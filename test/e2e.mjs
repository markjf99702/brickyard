// Uses Brickyard in Chromium through the real page:  node test/e2e.mjs  (needs Playwright)
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';

const require = createRequire(import.meta.url);
let pw;
try { pw = require('playwright'); } catch { pw = require(join(execSync('npm root -g').toString().trim(), 'playwright')); }
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json', '.json': 'application/json' };
const server = createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let body;
  try { body = await readFile(join(root, path === '/' ? 'index.html' : path)); } catch { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': TYPES[extname(path)] || 'text/html' });
  res.end(body);
}).listen(0);
const base = `http://localhost:${server.address().port}/`;

const browser = await pw.chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true });
// Set pictures come from Rebrickable; here they all fail, which shows the plain brick instead.
const pictures = [];
await ctx.route('https://cdn.rebrickable.com/**', r => { pictures.push(r.request().url()); r.fulfill({ status: 404 }); });
const page = await ctx.newPage();
const problems = [];
page.on('pageerror', e => problems.push(e.message));
page.on('console', m => { if (m.type() === 'error' && !/404/.test(m.text())) problems.push(m.text()); });
page.on('request', r => { if (!r.url().startsWith(base) && !r.url().startsWith('https://cdn.rebrickable.com/')) problems.push('left the site: ' + r.url()); });
page.on('dialog', d => { problems.push('dialog: ' + d.message()); d.dismiss(); });
const doc = () => page.evaluate(() => window.brickyard.doc());
const live = async () => Object.values((await doc()).sets).filter(x => !x.del);

await page.goto(base);
await page.evaluate(() => document.fonts.ready);
assert.match(await page.textContent('#home-stat'), /Nothing here yet/);

// Add a set by hand.
await page.click('#go-catalog');
await page.waitForSelector('.empty');
await page.click('#add-btn');
await page.fill('#e-num', '10698');
await page.fill('#e-name', 'Large Creative Brick Box');
await page.fill('#e-pieces', '790');
await page.click('#e-state [data-v="apart"]');
await page.fill('#e-room', 'Office');
await page.fill('#e-box', '7');
await page.click('#e-save');
let sets = await live();
assert.equal(sets.length, 1);
assert.deepEqual([sets[0].num, sets[0].state, sets[0].box, sets[0].pieces], ['10698-1', 'apart', '7', 790]);
assert.equal(await page.locator('.item').count(), 1);
assert.ok(pictures.some(u => u.includes('10698-1')), 'asked Rebrickable for the picture');
await page.waitForSelector('.item .pic.none');

// A bad set number is refused.
await page.click('#add-btn');
await page.fill('#e-num', 'hello');
await page.click('#e-save');
assert.equal((await live()).length, 1);
await page.click('[data-close]');

// Open a link from Claude's script: the 10698 already owned comes in unticked.
const dir = await mkdtemp(join(tmpdir(), 'brickyard-'));
const out = execSync(`python3 skill/brickyard-cataloger/scripts/make_brickyard.py test/fixtures/sample.json --out ${JSON.stringify(dir)}`, { cwd: root }).toString();
const link = out.trim().split('\n').find(l => l.startsWith('https://'));
await page.goto(base + link.slice(link.indexOf('#')));
await page.waitForSelector('.rv');
assert.equal(await page.locator('.rv li').count(), 7);
assert.equal(await page.locator('.rv li.off').count(), 1, 'the set already owned is unticked');
assert.match(await page.textContent('#rv-add'), /Add 6 sets/);
await page.click('#rv-add');
sets = await live();
assert.equal(sets.length, 7);
assert.ok(!/#b1z/.test(page.url()), 'the link is cleared from the address');

// Opening it again says so.
await page.goto(base + link.slice(link.indexOf('#')));
await page.waitForSelector('.rv');
assert.match(await page.textContent('.sheet'), /opened this link before/);
assert.equal(await page.locator('.rv li.off').count(), 7);
await page.click('[data-close]');

// Filter, search and group.
await page.click('.chip[data-f="sealed"]');
assert.equal(await page.locator('.item').count(), 1);
await page.click('.chip[data-f="all"]');
await page.fill('#q', 'box 3');
assert.equal(await page.locator('.item').count(), 2);
await page.fill('#q', '');
await page.selectOption('#group', 'box');
assert.deepEqual(await page.locator('.group span:first-child').allTextContents(), ['Box 3', 'Box 7', 'Box 12', 'Not packed']);

// Edit: clear a check, then remove a set.
await page.click('.item:has-text("Lamborghini")');
await page.click('#e-ok');
await page.click('#e-save');
assert.ok(!(await live()).find(x => /Lamborghini/.test(x.name)).check);
await page.click('.item:has-text("Medieval Castle")');
await page.click('#e-del');
assert.equal((await live()).length, 7, 'one tap does not remove');
await page.click('#e-del');
assert.equal((await live()).length, 6);
assert.equal(Object.values((await doc()).sets).filter(x => x.del).length, 1, 'removal is remembered');

// Pictures can be turned off.
await page.click('#menu-btn');
await page.click('#m-pics');
await page.click('[data-close]');
const before = pictures.length;
await page.reload();
assert.equal(pictures.length, before, 'no pictures asked for once turned off');

// Backup round trip: download, then open on a fresh browser.
await page.click('#menu-btn');
const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#m-backup')]);
const backup = await readFile(await dl.path(), 'utf8');
const fresh = await browser.newContext({ viewport: { width: 390, height: 844 } });
const p2 = await fresh.newPage();
await p2.goto(base + '#catalog');
await p2.setInputFiles('#file', { name: 'b.json', mimeType: 'application/json', buffer: Buffer.from(backup) });
await p2.click('#cs-go');
assert.equal(await p2.locator('.item').count(), 6);
await fresh.close();

// The spreadsheet.
await page.click('#menu-btn');
const [csv] = await Promise.all([page.waitForEvent('download'), page.click('#m-csv')]);
const rows = (await readFile(await csv.path(), 'utf8')).trim().split('\r\n');
assert.equal(rows.length, 7);

// Build from your box: add the box, the example builds, step through it, open a link from Claude.
await page.goto(base + '#build');
await page.waitForSelector('#build-list .group');
if (await page.$('#add-box')) await page.click('#add-box');
await page.waitForSelector('[data-pool]');
assert.equal(await page.isChecked('[data-pool]'), true, 'the box counts once added');
assert.match(await page.textContent('a[href="#model-x-cottage"]'), /Can build/);
await page.click('a[href="#model-x-cottage"]');
await page.waitForSelector('#model-view:not([hidden])');
assert.equal(await page.textContent('#step-n'), 'Step 1');
assert.match(await page.textContent('#step-parts'), /Plate 6x12/);
await page.click('#step-next');
assert.equal(await page.textContent('#step-n'), 'Step 2');
await page.evaluate(() => { const r = document.getElementById('step-range'); r.value = r.max; r.dispatchEvent(new Event('input')); });
assert.equal(await page.textContent('#step-n'), 'Done');
assert.match(await page.textContent('#model-check'), /every piece/);
const cottage = JSON.parse(await readFile(join(root, 'models/cottage.json'), 'utf8'));
cottage.model.name = 'Linked cottage';
await page.goto(base + '#d1z' + deflateRawSync(JSON.stringify(cottage)).toString('base64url'));
await page.waitForFunction(() => location.hash.startsWith('#model-m'));
assert.equal(await page.textContent('#build-title'), 'Linked cottage');
await page.goto(base + '#build');
await page.waitForSelector('#build-list .group');
assert.match(await page.textContent('#build-list'), /Linked cottage/);
assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'the build screen scrolls sideways on a phone');

// Shelf planner: sizes from Claude, a bookcase, fit the sets, and copy their places into My sets.
await page.goto(base + '#catalog');
const builtIds = await page.evaluate(() => Object.values(window.brickyard.doc().sets).filter(x => !x.del && (x.state === 'built' || x.state === 'partial') && x.num).map(x => x.num));
assert.ok(builtIds.length >= 2, 'the test catalog has built sets');
const sizeList = builtIds.map((num, i) => ({ num, w: 20 + i * 5, d: 15, h: 10 + i * 3 }));
await page.goto(base + '#z1z' + deflateRawSync(JSON.stringify({ brickyard: 1, sizes: sizeList })).toString('base64url'));
await page.waitForSelector('#zr-go');
await page.click('#zr-go');
await page.waitForSelector('[data-act="add-case"]');
await page.click('[data-act="add-case"]');
await page.fill('#k-name', 'Hall Billy'); await page.fill('#k-room', 'Hall');
await page.click('#k-save');
await page.click('[data-act="fill"]');
assert.equal(await page.locator('.sv-set').count(), builtIds.length, 'every built set is on a shelf');
await page.click('[data-act="apply"]');
assert.equal(await page.evaluate(() => Object.values(window.brickyard.doc().sets).filter(x => x.room === 'Hall' && /^Hall Billy, shelf \d$/.test(x.spot)).length), builtIds.length, 'places copied into My sets');
await page.click('.sv-set');
await page.selectOption('#z-where', '');
await page.click('#z-save');
assert.equal(await page.locator('.sv-set').count(), builtIds.length - 1, 'a set taken off its shelf');
assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'the shelf planner scrolls sideways on a phone');

// Fits a phone: nothing scrolls sideways.
for (const h of ['', '#catalog']) {
  await page.goto(base + h);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'the page scrolls sideways on a phone ' + h);
}

// Installable.
const cdp = await ctx.newCDPSession(page);
const inst = await cdp.send('Page.getInstallabilityErrors');
assert.deepEqual(inst.installabilityErrors, [], 'installable');

// Works offline once it has been opened.
await page.waitForFunction(() => navigator.serviceWorker?.controller, null, { timeout: 10000 }).catch(() => {});
await ctx.setOffline(true);
await page.reload();
assert.equal(await page.title(), 'Brickyard', 'the page did not load offline');
await ctx.setOffline(false);

assert.deepEqual(problems, [], 'problems while using it');
await browser.close();
server.close();
console.log('all good');
