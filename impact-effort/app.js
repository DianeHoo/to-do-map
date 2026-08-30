// ──────────────────────────────────────────────────────────────────────────────
// State
// ──────────────────────────────────────────────────────────────────────────────

// Lower number = ranked higher (most). impact 1 = most impact (top of grid).
// effort 1 = most effort (right of grid).
const SAMPLE_TASKS = [
  { text: "Write the project proposal", impact: 1, effort: 2 },         // Big Bets (top-right)
  { text: "Plan next quarter's roadmap", impact: 3, effort: 1 },        // Big Bets
  { text: "Reply to an important client email", impact: 2, effort: 8 }, // Quick Wins (top-left)
  { text: "Book the dentist appointment", impact: 4, effort: 7 },       // Quick Wins
  { text: "Reorganize the file system", impact: 7, effort: 3 },         // Thankless (bottom-right)
  { text: "Reconcile old receipts by hand", impact: 8, effort: 4 },     // Thankless
  { text: "Tidy desktop icons", impact: 6, effort: 6 },                 // Fill-ins (bottom-left)
  { text: "Browse new desk chairs", impact: 5, effort: 5 },             // Center
];

let state = {
  tasks: [],
  impactOrder: [],
  effortOrder: [],
  phase: 'dump',     // 'dump' | 'sort-impact' | 'sort-effort' | 'scatter'
  cardPositions: {},
  scatterSig: null,  // rankingSignature() the current cardPositions were computed from
  done: new Set(),
  history: [],       // cleanup snapshots: [{ ts, checkedCount, items: [{id,text,x,y,done}] }]
  viewingIdx: null,  // null = live view, number = index into state.history
};

let idCounter = 0;
const makeId = () => `t${++idCounter}`;

// ──────────────────────────────────────────────────────────────────────────────
// Utility
// ──────────────────────────────────────────────────────────────────────────────

function prefersReducedMotion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function announce(msg) {
  const el = document.getElementById('aria-live');
  el.textContent = '';
  requestAnimationFrame(() => { el.textContent = msg; });
}

// Bottom-center notice pill (storage failures, cleanup undo, import errors) —
// the editors' quieter cousin of the home screen's toast.
let editorToastTimer = null;
function showEditorNotice(msg, opts) {
  opts = opts || {};
  const toast = document.getElementById('editor-toast');
  const msgEl = document.getElementById('editor-toast-msg');
  const actionEl = document.getElementById('editor-toast-action');
  if (!toast || !msgEl || !actionEl) return;
  clearTimeout(editorToastTimer);
  msgEl.textContent = msg;
  if (opts.actionLabel) {
    actionEl.textContent = opts.actionLabel;
    actionEl.hidden = false;
    actionEl.onclick = () => {
      toast.hidden = true;
      actionEl.onclick = null;
      if (opts.onAction) opts.onAction();
    };
  } else {
    actionEl.hidden = true;
    actionEl.onclick = null;
  }
  toast.hidden = false;
  editorToastTimer = setTimeout(() => { toast.hidden = true; }, opts.duration || 5000);
  announce(msg);
}

function escapeHtml(str) {
  const d = document.createElement('div');
  d.appendChild(document.createTextNode(str));
  return d.innerHTML;
}

// ──────────────────────────────────────────────────────────────────────────────
// Phase transitions — vertical flow
// ──────────────────────────────────────────────────────────────────────────────

const PHASE_ORDER = ['dump', 'sort-impact', 'sort-effort', 'scatter'];
const PHASE_IDS = {
  'dump': 'phase-dump',
  'sort-impact': 'phase-sort-impact',
  'sort-effort': 'phase-sort-effort',
  'scatter': 'phase-scatter',
};

function showPhase(targetPhase) {
  const targetIdx = PHASE_ORDER.indexOf(targetPhase);

  // Restore transitions on ALL phases before switching
  // (rubber-band pull sets transition:none on active phase)
  document.querySelectorAll('.phase').forEach(el => {
    el.style.transition = '';
    el.style.transform = '';
  });

  // Force a reflow so the transition restoration takes effect
  // before we change classes
  document.body.offsetHeight;

  PHASE_ORDER.forEach((phase, idx) => {
    const el = document.getElementById(PHASE_IDS[phase]);
    el.classList.remove('phase-pending', 'phase-active', 'phase-completed');

    // Hidden phases are only faded out visually — inert removes their whole
    // subtree from the tab order and assistive tech (aria-hidden alone still
    // left every control tabbable).
    if (idx < targetIdx) {
      el.classList.add('phase-completed'); // slides up and out
      el.setAttribute('aria-hidden', 'true');
      el.inert = true;
    } else if (idx === targetIdx) {
      el.classList.add('phase-active'); // slides into view
      el.scrollTop = 0;
      el.removeAttribute('aria-hidden');
      el.inert = false;
    } else {
      el.classList.add('phase-pending'); // stays below
      el.setAttribute('aria-hidden', 'true');
      el.inert = true;
    }
  });

  state.phase = targetPhase;

  const toolbar = document.getElementById('canvas-toolbar');
  if (toolbar) toolbar.classList.toggle('visible', targetPhase === 'scatter');
  const utilWrap = document.getElementById('canvas-util-wrap');
  if (utilWrap) utilWrap.classList.toggle('visible', targetPhase === 'scatter');

  // Focus follows the transition — otherwise it stays stranded on a control
  // inside the phase that just went inert.
  const activeEl = document.getElementById(PHASE_IDS[targetPhase]);
  if (activeEl && !activeEl.contains(document.activeElement)) {
    activeEl.setAttribute('tabindex', '-1');
    activeEl.focus({ preventScroll: true });
  }

  syncTipRotation();
}

// ──────────────────────────────────────────────────────────────────────────────
// Phase 1: DUMP
// ──────────────────────────────────────────────────────────────────────────────

function initDump() {
  const input = document.getElementById('dump-input');
  const btnSort = document.getElementById('btn-ready-sort');
  const btnSuggest = document.getElementById('btn-suggest-tasks');

  renderDumpCards();
  updateSortButton();
  updateDumpOverflow();
  // Fix 1: toggle has-tasks on dump phase for intro fade
  document.getElementById('phase-dump').classList.toggle('has-tasks', state.tasks.length > 0);

  // Toggle .has-value — hide typewriter when input has text OR tasks exist
  // Toggle .has-input-text — show "Dump Tasks ↵" hint only when characters typed
  input.addEventListener('input', () => {
    input.parentElement.classList.toggle('has-value', input.value.length > 0 || state.tasks.length > 0);
    input.parentElement.classList.toggle('has-input-text', input.value.length > 0);
  });

  // Typewriter: hide on focus, restart on blur if empty
  input.addEventListener('focus', () => {
    stopTypewriter();
  });
  input.addEventListener('blur', () => {
    if (!input.value && state.tasks.length === 0) {
      startTypewriter();
    }
  });

  // Initialize typewriter animation
  initTypewriter();

  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      const text = input.value.trim();
      if (text) {
        addTask(text, true);
        input.value = '';
        input.parentElement.classList.remove('has-input-text');
        updateSortButton();
        saveState();
      }
      e.preventDefault();
    }
  });

  // Phase 4.3: "suggest tasks" button
  if (btnSuggest) {
    btnSuggest.addEventListener('click', () => {
      const sampleIds = [];
      SAMPLE_TASKS.forEach(sample => {
        const task = { id: makeId(), text: sample.text };
        state.tasks.unshift(task);
        sampleIds.push({ id: task.id, text: sample.text, impact: sample.impact, effort: sample.effort });
      });
      // Set impactOrder: sort by impact value ascending (most impactful first = lowest number)
      state.impactOrder = [...state.tasks].sort((a, b) => {
        const sa = SAMPLE_TASKS.find(s => s.text === a.text);
        const sb = SAMPLE_TASKS.find(s => s.text === b.text);
        return (sa?.impact || 99) - (sb?.impact || 99);
      }).map(t => t.id);
      // Set effortOrder: sort by effort value ascending (most effortful first = lowest number)
      state.effortOrder = [...state.tasks].sort((a, b) => {
        const sa = SAMPLE_TASKS.find(s => s.text === a.text);
        const sb = SAMPLE_TASKS.find(s => s.text === b.text);
        return (sa?.effort || 99) - (sb?.effort || 99);
      }).map(t => t.id);
      renderDumpCards();
      updateSortButton();
      // Add has-tasks class for dump intro fade
      document.getElementById('phase-dump').classList.add('has-tasks');
      btnSuggest.style.opacity = '0';
      btnSuggest.style.pointerEvents = 'none';
      saveState();
      announce(`${SAMPLE_TASKS.length} sample tasks added. Drag to reorder or add your own.`);
    });
  }

  btnSort.addEventListener('click', () => {
    if (state.tasks.length === 0) return;
    transitionToSortImpact();
  });
  btnSort.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (state.tasks.length > 0) transitionToSortImpact();
    }
  });

}

function addTask(text, animate) {
  const task = { id: makeId(), text };
  state.tasks.unshift(task);
  stopTypewriter();
  document.getElementById('phase-dump').classList.add('has-tasks');
  document.querySelector('.dump-input-wrap')?.classList.add('has-value');
  if (!animate) return;
  const cardsEl = document.getElementById('dump-cards');
  const card = createDumpCard(task);
  cardsEl.prepend(card);
  // Hide suggest button once user starts typing
  const suggestBtn = document.getElementById('btn-suggest-tasks');
  if (suggestBtn && state.tasks.length > 0) {
    suggestBtn.style.opacity = '0';
    suggestBtn.style.pointerEvents = 'none';
    suggestBtn.style.visibility = 'hidden'; // out of the tab order, not just invisible
  }
  card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  updateDumpOverflow();
}

function createDumpCard(task) {
  const card = document.createElement('div');
  card.className = 'dump-card';
  card.setAttribute('role', 'listitem');
  card.dataset.id = task.id;
  card.innerHTML = `<span class="card-text-dump">${escapeHtml(task.text)}</span>`;
  const delBtn = document.createElement('button');
  delBtn.className = 'dump-delete';
  delBtn.setAttribute('aria-label', `Remove ${task.text}`);
  delBtn.textContent = '\u00d7';
  delBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    deleteDumpTask(task.id);
  });
  card.appendChild(delBtn);
  return card;
}

function deleteDumpTask(id) {
  state.tasks = state.tasks.filter(t => t.id !== id);
  // The task must vanish from every structure, or "clean up" later counts
  // phantoms that aren't on the board and announces a cleanup that fades
  // zero cards.
  state.done.delete(id);
  delete state.cardPositions[id];
  state.impactOrder = state.impactOrder.filter(x => x !== id);
  state.effortOrder = state.effortOrder.filter(x => x !== id);
  const card = document.querySelector(`.dump-card[data-id="${id}"]`);
  if (card) {
    card.style.transition = 'opacity 150ms ease, transform 150ms ease';
    card.style.opacity = '0';
    card.style.transform = 'translateX(8px)';
    setTimeout(() => { card.remove(); updateDumpOverflow(); }, 160);
  }
  document.getElementById('phase-dump').classList.toggle('has-tasks', state.tasks.length > 0);
  // Toggle has-value on input wrap — hides typewriter when tasks exist
  const inputWrap = document.querySelector('.dump-input-wrap');
  if (inputWrap) inputWrap.classList.toggle('has-value', state.tasks.length > 0);
  // Remove from old/hidden tracking; hide toggle line when no old tasks remain
  oldTaskIds.delete(id);
  hiddenTaskIds.delete(id);
  if (oldTaskIds.size === 0) {
    document.getElementById('existing-tasks-line').style.display = 'none';
  }
  // Re-show suggest button and restart typewriter when all tasks deleted
  if (state.tasks.length === 0) {
    const suggestBtn = document.getElementById('btn-suggest-tasks');
    if (suggestBtn) { suggestBtn.style.opacity = ''; suggestBtn.style.pointerEvents = ''; suggestBtn.style.visibility = ''; }
    startTypewriter();
  }
  updateSortButton();
  saveState();
}

function renderDumpCards() {
  const cardsEl = document.getElementById('dump-cards');
  cardsEl.innerHTML = '';
  state.tasks.forEach(task => {
    const card = createDumpCard(task);
    cardsEl.appendChild(card);
  });
  updateSortButton();
  updateDumpOverflow();
  // Toggle suggest button and typewriter visibility
  const suggestBtn = document.getElementById('btn-suggest-tasks');
  const inputWrap = document.querySelector('.dump-input-wrap');
  if (state.tasks.length > 0) {
    if (suggestBtn) { suggestBtn.style.opacity = '0'; suggestBtn.style.pointerEvents = 'none'; suggestBtn.style.visibility = 'hidden'; }
    if (inputWrap) inputWrap.classList.add('has-value');
    stopTypewriter();
  } else {
    if (suggestBtn) { suggestBtn.style.opacity = ''; suggestBtn.style.pointerEvents = ''; suggestBtn.style.visibility = ''; }
    if (inputWrap) inputWrap.classList.remove('has-value');
  }
}

// Track old tasks (existed before returning to dump) vs new tasks (added this session)
let oldTaskIds = new Set();   // set once in showDumpFresh, never changes
let hiddenTaskIds = new Set(); // tracks which old tasks are currently hidden

function showDumpFresh() {
  // Called when returning to dump with existing tasks.
  // Hides existing cards, shows toggle link, typewriter keeps running.
  const cardsEl = document.getElementById('dump-cards');
  const line = document.getElementById('existing-tasks-line');

  if (state.tasks.length === 0) {
    line.style.display = 'none';
    oldTaskIds.clear();
    hiddenTaskIds.clear();
    return;
  }

  // Remember which tasks are "old" — this set is fixed for the session
  oldTaskIds = new Set(state.tasks.map(t => t.id));
  hiddenTaskIds = new Set(oldTaskIds);

  // Clear visible cards
  cardsEl.innerHTML = '';

  // Show toggle link, reset to "show" state
  line.textContent = 'show my tasks';
  line.style.display = 'block';

  // Update sort button to reflect total count
  updateSortButton();

  // Reset input to feel completely fresh — restart typewriter
  const inputWrap = document.querySelector('.dump-input-wrap');
  if (inputWrap) { inputWrap.classList.remove('has-value'); inputWrap.classList.remove('has-input-text'); }
  const suggestBtn = document.getElementById('btn-suggest-tasks');
  if (suggestBtn) { suggestBtn.style.opacity = '0'; suggestBtn.style.pointerEvents = 'none'; suggestBtn.style.visibility = 'hidden'; }
  document.getElementById('dump-input').value = '';
  startTypewriter();
}

function initExistingTasksLine() {
  const line = document.getElementById('existing-tasks-line');
  line.addEventListener('click', () => {
    const cardsEl = document.getElementById('dump-cards');
    if (hiddenTaskIds.size === 0) {
      // Currently showing old tasks — hide only the old ones, keep new ones
      hiddenTaskIds = new Set(oldTaskIds);
      cardsEl.querySelectorAll('.dump-card').forEach(card => {
        if (oldTaskIds.has(card.dataset.id)) card.remove();
      });
      line.textContent = 'show my tasks';
      updateDumpOverflow();
      // Restart typewriter if no new cards remain visible
      const input = document.getElementById('dump-input');
      if (!input.value && cardsEl.children.length === 0) {
        document.querySelector('.dump-input-wrap')?.classList.remove('has-value');
        startTypewriter();
      }
    } else {
      // Currently hidden — show all tasks (old + new)
      renderDumpCards();
      hiddenTaskIds.clear();
      line.textContent = 'hide my tasks';
    }
    updateSortButton();
  });
}

function updateSortButton() {
  const btn = document.getElementById('btn-ready-sort');
  const label = btn.querySelector('.nav-label');
  btn.classList.toggle('visible', state.tasks.length > 0);
  if (hiddenTaskIds.size > 0) {
    label.textContent = `sort all ${state.tasks.length} ${state.tasks.length === 1 ? 'task' : 'tasks'}`;
  } else {
    label.textContent = 'ready to sort';
  }
}

// Merge an existing ranking with the current task list: surviving tasks keep
// their ranked positions, deleted tasks drop out, and tasks that were never
// ranked surface at the top of the list so the user can slot them in.
function reconcileOrder(order) {
  const taskIds = new Set(state.tasks.map(t => t.id));
  const kept = order.filter(id => taskIds.has(id));
  const keptSet = new Set(kept);
  const unranked = state.tasks.filter(t => !keptSet.has(t.id)).map(t => t.id);
  return [...unranked, ...kept];
}

function transitionToSortImpact() {
  oldTaskIds.clear();
  hiddenTaskIds.clear();
  document.getElementById('existing-tasks-line').style.display = 'none';
  // Keep whatever ranking already exists — adding or deleting a task in the
  // dump must not throw away the rest of the ranking.
  state.impactOrder = reconcileOrder(state.impactOrder);
  state.effortOrder = state.effortOrder.length
    ? reconcileOrder(state.effortOrder)
    : [...state.impactOrder];
  renderSortList('impact');
  showPhase('sort-impact');
  saveState();
  announce('Sorting phase. Drag to rank by impact. Biggest payoff at the top.');
}

// ──────────────────────────────────────────────────────────────────────────────
// Phase 2: SORT — FLIP-based drag to reorder
// ──────────────────────────────────────────────────────────────────────────────

let dragState = null;
let canvasDragActive = false;

// Paste as plain text in the inline editors — pasted markup used to land in
// the contenteditable verbatim (running any embedded handlers at paste time)
// and then silently vanish on reload, since only textContent persists.
function attachPlainPaste(textEl) {
  if (textEl._pastePlain) return;
  textEl._pastePlain = true;
  textEl.addEventListener('paste', (ev) => {
    ev.preventDefault();
    const txt = ev.clipboardData ? ev.clipboardData.getData('text/plain') : '';
    document.execCommand('insertText', false, txt);
  });
}

function enterSortCardEdit(card, pass) {
  if (card.querySelector('.sort-edit-input')) return;
  const textEl = card.querySelector('.card-text');
  if (textEl.getAttribute('contenteditable') === 'true') return;
  const originalText = textEl.textContent;
  const taskId = card.dataset.id;

  textEl.setAttribute('contenteditable', 'true');
  textEl.style.outline = 'none';
  textEl.focus();
  attachPlainPaste(textEl);

  // Place cursor at end
  const range = document.createRange();
  range.selectNodeContents(textEl);
  range.collapse(false);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);

  function save() {
    textEl.setAttribute('contenteditable', 'false');
    const plainText = (textEl.textContent.trim() || originalText).slice(0, 500);
    if (plainText !== originalText) {
      const t = state.tasks.find(t => t.id === taskId);
      if (t) t.text = plainText;
      saveState();
    }
    textEl.textContent = plainText || originalText;
    resetIOSZoom();
    const order = pass === 'impact' ? state.impactOrder : state.effortOrder;
    const pos = order.indexOf(taskId);
    card.setAttribute('aria-label', `${plainText}, position ${pos + 1} of ${order.length}`);
  }

  function cancel() {
    textEl.setAttribute('contenteditable', 'false');
    textEl.textContent = originalText;
    resetIOSZoom();
  }

  textEl.addEventListener('keydown', function handler(ev) {
    if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); save(); textEl.removeEventListener('keydown', handler); }
    if (ev.key === 'Escape') { ev.preventDefault(); cancel(); textEl.removeEventListener('keydown', handler); }
    ev.stopPropagation();
  });

  textEl.addEventListener('blur', save, { once: true });
}

function renderSortList(pass) {
  const listId = pass === 'impact' ? 'sort-list-impact' : 'sort-list-effort';
  const listEl = document.getElementById(listId);
  const order = pass === 'impact' ? state.impactOrder : state.effortOrder;

  listEl.innerHTML = '';
  order.forEach((id, idx) => {
    const task = state.tasks.find(t => t.id === id);
    if (!task) return;

    const wrap = document.createElement('div');
    wrap.className = 'sort-card-wrap';

    const card = document.createElement('div');
    card.className = 'sort-card';
    card.setAttribute('draggable', 'false');
    card.dataset.id = id;
    card.setAttribute('role', 'listitem');
    card.setAttribute('aria-label', `${task.text}, position ${idx + 1} of ${order.length}`);
    card.tabIndex = 0;

    card.innerHTML = `
      <span class="rank" aria-hidden="true">${idx + 1}</span>
      <span class="card-text">${escapeHtml(task.text)}</span>
      <span class="handle" aria-hidden="true">\u2807</span>
    `;

    // ── Click to edit ──
    card.addEventListener('click', (e) => {
      if (card.querySelector('[contenteditable="true"]') || card.querySelector('.sort-edit-input')) return;
      if (card._suppressNextClick) { card._suppressNextClick = false; return; }
      enterSortCardEdit(card, pass);
    });

    // ── Drag to reorder ──
    // Mouse: anywhere on card initiates drag
    // Touch handle: instant drag  |  Touch card body: long-press to drag
    card.addEventListener('pointerdown', (e) => {
      if (card.querySelector('[contenteditable="true"]') || card.querySelector('.sort-edit-input')) return;
      if (e.pointerType === 'touch' && !e.target.closest('.handle')) return;
      if (e.button !== 0 && e.pointerType !== 'touch') return;
      onSortPointerDown(e, pass);
    });

    // Long-press entry via touchstart (immune to browser's pointercancel)
    card.addEventListener('touchstart', (e) => {
      if (card.querySelector('[contenteditable="true"]') || card.querySelector('.sort-edit-input')) return;
      if (e.target.closest('.handle')) return;
      const t = e.touches[0];
      if (t) startSortLongPress(t, card, pass);
    }, { passive: true });

    card.addEventListener('keydown', e => onSortKeyDown(e, id, pass));

    wrap.appendChild(card);
    listEl.appendChild(wrap);
  });
}

let pendingDrag = null;
const DRAG_MOVE_THRESHOLD = 4; // px before committing to drag

// ── Long-press to drag (touch, card body) ──
// Uses touch events (not pointer events) because the browser fires pointercancel
// on elements with touch-action:manipulation before our timer can complete.
const LONG_PRESS_DELAY = 400;
const LONG_PRESS_TOLERANCE = 5;
let sortLongPressCancel = null;

function startSortLongPress(e, card, pass) {
  if (sortLongPressCancel) sortLongPressCancel();

  const startX = e.clientX;
  const startY = e.clientY;
  let timer = null;

  const onMoveDuringWait = (ev) => {
    const t = ev.touches[0];
    if (!t) return;
    if (Math.abs(t.clientX - startX) > LONG_PRESS_TOLERANCE ||
        Math.abs(t.clientY - startY) > LONG_PRESS_TOLERANCE) {
      cancel();
    }
  };

  const cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    sortLongPressCancel = null;
    card.classList.remove('long-press-charging');
    document.removeEventListener('touchmove', onMoveDuringWait);
    document.removeEventListener('touchend', cancel);
    document.removeEventListener('touchcancel', cancel);
  };

  sortLongPressCancel = cancel;

  document.addEventListener('touchmove', onMoveDuringWait, { passive: true });
  document.addEventListener('touchend', cancel, { passive: true });
  document.addEventListener('touchcancel', cancel, { passive: true });

  card.classList.add('long-press-charging');

  timer = setTimeout(() => {
    cancel();
    if (navigator.vibrate) navigator.vibrate(30);

    // Start drag immediately (skip the 4px pending threshold)
    const cardRect = card.getBoundingClientRect();
    pendingDrag = {
      card, pass, startY,
      cardOffsetY: startY - cardRect.top,
      pointerId: null,
      committed: true,
    };
    commitDragStart(pendingDrag, null);

    // Track drag via touch events (pointer events are dead after browser's pointercancel)
    function onDragMove(ev) {
      ev.preventDefault(); // block scroll
      const t = ev.touches[0];
      if (t) onSortPointerMove({ clientY: t.clientY });
    }
    function onDragEnd() {
      document.removeEventListener('touchmove', onDragMove);
      document.removeEventListener('touchend', onDragEnd);
      document.removeEventListener('touchcancel', onDragEnd);
      onSortPointerUp({});
    }

    document.addEventListener('touchmove', onDragMove, { passive: false });
    document.addEventListener('touchend', onDragEnd, { passive: true });
    document.addEventListener('touchcancel', onDragEnd, { passive: true });
  }, LONG_PRESS_DELAY);
}

function onSortPointerDown(e, pass) {
  const card = e.currentTarget;

  pendingDrag = {
    card,
    pass,
    startY: e.clientY,
    cardOffsetY: e.clientY - card.getBoundingClientRect().top,
    pointerId: e.pointerId,
    committed: false,
  };

  document.addEventListener('pointermove', onSortPointerMovePending);
  document.addEventListener('pointerup', onSortPointerUpPending);
  document.addEventListener('pointercancel', onSortPointerUpPending);
}

function onSortPointerMovePending(e) {
  if (!pendingDrag) return;
  const dy = Math.abs(e.clientY - pendingDrag.startY);

  if (dy >= DRAG_MOVE_THRESHOLD && !pendingDrag.committed) {
    pendingDrag.committed = true;
    // Now actually start the drag
    commitDragStart(pendingDrag, e);
  }

  if (pendingDrag.committed) {
    onSortPointerMove(e);
  }
}

function onSortPointerUpPending(e) {
  if (pendingDrag && pendingDrag.committed) {
    onSortPointerUp(e);
  }
  pendingDrag = null;
  document.removeEventListener('pointermove', onSortPointerMovePending);
  document.removeEventListener('pointerup', onSortPointerUpPending);
  document.removeEventListener('pointercancel', onSortPointerUpPending);
}

function commitDragStart(pending, moveEvent) {
  const { card, pass, startY, cardOffsetY, pointerId } = pending;
  const listId = pass === 'impact' ? 'sort-list-impact' : 'sort-list-effort';
  const listEl = document.getElementById(listId);
  const cardRect = card.getBoundingClientRect();
  const allCards = Array.from(listEl.querySelectorAll('.sort-card'));
  const dragIdx = allCards.indexOf(card);

  // Capture initial rects for all cards (FLIP: First)
  const initialRects = new Map();
  allCards.forEach(c => {
    initialRects.set(c, c.getBoundingClientRect());
  });

  dragState = {
    card,
    pass,
    listId,
    pointerId,
    startY,
    cardOffsetY,
    originalIndex: dragIdx,
    currentIndex: dragIdx,
    initialRects,
    cardHeight: cardRect.height,
    gap: 6, // matches CSS gap
  };

  // Create a placeholder to hold the card's space in flow
  const placeholder = document.createElement('div');
  placeholder.style.height = cardRect.height + 'px';
  placeholder.style.flexShrink = '0';
  placeholder.className = 'sort-placeholder';
  // Insert placeholder at the list level (before the wrap container if present)
  const insertTarget = card.closest('.sort-card-wrap') || card;
  insertTarget.parentNode.insertBefore(placeholder, insertTarget);
  dragState.placeholder = placeholder;

  // Position card as dragging (fixed overlay)
  card.classList.add('dragging');
  card.style.position = 'fixed';
  card.style.width = cardRect.width + 'px';
  card.style.left = cardRect.left + 'px';
  card.style.top = cardRect.top + 'px';
  card.style.zIndex = '1000';
  card.style.pointerEvents = 'none';

  // Set transitions on wrap containers for smooth displacement
  const allWraps = Array.from(listEl.querySelectorAll('.sort-card-wrap'));
  const dragWrap = card.closest('.sort-card-wrap');
  allWraps.forEach(w => {
    if (w === dragWrap) return;
    w.style.transition = 'transform 200ms cubic-bezier(0.4, 0, 0.2, 1)';
  });
}

function onSortPointerMove(e) {
  if (!dragState) return;
  const { card, cardOffsetY, listId, originalIndex, cardHeight, gap } = dragState;
  const newTop = e.clientY - cardOffsetY;
  card.style.top = newTop + 'px';

  // Calculate which index the dragged card would occupy
  const listEl = document.getElementById(listId);
  const dragWrap = card.closest('.sort-card-wrap');
  const siblingWraps = Array.from(listEl.querySelectorAll('.sort-card-wrap')).filter(w => w !== dragWrap);
  let targetIndex = siblingWraps.length;

  for (let i = 0; i < siblingWraps.length; i++) {
    const rect = siblingWraps[i].getBoundingClientRect();
    const midpoint = rect.top + rect.height / 2;
    if (e.clientY < midpoint) {
      targetIndex = i;
      break;
    }
  }

  dragState.currentIndex = targetIndex >= originalIndex ? targetIndex + 1 : targetIndex;

  // Apply translateY to wrap containers (not inner cards — wraps are visible, cards would clip)
  siblingWraps.forEach((w, sibIdx) => {
    const fullIdx = sibIdx >= originalIndex ? sibIdx + 1 : sibIdx;
    let shift = 0;

    if (dragState.currentIndex <= originalIndex) {
      if (fullIdx >= dragState.currentIndex && fullIdx < originalIndex) {
        shift = cardHeight + gap;
      }
    } else {
      if (fullIdx > originalIndex && fullIdx < dragState.currentIndex) {
        shift = -(cardHeight + gap);
      }
    }

    w.style.transform = shift !== 0 ? `translateY(${shift}px)` : '';
  });
}

function onSortPointerUp(e) {
  if (!dragState) return;
  const { card, pass, listId, originalIndex, currentIndex } = dragState;

  // Remove placeholder
  if (dragState.placeholder && dragState.placeholder.parentNode) {
    dragState.placeholder.parentNode.removeChild(dragState.placeholder);
  }

  // Clean up dragged card styles
  card.classList.remove('dragging');
  card.style.position = '';
  card.style.width = '';
  card.style.left = '';
  card.style.top = '';
  card.style.zIndex = '';
  card.style.pointerEvents = '';

  const listEl = document.getElementById(listId);

  // Clear transforms on all wraps and cards
  const allWraps = Array.from(listEl.querySelectorAll('.sort-card-wrap'));
  allWraps.forEach(w => {
    w.style.transform = '';
    w.style.transition = '';
  });
  const allCards = Array.from(listEl.querySelectorAll('.sort-card'));
  allCards.forEach(c => {
    c.style.transform = '';
    c.style.transition = '';
  });

  // Perform DOM reorder
  const order = pass === 'impact' ? state.impactOrder : state.effortOrder;
  const finalIdx = Math.max(0, Math.min(order.length - 1, currentIndex > originalIndex ? currentIndex - 1 : currentIndex));

  if (finalIdx !== originalIndex) {
    const [moved] = order.splice(originalIndex, 1);
    order.splice(finalIdx, 0, moved);
    if (pass === 'impact') state.impactOrder = order;
    else state.effortOrder = order;
  }

  // Re-render with FLIP animation
  const oldRects = new Map();
  allCards.forEach(c => {
    oldRects.set(c.dataset.id, c.getBoundingClientRect());
  });

  renderSortList(pass);

  // FLIP: animate from old positions to new
  if (!prefersReducedMotion()) {
    const newCards = Array.from(listEl.querySelectorAll('.sort-card'));
    newCards.forEach(c => {
      const oldRect = oldRects.get(c.dataset.id);
      if (!oldRect) return;
      const newRect = c.getBoundingClientRect();
      const dx = oldRect.left - newRect.left;
      const dy = oldRect.top - newRect.top;
      if (Math.abs(dy) > 1 || Math.abs(dx) > 1) {
        c.style.transform = `translate(${dx}px, ${dy}px)`;
        c.offsetHeight; // force reflow
        c.style.transition = 'transform 200ms cubic-bezier(0.4, 0, 0.2, 1)';
        c.style.transform = '';
        c.addEventListener('transitionend', function cleanup() {
          c.style.transition = '';
          c.removeEventListener('transitionend', cleanup);
        });
      }
    });
  }

  dragState = null;
  saveState();
}

function onSortKeyDown(e, id, pass) {
  // Don't handle keys during inline editing
  if (e.target.getAttribute('contenteditable') === 'true' || e.target.classList.contains('sort-edit-input')) return;

  const order = pass === 'impact' ? state.impactOrder : state.effortOrder;
  const idx = order.indexOf(id);
  const listId = pass === 'impact' ? 'sort-list-impact' : 'sort-list-effort';

  if (e.key === 'ArrowUp' && idx > 0) {
    e.preventDefault();
    order.splice(idx, 1);
    order.splice(idx - 1, 0, id);
    if (pass === 'impact') state.impactOrder = order;
    else state.effortOrder = order;
    renderSortList(pass);
    const cards = document.querySelectorAll(`#${listId} .sort-card`);
    cards[idx - 1]?.focus();
    announce(`Moved to position ${idx}`);
    saveState();
  } else if (e.key === 'ArrowDown' && idx < order.length - 1) {
    e.preventDefault();
    order.splice(idx, 1);
    order.splice(idx + 1, 0, id);
    if (pass === 'impact') state.impactOrder = order;
    else state.effortOrder = order;
    renderSortList(pass);
    const cards = document.querySelectorAll(`#${listId} .sort-card`);
    cards[idx + 1]?.focus();
    announce(`Moved to position ${idx + 2}`);
    saveState();
  }
}


function initSort() {
  // Impact done
  const btnImpactDone = document.getElementById('btn-impact-done');
  btnImpactDone.addEventListener('click', () => { if (!isTransitioning) onImpactDone(); });
  btnImpactDone.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (!isTransitioning) onImpactDone(); }
  });

  // Effort done
  const btnEffortDone = document.getElementById('btn-effort-done');
  btnEffortDone.addEventListener('click', () => { if (!isTransitioning) onEffortDone(); });
  btnEffortDone.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (!isTransitioning) onEffortDone(); }
  });

}

function onImpactDone() {
  // Keep the existing effort ranking, merging in any task changes; only a
  // never-ranked board seeds from the impact order.
  state.effortOrder = state.effortOrder.length
    ? reconcileOrder(state.effortOrder)
    : [...state.impactOrder]; // carry over as starting order
  renderSortList('effort');
  showPhase('sort-effort');
  saveState();
  announce('Sorting effort. Drag to rank by effort. Hardest and most time-consuming at the top.');
}

function onEffortDone() {
  triggerScatter();
}

// ──────────────────────────────────────────────────────────────────────────────
// Phase 3: SCATTER — Position computation
// ──────────────────────────────────────────────────────────────────────────────

function rankingSignature() {
  return state.impactOrder.join('|') + '~' + state.effortOrder.join('|');
}

// Real card metrics for the scatter math. CSS caps cards at 200px wide
// (160 under 480px) with a 44px min height — the old hardcoded 140×36
// under-measured every card, so the separation pass packed them into
// overlaps. The edge padding scales down on narrow canvases: a fixed 64px
// left a 375px phone only 247px of usable width.
function canvasCardMetrics(canvasW) {
  return {
    cardW: canvasW <= 480 ? 160 : 200,
    cardH: 44,
    edgePad: Math.min(64, Math.max(20, Math.round(canvasW * 0.07))),
  };
}

function computeCanvasPositions(canvasW, canvasH) {
  const n = state.tasks.length;
  if (n === 0) return {};

  const EDGE_PAD = canvasCardMetrics(canvasW).edgePad;
  const MIN_GAP = 32;

  const usableW = canvasW - EDGE_PAD * 2;
  const usableH = canvasH - EDGE_PAD * 2;

  const positions = {};

  state.tasks.forEach(task => {
    const impactRank = state.impactOrder.indexOf(task.id);
    const effortRank = state.effortOrder.indexOf(task.id);

    // A task missing from an order (shared-view sandboxes empty the
    // rankings) belongs at the middle of that axis — a negative norm used
    // to clamp every unranked card onto the same edge point.
    const impactNorm = impactRank === -1 ? 0.5 : (n > 1 ? impactRank / (n - 1) : 0.5);
    const effortNorm = effortRank === -1 ? 0.5 : (n > 1 ? effortRank / (n - 1) : 0.5);

    // X axis = effort (rank 0 = most effort → right). Y axis = impact (rank 0 = most impact → top).
    const x = EDGE_PAD + (1 - effortNorm) * usableW;
    const y = EDGE_PAD + impactNorm * usableH;

    positions[task.id] = { x, y };
  });

  return forceNudge(positions, canvasW, canvasH, EDGE_PAD, MIN_GAP);
}

function forceNudge(positions, canvasW, canvasH, edgePad, minGap) {
  const { cardW: CARD_W, cardH: CARD_H } = canvasCardMetrics(canvasW);
  const ITERATIONS = 40;

  const ids = Object.keys(positions);
  const pos = { ...positions };

  for (let iter = 0; iter < ITERATIONS; iter++) {
    let anyMoved = false;
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = pos[ids[i]];
        const b = pos[ids[j]];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const overlapX = CARD_W + minGap - Math.abs(dx);
        const overlapY = CARD_H + minGap - Math.abs(dy);
        if (overlapX > 0 && overlapY > 0) {
          const pushX = overlapX / 2;
          const pushY = overlapY / 2;
          if (pushX < pushY) {
            const dir = dx < 0 ? -1 : 1;
            a.x -= dir * pushX * 0.5;
            b.x += dir * pushX * 0.5;
          } else {
            const dir = dy < 0 ? -1 : 1;
            a.y -= dir * pushY * 0.5;
            b.y += dir * pushY * 0.5;
          }
          anyMoved = true;
        }
      }
      pos[ids[i]].x = Math.max(edgePad, Math.min(canvasW - CARD_W - edgePad, pos[ids[i]].x));
      pos[ids[i]].y = Math.max(edgePad, Math.min(canvasH - CARD_H - edgePad, pos[ids[i]].y));
    }
    if (!(iter % 10) && !anyMoved) break;
  }

  return pos;
}

// A card's real height can exceed the nominal single-line metric that
// canvasCardMetrics()/forceNudge() budget for once its text wraps onto
// multiple lines — nothing above measures actual rendered size. Called
// after a card is in the DOM, this re-measures it and nudges it back
// inside the canvas so long text never renders with its bottom (or an
// edge) clipped by .scatter-canvas's overflow:hidden.
function clampCardWithinCanvas(card, taskId) {
  const canvas = document.getElementById('scatter-canvas');
  if (!canvas) return;
  const canvasRect = canvas.getBoundingClientRect();
  if (canvasRect.width <= 0 || canvasRect.height <= 0) return;
  const cardRect = card.getBoundingClientRect();
  const { edgePad } = canvasCardMetrics(canvasRect.width);
  const x = parseFloat(card.style.left) || 0;
  const y = parseFloat(card.style.top) || 0;
  const maxX = canvasRect.width - cardRect.width - edgePad;
  const maxY = canvasRect.height - cardRect.height - edgePad;
  const clampedX = Math.max(edgePad, Math.min(maxX, x));
  const clampedY = Math.max(edgePad, Math.min(maxY, y));
  if (clampedX !== x || clampedY !== y) {
    card.style.left = clampedX + 'px';
    card.style.top = clampedY + 'px';
    if (state.cardPositions[taskId]) {
      state.cardPositions[taskId] = { x: clampedX, y: clampedY };
    }
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Scatter animation
// ──────────────────────────────────────────────────────────────────────────────

function triggerScatter() {
  // Capture sort card positions before transition
  const sortCards = document.querySelectorAll('#sort-list-effort .sort-card');
  const sortRects = {};
  sortCards.forEach(card => {
    sortRects[card.dataset.id] = card.getBoundingClientRect();
  });

  const rm = prefersReducedMotion();

  // Show scatter phase
  showPhase('scatter');

  // Wait for layout
  requestAnimationFrame(() => {
    const canvas = document.getElementById('scatter-canvas');
    const canvasRect = canvas.getBoundingClientRect();
    const canvasH = canvasRect.height;
    const canvasW = canvasRect.width;

    // Re-entering the map with unchanged rankings must not reshuffle the
    // user's arrangement — only (re)compute when the rankings changed or a
    // task has no position yet.
    const sig = rankingSignature();
    const missingPos = state.tasks.some(t => !state.cardPositions[t.id]);
    if (missingPos || sig !== state.scatterSig) {
      state.cardPositions = computeCanvasPositions(canvasW, canvasH);
      state.scatterSig = sig;
    }
    buildCanvasCards(rm);

    saveState();

    requestAnimationFrame(() => {
      drawQuadrantLines(rm);

      setTimeout(() => {
        animateCardsFlying(sortRects, rm);
        setTimeout(() => {
          announce('Tasks placed on the grid. Click any task to mark it done.');
        }, rm ? 200 : 1400);
      }, rm ? 0 : 300);
    });
  });
}

function buildCanvasCards(rm) {
  const canvas = document.getElementById('scatter-canvas');
  canvas.querySelectorAll('.canvas-card').forEach(c => c.remove());

  state.tasks.forEach(task => {
    const pos = state.cardPositions[task.id];
    if (!pos) return;

    const card = document.createElement('div');
    card.className = 'canvas-card' + (state.done.has(task.id) ? ' done' : '');
    card.dataset.id = task.id;
    card.tabIndex = 0;
    card.setAttribute('role', 'button');
    card.setAttribute('aria-pressed', state.done.has(task.id) ? 'true' : 'false');
    card.setAttribute('aria-label', `${task.text}${state.done.has(task.id) ? ', done' : ''} — click to toggle done`);
    card.style.left = pos.x + 'px';
    card.style.top = pos.y + 'px';
    card.style.opacity = '0';

    // Phase 1.3: SVG with viewBox, width/height attributes
    card.innerHTML = `
      <span class="card-text">${escapeHtml(task.text)}</span>
      <span class="canvas-handle" aria-hidden="true">\u2807</span>
      <div class="card-strike" aria-hidden="true">
        <svg width="100%" height="100%" preserveAspectRatio="none" overflow="visible"><path class="strike-path" d=""/></svg>
      </div>
    `;

    // Phase 1.3: double-rAF for strike path
    requestAnimationFrame(() => requestAnimationFrame(() => updateStrikePath(card)));

    setupLongPressDrag(card, task.id);
    setupSwipeStrike(card, task.id);

    card.addEventListener('pointerdown', () => {
      document.querySelectorAll('.canvas-card').forEach(c => { c.style.zIndex = '1'; });
      card.style.zIndex = '10';
    });
    card.addEventListener('focus', () => {
      document.querySelectorAll('.canvas-card').forEach(c => { c.style.zIndex = '1'; });
      card.style.zIndex = '10';
    });

    let clickTimer = null;
    card.addEventListener('click', (e) => {
      if (card._suppressNextClick) { card._suppressNextClick = false; return; }
      if (card._isEditing) return;
      if (card.querySelector('input') || card.querySelector('[contenteditable="true"]')) return;
      clearTimeout(clickTimer);
      clickTimer = setTimeout(() => {
        if (card._isEditing) return;
        onCanvasCardTap(card, task.id);
      }, 300);
    });

    card.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      clearTimeout(clickTimer);
      card._suppressNextClick = true;
      setTimeout(() => { card._suppressNextClick = false; }, 300);
      if (card.classList.contains('done')) return; // done: dblclick does nothing
      const textEl = card.querySelector('.card-text');
      if (textEl.getAttribute('contenteditable') === 'true') return;
      const originalText = textEl.textContent;
      const taskId = card.dataset.id;

      card._isEditing = true;
      textEl.setAttribute('contenteditable', 'true');
      textEl.style.outline = 'none';
      textEl.focus();
      attachPlainPaste(textEl);
      scrollCardIntoKeyboardView(card);

      // Place cursor at end
      const range = document.createRange();
      range.selectNodeContents(textEl);
      range.collapse(false);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);

      function endEdit() {
        setTimeout(() => { card._isEditing = false; }, 350);
        restoreCardPosition(card, taskId);
        resetIOSZoom();
      }

      function save() {
        textEl.setAttribute('contenteditable', 'false');
        card._suppressNextClick = true;
        setTimeout(() => { card._suppressNextClick = false; }, 400);
        const plainText = (textEl.textContent.trim() || originalText).slice(0, 500);
        if (plainText !== originalText) {
          const t = state.tasks.find(t => t.id === taskId);
          if (t) t.text = plainText;
        }
        // Write back what persistence keeps: plain text. The old innerHTML
        // round-trip kept pasted markup alive on screen until reload.
        textEl.textContent = plainText;
        card.setAttribute('aria-label', `${plainText} — click to toggle done`);
        requestAnimationFrame(() => requestAnimationFrame(() => updateStrikePath(card)));
        clampCardWithinCanvas(card, taskId);
        saveState();
        endEdit();
      }

      function cancel() {
        textEl.setAttribute('contenteditable', 'false');
        card._suppressNextClick = true;
        setTimeout(() => { card._suppressNextClick = false; }, 400);
        textEl.textContent = originalText;
        endEdit();
      }

      textEl.addEventListener('keydown', function handler(ev) {
        if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); save(); textEl.removeEventListener('keydown', handler); }
        if (ev.key === 'Escape') { ev.preventDefault(); cancel(); textEl.removeEventListener('keydown', handler); }
        ev.stopPropagation();
      });

      textEl.addEventListener('blur', save, { once: true });
    });

    // Double-tap fallback for mobile
    let lastTapTime = 0;
    card.addEventListener('pointerup', (e) => {
      if (card._suppressNextClick) return;
      if (card._isEditing) return;
      if (card.querySelector('[contenteditable="true"]') || card.querySelector('.sort-edit-input')) return;
      const now = Date.now();
      if (now - lastTapTime < 250) {
        card.dispatchEvent(new Event('dblclick', { bubbles: true }));
        lastTapTime = 0;
      } else {
        lastTapTime = now;
      }
    });

    card.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onCanvasCardTap(card, task.id);
      }
      if (['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(e.key)) {
        e.preventDefault();
        const STEP = 20;
        const canvasRect = canvas.getBoundingClientRect();
        const EDGE = 24;
        const oldX = parseFloat(card.style.left) || 0;
        const oldY = parseFloat(card.style.top) || 0;
        let x = oldX;
        let y = oldY;
        if (e.key === 'ArrowLeft')  x = Math.max(EDGE, x - STEP);
        if (e.key === 'ArrowRight') x = Math.min(canvasRect.width - card.offsetWidth - EDGE, x + STEP);
        if (e.key === 'ArrowUp')    y = Math.max(EDGE, y - STEP);
        if (e.key === 'ArrowDown')  y = Math.min(canvasRect.height - card.offsetHeight - EDGE, y + STEP);
        if (x === oldX && y === oldY) {
          announce(`${getTaskText(task.id)} at edge`);
          return;
        }
        card.style.left = x + 'px';
        card.style.top  = y + 'px';
        state.cardPositions[task.id] = { x, y };
        saveState();
        announce(`${task.text} moved to ${Math.round(x)}, ${Math.round(y)}`);
      }
    });

    canvas.appendChild(card);
    clampCardWithinCanvas(card, task.id);
  });
}

function drawQuadrantLines(rm) {
  const lines = document.querySelectorAll('.q-line');
  const canvas = document.getElementById('scatter-canvas');
  const h = canvas.clientHeight;
  const w = canvas.clientWidth;

  const halfH = h / 2;
  const halfW = w / 2;

  // Phase 1.2: Set dasharray, then set dashoffset via inline style
  document.getElementById('vline-up').style.strokeDasharray = halfH;
  document.getElementById('vline-up').style.strokeDashoffset = halfH;
  document.getElementById('vline-down').style.strokeDasharray = halfH;
  document.getElementById('vline-down').style.strokeDashoffset = halfH;
  document.getElementById('hline-left').style.strokeDasharray = halfW;
  document.getElementById('hline-left').style.strokeDashoffset = halfW;
  document.getElementById('hline-right').style.strokeDasharray = halfW;
  document.getElementById('hline-right').style.strokeDashoffset = halfW;

  requestAnimationFrame(() => {
    // Phase 1.2: Clear inline strokeDashoffset before adding .drawn class
    // so the CSS class value (0) takes effect via transition
    lines.forEach(line => {
      line.style.strokeDashoffset = '';
      line.classList.add('drawn');
    });
  });
}

function animateCardsFlying(sortRects, rm) {
  const canvas = document.getElementById('scatter-canvas');
  const canvasRect = canvas.getBoundingClientRect();
  const cards = canvas.querySelectorAll('.canvas-card');

  if (rm) {
    cards.forEach((card) => {
      card.style.opacity = '1';
    });
    return;
  }

  cards.forEach((card, i) => {
    const id = card.dataset.id;
    const targetPos = state.cardPositions[id];
    if (!targetPos) return;

    const srcRect = sortRects[id];

    card.style.left = targetPos.x + 'px';
    card.style.top = targetPos.y + 'px';

    let fromX = 0, fromY = 0;
    if (srcRect) {
      fromX = (srcRect.left - canvasRect.left) - targetPos.x;
      fromY = (srcRect.top - canvasRect.top) - targetPos.y;
    } else {
      fromX = 0;
      fromY = canvasRect.height * 0.15;
    }

    const midX = fromX * 0.65;
    const midY = fromY * 0.65 - 12;

    card.animate([
      { transform: `translate(${fromX}px, ${fromY}px)`, opacity: 0.85 },
      { transform: `translate(${midX}px, ${midY}px)`,   opacity: 0.9  },
      { transform: `translate(0px, 0px)`,                opacity: 1    }
    ], {
      duration: 420,
      easing: 'cubic-bezier(0.25, 0.1, 0.15, 1.0)',
      fill: 'both',
      delay: i * 30
    });
  });
}

// ──────────────────────────────────────────────────────────────────────────────
// Canvas card interactions
// ──────────────────────────────────────────────────────────────────────────────

// Temporarily reposition a canvas card into view when keyboard is open (mobile)
function scrollCardIntoKeyboardView(card) {
  if (!window.visualViewport) return;
  const vvH = window.visualViewport.height;
  const fullH = window.innerHeight;
  if (vvH >= fullH * 0.85) return; // keyboard not open
  const cardTop = parseFloat(card.style.top) || 0;
  const safeMax = vvH - 60; // keep card above keyboard with margin
  if (cardTop > safeMax) {
    card._savedTop = cardTop;
    card.style.transition = 'top 200ms ease';
    card.style.top = Math.max(40, safeMax) + 'px';
    setTimeout(() => { card.style.transition = ''; }, 220);
  }
}

function restoreCardPosition(card, taskId) {
  if (card._savedTop !== undefined) {
    const rm = prefersReducedMotion();
    card.style.transition = rm ? 'none' : 'top 200ms ease';
    card.style.top = card._savedTop + 'px';
    state.cardPositions[taskId] = { x: parseFloat(card.style.left), y: card._savedTop };
    delete card._savedTop;
    setTimeout(() => { card.style.transition = ''; }, 220);
  }
}

function resetIOSZoom() {
  // Viewport meta tag manipulation no longer works on iOS 10+.
  // Auto-zoom is prevented by using font-size >= 16px on editable elements.
}

function onCanvasCardTap(card, id) {
  const isDone = state.done.has(id);
  const text = getTaskText(id);
  const strikePath = card.querySelector('.strike-path');
  if (isDone) {
    state.done.delete(id);
    card.classList.remove('done');
    card.setAttribute('aria-pressed', 'false');
    card.setAttribute('aria-label', `${text} — click to toggle done`);
    if (strikePath) {
      const len = parseFloat(strikePath.style.strokeDasharray) || strikePath.getTotalLength?.() || 100;
      strikePath.style.strokeDashoffset = len + '';
    }
    announce(`${text} — unmarked`);
  } else {
    state.done.add(id);
    card.classList.add('done');
    card.setAttribute('aria-pressed', 'true');
    card.setAttribute('aria-label', `${text}, done — click to toggle done`);
    // Set inline strokeDashoffset to 0 (visible)
    if (strikePath) {
      strikePath.style.strokeDashoffset = '0';
    }
    announce(`${text} — done`);
  }
  saveState();
  collapseInteractionHints();
}

// Swipe-to-strike removed — tap toggles strikethrough, hold to drag, double-tap to edit
function setupSwipeStrike(card, id) {}

function getTaskText(id) {
  return state.tasks.find(t => t.id === id)?.text || '';
}

// Fix 3: Horizontal strikethrough with 6 variations
function generateStrikePath(w, h) {
  const midY = h / 2;
  // Uneven horizontal jagged line — slight random wobble, spans full width
  const points = 7;
  const segW = (w + 4) / (points - 1);
  let d = `M -2 ${midY + (Math.random() - 0.5) * 2.5}`;
  for (let i = 1; i < points; i++) {
    const x = -2 + segW * i;
    const wobble = (Math.random() - 0.5) * 3;
    d += ` L ${x} ${midY + wobble}`;
  }
  return d;
}

function updateStrikePath(card) {
  const strike = card.querySelector('.card-strike');
  if (!strike) return;
  const svg = strike.querySelector('svg');
  const path = strike.querySelector('.strike-path');
  if (!svg || !path) return;

  const w = strike.offsetWidth;
  const h = strike.offsetHeight;

  // If dimensions are 0, the card hasn't laid out yet — retry, but stop
  // once the card leaves the DOM (cleanup removes cards mid-retry) and
  // give up after ~2s rather than polling forever.
  if (!w || w < 2 || !h || h < 2) {
    const tries = (parseInt(card.dataset.strikeTries, 10) || 0) + 1;
    if (!card.isConnected || tries > 20) { delete card.dataset.strikeTries; return; }
    card.dataset.strikeTries = tries;
    setTimeout(() => updateStrikePath(card), 100);
    return;
  }
  delete card.dataset.strikeTries;

  // Set viewBox for proper scaling
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);

  const prevW = parseFloat(card.dataset.strikeW) || 0;
  const prevH = parseFloat(card.dataset.strikeH) || 0;
  const prevD = card.dataset.strikeD || '';

  let d;
  // Reuse existing path if dimensions haven't changed much
  if (prevD && Math.abs(w - prevW) < 5 && Math.abs(h - prevH) < 5) {
    d = prevD;
  } else {
    d = generateStrikePath(w, h);
    card.dataset.strikeW = w;
    card.dataset.strikeH = h;
    card.dataset.strikeD = d;
  }
  path.setAttribute('d', d);
  path.style.strokeWidth = '1.5';

  // Floor for path length — add extra to prevent residue dot at start
  const len = Math.max(path.getTotalLength?.() || w * 1.2, 10) + 2;
  path.style.strokeDasharray = len + '';
  path.style.strokeDashoffset = card.classList.contains('done') ? '0' : len + '';
}

// ──────────────────────────────────────────────────────────────────────────────
// Add task on canvas
// ──────────────────────────────────────────────────────────────────────────────

function initCanvasAdd() {
  const addBtn = document.getElementById('canvas-add-btn');
  const addWrap = document.getElementById('canvas-add-input-wrap');
  const addInput = document.getElementById('canvas-add-input');
  if (!addBtn || !addWrap || !addInput) return;

  addBtn.addEventListener('click', () => {
    const isOpen = addWrap.classList.contains('visible');
    if (isOpen) {
      addWrap.classList.remove('visible');
    } else {
      addWrap.classList.add('visible');
      addInput.focus();
    }
  });

  addInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const text = addInput.value.trim();
      if (text) {
        addTaskToCanvas(text);
        addInput.value = '';
        addWrap.classList.remove('visible');
      }
      e.preventDefault();
    }
    if (e.key === 'Escape') {
      addWrap.classList.remove('visible');
      addBtn.focus();
    }
  });

  // Close on blur and reset iOS zoom
  addInput.addEventListener('blur', () => {
    setTimeout(() => {
      addWrap.classList.remove('visible');
    }, 150);
    resetIOSZoom();
  });

  document.addEventListener('click', (e) => {
    if (addWrap.classList.contains('visible') &&
        !addWrap.contains(e.target) && !addBtn.contains(e.target)) {
      addWrap.classList.remove('visible');
    }
  });
}

// Keep absolute-pixel card positions inside a canvas that changed size —
// rotation, a window resize, or restoring on a different screen. Positions
// rescale proportionally (their quadrant meaning survives; clamp-only would
// pile everything on the edges) and persist with the new canvas dims.
function reflowCanvasPositions() {
  const canvas = document.getElementById('scatter-canvas');
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return;
  const from = lastCanvasDims;
  if (from && Math.abs(from.w - rect.width) <= 1 && Math.abs(from.h - rect.height) <= 1) return;
  // History snapshots hold old-canvas coordinates — leave the viewer first.
  if (state.viewingIdx !== null) returnToNow();
  const source = (from && from.w > 0 && from.h > 0) ? from : { w: rect.width, h: rect.height };
  state.cardPositions = scaleSharedPositions(state.cardPositions, source, rect.width, rect.height);
  const { edgePad } = canvasCardMetrics(rect.width);
  canvas.querySelectorAll('.canvas-card:not(.ghost-card)').forEach(card => {
    const p = state.cardPositions[card.dataset.id];
    if (!p) return;
    card.style.left = p.x + 'px';
    card.style.top = p.y + 'px';
    // scaleSharedPositions clamps against the *nominal* single-line card
    // height; long text wrapped onto extra lines can still render taller
    // than that, pushing the real bottom edge past the canvas (clipped by
    // its overflow:hidden). Pull it back up now that the real height — text
    // wrap included — is measurable.
    const cardBottom = card.getBoundingClientRect().height + p.y;
    const overflow = cardBottom - (rect.height - edgePad);
    if (overflow > 0) {
      p.y = Math.max(edgePad, p.y - overflow);
      card.style.top = p.y + 'px';
    }
    updateStrikePath(card);
  });
  drawQuadrantLines(true);
  saveState(); // re-measures and persists the new canvas dims
}

// First free spot for a new card: the canvas center, then rings around it.
// Every card used to land on the exact same center coordinate — add three
// tasks, see one.
function findFreeCanvasSpot(canvasW, canvasH) {
  const { cardW, cardH, edgePad } = canvasCardMetrics(canvasW);
  const cx = canvasW / 2 - cardW / 2;
  const cy = canvasH / 2 - cardH / 2;
  const clampX = (v) => Math.max(edgePad, Math.min(canvasW - cardW - edgePad, v));
  const clampY = (v) => Math.max(edgePad, Math.min(canvasH - cardH - edgePad, v));
  const taken = Object.values(state.cardPositions);
  const isFree = (x, y) =>
    taken.every(p => Math.abs(p.x - x) >= cardW * 0.7 || Math.abs(p.y - y) >= cardH * 1.4);
  if (isFree(cx, cy)) return { x: clampX(cx), y: clampY(cy) };
  for (const r of [56, 112, 168]) {
    for (let k = 0; k < 8; k++) {
      const a = (Math.PI / 4) * k;
      const x = clampX(cx + Math.round(Math.cos(a) * r * 1.6));
      const y = clampY(cy + Math.round(Math.sin(a) * r));
      if (isFree(x, y)) return { x, y };
    }
  }
  // Everywhere near the middle is taken — nudge off-center so at least
  // this one card isn't stacked exactly on another.
  return { x: clampX(cx + 24), y: clampY(cy + 24) };
}

function addTaskToCanvas(text) {
  const task = { id: makeId(), text };
  state.tasks.push(task);

  const canvas = document.getElementById('scatter-canvas');
  const canvasRect = canvas.getBoundingClientRect();
  const { x, y } = findFreeCanvasSpot(canvasRect.width, canvasRect.height);
  state.cardPositions[task.id] = { x, y };

  state.impactOrder.push(task.id);
  state.effortOrder.push(task.id);
  // The new card was placed directly on the canvas — its position is in sync
  // with the orders, so re-entering the map must not trigger a re-scatter.
  state.scatterSig = rankingSignature();

  const card = document.createElement('div');
  card.className = 'canvas-card';
  card.dataset.id = task.id;
  card.tabIndex = 0;
  card.setAttribute('role', 'button');
  card.setAttribute('aria-pressed', 'false');
  card.setAttribute('aria-label', `${task.text} — click to toggle done`);
  card.style.left = x + 'px';
  card.style.top = y + 'px';
  card.style.opacity = '0';

  card.innerHTML = `
    <span class="card-text">${escapeHtml(task.text)}</span>
    <span class="canvas-handle" aria-hidden="true">\u2807</span>
    <div class="card-strike" aria-hidden="true">
      <svg width="100%" height="100%" preserveAspectRatio="none" overflow="visible"><path class="strike-path" d=""/></svg>
    </div>
  `;

  setupLongPressDrag(card, task.id);
  setupSwipeStrike(card, task.id);

  card.addEventListener('pointerdown', () => {
    document.querySelectorAll('.canvas-card').forEach(c => { c.style.zIndex = '1'; });
    card.style.zIndex = '10';
  });
  card.addEventListener('focus', () => {
    document.querySelectorAll('.canvas-card').forEach(c => { c.style.zIndex = '1'; });
    card.style.zIndex = '10';
  });

  let clickTimer = null;
  card.addEventListener('click', (e) => {
    if (card._suppressNextClick) { card._suppressNextClick = false; return; }
    if (card._isEditing) return;
    if (card.querySelector('input') || card.querySelector('[contenteditable="true"]')) return;
    clearTimeout(clickTimer);
    clickTimer = setTimeout(() => {
      if (card._isEditing) return;
      onCanvasCardTap(card, task.id);
    }, 250);
  });

  card.addEventListener('dblclick', (e) => {
    e.stopPropagation();
    clearTimeout(clickTimer);
    card._suppressNextClick = true;
    setTimeout(() => { card._suppressNextClick = false; }, 300);
    if (card.classList.contains('done')) return; // done: dblclick does nothing
    const textEl = card.querySelector('.card-text');
    if (textEl.getAttribute('contenteditable') === 'true') return;
    const originalText = textEl.textContent;
    const taskId = card.dataset.id;

    card._isEditing = true;
    textEl.setAttribute('contenteditable', 'true');
    textEl.style.outline = 'none';
    textEl.focus();
    attachPlainPaste(textEl);
    scrollCardIntoKeyboardView(card);

    const range = document.createRange();
    range.selectNodeContents(textEl);
    range.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);

    function endEdit() {
      setTimeout(() => { card._isEditing = false; }, 350);
      restoreCardPosition(card, taskId);
      resetIOSZoom();
    }

    function save() {
      textEl.setAttribute('contenteditable', 'false');
      card._suppressNextClick = true;
      setTimeout(() => { card._suppressNextClick = false; }, 400);
      const plainText = (textEl.textContent.trim() || originalText).slice(0, 500);
      if (plainText !== originalText) {
        const t = state.tasks.find(t => t.id === taskId);
        if (t) t.text = plainText;
      }
      // Write back what persistence keeps: plain text. The old innerHTML
      // round-trip kept pasted/dropped markup alive on screen until reload —
      // attachPlainPaste blocks it arriving via paste, but a native
      // drag-and-drop into this contenteditable bypasses that guard (drop
      // isn't a paste event) and Blink's own drop-insertion default action
      // still lands raw tags here. Same fix already applied to the
      // dblclick handler in buildCanvasCards(); this editor kept the
      // vulnerable round-trip.
      textEl.textContent = plainText;
      card.setAttribute('aria-label', `${plainText} — click to toggle done`);
      requestAnimationFrame(() => requestAnimationFrame(() => updateStrikePath(card)));
      clampCardWithinCanvas(card, taskId);
      saveState();
      endEdit();
    }

    function cancel() {
      textEl.setAttribute('contenteditable', 'false');
      card._suppressNextClick = true;
      setTimeout(() => { card._suppressNextClick = false; }, 400);
      textEl.textContent = originalText;
      endEdit();
    }

    textEl.addEventListener('keydown', function handler(ev) {
      if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); save(); textEl.removeEventListener('keydown', handler); }
      if (ev.key === 'Escape') { ev.preventDefault(); cancel(); textEl.removeEventListener('keydown', handler); }
      ev.stopPropagation();
    });

    textEl.addEventListener('blur', save, { once: true });
  });

  // Double-tap fallback for mobile
  let lastTapTime = 0;
  card.addEventListener('pointerup', (e) => {
    if (card._suppressNextClick) return;
    if (card._isEditing) return;
    if (card.querySelector('[contenteditable="true"]') || card.querySelector('.sort-edit-input')) return;
    const now = Date.now();
    if (now - lastTapTime < 250) {
      card.dispatchEvent(new Event('dblclick', { bubbles: true }));
      lastTapTime = 0;
    } else {
      lastTapTime = now;
    }
  });

  card.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onCanvasCardTap(card, task.id);
    }
    if (['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(e.key)) {
      e.preventDefault();
      const STEP = 20;
      const canvasRect2 = canvas.getBoundingClientRect();
      const EDGE = 24;
      const oldCx = parseFloat(card.style.left) || 0;
      const oldCy = parseFloat(card.style.top) || 0;
      let cx = oldCx;
      let cy = oldCy;
      if (e.key === 'ArrowLeft')  cx = Math.max(EDGE, cx - STEP);
      if (e.key === 'ArrowRight') cx = Math.min(canvasRect2.width - card.offsetWidth - EDGE, cx + STEP);
      if (e.key === 'ArrowUp')    cy = Math.max(EDGE, cy - STEP);
      if (e.key === 'ArrowDown')  cy = Math.min(canvasRect2.height - card.offsetHeight - EDGE, cy + STEP);
      if (cx === oldCx && cy === oldCy) {
        announce(`${getTaskText(task.id)} at edge`);
        return;
      }
      card.style.left = cx + 'px';
      card.style.top  = cy + 'px';
      state.cardPositions[task.id] = { x: cx, y: cy };
      saveState();
      announce(`${task.text} moved to ${Math.round(cx)}, ${Math.round(cy)}`);
    }
  });

  // Hide empty state when adding a card
  const emptyEl = document.getElementById('empty-state');
  if (emptyEl) emptyEl.classList.remove('visible');

  canvas.appendChild(card);
  clampCardWithinCanvas(card, task.id);

  requestAnimationFrame(() => requestAnimationFrame(() => {
    updateStrikePath(card);
    card.animate([
      { opacity: 0, transform: 'scale(0.9)' },
      { opacity: 1, transform: 'scale(1)' }
    ], { duration: 200, easing: 'ease-out', fill: 'forwards' });
  }));

  saveState();
  announce(`Added ${task.text} to the grid.`);
}

// ──────────────────────────────────────────────────────────────────────────────
// Long-press drag on canvas
// ──────────────────────────────────────────────────────────────────────────────

function setupLongPressDrag(card, id) {
  let isDragging = false;
  let startX, startY, startLeft, startTop;

  const DRAG_THRESHOLD = 4;

  // ── Handle drag (pointer events — handle has touch-action:none so no cancel) ──
  function onHandleDown(e) {
    if (e.button !== undefined && e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();

    startX = e.clientX;
    startY = e.clientY;
    startLeft = parseFloat(card.style.left) || 0;
    startTop = parseFloat(card.style.top) || 0;
    isDragging = false;

    card.setPointerCapture(e.pointerId);
    card._suppressNextClick = true;

    card.addEventListener('pointermove', onPointerMove);
    card.addEventListener('pointerup', onPointerEnd);
    card.addEventListener('pointercancel', onPointerEnd);
  }

  function onPointerMove(e) {
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;

    if (!isDragging) {
      if (Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return;
      isDragging = true;
      canvasDragActive = true;
      card.classList.add('grabbing');
      card.style.boxShadow = 'var(--card-shadow-lift)';
      card.style.zIndex = '100';
    }

    e.preventDefault();
    moveCard(dx, dy);
  }

  function onPointerEnd(e) {
    card.removeEventListener('pointermove', onPointerMove);
    card.removeEventListener('pointerup', onPointerEnd);
    card.removeEventListener('pointercancel', onPointerEnd);
    finishDrag();
  }

  // ── Shared: move card within canvas bounds ──
  function moveCard(dx, dy) {
    const canvas = document.getElementById('scatter-canvas');
    const canvasRect = canvas.getBoundingClientRect();
    const EDGE = 24;
    const newLeft = Math.max(EDGE, Math.min(canvasRect.width - card.offsetWidth - EDGE, startLeft + dx));
    const newTop = Math.max(EDGE, Math.min(canvasRect.height - card.offsetHeight - EDGE, startTop + dy));
    card.style.left = newLeft + 'px';
    card.style.top = newTop + 'px';
  }

  function finishDrag() {
    if (!isDragging) {
      setTimeout(() => { card._suppressNextClick = false; }, 50);
      return;
    }

    isDragging = false;
    canvasDragActive = false;
    card.classList.remove('grabbing');
    card.style.zIndex = '';
    card.style.boxShadow = '';
    card.style.transition = 'box-shadow 150ms ease';

    state.cardPositions[id] = {
      x: parseFloat(card.style.left),
      y: parseFloat(card.style.top),
    };
    saveState();
    collapseInteractionHints();

    setTimeout(() => { card._suppressNextClick = false; card.style.transition = ''; }, 200);
  }

  const handle = card.querySelector('.canvas-handle');
  if (handle) {
    handle.addEventListener('pointerdown', onHandleDown);
  }

  // ── Long-press on card body (touch events — immune to pointercancel) ──
  let lpTimer = null;
  card.addEventListener('touchstart', (e) => {
    if (e.target.closest('.canvas-handle')) return;

    const t = e.touches[0];
    if (!t) return;
    const sx = t.clientX;
    const sy = t.clientY;

    const onMoveLp = (ev) => {
      const mt = ev.touches[0];
      if (!mt) return;
      if (Math.abs(mt.clientX - sx) > LONG_PRESS_TOLERANCE ||
          Math.abs(mt.clientY - sy) > LONG_PRESS_TOLERANCE) {
        cancelLp();
      }
    };
    const cancelLp = () => {
      if (lpTimer) clearTimeout(lpTimer);
      lpTimer = null;
      card.classList.remove('long-press-charging');
      document.removeEventListener('touchmove', onMoveLp);
      document.removeEventListener('touchend', cancelLp);
      document.removeEventListener('touchcancel', cancelLp);
    };

    document.addEventListener('touchmove', onMoveLp, { passive: true });
    document.addEventListener('touchend', cancelLp, { passive: true });
    document.addEventListener('touchcancel', cancelLp, { passive: true });

    card.classList.add('long-press-charging');

    lpTimer = setTimeout(() => {
      cancelLp();
      if (navigator.vibrate) navigator.vibrate(30);

      // Set up drag state
      startX = sx;
      startY = sy;
      startLeft = parseFloat(card.style.left) || 0;
      startTop = parseFloat(card.style.top) || 0;
      isDragging = true;
      canvasDragActive = true;
      card._suppressNextClick = true;
      card.classList.add('grabbing');
      card.style.boxShadow = 'var(--card-shadow-lift)';
      card.style.zIndex = '100';

      // Track drag via touch events
      function onDragMove(ev) {
        ev.preventDefault(); // block scroll
        const dt = ev.touches[0];
        if (dt) moveCard(dt.clientX - startX, dt.clientY - startY);
      }
      function onDragEnd() {
        document.removeEventListener('touchmove', onDragMove);
        document.removeEventListener('touchend', onDragEnd);
        document.removeEventListener('touchcancel', onDragEnd);
        finishDrag();
      }

      document.addEventListener('touchmove', onDragMove, { passive: false });
      document.addEventListener('touchend', onDragEnd, { passive: true });
      document.addEventListener('touchcancel', onDragEnd, { passive: true });
    }, LONG_PRESS_DELAY);
  }, { passive: true });
}

// ──────────────────────────────────────────────────────────────────────────────
// localStorage persistence
// ──────────────────────────────────────────────────────────────────────────────

// This variant historically shared the main map's localStorage key, so the
// two pages overwrote each other's boards. It now has its own key; boards
// saved under the legacy key by THIS variant are migrated on first load.
const LS_KEY = 'todomap-impact-effort-state';
const LEGACY_LS_KEY = 'eisenhower-matrix-state';

// Which slot saveState/loadSavedState talk to. Normally the visitor's own
// board; while a shared map is open it points at that map's sandbox copy
// ('todomap-sandbox-<id>'), so viewer edits can never touch their own board.
let activeLsKey = LS_KEY;
// For sandbox copies: which published version this copy was seeded from.
let sandboxMeta = null;

// Multi-map: the home screen opens maps as ?map=<id>, each with its own slot
// in the maps index (maps-index.js). Without the param this stays the legacy
// single-board key.
const MAP_URL_ID = (() => {
  try { return new URLSearchParams(location.search).get('map'); }
  catch (e) { return null; }
})();
if (MAP_URL_ID) activeLsKey = 'todomap-map-' + MAP_URL_ID;

// Last known scatter-canvas size, persisted alongside positions so the home
// screen can normalize task coordinates for its card thumbnails.
let lastCanvasDims = null;
// Whether this session has written anything yet — the boot-time cloud pull
// only applies while the board is still untouched.
let dirtySinceBoot = false;

function saveState() {
  dirtySinceBoot = true;
  try {
    const serializable = {
      tasks: state.tasks,
      impactOrder: state.impactOrder,
      effortOrder: state.effortOrder,
      phase: state.phase,
      cardPositions: state.cardPositions,
      scatterSig: state.scatterSig,
      done: [...state.done],
      idCounter: idCounter,
      history: state.history,
    };
    if (sandboxMeta) serializable.sandboxMeta = sandboxMeta;
    const canvasEl = document.getElementById('scatter-canvas');
    const rect = canvasEl ? canvasEl.getBoundingClientRect() : null;
    if (rect && rect.width > 0) {
      lastCanvasDims = { w: Math.round(rect.width), h: Math.round(rect.height) };
    }
    if (lastCanvasDims) serializable.canvas = lastCanvasDims;
    localStorage.setItem(activeLsKey, JSON.stringify(serializable));
    if (MAP_URL_ID && window.TodoMapsIndex) {
      TodoMapsIndex.touch(MAP_URL_ID);
      if (window.TodoMapsCloud && TodoMapsCloud.enabled) TodoMapsCloud.schedulePush(MAP_URL_ID);
    }
  } catch(e) {
    // Storage full or unavailable — say so once instead of losing edits in
    // silence.
    if (!saveState.warned) {
      saveState.warned = true;
      showEditorNotice('this browser’s storage is full — changes aren’t saving');
    }
  }
}

function loadSavedState() {
  try {
    let raw = localStorage.getItem(activeLsKey);
    if (!raw && activeLsKey === LS_KEY) {
      // One-time migration: adopt legacy-key data only if it was written by
      // this variant (it has impact/effort ordering, not urgency/importance).
      const legacy = localStorage.getItem(LEGACY_LS_KEY);
      if (legacy) {
        try {
          const parsed = JSON.parse(legacy);
          if (parsed && 'impactOrder' in parsed) {
            localStorage.setItem(LS_KEY, legacy);
            localStorage.removeItem(LEGACY_LS_KEY);
            raw = legacy;
          }
        } catch (e) { /* unreadable legacy data — leave it alone */ }
      }
    }
    if (!raw) return false;
    const saved = JSON.parse(raw);
    if (!saved || !saved.tasks || !saved.phase) return false;
    state.tasks = saved.tasks;
    state.impactOrder = saved.impactOrder || [];
    state.effortOrder = saved.effortOrder || [];
    state.phase = saved.phase;
    state.cardPositions = saved.cardPositions || {};
    // Boards saved before scatterSig existed: adopt the loaded rankings as the
    // signature when every task already has a position, so the first re-entry
    // to the map doesn't reshuffle it.
    state.scatterSig = saved.scatterSig ||
      (state.tasks.length && state.tasks.every(t => state.cardPositions[t.id])
        ? rankingSignature() : null);
    state.done = new Set(saved.done || []);
    idCounter = saved.idCounter || 0;
    state.history = saved.history || [];
    state.viewingIdx = null;
    sandboxMeta = saved.sandboxMeta || null;
    lastCanvasDims = saved.canvas || null;
    // Heal saves from before deletions pruned these structures — stale done
    // ids made "clean up" announce work while fading zero cards.
    const liveIds = new Set(state.tasks.map(t => t.id));
    state.impactOrder = state.impactOrder.filter(id => liveIds.has(id));
    state.effortOrder = state.effortOrder.filter(id => liveIds.has(id));
    [...state.done].forEach(id => { if (!liveIds.has(id)) state.done.delete(id); });
    Object.keys(state.cardPositions).forEach(id => {
      if (!liveIds.has(id)) delete state.cardPositions[id];
    });
    return saved.phase;
  } catch(e) { return false; }
}

// ──────────────────────────────────────────────────────────────────────────────
// Canvas toolbar: Clean up, Back to top
// ──────────────────────────────────────────────────────────────────────────────

function doCleanup() {
  // Safety: can't clean up while viewing history
  if (state.viewingIdx !== null) return;

  const doneIds = [...state.done];
  if (doneIds.length === 0) {
    announce('Nothing to clean up.');
    return;
  }

  const canvas = document.getElementById('scatter-canvas');
  const rm = prefersReducedMotion();

  // Cleanup is undoable for one notice-length — capture everything the fade
  // is about to destroy.
  const undoData = {
    tasks: state.tasks.slice(),
    done: new Set(state.done),
    impactOrder: state.impactOrder.slice(),
    effortOrder: state.effortOrder.slice(),
    cardPositions: { ...state.cardPositions },
    scatterSig: state.scatterSig,
  };

  // Save snapshot before removing tasks
  const snapshot = {
    ts: Date.now(),
    checkedCount: doneIds.length,
    items: state.tasks.map(t => {
      const card = canvas.querySelector(`.canvas-card[data-id="${t.id}"]`);
      const x = card ? parseFloat(card.style.left) : (state.cardPositions[t.id] ? state.cardPositions[t.id].x : 0);
      const y = card ? parseFloat(card.style.top)  : (state.cardPositions[t.id] ? state.cardPositions[t.id].y : 0);
      return { id: t.id, text: t.text, x, y, done: state.done.has(t.id) };
    }),
  };
  state.history.push(snapshot);
  hSelected = state.history.length; // point to "now" (last entry index in entries array)
  buildHistoryTimeline();

  // Fade out done cards
  const doneCards = doneIds.map(id => canvas.querySelector(`.canvas-card[data-id="${id}"]`)).filter(Boolean);
  doneCards.forEach(c => {
    c.style.transition = rm ? 'none' : 'opacity 250ms ease';
    c.style.opacity = '0';
  });

  const afterFade = () => {
    // Remove from DOM
    doneCards.forEach(c => c.remove());

    // Update state
    state.tasks = state.tasks.filter(t => !state.done.has(t.id));
    state.impactOrder = state.impactOrder.filter(id => !state.done.has(id));
    state.effortOrder = state.effortOrder.filter(id => !state.done.has(id));
    state.done.clear();

    // Recompute positions for remaining tasks
    const canvasRect = canvas.getBoundingClientRect();
    if (canvasRect.width > 0 && state.tasks.length > 0) {
      state.cardPositions = computeCanvasPositions(canvasRect.width, canvasRect.height);
      state.scatterSig = rankingSignature();

      // Animate remaining cards to new positions
      const remaining = canvas.querySelectorAll('.canvas-card');
      remaining.forEach(card => {
        const id = card.dataset.id;
        const pos = state.cardPositions[id];
        if (pos) {
          card.style.transition = rm ? 'none' : 'left 400ms cubic-bezier(0.25, 0.1, 0.25, 1), top 400ms cubic-bezier(0.25, 0.1, 0.25, 1)';
          card.style.left = pos.x + 'px';
          card.style.top = pos.y + 'px';
        }
      });
      // Clear stale transition after animation so drag/arrow keys aren't sluggish
      if (!rm) {
        setTimeout(() => { remaining.forEach(card => { card.style.transition = ''; }); }, 420);
      }
    } else {
      state.cardPositions = {};
    }

    updateEmptyState();

    saveState();
    showEditorNotice(`cleaned up ${doneIds.length} ${doneIds.length === 1 ? 'task' : 'tasks'}`, {
      actionLabel: 'undo',
      duration: 8000,
      onAction: () => {
        // Tasks added after the cleanup survive the undo — merge them onto
        // the restored board instead of clobbering them away.
        const restored = new Set(undoData.tasks.map(t => t.id));
        const addedSince = state.tasks.filter(t => !restored.has(t.id));
        const curPos = state.cardPositions;
        state.tasks = undoData.tasks.concat(addedSince);
        state.done = new Set(undoData.done);
        state.impactOrder = undoData.impactOrder.concat(addedSince.map(t => t.id));
        state.effortOrder = undoData.effortOrder.concat(addedSince.map(t => t.id));
        state.cardPositions = { ...undoData.cardPositions };
        addedSince.forEach(t => { if (curPos[t.id]) state.cardPositions[t.id] = curPos[t.id]; });
        state.scatterSig = rankingSignature();
        state.history.pop(); // drop the snapshot this cleanup just pushed
        hSelected = hNowIdx();
        buildHistoryTimeline();
        rerenderFromState();
        saveState();
      },
    });
  };

  if (rm) {
    afterFade();
  } else {
    setTimeout(afterFade, 280);
  }
}

function doBackToTop() {
  // Show fresh dump — existing cards hidden behind context line
  showDumpFresh();
  document.getElementById('phase-dump').classList.toggle('has-tasks', state.tasks.length > 0);

  showPhase('dump');
  announce('Back to the beginning. Add more tasks or tap to see existing ones.');
}

function initToolbar() {
  const cleanupBtn = document.getElementById('btn-cleanup');
  const backBtn = document.getElementById('btn-back-to-top');

  if (cleanupBtn) cleanupBtn.addEventListener('click', doCleanup);
  if (backBtn) backBtn.addEventListener('click', doBackToTop);
}

// ──────────────────────────────────────────────────────────────────────────────
// Export / Import
// ──────────────────────────────────────────────────────────────────────────────

function exportGrid() {
  const data = {
    version: '1.0',
    exportedAt: new Date().toISOString(),
    grid: {
      tasks: state.tasks,
      impactOrder: state.impactOrder,
      effortOrder: state.effortOrder,
      phase: state.phase,
      cardPositions: state.cardPositions,
      done: [...state.done],
      idCounter: idCounter,
    }
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const d = new Date();
  const stamp = d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
  a.download = `to-do-map-${stamp}.json`;
  a.click();
  URL.revokeObjectURL(url);
  announce('Grid exported.');
}

// The scatter canvas's "all clear" message — kept in sync by every path
// that can land on an empty (or no-longer-empty) board, not just cleanup.
function updateEmptyState() {
  const emptyEl = document.getElementById('empty-state');
  if (emptyEl) emptyEl.classList.toggle('visible', state.phase === 'scatter' && state.tasks.length === 0);
}

// Rebuild the visible phase from state — shared by import, cleanup undo, and
// cloud pull. Assumes state (tasks/orders/positions/phase) is already set.
function rerenderFromState() {
  if (state.phase === 'scatter') {
    showPhase('scatter');
    const scatterCanvas = document.getElementById('scatter-canvas');
    scatterCanvas.classList.remove('history-view');
    scatterCanvas.querySelectorAll('.canvas-card').forEach(c => c.remove());
    hSelected = hNowIdx();
    document.fonts.ready.then(() => {
      const canvas = document.getElementById('scatter-canvas');
      const rect = canvas.getBoundingClientRect();
      if (rect.width > 0) {
        if (state.tasks.some(t => !state.cardPositions[t.id])) {
          state.cardPositions = computeCanvasPositions(rect.width, rect.height);
          state.scatterSig = rankingSignature();
        }
        reflowCanvasPositions();
        buildCanvasCards(prefersReducedMotion());
        canvas.querySelectorAll('.canvas-card').forEach(c => { c.style.opacity = '1'; });
        drawQuadrantLines(prefersReducedMotion());
        buildHistoryTimeline();
      }
    });
  } else if (state.phase === 'sort-impact') {
    renderSortList('impact');
    showPhase('sort-impact');
  } else if (state.phase === 'sort-effort') {
    renderSortList('impact');
    renderSortList('effort');
    showPhase('sort-effort');
  } else {
    // dump phase — rebuild dump cards
    renderDumpCards();
    if (state.tasks.length > 0) {
      document.getElementById('phase-dump').classList.add('has-tasks');
    }
    showPhase('dump');
  }
  updateEmptyState();
}

// Accept only things shaped like our own exports, and only the fields we
// wrote. Returns null (rather than throwing) for anything else.
function parseGridFile(text) {
  const data = JSON.parse(text);
  const g = data && data.grid;
  if (!g || !Array.isArray(g.tasks)) return null;
  const tasks = [];
  for (const t of g.tasks) {
    // Ids get interpolated into `[data-id="${t.id}"]` querySelector strings
    // all over this file (buildCanvasCards, cleanup snapshots, done-toggling)
    // with no escaping. bootSharedView's seedFromRecord() already restricts a
    // remote share record's ids to this same shape for exactly that reason —
    // a hand-edited or otherwise untrusted export file can carry an id like
    // `t1"]` just as easily, and an unescaped quote breaks out of the
    // attribute selector, throwing a DOMException the first time any of
    // those call sites run. Reject it the same way a malformed id is
    // rejected below, rather than let it into an id list at all.
    if (!t || typeof t.id !== 'string' || !/^[\w-]+$/.test(t.id) || typeof t.text !== 'string') return null;
    // Every live editor caps task text at 500 chars (dump-input/canvas-add-input
    // maxlength, plus the .slice(0, 500) in each inline-edit save()). A hand-edited
    // or otherwise untrusted export file has no such limit, and an unbounded string
    // renders as a card far taller than the canvas — clampCardWithinCanvas can only
    // reposition a card, it can't shrink one taller than the canvas itself, so the
    // excess stays clipped by .scatter-canvas's overflow:hidden. Cap on import too.
    tasks.push({ id: t.id, text: t.text.slice(0, 500) });
  }
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
  // Keep makeId collision-free even against hand-edited files: the counter
  // must clear every imported t<n> id.
  let counter = (typeof g.idCounter === 'number' && isFinite(g.idCounter)) ? g.idCounter : 0;
  tasks.forEach(t => {
    const n = /^t(\d+)$/.exec(t.id);
    if (n) counter = Math.max(counter, parseInt(n[1], 10));
  });
  // History entries are read by buildHistoryTimeline() (entry.checkedCount)
  // and selectSnapshot() (snap.items.forEach) with no null/shape guard —
  // an entry that isn't shaped like our own cleanup snapshots (e.g. a bare
  // `null` from a hand-edited file) throws there and wedges the timeline
  // for the rest of the session. Drop anything that doesn't match, the same
  // way idList() drops bad ids instead of failing the whole import.
  const history = Array.isArray(g.history) ? g.history.filter(h =>
    h && typeof h === 'object' &&
    isFinite(h.ts) && isFinite(h.checkedCount) &&
    Array.isArray(h.items) && h.items.every(it => it && typeof it.id === 'string')
  ) : [];
  return {
    tasks,
    impactOrder: idList(g.impactOrder),
    effortOrder: idList(g.effortOrder),
    phase: PHASE_ORDER.indexOf(g.phase) !== -1 ? g.phase : 'dump',
    cardPositions: positions,
    done: idList(g.done),
    idCounter: counter,
    history,
  };
}

function importGrid(file) {
  const reader = new FileReader();
  reader.onerror = function() {
    showEditorNotice('couldn’t read that file.');
  };
  reader.onload = function(e) {
    // Validate the whole candidate before touching live state — a bad file
    // must never leave a half-imported board behind.
    let candidate = null;
    try { candidate = parseGridFile(e.target.result); }
    catch (err) { candidate = null; }
    if (!candidate) {
      showEditorNotice('couldn’t import — not a to-do map export.');
      return;
    }
    state.tasks = candidate.tasks;
    state.impactOrder = candidate.impactOrder;
    state.effortOrder = candidate.effortOrder;
    state.phase = candidate.phase;
    state.cardPositions = candidate.cardPositions;
    state.done = new Set(candidate.done);
    idCounter = candidate.idCounter;
    state.history = candidate.history;
    state.viewingIdx = null;
    // Sandboxes only ever live on the map screen — never restore an
    // imported file into the (uninitialized) dump/sort screens there.
    if (window.SHARED_VIEW_ACTIVE) state.phase = 'scatter';
    // Imported files predate scatterSig — adopt the imported rankings as the
    // signature when every task has a position, so the map isn't reshuffled.
    state.scatterSig =
      (state.tasks.length && state.tasks.every(t => state.cardPositions[t.id]))
        ? rankingSignature() : null;
    saveState();
    rerenderFromState();
    announce('Grid restored from file.');
  };
  reader.readAsText(file);
}

function initExportImport() {
  document.getElementById('btn-export').addEventListener('click', exportGrid);
  const fileInput = document.getElementById('import-file-input');
  document.getElementById('btn-import').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', (e) => {
    if (e.target.files.length > 0) {
      importGrid(e.target.files[0]);
      e.target.value = ''; // reset so same file can be re-imported
    }
  });
}

// ──────────────────────────────────────────────────────────────────────────────
// Fix 1: Sort tips system
// ──────────────────────────────────────────────────────────────────────────────

const IMPACT_TIPS = [
  "Impact means how much finishing this actually moves things forward.",
  "A rough ranking is enough. You can adjust later.",
  "If two feel similar, put the bigger payoff above the other.",
  "Think about the outcome, not the work \u2014 effort comes next.",
  "Trust your first instinct. You can always move things later."
];

const EFFORT_TIPS = [
  "Effort means the time, energy, and hassle to get it done.",
  "Hardest and most time-consuming go at the top.",
  "Waiting on other people counts as effort too.",
  "If two feel similar, put the heavier lift above the other.",
  "A rough ranking beats a perfect one you never finish."
];

let impactTipIdx = 0;
let effortTipIdx = 0;
let impactTipTimer = null;
let effortTipTimer = null;

function rotateTip(textEl, tips, idxKey, timerKey) {
  // Slide out current
  textEl.style.animation = 'tipSlideOut 300ms ease forwards';
  setTimeout(() => {
    // Update text and slide in
    if (idxKey === 'impact') {
      impactTipIdx = (impactTipIdx + 1) % tips.length;
      textEl.textContent = tips[impactTipIdx];
    } else {
      effortTipIdx = (effortTipIdx + 1) % tips.length;
      textEl.textContent = tips[effortTipIdx];
    }
    textEl.style.animation = '';
    // Force reflow to restart animation
    textEl.offsetHeight;
    textEl.style.animation = 'tipSlideUp 600ms ease forwards';

    // Schedule next rotation
    const timer = setTimeout(() => rotateTip(textEl, tips, idxKey, timerKey), 6000);
    if (idxKey === 'impact') impactTipTimer = timer;
    else effortTipTimer = timer;
  }, 300);
}

function startTipRotation(containerId, tips, idxKey) {
  const container = document.getElementById(containerId);
  if (!container) return;
  const textEl = container.querySelector('.sort-tip-text');
  if (!textEl) return;

  // Show first tip
  const idx = idxKey === 'impact' ? impactTipIdx : effortTipIdx;
  textEl.textContent = tips[idx];
  textEl.style.animation = 'tipSlideUp 600ms ease forwards';

  // Start rotation after 5 seconds
  const timer = setTimeout(() => rotateTip(textEl, tips, idxKey), 5000);
  if (idxKey === 'impact') impactTipTimer = timer;
  else effortTipTimer = timer;
}

function stopTipRotation() {
  clearTimeout(impactTipTimer);
  clearTimeout(effortTipTimer);
  impactTipTimer = null;
  effortTipTimer = null;
}

// Rotation follows the visible phase (showPhase drives this) — both lists
// used to rotate forever from init, even while hidden, which kept two live
// regions chattering at screen readers every few seconds.
function syncTipRotation() {
  stopTipRotation();
  if (state.phase === 'sort-impact') {
    startTipRotation('sort-tip-impact', IMPACT_TIPS, 'impact');
  } else if (state.phase === 'sort-effort') {
    startTipRotation('sort-tip-effort', EFFORT_TIPS, 'effort');
  }
}

function initSortTips() {
  syncTipRotation();
}

// ──────────────────────────────────────────────────────────────────────────────
// Corner label popovers
// ──────────────────────────────────────────────────────────────────────────────

function initCornerPopovers() {
  const labels = document.querySelectorAll('.corner-label');
  const popovers = document.querySelectorAll('.corner-popover');

  // aria-hidden and aria-expanded track the open state — the markup ships
  // them hardcoded closed, which told screen readers the text never exists.
  const closeAll = () => {
    popovers.forEach(p => { p.classList.remove('open'); p.setAttribute('aria-hidden', 'true'); });
    labels.forEach(l => l.setAttribute('aria-expanded', 'false'));
  };

  labels.forEach(label => {
    label.setAttribute('aria-expanded', 'false');
    label.addEventListener('click', (e) => {
      e.stopPropagation();
      // Find the matching popover (next sibling)
      const popover = label.nextElementSibling;
      if (!popover || !popover.classList.contains('corner-popover')) return;
      const isOpen = popover.classList.contains('open');
      closeAll();
      if (!isOpen) {
        popover.classList.add('open');
        popover.setAttribute('aria-hidden', 'false');
        label.setAttribute('aria-expanded', 'true');
      }
    });
  });

  // Click outside or Escape dismisses all popovers
  document.addEventListener('click', closeAll);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeAll();
  });
}

// ──────────────────────────────────────────────────────────────────────────────
// Interaction hints — collapsible tips toggle
// ──────────────────────────────────────────────────────────────────────────────

function collapseInteractionHints() {
  const hints = document.getElementById('interaction-hints');
  if (!hints || hints.classList.contains('collapsed')) return;
  hints.classList.add('collapsed');
}

function initInteractionHints() {
  // On touch devices, tap "tips" to briefly show hints
  const hints = document.getElementById('interaction-hints');
  if (!hints) return;
  const toggle = document.getElementById('tips-toggle');
  if (!toggle) return;
  toggle.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!hints.classList.contains('collapsed')) return;
    hints.classList.remove('collapsed');
    // Re-collapse after finger lifts and a short reading window
    setTimeout(() => hints.classList.add('collapsed'), 3000);
  });
}

// ──────────────────────────────────────────────────────────────────────────────
// Fix 1: Map guide
// ──────────────────────────────────────────────────────────────────────────────

function initMapGuide() {
  const toggle = document.getElementById('map-guide-toggle');
  const content = document.getElementById('map-guide-content');
  const close = document.getElementById('map-guide-close');
  if (!toggle || !content) return;

  toggle.addEventListener('click', () => {
    content.classList.toggle('open');
    toggle.setAttribute('aria-expanded', content.classList.contains('open') ? 'true' : 'false');
  });
  if (close) {
    close.addEventListener('click', () => {
      content.classList.remove('open');
      toggle.setAttribute('aria-expanded', 'false');
      toggle.focus();
    });
  }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && content.classList.contains('open')) {
      content.classList.remove('open');
      toggle.setAttribute('aria-expanded', 'false');
      toggle.focus();
    }
  });
}

// ──────────────────────────────────────────────────────────────────────────────
// Typewriter animation for dump input
// ──────────────────────────────────────────────────────────────────────────────

const TYPEWRITER_TEXTS = [
  "write the project proposal",
  "reply to the client email",
  "plan next quarter's roadmap",
  "reorganize the file system",
  "book the dentist appointment",
];

let typewriterTimeouts = [];
let typewriterIdx = 0;
let typewriterRunning = false;

function stopTypewriter() {
  typewriterTimeouts.forEach(id => clearTimeout(id));
  typewriterTimeouts = [];
  typewriterRunning = false;
  const wrap = document.querySelector('.dump-input-wrap');
  if (wrap) wrap.classList.remove('typewriter-active');
}

function startTypewriter() {
  if (typewriterRunning) return;
  const el = document.getElementById('typewriter');
  const wrap = document.querySelector('.dump-input-wrap');
  if (!el) return;
  el.textContent = '';
  typewriterRunning = true;
  if (wrap) wrap.classList.add('typewriter-active');
  cycleTypewriter();
}

function cycleTypewriter() {
  if (!typewriterRunning) return;
  const el = document.getElementById('typewriter');
  if (!el) return;
  const text = TYPEWRITER_TEXTS[typewriterIdx % TYPEWRITER_TEXTS.length];
  typeText(text, () => {
    if (!typewriterRunning) return;
    deleteText(() => {
      if (!typewriterRunning) return;
      typewriterIdx++;
      cycleTypewriter();
    });
  });
}

function typeText(text, callback) {
  const el = document.getElementById('typewriter');
  if (!el) return;
  let i = 0;
  el.textContent = '';
  function step() {
    if (!typewriterRunning) return;
    el.textContent = text.slice(0, i + 1);
    i++;
    if (i >= text.length) {
      const tid = setTimeout(callback, 2000);
      typewriterTimeouts.push(tid);
    } else {
      const tid = setTimeout(step, 60);
      typewriterTimeouts.push(tid);
    }
  }
  step();
}

function deleteText(callback) {
  const el = document.getElementById('typewriter');
  if (!el) return;
  let i = el.textContent.length;
  function step() {
    if (!typewriterRunning) return;
    i--;
    el.textContent = el.textContent.slice(0, i);
    if (i <= 0) {
      const tid = setTimeout(callback, 500);
      typewriterTimeouts.push(tid);
    } else {
      const tid = setTimeout(step, 30);
      typewriterTimeouts.push(tid);
    }
  }
  step();
}

function initTypewriter() {
  const el = document.getElementById('typewriter');
  const input = document.getElementById('dump-input');
  if (!el || !input) return;

  // Click typewriter to focus input
  el.addEventListener('click', () => {
    input.focus();
  });

  // Only start if input is not focused, empty, and no tasks exist
  if (document.activeElement !== input && !input.value && state.tasks.length === 0) {
    startTypewriter();
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Dump cards overflow fade
// ──────────────────────────────────────────────────────────────────────────────

function updateDumpOverflow() {
  const lower = document.querySelector('.dump-lower');
  const cards = document.getElementById('dump-cards');
  if (!lower || !cards) return;
  // Show gradient when cards approach the fixed "ready to sort" button zone (~100px from bottom)
  const cardsBottom = cards.getBoundingClientRect().bottom;
  const lowerBottom = lower.getBoundingClientRect().bottom;
  lower.classList.toggle('has-overflow', lowerBottom - cardsBottom < 100);
}

// ──────────────────────────────────────────────────────────────────────────────
// Fullpage snap/slide navigation
// ──────────────────────────────────────────────────────────────────────────────

let overscrollAccumulator = 0;
let bouncingBack = false;
let isTransitioning = false;
const OVERSCROLL_THRESHOLD = 120;
const MAX_VISUAL_PULL = 250;

// After a committed phase jump, swallow the remainder of the wheel gesture:
// trackpad inertia keeps delivering events for a second or more after the
// 450ms transition lock, and without this a single fling blows through
// several phases (e.g. from the map all the way back to the dump screen).
let absorbInertia = false;
let inertiaQuietTimer = null;

function beginInertiaAbsorb() {
  absorbInertia = true;
  clearTimeout(inertiaQuietTimer);
  // The gate reopens only after the wheel events go quiet for a beat.
  inertiaQuietTimer = setTimeout(() => { absorbInertia = false; }, 300);
}

function updateOverscrollVisual(activePhase, direction, noIndicator) {
  // Rubber band: 1:1 movement up to ~60% of max, then decelerating
  const raw = overscrollAccumulator;
  const visualOffset = Math.min(raw * (1 - raw / (2 * MAX_VISUAL_PULL * 2)), MAX_VISUAL_PULL);

  // No transition during active pull — instant response
  activePhase.style.transition = 'none';
  if (direction === 'down') {
    activePhase.style.transform = `translateY(${-visualOffset}px)`;
  } else {
    activePhase.style.transform = `translateY(${visualOffset}px)`;
  }

  // No button animation on first/last page — just the rubber band feel
  if (noIndicator) return;

  // Find the nav button in the active phase
  const navBtn = activePhase.querySelector('.phase-nav-btn');
  if (navBtn) {
    const progress = overscrollAccumulator / OVERSCROLL_THRESHOLD;
    if (direction === 'down' && progress > 0.2) {
      // Button scales up and brightens as you pull
      const scale = 1 + Math.min(progress, 1) * 0.15; // max 1.15x
      const opacity = 0.7 + Math.min(progress, 1) * 0.3; // 0.7 → 1.0
      const isInFlow = navBtn.closest('.sort-section');
      navBtn.style.transition = 'none';
      navBtn.style.transform = isInFlow ? `scale(${scale})` : `translateX(-50%) scale(${scale})`;
      navBtn.style.opacity = opacity;
      // Arrow bounces down slightly
      const arrow = navBtn.querySelector('.nav-arrow');
      if (arrow) {
        arrow.style.transition = 'none';
        arrow.style.transform = `translateY(${Math.min(progress, 1) * 6}px)`;
      }
      // At commit point, change color
      if (progress >= 1) {
        navBtn.style.color = 'var(--sage)';
      } else {
        navBtn.style.color = '';
      }
    }
  }
}

function resetOverscroll(activePhase) {
  if (overscrollAccumulator > 0) {
    bouncingBack = true;
    activePhase.style.transition = 'transform 180ms cubic-bezier(0.2, 0.9, 0.3, 1.05)';
    activePhase.style.transform = 'translateY(0)';
    setTimeout(() => {
      activePhase.style.transition = '';
      activePhase.style.transform = '';
    }, 190);
    // Block all scroll events for 800ms to absorb trackpad inertia
    setTimeout(() => {
      bouncingBack = false;
    }, 800);
  }
  overscrollAccumulator = 0;
  // Reset nav button styles
  const navBtn = activePhase.querySelector('.phase-nav-btn');
  if (navBtn) {
    const isInFlow = navBtn.closest('.sort-section');
    navBtn.style.transition = 'transform 200ms ease, opacity 200ms ease, color 200ms ease';
    navBtn.style.transform = isInFlow ? '' : 'translateX(-50%)';
    navBtn.style.opacity = '';
    navBtn.style.color = '';
    const arrow = navBtn.querySelector('.nav-arrow');
    if (arrow) {
      arrow.style.transition = 'transform 200ms ease';
      arrow.style.transform = '';
    }
  }
}

function resetOverscrollTransform(activePhase) {
  activePhase.style.transform = '';
  // Reset nav button styles
  const navBtn = activePhase.querySelector('.phase-nav-btn');
  if (navBtn) {
    const isInFlow = navBtn.closest('.sort-section');
    navBtn.style.transition = 'transform 200ms ease, opacity 200ms ease, color 200ms ease';
    navBtn.style.transform = isInFlow ? '' : 'translateX(-50%)';
    navBtn.style.opacity = '';
    navBtn.style.color = '';
    const arrow = navBtn.querySelector('.nav-arrow');
    if (arrow) {
      arrow.style.transition = 'transform 200ms ease';
      arrow.style.transform = '';
    }
  }
}

function hideOverscrollIndicator() {
  // no-op — overscroll indicator removed
}

function goToNextPhase() {
  if (window.SHARED_VIEW_ACTIVE) return;
  const currentPhase = state.phase;
  // Gate: check if current phase is ready to advance
  if (currentPhase === 'dump' && state.tasks.length === 0) return;
  if (currentPhase === 'scatter') return; // last phase

  isTransitioning = true;
  beginInertiaAbsorb();

  if (currentPhase === 'dump') transitionToSortImpact();
  else if (currentPhase === 'sort-impact') onImpactDone();
  else if (currentPhase === 'sort-effort') onEffortDone();

  setTimeout(() => { isTransitioning = false; }, 450);
}

// A board can reach the map without complete rankings (e.g. a shared map
// copied to this browser stores empty order lists). Backfill them so the sort
// screens have something to show, without treating the backfill as a ranking
// change that would re-scatter the map.
function ensureOrdersRenderable() {
  if (state.impactOrder.length === state.tasks.length &&
      state.effortOrder.length === state.tasks.length) return;
  const positionsInSync = state.scatterSig === rankingSignature();
  state.impactOrder = reconcileOrder(state.impactOrder);
  state.effortOrder = state.effortOrder.length
    ? reconcileOrder(state.effortOrder)
    : [...state.impactOrder];
  if (positionsInSync) state.scatterSig = rankingSignature();
}

function goToPrevPhase() {
  if (window.SHARED_VIEW_ACTIVE) return;
  const currentPhase = state.phase;
  if (currentPhase === 'dump') return; // first phase

  isTransitioning = true;
  beginInertiaAbsorb();

  if (currentPhase === 'sort-impact') {
    showDumpFresh();
    document.getElementById('phase-dump').classList.toggle('has-tasks', state.tasks.length > 0);
    showPhase('dump');
  } else if (currentPhase === 'sort-effort') {
    ensureOrdersRenderable();
    renderSortList('impact');
    showPhase('sort-impact');
  } else if (currentPhase === 'scatter') {
    ensureOrdersRenderable();
    renderSortList('effort');
    showPhase('sort-effort');
  }

  saveState();
  setTimeout(() => { isTransitioning = false; }, 450);
}

function initPageScroll() {
  const container = document.querySelector('.flow-container');

  // ── Wheel overscroll detection ──
  let wheelIdleTimer = null;
  let lastWheelDirection = null;
  // bouncingBack is declared globally alongside resetOverscroll

  container.addEventListener('wheel', (e) => {
    if (absorbInertia) {
      // Still inside the gesture (or its inertia) that triggered the last
      // phase jump — keep extending the quiet window until events stop.
      beginInertiaAbsorb();
      e.preventDefault();
      return;
    }
    if (isTransitioning) { e.preventDefault(); return; }
    if (bouncingBack) { e.preventDefault(); return; }
    if (dragState || canvasDragActive) { return; }

    const activePhase = document.querySelector('.phase-active');
    if (!activePhase) return;

    // If cursor is over the dump card list, never trigger page overscroll
    const scrollableChild = e.target.closest('.dump-lower');
    if (scrollableChild) {
      return;
    }

    // Dump page with no tasks — no overscroll at all
    if (state.phase === 'dump' && state.tasks.length === 0) {
      return;
    }

    const isAtBottom = activePhase.scrollTop + activePhase.clientHeight >= activePhase.scrollHeight - 5;
    const isAtTop = activePhase.scrollTop <= 5;

    if (e.deltaY > 0 && isAtBottom) {
      e.preventDefault();
      if (state.phase === 'scatter') {
        // Last page — no overscroll at all
        return;
      } else {
        overscrollAccumulator = Math.min(overscrollAccumulator + e.deltaY, OVERSCROLL_THRESHOLD * 2);
        lastWheelDirection = 'down';
        updateOverscrollVisual(activePhase, 'down');
      }

      clearTimeout(wheelIdleTimer);
      if (overscrollAccumulator >= OVERSCROLL_THRESHOLD && state.phase !== 'scatter') {
        // Past threshold — snap immediately
        wheelIdleTimer = setTimeout(() => {
          hideOverscrollIndicator();
          resetOverscrollTransform(activePhase);
          overscrollAccumulator = 0;
          goToNextPhase();
        }, 16);
      } else {
        // Under threshold or last page — bounce back after settling
        wheelIdleTimer = setTimeout(() => {
          resetOverscroll(activePhase);
        }, 1000);
      }

    } else if (e.deltaY < 0 && isAtTop) {
      e.preventDefault();
      if (state.phase === 'dump') {
        const wasCapped = overscrollAccumulator >= OVERSCROLL_THRESHOLD * 0.4 - 1;
        overscrollAccumulator = Math.min(overscrollAccumulator + Math.abs(e.deltaY), OVERSCROLL_THRESHOLD * 0.4);
        updateOverscrollVisual(activePhase, 'up', true);
        // Only set timer if not already capped — once capped, let existing timer run
        if (!wasCapped) {
          clearTimeout(wheelIdleTimer);
          wheelIdleTimer = setTimeout(() => {
            resetOverscroll(activePhase);
          }, 200);
        }
      } else {
        overscrollAccumulator = Math.min(overscrollAccumulator + Math.abs(e.deltaY), OVERSCROLL_THRESHOLD * 2);
        lastWheelDirection = 'up';
        updateOverscrollVisual(activePhase, 'up');

        clearTimeout(wheelIdleTimer);
        if (overscrollAccumulator >= OVERSCROLL_THRESHOLD) {
          wheelIdleTimer = setTimeout(() => {
            hideOverscrollIndicator();
            resetOverscrollTransform(activePhase);
            overscrollAccumulator = 0;
            goToPrevPhase();
          }, 16);
        } else {
          wheelIdleTimer = setTimeout(() => {
            resetOverscroll(activePhase);
          }, 1000);
        }
      }

    } else {
      clearTimeout(wheelIdleTimer);
      resetOverscroll(activePhase);
    }
  }, { passive: false });

  // Reset accumulator on pointer interaction
  container.addEventListener('pointerdown', () => {
    if (!dragState) {
      overscrollAccumulator = 0;
      hideOverscrollIndicator();
    }
  });

  // ── Touch overscroll detection ──
  let touchStartY = 0;
  let touchAccumulator = 0;
  let touchDirection = null;

  container.addEventListener('touchstart', (e) => {
    touchStartY = e.touches[0].clientY;
    touchAccumulator = 0;
    touchDirection = null;
  }, { passive: true });

  container.addEventListener('touchmove', (e) => {
    if (isTransitioning) return;
    if (dragState || canvasDragActive) return; // don't interfere with sort or canvas drag

    const activePhase = document.querySelector('.phase-active');
    if (!activePhase) return;

    const deltaY = touchStartY - e.touches[0].clientY; // positive = swiping up (scroll down)

    // If finger is over the dump card list, never trigger page overscroll
    const scrollableChild = e.target.closest('.dump-lower');
    if (scrollableChild) {
      return;
    }

    // Dump page with no tasks — no overscroll at all
    if (state.phase === 'dump' && state.tasks.length === 0) {
      return;
    }

    const isAtBottom = activePhase.scrollTop + activePhase.clientHeight >= activePhase.scrollHeight - 5;
    const isAtTop = activePhase.scrollTop <= 5;

    if (deltaY > 0 && isAtBottom) {
      e.preventDefault();
      if (state.phase === 'scatter') {
        // Last page — no overscroll
        return;
      } else {
        touchAccumulator = deltaY;
        touchDirection = 'down';
        overscrollAccumulator = touchAccumulator;
        updateOverscrollVisual(activePhase, 'down');
      }
    } else if (deltaY < 0 && isAtTop) {
      e.preventDefault();
      if (state.phase === 'dump') {
        touchAccumulator = Math.min(Math.abs(deltaY), OVERSCROLL_THRESHOLD * 0.4);
        overscrollAccumulator = touchAccumulator;
        updateOverscrollVisual(activePhase, 'up', true);
      } else {
        touchAccumulator = Math.abs(deltaY);
        touchDirection = 'up';
        overscrollAccumulator = touchAccumulator;
        updateOverscrollVisual(activePhase, 'up');
      }
    } else {
      touchAccumulator = 0;
      touchDirection = null;
      resetOverscroll(activePhase);
    }
  }, { passive: false });

  container.addEventListener('touchend', () => {
    const activePhase = document.querySelector('.phase-active');
    if (!activePhase) return;

    if (overscrollAccumulator >= OVERSCROLL_THRESHOLD) {
      hideOverscrollIndicator();
      resetOverscrollTransform(activePhase);
      if (touchDirection === 'down') goToNextPhase();
      else if (touchDirection === 'up') goToPrevPhase();
    } else {
      resetOverscroll(activePhase);
    }
    touchAccumulator = 0;
    touchDirection = null;
    overscrollAccumulator = 0;
  }, { passive: true });
}

// ──────────────────────────────────────────────────────────────────────────────
// History Timeline
// ──────────────────────────────────────────────────────────────────────────────

const H_STEP  = 32; // px per entry (16px dot + 16px connector)
const H_SLOTS = 5;  // visible slots in the 144px viewport

let hSelected    = -1;
let hIsDragging  = false;
let hDidDrag     = false;
let hDragStartX  = 0;
let hDragStartSel = 0;

function hEntries() {
  return [...state.history, null]; // null = "now"
}

function hNowIdx() {
  return state.history.length; // last index in hEntries()
}

function hSlotFor(i, total) {
  const nowIdx = total - 1;
  if (i === 0)           return 0;
  if (i === 1)           return 1;
  if (i === nowIdx - 1)  return H_SLOTS - 2;
  if (i === nowIdx)      return H_SLOTS - 1;
  return Math.floor(H_SLOTS / 2);
}

function hTxFor(i) {
  return (hSlotFor(i, hEntries().length) - i) * H_STEP;
}

function hDotRadius(n) {
  if (n >= 8) return 8;
  if (n >= 5) return 6;
  if (n >= 2) return 4;
  return 3;
}

function hFormatLabel(i) {
  if (i === hNowIdx()) return 'now';
  const d = new Date(state.history[i].ts);
  const today = new Date();
  if (d.toDateString() === today.toDateString())
    return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
  return `${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getDate()).padStart(2,'0')}`;
}

function hApplyTx(tx, animate) {
  const track = document.getElementById('h-track');
  if (!track) return;
  track.style.transition = animate ? 'transform 0.2s ease' : 'none';
  track.style.transform  = `translateX(${tx}px)`;
}

function hSetSelected(i) {
  document.querySelectorAll('.h-entry').forEach(el => {
    const idx = parseInt(el.dataset.i);
    el.classList.toggle('is-selected', idx === i);
    if (idx !== i) el.querySelector('.h-entry-label').style.opacity = '';
  });
  hSelected = i;
}

function hUpdateNav() {
  const leftBtn  = document.getElementById('h-btn-left');
  const rightBtn = document.getElementById('h-btn-right');
  if (leftBtn)  leftBtn.classList.toggle('hidden', hSelected <= 0);
  if (rightBtn) rightBtn.classList.toggle('hidden', hSelected >= hNowIdx());
}

function buildHistoryTimeline() {
  const container = document.getElementById('history-timeline');
  if (!container) return;
  const entries = hEntries();
  const nowIdx  = hNowIdx();

  container.classList.toggle('has-history', state.history.length > 0);
  if (state.history.length === 0) return;

  if (hSelected < 0 || hSelected > nowIdx) hSelected = nowIdx;

  const track = document.getElementById('h-track');
  if (!track) return;

  let html = '';
  entries.forEach((entry, i) => {
    const isNow = i === nowIdx;
    const r     = isNow ? 2 : hDotRadius(entry.checkedCount);
    const lbl   = hFormatLabel(i);
    const sel   = i === hSelected ? ' is-selected' : '';
    const slot  = hSlotFor(i, entries.length);
    const anchor = slot === 0 ? ' anchor-left' : slot === H_SLOTS - 1 ? ' anchor-right' : '';
    html += `<div class="h-entry${sel}" data-i="${i}">
      <span class="h-entry-label${anchor}">${lbl}</span>
      <svg viewBox="0 0 16 16" fill="none" width="16" height="16">
        <circle class="h-dot-circle" cx="8" cy="8" r="${r}"/>
      </svg>
    </div>`;
    if (i < entries.length - 1)
      html += `<svg class="h-connector" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="1.5" fill="#D8D8D8"/></svg>`;
  });
  track.innerHTML = html;
  hApplyTx(hTxFor(hSelected), false);
  hAttachEntryEvents();
  hUpdateNav();
}

function hAttachEntryEvents() {
  document.querySelectorAll('.h-entry').forEach(el => {
    const i   = parseInt(el.dataset.i);
    const lbl = el.querySelector('.h-entry-label');

    el.addEventListener('mouseenter', () => {
      if (hIsDragging || i === hSelected) return;
      document.querySelectorAll('.h-entry').forEach(e => {
        if (parseInt(e.dataset.i) !== hSelected)
          e.querySelector('.h-entry-label').style.opacity = '';
      });
      lbl.style.opacity = '0.5';
    });
    el.addEventListener('mouseleave', () => {
      if (i !== hSelected) lbl.style.opacity = '';
    });
    el.addEventListener('click', () => {
      if (hDidDrag) return;
      hNavigateTo(i);
    });
  });
}

function hNavigateTo(i) {
  const nowIdx = hNowIdx();
  hSetSelected(i);
  hApplyTx(hTxFor(i), true);
  hUpdateNav();
  if (i === nowIdx) returnToNow();
  else selectSnapshot(i);
}

function hStartDrag(clientX) {
  hIsDragging   = true;
  hDidDrag      = false;
  hDragStartX   = clientX;
  hDragStartSel = hSelected;
  document.querySelectorAll('.h-entry').forEach(el => {
    if (!el.classList.contains('is-selected'))
      el.querySelector('.h-entry-label').style.opacity = '';
  });
  const track = document.getElementById('h-track');
  if (track) track.style.transition = 'none';
  const vp = document.getElementById('h-viewport');
  if (vp) vp.classList.add('dragging');
}

function hMoveDrag(clientX) {
  if (!hIsDragging) return;
  const nowIdx   = hNowIdx();
  const rawDelta = clientX - hDragStartX;
  if (Math.abs(rawDelta) > 2) hDidDrag = true;

  const maxDelta = hDragStartSel * H_STEP;
  const minDelta = (hDragStartSel - nowIdx) * H_STEP;
  const delta    = Math.max(minDelta, Math.min(maxDelta, rawDelta));

  const track = document.getElementById('h-track');
  if (track) track.style.transform = `translateX(${hTxFor(hDragStartSel) + delta}px)`;

  const newSel = Math.max(0, Math.min(nowIdx, Math.round(hDragStartSel - delta / H_STEP)));
  if (newSel === hSelected) return;

  const oldSlot = hSlotFor(hSelected, hEntries().length);
  const newSlot = hSlotFor(newSel, hEntries().length);
  hSetSelected(newSel);
  hUpdateNav();
  if (newSel === nowIdx) returnToNow();
  else selectSnapshot(newSel);

  if (oldSlot !== newSlot) {
    hDragStartX   = clientX;
    hDragStartSel = newSel;
    if (track) track.style.transform = `translateX(${hTxFor(newSel)}px)`;
  }
}

function hEndDrag() {
  if (!hIsDragging) return;
  hIsDragging = false;
  const vp = document.getElementById('h-viewport');
  if (vp) vp.classList.remove('dragging');
  hApplyTx(hTxFor(hSelected), true);
  setTimeout(() => { hDidDrag = false; }, 0);
}

function initHistoryTimeline() {
  const vp = document.getElementById('h-viewport');
  if (!vp) return;

  vp.addEventListener('mousedown',  e => hStartDrag(e.clientX));
  vp.addEventListener('touchstart', e => hStartDrag(e.touches[0].clientX), { passive: true });
  document.addEventListener('mousemove',  e => hMoveDrag(e.clientX));
  document.addEventListener('touchmove',  e => hMoveDrag(e.touches[0].clientX), { passive: true });
  document.addEventListener('mouseup',    hEndDrag);
  document.addEventListener('touchend',   hEndDrag);

  const leftBtn  = document.getElementById('h-btn-left');
  const rightBtn = document.getElementById('h-btn-right');

  if (leftBtn) leftBtn.addEventListener('click', () => {
    const newSel = Math.max(0, hSelected - 1);
    if (newSel !== hSelected) hNavigateTo(newSel);
  });

  let rightPending = false;
  let rightTimer   = null;
  if (rightBtn) {
    rightBtn.addEventListener('click', () => {
      if (rightPending) { clearTimeout(rightTimer); rightTimer = rightPending = false; return; }
      rightPending = true;
      rightTimer = setTimeout(() => {
        rightPending = rightTimer = false;
        const newSel = Math.min(hNowIdx(), hSelected + 1);
        if (newSel !== hSelected) hNavigateTo(newSel);
      }, 220);
    });
    rightBtn.addEventListener('dblclick', () => hNavigateTo(hNowIdx()));
  }
}

// ── Snapshot view / restore ───────────────────────────────────────────────────

function selectSnapshot(snapshotIdx) {
  const canvas = document.getElementById('scatter-canvas');
  if (!canvas) return;
  const snap = state.history[snapshotIdx];
  if (!snap) return;

  const rm = prefersReducedMotion();

  // Remove stale ghost cards from any previous history view
  canvas.querySelectorAll('.ghost-card').forEach(c => c.remove());

  // Freeze live positions only when entering from live view (not when switching snapshots)
  if (state.viewingIdx === null) {
    canvas.querySelectorAll('.canvas-card:not(.ghost-card)').forEach(card => {
      card.dataset.liveX = card.style.left;
      card.dataset.liveY = card.style.top;
    });
  }

  const snapMap  = {};
  snap.items.forEach(item => { snapMap[item.id] = item; });
  const liveIds  = new Set(state.tasks.map(t => t.id));

  // Snapshots hold coordinates from the canvas size they were taken on —
  // clamp them into today's canvas so old history stays visible.
  const snapRect = canvas.getBoundingClientRect();
  const snapMetrics = canvasCardMetrics(snapRect.width);
  const clampSnapX = (v) => Math.max(8, Math.min(snapRect.width - snapMetrics.cardW - 8, v));
  const clampSnapY = (v) => Math.max(8, Math.min(snapRect.height - snapMetrics.cardH - 8, v));

  // Animate live cards into historical positions (or fade out if absent)
  canvas.querySelectorAll('.canvas-card:not(.ghost-card)').forEach(card => {
    const id   = card.dataset.id;
    const item = snapMap[id];
    card.style.pointerEvents = 'none';
    if (item) {
      card.style.transition = rm ? 'none'
        : 'left 400ms cubic-bezier(0.25,0.1,0.25,1), top 400ms cubic-bezier(0.25,0.1,0.25,1), opacity 250ms ease';
      card.style.left    = clampSnapX(item.x) + 'px';
      card.style.top     = clampSnapY(item.y) + 'px';
      card.style.opacity = '1';
      card.classList.toggle('done', item.done);
    } else {
      card.style.transition = rm ? 'none' : 'opacity 250ms ease';
      card.style.opacity = '0';
    }
  });

  // Create ghost cards for deleted tasks that existed in this snapshot
  snap.items.forEach(item => {
    if (!liveIds.has(item.id)) {
      const ghost = document.createElement('div');
      ghost.className = 'canvas-card ghost-card' + (item.done ? ' done' : '');
      ghost.style.left   = clampSnapX(item.x) + 'px';
      ghost.style.top    = clampSnapY(item.y) + 'px';
      ghost.style.opacity = '0';
      ghost.innerHTML = `<span class="card-text">${escapeHtml(item.text)}</span>`;
      canvas.appendChild(ghost);
      requestAnimationFrame(() => {
        ghost.style.transition = rm ? 'none' : 'opacity 300ms ease';
        ghost.style.opacity    = item.done ? '0.25' : '0.45';
      });
    }
  });

  canvas.classList.add('history-view');
  state.viewingIdx = snapshotIdx;
}

function returnToNow() {
  const canvas = document.getElementById('scatter-canvas');
  if (!canvas) return;
  const rm = prefersReducedMotion();

  // Fade out and remove ghost cards
  canvas.querySelectorAll('.ghost-card').forEach(card => {
    card.style.transition = rm ? 'none' : 'opacity 200ms ease';
    card.style.opacity = '0';
    setTimeout(() => card.remove(), rm ? 0 : 220);
  });

  // Restore live cards to their live positions and done states
  canvas.querySelectorAll('.canvas-card:not(.ghost-card)').forEach(card => {
    const id     = card.dataset.id;
    const isDone = state.done.has(id);
    card.classList.toggle('done', isDone);
    const liveX = card.dataset.liveX || (state.cardPositions[id] ? state.cardPositions[id].x + 'px' : card.style.left);
    const liveY = card.dataset.liveY || (state.cardPositions[id] ? state.cardPositions[id].y + 'px' : card.style.top);
    card.style.transition = rm ? 'none'
      : 'left 400ms cubic-bezier(0.25,0.1,0.25,1), top 400ms cubic-bezier(0.25,0.1,0.25,1), opacity 250ms ease';
    card.style.left    = liveX;
    card.style.top     = liveY;
    card.style.opacity = '1';
    card.style.pointerEvents = '';
    delete card.dataset.liveX;
    delete card.dataset.liveY;
    if (!rm) setTimeout(() => { card.style.transition = ''; }, 420);
  });

  canvas.classList.remove('history-view');
  state.viewingIdx = null;
}

// ──────────────────────────────────────────────────────────────────────────────
// Sharing — publish this board as a link / render someone else's shared map.
// The generic plumbing (Supabase calls, dialog, banner) lives in ../share.js;
// this section is the app-specific glue.
// ──────────────────────────────────────────────────────────────────────────────

const SHARE_MAP_KIND = 'impact-effort';

function serializeBoardForShare() {
  const canvas = document.getElementById('scatter-canvas');
  const rect = canvas ? canvas.getBoundingClientRect() : { width: 0, height: 0 };
  // Prefer live card positions (mid-drag DOM state) over saved ones,
  // mirroring how doCleanup snapshots the canvas.
  const positions = {};
  state.tasks.forEach(t => {
    const card = canvas && canvas.querySelector(`.canvas-card[data-id="${t.id}"]`);
    if (card && card.style.left) {
      positions[t.id] = { x: parseFloat(card.style.left) || 0, y: parseFloat(card.style.top) || 0 };
    } else if (state.cardPositions[t.id]) {
      positions[t.id] = state.cardPositions[t.id];
    }
  });
  return {
    version: 1,
    tasks: state.tasks.map(t => Object.assign({}, t)),
    cardPositions: positions,
    done: [...state.done],
    canvas: { w: Math.round(rect.width), h: Math.round(rect.height) },
  };
}

// Published positions are absolute px on the owner's canvas; scale them to
// this device's canvas so the map keeps its shape on any screen.
//
// The clamp bounds below must match the real card footprint from
// canvasCardMetrics() — that's what forceNudge/computeCanvasPositions use to
// keep cards on-canvas everywhere else. This used to hardcode a much smaller
// card (140x40, 12px edge) than the actual rendered card (200x44, up to 64px
// edgePad); on a resize that shrank the canvas, that let clamped positions
// land well past the true safe area, so the real card spilled out under
// .scatter-canvas's overflow:hidden and was clipped, partly invisible.
function scaleSharedPositions(positions, sourceCanvas, targetW, targetH) {
  const scaled = {};
  const sw = sourceCanvas && sourceCanvas.w > 0 ? sourceCanvas.w : targetW;
  const sh = sourceCanvas && sourceCanvas.h > 0 ? sourceCanvas.h : targetH;
  const { cardW: CARD_W, cardH: CARD_H, edgePad: EDGE } = canvasCardMetrics(targetW);
  Object.keys(positions).forEach(id => {
    const p = positions[id];
    if (!p) return;
    if (!isFinite(p.x) || !isFinite(p.y)) return; // junk coords → recompute path
    let x = (p.x / sw) * targetW;
    let y = (p.y / sh) * targetH;
    x = Math.min(Math.max(x, EDGE), Math.max(EDGE, targetW - CARD_W - EDGE));
    y = Math.min(Math.max(y, EDGE), Math.max(EDGE, targetH - CARD_H - EDGE));
    scaled[id] = { x, y };
  });
  return scaled;
}

// Promote the current sandbox copy (with the viewer's edits) to a map of
// their own in the maps index, and open it there.
function copySandboxToBoard() {
  const payload = {
    tasks: state.tasks,
    impactOrder: [],
    effortOrder: [],
    phase: 'scatter',
    cardPositions: state.cardPositions,
    done: [...state.done],
    idCounter: idCounter,
    history: state.history,
  };
  if (lastCanvasDims) payload.canvas = lastCanvasDims;
  const newId = window.TodoMapsIndex
    ? TodoMapsIndex.create({ kind: SHARE_MAP_KIND, name: 'copied map', data: payload })
    : null;
  if (newId === null) {
    alert('Could not save the copy — browser storage is unavailable.');
    return;
  }
  location.href = location.pathname + '?map=' + encodeURIComponent(newId);
}

// A share link opens as a sandbox: a fully editable copy of the published
// map, persisted per-link in this browser only (activeLsKey points at it).
// The owner's published map is never written to from here.
async function bootSharedView(mapId) {
  window.SHARED_VIEW_ACTIVE = true;
  document.body.classList.add('shared-view');
  activeLsKey = 'todomap-sandbox-' + mapId;
  showPhase('scatter');
  TodoMapShare.showLoading();

  let haveSandbox = false;
  try { haveSandbox = !!localStorage.getItem(activeLsKey); } catch (e) { /* storage unavailable */ }

  let record = null;
  let fetchErr = null;
  try {
    record = await TodoMapShare.fetchMap(mapId);
  } catch (err) {
    fetchErr = err;
  }
  TodoMapShare.hideLoading();

  if (record && record.map_kind !== SHARE_MAP_KIND) {
    // An urgency/importance link opened on this page — hand it to the main map
    location.replace('../#m=' + mapId);
    return;
  }
  if (!record && !haveSandbox) {
    if (fetchErr) {
      TodoMapShare.renderShareError({
        title: 'Couldn’t load this shared map',
        message: fetchErr.message,
      });
    } else {
      TodoMapShare.renderShareError({
        title: 'This map is no longer shared',
        message: 'The link may have been turned off by its owner.',
      });
    }
    return;
  }

  // Wire up the normal map-screen machinery (dump/sort screens stay locked)
  initToolbar();
  initExportImport();
  initCanvasAdd();
  initCornerPopovers();
  initInteractionHints();
  initHistoryTimeline();
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', () => {
      const keyboardOpen = window.visualViewport.height < window.innerHeight * 0.75;
      document.body.classList.toggle('keyboard-open', keyboardOpen);
    });
  }

  function renderScatter() {
    document.fonts.ready.then(() => {
      const canvas = document.getElementById('scatter-canvas');
      const rect = canvas.getBoundingClientRect();
      if (rect.width === 0) return;
      if (state.tasks.some(t => !state.cardPositions[t.id])) {
        state.cardPositions = computeCanvasPositions(rect.width, rect.height);
      }
      // A returning sandbox may have been laid out on a different window size
      reflowCanvasPositions();
      buildCanvasCards(prefersReducedMotion());
      canvas.querySelectorAll('.canvas-card').forEach(c => { c.style.opacity = '1'; });
      drawQuadrantLines(prefersReducedMotion());
      buildHistoryTimeline();
      updateEmptyState();
      announce('Viewing a shared map. This is your own editable copy.');
    });
  }

  // Build a fresh sandbox from the published version
  function seedFromRecord() {
    const data = record.data || {};
    // Trust nothing about a remote payload's shape: ids must be plain tokens
    // (they get interpolated into querySelector strings) and text a string.
    // Every live editor caps task text at 500 chars (see parseGridFile's cap
    // on the same class of untrusted-payload text); a share record isn't
    // written by this browser's own editors, so cap it here too — otherwise
    // a card renders far taller than the canvas, clipped by its overflow.
    state.tasks = (Array.isArray(data.tasks) ? data.tasks : []).filter(t =>
      t && typeof t.id === 'string' && /^[\w-]+$/.test(t.id) && typeof t.text === 'string')
      .map(t => ({ id: t.id, text: t.text.slice(0, 500) }));
    // done ids get the same treatment idList() gives them on file import:
    // filtered down to real task ids, so a dangling or unsafe id in the
    // payload can't reach doCleanup()'s querySelector interpolation.
    const liveIds = new Set(state.tasks.map(t => t.id));
    state.done = new Set(Array.isArray(data.done) ? data.done.filter(id => liveIds.has(id)) : []);
    state.impactOrder = [];
    state.effortOrder = [];
    state.history = [];
    state.viewingIdx = null;
    state.phase = 'scatter';
    let maxId = 0;
    state.tasks.forEach(t => {
      const m = /^t(\d+)$/.exec(t.id || '');
      if (m) maxId = Math.max(maxId, parseInt(m[1], 10));
    });
    idCounter = maxId;
    sandboxMeta = { basedOnUpdatedAt: record.updated_at || null };
    document.fonts.ready.then(() => {
      const canvas = document.getElementById('scatter-canvas');
      const rect = canvas.getBoundingClientRect();
      state.cardPositions = scaleSharedPositions(data.cardPositions || {}, data.canvas, rect.width, rect.height);
      saveState();
    });
    renderScatter();
  }

  // Discard the local copy and reboot from the published version
  function resetSandbox() {
    try { localStorage.removeItem(activeLsKey); } catch (e) { /* storage unavailable */ }
    location.reload();
  }

  if (haveSandbox && loadSavedState()) {
    state.phase = 'scatter'; // sandboxes only ever live on the map screen
    renderScatter();
    // The owner published a newer version since this copy was made
    if (record && record.updated_at && sandboxMeta && sandboxMeta.basedOnUpdatedAt &&
        new Date(record.updated_at) > new Date(sandboxMeta.basedOnUpdatedAt)) {
      TodoMapShare.showUpdateNotice({
        updatedAt: record.updated_at,
        onLoadNewest: resetSandbox,
      });
    }
  } else if (record) {
    seedFromRecord();
  } else {
    TodoMapShare.renderShareError({
      title: 'Couldn’t load this shared map',
      message: fetchErr ? fetchErr.message : 'Please try again.',
    });
    return;
  }

  TodoMapShare.renderSharedChrome({
    record: record || { data: {}, updated_at: null },
    getState: () => ({ tasks: state.tasks, done: state.done }),
    onCopyToBoard: copySandboxToBoard,
    onReset: resetSandbox,
  });
}

// ?map= pointed at a map this browser doesn't know — a deleted map, someone
// else's link, or a bookmark from another profile. Never open the editor on
// it: everything typed would save into a slot no screen can ever reach.
function renderMapNotFound() {
  window.MAP_VIEW_HALTED = true;
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
  const overlay = document.createElement('div');
  overlay.className = 'share-error-overlay';
  const h = document.createElement('h2');
  h.textContent = 'map not found';
  const p = document.createElement('p');
  p.textContent = 'this map isn’t saved in this browser.';
  const link = document.createElement('a');
  link.href = '../home/';
  link.textContent = 'back to your maps →';
  overlay.appendChild(h);
  overlay.appendChild(p);
  overlay.appendChild(link);
  if (window.TodoMapsCloud && TodoMapsCloud.enabled) {
    const hint = document.createElement('p');
    hint.textContent = 'signed-in maps may still be syncing';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = 'check again';
    btn.style.cssText = 'margin-top:4px;padding:8px 18px;border:1px solid rgba(82,99,71,0.25);border-radius:8px;background:none;font-family:inherit;font-size:13px;color:var(--sage,#526347);cursor:pointer;';
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try { await TodoMapsCloud.syncNow(); } catch (e) { /* stays not-found */ }
      if (TodoMapsIndex.get(MAP_URL_ID)) { location.reload(); return; }
      btn.textContent = 'still not here';
    });
    overlay.appendChild(hint);
    overlay.appendChild(btn);
  }
  document.body.appendChild(overlay);
}

// ──────────────────────────────────────────────────────────────────────────────
// Boot
// ──────────────────────────────────────────────────────────────────────────────

function init() {
  // Shared-view mode: someone opened a share link — render it read-only
  // and skip all owner-side setup (their own board stays untouched).
  if (window.TodoMapShare && TodoMapShare.sharedMapId) {
    bootSharedView(TodoMapShare.sharedMapId);
    return;
  }
  // Owner mode always rides on ?map=. The head bounce catches bare visits;
  // this covers what it can't see, like a hash share.js refused to parse.
  if (!MAP_URL_ID) {
    location.replace('../home/');
    return;
  }
  if (window.TodoMapsIndex) {
    const entry = TodoMapsIndex.get(MAP_URL_ID);
    // An urgency/importance map opened on this page — hand it to the main
    // editor before anything touches its slot.
    if (entry && entry.kind !== 'impact-effort') {
      location.replace('../?map=' + encodeURIComponent(MAP_URL_ID));
      return;
    }
    if (!entry) {
      renderMapNotFound();
      return;
    }
    // The tab title carries the map name, so several open maps are tellable
    // apart in the tab strip.
    document.title = entry.name + ' · To-Do Map';
  }

  initSort();
  initToolbar();
  initExportImport();
  if (window.TodoMapShare) {
    TodoMapShare.initShareUI({
      kind: SHARE_MAP_KIND,
      serialize: serializeBoardForShare,
      // Share records live on this map's index entry — one link per map.
      getShare: () => {
        const entry = window.TodoMapsIndex ? TodoMapsIndex.get(MAP_URL_ID) : null;
        return (entry && entry.share) || null;
      },
      setShare: (rec) => { if (window.TodoMapsIndex) TodoMapsIndex.setShare(MAP_URL_ID, rec); },
      clearShare: () => { if (window.TodoMapsIndex) TodoMapsIndex.setShare(MAP_URL_ID, null); },
    });
  }
  initExistingTasksLine();
  initCanvasAdd();
  initDump();
  initSortTips();
  initMapGuide();
  initInteractionHints();
  initCornerPopovers();
  initPageScroll();
  initHistoryTimeline();

  const savedPhase = loadSavedState();

  if (savedPhase && savedPhase !== 'dump') {
    if (savedPhase === 'scatter') {
      showPhase('scatter');
      document.fonts.ready.then(() => {
        const canvas = document.getElementById('scatter-canvas');
        const canvasRect = canvas.getBoundingClientRect();
        if (canvasRect.width > 0) {
          if (state.tasks.some(t => !state.cardPositions[t.id])) {
            state.cardPositions = computeCanvasPositions(canvasRect.width, canvasRect.height);
            state.scatterSig = rankingSignature();
          }
          // The window (or device orientation) may have changed since the
          // last visit — pull stranded cards back inside before rendering.
          reflowCanvasPositions();
          buildCanvasCards(prefersReducedMotion());
          canvas.querySelectorAll('.canvas-card').forEach(c => { c.style.opacity = '1'; });
          drawQuadrantLines(prefersReducedMotion());
          buildHistoryTimeline();
          updateEmptyState();
          announce('Restored previous session. Click any task to mark it done.');
        }
      });
    } else if (savedPhase === 'sort-impact') {
      renderSortList('impact');
      showPhase('sort-impact');
      announce('Restored impact sorting session.');
    } else if (savedPhase === 'sort-effort') {
      renderSortList('impact');
      renderSortList('effort');
      showPhase('sort-effort');
      announce('Restored effort sorting session.');
    }
  } else {
    // Dump phase — show fresh if returning with existing tasks
    if (state.tasks.length > 0) {
      showDumpFresh();
      document.getElementById('phase-dump').classList.add('has-tasks');
    }
    showPhase('dump');
    // Don't auto-focus — let the typewriter animation play
  }

  // Detect virtual keyboard on mobile
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', () => {
      const keyboardOpen = window.visualViewport.height < window.innerHeight * 0.75;
      document.body.classList.toggle('keyboard-open', keyboardOpen);
    });
  }

  // Request persistent storage so browsers are less likely to evict data
  if (navigator.storage && navigator.storage.persist) {
    navigator.storage.persist();
  }

  // One safe pull on boot: adopt the server copy only when it is strictly
  // newer AND nothing has been edited here yet this session. A user already
  // typing keeps today's behavior — their edits win by last-write.
  if (window.TodoMapsCloud && TodoMapsCloud.enabled && window.TodoMapsIndex) {
    TodoMapsCloud.pullMap(MAP_URL_ID).then((row) => {
      if (!row || dirtySinceBoot) return;
      const local = TodoMapsIndex.get(MAP_URL_ID);
      if (!local || row.map_kind !== local.kind) return;
      const serverMs = Date.parse(row.updated_at) || 0;
      if (serverMs <= (local.updatedAt || 0) + 2000) return; // same skew window as sync
      // The server row's `data` carries none of the shape/length guards this
      // page's own writers enforce (see sanitizeGridData's comment in
      // maps-index.js) — sanitize before it's written and immediately
      // rendered below.
      if (!TodoMapsIndex.writeData(MAP_URL_ID, TodoMapsIndex.sanitizeGridData(row.data, row.map_kind))) return;
      TodoMapsIndex.adopt({ ...local, name: row.name, updatedAt: serverMs }, undefined);
      loadSavedState();
      rerenderFromState();
    }).catch(() => { /* sync failures are the status line's job, not boot's */ });
  }

  // Another tab can re-home this map (a sign-in ownership conflict) or
  // delete it. Follow the forwarding note when there is one; otherwise show
  // the not-found screen instead of letting edits pile into an unreachable
  // slot.
  window.addEventListener('storage', (e) => {
    if (!MAP_URL_ID || !window.TodoMapsIndex) return;
    if (e.key !== 'todoMapsIndex.v1') return;
    if (TodoMapsIndex.get(MAP_URL_ID)) {
      // The map came back (a delete undone in another tab) — resume.
      if (window.MAP_VIEW_HALTED) location.reload();
      return;
    }
    const moved = TodoMapsIndex.movedTo(MAP_URL_ID);
    if (moved) {
      location.replace('?map=' + encodeURIComponent(moved));
    } else if (!window.MAP_VIEW_HALTED) {
      renderMapNotFound();
    }
  });
}

init();

// Reflow the scatter canvas when the window changes size — registered at
// module level so shared views (which skip init's owner setup) get it too.
// The on-screen keyboard also resizes the viewport on Android; keyboard-open
// and a focused editable both skip the reflow.
let canvasReflowTimer = null;
window.addEventListener('resize', () => {
  if (state.phase !== 'scatter') return;
  if (document.body.classList.contains('keyboard-open')) return;
  const ae = document.activeElement;
  if (ae && (ae.isContentEditable || ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) return;
  clearTimeout(canvasReflowTimer);
  canvasReflowTimer = setTimeout(reflowCanvasPositions, 250);
});

// Ensure typewriter starts on fresh load after everything is initialized
document.fonts.ready.then(() => {
  if (window.SHARED_VIEW_ACTIVE || window.MAP_VIEW_HALTED) return;
  if (state.tasks.length === 0 && state.phase === 'dump') {
    const wrap = document.querySelector('.dump-input-wrap');
    if (wrap) wrap.classList.remove('has-value');
    startTypewriter();
  }
});
