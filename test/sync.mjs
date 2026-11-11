// Drive sync with two (and three) devices sharing one pretend Google Drive:  node test/sync.mjs  (needs Playwright)
// Brickyard is served at its real address through Playwright's routing, so its origin check passes untouched.
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { fakeGoogle } from './fake-google.mjs';

const require = createRequire(import.meta.url);
let pw;
try { pw = require('playwright'); } catch { pw = require(join(execSync('npm root -g').toString().trim(), 'playwright')); }
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SITE = 'https://brickyard.junkdrawer.works/';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json', '.json': 'application/json' };

const browser = await pw.chromium.launch();
// Chromium's language here is US English, where Brickyard starts in inches; every page is opened in British
// English, so it starts in cm, unless a check says otherwise.
const newContext = browser.newContext.bind(browser);
browser.newContext = (o = {}) => newContext({ locale: 'en-GB', ...o });
const g = fakeGoogle();
const problems = [];
async function device(sets) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  await ctx.route(SITE + '**', async r => {
    const p = new URL(r.request().url()).pathname;
    try { r.fulfill({ body: await readFile(join(root, p === '/' ? 'index.html' : p)), contentType: TYPES[extname(p)] || 'text/html' }); } catch { r.fulfill({ status: 404 }); }
  });
  await ctx.route('https://cdn.rebrickable.com/**', r => r.fulfill({ status: 404 }));
  await g.install(ctx);
  const page = await ctx.newPage();
  page.on('pageerror', e => problems.push(e.message));
  page.on('dialog', d => { problems.push('dialog: ' + d.message()); d.dismiss(); });
  await page.goto(SITE);
  if (sets) {
    await page.evaluate(s => localStorage.setItem('brickyard.v1', JSON.stringify({ brickyard: 1, catalog: { sets: s, seen: {} } })), sets);
    await page.reload();
  }
  return { ctx, page };
}
const names = page => page.evaluate(() => Object.values(window.brickyard.doc().sets).filter(x => !x.del).map(x => x.name).sort());
const synced = page => page.waitForFunction(() => { const b = document.querySelector('#home .sync-btn'); return b && !b.hidden && b.dataset.s === 'ok' && b.textContent === 'Synced'; }, null, { timeout: 15000 });
const syncNow = async page => { await page.evaluate(() => window.BrickyardSync.sheet()); await page.click('#dv-sync'); await page.click('[data-close]'); await synced(page); };
const inDriveRooms = () => { const f = g.files().find(x => x.appProperties && x.appProperties.brickyard === 'catalog' && !x.trashed); const c = JSON.parse(f.body).catalog.sets; return [c.a1.room, c.b1.room]; };
const inDrive = () => { const f = g.files().find(x => x.appProperties && x.appProperties.brickyard === 'catalog' && !x.trashed); return f ? Object.values(JSON.parse(f.body).catalog.sets).filter(x => !x.del).map(x => x.name).sort() : null; };
const set = (id, name, t) => ({ id, name, t: t || 1, state: 'built' });

// Turning it on: the offer shows only at Brickyard's own address, and the catalog lands in a Brickyard folder.
const A = await device({ a1: set('a1', 'Bonsai Tree'), a2: set('a2', 'Typewriter') });
assert.equal(await A.page.isVisible('#sync-offer'), true, 'the Drive offer shows');
await A.page.click('#sync-offer');
// By keyboard: the sheet is drawn again as the state changes, and the focus used to be thrown away each time (Enter
// on Connect, then on Sync now, left it on the page behind). It stays on the button, or goes to the one that took
// its place; what the sheet says is a status region, so the change is read out; and when the sheet closes, the
// offer that opened it has gone, so the sync button that replaced it takes the focus.
const at = () => A.page.evaluate(() => { const a = document.activeElement; return a.id || (a.closest('section') ? a.closest('section').id + ' ' : '') + (a.className || a.tagName); });
await A.page.waitForFunction(() => window.__cfg); // Google's script is loaded, so Connect opens it at once
await A.page.focus('#dv-go');
await A.page.keyboard.press('Enter');
await A.page.waitForSelector('#dv-sync');
assert.equal(await at(), 'dv-sync', 'after Connect, the focus is on Sync now');
await A.page.waitForFunction(() => document.querySelector('#dv-says').textContent === 'Last synced just now.');
assert.deepEqual(await A.page.evaluate(() => [document.querySelector('#dv-says').getAttribute('role'), document.querySelector('#dv-ago').getAttribute('aria-live')]), ['status', 'off'], 'what it says is read out; the minutes counting up are not');
await A.page.evaluate(() => { window.__said = []; new MutationObserver(() => window.__said.push(document.querySelector('#dv-says').textContent)).observe(document.querySelector('#dv-says'), { childList: true, subtree: true, characterData: true }); });
await A.page.keyboard.press('Enter');
await A.page.waitForFunction(() => window.__said.length >= 2 && document.querySelector('#dv-says').textContent === 'Last synced just now.');
assert.deepEqual([await at(), (await A.page.evaluate(() => window.__said))[0]], ['dv-sync', 'Syncing now…'], 'Sync now keeps the focus while the sheet says what is happening');
await A.page.keyboard.press('Escape');
await A.page.waitForFunction(() => !(history.state && history.state.sheet));
await A.page.waitForTimeout(100);
assert.equal(await at(), 'home sync-btn', 'closed, the focus is on the sync button');
await synced(A.page);
assert.deepEqual(inDrive(), ['Bonsai Tree', 'Typewriter'], 'the catalog is in Drive');
assert.ok(g.files().some(f => f.mimeType === 'application/vnd.google-apps.folder' && f.name === 'Brickyard' && f.appProperties.brickyard === 'folder'), 'in a Brickyard folder');
assert.equal((await A.page.evaluate(() => window.__cfg)).scope, 'https://www.googleapis.com/auth/drive.file', 'asks for drive.file only');

// A second device joins: nothing is lost on either side.
const B = await device({ b1: set('b1', 'Tree House') });
await B.page.click('#sync-offer'); await B.page.click('#dv-go'); await B.page.click('[data-close]');
await synced(B.page);
assert.deepEqual(await names(B.page), ['Bonsai Tree', 'Tree House', 'Typewriter'], 'the second device has everything');
await syncNow(A.page);
assert.deepEqual(await names(A.page), ['Bonsai Tree', 'Tree House', 'Typewriter'], 'and so does the first');
assert.equal(g.files().filter(f => f.appProperties && f.appProperties.brickyard === 'catalog' && !f.trashed).length, 1, 'one catalog file');

const rooms = page => page.evaluate(() => [window.brickyard.doc().sets.a1.room, window.brickyard.doc().sets.b1.room]);
// Both edit different sets, then the same set: different edits both survive, the later one wins on the same set.
await A.page.evaluate(() => { const d = window.brickyard.doc(); const x = Object.assign({}, d.sets.a1, { room: 'Office' }); window.brickyard.putSet(x); });
await B.page.evaluate(() => { const d = window.brickyard.doc(); const x = Object.assign({}, d.sets.b1, { room: 'Hall' }); window.brickyard.putSet(x); });
await A.page.waitForTimeout(14000); await synced(A.page); await synced(B.page);
assert.deepEqual(inDriveRooms(), ['Office', 'Hall'], 'edits made on two devices at once both reach Drive');
assert.deepEqual(await rooms(A.page), ['Office', 'Hall'], 'and the first device');
// The second too, without being asked: each looks twice after writing (5 and 10 seconds on), so whichever of them
// wrote last has the other's edit as well. With one look, it went without it until the next minute came round,
// about one time in five for the first device and one in two for the second.
assert.deepEqual(await rooms(B.page), ['Office', 'Hall'], 'and the second');
await A.page.evaluate(() => window.brickyard.putSet(Object.assign({}, window.brickyard.doc().sets.a2, { room: 'Den' })));
await A.page.waitForTimeout(100);
await B.page.evaluate(() => window.brickyard.putSet(Object.assign({}, window.brickyard.doc().sets.a2, { room: 'Attic' })));
await A.page.waitForTimeout(9000); await synced(A.page); await synced(B.page);
await syncNow(A.page);
assert.equal(await A.page.evaluate(() => window.brickyard.doc().sets.a2.room), 'Attic', 'the later edit of one set wins');

// Loose pieces travel too: a lot added on one device arrives on the other, and so does removing it.
const lots = page => page.evaluate(() => Object.values(window.brickyard.doc().loose).filter(x => !x.del).map(x => x.name + ' ' + x.parts.reduce((n, r) => n + r[2], 0)));
await A.page.goto(SITE + '#l1j' + Buffer.from(JSON.stringify({ brickyard: 1, loose: { id: 'sf-sync', name: 'Blue tub', parts: [['3001', 4, 40], ['2780', 0, 30]] } })).toString('base64url'));
await A.page.click('#ls-add');
await A.page.waitForTimeout(2600); await synced(A.page);
await syncNow(B.page);
assert.deepEqual(await lots(B.page), ['Blue tub 70'], 'a lot added on one device arrives on the other');
await B.page.evaluate(() => window.brickyard.removeLot('sf-sync'));
await B.page.waitForTimeout(2600); await synced(B.page);
await syncNow(A.page);
assert.deepEqual(await lots(A.page), [], 'a lot removed on one device is gone on the other');
await A.page.goto(SITE); // the lot's link left this device on Build from your box; the rest of the test starts from home

// A removal travels.
await B.page.goto(SITE + '#catalog');
await B.page.click('[data-id="b1"]');
await B.page.click('#e-del'); await B.page.waitForTimeout(700); await B.page.click('#e-del'); // a second tap, not a double tap
await B.page.waitForTimeout(2600); await synced(B.page);
await syncNow(A.page);
assert.deepEqual(await names(A.page), ['Bonsai Tree', 'Typewriter'], 'a set removed on one device is gone on the other');
assert.deepEqual(inDrive(), ['Bonsai Tree', 'Typewriter'], 'and in Drive');

// Bookcases travel set by set. Each device stands a set on the same bookcase before it has heard from the other:
// both sets are there afterwards. (The bookcase went whole, the later one winning, and one device's set came off.)
// Then one device takes a set off while the other renames the bookcase: the set stays off, and the name is kept.
{
  const shelf = page => page.evaluate(() => Object.values(window.BrickCore.shelves(window.brickyard.doc())).filter(c => !c.del).map(c => c.name + ': ' + c.levels.map(l => l.sets.map(s => s.id).join('+')).join(' / ')).join('; '));
  const change = (page, how) => page.evaluate(how => { const c = JSON.parse(JSON.stringify(window.BrickCore.shelves(window.brickyard.doc()).k)); new Function('c', how)(c); window.brickyard.putCase(c); }, how);
  await A.page.evaluate(() => window.brickyard.putCase({ id: 'k', name: 'Billy', w: 76, d: 26, levels: [{ h: 30, sets: [] }, { h: 30, sets: [] }] }));
  await A.page.waitForTimeout(2600); await synced(A.page);
  await syncNow(B.page);
  assert.equal(await shelf(B.page), 'Billy:  / ', 'a bookcase added on one device arrives on the other');
  await change(A.page, 'c.levels[0].sets.push({ id: "a1" })');
  await change(B.page, 'c.levels[0].sets.push({ id: "a2" })');
  await A.page.waitForTimeout(14000); await synced(A.page); await synced(B.page);
  await syncNow(A.page);
  assert.deepEqual([await shelf(A.page), await shelf(B.page)], ['Billy: a1+a2 / ', 'Billy: a1+a2 / '], 'two devices each stand a set on the same bookcase: both sets are on it on both devices');
  await change(B.page, 'c.levels[0].sets = c.levels[0].sets.filter(function (p) { return p.id !== "a1"; })');
  await change(A.page, 'c.name = "Hall Billy"');
  await A.page.waitForTimeout(14000); await synced(A.page); await synced(B.page);
  await syncNow(A.page);
  assert.deepEqual([await shelf(A.page), await shelf(B.page)], ['Hall Billy: a2 / ', 'Hall Billy: a2 / '], 'a set taken off on one device stays off, and the name given on the other is kept');
  const f = g.files().find(x => x.appProperties && x.appProperties.brickyard === 'catalog' && !x.trashed), cat = JSON.parse(f.body).catalog;
  assert.deepEqual([Object.keys(cat.cases.k.levels[0]), cat.places.a1.del, cat.places.a2.c], [['h'], 1, 'k'], 'in Drive, each set has its place by itself');
  await A.page.evaluate(() => window.brickyard.removeCase('k'));
  await A.page.waitForTimeout(2600); await synced(A.page);
  await syncNow(B.page);
  assert.equal(await shelf(B.page), '', 'and a bookcase removed on one device is gone on the other');
}

// Drive answering with an error: the button says Sync failed and a message says why, once. A tap on the button opens
// the sheet, which gives the reason and has Sync now (the reason was only in the button's tooltip, and a tap tried
// again without a word). With no answer at all it says the changes are kept here.
{
  const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS' };
  const broken = r => r.request().method() === 'OPTIONS' ? r.fulfill({ status: 204, headers: CORS })
    : r.fulfill({ status: 500, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: { code: 500, message: 'Backend Error' } }) });
  const btn = () => A.page.evaluate(() => { const b = document.querySelector('#home .sync-btn'); return [b.dataset.s, b.textContent, b.title]; });
  const toast = () => A.page.evaluate(() => { const t = document.querySelector('.toast'); return t.hidden ? '' : t.querySelector('span').textContent; });
  const failed = () => A.page.waitForFunction(() => document.querySelector('#home .sync-btn').dataset.s === 'err', null, { timeout: 15000 });
  assert.deepEqual(await btn(), ['ok', 'Synced', 'Synced with Google Drive']);
  await A.ctx.route('https://www.googleapis.com/**', broken);
  await A.page.evaluate(() => window.brickyard.putSet(Object.assign({}, window.brickyard.doc().sets.a2, { room: 'Loft' })));
  assert.deepEqual(await btn(), ['ok', 'Saving', 'Saving to Google Drive'], 'while a change waits to go, the button’s description says Saving too');
  await failed();
  assert.deepEqual(await btn(), ['err', 'Sync failed', 'Drive said: Backend Error']);
  // It waits its turn behind the line about what the last sync brought in ("From your other devices: …").
  await A.page.waitForFunction(() => { const t = document.querySelector('.toast'); return !t.hidden && /^Sync didn/.test(t.textContent); });
  assert.equal(await toast(), 'Sync didn’t work. Drive said: Backend Error', 'a message says why');
  await A.page.click('.toast');
  await A.page.click('#home .sync-btn');
  assert.deepEqual([await A.page.textContent('#sheetTitle'), await A.page.textContent('#drive-sheet .flag'), await A.page.locator('#dv-sync').count()],
    ['Sync with Google Drive', 'Drive said: Backend Error', 1], 'a tap on Sync failed opens the sheet with the reason and Sync now');
  await A.page.click('#dv-sync');
  await A.page.waitForFunction(() => /Syncing now/.test(document.getElementById('drive-sheet').textContent) === false && document.querySelector('#home .sync-btn').dataset.s === 'err');
  await A.page.waitForTimeout(600);
  assert.deepEqual([await toast(), await A.page.textContent('#drive-sheet .flag')], ['', 'Drive said: Backend Error'], 'the same failure again isn’t said twice; the sheet still shows it');
  await A.page.click('[data-close]');
  // No answer at all.
  await A.ctx.unroute('https://www.googleapis.com/**', broken);
  const dead = r => r.abort();
  await A.ctx.route('https://www.googleapis.com/**', dead);
  await A.page.evaluate(() => window.BrickyardSync.sheet());
  await A.page.click('#dv-sync');
  await A.page.click('[data-close]');
  await A.page.waitForFunction(() => !document.querySelector('.toast').hidden);
  assert.equal(await toast(), 'Couldn’t reach Google Drive. Your changes are kept here, and sync when it answers.');
  await A.page.click('.toast');
  // Drive back: Sync now from the sheet puts it right.
  await A.ctx.unroute('https://www.googleapis.com/**', dead);
  await A.page.click('#home .sync-btn');
  await A.page.click('#dv-sync');
  await A.page.click('[data-close]');
  await synced(A.page);
  assert.equal(JSON.parse(g.files().find(x => x.appProperties && x.appProperties.brickyard === 'catalog' && !x.trashed).body).catalog.sets.a2.room, 'Loft', 'and the change reaches Drive');
}

// An hour later Google wants a tap: the button says so, and one tap signs in again and syncs.
await A.page.evaluate(() => {
  const d = JSON.parse(localStorage.getItem('brickyard.drive')); d.exp = 1; localStorage.setItem('brickyard.drive', JSON.stringify(d));
  const g = JSON.parse(localStorage.getItem('junkdrawer.google')); g.exp = 1; localStorage.setItem('junkdrawer.google', JSON.stringify(g));
});
await A.page.reload();
await A.page.waitForFunction(() => document.querySelector('#home .sync-btn').dataset.s === 'tap');
await A.page.waitForFunction(() => window.__cfg); // Google's script is loaded, so the tap opens it at once
assert.deepEqual(await A.page.evaluate(() => [document.querySelector('.toast').hidden, document.querySelector('.toast span').textContent, document.querySelector('#home .sync-btn').title]),
  [false, 'Google signs Brickyard out after an hour. Tap Sync to sync again.', 'Google signs Brickyard out after an hour. Tap to sync again.'], 'and a message says why, where a phone can read it');
await A.page.click('#home .sync-btn');
await synced(A.page);
assert.equal((await A.page.evaluate(() => window.__prompts)).slice(-1)[0].login_hint, 'mark@gmail.com', 'signing in again skips the account chooser');

// A sign-in from another junkdrawer.works app at this address is reused without asking.
const C3 = await device({ c1: set('c1', 'Galaxy Explorer') });
await C3.page.evaluate(() => localStorage.setItem('junkdrawer.google', JSON.stringify({ token: 'tok-mark', exp: Date.now() + 3e6, scope: 'https://www.googleapis.com/auth/drive.file', email: 'mark@gmail.com' })));
await C3.page.click('#sync-offer'); await C3.page.click('#dv-go'); await C3.page.click('[data-close]');
await synced(C3.page);
assert.equal(await C3.page.evaluate(() => window.__prompts), undefined, 'no Google window');
assert.deepEqual(await names(C3.page), ['Bonsai Tree', 'Galaxy Explorer', 'Typewriter'], 'the third device joined');

// Stopping leaves the catalog, the Drive file and the shared sign-in alone, and never revokes.
await C3.page.evaluate(() => window.BrickyardSync.sheet());
await C3.page.click('#dv-off');
assert.equal(await C3.page.isVisible('#home .sync-btn'), false, 'the sync button goes');
assert.equal(await C3.page.evaluate(() => !!localStorage.getItem('junkdrawer.google') && !window.__revoked), true, 'shared sign-in kept, nothing revoked');
assert.deepEqual(await names(C3.page), ['Bonsai Tree', 'Galaxy Explorer', 'Typewriter'], 'the catalog stays');

// Elsewhere (not Brickyard's address) there's no Drive at all, and the menu's link carries the whole catalog across.
const local = await browser.newContext({ serviceWorkers: 'block', permissions: ['clipboard-read', 'clipboard-write'] });
await local.route('http://other.test/**', async r => {
  const p = new URL(r.request().url()).pathname;
  try { r.fulfill({ body: await readFile(join(root, p === '/' ? 'index.html' : p)), contentType: TYPES[extname(p)] || 'text/html' }); } catch { r.fulfill({ status: 404 }); }
});
const L = await local.newPage();
L.on('pageerror', e => problems.push(e.message));
await L.goto('http://other.test/');
await L.evaluate(s => localStorage.setItem('brickyard.v1', JSON.stringify({ brickyard: 1, catalog: { sets: s, seen: {} } })), { l1: set('l1', 'World Map'), l2: set('l2', 'Enterprise') });
await L.reload();
assert.equal(await L.isVisible('#sync-offer'), false, 'no Drive offer away from Brickyard’s address');
await L.goto('http://other.test/#catalog');
await L.click('#menu-btn');
assert.equal(await L.locator('#m-sync').count(), 0, 'no Drive in the menu there');
await L.click('#m-link');
await L.waitForTimeout(300);
const link = await L.inputValue('#all-link');
assert.ok(link.startsWith(SITE + '#b2z'), 'the link points at Brickyard, and is the checked kind');
await A.page.goto(link);
await A.page.waitForSelector('#cs-go');
await A.page.click('#cs-go');
const merged = await names(A.page);
assert.ok(merged.includes('Enterprise') && merged.includes('World Map') && merged.includes('Bonsai Tree'), 'opening it merges the catalog in');
await A.page.waitForTimeout(2600); await synced(A.page);
assert.deepEqual(inDrive(), ['Bonsai Tree', 'Enterprise', 'Galaxy Explorer', 'Typewriter', 'World Map'], 'and sync takes it to Drive');

// The same set added on two devices before the second one's first sync: an exact twin is kept once, and a message
// says so; a copy that differs (another room) stays a second set. Later syncs never fold anything.
{
  const toast = page => page.evaluate(() => { const t = document.querySelector('.toast'); return t.hidden ? '' : t.querySelector('span').textContent; });
  const orchid = (id, more) => ({ id, t: 5, num: '10311-1', name: 'Orchid', state: 'built', room: 'Office', added: '2026-11-01', ...more });
  const count = (page, name) => page.evaluate(n => Object.values(window.brickyard.doc().sets).filter(x => !x.del && x.name === n).length, name);
  await A.page.goto(SITE);
  await A.page.evaluate(x => window.brickyard.putSet(x), orchid('n1'));
  await A.page.waitForTimeout(2600); await synced(A.page);
  const F = await device({ f1: orchid('f1', { added: '2026-11-03' }), f2: orchid('f2', { room: 'Hall' }) });
  await F.page.click('#sync-offer'); await F.page.click('#dv-go'); await F.page.click('[data-close]');
  await synced(F.page);
  assert.deepEqual(await F.page.evaluate(() => Object.values(window.brickyard.doc().sets).filter(x => !x.del && x.name === 'Orchid').map(x => x.id).sort()), ['f2', 'n1'], 'on its first sync the exact twin is kept once; the Orchid in another room is a second set');
  await F.page.waitForFunction(() => /kept once/.test(document.querySelector('.toast').textContent));
  assert.equal(await toast(F.page), 'Orchid is on both devices with the same details: it’s kept once.');
  await F.page.waitForTimeout(2600); await synced(F.page);
  await syncNow(A.page);
  assert.deepEqual([await count(A.page, 'Orchid'), await A.page.evaluate(() => [!window.brickyard.doc().sets.n1.del, window.brickyard.doc().sets.f1.del])], [2, [true, 1]], 'the first device keeps its own copy, and the twin never shows there');
  // Once a device has synced, a second copy made on it on purpose is never folded.
  await F.page.evaluate(x => window.brickyard.putSet(x), orchid('f9'));
  await F.page.waitForTimeout(2600); await synced(F.page);
  await syncNow(A.page);
  assert.equal(await count(A.page, 'Orchid'), 3, 'a copy added after the first sync stays');
}

// What a sync brought in from another device is said in one line; nothing is said for this device's own changes.
{
  const said = async page => { await page.waitForFunction(() => { const t = document.querySelector('.toast'); return !t.hidden && /^From your other devices/.test(t.textContent); }); return page.evaluate(() => document.querySelector('.toast span').textContent); };
  const quiet = page => page.evaluate(() => { const t = document.querySelector('.toast'); return t.hidden || !/^From your other devices/.test(t.textContent); });
  const B2 = await device();
  await B2.page.click('#sync-offer'); await B2.page.click('#dv-go'); await B2.page.click('[data-close]');
  await synced(B2.page);
  assert.match(await said(B2.page), /^From your other devices: \d+ sets added$/, 'a device that joins is told how many sets arrived');
  await B2.page.click('.toast');
  if (await A.page.isVisible('.toast')) await A.page.click('.toast span'); // what an earlier sync brought in, kept up by the mouse resting on it
  await A.page.evaluate(() => window.brickyard.putSet({ id: 'v1', name: 'Saturn V', state: 'built' }));
  await A.page.waitForTimeout(2600); await synced(A.page);
  assert.equal(await quiet(A.page), true, 'nothing is said on the device that made the change');
  await syncNow(B2.page);
  assert.equal(await said(B2.page), 'From your other devices: 1 set added');
  await B2.page.click('.toast');
  await A.page.goto(SITE + '#catalog');
  await A.page.evaluate(() => window.brickyard.putSet(Object.assign({}, window.brickyard.doc().sets.v1, { room: 'Den' })));
  await A.page.click('.item:has-text("Typewriter")');
  await A.page.click('#e-del'); await A.page.waitForTimeout(700); await A.page.click('#e-del');
  await A.page.waitForTimeout(2600);
  await A.page.goto(SITE); await synced(A.page);
  await syncNow(B2.page);
  assert.equal(await said(B2.page), 'From your other devices: 1 set changed, Typewriter removed');
  await B2.page.click('.toast');
  await syncNow(B2.page);
  assert.equal(await quiet(B2.page), true, 'a sync that brings nothing says nothing');

  // The sync button is on Build from your box and the Shelf planner too (bookcases and loose pieces sync), and
  // gives way to a model's own name and menu.
  const btn = (page, screen) => page.evaluate(s => { const b = document.querySelector('#' + s + ' .sync-btn'); return b.getClientRects().length ? b.textContent : ''; }, screen);
  await B2.page.goto(SITE + '#shelves');
  await B2.page.waitForFunction(() => document.querySelector('#shelves .sync-btn').textContent === 'Synced');
  assert.equal(await btn(B2.page, 'shelves'), 'Synced', 'on the Shelf planner');
  await B2.page.goto(SITE + '#build');
  await B2.page.waitForSelector('#build-list .item');
  assert.equal(await btn(B2.page, 'build'), 'Synced', 'on Build from your box');
  assert.equal(await B2.page.evaluate(() => { const h = document.querySelector('#build h1').getBoundingClientRect(), s = getComputedStyle(document.querySelector('#build h1')); return Math.round(h.height / parseFloat(s.lineHeight)); }), 1, 'the title beside it is still on one line on a phone');
  await B2.page.goto(SITE + '#model-x-cottage');
  await B2.page.waitForSelector('#model-menu:not([hidden])');
  assert.equal(await btn(B2.page, 'build'), '', 'not over a model, which has its own name and menu there');
}

assert.deepEqual(problems, [], 'problems while using it');
await browser.close();
console.log('sync: all good');
