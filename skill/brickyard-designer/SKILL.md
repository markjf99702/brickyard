---
name: brickyard-designer
description: Design a new LEGO model from only the pieces someone owns, check it can really be built, and hand it to Brickyard as a link with 3D step-by-step instructions. Use this when someone pastes "My Brickyard pieces" from Brickyard, asks for a model built from their own bricks or their Large Creative Brick Box, or mentions Brickyard's "Build from your box". Also use it when they list or count loose LEGO pieces (a tub, a bag) to add to Brickyard.
---

# Brickyard designer

Brickyard (https://brickyard.junkdrawer.works/) shows a model in 3D, step by step, and checks it against the pieces the person has. Your job is to design the model they ask for **from their pieces only**, make sure the checker passes, and send them the link.

What matters, in order:
1. **It can be built.** Every part they need is in their pieces, in that colour, in that number. Nothing floats, nothing overlaps, each step joins onto what's already built, and no piece has to be squeezed in between pieces already built. The script checks all of this; never hand over a model it rejects.
2. **It looks like the thing.** A recognisable lighthouse beats a big one. Pick a scale the pieces can carry and spend the bright colours on what makes it read.
3. **It's pleasant to build.** Steps of 3 to 8 pieces, bottom up, finishing a course before starting the next.

## 1. Their pieces

Brickyard's **Copy my pieces for Claude** gives a line like `My Brickyard pieces, from 10698-1 Large Creative Brick Box + loose pieces (Blue tub)` and then `part/colour ×count` for every piece the builder knows. That list is the budget. When the first line ends `less the pieces in Cottage, which is built`, the pieces standing in that model are already out of the list: design from what's listed, and don't plan on taking the built model apart. It adds up their taken-apart sets and their **loose pieces** (lots counted by their Stud Finder scanner, or listed by hand). If they didn't paste one, use the sets they name (`--sets 10698-1`); the parts lists live in `data/sets/` and `data/index.json` says which sets have one. A set without a list can't be used yet; say so.

Paths here are from this skill's folder: `scripts/check_model.py`, and `data/` for everything the checker knows. (In the Brickyard repo the skill is `skill/brickyard-designer/`, and `data/` is a copy of the repo's `parts/`, which the script reads there.)

When they pasted a list, that list is the whole budget, loose pieces and all. Save what they pasted to a text file and give it to the script with `--pieces pieces.txt`. The pasted list already counts the sets it names, so the script leaves the model's own `sets` out of the count and says so in a NOTE. Don't put `--sets` beside a pasted list unless they have sets the list doesn't name: those are counted on top, and the script warns that they are. A `.brickyard-loose.json` file works with `--pieces` too; that one is added on top of the sets.

Part shapes are in `data/shapes.json` (name, `w` × `d` studs, `h` in plates, kind, which cells have studs on top `top` and take studs underneath `bot`). Colours are LDraw codes in `data/colors.json` (code, then name and hex). Only parts in shapes.json can be used; wheels, hinges and other specials can't yet. Write parts under the numbers shapes.json has. A few everyday numbers are read as those (`data/aliases.json`: 3023 is 3023b, 4073 is 6141), in the model and in their pieces, and the script says so in a NOTE.

## 2. Coordinates

- `x` runs left to right and `z` back to front, both in studs. `y` runs up in **plates**: a brick is 3, a plate or tile 1.
- A part's `x, y, z` is the back-left-bottom corner of its footprint **after** turning.
- Turn `r` is 0, 90, 180 or 270. At 0 a part's width runs along x and its depth along z; at 90 or 270 they swap. A 2x4 brick (3001, w 4 × d 2) at r 90 covers 2 studs across and 4 front to back.
- Slopes, curves and inverted slopes have their **high side at the back** (z = 0 of their own footprint) at r 0. Turned 90 the high side is on the right, 180 at the front, 270 on the left. The script's layer key says which way each one went (`high side right`; for an inverted slope, `full side right (overhangs to the left)`).
- Nothing can go under an arch or through a door or window frame: the checker treats them as solid.
- Parts join where one part's top studs meet the cells of the part sitting right on it. Tiles and the slope faces have no studs, so nothing joins on them.
- A piece can't be squeezed in between pieces already built. If a step adds a piece that joins an earlier step's piece under it **and** an earlier step's piece over it (a brick for the gap under a lintel that's already on, a plate slid between two built courses), the checker refuses the model: `Step 4 has a piece that would have to be squeezed in between pieces already built`. Put the piece in the step before whatever goes over it, or in the same step. Splitting the gap's filling into a stack doesn't help: pieces added in one step, one on another, that together fill a gap between pieces already built are refused the same way.
- Steps (`s`) start at 1. A step may only add parts that join something already built; pushing a part on from underneath is allowed but noted. That goes for the first step too: make it one part or one joined group (a base plate, say). Bricks side by side on the table join nothing until the course above ties them, so put that course in the same step.

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
python3 scripts/check_model.py lighthouse.json --layers --out OUTDIR
```

(Give the script's full path from wherever you're working, and any writable folder for `--out`.)

- It prints any problems with the parts they concern (numbered from 1), then `NOT READY`, and exits 1. For a model with problems it writes no file and prints no link, so there's nothing to hand over by mistake. (A file left in `--out` by an earlier run is not this model; the script points it out.) Fix and run again until it's clean.
- `--layers` draws the model from above, layer by layer (a layer is one plate high; the first row is the back), one letter per part, with a key of each part that starts on that layer: its name, colour, turn and step, and for slopes, curves and inverted slopes which side is high. A run of layers on which nothing starts is one line. Read it: it's how you see that the door is where you meant, the slopes face the right way, and the windows line up.
- Coordinates, turns and steps are whole numbers. The script warns about one that isn't and reads it as Brickyard would (2.5 as 3). It prints a NOTE for a colour that isn't in `data/colors.json`: nobody has pieces in a colour Brickyard doesn't know.
- Put the model file first: `--sets` and `--pieces` take everything after them. `--sets 10698-1` replaces the model's own `sets`, `--no-sets` counts no set at all, and `--pieces FILE` is a pasted list (the whole budget) or a loose-pieces file (added to the sets). Without any sets or pieces it can't check counts, so always give them.
- When it passes it writes `NAME.brickyard-model.json` to `--out`, prints a link starting `https://brickyard.junkdrawer.works/#d2z`, and exits 0.
- `--force` writes the file and prints the link for a model that failed, to look at what's wrong in Brickyard. That one is never for handing over.

Write the model's JSON and the outputs to a scratch or outputs folder, never into the skill's folder or a repo.

## Loose pieces they list themselves

Loose pieces are bricks that aren't a set: a tub, a bag. Stud Finder, their tray scanner, sends its own counts to Brickyard. When they tell you what's in a tub instead ("12 red 2x4 bricks and 7 white 2x4 plates in the blue tub") and want it in **Your pieces**, write the list as JSON and run the script:

```json
{"name": "Blue tub", "box": "14",
 "parts": [["3001", 4, 12], ["3020", "white", 7], ["2780", 0, 40, "Technic Pin with Friction"]]}
```

```sh
python3 scripts/make_loose.py tub.json --out OUTDIR
```

- A row is `[part, colour, count]`: LDraw part number, LDraw colour number (or the colour's name as `data/colors.json` has it), how many. Add the part's name as a fourth item for a piece that isn't in `data/shapes.json`: Brickyard keeps it and shows the name, though the builder can't use it yet.
- `name` is what they call it. The script makes the lot's id from the name, so a recount sent under the same name **replaces** the lot in Brickyard instead of adding a second one. Use the same name every time, and don't put a count or a date in it. `box` is the moving box it's packed in, if they said.
- The script prints `DROPPED:` for every row it leaves out, with why, and a `NOTE:` for a piece listed twice (the counts are added up) and for each piece the builder can't draw yet. Fix the rows you can; tell them about the rest. With no row it can read it writes nothing.
- It writes `NAME.brickyard-loose.json` and prints a link starting `https://brickyard.junkdrawer.works/#l2z`. Hand over the link and the file, the total, and anything left out. Opening it shows every kind of piece with its colour and count to check before it's added.

Only list a part you can name with confidence. "A handful of small grey bits" isn't a row: say you left it out.

## 4. Hand it over

Send the link, the file if your surface can attach files, and two or three lines: what it is, how many pieces and steps, and anything you swapped ("the roof is grey because you only have six yellow slopes"). Opening the link saves the model in Brickyard under **Models**, checks it against their pieces, and shows the finished model with **Start building**. If the script printed a NOTE that the link is long, lead with the file: some apps cut long links off, and they can open the file with **Open a file** under **Open a model** (or paste its text there).

If they come back with "I'm short of X" (they lost pieces, or have other sets ticked), redesign within the new list rather than telling them to buy parts.
