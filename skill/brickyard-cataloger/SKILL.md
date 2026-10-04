---
name: brickyard-cataloger
description: Catalog someone's LEGO sets into Brickyard, their LEGO app, from photos of set boxes, instruction books or built models (or a typed list of set numbers), and hand them over as a one-tap link and a file. Use this whenever someone sends photos of LEGO sets or boxes, wants sets added to their LEGO catalog, mentions Brickyard, or is packing LEGO for a move and wants to track which box each set is in.
---

# Brickyard cataloger

Brickyard (https://brickyard.junkdrawer.works/) keeps track of someone's LEGO: every set they own, where it is (a room and shelf, or a moving box), whether it's built, and what pieces are missing. It keeps its data in their browser and nowhere else. Your job is to turn photos of their sets into an accurate list and hand it to Brickyard as a **link**. Opening the link shows the list to check, with sets they already own unticked, before anything is added.

Two things make this worth doing, so protect them:
- **Accuracy over completeness.** A wrong set in someone's catalog is worse than a missing one. Never invent set numbers, and say plainly what you couldn't identify.
- **Their catalog, their call.** They review everything in Brickyard before it's added. Flag doubts rather than resolving them silently.

## 1. Read the photos

Go through each photo and make sure every set you can see ends up either in the list or in your "couldn't identify" note.

What each kind of photo gives you:
- **Boxes:** the set number (4 to 6 digits, usually in a corner of the front, often next to the age range and piece count), the name, the theme logo, and the piece count. This is the best evidence there is.
- **Instruction books:** the set number on the front cover, and a picture of the model.
- **Built models:** only the model itself. Identify the set if you recognise it with confidence, and flag it with `unsure` otherwise ("built model; looks like 10497 Galaxy Explorer").
- **Loose bricks in bags or a bin:** not a set. Mention them, don't list them.

Rules:
- **Set numbers from what's visible, or from a confident identification.** A number you read off a box needs no flag. A number you know from recognising a built model gets `unsure` saying so. A number you're guessing between two sets gets `unsure` naming both ("could be 42083").
- **Name, year, pieces and theme** can come from the box or from what you know about that set number. Leave out what you don't know rather than guess.
- **Two copies of the same set** are two entries. The script warns about doubles; keep both only if there really are two.

## 2. Where they are, and what state they're in

Each set can have a **room** and a **spot** (shelf, desk, closet), and a **moving box** label for while things are packed. Use what they tell you: "these are on the office bookcase" → `room: "Office", spot: "Bookcase"`; "this is box 7" → `box: "7"`. If they said nothing, don't hold things up asking: the review screen lets them set a room, spot and box for the whole batch.

Each set has a **state**:
- `built`: assembled, on display or put away whole;
- `partial`: partly built;
- `apart`: taken apart, in bags or loose;
- `sealed`: never opened.

A photo of a built model means `built`; a sealed box with the factory tape means `sealed`. Otherwise leave it out unless they say. Pick up anything else they mention: missing pieces ("the Tree House is missing a leaf" → `missing`), whether they still have the paper instructions (`instr: true` or `false`), sizes if they measured (`size` in cm).

## 3. Build the batch

When code tools are available, write the batch as JSON and run the bundled script:

```
python3 scripts/make_brickyard.py sets.json --out /mnt/user-data/outputs
```

(Use any writable folder for `--out`.)

```json
{"name": "Office, top shelf", "room": "Office", "spot": "Top shelf",
 "sets": [
  {"num": "10497", "name": "Galaxy Explorer", "year": 2022, "pieces": 1254, "theme": "Icons", "state": "built"},
  {"num": "10698", "name": "Large Creative Brick Box", "year": 2015, "pieces": 790, "theme": "Classic", "state": "apart", "box": "7", "instr": true},
  {"num": "42115", "name": "Lamborghini Sián FKP 37", "state": "built", "unsure": "built model; could be 42083 Bugatti Chiron"}
 ]}
```

Every field but a set number or name is optional; `references/brickyard-format.md` lists them all. The script normalises set numbers to Rebrickable's form (`10698` → `10698-1`), drops and flags anything that isn't a set number, maps words like "assembled" or "new in box" onto the four states, warns about doubles, and prints a summary, a **link** and a `.brickyard.json` file path. Read any warnings: they usually mean one more look at a photo.

Without code tools, write the JSON by hand wrapped as `{"brickyard": 1, "batch": {…}}` and give it as text to paste into Brickyard (**Add from photos** › paste box). The link needs the script.

## 4. Hand it over

1. One line: how many sets, and from where.
2. The list, short: *number Name*, one per line. Mark flagged ones and say what to check.
3. Anything you couldn't identify, and where it is in the photo.
4. The Brickyard link, as a link, copied character for character from the script's output.
5. The file as the fallback (**Open a file** in Brickyard's menu).

Don't claim you've added sets to their catalog. They add them when they open the link and tap **Add**. Opening the same link twice is safe: Brickyard says so and unticks what's already there.
