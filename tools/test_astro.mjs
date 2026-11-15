// Check the page's astro.js against astropy (astro_ref.json, from astro_ref.py).
//
//   node test_astro.mjs <webroot>/observatory/astro.js astro_ref.json
//
// Exits 1 if any position is off by more than its tolerance.  Tolerances:
// sidereal time 0.5 s (astro.js takes UT1 as UTC; astropy uses the IERS
// UT1-UTC), fixed sources 30" (astro.js leaves out aberration), the Sun
// 0.01 deg, the Moon 0.05 deg and 100 km (truncated series), the planets
// 0.05 deg, Jupiter and Saturn 0.2 deg (JPL's mean elements leave out
// their great inequality; the table quotes errors of 400" and 600").

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const [astroPath, refPath] = process.argv.slice(2);
const A = await import(pathToFileURL(resolve(astroPath)).href);
const ref = JSON.parse(readFileSync(refPath, "utf8"));

const SOURCES = {
  "Tau A": [83.63308, 22.01450], "Cyg A": [299.86815, 40.73392], "Cas A": [350.86642, 58.81178],
  "Vir A": [187.70593, 12.39112], "Sgr A*": [266.41683, -29.00781], "Polaris": [37.95456, 89.26411],
};
const TOL = { lst: 7.5 / 3600, source: 30 / 3600, sun: 0.01, moon: 0.05, planet: 0.05, giant: 0.2 };

// Angular distance between two (az, alt) pairs, degrees.
const offset = (az1, alt1, az2, alt2) => A.sepDeg(A.enuFromAltaz(az1, alt1), A.enuFromAltaz(az2, alt2));

const worst = { lst: 0, source: 0, sun: 0, moon: 0, planet: 0, giant: 0 };
let failed = 0;
const check = (kind, what, err) => {
  worst[kind] = Math.max(worst[kind], err);
  if (err > TOL[kind]) {
    failed++;
    console.log(`FAIL ${what}: ${(err * 3600).toFixed(1)}" (tolerance ${(TOL[kind] * 3600).toFixed(0)}")`);
  }
};

for (const t of ref.times) {
  const ob = A.observer(Date.parse(t.utc), ref.site);
  const dl = Math.abs(((ob.last - t.last_deg + 540) % 360) - 180);
  check("lst", `${t.utc} LAST`, dl);
  for (const [name, [ra, dec]] of Object.entries(SOURCES)) {
    const [az, alt] = A.altaz(A.apply(ob.toEnu, A.vec(ra, dec)));
    const r = t.sources[name];
    check("source", `${t.utc} ${name}`, offset(az, alt, r.az, r.alt));
  }
  const s = A.sun(ob), m = A.moon(ob);
  const [saz, salt] = A.altaz(s.enu), [maz, malt] = A.altaz(m.enu);
  check("sun", `${t.utc} Sun`, offset(saz, salt, t.sun.az, t.sun.alt));
  check("moon", `${t.utc} Moon`, offset(maz, malt, t.moon.az, t.moon.alt));
  const dkm = Math.abs(m.topoKm - t.moon.dist_km);
  if (dkm > 100) { failed++; console.log(`FAIL ${t.utc} Moon distance off by ${dkm.toFixed(0)} km`); }
  for (const p of A.planets(ob)) {
    const r = t.planets[p.name], [paz, palt] = A.altaz(p.enu);
    const kind = p.name === "Jupiter" || p.name === "Saturn" ? "giant" : "planet";
    check(kind, `${t.utc} ${p.name}`, offset(paz, palt, r.az, r.alt));
  }
}

for (const [k, v] of Object.entries(worst)) console.log(`worst ${k}: ${(v * 3600).toFixed(2)}"`);

// Lookback time against the closed-form age of a flat LCDM universe,
// t(z) = 2 / (3 H0 sqrt(OL)) asinh(sqrt(OL / Om) (1 + z)^-1.5).
const age = (z) => (2 * 977.792 / 67.66 / (3 * Math.sqrt(0.6889))) * Math.asinh(Math.sqrt(0.6889 / 0.3111) * (1 + z) ** -1.5);
for (const z of [0.1, 0.5, 1, 2, 8.5]) {
  const got = A.lookbackGyr(z), want = age(0) - age(z);
  if (Math.abs(got - want) > 0.001) { failed++; console.log(`FAIL lookback z=${z}: ${got.toFixed(4)} Gyr, want ${want.toFixed(4)}`); }
}

console.log(failed ? `${failed} failures` : "all passed");
process.exit(failed ? 1 : 0);
