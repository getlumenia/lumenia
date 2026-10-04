#!/usr/bin/env python3
"""Regenerate every Lumenia icon from one place: the extension's toolbar and store icons, the Chrome Web
Store promo tile, and the website's favicon, Apple touch icon and PWA icons.

Setup, once, in any scratch virtualenv (Pillow and numpy are the only dependencies):
    python3 -m venv /tmp/lumenia-art && /tmp/lumenia-art/bin/pip install pillow numpy
Run, from anywhere:
    /tmp/lumenia-art/bin/python apps/extension/store/make-assets.py

Writes
    apps/extension/static/icons/icon-16.png, icon-32.png, icon-48.png, icon-128.png   (manifest icons)
    apps/extension/store/icon-128.png        (the store icon: the same art as icon-128)
    apps/extension/store/promo-440x280.png   (Chrome Web Store small promo tile, 24-bit, no alpha)
    apps/web/app/favicon.ico                 (16, 32 and 48 px, each drawn for its size)
    apps/web/app/icon.png, apple-icon.png    (512 and 180 px, full bleed, no alpha)
    apps/web/public/icon-192.png, icon-512.png, icon-512-maskable.png   (the PWA manifest's icons)

The icon is the messenger (owner's decision, 2026-10-04: the main mascot, everywhere), on the
periwinkle field with a soft glow behind its head, rising from the bottom edge of the tile. It is cut
from apps/web/public/brand-kit-assets/mascot-messenger-cut.webp, the same cutout the site and the
extension already show. Two crops, both stopping well above the feet, where that cutout carries a small
maker's mark: head, envelope and body from 48 px up, and the face alone at 16 and 32 px, where the
envelope would only be a smudge. Each size is composed large and reduced once. Colours are the
Periwinkle tokens. The wordmark on the promo tile is painted from
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
WEB_APP = EXT.parent / "web" / "app"
MASCOT = PUBLIC / "brand-kit-assets" / "mascot-messenger-cut.webp"

# Periwinkle tokens (brand.md, apps/web/app/manifest.ts).
PAPER = (245, 243, 239)  # #F5F3EF
INK = (30, 27, 34)  # #1E1B22
ACCENT = (110, 95, 206)  # #6E5FCE
SOFT = (232, 227, 247)  # #E8E3F7

# Where the icons crop the 1024 px messenger cutout, as (left, top, width, height). The character sits in
# the box (238, 187, 563, 708); its maker's mark starts at 95% of that height, so both crops end above it.
RISE = (198, 157, 643, 643)  # head, envelope and body
FACE = (285, 165, 470, 470)  # the face, larger, for 16 and 32 px
GLOW = (207, 198, 245)  # a lighter periwinkle, behind the head

# Extension icons: (canvas px, tile px inside the canvas). The 128 px icon is 96 px of art plus 16 px of
# transparent padding on every side, as the Chrome Web Store asks for its icon.
ICONS = ((16, 16), (32, 32), (48, 48), (128, 96))
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


def glow_layer(w: int, h: int, cx: float, cy: float, radius: float) -> Image.Image:
    """A soft disc of GLOW, strongest at (cx, cy) and gone at `radius`."""
    ys, xs = np.mgrid[0:h, 0:w].astype(np.float32)
    t = np.clip(1 - np.hypot(xs + 0.5 - cx, ys + 0.5 - cy) / radius, 0, 1)
    layer = Image.new("RGBA", (w, h), GLOW + (0,))
    layer.putalpha(Image.fromarray((t**1.6 * 0.8 * 255 + 0.5).astype(np.uint8)))
    return layer


def icon(px: int, art: int | None = None, rounded: bool = True, scale: float = 0.96, crop: tuple | None = None) -> Image.Image:
    """The messenger on the periwinkle field, `px` square. `art` is the tile side, centred in the canvas;
    `rounded` clips it to the tile's rounded corners (off for icons an OS masks itself); `scale` is the
    mascot's width as a share of the tile, bottom-anchored so the body runs off the lower edge."""
    art = art or px
    crop = crop or (FACE if px <= 32 else RISE)
    a = max(art * 8, 512)  # compose large, reduce once
    tile = Image.new("RGBA", (a, a), ACCENT + (255,))
    tile.alpha_composite(glow_layer(a, a, a * 0.5, a * 0.34, a * 0.5))
    with Image.open(MASCOT) as src:
        x, y, w, h = crop
        m = src.convert("RGBA").crop((x, y, x + w, y + h))
    side = round(a * scale)
    tile.alpha_composite(m.resize((side, side), Image.Resampling.LANCZOS), ((a - side) // 2, a - side))
    if rounded:
        mask = Image.new("L", (a, a), 0)
        ImageDraw.Draw(mask).rounded_rectangle([0, 0, a - 1, a - 1], radius=a * CORNER, fill=255)
        tile.putalpha(mask)
    tile = tile.resize((art, art), Image.Resampling.LANCZOS)
    canvas = Image.new("RGBA", (px, px), (0, 0, 0, 0))
    canvas.alpha_composite(tile, ((px - art) // 2, (px - art) // 2))
    return canvas


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
    """440 x 280: wordmark and a three-line headline on paper; the messenger itself on the right, rising
    from the bottom edge in front of a soft circle and a glow, as the site's share image shows it."""
    w, h, k = 440, 280, 6
    img = Image.new("RGBA", (w * k, h * k), PAPER + (255,))
    cx, cy, circle_r = 332, 150, 146
    ImageDraw.Draw(img).ellipse(
        [(cx - circle_r) * k, (cy - circle_r) * k, (cx + circle_r) * k, (cy + circle_r) * k], fill=SOFT + (255,)
    )
    img.alpha_composite(glow_layer(w * k, h * k, cx * k, 92 * k, 120 * k))
    # The messenger, cut above its feet (RISE) and anchored to the bottom edge, so the cut never shows.
    with Image.open(MASCOT) as src:
        x, y, cw, ch = RISE
        m = src.convert("RGBA").crop((x, y, x + cw, y + ch))
    side = 226 * k
    img.alpha_composite(m.resize((side, side), Image.Resampling.LANCZOS), (cx * k - side // 2, h * k - side))
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
    for px, art in ICONS:
        im = icon(px, art)
        im.save(ICON_DIR / f"icon-{px}.png", optimize=True)
        if px == 128:
            im.save(HERE / "icon-128.png", optimize=True)
    promo().save(HERE / "promo-440x280.png", optimize=True)
    # The website. favicon.ico carries each size drawn for itself; the rest are full bleed, no alpha,
    # because iOS and the PWA launchers round or mask them themselves.
    ico = [icon(16), icon(32), icon(48)]
    ico[2].save(WEB_APP / "favicon.ico", sizes=[(16, 16), (32, 32), (48, 48)], append_images=ico[:2])
    icon(512, rounded=False).convert("RGB").save(WEB_APP / "icon.png", optimize=True)
    icon(180, rounded=False).convert("RGB").save(WEB_APP / "apple-icon.png", optimize=True)
    icon(192, rounded=False).convert("RGB").save(PUBLIC / "icon-192.png", optimize=True)
    icon(512, rounded=False).convert("RGB").save(PUBLIC / "icon-512.png", optimize=True)
    # Maskable: launchers may cut it to a circle 80% wide, so the messenger sits smaller and lower and
    # its head stays inside that circle.
    icon(512, rounded=False, scale=0.74).convert("RGB").save(PUBLIC / "icon-512-maskable.png", optimize=True)
    repo = EXT.parent.parent
    outs = [*ICON_DIR.glob("icon-*.png"), HERE / "icon-128.png", HERE / "promo-440x280.png", WEB_APP / "favicon.ico",
            WEB_APP / "icon.png", WEB_APP / "apple-icon.png", *PUBLIC.glob("icon-*.png")]
    for p in sorted(outs):
        with Image.open(p) as im:
            print(f"{p.relative_to(repo)}  {im.size[0]}x{im.size[1]}  {im.mode}")


if __name__ == "__main__":
    main()
