# Brickyard formats

## A batch (what you hand over)

```json
{"brickyard": 1, "batch": {
  "name": "Office, top shelf",
  "room": "Office", "spot": "Top shelf", "box": "", "state": "built",
  "sets": [{"num": "10497-1", "name": "Galaxy Explorer", "year": 2022, "pieces": 1254, "theme": "Icons"}]}}
```

| Field | Meaning |
|---|---|
| `name` | What the batch is, shown when it's opened. Up to 120 characters |
| `room`, `spot`, `box`, `state` | Defaults for sets that don't say their own. A set with no room gets the batch's room and spot; a set in the batch's room with no spot gets the batch's spot |
| `id` | Optional. Brickyard remembers batch ids it has added, so it can say when a link is opened twice. The script makes one from the content |
| `sets[]` | The sets |

Each set:

| Field | Meaning |
|---|---|
| `num` | Set number. `10698`, `10698-1`, `#10698` and `LEGO 10698` all mean `10698-1` (Rebrickable's form: number, dash, version) |
| `name` | Up to 160 characters. A set needs a `num` or a `name` |
| `year`, `pieces` | Whole numbers |
| `theme` | Free text: "Icons", "Technic", "Creator 3in1" |
| `state` | `built`, `partial`, `apart` or `sealed` |
| `room`, `spot` | Where it is, free text up to 60 characters each |
| `box` | Moving-box label, free text up to 40 characters ("7", "Kitchen 2") |
| `missing` | Missing pieces, free text |
| `instr` | `true` if they have the paper instructions, `false` if not |
| `size` | `{"w": 37, "d": 18, "h": 28}`: built size in cm, for the shelf planner |
| `tags` | List of short labels |
| `notes` | Free text, line breaks kept |
| `unsure` | What to double-check, in a few words. Shows as "Check" in Brickyard |

Brickyard ignores fields it doesn't know and drops values that don't fit, so a slip degrades quietly.

## Links

```
https://brickyard.junkdrawer.works/#b2z<data><check>
```

`<data>` is the compact batch JSON, compressed with raw DEFLATE, then base64url-encoded without padding. `<check>` is seven characters worked out from the rest, so a link that loses or changes a character on the way is turned down instead of opening as something else: the 32-bit FNV-1a hash of `b2z<data>` (the letters after the `#`, then the data), written in base 36 and padded with zeros on the left to seven characters. `#b2j<data><check>` is the same without compression. `make_brickyard.py` writes `#b2z`.

The unchecked forms still open, and always will: `#b1z<data>` and `#b1j<data>` (the same data with no check on the end; every link made before the check existed, and the ones Stud Finder sends), and `#batch=<URL-encoded JSON>`, which can be written by hand. The other kinds of link below have both forms too: `#z2z` and `#z1z` for sizes, `#l2z` and `#l1z` for loose pieces, `#d2z` and `#d1z` for a model, each with a `j` form. A copy of Brickyard from before the check says a `2` link needs a newer Brickyard, and to reload. The part after `#` never reaches a server.

## Sizes (for the shelf planner)

```json
{"brickyard": 1, "sizes": [{"num": "10497", "w": 52, "d": 32, "h": 13, "note": "LEGO's measurements"}]}
```

Built sizes in cm for sets already in Brickyard: `w` across the front, `d` front to back, `h` tall, and an optional `note` (up to 200 characters). The link is `#z2z<data><check>` (`#z2j` uncompressed; `#z1z` and `#z1j` without the check), made the same way as a batch link; `make_brickyard.py` makes it from a file like this. A row needs the set's number and all three sides; a side over 500 cm (a size written in mm, say) leaves its row out, in the script and in the page. Opening the link offers each size for the sets in My sets with that number, unticked where a set already has a size or where the size looks wrong for the set (a side under 1.5 cm or over 150 cm, or far too small or large for its piece count), with a line saying why. It never adds sets.

## A backup

**Download a backup** in Brickyard's menu saves `{"brickyard": 1, "saved": "2026-11-11T09:30:00.000Z", "catalog": {"sets": {id: set}, "seen": {batch id: time}, "cases": {id: bookcase}, "loose": {id: lot}}, "models": {id: {"model": model, "added": time}}}`. `saved` (when the file was made) and `models` are optional: a backup made before November 2026 has neither, and a Brickyard from before then opens a newer file and takes its catalog. Each set also has `id`, `t` (last changed, in milliseconds) and `added` (date). `"del": 1` marks a removed set, kept so a merge doesn't bring it back. Opening a backup merges it set by set, newest change winning. Opened as a file (not a link), it can instead put everything back the way the file has it: each set, bookcase and lot that differs is written as the file has it and anything the file doesn't have is removed, all timed at that moment so they win later merges. A bookcase is `{"id", "t", "name", "room", "w", "d", "levels": [{"h", "sets": [{"id", "turn"}]}]}`: inside width and depth in cm, and its shelves from the top down, each with its clear height and the sets on it left to right (`turn` when a set stands side-on). Bookcases merge the same way, and so do lots of loose pieces (below). `models` holds the models from Claude kept in that browser (each as in A model, below or in the designer skill's notes, with the time it was added); opening the backup adds the ones that browser doesn't have, by their parts, and leaves the rest as they are. Models are in the backup file only: the file Drive sync keeps is the catalog alone, and Copy everything as a link carries the catalog alone.

## A lot of loose pieces

Bricks that aren't a set: a tub, a bag, a moving box. Stud Finder (the tray scanner) makes these; so can anything that can count parts.

```json
{"brickyard": 1, "loose": {
  "id": "sf1a2b3c4d5e", "name": "Blue tub", "box": "14", "note": "",
  "parts": [["3001", 4, 12], ["3020", 15, 7], ["2780", 0, 40, "Technic Pin with Friction"]]}}
```

| Field | Meaning |
|---|---|
| `id` | Keeps the lot the same lot. Opening a lot whose id Brickyard already has **replaces** it, so a re-scan never doubles the count. Left out, one is made from the contents |
| `name` | Up to 80 characters; "Loose pieces" if left out |
| `box` | Moving-box label, up to 40 characters |
| `note` | Free text, up to 300 characters |
| `parts[]` | Rows of `[LDraw part, LDraw colour, count]`. A fourth item is the part's name, worth adding for parts the builder can't draw (not in `parts/shapes.json`). The same part and colour twice is added up; rows that don't fit are dropped |

Part numbers: the everyday number for a piece is accepted as well as LDraw's current one. BrickLink and Rebrickable write a 1x2 plate as `3023` and a round 1x1 plate as `4073`; the builder knows them as `3023b` and `6141`. `parts/aliases.json` lists these, and a number in it is read as the builder's whenever pieces are counted, in the page and in the designer skill's `check_model.py`. The lot is kept with the numbers it came with.

Links: `https://brickyard.junkdrawer.works/#l1z<data>` (deflated, base64url, like `#b1z`) or `#l1j<data>` uncompressed; `#l2z<data><check>` and `#l2j<data><check>` are the same with the check on the end (see Links above). Opening one shows the lot to review, then puts it in **Your pieces** under Build from your box, where it can be unticked or removed. Lots are saved in the catalog (`"loose": {id: lot}` in a backup, each with `t`, and `"del": 1` for a removed one), so backups and Drive sync carry them.

## A model (for Build from your box)

A model Claude designed from someone's pieces. The brickyard-designer skill writes these; its `check_model.py` checks one and makes the file and link.

```json
{"brickyard": 1, "model": {
  "name": "Lighthouse", "about": "A red and white lighthouse on a rocky base.", "sets": ["10698-1"],
  "parts": [["3001", 4, 0, 0, 0, 0, 1], ["3003", 15, 1, 3, 0, 90, 2]]}}
```

| Field | Meaning |
|---|---|
| `name` | Up to 80 characters; "Untitled model" if left out |
| `about` | One or two sentences shown with the model, up to 600 characters |
| `sets` | The set numbers whose pieces it was designed from, up to 50. One set number on its own (`"10698-1"`) is read as a list of one |
| `parts[]` | Rows of `[part, colour, x, y, z, turn, step]`, up to 5,000. Rows that don't fit are dropped |

In a row, `part` and `colour` are LDraw numbers (3001 is a 2x4 brick, 4 is red). `x` runs left to right and `z` back to front, in studs (-200 to 200); `y` runs up in plates (0 to 600; a brick is 3 plates). They give the back-left-bottom corner of the part's footprint after turning. `turn` is 0, 90, 180 or 270, and at 90 or 270 the part's width runs front to back. `step` is the building step it goes on in, from 1 (up to 2,000); with steps left out, each height is a step, bottom up. An everyday part number listed in `parts/aliases.json` is read as the builder's (3023 as 3023b), as for loose pieces above.

Links: `https://brickyard.junkdrawer.works/#d2z<data><check>` (deflated, base64url and checked, like `#b2z`) or `#d2j<data><check>` uncompressed; `#d1z<data>` and `#d1j<data>`, without the check, still open. `check_model.py` writes `#d2z`. Opening one saves the model in that browser under **Models**, checks it against the pieces ticked there (enough of each part in each colour, nothing overlapping, everything joined by studs, every step joining onto what's built), and shows it step by step. The model on its own, without the `{"brickyard": 1, "model": …}` wrapper, opens too when it's pasted or opened as a file.
