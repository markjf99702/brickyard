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
  function $(id) { return document.getElementById(id); }

  // The bookcases, each set standing in one place (S.dedupe: two devices can each have saved it on a different
  // one). A bookcase that had to lose a set comes back as a copy, and is saved that way the next time anything
  // here saves a bookcase (put). So a bookcase is always taken from here (caseOf), never from the catalog as kept.
  function cases() {
    var d = app.doc().cases;
    return S.dedupe(Object.keys(d).map(function (k) { return d[k]; }).filter(function (c) { return !c.del; })
      .sort(function (a, b) { return C.natural(a.room || '', b.room || '') || C.natural(a.name, b.name) || C.natural(a.id, b.id); }));
  }
  function caseOf(id) { return cases().filter(function (c) { return c.id === id; })[0] || null; }
  function tidy(but) { var d = app.doc().cases; cases().forEach(function (c) { if (c.id !== but && c !== d[c.id]) app.putCase(c); }); }
  function put(c) { tidy(c.id); app.putCase(c); }
  // Undo for a change to bookcases: each goes back as it was (copies kept from before). A set stood on another
  // bookcase in the meantime stays there.
  function putCasesBack(kept) {
    var mine = {}; kept.forEach(function (k) { mine[k.id] = 1; });
    var at = S.placements(cases().filter(function (c) { return !mine[c.id]; }));
    kept.forEach(function (k) { k.levels.forEach(function (l) { l.sets = l.sets.filter(function (p) { return !at[p.id]; }); }); });
    kept.forEach(function (k) { app.putBack('cases', k); });
  }
  function nameOf(x) { return x.name || 'Set ' + C.shortNum(x.num); }
  function onShelf(x) { return S.ON_SHELVES.indexOf(x.state) >= 0; }
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
      // On shelves: the sets drawn there. One that has lost its size isn't, and counts under Needs a size.
      var placed = sorted.placed.filter(S.hasSize).length, total = placed + sorted.waiting.length + sorted.noSize.length;
      var fitting = sorted.waiting.filter(function (x) { return !S.whyNot(all, x, ids); }).length;
      // Nothing to count until there's a set the planner places (the note at the end says which those are).
      if (total) html += '<p class="sumline"><span>' + (placed < total ? placed + ' of ' + plural(total, 'set') + ' on shelves' : total === 1 ? 'Your set is on a shelf' : 'All ' + total + ' sets are on shelves') + '</span></p>';
      html += '<div class="acts-row">' + (fitting ? '<button class="btn" type="button" data-act="fill">Fit ' + (fitting === sorted.waiting.length ? plural(fitting, 'set') : 'the sets') + ' onto the shelves</button>' : '') +
        '<button class="btn quiet" type="button" data-act="add-case">Add a bookcase</button></div>';
      if (placed) html += '<p class="note">Tap a set to move it, turn it side-on or fix its size.</p>';
      all.forEach(function (c, i) { html += caseHtml(c, ids, i); });
      if (sorted.placed.length) {
        // The card says whether My sets is behind these shelves: after Fit moves a set, or a bookcase is renamed,
        // nothing else on the screen did.
        var apart = places(all, ids).filter(function (p) { return p.differs; }).length;
        html += '<div class="how" style="margin-top:6px"><b>Happy with it?</b> <span class="note" style="display:block;margin:2px 0 8px">Copy each set’s room and shelf into My sets, so search finds it there.</span>' +
          (apart ? '<p class="note" id="apply-n" style="margin:0 0 8px;color:var(--ink)">' + (apart === 1 ? '1 set is' : apart.toLocaleString() + ' sets are') + ' somewhere else in My sets.</p><button class="btn quiet sm" type="button" data-act="apply">Put these places in My sets</button>'
            : '<p class="note ok" id="apply-n" style="margin:0">My sets matches these shelves.</p>') + '</div>';
      }
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
        '<ul class="list">' + sorted.noSize.map(function (x) {
          var at = S.placements(all)[x.id], c = at && all.filter(function (k) { return k.id === at.c; })[0];
          return setRow(x, '', c ? 'On ' + shelfName(c, at.l) : '');
        }).join('') + '</ul>';
    }
    if (!sorted.placed.length && !sorted.waiting.length && !sorted.noSize.length) {
      html += '<p class="note" style="margin-top:16px">The planner places sets marked <b>Built</b> or <b>Partly built</b> in My sets. You don’t have any yet. <a href="#catalog">Add or mark them in My sets.</a></p>';
    }
    $('shelves-body').innerHTML = html;
  }

  // `where` is for a set that needs a size but is on a shelf already (its size was cleared): it isn't in the drawing.
  function setRow(x, why, where) {
    var meta = S.hasSize(x) ? sizeText(x.size) : [C.shortNum(x.num), x.theme].filter(Boolean).join(' · ');
    return '<li><button class="item" type="button" data-set="' + esc(x.id) + '"><div class="pic none swatch" style="background:' + colourOf(x) + '"></div>' +
      '<div class="main"><div class="t">' + esc(nameOf(x)) + '</div>' + (meta ? '<div class="m">' + esc(meta) + '</div>' : '') +
      (where ? '<div class="m">' + esc(where) + '</div>' : '') +
      (why ? '<div class="m warn">' + esc(why) + '</div>' : '') + '</div><span></span></button></li>';
  }

  // Why a waiting set isn't on a shelf, from the bookcases and sizes as they are now: right after a fill that's
  // what the fill found, and it never outlives a bookcase or a size changing.
  function whyNot(x, all, ids) { return all.length ? S.whyNot(all, x, ids) : ''; }

  // A bookcase from the front, drawn to scale in cm. A shelf that's overfull, or holds a set taller than the space
  // above it (its size or the shelf's height changed after it was placed), is marked in red. A set that has been
  // taken apart or sealed since it was placed is drawn pale and hatched, with a line above the drawing that takes
  // it off: it still holds its room until then. `n` is the bookcase's place on the page, for the hatching's name.
  var HIT = 10.5; // the least a set's tap target measures, cm: about 44 px where a Billy fills a phone's width
  function caseHtml(c, ids, n) {
    var W = c.w + 2 * T, H = T, y = T, parts = [], tags = [], over = 0, high = 0, drawn = 0, gone = [], deep = [];
    c.levels.forEach(function (l) { H += l.h + T; });
    parts.push('<defs><pattern id="svh' + n + '" width="2.4" height="2.4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="0.9" height="2.4" class="sv-stripe"/></pattern></defs>');
    parts.push('<rect x="0" y="0" width="' + W + '" height="' + H + '" rx="0.8" class="sv-frame"/>');
    c.levels.forEach(function (l, li) {
      parts.push('<rect x="' + T + '" y="' + y + '" width="' + c.w + '" height="' + l.h + '" class="sv-back" data-level="' + esc(c.id) + ':' + li + '"/>');
      var x0 = T, u = S.used(l, ids), tall = 0, row = [];
      if (u > c.w + 0.01) over++;
      // The shelf's number and height, top right, on a tag of its own that's drawn after every set: a tall set at
      // that end of the shelf used to run through the words. A set standing under the tag starts its name below it.
      var text = (li + 1) + ' · ' + cm(l.h) + ' cm', tw = text.length * 1.28 + 1.6;
      var tag = { x: T + c.w - 0.4 - tw, y: y + 0.4, w: tw, h: 3.7 };
      tags.push('<rect x="' + tag.x.toFixed(2) + '" y="' + tag.y + '" width="' + tw.toFixed(2) + '" height="' + tag.h + '" rx="1.85" class="sv-tag"/>' +
        '<text x="' + (T + c.w - 1.2) + '" y="' + (y + 3.1) + '" class="sv-h" text-anchor="end">' + text + '</text>');
      l.sets.forEach(function (p) {
        var x = ids[p.id]; if (!x) return;
        if (!onShelf(x)) gone.push(x);
        if (!S.hasSize(x)) return;
        drawn++;
        if (x.size.h > l.h) tall++;
        var f = S.footprint(x, p.turn);
        if (f.deep > c.d) deep.push({ x: x, f: f, turn: !!p.turn });
        row.push({ x: x, p: p, f: f, x0: x0 });
        x0 += f.along + S.GAP;
      });
      row.forEach(function (r, i) {
        var x = r.x, f = r.f, top = y + l.h - f.h, next = row[i + 1];
        // A small set is hard to hit with a thumb, so each takes taps on a clear rectangle at least HIT wide and
        // tall: up into the empty shelf above it, and sideways as far as halfway to its neighbours or the shelf's end.
        var left = i ? r.x0 - S.GAP / 2 : T, right = next ? next.x0 - S.GAP / 2 : Math.max(T + c.w, r.x0 + f.along);
        var hw = Math.max(f.along, Math.min(HIT, right - left)), hx = Math.min(Math.max(left, r.x0 - (hw - f.along) / 2), right - hw);
        var hh = Math.max(f.h, Math.min(HIT, l.h)), hy = y + l.h - hh;
        var off = !onShelf(x), box = 'x="' + (r.x0 + 0.15) + '" y="' + top + '" width="' + Math.max(0.5, f.along - 0.3) + '" height="' + f.h + '" rx="0.8"';
        parts.push('<g class="sv-set' + (off ? ' off' : '') + '" data-set="' + esc(x.id) + '" role="button" tabindex="0" aria-label="' + esc((x.name || x.num) + ', ' + shelfName(c, li)) + '">' +
          '<rect x="' + hx.toFixed(2) + '" y="' + hy + '" width="' + hw.toFixed(2) + '" height="' + hh + '" class="sv-hit"/>' +
          '<rect ' + box + ' fill="' + colourOf(x) + '" class="sv-box' + (r.p.turn ? ' turned" stroke-dasharray="1.2 0.8' : '') + '"/>' +
          (off ? '<rect ' + box + ' fill="url(#svh' + n + ')" class="sv-hatch"/>' : '') +
          label(x, r.x0, top, f, tag) + '</g>');
      });
      y += l.h; high += tall;
      parts.push('<rect x="0" y="' + y + '" width="' + W + '" height="' + T + '" class="sv-board"' + (u > c.w + 0.01 || tall ? ' style="fill:var(--red)"' : '') + '/>');
      y += T;
    });
    var names = gone.slice(0, 3).map(nameOf), more = gone.length - names.length;
    var goneSays = !gone.length ? '' : gone.length === 1 ? names[0] + (gone[0].state === 'apart' ? ' is taken apart now.' : gone[0].state === 'sealed' ? ' is sealed now.' : ' isn’t built now.')
      : gone.length.toLocaleString() + ' sets here aren’t built now: ' + (more ? names.join(', ') + ' and ' + more.toLocaleString() + ' more.' : names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1] + '.');
    return '<section class="case">' +
      '<div class="case-hd"><div><h2>' + esc(c.name) + '</h2><div class="m">' + esc([c.room, cm(c.w) + ' × ' + cm(c.d) + ' cm inside', plural(c.levels.length, 'shelf').replace('shelfs', 'shelves'), plural(drawn, 'set')].filter(Boolean).join(' · ')) + '</div></div>' +
      '<button class="btn sm quiet" type="button" data-case="' + esc(c.id) + '">Edit</button></div>' +
      (over ? '<p class="flag bad"><span>' + (over === 1 ? 'A shelf is' : over + ' shelves are') + ' overfull, marked in red. Move a set off, or turn one side-on.</span></p>' : '') +
      (high ? '<p class="flag bad"><span>' + (high === 1 ? 'A set is too tall for its shelf, marked in red. Move it to a taller shelf.' : high + ' sets are too tall for their shelves, marked in red. Move them to taller shelves.') + '</span></p>' : '') +
      (deep.length ? '<p class="flag bad"><span>' + esc(deepSays(c, deep)) + '</span></p>' : '') +
      (gone.length ? '<p class="flag bad"><span>' + esc(goneSays) + '</span><button class="btn sm quiet" type="button" data-act="take-off" data-k="' + esc(c.id) + '">' + (gone.length === 1 ? 'Take it off the shelf' : 'Take them off') + '</button></p>' : '') +
      '<svg class="shelf" viewBox="0 0 ' + W + ' ' + H + '" style="--w:' + Math.round(W * 7) + 'px;--ar:' + (W / H).toFixed(3) + '" role="img" aria-label="' + esc(c.name) + ' from the front">' + parts.join('') + tags.join('') + '</svg></section>';
  }

  // A set that sticks out past the front of its bookcase: the bookcase's depth was edited, or the set's size was,
  // after it was placed. (An overfull shelf and a set too tall were flagged; this wasn't.) Whichever way round it
  // stands, it's the side that runs front to back that counts, and when the other way round would do the line says so.
  function deepSays(c, deep) {
    if (deep.length > 2) return deep.length.toLocaleString() + ' sets are too deep for this bookcase (' + cm(c.d) + ' cm deep). Move them to a deeper one.';
    return deep.map(function (o) {
      var other = S.footprint(o.x, !o.turn);
      return nameOf(o.x) + ' is ' + cm(o.f.deep) + ' cm deep ' + (o.turn ? 'side-on' : 'facing out') + '; this bookcase is ' + cm(c.d) + ' cm deep. ' +
        (other.deep <= c.d ? (o.turn ? 'Turn it to face out.' : 'Turn it side-on.') : 'Move it to a deeper one.');
    }).join(' ');
  }

  // About how wide a piece of text is in the drawing's font (Rubik), in ems: a little over, so what's said to fit does.
  function ems(t) {
    var n = 0;
    for (var i = 0; i < t.length; i++) {
      var ch = t.charAt(i);
      n += ch > '\u2e7f' ? 1.05 : /[mwMW…@%]/.test(ch) ? 0.88 : /[iIjl.,:;'’!| ]/.test(ch) ? 0.29 : /[frt()\-·\/]/.test(ch) ? 0.45 : /[0-9]/.test(ch) ? 0.65 : /[A-Z&]/.test(ch) ? 0.7 : 0.61;
    }
    return n;
  }
  // The start of a name that fits in room ems, ending in an ellipsis: the whole name if it fits, '' if under five
  // letters of it would.
  function shorten(name, room) {
    if (ems(name) <= room) return name;
    var k = name.length;
    while (k > 0 && ems(name.slice(0, k).replace(/[\s,·-]+$/, '') + '…') > room) k--;
    var cut = name.slice(0, k).replace(/[\s,·-]+$/, '');
    return cut.length >= 5 ? cut + '…' : '';
  }

  // A name on two lines, split at the space that leaves the longer line shortest: [first, second], or null if
  // there's no space or a line is over room ems.
  function halves(name, room) {
    var best = null, words = name.split(' ');
    for (var i = 1; i < words.length; i++) {
      var a = words.slice(0, i).join(' '), b = words.slice(i).join(' '), w = Math.max(ems(a), ems(b));
      if (w <= room && (!best || w < best.w)) best = { w: w, lines: [a, b] };
    }
    return best && best.lines;
  }

  // A set's name in its rectangle, never under 2.3 units tall (about 10 px where a Billy fills a phone's width; it
  // went down to 1.6, under 7 px). In order: the whole name across, on one line or two; the whole name up the side
  // of a set that's taller than it's wide; the start of the name with an ellipsis, across or up; the set's number;
  // nothing. `tag` is the shelf's label: a set standing under it keeps its name below it.
  function label(x, x0, top, f, tag) {
    var name = x.name || '', num = C.shortNum(x.num);
    var y0 = x0 + f.along > tag.x && top < tag.y + tag.h ? Math.min(top + f.h, tag.y + tag.h) : top, free = top + f.h - y0;
    var fs = Math.min(2.6, Math.max(2.3, f.along / 9)), across = free >= fs + 1 ? (f.along - 1) / fs : 0;
    var vs = Math.min(2.6, f.along - 1), up = f.h > f.along && vs >= 2.3 ? (free - 1.6) / vs : 0;
    var a = across ? shorten(name, across) : '', b = up ? shorten(name, up) : '', t, stand = false;
    var two = across && a !== name && free >= 2.2 * fs + 2 ? halves(name, across) : null, cx = x0 + f.along / 2;
    if (two) {
      return '<text y="' + (y0 + fs + 1.4).toFixed(2) + '" font-size="' + fs.toFixed(2) + '" text-anchor="middle" class="sv-t"><tspan x="' + cx + '">' + esc(two[0]) + '</tspan><tspan x="' + cx + '" dy="1.15em">' + esc(two[1]) + '</tspan></text>';
    }
    if (a && a === name) t = a;
    else if (b && b === name) { t = b; stand = true; }
    else if (a) t = a;
    else if (b) { t = b; stand = true; }
    else if (num && ems(num) <= across) t = num;
    else if (num && ems(num) <= up) { t = num; stand = true; }
    else return '';
    if (!stand) return '<text x="' + cx + '" y="' + (y0 + Math.min(free / 2 + fs / 3, fs + 1.4)).toFixed(2) + '" font-size="' + fs.toFixed(2) + '" text-anchor="middle" class="sv-t">' + esc(t) + '</text>';
    var cy = (y0 + free / 2).toFixed(2);
    return '<text x="' + cx + '" y="' + cy + '" dy="0.35em" transform="rotate(-90 ' + cx + ' ' + cy + ')" font-size="' + vs.toFixed(2) + '" text-anchor="middle" class="sv-t">' + esc(t) + '</text>';
  }

  // ---------- doing things ----------
  $('shelves-body').addEventListener('click', function (e) {
    var a = e.target.closest('[data-act],[data-set],[data-case]');
    if (!a) return;
    if (a.dataset.set) return setSheet(a.dataset.set);
    if (a.dataset.case) return caseSheet(caseOf(a.dataset.case));
    var act = a.dataset.act;
    if (act === 'add-case') caseSheet(null);
    if (act === 'fill') fillAll();
    if (act === 'apply') applyPlaces();
    if (act === 'take-off') takeOffGone(a.dataset.k);
    if (act === 'ask-sizes') askSizes();
    if (act === 'open-sizes') openSizes();
  });
  $('shelves-body').addEventListener('keydown', function (e) {
    var g = e.target.closest && e.target.closest('.sv-set');
    if (g && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); setSheet(g.dataset.set); }
  });

  function fillAll() {
    var before = cases(), r = S.fill(before, sets()), moved = 0;
    r.cases.forEach(function (c, i) { if (JSON.stringify(c.levels) !== JSON.stringify(before[i].levels)) put(c); });
    moved = S.sort(sets(), r.cases).placed.length - S.sort(sets(), before).placed.length;
    render();
    toast(moved ? plural(moved, 'set') + ' placed' + (r.left.length ? '; ' + r.left.length + ' didn’t fit' : '') : 'Nothing else fits. See why under each set.');
  }

  // Takes off a bookcase every set on it that isn't built or partly built any more.
  function takeOffGone(id) {
    var c = caseOf(id), ids = byId(), names = []; if (!c) return;
    var kept = copy(c), next = copy(c);
    next.levels.forEach(function (l) {
      l.sets = l.sets.filter(function (p) { var x = ids[p.id]; if (!x || onShelf(x)) return true; names.push(nameOf(x)); return false; });
    });
    if (!names.length) return;
    put(next); render();
    toast((names.length === 1 ? names[0] + ' is' : names.length.toLocaleString() + ' sets are') + ' off ' + c.name, false, { label: 'Undo', run: function () {
      putCasesBack([kept]); toast(names.length === 1 ? names[0] + ' is back on its shelf' : 'Those ' + names.length.toLocaleString() + ' sets are back on their shelves');
    } });
  }

  // Where the shelves put each set, against what My sets says: one entry for each set on a shelf (once, wherever
  // it stands), with the room and spot the button below would write. A set that isn't built or partly built any
  // more is `skip`: a taken-apart or sealed set isn't on a shelf, whatever the drawing still holds.
  function places(all, ids) {
    var at = S.placements(all), byCase = {}, out = [];
    all.forEach(function (c) { byCase[c.id] = c; });
    Object.keys(at).forEach(function (id) {
      var x = ids[id], c = byCase[at[id].c]; if (!x) return;
      var spot = shelfName(c, at[id].l), room = c.room || x.room || '', skip = S.ON_SHELVES.indexOf(x.state) < 0;
      out.push({ x: x, spot: spot, room: room, skip: skip, differs: !skip && (x.spot !== spot || (x.room || '') !== room) });
    });
    return out;
  }
  function sameWords(a, b) { return String(a || '') === String(b || ''); }

  // Copies each placed set's room and shelf into My sets. It overwrites what was written there (a room, "Mantelpiece,
  // left of the clock"), so the message has Undo, which puts back the room and spot of each set it changed, where
  // they still are as this left them.
  function applyPlaces() {
    var list = places(cases(), byId()), was = [], left = list.filter(function (p) { return p.skip; });
    list.forEach(function (p) {
      if (!p.differs) return;
      var y = copy(p.x); was.push({ id: y.id, room: y.room, spot: y.spot, toRoom: p.room, toSpot: p.spot });
      y.spot = p.spot; if (p.room) y.room = p.room; else delete y.room;
      app.putSet(y);
    });
    render();
    var kinds = ['taken apart', 'sealed', 'not built'].filter(function (k) {
      return left.some(function (p) { return (p.x.state === 'apart' ? 'taken apart' : p.x.state === 'sealed' ? 'sealed' : 'not built') === k; });
    });
    var also = left.length ? left.length.toLocaleString() + ' left alone: ' + kinds.join(' or ') : '';
    if (!was.length) { toast(also ? 'Nothing to update; ' + also : 'My sets already says this'); return; }
    toast(plural(was.length, 'set') + ' updated in My sets' + (also ? '; ' + also : ''), false, { label: 'Undo', run: function () {
      var n = 0;
      was.forEach(function (w) {
        var x = app.doc().sets[w.id];
        if (!x || x.del || !sameWords(x.spot, w.toSpot) || !sameWords(x.room, w.toRoom)) return; // changed since: leave it
        var y = copy(x);
        if (w.room) y.room = w.room; else delete y.room;
        if (w.spot) y.spot = w.spot; else delete y.spot;
        app.putSet(y); n++;
      });
      app.refresh();
      toast(n === 1 ? 'Put that set’s place back' : 'Put those ' + n.toLocaleString() + ' sets’ places back');
    } });
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
    var level = at ? caseOf(at.c).levels[at.l] : null, pos = level ? level.sets.findIndex(function (p) { return p.id === id; }) : -1;
    app.openSheet('<div class="hd"><h2 id="sheetTitle">' + esc(x.name || 'Set ' + C.shortNum(x.num)) + '</h2><button class="btn sm quiet" type="button" data-close>Close</button></div><div class="bd">' +
      '<div class="three">' +
      '<label class="field"><span>Width, cm</span><input id="z-w" inputmode="decimal" value="' + esc(z.w || '') + '"></label>' +
      '<label class="field"><span>Depth, cm</span><input id="z-d" inputmode="decimal" value="' + esc(z.d || '') + '"></label>' +
      '<label class="field"><span>Height, cm</span><input id="z-h" inputmode="decimal" value="' + esc(z.h || '') + '"></label></div>' +
      (all.length ? '<label class="field"><span>Where it stands</span><select id="z-where">' + opts + '</select></label>' : '') +
      (at ? '<label class="check"><input type="checkbox" id="z-turn"' + (at.turn ? ' checked' : '') + '> Stand it side-on (takes its depth along the shelf)</label>' +
        '<div class="acts-row"><button class="btn quiet sm" type="button" id="z-left"' + (pos <= 0 ? ' disabled' : '') + '>Move left</button><button class="btn quiet sm" type="button" id="z-right"' + (pos >= level.sets.length - 1 ? ' disabled' : '') + '>Move right</button></div>' : '') +
      '</div><div class="ft"><a class="btn quiet" href="#catalog" id="z-cat">See in My sets</a><button class="btn" type="button" id="z-save">Save</button></div>',
      function () { return now() !== was; });
    // Its size and place as the sheet has them, to tell whether closing would lose a change.
    function now() { return app.fieldsOf(['z-w', 'z-d', 'z-h', 'z-where', 'z-turn']); }
    var was = now();
    // My sets opens on this set (app.showSet), once this sheet has closed.
    $('z-cat').onclick = function (e) { e.preventDefault(); app.showSet(id); };
    function shift(by) {
      var c = copy(caseOf(at.c)), l = c.levels[at.l], i = l.sets.findIndex(function (p) { return p.id === id; });
      var p = l.sets.splice(i, 1)[0]; l.sets.splice(i + by, 0, p); put(c); app.closeSheet(); render();
    }
    if ($('z-left')) { $('z-left').onclick = function () { shift(-1); }; $('z-right').onclick = function () { shift(1); }; }
    $('z-save').onclick = function () {
      // cm unless they say inches; what can't be read is turned down by app.lengths, which says which box.
      var z = app.lengths([['z-w', 'Width'], ['z-d', 'Depth'], ['z-h', 'Height']]);
      if (!z) return;
      var w = z.v['z-w'], d = z.v['z-d'], h = z.v['z-h'];
      var y = JSON.parse(JSON.stringify(x));
      if (w && d && h) y.size = { w: w, d: d, h: h };
      else if (!w && !d && !h) delete y.size;
      else { toast('Give all three sizes, or none'); return; }
      if (JSON.stringify(y.size || null) !== JSON.stringify(x.size || null)) app.putSet(y);
      var want = $('z-where') ? $('z-where').value : '', turn = $('z-turn') ? $('z-turn').checked : false;
      var now = at ? at.c + ':' + at.l : '';
      if (want !== now || (at && turn !== at.turn)) {
        // Off every bookcase first, so it can only ever stand in the one place chosen here.
        var ids2 = byId(), list = cases(), next = list.map(copy);
        S.takeOff(next, id);
        if (want) {
          var bits = want.split(':'), c1 = next.filter(function (k) { return k.id === bits[0]; })[0], li = +bits[1];
          var f = S.fits(c1, li, ids2[id], ids2, $('z-turn') ? turn : false);
          if (f.why) { toast(f.why); return; }
          var p = { id: id }; if (f.turn) p.turn = true;
          if (at && at.c === c1.id && at.l === li) c1.levels[li].sets.splice(pos, 0, p); else c1.levels[li].sets.push(p);
        }
        next.forEach(function (k, i) { if (JSON.stringify(k.levels) !== JSON.stringify(list[i].levels)) put(k); });
      }
      app.closeSheet(); render();
      if (z.note) toast(z.note);
    };
  }

  // Add or change a bookcase. Each shelf has a box of its own for its height, top shelf first, with Remove, and Add
  // a shelf under them. (They were one box, "32, 32, 40": a phone's number keypad has no comma or space to type
  // that with, "32,5" was read as two shelves, and taking a height out of the middle left every shelf below it
  // holding the sets of the one above.) A row keeps the sets of the shelf it started as, wherever it ends up.
  var MOST = 20; // shelves a bookcase keeps (cleanCase)
  function caseSheet(c) {
    var isNew = !c, preset = isNew ? PRESETS[0] : null;
    var v = c ? { name: c.name, room: c.room || '', w: c.w, d: c.d } : { name: preset.name, room: '', w: preset.w, d: preset.d };
    var ids = byId(), rows = (c ? c.levels.map(function (l) { return l.h; }) : preset.levels).map(function (h, i) { return { from: c ? i : -1, v: cm(h) }; });
    var holds = function (r) { return r.from < 0 ? 0 : c.levels[r.from].sets.filter(function (p) { return ids[p.id]; }).length; };
    var rooms = {}; sets().forEach(function (x) { if (x.room) rooms[x.room] = 1; }); cases().forEach(function (k) { if (k.room) rooms[k.room] = 1; });
    app.openSheet('<div class="hd"><h2 id="sheetTitle">' + (isNew ? 'Add a bookcase' : 'Edit ' + esc(c.name)) + '</h2><button class="btn sm quiet" type="button" data-close>Close</button></div><div class="bd">' +
      (isNew ? '<div class="field"><span class="lbl">Start from</span><div class="seg" id="k-preset">' + PRESETS.map(function (p, i) {
        return '<button type="button" data-k="' + i + '" aria-pressed="' + (i === 0) + '">' + esc(p.label) + '</button>';
      }).join('') + '</div></div>' : '') +
      '<div class="two"><label class="field"><span>Name</span><input id="k-name" value="' + esc(v.name) + '" placeholder="e.g. Office Billy"></label>' +
      '<label class="field"><span>Room</span><input id="k-room" list="k-rooms" value="' + esc(v.room) + '" placeholder="e.g. Office"><datalist id="k-rooms">' + Object.keys(rooms).sort(C.natural).map(function (r) { return '<option value="' + esc(r) + '">'; }).join('') + '</datalist></label></div>' +
      '<div class="two"><label class="field"><span>Width inside, cm</span><input id="k-w" inputmode="decimal" value="' + esc(v.w) + '"></label>' +
      '<label class="field"><span>Depth inside, cm</span><input id="k-d" inputmode="decimal" value="' + esc(v.d) + '"></label></div>' +
      '<div class="field" role="group" aria-labelledby="k-levels-l"><span class="lbl" id="k-levels-l">Height of each shelf, top shelf first (cm)</span><ol class="levels" id="k-levels"></ol>' +
      '<div><button class="btn sm quiet" type="button" id="k-add">Add a shelf</button></div></div>' +
      '<p class="note">The height is the clear space above each shelf, up to the one above it. The presets are rough: measure yours for a close fit.</p>' +
      '</div><div class="ft">' + (isNew ? '<span></span>' : '<button class="btn danger" type="button" id="k-del">Remove</button>') + '<button class="btn" type="button" id="k-save">' + (isNew ? 'Add bookcase' : 'Save') + '</button></div>',
      function () { return now() !== was || $('k-room').value.trim() !== v.room; });
    // The rows as the sheet has them. What's typed lives in the boxes, so it's read back before the rows change.
    function read() { rows.forEach(function (r, i) { if ($('k-h' + i)) r.v = $('k-h' + i).value; }); }
    function draw() {
      $('k-levels').innerHTML = rows.map(function (r, i) {
        var n = holds(r);
        return '<li><span class="n" aria-hidden="true">' + (i + 1) + '</span><input id="k-h' + i + '" inputmode="decimal" autocomplete="off" aria-label="Height of shelf ' + (i + 1) + ', cm" value="' + esc(r.v) + '">' +
          '<span class="on">' + (n ? plural(n, 'set') : '') + '</span>' +
          '<button class="btn sm quiet" type="button" data-rm="' + i + '" aria-label="Remove shelf ' + (i + 1) + '"' + (rows.length === 1 ? ' disabled' : '') + '>Remove</button></li>';
      }).join('');
      $('k-add').disabled = rows.length >= MOST;
    }
    draw();
    // The bookcase as the sheet has it, to tell whether closing would lose a change. Choosing a preset isn't one:
    // it's what the sheet starts from.
    function now() { read(); return app.fieldsOf(['k-name', 'k-w', 'k-d'], rows.map(function (r) { return [r.from, String(r.v).trim()]; })); }
    var was = now();
    $('k-add').onclick = function () {
      read();
      // A new shelf starts at the height of the one above it: most are the same.
      rows.push({ from: -1, v: rows.length ? rows[rows.length - 1].v : '' }); draw();
      var box = $('k-h' + (rows.length - 1)); box.focus(); box.select();
    };
    $('k-levels').onclick = function (e) {
      var b = e.target.closest('[data-rm]'); if (!b || rows.length === 1) return;
      read(); rows.splice(+b.dataset.rm, 1); draw();
      var next = $('k-levels').querySelectorAll('[data-rm]')[Math.min(+b.dataset.rm, rows.length - 1)];
      if (next && !next.disabled) next.focus(); else $('k-add').focus();
    };
    if ($('k-preset')) $('k-preset').onclick = function (e) {
      var b = e.target.closest('button'); if (!b) return;
      var p = PRESETS[+b.dataset.k];
      this.querySelectorAll('button').forEach(function (y) { y.setAttribute('aria-pressed', y === b); });
      $('k-name').value = p.name; $('k-w').value = p.w; $('k-d').value = p.d;
      rows = (p.levels.length ? p.levels : ['']).map(function (h) { return { from: -1, v: String(h) }; }); draw();
      was = now();
      if (p.k === 'custom') $('k-name').focus();
    };
    if ($('k-del')) $('k-del').onclick = function () {
      if (!app.secondTap(this)) { this.textContent = 'Tap again to remove'; return; }
      var kept = copy(c), n = Object.keys(S.placements([c])).filter(function (id) { return ids[id]; }).length;
      // Sets that My sets says are on this bookcase, in the words Put these places in My sets writes ("Hall Billy,
      // shelf 2"), stop saying so: the bookcase is gone. Not when another bookcase has the same name.
      var twin = cases().some(function (k) { return k.id !== c.id && k.name === c.name; }), said = [];
      if (!twin) sets().forEach(function (x) {
        var m = /^(.*), shelf (\d+)$/.exec(x.spot || '');
        if (!m || m[1] !== c.name || +m[2] < 1 || +m[2] > c.levels.length || (c.room && x.room && x.room !== c.room)) return;
        said.push({ id: x.id, spot: x.spot });
        var y = copy(x); delete y.spot; app.putSet(y);
      });
      tidy(c.id); app.removeCase(c.id); app.closeSheet(); render();
      toast('Removed ' + c.name + (n ? '. Its sets are back in Not on a shelf yet.' : '') +
        (said.length ? (n ? ' ' : '. ') + (said.length === 1 ? '1 set no longer says' : said.length.toLocaleString() + ' sets no longer say') + ' ' + c.name + ' in My sets.' : ''), false, { label: 'Undo', run: function () {
        said.forEach(function (w) {
          var x = app.doc().sets[w.id];
          if (x && !x.del && !x.spot) { var y = copy(x); y.spot = w.spot; app.putSet(y); }
        });
        putCasesBack([kept]); toast(kept.name + ' is back');
      } });
    };
    $('k-save').onclick = function () {
      read();
      // Every size is cm unless it says inches, and one that can't be read keeps the sheet open (app.lengths).
      var boxes = [['k-w', 'Width'], ['k-d', 'Depth']].concat(rows.map(function (r, i) { return ['k-h' + i, 'Shelf ' + (i + 1)]; }));
      var z = app.lengths(boxes); if (!z) return;
      var blank = boxes.filter(function (b) { return !z.v[b[0]]; })[0];
      if (blank) {
        toast(blank[0] === 'k-w' || blank[0] === 'k-d' ? 'Give the width and depth inside, in cm' : 'Give ' + blank[1].toLowerCase() + ' a height, or remove it');
        $(blank[0]).focus(); return;
      }
      var y = C.cleanCase({ id: c ? c.id : 'k' + app.newId().slice(1), name: $('k-name').value || 'Bookcase', room: $('k-room').value, w: z.v['k-w'], d: z.v['k-d'],
        levels: rows.map(function (r, i) { return { h: z.v['k-h' + i], sets: r.from >= 0 ? c.levels[r.from].sets : [] }; }) });
      if (!y) { toast('Give the width, depth and at least one shelf height'); return; }
      // Sets on a shelf that was removed go back to the list, and the message says how many.
      var still = S.placements([y]), kept = c ? copy(c) : null;
      var off = c ? Object.keys(S.placements([c])).filter(function (id) { return ids[id] && !still[id]; }).length : 0;
      put(y); app.closeSheet(); render();
      var said = [off ? (off === 1 ? '1 set is' : off.toLocaleString() + ' sets are') + ' back in Not on a shelf yet' : '', z.note].filter(Boolean).join('. ');
      if (off) toast(said, false, { label: 'Undo', run: function () { putCasesBack([kept]); toast(kept.name + ' is as it was'); } });
      else if (said) toast(said);
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
    app.openSheet('<div class="hd"><h2 id="sheetTitle">Sets for Claude</h2><button class="btn sm quiet" type="button" data-close>Close</button></div>' +
      '<div class="bd"><p class="note">Copy this and paste it to Claude.</p><textarea class="paste" id="z-text" readonly style="min-height:200px">' + esc(text) + '</textarea></div>');
    $('z-text').select();
  }
  // Whatever is pasted or opened here goes where it belongs (app.takeIncoming): sizes to Add sizes below, and sets,
  // loose pieces or a model to their own screens.
  function openSizes() {
    app.openSheet('<div class="hd"><h2 id="sheetTitle">Sizes from Claude</h2><button class="btn sm quiet" type="button" data-close>Close</button></div><div class="bd">' +
      '<p class="note">Paste the link Claude sent, or open its file.</p>' +
      '<textarea class="paste" id="z-paste" aria-label="Paste a Brickyard link or file" placeholder="Paste a Brickyard link or file"></textarea></div>' +
      '<div class="ft"><button class="btn quiet" type="button" id="z-file">Open a file</button><button class="btn" type="button" id="z-go">Open</button></div>');
    $('z-file').onclick = app.openFile;
    $('z-go').onclick = function () { app.takePasted($('z-paste'), 'That doesn’t look like sizes from Claude'); };
  }
  function reviewSizes(list) {
    var rows = [], unknown = 0;
    list.forEach(function (z) {
      var mine = sets().filter(function (x) { return x.num === z.num; });
      if (!mine.length) unknown++;
      mine.forEach(function (x) { rows.push({ x: x, z: z, on: !S.hasSize(x) }); });
    });
    // Sizes never add sets, so a list for sets that aren't here has nothing to fill in: say what it held and why
    // nothing happened, with the way to My sets.
    if (!rows.length) {
      toast((list.length === 1 ? 'That size is for a set that isn’t' : 'Those ' + list.length.toLocaleString() + ' sizes are for sets that aren’t') +
        ' in My sets. Sizes only fill in sets you’ve already added.', false, { label: 'My sets', run: function () { location.hash = '#catalog'; } });
      return;
    }
    app.openSheet('<div class="hd"><h2 id="sheetTitle">Add sizes</h2><button class="btn sm quiet" type="button" data-close>Close</button></div><div class="bd">' +
      '<p class="note">Sizes Claude found for your sets. Sets that already have a size are unticked; tick one to replace it.' +
        (unknown ? ' ' + (unknown === 1 ? 'One set in the list isn’t' : unknown.toLocaleString() + ' sets in the list aren’t') + ' in My sets.' : '') + '</p>' +
      '<ul class="rv" id="zr">' + rows.map(function (r, i) {
        return '<li class="' + (r.on ? '' : 'off') + '"><input type="checkbox" data-i="' + i + '"' + (r.on ? ' checked' : '') + ' aria-label="Add this size">' +
          '<div class="pic none swatch" style="background:' + colourOf(r.x) + '"></div><div><div class="t">' + esc(r.x.name || C.shortNum(r.x.num)) + '</div>' +
          '<div class="m">' + sizeText(r.z) + (r.x.size ? ' · replaces ' + sizeText(r.x.size) : '') + '</div>' + (r.z.note ? '<div class="m">' + esc(r.z.note) + '</div>' : '') + '</div></li>';
      }).join('') + '</ul></div>' +
      '<div class="ft"><span class="note" id="zr-n" style="margin:0"></span><button class="btn" type="button" id="zr-go">Add sizes</button></div>');
    function count() { $('zr-n').textContent = plural(rows.filter(function (r) { return r.on; }).length, 'set'); }
    count();
    $('zr').onchange = function (e) { var r = rows[+e.target.dataset.i]; r.on = e.target.checked; e.target.parentNode.classList.toggle('off', !r.on); count(); };
    $('zr').onclick = app.tickRow;
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
      // Read as whatever it is (sizes, by its prefix); a link cut short or of a newer format says so.
      app.takeIncoming(C.parseIncoming(h), 'link', 'That link doesn’t hold sizes Brickyard can read');
      return;
    }
    render();
  }
  document.addEventListener('brickyard:route', route);
  // The catalog changed under the planner (Drive sync, or another tab).
  document.addEventListener('brickyard:changed', function () { if (!$('shelves').hidden) render(); });
  // For a sizes file opened from My sets' menu (js/app.js), which goes on to Add sizes here.
  window.BrickyardShelves = { reviewSizes: reviewSizes };
  route();
})();
