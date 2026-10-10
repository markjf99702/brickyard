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
| `num` | Set number. `10698`, `10698-1` and `#10698` all mean `10698-1` (Rebrickable's form: number, dash, version) |
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
https://brickyard.junkdrawer.works/#b1z<data>
```

`<data>` is the compact batch JSON, compressed with raw DEFLATE, then base64url-encoded without padding. `#b1j<data>` is the same without compression, and `#batch=<URL-encoded JSON>` can be written by hand. The part after `#` never reaches a server.

## Sizes (for the shelf planner)

```json
{"brickyard": 1, "sizes": [{"num": "10497", "w": 51, "d": 33, "h": 14, "note": "LEGO's measurements"}]}
```

Built sizes in cm for sets already in Brickyard: `w` across the front, `d` front to back, `h` tall, and an optional `note` (up to 200 characters). The link is `#z1z<data>` (`#z1j` uncompressed), made the same way as a batch link; `make_brickyard.py` makes it from a file like this. Opening it offers each size for the sets in My sets with that number, unticked where a set already has a size. It never adds sets.

## A backup

**Download a backup** in Brickyard's menu saves `{"brickyard": 1, "catalog": {"sets": {id: set}, "seen": {batch id: time}, "cases": {id: bookcase}}}`. Each set also has `id`, `t` (last changed, in milliseconds) and `added` (date). `"del": 1` marks a removed set, kept so a merge doesn't bring it back. Opening a backup merges it set by set, newest change winning. A bookcase is `{"id", "t", "name", "room", "w", "d", "levels": [{"h", "sets": [{"id", "turn"}]}]}`: inside width and depth in cm, and its shelves from the top down, each with its clear height and the sets on it left to right (`turn` when a set stands side-on). Bookcases merge the same way.

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

Links: `https://brickyard.junkdrawer.works/#l1z<data>` (deflated, base64url, like `#b1z`) or `#l1j<data>` uncompressed. Opening one shows the lot to review, then puts it in **Your pieces** under Build from your box, where it can be unticked or removed. Lots are saved in the catalog (`"loose": {id: lot}` in a backup, each with `t`, and `"del": 1` for a removed one), so backups and Drive sync carry them.
