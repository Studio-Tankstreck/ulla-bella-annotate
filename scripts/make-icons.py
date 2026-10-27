#!/usr/bin/env python3
"""Generate the Ulla-Bella extension icons (grey inactive + green active).

Pure stdlib PNG writer (no Pillow). Draws a solid square with a white "U".
- icon{16,32,48,128}.png       -> grey  (#9CA3AF): default / inactive state
- icon{16,32,48,128}-active.png  -> green (#55ac5f): active (paired Site on tab)

These are temporary beta artwork — replace with final artwork before public
launch (Task 14, Part 17).

Usage:  python3 scripts/make-icons.py
Output: extension/icons/icon{16,32,48,128}.png (+ -active variants)
"""
import struct
import zlib
from pathlib import Path

GREY = (156, 163, 175)   # #9CA3AF — inactive (not a configured Site)
GREEN = (85, 172, 95)     # #55ac5f — active (this page is your configured Site)
FG = (255, 255, 255)


def png_chunk(tag, data):
    return (struct.pack(">I", len(data)) + tag + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))


def write_png(path, size, img):
    raw = b"".join(
        b"\x00" + b"".join(struct.pack("BBBB", *px) for px in row)
        for row in img
    )
    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)  # 8-bit RGBA
    png = (b"\x89PNG\r\n\x1a\n"
           + png_chunk(b"IHDR", ihdr)
           + png_chunk(b"IDAT", zlib.compress(raw, 9))
           + png_chunk(b"IEND", b""))
    Path(path).write_bytes(png)


def draw_icon(size, bg):
    img = [[bg + (255,) for _ in range(size)] for _ in range(size)]
    m = size / 16.0
    stroke = max(1, int(round(2.0 * m)))
    left = int(round(3.5 * m))
    right = int(round(12.5 * m))
    top = int(round(3.5 * m))
    cy = int(round(10.0 * m))            # center y of the bottom arc
    cx = (left + right) // 2
    ro = (right - left) // 2             # outer arc radius
    ri = max(1, ro - stroke)             # inner arc radius

    def paint(x, y):
        if 0 <= x < size and 0 <= y < size:
            img[y][x] = FG + (255,)

    # Vertical bars (left + right), down to the arc center line.
    for y in range(top, cy + 1):
        for x in range(left, left + stroke):
            paint(x, y)
        for x in range(right - stroke, right):
            paint(x, y)

    # Bottom semicircular arc (annulus, lower half only).
    for y in range(cy, cy + ro + 1):
        dy = y - cy
        for x in range(cx - ro, cx + ro + 1):
            dx = x - cx
            d = (dx * dx + dy * dy) ** 0.5
            if ri <= d <= ro:
                paint(x, y)

    return img


def main():
    out = Path(__file__).resolve().parent.parent / "extension" / "icons"
    out.mkdir(parents=True, exist_ok=True)
    for size in (16, 32, 48, 128):
        write_png(out / f"icon{size}.png", size, draw_icon(size, GREY))
        write_png(out / f"icon{size}-active.png", size, draw_icon(size, GREEN))
        print(f"wrote {out / f'icon{size}.png'} + -active")


if __name__ == "__main__":
    main()
