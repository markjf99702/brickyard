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

## A backup

**Download a backup** in Brickyard's menu saves `{"brickyard": 1, "catalog": {"sets": {id: set}, "seen": {batch id: time}}}`. Each set also has `id`, `t` (last changed, in milliseconds) and `added` (date). `"del": 1` marks a removed set, kept so a merge doesn't bring it back. Opening a backup merges it set by set, newest change winning.
