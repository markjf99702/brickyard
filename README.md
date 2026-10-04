# Brickyard

**Use it: [brickyard.junkdrawer.works](https://brickyard.junkdrawer.works/)**

**A home for your LEGO: every set you own, where it is, and whether it's built.** Send Claude photos of your set boxes or built models, open the link it gives you, and the sets are in. While you're moving, it tracks which box each set is packed in.

<p align="center">
  <img src="docs/phone-catalog.png" alt="My sets, grouped by room: Bonsai Tree and Tree House on the living-room bookcase, the Large Creative Brick Box taken apart in the office closet, each with its picture, number, year and piece count" width="250">
  &nbsp;
  <img src="docs/phone-boxes.png" alt="The same sets grouped by moving box: Box 3 holds the sealed Medieval Castle and the partly built Typewriter, Box 12 the Lamborghini, marked Check" width="250">
  &nbsp;
  <img src="docs/phone-review.png" alt="Adding seven sets from Claude: a list with tick boxes, and fields to put them all in one room, shelf or moving box" width="250">
</p>

Brickyard is one app with three parts. **My sets** is here now. **Build from your box** (Claude designs a new model from only the pieces you own, with step-by-step instructions) and the **Shelf planner** (fit your built sets onto your shelves) come next, and both read from the same catalog.

## How it works

- **A catalog of sets.** For each set it keeps the number, name, year, piece count and theme; where it is (a room and shelf, or a moving box); whether it's built, partly built, taken apart or sealed; missing pieces; whether you have the paper instructions; its built size, for the shelf planner; tags and notes.
- **Add from photos.** Claude reads the set numbers off boxes and instruction books, or recognises built models, and makes a Brickyard link. Opening it shows the list first: sets you already own are unticked, anything Claude wasn't sure of is marked **Check**, and you can put the whole batch in one room, shelf or moving box before tapping **Add**.
- **Find things.** Search covers every field, and "box 3" finds what's packed in box 3. Filter by state, missing pieces or to check, and group by room, moving box, theme or state.
- **Pictures** of each set come from [Rebrickable](https://rebrickable.com/) by set number. Turn them off in the menu and nothing leaves your browser.
- **Backups.** Download the whole catalog as a file and open it on another device (it merges), or download a spreadsheet (CSV).
- No account and no server. Your catalog stays in your browser. It works offline and installs to a phone's home screen.

## Adding sets with Claude

`skill/brickyard-cataloger/` is a skill for Claude. Send it photos of your sets and it identifies each one, checks the set numbers, and hands them to Brickyard as a link and a `.brickyard.json` file. Its script also runs on its own:

```sh
python3 skill/brickyard-cataloger/scripts/make_brickyard.py sets.json
```

`skill/brickyard-cataloger/references/brickyard-format.md` describes the link, batch and backup formats.

## Running it

It's a static site: plain HTML, CSS and JavaScript, with no build step.

```sh
npx serve .                   # or any static file server, then open the printed address
npm test                      # unit tests, then uses it in Chromium through the real page (needs Playwright)
node tools/screenshots.mjs    # redraws docs/*.png and og.png (PICS=folder of thumbnails for set pictures)
node tools/make-icons.mjs     # redraws the PNG icons from icon.svg
```

To put it online with GitHub Pages: **Settings → Pages → Build and deployment → Deploy from a branch**, then pick `main` and `/ (root)`. The `CNAME` file serves it at brickyard.junkdrawer.works.

### Files

- `index.html`: the home screen and the catalog screen.
- `js/core.js`: cleaning sets, merging catalogs, finding doubles, search, links and the spreadsheet. No DOM, so the tests run it in Node.
- `js/app.js`: the screens, sheets and storage (`brickyard.v1` in localStorage).
- `css/app.css`: light and dark palettes.
- `skill/brickyard-cataloger/`: the Claude skill and its script.
- `test/core.test.cjs`, `test/e2e.mjs`: the tests; `test/fixtures/sample.json` is the sample batch the tests and screenshots use.
- `fonts/`: Rubik (SIL Open Font License, `fonts/OFL.txt`), served from here so nothing loads from elsewhere.
- `sw.js`: keeps a copy for using offline.

## License

MIT — see [LICENSE](LICENSE).
