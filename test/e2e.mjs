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

// A link cut short (as a chat app can leave it) says so when Brickyard opens on it, and everything else still works.
{
  const p = await ctx.newPage();
  p.on('pageerror', e => problems.push(e.message));
  for (const [h, says] of [['#b1zAAAAA', 'doesn’t look like sets'], ['#l1zA', 'doesn’t look like sets'], ['#z1zA', 'doesn’t hold sizes']]) {
    await p.goto('about:blank');
    await p.goto(base + h);
    await p.waitForFunction(w => (document.querySelector('.toast') || {}).textContent?.includes(w), says, { timeout: 10000 });
    assert.equal(await p.evaluate(() => typeof window.brickyard), 'object', 'Brickyard started after a cut-off ' + h);
  }
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
await page.click('[data-close]');

// A set you already have takes a second tap to add again, and a double tap is still one tap.
await page.click('#add-btn');
await page.fill('#e-num', '10698');
await page.dblclick('#e-save');
assert.equal((await live()).length, 1, 'a double tap does not add a second copy');
assert.equal(await page.textContent('#e-save'), 'Add another copy');
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

// Edit: clear a check, then remove a set.
await page.click('.item:has-text("Lamborghini")');
await page.click('#e-ok');
await page.click('#e-save');
assert.ok(!(await live()).find(x => /Lamborghini/.test(x.name)).check);
await page.click('.item:has-text("Medieval Castle")');
await page.dblclick('#e-del');
assert.equal((await live()).length, 7, 'one tap, or a double tap, does not remove');
await page.waitForTimeout(700);
await page.click('#e-del');
assert.equal((await live()).length, 6);
assert.equal(Object.values((await doc()).sets).filter(x => x.del).length, 1, 'removal is remembered');

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

// Back with a sheet open goes back and closes the sheet, instead of leaving it over the screen before with the page
// under it locked.
{
  const { c, p } = await withSets({ sets: { a: { id: 'a', t: 1, name: 'Bonsai Tree' } } });
  const state = () => p.evaluate(() => [document.querySelectorAll('.scrim').length, document.body.style.overflow, document.getElementById('home').hidden, document.getElementById('home').inert]);
  await p.goto(base + '#catalog');
  await p.click('.item:has-text("Bonsai Tree")');
  await p.waitForSelector('.sheet');
  await p.goBack();
  await p.waitForFunction(() => !document.getElementById('home').hidden);
  assert.deepEqual(await state(), [0, '', false, false], 'Back from a set’s sheet: home, no sheet, and the page scrolls and works');
  await p.goto(base + '#model-x-cottage');
  await p.waitForSelector('#model-view:not([hidden])');
  await p.click('#model-menu');
  await p.waitForSelector('.sheet');
  await p.goBack();
  await p.waitForFunction(() => !document.getElementById('home').hidden);
  assert.deepEqual(await state(), [0, '', false, false], 'Back from a model’s menu too');
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
assert.match(await page.textContent('.pieces .group'), /876/, 'the pool is the box (804) plus the tub (72)');
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
await page.waitForFunction(() => /876/.test(document.querySelector('.pieces .group').textContent));
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
  assert.match(await p.textContent('.case .flag.bad'), /A set is too tall for its shelf, marked in red/);
  await c.close();
}

// A long reason under a set that doesn't fit is shown whole on a phone, not cut off.
{
  const { c, p } = await withSets({ sets: { l: { id: 'l', t: 1, name: 'Lamborghini Sián FKP 37', state: 'built', size: { w: 60, d: 26, h: 15 } } },
    cases: { k: { id: 'k', t: 1, name: 'Kallax', w: 33, d: 37, levels: [{ h: 33, sets: [] }] } } });
  await p.goto(base + '#shelves');
  const why = p.locator('#shelves-body .list .item:has-text("Lamborghini") .warn');
  assert.equal(await why.textContent(), 'Too big for every bookcase (60 × 26 cm)');
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
  assert.deepEqual(await why(), ['Too tall for every shelf (39 cm)']);
  await p.click('[data-act="add-case"]');
  await p.click('#k-preset [data-k="3"]');
  await p.fill('#k-name', 'Tall one'); await p.fill('#k-w', '40'); await p.fill('#k-d', '30'); await p.fill('#k-levels', '45');
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
