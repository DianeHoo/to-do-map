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
// (signInWithEmail/consumeAuthHash) upgrades to a cross-device account. Map
// ids stay stable across account changes — syncNow merges both sides by id,
// and only a push that proves an id's server row belongs to a *different*
// account re-homes that one map (TodoMapsIndex.reassignId). A session that
// was email-backed never silently degrades to a fresh anonymous account:
// sync pauses and reports 'signed-out' instead of forking the maps.
//
// localStorage keys:
//   'todomap-auth.v1'            — session (access + refresh token)
//   'todomap-owner.v1'           — auth user id the local maps belong to
//   'todomapCloudTombstones.v1'  — ids deleted locally, pending server delete
//   'todomapShareRevokes.v1'     — share links of deleted maps, pending revoke
//   'todomapSyncPaused.v1'       — set on sign-out; cleared by the next sign-in
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
  const REVOKE_KEY = 'todomapShareRevokes.v1';
  const PAUSE_KEY = 'todomapSyncPaused.v1';
  const BASE = configured ? cfg.supabaseUrl.replace(/\/$/, '') : '';
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  // Client clocks write updatedAt on both sides of a round-trip; treat
  // near-ties as equal instead of ping-ponging pushes and pulls.
  const SKEW_MS = 2000;

  const warn = (...args) => console.warn('[todomap sync]', ...args);

  // ── Sync status (honest reporting only — no retry machinery) ────────────────

  let syncStatus = 'idle'; // idle | syncing | ok | offline | error | signed-out
  const statusCbs = [];
  function setStatus(next) {
    if (syncStatus === next) return;
    syncStatus = next;
    statusCbs.forEach(cb => { try { cb(next); } catch (e) { /* listener's problem */ } });
  }
  function getStatus() { return syncStatus; }
  function onStatus(cb) { if (typeof cb === 'function') statusCbs.push(cb); }

  function statusError(msg, status) {
    const e = new Error(msg);
    e.todomapStatus = status;
    return e;
  }
  function isNetworkError(e) {
    return (e instanceof TypeError) || /failed to fetch|networkerror|load failed/i.test(e.message || '');
  }
  function statusForError(e) {
    if (e && e.todomapStatus) return e.todomapStatus;
    if (isNetworkError(e)) return 'offline';
    return 'error';
  }

  function syncPaused() {
    try { return localStorage.getItem(PAUSE_KEY) === '1'; } catch (e) { return false; }
  }

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

  // Record which auth account this browser's maps belong to. Ids stay stable
  // across account changes — syncNow merges both sides by id, and only a
  // proven ownership conflict re-homes a map (see pushMapResolvingConflict).
  function commitSession(s) {
    const p = s && s.access_token ? jwtPayload(s.access_token) : null;
    const sub = p && p.sub;
    if (sub) {
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

  function refreshSession(token) {
    return authRequest('/auth/v1/token?grant_type=refresh_token', { refresh_token: token })
      .then(r => commitSession({ access_token: r.access_token, refresh_token: r.refresh_token }));
  }

  // Resolve a valid access token: cached → refreshed → fresh anonymous account.
  function ensureSession() {
    if (sessionPromise) return sessionPromise;
    sessionPromise = (async () => {
      if (syncPaused()) throw statusError('signed out — sign in to sync', 'signed-out');
      let s = loadSession();
      if (s && s.access_token && jwtExpMs(s.access_token) > Date.now() + 60000) return commitSession(s);
      if (s && s.refresh_token) {
        try {
          return await refreshSession(s.refresh_token);
        } catch (e) {
          // Offline is not an identity problem — keep the session untouched.
          if (isNetworkError(e)) throw statusError('offline', 'offline');
          // Another tab may have rotated the token while this one held the
          // old value — retry once with whatever is stored now.
          const latest = loadSession();
          if (latest && latest.refresh_token && latest.refresh_token !== s.refresh_token) {
            try { return await refreshSession(latest.refresh_token); }
            catch (e2) { if (isNetworkError(e2)) throw statusError('offline', 'offline'); }
          }
          const p = s.access_token ? jwtPayload(s.access_token) : null;
          if (p && p.email) {
            // An email account must never silently degrade into a fresh
            // anonymous one — that forks the user's maps. Stay signed out
            // until they sign in again.
            throw statusError('signed out — sign in again to sync', 'signed-out');
          }
          warn('session refresh failed, starting fresh:', e.message);
        }
      }
      // Anonymous sign-ins disabled in the project = sync simply isn't on for
      // signed-out visitors. That's a quiet 'local-only', not a failure.
      if (anonUnavailable) throw statusError('not signed in — maps stay local until you sign in', 'local-only');
      // POST /signup with no credentials = anonymous sign-in (when enabled)
      let r;
      try {
        r = await authRequest('/auth/v1/signup', { data: {} });
      } catch (e) {
        if (isNetworkError(e)) throw statusError('offline', 'offline');
        if (/anonymous/i.test(e.message) || /signups not allowed/i.test(e.message)) {
          anonUnavailable = true;
          throw statusError('not signed in — maps stay local until you sign in', 'local-only');
        }
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
      // Access token went stale server-side. Keep the refresh token — losing
      // it would spawn a fresh anonymous account and fork the maps — and let
      // the next call take the refresh path.
      sessionPromise = null;
      const stale = loadSession();
      if (stale && stale.refresh_token) saveSession({ ...stale, access_token: null });
      else saveSession(null);
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
  // Same upsert, but returning the written row — an id owned by another
  // account comes back as an RLS error *or* as a silently-empty result,
  // depending on how Postgres routes the conflict. Callers treat both as
  // "this id is taken".
  const upsertServerMapChecked = (row) =>
    rest('POST', 'maps?on_conflict=id', row, 'resolution=merge-duplicates,return=representation');

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

  // ── Share revokes (links of deleted maps, pending server removal) ───────────
  // Same persistence pattern as tombstones so a tab closed mid-delete still
  // settles later. Kept out of the delete moment itself: while the undo toast
  // is up the link must stay alive, so home queues the revoke and drains it
  // on toast expiry — and every syncNow drains leftovers. Doesn't need auth
  // (owner-key RPC), so none of it is gated on `enabled`.

  function readRevokes() {
    try { return JSON.parse(localStorage.getItem(REVOKE_KEY)) || []; }
    catch (e) { return []; }
  }
  function writeRevokes(list) {
    try { localStorage.setItem(REVOKE_KEY, JSON.stringify(list)); }
    catch (e) { /* storage unavailable */ }
  }
  function queueShareRevoke(shareId, ownerKey) {
    if (!shareId || !ownerKey) return;
    const list = readRevokes().filter(r => r.id !== shareId);
    list.push({ id: shareId, ownerKey });
    writeRevokes(list);
  }
  function dequeueShareRevoke(shareId) {
    writeRevokes(readRevokes().filter(r => r.id !== shareId));
  }
  async function drainShareRevokes() {
    if (!window.TodoMapShare || !TodoMapShare.remove) return;
    for (const r of readRevokes()) {
      try {
        await TodoMapShare.remove(r.id, r.ownerKey);
        dequeueShareRevoke(r.id);
      } catch (e) {
        // A link that's already gone is a settled revoke; anything else
        // stays queued for the next drain.
        if (/not found|no rows|404/i.test(e.message || '')) dequeueShareRevoke(r.id);
        else warn('share revoke failed (will retry):', e.message);
      }
    }
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
    if (!enabled) return false;
    const entry = TodoMapsIndex.get(id);
    if (!entry) return false; // deleted (or undone away) before the push fired
    if (!UUID_RE.test(entry.id)) return false; // pre-cloud id — stays local-only
    try {
      await upsertServerMap(rowFor(entry));
      setStatus('ok');
      return true;
    } catch (e) {
      warn('push failed for "' + entry.name + '":', e.message);
      setStatus(statusForError(e));
      return false;
    }
  }

  // Push one map, re-homing it onto a fresh id when its current id turns out
  // to belong to a different account (rows left behind by an earlier
  // anonymous session — the one case merging by id can't settle). Only
  // syncNow uses this: an open editor holds its slot key by id, so editors
  // never re-id out from under themselves. Returns 'pushed', 'reassigned',
  // or false when the map can't be pushed at all.
  async function pushMapResolvingConflict(id) {
    const entry = TodoMapsIndex.get(id);
    if (!entry || !UUID_RE.test(entry.id)) return false;
    let conflicted = false;
    try {
      const rows = await upsertServerMapChecked(rowFor(entry));
      conflicted = !Array.isArray(rows) || rows.length === 0;
    } catch (e) {
      if (!/row-level security|42501|duplicate key|409|403/i.test(e.message || '')) throw e;
      conflicted = true;
    }
    if (!conflicted) return 'pushed';
    const fresh = TodoMapsIndex.reassignId(id);
    if (!fresh) {
      warn('couldn’t re-home "' + entry.name + '" — storage unavailable');
      return false;
    }
    await upsertServerMap(rowFor(TodoMapsIndex.get(fresh)));
    return 'reassigned';
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

  // Undo of a delete: without clearing the tombstone first, the next sync
  // would re-delete the map that was just brought back.
  function undeleteMap(id) {
    clearTombstone(id);
    return pushMap(id);
  }

  // Reconcile local index with the server. Returns true when anything local
  // changed (the home screen re-renders on that).
  async function syncNow() {
    if (!enabled) return false;
    setStatus('syncing');
    try {
      const result = await doSyncNow();
      setStatus(result.failed ? 'error' : 'ok');
      return result.changed;
    } catch (e) {
      setStatus(statusForError(e));
      throw e;
    }
  }

  async function doSyncNow() {
    let changed = false;
    let failed = false;

    // Settle share revokes and pending deletes first, so a deleted map can't
    // be pulled back in and a dead link can't outlive its map.
    await drainShareRevokes();
    const tombstones = readTombstones();
    for (const id of tombstones) {
      try { await deleteServerMap(id); clearTombstone(id); }
      catch (e) { warn('tombstone delete failed:', e.message); failed = true; }
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
        const ok = TodoMapsIndex.adopt({
          id: row.id,
          name: row.name,
          kind: row.map_kind,
          createdAt: Date.parse(row.created_at) || serverMs,
          updatedAt: serverMs,
        }, row.data);
        if (ok) changed = true;
        else failed = true;
      } else if (serverMs > (local.updatedAt || 0) + SKEW_MS) {
        // Quota can refuse the slot write — then the entry must keep its old
        // updatedAt so the next sync retries, instead of recording a version
        // this browser doesn't actually have.
        if (TodoMapsIndex.writeData(row.id, row.data)) {
          TodoMapsIndex.adopt({ ...local, name: row.name, kind: row.map_kind, updatedAt: serverMs }, undefined);
          changed = true;
        } else {
          warn('couldn’t store "' + row.name + '" locally (storage full?)');
          failed = true;
        }
      } else if ((local.updatedAt || 0) > serverMs + SKEW_MS) {
        if (!(await pushMap(row.id))) failed = true;
      }
      delete localById[row.id];
    }

    // Left over = local-only maps the server hasn't seen. These are where an
    // ownership conflict surfaces (ids from an earlier account), so push via
    // the re-homing path — one map's failure never blocks the rest.
    for (const id of Object.keys(localById)) {
      try {
        const result = await pushMapResolvingConflict(id);
        if (result === 'reassigned') changed = true;
      } catch (e) {
        warn('push failed for map ' + id + ':', e.message);
        failed = true;
      }
    }

    return { changed, failed };
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
    try { localStorage.removeItem(PAUSE_KEY); } catch (e) { /* storage unavailable */ }
    commitSession({ access_token: at, refresh_token: params.get('refresh_token') });
    setStatus('idle');
    const p = jwtPayload(at);
    return { email: (p && p.email) || null };
  }

  // Drops the session; local maps stay — literally. Sync pauses until the
  // next sign-in instead of silently starting a fresh anonymous account
  // (which would fork every map away from the signed-out one).
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
    try { localStorage.setItem(PAUSE_KEY, '1'); } catch (e) { /* storage unavailable */ }
    setStatus('signed-out');
  }

  // ── Exports ─────────────────────────────────────────────────────────────────

  window.TodoMapsCloud = {
    enabled,
    syncNow,
    schedulePush,
    pushMap,
    pushDelete,
    undeleteMap,
    queueShareRevoke,
    dequeueShareRevoke,
    drainShareRevokes,
    getStatus,
    onStatus,
    currentUser,
    signInWithEmail,
    consumeAuthHash,
    signOut,
  };
})();
