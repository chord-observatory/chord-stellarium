#!/usr/bin/env python3
"""Build the observatory's catalog.json from public catalogues.

  python3 tools/build_catalog.py docs/catalog.json [--cache DIR]

Stdlib only, so it runs on chord-gateway.  It downloads:

- 3CRR (Laing, Riley & Longair 1983; the online catalogue kept by
  M. Hardcastle): name, J2000 radio position, 178 MHz flux, redshift,
  spectral index, FR class.
- The ATNF Pulsar Catalogue (Manchester et al. 2005), version PSRCAT_VERSION:
  pulsars north of Dec -40 with a measured 400 or 1400 MHz flux.
- d3-celestial (Olaf Frohn, BSD 3-clause): stars to magnitude 6 (from
  Hipparcos), their proper names, and the constellation lines and names.
- NVSS (Condon et al. 1998; VizieR VIII/65) components above NVSS_MIN_MJY
  at 1.4 GHz, grouped (friends of friends within GROUP_ARCMIN, so a
  radio galaxy's lobes are one source), and TGSS ADR1 (Intema et al. 2017)
  at 150 MHz, summed over each group's extent, for a spectral index.
  Kept: groups north of Dec -40 brighter than BRIGHT_400_JY at 400 MHz
  (without a TGSS match, at 1.4 GHz: no index, nothing extrapolated).
  A group within reach of a 3CRR source takes its name; one of the
  site's calibrators is left out (the page draws those from site.json).
- Green's catalogue of Galactic supernova remnants (2024 October
  version): position, size, type, 1 GHz flux and spectral index.

The hand-kept facts (site, array, pointings, calibrators, dumps) are in
site.json beside the page, not here; this file is regenerated, never
edited.  --cache keeps the downloads in DIR and reuses them.
"""

import argparse
import bisect
import datetime
import html
import json
import math
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

NVSS_MIN_MJY = 500          # NVSS components fetched (1.4 GHz)
NVSS_URLS = [f"https://{host}/viz-bin/asu-tsv?" + urllib.parse.urlencode({
    "-source": "VIII/65/nvss", "-out.max": "unlimited", "-out": "RAJ2000,DEJ2000,S1.4",
    "S1.4": f">{NVSS_MIN_MJY}"}) for host in ("vizier.cds.unistra.fr", "vizier.cfa.harvard.edu")]
TGSS_URL = "https://tgssadr.strw.leidenuniv.nl/catalogs/TGSSADR1_7sigma_catalog.tsv"
TGSS_MIN_MJY = 100          # TGSS sources kept for the spectral indices (150 MHz)
GROUP_ARCMIN = 4.0          # NVSS components this close are one source
MATCH_ARCMIN = 1.5          # TGSS and 3CRR reach beyond a group's extent
BRIGHT_400_JY = 5.0         # a group is kept at this flux or more at 400 MHz
GREEN_URL = "https://www.mrao.cam.ac.uk/surveys/snrs/snrs.data.html"

# The 3CR (Bennett 1962) and 3C (Edge et al. 1959) catalogues, for names
# only: their positions (precessed to J2000 by VizieR) are good to
# arcminutes, some to tens.  3C covers the south that 3CR leaves out.
THREEC_URLS = {table: [f"https://{host}/viz-bin/asu-tsv?" + urllib.parse.urlencode({
    "-source": f"VIII/1A/{table}", "-out.max": "unlimited", "-out": f"{col},e_DE1950,{flux}",
    "-out.add": "_RAJ,_DEJ"}) for host in ("vizier.cds.unistra.fr", "vizier.cfa.harvard.edu")]
    for table, col, flux in (("3cr", "3CR", "S178MHz"), ("3c", "3C", "S159MHz"))}
NAME_MAX_ARCMIN = 15.0      # a 3C name reaches at most this far, and twice its error
NAME_FLUX_RATIO = 3.0       # ... to a source within this factor of its flux
# The names every radio astronomer uses for these 3C sources.
ALIASES = {"3C 84": "Per A", "3C 218": "Hydra A", "3C 348": "Her A"}


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


def unit(ra, dec):
    r, d = math.radians(ra), math.radians(dec)
    return (math.cos(d) * math.cos(r), math.cos(d) * math.sin(r), math.sin(d))


def sep_arcmin(a, b):
    c = max(-1.0, min(1.0, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]))
    return math.degrees(math.acos(c)) * 60


def fetch_first(urls, cache, name, ok):
    """The first answer *ok* accepts, trying each mirror in turn (VizieR's
    servers come and go); cached under *name* once accepted."""
    if cache and (Path(cache) / name).exists():
        return (Path(cache) / name).read_bytes()
    for url in urls:
        try:
            with urllib.request.urlopen(url, timeout=300) as r:
                data = r.read()
        except OSError as e:
            print(f"{url}: {e}", file=sys.stderr)
            continue
        if ok(data):
            if cache:
                Path(cache).mkdir(parents=True, exist_ok=True)
                (Path(cache) / name).write_bytes(data)
            return data
        print(f"{url}: no data in the answer", file=sys.stderr)
    raise OSError(f"no mirror answered for {name}")


def nvss_components(raw):
    out = []
    for line in raw.decode(errors="replace").splitlines():
        f = line.split("\t")
        if len(f) < 3 or not re.match(r"\d\d \d\d", f[0]):
            continue
        out.append((sexa(f[0], True), sexa(f[1], False), float(f[2]) / 1000))
    return out


def tgss_sources(raw):
    lines = raw.decode(errors="replace").splitlines()
    head = lines[0].split("\t")
    ira, idec, iflux = head.index("RA"), head.index("DEC"), head.index("Total_flux")
    out = []
    for line in lines[1:]:
        f = line.split("\t")
        flux = float(f[iflux])
        if flux >= TGSS_MIN_MJY:
            out.append((float(f[ira]), float(f[idec]), flux / 1000))
    return out


class DecIndex:
    """Points sorted by declination, for 'everything within r arcmin'."""

    def __init__(self, points):
        self.points = sorted(points, key=lambda p: p[1])
        self.decs = [p[1] for p in self.points]
        self.units = [unit(p[0], p[1]) for p in self.points]

    def near(self, ra, dec, arcmin):
        u, d = unit(ra, dec), arcmin / 60
        lo, hi = bisect.bisect_left(self.decs, dec - d), bisect.bisect_right(self.decs, dec + d)
        return [i for i in range(lo, hi) if sep_arcmin(u, self.units[i]) <= arcmin]


def threec_entries(raw_3cr, raw_3c):
    """[(name, unit vector, position error in arcmin, flux near 170 MHz)]:
    every 3CR entry, then the 3C ones 3CR does not have."""
    out, seen = [], set()
    for raw in (raw_3cr, raw_3c):
        for line in raw.decode(errors="replace").splitlines():
            f = line.split("\t")
            if len(f) < 5 or not re.match(r"\s*\d", f[0]) or not f[2].strip():
                continue
            name = "3C " + f[2].strip()
            if name in seen:
                continue
            seen.add(name)
            out.append((name, unit(float(f[0]), float(f[1])), num(f[3]) or 5.0, num(f[4])))
    return out


def nvss_bright(raw_nvss, raw_tgss, crr, calibrators, threec):
    """NVSS components grouped into sources, with a TGSS spectral index;
    the bright ones at 400 MHz.  Rows: name, ra, dec, S1.4 (Jy), S150 (Jy
    or None), alpha (S ~ f^alpha), components, 3CRR name or "", 3C name
    or "", common name or ""."""
    comps = DecIndex(nvss_components(raw_nvss))
    parent = list(range(len(comps.points)))

    def root(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    for i, (ra, dec, _) in enumerate(comps.points):
        for j in comps.near(ra, dec, GROUP_ARCMIN):
            parent[root(j)] = root(i)
    groups = {}
    for i in range(len(comps.points)):
        groups.setdefault(root(i), []).append(i)

    tgss = DecIndex(tgss_sources(raw_tgss))
    crr_units = [(r[0], unit(r[1], r[2])) for r in crr["rows"]]
    cal_units = [unit(c["ra"], c["dec"]) for c in calibrators]
    rows = []
    for members in groups.values():
        s14 = sum(comps.points[i][2] for i in members)
        v = [sum(comps.units[i][k] * comps.points[i][2] for i in members) for k in range(3)]
        n = math.sqrt(sum(x * x for x in v))
        c = (v[0] / n, v[1] / n, v[2] / n)
        ra, dec = math.degrees(math.atan2(c[1], c[0])) % 360, math.degrees(math.asin(c[2]))
        if dec < -40:
            continue
        extent = max(sep_arcmin(c, comps.units[i]) for i in members)
        if any(sep_arcmin(c, u) <= extent + 3 for u in cal_units):
            continue
        reach = extent + MATCH_ARCMIN
        s150 = sum(tgss.points[i][2] for i in tgss.near(ra, dec, reach)) or None
        alpha = math.log(s14 / s150) / math.log(1400 / 150) if s150 else None
        # Without TGSS (its gaps; the bright HII regions, whose thermal
        # spectra are flat or rising) the flux is not extrapolated.
        if s14 * (400 / 1400) ** (alpha if alpha is not None else 0) < BRIGHT_400_JY:
            continue
        near3c = [(sep_arcmin(c, u), name) for name, u in crr_units if sep_arcmin(c, u) <= reach + 1]
        name3crr = min(near3c)[1] if near3c else ""
        h, m = divmod(round(ra / 15 * 60), 60)
        sign, dm = ("+" if dec >= 0 else "-"), round(abs(dec) * 60)
        rows.append({"nvss": f"NVSS J{h % 24:02d}{m:02d}{sign}{dm // 60:02d}{dm % 60:02d}", "unit": c,
                     "reach": reach, "ra": ra, "dec": dec, "s14": s14, "s150": s150, "alpha": alpha,
                     "n": len(members), "crr": name3crr, "threec": ""})
    # Each 3C name goes to one source: the nearest within its reach whose
    # flux, taken to the 3C frequency, agrees within NAME_FLUX_RATIO.
    for name, u, err, s3c in threec:
        if any(r["crr"] == name for r in rows):
            continue
        best = None
        for r in rows:
            d = sep_arcmin(r["unit"], u)
            if d > min(NAME_MAX_ARCMIN, max(3.0, 2 * err)) + r["reach"] or r["threec"]:
                continue
            s170 = r["s14"] * (170 / 1400) ** (r["alpha"] if r["alpha"] is not None else -0.8)
            if s3c and not 1 / NAME_FLUX_RATIO <= s170 / s3c <= NAME_FLUX_RATIO:
                continue
            if best is None or d < best[0]:
                best = (d, r)
        if best:
            best[1]["threec"] = name
    out = []
    for r in sorted(rows, key=lambda r: -r["s14"]):
        three = r["crr"] or r["threec"]
        out.append([ALIASES.get(three) or three or r["nvss"], round(r["ra"], 4), round(r["dec"], 4),
                    round(r["s14"], 2), round(r["s150"], 2) if r["s150"] else None,
                    round(r["alpha"], 2) if r["alpha"] is not None else None, r["n"], r["crr"],
                    r["threec"], r["nvss"]])
    return {"cols": ["name", "ra", "dec", "s1400_jy", "s150_jy", "alpha", "components", "crr", "threec", "nvss"],
            "rows": out}


def green_snrs(raw):
    """Green's table: rows name (Gl+b), other names, ra, dec, size a and b
    (arcmin), type, 1 GHz flux (Jy) and spectral index (S ~ f^alpha); a
    value Green marks uncertain keeps its number, '?' alone is None."""
    text = raw.decode("utf-8", errors="replace")
    body = html.unescape(re.sub(r"<[^>]+>", "", text[text.index("<PRE>") + 5:text.index("</PRE>")]))
    pat = re.compile(r"\s*(\d+\.\d)\s+([+-]\d+\.\d)\s+(\d\d \d\d \d\d)\s+([+-]\d\d \d\d)\s+(\S+)\s+(\S+)"
                     r"\s+(\S+)\s+(\S+)\s*(.*)$")
    rows = []
    for line in body.splitlines():
        m = pat.match(line)
        if not m:
            continue
        l, b, ra, dec, size, kind, flux, index, other = m.groups()
        sizes = [num(x.rstrip("?")) for x in size.split("x")]
        if None in sizes:
            continue
        idx = num(index.rstrip("?"))
        rows.append([f"G{l}{b}", other.strip(" ,"), sexa(ra, True), sexa(dec, False), sizes[0], sizes[-1],
                     kind.rstrip("?"), num(flux.rstrip("?")), -idx if idx is not None else None])
    return {"cols": ["name", "other", "ra", "dec", "size_a_arcmin", "size_b_arcmin", "type",
                     "s1000_jy", "alpha"], "rows": rows}


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("out")
    ap.add_argument("--cache")
    a = ap.parse_args(argv)
    d3c = {p: fetch(D3C + p, a.cache, "d3c-" + p.replace("/", "-")) for p in D3C_FILES}
    site = json.loads((Path(a.out).parent / "site.json").read_text())
    crr = three_crr(fetch(CRR_URL, a.cache, "3crr.txt"))
    nvss_raw = fetch_first(NVSS_URLS, a.cache, "nvss.tsv", lambda d: len(nvss_components(d)) > 1000)
    threec = threec_entries(*(fetch_first(THREEC_URLS[t], a.cache, f"{t}.tsv", lambda d: d.count(b"\n") > 200)
                              for t in ("3cr", "3c")))
    cat = {
        "generated": datetime.date.today().isoformat(),
        "sources_3crr": crr,
        "sources_nvss": nvss_bright(nvss_raw, fetch(TGSS_URL, a.cache, "tgss.tsv"), crr, site["calibrators"], threec),
        "snrs": green_snrs(fetch(GREEN_URL, a.cache, "green.html")),
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
            "nvss": "NVSS, Condon et al. 1998, AJ 115, 1693 (VizieR VIII/65), with spectral indices from "
                    "the TGSS ADR1, Intema et al. 2017, A&A 598, A78, https://tgssadr.strw.leidenuniv.nl/",
            "snrs": "D. A. Green, A catalogue of Galactic supernova remnants (2024 October version), "
                    "https://www.mrao.cam.ac.uk/surveys/snrs/",
            "d3_celestial_license": d3c["LICENSE"].decode(),
        },
    }
    with open(a.out, "w") as f:
        json.dump(cat, f, separators=(",", ":"), ensure_ascii=False)
        f.write("\n")
    for k in ("sources_3crr", "sources_nvss", "snrs", "pulsars", "stars"):
        print(f"{k}: {len(cat[k]['rows'])}", file=sys.stderr)
    print(f"constellation lines: {len(cat['constellations']['lines'])}", file=sys.stderr)


if __name__ == "__main__":
    main()
