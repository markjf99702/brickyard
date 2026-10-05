// Brickyard's pure logic: cleaning sets, merging catalogs, finding doubles, links and the spreadsheet.
// No DOM here, so test/core.test.js can run it in Node.
(function (root) {
  'use strict';

  var STATES = ['built', 'partial', 'apart', 'sealed'];
  var STATE_NAMES = { built: 'Built', partial: 'Partly built', apart: 'Taken apart', sealed: 'Sealed' };
  var STATE_WORDS = {
    built: 'built', assembled: 'built', complete: 'built', displayed: 'built', 'on display': 'built',
    partial: 'partial', 'partly built': 'partial', 'partially built': 'partial', 'half built': 'partial', 'in progress': 'partial',
    apart: 'apart', 'taken apart': 'apart', disassembled: 'apart', loose: 'apart', 'in bags': 'apart', 'broken down': 'apart',
    sealed: 'sealed', 'new in box': 'sealed', nib: 'sealed', misb: 'sealed', unopened: 'sealed', new: 'sealed',
  };

  function s(v, n) {
    if (typeof v === 'boolean' || v == null || typeof v === 'object') return '';
    return String(v).replace(/\s+/g, ' ').trim().slice(0, n);
  }
  function para(v, n) {
    if (typeof v !== 'string') return '';
    return v.replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, n);
  }
  function whole(v, lo, hi) {
    if (typeof v === 'boolean') return 0;
    var x = typeof v === 'number' ? Math.round(v) : parseInt(String(v == null ? '' : v).replace(/[, ]/g, ''), 10);
    if (!isFinite(x)) return 0;
    return Math.max(lo, Math.min(hi, x));
  }
  function measure(v) {
    var x = typeof v === 'number' ? v : parseFloat(String(v == null ? '' : v).replace(',', '.'));
    if (!isFinite(x) || x <= 0) return 0;
    return Math.min(500, Math.round(x * 10) / 10);
  }

  // "10698", "10698-1", "#10698", "set 10698 v2" → "10698-1". Rebrickable's numbering: number, dash, version.
  function setNum(v) {
    var t = s(v, 40).toLowerCase().replace(/^(set|no\.?|#)\s*/, '').replace(/\s+/g, '');
    var m = /^([0-9]{3,7}|[a-z]{1,8}[0-9]{2,7}[a-z]?)(?:-([0-9]{1,2}))?$/.exec(t);
    if (!m) return '';
    return m[1] + '-' + (m[2] ? String(parseInt(m[2], 10)) : '1');
  }
  function shortNum(num) { return String(num || '').replace(/-1$/, ''); }

  function names(v, n) {
    if (typeof v === 'string') v = v.split(/\s*[,;]\s*/);
    var out = [], seen = {};
    (Array.isArray(v) ? v : []).forEach(function (x) {
      x = s(x, 40); var k = x.toLowerCase();
      if (x && !seen[k]) { seen[k] = 1; out.push(x); }
    });
    return out.slice(0, n);
  }

  function state(v) {
    var k = s(v, 30).toLowerCase();
    if (STATES.indexOf(k) >= 0) return k;
    return STATE_WORDS[k] || '';
  }

  // One set, from anywhere (Claude's batch, a file, the form). Unknown fields are dropped and values that
  // don't fit are emptied, so a slip degrades quietly. Empty fields are left out.
  function cleanSet(x) {
    if (!x || typeof x !== 'object') return null;
    var o = {
      num: setNum(x.num || x.set || x.number),
      name: s(x.name || x.title, 160),
      year: whole(x.year, 0, 2100),
      pieces: whole(x.pieces || x.parts, 0, 20000),
      theme: s(x.theme, 60),
      state: state(x.state || x.status),
      room: s(x.room, 60),
      spot: s(x.spot || x.shelf, 60),
      box: s(x.box, 40),
      missing: para(x.missing, 600),
      instr: x.instr === true || x.instructions === true ? true : (x.instr === false || x.instructions === false ? false : null),
      tags: names(x.tags, 12),
      notes: para(x.notes, 2000),
      check: s(x.check || x.unsure, 300),
      added: /^\d{4}-\d{2}-\d{2}$/.test(s(x.added, 10)) ? s(x.added, 10) : '',
    };
    var size = x.size && typeof x.size === 'object' ? x.size : {};
    var w = measure(size.w), d = measure(size.d), h = measure(size.h);
    if (w || d || h) o.size = { w: w, d: d, h: h };
    if (!o.name && !o.num) return null;
    if (o.year && o.year < 1949) o.year = 0;
    var out = {};
    Object.keys(o).forEach(function (k) {
      var v = o[k];
      if (v === '' || v === 0 || v === null || (Array.isArray(v) && !v.length)) return;
      out[k] = v;
    });
    return out;
  }

  function stamp(set, id, t) {
    var o = cleanSet(set);
    if (!o) return null;
    o.id = s(id, 40); o.t = typeof t === 'number' && isFinite(t) ? t : 0;
    return o;
  }

  function emptyDoc() { return { sets: {}, seen: {}, cases: {} }; }

  // A bookcase for the shelf planner: its inside width and depth in cm, and its shelves from the top down, each
  // with the height clear above it and the sets standing on it, left to right ({id, turn} where turn means the
  // set stands side-on, its depth facing out).
  function cleanCase(x, id, t) {
    if (!x || typeof x !== 'object') return null;
    var key = s(x.id || id, 40); if (!key) return null;
    t = typeof t === 'number' && isFinite(t) ? t : (typeof x.t === 'number' && isFinite(x.t) ? x.t : 0);
    if (x.del) return { id: key, t: t, del: 1 };
    var levels = (Array.isArray(x.levels) ? x.levels : []).slice(0, 20).map(function (l) {
      var h = measure(l && typeof l === 'object' ? l.h : l);
      if (!h) return null;
      var seen = {}, sets = (l && Array.isArray(l.sets) ? l.sets : []).map(function (y) {
        var sid = s(y && typeof y === 'object' ? y.id : y, 40);
        if (!sid || seen[sid]) return null;
        seen[sid] = 1;
        var o = { id: sid }; if (y && y.turn === true) o.turn = true;
        return o;
      }).filter(Boolean).slice(0, 200);
      return { h: h, sets: sets };
    }).filter(Boolean);
    var w = measure(x.w), d = measure(x.d);
    if (!w || !d || !levels.length) return null;
    var o = { id: key, t: t, name: s(x.name, 60) || 'Bookcase', w: w, d: d, levels: levels };
    var room = s(x.room, 60); if (room) o.room = room;
    return o;
  }

  // A library file or backup: {"brickyard": 1, "catalog": {"sets": {id: set}, "seen": {batch id: t}, "cases": {id: case}}}.
  function cleanDoc(o) {
    var c = o && (o.catalog || o), doc = emptyDoc();
    var sets = c && c.sets;
    if (Array.isArray(sets)) sets = sets.reduce(function (m, x) { if (x && x.id) m[x.id] = x; return m; }, {});
    if (sets && typeof sets === 'object') Object.keys(sets).forEach(function (id) {
      var x = sets[id]; if (!x || typeof x !== 'object') return;
      var key = s(x.id || id, 40); if (!key) return;
      var t = typeof x.t === 'number' && isFinite(x.t) ? x.t : 0;
      if (x.del) { doc.sets[key] = { id: key, t: t, del: 1 }; return; }
      var y = stamp(x, key, t); if (y) doc.sets[key] = y;
    });
    var seen = c && c.seen;
    if (seen && typeof seen === 'object') Object.keys(seen).forEach(function (k) {
      if (typeof seen[k] === 'number' && isFinite(seen[k])) doc.seen[s(k, 80)] = seen[k];
    });
    var cases = c && c.cases;
    if (cases && typeof cases === 'object') Object.keys(cases).forEach(function (id) {
      var y = cleanCase(cases[id], id); if (y) doc.cases[y.id] = y;
    });
    return doc;
  }

  // Set by set (and bookcase by bookcase), the newer change wins; a removal is a change too. Same answer in any order.
  function mergeDocs(a, b) {
    var out = emptyDoc();
    [a, b].forEach(function (d) {
      ['sets', 'cases'].forEach(function (kind) {
        Object.keys(d[kind] || {}).forEach(function (id) {
          var x = d[kind][id], y = out[kind][id];
          if (!y || x.t > y.t || (x.t === y.t && JSON.stringify(x) > JSON.stringify(y))) out[kind][id] = x;
        });
      });
      Object.keys(d.seen).forEach(function (k) { out.seen[k] = Math.max(out.seen[k] || 0, d.seen[k]); });
    });
    return out;
  }

  // The same catalog, whatever order its keys were written in.
  function canon(v) {
    if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
    if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map(function (k) { return JSON.stringify(k) + ':' + canon(v[k]); }).join(',') + '}';
    return JSON.stringify(v);
  }
  function sameDoc(a, b) { return canon(a) === canon(b); }

  function live(doc) {
    return Object.keys(doc.sets).map(function (k) { return doc.sets[k]; }).filter(function (x) { return !x.del; });
  }

  function nameKey(n) { return String(n || '').toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, ''); }

  // Which owned set a new one might be: same set number, or (with no number) the same name.
  function findDup(doc, set) {
    var all = live(doc), i;
    if (set.num) { for (i = 0; i < all.length; i++) if (all[i].num === set.num) return all[i]; return null; }
    var k = nameKey(set.name); if (!k) return null;
    for (i = 0; i < all.length; i++) if (nameKey(all[i].name) === k) return all[i];
    return null;
  }

  // A batch from Claude: {"brickyard": 1, "batch": {name, room, spot, box, state, sets: [...]}}.
  function cleanBatch(o) {
    var b = o && (o.batch || o);
    if (!b || typeof b !== 'object') return null;
    var list = Array.isArray(b.sets) ? b.sets : [];
    var batch = {
      id: s(b.id, 80), name: s(b.name, 120),
      room: s(b.room, 60), spot: s(b.spot || b.shelf, 60), box: s(b.box, 40), state: state(b.state),
      sets: list.map(cleanSet).filter(Boolean).slice(0, 2000),
    };
    batch.sets.forEach(function (x) {
      if (!x.room && batch.room) { x.room = batch.room; if (!x.spot && batch.spot) x.spot = batch.spot; }
      else if (!x.spot && batch.spot && (!x.room || x.room === batch.room)) x.spot = batch.spot;
      if (!x.box && batch.box) x.box = batch.box;
      if (!x.state && batch.state) x.state = batch.state;
    });
    if (!batch.id) batch.id = 'c' + hash(JSON.stringify(batch.sets));
    return batch;
  }

  function hash(t) {
    var h = 2166136261 >>> 0;
    for (var i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    return h.toString(36);
  }

  function where(x) {
    var place = [x.room, x.spot].filter(Boolean).join(' › ');
    if (x.box) place = place ? place + ' · Box ' + x.box : 'Box ' + x.box;
    return place;
  }

  function totals(sets) {
    return sets.reduce(function (t, x) {
      t.sets++; t.pieces += x.pieces || 0;
      if (x.state) t[x.state] = (t[x.state] || 0) + 1;
      if (x.missing) t.missing++;
      if (x.check) t.check++;
      return t;
    }, { sets: 0, pieces: 0, missing: 0, check: 0 });
  }

  function matches(x, q) {
    if (!q) return true;
    // "box 3" means moving box 3, not any set with "box" and a 3 somewhere.
    var bm = /(?:^|\s)box\s+(\S+)/i.exec(q);
    if (bm) {
      if (String(x.box || '').toLowerCase() !== bm[1].toLowerCase()) return false;
      q = q.replace(bm[0], ' ');
    }
    var hay = [x.num, shortNum(x.num), x.name, x.theme, x.room, x.spot, x.box ? 'box ' + x.box : '', x.missing, x.notes, (x.tags || []).join(' '), STATE_NAMES[x.state] || '', x.year || '']
      .join(' ').toLowerCase();
    return String(q).toLowerCase().split(/\s+/).filter(Boolean).every(function (w) { return hay.indexOf(w) >= 0; });
  }

  // Box labels sort the way people count them: "2" before "10".
  function natural(a, b) {
    return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
  }

  function csvCell(v) {
    var t = v == null ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(t)) t = "'" + t; // a spreadsheet would run these as formulas
    return /[",\n\r]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
  }
  function toCsv(sets) {
    var head = ['Set', 'Name', 'Year', 'Pieces', 'Theme', 'State', 'Room', 'Shelf', 'Moving box', 'Missing pieces', 'Instructions', 'Width cm', 'Depth cm', 'Height cm', 'Tags', 'Notes'];
    var rows = sets.map(function (x) {
      var z = x.size || {};
      return [shortNum(x.num), x.name, x.year || '', x.pieces || '', x.theme, STATE_NAMES[x.state] || '', x.room, x.spot, x.box, x.missing,
        x.instr === true ? 'Yes' : x.instr === false ? 'No' : '', z.w || '', z.d || '', z.h || '', (x.tags || []).join('; '), x.notes];
    });
    return [head].concat(rows).map(function (r) { return r.map(csvCell).join(','); }).join('\r\n') + '\r\n';
  }

  // brickyard/#b1z… carries a batch as deflated JSON in base64url (#b1j… uncompressed); #batch= is URL-encoded
  // JSON for writing by hand. The part after # never reaches a server.
  function linkText(h) {
    h = String(h || '');
    var m = /#(b1[zj])([A-Za-z0-9_-]+)/.exec(h);
    if (!m) {
      var b = /#batch=(\S+)/.exec(h);
      if (!b) return Promise.resolve('');
      try { return Promise.resolve(decodeURIComponent(b[1])); } catch (e) { return Promise.reject(e); }
    }
    var bin = atob(m[2].replace(/-/g, '+').replace(/_/g, '/')), bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    if (m[1] === 'b1j') return Promise.resolve(new TextDecoder().decode(bytes));
    if (typeof DecompressionStream === 'undefined') return Promise.reject(new Error('This browser is too old to open Brickyard links. Ask Claude for the file instead.'));
    return new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).text();
  }

  // Anything pasted or opened: a link, a batch, or a whole catalog.
  function parseIncoming(t) {
    t = String(t || '').trim();
    var c = t.charAt(0);
    if (c !== '{' && /#(b1[zj][A-Za-z0-9_-]+|batch=\S+)\s*$/.test(t)) return linkText(t).then(parseIncoming);
    return Promise.resolve().then(function () {
      var o = JSON.parse(t);
      if (o && o.catalog) return { kind: 'catalog', doc: cleanDoc(o) };
      var b = cleanBatch(o);
      if (!b || !b.sets.length) throw new Error('empty');
      return { kind: 'batch', batch: b };
    });
  }

  var api = {
    linkText: linkText, parseIncoming: parseIncoming,
    STATES: STATES, STATE_NAMES: STATE_NAMES, s: s, setNum: setNum, shortNum: shortNum, state: state, cleanSet: cleanSet, stamp: stamp,
    emptyDoc: emptyDoc, cleanCase: cleanCase, measure: measure, cleanDoc: cleanDoc, mergeDocs: mergeDocs, sameDoc: sameDoc, live: live, findDup: findDup, cleanBatch: cleanBatch,
    hash: hash, where: where, totals: totals, matches: matches, natural: natural, csvCell: csvCell, toCsv: toCsv,
  };
  if (typeof module === 'object' && module.exports) module.exports = api; else root.BrickCore = api;
})(this);
