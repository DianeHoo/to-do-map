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

    if (idx < targetIdx) {
      el.classList.add('phase-completed'); // slides up and out
      el.setAttribute('aria-hidden', 'true');
    } else if (idx === targetIdx) {
      el.classList.add('phase-active'); // slides into view
      el.scrollTop = 0;
      el.removeAttribute('aria-hidden');
    } else {
      el.classList.add('phase-pending'); // stays below
      el.setAttribute('aria-hidden', 'true');
    }
  });

  state.phase = targetPhase;

  const toolbar = document.getElementById('canvas-toolbar');
  if (toolbar) toolbar.classList.toggle('visible', targetPhase === 'scatter');
  const utilWrap = document.getElementById('canvas-util-wrap');
  if (utilWrap) utilWrap.classList.toggle('visible', targetPhase === 'scatter');
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
      announce('8 tasks added. Drag to reorder or add your own.');
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
    if (suggestBtn) { suggestBtn.style.opacity = ''; suggestBtn.style.pointerEvents = ''; }
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
    if (suggestBtn) { suggestBtn.style.opacity = '0'; suggestBtn.style.pointerEvents = 'none'; }
    if (inputWrap) inputWrap.classList.add('has-value');
    stopTypewriter();
  } else {
    if (suggestBtn) { suggestBtn.style.opacity = ''; suggestBtn.style.pointerEvents = ''; }
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
  if (suggestBtn) { suggestBtn.style.opacity = '0'; suggestBtn.style.pointerEvents = 'none'; }
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
    label.textContent = `sort all ${state.tasks.length} tasks`;
  } else {
    label.textContent = 'ready to sort';
  }
}

function transitionToSortImpact() {
  oldTaskIds.clear();
  hiddenTaskIds.clear();
  document.getElementById('existing-tasks-line').style.display = 'none';
  // Preserve existing order if it has all task IDs (e.g. from sample tasks)
  const taskIds = new Set(state.tasks.map(t => t.id));
  const impactValid = state.impactOrder.length === state.tasks.length &&
    state.impactOrder.every(id => taskIds.has(id));
  if (!impactValid) {
    state.impactOrder = state.tasks.map(t => t.id);
  }
  const effortValid = state.effortOrder.length === state.tasks.length &&
    state.effortOrder.every(id => taskIds.has(id));
  if (!effortValid) {
    state.effortOrder = [...state.impactOrder];
  }
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

function enterSortCardEdit(card, pass) {
  if (card.querySelector('.sort-edit-input')) return;
  const textEl = card.querySelector('.card-text');
  if (textEl.getAttribute('contenteditable') === 'true') return;
  const originalText = textEl.textContent;
  const taskId = card.dataset.id;

  textEl.setAttribute('contenteditable', 'true');
  textEl.style.outline = 'none';
  textEl.focus();

  // Place cursor at end
  const range = document.createRange();
  range.selectNodeContents(textEl);
  range.collapse(false);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);

  function save() {
    textEl.setAttribute('contenteditable', 'false');
    const plainText = textEl.textContent.trim() || originalText;
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
  // Preserve existing effort order if it has all task IDs (e.g. from sample tasks)
  const taskIds = new Set(state.tasks.map(t => t.id));
  const effortValid = state.effortOrder.length === state.tasks.length &&
    state.effortOrder.every(id => taskIds.has(id));
  if (!effortValid) {
    state.effortOrder = [...state.impactOrder]; // carry over as starting order
  }
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

function computeCanvasPositions(canvasW, canvasH) {
  const n = state.tasks.length;
  if (n === 0) return {};

  const EDGE_PAD = 64; // keep cards away from edge labels and canvas border
  const MIN_GAP = 32;

  const usableW = canvasW - EDGE_PAD * 2;
  const usableH = canvasH - EDGE_PAD * 2;

  const positions = {};

  state.tasks.forEach(task => {
    const impactRank = state.impactOrder.indexOf(task.id);
    const effortRank = state.effortOrder.indexOf(task.id);

    const impactNorm = n > 1 ? impactRank / (n - 1) : 0.5;
    const effortNorm = n > 1 ? effortRank / (n - 1) : 0.5;

    // X axis = effort (rank 0 = most effort → right). Y axis = impact (rank 0 = most impact → top).
    const x = EDGE_PAD + (1 - effortNorm) * usableW;
    const y = EDGE_PAD + impactNorm * usableH;

    positions[task.id] = { x, y };
  });

  return forceNudge(positions, canvasW, canvasH, EDGE_PAD, MIN_GAP);
}

function forceNudge(positions, canvasW, canvasH, edgePad, minGap) {
  const CARD_W = 140;
  const CARD_H = 36;
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

    state.cardPositions = computeCanvasPositions(canvasW, canvasH);
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
        const html = textEl.innerHTML;
        const plainText = textEl.textContent.trim() || originalText;
        if (plainText !== originalText) {
          const t = state.tasks.find(t => t.id === taskId);
          if (t) t.text = plainText;
        }
        const cleaned = html.replace(/<div>/gi, '<br>').replace(/<\/div>/gi, '').replace(/<p>/gi, '<br>').replace(/<\/p>/gi, '').replace(/^<br>/, '').trim();
        textEl.innerHTML = cleaned || escapeHtml(originalText);
        card.setAttribute('aria-label', `${plainText} — click to toggle done`);
        requestAnimationFrame(() => requestAnimationFrame(() => updateStrikePath(card)));
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
      if (now - lastTapTime < 300) {
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

  // If dimensions are 0, the card hasn't laid out yet — retry
  if (!w || w < 2 || !h || h < 2) {
    setTimeout(() => updateStrikePath(card), 100);
    return;
  }

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

function addTaskToCanvas(text) {
  const task = { id: makeId(), text };
  state.tasks.push(task);

  const canvas = document.getElementById('scatter-canvas');
  const canvasRect = canvas.getBoundingClientRect();
  const x = canvasRect.width / 2 - 60;
  const y = canvasRect.height / 2 - 18;
  state.cardPositions[task.id] = { x, y };

  state.impactOrder.push(task.id);
  state.effortOrder.push(task.id);

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
      const html = textEl.innerHTML;
      const plainText = textEl.textContent.trim() || originalText;
      if (plainText !== originalText) {
        const t = state.tasks.find(t => t.id === taskId);
        if (t) t.text = plainText;
      }
      const cleaned = html.replace(/<div>/gi, '<br>').replace(/<\/div>/gi, '').replace(/<p>/gi, '<br>').replace(/<\/p>/gi, '').replace(/^<br>/, '').trim();
      textEl.innerHTML = cleaned || escapeHtml(originalText);
      card.setAttribute('aria-label', `${plainText} — click to toggle done`);
      requestAnimationFrame(() => requestAnimationFrame(() => updateStrikePath(card)));
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
    if (now - lastTapTime < 300) {
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

const LS_KEY = 'eisenhower-matrix-state';

function saveState() {
  try {
    const serializable = {
      tasks: state.tasks,
      impactOrder: state.impactOrder,
      effortOrder: state.effortOrder,
      phase: state.phase,
      cardPositions: state.cardPositions,
      done: [...state.done],
      idCounter: idCounter,
      history: state.history,
    };
    localStorage.setItem(LS_KEY, JSON.stringify(serializable));
  } catch(e) { /* storage full or unavailable — silent fail */ }
}

function loadSavedState() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return false;
    const saved = JSON.parse(raw);
    if (!saved || !saved.tasks || !saved.phase) return false;
    state.tasks = saved.tasks;
    state.impactOrder = saved.impactOrder || [];
    state.effortOrder = saved.effortOrder || [];
    state.phase = saved.phase;
    state.cardPositions = saved.cardPositions || {};
    state.done = new Set(saved.done || []);
    idCounter = saved.idCounter || 0;
    state.history = saved.history || [];
    state.viewingIdx = null;
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

    // Show empty state if no tasks left
    const emptyEl = document.getElementById('empty-state');
    if (emptyEl) emptyEl.classList.toggle('visible', state.tasks.length === 0);

    saveState();
    announce(`Cleaned up ${doneIds.length} completed ${doneIds.length === 1 ? 'task' : 'tasks'}.`);
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

function importGrid(file) {
  const reader = new FileReader();
  reader.onload = function(e) {
    try {
      const data = JSON.parse(e.target.result);
      if (!data.grid || !data.grid.tasks) {
        announce('Invalid file. Could not restore grid.');
        return;
      }
      const g = data.grid;
      state.tasks = g.tasks || [];
      state.impactOrder = g.impactOrder || [];
      state.effortOrder = g.effortOrder || [];
      state.phase = g.phase || 'dump';
      state.cardPositions = g.cardPositions || {};
      state.done = new Set(g.done || []);
      idCounter = g.idCounter || 0;
      state.history = g.history || [];
      state.viewingIdx = null;
      saveState();

      // Re-render from the restored phase
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
            if (Object.keys(state.cardPositions).length === 0) {
              state.cardPositions = computeCanvasPositions(rect.width, rect.height);
            }
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
      announce('Grid restored from file.');
    } catch(err) {
      announce('Could not read file. Make sure it is a valid export.');
    }
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

function initSortTips() {
  startTipRotation('sort-tip-impact', IMPACT_TIPS, 'impact');
  startTipRotation('sort-tip-effort', EFFORT_TIPS, 'effort');
}

// ──────────────────────────────────────────────────────────────────────────────
// Corner label popovers
// ──────────────────────────────────────────────────────────────────────────────

function initCornerPopovers() {
  const labels = document.querySelectorAll('.corner-label');
  const popovers = document.querySelectorAll('.corner-popover');

  labels.forEach(label => {
    label.addEventListener('click', (e) => {
      e.stopPropagation();
      // Find the matching popover (next sibling)
      const popover = label.nextElementSibling;
      if (!popover || !popover.classList.contains('corner-popover')) return;
      const isOpen = popover.classList.contains('open');
      // Close all popovers first
      popovers.forEach(p => p.classList.remove('open'));
      // Toggle the clicked one
      if (!isOpen) popover.classList.add('open');
    });
  });

  // Click outside dismisses all popovers
  document.addEventListener('click', () => {
    popovers.forEach(p => p.classList.remove('open'));
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
  const currentPhase = state.phase;
  // Gate: check if current phase is ready to advance
  if (currentPhase === 'dump' && state.tasks.length === 0) return;
  if (currentPhase === 'scatter') return; // last phase

  isTransitioning = true;

  if (currentPhase === 'dump') transitionToSortImpact();
  else if (currentPhase === 'sort-impact') onImpactDone();
  else if (currentPhase === 'sort-effort') onEffortDone();

  setTimeout(() => { isTransitioning = false; }, 450);
}

function goToPrevPhase() {
  const currentPhase = state.phase;
  if (currentPhase === 'dump') return; // first phase

  isTransitioning = true;

  if (currentPhase === 'sort-impact') {
    showDumpFresh();
    document.getElementById('phase-dump').classList.toggle('has-tasks', state.tasks.length > 0);
    showPhase('dump');
  } else if (currentPhase === 'sort-effort') {
    renderSortList('impact');
    showPhase('sort-impact');
  } else if (currentPhase === 'scatter') {
    renderSortList('effort');
    showPhase('sort-effort');
  }

  setTimeout(() => { isTransitioning = false; }, 450);
}

function initPageScroll() {
  const container = document.querySelector('.flow-container');

  // ── Wheel overscroll detection ──
  let wheelIdleTimer = null;
  let lastWheelDirection = null;
  // bouncingBack is declared globally alongside resetOverscroll

  container.addEventListener('wheel', (e) => {
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

  // Animate live cards into historical positions (or fade out if absent)
  canvas.querySelectorAll('.canvas-card:not(.ghost-card)').forEach(card => {
    const id   = card.dataset.id;
    const item = snapMap[id];
    card.style.pointerEvents = 'none';
    if (item) {
      card.style.transition = rm ? 'none'
        : 'left 400ms cubic-bezier(0.25,0.1,0.25,1), top 400ms cubic-bezier(0.25,0.1,0.25,1), opacity 250ms ease';
      card.style.left    = item.x + 'px';
      card.style.top     = item.y + 'px';
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
      ghost.style.left   = item.x + 'px';
      ghost.style.top    = item.y + 'px';
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
// Boot
// ──────────────────────────────────────────────────────────────────────────────

function init() {
  initSort();
  initToolbar();
  initExportImport();
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
          if (Object.keys(state.cardPositions).length === 0) {
            state.cardPositions = computeCanvasPositions(canvasRect.width, canvasRect.height);
          }
          buildCanvasCards(prefersReducedMotion());
          canvas.querySelectorAll('.canvas-card').forEach(c => { c.style.opacity = '1'; });
          drawQuadrantLines(prefersReducedMotion());
          buildHistoryTimeline();
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
}

init();

// Ensure typewriter starts on fresh load after everything is initialized
document.fonts.ready.then(() => {
  if (state.tasks.length === 0 && state.phase === 'dump') {
    const wrap = document.querySelector('.dump-input-wrap');
    if (wrap) wrap.classList.remove('has-value');
    startTypewriter();
  }
});
