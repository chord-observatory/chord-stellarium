# Observatory page: tools

The page itself is `ansible/roles/proxy_nginx/files/webroot/observatory/`,
served at `https://ctc.chord-observatory.ca/observatory/` and deployed with
the rest of the web root by `proxy-setup.yaml`. It is static: the browser
computes everything from the clock, the site and two JSON files. Nothing
here is deployed.

## Files of the page

| File | What | Edited how |
|---|---|---|
| `index.html` | Markup and styles | by hand |
| `app.js` | State, controls, panels, URL fragment | by hand |
| `astro.js` | Time, frames, Sun, Moon, cosmology (no DOM) | by hand; run the test |
| `proj.js` | Projections: stereographic dome, Mollweide, plate carrée | by hand |
| `skygl.js` | WebGL: the radio sky, ground, daylight, the band-drawn beam | by hand |
| `overlay.js` | Lines, markers, labels, pulsar blinking | by hand |
| `trace.js` | The drift-trace model under the sky | by hand |
| `site.json` | Site, array, pointings, calibrators, baseband dumps | **by hand** |
| `catalog.json` | 3CRR, ATNF pulsars, stars, constellations | `build_catalog.py` |
| `sky.png`, `sky.json` | 408 MHz sky, 2048 × 1024, ICRS plate carrée | `make_sky.py` |

To add a baseband dump or a pointing, edit `site.json` and rerun
`proxy-setup.yaml`. A dump's sky position is computed from its time and
pointing.

## Tools

- `build_catalog.py`: downloads 3CRR, psrcat and d3-celestial and writes
  `catalog.json`. Stdlib only; runs on chord-gateway.
- `make_sky.py` / `unpack_sky.py`: resamples the Haslam map (choco's copy)
  into `sky.png` and `sky.json`. `make_sky.py` runs in choco's venv on the
  choco VM and writes to stdout; the command is in its docstring.
- `astro_ref.py`: astropy positions (choco VM, stdout) into
  `astro_ref.json`.
- `test_astro.mjs`: checks `astro.js` against `astro_ref.json` (node; cx69
  has it). Tolerances are in the file. On 2026-11-15: sources 25",
  Sun 27", Moon 11", LST within UT1-UTC.
- `shots.mjs`: screenshots in headless Chrome, with console errors. Needs
  puppeteer in a scratch directory on cx69 (it has Chrome's libraries):

```bash
D=/tmp/observatory-$USER; mkdir -p $D/pp && cd $D/pp && npm init -y >/dev/null
PUPPETEER_CACHE_DIR=$D/cache npm_config_cache=$D/npmcache npm install puppeteer@23.11.1
# copy the page to $D/web and shots.mjs to $D/pp, then
python3 -m http.server 8765 --bind 127.0.0.1 --directory $D/web &
PUPPETEER_CACHE_DIR=$D/cache node shots.mjs http://127.0.0.1:8765/ $D/shots 1400x900 \
  dome='t=2026-10-30T10:59:20Z' array='v=dome&f=300-900&beam=array&alt=63&zoom=3.5'
```

## Conventions

- Catalogue positions are ICRS (J2000). The beam is fixed in the local
  frame (ENU): on the meridian at the pointing's declination of date.
- `astro.js` leaves out aberration (20") and refraction and takes UT1 as
  UTC. That is far below the beam's scale.
- The beam is a model: a Gaussian main lobe (HPBW 11.5° at 300 MHz,
  scaled as 1/f) and, for the array, the factor of an ideal 8 × 8 grid
  (6.3 m east-west, 8.5 m north-south) phased to the beam centre.
- The drift trace scales the 408 MHz map as f^-2.55 and averages it over
  the dish beam: a model of one dish's total power, not a measurement.
