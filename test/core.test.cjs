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

// Your pieces, for Build from your box and the home screen's card: a set with a parts list counts when it's taken
// apart, unless its tick says otherwise; a lot counts unless it's unticked; a set's count is its pieces in My sets,
// or with none there, its parts list's.
{
  const index = { '10698-1': 804 };
  const doc = C.cleanDoc({ catalog: {
    sets: {
      box: { id: 'box', t: 1, num: '10698', name: 'Large Creative Brick Box', pieces: 790, state: 'apart' },
      built: { id: 'built', t: 1, num: '10698', state: 'built' },
      other: { id: 'other', t: 1, num: '21318', name: 'Tree House', pieces: 3036, state: 'apart' },
      gone: { id: 'gone', t: 2, del: 1 },
    },
    loose: { tub: { id: 'tub', t: 1, name: 'Tub 10', parts: [['3001', 4, 50], ['3003', 1, 36]] }, bag: { id: 'bag', t: 1, name: 'Tub 2', parts: [['3001', 4, 5]] }, out: { id: 'out', t: 3, del: 1 } },
  } });
  const mine = t => { const y = C.yourPieces(doc, index, t); return [y.sets.map(x => [x.id, x.on, x.pieces]), y.lots.map(x => [x.id, x.on, x.pieces]), y.pieces]; };
  eq(mine({}), [[['box', true, 790], ['built', false, 804]], [['bag', true, 5], ['tub', true, 86]], 881], 'taken-apart sets with a parts list and every lot count; a set with no pieces of its own has its list’s');
  eq(mine({ box: false, built: true, tub: false })[2], 804 + 5, 'the ticks say otherwise');
  eq(mine({ box: false, built: false, tub: false, bag: false })[2], 0, 'everything unticked is no pieces');
  eq(mine({ constructor: false, other: true })[2], 881, 'a tick for something that isn’t listed changes nothing');
  eq(C.yourPieces(doc, {}, null).pieces, 91, 'with no parts lists known, the lots are all there is');
  eq(C.yourPieces(doc, Object.create(null), {}).sets, [], 'and a set number is looked up in the lists only');
  eq(C.yourPieces(C.emptyDoc(), index, {}), { sets: [], lots: [], pieces: 0 }, 'an empty catalog has none');
  eq(C.yourPieces(C.cleanDoc({ catalog: { sets: { a: { id: 'a', num: '10698', state: 'apart' } } } }), index, {}).sets[0].name, 'Set 10698', 'a set with no name is called by its number');
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
// A length typed into a size box: cm unless it says inches, and nothing guessed. measure, which cleaning uses, read
// '14 1/8"' as 14 and "10 in" as 10; the reader the sheets use works inches out and turns down what it can't read.
{
  const len = v => { const r = C.readLength(v); return r.bad ? r.bad : r.inch ? r.cm + ' from inches' : r.cm; };
  eq(['32', '32,5', ' 32.55 ', '32 cm', '32cm', '.5', '32.', 76, 0.04, '', '  ', '0', null, undefined].map(len), [32, 32.5, 32.6, 32, 32, 0.5, 32, 76, 0, 0, 0, 0, 0, 0], 'plain numbers are cm');
  for (const v of ['32', '32,5', ' 32.55 ', '.5', '32.', 76, 500, '0', '', '7,25']) eq(C.readLength(v).cm, C.measure(v), 'a plain ' + JSON.stringify(v) + ' reads as measure reads it');
  eq(['10 in', '10in', '11.5"', '9 7/8"', '14 1/8"', '12 5/8 inches', '12-5/8 in.', '5/8 inch', '12,5 in', '14 1/8”', "14 1/8''", '14 1/8″'].map(len),
    ['25.4 from inches', '25.4 from inches', '29.2 from inches', '25.1 from inches', '35.9 from inches', '32.1 from inches', '32.1 from inches', '1.6 from inches', '31.8 from inches', '35.9 from inches', '35.9 from inches', '35.9 from inches'], 'inches are worked out, to 0.1 cm');
  eq(["1' 2\"", "1'2\"", '1 ft 2 in', "6'", '6 ft', '2 feet 6', '1’ 2”', "5' 10 1/2\""].map(len), ['35.6 from inches', '35.6 from inches', '35.6 from inches', '182.9 from inches', '182.9 from inches', '76.2 from inches', '35.6 from inches', '179.1 from inches'], 'feet and inches');
  eq(['12 5/8', '5/8', 'tall', '32 mm', '1e2', '32 x 40', '32, 40', '-5', '12 5/0"', '10 in 5', '1 2 3', '32 cm.', '"', 'in'].map(len), Array(14).fill('unread'), 'anything else with letters or a slash is turned down');
  eq(['501', '3200', '200 in', "20'"].map(len), ['big', 'big', 'big', 'big'], 'and so is more than 500 cm');
  eq([C.readLength('500'), C.readLength('0"'), C.readLength(true), C.readLength({})], [{ cm: 500 }, { cm: 0 }, { cm: 0 }, { cm: 0 }], 'the edges');
}
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

// Cleaning a set twice gives what cleaning it once gave. Text cut at a field's limit is trimmed again after the cut:
// a cut that landed just after a space used to leave the space on the end, which the next read of the catalog trimmed
// off (a 40-character box label was 39 the second time). And words every object answers to aren't states or tags
// already seen: the state "constructor" came back as a function, and a tag "constructor" was dropped.
{
  const twice = x => C.cleanSet(C.cleanSet(x));
  const label = 'Typewriter theand2015 Typewriter3Galaxy 2'; // its 40th character is a space
  eq([label.charAt(39), C.cleanSet({ name: 'n', box: label }).box], [' ', 'Typewriter theand2015 Typewriter3Galaxy'], 'a cut that lands after a space leaves no space on the end');
  // Every one-line field, with a space as the last character kept and as the first one cut, and text that just fits.
  const LIMITS = { name: 160, theme: 60, room: 60, spot: 60, box: 40, check: 300 };
  const rnd = rng(11), word = () => Array.from({ length: 1 + Math.floor(rnd() * 9) }, () => 'abcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(rnd() * 36)]).join('');
  let stable = 0, kept = 0, n = 0;
  for (let round = 0; round < 60; round++) {
    for (const f of Object.keys(LIMITS)) {
      for (const at of [LIMITS[f] - 1, LIMITS[f], LIMITS[f] + 1]) {
        let t = ''; while (t.length < at - 1) t += word() + (rnd() < 0.3 ? '  ' : ' ');
        t = t.slice(0, at - 1).replace(/ $/, 'x') + ' ' + word() + ' ' + word(); // a space as character number `at`
        const x = { name: 'n', tags: [t, t + ' again'] }; x[f] = t;
        n++;
        if (JSON.stringify(twice(x)) === JSON.stringify(C.cleanSet(x))) stable++;
        const fits = { name: 'n' }; fits[f] = C.cleanSet(x)[f];
        if (C.cleanSet(fits)[f] === fits[f] && fits[f].length <= LIMITS[f] && fits[f] === fits[f].trim()) kept++;
      }
    }
  }
  eq([stable, kept], [n, n], 'cleaning twice is cleaning once, for text cut at each field’s limit');
  const lot = C.cleanLot({ name: 'x'.repeat(79) + ' tub', box: 'y'.repeat(39) + ' 2', parts: [['3001', 4, 1, 'z'.repeat(59) + ' brick']] });
  eq([lot.name, lot.box, lot.parts[0][3]], ['x'.repeat(79), 'y'.repeat(39), 'z'.repeat(59)], 'the same for a lot’s name, its box and a part’s name');
  // A value inside its limit cleans to itself, spaces in the middle and all.
  const whole = { num: '10698-1', name: 'a'.repeat(79) + ' ' + 'b'.repeat(80), theme: 'c'.repeat(29) + ' ' + 'd'.repeat(30), room: 'e'.repeat(60), spot: 'The tall white Billy between the window and the doo, shelf 1', box: 'f'.repeat(38) + ' 2',
    state: 'built', tags: ['g'.repeat(38) + ' h', 'constructor'], check: 'i'.repeat(299) + 'j' };
  check(C.sameDoc(C.cleanSet(whole), whole), 'a set whose text is inside its limits cleans to itself');
  eq([typeof C.state('constructor'), C.state('constructor'), C.state('toString'), C.state('__proto__'), C.state('Taken Apart'), C.state('nib')], ['string', '', '', '', 'apart', 'sealed'], 'a word every object answers to is not a state');
  eq(C.cleanSet({ name: 'O', state: 'constructor', status: 'valueOf' }), { name: 'O' }, 'and a set sent with one has no state');
  eq(C.cleanSet({ name: 'O', tags: ['constructor', 'Constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf', 'toString'] }).tags, ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf'], 'nor a tag that was seen already');
  eq(C.cleanBatch({ batch: { state: 'constructor', sets: [{ name: 'O' }] } }).sets, [{ name: 'O' }], 'nor a batch’s state');
}

// Doubles.
{
  const doc = C.cleanDoc({ catalog: { sets: { a: { id: 'a', t: 1, num: '10698', name: 'Box' }, b: { id: 'b', t: 1, name: 'Custom Castle' }, c: { id: 'c', t: 2, del: 1 } } } });
  eq(C.findDup(doc, C.cleanSet({ num: '10698-1' })).id, 'a', 'same number is a double');
  eq(C.findDup(doc, C.cleanSet({ num: '10698-2' })), null, 'another version is not');
  eq(C.findDup(doc, C.cleanSet({ name: 'custom castle!' })).id, 'b', 'same name with no number');
  eq(C.live(doc).length, 2, 'removed sets are not live');
  eq(C.findDup(doc, C.cleanSet({ name: 'Box' })).id, 'a', 'a name alone finds a set that has a number too');
  // A set owned by name alone is the one that arrives later with its number and that name (it used to be missed, and
  // was added a second time); the set that has the number already comes first; two numbers with one name are two sets.
  eq(C.findDup(doc, C.cleanSet({ num: '10497', name: 'Custom Castle' })).id, 'b', 'a set owned by name alone is found when it arrives with its number');
  eq(C.findDup(doc, C.cleanSet({ num: '10497', name: 'custom-castle' })).id, 'b', 'the names are compared the way they always are');
  eq(C.findDup(doc, C.cleanSet({ num: '10497', name: 'Castle' })), null, 'another name with a number is another set');
  eq(C.findDup(doc, C.cleanSet({ num: '10497' })), null, 'a number alone doesn’t match a set that has none');
  {
    const two = C.cleanDoc({ catalog: { sets: { n: { id: 'n', t: 1, name: 'Bonsai Tree' }, a: { id: 'a', t: 1, num: '10281', name: 'Bonsai Tree' }, f: { id: 'f', t: 1, num: '75192', name: 'Millennium Falcon' } } } });
    eq(C.findDup(two, C.cleanSet({ num: '10281', name: 'Bonsai Tree' })).id, 'a', 'the set with the same number comes before one with only the name');
    eq(C.findDup(two, C.cleanSet({ num: '75257', name: 'Millennium Falcon' })), null, 'two different numbers with one name are not the same set');
  }
  eq(C.findDup(doc, { name: '!!!' }), null, 'a name with nothing to compare matches nothing');
  // Every owned set a new one might be, for telling one copy from two.
  const two = C.cleanDoc({ catalog: { sets: { n: { id: 'n', t: 1, name: 'Bonsai Tree' }, a: { id: 'a', t: 1, num: '10281', name: 'Bonsai Tree' }, a2: { id: 'a2', t: 1, num: '10281', name: 'Bonsai' }, f: { id: 'f', t: 1, num: '75192', name: 'Millennium Falcon' }, g: { id: 'g', t: 3, del: 1 } } } });
  eq(C.findDups(two, C.cleanSet({ num: '10281', name: 'Bonsai Tree' })).map(x => x.id), ['a', 'a2', 'n'], 'findDups: every copy, the ones with the number first');
  eq([C.findDups(two, C.cleanSet({ num: '75192' })).map(x => x.id), C.findDups(two, C.cleanSet({ num: '10497' }))], [['f'], []], 'one copy, and none');
}
// What a row from Claude changes on the set already owned: where it is and its state, from what the row gives, and
// nothing else about it.
{
  const have = C.cleanSet({ num: '21318', name: 'Tree House', year: 2019, pieces: 3036, state: 'built', room: 'Living room', spot: 'Bookcase', notes: 'Mine', missing: 'a leaf', tags: ['ideas'] });
  const up = x => C.updateFor(have, C.cleanSet(Object.assign({ num: '21318' }, x)));
  eq(up({ name: 'Treehouse (Ideas)', year: 2020, pieces: 1, theme: 'Ideas', notes: 'Other', missing: 'none', tags: ['x'], check: 'hm' }), null, 'a row that says nothing new about where it is changes nothing');
  eq(up({ room: 'living room', spot: 'bookcase', state: 'built' }), null, 'the same place and state, typed another way, is no change');
  eq(up({ box: '7', state: 'partial' }), { set: { box: '7', state: 'partial' }, moved: true, state: true, fill: false, after: Object.assign({}, have, { box: '7', state: 'partial' }) }, 'box 7, partly built: only those two change, and the room stays');
  eq(up({ room: 'Office' }).set, { room: 'Office', spot: '' }, 'a new room takes the old shelf off');
  eq([up({ room: 'Office' }).after.spot, up({ room: 'Office' }).after.notes], [undefined, 'Mine'], 'and the rest of the set is as it was');
  eq(up({ room: 'Office', spot: 'Top shelf' }).set, { room: 'Office', spot: 'Top shelf' }, 'a new room and shelf');
  eq(up({ spot: 'Desk' }).set, { spot: 'Desk' }, 'a new shelf in the same room');
  eq(up({ state: 'apart' }), { set: { state: 'apart' }, moved: false, state: true, fill: false, after: Object.assign({}, have, { state: 'apart' }) }, 'a change of state alone is not a move');
  const boxed = C.cleanSet(Object.assign({}, have, { box: 'Box 3' }));
  eq(C.updateFor(boxed, C.cleanSet({ num: '21318', box: '03' })), null, 'the same box under another label is no move');
  eq(C.updateFor(boxed, C.cleanSet({ num: '21318', room: 'Living room', spot: 'Bookcase', state: 'apart' })).set, { state: 'apart' }, 'a row that doesn’t move it leaves its box alone');
  eq(C.updateFor(boxed, C.cleanSet({ num: '21318', room: 'Office', spot: 'Top shelf' })).set, { room: 'Office', spot: 'Top shelf' }, 'moved to another shelf with no box named, it stays in its box: a link never unpacks');
  eq(C.updateFor(boxed, C.cleanSet({ num: '21318', room: 'Office', box: '9' })).set, { room: 'Office', spot: '', box: '9' }, 'another room and another box');
  // A set typed in by name alone gets its number from the row, and its year, pieces and theme where they're blank.
  const named = C.cleanSet({ name: 'Bonsai Tree', year: 2020, room: 'Office', notes: 'Gift' });
  eq(C.updateFor(named, C.cleanSet({ num: '10281', name: 'Bonsai Tree', year: 2021, pieces: 878, theme: 'Icons', notes: 'x' })),
    { set: { num: '10281-1', pieces: 878, theme: 'Icons' }, moved: false, state: false, fill: true, after: Object.assign({}, named, { num: '10281-1', pieces: 878, theme: 'Icons' }) }, 'the number, and the blanks: the year it has is kept');
  eq(C.updateFor(named, C.cleanSet({ num: '10281', name: 'Bonsai Tree', box: '4' })).set, { box: '4', num: '10281-1' }, 'moved and filled in at once');
  eq(C.updateFor(C.cleanSet({ num: '10698' }), C.cleanSet({ num: '10698', name: 'Large Creative Brick Box', year: 2015, pieces: 790 })), null, 'a set that has its number is not filled in');
  eq(C.updateFor(named, C.cleanSet({ name: 'Bonsai Tree', year: 2021, theme: 'Icons' })), null, 'and nothing is filled in from a row with no number');
}
// A set that's in one list twice: the later ones are marked, the first isn't. Told the same way as a double
// with the catalog (same number, or the same name when one of the two has no number), whichever comes first.
const TWICE = [{ num: '10497', name: 'Galaxy Explorer' }, { num: '21318', name: 'Tree House' }, { num: '10497', name: 'Galaxy Explorer', state: 'built' }, { name: 'Mystery Castle' },
  { name: 'mystery castle!' }, { name: 'Tree House' }, { name: 'Bonsai & Friends' }, { num: '10281', name: 'Bonsai and friends' }, { num: '10497-2', name: 'Galaxy Explorer' }, { num: '10497' }, { num: '40000', name: '???' }, { name: '???' }];
const TWICE_WANT = [false, false, true, false, true, true, false, true, false, true, false, false];
eq(C.repeats(TWICE.map(C.cleanSet)), TWICE_WANT, 'which sets in a list are in it again');
eq(C.repeats([]), [], 'an empty list has no repeats');

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
  // Undo after Remove puts the set back timed after its removal, so it survives a merge with a copy (another device,
  // Google Drive) that still holds the removal. The same set from before the removal would be taken away again.
  const gone = C.cleanDoc({ catalog: { sets: { a: { id: 'a', t: 9, del: 1 }, b: { id: 'b', t: 3, name: 'Kept' } } } });
  const back = C.cleanDoc({ catalog: { sets: { a: { id: 'a', t: 10, name: 'Tree House', notes: 'one leaf missing', room: 'Office' } } } });
  const merged = C.mergeDocs(back, gone).sets.a;
  eq([merged.del, merged.t, merged.name, merged.notes, merged.room], [undefined, 10, 'Tree House', 'one leaf missing', 'Office'], 'a set put back after its removal survives a merge with the removal');
  eq(C.mergeDocs(gone, back), C.mergeDocs(back, gone), 'whichever way round they merge');
  eq(C.mergeDocs(C.mergeDocs(back, gone), gone).sets.a.name, 'Tree House', 'and again when the removal comes round once more');
}

// Search.
{
  const x = C.cleanSet({ num: '21327', name: 'Typewriter', room: 'Office', box: '3', state: 'partial' });
  check(C.matches(x, 'type office'), 'search matches several words');
  check(C.matches(x, 'box 3'), 'search finds a moving box');
  check(C.matches(x, 'partly'), 'search finds the state');
  check(!C.matches(x, 'castle'), 'search misses');
  // The Check note is searched like the other notes (it wasn't: "blurry" found nothing); piece counts and sizes aren't.
  {
    const unsure = C.cleanSet({ num: '42115', name: 'Lamborghini', pieces: 3696, size: { w: 60, d: 25, h: 13 }, check: 'number read from a blurry corner; could be 42083' });
    check(C.matches(unsure, 'blurry', []), 'search looks in a set’s Check note');
    check(C.matches(unsure, 'lamborghini 42083', []), 'with other words too');
    check(C.matches(unsure, 'to check', []), 'and "to check" still finds it');
    check(!C.matches(unsure, '3696', []) && !C.matches(unsure, '60', []), 'but not in its piece count or its size');
  }
  check(C.matches(C.cleanSet({ name: 'Bonsai Tree', box: 'Kitchen 2' }), 'box kitchen 2'), 'a box label of two words, with no list of labels');
}
// Search reads a name the way it's said, not the way it's punctuated: an accent, a curly or straight apostrophe, a
// hyphen or a full stop in the name (or in what's typed) doesn't stop a set being found.
{
  const sets = ['Lamborghini Sián FKP 37', 'Parisian Restaurant', 'Real Madrid – Santiago Bernabéu Stadium', 'Luke Skywalker\'s X-wing Fighter',
    'Lion Knights’ Castle', 'Dom’s Dodge Charger', 'Santa\'s Visit', 'Detective\'s Office', 'AT-AT', 'PAC-MAN Arcade', 'R2-D2', 'Fantasy Forest Creatures 3-in-1',
    'Typewriter'].map(name => C.cleanSet({ name }));
  const find = q => sets.filter(x => C.matches(x, q, [])).map(x => x.name);
  eq(find('sian'), ['Lamborghini Sián FKP 37', 'Parisian Restaurant'], 'an accent in the name: sian finds Sián');
  eq(find('SIÁN'), ['Lamborghini Sián FKP 37', 'Parisian Restaurant'], 'and one typed finds the name with or without it');
  eq(find('bernabeu'), ['Real Madrid – Santiago Bernabéu Stadium'], 'bernabeu');
  eq(find('skywalker’s'), ['Luke Skywalker\'s X-wing Fighter'], 'a curly apostrophe typed (as an iPhone does) finds a straight one');
  eq(find('dom\'s'), ['Dom’s Dodge Charger'], 'and a straight one finds a curly one');
  eq(find('knights’'), ['Lion Knights’ Castle'], 'knights’');
  eq(find('doms'), ['Dom’s Dodge Charger'], 'no apostrophe at all');
  eq(find('santas visit'), ['Santa\'s Visit'], 'santas');
  eq(find('detectives office'), ['Detective\'s Office'], 'detectives office');
  eq(find('xwing'), ['Luke Skywalker\'s X-wing Fighter'], 'xwing without its hyphen');
  eq(find('x-wing'), ['Luke Skywalker\'s X-wing Fighter'], 'and with it');
  eq(find('atat'), ['AT-AT'], 'atat');
  eq(find('pacman'), ['PAC-MAN Arcade'], 'pacman');
  eq(find('r2d2'), ['R2-D2'], 'r2d2');
  eq(find('3in1'), ['Fantasy Forest Creatures 3-in-1'], '3in1');
  eq(find('3-in-1 forest'), ['Fantasy Forest Creatures 3-in-1'], 'several words, one with hyphens');
  eq(find('type-writer'), ['Typewriter'], 'a hyphen typed where the name has none');
  eq(find('-'), ['Real Madrid – Santiago Bernabéu Stadium', 'Luke Skywalker\'s X-wing Fighter', 'AT-AT', 'PAC-MAN Arcade', 'R2-D2', 'Fantasy Forest Creatures 3-in-1'], 'punctuation alone still has to be there (a dash of any kind)');
  eq(find('castle xwing'), [], 'every word still has to match');
  const boxed = C.cleanSet({ name: 'Dom’s Dodge Charger', box: 'Café 2' });
  check(C.matches(boxed, 'box café 2 doms', ['Café 2']), 'words after a box label are read the same way');
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
// Search as it's typed on a phone: a plural finds the singular, the screen's own words find what they name, a
// number's "-1" isn't read as one more digit, and a box can be asked for as "box3", "box 03" or a question.
{
  const sets = [
    C.cleanSet({ num: '76391', name: 'Hogwarts Icons - Collectors\' Edition', box: '3' }), C.cleanSet({ num: '10295', name: 'Porsche 911', box: '3', check: 'or the 42096?' }),
    C.cleanSet({ num: '10280', name: 'Flower Bouquet', box: '03', missing: 'one leaf' }), C.cleanSet({ num: '76187', name: 'Venom', theme: 'Helmet Collection' }),
    C.cleanSet({ num: '75192', name: 'Millennium Falcon', box: 'Kitchen 2', notes: 'in the hall' }), C.cleanSet({ num: '10305', name: 'Lion Knights\' Castle', room: 'Classroom' }),
    C.cleanSet({ name: 'Battle Pack', box: '12' }),
  ];
  const labels = sets.map(x => x.box).filter(Boolean);
  const find = q => sets.filter(x => C.matches(x, q, labels)).map(x => x.name.split(' ')[0]);
  eq(find('911'), ['Porsche'], '911 is the Porsche, not set 76391-1');
  eq([find('76391'), find('76391-1'), find('7639')], [['Hogwarts'], ['Hogwarts'], ['Hogwarts']], 'a number is still found, with its -1 or by its start');
  eq([find('flowers'), find('helmets'), find('castles'), find('bouquets'), find('boxes')], [['Flower'], ['Venom'], ['Lion'], ['Flower'], ['Hogwarts', 'Porsche', 'Flower', 'Millennium', 'Battle']], 'a plural finds the singular ("boxes" finds what is in a box)');
  eq([find('class'), find('icons'), find('bus')], [['Lion'], ['Hogwarts'], []], 'a word that is there as typed is found as before, and a short one is left alone');
  eq([find('missing'), find('missing pieces'), find('check'), find('to check')], [['Flower'], ['Flower'], ['Porsche'], ['Porsche']], 'the words on the chips find what the chips show');
  eq([find('not packed'), find('not packed castle'), find('pack'), find('packed')], [['Venom', 'Lion'], ['Lion'], ['Battle'], []], 'not packed is the sets with no box, and "pack" is still only a word');
  eq([find('lego 75192'), find('LEGO millennium falcon'), find('lego')], [['Millennium'], ['Millennium'], []], 'LEGO in front of a search is dropped');
  eq([find('box3'), find('box 03'), find('Box #03'), find('box 3')], Array(4).fill(['Hogwarts', 'Porsche', 'Flower']), 'box3 and box 03 are box 3, and so is the box labelled 03');
  eq([find('in box 3'), find('what’s in box 3'), find('whats in box 3'), find('sets in box 3'), find('box 3 sets')], Array(5).fill(['Hogwarts', 'Porsche', 'Flower']), 'a box asked for as a question');
  eq([find('what’s in box kitchen 2'), find('in box 3 porsche'), find('lego box 12')], [['Millennium'], ['Porsche'], ['Battle']], 'with a label of two words, a word after it, or LEGO in front');
  eq([C.boxSearch('what’s in box 3', labels), C.boxSearch('box 3 sets', labels), C.boxSearch('in box 3 porsche', labels)], [{ label: '03', rest: '' }, { label: '03', rest: '' }, { label: '03', rest: 'porsche' }], 'what is left to search for');
  eq([find('in the'), find('falcon in')], [['Millennium'], ['Millennium']], '"in" away from a box is a word like any other');
  eq([find('box 7'), find('box7'), find('in box 7'), C.boxSearch('brick box 10698', labels)], [[], [], [], { label: null, rest: 'brick' }], 'a box nothing is packed in still finds nothing: not the packed sets with a 7 in them');
  // "box" and a number no box is labelled with is searched as words, so a set with Box in its name is found by it.
  {
    const more = sets.concat([C.cleanSet({ num: '10698', name: 'Large Creative Brick Box', state: 'apart' }), C.cleanSet({ num: '11021', name: 'Bricks Bricks Plates', box: 'Box 10' })]);
    const all = more.map(x => x.box).filter(Boolean), look = q => more.filter(x => C.matches(x, q, all)).map(x => x.name.split(' ')[0]);
    eq([look('brick box 10698'), look('box 10698'), look('creative box 106')], [['Large'], ['Large'], ['Large']], 'no box is labelled 10698, so "brick box 10698" is the Brick Box');
    eq([look('box 10'), look('brick box 10'), look('box 3 brick')], [['Bricks'], ['Bricks'], []], 'a box that is there is still that box, whatever else has the words');
    eq([look('box 7'), look('box 99')], [[], []], 'and one that is not finds only sets that say box themselves');
    eq(look('box 1'), ['Large', 'Bricks'], 'which the Brick Box 10698 does, and a label typed as "Box 10"');
  }
  eq([C.inBox(sets[2], '3'), C.inBox(sets[3], '3'), C.inBox(sets[4], 'kitchen 2')], [true, false, true], 'inBox matches a label the way boxes are grouped');
}

// Moving boxes: how the packing stands, and what a set going into or out of a box did to the boxes.
{
  const doc = C.cleanDoc({ sets: {
    a: { id: 'a', t: 1, num: '10334', name: 'Retro Radio', box: 'Box 03' }, b: { id: 'b', t: 1, num: '10311', name: 'Orchid', box: '3' },
    c: { id: 'c', t: 1, num: '21327', name: 'Typewriter', box: '12' }, d: { id: 'd', t: 1, num: '10281', name: 'Bonsai Tree' },
    e: { id: 'e', t: 2, del: 1 } },
  loose: { l: { id: 'l', t: 1, name: 'Red bag', box: '20', parts: [['3001', 4, 10]] }, m: { id: 'm', t: 1, name: 'Blue tub', box: '#3', parts: [['3001', 1, 5]] } } });
  eq(C.packing(doc), { packed: 3, toPack: 1, boxes: 2, all: 3 }, 'three sets packed in two boxes, one to pack, and a third box of loose pieces');
  eq(C.packing(C.emptyDoc()), { packed: 0, toPack: 0, boxes: 0, all: 0 }, 'nothing packed in an empty catalog');
  eq([C.sameBox('3', 'box 03'), C.sameBox('3', '#3'), C.sameBox('3', '13'), C.sameBox('', '')], [true, true, false, false], 'one box under several spellings');
  eq([C.boxHolds(doc, 'box 3').sets.map(x => x.id), C.boxHolds(doc, '3').lots.map(x => x.id), C.boxHolds(doc, '03').name, C.boxHolds(doc, '#20').name, C.boxHolds(doc, 'box 9').name], [['b', 'a'], ['m'], 'Box 3', 'Box 20', 'Box 9'], 'what a box holds, by name, and what it is called: as the first set in it has it');
  eq([C.boxNews(doc, '', ''), C.boxNews(doc, '3', 'Box 03'), C.boxNews(doc, 'Hall', 'hall')], ['', '', ''], 'no news when the set stayed where it was');
  eq(C.boxList(doc, 'Box 3'), 'Box 3 · 2 sets · 5 loose pieces\n10311 Orchid\n10334 Retro Radio\nBlue tub · 5 loose pieces', 'a box’s list as text, by name');
  eq(C.boxList(C.cleanDoc({ sets: { a: { id: 'a', t: 1, name: 'Castle', state: 'apart', box: 'Attic' }, b: { id: 'b', t: 1, num: '21318', state: 'built', box: 'attic' } } }), 'attic'), 'Box attic · 2 sets\n21318 · Built\nCastle · Taken apart', 'with each set’s state, and a set with only a name or only a number');
  eq(C.boxList(doc, '20'), 'Box 20 · 10 loose pieces\nRed bag · 10 loose pieces', 'a box of only loose pieces');
  eq(C.boxNews(doc, '', '3'), 'Box 3 holds 2 sets now.', 'into a box');
  eq(C.boxNews(doc, '', '12'), 'Box 12 holds 1 set now.', 'the first set in a box');
  eq(C.boxNews(doc, '3', ''), '2 sets still in Box 3.', 'out of a box with sets left in it');
  eq(C.boxNews(doc, '7', ''), 'Box 7 is empty now.', 'the last set out of a box');
  eq(C.boxNews(doc, '20', ''), 'Only loose pieces are left in Box 20.', 'a box left with loose pieces is not called empty');
  eq([C.boxNews(doc, '', '12', true), C.boxNews(doc, '7', '12', true), C.boxNews(doc, '3', '', true), C.boxNews(doc, '20', '', true)], ['', 'Box 7 is empty now.', '2 sets still in Box 3.', 'Only loose pieces are left in Box 20.'], 'loose pieces moved: no box is said to hold another set');
  eq(C.boxNews(doc, 'Box 7', '#12'), 'Box 12 holds 1 set now. Box 7 is empty now.', 'from one box to another');
  eq(C.boxNews(C.cleanDoc({ sets: { d: { id: 'd', t: 1, name: 'Bonsai Tree' } } }), '7', ''), 'That was the last moving box.', 'nothing packed anywhere any more');
  eq(C.boxNews(C.cleanDoc({ sets: { d: { id: 'd', t: 1, name: 'Bonsai Tree' } }, loose: { l: { id: 'l', t: 1, box: '20', parts: [['3001', 4, 10]] } } }), '7', ''), 'Box 7 is empty now.', 'a box of loose pieces is still a box packed');
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

  // Why something couldn't be read, so the page can say what to do. One of Brickyard's links that doesn't unpack
  // is 'cut' (cut short, or a character changed on the way); a link of a later format than this page knows is
  // 'newer'; anything else isn't a Brickyard link, and has no `why`.
  {
    const why = async t => { try { await C.parseIncoming(t); return 'opened'; } catch (e) { return e.why || 'not Brickyard'; } };
    const pack = o => zlib.deflateRawSync(Buffer.from(JSON.stringify(o))).toString('base64url');
    const site = 'https://brickyard.junkdrawer.works/';
    // Cut anywhere, a link says it's cut: every length of the compressed link, and of the others.
    for (const [link, what] of [[z, '#b1z'], [j, '#b1j'], ['#batch=' + encodeURIComponent(text), '#batch=']]) {
      const got = {};
      for (let n = what.length + 1; n < link.length; n++) { const w = await why(site + link.slice(0, n)); (got[w] = got[w] || []).push(n); }
      eq(Object.keys(got), ['cut'], 'a ' + what + ' link cut at any length is cut' + (got.cut && Object.keys(got).length === 1 ? '' : ': ' + JSON.stringify(got).slice(0, 200)));
      eq(await why(site + link), 'opened', 'and whole, it opens');
    }
    const kinds = { '#l1z': { brickyard: 1, loose: { name: 'Tub', parts: [['3001', 4, 12]] } }, '#z1z': { brickyard: 1, sizes: [{ num: '10497', w: 52, d: 32, h: 13 }] }, '#d1z': { brickyard: 1, model: { parts: [['3001', 4, 0, 0, 0, 0, 1]] } } };
    for (const p in kinds) {
      const link = site + p + pack(kinds[p]);
      eq([await why(link), await why(link.slice(0, link.length - 6)), await why('Here: ' + link.slice(0, 60) + '. Open it.')], ['opened', 'cut', 'cut'], 'a ' + p + ' link whole, cut at the end, and cut in a sentence');
    }
    eq(await why(site + z.slice(0, 30) + '!' + z.slice(31)), 'cut', 'a link with a character that can’t be in one');
    eq(await why(site + '#batch=%7B%22sets%22%3A%5B%7B%22num%22%3A%2210698%22%7D%5D%7D').then(w => w), 'opened', 'a hand-written link opens');
    eq(await why(site + '#batch=%7B%22sets%22%3A%5B%7B%22num%E0%A4%A'), 'cut', 'a hand-written link cut inside a %-escape');
    let lt = null; try { await C.linkText(z.slice(0, z.length - 4)); } catch (e) { lt = e; }
    eq(lt && lt.why, 'cut', 'linkText says cut too');
    // A whole link with a dash or an underscore stuck to its end opens: markdown's _link_, "link- open it". Those
    // are characters a link is made of, so they were taken as part of it, and about one time in three it then didn't
    // unpack and was turned down as cut short. A link that really is cut is still cut, with them after it or not.
    {
      const rnd = rng(5);
      let opened = 0, tried = 0, stillCut = 0, cuts = 0, ownEnd = 0;
      for (let i = 0; i < 60; i++) {
        const doc = { brickyard: 1, batch: { sets: Array.from({ length: 1 + i % 5 }, (_, k) => ({ num: String(10000 + Math.floor(rnd() * 80000)), name: 'Set ' + Math.floor(rnd() * 1e9).toString(36), room: 'Room ' + (k + i) })) } };
        const want = JSON.stringify((await C.parseIncoming(JSON.stringify(doc))).batch);
        for (const link of [site + '#b1z' + pack(doc), site + '#b1j' + Buffer.from(JSON.stringify(doc)).toString('base64url')]) {
          if (/[-_]$/.test(link)) ownEnd++;
          for (const t of ['_' + link + '_', link + '_', link + '- open it', link + '-', 'Here it is: __' + link + '__', '**' + link + '-_-**']) {
            tried++;
            const r = await C.parseIncoming(t).catch(() => null);
            if (r && JSON.stringify(r.batch) === want) opened++;
          }
          for (const t of [link.slice(0, link.length - 7) + '_', '_' + link.slice(0, link.length - 11) + '_', link.slice(0, 60) + '--', link.slice(0, link.length - 9) + '-_-']) {
            cuts++;
            if (await why(t) === 'cut') stillCut++;
          }
        }
      }
      eq([opened, stillCut], [tried, cuts], 'a whole link with - or _ stuck to its end opens, and a cut one is still cut');
      check(ownEnd > 0, 'some of those links end in - or _ themselves (' + ownEnd + ')');
      for (const p in kinds) eq([await why('_' + site + p + pack(kinds[p]) + '_'), await why(site + p + pack(kinds[p]) + '-')], ['opened', 'opened'], 'the same for a ' + p + ' link');
    }
    // The checked form: a 2 where the others have a 1, and a check of seven characters on the end (linkCheck).
    // Whole, it opens as the same thing the unchecked link does, for every kind, in a sentence or in markdown.
    {
      const checked = (kind, data) => '#' + kind + data + C.linkCheck(kind + data);
      const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
      const z2 = checked('b2z', z.slice(4)), j2 = checked('b2j', j.slice(4));
      const want = JSON.stringify((await C.parseIncoming(site + z)).batch);
      for (const [t, what] of [[site + z2, '#b2z'], [site + j2, '#b2j'], ['Here: ' + site + z2 + '. Open it.', '#b2z in a sentence'], ['_' + site + j2 + '_', '#b2j in markdown'], ['**' + site + z2 + '-_-**', '#b2z with dashes after it']]) {
        const r = await C.parseIncoming(t).catch(e => e);
        eq(r && r.batch && JSON.stringify(r.batch), want, 'a checked link opens: ' + what);
      }
      for (const p in kinds) {
        const kind = p.slice(1, 2) + '2', doc = kinds[p];
        const a = await C.parseIncoming(site + p + pack(doc)), b = await C.parseIncoming(site + checked(kind + 'z', pack(doc))).catch(() => null), c = await C.parseIncoming(checked(kind + 'j', b64(doc))).catch(() => null);
        eq([JSON.stringify(b), JSON.stringify(c)], [JSON.stringify(a), JSON.stringify(a)], 'checked ' + kind + 'z and ' + kind + 'j links open as the unchecked one does');
      }
      eq(C.linkCheck('b2zabc').length + C.linkCheck('').length, 14, 'the check is always seven characters');
      // One changed character anywhere after the #, to any other character a link is made of, is refused as
      // 'wrong'. In an unchecked uncompressed link the same slip can open as a different set without a word, which
      // is what the check is for: #b1j with the 9 of 10698 turned into an 8 opens, as 10688.
      const slip = (link, i, ch) => link.slice(0, i) + ch + link.slice(i + 1);
      const at = j.indexOf(Buffer.from('{"num":"10698').toString('base64url').slice(0, 4));
      let silent = 0;
      for (let i = 4; i < j.length; i++) for (const ch of 'AQgw048') {
        if (j[i] === ch) continue;
        const r = await C.parseIncoming(site + slip(j, i, ch)).catch(() => null);
        if (r && r.kind === 'batch' && JSON.stringify(r.batch) !== want) silent++;
      }
      check(silent > 0 && at !== 0, 'an unchecked link with one wrong character can open as something else (' + silent + ' ways here)');
      const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
      for (const link of [z2, j2]) {
        const got = {};
        for (let i = 1; i < link.length; i++) for (let k = 0; k < 5; k++) {
          const ch = letters[(i * 7 + k * 13) % 64];
          if (ch === link[i]) continue;
          const r = await C.parseIncoming(site + slip(link, i, ch)).catch(e => e);
          const w = r.kind ? (JSON.stringify(r.batch) === want ? 'same' : 'changed') : r.why || 'not Brickyard';
          got[w] = (got[w] || 0) + 1;
        }
        // The three characters after the # are the kind. Changed, they can make it no link of Brickyard's, or one
        // of a format not known yet ('newer'); and the 2 changed to a 1 makes it an unchecked link with the check
        // left on the end of its data, which is refused or opens as just what was sent. Never as anything else.
        check(!got.changed && (got.same || 0) <= 1 && got.wrong > link.length * 4, 'a checked link with one wrong character never opens changed: ' + JSON.stringify(got));
        const cut = {};
        for (let n = 5; n < link.length; n++) { const w = await why(site + link.slice(0, n)); cut[w] = (cut[w] || 0) + 1; }
        eq(Object.keys(cut), ['wrong'], 'and cut short at any length, it is refused');
        eq([await why(site + link.slice(0, 40) + link.slice(41)), await why(site + link.slice(0, 40) + 'A' + link.slice(40))], ['wrong', 'wrong'], 'so is one with a character missing or one too many');
      }
      let lt = null; try { await C.linkText(slip(z2, 20, z2[20] === 'A' ? 'B' : 'A')); } catch (e) { lt = e; }
      eq(lt && lt.why, 'wrong', 'linkText says wrong too');
    }
    // A later format: # then a letter, a number, and z or j, where the letter isn't known with that number, with a
    // link's worth of data after it.
    for (const t of [site + '#b3z' + z.slice(4), '#q7j' + j.slice(4), '#q2z' + z.slice(4), 'Open this: ' + site + '#d3z' + pack(kinds['#d1z']) + '.']) {
      eq([await why(t), C.newerLink(t)], ['newer', true], 'a link of a newer format: ' + t.slice(0, 50));
    }
    // Not Brickyard's at all, or whole but holding nothing: no `why`, so the page keeps its plain words.
    for (const t of ['not json', 'see {this}', 'https://example.com/page#top', 'https://example.com/#a2z-list', 'tag #b2z', '{"brickyard": 1, "batch": {"sets": [{"num"',
      '{"brickyard": 1, "batch": {"sets": []}}', site + '#b1z' + pack({ brickyard: 1, batch: { sets: [] } }), site + '#l1z' + pack({ brickyard: 1, loose: { parts: [] } })]) {
      eq([await why(t), C.newerLink(t)], ['not Brickyard', false], 'no reason given for: ' + t.slice(0, 60));
    }
    // A model with or without its wrapper is a model, wherever it's pasted; a batch is still a batch.
    const bare = { name: 'T', sets: ['10698-1'], parts: [['3001', 4, 0, 0, 0, 0, 1]] };
    for (const [t, what] of [[JSON.stringify(bare), 'the model file as the designer skill writes it'], [JSON.stringify({ brickyard: 1, model: bare }), 'a wrapped model'],
      [site + '#d1z' + pack({ brickyard: 1, model: bare }), 'a model link'], ['```json\n' + JSON.stringify(bare, null, 1) + '\n```', 'a model in fences']]) {
      const r = await C.parseIncoming(t).catch(() => null);
      eq(r && [r.kind, (r.doc.model || r.doc).parts.length], ['model', 1], what + ' is a model');
    }
    eq((await C.parseIncoming(JSON.stringify({ sets: [{ num: '10698', parts: 790 }] }))).kind, 'batch', 'sets with a piece count under "parts" are still a batch');
  }

  let py = true; try { execFileSync('python3', ['--version']); } catch (e) { py = false; }
  if (py) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brickyard-'));
    const out = execFileSync('python3', [path.join(root, 'skill/brickyard-cataloger/scripts/make_brickyard.py'), path.join(root, 'test/fixtures/sample.json'), '--out', dir], { encoding: 'utf8' });
    const link = out.trim().split('\n').find(l => l.startsWith('https://'));
    check(/^https:\/\/brickyard\.junkdrawer\.works\/#b2z[A-Za-z0-9_-]+$/.test(link), 'the script writes a checked link (#b2z)');
    const fromLink = await C.parseIncoming(link);
    eq(await C.parseIncoming(link.slice(0, 60) + (link[60] === 'A' ? 'B' : 'A') + link.slice(61)).catch(e => e.why), 'wrong', 'and the page refuses it with one character changed');
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
    // A set in the list twice is marked [twice] next to it in the script's summary, on the same sets the page's
    // review marks "Also above in this list".
    const twiceFile = path.join(dir, 'twice.json');
    fs.writeFileSync(twiceFile, JSON.stringify({ sets: TWICE }));
    const summary = execFileSync('python3', [path.join(root, 'skill/brickyard-cataloger/scripts/make_brickyard.py'), twiceFile, '--out', dir, '--no-link'], { encoding: 'utf8' });
    const lines = summary.split('\n').filter(l => /^ {2}\s*\S/.test(l));
    eq(lines.map(l => /\[twice\]/.test(l)), TWICE_WANT, 'the script marks the same sets [twice] as the page does');
    eq((summary.match(/^WARNING: .* is in the list twice/gm) || []).length, TWICE_WANT.filter(Boolean).length, 'with a warning for each');
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
    // Numbers that end in a half: the script rounds them as the page does (Math.round: a half goes up). Python's
    // round sent 790.5 pieces to 790 where the page has 791, dropped the year 1948.5 that the page keeps as 1949,
    // and made 12.25 x 0.15 x 6.35 cm 12.2 x 0.1 x 6.3 where the page has 12.3 x 0.2 x 6.4. Sizes that end in 5
    // hundredths come from inches (2.5 in is 6.35 cm).
    const callPy = (expr, input) => JSON.parse(execFileSync('python3', ['-c', `
import json, sys, importlib.util
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('mb', sys.argv[1]); mb = importlib.util.module_from_spec(spec); spec.loader.exec_module(mb)
print(json.dumps([${expr} for v in json.loads(sys.stdin.read())]))`, path.join(root, 'skill/brickyard-cataloger/scripts/make_brickyard.py')], { input: JSON.stringify(input), encoding: 'utf8', maxBuffer: 1 << 26 }));
    const halves = [
      { num: '10698', pieces: 790.5, year: 1948.5, size: { w: 12.25, d: 0.15, h: 6.35 } },
      { num: '10698', pieces: 2.5, year: 2014.5, size: { w: 19.05, d: 0.25, h: 499.95 } },
      { num: '10698', pieces: 20000.5, year: 2100.5, size: { w: 500.05, d: 0.05, h: 0.04 } },
      { num: '10698', pieces: 0.5, year: 1948.4, size: { w: 1.005, d: 2.675, h: 8.345 } },
      { num: '10698', pieces: -0.5, year: -1948.5, size: { w: -0.05, d: 0, h: 3 } },
      // A value inside its limits cleans to itself, on the page and in the script.
      { num: '10698', pieces: 790, year: 2015, size: { w: 12.3, d: 0.2, h: 6.4 } },
      { num: '10698', pieces: 20000, year: 1949, size: { w: 500, d: 0.1, h: 499.9 } },
    ];
    eq(C.cleanSet(halves[0]), { num: '10698-1', year: 1949, pieces: 791, size: { w: 12.3, d: 0.2, h: 6.4 } }, 'the page rounds a half up');
    const pySets = callPy('mb.clean(v, 0, [])', halves);
    halves.forEach((x, i) => check(C.sameDoc(pySets[i], C.cleanSet(x)), 'script and page agree on ' + JSON.stringify(x) + '\n    script ' + JSON.stringify(pySets[i]) + '\n    page   ' + JSON.stringify(C.cleanSet(x))));
    for (const i of [5, 6]) check(C.sameDoc(pySets[i], Object.assign({}, halves[i], { num: '10698-1' })), 'a set inside its limits comes through the script as it went in: ' + JSON.stringify(pySets[i]));
    // Every size from 0.01 to 500.10 cm by hundredths, and every half from 0.5 to 20,001.5 as a count.
    const cms = Array.from({ length: 50010 }, (_, i) => (i + 1) / 100), counts = Array.from({ length: 20002 }, (_, i) => i + 0.5);
    const pyCm = callPy('mb.measure(v)', cms), jsCm = cms.map(C.measure), offCm = cms.filter((v, i) => pyCm[i] !== jsCm[i]);
    eq([offCm.length, offCm.slice(0, 5)], [0, []], 'script and page give the same cm for all ' + cms.length.toLocaleString() + ' sizes');
    const pyN = callPy('mb.whole(v, 0, 20000)', counts), offN = counts.filter((v, i) => pyN[i] !== (C.cleanSet({ name: 'x', pieces: v }).pieces || 0));
    eq([offN.length, offN.slice(0, 5)], [0, []], 'and the same whole number for every half');
    // The script trims text again after cutting it, as the page does, and has no state or tag of its own for the
    // words every object answers to.
    const edges = [
      { name: 'n', box: 'Typewriter theand2015 Typewriter3Galaxy 2', room: 'r'.repeat(59) + ' 2', spot: 's'.repeat(59) + '  shelf', theme: 't'.repeat(59) + ' u', check: 'c'.repeat(299) + ' d' },
      { name: 'x'.repeat(159) + ' y', tags: ['constructor', 'g'.repeat(39) + ' h', 'toString', 'Constructor'], state: 'constructor' },
      { num: '10698-1', name: 'a'.repeat(79) + ' ' + 'b'.repeat(80), room: 'e'.repeat(60), spot: 'The tall white Billy between the window and the doo, shelf 1', box: 'f'.repeat(38) + ' 2', state: 'built', tags: ['g'.repeat(38) + ' h'] },
    ];
    const pyEdges = callPy('mb.clean(v, 0, [])', edges);
    edges.forEach((x, i) => check(C.sameDoc(pyEdges[i], C.cleanSet(x)), 'script and page agree on text cut at its limit, set ' + (i + 1) + '\n    script ' + JSON.stringify(pyEdges[i]) + '\n    page   ' + JSON.stringify(C.cleanSet(x))));
    check(C.sameDoc(pyEdges[2], edges[2]), 'and text inside its limits comes through the script as it went in');
    // A file the script can't use ends in its own words, not a Python traceback: one that is a bare string or number
    // has no sets in it. A number too big to be one (1e999, which both Python and the page read as infinity) is 0
    // to both, so the set comes through without it.
    const runPy = (name, text) => {
      const f = path.join(dir, name);
      fs.writeFileSync(f, text);
      const r = require('child_process').spawnSync('python3', ['-B', path.join(root, 'skill/brickyard-cataloger/scripts/make_brickyard.py'), f, '--out', dir, '--no-link'], { encoding: 'utf8' });
      return [r.status, r.stderr.trim(), r.stdout];
    };
    for (const [name, text] of [['string.json', '""'], ['words.json', '"10698"'], ['number.json', '5'], ['null.json', 'null'], ['true.json', 'true'], ['batch.json', '{"batch":"10698"}']]) {
      eq(runPy(name, text).slice(0, 2), [1, 'Expected {"sets": [...]} (or a plain list of sets).'], 'the script says what it expected of a file that is ' + text);
    }
    const huge = '{"name":"Huge","sets":[{"num":"1234567","pieces":-1e999,"year":1e999,"size":{"w":1e999,"d":5,"h":-1e999}},{"num":"10698","pieces":1e999}]}';
    const hugeRun = runPy('huge.json', huge);
    eq(hugeRun.slice(0, 2), [0, ''], 'a number too big to be one doesn’t stop the script');
    const hugeSets = JSON.parse(fs.readFileSync(path.join(dir, 'huge.brickyard.json'), 'utf8')).batch.sets;
    eq(hugeSets, [{ num: '1234567-1', size: { w: 0, d: 5, h: 0 } }, { num: '10698-1' }], 'it reads as 0, so it’s left out');
    eq((await C.parseIncoming(huge)).batch.sets, hugeSets, 'as the page reads the same file');
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

  // Sizes and models from Claude, opened or pasted in My sets, are recognised and handed on as they are, for the shelf
  // planner and Build from your box to read: the files, and their links in a sentence.
  const sizesDoc = { brickyard: 1, sizes: [{ num: '10497', w: 51, d: 25, h: 33 }] };
  const modelDoc = JSON.parse(fs.readFileSync(path.join(root, 'models/cottage.json'), 'utf8'));
  const deflated = o => zlib.deflateRawSync(Buffer.from(JSON.stringify(o))).toString('base64url');
  for (const [t, kind, doc, what] of [
    [JSON.stringify(sizesDoc, null, 1), 'sizes', sizesDoc, 'a sizes file'],
    [JSON.stringify(modelDoc), 'model', modelDoc, 'a model file'],
    ['Here are the sizes: https://brickyard.junkdrawer.works/#z1z' + deflated(sizesDoc) + '. Tap Add sizes.', 'sizes', sizesDoc, 'a sizes link'],
    ['https://brickyard.junkdrawer.works/#z1j' + Buffer.from(JSON.stringify(sizesDoc)).toString('base64url'), 'sizes', sizesDoc, 'an uncompressed sizes link'],
    ['Open it: https://brickyard.junkdrawer.works/#d1z' + deflated(modelDoc), 'model', modelDoc, 'a model link'],
  ]) {
    let r = null; try { r = await C.parseIncoming(t); } catch (e) { /* refused */ }
    eq(r && [r.kind, r.doc], [kind, doc], what + ' is recognised');
  }
  eq((await C.parseIncoming(JSON.stringify({ brickyard: 1, batch: { sets: [{ num: '10497' }], sizes: sizesDoc.sizes } }))).kind, 'batch', 'a batch with sizes in it is still a batch of sets');
  for (const t of [JSON.stringify({ brickyard: 1, sizes: [] }), JSON.stringify({ brickyard: 1, model: { name: 'No parts' } })]) {
    let refused = false; try { await C.parseIncoming(t); } catch (e) { refused = true; }
    check(refused, 'still refused: ' + t);
  }

  // The same set added on two devices before they first synced: merged it's there twice, under two ids. foldTwins
  // keeps an exact pair once; anything that differs, and anything that was together in one catalog, is left alone.
  {
    const cat = sets => C.cleanDoc({ catalog: { sets } });
    const bonsai = (id, more) => Object.assign({ id, t: 5, num: '10281-1', name: 'Bonsai Tree', state: 'built', room: 'Office', notes: 'A gift', added: '2026-11-01' }, more);
    const liveIds = d => C.live(d).map(x => x.id).sort();
    let r = C.foldTwins(cat({ a: bonsai('a') }), cat({ b: bonsai('b', { added: '2026-11-03', t: 9 }) }), 1000);
    eq([liveIds(r.doc), r.folded, r.doc.sets.a], [['b'], [{ kept: 'b', dropped: 'a', name: 'Bonsai Tree' }], { id: 'a', t: 1000, del: 1 }], 'an exact twin is kept once, as the copy from the other device, and the one here is removed');
    eq(C.mergeDocs(r.doc, cat({ a: bonsai('a') })).sets.a.del, 1, 'the removal wins when the other device still has the copy');
    r = C.foldTwins(cat({ a: bonsai('a') }), cat({ b: bonsai('b', { room: 'Hall' }) }), 1000);
    eq([liveIds(r.doc), r.folded], [['a', 'b'], []], 'copies that differ in anything are left alone: you may own two');
    r = C.foldTwins(cat({ a: bonsai('a'), a2: bonsai('a2') }), cat({ b: bonsai('b') }), 1000);
    eq([liveIds(r.doc), r.folded.length], [['a2', 'b'], 1], 'two here and one there stay two');
    r = C.foldTwins(cat({ a: bonsai('a'), a2: bonsai('a2') }), cat({ a: bonsai('a'), a2: bonsai('a2') }), 1000);
    eq([liveIds(r.doc), r.folded], [['a', 'a2'], []], 'two that are together in both catalogs are never folded');
    r = C.foldTwins(cat({ a: bonsai('a'), a2: bonsai('a2') }), cat({ a: bonsai('a'), b: bonsai('b') }), 1000);
    eq(liveIds(r.doc), ['a', 'b'], 'a set the other catalog knows too folds with nothing; the one only here folds with the one only there');
    r = C.foldTwins(cat({ a: bonsai('a') }), cat({ a: { id: 'a', t: 9, del: 1 }, b: bonsai('b') }), 1000);
    eq([liveIds(r.doc), r.folded], [['b'], []], 'a set the other catalog removed is removed, not folded');
    r = C.foldTwins(cat({ a: { id: 'a', t: 1, name: 'Custom Castle', state: 'built' } }), cat({ b: { id: 'b', t: 1, name: 'Custom Castle', state: 'built' } }), 1000);
    eq(liveIds(r.doc), ['a', 'b'], 'sets with no number are left alone');
    const shelf = id => ({ k: { id: 'k', t: 1, name: 'Billy', w: 76, d: 26, levels: [{ h: 30, sets: [{ id }] }] } });
    r = C.foldTwins(C.cleanDoc({ catalog: { sets: { a: bonsai('a') }, cases: shelf('a') } }), cat({ b: bonsai('b') }), 1000);
    eq([liveIds(r.doc), r.folded[0].kept], [['a'], 'a'], 'the copy that is on a shelf in the planner is the one kept');
    r = C.foldTwins(C.cleanDoc({ catalog: { sets: { a: bonsai('a') }, cases: shelf('a') } }),
      C.cleanDoc({ catalog: { sets: { b: bonsai('b') }, cases: { k2: Object.assign(shelf('b').k, { id: 'k2' }) } } }), 1000);
    eq(liveIds(r.doc), ['a', 'b'], 'two that are each on a shelf are two sets');
    eq(C.foldTwins(cat({ a: bonsai('a', { t: 5000 }) }), cat({ b: bonsai('b') }), 1000).doc.sets.b.t, 5, 'the kept copy is not changed');

    // Doubles, for the filter in My sets: sets that share a number, or a name when one has no number.
    const sets = [bonsai('a'), bonsai('b', { room: 'Hall' }), { id: 'c', name: 'Typewriter', num: '21327-1' }, { id: 'd', name: 'typewriter' }, { id: 'e', name: 'Orchid', num: '10311-1' },
      { id: 'f', name: 'Millennium Falcon', num: '75192-1' }, { id: 'g', name: 'Millennium Falcon', num: '75257-1' }];
    eq(Object.keys(C.doubles(sets)).sort(), ['a', 'b', 'c', 'd'], 'the same number twice, or the same name where one has no number; two numbers under one name are two sets');
    eq(C.totals(sets).doubles, 4, 'and the totals count them');
  }

  console.log(failed ? `${failed} failed, ${passed} passed` : `all ${passed} checks passed`);
  process.exit(failed ? 1 : 0);
})();
