// Copies parts/ into the designer skill, so the skill works on its own once it's uploaded to Claude:
//   node tools/copy-skill-data.mjs
// skill/brickyard-designer/data/ is that copy (shapes, colours, the index and every set's parts list). Run this
// whenever parts/ changes; test/build.test.cjs fails while the two differ.
import { cp, rm, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const from = join(root, 'parts'), to = join(root, 'skill/brickyard-designer/data');
await rm(to, { recursive: true, force: true }); // so a parts list that left parts/ leaves the copy too
await cp(from, to, { recursive: true });
const files = (await readdir(to, { recursive: true, withFileTypes: true })).filter(f => f.isFile());
console.log(`Copied parts/ to skill/brickyard-designer/data/ (${files.length} files). Upload the skill to Claude again for it to see them.`);
