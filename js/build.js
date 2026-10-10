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

// ---------- data ----------
// The site fetches parts/…; the single-file preview carries the same files in window.BRICKYARD_DATA.
const DATA = window.BRICKYARD_DATA || null;
const cache = {};
function get(path) {
  if (DATA) return DATA[path] ? Promise.resolve(DATA[path]) : Promise.reject(new Error('missing ' + path));
  if (!cache[path]) cache[path] = fetch(path).then(r => { if (!r.ok) throw new Error(path + ' ' + r.status); return r.json(); });
  return cache[path];
}
let shapes = null, colors = null, index = null;
const ready = Promise.all([get('parts/shapes.json'), get('parts/colors.json'), get('parts/index.json')])
  .then(([s, c, i]) => { shapes = s; colors = c; index = i; });

// Sets in My sets that Brickyard has a parts list for. Taken-apart sets count by default; the toggles override.
function poolSets() {
  const prefs = read(POOL, {});
  return Object.values(app.doc().sets).filter(x => !x.del && x.num && index[x.num])
    .map(x => ({ id: x.id, num: x.num, name: x.name || 'Set ' + x.num.replace(/-1$/, ''), pieces: index[x.num], state: x.state,
      on: x.id in prefs ? prefs[x.id] : x.state === 'apart' }));
}
function missingLists() {
  return Object.values(app.doc().sets).filter(x => !x.del && x.num && !index[x.num]).length;
}
// Lots of loose pieces (from a scanner, or a list from Claude). They count unless unticked.
function poolLots() {
  const prefs = read(POOL, {});
  return Object.values(app.doc().loose || {}).filter(x => !x.del)
    .map(x => ({ id: x.id, name: x.name, box: x.box || '', parts: x.parts, kinds: x.parts.length,
      pieces: x.parts.reduce((n, r) => n + r[2], 0), usable: x.parts.reduce((n, r) => n + (shapes[r[0]] ? r[2] : 0), 0),
      on: x.id in prefs ? prefs[x.id] : true }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}
async function currentPool() {
  const on = poolSets().filter(s => s.on), lots = poolLots().filter(l => l.on);
  const invs = await Promise.all(on.map(s => get('parts/sets/' + s.num + '.json')));
  return { sets: on, lots, any: on.length + lots.length > 0, pool: B.poolOf(invs.concat(lots)),
    pieces: on.reduce((n, s) => n + s.pieces, 0) + lots.reduce((n, l) => n + l.pieces, 0) };
}

// Models are kept in this browser, keyed by their content, so opening the same link twice keeps one copy.
function hashOf(t) { let h = 2166136261 >>> 0; for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h.toString(36); }
function saved() { return read(MODELS, {}); }
function saveModel(m) {
  const id = 'm' + hashOf(JSON.stringify(m.parts));
  const all = saved();
  if (!all[id]) { all[id] = { model: m, added: Date.now() }; write(MODELS, all); }
  return id;
}
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

// ---------- screens ----------
let current = null; // { id, model, res, steps, at }

async function route() {
  const h = location.hash;
  if ($('build').hidden) { stopStage(); return; }
  await ready;
  if (/^#d1[zj]/.test(h)) {
    try {
      const m = await B.parseModel(h);
      const id = saveModel(m);
      history.replaceState(null, '', location.pathname + location.search + '#model-' + id);
      return openModel(id);
    } catch (e) {
      toast(e && /browser/.test(e.message) ? e.message : 'That link doesn’t hold a model Brickyard can read');
      history.replaceState(null, '', location.pathname + location.search + '#build');
    }
  }
  if (h.startsWith('#model-')) return openModel(h.slice(7));
  return renderList();
}
document.addEventListener('brickyard:route', route);

async function renderList() {
  stopStage();
  current = null;
  $('build-title').textContent = 'Build from your box';
  $('build-back').setAttribute('href', '#');
  $('model-menu').hidden = true;
  $('model-view').hidden = true;
  $('build-list').hidden = false;
  const sets = poolSets(), on = sets.filter(s => s.on), none = missingLists(), lots = poolLots();
  const { pool, pieces, any } = await currentPool();

  let html = '<section class="pieces"><h2 class="group"><span>Your pieces</span><span>' + (pieces ? pieces.toLocaleString() : '') + '</span></h2>';
  if (!sets.length && !lots.length) {
    html += '<div class="how"><p style="margin:0 0 10px">Brickyard builds from the sets in My sets that are taken apart. Your Large Creative Brick Box isn’t in My sets yet.</p>' +
      '<button class="btn" type="button" id="add-box">Add the Large Creative Brick Box</button></div>';
  } else {
    html += '<ul class="menu pool">' + sets.map(s => '<li><label><input type="checkbox" data-pool="' + esc(s.id) + '"' + (s.on ? ' checked' : '') + '>' +
      '<span>' + esc(s.name) + '<small>' + esc(s.num.replace(/-1$/, '')) + ' · ' + plural(s.pieces, 'piece') + (s.state === 'apart' ? '' : s.state === 'built' ? ' · built, so off unless you take it apart' : '') + '</small></span></label></li>').join('') +
      lots.map(l => '<li class="lot"><label><input type="checkbox" data-pool="' + esc(l.id) + '"' + (l.on ? ' checked' : '') + '>' +
        '<span>' + esc(l.name) + '<small>Loose · ' + plural(l.pieces, 'piece') + (l.box ? ' · box ' + esc(l.box) : '') +
        (l.usable < l.pieces ? ' · the builder can use ' + l.usable.toLocaleString() : '') + '</small></span></label>' +
        '<button class="btn sm quiet" type="button" data-lot="' + esc(l.id) + '" aria-label="Remove ' + esc(l.name) + '">Remove</button></li>').join('') + '</ul>';
    if (!any) html += '<p class="flag"><span>Tick a set or a lot to build from its pieces.</span></p>';
  }
  if (none) html += '<p class="note">' + (none === 1 ? 'One of your sets doesn’t' : none + ' of your sets don’t') + ' have a parts list here yet. Tell Claude which ones you’ve taken apart and it can add their pieces.</p>';
  html += '<div class="acts-row"><button class="btn quiet" type="button" id="copy-pool"' + (any ? '' : ' disabled') + '>Copy my pieces for Claude</button><button class="btn quiet" type="button" id="open-model">Open a model</button></div></section>';

  const mine = Object.entries(saved()).sort((a, b) => b[1].added - a[1].added).map(([id, v]) => ({ id, model: B.cleanModel(v.model) })).filter(x => x.model);
  const examples = await Promise.all(EXAMPLES.map(async n => ({ id: 'x-' + n, model: await modelById('x-' + n), example: true })));
  const rows = mine.concat(examples);
  html += '<h2 class="group"><span>Models</span><span>' + rows.length + '</span></h2><ul class="list">' + rows.map(r => {
    const res = B.check(r.model, shapes, any ? pool : null);
    const shortBy = res.short.reduce((n, x) => n + (x.need - x.have), 0);
    const other = res.problems.filter(p => p.kind !== 'count').length;
    // With no pieces chosen there's nothing to count against, so only a broken model gets a badge.
    const state = other ? '<span class="badge sealed">Needs fixing</span>' : !any ? '' : shortBy ? '<span class="badge partial">' + shortBy + ' short</span>' : '<span class="badge built">Can build</span>';
    return '<li><a class="item" href="#model-' + esc(r.id) + '">' + swatchStack(r.model) +
      '<div class="main"><div class="t">' + esc(r.model.name) + (r.example ? ' <span class="m" style="display:inline">· example</span>' : '') + '</div>' +
      '<div class="m">' + plural(res.pieces, 'piece') + ' · ' + plural(res.steps.length, 'step') + '</div></div>' + state + '</a></li>';
  }).join('') + '</ul>' +
    '<div class="how" style="margin-top:14px"><b>Get a new model from Claude</b><ol><li>Tap <b>Copy my pieces for Claude</b>.</li><li>Paste it to Claude and say what you’d like: “a lighthouse”, “something for the new house”.</li>' +
    '<li>Claude designs it from those pieces only, checks it can really be built, and sends a link. Open it here.</li></ol></div>';
  $('build-list').innerHTML = html;

  if ($('add-box')) $('add-box').onclick = () => { app.addSet(BOX); toast('Added to My sets as taken apart'); renderList(); };
  $('build-list').querySelectorAll('[data-pool]').forEach(cb => cb.onchange = () => {
    const prefs = read(POOL, {}); prefs[cb.dataset.pool] = cb.checked; write(POOL, prefs); renderList();
  });
  $('build-list').querySelectorAll('[data-lot]').forEach(b => b.onclick = () => dropLot(lots.find(l => l.id === b.dataset.lot)));
  $('copy-pool').onclick = copyPool;
  $('open-model').onclick = openSheet;
}
document.addEventListener('brickyard:changed', () => { if (!$('build').hidden && !$('build-list').hidden) renderList(); });

function dropLot(l) {
  if (!l) return;
  const panel = app.openSheet('<div class="hd"><h2 id="sheetTitle">Remove these loose pieces?</h2><button class="btn sm quiet" type="button" data-close>Keep them</button></div>' +
    '<div class="bd"><p class="lede"><b>' + esc(l.name) + '</b> · ' + plural(l.pieces, 'piece') + '</p><p class="note">They leave Your pieces. Your sets aren’t touched, and opening the lot’s link or file again brings it back.</p></div>' +
    '<div class="ft"><span></span><button class="btn" type="button" id="lot-drop">Remove</button></div>');
  panel.querySelector('[data-close]').onclick = app.closeSheet;
  $('lot-drop').onclick = () => { app.removeLot(l.id); app.closeSheet(); toast('Removed ' + l.name); renderList(); };
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
    const panel = app.openSheet('<div class="hd"><h2 id="sheetTitle">Your pieces for Claude</h2><button class="btn sm quiet" type="button" data-close>Close</button></div>' +
      '<div class="bd"><p class="note">Copy this and paste it to Claude.</p><textarea class="paste" id="pool-text" readonly style="min-height:200px">' + esc(text) + '</textarea></div>');
    panel.querySelector('[data-close]').onclick = app.closeSheet;
    $('pool-text').select();
  }
}

function openSheet() {
  const panel = app.openSheet('<div class="hd"><h2 id="sheetTitle">Open a model</h2><button class="btn sm quiet" type="button" data-close>Close</button></div><div class="bd">' +
    '<p class="note">Paste the link or the file Claude sent.</p><textarea class="paste" id="model-paste" aria-label="Paste a model link or file" placeholder="https://brickyard.junkdrawer.works/#d1z…"></textarea></div>' +
    '<div class="ft"><span></span><button class="btn" type="button" id="model-go">Open</button></div>');
  panel.querySelector('[data-close]').onclick = app.closeSheet;
  $('model-go').onclick = async () => {
    try {
      const m = await B.parseModel($('model-paste').value);
      const id = saveModel(m); app.closeSheet(); location.hash = '#model-' + id;
    } catch (e) { toast('That doesn’t look like a model from Claude'); }
  };
}

// ---------- one model ----------
async function openModel(id) {
  const model = await modelById(id);
  if (!model) { toast('That model isn’t here any more'); location.hash = '#build'; return; }
  const { pool, sets, any } = await currentPool();
  const res = B.check(model, shapes, any ? pool : null);
  current = { id, model, res, steps: res.steps, at: 0, pool: any ? pool : null, sets };
  $('build-title').textContent = model.name;
  $('build-back').setAttribute('href', '#build');
  $('model-menu').hidden = false;
  $('build-list').hidden = true;
  $('model-view').hidden = false;
  $('model-about').textContent = model.about;
  $('step-range').max = String(current.steps.length);
  renderCheck();
  startStage();
  buildScene(model);
  showStep(0, false);
}

function renderCheck() {
  const { res, pool, sets } = current;
  let html = '';
  const fails = res.problems.filter(p => p.kind !== 'count');
  if (fails.length) html += '<div class="flag bad"><span><b>This model can’t be built as it is.</b> ' + fails.slice(0, 4).map(p => esc(p.text)).join('. ') + '. Ask Claude to fix it.</span></div>';
  if (!pool) html += '<div class="flag"><span>Brickyard doesn’t know which pieces you have yet, so it can’t check you have enough. Choose them under Your pieces on the list of models.</span></div>';
  else if (res.short.length) {
    html += '<div class="flag"><span><b>You’re short:</b> ' + res.short.map(x => {
      const [p, c] = x.key.split('/');
      return (x.need - x.have) + ' × ' + esc(colorOf(c).name) + ' ' + esc(partName(p).toLowerCase());
    }).join(', ') + '. Swap colours where it doesn’t matter, or ask Claude for another version.</span></div>';
  } else if (!fails.length) html += '<p class="note ok">✓ You have every piece for this, from ' + esc(sets.map(s => s.name).join(' and ')) + '.</p>';
  const cm = B.sizeCm(res.size);
  html += '<p class="note">' + plural(res.pieces, 'piece') + ' · ' + plural(res.steps.length, 'step') + ' · about ' + cm.w.toFixed(1).replace(/\.0$/, '') + ' × ' + cm.d.toFixed(1).replace(/\.0$/, '') + ' cm, ' + cm.h.toFixed(1).replace(/\.0$/, '') + ' cm tall</p>';
  $('model-check').innerHTML = html;
}

// Step k of the list (0-based); one past the last step shows the finished model.
function showStep(k, animate = true) {
  const n = current.steps.length;
  current.at = Math.max(0, Math.min(n, k));
  const done = current.at === n, step = done ? Infinity : current.steps[current.at];
  $('step-n').textContent = done ? 'Done' : 'Step ' + (current.at + 1);
  $('step-of').textContent = done ? ' · ' + plural(current.res.pieces, 'piece') : ' of ' + n;
  $('step-prev').disabled = current.at === 0;
  $('step-next').textContent = done ? 'From the start' : current.at === n - 1 ? 'Finish' : 'Next';
  $('step-range').value = String(current.at);

  const here = current.model.parts.map((q, i) => ({ q, i })).filter(x => x.q[6] === step);
  const groups = {};
  here.forEach(({ q }) => { const k2 = q[0] + '/' + q[1]; groups[k2] = (groups[k2] || 0) + 1; });
  const shortKeys = new Set(current.res.short.map(x => x.key));
  $('step-parts').innerHTML = done
    ? '<p class="note" style="margin:0">That’s the whole model. Drag it around to look it over.</p>'
    : '<div class="lbl">Find these</div><ul class="need">' + Object.keys(groups).map(k2 => {
      const [p, c] = k2.split('/'), col = colorOf(c);
      return '<li' + (shortKeys.has(k2) ? ' class="short"' : '') + '><i style="background:' + col.hex + (col.alpha ? ';opacity:.6' : '') + '"></i><span><b>' + groups[k2] + '×</b> ' +
        esc(partName(p)) + '<small>' + esc(col.name) + '</small></span></li>';
    }).join('') + '</ul>';
  showUpTo(step, animate && !done);
}

$('step-prev').onclick = () => showStep(current.at - 1);
$('step-next').onclick = () => showStep(current.at === current.steps.length ? 0 : current.at + 1);
$('step-range').oninput = e => showStep(+e.target.value, false);
document.addEventListener('keydown', e => {
  if (!current || $('model-view').hidden || document.querySelector('.scrim')) return;
  if (e.key === 'ArrowRight') showStep(current.at + 1);
  if (e.key === 'ArrowLeft') showStep(current.at - 1);
});
$('model-menu').onclick = () => {
  const ex = current.id.startsWith('x-');
  const panel = app.openSheet('<div class="hd"><h2 id="sheetTitle">' + esc(current.model.name) + '</h2><button class="btn sm quiet" type="button" data-close>Close</button></div><div class="bd"><ul class="menu">' +
    '<li><button type="button" id="mm-parts"><span>All the pieces<small>Everything this model needs, and what you have</small></span></button></li>' +
    (ex ? '' : '<li><button type="button" id="mm-del"><span>Remove from my models<small>Tap twice. Claude’s link still opens it again.</small></span></button></li>') +
    '</ul></div>');
  panel.querySelector('[data-close]').onclick = app.closeSheet;
  $('mm-parts').onclick = partsSheet;
  if ($('mm-del')) $('mm-del').onclick = function () {
    if (!this.dataset.sure) { this.dataset.sure = '1'; this.querySelector('span').firstChild.textContent = 'Tap again to remove'; return; }
    const all = saved(); delete all[current.id]; write(MODELS, all); app.closeSheet(); location.hash = '#build';
  };
};

function partsSheet() {
  const { res, pool } = current;
  const rows = Object.keys(res.used).sort((a, b) => partName(a.split('/')[0]).localeCompare(partName(b.split('/')[0])) || a.localeCompare(b));
  const panel = app.openSheet('<div class="hd"><h2 id="sheetTitle">All the pieces</h2><button class="btn sm quiet" type="button" data-close>Close</button></div><div class="bd">' +
    '<ul class="need wide">' + rows.map(k => {
      const [p, c] = k.split('/'), col = colorOf(c), have = pool ? pool[k] || 0 : null, need = res.used[k];
      return '<li' + (have !== null && have < need ? ' class="short"' : '') + '><i style="background:' + col.hex + '"></i><span><b>' + need + '×</b> ' + esc(partName(p)) +
        '<small>' + esc(col.name) + ' · ' + p + (have === null ? '' : ' · you have ' + have) + '</small></span></li>';
    }).join('') + '</ul></div>');
  panel.querySelector('[data-close]').onclick = app.closeSheet;
}

// ---------- 3D ----------
const PLATE = 0.4; // a plate is 0.4 studs tall (3.2 mm against 8 mm)
let renderer = null, scene, camera, controls, meshes = [], running = false, anims = [];
const mats = {}, geos = {};

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
    controls.addEventListener('start', () => { $('stage-hint').hidden = true; });
    new ResizeObserver(resize).observe(canvas);
  }
  running = true;
  resize();
  requestAnimationFrame(loop);
}
function stopStage() { running = false; }
function resize() {
  if (!renderer) return;
  const c = renderer.domElement, w = c.clientWidth, h = c.clientHeight;
  if (!w || !h) return;
  renderer.setSize(w, h, false);
  camera.aspect = w / h; camera.updateProjectionMatrix();
}
function loop(t) {
  if (!running) return;
  anims = anims.filter(a => {
    const k = Math.min(1, (t - a.t0) / 320);
    a.obj.position.y = a.y + (1 - k) * (1 - k) * 2.4;
    return k < 1;
  });
  controls.update();
  renderer.render(scene, camera);
  requestAnimationFrame(loop);
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
      break;
    default: out.push(box(w - e * 2, H, d - e * 2, e, 0, e));
  }
  return (geos[p] = out);
}

function partObject(q) {
  const [p, c, x, y, z, r] = q, sh = shapes[p];
  const inner = new THREE.Group();
  const mat = material(c);
  bodies(p).forEach(g => {
    inner.add(new THREE.Mesh(g, mat));
    inner.add(new THREE.LineSegments(new THREE.EdgesGeometry(g, 28), edgeMat));
  });
  if (sh.k === 'frame') {
    const pane = new THREE.Mesh(new THREE.BoxGeometry(sh.w - 0.44, sh.h * PLATE - PLATE * 2, 0.06), glassMat);
    pane.position.set(sh.w / 2, sh.h * PLATE / 2, sh.d / 2); inner.add(pane);
  }
  const top = sh.top === 'none' ? [] : sh.top === 'all' || !sh.top ? cellsOf(sh) : sh.top;
  top.forEach(([cx, cz]) => { const s = new THREE.Mesh(studGeo, mat); s.position.set(cx + 0.5, sh.h * PLATE + 0.1 - 0.01, cz + 0.5); inner.add(s); });
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
  // Frame the whole model, seen from the front right and a little above, like a set's instructions.
  const bounds = new THREE.Box3();
  meshes.forEach(m => { m.obj.visible = true; bounds.expandByObject(m.obj); });
  const centre = bounds.getCenter(new THREE.Vector3()), radius = bounds.getSize(new THREE.Vector3()).length() / 2 || 4;
  const dist = radius / Math.sin((camera.fov * Math.PI / 180) / 2) * 1.02;
  controls.target.copy(centre);
  camera.position.copy(centre).add(new THREE.Vector3(0.62, 0.55, 0.85).normalize().multiplyScalar(dist));
  controls.minDistance = radius * 0.8; controls.maxDistance = dist * 3;
  camera.near = dist / 100; camera.far = dist * 10; camera.updateProjectionMatrix();
  controls.update();
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
}

if (!$('build').hidden) route();
