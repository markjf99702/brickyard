// Checks the shelf planner: bookcases in the catalog, which way sets fit, filling shelves, and sizes links,
// including that the cataloger script makes sizes the page reads the same way.
// Run with: node test/shelf.test.cjs   (no dependencies; Node 18 or later)
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const os = require('os');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const load = f => { const mod = { exports: {} }; new Function('module', fs.readFileSync(path.join(root, f), 'utf8'))(mod); return mod.exports; };
const C = load('js/core.js'), S = load('js/shelf-core.js');

let failed = 0, passed = 0;
function check(ok, what) { if (ok) passed++; else { failed++; console.log('  FAIL ' + what); } }
function eq(a, b, what) { const x = JSON.stringify(a), y = JSON.stringify(b); check(x === y, what + (x === y ? '' : '\n    got  ' + x + '\n    want ' + y)); }

for (const f of ['js/shelves.js', 'js/shelf-core.js']) {
  let err = null; try { new Function(fs.readFileSync(path.join(root, f), 'utf8')); } catch (e) { err = e; }
  check(!err, f + ' parses' + (err ? ': ' + err.message : ''));
}

// Bookcases in the catalog.
const k = C.cleanCase({ id: 'k1', t: 3, name: ' Office  Billy ', room: 'Office', w: '76', d: 26, levels: [32, { h: '40', sets: ['a', { id: 'b', turn: true }, 'a', ''] }, 0, 'x'] });
eq(k, { id: 'k1', t: 3, name: 'Office Billy', w: 76, d: 26, levels: [{ h: 32, sets: [] }, { h: 40, sets: [{ id: 'a' }, { id: 'b', turn: true }] }], room: 'Office' }, 'bookcase cleaned');
eq(C.cleanCase({ id: 'k', w: 76, d: 26, levels: [] }), null, 'a bookcase needs a shelf');
eq(C.cleanCase({ id: 'k', t: 4, del: 1 }), { id: 'k', t: 4, del: 1 }, 'removal kept');
const d1 = C.cleanDoc({ catalog: { sets: {}, cases: { k1: { id: 'k1', t: 1, name: 'Old', w: 50, d: 20, levels: [30] } } } });
const d2 = C.cleanDoc({ catalog: { sets: {}, cases: { k1: { id: 'k1', t: 2, name: 'New', w: 50, d: 20, levels: [30] } } } });
eq(C.mergeDocs(d1, d2).cases.k1.name, 'New', 'newer bookcase wins');
eq(C.mergeDocs(d2, d1).cases.k1.name, 'New', 'in either order');
eq(C.cleanDoc({ catalog: { sets: {} } }).cases, {}, 'old backups have no bookcases');

// Fitting.
const set = (id, w, d, h, state) => ({ id, name: id, state: state || 'built', size: { w, d, h } });
const ids = list => Object.fromEntries(list.map(x => [x.id, x]));
const shelf = (w, d, hs) => ({ id: 'k', name: 'K', w, d, levels: hs.map(h => ({ h, sets: [] })) });
const wide = set('wide', 40, 30, 10), all1 = ids([wide]);
eq(S.fits(shelf(50, 40, [20]), 0, wide, all1), { turn: false }, 'facing out');
eq(S.fits(shelf(50, 35, [20]), 0, wide, all1), { turn: false }, 'facing out when it is deep enough');
eq(S.fits(shelf(50, 28, [20]), 0, wide, all1).why, 'Too deep (30 cm, the shelf is 28)', 'too deep both ways');
eq(S.fits(shelf(35, 45, [20]), 0, wide, all1), { turn: true }, 'side-on when facing out is too wide');
eq(S.fits(shelf(50, 40, [8]), 0, wide, all1).why, 'Too tall (10 cm, the shelf has 8)', 'too tall');
eq(S.fits(shelf(50, 40, [20]), 0, { id: 'n', name: 'n' }, all1).why, 'It needs a size', 'no size');

// Filling: tall sets first, each on the shortest shelf that takes it; sets already placed stay.
const sets = [set('tall', 20, 20, 38), set('mid', 30, 20, 25), set('a', 30, 20, 12), set('b', 30, 20, 12), set('c', 30, 20, 12), set('apart', 10, 10, 10, 'apart'), { id: 'nosize', name: 'n', state: 'built' }];
const k2 = { id: 'k2', name: 'Billy', w: 62, d: 26, levels: [{ h: 40, sets: [] }, { h: 26, sets: [] }, { h: 15, sets: [{ id: 'c' }] }] };
const r = S.fill([k2], sets);
eq(r.cases[0].levels.map(l => l.sets.map(p => p.id)), [['tall'], ['mid', 'b'], ['c', 'a']], 'filled by height');
eq(k2.levels[2].sets.length, 1, 'the old bookcase is not changed');
eq(r.left, [], 'everything fitted');
const r2 = S.fill([k2], sets.concat([set('huge', 20, 20, 50), set('deep', 40, 40, 10)]));
eq(r2.left.map(x => [x.set.id, x.why]), [['huge', 'Too tall for every shelf (50 cm)'], ['deep', 'Too deep for every bookcase (40 cm)']], 'why things are left');
const srt = S.sort(sets, r.cases);
eq([srt.placed.length, srt.waiting.length, srt.noSize.map(x => x.id)], [5, 0, ['nosize']], 'taken-apart sets are not on shelves');
eq(S.used(r.cases[0].levels[2], ids(sets)), 61, 'shelf use counts the gap');
const k3 = JSON.parse(JSON.stringify(r.cases[0])); S.takeOff([k3], 'b');
eq(k3.levels[1].sets.map(p => p.id), ['mid'], 'take a set off');
eq(S.whyNot([k3], set('x', 45, 20, 14), ids(sets)), 'No room left on a shelf it fits', 'no room left');

// Sizes from Claude, and the cataloger script makes the same.
const list = [{ num: '10497', w: '51', d: 33.04, h: 14, note: '  LEGO   says ' }, { num: '10497', w: 1, d: 1, h: 1 }, { num: 'nope', w: 1, d: 1, h: 1 }, { num: 21318, w: 22, d: 22 }];
const clean = S.cleanSizes({ sizes: list });
eq(clean, [{ num: '10497-1', w: 51, d: 33, h: 14, note: 'LEGO says' }], 'sizes cleaned');
eq(S.cleanSizes({ sets: [] }), null, 'not a sizes list');
(async () => {
  const doc = JSON.stringify({ brickyard: 1, sizes: list });
  check(S.isSizesLink('https://brickyard.junkdrawer.works/#z1z' + zlib.deflateRawSync(doc).toString('base64url')), 'sizes link recognised');
  eq(await S.parseSizes('#z1z' + zlib.deflateRawSync(doc).toString('base64url')), clean, 'z1z link opens');
  eq(await S.parseSizes('#z1j' + Buffer.from(doc).toString('base64url')), clean, 'z1j link opens');
  eq(await S.parseSizes(doc), clean, 'pasted file opens');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brickyard-'));
  fs.writeFileSync(path.join(dir, 'sizes.json'), doc);
  let out = null;
  try { out = execFileSync('python3', [path.join(root, 'skill/brickyard-cataloger/scripts/make_brickyard.py'), path.join(dir, 'sizes.json'), '--out', dir]).toString(); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (out) {
    const link = out.split('\n').find(l => l.includes('#z1z'));
    eq(await S.parseSizes(link), clean, 'script and page agree on sizes');
  } else console.log('  (python3 not found; skipped the skill script)');

  console.log(failed ? `${failed} failed, ${passed} passed` : `all ${passed} checks passed`);
  process.exit(failed ? 1 : 0);
})();
