#!/usr/bin/env python3
"""Turn a list of loose LEGO pieces into a Brickyard link and a .brickyard-loose.json file.

    python3 make_loose.py pieces.json [--out DIR] [--data DIR] [--no-link]

pieces.json:

{
  "name": "Blue tub",                    # what they call it; a recount under the same name replaces it
  "box": "14",                           # optional: the moving box it's packed in
  "note": "",                            # optional
  "parts": [                             # [part, colour, count] and, optionally, the part's name
    ["3001", 4, 12],                     # twelve red 2x4 bricks
    ["3020", "white", 7],                # a colour can be its LDraw name, as colors.json has it
    ["2780", 0, 40, "Technic Pin with Friction"]
  ]
}

Parts and colours are LDraw numbers (3001 is a 2x4 brick, 4 is red). A part the builder can't draw is kept, and
worth giving its name as the fourth item.

It reads the list the way Brickyard does (cleanLot in js/core.js) and, unlike the page, says what it did: every row
it leaves out is printed with the reason, and so is every row that was added to an earlier one for the same part
and colour. It gives the lot an id made from its name, so sending a recount of "Blue tub" replaces the Blue tub
they have instead of adding a second one (an "id" in the file is kept as it is). Then it writes
NAME.brickyard-loose.json to --out and prints the link. With no row it can read it writes nothing and exits 1.

Part shapes and colours come from the data/ folder beside scripts/ (in the Brickyard repo, from parts/); --data DIR
reads them from somewhere else.
"""
import argparse, base64, json, math, re, sys, zlib
from pathlib import Path

HERE = Path(__file__).resolve().parent
DEFAULT_BASE = 'https://brickyard.junkdrawer.works/'
LINK_WARN = 6000  # characters; check_model.py and the cataloger's make_brickyard.py use the same number and note
LONG_LINK = 'NOTE: this link is long. Lead with the file; some apps cut long links off.'


def find_data(arg):
    """The same folder check_model.py reads: --data, else the repo's parts/, else the skill's own data/."""
    for d in ([Path(arg)] if arg else []) + [HERE.parent.parent.parent / 'parts', HERE.parent / 'data']:
        if (d / 'shapes.json').exists() and (d / 'colors.json').exists():
            return d
    sys.exit('Can’t find shapes.json; pass --data with the folder holding shapes.json and colors.json.')


def as_js(v):
    """A number as the page would write it as text: 3001.0 in a file is 3001 there."""
    if isinstance(v, float) and math.isfinite(v) and v.is_integer() and abs(v) < 1e15:
        return int(v)
    return v


def s(v, n):
    """One line of text, at most n characters: s in js/core.js."""
    v = as_js(v)
    if isinstance(v, (bool, dict, list)) or v is None:
        return ''
    return re.sub(r'\s+', ' ', str(v)).strip()[:n].strip()


def para(v, n):
    if not isinstance(v, str):
        return ''
    v = re.sub(r'[ \t]+', ' ', v.replace('\r\n', '\n').replace('\r', '\n'))
    return re.sub(r'\n{3,}', '\n\n', v).strip()[:n]


def whole(v, lo, hi):
    """A whole number between lo and hi, read as whole in js/core.js reads one: a number is rounded, a half going
    up; text counts for the digits it starts with, commas and spaces left out; anything else is 0."""
    if isinstance(v, bool) or v is None:
        return 0
    if isinstance(v, (int, float)):
        if not math.isfinite(v):
            return 0
        f = math.floor(v)
        x = f + 1 if v - f >= 0.5 else f
    elif isinstance(v, str):
        m = re.match(r'\s*[+-]?[0-9]+', re.sub(r'[, ]', '', v))
        if not m:
            return 0
        x = int(m.group())
    else:
        return 0
    return max(lo, min(hi, x))


def part_num(v):
    t = s(v, 24).lower()
    return t if re.fullmatch(r'[a-z0-9]{1,24}', t) else ''


def colour_num(v):
    """An LDraw colour number from 0 to 99999, or -1: colourNum in js/core.js."""
    if isinstance(v, bool) or v is None:
        return -1
    if isinstance(v, (int, float)):
        if not math.isfinite(v) or v % 1:
            return -1
        n = int(v)
    elif isinstance(v, str) and re.fullmatch(r'[0-9]{1,5}', v):
        n = int(v)
    else:
        return -1
    return n if 0 <= n <= 99999 else -1


def colour_key(name):
    """A colour's name as it's looked up: lower case, single spaces, "gray" as "grey"."""
    return ' '.join(name.lower().replace('_', ' ').replace('gray', 'grey').split())


def name_key(name):
    return ''.join(ch for ch in name.casefold() if ch.isalnum())


def link_check(text):
    """The same as linkCheck in js/core.js and link_check in check_model.py: seven characters worked out from the
    rest of a link (FNV-1a, in base 36), which go on the end of a checked link (#l2z…)."""
    h = 2166136261
    for ch in text:
        h = ((h ^ ord(ch)) * 16777619) & 0xFFFFFFFF
    out = ''
    while h:
        h, r = divmod(h, 36)
        out = '0123456789abcdefghijklmnopqrstuvwxyz'[r] + out
    return out.rjust(7, '0')


def clean_lot(x, colours=None, say=None):
    """The lot as Brickyard keeps it (cleanLot in js/core.js, without the time), or None when no row can be read.
    `colours` maps a colour's name, in lower case, to its number, for rows that give a name; the page reads numbers
    only, so the number is what's written. `say(kind, text)` is told about each row left out ('DROPPED') and each
    row added to an earlier one ('NOTE')."""
    say = say or (lambda kind, text: None)
    if not isinstance(x, dict):
        return None
    by_key, parts = {}, []
    rows = x.get('parts')
    for i, r in enumerate((rows if isinstance(rows, list) else [])[:20000]):
        def drop(why, r=r):
            say('DROPPED', f'row {i + 1} {json.dumps(r, ensure_ascii=False)[:80]}: {why}')
        if not isinstance(r, list):
            drop('a row is [part, colour, count]')
            continue
        r = r + [None] * (4 - len(r))
        raw = r[0][:-4] if isinstance(r[0], str) and r[0].lower().endswith('.dat') else r[0]
        p = part_num(raw)
        col = r[1]
        if isinstance(col, str) and colours and not re.fullmatch(r'[0-9]{1,5}', col):
            col = colours.get(colour_key(col), col)
        c, n = colour_num(col), whole(r[2], 0, 100000)
        if not p:
            drop('the part isn’t an LDraw part number (letters and digits, like 3001 or 3023b)')
            continue
        if c < 0:
            drop('the colour isn’t an LDraw colour number or a colour’s name in colors.json (4 is red)')
            continue
        if n < 1:
            drop('the count isn’t a whole number of 1 or more')
            continue
        k = f'{p}/{c}'
        row = by_key.get(k)
        if row:
            was = row[2]
            row[2] = min(100000, row[2] + n)
            say('NOTE', f'row {i + 1}: {k} is listed more than once; the counts were added up ({was} + {n} = {row[2]}).')
            continue
        row = [p, c, n]
        nm = s(r[3], 60)
        if nm:
            row.append(nm)
        by_key[k] = row
        parts.append(row)
    if not parts:
        return None
    parts.sort(key=lambda r: (r[0], r[1]))
    name = s(x.get('name'), 80)
    key = s(x.get('id'), 40)
    if not key:
        # From the name, so a recount under the same name is the same lot. With no name there is nothing to go by
        # but what's in it.
        key = 'n' + link_check(name_key(name)) if name_key(name) else 'l' + link_check(json.dumps(parts, separators=(',', ':')))
    o = {'id': key, 'name': name or 'Loose pieces', 'parts': parts}
    box = s(x.get('box'), 40)
    if box:
        o['box'] = box
    note = para(x.get('note'), 300)
    if note:
        o['note'] = note
    return o


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('file', help='the loose pieces, as JSON')
    ap.add_argument('--data')
    ap.add_argument('--out', default='.')
    ap.add_argument('--base', default=DEFAULT_BASE)
    ap.add_argument('--no-link', action='store_true')
    a = ap.parse_args()
    data = find_data(a.data)
    shapes = json.loads((data / 'shapes.json').read_text(encoding='utf-8'))
    colors = json.loads((data / 'colors.json').read_text(encoding='utf-8'))
    try:
        aliases = json.loads((data / 'aliases.json').read_text(encoding='utf-8'))
    except (OSError, ValueError):
        aliases = {}
    try:
        src = json.loads(Path(a.file).read_text(encoding='utf-8'))
    except (OSError, ValueError) as e:
        sys.exit(f'Can’t read the pieces file {a.file}: {e}')
    if isinstance(src, dict) and isinstance(src.get('loose'), dict):
        src = src['loose']
    if not isinstance(src, dict) or not isinstance(src.get('parts'), list):
        sys.exit('Expected {"name": "Blue tub", "parts": [[part, colour, count], ...]}.')
    by_name = {}
    for code, v in colors.items():
        if isinstance(v, list) and v and isinstance(v[0], str) and code.isdigit():
            by_name.setdefault(colour_key(v[0]), int(code))
    said = {'DROPPED': [], 'NOTE': []}
    lot = clean_lot(src, by_name, lambda kind, text: said[kind].append(text))
    for text in said['DROPPED']:
        print('DROPPED: ' + text)
    if not lot:
        print('NOT READY: no row could be read, so no file was written and no link made.')
        sys.exit(1)
    for text in said['NOTE']:
        print('NOTE: ' + text)
    if not s(src.get('name'), 80):
        print('NOTE: no "name" given, so it is called “Loose pieces”. Give it the name they use for it (“Blue tub”): '
              'a recount under the same name then replaces it.')
    elif not s(src.get('id'), 40):
        print(f'NOTE: its id ({lot["id"]}) comes from the name “{lot["name"]}”. Send a recount under the same name and Brickyard replaces it.')
    pieces = sum(r[2] for r in lot['parts'])
    known = lambda p: aliases.get(p, p) in shapes if isinstance(aliases.get(p, p), str) else False
    usable = sum(r[2] for r in lot['parts'] if known(r[0]))
    print(f'{lot["name"]}: {pieces} piece{"s" if pieces != 1 else ""} of {len(lot["parts"])} kind{"s" if len(lot["parts"]) != 1 else ""}'
          + (f', in box {lot["box"]}' if lot.get('box') else '') + f'. The builder can use {usable} of them.')
    for r in lot['parts']:
        col = colors.get(str(r[1]))
        if not known(r[0]):
            print(f'NOTE: {r[0]}/{r[1]} ×{r[2]}' + (f' ({r[3]})' if len(r) > 3 else '') + ' isn’t a piece the builder can draw yet. It is kept, and counts once Brickyard learns its shape.'
                  + ('' if len(r) > 3 else ' Give its name as a fourth item so the list can say what it is.'))
        if not col:
            print(f'NOTE: colour {r[1]} ({r[0]}/{r[1]}) isn’t one of the LDraw colours in colors.json. Check it: a model can only use these pieces in a colour Brickyard knows.')
    doc = {'brickyard': 1, 'loose': lot}
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    stem = ''.join(ch if ch.isalnum() else '-' for ch in lot['name'].lower()).strip('-')[:40] or 'loose'
    path = out / f'{stem}.brickyard-loose.json'
    path.write_text(json.dumps(doc, ensure_ascii=False) + '\n', encoding='utf-8')
    print(f'File: {path}')
    if not a.no_link:
        c = zlib.compressobj(9, zlib.DEFLATED, -15)
        packed = c.compress(json.dumps(doc, ensure_ascii=False, separators=(',', ':')).encode()) + c.flush()
        body = base64.urlsafe_b64encode(packed).decode().rstrip('=')
        link = a.base + '#l2z' + body + link_check('l2z' + body)
        print(f'Link ({len(link)} characters):')
        print(link)
        if len(link) > LINK_WARN:
            print(LONG_LINK)
    if said['DROPPED']:
        n = len(said['DROPPED'])
        print(f'{n} row{"s were" if n != 1 else " was"} left out (above). Say so when you hand it over, or fix the list and run this again.')


if __name__ == '__main__':
    main()
