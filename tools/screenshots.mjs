// Renders the README screenshots (docs/*.png) and the link preview (og.png):  node tools/screenshots.mjs
// Uses the sample sets in test/fixtures/sample.json. Set pictures come from Rebrickable, which a sandbox's browser
// can't always reach, so the page is handed them from a folder of thumbnails named NUM.s.jpg and NUM.l.jpg. Left
// to itself the tool keeps that folder in tools/pics (not in git) and fetches the sample sets' pictures into it with
// curl the first time; if one can't be had it stops, where it used to draw every set as a plain brick and leave
// five changed pictures behind. PICS=folder uses a folder of your own as it is; PICS=none draws the plain brick
// on purpose.
import { createRequire } from 'node:module';
import { execSync, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile, mkdir, rename, rm } from 'node:fs/promises';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
let pw;
try { pw = require('playwright'); } catch { pw = require(join(execSync('npm root -g').toString().trim(), 'playwright')); }
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json', '.json': 'application/json' };

// The sample batch, as a stored catalog.
const C = { exports: {} };
new Function('module', await readFile(join(root, 'js/core.js'), 'utf8'))(C);
const sample = C.exports.cleanBatch(JSON.parse(await readFile(join(root, 'test/fixtures/sample.json'), 'utf8')));
const sets = {};
sample.sets.forEach((x, i) => { const id = 's' + i; sets[id] = Object.assign({ id, t: 1790000000000 + i, added: '2026-10-0' + (1 + (i % 4)) }, x); });
const catalog = { brickyard: 1, catalog: { sets, seen: {} } };

// The folder of set pictures (see the top). Each picture is fetched to a name of its own first, so one that
// stopped halfway is never taken for a picture the next time.
const PICS = process.env.PICS === 'none' ? '' : process.env.PICS || join(root, 'tools/pics');
if (!process.env.PICS) {
  await mkdir(PICS, { recursive: true });
  for (const x of sample.sets) for (const [size, end] of [['250x250p', '.s.jpg'], ['1000x800p', '.l.jpg']]) {
    const file = join(PICS, x.num + end), url = `https://cdn.rebrickable.com/media/thumbs/sets/${x.num}.jpg/${size}.jpg`;
    if (await readFile(file).then(() => true, () => false)) continue;
    try {
      execFileSync('curl', ['-fsSL', '--max-time', '60', '-o', file + '.part', url], { stdio: ['ignore', 'ignore', 'pipe'] });
      // A JPEG, or a PNG: Rebrickable sends some sets' pictures as PNG under the .jpg name.
      const head = (await readFile(file + '.part')).subarray(0, 2).toString('hex');
      if (head !== 'ffd8' && head !== '8950') throw new Error('what came back isn’t a picture');
      await rename(file + '.part', file);
    } catch (e) {
      await rm(file + '.part', { force: true });
      console.error(`Couldn’t fetch the picture of set ${x.num} (${url}):\n  ${String(e.stderr || e.message).trim()}\n` +
        'Nothing was drawn. Check the connection and run it again, or run with PICS=none to draw every set as a plain brick.');
      process.exit(1);
    }
  }
}

const server = createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let body;
  try { body = await readFile(join(root, path === '/' ? 'index.html' : path)); } catch { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': TYPES[extname(path)] || 'text/html' });
  res.end(body);
}).listen(0);
const base = `http://localhost:${server.address().port}/`;
const browser = await pw.chromium.launch();
// Chromium's language here is US English, where Brickyard starts in inches; every page is opened in British
// English, so it starts in cm, unless a check says otherwise.
const newContext = browser.newContext.bind(browser);
browser.newContext = (o = {}) => newContext({ locale: 'en-GB', ...o });
await mkdir(join(root, 'docs'), { recursive: true });

async function open(viewport, deviceScaleFactor, hash = '', seed = true) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor, hasTouch: true, serviceWorkers: 'block' });
  await ctx.route('https://cdn.rebrickable.com/**', async route => {
    const m = /sets\/([^/]+)\.jpg\/(\d+)x/.exec(route.request().url());
    if (!PICS || !m) return route.fulfill({ status: 404 });
    try { route.fulfill({ body: await readFile(join(PICS, m[1] + (m[2] === '250' ? '.s.jpg' : '.l.jpg'))), contentType: 'image/jpeg' }); }
    catch { route.fulfill({ status: 404 }); }
  });
  const page = await ctx.newPage();
  // With a backup just downloaded, so the home screen is drawn without its line about one being due (the sample
  // sets are dated weeks back).
  if (seed) await page.addInitScript(c => { localStorage.setItem('brickyard.v1', JSON.stringify(c)); localStorage.setItem('brickyard.backup', JSON.stringify({ t: Date.now() })); }, seed === true ? catalog : seed);
  await page.goto(base + hash);
  await page.evaluate(() => document.fonts.ready);
  await settled(page);
  return page;
}
// Before a shot: every set picture on the screen has loaded (and faded in) or failed, so none is caught halfway.
// (It was a fixed 400 ms after the page opened, and no wait at all after the list was drawn again.) A picture
// further down the page than the screen isn't asked for until it's scrolled to, and isn't in the shot.
async function settled(page) {
  await page.waitForFunction(() => [...document.querySelectorAll('.pic img')].every(i => {
    const r = i.getBoundingClientRect();
    return i.parentNode.classList.contains('in') || r.top >= innerHeight || r.bottom <= 0 || !r.width;
  }) && (document.getElementById('home').hidden || document.getElementById('home-build-stat').textContent.trim() !== ''), // and the home screen's count is in
  null, { timeout: 15000 });
  await page.waitForTimeout(400);
}

const shots = [
  ['home', '', null],
  ['catalog', '#catalog', null],
  ['boxes', '#catalog', async p => { await p.selectOption('#group', 'box'); }],
  ['set', '#catalog', async p => { await p.click('.item >> nth=1'); }],
];
for (const [name, hash, act] of shots) {
  const page = await open({ width: 390, height: 844 }, 2, hash);
  if (act) { await act(page); await settled(page); }
  await page.screenshot({ path: join(root, `docs/phone-${name}.png`) });
  await page.context().close();
}
// Build from your box: the example cottage at its last step, from the sample's Large Creative Brick Box (taken
// apart). The 3D view needs WebGL, which headless Chromium draws in software.
{
  const page = await open({ width: 390, height: 844 }, 2, '#model-x-cottage');
  await page.waitForSelector('#model-view:not([hidden])');
  await page.evaluate(() => { const r = document.getElementById('step-range'); r.value = r.max; r.dispatchEvent(new Event('input')); });
  await page.waitForTimeout(1000);
  await page.screenshot({ path: join(root, 'docs/phone-build.png'), fullPage: true });
  await page.context().close();
}
// The Shelf planner: the sample's built sets with made-up sizes and one Billy, after Fit, with its message put away.
// The Tree House is taller than a Billy's shelf, so it stays off, counted under the line at the top.
{
  const sizes = { '10497-1': [52, 26, 13], '21318-1': [27, 24, 37], '10281-1': [20, 21, 18], '21327-1': [27, 26, 11], '42115-1': [60, 25, 13] };
  const shelved = JSON.parse(JSON.stringify(catalog));
  Object.values(shelved.catalog.sets).forEach(x => { const z = sizes[x.num]; if (z) x.size = { w: z[0], d: z[1], h: z[2] }; });
  shelved.catalog.cases = { k: { id: 'k', t: 1790000000000, name: 'Billy', room: 'Living room', w: 76, d: 26, levels: [30, 30, 30, 30, 30, 30].map(h => ({ h, sets: [] })) } };
  const page = await open({ width: 390, height: 844 }, 2, '#shelves', shelved);
  await page.click('[data-act="fill"]');
  await page.click('.toast span');
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(root, 'docs/phone-shelves.png') });
  await page.context().close();
}
// What opening a link from Claude looks like, on an empty catalog.
{
  const z = execSync(`python3 skill/brickyard-cataloger/scripts/make_brickyard.py test/fixtures/sample.json --out ${JSON.stringify(join(root, 'node_modules/.tmp'))}`, { cwd: root }).toString();
  const link = z.trim().split('\n').find(l => l.startsWith('https://'));
  const page = await open({ width: 390, height: 844 }, 2, link.slice(link.indexOf('#')), false);
  await page.waitForSelector('.rv');
  await settled(page);
  await page.screenshot({ path: join(root, 'docs/phone-review.png') });
  await page.context().close();
}

// Link preview: a card with the name on the left and the catalog on the right.
{
  const shot = await open({ width: 390, height: 640 }, 2, '#catalog');
  const png = (await shot.screenshot()).toString('base64');
  await shot.context().close();
  const font = (await readFile(join(root, 'fonts/rubik.woff2'))).toString('base64');
  const icon = await readFile(join(root, 'icon.svg'), 'utf8');
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
  await page.setContent(`<style>@font-face{font-family:R;src:url(data:font/woff2;base64,${font}) format('woff2');font-weight:400 800}
    body{margin:0;width:1200px;height:630px;background:#f6f1e7;font-family:R;color:#23201c;display:flex;overflow:hidden}
    .l{flex:1;padding:84px 0 0 84px}.l svg{width:96px;height:96px}h1{font-size:96px;margin:28px 0 10px;letter-spacing:-.02em}
    p{font-size:34px;line-height:1.3;color:#6e665c;margin:0;max-width:560px}
    .r{width:430px;margin:48px 76px 0 0;border-radius:36px 36px 0 0;overflow:hidden;box-shadow:0 20px 50px -20px rgba(60,40,10,.45);border:10px solid #23201c;border-bottom:0}
    .r img{width:100%;display:block}</style>
    <div class="l">${icon}<h1>Brickyard</h1><p>Every LEGO set you own, where it is, and whether it’s built.</p></div><div class="r"><img src="data:image/png;base64,${png}"></div>`);
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: join(root, 'og.png') });
  await page.close();
}

await browser.close();
server.close();
console.log('screenshots written');
