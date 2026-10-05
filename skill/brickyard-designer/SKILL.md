---
name: brickyard-designer
description: Design a new LEGO model from only the pieces someone owns, check it can really be built, and hand it to Brickyard as a link with 3D step-by-step instructions. Use this when someone pastes "My Brickyard pieces" from Brickyard, asks for a model built from their own bricks or their Large Creative Brick Box, or mentions Brickyard's "Build from your box".
---

# Brickyard designer

Brickyard (https://brickyard.junkdrawer.works/) shows a model in 3D, step by step, and checks it against the pieces the person has. Your job is to design the model they ask for **from their pieces only**, make sure the checker passes, and send them the link.

What matters, in order:
1. **It can be built.** Every part they need is in their pieces, in that colour, in that number. Nothing floats, nothing overlaps, and each step joins onto what's already built. The script checks all of this; never hand over a model it rejects.
2. **It looks like the thing.** A recognisable lighthouse beats a big one. Pick a scale the pieces can carry and spend the bright colours on what makes it read.
3. **It's pleasant to build.** Steps of 3 to 8 pieces, bottom up, finishing a course before starting the next.

## 1. Their pieces

Brickyard's **Copy my pieces for Claude** gives a line like `My Brickyard pieces, from 10698-1 Large Creative Brick Box` and then `part/colour ×count` for every piece the builder knows. That list is the budget. If they didn't paste one, use the sets they name (`--sets 10698-1`); the parts lists live in `parts/sets/` (`data/sets/` when this skill is used outside the repo) and `parts/index.json` says which sets have one. A set without a list can't be used yet; say so.

Part shapes are in `parts/shapes.json` (name, `w` × `d` studs, `h` in plates, kind, which cells have studs on top `top` and take studs underneath `bot`). Colours are LDraw codes in `parts/colors.json`. Only parts in shapes.json can be used; wheels, hinges and other specials can't yet.

## 2. Coordinates

- `x` runs left to right and `z` back to front, both in studs. `y` runs up in **plates**: a brick is 3, a plate or tile 1.
- A part's `x, y, z` is the back-left-bottom corner of its footprint **after** turning.
- Turn `r` is 0, 90, 180 or 270. At 0 a part's width runs along x and its depth along z; at 90 or 270 they swap. A 2x4 brick (3001, w 4 × d 2) at r 90 covers 2 studs across and 4 front to back.
- Slopes, curves and inverted slopes have their **high side at the back** (z = 0 of their own footprint) at r 0. Turned 90 the high side is on the right, 180 at the front, 270 on the left. The script's layer map shows which way each part went.
- Parts join where one part's top studs meet the cells of the part sitting right on it. Tiles and the slope faces have no studs, so nothing joins on them.
- Steps (`s`) start at 1. A step may only add parts that join something already built; pushing a part on from underneath is allowed but noted.

Write the model as JSON:

```json
{
  "name": "Lighthouse",
  "about": "A red and white lighthouse on a rocky base.",
  "sets": ["10698-1"],
  "parts": [
    ["3001", 4, 0, 0, 0, 0, 1],
    ["3003", 15, 1, 3, 0, 90, 2]
  ]
}
```

Each part is `[part, colour, x, y, z, turn, step]`. `about` is one or two plain sentences shown under the model.

## 3. Design, then check

Work course by course from a base plate up. Keep a running tally of what you've used against the budget as you go; it's easy to run out of one colour of 1x2 bricks halfway up a wall. Overlap bricks between courses (running bond) so walls hold together; a stack of separate columns fails the join check.

For anything bigger than a handful of parts, write a small Python script that generates the parts list (loops for walls, a helper for each course) rather than typing coordinates by hand. Then run:

```sh
python3 skill/brickyard-designer/scripts/check_model.py lighthouse.json --layers --out OUTDIR
```

- It prints any problems with the parts they concern (numbered from 1) and exits 1. Fix and run again until it's clean.
- `--layers` draws every plate-height layer from above, one letter per part, with a key. Read it: it's how you see that the door is where you meant, the slopes face the right way, and the windows line up.
- `--sets` overrides the model's own `sets`. Without any sets it can't check counts, so always give them.
- When it passes it writes `NAME.brickyard-model.json` to `--out` and prints a link starting `https://brickyard.junkdrawer.works/#d1z`.

Write the JSON and outputs to a scratch folder, not the repo.

## 4. Hand it over

Send the link, the file if your surface can attach files, and two or three lines: what it is, how many pieces and steps, and anything you swapped ("the roof is grey because you only have six yellow slopes"). Opening the link saves the model in Brickyard under **Models**, checks it against their pieces, and shows step 1. If the link is too long for where they'll paste it (over about 8,000 characters), say they can also paste the file into **Open a model**.

If they come back with "I'm short of X" (they lost pieces, or have other sets ticked), redesign within the new list rather than telling them to buy parts.
