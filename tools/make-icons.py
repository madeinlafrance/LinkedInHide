#!/usr/bin/env python3
"""Generate the toolbar icons from LinkedIn's own favicon.

Source: icons/linkedin-favicon.ico, downloaded from https://www.linkedin.com/favicon.ico
(24,838 bytes; frames at 16/24/32/64 px, 32bpp BMP). Refresh it with:

    curl -L -o icons/linkedin-favicon.ico https://www.linkedin.com/favicon.ico

Writes icons/{active,inactive}-{16,32,48,128}.png:
  active   - LinkedIn's mark unchanged
  inactive - the same mark desaturated to luminance grey

Pure stdlib: the ICO frames are 32bpp BMP, so we read RGBA directly and only
ever *encode* PNG (zlib) — no decoder and no Pillow needed.

    python3 tools/make-icons.py
"""

import os
import struct
import sys
import zlib

SIZES = (16, 32, 48, 128)
# Rec. 709 luminance, and a slight lift so the off state reads as muted rather
# than merely dark.
LUMA = (0.2126, 0.7152, 0.0722)
GREY_LIFT = 0.15


def read_ico(path):
    """Return {size: (w, h, bytearray RGBA)} for every frame in the .ico."""
    with open(path, "rb") as fh:
        data = fh.read()
    _, kind, count = struct.unpack("<HHH", data[:6])
    if kind != 1:
        raise SystemExit(f"{path}: not an icon file")
    frames = {}
    for i in range(count):
        w, h, _pal, _r, _planes, bpp, size, off = struct.unpack(
            "<BBBBHHII", data[6 + i * 16 : 22 + i * 16]
        )
        w, h = w or 256, h or 256
        if bpp != 32:
            continue
        blob = data[off : off + size]
        hdr = struct.unpack("<I", blob[:4])[0]  # BITMAPINFOHEADER size
        px = blob[hdr : hdr + w * h * 4]
        # BMP rows are bottom-up and BGRA; flip to top-down RGBA.
        rgba = bytearray(w * h * 4)
        for y in range(h):
            src = (h - 1 - y) * w * 4
            dst = y * w * 4
            for x in range(0, w * 4, 4):
                b, g, r, a = px[src + x : src + x + 4]
                rgba[dst + x : dst + x + 4] = bytes((r, g, b, a))
        frames[w] = (w, h, rgba)
    if not frames:
        raise SystemExit(f"{path}: no 32bpp frames")
    return frames


def resize(src, sw, sh, dw, dh):
    """Bilinear resize, premultiplied so edges don't halo against transparency."""
    pm = [0.0] * (sw * sh * 4)
    for i in range(sw * sh):
        a = src[i * 4 + 3] / 255.0
        pm[i * 4 + 0] = src[i * 4 + 0] * a
        pm[i * 4 + 1] = src[i * 4 + 1] * a
        pm[i * 4 + 2] = src[i * 4 + 2] * a
        pm[i * 4 + 3] = src[i * 4 + 3]

    out = bytearray(dw * dh * 4)
    for y in range(dh):
        fy = min(max((y + 0.5) * sh / dh - 0.5, 0), sh - 1)
        y0 = int(fy)
        y1 = min(y0 + 1, sh - 1)
        wy = fy - y0
        for x in range(dw):
            fx = min(max((x + 0.5) * sw / dw - 0.5, 0), sw - 1)
            x0 = int(fx)
            x1 = min(x0 + 1, sw - 1)
            wx = fx - x0
            acc = [0.0] * 4
            for (yy, wgt_y) in ((y0, 1 - wy), (y1, wy)):
                for (xx, wgt_x) in ((x0, 1 - wx), (x1, wx)):
                    w = wgt_y * wgt_x
                    if w <= 0:
                        continue
                    base = (yy * sw + xx) * 4
                    for c in range(4):
                        acc[c] += pm[base + c] * w
            a = acc[3]
            o = (y * dw + x) * 4
            if a <= 0.5:
                out[o : o + 4] = b"\x00\x00\x00\x00"
                continue
            scale = 255.0 / a
            for c in range(3):
                out[o + c] = min(255, max(0, round(acc[c] * scale)))
            out[o + 3] = min(255, max(0, round(a)))
    return out


def desaturate(rgba):
    out = bytearray(rgba)
    for i in range(0, len(out), 4):
        if out[i + 3] == 0:
            continue
        lum = sum(out[i + c] * LUMA[c] for c in range(3))
        lum = lum + (255 - lum) * GREY_LIFT
        v = min(255, max(0, round(lum)))
        out[i] = out[i + 1] = out[i + 2] = v
    return out


def write_png(path, w, h, rgba):
    raw = b"".join(
        b"\x00" + bytes(rgba[y * w * 4 : (y + 1) * w * 4]) for y in range(h)
    )

    def chunk(tag, data):
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    with open(path, "wb") as fh:
        fh.write(
            b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw, 9))
            + chunk(b"IEND", b"")
        )


def main():
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    out = os.path.join(root, "icons")
    src = os.path.join(out, "linkedin-favicon.ico")
    if not os.path.exists(src):
        sys.exit(
            f"missing {src}\n"
            "  curl -L -o icons/linkedin-favicon.ico https://www.linkedin.com/favicon.ico"
        )

    frames = read_ico(src)
    for size in SIZES:
        # Prefer an exact frame; otherwise scale from the nearest larger one,
        # falling back to the largest available.
        if size in frames:
            w, h, rgba = frames[size]
        else:
            bigger = [s for s in sorted(frames) if s > size]
            pick = bigger[0] if bigger else max(frames)
            w, h, base = frames[pick]
            rgba = resize(base, w, h, size, size)
            w = h = size
        write_png(os.path.join(out, f"active-{size}.png"), w, h, rgba)
        write_png(os.path.join(out, f"inactive-{size}.png"), w, h, desaturate(rgba))
        print(f"wrote active-{size}.png / inactive-{size}.png")


if __name__ == "__main__":
    main()
