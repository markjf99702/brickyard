#!/usr/bin/env python3
"""Check a LEGO model against the pieces someone owns, show it layer by layer, and make a Brickyard link.

    python3 check_model.py model.json [--pieces FILE ...] [--sets 10698-1 ... | --no-sets] [--data DIR] [--out DIR]
                                      [--layers] [--no-link] [--force]

Put the model file first: --sets and --pieces take everything that follows them. Part shapes, colours and each
set's parts list come from the data/ folder beside scripts/ (in the Brickyard repo, from parts/, which data/ is a
copy of); --data DIR reads them from somewhere else.

model.json:

{
  "name": "Lighthouse",
  "about": "A red and white lighthouse on a rocky base.",   # one or two sentences, shown with the model
  "sets": ["10698-1"],                                        # whose pieces it's built from
  "parts": [                                                  # [part, colour, x, y, z, turn, step]
    ["3001", 4, 0, 0, 0, 0, 1],                              # a red 2x4 brick at the origin, step 1
    ["3003", 15, 1, 3, 0, 90, 2]
  ]
}

x runs left to right and z back to front, both in studs; y runs up in plates (a brick is 3 plates, a plate 1).
A part's x, y, z is the back-left-bottom corner of its footprint after turning; turn is 0, 90, 180 or 270 and at
90 or 270 the part's width runs front to back. Parts and colours are LDraw numbers (3001 is a 2x4 brick, 4 is red).

The budget is the parts lists of the model's own "sets" (or of --sets, which replaces them; --no-sets for none),
plus every --pieces file:
- a loose-pieces lot (a .brickyard-loose.json file from Stud Finder or Brickyard) is added on top of the sets;
- a text file holding what "Copy my pieces for Claude" gave (part/colour ×count, …) is the whole budget: that
  list already counts the sets it names, so the model's own sets are left out (a NOTE says so). Sets given with
  --sets beside it are still added, with a WARNING.

A part number that is another number for a piece the builder knows (3023 for 3023b: aliases.json in the data
folder) is read as that piece, in the model and in the pieces, with a NOTE. The file and link carry the builder's.

It checks what Brickyard checks, the same way (js/build-core.js): every part is one the builder knows, there
are enough of each part in each colour, no two parts overlap, everything is joined by studs, and every step
joins onto what's already built. With --layers it prints each layer from above.

When everything passes it writes NAME.brickyard-model.json to --out, prints the link and exits 0. When anything
fails it prints the problems and NOT READY, writes no file, prints no link and exits 1. --force writes the file
and prints the link anyway (still exit 1), for looking at a broken model in Brickyard.
"""
import argparse, base64, json, math, re, sys, zlib
from pathlib import Path

HERE = Path(__file__).resolve().parent
DEFAULT_BASE = 'https://brickyard.junkdrawer.works/'
LINK_WARN = 6000  # characters; make_brickyard.py in the cataloger skill uses the same number and the same note
LONG_LINK = 'NOTE: this link is long. Lead with the file; some apps cut long links off.'


# Other numbers for the same piece, from aliases.json in the data folder (3023 is 3023b): the everyday number
# BrickLink and Rebrickable use, read as the one shapes.json knows, the same as canon in js/build-core.js. READ_AS
# collects each number that was read as another, for a NOTE.
ALIASES, READ_AS = {}, {}


def use_aliases(data):
    """Reads aliases.json from the data folder. A folder without one (a copy from before it existed) has none."""
    ALIASES.clear()
    READ_AS.clear()
    try:
        table = json.loads((Path(data) / 'aliases.json').read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return
    if isinstance(table, dict):
        ALIASES.update({k: v for k, v in table.items() if isinstance(v, str)})


def canon(p):
    if p in ALIASES:
        READ_AS[p] = ALIASES[p]
        return ALIASES[p]
    return p


def set_names(v):
    """A model's "sets" as a list of names, the same as cleanModel in js/build-core.js: a list of set numbers,
    or one set number on its own. The second value says whether it was something else, and so ignored."""
    if isinstance(v, str):
        v = [v]
    if not isinstance(v, list):
        return [], v is not None
    out = []
    for x in v:
        if isinstance(x, float) and x.is_integer() and abs(x) < 1e15:
            x = int(x)
        if isinstance(x, bool) or not isinstance(x, (str, int)):
            continue
        if isinstance(x, int) and abs(x) >= 1e15:  # the page drops a number that big too
            continue
        x = ' '.join(str(x).split())[:20]
        if x:
            out.append(x)
    return out[:50], False


def find_data(arg):
    """The folder of part shapes, colours and sets' parts lists: --data, else the Brickyard repo's parts/ when the
    skill is sitting in the repo (the copy the page reads), else the data/ folder that ships with the skill."""
    for d in ([Path(arg)] if arg else []) + [HERE.parent.parent.parent / 'parts', HERE.parent / 'data']:
        if (d / 'shapes.json').exists() and (d / 'colors.json').exists():
            return d
    sys.exit('Can’t find shapes.json; pass --data with the folder holding shapes.json, colors.json and sets/.')


def turn_size(sh, r):
    return (sh['d'], sh['w']) if r in (90, 270) else (sh['w'], sh['d'])


def turn_cell(sh, r, cx, cz):
    if r == 90:
        return sh['d'] - 1 - cz, cx
    if r == 180:
        return sh['w'] - 1 - cx, sh['d'] - 1 - cz
    if r == 270:
        return cz, sh['w'] - 1 - cx
    return cx, cz


def mask_cells(sh, mask):
    if mask == 'none':
        return []
    if mask in ('all', None):
        return [(cx, cz) for cx in range(sh['w']) for cz in range(sh['d'])]
    return [tuple(c) for c in mask]


def placed(sh, q):
    def turn(c):
        t = turn_cell(sh, q['r'], c[0], c[1])
        return (q['x'] + t[0], q['z'] + t[1])
    return {k: [turn(c) for c in mask_cells(sh, m)] for k, m in (('top', sh.get('top')), ('bot', sh.get('bot')), ('foot', 'all'))}


def clean_model(o):
    m = o.get('model', o) if isinstance(o, dict) else None
    if not isinstance(m, dict) or not isinstance(m.get('parts'), list):
        sys.exit('Expected {"parts": [[part, colour, x, y, z, turn, step], ...]}.')
    odd = []  # values that weren't whole numbers, for a warning: (part number, field, as written, as read)

    def num(v, lo, hi, i=None, field=''):
        # A whole number, read the way the page reads one (int in js/build-core.js): a number is rounded to the
        # nearest, a half going up (2.5 is 3, as Math.round has it; Python's round would make it 2); text counts
        # for the digits it starts with (parseInt); true and false aren't numbers; neither is one too big to be.
        if isinstance(v, bool):
            return None
        if isinstance(v, str):
            lead = re.match(r'\s*[+-]?[0-9]+', v)
            n = int(lead.group()) if lead else None
        elif isinstance(v, (int, float)):
            try:
                n = math.floor(v + 0.5)
            except (OverflowError, ValueError):  # infinity (1e999 in the file), or not a number
                return None
        else:
            return None
        if n is None:
            return None
        if i is not None and n != v and not isinstance(v, str):
            odd.append((i + 1, field, v, n))
        return n if lo <= n <= hi else None
    parts = []
    for i, q in enumerate(m['parts'][:5000]):
        if isinstance(q, dict):
            q = [q.get(k) for k in ('p', 'c', 'x', 'y', 'z', 'r', 's')]
        if not isinstance(q, list):
            continue
        q = (q + [None] * 7)[:7]
        p = ''.join(ch for ch in str(q[0] or '').lower().removesuffix('.dat') if ch.isalnum())[:20]
        c, x, y, z = num(q[1], 0, 100000, i, 'colour'), num(q[2], -200, 200, i, 'x'), num(q[3], 0, 600, i, 'y'), num(q[4], -200, 200, i, 'z')
        r = num(q[5], 0, 270, i, 'turn')
        r = 0 if r is None else r
        s = num(q[6], 1, 2000, i, 'step') or 0
        if not p or None in (c, x, y, z) or r % 90:
            print(f'WARNING: part #{i + 1} {q} left out: needs a part, colour, x, y, z and a turn of 0/90/180/270')
            continue
        parts.append([canon(p), c, x, y, z, r, s])
    for i, field, was, n in odd[:12]:
        print(f'WARNING: part #{i}: {field} {was:g} isn’t a whole number; read as {n}, as Brickyard reads it')
    if len(odd) > 12:
        print(f'WARNING: and {len(odd) - 12} more values that aren’t whole numbers')
    if not parts:
        sys.exit('No usable parts.')
    if any(not q[6] for q in parts):
        ys = sorted({q[3] for q in parts})
        for q in parts:
            if not q[6]:
                q[6] = ys.index(q[3]) + 1
    def text(v, n):
        return ' '.join(v.split())[:n] if isinstance(v, str) else ''
    sets, odd = set_names(m.get('sets'))
    if odd:
        print(f'WARNING: "sets" should be a list of set numbers, like ["10698-1"]; {json.dumps(m.get("sets"))[:60]} was ignored')
    return {'name': text(m.get('name'), 80) or 'Untitled model', 'about': text(m.get('about'), 600), 'sets': sets, 'parts': parts}


def check(model, shapes, pool):
    problems, notes, used = [], [], {}
    parts = [dict(i=i, p=q[0], c=q[1], x=q[2], y=q[3], z=q[4], r=q[5], s=q[6], sh=shapes.get(q[0])) for i, q in enumerate(model['parts'])]
    for q in parts:
        if not q['sh']:
            problems.append(dict(kind='part', parts=[q['i']], text=f'Part {q["p"]} isn’t one the builder knows yet'))
            continue
        k = f'{q["p"]}/{q["c"]}'
        used[k] = used.get(k, 0) + 1
    short = []
    for k in sorted(used):
        have = pool.get(k, 0) if pool is not None else float('inf')
        if used[k] > have:
            short.append(dict(key=k, need=used[k], have=have))
    for x in short:
        problems.append(dict(kind='count', key=x['key'], parts=[q['i'] for q in parts if f'{q["p"]}/{q["c"]}' == x['key']],
                             text=f'Needs {x["need"]} of {x["key"]}, you have {x["have"]}'))
    ok = [q for q in parts if q['sh']]
    for q in ok:
        q['cells'] = placed(q['sh'], q)
    space, clash = {}, set()
    for q in ok:
        for y in range(q['y'], q['y'] + q['sh']['h']):
            for c in q['cells']['foot']:
                key = (c[0], y, c[1])
                other = space.get(key)
                if other is not None and (other, q['i']) not in clash:
                    clash.add((other, q['i']))
                    problems.append(dict(kind='overlap', parts=[other, q['i']], text=f'Two parts are in the same place ({c[0]}, {y}, {c[1]})'))
                space[key] = q['i']
    stud_at, edges = {}, []
    for q in ok:
        for c in q['cells']['top']:
            stud_at.setdefault((c[0], q['y'] + q['sh']['h'], c[1]), []).append(q['i'])
    for q in ok:
        for c in q['cells']['bot']:
            for j in stud_at.get((c[0], q['y'], c[1]), []):
                edges.append((j, q['i']))
    by_index = {q['i']: q for q in ok}

    def groups(members):
        up = {i: i for i in members}
        def find(i):
            while up[i] != i:
                up[i] = up[up[i]]
                i = up[i]
            return i
        for a, b in edges:
            if a in up and b in up:
                up[find(a)] = find(b)
        g = {}
        for i in members:
            g.setdefault(find(i), []).append(i)
        # The biggest group first, and of two the same size the one holding the earliest-listed part, each
        # group's parts in the order they're listed: the same choice js/build-core.js makes.
        return sorted(g.values(), key=lambda grp: (-len(grp), grp[0]))

    whole = groups([q['i'] for q in ok])
    for g in whole[1:]:
        problems.append(dict(kind='loose', parts=g, text=('A part isn’t' if len(g) == 1 else f'{len(g)} parts aren’t') + ' joined to the rest of the model'))
    # Every step on the way holds together too. A step's parts are fine when their group, among everything built
    # so far, holds a part from an earlier step. A group made only of this step's parts hangs in the air, however
    # big it is. The first step has nothing earlier, so its biggest group starts the model.
    steps = sorted({q['s'] for q in ok})
    if len(whole) == 1:
        for n, s in enumerate(steps):
            lone = []
            for k, grp in enumerate(groups([q['i'] for q in ok if q['s'] <= s])):
                joined = any(by_index[i]['s'] < s for i in grp) if n else k == 0
                if not joined:
                    lone += grp
            if lone:
                problems.append(dict(kind='order', step=s, parts=sorted(lone), text=f'Step {s} has parts with nothing to join to yet'))
    # Worth knowing: a part pushed on from below, under something already built. One note for each step that has
    # any, in step order, with every such part of the step in the order they're listed.
    under = {}
    for a, b in edges:
        below, above = by_index[a], by_index[b]
        if below['s'] > above['s']:
            under.setdefault(below['s'], set()).add(below['i'])
    for s in sorted(under):
        notes.append(dict(kind='under', step=s, parts=sorted(under[s]), text=f'Step {s} pushes a part on from underneath'))
    size = dict(w=0, d=0, h=0)
    if ok:
        xs = [c[0] for q in ok for c in q['cells']['foot']]
        zs = [c[1] for q in ok for c in q['cells']['foot']]
        # Height is from the lowest part's underside to the highest top, wherever the model sits (it was measured
        # from y 0, so a model written starting at y 30 came out 30 plates taller than it is).
        size = dict(w=max(xs) + 1 - min(xs), d=max(zs) + 1 - min(zs), h=max(q['y'] + q['sh']['h'] for q in ok) - min(q['y'] for q in ok))
    return dict(ok=not problems, problems=problems, notes=notes, used=used, short=short, steps=steps, pieces=len(ok), size=size)


SIDES = {0: 'back', 90: 'right', 180: 'front', 270: 'left'}
ACROSS = {'back': 'front', 'right': 'left', 'front': 'back', 'left': 'right'}


def facing(sh, r):
    """Which way a part that isn't the same all round has been turned, for the layer key: where a slope's or a
    curve's high side is, and where an inverted slope's full-height side is (it overhangs the other way)."""
    side = SIDES.get(r, 'back')
    if sh.get('k') in ('slope', 'curve'):
        return f', high side {side}'
    if sh.get('k') == 'inv':
        return f', full side {side} (overhangs to the {ACROSS[side]})'
    return ''


def layers(model, shapes, colors):
    """The model from above, layer by layer (a layer is one plate high): one character per stud, the back row
    first, a letter per part, and a key of each part that starts on that layer. A run of layers on which nothing
    starts is one line."""
    cells = {}
    for i, q in enumerate(model['parts']):
        sh = shapes.get(q[0])
        if not sh:
            continue
        pq = dict(x=q[2], z=q[4], r=q[5])
        for y in range(q[3], q[3] + sh['h']):
            for c in placed(sh, pq)['foot']:
                cells[(c[0], y, c[1])] = (i, y == q[3])
    if not cells:
        return ''
    xs = [k[0] for k in cells]; zs = [k[2] for k in cells]; ys = sorted({k[1] for k in cells})
    names = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
    out = ['Layers from above. Each row runs left to right (x); the first row is the back (lowest z). A capital is a part '
           'that starts on that layer, lower case one carrying on up from below, a dot is empty.']
    quiet = []  # layers in a row on which nothing starts

    def fold():
        if quiet:
            out.append((f'Layer y={quiet[0]}' if len(quiet) == 1 else f'Layers y={quiet[0]} to {quiet[-1]}') + ': nothing new; the parts below carry on up')
            quiet.clear()
    for y in ys:
        here = {k: v for k, v in cells.items() if k[1] == y}
        starts = sorted({v[0] for v in here.values() if v[1]})
        if not starts:
            quiet.append(y)
            continue
        fold()
        label = {}
        for n, i in enumerate(sorted({v[0] for v in here.values()})):
            label[i] = names[n % 26]
        out.append(f'Layer y={y} (new: {len(starts)})')
        for z in range(min(zs), max(zs) + 1):
            row = ''
            for x in range(min(xs), max(xs) + 1):
                v = here.get((x, y, z))
                row += '.' if not v else (label[v[0]] if v[1] else label[v[0]].lower())
            out.append('  ' + row)
        for i in starts:
            q = model['parts'][i]
            col = colors.get(str(q[1]), [str(q[1])])[0]
            out.append(f'  {label[i]} = {shapes[q[0]]["n"]} ({q[0]}), {col}, turn {q[5]}{facing(shapes[q[0]], q[5])}, step {q[6]}')
    fold()
    return '\n'.join(out)


def read_pieces(path):
    """Pieces from a loose-pieces lot (JSON) or from pasted "My Brickyard pieces" text: {"part/colour": count},
    and which of the two it was ('lot' or 'text')."""
    try:
        text = Path(path).read_text(encoding='utf-8')
    except (OSError, ValueError) as e:
        sys.exit(f'Can’t read the pieces file {path}: {e}')
    pool = {}
    try:
        doc = json.loads(text)
    except ValueError:
        doc = None
    if isinstance(doc, dict):
        lot = doc.get('loose', doc)
        rows = lot.get('parts') if isinstance(lot, dict) else None
        if not isinstance(rows, list):
            sys.exit(f'{path}: no "parts" list of [part, colour, count] rows.')
        for r in rows:
            # The colour is up to five plain digits ("²" is a digit to isdigit, and int() then refused it), and a
            # count too big to be a number (1e999) is no count.
            if isinstance(r, list) and len(r) >= 3 and re.fullmatch(r'[0-9a-z]{1,24}', str(r[0]).lower()) and re.fullmatch(r'[0-9]{1,5}', str(r[1])):
                try:
                    n = int(r[2])
                except (TypeError, ValueError, OverflowError):
                    continue
                if n > 0:
                    k = f'{canon(str(r[0]).lower())}/{int(r[1])}'
                    pool[k] = pool.get(k, 0) + n
        return pool, 'lot'
    # "My Brickyard pieces, from …" starts with the names of the sets and lots the pieces came from, and a name can
    # look like a row: "Bricks 2/3 x 4" was counted as four of part 2 in colour 3. The rows are read from after that
    # line: from "Pieces the builder knows", which the page always writes next (so it still works when the text
    # arrives as one line), or else from the second line. Text that doesn't start that way is a bare list, read whole.
    rows = text
    if text.lstrip().startswith('My Brickyard pieces'):
        at = text.find('Pieces the builder knows')
        if at < 0:
            at = text.find('\n', text.find('My Brickyard pieces'))
        if at >= 0:
            rows = text[at:]
    for p, c, n in re.findall(r'\b([0-9a-z]{1,24})/([0-9]{1,5})\s*[×x]\s*([0-9]+)', rows):
        k = f'{canon(p)}/{int(c)}'
        pool[k] = pool.get(k, 0) + int(n)
    if not pool:
        sys.exit(f'{path}: no pieces found. Expected a loose-pieces file or "part/colour ×count" text.')
    return pool, 'text'


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('file', nargs='?', help='the model, as JSON. Put it first')
    ap.add_argument('--sets', nargs='*', help='sets whose pieces it may use, instead of the model’s own "sets"')
    ap.add_argument('--no-sets', action='store_true', help='count no set’s parts list: the --pieces files are the whole budget')
    ap.add_argument('--pieces', nargs='*', default=[], help='loose-pieces files to add, or a pasted "My Brickyard pieces" text file (the whole budget)')
    ap.add_argument('--data')
    ap.add_argument('--out', default='.')
    ap.add_argument('--base', default=DEFAULT_BASE)
    ap.add_argument('--layers', action='store_true')
    ap.add_argument('--no-link', action='store_true')
    ap.add_argument('--force', action='store_true', help='write the file and print the link even when the model has problems')
    a = ap.parse_args()
    if a.file is None:
        # --sets and --pieces take every word after them, the model file too when it comes last.
        files = [v for v in a.sets or [] if v.lower().endswith('.json') or Path(v).is_file()]
        hint = ''
        if files:
            hint = f' {files[-1]} came after --sets, which takes everything after it as set numbers.'
        elif a.pieces:
            hint = f' --pieces takes everything after it as pieces files ({", ".join(a.pieces)}), the model too.'
        sys.exit(f'No model file.{hint} Put the model first: check_model.py model.json --pieces pieces.txt')
    if a.no_sets and a.sets:
        sys.exit('--no-sets and --sets ' + ' '.join(a.sets) + ' can’t both be given.')
    data = find_data(a.data)
    shapes = json.loads((data / 'shapes.json').read_text())
    colors = json.loads((data / 'colors.json').read_text())
    use_aliases(data)
    try:
        src = json.loads(Path(a.file).read_text(encoding='utf-8'))
    except (OSError, ValueError) as e:
        sys.exit(f'Can’t read the model file {a.file}: {e}')
    model = clean_model(src)
    pieces = [(f,) + read_pieces(f) for f in a.pieces]
    pasted = [f for f, _, kind in pieces if kind == 'text']
    notes, warns = [], []
    if a.no_sets or a.sets is not None:
        sets = a.sets or []
        if sets and pasted:
            warns.append(f'{", ".join(sets)} counted on top of the pasted list in {pasted[0]}. A pasted list already includes the sets it names; '
                         'leave --sets out unless these are extra sets.')
    elif pasted:
        sets = []
        if model['sets']:
            notes.append(f'{pasted[0]} is a pasted “My Brickyard pieces” list, so it is the whole budget: '
                         f'the model’s own sets ({", ".join(model["sets"])}) weren’t added on top.')
    else:
        sets = model['sets']
    sets = [x if '-' in x else x + '-1' for x in sets]
    pool = None
    if sets:
        pool = {}
        for x in sets:
            f = data / 'sets' / f'{x}.json'
            if not f.exists():
                sys.exit(f'No parts list for set {x} in {data / "sets"}.')
            for p, c, n in json.loads(f.read_text())['parts']:
                pool[f'{canon(p)}/{c}'] = pool.get(f'{canon(p)}/{c}', 0) + n
        model['sets'] = sets
    for _, more, _ in pieces:
        pool = pool if pool is not None else {}
        for k, n in more.items():
            pool[k] = pool.get(k, 0) + n
    res = check(model, shapes, pool)
    cm = dict(w=res['size']['w'] * 0.8, d=res['size']['d'] * 0.8, h=round(res['size']['h'] * 0.32, 1))
    print(f'{model["name"]}: {res["pieces"]} pieces, {len(res["steps"])} steps, '
          f'{res["size"]["w"]}x{res["size"]["d"]} studs, {res["size"]["h"]} plates tall ({cm["w"]:g} x {cm["d"]:g} x {cm["h"]:g} cm)')
    if pool is None:
        print('NOTE: no sets or pieces given, so piece counts weren’t checked.')
    for w in warns:
        print('WARNING: ' + w)
    for c in sorted({q[1] for q in model['parts'] if str(q[1]) not in colors}):
        notes.append(f'colour {c} isn’t one of the LDraw colours in colors.json. Brickyard will show it grey, as “Colour {c}”, and nobody has pieces in it.')
    for was in sorted(READ_AS):
        notes.append(f'part {was} was read as {READ_AS[was]}, the number the builder knows that piece by.')
    for n in notes:
        print('NOTE: ' + n)
    for p in res['problems']:
        print('PROBLEM: ' + p['text'] + f'  (parts {", ".join(str(i + 1) for i in p["parts"][:12])})')
    for n in res['notes']:
        print('NOTE: ' + n['text'])
    if a.layers:
        print(layers(model, shapes, colors))
    doc = {'brickyard': 1, 'model': model}
    out = Path(a.out)
    stem = ''.join(ch if ch.isalnum() else '-' for ch in model['name'].lower()).strip('-')[:40] or 'model'
    path = out / f'{stem}.brickyard-model.json'
    if not res['ok']:
        n = len(res['problems'])
        if not a.force:
            print(f'NOT READY: {n} problem{"s" if n != 1 else ""}. No file was written and no link made. Fix the model and run this again.')
            if path.exists():
                print(f'NOTE: {path} is from an earlier run. It isn’t this model; don’t hand it over.')
            sys.exit(1)
        print(f'NOT READY: {n} problem{"s" if n != 1 else ""}. --force made the file and link anyway; Brickyard will show the same problems.')
    out.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(doc, ensure_ascii=False) + '\n', encoding='utf-8')
    print(f'File: {path}')
    if not a.no_link:
        c = zlib.compressobj(9, zlib.DEFLATED, -15)
        packed = c.compress(json.dumps(doc, ensure_ascii=False, separators=(',', ':')).encode()) + c.flush()
        link = a.base + '#d1z' + base64.urlsafe_b64encode(packed).decode().rstrip('=')
        print(f'Link ({len(link)} characters):')
        print(link)
        if len(link) > LINK_WARN:
            print(LONG_LINK)
    sys.exit(0 if res['ok'] else 1)


if __name__ == '__main__':
    main()
