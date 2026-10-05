#!/usr/bin/env python3
"""Check a LEGO model against the pieces someone owns, show it layer by layer, and make a Brickyard link.

    python3 check_model.py model.json [--sets 10698-1 ...] [--data DIR] [--out DIR] [--layers] [--no-link]

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

It checks what Brickyard checks, the same way (js/build-core.js): every part is one the builder knows, there
are enough of each part in each colour, no two parts overlap, everything is joined by studs, and every step
joins onto what's already built. It exits 1 if anything fails. With --layers it prints each layer from above.
"""
import argparse, base64, json, sys, zlib
from pathlib import Path

HERE = Path(__file__).resolve().parent
DEFAULT_BASE = 'https://brickyard.junkdrawer.works/'


def find_data(arg):
    for d in ([Path(arg)] if arg else []) + [HERE.parent / 'data', HERE.parent.parent.parent / 'parts']:
        if (d / 'shapes.json').exists():
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
    return {'name': text(m.get('name'), 80) or 'Untitled model', 'about': text(m.get('about'), 600),
            'sets': [text(str(v), 20) for v in m.get('sets') or [] if text(str(v), 20)][:50], 'parts': parts}


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
        return list(g.values())

    whole = groups([q['i'] for q in ok])
    if len(whole) > 1:
        whole.sort(key=len, reverse=True)
        for g in whole[1:]:
            problems.append(dict(kind='loose', parts=g, text=('A part isn’t' if len(g) == 1 else f'{len(g)} parts aren’t') + ' joined to the rest of the model'))
    steps = sorted({q['s'] for q in ok})
    if len(whole) == 1:
        for s in steps:
            g = groups([q['i'] for q in ok if q['s'] <= s])
            if len(g) > 1:
                g.sort(key=len, reverse=True)
                lone = [i for grp in g[1:] for i in grp if by_index[i]['s'] == s]
                if lone:
                    problems.append(dict(kind='order', step=s, parts=lone, text=f'Step {s} has parts with nothing to join to yet'))
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


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('file')
    ap.add_argument('--sets', nargs='*', help='sets whose pieces it may use (default: the model’s own "sets")')
    ap.add_argument('--data')
    ap.add_argument('--out', default='.')
    ap.add_argument('--base', default=DEFAULT_BASE)
    ap.add_argument('--layers', action='store_true')
    ap.add_argument('--no-link', action='store_true')
    a = ap.parse_args()
    data = find_data(a.data)
    shapes = json.loads((data / 'shapes.json').read_text())
    colors = json.loads((data / 'colors.json').read_text())
    model = clean_model(json.loads(Path(a.file).read_text(encoding='utf-8')))
    sets = a.sets if a.sets is not None else model['sets']
    sets = [s if '-' in s else s + '-1' for s in sets]
    pool = None
    if sets:
        pool = {}
        for s in sets:
            f = data / 'sets' / f'{s}.json'
            if not f.exists():
                sys.exit(f'No parts list for set {s} in {data / "sets"}.')
            for p, c, n in json.loads(f.read_text())['parts']:
                pool[f'{p}/{c}'] = pool.get(f'{p}/{c}', 0) + n
        model['sets'] = sets
    res = check(model, shapes, pool)
    cm = dict(w=res['size']['w'] * 0.8, d=res['size']['d'] * 0.8, h=round(res['size']['h'] * 0.32, 1))
    print(f'{model["name"]}: {res["pieces"]} pieces, {len(res["steps"])} steps, '
          f'{res["size"]["w"]}x{res["size"]["d"]} studs, {res["size"]["h"]} plates tall ({cm["w"]:g} x {cm["d"]:g} x {cm["h"]:g} cm)')
    if pool is None:
        print('NOTE: no sets given, so piece counts weren’t checked.')
    for p in res['problems']:
        print('PROBLEM: ' + p['text'] + f'  (parts {", ".join(str(i + 1) for i in p["parts"][:12])})')
    for n in res['notes']:
        print('NOTE: ' + n['text'])
    if a.layers:
        print(layers(model, shapes, colors))
    doc = {'brickyard': 1, 'model': model}
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    stem = ''.join(ch if ch.isalnum() else '-' for ch in model['name'].lower()).strip('-')[:40] or 'model'
    path = out / f'{stem}.brickyard-model.json'
    path.write_text(json.dumps(doc, ensure_ascii=False) + '\n', encoding='utf-8')
    print(f'File: {path}')
    if not a.no_link:
        c = zlib.compressobj(9, zlib.DEFLATED, -15)
        data = c.compress(json.dumps(doc, ensure_ascii=False, separators=(',', ':')).encode()) + c.flush()
        link = a.base + '#d1z' + base64.urlsafe_b64encode(data).decode().rstrip('=')
        print(f'Link ({len(link)} characters):')
        print(link)
    sys.exit(0 if res['ok'] else 1)


if __name__ == '__main__':
    main()
