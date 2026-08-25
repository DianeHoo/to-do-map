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

  // Rename has no native maxlength like the task-text inputs do (it's a plain
  // .map-rename-input with none set) — an unbounded name renders as an
  // unbounded-height home-grid card (.map-title only wraps, it never clamps),
  // blowing out the whole grid layout for one long paste. Cap centrally so
  // every writer (rename, create, duplicate, JSON import via home.js) is
  // covered the same way parseGridFile caps task text on import.
  const MAX_NAME_LEN = 120;
  function capName(name) { return (name || '').trim().slice(0, MAX_NAME_LEN); }

  // Legacy single-map slots from before the home screen existed.
  const LEGACY_MAIN_KEY = 'eisenhower-matrix-state';
  const LEGACY_IMPACT_KEY = 'todomap-impact-effort-state';

  const KINDS = ['urgency-importance', 'impact-effort'];
  // One source for the human names — home and the dock both render these.
  const KIND_LABELS = {
    'urgency-importance': 'urgency × importance',
    'impact-effort': 'impact × effort',
  };
  const PHASE_ORDER = {
    'urgency-importance': ['dump', 'sort-urgency', 'sort-importance', 'scatter'],
    'impact-effort': ['dump', 'sort-impact', 'sort-effort', 'scatter'],
  };
  // Matches the maxlength on the quick-add inputs and the .slice(0, 500) in
  // every inline-edit save() in both editors.
  const MAX_TASK_TEXT_LEN = 500;

  // Every live task-text entry point in both editors caps text at 500 chars,
  // and both editors' own parseGridFile() plus home.js's sanitizeImportedGrid()
  // independently re-check that cap (and task/history shape) on file import —
  // each comment there explains why: unbounded text overflows the canvas, and
  // a malformed history entry crashes buildHistoryTimeline()/selectSnapshot().
  // Cloud sync (maps-cloud.js) is a *third* way board data lands in a map's
  // local slot, and until now it wrote the server's `data` column straight
  // through via writeData()/adopt() with none of that validation — the
  // server's jsonb column only enforces a 200 KB total size (maps-schema.sql),
  // nothing about task-text length or shape. A row pulled from another device
  // (or one written by a future/buggy client version) hits the same bugs the
  // two file-import paths were already fixed for. Mirror that same sanitizing
  // here, centrally, the way capName() below already covers every name writer.
  function sanitizeGridData(data, kind) {
    const g = data && typeof data === 'object' ? data : {};
    const tasks = Array.isArray(g.tasks)
      ? g.tasks
          .filter(t => t && typeof t.id === 'string' && typeof t.text === 'string')
          .map(t => ({ id: t.id, text: t.text.slice(0, MAX_TASK_TEXT_LEN) }))
      : [];
    const ids = new Set(tasks.map(t => t.id));
    const idList = (v) => (Array.isArray(v) ? v.filter(id => ids.has(id)) : []);
    const positions = {};
    if (g.cardPositions && typeof g.cardPositions === 'object') {
      Object.keys(g.cardPositions).forEach(id => {
        const p = g.cardPositions[id];
        if (ids.has(id) && p && isFinite(p.x) && isFinite(p.y)) {
          positions[id] = { x: Number(p.x), y: Number(p.y) };
        }
      });
    }
    let counter = (typeof g.idCounter === 'number' && isFinite(g.idCounter)) ? g.idCounter : 0;
    tasks.forEach(t => {
      const n = /^t(\d+)$/.exec(t.id);
      if (n) counter = Math.max(counter, parseInt(n[1], 10));
    });
    const history = Array.isArray(g.history) ? g.history.filter(h =>
      h && typeof h === 'object' &&
      isFinite(h.ts) && isFinite(h.checkedCount) &&
      Array.isArray(h.items) && h.items.every(it => it && typeof it.id === 'string')
    ) : [];
    const phaseOrder = PHASE_ORDER[kind] || PHASE_ORDER[KINDS[0]];
    const [orderA, orderB] = kind === 'impact-effort'
      ? ['impactOrder', 'effortOrder']
      : ['urgencyOrder', 'importanceOrder'];
    const slot = {
      tasks,
      phase: phaseOrder.indexOf(g.phase) !== -1 ? g.phase : 'dump',
      cardPositions: positions,
      done: idList(g.done),
      idCounter: counter,
      history,
    };
    slot[orderA] = idList(g[orderA]);
    slot[orderB] = idList(g[orderB]);
    return slot;
  }

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
      name: capName(opts.name) || 'untitled map',
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
    const trimmed = capName(name);
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
    // "name copy", "name copy 2", … — repeated duplicates stay tellable apart.
    // Reserve room in the base name for the suffix so a capped result never
    // swallows " copy N" entirely — that would make this and the previous
    // attempt collide and spin the counter forever instead of terminating.
    const names = new Set(entries.map(e => e.name));
    const base = entry.name.slice(0, MAX_NAME_LEN - 12);
    let name = capName(base + ' copy');
    for (let n = 2; names.has(name); n++) name = capName(base + ' copy ' + n);
    const now = Date.now();
    entries.push({
      id: copyId,
      name,
      kind: entry.kind,
      createdAt: now,
      updatedAt: now,
    });
    if (!writeIndex(entries)) {
      dropSlot(copyId); // don't leak the copied data when the index write failed
      return null;
    }
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
  //
  // The server's `name` column has no length constraint of its own (see
  // maps-schema.sql) — every *local* writer of a name goes through capName
  // (rename/create/duplicate above), but a row pulled down from another
  // device or session bypasses all of them and lands here instead. Cap it
  // the same way, or an unbounded name from the server blows out the home
  // grid exactly like the unbounded-rename bug this file's capName() was
  // added to fix, just reached via sync instead of the rename input.
  function adopt(entry, data) {
    if (!entry || !entry.id) return false;
    if (data !== undefined && !writeData(entry.id, data)) return false;
    const entries = readIndex().filter(e => e.id !== entry.id);
    entries.push(entry.name !== undefined ? { ...entry, name: capName(entry.name) || 'untitled map' } : entry);
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
    KIND_LABELS,
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
    sanitizeGridData,
    migrateLegacy,
  };
})();
