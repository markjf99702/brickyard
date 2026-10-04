# Brickyard

A LEGO app: a static site with no build step, served by GitHub Pages at https://brickyard.junkdrawer.works/. Three parts share one catalog: **My sets** (built), **Build from your box** and **Shelf planner** (not yet). The catalog lives in the browser's localStorage under `brickyard.v1`. Nothing about anyone's sets belongs in this repo.

- **Photos of sets, or a list of set numbers, sent in a session here:** follow `skill/brickyard-cataloger/SKILL.md`. Write the batch JSON and the `.brickyard.json` output to the scratchpad, not the repo, and hand over the link the script prints.
- **Tests:** `npm test` (`node test/core.test.cjs` needs nothing; `test/e2e.mjs` needs Playwright). Keep `js/core.js` free of DOM access so the unit test can run it.
- **Formats** (batch, link, backup) are in `skill/brickyard-cataloger/references/brickyard-format.md`. Link prefix `#b1z` / `#b1j` / `#batch=`; changing the format means bumping the prefix and keeping the old one readable. The page (`cleanSet` in `js/core.js`) and the script (`clean` in `make_brickyard.py`) must clean the same way; the unit test checks they agree.
- **Build from your box:** the parts inventory for set 10698 (LDraw part and colour codes) is being prepared outside this repo; use it as the builder's palette rather than fetching Rebrickable again.
- Style: ES5-ish `var`/`function` code in IIFEs, like the other junkdrawer.works apps; no dependencies. When the file list changes, bump `CACHE` in `sw.js`.
