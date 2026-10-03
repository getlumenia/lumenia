#!/usr/bin/env python3
"""Regenerate the Lumenia browser-extension artwork: the toolbar and store icons and the small promo tile.

Setup, once, in any scratch virtualenv (Pillow and numpy are the only dependencies):
    python3 -m venv /tmp/lumenia-art && /tmp/lumenia-art/bin/pip install pillow numpy
Run, from anywhere:
    /tmp/lumenia-art/bin/python apps/extension/store/make-assets.py

Writes
    apps/extension/static/icons/icon-16.png, icon-32.png, icon-48.png, icon-128.png   (manifest icons)
    apps/extension/store/icon-128.png        (the store icon: the same art as icon-128)
    apps/extension/store/promo-440x280.png   (Chrome Web Store small promo tile, 24-bit, no alpha)

Why drawn and not resized
    The mark is the lit dot of the "i" in the wordmark, on the periwinkle field. It is the mark the site
    already ships as its favicon and PWA icon (apps/web/app/manifest.ts). brand.md asks for a hand-drawn
    mark, so the AI-rendered images in brand-kit-assets are not used. Each icon size is drawn on its own,
    with a larger dot at 16 px, so the toolbar icon stays legible instead of being a blurred downscale of
    the 512 px file. Colours are the Periwinkle tokens; the glow is the wordmark SVG's own `lumen` radial
    gradient, read from the SVG. The wordmark on the promo tile is painted from
    apps/web/public/brand-kit-assets/logo-wordmark-t.svg (it uses only the M, L, C and z path commands).
"""
from __future__ import annotations

import re
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

HERE = Path(__file__).resolve().parent
EXT = HERE.parent  # apps/extension
PUBLIC = EXT.parent / "web" / "public"
WORDMARK_SVG = PUBLIC / "brand-kit-assets" / "logo-wordmark-t.svg"
HEADLINE_FONT = PUBLIC / "fonts" / "sentient-500.woff2"
ICON_DIR = EXT / "static" / "icons"

# Periwinkle tokens (brand.md, apps/web/app/manifest.ts).
PAPER = (245, 243, 239)  # #F5F3EF
INK = (30, 27, 34)  # #1E1B22
ACCENT = (110, 95, 206)  # #6E5FCE
SOFT = (232, 227, 247)  # #E8E3F7
DOT = (255, 249, 230)  # the lit dot, as measured on the site favicon

# Output sizes: (canvas px, tile px inside the canvas, dot diameter, glow diameter), the last two as a share of
# the tile. The dot is larger at 16 px so it still reads as a lit dot in the toolbar. The 128 px icon is 96 px
# of art plus 16 px of transparent padding on every side, as the Chrome Web Store asks for its icon.
ICONS = (
    (16, 16, 0.40, 0.88),
    (32, 32, 0.36, 0.88),
    (48, 48, 0.32, 0.86),
    (128, 96, 0.28, 0.84),
)
CORNER = 0.23  # corner radius as a share of the tile side

SVG_TEXT = WORDMARK_SVG.read_text(encoding="utf-8")


def _rgb(hex_color: str) -> tuple[int, int, int]:
    h = hex_color.lstrip("#")
    return int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)


def _attrs(tag: str) -> dict[str, str]:
    return dict(re.findall(r'([\w-]+)="([^"]*)"', tag))


def _lumen_stops() -> list[tuple[float, tuple[int, int, int], float]]:
    """(offset, rgb, alpha) stops of the wordmark's own `lumen` radial gradient."""
    grad = re.search(r'<radialGradient id="lumen".*?</radialGradient>', SVG_TEXT, re.S)
    if grad is None:
        raise SystemExit("the wordmark SVG no longer defines the `lumen` gradient")
    stops = []
    for tag in re.findall(r"<stop[^>]*>", grad.group(0)):
        a = _attrs(tag)
        stops.append((float(a["offset"].rstrip("%")) / 100, _rgb(a["stop-color"]), float(a.get("stop-opacity", "1"))))
    return stops


LUMEN = _lumen_stops()


def solid(color: tuple[int, int, int], mask: Image.Image) -> Image.Image:
    """A layer of one colour whose alpha is `mask` (so it composites without a dark fringe)."""
    layer = Image.new("RGBA", mask.size, color + (0,))
    layer.putalpha(mask)
    return layer


def lumen_layer(w: int, h: int, cx: float, cy: float, radius: float) -> Image.Image:
    """The lumen gradient as an RGBA layer, centred on (cx, cy)."""
    ys, xs = np.mgrid[0:h, 0:w].astype(np.float32)
    t = np.hypot(xs + 0.5 - cx, ys + 0.5 - cy) / radius
    offs = [s[0] for s in LUMEN]
    chans = [np.interp(t, offs, [s[1][i] for s in LUMEN]) for i in range(3)]
    alpha = np.interp(t, offs, [s[2] for s in LUMEN]) * 255
    return Image.fromarray(np.clip(np.stack([*chans, alpha], axis=-1) + 0.5, 0, 255).astype(np.uint8))


def icon(px: int, art: int, dot: float, glow: float, ss: int = 16) -> Image.Image:
    """One lit-dot tile, drawn at ss x and reduced. `art` is the tile side, centred in a px by px canvas."""
    s = px * ss
    c = s / 2
    im = Image.new("RGBA", (s, s), ACCENT + (255,))
    im.alpha_composite(lumen_layer(s, s, c, c, glow * art * ss / 2))
    r = dot * art * ss / 2
    dot_mask = Image.new("L", (s, s), 0)
    ImageDraw.Draw(dot_mask).ellipse([c - r, c - r, c + r, c + r], fill=255)
    im.alpha_composite(solid(DOT, dot_mask))
    pad = (px - art) / 2 * ss
    tile = Image.new("L", (s, s), 0)
    ImageDraw.Draw(tile).rounded_rectangle([pad, pad, s - pad - 1, s - pad - 1], radius=art * ss * CORNER, fill=255)
    im.putalpha(tile)
    return im.resize((px, px), Image.Resampling.BOX)


def _flatten(d: str, steps: int = 20) -> list[list[tuple[float, float]]]:
    """Path data (absolute M, L, C, z only) to a list of polylines."""
    tokens = re.findall(r"[MLCz]|-?\d*\.?\d+(?:[eE][-+]?\d+)?", d)
    polys: list[list[tuple[float, float]]] = []
    cur: list[tuple[float, float]] = []
    last = (0.0, 0.0)
    cmd = ""
    i = 0
    while i < len(tokens):
        if tokens[i] in "MLCz":
            cmd = tokens[i]
            i += 1
            if cmd == "z":
                if cur:
                    polys.append(cur)
                    cur = []
                continue
        n = {"M": 2, "L": 2, "C": 6}[cmd]
        v = [float(x) for x in tokens[i : i + n]]
        i += n
        if cmd == "M":
            if cur:
                polys.append(cur)
            last = (v[0], v[1])
            cur = [last]
            cmd = "L"  # further pairs after an M are implicit lineto
        elif cmd == "L":
            last = (v[0], v[1])
            cur.append(last)
        else:
            p0, p1, p2, p3 = last, (v[0], v[1]), (v[2], v[3]), (v[4], v[5])
            for k in range(1, steps + 1):
                t = k / steps
                u = 1 - t
                cur.append(tuple(u**3 * p0[j] + 3 * u * u * t * p1[j] + 3 * u * t * t * p2[j] + t**3 * p3[j] for j in (0, 1)))
            last = p3
    if cur:
        polys.append(cur)
    return polys


def wordmark(width: int, ss: int = 3) -> Image.Image:
    """The wordmark, `width` px wide on a transparent background, painted from the SVG."""
    shapes = [
        (_rgb(fill), _flatten(d))
        for fill, d in re.findall(r'<path[^>]*?fill="(#[0-9A-Fa-f]{6})"[^>]*?d="([^"]+)"', SVG_TEXT)
    ]
    circles = [_attrs(t) for t in re.findall(r"<circle[^>]*>", SVG_TEXT)]
    xs = [x for _, polys in shapes for poly in polys for x, _ in poly]
    ys = [y for _, polys in shapes for poly in polys for _, y in poly]
    for c in circles:
        cx, cy, r = float(c["cx"]), float(c["cy"]), float(c["r"])
        xs += [cx - r, cx + r]
        ys += [cy - r, cy + r]
    x0, y0 = min(xs), min(ys)
    scale = width * ss / (max(xs) - x0)
    w = width * ss
    h = -(-int((max(ys) - y0) * scale) // ss) * ss  # round up to a multiple of ss

    def px(p: tuple[float, float]) -> tuple[float, float]:
        return (p[0] - x0) * scale, (p[1] - y0) * scale

    # Letters: a coverage mask. The SVG paints the counters of "e" and "a" in the paper colour; here they erase.
    cover = Image.new("L", (w, h), 0)
    cd = ImageDraw.Draw(cover)
    for rgb, polys in shapes:
        for poly in polys:
            cd.polygon([px(p) for p in poly], fill=255 if rgb == ACCENT else 0)
    layer = solid(ACCENT, cover)
    # Then the three circles, in SVG order: the lumen glow, the dot of the "i", and its highlight.
    for c in circles:
        cx, cy = px((float(c["cx"]), float(c["cy"])))
        r = float(c["r"]) * scale
        if c["fill"].startswith("url("):
            layer.alpha_composite(lumen_layer(w, h, cx, cy, r))
        else:
            m = Image.new("L", (w, h), 0)
            ImageDraw.Draw(m).ellipse([cx - r, cy - r, cx + r, cy + r], fill=round(255 * float(c.get("opacity", "1"))))
            layer.alpha_composite(solid(_rgb(c["fill"]), m))
    return layer.resize((width, h // ss), Image.Resampling.BOX)


def promo() -> Image.Image:
    """440 x 280: wordmark and a three-line headline on paper, the lit-dot tile on a soft circle."""
    w, h, k = 440, 280, 6
    img = Image.new("RGBA", (w * k, h * k), PAPER + (255,))
    cx, cy, circle_r, tile_px = 352, 140, 158, 132
    ImageDraw.Draw(img).ellipse(
        [(cx - circle_r) * k, (cy - circle_r) * k, (cx + circle_r) * k, (cy + circle_r) * k], fill=SOFT + (255,)
    )
    # The tile, with a soft periwinkle shadow.
    n = tile_px * k
    left, top = round((cx - tile_px / 2) * k), round((cy - tile_px / 2) * k)
    blur, drop, pad = 12 * k, 9 * k, 36 * k
    shadow = Image.new("L", (n + 2 * pad, n + 2 * pad), 0)
    ImageDraw.Draw(shadow).rounded_rectangle([pad, pad, pad + n - 1, pad + n - 1], radius=n * CORNER, fill=85)
    img.alpha_composite(solid(ACCENT, shadow.filter(ImageFilter.GaussianBlur(blur))), (left - pad, top + drop - pad))
    img.alpha_composite(icon(n, n, 0.28, 0.84, ss=2), (left, top))
    # The text block on the left, centred on its ink.
    wm = wordmark(132 * k)
    font = ImageFont.truetype(str(HEADLINE_FONT), 40 * k)
    line_h, gap = round(40 * 1.12 * k), 18 * k
    block = Image.new("RGBA", (w * k // 2, wm.height + gap + line_h * 3 + 20 * k), (0, 0, 0, 0))
    block.alpha_composite(wm, (0, 0))
    bd = ImageDraw.Draw(block)
    baseline = wm.height + gap + font.getmetrics()[0]
    for i, line in enumerate(("Send", "dollars", "by link")):
        bd.text((0, baseline + i * line_h), line, font=font, fill=INK, anchor="ls")
    ink = block.getchannel("A").point(lambda a: 255 if a > 128 else 0).getbbox()
    block = block.crop((0, ink[1], block.width, ink[3]))
    img.alpha_composite(block, (34 * k, (h * k - block.height) // 2))
    return img.resize((w, h), Image.Resampling.LANCZOS).convert("RGB")


def main() -> None:
    ICON_DIR.mkdir(parents=True, exist_ok=True)
    for px, art, dot, glow in ICONS:
        im = icon(px, art, dot, glow)
        im.save(ICON_DIR / f"icon-{px}.png", optimize=True)
        if px == 128:
            im.save(HERE / "icon-128.png", optimize=True)
    promo().save(HERE / "promo-440x280.png", optimize=True)
    repo = EXT.parent.parent
    for p in sorted([*ICON_DIR.glob("icon-*.png"), HERE / "icon-128.png", HERE / "promo-440x280.png"]):
        with Image.open(p) as im:
            print(f"{p.relative_to(repo)}  {im.size[0]}x{im.size[1]}  {im.mode}")


if __name__ == "__main__":
    main()
