// ─────────────────────────────────────────────────────────────────────────────
// To-Do Map · cloud sync for the maps index
//
// Mirrors the local maps index (maps-index.js) into the Supabase `maps` table
// (supabase/maps-schema.sql) under an anonymous auth account, via plain
// fetch() like share.js — no client library, no build step.
//
// Local-first: localStorage stays the source the UI reads, and every cloud
// call degrades silently (offline, schema not run yet, anonymous sign-ins
// disabled). The home screen calls syncNow() on boot; editors and home
// mutations call schedulePush()/pushDelete(). Sync reconciles by updatedAt —
// newer side wins, deletes are remembered as tombstones until confirmed.
//
// Auth: anonymous account per browser by default; magic-link email sign-in
// (signInWithEmail/consumeAuthHash) upgrades to a cross-device account. When
// the account changes, local maps take fresh ids (TodoMapsIndex.reassignIds)
// so they re-insert under the new owner instead of colliding with rows the
// old account still owns.
//
// localStorage keys:
//   'todomap-auth.v1'            — session (access + refresh token)
//   'todomap-owner.v1'           — auth user id the local maps belong to
//   'todomapCloudTombstones.v1'  — ids deleted locally, pending server delete
// ─────────────────────────────────────────────────────────────────────────────

(function () {
  'use strict';

  const cfg = window.TODOMAP_SHARE_CONFIG || {};
  const configured = !!(
    cfg.supabaseUrl && /^https:\/\//.test(cfg.supabaseUrl) &&
    cfg.supabaseAnonKey && !/^YOUR_/.test(cfg.supabaseAnonKey)
  );
  const enabled = configured && !!(window.crypto && crypto.randomUUID) && !!window.TodoMapsIndex;

  const AUTH_KEY = 'todomap-auth.v1';
  const OWNER_KEY = 'todomap-owner.v1';
  const TOMBSTONE_KEY = 'todomapCloudTombstones.v1';
  const BASE = configured ? cfg.supabaseUrl.replace(/\/$/, '') : '';
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  // Client clocks write updatedAt on both sides of a round-trip; treat
  // near-ties as equal instead of ping-ponging pushes and pulls.
  const SKEW_MS = 2000;

  const warn = (...args) => console.warn('[todomap sync]', ...args);

  // ── Anonymous auth session ──────────────────────────────────────────────────

  function loadSession() {
    try { return JSON.parse(localStorage.getItem(AUTH_KEY)); }
    catch (e) { return null; }
  }
  function saveSession(s) {
    try { localStorage.setItem(AUTH_KEY, JSON.stringify(s)); }
    catch (e) { /* storage unavailable */ }
  }

  function jwtPayload(token) {
    try { return JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))); }
    catch (e) { return null; }
  }
  function jwtExpMs(token) {
    const p = jwtPayload(token);
    return p ? (p.exp || 0) * 1000 : 0;
  }

  // Record which auth account this browser's maps belong to. When the account
  // changes — magic-link sign-in, or a fresh anonymous session after sign-out —
  // the server rows for the old ids belong to the old owner, so the local maps
  // take fresh ids and sync re-inserts them cleanly under the new account.
  function commitSession(s) {
    const p = s && s.access_token ? jwtPayload(s.access_token) : null;
    const sub = p && p.sub;
    if (sub) {
      let prev = null;
      try { prev = localStorage.getItem(OWNER_KEY); } catch (e) { /* storage unavailable */ }
      if (prev && prev !== sub && window.TodoMapsIndex) TodoMapsIndex.reassignIds();
      try { localStorage.setItem(OWNER_KEY, sub); } catch (e) { /* storage unavailable */ }
    }
    saveSession(s);
    return s;
  }

  async function authRequest(path, body) {
    const res = await fetch(BASE + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': cfg.supabaseAnonKey },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => null);
    if (!res.ok) {
      const msg = (json && (json.msg || json.message || json.error_description)) || ('auth failed (' + res.status + ')');
      throw new Error(msg);
    }
    return json;
  }

  let sessionPromise = null;
  // Projects with anonymous sign-ins disabled: remember the 422 so this page
  // stops re-asking on every push — sync stays off until an email sign-in.
  let anonUnavailable = false;

  // Resolve a valid access token: cached → refreshed → fresh anonymous account.
  function ensureSession() {
    if (sessionPromise) return sessionPromise;
    sessionPromise = (async () => {
      let s = loadSession();
      if (s && s.access_token && jwtExpMs(s.access_token) > Date.now() + 60000) return commitSession(s);
      if (s && s.refresh_token) {
        try {
          const r = await authRequest('/auth/v1/token?grant_type=refresh_token', { refresh_token: s.refresh_token });
          return commitSession({ access_token: r.access_token, refresh_token: r.refresh_token });
        } catch (e) { warn('session refresh failed, starting fresh:', e.message); }
      }
      if (anonUnavailable) throw new Error('not signed in — maps stay local until you sign in');
      // POST /signup with no credentials = anonymous sign-in (when enabled)
      let r;
      try {
        r = await authRequest('/auth/v1/signup', { data: {} });
      } catch (e) {
        if (/anonymous/i.test(e.message)) anonUnavailable = true;
        throw e;
      }
      if (!r || !r.access_token) throw new Error('anonymous sign-in unavailable');
      return commitSession({ access_token: r.access_token, refresh_token: r.refresh_token });
    })();
    // Allow retry on the next call if this attempt failed
    sessionPromise.catch(() => { sessionPromise = null; });
    return sessionPromise;
  }

  // ── PostgREST ───────────────────────────────────────────────────────────────

  async function rest(method, path, body, prefer) {
    const s = await ensureSession();
    const headers = {
      'apikey': cfg.supabaseAnonKey,
      'Authorization': 'Bearer ' + s.access_token,
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (prefer) headers['Prefer'] = prefer;
    const res = await fetch(BASE + '/rest/v1/' + path, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401) {
      // Token went stale server-side — drop it and let the next call re-auth
      sessionPromise = null;
      saveSession(null);
      throw new Error('unauthorized');
    }
    if (!res.ok) {
      const json = await res.json().catch(() => null);
      throw new Error((json && json.message) || (method + ' ' + path + ' failed (' + res.status + ')'));
    }
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }

  const listServerMaps = () => rest('GET', 'maps?select=id,name,map_kind,data,created_at,updated_at');
  const deleteServerMap = (id) => rest('DELETE', 'maps?id=eq.' + id);
  const upsertServerMap = (row) =>
    rest('POST', 'maps?on_conflict=id', row, 'resolution=merge-duplicates,return=minimal');

  // ── Tombstones (local deletes pending server confirmation) ─────────────────

  function readTombstones() {
    try { return JSON.parse(localStorage.getItem(TOMBSTONE_KEY)) || []; }
    catch (e) { return []; }
  }
  function writeTombstones(ids) {
    try { localStorage.setItem(TOMBSTONE_KEY, JSON.stringify(ids)); }
    catch (e) { /* storage unavailable */ }
  }
  function addTombstone(id) {
    const t = readTombstones();
    if (t.indexOf(id) === -1) { t.push(id); writeTombstones(t); }
  }
  function clearTombstone(id) {
    writeTombstones(readTombstones().filter(x => x !== id));
  }

  // ── Push / delete / sync ────────────────────────────────────────────────────

  function rowFor(entry) {
    return {
      id: entry.id,
      name: entry.name,
      map_kind: entry.kind,
      data: TodoMapsIndex.readData(entry.id) || { tasks: [] },
      updated_at: new Date(entry.updatedAt || Date.now()).toISOString(),
    };
  }

  async function pushMap(id) {
    if (!enabled) return;
    const entry = TodoMapsIndex.get(id);
    if (!entry) return; // deleted (or undone away) before the push fired
    if (!UUID_RE.test(entry.id)) return; // pre-cloud id — stays local-only
    try { await upsertServerMap(rowFor(entry)); }
    catch (e) { warn('push failed for "' + entry.name + '":', e.message); }
  }

  const pushTimers = {};
  // Editors save on every interaction; collapse bursts into one upsert.
  function schedulePush(id, delayMs) {
    if (!enabled) return;
    clearTimeout(pushTimers[id]);
    pushTimers[id] = setTimeout(() => { delete pushTimers[id]; pushMap(id); }, delayMs || 1500);
  }

  async function pushDelete(id) {
    if (!enabled || !UUID_RE.test(id)) return;
    clearTimeout(pushTimers[id]);
    addTombstone(id);
    try {
      await deleteServerMap(id);
      clearTombstone(id);
    } catch (e) { warn('delete failed (will retry on next sync):', e.message); }
  }

  // Reconcile local index with the server. Returns true when anything local
  // changed (the home screen re-renders on that).
  async function syncNow() {
    if (!enabled) return false;
    let changed = false;

    // Settle pending deletes first so they can't be pulled back in
    const tombstones = readTombstones();
    for (const id of tombstones) {
      try { await deleteServerMap(id); clearTombstone(id); }
      catch (e) { warn('tombstone delete failed:', e.message); }
    }
    const deadIds = new Set(readTombstones());

    const server = (await listServerMaps()) || [];
    const localById = {};
    TodoMapsIndex.list().forEach(e => { localById[e.id] = e; });

    for (const row of server) {
      if (deadIds.has(row.id)) continue;
      const serverMs = Date.parse(row.updated_at) || 0;
      const local = localById[row.id];
      if (!local) {
        // New on the server (another tab/session of this account)
        TodoMapsIndex.adopt({
          id: row.id,
          name: row.name,
          kind: row.map_kind,
          createdAt: Date.parse(row.created_at) || serverMs,
          updatedAt: serverMs,
        }, row.data);
        changed = true;
      } else if (serverMs > (local.updatedAt || 0) + SKEW_MS) {
        TodoMapsIndex.writeData(row.id, row.data);
        TodoMapsIndex.adopt({ ...local, name: row.name, kind: row.map_kind, updatedAt: serverMs }, undefined);
        changed = true;
      } else if ((local.updatedAt || 0) > serverMs + SKEW_MS) {
        await pushMap(row.id);
      }
      delete localById[row.id];
    }

    // Left over = local-only maps the server hasn't seen
    for (const id of Object.keys(localById)) {
      await pushMap(id);
    }

    return changed;
  }

  // ── Email sign-in (magic link) ──────────────────────────────────────────────

  function currentUser() {
    const s = loadSession();
    const p = s && s.access_token ? jwtPayload(s.access_token) : null;
    if (!p) return null;
    return { email: p.email || null, anonymous: !p.email };
  }

  // Sends a magic link that redirects back to this page. The redirect URL
  // must be in the project's allowlist (Auth → URL Configuration).
  async function signInWithEmail(email) {
    const redirect = location.origin + location.pathname;
    await authRequest('/auth/v1/otp?redirect_to=' + encodeURIComponent(redirect), {
      email,
      create_user: true,
    });
  }

  // The magic link lands back here with tokens (or an error) in the URL hash.
  // Returns null when the hash has nothing auth-shaped; otherwise consumes it.
  function consumeAuthHash() {
    const hash = location.hash || '';
    if (!/(^|[#&])(access_token|error)=/.test(hash)) return null;
    const params = new URLSearchParams(hash.slice(1));
    history.replaceState(null, '', location.pathname + location.search);
    const err = params.get('error_description') || params.get('error');
    if (err) return { error: err.replace(/\+/g, ' ') };
    const at = params.get('access_token');
    if (!at) return { error: 'sign-in failed' };
    sessionPromise = null;
    commitSession({ access_token: at, refresh_token: params.get('refresh_token') });
    const p = jwtPayload(at);
    return { email: (p && p.email) || null };
  }

  // Drops the session; local maps stay. The next sync starts a fresh
  // anonymous account and commitSession re-owns the maps to it.
  function signOut() {
    const s = loadSession();
    if (configured && s && s.access_token) {
      fetch(BASE + '/auth/v1/logout', {
        method: 'POST',
        headers: { 'apikey': cfg.supabaseAnonKey, 'Authorization': 'Bearer ' + s.access_token },
      }).catch(() => { /* best effort */ });
    }
    sessionPromise = null;
    saveSession(null);
  }

  // ── Exports ─────────────────────────────────────────────────────────────────

  window.TodoMapsCloud = {
    enabled,
    syncNow,
    schedulePush,
    pushMap,
    pushDelete,
    currentUser,
    signInWithEmail,
    consumeAuthHash,
    signOut,
  };
})();
