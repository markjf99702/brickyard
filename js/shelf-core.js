// Brickyard's shelf planner logic: which way a set fits on a shelf, how full each shelf is, filling shelves
// with the sets that aren't on one yet, and sizes links from Claude. No DOM here, so tests can run it in Node.
//
// Sizes are a set's built size in cm: w across the front, d front to back, h tall. A set stands either
// facing out (w along the shelf) or turned side-on (d along the shelf).
(function (root) {
  'use strict';

  var GAP = 1; // cm between neighbouring sets on a shelf
  var CLEAR = 1; // cm Fit keeps clear above a set, so there's room to lift it in and out
  var EYE = 140, BOARD = 2; // cm: the height Fit fills from, and the board under each shelf when working that out
  var ON_SHELVES = ['built', 'partial'];

  function hasSize(x) { return !!(x && x.size && x.size.w && x.size.d && x.size.h); }

  // How much shelf a set takes standing one way: {along, deep, h}.
  function footprint(x, turn) {
    var z = x.size;
    return turn ? { along: z.d, deep: z.w, h: z.h } : { along: z.w, deep: z.d, h: z.h };
  }

  // Sizes are kept to 0.1 cm, and widths are added up and compared in whole tenths: in a computer's arithmetic
  // 76 - 11.4 - 1 is 63.599999999999994, so two sets that filled a shelf exactly were told there was no room.
  function tenths(x) { return Math.round(x * 10); }

  // Width used on a level, given the sets on it and a lookup from id to set.
  function used(level, byId, skip) {
    var n = 0, total = 0;
    level.sets.forEach(function (p) {
      var x = byId[p.id];
      if (!x || p.id === skip || !hasSize(x)) return;
      total += tenths(footprint(x, p.turn).along); n++;
    });
    return (total + (n > 1 ? (n - 1) * tenths(GAP) : 0)) / 10;
  }
  // Whether what's on a level takes more width than the bookcase has.
  function overfull(c, level, byId) { return tenths(used(level, byId)) > tenths(c.w); }

  // Can set x go on level li of bookcase c (leaving out where it already is)? Returns the way it fits
  // ({turn}) or why not ({why}). Facing out is preferred; side-on only when facing out won't fit. Only a shelf
  // that would take the set if it were empty is short of room; otherwise the set is too deep, too wide, or too
  // wide facing out and too deep side-on ("too big"). By hand a set can stand on a shelf exactly its height; Fit
  // asks for `clear` cm above it as well, and a shelf that is tall enough but for that says so with `near`.
  function fits(c, li, x, byId, preferTurn, clear) {
    if (!hasSize(x)) return { why: 'It needs a size' };
    var level = c.levels[li];
    if (x.size.h > level.h) return { why: 'Too tall (' + x.size.h + ' cm, the shelf has ' + level.h + ')' };
    if (clear && tenths(x.size.h) + tenths(clear) > tenths(level.h)) return { why: 'Too tall with ' + clear + ' cm clear above it (' + x.size.h + ' cm, the shelf has ' + level.h + ')', near: true };
    var u = used(level, byId, x.id), others = level.sets.filter(function (p) { return p.id !== x.id && byId[p.id] && hasSize(byId[p.id]); }).length;
    var room = tenths(c.w) - tenths(u) - (others ? tenths(GAP) : 0); // in tenths of a cm
    var ways = preferTurn ? [true, false] : [false, true], deep = 0, wide = 0;
    for (var i = 0; i < 2; i++) {
      var f = footprint(x, ways[i]);
      if (f.deep > c.d) { deep++; continue; }
      if (f.along > c.w) { wide++; continue; }
      if (tenths(f.along) > room) continue;
      return { turn: ways[i] };
    }
    var least = Math.min(x.size.w, x.size.d);
    if (deep === 2) return { why: 'Too deep (' + least + ' cm, the shelf is ' + c.d + ')' };
    if (wide === 2) return { why: 'Too wide (' + least + ' cm, the shelf is ' + c.w + ')' };
    if (deep && wide) return { why: 'Too big (' + x.size.w + ' × ' + x.size.d + ' cm, the shelf is ' + c.w + ' × ' + c.d + ')' };
    return { why: 'Not enough room left on this shelf' };
  }

  // Why a set fits on no shelf at all, or '' if it fits somewhere. Running out of room says more than being
  // too tall for some shelf, so it wins. A reason with a size in it gives both sizes, the set's and the biggest
  // there is to put it in: "Too deep for every bookcase (32 cm)" under a bookcase whose shelves are all labelled
  // 32 cm (their height) read as the bookcase's own size. A set can stand either way round, so its depth or width
  // here is the lesser of the two, "even side-on" when that's the way that gives it. With `clear` (Fit's rule: that
  // many cm above the set) a set that only a shelf of its own height could take says what it needs.
  function whyNot(cases, x, byId, clear) { return reason(cases, x, byId, clear).why; }
  // The same with its kind, for counting: { why, kind } where kind is '' (it fits somewhere), 'size', 'none' (no
  // bookcases), 'room', 'deep', 'tall', 'clear' (tall enough a shelf, but for the space above), 'wide' or 'big'
  // (anything else).
  function reason(cases, x, byId, clear) {
    if (!hasSize(x)) return { why: 'It needs a size', kind: 'size' };
    if (!cases.length) return { why: 'No bookcases yet', kind: 'none' };
    var why = [], near = false;
    for (var i = 0; i < cases.length; i++) for (var li = 0; li < cases[i].levels.length; li++) {
      var f = fits(cases[i], li, x, byId, false, clear);
      if (!f.why) return { why: '', kind: '' };
      why.push(f.why); if (f.near) near = true;
    }
    var all = function (re) { return why.every(function (w) { return re.test(w); }); };
    var most = function (of) { return Math.max.apply(null, cases.map(of)); }, one = cases.length === 1;
    var least = Math.min(x.size.w, x.size.d);
    if (why.some(function (w) { return /room/.test(w); })) return { why: 'No room left on a shelf it fits', kind: 'room' };
    if (all(/deep/)) {
      return { kind: 'deep', why: least + ' cm deep' + (x.size.d > least ? ' even side-on' : '') + '; your ' + (one ? 'bookcase is ' : 'deepest bookcase is ') + most(function (c) { return c.d; }) + ' cm' + (one ? ' deep' : '') };
    }
    if (all(/tall/)) {
      if (near) return { kind: 'clear', why: x.size.h + ' cm tall: needs ' + (tenths(x.size.h) + tenths(clear)) / 10 + ' cm of space' };
      var hs = [].concat.apply([], cases.map(function (c) { return c.levels.map(function (l) { return l.h; }); }));
      return { kind: 'tall', why: x.size.h + ' cm tall; your ' + (hs.length === 1 ? 'shelf is ' : 'tallest shelf is ') + Math.max.apply(null, hs) + ' cm' + (hs.length === 1 ? ' tall' : '') };
    }
    if (all(/wide/)) {
      return { kind: 'wide', why: least + ' cm wide' + (x.size.w > least ? ' even side-on' : '') + '; your ' + (one ? 'bookcase is ' : 'widest bookcase is ') + most(function (c) { return c.w; }) + ' cm' + (one ? ' wide' : '') };
    }
    if (all(/deep|wide|big/)) return { kind: 'big', why: 'At ' + x.size.w + ' × ' + x.size.d + ' cm, too big for ' + (one ? 'your bookcase' : 'every bookcase') };
    if (all(/deep|tall/)) return { kind: 'big', why: 'Too tall or too deep for every shelf' };
    return { kind: 'big', why: 'Too big for every shelf' };
  }

  // How much more shelf the sets that have run out of room would take, in cm: each one's width along the shelf the
  // way Fit would stand it (facing out if some shelf takes it that way when empty, else side-on), and the gap beside
  // it. The bits of shelf still free aren't taken off: each is too short for any of these sets, which is why they're
  // waiting. It's a guide to how many more shelves to find, not a promise that they'd pack that tightly.
  function shelfNeeded(sets, cases, clear) {
    var total = 0;
    sets.forEach(function (x) {
      if (!hasSize(x)) return;
      var out = cases.some(function (c) {
        return x.size.d <= c.d && x.size.w <= c.w && c.levels.some(function (l) { return tenths(x.size.h) + tenths(clear || 0) <= tenths(l.h); });
      });
      total += tenths(footprint(x, !out).along) + tenths(GAP);
    });
    return total / 10;
  }

  // Where every set is: id → {c: case id, l: level index, turn}.
  function placements(cases) {
    var at = {};
    cases.forEach(function (c) {
      c.levels.forEach(function (l, li) { l.sets.forEach(function (p) { at[p.id] = { c: c.id, l: li, turn: !!p.turn }; }); });
    });
    return at;
  }

  // Sets that belong on shelves: built or partly built. Each is placed, waiting (has a size), or needs a size. A
  // set that's on a shelf but has lost its size isn't drawn (there's nothing to draw it by), so it is listed under
  // noSize as well, where it can be found and given one.
  function sort(sets, cases) {
    var at = placements(cases), out = { placed: [], waiting: [], noSize: [] };
    sets.forEach(function (x) {
      var mine = ON_SHELVES.indexOf(x.state) >= 0;
      if (at[x.id]) { out.placed.push(x); if (mine && !hasSize(x)) out.noSize.push(x); }
      else if (!mine) return;
      else if (hasSize(x)) out.waiting.push(x);
      else out.noSize.push(x);
    });
    return out;
  }

  // A set stands in one place. Two devices can each save a bookcase with the same set on it (one moved it, the
  // other hadn't heard), and merging keeps both bookcases whole. The set stays on the bookcase changed last (the
  // later id when they tie) and, within one bookcase, on its first shelf. Bookcases that lose nothing come back
  // as they are; the others as copies.
  function dedupe(cases) {
    var keep = {}, later = function (a, b) { return (a.t || 0) > (b.t || 0) || ((a.t || 0) === (b.t || 0) && String(a.id) > String(b.id)); };
    cases.forEach(function (c) {
      c.levels.forEach(function (l) { l.sets.forEach(function (p) { if (!keep[p.id] || later(c, keep[p.id])) keep[p.id] = c; }); });
    });
    return cases.map(function (c) {
      var seen = {}, extra = false;
      c.levels.forEach(function (l) { l.sets.forEach(function (p) { if (keep[p.id] !== c || seen[p.id]) extra = true; seen[p.id] = 1; }); });
      if (!extra) return c;
      var out = JSON.parse(JSON.stringify(c)); seen = {};
      out.levels.forEach(function (l) {
        l.sets = l.sets.filter(function (p) { if (keep[p.id] !== c || seen[p.id]) return false; seen[p.id] = 1; return true; });
      });
      return out;
    });
  }

  // Put every waiting set somewhere it fits, keeping sets already on shelves where they are. Returns new bookcases
  // (the old ones aren't changed) and the sets that didn't fit, with why.
  //
  // The sets are taken tallest first, each put on the best shelf there is for it then (fillOnce, below). Taking them
  // in one order only can leave out a set that another order finds room for, so eight ways are tried: four
  // orders, each filling the fullest shelf first and then again the emptiest first. Tallest first on the fullest
  // shelf is what's kept unless another way places more sets (in 200 made-up collections that was 1 in 4 of them);
  // of the ways that place the most, the one with fewest sets side-on.
  var ORDERS = [
    function (a, b) { return b.size.h - a.size.h || Math.max(b.size.w, b.size.d) - Math.max(a.size.w, a.size.d); }, // tallest
    function (a, b) { return b.size.w - a.size.w || b.size.h - a.size.h; }, // widest
    function (a, b) { return b.size.w * b.size.h - a.size.w * a.size.h; }, // biggest from the front
    function (a, b) { return b.size.h - a.size.h || a.size.w - b.size.w; }, // tallest, the narrower of them first
  ];
  function fill(cases, sets) {
    var byId = {}; sets.forEach(function (x) { byId[x.id] = x; });
    var first = null, best = null;
    ORDERS.forEach(function (order) {
      [false, true].forEach(function (spread) {
        var r = fillOnce(cases, sets, byId, order, spread);
        if (!first) first = best = r;
        else if (r.left.length < best.left.length || (r.left.length === best.left.length && best !== first && r.turned < best.turned)) best = r;
      });
    });
    return { cases: best.cases, left: best.left };
  }
  // One way of filling. For each set the best shelf is, most important first: one in the set's own room (a set with
  // a room in My sets goes on a bookcase in that room when one takes it, and anywhere only when none does; sets and
  // bookcases with no room are placed as ever); the shortest that takes it with CLEAR cm above it, so tall shelves
  // stay free for tall sets; one that takes it facing out before one where it has to turn side-on (it used to turn
  // on the first shelf it came to while the next one still had room for it facing out); the one it fills most
  // nearly (or, with `spread`, the one with most room left); and the one nearest eye level (it used to be the top).
  function fillOnce(cases, sets, byId, order, spread) {
    var out = JSON.parse(JSON.stringify(cases));
    var todo = sort(sets, out).waiting.slice().sort(function (a, b) {
      return order(a, b) || String(a.name || '').localeCompare(String(b.name || '')) || (String(a.id) < String(b.id) ? -1 : 1);
    });
    var left = [], turned = 0;
    todo.forEach(function (x) {
      var best = null;
      out.forEach(function (c) {
        c.levels.forEach(function (l, li) {
          var f = fits(c, li, x, byId, false, CLEAR);
          if (f.why) return;
          var rest = tenths(c.w) - tenths(used(l, byId)) - tenths(footprint(x, f.turn).along);
          var key = [x.room && !sameRoom(x.room, c.room) ? 1 : 0, tenths(l.h) - tenths(x.size.h), f.turn ? 1 : 0, spread ? -rest : rest, eyeGap(c, li)];
          if (!best || before(key, best.key)) best = { l: l, turn: f.turn, key: key };
        });
      });
      if (!best) { left.push(x); return; }
      var p = { id: x.id }; if (best.turn) { p.turn = true; turned++; }
      best.l.sets.push(p);
    });
    return { cases: out, turned: turned, left: left.map(function (x) { return { set: x, why: whyNot(out, x, byId, CLEAR) }; }) };
  }
  // How far the middle of a shelf is from eye level, in tenths of a cm, taking the bookcase to stand on the floor
  // with a board under each shelf. levels[0] is the top shelf.
  function eyeGap(c, li) {
    var y = BOARD;
    for (var i = c.levels.length - 1; i > li; i--) y += c.levels[i].h + BOARD;
    return Math.abs(tenths(y + c.levels[li].h / 2) - tenths(EYE));
  }
  // Rooms are typed by hand in two places, so "Office" and "office " are the same room.
  function sameRoom(a, b) { var f = function (t) { return String(t || '').replace(/\s+/g, ' ').trim().toLowerCase(); }; return !!f(a) && f(a) === f(b); }
  function before(a, b) {
    for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i];
    return false;
  }

  // Remove a set from wherever it is.
  function takeOff(cases, id) {
    cases.forEach(function (c) { c.levels.forEach(function (l) { l.sets = l.sets.filter(function (p) { return p.id !== id; }); }); });
  }

  // A sizes list from Claude: {"brickyard": 1, "sizes": [{"num": "10497", "w": 52, "d": 32, "h": 13}, ...]}.
  // A row without a set number or one of its three sides is left out, and so is one with a side over 500 cm (it
  // used to be made 500: a Millennium Falcon sent in mm arrived as 500 x 500 x 210 cm). `tally`, when given, gets
  // how many rows were left out that way (tally.dropped), for the page to say so.
  function cleanSizes(o, tally) {
    var list = o && (o.sizes || (o.batch && o.batch.sizes));
    if (!Array.isArray(list)) return null;
    var out = [], seen = {}, dropped = 0;
    list.slice(0, 2000).forEach(function (y) {
      if (!y || typeof y !== 'object') { dropped++; return; }
      var num = setNumOf(y.num || y.set), w = measureOf(y.w), d = measureOf(y.d), h = measureOf(y.h);
      if (!num || !w || !d || !h) { dropped++; return; }
      if (seen[num]) return;
      seen[num] = 1;
      var row = { num: num, w: w, d: d, h: h };
      var note = typeof y.note === 'string' ? y.note.replace(/\s+/g, ' ').trim().slice(0, 200) : '';
      if (note) row.note = note;
      out.push(row);
    });
    if (tally) tally.dropped = dropped;
    return out.length ? out : null;
  }

  // Whether a size from Claude looks wrong for set x: '' or a few words saying why, for the page to show beside
  // it and leave it unticked. Three checks: a side under 1.5 cm or over 150 cm; for a set with a piece count, less
  // than 1 or more than 80 cubic cm of box per piece (real sets looked at ran from 1.2 for the flat World Map to 48
  // for the Eiffel Tower; a 4,514-piece castle sent as 3 cm tall is 0.96, and inches sent as cm 0.78); and, where
  // the set has a size already, a height or footprint more than half as big again or under half of it (the
  // footprint's two sides are compared smaller to smaller, since a set can be measured either way round). These
  // limits are an estimate made for this page from that handful of sets, not a published rule: they only untick
  // a row and ask, they never stop a size being added.
  function sizeDoubt(z, x) {
    var sides = [[z.w, 'wide'], [z.d, 'deep'], [z.h, 'tall']].sort(function (a, b) { return a[0] - b[0]; }), least = sides[0], most = sides[2];
    if (least[0] < 1.5) return 'Only ' + least[0] + ' cm ' + least[1] + '?';
    if (most[0] > 150) return most[0] + ' cm ' + most[1] + '?';
    var pieces = x && x.pieces > 0 ? x.pieces : 0, each = pieces ? z.w * z.d * z.h / pieces : 0;
    if (pieces && each < 1) return least[0] + ' cm ' + least[1] + ' for ' + pieces.toLocaleString('en') + ' pieces?';
    if (pieces && each > 80) return most[0] + ' cm ' + most[1] + ' for ' + pieces.toLocaleString('en') + (pieces === 1 ? ' piece?' : ' pieces?');
    if (hasSize(x)) {
      var far = function (a, b) { return a > b * 1.5 || a < b * 0.5; }, o = x.size;
      if (far(z.h, o.h) || far(Math.min(z.w, z.d), Math.min(o.w, o.d)) || far(Math.max(z.w, z.d), Math.max(o.w, o.d))) return 'Very different from the size it has now.';
    }
    return '';
  }
  // Same rules as js/core.js (setNum, measure), repeated so this file stands on its own, but for one thing: a side
  // over 500 cm is no size at all here (0), where measure makes it 500.
  function setNumOf(v) {
    var t = (typeof v === 'number' || typeof v === 'string' ? String(v) : '').replace(/\s+/g, ' ').trim().slice(0, 40).toLowerCase().replace(/^(?:lego[®™]?\s*)?(?:(?:set|no\.?|#)\s*)*/, '').replace(/\s+/g, '');
    var m = /^([0-9]{3,7}|[a-z]{1,8}[0-9]{2,7}[a-z]?)(?:-([0-9]{1,2}))?$/.exec(t);
    return m ? m[1] + '-' + (m[2] ? String(parseInt(m[2], 10)) : '1') : '';
  }
  function measureOf(v) {
    var x = typeof v === 'number' ? v : parseFloat(String(v == null ? '' : v).replace(',', '.'));
    if (!isFinite(x) || x <= 0) return 0;
    x = Math.round(x * 10) / 10;
    return x > 500 ? 0 : x;
  }

  // brickyard/#z1z… carries a sizes list as deflated JSON in base64url (#z1j… uncompressed); #z2z… and #z2j… are
  // the same with a check on the end.
  function sizesText(h) {
    var m = /#(z[12][zj])([A-Za-z0-9_-]+)/.exec(String(h || ''));
    if (!m) return Promise.resolve('');
    // Inside the promise, so a link cut short (which atob refuses) is turned down instead of throwing.
    var unpack = function (body) {
      return Promise.resolve().then(function () {
        var bin = atob(body.replace(/-/g, '+').replace(/_/g, '/')), bytes = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        if (m[1].charAt(2) === 'j') return new TextDecoder().decode(bytes);
        if (typeof DecompressionStream === 'undefined') throw new Error('This browser is too old to open Brickyard links.');
        return new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).text();
      });
    };
    if (m[1].charAt(1) === '1') return lessEnd(m[2], unpack);
    // The checked form (#z2z…): seven characters on the end are a check of the rest, as in js/core.js (linkText,
    // linkCheck), and a link they don't fit has a wrong or missing character.
    var body = m[2].replace(/[-_]+$/, ''), data = body.slice(0, -7);
    if (body.length < 8 || linkCheck(m[1] + data) !== body.slice(-7)) return Promise.reject(new Error('This Brickyard link has a wrong or missing character'));
    return unpack(data);
  }
  function linkCheck(t) {
    var h = 2166136261 >>> 0;
    for (var i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    var c = h.toString(36);
    return '0000000'.slice(c.length) + c;
  }
  // A link with a dash or an underscore stuck to its end (markdown's _link_) is tried again without it, as in
  // js/core.js (lessEnd).
  function lessEnd(body, unpack, n) {
    var text = n ? body.slice(0, -n) : body;
    return unpack(text).catch(function (e) {
      if ((n || 0) >= 3 || !/[-_]$/.test(text) || (e && /browser/.test(e.message))) throw e;
      return lessEnd(body, unpack, (n || 0) + 1);
    });
  }
  // Pasted text can carry more than the link or the file (a sentence around the link, ```json fences around the
  // file), so the link is found wherever it is, and the JSON is what runs from the first { to the last }, as in
  // js/core.js (parseIncoming).
  function isSizesLink(t) { return /#z[12][zj][A-Za-z0-9_-]+/.test(String(t || '')); }
  function parseSizes(t) {
    t = String(t || '').trim();
    if (t.charAt(0) !== '{' && isSizesLink(t)) return sizesText(t).then(parseSizes);
    return Promise.resolve().then(function () {
      var i = t.indexOf('{'), j = t.lastIndexOf('}');
      var z = cleanSizes(JSON.parse(i >= 0 && j > i ? t.slice(i, j + 1) : t));
      if (!z) throw new Error('empty');
      return z;
    });
  }

  var api = { GAP: GAP, CLEAR: CLEAR, ON_SHELVES: ON_SHELVES, hasSize: hasSize, footprint: footprint, used: used, overfull: overfull, fits: fits, whyNot: whyNot, reason: reason, shelfNeeded: shelfNeeded, placements: placements, sort: sort, dedupe: dedupe,
    fill: fill, takeOff: takeOff, cleanSizes: cleanSizes, sizeDoubt: sizeDoubt, sizesText: sizesText, isSizesLink: isSizesLink, parseSizes: parseSizes };
  if (typeof module === 'object' && module.exports) module.exports = api; else root.ShelfCore = api;
})(this);
