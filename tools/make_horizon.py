#!/usr/bin/env python3
"""The terrain skyline around the site, for the observatory page.

  python3 tools/make_horizon.py docs/horizon.json [--cache DIR]

Stdlib only, so it runs on chord-gateway.  Downloads SRTM 1-arcsecond
tiles (AWS Terrain Tiles, "skadi" HGT format) around the site and, for
each azimuth, marches out along the ground from MIN_M to MAX_KM, keeping the
largest elevation angle of the terrain as seen from EYE_M above the
ground at the site.  Earth curvature and standard refraction
(coefficient REFRACTION_K) are included.

horizon.json holds, every STEP_DEG of azimuth (from north through
east), the skyline's altitude and the distance to the point that sets
it.  --cache keeps the tiles in DIR and reuses them.
"""

import argparse
import array
import gzip
import json
import math
import sys
import urllib.request
from pathlib import Path

SITE_LAT, SITE_LON = 49.32075144444, -119.62081125
EYE_M = 2.0
STEP_DEG = 0.5
STEP_M = 30.0
MIN_M = 300.0       # nearer terrain is DEM noise at this scale (a 30 m pixel set 10 deg of skyline)
MAX_KM = 80.0
REFRACTION_K = 0.13
EARTH_R = 6371000.0
URL = "https://s3.amazonaws.com/elevation-tiles-prod/skadi/{ns}{lat:02d}/{ns}{lat:02d}{ew}{lon:03d}.hgt.gz"
N = 3601                                    # samples per tile side (1 arcsecond)


class Dem:
    def __init__(self, cache):
        self.cache = Path(cache) if cache else None
        self.tiles = {}

    def tile(self, lat0, lon0):
        key = (lat0, lon0)
        if key not in self.tiles:
            url = URL.format(ns="N" if lat0 >= 0 else "S", lat=abs(lat0),
                             ew="E" if lon0 >= 0 else "W", lon=abs(lon0))
            name = url.rsplit("/", 1)[-1]
            path = self.cache / name if self.cache else None
            if path and path.exists():
                raw = path.read_bytes()
            else:
                with urllib.request.urlopen(url, timeout=300) as r:
                    raw = r.read()
                if path:
                    path.parent.mkdir(parents=True, exist_ok=True)
                    path.write_bytes(raw)
            a = array.array("h", gzip.decompress(raw))
            if sys.byteorder == "little":
                a.byteswap()                        # HGT is big-endian
            if len(a) != N * N:
                raise ValueError(f"{name}: {len(a)} samples, expected {N * N}")
            self.tiles[key] = a
        return self.tiles[key]

    def height(self, lat, lon):
        """Terrain height (m), bilinear; rows run north to south."""
        lat0, lon0 = math.floor(lat), math.floor(lon)
        t = self.tile(lat0, lon0)
        y = (lat0 + 1 - lat) * (N - 1)
        x = (lon - lon0) * (N - 1)
        r, c = min(int(y), N - 2), min(int(x), N - 2)
        fy, fx = y - r, x - c
        h00, h01 = t[r * N + c], t[r * N + c + 1]
        h10, h11 = t[(r + 1) * N + c], t[(r + 1) * N + c + 1]
        if min(h00, h01, h10, h11) < -1000:      # void (-32768)
            return None
        return (1 - fy) * ((1 - fx) * h00 + fx * h01) + fy * ((1 - fx) * h10 + fx * h11)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("out")
    ap.add_argument("--cache")
    a = ap.parse_args(argv)
    dem = Dem(a.cache)
    ground = dem.height(SITE_LAT, SITE_LON)
    h0 = ground + EYE_M
    r_eff = EARTH_R / (1 - REFRACTION_K)
    coslat = math.cos(math.radians(SITE_LAT))
    alts, dists = [], []
    n_az = round(360 / STEP_DEG)
    for i in range(n_az):
        az = math.radians(i * STEP_DEG)
        dn, de = math.cos(az), math.sin(az)
        best, best_d = -90.0, 0.0
        d = MIN_M
        while d <= MAX_KM * 1000:
            lat = SITE_LAT + math.degrees(d * dn / EARTH_R)
            lon = SITE_LON + math.degrees(d * de / (EARTH_R * coslat))
            h = dem.height(lat, lon)
            if h is not None:
                alt = math.degrees(math.atan2(h - h0 - d * d / (2 * r_eff), d))
                if alt > best:
                    best, best_d = alt, d
            d += STEP_M
        alts.append(round(best, 2))
        dists.append(round(best_d / 1000, 2))
    out = {
        "source": "SRTM 1-arcsecond (NASA/USGS), via AWS Terrain Tiles (Mapzen) skadi tiles",
        "observer": {"lat": SITE_LAT, "lon": SITE_LON, "ground_m": round(ground, 1), "eye_m": EYE_M},
        "min_km": MIN_M / 1000, "max_km": MAX_KM, "refraction_k": REFRACTION_K,
        "step_deg": STEP_DEG,
        "az0_deg": 0.0,
        "alt_deg": alts,
        "dist_km": dists,
    }
    with open(a.out, "w") as f:
        json.dump(out, f, separators=(",", ":"))
        f.write("\n")
    print(f"ground {ground:.1f} m; skyline {min(alts):.2f} to {max(alts):.2f} deg; "
          f"tiles {sorted(dem.tiles)}", file=sys.stderr)


if __name__ == "__main__":
    main()
