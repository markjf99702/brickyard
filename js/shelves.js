// Shelf planner: your bookcases drawn from the front, your built sets standing on them, and a button that fits
// the rest in where they go. The logic is in js/shelf-core.js; bookcases are kept in the catalog (cases).
(function () {
  'use strict';
  var S = window.ShelfCore, C = window.BrickCore, app = window.brickyard;
  var esc = app.esc, plural = app.plural, toast = app.toast;
  var T = 1.8; // board thickness in the drawing, cm
  var PRESETS = [
    { k: 'billy', label: 'Billy', name: 'Billy', w: 76, d: 26, levels: [32, 32, 32, 32, 32, 32] },
    { k: 'billy40', label: 'Billy narrow', name: 'Billy narrow', w: 36, d: 26, levels: [32, 32, 32, 32, 32, 32] },
    { k: 'kallax', label: 'Kallax column', name: 'Kallax', w: 33, d: 37, levels: [33, 33, 33, 33] },
    { k: 'custom', label: 'My own', name: '', w: '', d: '', levels: [] },
  ];
  var COLOURS = ['#c8322b', '#1f5ba6', '#2f8a4e', '#e08a1e', '#6d4fa0', '#20817a', '#8a5a3c', '#5b6770'];
  var lastLeft = {}; // id → why it didn't fit, from the last fill
  function $(id) { return document.getElementById(id); }

  function cases() {
    var d = app.doc().cases;
    return Object.keys(d).map(function (k) { return d[k]; }).filter(function (c) { return !c.del; })
      .sort(function (a, b) { return C.natural(a.room || '', b.room || '') || C.natural(a.name, b.name) || C.natural(a.id, b.id); });
  }
  function sets() { return C.live(app.doc()); }
  function byId() { var m = {}; sets().forEach(function (x) { m[x.id] = x; }); return m; }
  function copy(c) { return JSON.parse(JSON.stringify(c)); }
  function shelfName(c, li) { return c.name + ', shelf ' + (li + 1); }
  function cm(v) { return String(v).replace(/\.0$/, ''); }
  function sizeText(z) { return cm(z.w) + ' × ' + cm(z.d) + ' × ' + cm(z.h) + ' cm'; }
  function colourOf(x) { var k = x.theme || x.name || ''; return COLOURS[parseInt(C.hash(k), 36) % COLOURS.length]; }

  // ---------- the screen ----------
  function render() {
    var all = cases(), ids = byId(), sorted = S.sort(sets(), all);
    var html = '';
    if (!all.length) {
      html += '<div class="empty"><h2>Your bookcases go here</h2><p>Add each bookcase with its shelf heights, and Brickyard fits your built sets onto them, tallest first, so you know where everything goes before you unpack.</p>' +
        '<div class="acts"><button class="btn" type="button" data-act="add-case">Add a bookcase</button></div></div>';
    } else {
      var placed = sorted.placed.length, total = placed + sorted.waiting.length + sorted.noSize.length;
      var fitting = sorted.waiting.filter(function (x) { return !S.whyNot(all, x, ids); }).length;
      html += '<p class="sumline"><span>' + plural(placed, 'set') + ' of ' + total + ' on shelves</span></p>';
      html += '<div class="acts-row">' + (fitting ? '<button class="btn" type="button" data-act="fill">Fit ' + (fitting === sorted.waiting.length ? plural(fitting, 'set') : 'the sets') + ' onto the shelves</button>' : '') +
        '<button class="btn quiet" type="button" data-act="add-case">Add a bookcase</button></div>';
      all.forEach(function (c) { html += caseHtml(c, ids); });
      if (placed) html += '<div class="how" style="margin-top:6px"><b>Happy with it?</b> <span class="note" style="display:block;margin:2px 0 8px">Copy each set’s room and shelf into My sets, so search finds it there.</span><button class="btn quiet sm" type="button" data-act="apply">Put these places in My sets</button></div>';
    }
    if (sorted.waiting.length) {
      html += '<h2 class="group"><span>Not on a shelf yet</span><span>' + sorted.waiting.length + '</span></h2><ul class="list">' + sorted.waiting.map(function (x) {
        return setRow(x, whyNot(x, all, ids));
      }).join('') + '</ul>';
    }
    if (sorted.noSize.length) {
      html += '<h2 class="group"><span>Needs a size</span><span>' + sorted.noSize.length + '</span></h2>' +
        '<p class="note">Brickyard needs each built set’s width, depth and height to fit it on a shelf. Measure them, or ask Claude: it knows the sizes LEGO gives for most sets.</p>' +
        '<div class="acts-row"><button class="btn quiet" type="button" data-act="ask-sizes">Copy these for Claude</button><button class="btn quiet" type="button" data-act="open-sizes">Open sizes from Claude</button></div>' +
        '<ul class="list">' + sorted.noSize.map(function (x) { return setRow(x, ''); }).join('') + '</ul>';
    }
    if (!sorted.placed.length && !sorted.waiting.length && !sorted.noSize.length) {
      html += '<p class="note" style="margin-top:16px">The planner places sets marked <b>Built</b> or <b>Partly built</b> in My sets. You don’t have any yet.</p>';
    }
    $('shelves-body').innerHTML = html;
  }

  function setRow(x, why) {
    var meta = x.size ? sizeText(x.size) : [C.shortNum(x.num), x.theme].filter(Boolean).join(' · ');
    return '<li><button class="item" type="button" data-set="' + esc(x.id) + '"><div class="pic none swatch" style="background:' + colourOf(x) + '"></div>' +
      '<div class="main"><div class="t">' + esc(x.name || 'Set ' + C.shortNum(x.num)) + '</div><div class="m">' + esc(meta) + '</div>' +
      (why ? '<div class="m warn">' + esc(why) + '</div>' : '') + '</div><span></span></button></li>';
  }

  // Why a waiting set isn't on a shelf: what the last fill said, or what stops it fitting now.
  function whyNot(x, all, ids) { return lastLeft[x.id] || (all.length ? S.whyNot(all, x, ids) : ''); }

  // A bookcase from the front, drawn to scale in cm.
  function caseHtml(c, ids) {
    var W = c.w + 2 * T, H = T, y = T, parts = [], over = 0;
    c.levels.forEach(function (l) { H += l.h + T; });
    parts.push('<rect x="0" y="0" width="' + W + '" height="' + H + '" rx="0.8" class="sv-frame"/>');
    c.levels.forEach(function (l, li) {
      parts.push('<rect x="' + T + '" y="' + y + '" width="' + c.w + '" height="' + l.h + '" class="sv-back" data-level="' + esc(c.id) + ':' + li + '"/>');
      var x0 = T, u = S.used(l, ids);
      if (u > c.w + 0.01) over++;
      l.sets.forEach(function (p) {
        var x = ids[p.id]; if (!x || !S.hasSize(x)) return;
        var f = S.footprint(x, p.turn), top = y + l.h - f.h, col = colourOf(x);
        parts.push('<g class="sv-set" data-set="' + esc(x.id) + '" role="button" tabindex="0" aria-label="' + esc((x.name || x.num) + ', ' + shelfName(c, li)) + '">' +
          '<rect x="' + (x0 + 0.15) + '" y="' + top + '" width="' + Math.max(0.5, f.along - 0.3) + '" height="' + f.h + '" rx="0.8" fill="' + col + '"' + (p.turn ? ' stroke-dasharray="1.2 0.8" class="turned"' : '') + '/>' +
          label(x, x0, top, f) + '</g>');
        x0 += f.along + S.GAP;
      });
      parts.push('<text x="' + (T + c.w - 0.8) + '" y="' + (y + 3) + '" class="sv-h" text-anchor="end">' + (li + 1) + ' · ' + cm(l.h) + ' cm</text>');
      y += l.h;
      parts.push('<rect x="0" y="' + y + '" width="' + W + '" height="' + T + '" class="sv-board"' + (u > c.w + 0.01 ? ' style="fill:var(--red)"' : '') + '/>');
      y += T;
    });
    var n = c.levels.reduce(function (k, l) { return k + l.sets.filter(function (p) { return ids[p.id]; }).length; }, 0);
    return '<section class="case">' +
      '<div class="case-hd"><div><h2>' + esc(c.name) + '</h2><div class="m">' + esc([c.room, cm(c.w) + ' × ' + cm(c.d) + ' cm inside', plural(c.levels.length, 'shelf').replace('shelfs', 'shelves'), plural(n, 'set')].filter(Boolean).join(' · ')) + '</div></div>' +
      '<button class="btn sm quiet" type="button" data-case="' + esc(c.id) + '">Edit</button></div>' +
      (over ? '<p class="flag bad"><span>' + (over === 1 ? 'A shelf is' : over + ' shelves are') + ' overfull, marked in red. Move a set off, or turn one side-on.</span></p>' : '') +
      '<svg class="shelf" viewBox="0 0 ' + W + ' ' + H + '" style="width:min(100%,' + Math.round(W * 7) + 'px,calc(72vh * ' + (W / H).toFixed(3) + '))" role="img" aria-label="' + esc(c.name) + ' from the front">' + parts.join('') + '</svg></section>';
  }

  // A name in the set's rectangle if it fits, else its number, else nothing.
  function label(x, x0, top, f) {
    var fs = Math.min(2.6, Math.max(1.6, f.along / 9)), cx = x0 + f.along / 2;
    var name = x.name || '', num = C.shortNum(x.num), room = f.along - 1;
    var t = name.length * fs * 0.55 <= room ? name : (num && num.length * fs * 0.6 <= room ? num : '');
    if (!t || f.h < fs + 1) return '';
    return '<text x="' + cx + '" y="' + (top + Math.min(f.h / 2 + fs / 3, fs + 1.4)) + '" font-size="' + fs + '" text-anchor="middle" class="sv-t">' + esc(t) + '</text>';
  }

  // ---------- doing things ----------
  $('shelves-body').addEventListener('click', function (e) {
    var a = e.target.closest('[data-act],[data-set],[data-case]');
    if (!a) return;
    if (a.dataset.set) return setSheet(a.dataset.set);
    if (a.dataset.case) return caseSheet(app.doc().cases[a.dataset.case]);
    var act = a.dataset.act;
    if (act === 'add-case') caseSheet(null);
    if (act === 'fill') fillAll();
    if (act === 'apply') applyPlaces();
    if (act === 'ask-sizes') askSizes();
    if (act === 'open-sizes') openSizes();
  });
  $('shelves-body').addEventListener('keydown', function (e) {
    var g = e.target.closest && e.target.closest('.sv-set');
    if (g && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); setSheet(g.dataset.set); }
  });

  function fillAll() {
    var before = cases(), r = S.fill(before, sets()), moved = 0;
    r.cases.forEach(function (c, i) { if (JSON.stringify(c.levels) !== JSON.stringify(before[i].levels)) { app.putCase(c); } });
    lastLeft = {};
    r.left.forEach(function (x) { lastLeft[x.set.id] = x.why; });
    moved = S.sort(sets(), r.cases).placed.length - S.sort(sets(), before).placed.length;
    render();
    toast(moved ? plural(moved, 'set') + ' placed' + (r.left.length ? '; ' + r.left.length + ' didn’t fit' : '') : 'Nothing else fits. See why under each set.');
  }

  function applyPlaces() {
    var ids = byId(), n = 0;
    cases().forEach(function (c) {
      c.levels.forEach(function (l, li) {
        l.sets.forEach(function (p) {
          var x = ids[p.id]; if (!x) return;
          var spot = shelfName(c, li), room = c.room || x.room || '';
          if (x.spot === spot && (x.room || '') === room) return;
          var y = JSON.parse(JSON.stringify(x)); y.spot = spot; if (room) y.room = room; else delete y.room;
          app.putSet(y); n++;
        });
      });
    });
    toast(n ? plural(n, 'set') + ' updated in My sets' : 'My sets already says this');
  }

  // One set: its size, where it stands, and moving it.
  function setSheet(id) {
    var x = byId()[id]; if (!x) return;
    var all = cases(), at = S.placements(all)[id], ids = byId(), z = x.size || {};
    var opts = '<option value="">Not on a shelf</option>' + all.map(function (c) {
      return '<optgroup label="' + esc(c.name) + '">' + c.levels.map(function (l, li) {
        var here = at && at.c === c.id && at.l === li, f = S.fits(c, li, x, ids, here && at.turn);
        return '<option value="' + esc(c.id) + ':' + li + '"' + (here ? ' selected' : '') + (f.why && !here ? ' disabled' : '') + '>Shelf ' + (li + 1) + ' (' + cm(l.h) + ' cm)' + (f.why && !here ? ' · ' + esc(f.why.replace(/ \(.*\)/, '').toLowerCase()) : '') + '</option>';
      }).join('') + '</optgroup>';
    }).join('');
    var level = at ? app.doc().cases[at.c].levels[at.l] : null, pos = level ? level.sets.findIndex(function (p) { return p.id === id; }) : -1;
    var panel = app.openSheet('<div class="hd"><h2 id="sheetTitle">' + esc(x.name || 'Set ' + C.shortNum(x.num)) + '</h2><button class="btn sm quiet" type="button" data-close>Close</button></div><div class="bd">' +
      '<div class="three">' +
      '<label class="field"><span>Width, cm</span><input id="z-w" inputmode="decimal" value="' + esc(z.w || '') + '"></label>' +
      '<label class="field"><span>Depth, cm</span><input id="z-d" inputmode="decimal" value="' + esc(z.d || '') + '"></label>' +
      '<label class="field"><span>Height, cm</span><input id="z-h" inputmode="decimal" value="' + esc(z.h || '') + '"></label></div>' +
      (all.length ? '<label class="field"><span>Where it stands</span><select id="z-where">' + opts + '</select></label>' : '') +
      (at ? '<label class="check"><input type="checkbox" id="z-turn"' + (at.turn ? ' checked' : '') + '> Stand it side-on (takes its depth along the shelf)</label>' +
        '<div class="acts-row"><button class="btn quiet sm" type="button" id="z-left"' + (pos <= 0 ? ' disabled' : '') + '>Move left</button><button class="btn quiet sm" type="button" id="z-right"' + (pos >= level.sets.length - 1 ? ' disabled' : '') + '>Move right</button></div>' : '') +
      '</div><div class="ft"><a class="btn quiet" href="#catalog" id="z-cat">See in My sets</a><button class="btn" type="button" id="z-save">Save</button></div>');
    panel.querySelector('[data-close]').onclick = app.closeSheet;
    $('z-cat').onclick = function () { app.closeSheet(); };
    function shift(by) {
      var c = copy(app.doc().cases[at.c]), l = c.levels[at.l], i = l.sets.findIndex(function (p) { return p.id === id; });
      var p = l.sets.splice(i, 1)[0]; l.sets.splice(i + by, 0, p); app.putCase(c); app.closeSheet(); render();
    }
    if ($('z-left')) { $('z-left').onclick = function () { shift(-1); }; $('z-right').onclick = function () { shift(1); }; }
    $('z-save').onclick = function () {
      var w = C.measure($('z-w').value), d = C.measure($('z-d').value), h = C.measure($('z-h').value);
      var y = JSON.parse(JSON.stringify(x));
      if (w && d && h) y.size = { w: w, d: d, h: h };
      else if (!w && !d && !h) delete y.size;
      else { toast('Give all three sizes, or none'); return; }
      if (JSON.stringify(y.size || null) !== JSON.stringify(x.size || null)) { app.putSet(y); delete lastLeft[id]; }
      var want = $('z-where') ? $('z-where').value : '', turn = $('z-turn') ? $('z-turn').checked : false;
      var now = at ? at.c + ':' + at.l : '';
      if (want !== now || (at && turn !== at.turn)) {
        var ids2 = byId(), changed = {};
        if (at) { var c0 = copy(app.doc().cases[at.c]); S.takeOff([c0], id); changed[c0.id] = c0; }
        if (want) {
          var bits = want.split(':'), c1 = changed[bits[0]] || copy(app.doc().cases[bits[0]]), li = +bits[1];
          var f = S.fits(c1, li, ids2[id], ids2, $('z-turn') ? turn : false);
          if (f.why) { toast(f.why); return; }
          var p = { id: id }; if (f.turn) p.turn = true;
          if (at && at.c === c1.id && at.l === li) c1.levels[li].sets.splice(pos, 0, p); else c1.levels[li].sets.push(p);
          changed[c1.id] = c1;
        }
        Object.keys(changed).forEach(function (k) { app.putCase(changed[k]); });
      }
      app.closeSheet(); render();
    };
  }

  // Add or change a bookcase.
  function caseSheet(c) {
    var isNew = !c, preset = isNew ? PRESETS[0] : null;
    var v = c ? { name: c.name, room: c.room || '', w: c.w, d: c.d, levels: c.levels.map(function (l) { return l.h; }) } : { name: preset.name, room: '', w: preset.w, d: preset.d, levels: preset.levels };
    var rooms = {}; sets().forEach(function (x) { if (x.room) rooms[x.room] = 1; }); cases().forEach(function (k) { if (k.room) rooms[k.room] = 1; });
    var panel = app.openSheet('<div class="hd"><h2 id="sheetTitle">' + (isNew ? 'Add a bookcase' : 'Edit ' + esc(c.name)) + '</h2><button class="btn sm quiet" type="button" data-close>Close</button></div><div class="bd">' +
      (isNew ? '<div class="field"><span class="lbl">Start from</span><div class="seg" id="k-preset">' + PRESETS.map(function (p, i) {
        return '<button type="button" data-k="' + i + '" aria-pressed="' + (i === 0) + '">' + esc(p.label) + '</button>';
      }).join('') + '</div></div>' : '') +
      '<div class="two"><label class="field"><span>Name</span><input id="k-name" value="' + esc(v.name) + '" placeholder="e.g. Office Billy"></label>' +
      '<label class="field"><span>Room</span><input id="k-room" list="k-rooms" value="' + esc(v.room) + '" placeholder="e.g. Office"><datalist id="k-rooms">' + Object.keys(rooms).sort(C.natural).map(function (r) { return '<option value="' + esc(r) + '">'; }).join('') + '</datalist></label></div>' +
      '<div class="field"><span class="lbl">Inside, in cm</span><div class="two"><input id="k-w" inputmode="decimal" aria-label="Width inside in cm" placeholder="Width" value="' + esc(v.w) + '"><input id="k-d" inputmode="decimal" aria-label="Depth inside in cm" placeholder="Depth" value="' + esc(v.d) + '"></div></div>' +
      '<label class="field"><span>Height of each shelf, top shelf first (cm)</span><input id="k-levels" inputmode="decimal" value="' + esc(v.levels.join(', ')) + '" placeholder="e.g. 32, 32, 40, 40"></label>' +
      '<p class="note">The height is the clear space above each shelf, up to the one above it. The presets are rough: measure yours for a close fit.</p>' +
      '</div><div class="ft">' + (isNew ? '<span></span>' : '<button class="btn danger" type="button" id="k-del">Remove</button>') + '<button class="btn" type="button" id="k-save">' + (isNew ? 'Add bookcase' : 'Save') + '</button></div>');
    panel.querySelector('[data-close]').onclick = app.closeSheet;
    if ($('k-preset')) $('k-preset').onclick = function (e) {
      var b = e.target.closest('button'); if (!b) return;
      var p = PRESETS[+b.dataset.k];
      this.querySelectorAll('button').forEach(function (y) { y.setAttribute('aria-pressed', y === b); });
      $('k-name').value = p.name; $('k-w').value = p.w; $('k-d').value = p.d; $('k-levels').value = p.levels.join(', ');
      if (p.k === 'custom') $('k-name').focus();
    };
    if ($('k-del')) $('k-del').onclick = function () {
      if (!this.dataset.sure) { this.dataset.sure = '1'; this.textContent = 'Tap again to remove'; return; }
      app.removeCase(c.id); app.closeSheet(); render(); toast('Removed. Its sets are back in Not on a shelf yet.');
    };
    $('k-save').onclick = function () {
      var hs = $('k-levels').value.split(/[^0-9.]+/).map(C.measure).filter(Boolean);
      var y = C.cleanCase({ id: c ? c.id : 'k' + app.newId().slice(1), name: $('k-name').value || 'Bookcase', room: $('k-room').value, w: $('k-w').value, d: $('k-d').value,
        levels: hs.map(function (h, i) { return { h: h, sets: c && c.levels[i] ? c.levels[i].sets : [] }; }) });
      if (!y) { toast('Give the width, depth and at least one shelf height'); return; }
      app.putCase(y); app.closeSheet(); render();
    };
  }

  // ---------- sizes from Claude ----------
  function askSizes() {
    var need = S.sort(sets(), cases()).noSize;
    var text = 'Built sizes for my Brickyard sets, please (width × depth × height in cm, as built and displayed). Send them as a Brickyard sizes link.\n' +
      need.map(function (x) { return (C.shortNum(x.num) || '(no number)') + ' ' + (x.name || ''); }).join('\n') + '\n';
    var done = function () { toast('Copied. Paste it to Claude.'); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, function () { showText(text); });
    else showText(text);
  }
  function showText(text) {
    var panel = app.openSheet('<div class="hd"><h2 id="sheetTitle">Sets for Claude</h2><button class="btn sm quiet" type="button" data-close>Close</button></div>' +
      '<div class="bd"><p class="note">Copy this and paste it to Claude.</p><textarea class="paste" id="z-text" readonly style="min-height:200px">' + esc(text) + '</textarea></div>');
    panel.querySelector('[data-close]').onclick = app.closeSheet;
    $('z-text').select();
  }
  function openSizes() {
    var panel = app.openSheet('<div class="hd"><h2 id="sheetTitle">Sizes from Claude</h2><button class="btn sm quiet" type="button" data-close>Close</button></div><div class="bd">' +
      '<p class="note">Paste the link or the file Claude sent.</p><textarea class="paste" id="z-paste" aria-label="Paste a sizes link or file" placeholder="https://brickyard.junkdrawer.works/#z1z…"></textarea></div>' +
      '<div class="ft"><span></span><button class="btn" type="button" id="z-go">Open</button></div>');
    panel.querySelector('[data-close]').onclick = app.closeSheet;
    $('z-go').onclick = function () {
      S.parseSizes($('z-paste').value).then(function (z) { app.closeSheet(); reviewSizes(z); }, function () { toast('That doesn’t look like sizes from Claude'); });
    };
  }
  function reviewSizes(list) {
    var rows = [], unknown = 0;
    list.forEach(function (z) {
      var mine = sets().filter(function (x) { return x.num === z.num; });
      if (!mine.length) unknown++;
      mine.forEach(function (x) { rows.push({ x: x, z: z, on: !S.hasSize(x) }); });
    });
    if (!rows.length) { toast('None of those sets are in My sets'); return; }
    var panel = app.openSheet('<div class="hd"><h2 id="sheetTitle">Add sizes</h2><button class="btn sm quiet" type="button" data-close>Close</button></div><div class="bd">' +
      '<p class="note">Sizes Claude found for your sets. Sets that already have a size are unticked; tick one to replace it.' + (unknown ? ' ' + plural(unknown, 'set') + ' in the list aren’t in My sets.' : '') + '</p>' +
      '<ul class="rv" id="zr">' + rows.map(function (r, i) {
        return '<li class="' + (r.on ? '' : 'off') + '"><input type="checkbox" data-i="' + i + '"' + (r.on ? ' checked' : '') + ' aria-label="Add this size">' +
          '<div class="pic none swatch" style="background:' + colourOf(r.x) + '"></div><div><div class="t">' + esc(r.x.name || C.shortNum(r.x.num)) + '</div>' +
          '<div class="m">' + sizeText(r.z) + (r.x.size ? ' · replaces ' + sizeText(r.x.size) : '') + '</div>' + (r.z.note ? '<div class="m">' + esc(r.z.note) + '</div>' : '') + '</div></li>';
      }).join('') + '</ul></div>' +
      '<div class="ft"><span class="note" id="zr-n" style="margin:0"></span><button class="btn" type="button" id="zr-go">Add sizes</button></div>');
    panel.querySelector('[data-close]').onclick = app.closeSheet;
    function count() { $('zr-n').textContent = plural(rows.filter(function (r) { return r.on; }).length, 'set'); }
    count();
    $('zr').onchange = function (e) { var r = rows[+e.target.dataset.i]; r.on = e.target.checked; e.target.parentNode.classList.toggle('off', !r.on); count(); };
    $('zr-go').onclick = function () {
      var n = 0;
      rows.forEach(function (r) {
        if (!r.on) return;
        var y = JSON.parse(JSON.stringify(r.x)); y.size = { w: r.z.w, d: r.z.d, h: r.z.h }; app.putSet(y); n++;
      });
      app.closeSheet(); render(); toast(n ? plural(n, 'size') + ' added' : 'Nothing added');
    };
  }

  // ---------- routing ----------
  function route() {
    if ($('shelves').hidden) return;
    var h = location.hash;
    if (/^#z1[zj]/.test(h)) {
      history.replaceState(null, '', location.pathname + location.search + '#shelves');
      render();
      S.parseSizes(h).then(reviewSizes, function (e) { toast(e && /browser/.test(e.message) ? e.message : 'That link doesn’t hold sizes Brickyard can read'); });
      return;
    }
    render();
  }
  document.addEventListener('brickyard:route', route);
  route();
})();
