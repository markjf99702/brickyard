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
eq(r2.left.map(x => [x.set.id, x.why]), [['huge', '50 cm tall; your tallest shelf is 40 cm'], ['deep', '40 cm deep; your bookcase is 26 cm deep']], 'why things are left: the set’s size and the most there is');
const srt = S.sort(sets, r.cases);
eq([srt.placed.length, srt.waiting.length, srt.noSize.map(x => x.id)], [5, 0, ['nosize']], 'taken-apart sets are not on shelves');
eq(S.used(r.cases[0].levels[2], ids(sets)), 61, 'shelf use counts the gap');
const k3 = JSON.parse(JSON.stringify(r.cases[0])); S.takeOff([k3], 'b');
eq(k3.levels[1].sets.map(p => p.id), ['mid'], 'take a set off');
eq(S.whyNot([k3], set('x', 45, 20, 14), ids(sets)), 'No room left on a shelf it fits', 'no room left');
// A set wider than a shelf (or too wide one way and too deep the other) says so, even on an empty shelf: only a
// shelf that would take it when empty can be short of room.
const lambo = set('lambo', 60, 26, 15), kallax = { id: 'kx', name: 'Kallax', w: 33, d: 37, levels: [{ h: 33, sets: [] }] };
eq(S.fits(kallax, 0, lambo, ids([lambo])).why, 'Too big (60 × 26 cm, the shelf is 33 × 37)', 'too wide facing out and too deep side-on');
eq(S.whyNot([kallax], lambo, ids([lambo])), 'At 60 × 26 cm, too big for your bookcase', 'too big for an empty shelf is not short of room');
eq(S.whyNot([kallax, shelf(30, 40, [20])], lambo, ids([lambo])), 'At 60 × 26 cm, too big for every bookcase', 'too big for each of two');
const square = set('sq', 40, 40, 10);
eq(S.fits(shelf(33, 45, [20]), 0, square, ids([square])).why, 'Too wide (40 cm, the shelf is 33)', 'too wide both ways');
eq(S.whyNot([shelf(33, 45, [20])], square, ids([square])), '40 cm wide; your bookcase is 33 cm wide', 'too wide for the one bookcase');
eq(S.whyNot([shelf(33, 45, [20]), shelf(36, 45, [20])], square, ids([square])), '40 cm wide; your widest bookcase is 36 cm', 'too wide for every bookcase');
// The reasons give the set's size and the most any bookcase or shelf has. A set stands either way round, so its
// depth is the lesser of its two sides, "even side-on" when that's the way that gives it; so is its width.
const explorer = set('explorer', 52, 32, 13), b6 = { id: 'b6', name: 'Billy', w: 76, d: 26, levels: [32, 32, 32, 32, 32, 32].map(h => ({ h, sets: [] })) };
eq(S.whyNot([b6], explorer, ids([explorer])), '32 cm deep; your bookcase is 26 cm deep', 'too deep for a Billy, whose shelves are 32 cm tall');
eq(S.whyNot([b6, kallax], set('d2', 60, 40, 13), {}), '40 cm deep; your deepest bookcase is 37 cm', 'too deep for each of two');
eq(S.whyNot([b6], set('d3', 30, 41, 13), {}), '30 cm deep even side-on; your bookcase is 26 cm deep', 'the lesser side is its width');
eq(S.whyNot([shelf(20, 45, [20])], set('w2', 40, 30, 10), {}), '30 cm wide even side-on; your bookcase is 20 cm wide', 'the lesser side is its depth');
eq(S.whyNot([b6], set('t2', 27, 24, 37), {}), '37 cm tall; your tallest shelf is 32 cm', 'too tall for every shelf');
eq(S.whyNot([shelf(50, 40, [8])], set('t3', 10, 10, 10.5), {}), '10.5 cm tall; your shelf is 8 cm tall', 'too tall for the one shelf');
const galaxy = set('galaxy', 51, 25, 33), billy = { id: 'b', name: 'Billy', w: 76, d: 26, levels: [{ h: 32, sets: [] }, { h: 32, sets: [] }] };
eq(S.whyNot([billy, kallax], galaxy, ids([galaxy])), 'Too big for every shelf', 'too tall for one bookcase and too big for the other');
eq(S.fits(shelf(35, 45, [20]), 0, set('w', 40, 30, 10), ids([set('w', 40, 30, 10), set('o', 10, 10, 10)])), { turn: true }, 'still side-on when facing out is too wide');

// Sizes from Claude, and the cataloger script makes the same.
const list = [{ num: '10497', w: '51', d: 33.04, h: 14, note: '  LEGO   says ' }, { num: '10497', w: 1, d: 1, h: 1 }, { num: 'nope', w: 1, d: 1, h: 1 },
  { num: 21318, w: 22, d: 22 }, { num: 'LEGO® Set No. 10281', w: 20, d: 15, h: 18 }];
const clean = S.cleanSizes({ sizes: list });
eq(clean, [{ num: '10497-1', w: 51, d: 33, h: 14, note: 'LEGO says' }, { num: '10281-1', w: 20, d: 15, h: 18 }], 'sizes cleaned');
eq(S.cleanSizes({ sets: [] }), null, 'not a sizes list');
// Sizes read set numbers the way My sets does (js/core.js setNum), "LEGO 10497" included.
{
  const spellings = ['10497', '#10497-2', 'Set 6020', 'LEGO 10497', 'lego10497-1', 'LEGO™ Set No. #75192', 'sw0001a', 'set 10497 v2', 'hello'];
  const one = n => (S.cleanSizes({ sizes: [{ num: n, w: 1, d: 1, h: 1 }] }) || [{ num: '' }])[0].num;
  eq(spellings.map(one), spellings.map(C.setNum), 'the planner and My sets agree on set numbers');
}
(async () => {
  const doc = JSON.stringify({ brickyard: 1, sizes: list });
  check(S.isSizesLink('https://brickyard.junkdrawer.works/#z1z' + zlib.deflateRawSync(doc).toString('base64url')), 'sizes link recognised');
  eq(await S.parseSizes('#z1z' + zlib.deflateRawSync(doc).toString('base64url')), clean, 'z1z link opens');
  eq(await S.parseSizes('#z1j' + Buffer.from(doc).toString('base64url')), clean, 'z1j link opens');
  eq(await S.parseSizes(doc), clean, 'pasted file opens');
  // A whole message from Claude, copied: the link in a sentence, or the file in ```json fences.
  for (const [t, what] of [
    ['Here are the sizes: https://brickyard.junkdrawer.works/#z1z' + zlib.deflateRawSync(doc).toString('base64url') + '. Tap Add sizes.', 'a sizes link in a sentence'],
    ['```json\n' + doc + '\n```', 'a sizes file in ```json fences'],
  ]) {
    let z = null; try { z = await S.parseSizes(t); } catch (e) { /* refused */ }
    eq(z, clean, what + ' opens');
  }
  for (const h of ['#z1zA', '#z1jAAAAA']) {
    let threw = null, refused = false;
    try { await S.parseSizes('https://brickyard.junkdrawer.works/' + h).catch(() => { refused = true; }); } catch (e) { threw = e; }
    check(!threw && refused, 'a cut-off sizes link is refused, not thrown: ' + h);
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brickyard-'));
  fs.writeFileSync(path.join(dir, 'sizes.json'), doc);
  let out = null;
  try { out = execFileSync('python3', [path.join(root, 'skill/brickyard-cataloger/scripts/make_brickyard.py'), path.join(dir, 'sizes.json'), '--out', dir]).toString(); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (out) {
    const link = out.split('\n').find(l => l.includes('#z1z'));
    eq(await S.parseSizes(link), clean, 'script and page agree on sizes');
    check(!/NOTE: this link is long/.test(out), 'a short sizes link has no note about its length');
    // A long sizes link gets the same note as a long batch link: lead with the file.
    fs.writeFileSync(path.join(dir, 'many.json'), JSON.stringify({ sizes: Array.from({ length: 900 }, (_, i) => ({ num: String(10000 + i * 37), w: 10 + i % 41, d: 8 + i % 23, h: 5 + i % 31, note: 'estimate ' + (i * 7919 % 1000) })) }));
    const many = execFileSync('python3', [path.join(root, 'skill/brickyard-cataloger/scripts/make_brickyard.py'), path.join(dir, 'many.json'), '--out', dir]).toString();
    check(/\nLink \((\d+) characters\):/.test(many) && +/Link \((\d+)/.exec(many)[1] > 6000 && /\nNOTE: this link is long\. Lead with the file; some apps cut long links off\./.test(many), 'a long sizes link says to lead with the file');
  } else console.log('  (python3 not found; skipped the skill script)');
  fs.rmSync(dir, { recursive: true, force: true });

  // The sizes example is the same set with the same numbers wherever it's written down: the cataloger skill, the
  // format reference, the script's own help and this file's comment.
  const example = '{"num": "10497", "w": 52, "d": 32, "h": 13';
  for (const f of ['skill/brickyard-cataloger/SKILL.md', 'skill/brickyard-cataloger/references/brickyard-format.md', 'skill/brickyard-cataloger/scripts/make_brickyard.py', 'js/shelf-core.js']) {
    const text = fs.readFileSync(path.join(root, f), 'utf8'), found = text.match(/\{"num": "10497", "w": [^}]*/g) || [];
    check(found.length > 0 && found.every(x => x.startsWith(example)), f + ' gives the one sizes example' + (found.length ? ': ' + found.join(' | ') : ': none found'));
  }

  console.log(failed ? `${failed} failed, ${passed} passed` : `all ${passed} checks passed`);
  process.exit(failed ? 1 : 0);
})();
