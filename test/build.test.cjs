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
eq(kinds(B.check(M([['3001', 1, 0, 0, 0, 0, 1], ['3001', 1, 0, 3, 0, 0, 1]]), shapes, {})), ['count'], 'no pieces, short');
eq(kinds(B.check(M([['zzz', 1, 0, 0, 0, 0, 1]]), shapes, null)), ['part'], 'unknown part');
eq(B.check(M([['3001', 4, 0, 3, 0, 0, 1], plate(0, 0, 2)]), shapes, null).notes.map(n => n.kind), ['under'], 'pushed on from underneath');
eq(B.cleanModel({ parts: [['3001', 1, 0, 3, 0], ['3001', 1, 0, 0, 0]] }).parts.map(q => q[6]), [2, 1], 'no steps: one per height');
eq(B.cleanModel({ parts: [['3001', 1, 0, 0, 0, 45]] }), null, 'turns are whole quarter turns');
check(B.cleanModel({ model: { parts: [{ p: '3001.dat', c: '1', x: 0, y: 0, z: 0 }] } }).parts[0][0] === '3001', 'objects and .dat names work');

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

  // The designer skill's script checks the same way as the page.
  const script = path.join(root, 'skill/brickyard-designer/scripts/check_model.py');
  const cases = {
    cottage: cottage,
    overlap: M([plate(0, 0, 1), ['3001', 4, 1, 0, 0, 0, 2]]),
    order: M([plate(0, 0, 1), plate(4, 0, 2), ['3001', 4, 2, 3, 0, 0, 3]]),
    turned: M([['3039', 4, 0, 0, 0, 90, 1], ['3004', 1, 1, 3, 0, 90, 2], ['3004', 1, 0, 3, 0, 0, 2]]),
    under: M([['3001', 4, 0, 3, 0, 0, 1], plate(0, 0, 2)]),
  };
  let py = null;
  try {
    py = JSON.parse(execFileSync('python3', ['-c', `
import json, sys, importlib.util
spec = importlib.util.spec_from_file_location('cm', sys.argv[1]); cm = importlib.util.module_from_spec(spec); spec.loader.exec_module(cm)
shapes = json.load(open(sys.argv[2])); pool = {}
for p, c, n in json.load(open(sys.argv[3]))['parts']: pool[f'{p}/{c}'] = pool.get(f'{p}/{c}', 0) + n
out = {}
for k, m in json.loads(sys.stdin.read()).items():
    r = cm.check(cm.clean_model(m), shapes, pool)
    out[k] = dict(problems=[(p['kind'], sorted(p['parts'])) for p in r['problems']], notes=[n['step'] for n in r['notes']], size=r['size'], steps=r['steps'])
print(json.dumps(out))`, script, path.join(root, 'parts/shapes.json'), path.join(root, 'parts/sets/10698-1.json')], { input: JSON.stringify(cases) }).toString());
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (py) for (const k in cases) {
    const r = B.check(cases[k], shapes, pool);
    eq({ problems: r.problems.map(p => [p.kind, p.parts.slice().sort((a, b) => a - b)]), notes: r.notes.map(n => n.step), size: r.size, steps: r.steps }, py[k], 'script and page agree: ' + k);
  } else console.log('  (python3 not found; skipped the skill script)');

  console.log(failed ? `${failed} failed, ${passed} passed` : `all ${passed} checks passed`);
  process.exit(failed ? 1 : 0);
})();
