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
assert.match(await page.textContent('#home-stat'), /Nothing here yet/);

// A link cut short (as a chat app can leave it) says so when Brickyard opens on it, with what to do, on the screen
// that kind of link belongs to; so does a link of a newer format than this copy of the page knows. Everything else
// still works.
const CUT = 'That Brickyard link is cut short or has a wrong character. Copy the whole link again, or open the file that came with it.';
const NEWER = 'That link needs a newer Brickyard. Reload the page, then open it again.';
{
  const p = await ctx.newPage();
  p.on('pageerror', e => problems.push(e.message));
  const packed = o => deflateRawSync(JSON.stringify(o)).toString('base64url');
  const whole = '#b1z' + packed({ brickyard: 1, batch: { sets: Array.from({ length: 12 }, (_, i) => ({ num: String(21300 + i), name: 'Set number ' + i, room: 'Office' })) } });
  const plain = '#b1j' + Buffer.from(JSON.stringify({ brickyard: 1, batch: { sets: [{ num: '10698', name: 'Large Creative Brick Box' }] } })).toString('base64url');
  const screen = () => p.evaluate(() => ['home', 'catalog', 'build', 'shelves'].filter(id => !document.getElementById(id).hidden).join());
  for (const [h, says, on] of [['#b1zAAAAA', CUT, 'catalog'], ['#l1zA', CUT, 'build'], ['#z1zA', CUT, 'shelves'], ['#d1zA', CUT, 'build'],
    [whole.slice(0, whole.length - 9), CUT, 'catalog'], [whole.slice(0, 60), CUT, 'catalog'], [plain.slice(0, 80), CUT, 'catalog'], ['#batch=%7B%22sets%22%3A%5B%7B%22num', CUT, 'catalog'],
    ['#b2z' + whole.slice(4), NEWER, 'home'], ['#q7j' + plain.slice(4), NEWER, 'home']]) {
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
  assert.deepEqual(Object.keys(JSON.parse(await p.evaluate(() => localStorage.getItem('brickyard.v1'))).catalog).sort(), ['cases', 'loose', 'seen', 'sets'], 'the catalog holds nothing new');
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
await page.fill('#q', 'box 4');
assert.match(await page.textContent('#list-wrap'), /Nothing matches/, 'box 4 has nothing in it');
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
  const heads = () => p.locator('#list-wrap .group').evaluateAll(hs => hs.map(h => [h.children[0].textContent.toLowerCase(), +h.children[1].textContent]));
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
  const heads = () => p.locator('#list-wrap .group').evaluateAll(hs => hs.map(h => [h.children[0].textContent, +h.children[1].textContent]));
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
  const heads = () => p.locator('#list-wrap .group').evaluateAll(hs => hs.map(h => h.children[0].textContent + ' ' + h.children[1].textContent));
  assert.deepEqual(await heads(), ['Box 3 1', 'Box 14 1', 'Box 20 ', 'Not packed 1'], 'a box of only loose pieces has a group in its place');
  assert.deepEqual(await lines(), ['Also in box 14: Blue tub, 42 loose pieces', 'In box 20: Red bag, 10 loose pieces'], 'each box’s loose pieces under its group');
  assert.equal(await p.locator('.group:has-text("Box 14") + .list + .note.lots').count(), 1, 'the line is under its box’s sets');
  await p.fill('#q', 'box 14');
  assert.deepEqual(await p.locator('#list-wrap .item .t').allTextContents(), ['Typewriter']);
  assert.deepEqual(await lines(), ['Also in box 14: Blue tub, 42 loose pieces'], 'a search for the box shows its loose pieces');
  await p.fill('#q', 'box 20');
  assert.deepEqual([await p.locator('#list-wrap .item').count(), await lines()], [0, ['In box 20: Red bag, 10 loose pieces']], 'a box of only loose pieces is found, not "Nothing matches"');
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
// as they do grouped by box: no "Also in box 14" under no sets, and nothing listed when none of them are in it.
{
  const { c, p } = await withSets({
    sets: { t: { id: 't', t: 1, name: 'Typewriter', box: '14', state: 'partial' }, g: { id: 'g', t: 1, name: 'Galaxy Explorer', box: '3', state: 'built' } },
    loose: { tub: { id: 'tub', t: 1, name: 'Blue tub', box: 'Box 14', parts: [['3001', 4, 40]] }, bag: { id: 'bag', t: 1, name: 'Red bag', box: '20', parts: [['3001', 4, 10]] } } });
  await p.goto(base + '#catalog');
  const lines = () => p.locator('#list-wrap .note.lots').allTextContents();
  await p.fill('#q', 'box 14');
  assert.deepEqual(await lines(), ['Also in box 14: Blue tub, 40 loose pieces'], 'with All, a box’s loose pieces show');
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
  assert.deepEqual([await sheets(), (await kept('r')).box, await p.textContent('.toast')], [0, '7', 'Saved'], 'Enter in Moving box saves and closes');
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
  assert.deepEqual([await sheets(), await p.evaluate(() => window.brickyard.doc().cases.k.levels.map(l => l.h))], [0, [33]], 'and is left as it was once discarded');
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
  assert.deepEqual((await kept('cases')).k.levels, [{ h: 40, sets: [{ id: 't' }] }, { h: 32, sets: [] }]);
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
  await p.click('#rv-add');
  assert.deepEqual([await toastSays(), await names()], [['Added 3 sets', 'Undo'], ['Bonsai Tree', 'Galaxy Explorer in 12', 'Kingfisher Bird in 12', 'Orchid', 'Retro Radio in 12']]);
  await p.click('.toast button');
  assert.deepEqual([await toastSays(), await names(), await p.locator('.item .t').allTextContents(), await p.evaluate(() => window.brickyard.doc().seen)],
    [['Took those 3 sets out again', ''], ['Bonsai Tree', 'Orchid'], ['Bonsai Tree', 'Orchid'], {}], 'Undo leaves My sets as it was');
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
  assert.equal(await p.textContent('.item[data-id="b"] .warn'), 'To check', 'the row says To check, as the chip does');
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
  await p.fill('#model-paste', base + '#d2z' + packed({ brickyard: 2, model: wall }));
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
// and can carry a button. One left showing goes when a sheet opens, unless it's a held warning.
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
  await p.evaluate(() => window.brickyard.toast('Added 7 sets'));
  assert.equal(await p.locator('.toast button').count(), 0, 'the next message has no button left in it');
  await p.click('#menu-btn');
  assert.equal(await p.locator('.toast').isHidden(), true, 'a message left showing goes when a sheet opens');
  await p.click('[data-close]');
  await p.evaluate(() => window.brickyard.toast('This browser wouldn’t save.', true));
  await p.click('#menu-btn');
  assert.equal(await p.locator('.toast').isVisible(), true, 'a held warning stays');
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
  // A set number that's refused: its box says so to a screen reader, until it's changed.
  await p.fill('#e-num', 'hello');
  await p.press('#e-num', 'Enter');
  assert.deepEqual([await p.getAttribute('#e-num', 'aria-invalid'), await p.textContent('.toast span'), await p.evaluate(() => document.activeElement.id)], ['true', 'That set number doesn’t look right. It’s usually 4 or 5 digits.', 'e-num']);
  await p.fill('#e-num', '10311');
  assert.equal(await p.getAttribute('#e-num', 'aria-invalid'), null);
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
  await p.click('#step-next'); await p.click('#step-next');
  assert.equal(await step(), 'Step 3');
  await p.reload();
  await p.waitForSelector('#model-view:not([hidden])');
  assert.deepEqual([await step(), await p.evaluate(() => location.hash)], ['Step 3', '#model-x-cottage'], 'a reload reopens the model on its step');
  const wall = { brickyard: 1, model: { name: 'Wall', parts: Array.from({ length: 4 }, (_, i) => ['3001', 4, 0, i * 3, 0, 0, i + 1]) } };
  await p.goto(base + '#d1z' + deflateRawSync(JSON.stringify(wall)).toString('base64url'));
  await p.waitForFunction(() => location.hash.startsWith('#model-m'));
  await p.waitForSelector('#model-view:not([hidden])');
  assert.equal(await step(), 'Step 1', 'another model starts at its first step');
  await p.goto(base + '#build');
  await p.click('#build-list a[href="#model-x-cottage"]');
  await p.waitForSelector('#model-view:not([hidden])');
  assert.equal(await step(), 'Step 3', 'and the first is still on its step');
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
  assert.match(await p.textContent('li.lot'), /Loose · 108 pieces · box 4 · the builder can use 104/, 'and so does Your pieces');
  assert.deepEqual((await p.evaluate(() => window.brickyard.doc().loose.tub.parts)).map(r => r[0]).sort(), ['2780', '3001', '3003', '3023', '3660', '4073', '60481'], 'the lot keeps the numbers it came with');
  await p.click('#copy-pool');
  await p.waitForSelector('.toast:not([hidden])');
  const copied = await p.evaluate(() => navigator.clipboard.readText());
  assert.match(copied, /Pieces the builder knows, as LDraw part\/colour ×count:\n3001\/4 ×12, 3003\/1 ×6, 3023b\/15 ×50, 3660b\/4 ×10, 60481a\/4 ×6, 6141\/14 ×20\n\(1 more kinds/, 'what’s copied for Claude has them, under the builder’s numbers');
  const model = { brickyard: 1, model: { name: 'Bare stack', parts: [['3023', 15, 0, 0, 0, 0, 1], ['3023', 15, 0, 1, 0, 0, 2], ['4073', 14, 0, 2, 0, 0, 3]] } };
  await p.goto(base + '#d1z' + deflateRawSync(JSON.stringify(model)).toString('base64url'));
  await p.waitForFunction(() => location.hash.startsWith('#model-m') && !document.getElementById('model-view').hidden);
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
  // Steps numbered 1, 2, 5, 9: the step with nothing to join to is the page's step 3, not the model's 5.
  const gaps = { name: 'Gaps', parts: [['3001', 4, 0, 0, 0, 0, 1], ['3001', 15, -2, 3, 0, 0, 2], ['3001', 1, 4, 0, 0, 0, 5], ['3001', 14, 2, 3, 0, 0, 9]] };
  assert.equal((await open(gaps))[0], 'This model can’t be built as it is. Step 3 adds pieces with nothing to join to yet. Ask Claude to fix it.', 'a step is named as the page counts them');
  await p.tap('#step-next'); await p.tap('#step-next');
  assert.equal(await p.textContent('.stepnum'), 'Step 3 of 4');
  // A piece that goes on from underneath says so on its step.
  const under = { name: 'Under', parts: [['3001', 4, 0, 3, 0, 0, 1], ['3003', 15, 0, 0, 0, 0, 2], ['3003', 15, 0, 6, 0, 0, 3], ['3003', 15, 2, 0, 0, 0, 3]] };
  await open(under);
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
  assert.equal(await p.textContent('.stepnum'), 'Step 1 of 3', 'a model saved under an old id still opens at its address');
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
  await p.click('#step-next');
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

// A damaged entry among the saved models is skipped: the list still shows, and the home screen doesn't count it.
{
  const { c, p } = await withSets({ sets: {} });
  await p.evaluate(m => localStorage.setItem('brickyard.models', JSON.stringify({ a: null, b: { added: 1 }, c: { model: Object.assign({}, m, { name: 'Saved cottage' }), added: 2 } })), cottage.model);
  await p.goto(base + '#build');
  await p.waitForSelector('#build-list .list', { timeout: 10000 });
  assert.deepEqual(await p.locator('#build-list .list .item .t').allTextContents(), ['Saved cottage', 'Cottage · example']);
  await p.goto(base);
  assert.match(await p.textContent('#home-build-stat'), /^1 model from Claude/);
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
assert.match(await page.textContent('li.lot'), /Blue tub \(garage\).*Loose · 72 pieces · box 14 · the builder can use 42/);
assert.equal(await page.isChecked('[data-pool="sf-test"]'), true, 'loose pieces count unless unticked');
let stored = (await doc()).loose['sf-test'];
assert.deepEqual([stored.name, stored.box, stored.parts.length], ['Blue tub (garage)', '14', 3]);
assert.match(await page.textContent('.pieces .group'), /862/, 'the pool is the box (790, as My sets has it) plus the tub (72)');
await page.goto(base + '#');
await page.waitForFunction(() => /72 loose pieces/.test(document.getElementById('home-build-stat').textContent));
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
assert.match(await page.textContent('.sheet .flag'), /already have this lot \(72 pieces\)/);
assert.equal(await page.textContent('#ls-add'), 'Replace it');
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
assert.equal(await page.evaluate(() => Object.values(window.brickyard.doc().cases).filter(c => !c.del).length), 1, 'a double tap does not remove a bookcase');
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
  const saved = () => p.evaluate(() => Object.values(window.brickyard.doc().cases).map(k => k.id + ':' + k.levels.map(l => l.sets.map(q => q.id).join('+')).join('/')).sort().join(' '));
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
  const kept = () => p.evaluate(() => { const k = window.brickyard.doc().cases.k; return [k.w, k.d, k.levels.map(l => l.h + ':' + l.sets.map(q => q.id).join('+')).join(' ')]; });
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
  assert.deepEqual([await p.locator('.sheet').count(), await p.getAttribute('#k-w', 'aria-invalid'), await p.evaluate(() => document.activeElement.id), await toastSays()],
    [1, 'true', 'k-w', ['Width: “14 1/8” isn’t a length Brickyard can read. Type cm, or inches with in or " after the number.', '']], 'a size that can’t be read keeps the sheet open and says which box');
  await p.fill('#k-w', '30"');
  await p.click('#k-add');
  assert.deepEqual([(await rows())[2], await p.evaluate(() => document.activeElement.id)], ['28 |  | Height of shelf 3, cm | Remove shelf 3', 'k-h2'], 'a new shelf starts at the height above it, ready to type over');
  await p.fill('#k-h2', '');
  await p.click('#k-save');
  assert.deepEqual([await p.locator('.sheet').count(), await toastSays()], [1, ['Give shelf 3 a height, or remove it', '']]);
  await p.fill('#k-h2', '40');
  await p.click('#k-save');
  assert.deepEqual([await p.locator('.sheet').count(), await kept(), await toastSays()], [0, [76.2, 26, '32.5: 28:b+g 40:'], ['1 set is back in Not on a shelf yet. Read as inches: 76.2 cm', 'Undo']], '"32,5" is one shelf of 32.5 cm, inches are worked out, and the message says what came off');
  await p.click('.toast button');
  assert.deepEqual([await kept(), await toastSays()], [[76, 26, '32: 30:a 28:b+g'], ['Billy is as it was', '']], 'Undo puts the bookcase back with its sets');
  // A set's sizes, in the planner's sheet and in My sets'.
  await p.click('.sv-set[data-set="a"]');
  await p.fill('#z-h', '7 in');
  await p.click('#z-save');
  assert.deepEqual([await p.evaluate(() => window.brickyard.doc().sets.a.size.h), await toastSays()], [17.8, ['Read as inches: 17.8 cm', '']]);
  await p.click('.sv-set[data-set="a"]');
  await p.fill('#z-w', '20 x 15');
  await p.click('#z-save');
  assert.deepEqual([await p.locator('.sheet').count(), (await toastSays())[0].slice(0, 30)], [1, 'Width: “20 x 15” isn’t a lengt']);
  await p.click('#z-cat');
  await p.waitForSelector('#e-save');
  await p.fill('#e-w', '9 7/8"'); await p.fill('#e-d', '5,5');
  await p.click('#e-save');
  assert.deepEqual([await p.evaluate(() => window.brickyard.doc().sets.a.size), await toastSays()], [{ w: 25.1, d: 5.5, h: 17.8 }, ['Saved. Read as inches: 25.1 cm', '']], 'My sets reads sizes the same way');
  await p.click('.item:has-text("Bonsai Tree")');
  await p.fill('#e-h', '3200');
  await p.click('#e-save');
  assert.deepEqual([await p.locator('.sheet').count(), await toastSays()], [1, ['Height: “3200” is more than Brickyard keeps (500 cm).', '']]);
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
  const on = () => p.evaluate(() => window.brickyard.doc().cases.k.levels.map(l => l.sets.map(q => q.id).join('+')).join(' / '));
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
  const row = () => p.evaluate(() => window.brickyard.doc().cases.k.levels[1].sets.map(q => q.id + (q.turn ? '*' : '')).join(' '));
  await p.goto(base + '#shelves');
  await p.click('.sv-set[data-set="lm"]');
  assert.deepEqual([await p.textContent('#z-which'), await p.textContent('#z-where option:checked'), await p.textContent('#z-msg')], ['42115 · Technic', 'Billy · shelf 1 (32 cm)', ''], 'the sheet says which set it is, and which bookcase its shelf is on');
  await p.check('#z-turn');
  await p.click('#z-save');
  assert.deepEqual([await p.locator('.sheet').count(), await p.textContent('#z-msg'), await p.evaluate(() => !!window.brickyard.doc().cases.k.levels[0].sets[0].turn)], [1, 'Side-on it’s 60 cm deep; the shelf is 26.', false], 'a tick that can’t be honoured keeps the sheet open and says why');
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
  assert.deepEqual([await p.locator('.sheet').count(), await row(), await p.evaluate(() => window.brickyard.doc().sets.bs.size.h)], [0, 'lb bs bq*', 30], 'Move right moves the set and keeps the height typed');
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
  assert.deepEqual(await p.evaluate(() => Object.values(window.brickyard.doc().cases).map(k => [k.name, k.w, k.d, k.levels.map(l => l.h).join(' ')])), [['Billy', 76, 26, '30 30 30 30 30 30']]);
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
  assert.deepEqual([await p.textContent('.sheet .note'), await p.textContent('#zr-n')], ['Sizes Claude found for your sets. Sets that already have a size are unticked; tick one to replace it. 3 sizes look wrong and are unticked too: check them before you tick. One size in the list couldn’t be read.', '1 set']);
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
    return [r.width, s.parentNode.clientWidth - 24, parseFloat(getComputedStyle(s.querySelector('.sv-h')).fontSize) * r.width / s.viewBox.baseVal.width];
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
  await p.click('#step-next'); await p.click('#step-next');
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
    'Tree House is taken apart, but Brickyard has no parts list for it yet, so its pieces aren’t counted.']);
  await first.c.close();
  const many = await withSets({ sets: { a: other('a', 'Tree House', 'apart'), b: other('b', 'Galaxy Explorer', 'apart'), c: other('c', 'Medieval Castle', 'apart'), d: other('d', 'Typewriter', 'apart'),
    e: { id: 'e', t: 1, name: 'Bonsai Tree', state: 'apart' }, x: box('x', 'built'), y: box('y', 'partial'), z: box('z', 'sealed') },
    loose: { tub: { id: 'tub', t: 1, name: 'Blue tub', parts: [['3001', 4, 40]] } } });
  const p = many.p;
  await p.goto(base + '#build');
  await p.waitForSelector('[data-pool]');
  const rows = () => p.evaluate(() => [...document.querySelectorAll('.menu.pool li:not(.lot) small')].map(e => e.textContent));
  assert.deepEqual(await rows(), ['10698 · 790 pieces · built, so off unless you take it apart', '10698 · 790 pieces · partly built, so off', '10698 · 790 pieces · sealed, so off'], 'each set that’s off says why, with My sets’ piece count');
  assert.deepEqual(await says(p), ['Bonsai Tree, Galaxy Explorer, Medieval Castle and 2 more are taken apart, but Brickyard has no parts list for them yet, so their pieces aren’t counted.'], 'up to three are named');
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
  assert.deepEqual(await says(two.p), ['Tick a set to build from its pieces.', 'Tree House and Typewriter are taken apart, but Brickyard has no parts list for them yet, so their pieces aren’t counted.'], 'no word of loose pieces when there are none');
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
  assert.deepEqual(await says(p), ['0 of 4 sets on shelves', 'Brickyard needs each built set’s width, depth and height to fit it on a shelf. Measure them, or ask Claude: it knows the sizes LEGO gives for most sets.'], 'nothing placed yet: the count, and no word about tapping');
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
      document.querySelector('#build-list .how').insertAdjacentHTML('beforeend', '<div class="pic" id="shot"><img alt=""></div>');
      const bg = sel => getComputedStyle(document.querySelector(sel)).backgroundColor, probe = document.body.appendChild(document.createElement('i'));
      probe.style.background = 'var(--soft)';
      return [bg('.pic.swatches') === getComputedStyle(probe).backgroundColor, bg('#shot')];
    });
    assert.deepEqual(tiles, [true, colorScheme === 'dark' ? 'rgb(244, 241, 234)' : 'rgb(255, 255, 255)'], colorScheme + ': the swatch tile is the soft colour, a picture’s tile light');
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
  assert.deepEqual(await small(p, '#catalog .back, #catalog .icon-btn, #catalog .sync-btn, .chip, #group, #catalog .btn, .jd-foot a'), [], 'My sets: nothing to tap is under 44 px');
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
console.log('all good');
