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
await A.page.click('#dv-go');
await A.page.click('[data-close]');
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
await syncNow(B.page); // it would on its own within a minute, or when the page is next opened
assert.deepEqual(await rooms(B.page), ['Office', 'Hall'], 'and the second');
await A.page.evaluate(() => window.brickyard.putSet(Object.assign({}, window.brickyard.doc().sets.a2, { room: 'Den' })));
await A.page.waitForTimeout(100);
await B.page.evaluate(() => window.brickyard.putSet(Object.assign({}, window.brickyard.doc().sets.a2, { room: 'Attic' })));
await A.page.waitForTimeout(9000); await synced(A.page); await synced(B.page);
await syncNow(A.page);
assert.equal(await A.page.evaluate(() => window.brickyard.doc().sets.a2.room), 'Attic', 'the later edit of one set wins');

// A removal travels.
await B.page.goto(SITE + '#catalog');
await B.page.click('[data-id="b1"]');
await B.page.click('#e-del'); await B.page.click('#e-del');
await B.page.waitForTimeout(2600); await synced(B.page);
await syncNow(A.page);
assert.deepEqual(await names(A.page), ['Bonsai Tree', 'Typewriter'], 'a set removed on one device is gone on the other');
assert.deepEqual(inDrive(), ['Bonsai Tree', 'Typewriter'], 'and in Drive');

// An hour later Google wants a tap: the button says so, and one tap signs in again and syncs.
await A.page.evaluate(() => {
  const d = JSON.parse(localStorage.getItem('brickyard.drive')); d.exp = 1; localStorage.setItem('brickyard.drive', JSON.stringify(d));
  const g = JSON.parse(localStorage.getItem('junkdrawer.google')); g.exp = 1; localStorage.setItem('junkdrawer.google', JSON.stringify(g));
});
await A.page.reload();
await A.page.waitForFunction(() => document.querySelector('#home .sync-btn').dataset.s === 'tap');
await A.page.waitForFunction(() => window.__cfg); // Google's script is loaded, so the tap opens it at once
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
assert.ok(link.startsWith(SITE + '#b1z'), 'the link points at Brickyard');
await A.page.goto(link);
await A.page.waitForSelector('#cs-go');
await A.page.click('#cs-go');
const merged = await names(A.page);
assert.ok(merged.includes('Enterprise') && merged.includes('World Map') && merged.includes('Bonsai Tree'), 'opening it merges the catalog in');
await A.page.waitForTimeout(2600); await synced(A.page);
assert.deepEqual(inDrive(), ['Bonsai Tree', 'Enterprise', 'Galaxy Explorer', 'Typewriter', 'World Map'], 'and sync takes it to Drive');

assert.deepEqual(problems, [], 'problems while using it');
await browser.close();
console.log('sync: all good');
