// Checks Brickyard's set cleaning, merging, doubles, links, the spreadsheet, and the skill's script.
// Run with: node test/core.test.cjs   (no dependencies; Node 18 or later)
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const os = require('os');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const mod = { exports: {} };
new Function('module', fs.readFileSync(path.join(root, 'js/core.js'), 'utf8'))(mod);
const C = mod.exports;

let failed = 0, passed = 0;
function check(ok, what) { if (ok) passed++; else { failed++; console.log('  FAIL ' + what); } }
function eq(a, b, what) { const x = JSON.stringify(a), y = JSON.stringify(b); check(x === y, what + (x === y ? '' : '\n    got  ' + x + '\n    want ' + y)); }
function rng(seed) { let a = seed; return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

// The page script parses.
for (const f of ['js/app.js', 'js/core.js']) {
  let err = null; try { new Function(fs.readFileSync(path.join(root, f), 'utf8')); } catch (e) { err = e; }
  check(!err, f + ' parses' + (err ? ': ' + err.message : ''));
}

// Set numbers.
eq(C.setNum('10698'), '10698-1', 'plain number gets -1');
eq(C.setNum('#10698-2'), '10698-2', 'version kept, # dropped');
eq(C.setNum('Set 6020'), '6020-1', '"Set" prefix');
eq(C.setNum('40220-01'), '40220-1', 'leading zero in version');
eq(C.setNum('sw0001a'), 'sw0001a-1', 'letters-and-numbers ids');
eq(C.setNum('hello'), '', 'a word is not a set number');
eq(C.setNum('12'), '', 'too short');
eq(C.shortNum('10698-1'), '10698', 'short form drops -1');
eq(C.shortNum('10698-2'), '10698-2', 'short form keeps other versions');

// Cleaning.
eq(C.cleanSet({ num: '10698', name: '  Large   Creative Brick Box ', pieces: '790', state: 'Disassembled', year: '2015', box: 7, junk: 1 }),
  { num: '10698-1', name: 'Large Creative Brick Box', year: 2015, pieces: 790, state: 'apart', box: '7' }, 'cleans and maps a set');
eq(C.cleanSet({ name: 'x', state: 'on fire', year: 1800, pieces: -4, size: { w: '37,5', d: 0, h: 'tall' } }), { name: 'x', size: { w: 37.5, d: 0, h: 0 } }, 'bad values dropped');
eq(C.cleanSet({ year: 2020 }), null, 'needs a number or a name');
eq(C.cleanSet({ name: 'x', instr: false }).instr, false, 'no instructions is kept');
eq(C.cleanSet({ name: 'x', tags: 'a, b; A' }).tags, ['a', 'b'], 'tags split and deduped');
eq(C.cleanSet({ name: 'x', unsure: 'blurry' }).check, 'blurry', 'unsure becomes check');
check(C.cleanSet({ name: 'y'.repeat(500) }).name.length === 160, 'name clamped');

// Batches.
{
  const b = C.cleanBatch({ brickyard: 1, batch: { room: 'Office', spot: 'Top', box: '3', state: 'built', sets: [
    { num: '1' }, { num: '10497' }, { num: '10281', room: 'Den' }, { num: '21327', spot: 'Desk', state: 'partial' }] } });
  eq(b.sets.length, 3, 'unusable set dropped');
  eq([b.sets[0].room, b.sets[0].spot, b.sets[0].box, b.sets[0].state], ['Office', 'Top', '3', 'built'], 'batch defaults fill in');
  eq([b.sets[1].room, b.sets[1].spot], ['Den', undefined], 'a set in another room keeps no batch shelf');
  eq([b.sets[2].spot, b.sets[2].state], ['Desk', 'partial'], 'a set’s own values win');
  check(/^c/.test(b.id), 'batch gets an id');
  eq(C.cleanBatch({ batch: { sets: [{ num: '10497' }] } }).id, C.cleanBatch({ batch: { sets: [{ num: '10497' }] } }).id, 'same content, same id');
}

// Doubles.
{
  const doc = C.cleanDoc({ catalog: { sets: { a: { id: 'a', t: 1, num: '10698', name: 'Box' }, b: { id: 'b', t: 1, name: 'Custom Castle' }, c: { id: 'c', t: 2, del: 1 } } } });
  eq(C.findDup(doc, C.cleanSet({ num: '10698-1' })).id, 'a', 'same number is a double');
  eq(C.findDup(doc, C.cleanSet({ num: '10698-2' })), null, 'another version is not');
  eq(C.findDup(doc, C.cleanSet({ name: 'custom castle!' })).id, 'b', 'same name with no number');
  eq(C.live(doc).length, 2, 'removed sets are not live');
}

// Merging: any order, same result; newest change wins; removals stick.
{
  const r = rng(7);
  const pick = a => a[Math.floor(r() * a.length)];
  let ok = true;
  for (let n = 0; n < 300; n++) {
    const docs = [0, 1, 2].map(() => {
      const sets = {};
      for (let i = 0; i < 6; i++) {
        const id = pick(['a', 'b', 'c', 'd', 'e']), t = Math.floor(r() * 10);
        sets[id] = r() < .2 ? { id, t, del: 1 } : { id, t, name: pick(['One', 'Two', 'Three']), state: pick(['built', 'apart']) };
      }
      return C.cleanDoc({ catalog: { sets, seen: { ['k' + Math.floor(r() * 3)]: Math.floor(r() * 9) } } });
    });
    const canon = d => JSON.stringify([Object.keys(d.sets).sort().map(k => d.sets[k]), Object.keys(d.seen).sort().map(k => [k, d.seen[k]])]);
    const x = canon(C.mergeDocs(C.mergeDocs(docs[0], docs[1]), docs[2]));
    const y = canon(C.mergeDocs(docs[2], C.mergeDocs(docs[1], docs[0])));
    if (x !== y) { ok = false; break; }
  }
  check(ok, 'merging gives the same catalog in any order');
  const m = C.mergeDocs(C.cleanDoc({ catalog: { sets: { a: { id: 'a', t: 5, name: 'Old' } } } }), C.cleanDoc({ catalog: { sets: { a: { id: 'a', t: 9, del: 1 } } } }));
  eq(m.sets.a, { id: 'a', t: 9, del: 1 }, 'a later removal wins');
}

// Search.
{
  const x = C.cleanSet({ num: '21327', name: 'Typewriter', room: 'Office', box: '3', state: 'partial' });
  check(C.matches(x, 'type office'), 'search matches several words');
  check(C.matches(x, 'box 3'), 'search finds a moving box');
  check(C.matches(x, 'partly'), 'search finds the state');
  check(!C.matches(x, 'castle'), 'search misses');
}
eq(['10', '2', 'B', 'a'].sort(C.natural), ['2', '10', 'a', 'B'], 'boxes sort as people count');

// Spreadsheet.
eq(C.csvCell('=1+1'), "'=1+1", 'formulas defused');
eq(C.csvCell('a,"b"'), '"a,""b"""', 'quotes and commas');
check(C.toCsv([C.cleanSet({ num: '10698', name: 'Box', size: { w: 3 } })]).split('\r\n')[1].startsWith('10698,Box,'), 'a row per set');

// Links and the skill's script.
(async () => {
  const sample = { brickyard: 1, batch: { name: 'Shelf', sets: [{ num: '10698-1', name: 'Large Creative Brick Box' }] } };
  const text = JSON.stringify(sample);
  const z = '#b1z' + zlib.deflateRawSync(Buffer.from(text)).toString('base64url');
  const j = '#b1j' + Buffer.from(text).toString('base64url');
  for (const [h, what] of [[z, 'compressed'], [j, 'uncompressed'], ['#batch=' + encodeURIComponent(text), 'hand-written']]) {
    const r = await C.parseIncoming('https://brickyard.junkdrawer.works/' + h);
    eq([r.kind, r.batch.sets[0].num, r.batch.name], ['batch', '10698-1', 'Shelf'], what + ' link opens');
  }
  const pasted = await C.parseIncoming(JSON.stringify(sample));
  eq(pasted.batch.sets.length, 1, 'pasted file text opens');
  const cat = await C.parseIncoming(JSON.stringify({ brickyard: 1, catalog: { sets: { a: { id: 'a', t: 1, name: 'X' } } } }));
  eq(cat.kind, 'catalog', 'a backup opens as a catalog');
  let bad = null; try { await C.parseIncoming('not json'); } catch (e) { bad = e; }
  check(bad, 'rubbish is refused');

  let py = true; try { execFileSync('python3', ['--version']); } catch (e) { py = false; }
  if (py) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brickyard-'));
    const out = execFileSync('python3', [path.join(root, 'skill/brickyard-cataloger/scripts/make_brickyard.py'), path.join(root, 'test/fixtures/sample.json'), '--out', dir], { encoding: 'utf8' });
    const link = out.trim().split('\n').find(l => l.startsWith('https://'));
    const fromLink = await C.parseIncoming(link);
    const file = fs.readdirSync(dir).find(f => f.endsWith('.brickyard.json'));
    const fromFile = await C.parseIncoming(fs.readFileSync(path.join(dir, file), 'utf8'));
    eq(fromLink.batch, fromFile.batch, 'the script’s link and file say the same');
    const want = JSON.parse(fs.readFileSync(path.join(root, 'test/fixtures/sample.json'), 'utf8'));
    eq(fromLink.batch.sets.length, want.sets.length, 'every set comes through the script');
    const lambo = fromLink.batch.sets.find(x => x.num === '42115-1');
    eq([lambo.check, lambo.box, lambo.state], ['box corner was blurry; could be 42083', '12', 'built'], 'fields survive the script');
    eq(fromLink.batch.sets[0].instr, true, 'instructions survive');
    // The script cleans the same way the page does.
    fromLink.batch.sets.forEach(x => eq(C.cleanSet(x), x, 'page agrees with script on ' + x.name));
    const odd = path.join(dir, 'odd.json');
    fs.writeFileSync(odd, JSON.stringify({ sets: [{ num: 'abc!', name: 'Mystery' }, { num: '10497' }, { num: '10497' }] }));
    const o = execFileSync('python3', [path.join(root, 'skill/brickyard-cataloger/scripts/make_brickyard.py'), odd, '--out', dir], { encoding: 'utf8' });
    check(/doesn’t look like a set number/.test(o), 'script flags a bad set number');
    check(/twice/.test(o), 'script flags doubles');
  } else console.log('  (python3 not found; skipped the skill script)');

  // Lots of loose pieces: cleaned, added up, kept in the catalog, merged like sets, carried by links.
  const lot = C.cleanLot({ id: 'sf1', name: ' Blue  tub ', box: '14', parts: [['3001', 4, 12], ['3001', '4', 3], ['3020', 15, 7, 'Plate 2 x 4'],
    ['BAD ID', 1, 1], ['3004', -1, 2], ['3005', 1.5, 2], ['3005', 0, 0], ['2780', 0, 40, 'Technic Pin'], 'junk', ['3024']] });
  eq(lot, { id: 'sf1', t: 0, name: 'Blue tub', parts: [['2780', 0, 40, 'Technic Pin'], ['3001', 4, 15], ['3020', 15, 7, 'Plate 2 x 4']], box: '14' },
    'a lot is cleaned: bad rows dropped, the same part and colour added up, rows in order');
  eq(C.lotTotals(lot), { pieces: 62, kinds: 3 }, 'a lot’s pieces and kinds');
  eq(C.cleanLot({ id: 'x', parts: [['nope!', 1, 1]] }), null, 'a lot with no usable rows is nothing');
  eq(C.cleanLot({ parts: [['3001', 0, 1]] }).id, C.cleanLot({ parts: [['3001', '0', 1]] }).id, 'a lot with no id gets one from what’s in it');
  eq(C.cleanLot({ id: 'x', parts: [['3001', 0, 2]] }).parts, [['3001', 0, 2]], 'colour 0 (black) is a colour');
  const withLot = C.cleanDoc({ catalog: { sets: {}, loose: { sf1: Object.assign({}, lot, { t: 5 }), gone: { del: 1, t: 9 }, bad: { parts: [] } } } });
  eq(Object.keys(withLot.loose).sort(), ['gone', 'sf1'], 'lots live in the catalog; an empty one is dropped');
  eq(C.liveLots(withLot).map(l => l.id), ['sf1'], 'a removed lot isn’t live');
  eq(C.cleanDoc(JSON.parse(JSON.stringify({ catalog: withLot }))), withLot, 'a catalog with lots survives a save and a load');
  const older = C.cleanDoc({ catalog: { loose: { sf1: { id: 'sf1', t: 3, name: 'Old count', parts: [['3001', 4, 1]] } } } });
  eq(C.mergeDocs(withLot, older).loose.sf1.name, 'Blue tub', 'the newer copy of a lot wins');
  eq(C.mergeDocs(older, withLot), C.mergeDocs(withLot, older), 'lots merge the same in either order');
  eq(C.mergeDocs(withLot, C.cleanDoc({ catalog: { loose: { sf1: { del: 1, t: 8 } } } })).loose.sf1, { id: 'sf1', t: 8, del: 1 }, 'removing a lot later wins');
  eq(C.mergeDocs(C.cleanDoc({ catalog: { sets: {} } }), withLot).loose.sf1.name, 'Blue tub', 'a catalog from before lots existed merges with one that has them');
  const lotDoc = JSON.stringify({ brickyard: 1, loose: lot });
  const fromLotFile = await C.parseIncoming(lotDoc);
  eq([fromLotFile.kind, fromLotFile.lot], ['loose', lot], 'a loose-pieces file is recognised');
  const lz = 'https://brickyard.junkdrawer.works/#l1z' + zlib.deflateRawSync(Buffer.from(lotDoc)).toString('base64url');
  eq((await C.parseIncoming(lz)).lot, lot, 'a loose-pieces link (#l1z) opens');
  eq((await C.parseIncoming('https://brickyard.junkdrawer.works/#l1j' + Buffer.from(lotDoc).toString('base64url'))).lot, lot, 'and uncompressed (#l1j)');
  let threw = false;
  try { await C.parseIncoming(JSON.stringify({ brickyard: 1, loose: { parts: [] } })); } catch (e) { threw = true; }
  check(threw, 'an empty lot is refused');
  eq((await C.parseIncoming(JSON.stringify({ brickyard: 1, batch: { sets: [{ num: '10698' }] } }))).kind, 'batch', 'a batch of sets is still a batch');

  console.log(failed ? `${failed} failed, ${passed} passed` : `all ${passed} checks passed`);
  process.exit(failed ? 1 : 0);
})();
