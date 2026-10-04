// Renders the README screenshots (docs/*.png) and the link preview (og.png):  node tools/screenshots.mjs
// Uses the sample sets in test/fixtures/sample.json. Set pictures come from Rebrickable; the sandbox's browser
// can't reach it, so point PICS at a folder of thumbnails named NUM.s.jpg and NUM.l.jpg (curl them first),
// or leave it unset to show the plain brick instead.
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

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
await mkdir(join(root, 'docs'), { recursive: true });

// The sample batch, as a stored catalog.
const C = { exports: {} };
new Function('module', await readFile(join(root, 'js/core.js'), 'utf8'))(C);
const sample = C.exports.cleanBatch(JSON.parse(await readFile(join(root, 'test/fixtures/sample.json'), 'utf8')));
const sets = {};
sample.sets.forEach((x, i) => { const id = 's' + i; sets[id] = Object.assign({ id, t: 1790000000000 + i, added: '2026-10-0' + (1 + (i % 4)) }, x); });
const catalog = { brickyard: 1, catalog: { sets, seen: {} } };

async function open(viewport, deviceScaleFactor, hash = '', seed = true) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor, hasTouch: true, serviceWorkers: 'block' });
  await ctx.route('https://cdn.rebrickable.com/**', async route => {
    const m = /sets\/([^/]+)\.jpg\/(\d+)x/.exec(route.request().url());
    if (!process.env.PICS || !m) return route.fulfill({ status: 404 });
    try { route.fulfill({ body: await readFile(join(process.env.PICS, m[1] + (m[2] === '250' ? '.s.jpg' : '.l.jpg'))), contentType: 'image/jpeg' }); }
    catch { route.fulfill({ status: 404 }); }
  });
  const page = await ctx.newPage();
  if (seed) await page.addInitScript(c => localStorage.setItem('brickyard.v1', JSON.stringify(c)), catalog);
  await page.goto(base + hash);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400);
  return page;
}

const shots = [
  ['home', '', null],
  ['catalog', '#catalog', null],
  ['boxes', '#catalog', async p => { await p.selectOption('#group', 'box'); }],
  ['set', '#catalog', async p => { await p.click('.item >> nth=1'); await p.waitForTimeout(400); }],
];
for (const [name, hash, act] of shots) {
  const page = await open({ width: 390, height: 844 }, 2, hash);
  if (act) await act(page);
  await page.screenshot({ path: join(root, `docs/phone-${name}.png`) });
  await page.context().close();
}
// What opening a link from Claude looks like, on an empty catalog.
{
  const z = execSync(`python3 skill/brickyard-cataloger/scripts/make_brickyard.py test/fixtures/sample.json --out ${JSON.stringify(join(root, 'node_modules/.tmp'))}`, { cwd: root }).toString();
  const link = z.trim().split('\n').find(l => l.startsWith('https://'));
  const page = await open({ width: 390, height: 844 }, 2, link.slice(link.indexOf('#')), false);
  await page.waitForSelector('.rv');
  await page.waitForTimeout(400);
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
