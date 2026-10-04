// Bundles Brickyard into one file for the Artifact viewer:  node tools/build-artifact.mjs  →  dist/artifact.html
// The viewer adds its own document wrapper, so this is the page's insides: title, style, body, scripts.
// The copy opens on the example batch (test/fixtures/sample.json) when its catalog is empty.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = f => readFile(join(root, f), 'utf8');
const html = await read('index.html');
const font = (await readFile(join(root, 'fonts/rubik.woff2'))).toString('base64');
const css = (await read('css/app.css')).replace("url('../fonts/rubik.woff2')", `url(data:font/woff2;base64,${font})`);
const body = html.slice(html.indexOf('<body>') + 6, html.indexOf('  <script src="js/core.js">'));
const example = JSON.parse(await read('test/fixtures/sample.json'));
example.name = 'Example sets';
const script = s => s.replace(/<\/script/gi, '<\\/script');
const out = `<title>Brickyard</title>
<style>
${css}</style>
${body}<script>window.BRICKYARD_EXAMPLE = ${script(JSON.stringify({ brickyard: 1, batch: example }))};</script>
<script>
${script(await read('js/core.js'))}</script>
<script>
${script(await read('js/app.js'))}</script>
`;
await mkdir(join(root, 'dist'), { recursive: true });
await writeFile(join(root, 'dist/artifact.html'), out);
console.log('dist/artifact.html', Math.round(out.length / 1024) + ' KB');
