// Brickyard: the home screen and the catalog of sets.
(function () {
  'use strict';
  var C = window.BrickCore;
  var KEY = 'brickyard.v1', PREFS = 'brickyard.prefs';
  var SITE = 'https://brickyard.junkdrawer.works/';
  var FRAMED = window.top !== window; // the Artifact copy: no downloads

  // ---------- storage ----------
  function read(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } }
  function write(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } }
  var DOC = C.cleanDoc(read(KEY) || {});
  var prefs = Object.assign({ pics: true, group: 'room', show: 'all' }, read(PREFS) || {});
  function save() { if (!write(KEY, { brickyard: 1, catalog: DOC })) toast('This browser wouldn’t save. Download a backup from the menu.'); }
  function savePrefs() { write(PREFS, prefs); }

  function newId() { return 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  function today() { var d = new Date(); return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2); }
  function putSet(x) { x.t = Date.now(); DOC.sets[x.id] = x; }
  function removeSet(id) { DOC.sets[id] = { id: id, t: Date.now(), del: 1 }; }

  // ---------- little helpers ----------
  function $(id) { return document.getElementById(id); }
  function esc(t) { return String(t == null ? '' : t).replace(/[&<>"']/g, function (c) { return '&#' + c.charCodeAt(0) + ';'; }); }
  function plural(n, w) { return n.toLocaleString() + ' ' + w + (n === 1 ? '' : 's'); }
  var toastTimer;
  function toast(msg) {
    var el = document.querySelector('.toast');
    if (!el) { el = document.createElement('div'); el.className = 'toast'; el.setAttribute('role', 'status'); document.body.appendChild(el); }
    el.textContent = msg; el.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { el.hidden = true; }, 3200);
  }
  function picHtml(x, cls) {
    var brick = '<svg width="34" height="26" viewBox="0 0 34 26" aria-hidden="true"><rect x="1" y="7" width="32" height="18" rx="2" fill="var(--line)"/><rect x="5" y="2" width="8" height="6" rx="1.5" fill="var(--line)"/><rect x="21" y="2" width="8" height="6" rx="1.5" fill="var(--line)"/></svg>';
    if (!prefs.pics || !x.num) return '<div class="pic none ' + (cls || '') + '">' + brick + '</div>';
    return '<div class="pic ' + (cls || '') + '"><img alt="" loading="lazy" src="https://cdn.rebrickable.com/media/thumbs/sets/' + esc(x.num) + '.jpg/' + (cls === 'head-pic' ? '1000x800p' : '250x250p') + '.jpg" data-fallback="1"></div>';
  }
  // A picture that doesn't exist turns back into the plain brick.
  document.addEventListener('error', function (e) {
    var img = e.target;
    if (img && img.tagName === 'IMG' && img.dataset.fallback) {
      var box = img.parentNode; box.classList.add('none');
      box.innerHTML = '<svg width="34" height="26" viewBox="0 0 34 26" aria-hidden="true"><rect x="1" y="7" width="32" height="18" rx="2" fill="var(--line)"/><rect x="5" y="2" width="8" height="6" rx="1.5" fill="var(--line)"/><rect x="21" y="2" width="8" height="6" rx="1.5" fill="var(--line)"/></svg>';
    }
  }, true);
  function metaLine(x) {
    return [C.shortNum(x.num), x.year, x.pieces ? plural(x.pieces, 'piece') : ''].filter(Boolean).join(' · ');
  }
  function download(name, type, text) {
    if (FRAMED) { toast('Downloads don’t work in this preview. Open Brickyard at its own address.'); return; }
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: type }));
    a.download = name; document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  // ---------- screens ----------
  function route() {
    var onCat = location.hash === '#catalog';
    $('home').hidden = onCat; $('catalog').hidden = !onCat;
    if (onCat) renderCatalog(); else renderHome();
    window.scrollTo(0, 0);
  }
  window.addEventListener('hashchange', function () { if (!checkLink()) route(); });
  window.addEventListener('scroll', function () {
    document.querySelectorAll('.bar').forEach(function (b) { b.classList.toggle('scrolled', window.scrollY > 4); });
  }, { passive: true });

  function renderHome() {
    var t = C.totals(C.live(DOC));
    $('home-stat').textContent = t.sets ? plural(t.sets, 'set') + (t.pieces ? ' · ' + plural(t.pieces, 'piece') : '') : 'Nothing here yet. Start with your sets.';
  }

  var FILTERS = [
    ['all', 'All'], ['built', 'Built'], ['partial', 'Partly built'], ['apart', 'Taken apart'], ['sealed', 'Sealed'],
    ['missing', 'Missing pieces'], ['check', 'To check'],
  ];
  function passes(x) {
    var f = prefs.show;
    if (f === 'all') return true;
    if (f === 'missing') return !!x.missing;
    if (f === 'check') return !!x.check;
    return x.state === f;
  }

  function groupOf(x) {
    switch (prefs.group) {
      case 'box': return x.box ? 'Box ' + x.box : 'Not packed';
      case 'theme': return x.theme || 'No theme';
      case 'state': return C.STATE_NAMES[x.state] || 'State not set';
      case 'new': return '';
      default: return x.room ? x.room + (x.spot ? ' › ' + x.spot : '') : 'No room yet';
    }
  }

  function renderCatalog() {
    var all = C.live(DOC), q = $('q').value.trim(), t = C.totals(all);
    $('cat-tools').hidden = !all.length;
    if (!FILTERS.some(function (f) { return f[0] === prefs.show; })) prefs.show = 'all';
    $('chips').innerHTML = FILTERS.filter(function (f) {
      return f[0] === 'all' || f[0] === prefs.show || (f[0] === 'missing' ? t.missing : f[0] === 'check' ? t.check : t[f[0]]);
    }).map(function (f) {
      var n = f[0] === 'all' ? t.sets : f[0] === 'missing' ? t.missing : f[0] === 'check' ? t.check : (t[f[0]] || 0);
      return '<button class="chip" type="button" data-f="' + f[0] + '" aria-pressed="' + (prefs.show === f[0]) + '">' + esc(f[1]) + '<span class="n">' + n + '</span></button>';
    }).join('');
    $('group').value = prefs.group;
    fillLists(all);

    if (!all.length) {
      $('list-wrap').innerHTML = '<div class="empty"><svg width="80" height="60" viewBox="0 0 88 72" aria-hidden="true"><rect x="14" y="30" width="60" height="34" rx="4" fill="var(--red)"/><rect x="21" y="22" width="14" height="9" rx="2" fill="var(--red)"/><rect x="53" y="22" width="14" height="9" rx="2" fill="var(--red)"/></svg>' +
        '<h2>No sets yet</h2><p>Send Claude photos of your boxes or built models and open the link it gives you. Or add a set by its number.</p>' +
        '<div class="acts"><button class="btn quiet" type="button" data-act="claude">How to add from photos</button><button class="btn" type="button" data-act="add">+ Add a set</button></div></div>';
      $('sum').textContent = '';
      return;
    }

    var shown = all.filter(function (x) { return passes(x) && C.matches(x, q); });
    $('sum').textContent = (shown.length === all.length ? plural(all.length, 'set') : shown.length + ' of ' + all.length + ' sets') +
      (t.pieces ? ' · ' + C.totals(shown).pieces.toLocaleString() + ' pieces' : '');
    if (!shown.length) { $('list-wrap').innerHTML = '<div class="empty"><p>Nothing matches. Try another word or filter.</p></div>'; return; }

    if (prefs.group === 'new') shown.sort(function (a, b) { return (b.added || '').localeCompare(a.added || '') || b.t - a.t; });
    else shown.sort(function (a, b) {
      var ga = groupOf(a), gb = groupOf(b), la = /^(No |Not |State not)/.test(ga), lb = /^(No |Not |State not)/.test(gb);
      if (la !== lb) return la ? 1 : -1;
      if (prefs.group === 'state') { var sa = C.STATES.indexOf(a.state), sb = C.STATES.indexOf(b.state); if (sa !== sb) return sa - sb; }
      return C.natural(ga, gb) || C.natural(a.name || '', b.name || '');
    });

    var html = '', last = null;
    shown.forEach(function (x) {
      var g = groupOf(x);
      if (g !== last) {
        if (last !== null) html += '</ul>';
        var n = shown.filter(function (y) { return groupOf(y) === g; }).length;
        html += (g ? '<h3 class="group"><span>' + esc(g) + '</span><span>' + n + '</span></h3>' : '') + '<ul class="list">';
        last = g;
      }
      var sub = prefs.group === 'room' ? (x.box ? 'Box ' + x.box : '') : prefs.group === 'box' ? [x.room, x.spot].filter(Boolean).join(' › ') : C.where(x);
      html += '<li><button class="item" type="button" data-id="' + esc(x.id) + '">' + picHtml(x) +
        '<div class="main"><div class="t">' + esc(x.name || 'Set ' + C.shortNum(x.num)) + '</div><div class="m">' + esc(metaLine(x)) + '</div>' +
        (sub ? '<div class="m">' + esc(sub) + '</div>' : '') +
        (x.missing || x.check ? '<div class="m warn">' + [x.missing ? 'Missing pieces' : '', x.check ? 'Check' : ''].filter(Boolean).join(' · ') + '</div>' : '') + '</div>' +
        (x.state ? '<span class="badge ' + x.state + '">' + esc(C.STATE_NAMES[x.state]) + '</span>' : '<span></span>') + '</button></li>';
    });
    $('list-wrap').innerHTML = html + '</ul>';
  }

  function fillLists(all) {
    [['dl-room', 'room'], ['dl-spot', 'spot'], ['dl-box', 'box'], ['dl-theme', 'theme']].forEach(function (p) {
      var seen = {};
      all.forEach(function (x) { if (x[p[1]]) seen[x[p[1]]] = 1; });
      $(p[0]).innerHTML = Object.keys(seen).sort(C.natural).map(function (v) { return '<option value="' + esc(v) + '">'; }).join('');
    });
  }

  $('q').addEventListener('input', renderCatalog);
  $('group').addEventListener('change', function () { prefs.group = this.value; savePrefs(); renderCatalog(); });
  $('chips').addEventListener('click', function (e) {
    var b = e.target.closest('.chip'); if (!b) return;
    prefs.show = b.dataset.f; savePrefs(); renderCatalog();
  });
  $('list-wrap').addEventListener('click', function (e) {
    var b = e.target.closest('[data-id]'); if (b) return editSheet(DOC.sets[b.dataset.id]);
    var a = e.target.closest('[data-act]'); if (!a) return;
    if (a.dataset.act === 'add') editSheet(null); else claudeSheet();
  });
  $('add-btn').addEventListener('click', function () { editSheet(null); });
  $('claude-btn').addEventListener('click', claudeSheet);
  $('menu-btn').addEventListener('click', menuSheet);

  // ---------- sheets ----------
  var openScrim = null, lastFocus = null;
  function openSheet(html, onClose) {
    closeSheet();
    lastFocus = document.activeElement;
    var scrim = document.createElement('div');
    scrim.className = 'scrim';
    scrim.innerHTML = '<div class="sheet" role="dialog" aria-modal="true" aria-labelledby="sheetTitle">' + html + '</div>';
    scrim.addEventListener('click', function (e) { if (e.target === scrim) closeSheet(); });
    scrim._onClose = onClose;
    document.body.appendChild(scrim);
    document.body.style.overflow = 'hidden';
    openScrim = scrim;
    var f = scrim.querySelector('[autofocus]') || scrim.firstChild;
    if (f === scrim.firstChild) f.tabIndex = -1;
    f.focus({ preventScroll: true });
    return scrim.firstChild;
  }
  function closeSheet() {
    if (!openScrim) return;
    var s = openScrim; openScrim = null;
    s.remove(); document.body.style.overflow = '';
    if (s._onClose) s._onClose();
    if (lastFocus && lastFocus.focus && document.contains(lastFocus)) lastFocus.focus();
  }
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && openScrim) closeSheet(); });

  function field(label, inner) { return '<label class="field"><span>' + label + '</span>' + inner + '</label>'; }
  function input(id, val, extra) { return '<input id="' + id + '" value="' + esc(val == null ? '' : val) + '" autocomplete="off"' + (extra || '') + '>'; }

  function editSheet(x) {
    var isNew = !x;
    x = x ? JSON.parse(JSON.stringify(x)) : { id: newId(), state: 'built' };
    var z = x.size || {};
    var panel = openSheet(
      '<div class="hd"><h2 id="sheetTitle">' + (isNew ? 'Add a set' : esc(x.name || 'Set ' + C.shortNum(x.num))) + '</h2><button class="btn sm quiet" type="button" data-close>Close</button></div>' +
      '<div class="bd">' +
      (isNew ? '' : picHtml(x, 'head-pic')) +
      (x.check ? '<p class="flag"><span><b>Check:</b> ' + esc(x.check) + '</span><button class="btn sm quiet" type="button" id="e-ok">It’s right</button></p>' : '') +
      '<div class="two">' + field('Set number', input('e-num', C.shortNum(x.num), ' inputmode="text" placeholder="10698"' + (isNew ? ' autofocus' : ''))) + field('Year', input('e-year', x.year || '', ' inputmode="numeric"')) + '</div>' +
      field('Name', input('e-name', x.name, ' placeholder="Large Creative Brick Box"')) +
      '<div class="two">' + field('Pieces', input('e-pieces', x.pieces || '', ' inputmode="numeric"')) + field('Theme', input('e-theme', x.theme, ' list="dl-theme" placeholder="Classic"')) + '</div>' +
      '<div class="field"><span class="lbl">State</span><div class="seg" id="e-state">' + C.STATES.map(function (k) {
        return '<button type="button" data-v="' + k + '" aria-pressed="' + (x.state === k) + '">' + C.STATE_NAMES[k].replace('Taken apart', 'Apart') + '</button>';
      }).join('') + '</div></div>' +
      '<div class="two">' + field('Room', input('e-room', x.room, ' list="dl-room" placeholder="Office"')) + field('Shelf or spot', input('e-spot', x.spot, ' list="dl-spot" placeholder="Top shelf"')) + '</div>' +
      field('Moving box', input('e-box', x.box, ' list="dl-box" placeholder="Leave blank if it’s not packed"')) +
      field('Missing pieces', '<textarea id="e-missing" placeholder="e.g. one red 2×4 brick, the minifigure’s hat">' + esc(x.missing) + '</textarea>') +
      '<label class="check"><input type="checkbox" id="e-instr"' + (x.instr ? ' checked' : '') + '> I have the paper instructions</label>' +
      '<div class="field"><span class="lbl">Size when built, in cm (for the shelf planner)</span><div class="three">' +
      input('e-w', z.w || '', ' inputmode="decimal" placeholder="Width" aria-label="Width in cm"') + input('e-d', z.d || '', ' inputmode="decimal" placeholder="Depth" aria-label="Depth in cm"') + input('e-h', z.h || '', ' inputmode="decimal" placeholder="Height" aria-label="Height in cm"') + '</div></div>' +
      field('Tags', input('e-tags', (x.tags || []).join(', '), ' placeholder="Comma between tags"')) +
      field('Notes', '<textarea id="e-notes">' + esc(x.notes) + '</textarea>') +
      '</div>' +
      '<div class="ft">' + (isNew ? '<span></span>' : '<button class="btn danger" type="button" id="e-del">Remove</button>') + '<button class="btn" type="button" id="e-save">' + (isNew ? 'Add set' : 'Save') + '</button></div>');

    var st = x.state;
    panel.querySelector('[data-close]').onclick = closeSheet;
    $('e-state').onclick = function (e) {
      var b = e.target.closest('button'); if (!b) return;
      st = st === b.dataset.v ? '' : b.dataset.v;
      this.querySelectorAll('button').forEach(function (y) { y.setAttribute('aria-pressed', y.dataset.v === st); });
    };
    if ($('e-ok')) $('e-ok').onclick = function () { delete x.check; this.parentNode.remove(); };
    if ($('e-del')) $('e-del').onclick = function () {
      if (!confirm('Remove ' + (x.name || 'this set') + ' from your catalog?')) return;
      removeSet(x.id); save(); closeSheet(); renderCatalog(); toast('Removed');
    };
    $('e-save').onclick = function () {
      var raw = $('e-num').value.trim(), num = C.setNum(raw);
      if (raw && !num) { toast('That set number doesn’t look right. It’s usually 4 or 5 digits.'); $('e-num').focus(); return; }
      var y = C.cleanSet({
        num: num, name: $('e-name').value, year: $('e-year').value, pieces: $('e-pieces').value, theme: $('e-theme').value, state: st,
        room: $('e-room').value, spot: $('e-spot').value, box: $('e-box').value, missing: $('e-missing').value,
        instr: $('e-instr').checked ? true : (x.instr === false ? false : null), tags: $('e-tags').value, notes: $('e-notes').value,
        size: { w: $('e-w').value, d: $('e-d').value, h: $('e-h').value }, check: x.check, added: x.added || today(),
      });
      if (!y) { toast('Give it a set number or a name.'); $('e-num').focus(); return; }
      if (isNew) {
        var dup = C.findDup(DOC, y);
        if (dup && !confirm('You already have ' + (dup.name || 'this set') + '. Add another copy?')) return;
      }
      y.id = x.id; putSet(y); save(); closeSheet(); renderCatalog();
      toast(isNew ? 'Added' : 'Saved');
    };
  }

  // ---------- adding from Claude ----------
  function claudeSheet() {
    var panel = openSheet('<div class="hd"><h2 id="sheetTitle">Add from photos</h2><button class="btn sm quiet" type="button" data-close>Close</button></div><div class="bd">' +
      '<div class="how"><b>With Claude</b><ol><li>Take photos of your set boxes, the instruction books, or the built models. The set number on a box is the best thing to get in the picture.</li>' +
      '<li>Send them to Claude and say where they are (a room and shelf, or a moving box number).</li><li>Claude sends back a Brickyard link. Open it, check the list, and tap <b>Add</b>.</li></ol></div>' +
      '<p class="note">Claude gives you a file too, in case the link is too long. Open it, or paste the link or file text here:</p>' +
      '<textarea class="paste" id="paste" placeholder="Paste a Brickyard link or file" aria-label="Paste a Brickyard link or file"></textarea>' +
      '</div><div class="ft"><button class="btn quiet" type="button" id="p-file">Open a file</button><button class="btn" type="button" id="p-go">Open</button></div>');
    panel.querySelector('[data-close]').onclick = closeSheet;
    $('p-file').onclick = function () { $('file').click(); };
    $('p-go').onclick = function () { var t = $('paste').value; if (!t.trim()) { $('paste').focus(); return; } takeIncoming(C.parseIncoming(t)); };
  }

  function takeIncoming(p) {
    return p.then(function (r) { if (r.kind === 'catalog') catalogSheet(r.doc); else reviewSheet(r.batch); })
      .catch(function (e) { toast(e && /browser/.test(e.message) ? e.message : 'That doesn’t look like sets from Claude or a Brickyard file'); });
  }
  function checkLink() {
    var h = location.hash;
    if (!/^#(b1[zj]|batch=)/.test(h)) return false;
    try { history.replaceState(null, '', location.pathname + location.search + '#catalog'); } catch (e) { location.hash = '#catalog'; }
    route();
    takeIncoming(C.linkText(h).then(function (t) { if (!t) throw new Error('empty'); return C.parseIncoming(t); }));
    return true;
  }
  $('file').addEventListener('change', function () {
    var f = this.files && this.files[0]; this.value = '';
    if (!f) return;
    f.text().then(function (t) { takeIncoming(C.parseIncoming(t)); });
  });

  function reviewSheet(batch) {
    var rows = batch.sets.map(function (x) { var dup = C.findDup(DOC, x); return { x: x, dup: dup, on: !dup }; });
    var seenAt = DOC.seen[batch.id];
    var nd = rows.filter(function (r) { return r.dup; }).length, nc = rows.filter(function (r) { return r.x.check; }).length;
    var panel = openSheet('<div class="hd"><h2 id="sheetTitle">Add sets from Claude</h2><button class="btn sm quiet" type="button" data-close>Not now</button></div><div class="bd">' +
      '<p class="lede">' + (batch.name ? '<b>' + esc(batch.name) + '</b> · ' : '') + plural(rows.length, 'set') + (nd ? ' · ' + nd + ' you already have' : '') + (nc ? ' · ' + nc + ' to check' : '') + '</p>' +
      (seenAt ? '<p class="flag"><span>You opened this link before. Sets you already have are unticked.</span></p>' : '') +
      '<div class="bulk"><span class="lbl">Put them all in</span><div class="two"><input id="rv-room" list="dl-room" placeholder="Room" value="' + esc(batch.room) + '" autocomplete="off"><input id="rv-spot" list="dl-spot" placeholder="Shelf or spot" value="' + esc(batch.spot) + '" autocomplete="off"></div>' +
      '<input id="rv-box" list="dl-box" placeholder="Moving box" value="' + esc(batch.box) + '" autocomplete="off">' +
      '<span class="note" style="margin:0">Leave these blank to keep what Claude put for each set.</span></div>' +
      '<ul class="rv" id="rv">' + rows.map(function (r, i) {
        var x = r.x, meta = [metaLine(x), C.STATE_NAMES[x.state], C.where(x)].filter(Boolean).join(' · ');
        return '<li data-i="' + i + '"' + (r.on ? '' : ' class="off"') + '><input type="checkbox" aria-label="Add ' + esc(x.name || 'this set') + '"' + (r.on ? ' checked' : '') + '>' + picHtml(x) +
          '<div><div class="t">' + esc(x.name || 'Set ' + C.shortNum(x.num)) + '</div><div class="m">' + esc(meta) + '</div>' +
          (r.dup ? '<div class="w">You already have this one' + (C.where(r.dup) ? ' (' + esc(C.where(r.dup)) + ')' : '') + '</div>' : '') +
          (x.check ? '<div class="w">Check: ' + esc(x.check) + '</div>' : '') + '</div></li>';
      }).join('') + '</ul></div>' +
      '<div class="ft"><span class="note" id="rv-n" style="margin:0"></span><button class="btn" type="button" id="rv-add">Add</button></div>');
    function count() {
      var n = rows.filter(function (r) { return r.on; }).length;
      $('rv-n').textContent = n + ' of ' + rows.length + ' ticked';
      $('rv-add').textContent = n ? 'Add ' + plural(n, 'set') : 'Add';
      $('rv-add').disabled = !n;
    }
    panel.querySelector('[data-close]').onclick = closeSheet;
    $('rv').onchange = function (e) {
      var li = e.target.closest('li'); if (!li) return;
      rows[+li.dataset.i].on = e.target.checked; li.classList.toggle('off', !e.target.checked); count();
    };
    $('rv-add').onclick = function () {
      var room = $('rv-room').value.trim(), spot = $('rv-spot').value.trim(), box = $('rv-box').value.trim(), n = 0, day = today();
      rows.forEach(function (r) {
        if (!r.on) return;
        var y = Object.assign({}, r.x);
        if (room && room !== batch.room) { y.room = room; y.spot = spot; }
        else if (spot && spot !== batch.spot) y.spot = spot;
        if (box !== batch.box) y.box = box;
        y = C.cleanSet(Object.assign(y, { added: day }));
        if (!y) return;
        y.id = newId(); putSet(y); n++;
      });
      DOC.seen[batch.id] = Date.now();
      save(); closeSheet(); renderCatalog();
      toast('Added ' + plural(n, 'set'));
    };
    count();
  }

  function catalogSheet(doc) {
    var incoming = C.live(doc).length;
    var panel = openSheet('<div class="hd"><h2 id="sheetTitle">Open a Brickyard file</h2><button class="btn sm quiet" type="button" data-close>Cancel</button></div><div class="bd">' +
      '<p class="lede">This file has ' + plural(incoming, 'set') + '. Bringing it in merges it with what’s here, set by set, keeping whichever copy was changed last. Nothing here is lost.</p></div>' +
      '<div class="ft"><span></span><button class="btn" type="button" id="cs-go">Merge it in</button></div>');
    panel.querySelector('[data-close]').onclick = closeSheet;
    $('cs-go').onclick = function () {
      DOC = C.mergeDocs(DOC, doc); save(); closeSheet(); renderCatalog(); toast('Merged. You have ' + plural(C.live(DOC).length, 'set') + '.');
    };
  }

  // ---------- menu ----------
  function menuSheet() {
    var panel = openSheet('<div class="hd"><h2 id="sheetTitle">Brickyard</h2><button class="btn sm quiet" type="button" data-close>Close</button></div><div class="bd"><ul class="menu">' +
      '<li><button type="button" id="m-claude"><span>Add from photos<small>Send Claude pictures of your sets and open its link</small></span></button></li>' +
      (FRAMED ? '' : '<li><button type="button" id="m-backup"><span>Download a backup<small>Your whole catalog as one file. Open it on another device to merge.</small></span></button></li>') +
      '<li><button type="button" id="m-open"><span>Open a file<small>A backup, or sets from Claude</small></span></button></li>' +
      (FRAMED ? '' : '<li><button type="button" id="m-csv"><span>Download a spreadsheet<small>CSV, for Excel, Numbers or Google Sheets</small></span></button></li>') +
      '<li><label><input type="checkbox" id="m-pics"' + (prefs.pics ? ' checked' : '') + ' style="width:20px;height:20px;accent-color:var(--red)"><span>Show set pictures<small>Loaded from Rebrickable by set number. Nothing else is sent.</small></span></label></li>' +
      '</ul><p class="note">Your catalog is kept in this browser only. Download a backup now and then, and before you clear your browser’s data.</p></div>');
    panel.querySelector('[data-close]').onclick = closeSheet;
    $('m-claude').onclick = claudeSheet;
    $('m-open').onclick = function () { closeSheet(); $('file').click(); };
    if ($('m-backup')) $('m-backup').onclick = function () { closeSheet(); download('Brickyard ' + today() + '.json', 'application/json', JSON.stringify({ brickyard: 1, catalog: DOC }, null, 1)); };
    if ($('m-csv')) $('m-csv').onclick = function () {
      closeSheet();
      var sets = C.live(DOC).sort(function (a, b) { return C.natural(a.name || '', b.name || ''); });
      download('Brickyard sets ' + today() + '.csv', 'text/csv', '﻿' + C.toCsv(sets));
    };
    $('m-pics').onchange = function () { prefs.pics = this.checked; savePrefs(); renderCatalog(); };
  }

  // Another tab changed the catalog.
  window.addEventListener('storage', function (e) {
    if (e.key !== KEY) return;
    DOC = C.mergeDocs(DOC, C.cleanDoc(read(KEY) || {}));
    if (!openScrim) route();
  });

  if ('serviceWorker' in navigator && window.isSecureContext && !FRAMED) navigator.serviceWorker.register('sw.js').catch(function () {});
  if (!checkLink()) route();
  window.brickyard = { doc: function () { return DOC; } };
})();
