#!/usr/bin/env python3
"""Reference positions from astropy, to test the page's astro.js against.

Writes astro_ref.json on stdout: for each test time, the local apparent
sidereal time at the site, and the topocentric altitude and azimuth
(no refraction) of the Sun, the Moon and a few fixed ICRS sources.
test_astro.mjs reads it.

Runs in choco's venv (astropy, offline IERS tables are fine: UT1-UTC
is under a second):

  ssh choco.site.chord-observatory.ca \\
    'env -u HDF5_PLUGIN_PATH /opt/choco/.venv/bin/python -' \\
    < astro_ref.py > astro_ref.json
"""

import json
import sys
import warnings

import astropy.utils.iers

astropy.utils.iers.conf.auto_download = False
astropy.utils.iers.conf.auto_max_age = None
warnings.filterwarnings("ignore")

import astropy.units as u
from astropy.coordinates import AltAz, EarthLocation, SkyCoord, get_body
from astropy.time import Time

# The site as kotekan records it (choco.observatory).
LAT, LON, HEIGHT = 49.32075144444, -119.62081125, 545.0

SOURCES = {
    "Tau A": (83.63308, 22.01450),
    "Cyg A": (299.86815, 40.73392),
    "Cas A": (350.86642, 58.81178),
    "Vir A": (187.70593, 12.39112),
    "Sgr A*": (266.41683, -29.00781),
    "Polaris": (37.95456, 89.26411),
}

TIMES = [
    "2000-01-01T12:00:00", "2010-06-21T03:30:00", "2020-03-15T18:45:10",
    "2026-10-29T17:00:00", "2026-10-30T10:59:20", "2026-11-15T06:00:00",
    "2026-11-15T20:00:00", "2026-12-21T08:12:00", "2027-03-20T15:01:00",
    "2027-06-21T11:30:00", "2027-09-23T00:00:00", "2028-02-29T23:59:00",
    "2030-07-04T04:04:04", "2035-01-01T00:00:00", "2026-11-20T13:37:00",
    "2026-11-24T02:15:00", "2026-11-28T19:40:00", "2026-12-03T09:05:00",
    "2026-12-08T22:30:00", "2026-12-13T12:00:00",
]


def main():
    site = EarthLocation.from_geodetic(LON * u.deg, LAT * u.deg, HEIGHT * u.m)
    src = SkyCoord([v[0] for v in SOURCES.values()] * u.deg,
                   [v[1] for v in SOURCES.values()] * u.deg, frame="icrs")
    out = {"site": {"lat": LAT, "lon": LON, "height_m": HEIGHT}, "times": []}
    for iso in TIMES:
        t = Time(iso, scale="utc")
        frame = AltAz(obstime=t, location=site)
        rec = {"utc": iso + "Z",
               "last_deg": float(t.sidereal_time("apparent", LON * u.deg).deg),
               "lmst_deg": float(t.sidereal_time("mean", LON * u.deg).deg)}
        for name in ("sun", "moon"):
            aa = get_body(name, t, site).transform_to(frame)
            rec[name] = {"alt": float(aa.alt.deg), "az": float(aa.az.deg),
                         "dist_km": float(aa.distance.to(u.km).value)}
        aa = src.transform_to(frame)
        rec["sources"] = {n: {"alt": float(a), "az": float(z)}
                          for n, a, z in zip(SOURCES, aa.alt.deg, aa.az.deg)}
        out["times"].append(rec)
    json.dump(out, sys.stdout, indent=1)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
