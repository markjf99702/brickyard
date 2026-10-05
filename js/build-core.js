// Brickyard's model logic for "Build from your box": parts on the stud grid, the checks that say whether a
// model can really be built from your pieces, and links. No DOM here, so tests can run it in Node, and
// skill/brickyard-designer/scripts/check_model.py does the same checks the same way.
//
// Coordinates: x runs left to right and z back to front, both in studs; y runs up, in plates (a brick is 3).
// A part's x, y, z is the back-left-bottom corner of its footprint after turning. r turns it 0, 90, 180 or
// 270 degrees; at 90 a part's own width runs front to back. s is the step it goes on in.
(function (root) {
  'use strict';

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
      parts.push([p, c, x, y, z, r, s || 0]);
    });
    if (!parts.length) return null;
    // No steps given: one step per height, bottom up.
    if (parts.some(function (q) { return !q[6]; })) {
      var ys = parts.map(function (q) { return q[3]; }).filter(function (v, i, a) { return a.indexOf(v) === i; }).sort(function (a, b) { return a - b; });
      parts.forEach(function (q) { if (!q[6]) q[6] = ys.indexOf(q[3]) + 1; });
    }
    var str = function (v, n) { return typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, n) : ''; };
    return {
      name: str(m.name, 80) || 'Untitled model', about: str(m.about, 600),
      sets: (Array.isArray(m.sets) ? m.sets : []).map(function (v) { return str(String(v), 20); }).filter(Boolean).slice(0, 50),
      parts: parts,
    };
  }

  // Pieces available: the sum of the chosen sets' inventories, keyed "part/colour".
  function poolOf(inventories) {
    var pool = {};
    inventories.forEach(function (inv) {
      (inv.parts || []).forEach(function (row) { var k = row[0] + '/' + row[1]; pool[k] = (pool[k] || 0) + row[2]; });
    });
    return pool;
  }

  // Everything that would stop the model being built from these pieces, and some things worth knowing.
  function check(model, shapes, pool) {
    var problems = [], notes = [], used = {};
    var parts = model.parts.map(function (q, i) {
      var sh = shapes[q[0]];
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
      return Object.keys(g).map(function (k) { return g[k]; });
    }

    // The whole model holds together…
    var all = groups(ok.map(function (q) { return q.i; }));
    if (all.length > 1) {
      all.sort(function (a, b) { return b.length - a.length; });
      all.slice(1).forEach(function (g) {
        problems.push({ kind: 'loose', parts: g, text: (g.length === 1 ? 'A part isn’t' : g.length + ' parts aren’t') + ' joined to the rest of the model' });
      });
    }
    // …and so does every step on the way, so it can be built in that order.
    var steps = ok.map(function (q) { return q.s; }).filter(function (v, i, a) { return a.indexOf(v) === i; }).sort(function (a, b) { return a - b; });
    if (all.length === 1) {
      steps.forEach(function (s) {
        var sofar = ok.filter(function (q) { return q.s <= s; }).map(function (q) { return q.i; });
        var g = groups(sofar);
        if (g.length > 1) {
          g.sort(function (a, b) { return b.length - a.length; });
          var lone = [].concat.apply([], g.slice(1)).filter(function (i) { return byIndex[i].s === s; });
          if (lone.length) problems.push({ kind: 'order', step: s, parts: lone, text: 'Step ' + s + ' has parts with nothing to join to yet' });
        }
      });
    }
    // Worth knowing: a part pushed on from below, under something already built.
    edges.forEach(function (e) {
      var below = byIndex[e[0]], above = byIndex[e[1]];
      if (below.s > above.s) notes.push({ kind: 'under', step: below.s, parts: [below.i], text: 'Step ' + below.s + ' pushes a part on from underneath' });
    });
    var seen = {};
    notes = notes.filter(function (n) { var k = n.kind + n.step; if (seen[k]) return false; seen[k] = 1; return true; });

    var count = ok.length;
    var size = { w: 0, d: 0, h: 0 };
    if (ok.length) {
      var x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity, y1 = 0;
      ok.forEach(function (q) {
        q.cells.foot.forEach(function (c) { x0 = Math.min(x0, c[0]); x1 = Math.max(x1, c[0] + 1); z0 = Math.min(z0, c[1]); z1 = Math.max(z1, c[1] + 1); });
        y1 = Math.max(y1, q.y + q.sh.h);
      });
      size = { w: x1 - x0, d: z1 - z0, h: y1 };
    }
    return { ok: !problems.length, problems: problems, notes: notes, used: used, short: short, steps: steps, pieces: count, size: size };
  }

  // Studs to centimetres: a stud is 8 mm, a plate 3.2 mm.
  function sizeCm(size) { return { w: size.w * 0.8, d: size.d * 0.8, h: Math.round(size.h * 0.32 * 10) / 10 }; }

  // brickyard/#d1z… carries a model as deflated JSON in base64url (#d1j… uncompressed).
  function modelText(h) {
    var m = /#(d1[zj])([A-Za-z0-9_-]+)/.exec(String(h || ''));
    if (!m) return Promise.resolve('');
    var bin = atob(m[2].replace(/-/g, '+').replace(/_/g, '/')), bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    if (m[1] === 'd1j') return Promise.resolve(new TextDecoder().decode(bytes));
    if (typeof DecompressionStream === 'undefined') return Promise.reject(new Error('This browser is too old to open Brickyard links.'));
    return new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).text();
  }
  function isModelLink(t) { return /#d1[zj][A-Za-z0-9_-]+\s*$/.test(String(t || '').trim()); }
  function parseModel(t) {
    t = String(t || '').trim();
    if (t.charAt(0) !== '{' && isModelLink(t)) return modelText(t).then(parseModel);
    return Promise.resolve().then(function () {
      var m = cleanModel(JSON.parse(t));
      if (!m) throw new Error('empty');
      return m;
    });
  }

  var api = { turnSize: turnSize, turnCell: turnCell, placed: placed, cleanModel: cleanModel, poolOf: poolOf, check: check, sizeCm: sizeCm,
    modelText: modelText, isModelLink: isModelLink, parseModel: parseModel };
  if (typeof module === 'object' && module.exports) module.exports = api; else root.BuildCore = api;
})(this);
