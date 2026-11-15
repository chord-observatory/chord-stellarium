# chord-stellarium

The sky above the CHORD pathfinder at DRAO, computed in the browser: the
408 MHz radio sky, the dishes' beam over any band, 3CRR sources, pulsars,
the baseband dumps, stars, planets, the Sun and the Moon, over the real
skyline, at any time.

- Page: <https://chord-observatory.github.io/chord-stellarium/>, also at
  <https://ctc.chord-observatory.ca/observatory/>, which redirects here
  (chord-sysops `proxy_nginx`). choco's menu links the proxy address.
- A link keeps the moment and the view, for example
  `#t=2026-10-30T10:59:20Z&p=taua&v=dome` (the Tau A baseband dump).
  `#kiosk` hides the controls, for wall displays.

The page is static: no server, no live data. The dish pointing is a
choice (Tau A, Cyg A or a declination), not read from the dishes.

## Layout

| Path | What | Edited how |
|---|---|---|
| `web/index.html` | Markup and styles | by hand |
| `web/app.js` | State, controls, panels, URL fragment | by hand |
| `web/astro.js` | Time, frames, Sun, Moon, planets, cosmology (no DOM) | by hand; run the test |
| `web/proj.js` | Projections: stereographic camera, Mollweide, plate carrée | by hand |
| `web/skygl.js` | WebGL: the radio sky, ground, daylight, the band-drawn beam | by hand |
| `web/overlay.js` | Lines, markers, labels, pulsar blinking | by hand |
| `web/trace.js` | The drift-trace model under the sky | by hand |
| `web/site.json` | Site, array, pointings, calibrators, baseband dumps | **by hand** |
| `web/catalog.json` | 3CRR, ATNF pulsars, stars, constellations | `tools/build_catalog.py` |
| `web/sky.png`, `web/sky.json` | 408 MHz sky, 2048 × 1024, ICRS plate carrée | `tools/make_sky.py` |
| `web/horizon.json` | Terrain skyline every 0.5° of azimuth (optional: flat without it) | `tools/make_horizon.py` |
| `tools/` | The builders above, and the tests | |

To add a baseband dump or a pointing, edit `web/site.json`. A dump's sky
position is computed from its time and pointing.

## Publishing

Every push to `main` publishes `web/` to GitHub Pages
(`.github/workflows/pages.yml`). The workflow stamps each module, data
and image URL with the commit (`?v=<sha>`): Pages lets browsers cache
files for 10 minutes, and a stamped page only ever loads files from its
own commit, never a mix of old and new.

To look at a change before pushing, serve `web/` locally
(`python3 -m http.server -d web`) and open it in a browser.

## Tools

- `tools/build_catalog.py`: downloads 3CRR, psrcat and d3-celestial and
  writes `web/catalog.json`. Stdlib only.
- `tools/make_sky.py` / `tools/unpack_sky.py`: resample the Haslam map
  into `web/sky.png` and `web/sky.json`. `make_sky.py` needs numpy,
  astropy, Pillow and `choco.healpix`, so it runs in choco's venv on the
  choco VM, which also holds the FITS file; the command is in its
  docstring.
- `tools/make_horizon.py`: the skyline from SRTM 1" tiles (AWS Terrain
  Tiles), 2 m above the ground at the site, terrain from 300 m to 80 km,
  with curvature and refraction. Stdlib only. Nearer terrain is left out:
  a 30 m DEM pixel next to the site set 10° of skyline. On 2026-11-15 the
  skyline was 3.8–10.8° high, set by hills 1–9 km away (7.2° due south).
- `tools/astro_ref.py`: astropy positions into `tools/astro_ref.json`
  (choco's venv).
- `tools/test_astro.mjs`: checks `web/astro.js` against
  `tools/astro_ref.json` under node. Tolerances are in the file. On
  2026-11-15: sources 25", Sun 27", Moon 11", planets 1.8' (Jupiter and
  Saturn 10': JPL's mean elements leave out their great inequality), LST
  within UT1-UTC.
- `tools/shots.mjs`: screenshots in headless Chrome, with console errors,
  for checking a change without a browser at hand. Needs puppeteer in a
  scratch directory (cx69 has the libraries Chrome needs):

```bash
D=/tmp/stellarium-$USER; mkdir -p $D/pp && cd $D/pp && npm init -y >/dev/null
PUPPETEER_CACHE_DIR=$D/cache npm_config_cache=$D/npmcache npm install puppeteer@23.11.1
# copy web/ to $D/web and tools/shots.mjs to $D/pp, then
python3 -m http.server 8765 --bind 127.0.0.1 --directory $D/web &
PUPPETEER_CACHE_DIR=$D/cache node shots.mjs http://127.0.0.1:8765/ $D/shots 1400x900 \
  ground='t=2026-11-15T06:00:00Z' array='v=dome&f=300-900&beam=array&alt=63&zoom=3.5'
```

## Conventions

- Catalogue positions are ICRS (J2000). The beam is fixed in the local
  frame (ENU): on the meridian at the pointing's declination of date.
- `astro.js` leaves out aberration (20") and refraction and takes UT1 as
  UTC. That is far below the beam's scale.
- Views: Ground (the default: standing at the site, facing south, framing
  the skyline and the beam) and Dome are one stereographic camera that
  turns to any azimuth and tilts from nadir to zenith; Chart is the whole
  sky as a map. With the Horizon layer on, the terrain hides what is below
  the skyline.
- The beam is a model: a Gaussian main lobe (HPBW 11.5° at 300 MHz,
  scaled as 1/f) and, for the array, the factor of an ideal 8 × 8 grid
  (6.3 m east-west, 8.5 m north-south) phased to the beam centre.
- The drift trace scales the 408 MHz map as f^-2.55, averages it over the
  dish beam and adds a quiet Sun: a model of one dish's total power, not
  a measurement.

## Data and credits

The page's Credits panel lists every source. The stars and constellations
come from d3-celestial (BSD 3-clause; its notice ships in
`web/catalog.json` and shows in the panel). The code here is under the
BSD 3-clause licence in `LICENSE`.
