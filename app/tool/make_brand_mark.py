#!/usr/bin/env python3
"""Generates lib/ui/shell/brand_glyph.g.dart from the brand masters in assets/brand/.

Run from app/:

    python3 tool/make_brand_mark.py

The masters are plain SVG in the launcher's 108 grid: every path is `M x y` followed by
absolute `C` segments and `Z`; gradients use userSpaceOnUse (a radial one may carry a
`matrix(a 0 0 d e f)` gradientTransform). This script reads

    glyph-light.svg   colour glyph for light backgrounds   (paths + gradients)
    glyph-dark.svg    colour glyph for dark backgrounds    (gradients)
    tile.svg          the launcher tile                    (tile path + its gradient)

and writes the paths as `Path` builders, the gradients as `ui.Gradient`s, and the
measurements the widgets lay out with: the glyph's ink box, its aspect ratio and its
visual centre (the area centroid of the ink). Pure Python, no dependencies.
"""
import os
import re
import sys

APP = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(APP, 'assets', 'brand')
OUT = os.path.join(APP, 'lib', 'ui', 'shell', 'brand_glyph.g.dart')

NUM = r'-?\d+(?:\.\d+)?'


def read(name):
    return open(os.path.join(SRC, name), encoding='utf-8').read()


def paths(svg):
    out = {}
    for m in re.finditer(r'<path id="([^"]+)"[^>]*?\sd="([^"]+)"', svg):
        out[m.group(1)] = parse_d(m.group(2))
    return out


def parse_d(d):
    """[(x0, y0), [(c1, c2, p3), ...]] per subpath."""
    toks = re.findall(r'[MCZ]|' + NUM, d)
    subs, i, cur = [], 0, None
    while i < len(toks):
        t = toks[i]
        if t == 'M':
            cur = [(float(toks[i + 1]), float(toks[i + 2])), []]
            subs.append(cur)
            i += 3
        elif t == 'C':
            i += 1
            while i < len(toks) and toks[i] not in 'MCZ':
                v = [float(x) for x in toks[i:i + 6]]
                cur[1].append(((v[0], v[1]), (v[2], v[3]), (v[4], v[5])))
                i += 6
        elif t == 'Z':
            i += 1
        else:
            raise ValueError(f'unexpected token {t!r}: only M, C and Z are supported')
    return subs


def gradients(svg):
    out = {}
    for m in re.finditer(r'<(linear|radial)Gradient id="([^"]+)"([^>]*)>(.*?)</\1Gradient>', svg):
        kind, gid, attrs, body = m.groups()
        a = dict(re.findall(r'([\w-]+)="([^"]*)"', attrs))
        stops = [(float(o), c) for o, c in re.findall(r'<stop offset="([^"]+)" stop-color="(#[0-9A-Fa-f]{6})"/>', body)]
        g = dict(kind=kind, stops=stops)
        if kind == 'linear':
            g.update(p1=(float(a['x1']), float(a['y1'])), p2=(float(a['x2']), float(a['y2'])))
        else:
            g.update(c=(float(a['cx']), float(a['cy'])), r=float(a['r']))
            if 'gradientTransform' in a:
                v = [float(x) for x in re.findall(NUM, a['gradientTransform'])]
                if v[1] != 0 or v[2] != 0:
                    raise ValueError('only axis-aligned gradient transforms are supported')
                g['matrix'] = v
        out[gid] = g
    return out


def bez(p0, c1, c2, p3, t):
    mt = 1 - t
    return tuple(mt ** 3 * a + 3 * mt * mt * t * b + 3 * mt * t * t * c + t ** 3 * d
                 for a, b, c, d in zip(p0, c1, c2, p3))


def flatten(subs, n=256):
    polys = []
    for start, segs in subs:
        pts, cur = [], start
        for c1, c2, p3 in segs:
            pts += [bez(cur, c1, c2, p3, k / n) for k in range(n)]
            cur = p3
        polys.append(pts)
    return polys


def area_centroid(poly):
    a = cx = cy = 0.0
    for (x0, y0), (x1, y1) in zip(poly, poly[1:] + poly[:1]):
        k = x0 * y1 - x1 * y0
        a += k
        cx += (x0 + x1) * k
        cy += (y0 + y1) * k
    a /= 2
    return a, cx / (6 * a), cy / (6 * a)


def f(v):
    s = f'{v:.4f}'.rstrip('0').rstrip('.')
    return '0' if s in ('-0', '') else s


def dart_path(subs):
    lines = ['Path()']
    for (x, y), segs in subs:
        lines.append(f'    ..moveTo({f(x)}, {f(y)})')
        for (a, b), (c, d), (e, g) in segs:
            lines.append(f'    ..cubicTo({f(a)}, {f(b)}, {f(c)}, {f(d)}, {f(e)}, {f(g)})')
        lines.append('    ..close()')
    return '\n'.join(lines)


def dart_color(hexc):
    return f'Color(0xFF{hexc[1:].upper()})'


def dart_gradient(g):
    cols = ', '.join(dart_color(c) for _, c in g['stops'])
    stops = ', '.join(f(o) for o, _ in g['stops'])
    if g['kind'] == 'linear':
        (a, b), (c, d) = g['p1'], g['p2']
        return f'ui.Gradient.linear(Offset({f(a)}, {f(b)}), Offset({f(c)}, {f(d)}), const [{cols}], const [{stops}])'
    cx, cy = g['c']
    if 'matrix' in g:
        sa, _, _, sd, e, h = g['matrix']
        # gradient space (centre cx, cy, radius r) → grid, column-major
        m = [sa, 0, 0, 0, 0, sd, 0, 0, 0, 0, 1, 0, e, h, 0, 1]
        mat = ', '.join(f(v) for v in m)
        return (f'ui.Gradient.radial(Offset({f(cx)}, {f(cy)}), {f(g["r"])}, const [{cols}], const [{stops}], '
                f'TileMode.clamp, Float64List.fromList(const [{mat}]))')
    return f'ui.Gradient.radial(Offset({f(cx)}, {f(cy)}), {f(g["r"])}, const [{cols}], const [{stops}])'


def main():
    light, dark, tile = read('glyph-light.svg'), read('glyph-dark.svg'), read('tile.svg')
    p = paths(light)
    pt = paths(tile)
    gl, gd, gt = gradients(light), gradients(dark), gradients(tile)
    need = {'body': 'body', 'fin': 'fin-layer', 'belly': 'belly-layer', 'bubble': 'bubble-layer'}
    for key in need.values():
        if key not in p:
            sys.exit(f'glyph-light.svg: path id="{key}" missing')

    # ink box and visual centre: tail/body and bubble (the fin and belly lie inside the body)
    ink = flatten(p['body']) + flatten(p['bubble-layer'])
    xs = [x for poly in ink for x, _ in poly]
    ys = [y for poly in ink for _, y in poly]
    box = (min(xs), min(ys), max(xs), max(ys))
    tot = cx = cy = 0.0
    for poly in ink:
        a, x, y = area_centroid(poly)
        tot += a
        cx += a * x
        cy += a * y
    cx, cy = cx / tot, cy / tot
    w, h = box[2] - box[0], box[3] - box[1]

    out = f'''// GENERATED by tool/make_brand_mark.py from assets/brand/glyph-light.svg,
// glyph-dark.svg and tile.svg. Do not edit; change the masters and run the tool.
//
// The dsh-go glyph in the launcher's 108 grid: the same placement as the themed
// launcher layer (android/app/src/main/res/drawable/ic_launcher_monochrome.xml).

// dart format off
import 'dart:typed_data';
import 'dart:ui' as ui;
import 'dart:ui' show Color, Offset, Path, Rect, Shader, TileMode;

/// Paths, gradients and measurements of the brand glyph (see `brand_mark.dart`).
abstract final class BrandGlyph {{
  /// The glyph's ink box (tail, body and bubble).
  static const box = Rect.fromLTRB({f(box[0])}, {f(box[1])}, {f(box[2])}, {f(box[3])});

  /// Width / height of [box].
  static const aspect = {w / h:.6f};

  /// Visual centre: the area centroid of the ink, in the grid.
  static const centroid = Offset({f(cx)}, {f(cy)});

  /// The tile: the 72-unit visible square of the launcher icon.
  static const tileBox = Rect.fromLTWH(18, 18, 72, 72);

  /// Tail, fin and body as one shape: the silhouette.
  static final Path body = {dart_path(p['body'])};

  /// The fin, behind the tail's stem (drawn over [body] in the colour glyph).
  static final Path fin = {dart_path(p['fin-layer'])};

  /// The belly, in front of the stem (drawn over [body] in the colour glyph).
  static final Path belly = {dart_path(p['belly-layer'])};

  /// The bubble.
  static final Path bubble = {dart_path(p['bubble-layer'])};

  /// The tile's rounded square (the app icon's outline).
  static final Path tile = {dart_path(pt['tile'])};

  static final Shader tileFill = {dart_gradient(gt['tile-bg'])};

  /// Gradients of the colour glyph: for light backgrounds, then for dark ones.
  static final Shader tailLight = {dart_gradient(gl['tail'])};
  static final Shader finLight = {dart_gradient(gl['fin'])};
  static final Shader bellyLight = {dart_gradient(gl['belly'])};
  static final Shader bubbleLight = {dart_gradient(gl['bubble'])};
  static final Shader tailDark = {dart_gradient(gd['tail'])};
  static final Shader finDark = {dart_gradient(gd['fin'])};
  static final Shader bellyDark = {dart_gradient(gd['belly'])};
  static final Shader bubbleDark = {dart_gradient(gd['bubble'])};
}}
'''
    open(OUT, 'w', encoding='utf-8').write(out)
    print(f'wrote {os.path.relpath(OUT, APP)}: box {box}, aspect {w / h:.4f}, '
          f'centroid ({cx:.3f}, {cy:.3f}) = ({(cx - box[0]) / w:.4f}, {(cy - box[1]) / h:.4f}) of the box')


if __name__ == '__main__':
    main()
