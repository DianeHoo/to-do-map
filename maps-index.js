// ─────────────────────────────────────────────────────────────────────────────
// To-Do Map · maps index
//
// The home screen (/home/) lists every map saved in this browser. This module
// owns that list: an index of { id, name, kind, createdAt, updatedAt, share }
// entries under 'todoMapsIndex.v1', with each map's board state in its own
// localStorage slot ('todomap-map-<id>') in the exact shape the editors'
// saveState/loadSavedState already read and write.
//
// Loaded by the home screen and by both editors BEFORE app.js (the editors
// only call touch()/get() from it). No build step, no framework — same deal
// as share.js.
// ─────────────────────────────────────────────────────────────────────────────

(function () {
  'use strict';

  const INDEX_KEY = 'todoMapsIndex.v1';
  const SLOT_PREFIX = 'todomap-map-';

  // Legacy single-map slots from before the home screen existed.
  const LEGACY_MAIN_KEY = 'eisenhower-matrix-state';
  const LEGACY_IMPACT_KEY = 'todomap-impact-effort-state';

  const KINDS = ['urgency-importance', 'impact-effort'];

  function slotKey(id) { return SLOT_PREFIX + id; }

  function readIndex() {
    try {
      const parsed = JSON.parse(localStorage.getItem(INDEX_KEY));
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) { return []; }
  }

  function writeIndex(entries) {
    try {
      localStorage.setItem(INDEX_KEY, JSON.stringify(entries));
      return true;
    } catch (e) { return false; }
  }

  function newId() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function get(id) {
    return readIndex().find(e => e.id === id) || null;
  }

  // Patch one entry in place; returns the updated entry or null if missing.
  function patch(id, changes) {
    const entries = readIndex();
    const entry = entries.find(e => e.id === id);
    if (!entry) return null;
    Object.assign(entry, changes);
    writeIndex(entries);
    return entry;
  }

  function readData(id) {
    try { return JSON.parse(localStorage.getItem(slotKey(id))); }
    catch (e) { return null; }
  }

  function writeData(id, data) {
    try {
      localStorage.setItem(slotKey(id), JSON.stringify(data));
      return true;
    } catch (e) { return false; }
  }

  // Create a map (optionally seeded with board state). Returns the id, or
  // null when storage is unavailable.
  function create(opts) {
    const kind = KINDS.indexOf(opts.kind) !== -1 ? opts.kind : KINDS[0];
    const id = newId();
    const now = Date.now();
    if (opts.data && !writeData(id, opts.data)) return null;
    const entries = readIndex();
    entries.push({
      id,
      name: (opts.name || '').trim() || 'untitled map',
      kind,
      createdAt: now,
      updatedAt: now,
    });
    if (!writeIndex(entries)) {
      try { localStorage.removeItem(slotKey(id)); } catch (e) { /* best effort */ }
      return null;
    }
    return id;
  }

  function rename(id, name) {
    const trimmed = (name || '').trim();
    if (!trimmed) return get(id);
    return patch(id, { name: trimmed, updatedAt: Date.now() });
  }

  // Bump updatedAt — the editors call this on every save so the home grid
  // keeps its most-recently-edited-first order.
  function touch(id) {
    return patch(id, { updatedAt: Date.now() });
  }

  function duplicate(id) {
    const entry = get(id);
    if (!entry) return null;
    const copyId = newId();
    const data = readData(id);
    if (data && !writeData(copyId, data)) return null;
    const entries = readIndex();
    const now = Date.now();
    entries.push({
      id: copyId,
      name: entry.name + ' copy',
      kind: entry.kind,
      createdAt: now,
      updatedAt: now,
    });
    if (!writeIndex(entries)) return null;
    return copyId;
  }

  // Remove a map from the index. The data slot is kept unless dropData is
  // true, so the home screen's undo toast can restore without a copy.
  // Returns false when the index write failed (storage unavailable) — the
  // slot is kept in that case too, so a half-failed delete never orphans data.
  function remove(id, dropData) {
    const ok = writeIndex(readIndex().filter(e => e.id !== id));
    if (ok && dropData) dropSlot(id);
    return ok;
  }

  function dropSlot(id) {
    try { localStorage.removeItem(slotKey(id)); } catch (e) { /* storage unavailable */ }
  }

  // Re-insert a previously removed entry (undo of remove()).
  function restore(entry) {
    if (!entry || !entry.id || get(entry.id)) return;
    const entries = readIndex();
    entries.push(entry);
    writeIndex(entries);
  }

  // Give one map a fresh id, moving its data slot along. Cloud sync calls
  // this only when a push proves the old id's server row belongs to another
  // account (a previous anonymous session) — everything else keeps its id so
  // bookmarks and open editors survive sign-in. Returns the new id, or null
  // when the move couldn't be completed safely.
  function reassignId(id) {
    const entries = readIndex();
    const entry = entries.find(e => e.id === id);
    if (!entry) return null;
    const fresh = newId();
    const data = readData(id);
    if (data) {
      // Copy first; only drop the old slot once the copy is known-good, so a
      // failed write (quota) never orphans the map's contents.
      if (!writeData(fresh, data)) return null;
    }
    entry.id = fresh;
    if (!writeIndex(entries)) {
      dropSlot(fresh);
      return null;
    }
    if (data) dropSlot(id);
    recordMove(id, fresh);
    return fresh;
  }

  // Forwarding notes for reassignId: an editor tab open on the old id reads
  // this (via its storage listener) and follows the map to its new URL
  // instead of stranding the user on a slot that no longer exists.
  const MOVED_KEY = 'todomapMovedIds.v1';

  function recordMove(oldId, newId) {
    try {
      const moved = JSON.parse(localStorage.getItem(MOVED_KEY)) || {};
      moved[oldId] = newId;
      // A handful of recent moves is plenty — this only serves live tabs.
      const keys = Object.keys(moved);
      if (keys.length > 20) keys.slice(0, keys.length - 20).forEach(k => { delete moved[k]; });
      localStorage.setItem(MOVED_KEY, JSON.stringify(moved));
    } catch (e) { /* storage unavailable */ }
  }

  function movedTo(id) {
    try {
      const moved = JSON.parse(localStorage.getItem(MOVED_KEY)) || {};
      return moved[id] || null;
    } catch (e) { return null; }
  }

  // Insert or replace an entry exactly as given (timestamps untouched), used
  // by cloud sync when the server side is the newer one. Optionally writes
  // the map's data slot in the same step. Returns false when storage refused
  // either write, so sync can retry instead of assuming the copy landed.
  function adopt(entry, data) {
    if (!entry || !entry.id) return false;
    if (data !== undefined && !writeData(entry.id, data)) return false;
    const entries = readIndex().filter(e => e.id !== entry.id);
    entries.push(entry);
    return writeIndex(entries);
  }

  // Remember a map's published share so re-sharing updates the same link.
  function setShare(id, share) {
    return patch(id, { share });
  }

  // ── Legacy migration ────────────────────────────────────────────────────────
  // First visit to the home screen: fold the old single-map slots into the
  // index so nobody loses data. The legacy key is removed after copying, which
  // also makes this safe to call on every load.

  function migrateLegacyKey(key, fallbackKind) {
    let raw = null;
    try { raw = localStorage.getItem(key); } catch (e) { return; }
    if (!raw) return;
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch (e) { /* unreadable — leave it */ }
    if (!parsed || !Array.isArray(parsed.tasks) || !parsed.phase) return;
    // The impact/effort variant briefly wrote under the main key too; its data
    // is recognizable by its ordering fields.
    const kind = ('impactOrder' in parsed) ? 'impact-effort' : fallbackKind;
    if (create({ kind, name: 'my map', data: parsed }) !== null) {
      try { localStorage.removeItem(key); } catch (e) { /* storage unavailable */ }
    }
  }

  function migrateLegacy() {
    migrateLegacyKey(LEGACY_MAIN_KEY, 'urgency-importance');
    migrateLegacyKey(LEGACY_IMPACT_KEY, 'impact-effort');
  }

  // ── Exports ─────────────────────────────────────────────────────────────────

  window.TodoMapsIndex = {
    KINDS,
    slotKey,
    list: readIndex,
    get,
    create,
    rename,
    touch,
    duplicate,
    remove,
    dropSlot,
    restore,
    adopt,
    reassignId,
    movedTo,
    setShare,
    readData,
    writeData,
    migrateLegacy,
  };
})();
