// Bundles Brickyard into one file for the Artifact viewer:  node tools/build-artifact.mjs  →  dist/artifact.html
// The viewer adds its own document wrapper, so this is the page's insides: title, style, body, scripts.
// The copy opens on the example batch (test/fixtures/sample.json) when its catalog is empty. It carries the
// builder's data files in window.BRICKYARD_DATA and loads three.js from jsDelivr, the viewer's allowed CDN.
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
const THREE = 'https://cdn.jsdelivr.net/npm/three@0.186.1/';
const files = ['parts/shapes.json', 'parts/colors.json', 'parts/index.json', 'models/cottage.json'];
for (const n of Object.keys(JSON.parse(await read('parts/index.json')))) files.push('parts/sets/' + n + '.json');
const data = {};
for (const f of files) data[f] = JSON.parse(await read(f));
const build = (await read('js/build.js'))
  .replace("from './vendor/three.module.js'", "from 'three'")
  .replace("from './vendor/OrbitControls.js'", `from '${THREE}examples/jsm/controls/OrbitControls.js'`);
const out = `<title>Brickyard</title>
<style>
${css}</style>
${body}<script>window.BRICKYARD_EXAMPLE = ${script(JSON.stringify({ brickyard: 1, batch: example }))};</script>
<script>
${script(await read('js/core.js'))}</script>
<script>
${script(await read('js/shelf-core.js'))}</script>
<script>
${script(await read('js/app.js'))}</script>
<script>
${script(await read('js/shelves.js'))}</script>
<script>window.BRICKYARD_DATA = ${script(JSON.stringify(data))};</script>
<script>
${script(await read('js/build-core.js'))}</script>
<script type="importmap">{"imports":{"three":"${THREE}build/three.module.min.js"}}</script>
<script type="module">
${script(build)}</script>
`;
await mkdir(join(root, 'dist'), { recursive: true });
await writeFile(join(root, 'dist/artifact.html'), out);
console.log('dist/artifact.html', Math.round(out.length / 1024) + ' KB');
