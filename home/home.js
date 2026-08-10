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

  const KIND_LABELS = {
    'urgency-importance': 'urgency × importance',
    'impact-effort': 'impact × effort',
  };

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

  function hideToast(runExpire) {
    clearTimeout(toastTimer);
    toastTimer = null;
    toastEl.hidden = true;
    const expire = toastOnExpire;
    toastOnExpire = null;
    if (runExpire && expire) expire();
  }

  function showToast(msg, opts) {
    // A pending delete's cleanup runs now so toasts never queue up.
    hideToast(true);
    opts = opts || {};
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

    // Thumbnail
    const thumb = el('div', 'map-thumb');
    thumb.appendChild(el('div', 'axis-v'));
    thumb.appendChild(el('div', 'axis-h'));
    thumb.appendChild(buildThumbDots(entry, data));
    const tag = el('span', 'map-kind-tag', KIND_LABELS[entry.kind] || entry.kind);
    thumb.appendChild(tag);
    thumb.addEventListener('click', () => openMap(entry));
    card.appendChild(thumb);

    // Title row
    const row = el('div', 'map-title-row');

    if (renamingId === entry.id) {
      const input = el('input', 'map-rename-input');
      input.type = 'text';
      input.value = entry.name;
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
      const title = el('div', 'map-title', entry.name);
      title.title = 'double-click to rename';
      let openTimer = null;
      title.addEventListener('click', (e) => {
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
    }

    return card;
  }

  function render() {
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
    // The entry leaves the index right away; its data slot sticks around
    // until the undo toast expires.
    Maps.remove(entry.id, false);
    render();
    showToast('deleted “' + entry.name + '”', {
      actionLabel: 'undo',
      onAction: () => { Maps.restore(entry); cloudPush(entry.id); render(); },
      onExpire: () => { Maps.dropSlot(entry.id); if (cloud) cloud.pushDelete(entry.id); },
    });
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
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
    try { document.execCommand('copy'); } catch (e) { /* clipboard unavailable */ }
    ta.remove();
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

    showToast('publishing…', { duration: 60000 });
    try {
      const existing = entry.share;
      if (existing && existing.id && existing.ownerKey) {
        // Already shared once from here — refresh the same link if it's alive.
        const ok = await TodoMapShare.update(existing.id, existing.ownerKey, payload);
        if (ok) {
          await copyText(shareUrl(existing.id));
          showToast('share link updated and copied');
          return;
        }
        // Link was deleted server-side — fall through and publish fresh.
      }
      const res = await TodoMapShare.publish(payload, entry.kind);
      Maps.setShare(entry.id, {
        id: res.id,
        ownerKey: res.owner_key,
        publishedAt: new Date().toISOString(),
      });
      await copyText(shareUrl(res.id));
      showToast('share link copied');
    } catch (err) {
      showToast('couldn’t share: ' + err.message);
    }
  }

  // ── New-map picker ──────────────────────────────────────────────────────────

  function openKindPicker() { kindPicker.hidden = false; }
  function closeKindPicker() { kindPicker.hidden = true; }

  function createMap(kind) {
    closeKindPicker();
    const id = Maps.create({ kind, name: 'untitled map' });
    if (id === null) {
      showToast('couldn’t create a map — browser storage is unavailable.');
      return;
    }
    cloudPush(id);
    startRename(id);
  }

  function importFromFile(file) {
    const reader = new FileReader();
    reader.onload = (e) => {
      let data = null;
      try { data = JSON.parse(e.target.result); } catch (err) { /* handled below */ }
      const g = data && data.grid;
      if (!g || !Array.isArray(g.tasks)) {
        showToast('couldn’t import — not a To-Do Map export.');
        return;
      }
      // Exports carry the variant's ordering fields, which tells us the kind.
      const kind = ('impactOrder' in g) ? 'impact-effort' : 'urgency-importance';
      const slot = Object.assign({}, g, {
        phase: g.phase || 'dump',
        history: g.history || [],
      });
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
      announce('Map imported.');
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

  function refreshAuthLink() {
    if (!cloud) return; // stays hidden — no account system without sync
    const user = cloud.currentUser();
    authLink.hidden = false;
    authLink.textContent = user && user.email ? user.email : 'sign in';
  }

  function openAuthModal() {
    const user = cloud.currentUser();
    const signedIn = !!(user && user.email);
    authSignedOut.hidden = signedIn;
    authSignedIn.hidden = !signedIn;
    if (signedIn) {
      authUserEmail.textContent = user.email;
    } else {
      authStatus.hidden = true;
      authSend.disabled = false;
    }
    authModal.hidden = false;
    if (!signedIn) requestAnimationFrame(() => authEmail.focus());
  }
  function closeAuthModal() { authModal.hidden = true; }

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
      authStatus.textContent = 'magic link sent — check your inbox.';
    } catch (err) {
      authSend.disabled = false;
      authStatus.textContent = 'couldn’t send: ' + err.message;
    }
  }

  if (cloud) {
    authLink.addEventListener('click', openAuthModal);
    authSend.addEventListener('click', sendMagicLink);
    authEmail.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendMagicLink(); });
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
  });

  // Any outside click closes an open ⋯ menu
  document.addEventListener('click', () => {
    if (openMenuId !== null) { openMenuId = null; render(); }
  });

  // ── Boot ────────────────────────────────────────────────────────────────────

  Maps.migrateLegacy();

  // A magic link may have just landed us here with tokens in the hash;
  // consume them before first render (signing in can re-id local maps).
  if (cloud) {
    const auth = cloud.consumeAuthHash();
    if (auth && auth.error) showToast('sign-in failed: ' + auth.error);
    else if (auth) showToast(auth.email ? 'signed in as ' + auth.email : 'signed in');
  }

  render();
  refreshAuthLink();

  if (cloud) {
    cloud.syncNow()
      .then((changed) => { if (changed) render(); })
      .catch((e) => console.warn('[todomap sync]', e.message));
  }
})();
