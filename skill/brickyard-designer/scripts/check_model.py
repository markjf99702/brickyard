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

It checks what Brickyard checks, the same way (js/build-core.js): every part is one the builder knows, there
are enough of each part in each colour, no two parts overlap, everything is joined by studs, and every step
joins onto what's already built. With --layers it prints each layer from above.

When everything passes it writes NAME.brickyard-model.json to --out, prints the link and exits 0. When anything
fails it prints the problems and NOT READY, writes no file, prints no link and exits 1. --force writes the file
and prints the link anyway (still exit 1), for looking at a broken model in Brickyard.
"""
import argparse, base64, json, re, sys, zlib
from pathlib import Path

HERE = Path(__file__).resolve().parent
DEFAULT_BASE = 'https://brickyard.junkdrawer.works/'


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
    def num(v, lo, hi):
        try:
            n = round(float(v))
        except (TypeError, ValueError):
            return None
        return n if lo <= n <= hi else None
    parts = []
    for i, q in enumerate(m['parts'][:5000]):
        if isinstance(q, dict):
            q = [q.get(k) for k in ('p', 'c', 'x', 'y', 'z', 'r', 's')]
        if not isinstance(q, list):
            continue
        q = (q + [None] * 7)[:7]
        p = ''.join(ch for ch in str(q[0] or '').lower().removesuffix('.dat') if ch.isalnum())[:20]
        c, x, y, z = num(q[1], 0, 100000), num(q[2], -200, 200), num(q[3], 0, 600), num(q[4], -200, 200)
        r = num(q[5], 0, 270)
        r = 0 if r is None else r
        s = num(q[6], 1, 2000) or 0
        if not p or None in (c, x, y, z) or r % 90:
            print(f'WARNING: part #{i + 1} {q} left out: needs a part, colour, x, y, z and a turn of 0/90/180/270')
            continue
        parts.append([p, c, x, y, z, r, s])
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
    seen = set()
    for a, b in edges:
        below, above = by_index[a], by_index[b]
        if below['s'] > above['s'] and below['s'] not in seen:
            seen.add(below['s'])
            notes.append(dict(kind='under', step=below['s'], parts=[below['i']], text=f'Step {below["s"]} pushes a part on from underneath'))
    size = dict(w=0, d=0, h=0)
    if ok:
        xs = [c[0] for q in ok for c in q['cells']['foot']]
        zs = [c[1] for q in ok for c in q['cells']['foot']]
        size = dict(w=max(xs) + 1 - min(xs), d=max(zs) + 1 - min(zs), h=max(q['y'] + q['sh']['h'] for q in ok))
    return dict(ok=not problems, problems=problems, notes=notes, used=used, short=short, steps=steps, pieces=len(ok), size=size)


def layers(model, shapes, colors):
    """Each plate-height layer from above: one character per stud, a letter per part (lower case where the part
    continues from a lower layer), and a key of what each letter is."""
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
    out = []
    for y in ys:
        here = {k: v for k, v in cells.items() if k[1] == y}
        starts = sorted({v[0] for v in here.values() if v[1]})
        label = {}
        for n, i in enumerate(sorted({v[0] for v in here.values()})):
            label[i] = names[n % 26]
        out.append(f'Layer y={y}' + (f' (new: {len(starts)})' if starts else ''))
        for z in range(min(zs), max(zs) + 1):
            row = ''
            for x in range(min(xs), max(xs) + 1):
                v = here.get((x, y, z))
                row += '.' if not v else (label[v[0]] if v[1] else label[v[0]].lower())
            out.append('  ' + row)
        for i in starts:
            q = model['parts'][i]
            col = colors.get(str(q[1]), [str(q[1])])[0]
            out.append(f'  {label[i]} = {shapes[q[0]]["n"]} ({q[0]}), {col}, turn {q[5]}, step {q[6]}')
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
            if isinstance(r, list) and len(r) >= 3 and re.fullmatch(r'[0-9a-z]{1,24}', str(r[0]).lower()) and str(r[1]).isdigit():
                try:
                    n = int(r[2])
                except (TypeError, ValueError):
                    continue
                if n > 0:
                    k = f'{str(r[0]).lower()}/{int(r[1])}'
                    pool[k] = pool.get(k, 0) + n
        return pool, 'lot'
    for p, c, n in re.findall(r'\b([0-9a-z]{1,24})/(\d{1,5})\s*[×x]\s*(\d+)', text):
        pool[f'{p}/{int(c)}'] = pool.get(f'{p}/{int(c)}', 0) + int(n)
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
                pool[f'{p}/{c}'] = pool.get(f'{p}/{c}', 0) + n
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
    sys.exit(0 if res['ok'] else 1)


if __name__ == '__main__':
    main()
