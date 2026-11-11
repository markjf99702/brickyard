// Brickyard's model logic for "Build from your box": parts on the stud grid, the checks that say whether a
// model can really be built from your pieces, and links. No DOM here, so tests can run it in Node, and
// skill/brickyard-designer/scripts/check_model.py does the same checks the same way.
//
// Coordinates: x runs left to right and z back to front, both in studs; y runs up, in plates (a brick is 3).
// A part's x, y, z is the back-left-bottom corner of its footprint after turning. r turns it 0, 90, 180 or
// 270 degrees; at 90 a part's own width runs front to back. s is the step it goes on in.
(function (root) {
  'use strict';

  // Other numbers for the same piece (parts/aliases.json): the everyday number BrickLink and Rebrickable use,
  // which LDraw keeps as "moved to" its current one. shapes.json knows each piece under one number only, so a
  // part number is read as that one wherever it comes in: a model's parts, and the pieces of a set or a lot.
  // check_model.py reads the same table the same way (canon).
  var ALIAS = {};
  function useAliases(map) { ALIAS = map && typeof map === 'object' ? map : {}; }
  function canon(p) { return Object.prototype.hasOwnProperty.call(ALIAS, p) && typeof ALIAS[p] === 'string' ? ALIAS[p] : p; }

  function turnSize(sh, r) { return r === 90 || r === 270 ? { w: sh.d, d: sh.w } : { w: sh.w, d: sh.d }; }

  // A cell of the part's own footprint (cx along its width, cz along its depth) → a cell of the turned footprint.
  function turnCell(sh, r, cx, cz) {
    if (r === 90) return [sh.d - 1 - cz, cx];
    if (r === 180) return [sh.w - 1 - cx, sh.d - 1 - cz];
    if (r === 270) return [cz, sh.w - 1 - cx];
    return [cx, cz];
  }

  function maskCells(sh, mask) {
    if (mask === 'none') return [];
    if (mask === 'all' || !mask) {
      var all = [];
      for (var cx = 0; cx < sh.w; cx++) for (var cz = 0; cz < sh.d; cz++) all.push([cx, cz]);
      return all;
    }
    return mask;
  }

  // World cells of a placed part: its studs on top, the places underneath that take a stud, and its footprint.
  function placed(sh, q) {
    var turn = function (c) { var t = turnCell(sh, q.r, c[0], c[1]); return [q.x + t[0], q.z + t[1]]; };
    return { top: maskCells(sh, sh.top).map(turn), bot: maskCells(sh, sh.bot).map(turn), foot: maskCells(sh, 'all').map(turn) };
  }

  function int(v, lo, hi) {
    var n = typeof v === 'number' ? v : parseInt(v, 10);
    if (!isFinite(n)) return null;
    n = Math.round(n);
    return n < lo || n > hi ? null : n;
  }

  // A model from anywhere: {name, about, sets: [...], parts: [[p, c, x, y, z, r, s], ...]} (objects work too).
  function cleanModel(o) {
    var m = o && (o.model || o);
    if (!m || typeof m !== 'object' || !Array.isArray(m.parts)) return null;
    var parts = [];
    m.parts.slice(0, 5000).forEach(function (q) {
      if (Array.isArray(q)) q = { p: q[0], c: q[1], x: q[2], y: q[3], z: q[4], r: q[5], s: q[6] };
      if (!q || typeof q !== 'object') return;
      var p = String(q.p == null ? '' : q.p).toLowerCase().replace(/\.dat$/, '').replace(/[^a-z0-9]/g, '').slice(0, 20);
      var c = int(q.c, 0, 100000), x = int(q.x, -200, 200), y = int(q.y, 0, 600), z = int(q.z, -200, 200);
      var r = int(q.r, 0, 270); if (r === null) r = 0;
      var s = int(q.s, 1, 2000);
      if (!p || c === null || x === null || y === null || z === null || r % 90) return;
      parts.push([canon(p), c, x, y, z, r, s || 0]);
    });
    if (!parts.length) return null;
    // No steps given: one step per height, bottom up.
    if (parts.some(function (q) { return !q[6]; })) {
      var ys = parts.map(function (q) { return q[3]; }).filter(function (v, i, a) { return a.indexOf(v) === i; }).sort(function (a, b) { return a - b; });
      parts.forEach(function (q) { if (!q[6]) q[6] = ys.indexOf(q[3]) + 1; });
    }
    var str = function (v, n) { return typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, n) : ''; };
    // The sets it's built from: a list of set numbers, or one on its own ("10698-1" is not seven sets, one a
    // letter). Anything else is no sets; check_model.py (set_names) reads them the same way, and warns.
    var sets = typeof m.sets === 'string' ? [m.sets] : Array.isArray(m.sets) ? m.sets : [];
    return {
      name: str(m.name, 80) || 'Untitled model', about: str(m.about, 600),
      sets: sets.filter(function (v) { return typeof v === 'string' || (typeof v === 'number' && isFinite(v) && v % 1 === 0 && Math.abs(v) < 1e15); })
        .map(function (v) { return str(String(v), 20); }).filter(Boolean).slice(0, 50),
      parts: parts,
    };
  }

  // Pieces available: the sum of the chosen sets' inventories and lots, keyed "part/colour". A lot keeps the part
  // numbers it came with; they are read as the builder's here, each time.
  function poolOf(inventories) {
    var pool = {};
    inventories.forEach(function (inv) {
      (inv.parts || []).forEach(function (row) { var k = canon(String(row[0])) + '/' + row[1]; pool[k] = (pool[k] || 0) + row[2]; });
    });
    return pool;
  }

  // Everything that would stop the model being built from these pieces, and some things worth knowing.
  function check(model, shapes, pool) {
    var problems = [], notes = [], used = {};
    var parts = model.parts.map(function (q, i) {
      // The part's own entry in shapes, not anything every object has: a part written "constructor" was found, and
      // counted as a piece the builder knows (check_model.py said it wasn't).
      var sh = Object.prototype.hasOwnProperty.call(shapes, q[0]) ? shapes[q[0]] : undefined;
      return { i: i, p: q[0], c: q[1], x: q[2], y: q[3], z: q[4], r: q[5], s: q[6], sh: sh };
    });
    parts.forEach(function (q) {
      if (!q.sh) { problems.push({ kind: 'part', parts: [q.i], text: 'Part ' + q.p + ' isn’t one the builder knows yet' }); return; }
      var k = q.p + '/' + q.c; used[k] = (used[k] || 0) + 1;
    });
    var short = [];
    Object.keys(used).sort().forEach(function (k) {
      var have = pool ? pool[k] || 0 : Infinity;
      if (used[k] > have) short.push({ key: k, need: used[k], have: have });
    });
    short.forEach(function (x) {
      problems.push({ kind: 'count', key: x.key, parts: parts.filter(function (q) { return q.p + '/' + q.c === x.key; }).map(function (q) { return q.i; }),
        text: 'Needs ' + x.need + ' of ' + x.key + ', you have ' + x.have });
    });

    var ok = parts.filter(function (q) { return q.sh; });
    ok.forEach(function (q) { q.cells = placed(q.sh, q); });

    // Two parts can't be in the same place.
    var space = {}, clash = {};
    ok.forEach(function (q) {
      for (var y = q.y; y < q.y + q.sh.h; y++) q.cells.foot.forEach(function (c) {
        var key = c[0] + ',' + y + ',' + c[1], other = space[key];
        if (other !== undefined && !clash[other + '-' + q.i]) {
          clash[other + '-' + q.i] = 1;
          problems.push({ kind: 'overlap', parts: [other, q.i], text: 'Two parts are in the same place (' + c[0] + ', ' + y + ', ' + c[1] + ')' });
        }
        space[key] = q.i;
      });
    });

    // Stud joins: a stud on top of one part goes into a part sitting right on it.
    var studAt = {}, edges = [];
    ok.forEach(function (q) { q.cells.top.forEach(function (c) { (studAt[c[0] + ',' + (q.y + q.sh.h) + ',' + c[1]] = studAt[c[0] + ',' + (q.y + q.sh.h) + ',' + c[1]] || []).push(q.i); }); });
    ok.forEach(function (q) {
      q.cells.bot.forEach(function (c) {
        (studAt[c[0] + ',' + q.y + ',' + c[1]] || []).forEach(function (j) { edges.push([j, q.i]); });
      });
    });
    var byIndex = {}; ok.forEach(function (q) { byIndex[q.i] = q; });

    function groups(members) {
      var up = {}; members.forEach(function (i) { up[i] = i; });
      function find(i) { while (up[i] !== i) { up[i] = up[up[i]]; i = up[i]; } return i; }
      edges.forEach(function (e) { if (e[0] in up && e[1] in up) up[find(e[0])] = find(e[1]); });
      var g = {}; members.forEach(function (i) { (g[find(i)] = g[find(i)] || []).push(i); });
      // The biggest group first, and of two the same size the one holding the earliest-listed part, each group's
      // parts in the order they're listed: so the page and check_model.py name the same parts, whichever way
      // either happens to walk them.
      return Object.keys(g).map(function (k) { return g[k]; }).sort(function (a, b) { return b.length - a.length || a[0] - b[0]; });
    }

    // The whole model holds together…
    var all = groups(ok.map(function (q) { return q.i; }));
    if (all.length > 1) {
      all.slice(1).forEach(function (g) {
        problems.push({ kind: 'loose', parts: g, text: (g.length === 1 ? 'A part isn’t' : g.length + ' parts aren’t') + ' joined to the rest of the model' });
      });
    }
    // …and so does every step on the way, so it can be built in that order. A step's parts are fine when their
    // group, among everything built so far, holds a part from an earlier step: they join onto what's built. A
    // group made only of this step's parts hangs in the air, however big it is. (Calling the biggest group "the
    // model" passed a step that built a bigger lump beside the model, and gave the same model two verdicts
    // depending on the order its parts were listed in.) The first step has nothing earlier, so its biggest
    // group starts the model.
    var steps = ok.map(function (q) { return q.s; }).filter(function (v, i, a) { return a.indexOf(v) === i; }).sort(function (a, b) { return a - b; });
    if (all.length === 1) {
      steps.forEach(function (s, n) {
        var lone = [];
        groups(ok.filter(function (q) { return q.s <= s; }).map(function (q) { return q.i; })).forEach(function (g, k) {
          var joined = n ? g.some(function (i) { return byIndex[i].s < s; }) : k === 0;
          if (!joined) lone = lone.concat(g);
        });
        lone.sort(function (a, b) { return a - b; });
        if (lone.length) problems.push({ kind: 'order', step: s, parts: lone, text: 'Step ' + s + ' has parts with nothing to join to yet' });
      });
    }
    // A part can't be squeezed in between parts already built: one that joins a part from an earlier step under it
    // and another from an earlier step over it has no way in (studs go on straight down or straight up, and there
    // is no room to do either). The same goes for a stack put on in one step that fills such a gap: whichever of
    // its parts goes on last is squeezed. So a part is refused when a run of the step's parts, each on the one
    // before, leads down from it to a part that is on an earlier step's part and up from it to a part that is
    // under one. One problem for each step that has any, in step order, its parts as they're listed.
    var onto = {}, below = {}, over = {}, beneath = {};
    edges.forEach(function (e) {
      var lo = byIndex[e[0]], hi = byIndex[e[1]];
      if (lo.s < hi.s) onto[hi.i] = 1;
      if (hi.s < lo.s) below[lo.i] = 1;
      if (lo.s === hi.s) { (over[lo.i] = over[lo.i] || []).push(hi.i); (beneath[hi.i] = beneath[hi.i] || []).push(lo.i); }
    });
    var spread = function (from, next) {
      var seen = {}, todo = Object.keys(from).map(Number);
      todo.forEach(function (i) { seen[i] = 1; });
      while (todo.length) (next[todo.pop()] || []).forEach(function (j) { if (!seen[j]) { seen[j] = 1; todo.push(j); } });
      return seen;
    };
    onto = spread(onto, over); below = spread(below, beneath);
    var tight = {};
    ok.forEach(function (q) { if (onto[q.i] && below[q.i]) (tight[q.s] = tight[q.s] || []).push(q.i); });
    Object.keys(tight).map(Number).sort(function (a, b) { return a - b; }).forEach(function (s) {
      problems.push({ kind: 'squeeze', step: s, parts: tight[s], text: 'Step ' + s + ' has ' + (tight[s].length === 1 ? 'a piece' : tight[s].length + ' pieces') + ' that would have to be squeezed in between pieces already built' });
    });
    // Worth knowing: a part pushed on from below, under something already built. One note for each step that has
    // any, in step order, with every such part of the step in the order they're listed.
    var under = {};
    edges.forEach(function (e) {
      var below = byIndex[e[0]], above = byIndex[e[1]];
      if (below.s > above.s) (under[below.s] = under[below.s] || {})[below.i] = 1;
    });
    Object.keys(under).map(Number).sort(function (a, b) { return a - b; }).forEach(function (s) {
      notes.push({ kind: 'under', step: s, parts: Object.keys(under[s]).map(Number).sort(function (a, b) { return a - b; }), text: 'Step ' + s + ' pushes a part on from underneath' });
    });

    var count = ok.length;
    var size = { w: 0, d: 0, h: 0 };
    if (ok.length) {
      // Height is from the lowest part's underside to the highest top, wherever the model sits (it was measured
      // from y 0, so a model written starting at y 30 came out 30 plates taller than it is).
      var x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      ok.forEach(function (q) {
        q.cells.foot.forEach(function (c) { x0 = Math.min(x0, c[0]); x1 = Math.max(x1, c[0] + 1); z0 = Math.min(z0, c[1]); z1 = Math.max(z1, c[1] + 1); });
        y0 = Math.min(y0, q.y); y1 = Math.max(y1, q.y + q.sh.h);
      });
      size = { w: x1 - x0, d: z1 - z0, h: y1 - y0 };
    }
    return { ok: !problems.length, problems: problems, notes: notes, used: used, short: short, steps: steps, pieces: count, size: size };
  }

  // A piece in words, its size before its name as it's said: "white 2x2 brick", "yellow 2x4 slope 45".
  function pieceWords(name, colour) {
    var m = /^(.*?) (\d+x\d+(?:x[\d⅓⅔]+)?)(.*)$/.exec(name);
    return (colour ? String(colour).toLowerCase() + ' ' : '') + (m ? m[2] + ' ' + m[1].toLowerCase() + m[3] : String(name).toLowerCase());
  }
  // More than one of a piece, where its name takes an s without getting in the way ("white 1x4 bricks"); '' where it
  // doesn't ("1x2 brick with grille", "2x4 slope 45").
  function piecesWords(name, colour) {
    var m = /^([A-Za-z ]+) (\d+x\d+(?:x[\d⅓⅔]+)?)$/.exec(name);
    return m ? (colour ? String(colour).toLowerCase() + ' ' : '') + m[2] + ' ' + m[1].toLowerCase() + (/(ch|s|x)$/.test(m[1]) ? 'es' : 's') : '';
  }

  // Where each piece goes, in words, for building without the picture (it can't be drawn, or can't be seen): how
  // high, what it sits on, where on the model's footprint counted in studs from its front left corner, and which
  // way it's turned. "Brick 1x4, Dark Blue: 1 plate up, on the green 6x12 plate, 2 studs in from the left, at the
  // back, running left to right". One text for each of the model's parts, in their order ('' for a part the
  // builder doesn't know). colourName gives a colour's name from its code.
  var SIDE = { 0: 'back', 90: 'right', 180: 'front', 270: 'left' };
  function whereTexts(model, shapes, colourName) {
    var name = function (c) { return colourName ? colourName(c) : 'colour ' + c; };
    var ok = [];
    model.parts.forEach(function (q, i) {
      var sh = Object.prototype.hasOwnProperty.call(shapes, q[0]) ? shapes[q[0]] : null;
      if (sh) ok.push({ i: i, p: q[0], c: q[1], x: q[2], y: q[3], z: q[4], r: q[5], s: q[6], sh: sh, cells: placed(sh, { x: q[2], z: q[4], r: q[5] }), size: turnSize(sh, q[5]) });
    });
    var x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity, y0 = Infinity, studAt = {}, socketAt = {};
    ok.forEach(function (q) {
      x0 = Math.min(x0, q.x); x1 = Math.max(x1, q.x + q.size.w); z0 = Math.min(z0, q.z); z1 = Math.max(z1, q.z + q.size.d); y0 = Math.min(y0, q.y);
      q.cells.top.forEach(function (c) { var k = c[0] + ',' + (q.y + q.sh.h) + ',' + c[1]; (studAt[k] = studAt[k] || []).push(q); });
      q.cells.bot.forEach(function (c) { var k = c[0] + ',' + q.y + ',' + c[1]; (socketAt[k] = socketAt[k] || []).push(q); });
    });
    var studs = function (n) { return n + (n === 1 ? ' stud' : ' studs'); };
    // The pieces a piece joins, said as few words as tell them: one by its name, several of a kind counted.
    var said = function (list) {
      var kinds = {};
      list.forEach(function (o) { kinds[o.p + '/' + o.c] = o; });
      var keys = Object.keys(kinds), one = kinds[keys[0]];
      if (list.length === 1) return 'the ' + pieceWords(one.sh.n, name(one.c));
      if (keys.length === 1 && piecesWords(one.sh.n, name(one.c))) return list.length + ' ' + piecesWords(one.sh.n, name(one.c));
      if (list.length === 2 && keys.length === 2) return 'the ' + pieceWords(one.sh.n, name(one.c)) + ' and the ' + pieceWords(kinds[keys[1]].sh.n, name(kinds[keys[1]].c));
      return list.length + ' pieces';
    };
    var uniq = function (list) { return list.filter(function (o, n) { return list.indexOf(o) === n; }).sort(function (a, b) { return a.i - b.i; }); };
    var out = model.parts.map(function () { return ''; });
    ok.forEach(function (q) {
      var bits = [], up = q.y - y0, bricks = Math.floor(up / 3), plates = up % 3;
      if (up) bits.push([bricks ? bricks + (bricks === 1 ? ' brick' : ' bricks') : '', plates ? plates + (plates === 1 ? ' plate' : ' plates') : ''].filter(Boolean).join(' and ') + ' up');
      // What's under it that it goes onto (built by then), or, with nothing under, what it's pushed up into.
      var onto = uniq([].concat.apply([], q.cells.bot.map(function (c) { return (studAt[c[0] + ',' + q.y + ',' + c[1]] || []).filter(function (o) { return o.s <= q.s; }); })));
      var into = uniq([].concat.apply([], q.cells.top.map(function (c) { return (socketAt[c[0] + ',' + (q.y + q.sh.h) + ',' + c[1]] || []).filter(function (o) { return o.s < q.s; }); })));
      if (onto.length) bits.push('on ' + said(onto));
      else if (into.length) bits.push('under ' + said(into) + ', pushed on from underneath');
      else if (!up) bits.push('on the table');
      var left = q.x - x0, right = x1 - (q.x + q.size.w), front = z1 - (q.z + q.size.d), back = q.z - z0;
      bits.push(!left && !right ? 'the full width' : !left ? 'at the left edge' : !right ? 'at the right edge' : studs(left) + ' in from the left');
      bits.push(!front && !back ? 'front to back' : !front ? 'at the front' : !back ? 'at the back' : studs(front) + ' back from the front');
      if (q.sh.k === 'slope' || q.sh.k === 'curve') bits.push('high side at the ' + SIDE[q.r]);
      else if (q.sh.k === 'inv') bits.push('full side at the ' + SIDE[q.r]);
      else if (q.size.w !== q.size.d && (left || right) && (front || back)) bits.push(q.size.w > q.size.d ? 'running left to right' : 'running front to back');
      out[q.i] = q.sh.n + ', ' + name(q.c) + ': ' + bits.join(', ');
    });
    return out;
  }

  // Studs to centimetres: a stud is 8 mm, a plate 3.2 mm.
  function sizeCm(size) { return { w: size.w * 0.8, d: size.d * 0.8, h: Math.round(size.h * 0.32 * 10) / 10 }; }

  // brickyard/#d1z… carries a model as deflated JSON in base64url (#d1j… uncompressed); #d2z… and #d2j… are
  // the same with a check on the end.
  function modelText(h) {
    var m = /#(d[12][zj])([A-Za-z0-9_-]+)/.exec(String(h || ''));
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
    // The checked form (#d2z…): seven characters on the end are a check of the rest, as in js/core.js (linkText,
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
  function isModelLink(t) { return /#d[12][zj][A-Za-z0-9_-]+/.test(String(t || '')); }
  function parseModel(t) {
    t = String(t || '').trim();
    if (t.charAt(0) !== '{' && isModelLink(t)) return modelText(t).then(parseModel);
    return Promise.resolve().then(function () {
      var i = t.indexOf('{'), j = t.lastIndexOf('}');
      var m = cleanModel(JSON.parse(i >= 0 && j > i ? t.slice(i, j + 1) : t));
      if (!m) throw new Error('empty');
      return m;
    });
  }

  var api = { useAliases: useAliases, canon: canon, turnSize: turnSize, turnCell: turnCell, placed: placed, cleanModel: cleanModel, poolOf: poolOf, check: check, sizeCm: sizeCm, pieceWords: pieceWords, whereTexts: whereTexts,
    modelText: modelText, isModelLink: isModelLink, parseModel: parseModel };
  if (typeof module === 'object' && module.exports) module.exports = api; else root.BuildCore = api;
})(this);
