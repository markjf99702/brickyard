// Shelf planner: your bookcases drawn from the front, your built sets standing on them, and a button that fits
// the rest in where they go. The logic is in js/shelf-core.js; bookcases are kept in the catalog (cases).
(function () {
  'use strict';
  var S = window.ShelfCore, C = window.BrickCore, app = window.brickyard;
  var esc = app.esc, plural = app.plural, toast = app.toast;
  var T = 1.8; // board thickness in the drawing, cm
  // Sizes inside, in cm, from IKEA's UK product pages as read on 10 November 2026. BILLY bookcase 80x28x202 cm
  // (and 40x28x202): "1 fixed shelf and 4 adjustable shelves included", so six spaces; BILLY extra shelf 76x26 cm
  // (36x26 for the narrow one), 2 cm thick. Six spaces of 32 cm and five 2 cm shelves would be 202 cm, the whole
  // outside height, with nothing left for the top, the bottom and the plinth. With 2 cm panels top and bottom and
  // no plinth at all the spaces could average 31.3 cm at most; 30 is an estimate that allows for the plinth, whose
  // height IKEA doesn't publish. The shelves move, so the sheet says to measure. KALLAX 42x147 cm is 41.5 cm wide
  // and 39 cm deep (it was 37 here, which turned away sets 37.1 to 39 cm deep), with 33 cm spaces (its inserts are
  // 33x33 cm).
  var MEASURE = 'Measure yours for a close fit.';
  var BILLY_NOTE = 'Billy shelves move: these are six even spaces of about 30 cm. Measure yours.';
  var PRESETS = [
    { k: 'billy', label: 'Billy', name: 'Billy', w: 76, d: 26, levels: [30, 30, 30, 30, 30, 30], note: BILLY_NOTE },
    { k: 'billy40', label: 'Billy narrow', name: 'Billy narrow', w: 36, d: 26, levels: [30, 30, 30, 30, 30, 30], note: BILLY_NOTE },
    { k: 'kallax', label: 'Kallax column', name: 'Kallax', w: 33, d: 39, levels: [33, 33, 33, 33], note: MEASURE },
    { k: 'custom', label: 'My own', name: '', w: '', d: '', levels: [], note: '' },
  ];
  // A set's colour in the drawing, by its theme. Its name is written on it in white, so each is dark enough for
  // white to measure 4.5:1 on it (the orange was #e08a1e, 2.7:1, and the green #2f8a4e, 4.3:1).
  var COLOURS = ['#c8322b', '#1f5ba6', '#2c8249', '#b85a00', '#6d4fa0', '#20817a', '#8a5a3c', '#5b6770'];
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
  // The same, as it's written into a set's Shelf or spot in My sets, which keeps 60 characters (cleanSet): a long
  // bookcase name gives way so the shelf number always fits. It was written whole, and the next time the catalog was
  // read "The tall white Billy between the window and the door, shelf 1" lost its "1"; the planner then said the
  // set was somewhere else in My sets, and pressing the button again didn't help.
  function spotName(c, li) { var tail = ', shelf ' + (li + 1); return C.s(c.name, 60 - tail.length).trim() + tail; }
  function cm(v) { return String(v).replace(/\.0$/, ''); }
  function sizeText(z) { return cm(z.w) + ' × ' + cm(z.d) + ' × ' + cm(z.h) + ' cm'; }
  function colourOf(x) { var k = x.theme || x.name || ''; return COLOURS[parseInt(C.hash(k), 36) % COLOURS.length]; }

  // ---------- the screen ----------
  function render() {
    var all = cases(), ids = byId(), sorted = S.sort(sets(), all);
    var html = '';
    if (!all.length) {
      // Over the words, the drawing the home screen's Shelf planner card has, as My sets' empty state has its brick.
      html += '<div class="empty"><svg width="88" height="72" viewBox="0 0 88 72" aria-hidden="true"><rect x="8" y="30" width="72" height="4" rx="1" fill="var(--muted)"/><rect x="8" y="62" width="72" height="4" rx="1" fill="var(--muted)"/>' +
        '<rect x="14" y="14" width="18" height="16" rx="2" fill="var(--blue)"/><rect x="36" y="20" width="24" height="10" rx="2" fill="var(--yellow)"/><rect x="18" y="44" width="30" height="18" rx="2" fill="var(--red)"/><rect x="54" y="50" width="14" height="12" rx="2" fill="var(--green)"/></svg>' +
        '<h2>Your bookcases go here</h2><p>Add each bookcase with its shelf heights, and Brickyard fits your built sets onto them, tallest first, so you know where everything goes before you unpack.</p>' +
        '<div class="acts"><button class="btn" type="button" data-act="add-case">Add a bookcase</button></div>' + jumps(sorted) + '</div>';
    } else {
      // On shelves: the sets drawn there. One that has lost its size isn't, and counts under Needs a size.
      var placed = sorted.placed.filter(S.hasSize).length, total = placed + sorted.waiting.length + sorted.noSize.length;
      var fitting = sorted.waiting.filter(function (x) { return !S.whyNot(all, x, ids); }).length;
      // When nothing waiting fits there's no Fit button, and the count says why there's nothing more to press.
      var rest = total - placed, stuck = !fitting && rest ? '; the other ' + (rest === 1 ? 'one ' : rest.toLocaleString() + ' ') +
        (!sorted.noSize.length ? (rest === 1 ? 'doesn’t fit' : 'don’t fit') : !sorted.waiting.length ? (rest === 1 ? 'needs a size' : 'need a size') : 'don’t fit or need a size') : '';
      // Nothing to count until there's a set the planner places (the note at the end says which those are).
      if (total) html += '<p class="sumline"><span>' + (placed < total ? placed + ' of ' + plural(total, 'set') + ' on shelves' + stuck : total === 1 ? 'Your set is on a shelf' : 'All ' + total + ' sets are on shelves') + '</span></p>' + jumps(sorted);
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
      // Each set with why it's waiting (worked out afresh from the bookcases and sizes as they are now, so it never
      // outlives a bookcase or a size changing): the ones that fit somewhere first, then the ones that only need
      // room, then the ones no shelf here can take.
      var rows = sorted.waiting.map(function (x, i) { var r = all.length ? S.reason(all, x, ids) : { why: '', kind: '' }; return { x: x, why: r.why, kind: r.kind, i: i }; });
      var rank = function (r) { return r.kind === '' ? 0 : r.kind === 'room' ? 1 : 2; };
      rows.sort(function (a, b) { return rank(a) - rank(b) || a.i - b.i; });
      html += '<h2 class="group" id="sv-waiting" tabindex="-1" aria-label="Not on a shelf yet, ' + plural(sorted.waiting.length, 'set') + '"><span>Not on a shelf yet</span><span>' + sorted.waiting.length + '</span></h2>' + needLine(rows, all) +
        '<ul class="list">' + rows.map(function (r) { return setRow(r.x, r.why); }).join('') + '</ul>';
    }
    if (sorted.noSize.length) {
      html += '<h2 class="group" id="sv-nosize" tabindex="-1" aria-label="Needs a size, ' + plural(sorted.noSize.length, 'set') + '"><span>Needs a size</span><span>' + sorted.noSize.length + '</span></h2>' +
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
    // The keyboard's place survives the redraw: the set, bookcase or button that had the focus is found again by
    // what it's for (it was thrown back to the top of the page after every Save, Fit and Undo), and so is the one
    // an open sheet will give the focus back to when it closes.
    var had = keyOf(document.activeElement), from = keyOf(app.lastFocus());
    $('shelves-body').innerHTML = html;
    if (from) app.lastFocus(again(from));
    if (had) again(had).focus({ preventScroll: true });
  }
  function keyOf(el) {
    var t = el && el.closest && $('shelves-body').contains(el) ? el.closest('[data-set],[data-case],[data-act]') : null;
    return t && { set: t.dataset.set, kase: t.dataset.case, act: t.dataset.act, k: t.dataset.k, drawn: t.classList.contains('sv-set') };
  }
  function again(key) {
    var all = [].slice.call($('shelves-body').querySelectorAll('[data-set],[data-case],[data-act]')), pick = function (ok) { return all.filter(ok)[0]; };
    return (key.set && (pick(function (e) { return e.dataset.set === key.set && e.classList.contains('sv-set') === key.drawn; }) || pick(function (e) { return e.dataset.set === key.set; }))) ||
      (key.kase && pick(function (e) { return e.dataset.case === key.kase; })) ||
      (key.act && (pick(function (e) { return e.dataset.act === key.act && e.dataset.k === key.k; }) || pick(function (e) { return e.dataset.act === key.act; }))) ||
      // A button that has gone (Fit, once everything is placed) hands on to the next real button, Add a bookcase,
      // not to the words above it that go down the page.
      pick(function (e) { return !!e.dataset.act && e.dataset.act !== 'jump'; }) || pick(function (e) { return !!e.dataset.act; }) || document.querySelector('#shelves h1');
  }

  // The ways down to the two lists under the bookcases, as words to tap under the count: "87 not on a shelf yet",
  // "58 need a size". With 300 sets and three bookcases, Needs a size and its two buttons (Copy these for Claude,
  // Open sizes from Claude) were a dozen screens down, and nothing at the top said they were there. A list with
  // nothing in it is left out.
  function jumps(sorted) {
    var w = sorted.waiting.length, n = sorted.noSize.length, arrow = '<span aria-hidden="true">↓</span>';
    if (!w && !n) return '';
    return '<div class="jump">' + (w ? '<button type="button" data-act="jump" data-k="waiting">' + w.toLocaleString() + ' not on a shelf yet' + arrow + '</button>' : '') +
      (n ? '<button type="button" data-act="jump" data-k="nosize">' + (n === 1 ? '1 needs a size' : n.toLocaleString() + ' need a size') + arrow + '</button>' : '') + '</div>';
  }
  // Brings a list's heading to the top of the screen, under the bar, and gives it the focus, so a screen reader
  // says where this is and Tab goes on from there.
  function jump(k) {
    var h = $(k === 'nosize' ? 'sv-nosize' : 'sv-waiting');
    if (!h) return;
    h.scrollIntoView({ block: 'start' });
    h.focus({ preventScroll: true });
  }

  // `where` is for a set that needs a size but is on a shelf already (its size was cleared): it isn't in the drawing.
  function setRow(x, why, where) {
    var meta = S.hasSize(x) ? sizeText(x.size) : [C.shortNum(x.num), x.theme].filter(Boolean).join(' · ');
    return '<li><button class="item" type="button" data-set="' + esc(x.id) + '"><div class="pic none swatch" style="background:' + colourOf(x) + '"></div>' +
      '<div class="main"><div class="t">' + esc(nameOf(x)) + '</div>' + (meta ? '<div class="m">' + esc(meta) + '</div>' : '') +
      (where ? '<div class="m">' + esc(where) + '</div>' : '') +
      (why ? '<div class="m warn">' + esc(why) + '</div>' : '') + '</div><span></span></button></li>';
  }

  // The reasons under Not on a shelf yet, added up in one line: how many sets need more shelf and about how much,
  // how many are too tall, too deep or too wide for anything here. (After Fit, 83 rows each gave their own reason
  // and nothing said what they came to.) A part that's zero is left out.
  function needLine(rows, all) {
    var of = function (kind) { return rows.filter(function (r) { return r.kind === kind; }); };
    var is = function (n, one, many) { return (n === 1 ? '1 ' + one : n.toLocaleString() + ' ' + many); };
    var room = of('room'), tall = of('tall').length, deep = of('deep').length, wide = of('wide').length, big = of('big').length, bits = [];
    var hs = [].concat.apply([], all.map(function (c) { return c.levels.map(function (l) { return l.h; }); }));
    var most = function (f) { return cm(Math.max.apply(null, all.map(f))); }, one = all.length === 1;
    if (room.length) {
      var need = S.shelfNeeded(room.map(function (r) { return r.x; }), all);
      bits.push(is(room.length, 'needs', 'need') + ' more shelf: about ' + (need < 100 ? Math.ceil(need / 5) * 5 + ' cm' : (need < 1000 ? (Math.round(need / 10) / 10) : Math.round(need / 100)) + ' m') + '.');
    }
    if (tall) bits.push(is(tall, 'is', 'are') + ' taller than your ' + (hs.length === 1 ? 'shelf' : 'tallest shelf') + ' (' + cm(Math.max.apply(null, hs)) + ' cm).');
    if (deep) bits.push(is(deep, 'is', 'are') + ' deeper than your ' + (one ? 'bookcase' : 'deepest bookcase') + ' (' + most(function (c) { return c.d; }) + ' cm).');
    if (wide) bits.push(is(wide, 'is', 'are') + ' wider than your ' + (one ? 'bookcase' : 'widest bookcase') + ' (' + most(function (c) { return c.w; }) + ' cm).');
    if (big) bits.push(is(big, 'is', 'are') + ' too big some other way.');
    // One set that doesn't fit says why on its own row; the line is for adding several up.
    return rows.length - of('').length > 1 ? '<p class="note" id="need-line">' + esc(bits.join(' ')) + '</p>' : '';
  }

  // A bookcase from the front, drawn to scale in cm. A shelf that's overfull, or holds a set taller than the space
  // above it or deeper than the bookcase (a size changed after it was placed), has a red board and a "!" on its
  // label, so it isn't told by colour alone, and a line above the drawing says which shelf, which set and by how
  // much. A set that has been taken apart or sealed since it was placed is drawn pale and hatched, with a line that
  // takes it off: it still holds its room until then. `n` is the bookcase's place on the page, for the hatching's
  // name.
  //
  // For a screen reader the drawing is a group (as an image, the sets in it weren't there at all): each set is a
  // button that says its shelf, whether it's side-on and what's wrong with it, and each shelf's label says its
  // height and how many sets it holds, empty ones too.
  //
  // The words and the tap targets are sized in the drawing's own units (cm), for a Billy filling a phone's width,
  // where a cm gets about 4.2 px. A bookcase drawn smaller than that (a wide one squeezed onto a phone: a 180 cm
  // bench had names 4.7 px tall and sets to tap of 19 px; a tall one kept short on a laptop) has them scaled up by
  // `k` to come out the same size on the screen. The size it will be drawn at is worked out the way the
  // stylesheet does it (svg.shelf in css/app.css), so the planner is drawn again when the window's size changes.
  var HIT = 10.5; // the least a set's tap target measures, cm: about 44 px where a Billy fills a phone's width
  var PX = 4.15; // CSS px to a cm where a Billy fills a 390 px phone's width, a little under
  function pxPerCm(W, H) {
    var body = $('shelves-body'), cs = getComputedStyle(body);
    var room = body.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - 26, w = Math.min(room, W * 7); // 26: the card's padding and border
    if (window.innerWidth > 600) w = Math.min(w, 0.72 * window.innerHeight * W / H);
    return w > 0 ? w / W : PX;
  }
  function caseHtml(c, ids, n) {
    var W = c.w + 2 * T, H = T, y = T, parts = [], tags = [], over = [], high = [], drawn = 0, gone = [], deep = [];
    c.levels.forEach(function (l) { H += l.h + T; });
    var k = Math.max(1, PX / pxPerCm(W, H)), hit = HIT * k;
    parts.push('<defs><pattern id="svh' + n + '" width="2.4" height="2.4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="0.9" height="2.4" class="sv-stripe"/></pattern></defs>');
    parts.push('<rect x="0" y="0" width="' + W + '" height="' + H + '" rx="0.8" class="sv-frame"/>');
    c.levels.forEach(function (l, li) {
      parts.push('<rect x="' + T + '" y="' + y + '" width="' + c.w + '" height="' + l.h + '" class="sv-back" data-level="' + esc(c.id) + ':' + li + '"/>');
      var x0 = T, full = S.overfull(c, l, ids), tall = 0, out = 0, row = [];
      if (full) over.push('Shelf ' + (li + 1) + ' is overfull: ' + cm(S.used(l, ids)) + ' cm of sets on a ' + cm(c.w) + ' cm shelf.');
      l.sets.forEach(function (p) {
        var x = ids[p.id]; if (!x) return;
        if (!onShelf(x)) gone.push(x);
        if (!S.hasSize(x)) return;
        drawn++;
        var f = S.footprint(x, p.turn), r = { x: x, p: p, f: f, x0: x0, tall: x.size.h > l.h, deep: f.deep > c.d };
        if (r.tall) { tall++; high.push({ x: x, li: li, h: l.h }); }
        if (r.deep) { out++; deep.push({ x: x, f: f, turn: !!p.turn }); }
        row.push(r);
        x0 += f.along + S.GAP;
      });
      // The shelf's number and height, top right, on a tag of its own that's drawn after every set: a tall set at
      // that end of the shelf used to run through the words. A set standing under the tag starts its name below it.
      var bad = full || tall || out, text = (bad ? '! ' : '') + (li + 1) + ' · ' + cm(l.h) + ' cm', tw = (text.length * 1.28 + 1.6) * k;
      var tag = { x: T + c.w - 0.4 - tw, y: y + 0.4, w: tw, h: 3.7 * k };
      var says = ['Shelf ' + (li + 1), cm(l.h) + ' cm', row.length ? plural(row.length, 'set') : 'empty', full ? 'overfull' : '', tall ? (tall === 1 ? 'a set too tall' : tall + ' sets too tall') : '', out ? (out === 1 ? 'a set too deep' : out + ' sets too deep') : ''].filter(Boolean).join(', ');
      tags.push('<g role="img" aria-label="' + esc(says) + '"><rect x="' + tag.x.toFixed(2) + '" y="' + tag.y + '" width="' + tw.toFixed(2) + '" height="' + +tag.h.toFixed(2) + '" rx="' + +(1.85 * k).toFixed(2) + '" class="sv-tag' + (bad ? ' bad' : '') + '"/>' +
        '<text x="' + +(T + c.w - 0.4 - 0.8 * k).toFixed(2) + '" y="' + +(y + 0.4 + 2.7 * k).toFixed(2) + '" font-size="' + +(2.6 * k).toFixed(2) + '" class="sv-h' + (bad ? ' bad' : '') + '" text-anchor="end">' + text + '</text></g>');
      row.forEach(function (r, i) {
        var x = r.x, f = r.f, top = y + l.h - f.h, next = row[i + 1];
        // A small set is hard to hit with a thumb, so each takes taps on a clear rectangle at least HIT wide and
        // tall: up into the empty shelf above it, and sideways as far as halfway to its neighbours or the shelf's end.
        var left = i ? r.x0 - S.GAP / 2 : T, right = next ? next.x0 - S.GAP / 2 : Math.max(T + c.w, r.x0 + f.along);
        var hw = Math.max(f.along, Math.min(hit, right - left)), hx = Math.min(Math.max(left, r.x0 - (hw - f.along) / 2), right - hw);
        var hh = Math.max(f.h, Math.min(hit, l.h)), hy = y + l.h - hh;
        var off = !onShelf(x), bw = Math.max(0.5, f.along - 0.3), box = 'x="' + (r.x0 + 0.15) + '" y="' + top + '" width="' + bw + '" height="' + f.h + '" rx="0.8"';
        var name = [x.name || C.shortNum(x.num), shelfName(c, li), r.p.turn ? 'side-on' : '', r.tall ? 'too tall for this shelf' : '', r.deep ? 'too deep for this bookcase' : '',
          !off ? '' : x.state === 'apart' ? 'taken apart' : x.state === 'sealed' ? 'sealed' : 'not built'].filter(Boolean).join(', ');
        parts.push('<g class="sv-set' + (off ? ' off' : '') + '" data-set="' + esc(x.id) + '" role="button" tabindex="0" aria-label="' + esc(name) + '">' +
          '<rect x="' + hx.toFixed(2) + '" y="' + hy + '" width="' + hw.toFixed(2) + '" height="' + hh + '" class="sv-hit"/>' +
          // Shown when the set has the keyboard's focus: a light line outside the dark one round the set, so one of
          // them shows against whatever is beside it.
          '<rect x="' + (r.x0 - 0.45).toFixed(2) + '" y="' + (top - 0.6) + '" width="' + (bw + 1.2).toFixed(2) + '" height="' + (f.h + 1.2) + '" rx="1.3" class="sv-ring"/>' +
          '<rect ' + box + ' fill="' + colourOf(x) + '" class="sv-box' + (r.p.turn ? ' turned" stroke-dasharray="1.2 0.8' : '') + '"/>' +
          (off ? '<rect ' + box + ' fill="url(#svh' + n + ')" class="sv-hatch"/>' : '') +
          label(x, r.x0, top, f, tag, k) + '</g>');
      });
      y += l.h;
      parts.push('<rect x="0" y="' + y + '" width="' + W + '" height="' + T + '" class="sv-board' + (bad ? ' bad' : '') + '"/>');
      y += T;
    });
    var names = gone.slice(0, 3).map(nameOf), more = gone.length - names.length;
    var goneSays = !gone.length ? '' : gone.length === 1 ? names[0] + (gone[0].state === 'apart' ? ' is taken apart now.' : gone[0].state === 'sealed' ? ' is sealed now.' : ' isn’t built now.')
      : gone.length.toLocaleString() + ' sets here aren’t built now: ' + (more ? names.join(', ') + ' and ' + more.toLocaleString() + ' more.' : names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1] + '.');
    // Up to three sets too tall are named with their heights; more than that are counted (their shelves have the "!").
    var highSays = !high.length ? '' : high.length > 3 ? high.length.toLocaleString() + ' sets are too tall for their shelves. Move them to taller shelves.'
      : high.map(function (o) { return nameOf(o.x) + ' (' + cm(o.x.size.h) + ' cm) is too tall for shelf ' + (o.li + 1) + ' (' + cm(o.h) + ' cm).'; }).join(' ') + (high.length === 1 ? ' Move it to a taller shelf.' : ' Move them to taller shelves.');
    return '<section class="case">' +
      '<div class="case-hd"><div><h2>' + esc(c.name) + '</h2><div class="m">' + esc([c.room, cm(c.w) + ' × ' + cm(c.d) + ' cm inside', plural(c.levels.length, 'shelf').replace('shelfs', 'shelves'), plural(drawn, 'set')].filter(Boolean).join(' · ')) + '</div></div>' +
      '<button class="btn sm quiet" type="button" data-case="' + esc(c.id) + '" aria-label="Edit ' + esc(c.name) + '">Edit</button></div>' +
      (over.length ? '<p class="flag bad"><span>' + esc(over.join(' ')) + ' Move a set off, or turn one side-on.</span></p>' : '') +
      (high.length ? '<p class="flag bad"><span>' + esc(highSays) + '</span></p>' : '') +
      (deep.length ? '<p class="flag bad"><span>' + esc(deepSays(c, deep)) + '</span></p>' : '') +
      (gone.length ? '<p class="flag bad"><span>' + esc(goneSays) + '</span><button class="btn sm quiet" type="button" data-act="take-off" data-k="' + esc(c.id) + '">' + (gone.length === 1 ? 'Take it off the shelf' : 'Take them off') + '</button></p>' : '') +
      '<svg class="shelf" viewBox="0 0 ' + W + ' ' + H + '" style="--w:' + Math.round(W * 7) + 'px;--ar:' + (W / H).toFixed(3) + '" role="group" aria-label="' + esc(c.name) + ' from the front">' + parts.join('') + tags.join('') + '</svg></section>';
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

  // A set's name in its rectangle, never under 2.3 units tall on a Billy (about 10 px where one fills a phone's
  // width; it went down to 1.6, under 7 px), and `k` times that on a bookcase drawn smaller (caseHtml). In order: the whole
  // name across, on one line or two; the whole name up the side of a set that's taller than it's wide; the start of
  // the name with an ellipsis, across or up; the set's number; nothing. `tag` is the shelf's label: a set standing
  // under it keeps its name below it.
  function label(x, x0, top, f, tag, k) {
    var name = x.name || '', num = C.shortNum(x.num);
    var y0 = x0 + f.along > tag.x && top < tag.y + tag.h ? Math.min(top + f.h, tag.y + tag.h) : top, free = top + f.h - y0;
    var fs = Math.min(2.6 * k, Math.max(2.3 * k, f.along / 9)), across = free >= fs + k ? (f.along - k) / fs : 0;
    var vs = Math.min(2.6 * k, f.along - k), up = f.h > f.along && vs >= 2.3 * k ? (free - 1.6 * k) / vs : 0;
    var a = across ? shorten(name, across) : '', b = up ? shorten(name, up) : '', t, stand = false;
    var two = across && a !== name && free >= 2.2 * fs + 2 * k ? halves(name, across) : null, cx = x0 + f.along / 2;
    if (two) {
      return '<text y="' + (y0 + fs + 1.4 * k).toFixed(2) + '" font-size="' + fs.toFixed(2) + '" text-anchor="middle" class="sv-t"><tspan x="' + cx + '">' + esc(two[0]) + '</tspan><tspan x="' + cx + '" dy="1.15em">' + esc(two[1]) + '</tspan></text>';
    }
    if (a && a === name) t = a;
    else if (b && b === name) { t = b; stand = true; }
    else if (a) t = a;
    else if (b) { t = b; stand = true; }
    else if (num && ems(num) <= across) t = num;
    else if (num && ems(num) <= up) { t = num; stand = true; }
    else return '';
    if (!stand) return '<text x="' + cx + '" y="' + (y0 + Math.min(free / 2 + fs / 3, fs + 1.4 * k)).toFixed(2) + '" font-size="' + fs.toFixed(2) + '" text-anchor="middle" class="sv-t">' + esc(t) + '</text>';
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
    if (act === 'jump') jump(a.dataset.k);
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

  // Fit, with Undo: the bookcases it changed go back as they were.
  function fillAll() {
    var before = cases(), r = S.fill(before, sets()), moved = 0, kept = [];
    r.cases.forEach(function (c, i) { if (JSON.stringify(c.levels) !== JSON.stringify(before[i].levels)) { kept.push(copy(before[i])); put(c); } });
    moved = S.sort(sets(), r.cases).placed.length - S.sort(sets(), before).placed.length;
    render();
    if (!moved) { toast('Nothing else fits. See why under each set.'); return; }
    toast(plural(moved, 'set') + ' placed' + (r.left.length ? '; ' + r.left.length + ' didn’t fit' : ''), false, { label: 'Undo', run: function () {
      putCasesBack(kept); toast(moved === 1 ? 'Took that set off again' : 'Took those ' + moved.toLocaleString() + ' sets off again');
    } });
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
      var spot = spotName(c, at[id].l), room = c.room || x.room || '', skip = S.ON_SHELVES.indexOf(x.state) < 0;
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

  // Why a set can't stand the way that was asked for on a shelf where it does fit the other way round.
  function wayWhy(c, li, x, ids, turn) {
    var f = S.footprint(x, turn), l = c.levels[li], way = turn ? 'Side-on' : 'Facing out';
    if (f.deep > c.d) return way + ' it’s ' + cm(f.deep) + ' cm deep; the shelf is ' + cm(c.d) + '.';
    if (f.along > c.w) return way + ' it’s ' + cm(f.along) + ' cm wide; the shelf is ' + cm(c.w) + '.';
    var others = l.sets.filter(function (p) { return p.id !== x.id && ids[p.id] && S.hasSize(ids[p.id]); }).length;
    var left = Math.max(0, Math.round((c.w - S.used(l, ids, x.id) - (others ? S.GAP : 0)) * 10) / 10);
    return way + ' it needs ' + cm(f.along) + ' cm; ' + cm(left) + (left === 1 ? ' is left.' : ' are left.');
  }

  // One set: its size, where it stands, and moving it.
  function setSheet(id) {
    var x = byId()[id]; if (!x) return;
    var all = cases(), at = S.placements(all)[id], ids = byId(), z = x.size || {};
    // Each shelf is named with its bookcase: closed, the box showed "Shelf 2 (32 cm)" with three bookcases on the page.
    var opts = '<option value="">Not on a shelf</option>' + all.map(function (c) {
      return '<optgroup label="' + esc(c.name) + '">' + c.levels.map(function (l, li) {
        var here = at && at.c === c.id && at.l === li, f = S.fits(c, li, x, ids, here && at.turn);
        return '<option value="' + esc(c.id) + ':' + li + '"' + (here ? ' selected' : '') + (f.why && !here ? ' disabled' : '') + '>' + esc(c.name) + ' · shelf ' + (li + 1) + ' (' + cm(l.h) + ' cm)' + (f.why && !here ? ' · ' + esc(f.why.replace(/ \(.*\)/, '').toLowerCase()) : '') + '</option>';
      }).join('') + '</optgroup>';
    }).join('');
    var level = at ? caseOf(at.c).levels[at.l] : null, pos = level ? level.sets.findIndex(function (p) { return p.id === id; }) : -1;
    // Which set this is, under its name: two copies of one set, or two sets of one colour, looked the same here.
    var which = [C.shortNum(x.num), x.theme].filter(Boolean).join(' · ');
    // For a set that fits nowhere, the reason its row in the list gives; then whatever Save couldn't do.
    var stuck = !at && all.length && S.hasSize(x) ? S.whyNot(all, x, ids) : '';
    app.openSheet('<div class="hd"><h2 id="sheetTitle">' + esc(nameOf(x)) + '</h2><button class="btn sm quiet" type="button" data-close>Close</button></div><div class="bd">' +
      (which ? '<p class="note" id="z-which" style="margin-top:0">' + esc(which) + '</p>' : '') +
      '<div class="three">' +
      '<label class="field"><span>Width, cm</span><input id="z-w" inputmode="decimal" value="' + esc(z.w || '') + '"></label>' +
      '<label class="field"><span>Depth, cm</span><input id="z-d" inputmode="decimal" value="' + esc(z.d || '') + '"></label>' +
      '<label class="field"><span>Height, cm</span><input id="z-h" inputmode="decimal" value="' + esc(z.h || '') + '"></label></div>' +
      (all.length ? '<label class="field"><span>Where it stands</span><select id="z-where">' + opts + '</select></label>' : '') +
      (at ? '<label class="check"><input type="checkbox" id="z-turn"' + (at.turn ? ' checked' : '') + '> Stand it side-on (takes its depth along the shelf)</label>' : '') +
      '<p class="note warn" id="z-msg" role="status">' + esc(stuck) + '</p>' +
      (at ? '<div class="acts-row"><button class="btn quiet sm" type="button" id="z-left"' + (pos <= 0 ? ' disabled' : '') + '>Move left</button><button class="btn quiet sm" type="button" id="z-right"' + (pos >= level.sets.length - 1 ? ' disabled' : '') + '>Move right</button></div>' : '') +
      '</div><div class="ft"><a class="btn quiet" href="#catalog" id="z-cat">See in My sets</a><button class="btn" type="button" id="z-save">Save</button></div>',
      function () { return now() !== was; });
    // Its size and place as the sheet has them, to tell whether closing would lose a change.
    function now() { return app.fieldsOf(['z-w', 'z-d', 'z-h', 'z-where', 'z-turn']); }
    var was = now();
    // Each part of it as it was when the sheet opened, to tell which of them this sheet changed (save).
    function sizeNow() { return app.fieldsOf(['z-w', 'z-d', 'z-h']); }
    var held = { size: sizeNow(), where: $('z-where') ? $('z-where').value : '', turn: $('z-turn') ? $('z-turn').checked : false };
    // My sets opens on this set (app.showSet), once this sheet has closed.
    $('z-cat').onclick = function (e) { e.preventDefault(); app.showSet(id); };
    // What can't be done is said in the sheet, which stays open with nothing saved. (A tick that couldn't be
    // honoured used to close the sheet with the set as it was, and no word.)
    // The box it's about (the shelf chosen, or the side-on tick) is marked, takes the focus and has the reason as
    // its description, until it's changed.
    function refuse(why, box) {
      $('z-msg').textContent = why;
      ['z-where', 'z-turn'].forEach(function (k) { if ($(k)) { $(k).removeAttribute('aria-invalid'); $(k).removeAttribute('aria-describedby'); $(k).onchange = null; } });
      if (!why || !box) return;
      box.setAttribute('aria-invalid', 'true'); box.setAttribute('aria-describedby', 'z-msg'); box.focus();
      box.onchange = function () { refuse(''); };
    }
    // Save, and Move left or right (by -1 or 1), which save whatever else the sheet holds first: a size typed
    // before Move was thrown away.
    //
    // It changes what this sheet changed (the size, the shelf, the tick), on the set and the bookcases as they're
    // kept now, and works the set's place out afresh. The sheet shows them as they were when it opened, and used
    // to write that back: a size given to the set on another device, or in another tab, while the sheet was open
    // went again on Save.
    function save(by) {
      refuse('');
      // cm unless they say inches; what can't be read is turned down by app.lengths, which says which box.
      var z = app.lengths([['z-w', 'Width'], ['z-d', 'Depth'], ['z-h', 'Height']]);
      if (!z) return;
      var w = z.v['z-w'], d = z.v['z-d'], h = z.v['z-h'];
      var live = byId()[id], back = false;
      // The set was removed while the sheet was open: with nothing changed here (or a press on Move) it stays
      // removed; with changes, Save asks first, as it does in My sets.
      if (!live) {
        if (by || now() === was) { app.closeSheet(); render(); toast(nameOf(x) + ' was removed while this was open. Nothing was saved.'); return; }
        if (!app.secondTap($('z-save'), 'gone')) {
          $('z-save').textContent = 'Bring it back';
          toast('This set was removed while its sheet was open. Tap again to bring it back.');
          return;
        }
        live = x; back = true;
      }
      var y = copy(live), sized = sizeNow() !== held.size;
      if (w && d && h) { if (sized) y.size = { w: w, d: d, h: h }; }
      else if (!w && !d && !h) { if (sized) delete y.size; }
      else { app.wrong(['z-w', 'z-d', 'z-h'].map($).filter(function (b) { return !z.v[b.id]; }), 'Give all three sizes, or none.'); return; }
      var ids2 = byId(), list = cases(), next = list.map(copy), cur = S.placements(list)[id] || null;
      var from = cur ? cur.c + ':' + cur.l : '', ticked = !!$('z-turn') && $('z-turn').checked !== held.turn;
      // A box left as it was stands for where the set is now.
      var want = $('z-where') && $('z-where').value !== held.where ? $('z-where').value : from, turn = ticked ? $('z-turn').checked : !!(cur && cur.turn);
      var spot = cur ? list.filter(function (k) { return k.id === cur.c; })[0].levels[cur.l].sets.findIndex(function (p) { return p.id === id; }) : -1;
      ids2[id] = y;
      if (want !== from || (cur && turn !== cur.turn)) {
        // Off every bookcase first, so it can only ever stand in the one place chosen here.
        S.takeOff(next, id);
        if (want) {
          var bits = want.split(':'), c1 = next.filter(function (k) { return k.id === bits[0]; })[0], li = +bits[1];
          // The shelf chosen went while the sheet was open (its bookcase removed, or made shorter).
          if (!c1 || !c1.levels[li]) { refuse('That shelf isn’t there any more. Close this and open the set again.', $('z-where')); return; }
          var f = S.fits(c1, li, y, ids2, $('z-turn') ? turn : false);
          if (f.why) { refuse(f.why + '.', want === from && $('z-turn') ? $('z-turn') : $('z-where')); return; }
          // The tick was changed and this shelf only takes the set the other way round.
          if (ticked && !!f.turn !== turn) { refuse(wayWhy(c1, li, y, ids2, turn), $('z-turn')); return; }
          var p = { id: id }; if (f.turn) p.turn = true;
          if (cur && cur.c === c1.id && cur.l === li) c1.levels[li].sets.splice(spot, 0, p); else c1.levels[li].sets.push(p);
        }
      }
      var here = by ? S.placements(next)[id] : null;
      if (here) {
        var l = next.filter(function (k) { return k.id === here.c; })[0].levels[here.l], i = l.sets.findIndex(function (q) { return q.id === id; });
        var q = l.sets.splice(i, 1)[0]; l.sets.splice(Math.max(0, Math.min(l.sets.length, i + by)), 0, q);
      }
      if (back) app.putBack('sets', y);
      else if (JSON.stringify(y.size || null) !== JSON.stringify(live.size || null)) app.putSet(y);
      next.forEach(function (k, n) { if (JSON.stringify(k.levels) !== JSON.stringify(list[n].levels)) put(k); });
      app.closeSheet(); render();
      // What became of it, in a message: the sheet used to close without a word unless a size was read as inches,
      // and a set turned side-on differs in the drawing only by a dashed edge. A new shelf first (and side-on,
      // when that's the only way it fits there), or off the shelves; else the turn; else the move along the shelf.
      var to = S.placements(next)[id] || null, c2 = to && next.filter(function (k) { return k.id === to.c; })[0];
      var nth = to ? c2.levels[to.l].sets.findIndex(function (q) { return q.id === id; }) : -1;
      var said = back ? nameOf(y) + ' is back'
        : to && (!cur || cur.c !== to.c || cur.l !== to.l) ? nameOf(y) + ' is on ' + shelfName(c2, to.l) + (to.turn ? ', side-on' : '')
        : cur && !to ? 'Off the shelves'
        : to && !to.turn !== !cur.turn ? (to.turn ? 'Turned side-on' : 'Turned to face out')
        : to && nth !== spot ? (nth < spot ? 'Moved left' : 'Moved right')
        : 'Saved';
      toast(said + (z.note ? '. ' + z.note : ''));
    }
    if ($('z-left')) { $('z-left').onclick = function () { save(-1); }; $('z-right').onclick = function () { save(1); }; }
    $('z-save').onclick = function () { save(0); };
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
    var onIt = c ? Object.keys(S.placements([c])).filter(function (id) { return ids[id]; }).length : 0;
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
      '<p class="note">The height is the clear space above each shelf, up to the one above it. <span id="k-note">' + esc(isNew ? preset.note : MEASURE) + '</span></p>' +
      (onIt ? '<div><button class="btn sm quiet" type="button" id="k-clear">Take every set off</button></div>' : '') +
      '</div><div class="ft">' + (isNew ? '<span></span>' : '<button class="btn danger" type="button" id="k-del">Remove</button>') + '<button class="btn" type="button" id="k-save">' + (isNew ? 'Add bookcase' : 'Save') + '</button></div>',
      function () { return dirty(); });
    function dirty() { return now() !== was || $('k-room').value.trim() !== v.room; }
    // The bookcase as it's kept now. The sheet has it as it was when it opened, and a set stood on it since (from
    // another device or another tab), or taken off it, isn't in that copy. Null if it has been removed meanwhile:
    // then the sheet closes and says so.
    function kept() {
      var k = caseOf(c.id);
      if (!k) { app.closeSheet(); render(); toast(c.name + ' was removed while this was open. Nothing was saved.'); }
      return k;
    }
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
      $('k-note').textContent = p.note;
      was = now();
      if (p.k === 'custom') $('k-name').focus();
    };
    // Starting a bookcase again: Fit leaves placed sets where they are, so the way to a fresh arrangement was to
    // take each set off in its own sheet. It takes a second tap, and the message has Undo.
    if ($('k-clear')) $('k-clear').onclick = function () {
      if (!app.secondTap(this)) { this.textContent = 'Tap again to take ' + (onIt === 1 ? 'it' : 'all ' + onIt.toLocaleString()) + ' off'; return; }
      var k = kept(); if (!k) return;
      var before = copy(k), next = copy(k), all = byId(), n = Object.keys(S.placements([k])).filter(function (id) { return all[id]; }).length;
      next.levels.forEach(function (l) { l.sets = []; });
      put(next); app.closeSheet(); render();
      toast((n === 1 ? '1 set is' : n.toLocaleString() + ' sets are') + ' off ' + k.name, false, { label: 'Undo', run: function () {
        putCasesBack([before]); toast(n === 1 ? 'That set is back on its shelf' : 'Those ' + n.toLocaleString() + ' sets are back on their shelves');
      } });
    };
    if ($('k-del')) $('k-del').onclick = function () {
      if (!app.secondTap(this)) { this.textContent = 'Tap again to remove'; return; }
      var c = kept(); if (!c) return; // as it's kept now, so Undo puts back the sets that stand on it now
      var before = copy(c), ids = byId(), n = Object.keys(S.placements([c])).filter(function (id) { return ids[id]; }).length;
      // Sets that My sets says are on this bookcase, in the words Put these places in My sets writes ("Hall Billy,
      // shelf 2", spotName), stop saying so: the bookcase is gone. Not when another bookcase has the same name (or
      // one so long that it's written the same).
      var twin = cases().some(function (k) { return k.id !== c.id && spotName(k, 0) === spotName(c, 0); }), said = [];
      if (!twin) sets().forEach(function (x) {
        var m = /, shelf (\d+)$/.exec(x.spot || '');
        if (!m || +m[1] < 1 || +m[1] > c.levels.length || x.spot !== spotName(c, +m[1] - 1) || (c.room && x.room && x.room !== c.room)) return;
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
        putCasesBack([before]); toast(before.name + ' is back');
      } });
    };
    $('k-save').onclick = function () {
      // Removed while the sheet was open: with nothing changed here it stays removed; with changes, the first Save
      // asks, and the next puts the bookcase back as the sheet has it.
      var live = c ? caseOf(c.id) : null, gone = !!c && !live;
      if (gone) {
        if (!dirty()) { kept(); return; }
        if (!app.secondTap(this, 'gone')) {
          this.textContent = 'Bring it back';
          toast('This bookcase was removed while its sheet was open. Tap again to bring it back.');
          return;
        }
      }
      read();
      // Every size is cm unless it says inches, and one that can't be read keeps the sheet open (app.lengths).
      var boxes = [['k-w', 'Width'], ['k-d', 'Depth']].concat(rows.map(function (r, i) { return ['k-h' + i, 'Shelf ' + (i + 1)]; }));
      var z = app.lengths(boxes); if (!z) return;
      var blank = boxes.filter(function (b) { return !z.v[b[0]]; })[0];
      if (blank) {
        if (blank[0] === 'k-w' || blank[0] === 'k-d') app.wrong(['k-w', 'k-d'].map($).filter(function (b) { return !z.v[b.id]; }), 'Give the width and depth inside, in cm.');
        else app.wrong($(blank[0]), 'Give ' + blank[1].toLowerCase() + ' a height, or remove it.');
        return;
      }
      // Each row keeps the sets of the shelf it started as, as that shelf holds them now (it took them from the
      // copy made when the sheet opened: a set stood on the bookcase from another tab meanwhile came off again on
      // Save, and one moved to another bookcase stood on both). A bookcase being brought back takes the sets it had,
      // less any that stand somewhere else by now.
      var src = live || c, taken = gone ? S.placements(cases()) : {};
      var y = C.cleanCase({ id: c ? c.id : 'k' + app.newId().slice(1), name: $('k-name').value || 'Bookcase', room: $('k-room').value, w: z.v['k-w'], d: z.v['k-d'],
        levels: rows.map(function (r, i) { return { h: z.v['k-h' + i], sets: r.from >= 0 && src.levels[r.from] ? src.levels[r.from].sets.filter(function (p) { return !taken[p.id]; }) : [] }; }) });
      if (!y) { app.wrong([$('k-w'), $('k-d')], 'Give the width, depth and at least one shelf height.'); return; }
      // Sets on a shelf that was removed go back to the list, and the message says how many.
      var still = S.placements([y]), before = live ? copy(live) : null, all = byId();
      var off = live ? Object.keys(S.placements([live])).filter(function (id) { return all[id] && !still[id]; }).length : 0;
      if (gone) { tidy(y.id); app.putBack('cases', y); } else put(y);
      app.closeSheet(); render();
      // A new bookcase is named in a message, with Undo: the sheet used to close without a word. So does a Save
      // that had nothing else to say.
      var said = [isNew ? 'Added ' + y.name : gone ? y.name + ' is back' : '', off ? (off === 1 ? '1 set is' : off.toLocaleString() + ' sets are') + ' back in Not on a shelf yet' : '', z.note].filter(Boolean).join('. ') || 'Saved';
      if (isNew) toast(said, false, { label: 'Undo', run: function () { tidy(y.id); app.removeCase(y.id); render(); toast('Took ' + y.name + ' out again'); } });
      else if (off) toast(said, false, { label: 'Undo', run: function () { putCasesBack([before]); toast(before.name + ' is as it was'); } });
      else toast(said);
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
  // `dropped` is how many sizes in the link or file couldn't be read at all (S.cleanSizes). A size that looks wrong
  // for its set (S.sizeDoubt: 3 cm tall for 4,514 pieces, inches sent as cm) is shown with a Check line saying
  // why, and left unticked: it used to arrive ticked like the rest.
  function reviewSizes(list, dropped) {
    var rows = [], unknown = 0;
    list.forEach(function (z) {
      var mine = sets().filter(function (x) { return x.num === z.num; });
      if (!mine.length) unknown++;
      mine.forEach(function (x) { var doubt = S.sizeDoubt(z, x); rows.push({ x: x, z: z, doubt: doubt, on: !S.hasSize(x) && !doubt }); });
    });
    var doubts = rows.filter(function (r) { return r.doubt; }).length;
    // Sizes never add sets, so a list for sets that aren't here has nothing to fill in: say what it held and why
    // nothing happened, with the way to My sets.
    if (!rows.length) {
      toast((list.length === 1 ? 'That size is for a set that isn’t' : 'Those ' + list.length.toLocaleString() + ' sizes are for sets that aren’t') +
        ' in My sets. Sizes only fill in sets you’ve already added.', false, { label: 'My sets', run: function () { location.hash = '#catalog'; } });
      return;
    }
    app.openSheet('<div class="hd"><h2 id="sheetTitle">Add sizes</h2><button class="btn sm quiet" type="button" data-close>Not now</button></div><div class="bd">' +
      '<p class="note">Sizes Claude found for your sets. Sets that already have a size are unticked; tick one to replace it.' +
        (doubts ? ' ' + (doubts === 1 ? 'One size looks wrong and is' : doubts.toLocaleString() + ' sizes look wrong and are') + ' unticked too: check ' + (doubts === 1 ? 'it' : 'them') + ' before you tick.' : '') +
        (dropped ? ' ' + (dropped === 1 ? 'One size in the list' : dropped.toLocaleString() + ' sizes in the list') + ' couldn’t be read.' : '') +
        (unknown ? ' ' + (unknown === 1 ? 'One set in the list isn’t' : unknown.toLocaleString() + ' sets in the list aren’t') + ' in My sets.' : '') + '</p>' +
      '<ul class="rv" id="zr">' + rows.map(function (r, i) {
        return '<li class="' + (r.on ? '' : 'off') + '"><input type="checkbox" data-i="' + i + '"' + (r.on ? ' checked' : '') + ' aria-label="Add size for ' + esc(nameOf(r.x)) + '" aria-describedby="zr-d' + i + '">' +
          '<div class="pic none swatch" style="background:' + colourOf(r.x) + '"></div><div><div class="t">' + esc(r.x.name || C.shortNum(r.x.num)) + '</div><div id="zr-d' + i + '">' +
          '<div class="m">' + esc(C.shortNum(r.x.num)) + ' · ' + sizeText(r.z) + (S.hasSize(r.x) ? ' · replaces ' + sizeText(r.x.size) : '') + '</div>' + (r.z.note ? '<div class="m">' + esc(r.z.note) + '</div>' : '') +
          (r.doubt ? '<div class="w">Check: ' + esc(r.doubt) + '</div>' : '') + '</div></div></li>';
      }).join('') + '</ul></div>' +
      '<div class="ft"><span class="note" id="zr-n" aria-live="polite" style="margin:0"></span><button class="btn" type="button" id="zr-go">Add sizes</button></div>');
    // Counted the way Add sets from Claude counts: how many are ticked, on the button too, which waits for a tick.
    // (With none ticked it was a live "Add sizes" beside "0 sets", and pressing it answered "Nothing added".)
    function count() {
      var n = rows.filter(function (r) { return r.on; }).length;
      $('zr-n').textContent = n + ' of ' + rows.length + ' ticked';
      $('zr-go').textContent = n ? 'Add ' + plural(n, 'size') : 'Add sizes';
      $('zr-go').disabled = !n;
    }
    count();
    $('zr').onchange = function (e) { var r = rows[+e.target.dataset.i]; r.on = e.target.checked; e.target.closest('li').classList.toggle('off', !r.on); count(); };
    $('zr').onclick = app.tickRow;
    $('zr-go').onclick = function () {
      var n = 0;
      rows.forEach(function (r) {
        if (!r.on) return;
        var y = JSON.parse(JSON.stringify(r.x)); y.size = { w: r.z.w, d: r.z.d, h: r.z.h }; app.putSet(y); n++;
      });
      app.closeSheet(); render(); toast(plural(n, 'size') + ' added');
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
  // The words in a drawing are sized for the width it's drawn at (caseHtml), so a new width draws them again: a
  // phone turned on its side, a window dragged narrower. A phone's keyboard opening changes only the height.
  var sizedFor = window.innerWidth, resizing = 0;
  window.addEventListener('resize', function () {
    clearTimeout(resizing);
    resizing = setTimeout(function () {
      if (window.innerWidth === sizedFor && window.innerWidth <= 600) return;
      sizedFor = window.innerWidth;
      if (!$('shelves').hidden) render();
    }, 150);
  });
  // The catalog changed under the planner (Drive sync, or another tab).
  document.addEventListener('brickyard:changed', function () { if (!$('shelves').hidden) render(); });
  // For a sizes file opened from My sets' menu (js/app.js), which goes on to Add sizes here.
  window.BrickyardShelves = { reviewSizes: reviewSizes };
  route();
})();
