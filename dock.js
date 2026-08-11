// ─────────────────────────────────────────────────────────────────────────────
// To-Do Map · map dock (design 2a)
//
// Hidden dock on the left edge of every editor opened from the home screen
// (?map=<id>). Desktop: moving the cursor to the left edge (15px hotzone)
// slides the dock over the canvas — schematic tiles for each map, active one
// ringed, quadrant glyph goes home, + creates (via home). Touch devices get a
// title chip (top-left) that drops the same list down.
//
// Self-contained: injects its own styles and DOM. Load AFTER maps-index.js.
// Feel (from the approved prototype): 420ms cubic-bezier(0.25,0.1,0.25,1),
// 15px edge trigger.
// ─────────────────────────────────────────────────────────────────────────────

(function () {
  'use strict';

  if (!/(?:\?|&)map=/.test(location.search)) return; // share views / bare visits: no dock
  var Maps = window.TodoMapsIndex;
  if (!Maps) return;

  var currentId = new URLSearchParams(location.search).get('map');
  var isIE = /\/impact-effort\//.test(location.pathname);
  var HOME_HREF = isIE ? '../home/' : 'home/';

  // Lets the editors' CSS clear the touch chip (top-left labels shift down).
  document.body.classList.add('has-map-dock');

  function hrefFor(entry) {
    var base = entry.kind === 'impact-effort' ? (isIE ? '' : 'impact-effort/') : (isIE ? '../' : '');
    return base + '?map=' + encodeURIComponent(entry.id);
  }

  var KIND_LABELS = {
    'urgency-importance': 'urgency × importance',
    'impact-effort': 'impact × effort',
  };

  // ── Styles ──────────────────────────────────────────────────────────────────

  var css = [
    '#map-dock-hotzone { position: fixed; left: 0; top: 0; bottom: 0; width: 15px; z-index: 390; background: none; border: none; padding: 0; cursor: default; }',
    '#map-dock-edge { position: fixed; left: 0; top: 0; bottom: 0; width: 2px; z-index: 389; pointer-events: none;',
    '  background: linear-gradient(to bottom, transparent, rgba(82,99,71,0.22), transparent); transition: opacity 200ms; }',
    '#map-dock { position: fixed; left: 0; top: 0; bottom: 0; width: 64px; z-index: 400;',
    '  background: #ffffff; box-shadow: 0 8px 24px rgba(46,52,45,0.16);',
    '  display: flex; flex-direction: column; align-items: center; padding: 16px 0; gap: 12px;',
    '  transform: translateX(-76px); transition: transform 420ms cubic-bezier(0.25, 0.1, 0.25, 1); }',
    '#map-dock.open { transform: translateX(0); }',
    '@media (prefers-reduced-motion: reduce) { #map-dock { transition: none; } }',
    '.dock-home { width: 36px; height: 36px; border-radius: 8px; border: none; background: none; cursor: pointer;',
    '  display: grid; grid-template-columns: 8px 8px; grid-template-rows: 8px 8px; gap: 4px; place-content: center; margin-bottom: 6px; }',
    '.dock-home:hover { background: rgba(82,99,71,0.08); }',
    '.dock-home span { border-radius: 50%; background: rgba(82,99,71,0.35); }',
    '.dock-home span:first-child { background: #526347; }',
    '.dock-divider { width: 24px; height: 1px; background: rgba(82,99,71,0.15); flex-shrink: 0; }',
    '.dock-tiles { display: flex; flex-direction: column; gap: 12px; overflow-y: auto; scrollbar-width: none; }',
    '.dock-tiles::-webkit-scrollbar { display: none; }',
    '.dock-tile { position: relative; width: 40px; height: 40px; border-radius: 8px; background: #ffffff; flex-shrink: 0;',
    '  box-shadow: 0 1px 4px rgba(46,52,45,0.05); opacity: 0.75; display: block; transition: box-shadow 150ms, opacity 150ms; }',
    '.dock-tile:hover { opacity: 1; }',
    '.dock-tile.active { opacity: 1; box-shadow: 0 1px 4px rgba(46,52,45,0.05), 0 0 0 1.5px #526347; }',
    '.dock-tile .dt-v { position: absolute; left: 50%; top: 22%; bottom: 22%; width: 1px; background: rgba(82,99,71,0.2); }',
    '.dock-tile .dt-h { position: absolute; top: 50%; left: 14%; right: 14%; height: 1px; background: rgba(82,99,71,0.2); }',
    '.dock-tile .dt-dot { position: absolute; width: 10px; height: 4px; border-radius: 2px; background: #fafaf5; box-shadow: 0 1px 2px rgba(46,52,45,0.2); }',
    '.dock-tile .dt-dot.done { opacity: 0.5; }',
    '.dock-new { width: 40px; height: 40px; border-radius: 8px; border: 1px dashed rgba(82,99,71,0.25); background: none;',
    '  display: grid; place-items: center; color: rgba(82,99,71,0.55); font-size: 16px; font-weight: 300; cursor: pointer; margin-top: auto; flex-shrink: 0; }',
    '.dock-new:hover { border-color: rgba(82,99,71,0.55); color: #526347; }',
    '#map-dock-tip { position: fixed; z-index: 410; background: #ffffff; border-radius: 999px; box-shadow: 0 8px 24px rgba(46,52,45,0.16);',
    '  padding: 5px 12px; font-family: var(--font-body, sans-serif); font-size: 12px; white-space: nowrap; color: #2e342d; pointer-events: none; display: none; }',
    '#map-dock-tip .dt-count { color: rgba(46,52,45,0.3); }',
    '#map-dock-chip { display: none; position: fixed; top: 12px; left: 12px; z-index: 400; background: #ffffff; border: none;',
    '  border-radius: 999px; box-shadow: 0 2px 8px rgba(46,52,45,0.12); padding: 8px 14px;',
    '  font-family: var(--font-body, sans-serif); font-size: 13px; font-weight: 500; color: #2e342d; cursor: pointer;',
    '  max-width: 60vw; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
    '#map-dock-chip .chip-caret { color: rgba(82,99,71,0.55); font-size: 10px; margin-left: 6px; }',
    '#map-dock-sheet { display: none; position: fixed; top: 52px; left: 12px; z-index: 401; width: min(260px, calc(100vw - 24px));',
    '  background: #ffffff; border-radius: 12px; box-shadow: 0 8px 24px rgba(46,52,45,0.16); padding: 6px; flex-direction: column; }',
    '#map-dock-sheet.open { display: flex; }',
    '.dock-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 10px; border-radius: 8px;',
    '  border: none; background: none; font-family: var(--font-body, sans-serif); font-size: 13px; color: #2e342d; cursor: pointer; text-align: left; text-decoration: none; }',
    '.dock-row.active { background: rgba(82,99,71,0.08); font-weight: 500; color: #526347; }',
    '.dock-row .dr-count { font-family: var(--font-display, sans-serif); font-size: 11px; color: rgba(46,52,45,0.3); }',
    '.dock-row.dock-all { color: rgba(82,99,71,0.82); }',
    '.dock-sheet-divider { height: 1px; background: rgba(82,99,71,0.15); margin: 4px 8px; }',
    '@media (pointer: coarse) {',
    '  #map-dock, #map-dock-hotzone, #map-dock-edge, #map-dock-tip { display: none; }',
    '  #map-dock-chip { display: block; }',
    '}',
  ].join('\n');

  var styleEl = document.createElement('style');
  styleEl.textContent = css;
  document.head.appendChild(styleEl);

  // ── Thumb dots (same scheme as the home cards) ──────────────────────────────

  function seededRand(seedStr) {
    var x = 0;
    for (var i = 0; i < seedStr.length; i++) x = (x * 31 + seedStr.charCodeAt(i)) >>> 0;
    x = x || 1;
    return function () { x = (x * 9301 + 49297) % 233280; return x / 233280; };
  }
  var clamp = function (v, lo, hi) { return Math.min(Math.max(v, lo), hi); };

  function tileDots(entry, data) {
    var tasks = (data && Array.isArray(data.tasks)) ? data.tasks : [];
    var done = new Set((data && data.done) || []);
    var positions = (data && data.cardPositions) || {};
    var cv = data && data.canvas;
    var hasCanvas = cv && cv.w > 0 && cv.h > 0;
    var rand = seededRand(entry.id);
    var frag = document.createDocumentFragment();
    tasks.slice(0, 4).forEach(function (t) {
      var dot = document.createElement('div');
      dot.className = 'dt-dot' + (done.has(t.id) ? ' done' : '');
      var p = positions[t.id], x, y;
      if (hasCanvas && p) {
        x = clamp(((p.x + 70) / cv.w) * 100, 12, 64);
        y = clamp(((p.y + 20) / cv.h) * 100, 18, 68);
      } else {
        x = 14 + rand() * 50;
        y = 20 + rand() * 48;
      }
      dot.style.left = x + '%';
      dot.style.top = y + '%';
      frag.appendChild(dot);
    });
    return frag;
  }

  function countLabel(data) {
    var tasks = (data && Array.isArray(data.tasks)) ? data.tasks : [];
    var done = new Set((data && data.done) || []);
    var doneCount = tasks.filter(function (t) { return done.has(t.id); }).length;
    return doneCount + '/' + tasks.length;
  }

  // ── DOM ─────────────────────────────────────────────────────────────────────

  var entries = Maps.list().slice().sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); });
  var current = entries.filter(function (e) { return e.id === currentId; })[0] || null;

  var edge = document.createElement('div');
  edge.id = 'map-dock-edge';

  var hotzone = document.createElement('button');
  hotzone.id = 'map-dock-hotzone';
  hotzone.type = 'button';
  hotzone.setAttribute('aria-label', 'open map dock');

  var dock = document.createElement('nav');
  dock.id = 'map-dock';
  dock.setAttribute('aria-label', 'your maps');

  var tip = document.createElement('div');
  tip.id = 'map-dock-tip';

  var homeBtn = document.createElement('button');
  homeBtn.className = 'dock-home';
  homeBtn.type = 'button';
  homeBtn.setAttribute('aria-label', 'all maps');
  homeBtn.title = 'all maps';
  for (var i = 0; i < 4; i++) homeBtn.appendChild(document.createElement('span'));
  homeBtn.addEventListener('click', function () { location.href = HOME_HREF; });
  dock.appendChild(homeBtn);

  var divider = document.createElement('div');
  divider.className = 'dock-divider';
  dock.appendChild(divider);

  var tiles = document.createElement('div');
  tiles.className = 'dock-tiles';
  entries.forEach(function (entry) {
    var data = Maps.readData(entry.id);
    var a = document.createElement('a');
    a.className = 'dock-tile' + (entry.id === currentId ? ' active' : '');
    a.href = hrefFor(entry);
    a.setAttribute('aria-label', entry.name + ' — ' + (KIND_LABELS[entry.kind] || entry.kind));
    if (entry.id === currentId) a.setAttribute('aria-current', 'page');
    var v = document.createElement('div'); v.className = 'dt-v';
    var h = document.createElement('div'); h.className = 'dt-h';
    a.appendChild(v); a.appendChild(h);
    a.appendChild(tileDots(entry, data));
    a.addEventListener('mouseenter', function () {
      var r = a.getBoundingClientRect();
      tip.innerHTML = '';
      tip.appendChild(document.createTextNode(entry.name + ' '));
      var c = document.createElement('span');
      c.className = 'dt-count';
      c.textContent = '· ' + countLabel(data);
      tip.appendChild(c);
      tip.style.left = (r.right + 12) + 'px';
      tip.style.top = (r.top + r.height / 2) + 'px';
      tip.style.transform = 'translateY(-50%)';
      tip.style.display = 'block';
    });
    a.addEventListener('mouseleave', function () { tip.style.display = 'none'; });
    tiles.appendChild(a);
  });
  dock.appendChild(tiles);

  var newBtn = document.createElement('button');
  newBtn.className = 'dock-new';
  newBtn.type = 'button';
  newBtn.setAttribute('aria-label', 'new map');
  newBtn.title = 'new map';
  newBtn.textContent = '+';
  newBtn.addEventListener('click', function () { location.href = HOME_HREF; });
  dock.appendChild(newBtn);

  // ── Open/close (desktop) ────────────────────────────────────────────────────

  function open() { dock.classList.add('open'); edge.style.opacity = '0'; }
  function close() { dock.classList.remove('open'); edge.style.opacity = '1'; tip.style.display = 'none'; }

  hotzone.addEventListener('mouseenter', open);
  hotzone.addEventListener('focus', open);
  dock.addEventListener('mouseleave', close);
  dock.addEventListener('focusout', function (e) {
    if (!dock.contains(e.relatedTarget) && e.relatedTarget !== hotzone) close();
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && dock.classList.contains('open')) close();
  });

  // ── Touch: title chip + dropdown ────────────────────────────────────────────

  var chip = document.createElement('button');
  chip.id = 'map-dock-chip';
  chip.type = 'button';
  chip.setAttribute('aria-haspopup', 'menu');
  chip.innerHTML = '';
  chip.appendChild(document.createTextNode(current ? current.name : 'maps'));
  var caret = document.createElement('span');
  caret.className = 'chip-caret';
  caret.textContent = '▾';
  chip.appendChild(caret);

  var sheet = document.createElement('div');
  sheet.id = 'map-dock-sheet';
  sheet.setAttribute('role', 'menu');
  entries.forEach(function (entry) {
    var row = document.createElement('a');
    row.className = 'dock-row' + (entry.id === currentId ? ' active' : '');
    row.href = hrefFor(entry);
    row.setAttribute('role', 'menuitem');
    var name = document.createElement('span');
    name.textContent = entry.name;
    var count = document.createElement('span');
    count.className = 'dr-count';
    count.textContent = countLabel(Maps.readData(entry.id));
    row.appendChild(name); row.appendChild(count);
    sheet.appendChild(row);
  });
  var sheetDivider = document.createElement('div');
  sheetDivider.className = 'dock-sheet-divider';
  sheet.appendChild(sheetDivider);
  var allRow = document.createElement('a');
  allRow.className = 'dock-row dock-all';
  allRow.href = HOME_HREF;
  allRow.setAttribute('role', 'menuitem');
  allRow.textContent = 'all maps';
  sheet.appendChild(allRow);

  chip.addEventListener('click', function (e) {
    e.stopPropagation();
    sheet.classList.toggle('open');
  });
  document.addEventListener('click', function () { sheet.classList.remove('open'); });

  document.body.appendChild(edge);
  document.body.appendChild(hotzone);
  document.body.appendChild(dock);
  document.body.appendChild(tip);
  document.body.appendChild(chip);
  document.body.appendChild(sheet);
})();
