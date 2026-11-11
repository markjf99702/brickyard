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

  // One line of text, at most n characters. Trimmed again after the cut: a cut that landed just after a space left
  // the space on the end, and the next time the catalog was read it was trimmed off, so a 40-character box label
  // became 39 and the set looked changed. Text inside its limit comes back as it is.
  function s(v, n) {
    if (typeof v === 'boolean' || v == null || typeof v === 'object') return '';
    return String(v).replace(/\s+/g, ' ').trim().slice(0, n).trim();
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

  // A length someone typed into a box, in cm: { cm } (0 for an empty box), with inch: true when it was given in
  // inches and worked out, or { bad } when it can't be read ('unread') or is over the 500 cm kept ('big'). A plain
  // number is cm, with a point or a comma ("32,5"), and comes out as measure gives it. Inches have to say so: in,
  // inch, inches or " after the number, which may be a decimal, a fraction or both (12.5", 5/8 in, 12 5/8"), with
  // feet in front if there are any (1' 2", 2 ft 6 in, 6 ft). Anything else with a letter or a slash in it is
  // turned down, not guessed at: measure reads '12 5/8"' as 12 and "10 in" as 10, which saved inches as cm
  // without a word. measure itself is left as it is, because cleanSet and the cataloger's script must agree.
  function readLength(v) {
    var t = s(v, 40).toLowerCase().replace(/[\u201c\u201d\u2033]|''|[\u2018\u2019\u2032]{2}/g, '"').replace(/[\u2018\u2019\u2032]/g, "'").replace(/(\d),(\d)/g, '$1.$2');
    var done = function (x, inch) {
      if (!isFinite(x) || x > 500) return { bad: 'big' };
      var o = { cm: x <= 0 ? 0 : Math.round(x * 10) / 10 };
      if (inch && o.cm) o.inch = true;
      return o;
    };
    if (!t) return { cm: 0 };
    var m = /^(\d+\.?\d*|\.\d+)\s*(?:cm)?$/.exec(t);
    if (m) return done(parseFloat(m[1]));
    var inches = 0, feet = /^(\d+\.?\d*|\.\d+)\s*(?:'|ft\.?|foot|feet)\s*/.exec(t), rest = feet ? t.slice(feet[0].length) : t;
    if (feet) inches = parseFloat(feet[1]) * 12;
    if (rest) {
      m = /^(?:(\d+\.?\d*|\.\d+)|(?:(\d+)[ -])?(\d+)\/(\d+))\s*("|in\.?|inch|inches)?$/.exec(rest);
      if (!m || (!m[5] && !feet) || (m[3] && !+m[4])) return { bad: 'unread' };
      inches += m[1] ? parseFloat(m[1]) : (+m[2] || 0) + m[3] / m[4];
    }
    return done(inches * 2.54, true);
  }

  // A set number the way Rebrickable writes it: number, dash, version. "10698", "#10698", "Set 10698" and
  // "LEGO 10698" are all "10698-1" (a leading "LEGO" goes, then any run of "set", "no." and "#"), and "10698-2"
  // keeps its version. Anything else is "" ("set 10698 v2", "hello"). shelf-core.js (setNumOf) and the
  // cataloger's script (set_num) clean the same way.
  function setNum(v) {
    var t = s(v, 40).toLowerCase().replace(/^(?:lego[®™]?\s*)?(?:(?:set|no\.?|#)\s*)*/, '').replace(/\s+/g, '');
    var m = /^([0-9]{3,7}|[a-z]{1,8}[0-9]{2,7}[a-z]?)(?:-([0-9]{1,2}))?$/.exec(t);
    if (!m) return '';
    return m[1] + '-' + (m[2] ? String(parseInt(m[2], 10)) : '1');
  }
  function shortNum(num) { return String(num || '').replace(/-1$/, ''); }
  // LEGO's own page of building instructions for a set, by its number as printed on the box (no "-1"); '' for a
  // number that isn't all digits, which LEGO's page doesn't go by.
  function instructionsUrl(num) {
    var m = /^([0-9]{3,7})-[0-9]+$/.exec(setNum(num));
    return m ? 'https://www.lego.com/service/buildinginstructions/' + m[1] : '';
  }

  function names(v, n) {
    if (typeof v === 'string') v = v.split(/\s*[,;]\s*/);
    var out = [], seen = Object.create(null); // nothing in it to start with: a tag "constructor" was dropped as seen already
    (Array.isArray(v) ? v : []).forEach(function (x) {
      x = s(x, 40); var k = x.toLowerCase();
      if (x && !seen[k]) { seen[k] = 1; out.push(x); }
    });
    return out.slice(0, n);
  }

  function state(v) {
    var k = s(v, 30).toLowerCase();
    if (STATES.indexOf(k) >= 0) return k;
    // Only the words in the list: "constructor" is on every object, and came back as a function for a state.
    return Object.prototype.hasOwnProperty.call(STATE_WORDS, k) ? STATE_WORDS[k] : '';
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

  function emptyDoc() { return { sets: {}, seen: {}, cases: {}, loose: {}, places: {} }; }

  // A lot of loose pieces: one tub, bag or moving box of bricks that aren't a set, counted by a scanner (Stud
  // Finder) or listed by hand. Rows are [LDraw part, LDraw colour, count], with the part's name as a fourth
  // item when the sender added one (for parts the builder can't draw yet, so the list can still say what they
  // are). The same part and colour twice is added up. A lot keeps its id, so opening it again replaces it.
  function partNum(v) { var t = s(v, 24).toLowerCase(); return /^[a-z0-9]{1,24}$/.test(t) ? t : ''; }
  function colourNum(v) {
    if (typeof v === 'number' ? !isFinite(v) || v % 1 : !/^\d{1,5}$/.test(String(v == null ? '' : v))) return -1;
    var n = Number(v); return n >= 0 && n <= 99999 ? n : -1;
  }
  function cleanLot(x, id, t) {
    if (!x || typeof x !== 'object') return null;
    var key = s(x.id || id, 40);
    t = typeof t === 'number' && isFinite(t) ? t : (typeof x.t === 'number' && isFinite(x.t) ? x.t : 0);
    if (x.del) return key ? { id: key, t: t, del: 1 } : null;
    var byKey = {}, parts = [];
    (Array.isArray(x.parts) ? x.parts : []).slice(0, 20000).forEach(function (r) {
      if (!Array.isArray(r)) return;
      var p = partNum(r[0]), c = colourNum(r[1]), n = whole(r[2], 0, 100000);
      if (!p || c < 0 || n < 1) return;
      var k = p + '/' + c, row = byKey[k];
      if (row) { row[2] = Math.min(100000, row[2] + n); return; }
      row = [p, c, n];
      var nm = s(r[3], 60); if (nm) row.push(nm);
      byKey[k] = row; parts.push(row);
    });
    if (!parts.length) return null;
    parts.sort(function (a, b) { return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] - b[1]; });
    var o = { id: key || 'l' + hash(JSON.stringify(parts)), t: t, name: s(x.name, 80) || 'Loose pieces', parts: parts };
    var box = s(x.box, 40); if (box) o.box = box;
    var note = para(x.note, 300); if (note) o.note = note;
    return o;
  }
  function lotTotals(lot) {
    return { pieces: (lot.parts || []).reduce(function (n, r) { return n + r[2]; }, 0), kinds: (lot.parts || []).length };
  }
  function liveLots(doc) {
    return Object.keys(doc.loose || {}).map(function (k) { return doc.loose[k]; }).filter(function (x) { return !x.del; });
  }

  // "Your pieces" in Build from your box: which sets and lots count, and how many pieces that is. The one place the
  // rule lives, for the builder's own list (js/build.js) and the number on the home screen's card (js/app.js), which
  // counted loose pieces only and so said "86 loose pieces" where the builder said 876.
  // `index` is parts/index.json: the sets Brickyard has a parts list for, each with its list's count. `ticks` is what
  // the person ticked or unticked there (brickyard.pool: {id: true or false}).
  // A set is listed when it has a parts list. It counts when it's taken apart, unless its tick says otherwise; a lot
  // counts unless it's unticked. A set's count is its pieces in My sets, so the two screens agree (the parts list for
  // 10698 adds up to 804, the box says 790); with none there, it's the parts list's.
  function yourPieces(doc, index, ticks) {
    var has = function (o, k) { return !!o && Object.prototype.hasOwnProperty.call(o, k); };
    var on = function (id, usual) { return has(ticks, id) ? !!ticks[id] : usual; };
    var sets = live(doc).filter(function (x) { return x.num && has(index, x.num); }).map(function (x) {
      return { id: x.id, num: x.num, name: x.name || 'Set ' + shortNum(x.num), pieces: x.pieces || index[x.num], state: x.state, on: on(x.id, x.state === 'apart') };
    });
    var lots = liveLots(doc).map(function (x) {
      return { id: x.id, name: x.name, box: x.box || '', parts: x.parts, kinds: x.parts.length, pieces: lotTotals(x).pieces, on: on(x.id, true) };
    }).sort(function (a, b) { return a.name.localeCompare(b.name, undefined, { numeric: true }); });
    var count = function (n, x) { return n + (x.on ? x.pieces : 0); };
    return { sets: sets, lots: lots, pieces: sets.reduce(count, 0) + lots.reduce(count, 0) };
  }

  // A bookcase for the shelf planner, as the planner works with it: its inside width and depth in cm, and its
  // shelves from the top down, each with the height clear above it and the sets standing on it, left to right
  // ({id, turn} where turn means the set stands side-on, its depth facing out).
  //
  // That isn't how it is kept. The catalog keeps a bookcase without its sets (`cases`: name, room, sizes, shelf
  // heights) and each set's place on its own (`places`, below), so that two devices' changes merge set by set.
  // `shelves` puts the two together for the planner and `putShelf` takes them apart again.
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

  // Where one set stands: { id: the set's, t, c: bookcase id, l: shelf (0 is the top one), n: its place along the
  // shelf, turn }, or { id, t, del: 1 } for a set taken off the shelves. Sets on a shelf stand in the order of
  // their `n`, lowest at the left (by id when two are the same); a set put between two others gets a number
  // between theirs, so moving one set changes that set's record only. One record a set, with the time it was last
  // put somewhere: catalogs merge them the way they merge sets, the later one winning. (A bookcase used to carry
  // its sets, and merged whole: two devices that each put a set on the same bookcase before they synced lost one
  // device's.)
  function cleanPlace(x, id) {
    if (!x || typeof x !== 'object') return null;
    var key = s(x.id || id, 40); if (!key) return null;
    var t = typeof x.t === 'number' && isFinite(x.t) ? x.t : 0;
    if (x.del) return { id: key, t: t, del: 1 };
    var c = s(x.c, 40), l = typeof x.l === 'number' && x.l >= 0 && x.l < 20 ? Math.floor(x.l) : -1;
    if (!c || l < 0) return null;
    var o = { id: key, t: t, c: c, l: l, n: typeof x.n === 'number' && isFinite(x.n) ? x.n : 0 };
    if (x.turn === true) o.turn = true;
    return o;
  }

  // The bookcases as the planner works with them, by id: each with the sets that stand on it ({ id: bookcase }; a
  // removed one is its removal, { id, t, del: 1 }). A place on a bookcase or a shelf that isn't there (the bookcase
  // was removed, or made shorter, on another device) puts its set on no shelf: it waits.
  function shelves(doc) {
    var out = {};
    Object.keys(doc.cases || {}).forEach(function (id) {
      var c = doc.cases[id];
      if (c.del) { out[id] = c; return; }
      var v = { id: c.id, t: c.t, name: c.name, w: c.w, d: c.d, levels: c.levels.map(function (l) { return { h: l.h, sets: [] }; }) };
      if (c.room) v.room = c.room;
      out[id] = v;
    });
    Object.keys(doc.places || {}).map(function (k) { return doc.places[k]; }).filter(function (p) {
      return !p.del && out[p.c] && !out[p.c].del && out[p.c].levels[p.l];
    }).sort(function (a, b) { return a.n - b.n || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0); }).forEach(function (p) {
      var o = { id: p.id }; if (p.turn) o.turn = true;
      out[p.c].levels[p.l].sets.push(o);
    });
    return out;
  }

  // Keeps a bookcase as the planner has it (`v`, with its sets) in catalog `doc`, timed `now`: the bookcase itself
  // if its name, room, sizes or shelf heights changed (or it had been removed), and the place of each set that
  // moved. A set that stood on it and isn't in `v` is taken off the shelves, unless it stands on another bookcase
  // by now. Whatever didn't change keeps its time, so another device's later change to it still wins a merge.
  function putShelf(doc, v, now) {
    var c = cleanCase(v); if (!c || c.del) return null;
    var frame = { id: c.id, t: 0, name: c.name, w: c.w, d: c.d, levels: c.levels.map(function (l) { return { h: l.h }; }) };
    if (c.room) frame.room = c.room;
    var old = doc.cases[c.id], here = {};
    if (!old || old.del || !sameThing(old, frame)) { frame.t = later(old, now); doc.cases[c.id] = frame; }
    if (!doc.places) doc.places = {};
    c.levels.forEach(function (l, li) {
      var ns = alongShelf(l.sets.map(function (p) { var q = doc.places[p.id]; return q && !q.del && q.c === c.id && q.l === li ? q.n : null; }));
      l.sets.forEach(function (p, i) {
        var q = doc.places[p.id], r = { id: p.id, t: 0, c: c.id, l: li, n: ns[i] };
        if (p.turn) r.turn = true;
        here[p.id] = 1;
        if (q && sameThing(q, r)) return;
        r.t = later(q, now); doc.places[p.id] = r;
      });
    });
    Object.keys(doc.places).forEach(function (id) {
      var q = doc.places[id];
      if (!q.del && q.c === c.id && !here[id]) doc.places[id] = { id: id, t: later(q, now), del: 1 };
    });
    return doc.cases[c.id];
  }
  // A number for each set along a shelf, left to right, changing as few as can be: `ns` is the number each has now
  // (null for a set new to the shelf). The longest run of sets that are already in order keep theirs; each of the
  // others gets one between its neighbours' (one more than the last at the right-hand end, one less than the first
  // at the left).
  function alongShelf(ns) {
    var best = [], len = [], prev = [], end = -1, i, j;
    for (i = 0; i < ns.length; i++) {
      len[i] = ns[i] === null ? 0 : 1; prev[i] = -1;
      if (ns[i] === null) continue;
      for (j = 0; j < i; j++) if (ns[j] !== null && ns[j] < ns[i] && len[j] + 1 > len[i]) { len[i] = len[j] + 1; prev[i] = j; }
      if (end < 0 || len[i] > len[end]) end = i;
    }
    var keep = {}; for (i = end; i >= 0; i = prev[i]) keep[i] = 1;
    var out = ns.map(function (n, k) { return keep[k] ? n : null; });
    for (i = 0; i < out.length; i++) {
      if (out[i] !== null) continue;
      for (j = i; j < out.length && out[j] === null; j++);
      var lo = i ? out[i - 1] : null, hi = j < out.length ? out[j] : null, m = j - i;
      for (var k = 0; k < m; k++) {
        out[i + k] = lo === null && hi === null ? k + 1 : hi === null ? lo + k + 1 : lo === null ? hi - (m - k) : lo + (hi - lo) * (k + 1) / (m + 1);
      }
      i = j;
    }
    // Halved too often to tell two apart (some fifty sets put into the same gap): number them afresh.
    for (i = 1; i < out.length; i++) if (!(out[i] > out[i - 1])) return out.map(function (n, k) { return k + 1; });
    return out;
  }

  // A library file or backup: {"brickyard": 1, "catalog": {"sets": {id: set}, "seen": {batch id: t}, "cases": {id: case},
  // "loose": {id: lot}, "places": {set id: place}}}. A catalog from before places (a backup, a link, the copy an
  // older Brickyard kept) has each bookcase carrying its sets: they become places, timed as the bookcase was. Where
  // such a catalog had a set on two bookcases it stays on the one changed last (the later id when they tie), and
  // within one bookcase on its first shelf, as the planner showed it then.
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
    var places = c && c.places;
    if (places && typeof places === 'object') Object.keys(places).forEach(function (id) {
      var y = cleanPlace(places[id], id); if (y) doc.places[y.id] = y;
    });
    var cases = c && c.cases, carried = {};
    if (cases && typeof cases === 'object') Object.keys(cases).forEach(function (id) {
      var y = cleanCase(cases[id], id); if (!y) return;
      doc.cases[y.id] = y;
      if (y.del) return;
      y.levels.forEach(function (l, li) {
        l.sets.forEach(function (p, i) {
          var have = carried[p.id] || doc.places[p.id], r = { id: p.id, t: y.t, c: y.id, l: li, n: i + 1 };
          if (p.turn) r.turn = true;
          if (have && (have.t > r.t || (have.t === r.t && (!carried[p.id] || have.c >= r.c)))) return;
          carried[p.id] = doc.places[p.id] = r;
        });
        delete l.sets;
      });
    });
    var loose = c && c.loose;
    if (loose && typeof loose === 'object') Object.keys(loose).forEach(function (id) {
      var y = cleanLot(loose[id], id); if (y) doc.loose[y.id] = y;
    });
    return doc;
  }

  // Set by set (and bookcase by bookcase, lot by lot, and each set's place on a shelf by itself), the newer change
  // wins; a removal is a change too. Same answer in any order.
  function mergeDocs(a, b) {
    var out = emptyDoc();
    [a, b].forEach(function (d) {
      ['sets', 'cases', 'loose', 'places'].forEach(function (kind) {
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

  // ---------- two copies of a catalog, and what differs between them ----------
  // A thing in the catalog (a set, a bookcase, a lot) without the time it was last changed.
  function untimed(x) { var o = {}; Object.keys(x).forEach(function (k) { if (k !== 't') o[k] = x[k]; }); return o; }
  function sameThing(a, b) { return canon(untimed(a)) === canon(untimed(b)); }
  // The time for a change that has to win a merge against `a`: now, and after `a` was last changed.
  function later(a, now) { return Math.max(now, a ? a.t + 1 : 0); }

  // Two devices each added the same set before they first synced (or before a backup or a catalog link was opened on
  // the other): merged, it's there twice, under two ids. foldTwins merges `here` (this device's catalog) with `there`
  // (the other one) and keeps such a pair once. A pair is a set only `here` has ever had and a set only `there` has
  // ever had, with the same set number and everything else the same (name, place, moving box, state, notes, size…;
  // not the day it was added). Copies that differ in anything are left alone: they may be two sets really owned, and
  // My sets has a Doubles filter for those. Nothing is folded among the sets of one catalog, so two copies that were
  // together on a device stay two; each set folds with one twin at most, so two here and two there stay two.
  // The copy from `there` is the one kept (the other devices know it by that id), unless the one here is on a shelf
  // in the planner and the other isn't; two that are both on shelves are two sets, and stay. The other gets a
  // removal timed `now`, which takes it off every device.
  // Returns { doc: the merged catalog, folded: [{ kept: id, dropped: id, name }] }.
  function twinKey(x) {
    var o = untimed(x); delete o.id; delete o.added;
    return canon(o);
  }
  function foldTwins(here, there, now) {
    var doc = mergeDocs(here, there), folded = [], placed = {}, theirs = {};
    var on = shelves(doc);
    Object.keys(on).forEach(function (id) {
      (on[id].levels || []).forEach(function (l) { l.sets.forEach(function (y) { placed[y.id] = 1; }); });
    });
    var only = function (a, b) {
      return Object.keys(a.sets).sort().map(function (id) { return a.sets[id]; }).filter(function (x) { return !x.del && x.num && !b.sets[x.id]; });
    };
    only(there, here).forEach(function (y) { var k = twinKey(y); (theirs[k] = theirs[k] || []).push(y); });
    only(here, there).forEach(function (x) {
      var list = theirs[twinKey(x)] || [], i = -1;
      list.forEach(function (y, j) { if (i < 0 && !(placed[x.id] && placed[y.id])) i = j; });
      if (i < 0) return;
      var y = list.splice(i, 1)[0], keep = placed[x.id] ? x : y, drop = keep === x ? y : x;
      doc.sets[drop.id] = { id: drop.id, t: later(drop, now), del: 1 };
      folded.push({ kept: keep.id, dropped: drop.id, name: keep.name || 'Set ' + shortNum(keep.num) });
    });
    return { doc: doc, folded: folded };
  }

  // Which sets are in the catalog more than once, for the Doubles filter: { id: true } for every set that shares its
  // number with another, or (one of them having no number) its name.
  function doubles(sets) {
    var nums = {}, byName = {}, bare = {}, out = {};
    sets.forEach(function (x) {
      var k = nameKey(x.name);
      if (x.num) nums[x.num] = (nums[x.num] || 0) + 1;
      else if (k) bare[k] = (bare[k] || 0) + 1;
      if (k) byName[k] = (byName[k] || 0) + 1;
    });
    sets.forEach(function (x) {
      var k = nameKey(x.name);
      if (x.num ? nums[x.num] > 1 || (k && bare[k]) : k && byName[k] > 1) out[x.id] = true;
    });
    return out;
  }

  // What changed between the catalog as it was (`before`) and as it is after a sync brought another device's changes
  // in (`after`): { added, changed, removed: sets, cases, lots: how many bookcases and lots differ }. `skip` is ids
  // to leave out ({ id: true }): twins folded in the same sync, which are said in a line of their own. A removal of
  // something that was never here isn't a change here.
  function arrived(before, after, skip) {
    var out = { added: [], changed: [], removed: [], cases: 0, lots: 0 };
    var each = function (kind, f) {
      Object.keys(after[kind] || {}).forEach(function (id) {
        if (skip && skip[id]) return;
        var a = (before[kind] || {})[id], b = after[kind][id], was = !!a && !a.del, is = !b.del;
        if (was || is) f(a, b, was, is);
      });
    };
    each('sets', function (a, b, was, is) {
      if (!was) out.added.push(b); else if (!is) out.removed.push(a); else if (!sameThing(a, b)) out.changed.push(b);
    });
    // A bookcase has changed if it has itself, or a set was put on it, moved along it or taken off it.
    var touched = {};
    each('cases', function (a, b, was, is) { if (was !== is || !sameThing(a, b)) touched[b.id] = 1; });
    each('places', function (a, b, was, is) { if (was !== is || !sameThing(a, b)) { if (was) touched[a.c] = 1; if (is) touched[b.c] = 1; } });
    out.cases = Object.keys(touched).filter(function (id) { var a = (before.cases || {})[id], b = (after.cases || {})[id]; return (a && !a.del) || (b && !b.del); }).length;
    each('loose', function (a, b, was, is) { if (was !== is || !sameThing(a, b)) out.lots++; });
    return out;
  }
  // The same in a line: "From your other devices: 3 sets added", "…: 1 set changed, Bonsai Tree removed". One or two
  // removed sets are named; more are counted. '' when nothing changed here.
  function arrivedText(n) {
    var called = function (x) { return x.name || 'Set ' + shortNum(x.num); }, bits = [];
    if (n.added.length) bits.push(count(n.added.length, 'set') + ' added');
    if (n.changed.length) bits.push(count(n.changed.length, 'set') + ' changed');
    if (n.removed.length) bits.push((n.removed.length > 2 ? count(n.removed.length, 'set') : n.removed.map(called).join(' and ')) + ' removed');
    if (n.cases) bits.push(count(n.cases, 'bookcase') + ' changed');
    if (n.lots) bits.push('loose pieces changed');
    return bits.length ? 'From your other devices: ' + bits.join(', ') : '';
  }

  // Going back to a backup: the catalog as `file` has it, made so that it wins every merge (with this device's copy,
  // with Drive, with the other devices). Opening a backup merges, and the later change to each set wins, so a file
  // from yesterday couldn't undo today's mistake. Here everything the file has that differs from `here` comes back
  // as the file has it, timed `now`; everything here that the file doesn't have (or has as removed) is removed,
  // timed `now`; what's the same is left as it is. Sets, bookcases and lots alike. Run it the other way round (the
  // catalog from before, as the file) and it undoes itself.
  // Returns { doc, n: { back: sets that go back to how the file has them, gone: sets here that the file doesn't
  // have, cases, lots: bookcases and lots that change or go }, went: the sets removed }.
  function restoreDoc(here, file, now) {
    var doc = emptyDoc(), n = { back: 0, gone: 0, cases: 0, lots: 0 }, went = [], touched = {};
    ['sets', 'cases', 'loose', 'places'].forEach(function (kind) {
      // A set's place that changes is a change to the bookcase it stands on, there or here.
      var ids = {}, tally = function (k, a, b) {
        if (kind === 'sets') n[k]++; else if (kind === 'loose') n.lots++;
        else [a, b].forEach(function (x) { if (x && !x.del) touched[kind === 'cases' ? x.id : x.c] = 1; });
      };
      Object.keys(here[kind] || {}).concat(Object.keys(file[kind] || {})).forEach(function (id) { ids[id] = 1; });
      Object.keys(ids).forEach(function (id) {
        var a = (here[kind] || {})[id], b = (file[kind] || {})[id], was = !!a && !a.del, want = !!b && !b.del;
        if (!want) {
          if (!was) { doc[kind][id] = a && b ? (b.t > a.t ? b : a) : a || b; return; } // removed in both: the removal stays
          doc[kind][id] = { id: id, t: later(a, now), del: 1 };
          if (kind === 'sets') went.push(a);
          tally('gone', a, b); return;
        }
        if (was && sameThing(a, b)) { doc[kind][id] = a; return; }
        var y = JSON.parse(JSON.stringify(b)); y.t = later(a, now);
        doc[kind][id] = y; tally('back', a, b);
      });
    });
    [here, file].forEach(function (d) { Object.keys(d.seen || {}).forEach(function (k) { doc.seen[k] = Math.max(doc.seen[k] || 0, d.seen[k]); }); });
    n.cases = Object.keys(touched).filter(function (id) { return [here, file].some(function (d) { var c = (d.cases || {})[id]; return c && !c.del; }); }).length;
    return { doc: doc, n: n, went: went };
  }

  function nameKey(n) { return String(n || '').toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, ''); }

  // Whether a new set might be one already there: the same set number, or (with no number) the same name. The
  // cataloger's script (is_dup) tells doubles the same way.
  function isDup(have, set) {
    if (set.num) return have.num === set.num;
    var k = nameKey(set.name);
    return !!k && nameKey(have.name) === k;
  }
  // Which owned sets a new one might be. A set owned by name alone (typed in before the photos were sent) is found
  // when the new one arrives with its number and the same name: it used to be missed, and the review ticked it to
  // be added a second time. Ones with the same number come first. Two sets with different numbers and one name stay
  // two sets. findDup is the first of them.
  function findDups(doc, set) {
    var all = live(doc), own = all.filter(function (x) { return isDup(x, set); });
    return own.concat(all.filter(function (x) { return !x.num && own.indexOf(x) < 0 && isDup(set, x); }));
  }
  function findDup(doc, set) { return findDups(doc, set)[0] || null; }
  // What a row from Claude says about a set already owned (`have`) that the catalog doesn't: null when nothing, or
  // { set: the fields to change and what to, moved, state, fill, after: the set as it would be }. "These eight
  // went in box 7" used to be eight rows marked "You already have this one", and ticking one added a second copy.
  // Only where it is and what state it's in ever change: its room, shelf, moving box and state, and only the ones
  // the row gives. A new room takes the row's shelf with it (the old shelf was in the old room). A row that names
  // no box says nothing about its box, which stays: a box can be in a room, and a set is taken out of one in
  // Brickyard (Unpack), never by a link. `moved` is a change of place, `state` a change of state.
  // The set's name, notes, missing pieces and the rest are never touched, and its number only when it has none (it
  // was typed in by name, and the row is the same name with its number): then the number is filled in, and its
  // year, pieces and theme where those are blank (`fill`).
  function updateFor(have, x) {
    var set = {}, moved = false, fill = false, differs = function (a, b) { return natural(a || '', b || '') !== 0; };
    if (x.room && differs(x.room, have.room)) { set.room = x.room; set.spot = x.spot || ''; moved = true; }
    else if (x.spot && differs(x.spot, have.spot)) { set.spot = x.spot; moved = true; }
    if (x.box && !sameBox(x.box, have.box)) { set.box = x.box; moved = true; }
    if (x.state && x.state !== have.state) set.state = x.state;
    if (!have.num && x.num) {
      set.num = x.num; fill = true;
      ['year', 'pieces', 'theme'].forEach(function (k) { if (!have[k] && x[k]) set[k] = x[k]; });
    }
    if (!moved && !fill && !set.state) return null;
    var after = {};
    Object.keys(have).forEach(function (k) { after[k] = have[k]; });
    Object.keys(set).forEach(function (k) { if (set[k] === '') delete after[k]; else after[k] = set[k]; });
    return { set: set, moved: moved, state: !!set.state, fill: fill, after: after };
  }
  // In a list of sets (a batch from Claude), which ones are in it again: true for each set that matches one
  // earlier in the list, either way round, so a set with its number and the same set by name alone are a pair
  // whichever comes first. The first of them isn't marked.
  function repeats(sets) {
    return sets.map(function (x, i) {
      return sets.slice(0, i).some(function (y) { return isDup(y, x) || isDup(x, y); });
    });
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

  // A moving box's label without a "Box" or "#" in front, the way it's shown and searched: "Box 5", "box #5" and
  // "#5" are all box 5, so it never reads "Box Box 5" and "box 5" finds it. The label is kept as it was typed.
  function bareBox(t) { var u = t.replace(/^box(?:\s+|(?=[#\d]))/i, '').replace(/^#\s*/, ''); return u || t; }
  function boxName(b) { return bareBox(s(b, 40)); }

  // Two labels for one moving box: "3", "03", "Box 3" and "#3" are the same box, the way boxes are grouped.
  function sameBox(a, b) { return !!a && !!b && natural(boxName(a), boxName(b)) === 0; }
  // What a moving box holds: its sets, by name, and its lots of loose pieces. The box is called what the first of
  // them calls it, as its heading in My sets is: a set that had it as "03" came out of Box 3.
  function byName(a, b) { return natural(a.name || '', b.name || '') || natural(a.num || '', b.num || ''); }
  function boxHolds(doc, box) {
    var inIt = function (x) { return sameBox(x.box, box); };
    var h = { sets: live(doc).filter(inIt).sort(byName), lots: liveLots(doc).filter(inIt) };
    h.name = 'Box ' + boxName((h.sets[0] || h.lots[0] || { box: box }).box);
    return h;
  }
  // How the packing stands: how many sets are in a moving box (`packed`) and how many aren't (`toPack`), how many
  // boxes hold sets (`boxes`), and how many hold anything, loose pieces too (`all`).
  function packing(doc) {
    var sets = live(doc), packed = sets.filter(function (x) { return x.box; });
    var count = function (list) {
      var seen = [];
      list.forEach(function (x) { if (x.box && !seen.some(function (b) { return sameBox(b, x.box); })) seen.push(x.box); });
      return seen.length;
    };
    return { packed: packed.length, toPack: sets.length - packed.length, boxes: count(packed), all: count(packed.concat(liveLots(doc))) };
  }
  function count(n, w) { return n.toLocaleString() + ' ' + w + (n === 1 ? '' : 's'); }
  // What happened to the moving boxes when a set went from box `was` to box `now` (either may be empty), for the
  // message that says it's saved; `doc` is the catalog after the change. "Box 4 holds 3 sets now." for the box it
  // went into; for the one it left, "2 sets still in Box 3.", "Box 12 is empty now.", or, when nothing is packed
  // anywhere any more, "That was the last moving box." Nothing when the set stayed where it was. With `loose`, it
  // was a lot of loose pieces that moved: a box isn't said to hold one more set for it.
  function boxNews(doc, was, now, loose) {
    was = s(was, 40); now = s(now, 40);
    if ((!was && !now) || sameBox(was, now)) return '';
    var out = [];
    if (now && !loose) { var into = boxHolds(doc, now); out.push(into.name + ' holds ' + count(into.sets.length, 'set') + ' now.'); }
    if (was) {
      var left = boxHolds(doc, was);
      out.push(left.sets.length ? count(left.sets.length, 'set') + ' still in ' + left.name + '.'
        : left.lots.length ? 'Only loose pieces are left in ' + left.name + '.'
        : !packing(doc).all ? 'That was the last moving box.' : left.name + ' is empty now.');
    }
    return out.join(' ');
  }

  // A moving box's list as plain text, for a label on the box or a message: the box and what it holds, then each
  // set's number, name and state on a line of its own, by name, then its loose pieces.
  function boxList(doc, box) {
    var h = boxHolds(doc, box), name = h.name, sets = h.sets;
    var loose = h.lots.reduce(function (n, l) { return n + lotTotals(l).pieces; }, 0);
    return [name + ' · ' + [sets.length ? count(sets.length, 'set') : '', loose ? count(loose, 'loose piece') : ''].filter(Boolean).join(' · ')].concat(
      sets.map(function (x) { return [[shortNum(x.num), x.name].filter(Boolean).join(' '), STATE_NAMES[x.state] || ''].filter(Boolean).join(' · '); }),
      h.lots.map(function (l) { return l.name + ' · ' + count(lotTotals(l).pieces, 'loose piece'); })).join('\n');
  }

  // What's missing from these sets as plain text, for an order of replacement pieces: a line for each set that has
  // anything missing, by name, with its number, its name and what's missing ("60337 Express Passenger Train: one
  // dark grey 1x2 plate"). A set's several lines of missing pieces are run into one, with commas.
  function missingList(sets) {
    return sets.filter(function (x) { return x.missing; }).sort(function (a, b) { return natural(a.name || '', b.name || '') || natural(a.num || '', b.num || ''); }).map(function (x) {
      var lines = String(x.missing).split('\n').map(function (l) { return l.trim().replace(/[,;]$/, ''); }).filter(Boolean);
      return ([shortNum(x.num), x.name].filter(Boolean).join(' ') || 'A set') + ': ' + lines.join(', ');
    }).join('\n');
  }

  function where(x) {
    var place = [x.room, x.spot].filter(Boolean).join(' › ');
    if (x.box) place = (place ? place + ' · ' : '') + 'Box ' + boxName(x.box);
    return place;
  }

  function totals(sets) {
    var twice = doubles(sets);
    return sets.reduce(function (t, x) {
      t.sets++; t.pieces += x.pieces || 0;
      if (x.state) t[x.state] = (t[x.state] || 0) + 1;
      if (x.missing) t.missing++;
      if (x.check) t.check++;
      if (twice[x.id]) t.doubles++;
      return t;
    }, { sets: 0, pieces: 0, missing: 0, check: 0, doubles: 0 });
  }

  // "box 3" means moving box 3, not any set with "box" and a 3 somewhere. A label can be more than one word
  // ("box kitchen 2"), so what follows "box" is matched against the catalog's labels and the longest that fits
  // wins, so "box kitchen 2" isn't box "Kitchen" and a 2 somewhere. Labels are matched without a "Box" or "#" in
  // front (boxName), on either side, and words after the label are searched as usual ("box 3 typewriter").
  // A word after "box" that's neither a label nor a number is just a word ("creative brick box large"): then
  // it's no box search at all (null). Otherwise it returns the label (null for a box with nothing in it, such as
  // "box 3" before anything is packed in box 3) and the rest of the query. With no label, `matches` searches the
  // words as they were typed.
  // It can be asked as a question: "in box 3", "what's in box 3" and "sets in box 3" are all box 3 (the other words
  // used to be searched for, so "in box 3" found only the sets with "in" somewhere). "box3" is box 3 too, and a
  // label is matched the way boxes are grouped (natural), so "box 03" finds box 3.
  function boxSearch(q, labels) {
    q = unlego(q);
    var bm = /(?:^|\s)box(?:\s+|(?=[#\d]))(\S.*)$/i.exec(q);
    if (!bm) return null;
    var rest = bm[1].toLowerCase().replace(/\s+/g, ' ').trim(), tries = [rest], best = null;
    if (bareBox(rest) !== rest) tries.push(bareBox(rest));
    labels.forEach(function (l) {
      var k = boxName(l).toLowerCase(), n = k.split(' ').length;
      if (!k || (best && k.length <= best.label.length)) return;
      tries.forEach(function (t) {
        var words = t.split(' ');
        if (natural(words.slice(0, n).join(' '), k) === 0) best = { label: k, after: words.slice(n).join(' ') };
      });
    });
    if (!best && !/^\d+$/.test(tries[tries.length - 1].split(' ')[0])) return null;
    var before = fold(q.slice(0, bm.index)).replace(/(^|\s)(?:what'?s\s+)?in\s*$/, '$1');
    return { label: best ? best.label : null, rest: (before + ' ' + (best ? best.after : '')).split(/\s+/).filter(function (w) { return w && w !== 'sets'; }).join(' ') };
  }
  // "lego 75192" is 75192: the word LEGO in front of a search is dropped, unless it's the whole search.
  function unlego(q) { return String(q || '').replace(/^\s*lego\s+(?=\S)/i, ''); }
  // True when a set's box is the one a box search found (its label, as boxSearch gives it).
  function inBox(x, label) { return !!x.box && natural(boxName(x.box), label) === 0; }

  // labels: every moving-box label in the catalog. Without them, the set's own is the only one known.
  // A set's number, name, theme, room, spot, moving box, missing pieces, notes, Check note, tags, state and year
  // are searched; not its piece count or sizes, where "60" would find half the catalog.
  // Besides the set's own fields, the words the screen uses are searched: "missing pieces" finds the sets with
  // something missing and "to check" the ones marked, and "not packed" is the sets with no moving box. A word of
  // four letters or more that isn't found is tried without its last s or es ("flowers" finds Flower Bouquet).
  function matches(x, q, labels) {
    if (!q) return true;
    q = unlego(q);
    var b = boxSearch(q, labels || (x.box ? [x.box] : []));
    // "box" and a number that no moving box is labelled with is an ordinary search of the words: "brick box 10698"
    // found nothing, because no box was labelled 10698, with the Large Creative Brick Box 10698 in the catalog.
    // The words are looked for in what the set itself says. The "box" that search puts in front of every packed
    // set's label is left out (`bare`), or "box 7" with no box 7 would be every packed set with a 7 somewhere.
    var bare = !!b && !b.label;
    if (b && b.label) {
      if (!inBox(x, b.label)) return false;
      q = b.rest;
    }
    q = fold(q);
    if (/(^|\s)not packed(\s|$)/.test(q)) {
      if (x.box) return false;
      q = q.replace(/(^|\s)not packed(?=\s|$)/, ' ');
    }
    // The number's "-1" is left out of the text without punctuation: "76391-1" read as 763911, and "911" found it.
    var rest = [shortNum(x.num), x.name, x.theme, x.room, x.spot, x.box ? (bare ? '' : 'box ' + boxName(x.box) + ' ') + x.box : '', x.missing, x.notes, x.check, (x.tags || []).join(' '), STATE_NAMES[x.state] || '', x.year || '',
      x.missing ? 'missing pieces' : '', x.check ? 'to check' : ''].join(' ');
    var hay = fold((x.num || '') + ' ' + rest), plain = unpunct(fold(rest));
    var has = function (w) { var u = unpunct(w); return hay.indexOf(w) >= 0 || (!!u && plain.indexOf(u) >= 0); };
    return q.split(/\s+/).filter(Boolean).every(function (w) {
      return has(w) || (w.length >= 4 && ((/s$/.test(w) && has(w.slice(0, -1))) || (/es$/.test(w) && has(w.slice(0, -2)))));
    });
  }
  // Search reads a name the way it's said. Both what's typed and what's searched are put in lower case, without
  // accents ("sian" finds Sián), with curly quotes straightened (a phone types ’ where the name has ') and every
  // kind of dash a hyphen. A word that isn't found as typed is tried again with the punctuation left out of both,
  // so "xwing", "doms" and "r2d2" find X-wing, Dom's and R2-D2.
  function fold(t) {
    t = String(t == null ? '' : t).toLowerCase();
    if (t.normalize) t = t.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    return t.replace(/[\u2018\u2019\u201b\u02bc\u2032]/g, "'").replace(/[\u201c\u201d\u201f\u2033]/g, '"').replace(/[\u2010-\u2015\u2212]/g, '-');
  }
  function unpunct(t) { return t.replace(/[!-\/:-@\[-`{-~\u00b7]/g, ''); }

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
  // JSON for writing by hand. #l1z… / #l1j… carry a lot of loose pieces the same way, and so do the other screens'
  // links, read here when one is pasted: sizes (#z1z…, js/shelf-core.js) and models (#d1z…, js/build-core.js).
  // The part after # never reaches a server.
  //
  // The checked form has a 2 where those have a 1 (#b2z…, #b2j…, and l, z and d the same), and seven more
  // characters on its end: a check worked out from the rest (linkCheck). One changed character in a #b1j link
  // opened as a different set, without a word, and sometimes in a #b1z link too; in a checked link the seven no
  // longer fit, and it is turned down. The skills' scripts and Copy everything as a link write the checked form.
  // The unchecked ones still open: the links made before, and the ones Stud Finder sends.
  //
  // A link that can't be read says why, in the error's `why`, so the page can say what to do about it:
  // 'cut' when it is one of Brickyard's but doesn't unpack (a chat app cut it short, or a character changed on the
  // way); 'wrong' when it is a checked link and its check doesn't fit (a character is wrong or missing, for
  // certain); 'newer' when it looks like a Brickyard link of a later format (# then a letter, a number, and z or
  // j, where this copy of the page doesn't know the letter with that number). Anything else isn't a Brickyard
  // link at all.
  var WHY = { cut: 'This Brickyard link doesn’t unpack', wrong: 'This Brickyard link has a wrong or missing character', newer: 'This link is for a newer Brickyard' };
  function fault(why) { var e = new Error(WHY[why]); e.why = why; return e; }
  function newerLink(t) { return /#(?:[a-z][3-9]|[ace-km-y]2)[zj][A-Za-z0-9_-]{12,}/.test(String(t || '')); }
  // The seven characters on the end of a checked link: the hash of what comes before them, from the letter after
  // the # on ("b2z" and the data), in base 36. Any one changed character changes it. make_brickyard.py and
  // check_model.py (link_check) work it out the same way, and so do js/shelf-core.js and js/build-core.js.
  function linkCheck(t) { var c = hash(t); return '0000000'.slice(c.length) + c; }
  var LINK = /#([bldz])([12])([zj])([A-Za-z0-9_-]+)/;
  function linkText(h) {
    h = String(h || '');
    var m = LINK.exec(h);
    if (!m) {
      var b = /#batch=(\S+)/.exec(h);
      if (!b) return Promise.resolve('');
      // A full stop or bracket after the link in a sentence isn't part of it; the JSON in it ends with } (or %7D).
      try { return Promise.resolve(decodeURIComponent(b[1].replace(/[.,;:!?)\]>"'’”»…—–]+$/, ''))); } catch (e) { return Promise.reject(fault('cut')); }
    }
    // Inside the promise, so a link cut short (which atob refuses) is turned down like any bad link instead of
    // throwing while the page starts.
    var unpack = function (body) {
      return Promise.resolve().then(function () {
        var bin = atob(body.replace(/-/g, '+').replace(/_/g, '/')), bytes = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        if (m[3] === 'j') return new TextDecoder().decode(bytes);
        if (typeof DecompressionStream === 'undefined') throw new Error('This browser is too old to open Brickyard links. Ask Claude for the file instead.');
        return new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).text();
      });
    };
    var old = function (e) { throw e && /browser/.test(e.message) ? e : fault('cut'); };
    if (m[2] === '1') return lessEnd(m[4], unpack).catch(old);
    // A checked link never ends in a dash or an underscore (its check is letters and numbers), so any on its end
    // came from the text around it: markdown's _link_.
    var body = m[4].replace(/[-_]+$/, ''), data = body.slice(0, -7);
    if (body.length < 8 || linkCheck(m[1] + m[2] + m[3] + data) !== body.slice(-7)) return Promise.reject(fault('wrong'));
    return unpack(data).catch(old);
  }
  // A whole link can arrive with a dash or an underscore stuck to its end, which are characters a link is made of:
  // markdown's _link_, or "link- open it". About one time in three what was captured then doesn't unpack, and the
  // link was turned down as cut short when all of it had arrived. So when it doesn't unpack and ends in one of
  // those, it's tried again without the last one, then two, then three. A link that really was cut still fails.
  function lessEnd(body, unpack, n) {
    var text = n ? body.slice(0, -n) : body;
    return unpack(text).catch(function (e) {
      if ((n || 0) >= 3 || !/[-_]$/.test(text) || (e && /browser/.test(e.message))) throw e;
      return lessEnd(body, unpack, (n || 0) + 1);
    });
  }

  // The JSON in what was pasted: from the first { to the last }, so ```json fences or a line above it don't matter.
  function jsonPart(t) {
    var i = t.indexOf('{'), j = t.lastIndexOf('}');
    return i >= 0 && j > i ? t.slice(i, j + 1) : t;
  }

  // Anything pasted or opened: a link, a batch, a lot of loose pieces, or a whole catalog. Copying a whole message
  // from Claude brings more than that along, so a link is found wherever it is in the text (in a sentence, with a
  // full stop after it), and the JSON inside whatever surrounds it. Sizes for the shelf planner and a model for
  // Build from your box come back as they are (kind 'sizes' or 'model', doc), for those screens to read.
  function parseIncoming(t) {
    t = String(t || '').trim();
    if (t.charAt(0) !== '{') {
      if (LINK.test(t) || /#batch=\S+/.test(t)) return linkText(t).then(function (text) {
        var o;
        try { o = JSON.parse(jsonPart(text)); } catch (e) { throw fault('cut'); } // it unpacked, into something that isn't whole
        return sortOut(o);
      });
      if (newerLink(t)) return Promise.reject(fault('newer'));
    }
    return Promise.resolve().then(function () { return sortOut(JSON.parse(jsonPart(t))); });
  }
  // What the JSON holds. A model may come without its {"brickyard": 1, "model": …} wrapper (the file the designer
  // skill checks is the model itself), so anything with a list of parts at the top is a model.
  function sortOut(o) {
    // A backup also says when it was saved, and carries the models from Claude that were in that browser, under
    // their own heading beside the catalog. They're handed on as they are, for Build from your box to read.
    if (o && o.catalog) {
      var when = typeof o.saved === 'string' ? Date.parse(o.saved) : NaN;
      return { kind: 'catalog', doc: cleanDoc(o), models: o.models && typeof o.models === 'object' && !Array.isArray(o.models) ? o.models : null, saved: isFinite(when) ? when : 0 };
    }
    if (o && o.loose && !o.sets && !o.batch) {
      var lot = cleanLot(o.loose);
      if (!lot || lot.del) throw new Error('empty');
      return { kind: 'loose', lot: lot };
    }
    var sizes = o && (o.sizes || (o.batch && o.batch.sizes)), sets = o && (o.sets || (o.batch && o.batch.sets));
    if (Array.isArray(sizes) && sizes.length && !sets) return { kind: 'sizes', doc: o };
    if (o && ((o.model && typeof o.model === 'object' && Array.isArray(o.model.parts)) || (Array.isArray(o.parts) && !o.batch))) return { kind: 'model', doc: o };
    var b = cleanBatch(o);
    if (!b || !b.sets.length) throw new Error('empty');
    return { kind: 'batch', batch: b };
  }

  var api = {
    linkText: linkText, parseIncoming: parseIncoming, newerLink: newerLink, linkCheck: linkCheck,
    STATES: STATES, STATE_NAMES: STATE_NAMES, s: s, setNum: setNum, shortNum: shortNum, instructionsUrl: instructionsUrl, state: state, cleanSet: cleanSet, stamp: stamp,
    emptyDoc: emptyDoc, cleanCase: cleanCase, cleanPlace: cleanPlace, shelves: shelves, putShelf: putShelf, cleanLot: cleanLot, lotTotals: lotTotals, liveLots: liveLots, yourPieces: yourPieces, measure: measure, readLength: readLength, cleanDoc: cleanDoc, mergeDocs: mergeDocs, sameDoc: sameDoc, live: live, findDup: findDup, findDups: findDups, updateFor: updateFor, repeats: repeats, cleanBatch: cleanBatch,
    foldTwins: foldTwins, doubles: doubles, restoreDoc: restoreDoc, arrived: arrived, arrivedText: arrivedText,
    hash: hash, boxName: boxName, sameBox: sameBox, boxHolds: boxHolds, packing: packing, boxNews: boxNews, boxList: boxList, missingList: missingList, where: where, totals: totals, boxSearch: boxSearch, inBox: inBox, matches: matches, fold: fold, natural: natural, csvCell: csvCell, toCsv: toCsv,
  };
  if (typeof module === 'object' && module.exports) module.exports = api; else root.BrickCore = api;
})(this);
