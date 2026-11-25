#!/usr/bin/env python3
"""Builds the whale-tail activity sprites (app/assets/whale/) from the drawn
originals in tool/whale_src/ (1.webp still, 2-4.gif loops; blue line art on a
white, non-transparent background).

Run from app/:

    python3 tool/make_whale_sprites.py [--preview out.png]

Needs ImageMagick 7 (`magick`) and numpy.

What it does, per source:

1. Key out the white: every pixel is modelled as `alpha * ink + (1 - alpha) *
   white`, with `ink` the source's own line colour (median of its darkest
   pixels). Alpha is the least-squares fit of the pixel's distance from white
   onto the ink's distance from white, so anti-aliased edges and the motion
   trails of 4.gif keep their partial coverage. The output is white RGB +
   that alpha: a mask the app tints at run time (`BlendMode.srcIn`).
2. Line every animation up on one anchor: the base of the two stems (where
   the tail leaves the water). All four drawings share a stroke width
   (~17 px) and scale, so they keep their size; one translation per animation
   (never per frame, so nothing jitters) puts each stem base on the same
   point, and switching speed levels leaves the stems in place.
3. Fit the union of every frame of every animation into one frame size with
   a small margin, downscale (Lanczos, on the alpha only) and pack each
   animation into a 6-column grid.

Writes whale_<level>.png and whale.json (frame size, columns, per-level frame
count and frame duration).
"""

import argparse
import json
import pathlib
import subprocess
import sys

import numpy as np

HERE = pathlib.Path(__file__).resolve().parent
SRC = HERE / 'whale_src'
OUT = HERE.parent / 'assets' / 'whale'

# Output frame: wider than tall because 3.gif's flat pose spans ~1.3x the
# tail's height; a square frame would shrink every tail by about a fifth.
FRAME_W, FRAME_H = 120, 96
MARGIN = 3  # output px kept clear on every side
COLUMNS = 6
SOURCES = [(1, '1.webp'), (2, '2.gif'), (3, '3.gif'), (4, '4.gif')]

# Below this the pixel is paper (GIF dither, WebP ringing), not ink.
ALPHA_FLOOR = 0.02


def magick(*args, data=None):
    return subprocess.run(
        ['magick', *map(str, args)], input=data, capture_output=True, check=True
    ).stdout


def load_frames(path):
    """Coalesced RGB frames (n, h, w, 3) in 0..1 and per-frame delays (ms)."""
    info = magick('identify', '-format', '%w %h %T\n', path).decode().split('\n')
    info = [line.split() for line in info if line.strip()]
    w, h = int(info[0][0]), int(info[0][1])
    delays = [int(line[2]) * 10 for line in info]
    raw = magick(path, '-coalesce', '-alpha', 'off', '-depth', '8', 'rgb:-')
    frames = np.frombuffer(raw, np.uint8).reshape(len(info), h, w, 3)
    return frames.astype(np.float64) / 255, delays


def key_out_white(frames):
    """Alpha (n, h, w) of the ink over white, see the module docstring."""
    dist = 1 - frames  # distance from white, per channel
    darkness = dist.mean(-1)
    ink_pixels = dist[darkness > 0.3]
    top = ink_pixels[ink_pixels.mean(-1) >= np.quantile(ink_pixels.mean(-1), 0.8)]
    ink = np.median(top, axis=0)
    alpha = (dist @ ink) / (ink @ ink)
    alpha = np.clip(alpha, 0, 1)
    alpha[alpha < ALPHA_FLOOR] = 0
    return alpha, 1 - ink


def stem_base(alpha):
    """(x, y) of the stems' bottom: centre of the solid ink in the lowest 8%
    of each frame's drawing, averaged over the frames."""
    xs, ys = [], []
    for a in alpha:
        sy, sx = np.nonzero(a > 0.5)
        top, bottom = sy.min(), sy.max()
        sel = sy >= bottom - 0.08 * (bottom - top)
        xs.append(sx[sel].mean())
        ys.append(bottom)
    return float(np.mean(xs)), float(np.mean(ys))


def union_box(alpha):
    """(x0, y0, x1, y1) covering every frame's ink, inclusive."""
    covered = (alpha > 0).any(axis=0)
    ys, xs = np.nonzero(covered)
    return xs.min(), ys.min(), xs.max(), ys.max()


def downscale(canvas, w, h):
    """Lanczos resize of one alpha plane to w×h (through 16-bit gray).

    Raw gray is read and written little-endian unless told otherwise, so the
    byte order is pinned on both sides (a swap survives a plain round trip
    and only shows up as noise once pixels are mixed)."""
    ch, cw = canvas.shape
    data = (np.clip(canvas, 0, 1) * 65535).round().astype('>u2').tobytes()
    out = magick(
        '-endian', 'MSB', '-size', f'{cw}x{ch}', '-depth', '16', 'gray:-',
        '-filter', 'Lanczos', '-resize', f'{w}x{h}!',
        '-endian', 'MSB', '-depth', '16', 'gray:-', data=data,
    )
    return np.frombuffer(out, '>u2').reshape(h, w).astype(np.float64) / 65535


def write_rgba(alpha, path):
    """White RGB + alpha PNG (colour type 6)."""
    h, w = alpha.shape
    rgba = np.empty((h, w, 4), np.uint8)
    rgba[..., :3] = 255
    rgba[..., 3] = np.clip(alpha * 255 + 0.5, 0, 255).astype(np.uint8)
    magick(
        '-size', f'{w}x{h}', '-depth', '8', 'rgba:-',
        '-define', 'png:color-type=6', '-strip', f'PNG32:{path}',
        data=rgba.tobytes(),
    )


def preview(levels, originals, path):
    """One row per level: the original first frame (as drawn, on white), then
    six keyed frames tinted like the app does on the light page (DeepSeek
    blue) and the same six on the dark page (its lightened variant)."""
    themes = (((0xF0, 0xF4, 0xFD), (0x4D, 0x6B, 0xFE)),
              ((0x1C, 0x1F, 0x28), (0x7A, 0x98, 0xFB)))
    gap = np.full((FRAME_H, 12, 3), 128.0)
    rows = []
    for frames, original in zip(levels, originals):
        picks = np.linspace(0, len(frames) - 1, min(6, len(frames))).round().astype(int)
        picks = list(picks) + [picks[-1]] * (6 - len(picks))
        row = [original * 255, gap]
        for bg, ink in themes:
            for i in picks:
                a = frames[i][..., None]
                row.append(a * np.array(ink) + (1 - a) * np.array(bg))
            row.append(gap)
        rows.append(np.concatenate(row[:-1], axis=1))
        rows.append(np.full((6, rows[-1].shape[1], 3), 128.0))
    image = np.concatenate(rows[:-1], axis=0)
    h, w, _ = image.shape
    magick('-size', f'{w}x{h}', '-depth', '8', 'rgb:-', '-scale', '200%', path,
           data=np.clip(image + 0.5, 0, 255).astype(np.uint8).tobytes())


def main():
    parser = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    parser.add_argument('--preview', help='also write a tinted contact sheet')
    args = parser.parse_args()

    loaded = []
    for level, name in SOURCES:
        frames, delays = load_frames(SRC / name)
        alpha, ink = key_out_white(frames)
        base = stem_base(alpha)
        x0, y0, x1, y1 = union_box(alpha)
        # Union box relative to the stem base.
        rel = (x0 - base[0], y0 - base[1], x1 - base[0], y1 - base[1])
        loaded.append((level, name, alpha, delays, base, rel, frames[0]))
        print(f'{name}: {len(alpha)} frames, ink #{"".join(f"{round(c * 255):02X}" for c in ink)}, '
              f'stem base ({base[0]:.1f}, {base[1]:.1f}), box {tuple(round(v) for v in rel)}',
              file=sys.stderr)

    # One placement for every animation: the union of all boxes, centred.
    left = min(r[0] for *_, r, _ in loaded)
    top = min(r[1] for *_, r, _ in loaded)
    right = max(r[2] for *_, r, _ in loaded)
    bottom = max(r[3] for *_, r, _ in loaded)
    scale = min((FRAME_W - 2 * MARGIN) / (right - left + 1),
                (FRAME_H - 2 * MARGIN) / (bottom - top + 1))
    # Source-space canvas that maps onto one output frame.
    canvas_w, canvas_h = FRAME_W / scale, FRAME_H / scale
    anchor_x = canvas_w / 2 - (left + right) / 2
    anchor_y = canvas_h / 2 - (top + bottom) / 2
    cw, ch = int(round(canvas_w)), int(round(canvas_h))
    print(f'scale {scale:.4f}, canvas {cw}x{ch}, stem base at '
          f'({anchor_x * scale:.1f}, {anchor_y * scale:.1f}) in the frame', file=sys.stderr)

    OUT.mkdir(parents=True, exist_ok=True)
    manifest = {
        'frameWidth': FRAME_W,
        'frameHeight': FRAME_H,
        'columns': COLUMNS,
        'levels': [],
    }
    previews, originals = [], []
    for level, name, alpha, delays, base, _, first in loaded:
        dx = int(round(anchor_x - base[0]))
        dy = int(round(anchor_y - base[1]))

        def place(plane, fill=0.0):
            """The plane on the shared canvas (clipped; the union fits)."""
            canvas = np.full((ch, cw), fill)
            h, w = plane.shape
            sx0, sy0 = max(0, -dx), max(0, -dy)
            tx0, ty0 = max(0, dx), max(0, dy)
            pw, ph = min(w - sx0, cw - tx0), min(h - sy0, ch - ty0)
            canvas[ty0:ty0 + ph, tx0:tx0 + pw] = plane[sy0:sy0 + ph, sx0:sx0 + pw]
            return canvas

        originals.append(np.stack([
            np.clip(downscale(place(first[..., c], 1.0), FRAME_W, FRAME_H), 0, 1)
            for c in range(3)
        ], axis=-1))
        frames = []
        for a in alpha:
            small = np.clip(downscale(place(a), FRAME_W, FRAME_H), 0, 1)
            small[small < 1 / 255] = 0  # Lanczos ringing outside the ink
            frames.append(small)
        previews.append(frames)

        rows = -(-len(frames) // COLUMNS)
        cols = min(COLUMNS, len(frames))
        sheet = np.zeros((rows * FRAME_H, cols * FRAME_W))
        for i, f in enumerate(frames):
            r, c = divmod(i, COLUMNS)
            sheet[r * FRAME_H:(r + 1) * FRAME_H, c * FRAME_W:(c + 1) * FRAME_W] = f
        image = f'whale_{level}.png'
        write_rgba(sheet, OUT / image)

        moving = [d for d in delays if d > 0]
        if len(set(moving)) > 1:
            sys.exit(f'{name}: uneven frame delays {sorted(set(moving))}')
        manifest['levels'].append({
            'level': level,
            'image': image,
            'frames': len(frames),
            'frameMs': moving[0] if len(frames) > 1 else 0,
            'source': name,
        })

    (OUT / 'whale.json').write_text(json.dumps(manifest, indent=2) + '\n')
    print(f'wrote {OUT}', file=sys.stderr)
    if args.preview:
        preview(previews, originals, args.preview)
        print(f'wrote {args.preview}', file=sys.stderr)


if __name__ == '__main__':
    main()
