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
| `docs/index.html` | Markup and styles | by hand |
| `docs/app.js` | State, controls, panels, URL fragment | by hand |
| `docs/astro.js` | Time, frames, Sun, Moon, planets, cosmology (no DOM) | by hand; run the test |
| `docs/proj.js` | Projections: stereographic camera, Mollweide, plate carrée | by hand |
| `docs/skygl.js` | WebGL: the radio sky, daylight, the band-drawn beam, the ground; the made-up clouds and terrain | by hand |
| `docs/atmos.js` | The daylight and twilight sky (scattering model) and its light, tabulated per Sun altitude | by hand |
| `docs/dishes.js` | The 64 dishes, tilted to the pointing, on a 2D canvas | by hand |
| `docs/overlay.js` | Lines, markers, labels, pulsar blinking | by hand |
| `docs/trace.js` | The drift-trace model under the sky | by hand |
| `docs/site.json` | Site, array, pointings, calibrators, baseband dumps | **by hand** |
| `docs/catalog.json` | 3CRR, bright NVSS sources, Galactic SNRs, ATNF pulsars, stars, constellations | `tools/build_catalog.py` |
| `docs/sky.png`, `docs/sky.json` | 408 MHz sky, 2048 × 1024, ICRS plate carrée | `tools/make_sky.py` |
| `docs/horizon.json` | Terrain skyline every 0.5° of azimuth (optional: flat without it) | `tools/make_horizon.py` |
| `tools/` | The builders above, and the tests | |

To add a baseband dump or a pointing, edit `docs/site.json`. A dump's sky
position is computed from its time and pointing.

## Publishing

GitHub Pages publishes `docs/` from `main` (deploy from a branch; no
workflow, no build step): a push is a release. `docs/.nojekyll` turns
off Pages' Jekyll pass, so the files are served as they are.

Pages lets browsers cache files for 10 minutes. Someone who loaded the
page just before a push and reloads within those minutes can get new
and old modules together; a second reload clears it.

To look at a change before pushing, serve `docs/` locally
(`python3 -m http.server -d docs`) and open it in a browser.

## Tools

- `tools/build_catalog.py`: downloads 3CRR, psrcat, d3-celestial, NVSS,
  TGSS ADR1, 3CR/3C and Green's SNR catalogue and writes
  `docs/catalog.json`. Stdlib only. The radio sources in three layers:
  - **3CRR** (173): complete above 10.9 Jy at 178 MHz, but only north of
    +10° and off the Galactic plane.
  - **NVSS** (555): NVSS components within 4′ grouped into one source,
    with a spectral index from TGSS (150 MHz) summed over the group, kept
    when brighter than 5 Jy at 400 MHz, north of −40°. Named after 3CRR,
    else after 3CR/3C when the position (within twice its error, at most
    15′) and the flux (within ×3) agree, else NVSS J. Without a TGSS
    match (59, many of them HII regions with flat spectra) the index is
    unknown and the page shows the 1.4 GHz flux, not an extrapolation.
    TGSS's flux scale is off by tens of percent in some fields (3C 286
    reads 17 Jy at 150 MHz, about 30 % low).
  - **Supernova remnants** (310, Green 2024 October): drawn at their
    size; their 1 GHz flux and index give the flux in the band.
  The page scales each source's flux to the band's centre with its index.
  VizieR's servers come and go: the script tries CDS, then CfA.
- `tools/make_sky.py` / `tools/unpack_sky.py`: resample the Haslam map
  into `docs/sky.png` and `docs/sky.json`. `make_sky.py` needs numpy,
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
- `tools/test_astro.mjs`: checks `docs/astro.js` against
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
# copy docs/ to $D/web and tools/shots.mjs to $D/pp, then
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
- The Landscape layer (off by default) holds the scenery of the ground
  and dome views: the daylight, the dishes, the clouds and the terrain.
  Without it the sky is the radio sky alone and the ground is plain.
- The daylight is a model of the clear sky for the Sun's true altitude,
  added over the radio sky (radio waves pass through it). The light on
  the ground, the dishes and the clouds comes from the same model, and
  the Sun goes behind the real skyline.
- The clouds and the terrain are made up. The clouds are fractal noise
  on a steady wind. The landscape is a terrain
  function (`terrainAt` in `skygl.js`) baked once into three height maps
  and ray-marched per pixel: knolls, rocks, sagebrush, flowers and grass
  in the wind, and a lake whose shore is where the terrain meets the
  water. It is levelled where the dishes stand and along the sight lines
  to them and to the lake, so the 2D-drawn dishes are never hidden. While
  the wind blows the sky redraws every frame, at a lower resolution on a
  slow GPU (`govern` in `app.js`).

## Data and credits

The page's Credits panel lists every source. The stars and constellations
come from d3-celestial (BSD 3-clause; its notice ships in
`docs/catalog.json` and shows in the panel). The code here is under the
BSD 3-clause licence in `LICENSE`.
