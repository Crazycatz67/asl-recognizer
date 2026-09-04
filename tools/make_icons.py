# One-off: generate the PWA icon set. Flat raised-hand mark in white on the
# app's cyan accent, rounded square for the normal icons, full-bleed with a
# centre safe-zone for the maskable one. Run:
#   python tools/make_icons.py
from PIL import Image, ImageDraw

OUT = "icons"

CYAN_TOP = (125, 211, 252)   # #7dd3fc
CYAN_BOT = (2, 132, 199)     # #0284c7
WHITE = (248, 250, 252, 255) # #f8fafc


def gradient(size):
    w, h = size, size
    base = Image.new("RGB", (w, h), CYAN_TOP)
    top = Image.new("RGB", (w, h), CYAN_TOP)
    bot = Image.new("RGB", (w, h), CYAN_BOT)
    mask = Image.new("L", (w, h))
    for y in range(h):
        for_row = int(255 * (y / (h - 1)))
        for x in range(w):
            mask.putpixel((x, y), for_row)
    return Image.composite(bot, top, mask)


def rounded_mask(size, radius):
    m = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(m)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return m


def draw_hand(img, scale, cx, cy):
    """A blunt raised-palm glyph, centred on (cx, cy), sized by `scale` (px ~ palm width)."""
    d = ImageDraw.Draw(img)
    pw = scale                     # palm width
    ph = scale * 0.92              # palm height
    fw = pw * 0.20                 # finger width
    gap = fw * 0.28
    palm_top = cy - ph * 0.10
    # palm
    d.rounded_rectangle(
        [cx - pw / 2, palm_top, cx + pw / 2, palm_top + ph],
        radius=fw * 0.9, fill=WHITE,
    )
    # four fingers
    finger_span = fw * 4 + gap * 3
    fx0 = cx - finger_span / 2
    heights = [0.66, 0.80, 0.74, 0.58]
    for i, hf in enumerate(heights):
        x0 = fx0 + i * (fw + gap)
        fh = ph * hf
        d.rounded_rectangle(
            [x0, palm_top - fh + fw * 0.4, x0 + fw, palm_top + ph * 0.25],
            radius=fw / 2, fill=WHITE,
        )
    # thumb, angled off the lower-left
    d.rounded_rectangle(
        [cx - pw / 2 - fw * 0.65, cy + ph * 0.10,
         cx - pw / 2 + fw * 0.55, cy + ph * 0.10 + fw * 3.0],
        radius=fw / 2, fill=WHITE,
    )


def build(size, radius_frac, hand_frac, path):
    base = gradient(size).convert("RGBA")
    if radius_frac:
        m = rounded_mask(size, int(size * radius_frac))
        out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        out.paste(base, (0, 0), m)
    else:
        out = base
    draw_hand(out, size * hand_frac, size / 2, size / 2)
    out.save(path)
    print("wrote", path, size)


if __name__ == "__main__":
    import os
    os.makedirs(OUT, exist_ok=True)
    build(512, 0.18, 0.42, f"{OUT}/icon-512.png")
    build(192, 0.18, 0.42, f"{OUT}/icon-192.png")
    build(512, 0.0, 0.34, f"{OUT}/icon-maskable-512.png")  # full-bleed, hand in safe zone
    build(180, 0.0, 0.44, f"{OUT}/apple-touch-icon.png")   # iOS masks its own corners
