// ─────────────────────────────────────────────────────────────────────────────
// To-Do Map · home screen
//
// Lists every map in this browser (via TodoMapsIndex), creates new ones,
// imports exported .json files, and proxies the share flow through the same
// publish_map RPC the editors use. Opening a card hands off to the editor for
// that map's kind with ?map=<id>.
// ─────────────────────────────────────────────────────────────────────────────

(function () {
  'use strict';

  const Maps = window.TodoMapsIndex;
  const grid = document.getElementById('maps-grid');
  const emptyState = document.getElementById('empty-state');
  const kindPicker = document.getElementById('kind-picker');
  const importInput = document.getElementById('import-input');
  const toastEl = document.getElementById('toast');
  const toastMsg = document.getElementById('toast-msg');
  const toastAction = document.getElementById('toast-action');
  const announcer = document.getElementById('announcer');

  const KIND_LABELS = Maps.KIND_LABELS;

  // Cards render newest-edited first; these two survive re-renders.
  let renamingId = null;
  let openMenuId = null;
  // Ids already shown once — their cards skip the entrance animation.
  const seenIds = new Set();

  function announce(msg) { announcer.textContent = msg; }

  // Cloud sync is optional plumbing — every call site guards on it.
  const cloud = window.TodoMapsCloud && TodoMapsCloud.enabled ? TodoMapsCloud : null;
  function cloudPush(id) { if (cloud) cloud.schedulePush(id, 400); }

  function editorHref(entry) {
    const base = entry.kind === 'impact-effort' ? '../impact-effort/' : '../';
    return base + '?map=' + encodeURIComponent(entry.id);
  }

  // ── Toast (share feedback + delete undo) ───────────────────────────────────

  let toastTimer = null;
  let toastOnExpire = null;
  let queuedToast = null;

  function hideToast(runExpire) {
    clearTimeout(toastTimer);
    toastTimer = null;
    toastEl.hidden = true;
    const expire = toastOnExpire;
    toastOnExpire = null;
    if (runExpire && expire) expire();
    // An informational toast that arrived during an undo window shows now
    if (queuedToast) {
      const q = queuedToast;
      queuedToast = null;
      showToast(q.msg, q.opts);
    }
  }

  function showToast(msg, opts) {
    opts = opts || {};
    // Never let a passing status message forfeit a pending undo (its expiry
    // is destructive) — park the new toast until the undo window resolves.
    // A second destructive toast settles the first one immediately instead.
    if (toastOnExpire && !opts.onExpire) {
      queuedToast = { msg, opts };
      return;
    }
    hideToast(true);
    toastMsg.textContent = msg;
    if (opts.actionLabel) {
      toastAction.textContent = opts.actionLabel;
      toastAction.hidden = false;
      toastAction.onclick = () => { hideToast(false); if (opts.onAction) opts.onAction(); };
    } else {
      toastAction.hidden = true;
      toastAction.onclick = null;
    }
    toastOnExpire = opts.onExpire || null;
    toastEl.hidden = false;
    toastTimer = setTimeout(() => hideToast(true), opts.duration || 5000);
    announce(msg);
  }

  // ── Thumbnail mini-cards ────────────────────────────────────────────────────

  // Deterministic PRNG so a map's schematic preview is stable across renders.
  function seededRand(seedStr) {
    let x = 0;
    for (let i = 0; i < seedStr.length; i++) x = (x * 31 + seedStr.charCodeAt(i)) >>> 0;
    x = x || 1;
    return () => {
      x = (x * 9301 + 49297) % 233280;
      return x / 233280;
    };
  }

  const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

  // Up to 9 mini cards, placed from the map's real task coordinates when the
  // board has been laid out (positions + canvas size saved), otherwise
  // scattered pseudo-randomly. Done tasks render faded.
  function buildThumbDots(entry, data) {
    const tasks = (data && Array.isArray(data.tasks)) ? data.tasks : [];
    const done = new Set((data && data.done) || []);
    const positions = (data && data.cardPositions) || {};
    const cv = data && data.canvas;
    const hasCanvas = cv && cv.w > 0 && cv.h > 0;
    const rand = seededRand(entry.id);
    const frag = document.createDocumentFragment();

    tasks.slice(0, 9).forEach(t => {
      const dot = document.createElement('div');
      dot.className = 'mini-card' + (done.has(t.id) ? ' done' : '');
      const p = positions[t.id];
      let x, y;
      if (hasCanvas && p) {
        // Editor positions are the card's top-left in px; +70/+20 ≈ its center.
        x = clamp(((p.x + 70) / cv.w) * 100, 6, 82);
        y = clamp(((p.y + 20) / cv.h) * 100, 12, 78);
      } else {
        x = 10 + rand() * 74;
        y = 18 + rand() * 60;
      }
      dot.style.left = x + '%';
      dot.style.top = y + '%';
      dot.style.width = Math.round(16 + rand() * 20) + 'px';
      frag.appendChild(dot);
    });
    return frag;
  }

  // ── Card rendering ──────────────────────────────────────────────────────────

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function openMap(entry) { location.href = editorHref(entry); }

  function buildCard(entry) {
    const card = el('div', 'map-card' + (seenIds.has(entry.id) ? '' : ' is-new'));
    seenIds.add(entry.id);
    card.dataset.id = entry.id;

    const data = Maps.readData(entry.id);
    const tasks = (data && Array.isArray(data.tasks)) ? data.tasks : [];
    const doneSet = new Set((data && data.done) || []);
    const doneCount = tasks.filter(t => doneSet.has(t.id)).length;

    // Thumbnail — a real link, so keyboard and middle-click work natively
    const thumb = el('a', 'map-thumb');
    thumb.href = editorHref(entry);
    thumb.setAttribute('aria-label', 'open ' + entry.name);
    thumb.appendChild(el('div', 'axis-v'));
    thumb.appendChild(el('div', 'axis-h'));
    thumb.appendChild(buildThumbDots(entry, data));
    const tag = el('span', 'map-kind-tag', KIND_LABELS[entry.kind] || entry.kind);
    thumb.appendChild(tag);
    thumb.addEventListener('click', (e) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey) return; // let new-tab clicks be
      e.preventDefault();
      openMap(entry);
    });
    card.appendChild(thumb);

    // Title row
    const row = el('div', 'map-title-row');

    if (renamingId === entry.id) {
      const input = el('input', 'map-rename-input');
      input.type = 'text';
      input.value = entry.name;
      input.maxLength = 120; // matches maps-index.js's MAX_NAME_LEN
      input.setAttribute('aria-label', 'map name');
      let cancelled = false;
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') input.blur();
        if (e.key === 'Escape') { cancelled = true; input.blur(); }
      });
      input.addEventListener('blur', () => {
        renamingId = null;
        if (!cancelled) { Maps.rename(entry.id, input.value); cloudPush(entry.id); }
        render();
      });
      row.appendChild(input);
      // Focus after it's in the DOM
      requestAnimationFrame(() => { input.focus(); input.select(); });
    } else {
      const title = el('a', 'map-title', entry.name);
      title.href = editorHref(entry);
      title.title = 'double-click to rename';
      let openTimer = null;
      title.addEventListener('click', (e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey) return; // let new-tab clicks be
        e.preventDefault();
        // Debounce so double-click (rename) doesn't also open
        clearTimeout(openTimer);
        if (e.detail > 1) return;
        openTimer = setTimeout(() => openMap(entry), 250);
      });
      title.addEventListener('dblclick', () => {
        clearTimeout(openTimer);
        startRename(entry.id);
      });
      row.appendChild(title);
    }

    row.appendChild(el('span', 'map-count', doneCount + '/' + tasks.length));

    const menuBtn = el('button', 'map-menu-btn', '⋯');
    menuBtn.type = 'button';
    menuBtn.setAttribute('aria-label', 'actions for ' + entry.name);
    menuBtn.setAttribute('aria-haspopup', 'menu');
    menuBtn.setAttribute('aria-expanded', String(openMenuId === entry.id));
    menuBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openMenuId = openMenuId === entry.id ? null : entry.id;
      render();
    });
    row.appendChild(menuBtn);
    card.appendChild(row);

    // ⋯ dropdown
    if (openMenuId === entry.id) {
      const menu = el('div', 'map-menu');
      menu.setAttribute('role', 'menu');
      menu.addEventListener('click', (e) => e.stopPropagation());
      menu.addEventListener('keydown', (e) => {
        const items = [...menu.querySelectorAll('[role="menuitem"]')];
        const idx = items.indexOf(document.activeElement);
        if (e.key === 'Escape') {
          e.stopPropagation();
          openMenuId = null;
          render();
          const btn = grid.querySelector('.map-card[data-id="' + entry.id + '"] .map-menu-btn');
          if (btn) btn.focus();
        } else if (e.key === 'ArrowDown') { e.preventDefault(); (items[idx + 1] || items[0]).focus(); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); (items[idx - 1] || items[items.length - 1]).focus(); }
        else if (e.key === 'Home') { e.preventDefault(); items[0].focus(); }
        else if (e.key === 'End') { e.preventDefault(); items[items.length - 1].focus(); }
      });

      const item = (label, className, fn) => {
        const b = el('button', className, label);
        b.type = 'button';
        b.setAttribute('role', 'menuitem');
        b.addEventListener('click', () => { openMenuId = null; fn(); });
        menu.appendChild(b);
      };
      item('rename', '', () => startRename(entry.id));
      item('duplicate', '', () => duplicateMap(entry));
      item('share', '', () => { render(); shareMap(entry); });
      item('delete', 'menu-delete', () => deleteMap(entry));
      card.appendChild(menu);
      // Menu just opened via the ⋯ button — move focus to its first action
      requestAnimationFrame(() => {
        const first = menu.querySelector('[role="menuitem"]');
        if (first && card.contains(menu)) first.focus();
      });
    }

    return card;
  }

  // A render that lands mid-rename would rebuild the input from the stored
  // name and eat what the user typed — defer it; the input's blur handler
  // renders anyway.
  let pendingRender = false;

  function render() {
    if (renamingId !== null) {
      const input = grid.querySelector('.map-rename-input');
      if (input && document.activeElement === input) { pendingRender = true; return; }
    }
    pendingRender = false;
    const entries = Maps.list().slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

    grid.textContent = '';
    entries.forEach(entry => grid.appendChild(buildCard(entry)));

    const tile = el('button', 'new-map-tile');
    tile.type = 'button';
    tile.setAttribute('aria-label', 'new map');
    tile.appendChild(el('span', '', '+'));
    tile.addEventListener('click', openKindPicker);
    grid.appendChild(tile);

    emptyState.hidden = entries.length !== 0;
  }

  // ── Actions ─────────────────────────────────────────────────────────────────

  function startRename(id) {
    renamingId = id;
    openMenuId = null;
    render();
  }

  function duplicateMap(entry) {
    const copyId = Maps.duplicate(entry.id);
    if (copyId === null) {
      showToast('couldn’t duplicate — browser storage is unavailable.');
      return;
    }
    cloudPush(copyId);
    render();
  }

  function deleteMap(entry) {
    // Everything leaves immediately — entry, data slot, server row — so a tab
    // closed mid-toast can't resurrect the map later; undo restores from the
    // in-memory capture. The share link outlives the undo window on purpose:
    // its revoke is queued and drained only once the toast expires.
    const data = Maps.readData(entry.id);
    if (!Maps.remove(entry.id, true)) {
      showToast('couldn’t delete — browser storage is unavailable.');
      return;
    }
    if (cloud) cloud.pushDelete(entry.id);
    const share = entry.share;
    const revokes = window.TodoMapsCloud || null;
    if (share && share.id && share.ownerKey && revokes) {
      revokes.queueShareRevoke(share.id, share.ownerKey);
    }
    render();
    showToast('deleted “' + entry.name + '”', {
      actionLabel: 'undo',
      onAction: () => {
        Maps.restore(entry);
        if (data && !Maps.writeData(entry.id, data)) {
          showToast('map restored, but its tasks couldn’t be saved (storage full?)');
        }
        if (share && share.id && revokes) revokes.dequeueShareRevoke(share.id);
        if (cloud) cloud.undeleteMap(entry.id);
        render();
      },
      onExpire: () => {
        if (share && share.id && revokes) revokes.drainShareRevokes();
      },
    });
  }

  // Resolves true only when the link actually reached the clipboard — the
  // toast copy stops claiming "copied" when it didn't.
  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(() => true, () => fallbackCopy(text));
    }
    return Promise.resolve(fallbackCopy(text));
  }

  function fallbackCopy(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { /* clipboard unavailable */ }
    ta.remove();
    return ok;
  }

  async function shareMap(entry) {
    const data = Maps.readData(entry.id) || {};
    const payload = {
      version: 1,
      tasks: Array.isArray(data.tasks) ? data.tasks : [],
      cardPositions: data.cardPositions || {},
      done: data.done || [],
      canvas: data.canvas || { w: 0, h: 0 },
    };
    const shareUrl = (id) =>
      new URL(entry.kind === 'impact-effort' ? '../impact-effort/' : '../', location.href).href + '#m=' + id;

    showToast('publishing…', { duration: 15000 });
    try {
      const existing = entry.share;
      if (existing && existing.id && existing.ownerKey) {
        // Already shared once from here — refresh the same link if it's alive.
        const ok = await TodoMapShare.update(existing.id, existing.ownerKey, payload);
        if (ok) {
          Maps.setShare(entry.id, { ...existing, updatedAt: new Date().toISOString() });
          const copied = await copyText(shareUrl(existing.id));
          showToast(copied ? 'share link updated and copied' : 'share link updated — couldn’t reach the clipboard');
          return;
        }
        // Link was deleted server-side — fall through and publish fresh.
      }
      const res = await TodoMapShare.publish(payload, entry.kind);
      const now = new Date().toISOString();
      Maps.setShare(entry.id, {
        id: res.id,
        ownerKey: res.owner_key,
        publishedAt: now,
        updatedAt: now,
      });
      const copied = await copyText(shareUrl(res.id));
      showToast(copied ? 'share link copied' : 'link published — couldn’t reach the clipboard');
    } catch (err) {
      showToast('couldn’t share: ' + err.message);
    }
  }

  // ── New-map picker ──────────────────────────────────────────────────────────

  // Minimal focus trap shared by the two dialogs: Tab cycles inside the
  // panel, and focus returns to whatever opened it on close.
  function trapFocus(overlay, panel) {
    let opener = null;
    overlay.addEventListener('keydown', (e) => {
      if (e.key !== 'Tab') return;
      const list = [...panel.querySelectorAll('button, [href], input, select, textarea')]
        .filter((el) => !el.hidden && el.offsetParent !== null && !el.disabled);
      if (!list.length) return;
      const first = list[0];
      const last = list[list.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    });
    return {
      opened() { opener = document.activeElement; },
      closed() { if (opener && opener.focus) opener.focus(); opener = null; },
    };
  }

  const kindTrap = trapFocus(kindPicker, kindPicker.querySelector('.kind-picker-panel'));

  function openKindPicker() {
    kindTrap.opened();
    kindPicker.hidden = false;
    requestAnimationFrame(() => {
      const first = kindPicker.querySelector('.kind-option');
      if (first) first.focus();
    });
  }
  function closeKindPicker() { kindPicker.hidden = true; kindTrap.closed(); }

  // "untitled map", "untitled map 2", … — identical names make the dock and
  // grid unreadable, so new maps count up.
  function untitledName() {
    const names = new Set(Maps.list().map((e) => e.name));
    if (!names.has('untitled map')) return 'untitled map';
    let n = 2;
    while (names.has('untitled map ' + n)) n++;
    return 'untitled map ' + n;
  }

  function createMap(kind) {
    closeKindPicker();
    const id = Maps.create({ kind, name: untitledName() });
    if (id === null) {
      showToast('couldn’t create a map — browser storage is unavailable.');
      return;
    }
    cloudPush(id);
    startRename(id);
  }

  // PHASE_ORDER for both editor variants — kept here too since home.js runs
  // before either editor's app.js is ever loaded.
  const PHASE_ORDER = {
    'urgency-importance': ['dump', 'sort-urgency', 'sort-importance', 'scatter'],
    'impact-effort': ['dump', 'sort-impact', 'sort-effort', 'scatter'],
  };

  // Every live task-text entry point in both editors caps text at 500 chars
  // (maxlength on the quick-add inputs, .slice(0, 500) in every inline-edit
  // save(), and the editors' own parseGridFile() on their in-app import).
  // This is a *second*, independently-written import path — the home
  // screen's own "import from file" button — and it was building the new
  // map's data straight from the parsed file with none of that validation:
  // unbounded task text renders a card far taller than the canvas (same
  // clipping bug parseGridFile() was fixed for), and malformed history
  // entries crash buildHistoryTimeline()/selectSnapshot() the same way a
  // hand-edited export could before parseGridFile() gained its own shape
  // check. Mirror that same sanitizing here so this entry point is covered
  // the same way the in-editor import already is.
  function sanitizeImportedGrid(g, kind) {
    const tasks = g.tasks.map(t => ({ id: t.id, text: t.text.slice(0, 500) }));
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
    const [orderA, orderB] = kind === 'impact-effort'
      ? ['impactOrder', 'effortOrder']
      : ['urgencyOrder', 'importanceOrder'];
    const slot = {
      tasks,
      phase: PHASE_ORDER[kind].indexOf(g.phase) !== -1 ? g.phase : 'dump',
      cardPositions: positions,
      done: idList(g.done),
      idCounter: counter,
      history,
    };
    slot[orderA] = idList(g[orderA]);
    slot[orderB] = idList(g[orderB]);
    return slot;
  }

  function importFromFile(file) {
    // Exports are a few KB; anything huge is the wrong file.
    if (file.size > 1024 * 1024) {
      showToast('couldn’t import — that file is too large to be a map export.');
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => showToast('couldn’t read that file.');
    reader.onload = (e) => {
      let data = null;
      try { data = JSON.parse(e.target.result); } catch (err) { /* handled below */ }
      const g = data && data.grid;
      // Ids must be plain tokens, matching parseGridFile()'s own check in both
      // editors: a task's id gets interpolated into `[data-id="${t.id}"]`
      // querySelector strings once this map is opened, with no escaping —
      // an id like `t1"]` breaks out of the attribute selector and throws a
      // DOMException the first time any of those call sites run. This is a
      // second, independently-written import path, so it needs the same guard.
      const tasksOk = g && Array.isArray(g.tasks) &&
        g.tasks.every((t) => t && typeof t.id === 'string' && /^[\w-]+$/.test(t.id) && typeof t.text === 'string');
      if (!tasksOk) {
        showToast('couldn’t import — not a to-do map export.');
        return;
      }
      // Exports carry the variant's ordering fields, which tells us the kind.
      const kind = ('impactOrder' in g) ? 'impact-effort' : 'urgency-importance';
      const slot = sanitizeImportedGrid(g, kind);
      const id = Maps.create({
        kind,
        name: file.name.replace(/\.json$/i, ''),
        data: slot,
      });
      if (id === null) {
        showToast('couldn’t import — browser storage is unavailable.');
        return;
      }
      cloudPush(id);
      closeKindPicker();
      render();
      announce('map imported');
    };
    reader.readAsText(file);
  }

  // ── Wiring ──────────────────────────────────────────────────────────────────

  document.getElementById('btn-new-map').addEventListener('click', openKindPicker);

  kindPicker.addEventListener('click', (e) => {
    if (e.target === kindPicker) closeKindPicker();
  });
  kindPicker.querySelectorAll('.kind-option[data-kind]').forEach(btn => {
    btn.addEventListener('click', () => createMap(btn.dataset.kind));
  });
  document.getElementById('btn-import').addEventListener('click', () => importInput.click());
  importInput.addEventListener('change', () => {
    if (importInput.files.length > 0) {
      importFromFile(importInput.files[0]);
      importInput.value = '';
    }
  });

  // ── Account (magic-link sign-in) ────────────────────────────────────────────

  const authLink = document.getElementById('auth-link');
  const authModal = document.getElementById('auth-modal');
  const authSignedOut = document.getElementById('auth-signedout');
  const authSignedIn = document.getElementById('auth-signedin');
  const authEmail = document.getElementById('auth-email');
  const authSend = document.getElementById('auth-send');
  const authStatus = document.getElementById('auth-status');
  const authUserEmail = document.getElementById('auth-user-email');
  const authSent = document.getElementById('auth-sent');
  const authSentEmail = document.getElementById('auth-sent-email');

  function refreshAuthLink() {
    if (!cloud) return; // stays hidden — no account system without sync
    const user = cloud.currentUser();
    authLink.hidden = false;
    authLink.textContent = user && user.email ? user.email : 'sign in';
  }

  // Honest sync surface: hidden while things work, one short line when they
  // don't. Driven by TodoMapsCloud's status tracker (no retry machinery).
  const syncStatusEl = document.getElementById('sync-status');

  function refreshSyncStatus() {
    if (!cloud || !syncStatusEl) return;
    const s = cloud.getStatus();
    syncStatusEl.textContent = '';
    if (s === 'offline') {
      syncStatusEl.textContent = 'offline — changes stay in this browser';
    } else if (s === 'error') {
      syncStatusEl.append('sync failed · ');
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.textContent = 'retry';
      retry.addEventListener('click', () => {
        cloud.syncNow()
          .then((changed) => { if (changed) render(); })
          .catch(() => { /* the status line already reports it */ });
      });
      syncStatusEl.appendChild(retry);
    } else if (s === 'signed-out') {
      const link = document.createElement('button');
      link.type = 'button';
      link.textContent = 'signed out — sign in to sync';
      link.addEventListener('click', openAuthModal);
      syncStatusEl.appendChild(link);
    }
    syncStatusEl.hidden = !syncStatusEl.firstChild;
  }

  const authTrap = trapFocus(authModal, authModal.querySelector('.auth-panel'));

  function openAuthModal() {
    const user = cloud.currentUser();
    const signedIn = !!(user && user.email);
    authSignedOut.hidden = signedIn;
    authSignedIn.hidden = !signedIn;
    authSent.hidden = true;
    if (signedIn) {
      authUserEmail.textContent = user.email;
    } else {
      authStatus.hidden = true;
      authSend.disabled = false;
    }
    authTrap.opened();
    authModal.hidden = false;
    requestAnimationFrame(() => {
      if (!signedIn) authEmail.focus();
      else document.getElementById('auth-signout').focus();
    });
  }
  function closeAuthModal() { authModal.hidden = true; authTrap.closed(); }

  async function sendMagicLink() {
    const email = authEmail.value.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      authStatus.textContent = 'that doesn’t look like an email address.';
      authStatus.hidden = false;
      return;
    }
    authSend.disabled = true;
    authStatus.textContent = 'sending…';
    authStatus.hidden = false;
    try {
      await cloud.signInWithEmail(email);
      authStatus.hidden = true;
      authSignedOut.hidden = true;
      authSentEmail.textContent = 'we sent a link to ' + email;
      authSent.hidden = false;
    } catch (err) {
      authSend.disabled = false;
      authStatus.textContent = 'couldn’t send: ' + err.message;
    }
  }

  if (cloud) {
    authLink.addEventListener('click', openAuthModal);
    authSend.addEventListener('click', sendMagicLink);
    authEmail.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendMagicLink(); });
    document.getElementById('auth-resend').addEventListener('click', async () => {
      try {
        await cloud.signInWithEmail(authEmail.value.trim());
        announce('link sent again');
      } catch (err) { /* keep the sent panel; a resend failure is silent */ }
    });
    document.getElementById('auth-change-email').addEventListener('click', () => {
      authSent.hidden = true;
      authSignedOut.hidden = false;
      authSend.disabled = false;
      requestAnimationFrame(() => authEmail.focus());
    });
    document.getElementById('auth-signout').addEventListener('click', () => {
      cloud.signOut();
      closeAuthModal();
      refreshAuthLink();
      showToast('signed out — your maps stay in this browser');
    });
    authModal.addEventListener('click', (e) => { if (e.target === authModal) closeAuthModal(); });
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !kindPicker.hidden) closeKindPicker();
    if (e.key === 'Escape' && !authModal.hidden) closeAuthModal();
    if (e.key === 'Escape' && openMenuId !== null) { openMenuId = null; render(); }
  });

  // Any outside click closes an open ⋯ menu
  document.addEventListener('click', () => {
    if (openMenuId !== null) { openMenuId = null; render(); }
  });

  // Freshness: a bfcache Back restores this page exactly as it was — counts
  // and thumbnails included — so re-render from storage. The storage listener
  // keeps edits made in other tabs visible without a reload.
  window.addEventListener('pageshow', (e) => {
    if (e.persisted) { render(); refreshAuthLink(); refreshSyncStatus(); }
  });
  let storageRenderTimer = null;
  window.addEventListener('storage', (e) => {
    const relevant = !e.key || e.key === 'todoMapsIndex.v1' ||
      e.key.indexOf('todomap-map-') === 0 || e.key === 'todomap-auth.v1';
    if (!relevant) return;
    clearTimeout(storageRenderTimer);
    storageRenderTimer = setTimeout(() => { render(); refreshAuthLink(); }, 150);
  });

  // ── Boot ────────────────────────────────────────────────────────────────────

  Maps.migrateLegacy();
  // Fold pre-multi-map share links (kind-keyed store) into their map entries.
  if (window.TodoMapShare && TodoMapShare.adoptLegacyShares) TodoMapShare.adoptLegacyShares();

  // A magic link may have just landed us here with tokens in the hash;
  // consume them before first render.
  if (cloud) {
    const auth = cloud.consumeAuthHash();
    if (auth && auth.error) showToast('sign-in failed: ' + auth.error);
    else if (auth) showToast(auth.email ? 'signed in as ' + auth.email : 'signed in');
  }

  render();
  refreshAuthLink();
  refreshSyncStatus();

  if (cloud) {
    cloud.onStatus(refreshSyncStatus);
    cloud.syncNow()
      .then((changed) => { if (changed) render(); })
      .catch((e) => console.warn('[todomap sync]', e.message));
  }
})();
