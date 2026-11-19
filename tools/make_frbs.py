#!/usr/bin/env python3
"""Build the observatory's frbs.json from the second CHIME/FRB catalogue.

  python3 tools/make_frbs.py docs/frbs.json [--csv chimefrbcat2.csv]

Stdlib only.  It downloads the catalogue's CSV (CHIME/FRB Collaboration,
arXiv:2601.09399; release VERSION, doi:10.11570/25.0066), or reads the
copy given with --csv.  The catalogue has a row per sub-burst; the page
gets:

- bursts: an entry per one-off burst (no repeater name), with its
  position, the larger of the two position errors, the dispersion measure
  (DM) and the part of it from beyond the Galaxy (NE2001), the fluence
  summed over its sub-bursts, and the arrival time.
- repeaters: an entry per repeating source, at the position of its
  best-localised burst (single bursts are good to about 0.2 deg, and some
  were caught in a sidelobe degrees away in RA), with the median DM, the
  number of bursts in the catalogue, and the first and last of them.

Bursts seen only in a far sidelobe have no position and are left out.
"""

import argparse
import csv
import datetime
import io
import json
import math
import statistics
import sys
import urllib.request

VERSION = "20251231"
URL = f"https://assets.chime-frb.ca/catalogs/catalog2/releases/{VERSION}/data/chimefrbcat2.csv"


def num(text):
    try:
        v = float(text)
    except ValueError:
        return None
    return v if math.isfinite(v) else None


def rnd(v, n):
    return None if v is None else round(v, n)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("out")
    ap.add_argument("--csv")
    a = ap.parse_args(argv)
    if a.csv:
        text = open(a.csv, encoding="utf-8").read()
    else:
        with urllib.request.urlopen(URL, timeout=300) as r:
            text = r.read().decode("utf-8")

    events = {}
    for row in csv.DictReader(io.StringIO(text)):
        e = events.setdefault(row["event_id"], {"row": row, "fluence": None})
        f = num(row["fluence"])
        if f is not None:
            e["fluence"] = (e["fluence"] or 0.0) + f

    bursts, groups, unplaced = [], {}, 0
    for e in events.values():
        r = e["row"]
        ra, dec = num(r["ra"]), num(r["dec"])
        if ra is None or dec is None:
            unplaced += 1
            continue
        errs = [v for v in (num(r["ra_err"]), num(r["dec_err"])) if v is not None]
        b = {"name": r["tns_name"], "ra": ra, "dec": dec, "err": max(errs) if errs else None,
             "dm": num(r["dm_fitb"]) or num(r["bonsai_dm"]), "dm_exc": num(r["dm_exc_ne2001"]),
             "fluence": e["fluence"], "mjd": num(r["mjd_400"])}
        if r["repeater_name"]:
            groups.setdefault(r["repeater_name"], []).append(b)
        else:
            bursts.append(b)

    bursts.sort(key=lambda b: b["name"])
    burst_rows = [[b["name"], round(b["ra"], 3), round(b["dec"], 3), rnd(b["err"], 3), rnd(b["dm"], 1),
                   rnd(b["dm_exc"], 0), rnd(b["fluence"], 2), rnd(b["mjd"], 4)] for b in bursts]
    rep_rows = []
    for name, g in sorted(groups.items()):
        best = min(g, key=lambda b: b["err"] if b["err"] is not None else 9.0)
        mjds = [b["mjd"] for b in g if b["mjd"] is not None]
        fl = [b["fluence"] for b in g if b["fluence"] is not None]
        rep_rows.append([name, round(best["ra"], 4), round(best["dec"], 4), rnd(best["err"], 4),
                         rnd(statistics.median(b["dm"] for b in g if b["dm"] is not None), 1),
                         rnd(statistics.median(b["dm_exc"] for b in g if b["dm_exc"] is not None), 0),
                         len(g), rnd(min(mjds), 2), rnd(max(mjds), 2), rnd(max(fl), 2) if fl else None])

    out = {
        "generated": datetime.date.today().isoformat(),
        "credit": f"CHIME/FRB Collaboration, the second CHIME/FRB catalogue (release {VERSION}), "
                  "arXiv:2601.09399, https://www.chime-frb.ca/catalogs/catalog2",
        "bursts": {"cols": ["name", "ra", "dec", "err_deg", "dm", "dm_exc", "fluence_jy_ms", "mjd"],
                   "rows": burst_rows},
        "repeaters": {"cols": ["name", "ra", "dec", "err_deg", "dm", "dm_exc", "bursts", "mjd_first",
                               "mjd_last", "fluence_max_jy_ms"], "rows": rep_rows},
    }
    with open(a.out, "w") as f:
        json.dump(out, f, separators=(",", ":"))
        f.write("\n")
    print(f"bursts: {len(burst_rows)}, repeaters: {len(rep_rows)} ({sum(r[6] for r in rep_rows)} bursts), "
          f"without a position: {unplaced}", file=sys.stderr)


if __name__ == "__main__":
    main()
