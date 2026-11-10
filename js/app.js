// Brickyard: the home screen and the catalog of sets.
(function () {
  'use strict';
  var C = window.BrickCore;
  var KEY = 'brickyard.v1', PREFS = 'brickyard.prefs', TOOK = 'brickyard.took';
  var SITE = 'https://brickyard.junkdrawer.works/';
  var FRAMED = window.top !== window; // the Artifact copy: no downloads

  // ---------- storage ----------
  function read(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } }
  function write(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } }
  var DOC = C.cleanDoc(read(KEY) || {});
  var prefs = Object.assign({ pics: true, group: 'room' }, read(PREFS) || {});
  if (FRAMED) prefs.pics = false;
  // Which sets My sets shows (All, Built, To check…) lasts for the visit only. It used to be remembered with the
  // rest, and a filter left on weeks before opened My sets on three sets of a hundred, with its lit chip off the
  // side of the screen.
  var show = 'all';
  if ('show' in prefs) { delete prefs.show; write(PREFS, prefs); }
  function save() {
    // Held, so the "Added" or "Saved" that follows in the same tap doesn't cover it: it's the only sign the change
    // will be gone after a reload. The preview copy has no backup download, but it can copy everything as a link.
    if (!write(KEY, { brickyard: 1, catalog: DOC })) {
      toast(FRAMED ? 'This browser wouldn’t save. Copy everything as a link from the menu to keep your sets.'
        : 'This browser wouldn’t save. Download a backup from the menu.', true);
    }
    document.dispatchEvent(new CustomEvent('brickyard:saved')); // Drive sync (js/sync.js) picks it up
  }
  function savePrefs() { write(PREFS, prefs); }

  function newId() { return 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  function today() { var d = new Date(); return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2); }
  function putSet(x) { x.t = Date.now(); DOC.sets[x.id] = x; }
  function removeSet(id) { DOC.sets[id] = { id: id, t: Date.now(), del: 1 }; }
  // Puts back a set, bookcase or lot ('sets', 'cases', 'loose') that was removed, as it was, timed after the
  // removal. When catalogs merge the later change wins, so the removal doesn't take it away again, here or on
  // another device.
  function putBack(kind, x) { var gone = DOC[kind][x.id]; x.t = Math.max(Date.now(), gone ? gone.t + 1 : 0); DOC[kind][x.id] = x; }

  // ---------- little helpers ----------
  function $(id) { return document.getElementById(id); }
  function esc(t) { return String(t == null ? '' : t).replace(/[&<>"']/g, function (c) { return '&#' + c.charCodeAt(0) + ';'; }); }
  function plural(n, w) { return n.toLocaleString() + ' ' + w + (n === 1 ? '' : 's'); }
  // ---------- messages ----------
  // The message at the bottom of the screen, in a region that's on the page from the start and stays there: a
  // screen reader follows a region it already knows, and tends to miss one that arrives with its first words in it.
  // The words go in after the message is shown, for the same reason. `aside` is for words that are read out but
  // not shown (say).
  var says = document.createElement('div'), toastEl = document.createElement('div'), aside = document.createElement('span');
  says.setAttribute('role', 'status'); toastEl.className = 'toast'; toastEl.hidden = true; aside.className = 'vh';
  says.appendChild(toastEl); says.appendChild(aside); document.body.appendChild(says);
  var toastTimer, toastEnds = 0, toastLeft = 0, toastHeld = false, toastStays = false, toastN = 0, over = 0, queued = null;
  var MAC = /Mac|iPhone|iPad/.test(navigator.platform || '');
  // A tap on a message puts it away: a long one can sit over the box you want to type in next. Not a held one
  // (it's the only sign something went wrong), and not by a tap on its button.
  toastEl.addEventListener('click', function (e) { if (!toastHeld && !e.target.closest('button')) hideToast(); });
  // It waits while the mouse is on it or its button has the keyboard's focus, and goes a moment after.
  function linger(bit, on) {
    var was = over; over = on ? over | bit : over & ~bit;
    if (toastEl.hidden || !was === !over) return;
    if (over) { toastLeft = Math.max(toastEnds - Date.now(), 1500); clearTimeout(toastTimer); }
    else runToast(toastLeft);
  }
  toastEl.addEventListener('pointerenter', function (e) { if (e.pointerType === 'mouse') linger(1, true); });
  toastEl.addEventListener('pointerleave', function () { linger(1, false); });
  toastEl.addEventListener('focusin', function () { linger(2, true); });
  toastEl.addEventListener('focusout', function () { linger(2, false); });
  function runToast(ms) { clearTimeout(toastTimer); toastEnds = Date.now() + ms; toastTimer = setTimeout(hideToast, ms); }
  // How long a message stays: 3.2 seconds, and longer the more there is to read (50 ms a character past 40, up
  // to 10 seconds). A held message stays at least 6 seconds, and nothing else replaces it meanwhile. One with an
  // action ({ label, run }, such as Undo) carries a button and stays 10 seconds, but the next message takes its
  // place; so does a 'long' one (hold is 'long'), a couple of sentences that get at least 6 seconds.
  function toast(msg, hold, action) {
    var stay = hold === 'long';
    hold = hold === true;
    if (!hold && toastHeld && !toastEl.hidden) return;
    var el = toastEl;
    el.className = action ? 'toast act' : 'toast';
    el.hidden = false; el.textContent = '';
    el.appendChild(document.createElement('span')).textContent = msg;
    if (action) {
      var b = el.appendChild(document.createElement('button'));
      b.type = 'button'; b.textContent = action.label;
      // Ctrl+Z (Cmd+Z on a Mac) presses Undo while it shows: by keyboard the button is past every set in the list.
      if (action.label === 'Undo') { b.dataset.undo = '1'; b.title = 'Undo (' + (MAC ? '⌘Z' : 'Ctrl+Z') + ')'; }
      b.onclick = function () { hideToast(true); action.run(); };
    }
    var ms = Math.min(3200 + Math.max(0, String(msg).length - 40) * 50, 10000);
    if (hold || stay) ms = Math.max(ms, 6000);
    if (action) ms = 10000;
    toastHeld = hold; toastStays = !!(hold || stay || action); toastN++; over = 0;
    runToast(ms);
  }
  // `pressed` is true when the message's own button put it away: a message that was waiting (toastAfter) waits on,
  // for whatever the button says next.
  function hideToast(pressed) {
    toastEl.hidden = true;
    clearTimeout(toastTimer); toastHeld = false; toastStays = false; over = 0;
    if (pressed === true || !queued) return;
    var next = queued; queued = null;
    setTimeout(function () { toastAfter(next[0], next[1]); }, 400);
  }
  // A message that can wait (Drive sync saying it failed): shown once whatever is showing has gone, so it never
  // takes the place of an Undo. The last one waiting is the one shown.
  function toastAfter(msg, hold) {
    if (toastEl.hidden) toast(msg, hold); else queued = [msg, hold];
  }
  // Words for a screen reader only, such as a button's new words when its first press turned it into a question.
  var sayTimer = 0;
  function say(t) {
    aside.textContent = ''; clearTimeout(sayTimer);
    sayTimer = setTimeout(function () { aside.textContent = t; sayTimer = setTimeout(function () { aside.textContent = ''; }, 5000); }, 50);
  }
  document.addEventListener('keydown', function (e) {
    if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey || (e.key !== 'z' && e.key !== 'Z')) return;
    var b = !toastEl.hidden && toastEl.querySelector('button[data-undo]'), a = document.activeElement;
    // In a box being typed in, Ctrl+Z is the box's own undo.
    var typing = a && (a.tagName === 'TEXTAREA' || a.isContentEditable || (a.tagName === 'INPUT' && !/^(checkbox|radio|button|range|file)$/.test(a.type)));
    if (!b || typing) return;
    e.preventDefault(); b.click();
  });
  // Removing and doubling up take a second tap, so nothing goes on one slip. It has to come a moment after the
  // first, so a double tap is still one tap. True when this tap is the one that confirms.
  function secondTap(btn, key) {
    key = key || 'sure';
    var first = Number(btn.dataset[key] || 0);
    if (!first) {
      btn.dataset[key] = String(Date.now());
      // The button's new words ("Tap again to remove") are read out: a screen reader doesn't read again a button
      // it's already on. Not when the first press said more in a message of its own.
      var n = toastN;
      setTimeout(function () { if (toastN === n && document.contains(btn)) say(btn.textContent); }, 0);
      return false;
    }
    return Date.now() - first >= 600;
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
  // #catalog is My sets; #build, #model-… and model links (#d1z…) belong to Build from your box (js/build.js);
  // #shelves and sizes links (#z1z…) to the shelf planner (js/shelves.js).
  function route() {
    // Going to another screen (Back, or a link) closes an open sheet, so it isn't left over the screen before with
    // the page under it locked. A sheet opened for the address being shown stays: the preview opens its example
    // just after moving to My sets, before the browser says it moved. History has moved on already, so the sheet
    // only comes off the screen.
    if (openScrim && openScrim._at !== location.hash) dropSheet();
    var h = location.hash, onCat = h === '#catalog', onBuild = /^#(build|model-|d1[zj])/.test(h), onShelves = /^#(shelves|z1[zj])/.test(h);
    $('home').hidden = onCat || onBuild || onShelves; $('catalog').hidden = !onCat; $('build').hidden = !onBuild; $('shelves').hidden = !onShelves;
    // Each screen has its own title, for the tab, the browser's history and a phone's app switcher (they all read
    // "Brickyard"). A model's is its name, once Build from your box has it open (js/build.js).
    document.title = onCat ? 'My sets · Brickyard' : onBuild ? 'Build from your box · Brickyard' : onShelves ? 'Shelf planner · Brickyard' : 'Brickyard';
    if (onCat) renderCatalog(); else if (!onBuild && !onShelves) renderHome();
    window.scrollTo(0, 0);
    // On a move to another screen its heading takes the focus, so a screen reader says where this is and Tab starts
    // from the top of it (the link that was pressed is hidden by now, which left the focus nowhere). Not when
    // Brickyard opens, and Build from your box says when its heading is ready (a model's name).
    var screen = onBuild ? h.replace(/^#d1[zj].*/, '#model-') : onCat ? 'catalog' : onShelves ? 'shelves' : 'home';
    arriving = !!onScreenNow && onScreenNow !== screen;
    onScreenNow = screen;
    if (!onBuild) heading();
    document.dispatchEvent(new CustomEvent('brickyard:route', { detail: h }));
  }
  var onScreenNow = '', arriving = false;
  function heading() {
    if (!arriving) return;
    arriving = false;
    var h1 = document.querySelector('body > section:not([hidden]) h1');
    // A sheet opened for this screen keeps the focus, and gets it back to give to the heading when it closes.
    if (openScrim) lastFocus = h1; else if (h1) h1.focus({ preventScroll: true });
  }
  window.addEventListener('hashchange', function () { if (!checkLink()) route(); });
  window.addEventListener('scroll', function () {
    document.querySelectorAll('.bar').forEach(function (b) { b.classList.toggle('scrolled', window.scrollY > 4); });
  }, { passive: true });

  function renderHome() {
    var t = C.totals(C.live(DOC));
    var loose = C.liveLots(DOC).reduce(function (n, l) { return n + C.lotTotals(l).pieces; }, 0);
    $('home-stat').textContent = t.sets ? plural(t.sets, 'set') + (t.pieces ? ' · ' + plural(t.pieces, 'piece') : '') : 'Nothing here yet. Start with your sets.';
    var models = 0;
    try {
      var saved = JSON.parse(localStorage.getItem('brickyard.models') || '{}') || {};
      models = Object.keys(saved).filter(function (k) { return saved[k] && saved[k].model; }).length; // as Build from your box lists them
    } catch (e) { /* none saved */ }
    $('home-build-stat').textContent = [models ? plural(models, 'model') + ' from Claude' : '', loose ? plural(loose, 'loose piece') : ''].filter(Boolean).join(' · ') || 'Try the example cottage';
    var cases = Object.keys(DOC.cases).map(function (k) { return DOC.cases[k]; }).filter(function (c) { return !c.del; });
    var on = Object.keys(window.ShelfCore.placements(cases)).filter(function (id) { return DOC.sets[id] && !DOC.sets[id].del; }).length;
    $('home-shelf-stat').textContent = cases.length ? plural(cases.length, 'bookcase') + ' · ' + plural(on, 'set') + ' on shelves' : 'Start with your bookcases';
  }

  var FILTERS = [
    ['all', 'All'], ['built', 'Built'], ['partial', 'Partly built'], ['apart', 'Taken apart'], ['sealed', 'Sealed'],
    ['missing', 'Missing pieces'], ['check', 'To check'],
  ];
  function passes(x) {
    var f = show;
    if (f === 'all') return true;
    if (f === 'missing') return !!x.missing;
    if (f === 'check') return !!x.check;
    return x.state === f;
  }

  function groupOf(x) {
    switch (prefs.group) {
      case 'box': return x.box ? 'Box ' + C.boxName(x.box) : 'Not packed';
      case 'theme': return x.theme || 'No theme';
      case 'state': return C.STATE_NAMES[x.state] || 'State not set';
      case 'new': return '';
      default: return x.room ? x.room + (x.spot ? ' › ' + x.spot : '') : 'No room yet';
    }
  }

  // The keyboard's place survives the list being drawn again (Save, Remove, Undo, a filter chip, a catalog arriving
  // from sync): a row or a chip is found again by its set or its filter, and where a removed set's row was, the row
  // that took its place has it. The same for the row a sheet will give the focus back to when it closes. It used
  // to be thrown back to the top of the page each time.
  function allRows() { return [].slice.call(document.querySelectorAll('#list-wrap .item[data-id]')); }
  function spot(el) {
    if (!el || !el.dataset || !($('list-wrap').contains(el) || $('chips').contains(el))) return null;
    return { id: el.dataset.id, f: el.dataset.f, at: allRows().indexOf(el) };
  }
  function found(s) {
    if (s.f) return document.querySelector('#chips .chip[data-f="' + s.f + '"]') || document.querySelector('#chips .chip');
    var rows = allRows();
    return (s.id && rowOf(s.id)) || rows[Math.min(Math.max(s.at, 0), rows.length - 1)] || document.querySelector('#catalog h1');
  }
  function renderCatalog() {
    var had = spot(document.activeElement), from = spot(lastFocus);
    drawCatalog();
    if (from) lastFocus = found(from);
    if (had && found(had)) found(had).focus({ preventScroll: true });
  }
  function drawCatalog() {
    var all = C.live(DOC), q = $('q').value.trim(), t = C.totals(all);
    $('cat-tools').hidden = !all.length;
    // With no sets yet the empty state has the same two buttons, so the row at the bottom would only repeat them.
    document.querySelector('#catalog .fab-row').hidden = !all.length;
    var chips = $('chips');
    chips.innerHTML = FILTERS.filter(function (f) {
      return f[0] === 'all' || f[0] === show || (f[0] === 'missing' ? t.missing : f[0] === 'check' ? t.check : t[f[0]]);
    }).map(function (f) {
      var n = f[0] === 'all' ? t.sets : f[0] === 'missing' ? t.missing : f[0] === 'check' ? t.check : (t[f[0]] || 0);
      // Its name for a screen reader is "Built, 7 sets": the label and the count run together read as "Built7".
      return '<button class="chip" type="button" data-f="' + f[0] + '" aria-pressed="' + (show === f[0]) + '" aria-label="' + esc(f[1]) + ', ' + plural(n, 'set') + '">' + esc(f[1]) + '<span class="n">' + n + '</span></button>';
    }).join('');
    // The lit chip is always in view: the row scrolls sideways on a phone, and "To check" is at its far end.
    var lit = chips.querySelector('[aria-pressed="true"]');
    if (lit) {
      var cr = chips.getBoundingClientRect(), lr = lit.getBoundingClientRect();
      if (lr.right > cr.right - 16) chips.scrollLeft += lr.right - cr.right + 16;
      else if (lr.left < cr.left + 16) chips.scrollLeft += lr.left - cr.left - 16;
    }
    $('group').value = prefs.group;
    fillLists(all);

    if (!all.length) {
      $('list-wrap').innerHTML = '<div class="empty"><svg width="80" height="60" viewBox="0 0 88 72" aria-hidden="true"><rect x="14" y="30" width="60" height="34" rx="4" fill="var(--red)"/><rect x="21" y="22" width="14" height="9" rx="2" fill="var(--red)"/><rect x="53" y="22" width="14" height="9" rx="2" fill="var(--red)"/></svg>' +
        '<h2>No sets yet</h2><p>Send Claude photos of your boxes or built models and open the link it gives you. Or add a set by its number.</p>' +
        '<div class="acts"><button class="btn quiet" type="button" data-act="claude">How to add from photos</button><button class="btn" type="button" data-act="add">+ Add a set</button></div></div>';
      $('sum').textContent = '';
      return;
    }

    // Loose pieces aren't sets, but they're packed in moving boxes too (lots, kept for Build from your box). Their
    // boxes are boxes the search knows, and looking at a box shows them: a line under the box's group, or after a
    // search for the box. Not with a filter on (Built, Missing pieces…): that's a look for sets of that kind.
    var lots = C.liveLots(DOC).filter(function (l) { return l.box; });
    var labels = Object.keys(all.concat(lots).reduce(function (m, x) { if (x.box) m[x.box] = 1; return m; }, {}));
    var shown = all.filter(function (x) { return passes(x) && C.matches(x, q, labels); });
    var bs = C.boxSearch(q, labels), inBox = function (x) { return x.box && C.boxName(x.box).toLowerCase() === bs.label; };
    var hunt = bs && bs.label && !bs.rest.trim() && show === 'all' ? lots.filter(inBox) : [];
    var huntLine = hunt.length ? lotsLine(hunt, C.boxName((shown[0] || hunt[0]).box), shown.length > 0) : '';
    $('sum').textContent = (shown.length === all.length ? plural(all.length, 'set') : shown.length + ' of ' + all.length + ' sets') +
      (t.pieces ? ' · ' + C.totals(shown).pieces.toLocaleString() + ' pieces' : '');
    // The line at the top of a printed list (it shows only on paper): what's listed, the day, and how many.
    var onlyBox = bs && bs.label && !bs.rest.trim() && shown.length ? 'Box ' + C.boxName(shown[0].box) : '';
    $('print-head').textContent = ['Brickyard', onlyBox || 'My sets ' + ({ box: 'by moving box', theme: 'by theme', state: 'by state', 'new': 'newest first' }[prefs.group] || 'by room'),
      q && !onlyBox ? '“' + q + '”' : '', show === 'all' ? '' : (FILTERS.filter(function (f) { return f[0] === show; })[0] || [])[1],
      new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }), plural(shown.length, 'set')].filter(Boolean).join(' · ');
    if (!shown.length) {
      // Nothing under the filter that's on, when the same search finds sets with it off: say so, with the way to
      // them. ("Nothing matches" under To check, with two Millennium Falcons owned, read as not having one.)
      var under = show === 'all' ? 0 : all.filter(function (x) { return C.matches(x, q, labels); }).length;
      var name = (FILTERS.filter(function (f) { return f[0] === show; })[0] || [])[1];
      $('list-wrap').innerHTML = huntLine || '<div class="empty"><p>' + (!under ? 'Nothing matches. Try another word or filter.'
        : 'Nothing under ' + esc(name) + '. ' + (q ? plural(under, 'set') + (under === 1 ? ' matches' : ' match') + ' in all your sets.' : '') +
          '</p><div class="acts"><button class="btn quiet" type="button" data-act="all">' + (q ? (under === 1 ? 'Show it' : 'Show them') : 'Show all your sets') + '</button></div>') + '</div>';
      return;
    }

    if (prefs.group === 'new') shown.sort(function (a, b) { return (b.added || '').localeCompare(a.added || '') || b.t - a.t; });
    else shown.sort(function (a, b) {
      var ga = groupOf(a), gb = groupOf(b), la = /^(No |Not |State not)/.test(ga), lb = /^(No |Not |State not)/.test(gb);
      if (la !== lb) return la ? 1 : -1;
      if (prefs.group === 'state') { var sa = C.STATES.indexOf(a.state), sb = C.STATES.indexOf(b.state); if (sa !== sb) return sa - sb; }
      return C.natural(ga, gb) || C.natural(a.name || '', b.name || '');
    });

    // Groups are told apart the way they're sorted, so "Office" and "office" (or box "3" and "03") make one group,
    // headed by the first spelling.
    var groups = [];
    shown.forEach(function (x) {
      var g = groupOf(x), last = groups[groups.length - 1];
      if (!last || C.natural(g, last.name) !== 0) groups.push(last = { name: g, sets: [] });
      last.sets.push(x);
    });
    // Every set by moving box: each box's loose pieces go under its group, and a box holding only loose pieces
    // gets a group of its own, in its place among the others.
    if (prefs.group === 'box' && !q && show === 'all' && lots.length) {
      lots.forEach(function (l) {
        var name = 'Box ' + C.boxName(l.box), g = groups.filter(function (y) { return C.natural(y.name, name) === 0; })[0];
        if (!g) groups.push(g = { name: name, sets: [] });
        (g.lots = g.lots || []).push(l);
      });
      groups.sort(function (a, b) {
        var la = a.name === 'Not packed', lb = b.name === 'Not packed';
        return la !== lb ? (la ? 1 : -1) : C.natural(a.name, b.name);
      });
    }
    $('list-wrap').innerHTML = groups.map(function (g) {
      // A heading straight under the screen's, read out as "Office, 5 sets" (it was a bare "Office 5").
      return (g.name ? '<h2 class="group"' + (g.sets.length ? ' aria-label="' + esc(g.name) + ', ' + plural(g.sets.length, 'set') + '"' : '') + '><span>' + esc(g.name) + '</span><span>' + (g.sets.length || '') + '</span></h2>' : '') +
        (g.sets.length ? '<ul class="list">' + g.sets.map(setItem).join('') + '</ul>' : '') +
        (g.lots ? lotsLine(g.lots, g.name.replace(/^Box /, ''), g.sets.length > 0) : '');
    }).join('') + huntLine;
  }

  function setItem(x) {
    var sub = prefs.group === 'room' ? (x.box ? 'Box ' + C.boxName(x.box) : '') : prefs.group === 'box' ? [x.room, x.spot].filter(Boolean).join(' › ') : C.where(x);
    return '<li><button class="item" type="button" data-id="' + esc(x.id) + '">' + picHtml(x) +
      '<div class="main"><div class="t">' + esc(x.name || 'Set ' + C.shortNum(x.num)) + '</div><div class="m">' + esc(metaLine(x)) + '</div>' +
      (sub ? '<div class="m">' + esc(sub) + '</div>' : '') +
      (x.missing || x.check ? '<div class="m warn">' + [x.missing ? 'Missing pieces' : '', x.check ? 'To check' : ''].filter(Boolean).join(' · ') + '</div>' : '') + '</div>' +
      (x.state ? '<span class="badge ' + x.state + '">' + esc(C.STATE_NAMES[x.state]) + '</span>' : '<span></span>') + '</button></li>';
  }

  // The loose pieces packed in a box, as one muted line that goes to Build from your box, where they live.
  // "Also" when the box has sets in it too.
  function lotsLine(lots, label, also) {
    return '<p class="note lots"><a href="#build">' + (also ? 'Also in box ' : 'In box ') + esc(label) + ': ' +
      lots.map(function (l) { return esc(l.name) + ', ' + plural(C.lotTotals(l).pieces, 'loose piece'); }).join('; ') + '</a></p>';
  }

  function fillLists(all) {
    [['dl-room', 'room'], ['dl-spot', 'spot'], ['dl-box', 'box'], ['dl-theme', 'theme']].forEach(function (p) {
      var seen = {};
      all.forEach(function (x) { if (x[p[1]]) seen[x[p[1]]] = 1; });
      $(p[0]).innerHTML = Object.keys(seen).sort(C.natural).map(function (v) { return '<option value="' + esc(v) + '">'; }).join('');
    });
  }

  $('q').addEventListener('input', renderCatalog);
  // Going into the search while it holds the last thing looked for selects it, so typing replaces it: packing one
  // set after another, each search started with clearing the one before.
  $('q').addEventListener('focus', function () { if (this.value) this.select(); });
  $('group').addEventListener('change', function () { prefs.group = this.value; savePrefs(); renderCatalog(); });
  $('chips').addEventListener('click', function (e) {
    var b = e.target.closest('.chip'); if (!b) return;
    show = b.dataset.f; renderCatalog();
  });
  $('list-wrap').addEventListener('click', function (e) {
    var b = e.target.closest('[data-id]'); if (b) return editSheet(DOC.sets[b.dataset.id]);
    var a = e.target.closest('[data-act]'); if (!a) return;
    if (a.dataset.act === 'add') editSheet(null);
    else if (a.dataset.act === 'all') { show = 'all'; renderCatalog(); }
    else claudeSheet();
  });
  $('add-btn').addEventListener('click', function () { editSheet(null); });
  $('claude-btn').addEventListener('click', claudeSheet);
  $('menu-btn').addEventListener('click', menuSheet);

  // ---------- sheets ----------
  var openScrim = null, lastFocus = null;
  // While a sheet is open the screens behind it (and the footer) are inert, so Tab and screen readers stay in the
  // sheet. The toast is outside them, so it's still read out.
  function behind(on) { document.querySelectorAll('body > section, body > .jd-foot').forEach(function (el) { el.inert = on; }); }

  // A sheet has a place of its own in the browser's history (the same address, marked as a sheet), so Back closes
  // the sheet and stays on the screen instead of leaving it. One sheet opened over another takes over its place.
  // When a sheet closes itself (Close, Save, a tap outside) it goes back over that place, which the browser does a
  // moment later: `going` is true until it has, and what has to wait for it (moving to another screen, which would
  // otherwise be the thing gone back over) is given to closeSheet and kept in `after`. The preview copy leaves
  // history alone: it's shared with the page around it.
  var going = false, goTimer = 0, after = [];
  function onEntry() { return !FRAMED && !!(history.state && history.state.sheet); }
  function pushEntry() {
    if (FRAMED) return false;
    try { history.pushState({ sheet: 1 }, ''); return true; } catch (e) { return false; } // the sheet still works, without Back
  }
  function landed() {
    clearTimeout(goTimer); going = false;
    var run = after; after = [];
    run.forEach(function (f) { f(); });
    // A sheet opened while Back was on its way had its place taken from under it.
    if (openScrim && !onEntry()) openScrim._placed = pushEntry();
    // Going back over a sheet's place can take the focus off the page altogether (it does for the first sheet closed
    // after Brickyard is opened on a screen), a moment after the closing sheet gave it back. Give it back again.
    setTimeout(function () {
      if (!openScrim && document.activeElement === document.body && lastFocus && lastFocus.focus && document.contains(lastFocus)) lastFocus.focus({ preventScroll: true });
    }, 0);
  }
  function goBack() {
    // If the browser never says it went back, carry on anyway rather than keep everything waiting.
    going = true; goTimer = setTimeout(landed, 3000); history.back();
  }
  // On a sheet's place with no sheet open (after a reload, or Forward once Back has closed it): step off it, so
  // the next Back isn't a press that does nothing.
  function offEntry() { if (!openScrim && !going && onEntry()) goBack(); }
  window.addEventListener('popstate', function () {
    if (going) { landed(); return; }
    var s = openScrim;
    if (!s) { offEntry(); return; }
    // Back with a sheet open: its place is gone, and the address is still its screen's. (Anywhere else, route()
    // closes it.) With changes in it, Back asks first, like Close, and the sheet stays without a place: the next
    // Back in a row leaves the screen and the changes. It can't take its place back here. Chrome's Back skips
    // every place a page adds without a tap since the last Back, which would leave Brickyard altogether; the next
    // tap or keystroke in the sheet takes it back instead (openSheet).
    if (!s._placed || onEntry() || s._at !== location.hash) return;
    if (!changed(s) || sure(s)) dropSheet();
  });

  // dirty, when given, says whether the sheet holds changes that closing would throw away. While it does, a tap on
  // the page outside does nothing, and Close, Escape or Back ask first (askClose).
  function openSheet(html, dirty) {
    dropSheet();
    if (!toastStays) hideToast(); // "Added 7 sets" would sit on top of the next sheet
    lastFocus = document.activeElement;
    var scrim = document.createElement('div');
    scrim.className = 'scrim';
    scrim.innerHTML = '<div class="sheet" role="dialog" aria-modal="true" aria-labelledby="sheetTitle">' + html + '</div>';
    var x = scrim.querySelector('[data-close]');
    // Going back to the changes after "Discard changes?" puts Close back, so a later slip is a first tap again.
    var calm = function () { if (x && x.dataset.sure) { delete x.dataset.sure; x.textContent = x.dataset.label; } };
    // And a sheet that lost its place to a Back that asked gets one again, so the next Back asks again.
    var back = function (e) {
      calm();
      if (e.isTrusted && openScrim === scrim && scrim._placed && !going && !onEntry() && scrim._at === location.hash) pushEntry();
    };
    scrim.addEventListener('click', function (e) {
      if (e.target === scrim) askClose(true);
      else if (x && x.contains(e.target)) askClose();
      else back(e);
    });
    scrim.addEventListener('input', back);
    scrim._dirty = typeof dirty === 'function' ? dirty : null;
    scrim._at = location.hash; // the screen it belongs to (route)
    scrim._placed = onEntry() || pushEntry();
    document.body.appendChild(scrim);
    document.body.style.overflow = 'hidden';
    behind(true);
    openScrim = scrim;
    var f = scrim.querySelector('[autofocus]') || scrim.firstChild;
    if (f === scrim.firstChild) f.tabIndex = -1;
    f.focus({ preventScroll: true });
    return scrim.firstChild;
  }
  function changed(s) { return !!(s._dirty && s._dirty()); }
  // Turns the sheet's Close button into "Discard changes?". True when this is the tap after that one.
  function sure(s) {
    var b = s.querySelector('[data-close]');
    if (!b || secondTap(b)) return true;
    if (!b.dataset.label) b.dataset.label = b.textContent;
    b.textContent = 'Discard changes?'; b.focus({ preventScroll: true });
    return false;
  }
  // The person asking to close: the sheet's Close button, Escape, or a tap on the page outside (outside is true).
  // closeSheet is the sheet closing itself once it's done. With changes in it, a tap outside does nothing, and the
  // others turn Close into "Discard changes?" and close on the next one, so nothing typed goes on one slip.
  function askClose(outside) {
    var s = openScrim;
    if (s && (!changed(s) || (!outside && sure(s)))) closeSheet();
  }
  // Takes the sheet off the screen, leaving history as it is.
  function dropSheet() {
    if (!openScrim) return;
    var s = openScrim; openScrim = null;
    s.remove(); document.body.style.overflow = ''; behind(false);
    if (lastFocus && lastFocus.focus && document.contains(lastFocus)) lastFocus.focus();
  }
  // Closes the sheet and goes back over its place in history. `then` runs once that's done (at once when there was
  // nothing to go back over): anything that moves to another screen has to wait for it.
  function closeSheet(then) {
    if (openScrim) {
      dropSheet();
      if (onEntry() && !going) goBack();
    }
    if (typeof then !== 'function') return;
    if (going) after.push(then); else then();
  }
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && openScrim) askClose(); });
  // What's in a sheet's fields (and anything else that counts), as one text, to tell whether it has changed since
  // the sheet opened.
  function fieldsOf(ids, more) {
    return JSON.stringify(ids.map(function (id) { var el = $(id); return !el ? null : el.type === 'checkbox' ? el.checked : el.value.trim(); }).concat(more || []));
  }

  // In a list of rows to tick (sets from Claude, sizes), a tap anywhere on a row ticks or unticks it, not only on
  // its little box. The box's own taps tick it already.
  function tickRow(e) {
    var li = e.target.closest('li'), box = li && li.querySelector('input[type="checkbox"]');
    if (!box || e.target === box) return;
    box.checked = !box.checked;
    box.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function field(label, inner) { return '<label class="field"><span>' + label + '</span>' + inner + '</label>'; }
  function input(id, val, extra) { return '<input id="' + id + '" value="' + esc(val == null ? '' : val) + '" autocomplete="off"' + (extra || '') + '>'; }

  function editSheet(x) {
    var isNew = !x;
    x = x ? JSON.parse(JSON.stringify(x)) : { id: newId(), state: 'built' };
    var z = x.size || {};
    // Everything the sheet lets you change, to tell whether closing it would lose something.
    var st = x.state, was = null, numWas = isNew ? '' : x.num || '';
    // Enter in one of the sheet's one-line boxes saves (the boxes are in a form, so the browser still lets Enter
    // choose a suggestion from a box's list first); on a phone the keyboard's key says Done.
    var box = function (id, val, extra) { return input(id, val, ' enterkeyhint="done"' + (extra || '')); };
    var now = function () { return fieldsOf(['e-num', 'e-year', 'e-name', 'e-pieces', 'e-theme', 'e-room', 'e-spot', 'e-box', 'e-missing', 'e-instr', 'e-w', 'e-d', 'e-h', 'e-tags', 'e-notes'], [st || '']); };
    var panel = openSheet(
      '<div class="hd"><h2 id="sheetTitle">' + (isNew ? 'Add a set' : esc(x.name || 'Set ' + C.shortNum(x.num))) + '</h2><button class="btn sm quiet" type="button" data-close>Close</button></div>' +
      '<form class="bd" id="e-form" novalidate>' +
      (isNew ? '' : picHtml(x, 'head-pic')) +
      (x.check ? '<p class="flag"><span><b>Check:</b> ' + esc(x.check) + '</span><button class="btn sm quiet" type="button" id="e-ok">It’s right</button></p>' : '') +
      '<div class="two">' + field('Set number', box('e-num', C.shortNum(x.num), ' inputmode="text" placeholder="e.g. 10698"' + (isNew ? ' autofocus' : ''))) + field('Year', box('e-year', x.year || '', ' inputmode="numeric"')) + '</div>' +
      field('Name', box('e-name', x.name, ' placeholder="e.g. Large Creative Brick Box"')) +
      '<div class="two">' + field('Pieces', box('e-pieces', x.pieces || '', ' inputmode="numeric"')) + field('Theme', box('e-theme', x.theme, ' list="dl-theme" placeholder="e.g. Classic"')) + '</div>' +
      '<div class="field" role="group" aria-labelledby="e-state-l"><span class="lbl" id="e-state-l">State</span><div class="seg" id="e-state">' + C.STATES.map(function (k) {
        return '<button type="button" data-v="' + k + '" aria-pressed="' + (x.state === k) + '">' + C.STATE_NAMES[k].replace('Taken apart', 'Apart') + '</button>';
      }).join('') + '</div></div>' +
      '<div class="two">' + field('Room', box('e-room', x.room, ' list="dl-room" placeholder="e.g. Office"')) + field('Shelf or spot', box('e-spot', x.spot, ' list="dl-spot" placeholder="e.g. Top shelf"')) + '</div>' +
      field('Moving box', box('e-box', x.box, ' list="dl-box" placeholder="Leave blank if it’s not packed"')) +
      field('Missing pieces', '<textarea id="e-missing" placeholder="e.g. one red 2×4 brick, the minifigure’s hat">' + esc(x.missing) + '</textarea>') +
      '<label class="check"><input type="checkbox" id="e-instr"' + (x.instr ? ' checked' : '') + '> I have the paper instructions</label>' +
      // Each box has its own label: a placeholder is gone once the box holds a number, leaving a bare "50 8 16".
      '<div class="field" role="group" aria-labelledby="e-size"><span class="lbl" id="e-size">Size when built (for the shelf planner)</span><div class="three">' +
      field('Width, cm', box('e-w', z.w || '', ' inputmode="decimal"')) + field('Depth, cm', box('e-d', z.d || '', ' inputmode="decimal"')) + field('Height, cm', box('e-h', z.h || '', ' inputmode="decimal"')) + '</div></div>' +
      field('Tags', box('e-tags', (x.tags || []).join(', '), ' placeholder="Comma between tags"')) +
      field('Notes', '<textarea id="e-notes">' + esc(x.notes) + '</textarea>') +
      '</form>' +
      '<div class="ft">' + (isNew ? '<span></span>' : '<button class="btn danger" type="button" id="e-del">Remove</button>') + '<button class="btn" type="submit" form="e-form" id="e-save">' + (isNew ? 'Add set' : 'Save') + '</button></div>',
      function () { return now() !== was; });
    was = now();
    if (panel.querySelector('.head-pic')) panel.querySelector('.head-pic').dataset.num = numWas;

    $('e-state').onclick = function (e) {
      var b = e.target.closest('button'); if (!b) return;
      st = st === b.dataset.v ? '' : b.dataset.v;
      this.querySelectorAll('button').forEach(function (y) { y.setAttribute('aria-pressed', y.dataset.v === st); });
    };
    // Saved at once, on the set as it's kept, so Close afterwards doesn't bring the check back. Whatever else has
    // been typed in the sheet still waits for Save.
    if ($('e-ok')) $('e-ok').onclick = function () {
      delete x.check; this.parentNode.remove(); panel.focus({ preventScroll: true });
      var kept = DOC.sets[x.id];
      if (kept && !kept.del && kept.check) { kept = JSON.parse(JSON.stringify(kept)); delete kept.check; putSet(kept); save(); renderCatalog(); }
      toast('Marked as right');
    };
    if ($('e-del')) $('e-del').onclick = function () {
      if (!secondTap(this)) { this.textContent = 'Tap again to remove'; return; }
      var kept = DOC.sets[x.id] && !DOC.sets[x.id].del ? DOC.sets[x.id] : x, name = kept.name || 'Set ' + C.shortNum(kept.num);
      removeSet(x.id); save(); closeSheet(); renderCatalog();
      toast('Removed ' + name, false, { label: 'Undo', run: function () { putBack('sets', kept); save(); refresh(); toast(name + ' is back'); } });
    };
    // The picture at the top follows the number: one put right showed the old set until Save.
    $('e-num').addEventListener('change', function () {
      var pic = panel.querySelector('.head-pic'), num = C.setNum(this.value.trim()), d = document.createElement('div');
      if (!pic || pic.dataset.num === num) return;
      d.innerHTML = picHtml({ num: num }, 'head-pic'); d.firstChild.dataset.num = num;
      pic.parentNode.replaceChild(d.firstChild, pic);
    });
    // A different number is a different question: the button that was asking about a set you already have goes
    // back to its own words.
    $('e-num').addEventListener('input', function () {
      var b = $('e-save');
      this.removeAttribute('aria-invalid');
      if (b.dataset.again) { delete b.dataset.again; b.textContent = isNew ? 'Add set' : 'Save'; }
    });
    // Space ticks a tick-box; Enter on one would save the sheet, like Enter in a box.
    $('e-form').onkeydown = function (e) { if (e.key === 'Enter' && e.target.type === 'checkbox') e.preventDefault(); };
    $('e-form').onsubmit = function (e) {
      e.preventDefault();
      var btn = $('e-save');
      var raw = $('e-num').value.trim(), num = C.setNum(raw);
      if (raw && !num) { toast('That set number doesn’t look right. It’s usually 4 or 5 digits.'); $('e-num').setAttribute('aria-invalid', 'true'); $('e-num').focus(); return; }
      var y = C.cleanSet({
        num: num, name: $('e-name').value, year: $('e-year').value, pieces: $('e-pieces').value, theme: $('e-theme').value, state: st,
        room: $('e-room').value, spot: $('e-spot').value, box: $('e-box').value, missing: $('e-missing').value,
        instr: $('e-instr').checked ? true : (x.instr === false ? false : null), tags: $('e-tags').value, notes: $('e-notes').value,
        size: { w: $('e-w').value, d: $('e-d').value, h: $('e-h').value }, check: x.check, added: x.added || today(),
      });
      if (!y) { toast('Give it a set number or a name.'); $('e-num').focus(); return; }
      // A set you already have takes a second tap: a new set, or one whose number was changed to another set's
      // (which used to save without a word).
      var dup = isNew ? C.findDup(DOC, y) : y.num && y.num !== numWas ? C.live(DOC).filter(function (o) { return o.id !== x.id && o.num === y.num; })[0] : null;
      if (dup && !secondTap(btn, 'again')) {
        btn.textContent = isNew ? 'Add another copy' : 'Save anyway';
        toast('You already have ' + (dup.name || 'this set') + (C.where(dup) ? ' (' + C.where(dup) + ')' : '') + (isNew ? '. Tap again to add a second copy.' : '. Tap again to keep both.'));
        return;
      }
      y.id = x.id; putSet(y); save(); closeSheet(); renderCatalog();
      toast(isNew ? 'Added' : 'Saved');
    };
  }

  // One set, shown in My sets from another screen (the shelf planner's See in My sets): its row in view and its
  // sheet open. A filter or a search left on from before that would hide it is taken off; one that shows it stays.
  // The move waits for an open sheet to close (closeSheet), and the row and the sheet wait for My sets to be drawn:
  // route() draws it from the top and closes any sheet from the screen before.
  function rowOf(id) {
    var rows = document.querySelectorAll('#list-wrap .item[data-id]');
    for (var i = 0; i < rows.length; i++) if (rows[i].dataset.id === id) return rows[i];
    return null;
  }
  function showSet(id) {
    var x = DOC.sets[id];
    if (!x || x.del) return;
    closeSheet(function () {
      var open = function () {
        if (!rowOf(id) && !passes(x)) { show = 'all'; renderCatalog(); }
        if (!rowOf(id)) { $('q').value = ''; renderCatalog(); }
        var row = rowOf(id);
        // The row takes the focus, so it comes back to it when the sheet closes.
        if (row) { row.scrollIntoView({ block: 'center' }); row.focus({ preventScroll: true }); }
        editSheet(DOC.sets[id]);
      };
      if (location.hash === '#catalog') { open(); return; }
      document.addEventListener('brickyard:route', function once() {
        document.removeEventListener('brickyard:route', once);
        if (location.hash === '#catalog' && DOC.sets[id] && !DOC.sets[id].del) open();
      });
      location.hash = '#catalog';
    });
  }

  // ---------- adding from Claude ----------
  function claudeSheet() {
    openSheet('<div class="hd"><h2 id="sheetTitle">Add from photos</h2><button class="btn sm quiet" type="button" data-close>Close</button></div><div class="bd">' +
      '<div class="how"><b>With Claude</b><ol><li>Take photos of your set boxes, the instruction books, or the built models. The set number on a box is the best thing to get in the picture.</li>' +
      '<li>Send them to Claude and say where they are (a room and shelf, or a moving box number).</li><li>Claude sends back a Brickyard link. Open it, check the list, and tap <b>Add</b>.</li></ol></div>' +
      '<p class="note">Claude gives you a file too, in case the link is too long. Open it, or paste the link or file text here:</p>' +
      '<textarea class="paste" id="paste" placeholder="Paste a Brickyard link or file" aria-label="Paste a Brickyard link or file"></textarea>' +
      '</div><div class="ft"><button class="btn quiet" type="button" id="p-file">Open a file</button><button class="btn" type="button" id="p-go">Open</button></div>');
    $('p-file').onclick = function () { $('file').click(); };
    $('p-go').onclick = function () { takePasted($('paste'), 'That doesn’t look like sets from Claude or a Brickyard file'); };
  }
  // What's in a sheet's paste box, read as whatever it is. Open a model (js/build.js) and Sizes from Claude
  // (js/shelves.js) use it too, so every paste box takes every kind of Brickyard link or file.
  function takePasted(box, plain) {
    var t = box.value; if (!t.trim()) { box.focus(); return; }
    takeIncoming(C.parseIncoming(t), /^\s*[{[]/.test(t) ? 'file' : 'link', plain); // a file's text starts with a bracket
  }

  // Something that couldn't be read. A Brickyard link that doesn't unpack, or one of a later format, says so and
  // what to do (C.parseIncoming marks which); anything else gets `plain`, the words for where it was tried. A cut
  // link can't say who made it (Claude, Stud Finder, or Copy everything as a link here), so the words don't either.
  function unread(e, plain) {
    if (e && e.why === 'cut') toast('That Brickyard link is cut short or has a wrong character. Copy the whole link again, or open the file that came with it.', 'long');
    else if (e && e.why === 'newer') toast('That link needs a newer Brickyard. Reload the page, then open it again.', 'long');
    else toast(e && /browser/.test(e.message) ? e.message : plain);
  }

  // Whatever arrives (an opened link, a pasted link or file text, a file) goes to the review for its kind, on the
  // screen that kind belongs to, wherever it was opened from: sets pasted into Open a model are reviewed, and
  // added, in My sets. from is where it came from, 'link' or 'file', for the words on the sheet; plain is what
  // to say when it isn't anything of Brickyard's.
  function takeIncoming(p, from, plain) {
    return p.then(function (r) {
      if (r.kind === 'sizes') takeSizes(r.doc);
      else if (r.kind === 'model') takeModel(r.doc);
      else if (r.kind === 'loose') onScreen('#build', function () { looseSheet(r.lot); });
      else if (r.kind === 'catalog') onScreen('#catalog', function () { catalogSheet(r.doc, from); });
      else onScreen('#catalog', function () { reviewSheet(r.batch); });
    }).catch(function (e) { unread(e, plain || 'That doesn’t look like sets from Claude or a Brickyard file'); });
  }
  // Opens a sheet on the screen it belongs to. Already there, it takes the place of any sheet that's open. From
  // another screen, the open sheet closes first: moving on has to wait for its place in history to be gone.
  function onScreen(to, open) {
    if (location.hash === to) { open(); return; }
    closeSheet(function () { location.hash = to; open(); });
  }
  // Sizes go to the shelf planner's Add sizes (js/shelves.js), and a model into Build from your box (js/build.js),
  // opened.
  function takeSizes(doc) {
    var z = window.ShelfCore.cleanSizes(doc);
    if (!z || !window.BrickyardShelves) throw new Error('empty');
    closeSheet(function () { location.hash = '#shelves'; window.BrickyardShelves.reviewSizes(z); });
  }
  function takeModel(doc) {
    var m = window.BuildCore && window.BuildCore.cleanModel(doc);
    if (!m || !window.BrickyardBuild) throw new Error('empty');
    var id = window.BrickyardBuild.saveModel(m);
    closeSheet(function () { location.hash = '#model-' + id; });
  }
  function checkLink() {
    var h = location.hash;
    // A link of a format this copy of the page doesn't know (an old copy kept for offline, say) used to land on
    // the home screen without a word.
    if (/^#[a-z][2-9][zj]/.test(h) && C.newerLink(h)) {
      try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { location.hash = ''; }
      route(); unread({ why: 'newer' });
      return true;
    }
    if (!/^#([bl]1[zj]|batch=)/.test(h)) return false;
    var to = h.charAt(1) === 'l' ? '#build' : '#catalog'; // loose pieces belong to Build from your box
    try { history.replaceState(null, '', location.pathname + location.search + to); } catch (e) { location.hash = to; }
    route();
    takeIncoming(C.parseIncoming(h), 'link');
    return true;
  }
  $('file').addEventListener('change', function () {
    var f = this.files && this.files[0]; this.value = '';
    if (!f) return;
    f.text().then(function (t) { takeIncoming(C.parseIncoming(t), 'file'); });
  });

  function reviewSheet(batch) {
    // A set that's in the list a second time is marked, and stays ticked: there may really be two, and only the
    // person looking at the shelf knows.
    var again = C.repeats(batch.sets);
    // Which rows of this link were added from it before, on this device, and as which sets (tookFrom). A set
    // already owned is found by its number or name, which misses one whose number was put right after it was
    // added, or one removed since: opened again, the link had those ticked, one tap from coming back.
    var before = tookFrom(batch.id);
    var rows = batch.sets.map(function (x, i) {
      var dup = C.findDup(DOC, x), was = before[i] ? DOC.sets[before[i]] || { del: 1 } : null;
      return { x: x, dup: dup, was: dup ? null : was, again: again[i], on: !dup && !was };
    });
    var seenAt = DOC.seen[batch.id];
    var nd = rows.filter(function (r) { return r.dup; }).length, nc = rows.filter(function (r) { return r.x.check; }).length, na = rows.filter(function (r) { return r.again; }).length;
    var nb = rows.filter(function (r) { return r.was; }).length;
    openSheet('<div class="hd"><h2 id="sheetTitle">Add sets from Claude</h2><button class="btn sm quiet" type="button" data-close>Not now</button></div><div class="bd">' +
      '<p class="lede">' + (batch.name ? '<b>' + esc(batch.name) + '</b> · ' : '') + plural(rows.length, 'set') + (nd ? ' · ' + nd + ' you already have' : '') + (nb ? ' · ' + nb + ' added before' : '') + (nc ? ' · ' + nc + ' to check' : '') + (na ? ' · ' + na + ' twice in this list' : '') + '</p>' +
      (seenAt || nb ? '<p class="flag"><span>You opened this link before. ' + (nb ? 'The sets you added from it then are unticked, and so are any others you already have.' : 'Sets you already have are unticked.') + '</span></p>' : '') +
      '<div class="bulk" role="group" aria-labelledby="rv-all"><span class="lbl" id="rv-all">Put them all in</span><div class="two">' + field('Room', input('rv-room', batch.room, ' list="dl-room"')) + field('Shelf or spot', input('rv-spot', batch.spot, ' list="dl-spot"')) + '</div>' +
      field('Moving box', input('rv-box', batch.box, ' list="dl-box"')) +
      '<span class="note" style="margin:0">Leave Room and Shelf blank to keep what Claude put for each set. Clear Moving box if they’re unpacked.</span></div>' +
      '<ul class="rv" id="rv">' + rows.map(function (r, i) {
        var x = r.x, meta = [metaLine(x), C.STATE_NAMES[x.state], C.where(x)].filter(Boolean).join(' · ');
        return '<li data-i="' + i + '"' + (r.on ? '' : ' class="off"') + '><input type="checkbox" aria-label="Add ' + esc(x.name || 'this set') + '"' + (r.on ? ' checked' : '') + '>' + picHtml(x) +
          '<div><div class="t">' + esc(x.name || 'Set ' + C.shortNum(x.num)) + '</div><div class="m">' + esc(meta) + '</div>' +
          (r.dup ? '<div class="w">You already have this one' + (C.where(r.dup) ? ' (' + esc(C.where(r.dup)) + ')' : '') + '</div>' : '') +
          (r.was ? '<div class="w">Added from this link before' + (r.was.del ? ', and removed since' : ', now ' + esc(nowCalled(x, r.was))) + '</div>' : '') +
          (r.again ? '<div class="w">Also above in this list.' + (r.on ? ' Untick it unless you have two.' : '') + '</div>' : '') +
          (x.check ? '<div class="w">Check: ' + esc(x.check) + '</div>' : '') + '</div></li>';
      }).join('') + '</ul></div>' +
      '<div class="ft"><span class="note" id="rv-n" style="margin:0"></span><button class="btn" type="button" id="rv-add">Add</button></div>',
      function () { return now() !== was; });
    // The ticks and where they all go: changing either is something to lose.
    function now() { return fieldsOf(['rv-room', 'rv-spot', 'rv-box'], rows.map(function (r) { return r.on; })); }
    var was = now();
    function count() {
      var n = rows.filter(function (r) { return r.on; }).length;
      $('rv-n').textContent = n + ' of ' + rows.length + ' ticked';
      $('rv-add').textContent = n ? 'Add ' + plural(n, 'set') : 'Add';
      $('rv-add').disabled = !n;
    }
    $('rv').onchange = function (e) {
      var li = e.target.closest('li'); if (!li) return;
      rows[+li.dataset.i].on = e.target.checked; li.classList.toggle('off', !e.target.checked); count();
    };
    $('rv').onclick = tickRow;
    $('rv-add').onclick = function () {
      var room = $('rv-room').value.trim(), spot = $('rv-spot').value.trim(), box = $('rv-box').value.trim(), n = 0, day = today();
      var took = Object.assign({}, before), ids = [], seenWas = DOC.seen[batch.id];
      rows.forEach(function (r, i) {
        if (!r.on) return;
        var y = Object.assign({}, r.x);
        if (room && room !== batch.room) { y.room = room; y.spot = spot; }
        else if (spot && spot !== batch.spot) y.spot = spot;
        // A box typed here goes on every set. Cleared, the batch's box comes off the sets that have it (they're
        // unpacked), and a set Claude put in a box of its own keeps that one.
        if (box && box !== batch.box) y.box = box;
        else if (!box && batch.box && C.natural(C.boxName(y.box), C.boxName(batch.box)) === 0) delete y.box;
        y = C.cleanSet(Object.assign(y, { added: day }));
        if (!y) return;
        y.id = newId(); putSet(y); n++; took[i] = y.id; ids.push(y.id);
      });
      DOC.seen[batch.id] = Date.now();
      tookFrom(batch.id, took);
      save(); closeSheet(); renderCatalog();
      // Undo takes out the sets this tap added (a batch with the wrong box typed for all of them was fourteen sets
      // to put right or remove by hand), and forgets that the link was opened, so it's offered whole again.
      toast('Added ' + plural(n, 'set'), false, { label: 'Undo', run: function () {
        ids.forEach(function (id) { if (DOC.sets[id] && !DOC.sets[id].del) removeSet(id); });
        if (seenWas === undefined) delete DOC.seen[batch.id]; else DOC.seen[batch.id] = seenWas;
        tookFrom(batch.id, before);
        save(); refresh();
        toast(n === 1 ? 'Took that set out again' : 'Took those ' + n.toLocaleString() + ' sets out again');
      } });
    };
    count();
  }

  // What this device has added from each link of sets: { batch id: { row in the link: the set's id here } }, kept
  // beside the catalog and not in it (it isn't synced, and a backup doesn't hold it). On a device without it a
  // link opened again is told by the sets' numbers and names alone, as before. With `rows` it saves them; with
  // null it forgets the link.
  function tookFrom(batchId, rows) {
    var all = read(TOOK);
    if (!all || typeof all !== 'object' || Array.isArray(all)) all = {};
    if (rows === undefined) { var got = all[batchId]; return got && typeof got === 'object' ? got : {}; }
    if (rows && Object.keys(rows).length) all[batchId] = rows; else delete all[batchId];
    write(TOOK, all);
  }
  // What a set added before is now, when it no longer matches its row in the link: its name if that changed, and
  // its number.
  function nowCalled(x, y) {
    var num = C.shortNum(y.num), name = y.name || '';
    if (name && name !== (x.name || '')) return name + (num ? ' ' + num : '');
    return num ? 'set ' + num : name || 'changed';
  }

  // A lot of loose pieces, from a scanner or from Claude. Opening the same lot again replaces it, so nothing is
  // ever counted twice.
  function shapeIds() {
    if (window.BRICKYARD_DATA) return Promise.resolve(window.BRICKYARD_DATA['parts/shapes.json'] || {});
    return fetch('parts/shapes.json').then(function (r) { return r.ok ? r.json() : {}; }).catch(function () { return {}; });
  }
  function looseSheet(lot) {
    var had = DOC.loose[lot.id] && !DOC.loose[lot.id].del ? DOC.loose[lot.id] : null, n = C.lotTotals(lot);
    openSheet('<div class="hd"><h2 id="sheetTitle">Add loose pieces</h2><button class="btn sm quiet" type="button" data-close>Not now</button></div><div class="bd">' +
      '<p class="lede"><b>' + esc(lot.name) + '</b> · ' + plural(n.pieces, 'piece') + ' of ' + plural(n.kinds, 'kind') + '</p>' +
      (had ? '<p class="flag"><span>You already have this lot (' + plural(C.lotTotals(had).pieces, 'piece') + '). Adding it again replaces it, so nothing is counted twice.</span></p>' : '') +
      '<p class="note" id="ls-use"></p>' +
      '<div class="bulk">' + field('Call it', input('ls-name', lot.name, ' maxlength="80"')) +
      field('Moving box', input('ls-box', lot.box || (had && had.box) || '', ' list="dl-box" maxlength="40" placeholder="Leave blank if it’s not packed"')) + '</div>' +
      '<p class="note">Loose pieces join <b>Your pieces</b> in Build from your box, next to your taken-apart sets. You can untick or remove a lot there.</p></div>' +
      '<div class="ft"><span></span><button class="btn" type="button" id="ls-add">' + (had ? 'Replace it' : 'Add ' + plural(n.pieces, 'piece')) + '</button></div>');
    shapeIds().then(function (shapes) {
      var use = lot.parts.reduce(function (k, r) { return k + (shapes[r[0]] ? r[2] : 0); }, 0);
      if ($('ls-use')) $('ls-use').textContent = use === n.pieces ? 'The builder can use all of them.'
        : 'The builder can use ' + use.toLocaleString() + ' of them today. The rest are kept, and count once Brickyard learns their shapes.';
    });
    $('ls-add').onclick = function () {
      var y = C.cleanLot(Object.assign({}, lot, { name: $('ls-name').value, box: $('ls-box').value }), lot.id, Date.now());
      if (!y) return;
      DOC.loose[y.id] = y; save();
      closeSheet(function () {
        toast((had ? 'Replaced ' : 'Added ') + plural(n.pieces, 'loose piece'));
        if (location.hash === '#build') route(); else location.hash = '#build';
      });
    };
  }

  // A whole catalog, from a backup file or from Copy everything as a link on another device. Merging keeps the
  // later change to each set, and removing a set is a change: one removed here after the file was saved would stay
  // removed. Those are counted, and a box offers to bring them back (timed now, so they win the merge everywhere).
  function catalogSheet(doc, from) {
    var link = from === 'link', incoming = C.live(doc).length, merged = C.mergeDocs(DOC, doc);
    var gone = C.live(doc).filter(function (x) { return DOC.sets[x.id] && DOC.sets[x.id].del && merged.sets[x.id].del; });
    var names = gone.slice(0, 3).map(function (x) { return x.name || 'Set ' + C.shortNum(x.num); }).join(', ') + (gone.length > 3 ? ' and ' + (gone.length - 3) + ' more' : '');
    openSheet('<div class="hd"><h2 id="sheetTitle">' + (link ? 'Your catalog from a link' : 'Open a Brickyard file') + '</h2><button class="btn sm quiet" type="button" data-close>Cancel</button></div><div class="bd">' +
      '<p class="lede">This ' + (link ? 'link' : 'file') + ' has ' + plural(incoming, 'set') + (C.liveLots(doc).length ? ' and ' + plural(C.liveLots(doc).length, 'lot') + ' of loose pieces' : '') +
      '. Bringing it in merges it with what’s here, set by set: whichever was changed last is kept, and removing a set counts as a change. Sets that are only here stay.</p>' +
      (gone.length ? '<label class="check"><input type="checkbox" id="cs-back"><span>Bring back the ' + (gone.length === 1 ? 'set' : gone.length.toLocaleString() + ' sets') + ' removed here since this ' + (link ? 'link was copied' : 'file was saved') +
        '<span class="note" style="display:block;margin:2px 0 0">' + esc(names) + '</span></span></label>' : '') + '</div>' +
      '<div class="ft"><span></span><button class="btn" type="button" id="cs-go">Merge it in</button></div>');
    $('cs-go').onclick = function () {
      var back = $('cs-back') && $('cs-back').checked ? gone : [];
      DOC = C.mergeDocs(DOC, doc);
      back.forEach(function (x) { putBack('sets', JSON.parse(JSON.stringify(x))); });
      save(); closeSheet(); renderCatalog();
      toast('Merged. ' + (back.length ? plural(back.length, 'set') + ' brought back. ' : '') + 'You have ' + plural(C.live(DOC).length, 'set') + '.');
    };
  }

  // ---------- menu ----------
  function menuSheet() {
    openSheet('<div class="hd"><h2 id="sheetTitle">Brickyard</h2><button class="btn sm quiet" type="button" data-close>Close</button></div><div class="bd"><ul class="menu">' +
      '<li><button type="button" id="m-claude"><span>Add from photos<small>Send Claude pictures of your sets and open its link</small></span></button></li>' +
      (FRAMED ? '' : '<li><button type="button" id="m-backup"><span>Download a backup<small>Your whole catalog as one file. Open it on another device to merge.</small></span></button></li>') +
      (window.BrickyardSync && window.BrickyardSync.here ? '<li><button type="button" id="m-sync"><span>Sync with Google Drive<small>The same catalog on every device</small></span></button></li>' : '') +
      '<li><button type="button" id="m-link"><span>Copy everything as a link<small>Open it on another device, or at brickyard.junkdrawer.works, to bring your sets across</small></span></button></li>' +
      '<li><button type="button" id="m-open"><span>Open a file<small>A backup, or sets, sizes or a model from Claude</small></span></button></li>' +
      (FRAMED ? '' : '<li><button type="button" id="m-csv"><span>Download a spreadsheet<small>CSV, for Excel, Numbers or Google Sheets</small></span></button></li>') +
      (FRAMED ? '' : '<li><label><input type="checkbox" id="m-pics"' + (prefs.pics ? ' checked' : '') + ' style="width:20px;height:20px;accent-color:var(--red)"><span>Show set pictures<small>Loaded from Rebrickable by set number. Nothing else is sent.</small></span></label></li>') +
      '</ul><p class="note">' + (FRAMED ? 'This preview keeps your catalog in this browser only. To keep it on every device, copy everything as a link and open it at brickyard.junkdrawer.works, then turn on Google Drive sync there.'
        : 'Your catalog is kept in this browser' + (window.BrickyardSync && window.BrickyardSync.here ? ', and in your Google Drive if you turn on sync.' : ' only.') + ' Download a backup now and then, and before you clear your browser’s data.') + '</p></div>');
    $('m-claude').onclick = claudeSheet;
    $('m-open').onclick = function () { closeSheet(); $('file').click(); };
    $('m-link').onclick = copyAll;
    if ($('m-sync')) $('m-sync').onclick = function () { window.BrickyardSync.sheet(); };
    if ($('m-backup')) $('m-backup').onclick = function () { closeSheet(); download('Brickyard ' + today() + '.json', 'application/json', JSON.stringify({ brickyard: 1, catalog: DOC }, null, 1)); };
    if ($('m-csv')) $('m-csv').onclick = function () {
      closeSheet();
      var sets = C.live(DOC).sort(function (a, b) { return C.natural(a.name || '', b.name || ''); });
      download('Brickyard sets ' + today() + '.csv', 'text/csv', '﻿' + C.toCsv(sets));
    };
    if ($('m-pics')) $('m-pics').onchange = function () { prefs.pics = this.checked; savePrefs(); renderCatalog(); };
  }

  // Show the catalog as it is now on whichever screen is open, without moving the page. A sheet keeps its own
  // copy of what it shows, so the screen behind an open one catches up too.
  function refresh() {
    if (!$('catalog').hidden) renderCatalog(); else if (!$('home').hidden) renderHome();
    document.dispatchEvent(new CustomEvent('brickyard:changed')); // the builder and the shelf planner redraw
  }

  // A catalog merged in from elsewhere (Drive sync): keep it, and show it.
  function takeDoc(doc) {
    DOC = doc; write(KEY, { brickyard: 1, catalog: DOC });
    refresh();
  }

  // The whole catalog as one link, to open on another device or at Brickyard's own address (the claude.ai copy
  // can't download files). Opening it merges, like a backup.
  function copyAll() {
    var text = JSON.stringify({ brickyard: 1, catalog: DOC }), bytes = new TextEncoder().encode(text);
    var b64 = function (u8) { var bin = ''; for (var i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i]); return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
    var made = typeof CompressionStream === 'undefined' ? Promise.resolve('#b1j' + b64(bytes))
      : new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer().then(function (b) { return '#b1z' + b64(new Uint8Array(b)); });
    made.then(function (h) {
      var link = SITE + h;
      // Chat apps, notes and some browsers cut a very long link off, and what's left won't open. The preview copy
      // can't download a backup, so there the link is all there is.
      var lengthy = link.length > 8000 && !FRAMED;
      var show = function () {
        openSheet('<div class="hd"><h2 id="sheetTitle">Your catalog as a link</h2><button class="btn sm quiet" type="button" data-close>Close</button></div>' +
          '<div class="bd"><p class="note">Copy this and open it on the other device. It adds what that device doesn’t have.' +
          (lengthy ? ' It’s a long link; if it won’t open, use Download a backup instead.' : '') + '</p><textarea class="paste" id="all-link" readonly style="min-height:160px">' + esc(link) + '</textarea></div>');
        $('all-link').select();
      };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(link).then(function () {
        closeSheet();
        if (lengthy) toast('Copied. It’s a long link; if it won’t open, use Download a backup instead.', 'long');
        else toast('Copied. Open the link on your other device.');
      }, show);
      else show();
    });
  }

  // Another tab changed the catalog: show it here without moving the page or a model back to its first step.
  window.addEventListener('storage', function (e) {
    if (e.key !== KEY) return;
    DOC = C.mergeDocs(DOC, C.cleanDoc(read(KEY) || {}));
    refresh();
  });

  if ('serviceWorker' in navigator && window.isSecureContext && !FRAMED) navigator.serviceWorker.register('sw.js').catch(function () {});
  offEntry();
  if (!checkLink()) {
    route();
    // The preview copy has no sets of its own, so it opens on Claude's example batch.
    if (FRAMED && window.BRICKYARD_EXAMPLE && !C.live(DOC).length) {
      location.hash = '#catalog';
      takeIncoming(C.parseIncoming(JSON.stringify(window.BRICKYARD_EXAMPLE)));
    }
  }
  window.brickyard = {
    doc: function () { return DOC; },
    // For the shelf planner (js/shelves.js) and Build from your box (js/build.js), which adds the brick box.
    putSet: function (x) { putSet(x); save(); },
    putCase: function (c) { c.t = Date.now(); DOC.cases[c.id] = c; save(); },
    removeCase: function (id) { DOC.cases[id] = { id: id, t: Date.now(), del: 1 }; save(); },
    removeLot: function (id) { DOC.loose[id] = { id: id, t: Date.now(), del: 1 }; save(); },
    // Undo for a bookcase or a lot just removed; refresh for a change kept outside the catalog (a model).
    putBack: function (kind, x) { putBack(kind, x); save(); refresh(); }, refresh: refresh,
    newId: newId, takeDoc: takeDoc, showSet: showSet,
    addSet: function (x) { var y = C.cleanSet(x); if (!y) return null; y.id = newId(); y.added = today(); putSet(y); save(); return y; },
    // For the other screens' paste boxes and links: anything of Brickyard's goes to its own review (takeIncoming),
    // and what can't be read says why (unread).
    takeIncoming: takeIncoming, takePasted: takePasted, unread: unread, openFile: function () { $('file').click(); },
    toast: toast, toastAfter: toastAfter, heading: heading, openSheet: openSheet, closeSheet: closeSheet, fieldsOf: fieldsOf, secondTap: secondTap, tickRow: tickRow, esc: esc, plural: plural, FRAMED: FRAMED,
  };
  document.dispatchEvent(new CustomEvent('brickyard:ready'));
})();
