#!/usr/bin/env python3
"""Resample the 408 MHz all-sky map into the observatory's sky texture.

Reads the destriped Haslam map (Remazeilles et al. 2015), a Galactic
HEALPix FITS in RING order, and writes one JSON object on stdout:

  {"meta": {...}, "png_base64": "..."}

The PNG is 8-bit greyscale, plate carree in ICRS (J2000): column x is
RA = (x + 0.5) * 360 / width degrees, increasing to the right; row y is
Dec = 90 - (y + 0.5) * 180 / height degrees.  A pixel value p stands for
log10(T / K) = lo + p * (hi - lo) / 255, with lo and hi in "meta".

Runs in choco's venv, which has numpy, astropy, Pillow, choco.healpix
and the FITS file (the choco VM: /opt/choco).  It writes nothing on the
host it runs on:

  ssh choco.site.chord-observatory.ca \\
    'env -u HDF5_PLUGIN_PATH /opt/choco/.venv/bin/python - \\
       /opt/choco/jobs/skymap/haslam408_ds_Remazeilles2014.fits' \\
    < tools/make_sky.py > sky.out.json
  python3 tools/unpack_sky.py sky.out.json web
"""

import base64
import io
import json
import sys

import numpy as np
from PIL import Image

from choco.healpix import load_healpix, sample_equatorial

WIDTH, HEIGHT = 2048, 1024


def main(path, width=WIDTH, height=HEIGHT):
    m, nside = load_healpix(path)
    ra = (np.arange(width) + 0.5) * (2 * np.pi / width)
    dec = np.pi / 2 - (np.arange(height) + 0.5) * (np.pi / height)
    ra2, dec2 = np.meshgrid(ra, dec)
    t = sample_equatorial(m, nside, ra2.ravel(), dec2.ravel()).reshape(height, width)
    good = np.isfinite(t) & (t > 0)
    logt = np.where(good, np.log10(np.where(good, t, 1.0)), np.nan)
    lo = float(np.floor(np.nanmin(logt) * 100) / 100)
    hi = float(np.ceil(np.nanmax(logt) * 100) / 100)
    p = np.round((logt - lo) / (hi - lo) * 255)
    p = np.where(good, np.clip(p, 0, 255), 0).astype(np.uint8)
    buf = io.BytesIO()
    Image.fromarray(p, mode="L").save(buf, format="PNG", optimize=True)
    meta = {
        "map": "Haslam et al. 1982, 408 MHz; destriped by Remazeilles et al. 2015",
        "file": path.rsplit("/", 1)[-1],
        "nside": nside,
        "frame": "ICRS",
        "projection": "plate carree; x: RA 0..360 increasing; y: Dec +90..-90",
        "width": width,
        "height": height,
        "freq_mhz": 408.0,
        "log10_t_lo": lo,
        "log10_t_hi": hi,
        "bad_pixels": int((~good).sum()),
    }
    json.dump({"meta": meta, "png_base64": base64.b64encode(buf.getvalue()).decode()},
              sys.stdout)


if __name__ == "__main__":
    main(sys.argv[1])
