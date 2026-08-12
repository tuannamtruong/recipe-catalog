#!/usr/bin/env python3
"""The cooking-app icon, drawn from scratch and encoded for each platform.

Pure stdlib: a tiny RGBA raster with hard-edged fills, rendered large and
averaged down for antialiasing, then packed as a Windows .ico or an Apple
.icns. Imported by the platform bundlers in this folder.
"""
from __future__ import annotations

import struct
import zlib

BG = (198, 72, 47, 255)      # burnt orange plate
FG = (255, 250, 244, 255)    # warm white pot

ICO_SIZES = (16, 24, 32, 48, 64, 128, 256)

# ICNS chunk type -> pixel size. Apple accepts PNG payloads for all of these;
# the retina types are just a second name for the same pixel dimensions.
ICNS_TYPES = (
    ("icp4", 16),
    ("icp5", 32),
    ("ic11", 32),    # 16@2x
    ("icp6", 64),
    ("ic12", 64),    # 32@2x
    ("ic07", 128),
    ("ic13", 256),   # 128@2x
    ("ic08", 256),
    ("ic14", 512),   # 256@2x
    ("ic09", 512),
)


class _Canvas:
    """Tiny RGBA raster with hard-edged fills; antialiasing comes from
    rendering large and averaging down."""

    def __init__(self, n: int):
        self.n = n
        self.buf = bytearray(n * n * 4)

    def _put(self, x: int, y: int, color) -> None:
        i = (y * self.n + x) * 4
        self.buf[i : i + 4] = bytes(color)

    def rounded_rect(self, x0, y0, x1, y1, r, color) -> None:
        n = self.n
        for y in range(max(0, int(y0)), min(n, int(y1) + 1)):
            py = y + 0.5
            if not (y0 <= py <= y1):
                continue
            for x in range(max(0, int(x0)), min(n, int(x1) + 1)):
                px = x + 0.5
                if not (x0 <= px <= x1):
                    continue
                dx = max(x0 + r - px, 0.0, px - (x1 - r))
                dy = max(y0 + r - py, 0.0, py - (y1 - r))
                if dx * dx + dy * dy <= r * r:
                    self._put(x, y, color)

    def circle(self, cx, cy, rad, color) -> None:
        n = self.n
        for y in range(max(0, int(cy - rad)), min(n, int(cy + rad) + 1)):
            for x in range(max(0, int(cx - rad)), min(n, int(cx + rad) + 1)):
                dx, dy = x + 0.5 - cx, y + 0.5 - cy
                if dx * dx + dy * dy <= rad * rad:
                    self._put(x, y, color)


def render(size: int) -> bytes:
    """Top-down RGBA bytes for one icon size."""
    ss = 4 if size <= 64 else 2
    s = size * ss
    c = _Canvas(s)

    c.rounded_rect(0, 0, s, s, 0.215 * s, BG)
    # handles first so the body draws over their inner ends
    c.rounded_rect(0.10 * s, 0.500 * s, 0.24 * s, 0.585 * s, 0.030 * s, FG)
    c.rounded_rect(0.76 * s, 0.500 * s, 0.90 * s, 0.585 * s, 0.030 * s, FG)
    c.rounded_rect(0.20 * s, 0.440 * s, 0.80 * s, 0.780 * s, 0.090 * s, FG)
    c.rounded_rect(0.155 * s, 0.345 * s, 0.845 * s, 0.435 * s, 0.045 * s, FG)
    c.circle(0.50 * s, 0.315 * s, 0.055 * s, FG)

    # Downsample with premultiplied alpha so edges don't pick up dark fringes.
    src, out = c.buf, bytearray(size * size * 4)
    n = ss * ss
    for oy in range(size):
        for ox in range(size):
            sa = sr = sg = sb = 0
            for dy in range(ss):
                row = ((oy * ss + dy) * s + ox * ss) * 4
                for dx in range(ss):
                    i = row + dx * 4
                    a = src[i + 3]
                    if a:
                        sa += a
                        sr += src[i] * a
                        sg += src[i + 1] * a
                        sb += src[i + 2] * a
            j = (oy * size + ox) * 4
            if sa:
                out[j] = sr // sa
                out[j + 1] = sg // sa
                out[j + 2] = sb // sa
                out[j + 3] = sa // n
    return bytes(out)


def build_ico() -> bytes:
    """Multi-size Windows .ico (32bpp BGRA DIBs)."""
    images = []
    for size in ICO_SIZES:
        rgba = render(size)
        # DIB: 32bpp bottom-up BGRA, doubled height, plus a zeroed AND mask.
        rows = []
        for y in range(size - 1, -1, -1):
            row = bytearray()
            for x in range(size):
                i = (y * size + x) * 4
                row += bytes((rgba[i + 2], rgba[i + 1], rgba[i], rgba[i + 3]))
            rows.append(bytes(row))
        pixels = b"".join(rows)
        mask = b"\x00" * (((size + 31) // 32) * 4 * size)
        header = struct.pack(
            "<IiiHHIIiiII", 40, size, size * 2, 1, 32, 0, len(pixels), 0, 0, 0, 0
        )
        images.append((size, header + pixels + mask))

    out = struct.pack("<HHH", 0, 1, len(images))
    offset = 6 + 16 * len(images)
    entries, blobs = b"", b""
    for size, blob in images:
        dim = 0 if size >= 256 else size
        entries += struct.pack("<BBBBHHII", dim, dim, 0, 0, 1, 32, len(blob), offset)
        offset += len(blob)
        blobs += blob
    return out + entries + blobs


def _chunk(tag: bytes, data: bytes) -> bytes:
    return (struct.pack(">I", len(data)) + tag + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))


def build_png(size: int, rgba: bytes) -> bytes:
    """RGBA8 PNG, no filtering (the icon is flat colour; it compresses fine)."""
    raw = b"".join(
        b"\x00" + rgba[y * size * 4 : (y + 1) * size * 4] for y in range(size)
    )
    return (
        b"\x89PNG\r\n\x1a\n"
        + _chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
        + _chunk(b"IDAT", zlib.compress(raw, 9))
        + _chunk(b"IEND", b"")
    )


def build_icns() -> bytes:
    """Apple .icns holding a PNG per icon type."""
    pngs: dict[int, bytes] = {}
    chunks = b""
    for tag, size in ICNS_TYPES:
        if size not in pngs:
            pngs[size] = build_png(size, render(size))
        blob = pngs[size]
        chunks += tag.encode("ascii") + struct.pack(">I", len(blob) + 8) + blob
    return b"icns" + struct.pack(">I", len(chunks) + 8) + chunks
