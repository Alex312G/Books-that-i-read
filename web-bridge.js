// Phone (web) version of the desktop bridge. In the desktop app, preload.js already provides
// window.bookshelf and this file does nothing. In a browser it keeps the library and PDFs in the
// phone's storage (IndexedDB) and talks to GitHub directly with a token kept on the phone.
(() => {
  if (window.bookshelf) return;

  const API = localStorage.getItem('bookshelf.api') || 'https://api.github.com'; // overridable for testing
  const CFG = 'bookshelf.github';

  /* ---------- local storage (IndexedDB: kv for the library, files for PDFs) ---------- */
  let dbp;
  function db() {
    return dbp ||= new Promise((res, rej) => {
      const r = indexedDB.open('bookshelf-web', 1);
      r.onupgradeneeded = () => { r.result.createObjectStore('kv'); r.result.createObjectStore('files'); };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  async function op(store, mode, fn) {
    const d = await db();
    return new Promise((res, rej) => {
      const t = d.transaction(store, mode);
      const q = fn(t.objectStore(store));
      t.oncomplete = () => res(q?.result);
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error);
    });
  }
  const kvGet = k => op('kv', 'readonly', s => s.get(k));
  const kvSet = (k, v) => op('kv', 'readwrite', s => s.put(v, k));
  const count = d => (d.books?.length || 0) + (d.sites?.length || 0) + (d.sessions?.length || 0);

  /* ---------- GitHub ---------- */
  const readCfg = () => { try { return JSON.parse(localStorage.getItem(CFG) || '{}'); } catch { return {}; } };
  const writeCfg = c => localStorage.setItem(CFG, JSON.stringify(c));
  const patchCfg = p => writeCfg({ ...readCfg(), ...p });

  async function gh(token, url, opts = {}) {
    const res = await fetch(API + url, {
      method: opts.method || 'GET',
      body: opts.body,
      cache: 'no-store',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: opts.raw ? 'application/vnd.github.raw' : 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(opts.body ? { 'Content-Type': 'application/json' } : {})
      }
    });
    if (opts.raw === 'bytes') return { status: res.status, bytes: res.ok ? new Uint8Array(await res.arrayBuffer()) : null };
    if (opts.raw) return { status: res.status, text: await res.text() };
    let data = null;
    try { data = await res.json(); } catch {}
    return { status: res.status, data };
  }
  function explain(status, data) {
    if (status === 401) return 'The token is invalid or has expired.';
    if (status === 404) return "Repository not found, or the token doesn't have access to it.";
    if (status === 403) return /rate limit/i.test(data?.message || '') ? 'GitHub rate limit reached, try again later.' : 'The token needs "Contents: Read and write" permission on this repo.';
    return data?.message || `GitHub error ${status}`;
  }
  const cleanRepo = r => String(r || '').trim().replace(/^(https?:\/\/)?(www\.)?github\.com\//i, '').replace(/\.git$/i, '').replace(/\/+$/, '');
  const validRepo = r => /^[\w.-]+\/[\w.-]+$/.test(r);

  function toB64(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }
  const b64Text = text => toB64(new TextEncoder().encode(text));
  const textB64 = b64 => new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\s/g, '')), c => c.charCodeAt(0)));

  async function readRepoFile(token, repo, file) {
    const url = `/repos/${repo}/contents/${file}`;
    const cur = await gh(token, url);
    if (cur.status === 404) return { ok: true, text: null, sha: null };
    if (cur.status !== 200) return { ok: false, error: explain(cur.status, cur.data) };
    let text = cur.data.content ? textB64(cur.data.content) : '';
    if (!text && cur.data.size > 0) {
      const raw = await gh(token, url, { raw: true });
      if (raw.status !== 200) return { ok: false, error: explain(raw.status) };
      text = raw.text;
    }
    return { ok: true, text, sha: cur.data.sha };
  }

  const START = '<!-- bookshelf:start -->', END = '<!-- bookshelf:end -->';
  function mergeReadme(remote, generated) {
    const gs = generated.indexOf(START), ge = generated.indexOf(END);
    if (gs < 0 || ge < 0) return generated;
    const block = generated.slice(gs, ge + END.length);
    if (remote) {
      const rs = remote.indexOf(START), re = remote.indexOf(END);
      if (rs >= 0 && re > rs) return remote.slice(0, rs) + block + remote.slice(re + END.length);
      if (!remote.trimStart().startsWith('# 📚 My Reading Log') && remote.trim()) return remote.trimEnd() + '\n\n' + block + '\n';
    }
    return generated;
  }

  const offline = () => ({ ok: false, error: "Couldn't reach GitHub." });
  const sha256 = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('');

  window.bookshelf = {
    platform: 'web',
    github: {
      async get() {
        const c = readCfg();
        return {
          repo: c.repo || '', syncRepo: c.syncRepo || '', hasToken: !!c.token, includeOpinions: !!c.includeOpinions,
          lastSync: c.lastSync || null, lastError: c.lastError || null,
          lastDeviceSync: c.lastDeviceSync || null, deviceSyncError: c.deviceSyncError || null
        };
      },
      async set({ repo, syncRepo, token, includeOpinions }) {
        repo = cleanRepo(repo); syncRepo = cleanRepo(syncRepo);
        if (!validRepo(repo)) return { ok: false, error: 'Write the repository as username/repo-name.' };
        if (syncRepo && !validRepo(syncRepo)) return { ok: false, error: 'Write the sync repository as username/repo-name.' };
        const c = readCfg();
        const tok = String(token || '').trim() || c.token;
        if (!tok) return { ok: false, error: 'Paste a GitHub access token.' };
        try {
          const r = await gh(tok, `/repos/${repo}`);
          if (r.status !== 200) return { ok: false, error: explain(r.status, r.data) };
          if (syncRepo) {
            const s = await gh(tok, `/repos/${syncRepo}`);
            if (s.status !== 200) return { ok: false, error: 'Sync repository: ' + explain(s.status, s.data) };
            if (s.data && s.data.private === false) return { ok: false, error: 'The sync repository must be private: it holds your notes and PDFs.' };
          }
        } catch { return { ok: false, error: "Couldn't reach GitHub. Check your internet connection." }; }
        writeCfg({ ...c, repo, syncRepo, token: tok, includeOpinions: !!includeOpinions, lastError: null, deviceSyncError: null, ...(c.repo !== repo ? { lastSync: null } : {}) });
        return { ok: true };
      },
      async clear() { writeCfg({}); return { ok: true }; },
      async push(generated, message) {
        const c = readCfg();
        if (!c.repo || !c.token) return { ok: false, error: 'GitHub is not connected.' };
        let result;
        try {
          result = { ok: false, error: 'README.md was changed on GitHub at the same moment; it will retry next time.' };
          for (let attempt = 0; attempt < 2; attempt++) {
            const cur = await readRepoFile(c.token, c.repo, 'README.md');
            if (!cur.ok) { result = cur; break; }
            const content = mergeReadme(cur.text || '', generated);
            if (cur.sha && cur.text === content) { result = { ok: true, unchanged: true }; break; }
            const put = await gh(c.token, `/repos/${c.repo}/contents/README.md`, { method: 'PUT', body: JSON.stringify({ message, content: b64Text(content), ...(cur.sha ? { sha: cur.sha } : {}) }) });
            if (put.status === 200 || put.status === 201) { result = { ok: true }; break; }
            if (put.status !== 409 && put.status !== 422) { result = { ok: false, error: explain(put.status, put.data) }; break; }
          }
        } catch { result = offline(); }
        patchCfg({ lastError: result.ok ? null : result.error, ...(result.ok ? { lastSync: Date.now() } : {}) });
        return result;
      }
    },
    sync: {
      async get() {
        const c = readCfg();
        if (!c.syncRepo || !c.token) return { ok: false, error: 'Sync is not set up.' };
        try {
          const r = await readRepoFile(c.token, c.syncRepo, 'library.json');
          if (!r.ok) patchCfg({ deviceSyncError: r.error });
          return r;
        } catch { patchCfg({ deviceSyncError: "Couldn't reach GitHub." }); return offline(); }
      },
      async put(text, sha, message) {
        const c = readCfg();
        if (!c.syncRepo || !c.token) return { ok: false, error: 'Sync is not set up.' };
        try {
          const put = await gh(c.token, `/repos/${c.syncRepo}/contents/library.json`, { method: 'PUT', body: JSON.stringify({ message, content: b64Text(text), ...(sha ? { sha } : {}) }) });
          if (put.status === 200 || put.status === 201) { patchCfg({ deviceSyncError: null, lastDeviceSync: Date.now() }); return { ok: true, sha: put.data?.content?.sha }; }
          if (put.status === 409 || put.status === 422) return { ok: false, conflict: true };
          const error = explain(put.status, put.data);
          patchCfg({ deviceSyncError: error });
          return { ok: false, error };
        } catch { patchCfg({ deviceSyncError: "Couldn't reach GitHub." }); return offline(); }
      },
      async done() { patchCfg({ deviceSyncError: null, lastDeviceSync: Date.now() }); return true; },
      async pdfList() {
        const c = readCfg();
        if (!c.syncRepo || !c.token) return { ok: false, error: 'Sync is not set up.' };
        try {
          const r = await gh(c.token, `/repos/${c.syncRepo}/contents/pdfs`);
          if (r.status === 404) return { ok: true, hashes: [] };
          if (r.status !== 200) return { ok: false, error: explain(r.status, r.data) };
          return { ok: true, hashes: (r.data || []).map(f => f.name.replace(/\.pdf$/, '')).filter(h => /^[0-9a-f]{64}$/.test(h)) };
        } catch { return offline(); }
      },
      async pdfUpload(id, hash, title) {
        const c = readCfg();
        if (!c.syncRepo || !c.token) return { ok: false, error: 'Sync is not set up.' };
        try {
          const bytes = await op('files', 'readonly', s => s.get(id));
          if (!bytes) return { ok: false, error: 'PDF not on this phone' };
          const put = await gh(c.token, `/repos/${c.syncRepo}/contents/pdfs/${hash}.pdf`, { method: 'PUT', body: JSON.stringify({ message: `Add PDF: ${title}`, content: toB64(new Uint8Array(bytes)) }) });
          if (put.status === 200 || put.status === 201 || put.status === 422) return { ok: true };
          return { ok: false, error: explain(put.status, put.data) };
        } catch { return offline(); }
      },
      async pdfDownload(id, hash) {
        const c = readCfg();
        if (!c.syncRepo || !c.token) return { ok: false, error: 'Sync is not set up.' };
        try {
          const r = await gh(c.token, `/repos/${c.syncRepo}/contents/pdfs/${hash}.pdf`, { raw: 'bytes' });
          if (r.status !== 200 || !r.bytes) return { ok: false, error: r.status === 404 ? 'not-found' : explain(r.status) };
          if (await sha256(r.bytes) !== hash) return { ok: false, error: 'The downloaded PDF is damaged.' };
          await op('files', 'readwrite', s => s.put(r.bytes.buffer, id));
          return { ok: true };
        } catch { return offline(); }
      }
    },
    library: {
      async load() {
        for (const key of ['library', 'library.prev']) {
          const text = await kvGet(key);
          if (text) { try { JSON.parse(text); return { text, from: key }; } catch {} }
        }
        return null;
      },
      async save(text) {
        const next = JSON.parse(text);
        const prevText = await kvGet('library');
        if (prevText) {
          const prev = JSON.parse(prevText);
          if (count(next) < count(prev) - 1) throw new Error('this save would have lost data, so it was not written');
          await kvSet('library.prev', prevText);
        }
        await kvSet('library', text);
        return true;
      },
      async legacyBackup() { return null; }
    },
    files: {
      async save(id, bytes) { await op('files', 'readwrite', s => s.put(bytes instanceof ArrayBuffer ? bytes : new Uint8Array(bytes).buffer, id)); return true; },
      async load(id) { const b = await op('files', 'readonly', s => s.get(id)); return b ? new Uint8Array(b) : null; },
      async has(id) { return !!(await op('files', 'readonly', s => s.getKey(id))); },
      async remove(id) { await op('files', 'readwrite', s => s.delete(id)); return true; }
    },
    imports: { async list() { return []; }, async done() { return true; } },
    onClosing() {},
    onSiteActivity() {},
    closeReady() {}
  };

  navigator.storage?.persist?.();
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
  }
})();
