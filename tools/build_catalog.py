#!/usr/bin/env python3
"""Build the observatory's catalog.json from public catalogues.

  python3 build_catalog.py <webroot>/observatory/catalog.json [--cache DIR]

Stdlib only, so it runs on chord-gateway.  It downloads:

- 3CRR (Laing, Riley & Longair 1983; the online catalogue kept by
  M. Hardcastle): name, J2000 radio position, 178 MHz flux, redshift,
  spectral index, FR class.
- The ATNF Pulsar Catalogue (Manchester et al. 2005), version PSRCAT_VERSION:
  pulsars north of Dec -40 with a measured 400 or 1400 MHz flux.
- d3-celestial (Olaf Frohn, BSD 3-clause): stars to magnitude 6 (from
  Hipparcos), their proper names, and the constellation lines and names.

The hand-kept facts (site, array, pointings, calibrators, dumps) are in
site.json beside the page, not here; this file is regenerated, never
edited.  --cache keeps the downloads in DIR and reuses them.
"""

import argparse
import datetime
import json
import re
import sys
import urllib.parse
import urllib.request
from pathlib import Path

PSRCAT_VERSION = "2.9.0"
CRR_URL = "https://3crr.extragalactic.info/cgi/ascii?1,2,3,4,8,7,23,24"
PSRCAT_URL = "https://www.atnf.csiro.au/research/pulsar/psrcat/proc_form.php?" + urllib.parse.urlencode({
    "version": PSRCAT_VERSION, "JName": "JName", "Name": "Name", "RaJ": "RaJ", "DecJ": "DecJ",
    "P0": "P0", "DM": "DM", "S400": "S400", "S1400": "S1400", "Assoc": "Assoc",
    "startUserDefined": "true", "sort_attr": "jname", "sort_order": "asc",
    "condition": "DecJ > -40", "ephemeris": "short", "coords_unit": "raj/decj",
    "style": "Short csv without errors", "no_value": "*", "nohead": "nohead",
    "fsize": "3", "x_scale": "linear", "y_scale": "linear", "state": "query",
    "table_bottom.x": "0", "table_bottom.y": "0",
})
D3C = "https://raw.githubusercontent.com/ofrohn/d3-celestial/master/"
D3C_FILES = ["data/stars.6.json", "data/starnames.json", "data/constellations.json",
             "data/constellations.lines.json", "LICENSE"]
STAR_MAG_LIMIT = 6.0        # faintest star kept
STAR_NAME_MAG = 2.5         # proper names only for stars brighter than this


def fetch(url, cache, name):
    if cache:
        path = Path(cache) / name
        if path.exists():
            return path.read_bytes()
    with urllib.request.urlopen(url, timeout=120) as r:
        data = r.read()
    if cache:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
    return data


def sexa(text, hours):
    """Degrees from 'hh mm ss.s' / 'dd:mm:ss' (fields may be missing)."""
    parts = re.split(r"[ :]+", text.strip())
    sign = -1.0 if parts[0].startswith("-") else 1.0
    vals = [abs(float(p)) for p in parts]
    deg = vals[0] + (vals[1] / 60 if len(vals) > 1 else 0) + (vals[2] / 3600 if len(vals) > 2 else 0)
    return round(sign * deg * (15 if hours else 1), 5)


def num(text):
    text = text.strip()
    if text in ("", "*", "-"):
        return None
    try:
        return float(text)
    except ValueError:
        return None


def three_crr(raw):
    rows = []
    for line in raw.decode().splitlines()[2:]:
        f = line.split()
        if len(f) != 12:
            raise ValueError(f"3CRR: unexpected line {line!r}")
        name, z, s178, alpha, fr = f[0], num(f[2]), num(f[3]), num(f[4]), f[5]
        ra = sexa(" ".join(f[6:9]), True)
        dec = sexa(" ".join(f[9:12]), False)
        name = re.sub(r"^3C(\d)", r"3C \1", name)
        rows.append([name, ra, dec, s178, z, alpha, fr])
    return {"cols": ["name", "ra", "dec", "s178_jy", "z", "alpha", "fr"], "rows": rows}


def pulsars(raw):
    text = raw.decode(errors="replace")
    body = text[text.index("<pre>") + 5:text.index("</pre>")]
    rows = []
    for line in body.splitlines():
        f = line.split(";")
        if len(f) < 11:
            continue
        _, jname, name, raj, decj, p0, dm, s400, s1400, assoc = f[:10]
        p0, s400, s1400 = num(p0), num(s400), num(s1400)
        if p0 is None or (s400 is None and s1400 is None):
            continue
        # Only the supernova-remnant and globular-cluster associations: the
        # others (gamma-ray, X-ray counterparts) come truncated in this style.
        assoc = ",".join(a.split("[")[0] for a in assoc.split(",")
                         if a.startswith(("SNR:", "GC:")))
        rows.append([name.strip(), jname.strip(), sexa(raj, True), sexa(decj, False),
                     p0, num(dm), s400, s1400, assoc])
    return {"cols": ["name", "jname", "ra", "dec", "p0_s", "dm", "s400_mjy", "s1400_mjy", "assoc"],
            "rows": rows}


def ra360(lon):
    return round(lon % 360.0, 4)


def stars(raw_stars, raw_names):
    names = json.loads(raw_names)
    rows = []
    for f in json.loads(raw_stars)["features"]:
        mag = f["properties"]["mag"]
        if mag > STAR_MAG_LIMIT:
            continue
        lon, lat = f["geometry"]["coordinates"]
        bv = num(str(f["properties"].get("bv", "")))
        n = names.get(str(f["id"]), {})
        name = n.get("name", "") if mag < STAR_NAME_MAG else ""
        rows.append([ra360(lon), round(lat, 4), mag, bv, name])
    rows.sort(key=lambda r: r[2])
    return {"cols": ["ra", "dec", "mag", "bv", "name"], "rows": rows}


def constellations(raw_names, raw_lines):
    names = [[f["id"], f["properties"]["name"], ra360(f["geometry"]["coordinates"][0]),
              f["geometry"]["coordinates"][1]] for f in json.loads(raw_names)["features"]]
    lines = []
    for f in json.loads(raw_lines)["features"]:
        for seg in f["geometry"]["coordinates"]:
            lines.append([v for lon, lat in seg for v in (ra360(lon), round(lat, 4))])
    return {"names": names, "lines": lines}


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("out")
    ap.add_argument("--cache")
    a = ap.parse_args(argv)
    d3c = {p: fetch(D3C + p, a.cache, "d3c-" + p.replace("/", "-")) for p in D3C_FILES}
    cat = {
        "generated": datetime.date.today().isoformat(),
        "sources_3crr": three_crr(fetch(CRR_URL, a.cache, "3crr.txt")),
        "pulsars": pulsars(fetch(PSRCAT_URL, a.cache, "psrcat.html")),
        "stars": stars(d3c["data/stars.6.json"], d3c["data/starnames.json"]),
        "constellations": constellations(d3c["data/constellations.json"],
                                         d3c["data/constellations.lines.json"]),
        "credits": {
            "3crr": "Laing, Riley & Longair 1983, MNRAS 204, 151; online 3CRR catalogue, "
                    "https://3crr.extragalactic.info/",
            "pulsars": f"ATNF Pulsar Catalogue v{PSRCAT_VERSION}, Manchester et al. 2005, AJ 129, 1993, "
                       "https://www.atnf.csiro.au/research/pulsar/psrcat/",
            "stars": "d3-celestial data (Hipparcos stars, constellation lines and names), "
                     "https://github.com/ofrohn/d3-celestial",
            "d3_celestial_license": d3c["LICENSE"].decode(),
        },
    }
    with open(a.out, "w") as f:
        json.dump(cat, f, separators=(",", ":"), ensure_ascii=False)
        f.write("\n")
    for k in ("sources_3crr", "pulsars", "stars"):
        print(f"{k}: {len(cat[k]['rows'])}", file=sys.stderr)
    print(f"constellation lines: {len(cat['constellations']['lines'])}", file=sys.stderr)


if __name__ == "__main__":
    main()
