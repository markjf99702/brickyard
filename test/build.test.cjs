// Checks the "Build from your box" logic: turning parts, the build checks, links, and that the designer
// skill's script agrees with the page. Run with: node test/build.test.cjs   (no dependencies; Node 18 or later)
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const mod = { exports: {} };
new Function('module', fs.readFileSync(path.join(root, 'js/build-core.js'), 'utf8'))(mod);
const B = mod.exports;
const json = f => JSON.parse(fs.readFileSync(path.join(root, f), 'utf8'));
const shapes = json('parts/shapes.json'), colors = json('parts/colors.json'), index = json('parts/index.json');
const box = json('parts/sets/10698-1.json'), pool = B.poolOf([box]);

let failed = 0, passed = 0;
function check(ok, what) { if (ok) passed++; else { failed++; console.log('  FAIL ' + what); } }
function eq(a, b, what) { const x = JSON.stringify(a), y = JSON.stringify(b); check(x === y, what + (x === y ? '' : '\n    got  ' + x + '\n    want ' + y)); }
const kinds = res => res.problems.map(p => p.kind).sort();

// The data files hang together.
eq(Object.keys(index), ['10698-1'], 'one parts list so far');
eq(box.parts.reduce((n, r) => n + r[2], 0), index['10698-1'], 'index counts the 10698 pieces');
check(Object.values(shapes).every(s => s.n && s.w > 0 && s.d > 0 && s.h > 0 && s.k), 'every shape has a name, size and kind');
check(box.parts.every(r => colors[String(r[1])]), 'every 10698 colour has a name and hex');
// The designer skill is uploaded to Claude on its own, so it carries a copy of parts/ in its data/ folder.
const skill = path.join(root, 'skill/brickyard-designer');
const filesIn = dir => { try { return fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter(f => f.isFile()).map(f => path.relative(dir, path.join(f.parentPath || f.path, f.name)).split(path.sep).join('/')).sort(); } catch (e) { return []; } };
eq(filesIn(path.join(skill, 'data')), filesIn(path.join(root, 'parts')), 'the skill’s data/ has the files parts/ has (run node tools/copy-skill-data.mjs)');
for (const f of filesIn(path.join(root, 'parts'))) {
  let copy = null; try { copy = fs.readFileSync(path.join(skill, 'data', f)); } catch (e) { /* missing: reported above */ }
  check(copy && copy.equals(fs.readFileSync(path.join(root, 'parts', f))), 'the skill’s data/' + f + ' is parts/' + f + ' (run node tools/copy-skill-data.mjs)');
}

// Turning: a 1x2 brick turned 90 runs front to back, and its cells land inside the turned footprint.
eq(B.turnSize(shapes['3004'], 90), { w: 1, d: 2 }, '1x2 turned 90 is 1 wide, 2 deep');
for (const p of ['3001', '3039', '3004']) for (const r of [0, 90, 180, 270]) {
  const sh = shapes[p], sz = B.turnSize(sh, r), seen = new Set();
  for (let cx = 0; cx < sh.w; cx++) for (let cz = 0; cz < sh.d; cz++) {
    const [x, z] = B.turnCell(sh, r, cx, cz); seen.add(x + ',' + z);
    check(x >= 0 && x < sz.w && z >= 0 && z < sz.d, `${p} r${r} cell ${cx},${cz} inside`);
  }
  eq(seen.size, sh.w * sh.d, `${p} r${r} covers its footprint once`);
}
// A 2x2 slope's studs are at its high back edge; turned 180 they're at the front.
eq(B.placed(shapes['3039'], { x: 0, z: 0, r: 180 }).top.map(String).sort(), ['0,1', '1,1'], 'slope turned 180 has studs at the front');

// Models.
const plate = (x, z, s) => ['3001', 1, x, 0, z, 0, s];
const M = parts => B.cleanModel({ name: 't', parts });
eq(kinds(B.check(M([plate(0, 0, 1), ['3001', 4, 0, 3, 0, 0, 2]]), shapes, null)), [], 'brick on a brick is fine');
eq(kinds(B.check(M([plate(0, 0, 1), ['3001', 4, 1, 0, 0, 0, 2]]), shapes, null)), ['loose', 'overlap'], 'side by side overlapping');
eq(kinds(B.check(M([plate(0, 0, 1), ['3001', 4, 5, 0, 0, 0, 1]]), shapes, null)), ['loose'], 'two bricks not touching');
eq(kinds(B.check(M([plate(0, 0, 1), ['3001', 4, 2, 3, 0, 0, 2], plate(4, 0, 3)]), shapes, null)), [], 'bridge joins two bricks');
eq(kinds(B.check(M([plate(0, 0, 1), plate(4, 0, 2), ['3001', 4, 2, 3, 0, 0, 3]]), shapes, null)), ['order'], 'step 2 has nothing to join to yet');
// A step has to join onto what's built, whatever order the parts are listed in. Two 2x2s side by side in the air
// (steps 1 and 2) with the 2x4 under them last: step 2 joins nothing, listed either way round.
const FLOAT_A = [['3001', 4, 0, 0, 0, 0, 3], ['3003', 4, 2, 3, 0, 0, 2], ['3003', 4, 0, 3, 0, 0, 1]];
const FLOAT_A2 = [FLOAT_A[0], FLOAT_A[2], FLOAT_A[1]];
// A brick on the table, two stacked bricks floating beside it, then the brick that ties them: the two are a bigger
// group than the one they should have joined, and still hang in the air at step 2.
const FLOAT_B = [['3001', 4, 0, 0, 0, 0, 1], ['3001', 1, 6, 3, 0, 0, 2], ['3001', 1, 4, 6, 0, 0, 2], ['3001', 14, 2, 3, 0, 0, 3]];
const FLOAT_B2 = [FLOAT_B[3], FLOAT_B[2], FLOAT_B[1], FLOAT_B[0]];
// Two separate towers the same size: the one listed first is the model.
const TOWERS = [['3001', 4, 0, 0, 0, 0, 1], ['3001', 1, 20, 0, 0, 0, 1], ['3001', 1, 20, 3, 0, 0, 2], ['3001', 4, 0, 3, 0, 0, 2]];
const told = parts => B.check(M(parts), shapes, null).problems.map(p => [p.kind, p.step || 0, p.parts]);
eq(told(FLOAT_A), [['order', 2, [1]]], 'a step-2 part beside the step-1 part joins nothing');
eq(told(FLOAT_A2), [['order', 2, [2]]], 'and the same with the two rows swapped');
eq(told(FLOAT_B), [['order', 2, [1, 2]]], 'two stacked bricks beside the model join nothing, though there are more of them');
eq(told(FLOAT_B2), [['order', 2, [1, 2]]], 'and the same listed backwards');
eq(told(TOWERS), [['loose', 0, [1, 2]]], 'of two towers the same size, the one listed first is the model');
eq(told([['3001', 4, 0, 0, 0, 0, 1], ['3001', 4, 0, 3, 0, 0, 1], ['3001', 1, 4, 0, 0, 0, 1], ['3001', 1, 4, 3, 0, 0, 2], ['3001', 14, 8, 0, 0, 0, 2], ['3001', 14, 8, 3, 0, 0, 2], ['3001', 15, 2, 6, 0, 0, 3], ['3001', 15, 6, 6, 0, 0, 3]]),
  [['order', 1, [2]], ['order', 2, [4, 5]]], 'a first step in two lumps keeps the bigger; later steps may add to either, but not start a third');
eq(kinds(B.check(M([['3001', 1, 0, 0, 0, 0, 1], ['3001', 1, 0, 3, 0, 0, 1]]), shapes, {})), ['count'], 'no pieces, short');
eq(kinds(B.check(M([['zzz', 1, 0, 0, 0, 0, 1]]), shapes, null)), ['part'], 'unknown part');
eq(B.check(M([['3001', 4, 0, 3, 0, 0, 1], plate(0, 0, 2)]), shapes, null).notes.map(n => n.kind), ['under'], 'pushed on from underneath');
eq(B.cleanModel({ parts: [['3001', 1, 0, 3, 0], ['3001', 1, 0, 0, 0]] }).parts.map(q => q[6]), [2, 1], 'no steps: one per height');
eq(B.cleanModel({ parts: [['3001', 1, 0, 0, 0, 45]] }), null, 'turns are whole quarter turns');
check(B.cleanModel({ model: { parts: [{ p: '3001.dat', c: '1', x: 0, y: 0, z: 0 }] } }).parts[0][0] === '3001', 'objects and .dat names work');
// "sets" is a list of set numbers, or one on its own: a single string is one set, not a set per letter.
const one = [['3001', 4, 0, 0, 0, 0, 1]];
const SETS = { string: '10698-1', list: ['10698-1', ' 10696 '], number: [10698], mixed: [null, '10698-1', {}, true, 1.5, ['x'], ''], 'a number alone': 5, object: { a: 1 }, none: null };
const WANT = { string: ['10698-1'], list: ['10698-1', '10696'], number: ['10698'], mixed: ['10698-1'], 'a number alone': [], object: [], none: [] };
for (const k in SETS) eq(B.cleanModel({ sets: SETS[k], parts: one }).sets, WANT[k], 'sets given as ' + k);

// Models made up from a seed, for comparing the page with the script further down: each is built so that it can
// be built (every new part goes onto a stud of an earlier one, or under it, in free space, from the box's pieces,
// steps only going up), then broken in one way.
function seeded(seed) {
  let a = seed;
  const f = () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  return { int: (lo, hi) => lo + Math.floor(f() * (hi - lo + 1)), pick: l => l[Math.floor(f() * l.length)], chance: p => f() < p,
    shuffle: l => { l = l.slice(); for (let i = l.length - 1; i > 0; i--) { const j = Math.floor(f() * (i + 1)); [l[i], l[j]] = [l[j], l[i]]; } return l; } };
}
const inPool = {};
Object.keys(pool).forEach(k => { const [p, c] = k.split('/'); if (shapes[p]) (inPool[p] = inPool[p] || []).push(+c); });
const POOLED = Object.keys(inPool), TURNS = [0, 90, 180, 270];
const cellsOf = q => B.placed(shapes[q[0]], { x: q[2], z: q[4], r: q[5] });
function legalModel(g, size) {
  const left = Object.assign({}, pool), space = {}, parts = [];
  const take = () => { for (let t = 0; t < 30; t++) { const p = g.pick(POOLED), c = g.pick(inPool[p]); if (left[p + '/' + c] > 0) return [p, c]; } return null; };
  const filled = q => { const out = [], foot = cellsOf(q).foot; for (let y = q[3]; y < q[3] + shapes[q[0]].h; y++) foot.forEach(c => out.push(c[0] + ',' + y + ',' + c[1])); return out; };
  const put = q => { filled(q).forEach(k => { space[k] = 1; }); left[q[0] + '/' + q[1]]--; parts.push(q); };
  let step = 1;
  const first = take(); put([first[0], first[1], g.int(-3, 3), g.chance(0.8) ? 0 : g.int(1, 9), g.int(-3, 3), g.pick(TURNS), step]);
  for (let tries = 0; parts.length < size && tries < size * 30; tries++) {
    const pc = take(); if (!pc) break;
    const sh = shapes[pc[0]], base = g.pick(parts), bc = cellsOf(base), r = g.pick(TURNS), below = g.chance(0.12);
    const anchors = below ? bc.bot : bc.top; if (!anchors.length) continue;
    const at = g.pick(anchors);
    // Put the new part at the origin to learn where its sockets (or studs) are, then slide one onto the anchor.
    const probe = cellsOf([pc[0], pc[1], 0, 0, 0, r, 1]), mine = below ? probe.top : probe.bot; if (!mine.length) continue;
    const m = g.pick(mine);
    const q = [pc[0], pc[1], at[0] - m[0], below ? base[3] - sh.h : base[3] + shapes[base[0]].h, at[1] - m[1], r, g.chance(0.4) ? ++step : step];
    if (q[3] < 0 || q[3] > 590 || Math.abs(q[2]) > 190 || Math.abs(q[4]) > 190 || filled(q).some(k => k in space)) continue;
    put(q);
  }
  return { name: 'Seeded', sets: ['10698-1'], parts };
}
const BREAK = {
  nothing: m => m,
  unknownPart: (m, g) => { g.pick(m.parts)[0] = g.pick(['9999', 'zz1', '3001x']); },
  tooMany: (m, g) => { const k = g.pick(Object.keys(pool).filter(k => shapes[k.split('/')[0]])), [p, c] = k.split('/'); for (let i = 0; i <= pool[k]; i++) m.parts.push([p, +c, 60 + (i % 20) * 9, 0, 60 + Math.floor(i / 20) * 9, 0, 1]); },
  overlap: (m, g) => { const q = g.pick(m.parts).slice(); q[6] = g.pick(m.parts)[6]; if (g.chance(0.5)) q[2] += g.pick([0, 1]); m.parts.push(q); },
  floating: (m, g) => { const p = g.pick(POOLED); m.parts.push([p, g.pick(inPool[p]), g.int(40, 60), g.int(0, 30), g.int(40, 60), 0, g.int(1, 5)]);
    if (g.chance(0.5)) { const p2 = g.pick(POOLED); m.parts.push([p2, g.pick(inPool[p2]), -g.int(40, 60), g.int(0, 30), g.int(40, 60), 90, g.int(1, 5)]); } },
  twoTowers: (m, g) => { m.parts.slice(0, g.int(1, m.parts.length)).forEach(q => { const c = q.slice(); c[2] += 80; m.parts.splice(g.int(0, m.parts.length), 0, c); }); },
  shuffleSteps: (m, g) => { const s = g.shuffle(m.parts.map(q => q[6])); m.parts.forEach((q, i) => { q[6] = s[i]; }); },
  earlyStep: (m, g) => { g.pick(m.parts)[6] = 1; g.pick(m.parts)[6] = g.int(1, 3); },
  shuffleParts: (m, g) => { m.parts = g.shuffle(m.parts); },
  nudge: (m, g) => { const q = g.pick(m.parts); q[g.pick([2, 3, 4])] += g.pick([-1, 1, 2, 3]); },
  turn: (m, g) => { g.pick(m.parts)[5] = g.pick(TURNS); },
  noSteps: (m, g) => { m.parts.forEach(q => { if (g.chance(0.5)) q.length = 6; }); },
  soup: (m, g) => { m.parts = Array.from({ length: g.int(2, 14) }, () => [g.pick(Object.keys(shapes)), g.pick([4, 1, 15, 14, 0]), g.int(-2, 4), g.int(0, 3) * g.pick([1, 3]), g.int(-2, 4), g.pick(TURNS), g.int(1, 4)]); },
};
// Everything a check says, the part lists as they are (not sorted): what the page and the script must agree on.
const said = r => ({ ok: r.ok, problems: r.problems.map(p => [p.kind, p.parts, p.text, p.step || 0, p.key || '']), notes: r.notes.map(n => [n.kind, n.step, n.parts, n.text]),
  used: Object.keys(r.used).sort().map(k => [k, r.used[k]]), short: r.short.map(x => [x.key, x.need, x.have]), steps: r.steps, pieces: r.pieces, size: r.size });
const batch = {};
{
  const g = seeded(20261110), breaks = Object.keys(BREAK), copy = v => JSON.parse(JSON.stringify(v));
  for (let i = 0; i < 6 * breaks.length; i++) {
    const legal = legalModel(g, g.int(2, i % 20 === 0 ? 120 : 14)), how = breaks[i % breaks.length];
    const broken = copy(legal); BREAK[how](broken, g);
    const mixed = copy(broken); mixed.parts = g.shuffle(mixed.parts);
    batch['legal ' + i] = legal; batch[how + ' ' + i] = broken; batch[how + ' ' + i + ', rows shuffled'] = mixed;
    eq(B.check(B.cleanModel(copy(legal)), shapes, pool).problems, [], 'a model made to be buildable passes: ' + i);
    // The verdict is about the model, not about the order its rows were written in.
    const a = B.check(B.cleanModel(copy(broken)), shapes, pool), b = B.check(B.cleanModel(copy(mixed)), shapes, pool);
    eq([b.ok, kinds(b).filter((k, n, l) => l.indexOf(k) === n)], [a.ok, kinds(a).filter((k, n, l) => l.indexOf(k) === n)], 'the same verdict with the rows shuffled: ' + how + ' ' + i);
  }
}

// The example cottage can be built from the box.
const cottage = B.cleanModel(json('models/cottage.json'));
const res = B.check(cottage, shapes, pool);
eq(res.problems, [], 'cottage has no problems');
eq(res.pieces, cottage.parts.length, 'cottage pieces counted');

// Links round-trip.
(async () => {
  const doc = JSON.stringify({ brickyard: 1, model: cottage });
  const link = 'https://brickyard.junkdrawer.works/#d1z' + zlib.deflateRawSync(doc).toString('base64url');
  check(B.isModelLink(link), 'model link recognised');
  eq((await B.parseModel(link)).parts, cottage.parts, 'd1z link opens');
  eq((await B.parseModel('#d1j' + Buffer.from(doc).toString('base64url'))).name, 'Cottage', 'd1j link opens');
  // A whole message from Claude, copied: the link with a full stop after it or in a sentence, or the file in fences.
  for (const [t, what] of [[link + '.', 'a model link with a full stop after it'], ['Your cottage: ' + link + ' Open it in Brickyard.', 'a model link in a sentence'],
    ['```json\n' + doc + '\n```', 'a model file in ```json fences']]) {
    let m = null; try { m = await B.parseModel(t); } catch (e) { /* refused */ }
    eq(m && m.parts, cottage.parts, what + ' opens');
  }
  for (const h of ['#d1zA', '#d1jAAAAA']) {
    let threw = null, refused = false;
    try { await B.parseModel('https://brickyard.junkdrawer.works/' + h).catch(() => { refused = true; }); } catch (e) { threw = e; }
    check(!threw && refused, 'a cut-off model link is refused, not thrown: ' + h);
  }

  // The designer skill's script checks the same way as the page.
  const script = path.join(root, 'skill/brickyard-designer/scripts/check_model.py');
  const cases = {
    cottage: cottage,
    overlap: M([plate(0, 0, 1), ['3001', 4, 1, 0, 0, 0, 2]]),
    order: M([plate(0, 0, 1), plate(4, 0, 2), ['3001', 4, 2, 3, 0, 0, 3]]),
    turned: M([['3039', 4, 0, 0, 0, 90, 1], ['3004', 1, 1, 3, 0, 90, 2], ['3004', 1, 0, 3, 0, 0, 2]]),
    under: M([['3001', 4, 0, 3, 0, 0, 1], plate(0, 0, 2)]),
    'floating, base first': M(FLOAT_A), 'floating, rows swapped': M(FLOAT_A2), 'a floating pair': M(FLOAT_B), 'a floating pair, backwards': M(FLOAT_B2), 'two towers': M(TOWERS),
  };
  Object.assign(cases, batch); // and the seeded models, as they were written (the script cleans them itself)
  let py = null;
  // Importing the script would leave a __pycache__ folder in the repo (and on the site), so it writes no bytecode.
  const bytecode = () => { try { return fs.readdirSync(path.join(root, 'skill/brickyard-designer/scripts/__pycache__')).sort(); } catch (e) { return []; } };
  const bytecodeBefore = bytecode();
  try {
    py = JSON.parse(execFileSync('python3', ['-c', `
import json, sys, importlib.util
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('cm', sys.argv[1]); cm = importlib.util.module_from_spec(spec); spec.loader.exec_module(cm)
import contextlib, io
shapes = json.load(open(sys.argv[2])); pool = {}
for p, c, n in json.load(open(sys.argv[3]))['parts']: pool[f'{p}/{c}'] = pool.get(f'{p}/{c}', 0) + n
src = json.loads(sys.stdin.read()); out = {}
for k, m in src['cases'].items():
    with contextlib.redirect_stdout(io.StringIO()):
        model = cm.clean_model(m)
    r = cm.check(model, shapes, pool)
    out[k] = dict(parts=model['parts'], said=dict(ok=r['ok'], problems=[[p['kind'], p['parts'], p['text'], p.get('step', 0), p.get('key', '')] for p in r['problems']],
        notes=[[n['kind'], n['step'], n['parts'], n['text']] for n in r['notes']], used=sorted(r['used'].items()), short=[[x['key'], x['need'], x['have']] for x in r['short']],
        steps=r['steps'], pieces=r['pieces'], size=r['size']))
sets = {}
for k, v in src['sets'].items():
    said = io.StringIO()
    with contextlib.redirect_stdout(said):
        sets[k] = [cm.clean_model(dict(sets=v, parts=[['3001', 4, 0, 0, 0, 0, 1]]))['sets'], 'WARNING' in said.getvalue()]
print(json.dumps(dict(cases=out, sets=sets)))`, script, path.join(root, 'parts/shapes.json'), path.join(root, 'parts/sets/10698-1.json')], { input: JSON.stringify({ cases, sets: SETS }) }).toString());
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (py) eq(bytecode(), bytecodeBefore, 'checking the script leaves no bytecode behind in the repo');
  // The same parts after cleaning, and the same findings word for word, naming the same parts in the same order.
  if (py) for (const k in cases) {
    const m = B.cleanModel(JSON.parse(JSON.stringify(cases[k])));
    eq({ parts: m.parts, said: said(B.check(m, shapes, pool)) }, py.cases[k], 'script and page agree: ' + k);
  } else console.log('  (python3 not found; skipped the skill script)');
  // The script reads "sets" as the page does, and warns when it's neither a list nor one set number.
  if (py) for (const k in SETS) eq(py.sets[k], [WANT[k], ['a number alone', 'object'].includes(k)], 'script reads sets given as ' + k);

  // Loose pieces join the pool, and the script counts them the same way from a lot file or from pasted text.
  const lot = { id: 'sf1', name: 'Blue tub', parts: [['3001', 4, 5], ['3020', 15, 2], ['2780', 0, 40, 'Technic Pin']] };
  const both = B.poolOf([box, lot]);
  eq(both['3001/4'], pool['3001/4'] + 5, 'a lot adds to what the sets give');
  eq(both['2780/0'], 40, 'parts the builder can’t draw are still in the pool');
  const greedy = M(Array.from({ length: pool['3001/4'] + 3 }, (_, i) => ['3001', 4, 0, i * 3, 0, 0, i + 1]));
  eq(kinds(B.check(greedy, shapes, pool)), ['count'], 'a tower of red 2x4s is too many for the box alone');
  eq(kinds(B.check(greedy, shapes, both)), [], 'and fine with the loose ones');
  if (py) {
    const os = require('os');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brickyard-'));
    const model = path.join(dir, 'tower.json'), lotFile = path.join(dir, 'tub.brickyard-loose.json'), pasted = path.join(dir, 'pieces.txt');
    fs.writeFileSync(model, JSON.stringify({ name: 'Tower', sets: ['10698-1'], parts: greedy.parts }));
    fs.writeFileSync(lotFile, JSON.stringify({ brickyard: 1, loose: lot }));
    fs.writeFileSync(pasted, 'My Brickyard pieces, from 10698-1 Large Creative Brick Box + loose pieces (Blue tub).\nPieces the builder knows, as LDraw part/colour ×count:\n' +
      Object.keys(both).filter(k => shapes[k.split('/')[0]]).sort().map(k => k + ' ×' + both[k]).join(', ') + '\n');
    // The script as Claude runs it: [exit code, what it printed, what it said went wrong].
    const sh = args => { const r = require('child_process').spawnSync('python3', ['-B', script].concat(args), { encoding: 'utf8' }); return [r.status, r.stdout, r.stderr]; };
    const run = args => sh([model, '--out', dir, '--no-link'].concat(args));
    const alone = run([]);
    check(alone[0] === 1 && /Needs \d+ of 3001\/4/.test(alone[1]), 'script: the box alone is short');
    eq(run(['--pieces', lotFile])[0], 0, 'script: the box plus a lot file is enough');
    eq(run(['--sets', '--pieces', pasted])[0], 0, 'script: the pasted list on its own is enough');
    const lotOnly = run(['--sets', '--pieces', lotFile]);
    check(lotOnly[0] === 1 && /you have 5\b/.test(lotOnly[1]), 'script: with no sets, a lot file is the whole budget');
    eq(run(['--no-sets', '--pieces', lotFile]).slice(0, 2), lotOnly.slice(0, 2), 'script: --no-sets is an empty --sets');

    // A pasted list already counts the sets it names, so the model's own sets aren't added on top of it: one
    // brick more than the list has is one too many, with or without the empty --sets.
    const most = both['3001/4'], over = path.join(dir, 'over.json');
    fs.writeFileSync(over, JSON.stringify({ name: 'Over', sets: ['10698-1'], parts: Array.from({ length: most + 1 }, (_, i) => ['3001', 4, 0, i * 3, 0, 0, i + 1]) }));
    const short = new RegExp('Needs ' + (most + 1) + ' of 3001/4, you have ' + most + '\\b');
    for (const [args, what] of [[['--pieces', pasted, '--sets'], 'with an empty --sets'], [['--pieces', pasted, '--no-sets'], 'with --no-sets'], [['--pieces', pasted], 'with the pasted list alone']]) {
      const r = sh([over, '--out', dir].concat(args));
      check(r[0] === 1 && short.test(r[1]), 'script: one brick more than the pasted list is short, ' + what + (r[0] === 1 ? '' : '\n    ' + r[1].split('\n').slice(0, 3).join(' | ')));
    }
    const noted = run(['--pieces', pasted]);
    check(noted[0] === 0 && /NOTE: .*whole budget.*10698-1/.test(noted[1]), 'script: it says the model’s own sets were left out');
    const onTop = sh([over, '--out', dir, '--no-link', '--pieces', pasted, '--sets', '10698-1']);
    check(onTop[0] === 0 && /WARNING: 10698-1 counted on top of the pasted list/.test(onTop[1]), 'script: sets named beside a pasted list are added, with a warning');
    eq(sh([over, '--out', dir, '--no-sets', '--sets', '10698-1'])[0], 1, 'script: --no-sets and --sets together are refused');

    // A model with problems is not handed over: no file, no link, and it says so. --force makes them anyway.
    const made = path.join(dir, 'over.brickyard-model.json');
    fs.rmSync(made, { force: true });
    const failing = sh([over, '--out', dir, '--pieces', pasted]);
    check(failing[0] === 1 && /NOT READY: 1 problem\./.test(failing[1]) && !/https:|File:/.test(failing[1]) && !fs.existsSync(made), 'script: a failing model gets no file and no link');
    const forced = sh([over, '--out', dir, '--pieces', pasted, '--force']);
    check(forced[0] === 1 && /NOT READY/.test(forced[1]) && /https:\/\/brickyard\.junkdrawer\.works\/#d1z/.test(forced[1]) && fs.existsSync(made), 'script: --force makes the file and link, and still exits 1');
    check(/from an earlier run/.test(sh([over, '--out', dir, '--pieces', pasted])[1]), 'script: a file left by an earlier run is pointed out');
    const passing = sh([model, '--out', dir, '--pieces', lotFile]);
    check(passing[0] === 0 && !/NOT READY/.test(passing[1]) && /\nhttps:\/\/brickyard\.junkdrawer\.works\/#d1z/.test(passing[1]) && fs.existsSync(path.join(dir, 'tower.brickyard-model.json')), 'script: a passing model gets its file and link');

    // --sets and --pieces take every word after them. A model file put last is named, not "file is required".
    for (const [args, says] of [[['--pieces', pasted, '--sets', model], /No model file\. .*tower\.json came after --sets.*Put the model first/], [['--pieces', pasted, model], /No model file\. .*--pieces takes everything after it.*tower\.json/], [[], /No model file\. Put the model first/]]) {
      const r = sh(args);
      check(r[0] === 1 && says.test(r[2]), 'script: a model file that isn’t first: ' + (args.join(' ').replace(dir, '').replace(dir, '') || 'none at all') + (says.test(r[2]) ? '' : '\n    ' + r[2].trim().split('\n').pop()));
    }
    // The skill folder copied somewhere with no repo around it (as it is once uploaded) checks the cottage from
    // its own data/, and nothing of the repo is needed.
    const lone = path.join(dir, 'elsewhere');
    fs.cpSync(skill, path.join(lone, 'brickyard-designer'), { recursive: true });
    fs.copyFileSync(path.join(root, 'models/cottage.json'), path.join(lone, 'cottage.json'));
    const away = require('child_process').spawnSync('python3', ['-B', 'brickyard-designer/scripts/check_model.py', 'cottage.json', '--out', 'out'], { cwd: lone, encoding: 'utf8' });
    check(!path.resolve(lone).startsWith(root + path.sep), 'the copied skill is outside the repo');
    check(away.status === 0 && /Cottage: 40 pieces/.test(away.stdout) && /\nhttps:\/\/brickyard\.junkdrawer\.works\/#d1z/.test(away.stdout) && fs.existsSync(path.join(lone, 'out/cottage.brickyard-model.json')),
      'the skill on its own checks the cottage' + (away.status === 0 ? '' : '\n    ' + (away.stdout + away.stderr).trim().split('\n').pop()));
    // "sets": "10698-1" is that set, as on the page.
    const texted = path.join(dir, 'texted.json');
    fs.writeFileSync(texted, JSON.stringify({ name: 'Texted', sets: '10698-1', parts: greedy.parts.slice(0, 2) }));
    const asText = sh([texted, '--out', dir, '--no-link']);
    check(asText[0] === 0 && !/No parts list|weren’t checked/.test(asText[1] + asText[2]), 'script: "sets" as one string is that set' + (asText[0] === 0 ? '' : '\n    ' + (asText[1] + asText[2]).trim()));
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log(failed ? `${failed} failed, ${passed} passed` : `all ${passed} checks passed`);
  process.exit(failed ? 1 : 0);
})();
