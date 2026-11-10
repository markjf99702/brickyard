// Build from your box: the pieces you have, the models Claude designed from them, and a 3D step-by-step
// view for building one. The checks are in js/build-core.js; this file is the screens and the drawing.
import * as THREE from './vendor/three.module.js';
import { OrbitControls } from './vendor/OrbitControls.js';

const B = window.BuildCore;
const app = window.brickyard;
const { esc, plural, toast } = app;
const MODELS = 'brickyard.models', POOL = 'brickyard.pool';
const EXAMPLES = ['cottage'];
const BOX = { num: '10698', name: 'Large Creative Brick Box', year: 2015, pieces: 790, theme: 'Classic', state: 'apart' };
const $ = id => document.getElementById(id);

function read(k, d) { try { return JSON.parse(localStorage.getItem(k) || 'null') || d; } catch (e) { return d; } }
function write(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* the page still works without saving */ } }
// The step each model is on, for this tab only, so a reload (or the phone dropping the tab and bringing it back)
// reopens a model where you were. The address stays #model-ID.
const STEP = 'brickyard.step.';
function stepOf(id) { try { return Math.max(0, parseInt(sessionStorage.getItem(STEP + id), 10) || 0); } catch (e) { return 0; } }
function keepStep(id, at) { try { sessionStorage.setItem(STEP + id, String(at)); } catch (e) { /* it starts at step 1 instead */ } }

// ---------- data ----------
// The site fetches parts/…; the single-file preview carries the same files in window.BRICKYARD_DATA.
const DATA = window.BRICKYARD_DATA || null;
const cache = {};
// A file that didn't arrive (no signal, or the offline copy answering with the page in its place) isn't kept: the
// next ask goes to the network again. The failed ask used to be kept, so the builder stayed an empty screen until
// the page was reloaded. `lost` marks the error as a file that didn't arrive, which gets a message and Try again
// (orSay); anything else is a mistake in the page and is thrown on.
function lost(e) { e.lost = true; return e; }
function get(path) {
  if (DATA) return DATA[path] ? Promise.resolve(DATA[path]) : Promise.reject(lost(new Error('missing ' + path)));
  if (!cache[path]) {
    cache[path] = fetch(path).then(r => { if (!r.ok) throw new Error(path + ' ' + r.status); return r.json(); })
      .catch(e => { delete cache[path]; throw lost(e); });
  }
  return cache[path];
}
let shapes = null, colors = null, index = null, loading = null;
// The files every screen here needs, asked for once; after a failure the next call asks again.
// parts/aliases.json is other numbers for the same piece (3023 for 3023b). Without it (a copy of the page from
// before it existed) every number is read as it's written, as it was.
function load() {
  if (!loading) {
    loading = Promise.all([get('parts/shapes.json'), get('parts/colors.json'), get('parts/index.json'), get('parts/aliases.json').catch(() => ({}))])
      // shapes holds its parts and nothing else (no "constructor" or "toString" from every object's own kit), so a part
      // number is known only if it's in the file: a model with a part written "constructor" stopped the page opening it.
      .then(([s, c, i, a]) => { shapes = Object.assign(Object.create(null), s); colors = c; index = i; B.useAliases(a); })
      .catch(e => { loading = null; throw e; });
  }
  return loading;
}
// A screen that couldn't get a file says so, with Try again, in place of the list (it was an empty screen under the
// title, with nothing to press). Trying again runs route(), which reads the address as it still is: a model link
// that didn't open is still there, and opens.
const orSay = fn => async (...a) => {
  try { return await fn(...a); }
  catch (e) {
    if (!e || !e.lost) throw e;
    stopStage();
    current = null;
    $('build-title').textContent = 'Build from your box';
    document.title = 'Build from your box · Brickyard';
    $('build-back').setAttribute('href', '#');
    $('model-menu').hidden = true;
    $('model-view').hidden = true;
    $('build-list').hidden = false;
    app.lostBuilder(route);
    app.heading();
  }
};

// Your pieces: the sets in My sets that Brickyard has a parts list for, and the lots of loose pieces (from a scanner,
// or a list from Claude). Which of them count, and how many pieces that is, is worked out in js/core.js (yourPieces),
// where the home screen's card gets its number too.
function mine() { return window.BrickCore.yourPieces(app.doc(), index, read(POOL, {})); }
function poolSets() { return mine().sets; }
// Taken-apart sets Brickyard has no parts list for, by name: their pieces can't be counted yet. Built and sealed
// sets aren't pieces to build from, so a missing list for one of those is nothing to mention.
function missingLists() {
  return Object.values(app.doc().sets).filter(x => !x.del && x.state === 'apart' && !(x.num && index[x.num]))
    .map(x => x.name || 'Set ' + String(x.num || '').replace(/-1$/, ''))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}
// Why an unticked set is off, when it's the set's state that says so.
const OFF = { built: 'built, so off unless you take it apart', partial: 'partly built, so off', sealed: 'sealed, so off' };
// `usable` is how many of a lot's pieces the builder can draw.
function poolLots() {
  return mine().lots.map(l => Object.assign(l, { usable: l.parts.reduce((n, r) => n + (shapes[B.canon(r[0])] ? r[2] : 0), 0) }));
}
async function currentPool() {
  const on = poolSets().filter(s => s.on), lots = poolLots().filter(l => l.on);
  const invs = await Promise.all(on.map(s => get('parts/sets/' + s.num + '.json')));
  on.forEach((s, i) => { s.parts = invs[i].parts || []; }); // so a model can say which sets its pieces come from
  return { sets: on, lots, any: on.length + lots.length > 0, pool: B.poolOf(invs.concat(lots)), pieces: mine().pieces };
}

// Models are kept in this browser, keyed by their parts, so opening the same link twice keeps one copy. The same
// parts are the same model whatever order they're listed in (sameParts), and the one that comes in is the one kept:
// a model sent again under a better name, or with a new description, shows those (it used to keep the old ones, and
// the same parts listed in another order made a second row). It keeps its place in the list (added).
function hashOf(t) { let h = 2166136261 >>> 0; for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h.toString(36); }
function saved() { return read(MODELS, {}); }
function sameParts(parts) { return parts.map(q => q.join(',')).sort().join(';'); }
function saveModel(m) {
  const all = saved(), key = sameParts(m.parts);
  // An entry saved before ids were made this way (from the parts in the order they were listed, under the part
  // numbers they came with) keeps the id it has, so its #model- address still opens it.
  const id = Object.keys(all).find(k => { const old = all[k] && all[k].model && B.cleanModel(all[k].model); return old && sameParts(old.parts) === key; }) || 'm' + hashOf(key);
  if (!all[id] || JSON.stringify(all[id].model) !== JSON.stringify(m)) { all[id] = { model: m, added: (all[id] && all[id].added) || Date.now() }; write(MODELS, all); }
  return id;
}
// When a model was added, for the list: two with the same name can be told apart.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function addedOn(t) {
  if (!t) return '';
  const d = new Date(t), now = new Date(), day = x => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((day(now) - day(d)) / 864e5);
  return 'Added ' + (days <= 0 ? 'today' : days === 1 ? 'yesterday' : d.getDate() + ' ' + MONTHS[d.getMonth()] + (d.getFullYear() === now.getFullYear() ? '' : ' ' + d.getFullYear()));
}
// For a model file opened from My sets' menu (js/app.js), which saves it here and opens it.
// inView is for test/e2e.mjs: where the model's bounds fall on the picture.
window.BrickyardBuild = { saveModel, inView: () => inView() };
async function modelById(id) {
  if (id.startsWith('x-')) {
    const name = id.slice(2);
    if (!EXAMPLES.includes(name)) return null;
    const doc = await get('models/' + name + '.json');
    return B.cleanModel(doc);
  }
  const m = saved()[id];
  return m ? B.cleanModel(m.model) : null;
}
function colorOf(c) { const x = colors[String(c)]; return x ? { name: x[0], hex: x[1], alpha: x[2] } : { name: 'Colour ' + c, hex: '#999999' }; }
function partName(p) { return shapes[p] ? shapes[p].n : 'Part ' + p; }
// A piece in a sentence: "a white 2x2 brick", "an orange 1x4 arch".
function aPiece(q) {
  const m = /^(.*?) (\d+x\d+(?:x[\d⅓⅔]+)?)(.*)$/.exec(partName(q[0]));
  const t = colorOf(q[1]).name.toLowerCase() + ' ' + (m ? m[2] + ' ' + m[1].toLowerCase() + m[3] : partName(q[0]).toLowerCase());
  return (/^[aeiou]/.test(t) ? 'an ' : 'a ') + t;
}
function listed(a) { return a.length > 1 ? a.slice(0, -1).join(', ') + ' and ' + a[a.length - 1] : a[0] || ''; }

// ---------- screens ----------
let current = null; // { id, model, res, steps, at }

const route = orSay(async () => {
  const h = location.hash;
  if ($('build').hidden) { stopStage(); return; }
  await load();
  if (/^#d1[zj]/.test(h)) {
    try {
      const r = await window.BrickCore.parseIncoming(h);
      const m = r.kind === 'model' ? B.cleanModel(r.doc) : null;
      if (!m) throw new Error('empty');
      const id = saveModel(m);
      history.replaceState(null, '', location.pathname + location.search + '#model-' + id);
      return openModel(id);
    } catch (e) {
      app.unread(e, 'That link doesn’t hold a model Brickyard can read'); // cut short and newer links say so
      history.replaceState(null, '', location.pathname + location.search + '#build');
    }
  }
  if (h.startsWith('#model-')) return openModel(h.slice(7));
  return renderList();
});
document.addEventListener('brickyard:route', route);

const renderList = orSay(async () => {
  await load();
  stopStage();
  current = null;
  $('build-title').textContent = 'Build from your box';
  document.title = 'Build from your box · Brickyard';
  app.heading(); // arriving from another screen, the heading takes the focus (js/app.js)
  $('build-back').setAttribute('href', '#');
  $('model-menu').hidden = true;
  $('model-view').hidden = true;
  $('build-list').hidden = false;
  const sets = poolSets(), on = sets.filter(s => s.on), none = missingLists(), lots = poolLots();
  const { pool, pieces, any } = await currentPool();

  // The headings are read out as "Your pieces, 816 pieces" and "Models, 2" (they were a bare "Your pieces 816").
  let html = '<section class="pieces"><h2 class="group" tabindex="-1"' + (pieces ? ' aria-label="Your pieces, ' + plural(pieces, 'piece') + '"' : '') + '><span>Your pieces</span><span>' + (pieces ? pieces.toLocaleString() : '') + '</span></h2>';
  if (!sets.length && !lots.length) {
    html += '<div class="how"><p style="margin:0 0 10px">Brickyard builds from sets that are taken apart and that it has a parts list for. So far that is the Large Creative Brick Box (10698). Have one? Add it.</p>' +
      '<button class="btn" type="button" id="add-box">Add the Large Creative Brick Box</button></div>';
  } else {
    html += '<ul class="menu pool">' + sets.map(s => '<li><label><input type="checkbox" data-pool="' + esc(s.id) + '"' + (s.on ? ' checked' : '') + '>' +
      '<span>' + esc(s.name) + '<small>' + esc(s.num.replace(/-1$/, '')) + ' · ' + plural(s.pieces, 'piece') + (!s.on && OFF[s.state] ? ' · ' + OFF[s.state] : '') + '</small></span></label></li>').join('') +
      lots.map(l => '<li class="lot"><label><input type="checkbox" data-pool="' + esc(l.id) + '"' + (l.on ? ' checked' : '') + '>' +
        '<span>' + esc(l.name) + '<small>Loose · ' + plural(l.pieces, 'piece') + (l.box ? ' · box ' + esc(window.BrickCore.boxName(l.box)) : '') +
        (l.usable < l.pieces ? ' · the builder can use ' + l.usable.toLocaleString() : '') + '</small></span></label>' +
        '<button class="btn sm quiet" type="button" data-lot="' + esc(l.id) + '" aria-label="Remove ' + esc(l.name) + '">Remove</button></li>').join('') + '</ul>';
    if (!any) html += '<p class="flag"><span>' + (!lots.length ? 'Tick a set to build from its pieces.' : sets.length ? 'Tick a set or some loose pieces to build from them.' : 'Tick your loose pieces to build from them.') + '</span></p>';
  }
  if (none.length) {
    const names = none.slice(0, 3).concat(none.length > 3 ? [(none.length - 3) + ' more'] : []), one = none.length === 1;
    html += '<p class="note">' + esc(names.length > 1 ? names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1] : names[0]) + (one ? ' is' : ' are') + ' taken apart, but Brickyard has no parts list for ' +
      (one ? 'it' : 'them') + ' yet, so ' + (one ? 'its' : 'their') + ' pieces aren’t counted.</p>';
  }
  html += '<div class="acts-row"><button class="btn quiet" type="button" id="copy-pool"' + (any ? '' : ' disabled') + '>Copy my pieces for Claude</button><button class="btn quiet" type="button" id="open-model">Open a model</button></div></section>';

  // A saved entry with no model in it (a damaged save) is skipped rather than stopping the whole list.
  const mine = Object.entries(saved()).filter(([, v]) => v && v.model).sort((a, b) => (b[1].added || 0) - (a[1].added || 0))
    .map(([id, v]) => ({ id, model: B.cleanModel(v.model), added: addedOn(v.added) })).filter(x => x.model);
  const examples = await Promise.all(EXAMPLES.map(async n => ({ id: 'x-' + n, model: await modelById('x-' + n), example: true })));
  const rows = mine.concat(examples);
  html += '<h2 class="group" aria-label="Models, ' + rows.length + '"><span>Models</span><span>' + rows.length + '</span></h2><ul class="list">' + rows.map(r => {
    const res = B.check(r.model, shapes, any ? pool : null);
    const shortBy = res.short.reduce((n, x) => n + (x.need - x.have), 0);
    const other = res.problems.filter(p => p.kind !== 'count').length;
    // With no pieces chosen there's nothing to count against, so only a broken model gets a badge.
    const state = other ? '<span class="badge sealed">Needs fixing' + (any && shortBy ? ' · ' + shortBy + ' short' : '') + '</span>' : !any ? '' : shortBy ? '<span class="badge partial">' + shortBy + ' short</span>' : '<span class="badge built">Can build</span>';
    return '<li><a class="item" href="#model-' + esc(r.id) + '">' + swatchStack(r.model) +
      '<div class="main"><div class="t">' + esc(r.model.name) + (r.example ? ' <span class="m" style="display:inline">· example</span>' : '') + '</div>' +
      '<div class="m"><span>' + plural(r.model.parts.length, 'piece') + '</span>' + (res.steps.length ? ' · <span>' + plural(res.steps.length, 'step') + '</span>' : '') + '</div>' +
      (r.added ? '<div class="m">' + r.added + '</div>' : '') + '</div>' + state + '</a></li>';
  }).join('') + '</ul>' +
    '<div class="how" style="margin-top:14px"><b>Get a new model from Claude</b><ol><li>Tap <b>Copy my pieces for Claude</b>.</li><li>Paste it to Claude and say what you’d like: “a lighthouse”, “something for the new house”.</li>' +
    '<li>Claude designs it from those pieces only, checks it can really be built, and sends a link. Open it here.</li></ol></div>';
  $('build-list').innerHTML = html;

  if ($('add-box')) $('add-box').onclick = () => { app.addSet(BOX); toast('Added to My sets as taken apart'); renderList(); };
  $('build-list').querySelectorAll('[data-pool]').forEach(cb => cb.onchange = () => {
    const prefs = read(POOL, {}); prefs[cb.dataset.pool] = cb.checked; write(POOL, prefs);
    renderList().then(() => focusIn('[data-pool="' + CSS.escape(cb.dataset.pool) + '"]')); // the list is redrawn: the tick keeps the focus
  });
  $('build-list').querySelectorAll('[data-lot]').forEach(b => b.onclick = () => dropLot(lots.find(l => l.id === b.dataset.lot)));
  $('copy-pool').onclick = copyPool;
  $('open-model').onclick = openSheet;
});
function focusIn(sel) { const el = $('build-list').querySelector(sel); if (el) el.focus({ preventScroll: true }); return !!el; }
// (With "Couldn't load" showing, the address may still be a model's: route() reads it again.)
document.addEventListener('brickyard:changed', () => { if (!$('build').hidden && !$('build-list').hidden) ($('build-retry') ? route : renderList)(); });

function dropLot(l) {
  if (!l) return;
  app.openSheet('<div class="hd"><h2 id="sheetTitle">Remove these loose pieces?</h2><button class="btn sm quiet" type="button" data-close>Keep them</button></div>' +
    '<div class="bd"><p class="lede"><b>' + esc(l.name) + '</b> · ' + plural(l.pieces, 'piece') + '</p><p class="note">They leave Your pieces. Your sets aren’t touched, and opening the lot’s link or file again brings it back.</p></div>' +
    '<div class="ft"><span></span><button class="btn" type="button" id="lot-drop">Remove</button></div>');
  $('lot-drop').onclick = () => {
    const kept = app.doc().loose[l.id], ids = poolLots().map(x => x.id), at = ids.indexOf(l.id);
    app.removeLot(l.id); app.closeSheet();
    // The focus goes to the lot that took this one's place, or the one before it, or the heading: the button it
    // was on has gone with the lot.
    renderList().then(() => { [ids[at + 1], ids[at - 1]].some(id => id && focusIn('[data-pool="' + CSS.escape(id) + '"]')) || focusIn('.pieces h2'); });
    toast('Removed ' + l.name, false, { label: 'Undo', run: () => { app.putBack('loose', kept); toast(l.name + ' is back'); } });
  };
}

// A little stack of the model's main colours, for the list.
function swatchStack(m) {
  const n = {};
  m.parts.forEach(q => { n[q[1]] = (n[q[1]] || 0) + 1; });
  const top = Object.keys(n).sort((a, b) => n[b] - n[a]).slice(0, 4);
  return '<div class="pic swatches">' + top.map((c, i) => '<i style="background:' + colorOf(c).hex + ';left:' + (6 + i * 12) + 'px;top:' + (30 - i * 7) + 'px"></i>').join('') + '</div>';
}

async function copyPool() {
  const { sets, lots, pool } = await currentPool();
  const rows = Object.keys(pool).filter(k => shapes[k.split('/')[0]]).sort();
  const other = Object.keys(pool).length - rows.length;
  const text = 'My Brickyard pieces, from ' + sets.map(s => s.num + ' ' + s.name).concat(lots.map(l => 'loose pieces (' + l.name + ')')).join(' + ') + '.\n' +
    'Pieces the builder knows, as LDraw part/colour ×count:\n' + rows.map(k => k + ' ×' + pool[k]).join(', ') +
    (other ? '\n(' + other + ' more kinds, such as wheels and hinges, that the builder doesn’t use yet.)' : '') + '\n';
  try { await navigator.clipboard.writeText(text); toast('Copied. Paste it to Claude with what you’d like built.'); }
  catch (e) {
    app.openSheet('<div class="hd"><h2 id="sheetTitle">Your pieces for Claude</h2><button class="btn sm quiet" type="button" data-close>Close</button></div>' +
      '<div class="bd"><p class="note">Copy this and paste it to Claude.</p><textarea class="paste" id="pool-text" readonly style="min-height:200px">' + esc(text) + '</textarea></div>');
    $('pool-text').select();
  }
}

// Whatever is pasted or opened here goes where it belongs (app.takeIncoming): a model opens, and loose pieces, sets
// or sizes go to their own review, so there's no wrong box to paste a Brickyard link into.
function openSheet() {
  app.openSheet('<div class="hd"><h2 id="sheetTitle">Open a model</h2><button class="btn sm quiet" type="button" data-close>Close</button></div><div class="bd">' +
    '<p class="note">Paste the link Claude sent, or open its file. A loose-pieces link, from Stud Finder say, opens here too.</p>' +
    '<textarea class="paste" id="model-paste" aria-label="Paste a Brickyard link or file" placeholder="Paste a Brickyard link or file"></textarea></div>' +
    '<div class="ft"><button class="btn quiet" type="button" id="model-file">Open a file</button><button class="btn" type="button" id="model-go">Open</button></div>');
  $('model-file').onclick = app.openFile;
  $('model-go').onclick = () => app.takePasted($('model-paste'), 'That doesn’t look like a model from Claude');
}

// ---------- one model ----------
const openModel = orSay(async id => {
  await load();
  const model = await modelById(id);
  // The list takes this address's place in history rather than a new one after it. Back can land here on a model
  // that was removed, with no tap since, and Chrome's Back then skips every place a page adds: the next Back would
  // leave Brickyard.
  if (!model) { toast('That model isn’t saved on this device. Open Claude’s link to it here.', 'long'); location.replace('#build'); return; }
  const { pool, sets, lots, any } = await currentPool();
  const res = B.check(model, shapes, any ? pool : null);
  current = { id, model, res, steps: res.steps, at: 0, pool: any ? pool : null, sets, lots };
  $('build-title').textContent = model.name;
  document.title = model.name + ' · Brickyard';
  app.heading();
  $('build-back').setAttribute('href', '#build');
  $('model-menu').hidden = false;
  $('build-list').hidden = true;
  $('model-view').hidden = false;
  $('model-about').textContent = model.about;
  $('step-range').max = String(current.steps.length);
  renderCheck();
  // A model with nothing the builder can draw has no picture and no steps: the message says so on its own.
  $('model-view').classList.toggle('bare', !res.pieces);
  if (!res.pieces) { stopStage(); return; }
  startStage();
  buildScene(model);
  showStep(stepOf(id), false);
});

// What the check found, in words about the pieces: which piece, by its colour and name, and in which step as the
// page counts them (the checker's own texts, which the page shares with check_model.py, give grid positions and
// the model's step numbers, and repeat themselves).
function stepNo(i) { return current.steps.indexOf(current.model.parts[i][6]) + 1; }
function inStep(i) { return 'in step ' + stepNo(i); }
function whatsWrong(fails) {
  const { model, steps } = current, q = i => model.parts[i], of = kind => fails.filter(p => p.kind === kind), out = [];
  const unknown = of('part');
  if (unknown.length) {
    const ids = unknown.map(p => q(p.parts[0])[0]).filter((v, i, a) => a.indexOf(v) === i);
    out.push('It uses ' + (unknown.length === 1 ? 'a piece' : unknown.length + ' pieces') + ' the builder can’t draw (' + ids.slice(0, 4).join(', ') + (ids.length > 4 ? ' and ' + (ids.length - 4) + ' more' : '') + ')');
  }
  const clash = of('overlap');
  clash.slice(0, 2).forEach(p => {
    // An arch or a frame is solid to the check, though the picture shows it open: a piece under or through one
    // is "inside" it.
    const open = i => /^(arch|frame)$/.test(shapes[q(i)[0]].k);
    const [a, b] = open(p.parts[0]) && !open(p.parts[1]) ? [p.parts[1], p.parts[0]] : p.parts, when = inStep(stepNo(a) > stepNo(b) ? a : b);
    const A = aPiece(q(a)), B2 = aPiece(q(b));
    out.push(open(b) && !open(a) ? A.charAt(0).toUpperCase() + A.slice(1) + ' is inside ' + B2 + ', ' + when
      : A.charAt(0).toUpperCase() + A.slice(1) + ' and ' + (A === B2 ? 'another' : B2) + ' are in the same place, ' + when);
  });
  if (clash.length > 2) out.push(plural(clash.length - 2, 'more pair') + ' of pieces ' + (clash.length === 3 ? 'is' : 'are') + ' in the same place too');
  const loose = [].concat(...of('loose').map(p => p.parts));
  if (loose.length === 1) { const A = aPiece(q(loose[0])); out.push(A.charAt(0).toUpperCase() + A.slice(1) + ' ' + inStep(loose[0]) + ' isn’t joined to the rest of the model'); }
  else if (loose.length) out.push(loose.length + ' pieces aren’t joined to the rest of the model: ' + listed(loose.slice(0, 2).map(i => aPiece(q(i)) + ' ' + inStep(i)).concat(loose.length > 2 ? [(loose.length - 2) + ' more'] : [])));
  const order = of('order').map(p => steps.indexOf(p.step) + 1);
  if (order.length) out.push((order.length === 1 ? 'Step ' + order[0] + ' adds' : 'Steps ' + listed(order.slice(0, 4).concat(order.length > 4 ? [(order.length - 4) + ' more'] : [])) + ' add') + ' pieces with nothing to join to yet');
  return out;
}

function renderCheck() {
  const { res, pool, sets, lots, model } = current;
  let html = '';
  const fails = res.problems.filter(p => p.kind !== 'count'), left = model.parts.length - res.pieces;
  if (!res.pieces) {
    const ids = model.parts.map(q => q[0]).filter((v, i, a) => a.indexOf(v) === i);
    $('model-check').innerHTML = '<div class="flag bad"><span><b>Brickyard can’t show this model.</b> ' + (left === 1 ? 'Its one piece isn’t' : 'None of its ' + left + ' pieces are') + ' among the ones the builder can draw (' +
      esc(ids.slice(0, 4).join(', ')) + (ids.length > 4 ? ' and ' + (ids.length - 4) + ' more' : '') + '). Ask Claude to design it from the pieces in <b>Copy my pieces for Claude</b>.</span></div>';
    return;
  }
  if (fails.length) html += '<div class="flag bad"><span><b>This model can’t be built as it is.</b> ' + esc(whatsWrong(fails).join('. ')) + '. Ask Claude to fix it.</span></div>';
  if (!pool) html += '<div class="flag"><span>Brickyard doesn’t know which pieces you have yet, so it can’t check you have enough. Choose them under Your pieces on the list of models.</span></div>';
  else if (res.short.length) {
    html += '<div class="flag"><span><b>You’re short:</b> ' + res.short.map(x => {
      const [p, c] = x.key.split('/');
      return (x.need - x.have) + ' × ' + esc(colorOf(c).name) + ' ' + esc(partName(p).toLowerCase());
    }).join(', ') + '. Swap colours where it doesn’t matter, or ask Claude for another version.</span></div>';
  } else if (!fails.length) {
    // Named the way Copy my pieces for Claude names them: the sets, then each lot as "loose pieces (Red tub)". Only
    // the ones that hold a piece this model uses (a lot of wheels isn't where a cottage's bricks came from).
    const holds = src => src.parts.some(r => res.used[B.canon(String(r[0])) + '/' + r[1]]);
    const from = sets.filter(holds).map(s => s.name).concat(lots.filter(holds).map(l => 'loose pieces (' + l.name + ')'));
    html += '<p class="note ok">✓ You have every piece for this' + (from.length ? ', from ' + esc(listed(from)) : '') + '.</p>';
  }
  const cm = B.sizeCm(res.size);
  html += '<p class="note">' + plural(model.parts.length, 'piece') + (left ? ', ' + left + ' the builder can’t draw' : '') + ' · ' + plural(res.steps.length, 'step') + ' · about ' + cm.w.toFixed(1).replace(/\.0$/, '') + ' × ' + cm.d.toFixed(1).replace(/\.0$/, '') + ' cm, ' + cm.h.toFixed(1).replace(/\.0$/, '') + ' cm tall</p>';
  $('model-check').innerHTML = html;
}

// Step k of the list (0-based); one past the last step shows the finished model.
function showStep(k, animate = true) {
  const n = current.steps.length;
  current.at = Math.max(0, Math.min(n, k));
  keepStep(current.id, current.at);
  const done = current.at === n, step = done ? Infinity : current.steps[current.at];
  $('step-n').textContent = done ? 'Done' : 'Step ' + (current.at + 1);
  $('step-of').textContent = done ? ' · ' + plural(current.res.pieces, 'piece') : ' of ' + n;
  // Previous stays in the Tab order at the first step (a disabled button drops the focus it has), and says it's off.
  $('step-prev').setAttribute('aria-disabled', String(current.at === 0));
  // At the end the button in Next's place starts again: quiet, so one more tap out of habit isn't asked for.
  $('step-next').textContent = done ? 'From the start' : current.at === n - 1 ? 'Finish' : 'Next';
  $('step-next').classList.toggle('quiet', done);
  $('step-range').value = String(current.at);
  $('step-range').setAttribute('aria-valuetext', done ? 'Done, ' + plural(current.res.pieces, 'piece') : 'Step ' + (current.at + 1) + ' of ' + n);

  // The step's pieces the builder draws (one it can't isn't in the picture, and the message above names it).
  const here = current.model.parts.map((q, i) => ({ q, i })).filter(x => x.q[6] === step && shapes[x.q[0]]);
  const groups = {};
  here.forEach(({ q }) => { const k2 = q[0] + '/' + q[1]; groups[k2] = (groups[k2] || 0) + 1; });
  const shortKeys = new Set(current.res.short.map(x => x.key));
  // Pieces that push on from below, under something already built (the checker notes them; nothing showed it).
  const note = current.res.notes.find(x => x.kind === 'under' && x.step === step), under = {};
  if (note) note.parts.forEach(i => { const k2 = current.model.parts[i][0] + '/' + current.model.parts[i][1]; under[k2] = (under[k2] || 0) + 1; });
  $('step-parts').innerHTML = done
    ? '<p class="note" style="margin:0">That’s the whole model. Drag it around to look it over.</p>'
    : '<div class="lbl">Find these</div><ul class="need">' + Object.keys(groups).map(k2 => {
      const [p, c] = k2.split('/'), col = colorOf(c);
      return '<li' + (shortKeys.has(k2) ? ' class="short"' : '') + '><i style="background:' + col.hex + (col.alpha ? ';opacity:.6' : '') + '"></i><span><b>' + groups[k2] + '×</b> ' +
        esc(partName(p)) + '<small>' + esc(col.name) + (under[k2] && note.parts.length < here.length ? ' · ' + (under[k2] < groups[k2] ? under[k2] + ' ' : '') + 'from underneath' : '') + '</small></span></li>';
    }).join('') + '</ul>' + (note ? '<p class="note under">' + (here.length === 1 ? 'This one goes on from underneath.' : note.parts.length === here.length ? 'These go on from underneath.' : note.parts.length + ' of these ' + (note.parts.length === 1 ? 'goes' : 'go') + ' on from underneath.') + '</p>' : '');
  showUpTo(step, animate && !done);
}

$('step-prev').onclick = () => { if (current.at > 0) showStep(current.at - 1); };
$('step-next').onclick = () => showStep(current.at === current.steps.length ? 0 : current.at + 1);
// The slider. A finger moves it only by its knob: a tap or a swipe that starts anywhere else on it leaves the step
// alone (the strip under the buttons is where a thumb lands low, and where it starts a scroll), and so does a drag
// of the knob that turned into a scroll of the page. A mouse still clicks along the track, and arrow keys move it.
const range = $('step-range');
let grab = null; // { at: the step when the finger went down, knob: it went down on the knob, y: the page's scroll then }
function knobX() {
  const r = range.getBoundingClientRect(), w = 20; // about a knob's width; it travels the track less that
  return r.left + w / 2 + (current.at / (+range.max || 1)) * (r.width - w);
}
range.addEventListener('pointerdown', e => {
  grab = !current || e.pointerType === 'mouse' ? null : { at: current.at, knob: Math.abs(e.clientX - knobX()) <= 24, y: window.scrollY };
});
range.oninput = () => {
  // What the browser does with a touch can come a moment after the finger lifts, so the rule outlasts it a little.
  if (grab && grab.up && performance.now() - grab.up > 600) grab = null;
  if (grab && !grab.knob) { range.value = String(grab.at); return; }
  showStep(+range.value, false);
};
function letGo(e) {
  if (!grab || grab.up) return;
  grab.up = performance.now();
  if (grab.knob && (e.type === 'pointercancel' || Math.abs(window.scrollY - grab.y) > 8)) { grab.knob = false; if (current) showStep(grab.at, false); }
}
range.addEventListener('pointerup', letGo);
range.addEventListener('pointercancel', letGo);
document.addEventListener('keydown', e => {
  if (!current || $('model-view').hidden || document.querySelector('.scrim')) return;
  if (e.altKey || e.ctrlKey || e.metaKey) return; // Alt+Left is the browser's Back
  if (e.target === $('stage')) return; // on the picture, the arrows turn it (turnKeys)
  if (/^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return; // the step slider moves itself
  if (e.key === 'ArrowRight') showStep(current.at + 1);
  if (e.key === 'ArrowLeft') showStep(current.at - 1);
});
$('model-menu').onclick = () => {
  const ex = current.id.startsWith('x-');
  app.openSheet('<div class="hd"><h2 id="sheetTitle">' + esc(current.model.name) + '</h2><button class="btn sm quiet" type="button" data-close>Close</button></div><div class="bd"><ul class="menu">' +
    '<li><button type="button" id="mm-parts"><span>All the pieces<small>Everything this model needs, and what you have</small></span></button></li>' +
    (ex ? '' : '<li><button type="button" id="mm-del"><span>Remove from my models<small>Tap twice. Claude’s link still opens it again.</small></span></button></li>') +
    '</ul></div>');
  $('mm-parts').onclick = partsSheet;
  if ($('mm-del')) $('mm-del').onclick = function () {
    if (!app.secondTap(this)) { this.querySelector('span').firstChild.textContent = 'Tap again to remove'; return; }
    const id = current.id, name = current.model.name, all = saved(), kept = all[id];
    delete all[id]; write(MODELS, all);
    app.closeSheet(() => {
      location.replace('#build'); // in the removed model's place, so Back doesn't come back to it
      toast('Removed ' + name, false, { label: 'Undo', run: () => {
        const now = saved(); now[id] = kept; write(MODELS, now);
        app.refresh(); toast(name + ' is back');
      } });
    });
  };
};

function partsSheet() {
  const { res, pool } = current;
  const rows = Object.keys(res.used).sort((a, b) => partName(a.split('/')[0]).localeCompare(partName(b.split('/')[0])) || a.localeCompare(b));
  app.openSheet('<div class="hd"><h2 id="sheetTitle">All the pieces</h2><button class="btn sm quiet" type="button" data-close>Close</button></div><div class="bd">' +
    '<ul class="need wide">' + rows.map(k => {
      const [p, c] = k.split('/'), col = colorOf(c), have = pool ? pool[k] || 0 : null, need = res.used[k];
      return '<li' + (have !== null && have < need ? ' class="short"' : '') + '><i style="background:' + col.hex + (col.alpha ? ';opacity:.6' : '') + '"></i><span><b>' + need + '×</b> ' + esc(partName(p)) +
        '<small>' + esc(col.name) + ' · ' + p + (have === null ? '' : ' · you have ' + have) + '</small></span></li>';
    }).join('') + '</ul></div>');
}

// ---------- 3D ----------
const PLATE = 0.4; // a plate is 0.4 studs tall (3.2 mm against 8 mm)
let renderer = null, scene, camera, controls, meshes = [], running = false, anims = [];
// The picture is drawn only when it has changed: `dirty` says it has, and `raf` is the one frame asked for (0 for
// none). It used to be drawn sixty times a second whatever happened, by one more loop for every model opened
// over another.
let raf = 0, dirty = false;
function redraw() { dirty = true; wake(); }
function wake() { if (running && !raf) raf = requestAnimationFrame(loop); }
let view = null; // { box, centre, radius: the model's bounds, moved: the person has turned or zoomed the picture }
// Seen from the front right and a little above, like a set's instructions.
const LOOK = new THREE.Vector3(0.62, 0.55, 0.85).normalize();
// Frames with no glass in them: the fence (bars) and the door frame (an empty opening). The rest are windows.
const FENCE = '15332', OPEN = [FENCE, '60596'];
const mats = {}, geos = {}, lines = {}, studs = {}, panes = {}; // made once for each colour or part, and kept

function startStage() {
  const canvas = $('stage');
  if (!renderer) {
    try { renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true }); }
    catch (e) { $('stage-hint').textContent = 'This browser can’t show 3D here. The steps below still list every piece.'; return; }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    scene = new THREE.Scene();
    scene.add(new THREE.HemisphereLight(0xffffff, 0x8a7f70, 1.9));
    const sun = new THREE.DirectionalLight(0xffffff, 2.2); sun.position.set(6, 12, 9); scene.add(sun);
    const fill = new THREE.DirectionalLight(0xffffff, 0.6); fill.position.set(-8, 4, -6); scene.add(fill);
    camera = new THREE.PerspectiveCamera(28, 1, 0.1, 500);
    controls = new OrbitControls(camera, canvas);
    controls.enableDamping = true;
    controls.enablePan = false;
    controls.maxPolarAngle = Math.PI * 0.52; // stops just under the horizon: from below a model is a blank slab
    controls.addEventListener('change', redraw);
    controls.addEventListener('start', movedIt);
    canvas.addEventListener('keydown', turnKeys);
    $('stage-reset').onclick = () => {
      // With damping off for one update, whatever was left of a flick is spent before the camera is put back.
      controls.enableDamping = false; controls.update(); controls.enableDamping = true;
      view.moved = false; $('stage-reset').hidden = true;
      frame();
    };
    new ResizeObserver(resize).observe(canvas);
    // A phone can take the picture away (the tab left in the background, memory running short). The browser brings
    // it back by itself; until then the stage says so, where it was a blank box with a sad face.
    canvas.addEventListener('webglcontextlost', () => {
      const h = $('stage-hint');
      if (!dropped) dropped = { text: h.textContent, hidden: h.hidden };
      h.textContent = 'The picture was dropped. It comes back by itself, or reload.'; h.hidden = false;
    });
    canvas.addEventListener('webglcontextrestored', () => {
      const h = $('stage-hint');
      if (dropped) { h.textContent = dropped.text; h.hidden = dropped.hidden; dropped = null; }
      redraw();
    });
  }
  running = true;
  resize();
  redraw();
  // "Drag to turn" has been read after a few seconds, and sits on the front of a model that fills the stage.
  if (!hintTimer && !$('stage-hint').hidden) hintTimer = setTimeout(hideHint, 4000);
}
let dropped = null, hintTimer = 0; // the hint as it was before "The picture was dropped" took its place
function hideHint(now) {
  const h = $('stage-hint');
  if (dropped) dropped.hidden = true;
  else if (now === true) h.hidden = true;
  else if (!h.hidden) { h.classList.add('going'); setTimeout(() => { h.classList.remove('going'); if (!dropped) h.hidden = true; }, 500); } // it fades (css/app.css)
}
// The person has turned or zoomed the picture: the hint has done its job, and Reset view shows.
function movedIt() {
  hideHint(true);
  if (view) { view.moved = true; $('stage-reset').hidden = false; }
}
// With the picture focused, the arrow keys turn it and + and - zoom, so a keyboard can look round a model too.
function turnKeys(e) {
  if (!view || e.altKey || e.ctrlKey || e.metaKey) return;
  // The model goes the way the arrow points, as it follows a finger: right turns it to the right, up tips it up.
  const turn = { ArrowLeft: [1, 0], ArrowRight: [-1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] }[e.key], zoom = { '+': 0.8, '=': 0.8, '-': 1.25, _: 1.25 }[e.key];
  if (!turn && !zoom) return;
  e.preventDefault();
  const off = camera.position.clone().sub(controls.target), at = new THREE.Spherical().setFromVector3(off);
  if (turn) {
    at.theta += turn[0] * Math.PI / 12; // 15 degrees a press
    at.phi = Math.max(0.05, Math.min(controls.maxPolarAngle, at.phi + turn[1] * Math.PI / 18));
  } else at.radius = Math.max(controls.minDistance, Math.min(controls.maxDistance, at.radius * zoom));
  camera.position.copy(controls.target).add(off.setFromSpherical(at));
  controls.update();
  movedIt();
  redraw();
}
function stopStage() {
  running = false; anims = [];
  if (raf) cancelAnimationFrame(raf);
  raf = 0;
}
function resize() {
  if (!renderer) return;
  const c = renderer.domElement, w = c.clientWidth, h = c.clientHeight;
  if (!w || !h) return;
  renderer.setSize(w, h, false);
  camera.aspect = w / h; camera.updateProjectionMatrix();
  if (view && !view.moved) frame(); // a turned phone or a resized window fits the model again, until it's been moved
  redraw(); // a new size clears the picture
}
function loop(t) {
  raf = 0;
  if (!running) return;
  const moving = anims.length > 0;
  anims = anims.filter(a => {
    const k = Math.max(0, Math.min(1, (t - a.t0) / 320));
    a.obj.position.y = a.y + (1 - k) * (1 - k) * 2.4;
    return k < 1;
  });
  // While a turn or a zoom is still easing out, this moves the camera and says so ('change'), which asks for the
  // next frame; once it has settled nothing does, and the loop sleeps until something changes.
  controls.update();
  if (dirty || moving) { dirty = false; renderer.render(scene, camera); }
  if (anims.length) wake();
}

function material(c) {
  if (mats[c]) return mats[c];
  const col = colorOf(c);
  return (mats[c] = new THREE.MeshStandardMaterial({ color: col.hex, roughness: 0.38, metalness: 0, transparent: !!col.alpha, opacity: col.alpha || 1 }));
}
const edgeMat = new THREE.LineBasicMaterial({ color: 0x1c1712, transparent: true, opacity: 0.32 });
const glassMat = new THREE.MeshStandardMaterial({ color: 0xcfe6f5, roughness: 0.1, transparent: true, opacity: 0.35 });
const studGeo = new THREE.CylinderGeometry(0.3, 0.3, 0.2, 20);
const eyeGeo = new THREE.CylinderGeometry(0.17, 0.17, 0.02, 16);
const eyeMat = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.5 });

function box(w, h, d, x, y, z) { const g = new THREE.BoxGeometry(w, h, d); g.translate(x + w / 2, y + h / 2, z + d / 2); return g; }
function profile(sh, pts) {
  const shape = new THREE.Shape(pts.map(([z, y]) => new THREE.Vector2(z, y)));
  const g = new THREE.ExtrudeGeometry(shape, { depth: sh.w - 0.04, bevelEnabled: false, curveSegments: 12 });
  g.rotateY(-Math.PI / 2); g.translate(sh.w - 0.02, 0, 0);
  return g;
}

// The body of one part in its own frame: x 0..w, y 0..height, z 0..d, its high side (for slopes) at the back.
function bodies(p) {
  if (geos[p]) return geos[p];
  const sh = shapes[p], H = sh.h * PLATE - 0.01, w = sh.w, d = sh.d, e = 0.02, out = [];
  const low = (sh.low || 0) * PLATE, flat = sh.flat || 0;
  switch (sh.k) {
    case 'round': case 'rtile': {
      const g = new THREE.CylinderGeometry(w / 2 - 0.04, w / 2 - 0.04, H, 28); g.translate(w / 2, H / 2, d / 2); out.push(g); break;
    }
    case 'cone': {
      const g = new THREE.CylinderGeometry(0.3, 0.47, H, 28); g.translate(0.5, H / 2, 0.5); out.push(g); break;
    }
    case 'slope': out.push(profile(sh, [[e, 0], [d - e, 0], [d - e, Math.max(low, 0.05)], [Math.max(flat, e), H], [e, H]])); break;
    case 'curve': {
      const pts = [[e, 0], [d - e, 0]];
      for (let i = 0; i <= 12; i++) { const a = (i / 12) * Math.PI / 2; pts.push([flat + (d - e - flat) * Math.cos(a), low + (H - low) * Math.sin(a)]); }
      pts.push([e, H]);
      out.push(profile(sh, pts)); break;
    }
    case 'inv': out.push(profile(sh, [[e, 0], [Math.max(flat, e), 0], [d - e, H - Math.max(low, 0.05)], [d - e, H], [e, H]])); break;
    case 'arch':
      out.push(box(1 - e * 2, H, d - e * 2, e, 0, e), box(1 - e * 2, H, d - e * 2, w - 1 + e, 0, e), box(w - e * 2, PLATE * (sh.lintel || 1), d - e * 2, e, H - PLATE * (sh.lintel || 1), e));
      break;
    case 'frame':
      out.push(box(w - e * 2, PLATE, d - e * 2, e, 0, e), box(w - e * 2, PLATE, d - e * 2, e, H - PLATE, e),
        box(0.22, H, d - e * 2, e, 0, e), box(0.22, H, d - e * 2, w - 0.22 - e, 0, e));
      // A fence has bars where a window has glass: a thin upright at each stud line between its ends.
      if (p === FENCE) for (let x = 1; x < w; x++) out.push(box(0.12, H - PLATE * 2, 0.3, x - 0.06, PLATE, d / 2 - 0.15));
      break;
    default: out.push(box(w - e * 2, H, d - e * 2, e, 0, e));
  }
  return (geos[p] = out);
}

// The dark lines along a part's edges, the glass in a frame, and all of a part's studs as one shape: each made once
// for a part number and shared by every one of that part in every model, so opening models doesn't pile them up
// (a set of lines for each piece and a pane for each window used to be made on every open and never let go), and
// a part's studs are one thing to draw, not one each (a 16x16 plate was 257 things to draw).
function edgesOf(p) { return lines[p] || (lines[p] = bodies(p).map(g => new THREE.EdgesGeometry(g, 28))); }
function paneOf(p) {
  if (panes[p]) return panes[p];
  const sh = shapes[p], g = new THREE.BoxGeometry(sh.w - 0.44, sh.h * PLATE - PLATE * 2, 0.06);
  g.translate(sh.w / 2, sh.h * PLATE / 2, sh.d / 2);
  return (panes[p] = g);
}
function studsOf(p) {
  if (p in studs) return studs[p];
  const sh = shapes[p], top = sh.top === 'none' ? [] : sh.top === 'all' || !sh.top ? cellsOf(sh) : sh.top;
  if (!top.length) return (studs[p] = null);
  const one = studGeo.toNonIndexed(), pos = one.attributes.position.array, nor = one.attributes.normal.array, n = pos.length;
  const P = new Float32Array(n * top.length), N = new Float32Array(n * top.length), y = sh.h * PLATE + 0.1 - 0.01;
  top.forEach(([cx, cz], k) => {
    for (let i = 0; i < n; i += 3) { P[k * n + i] = pos[i] + cx + 0.5; P[k * n + i + 1] = pos[i + 1] + y; P[k * n + i + 2] = pos[i + 2] + cz + 0.5; }
    N.set(nor, k * n);
  });
  one.dispose();
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(P, 3)); g.setAttribute('normal', new THREE.BufferAttribute(N, 3));
  return (studs[p] = g);
}

function partObject(q) {
  const [p, c, x, y, z, r] = q, sh = shapes[p];
  const inner = new THREE.Group();
  const mat = material(c);
  bodies(p).forEach((g, i) => {
    inner.add(new THREE.Mesh(g, mat));
    inner.add(new THREE.LineSegments(edgesOf(p)[i], edgeMat));
  });
  if (sh.k === 'frame' && !OPEN.includes(p)) inner.add(new THREE.Mesh(paneOf(p), glassMat));
  if (studsOf(p)) inner.add(new THREE.Mesh(studsOf(p), mat));
  if (p === '98138p07' || p === '98138p0c') {
    const eye = new THREE.Mesh(eyeGeo, eyeMat); eye.position.set(0.5, sh.h * PLATE, 0.5);
    if (p === '98138p0c') eye.scale.set(1, 1, 0.25);
    inner.add(eye);
  }
  const size = B.turnSize(sh, r);
  inner.position.set(-sh.w / 2, 0, -sh.d / 2);
  const outer = new THREE.Group();
  outer.add(inner);
  outer.rotation.y = -r * Math.PI / 180;
  outer.position.set(x + size.w / 2, y * PLATE, z + size.d / 2);
  return outer;
}
function cellsOf(sh) { const a = []; for (let i = 0; i < sh.w; i++) for (let j = 0; j < sh.d; j++) a.push([i, j]); return a; }

function buildScene(model) {
  if (!renderer) return;
  meshes.forEach(m => scene.remove(m.obj));
  meshes = model.parts.map(q => shapes[q[0]] ? { q, obj: partObject(q) } : null).filter(Boolean);
  meshes.forEach(m => { m.obj.visible = false; m.y = m.obj.position.y; scene.add(m.obj); });
  const box = new THREE.Box3();
  meshes.forEach(m => { m.obj.visible = true; box.expandByObject(m.obj); });
  if (box.isEmpty()) box.set(new THREE.Vector3(-4, 0, -4), new THREE.Vector3(4, 4, 4)); // nothing to draw
  view = { box, centre: box.getCenter(new THREE.Vector3()), radius: box.getSize(new THREE.Vector3()).length() / 2, moved: false };
  $('stage-reset').hidden = true;
  frame();
  redraw();
}

// The eight corners of the model's bounds.
function corners() {
  const { min, max } = view.box, out = [];
  for (let i = 0; i < 8; i++) out.push(new THREE.Vector3(i & 1 ? max.x : min.x, i & 2 ? max.y : min.y, i & 4 ? max.z : min.z));
  return out;
}
// Puts the camera where the whole model shows, as large as the stage allows: the nearest place along LOOK from
// which every corner of its bounds is inside the picture, across as well as up and down. (It was fitted to the
// picture's height alone, so on a phone, where the stage is narrower than it is tall, a wide model ran off both
// sides.) FILL is the share of the picture the model may take, which leaves a margin round it.
const FILL = 0.9;
function frame() {
  const right = new THREE.Vector3(0, 1, 0).cross(LOOK).normalize(), up = LOOK.clone().cross(right);
  const tv = Math.tan(camera.fov * Math.PI / 360) * FILL, th = tv * camera.aspect;
  let dist = 0;
  corners().forEach(p => {
    const v = p.sub(view.centre), along = v.dot(LOOK);
    dist = Math.max(dist, along + Math.abs(v.dot(right)) / th, along + Math.abs(v.dot(up)) / tv);
  });
  controls.target.copy(view.centre);
  camera.position.copy(view.centre).addScaledVector(LOOK, dist);
  // No nearer than just outside the model, and no further than three times where it starts.
  controls.minDistance = Math.min(view.radius * 1.2, dist * 0.6); controls.maxDistance = dist * 3;
  camera.near = dist / 100; camera.far = dist * 10; camera.updateProjectionMatrix();
  controls.update();
}
// Where the model's bounds fall on the picture, as [left, top, right, bottom] in shares of its width and height
// (0 to 1 is inside), and how far round from straight above the camera is, in half turns.
function inView() {
  if (!renderer || !view) return null;
  camera.updateMatrixWorld();
  const r = [Infinity, Infinity, -Infinity, -Infinity];
  corners().forEach(p => {
    p.project(camera);
    const x = (p.x + 1) / 2, y = (1 - p.y) / 2;
    r[0] = Math.min(r[0], x); r[1] = Math.min(r[1], y); r[2] = Math.max(r[2], x); r[3] = Math.max(r[3], y);
  });
  let panes = 0;
  scene.traverse(o => { if (o.material === glassMat) panes++; });
  return { box: r, polar: controls.getPolarAngle() / Math.PI, moved: view.moved, panes };
}

function showUpTo(step, animate) {
  if (!renderer) return;
  const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  anims = [];
  meshes.forEach(m => {
    const s = m.q[6];
    m.obj.visible = s <= step;
    m.obj.position.y = m.y;
    if (animate && !still && s === step) anims.push({ obj: m.obj, y: m.y, t0: performance.now() });
  });
  redraw();
}

if (!$('build').hidden) route();
