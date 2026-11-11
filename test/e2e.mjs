// Uses Brickyard in Chromium through the real page:  node test/e2e.mjs  (needs Playwright)
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';

const require = createRequire(import.meta.url);
let pw;
try { pw = require('playwright'); } catch { pw = require(join(execSync('npm root -g').toString().trim(), 'playwright')); }
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json', '.json': 'application/json' };
// The server answers the way GitHub Pages does: a browser may keep each file for ten minutes, and asks again by its
// ETag. `net` is the connection: 'up', 'down' (the server drops every connection) or 'stalled' (a garage with one bar
// of signal, a captive wifi: it takes each request and holds on to it). With `release` set it serves the next release
// (see the end).
let net = 'up', release = false;
const held = [];
const server = createServer((req, res) => {
  if (net === 'down') { req.socket.destroy(); return; }
  if (net === 'stalled') { held.push([req, res]); return; }
  serve(req, res);
}).listen(0);
async function serve(req, res) {
  let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (path.endsWith('/')) path += 'index.html';
  let body;
  try { body = await readFile(join(root, path)); } catch { res.writeHead(404); res.end(); return; }
  if (release && path === '/sw.js') body = Buffer.from(String(body).replace(/const FILES = '[0-9a-f]*'/, "const FILES = 'next'"));
  if (release && path === '/index.html') body = Buffer.concat([body, Buffer.from('<!-- the next release -->\n')]);
  const etag = `"${createHash('sha1').update(body).digest('hex').slice(0, 16)}"`;
  const head = { etag, 'cache-control': 'max-age=600', 'content-type': TYPES[extname(path)] || 'text/html' };
  if (req.headers['if-none-match'] === etag) { res.writeHead(304, head); res.end(); return; }
  res.writeHead(200, head);
  res.end(body);
}
const base = `http://localhost:${server.address().port}/`;
// Waits for ok() to come true, for up to ms, or fails saying what didn't happen.
const until = async (ok, ms, what) => {
  for (const end = Date.now() + ms; !(await ok());) { assert.ok(Date.now() < end, what); await new Promise(r => setTimeout(r, 100)); }
};

const browser = await pw.chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true });
// Set pictures come from Rebrickable; here they all fail, which shows the plain brick instead.
// `told` is what a picture request said about where it came from (its Referer), which should be nothing.
const pictures = [], told = [];
await ctx.route('https://cdn.rebrickable.com/**', r => {
  pictures.push(r.request().url());
  const h = r.request().headers();
  for (const k of ['referer', 'origin', 'cookie']) if (h[k]) told.push(k + ': ' + h[k]);
  r.fulfill({ status: 404 });
});
const page = await ctx.newPage();
const problems = [];
page.on('pageerror', e => problems.push(e.message));
page.on('console', m => { if (m.type() === 'error' && !/404/.test(m.text())) problems.push(m.text()); });
page.on('request', r => { if (!r.url().startsWith(base) && !r.url().startsWith('https://cdn.rebrickable.com/')) problems.push('left the site: ' + r.url()); });
page.on('dialog', d => { problems.push('dialog: ' + d.message()); d.dismiss(); });
const doc = () => page.evaluate(() => window.brickyard.doc());
const live = async () => Object.values((await doc()).sets).filter(x => !x.del);
// Closing a sheet with changes in it: Close asks first, and the next tap, a moment later, closes it.
const discard = async p => { await p.click('[data-close]'); await p.waitForTimeout(650); await p.click('[data-close]'); };
// A browser of its own with this catalog already saved in it, for checks that need particular sets.
async function withSets(catalog, opts = {}) {
  const c = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, serviceWorkers: 'block', ...opts });
  await c.route('https://cdn.rebrickable.com/**', r => r.fulfill({ status: 404 }));
  const p = await c.newPage();
  p.on('pageerror', e => problems.push(e.message));
  await p.goto(base);
  await p.evaluate(cat => localStorage.setItem('brickyard.v1', JSON.stringify({ brickyard: 1, catalog: cat })), catalog);
  await p.reload();
  return { c, p };
}

await page.goto(base);
await page.evaluate(() => document.fonts.ready);
assert.equal(await page.textContent('#home-stat'), 'No sets yet. Start here.');

// A link cut short (as a chat app can leave it) says so when Brickyard opens on it, with what to do, on the screen
// that kind of link belongs to; so does a link of a newer format than this copy of the page knows. Everything else
// still works.
const CUT = 'That Brickyard link is cut short or has a wrong character. Copy the whole link again, or open the file that came with it.';
const NEWER = 'That link needs a newer Brickyard. Reload the page, then open it again.';
// The checked form of a link: a 2 where the others have a 1, and seven characters worked out from the rest on its end
// (linkCheck in js/core.js: FNV-1a of the kind and the data, in base 36). With one wrong character it isn't opened.
const WRONG = 'That Brickyard link has a wrong or missing character, so nothing was opened. Copy the whole link again, or open the file that came with it.';
const checked = (kind, data) => { let h = 2166136261; for (const ch of kind + data) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0; return '#' + kind + data + h.toString(36).padStart(7, '0'); };
{
  const p = await ctx.newPage();
  p.on('pageerror', e => problems.push(e.message));
  const packed = o => deflateRawSync(JSON.stringify(o)).toString('base64url');
  const whole = '#b1z' + packed({ brickyard: 1, batch: { sets: Array.from({ length: 12 }, (_, i) => ({ num: String(21300 + i), name: 'Set number ' + i, room: 'Office' })) } });
  const plain = '#b1j' + Buffer.from(JSON.stringify({ brickyard: 1, batch: { sets: [{ num: '10698', name: 'Large Creative Brick Box' }] } })).toString('base64url');
  const screen = () => p.evaluate(() => ['home', 'catalog', 'build', 'shelves'].filter(id => !document.getElementById(id).hidden).join());
  for (const [h, says, on] of [['#b1zAAAAA', CUT, 'catalog'], ['#l1zA', CUT, 'build'], ['#z1zA', CUT, 'shelves'], ['#d1zA', CUT, 'build'],
    [whole.slice(0, whole.length - 9), CUT, 'catalog'], [whole.slice(0, 60), CUT, 'catalog'], [plain.slice(0, 80), CUT, 'catalog'], ['#batch=%7B%22sets%22%3A%5B%7B%22num', CUT, 'catalog'],
    ['#b3z' + whole.slice(4), NEWER, 'home'], ['#q7j' + plain.slice(4), NEWER, 'home'], ['#q2z' + whole.slice(4), NEWER, 'home'],
    // A checked link with a character changed, missing or cut off the end says so, for every kind, on its own screen.
    ...[['b2z', { brickyard: 1, batch: { sets: [{ num: '10698', name: 'Large Creative Brick Box' }] } }, 'catalog'], ['l2z', { brickyard: 1, loose: { name: 'Tub', parts: [['3001', 4, 12]] } }, 'build'],
      ['z2z', { brickyard: 1, sizes: [{ num: '10497', w: 52, d: 32, h: 13 }] }, 'shelves'], ['d2z', { brickyard: 1, model: { name: 'Wall', parts: [['3001', 4, 0, 0, 0, 0, 1]] } }, 'build']].flatMap(([kind, o, on]) => {
      const l = checked(kind, packed(o));
      return [[l.slice(0, 20) + (l[20] === 'A' ? 'B' : 'A') + l.slice(21), WRONG, on], [l.slice(0, 20) + l.slice(21), WRONG, on], [l.slice(0, l.length - 3), WRONG, on]];
    }),
    [checked('b2j', plain.slice(4)).replace(/.$/, c => c === 'a' ? 'b' : 'a'), WRONG, 'catalog']]) {
    await p.goto('about:blank');
    await p.goto(base + h);
    await p.waitForFunction(() => { const t = document.querySelector('.toast'); return t && !t.hidden; }, null, { timeout: 10000 });
    assert.deepEqual([await p.textContent('.toast'), await screen()], [says, on], 'what a link that can’t be opened says: ' + h.slice(0, 24));
    assert.equal(await p.evaluate(() => typeof window.brickyard), 'object', 'Brickyard started after a cut-off ' + h);
    assert.ok(!/[bldzq]\d[zj]/.test(await p.evaluate(() => location.hash)), 'and the link is gone from the address');
  }
  // It stays up long enough to read (7 seconds, where a short message gets 3), and then goes.
  await p.waitForTimeout(4000);
  assert.equal(await p.isVisible('.toast'), true, 'the message is still there after 4 seconds');
  await p.waitForFunction(() => document.querySelector('.toast').hidden, null, { timeout: 6000 });
  await p.goto(base + '#build');
  await p.waitForSelector('#build-list .group');
  // Whole, a checked link of each kind opens what it carries, on its own screen: sets and loose pieces to review,
  // sizes with no sets to put them on say so, a model opens.
  const title = () => p.textContent('#sheetTitle');
  await p.goto('about:blank');
  await p.goto(base + checked('b2z', whole.slice(4)));
  await p.waitForSelector('.sheet');
  assert.deepEqual([await title(), await p.locator('#rv li').count(), await screen(), await p.evaluate(() => location.hash)], ['Add sets from Claude', 12, 'catalog', '#catalog'], 'a checked link of sets opens its review');
  await p.goto('about:blank');
  await p.goto(base + checked('b2j', plain.slice(4)));
  await p.waitForSelector('.sheet');
  assert.deepEqual([await title(), await p.textContent('#rv .t')], ['Add sets from Claude', 'Large Creative Brick Box'], 'and an uncompressed one');
  await p.goto('about:blank');
  await p.goto(base + checked('l2z', packed({ brickyard: 1, loose: { name: 'Tub', parts: [['3001', 4, 12]] } })));
  await p.waitForSelector('.sheet');
  assert.deepEqual([await title(), await screen()], ['Add loose pieces', 'build'], 'a checked link of loose pieces opens its review');
  await p.goto('about:blank');
  await p.goto(base + checked('d2z', packed({ brickyard: 1, model: { name: 'Checked wall', parts: [['3001', 4, 0, 0, 0, 0, 1], ['3001', 4, 0, 3, 0, 0, 2]] } })));
  await p.waitForFunction(() => /^#model-/.test(location.hash) && document.getElementById('build-title').textContent === 'Checked wall', null, { timeout: 15000 });
  await p.evaluate(() => localStorage.removeItem('brickyard.models')); // this browser's models are counted further down
  await p.goto('about:blank');
  await p.goto(base + checked('z2z', packed({ brickyard: 1, sizes: [{ num: '10497', w: 52, d: 32, h: 13 }] })));
  await p.waitForFunction(() => { const s = document.querySelector('.sheet'), t = document.querySelector('.toast'); return s || (t && !t.hidden); }, null, { timeout: 10000 });
  assert.deepEqual([await screen(), await p.evaluate(() => { const t = document.querySelector('.toast'); return !!t && !t.hidden && /wrong|cut short|newer/.test(t.textContent); })], ['shelves', false], 'a checked sizes link is read on the shelf planner');
  await p.close();
}

// A browser that won't save says so, and "Added" doesn't cover the warning.
{
  const c2 = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  await c2.route('https://cdn.rebrickable.com/**', r => r.fulfill({ status: 404 }));
  await c2.addInitScript(() => {
    const real = Storage.prototype.setItem;
    Storage.prototype.setItem = function (k, v) { if (k === 'brickyard.v1') throw new DOMException('full', 'QuotaExceededError'); return real.call(this, k, v); };
  });
  const p = await c2.newPage();
  p.on('pageerror', e => problems.push(e.message));
  await p.goto(base + '#catalog');
  await p.click('.empty [data-act="add"]');
  await p.fill('#e-num', '10698');
  await p.click('#e-save');
  assert.match(await p.textContent('.toast'), /wouldn’t save. Download a backup/, 'the save warning shows, not Added');
  await p.evaluate(() => window.brickyard.toast('Something else'));
  assert.match(await p.textContent('.toast'), /wouldn’t save/, 'the warning stays up');
  await p.click('.toast');
  assert.equal(await p.isVisible('.toast'), true, 'and a tap doesn’t put a held warning away');
  // The preview copy (in a frame) can't download a backup, so it points at the link instead.
  await p.setContent(`<iframe src="${base}#catalog" style="width:390px;height:800px"></iframe>`);
  const f = await (await p.waitForSelector('iframe')).contentFrame();
  await f.click('.empty [data-act="add"]');
  await f.fill('#e-num', '10698');
  await f.click('#e-save');
  assert.match(await f.textContent('.toast'), /wouldn’t save. Copy everything as a link/, 'the preview says to copy a link');
  await c2.close();
}

// Add a set by hand. With no sets yet, the empty state's buttons are the only ones (not repeated at the bottom).
await page.click('#go-catalog');
await page.waitForSelector('.empty');
assert.equal(await page.locator('#catalog .fab-row').isHidden(), true, 'the bottom buttons wait until there are sets');
assert.equal(await page.locator('#catalog button:visible', { hasText: 'Add a set' }).count(), 1, 'one + Add a set on an empty catalog');
await page.click('.empty [data-act="add"]');
assert.deepEqual(await page.$$eval('#e-num, #e-name, #e-theme, #e-room, #e-spot', els => els.map(e => e.placeholder)),
  ['e.g. 10698', 'e.g. Large Creative Brick Box', 'e.g. Classic', 'e.g. Office', 'e.g. Top shelf'], 'examples say they’re examples');
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
assert.equal(await page.locator('#catalog .fab-row').isVisible(), true, 'the bottom buttons are back once there are sets');
await page.waitForSelector('.item .pic.none'); // the picture was asked for, and failed here
assert.ok(pictures.some(u => u.includes('10698-1')), 'asked Rebrickable for the picture');
assert.deepEqual(told, [], 'and told it nothing else: not which site asked');

// A bad set number is refused.
await page.click('#add-btn');
await page.fill('#e-num', 'hello');
await page.click('#e-save');
assert.equal((await live()).length, 1);
await discard(page);

// A set you already have takes a second tap to add again, and a double tap is still one tap.
await page.click('#add-btn');
await page.fill('#e-num', '10698');
await page.dblclick('#e-save');
assert.equal((await live()).length, 1, 'a double tap does not add a second copy');
assert.equal(await page.textContent('#e-save'), 'Add another copy');
await discard(page);

// Open a link from Claude's script: the 10698 already owned comes in unticked.
const dir = await mkdtemp(join(tmpdir(), 'brickyard-'));
const out = execSync(`python3 skill/brickyard-cataloger/scripts/make_brickyard.py test/fixtures/sample.json --out ${JSON.stringify(dir)}`, { cwd: root }).toString();
const link = out.trim().split('\n').find(l => l.startsWith('https://'));
await page.goto(base + link.slice(link.indexOf('#')));
await page.waitForSelector('.rv');
assert.equal(await page.locator('.rv li').count(), 7);
// It's owned once, and the link has it on a shelf the catalog doesn't: that row offers to move it (see further down).
// Unticked here, so the catalog below is the one these checks were written for.
assert.deepEqual([await page.locator('.rv li.off').count(), await page.textContent('.rv li .w'), await page.textContent('#rv-add')], [0, 'Move it: Office › Closet, still in Box 7 (now Office · Box 7)', 'Add 6, move 1'], 'the set already owned is offered as a move');
await page.click('.rv li >> nth=0 >> input');
assert.equal(await page.locator('.rv li.off').count(), 1, 'the set already owned is unticked');
assert.match(await page.textContent('#rv-add'), /Add 6 sets/);
assert.deepEqual(await page.$$eval('.bulk label > span', s => s.map(x => x.textContent)), ['Room', 'Shelf or spot', 'Moving box'], 'the fields for the whole batch have labels');
// A tap anywhere on a row ticks or unticks it, not only on its little box.
await page.click('.rv li >> nth=1 >> .t');
assert.match(await page.textContent('#rv-add'), /Add 5 sets/, 'tapping a set’s name unticks it');
assert.equal(await page.locator('.rv li').nth(1).getAttribute('class'), 'off');
await page.click('.rv li >> nth=1 >> .pic');
assert.match(await page.textContent('#rv-add'), /Add 6 sets/, 'tapping its picture ticks it again');
await page.click('.rv li >> nth=1 >> input');
assert.match(await page.textContent('#rv-add'), /Add 5 sets/, 'the box itself still unticks once per tap');
await page.click('.rv li >> nth=1 >> input');
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

// A link from Claude opened a second time doesn't offer the sets that were added from it the first time, whatever has
// happened to them since. A set already owned is found by its number or name, so one whose number was put right after
// it was added, and one removed (sold) since, came back ticked: "2 of 3 ticked", one tap from being added again. This
// device now remembers which rows of each link it added, and those start unticked and say why. A row left unticked
// the first time is still offered; a device without the memory (a catalog that came by sync) behaves as before.
{
  const batch = { brickyard: 1, batch: { name: 'Hall shelf', sets: [{ num: '10334', name: 'Retro Radio', check: 'could be 10340' }, { num: '10497', name: 'Galaxy Explorer' },
    { num: '10331', name: 'Kingfisher Bird' }, { num: '21318', name: 'Tree House' }] } };
  const { c, p } = await withSets({ sets: { o: { id: 'o', t: 1, name: 'Orchid', state: 'built' } } });
  const link = base + '#b1z' + deflateRawSync(JSON.stringify(batch)).toString('base64url');
  const rows = () => p.$$eval('.rv li', ls => ls.map(l => [l.querySelector('input').checked, [...l.querySelectorAll('.w')].map(w => w.textContent).join(' | ')]));
  await p.goto(link);
  await p.waitForSelector('#rv-add');
  await p.click('.rv li >> nth=3 >> .t'); // Tree House isn't here: left for another day
  await p.click('#rv-add');
  assert.equal(await p.locator('.item').count(), 4);
  // The radio's number is put right, and the kingfisher is sold.
  await p.click('.item:has-text("Retro Radio")');
  await p.fill('#e-num', '10340');
  await p.click('#e-save');
  await p.click('.item:has-text("Kingfisher")');
  await p.click('#e-del'); await p.waitForTimeout(650); await p.click('#e-del');
  assert.equal(await p.locator('.item').count(), 3);
  await p.goto(link);
  await p.waitForSelector('#rv-add');
  assert.deepEqual(await rows(), [[false, 'Added from this link before, now set 10340 | Check: could be 10340'], [false, 'You already have this one'],
    [false, 'Added from this link before, and removed since'], [true, '']], 'the sets added before are unticked, and say what became of them');
  assert.deepEqual([await p.textContent('#rv-n'), await p.textContent('#rv-add'), await p.textContent('.sheet .flag'), await p.textContent('.sheet .lede')],
    ['1 of 4 ticked', 'Add 1 set', 'You opened this link before. The sets you added from it then are unticked, and so are any others you already have.',
      'Hall shelf · 4 sets · 1 you already have · 2 added before · 1 to check']);
  await p.click('#rv-add');
  assert.equal(await p.locator('.item').count(), 4, 'the one left out the first time is added');
  await p.goto(link);
  await p.waitForSelector('#rv-add');
  assert.deepEqual([(await rows()).map(r => r[0]), await p.isDisabled('#rv-add'), await p.textContent('#rv-n')], [[false, false, false, false], true, '0 of 4 ticked'], 'and the third time nothing is ticked');
  // The sold one can still be ticked, if it comes home again.
  await p.click('.rv li >> nth=2 >> .t');
  assert.equal(await p.textContent('#rv-add'), 'Add 1 set');
  await p.click('[data-close]'); await p.waitForTimeout(650); await p.click('[data-close]');
  // Without the memory (another device, with the same catalog from sync) it's told by number and name, as before.
  await p.evaluate(() => localStorage.removeItem('brickyard.took'));
  await p.goto(base + '#catalog');
  await p.goto(link);
  await p.waitForSelector('#rv-add');
  assert.deepEqual([(await rows()).map(r => r[0]), await p.textContent('.sheet .flag')], [[true, false, true, false], 'You opened this link before. Sets you already have are unticked.']);
  assert.deepEqual(Object.keys(JSON.parse(await p.evaluate(() => localStorage.getItem('brickyard.v1'))).catalog).sort(), ['cases', 'loose', 'places', 'seen', 'sets'], 'the catalog holds nothing new');
  await c.close();
}

// Filter, search and group.
await page.click('.chip[data-f="sealed"]');
assert.equal(await page.locator('.item').count(), 1);
await page.click('.chip[data-f="all"]');
await page.fill('#q', 'box 3');
assert.equal(await page.locator('.item').count(), 2);
// "box" then a word that isn't a box is an ordinary search; a box with nothing in it finds nothing.
await page.fill('#q', 'creative brick box large');
assert.deepEqual(await page.locator('.item .t').allTextContents(), ['Large Creative Brick Box'], '"creative brick box large" is an ordinary search');
await page.fill('#q', 'box 99');
assert.match(await page.textContent('#list-wrap'), /Nothing matches/, 'box 99 has nothing in it');
// "box" and a number no moving box is labelled with is searched as words: it found nothing, with the Brick Box
// 10698 in the list. A line says no box has that label.
await page.fill('#q', 'brick box 10698');
assert.deepEqual([await page.locator('.item .t').allTextContents(), await page.textContent('#no-box')],
  [['Large Creative Brick Box'], 'No moving box is labelled 10698. These match the words.'], '"brick box 10698" finds the Brick Box');
await page.fill('#q', 'box 3');
assert.equal(await page.locator('#no-box').count(), 0, 'a box that is there has no such line');
await page.fill('#q', '');
await page.selectOption('#group', 'box');
assert.deepEqual(await page.locator('.group span:first-child').allTextContents(), ['Box 3', 'Box 7', 'Box 12', 'Not packed']);

// A moving box with a label of two words, next to a shorter label.
{
  const { c, p } = await withSets({ sets: {
    k2a: { id: 'k2a', t: 1, name: 'Bonsai Tree', box: 'Kitchen 2' }, k2b: { id: 'k2b', t: 1, name: 'Orchid', box: 'Kitchen 2' },
    k1: { id: 'k1', t: 1, name: 'Spice Rack', year: 2012, box: 'Kitchen' } } });
  await p.goto(base + '#catalog');
  await p.fill('#q', 'box kitchen 2');
  assert.deepEqual(await p.locator('.item .t').allTextContents(), ['Bonsai Tree', 'Orchid'], '"box kitchen 2" finds that box only');
  await c.close();
}

// One group per room or box, however it's spelled ("Office" and "office", box "3" and "03").
{
  const { c, p } = await withSets({ sets: {
    a: { id: 'a', t: 1, name: 'Alpha', room: 'Office', box: 'Kitchen 2' }, b: { id: 'b', t: 1, name: 'Bravo', room: 'office', box: 'kitchen 2' },
    c: { id: 'c', t: 1, name: 'Charlie', room: 'Office', box: '3' }, d: { id: 'd', t: 1, name: 'Delta', room: 'office', box: '03' },
    e: { id: 'e', t: 1, name: 'Echo', room: 'Office' } } });
  await p.goto(base + '#catalog');
  const heads = () => p.locator('#list-wrap .group').evaluateAll(hs => hs.map(h => { const s = h.querySelectorAll('span'); return [s[0].textContent.toLowerCase(), +s[1].textContent]; }));
  assert.deepEqual(await heads(), [['office', 5]], 'one room, whatever its spelling');
  await p.selectOption('#group', 'box');
  assert.deepEqual(await heads(), [['box 3', 2], ['box kitchen 2', 2], ['not packed', 1]], 'one moving box, whatever its spelling');
  await p.selectOption('#group', 'new');
  assert.deepEqual([await p.locator('#list-wrap .group').count(), await p.locator('#list-wrap .list').count(), await p.locator('#list-wrap .item').count()], [0, 1, 5], 'newest first is one list');
  await c.close();
}

// A box typed as "Box 5" or "#5" is box 5: shown as "Box 5", never "Box Box 5", one group with "5", and "box 5" finds it.
{
  const { c, p } = await withSets({ sets: {
    a: { id: 'a', t: 1, name: 'Alpha', room: 'Office', box: 'Box 5' }, b: { id: 'b', t: 1, name: 'Bravo', room: 'Office', box: '#5' },
    c: { id: 'c', t: 1, name: 'Charlie', room: 'Office', box: '5' }, d: { id: 'd', t: 1, name: 'Delta', room: 'Office', box: 'Box 15' } } });
  await p.goto(base + '#catalog');
  const subs = () => p.locator('#list-wrap .item .m').evaluateAll(ms => ms.map(m => m.textContent).filter(Boolean));
  assert.deepEqual(await subs(), ['Box 5', 'Box 5', 'Box 5', 'Box 15'], 'grouped by room, each set says Box 5, not Box Box 5');
  await p.selectOption('#group', 'box');
  const heads = () => p.locator('#list-wrap .group').evaluateAll(hs => hs.map(h => { const s = h.querySelectorAll('span'); return [s[0].textContent, +s[1].textContent]; }));
  assert.deepEqual(await heads(), [['Box 5', 3], ['Box 15', 1]], 'Box 5, #5 and 5 are one box');
  await p.selectOption('#group', 'theme');
  assert.deepEqual(await subs(), ['Office · Box 5', 'Office · Box 5', 'Office · Box 5', 'Office · Box 15'], 'and say so grouped any other way');
  await p.fill('#q', 'box 5');
  assert.deepEqual(await p.locator('#list-wrap .item .t').allTextContents(), ['Alpha', 'Bravo', 'Charlie'], '"box 5" finds Box 5, #5 and 5');
  await p.click('.item:has-text("Alpha")');
  assert.equal(await p.inputValue('#e-box'), 'Box 5', 'the label is kept as it was typed');
  await c.close();
}

// Loose pieces packed in a moving box show with that box: a line under its group (a box of only loose pieces gets a
// group of its own), and after a search for the box. The line goes to Build from your box, where they live.
{
  const { c, p } = await withSets({
    sets: { t: { id: 't', t: 1, name: 'Typewriter', box: '14' }, g: { id: 'g', t: 1, name: 'Galaxy Explorer', box: '3' }, o: { id: 'o', t: 1, name: 'Orchid' } },
    loose: { tub: { id: 'tub', t: 1, name: 'Blue tub', box: 'Box 14', parts: [['3001', 4, 40], ['3020', 15, 2]] },
      bag: { id: 'bag', t: 1, name: 'Red bag', box: '20', parts: [['3001', 4, 10]] }, cup: { id: 'cup', t: 1, name: 'Cup', parts: [['3001', 4, 1]] } } });
  await p.goto(base + '#catalog');
  const lines = () => p.locator('#list-wrap .note.lots').allTextContents();
  assert.deepEqual(await lines(), [], 'grouped by room, no lines');
  await p.selectOption('#group', 'box');
  const heads = () => p.locator('#list-wrap .group').evaluateAll(hs => hs.map(h => { const s = h.querySelectorAll('span'); return s[0].textContent + ' ' + s[1].textContent; }));
  assert.deepEqual(await heads(), ['Box 3 1', 'Box 14 1', 'Box 20 ', 'Not packed 1'], 'a box of only loose pieces has a group in its place');
  assert.deepEqual(await lines(), ['Also in Box 14: Blue tub, 42 loose pieces', 'In Box 20: Red bag, 10 loose pieces'], 'each box’s loose pieces under its group');
  assert.equal(await p.locator('.group:has-text("Box 14") + .list + .note.lots').count(), 1, 'the line is under its box’s sets');
  await p.fill('#q', 'box 14');
  assert.deepEqual(await p.locator('#list-wrap .item .t').allTextContents(), ['Typewriter']);
  assert.deepEqual(await lines(), ['Also in Box 14: Blue tub, 42 loose pieces'], 'a search for the box shows its loose pieces');
  await p.fill('#q', 'box 20');
  assert.deepEqual([await p.locator('#list-wrap .item').count(), await lines()], [0, ['In Box 20: Red bag, 10 loose pieces']], 'a box of only loose pieces is found, not "Nothing matches"');
  await p.fill('#q', 'box 14 typewriter');
  assert.deepEqual(await lines(), [], 'looking for something in the box shows only that');
  await p.fill('#q', 'box 99');
  assert.match(await p.textContent('#list-wrap'), /Nothing matches/);
  await p.fill('#q', 'box 20');
  await p.click('.note.lots a');
  await p.waitForSelector('li.lot');
  assert.equal(await p.evaluate(() => location.hash), '#build', 'the line goes to Build from your box');
  await c.close();
}
// With a filter on (Built, Partly built…) a search for a box is for sets of that kind, so its loose pieces stay out,
// as they do grouped by box: no "Also in Box 14" under no sets, and nothing listed when none of them are in it.
{
  const { c, p } = await withSets({
    sets: { t: { id: 't', t: 1, name: 'Typewriter', box: '14', state: 'partial' }, g: { id: 'g', t: 1, name: 'Galaxy Explorer', box: '3', state: 'built' } },
    loose: { tub: { id: 'tub', t: 1, name: 'Blue tub', box: 'Box 14', parts: [['3001', 4, 40]] }, bag: { id: 'bag', t: 1, name: 'Red bag', box: '20', parts: [['3001', 4, 10]] } } });
  await p.goto(base + '#catalog');
  const lines = () => p.locator('#list-wrap .note.lots').allTextContents();
  await p.fill('#q', 'box 14');
  assert.deepEqual(await lines(), ['Also in Box 14: Blue tub, 40 loose pieces'], 'with All, a box’s loose pieces show');
  await p.click('.chip[data-f="built"]');
  assert.deepEqual([await lines(), await p.textContent('#list-wrap .empty p')], [[], 'Nothing under Built. 1 set matches in all your sets.'], 'Built, with no built set in box 14: nothing under Built');
  await p.click('.chip[data-f="partial"]');
  assert.deepEqual([await p.locator('#list-wrap .item .t').allTextContents(), await lines()], [['Typewriter'], []], 'Partly built: the set, and no loose pieces');
  await p.fill('#q', 'box 20');
  assert.deepEqual([await lines(), await p.textContent('#list-wrap')], [[], 'Nothing matches. Try another word or filter.'], 'a box of only loose pieces, with a filter on');
  await c.close();
}

// A filter left on doesn't hide My sets the next time Brickyard is opened. It lasts for the visit: a fresh load starts
// at All (it used to open on "1 of 17 sets", the lit chip off the side of the screen, and a search for a set that's
// owned said "Nothing matches"). Group by is still remembered. During the visit the lit chip is kept in view, and a
// search that finds nothing under the filter says how many sets it finds without it, with a button to them.
{
  const sets = {};
  ['built', 'built', 'partial', 'apart', 'sealed', 'built', 'built', 'apart', 'built', 'built', 'built', 'sealed', 'built', 'built', 'built'].forEach((state, i) => {
    sets['s' + i] = { id: 's' + i, t: 1, name: 'Set ' + String(i).padStart(2, '0'), state, box: String(1 + i % 4) };
  });
  sets.f = { id: 'f', t: 1, num: '75192-1', name: 'Millennium Falcon', state: 'built', room: 'Office' };
  sets.r = { id: 'r', t: 1, num: '10334-1', name: 'Retro Radio', state: 'built', check: 'could be 10340', missing: 'the dial' };
  const { c, p } = await withSets({ sets });
  await p.evaluate(() => localStorage.setItem('brickyard.prefs', JSON.stringify({ pics: true, group: 'box', show: 'check' })));
  await p.goto(base + '#catalog');
  await p.reload();
  const lit = () => p.evaluate(() => {
    const b = document.querySelector('.chip[aria-pressed="true"]'), r = b.getBoundingClientRect();
    return [b.dataset.f, r.left >= 0 && r.right <= innerWidth];
  });
  assert.deepEqual([await p.textContent('#sum'), await lit(), await p.inputValue('#group')], ['17 sets', ['all', true], 'box'], 'a fresh load shows every set, grouped as before');
  await p.fill('#q', 'falcon');
  assert.deepEqual(await p.locator('.item .t').allTextContents(), ['Millennium Falcon'], 'and a search finds a set that’s owned');
  await p.fill('#q', '');
  await p.click('.chip[data-f="check"]');
  await p.evaluate(() => { document.getElementById('chips').scrollLeft = 0; });
  await p.fill('#q', 'retro');
  assert.deepEqual([await p.textContent('#sum'), await lit()], ['1 of 17 sets', ['check', true]], 'the lit chip is brought into view when the list is drawn');
  await p.fill('#q', 'falcon');
  assert.equal(await p.textContent('#list-wrap .empty p'), 'Nothing under To check. 1 set matches in all your sets.', 'nothing under the filter, one without it');
  await p.fill('#q', 'set');
  assert.equal(await p.textContent('#list-wrap .empty p'), 'Nothing under To check. 15 sets match in all your sets.');
  await p.fill('#q', 'falcon');
  await p.click('#list-wrap [data-act="all"]');
  assert.deepEqual([await p.locator('.item .t').allTextContents(), await lit(), await p.inputValue('#q')], [['Millennium Falcon'], ['all', true], 'falcon'], 'its button takes the filter off and keeps the search');
  await p.fill('#q', 'zzz');
  assert.equal(await p.textContent('#list-wrap'), 'Nothing matches. Try another word or filter.', 'a search that finds nothing anywhere says so plainly');
  await p.fill('#q', '');
  await p.click('.chip[data-f="check"]');
  await p.click('#catalog .back');
  await p.click('#go-catalog');
  assert.deepEqual([await p.textContent('#sum'), (await lit())[0]], ['1 of 17 sets', 'check'], 'the filter is kept while Brickyard stays open');
  assert.equal(JSON.parse(await p.evaluate(() => localStorage.getItem('brickyard.prefs'))).show, undefined, 'and isn’t saved for next time');
  await c.close();
}

// Adding sets from Claude: clearing Moving box takes the batch's box off the sets that have it, and a set Claude
// put in a box of its own keeps it. A box typed in goes on every set.
{
  const { c, p } = await withSets({ sets: {} });
  const open = async b => {
    await p.goto(base + '#b1z' + deflateRawSync(JSON.stringify({ brickyard: 1, batch: b })).toString('base64url'));
    await p.waitForSelector('#rv-add');
  };
  const boxes = () => p.evaluate(() => Object.values(window.brickyard.doc().sets).filter(x => !x.del).map(x => x.name + ': ' + (x.box || '')).sort());
  await open({ name: 'Box 7', box: '7', sets: [{ num: '10497', name: 'Galaxy Explorer' }, { num: '21318', name: 'Tree House' }, { num: '10281', name: 'Bonsai Tree', box: 'Kitchen 2' }] });
  assert.equal(await p.inputValue('#rv-box'), '7');
  assert.equal(await p.textContent('.bulk .note'), 'Leave Room and Shelf blank to keep what Claude put for each set. Clear Moving box if they’re unpacked.');
  await p.fill('#rv-box', '');
  await p.click('#rv-add');
  assert.deepEqual(await boxes(), ['Bonsai Tree: Kitchen 2', 'Galaxy Explorer: ', 'Tree House: '], 'a cleared box comes off the batch’s sets, not off Bonsai’s own');
  await open({ box: '7', sets: [{ num: '21327', name: 'Typewriter' }, { num: '10311', name: 'Orchid', box: 'Kitchen 2' }] });
  await p.fill('#rv-box', '9');
  await p.click('#rv-add');
  assert.deepEqual((await boxes()).filter(b => /Typewriter|Orchid/.test(b)), ['Orchid: 9', 'Typewriter: 9'], 'a box typed in goes on every set');
  await open({ box: '7', sets: [{ num: '75192', name: 'Millennium Falcon' }, { num: '10294', name: 'Titanic', box: 'Kitchen 2' }] });
  await p.click('#rv-add');
  assert.deepEqual((await boxes()).filter(b => /Falcon|Titanic/.test(b)), ['Millennium Falcon: 7', 'Titanic: Kitchen 2'], 'left as it was, each set keeps what Claude put');
  await c.close();
}

// "It's right" on a set marked Check is saved at once: closing the sheet without Save leaves it cleared (it used to
// come back), and Save afterwards keeps it cleared along with whatever else was changed.
await page.click('.chip[data-f="check"]');
assert.equal(await page.textContent('.chip[data-f="check"] .n'), '1');
await page.click('.item:has-text("Lamborghini")');
await page.click('#e-ok');
assert.equal(await page.textContent('.toast'), 'Marked as right');
assert.deepEqual([await page.locator('.sheet').count(), await page.locator('.sheet .flag').count()], [1, 0], 'the sheet stays open, without its Check note');
await page.click('[data-close]');
assert.ok(!(await live()).find(x => /Lamborghini/.test(x.name)).check, 'It’s right then Close: the check is gone');
assert.equal(await page.textContent('.chip[data-f="check"] .n'), '0', 'and To check counts none');
await page.click('.chip[data-f="all"]');
{
  const { c, p } = await withSets({ sets: { l: { id: 'l', t: 1, num: '42115-1', name: 'Lamborghini', check: 'could be 42083' } } });
  await p.goto(base + '#catalog');
  await p.click('.item:has-text("Lamborghini")');
  await p.click('#e-ok');
  await p.fill('#e-notes', 'on loan');
  await p.click('#e-save');
  const l = await p.evaluate(() => window.brickyard.doc().sets.l);
  assert.deepEqual([l.check, l.notes, l.num], [undefined, 'on loan', '42115-1'], 'Save after It’s right keeps the check cleared');
  await c.close();
}

// A moving box has a sheet of its own: a tap on its heading in Group by Moving box opens it (a heading did nothing),
// with the box's sets and loose pieces, and Add sets to this box, Copy this list and Rename this box. A search for
// the box has a button that opens the same sheet.
{
  const { c, p } = await withSets({
    sets: { a: { id: 'a', t: 1, num: '10334-1', name: 'Retro Radio', pieces: 906, state: 'built', box: 'Box 03', room: 'Hall' }, b: { id: 'b', t: 1, num: '10311-1', name: 'Orchid', pieces: 608, state: 'built', box: '3' },
      d: { id: 'd', t: 1, num: '21327-1', name: 'Typewriter', state: 'apart', box: '12' }, e: { id: 'e', t: 1, num: '10281-1', name: 'Bonsai Tree', state: 'built', room: 'Hall' },
      f: { id: 'f', t: 1, num: '10280-1', name: 'Flower Bouquet', state: 'sealed' }, g: { id: 'g', t: 1, num: '10497-1', name: 'Galaxy Explorer', state: 'built' } },
    loose: { tub: { id: 'tub', t: 1, name: 'Blue tub', box: '#3', parts: [['3001', 4, 40], ['3020', 15, 2]] }, bag: { id: 'bag', t: 1, name: 'Red bag', box: '20', parts: [['3001', 4, 10]] } } },
  { permissions: ['clipboard-read', 'clipboard-write'] });
  const says = () => p.textContent('.toast > span'), title = () => p.textContent('#sheetTitle');
  const boxOf = id => p.evaluate(i => { const d = window.brickyard.doc(), x = d.sets[i] || d.loose[i]; return x.box || ''; }, id);
  const heads = () => p.locator('#list-wrap .group').evaluateAll(hs => hs.map(h => h.textContent));
  await p.goto(base + '#catalog');
  await p.selectOption('#group', 'box');
  assert.deepEqual([await heads(), await p.locator('#list-wrap .box-head').count()], [['Box 32', 'Box 121', 'Box 20', 'Not packed3'], 3], 'each box’s heading is a button that opens the box; Not packed’s only folds');
  assert.equal(await p.getAttribute('.box-head[data-box="3"]', 'aria-label'), 'Box 3, 2 sets');
  assert.ok((await p.locator('.box-head').first().boundingBox()).height >= 44, 'tall enough for a finger');
  await p.click('.box-head[data-box="3"]');
  assert.deepEqual([await title(), await p.textContent('.sheet .lede'), await p.locator('#bx-sets .item .t').allTextContents(), await p.textContent('.sheet .note.lots'), await p.locator('#bx-acts button').evaluateAll(bs => bs.map(b => b.firstChild.firstChild.textContent))],
    ['Box 3', '2 sets · 1,514 pieces · 42 loose pieces', ['Orchid', 'Retro Radio'], 'Also in this box: Blue tub, 42 loose pieces', ['Unpack this box', 'Add sets to this box', 'Copy this list', 'Rename this box']], 'the box’s sheet');
  // A set in it opens its own sheet.
  await p.click('#bx-sets .item[data-id="b"]');
  assert.deepEqual([await title(), await p.inputValue('#e-box')], ['Orchid', '3']);
  await p.click('[data-close]');
  await p.waitForFunction(() => !document.querySelector('.sheet'));
  // Copy this list.
  await p.click('.box-head[data-box="3"]');
  await p.click('#bx-copy');
  await p.waitForFunction(() => !document.querySelector('.sheet'));
  assert.deepEqual([await says(), await p.evaluate(() => navigator.clipboard.readText())], ['Copied Box 3’s list', 'Box 3 · 2 sets · 42 loose pieces\n10311 Orchid · Built\n10334 Retro Radio · Built\nBlue tub · 42 loose pieces']);
  // Add sets to this box: the sets that aren't packed, none ticked, with a search; Undo takes them out again.
  await p.click('.box-head[data-box="3"]');
  await p.click('#bx-add');
  const rows = () => p.$$eval('#ab li', ls => ls.filter(l => !l.hidden).map(l => l.querySelector('.t').textContent + (l.querySelector('input').checked ? ' ✓' : '')));
  assert.deepEqual([await title(), await rows(), await p.textContent('#ab-go'), await p.isDisabled('#ab-go')], ['Add sets to Box 3', ['Bonsai Tree', 'Flower Bouquet', 'Galaxy Explorer'], 'Add', true]);
  await p.click('#ab li:has-text("Galaxy Explorer")');
  await p.fill('#ab-q', 'flowers');
  assert.deepEqual(await rows(), ['Flower Bouquet', 'Galaxy Explorer ✓'], 'the search narrows the list, and a ticked set stays');
  await p.click('#ab li:has-text("Flower Bouquet") input');
  await p.fill('#ab-q', 'zzz');
  assert.deepEqual([await rows(), await p.isVisible('#ab-none')], [['Flower Bouquet ✓', 'Galaxy Explorer ✓'], false]);
  assert.deepEqual([await p.textContent('#ab-n'), await p.textContent('#ab-go')], ['2 ticked', 'Add 2 sets']);
  // With sets ticked, Close asks before it throws them away.
  await p.click('[data-close]');
  assert.equal(await p.textContent('[data-close]'), 'Discard changes?');
  await p.click('#ab-go');
  await p.waitForFunction(() => !document.querySelector('.sheet'));
  assert.deepEqual([await says(), await boxOf('f'), await boxOf('g'), await boxOf('e'), await heads()], ['Box 3 holds 4 sets now.', '3', '3', '', ['Box 34', 'Box 121', 'Box 20', 'Not packed1']]);
  await p.click('.toast button');
  assert.deepEqual([await says(), await boxOf('f'), await boxOf('g'), await heads()], ['Took those 2 out of Box 3 again', '', '', ['Box 32', 'Box 121', 'Box 20', 'Not packed3']]);
  // Rename this box: every set and lot in it, whatever each called the box. Nothing typed is turned down.
  await p.click('.box-head[data-box="3"]');
  await p.click('#bx-rename');
  assert.deepEqual([await title(), await p.inputValue('#rn-box'), await p.evaluate(() => document.activeElement.id)], ['Rename Box 3', '3', 'rn-box']);
  await p.fill('#rn-box', ' ');
  await p.click('#rn-go');
  assert.equal(await p.textContent('#rn-box-err'), 'Give the box a label.');
  await p.fill('#rn-box', 'Kitchen 1');
  await p.press('#rn-box', 'Enter');
  await p.waitForFunction(() => !document.querySelector('.sheet'));
  assert.deepEqual([await says(), await boxOf('a'), await boxOf('b'), await boxOf('tub'), await boxOf('d'), await heads()], ['Box 3 is now Box Kitchen 1', 'Kitchen 1', 'Kitchen 1', 'Kitchen 1', '12', ['Box 121', 'Box 20', 'Box Kitchen 12', 'Not packed3']]);
  assert.equal(await p.evaluate(() => document.activeElement.dataset.box), 'Kitchen 1', 'the keyboard is on the box under its new name');
  await p.click('.toast button');
  assert.deepEqual([await says(), await boxOf('a'), await boxOf('b'), await boxOf('tub')], ['It’s Box 3 again', 'Box 03', '3', '#3'], 'Undo gives each its own label back');
  // A label another box has takes a second tap, and makes the two one box.
  await p.click('.box-head[data-box="12"]');
  await p.click('#bx-rename');
  await p.fill('#rn-box', '3');
  await p.click('#rn-go');
  assert.deepEqual([await p.textContent('#rn-go'), await p.textContent('#rn-hint'), await boxOf('d')], ['Put them together', 'Box 3 already holds 2 sets. Tap again to make the two one box.', '12']);
  await p.waitForTimeout(650);
  await p.click('#rn-go');
  await p.waitForFunction(() => !document.querySelector('.sheet'));
  assert.deepEqual([await says(), await boxOf('d'), await heads()], ['Box 12 is now part of Box 3', '3', ['Box 33', 'Box 20', 'Not packed3']]);
  // A box of only loose pieces has a sheet too.
  await p.click('.box-head[data-box="20"]');
  assert.deepEqual([await title(), await p.textContent('.sheet .lede'), await p.locator('#bx-sets').count(), await p.textContent('.sheet .note.lots')], ['Box 20', '10 loose pieces', 0, 'In this box: Red bag, 10 loose pieces']);
  await p.click('[data-close]');
  await p.waitForFunction(() => !document.querySelector('.sheet'));
  // A search for a box, grouped any other way, has a button that opens the box's sheet.
  await p.selectOption('#group', 'room');
  await p.fill('#q', 'box 3');
  assert.equal(await p.textContent('.boxline button'), 'Box 3: unpack, add sets, copy its list');
  await p.click('.boxline button');
  assert.deepEqual([await title(), await p.locator('#bx-sets .item').count()], ['Box 3', 3]);
  await p.click('[data-close]');
  await p.waitForFunction(() => !document.querySelector('.sheet'));
  await p.fill('#q', 'box 20');
  await p.click('.boxline button');
  assert.equal(await title(), 'Box 20', 'and for a box of only loose pieces');
  await p.click('[data-close]');
  await p.fill('#q', 'box 3 radio');
  assert.equal(await p.locator('.boxline').count(), 0, 'not when the search is for something in the box');
  await p.selectOption('#group', 'box');
  await p.fill('#q', 'box 3');
  assert.deepEqual([await p.locator('.boxline').count(), await p.locator('.box-head').count()], [0, 1], 'grouped by box, the heading is the button');
  await c.close();
}

// Unpack this box, in a box's sheet: its sets and loose pieces as a ticked list, with a Room and a Shelf that go on
// every ticked set and are left as they are when blank. (Unpacking was open the set, clear the box, type the room
// and shelf, Save, once for every set.) The message says how the box stands, and Undo puts everything back.
{
  const { c, p } = await withSets({
    sets: { a: { id: 'a', t: 1, num: '10334-1', name: 'Retro Radio', state: 'built', box: '3', room: 'Hall', spot: 'Top shelf' }, b: { id: 'b', t: 1, num: '10311-1', name: 'Orchid', state: 'built', box: '3', room: 'Flat', notes: 'a gift' },
      d: { id: 'd', t: 1, num: '21327-1', name: 'Typewriter', state: 'apart', box: '12' }, e: { id: 'e', t: 1, num: '10281-1', name: 'Bonsai Tree', state: 'built', room: 'Hall' } },
    loose: { tub: { id: 'tub', t: 1, name: 'Blue tub', box: 'Box 3', parts: [['3001', 4, 40], ['3020', 15, 2]] }, bag: { id: 'bag', t: 1, name: 'Red bag', box: '20', parts: [['3001', 4, 10]] } } });
  const says = () => p.textContent('.toast > span'), gone = () => p.waitForFunction(() => !document.querySelector('.sheet'));
  const kept = id => p.evaluate(i => { const d = window.brickyard.doc(), x = d.sets[i] || d.loose[i]; return [x.room || '', x.spot || '', x.box || ''].join('|'); }, id);
  const heads = () => p.locator('#list-wrap .group').evaluateAll(hs => hs.map(h => h.textContent));
  const open = async box => { await p.click(`.box-head[data-box="${box}"]`); await p.click('#bx-unpack'); };
  await p.goto(base + '#catalog');
  await p.selectOption('#group', 'box');
  await open('3');
  assert.deepEqual([await p.textContent('#sheetTitle'), await p.$$eval('#up li', ls => ls.map(l => l.querySelector('.t').textContent + ': ' + l.querySelector('.m').textContent + (l.querySelector('input').checked ? ' ✓' : ''))), await p.textContent('#up-go'), await p.textContent('#up-n')],
    ['Unpack Box 3', ['Orchid: 10311 · Built · Flat ✓', 'Retro Radio: 10334 · Built · Hall › Top shelf ✓', 'Blue tub: 42 loose pieces ✓'], 'Unpack 2 sets and the loose pieces', '3 of 3 ticked'], 'everything in the box, ticked');
  // One set unticked, and no room typed: the others leave the box and keep their places.
  await p.click('#up li:has-text("Retro Radio")');
  assert.equal(await p.textContent('#up-go'), 'Unpack 1 set and the loose pieces');
  await p.click('#up-go');
  await gone();
  assert.deepEqual([await says(), await kept('b'), await kept('a'), await kept('tub'), await heads()], ['Unpacked 1 set and the loose pieces. 1 set still in Box 3.', 'Flat||', 'Hall|Top shelf|3', '||', ['Box 31', 'Box 121', 'Box 20', 'Not packed2']]);
  assert.equal(await p.evaluate(() => window.brickyard.doc().sets.b.notes), 'a gift', 'nothing else about a set is touched');
  await p.click('.toast button');
  assert.deepEqual([await says(), await kept('b'), await kept('tub')], ['Back in Box 3', 'Flat||3', '||Box 3'], 'Undo puts them back, each under the label it had');
  // A room and a shelf typed go on every ticked set. The box comes empty, and one box is still packed (the one of
  // only loose pieces doesn't hold a set, but it's a box).
  await open('3');
  await p.fill('#up-room', 'Office');
  await p.fill('#up-spot', 'Billy 2');
  await p.click('[data-close]');
  assert.equal(await p.textContent('[data-close]'), 'Discard changes?', 'a room typed is something to lose');
  await p.click('#up-go');
  await gone();
  assert.deepEqual([await says(), await kept('a'), await kept('b'), await kept('tub'), await kept('e'), await heads()], ['Box 3 is empty. 2 boxes still packed.', 'Office|Billy 2|', 'Office|Billy 2|', '||', 'Hall||', ['Box 121', 'Box 20', 'Not packed3']]);
  assert.equal(await p.evaluate(() => document.activeElement.tagName), 'H1', 'the keyboard is on the screen’s heading: the box’s own has gone');
  await p.click('.toast button');
  assert.deepEqual([await kept('a'), await kept('b'), await kept('tub')], ['Hall|Top shelf|3', 'Flat||3', '||Box 3'], 'Undo gives back the room and shelf each had');
  // Only a shelf typed: the room stays.
  await open('3');
  await p.fill('#up-spot', 'Floor');
  await p.click('#up li:has-text("Blue tub")');
  await p.click('#up-go');
  await gone();
  assert.deepEqual([await says(), await kept('a'), await kept('b'), await kept('tub')], ['Unpacked 2 sets. Only loose pieces are left in Box 3.', 'Hall|Floor|', 'Flat|Floor|', '||Box 3']);
  // A box of only loose pieces has no Room or Shelf to ask for.
  await open('Box 3');
  assert.deepEqual([await p.locator('#up-room').count(), await p.textContent('#up-go')], [0, 'Unpack the loose pieces']);
  await p.click('#up-go');
  await gone();
  assert.equal(await says(), 'Box 3 is empty. 2 boxes still packed.');
  await open('12');
  await p.click('#up-go');
  await gone();
  assert.equal(await says(), 'Box 12 is empty. 1 box still packed.');
  // The last box, reached from a search for it.
  await p.selectOption('#group', 'room');
  await p.fill('#q', 'box 20');
  await p.click('.boxline button');
  await p.click('#bx-unpack');
  await p.click('#up li input');
  assert.deepEqual([await p.textContent('#up-go'), await p.isDisabled('#up-go')], ['Unpack', true], 'nothing ticked is nothing to unpack');
  await p.click('#up li input');
  await p.click('#up-go');
  await gone();
  assert.deepEqual([await says(), await p.evaluate(() => window.brickyard.doc().loose.bag.box), await p.inputValue('#q'), await p.locator('#list-wrap .item').count()], ['Every box is unpacked.', undefined, '', 4], 'and the search for the box that has gone is cleared');
  await p.goto(base);
  assert.equal(await p.evaluate(() => document.getElementById('home-pack').hidden), true, 'and the home card has no packed line');
  await c.close();
}

// A lot of loose pieces can be renamed and moved out of its moving box after it has arrived: a tap on its name
// under Your pieces opens a sheet with Call it and Moving box. (They could only be typed when the lot first arrived,
// so an unpacked lot went on saying Box 9, there and in My sets.) Its tick still ticks, and Remove still removes.
{
  const { c, p } = await withSets({
    sets: { a: { id: 'a', t: 1, num: '10334-1', name: 'Retro Radio', state: 'built', box: '3' } },
    loose: { tub: { id: 'tub', t: 1, name: 'Blue tub', box: '9', note: 'from the garage', parts: [['3001', 4, 40], ['3020', 15, 2]] }, bag: { id: 'bag', t: 1, name: 'Red bag', parts: [['3001', 4, 10]] } } });
  const lot = id => p.evaluate(i => window.brickyard.doc().loose[i], id), says = () => p.textContent('.toast > span');
  const rows = () => p.$$eval('li.lot', ls => ls.map(l => l.querySelector('.lot-name').textContent));
  const gone = () => p.waitForFunction(() => !document.querySelector('.sheet'));
  await p.goto(base + '#build');
  await p.waitForSelector('li.lot');
  assert.deepEqual(await rows(), ['Blue tubLoose · 42 pieces · Box 9', 'Red bagLoose · 10 pieces']);
  assert.deepEqual(await p.$$eval('li.lot', ls => ls.map(l => [...l.children].map(e => e.tagName + ':' + Math.round(e.getBoundingClientRect().height >= 40)).join())), Array(2).fill('LABEL:1,BUTTON:1,BUTTON:1'), 'a tick, the name and Remove, each tall enough for a finger');
  assert.equal(await p.getAttribute('[data-pool="tub"]', 'aria-label'), 'Build from Blue tub');
  await p.click('[data-edit="tub"]');
  assert.deepEqual([await p.textContent('#sheetTitle'), await p.textContent('.sheet .lede'), await p.inputValue('#lt-name'), await p.inputValue('#lt-box'), await p.$$eval('#dl-box option', os => os.map(o => o.value))],
    ['Blue tub', '42 loose pieces of 2 kinds', 'Blue tub', '9', ['3', '9']], 'the lot’s sheet, with the boxes in use to choose from');
  // No name is turned down; a change that's closed asks first.
  await p.fill('#lt-name', '  ');
  await p.click('#lt-save');
  assert.equal(await p.textContent('#lt-name-err'), 'Give them a name.');
  await p.fill('#lt-name', 'Blue tub (kitchen)');
  await p.click('[data-close]');
  assert.equal(await p.textContent('[data-close]'), 'Discard changes?');
  // Unpacked: the box is cleared, and the message says the box is empty. Everything else about the lot is kept.
  const t0 = (await lot('tub')).t;
  await p.fill('#lt-box', '');
  await p.press('#lt-box', 'Enter');
  await gone();
  await p.waitForFunction(() => /kitchen/.test(document.querySelector('li.lot').textContent));
  const kept = await lot('tub');
  assert.deepEqual([await says(), kept.name, kept.box, kept.note, kept.parts, kept.t > t0, await rows()],
    ['Saved. Box 9 is empty now.', 'Blue tub (kitchen)', undefined, 'from the garage', [['3001', 4, 40], ['3020', 15, 2]], true, ['Blue tub (kitchen)Loose · 42 pieces', 'Red bagLoose · 10 pieces']]);
  assert.equal(await p.evaluate(() => document.activeElement.dataset.edit), 'tub', 'the keyboard is back on the lot’s name');
  assert.equal(JSON.parse(await p.evaluate(() => localStorage.getItem('brickyard.v1'))).catalog.loose.tub.name, 'Blue tub (kitchen)', 'saved in the catalog, which is what syncs');
  // Into a box: My sets lists it under that box.
  await p.click('[data-edit="bag"]');
  await p.fill('#lt-box', '3');
  await p.click('#lt-save');
  await gone();
  assert.deepEqual([await says(), (await lot('bag')).box], ['Saved', '3']);
  await p.waitForFunction(() => /Box 3/.test(document.querySelectorAll('li.lot')[1].textContent));
  // Nothing changed is nothing written.
  const t1 = (await lot('bag')).t;
  await p.click('[data-edit="bag"]');
  await p.click('#lt-save');
  await gone();
  assert.equal((await lot('bag')).t, t1, 'a Save with nothing changed leaves the lot’s time of change alone');
  // The tick still turns the lot off, and Remove still asks.
  await p.click('[data-pool="bag"]');
  await p.waitForFunction(() => !document.querySelector('[data-pool="bag"]').checked);
  assert.equal(await p.evaluate(() => JSON.parse(localStorage.getItem('brickyard.pool')).bag), false);
  await p.click('[data-lot="bag"]');
  assert.equal(await p.textContent('#sheetTitle'), 'Remove these loose pieces?');
  await p.click('[data-close]');
  await p.goto(base + '#catalog');
  await p.selectOption('#group', 'box');
  assert.deepEqual(await p.locator('#list-wrap .note.lots').allTextContents(), ['Also in Box 3: Red bag, 10 loose pieces'], 'My sets has the lot under its new box, and no Box 9');
  await c.close();
}

// While any set is in a moving box, My sets has a Not packed chip after All, with the number still to pack, and
// the home screen's card says how many are packed, in how many boxes, and how many are left. Both go when no set
// has a box.
{
  const { c, p } = await withSets({ sets: {
    a: { id: 'a', t: 1, num: '10334-1', name: 'Retro Radio', state: 'built', box: '3' }, b: { id: 'b', t: 1, num: '10311-1', name: 'Orchid', state: 'built', box: 'Box 03' },
    d: { id: 'd', t: 1, num: '21327-1', name: 'Typewriter', state: 'apart', box: '12' }, e: { id: 'e', t: 1, num: '10281-1', name: 'Bonsai Tree', state: 'built', room: 'Hall' },
    f: { id: 'f', t: 1, num: '10280-1', name: 'Flower Bouquet', state: 'sealed' } } });
  const card = () => p.evaluate(() => { const el = document.getElementById('home-pack'); return el.hidden ? null : el.textContent; });
  const chips = () => p.$$eval('.chip', cs => cs.map(c => c.textContent));
  assert.equal(await card(), '3 packed in 2 boxes · 2 to pack', 'the home card counts what is packed');
  await p.goto(base + '#catalog');
  assert.deepEqual(await chips(), ['All5', 'Not packed2', 'Built3', 'Taken apart1', 'Sealed1'], 'Not packed is the second chip');
  assert.equal(await p.getAttribute('.chip[data-f="unpacked"]', 'aria-label'), 'Not packed, 2 sets');
  await p.click('.chip[data-f="unpacked"]');
  assert.deepEqual([await p.locator('#list-wrap .item .t').allTextContents(), await p.textContent('#sum')], [['Bonsai Tree', 'Flower Bouquet'], '2 of 5 sets'], 'it shows the sets with no box');
  // Packing one of them takes it off the list, and the count goes down.
  await p.click('.item[data-id="f"]');
  await p.fill('#e-box', '12');
  await p.click('#e-save');
  assert.deepEqual([await p.locator('#list-wrap .item .t').allTextContents(), await chips()], [['Bonsai Tree'], ['All5', 'Not packed1', 'Built3', 'Taken apart1', 'Sealed1']]);
  // The last one packed: the chip stays while it's the one in force, and says so.
  await p.click('.item[data-id="e"]');
  await p.fill('#e-box', '12');
  await p.click('#e-save');
  assert.deepEqual([await p.textContent('#list-wrap'), (await chips())[1]], ['Nothing under Not packed. Show all your sets', 'Not packed0']);
  await p.click('[data-act="all"]');
  assert.deepEqual(await chips(), ['All5', 'Built3', 'Taken apart1', 'Sealed1'], 'with every set packed there is no chip');
  await p.goto(base);
  assert.equal(await card(), '5 packed in 2 boxes · none left to pack');
  // Every box unpacked: no chip and no line, and a Not packed filter left on is lifted.
  await p.goto(base + '#catalog');
  await p.evaluate(() => { const b = window.brickyard, d = b.doc(); Object.keys(d.sets).forEach(id => { const x = Object.assign({}, d.sets[id]); if (id !== 'a') delete x.box; b.putSet(x); }); b.refresh(); });
  await p.click('.chip[data-f="unpacked"]');
  assert.equal(await p.locator('#list-wrap .item').count(), 4);
  await p.evaluate(() => { const b = window.brickyard, x = Object.assign({}, b.doc().sets.a); delete x.box; b.putSet(x); b.refresh(); });
  assert.deepEqual([await chips(), await p.locator('#list-wrap .item').count()], [['All5', 'Built3', 'Taken apart1', 'Sealed1'], 5], 'with nothing packed the chip and its filter go');
  await p.goto(base);
  assert.equal(await card(), null, 'and so does the line on the home card');
  await c.close();
}

// Save says what happened to a moving box when a set went into one or came out of one: it said "Saved", the word
// for a typo put right, when the last set came out of a box and when a box got its third.
{
  const { c, p } = await withSets({ sets: {
    a: { id: 'a', t: 1, num: '10334-1', name: 'Retro Radio', state: 'built', box: '3' }, b: { id: 'b', t: 1, num: '10311-1', name: 'Orchid', state: 'built', box: '3' },
    d: { id: 'd', t: 1, num: '21327-1', name: 'Typewriter', state: 'apart', box: 'Box 12' }, e: { id: 'e', t: 1, num: '10281-1', name: 'Bonsai Tree', state: 'built', room: 'Hall' } } });
  await p.goto(base + '#catalog');
  const save = async (id, box, more) => {
    await p.click(`.item[data-id="${id}"]`);
    await p.fill('#e-box', box);
    if (more) await more();
    await p.click('#e-save');
    return p.textContent('.toast');
  };
  assert.equal(await save('e', '3'), 'Saved. Box 3 holds 3 sets now.', 'into a box');
  assert.equal(await save('e', '03'), 'Saved', 'the same box written another way is no news');
  assert.equal(await save('e', ''), 'Saved. 2 sets still in Box 3.', 'out of a box that still holds some');
  assert.equal(await save('d', '3'), 'Saved. Box 3 holds 3 sets now. Box 12 is empty now.', 'from one box to another, the last one out of the first');
  assert.equal(await save('d', '', () => p.fill('#e-w', '11"')), 'Saved. 2 sets still in Box 3. Read as inches: 27.9 cm', 'with what was read as inches after it');
  assert.equal(await save('a', '9'), 'Saved. Box 9 holds 1 set now. 1 set still in Box 3.');
  assert.equal(await save('a', ''), 'Saved. Box 9 is empty now.', 'the last set out of a box, with another box still packed');
  assert.equal(await save('b', ''), 'Saved. That was the last moving box.', 'the last set out of the last box');
  // A set added by hand into a box says so too.
  await p.click('#add-btn');
  await p.fill('#e-num', '21318');
  await p.fill('#e-box', '4');
  await p.click('#e-save');
  assert.equal(await p.textContent('.toast'), 'Added Set 21318. Box 4 holds 1 set now.');
  await c.close();
}

// A set's sheet from the keyboard. Enter in a one-line box saves (it did nothing: on a phone the keyboard had to be
// put away to reach Save), Enter in Missing pieces or Notes is still a new line, and Enter on a tick-box or a State
// button doesn't save. The picture at the top follows the number as soon as it's changed. A set renumbered to one
// that's already owned takes a second go, like adding one. And going back into the search selects what's in it.
{
  const { c, p } = await withSets({ sets: { f: { id: 'f', t: 1, num: '75192-1', name: 'Millennium Falcon', room: 'Office', state: 'built' },
    r: { id: 'r', t: 1, num: '10334-1', name: 'Retro Radio', state: 'built' }, b: { id: 'b', t: 1, num: '10281-1', name: 'Bonsai Tree', state: 'built', box: '7' } } });
  const asked = [];
  p.on('request', r => { if (r.url().includes('rebrickable')) asked.push(r.url().replace(/.*\/sets\//, '')); });
  const kept = id => p.evaluate(i => window.brickyard.doc().sets[i], id), sheets = () => p.locator('.sheet').count();
  await p.goto(base + '#catalog');
  await p.click('.item:has-text("Retro Radio")');
  assert.deepEqual(await p.$$eval('#e-form input:not([type="checkbox"])', els => [els.length, els.every(e => e.enterKeyHint === 'done')]), [12, true], 'the keyboard’s Enter key says Done');
  await p.fill('#e-box', '7');
  await p.press('#e-box', 'Enter');
  assert.deepEqual([await sheets(), (await kept('r')).box, await p.textContent('.toast')], [0, '7', 'Saved. Box 7 holds 2 sets now.'], 'Enter in Moving box saves and closes');
  await p.click('.item:has-text("Retro Radio")');
  await p.click('#e-missing');
  await p.keyboard.type('the dial');
  await p.keyboard.press('Enter');
  await p.keyboard.type('one foot');
  assert.deepEqual([await sheets(), await p.inputValue('#e-missing')], [1, 'the dial\none foot'], 'Enter in Missing pieces is a new line');
  await p.focus('#e-instr');
  await p.keyboard.press('Enter');
  await p.focus('#e-state [data-v="apart"]');
  await p.keyboard.press('Enter');
  assert.deepEqual([await sheets(), await p.getAttribute('#e-state [data-v="apart"]', 'aria-pressed'), (await kept('r')).missing], [1, 'true', undefined], 'Enter on a tick-box or a State button doesn’t save');
  // The number put right: the picture is asked for again at once, for the new number.
  asked.length = 0;
  await p.fill('#e-num', '10340');
  await p.press('#e-num', 'Tab');
  await p.waitForFunction(() => document.querySelector('.head-pic').dataset.num === '10340-1');
  await until(() => asked.includes('10340-1.jpg/1000x800p.jpg'), 5000, 'the picture follows the number');
  // A number another set has: the first go asks, the second saves.
  await p.fill('#e-num', '75192');
  await p.press('#e-num', 'Enter');
  assert.deepEqual([await sheets(), await p.textContent('#e-save'), await p.textContent('.toast'), (await kept('r')).num],
    [1, 'Save anyway', 'You already have Millennium Falcon (Office). Tap again to keep both.', '10334-1'], 'renumbered to a set that’s owned: it asks first');
  await p.press('#e-num', 'Enter');
  assert.equal((await kept('r')).num, '10334-1', 'and Enter held down is still one go');
  await p.fill('#e-num', '10340');
  assert.equal(await p.textContent('#e-save'), 'Save', 'another number puts Save back');
  await p.fill('#e-num', '75192');
  await p.click('#e-save');
  await p.waitForTimeout(650);
  await p.click('#e-save');
  assert.deepEqual([await sheets(), (await kept('r')).num, (await kept('r')).missing], [0, '75192-1', 'the dial\none foot'], 'the second go saves');
  // A set saved with the number it already had isn't asked about, though another has it too.
  await p.click('.item:has-text("Retro Radio")');
  await p.fill('#e-room', 'Hall');
  await p.press('#e-room', 'Enter');
  assert.deepEqual([await sheets(), (await kept('r')).room], [0, 'Hall']);
  // Adding by hand: Enter adds, and a set already owned still takes a second go.
  await p.click('#add-btn');
  await p.fill('#e-num', '21318');
  await p.press('#e-num', 'Enter');
  assert.equal(await p.locator('.item').count(), 4, 'Enter adds the set');
  await p.click('#add-btn');
  await p.fill('#e-num', '21318');
  await p.press('#e-num', 'Enter');
  await p.press('#e-num', 'Enter');
  assert.deepEqual([await p.locator('.item').count(), await p.textContent('#e-save')], [4, 'Add another copy'], 'Enter doesn’t get round the second tap');
  await p.click('[data-close]'); await p.waitForTimeout(650); await p.click('[data-close]');
  // The search: tapped or clicked with something in it, typing replaces it.
  await p.fill('#q', 'radio');
  await p.click('h1:visible');
  await p.click('#q');
  await p.keyboard.type('falcon');
  assert.equal(await p.inputValue('#q'), 'falcon', 'a click in the search selects what’s there');
  await p.click('h1:visible');
  await p.tap('#q');
  await p.keyboard.type('bonsai');
  assert.deepEqual([await p.inputValue('#q'), await p.locator('.item .t').allTextContents()], ['bonsai', ['Bonsai Tree']], 'and so does a tap');
  await c.close();
}

// What's typed in a sheet isn't thrown away on one slip. With changes in it, a tap on the dimmed page outside does
// nothing, and Close or Escape ask first ("Discard changes?") and close on the next one. A sheet nothing was changed
// in closes as it always did.
{
  const { c, p } = await withSets({ sets: { a: { id: 'a', t: 1, num: '10281-1', name: 'Bonsai Tree', state: 'built' } },
    cases: { k: { id: 'k', t: 1, name: 'Kallax', w: 33, d: 37, levels: [{ h: 33, sets: [] }] } } });
  const sheets = () => p.locator('.sheet').count(), outside = () => p.mouse.click(195, 12), close = () => p.textContent('[data-close]');
  await p.goto(base + '#catalog');
  await p.click('.item:has-text("Bonsai Tree")');
  await outside();
  assert.equal(await sheets(), 0, 'a tap outside a sheet nothing was changed in closes it');
  await p.click('.item:has-text("Bonsai Tree")');
  await p.fill('#e-missing', 'one green leaf');
  await outside();
  assert.deepEqual([await sheets(), await p.inputValue('#e-missing')], [1, 'one green leaf'], 'with something typed, a tap outside leaves the sheet open');
  await p.click('[data-close]');
  assert.deepEqual([await sheets(), await close()], [1, 'Discard changes?'], 'Close asks first');
  await p.click('[data-close]');
  assert.equal(await sheets(), 1, 'and a double tap is still one tap');
  await p.type('#e-missing', ', and the pot');
  assert.equal(await close(), 'Close', 'going back to typing puts Close back');
  await p.keyboard.press('Escape');
  assert.deepEqual([await sheets(), await close()], [1, 'Discard changes?'], 'Escape asks first too');
  await p.waitForTimeout(700);
  await p.keyboard.press('Escape');
  assert.equal(await sheets(), 0, 'and the next one closes');
  assert.equal(await p.evaluate(() => window.brickyard.doc().sets.a.missing), undefined, 'nothing was saved');
  await p.click('.item:has-text("Bonsai Tree")');
  await p.click('#e-state [data-v="apart"]');
  await outside();
  assert.equal(await sheets(), 1, 'a changed state counts as a change');
  await p.click('#e-state [data-v="built"]');
  await outside();
  assert.equal(await sheets(), 0, 'and put back as it was, the sheet closes on one tap again');
  await p.click('.item:has-text("Bonsai Tree")');
  await p.fill('#e-missing', 'one green leaf');
  await p.click('#e-save');
  assert.deepEqual([await sheets(), await p.evaluate(() => window.brickyard.doc().sets.a.missing)], [0, 'one green leaf'], 'Save saves without asking');
  // A batch from Claude: unticking a set, or typing where they all go, is a change.
  await p.goto(base + '#b1z' + deflateRawSync(JSON.stringify({ brickyard: 1, batch: { sets: [{ num: '10497', name: 'Galaxy Explorer' }, { num: '21318', name: 'Tree House' }] } })).toString('base64url'));
  await p.waitForSelector('#rv-add');
  await p.click('.rv li >> nth=1 >> .t');
  await outside();
  assert.equal(await sheets(), 1, 'a batch with a set unticked stays open');
  await p.click('.rv li >> nth=1 >> .t');
  await p.fill('#rv-box', '4');
  await p.click('[data-close]');
  assert.deepEqual([await sheets(), await close()], [1, 'Discard changes?'], 'and with a box typed in, Not now asks first');
  await p.fill('#rv-box', '');
  assert.equal(await close(), 'Not now');
  await p.click('[data-close]');
  assert.equal(await sheets(), 0);
  // The shelf planner's sheets: a bookcase, and a set's size and place.
  await p.goto(base + '#shelves');
  await p.click('[data-case="k"]');
  await p.fill('#k-h0', '34');
  await outside();
  assert.equal(await sheets(), 1, 'a bookcase being changed stays open');
  await p.click('[data-close]');
  await p.waitForTimeout(700);
  await p.click('[data-close]');
  assert.deepEqual([await sheets(), await p.evaluate(() => window.BrickCore.shelves(window.brickyard.doc()).k.levels.map(l => l.h))], [0, [33]], 'and is left as it was once discarded');
  await p.click('[data-act="add-case"]');
  await p.click('#k-preset [data-k="2"]');
  await outside();
  assert.equal(await sheets(), 0, 'choosing a preset for a new bookcase isn’t something to lose');
  await p.click('#shelves-body .list .item:has-text("Bonsai Tree")');
  await p.fill('#z-h', '18');
  await outside();
  assert.deepEqual([await sheets(), await p.inputValue('#z-h')], [1, '18'], 'a set’s size being typed stays open');
  await c.close();
}

// Remove a set.
await page.click('.item:has-text("Medieval Castle")');
await page.dblclick('#e-del');
assert.equal((await live()).length, 7, 'one tap, or a double tap, does not remove');
await page.waitForTimeout(700);
await page.click('#e-del');
assert.equal((await live()).length, 6);
assert.equal(Object.values((await doc()).sets).filter(x => x.del).length, 1, 'removal is remembered');

// Remove says what it removed and offers Undo, which puts the thing back as it was: a set (with its notes, and its
// place on a shelf), a bookcase, a lot of loose pieces, a model. Put back, it's timed after the removal, so a copy of
// the catalog that still holds the removal (another device, Drive) doesn't take it away again.
{
  const { c, p } = await withSets({
    sets: { t: { id: 't', t: 1, num: '21318-1', name: 'Tree House', state: 'built', room: 'Living room', notes: 'a gift', missing: 'one leaf', size: { w: 27, d: 24, h: 37 } },
      o: { id: 'o', t: 1, name: 'Orchid', state: 'built' } },
    cases: { k: { id: 'k', t: 1, name: 'Hall Billy', w: 76, d: 26, levels: [{ h: 40, sets: [{ id: 't' }] }, { h: 32, sets: [] }] },
      e: { id: 'e', t: 1, name: 'Empty Kallax', w: 33, d: 37, levels: [{ h: 33, sets: [] }] } },
    loose: { tub: { id: 'tub', t: 1, name: 'Blue tub', box: '14', parts: [['3001', 4, 40], ['3020', 15, 2]] } } });
  const toastSays = () => p.evaluate(() => { const t = document.querySelector('.toast'); return t && !t.hidden ? [t.querySelector('span').textContent, (t.querySelector('button') || {}).textContent || ''] : null; });
  const twice = async sel => { await p.click(sel); await p.waitForTimeout(650); await p.click(sel); };
  const kept = kind => p.evaluate(k => window.brickyard.doc()[k], kind);
  await p.goto(base + '#catalog');
  await p.click('.item:has-text("Tree House")');
  await twice('#e-del');
  assert.deepEqual(await toastSays(), ['Removed Tree House', 'Undo'], 'Remove names the set and offers Undo');
  const gone = (await kept('sets')).t;
  assert.deepEqual([gone.del, await p.locator('.item').count()], [1, 1]);
  await p.click('.toast button');
  const back = (await kept('sets')).t;
  assert.deepEqual([back.name, back.notes, back.missing, back.room, back.size, back.del], ['Tree House', 'a gift', 'one leaf', 'Living room', { w: 27, d: 24, h: 37 }, undefined], 'Undo puts the set back as it was');
  assert.ok(back.t > gone.t, 'timed after the removal');
  assert.deepEqual([await toastSays(), await p.locator('.item').count()], [['Tree House is back', ''], 2], 'and says so, with the set in the list again');
  assert.equal(await p.evaluate(g => window.BrickCore.mergeDocs(window.brickyard.doc(), { sets: { t: g }, cases: {}, loose: {}, seen: {} }).sets.t.name, gone), 'Tree House', 'a copy that still holds the removal doesn’t take it away again');
  assert.equal(JSON.parse(await p.evaluate(() => localStorage.getItem('brickyard.v1'))).catalog.sets.t.name, 'Tree House', 'and it is saved');
  await p.goto(base + '#shelves');
  assert.equal(await p.locator('.sv-set').count(), 1, 'it is still on its shelf');
  // A bookcase.
  await p.click('[data-case="k"]');
  await twice('#k-del');
  assert.deepEqual(await toastSays(), ['Removed Hall Billy. Its sets are back in Not on a shelf yet.', 'Undo']);
  assert.deepEqual([await p.locator('.case').count(), await p.locator('.sv-set').count()], [1, 0]);
  await p.click('.toast button');
  assert.deepEqual([await toastSays(), await p.locator('.case').count(), await p.locator('.sv-set').count()], [['Hall Billy is back', ''], 2, 1], 'Undo puts the bookcase back with the set on it');
  assert.deepEqual((await p.evaluate(() => window.BrickCore.shelves(window.brickyard.doc()))).k.levels, [{ h: 40, sets: [{ id: 't' }] }, { h: 32, sets: [] }]);
  await p.click('[data-case="e"]');
  await twice('#k-del');
  assert.deepEqual(await toastSays(), ['Removed Empty Kallax', 'Undo'], 'an empty bookcase has no sets to speak of');
  // A lot of loose pieces.
  await p.goto(base + '#build');
  await p.click('li.lot [data-lot="tub"]');
  await p.click('#lot-drop');
  await p.waitForFunction(() => !document.querySelector('li.lot'));
  assert.deepEqual(await toastSays(), ['Removed Blue tub', 'Undo']);
  await p.click('.toast button');
  await p.waitForSelector('li.lot');
  const tub = (await kept('loose')).tub;
  assert.deepEqual([await toastSays(), tub.name, tub.box, tub.parts], [['Blue tub is back', ''], 'Blue tub', '14', [['3001', 4, 40], ['3020', 15, 2]]], 'Undo puts the lot back');
  // A model: removing it says so (it said nothing), and Undo puts it back in the list.
  const wall = { brickyard: 1, model: { name: 'Wall', parts: Array.from({ length: 4 }, (_, i) => ['3001', 4, 0, i * 3, 0, 0, i + 1]) } };
  await p.goto(base + '#d1z' + deflateRawSync(JSON.stringify(wall)).toString('base64url'));
  await p.waitForFunction(() => location.hash.startsWith('#model-m') && !document.getElementById('model-view').hidden);
  await p.click('#model-menu');
  await twice('#mm-del');
  await p.waitForSelector('#build-list:not([hidden]) .list');
  assert.deepEqual([await toastSays(), await p.locator('#build-list .list .item:has-text("Wall")').count()], [['Removed Wall', 'Undo'], 0], 'removing a model says what went');
  await p.click('.toast button');
  await p.waitForSelector('#build-list .list .item:has-text("Wall")');
  assert.deepEqual(await toastSays(), ['Wall is back', '']);
  await p.click('#build-list .list .item:has-text("Wall")');
  await p.waitForSelector('#model-view:not([hidden])');
  assert.equal(await p.textContent('#build-title'), 'Wall', 'and it opens again');
  await c.close();
}

// "Added 3 sets" has Undo: one tap takes out the sets that were just added and leaves My sets as it was (a batch added
// with the wrong box typed for all of them used to be put right or removed set by set). The link is then offered
// whole again, as if it had never been opened.
{
  const batch = { brickyard: 1, batch: { name: 'Hall shelf', sets: [{ num: '10334', name: 'Retro Radio' }, { num: '10497', name: 'Galaxy Explorer' }, { num: '10331', name: 'Kingfisher Bird' }, { num: '10281', name: 'Bonsai Tree' }] } };
  const { c, p } = await withSets({ sets: { o: { id: 'o', t: 1, name: 'Orchid', state: 'built' }, b: { id: 'b', t: 1, num: '10281-1', name: 'Bonsai Tree', state: 'built' } } });
  const link = base + '#b1z' + deflateRawSync(JSON.stringify(batch)).toString('base64url');
  const names = () => p.evaluate(() => Object.values(window.brickyard.doc().sets).filter(x => !x.del).map(x => x.name + (x.box ? ' in ' + x.box : '')).sort());
  const toastSays = () => p.evaluate(() => { const t = document.querySelector('.toast'); return t && !t.hidden ? [t.querySelector('span').textContent, (t.querySelector('button') || {}).textContent || ''] : null; });
  const ticks = () => p.$$eval('.rv li input', bs => bs.map(b => b.checked));
  await p.goto(link);
  await p.waitForSelector('#rv-add');
  await p.fill('#rv-box', '12'); // the wrong box
  // Put them all in box 12 is all of them: the Bonsai Tree that's owned already is in the photo too, and its row
  // turns into a move, ticked. Undo takes it back out of the box as well.
  assert.deepEqual([await ticks(), await p.textContent('#rv li:nth-child(4) .w'), await p.textContent('#rv-add')], [[true, true, true, true], 'Move it: Box 12', 'Add 3, move 1']);
  await p.click('#rv-add');
  assert.deepEqual([await toastSays(), await names()], [['Added 3, moved 1', 'Undo'], ['Bonsai Tree in 12', 'Galaxy Explorer in 12', 'Kingfisher Bird in 12', 'Orchid', 'Retro Radio in 12']]);
  await p.click('.toast button');
  assert.deepEqual([await toastSays(), await names(), await p.locator('.item .t').allTextContents(), await p.evaluate(() => window.brickyard.doc().seen)],
    [['Took out the 3 sets added, and put the other back', ''], ['Bonsai Tree', 'Orchid'], ['Bonsai Tree', 'Orchid'], {}], 'Undo leaves My sets as it was');
  assert.deepEqual(Object.values(JSON.parse(await p.evaluate(() => localStorage.getItem('brickyard.v1'))).catalog.sets).filter(x => !x.del).length, 2, 'and that is saved');
  await p.goto(link);
  await p.waitForSelector('#rv-add');
  assert.deepEqual([await ticks(), await p.locator('.sheet .flag').count()], [[true, true, true, false], 0], 'the link is offered whole again, without "opened before"');
  // Undo after a second go at the same link takes out only what that go added, and remembers the first.
  await p.click('.rv li >> nth=2 >> .t');
  await p.click('#rv-add');
  await p.goto(link);
  await p.waitForSelector('#rv-add');
  assert.deepEqual(await ticks(), [false, false, true, false]);
  await p.click('#rv-add');
  assert.deepEqual(await toastSays(), ['Added 1 set', 'Undo']);
  await p.click('.toast button');
  assert.deepEqual([await toastSays(), await names()], [['Took that set out again', ''], ['Bonsai Tree', 'Galaxy Explorer', 'Orchid', 'Retro Radio']]);
  await p.goto(link);
  await p.waitForSelector('#rv-add');
  assert.deepEqual([await ticks(), await p.locator('.sheet .flag').count()], [[false, false, true, false], 1], 'the first go is still remembered');
  await c.close();
}

// Tab stays in an open sheet, never reaching the page behind it, and closing it gives focus back.
await page.focus('#menu-btn');
await page.keyboard.press('Enter');
await page.waitForSelector('.sheet');
for (let i = 0; i < 14; i++) {
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => !!document.activeElement.closest('body > section, .jd-foot')), false, 'Tab ' + (i + 1) + ' stays out of the page behind the sheet');
}
await page.keyboard.press('Escape');
assert.equal(await page.evaluate(() => document.activeElement.id), 'menu-btn', 'focus goes back to the menu button');
assert.equal(await page.evaluate(() => document.getElementById('catalog').inert), false, 'the page works again once the sheet is closed');

// The keyboard's place is kept when a sheet closes or the list is redrawn. It used to be thrown back to the top of
// the page: after Escape on the first sheet opened on a screen, after Save and Remove (the list is drawn again), and
// after a press on a filter chip (the chips are too). Now it's on the set's row again, on the row that took a removed
// set's place, and on the chip.
{
  const { c, p } = await withSets({ sets: { a: { id: 'a', t: 1, num: '10281-1', name: 'Bonsai Tree', state: 'built', room: 'Hall' }, b: { id: 'b', t: 1, name: 'Orchid', state: 'built', room: 'Hall' },
    d: { id: 'd', t: 1, name: 'Typewriter', state: 'apart', room: 'Office' }, e: { id: 'e', t: 1, name: 'Wildflowers', state: 'built', room: 'Office' } } },
  { viewport: { width: 1280, height: 800 }, hasTouch: false, deviceScaleFactor: 1 });
  const active = () => p.evaluate(() => { const a = document.activeElement; return a === document.body ? 'BODY' : a.dataset.id || a.dataset.f || a.id || a.tagName; });
  // Closing a sheet goes back over its place in history, which the browser does a moment later.
  const closed = async () => { await p.waitForFunction(() => !document.querySelector('.sheet') && !(history.state && history.state.sheet)); await p.waitForTimeout(100); };
  await p.goto('about:blank'); // opened afresh on My sets: the case that lost the focus on the first close
  await p.goto(base + '#catalog');
  await p.focus('.item[data-id="a"]');
  await p.keyboard.press('Enter');
  await p.waitForSelector('.sheet');
  await p.keyboard.press('Escape');
  await closed();
  assert.equal(await active(), 'a', 'after Escape on the first sheet, focus is on the set’s row');
  await p.keyboard.press('Enter');
  await p.fill('#e-notes', 'a gift');
  await p.press('#e-year', 'Enter');
  await closed();
  assert.equal(await active(), 'a', 'after Save, on the row as it’s drawn again');
  await p.keyboard.press('Enter');
  await p.fill('#e-room', 'Study');
  await p.click('#e-save');
  await closed();
  assert.deepEqual([await active(), await p.locator('.item .t').allTextContents()], ['a', ['Orchid', 'Typewriter', 'Wildflowers', 'Bonsai Tree']], 'and still on it when Save moved it down the list');
  // Remove: the row that took its place (the last row, when it was the last).
  await p.focus('.item[data-id="d"]');
  await p.keyboard.press('Enter');
  await p.focus('#e-del');
  await p.keyboard.press('Enter'); await p.waitForTimeout(650); await p.keyboard.press('Enter');
  await closed();
  assert.equal(await active(), 'e', 'after Remove, on the row that took its place');
  await p.keyboard.press('Control+z');
  await p.waitForFunction(() => document.querySelectorAll('.item').length === 4);
  assert.equal(await active(), 'e', 'and Undo leaves it there');
  // A filter chip.
  await p.focus('.chip[data-f="apart"]');
  await p.keyboard.press('Space');
  assert.deepEqual([await active(), await p.getAttribute('.chip[data-f="apart"]', 'aria-pressed')], ['apart', 'true'], 'a chip keeps the focus when it’s pressed');
  await p.keyboard.press('Tab');
  assert.equal(await active(), 'group', 'so Tab goes on from it, not from the top');
  // A catalog arriving from sync, or another tab's save, redraws the list too.
  await p.focus('.chip[data-f="all"]');
  await p.keyboard.press('Enter');
  await p.focus('.item[data-id="b"]');
  await p.evaluate(() => window.brickyard.takeDoc(window.brickyard.doc()));
  assert.equal(await active(), 'b', 'the list redrawn under you keeps your place');
  // A set shown by a search that Save takes out of it: the next row has the focus.
  await p.fill('#q', 'hall');
  await p.focus('.item[data-id="b"]');
  await p.keyboard.press('Enter');
  await p.fill('#e-room', 'Attic');
  await p.press('#e-room', 'Enter');
  await closed();
  assert.deepEqual([await p.locator('.item').count(), await active()], [0, 'H1'], 'with no row left, the screen’s heading has it');
  await c.close();
}

// Every screen has its own title (they were all "Brickyard": in the tab, the browser's history, a phone's app
// switcher), and on a move to another screen its heading takes the focus, so a screen reader says where this is
// (the focus was left nowhere). Not when Brickyard first opens. And the names a screen reader is given: a chip is
// "Built, 2 sets" (it read "Built2"), a group's heading "Hall, 2 sets", a row's warning "To check" like its chip,
// and the State buttons are a group called State. The count line is read out when a search or a filter changes it.
{
  const { c, p } = await withSets({ sets: { a: { id: 'a', t: 1, num: '10281-1', name: 'Bonsai Tree', state: 'built', room: 'Hall' }, b: { id: 'b', t: 1, name: 'Orchid', state: 'built', room: 'Hall', check: 'or is it 10311?' },
    d: { id: 'd', t: 1, name: 'Typewriter', state: 'apart', room: 'Office' } } }, { viewport: { width: 1280, height: 800 }, hasTouch: false, deviceScaleFactor: 1 });
  const at = () => p.evaluate(() => { const a = document.activeElement; return [document.title, a === document.body ? 'BODY' : a.tagName + ' ' + a.textContent.slice(0, 40)]; });
  const shown = id => p.waitForFunction(i => !document.getElementById(i).hidden, id); // the browser moves on a moment after the press
  assert.deepEqual(await at(), ['Brickyard', 'BODY'], 'home, as it opens: nothing takes the focus');
  await p.focus('#go-catalog');
  await p.keyboard.press('Enter');
  await shown('catalog');
  assert.deepEqual(await at(), ['My sets · Brickyard', 'H1 My sets']);
  await p.goBack();
  await shown('home');
  assert.deepEqual(await at(), ['Brickyard', 'H1 Brickyard']);
  await p.click('#go-shelves');
  await shown('shelves');
  assert.deepEqual(await at(), ['Shelf planner · Brickyard', 'H1 Shelf planner']);
  await p.goto(base + '#build');
  await p.waitForSelector('#build-list .list .item');
  assert.deepEqual(await at(), ['Build from your box · Brickyard', 'H1 Build from your box']);
  await p.click('#build-list .list .item:has-text("Cottage")');
  await p.waitForSelector('#model-view:not([hidden])');
  await p.waitForFunction(() => document.title !== 'Build from your box · Brickyard');
  assert.deepEqual(await at(), ['Cottage · Brickyard', 'H1 Cottage'], 'a model’s title and heading are its name');
  const step = await p.textContent('#step-n');
  await p.keyboard.press('ArrowRight');
  assert.notEqual(await p.textContent('#step-n'), step, 'and the arrow keys still step through it');
  await p.click('#build-back');
  await p.waitForSelector('#build-list:not([hidden]) .list .item');
  await p.waitForFunction(() => document.title === 'Build from your box · Brickyard');
  assert.deepEqual(await at(), ['Build from your box · Brickyard', 'H1 Build from your box']);
  // Opened afresh on a screen, the focus is left alone; a link that opens a sheet leaves it in the sheet.
  await p.goto('about:blank');
  await p.goto(base + '#catalog');
  assert.deepEqual(await at(), ['My sets · Brickyard', 'BODY']);
  await p.goto(base + '#shelves');
  const batch = { brickyard: 1, batch: { sets: [{ num: '10497', name: 'Galaxy Explorer' }] } };
  await p.goto(base + '#b1z' + deflateRawSync(JSON.stringify(batch)).toString('base64url'));
  await p.waitForSelector('#rv-add');
  assert.deepEqual([(await at())[0], await p.evaluate(() => !!document.activeElement.closest('.sheet'))], ['My sets · Brickyard', true], 'sets from a link: the sheet has the focus');
  assert.equal(await p.getByRole('group', { name: 'Put them all in' }).count(), 1);
  await p.click('[data-close]');
  await p.waitForFunction(() => !(history.state && history.state.sheet));
  await p.waitForTimeout(100);
  assert.deepEqual(await at(), ['My sets · Brickyard', 'H1 My sets'], 'and hands it to the heading when it closes');
  // Names.
  const named = (role, name, more) => p.getByRole(role, { name, exact: true, ...more }).count();
  assert.deepEqual([await named('button', 'All, 3 sets'), await named('button', 'Built, 2 sets'), await named('button', 'To check, 1 set'), await p.textContent('.chip[data-f="built"]')], [1, 1, 1, 'Built2'], 'a chip’s name has its count in words; it looks as it did');
  assert.deepEqual([await named('heading', 'Hall, 2 sets', { level: 2 }), await named('heading', 'Office, 1 set', { level: 2 }), await p.locator('#list-wrap h3').count()], [1, 1, 0], 'a group’s heading, straight under the screen’s');
  assert.equal(await named('button', /Orchid.*To check: or is it 10311\?/, { exact: false }), 1, 'the row says To check, as the chip does, and what to check');
  assert.equal(await p.getAttribute('#sum', 'aria-live'), 'polite', 'the count is read out when it changes');
  await p.click('.item[data-id="a"]');
  assert.deepEqual([await named('group', 'State'), await p.getByRole('group', { name: 'State' }).getByRole('button').count()], [1, 4], 'the State buttons are a group called State');
  await c.close();
}

// Open a file in My sets also takes the sizes and model files Claude hands over: sizes go on to the shelf planner's
// Add sizes, a model into Build from your box, opened. A sizes link pasted into Add from photos goes on too.
{
  const { c, p } = await withSets({ sets: { g: { id: 'g', t: 1, num: '10497-1', name: 'Galaxy Explorer', state: 'built' } } });
  const file = (name, o) => p.setInputFiles('#file', { name, mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(o, null, 1)) });
  await p.goto(base + '#catalog');
  await p.click('#menu-btn');
  assert.equal(await p.textContent('#m-open small'), 'A backup, or sets, sizes or a model from Claude');
  await p.click('[data-close]');
  await file('sizes.brickyard.json', { brickyard: 1, sizes: [{ num: '10497', w: 51, d: 25, h: 33 }] });
  await p.waitForSelector('#zr-go');
  await p.waitForFunction(() => !document.getElementById('shelves').hidden);
  assert.equal(await p.evaluate(() => location.hash), '#shelves', 'a sizes file goes on to the shelf planner');
  await p.click('#zr-go');
  assert.deepEqual(await p.evaluate(() => window.brickyard.doc().sets.g.size), { w: 51, d: 25, h: 33 }, 'and its sizes are added');
  await p.goto(base + '#catalog');
  const model = JSON.parse(await readFile(join(root, 'models/cottage.json'), 'utf8'));
  model.model.name = 'Filed cottage';
  await file('filed-cottage.brickyard-model.json', model);
  await p.waitForFunction(() => location.hash.startsWith('#model-m'));
  await p.waitForSelector('#model-view:not([hidden])');
  assert.equal(await p.textContent('#build-title'), 'Filed cottage', 'a model file opens in Build from your box');
  assert.equal(await p.evaluate(() => Object.values(JSON.parse(localStorage.getItem('brickyard.models'))).filter(m => m.model.name === 'Filed cottage').length), 1, 'and is kept with the models');
  await p.goto(base + '#catalog');
  await p.click('#claude-btn');
  await p.fill('#paste', 'Sizes: ' + base + '#z1z' + deflateRawSync(JSON.stringify({ brickyard: 1, sizes: [{ num: '10497', w: 52, d: 25, h: 33 }] })).toString('base64url') + '.');
  await p.click('#p-go');
  await p.waitForSelector('#zr-go');
  assert.equal(await p.evaluate(() => location.hash), '#shelves', 'a pasted sizes link goes on to the shelf planner');
  await c.close();
}

// Every paste box takes every kind of Brickyard link or file and sends it to its own review, on the screen it
// belongs to: sets pasted into Open a model end up in My sets, and so on round. Each box has Open a file too.
{
  const { c, p } = await withSets({ sets: { g: { id: 'g', t: 1, num: '10497-1', name: 'Galaxy Explorer', state: 'built' } } });
  const packed = o => deflateRawSync(JSON.stringify(o)).toString('base64url');
  const at = () => p.evaluate(() => [location.hash, (document.getElementById('sheetTitle') || {}).textContent || '', ['home', 'catalog', 'build', 'shelves'].filter(id => !document.getElementById(id).hidden).join()]);
  const says = () => p.evaluate(() => { const t = document.querySelector('.toast'); return t && !t.hidden ? t.querySelector('span').textContent : ''; });
  const setsDoc = { brickyard: 1, batch: { name: 'From the other box', sets: [{ num: '21318', name: 'Tree House' }] } };
  const setsLink = base + '#b1z' + packed(setsDoc);
  const lotLink = 'Your tub: ' + base + '#l1z' + packed({ brickyard: 1, loose: { id: 'tub', name: 'Blue tub', parts: [['3001', 4, 40]] } }) + '.';
  const sizesLink = base + '#z1z' + packed({ brickyard: 1, sizes: [{ num: '10497', w: 52, d: 32, h: 13 }] });
  const wall = { name: 'Wall', parts: Array.from({ length: 4 }, (_, i) => ['3001', 4, 0, i * 3, 0, 0, i + 1]) };
  const paste = async (open, box, go, text) => { await p.click(open); await p.fill(box, text); await p.click(go); };
  const model = t => paste('#open-model', '#model-paste', '#model-go', t), sizes = t => paste('[data-act="open-sizes"]', '#z-paste', '#z-go', t);

  // Open a model, in Build from your box.
  await p.goto(base + '#build');
  await p.click('#open-model');
  assert.deepEqual(await p.$eval('#model-paste', e => [e.placeholder, e.getAttribute('aria-label')]), ['Paste a Brickyard link or file', 'Paste a Brickyard link or file']);
  assert.deepEqual(await p.$$eval('.sheet .ft button', bs => bs.map(b => b.textContent)), ['Open a file', 'Open'], 'Open a model has Open a file');
  await p.click('[data-close]');
  await model(setsLink);
  await p.waitForSelector('#rv-add');
  await p.waitForFunction(() => !document.getElementById('catalog').hidden);
  assert.deepEqual(await at(), ['#catalog', 'Add sets from Claude', 'catalog'], 'a sets link pasted into Open a model is reviewed in My sets');
  await p.click('#rv-add');
  await p.waitForFunction(() => !document.querySelector('.scrim'));
  assert.deepEqual([await at(), await says(), await p.locator('#catalog .item').count()], [['#catalog', '', 'catalog'], 'Added 1 set', 2], 'and added there, with the list showing it');
  await p.goBack();
  await p.waitForSelector('#build-list:not([hidden]) #open-model');
  assert.deepEqual(await at(), ['#build', '', 'build'], 'Back from there is Build from your box, with no sheet left over');
  await model(lotLink);
  await p.waitForSelector('#ls-add');
  assert.deepEqual(await at(), ['#build', 'Add loose pieces', 'build'], 'a loose-pieces link pasted into Open a model is reviewed where it is');
  await p.click('#ls-add');
  await p.waitForSelector('li.lot');
  await model(sizesLink);
  await p.waitForSelector('#zr-go');
  await p.waitForFunction(() => !document.getElementById('shelves').hidden);
  assert.deepEqual(await at(), ['#shelves', 'Add sizes', 'shelves'], 'a sizes link pasted into Open a model goes to the shelf planner');
  await p.click('[data-close]');
  // Open a file, from Open a model: a sets file is reviewed in My sets.
  await p.goto(base + '#build');
  await p.click('#open-model');
  const [chooser] = await Promise.all([p.waitForEvent('filechooser'), p.click('#model-file')]);
  await chooser.setFiles({ name: 'more.brickyard.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(setsDoc, null, 1)) });
  await p.waitForSelector('#rv-add');
  await p.waitForFunction(() => !document.getElementById('catalog').hidden);
  assert.deepEqual([await at(), await p.textContent('#rv .w')], [['#catalog', 'Add sets from Claude', 'catalog'], 'You already have this one'], 'a sets file opened from Open a model is reviewed in My sets');
  await p.click('[data-close]');
  // Things that aren't Brickyard's keep the box's own words; a cut link says it's cut, and the sheet stays to try again.
  await p.goto(base + '#build');
  await model('hello there');
  await p.waitForFunction(() => document.querySelector('.toast') && !document.querySelector('.toast').hidden);
  assert.deepEqual([await says(), (await at())[1]], ['That doesn’t look like a model from Claude', 'Open a model']);
  await p.fill('#model-paste', setsLink.slice(0, setsLink.length - 7));
  await p.click('#model-go');
  await p.waitForFunction(w => document.querySelector('.toast span').textContent === w, CUT);
  assert.equal((await at())[1], 'Open a model', 'the sheet is still there after a cut link');
  // The message sits over the paste box for six seconds; a tap puts it away.
  await p.click('.toast');
  assert.deepEqual([await p.isHidden('.toast'), (await at())[1]], [true, 'Open a model'], 'a tap on the message puts it away, and nothing else');
  await p.fill('#model-paste', base + '#d3z' + packed({ brickyard: 2, model: wall }));
  await p.click('#model-go');
  await p.waitForFunction(w => document.querySelector('.toast span').textContent === w, NEWER);
  await p.click('[data-close]');

  // Sizes from Claude, in the shelf planner.
  await p.goto(base + '#shelves');
  await p.click('[data-act="open-sizes"]');
  assert.deepEqual(await p.$eval('#z-paste', e => [e.placeholder, e.getAttribute('aria-label')]), ['Paste a Brickyard link or file', 'Paste a Brickyard link or file']);
  assert.deepEqual(await p.$$eval('.sheet .ft button', bs => bs.map(b => b.textContent)), ['Open a file', 'Open'], 'Sizes from Claude has Open a file');
  await p.click('[data-close]');
  await sizes(setsLink);
  await p.waitForSelector('#rv-add');
  await p.waitForFunction(() => !document.getElementById('catalog').hidden);
  assert.deepEqual(await at(), ['#catalog', 'Add sets from Claude', 'catalog'], 'a sets link pasted into Sizes from Claude is reviewed in My sets');
  await p.click('[data-close]');
  await p.goto(base + '#shelves');
  await sizes('```json\n' + JSON.stringify(wall) + '\n```'); // the model as the designer skill writes it, without a wrapper
  await p.waitForFunction(() => location.hash.startsWith('#model-m') && !document.getElementById('model-view').hidden);
  assert.equal(await p.textContent('#build-title'), 'Wall', 'a model pasted into Sizes from Claude opens in Build from your box');
  await p.goto(base + '#shelves');
  await sizes(sizesLink);
  await p.waitForSelector('#zr-go');
  assert.deepEqual([await at(), await p.textContent('#zr .m')], [['#shelves', 'Add sizes', 'shelves'], '10497 · 52 × 32 × 13 cm'], 'and sizes are still sizes');
  await p.click('#zr-go');
  await p.goto(base + '#shelves');
  await p.evaluate(() => { const d = window.brickyard.doc().sets.g; delete d.size; window.brickyard.putSet(d); });
  await p.reload();
  await sizes('not sizes');
  await p.waitForFunction(() => document.querySelector('.toast') && !document.querySelector('.toast').hidden);
  assert.equal(await says(), 'That doesn’t look like sizes from Claude');
  await p.click('[data-close]');
  // Sizes for sets that aren't in My sets: it says how many it held and why nothing came of them, with the way there.
  for (const [list, text] of [[[{ num: '99901', w: 10, d: 10, h: 10 }, { num: '99902', w: 10, d: 10, h: 10 }, { num: '99903', w: 10, d: 10, h: 10 }], 'Those 3 sizes are for sets that aren’t in My sets. Sizes only fill in sets you’ve already added.'],
    [[{ num: '99901', w: 10, d: 10, h: 10 }], 'That size is for a set that isn’t in My sets. Sizes only fill in sets you’ve already added.']]) {
    await p.goto('about:blank');
    await p.goto(base + '#z1z' + packed({ brickyard: 1, sizes: list }));
    await p.waitForFunction(() => document.querySelector('.toast') && !document.querySelector('.toast').hidden);
    assert.deepEqual([await says(), await p.textContent('.toast button'), await at()], [text, 'My sets', ['#shelves', '', 'shelves']]);
  }
  await p.click('.toast button');
  await p.waitForFunction(() => !document.getElementById('catalog').hidden);
  assert.equal((await at())[0], '#catalog', 'its button goes to My sets');
  await c.close();
}

// A set that's in one batch twice says so on the later one, and in the count at the top. Both stay ticked (there
// may really be two); one that's also owned already is unticked as ever, and isn't told to untick.
{
  const { c, p } = await withSets({ sets: { t: { id: 't', t: 1, num: '21318-1', name: 'Tree House', room: 'Hall' } } });
  const open = async sets => {
    await p.goto('about:blank');
    await p.goto(base + '#b1z' + deflateRawSync(JSON.stringify({ brickyard: 1, batch: { name: 'Hall shelf', sets } })).toString('base64url'));
    await p.waitForSelector('#rv-add');
    return p.$$eval('#rv li', lis => lis.map(li => [li.querySelector('.t').textContent, li.querySelector('input').checked, [...li.querySelectorAll('.w')].map(w => w.textContent)]));
  };
  const galaxy = { num: '10497', name: 'Galaxy Explorer' }, tree = { num: '21318', name: 'Tree House' };
  assert.deepEqual(await open([galaxy, tree, { name: 'Bonsai Tree' }, galaxy, tree, { name: 'bonsai tree' }]), [
    ['Galaxy Explorer', true, []], ['Tree House', false, ['You already have this one (Hall)']], ['Bonsai Tree', true, []],
    ['Galaxy Explorer', true, ['Also above in this list. Untick it unless you have two.']],
    ['Tree House', false, ['You already have this one (Hall)', 'Also above in this list.']],
    ['bonsai tree', true, ['Also above in this list. Untick it unless you have two.']]], 'the later of two the same says so');
  assert.equal(await p.textContent('.sheet .lede'), 'Hall shelf · 6 sets · 2 you already have · 3 twice in this list');
  assert.equal(await p.textContent('#rv-n'), '4 of 6 ticked', 'the repeats stay ticked');
  await p.click('#rv li:nth-child(6)');
  await p.click('#rv-add');
  assert.deepEqual((await p.evaluate(() => Object.values(window.brickyard.doc().sets).filter(x => !x.del).map(x => x.name))).sort(), ['Bonsai Tree', 'Galaxy Explorer', 'Galaxy Explorer', 'Tree House'], 'left ticked, both copies are added; unticked, one');
  const plain = await open([{ name: 'Bonsai Tree' }, { num: '21327', name: 'Typewriter' }]);
  assert.deepEqual([plain.map(r => r[2].length), await p.textContent('.sheet .lede')], [[1, 0], 'Hall shelf · 2 sets · 1 you already have'], 'a list with nothing in it twice says nothing about it');
  await c.close();
}

// A link from Claude moves the sets you already own. A Tree House sent as "box 7, partly built" used to arrive
// unticked as "You already have this one", and ticking it added a second Tree House, the first still on the bookcase.
// A row for a set owned once, whose room, shelf, box or state is not the catalog's, now says what it would change
// and is ticked; Add changes only those on the set that's owned. A set typed in by name gets its number from the
// row. "Add a second copy instead" is on each such row; a set owned twice is left alone, and says so.
{
  const own = {
    t: { id: 't', t: 1, num: '21318-1', name: 'Tree House', year: 2019, pieces: 3036, state: 'built', room: 'Living room', spot: 'Bookcase', notes: 'A gift', missing: 'one leaf', tags: ['ideas'], added: '2026-01-02' },
    o: { id: 'o', t: 1, num: '10311-1', name: 'Orchid', state: 'built', room: 'Office', spot: 'Desk', box: 'Box 3' },
    b: { id: 'b', t: 1, name: 'Bonsai Tree', room: 'Office', year: 2020, notes: 'Typed in' },
    g1: { id: 'g1', t: 1, num: '10497-1', name: 'Galaxy Explorer', room: 'Hall' }, g2: { id: 'g2', t: 1, num: '10497-1', name: 'Galaxy Explorer', room: 'Attic' },
    r: { id: 'r', t: 1, num: '10334-1', name: 'Retro Radio', state: 'built', room: 'Office', box: '7' },
  };
  const batch = { brickyard: 1, batch: { id: 'pack7', name: 'Box 7', box: '7', sets: [
    { num: '21318', name: 'Treehouse', state: 'partial', notes: 'From the photo', year: 2021 }, { num: '10311', name: 'Orchid' }, { num: '10281', name: 'Bonsai Tree', year: 2021, pieces: 878, theme: 'Icons' },
    { num: '10497', name: 'Galaxy Explorer' }, { num: '10334', name: 'Retro Radio' }, { num: '21327', name: 'Typewriter' }, { num: '10311', name: 'Orchid' }] } };
  const { c, p } = await withSets({ sets: own });
  const link = base + '#b1z' + deflateRawSync(JSON.stringify(batch)).toString('base64url');
  const rows = () => p.$$eval('#rv li', ls => ls.map(l => [l.querySelector('input').checked, l.querySelector('input').getAttribute('aria-label'), [...l.querySelectorAll('.w')].map(w => w.textContent).join(' | '), (l.querySelector('[data-copy]') || {}).textContent || '']));
  const sets = () => p.evaluate(() => { const o = {}; Object.values(window.brickyard.doc().sets).filter(x => !x.del).forEach(x => { o[x.id] = x; }); return o; });
  const says = async () => { await p.waitForFunction(() => document.querySelector('.toast') && !document.querySelector('.toast').hidden); return p.textContent('.toast span'); };
  await p.goto(link);
  await p.waitForSelector('#rv-add');
  assert.deepEqual(await rows(), [
    [true, 'Move Treehouse', 'Move it: Box 7, Partly built (now Living room › Bookcase, Built)', 'Add a second copy instead'],
    [true, 'Move Orchid', 'Move it: Box 7 (now Office › Desk · Box 3)', 'Add a second copy instead'],
    [true, 'Move Bonsai Tree', 'Move it: Box 7 (now Office), and add its number', 'Add a second copy instead'],
    [false, 'Add Galaxy Explorer', 'You already have 2 of this one, and a link can’t tell which to change. Change the right one yourself.', ''],
    [false, 'Add Retro Radio', 'You already have this one (Office · Box 7)', ''],
    [true, 'Add Typewriter', '', ''],
    [false, 'Add Orchid', 'You already have this one (Office › Desk · Box 3) | Also above in this list.', ''],
  ], 'what each row would do');
  assert.deepEqual([await p.textContent('#rv-add'), await p.textContent('#rv-n'), await p.textContent('.sheet .lede')], ['Add 1, move 3', '4 of 7 ticked', 'Box 7 · 7 sets · 6 you already have · 1 twice in this list']);
  // The link to tap under a row is a finger tall, and the words don't spill out of the sheet on a phone.
  assert.ok(await p.$$eval('#rv [data-copy]', bs => bs.every(b => b.getBoundingClientRect().height >= 44)), 'Add a second copy instead is 44 px tall');
  assert.ok(await p.evaluate(() => document.querySelector('.sheet').scrollWidth <= document.querySelector('.sheet').clientWidth), 'nothing spills sideways');
  // A second copy instead: the row adds, and can be turned back.
  await p.click('#rv li:nth-child(2) [data-copy]');
  assert.deepEqual([(await rows())[1], await p.textContent('#rv-add')], [[true, 'Add Orchid', 'Adds a second copy. You already have this one (Office › Desk · Box 3)', 'Move the one you have instead'], 'Add 2, move 2']);
  await p.click('#rv li:nth-child(2) [data-copy]');
  assert.deepEqual([(await rows())[1].slice(0, 2), await p.textContent('#rv-add')], [[true, 'Move Orchid'], 'Add 1, move 3']);
  // What's typed under Put them all in changes where they'd go, and the rows say so; a tick that was touched stays.
  await p.click('#rv li:nth-child(3) input');
  await p.fill('#rv-box', '');
  assert.deepEqual((await rows()).map(r => [r[0], r[2]]).slice(0, 5), [[true, 'Change it: Partly built (now Built)'], [false, 'You already have this one (Office › Desk · Box 3)'],
    [false, 'Add its number to the one you have (Office)'], [false, 'You already have 2 of this one'], [false, 'You already have this one (Office · Box 7)']], 'with the box cleared, nothing is packed');
  assert.equal(await p.textContent('#rv-add'), 'Add 1, change 1');
  await p.fill('#rv-box', '7');
  await p.click('#rv li:nth-child(3) input');
  assert.equal(await p.textContent('#rv-add'), 'Add 1, move 3');
  await p.click('#rv-add');
  assert.equal(await says(), 'Added 1, moved 3');
  let now = await sets();
  assert.deepEqual([Object.keys(now).length, now.t, now.o.box, now.b], [7,
    { ...own.t, state: 'partial', box: '7', t: now.t.t }, '7', { id: 'b', name: 'Bonsai Tree', room: 'Office', year: 2020, notes: 'Typed in', num: '10281-1', pieces: 878, theme: 'Icons', box: '7', t: now.b.t }],
    'only the box and the state changed on the Tree House; the Bonsai Tree got its number, pieces and theme, and kept its year');
  assert.ok(now.t.t > 1 && now.g1.t === 1 && now.r.t === 1, 'and the sets that weren’t ticked are untouched');
  // Undo takes the new set out and puts the three back as they were.
  await p.click('.toast button');
  now = await sets();
  assert.deepEqual([Object.keys(now).sort(), { ...now.t, t: 1 }, { ...now.o, t: 1 }, { ...now.b, t: 1 }], [Object.keys(own).sort(), own.t, own.o, own.b], 'Undo puts everything back');
  assert.equal(await says(), 'Took out the 1 set added, and put the others back');
  // Only sets that are owned: the button and the message say Move.
  const just = base + '#b1z' + deflateRawSync(JSON.stringify({ brickyard: 1, batch: { id: 'pack9', sets: [{ num: '21318', box: '9' }, { num: '10311', room: 'Office', spot: 'Desk', state: 'apart' }, { num: '10334', room: 'Den' }] } })).toString('base64url');
  await p.goto('about:blank');
  await p.goto(just);
  await p.waitForSelector('#rv-add');
  assert.deepEqual([(await rows()).map(r => r[2]), await p.textContent('#rv-add')], [['Move it: Box 9 (now Living room › Bookcase)', 'Change it: Taken apart (now Built)', 'Move it: Den, still in Box 7 (now Office · Box 7)'], 'Move 2, change 1']);
  await p.click('#rv li:nth-child(2) input');
  assert.equal(await p.textContent('#rv-add'), 'Move 2 sets');
  await p.click('#rv-add');
  assert.equal(await says(), 'Moved 2 sets');
  now = await sets();
  assert.deepEqual([now.t.box, now.t.room, now.r.room, now.r.box, now.o.state, Object.keys(now).length], ['9', 'Living room', 'Den', '7', 'built', 6], 'moved to another room with no box named, it stays in its box');
  // Opened again, the link has nothing left to do; and an old link no longer matches where the sets are, but it was
  // opened before, so its moves aren't ticked: one tap would have put them all back.
  await p.goto('about:blank');
  await p.goto(just);
  await p.waitForSelector('#rv-add');
  assert.deepEqual([(await rows()).map(r => [r[0], r[2]]), await p.isDisabled('#rv-add')], [[[false, 'You already have this one (Living room › Bookcase · Box 9)'], [false, 'Change it: Taken apart (now Built)'], [false, 'You already have this one (Den · Box 7)']], true]);
  await p.click('#rv li:nth-child(2) input');
  await p.click('#rv-add');
  assert.deepEqual([await says(), (await sets()).o.state], ['Changed 1 set', 'apart']);
  await p.click('.toast button');
  assert.deepEqual([await says(), (await sets()).o.state], ['Put that set back as it was', 'built']);
  await c.close();
}

// On an iPhone or iPad, Brickyard opened from the home screen keeps its own sets, apart from the browser's, and a link
// tapped in another app opens in the browser: the sets added from it never reached the Brickyard on the home screen.
// From the home screen (navigator.standalone), Add from photos puts the paste box first with a Paste button, and
// says to copy the link and paste it. In the browser there, with no sets yet, the review says where the sets may be
// and copies the link to take across. Anywhere else, both are as they were.
{
  const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
  const batch = { brickyard: 1, batch: { name: 'Hall shelf', sets: [{ num: '21318', name: 'Tree House' }, { num: '10311', name: 'Orchid' }] } };
  const hash = '#b1z' + deflateRawSync(JSON.stringify(batch)).toString('base64url');
  const phone = async (more = {}) => {
    const c = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, serviceWorkers: 'block', userAgent: UA, ...more });
    await c.route('https://cdn.rebrickable.com/**', r => r.fulfill({ status: 404 }));
    // "?app" in the address stands for having been opened from the home screen.
    await c.addInitScript(() => { if (location.search === '?app') Object.defineProperty(Navigator.prototype, 'standalone', { get: () => true }); });
    const p = await c.newPage();
    p.on('pageerror', e => problems.push(e.message));
    return { c, p };
  };
  const sheet = p => p.evaluate(() => {
    const how = document.querySelector('.sheet .how'), box = document.getElementById('paste');
    return [!!(box.compareDocumentPosition(how) & Node.DOCUMENT_POSITION_FOLLOWING), !!document.getElementById('p-paste'), how.querySelector('li:nth-child(3)').textContent];
  });
  const says = async p => { await p.waitForFunction(() => document.querySelector('.toast') && !document.querySelector('.toast').hidden); return p.textContent('.toast span'); };
  // From the home screen: the box first, Paste, and the third step says to paste.
  const app = await phone({ permissions: ['clipboard-read', 'clipboard-write'] });
  await app.p.goto(base + '?app#catalog');
  await app.p.click('.empty [data-act="claude"]');
  assert.deepEqual(await sheet(app.p), [true, true, 'Claude sends back a Brickyard link. Copy the link and paste it here: a link tapped in another app opens in your browser, which keeps its own sets.'], 'Add from photos, from the home screen');
  assert.ok((await app.p.locator('#p-paste').boundingBox()).height >= 44, 'Paste is a finger tall');
  // Paste with nothing copied says so; with Claude's message copied, one tap opens the review.
  await app.p.evaluate(() => navigator.clipboard.writeText(' '));
  await app.p.click('#p-paste');
  assert.equal(await says(app.p), 'Nothing is copied yet. Copy Claude’s link first.');
  await app.p.evaluate(t => navigator.clipboard.writeText(t), 'Here it is: https://brickyard.junkdrawer.works/' + hash + ' Open it and tap Add.');
  await app.p.click('#p-paste');
  await app.p.waitForSelector('#rv-add');
  assert.deepEqual([await app.p.locator('#rv li').count(), await app.p.locator('#rv-app').count()], [2, 0], 'Paste opens the review, with no line about the home screen: this is it');
  await app.p.click('#rv-add');
  assert.equal(await app.p.evaluate(() => Object.values(window.brickyard.doc().sets).length), 2, 'and the sets are added here');
  await app.c.close();
  // A browser that won't hand over what was copied leaves the box ready for a paste by hand.
  const shut = await phone();
  await shut.p.goto(base + '?app#catalog');
  await shut.p.click('.empty [data-act="claude"]');
  await shut.p.click('#p-paste');
  assert.deepEqual([await says(shut.p), await shut.p.evaluate(() => document.activeElement.id)], ['Hold your finger on the box and tap Paste, then Open.', 'paste']);
  await shut.c.close();
  // In the browser on the same phone: Add from photos is as it was, and a link opened with no sets here says where
  // they may be, and copies the link to paste in there.
  const web = await phone({ permissions: ['clipboard-read', 'clipboard-write'] });
  await web.p.goto(base + '#catalog');
  await web.p.click('.empty [data-act="claude"]');
  assert.deepEqual(await sheet(web.p), [false, false, 'Claude sends back a Brickyard link. Open it, check the list, and tap Add.'], 'Add from photos, in the browser');
  await web.p.goto('about:blank');
  await web.p.goto(base + hash);
  await web.p.waitForSelector('#rv-add');
  assert.equal(await web.p.textContent('#rv-app'), 'Are your sets in the Brickyard on your home screen? This is your browser, which keeps its own sets. Copy the link and paste it into Add from photos there. Copy the link');
  assert.ok((await web.p.locator('#rv-copy').boundingBox()).height >= 44, 'Copy the link is a finger tall');
  await web.p.click('#rv-copy');
  assert.deepEqual([await says(web.p), await web.p.evaluate(() => navigator.clipboard.readText())], ['Copied. Open Brickyard from your home screen, then Add from photos and Paste.', 'https://brickyard.junkdrawer.works/' + hash]);
  // With sets here already this is where they are, and it says nothing; nor does any other kind of device.
  await web.p.click('#rv-add');
  await web.p.goto('about:blank');
  await web.p.goto(base + hash);
  await web.p.waitForSelector('#rv-add');
  assert.equal(await web.p.locator('#rv-app').count(), 0, 'no line once there are sets in this browser');
  await web.c.close();
  const other = await withSets({ sets: {} });
  await other.p.goto(base + hash);
  await other.p.waitForSelector('#rv-add');
  assert.equal(await other.p.locator('#rv-app').count(), 0, 'and none on a device that isn’t an iPhone or iPad');
  await other.p.click('[data-close]');
  await other.p.waitForFunction(() => !document.querySelector('.scrim'));
  await other.p.click('.empty [data-act="claude"]');
  assert.deepEqual((await sheet(other.p)).slice(0, 2), [false, false], 'where Add from photos is as it was');
  await other.c.close();
}

// Copy everything as a link warns when the link is long enough to be cut off on the way (over 8,000 characters).
{
  const few = { a: { id: 'a', t: 1, num: '10698-1', name: 'Large Creative Brick Box' } }, lots = {};
  for (let i = 0; i < 400; i++) lots['s' + i] = { id: 's' + i, t: 1 + i, num: (20000 + i * 7) + '-1', name: 'Set ' + (i * 7919 % 1000) + ' of the ' + ['harbour', 'castle', 'garage', 'forest'][i % 4], room: 'Room ' + (i % 9) };
  for (const [sets, says] of [[few, 'Copied. Open the link on your other device.'], [lots, 'Copied. It’s a long link; if it won’t open, use Download a backup instead.']]) {
    const { c, p } = await withSets({ sets }, { permissions: ['clipboard-read', 'clipboard-write'] });
    await p.goto(base + '#catalog');
    await p.click('#menu-btn');
    await p.click('#m-link');
    await p.waitForFunction(() => document.querySelector('.toast') && !document.querySelector('.toast').hidden);
    const copied = await p.evaluate(() => navigator.clipboard.readText());
    assert.deepEqual([await p.textContent('.toast'), copied.length > 8000], [says, sets === lots], 'what Copy everything as a link says for a link of ' + copied.length + ' characters');
    // The link is the checked kind, and it opens: on another device it offers the catalog to merge in.
    assert.match(copied, /^https:\/\/brickyard\.junkdrawer\.works\/#b2z[A-Za-z0-9_-]+$/, 'Copy everything as a link writes a checked link');
    assert.equal(copied.slice(copied.indexOf('#')), checked('b2z', copied.slice(copied.indexOf('#') + 4, -7)), 'with the check on its end');
    if (sets === few) {
      const other = await withSets({ sets: {} });
      await other.p.goto(base + copied.slice(copied.indexOf('#')));
      await other.p.waitForSelector('.sheet');
      assert.deepEqual([await other.p.textContent('#sheetTitle'), /This link has 1 set\b/.test(await other.p.textContent('.sheet .lede'))], ['Your catalog from a link', true], 'and the link opens on another device');
      await other.c.close();
    }
    await c.close();
  }
}

// Back with a sheet open closes the sheet and stays on the screen, where it was scrolled to (it used to leave My sets
// for the home screen). Back again goes on back. A sheet closed by its own buttons leaves nothing in the way.
{
  const many = { k: { id: 'k', t: 1, num: '21318-1', name: 'Kept apart', state: 'apart' } };
  for (let i = 0; i < 30; i++) many['s' + i] = { id: 's' + i, t: 1, name: 'Set ' + String(i).padStart(2, '0'), room: 'Office', state: 'built', size: { w: 10, d: 10, h: 10 } };
  const { c, p } = await withSets({ sets: many, cases: { b: { id: 'b', t: 1, name: 'Billy', w: 76, d: 26, levels: [{ h: 32, sets: [{ id: 's0' }] }] } } });
  const at = () => p.evaluate(() => [location.hash, document.querySelectorAll('.scrim').length, document.body.style.overflow,
    ['home', 'catalog', 'build', 'shelves'].filter(id => !document.getElementById(id).hidden).join(), !!(history.state && history.state.sheet)]);
  // Back, as the browser's button does it. The page has to have caught up before the next step.
  const back = async () => { await p.goBack(); await p.waitForTimeout(150); };
  const settled = () => p.waitForFunction(() => !(history.state && history.state.sheet) && !document.querySelector('.scrim'));
  await p.click('#go-catalog');
  await p.waitForSelector('.item');
  await p.evaluate(() => window.scrollTo(0, 900));
  await p.click('.item:has-text("Set 14")');
  await p.waitForSelector('.sheet');
  await back();
  assert.deepEqual(await at(), ['#catalog', 0, '', 'catalog', false], 'Back from a set’s sheet: still My sets, no sheet, and the page scrolls again');
  assert.equal(await p.evaluate(() => Math.round(window.scrollY)), 900, 'and where it was scrolled to');
  assert.equal(await p.evaluate(() => document.getElementById('catalog').inert), false);
  await back();
  assert.deepEqual(await at(), ['', 0, '', 'home', false], 'Back again goes home');
  // Closed by Close, by a tap outside or by Save, the sheet is gone from history too: one Back leaves My sets.
  for (const how of ['Close', 'a tap outside', 'Save']) {
    await p.click('#go-catalog');
    await p.click('.item:has-text("Set 02")');
    if (how === 'Close') await p.click('[data-close]');
    else if (how === 'a tap outside') await p.mouse.click(195, 12);
    else { await p.fill('#e-notes', 'saved by ' + how); await p.click('#e-save'); }
    await settled();
    assert.deepEqual(await at(), ['#catalog', 0, '', 'catalog', false], how + ' closes the sheet and stays');
    await back();
    assert.deepEqual(await at(), ['', 0, '', 'home', false], 'after ' + how + ', one Back goes home');
  }
  // One sheet opened from another (the menu, then Add from photos) is one step: Back closes it and stays.
  await p.click('#go-catalog');
  await p.click('#menu-btn');
  await p.click('#m-claude');
  assert.match(await p.textContent('#sheetTitle'), /Add from photos/);
  await back();
  assert.deepEqual(await at(), ['#catalog', 0, '', 'catalog', false], 'the menu then Add from photos, then Back: no sheet, same screen');
  await back();
  assert.deepEqual(await at(), ['', 0, '', 'home', false]);
  // A reload with a sheet open (or a phone bringing the tab back) leaves no step that does nothing: one Back goes home.
  await p.click('#go-catalog');
  await p.click('#menu-btn');
  assert.equal((await at())[4], true);
  await p.reload();
  await p.waitForSelector('.item');
  await settled();
  await back();
  assert.deepEqual(await at(), ['', 0, '', 'home', false], 'after a reload with a sheet open, one Back goes home');
  // A link from Claude taking over the tab while a sheet is open: its sheet opens, and once added, one Back goes home.
  await p.click('#go-catalog');
  await p.click('#menu-btn');
  await p.evaluate(h => { location.hash = h; }, '#b1z' + deflateRawSync(JSON.stringify({ brickyard: 1, batch: { sets: [{ num: '10497', name: 'Galaxy Explorer' }] } })).toString('base64url'));
  await p.waitForSelector('#rv-add');
  await p.click('#rv-add');
  await settled();
  assert.deepEqual(await at(), ['#catalog', 0, '', 'catalog', false]);
  await back();
  assert.deepEqual(await at(), ['#catalog', 0, '', 'catalog', false], 'Back steps over where the menu was');
  await back();
  assert.deepEqual(await at(), ['', 0, '', 'home', false], 'and then home');
  // With changes in the sheet, Back asks first, like Close. Going on typing gives Back the sheet to ask about again;
  // a second Back in a row leaves the screen, and the changes with it.
  await p.click('#go-catalog');
  await p.click('.item:has-text("Set 03")');
  await p.fill('#e-missing', 'a grey 1×2 plate');
  await back();
  assert.deepEqual([await at(), await p.textContent('[data-close]'), await p.inputValue('#e-missing')], [['#catalog', 1, 'hidden', 'catalog', false], 'Discard changes?', 'a grey 1×2 plate'], 'Back with something typed keeps the sheet and asks');
  await p.locator('#e-missing').pressSequentially(', and a tile');
  assert.deepEqual([await at(), await p.textContent('[data-close]')], [['#catalog', 1, 'hidden', 'catalog', true], 'Close'], 'typing on puts Close back, and the sheet back in Back’s way');
  await back();
  assert.deepEqual([await at(), await p.textContent('[data-close]'), await p.inputValue('#e-missing')], [['#catalog', 1, 'hidden', 'catalog', false], 'Discard changes?', 'a grey 1×2 plate, and a tile'], 'so Back asks again');
  await p.waitForTimeout(700);
  await p.click('[data-close]');
  assert.deepEqual(await at(), ['#catalog', 0, '', 'catalog', false], 'Discard changes? closes it, still on My sets');
  assert.equal(await p.evaluate(() => window.brickyard.doc().sets.s3.missing), undefined);
  await back();
  assert.deepEqual(await at(), ['', 0, '', 'home', false], 'and one Back from there goes home');
  await p.click('#go-catalog');
  await p.click('.item:has-text("Set 03")');
  await p.fill('#e-missing', 'a grey 1×2 plate');
  await back();
  await back();
  assert.deepEqual(await at(), ['', 0, '', 'home', false], 'Back twice in a row with something typed: home, the sheet gone');
  assert.equal(await p.evaluate(() => window.brickyard.doc().sets.s3.missing), undefined);
  await p.click('#go-catalog');
  await p.click('.item:has-text("Set 03")');
  await p.fill('#e-missing', 'a grey 1×2 plate');
  await back();
  await p.click('#e-save');
  await settled();
  assert.deepEqual([await at(), await p.evaluate(() => window.brickyard.doc().sets.s3.missing)], [['#catalog', 0, '', 'catalog', false], 'a grey 1×2 plate'], 'Save after Back asked still saves, and stays');
  await back();
  assert.deepEqual(await at(), ['', 0, '', 'home', false]);
  // The shelf planner: Back closes a set's sheet and stays; See in My sets opens the set there; Back closes that and
  // stays on My sets, and Back again is the planner.
  await p.click('#go-shelves');
  await p.click('.sv-set');
  await p.waitForSelector('#z-cat');
  await back();
  assert.deepEqual(await at(), ['#shelves', 0, '', 'shelves', false], 'Back from a set’s sheet in the shelf planner stays there');
  await p.click('.sv-set');
  await p.click('#z-cat');
  await p.waitForSelector('#e-save');
  assert.deepEqual([await at(), await p.textContent('#sheetTitle')], [['#catalog', 1, 'hidden', 'catalog', true], 'Set 00'], 'See in My sets opens the set in My sets');
  await back();
  assert.deepEqual(await at(), ['#catalog', 0, '', 'catalog', false], 'Back closes the set and stays on My sets');
  await back();
  assert.deepEqual(await at(), ['#shelves', 0, '', 'shelves', false], 'and Back from there is the shelf planner, without the sheet');
  // A sizes link pasted into Add from photos goes on to the shelf planner's Add sizes: Back closes that and stays there.
  await p.goto(base + '#catalog');
  await p.click('#claude-btn');
  await p.fill('#paste', base + '#z1z' + deflateRawSync(JSON.stringify({ brickyard: 1, sizes: [{ num: '21318', w: 30, d: 20, h: 39 }] })).toString('base64url'));
  await p.click('#p-go');
  await p.waitForSelector('#zr-go');
  await p.waitForFunction(() => !document.getElementById('shelves').hidden);
  assert.deepEqual(await at(), ['#shelves', 1, 'hidden', 'shelves', true]);
  await back();
  assert.deepEqual(await at(), ['#shelves', 0, '', 'shelves', false], 'Back from Add sizes stays on the shelf planner');
  await back();
  assert.deepEqual(await at(), ['#catalog', 0, '', 'catalog', false], 'and Back again is My sets, with Add from photos closed');
  // A model: Back closes its menu and stays on the model; a model opened by pasting, and one removed, land where they should.
  await p.goto(base + '#model-x-cottage');
  await p.waitForSelector('#model-view:not([hidden])');
  await p.click('#model-menu');
  await p.click('#mm-parts');
  assert.match(await p.textContent('#sheetTitle'), /All the pieces/);
  await back();
  assert.deepEqual([await at(), await p.isVisible('#model-view')], [['#model-x-cottage', 0, '', 'build', false], true], 'Back from a model’s menu stays on the model');
  await p.goto(base + '#build');
  await p.click('#open-model');
  const wall = { brickyard: 1, model: { name: 'Wall', parts: Array.from({ length: 4 }, (_, i) => ['3001', 4, 0, i * 3, 0, 0, i + 1]) } };
  await p.fill('#model-paste', JSON.stringify(wall));
  await p.click('#model-go');
  await p.waitForFunction(() => location.hash.startsWith('#model-m') && !document.getElementById('model-view').hidden);
  assert.deepEqual((await at()).slice(1), [0, '', 'build', false], 'a pasted model opens, with the sheet gone');
  await p.click('#model-menu');
  await p.click('#mm-del');
  await p.waitForTimeout(700);
  await p.click('#mm-del');
  await p.waitForSelector('#build-list:not([hidden]) .list');
  assert.deepEqual(await at(), ['#build', 0, '', 'build', false], 'a removed model lands on the list of models');
  await back();
  assert.deepEqual([await at(), await p.isVisible('#build-list'), await p.locator('.toast:not([hidden])', { hasText: 'isn’t saved on this device' }).count()], [['#build', 0, '', 'build', false], true, 0], 'and Back doesn’t come back to the model that’s gone');
  // The address of a model that isn't kept here goes to the list, in its place in history: Back doesn't bounce off it.
  await p.goto(base + '#catalog');
  await p.evaluate(() => { location.hash = '#model-mgone'; });
  await p.waitForSelector('#build-list:not([hidden]) .list');
  assert.deepEqual([await at(), await p.textContent('.toast')], [['#build', 0, '', 'build', false], 'That model isn’t saved on this device. Open Claude’s link to it here.']);
  await back();
  assert.deepEqual(await at(), ['#catalog', 0, '', 'catalog', false], 'Back from the list is My sets, not the missing model again');
  // Loose pieces pasted in My sets land on Build from your box once added.
  await p.goto(base + '#catalog');
  await p.click('#claude-btn');
  await p.fill('#paste', JSON.stringify({ brickyard: 1, loose: { id: 'tub', name: 'Blue tub', parts: [['3001', 4, 40]] } }));
  await p.click('#p-go');
  await p.click('#ls-add');
  await p.waitForSelector('li.lot');
  assert.deepEqual(await at(), ['#build', 0, '', 'build', false], 'adding loose pieces lands on Build from your box');
  await back();
  assert.deepEqual(await at(), ['#catalog', 0, '', 'catalog', false], 'and Back from there is My sets, with no sheet left over');
  await c.close();
}

// A long list keeps its place when a sheet closes. The first sheet closed after arriving on a screen threw My sets
// (and the Shelf planner) back to the top: closing goes back over the sheet's place in history, and the browser put
// the page where it had it for the place before. Scrolled by real touch drags, as a thumb does it. A reload in the
// middle of the list still comes back to the same place.
{
  const many = {}, shelf = n => ({ h: 32, sets: [0, 1, 2].map(i => ({ id: 's' + (n * 3 + i) })) });
  for (let i = 0; i < 150; i++) many['s' + i] = { id: 's' + i, t: 1, name: 'Set ' + String(i).padStart(3, '0'), room: 'Office', state: 'built', size: { w: 10, d: 10, h: 10 } };
  const cases = {};
  for (let k = 0; k < 3; k++) cases['k' + k] = { id: 'k' + k, t: 1, name: 'Billy ' + (k + 1), w: 76, d: 26, levels: [0, 1, 2, 3, 4].map(l => shelf(k * 5 + l)) };
  const { c, p } = await withSets({ sets: many, cases });
  const cdp = await c.newCDPSession(p);
  const y = () => p.evaluate(() => Math.round(window.scrollY));
  // Drags the page up n times, and waits for it to come to rest.
  const drag = async n => {
    for (let i = 0; i < n; i++) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 200, y: 650 }] });
      for (let at = 650; at >= 150; at -= 50) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 200, y: at }] });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await p.waitForTimeout(150);
    }
    for (let was = -1, now = await y(); now !== was; was = now, now = await y()) await p.waitForTimeout(250);
  };
  // Taps whatever matches `sel` and is in the middle of the screen, clear of the bars.
  const tapOne = async sel => {
    const at = await p.evaluate(sel => {
      const el = [...document.querySelectorAll(sel)].find(e => { const r = e.getBoundingClientRect(); return r.top > 220 && r.bottom < 620; }), r = el.getBoundingClientRect();
      return [r.left + r.width / 2, r.top + r.height / 2];
    }, sel);
    await p.touchscreen.tap(at[0], at[1]);
    await p.waitForSelector('.sheet');
  };
  const closed = () => p.waitForFunction(() => !(history.state && history.state.sheet) && !document.querySelector('.scrim'));
  // Brickyard opened afresh each time: it's the first sheet after arriving that jumped.
  const arrive = async go => { await p.goto('about:blank'); await p.goto(base); await p.tap(go); };
  for (const how of ['Close', 'Save', 'Back', 'a tap outside']) {
    await arrive('#go-catalog');
    await p.waitForSelector('#list-wrap .item');
    await drag(2);
    const was = await y();
    assert.ok(was > 2000, 'the drags moved My sets a long way down (' + was + ')');
    await tapOne('#list-wrap .item');
    if (how === 'Close') await p.tap('.sheet [data-close]');
    else if (how === 'Save') { await p.fill('#e-notes', 'saved'); await p.tap('#e-save'); }
    else if (how === 'Back') await p.goBack();
    else await p.touchscreen.tap(195, 12);
    await closed();
    await p.waitForTimeout(400);
    assert.ok(Math.abs(await y() - was) <= 2, 'the first sheet in My sets closed by ' + how + ' leaves the list where it was: ' + was + ', now ' + await y());
  }
  await arrive('#go-shelves');
  await p.waitForSelector('.sv-set');
  await drag(1);
  let was = await y();
  assert.ok(was > 800, 'the drags moved the planner down (' + was + ')');
  await tapOne('.sv-set');
  await p.tap('.sheet [data-close]');
  await closed();
  await p.waitForTimeout(400);
  assert.ok(Math.abs(await y() - was) <= 2, 'a set’s sheet in the Shelf planner closes with the bookcases where they were: ' + was + ', now ' + await y());
  // A reload keeps the place too, on each screen (the browser did this itself until Brickyard took the job over).
  await p.reload();
  await p.waitForSelector('.sv-set');
  await p.waitForTimeout(400);
  assert.ok(Math.abs(await y() - was) <= 2, 'a reload of the Shelf planner comes back to the same place: ' + was + ', now ' + await y());
  await p.tap('#shelves .back');
  await p.tap('#go-catalog');
  assert.equal(await y(), 0, 'a move to another screen still starts at its top');
  await drag(3);
  was = await y();
  await p.reload();
  await p.waitForSelector('#list-wrap .item');
  await p.waitForTimeout(400);
  assert.ok(Math.abs(await y() - was) <= 2, 'and a reload of My sets: ' + was + ', now ' + await y());
  // Opened afresh (a link, a bookmark), it starts at the top, whatever the tab remembers.
  await p.goto('about:blank');
  await p.goto(base + '#catalog');
  await p.waitForSelector('#list-wrap .item');
  await p.waitForTimeout(300);
  assert.equal(await y(), 0, 'opened afresh, My sets starts at the top');
  await c.close();
}
// The preview copy (in a frame, with no sets) moves to My sets and opens its example batch, which stays open.
{
  const c = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  await c.route('https://cdn.rebrickable.com/**', r => r.fulfill({ status: 404 }));
  const example = { brickyard: 1, batch: JSON.parse(await readFile(join(root, 'test/fixtures/sample.json'), 'utf8')) };
  await c.addInitScript(b => { if (window.top !== window) window.BRICKYARD_EXAMPLE = b; }, example);
  const p = await c.newPage();
  p.on('pageerror', e => problems.push(e.message));
  await p.setContent(`<iframe src="${base}" style="width:390px;height:800px"></iframe>`);
  const f = await (await p.waitForSelector('iframe')).contentFrame();
  await f.waitForSelector('#rv-add');
  await f.waitForTimeout(600);
  assert.deepEqual([await f.evaluate(() => location.hash), await f.locator('#rv-add').count()], ['#catalog', 1], 'the example’s sheet stays open on My sets');
  assert.equal(await f.evaluate(() => history.state), null, 'and the preview leaves the history it shares with the page around it alone');
  await f.click('[data-close]');
  assert.deepEqual([await f.evaluate(() => location.hash), await f.locator('.scrim').count()], ['#catalog', 0], 'its sheet closes, still on My sets');
  await c.close();
}

// A set's picture shows whole, inside its box: in the list, in a batch from Claude and at the top of the set's sheet,
// on a phone and on a wide screen. Rebrickable's two sizes are stood in for by pictures of the same shapes.
{
  const { c, p } = await withSets({ sets: { t: { id: 't', t: 1, num: '21318-1', name: 'Tree House' } } });
  const pic = (w, h) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="${w}" height="${h}" fill="#2f8a4e"/></svg>`;
  await c.route('https://cdn.rebrickable.com/**', r => r.fulfill({ contentType: 'image/svg+xml', body: /1000x800p/.test(r.request().url()) ? pic(1000, 800) : pic(250, 250) }));
  const whole = async (sel, what) => {
    await p.waitForFunction(s => { const i = document.querySelector(s + ' img'); return i && i.complete && i.naturalWidth > 0; }, sel);
    const [img, box] = await p.evaluate(s => {
      const r = e => { const b = e.getBoundingClientRect(); return [b.left, b.top, b.right, b.bottom].map(Math.round); };
      const el = document.querySelector(s);
      return [r(el.querySelector('img')), r(el)];
    }, sel);
    assert.ok(img[0] >= box[0] && img[1] >= box[1] && img[2] <= box[2] && img[3] <= box[3], what + ': the picture ' + img + ' is inside its box ' + box);
  };
  for (const [width, height] of [[390, 844], [1280, 800]]) {
    await p.setViewportSize({ width, height });
    await p.goto(base + '#catalog');
    await whole('.item .pic', 'the list at ' + width);
    await p.click('.item:has-text("Tree House")');
    await whole('.sheet .head-pic', 'the set’s sheet at ' + width);
    await p.click('[data-close]');
    await p.goto(base + '#b1z' + deflateRawSync(JSON.stringify({ brickyard: 1, batch: { sets: [{ num: '10281', name: 'Bonsai Tree' }] } })).toString('base64url'));
    await whole('.rv .pic', 'a batch from Claude at ' + width);
    await p.click('[data-close]');
  }
  await c.close();
}

// A message at the bottom uses the screen's width (it was squeezed into half of it, four lines tall), stays centred,
// and can carry a button. A plain one left showing goes when a sheet opens. One that stays (a held warning, or one
// with Undo) is kept, clear of the sheet: the case after this one.
{
  const { c, p } = await withSets({ sets: { t: { id: 't', t: 1, num: '21318-1', name: 'Tree House', room: 'Living room', spot: 'Bookcase' } } });
  const box = () => p.locator('.toast').boundingBox();
  await p.goto(base + '#catalog');
  await p.click('#add-btn');
  await p.fill('#e-num', '21318');
  await p.click('#e-save');
  assert.equal(await p.textContent('.toast'), 'You already have Tree House (Living room › Bookcase). Tap again to add a second copy.');
  let b = await box();
  assert.ok(b.width > 300, 'a long message is wider than 300 px on a phone (' + Math.round(b.width) + ')');
  assert.ok(b.x >= 16 && b.x + b.width <= 390 - 16 + 0.5 && Math.abs(b.x + b.width / 2 - 195) < 1, 'and sits centred with a margin each side');
  await p.evaluate(() => window.brickyard.toast('Saved'));
  b = await box();
  assert.ok(b.width < 120 && Math.abs(b.x + b.width / 2 - 195) < 1, 'a short one stays small and centred (' + Math.round(b.width) + ')');
  await discard(p);
  await p.evaluate(() => { window.undone = 0; window.brickyard.toast('Removed Tree House', false, { label: 'Undo', run: () => { window.undone++; } }); });
  assert.equal(await p.textContent('.toast button'), 'Undo');
  await p.click('.toast button');
  assert.deepEqual([await p.evaluate(() => window.undone), await p.locator('.toast').isHidden()], [1, true], 'its button runs once and the message goes');
  // A plain message the page really makes. (This was tried with a made-up "Added 7 sets"; the page's own has Undo.)
  await p.click('.item:has-text("Tree House")');
  await p.click('#e-save');
  await p.waitForFunction(() => !document.querySelector('.scrim'));
  assert.equal(await p.textContent('.toast'), 'Saved');
  assert.equal(await p.locator('.toast button').count(), 0, 'the next message has no button left in it');
  await p.click('#menu-btn');
  assert.equal(await p.locator('.toast').isHidden(), true, 'a plain message left showing goes when a sheet opens');
  await p.click('[data-close]');
  await p.evaluate(() => window.brickyard.toast('This browser wouldn’t save.', true));
  await p.click('#menu-btn');
  assert.equal(await p.locator('.toast').isVisible(), true, 'a held warning stays');
  await c.close();
}

// A message never sits on an open sheet. One with Undo stays 10 seconds and is kept when a sheet opens, and at the
// bottom of a phone's screen that put it over the sheet's own controls: after Fit, a tap on Move right in a set's
// sheet pressed Undo and took every set off again; after adding sets from a link, "Added 7 sets" covered the Missing
// pieces box of the next set. While a sheet is open on a phone every message shows at the top of the screen, above the
// sheet, which gives way when the message needs more room than it leaves; on a wide screen, where the sheet is in
// the middle, the message goes below it.
{
  const example = { brickyard: 1, batch: JSON.parse(await readFile(join(root, 'test/fixtures/sample.json'), 'utf8')) };
  const link = '#b1z' + deflateRawSync(JSON.stringify(example)).toString('base64url');
  const LONG = 'Removed The Lord of the Rings: Barad-dûr and its sets are back in Not on a shelf yet. 3 sets no longer say Hall Billy in My sets.';
  // Where the message and the sheet are, and what a tap in the middle of each of the sheet's controls would land on.
  const look = p => p.evaluate(() => {
    const box = el => { const r = el.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right) }; };
    const t = document.querySelector('.toast'), sheet = document.querySelector('.sheet'), under = [];
    if (sheet) sheet.querySelectorAll('button, input, select, textarea, a').forEach(el => {
      const r = el.getBoundingClientRect(), b = sheet.querySelector('.bd').getBoundingClientRect();
      if (!r.width || el.disabled || (el.closest('.bd') && (r.bottom < b.top + 4 || r.top > b.bottom - 4))) return; // scrolled out of the sheet
      const hit = document.elementFromPoint(r.left + r.width / 2, Math.min(Math.max(r.top + r.height / 2, 1), innerHeight - 1));
      if (hit && hit.closest('.toast')) under.push(el.id || el.textContent.trim());
    });
    return { says: t.hidden ? null : t.querySelector('span').textContent, toast: t.hidden ? null : box(t), sheet: sheet && box(sheet), close: sheet && box(sheet.querySelector('[data-close]')), under, h: innerHeight, w: innerWidth };
  });
  // The message is wholly above the sheet (or, on a wide screen, wholly below it), on the screen, and over none of
  // the sheet's controls; the sheet's heading and Close are on the screen too.
  const clear = async (p, what, below) => {
    await p.waitForFunction(() => !document.getAnimations().length); // the sheet has come up
    const l = await look(p);
    assert.ok(l.toast && l.sheet, what + ': a message and a sheet are showing');
    assert.ok(below ? l.toast.top >= l.sheet.bottom : l.toast.bottom <= l.sheet.top, what + ': the message is ' + (below ? 'below' : 'above') + ' the sheet ' + JSON.stringify([l.toast, l.sheet]));
    assert.ok(l.toast.top >= 0 && l.toast.bottom <= l.h && l.toast.left >= 0 && l.toast.right <= l.w, what + ': and on the screen ' + JSON.stringify(l.toast));
    assert.deepEqual(l.under, [], what + ': no control of the sheet is under it');
    assert.ok(l.close.top >= (below ? 0 : l.toast.bottom) && l.close.bottom <= l.h, what + ': the sheet’s Close is on the screen');
    return l;
  };
  for (const size of [{ width: 390, height: 844 }, { width: 390, height: 664 }, { width: 320, height: 568 }, { width: 1280, height: 800 }]) {
    const wide = size.width >= 700, at = size.width + '×' + size.height;
    const { c, p } = await withSets({ sets: { o: { id: 'o', t: 1, num: '10311-1', name: 'Orchid', state: 'built' } } }, wide ? { viewport: size, hasTouch: false, deviceScaleFactor: 1 } : { viewport: size });
    await p.goto(base + link);
    await p.click('#rv-add');
    await p.waitForFunction(() => !document.querySelector('.scrim'));
    let l = await look(p);
    assert.equal(l.says, 'Added 7 sets. 1 to check.');
    assert.ok(l.toast.top > l.h / 2, at + ': with no sheet open the message is at the bottom of the screen');
    // The set marked Check, straight after: its sheet is the tallest there is.
    await p.click('.item:has-text("Lamborghini")');
    l = await clear(p, at + ', “Added 7 sets” over the next set’s sheet', wide);
    assert.equal(l.says, 'Added 7 sets. 1 to check.', 'the message with Undo is still there');
    // A message raised while the sheet is open goes to the same place.
    await p.click('#e-ok');
    l = await clear(p, at + ', “Marked as right”', wide);
    assert.equal(l.says, 'Marked as right');
    // Two or three lines of it, with a button.
    await p.evaluate(t => window.brickyard.toast(t, false, { label: 'Undo', run() {} }), LONG);
    l = await clear(p, at + ', a long message with Undo', wide);
    if (!wide) assert.ok(l.toast.bottom - l.toast.top > 60, 'which takes more than one line (' + (l.toast.bottom - l.toast.top) + ' px)');
    // The sheet gets its height back when the message goes, and the next message after it closes is at the bottom.
    const tall = l.sheet.bottom - l.sheet.top;
    await p.evaluate(() => document.querySelector('.toast span').click());
    assert.ok((await look(p)).sheet.bottom - (await look(p)).sheet.top >= tall, 'the sheet is no shorter once the message has gone');
    await p.click('.sheet [data-close]');
    await p.waitForFunction(() => !document.querySelector('.scrim'));
    await p.evaluate(t => window.brickyard.toast(t, false, { label: 'Undo', run() {} }), LONG);
    l = await look(p);
    assert.ok(l.toast.top > l.h / 2, at + ': and back at the bottom once the sheet is closed');
    // Over the menu, and a cut link's message in Add from photos, which sat on the box the link was pasted in.
    await p.click('#menu-btn');
    await clear(p, at + ', over the menu', wide);
    await p.click('#m-claude');
    await p.fill('#paste', 'https://brickyard.junkdrawer.works/#b1zAAAAA');
    await p.click('#p-go');
    await p.waitForFunction(() => /cut short/.test(document.querySelector('.toast').textContent));
    await clear(p, at + ', a cut link in Add from photos', wide);
    await c.close();
  }
}

// The same in the Shelf planner, where it did the most harm: after Fit, a set's sheet has Move left and Move right
// where the message with Undo was. A real tap on Move right moves the set, and takes nothing off.
{
  const set = (id, name, w) => ({ id, t: 1, name, state: 'built', size: { w, d: 20, h: 20 } });
  const { c, p } = await withSets({ sets: { a: set('a', 'Set A', 20), b: set('b', 'Set B', 20), d: set('d', 'Set D', 20), w: set('w', 'Too wide', 90) },
    cases: { k: { id: 'k', t: 1, name: 'Billy', w: 76, d: 26, levels: [{ h: 32, sets: [] }] } } });
  const on = () => p.evaluate(() => window.BrickCore.shelves(window.brickyard.doc()).k.levels.map(l => l.sets.map(q => q.id).join('+')).join(' / '));
  const says = () => p.evaluate(() => { const t = document.querySelector('.toast'); return t.hidden ? null : t.textContent; });
  await p.goto(base + '#shelves');
  await p.tap('[data-act="fill"]');
  assert.deepEqual([await on(), await says()], ['a+b+d', '3 sets placed; 1 didn’t fitUndo']);
  await p.tap('.sv-set[data-set="a"]');
  await p.waitForSelector('#z-right');
  // Once the sheet has come up: on its way it's 30 px lower, and its buttons are measured clear of a message that
  // would lie on them a fifth of a second later.
  await p.waitForFunction(() => !document.getAnimations().length);
  const hits = await p.evaluate(() => ['z-left', 'z-right', 'z-save', 'z-cat'].filter(id => !document.getElementById(id).disabled).map(id => {
    const r = document.getElementById(id).getBoundingClientRect(), hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return id + ':' + (hit && hit.closest('#' + id) ? 'itself' : hit && hit.closest('.toast') ? 'the message' : 'something else');
  }));
  assert.deepEqual(hits, ['z-right:itself', 'z-save:itself', 'z-cat:itself'], 'a tap in the middle of each of the sheet’s buttons lands on that button');
  const r = await p.locator('#z-right').boundingBox();
  await p.touchscreen.tap(r.x + r.width / 2, r.y + r.height / 2);
  await p.waitForFunction(() => !document.getElementById('z-left').disabled);
  assert.deepEqual([await on(), await p.locator('.sv-set').count()], ['b+a+d', 3], 'a real tap on Move right moves the set right, and every set is still on its shelf');
  await c.close();
}

// Undo pressed while a sheet is open closes the sheet first. It used to leave the sheet showing what Undo had just
// taken away: after "Added 7 sets", with one of them open, Undo emptied the list behind the sheet, and the sheet's
// Save put that one set back. A sheet with changes typed in it stays open.
{
  const example = { brickyard: 1, batch: JSON.parse(await readFile(join(root, 'test/fixtures/sample.json'), 'utf8')) };
  const link = '#b1z' + deflateRawSync(JSON.stringify(example)).toString('base64url');
  const { c, p } = await withSets({ sets: { o: { id: 'o', t: 1, num: '10311-1', name: 'Orchid', state: 'built' } } });
  const says = () => p.evaluate(() => { const t = document.querySelector('.toast'); return t.hidden ? null : t.textContent; });
  const rows = () => p.locator('#list-wrap .item').count();
  const undo = async () => { const b = await p.locator('.toast button').boundingBox(); await p.touchscreen.tap(b.x + b.width / 2, b.y + b.height / 2); };
  const add = async () => { await p.goto(base + link); await p.click('#rv-add'); await p.waitForFunction(() => !document.querySelector('.scrim') && !(history.state && history.state.sheet)); };
  await add();
  assert.deepEqual([await rows(), await says()], [8, 'Added 7 sets. 1 to check.Undo']);
  await p.click('.item:has-text("Lamborghini")');
  await p.waitForSelector('#e-save');
  await undo();
  await p.waitForFunction(() => /out again/.test(document.querySelector('.toast').textContent));
  assert.deepEqual([await rows(), await p.locator('.scrim').count(), await says(), await p.evaluate(() => !!(history.state && history.state.sheet))],
    [1, 0, 'Took those 7 sets out again', false], 'Undo with one of the new sets open: the sets are gone, and so is the sheet');
  await p.goBack();
  await p.waitForSelector('#home:not([hidden])');
  assert.equal(await p.locator('.scrim').count(), 0, 'and the sheet left no place of its own behind: Back goes home');
  // With something typed in the sheet, it stays: what's typed isn't thrown away by a tap on a message.
  await add();
  await p.click('.item:has-text("Typewriter")');
  await p.fill('#e-notes', 'on loan to Sam');
  await undo();
  await p.waitForFunction(() => /out again/.test(document.querySelector('.toast').textContent));
  assert.deepEqual([await rows(), await p.locator('.scrim').count(), await p.inputValue('#e-notes')], [1, 1, 'on loan to Sam'], 'Undo with changes typed in the open sheet leaves the sheet');
  await discard(p);
  await c.close();
}
{
  const set = (id, name, w) => ({ id, t: 1, name, state: 'built', size: { w, d: 20, h: 20 } });
  const { c, p } = await withSets({ sets: { a: set('a', 'Set A', 20), b: set('b', 'Set B', 20), d: set('d', 'Set D', 20), w: set('w', 'Too wide', 90) },
    cases: { k: { id: 'k', t: 1, name: 'Billy', w: 76, d: 26, levels: [{ h: 32, sets: [] }] } } });
  const on = () => p.evaluate(() => window.BrickCore.shelves(window.brickyard.doc()).k.levels.map(l => l.sets.map(q => q.id).join('+')).join(' / '));
  const says = () => p.evaluate(() => { const t = document.querySelector('.toast'); return t.hidden ? null : t.textContent; });
  const undo = async () => { const b = await p.locator('.toast button').boundingBox(); await p.touchscreen.tap(b.x + b.width / 2, b.y + b.height / 2); };
  await p.goto(base + '#shelves');
  await p.tap('[data-act="fill"]');
  await p.tap('.sv-set[data-set="b"]');
  await p.waitForSelector('#z-save');
  assert.match(await p.textContent('#z-where option:checked'), /Billy · shelf 1/);
  await undo();
  await p.waitForFunction(() => /off again/.test(document.querySelector('.toast').textContent));
  assert.deepEqual([await on(), await p.locator('.sv-set').count(), await p.locator('.scrim').count(), await says()], ['', 0, 0, 'Took those 3 sets off again'],
    'Undo of Fit with a set’s sheet open: every set is off, and no sheet is left saying the set is on shelf 1');
  await p.waitForFunction(() => !(history.state && history.state.sheet));
  assert.equal(await p.evaluate(() => location.hash), '#shelves');
  await c.close();
}

// Save in a sheet changes what the sheet changed, and leaves the rest as it's kept now. A sheet shows the set as it
// was when it opened, and Save used to write all of that back: with a set's sheet open in one tab, another tab (or
// a Drive sync, which hands the catalog to takeDoc) packed the set in box 7, and Save in the first tab took it out
// again without a word; a set removed elsewhere came back. Two tabs of one browser here, then takeDoc.
{
  const sets = {
    b: { id: 'b', t: 1, num: '10281-1', name: 'Bonsai Tree', year: 2021, state: 'built', room: 'Living room', spot: 'Bookcase', instr: false, added: '2026-01-05', tags: ['plants'] },
    t: { id: 't', t: 1, num: '21318-1', name: 'Tree House', state: 'built', room: 'Office', instr: true, added: '2026-01-06', check: 'could be 21338' },
    o: { id: 'o', t: 1, num: '10311-1', name: 'Orchid', state: 'built', added: '2026-01-07' },
    g: { id: 'g', t: 1, num: '10497-1', name: 'Galaxy Explorer', state: 'built', added: '2026-01-08' },
  };
  const { c, p } = await withSets({ sets });
  const q = await c.newPage(); // the other tab
  q.on('pageerror', e => problems.push(e.message));
  await p.goto(base + '#catalog');
  await q.goto(base + '#catalog');
  const kept = (pg, id) => pg.evaluate(id => { const x = Object.assign({}, window.brickyard.doc().sets[id]); delete x.t; return x; }, id);
  const says = () => p.evaluate(() => { const t = document.querySelector('.toast'); return t.hidden ? null : t.textContent; });
  const closed = pg => pg.waitForFunction(() => !document.querySelector('.scrim') && !(history.state && history.state.sheet));
  const open = async (pg, name) => { await pg.click(`.item:has-text("${name}")`); await pg.waitForSelector('#e-save'); };
  // In the other tab: open the set, do something to its sheet, save.
  const elsewhere = async (name, change) => { await open(q, name); await change(); await q.click('#e-save'); await closed(q); };
  const seen = (id, ok) => p.waitForFunction(([id, ok]) => new Function('x', 'return ' + ok)(window.brickyard.doc().sets[id]), [id, ok]);

  // The other tab packs it in box 7 and takes it out of its room; this tab adds a note.
  await open(p, 'Bonsai Tree');
  await elsewhere('Bonsai Tree', async () => { await q.fill('#e-box', '7'); await q.fill('#e-room', ''); await q.fill('#e-year', '2022'); });
  await seen('b', 'x.box === "7"');
  assert.match(await p.textContent('.item:has-text("Bonsai Tree")'), /Box 7/, 'the row behind the open sheet shows the other tab’s box');
  assert.equal(await p.inputValue('#e-box'), '', 'while the sheet still shows the set as it was');
  await p.fill('#e-notes', 'gift from Sam');
  await p.click('#e-save');
  await closed(p);
  assert.deepEqual(await kept(p, 'b'), { num: '10281-1', name: 'Bonsai Tree', year: 2022, state: 'built', spot: 'Bookcase', box: '7', instr: false, tags: ['plants'], notes: 'gift from Sam', added: '2026-01-05', id: 'b' },
    'Save adds the note and keeps the other tab’s box, year and cleared room; the day it was added and "no instructions" are kept too');
  assert.equal(await says(), 'Saved');
  // Both changed the same box: this sheet's Save is the later change. A box cleared here comes out cleared.
  await open(p, 'Tree House');
  await elsewhere('Tree House', async () => { await q.fill('#e-notes', 'from the other tab'); await q.fill('#e-box', '3'); await q.fill('#e-spot', 'Desk'); });
  await seen('t', 'x.box === "3"');
  await p.fill('#e-notes', 'from this tab');
  await p.fill('#e-room', '');
  await p.uncheck('#e-instr');
  await p.click('#e-save');
  await closed(p);
  assert.deepEqual(await kept(p, 't'), { num: '21318-1', name: 'Tree House', state: 'built', spot: 'Desk', box: '3', notes: 'from this tab', check: 'could be 21338', added: '2026-01-06', id: 't' },
    'a box changed in both keeps this sheet’s; Room cleared here is cleared, the tick taken off is off, and To check stays');
  // A size given elsewhere stays when the sheet leaves the sizes alone; change one and the size is the sheet's three.
  await open(p, 'Orchid');
  await elsewhere('Orchid', async () => { await q.fill('#e-w', '20'); await q.fill('#e-d', '18'); await q.fill('#e-h', '39'); });
  await seen('o', '!!x.size');
  await p.click('#e-state [data-v="partial"]');
  await p.click('#e-save');
  await closed(p);
  assert.deepEqual([(await kept(p, 'o')).size, (await kept(p, 'o')).state], [{ w: 20, d: 18, h: 39 }, 'partial'], 'the size from the other tab is kept, with the state changed here');
  await open(p, 'Orchid');
  await elsewhere('Orchid', async () => { await q.fill('#e-w', '25'); });
  await seen('o', 'x.size.w === 25');
  await p.fill('#e-h', '40');
  await p.click('#e-save');
  await closed(p);
  assert.deepEqual((await kept(p, 'o')).size, { w: 20, d: 18, h: 40 }, 'a size changed in the sheet is saved as the sheet shows it, all three');
  // Save with nothing changed, here or elsewhere, writes nothing: the set isn't marked as changed now.
  const when = await p.evaluate(() => window.brickyard.doc().sets.o.t);
  await open(p, 'Orchid');
  await p.click('#e-save');
  await closed(p);
  assert.deepEqual([await p.evaluate(() => window.brickyard.doc().sets.o.t), await says()], [when, 'Saved'], 'an untouched Save leaves the set’s time of change alone');

  // Removed in the other tab while its sheet is open here. Save with nothing changed: it stays removed.
  const remove = async name => { await open(q, name); await q.click('#e-del'); await q.waitForTimeout(650); await q.click('#e-del'); await closed(q); };
  await open(p, 'Orchid');
  await remove('Orchid');
  await seen('o', '!!x.del');
  await p.click('#e-save');
  await closed(p);
  assert.deepEqual([await p.locator('#list-wrap .item').count(), await p.evaluate(() => !!window.brickyard.doc().sets.o.del), await says()], [3, true, 'Orchid was removed while this was open. Nothing was saved.'],
    'a set removed elsewhere stays removed after a Save that changed nothing, and the message says why');
  // With something changed, the first Save asks; the next brings the set back as the sheet has it.
  await open(p, 'Galaxy Explorer');
  await remove('Galaxy Explorer');
  await seen('g', '!!x.del');
  await p.fill('#e-notes', 'the 2022 one');
  await p.click('#e-save');
  assert.deepEqual([await p.locator('.scrim').count(), await p.textContent('#e-save'), await says(), await p.evaluate(() => !!window.brickyard.doc().sets.g.del)],
    [1, 'Bring it back', 'This set was removed while its sheet was open. Tap again to bring it back.', true], 'a changed Save asks before bringing a removed set back');
  await p.waitForTimeout(650);
  await p.click('#e-save');
  await closed(p);
  assert.deepEqual([await kept(p, 'g'), await says()], [{ num: '10497-1', name: 'Galaxy Explorer', state: 'built', notes: 'the 2022 one', added: '2026-01-08', id: 'g' }, 'Saved, and Galaxy Explorer is back']);
  await q.waitForFunction(() => { const x = window.brickyard.doc().sets.g; return !x.del && x.notes === 'the 2022 one'; });
  assert.equal(await q.locator('#list-wrap .item').count(), 3, 'and it is back in the other tab too');
  await q.close();

  // The same when the change arrives as a whole catalog (Drive sync hands it to takeDoc).
  const sync = change => p.evaluate(change => {
    const d = JSON.parse(JSON.stringify(window.brickyard.doc()));
    new Function('sets', 't', change)(d.sets, Date.now());
    window.brickyard.takeDoc(d);
  }, change);
  await open(p, 'Bonsai Tree');
  await sync('sets.b.box = "9"; delete sets.b.spot; sets.b.room = "Hall"; sets.b.t = t;');
  await p.fill('#e-name', 'Bonsai Tree (the green one)');
  await p.click('#e-save');
  await closed(p);
  assert.deepEqual(await kept(p, 'b'), { num: '10281-1', name: 'Bonsai Tree (the green one)', year: 2022, state: 'built', room: 'Hall', box: '9', instr: false, tags: ['plants'], notes: 'gift from Sam', added: '2026-01-05', id: 'b' },
    'a sync under an open sheet: Save changes the name and keeps the sync’s box and room');
  await open(p, 'Tree House');
  await sync('sets.t = { id: "t", t: t, del: 1 };');
  await p.click('#e-save');
  await closed(p);
  assert.deepEqual([await p.evaluate(() => !!window.brickyard.doc().sets.t.del), await says()], [true, 'Tree House was removed while this was open. Nothing was saved.'], 'and a set the sync removed stays removed');
  // Undo that takes away the set whose sheet is open with changes in it leaves the sheet, and its Save asks.
  await p.goto(base + '#b1j' + Buffer.from(JSON.stringify({ brickyard: 1, batch: { sets: [{ num: '21327', name: 'Typewriter' }] } })).toString('base64url'));
  await p.click('#rv-add');
  await closed(p);
  await open(p, 'Typewriter');
  await p.fill('#e-notes', 'on loan');
  await p.click('.toast button');
  await p.waitForFunction(() => /out again/.test(document.querySelector('.toast').textContent));
  await p.click('#e-save');
  assert.deepEqual([await p.locator('.scrim').count(), await p.textContent('#e-save'), await p.locator('#list-wrap .item').count()], [1, 'Bring it back', 2], 'Save after Undo took the set away asks first');
  await discard(p);
  await c.close();
}

// The Shelf planner's sheets work the same way: on the set and the bookcase as they're kept now.
{
  const set = (id, name, w) => ({ id, t: 1, name, state: 'built', size: { w, d: 20, h: 20 } });
  const sets = { a: set('a', 'Set A', 20), b: set('b', 'Set B', 20), n: { id: 'n', t: 1, name: 'No size yet', state: 'built' } };
  const cases = { k: { id: 'k', t: 1, name: 'Billy', w: 76, d: 26, levels: [{ h: 32, sets: [{ id: 'a' }] }, { h: 32, sets: [] }] }, m: { id: 'm', t: 1, name: 'Kallax', w: 33, d: 39, levels: [{ h: 33, sets: [] }] } };
  const { c, p } = await withSets({ sets, cases });
  const q = await c.newPage();
  q.on('pageerror', e => problems.push(e.message));
  await p.goto(base + '#shelves');
  await q.goto(base + '#shelves');
  const on = pg => pg.evaluate(() => { const d = window.BrickCore.shelves(window.brickyard.doc()); return Object.keys(d).sort().map(k => d[k].del ? k + ' removed' : d[k].name + ': ' + d[k].levels.map(l => l.sets.map(s => s.id + (s.turn ? '(side-on)' : '')).join('+')).join(' / ')).join('; '); });
  const says = () => p.evaluate(() => { const t = document.querySelector('.toast'); return t.hidden ? null : t.textContent; });
  const closed = pg => pg.waitForFunction(() => !document.querySelector('.scrim') && !(history.state && history.state.sheet));
  const sameHere = async () => { const there = await on(q); await p.waitForFunction(there => { const d = window.BrickCore.shelves(window.brickyard.doc()); return Object.keys(d).sort().map(k => d[k].del ? k + ' removed' : d[k].name + ': ' + d[k].levels.map(l => l.sets.map(s => s.id + (s.turn ? '(side-on)' : '')).join('+')).join(' / ')).join('; ') === there; }, there); };
  // A bookcase's Edit sheet is open here; the other tab stands a set on that bookcase. Save keeps it there.
  await p.click('[data-case="k"]');
  await p.waitForSelector('#k-save');
  await q.click('[data-act="fill"]');
  assert.equal(await on(q), 'Billy: a+b / ; Kallax: ');
  await sameHere();
  await p.fill('#k-name', 'Hall Billy');
  await p.click('#k-save');
  await closed(p);
  assert.equal(await on(p), 'Hall Billy: a+b / ; Kallax: ', 'a set stood on the bookcase from the other tab while its Edit sheet was open is still there after Save');
  // A set's sheet is open here; the other tab moves the set to another shelf. A tick here turns it where it is now.
  await p.locator('.sv-set[data-set="b"]').click();
  await p.waitForSelector('#z-turn');
  await q.locator('.sv-set[data-set="b"]').click();
  await q.selectOption('#z-where', 'k:1');
  await q.click('#z-save');
  await closed(q);
  await sameHere();
  await p.check('#z-turn');
  await p.fill('#z-w', '21');
  await p.click('#z-save');
  await closed(p);
  assert.deepEqual([await on(p), await p.evaluate(() => window.brickyard.doc().sets.b.size)], ['Hall Billy: a / b(side-on); Kallax: ', { w: 21, d: 20, h: 20 }],
    'side-on ticked in a sheet opened before the set was moved: it turns on the shelf it stands on now, and the size typed is saved');
  // What My sets changed on the set meanwhile is kept when the planner's sheet saves a size.
  await p.locator('.sv-set[data-set="a"]').click();
  await p.waitForSelector('#z-save');
  await p.evaluate(() => { const d = JSON.parse(JSON.stringify(window.brickyard.doc())); d.sets.a.notes = 'dusted'; d.sets.a.t = Date.now(); window.brickyard.takeDoc(d); });
  await p.fill('#z-h', '22');
  await p.click('#z-save');
  await closed(p);
  assert.deepEqual(await p.evaluate(() => [window.brickyard.doc().sets.a.notes, window.brickyard.doc().sets.a.size]), ['dusted', { w: 20, d: 20, h: 22 }], 'a note added elsewhere is kept when the sheet saves a height');
  // A set removed elsewhere: an untouched Save leaves it removed; a changed one asks.
  await p.click('.item[data-set="n"]');
  await p.waitForSelector('#z-save');
  await p.evaluate(() => { const d = JSON.parse(JSON.stringify(window.brickyard.doc())); d.sets.n = { id: 'n', t: Date.now(), del: 1 }; window.brickyard.takeDoc(d); });
  await p.fill('#z-w', '10'); await p.fill('#z-d', '10'); await p.fill('#z-h', '10');
  await p.click('#z-save');
  assert.deepEqual([await p.locator('.scrim').count(), await p.textContent('#z-save'), await says()], [1, 'Bring it back', 'This set was removed while its sheet was open. Tap again to bring it back.']);
  await p.waitForTimeout(650);
  await p.click('#z-save');
  await closed(p);
  assert.deepEqual(await p.evaluate(() => { const x = window.brickyard.doc().sets.n; return [!!x.del, x.name, x.size]; }), [false, 'No size yet', { w: 10, d: 10, h: 10 }], 'the second Save brings it back with its size');
  // A bookcase removed elsewhere while its Edit sheet is open: untouched, it stays removed.
  await p.click('[data-case="m"]');
  await p.waitForSelector('#k-save');
  await q.click('[data-case="m"]');
  await q.click('#k-del'); await q.waitForTimeout(650); await q.click('#k-del');
  await closed(q);
  await sameHere();
  await p.click('#k-save');
  await closed(p);
  assert.deepEqual([await on(p), await says()], ['Hall Billy: a / b(side-on); m removed', 'Kallax was removed while this was open. Nothing was saved.'], 'Save on a bookcase removed elsewhere, with nothing changed, leaves it removed');
  // And one whose sheet was changed asks, then comes back, without a set that stands somewhere else by now.
  await p.click('[data-case="k"]');
  await p.waitForSelector('#k-save');
  await q.click('[data-case="k"]');
  await q.click('#k-del'); await q.waitForTimeout(650); await q.click('#k-del');
  await closed(q);
  await sameHere();
  await p.fill('#k-room', 'Hall');
  await p.click('#k-save');
  assert.deepEqual([await p.locator('.scrim').count(), await p.textContent('#k-save'), await says()], [1, 'Bring it back', 'This bookcase was removed while its sheet was open. Tap again to bring it back.']);
  await p.waitForTimeout(650);
  await p.click('#k-save');
  await closed(p);
  assert.equal(await on(p), 'Hall Billy: a / b(side-on); m removed', 'the second Save brings the bookcase back with its sets');
  await q.close();
  await c.close();
}

// Actions that closed their sheet without a word now say what they did. A download names its file and says where
// it went. A new bookcase is named, with Undo. A set saved in the planner says what became of it (its new shelf,
// the turn, the move along the shelf, off the shelves; "Saved" when it only kept a size), with what was read as
// inches after it. Add sizes counts its ticks the way Add sets from Claude does, and waits for one: with none
// ticked it was a live "Add sizes" beside "0 sets", and pressing it answered "Nothing added".
{
  const set = (id, name, w, more) => ({ id, t: 1, name, state: 'built', size: { w, d: 20, h: 20 }, ...more });
  const sets = { th: set('th', 'Tree House', 25, { num: '21318-1' }), a: set('a', 'Set A', 20), b: set('b', 'Set B', 20), o: { id: 'o', t: 1, num: '10311-1', name: 'Orchid', state: 'built' },
    g: { id: 'g', t: 1, num: '10497-1', name: 'Galaxy Explorer', state: 'built' }, c: set('c', 'Lion Knights’ Castle', 40, { num: '10305-1' }) };
  const cases = { k: { id: 'k', t: 1, name: 'Office Billy', w: 76, d: 26, levels: [{ h: 32, sets: [{ id: 'a' }, { id: 'th' }, { id: 'b' }] }, { h: 32, sets: [] }] } };
  const { c, p } = await withSets({ sets, cases });
  // The message's words (a file's name is kept in one piece by joiners after its dashes, taken out here) and its button.
  const says = () => p.evaluate(() => { const t = document.querySelector('.toast'); return t.hidden ? [] : [t.querySelector('span').textContent.replace(/⁠/g, ''), t.querySelector('button') ? t.querySelector('button').textContent : '']; });
  const closed = () => p.waitForFunction(() => !document.querySelector('.scrim') && !(history.state && history.state.sheet));
  const on = () => p.evaluate(() => { const d = window.BrickCore.shelves(window.brickyard.doc()); return Object.values(d).filter(k => !k.del).sort((x, y) => x.name.localeCompare(y.name)).map(k => k.name + ': ' + k.levels.map(l => l.sets.map(s => s.id + (s.turn ? '(side-on)' : '')).join('+')).join(' / ')).join('; '); });
  await p.goto(base + '#catalog');
  for (const [id, what, name] of [['m-backup', 'Backup', /^Brickyard \d{4}-\d\d-\d\d\.json$/], ['m-csv', 'Spreadsheet', /^Brickyard sets \d{4}-\d\d-\d\d\.csv$/]]) {
    await p.click('#menu-btn');
    const [file] = await Promise.all([p.waitForEvent('download'), p.click('#' + id)]);
    await closed();
    assert.match(file.suggestedFilename(), name);
    assert.deepEqual(await says(), [what + ' made: ' + file.suggestedFilename() + '. It’s in your downloads.', ''], 'a download says what was made and where it went');
    assert.ok(await p.$eval('.toast', t => t.getBoundingClientRect().height) < 80, 'in two lines on a phone');
  }
  // A new bookcase, and Undo.
  await p.goto(base + '#shelves');
  await p.click('[data-act="add-case"]');
  await p.fill('#k-name', 'Hall Kallax');
  await p.click('#k-save');
  await closed();
  assert.deepEqual([await says(), await on()], [['Added Hall Kallax', 'Undo'], 'Hall Kallax:  /  /  /  /  / ; Office Billy: a+th+b / '], 'a new bookcase is named, with Undo');
  await p.click('.toast button');
  assert.deepEqual([await says(), await on(), await p.locator('.case').count()], [['Took Hall Kallax out again', ''], 'Office Billy: a+th+b / ', 1], 'Undo takes it out again');
  // A bookcase saved with nothing else to say.
  await p.click('[data-case="k"]');
  await p.fill('#k-room', 'Office');
  await p.click('#k-save');
  await closed();
  assert.deepEqual(await says(), ['Saved', '']);
  // A set's sheet in the planner.
  const open = async () => { await p.locator('.sv-set[data-set="th"]').click(); await p.waitForSelector('#z-save'); };
  const save = async (act, button) => { await open(); if (act) await act(); await p.click(button || '#z-save'); await closed(); return [(await says()).join('|'), await on()]; };
  assert.deepEqual(await save(), ['Saved|', 'Office Billy: a+th+b / '], 'nothing changed');
  // Move left and Move right keep the sheet open, so they can be tapped more than once. The focus stays on the
  // button, or goes to the other one at the end of the shelf, and closing gives it back to the set in the drawing.
  const moved = async button => { await p.click(button); return [(await says()).join('|'), await on(), await p.locator('.sheet').count(), await p.evaluate(() => document.activeElement.id)]; };
  await open();
  assert.deepEqual(await moved('#z-right'), ['Moved right|', 'Office Billy: a+b+th / ', 1, 'z-left'], 'Move right keeps the sheet open; at the end of the shelf the focus goes to Move left');
  assert.deepEqual(await moved('#z-left'), ['Moved left|', 'Office Billy: a+th+b / ', 1, 'z-left'], 'and it can be tapped again');
  assert.deepEqual(await moved('#z-left'), ['Moved left|', 'Office Billy: th+a+b / ', 1, 'z-right']);
  assert.deepEqual([await p.evaluate(() => document.getAnimations().length), await p.evaluate(() => [document.getElementById('z-left').disabled, document.getElementById('z-right').disabled])], [0, [true, false]], 'the sheet doesn’t slide up again, and shows where the set stands now');
  assert.deepEqual(await moved('#z-right'), ['Moved right|', 'Office Billy: a+th+b / ', 1, 'z-right']);
  await p.click('[data-close]');
  await closed();
  assert.equal(await p.evaluate(() => document.activeElement.dataset.set), 'th', 'closed without a question, with the focus back on the set in the drawing');
  assert.deepEqual(await save(() => p.check('#z-turn')), ['Turned side-on|', 'Office Billy: a+th(side-on)+b / ']);
  assert.deepEqual(await save(() => p.uncheck('#z-turn')), ['Turned to face out|', 'Office Billy: a+th+b / ']);
  assert.deepEqual(await save(() => p.selectOption('#z-where', 'k:1')), ['Tree House is on Office Billy, shelf 2|', 'Office Billy: a+b / th'], 'a new shelf is named');
  assert.deepEqual(await save(() => p.fill('#z-w', '11"')), ['Saved. Read as inches: 27.9 cm|', 'Office Billy: a+b / th'], 'what was read as inches comes after');
  assert.deepEqual(await save(() => p.selectOption('#z-where', '')), ['Off the shelves|', 'Office Billy: a+b / ']);
  // A set that only fits a shelf side-on says so when it's put there. (30 cm from front to back, in a bookcase 26 deep.)
  await p.evaluate(() => { const d = JSON.parse(JSON.stringify(window.brickyard.doc())); d.sets.th.size = { w: 24, d: 30, h: 20 }; d.sets.th.t = Date.now(); window.brickyard.takeDoc(d); });
  await p.click('.item[data-set="th"]');
  await p.waitForSelector('#z-save');
  await p.selectOption('#z-where', 'k:0');
  await p.click('#z-save');
  await closed();
  assert.deepEqual([(await says()).join('|'), await on()], ['Tree House is on Office Billy, shelf 1, side-on|', 'Office Billy: a+b+th(side-on) / ']);
  // Add sizes.
  await p.goto('about:blank');
  await p.goto(base + '#z1z' + deflateRawSync(JSON.stringify({ brickyard: 1, sizes: [{ num: '10311', w: 24, d: 18, h: 39 }, { num: '10497', w: 52, d: 32, h: 13 }, { num: '10305', w: 44, d: 33, h: 38 }] })).toString('base64url'));
  await p.waitForSelector('#zr-go');
  const foot = () => p.evaluate(() => [document.getElementById('zr-n').textContent, document.getElementById('zr-go').textContent, document.getElementById('zr-go').disabled]);
  assert.deepEqual(await foot(), ['2 of 3 ticked', 'Add 2 sizes', false], 'the two sets with no size are ticked, and counted on the button');
  await p.click('#zr li:has-text("Orchid")');
  assert.deepEqual(await foot(), ['1 of 3 ticked', 'Add 1 size', false]);
  await p.click('#zr li:has-text("Galaxy Explorer")');
  assert.deepEqual(await foot(), ['0 of 3 ticked', 'Add sizes', true], 'with none ticked the button waits');
  await p.click('#zr li:has-text("Lion Knights")');
  await p.click('#zr-go');
  await closed();
  assert.deepEqual([await says(), await p.evaluate(() => window.brickyard.doc().sets.c.size)], [['1 size added', ''], { w: 44, d: 33, h: 38 }]);
  await c.close();
}

// A button that asks for a second tap doesn't stay a question. "Tap again to remove" used to stay until the sheet
// closed: a tap on it minutes later, after other things in the sheet, removed the set. After five seconds, or when
// the focus leaves it, the button has its own words back and the next tap is a first tap again. For every button
// that asks: a set's Remove, a bookcase's Remove and Take every set off, a model's Remove, Close with changes
// typed, and Add set for a set that's already here.
{
  const set = (id, name, w) => ({ id, t: 1, name, state: 'built', size: { w, d: 20, h: 20 } });
  const { c, p } = await withSets({ sets: { t: { id: 't', t: 1, num: '21318-1', name: 'Tree House', state: 'built' }, a: set('a', 'Set A', 20) }, cases: { k: { id: 'k', t: 1, name: 'Billy', w: 76, d: 26, levels: [{ h: 32, sets: [{ id: 'a' }] }] } } });
  const words = sel => p.$eval(sel, b => (b.querySelector('span') ? b.querySelector('span').firstChild : b).textContent);
  const kept = () => p.evaluate(() => { const d = window.brickyard.doc(); return [Object.values(d.sets).filter(x => !x.del).length, Object.values(d.cases).filter(x => !x.del).length, window.BrickCore.shelves(d).k.levels[0].sets.length, Object.keys(JSON.parse(localStorage.getItem('brickyard.models') || '{}')).length].join(); });
  // One tap, then the focus goes to `away`: the button's own words are back, and a tap is a first tap again.
  const calms = async (sel, own, asks, away) => {
    await p.click(sel);
    assert.equal(await words(sel), asks, own + ' asks on its first tap');
    await p.waitForTimeout(650);
    await p.focus(away);
    assert.equal(await words(sel), own, own + ': its own words are back when the focus leaves it');
    await p.click(sel);
    assert.equal(await words(sel), asks, own + ': and the next tap asks again');
  };
  await p.goto(base + '#catalog');
  await p.click('.item:has-text("Tree House")');
  await calms('#e-del', 'Remove', 'Tap again to remove', '#e-name');
  // Left alone with the focus still on it, it goes back after five seconds.
  await p.waitForTimeout(3000);
  assert.equal(await words('#e-del'), 'Tap again to remove', 'still asking after 3 seconds');
  await p.waitForTimeout(2500);
  assert.deepEqual([await words('#e-del'), await p.evaluate(() => document.activeElement.id)], ['Remove', 'e-del'], 'and back to Remove after 5');
  await p.click('#e-del');
  assert.deepEqual([await words('#e-del'), await kept()], ['Tap again to remove', '2,1,1,0'], 'a tap after that is a first tap: the set is still here');
  // Close with something typed.
  await p.fill('#e-notes', 'a note');
  await calms('.sheet [data-close]', 'Close', 'Discard changes?', '#e-notes');
  await p.waitForTimeout(650);
  await p.click('.sheet [data-close]');
  await p.waitForFunction(() => !document.querySelector('.scrim'));
  // Add set, for a set that's already here.
  await p.click('#add-btn');
  await p.fill('#e-num', '21318');
  await p.click('#e-save');
  assert.equal(await p.textContent('#e-dup'), 'You already have Tree House. Tap again to add a second copy.', 'the line under the number asks with the button');
  await p.waitForTimeout(650);
  await p.focus('#e-year');
  assert.deepEqual([await words('#e-save'), await p.textContent('#e-dup'), await p.isVisible('#e-dup')], ['Add set', 'You already have Tree House.', true],
    'when the button has its own words back, the line under the number stops saying "Tap again": the next tap is a first tap');
  await calms('#e-save', 'Add set', 'Add another copy', '#e-year');
  assert.equal(await p.textContent('#e-dup'), 'You already have Tree House. Tap again to add a second copy.', 'asked again, the line says so again');
  assert.equal(await p.inputValue('#e-name'), 'Tree House', 'the first copy’s name is still in its box');
  await p.waitForTimeout(650);
  await p.click('#e-save');
  await p.waitForFunction(() => !document.querySelector('.scrim'));
  assert.equal(await kept(), '3,1,1,0', 'a second tap straight after adds the copy');
  // A bookcase: Take every set off, and Remove.
  await p.goto(base + '#shelves');
  await p.click('[data-case="k"]');
  await calms('#k-clear', 'Take every set off', 'Tap again to take it off', '#k-name');
  await calms('#k-del', 'Remove', 'Tap again to remove', '#k-name');
  assert.equal(await kept(), '3,1,1,0', 'nothing has gone');
  await p.click('.sheet [data-close]');
  // A model.
  await p.goto(base + '#d1z' + deflateRawSync(JSON.stringify({ brickyard: 1, model: { name: 'Wall', parts: Array.from({ length: 4 }, (_, i) => ['3001', 4, 0, i * 3, 0, 0, i + 1]) } })).toString('base64url'));
  await p.waitForFunction(() => location.hash.startsWith('#model-m') && !document.getElementById('model-view').hidden);
  await p.click('#model-menu');
  await calms('#mm-del', 'Remove from my models', 'Tap again to remove', '#mm-parts');
  assert.deepEqual([await p.textContent('#mm-del small'), await kept()], ['Tap twice. Claude’s link still opens it again.', '3,1,1,1'], 'the line under it is whole again, and the model is still here');
  await p.waitForTimeout(650);
  await p.click('#mm-del');
  await p.waitForSelector('#build-list:not([hidden]) .list');
  assert.equal(await kept(), '3,1,1,0', 'the second tap still removes');
  await c.close();
}

// One word for each thing. The State control says "Taken apart", like the chips, the badges and the planner (it
// said "Apart"); each of its buttons is as wide as its words need, so at 320 px all four are still on one line,
// none narrower than 44 px. Loose pieces are never called a "lot", the code's word ("You can untick or remove a lot there" read as "remove much"). A review
// that came from a link or a file is put off with "Not now", whichever kind it is (the catalog's said Cancel, the
// sizes' said Close). A moving box is "Box 7" wherever it's named. And the hint on the 3D picture says how the
// thing in hand zooms: the wheel with a mouse, a pinch with fingers.
{
  const lot = { id: 'tub', t: 1, name: 'Blue tub', box: '7', parts: [['3001', 4, 40], ['3020', 15, 2]] };
  const { c, p } = await withSets({ sets: { t: { id: 't', t: 1, num: '21318-1', name: 'Tree House', state: 'apart', box: '7' } }, loose: { tub: lot } }, { viewport: { width: 320, height: 568 } });
  const shown = () => p.$eval('.sheet', s => s.innerText.replace(/\s+/g, ' '));
  const close = () => p.textContent('.sheet [data-close]');
  await p.goto(base + '#catalog');
  await p.click('.item:has-text("Tree House")');
  const seg = await p.$$eval('#e-state button', bs => bs.map(b => { const r = b.getBoundingClientRect(); return [b.textContent, b.scrollWidth <= b.clientWidth, Math.round(r.width), Math.round(r.height)]; }));
  assert.deepEqual(seg.map(b => b[0]), ['Built', 'Partly built', 'Taken apart', 'Sealed']);
  assert.ok(seg.every(b => b[1] && b[2] >= 44 && b[3] === 44), 'at 320 px each name is inside its button, on one line, and no button is under 44 px ' + JSON.stringify(seg));
  assert.equal(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.querySelector('.sheet').scrollWidth <= innerWidth), true, 'and nothing runs off the side');
  await p.click('.sheet [data-close]');
  await p.selectOption('#group', 'box');
  assert.equal(await p.textContent('.note.lots'), 'Also in Box 7: Blue tub, 42 loose pieces');
  await p.goto(base + '#build');
  await p.waitForSelector('li.lot');
  assert.match(await p.textContent('li.lot small'), /^Loose · 42 pieces · Box 7/);
  await p.click('li.lot [data-lot]');
  assert.match(await shown(), /opening their link or file again brings them back\./);
  assert.doesNotMatch(await shown(), /\blots?\b/i, 'removing loose pieces');
  await p.click('.sheet [data-close]');
  // The same loose pieces, opened again.
  await p.goto('about:blank');
  await p.goto(base + '#l1j' + Buffer.from(JSON.stringify({ brickyard: 1, loose: lot })).toString('base64url'));
  await p.waitForSelector('#ls-add');
  assert.match(await shown(), /You already have these loose pieces \(42 pieces\)\. Adding them again replaces them, so nothing is counted twice\./);
  assert.match(await shown(), /You can untick or remove them there\./);
  assert.doesNotMatch(await shown(), /\blots?\b/i, 'adding loose pieces');
  assert.deepEqual([await close(), await p.textContent('#ls-add')], ['Not now', 'Replace them']);
  await p.click('.sheet [data-close]');
  // A whole catalog from a link counts its loose pieces.
  const other = { brickyard: 1, catalog: { sets: { x: { id: 'x', t: 5, num: '10311-1', name: 'Orchid' } }, loose: { bag: { id: 'bag', t: 5, name: 'Red bag', parts: [['3001', 4, 10]] }, tub: lot } } };
  await p.goto('about:blank');
  await p.goto(base + '#b1j' + Buffer.from(JSON.stringify(other)).toString('base64url'));
  await p.waitForSelector('#cs-go');
  assert.match(await shown(), /This link has 1 set and 52 loose pieces\. Bringing it in merges it/);
  assert.doesNotMatch(await shown(), /\blots?\b/i, 'a catalog from a link');
  assert.equal(await close(), 'Not now');
  await p.click('.sheet [data-close]');
  await p.goto('about:blank');
  await p.goto(base + '#z1j' + Buffer.from(JSON.stringify({ brickyard: 1, sizes: [{ num: '21318', w: 27, d: 24, h: 37 }] })).toString('base64url'));
  await p.waitForSelector('#zr-go');
  assert.deepEqual([await p.textContent('#sheetTitle'), await close()], ['Add sizes', 'Not now']);
  await c.close();
  for (const [opts, hint] of [[{ viewport: { width: 1280, height: 800 }, hasTouch: false, deviceScaleFactor: 1 }, 'Drag to turn · scroll to zoom'], [{ isMobile: true }, 'Drag to turn · pinch to zoom']]) {
    const m = await withSets({ sets: {} }, opts);
    await m.p.goto(base + '#model-x-cottage');
    await m.p.waitForSelector('#model-view:not([hidden])');
    assert.equal(await m.p.textContent('#stage-hint'), hint, opts.isMobile ? 'on a phone' : 'with a mouse');
    await m.c.close();
  }
}

// The Shelf planner says, under its count, how many sets are in each of the two lists below the bookcases, as words
// to tap that go there: "22 not on a shelf yet", "12 need a size". With 300 sets and three bookcases, Needs a size
// and its two buttons (Copy these for Claude, Open sizes from Claude) were a dozen screens down, and the line at
// the top said only "29 of 174 sets on shelves". A tap brings the list's heading to the top of the screen, clear
// of the bar, and gives it the focus. A list with nothing in it is left out, and with no bookcase yet the same
// words are under Add a bookcase.
{
  const sets = {};
  for (let i = 0; i < 40; i++) sets['s' + i] = { id: 's' + i, t: 1, num: (10200 + i) + '-1', name: 'Set number ' + (i + 1), state: 'built', ...(i % 3 ? { size: { w: 30, d: 20, h: 20 } } : {}) };
  sets.one = { id: 'one', t: 1, name: 'Small one', state: 'built', size: { w: 10, d: 10, h: 10 } };
  const billy = { id: 'k', t: 1, name: 'Billy', w: 76, d: 26, levels: [{ h: 30, sets: [{ id: 's1' }, { id: 's2' }] }, { h: 30, sets: [] }] };
  for (const width of [390, 320]) {
    const { c, p } = await withSets({ sets, cases: { k: billy } }, { viewport: { width, height: width === 320 ? 568 : 844 } });
    const jumps = () => p.$$eval('#shelves-body .jump button', bs => bs.map(b => { const r = b.getBoundingClientRect(); return [b.textContent, r.height >= 44 && r.width >= 44, r.left >= 0 && r.right <= innerWidth]; }));
    // Where the heading that has the focus is: its words, and how far under the bar its top is.
    const landed = () => p.evaluate(() => { const h = document.activeElement, r = h.getBoundingClientRect(), bar = document.querySelector('#shelves .bar').getBoundingClientRect().bottom;
      return [h.tagName, h.getAttribute('aria-label'), r.top >= bar && r.top - bar < 40 && r.bottom <= innerHeight]; });
    await p.goto(base + '#shelves');
    assert.deepEqual([await p.textContent('#shelves-body .sumline'), await jumps()], ['2 of 41 sets on shelves', [['25 not on a shelf yet↓', true, true], ['14 need a size↓', true, true]]], width + ' px: the two lists are counted under the line at the top, each 44 px tall and on the screen');
    assert.equal(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.ok(await p.$eval('#sv-nosize', h => h.getBoundingClientRect().top) > 1500, 'Needs a size is far down the page');
    await p.click('.jump [data-k="nosize"]');
    assert.deepEqual(await landed(), ['H2', 'Needs a size, 14 sets', true], width + ' px: a tap brings Needs a size to the top of the screen, under the bar, with the focus');
    assert.equal(await p.evaluate(() => { const r = document.querySelector('[data-act="ask-sizes"]').getBoundingClientRect(); return r.top > 0 && r.bottom < innerHeight; }), true, 'and Copy these for Claude is on the screen');
    await p.evaluate(() => scrollTo(0, 0));
    await p.focus('.jump [data-k="waiting"]');
    await p.keyboard.press('Enter');
    assert.deepEqual(await landed(), ['H2', 'Not on a shelf yet, 25 sets', true], 'the same for Not on a shelf yet, by keyboard');
    // A list with nothing in it isn't counted: every set given a size.
    await p.evaluate(() => { const d = JSON.parse(JSON.stringify(window.brickyard.doc())); Object.values(d.sets).forEach(x => { if (!x.size) { x.size = { w: 30, d: 20, h: 20 }; x.t = Date.now(); } }); window.brickyard.takeDoc(d); });
    assert.deepEqual((await jumps()).map(j => j[0]), ['39 not on a shelf yet↓']);
    // With no bookcase the words are under Add a bookcase.
    await p.evaluate(() => { const d = JSON.parse(JSON.stringify(window.brickyard.doc())); d.cases.k = { id: 'k', t: Date.now(), del: 1 }; delete d.sets.one.size; d.sets.one.t = Date.now(); window.brickyard.takeDoc(d); });
    assert.deepEqual([await p.locator('.empty .jump').count(), (await jumps()).map(j => j[0])], [1, ['40 not on a shelf yet↓', '1 needs a size↓']]);
    // Over the words there, the shelf drawing from the home screen's card (it was words only, where My sets has its brick).
    assert.deepEqual(await p.evaluate(() => { const svg = document.querySelector('#shelves-body .empty > svg'), home = document.querySelector('#go-shelves svg'), r = svg.getBoundingClientRect();
      return [svg.innerHTML === home.innerHTML.replace(/>\s+</g, '><').trim(), svg.getAttribute('aria-hidden'), svg.nextElementSibling.textContent, r.width > 60 && r.left >= 0 && r.right <= innerWidth && r.bottom <= document.querySelector('.empty h2').getBoundingClientRect().top]; }),
      [true, 'true', 'Your bookcases go here', true]);
    await p.click('.jump [data-k="nosize"]');
    // The last thing on the page comes as far up as the page goes: on the screen, under the bar.
    assert.deepEqual([(await landed()).slice(0, 2), await p.$eval('#sv-nosize', h => { const r = h.getBoundingClientRect(); return r.top >= document.querySelector('#shelves .bar').getBoundingClientRect().bottom && r.bottom <= innerHeight; })], [['H2', 'Needs a size, 1 set'], true]);
    await c.close();
  }
  // Nothing to go to: no words.
  const { c, p } = await withSets({ sets: { a: { id: 'a', t: 1, name: 'Set A', state: 'built', size: { w: 20, d: 20, h: 20 } } }, cases: { k: { id: 'k', t: 1, name: 'Billy', w: 76, d: 26, levels: [{ h: 30, sets: [{ id: 'a' }] }] } } });
  await p.goto(base + '#shelves');
  assert.deepEqual([await p.textContent('#shelves-body .sumline'), await p.locator('.jump').count()], ['Your set is on a shelf', 0]);
  await c.close();
}

// The search box stays in view under the title bar while My sets scrolls (it went with the page). Going into it
// doesn't move the page; what a search typed down the list finds is shown from its top; and a row the keyboard
// moves to stops under the search, not behind it. On a screen too short for both (a phone on its side) the search
// scrolls with the page as before.
{
  const sets = {};
  for (let i = 0; i < 60; i++) sets['s' + i] = { id: 's' + i, t: 1, name: 'Set ' + String(i).padStart(2, '0'), room: 'Room ' + (i % 4), state: 'built' };
  for (const opts of [{}, { viewport: { width: 1280, height: 800 }, hasTouch: false, deviceScaleFactor: 1 }]) {
    const { c, p } = await withSets({ sets }, opts);
    await p.goto(base + '#catalog');
    const q = () => p.$eval('#q', e => { const r = e.getBoundingClientRect(), bar = document.querySelector('#catalog .bar').getBoundingClientRect(); return [Math.round(r.top - bar.bottom), document.elementFromPoint(r.left + 60, r.top + 20) === e]; });
    assert.deepEqual(await q(), [2, true], 'the search box is under the bar to begin with');
    await p.evaluate(() => scrollTo(0, 1500));
    assert.deepEqual([await q(), await p.evaluate(() => Math.round(scrollY))], [[2, true], 1500], 'and still there, on top of the rows, 1,500 px down the list');
    await p.evaluate(() => document.getElementById('q').focus());
    assert.equal(await p.evaluate(() => Math.round(scrollY)), 1500, 'going into it leaves the page where it is');
    // Shift+Tab from a row down the list: the row before it stops clear of the search.
    await p.evaluate(() => { document.querySelectorAll('#list-wrap .item')[30].focus({ preventScroll: true }); scrollTo(0, document.querySelectorAll('#list-wrap .item')[30].getBoundingClientRect().top + scrollY - 140); });
    await p.keyboard.press('Shift+Tab');
    assert.ok(await p.evaluate(() => document.activeElement.getBoundingClientRect().top >= document.querySelector('.tools').getBoundingClientRect().bottom), 'a row the keyboard moves up to is shown under the search box');
    await p.evaluate(() => scrollTo(0, 1500));
    await p.focus('#q');
    await p.keyboard.type('set 4');
    assert.deepEqual([await p.evaluate(() => Math.round(scrollY)), await p.locator('#list-wrap .item').count()], [0, 15], 'what a search finds is shown from its top');
    await c.close();
  }
  const side = await withSets({ sets }, { viewport: { width: 844, height: 390 } });
  await side.p.goto(base + '#catalog');
  await side.p.evaluate(() => scrollTo(0, 1500));
  assert.ok(await side.p.$eval('#q', e => e.getBoundingClientRect().bottom < 0), 'on a phone on its side the search scrolls away, leaving the room to the list');
  await side.c.close();
}

// Coming back to My sets from the home screen, the builder or the planner returns to where the list was (it always
// landed at the top), by the links on the page and by the browser's Back alike. The other screens still open at
// their tops, and so does My sets the first time.
{
  const sets = {};
  for (let i = 0; i < 60; i++) sets['s' + i] = { id: 's' + i, t: 1, name: 'Set ' + String(i).padStart(2, '0'), room: 'Room ' + (i % 4), state: 'built' };
  const { c, p } = await withSets({ sets });
  const y = () => p.evaluate(() => Math.round(scrollY));
  const on = id => p.waitForSelector('#' + id + ':not([hidden])');
  await p.click('#go-catalog'); await on('catalog');
  assert.equal(await y(), 0, 'My sets opens at its top');
  await p.evaluate(() => scrollTo(0, 1500));
  await p.click('#catalog .back'); await on('home');
  assert.equal(await y(), 0, 'the home screen opens at its top');
  await p.click('#go-catalog'); await on('catalog');
  assert.equal(await y(), 1500, 'back in My sets, the list is where it was left');
  await p.evaluate(() => scrollTo(0, 2200));
  await p.evaluate(() => { location.hash = '#shelves'; }); await on('shelves');
  assert.equal(await y(), 0, 'the Shelf planner opens at its top');
  await p.goBack(); await on('catalog');
  assert.equal(await y(), 2200, 'the browser’s Back from the planner comes back to the place too');
  await p.evaluate(() => { location.hash = '#build'; }); await on('build');
  await p.click('#build-back'); await on('home');
  await p.click('#go-catalog'); await on('catalog');
  assert.equal(await y(), 2200, 'and from the builder, by way of the home screen');
  await c.close();
}

// Folding. With the whole list showing, a tap on a group's heading folds its sets away and another shows them; Fold
// all on the summary line folds every group, and turns into Unfold all. What's folded is remembered on the device,
// for each way of grouping. A search or a filter chip shows every set it finds, folded group or not, and the folds
// are back afterwards. A moving box's heading still opens the box: the arrow before it folds. A set that's shown
// (added by hand, or See in My sets) has its group opened. Paper gets the whole list.
{
  const s = (id, name, room, more) => ({ id, t: 1, name, room, state: 'built', ...more });
  const { c, p } = await withSets({ sets: { a: s('a', 'Orchid', 'Office', { box: '3' }), b: s('b', 'Typewriter', 'Office'), d: s('d', 'Castle', 'Den', { box: '3', check: 'which castle?' }), e: s('e', 'Titanic', 'Den', { box: '7' }), f: s('f', 'Loose bits', '') },
    loose: { bag: { id: 'bag', t: 1, name: 'Blue tub', box: '3', parts: [['3001', 1, 42]] } } });
  await p.goto(base + '#catalog');
  const seen = () => p.$$eval('#list-wrap .item', els => els.filter(e => e.getClientRects().length).map(e => e.querySelector('.t').textContent));
  const heads = () => p.$$eval('#list-wrap h2.group', hs => hs.map(h => [h.querySelector('span').textContent, h.querySelector('[data-fold]') ? h.querySelector('[data-fold]').getAttribute('aria-expanded') : 'plain']));
  const prefs = () => p.evaluate(() => JSON.parse(localStorage.getItem('brickyard.prefs') || '{}').folded);
  const all = () => p.$eval('#fold-all', b => b.hidden ? null : b.textContent);
  assert.deepEqual([await heads(), await seen(), await all()], [[['Den', 'true'], ['Office', 'true'], ['No room yet', 'true']], ['Castle', 'Titanic', 'Orchid', 'Typewriter', 'Loose bits'], 'Fold all'], 'every group starts open');
  assert.deepEqual(await p.$eval('[data-fold="Office"]', b => [b.getBoundingClientRect().height >= 44, Math.round(b.getBoundingClientRect().width) >= 350]), [true, true], 'the whole heading is the button');
  await p.focus('[data-fold="Office"]');
  await p.keyboard.press('Enter');
  assert.deepEqual([await heads(), await seen(), await prefs(), await all()], [[['Den', 'true'], ['Office', 'false'], ['No room yet', 'true']], ['Castle', 'Titanic', 'Loose bits'], { room: ['Office'] }, 'Fold all'], 'a tap on Office folds its sets away, and the device remembers');
  assert.deepEqual([await p.evaluate(() => document.activeElement.dataset.fold), await p.getByRole('button', { name: 'Office, 2 sets', expanded: false }).count(), await p.textContent('#sum')], ['Office', 1, '5 sets'], 'the keyboard stays on the heading, which says it is folded; the count is still of every set');
  await p.reload();
  assert.deepEqual(await seen(), ['Castle', 'Titanic', 'Loose bits'], 'still folded after a reload');
  // A search, or a filter chip, shows what it finds; the folds come back with the whole list.
  await p.fill('#q', 'orchid');
  assert.deepEqual([await seen(), await heads(), await all()], [['Orchid'], [['Office', 'plain']], null], 'a search finds a set in a folded group and shows it');
  await p.fill('#q', '');
  await p.click('.chip[data-f="check"]');
  assert.deepEqual([await seen(), await all()], [['Castle'], null], 'so does a filter chip');
  await p.click('.chip[data-f="all"]');
  assert.deepEqual(await seen(), ['Castle', 'Titanic', 'Loose bits'], 'and the fold is back with the whole list');
  // Fold all, Unfold all.
  await p.click('#fold-all');
  assert.deepEqual([await seen(), await all(), await prefs()], [[], 'Unfold all', { room: ['Den', 'Office', 'No room yet'] }]);
  await p.click('[data-fold="Den"]');
  assert.deepEqual([await seen(), await all()], [['Castle', 'Titanic'], 'Fold all'], 'one group opened: the button folds again');
  await p.click('#fold-all'); await p.click('#fold-all');
  assert.deepEqual([await seen(), await all(), await prefs()], [['Castle', 'Titanic', 'Orchid', 'Typewriter', 'Loose bits'], 'Fold all', { room: [] }], 'Unfold all shows every set');
  // By moving box: the arrow folds, the heading still opens the box, and the box's loose pieces fold with it.
  await p.selectOption('#group', 'box');
  assert.deepEqual([await seen(), await p.locator('#list-wrap .note.lots').evaluateAll(els => els.filter(e => e.getClientRects().length).length)], [['Castle', 'Orchid', 'Titanic', 'Loose bits', 'Typewriter'], 1], 'folds are kept for each way of grouping: by box, nothing is folded yet');
  await p.click('.group.two [data-fold="Box 3"]');
  assert.deepEqual([await seen(), await p.locator('#list-wrap .note.lots').evaluateAll(els => els.filter(e => e.getClientRects().length).length), await prefs(), await p.getByRole('button', { name: 'What’s in Box 3', expanded: false }).count()],
    [['Titanic', 'Loose bits', 'Typewriter'], 0, { room: [], box: ['Box 3'] }, 1], 'the arrow before Box 3 folds its sets and its loose pieces');
  await p.click('.box-head[data-box="3"]');
  assert.equal(await p.textContent('#sheetTitle'), 'Box 3', 'the heading itself still opens the box');
  await p.click('[data-close]');
  // A set that's shown has its group opened: See in My sets (showSet), and a set added by hand.
  await p.evaluate(() => window.brickyard.showSet('a'));
  await p.waitForSelector('.sheet');
  assert.equal(await p.textContent('#sheetTitle'), 'Orchid');
  await p.click('[data-close]');
  assert.deepEqual([await seen(), await prefs()], [['Castle', 'Orchid', 'Titanic', 'Loose bits', 'Typewriter'], { room: [], box: [] }], 'showing a set in a folded box opens the box’s group');
  await p.click('[data-fold="Not packed"]');
  await p.click('#add-btn'); await p.fill('#e-name', 'New arrival'); await p.click('#e-save');
  await until(async () => (await seen()).includes('New arrival'), 3000, 'a set added into a folded group was left hidden');
  // On paper every set is listed, folded or not, without the arrows.
  await p.click('#fold-all');
  assert.deepEqual(await seen(), []);
  await p.emulateMedia({ media: 'print' });
  assert.deepEqual([(await seen()).length, await p.$$eval('.fold.mark, #fold-all', els => els.filter(e => e.getClientRects().length).length)], [6, 0], 'paper gets the whole list');
  await p.emulateMedia({ media: 'screen' });
  // Prefs saved before folding existed, or with something else under the name, are fine.
  await p.evaluate(() => localStorage.setItem('brickyard.prefs', JSON.stringify({ pics: true, group: 'room', folded: 'yes' })));
  await p.reload();
  assert.deepEqual([(await seen()).length, await all()], [6, 'Fold all']);
  await p.click('[data-fold="Den"]');
  assert.deepEqual(await prefs(), { room: ['Den'] });
  await c.close();
}

// With the Missing pieces filter on, Copy this list puts what's missing on the clipboard, a line a set, for an order
// of replacement pieces: the sets the list is showing, so a search narrows it. Under any other filter there's no
// such button. Where the browser won't copy, the text is shown to copy by hand.
{
  const sets = { e: { id: 'e', t: 1, num: '60337-1', name: 'Express Passenger Train', state: 'built', room: 'Office', missing: 'one dark grey 1x2 plate' }, t: { id: 't', t: 1, num: '21327-1', name: 'Typewriter', state: 'built', room: 'Den', missing: 'the dial\none foot' }, o: { id: 'o', t: 1, num: '10311-1', name: 'Orchid', state: 'built' } };
  const { c, p } = await withSets({ sets }, { permissions: ['clipboard-read', 'clipboard-write'] });
  const says = () => p.textContent('.toast:not([hidden]) span').catch(() => '');
  await p.goto(base + '#catalog');
  assert.equal(await p.locator('[data-act="missing"]').count(), 0, 'no Copy this list on the whole list');
  await p.click('.chip[data-f="missing"]');
  assert.deepEqual([await p.textContent('[data-act="missing"]'), await p.$eval('[data-act="missing"]', b => b.getBoundingClientRect().height >= 44)], ['Copy this list', true]);
  await p.click('[data-act="missing"]');
  await until(async () => (await says()) !== '', 3000, 'Copy this list said nothing');
  assert.deepEqual([await says(), await p.evaluate(() => navigator.clipboard.readText())], ['Copied what’s missing from 2 sets', '60337 Express Passenger Train: one dark grey 1x2 plate\n21327 Typewriter: the dial, one foot']);
  await p.fill('#q', 'typewriter');
  await p.click('[data-act="missing"]');
  await until(async () => (await says()) === 'Copied what’s missing from 1 set', 3000, 'a search narrows what is copied');
  assert.equal(await p.evaluate(() => navigator.clipboard.readText()), '21327 Typewriter: the dial, one foot');
  await p.fill('#q', 'zzz');
  assert.equal(await p.locator('[data-act="missing"]').count(), 0, 'nothing found, nothing to copy');
  await p.fill('#q', '');
  // The browser refuses: the list is shown instead, selected.
  await p.evaluate(() => { navigator.clipboard.writeText = () => Promise.reject(new Error('no')); });
  await p.click('[data-act="missing"]');
  await p.waitForSelector('#bx-text');
  assert.deepEqual([await p.textContent('#sheetTitle'), await p.inputValue('#bx-text')], ['Missing pieces', '60337 Express Passenger Train: one dark grey 1x2 plate\n21327 Typewriter: the dial, one foot']);
  await p.click('[data-close]');
  await p.click('.chip[data-f="built"]');
  assert.equal(await p.locator('[data-act="missing"]').count(), 0, 'and none under Built');
  await c.close();
}

// A set with a number has a link in its sheet to LEGO's own page of building instructions for that number, opened in
// a new tab without saying where from. It follows the number as it's typed, and a set with no number has none.
// Nothing is asked of LEGO until it's tapped (the check at the end that no request left the site covers that).
{
  const { c, p } = await withSets({ sets: { f: { id: 'f', t: 1, num: '75192-1', name: 'Millennium Falcon', state: 'apart' }, m: { id: 'm', t: 1, name: 'Mystery castle', state: 'built' } } });
  await p.goto(base + '#catalog');
  await p.click('.item[data-id="f"]');
  const link = () => p.$eval('#e-lego', a => [a.closest('p').hidden, a.textContent, a.href, a.target, a.rel, Math.round(a.getBoundingClientRect().height) >= 44]);
  assert.deepEqual(await link(), [false, 'Instructions at LEGO ↗ (opens in a new tab)', 'https://www.lego.com/service/buildinginstructions/75192', '_blank', 'noopener noreferrer', true], 'the Falcon’s sheet links to LEGO’s instructions for 75192');
  await p.fill('#e-num', '10698');
  assert.equal((await link())[2], 'https://www.lego.com/service/buildinginstructions/10698', 'the link follows the number in the box');
  await p.fill('#e-num', '');
  assert.equal((await link())[0], true, 'and goes when the number does');
  await discard(p);
  await p.click('.item[data-id="m"]');
  assert.equal((await link())[0], true, 'a set with no number has no link');
  await p.fill('#e-num', '6080');
  assert.deepEqual((await link()).slice(0, 3), [false, 'Instructions at LEGO ↗ (opens in a new tab)', 'https://www.lego.com/service/buildinginstructions/6080'], 'until one is typed');
  await c.close();
}

// Small things for fingers. The keyboard's Search key (Enter) in the search box puts the keyboard away: the list
// is searched at every letter, so the key did nothing and the keyboard stayed over the results. Only on a touch
// screen: on a laptop Enter does nothing, and the cursor stays in the box (it used to leave it). Two quick taps on
// a button are never a double tap that zooms the page (touch-action), while the 3D picture keeps its touches to
// itself. A hover look is only for a device that hovers (on a phone it stayed on the last row tapped), and rows,
// cards, chips and menu rows have a pressed look. And a run of digits is never made a phone link.
{
  const { c, p } = await withSets({ sets: { t: { id: 't', t: 1, num: '21318-1', name: 'Tree House', state: 'built' }, o: { id: 'o', t: 1, num: '10311-1', name: 'Orchid', state: 'built' } } });
  await p.goto(base + '#catalog');
  await p.fill('#q', 'tree');
  await p.press('#q', 'Enter');
  assert.deepEqual([await p.evaluate(() => document.activeElement.tagName), await p.inputValue('#q'), await p.locator('#list-wrap .item .t').allTextContents()], ['BODY', 'tree', ['Tree House']], 'Enter leaves the search box, with what it found still showing');
  await p.fill('#q', '');
  {
    const lap = await withSets({ sets: { t: { id: 't', t: 1, num: '21318-1', name: 'Tree House', state: 'built', box: '3' }, o: { id: 'o', t: 1, num: '10311-1', name: 'Orchid', state: 'built' } } }, { viewport: { width: 1280, height: 800 }, hasTouch: false, deviceScaleFactor: 1 });
    await lap.p.goto(base + '#catalog');
    await lap.p.fill('#q', 'tree');
    await lap.p.press('#q', 'Enter');
    await lap.p.keyboard.type(' house');
    assert.deepEqual([await lap.p.evaluate(() => document.activeElement.id), await lap.p.inputValue('#q'), await lap.p.locator('#list-wrap .item .t').allTextContents()], ['q', 'tree house', ['Tree House']], 'on a laptop Enter leaves the cursor in the search box, and typing carries on');
    await lap.p.fill('#q', 'box 3');
    await lap.p.click('.boxline button'); await lap.p.click('#bx-add');
    await lap.p.fill('#ab-q', 'orc'); await lap.p.press('#ab-q', 'Enter');
    assert.deepEqual([await lap.p.evaluate(() => document.activeElement.id), await lap.p.locator('.sheet').count()], ['ab-q', 1], 'and in the search of Add sets to this box');
    await lap.c.close();
  }
  const touch = sels => p.evaluate(list => list.map(s => getComputedStyle(document.querySelector(s)).touchAction).join(), sels);
  assert.equal(await touch(['#add-btn', '.chip', '#q', '.item', '#group', '#menu-btn', '#catalog .back', '.jd-foot a']), Array(8).fill('manipulation').join());
  assert.equal(await p.getAttribute('meta[name="format-detection"]', 'content'), 'telephone=no');
  // Every hover look is inside "a device that hovers", but the footer's links, which lose theirs on the next page.
  const looks = await p.evaluate(() => {
    const out = { hover: [], active: [] };
    const walk = (rules, media) => { for (const r of rules) {
      if (r.media) walk(r.cssRules, media + ' ' + r.conditionText);
      else if (r.selectorText) for (const sel of r.selectorText.split(',').map(x => x.trim())) { if (/:hover/.test(sel) && !/hover: hover/.test(media)) out.hover.push(sel); if (/:active/.test(sel)) out.active.push(sel); }
    } };
    for (const sheet of document.styleSheets) walk(sheet.cssRules, '');
    return out;
  });
  assert.deepEqual(looks.hover, ['.jd-foot a:hover']);
  for (const sel of ['.item:active', '.room:active', '.chip:active', '.menu button:active', '.back:active']) assert.ok(looks.active.includes(sel), 'a pressed look for ' + sel);
  // Pressed: the row's ground is the soft colour while the mouse is down on it, and its own again after.
  const soft = await p.evaluate(() => { const d = document.createElement('div'); d.style.background = 'var(--soft)'; document.body.appendChild(d); const v = getComputedStyle(d).backgroundColor; d.remove(); return v; });
  const ground = sel => p.$eval(sel, el => getComputedStyle(el).backgroundColor);
  for (const sel of ['#list-wrap .item', '.chip[aria-pressed="false"]']) {
    const b = await p.locator(sel).first().boundingBox(), was = await ground(sel);
    await p.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await p.mouse.down();
    assert.deepEqual([await ground(sel), was === soft], [soft, false], sel + ' looks pressed while it’s held');
    await p.mouse.move(195, 30); // off it, onto the bar, so letting go presses nothing
    await p.mouse.up();
    assert.equal(await ground(sel), was);
  }
  // The chosen chip keeps its dark ground when pressed.
  const lit = await p.locator('.chip[aria-pressed="true"]').boundingBox(), dark = await ground('.chip[aria-pressed="true"]');
  await p.mouse.move(lit.x + lit.width / 2, lit.y + lit.height / 2);
  await p.mouse.down();
  assert.equal(await ground('.chip[aria-pressed="true"]'), dark);
  await p.mouse.up();
  await p.goto(base + '#model-x-cottage');
  await p.waitForSelector('#model-view:not([hidden])');
  assert.equal(await touch(['.stage', '#stage', '#step-next', '#step-range']), 'none,none,manipulation,manipulation', 'the 3D picture keeps its touches; the buttons under it don’t zoom the page');
  await c.close();
}

// "You already have …" is said under the Set number box as well as in a message, and stays there until the number
// changes. On a phone with the number box in use, the keyboard covers the bottom half of the screen: the message
// showed at y 697 and the button that had turned into "Add another copy" at y 788, both under it, so pressing Done
// seemed to do nothing. The line is right under the box, and the message is at the top while the sheet is open.
{
  const { c, p } = await withSets({ sets: { t: { id: 't', t: 1, num: '21318-1', name: 'Tree House', room: 'Living room', spot: 'Bookcase' }, o: { id: 'o', t: 1, num: '10311-1', name: 'Orchid' } } });
  const ASK = 'You already have Tree House (Living room › Bookcase). Tap again to add a second copy.';
  const line = () => p.evaluate(() => { const el = document.getElementById('e-dup'), r = el.getBoundingClientRect(), n = document.getElementById('e-num').getBoundingClientRect(), t = document.querySelector('.toast');
    return { says: el.hidden ? null : el.textContent, under: Math.round(r.top - n.bottom), bottom: Math.round(r.bottom), toast: t.hidden ? null : Math.round(t.getBoundingClientRect().bottom) }; });
  await p.goto(base + '#catalog');
  await p.tap('#add-btn');
  assert.equal((await line()).says, null, 'no line under the number to begin with');
  await p.fill('#e-num', '21318');
  await p.press('#e-num', 'Enter'); // the keyboard's Done
  let l = await line();
  assert.deepEqual([l.says, await p.textContent('.toast'), await p.textContent('#e-save')], [ASK, ASK, 'Add another copy']);
  // A phone's keyboard covers from about y 508 of 844 down.
  assert.ok(l.under >= 0 && l.under < 24 && l.bottom < 500, 'the line is right under the number box, in the top half of the screen ' + JSON.stringify(l));
  assert.ok(l.toast < 500, 'and the message is at the top of the screen, not under a keyboard (' + l.toast + ')');
  await p.evaluate(() => document.querySelector('.toast span').click());
  assert.deepEqual([(await line()).says, await p.locator('.toast').isHidden()], [ASK, true], 'the line stays when the message has gone');
  await p.fill('#e-num', '21319');
  assert.deepEqual([(await line()).says, await p.textContent('#e-save')], [null, 'Add set'], 'and goes when the number changes');
  await p.fill('#e-num', '21318');
  await p.press('#e-num', 'Enter');
  await p.waitForTimeout(650);
  await p.press('#e-num', 'Enter');
  await p.waitForFunction(() => !document.querySelector('.scrim'));
  assert.equal(await p.locator('#list-wrap .item').count(), 3, 'Done a second time adds the second copy');
  // A set whose number is changed to one you have: the same, in its own words.
  await p.click('.item:has-text("Orchid")');
  await p.fill('#e-num', '21318');
  await p.click('#e-save');
  assert.deepEqual([(await line()).says, await p.textContent('#e-save')], ['You already have Tree House (Living room › Bookcase). Tap again to keep both.', 'Save anyway']);
  await discard(p);
  await c.close();
}

// Messages can be read and acted on by everyone. The place they're shown in is on the page from the start (a screen
// reader tends to miss one that arrives with its first words in it). A message stays longer the more there is to
// read, 10 seconds with a button, and waits while the mouse is on it or its button has the keyboard's focus. Ctrl+Z
// presses Undo while it shows (by keyboard the button came after every set in the list, and was gone first), except
// in a box being typed in. A button that turns into a question on its first press has its new words read out, and
// a set number that's refused marks its box as wrong.
{
  const { c, p } = await withSets({ sets: { t: { id: 't', t: 1, num: '21318-1', name: 'Tree House', state: 'built', room: 'Living room' }, o: { id: 'o', t: 1, name: 'Orchid', state: 'built' } } },
    { viewport: { width: 1280, height: 800 }, hasTouch: false, deviceScaleFactor: 1 });
  await p.clock.install();
  await p.goto(base + '#catalog');
  const region = () => p.evaluate(() => { const r = document.querySelectorAll('[role="status"]'); return [r.length, r[0].contains(document.querySelector('.toast')), document.querySelector('.toast').hidden]; });
  assert.deepEqual(await region(), [1, true, true], 'the place for messages is there before the first one');
  const up = () => p.evaluate(() => !document.querySelector('.toast').hidden);
  // How long each kind stays: the clock is the page's own, moved on by hand.
  const lasts = async (show, ms) => {
    await p.evaluate(show);
    await p.clock.runFor(ms - 200);
    const before = await up();
    await p.clock.runFor(400);
    return [before, await up()];
  };
  assert.deepEqual(await lasts(() => window.brickyard.toast('Saved'), 3200), [true, false], 'a short message: 3.2 seconds');
  assert.deepEqual(await lasts(() => window.brickyard.toast('You already have Large Creative Brick Box (Office › Closet). Tap again to add a second copy.'), 3200 + 50 * 50), [true, false], '90 characters: 5.7 seconds');
  assert.deepEqual(await lasts(() => window.brickyard.toast('x'.repeat(400)), 10000), [true, false], 'never more than 10 seconds');
  assert.deepEqual(await lasts(() => window.brickyard.toast('Removed Orchid', false, { label: 'Undo', run() {} }), 10000), [true, false], 'one with a button: 10 seconds');
  assert.deepEqual(await lasts(() => window.brickyard.toast('This browser wouldn’t save.', true), 6000), [true, false], 'a held warning: 6 seconds at least');
  assert.deepEqual(await region(), [1, true, true], 'and the place is still the same one');
  // It waits under the mouse, and while its button has the focus.
  await p.evaluate(() => window.brickyard.toast('Removed Orchid', false, { label: 'Undo', run() {} }));
  await p.hover('.toast span');
  await p.clock.runFor(30000);
  assert.equal(await up(), true, 'it stays while the mouse is on it');
  await p.mouse.move(10, 10);
  await p.clock.runFor(11000);
  assert.equal(await up(), false, 'and goes once the mouse has left');
  await p.evaluate(() => window.brickyard.toast('Removed Orchid', false, { label: 'Undo', run() {} }));
  await p.focus('.toast button');
  await p.clock.runFor(30000);
  assert.equal(await up(), true, 'it stays while its button has the focus');
  await p.focus('#q');
  await p.clock.runFor(11000);
  assert.equal(await up(), false);
  // A message that can wait doesn't take an Undo's place.
  await p.evaluate(() => { window.brickyard.toast('Removed Orchid', false, { label: 'Undo', run() {} }); window.brickyard.toastAfter('Sync didn’t work.'); });
  assert.equal(await p.textContent('.toast span'), 'Removed Orchid');
  await p.clock.runFor(10500);
  assert.deepEqual([await up(), await p.textContent('.toast span')], [true, 'Sync didn’t work.'], 'it shows once the Undo has gone');
  await p.clock.runFor(4000);
  // Several that wait are each shown in turn (it was the last one only), and the same words aren't kept twice.
  await p.evaluate(() => {
    const b = window.brickyard;
    b.toast('Removed Orchid', false, { label: 'Undo', run() {} });
    b.toastAfter('From your other devices: 3 sets added'); b.toastAfter('Google signs Brickyard out after an hour. Tap Sync to sync again.'); b.toastAfter('From your other devices: 3 sets added');
  });
  await p.clock.runFor(10500);
  assert.deepEqual([await up(), await p.textContent('.toast span')], [true, 'From your other devices: 3 sets added'], 'the first that waited shows once the Undo has gone');
  await p.clock.runFor(3700);
  assert.deepEqual([await up(), await p.textContent('.toast span')], [true, 'Google signs Brickyard out after an hour. Tap Sync to sync again.'], 'then the second');
  await p.clock.runFor(6000);
  assert.equal(await up(), false, 'and nothing is said twice');
  // Ctrl+Z is Undo while the button shows.
  const sets = () => p.locator('.item .t').allTextContents();
  await p.focus('.item:has-text("Tree House")');
  await p.keyboard.press('Enter');
  await p.focus('#e-del');
  await p.keyboard.press('Enter');
  await p.clock.runFor(100);
  assert.equal(await p.textContent('[role="status"] .vh'), 'Tap again to remove', 'the button’s new words are read out');
  await p.clock.runFor(700);
  await p.keyboard.press('Enter');
  assert.deepEqual([await sets(), await p.getAttribute('.toast button', 'title')], [['Orchid'], 'Undo (Ctrl+Z)']);
  await p.focus('#q');
  await p.keyboard.press('Control+z');
  assert.deepEqual(await sets(), ['Orchid'], 'in the search box Ctrl+Z is the box’s own');
  await p.focus('.item');
  await p.keyboard.press('Control+z');
  assert.deepEqual([await sets(), await p.textContent('.toast span')], [['Tree House', 'Orchid'], 'Tree House is back'], 'anywhere else it puts the set back');
  await p.keyboard.press('Control+z');
  assert.deepEqual(await sets(), ['Tree House', 'Orchid'], 'and does nothing with no Undo showing');
  // Close with changes: its question is read out too.
  await p.click('.item:has-text("Orchid")');
  await p.fill('#e-notes', 'a gift');
  await p.keyboard.press('Escape');
  await p.clock.runFor(100);
  assert.equal(await p.textContent('[role="status"] .vh'), 'Discard changes?');
  // A set number that's refused: a line under its box says so, as the box's description, and is read out, until
  // the box is changed.
  await p.fill('#e-num', 'hello');
  await p.press('#e-num', 'Enter');
  await p.clock.runFor(100);
  const NUM = 'That set number doesn’t look right. It’s usually 4 or 5 digits.';
  assert.deepEqual([await p.getAttribute('#e-num', 'aria-invalid'), await p.textContent('#' + await p.getAttribute('#e-num', 'aria-describedby')), await p.textContent('[role="status"] .vh'), await p.evaluate(() => document.activeElement.id)], ['true', NUM, NUM, 'e-num']);
  await p.fill('#e-num', '10311');
  assert.deepEqual([await p.getAttribute('#e-num', 'aria-invalid'), await p.getAttribute('#e-num', 'aria-describedby'), await p.locator('.sheet .err').count()], [null, null, 0]);
  await c.close();
}

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

// A backup can bring back a set removed since it was saved. Merging keeps the later change, and the removal is the
// later one, so the set used to stay removed while the sheet said "Nothing here is lost". The sheet now counts those
// sets and offers to bring them back; left unticked, the merge is as before. A catalog that came by link says link.
{
  const { c, p } = await withSets({ sets: {
    t: { id: 't', t: 1, num: '21318-1', name: 'Tree House', notes: 'a gift', room: 'Living room' }, o: { id: 'o', t: 1, name: 'Orchid' }, b: { id: 'b', t: 1, name: 'Bonsai Tree' } } });
  const file = text => p.setInputFiles('#file', { name: 'Brickyard.json', mimeType: 'application/json', buffer: Buffer.from(text) });
  const names = async () => (await p.evaluate(() => Object.values(window.brickyard.doc().sets).filter(x => !x.del).map(x => x.name))).sort();
  await p.goto(base + '#catalog');
  const saved = await p.evaluate(() => JSON.stringify({ brickyard: 1, catalog: window.brickyard.doc() }));
  await file(saved);
  await p.waitForSelector('#cs-go');
  assert.equal(await p.textContent('#sheetTitle'), 'Open a Brickyard file');
  assert.equal(await p.textContent('.sheet .lede'), 'This file has 3 sets. Bringing it in merges it with what’s here, set by set: whichever was changed last is kept, and removing a set counts as a change. Sets that are only here stay.');
  assert.equal(await p.locator('#cs-back').count(), 0, 'with nothing removed since, there is nothing to bring back');
  await p.click('[data-close]');
  await p.click('.item:has-text("Tree House")');
  await p.click('#e-del'); await p.waitForTimeout(650); await p.click('#e-del');
  const gone = await p.evaluate(() => window.brickyard.doc().sets.t);
  await file(saved);
  await p.waitForSelector('#cs-go');
  assert.deepEqual([await p.isChecked('#cs-back'), await p.textContent('.sheet .check')], [false, 'Bring back the set removed here since this file was savedTree House'], 'the sheet offers to bring the removed set back, unticked');
  await p.click('#cs-go');
  assert.deepEqual([await p.textContent('.toast'), await names()], ['Merged. You have 2 sets.', ['Bonsai Tree', 'Orchid']], 'left unticked, the removal stands');
  await file(saved);
  await p.waitForSelector('#cs-go');
  await p.click('.sheet .check');
  await p.click('#cs-go');
  assert.deepEqual([await p.textContent('.toast'), await names()], ['Merged. 1 set brought back. You have 3 sets.', ['Bonsai Tree', 'Orchid', 'Tree House']], 'ticked, the set is back');
  const back = await p.evaluate(() => window.brickyard.doc().sets.t);
  assert.deepEqual([back.notes, back.room, back.t > gone.t], ['a gift', 'Living room', true], 'as the backup had it, and timed after its removal');
  assert.equal(await p.locator('.item:has-text("Tree House")').count(), 1);
  await file(saved);
  await p.waitForSelector('#cs-go');
  assert.equal(await p.locator('#cs-back').count(), 0, 'once back, there is nothing more to bring back');
  await p.click('[data-close]');
  // Two removed: the box counts them. The same catalog by link, or pasted as a link, is called a link.
  for (const name of ['Orchid', 'Bonsai Tree']) { await p.click(`.item:has-text("${name}")`); await p.click('#e-del'); await p.waitForTimeout(650); await p.click('#e-del'); }
  const link = '#b1z' + deflateRawSync(saved).toString('base64url');
  await p.goto(base + link);
  await p.waitForSelector('#cs-go');
  assert.equal(await p.textContent('#sheetTitle'), 'Your catalog from a link');
  assert.match(await p.textContent('.sheet .lede'), /^This link has 3 sets\. Bringing it in merges/);
  assert.equal(await p.textContent('.sheet .check'), 'Bring back the 2 sets removed here since this link was copiedOrchid, Bonsai Tree');
  await p.click('[data-close]');
  await p.click('#claude-btn');
  await p.fill('#paste', 'https://brickyard.junkdrawer.works/' + link);
  await p.click('#p-go');
  await p.waitForSelector('#cs-go');
  assert.equal(await p.textContent('#sheetTitle'), 'Your catalog from a link', 'a pasted link is a link too');
  await p.click('[data-close]');
  await p.click('#claude-btn');
  await p.fill('#paste', saved);
  await p.click('#p-go');
  await p.waitForSelector('#cs-go');
  assert.equal(await p.textContent('#sheetTitle'), 'Open a Brickyard file', 'and a file’s text is a file');
  await p.click('#cs-back');
  await p.click('#cs-go');
  assert.deepEqual([await p.textContent('.toast'), await names()], ['Merged. 2 sets brought back. You have 3 sets.', ['Bonsai Tree', 'Orchid', 'Tree House']]);
  await c.close();
}

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
// A model that hasn't been started opens on the finished model: its name, pieces and steps, every piece in the
// picture, and Start building where Next will be, with nothing to go back or slide to yet. (It opened on step 1,
// one plate in an empty picture, and the finished model was first seen seven taps later.)
const shown = () => page.evaluate(() => window.BrickyardBuild.inView().shown);
assert.deepEqual([await page.textContent('.stepnum'), await page.textContent('#step-next'), await page.textContent('#step-parts'), await page.isVisible('#step-prev'), await page.isVisible('#step-range'), await shown()],
  ['Finished model', 'Start building', 'Cottage: 40 pieces in 7 steps. This is how it looks when it’s built. Drag it around to look it over.', false, false, 40], 'a model opens on its finished picture');
const under = () => page.evaluate(() => Math.round(document.getElementById('step-parts').getBoundingClientRect().top));
const top = await under();
await page.click('#step-next');
assert.deepEqual([await page.textContent('.stepnum'), await page.textContent('#step-next'), await page.isVisible('#step-prev'), await page.isVisible('#step-range'), await shown(), await under()],
  ['Step 1 of 7', 'Next', true, true, 1, top], 'Start building goes to step 1, and nothing under the picture moves');
assert.equal(await page.textContent('#step-n'), 'Step 1');
// Arrow keys move one step, on the step slider or with nothing focused.
await page.focus('#step-range');
await page.keyboard.press('ArrowRight');
assert.equal(await page.textContent('#step-n'), 'Step 2', 'an arrow key on the slider moves one step');
await page.evaluate(() => document.activeElement.blur());
await page.keyboard.press('ArrowLeft');
assert.equal(await page.textContent('#step-n'), 'Step 1', 'and with nothing focused');
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
await page.click('#model-menu');
await page.dblclick('#mm-del');
assert.equal(await page.evaluate(() => Object.keys(JSON.parse(localStorage.getItem('brickyard.models'))).length), 1, 'a double tap does not remove a model');
await page.click('[data-close]');
await page.goto(base + '#build');
await page.waitForSelector('#build-list .group');
assert.match(await page.textContent('#build-list'), /Linked cottage/);
assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'the build screen scrolls sideways on a phone');

// A reload reopens a model on the step it was on (kept for the tab, per model), with the address still #model-ID.
{
  const { c, p } = await withSets({ sets: {} });
  const step = () => p.textContent('#step-n');
  await p.goto(base + '#model-x-cottage');
  await p.waitForSelector('#model-view:not([hidden])');
  assert.equal(await step(), 'Finished model');
  await p.click('#step-next');
  await p.reload();
  await p.waitForSelector('#model-view:not([hidden])');
  assert.equal(await step(), 'Step 1', 'once started, a reload opens it on step 1, not on the finished picture again');
  await p.click('#step-next'); await p.click('#step-next');
  assert.equal(await step(), 'Step 3');
  await p.reload();
  await p.waitForSelector('#model-view:not([hidden])');
  assert.deepEqual([await step(), await p.evaluate(() => location.hash)], ['Step 3', '#model-x-cottage'], 'a reload reopens the model on its step');
  const wall = { brickyard: 1, model: { name: 'Wall', parts: Array.from({ length: 4 }, (_, i) => ['3001', 4, 0, i * 3, 0, 0, i + 1]) } };
  await p.goto(base + '#d1z' + deflateRawSync(JSON.stringify(wall)).toString('base64url'));
  await p.waitForFunction(() => location.hash.startsWith('#model-m'));
  await p.waitForSelector('#model-view:not([hidden])');
  assert.equal(await step(), 'Finished model', 'another model, not started, opens on its finished picture');
  await p.goto(base + '#build');
  await p.click('#build-list a[href="#model-x-cottage"]');
  await p.waitForSelector('#model-view:not([hidden])');
  assert.equal(await step(), 'Step 3', 'and the first is still on its step');
  await c.close();
}

// What a step adds stands out in the picture: its pieces have the crisp outline and everything built before is
// faded a little; the finished model is at full colour. (Step 5's four yellow slopes looked like the yellow walls.)
// Finishing with Next turns the model round once; a touch stops it, a change of step puts it back, the slider to
// the end doesn't start it, and with less motion asked for it doesn't happen. The card says what was built.
{
  const { c, p } = await withSets({ sets: {} });
  const view = () => p.evaluate(() => { const v = window.BrickyardBuild.inView(); return [v.shown, v.now, v.faded, v.spin]; });
  const box = () => p.evaluate(() => window.BrickyardBuild.inView().box.map(n => n.toFixed(3)).join());
  const slide = to => p.evaluate(to => { const r = document.getElementById('step-range'); r.value = String(+r.max + to); r.dispatchEvent(new Event('input')); }, to);
  await p.goto(base + '#model-x-cottage');
  await p.waitForFunction(() => window.BrickyardBuild.inView());
  assert.deepEqual(await view(), [40, 0, 0, false], 'the finished picture a model opens on is at full colour');
  const home = await box();
  const settled = () => p.waitForFunction(() => !window.BrickyardBuild.inView().glide);
  await p.click('#step-next');
  await settled();
  const one = await box(); // step 1, framed on its one plate
  for (let i = 0; i < 4; i++) await p.click('#step-next');
  assert.deepEqual([await p.textContent('.stepnum'), await view()], ['Step 5 of 7', [27, 4, 23, false]], 'step 5: its four slopes stand out, the 23 pieces under them are faded');
  await slide(0);
  assert.deepEqual([await p.textContent('#step-parts'), await view()], ['That’s the Cottage: 40 pieces in 7 steps.', [40, 0, 0, false]], 'the slider to the end: full colour, and no turn');
  await slide(-1);
  assert.deepEqual([await p.textContent('#step-next'), (await view()).slice(1)], ['Finish', [9, 31, false]]);
  await p.click('#step-next');
  assert.deepEqual([await p.textContent('.stepnum'), await view()], ['Done · 40 pieces', [40, 0, 0, true]], 'Finish turns the finished model');
  await p.waitForFunction(was => window.BrickyardBuild.inView().box.map(n => n.toFixed(3)).join() !== was, home);
  await p.tap('#stage');
  assert.deepEqual([(await view())[3], await p.isVisible('#stage-reset')], [false, true], 'a touch on the picture stops the turn where it is');
  await p.click('#stage-reset');
  assert.equal(await box(), home);
  await slide(-1); await p.click('#step-next');
  assert.equal((await view())[3], true);
  await p.waitForFunction(was => window.BrickyardBuild.inView().box.map(n => n.toFixed(3)).join() !== was, home);
  await p.click('#step-next'); // From the start
  await settled();
  assert.deepEqual([await p.textContent('.stepnum'), (await view())[3], await box()], ['Step 1 of 7', false, one], 'a change of step stops the turn and puts the picture back');
  // A name that brings its own first word keeps it.
  await p.goto(base + '#d1z' + deflateRawSync(JSON.stringify({ brickyard: 1, model: { name: 'My first wall', parts: [['3001', 4, 0, 0, 0, 0, 1], ['3001', 4, 0, 3, 0, 0, 2]] } })).toString('base64url'));
  await p.waitForFunction(() => document.getElementById('build-title').textContent === 'My first wall');
  await p.evaluate(() => { const r = document.getElementById('step-range'); r.value = r.max; r.dispatchEvent(new Event('input')); });
  assert.equal(await p.textContent('#step-parts'), 'That’s My first wall: 2 pieces in 2 steps.');
  await c.close();
  const calm = await withSets({ sets: {} }, { reducedMotion: 'reduce' });
  await calm.p.goto(base + '#model-x-cottage');
  await calm.p.waitForFunction(() => window.BrickyardBuild.inView());
  await calm.p.evaluate(() => { const r = document.getElementById('step-range'); r.value = String(+r.max - 1); r.dispatchEvent(new Event('input')); });
  await calm.p.click('#step-next');
  assert.deepEqual([await calm.p.textContent('.stepnum'), await calm.p.evaluate(() => window.BrickyardBuild.inView().spin)], ['Done · 40 pieces', false], 'with less motion asked for, the finished model stays still');
  await calm.c.close();
}

// The picture is framed on what's built so far: on a tall model the first steps were a small patch at the bottom
// of a picture framed for the finished model. It moves out as the model grows, never nearer than a third of the
// way in from where the whole model fits, and stops following once the picture has been turned or zoomed, until
// Reset view. The picture a model opens on and Done show the whole model.
{
  const tall = { name: 'Lighthouse', parts: [['3028', 2, 0, 0, 0, 0, 1], ['3001', 4, 2, 1, 2, 0, 2], ['3001', 4, 6, 1, 2, 0, 2]].concat(Array.from({ length: 26 }, (_, i) => ['3003', i % 2 ? 4 : 15, 5, 4 + i * 3, 2, 0, 3 + Math.floor(i / 2)])) };
  const link = m => base + '#d1z' + deflateRawSync(JSON.stringify({ brickyard: 1, model: m })).toString('base64url');
  const { c, p } = await withSets({ sets: {} }, { reducedMotion: 'reduce' }); // no gliding, so where the camera goes can be read at once
  const view = () => p.evaluate(() => window.BrickyardBuild.inView());
  const inside = b => b.every(n => n >= -0.001 && n <= 1.001), widest = b => Math.max(b[2] - b[0], b[3] - b[1]), near = (a, b) => Math.abs(a - b) < 0.005;
  await p.goto(link(tall));
  await p.waitForFunction(() => document.getElementById('build-title').textContent === 'Lighthouse' && window.BrickyardBuild.inView());
  let v = await view();
  assert.ok(near(v.far, 1) && inside(v.box) && widest(v.box) > 0.8, 'the finished picture shows the whole model: ' + JSON.stringify(v));
  await p.click('#step-next'); await p.click('#step-next');
  v = await view();
  assert.equal(await p.textContent('.stepnum'), 'Step 2 of 15');
  assert.ok(inside(v.built) && widest(v.built) > 0.8 && v.far < 0.5 && v.box[1] < 0, 'step 2 of a tall model fills the picture, framed on what’s built: ' + JSON.stringify(v));
  for (let i = 3, last = v.far; i <= 15; i++, last = v.far) {
    await p.click('#step-next');
    v = await view();
    assert.ok(inside(v.built) && widest(v.built) > 0.8 && v.far >= last - 0.001 && v.far <= 1.001, 'step ' + i + ' is framed on what’s built, no nearer than the step before: ' + JSON.stringify(v));
  }
  await p.click('#step-next');
  v = await view();
  assert.ok((await p.textContent('.stepnum')).startsWith('Done') && near(v.far, 1) && inside(v.box), 'Done shows the whole model');
  // One 2x2 brick of a tower of thirty doesn't fill the stage: the camera stops a third of the way in.
  await p.goto(link({ name: 'Tower', parts: Array.from({ length: 30 }, (_, i) => ['3003', i % 2 ? 4 : 15, 0, i * 3, 0, 0, i + 1]) }));
  await p.waitForFunction(() => document.getElementById('build-title').textContent === 'Tower');
  await p.click('#step-next');
  v = await view();
  assert.ok(near(v.far, 1 / 3) && inside(v.built), 'no nearer than a third of the way in: ' + v.far);
  // Zoomed by hand, the picture is left where it was put at the next step; Reset view frames the step again.
  await p.focus('#stage'); await p.keyboard.press('-');
  const mine = (await view()).far;
  await p.click('#step-next'); await p.click('#step-next');
  v = await view();
  assert.deepEqual([await p.textContent('.stepnum'), v.moved, near(v.far, mine)], ['Step 3 of 30', true, true], 'once it has been zoomed, the picture stays where it was put');
  await p.click('#stage-reset');
  v = await view();
  assert.ok(!v.moved && near(v.far, 1 / 3) && inside(v.built), 'Reset view frames the step again: ' + v.far);
  await p.evaluate(() => { const r = document.getElementById('step-range'); r.value = '20'; r.dispatchEvent(new Event('input')); });
  v = await view();
  assert.ok(v.far > 0.6 && inside(v.built), 'and it follows the steps again: ' + v.far);
  await c.close();
  // With motion, the camera glides to the same place.
  const m = await withSets({ sets: {} });
  await m.p.goto(link(tall));
  await m.p.waitForFunction(() => document.getElementById('build-title').textContent === 'Lighthouse' && window.BrickyardBuild.inView());
  await m.p.click('#step-next'); await m.p.click('#step-next');
  await m.p.waitForFunction(() => !window.BrickyardBuild.inView().glide);
  const still = await m.p.evaluate(() => window.BrickyardBuild.inView());
  const moving = await m.p.evaluate(() => { document.getElementById('step-next').click(); return window.BrickyardBuild.inView(); });
  await m.p.waitForFunction(() => !window.BrickyardBuild.inView().glide);
  v = await m.p.evaluate(() => window.BrickyardBuild.inView());
  assert.ok(moving.glide && near(moving.far, still.far) && v.far > still.far + 0.005 && inside(v.built), 'with motion, the camera glides out to the new step: ' + [still.far, moving.far, v.far]);
  await m.c.close();
}

// Four buttons on the picture turn it left and right and zoom out and in, a tap each: turning took a drag and
// zooming two fingers or a wheel (WCAG 2.2 SC 2.5.7 Dragging Movements, SC 2.5.1 Pointer Gestures). They sit in the
// picture's bottom corners, clear of each other and of the hint, and count as moving the picture (Reset view).
{
  const { c, p } = await withSets({ sets: {} }, { reducedMotion: 'reduce' });
  await p.goto(base + '#model-x-cottage');
  await p.waitForFunction(() => window.BrickyardBuild.inView());
  const box = () => p.evaluate(() => window.BrickyardBuild.inView().box.map(n => n.toFixed(3))), wide = b => b[2] - b[0];
  const keys = await p.$$eval('#stage-keys button', bs => bs.map(b => { const r = b.getBoundingClientRect(); return [b.getAttribute('aria-label'), Math.round(r.width), Math.round(r.height), Math.round(r.left), Math.round(r.right)]; }));
  assert.deepEqual(keys.map(k => k.slice(0, 3)), [['Turn left', 44, 44], ['Turn right', 44, 44], ['Zoom out', 44, 44], ['Zoom in', 44, 44]]);
  const stage = await p.locator('.stage').boundingBox(), hint = await p.locator('#stage-hint').boundingBox(), first = await p.locator('#stage-keys button >> nth=0').boundingBox();
  assert.ok(keys[1][4] < keys[2][3] && hint.y + hint.height < first.y && first.y + first.height <= stage.y + stage.height, 'the buttons are inside the picture, apart, and under the hint');
  const home = await box();
  // A phone's picture is taller than the cottage fitted to its width: the model sits in the room above the buttons.
  assert.ok(home[3] * stage.height <= first.y - stage.y + 1 && home[1] >= 0.05, 'the model sits above the buttons, inside the picture: ' + home + ', buttons from ' + ((first.y - stage.y) / stage.height).toFixed(3));
  assert.equal(await p.isHidden('#stage-reset'), true);
  await p.tap('[data-turn="left"]');
  const left = await box();
  assert.deepEqual([left.join() !== home.join(), await p.isVisible('#stage-reset'), await p.textContent('.stepnum')], [true, true, 'Finished model'], 'Turn left turns the picture, and leaves the step');
  await p.tap('#stage-reset');
  await p.focus('#stage'); await p.keyboard.press('ArrowLeft');
  assert.deepEqual(await box(), left, 'as the left arrow key does');
  await p.tap('[data-turn="right"]');
  assert.deepEqual(await box(), home, 'Turn right turns it back');
  await p.tap('[data-zoom="in"]');
  assert.ok(wide(await box()) > wide(home) * 1.1, 'Zoom in');
  await p.tap('[data-zoom="out"]'); await p.tap('[data-zoom="out"]');
  assert.ok(wide(await box()) < wide(home) * 0.9, 'Zoom out');
  await p.tap('#stage-reset');
  assert.deepEqual(await box(), home);
  await c.close();
}

// Under a step's pieces, "Where they go" says in words where each one goes (a piece's place was only in the
// picture). It's folded away, stays open once opened, and is open from the start where there is no picture.
{
  const { c, p } = await withSets({ sets: {} });
  await p.goto(base + '#model-x-cottage');
  await p.waitForSelector('#model-view:not([hidden])');
  assert.equal(await p.locator('details.where').count(), 0, 'nothing to place on the finished picture');
  await p.click('#step-next');
  const where = () => p.$eval('details.where', d => [d.open, d.querySelector('summary').textContent, [...d.querySelectorAll('li')].map(l => l.textContent)]);
  assert.deepEqual(await where(), [false, 'Where they go', ['Plate 6x12, Bright Green: on the table, the full width, front to back']], 'step 1: folded, one line');
  assert.ok((await p.locator('details.where summary').boundingBox()).height >= 44, 'its heading is 44 px to tap');
  await p.tap('details.where summary');
  assert.equal(await p.isVisible('details.where li'), true);
  await p.click('#step-next');
  const two = await where();
  assert.deepEqual([two[0], two[2].length, two[2][0]], [true, 7, 'Brick 1x4, Bright Light Yellow: 1 plate up, on the bright green 6x12 plate, 2 studs in from the left, 1 stud back from the front, running left to right'],
    'step 2: still open, a line for each of its seven pieces');
  assert.equal(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'and nothing runs off the side');
  await p.evaluate(() => { const r = document.getElementById('step-range'); r.value = r.max; r.dispatchEvent(new Event('input')); });
  assert.equal(await p.locator('details.where').count(), 0, 'none at Done');
  await c.close();
  // No 3D in this browser: the list is open, since it's all there is to build from.
  const no = await withSets({ sets: {} });
  await no.p.addInitScript(() => { const real = HTMLCanvasElement.prototype.getContext; HTMLCanvasElement.prototype.getContext = function (kind, ...a) { return /webgl/.test(kind) ? null : real.call(this, kind, ...a); }; });
  await no.p.goto(base + '#model-x-cottage');
  await no.p.reload(); // the page starts again, without WebGL this time
  await no.p.waitForSelector('#model-view:not([hidden])');
  assert.match(await no.p.textContent('#stage-hint'), /can’t show 3D here/);
  // With no picture there is no finished picture to open on either: it opens on step 1 (it said "This is how it
  // looks when it's built. Drag it around to look it over." over an empty box).
  assert.deepEqual([await no.p.textContent('.stepnum'), await no.p.textContent('#step-next')], ['Step 1 of 7', 'Next'], 'with no picture, a model opens on step 1');
  assert.deepEqual([await no.p.$eval('details.where', d => d.open), await no.p.isHidden('#stage-keys')], [true, true], 'with no picture, Where they go is open, and there are no turn and zoom buttons');
  await no.c.close();
}

// A model's menu copies it as a link, the checked kind Claude's script makes, which opens the same model on another
// device (models stay on each device). A very long one says so; where the browser won't copy, the link is shown to
// copy by hand. The example has no such row.
{
  const wall = n => ({ name: 'Wall of ' + n, about: 'A test wall.', parts: Array.from({ length: n }, (_, i) => ['3001', (i * 37) % 500, (i * 7919) % 400 - 200, n > 4 ? (i * 31) % 600 : i * 3, (i * 104729) % 400 - 200, 0, i + 1]) });
  const link = m => base + '#d1z' + deflateRawSync(JSON.stringify({ brickyard: 1, model: m })).toString('base64url');
  for (const [n, says] of [[4, 'Copied. Open the link on your other device, or send it to someone.'], [1500, 'Copied. It’s a long link; if it won’t open, Download a backup in My sets’ menu holds your models too.']]) {
    const { c, p } = await withSets({ sets: {} }, { permissions: ['clipboard-read', 'clipboard-write'] });
    await p.goto(link(wall(n)));
    await p.waitForFunction(n => document.getElementById('build-title').textContent === 'Wall of ' + n, n);
    await p.click('#model-menu');
    assert.deepEqual(await p.$$eval('.sheet .menu button', bs => bs.map(b => b.querySelector('span').firstChild.textContent)), ['All the pieces', 'I’ve built this', 'Copy a link to this model', 'Rename', 'Remove from my models'], 'a model’s menu');
    await p.click('#mm-link');
    await p.waitForFunction(() => document.querySelector('.toast') && !document.querySelector('.toast').hidden);
    const copied = await p.evaluate(() => navigator.clipboard.readText());
    assert.deepEqual([await p.textContent('.toast'), copied.length > 8000, await p.locator('.sheet').count()], [says, n > 4, 0], 'what Copy a link to this model says for a link of ' + copied.length + ' characters');
    assert.match(copied, /^https:\/\/brickyard\.junkdrawer\.works\/#d2z[A-Za-z0-9_-]+$/, 'it is a checked model link');
    assert.equal(copied.slice(copied.indexOf('#')), checked('d2z', copied.slice(copied.indexOf('#') + 4, -7)), 'with the check on its end');
    if (n === 4) {
      const mine = await p.evaluate(() => Object.values(JSON.parse(localStorage.getItem('brickyard.models')))[0].model);
      const other = await withSets({ sets: {} });
      await other.p.goto(base + copied.slice(copied.indexOf('#')));
      await other.p.waitForFunction(() => document.getElementById('build-title').textContent === 'Wall of 4');
      assert.deepEqual(await other.p.evaluate(() => Object.values(JSON.parse(localStorage.getItem('brickyard.models')))[0].model), mine, 'and it opens the same model on another device');
      await other.c.close();
    }
    await c.close();
  }
  // No clipboard (a browser that won't let the page copy): the link is shown, selected, to copy by hand.
  const { c, p } = await withSets({ sets: {} });
  await p.addInitScript(() => { Object.defineProperty(navigator, 'clipboard', { value: { writeText: () => Promise.reject(new Error('no')) } }); });
  await p.goto(link(wall(4)));
  await p.reload();
  await p.waitForFunction(() => document.getElementById('build-title').textContent === 'Wall of 4');
  await p.click('#model-menu'); await p.click('#mm-link');
  await p.waitForSelector('#model-link');
  assert.deepEqual([await p.textContent('#sheetTitle'), /#d2z/.test(await p.inputValue('#model-link')), await p.evaluate(() => { const t = document.getElementById('model-link'); return t.selectionEnd - t.selectionStart === t.value.length; })],
    ['This model as a link', true, true], 'where it can’t be copied, the link is shown to copy');
  await p.click('[data-close]');
  await p.goto(base + '#model-x-cottage');
  await p.waitForFunction(() => document.getElementById('build-title').textContent === 'Cottage');
  await p.click('#model-menu');
  assert.deepEqual(await p.$$eval('.sheet .menu button', bs => bs.map(b => b.id)), ['mm-parts', 'mm-built'], 'the example has only All the pieces and I’ve built this');
  await c.close();
}

// Rename, in a model's menu: two versions Claude both called "Lighthouse" could only be told apart by date. The
// new name shows on the model, in the list and in its link, stays when Claude's link to the same model is opened
// again (which still brings a new description), and an empty name is refused under the box.
{
  const { c, p } = await withSets({ sets: {} }, { permissions: ['clipboard-read', 'clipboard-write'] });
  const model = about => ({ name: 'Lighthouse', about, parts: [['3001', 4, 0, 0, 0, 0, 1], ['3001', 15, 0, 3, 0, 0, 2]] });
  const link = m => base + '#d1z' + deflateRawSync(JSON.stringify({ brickyard: 1, model: m })).toString('base64url');
  const kept = () => p.evaluate(() => Object.values(JSON.parse(localStorage.getItem('brickyard.models'))).map(v => [v.model.name, v.model.about, v.named === true, typeof v.added]));
  await p.goto(link(model('First try.')));
  await p.waitForFunction(() => document.getElementById('build-title').textContent === 'Lighthouse');
  await p.click('#model-menu'); await p.click('#mm-name');
  assert.deepEqual([await p.textContent('#sheetTitle'), await p.inputValue('#mn-name')], ['Rename this model', 'Lighthouse']);
  await p.fill('#mn-name', '   ');
  await p.click('#mn-save');
  assert.deepEqual([await p.textContent('#mn-name-err'), await p.getAttribute('#mn-name', 'aria-invalid'), (await kept())[0][0]], ['Give it a name.', 'true', 'Lighthouse'], 'an empty name is refused, under the box');
  await p.fill('#mn-name', '  Lighthouse,   striped ');
  await p.press('#mn-name', 'Enter');
  await p.waitForFunction(() => !document.querySelector('.sheet'));
  assert.deepEqual([await p.textContent('.toast'), await p.textContent('#build-title'), await p.title(), await p.textContent('#step-parts'), await kept()],
    ['Renamed to Lighthouse, striped', 'Lighthouse, striped', 'Lighthouse, striped · Brickyard', 'Lighthouse, striped: 2 pieces in 2 steps. This is how it looks when it’s built. Drag it around to look it over.', [['Lighthouse, striped', 'First try.', true, 'number']]],
    'the new name shows on the model and is saved with it');
  await p.click('#model-menu'); await p.click('#mm-link');
  await p.waitForFunction(() => /Copied/.test(document.querySelector('.toast').textContent));
  const copied = await p.evaluate(() => navigator.clipboard.readText());
  // Claude's link again, with a new description: the description comes in, the name you gave stays, and it's one model.
  await p.goto(link(model('Second try.')));
  await p.waitForFunction(() => document.getElementById('model-about').textContent === 'Second try.');
  assert.deepEqual([await p.textContent('#build-title'), await kept()], ['Lighthouse, striped', [['Lighthouse, striped', 'Second try.', true, 'number']]], 'the same model from Claude again keeps the name you gave it');
  await p.goto(base + '#build');
  await p.waitForSelector('#build-list .list .item');
  assert.match(await p.textContent('#build-list .list .item'), /^Lighthouse, striped2 pieces · 2 steps/);
  const other = await withSets({ sets: {} });
  await other.p.goto(base + copied.slice(copied.indexOf('#')));
  await other.p.waitForFunction(() => document.getElementById('build-title').textContent === 'Lighthouse, striped');
  await other.c.close();
  await c.close();
}

// The step slider sits clear of the buttons, and a finger moves it only by its knob: a tap that lands low on Next
// is one step (it jumped to the end), a tap or a swipe that starts on the track leaves the step alone, and
// dragging the knob still works. A screen reader hears the step, not a bare number one behind.
{
  const { c, p } = await withSets({ sets: {} });
  await p.goto(base + '#model-x-cottage');
  await p.waitForSelector('#model-view:not([hidden])');
  const step = () => p.textContent('.stepnum'), box = sel => p.locator(sel).boundingBox();
  const said = () => p.$eval('#step-range', e => [e.value, e.getAttribute('aria-valuetext')]);
  await p.tap('#step-next'); // Start building
  assert.deepEqual([await step(), await said()], ['Step 1 of 7', ['0', 'Step 1 of 7']], 'the slider says the step it is on');
  assert.deepEqual(await p.$eval('.stepnum', e => [e.getAttribute('aria-live'), e.getAttribute('aria-atomic')]), ['polite', 'true'], 'a step change is read out');
  // Previous at the first step is off without being disabled, so it keeps the focus it has.
  await p.tap('#step-next');
  await p.focus('#step-prev');
  await p.keyboard.press('Enter');
  assert.deepEqual([await step(), await p.evaluate(() => document.activeElement.id), await p.getAttribute('#step-prev', 'aria-disabled'), await p.$eval('#step-prev', e => e.disabled)],
    ['Step 1 of 7', 'step-prev', 'true', false], 'Previous keeps the focus at the first step');
  await p.keyboard.press('Enter');
  assert.equal(await step(), 'Step 1 of 7', 'and does nothing there');
  await p.tap('#step-next');
  assert.equal(await p.getAttribute('#step-prev', 'aria-disabled'), 'false');
  // Measured together, once the font is in (it changes the buttons' height, and the taps below go by these) and
  // Next is no longer pressed (a pressed button sits 1 px lower).
  await p.evaluate(() => document.fonts.ready);
  await p.waitForFunction(() => !document.querySelector('#step-next:active'));
  let [next, prev, range] = await p.evaluate(() => ['step-next', 'step-prev', 'step-range'].map(id => { const r = document.getElementById(id).getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; }));
  assert.ok(range.y - Math.max(next.y + next.height, prev.y + prev.height) >= 12, 'the slider’s tap area starts at least 12 px under the buttons');
  await p.touchscreen.tap(next.x + next.width / 2, next.y + next.height - 2);
  assert.equal(await step(), 'Step 3 of 7', 'a tap 2 px above Next’s bottom edge is one step');
  await p.touchscreen.tap(prev.x + prev.width / 2, prev.y + prev.height - 2);
  assert.equal(await step(), 'Step 2 of 7', 'and the same on Previous');
  await p.touchscreen.tap(next.x + next.width / 2, next.y + next.height + 8);
  assert.equal(await step(), 'Step 2 of 7', 'a tap just under Next does nothing');
  await p.touchscreen.tap(range.x + range.width - 40, range.y + range.height / 2);
  await p.waitForTimeout(150);
  assert.deepEqual([await step(), await said()], ['Step 2 of 7', ['1', 'Step 2 of 7']], 'a tap on the track away from the knob leaves the step alone');
  const cdp = await c.newCDPSession(p);
  const touch = async (x0, y0, x1, y1) => {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x0, y: y0 }] });
    for (let k = 1; k <= 8; k++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x0 + (x1 - x0) * k / 8, y: y0 + (y1 - y0) * k / 8 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await p.waitForTimeout(400);
  };
  // A scroll that starts on the slider scrolls the page and leaves the step.
  await touch(range.x + 300, range.y + 22, range.x + 300, range.y - 230);
  assert.deepEqual([await step(), await p.evaluate(() => scrollY > 8)], ['Step 2 of 7', true], 'a swipe that starts on the slider scrolls the page and leaves the step');
  await p.evaluate(() => scrollTo(0, 0));
  await p.waitForTimeout(700); // past the moment the last touch still counts
  // Dragging the knob moves it: from step 2 (1 of 7 along) to the far end.
  range = await box('#step-range');
  const knob = range.x + 8 + (1 / 7) * (range.width - 16);
  await touch(knob, range.y + 22, range.x + range.width - 2, range.y + 22);
  assert.deepEqual([await step(), await said()], ['Done · 40 pieces', ['7', 'Done, 40 pieces']], 'dragging the knob to the end shows the finished model');
  assert.deepEqual(await p.$eval('#step-next', e => [e.textContent, e.classList.contains('quiet')]), ['From the start', true], 'at the end, From the start is a quiet button');
  await p.tap('#step-next');
  assert.deepEqual([await step(), await p.$eval('#step-next', e => e.classList.contains('quiet'))], ['Step 1 of 7', false]);
  // Arrow keys with Alt, Ctrl or the command key are the browser's (Alt+Left is Back), not a step.
  await p.tap('#step-next'); await p.tap('#step-next');
  await p.evaluate(() => document.activeElement.blur());
  for (const k of ['Alt', 'Control', 'Meta']) await p.evaluate(k => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', altKey: k === 'Alt', ctrlKey: k === 'Control', metaKey: k === 'Meta', bubbles: true })), k);
  assert.equal(await step(), 'Step 3 of 7', 'Alt, Ctrl or the command key with an arrow doesn’t move the step');
  await p.keyboard.press('ArrowLeft');
  assert.equal(await step(), 'Step 2 of 7');
  await c.close();
}
// On a laptop a click along the slider's track still jumps to that step.
{
  const { c, p } = await withSets({ sets: {} }, { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, hasTouch: false });
  await p.goto(base + '#model-x-cottage');
  await p.waitForSelector('#model-view:not([hidden])');
  await p.click('#step-next'); // Start building
  const range = await p.locator('#step-range').boundingBox();
  await p.mouse.click(range.x + range.width - 3, range.y + range.height / 2);
  assert.equal(await p.textContent('.stepnum'), 'Done · 40 pieces', 'a mouse click at the end of the track goes to the end');
  await c.close();
}
// Your pieces: the headings say what their numbers count, a tick keeps the focus when the list is redrawn, and
// removing a lot moves the focus to the next lot (or the heading), not nowhere. The icons in buttons are hidden
// from a screen reader, which reads the button's own name.
{
  const { c, p } = await withSets({ sets: { a: { id: 'a', t: 1, num: '10698-1', name: 'Large Creative Brick Box', pieces: 790, state: 'apart' } },
    loose: { tub: { id: 'tub', t: 1, name: 'Blue tub', parts: [['3001', 4, 20]] }, bag: { id: 'bag', t: 1, name: 'Red bag', parts: [['3001', 4, 6]] } } },
  { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, hasTouch: false });
  await p.goto(base + '#build');
  await p.waitForSelector('li.lot');
  assert.deepEqual(await p.$$eval('#build-list h2.group', hs => hs.map(h => h.getAttribute('aria-label'))), ['Your pieces, 816 pieces', 'Models, 1']);
  assert.equal(await p.$$eval('a svg, button svg, label svg', s => s.filter(x => x.getAttribute('aria-hidden') !== 'true').length), 0, 'every icon in a link, button or label is hidden from a screen reader');
  const focus = () => p.evaluate(() => { const e = document.activeElement; return e.dataset.pool || e.tagName + ' ' + e.textContent; });
  await p.focus('[data-pool="tub"]');
  await p.keyboard.press('Space');
  await p.waitForFunction(() => /796/.test(document.querySelector('.pieces .group').textContent));
  assert.equal(await focus(), 'tub', 'a tick keeps the focus when it is changed');
  await p.keyboard.press('Space');
  await p.waitForFunction(() => /816/.test(document.querySelector('.pieces .group').textContent));
  assert.equal(await focus(), 'tub');
  await p.click('[data-lot="tub"]');
  await p.click('#lot-drop');
  await p.waitForFunction(() => document.querySelectorAll('li.lot').length === 1);
  await p.waitForFunction(() => document.activeElement !== document.body);
  assert.equal(await focus(), 'bag', 'removing a lot moves the focus to the next one');
  await p.click('[data-lot="bag"]');
  await p.click('#lot-drop');
  await p.waitForFunction(() => !document.querySelector('li.lot'));
  await p.waitForFunction(() => document.activeElement !== document.body);
  assert.equal(await focus(), 'H2 Your pieces790', 'and with none left, to the heading');
  await c.close();
}

// Everyday part numbers, the ones BrickLink and Rebrickable use (3023 for a 1x2 plate, 4073 for a round 1x1 plate),
// are the pieces the builder knows under LDraw's current numbers (3023b, 6141): loose pieces counted under them
// can be used, are in what's copied for Claude, and a model written with them opens and builds.
{
  const tub = { id: 'tub', name: 'Blue tub', box: '4', parts: [['3023', 15, 50], ['3660', 4, 10], ['60481', 4, 6], ['4073', 14, 20], ['3001', 4, 12], ['3003', 1, 6], ['2780', 0, 4, 'Technic Pin']] };
  const { c, p } = await withSets({ sets: {} }, { permissions: ['clipboard-read', 'clipboard-write'] });
  await p.goto(base + '#l1z' + deflateRawSync(JSON.stringify({ brickyard: 1, loose: tub })).toString('base64url'));
  await p.waitForSelector('#ls-add');
  await p.waitForFunction(() => document.getElementById('ls-use').textContent !== '');
  assert.equal(await p.textContent('#ls-use'), 'The builder can use 104 of them today. The rest are kept, and count once Brickyard learns their shapes.', 'Add loose pieces counts pieces under their everyday numbers');
  await p.click('#ls-add');
  await p.waitForSelector('li.lot');
  assert.match(await p.textContent('li.lot'), /Loose · 108 pieces · Box 4 · the builder can use 104/, 'and so does Your pieces');
  assert.deepEqual((await p.evaluate(() => window.brickyard.doc().loose.tub.parts)).map(r => r[0]).sort(), ['2780', '3001', '3003', '3023', '3660', '4073', '60481'], 'the lot keeps the numbers it came with');
  await p.click('#copy-pool');
  await p.waitForSelector('.toast:not([hidden])');
  const copied = await p.evaluate(() => navigator.clipboard.readText());
  assert.match(copied, /Pieces the builder knows, as LDraw part\/colour ×count:\n3001\/4 ×12, 3003\/1 ×6, 3023b\/15 ×50, 3660b\/4 ×10, 60481a\/4 ×6, 6141\/14 ×20\n\(1 more kinds/, 'what’s copied for Claude has them, under the builder’s numbers');
  const model = { brickyard: 1, model: { name: 'Bare stack', parts: [['3023', 15, 0, 0, 0, 0, 1], ['3023', 15, 0, 1, 0, 0, 2], ['4073', 14, 0, 2, 0, 0, 3]] } };
  await p.goto(base + '#d1z' + deflateRawSync(JSON.stringify(model)).toString('base64url'));
  await p.waitForFunction(() => location.hash.startsWith('#model-m') && !document.getElementById('model-view').hidden);
  await p.click('#step-next'); // Start building
  assert.deepEqual([await p.locator('#model-check .flag.bad').count(), await p.textContent('#model-check .note.ok'), await p.textContent('#step-parts li')],
    [0, '✓ You have every piece for this, from loose pieces (Blue tub).', '1× Plate 1x2White'], 'a model written with everyday numbers opens and can be built');
  await c.close();
}

// The picture fits the model, across as well as up and down: on a phone the stage is narrower than it is tall, and
// a model 12 or 32 studs wide ran off both sides. It can't be turned to look from underneath (a blank slab), and
// Reset view, which shows once the picture has been moved, puts it back as it opened.
{
  const { c, p } = await withSets({ sets: {} });
  const open = async model => {
    await p.goto(base + '#d1z' + deflateRawSync(JSON.stringify({ brickyard: 1, model })).toString('base64url'));
    await p.waitForFunction(n => location.hash.startsWith('#model-m') && document.getElementById('build-title').textContent === n, model.name);
    return p.evaluate(() => window.BrickyardBuild.inView());
  };
  const inside = v => v.box.every(n => n >= 0 && n <= 1), fills = v => Math.max(v.box[2] - v.box[0], v.box[3] - v.box[1]);
  const wall = { name: 'Long wall', parts: Array.from({ length: 15 }, (_, i) => ['3001', i % 2 ? 4 : 15, i < 8 ? i * 4 : (i - 8) * 4 + 2, i < 8 ? 0 : 3, 0, 0, 1]) };
  const plate = { name: 'Wide plate', parts: [['3028', 2, 0, 0, 0, 0, 1], ['3001', 4, 4, 1, 2, 0, 2]] };
  const tower = { name: 'Tower', parts: Array.from({ length: 30 }, (_, i) => ['3003', i % 2 ? 4 : 15, 0, i * 3, 0, 0, i + 1]) };
  for (const m of [plate, wall, tower]) {
    const v = await open(m);
    assert.ok(v, 'the 3D picture is drawn in this browser');
    assert.ok(inside(v) && fills(v) > 0.8, m.name + ' fits inside the picture on a phone, and fills it: ' + v.box.map(n => n.toFixed(2)));
  }
  // Turned on its side, the phone gets the model fitted again; once the picture has been moved, it's left alone.
  await p.setViewportSize({ width: 844, height: 390 });
  await p.waitForFunction(() => { const c = document.getElementById('stage'); return c.width / c.height > 2; });
  let v = await p.evaluate(() => window.BrickyardBuild.inView());
  assert.ok(inside(v) && fills(v) > 0.8, 'the tower is fitted again when the phone is turned: ' + v.box.map(n => n.toFixed(2)));
  await p.setViewportSize({ width: 390, height: 844 });
  await p.waitForFunction(() => { const c = document.getElementById('stage'); return c.width / c.height < 1; });
  // A long drag upwards stops just under the horizon.
  const first = await open(plate), s = await p.locator('#stage').boundingBox();
  assert.equal(await p.isHidden('#stage-reset'), true, 'no Reset view until the picture has been moved');
  const cdp = await c.newCDPSession(p);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: s.x + 195, y: s.y + 380 }] });
  for (let k = 1; k <= 12; k++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: s.x + 195, y: s.y + 380 - k * 25 }] });
  // The finger rests before it lifts: a drag, not a flick. Lifted at speed, about one run in thirty the browser
  // sent no click for the next tap (on Reset view, below), and the wait for the button to go timed out.
  await p.waitForTimeout(150);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: s.x + 195, y: s.y + 80 }] });
  await p.waitForTimeout(60);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await p.waitForFunction(() => window.BrickyardBuild.inView().moved);
  await p.waitForTimeout(600); // the turn eases out
  v = await p.evaluate(() => window.BrickyardBuild.inView());
  assert.ok(v.moved && v.polar > 0.45 && v.polar <= 0.5201, 'a long drag up stops just under the horizon, not underneath: ' + v.polar.toFixed(3));
  assert.equal(await p.isVisible('#stage-reset'), true, 'Reset view shows once the picture has been moved');
  await p.tap('#stage-reset');
  await p.waitForFunction(() => document.getElementById('stage-reset').hidden);
  v = await p.evaluate(() => window.BrickyardBuild.inView());
  assert.deepEqual([v.box.map(n => n.toFixed(3)), v.moved, await p.isHidden('#stage-reset')], [first.box.map(n => n.toFixed(3)), false, true], 'Reset view puts the picture back as it opened');
  await c.close();
}
// On a laptop the stage is wide, and the cottage still fills its height.
{
  const { c, p } = await withSets({ sets: {} }, { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, hasTouch: false });
  await p.goto(base + '#model-x-cottage');
  await p.waitForSelector('#model-view:not([hidden])');
  await p.waitForFunction(() => window.BrickyardBuild.inView());
  const v = await p.evaluate(() => window.BrickyardBuild.inView());
  assert.ok(v.box.every(n => n >= 0 && n <= 1) && v.box[3] - v.box[1] > 0.8, 'the cottage fills the stage’s height on a laptop: ' + v.box.map(n => n.toFixed(2)));
  // The turn and zoom buttons stand at the edges of the page's column, over Previous and Next, not in the far
  // corners of a picture as wide as the window.
  await p.click('#step-next');
  const edges = await p.evaluate(() => ['[data-turn="left"]', '#step-prev', '[data-zoom="in"]', '#step-next'].map(s => document.querySelector(s).getBoundingClientRect()).map((r, i) => Math.round(i < 2 ? r.left : r.right)));
  assert.deepEqual([edges[0], edges[2]], [edges[1], edges[3]], 'on a laptop the turn and zoom buttons line up with Previous and Next');
  await c.close();
}

// The 3D picture is drawn when it changes, not all the time: a model left alone isn't redrawn at all (it was, sixty
// times a second), opening one model over another doesn't start a second loop drawing it (each open added one),
// models opened in turn don't pile up what the graphics card holds, and a big plate's studs are one thing to draw.
// Counted by wrapping the calls WebGL makes.
{
  const { c, p } = await withSets({ sets: {} });
  await c.addInitScript(() => {
    const S = window.__gl = { clears: 0, draws: 0, buffers: 0 }, P = WebGL2RenderingContext.prototype;
    const wrap = (n, f) => { const o = P[n]; P[n] = function () { f(); return o.apply(this, arguments); }; };
    wrap('clear', () => S.clears++);
    ['drawElements', 'drawArrays', 'drawElementsInstanced', 'drawArraysInstanced'].forEach(n => wrap(n, () => S.draws++));
    wrap('createBuffer', () => S.buffers++); wrap('deleteBuffer', () => S.buffers--);
  });
  const gl = () => p.evaluate(() => Object.assign({}, window.__gl));
  const open = async model => {
    await p.goto(base + '#d1z' + deflateRawSync(JSON.stringify({ brickyard: 1, model })).toString('base64url'));
    await p.waitForFunction(n => location.hash.startsWith('#model-m') && document.getElementById('build-title').textContent === n, model.name);
  };
  const toEnd = () => p.evaluate(() => { const r = document.getElementById('step-range'); r.value = r.max; r.dispatchEvent(new Event('input')); });
  // Waits for the picture to come to rest: nothing drawn for half a second.
  const rest = async () => { for (let last = -1, n = (await gl()).clears; n !== last; last = n, n = (await gl()).clears) await p.waitForTimeout(500); };
  const tower = (name, n) => ({ name, parts: Array.from({ length: n }, (_, i) => ['3003', i % 2 ? 4 : 15, 0, i * 3, 0, 0, i + 1]) });
  await p.reload(); // so the page has the counters from its start
  await p.goto(base + '#model-x-cottage');
  await p.waitForFunction(() => document.getElementById('build-title').textContent === 'Cottage');
  await toEnd();
  await p.waitForFunction(() => window.__gl.clears > 0);
  await rest();
  let a = await gl();
  assert.ok(a.clears > 0, 'the picture is drawn in this browser, and its calls are counted');
  await p.waitForTimeout(2000);
  let b = await gl();
  assert.equal(b.clears - a.clears, 0, 'a model left alone isn’t redrawn');
  // Two more models opened over the cottage, without passing through the list; then a step's drop is drawn once
  // for each frame the browser gives, not once for each model opened.
  await open(tower('Tower A', 6)); await open(tower('Tower B', 8));
  await rest();
  const drop = await p.evaluate(() => new Promise(done => {
    const from = window.__gl.clears, t0 = performance.now(); let frames = 0;
    document.getElementById('step-next').click();
    requestAnimationFrame(function tick() { frames++; if (performance.now() - t0 < 600) requestAnimationFrame(tick); else done({ frames, clears: window.__gl.clears - from }); });
  }));
  assert.ok(drop.clears >= 3 && drop.clears <= drop.frames + 1, 'a step dropping in is drawn once a frame, by one loop: ' + JSON.stringify(drop));
  await rest();
  a = await gl(); await p.waitForTimeout(1000); b = await gl();
  assert.equal(b.clears - a.clears, 0, 'and once it has landed, nothing more is drawn');
  // Ten models of the same pieces, opened in turn through the list: what the graphics card holds stays level.
  const held = [];
  for (let i = 0; i < 10; i++) {
    await open(tower('Tower ' + i, 10 + i));
    await toEnd();
    await rest();
    held.push((await gl()).buffers);
    await p.goto(base + '#build');
    await p.waitForSelector('#build-list:not([hidden]) .list');
  }
  assert.ok(held[9] > 0 && held[9] === held[2], 'ten models opened in turn hold no more than three did: ' + held);
  // A 16x16 plate, studs and all, is a few things to draw.
  await open({ name: 'Big plate', parts: [['91405', 2, 0, 0, 0, 0, 1]] });
  await rest();
  a = await gl();
  await toEnd();
  await p.waitForFunction(n => window.__gl.clears > n, a.clears);
  await rest();
  b = await gl();
  assert.ok(b.clears > a.clears && (b.draws - a.draws) / (b.clears - a.clears) < 10, 'a 16x16 plate is under 10 things to draw: ' + (b.draws - a.draws) + ' in ' + (b.clears - a.clears));
  // The picture taken away (a phone short of memory): the stage says so, and says nothing once it is back.
  await p.evaluate(() => { window.__lose = document.getElementById('stage').getContext('webgl2').getExtension('WEBGL_lose_context'); window.__lose.loseContext(); });
  await p.waitForFunction(() => /picture was dropped/.test(document.getElementById('stage-hint').textContent));
  assert.deepEqual([await p.textContent('#stage-hint'), await p.isVisible('#stage-hint')], ['The picture was dropped. It comes back by itself, or reload.', true]);
  a = await gl();
  await p.evaluate(() => window.__lose.restoreContext());
  await p.waitForFunction(() => /Drag to turn/.test(document.getElementById('stage-hint').textContent));
  await p.waitForFunction(n => window.__gl.clears > n, a.clears); // and it is drawn again when it comes back
  await c.close();
}

// What a model's page says when it can't be built: which piece, by colour and name, in which step as the page
// counts them, each kind of problem once (it repeated itself, gave grid positions, and never named a piece). A
// model with pieces the builder can't draw says how many; one with nothing it can draw shows the message alone.
{
  const { c, p } = await withSets({ sets: {}, loose: { tub: { id: 'tub', t: 1, name: 'Red tub', parts: [['3001', 4, 1], ['3003', 15, 9], ['3020', 2, 4], ['3659', 4, 2], ['3023', 1, 2]] }, wheels: { id: 'wheels', t: 1, name: 'Wheels', parts: [['2780', 0, 40], ['3622', 4, 2]] } } });
  const open = async model => {
    await p.goto(base + '#d1z' + deflateRawSync(JSON.stringify({ brickyard: 1, model })).toString('base64url'));
    await p.waitForFunction(n => location.hash.startsWith('#model-m') && document.getElementById('build-title').textContent === n, model.name);
    return p.$$eval('#model-check > *', els => els.map(e => e.textContent));
  };
  const broken = { name: 'Broken bridge', parts: [['3001', 4, 0, 0, 0, 0, 1], ['3001', 1, 2, 0, 0, 0, 1], ['4081b', 15, 0, 3, 0, 0, 2], ['3003', 15, 20, 0, 0, 0, 3], ['3003', 14, 30, 0, 0, 0, 4], ['3001', 14, 0, 3, 0, 0, 2]] };
  assert.deepEqual(await open(broken), ['This model can’t be built as it is. It uses a piece the builder can’t draw (4081b). A red 2x4 brick and a blue 2x4 brick are in the same place, in step 1. ' +
    '2 pieces aren’t joined to the rest of the model: a white 2x2 brick in step 3 and a yellow 2x2 brick in step 4. Ask Claude to fix it.',
    'You’re short: 1 × Blue brick 2x4, 1 × Yellow brick 2x4, 1 × Yellow brick 2x2. Swap colours where it doesn’t matter, or ask Claude for another version.',
    '6 pieces, 1 the builder can’t draw · 4 steps · about 25.6 × 1.6 cm, 1.9 cm tall'], 'a broken model names its pieces and counts the ones it can’t draw');
  // A piece under an arch: the check treats an arch as solid, and the message says which piece is inside which.
  const arch = { name: 'Arch', parts: [['3020', 2, 0, 0, 0, 0, 1], ['3659', 4, 0, 1, 0, 0, 2], ['3023b', 1, 1, 1, 0, 0, 2]] };
  assert.equal((await open(arch))[0], 'This model can’t be built as it is. A blue 1x2 plate is inside a red 1x4 arch, in step 2. Ask Claude to fix it.', 'a piece under an arch');
  // A piece that would sit on a piece already built and under another: it has no way in. Its step (the model's 9)
  // is named as the page counts them.
  const tight = { name: 'Tight', parts: [['3001', 4, 0, 0, 0, 0, 1], ['3003', 15, 0, 3, 0, 0, 2], ['3003', 15, 0, 6, 0, 0, 2], ['3001', 4, 0, 9, 0, 0, 3], ['3003', 15, 2, 3, 0, 0, 7], ['3003', 15, 2, 6, 0, 0, 9]] };
  assert.equal((await open(tight))[0], 'This model can’t be built as it is. Step 5 has a piece that would have to be squeezed in between pieces already built. Ask Claude to fix it.', 'a piece squeezed in between built pieces');
  // Steps numbered 1, 2, 5, 9: the step with nothing to join to is the page's step 3, not the model's 5.
  const gaps = { name: 'Gaps', parts: [['3001', 4, 0, 0, 0, 0, 1], ['3001', 15, -2, 3, 0, 0, 2], ['3001', 1, 4, 0, 0, 0, 5], ['3001', 14, 2, 3, 0, 0, 9]] };
  assert.equal((await open(gaps))[0], 'This model can’t be built as it is. Step 3 adds pieces with nothing to join to yet. Ask Claude to fix it.', 'a step is named as the page counts them');
  await p.tap('#step-next'); await p.tap('#step-next'); await p.tap('#step-next');
  assert.equal(await p.textContent('.stepnum'), 'Step 3 of 4');
  // A piece that goes on from underneath says so on its step.
  const under = { name: 'Under', parts: [['3001', 4, 0, 3, 0, 0, 1], ['3003', 15, 0, 0, 0, 0, 2], ['3003', 15, 0, 6, 0, 0, 3], ['3003', 15, 2, 0, 0, 0, 3]] };
  await open(under);
  await p.tap('#step-next'); // Start building
  assert.equal(await p.locator('#step-parts .under').count(), 0, 'nothing about underneath on a step that builds upwards');
  await p.tap('#step-next');
  assert.equal(await p.textContent('#step-parts .under'), 'This one goes on from underneath.');
  await p.tap('#step-next');
  assert.deepEqual([await p.textContent('#step-parts .under'), await p.textContent('#step-parts li small')], ['1 of these goes on from underneath.', 'White · 1 from underneath'], 'a step of two, one of them from underneath');
  // Nothing the builder can draw: the message on its own, with no empty picture, no steps and no "0 pieces".
  const none = { name: 'Odd parts', about: 'Made of parts the builder has no shape for.', parts: [['zz9', 4, 0, 0, 0, 0, 1], ['zz9', 4, 0, 3, 0, 0, 2], ['qq1', 1, 0, 6, 0, 0, 3]] };
  assert.deepEqual(await open(none), ['Brickyard can’t show this model. None of its 3 pieces are among the ones the builder can draw (zz9, qq1). Ask Claude to design it from the pieces in Copy my pieces for Claude.']);
  assert.deepEqual(await Promise.all(['.stage', '.stepbar', '#step-range', '#step-parts'].map(s => p.isVisible(s))), [false, false, false, false], 'no picture and no steps for it');
  assert.equal(await p.isVisible('#model-about'), true);
  // A part number that every object answers to ("constructor") is as unknown as zz9. It was taken for a piece the
  // builder knows, and the page stopped while opening the model, with the last model's words still showing.
  const odd = { name: 'Odder parts', parts: [['3001', 4, 0, 0, 0, 0, 1], ['constructor', 4, 0, 3, 0, 0, 2]] };
  assert.deepEqual([(await open(odd))[0].slice(0, 89), await p.textContent('#build-title')],
    ['This model can’t be built as it is. It uses a piece the builder can’t draw (constructor).', 'Odder parts']);
  // The line that says you have every piece names only where this model's pieces come from: not the lot of wheels.
  const plain = { name: 'Plain', parts: [['3020', 2, 0, 0, 0, 0, 1], ['3003', 15, 0, 1, 0, 0, 2]] };
  assert.equal((await open(plain))[0], '✓ You have every piece for this, from loose pieces (Red tub).', 'only the lot that holds its pieces is named');
  assert.equal(await p.isVisible('.stage'), true, 'and a model that can be drawn has its picture back');
  // The list: a broken model that is also short says both, and counts all its pieces.
  await p.goto(base + '#build');
  await p.waitForSelector('#build-list:not([hidden]) .list');
  const row = async name => (await p.textContent('#build-list .list .item:has-text("' + name + '")')).replace(name, '');
  assert.deepEqual([await row('Broken bridge'), await row('Odd parts'), await row('Plain')], ['6 pieces · 4 stepsAdded todayNeeds fixing · 3 short', '3 piecesAdded todayNeeds fixing', '2 pieces · 2 stepsAdded todayCan build']);
  await c.close();
}

// A model sent again: the same parts under a new name or description show the new ones (it kept the old), the same
// parts listed in another order are the same model (they made a second row), and each row says when it was added.
// A model saved under an id made the old way keeps that id, so its address still opens.
{
  const { c, p } = await withSets({ sets: {} });
  const parts = [['3001', 4, 0, 0, 0, 0, 1], ['3001', 15, 2, 3, 0, 0, 2], ['3023b', 1, 0, 3, 0, 0, 2], ['3003', 14, 2, 6, 0, 0, 3]];
  const open = async (model, name) => {
    await p.goto(base + '#build');
    await p.goto(base + '#d1z' + deflateRawSync(JSON.stringify({ brickyard: 1, model })).toString('base64url'));
    await p.waitForFunction(n => location.hash.startsWith('#model-m') && document.getElementById('build-title').textContent === n, name || model.name);
    return p.evaluate(() => location.hash);
  };
  const kept = () => p.evaluate(() => JSON.parse(localStorage.getItem('brickyard.models')));
  const rows = async () => { await p.goto(base + '#build'); await p.waitForSelector('#build-list:not([hidden]) .list'); return p.locator('#build-list .list .item .main').allTextContents(); };
  const first = await open({ name: 'Wide', about: 'The first go.', parts });
  // As if it was added on 3 November last year.
  await p.evaluate(([id, t]) => { const all = JSON.parse(localStorage.getItem('brickyard.models')); all[id].added = t; localStorage.setItem('brickyard.models', JSON.stringify(all)); }, [first.slice(7), new Date(new Date().getFullYear() - 1, 10, 3, 12).getTime()]);
  const again = await open({ name: 'Renamed', about: 'A better name and a new description.', parts });
  assert.deepEqual([again, await p.textContent('#build-title'), await p.textContent('#model-about')], [first, 'Renamed', 'A better name and a new description.'], 'the same parts under a new name show the new name');
  const turned = await open({ name: 'Renamed', about: 'A better name and a new description.', parts: parts.slice().reverse() });
  assert.deepEqual([turned, Object.keys(await kept()).length], [first, 1], 'the same parts listed in another order are the same model');
  await open({ name: 'Other', parts: parts.slice(0, 3) });
  assert.deepEqual(await rows(), ['Other3 pieces · 2 stepsAdded today', 'Renamed4 pieces · 3 stepsAdded 3 Nov ' + (new Date().getFullYear() - 1), 'Cottage · example40 pieces · 7 steps'], 'each row says when it was added, and a model sent again keeps its place');
  // An id made the old way (any id at all), with the parts under the numbers they came with.
  await p.evaluate(m => localStorage.setItem('brickyard.models', JSON.stringify({ mold123: { model: m, added: Date.now() - 2 * 864e5 } })), { name: 'Old one', about: '', sets: [], parts: parts.map(q => [q[0] === '3023b' ? '3023' : q[0]].concat(q.slice(1))) });
  await p.goto(base + '#build');
  await p.goto(base + '#model-mold123');
  await p.waitForFunction(() => document.getElementById('build-title').textContent === 'Old one');
  assert.deepEqual([await p.textContent('.stepnum'), await p.textContent('#step-parts')], ['Finished model', 'Old one: 4 pieces in 3 steps. This is how it looks when it’s built. Drag it around to look it over.'], 'a model saved under an old id still opens at its address');
  assert.deepEqual([await open({ name: 'Old one, again', parts }), Object.keys(await kept())], ['#model-mold123', ['mold123']], 'and its link opens that one, not a second copy');
  assert.match((await rows())[0], /^Old one, again4 pieces · 3 stepsAdded \d+ [A-Z][a-z]{2}( \d{4})?$/);
  await c.close();
}

// The picture's finishing touches: a fence and a door frame have no glass in them (a window does), the "Drag to
// turn" line goes by itself after a few seconds, a see-through piece's swatch is see-through in All the pieces
// too, and with the keyboard on the picture the arrow keys turn it and + and - zoom, without changing the step.
{
  const { c, p } = await withSets({ sets: {} }, { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, hasTouch: false });
  const model = { name: 'Fence and door', parts: [['3020', 2, 0, 0, 0, 0, 1], ['3020', 2, 4, 0, 0, 0, 1], ['3020', 2, 8, 0, 0, 0, 1], ['3001', 4, 2, 1, 0, 0, 1], ['3001', 4, 6, 1, 0, 0, 1],
    ['15332', 15, 0, 4, 1, 0, 2], ['60596', 15, 4, 4, 1, 0, 2], ['60592', 33, 8, 4, 1, 0, 2]] };
  await p.goto(base + '#d1z' + deflateRawSync(JSON.stringify({ brickyard: 1, model })).toString('base64url'));
  await p.waitForFunction(() => location.hash.startsWith('#model-m') && document.getElementById('build-title').textContent === 'Fence and door');
  const view = () => p.evaluate(() => window.BrickyardBuild.inView());
  assert.equal((await view()).panes, 1, 'only the window has glass: not the fence, not the door frame');
  assert.equal(await p.isVisible('#stage-hint'), true);
  await p.waitForFunction(() => document.getElementById('stage-hint').hidden, null, { timeout: 8000 });
  await p.click('#model-menu'); await p.click('#mm-parts');
  assert.deepEqual(await p.$$eval('.sheet .need li', ls => ls.filter(l => /Trans/.test(l.textContent)).map(l => l.querySelector('i').style.opacity)), ['0.6'], 'a see-through piece’s swatch in All the pieces');
  await p.click('[data-close]');
  // Keys on the picture.
  assert.deepEqual(await p.$eval('#stage', e => [e.tabIndex, e.getAttribute('role'), /arrow keys turn it, plus and minus zoom/.test(e.getAttribute('aria-label'))]), [0, 'img', true]);
  await p.click('#step-next'); await p.click('#step-next');
  await p.waitForFunction(() => !window.BrickyardBuild.inView().glide); // the camera has come to rest on the step
  const first = await view();
  await p.focus('#stage');
  await p.keyboard.press('ArrowRight');
  let v = await view();
  assert.deepEqual([v.moved, v.box.join() !== first.box.join(), await p.textContent('.stepnum'), await p.isVisible('#stage-reset')], [true, true, 'Step 2 of 2', true], 'an arrow key on the picture turns it, and leaves the step');
  await p.keyboard.press('ArrowLeft');
  v = await view();
  assert.deepEqual([v.box.map(n => n.toFixed(3)), await p.textContent('.stepnum')], [first.box.map(n => n.toFixed(3)), 'Step 2 of 2'], 'and the other arrow turns it back');
  const wide = b => b[2] - b[0];
  await p.keyboard.press('+');
  assert.ok(wide((await view()).box) > wide(first.box) * 1.1, 'plus zooms in');
  await p.keyboard.press('-'); await p.keyboard.press('-');
  assert.ok(wide((await view()).box) < wide(first.box) * 0.9, 'minus zooms out');
  for (let i = 0; i < 12; i++) await p.keyboard.press('ArrowUp');
  assert.ok((await view()).polar <= 0.5201, 'up stops just under the horizon');
  for (let i = 0; i < 30; i++) await p.keyboard.press('ArrowDown');
  assert.ok((await view()).polar > 0, 'down stops above the model');
  await p.evaluate(() => document.activeElement.blur());
  await p.keyboard.press('ArrowLeft');
  assert.equal(await p.textContent('.stepnum'), 'Step 1 of 2', 'away from the picture, the arrows are steps again');
  await c.close();
}

// A set marked Check stops being To check when its number is put right and saved (it stayed To check, with a
// toast that only said Saved, until the sheet was opened again for "It's right"). Any other change keeps the mark.
// While the number differs and the name is as it was, a line under Name says the name, year and pieces are still
// the old set's.
{
  const { c, p } = await withSets({ sets: {
    a: { id: 'a', t: 1, num: '10334-1', name: 'Retro Radio', year: 2024, pieces: 906, state: 'built', room: 'Hall', check: 'number read from a blurry corner' },
    b: { id: 'b', t: 1, num: '10311-1', name: 'Orchid', state: 'built', room: 'Hall', check: 'or is it 10281?' },
    d: { id: 'd', t: 1, num: '21327-1', name: 'Typewriter', state: 'apart', room: 'Office' } } });
  await p.goto(base + '#catalog');
  const checks = () => p.textContent('.chip[data-f="check"] .n');
  const kept = id => p.evaluate(i => window.brickyard.doc().sets[i], id);
  assert.equal(await checks(), '2');
  // Only its box changed: still To check.
  await p.click('.item[data-id="b"]');
  await p.fill('#e-box', '7');
  await p.click('#e-save');
  assert.deepEqual([await checks(), await p.textContent('.toast'), (await kept('b')).check, (await kept('b')).box], ['2', 'Saved. Box 7 holds 1 set now.', 'or is it 10281?', '7'], 'a change to its box keeps the mark');
  // Its number changed.
  await p.click('.item[data-id="a"]');
  assert.equal(await p.isHidden('#e-still'), true, 'no line under Name as the sheet opens');
  await p.fill('#e-num', '10340');
  assert.equal(await p.textContent('#e-still'), 'The name, year and pieces are still set 10334’s. Change them too if this is a different set.');
  assert.equal(await p.isVisible('#e-still'), true);
  await p.fill('#e-num', '10334');
  assert.equal(await p.isHidden('#e-still'), true, 'put back, the line goes');
  await p.fill('#e-num', '10340');
  await p.fill('#e-name', 'Retro Radios');
  assert.equal(await p.isHidden('#e-still'), true, 'and once the name is changed');
  await p.fill('#e-name', 'Retro Radio');
  assert.equal(await p.isVisible('#e-still'), true);
  await p.click('#e-save');
  assert.deepEqual([await checks(), await p.textContent('.toast'), (await kept('a')).check, (await kept('a')).num], ['1', 'Saved. No longer marked to check.', undefined, '10340-1'], 'a corrected number takes the mark off');
  assert.equal(await p.locator('.item[data-id="a"] .warn').count(), 0, 'and its row no longer says so');
  // A set with no mark says only Saved, and a new set has no line.
  await p.click('.item[data-id="d"]');
  await p.fill('#e-num', '21328');
  assert.equal(await p.isVisible('#e-still'), true);
  await p.click('#e-save');
  assert.equal(await p.textContent('.toast'), 'Saved');
  await p.click('#add-btn');
  await p.fill('#e-num', '10698');
  assert.equal(await p.isHidden('#e-still'), true);
  await c.close();
}

// A row says what is missing and what to check, in the words typed (it said only "Missing pieces" and "To check",
// and each set had to be opened to find out), on a line each of two lines at most; a screen reader still hears
// "To check". A set a search found only by its tags or notes shows them. Newest first heads each day's sets with
// the day, and each row says the day it was added; the menu that chooses it is Sort and group. On paper each row has the first line of its notes.
{
  const long = 'the number on the box was half under a price sticker and the last digit could be a 3 or an 8, and the photo of the back was out of focus so the name could not be read either';
  const { c, p } = await withSets({ sets: {
    a: { id: 'a', t: 1, num: '10305-1', name: 'Lion Knights’ Castle', state: 'built', room: 'Hall', missing: 'two shields\none grey 1x2 plate,', added: '2026-10-20' },
    b: { id: 'b', t: 2, num: '10334-1', name: 'Retro Radio', state: 'built', room: 'Hall', check: 'number read from a blurry corner', missing: 'the dial', added: '2026-10-20' },
    d: { id: 'd', t: 3, num: '10294-1', name: 'Titanic', state: 'apart', room: 'Office', notes: 'Second-hand, from Sam\nBags 1-12 in box 7, 13-25 in box 8', tags: ['display'], added: '2026-10-21' },
    e: { id: 'e', t: 4, num: '10497-1', name: 'Galaxy Explorer', state: 'built', room: 'Office', tags: ['display', 'space'], check: long },
    f: { id: 'f', t: 5, num: '21327-1', name: 'Typewriter', state: 'built', room: 'Office', notes: 'A display piece' } } });
  await p.goto(base + '#catalog');
  const lines = id => p.$$eval(`.item[data-id="${id}"] .m`, els => els.filter(e => getComputedStyle(e).display !== 'none').map(e => [...e.childNodes].filter(n => !(n.classList && n.classList.contains('vh'))).map(n => n.textContent).join('')));
  assert.deepEqual(await lines('a'), ['10305', 'Missing: two shields, one grey 1x2 plate']);
  assert.deepEqual(await lines('b'), ['10334', 'Missing: the dial', 'Check: number read from a blurry corner']);
  assert.equal(await p.getByRole('button', { name: /Retro Radio.*Missing: the dial.*To check: number read from a blurry corner/ }).count(), 1, 'a screen reader hears To check, the chip’s words');
  assert.deepEqual(await lines('d'), ['10294'], 'notes and tags stay off a row');
  // A long reason is two lines, cut with an ellipsis; the row is no wider than the list.
  const box = await p.$eval('.item[data-id="e"] .warn', e => ({ h: e.getBoundingClientRect().height, line: parseFloat(getComputedStyle(e).lineHeight), cut: e.scrollHeight > e.clientHeight + 1, right: e.getBoundingClientRect().right }));
  assert.ok(box.cut && Math.abs(box.h - 2 * box.line) < 2 && box.right <= 390, 'a long reason takes two lines: ' + JSON.stringify(box));
  // Found by a tag, by notes, by both.
  await p.fill('#q', 'display');
  assert.deepEqual([await lines('d'), await lines('e'), await lines('f')], [['10294', 'Tags: display'], ['10497', 'Check: ' + long, 'Tags: display, space'], ['21327', 'Notes: A display piece']]);
  await p.fill('#q', 'bags');
  assert.deepEqual(await lines('d'), ['10294', 'Notes: Bags 1-12 in box 7, 13-25 in box 8'], 'the line of the notes that was found');
  await p.fill('#q', 'titanic');
  assert.deepEqual(await lines('d'), ['10294'], 'found by its name, a row is as it was');
  await p.fill('#q', '');
  // Newest first: a heading for each day, newest at the top; sets with no date come last.
  await p.selectOption('#group', 'new');
  const day = iso => new Date(iso + 'T12:00').toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  assert.deepEqual(await p.$$eval('#list-wrap h2.group', hs => hs.map(h => [...h.querySelectorAll('span')].map(s => s.textContent))), [[day('2026-10-21'), '1'], [day('2026-10-20'), '2'], ['No date', '2']]);
  assert.equal(await p.getByRole('heading', { name: day('2026-10-20') + ', 2 sets', level: 2 }).count(), 1);
  assert.deepEqual([await lines('d'), await lines('a'), await lines('e')], [['10294', 'Added ' + day('2026-10-21') + ' · Office'], ['10305', 'Added ' + day('2026-10-20') + ' · Hall', 'Missing: two shields, one grey 1x2 plate'], ['10497', 'Office', 'Check: ' + long]], 'each row says the day it was added, before where it is; a set with no day says where it is');
  assert.deepEqual([await p.textContent('.sumline label'), await p.getAttribute('#group', 'aria-label')], ['Sort and group RoomMoving boxThemeStateNewest first', 'Sort and group'], 'the menu is called Sort and group: Newest first is a sort');
  // On paper: the first line of a set's notes, and all of a long reason.
  await p.emulateMedia({ media: 'print' });
  assert.deepEqual(await lines('d'), ['10294', 'Added ' + day('2026-10-21') + ' · Office', 'Second-hand, from Sam']);
  assert.equal(await p.$eval('.item[data-id="e"] .warn', e => e.scrollHeight > e.clientHeight + 1), false, 'the whole reason is printed');
  await c.close();
}

// After a batch is added the screen shows it: the message says how many are to check, the chip row is moved along
// so the To check chip is on the screen (on a phone it was off the side), and the first new row is in view, not
// thousands of pixels down a list still at its top. Not when the search in force hides the new sets.
{
  const sets = {};
  for (let i = 0; i < 40; i++) sets['s' + i] = { id: 's' + i, t: 1, num: (10200 + i) + '-1', name: 'Set number ' + (i + 1), state: ['built', 'apart', 'partial', 'sealed'][i % 4], room: ['Office', 'Hall', 'Garage'][i % 3], missing: i === 3 ? 'a tile' : '' };
  const { c, p } = await withSets({ sets });
  const link = (list, more) => base + '#b1z' + deflateRawSync(JSON.stringify({ brickyard: 1, batch: { sets: list, ...more } })).toString('base64url');
  const seen = sel => p.evaluate(s => {
    const r = document.querySelector(s).getBoundingClientRect(), top = document.querySelector('#catalog .bar').getBoundingClientRect().bottom, bottom = document.querySelector('.fab-row').getBoundingClientRect().top;
    return r.left >= 0 && r.right <= innerWidth && r.top >= top && r.bottom <= bottom;
  }, sel);
  await p.goto(link([{ num: '31058', name: 'Mighty Dinosaurs' }, { num: '60198', name: 'Cargo Train', check: 'number partly hidden' }, { num: '10334', name: 'Retro Radio', check: 'blurry' }], { room: 'Zoo', id: 'zoo' }));
  await p.click('#rv-add');
  assert.equal(await p.textContent('.toast span'), 'Added 3 sets. 2 to check.');
  assert.equal(await p.locator('.toast button').textContent(), 'Undo', 'Undo is still offered');
  await p.waitForFunction(() => !(history.state && history.state.sheet));
  await p.waitForTimeout(300);
  const first = await p.$eval('#list-wrap .item:has-text("Cargo Train")', el => el.dataset.id); // Zoo: Cargo Train, Mighty Dinosaurs, Retro Radio
  assert.ok(await p.evaluate(() => scrollY) > 1000, 'the list has moved down to the new sets');
  assert.equal(await seen(`.item[data-id="${first}"]`), true, 'the first new row is on the screen, clear of the bars');
  const chip = await p.$eval('.chip[data-f="check"]', el => { const r = el.getBoundingClientRect(); return [r.left >= 0, r.right <= innerWidth, el.textContent]; });
  assert.deepEqual(chip, [true, true, 'To check2'], 'and so is the To check chip');
  assert.deepEqual(await p.$$eval('.chip', cs => cs.map(c => c.dataset.f)), ['all', 'built', 'partial', 'apart', 'sealed', 'missing', 'check'], 'the chips are in the order they were');
  // None to check: no word about it, and the chip row stays where it is. A search that hides the new sets leaves the list alone.
  await p.goto('about:blank');
  await p.goto(base + '#catalog');
  await p.fill('#q', 'office');
  await p.goto(link([{ num: '21318', name: 'Tree House' }], { room: 'Zoo', id: 'zoo2' }));
  await p.fill('#q', 'office');
  await p.click('#rv-add');
  assert.equal(await p.textContent('.toast span'), 'Added 1 set');
  await p.waitForFunction(() => !(history.state && history.state.sheet));
  await p.waitForTimeout(300);
  assert.deepEqual(await p.evaluate(() => [scrollY, document.getElementById('chips').scrollLeft]), [0, 0]);
  await c.close();
}

// A set added by hand is shown too. The message was the bare word "Added", and in a catalog of 300 sets grouped by
// room the new row was some 25,000 px down the page, under No room yet, with the page left where it was. Now the
// message names the set, and its row is brought into view and tinted for a moment; one that's in view already
// leaves the page where it is. When the filter or the search hides the new set, they're left alone: the message
// says so, with Show, which lifts what hides it. The rows of a batch from a link are tinted the same way.
{
  const sets = {};
  for (let i = 0; i < 300; i++) sets['s' + i] = { id: 's' + i, t: 1, num: (10200 + i) + '-1', name: 'Set number ' + (i + 1), state: ['built', 'apart', 'partial', 'sealed'][i % 4], room: ['Office', 'Hall', 'Garage', 'Basement', ''][i % 5] };
  const { c, p } = await withSets({ sets });
  // Where a set's row is: on the screen between the bar and the two buttons, tinted, and holding the focus?
  const row = name => p.evaluate(n => {
    const el = [...document.querySelectorAll('#list-wrap .item')].filter(r => r.querySelector('.t').textContent === n)[0];
    if (!el) return null;
    const r = el.getBoundingClientRect(), top = document.querySelector('#catalog .bar').getBoundingClientRect().bottom, bottom = document.querySelector('.fab-row').getBoundingClientRect().top;
    return { seen: r.top >= top && r.bottom <= bottom, tint: el.classList.contains('new'), lit: getComputedStyle(el).animationName === 'new-row', focus: document.activeElement === el };
  }, name);
  const add = async (num, name, more) => {
    await p.click('#add-btn');
    await p.fill('#e-num', num);
    await p.fill('#e-name', name);
    if (more) await more();
    await p.click('#e-save');
    await p.waitForFunction(() => !document.querySelector('.scrim') && !(history.state && history.state.sheet));
    await p.waitForTimeout(300);
  };
  const says = () => p.evaluate(() => { const t = document.querySelector('.toast'); return t.hidden ? [] : [t.querySelector('span').textContent, t.querySelector('button') ? t.querySelector('button').textContent : '']; });
  await p.goto(base + '#catalog');
  await add('21061', 'Notre-Dame de Paris');
  assert.deepEqual(await says(), ['Added Notre-Dame de Paris', ''], 'the message says which set');
  assert.ok(await p.evaluate(() => scrollY) > 10000, 'the page has moved down to the new set');
  assert.deepEqual(await row('Notre-Dame de Paris'), { seen: true, tint: true, lit: true, focus: false }, 'its row is on the screen, clear of the bars, and tinted');
  await p.waitForFunction(() => !document.querySelector('.item.new'), null, { timeout: 6000 });
  assert.equal(await p.evaluate(() => document.getAnimations().length), 0, 'the tint goes after a moment');
  // A set whose row is in view already: the page stays put. (Named only, with a size in inches.)
  const y = await p.evaluate(() => scrollY);
  await p.click('#add-btn');
  await p.fill('#e-name', 'Notre-Dame, a second one');
  for (const k of ['w', 'd', 'h']) await p.fill('#e-' + k, '10"');
  await p.click('#e-save');
  await p.waitForFunction(() => !document.querySelector('.scrim') && !(history.state && history.state.sheet));
  await p.waitForTimeout(300);
  assert.deepEqual([await says(), await p.evaluate(() => scrollY), await row('Notre-Dame, a second one')],
    [['Added Notre-Dame, a second one. Read as inches: width 25.4 cm, depth 25.4 cm, height 25.4 cm', ''], y, { seen: true, tint: true, lit: true, focus: false }], 'a row that’s in view is tinted where it is');
  // Under a filter that hides it: the filter stays, and the message has the way to the set.
  await p.evaluate(() => scrollTo(0, 0));
  await p.click('.chip[data-f="sealed"]');
  await add('21338', 'A-Frame Cabin');
  assert.deepEqual([await says(), await row('A-Frame Cabin'), await p.getAttribute('.chip[data-f="sealed"]', 'aria-pressed'), await p.evaluate(() => scrollY)],
    [['Added A-Frame Cabin. It isn’t under Sealed.', 'Show'], null, 'true', 0], 'a set the filter hides: the message says so, and the list is left alone');
  await p.click('.toast button');
  assert.deepEqual([await row('A-Frame Cabin'), await p.getAttribute('.chip[data-f="all"]', 'aria-pressed'), await p.locator('.toast').isHidden()],
    [{ seen: true, tint: true, lit: true, focus: true }, 'true', true], 'Show lifts the filter and brings the row into view');
  // Hidden by the search, under a filter that would show it: the search goes, the filter stays.
  await p.click('.chip[data-f="built"]');
  await p.fill('#q', 'office');
  await add('21341', 'Galaxy Explorer');
  assert.deepEqual([await says(), await row('Galaxy Explorer')], [['Added Galaxy Explorer. It doesn’t match “office”.', 'Show'], null]);
  await p.click('.toast button');
  assert.deepEqual([await row('Galaxy Explorer'), await p.inputValue('#q'), await p.getAttribute('.chip[data-f="built"]', 'aria-pressed')], [{ seen: true, tint: true, lit: true, focus: true }, '', 'true'], 'Show clears the search and keeps a filter the set is under');
  // Show pressed from another screen goes to My sets first.
  await p.fill('#q', 'office');
  await add('21342', 'Orchid');
  await p.evaluate(() => { location.hash = '#shelves'; });
  await p.waitForSelector('#shelves:not([hidden])');
  await p.click('.toast button');
  await p.waitForFunction(() => document.querySelector('.item.new'));
  assert.deepEqual([await p.evaluate(() => location.hash), await row('Orchid')], ['#catalog', { seen: true, tint: true, lit: true, focus: true }]);
  // A batch from a link: every new row is tinted.
  await p.goto('about:blank');
  await p.goto(base + '#b1z' + deflateRawSync(JSON.stringify({ brickyard: 1, batch: { id: 'zoo3', room: 'Zoo', sets: [{ num: '31058', name: 'Mighty Dinosaurs' }, { num: '60198', name: 'Cargo Train' }] } })).toString('base64url'));
  await p.click('#rv-add');
  await p.waitForFunction(() => document.querySelector('.item.new'));
  assert.deepEqual(await p.$$eval('.item.new .t', ts => ts.map(t => t.textContent)), ['Cargo Train', 'Mighty Dinosaurs'], 'the rows of a batch are tinted');
  await c.close();
  // Where motion is turned down the row has a still line round it, and no animation.
  const still = await withSets({ sets: { o: { id: 'o', t: 1, num: '10311-1', name: 'Orchid' } } }, { reducedMotion: 'reduce' });
  await still.p.goto(base + '#catalog');
  await still.p.click('#add-btn');
  await still.p.fill('#e-num', '21061');
  await still.p.click('#e-save');
  await still.p.waitForSelector('.item.new');
  assert.deepEqual(await still.p.$eval('.item.new', el => { const cs = getComputedStyle(el); return [el.querySelector('.t').textContent, cs.animationName, cs.outlineStyle, cs.outlineWidth]; }), ['Set 21061', 'none', 'solid', '2px']);
  assert.equal(await still.p.textContent('.toast'), 'Added Set 21061', 'a set with no name is called by its number');
  await still.c.close();
}

// A second copy added by its number takes the first copy's name, year, pieces and theme into the empty boxes on
// the first tap, to be seen before "Add another copy" (it was a bare "Set 75192" beside a first copy that had them
// all). Not its place, state, missing pieces, notes or size; a box already typed in is left alone; and a change of
// number takes them out again.
{
  const { c, p } = await withSets({ sets: {
    a: { id: 'a', t: 1, num: '75192-1', name: 'Millennium Falcon', year: 2017, pieces: 7541, theme: 'Star Wars', state: 'sealed', room: 'Garage', box: '4', missing: 'a dish', notes: 'From Sam', size: { w: 84, d: 56, h: 21 }, tags: ['display'] } } });
  await p.goto(base + '#catalog');
  const boxes = () => p.evaluate(() => ['e-name', 'e-year', 'e-pieces', 'e-theme', 'e-room', 'e-box', 'e-missing', 'e-notes', 'e-w', 'e-tags'].map(id => document.getElementById(id).value));
  await p.click('#add-btn');
  await p.fill('#e-num', '75192');
  await p.click('#e-save');
  assert.equal(await p.textContent('.toast'), 'You already have Millennium Falcon (Garage · Box 4). Tap again to add a second copy.');
  assert.equal(await p.textContent('#e-save'), 'Add another copy');
  assert.deepEqual(await boxes(), ['Millennium Falcon', '2017', '7541', 'Star Wars', '', '', '', '', '', ''], 'the empty boxes take what the first copy has, and nothing about where it is');
  // Another number: what was lent goes, and the button asks afresh.
  await p.fill('#e-num', '75257');
  assert.deepEqual([await boxes(), await p.textContent('#e-save')], [['', '', '', '', '', '', '', '', '', ''], 'Add set']);
  // A year typed first is kept.
  await p.fill('#e-num', '75192');
  await p.fill('#e-year', '2018');
  await p.click('#e-save');
  assert.deepEqual((await boxes()).slice(0, 4), ['Millennium Falcon', '2018', '7541', 'Star Wars']);
  await p.waitForTimeout(650);
  await p.click('#e-save');
  const sets = await p.evaluate(() => Object.values(window.brickyard.doc().sets).filter(x => x.id !== 'a').map(x => [x.num, x.name, x.year, x.pieces, x.theme, x.state, x.room, x.box, x.missing, x.notes, x.size, x.tags]));
  assert.deepEqual(sets, [['75192-1', 'Millennium Falcon', 2018, 7541, 'Star Wars', 'built', undefined, undefined, undefined, undefined, undefined, undefined]], 'the second copy has the first one’s name and piece count');
  assert.deepEqual(await p.$$eval('#list-wrap .item .t', els => els.map(e => e.textContent)), ['Millennium Falcon', 'Millennium Falcon']);
  await c.close();
}

// The menu prints the list: a copy on a phone's home screen has no browser menu to print from, and the page had no
// print command of its own. The sheet is closed first, so the paper has the list and not the menu. Not in the
// preview copy (a frame), and not with no sets.
{
  const { c, p } = await withSets({ sets: { a: { id: 'a', t: 1, num: '10281-1', name: 'Bonsai Tree', state: 'built', box: '2' }, b: { id: 'b', t: 1, num: '21318-1', name: 'Tree House', state: 'built', box: '3' } } });
  await p.goto(base + '#catalog');
  await p.evaluate(() => { window.__prints = []; window.print = () => window.__prints.push([document.querySelectorAll('.scrim').length, !!(history.state && history.state.sheet), [...document.querySelectorAll('#list-wrap .item .t')].map(e => e.textContent).join()]); });
  await p.fill('#q', 'box 2');
  await p.click('#menu-btn');
  assert.equal(await p.textContent('#m-print'), 'Print this listWhat My sets is showing now: search for a box first to print its packing list');
  await p.click('#m-print');
  await p.waitForFunction(() => window.__prints.length);
  assert.deepEqual(await p.evaluate(() => window.__prints), [[0, false, 'Bonsai Tree']], 'printed once, with the menu closed, the list as it was showing');
  await p.setContent(`<iframe src="${base}#catalog" style="width:390px;height:800px"></iframe>`);
  const f = await (await p.waitForSelector('iframe')).contentFrame();
  await f.click('#menu-btn');
  assert.deepEqual([await f.locator('#m-link').count(), await f.locator('#m-print').count()], [1, 0], 'the preview copy has no Print');
  await c.close();
  const e = await withSets({ sets: {} });
  await e.p.goto(base + '#catalog');
  await e.p.click('#menu-btn');
  assert.deepEqual([await e.p.locator('#m-link').count(), await e.p.locator('#m-print').count()], [1, 0], 'nothing to print with no sets');
  await e.c.close();
}

// The row the keyboard is on is clear of the bar and the search box stuck to the top and the two buttons stuck to the
// bottom of My sets (each room's heading is a stop on the way: it folds), going down the list and coming back up (WCAG 2.2, 2.4.11 Focus Not Obscured: a third of the rows stopped
// partly under one or the other, some with only the edge of the focus ring showing). And a set shown from the
// shelf planner still lands in the middle of what's left.
{
  const sets = {};
  for (let i = 0; i < 40; i++) sets['s' + i] = { id: 's' + i, t: 1, num: (10200 + i) + '-1', name: 'Set number ' + (i + 1), state: ['built', 'apart', 'partial', 'sealed'][i % 4], room: ['Office', 'Hall', 'Garage'][i % 3] };
  for (const size of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
    const { c, p } = await withSets({ sets }, { viewport: size, hasTouch: false, deviceScaleFactor: 1 });
    await p.goto(base + '#catalog');
    const hidden = () => p.evaluate(() => {
      const a = document.activeElement, r = a.getBoundingClientRect(), top = document.querySelector('#catalog .tools').getBoundingClientRect().bottom, bottom = document.querySelector('.fab-row').getBoundingClientRect().top;
      return a.classList.contains('item') ? Math.round(Math.max(0, top - r.top, r.bottom - bottom)) : -1;
    });
    await p.focus('#group');
    let rows = 0, worst = 0;
    for (let i = 0; i < 43; i++) { await p.keyboard.press('Tab'); const h = await hidden(); if (h >= 0) { rows++; worst = Math.max(worst, h); } }
    assert.deepEqual([rows, worst], [40, 0], `going down the list at ${size.width} px: rows reached, and the most of one that was covered`);
    rows = 0;
    for (let i = 0; i < 41; i++) { await p.keyboard.press('Shift+Tab'); const h = await hidden(); if (h >= 0) { rows++; worst = Math.max(worst, h); } }
    assert.deepEqual([rows, worst], [39, 0], `and coming back up at ${size.width} px`);
    // Shown from elsewhere (the planner's See in My sets): in the middle of the room between the bars.
    await p.evaluate(() => { scrollTo(0, 0); window.brickyard.showSet('s20'); });
    await p.waitForSelector('#e-form');
    const mid = await p.evaluate(() => { const r = document.querySelector('.item[data-id="s20"]').getBoundingClientRect(), top = document.querySelector('#catalog .bar').getBoundingClientRect().bottom, bottom = document.querySelector('.fab-row').getBoundingClientRect().top; return Math.abs((r.top + r.bottom) / 2 - (top + bottom) / 2); });
    assert.ok(mid < 40, 'a set shown from the planner is in the middle, between the bars: off by ' + mid);
    await c.close();
  }
}

// The buttons in the bar stuck to the top and in the row stuck to the bottom are always in view, so the page stays
// where it is when one of them takes the focus. They stand in the room kept clear for the rows (the case above),
// and the browser moved the page half a screen to "show" them: the list jumped when a sheet opened by + Add a set,
// Add from photos or the menu button closed and gave the focus back, and when Tab reached one.
{
  const sets = {};
  for (let i = 0; i < 40; i++) sets['s' + i] = { id: 's' + i, t: 1, num: (10200 + i) + '-1', name: 'Set number ' + (i + 1), room: ['Office', 'Hall', 'Garage'][i % 3] };
  const { c, p } = await withSets({ sets }, { viewport: { width: 1280, height: 800 }, hasTouch: false, deviceScaleFactor: 1 });
  await p.goto(base + '#catalog');
  const at = () => p.evaluate(() => [document.activeElement.id || document.activeElement.className, Math.round(scrollY)]);
  // A press with the mouse where the button is: Playwright's own click moves the page to its target first.
  const press = async sel => { const b = await p.locator(sel).boundingBox(); await p.mouse.click(b.x + b.width / 2, b.y + b.height / 2); };
  for (const id of ['add-btn', 'claude-btn', 'menu-btn']) {
    await p.evaluate(() => scrollTo(0, 1500));
    await press('#' + id);
    await p.waitForSelector('.scrim');
    await press('.sheet [data-close]');
    await p.waitForFunction(() => !document.querySelector('.scrim') && !(history.state && history.state.sheet));
    await p.waitForTimeout(200);
    assert.deepEqual(await at(), [id, 1500], 'closing the sheet gives the focus back to the button that opened it, and the list stays where it was');
  }
  await p.evaluate(() => { const rows = document.querySelectorAll('#list-wrap .item'); rows[rows.length - 1].focus({ preventScroll: true }); scrollTo(0, 1500); });
  await p.keyboard.press('Tab');
  assert.deepEqual(await at(), ['claude-btn', 1500], 'Tab from the last set to the buttons at the bottom');
  await p.evaluate(() => document.querySelector('#catalog .back').focus());
  assert.deepEqual(await at(), ['back', 1500], 'and the focus on the Back arrow in the bar');
  await c.close();
}

// A mistake in a sheet is said in a line under the box that's wrong, and stays there until the box is changed
// (WCAG 2.2, 3.3.1 Error Identification: it was a message at the bottom of the screen, gone in four seconds, and
// in the planner's sheets no box was marked). The box is marked, has the line as its description and takes the
// focus; boxes that share a mistake are all marked, and putting one right clears it.
{
  const set = (id, name, w, d, h, more) => ({ id, t: 1, name, state: 'built', size: { w, d, h }, ...more });
  const { c, p } = await withSets({ sets: { lm: set('lm', 'Lamborghini Sián', 60, 25, 13, { num: '42115-1' }), bs: set('bs', 'Medieval Blacksmith', 10, 21, 27) },
    cases: { k: { id: 'k', t: 1, name: 'Billy', w: 76, d: 26, levels: [{ h: 32, sets: [{ id: 'lm' }] }, { h: 32, sets: [{ id: 'bs' }] }] } } });
  const marks = ids => p.evaluate(list => list.map(id => { const e = document.getElementById(id), d = e.getAttribute('aria-describedby'); return [e.getAttribute('aria-invalid'), d && document.getElementById(d).textContent].join(' | '); }), ids);
  const errs = () => p.evaluate(() => [...document.querySelectorAll('.sheet .err')].filter(e => { const r = e.getBoundingClientRect(), b = e.closest('.bd').getBoundingClientRect(); return r.height > 0 && r.top >= b.top - 1 && r.bottom <= b.bottom + 1; }).map(e => e.textContent)); // the ones in view
  const focus = () => p.evaluate(() => document.activeElement.id);
  const toastUp = () => p.evaluate(() => !document.querySelector('.toast').hidden);
  // Add a set with neither a number nor a name.
  await p.goto(base + '#catalog');
  await p.click('#add-btn');
  await p.click('#e-save');
  const BOTH = 'Give it a set number or a name.';
  assert.deepEqual([await errs(), await marks(['e-num', 'e-name']), await focus(), await toastUp()], [[BOTH], ['true | ' + BOTH, 'true | ' + BOTH], 'e-num', false], 'said under the boxes, not in a message that goes');
  await p.waitForTimeout(5000);
  assert.deepEqual(await errs(), [BOTH], 'and still said five seconds later');
  await p.fill('#e-name', 'Orchid');
  assert.deepEqual([await errs(), await marks(['e-num', 'e-name'])], [[], [' | ', ' | ']], 'typing in either box clears it');
  // A size that can't be read, far down the sheet: the line is brought into view with its box.
  await p.fill('#e-d', 'deep');
  await p.click('#e-save');
  assert.deepEqual([await errs(), await marks(['e-w', 'e-d', 'e-h']), await focus()], [['Depth: “deep” isn’t a length Brickyard can read. Type cm, or inches with in or " after the number.'], [' | ', 'true | Depth: “deep” isn’t a length Brickyard can read. Type cm, or inches with in or " after the number.', ' | '], 'e-d']);
  await p.fill('#e-d', '12');
  assert.deepEqual(await errs(), []);
  await p.click('[data-close]'); await p.waitForTimeout(650); await p.click('[data-close]');
  // The planner's sheet for a set: one size of three missing; a shelf that no longer takes it.
  await p.goto(base + '#shelves');
  await p.click('.sv-set[data-set="lm"]');
  await p.fill('#z-d', ''); await p.fill('#z-h', '');
  await p.click('#z-save');
  const THREE = 'Give all three sizes, or none.';
  assert.deepEqual([await errs(), await marks(['z-w', 'z-d', 'z-h']), await focus(), await toastUp()], [[THREE], [' | ', 'true | ' + THREE, 'true | ' + THREE], 'z-d', false]);
  await p.fill('#z-d', '25'); await p.fill('#z-h', '50');
  assert.deepEqual(await errs(), []);
  assert.equal(await p.$eval('#z-where option[value="k:1"]', o => o.disabled), false);
  await p.selectOption('#z-where', 'k:1');
  await p.click('#z-save');
  const TALL = await p.textContent('#z-msg');
  assert.match(TALL, /50 cm/);
  assert.deepEqual([await marks(['z-where']), await focus()], [['true | ' + TALL], 'z-where'], 'a shelf that won’t take it is marked, with the reason');
  await p.selectOption('#z-where', '');
  assert.deepEqual([await marks(['z-where']), await p.textContent('#z-msg')], [[' | '], ''], 'until another is chosen');
  await p.click('[data-close]'); await p.waitForTimeout(650); await p.click('[data-close]');
  // A bookcase with no width, then a shelf with no height.
  await p.click('[data-case="k"]');
  await p.fill('#k-w', '');
  await p.click('#k-save');
  const WD = 'Give the width and depth inside, in cm.';
  assert.deepEqual([await errs(), await marks(['k-w', 'k-d']), await focus(), await toastUp()], [[WD], ['true | ' + WD, ' | '], 'k-w', false]);
  await p.fill('#k-w', '76');
  await p.fill('#k-h1', '');
  await p.click('#k-save');
  assert.deepEqual([await errs(), await marks(['k-h0', 'k-h1']), await focus()], [['Give shelf 2 a height, or remove it.'], [' | ', 'true | Give shelf 2 a height, or remove it.'], 'k-h1']);
  // The line is no wider than its sheet, and the sheet is no wider than the screen.
  assert.ok(await p.evaluate(() => document.querySelector('.sheet .err').getBoundingClientRect().right <= 390 && document.querySelector('.sheet').scrollWidth <= 390));
  await c.close();
}

// A phone at 200% zoom lays the page out 195 px wide. No screen or sheet is wider than that (the home screen, Build
// from your box and the Shelf planner ran off the side, and in the planner a sheet's Save ended past the edge
// where it couldn't be scrolled to), every sheet's buttons are inside the screen, and the button in a message is
// 44 px tall at any width.
{
  const cat = { sets: { a: { id: 'a', t: 1, num: '42115-1', name: 'Lamborghini Sián FKP 37', year: 2020, pieces: 3696, theme: 'Technic', state: 'built', room: 'Garage', check: 'could be 42143', size: { w: 60, d: 25, h: 13 } },
    b: { id: 'b', t: 1, num: '10281-1', name: 'Bonsai Tree', state: 'built', room: 'Living room', spot: 'Bookcase' } },
    cases: { k: { id: 'k', t: 1, name: 'Office Billy', room: 'Office', w: 76, d: 26, levels: [{ h: 32, sets: [{ id: 'a' }] }, { h: 32, sets: [] }] } } };
  const { c, p } = await withSets(cat, { viewport: { width: 195, height: 422 }, isMobile: true });
  // The page's width, and whatever in an open sheet ends outside the screen.
  const wide = () => p.evaluate(() => [document.documentElement.scrollWidth, [...document.querySelectorAll('.sheet, .sheet .btn, .sheet input, .sheet select, .sheet .seg button, .toast, .toast button')]
    .filter(e => { const r = e.getBoundingClientRect(); return r.width && (r.left < 0 || r.right > innerWidth + 0.5); }).map(e => e.id || e.textContent.slice(0, 20))]);
  const shut = async () => { await p.click('[data-close]'); await p.waitForTimeout(650); if (await p.locator('.sheet').count()) await p.click('[data-close]'); await p.waitForFunction(() => !document.querySelector('.sheet')); };
  assert.deepEqual(await wide(), [195, []], 'the home screen');
  await p.goto(base + '#catalog');
  await p.click('.item[data-id="a"]');
  assert.deepEqual(await wide(), [195, []], 'a set’s sheet');
  await p.click('#e-del'); await p.waitForTimeout(650); await p.click('#e-del');
  assert.deepEqual(await wide(), [195, []], 'a message with Undo');
  await p.click('.toast button');
  await p.click('#claude-btn');
  assert.deepEqual(await wide(), [195, []], 'Add from photos');
  await shut();
  await p.goto(base + '#b1z' + deflateRawSync(JSON.stringify({ brickyard: 1, batch: { name: 'Hall closet', room: 'Hall', sets: [{ num: '31058', name: 'Mighty Dinosaurs', year: 2017, pieces: 174, state: 'built' }, { num: '10281', name: 'Bonsai Tree' }] } })).toString('base64url'));
  await p.waitForSelector('#rv-add');
  assert.deepEqual([await wide(), await p.$$eval('.rv li', ls => ls.every(l => l.getBoundingClientRect().right <= innerWidth && l.querySelector('.t').scrollWidth <= l.querySelector('.t').clientWidth))], [[195, []], true], 'Add sets from Claude, each row whole');
  await shut();
  await p.goto(base + '#build');
  await p.waitForSelector('#build-list .item');
  assert.deepEqual(await wide(), [195, []], 'Build from your box');
  await p.goto(base + '#shelves');
  await p.waitForSelector('.case');
  assert.deepEqual(await wide(), [195, []], 'the Shelf planner');
  await p.click('.sv-set[data-set="a"]');
  assert.deepEqual([await wide(), await p.$eval('#z-save', b => b.getBoundingClientRect().right <= innerWidth)], [[195, []], true], 'a set’s sheet in the planner, Save inside the screen');
  await shut();
  await p.click('[data-case="k"]');
  assert.deepEqual([await wide(), await p.$eval('#k-save', b => b.getBoundingClientRect().right <= innerWidth)], [[195, []], true], 'a bookcase’s sheet');
  await c.close();
  // At an ordinary width the button in a message is 44 px tall (it was 41.75).
  const n = await withSets(cat);
  await n.p.goto(base + '#catalog');
  await n.p.click('.item[data-id="b"]');
  await n.p.click('#e-del'); await n.p.waitForTimeout(650); await n.p.click('#e-del');
  assert.ok(await n.p.$eval('.toast button', b => b.getBoundingClientRect().height) >= 44);
  await n.c.close();
}

// A row's line of number, year and pieces is never cut short: beside the widest badges it ended "3,854 piec…" on
// one row in eight. It wraps between the three instead, with the piece count kept whole.
{
  const sets = { a: { id: 'a', t: 1, num: '42131-1', name: 'Cat D11 Bulldozer', year: 2021, pieces: 3854, state: 'apart', room: 'Garage' },
    b: { id: 'b', t: 1, num: '21327-1', name: 'Typewriter', year: 2021, pieces: 2079, state: 'partial', room: 'Garage' }, d: { id: 'd', t: 1, num: '10281-1', name: 'Bonsai Tree', year: 2021, pieces: 878, state: 'built', room: 'Garage' } };
  for (const width of [390, 320]) {
    const { c, p } = await withSets({ sets }, { viewport: { width, height: 700 } });
    await p.goto(base + '#catalog');
    await p.evaluate(() => document.fonts.ready);
    const rows = await p.$$eval('.item .m.meta', ms => ms.map(m => [m.textContent, m.scrollWidth > m.clientWidth, [...m.children].every(s => s.getClientRects().length === 1), Math.round(m.getBoundingClientRect().height / parseFloat(getComputedStyle(m).lineHeight))]));
    assert.deepEqual(rows.map(r => r.slice(0, 3)), [['10281 · 2021 · 878 pieces', false, true], ['42131 · 2021 · 3,854 pieces', false, true], ['21327 · 2021 · 2,079 pieces', false, true]], `nothing cut at ${width} px, and no number split from its word`);
    if (width === 390) assert.equal(rows[0][3], 1, 'a line that fits is still one line');
    await c.close();
  }
}

// Search the way it's typed: a box asked for as a question shows that box, loose pieces and all (the other words
// were searched for, and "what's in box 3" found nothing); "box 03" is box 3; a plural finds the singular; and
// the chips' own words find what the chips show.
{
  const { c, p } = await withSets({ sets: { a: { id: 'a', t: 1, num: '10280-1', name: 'Flower Bouquet', box: '3', missing: 'one leaf' }, b: { id: 'b', t: 1, num: '21327-1', name: 'Typewriter', box: '3' },
    d: { id: 'd', t: 1, num: '76391-1', name: 'Hogwarts Icons', box: '4' }, e: { id: 'e', t: 1, num: '10295-1', name: 'Porsche 911' } },
    loose: { l: { id: 'l', t: 1, name: 'Blue tub', box: '3', parts: [['3001', 4, 40]] } } });
  await p.goto(base + '#catalog');
  const find = async q => { await p.fill('#q', q); return [(await p.$$eval('#list-wrap .item .t', els => els.map(e => e.textContent.split(' ')[0]))).join(), await p.locator('#list-wrap .note.lots').count()]; };
  assert.deepEqual(await find('what’s in box 3'), ['Flower,Typewriter', 1], 'a box asked for as a question, with its loose pieces');
  assert.deepEqual([await find('box 03'), await find('box3'), await find('in box 3 type')], [['Flower,Typewriter', 1], ['Flower,Typewriter', 1], ['Typewriter', 0]]);
  assert.match(await p.textContent('#print-head'), /^Brickyard · My sets by room · “in box 3 type” · /);
  await p.fill('#q', 'what’s in box 3');
  assert.match(await p.textContent('#print-head'), /^Brickyard · Box 3 · /, 'and printed, it is headed Box 3');
  assert.deepEqual([await find('flowers'), await find('911'), await find('not packed'), await find('missing pieces'), await find('lego 21327')], [['Flower', 0], ['Porsche', 0], ['Porsche', 0], ['Flower', 0], ['Typewriter', 0]]);
  await c.close();
}

// In a list of rows to tick, each tick box is described by the rest of its row (it read only "Add Cargo Train",
// without the reason it's unticked or the thing to check), and the count is read out when a tick changes it. In
// Add sets from Claude and in the planner's Add sizes.
{
  const { c, p } = await withSets({ sets: { a: { id: 'a', t: 1, num: '10281-1', name: 'Bonsai Tree', state: 'built', room: 'Living room', spot: 'Bookcase' }, b: { id: 'b', t: 1, num: '10305-1', name: 'Lion Knights’ Castle', pieces: 4514, state: 'built' } } });
  await p.goto(base + '#b1z' + deflateRawSync(JSON.stringify({ brickyard: 1, batch: { sets: [{ num: '10281', name: 'Bonsai Tree' }, { num: '60198', name: 'Cargo Train', year: 2018, pieces: 1226, state: 'sealed', room: 'Garage', check: 'number partly hidden' }] } })).toString('base64url'));
  await p.waitForSelector('#rv-add');
  const said = sel => p.$$eval(sel + ' input[type="checkbox"]', bs => bs.map(b => [b.getAttribute('aria-label'), b.checked, document.getElementById(b.getAttribute('aria-describedby')).innerText.replace(/\n+/g, ' / ')]));
  assert.deepEqual(await said('#rv'), [['Add Bonsai Tree', false, '10281 / You already have this one (Living room › Bookcase)'], ['Add Cargo Train', true, '60198 · 2018 · 1,226 pieces · Sealed · Garage / Check: number partly hidden']]);
  assert.equal(await p.getByRole('checkbox', { name: 'Add Cargo Train', description: /Check: number partly hidden/ }).count(), 1);
  assert.equal(await p.getAttribute('#rv-n', 'aria-live'), 'polite');
  await p.click('#rv li:first-child .t');
  assert.deepEqual([await p.textContent('#rv-n'), await p.$eval('#rv li:first-child', l => l.className)], ['2 of 2 ticked', ''], 'a tap on the row still ticks it');
  await p.click('[data-close]'); await p.waitForTimeout(650); await p.click('[data-close]');
  await p.goto(base + '#z1z' + deflateRawSync(JSON.stringify({ brickyard: 1, sizes: [{ num: '10281', w: 21, d: 20, h: 18 }, { num: '10305', w: 44, d: 33, h: 3 }] })).toString('base64url'));
  await p.waitForSelector('#zr-go');
  const sizes = await said('#zr');
  assert.deepEqual([sizes[0], sizes[1].slice(0, 2), /^10305 · 44 × 33 × 3 cm \/ Check: /.test(sizes[1][2]), await p.getAttribute('#zr-n', 'aria-live')], [['Add size for Bonsai Tree', true, '10281 · 21 × 20 × 18 cm'], ['Add size for Lion Knights’ Castle', false], true, 'polite']);
  await p.click('#zr li:last-child .t');
  assert.deepEqual([await p.textContent('#zr-n'), await p.$eval('#zr li:last-child', l => l.className)], ['2 of 2 ticked', '']);
  await c.close();
}

// Removing one of two sets with the same name says which: "Removed Millennium Falcon 75257". And a typed list of
// set numbers pasted where a link goes says what to do with it (it only said the paste didn't look like sets from
// Claude); a link cut short, and words with no numbers, still say what they did.
{
  const { c, p } = await withSets({ sets: { a: { id: 'a', t: 1, num: '75192-1', name: 'Millennium Falcon' }, b: { id: 'b', t: 1, num: '75257-1', name: 'Millennium Falcon' }, d: { id: 'd', t: 1, num: '10281-1', name: 'Bonsai Tree' }, e: { id: 'e', t: 1, name: 'Bonsai tree' } } });
  await p.goto(base + '#catalog');
  const remove = async id => { await p.click(`.item[data-id="${id}"]`); await p.click('#e-del'); await p.waitForTimeout(650); await p.click('#e-del'); return p.textContent('.toast span'); };
  assert.equal(await remove('b'), 'Removed Millennium Falcon 75257');
  await p.click('.toast button');
  assert.equal(await p.textContent('.toast span'), 'Millennium Falcon 75257 is back');
  assert.equal(await remove('e'), 'Removed Bonsai tree', 'one with no number has only its name to give');
  assert.equal(await remove('d'), 'Removed Bonsai Tree', 'and the only set of its name is named as before');
  const LIST = 'That’s a list, not a Brickyard link. Send it to Claude and ask for a Brickyard link: it fills in names, years and pieces.';
  const paste = async text => { await p.evaluate(() => { document.querySelector('.toast').hidden = true; }); await p.fill('#paste', text); await p.click('#p-go'); await p.waitForFunction(() => !document.querySelector('.toast').hidden); return p.textContent('.toast'); };
  await p.click('#claude-btn');
  assert.equal(await paste('10497, 21318, 75192'), LIST);
  assert.equal(await paste('75192 Millennium Falcon\n10281-1 Bonsai Tree'), LIST);
  assert.equal(await paste('Set Number,Quantity\n75192-1,1\n10281-1,2'), LIST, 'the text of an export');
  assert.equal(await paste('my sets please'), 'That doesn’t look like sets from Claude or a Brickyard file');
  assert.match(await paste(base + '#b1zAAAA12345'), /cut short or has a wrong character/);
  assert.equal(await p.locator('.sheet').count(), 1, 'the sheet stays open for another go');
  // Only the box for sets says so. "My Brickyard pieces" pasted back under Open a model has a set's number in it
  // too, and was told Claude would fill in names, years and pieces.
  await p.goto(base + '#build');
  await p.click('#open-model');
  await p.evaluate(() => { document.querySelector('.toast').hidden = true; });
  await p.fill('#model-paste', 'My Brickyard pieces\nLarge Creative Brick Box (10698)\n3001/4 ×12');
  await p.click('#model-go');
  await p.waitForFunction(() => !document.querySelector('.toast').hidden);
  assert.equal(await p.textContent('.toast'), 'That doesn’t look like a model from Claude');
  await c.close();
}

// In a contrast theme (forced colours) the chosen filter and the chosen State are in the theme's highlight colours
// (they were marked by a background and a shadow, which the theme takes away, so all four States looked the same),
// and buttons have an outline.
{
  const { c, p } = await withSets({ sets: { a: { id: 'a', t: 1, num: '10281-1', name: 'Bonsai Tree', state: 'built' }, b: { id: 'b', t: 1, num: '21327-1', name: 'Typewriter', state: 'apart' } } }, { forcedColors: 'active', viewport: { width: 1000, height: 800 }, hasTouch: false, deviceScaleFactor: 1 });
  await p.goto(base + '#catalog');
  const bg = sel => p.$$eval(sel, els => els.map(e => getComputedStyle(e).backgroundColor));
  await p.click('.chip[data-f="built"]');
  const chips = await bg('.chip');
  assert.ok(chips[1] !== chips[0] && chips[0] === chips[2], 'the chosen chip stands out: ' + chips);
  await p.click('.item[data-id="a"]');
  const seg = await bg('#e-state button');
  assert.ok(seg[0] === chips[1] && seg[0] !== seg[1] && seg[1] === seg[2] && seg[2] === seg[3], 'and the chosen State: ' + seg);
  assert.deepEqual(await p.$$eval('#e-save, [data-close], #e-del, #e-state button', els => els.map(e => getComputedStyle(e).borderTopWidth)), Array(7).fill('1px'), 'buttons have an outline');
  await c.close();
}

// A damaged entry among the saved models is skipped: the list still shows, and the home screen doesn't count it.
{
  const { c, p } = await withSets({ sets: {} });
  await p.evaluate(m => localStorage.setItem('brickyard.models', JSON.stringify({ a: null, b: { added: 1 }, c: { model: Object.assign({}, m, { name: 'Saved cottage' }), added: 2 } })), cottage.model);
  await p.goto(base + '#build');
  await p.waitForSelector('#build-list .list', { timeout: 10000 });
  assert.deepEqual(await p.locator('#build-list .list .item .t').allTextContents(), ['Saved cottage', 'Cottage · example']);
  await p.goto(base);
  await p.waitForFunction(() => document.getElementById('home-build-stat').textContent === '1 model from Claude');
  await c.close();
}

// Loose pieces from a scanner: open the link, review, add; they join Your pieces; opening it again replaces it.
const lot = { brickyard: 1, loose: { id: 'sf-test', name: 'Blue tub', box: '14', parts: [['3001', 4, 40], ['3020', 15, 2], ['2780', 0, 30, 'Technic Pin with Friction']] } };
const lotLink = n => base + '#l1z' + deflateRawSync(JSON.stringify(n)).toString('base64url');
await page.goto(base + '#catalog');
await page.goto(lotLink(lot));
await page.waitForSelector('#ls-add');
assert.match(await page.textContent('.sheet .lede'), /Blue tub.*72 pieces of 3 kinds/);
await page.waitForFunction(() => /can use 42 of them/.test(document.getElementById('ls-use').textContent));
assert.equal(await page.inputValue('#ls-box'), '14');
assert.deepEqual(await page.$$eval('.sheet .bulk label > span', s => s.map(x => x.textContent)), ['Call it', 'Moving box'], 'the lot’s name and box each have a label');
await page.fill('#ls-name', 'Blue tub (garage)');
await page.click('#ls-add');
await page.waitForSelector('li.lot [data-pool="sf-test"]');
assert.equal(await page.evaluate(() => location.hash), '#build');
assert.match(await page.textContent('li.lot'), /Blue tub \(garage\).*Loose · 72 pieces · Box 14 · the builder can use 42/);
assert.equal(await page.isChecked('[data-pool="sf-test"]'), true, 'loose pieces count unless unticked');
let stored = (await doc()).loose['sf-test'];
assert.deepEqual([stored.name, stored.box, stored.parts.length], ['Blue tub (garage)', '14', 3]);
assert.match(await page.textContent('.pieces .group'), /862/, 'the pool is the box (790, as My sets has it) plus the tub (72)');
await page.goto(base + '#');
// The home screen's card says the same number (it said "72 loose pieces", counting only those).
await page.waitForFunction(() => /^862 pieces to build from/.test(document.getElementById('home-build-stat').textContent));
// A model that needs more red 2x4s than the box has is short without the tub and fine with it.
const reds = { brickyard: 1, model: { name: 'Red wall', parts: Array.from({ length: 12 }, (_, i) => ['3001', 4, 0, i * 3, 0, 0, i + 1]) } };
await page.goto(base + '#d1z' + deflateRawSync(JSON.stringify(reds)).toString('base64url'));
await page.waitForFunction(() => location.hash.startsWith('#model-m'));
assert.match(await page.textContent('#model-check'), /every piece for this, from Large Creative Brick Box and loose pieces \(Blue tub \(garage\)\)\./, 'the lot is named with the box');
await page.goto(base + '#build');
await page.waitForSelector('li.lot');
await page.uncheck('[data-pool="sf-test"]');
await page.waitForFunction(() => /short/.test(document.querySelector('#build-list .list').textContent));
await page.check('[data-pool="sf-test"]');
await page.waitForFunction(() => !/short/.test(document.querySelector('#build-list .list').textContent));
// With the box unticked the tub alone covers it, and the check names the tub.
await page.uncheck('.menu.pool li:not(.lot) [data-pool]');
await page.waitForFunction(() => /^72$/.test(document.querySelector('.pieces .group span:last-child').textContent));
await page.click('#build-list a.item:has-text("Red wall")');
await page.waitForSelector('#model-view:not([hidden])');
assert.match(await page.textContent('#model-check'), /every piece for this, from loose pieces \(Blue tub \(garage\)\)\./, 'a lot on its own is named');
await page.goto(base + '#build');
await page.waitForSelector('li.lot');
await page.check('.menu.pool li:not(.lot) [data-pool]');
await page.waitForFunction(() => /862/.test(document.querySelector('.pieces .group').textContent));
// The same lot again, recounted: it replaces, never doubles.
lot.loose.parts[0][2] = 45;
await page.goto(lotLink(lot));
await page.waitForSelector('#ls-add');
assert.match(await page.textContent('.sheet .flag'), /already have these loose pieces \(72 pieces\)\. Adding them again replaces them/);
assert.equal(await page.textContent('#ls-add'), 'Replace them');
await page.click('#ls-add');
await page.waitForFunction(() => /77 pieces/.test(document.querySelector('li.lot').textContent));
assert.equal(Object.keys((await doc()).loose).length, 1);
// A lot can be removed, and comes back from its link.
await page.click('li.lot [data-lot]');
await page.waitForSelector('#lot-drop');
await page.click('#lot-drop');
await page.waitForFunction(() => !document.querySelector('li.lot'));
assert.equal((await doc()).loose['sf-test'].del, 1);
assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'the build screen with a lot scrolls sideways on a phone');

// Shelf planner: sizes from Claude, a bookcase, fit the sets, and copy their places into My sets.
await page.goto(base + '#catalog');
const builtIds = await page.evaluate(() => Object.values(window.brickyard.doc().sets).filter(x => !x.del && (x.state === 'built' || x.state === 'partial') && x.num).map(x => x.num));
assert.ok(builtIds.length >= 2, 'the test catalog has built sets');
const sizeList = builtIds.map((num, i) => ({ num, w: 20 + i * 5, d: 15, h: 10 + i * 3 }));
await page.goto(base + '#z1z' + deflateRawSync(JSON.stringify({ brickyard: 1, sizes: sizeList })).toString('base64url'));
await page.waitForSelector('#zr-go');
// A tap on a row ticks or unticks it here too.
const sizesTicked = await page.textContent('#zr-n');
await page.click('#zr li >> nth=0 >> .t');
assert.notEqual(await page.textContent('#zr-n'), sizesTicked, 'tapping a set’s name unticks its size');
await page.click('#zr li >> nth=0 >> .t');
assert.equal(await page.textContent('#zr-n'), sizesTicked, 'and ticks it again');
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
await page.click('[data-case]');
await page.dblclick('#k-del');
assert.equal(await page.evaluate(() => Object.values(window.BrickCore.shelves(window.brickyard.doc())).filter(c => !c.del).length), 1, 'a double tap does not remove a bookcase');
await page.click('[data-close]');

// Put these places in My sets writes over what My sets said, so its message has Undo, and the card says first how
// many sets it would change ("My sets matches these shelves" when none, with no button). A set on two bookcases
// counts once; a set that's been taken apart or sealed since it was placed is left alone, and the message says so.
// Removing a bookcase takes its name out of My sets too ("Billy, shelf 1", the words the button wrote), in the same
// Undo.
{
  const set = (id, name, state, more) => ({ id, t: 1, name, state, size: { w: 12, d: 10, h: 10 }, ...more });
  const { c, p } = await withSets({ sets: {
    bt: set('bt', 'Bonsai Tree', 'built', { room: 'Living room', spot: 'Mantelpiece, left of the clock' }), tw: set('tw', 'Typewriter', 'built', { room: 'Office', spot: 'Billy, shelf 1' }),
    lb: set('lb', 'London Bus', 'built'), mc: set('mc', 'Medieval Castle', 'apart', { box: '7' }), or: set('or', 'Orchid', 'sealed') },
    cases: { k: { id: 'k', t: 2, name: 'Billy', room: 'Office', w: 76, d: 26, levels: [{ h: 32, sets: [{ id: 'tw' }, { id: 'bt' }] }, { h: 32, sets: [{ id: 'mc' }, { id: 'or' }, { id: 'lb' }] }] },
      x: { id: 'x', t: 1, name: 'Kallax', w: 33, d: 37, levels: [{ h: 33, sets: [{ id: 'bt' }] }] } } });
  const toastSays = () => p.evaluate(() => { const t = document.querySelector('.toast'); return t && !t.hidden ? [t.querySelector('span').textContent, (t.querySelector('button') || {}).textContent || ''] : null; });
  const places = () => p.evaluate(() => Object.values(window.brickyard.doc().sets).map(x => [x.id, x.room || '', x.spot || ''].join('/')).sort());
  const card = () => p.evaluate(() => [document.getElementById('apply-n').textContent, !!document.querySelector('[data-act="apply"]')]);
  const before = ['bt/Living room/Mantelpiece, left of the clock', 'lb//', 'mc//', 'or//', 'tw/Office/Billy, shelf 1'];
  await p.goto(base + '#shelves');
  await p.waitForSelector('.case');
  assert.deepEqual(await card(), ['2 sets are somewhere else in My sets.', true], 'the card counts the sets My sets has elsewhere, each once');
  await p.click('[data-act="apply"]');
  assert.deepEqual(await toastSays(), ['2 sets updated in My sets; 2 left alone: taken apart or sealed', 'Undo'], 'the message counts what changed and what was left, with Undo');
  assert.deepEqual(await places(), ['bt/Office/Billy, shelf 1', 'lb/Office/Billy, shelf 2', 'mc//', 'or//', 'tw/Office/Billy, shelf 1'], 'a taken-apart or sealed set gets no shelf');
  assert.deepEqual(await card(), ['My sets matches these shelves.', false], 'and the card says My sets is up to date');
  await p.click('.toast button');
  assert.deepEqual([await places(), await toastSays(), await card()], [before, ['Put those 2 sets’ places back', ''], ['2 sets are somewhere else in My sets.', true]], 'Undo puts back the room and spot that were written over');
  await p.click('[data-act="apply"]');
  await p.click('[data-case="k"]');
  await p.click('#k-del'); await p.waitForTimeout(650); await p.click('#k-del');
  assert.deepEqual(await toastSays(), ['Removed Billy. Its sets are back in Not on a shelf yet. 3 sets no longer say Billy in My sets.', 'Undo']);
  assert.deepEqual(await places(), ['bt/Office/', 'lb/Office/', 'mc//', 'or//', 'tw/Office/'], 'removing the bookcase clears the shelf it gave each set');
  await p.click('.toast button');
  assert.deepEqual(await places(), ['bt/Office/Billy, shelf 1', 'lb/Office/Billy, shelf 2', 'mc//', 'or//', 'tw/Office/Billy, shelf 1'], 'and Undo puts the bookcase and those words back');
  await c.close();
}

// A set that stops belonging on its shelf. One whose size was cleared isn't drawn, so it's listed under Needs a size
// with the shelf it's on (it was in neither list, and still counted as on a shelf). One taken apart or sealed since
// is drawn pale and hatched, and a line over the bookcase takes such sets off, with Undo.
{
  const set = (id, name, state, size) => ({ id, t: 1, name, state, ...(size ? { size: { w: size[0], d: size[1], h: size[2] } } : {}) });
  const { c, p } = await withSets({ sets: { mc: set('mc', 'Medieval Castle', 'apart', [30, 20, 25]), bt: set('bt', 'Bonsai Tree', 'sealed', [20, 15, 18]), bs: set('bs', 'Bookshop', 'built'),
    tw: set('tw', 'Typewriter', 'built', [27, 26, 11]) },
    cases: { k: { id: 'k', t: 2, name: 'Billy narrow', w: 76, d: 26, levels: [{ h: 32, sets: [{ id: 'bs' }, { id: 'tw' }, { id: 'mc' }] }, { h: 32, sets: [{ id: 'bt' }] }] } } });
  const toastSays = () => p.evaluate(() => { const t = document.querySelector('.toast'); return t && !t.hidden ? [t.querySelector('span').textContent, (t.querySelector('button') || {}).textContent || ''] : null; });
  const seen = () => p.evaluate(() => ({ sum: document.querySelector('#shelves-body .sumline').textContent, head: document.querySelector('.case-hd .m').textContent, drawn: [...document.querySelectorAll('.sv-set')].map(g => g.dataset.set + (g.classList.contains('off') ? ' off' : '')),
    rows: [...document.querySelectorAll('#shelves-body .list .item')].map(r => [...r.querySelectorAll('.t, .m')].map(e => e.textContent).join(' | ')), flag: [...document.querySelectorAll('.case .flag')].map(f => [f.querySelector('span').textContent, (f.querySelector('button') || {}).textContent || '']) }));
  await p.goto(base + '#shelves');
  await p.waitForSelector('.case');
  assert.deepEqual(await seen(), { sum: '3 of 4 sets on shelves; the other one needs a size', head: '76 × 26 cm inside · 2 shelves · 3 sets', drawn: ['tw', 'mc off', 'bt off'], rows: ['Bookshop | On Billy narrow, shelf 1'],
    flag: [['2 sets here aren’t built now: Medieval Castle and Bonsai Tree.', 'Take them off']] }, 'a set with no size is listed with its shelf; taken-apart and sealed sets are hatched and flagged');
  await p.click('[data-act="take-off"]');
  assert.deepEqual([await toastSays(), (await seen()).drawn, (await seen()).flag], [['2 sets are off Billy narrow', 'Undo'], ['tw'], []], 'the button takes them off');
  await p.click('.toast button');
  assert.deepEqual([await toastSays(), (await seen()).drawn], [['Those 2 sets are back on their shelves', ''], ['tw', 'mc off', 'bt off']], 'and Undo puts them back');
  await p.evaluate(() => { const d = window.brickyard.doc(); window.brickyard.putSet(Object.assign({}, d.sets.bt, { state: 'built' })); window.brickyard.refresh(); });
  assert.deepEqual((await seen()).flag, [['Medieval Castle is taken apart now.', 'Take it off the shelf']]);
  await c.close();
}

// Two devices can each save a bookcase with the same set on it, and syncing keeps both. The set is drawn once, on the
// bookcase changed last; moving it leaves it in one place in what's saved, and the other bookcase is saved without it.
{
  const set = (id, name) => ({ id, t: 1, name, state: 'built', size: { w: 20, d: 15, h: 18 } });
  const { c, p } = await withSets({ sets: { x: set('x', 'Bonsai Tree'), y: set('y', 'Orchid') },
    cases: { k1: { id: 'k1', t: 12, name: 'Billy', w: 76, d: 26, levels: [{ h: 32, sets: [{ id: 'x' }, { id: 'y' }] }, { h: 32, sets: [] }] },
      k2: { id: 'k2', t: 11, name: 'Kallax', w: 33, d: 37, levels: [{ h: 33, sets: [{ id: 'x' }] }] } } });
  const saved = () => p.evaluate(() => Object.values(window.BrickCore.shelves(window.brickyard.doc())).map(k => k.id + ':' + k.levels.map(l => l.sets.map(q => q.id).join('+')).join('/')).sort().join(' '));
  await p.goto(base + '#shelves');
  await p.waitForSelector('.case');
  assert.deepEqual([await p.locator('.sv-set[data-set="x"]').count(), await p.locator('.sv-set').count(), await p.textContent('#shelves-body .sumline')], [1, 2, 'All 2 sets are on shelves'], 'a set on two bookcases is drawn once');
  assert.match(await p.getAttribute('.sv-set[data-set="x"]', 'aria-label'), /Billy, shelf 1/, 'on the bookcase changed last');
  await p.goto(base);
  assert.equal(await p.textContent('#home-shelf-stat'), '2 bookcases · 2 sets on shelves', 'and counted once on the home screen');
  await p.goto(base + '#shelves');
  await p.click('.sv-set[data-set="x"]');
  await p.selectOption('#z-where', 'k1:1');
  await p.click('#z-save');
  assert.equal(await saved(), 'k1:y/x k2:', 'moved, it is saved in one place');
  await c.close();
}

// A bookcase's sheet has a box for each shelf's height, top shelf first, each with Remove, and Add a shelf. (One box
// took them all as "32, 32, 40": a phone's number keypad can't type that, "32,5" made two shelves, and inches were
// saved as cm.) A row keeps its own sets when a shelf above it is removed, and Save says what came off, with Undo.
// Sizes are cm unless they say inches; what can't be read keeps the sheet open and says which box. A set left deeper
// than its bookcase is flagged, as one too tall is.
{
  const set = (id, name, w, d, h) => ({ id, t: 1, name, state: 'built', size: { w, d, h } });
  const { c, p } = await withSets({ sets: { a: set('a', 'Bonsai Tree', 20, 15, 18), b: set('b', 'Typewriter', 27, 26, 11), g: set('g', 'London Bus', 34, 9, 18) },
    cases: { k: { id: 'k', t: 1, name: 'Billy', w: 76, d: 26, levels: [{ h: 32, sets: [] }, { h: 30, sets: [{ id: 'a' }] }, { h: 28, sets: [{ id: 'b' }, { id: 'g' }] }] } } });
  const toastSays = () => p.evaluate(() => { const t = document.querySelector('.toast'); return t && !t.hidden ? [t.querySelector('span').textContent, (t.querySelector('button') || {}).textContent || ''] : null; });
  const kept = () => p.evaluate(() => { const k = window.BrickCore.shelves(window.brickyard.doc()).k; return [k.w, k.d, k.levels.map(l => l.h + ':' + l.sets.map(q => q.id).join('+')).join(' ')]; });
  const rows = () => p.evaluate(() => [...document.querySelectorAll('#k-levels li')].map(li => [li.querySelector('input').value, li.querySelector('.on').textContent, li.querySelector('input').getAttribute('aria-label'), li.querySelector('button').getAttribute('aria-label')].join(' | ')));
  await p.goto(base + '#shelves');
  await p.click('[data-case="k"]');
  assert.deepEqual(await rows(), ['32 |  | Height of shelf 1, cm | Remove shelf 1', '30 | 1 set | Height of shelf 2, cm | Remove shelf 2', '28 | 2 sets | Height of shelf 3, cm | Remove shelf 3'], 'a box for each shelf, saying what stands on it');
  assert.deepEqual(await p.evaluate(() => [...document.querySelectorAll('.sheet .btn, .sheet input')].filter(e => { const r = e.getBoundingClientRect(); return r.width < 44 || r.height < 44; }).map(e => e.id || e.textContent)), [], 'nothing to tap in it is under 44 px');
  await p.click('[data-rm="1"]');
  assert.deepEqual(await rows(), ['32 |  | Height of shelf 1, cm | Remove shelf 1', '28 | 2 sets | Height of shelf 2, cm | Remove shelf 2'], 'a shelf removed takes its sets, and the one below keeps its own');
  await p.fill('#k-h0', '32,5');
  await p.fill('#k-w', '14 1/8');
  await p.click('#k-save');
  const errs = () => p.locator('.sheet .err').allTextContents(); // what a sheet says is wrong, under the box
  assert.deepEqual([await p.locator('.sheet').count(), await p.getAttribute('#k-w', 'aria-invalid'), await p.evaluate(() => document.activeElement.id), await errs()],
    [1, 'true', 'k-w', ['Width: “14 1/8” isn’t a length Brickyard can read. Type cm, or inches with in or " after the number.']], 'a size that can’t be read keeps the sheet open and says which box');
  await p.fill('#k-w', '30"');
  await p.click('#k-add');
  assert.deepEqual([(await rows())[2], await p.evaluate(() => document.activeElement.id)], ['28 |  | Height of shelf 3, cm | Remove shelf 3', 'k-h2'], 'a new shelf starts at the height above it, ready to type over');
  await p.fill('#k-h2', '');
  await p.click('#k-save');
  assert.deepEqual([await p.locator('.sheet').count(), await errs(), await p.getAttribute('#k-h2', 'aria-describedby')], [1, ['Give shelf 3 a height, or remove it.'], 'k-h2-err']);
  await p.fill('#k-h2', '40');
  await p.click('#k-save');
  assert.deepEqual([await p.locator('.sheet').count(), await kept(), await toastSays()], [0, [76.2, 26, '32.5: 28:b+g 40:'], ['1 set is back in Not on a shelf yet. Read as inches: 76.2 cm', 'Undo']], '"32,5" is one shelf of 32.5 cm, inches are worked out, and the message says what came off');
  await p.click('.toast button');
  assert.deepEqual([await kept(), await toastSays()], [[76, 26, '32: 30:a 28:b+g'], ['Billy is as it was', '']], 'Undo puts the bookcase back with its sets');
  // A set's sizes, in the planner's sheet and in My sets'.
  await p.click('.sv-set[data-set="a"]');
  await p.fill('#z-h', '7 in');
  await p.click('#z-save');
  assert.deepEqual([await p.evaluate(() => window.brickyard.doc().sets.a.size.h), await toastSays()], [17.8, ['Saved. Read as inches: 17.8 cm', '']]);
  await p.click('.sv-set[data-set="a"]');
  await p.fill('#z-w', '20 x 15');
  await p.click('#z-save');
  assert.deepEqual([await p.locator('.sheet').count(), (await errs())[0].slice(0, 30)], [1, 'Width: “20 x 15” isn’t a lengt']);
  await p.click('#z-cat');
  await p.waitForSelector('#e-save');
  await p.fill('#e-w', '9 7/8"'); await p.fill('#e-d', '5,5');
  await p.click('#e-save');
  assert.deepEqual([await p.evaluate(() => window.brickyard.doc().sets.a.size), await toastSays()], [{ w: 25.1, d: 5.5, h: 17.8 }, ['Saved. Read as inches: 25.1 cm', '']], 'My sets reads sizes the same way');
  await p.click('.item:has-text("Bonsai Tree")');
  await p.fill('#e-h', '3200');
  await p.click('#e-save');
  assert.deepEqual([await p.locator('.sheet').count(), await errs()], [1, ['Height: “3200” is more than Brickyard keeps (500 cm).']]);
  await discard(p);
  // A bookcase made shallower than the sets on it.
  await p.goto(base + '#shelves');
  await p.click('[data-case="k"]');
  await p.fill('#k-d', '5');
  await p.click('#k-save');
  assert.deepEqual(await p.locator('.case .flag.bad').allTextContents(), ['3 sets are too deep for this bookcase (5 cm deep). Move them to a deeper one.']);
  await p.click('[data-case="k"]');
  await p.fill('#k-d', '20');
  await p.click('#k-save');
  assert.deepEqual(await p.locator('.case .flag.bad').allTextContents(), ['Typewriter is 26 cm deep facing out; this bookcase is 20 cm deep. Move it to a deeper one.']);
  await c.close();
}

// Fit keeps 1 cm clear above a set. One that only a shelf of its own height could take is left, says what it needs on
// its row, and can still be stood there by hand: its sheet says so and offers the shelf.
{
  const set = (id, name, w, d, h) => ({ id, t: 1, name, state: 'built', size: { w, d, h } });
  const { c, p } = await withSets({ sets: { a: set('a', 'Snug', 20, 20, 32), b: set('b', 'Snug too', 20, 20, 31.5), l: set('l', 'Low', 20, 20, 31) }, cases: { k: { id: 'k', t: 1, name: 'Billy', w: 76, d: 26, levels: [{ h: 32, sets: [] }] } } });
  await p.goto(base + '#shelves');
  await p.waitForSelector('.case');
  const rows = () => p.evaluate(() => [...document.querySelectorAll('#shelves-body .list .item')].map(e => e.querySelector('.t').textContent + ': ' + ((e.querySelector('.m.warn') || {}).textContent || '')));
  assert.deepEqual([await p.textContent('[data-act="fill"]'), await rows()], ['Fit the sets onto the shelves', ['Low: ', 'Snug: 32 cm tall: needs 33 cm of space', 'Snug too: 31.5 cm tall: needs 32.5 cm of space']], 'a set with no room above it says what it needs');
  await p.click('[data-act="fill"]');
  assert.deepEqual([await p.evaluate(() => window.BrickCore.shelves(window.brickyard.doc()).k.levels[0].sets.map(q => q.id)), await p.textContent('#need-line'), await p.locator('[data-act="fill"]').count()],
    [['l'], '2 need a shelf 1 cm taller than they are.', 0], 'Fit leaves them, and one line adds them up');
  await p.click('#shelves-body .list .item >> nth=0');
  await p.waitForSelector('#z-where');
  assert.deepEqual([await p.textContent('#z-msg'), await p.evaluate(() => document.querySelector('#z-where option[value="k:0"]').disabled)],
    ['32 cm tall: needs 33 cm of space. Fit keeps 1 cm clear above a set; you can still choose a shelf here.', false], 'its sheet says it can still be put there by hand');
  await p.selectOption('#z-where', 'k:0');
  await p.click('#z-save');
  assert.deepEqual(await p.evaluate(() => window.BrickCore.shelves(window.brickyard.doc()).k.levels[0].sets.map(q => q.id)), ['l', 'a'], 'and by hand it goes on a shelf exactly its height');
  await c.close();
}

// The home screen's Shelf planner card says how many built sets are on shelves of how many, as the planner's own
// count does (the rest are waiting, or need a size first); just how many when they all are.
{
  const set = (id, name, more) => ({ id, t: 1, name, state: 'built', size: { w: 20, d: 20, h: 20 }, ...more });
  const { c, p } = await withSets({ sets: { a: set('a', 'On a shelf'), b: set('b', 'Waiting'), n: { id: 'n', t: 1, name: 'No size', state: 'partial' }, s: set('s', 'Sealed', { state: 'sealed' }) },
    cases: { k: { id: 'k', t: 1, name: 'Billy', w: 76, d: 26, levels: [{ h: 32, sets: [{ id: 'a' }] }] } } });
  assert.equal(await p.textContent('#home-shelf-stat'), '1 bookcase · 1 of 3 sets on shelves', 'the card says how many sets are still waiting for a shelf');
  await p.goto(base + '#shelves');
  await p.waitForSelector('.case');
  assert.equal(await p.textContent('#shelves-body .sumline'), '1 of 3 sets on shelves', 'as the planner counts them');
  await p.evaluate(() => { const d = window.brickyard.doc(); for (const id of ['b', 'n']) window.brickyard.putSet(Object.assign({}, d.sets[id], { state: 'apart' })); window.brickyard.refresh(); });
  await p.goto(base);
  assert.equal(await p.textContent('#home-shelf-stat'), '1 bookcase · 1 set on shelves', 'and says no more once none is');
  await c.close();
}

// With Show set pictures on, a set on a shelf has its picture in its rectangle and its name on a strip below; the
// picture is asked for without saying which page wants it. A set whose picture doesn't come, one with no number
// and one that isn't built any more stay colour blocks with their names, and so does every set with pictures off.
{
  const set = (id, name, num, w, h, more) => ({ id, t: 1, name, state: 'built', size: { w, d: 20, h }, ...(num ? { num } : {}), ...more });
  const sets = { a: set('a', 'Galaxy Explorer', '10497-1', 40, 20), b: set('b', 'Tree House', '21318-1', 20, 28), n: set('n', 'My own castle', '', 20, 20), o: set('o', 'Typewriter', '21327-1', 27, 11, { state: 'apart' }), s: set('s', 'Orchid', '10311-1', 6, 6) };
  const { c, p } = await withSets({ sets, cases: { k: { id: 'k', t: 1, name: 'Billy', w: 76, d: 26, levels: [{ h: 30, sets: [{ id: 'a' }, { id: 'b' }] }, { h: 30, sets: [{ id: 'n' }, { id: 'o' }, { id: 's' }] }] } } });
  const asked = [];
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
  await c.route('https://cdn.rebrickable.com/**', r => {
    const h = r.request().headers();
    asked.push(r.request().url().replace(/.*sets\//, '') + (h.referer || h.origin ? ' from ' + (h.referer || h.origin) : ''));
    if (/10497-1|10311-1/.test(r.request().url())) r.fulfill({ body: png, contentType: 'image/png' }); else r.fulfill({ status: 404 });
  });
  await p.goto(base + '#shelves');
  await p.waitForSelector('.sv-set.pic');
  await p.waitForFunction(() => document.querySelectorAll('.sv-img').length === 2 && document.querySelectorAll('.sv-p.in').length === 2);
  const drawn = () => p.evaluate(() => [...document.querySelectorAll('.sv-set')].map(g => {
    const shown = t => !!t && getComputedStyle(t).display !== 'none', img = document.querySelector('.sv-img[data-set="' + g.dataset.set + '"]');
    const box = g.querySelector('.sv-box').getBoundingClientRect(), i = img && img.parentNode.getBoundingClientRect(), st = g.querySelector('.sv-st');
    return [g.dataset.set, img && img.parentNode.classList.contains('in') && img.naturalWidth ? 'picture' : 'block', shown(g.querySelector('.sv-t')) ? 'name' : shown(st) ? 'strip: ' + st.textContent : 'no name',
      !i || (i.left >= box.left && i.right <= box.right && i.top >= box.top && i.bottom <= (shown(st) ? st.getBoundingClientRect().top + 1 : box.bottom)) ? '' : 'picture outside its set'].filter(Boolean).join(', ');
  }));
  assert.deepEqual(await drawn(), ['a, picture, strip: Galaxy Explorer', 'b, block, name', 'n, block, name', 'o, block, name', 's, picture, no name'],
    'a set whose picture arrives shows it over its name on a strip; a tiny one the picture alone; the others stay colour blocks');
  assert.deepEqual(asked.filter(a => /from/.test(a)), [], 'no picture request says which page asked');
  assert.ok(!asked.some(a => /21327/.test(a)) && asked.some(a => /21318/.test(a)), 'a set that isn’t built any more isn’t asked for: ' + asked.join(' '));
  // A tap on the picture opens the set, and the drawing keeps its pictures when it's drawn again.
  const at = await p.evaluate(() => { const r = document.querySelector('.sv-img[data-set="a"]').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; });
  await p.touchscreen.tap(at[0], at[1]);
  await p.waitForSelector('#z-save');
  assert.equal(await p.textContent('#sheetTitle'), 'Galaxy Explorer', 'a tap on a picture opens its set');
  await p.click('#z-save');
  await p.waitForFunction(() => !document.querySelector('.scrim'));
  assert.equal((await drawn())[0], 'a, picture, strip: Galaxy Explorer', 'drawn again, the picture is there at once');
  await p.evaluate(() => { window.brickyard.pref('pics', false); window.brickyard.refresh(); });
  assert.deepEqual([await p.locator('.sv-img').count(), (await drawn())[0]], [0, 'a, block, name'], 'with Show set pictures off the drawing is colour blocks');
  await c.close();
}

// A set can be put on a full shelf by hand. In Where it stands, a shelf that is only short of room can be chosen
// and says by how much it would be over (every full shelf was greyed out, so after Fit nothing could be moved); one
// too short for the set stays greyed out. Chosen, the set stands there and the shelf is flagged overfull.
{
  const set = (id, name, w, d, h) => ({ id, t: 1, name, state: 'built', size: { w, d, h } });
  const { c, p } = await withSets({ sets: { a: set('a', 'Long', 50, 10, 10), b: set('b', 'Wide', 38, 26, 10) }, cases: { k: { id: 'k', t: 1, name: 'Billy', w: 76, d: 26, levels: [{ h: 32, sets: [{ id: 'a' }] }, { h: 8, sets: [] }] } } });
  await p.goto(base + '#shelves');
  await p.waitForSelector('.case');
  assert.equal(await p.locator('[data-act="fill"]').count(), 0, 'Fit has nothing it can place');
  await p.click('#shelves-body .list .item[data-set="b"]');
  await p.waitForSelector('#z-where');
  assert.deepEqual(await p.evaluate(() => [document.getElementById('z-msg').textContent].concat([...document.querySelectorAll('#z-where option')].slice(1).map(o => o.textContent + (o.disabled ? ' [greyed]' : '')))),
    ['No room left on a shelf it fits. You can still choose a full shelf here: it will show as overfull until a set comes off.', 'Billy · shelf 1 (32 cm) · full, 13 cm over with this', 'Billy · shelf 2 (8 cm) · too tall [greyed]'],
    'a full shelf can be chosen and says how far over it would be; one too short can’t');
  await p.selectOption('#z-where', 'k:0');
  await p.click('#z-save');
  await p.waitForFunction(() => !document.querySelector('.scrim'));
  assert.deepEqual([await p.evaluate(() => window.BrickCore.shelves(window.brickyard.doc()).k.levels[0].sets.map(q => q.id)), await p.textContent('.toast span'), await p.textContent('.case .flag.bad'), await p.locator('.sv-tag.bad').count()],
    [['a', 'b'], 'Wide is on Billy, shelf 1, which is now 13 cm over', 'Shelf 1 is overfull: 89 cm of sets on a 76 cm shelf. Move a set off, or turn one side-on.', 1], 'chosen, the set stands there and the shelf is flagged overfull');
  await p.locator('.sv-set[data-set="b"]').click();
  await p.waitForSelector('#z-where');
  await p.selectOption('#z-where', '');
  await p.click('#z-save');
  await p.waitForFunction(() => !document.querySelector('.scrim'));
  assert.deepEqual([await p.textContent('.toast span'), await p.locator('.case .flag.bad').count()], ['Off the shelves', 0], 'and moving it off clears the flag');
  await c.close();
}

// "Keep themes together" under Fit: off to begin with, and Fit then puts each set on the closest fit. Ticked, a set
// goes beside one of its own theme first, and the tick is still there after a reload (kept with the device's other
// settings, not in the catalog). It's only there while there is something for Fit to place.
{
  const set = (id, name, theme, w, h) => ({ id, t: 1, name, theme, state: 'built', size: { w, d: 20, h } });
  const sets = { f: set('f', 'Falcon', 'Star Wars', 40, 20), x: set('x', 'X-wing', 'Star Wars', 20, 20), b: set('b', 'Bonsai', 'Botanical', 50, 20) };
  const { c, p } = await withSets({ sets, cases: { k: { id: 'k', t: 1, name: 'Billy', w: 76, d: 26, levels: [{ h: 30, sets: [{ id: 'f' }] }, { h: 30, sets: [{ id: 'b' }] }] } } });
  const on = () => p.evaluate(() => window.BrickCore.shelves(window.brickyard.doc()).k.levels.map(l => l.sets.map(q => q.id).join('+')).join(' / '));
  await p.goto(base + '#shelves');
  await p.waitForSelector('.case');
  assert.deepEqual([await p.isChecked('#fit-themes'), await p.textContent('#fit-themes-row')], [false, ' Keep themes together'], 'the choice is under Fit, not ticked');
  await p.click('[data-act="fill"]');
  assert.deepEqual([await on(), await p.locator('#fit-themes').count()], ['f / b+x', 0], 'without it the closest fit; and with nothing left to place the choice goes with the button');
  await p.click('.toast button');
  await p.tap('#fit-themes-row');
  assert.deepEqual([await p.isChecked('#fit-themes'), await p.evaluate(() => [JSON.parse(localStorage.getItem('brickyard.prefs')).fitThemes, JSON.stringify(window.brickyard.doc()).includes('fitThemes')])], [true, [true, false]], 'ticking it is kept with the settings, not in the catalog');
  await p.reload();
  await p.waitForSelector('.case');
  assert.equal(await p.isChecked('#fit-themes'), true, 'and is still ticked after a reload');
  await p.click('[data-act="fill"]');
  assert.equal(await on(), 'f+x / b', 'ticked, the X-wing goes beside the Falcon');
  await c.close();
}

// Fit has Undo, and a bookcase can be started again: "Take every set off" in its sheet, on a second tap, with Undo
// too. (Fit leaves placed sets where they are, so a fresh arrangement meant opening every set's sheet.) When nothing
// waiting fits, the count says so, and one line under Not on a shelf yet adds up why: how many need more shelf and
// about how much, how many are too tall or too deep. The sets that only need room come first.
{
  const set = (id, name, w, d, h) => ({ id, t: 1, name, state: 'built', size: { w, d, h } });
  const sets = { t: set('t', 'Tree House', 27, 24, 37), g: set('g', 'Galaxy Explorer', 52, 32, 13), e: set('e', 'Eiffel Tower', 58, 58, 149) };
  for (let i = 0; i < 6; i++) sets['s' + i] = set('s' + i, 'Set ' + i, 30, 20, 20);
  const { c, p } = await withSets({ sets, cases: { k: { id: 'k', t: 1, name: 'Billy', w: 76, d: 26, levels: [{ h: 32, sets: [] }, { h: 32, sets: [] }] } } });
  const toastSays = () => p.evaluate(() => { const t = document.querySelector('.toast'); return t && !t.hidden ? [t.querySelector('span').textContent, (t.querySelector('button') || {}).textContent || ''] : null; });
  const on = () => p.evaluate(() => window.BrickCore.shelves(window.brickyard.doc()).k.levels.map(l => l.sets.map(q => q.id).join('+')).join(' / '));
  const waiting = () => p.evaluate(() => ({ sum: document.querySelector('#shelves-body .sumline').textContent, line: (document.getElementById('need-line') || {}).textContent || '', rows: [...document.querySelectorAll('#shelves-body .list .item .t')].map(e => e.textContent).join(', ') }));
  await p.goto(base + '#shelves');
  await p.waitForSelector('.case');
  assert.deepEqual(await waiting(), { sum: '0 of 9 sets on shelves', line: '2 are taller than your tallest shelf (32 cm). 1 is deeper than your bookcase (26 cm).', rows: 'Set 0, Set 1, Set 2, Set 3, Set 4, Set 5, Tree House, Galaxy Explorer, Eiffel Tower' }, 'before Fit: the sets that fit first');
  await p.click('[data-act="fill"]');
  assert.deepEqual([await on(), await toastSays()], ['s0+s1 / s2+s3', ['4 sets placed; 5 didn’t fit', 'Undo']], 'Fit says what it did, with Undo');
  assert.deepEqual(await waiting(), { sum: '4 of 9 sets on shelves; the other 5 don’t fit', line: '2 need more shelf: about 65 cm. 2 are taller than your tallest shelf (32 cm). 1 is deeper than your bookcase (26 cm).', rows: 'Set 4, Set 5, Tree House, Galaxy Explorer, Eiffel Tower' },
    'the count says nothing else fits, and one line adds up why');
  await p.click('.toast button');
  assert.deepEqual([await on(), await toastSays(), await p.locator('[data-act="fill"]').count()], [' / ', ['Took those 4 sets off again', ''], 1], 'Undo takes them off again');
  await p.click('[data-act="fill"]');
  await p.click('[data-case="k"]');
  await p.click('#k-clear');
  assert.deepEqual([await p.textContent('#k-clear'), await on()], ['Tap again to take all 4 off', 's0+s1 / s2+s3'], 'taking every set off asks first');
  await p.waitForTimeout(650);
  await p.click('#k-clear');
  assert.deepEqual([await on(), await toastSays(), await p.locator('.sheet').count()], [' / ', ['4 sets are off Billy', 'Undo'], 0]);
  await p.click('.toast button');
  assert.deepEqual([await on(), await toastSays()], ['s0+s1 / s2+s3', ['Those 4 sets are back on their shelves', '']], 'and Undo stands them where they were');
  await c.close();
}

// What's wrong on a bookcase is said in words, with which shelf, which set and by how much, and the shelf's label has
// a "!" (it was a red board and "A shelf is overfull, marked in red"). For a screen reader the drawing is a group:
// each set is a button that says its shelf, whether it's side-on and what's wrong; each shelf's label says its height
// and what's on it, an empty one too; Edit says which bookcase, and a heading how many sets. A set's name is white on
// a colour dark enough for 4.5:1. The keyboard's place survives the redraw after Save and Fit.
{
  const set = (id, name, w, d, h, more) => ({ id, t: 1, name, state: 'built', size: { w, d, h }, ...more });
  const { c, p } = await withSets({ sets: { ge: set('ge', 'Galaxy Explorer', 52, 25, 13), lb: set('lb', 'London Bus', 34, 9, 18), th: set('th', 'Tree House', 27, 24, 37), bq: set('bq', 'Flower Bouquet', 26, 13, 31),
    w1: set('w1', 'Bonsai Tree', 20, 15, 18), w2: set('w2', 'Eiffel Tower', 58, 58, 149), ns: { id: 'ns', t: 1, name: 'Orchid', state: 'built' } },
    cases: { k: { id: 'k', t: 1, name: 'Office Billy', w: 76, d: 26, levels: [{ h: 32, sets: [{ id: 'ge' }, { id: 'lb' }] }, { h: 32, sets: [{ id: 'th' }, { id: 'bq', turn: true }] }, { h: 40, sets: [] }] } } }, { viewport: { width: 1280, height: 800 }, hasTouch: false });
  await p.goto(base + '#shelves');
  await p.waitForSelector('.case');
  assert.deepEqual(await p.locator('.case .flag.bad').allTextContents(), ['Shelf 1 is overfull: 87 cm of sets on a 76 cm shelf. Move a set off, or turn one side-on.', 'Tree House (37 cm) is too tall for shelf 2 (32 cm). Move it to a taller shelf.'], 'the flags say which shelf, which set and by how much');
  const said = await p.evaluate(() => { const svg = document.querySelector('svg.shelf'); return {
    svg: [svg.getAttribute('role'), svg.getAttribute('aria-label')], sets: [...svg.querySelectorAll('.sv-set')].map(g => g.getAttribute('aria-label')),
    shelves: [...svg.querySelectorAll('g[role="img"]')].map(g => g.getAttribute('aria-label') + ' = ' + g.textContent), boards: [...svg.querySelectorAll('.sv-board')].map(b => b.classList.contains('bad')),
    edit: document.querySelector('[data-case]').getAttribute('aria-label'), heads: [...document.querySelectorAll('#shelves-body h2.group')].map(h => h.getAttribute('aria-label')) }; });
  assert.deepEqual(said, { svg: ['group', 'Office Billy from the front'],
    sets: ['Galaxy Explorer, Office Billy, shelf 1', 'London Bus, Office Billy, shelf 1', 'Tree House, Office Billy, shelf 2, too tall for this shelf', 'Flower Bouquet, Office Billy, shelf 2, side-on'],
    shelves: ['Shelf 1, 32 cm, 2 sets, overfull = ! 1 · 32 cm', 'Shelf 2, 32 cm, 2 sets, a set too tall = ! 2 · 32 cm', 'Shelf 3, 40 cm, empty = 3 · 40 cm'], boards: [true, true, false],
    edit: 'Edit Office Billy', heads: ['Not on a shelf yet, 2 sets', 'Needs a size, 1 set'] }, 'everything in the drawing has a name that says what it is');
  // White on each colour a set can be drawn in.
  const ratios = await p.evaluate(() => {
    const lum = c => [0.2126, 0.7152, 0.0722].reduce((n, k, i) => { const v = c[i] / 255; return n + k * (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4); }, 0), seen = {};
    for (let i = 0; i < 400 && Object.keys(seen).length < 8; i++) {
      const d = window.brickyard.doc(); window.brickyard.putSet(Object.assign({}, d.sets.ge, { theme: 'Theme ' + i })); window.brickyard.refresh();
      const fill = document.querySelector('.sv-set[data-set="ge"] .sv-box').getAttribute('fill');
      seen[fill] = +(1.05 / (lum([1, 3, 5].map(k => parseInt(fill.slice(k, k + 2), 16))) + 0.05)).toFixed(2);
    }
    return seen;
  });
  assert.equal(Object.keys(ratios).length, 8, 'every colour was drawn');
  assert.deepEqual(Object.entries(ratios).filter(r => r[1] < 4.5), [], 'white measures at least 4.5:1 on every colour of set');
  // The keyboard's place.
  await p.focus('.sv-set[data-set="lb"]');
  const ring = await p.evaluate(() => { const g = document.activeElement, cs = e => getComputedStyle(g.querySelector(e)); return [cs('.sv-box').stroke !== cs('.sv-ring').stroke, parseFloat(cs('.sv-box').strokeWidth) >= 0.8, cs('.sv-ring').stroke !== 'none']; });
  assert.deepEqual(ring, [true, true, true], 'a set with the focus has a dark line round it and a light one outside');
  await p.keyboard.press('Enter');
  await p.fill('#z-h', '17');
  await p.click('#z-save');
  await p.waitForTimeout(300); // Back over the sheet's place in history can move the focus a moment later
  assert.deepEqual(await p.evaluate(() => [document.activeElement.dataset.set, document.activeElement.classList.contains('sv-set'), window.brickyard.doc().sets.lb.size.h]), ['lb', true, 17], 'after Save the focus is back on the set');
  await p.focus('[data-act="fill"]');
  await p.keyboard.press('Enter');
  assert.equal(await p.evaluate(() => document.activeElement.dataset.act), 'add-case', 'after Fit, with nothing left to fit, it is on the next button and not lost');
  await p.focus('[data-case="k"]');
  await p.keyboard.press('Enter');
  await p.fill('#k-name', 'Hall Billy');
  await p.click('#k-save');
  await p.waitForTimeout(300);
  assert.deepEqual(await p.evaluate(() => [document.activeElement.dataset.case, document.activeElement.getAttribute('aria-label')]), ['k', 'Edit Hall Billy'], 'and after saving a bookcase, on its Edit button');
  await c.close();
}
// Sizes from Claude: each tick says whose size it adds.
{
  const { c, p } = await withSets({ sets: { g: { id: 'g', t: 1, num: '10497-1', name: 'Galaxy Explorer', state: 'built' } } });
  await p.goto(base + '#z1j' + Buffer.from(JSON.stringify({ brickyard: 1, sizes: [{ num: '10497', w: 52, d: 32, h: 13 }] })).toString('base64url'));
  await p.waitForSelector('#zr-go');
  assert.equal(await p.getAttribute('#zr input', 'aria-label'), 'Add size for Galaxy Explorer');
  await c.close();
}

// A set's sheet in the planner. A tick that can't be honoured keeps the sheet open and says why (it closed as if it
// had worked). Move left and Move right save what else the sheet holds first (a height typed before Move was thrown
// away). Each shelf in the list is named with its bookcase, the set's number and theme are under its name, and a
// set that fits nowhere says why here too.
{
  const set = (id, name, w, d, h, more) => ({ id, t: 1, name, state: 'built', size: { w, d, h }, ...more });
  const { c, p } = await withSets({ sets: { lm: set('lm', 'Lamborghini Sián', 60, 25, 13, { num: '42115-1', theme: 'Technic' }), bs: set('bs', 'Medieval Blacksmith', 27, 21, 27), lb: set('lb', 'London Bus', 34, 9, 18),
    bq: set('bq', 'Flower Bouquet', 26, 13, 20), ge: set('ge', 'Galaxy Explorer', 52, 32, 13) },
    cases: { k: { id: 'k', t: 1, name: 'Billy', w: 76, d: 26, levels: [{ h: 32, sets: [{ id: 'lm' }] }, { h: 32, sets: [{ id: 'bs' }, { id: 'lb' }, { id: 'bq', turn: true }] }] } } });
  const row = () => p.evaluate(() => window.BrickCore.shelves(window.brickyard.doc()).k.levels[1].sets.map(q => q.id + (q.turn ? '*' : '')).join(' '));
  await p.goto(base + '#shelves');
  await p.click('.sv-set[data-set="lm"]');
  assert.deepEqual([await p.textContent('#z-which'), await p.textContent('#z-where option:checked'), await p.textContent('#z-msg')], ['42115 · Technic', 'Billy · shelf 1 (32 cm)', ''], 'the sheet says which set it is, and which bookcase its shelf is on');
  await p.check('#z-turn');
  await p.click('#z-save');
  assert.deepEqual([await p.locator('.sheet').count(), await p.textContent('#z-msg'), await p.evaluate(() => !!window.BrickCore.shelves(window.brickyard.doc()).k.levels[0].sets[0].turn)], [1, 'Side-on it’s 60 cm deep; the shelf is 26.', false], 'a tick that can’t be honoured keeps the sheet open and says why');
  await discard(p);
  // Facing out needs more room than the shelf has left.
  await p.click('.sv-set[data-set="bq"]');
  await p.uncheck('#z-turn');
  await p.click('#z-save');
  assert.deepEqual([await p.locator('.sheet').count(), await p.textContent('#z-msg')], [1, 'Facing out it needs 26 cm; 13 are left.']);
  await discard(p);
  // Move saves the size typed first.
  await p.click('.sv-set[data-set="bs"]');
  await p.fill('#z-h', '30');
  await p.click('#z-right');
  assert.deepEqual([await p.locator('.sheet').count(), await row(), await p.evaluate(() => window.brickyard.doc().sets.bs.size.h), await p.inputValue('#z-h')], [1, 'lb bs bq*', 30, '30'], 'Move right moves the set and keeps the height typed');
  await p.click('[data-close]');
  await p.waitForFunction(() => !document.querySelector('.scrim'));
  await p.click('.sv-set[data-set="bs"]');
  await p.fill('#z-h', 'tall');
  await p.click('#z-left');
  assert.deepEqual([await p.locator('.sheet').count(), await row()], [1, 'lb bs bq*'], 'and a size that can’t be read stops the move');
  await discard(p);
  await p.click('#shelves-body .list .item:has-text("Galaxy Explorer")');
  assert.equal(await p.textContent('#z-msg'), '32 cm deep; your bookcase is 26 cm deep', 'a set that fits nowhere says why in its sheet');
  await c.close();
}

// The presets. A Billy's six spaces are about 30 cm (six of 32 cm and its five 2 cm shelves would be 202 cm, the whole
// outside height, with no top, bottom or plinth), and the sheet says they're a guess to measure. A Kallax is 39 cm
// deep inside (IKEA UK's product pages, 10 November 2026).
{
  const { c, p } = await withSets({ sets: {} });
  const sheet = () => p.evaluate(() => [document.getElementById('k-w').value, document.getElementById('k-d').value, [...document.querySelectorAll('#k-levels input')].map(i => i.value).join(' '), document.getElementById('k-note').textContent]);
  await p.goto(base + '#shelves');
  await p.click('[data-act="add-case"]');
  assert.deepEqual(await sheet(), ['76', '26', '30 30 30 30 30 30', 'Billy shelves move: these are six even spaces of about 30 cm. Measure yours.']);
  await p.click('#k-preset [data-k="1"]');
  assert.deepEqual((await sheet()).slice(0, 3), ['36', '26', '30 30 30 30 30 30']);
  await p.click('#k-preset [data-k="2"]');
  assert.deepEqual(await sheet(), ['33', '39', '33 33 33 33', 'Measure yours for a close fit.']);
  await p.click('#k-preset [data-k="3"]');
  assert.deepEqual(await sheet(), ['', '', '', ''], 'My own starts with one empty shelf');
  await p.click('#k-preset [data-k="0"]');
  await p.click('#k-save');
  assert.deepEqual(await p.evaluate(() => Object.values(window.BrickCore.shelves(window.brickyard.doc())).map(k => [k.name, k.w, k.d, k.levels.map(l => l.h).join(' ')])), [['Billy', 76, 26, '30 30 30 30 30 30']]);
  await c.close();
}

// A size from Claude that looks wrong for its set arrives unticked, with a line saying why: a 4,514-piece castle 3 cm
// tall, inches sent as cm, a size nothing like the one the set has. One sent in mm (840 cm wide) is left out and
// counted, where it used to be offered as 500 × 500 × 210 cm. Each row shows the set's number.
{
  const { c, p } = await withSets({ sets: { ge: { id: 'ge', t: 1, num: '10497-1', name: 'Galaxy Explorer', pieces: 1254, state: 'built' }, lk: { id: 'lk', t: 1, num: '10305-1', name: 'Lion Knights’ Castle', pieces: 4514, state: 'built' },
    mc: { id: 'mc', t: 1, num: '31120-1', name: 'Medieval Castle', pieces: 1426, state: 'built' }, mf: { id: 'mf', t: 1, num: '75192-1', name: 'Millennium Falcon', pieces: 7541, state: 'built' },
    lb: { id: 'lb', t: 1, num: '10258-1', name: 'London Bus', pieces: 1686, state: 'built', size: { w: 34, d: 9, h: 18 } } } });
  const sizes = [{ num: '10497', w: 52, d: 32, h: 13 }, { num: '10305', w: 44, d: 33, h: 3 }, { num: '31120', w: 12.6, d: 10.2, h: 8.7 }, { num: '75192', w: 840, d: 560, h: 210 }, { num: '10258', w: 68, d: 18, h: 36 }];
  await p.goto(base + '#z1j' + Buffer.from(JSON.stringify({ brickyard: 1, sizes })).toString('base64url'));
  await p.waitForSelector('#zr-go');
  assert.deepEqual(await p.evaluate(() => [...document.querySelectorAll('#zr li')].map(li => [li.querySelector('input').checked ? 'ticked' : 'unticked', li.querySelector('.m').textContent, (li.querySelector('.w') || {}).textContent || ''].join(' | '))), [
    'ticked | 10497 · 52 × 32 × 13 cm | ', 'unticked | 10305 · 44 × 33 × 3 cm | Check: 3 cm tall for 4,514 pieces?', 'unticked | 31120 · 12.6 × 10.2 × 8.7 cm | Check: 8.7 cm tall for 1,426 pieces?',
    'unticked | 10258 · 68 × 18 × 36 cm · replaces 34 × 9 × 18 cm | Check: Very different from the size it has now.'], 'sizes that look wrong are unticked and say why');
  assert.deepEqual([await p.textContent('.sheet .note'), await p.textContent('#zr-n')], ['Sizes Claude found for your sets. Sets that already have a size are unticked; tick one to replace it. 3 sizes look wrong and are unticked too: check them before you tick. One size in the list couldn’t be read.', '1 of 4 ticked']);
  await p.click('#zr-go');
  assert.deepEqual(await p.evaluate(() => Object.values(window.brickyard.doc().sets).filter(x => x.size).map(x => x.id).sort()), ['ge', 'lb'], 'only the ticked size is added');
  await c.close();
}

// A set made taller than its shelf after it was placed is marked, like an overfull shelf.
{
  const { c, p } = await withSets({ sets: { t: { id: 't', t: 1, name: 'Typewriter', state: 'built', size: { w: 30, d: 30, h: 20 } } },
    cases: { k: { id: 'k', t: 1, name: 'Kallax', w: 33, d: 37, levels: [{ h: 33, sets: [] }, { h: 33, sets: [{ id: 't' }] }] } } });
  await p.goto(base + '#shelves');
  await p.waitForSelector('.sv-set');
  assert.equal(await p.locator('.case .flag.bad').count(), 0, 'nothing marked at first');
  await p.click('.sv-set');
  await p.fill('#z-h', '60');
  await p.click('#z-save');
  assert.equal(await p.locator('.case .flag.bad').count(), 1, 'a set taller than its shelf is marked');
  assert.equal(await p.textContent('.case .flag.bad'), 'Typewriter (60 cm) is too tall for shelf 2 (33 cm). Move it to a taller shelf.', 'by name, with both heights');
  await c.close();
}

// On a phone a tall bookcase is drawn the full width of the screen, so its shelf labels can be read (about 11 px,
// where they were 6). The page scrolls instead.
{
  const { c, p } = await withSets({ sets: {}, cases: { k: { id: 'k', t: 1, name: 'Billy', w: 76, d: 26, levels: [32, 32, 32, 32, 32, 32].map(h => ({ h, sets: [] })) } } });
  await p.goto(base + '#shelves');
  await p.waitForSelector('svg.shelf');
  const [w, room, px] = await p.evaluate(() => {
    const s = document.querySelector('svg.shelf'), r = s.getBoundingClientRect();
    return [r.width, s.closest('.case').clientWidth - 24, parseFloat(getComputedStyle(s.querySelector('.sv-h')).fontSize) * r.width / s.viewBox.baseVal.width];
  });
  assert.ok(Math.abs(w - room) < 1, 'a Billy takes the card’s width on a phone (' + Math.round(w) + ' of ' + room + ' px)');
  assert.ok(px >= 9, 'its shelf labels are at least 9 px (' + px.toFixed(1) + ')');
  assert.equal(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'and nothing scrolls sideways');
  await c.close();
}

// A long reason under a set that doesn't fit is shown whole on a phone, not cut off.
{
  const { c, p } = await withSets({ sets: { l: { id: 'l', t: 1, name: 'Lamborghini Sián FKP 37', state: 'built', size: { w: 60, d: 26, h: 15 } } },
    cases: { k: { id: 'k', t: 1, name: 'Kallax', w: 33, d: 37, levels: [{ h: 33, sets: [] }] } } });
  await p.goto(base + '#shelves');
  const why = p.locator('#shelves-body .list .item:has-text("Lamborghini") .warn');
  assert.equal(await why.textContent(), 'At 60 × 26 cm, too big for your bookcase');
  assert.equal(await why.evaluate(e => e.scrollWidth <= e.clientWidth), true, 'the reason is shown whole');
  await c.close();
}

// Sizes for sets that aren't in My sets are counted in plain words.
{
  const { c, p } = await withSets({ sets: { g: { id: 'g', t: 1, num: '10497-1', name: 'Galaxy Explorer', state: 'built' } } });
  const sizes = nums => base + '#z1z' + deflateRawSync(JSON.stringify({ brickyard: 1, sizes: nums.map(num => ({ num, w: 20, d: 15, h: 10 })) })).toString('base64url');
  await p.goto(sizes(['10497', '99999']));
  await p.waitForSelector('#zr-go');
  assert.match(await p.textContent('.sheet .note'), /\. One set in the list isn’t in My sets\.$/);
  await p.goto('about:blank');
  await p.goto(sizes(['10497', '99999', '99998']));
  await p.waitForSelector('#zr-go');
  assert.match(await p.textContent('.sheet .note'), /\. 2 sets in the list aren’t in My sets\.$/);
  await c.close();
}

// Why a set isn't on a shelf is worked out afresh: adding a bookcase that takes it clears the old reason.
{
  const { c, p } = await withSets({ sets: {
    th: { id: 'th', t: 1, name: 'Tree House', state: 'built', size: { w: 30, d: 20, h: 39 } },
    bt: { id: 'bt', t: 1, name: 'Bonsai Tree', state: 'built', size: { w: 20, d: 15, h: 18 } } },
    cases: { k: { id: 'k', t: 1, name: 'Billy', w: 76, d: 26, levels: [{ h: 32, sets: [] }, { h: 32, sets: [] }] } } });
  await p.goto(base + '#shelves');
  await p.click('[data-act="fill"]');
  const why = () => p.locator('#shelves-body .list .item:has-text("Tree House") .warn').allTextContents();
  assert.deepEqual(await why(), ['39 cm tall; your tallest shelf is 32 cm'], 'the reason gives the set’s height and the tallest shelf’s');
  await p.click('[data-act="add-case"]');
  await p.click('#k-preset [data-k="3"]');
  await p.fill('#k-name', 'Tall one'); await p.fill('#k-w', '40'); await p.fill('#k-d', '30'); await p.fill('#k-h0', '45');
  await p.click('#k-save');
  assert.match(await p.textContent('[data-act="fill"]'), /Fit 1 set/);
  assert.deepEqual(await why(), [], 'the old reason goes once a bookcase would take the set');
  await c.close();
}

// A catalog brought in by Drive sync (which hands it to app.takeDoc) shows on the planner, and behind an open sheet.
{
  const { c, p } = await withSets({ sets: { a: { id: 'a', t: 1, name: 'Bonsai Tree', state: 'built' } } });
  const takeIn = extra => p.evaluate(x => {
    const d = JSON.parse(JSON.stringify(window.brickyard.doc()));
    Object.assign(d.sets, x.sets || {}); Object.assign(d.cases, x.cases || {});
    window.brickyard.takeDoc(d);
  }, extra);
  await p.goto(base + '#shelves');
  await p.waitForSelector('[data-act="add-case"]');
  await takeIn({ cases: { k: { id: 'k', t: 5, name: 'Hall Billy', w: 76, d: 26, levels: [{ h: 32, sets: [] }] } } });
  await p.waitForSelector('#shelves .case', { timeout: 5000 });
  await p.goto(base + '#catalog');
  await p.click('.item:has-text("Bonsai Tree")');
  await takeIn({ sets: { g: { id: 'g', t: 5, name: 'Galaxy Explorer', state: 'built' } } });
  await p.click('[data-close]');
  assert.deepEqual(await p.locator('#list-wrap .item .t').allTextContents(), ['Bonsai Tree', 'Galaxy Explorer'], 'My sets caught up behind the sheet');
  await c.close();
}

// A save in another tab shows here without moving this tab to the top or a model back to its first step.
{
  const many = {};
  for (let i = 0; i < 20; i++) many['s' + i] = { id: 's' + i, t: 1, name: 'Set ' + String(i).padStart(2, '0'), room: 'Office' };
  const { c, p } = await withSets({ sets: many });
  const other = await c.newPage();
  other.on('pageerror', e => problems.push(e.message));
  await other.goto(base + '#catalog');
  const saveThere = note => other.evaluate(n => window.brickyard.putSet(Object.assign({}, window.brickyard.doc().sets.s0, { notes: n })), note);
  const seen = note => p.waitForFunction(n => window.brickyard.doc().sets.s0.notes === n, note);
  await p.goto(base + '#catalog');
  await p.evaluate(() => window.scrollTo(0, 400));
  await saveThere('one'); await seen('one');
  assert.equal(await p.evaluate(() => Math.round(window.scrollY)), 400, 'a save in another tab leaves this one where it was');
  await p.goto(base + '#model-x-cottage');
  await p.waitForSelector('#model-view:not([hidden])');
  await p.click('#step-next'); await p.click('#step-next'); await p.click('#step-next');
  assert.equal(await p.textContent('#step-n'), 'Step 3');
  await saveThere('two'); await seen('two');
  await p.waitForTimeout(1000);
  assert.equal(await p.textContent('#step-n'), 'Step 3', 'a model being built stays on its step');
  await c.close();
}

// Small text reads at 4.5:1 or better, light and dark: the Built, Can build and Sealed badges, the ✓ note when you have
// every piece, and the white on the red buttons (which sit on a deeper red in dark mode).
{
  const ratio = (p, sel, under) => p.evaluate(([sel, under]) => {
    const parse = c => {
      const m = /^(?:rgba?|color)\((?:srgb )?([^)]*)\)/.exec(c), v = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
      return c.startsWith('color(') ? [v[0], v[1], v[2], v[3] ?? 1] : [v[0] / 255, v[1] / 255, v[2] / 255, v[3] ?? 1];
    };
    const over = (a, b) => [0, 1, 2].map(i => a[i] * a[3] + b[i] * (1 - a[3])).concat(1);
    const lum = c => [0.2126, 0.7152, 0.0722].reduce((n, k, i) => n + k * (c[i] <= 0.03928 ? c[i] / 12.92 : ((c[i] + 0.055) / 1.055) ** 2.4), 0);
    const s = getComputedStyle(document.querySelector(sel)), bg = over(parse(s.backgroundColor), parse(getComputedStyle(document.querySelector(under)).backgroundColor));
    const a = lum(over(parse(s.color), bg)), b = lum(bg);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  }, [sel, under]);
  const sets = { b: { id: 'b', t: 1, num: '10698-1', name: 'Large Creative Brick Box', state: 'apart' }, s: { id: 's', t: 1, name: 'Castle', state: 'sealed' }, g: { id: 'g', t: 1, name: 'Galaxy', state: 'built' } };
  for (const colorScheme of ['light', 'dark']) {
    const { c, p } = await withSets({ sets }, { colorScheme });
    await p.goto(base + '#catalog');
    const got = { Built: await ratio(p, '.badge.built', '.item'), Sealed: await ratio(p, '.badge.sealed', '.item'), button: await ratio(p, '#add-btn', 'body') };
    await p.goto(base + '#build');
    await p.waitForSelector('a[href="#model-x-cottage"] .badge.built');
    got['Can build'] = await ratio(p, 'a[href="#model-x-cottage"] .badge.built', 'a[href="#model-x-cottage"]');
    await p.click('a[href="#model-x-cottage"]');
    await p.waitForSelector('#model-check .note.ok');
    got['every piece'] = await ratio(p, '#model-check .note.ok', 'body');
    for (const [what, r] of Object.entries(got)) assert.ok(r >= 4.5, colorScheme + ': ' + what + ' is ' + r.toFixed(2) + ':1');
    await c.close();
  }
}

// More small text at 4.5:1 or better, light and dark, each against what's painted behind it with any fading counted:
// the red words (To check and Missing pieces on a row, the reason in a batch from Claude, Remove, "short" by a piece:
// 4.1:1 in dark mode on the brighter red that suits a button), the Taken apart badge, the examples in empty boxes
// (the browser's grey, 3.6:1 in dark mode), and an unticked set in a batch from Claude, whose whole row was faded to
// 55%, taking the reason it's unticked to 2.5:1. And the chosen State button has a line round it that stands out
// from its track at 3:1 or better (the button alone was 1.2:1 in light, 1.8:1 in dark).
{
  // What's painted for `sel` (or its ::pseudo) over the backgrounds of `under`, outermost last, with the fading
  // (opacity) of the element and everything round it up to the last of them.
  const ratio = (p, sel, under, pseudo, what = 'color') => p.evaluate(([sel, under, pseudo, what]) => {
    const parse = c => {
      const m = /^(?:rgba?|color)\((?:srgb )?([^)]*)\)/.exec(c), v = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
      return c.startsWith('color(') ? [v[0], v[1], v[2], v[3] ?? 1] : [v[0] / 255, v[1] / 255, v[2] / 255, v[3] ?? 1];
    };
    const over = (a, b) => [0, 1, 2].map(i => a[i] * a[3] + b[i] * (1 - a[3])).concat(1);
    const lum = c => [0.2126, 0.7152, 0.0722].reduce((n, k, i) => n + k * (c[i] <= 0.03928 ? c[i] / 12.92 : ((c[i] + 0.055) / 1.055) ** 2.4), 0);
    const el = document.querySelector(sel), grounds = under.map(u => document.querySelector(u)), last = grounds[grounds.length - 1];
    const bg = grounds.reduceRight((b, g) => over(parse(getComputedStyle(g).backgroundColor), b), [1, 1, 1, 1]);
    let fade = 1;
    for (let e = el; e && e !== last; e = e.parentElement) fade *= +getComputedStyle(e).opacity;
    const ink = parse(what === 'ring' ? /rgba?\([^)]*\)[^,]*inset|inset[^,]*rgba?\([^)]*\)/.exec(getComputedStyle(el).boxShadow)[0].match(/rgba?\([^)]*\)/)[0] : getComputedStyle(el, pseudo || undefined).color);
    if (pseudo === '::placeholder') ink[3] *= +getComputedStyle(el, pseudo).opacity;
    ink[3] *= fade;
    const a = lum(over(ink, bg)), b = lum(bg);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  }, [sel, under, pseudo, what]);
  const sets = { b: { id: 'b', t: 1, num: '10698-1', name: 'Large Creative Brick Box', state: 'apart', check: 'or 10696?', missing: 'a red brick' }, g: { id: 'g', t: 1, num: '10497-1', name: 'Galaxy Explorer', state: 'built' } };
  const batch = { brickyard: 1, batch: { sets: [{ num: '10497', name: 'Galaxy Explorer', year: 2022, check: 'the box was half hidden' }] } };
  for (const colorScheme of ['light', 'dark']) {
    const { c, p } = await withSets({ sets }, { colorScheme });
    await p.goto(base + '#catalog');
    const got = { 'To check on a row': await ratio(p, '.item .m.warn', ['.item', 'body']), 'Taken apart': await ratio(p, '.badge.apart', ['.badge.apart', '.item', 'body']),
      'the search’s example': await ratio(p, '#q', ['#q'], '::placeholder') };
    await p.evaluate(() => document.querySelector('#list-wrap').insertAdjacentHTML('beforeend', '<div class="callout"><ul class="need"><li class="short"><small id="probe">2 of 4</small></li></ul></div>'));
    got['short, by a piece'] = await ratio(p, '#probe', ['.callout', 'body'], '::after');
    await p.click('.item[data-id="g"]');
    Object.assign(got, { Remove: await ratio(p, '#e-del', ['.sheet']), 'a box’s example': await ratio(p, '#e-box', ['#e-box'], '::placeholder'), 'an example in Missing pieces': await ratio(p, '#e-missing', ['#e-missing'], '::placeholder') });
    const ring = await ratio(p, '#e-state [aria-pressed="true"]', ['#e-state', '.sheet'], '', 'ring');
    assert.ok(ring >= 3, colorScheme + ': the line round the chosen State button is ' + ring.toFixed(2) + ':1 against its track');
    await p.click('[data-close]');
    await p.goto(base + '#b1z' + deflateRawSync(JSON.stringify(batch)).toString('base64url'));
    await p.waitForSelector('.rv li.off');
    Object.assign(got, { 'an unticked set’s name': await ratio(p, '.rv li.off .t', ['.rv li.off', '.sheet']), 'its details': await ratio(p, '.rv li.off .m', ['.rv li.off', '.sheet']),
      'why it’s unticked': await ratio(p, '.rv li.off .w', ['.rv li.off', '.sheet']) });
    for (const [what, r] of Object.entries(got)) assert.ok(r >= 4.5, colorScheme + ': ' + what + ' is ' + r.toFixed(2) + ':1');
    await c.close();
  }
}

// Build from your box says only what's so. A set with no parts list is named only when it's taken apart (its pieces
// are the ones not counted; it used to count every built and sealed set too, and promise Claude could add their
// pieces). With no set it can build from, it says which set it has a list for without presuming you own one. A set
// that's off says why by its state; its piece count is the one My sets shows; and "Tick a set" speaks of loose pieces
// only when there are some.
{
  const box = (id, state) => ({ id, t: 1, num: '10698-1', name: 'Large Creative Brick Box', pieces: 790, state });
  const other = (id, name, state) => ({ id, t: 1, num: '2131' + id.charCodeAt(0) % 10 + '-1', name, state });
  const says = p => p.evaluate(() => [...document.querySelectorAll('.pieces .how p, .pieces .flag, .pieces .note')].map(e => e.textContent));
  const first = await withSets({ sets: { a: other('a', 'Tree House', 'apart'), b: other('b', 'Galaxy Explorer', 'built'), c: other('c', 'Medieval Castle', 'sealed') } });
  await first.p.goto(base + '#build');
  await first.p.waitForSelector('#add-box');
  assert.deepEqual(await says(first.p), ['Brickyard builds from sets that are taken apart and that it has a parts list for. So far that is the Large Creative Brick Box (10698). Have one? Add it.',
    'Tree House is taken apart, but Brickyard has no parts list for it yet, so its pieces aren’t counted.', 'A parts list is a small file in the Brickyard project. Copy this set and paste it into a Claude session opened on the Brickyard project: it adds the list.']);
  await first.c.close();
  const many = await withSets({ sets: { a: other('a', 'Tree House', 'apart'), b: other('b', 'Galaxy Explorer', 'apart'), c: other('c', 'Medieval Castle', 'apart'), d: other('d', 'Typewriter', 'apart'),
    e: { id: 'e', t: 1, name: 'Bonsai Tree', state: 'apart' }, x: box('x', 'built'), y: box('y', 'partial'), z: box('z', 'sealed') },
    loose: { tub: { id: 'tub', t: 1, name: 'Blue tub', parts: [['3001', 4, 40]] } } });
  const p = many.p;
  await p.goto(base + '#build');
  await p.waitForSelector('[data-pool]');
  const rows = () => p.evaluate(() => [...document.querySelectorAll('.menu.pool li:not(.lot) small')].map(e => e.textContent));
  assert.deepEqual(await rows(), ['10698 · 790 pieces · built, so off unless you take it apart', '10698 · 790 pieces · partly built, so off', '10698 · 790 pieces · sealed, so off'], 'each set that’s off says why, with My sets’ piece count');
  assert.deepEqual(await says(p), ['Bonsai Tree, Galaxy Explorer, Medieval Castle and 2 more are taken apart, but Brickyard has no parts list for them yet, so their pieces aren’t counted.',
    'A parts list is a small file in the Brickyard project. Copy these sets and paste them into a Claude session opened on the Brickyard project: it adds each list. 1 of them has no set number, and a parts list goes by the number: add it in My sets.'], 'up to three are named');
  await p.uncheck('[data-pool="tub"]');
  await p.waitForFunction(() => document.querySelector('.pieces .flag'));
  assert.equal(await p.textContent('.pieces .flag'), 'Tick a set or some loose pieces to build from them.');
  await p.check('[data-pool="x"]');
  await p.waitForFunction(() => !document.querySelector('.pieces .flag'));
  assert.deepEqual([(await rows())[0], await p.textContent('.pieces .group span:last-child')], ['10698 · 790 pieces', '790'], 'ticked, it’s on and says no more');
  await many.c.close();
  const two = await withSets({ sets: { a: other('a', 'Tree House', 'apart'), b: other('b', 'Typewriter', 'apart'), x: box('x', 'built') } });
  await two.p.goto(base + '#build');
  await two.p.waitForSelector('[data-pool]');
  assert.deepEqual(await says(two.p), ['Tick a set to build from its pieces.', 'Tree House and Typewriter are taken apart, but Brickyard has no parts list for them yet, so their pieces aren’t counted.',
    'A parts list is a small file in the Brickyard project. Copy these sets and paste them into a Claude session opened on the Brickyard project: it adds each list.'], 'no word of loose pieces when there are none');
  await two.c.close();
}

// A full shelf can be read and tapped on a phone. The shelf's label sits on a tag drawn over the sets (a tall set at
// that end of the shelf used to run through the words) and that set's name starts below it. A set's name is never
// under 9 px and stays inside its rectangle: across on one line or two, up the side of a tall narrow set, cut short
// with an ellipsis, or the set's number. A small set takes taps on about 44 px each way, into the empty shelf beside
// and above it.
{
  const set = (id, name, w, d, h, more) => ({ id, t: 1, name, state: 'built', size: { w, d, h }, ...more });
  const { c, p } = await withSets({ sets: { a: set('a', 'Motorised Lighthouse', 25, 25, 31.5), b: set('b', 'Orchid', 30, 24, 31), w: set('w', 'Wildflower Bouquet', 26, 13, 31),
    n: set('n', 'A set with quite a long name', 6, 6, 21), g: set('g', '', 9, 9, 5, { num: '20915-1' }) },
    cases: { k: { id: 'k', t: 1, name: 'Billy', w: 76, d: 26, levels: [{ h: 32, sets: [{ id: 'a' }, { id: 'b' }, { id: 'w', turn: true }] }, { h: 32, sets: [{ id: 'n' }] }, { h: 32, sets: [{ id: 'g' }] }] } } });
  await p.goto(base + '#shelves');
  await p.waitForSelector('.sv-set');
  await p.evaluate(() => document.fonts.ready);
  const drawn = await p.evaluate(() => {
    const box = e => { const r = e.getBoundingClientRect(); return [r.left, r.top, r.right, r.bottom]; };
    const inside = (a, b) => a[0] >= b[0] - 1 && a[1] >= b[1] - 1 && a[2] <= b[2] + 1 && a[3] <= b[3] + 1, apart = (a, b) => a[2] <= b[0] || b[2] <= a[0] || a[3] <= b[1] || b[3] <= a[1];
    const svg = document.querySelector('svg.shelf'), kids = [...svg.children], tags = [...svg.querySelectorAll('.sv-tag')].map(box);
    const sets = [...svg.querySelectorAll('.sv-set')].map(g => {
      const t = g.querySelector('.sv-t'), hit = g.querySelector('.sv-hit').getBoundingClientRect();
      if (!t) return { id: g.dataset.set, says: '', px: 0, hit: [0, 0] };
      const tb = box(t);
      return { id: g.dataset.set, says: [...t.querySelectorAll('tspan')].map(s => s.textContent).join(' / ') || t.textContent, px: Math.min(tb[2] - tb[0], tb[3] - tb[1]) > 0 ? parseFloat(getComputedStyle(t).fontSize) * svg.getBoundingClientRect().width / svg.viewBox.baseVal.width : 0,
        inside: inside(tb, box(g.querySelector('.sv-box'))), clear: tags.every(k => apart(tb, k)), hit: [Math.round(hit.width), Math.round(hit.height)] };
    });
    return { sets, tagsLast: kids.findIndex(k => !!k.querySelector('.sv-tag')) > kids.map(k => k.classList.contains('sv-set')).lastIndexOf(true), labels: [...svg.querySelectorAll('.sv-h')].map(t => t.textContent) };
  });
  assert.deepEqual(drawn.sets.map(s => [s.id, s.says]), [['a', 'Motorised / Lighthouse'], ['b', 'Orchid'], ['w', 'Wildflower Bouquet'], ['n', 'A set with q…'], ['g', '20915']], 'what each set is called in the drawing');
  for (const s of drawn.sets) assert.deepEqual([s.id, s.px >= 9, s.inside, s.clear, s.hit[0] >= 43 && s.hit[1] >= 43], [s.id, true, true, true, true], 'a name of ' + s.px.toFixed(1) + ' px, inside its set, clear of the shelf’s label, with ' + s.hit.join(' × ') + ' px to tap');
  assert.deepEqual([drawn.tagsLast, drawn.labels], [true, ['1 · 32 cm', '2 · 32 cm', '3 · 32 cm']], 'the shelves’ labels are drawn over the sets');
  // Beside the narrow set, and above the low one, still opens it.
  for (const [id, title, where] of [['n', 'A set with quite a long name', 'beside'], ['g', 'Set 20915', 'above']]) {
    const [x, y] = await p.evaluate(([id, where]) => {
      const g = document.querySelector('.sv-set[data-set="' + id + '"]'), b = g.querySelector('.sv-box').getBoundingClientRect(), h = g.querySelector('.sv-hit').getBoundingClientRect();
      g.scrollIntoView({ block: 'center' });
      const b2 = g.querySelector('.sv-box').getBoundingClientRect(), h2 = g.querySelector('.sv-hit').getBoundingClientRect();
      return where === 'beside' ? [b2.right + (h2.right - b2.right) * 0.7, (b2.top + b2.bottom) / 2] : [(b2.left + b2.right) / 2, h2.top + (b2.top - h2.top) * 0.3];
    }, [id, where]);
    await p.touchscreen.tap(x, y);
    await p.waitForSelector('#z-save');
    assert.equal(await p.textContent('#sheetTitle'), title, 'a tap ' + where + ' a small set opens it');
    await p.click('[data-close]');
  }
  await c.close();
}

// On a screen wider than a phone every bookcase is drawn at one scale, the largest at which the tallest is 72% of
// the window's height, and they stand in a row with their feet level, like furniture along a wall. (Each was drawn
// as big as would fit, so a Kallax column and a low bench looked as tall as the Billy between them.) The row
// wraps in a narrower window, and never makes the page scroll sideways. On a phone each still has the full width.
{
  const cases = { b: { id: 'b', t: 1, name: 'Billy', w: 76, d: 26, levels: [30, 30, 30, 30, 30, 30].map(h => ({ h, sets: [] })) },
    k: { id: 'k', t: 1, name: 'Kallax', w: 33, d: 39, levels: [33, 33, 33, 33].map(h => ({ h, sets: [] })) },
    l: { id: 'l', t: 1, name: 'Low bench', w: 120, d: 30, levels: [{ h: 35, sets: [{ id: 'a' }] }] } };
  const sets = { a: { id: 'a', t: 1, name: 'Galaxy Explorer', state: 'built', size: { w: 52, d: 25, h: 13 } } };
  const drawn = p => p.evaluate(() => ({ wide: document.documentElement.scrollWidth - window.innerWidth, list: [...document.querySelectorAll('svg.shelf')].map(s => {
    const r = s.getBoundingClientRect(), t = s.querySelector('.sv-t');
    return { scale: r.width / s.viewBox.baseVal.width, top: r.top + scrollY, bottom: r.bottom + scrollY, left: r.left, right: r.right, h: r.height, name: t ? parseFloat(t.getAttribute('font-size')) * r.width / s.viewBox.baseVal.width : 0 };
  }) }));
  const same = (list, of) => Math.max(...list.map(of)) - Math.min(...list.map(of));
  const desk = await withSets({ sets, cases }, { viewport: { width: 1280, height: 800 }, hasTouch: false });
  await desk.p.goto(base + '#shelves');
  await desk.p.waitForSelector('.case');
  let d = await drawn(desk.p);
  assert.ok(same(d.list, x => x.scale) < 0.03, 'on a laptop the three bookcases are drawn at one scale: ' + d.list.map(x => x.scale.toFixed(2)).join(', '));
  assert.ok(Math.abs(Math.max(...d.list.map(x => x.h)) - 0.72 * 800) < 4, 'the tallest is 72% of the window’s height: ' + d.list.map(x => Math.round(x.h)).join(', '));
  assert.ok(same(d.list, x => x.bottom) < 1.5 && d.list.every((x, i) => !i || x.left > d.list[i - 1].right), 'they stand in a row, feet level: ' + JSON.stringify(d.list.map(x => [Math.round(x.left), Math.round(x.bottom)])));
  assert.ok(d.wide <= 0 && d.list[2].name >= 9, 'the page doesn’t scroll sideways, and a set’s name is ' + d.list[2].name.toFixed(1) + ' px');
  await desk.p.setViewportSize({ width: 700, height: 800 });
  await until(async () => (await drawn(desk.p)).list[2].top > (await drawn(desk.p)).list[0].bottom, 3000, 'the row didn’t wrap when the window narrowed');
  d = await drawn(desk.p);
  assert.ok(same(d.list, x => x.scale) < 0.03 && d.wide <= 0 && d.list.every(x => x.left >= 0 && x.right <= 700), 'in a narrower window the row wraps, still at one scale: ' + JSON.stringify(d.list.map(x => [x.scale.toFixed(2), Math.round(x.left), Math.round(x.right)])));
  await desk.c.close();
  const phone = await withSets({ sets, cases });
  await phone.p.goto(base + '#shelves');
  await phone.p.waitForSelector('.case');
  d = await drawn(phone.p);
  assert.ok(d.list.every((x, i) => !i || x.top > d.list[i - 1].bottom) && d.list[1].scale > d.list[0].scale + 1 && d.list[0].scale > d.list[2].scale + 1 && d.wide <= 0,
    'on a phone each bookcase still has the width to itself, one under the other: ' + d.list.map(x => x.scale.toFixed(2)).join(', '));
  await phone.c.close();
}

// A bookcase wider than a Billy is squeezed into the same width on a phone, and its words and tap targets were
// squeezed with it: on a 180 cm bench names were under 5 px and sets 19 px to tap. They're sized for the width the
// drawing gets: at least 9 px and 43 px on a phone at 120, 147 and 180 cm, and no bigger than a Billy's on a laptop.
{
  const set = (id, name, w, d, h, more) => ({ id, t: 1, name, state: 'built', size: { w, d, h }, ...more });
  const sets = { or: set('or', 'Orchid', 30, 24, 31), fb: set('fb', 'Flower Bouquet', 26, 13, 31), lb: set('lb', 'London Bus', 34, 9, 18), ge: set('ge', 'Galaxy Explorer', 52, 25, 13), g9: set('g9', '', 9, 9, 5, { num: '20915-1' }) };
  const measure = p => p.evaluate(() => { const svg = document.querySelector('svg.shelf'), k = svg.getBoundingClientRect().width / svg.viewBox.baseVal.width, px = e => parseFloat(getComputedStyle(e).fontSize) * k;
    const inside = (a, b) => a.left >= b.left - 1 && a.right <= b.right + 1 && a.top >= b.top - 1 && a.bottom <= b.bottom + 1;
    return { names: [...svg.querySelectorAll('.sv-t')].map(px), tags: [...svg.querySelectorAll('.sv-h')].map(px), hits: [...svg.querySelectorAll('.sv-hit')].map(h => { const r = h.getBoundingClientRect(); return Math.min(r.width, r.height); }),
      said: svg.querySelectorAll('.sv-t').length, fits: [...svg.querySelectorAll('.sv-set')].every(g => !g.querySelector('.sv-t') || inside(g.querySelector('.sv-t').getBoundingClientRect(), g.querySelector('.sv-box').getBoundingClientRect())),
      tagFits: [...svg.querySelectorAll('g[role="img"]')].every(g => inside(g.querySelector('text').getBoundingClientRect(), g.querySelector('rect').getBoundingClientRect())) }; });
  for (const w of [120, 147, 180]) {
    const cases = { k: { id: 'k', t: 1, name: 'Wide one', w, d: 40, levels: [{ h: 35, sets: [{ id: 'or' }, { id: 'fb' }, { id: 'lb' }] }, { h: 35, sets: [{ id: 'ge' }, { id: 'g9' }] }] } };
    const phone = await withSets({ sets, cases });
    await phone.p.goto(base + '#shelves');
    await phone.p.waitForSelector('.sv-set');
    await phone.p.evaluate(() => document.fonts.ready);
    const m = await measure(phone.p);
    assert.deepEqual([m.names.every(x => x >= 9), m.tags.every(x => x >= 9), m.hits.every(x => x >= 43), m.said >= 4, m.fits, m.tagFits], [true, true, true, true, true, true],
      'at ' + w + ' cm on a phone: names of ' + m.names.map(x => x.toFixed(1)).join(', ') + ' px, labels of ' + m.tags[0].toFixed(1) + ' px, ' + Math.round(Math.min(...m.hits)) + ' px to tap');
    assert.equal(await phone.p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await phone.c.close();
    const desk = await withSets({ sets, cases }, { viewport: { width: 1280, height: 800 }, hasTouch: false });
    await desk.p.goto(base + '#shelves');
    await desk.p.waitForSelector('.sv-set');
    const d = await measure(desk.p);
    assert.deepEqual([d.names.every(x => x >= 9 && x <= 16), d.said >= 4], [true, true], 'at ' + w + ' cm on a laptop the names stay their usual size (' + d.names.map(x => x.toFixed(1)).join(', ') + ' px)');
    // Narrowed to a phone's width, the drawing's words are sized again.
    if (w === 180) {
      await desk.p.setViewportSize({ width: 390, height: 844 });
      await until(async () => (await measure(desk.p)).names.every(x => x >= 9), 3000, 'the words weren’t sized again when the window narrowed');
    }
    await desk.c.close();
  }
}

// What the planner says about its sets. With none it can place there's no count ("0 sets of 0 on shelves"), and the
// note that says which sets it places has the way to My sets. The count reads "3 of 5 sets on shelves", and "All 5
// sets are on shelves" once they are; from the first set placed, a line says a set in the drawing can be tapped. A
// set that fits nowhere gives its own size and the most there is: "Too deep for every bookcase (32 cm)" under a
// bookcase whose shelves are all labelled 32 cm read as the bookcase's size.
{
  const billy = { k: { id: 'k', t: 1, name: 'Billy', w: 76, d: 26, levels: [32, 32].map(h => ({ h, sets: [] })) } };
  const says = p => p.evaluate(() => [...document.querySelectorAll('#shelves-body > .sumline, #shelves-body > .note')].map(e => e.textContent));
  const none = await withSets({ sets: { a: { id: 'a', t: 1, name: 'Castle', state: 'sealed' } }, cases: billy });
  await none.p.goto(base + '#shelves');
  await none.p.waitForSelector('.case');
  assert.deepEqual(await says(none.p), ['The planner places sets marked Built or Partly built in My sets. You don’t have any yet. Add or mark them in My sets.'], 'no count with nothing to place');
  await none.p.click('#shelves-body .note a');
  await none.p.waitForSelector('#list-wrap .item');
  assert.equal(await none.p.evaluate(() => location.hash), '#catalog', 'and the note leads to My sets');
  await none.c.close();
  const set = (id, name, w, d, h) => ({ id, t: 1, name, state: 'built', size: { w, d, h } });
  const { c, p } = await withSets({ sets: { a: set('a', 'Bonsai Tree', 20, 15, 18), b: set('b', 'Typewriter', 27, 26, 11), g: set('g', 'Galaxy Explorer', 52, 32, 13), n: { id: 'n', t: 1, name: 'Orchid', state: 'built' } }, cases: billy });
  await p.goto(base + '#shelves');
  await p.waitForSelector('.case');
  assert.deepEqual(await says(p), ['0 of 4 sets on shelves', 'Brickyard needs each built set’s width, depth and height to fit it on a shelf. Measure them, or ask Claude: it knows the sizes LEGO gives for most sets. This one has no set number, so Claude can’t look its size up: measure it.',
    'Claude needs the Brickyard cataloger skill for this. Without it, what you copy says how to answer.'], 'nothing placed yet: the count, and no word about tapping');
  await p.click('[data-act="fill"]');
  assert.deepEqual((await says(p)).slice(0, 2), ['2 of 4 sets on shelves; the other 2 don’t fit or need a size', 'Tap a set to move it, turn it side-on or fix its size.']);
  assert.equal(await p.textContent('#shelves-body .list .item:has-text("Galaxy Explorer") .warn'), '32 cm deep; your bookcase is 26 cm deep');
  await p.evaluate(() => { const d = window.brickyard.doc(); for (const id of ['g', 'n']) window.brickyard.putSet(Object.assign({}, d.sets[id], { state: 'apart' })); window.brickyard.refresh(); });
  assert.deepEqual(await says(p), ['All 2 sets are on shelves', 'Tap a set to move it, turn it side-on or fix its size.']);
  await c.close();
}

// Every size box says what it is, above the box, where it stays once the box holds a number: a bookcase opened on
// a bare "76" and "26", and a set's size was a bare "50 8 16" (the words were only placeholders).
{
  const { c, p } = await withSets({ sets: { a: { id: 'a', t: 1, name: 'Typewriter', state: 'built', size: { w: 50, d: 8, h: 16 } } } });
  const labels = ids => p.evaluate(ids => ids.map(id => { const l = document.getElementById(id).labels[0], r = l && l.firstElementChild.getBoundingClientRect(); return l && r.width > 0 && r.height > 0 ? l.firstElementChild.textContent : ''; }), ids);
  await p.goto(base + '#catalog');
  await p.click('.item:has-text("Typewriter")');
  assert.deepEqual([await labels(['e-w', 'e-d', 'e-h']), await p.inputValue('#e-w')], [['Width, cm', 'Depth, cm', 'Height, cm'], '50'], 'a set’s size boxes are labelled');
  await p.click('[data-close]');
  await p.goto(base + '#shelves');
  await p.click('[data-act="add-case"]');
  assert.deepEqual([await labels(['k-w', 'k-d']), await p.inputValue('#k-w'), await p.inputValue('#k-d')], [['Width inside, cm', 'Depth inside, cm'], '76', '26'], 'a bookcase’s size boxes are labelled');
  await c.close();
}

// See in My sets, in the shelf planner, shows that set: its sheet open and its row in view behind it, down a long
// list. A search or a filter left on from before that would hide the set is taken off (it used to land at the top of
// My sets with the old search still in the box, and the set nowhere on the screen); one that shows it is left alone.
{
  const many = { tw: { id: 'tw', t: 1, name: 'Typewriter', room: 'Office', state: 'apart' }, bt: { id: 'bt', t: 1, name: 'Bonsai Tree', room: 'Study', state: 'built', size: { w: 20, d: 15, h: 18 } } };
  for (let i = 0; i < 30; i++) many['s' + i] = { id: 's' + i, t: 1, name: 'Set ' + String(i).padStart(2, '0'), room: 'Office', state: 'built' };
  const { c, p } = await withSets({ sets: many, cases: { b: { id: 'b', t: 1, name: 'Billy', w: 76, d: 26, levels: [{ h: 32, sets: [{ id: 'bt' }] }] } } });
  const seen = () => p.evaluate(() => {
    const row = [...document.querySelectorAll('#list-wrap .item')].find(r => r.dataset.id === 'bt'), r = row && row.getBoundingClientRect();
    return [location.hash, (document.getElementById('sheetTitle') || {}).textContent || '', document.getElementById('q').value,
      document.querySelector('.chip[aria-pressed="true"]').dataset.f, !!r && r.top >= 60 && r.bottom <= innerHeight, Math.round(scrollY) > 500];
  });
  const see = async () => { await p.goto(base + '#shelves'); await p.click('.sv-set'); await p.click('#z-cat'); await p.waitForSelector('#e-save'); };
  await p.goto(base + '#catalog');
  await p.fill('#q', 'typewriter');
  await p.click('.chip[data-f="apart"]');
  await see();
  assert.deepEqual(await seen(), ['#catalog', 'Bonsai Tree', '', 'all', true, true], 'the set’s sheet is open, its row behind it, the old search and filter gone');
  await p.click('[data-close]');
  assert.equal(await p.evaluate(() => document.activeElement.dataset.id), 'bt', 'and closing the sheet leaves you on its row');
  await p.fill('#q', 'bonsai');
  await p.click('.chip[data-f="built"]');
  await see();
  assert.deepEqual((await seen()).slice(0, 4), ['#catalog', 'Bonsai Tree', 'bonsai', 'built'], 'a search and a filter that show the set stay');
  await c.close();
}

// The dark look. A model's tile of colour swatches is as dark as the tiles round it (a set's picture keeps its light
// ground, and the swatches had it too: a cream block in the list). The chosen State button is lighter than its track
// (it was darker, and told apart only by its words). A sheet has a line along its top to tell it from the page. The
// light look keeps its white picture tile, its card-coloured button and no line.
{
  const sets = { b: { id: 'b', t: 1, num: '10698-1', name: 'Large Creative Brick Box', state: 'apart' } };
  const seen = p => p.evaluate(() => {
    const rgb = c => (/^rgba?\(([^)]*)\)/.exec(c) || ['', '0,0,0,0'])[1].split(/[\s,/]+/).map(Number);
    const lum = c => [0.2126, 0.7152, 0.0722].reduce((n, k, i) => { const v = rgb(c)[i] / 255; return n + k * (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4); }, 0);
    const bg = sel => getComputedStyle(document.querySelector(sel)).backgroundColor, sheet = getComputedStyle(document.querySelector('.sheet'));
    const on = lum(bg('.seg button[aria-pressed="true"]')), track = lum(bg('.seg'));
    return { on: +((Math.max(on, track) + 0.05) / (Math.min(on, track) + 0.05)).toFixed(2), lighter: on > track, edge: sheet.borderTopWidth + ' ' + (rgb(sheet.borderTopColor)[3] === 0 ? 'clear' : 'drawn') };
  });
  for (const colorScheme of ['dark', 'light']) {
    const { c, p } = await withSets({ sets }, { colorScheme });
    await p.goto(base + '#build');
    await p.waitForSelector('a[href="#model-x-cottage"] .pic.swatches');
    const tiles = await p.evaluate(() => {
      document.querySelector('#build-list .how').insertAdjacentHTML('beforeend', '<div class="pic in" id="shot"><img alt=""></div>');
      const bg = sel => getComputedStyle(document.querySelector(sel)).backgroundColor, probe = document.body.appendChild(document.createElement('i'));
      probe.style.background = 'var(--soft)';
      return [bg('.pic.swatches') === getComputedStyle(probe).backgroundColor, bg('#shot')];
    });
    assert.deepEqual(tiles, [true, colorScheme === 'dark' ? 'rgb(244, 241, 234)' : 'rgb(255, 255, 255)'], colorScheme + ': the swatch tile is the soft colour, the tile of a picture that has loaded light');
    await p.goto(base + '#catalog');
    await p.click('.item');
    const s = await seen(p);
    if (colorScheme === 'dark') assert.deepEqual([s.lighter, s.on >= 1.5, s.edge], [true, true, '1px drawn'], 'dark: the chosen State button stands out from its track (' + s.on + ':1) and the sheet has a top edge');
    else assert.deepEqual([s.lighter, s.edge], [true, '1px clear'], 'light: as it was');
    await c.close();
  }
}

// Everything tapped is at least 44 px each way on a phone (the least Apple's Human Interface Guidelines give for a
// touch target): Back and the menu button, the filter chips, Group by, the small buttons in a sheet's header, the
// State buttons, a tick-box's row, the step slider, the links at the foot. Group by is in 16 px type like every
// other box (in 14 px, iOS zoomed the page when it opened). A button's words stay on one line: "It's right" beside
// a Check note, and the two buttons at the bottom of My sets on a 320 px phone.
{
  const sets = { a: { id: 'a', t: 1, num: '42115-1', name: 'Lamborghini Sián FKP 37', state: 'built', check: 'box corner was blurry; could be 42083' }, b: { id: 'b', t: 1, name: 'Castle', state: 'sealed', missing: 'a flag' } };
  const small = (p, sel) => p.evaluate(sel => [...document.querySelectorAll(sel)].filter(e => e.getClientRects().length).map(e => { const r = e.getBoundingClientRect(); return [(e.textContent || e.getAttribute('aria-label') || e.id).trim().slice(0, 20), Math.round(r.width), Math.round(r.height)]; })
    .filter(x => x[1] < 44 || x[2] < 44), sel);
  const { c, p } = await withSets({ sets });
  await p.goto(base + '#catalog');
  await p.evaluate(() => { const s = document.querySelector('#catalog .sync-btn'); s.hidden = false; s.querySelector('span').textContent = 'Synced'; });
  assert.deepEqual(await small(p, '#catalog .back, #catalog .icon-btn, #catalog .sync-btn, .chip, #group, #fold-all, #list-wrap .fold, #catalog .btn, .jd-foot a'), [], 'My sets: nothing to tap is under 44 px');
  await p.evaluate(() => { const d = window.brickyard.doc(); d.sets.b.box = '3'; window.brickyard.takeDoc(d); });
  await p.selectOption('#group', 'box');
  assert.deepEqual([await p.locator('#list-wrap .fold.mark').count(), await small(p, '#list-wrap .fold, #list-wrap .box-head'), await p.$eval('#list-wrap .fold.mark', b => b.getBoundingClientRect().left >= 0)], [1, [], true], 'by moving box, the arrow that folds a box and the heading that opens it are each 44 px');
  await p.selectOption('#group', 'room');
  assert.ok(await p.evaluate(() => parseFloat(getComputedStyle(document.getElementById('group')).fontSize)) >= 16, 'Group by is in 16 px type');
  await p.click('.item:has-text("Lamborghini")');
  assert.deepEqual(await small(p, '.sheet .btn, .sheet .seg button, .sheet .check, .sheet input:not([type="checkbox"]), .sheet select'), [], 'a set’s sheet: nothing to tap is under 44 px');
  assert.ok(await p.evaluate(() => document.getElementById('e-ok').getBoundingClientRect().height) < 50, '“It’s right” is on one line');
  await p.click('[data-close]');
  await p.goto(base + '#model-x-cottage');
  await p.waitForSelector('#model-view:not([hidden])');
  assert.deepEqual(await small(p, '#build .back, #build .icon-btn, #build .btn, #step-range'), [], 'a model: nothing to tap is under 44 px');
  await p.setViewportSize({ width: 320, height: 640 });
  await p.goto(base + '#catalog');
  assert.deepEqual(await p.evaluate(() => [...document.querySelectorAll('#catalog .fab-row .btn')].map(b => { const r = b.getBoundingClientRect(); return r.height < 50 && r.left >= 0 && r.right <= innerWidth; }).concat(document.documentElement.scrollWidth <= innerWidth)),
    [true, true, true], 'at 320 px the two bottom buttons are one line each, on the screen');
  await c.close();
}

// On an iPhone a sheet stays inside what's visible: its height follows the browser's toolbar (dvh; plain vh is the
// screen with the toolbar away, which pushed the title and Close off the top), and a sheet with no buttons along the
// bottom ends clear of the home bar, as one with buttons does. Chromium has no toolbar to show, so the first half is
// read from the style sheet.
{
  const { c, p } = await withSets({ sets: { a: { id: 'a', t: 1, name: 'Bonsai Tree', state: 'built' } } });
  const cdp = await c.newCDPSession(p);
  await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { bottom: 34 } });
  await p.goto(base + '#catalog');
  const heights = await p.evaluate(() => {
    const out = [], walk = rules => { for (const r of rules) { if (r.selectorText === '.sheet' && r.style.maxHeight) out.push(r.style.maxHeight); if (r.cssRules) walk(r.cssRules); } };
    walk(document.styleSheets[0].cssRules);
    return out;
  });
  assert.deepEqual(heights, ['92dvh', '86dvh'], 'a sheet’s height follows the visible screen');
  const pad = sel => p.evaluate(s => parseFloat(getComputedStyle(document.querySelector(s)).paddingBottom), sel);
  await p.click('#menu-btn');
  assert.equal(await pad('.sheet .bd'), 48, 'the menu ends clear of the home bar');
  await p.click('[data-close]');
  await p.click('.item:has-text("Bonsai Tree")');
  assert.deepEqual([await pad('.sheet .bd'), await pad('.sheet .ft')], [14, 46], 'a sheet with buttons keeps them clear instead');
  await c.close();
}

// At 200% zoom a phone lays the page out about 195 px wide. Set names stay whole there: the row's picture is smaller
// and its badge goes under the words (the name was squeezed to a 13 px column, "L. K.", or to nothing), and nothing
// scrolls sideways, in My sets or on a model. At 390 px a row is laid out as it always was.
{
  const sets = { l: { id: 'l', t: 1, num: '10305-1', name: 'Lion Knights’ Castle', pieces: 4514, year: 2022, state: 'built', room: 'Hall' },
    b: { id: 'b', t: 1, num: '10698-1', name: 'Large Creative Brick Box', pieces: 790, state: 'apart', box: '7' }, m: { id: 'm', t: 1, num: '31120-1', name: 'Medieval Castle', state: 'sealed' },
    t: { id: 't', t: 1, num: '21327-1', name: 'Typewriter', state: 'partial' }, o: { id: 'o', t: 1, name: 'Orchid' } };
  const { c, p } = await withSets({ sets }, { viewport: { width: 195, height: 422 } });
  await p.goto(base + '#catalog');
  const rows = () => p.$$eval('#list-wrap .item', els => els.map(e => { const t = e.querySelector('.t'), r = t.getBoundingClientRect(), b = e.querySelector('.badge'); return [t.textContent, Math.round(r.width), t.scrollHeight <= t.clientHeight + 1, b ? b.getBoundingClientRect().top >= r.bottom : true]; }));
  const sideways = () => p.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  for (const [name, width, whole, under] of await rows()) assert.ok(width >= 85 && whole && under, name + ' at 195 px: its name is ' + width + ' px wide' + (whole ? '' : ', cut short') + (under ? '' : ', beside its badge'));
  assert.equal(await sideways(), 0, 'My sets doesn’t scroll sideways at 195 px');
  await p.goto(base + '#model-x-cottage');
  await p.waitForSelector('#model-view:not([hidden])');
  assert.equal(await sideways(), 0, 'nor does a model');
  await p.setViewportSize({ width: 390, height: 844 });
  await p.goto(base + '#catalog');
  assert.deepEqual(await p.$eval('#list-wrap .item', e => [getComputedStyle(e).gridTemplateColumns.split(' ').length, Math.round(e.querySelector('.pic').getBoundingClientRect().width)]), [3, 64], 'a row at 390 px is as it was');
  await c.close();
}

// My sets on paper: the list under a line saying what it is, without the search, the chips, Group by or the buttons.
// One moving box's sets (a search for the box, then print) come out on one page: the page was as tall as the screen
// at least, which added a blank sheet.
{
  const sets = {};
  for (let i = 0; i < 12; i++) sets['s' + i] = { id: 's' + i, t: 1, name: 'Set ' + String(i).padStart(2, '0'), state: 'built', box: String(1 + i % 3), room: 'Hall' };
  const { c, p } = await withSets({ sets }, { viewport: { width: 1280, height: 800 }, hasTouch: false, deviceScaleFactor: 1 });
  await p.goto(base + '#catalog');
  await p.selectOption('#group', 'box');
  await p.fill('#q', 'box 2');
  const pages = async () => ((await p.pdf({ format: 'Letter' })).toString('latin1').match(/\/Type\s*\/Page\b/g) || []).length;
  assert.equal(await pages(), 1, 'one box’s sets print on one page');
  await p.emulateMedia({ media: 'print' });
  const day = await p.evaluate(() => new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }));
  assert.deepEqual([await p.textContent('#print-head'), await p.isVisible('#print-head')], ['Brickyard · Box 2 · ' + day + ' · 4 sets', true], 'under a line that says which box, when, and how many');
  assert.deepEqual(await p.$$eval('#q, #chips, #group, #add-btn, #catalog .bar, .jd-foot', els => els.filter(e => e.getClientRects().length).map(e => e.id || e.className)), [], 'without the search, the chips, Group by, the buttons or the bars');
  assert.deepEqual(await p.evaluate(() => [getComputedStyle(document.querySelector('.group')).breakAfter, getComputedStyle(document.querySelector('.list li')).breakInside]), ['avoid', 'avoid'], 'a heading stays with its first set, and no set is cut in two');
  await p.emulateMedia({ media: 'screen' });
  assert.equal(await p.isVisible('#print-head'), false, 'the line is for paper only');
  await p.fill('#q', '');
  assert.equal(await p.textContent('#print-head'), 'Brickyard · My sets by moving box · ' + day + ' · 12 sets');
  await c.close();
}

// Build from your box when one of its files doesn't arrive.
{
  const cottage = (await readFile(join(root, 'models/cottage.json'), 'utf8')).trim();
  const link = '#d1j' + Buffer.from(cottage).toString('base64url');
  const LOST = 'Couldn’t load the builder’s files. Check your connection.';
  const fresh = async () => {
    const c = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, serviceWorkers: 'block' });
    const p = await c.newPage(), errors = [];
    p.on('pageerror', e => errors.push(e.message));
    return { c, p, errors };
  };
  {
    const { c, p, errors } = await fresh();
    let down = true, go;
    const wait = new Promise(r => { go = r; });
    await c.route('**/parts/shapes.json', async r => { await wait; return down ? r.abort() : r.continue(); });
    await p.goto(base + '#build');
    assert.equal(await p.textContent('#build-list'), 'Loading…', 'while its files are on their way, the builder says so');
    go();
    await p.waitForSelector('#build-retry');
    assert.equal(await p.textContent('#build-list p'), LOST, 'Build from your box says its files didn’t load');
    await p.click('#build-retry');
    await p.waitForFunction(() => document.querySelector('#build-retry') && !document.querySelector('#build-retry').dataset.busy);
    assert.equal(await p.evaluate(() => document.activeElement.id), 'build-retry', 'still no connection: it says so again, and the keyboard stays on Try again');
    // Leaving and coming back asks again too.
    await p.click('#build-back');
    await p.click('#go-build');
    await p.waitForSelector('#build-retry');
    down = false;
    await p.click('#build-retry');
    await p.waitForSelector('#build-list .group');
    assert.match(await p.textContent('#build-list'), /Cottage/, 'with the connection back, Try again shows the list');
    assert.deepEqual(errors, [], 'and nothing went wrong in the page');
    await c.close();
  }
  // A model link from Claude opened cold: its address is kept, so Try again opens the model.
  for (const file of ['parts/shapes.json', 'models/cottage.json', 'js/vendor/three.core.js']) {
    const { c, p, errors } = await fresh();
    let down = true;
    await c.route('**/' + file, r => (down ? r.abort() : r.continue()));
    const to = file.startsWith('models/') ? '#model-x-cottage' : link;
    await p.goto(base + to);
    await p.waitForSelector('#build-retry');
    assert.deepEqual([await p.textContent('#build-list p'), await p.evaluate(() => location.hash), await p.isHidden('#model-view')], [LOST, to, true], 'a model that couldn’t open says so and keeps its address: ' + file);
    down = false;
    await p.click('#build-retry'); // a script that didn't load is asked for again by loading the page again
    await p.waitForSelector('#model-view:not([hidden])');
    assert.equal(await p.textContent('#build-title'), 'Cottage', 'Try again opens the model: ' + file);
    assert.deepEqual(errors, [], 'and nothing went wrong in the page: ' + file);
    await c.close();
  }
}

// The home screen's Build from your box card says the number that screen says beside Your pieces, whatever is
// ticked there. (It counted loose pieces only: "86 loose pieces" where the builder said 876, and with the brick box
// alone, "Try the example cottage".)
{
  const sets = { box: { id: 'box', t: 1, num: '10698-1', name: 'Large Creative Brick Box', pieces: 790, state: 'apart' }, tree: { id: 'tree', t: 1, num: '21318-1', name: 'Tree House', pieces: 3036, state: 'apart' } };
  const { c, p } = await withSets({ sets, loose: { tub: { id: 'tub', t: 1, name: 'Tub', parts: [['3001', 4, 50], ['3003', 1, 36]] } } });
  const card = async () => {
    await p.goto(base);
    await p.waitForFunction(() => document.getElementById('home-build-stat').textContent.trim());
    return p.textContent('#home-build-stat');
  };
  const beside = async () => {
    await p.click('#go-build');
    await p.waitForSelector('#build-list .pieces .group');
    return p.textContent('#build-list .pieces .group span:last-child');
  };
  assert.deepEqual([await card(), await beside()], ['876 pieces to build from', '876'], 'the card and Your pieces say the same number');
  await p.uncheck('[data-pool="tub"]');
  await p.waitForFunction(() => document.querySelector('#build-list .pieces .group span:last-child').textContent === '790');
  assert.deepEqual([await card(), await beside()], ['790 pieces to build from', '790'], 'and the same with a lot unticked');
  await p.evaluate(m => localStorage.setItem('brickyard.models', JSON.stringify({ m1: { model: m, added: 1 } })), { name: 'Wall', parts: [['3001', 4, 0, 0, 0, 0, 1]] });
  assert.equal(await card(), '790 pieces to build from · 1 model from Claude', 'the models from Claude follow the pieces');
  await beside();
  await p.uncheck('[data-pool="box"]');
  await p.waitForFunction(() => document.querySelector('#build-list .pieces .group span:last-child').textContent === '');
  assert.equal(await card(), '1 model from Claude', 'with nothing ticked, the models alone');
  await p.evaluate(() => localStorage.removeItem('brickyard.models'));
  assert.equal(await card(), 'Try the example cottage', 'and with neither, the example');
  await c.close();
}

// A set's picture on its way is the plain brick on the soft ground, in the list and at the top of the set's sheet;
// once it has loaded it fades in over white and the brick goes (the picture is multiplied onto its tile, so a brick
// left there would show through). A picture that fails late, with the sheet open, leaves the tile where it is with
// the brick in it: it used to go, and every box in the sheet moved up 184 px under the finger. The next time, the
// sheet opens without the tile.
{
  const { c, p } = await withSets({ sets: { t: { id: 't', t: 1, num: '21318-1', name: 'Tree House' } } });
  let small, large;
  const waits = [new Promise(r => { small = r; }), new Promise(r => { large = r; })];
  await c.route('https://cdn.rebrickable.com/**', async r => {
    const big = /1000x800p/.test(r.request().url());
    await waits[big ? 1 : 0];
    return big ? r.fulfill({ status: 404 }) : r.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="250" height="250"><rect width="250" height="250" fill="#2f8a4e"/></svg>' });
  });
  const tile = sel => p.$eval(sel, el => {
    const probe = document.body.appendChild(document.createElement('i')); probe.style.background = 'var(--soft)';
    const soft = getComputedStyle(probe).backgroundColor; probe.remove();
    const img = el.querySelector('img'), brick = el.querySelector('svg');
    return { ground: getComputedStyle(el).backgroundColor === soft ? 'soft' : getComputedStyle(el).backgroundColor, picture: img ? getComputedStyle(img).opacity : 'none', brick: brick ? getComputedStyle(brick).opacity : 'none', tall: el.offsetHeight };
  });
  await p.goto(base + '#catalog');
  await p.waitForSelector('.item .pic img');
  assert.deepEqual(await tile('.item .pic'), { ground: 'soft', picture: '0', brick: '1', tall: 52 }, 'a picture on its way is the brick on the soft ground');
  small();
  await p.waitForFunction(() => getComputedStyle(document.querySelector('.item .pic img')).opacity === '1');
  await p.waitForFunction(() => getComputedStyle(document.querySelector('.item .pic svg')).opacity === '0');
  assert.deepEqual(await tile('.item .pic'), { ground: 'rgb(255, 255, 255)', picture: '1', brick: '0', tall: 52 }, 'once loaded it shows on white, and the brick is gone');
  // Drawn again (a letter typed in the search), a picture that has arrived is there at once: no brick, no fade.
  await p.fill('#q', 'tree');
  assert.deepEqual(await tile('.item .pic'), { ground: 'rgb(255, 255, 255)', picture: '1', brick: 'none', tall: 52 }, 'the list drawn again shows it straight away');
  await p.fill('#q', '');

  await p.click('.item:has-text("Tree House")');
  await p.waitForSelector('.sheet .head-pic img');
  await p.waitForTimeout(350); // the sheet has slid up
  const top = () => p.$eval('#e-num', e => Math.round(e.getBoundingClientRect().top));
  const before = await top();
  assert.deepEqual(await tile('.sheet .head-pic'), { ground: 'soft', picture: '0', brick: '1', tall: 170 }, 'the sheet’s picture on its way');
  large(); // the big picture fails, a while after the sheet opened
  await p.waitForFunction(() => !document.querySelector('.sheet .head-pic img'));
  assert.deepEqual([await top(), await tile('.sheet .head-pic')], [before, { ground: 'soft', picture: 'none', brick: '1', tall: 170 }], 'a picture that fails late leaves the sheet where it was, with the brick in its tile');
  await p.click('[data-close]');
  await p.click('.item:has-text("Tree House")');
  await p.waitForSelector('#e-num');
  await p.waitForTimeout(350);
  assert.deepEqual([await p.isVisible('.sheet .head-pic'), await top() < before - 150], [false, true], 'opened again, the sheet starts without the tile');
  // Not for the rest of the visit: a row's picture can fail on a weak signal and come the next time the list is
  // drawn. Once a picture of the set has arrived, its sheet asks for the big one again.
  await p.click('[data-close]');
  await p.waitForFunction(() => !document.querySelector('.scrim'));
  await p.evaluate(() => { window.tileLoads = 0; document.addEventListener('load', e => { if (e.target.tagName === 'IMG') window.tileLoads++; }, true); });
  await p.fill('#q', 'tree'); // the list is drawn again, and its picture loads
  await p.waitForFunction(() => window.tileLoads > 0);
  await p.click('.item:has-text("Tree House")');
  await p.waitForSelector('#e-num');
  assert.equal(await p.isVisible('.sheet .head-pic'), true, 'after a picture of the set has arrived, the sheet has its tile again');
  await c.close();
}
// With less motion asked for, nothing fades.
{
  const { c, p } = await withSets({ sets: { t: { id: 't', t: 1, num: '21318-1', name: 'Tree House' } } }, { reducedMotion: 'reduce' });
  await p.goto(base + '#catalog');
  await p.waitForSelector('.item .pic');
  assert.deepEqual(await p.$eval('.item .pic', el => [getComputedStyle(el).transitionDuration, getComputedStyle(el.querySelector('svg')).transitionDuration]), ['0s', '0s'], 'no fade under prefers-reduced-motion');
  await c.close();
}

// On a phone the pieces to find are in view under the picture: the picture is half the screen that's showing, and the
// list is in two columns. At 390 x 664 (an iPhone with Safari's bars up) the picture was 385 px tall and the list one
// column: two of the three kinds in the cottage's second step were on the screen, and four of the last step's six
// at the full 844.
{
  const { c, p } = await withSets({ sets: {} }, { viewport: { width: 390, height: 664 } });
  await p.goto(base + '#model-x-cottage');
  await p.waitForSelector('#model-view:not([hidden])');
  await p.click('#step-next'); // Start building
  await p.waitForSelector('#step-parts .need li');
  const seen = () => p.evaluate(() => {
    const kinds = [...document.querySelectorAll('#step-parts .need li')];
    return { picture: Math.round(document.querySelector('.stage').getBoundingClientRect().height), columns: getComputedStyle(document.querySelector('#step-parts .need')).gridTemplateColumns.split(' ').length,
      whole: kinds.filter(l => l.getBoundingClientRect().bottom <= innerHeight).length + ' of ' + kinds.length, sideways: document.documentElement.scrollWidth > innerWidth };
  });
  await p.click('#step-next');
  await p.waitForFunction(() => document.getElementById('step-n').textContent === 'Step 2');
  assert.deepEqual(await seen(), { picture: 332, columns: 2, whole: '3 of 3', sideways: false }, 'step 2 of the cottage at 390 x 664: every kind of piece is on the screen');
  await p.setViewportSize({ width: 390, height: 844 });
  await p.evaluate(() => { const r = document.getElementById('step-range'); r.value = String(+r.max - 1); r.dispatchEvent(new Event('input')); });
  await p.waitForFunction(() => document.getElementById('step-next').textContent === 'Finish');
  assert.deepEqual(await seen(), { picture: 422, columns: 2, whole: '6 of 6', sideways: false }, 'the last step at 390 x 844: all six kinds');
  // All the pieces, in the model's menu, stays one column; and a laptop keeps its wider columns.
  await p.click('#model-menu');
  await p.click('#mm-parts');
  assert.equal(await p.$eval('.sheet .need', el => getComputedStyle(el).gridTemplateColumns.split(' ').length), 1, 'All the pieces is one column');
  await p.click('[data-close]');
  await p.setViewportSize({ width: 1280, height: 800 });
  assert.deepEqual([(await seen()).columns, (await seen()).picture], [3, 400], 'on a laptop: three columns, under a picture half the window tall');
  await p.setViewportSize({ width: 290, height: 600 });
  assert.equal((await seen()).columns, 1, 'and one column on a very narrow screen');
  await c.close();
}

// A bookcase with a long name: the place Put these places in My sets writes keeps its shelf number. A set's Shelf or
// spot holds 60 characters, and "The tall white Billy between the window and the door, shelf 1" is 61: the next time
// Brickyard opened, the spot had lost its "1", the card said the set was somewhere else in My sets, and pressing the
// button again changed nothing. The name gives way now, in what's written and in what Remove looks for.
{
  const NAME = 'The tall white Billy between the window and the door, by Sam'; // 60 characters, the longest a bookcase's name can be
  assert.equal(NAME.length, 60);
  const set = (id, name) => ({ id, t: 1, name, state: 'built', size: { w: 12, d: 10, h: 10 } });
  const { c, p } = await withSets({ sets: { a: set('a', 'Bonsai Tree'), b: set('b', 'Typewriter') },
    cases: { k: { id: 'k', t: 2, name: NAME, w: 76, d: 26, levels: Array.from({ length: 10 }, (_, i) => ({ h: 20, sets: i === 0 ? [{ id: 'a' }] : i === 9 ? [{ id: 'b' }] : [] })) } } });
  const spots = () => p.evaluate(() => Object.values(window.brickyard.doc().sets).map(x => x.spot || ''));
  const card = () => p.textContent('#apply-n');
  await p.goto(base + '#shelves');
  await p.waitForSelector('.case');
  assert.equal(await card(), '2 sets are somewhere else in My sets.');
  await p.click('[data-act="apply"]');
  const wrote = ['The tall white Billy between the window and the doo, shelf 1', 'The tall white Billy between the window and the do, shelf 10'];
  assert.deepEqual([await spots(), wrote.map(w => w.length), await card()], [wrote, [60, 60], 'My sets matches these shelves.'], 'the spot written is the name cut to leave room for the shelf number');
  await p.reload();
  await p.waitForSelector('.case');
  assert.deepEqual([await spots(), await card()], [wrote, 'My sets matches these shelves.'], 'after Brickyard is opened again the spots still end in their shelf numbers, and the card still says My sets matches');
  assert.match(await p.textContent('.case-hd h2'), new RegExp('^' + NAME), 'the bookcase keeps its whole name');
  // Removing the bookcase takes those words out of My sets, as it does for a short name.
  await p.click('[data-case="k"]');
  await p.click('#k-del');
  await p.waitForTimeout(650);
  await p.click('#k-del');
  assert.deepEqual([await spots(), /2 sets no longer say /.test(await p.textContent('.toast'))], [['', ''], true], 'and removing the bookcase clears them');
  await c.close();
}

// A whole link from Claude with a dash or an underscore stuck to its end opens: markdown's _link_, or "link- open
// it". They're characters a link is made of, so they were taken as part of it, and about one time in three the
// browser then couldn't unpack it and Brickyard said the link was cut short when all of it had arrived. A link that
// really is cut still says so.
{
  const { c, p } = await withSets({ sets: {} });
  const links = Array.from({ length: 40 }, (_, i) => {
    const doc = { brickyard: 1, batch: { sets: Array.from({ length: 1 + i % 4 }, (_, k) => ({ num: String(21300 + i * 7 + k), name: 'Set ' + 'n'.repeat(i) + k, room: 'Office' })) } };
    return [base + '#b1z' + deflateRawSync(JSON.stringify(doc)).toString('base64url'), doc.batch.sets.length];
  });
  const got = await p.evaluate(async list => {
    const open = t => window.BrickCore.parseIncoming(t).then(r => r.batch.sets.length, e => e.why || 'refused');
    const out = { whole: 0, ended: 0, cut: 0 };
    for (const [link, n] of list) {
      if (await open(link) === n) out.whole++;
      if (await open('_' + link + '_') === n && await open(link + '- open it') === n && await open('**' + link + '__**') === n) out.ended++;
      if (await open(link.slice(0, link.length - 9) + '_') === 'cut' && await open(link.slice(0, 70) + '-') === 'cut') out.cut++;
    }
    return out;
  }, links);
  assert.deepEqual(got, { whole: 40, ended: 40, cut: 40 }, 'links with - or _ stuck to their ends open in the browser, and cut ones are still cut');
  // And opened from the address bar, as a tap on such a link would.
  await p.goto('about:blank');
  await p.goto(links[5][0] + '_');
  await p.waitForSelector('.rv li');
  assert.equal(await p.locator('.rv li').count(), links[5][1], 'a link with an underscore after it opens its review');
  await c.close();
}

// Fits a phone: nothing scrolls sideways.
for (const h of ['', '#catalog']) {
  await page.goto(base + h);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'the page scrolls sideways on a phone ' + h);
}

// Installable.
const cdp = await ctx.newCDPSession(page);
const inst = await cdp.send('Page.getInstallabilityErrors');
assert.deepEqual(inst.installabilityErrors, [], 'installable');

// Works offline once it has been opened: My sets, with the sets in it. The server goes down as well as the browser:
// in some Chromium builds the browser's offline switch alone doesn't stop the service worker's own requests, and
// this passed with no copy at all.
await page.waitForFunction(() => navigator.serviceWorker?.controller, null, { timeout: 10000 });
const rowsBefore = await page.locator('#list-wrap .item').count();
assert.ok(rowsBefore > 0, 'My sets has sets in it before going offline');
const opened = async how => {
  assert.equal(await page.title(), 'My sets · Brickyard', 'the page did not open ' + how);
  await page.waitForSelector('#list-wrap .item', { timeout: 5000 }).catch(() => {});
  assert.equal(await page.locator('#list-wrap .item').count(), rowsBefore, 'My sets did not show its sets ' + how);
};
net = 'down';
await ctx.setOffline(true);
await page.reload();
await opened('offline');
await ctx.setOffline(false);

// On a connection that's up but not answering, it opens from the copy too, after the worker's few seconds' wait for
// the network: the page and every file it loads (were any of them left waiting on the network, it wouldn't open).
net = 'stalled';
const t0 = Date.now();
await page.reload({ timeout: 10000 }).catch(() => {});
const took = Date.now() - t0;
assert.ok(took < 8000, `the page took ${took} ms to open on a stalled connection`);
await opened('on a stalled connection');
net = 'up';
for (const [req, res] of held.splice(0)) serve(req, res);

// A new release: every file in the new copy comes from the server, though the browser still has its own copies of
// the old ones for ten minutes. (The next release changes index.html, and so FILES in sw.js, as a real one does.)
release = true;
await page.evaluate(async () => (await navigator.serviceWorker.getRegistration()).update());
await until(() => page.evaluate(async () => !!(await (await caches.match('index.html'))?.text())?.includes('<!-- the next release -->')),
  10000, "the new release's offline copy kept the old index.html");
release = false;

assert.deepEqual(problems, [], 'problems while using it');
assert.ok(pictures.length > 1, 'set pictures were asked for along the way');
assert.deepEqual(told, [], 'and no request for one said which site was asking');
// "I've built this", in a model's menu. The example cottage and a second model both need the brick box's one green
// 6x12 plate, and both said "Can build". With the cottage marked built, its pieces are out of Your pieces for the
// other model (1 short: the plate), and out of what's copied for
// Claude, whose first line says so. The cottage's row says Built. Taking it apart gives the pieces back.
{
  const { c, p } = await withSets({ sets: { a: { id: 'a', t: 1, num: '10698-1', name: 'Large Creative Brick Box', pieces: 790, state: 'apart' } } }, { permissions: ['clipboard-read', 'clipboard-write'] });
  const says = async () => { await p.waitForFunction(() => document.querySelector('.toast') && !document.querySelector('.toast').hidden); return p.textContent('.toast span'); };
  const row = sel => p.$eval(sel, a => a.querySelector('.badge') ? a.querySelector('.badge').textContent : '');
  const field = { brickyard: 1, model: { name: 'Field', parts: [['3028', 10, 0, 0, 0, 0, 1], ['3001', 4, 0, 1, 0, 0, 2]] } };
  await p.goto(base + '#d1z' + deflateRawSync(JSON.stringify(field)).toString('base64url'));
  await p.waitForFunction(() => document.getElementById('build-title').textContent === 'Field');
  const id = await p.evaluate(() => location.hash.slice(7));
  assert.equal(await p.textContent('#model-check .note.ok'), '✓ You have every piece for this, from Large Creative Brick Box.');
  await p.goto(base + '#build');
  await p.waitForSelector('a[href="#model-x-cottage"]');
  assert.deepEqual([await row('a[href="#model-' + id + '"]'), await row('a[href="#model-x-cottage"]'), await p.locator('#built-note').count()], ['Can build', 'Can build', 0], 'with nothing built, both can be');
  await p.click('a[href="#model-x-cottage"]');
  await p.waitForFunction(() => document.getElementById('build-title').textContent === 'Cottage');
  await p.click('#model-menu');
  assert.deepEqual(await p.$$eval('.sheet .menu button', bs => bs.map(b => b.querySelector('span').firstChild.textContent)), ['All the pieces', 'I’ve built this'], 'the example’s menu has it too');
  assert.equal(await p.textContent('#mm-built small'), 'Its pieces stop counting for your other models and for Claude');
  await p.click('#mm-built');
  assert.equal(await says(), 'Cottage is built. Its pieces are left out for your other models and for Claude.');
  assert.equal(await p.locator('.sheet').count(), 0, 'and the menu closes');
  assert.equal(await p.textContent('#model-check .note.ok'), '✓ You’ve built this. Its pieces are left out for your other models and for Claude.', 'the built model says so');
  assert.deepEqual(await p.evaluate(() => JSON.parse(localStorage.getItem('brickyard.models'))['x-cottage']), { built: true }, 'kept in this browser');
  await p.goto(base + '#build');
  await p.waitForSelector('#built-note');
  assert.equal(await p.textContent('#built-note'), 'Cottage is built, so its 40 pieces are left out for your other models and for Claude.');
  assert.deepEqual([await row('a[href="#model-' + id + '"]'), await row('a[href="#model-x-cottage"]')], ['1 short', 'Built'], 'the other model is short of the plate the cottage stands on');
  assert.equal(await p.textContent('.pieces h2'), 'Your pieces790', 'Your pieces still counts what you own');
  assert.equal(await p.textContent('h2.group[aria-label^="Models"]'), 'Models2', 'the example’s entry isn’t a model of its own');
  await p.click('#copy-pool');
  await says();
  const copied = await p.evaluate(() => navigator.clipboard.readText());
  assert.match(copied, /^My Brickyard pieces, from 10698-1 Large Creative Brick Box, less the pieces in Cottage, which is built\.\nPieces the builder knows, as LDraw part\/colour ×count:\n/, 'what’s copied for Claude says the cottage is built');
  assert.doesNotMatch(copied, /\b3028\/10 ×/, 'and leaves its pieces out: the one green 6x12 plate');
  assert.match(copied, /\b3010\/226 ×1,/, 'and all but one of the box’s bright light yellow 1x4 bricks');
  await p.click('a[href="#model-' + id + '"]');
  await p.waitForFunction(() => document.getElementById('build-title').textContent === 'Field');
  assert.equal(await p.textContent('#model-check .flag'), 'You’re short: 1 × Bright Green plate 6x12. Cottage is built, so its pieces aren’t counted. Swap colours where it doesn’t matter, or ask Claude for another version.');
  // Both built: each keeps its own pieces, the first line names both, and a reload keeps it.
  await p.click('#model-menu'); await p.click('#mm-built');
  assert.equal(await says(), 'Field is built. Its pieces are left out for your other models and for Claude.');
  await p.reload();
  await p.waitForFunction(() => document.getElementById('build-title').textContent === 'Field');
  assert.equal(await p.textContent('#model-check .note.ok'), '✓ You’ve built this. Its pieces are left out for your other models and for Claude.');
  await p.goto(base + '#build');
  await p.waitForSelector('#built-note');
  assert.equal(await p.textContent('#built-note'), 'Cottage and Field are built, so their 42 pieces are left out for your other models and for Claude.');
  await p.click('#copy-pool');
  await says();
  assert.match(await p.evaluate(() => navigator.clipboard.readText()), /^My Brickyard pieces, from 10698-1 Large Creative Brick Box, less the pieces in Cottage and Field, which are built\.\n/);
  // The same model from Claude's link again is still built.
  await p.goto('about:blank');
  await p.goto(base + '#d1z' + deflateRawSync(JSON.stringify(field)).toString('base64url'));
  await p.waitForFunction(() => document.getElementById('build-title').textContent === 'Field');
  assert.equal(await p.evaluate(i => JSON.parse(localStorage.getItem('brickyard.models'))[i].built, id), true, 'the model sent again stays built');
  // Taken apart again.
  await p.click('#model-menu');
  assert.deepEqual([await p.$eval('#mm-built span', s => s.firstChild.textContent), await p.textContent('#mm-built small')], ['I’ve taken this apart', 'It’s marked as built. Its pieces count for your other models again']);
  await p.click('#mm-built');
  assert.equal(await says(), 'Field is taken apart. Its pieces count for your other models again.');
  assert.equal(await p.textContent('#model-check .flag'), 'You’re short: 1 × Bright Green plate 6x12. Cottage is built, so its pieces aren’t counted. Swap colours where it doesn’t matter, or ask Claude for another version.');
  await p.goto(base + '#model-x-cottage');
  await p.waitForFunction(() => document.getElementById('build-title').textContent === 'Cottage');
  await p.click('#model-menu'); await p.click('#mm-built');
  assert.equal(await says(), 'Cottage is taken apart. Its pieces count for your other models again.');
  assert.equal(await p.evaluate(() => 'x-cottage' in JSON.parse(localStorage.getItem('brickyard.models'))), false, 'and nothing is left of the example’s entry');
  await p.goto(base + '#build');
  await p.waitForSelector('a[href="#model-x-cottage"]');
  assert.deepEqual([await row('a[href="#model-' + id + '"]'), await row('a[href="#model-x-cottage"]'), await p.locator('#built-note').count()], ['Can build', 'Can build', 0], 'both can be built again');
  await c.close();
}

// The texts Brickyard copies for Claude work in a chat that hasn't the skills. Add from photos has a note to copy:
// it names Brickyard and its address, says where the format is, and ends "They are in: " to be finished. Each
// how-to says which skill Claude needs.
{
  const { c, p } = await withSets({ sets: {} }, { permissions: ['clipboard-read', 'clipboard-write'] });
  const says = async () => { await p.waitForFunction(() => document.querySelector('.toast') && !document.querySelector('.toast').hidden); return p.textContent('.toast span'); };
  await p.goto(base + '#catalog');
  await p.click('#menu-btn'); await p.click('#m-claude');
  await p.waitForSelector('#p-note');
  assert.equal(await p.textContent('.sheet .how li:nth-child(2)'), 'Send them to Claude with the note below, and finish it with where they are (a room and shelf, or a moving box number).');
  assert.equal(await p.textContent('.sheet .how .note'), 'Claude needs the Brickyard cataloger skill for this. Without it, the note says how to answer.');
  assert.ok((await p.locator('#p-note').boundingBox()).height >= 44, 'Copy a note for Claude is a finger tall');
  await p.click('#p-note');
  assert.equal(await says(), 'Copied. Paste it to Claude with the photos, and finish it with where they are.');
  const note = await p.evaluate(() => navigator.clipboard.readText());
  assert.match(note, /^Photos of my LEGO sets, to add to Brickyard \(https:\/\/brickyard\.junkdrawer\.works\/\)\. Please work out which sets they are and send them back as a Brickyard link I can open to add them\.\n/);
  assert.match(note, /\nIf you don’t have the Brickyard cataloger skill, the format is at https:\/\/brickyard\.junkdrawer\.works\/skill\/brickyard-cataloger\/references\/brickyard-format\.md: send the sets as that JSON, as text I can paste into Brickyard\.\nThey are in: $/, 'it ends ready to be finished');
  assert.equal(await p.locator('.sheet #paste').count(), 1, 'and the sheet stays open for the link');
  // Where the browser won't copy, the note is shown to copy by hand.
  await p.evaluate(() => { navigator.clipboard.writeText = () => Promise.reject(new Error('no')); });
  await p.click('#p-note');
  await p.waitForSelector('#p-note-text');
  assert.deepEqual(await p.$eval('#p-note-text', (t, n) => [t.value === n, t.selectionEnd - t.selectionStart === n.length, document.activeElement === t], note), [true, true, true], 'shown, selected');
  await c.close();
}
// Copy these for Claude, in the Shelf planner, names the sets that have a number: a size comes back by its set's
// number, so a set with none could never get one. The screen says how many are left to measure. The text says which
// way round width and depth go, and gives the plain form to answer in, which opens when it's pasted back.
{
  const sets = { a: { id: 'a', t: 1, num: '10497-1', name: 'Galaxy Explorer', state: 'built' }, b: { id: 'b', t: 1, name: 'Bonsai tree', state: 'built' }, d: { id: 'd', t: 1, num: '21327-1', name: 'Typewriter', state: 'built' } };
  const { c, p } = await withSets({ sets }, { permissions: ['clipboard-read', 'clipboard-write'] });
  const says = async () => { await p.waitForFunction(() => document.querySelector('.toast') && !document.querySelector('.toast').hidden); return p.textContent('.toast span'); };
  await p.goto(base + '#shelves');
  await p.waitForSelector('[data-act="ask-sizes"]');
  const notes = () => p.$$eval('#sv-nosize ~ p.note', ps => ps.map(x => x.textContent));
  assert.deepEqual(await notes(), ['Brickyard needs each built set’s width, depth and height to fit it on a shelf. Measure them, or ask Claude: it knows the sizes LEGO gives for most sets. 1 of these has no set number, so Claude can’t look its size up: measure that one.',
    'Claude needs the Brickyard cataloger skill for this. Without it, what you copy says how to answer.']);
  await p.click('[data-act="ask-sizes"]');
  assert.equal(await says(), 'Copied. Paste it to Claude. The one with no set number isn’t in it.');
  const text = await p.evaluate(() => navigator.clipboard.readText());
  assert.equal(text, 'Built sizes for my Brickyard sets, please (width × depth × height in cm, as built and displayed). Send them as a Brickyard sizes link.\n' +
    'Width is across the front as the set stands on display, depth is front to back, and height is to its top.\n' +
    'If you don’t have the Brickyard cataloger skill, answer in this form, as text I can paste into Brickyard (the numbers here are an example): {"brickyard": 1, "sizes": [{"num": "10497", "w": 52, "d": 32, "h": 13, "note": "where the size came from"}]}\n' +
    '10497 Galaxy Explorer\n21327 Typewriter\n');
  // The plain form, pasted back as a chat would send it, opens as sizes.
  await p.click('[data-act="open-sizes"]');
  await p.fill('#z-paste', 'Here you go:\n' + text.match(/\{"brickyard".*\}\]\}/)[0]);
  await p.click('#z-go');
  await p.waitForFunction(() => /Galaxy Explorer/.test((document.querySelector('.sheet') || {}).textContent || '') && /52/.test(document.querySelector('.sheet').textContent));
  await p.click('.sheet [data-close]');
  await c.close();
  // With no numbered set to ask about, there is nothing to copy.
  const bare = await withSets({ sets: { b: sets.b, e: { id: 'e', t: 1, name: 'Castle', state: 'built' } } });
  await bare.p.goto(base + '#shelves');
  await bare.p.waitForSelector('[data-act="ask-sizes"]');
  assert.deepEqual([await bare.p.isDisabled('[data-act="ask-sizes"]'), await bare.p.$eval('#sv-nosize ~ p.note', x => x.textContent.split('. ').pop())], [true, 'None of these has a set number, so Claude can’t look their sizes up: measure them.']);
  await bare.c.close();
}
// Copy my pieces for Claude ends with where a model's rules are, for a Claude without the designer skill, and the
// script still reads the pasted text as the pieces it lists.
{
  const { c, p } = await withSets({ sets: { a: { id: 'a', t: 1, num: '10698-1', name: 'Large Creative Brick Box', pieces: 790, state: 'apart' } } }, { permissions: ['clipboard-read', 'clipboard-write'] });
  await p.goto(base + '#build');
  await p.waitForSelector('#copy-pool');
  assert.equal(await p.textContent('#build-list .how .note'), 'Claude needs the Brickyard designer skill for this. Without it, what you copy says where the rules are.');
  await p.click('#copy-pool');
  await p.waitForFunction(() => document.querySelector('.toast') && !document.querySelector('.toast').hidden);
  const text = await p.evaluate(() => navigator.clipboard.readText());
  assert.match(text, /\n\(\d+ more kinds, such as wheels and hinges, that the builder doesn’t use yet\.\)\nHow a Brickyard model is written and checked, if you don’t have the Brickyard designer skill: https:\/\/brickyard\.junkdrawer\.works\/skill\/brickyard-designer\/SKILL\.md\n$/);
  const dir = await mkdtemp(join(tmpdir(), 'brickyard-pieces-'));
  const { writeFile } = await import('node:fs/promises');
  await writeFile(join(dir, 'pieces.txt'), text);
  const out = execSync(`python3 -B ${join(root, 'skill/brickyard-designer/scripts/check_model.py')} ${join(root, 'models/cottage.json')} --pieces ${join(dir, 'pieces.txt')} --out ${dir} --no-link`).toString();
  assert.match(out, /^Cottage: 40 pieces, 7 steps/, 'check_model.py reads what was copied');
  assert.doesNotMatch(out, /PROBLEM|NOT READY/);
  await c.close();
}

// Copy my taken-apart sets: the taken-apart sets Brickyard has no parts list for, as a request to paste into a Claude
// session opened on the Brickyard project (a parts list is a file there, which a chat can't add). A set is named
// once, one with no number is left out, and the button isn't there with nothing to ask for.
{
  const sets = { a: { id: 'a', t: 1, num: '21318-1', name: 'Tree House', state: 'apart' }, b: { id: 'b', t: 1, num: '21318-1', name: 'Tree House', state: 'apart' }, d: { id: 'd', t: 1, num: '10497-1', name: 'Galaxy Explorer', state: 'apart' },
    e: { id: 'e', t: 1, name: 'Bonsai tree', state: 'apart' }, f: { id: 'f', t: 1, num: '10698-1', name: 'Large Creative Brick Box', pieces: 790, state: 'apart' }, g: { id: 'g', t: 1, num: '21327-1', name: 'Typewriter', state: 'built' } };
  const { c, p } = await withSets({ sets }, { permissions: ['clipboard-read', 'clipboard-write'] });
  await p.goto(base + '#build');
  await p.waitForSelector('#copy-apart');
  assert.equal(await p.textContent('#apart-how'), 'A parts list is a small file in the Brickyard project. Copy these sets and paste them into a Claude session opened on the Brickyard project: it adds each list. 1 of them has no set number, and a parts list goes by the number: add it in My sets.');
  assert.ok((await p.locator('#copy-apart').boundingBox()).height >= 44, 'the button is a finger tall');
  await p.click('#copy-apart');
  await p.waitForFunction(() => document.querySelector('.toast') && !document.querySelector('.toast').hidden);
  assert.equal(await p.textContent('.toast span'), 'Copied. Paste it into a Claude session opened on the Brickyard project.');
  assert.equal(await p.evaluate(() => navigator.clipboard.readText()), 'Parts lists for Brickyard, please. These sets of mine are taken apart, and Brickyard has no parts list for them, so Build from your box can’t count their pieces.\n' +
    'For each one, add parts/sets/NUM-1.json and its count to parts/index.json, the way the project’s CLAUDE.md says a new set joins the pool.\n10497-1 Galaxy Explorer\n21318-1 Tree House\n');
  // Where the browser won't copy, the text is shown.
  await p.evaluate(() => { navigator.clipboard.writeText = () => Promise.reject(new Error('no')); });
  await p.click('#copy-apart');
  await p.waitForSelector('#pool-text');
  assert.deepEqual([await p.textContent('#sheetTitle'), await p.textContent('.sheet .note'), (await p.inputValue('#pool-text')).split('\n').length], ['Your taken-apart sets', 'Copy this and paste it into a Claude session opened on the Brickyard project.', 5]);
  await c.close();
  const one = await withSets({ sets: { a: sets.a, f: sets.f } });
  await one.p.goto(base + '#build');
  await one.p.waitForSelector('#copy-apart');
  assert.equal(await one.p.textContent('#apart-how'), 'A parts list is a small file in the Brickyard project. Copy this set and paste it into a Claude session opened on the Brickyard project: it adds the list.');
  await one.c.close();
  const bare = await withSets({ sets: { e: sets.e, f: sets.f } });
  await bare.p.goto(base + '#build');
  await bare.p.waitForSelector('#apart-how');
  assert.deepEqual([await bare.p.textContent('#apart-how'), await bare.p.locator('#copy-apart').count()], ['It has no set number, and a parts list goes by the number: add it in My sets.', 0]);
  await bare.c.close();
  const none = await withSets({ sets: { f: sets.f, g: sets.g } });
  await none.p.goto(base + '#build');
  await none.p.waitForSelector('#copy-pool');
  assert.deepEqual([await none.p.locator('#apart-how').count(), await none.p.locator('#copy-apart').count()], [0, 0], 'with a list for every taken-apart set, nothing to ask for');
  await none.c.close();
}

await browser.close();
server.close();

// sw.js changes whenever a file it keeps does, so a release replaces the whole offline copy at once: FILES in sw.js is
// a fingerprint of every file in SHELL (sha1 of each, in the list's order, an address like './' read as its
// index.html; the first 8 hex of the sha1 of those).
const sw = await readFile(join(root, 'sw.js'), 'utf8');
const shell = [...sw.match(/SHELL = \[([^\]]*)\]/)[1].replace(/\/\/.*/g, '').matchAll(/'([^']*)'/g)].map(m => m[1]);
const all = createHash('sha1');
for (const f of shell) all.update(createHash('sha1').update(await readFile(join(root, f.endsWith('/') ? f + 'index.html' : f))).digest());
const files = all.digest('hex').slice(0, 8);
assert.equal(sw.match(/const FILES = '([0-9a-f]*)'/)?.[1], files, `a file sw.js keeps for offline has changed: set FILES in sw.js to '${files}'`);

// And SHELL is the whole of what the page asks its own address for: a file left out of it is missing offline, and
// nothing said so. (A new set joins the builder by adding parts/sets/NUM-1.json and its count to parts/index.json;
// its parts list has to be kept for offline too.) Everything index.html names in a src or an href, every file
// js/build.js imports and the files those import, the builder's parts files, and the parts list of each set in
// parts/index.json.
const wanted = new Set(['parts/shapes.json', 'parts/colors.json', 'parts/index.json', 'parts/aliases.json']);
for (const m of (await readFile(join(root, 'index.html'), 'utf8')).matchAll(/\s(?:src|href)="([^"#]+)"/g)) if (!/^[a-z]+:/.test(m[1])) wanted.add(m[1]);
const follow = async file => {
  for (const m of (await readFile(join(root, file), 'utf8')).matchAll(/\b(?:from|import)\s*\(?\s*["'](\.{1,2}\/[^"']+)["']/g)) {
    const to = new URL(m[1], 'http://x/' + file).pathname.slice(1);
    if (!wanted.has(to)) { wanted.add(to); await follow(to); }
  }
};
await follow('js/build.js');
for (const num of Object.keys(JSON.parse(await readFile(join(root, 'parts/index.json'), 'utf8')))) wanted.add('parts/sets/' + num + '.json');
assert.ok(wanted.size >= 17 && wanted.has('js/vendor/three.core.js') && wanted.has('fonts/rubik.woff2') && wanted.has('parts/sets/10698-1.json'), 'the check found the files to look for: ' + [...wanted].join(', '));
assert.deepEqual([...wanted].filter(f => !shell.includes(f)), [], 'files the page asks for that sw.js doesn’t keep for offline: add them to SHELL in sw.js, and bump CACHE');
console.log('all good');
