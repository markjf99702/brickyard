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

  // Studs to centimetres: a stud is 8 mm, a plate 3.2 mm.
  function sizeCm(size) { return { w: size.w * 0.8, d: size.d * 0.8, h: Math.round(size.h * 0.32 * 10) / 10 }; }

  // brickyard/#d1z… carries a model as deflated JSON in base64url (#d1j… uncompressed).
  function modelText(h) {
    var m = /#(d1[zj])([A-Za-z0-9_-]+)/.exec(String(h || ''));
    if (!m) return Promise.resolve('');
    // Inside the promise, so a link cut short (which atob refuses) is turned down instead of throwing.
    return lessEnd(m[2], function (body) {
      return Promise.resolve().then(function () {
        var bin = atob(body.replace(/-/g, '+').replace(/_/g, '/')), bytes = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        if (m[1] === 'd1j') return new TextDecoder().decode(bytes);
        if (typeof DecompressionStream === 'undefined') throw new Error('This browser is too old to open Brickyard links.');
        return new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).text();
      });
    });
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
  function isModelLink(t) { return /#d1[zj][A-Za-z0-9_-]+/.test(String(t || '')); }
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

  var api = { useAliases: useAliases, canon: canon, turnSize: turnSize, turnCell: turnCell, placed: placed, cleanModel: cleanModel, poolOf: poolOf, check: check, sizeCm: sizeCm,
    modelText: modelText, isModelLink: isModelLink, parseModel: parseModel };
  if (typeof module === 'object' && module.exports) module.exports = api; else root.BuildCore = api;
})(this);
