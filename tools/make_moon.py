#!/usr/bin/env python3
"""The Moon's near side, for the observatory page.

  python3 -I tools/make_moon.py lroc_color_poles_1k.jpg docs/moon.png

Needs Pillow.  The input is NASA's CGI Moon Kit colour map (Lunar
Reconnaissance Orbiter camera mosaic; Scientific Visualization Studio,
https://svs.gsfc.nasa.gov/4720; public domain): 1024 x 512, simple
cylindrical, longitude 0 (the middle of the near side) at the centre.
The output is the disc as seen from the Earth, north up, N x N with a
transparent surround, stretched so the bright highlands are near white.
"""

import math
import sys

from PIL import Image

N, SS = 256, 3


def main(src, out):
    m = Image.open(src).convert("RGB")
    w, h = m.size
    px = m.load()
    big = N * SS
    img = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    o = img.load()
    vals = []
    for j in range(big):
        y = 1 - 2 * (j + 0.5) / big
        for i in range(big):
            x = 2 * (i + 0.5) / big - 1
            if x * x + y * y >= 1:
                continue
            z = math.sqrt(1 - x * x - y * y)
            lat, lon = math.asin(y), math.atan2(x, z)
            c = px[min(w - 1, int((lon / (2 * math.pi) + 0.5) * w)), min(h - 1, int((0.5 - lat / math.pi) * h))]
            o[i, j] = (*c, 255)
            vals.append(max(c))
    vals.sort()
    k = 240 / vals[int(0.995 * len(vals))]
    img = img.resize((N, N), Image.LANCZOS)
    r, g, b, a = img.split()
    lift = lambda ch: ch.point(lambda v: min(255, round(255 * (min(1, v * k / 255) ** 0.85))))
    Image.merge("RGBA", (lift(r), lift(g), lift(b), a)).save(out, optimize=True)


if __name__ == "__main__":
    main(*sys.argv[1:3])
