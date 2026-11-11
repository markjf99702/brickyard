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
// Fit keeps 1 cm clear above a set: a shelf exactly the set's height is left for a taller one, and a set that only
// such a shelf could take says what it needs. By hand (fits without the last argument) it still stands there.
{
  const snug = set('snug', 20, 20, 32), low = set('low', 20, 20, 31), half = set('half', 20, 20, 31.5), all = [snug, low, half];
  const two = { id: 'k', name: 'Two', w: 76, d: 26, levels: [{ h: 40, sets: [] }, { h: 32, sets: [] }] }, one = { id: 'k', name: 'One', w: 76, d: 26, levels: [{ h: 32, sets: [] }] };
  eq(S.fill([two], all).cases[0].levels.map(l => l.sets.map(p => p.id)), [['snug', 'half'], ['low']], 'Fit uses a shelf only when it is 1 cm taller than the set');
  const r1 = S.fill([one], all);
  eq([r1.cases[0].levels[0].sets.map(p => p.id), r1.left.map(x => [x.set.id, x.why])], [['low'], [['snug', '32 cm tall: needs 33 cm of space'], ['half', '31.5 cm tall: needs 32.5 cm of space']]], 'a set that misses by that centimetre says so');
  eq([S.fits(one, 0, snug, ids(all)), S.whyNot([one], snug, ids(all)), S.reason([one], snug, ids(all), S.CLEAR).kind, S.fits(one, 0, snug, ids(all), false, S.CLEAR).near], [{ turn: false }, '', 'clear', true], 'by hand it still stands on a shelf exactly its height');
  eq(S.reason([one], set('big', 20, 20, 50), ids(all), S.CLEAR), { kind: 'tall', why: '50 cm tall; your shelf is 32 cm tall' }, 'a set taller than every shelf says that, as before');
  // With another bookcase that can't take it for some other reason, it still says what it needs.
  const bow = set('bow', 40, 16, 29.5), billy = { id: 'b', name: 'Billy', w: 76, d: 26, levels: [{ h: 30, sets: [] }] }, cube = { id: 'c', name: 'Kallax', w: 33, d: 39, levels: [{ h: 33, sets: [] }] };
  eq(S.reason([billy, cube], bow, ids([bow]), S.CLEAR), { kind: 'clear', why: '29.5 cm tall: needs 30.5 cm of space' }, 'only the space above is in the way, whatever is wrong with the other bookcase');
  const held = { id: 'k', name: 'One', w: 76, d: 26, levels: [{ h: 32, sets: [{ id: 'snug' }] }] };
  eq(S.fill([held], all).cases[0].levels[0].sets.map(p => p.id), ['snug', 'low'], 'a set already on a shelf its own height stays there');
}

// Side-on only when no shelf of that height takes the set facing out. The first shelf has 40 cm left and the second
// 74: a 50 x 20 set goes on the second facing out, where it used to turn side-on on the first (the closer fit).
{
  const a = set('a', 39, 20, 20), b = set('b', 5, 20, 20), x = set('x', 50, 20, 20), all = [a, b, x];
  const k = { id: 'k', name: 'K', w: 80, d: 60, levels: [{ h: 30, sets: [{ id: 'a' }] }, { h: 30, sets: [{ id: 'b' }] }] };
  eq(S.fill([k], all).cases[0].levels.map(l => l.sets), [[{ id: 'a' }], [{ id: 'b' }, { id: 'x' }]], 'facing out on another shelf of the same height before side-on');
  const k1 = { id: 'k', name: 'K', w: 80, d: 60, levels: [{ h: 30, sets: [{ id: 'a' }] }, { h: 30, sets: [{ id: 'b' }, { id: 'c' }] }] };
  eq(S.fill([k1], all.concat([set('c', 30, 20, 20)])).cases[0].levels[0].sets, [{ id: 'a' }, { id: 'x', turn: true }], 'side-on when none of them takes it facing out');
  const k2 = { id: 'k', name: 'K', w: 80, d: 60, levels: [{ h: 30, sets: [{ id: 'a' }] }, { h: 40, sets: [{ id: 'b' }] }] };
  eq(S.fill([k2], all).cases[0].levels[0].sets, [{ id: 'a' }, { id: 'x', turn: true }], 'a taller shelf is still kept for taller sets');
}

// A set with a room goes on a bookcase in that room when one takes it, whatever fits it more closely elsewhere;
// when none there takes it, or it has no room, it goes wherever it fits best, as before.
{
  const inRoom = (x, room) => Object.assign(x, { room });
  const hall = { id: 'h', name: 'Hall', room: 'Hall', w: 60, d: 30, levels: [{ h: 22, sets: [] }] }, office = { id: 'o', name: 'Office', room: 'Office', w: 60, d: 30, levels: [{ h: 40, sets: [] }] };
  const mine = inRoom(set('mine', 30, 20, 20), ' office'), free = set('free', 20, 20, 20), tall = inRoom(set('tall', 20, 20, 39.5), 'Hall'), wide = inRoom(set('wide', 40, 20, 20), 'Office');
  const r = S.fill([hall, office], [mine, free, tall, wide]);
  // The widest goes first: into the Office, its room, though the Hall's shelf is the closer fit. The next Office set
  // has no room left there and goes to the Hall, with the set that has no room.
  eq(r.cases.map(c => c.levels[0].sets.map(p => p.id)), [['mine', 'free'], ['wide']], 'its own room first; a set with no room, or with no place left in its room, goes where it fits');
  eq(r.left.map(x => x.set.id), ['tall'], 'and a set no shelf takes is still left');
  const bare = { id: 'b', name: 'Bare', w: 60, d: 30, levels: [{ h: 40, sets: [] }] };
  eq(S.fill([hall, bare], [mine]).cases.map(c => c.levels[0].sets.length), [1, 0], 'a bookcase with no room is not the set’s room');
}

// Shelves that suit a set equally are taken from eye level (1.4 m up, the bookcase on the floor) outwards, not from
// the top down. Six 30 cm spaces with 2 cm boards have their middles 177, 145, 113, 81, 49 and 17 cm up.
{
  const billy = { id: 'k', name: 'Billy', w: 76, d: 26, levels: [30, 30, 30, 30, 30, 30].map(h => ({ h, sets: [] })) }, six = [];
  for (let i = 0; i < 6; i++) six.push(set('s' + i, 60, 20, 20));
  const where = n => S.fill([billy], six.slice(0, n)).cases[0].levels.map(l => l.sets.length).join('');
  eq([1, 2, 3, 4, 5, 6].map(where), ['010000', '011000', '111000', '111100', '111110', '111111'], 'from eye level outwards');
  const pair = [set('p', 30, 20, 20), set('q', 30, 20, 20)];
  eq(S.fill([billy], pair).cases[0].levels.map(l => l.sets.length).join(''), '020000', 'a shelf with a set on it is still filled before an empty one');
}

// Fit tries eight ways of taking the sets and keeps the one that places most. Tallest first (widest of those first)
// stands the 60 cm set on this 80 cm shelf and nothing else fits beside it; another order gets two sets on. When
// no other way places more, tallest first is what's kept.
{
  const four = [set('a', 30, 20, 20), set('b', 60, 20, 20), set('c', 30, 20, 20), set('d', 50, 20, 20)];
  const k = { id: 'k', name: 'K', w: 80, d: 20, levels: [{ h: 32, sets: [] }, { h: 12, sets: [] }] };
  const r = S.fill([k], four);
  eq([r.cases[0].levels[0].sets.map(p => p.id).sort(), r.left.map(x => [x.set.id, x.why]).sort()], [['a', 'c'], [['b', 'No room left on a shelf it fits'], ['d', 'No room left on a shelf it fits']]], 'the order that places most sets is kept');
  eq(Object.keys(r).sort(), ['cases', 'left'], 'Fit gives back the bookcases and what is left');
  const wideK = { id: 'k', name: 'K', w: 100, d: 20, levels: [{ h: 32, sets: [] }] };
  eq(S.fill([wideK], four).cases[0].levels[0].sets.map(p => p.id), ['b', 'a'], 'tallest and widest first when nothing places more');
}

// Keep themes together, when asked: a set goes on a shelf that already holds one of its theme, then an empty shelf,
// then any other. Without it the closest fit wins, as ever.
{
  const themed = (x, theme) => Object.assign(x, { theme });
  const all = [themed(set('falcon', 40, 20, 20), 'Star Wars'), themed(set('xwing', 20, 20, 20), 'star wars'), themed(set('tree', 50, 20, 20), 'Botanical'), set('plain', 15, 20, 10), themed(set('tie', 10, 20, 12), 'Star Wars')];
  const k = { id: 'k', name: 'K', w: 76, d: 26, levels: [{ h: 30, sets: [{ id: 'falcon' }] }, { h: 30, sets: [{ id: 'tree' }] }, { h: 30, sets: [] }, { h: 14, sets: [] }] };
  const where = r => r.cases[0].levels.map(l => l.sets.map(p => p.id).join('+'));
  eq(where(S.fill([k], all)), ['falcon', 'tree+xwing', '', 'tie+plain'], 'without the choice, the closest fit');
  eq(where(S.fill([k], all, { themes: true })), ['falcon+xwing+tie', 'tree', '', 'plain'], 'with it, beside its own theme first, even on a taller shelf');
  const full = { id: 'k', name: 'K', w: 76, d: 26, levels: [{ h: 30, sets: [{ id: 'falcon' }, { id: 'tree' }] }, { h: 30, sets: [] }] };
  eq(where(S.fill([full], [all[0], all[2], themed(set('orchid', 30, 20, 20), 'Botanical'), themed(set('car', 30, 20, 20), 'Technic')], { themes: true })), ['falcon+tree', 'car+orchid'], 'no room beside its theme: an empty shelf, then any other');
}

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

// Sets that fill a shelf exactly fit. Sizes are kept to 0.1 cm, and sums of those aren't exact in a computer's
// arithmetic (76 - 11.4 - 1 is 63.599999999999994), so 11.4 + 1 + 63.6 on a 76 cm shelf was "Not enough room".
{
  const a = set('a', 11.4, 10, 10), b = set('b', 63.6, 10, 10), k76 = { id: 'k', name: 'K', w: 76, d: 26, levels: [{ h: 32, sets: [{ id: 'a' }] }] };
  eq(S.fits(k76, 0, b, ids([a, b])), { turn: false }, '11.4 + 1 + 63.6 fits a 76 cm shelf');
  eq(S.fits(k76, 0, set('b2', 63.7, 26, 10), ids([a])).why, 'Not enough room left on this shelf', 'and 0.1 cm more does not');
  const three = [set('p', 20.1, 10, 10), set('q', 20.2, 10, 10), set('r', 33.7, 10, 10)], k3s = { id: 'k', name: 'K', w: 76, d: 26, levels: [{ h: 32, sets: [{ id: 'p' }, { id: 'q' }] }] };
  eq(S.fits(k3s, 0, three[2], ids(three)), { turn: false }, '20.1 + 20.2 + 33.7 and two gaps fit 76');
  k3s.levels[0].sets.push({ id: 'r' });
  eq(S.used(k3s.levels[0], ids(three)), 76, 'and use exactly 76');
  // Every pair and every three of 0.1 cm widths that fill a shelf exactly, for a few shelf widths.
  let refused = 0, tried = 0;
  for (const w of [76, 36, 33, 80.5, 59.7]) {
    for (let i = 1; i < (w - 1) * 10; i += 7) {
      const x = set('x', i / 10, 5, 5), y = set('y', Math.round((w - 1) * 10 - i) / 10, 5, 5), kw = { id: 'k', name: 'K', w, d: 26, levels: [{ h: 32, sets: [{ id: 'x' }] }] };
      tried++; if (S.fits(kw, 0, y, ids([x, y])).why) refused++;
      for (let j = 1; j < (w - 2) * 10 - i; j += 53) {
        const y2 = set('y', j / 10, 5, 5), z = set('z', Math.round((w - 2) * 10 - i - j) / 10, 5, 5), k2 = { id: 'k', name: 'K', w, d: 26, levels: [{ h: 32, sets: [{ id: 'x' }, { id: 'y' }] }] };
        tried++; if (S.fits(k2, 0, z, ids([x, y2, z])).why) refused++;
      }
    }
  }
  eq([refused, tried > 2000], [0, true], 'no exact fit is refused');
  const full = S.fill([{ id: 'k', name: 'K', w: 76, d: 26, levels: [{ h: 32, sets: [] }] }], [a, b]);
  eq([full.cases[0].levels[0].sets.length, full.left.length], [2, 0], 'Fit puts both on the shelf');
}
// Counting why sets wait, and how much more shelf the ones short of room would take: each the way Fit would stand
// it (facing out if an empty shelf takes it that way, else side-on) plus the gap.
{
  const billy2 = { id: 'b', name: 'Billy', w: 76, d: 26, levels: [{ h: 32, sets: [{ id: 'f1' }, { id: 'f2' }] }, { h: 32, sets: [{ id: 'f3' }, { id: 'f4' }] }] };
  const on = [set('f1', 40, 20, 30), set('f2', 30, 20, 30), set('f3', 40, 20, 30), set('f4', 30, 20, 30)];
  const waits = [set('r1', 20, 15, 18), set('r2', 22, 40, 12), set('t', 20, 20, 40), set('d', 30, 28, 10), set('w', 80, 90, 10), set('m', 80, 20, 10)], all5 = ids(on.concat(waits));
  eq(waits.map(x => S.reason([billy2], x, all5).kind), ['room', 'room', 'tall', 'deep', 'deep', 'big'], 'each waiting set’s kind of reason');
  eq(waits.map(x => S.reason([billy2], x, all5).why), waits.map(x => S.whyNot([billy2], x, all5)), 'with the same words as before');
  eq([S.reason([billy2], set('s', 3, 3, 3), all5), S.reason([], set('s', 5, 5, 5), {}).kind, S.reason([billy2], { id: 'n' }, {}).kind], [{ why: '', kind: '' }, 'none', 'size'], 'and one that fits, no bookcases, no size');
  eq(S.shelfNeeded(waits.slice(0, 2), [billy2]), 20 + 1 + 40 + 1, 'facing out (20), and side-on where facing out is too deep (40), each with its gap');
  eq(S.shelfNeeded([set('a', 11.4, 5, 5), set('b', 63.6, 5, 5)], [billy2]), 77, 'added up in tenths');
  eq(S.shelfNeeded([], [billy2]), 0, 'nothing waiting needs nothing');
}
// A set that stops belonging on its shelf. One whose size was cleared is still placed, and is listed under Needs a
// size too (it isn't drawn, and was in neither list). One taken apart since stays placed, for the page to flag, and
// Fit leaves it where it is.
{
  const bare = { id: 'bare', name: 'Bookshop', state: 'built' }, gone = set('gone', 20, 10, 10, 'apart'), next = set('next', 20, 20, 10);
  const kc = { id: 'kc', name: 'Billy narrow', w: 36, d: 26, levels: [{ h: 32, sets: [{ id: 'bare' }, { id: 'gone' }] }] };
  const s2 = S.sort([bare, gone, next], [kc]);
  eq([s2.placed.map(x => x.id), s2.waiting.map(x => x.id), s2.noSize.map(x => x.id)], [['bare', 'gone'], ['next'], ['bare']], 'a placed set with no size is under Needs a size as well');
  eq(S.sort([{ id: 'bare', name: 'Bookshop', state: 'apart' }], [kc]).noSize, [], 'not one that has been taken apart');
  const f2 = S.fill([kc], [bare, gone, next]);
  eq(f2.cases[0].levels[0].sets.map(p => p.id), ['bare', 'gone'], 'Fit leaves a taken-apart set on its shelf, and the room it takes');
  eq(f2.left.map(x => x.set.id), ['next'], 'so the next set has no room');
}
// Two devices: the phone moves X from k1 to k2 (both saved at t 11); the laptop, not yet synced, adds Y to k1
// (t 12). Merged, X stood on both. It stays on the bookcase changed last, in either order, and a tie goes to the
// later id.
{
  const mk = (id, t, on) => ({ id, t, name: id, w: 76, d: 26, levels: [{ h: 32, sets: on.map(i => ({ id: i })) }, { h: 32, sets: [] }] });
  const phone = C.cleanDoc({ catalog: { sets: {}, cases: { k1: mk('k1', 11, []), k2: mk('k2', 11, ['x']) } } });
  const laptop = C.cleanDoc({ catalog: { sets: {}, cases: { k1: mk('k1', 12, ['x', 'y']), k2: mk('k2', 5, []) } } });
  const on = list => list.map(c => c.id + ':' + c.levels.map(l => l.sets.map(p => p.id).join('+')).join('/')).join(' ');
  const merged = Object.values(C.mergeDocs(phone, laptop).cases);
  eq(on(merged), 'k1:x+y/ k2:x/', 'merged, a set stands on two bookcases');
  const once = S.dedupe(merged);
  eq(on(once), 'k1:x+y/ k2:/', 'it stays on the bookcase changed last');
  eq(on(S.dedupe(merged.slice().reverse()).reverse()), 'k1:x+y/ k2:/', 'whatever order the bookcases come in');
  eq(on(merged), 'k1:x+y/ k2:x/', 'the bookcases given are not changed');
  check(once[0] === merged[0] && once[1] !== merged[1], 'a bookcase that loses nothing comes back as it is');
  eq(on(S.dedupe([mk('k1', 7, ['x']), mk('k2', 7, ['x', 'z'])])), 'k1:/ k2:x+z/', 'a tie goes to the later id');
  const twice = mk('k3', 1, ['x']); twice.levels[1].sets.push({ id: 'x', turn: true });
  eq(on(S.dedupe([twice])), 'k3:x/', 'and on one bookcase, to its first shelf');
  eq(Object.keys(S.placements(once)), ['x', 'y'], 'each set is in one place');
}

// Sizes from Claude, and the cataloger script makes the same.
const list = [{ num: '10497', w: '51', d: 33.04, h: 14, note: '  LEGO   says ' }, { num: '10497', w: 1, d: 1, h: 1 }, { num: 'nope', w: 1, d: 1, h: 1 },
  { num: 21318, w: 22, d: 22 }, { num: 'LEGO® Set No. 10281', w: 20, d: 15, h: 18 }, { num: '75192', w: 840, d: 560, h: 210 }, { num: '10294', w: 500.04, d: 500, h: '0,5' }, { num: '10307', w: 20, d: 20, h: 500.1 }];
const clean = S.cleanSizes({ sizes: list });
eq(clean, [{ num: '10497-1', w: 51, d: 33, h: 14, note: 'LEGO says' }, { num: '10281-1', w: 20, d: 15, h: 18 }, { num: '10294-1', w: 500, d: 500, h: 0.5 }], 'sizes cleaned: a side over 500 cm drops the row (sent in mm, it used to arrive as 500 cm)');
{
  const tally = {}; S.cleanSizes({ sizes: list.concat([null, 'x']) }, tally);
  eq(tally.dropped, 6, 'and the rows left out are counted, but not a set that is in the list twice');
}
// A size that looks wrong is asked about, not ticked. The limits are this page's estimate, not a published rule.
{
  const castle = { id: 'c', name: 'Lion Knights’ Castle', pieces: 4514 }, plain = { id: 'p', name: 'No count' };
  eq(S.sizeDoubt({ w: 44, d: 33, h: 3 }, castle), '3 cm tall for 4,514 pieces?', 'a 4,514-piece castle 3 cm tall');
  eq(S.sizeDoubt({ w: 12.6, d: 10.2, h: 8.7 }, { pieces: 1426 }), '8.7 cm tall for 1,426 pieces?', 'inches sent as cm');
  eq(S.sizeDoubt({ w: 60, d: 40, h: 40 }, { pieces: 120 }), '60 cm wide for 120 pieces?', 'far too big for its pieces');
  eq(S.sizeDoubt({ w: 44, d: 33, h: 1.2 }, plain), 'Only 1.2 cm tall?', 'a side under 1.5 cm');
  eq(S.sizeDoubt({ w: 44, d: 210, h: 30 }, plain), '210 cm deep?', 'a side over 150 cm');
  eq(S.sizeDoubt({ w: 44, d: 33, h: 3 }, plain), '', 'with no piece count, a flat set passes');
  eq([[52, 32, 13, 1254], [65, 104, 4, 11695], [34, 9, 18, 1686], [44, 33, 38, 4514], [26, 24, 39, 608], [58, 58, 149, 10001]].map(z => S.sizeDoubt({ w: z[0], d: z[1], h: z[2] }, { pieces: z[3] })), ['', '', '', '', '', ''], 'real sets pass: Galaxy Explorer, World Map, London Bus, Lion Knights’ Castle, Orchid, Eiffel Tower');
  const sized = { pieces: 1254, size: { w: 52, d: 32, h: 13 } };
  eq([S.sizeDoubt({ w: 32, d: 52, h: 13 }, sized), S.sizeDoubt({ w: 50, d: 30, h: 15 }, sized), S.sizeDoubt({ w: 52, d: 32, h: 26 }, sized), S.sizeDoubt({ w: 20, d: 12, h: 13 }, sized)],
    ['', '', 'Very different from the size it has now.', 'Very different from the size it has now.'], 'against the size it has: the other way round is the same, half as big again is not');
}
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
  // The checked form (#z2z, #z2j): the same data with the check js/core.js works out on its end. Whole it opens;
  // with one character changed, or cut short, it is refused.
  {
    const checked = (kind, data) => '#' + kind + data + C.linkCheck(kind + data);
    const z2 = checked('z2z', zlib.deflateRawSync(doc).toString('base64url')), j2 = checked('z2j', Buffer.from(doc).toString('base64url'));
    check(S.isSizesLink('https://brickyard.junkdrawer.works/' + z2), 'checked sizes link recognised');
    eq([await S.parseSizes(z2), await S.parseSizes('_https://brickyard.junkdrawer.works/' + j2 + '_')], [clean, clean], 'z2z and z2j links open');
    let refused = 0, tried = 0;
    for (const l of [z2, j2]) for (let i = 4; i < l.length; i++) {
      tried += 2;
      if (await S.parseSizes(l.slice(0, i) + (l[i] === 'A' ? 'B' : 'A') + l.slice(i + 1)).then(() => false, () => true)) refused++;
      if (await S.parseSizes(l.slice(0, i)).then(() => false, () => true)) refused++;
    }
    eq(refused, tried, 'a checked sizes link with a wrong character, or cut short, is refused');
  }
  eq(await S.parseSizes(doc), clean, 'pasted file opens');
  // A whole message from Claude, copied: the link in a sentence, or the file in ```json fences.
  for (const [t, what] of [
    ['Here are the sizes: https://brickyard.junkdrawer.works/#z1z' + zlib.deflateRawSync(doc).toString('base64url') + '. Tap Add sizes.', 'a sizes link in a sentence'],
    ['```json\n' + doc + '\n```', 'a sizes file in ```json fences'],
  ]) {
    let z = null; try { z = await S.parseSizes(t); } catch (e) { /* refused */ }
    eq(z, clean, what + ' opens');
  }
  // A sizes link with a dash or an underscore stuck to its end (markdown's _link_) still opens: they're characters a
  // link is made of, and with one more on the end it didn't always unpack.
  {
    let opened = 0, tried = 0;
    for (let i = 0; i < 24; i++) {
      const some = { brickyard: 1, sizes: Array.from({ length: 1 + i % 4 }, (_, k) => ({ num: String(10000 + i * 37 + k), w: 10 + i, d: 8 + k, h: 5 + i % 7, note: 'n'.repeat(i) })) };
      const link = 'https://brickyard.junkdrawer.works/#z1z' + zlib.deflateRawSync(JSON.stringify(some)).toString('base64url');
      for (const t of ['_' + link + '_', link + '-', link + '__ ']) {
        tried++;
        const z = await S.parseSizes(t).catch(() => null);
        if (JSON.stringify(z) === JSON.stringify(S.cleanSizes(some))) opened++;
      }
    }
    eq(opened, tried, 'a sizes link with - or _ stuck to its end opens');
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
    const link = out.split('\n').find(l => l.includes('#z2z'));
    eq(await S.parseSizes(link), clean, 'script and page agree on sizes');
    check(!/NOTE: this link is long/.test(out), 'a short sizes link has no note about its length');
    // Sizes that end in 5 hundredths (they come from inches: 2.5 in is 6.35 cm) are rounded the same way by both: a
    // half goes up. The script made 12.25 x 0.15 x 6.35 cm 12.2 x 0.1 x 6.3 where the page has 12.3 x 0.2 x 6.4. A
    // side that rounds to more than 500 is no size for both, and one inside the limits comes through as it is.
    const halves = { brickyard: 1, sizes: [{ num: '10497', w: 12.25, d: 0.15, h: 6.35 }, { num: '21318', w: 19.05, d: 499.95, h: 500.04 }, { num: '10281', w: 500.05, d: 10, h: 10 },
      { num: '42115', w: 60, d: 25.5, h: 13.4 }, { num: '21327', w: 2.675, d: 1.005, h: 8.345 }] };
    eq(S.cleanSizes(halves).slice(0, 2), [{ num: '10497-1', w: 12.3, d: 0.2, h: 6.4 }, { num: '21318-1', w: 19.1, d: 500, h: 500 }], 'the page rounds a half up');
    fs.writeFileSync(path.join(dir, 'halves.json'), JSON.stringify(halves));
    const half = execFileSync('python3', [path.join(root, 'skill/brickyard-cataloger/scripts/make_brickyard.py'), path.join(dir, 'halves.json'), '--out', dir]).toString();
    eq(await S.parseSizes(half.split('\n').find(l => l.includes('#z2z'))), S.cleanSizes(halves), 'script and page agree on sizes that end in a half');
    eq(S.cleanSizes(halves).find(z => z.num === '42115-1'), { num: '42115-1', w: 60, d: 25.5, h: 13.4 }, 'and a size inside its limits is kept as it is');
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
