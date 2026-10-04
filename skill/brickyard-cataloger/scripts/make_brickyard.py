#!/usr/bin/env python3
"""Turn a list of LEGO sets into a Brickyard batch: a link that opens it in Brickyard, and a file.

    python3 make_brickyard.py sets.json [--out DIR] [--base URL] [--no-link]

sets.json (every field is optional except a set number or a name):

{
  "name": "Office shelves",                       # shown when the batch is opened
  "room": "Office", "spot": "Top shelf",          # for any set that doesn't say its own
  "box": "",                                      # a moving-box label, for any set that doesn't say its own
  "state": "built",                               # built, partial, apart or sealed, for any set that doesn't say
  "sets": [
    {"num": "10698", "name": "Large Creative Brick Box", "year": 2015, "pieces": 790, "theme": "Classic",
     "state": "apart", "room": "Office", "spot": "Closet", "box": "7",
     "missing": "one red 2x4 brick", "instr": true, "size": {"w": 37, "d": 18, "h": 28},
     "tags": ["creative"], "notes": "",
     "unsure": "number read from a blurry corner"}  # anything you're not sure of, in a few words
  ]
}

Set numbers are normalised the way Rebrickable writes them ("10698" -> "10698-1"); a number that doesn't
look like a set number is dropped and flagged. State words like "assembled" or "new in box" are mapped
onto Brickyard's four. Likely doubles in the list are flagged. Exits 1 (printing why) if the input can't be used.
"""
import argparse, base64, datetime, hashlib, json, re, sys, zlib
from pathlib import Path

DEFAULT_BASE = 'https://brickyard.junkdrawer.works/'
STATES = {
    'built': 'built', 'assembled': 'built', 'complete': 'built', 'displayed': 'built', 'on display': 'built',
    'partial': 'partial', 'partly built': 'partial', 'partially built': 'partial', 'half built': 'partial', 'in progress': 'partial',
    'apart': 'apart', 'taken apart': 'apart', 'disassembled': 'apart', 'loose': 'apart', 'in bags': 'apart', 'broken down': 'apart',
    'sealed': 'sealed', 'new in box': 'sealed', 'nib': 'sealed', 'misb': 'sealed', 'unopened': 'sealed', 'new': 'sealed',
}
LINK_WARN = 6000


def s(v, n):
    if isinstance(v, (bool, dict, list)) or v is None:
        return ''
    return re.sub(r'\s+', ' ', str(v)).strip()[:n]


def para(v, n):
    if not isinstance(v, str):
        return ''
    v = re.sub(r'[ \t]+', ' ', v.replace('\r\n', '\n').replace('\r', '\n'))
    return re.sub(r'\n{3,}', '\n\n', v).strip()[:n]


def whole(v, lo, hi):
    if isinstance(v, bool):
        return 0
    if isinstance(v, (int, float)):
        x = int(round(v))
    else:
        m = re.search(r'-?\d+', str(v or '').replace(',', ''))
        x = int(m[0]) if m else 0
    return max(lo, min(hi, x))


def measure(v):
    try:
        x = float(str(v).replace(',', '.'))
    except (TypeError, ValueError):
        return 0
    return 0 if x <= 0 else min(500, round(x, 1))


def set_num(v):
    t = re.sub(r'\s+', '', re.sub(r'^(set|no\.?|#)\s*', '', s(v, 40).lower()))
    m = re.fullmatch(r'([0-9]{3,7}|[a-z]{1,8}[0-9]{2,7}[a-z]?)(?:-([0-9]{1,2}))?', t)
    if not m:
        return ''
    return m[1] + '-' + (str(int(m[2])) if m[2] else '1')


def state(v):
    return STATES.get(s(v, 30).lower(), '')


def tags(v):
    if isinstance(v, str):
        v = re.split(r'\s*[,;]\s*', v)
    out, seen = [], set()
    for x in v if isinstance(v, list) else []:
        x = s(x, 40)
        if x and x.lower() not in seen:
            seen.add(x.lower())
            out.append(x)
    return out[:12]


def clean(x, i, warn):
    if not isinstance(x, dict):
        warn.append(f'#{i + 1}: not a set object, left out')
        return None
    flags = [s(x.get('unsure') or x.get('check'), 300)]
    raw = s(x.get('num') or x.get('set') or x.get('number'), 40)
    num = set_num(raw)
    name = s(x.get('name') or x.get('title'), 160)
    if raw and not num:
        flags.append(f'set number read as {raw} doesn’t look like one, so it was left off')
        warn.append(f'“{name or raw}”: set number {raw} doesn’t look like a set number; dropped and flagged')
    if not num and not name:
        warn.append(f'#{i + 1}: no set number or name, left out')
        return None
    st = s(x.get('state') or x.get('status'), 30)
    if st and not state(st):
        warn.append(f'“{name or num}”: state “{st}” isn’t one Brickyard knows (built, partial, apart, sealed); left blank')
    out = {
        'num': num, 'name': name, 'year': whole(x.get('year'), 0, 2100), 'pieces': whole(x.get('pieces') or x.get('parts'), 0, 20000),
        'theme': s(x.get('theme'), 60), 'state': state(st), 'room': s(x.get('room'), 60), 'spot': s(x.get('spot') or x.get('shelf'), 60),
        'box': s(x.get('box'), 40), 'missing': para(x.get('missing'), 600), 'tags': tags(x.get('tags')), 'notes': para(x.get('notes'), 2000),
    }
    if out['year'] and out['year'] < 1949:
        out['year'] = 0
    instr = x.get('instr', x.get('instructions'))
    if isinstance(instr, bool):
        out['instr'] = instr
    size = x.get('size') if isinstance(x.get('size'), dict) else {}
    z = {k: measure(size.get(k)) for k in 'wdh'}
    if any(z.values()):
        out['size'] = z
    out['check'] = s('; '.join(f for f in flags if f), 300)
    return {k: v for k, v in out.items() if v not in ('', 0, [], None) or k == 'instr'}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('file')
    ap.add_argument('--out', default='.')
    ap.add_argument('--base', default=DEFAULT_BASE)
    ap.add_argument('--no-link', action='store_true')
    a = ap.parse_args()
    try:
        src = json.loads(Path(a.file).read_text(encoding='utf-8'))
    except (OSError, ValueError) as e:
        sys.exit(f'Can’t read {a.file}: {e}')
    if isinstance(src, list):
        src = {'sets': src}
    src = src.get('batch', src)
    if not isinstance(src, dict) or not isinstance(src.get('sets'), list):
        sys.exit('Expected {"sets": [...]} (or a plain list of sets).')
    warn = []
    sets = [y for y in (clean(x, i, warn) for i, x in enumerate(src['sets'])) if y]
    if not sets:
        sys.exit('No usable sets: each needs a set number or a name.')
    seen = {}
    for x in sets:
        k = x.get('num') or re.sub(r'[^a-z0-9]', '', x.get('name', '').lower())
        if k in seen:
            warn.append(f'“{x.get("name") or x.get("num")}” is in the list twice. Keep both only if there really are two copies.')
        seen[k] = 1
    batch = {'name': s(src.get('name'), 120), 'room': s(src.get('room'), 60), 'spot': s(src.get('spot') or src.get('shelf'), 60),
             'box': s(src.get('box'), 40), 'state': state(src.get('state')), 'sets': sets}
    batch = {k: v for k, v in batch.items() if v}
    body = json.dumps(sets, sort_keys=True, ensure_ascii=False)
    batch['id'] = 'p' + datetime.date.today().strftime('%Y%m%d') + '-' + hashlib.sha1(body.encode()).hexdigest()[:10]
    doc = {'brickyard': 1, 'batch': batch}
    text = json.dumps(doc, ensure_ascii=False, separators=(',', ':'))

    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    stem = re.sub(r'[^A-Za-z0-9]+', '-', batch.get('name') or 'sets').strip('-').lower()[:40] or 'sets'
    path = out / f'{stem}.brickyard.json'
    path.write_text(json.dumps(doc, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')

    print(f'{len(sets)} set{"s" if len(sets) != 1 else ""}' + (f' · {batch["name"]}' if batch.get('name') else ''))
    for x in sets:
        print(f'  {x.get("num", "?").removesuffix("-1"):>8}  {x.get("name", "")}' + (f'   [check: {x["check"]}]' if x.get('check') else ''))
    for w in warn:
        print('WARNING: ' + w)
    print(f'File: {path}')
    if not a.no_link:
        c = zlib.compressobj(9, zlib.DEFLATED, -15)
        data = c.compress(text.encode('utf-8')) + c.flush()
        link = a.base + '#b1z' + base64.urlsafe_b64encode(data).decode().rstrip('=')
        print(f'Link ({len(link)} characters):')
        print(link)
        if len(link) > LINK_WARN:
            print('NOTE: this link is long. Lead with the file; some apps cut long links off.')


if __name__ == '__main__':
    main()
