// ─────────────────────────────────────────────────────────────────────────────
// To-Do Map · sharing module
//
// Talks to the Supabase functions defined in supabase/schema.sql via plain
// fetch() RPC calls (no client library, no build step). Loaded by both the
// main map and the impact/effort variant BEFORE app.js; each app.js wires it
// up through TodoMapShare.initShareUI() and the shared-view boot path.
//
// localStorage 'todomap-shares' holds the owner keys for maps published from
// this browser: { [mapId]: { key, kind, publishedAt, updatedAt } }
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

  // ── Owner-key store ─────────────────────────────────────────────────────────

  function readOwnerStore() {
    try { return JSON.parse(localStorage.getItem(OWNER_STORE_KEY)) || {}; }
    catch (e) { return {}; }
  }
  function writeOwnerStore(store) {
    try { localStorage.setItem(OWNER_STORE_KEY, JSON.stringify(store)); }
    catch (e) { /* storage unavailable */ }
  }
  function getShareFor(kind) {
    const store = readOwnerStore();
    let best = null;
    Object.keys(store).forEach(id => {
      const rec = store[id];
      if (rec && rec.kind === kind && (!best || rec.publishedAt > best.publishedAt)) {
        best = Object.assign({ id }, rec);
      }
    });
    return best;
  }
  function saveShare(id, rec) {
    const store = readOwnerStore();
    store[id] = rec;
    writeOwnerStore(store);
  }
  function removeShare(id) {
    const store = readOwnerStore();
    delete store[id];
    writeOwnerStore(store);
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
    // opts: { kind, serialize } — serialize() returns the publishable JSON
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
    const existing = getShareFor(opts.kind);
    const data = opts.serialize();

    const backdrop = el('div', 'share-dialog-backdrop');
    const dialog = el('div', 'share-dialog');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-label', 'Share this map');
    backdrop.appendChild(dialog);

    const status = el('div', 'share-status');
    status.setAttribute('aria-live', 'polite');

    function close() {
      backdrop.remove();
      document.removeEventListener('keydown', onKey);
    }
    function onKey(e) { if (e.key === 'Escape') close(); }
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
        const rec = readOwnerStore()[id];
        if (!rec) return;
        const fresh = opts.serialize();
        updateBtn.disabled = true;
        setStatus('Updating…');
        try {
          const ok = await api.update(id, rec.key, fresh);
          if (ok) {
            rec.updatedAt = new Date().toISOString();
            saveShare(id, rec);
            setStatus('Updated — everyone with the link now sees this version.');
          } else {
            setStatus('This link no longer exists on the server. Publish a new one.', true);
            removeShare(id);
          }
        } catch (err) {
          setStatus(err.message, true);
        }
        updateBtn.disabled = false;
      });

      const stopBtn = el('button', 'share-btn-quiet share-btn-danger', 'Stop sharing');
      stopBtn.addEventListener('click', async () => {
        const rec = readOwnerStore()[id];
        if (!rec) return;
        stopBtn.disabled = true;
        setStatus('Removing…');
        try {
          await api.remove(id, rec.key);
          removeShare(id);
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
          saveShare(result.id, { key: result.owner_key, kind: opts.kind, publishedAt: now, updatedAt: now });
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
    // opts: { record: {data, map_kind, updated_at}, itemCount, onCopyToBoard }
    const banner = el('div', 'share-banner');
    banner.setAttribute('role', 'region');
    banner.setAttribute('aria-label', 'Shared map');

    banner.appendChild(el('span', 'share-banner-title', 'Shared to-do map'));
    const count = opts.itemCount;
    const metaBits = [`${count} item${count === 1 ? '' : 's'}`];
    if (opts.record.updated_at) metaBits.push(`updated ${timeAgo(opts.record.updated_at)}`);
    banner.appendChild(el('span', 'share-banner-meta', metaBits.join(' · ')));
    banner.appendChild(el('span', 'share-banner-spacer'));

    const listBtn = el('button', null, 'View list');
    const copyBtn = el('button', null, 'Copy to my board');
    const ownLink = el('a', null, 'Make your own →');
    ownLink.href = location.pathname;

    banner.appendChild(listBtn);
    banner.appendChild(copyBtn);
    banner.appendChild(ownLink);

    // List panel
    const panel = el('div', 'share-list-panel');
    panel.hidden = true;
    panel.setAttribute('aria-label', 'Shared list items');
    const data = opts.record.data || {};
    const doneSet = new Set(data.done || []);
    (data.tasks || []).forEach(task => {
      const item = el('div', 'share-list-item' + (doneSet.has(task.id) ? ' done' : ''));
      item.appendChild(el('span', 'dot'));
      item.appendChild(el('span', 'item-text', task.text));
      panel.appendChild(item);
    });

    listBtn.addEventListener('click', () => {
      panel.hidden = !panel.hidden;
      listBtn.textContent = panel.hidden ? 'View list' : 'Hide list';
    });
    copyBtn.addEventListener('click', () => opts.onCopyToBoard && opts.onCopyToBoard());

    document.body.appendChild(banner);
    document.body.appendChild(panel);
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
    initShareUI,
    renderSharedChrome,
    renderShareError,
  };
})();
