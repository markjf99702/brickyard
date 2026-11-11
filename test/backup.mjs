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

assert.deepEqual(problems, [], 'problems while using it');
await browser.close();
server.close();
console.log('backup: all good');
