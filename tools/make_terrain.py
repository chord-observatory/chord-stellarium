#!/usr/bin/env python3
"""The real terrain around the site, for the observatory page's Landscape.

  python3 tools/make_terrain.py docs/terrain.png [--cache DIR]

Stdlib only.  Samples the SRTM 1-arcsecond tiles (as make_horizon.py
does) on a grid of N x N points HALF_M around the site, east and north
in metres, and writes them as an RGB PNG: the height in units of UNIT_M
above BASE_M is R * 256 + G.  Row 0 is the north edge.  skygl.js holds
the same constants (DEM).
"""

import argparse
import struct
import sys
import zlib

from make_horizon import Dem, SITE_LAT, SITE_LON, EARTH_R
import math

N = 512
HALF_M = 8000.0
BASE_M = 0.0
UNIT_M = 0.1


def png(path, n, rows):
    def chunk(kind, data):
        c = kind + data
        return struct.pack(">I", len(data)) + c + struct.pack(">I", zlib.crc32(c))
    raw = b"".join(b"\0" + r for r in rows)
    with open(path, "wb") as f:
        f.write(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", n, n, 8, 2, 0, 0, 0))
                + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("out")
    ap.add_argument("--cache")
    a = ap.parse_args(argv)
    dem = Dem(a.cache)
    coslat = math.cos(math.radians(SITE_LAT))
    rows, lo, hi = [], 1e9, -1e9
    for j in range(N):
        north = HALF_M - (j + 0.5) * 2 * HALF_M / N
        lat = SITE_LAT + math.degrees(north / EARTH_R)
        row = bytearray()
        for i in range(N):
            east = -HALF_M + (i + 0.5) * 2 * HALF_M / N
            h = dem.height(lat, SITE_LON + math.degrees(east / (EARTH_R * coslat)))
            if h is None:
                raise ValueError(f"void in the DEM at row {j}, column {i}")
            lo, hi = min(lo, h), max(hi, h)
            v = max(0, min(65535, round((h - BASE_M) / UNIT_M)))
            row += bytes((v >> 8, v & 255, 0))
        rows.append(bytes(row))
    png(a.out, N, rows)
    print(f"site {dem.height(SITE_LAT, SITE_LON):.1f} m; heights {lo:.0f} to {hi:.0f} m", file=sys.stderr)


if __name__ == "__main__":
    main()
