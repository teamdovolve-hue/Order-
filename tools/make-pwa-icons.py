#!/usr/bin/env python3
"""
make-pwa-icons.py — build the PWA icon set from the restaurant logo.
[AI UPDATE 2026-09-24]

Usage (run from the repo root; needs Pillow:  pip install pillow):

    python3 tools/make-pwa-icons.py "new pizza hut logo.png"

Writes into icons/:
    icon-192.png            manifest icon, purpose "any"
    icon-512.png            manifest icon, purpose "any"
    icon-maskable-512.png   manifest icon, purpose "maskable" (logo kept inside the safe zone)
    apple-touch-icon.png    180x180 (iOS home screen — must be opaque)

With NO argument it draws a simple placeholder pizza icon instead, so the PWA is
installable before the real logo is dropped in. Re-run with the logo to replace it.

The logo is placed on a solid background. The colour is taken from the logo's
top-left pixel when the logo is opaque there, otherwise the app's dark #1A1E29.
Override with:  --bg "#RRGGBB"
"""
import argparse
import glob
import os
import sys

from PIL import Image, ImageDraw

DEFAULT_BG = (26, 30, 41)  # #1A1E29 — matches <meta name="theme-color">
OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "icons")


def hex_to_rgb(h):
    h = h.lstrip("#")
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def placeholder(size=1024):
    """Simple pizza slice on the dark app background (temporary stand-in)."""
    img = Image.new("RGBA", (size, size), DEFAULT_BG + (255,))
    d = ImageDraw.Draw(img)
    s = size / 1024
    # crust arc (top), cheese triangle, pepperoni
    d.polygon([(512 * s, 900 * s), (262 * s, 262 * s), (762 * s, 262 * s)], fill=(245, 166, 35, 255))
    d.rounded_rectangle([222 * s, 190 * s, 802 * s, 300 * s], radius=55 * s, fill=(200, 134, 26, 255))
    for cx, cy, r in ((450, 400, 48), (580, 470, 44), (512, 620, 42), (470, 520, 26)):
        d.ellipse([(cx - r) * s, (cy - r) * s, (cx + r) * s, (cy + r) * s], fill=(190, 45, 35, 255))
    return img


def flatten(logo, bg):
    canvas = Image.new("RGBA", logo.size, bg + (255,))
    canvas.alpha_composite(logo)
    return canvas


def fit_on_square(logo, size, fill_ratio, bg):
    """Centre `logo` on a size x size square of colour bg, occupying fill_ratio of it."""
    canvas = Image.new("RGBA", (size, size), bg + (255,))
    target = int(size * fill_ratio)
    w, h = logo.size
    scale = target / max(w, h)
    resized = logo.resize((max(1, round(w * scale)), max(1, round(h * scale))), Image.LANCZOS)
    canvas.alpha_composite(resized, ((size - resized.width) // 2, (size - resized.height) // 2))
    return canvas


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("logo", nargs="?", help="path to the logo PNG (omit for a placeholder)")
    ap.add_argument("--bg", help="background colour, e.g. #1A1E29")
    args = ap.parse_args()

    # [AI UPDATE v3] No argument → auto-pick the logo from attached_assets/ (e.g. "new pizzaa hut.png").
    if not args.logo:
        root = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "attached_assets")
        hits = [f for f in glob.glob(os.path.join(root, "*.png"))
                if "pizz" in os.path.basename(f).lower() and "hut" in os.path.basename(f).lower()]
        if hits:
            args.logo = sorted(hits)[0]
            print("using logo:", os.path.basename(args.logo))

    if args.logo:
        if not os.path.isfile(args.logo):
            sys.exit(f"Logo not found: {args.logo}")
        logo = Image.open(args.logo).convert("RGBA")
        if args.bg:
            bg = hex_to_rgb(args.bg)
        else:
            px = logo.getpixel((0, 0))
            bg = px[:3] if px[3] == 255 else DEFAULT_BG
        # A logo that is already a full-bleed opaque square needs no padding on "any" icons.
        opaque_square = logo.getpixel((0, 0))[3] == 255 and logo.width == logo.height
        any_ratio = 1.0 if opaque_square else 0.88
        mask_ratio = 0.70  # maskable safe zone = central 80% circle → keep the mark well inside
        src_any = src_mask = logo
    else:
        bg = hex_to_rgb(args.bg) if args.bg else DEFAULT_BG
        src_any = src_mask = placeholder()
        any_ratio, mask_ratio = 1.0, 0.70

    os.makedirs(OUT_DIR, exist_ok=True)

    def save(img, name, px):
        img.resize((px, px), Image.LANCZOS).convert("RGB").save(os.path.join(OUT_DIR, name), optimize=True)
        print("wrote icons/" + name, f"({px}x{px})")

    big_any = fit_on_square(src_any, 1024, any_ratio, bg)
    big_mask = fit_on_square(src_mask, 1024, mask_ratio, bg)
    save(big_any, "icon-192.png", 192)
    save(big_any, "icon-512.png", 512)
    save(big_mask, "icon-maskable-512.png", 512)
    save(big_any, "apple-touch-icon.png", 180)


if __name__ == "__main__":
    main()
