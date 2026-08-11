// ─────────────────────────────────────────────────────────────────────────────
// To-Do Map · sharing module
//
// Talks to the Supabase functions defined in supabase/schema.sql via plain
// fetch() RPC calls (no client library, no build step). Loaded by both the
// main map and the impact/effort variant BEFORE app.js; each app.js wires it
// up through TodoMapShare.initShareUI() and the shared-view boot path.
//
// Share records ({ id, ownerKey, publishedAt, updatedAt }) live on each map's
// entry in the maps index — the dialog reaches them through accessors the
// caller passes to initShareUI. The old kind-keyed 'todomap-shares' store is
// folded into the index once by adoptLegacyShares().
// ─────────────────────────────────────────────────────────────────────────────

(function () {
  'use strict';

  const cfg = window.TODOMAP_SHARE_CONFIG || {};
  const configured = !!(
    cfg.supabaseUrl && /^https:\/\//.test(cfg.supabaseUrl) &&
    cfg.supabaseAnonKey && !/^YOUR_/.test(cfg.supabaseAnonKey)
  );

  const OWNER_STORE_KEY = 'todomap-shares';

  // ── Supabase RPC ────────────────────────────────────────────────────────────

  async function rpc(fn, args) {
    if (!configured) {
      throw new Error('Sharing is not configured yet (see share-config.js).');
    }
    const res = await fetch(`${cfg.supabaseUrl.replace(/\/$/, '')}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': cfg.supabaseAnonKey,
        'Authorization': `Bearer ${cfg.supabaseAnonKey}`,
      },
      body: JSON.stringify(args),
    });
    if (!res.ok) {
      let msg = `Request failed (${res.status})`;
      try {
        const body = await res.json();
        if (body && body.message) msg = body.message;
      } catch (e) { /* non-JSON error body */ }
      throw new Error(msg);
    }
    const text = await res.text();
    return text && text !== 'null' ? JSON.parse(text) : null;
  }

  const api = {
    publish: (data, kind) => rpc('publish_map', { map_data: data, map_kind: kind }),
    fetchMap: (id) => rpc('get_shared_map', { map_id: id }),
    update: (id, key, data) => rpc('update_shared_map', { map_id: id, owner_key: key, map_data: data }),
    remove: (id, key) => rpc('delete_shared_map', { map_id: id, owner_key: key }),
  };

  // ── Legacy owner-key store migration ────────────────────────────────────────

  function readOwnerStore() {
    try { return JSON.parse(localStorage.getItem(OWNER_STORE_KEY)) || {}; }
    catch (e) { return {}; }
  }

  // Pre-multi-map browsers kept published links here, keyed by map kind — so
  // two maps of the same kind would fight over one record. The maps index owns
  // share records now (entry.share); fold unambiguous store records into it,
  // then retire the store. Called once from the home screen's boot.
  function adoptLegacyShares() {
    if (!window.TodoMapsIndex) return;
    const store = readOwnerStore();
    const recIds = Object.keys(store);
    if (recIds.length) {
      const newestByKind = {};
      recIds.forEach(id => {
        const rec = store[id];
        if (!rec || !rec.kind) return;
        const cur = newestByKind[rec.kind];
        if (!cur || (rec.publishedAt || '') > (store[cur].publishedAt || '')) {
          newestByKind[rec.kind] = id;
        }
      });
      const mapsByKind = {};
      TodoMapsIndex.list().forEach(e => {
        (mapsByKind[e.kind] = mapsByKind[e.kind] || []).push(e);
      });
      Object.keys(newestByKind).forEach(kind => {
        const candidates = mapsByKind[kind] || [];
        // Adopt only when there is exactly one possible owner — never guess
        // whose link it is. Unadopted links stay alive as they are.
        if (candidates.length !== 1 || candidates[0].share) return;
        const id = newestByKind[kind];
        const rec = store[id];
        TodoMapsIndex.setShare(candidates[0].id, {
          id,
          ownerKey: rec.key,
          publishedAt: rec.publishedAt,
          updatedAt: rec.updatedAt,
        });
      });
    }
    try { localStorage.removeItem(OWNER_STORE_KEY); } catch (e) { /* storage unavailable */ }
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  const hashMatch = /^#m=([A-Za-z0-9]{4,})$/.exec(location.hash || '');
  const sharedMapId = hashMatch ? hashMatch[1] : null;

  function shareUrlFor(id) {
    return location.origin + location.pathname + '#m=' + id;
  }

  function timeAgo(iso) {
    const then = new Date(iso).getTime();
    if (!isFinite(then)) return '';
    const mins = Math.max(0, Math.round((Date.now() - then) / 60000));
    if (mins < 2) return 'just now';
    if (mins < 60) return `${mins} min ago`;
    const hours = Math.round(mins / 60);
    if (hours < 24) return hours === 1 ? '1 hour ago' : `${hours} hours ago`;
    const days = Math.round(hours / 24);
    if (days < 31) return days === 1 ? 'yesterday' : `${days} days ago`;
    return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }

  function copyToClipboard(text, inputEl) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(() => true, () => fallbackCopy(inputEl));
    }
    return Promise.resolve(fallbackCopy(inputEl));
  }
  function fallbackCopy(inputEl) {
    if (!inputEl) return false;
    inputEl.focus();
    inputEl.select();
    try { return document.execCommand('copy'); } catch (e) { return false; }
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  // ── Owner UI: share button + dialog ─────────────────────────────────────────

  function initShareUI(opts) {
    // opts: { kind, serialize, getShare, setShare, clearShare }
    //   serialize()   → the publishable JSON
    //   getShare()    → this map's { id, ownerKey, publishedAt, updatedAt } or null
    //   setShare(rec) / clearShare() → persist or drop that record
    const wrap = document.getElementById('canvas-util-wrap');
    if (!wrap || sharedMapId) return; // no owner UI inside a shared view

    const sep = el('span', 'canvas-util-sep', '·');
    sep.setAttribute('aria-hidden', 'true');
    const btn = el('button', 'canvas-util-btn', 'share');
    btn.id = 'btn-share';
    btn.setAttribute('aria-label', 'Share this map with a link');
    wrap.appendChild(sep);
    wrap.appendChild(btn);

    btn.addEventListener('click', () => openShareDialog(opts));
  }

  function openShareDialog(opts) {
    const existing = opts.getShare();
    const data = opts.serialize();

    const backdrop = el('div', 'share-dialog-backdrop');
    const dialog = el('div', 'share-dialog');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-label', 'Share this map');
    backdrop.appendChild(dialog);

    const status = el('div', 'share-status');
    status.setAttribute('aria-live', 'polite');

    const opener = document.activeElement;
    function close() {
      backdrop.remove();
      document.removeEventListener('keydown', onKey);
      if (opener && opener.focus) opener.focus();
    }
    function onKey(e) {
      if (e.key === 'Escape') { close(); return; }
      // Keep Tab inside the dialog while it's up
      if (e.key === 'Tab') {
        const list = [...dialog.querySelectorAll('button, input, [href]')]
          .filter((n) => !n.disabled && n.offsetParent !== null);
        if (!list.length) return;
        const first = list[0];
        const last = list[list.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
        else if (!dialog.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
      }
    }
    document.addEventListener('keydown', onKey);
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });

    function setStatus(msg, isError) {
      status.textContent = msg;
      status.classList.toggle('error', !!isError);
    }

    function renderPublishedState(id) {
      dialog.textContent = '';
      dialog.appendChild(el('h2', null, 'This map is shared'));
      const p = el('p', null, 'Anyone with this link can read these items. The link shows the version you last published — your edits stay private until you update it.');
      dialog.appendChild(p);

      const row = el('div', 'share-link-row');
      const input = el('input');
      input.type = 'text';
      input.readOnly = true;
      input.value = shareUrlFor(id);
      input.setAttribute('aria-label', 'Share link');
      input.addEventListener('focus', () => input.select());
      const copyBtn = el('button', 'share-btn-primary', 'Copy link');
      copyBtn.addEventListener('click', () => {
        copyToClipboard(input.value, input).then(ok => {
          setStatus(ok ? 'Link copied.' : 'Select the link and copy it manually.', !ok);
        });
      });
      row.appendChild(input);
      row.appendChild(copyBtn);
      dialog.appendChild(row);

      const actions = el('div', 'share-dialog-actions');
      const updateBtn = el('button', 'share-btn-quiet', 'Update shared link');
      updateBtn.addEventListener('click', async () => {
        const rec = opts.getShare();
        if (!rec || rec.id !== id) return;
        const fresh = opts.serialize();
        updateBtn.disabled = true;
        setStatus('Updating…');
        try {
          const ok = await api.update(id, rec.ownerKey, fresh);
          if (ok) {
            rec.updatedAt = new Date().toISOString();
            opts.setShare(rec);
            setStatus('Updated — everyone with the link now sees this version.');
          } else {
            setStatus('This link no longer exists on the server. Publish a new one.', true);
            opts.clearShare();
          }
        } catch (err) {
          setStatus(err.message, true);
        }
        updateBtn.disabled = false;
      });

      const stopBtn = el('button', 'share-btn-quiet share-btn-danger', 'Stop sharing');
      stopBtn.addEventListener('click', async () => {
        const rec = opts.getShare();
        if (!rec || rec.id !== id) return;
        stopBtn.disabled = true;
        setStatus('Removing…');
        try {
          await api.remove(id, rec.ownerKey);
          opts.clearShare();
          setStatus('');
          renderUnpublishedState();
        } catch (err) {
          setStatus(err.message, true);
          stopBtn.disabled = false;
        }
      });

      const closeBtn = el('button', 'share-btn-quiet', 'Close');
      closeBtn.addEventListener('click', close);

      actions.appendChild(updateBtn);
      actions.appendChild(stopBtn);
      actions.appendChild(closeBtn);
      dialog.appendChild(actions);
      dialog.appendChild(status);
      copyBtn.focus();
    }

    function renderUnpublishedState() {
      dialog.textContent = '';
      dialog.appendChild(el('h2', null, 'Share this map'));
      dialog.appendChild(el('p', null,
        'Publishing creates a link that opens a read-only copy of this map and its list. ' +
        'Anyone with the link can read these items — nothing else on your board is included.'));

      const actions = el('div', 'share-dialog-actions');
      const publishBtn = el('button', 'share-btn-primary', 'Publish & copy link');
      const cancelBtn = el('button', 'share-btn-quiet', 'Cancel');
      cancelBtn.addEventListener('click', close);
      actions.appendChild(publishBtn);
      actions.appendChild(cancelBtn);
      dialog.appendChild(actions);
      dialog.appendChild(status);

      if (!data.tasks || data.tasks.length === 0) {
        publishBtn.disabled = true;
        setStatus('Nothing to share yet — the map is empty.');
      }

      publishBtn.addEventListener('click', async () => {
        publishBtn.disabled = true;
        setStatus('Publishing…');
        try {
          const fresh = opts.serialize();
          const result = await api.publish(fresh, opts.kind);
          const now = new Date().toISOString();
          opts.setShare({ id: result.id, ownerKey: result.owner_key, publishedAt: now, updatedAt: now });
          renderPublishedState(result.id);
          const input = dialog.querySelector('input');
          copyToClipboard(shareUrlFor(result.id), input).then(ok => {
            setStatus(ok ? 'Published — link copied to your clipboard.' : 'Published. Copy the link above.');
          });
        } catch (err) {
          setStatus(err.message, true);
          publishBtn.disabled = false;
        }
      });

      publishBtn.focus();
    }

    document.body.appendChild(backdrop);
    if (existing) renderPublishedState(existing.id);
    else renderUnpublishedState();
  }

  // ── Viewer UI: banner, list panel, error overlay ────────────────────────────

  function renderSharedChrome(opts) {
    // opts: {
    //   record: {data, map_kind, updated_at},
    //   getState: () => ({ tasks, done }),   // live sandbox state for the list
    //   onCopyToBoard, onReset,
    // }
    const banner = el('div', 'share-banner');
    banner.setAttribute('role', 'region');
    banner.setAttribute('aria-label', 'Shared map');

    banner.appendChild(el('span', 'share-banner-title', 'Shared map — your copy'));
    const live = opts.getState();
    const count = live.tasks.length;
    const metaBits = [`${count} item${count === 1 ? '' : 's'}`, 'edits save on this device only'];
    banner.appendChild(el('span', 'share-banner-meta', metaBits.join(' · ')));
    banner.appendChild(el('span', 'share-banner-spacer'));

    const listBtn = el('button', null, 'View list');
    const resetBtn = el('button', null, 'Reset to owner’s version');
    const copyBtn = el('button', null, 'Copy to my board');
    const ownLink = el('a', null, 'Make your own →');
    ownLink.href = location.pathname;

    banner.appendChild(listBtn);
    banner.appendChild(resetBtn);
    banner.appendChild(copyBtn);
    banner.appendChild(ownLink);

    // List panel — rebuilt from live state every time it opens, so it
    // reflects the viewer's own edits and tick-offs.
    const panel = el('div', 'share-list-panel');
    panel.hidden = true;
    panel.setAttribute('aria-label', 'Shared list items');

    function rebuildPanel() {
      panel.textContent = '';
      const s = opts.getState();
      const doneSet = s.done instanceof Set ? s.done : new Set(s.done || []);
      (s.tasks || []).forEach(task => {
        const item = el('div', 'share-list-item' + (doneSet.has(task.id) ? ' done' : ''));
        item.appendChild(el('span', 'dot'));
        item.appendChild(el('span', 'item-text', task.text));
        panel.appendChild(item);
      });
      if (!s.tasks || s.tasks.length === 0) {
        panel.appendChild(el('div', 'share-list-item', 'No items.'));
      }
    }

    listBtn.addEventListener('click', () => {
      panel.hidden = !panel.hidden;
      if (!panel.hidden) rebuildPanel();
      listBtn.textContent = panel.hidden ? 'View list' : 'Hide list';
    });
    copyBtn.addEventListener('click', () => opts.onCopyToBoard && opts.onCopyToBoard());
    resetBtn.addEventListener('click', () => {
      if (confirm('Discard your changes and reload the owner’s version of this map?')) {
        opts.onReset && opts.onReset();
      }
    });

    document.body.appendChild(banner);
    document.body.appendChild(panel);
  }

  // "The owner updated this map" pill, shown when the published version is
  // newer than the one this sandbox copy was made from.
  function showUpdateNotice(opts) {
    // opts: { updatedAt, onLoadNewest }
    const notice = el('div', 'share-update-notice');
    notice.setAttribute('role', 'status');
    const when = opts.updatedAt ? ` ${timeAgo(opts.updatedAt)}` : '';
    notice.appendChild(el('span', null, `The owner updated this map${when}.`));
    const loadBtn = el('button', 'notice-load', 'Load newest');
    const dismissBtn = el('button', 'notice-dismiss', 'Keep my version');
    loadBtn.addEventListener('click', () => {
      if (confirm('Load the owner’s newest version? This replaces your changes to this copy.')) {
        opts.onLoadNewest && opts.onLoadNewest();
      }
    });
    dismissBtn.addEventListener('click', () => notice.remove());
    notice.appendChild(loadBtn);
    notice.appendChild(dismissBtn);
    document.body.appendChild(notice);
  }

  let loadingEl = null;
  function showLoading() {
    if (loadingEl) return;
    loadingEl = el('div', 'share-loading');
    loadingEl.appendChild(el('div', 'spinner'));
    loadingEl.appendChild(el('div', null, 'Loading shared map…'));
    document.body.appendChild(loadingEl);
  }
  function hideLoading() {
    if (loadingEl) { loadingEl.remove(); loadingEl = null; }
  }

  function renderShareError(opts) {
    const overlay = el('div', 'share-error-overlay');
    overlay.appendChild(el('h2', null, opts.title));
    if (opts.message) overlay.appendChild(el('p', null, opts.message));
    const link = el('a', null, 'Make your own to-do map →');
    link.href = location.pathname;
    overlay.appendChild(link);
    document.body.appendChild(overlay);
  }

  // ── Exports ─────────────────────────────────────────────────────────────────

  window.TodoMapShare = {
    configured,
    sharedMapId,
    fetchMap: api.fetchMap,
    // Raw RPCs for flows that manage their own records in the maps index —
    // the home screen's share action and its delete pipeline's revokes.
    publish: api.publish,
    update: api.update,
    remove: api.remove,
    adoptLegacyShares,
    initShareUI,
    renderSharedChrome,
    renderShareError,
    showUpdateNotice,
    showLoading,
    hideLoading,
  };
})();
