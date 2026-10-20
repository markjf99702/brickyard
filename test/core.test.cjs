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
eq(C.setNum('LEGO 10698'), '10698-1', 'a leading LEGO goes');
eq(C.setNum('LEGO® Set No. #10698-2'), '10698-2', 'LEGO, then any run of set, no. and #');
eq(C.setNum('lego10698-1'), '10698-1', 'lego stuck to the number goes too');
eq(C.setNum('set 10698 v2'), '', 'a version written as v2 is not a set number');
eq(C.setNum('LEGO'), '', 'LEGO alone is not a set number');
// A set saved before LEGO was dropped from numbers ("lego10698-1") loads as the plain number, so it gets its
// picture, its parts list and the double warning.
{
  const old = C.cleanDoc({ catalog: { sets: { a: { id: 'a', t: 1, num: 'lego10698-1', name: 'Large Creative Brick Box' } } } });
  eq(old.sets.a.num, '10698-1', 'a set saved as lego10698-1 loads as 10698-1');
  eq((C.findDup(old, C.cleanSet({ num: '10698' })) || {}).id, 'a', 'and is the same set as 10698');
}
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
  check(C.matches(C.cleanSet({ name: 'Bonsai Tree', box: 'Kitchen 2' }), 'box kitchen 2'), 'a box label of two words, with no list of labels');
}
// Moving boxes by label: labels of more than one word, "#" before a number, words after the label, and the
// longest label in the catalog winning, so "box kitchen 2" isn't box "Kitchen" plus a 2 somewhere.
{
  const sets = [
    C.cleanSet({ name: 'Bonsai Tree', box: 'Kitchen 2' }), C.cleanSet({ name: 'Orchid', box: 'kitchen 2' }),
    C.cleanSet({ name: 'Spice Rack', box: 'Kitchen', year: 2012 }),
    C.cleanSet({ name: 'Typewriter', box: '3' }), C.cleanSet({ name: 'Galaxy Explorer', box: '13' }),
  ];
  const labels = sets.map(x => x.box);
  const find = q => sets.filter(x => C.matches(x, q, labels)).map(x => x.name);
  eq(find('box kitchen 2'), ['Bonsai Tree', 'Orchid'], 'box kitchen 2');
  eq(find('Box Kitchen 2'), ['Bonsai Tree', 'Orchid'], 'Box Kitchen 2, whatever the case');
  eq(find('box kitchen'), ['Spice Rack'], 'box kitchen is only that box');
  eq(find('box #3'), ['Typewriter'], 'box #3');
  eq(find('box 3 typewriter'), ['Typewriter'], 'words after the box label are searched as usual');
  eq(find('typewriter box 3'), ['Typewriter'], 'and before it');
  eq(find('box 3 castle'), [], 'every word still has to match');
  eq(find('box 3'), ['Typewriter'], 'box 3 is not box 13');
  eq(find('box 99'), [], 'a box with nothing in it finds nothing');
}
// "Box 5", "box #5" and "#5" typed as a label are all box 5: shown as "Box 5", never "Box Box 5", and found by
// "box 5". Only showing and searching changes; the label is kept as typed.
eq(['Box 5', 'box #5', '#5', '# 5', 'Box5', 'BOX 5', '5', 'Box Kitchen 2', 'Kitchen 2', 'Boxes', 'Box', '#', ''].map(C.boxName),
  ['5', '5', '5', '5', '5', '5', '5', 'Kitchen 2', 'Kitchen 2', 'Boxes', 'Box', '#', ''], 'a box label without Box or # in front');
eq(C.where({ room: 'Office', spot: 'Closet', box: 'Box 5' }), 'Office › Closet · Box 5', 'where: Box 5, not Box Box 5');
eq(C.where({ box: '#5' }), 'Box 5', 'where: #5 is Box 5');
eq(C.cleanSet({ name: 'x', box: 'Box 5' }).box, 'Box 5', 'the label is saved as typed');
{
  const sets = [C.cleanSet({ name: 'Galaxy Explorer', box: 'Box 5' }), C.cleanSet({ name: 'Tree House', box: '#5' }),
    C.cleanSet({ name: 'Typewriter', box: '5' }), C.cleanSet({ name: 'Castle', box: 'Box 15' }), C.cleanSet({ name: 'Orchid', box: 'Box Kitchen 2' })];
  const labels = sets.map(x => x.box);
  const find = q => sets.filter(x => C.matches(x, q, labels)).map(x => x.name);
  eq(find('box 5'), ['Galaxy Explorer', 'Tree House', 'Typewriter'], 'box 5 finds Box 5, #5 and 5');
  eq(find('Box #5'), ['Galaxy Explorer', 'Tree House', 'Typewriter'], 'and so does Box #5');
  eq(find('box 15'), ['Castle'], 'box 15 is still only box 15');
  eq(find('box kitchen 2'), ['Orchid'], 'Box Kitchen 2 is box kitchen 2');
  eq(find('box 5 tree'), ['Tree House'], 'words after a box are searched as usual');
  check(C.matches(sets[0], 'box 5'), 'Box 5 is found with no list of labels');
  check(C.matches(sets[1], '#5'), 'a label is still found as it was typed');
}
// "box" then a word that's neither a box label nor a number is an ordinary search: "creative brick box large"
// finds the Large Creative Brick Box. "box 7" with nothing packed in box 7 still finds nothing.
{
  const sets = [C.cleanSet({ num: '10698', name: 'Large Creative Brick Box' }), C.cleanSet({ name: 'Typewriter', box: '3' }),
    C.cleanSet({ name: 'Bonsai Tree', box: 'Kitchen 2' }), C.cleanSet({ name: 'Spice Rack', box: 'Kitchen' })];
  const labels = sets.map(x => x.box).filter(Boolean);
  const find = q => sets.filter(x => C.matches(x, q, labels)).map(x => x.name);
  eq(find('creative brick box large'), ['Large Creative Brick Box'], 'box then a word that isn’t a box is an ordinary search');
  eq(find('box large'), ['Large Creative Brick Box'], 'and so is box large');
  eq(find('box 7'), [], 'box 7 with nothing in it finds nothing');
  eq(find('box #7'), [], 'nor does box #7');
  eq(find('box 7 typewriter'), [], 'box 7 is still a box with words after it');
  eq(find('box kitchen'), ['Spice Rack'], 'a label is still a box');
  eq(find('box kitchen 2 bonsai'), ['Bonsai Tree'], 'a label of two words, then a word');
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
  // Copying a whole message from Claude brings more than the link or the file along: a sentence around the link,
  // a full stop after it, ```json fences or a line above the file. All of it opens; rubbish is still refused.
  {
    const url = 'https://brickyard.junkdrawer.works/' + z;
    for (const [t, what] of [
      [url + '.', 'a link with a full stop after it'],
      ['Here is your Brickyard link: ' + url + ' Open it and tap Add.', 'a link in a sentence'],
      ['<' + url + '>', 'a link in angle brackets'],
      ['[Open in Brickyard](' + url + ')', 'a link in Markdown'],
      [url + '\nOpen it, check the list, and tap Add.', 'a link with a line after it'],
      ['Or this one: https://brickyard.junkdrawer.works/#batch=' + encodeURIComponent(text) + '.', 'a hand-written link with a full stop after it'],
      ['```json\n' + JSON.stringify(sample, null, 1) + '\n```', 'the file in ```json fences'],
      ['Brickyard batch:\n' + text, 'the file with a line above it'],
      [text + '\n\nThat’s one set.', 'the file with a line after it'],
    ]) {
      let r = null; try { r = await C.parseIncoming(t); } catch (e) { /* refused */ }
      eq(r && [r.kind, r.batch.sets[0].num], ['batch', '10698-1'], what + ' opens');
    }
    for (const t of ['Here is your link: none yet.', 'see {this}', '{"brickyard": 1, "batch": {"sets": []}}']) {
      let refused = false; try { await C.parseIncoming(t); } catch (e) { refused = true; }
      check(refused, 'still refused: ' + t);
    }
  }
  // A link cut short, as a chat app can leave it, is refused like any bad link and never thrown: the page opens
  // links while it starts, and a throw there stopped Brickyard starting at all.
  for (const h of ['#b1zA', '#b1zAAAAA', '#b1jAAAAA', '#l1zA']) {
    for (const [what, open] of [['parseIncoming', t => C.parseIncoming('https://brickyard.junkdrawer.works/' + t)], ['linkText', t => C.linkText(t)]]) {
      let threw = null, refused = false;
      try { await open(h).catch(() => { refused = true; }); } catch (e) { threw = e; }
      check(!threw && refused, what + ' refuses a cut-off link, not throws: ' + h + (threw ? ' (threw ' + threw.message + ')' : ''));
    }
  }

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
    // Set numbers however they're written: the script's set_num and the page's setNum agree.
    const spellings = ['10698', '10698-1', '#10698-2', 'Set 6020', 'set10698', 'No. 10698', 'LEGO 10698', 'Lego set 10698', 'lego10698-1',
      'LEGO® Set No. #10698-2', 'LEGO™ 75192', 'set #no. 10698', 'sw0001a', 'set 10698 v2', 'LEGO', 'hello', '12', 'LEGO-10698'];
    const ascii = t => t.replace(/[\u007f-￿]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
    const pyNums = JSON.parse(execFileSync('python3', ['-c', `
import json, sys, importlib.util
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('mb', sys.argv[1]); mb = importlib.util.module_from_spec(spec); spec.loader.exec_module(mb)
print(json.dumps([mb.set_num(v) for v in json.loads(sys.stdin.read())]))`, path.join(root, 'skill/brickyard-cataloger/scripts/make_brickyard.py')], { input: ascii(JSON.stringify(spellings)), encoding: 'utf8' }));
    eq(pyNums, spellings.map(C.setNum), 'script and page agree on set numbers');
    // And through a whole batch: "LEGO 10497" arrives as 10497-1, so it's found as a double.
    const lego = path.join(dir, 'lego.json');
    fs.writeFileSync(lego, JSON.stringify({ sets: [{ num: 'LEGO 10497', name: 'Galaxy Explorer' }, { num: 'LEGO® Set No. 21318-2', name: 'Tree House' }] }));
    const lo = execFileSync('python3', [path.join(root, 'skill/brickyard-cataloger/scripts/make_brickyard.py'), lego, '--out', dir], { encoding: 'utf8' });
    const legoBatch = (await C.parseIncoming(lo.trim().split('\n').find(l => l.startsWith('https://')))).batch;
    eq(legoBatch.sets.map(x => x.num), ['10497-1', '21318-2'], 'the script drops LEGO from set numbers');
    legoBatch.sets.forEach(x => eq(C.cleanSet(x), x, 'page agrees with script on ' + x.name));
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
  eq(await C.parseIncoming('Stud Finder counted your tub: ' + lz + '. Open it in Brickyard.').then(r => r.lot, () => null), lot, 'a loose-pieces link in a sentence opens');
  let threw = false;
  try { await C.parseIncoming(JSON.stringify({ brickyard: 1, loose: { parts: [] } })); } catch (e) { threw = true; }
  check(threw, 'an empty lot is refused');
  eq((await C.parseIncoming(JSON.stringify({ brickyard: 1, batch: { sets: [{ num: '10698' }] } }))).kind, 'batch', 'a batch of sets is still a batch');

  console.log(failed ? `${failed} failed, ${passed} passed` : `all ${passed} checks passed`);
  process.exit(failed ? 1 : 0);
})();
