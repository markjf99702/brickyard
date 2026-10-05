// Brickyard's shelf planner logic: which way a set fits on a shelf, how full each shelf is, filling shelves
// with the sets that aren't on one yet, and sizes links from Claude. No DOM here, so tests can run it in Node.
//
// Sizes are a set's built size in cm: w across the front, d front to back, h tall. A set stands either
// facing out (w along the shelf) or turned side-on (d along the shelf).
(function (root) {
  'use strict';

  var GAP = 1; // cm between neighbouring sets on a shelf
  var ON_SHELVES = ['built', 'partial'];

  function hasSize(x) { return !!(x && x.size && x.size.w && x.size.d && x.size.h); }

  // How much shelf a set takes standing one way: {along, deep, h}.
  function footprint(x, turn) {
    var z = x.size;
    return turn ? { along: z.d, deep: z.w, h: z.h } : { along: z.w, deep: z.d, h: z.h };
  }

  // Width used on a level, given the sets on it and a lookup from id to set.
  function used(level, byId, skip) {
    var n = 0, total = 0;
    level.sets.forEach(function (p) {
      var x = byId[p.id];
      if (!x || p.id === skip || !hasSize(x)) return;
      total += footprint(x, p.turn).along; n++;
    });
    return total + (n > 1 ? (n - 1) * GAP : 0);
  }

  // Can set x go on level li of bookcase c (leaving out where it already is)? Returns the way it fits
  // ({turn}) or why not ({why}). Facing out is preferred; side-on only when facing out won't fit.
  function fits(c, li, x, byId, preferTurn) {
    if (!hasSize(x)) return { why: 'It needs a size' };
    var level = c.levels[li];
    if (x.size.h > level.h) return { why: 'Too tall (' + x.size.h + ' cm, the shelf has ' + level.h + ')' };
    var u = used(level, byId, x.id), others = level.sets.filter(function (p) { return p.id !== x.id && byId[p.id] && hasSize(byId[p.id]); }).length;
    var room = c.w - u - (others ? GAP : 0);
    var ways = preferTurn ? [true, false] : [false, true], why = '';
    for (var i = 0; i < 2; i++) {
      var f = footprint(x, ways[i]);
      if (f.deep > c.d) { why = why || 'Too deep (' + Math.min(x.size.w, x.size.d) + ' cm, the shelf is ' + c.d + ')'; continue; }
      if (f.along > room) { why = 'Not enough room left on this shelf'; continue; }
      return { turn: ways[i] };
    }
    return { why: why };
  }

  // Why a set fits on no shelf at all, or '' if it fits somewhere. Running out of room says more than being
  // too tall for some shelf, so it wins.
  function whyNot(cases, x, byId) {
    if (!hasSize(x)) return 'It needs a size';
    if (!cases.length) return 'No bookcases yet';
    var why = [];
    for (var i = 0; i < cases.length; i++) for (var li = 0; li < cases[i].levels.length; li++) {
      var f = fits(cases[i], li, x, byId);
      if (!f.why) return '';
      why.push(f.why);
    }
    if (why.some(function (w) { return /room/.test(w); })) return 'No room left on a shelf it fits';
    if (why.every(function (w) { return /deep/.test(w); })) return 'Too deep for every bookcase (' + Math.min(x.size.w, x.size.d) + ' cm)';
    if (why.every(function (w) { return /tall/.test(w); })) return 'Too tall for every shelf (' + x.size.h + ' cm)';
    return 'Too tall or too deep for every shelf';
  }

  // Where every set is: id → {c: case id, l: level index, turn}.
  function placements(cases) {
    var at = {};
    cases.forEach(function (c) {
      c.levels.forEach(function (l, li) { l.sets.forEach(function (p) { at[p.id] = { c: c.id, l: li, turn: !!p.turn }; }); });
    });
    return at;
  }

  // Sets that belong on shelves: built or partly built. Each is placed, waiting (has a size), or needs a size.
  function sort(sets, cases) {
    var at = placements(cases), out = { placed: [], waiting: [], noSize: [] };
    sets.forEach(function (x) {
      if (at[x.id]) out.placed.push(x);
      else if (ON_SHELVES.indexOf(x.state) < 0) return;
      else if (hasSize(x)) out.waiting.push(x);
      else out.noSize.push(x);
    });
    return out;
  }

  // Put every waiting set somewhere it fits, keeping sets already on shelves where they are. Tallest sets go
  // first, each on the shortest shelf that takes it, so tall shelves stay free for tall sets. Returns new
  // bookcases (the old ones aren't changed) and the sets that didn't fit, with why.
  function fill(cases, sets) {
    var byId = {}; sets.forEach(function (x) { byId[x.id] = x; });
    var out = JSON.parse(JSON.stringify(cases));
    var todo = sort(sets, out).waiting.slice().sort(function (a, b) {
      return b.size.h - a.size.h || Math.max(b.size.w, b.size.d) - Math.max(a.size.w, a.size.d) || String(a.name || '').localeCompare(String(b.name || ''));
    });
    var left = [];
    todo.forEach(function (x) {
      var best = null;
      out.forEach(function (c) {
        c.levels.forEach(function (l, li) {
          var f = fits(c, li, x, byId);
          if (f.why) return;
          var spare = l.h - x.size.h, rest = c.w - used(l, byId) - footprint(x, f.turn).along;
          if (!best || spare < best.spare || (spare === best.spare && rest < best.rest)) best = { c: c, l: l, turn: f.turn, spare: spare, rest: rest };
        });
      });
      if (!best) { left.push({ set: x, why: whyNot(out, x, byId) }); return; }
      var p = { id: x.id }; if (best.turn) p.turn = true;
      best.l.sets.push(p);
    });
    return { cases: out, left: left };
  }

  // Remove a set from wherever it is.
  function takeOff(cases, id) {
    cases.forEach(function (c) { c.levels.forEach(function (l) { l.sets = l.sets.filter(function (p) { return p.id !== id; }); }); });
  }

  // A sizes list from Claude: {"brickyard": 1, "sizes": [{"num": "10497", "w": 51, "d": 25, "h": 33}, ...]}.
  function cleanSizes(o) {
    var list = o && (o.sizes || (o.batch && o.batch.sizes));
    if (!Array.isArray(list)) return null;
    var out = [], seen = {};
    list.slice(0, 2000).forEach(function (y) {
      if (!y || typeof y !== 'object') return;
      var num = setNumOf(y.num || y.set), w = measureOf(y.w), d = measureOf(y.d), h = measureOf(y.h);
      if (!num || !w || !d || !h || seen[num]) return;
      seen[num] = 1;
      var row = { num: num, w: w, d: d, h: h };
      var note = typeof y.note === 'string' ? y.note.replace(/\s+/g, ' ').trim().slice(0, 200) : '';
      if (note) row.note = note;
      out.push(row);
    });
    return out.length ? out : null;
  }
  // Same rules as js/core.js (setNum, measure), repeated so this file stands on its own.
  function setNumOf(v) {
    var t = (typeof v === 'number' || typeof v === 'string' ? String(v) : '').replace(/\s+/g, ' ').trim().slice(0, 40).toLowerCase().replace(/^(set|no\.?|#)\s*/, '').replace(/\s+/g, '');
    var m = /^([0-9]{3,7}|[a-z]{1,8}[0-9]{2,7}[a-z]?)(?:-([0-9]{1,2}))?$/.exec(t);
    return m ? m[1] + '-' + (m[2] ? String(parseInt(m[2], 10)) : '1') : '';
  }
  function measureOf(v) {
    var x = typeof v === 'number' ? v : parseFloat(String(v == null ? '' : v).replace(',', '.'));
    if (!isFinite(x) || x <= 0) return 0;
    return Math.min(500, Math.round(x * 10) / 10);
  }

  // brickyard/#z1z… carries a sizes list as deflated JSON in base64url (#z1j… uncompressed).
  function sizesText(h) {
    var m = /#(z1[zj])([A-Za-z0-9_-]+)/.exec(String(h || ''));
    if (!m) return Promise.resolve('');
    var bin = atob(m[2].replace(/-/g, '+').replace(/_/g, '/')), bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    if (m[1] === 'z1j') return Promise.resolve(new TextDecoder().decode(bytes));
    if (typeof DecompressionStream === 'undefined') return Promise.reject(new Error('This browser is too old to open Brickyard links.'));
    return new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).text();
  }
  function isSizesLink(t) { return /#z1[zj][A-Za-z0-9_-]+\s*$/.test(String(t || '').trim()); }
  function parseSizes(t) {
    t = String(t || '').trim();
    if (t.charAt(0) !== '{' && isSizesLink(t)) return sizesText(t).then(parseSizes);
    return Promise.resolve().then(function () {
      var z = cleanSizes(JSON.parse(t));
      if (!z) throw new Error('empty');
      return z;
    });
  }

  var api = { GAP: GAP, ON_SHELVES: ON_SHELVES, hasSize: hasSize, footprint: footprint, used: used, fits: fits, whyNot: whyNot, placements: placements, sort: sort,
    fill: fill, takeOff: takeOff, cleanSizes: cleanSizes, sizesText: sizesText, isSizesLink: isSizesLink, parseSizes: parseSizes };
  if (typeof module === 'object' && module.exports) module.exports = api; else root.ShelfCore = api;
})(this);
