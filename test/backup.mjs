// Keeping a catalog safe, in Chromium through the real page:  node test/backup.mjs  (needs Playwright)
// Doubles and the twins folded when two catalogs meet, Recently removed, the backup file and its reminder, and going
// back to a backup.
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
let pw;
try { pw = require('playwright'); } catch { pw = require(join(execSync('npm root -g').toString().trim(), 'playwright')); }
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json', '.json': 'application/json' };
const server = createServer(async (req, res) => {
  let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (path.endsWith('/')) path += 'index.html';
  try { const body = await readFile(join(root, path)); res.writeHead(200, { 'content-type': TYPES[extname(path)] || 'text/html' }); res.end(body); } catch { res.writeHead(404); res.end(); }
}).listen(0);
const base = `http://localhost:${server.address().port}/`;
const browser = await pw.chromium.launch();
const problems = [];
const DAY = 86400000;

// A browser of its own with this saved in it: `catalog` under brickyard.v1, and anything in `more` under its own key.
// `init` runs in the page before any of its scripts.
async function withSets(catalog, more = {}, init) {
  const c = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, serviceWorkers: 'block' });
  await c.route('https://cdn.rebrickable.com/**', r => r.fulfill({ status: 404 }));
  if (init) await c.addInitScript(init);
  const p = await c.newPage();
  p.on('pageerror', e => problems.push(e.message));
  p.on('dialog', d => { problems.push('dialog: ' + d.message()); d.dismiss(); });
  await p.goto(base);
  await p.evaluate(([cat, extra]) => {
    localStorage.setItem('brickyard.v1', JSON.stringify({ brickyard: 1, catalog: cat }));
    for (const k of Object.keys(extra)) localStorage.setItem(k, JSON.stringify(extra[k]));
  }, [catalog, more]);
  await p.reload();
  return { c, p };
}
const names = p => p.evaluate(() => Object.values(window.brickyard.doc().sets).filter(x => !x.del).map(x => x.name).sort());
const toast = p => p.evaluate(() => { const t = document.querySelector('.toast'); return t.hidden ? '' : t.querySelector('span').textContent; });
const openFile = (p, o) => p.setInputFiles('#file', { name: 'Brickyard.json', mimeType: 'application/json', buffer: Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)) });
const rows = p => p.evaluate(() => [...document.querySelectorAll('#list-wrap .item .t')].map(e => e.textContent));
const bonsai = (id, more) => ({ id, t: 5, num: '10281-1', name: 'Bonsai Tree', state: 'built', room: 'Office', added: '2026-11-01', ...more });

// ---------- Doubles, and twins folded when a file is opened ----------
// The same set added on two devices: opening the other device's backup keeps an exact twin once and says so, leaves
// a copy that differs alone, and My sets has a Doubles chip that lists the ones left.
{
  const { c, p } = await withSets({ sets: { a: bonsai('a'), o: { id: 'o', t: 5, num: '10311-1', name: 'Orchid', state: 'built' }, w: { id: 'w', t: 5, num: '21327-1', name: 'Typewriter', state: 'built' } } },
    { 'brickyard.pool': { a: true } });
  await p.goto(base + '#catalog');
  assert.equal(await p.locator('.chip[data-f="doubles"]').count(), 0, 'with no set here twice there is no Doubles chip');
  await openFile(p, { brickyard: 1, catalog: { sets: { b: bonsai('b', { t: 9, added: '2026-11-04' }), o2: { id: 'o2', t: 5, num: '10311-1', name: 'Orchid', state: 'built', room: 'Hall' }, w: { id: 'w', t: 5, num: '21327-1', name: 'Typewriter', state: 'built' } } } });
  await p.waitForSelector('#cs-go');
  assert.equal(await p.textContent('#cs-twins'), 'Bonsai Tree is here and in this file with the same details: it will be kept once.', 'the sheet says which set is in both');
  await p.click('#cs-go');
  assert.equal(await toast(p), 'Merged. Bonsai Tree is here and in the file with the same details: it’s kept once. You have 4 sets.');
  assert.deepEqual(await names(p), ['Bonsai Tree', 'Orchid', 'Orchid', 'Typewriter'], 'the exact twin is kept once; the Orchid in another room stays a second set');
  assert.deepEqual(await p.evaluate(() => [window.brickyard.doc().sets.a.del, !window.brickyard.doc().sets.b.del, JSON.parse(localStorage.getItem('brickyard.pool'))]), [1, true, { b: true }],
    'the copy from the file is the one kept, and its tick in Build from your box came with it');
  assert.equal(await p.textContent('.chip[data-f="doubles"]'), 'Doubles2', 'a Doubles chip counts the copies that were left alone');
  await p.click('.chip[data-f="doubles"]');
  assert.deepEqual(await rows(p), ['Orchid', 'Orchid'], 'and lists them');
  await c.close();
}

// ---------- Recently removed ----------
// A removed set can be put back from the menu for 30 days, as it was, on the device that removed it. The list is
// kept beside the catalog, so the catalog (and with it a backup and what syncs) holds only the removal, as before.
{
  const tree = { id: 't', t: 1, num: '21318-1', name: 'Tree House', notes: 'a gift', room: 'Living room', spot: 'Top shelf', box: '7', state: 'built' };
  const { c, p } = await withSets({ sets: { t: tree, o: { id: 'o', t: 1, name: 'Orchid' }, old: { id: 'old', t: 1, del: 1 }, x: { id: 'x', t: 1, del: 1 } } },
    { 'brickyard.removed': [{ set: { id: 'old', t: 1, name: 'Typewriter' }, at: Date.now() - 31 * DAY }, { set: { id: 'x', t: 1, name: 'Bonsai Tree', room: 'Office' }, at: Date.now() - 3 * DAY }] });
  await p.goto(base + '#catalog');
  await p.click('#menu-btn');
  assert.equal(await p.textContent('#m-gone span'), 'Recently removed (1)Put back a set removed on this device in the last 30 days', 'a set removed 31 days ago is off the list; one from 3 days ago is on it');
  await p.click('[data-close]');
  await p.click('.item:has-text("Tree House")');
  await p.click('#e-del'); await p.waitForTimeout(650); await p.click('#e-del');
  await p.click('.toast span'); // the ten seconds of Undo, gone
  assert.deepEqual(await p.evaluate(() => [window.brickyard.doc().sets.t, Object.keys(JSON.parse(localStorage.getItem('brickyard.v1')).catalog)].flat().map(x => typeof x === 'object' ? Object.keys(x).sort().join() : x)),
    ['del,id,t', 'sets', 'seen', 'cases', 'loose', 'places'], 'the catalog keeps only the removal, as it did');
  await p.click('#menu-btn');
  await p.click('#m-gone');
  assert.deepEqual(await p.evaluate(() => [document.querySelector('.sheet .lede').textContent, ...[...document.querySelectorAll('#gone li')].map(li => li.querySelector('.t').textContent + ' | ' + li.querySelector('.m').textContent)]),
    ['Sets removed on this device in the last 30 days. Only this device can put them back; after 30 days they’re gone from this list.', 'Tree House | 21318 · Living room › Top shelf · Box 7 · Removed today', 'Bonsai Tree | Office · Removed 3 days ago'],
    'the list says whose it is, and each set with where it was and when it went');
  await p.click('[data-back="t"]');
  assert.equal(await toast(p), 'Tree House is back');
  const back = await p.evaluate(() => window.brickyard.doc().sets.t);
  assert.deepEqual([{ ...back, t: 0 }, back.t > 1], [{ ...tree, t: 0 }, true], 'put back as it was, timed after its removal');
  assert.deepEqual(await p.evaluate(() => [...document.querySelectorAll('#gone .t')].map(e => e.textContent)), ['Bonsai Tree'], 'and off the list, which stays open for the next');
  await p.click('[data-back="x"]');
  assert.deepEqual([await p.locator('.sheet').count(), await names(p)], [0, ['Bonsai Tree', 'Orchid', 'Tree House']], 'the last one put back closes the list');
  await p.click('#menu-btn');
  assert.equal(await p.locator('#m-gone').count(), 0, 'with nothing removed lately the menu has no row for it');
  // Undo within its ten seconds takes the set off the list too.
  await p.click('[data-close]');
  await p.click('.item:has-text("Orchid")');
  await p.click('#e-del'); await p.waitForTimeout(650); await p.click('#e-del');
  await p.click('.toast button');
  assert.deepEqual([await names(p), await p.evaluate(() => JSON.parse(localStorage.getItem('brickyard.removed')).length)], [['Bonsai Tree', 'Orchid', 'Tree House'], 0], 'a removal that was undone is not on the list');
  await c.close();
}

// ---------- The backup file holds the models from Claude too ----------
// A model was in one browser's storage and nowhere else. Download a backup now writes them under their own heading
// beside the catalog, with the day the file was saved; opening the file adds the ones that aren't there already.
{
  const { c, p } = await withSets({ sets: { o: { id: 'o', t: 1, name: 'Orchid' } } });
  await p.waitForFunction(() => window.BrickyardBuild);
  const id = await p.evaluate(async () => window.BrickyardBuild.saveModel(window.BuildCore.cleanModel(await (await fetch('models/cottage.json')).json())));
  await p.evaluate(k => { const all = JSON.parse(localStorage.getItem('brickyard.models')); all[k].added = 1700000000000; localStorage.setItem('brickyard.models', JSON.stringify(all)); }, id);
  await p.goto(base + '#catalog');
  await p.click('#menu-btn');
  assert.match(await p.textContent('#m-backup small'), /^Your whole catalog and your models as one file\. /);
  const [dl] = await Promise.all([p.waitForEvent('download'), p.click('#m-backup')]);
  const text = await readFile(await dl.path(), 'utf8'), file = JSON.parse(text);
  assert.deepEqual([Object.keys(file), Object.keys(file.models), file.models[id].added, Math.abs(Date.parse(file.saved) - Date.now()) < 60000, Object.keys(file.catalog.sets)],
    [['brickyard', 'saved', 'catalog', 'models'], [id], 1700000000000, true, ['o']], 'the file has the catalog as before, when it was saved, and the models under their own heading');
  await c.close();
  const other = await withSets({ sets: { b: { id: 'b', t: 1, name: 'Bonsai Tree' } } });
  const q = other.p;
  await q.waitForFunction(() => window.BrickyardBuild);
  await q.goto(base + '#catalog');
  await openFile(q, text);
  await q.waitForSelector('#cs-go');
  assert.match(await q.textContent('.sheet .lede'), /^This file has 1 set and 1 model from Claude\. /);
  await q.click('#cs-go');
  assert.equal(await toast(q), 'Merged. 1 model added. You have 2 sets.');
  assert.deepEqual(await q.evaluate(k => { const all = JSON.parse(localStorage.getItem('brickyard.models')); return [Object.keys(all), all[k].added, all[k].model.parts.length > 10]; }, id), [[id], 1700000000000, true],
    'the model is on this device now, under the day it was added');
  await openFile(q, text);
  await q.waitForSelector('#cs-go');
  await q.click('#cs-go');
  assert.deepEqual([await toast(q), await q.evaluate(() => Object.keys(JSON.parse(localStorage.getItem('brickyard.models'))).length)], ['Merged. You have 2 sets.', 1], 'opened again, a model that is here already is left as it is');
  await q.goto(base);
  await q.waitForFunction(() => /1 model from Claude/.test(document.getElementById('home-build-stat').textContent));
  // A backup from before models were in it opens as it always did.
  await q.goto(base + '#catalog');
  await openFile(q, { brickyard: 1, catalog: { sets: { n: { id: 'n', t: 1, name: 'Typewriter' } } } });
  await q.waitForSelector('#cs-go');
  assert.match(await q.textContent('.sheet .lede'), /^This file has 1 set\. /);
  await q.click('#cs-go');
  assert.deepEqual(await names(q), ['Bonsai Tree', 'Orchid', 'Typewriter']);
  await other.c.close();
}

// ---------- A backup you are reminded of ----------
// The menu says when the last backup was downloaded here. With Drive sync off, the home screen has one quiet line
// once a backup is due: something changed since the last one, and it was 30 days ago or more, or 20 things changed.
{
  const now = Date.now();
  const sets = (n, t) => Object.fromEntries(Array.from({ length: n }, (_, i) => ['s' + i, { id: 's' + i, t, name: 'Set ' + i }]));
  const line = async p => await p.isVisible('#backup-nudge') ? p.textContent('#backup-nudge') : '';
  const menuSays = async p => { await p.goto(base + '#catalog'); await p.click('#menu-btn'); const s = await p.textContent('#m-backup small'); await p.click('[data-close]'); await p.goto(base); return s; };
  for (const [what, catalog, more, want, menu] of [
    ['no backup yet, and the oldest change 40 days old', { sets: sets(3, now - 40 * DAY) }, {}, 'No backup of your catalog yet. Download one', 'No backup yet.'],
    ['no backup yet, and everything new', { sets: sets(3, now - 2 * DAY) }, {}, '', 'No backup yet.'],
    ['no backup yet, and 20 new sets', { sets: sets(20, now - 2 * DAY) }, {}, 'No backup of your catalog yet. Download one', 'No backup yet.'],
    ['a backup 12 days ago and 2 changes since', { sets: { ...sets(5, now - 20 * DAY), ...Object.fromEntries(Object.entries(sets(2, now - DAY)).map(([k, v]) => ['n' + k, { ...v, id: 'n' + k }])) } }, { 'brickyard.backup': { t: now - 12 * DAY } }, '', 'Last backup 12 days ago.'],
    ['a backup 31 days ago and 1 change since', { sets: { ...sets(5, now - 40 * DAY), z: { id: 'z', t: now - DAY, del: 1 } } }, { 'brickyard.backup': { t: now - 31 * DAY } }, '1 change since your last backup, 31 days ago. Download one', 'Last backup 31 days ago.'],
    ['a backup 31 days ago and nothing changed since', { sets: sets(5, now - 40 * DAY) }, { 'brickyard.backup': { t: now - 31 * DAY } }, '', 'Last backup 31 days ago.'],
    ['a backup 2 days ago and 20 changes since', { sets: sets(19, now - DAY), cases: { k: { id: 'k', t: now - DAY, name: 'Billy', w: 76, d: 26, levels: [{ h: 30, sets: [] }] } } }, { 'brickyard.backup': { t: now - 2 * DAY } }, '20 changes since your last backup, 2 days ago. Download one', 'Last backup 2 days ago.'],
    ['Drive sync on', { sets: sets(30, now - 40 * DAY) }, { 'brickyard.drive': { on: true } }, '', 'No backup yet.'],
  ]) {
    const { c, p } = await withSets(catalog, more);
    assert.equal(await line(p), want, 'the line on the home screen with ' + what);
    assert.equal(await menuSays(p), 'Your whole catalog and your models as one file. ' + menu, 'the menu with ' + what);
    await c.close();
  }
  // A tap on the line downloads a backup; the line goes, and the menu says today.
  const { c, p } = await withSets({ sets: sets(3, now - 40 * DAY) });
  assert.deepEqual(await p.evaluate(() => { const b = document.getElementById('backup-nudge'), s = getComputedStyle(b); return [b.tagName, b.getBoundingClientRect().height >= 44, s.fontWeight]; }), ['BUTTON', true, '400'], 'a quiet line, with room for a finger');
  const [dl] = await Promise.all([p.waitForEvent('download'), p.click('#backup-nudge')]);
  assert.match(dl.suggestedFilename(), /^Brickyard \d{4}-\d\d-\d\d\.json$/);
  assert.deepEqual([await line(p), await menuSays(p)], ['', 'Your whole catalog and your models as one file. Last backup today.']);
  await c.close();
}

// The browser is asked to keep Brickyard's storage, once there is a set to keep, and the menu says when it agreed.
{
  const stub = () => { Object.defineProperty(navigator, 'storage', { configurable: true, value: { persisted: async () => false, persist: async () => { window.__asked = (window.__asked || 0) + 1; return true; } } }); };
  const some = await withSets({ sets: { o: { id: 'o', t: Date.now(), name: 'Orchid' } } }, {}, stub);
  await some.p.goto(base + '#catalog');
  assert.equal(await some.p.evaluate(() => window.__asked), 1, 'asked as the page opens, once');
  await some.p.click('#menu-btn');
  assert.match(await some.p.textContent('.sheet .note'), /This browser has agreed not to clear Brickyard’s storage by itself\.$/);
  await some.c.close();
  const none = await withSets({ sets: {} }, {}, stub);
  assert.equal(await none.p.evaluate(() => window.__asked), undefined, 'with no sets there is nothing to ask for');
  await none.p.evaluate(() => window.brickyard.addSet({ name: 'Orchid' }));
  await none.p.waitForFunction(() => window.__asked === 1);
  await none.c.close();
}

// ---------- Going back to a backup ----------
// Opening a backup merges, and the later change wins, so yesterday's file couldn't undo today's mistake. A file has a
// second choice: put everything back the way the file has it. It counts what will change first, takes a second tap,
// and the message afterwards has Undo.
{
  const { c, p } = await withSets({
    sets: { a: { id: 'a', t: 1, name: 'Orchid', room: 'Office' }, b: { id: 'b', t: 1, name: 'Bonsai Tree', box: '3' }, t: { id: 't', t: 1, name: 'Typewriter' } },
    cases: { k: { id: 'k', t: 1, name: 'Billy', w: 76, d: 26, levels: [{ h: 30, sets: [] }] } } });
  const state = () => p.evaluate(() => { const d = window.brickyard.doc(); return [Object.values(d.sets).filter(x => !x.del).map(x => x.name + (x.box ? ' in ' + x.box : '')).sort().join(', '), Object.values(d.cases).filter(x => !x.del).map(x => x.name).join()]; });
  const listed = async () => { await p.click('#menu-btn'); const has = await p.locator('#m-gone').count(); if (has) await p.click('#m-gone'); const l = await p.evaluate(() => [...document.querySelectorAll('#gone .t')].map(e => e.textContent)); await p.click('[data-close]'); return l; };
  await p.goto(base + '#catalog');
  const saved = await p.evaluate(() => JSON.stringify({ brickyard: 1, saved: '2026-11-09T10:00:00.000Z', catalog: window.brickyard.doc() }));
  const day = await p.evaluate(() => new Date('2026-11-09T10:00:00.000Z').toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })); // as this browser writes a day
  await openFile(p, saved);
  await p.waitForSelector('#cs-go');
  assert.deepEqual([await p.textContent('#cs-old b'), await p.textContent('#cs-old-says'), await p.locator('#cs-old-go').count()], ['Or go back to this file', 'Saved ' + day + '. Everything here is already the way this file has it.', 0],
    'with nothing changed since the file was saved, there is nothing to go back to');
  await p.click('[data-close]');
  // Since the file: a set moved to the wrong box, one removed, one added, and the bookcase removed.
  await p.evaluate(() => { const b = window.brickyard; b.putSet({ ...b.doc().sets.b, box: '7' }); b.addSet({ name: 'Galaxy Explorer' }); b.removeCase('k'); });
  await p.reload();
  await p.click('.item:has-text("Typewriter")');
  await p.click('#e-del'); await p.waitForTimeout(650); await p.click('#e-del');
  await p.click('.toast span');
  const mistake = ['Bonsai Tree in 7, Galaxy Explorer, Orchid', ''];
  assert.deepEqual(await state(), mistake);
  await openFile(p, saved);
  await p.waitForSelector('#cs-old-go');
  assert.equal(await p.textContent('#cs-old-says'), 'Saved ' + day + '. Everything is put back the way this file has it, and changes made since are undone: 2 sets go back to how they were; 1 added since is removed; 1 bookcase changes.',
    'the sheet counts what will change before anything does');
  await p.click('#cs-old-go');
  assert.deepEqual([await p.textContent('#cs-old-go'), await state()], ['Tap again to put everything back', mistake], 'one tap asks, and changes nothing');
  await p.waitForTimeout(650);
  await p.click('#cs-old-go');
  assert.equal(await toast(p), 'Everything is back the way the file has it: 2 sets go back to how they were; 1 added since is removed; 1 bookcase changes.');
  assert.deepEqual(await state(), ['Bonsai Tree in 3, Orchid, Typewriter', 'Billy'], 'the catalog is the way the file has it: the box, the removed set and the bookcase are back, and the set added since is gone');
  assert.equal(await p.evaluate(() => { const d = window.brickyard.doc(); return Math.min(d.sets.b.t, d.sets.t.t, d.sets[Object.keys(d.sets).find(k => d.sets[k].del && k !== 't')].t, d.cases.k.t) > Date.now() - 60000; }), true, 'timed now, so it wins on every device');
  await p.click('.toast button');
  assert.deepEqual([await toast(p), await state()], ['Undone. Your catalog is as it was before.', mistake], 'Undo puts the catalog back as it was before');
  assert.deepEqual(await listed(), ['Typewriter'], 'and Recently removed is as it was');
  // Gone back again and left: the set it removed can still be put back by itself.
  await openFile(p, saved);
  await p.waitForSelector('#cs-old-go');
  await p.click('#cs-old-go'); await p.waitForTimeout(650); await p.click('#cs-old-go');
  await p.click('.toast span');
  assert.deepEqual(await listed(), ['Galaxy Explorer'], 'the set it removed is in Recently removed');
  // A catalog that came by link is for moving between devices: it has the merge alone.
  const link = base + '#b1j' + Buffer.from(saved).toString('base64url');
  await p.goto(link);
  await p.waitForSelector('#cs-go');
  assert.equal(await p.locator('#cs-old').count(), 0, 'a link has no going back');
  await c.close();
}

assert.deepEqual(problems, [], 'problems while using it');
await browser.close();
server.close();
console.log('backup: all good');
