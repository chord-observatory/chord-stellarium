// The daylight and twilight sky: scattering by air (Rayleigh) and aerosol
// (Mie), with ozone absorption, in a spherical atmosphere lit by the Sun at
// its true altitude.  Single scattering is integrated along each view; the
// higher orders, which light the Earth's shadow, are approximated as an
// isotropic source as bright as the mean single-scattered sky.  The sky
// depends only on the view's altitude and its azimuth from the Sun, so it
// is tabulated in those two (skyModel), once per change of the Sun's
// altitude, and the shader looks it up.  Coefficients (1/km): Bruneton's
// precomputed-atmosphere reference (2017).
//
// The table holds display values: an exposure that follows the brightness
// of the sky (the eye adapts) down to a floor, below which the sky goes
// dark, a shift toward blue in dim light, then a filmic curve.  Light for the clouds, the ground and the
// dishes goes out as exposed linear radiances of a white surface (sunLin,
// ambLin), for the same curve (curve(); the shader has a copy).

export const LUT_W = 64, LUT_H = 64;
export const LUT_ALT_MIN = -12, LUT_ALT_SPAN = 102;   // rows: alt = min + span v^2

const R = 6360, RT = 6420, H0 = 0.55;                 // ground, top of the air, the site (km)
const BR = [5.802e-3, 13.558e-3, 33.1e-3];
const BM = 3.996e-3, BME = 4.44e-3, G = 0.8;
const BO = [0.65e-3, 1.881e-3, 0.085e-3];
const HR = 8.0, HM = 1.2;
const SUN = 20;                                       // solar irradiance (arbitrary units)
const GROUND_ALBEDO = 0.25;
const VIEW_N = 24;
const KEY = 0.24;                                     // exposure: the upper sky's linear level on display
const FLOOR_SUN = -4.5;                               // below this Sun altitude the eye stops adapting
const STRENGTH = 0.62;                                // the optical sky's share of the display, over the radio sky
const SATURATION = 1.6;                               // on display: a clear sky looks bluer than a plain curve gives

const DEG = Math.PI / 180;
const ozone = (h) => Math.max(0, 1 - Math.abs(h - 25) / 15);

// Optical depth to the top of the air from height h along a ray whose
// zenith cosine there is mu, tabulated in sqrt(h / 60) and sqrt((mu + 0.2) / 1.2).
// Rays that meet the ground hold Infinity.
const TH = 48, TM = 256;
const tab = [new Float32Array(TH * TM), new Float32Array(TH * TM), new Float32Array(TH * TM)];
for (let i = 0; i < TH; i++) {
  const r0 = R + 60 * (i / (TH - 1)) ** 2;
  for (let j = 0; j < TM; j++) {
    const mu = -0.2 + 1.2 * (j / (TM - 1)) ** 2, o = i * TM + j;
    const b = r0 * mu, g = b * b - (r0 * r0 - R * R);
    if (g > 0 && -b - Math.sqrt(g) > 0) { tab[0][o] = tab[1][o] = tab[2][o] = Infinity; continue; }
    const tTop = -b + Math.sqrt(Math.max(0, b * b - (r0 * r0 - RT * RT))), n = 32, ds = tTop / n;
    let dr = 0, dm = 0, dO = 0;
    for (let k = 0; k < n; k++) {
      const t = (k + 0.5) * ds, h = Math.sqrt(r0 * r0 + t * t + 2 * r0 * t * mu) - R;
      dr += Math.exp(-h / HR); dm += Math.exp(-h / HM); dO += ozone(h);
    }
    tab[0][o] = dr * ds; tab[1][o] = dm * ds; tab[2][o] = dO * ds;
  }
}

/** Optical depths [Rayleigh, Mie, ozone] to the top from height h along zenith
 *  cosine mu, into out; false when the ray meets the ground. */
function depth(h, mu, out) {
  const fi = Math.sqrt(Math.min(1, Math.max(0, h / 60))) * (TH - 1);
  const fj = Math.sqrt(Math.min(1, Math.max(0, (mu + 0.2) / 1.2))) * (TM - 1);
  const i = Math.min(TH - 2, Math.floor(fi)), j = Math.min(TM - 2, Math.floor(fj)), a = fi - i, c = fj - j;
  const o = i * TM + j;
  for (let k = 0; k < 3; k++) {
    const t = tab[k], v00 = t[o], v01 = t[o + 1], v10 = t[o + TM], v11 = t[o + TM + 1];
    if (v00 + v01 + v10 + v11 === Infinity) return false;
    out[k] = (v00 * (1 - c) + v01 * c) * (1 - a) + (v10 * (1 - c) + v11 * c) * a;
  }
  return true;
}
const scratch = new Float64Array(3);

const ext = (d, k) => Math.exp(-(BR[k] * d[0] + BME * d[1] + BO[k] * d[2]));

/** Sunlight at height h (km) above the site for a Sun at altitude alt (deg), per channel, 0..1. */
export function sunTransmit(altDeg, h) {
  const d = new Float64Array(3);
  return depth(H0 + h, Math.sin(altDeg * DEG), d) ? [0, 1, 2].map((k) => ext(d, k)) : [0, 0, 0];
}

/** Along altitude alt, azimuth phi from the Sun: the single-scattered radiance
 *  ss and the in-scatter weight w of an isotropic source of unit radiance. */
function view(alt, phi, sunAlt) {
  const ca = Math.cos(alt);
  const dx = ca * Math.sin(phi), dy = ca * Math.cos(phi), dz = Math.sin(alt);
  const sy = Math.cos(sunAlt), sz = Math.sin(sunAlt);
  const pz = R + H0, b = pz * dz, g = b * b - (pz * pz - R * R);
  const tMax = g > 0 && -b - Math.sqrt(g) > 0 ? -b - Math.sqrt(g) : -b + Math.sqrt(b * b - (pz * pz - RT * RT));
  const mu = dx * 0 + dy * sy + dz * sz;
  const pr = (3 / (16 * Math.PI)) * (1 + mu * mu);
  const pm = (3 / (8 * Math.PI)) * ((1 - G * G) * (1 + mu * mu)) / ((2 + G * G) * Math.pow(1 + G * G - 2 * G * mu, 1.5));
  const vd = [0, 0, 0], ss = [0, 0, 0], w = [0, 0, 0];
  for (let i = 0; i < VIEW_N; i++) {
    const t = tMax * ((i + 0.5) / VIEW_N) ** 2;                 // denser near the eye
    const ds = tMax * (2 * i + 1) / (VIEW_N * VIEW_N);
    const x = t * dx, y = t * dy, z = pz + t * dz, r = Math.sqrt(x * x + y * y + z * z), h = r - R;
    const dr = Math.exp(-h / HR) * ds, dm = Math.exp(-h / HM) * ds, dO = ozone(h) * ds;
    vd[0] += dr / 2; vd[1] += dm / 2; vd[2] += dO / 2;
    const lit = depth(h, (y * sy + z * sz) / r, scratch);
    for (let k = 0; k < 3; k++) {
      const tv = ext(vd, k), sc = BR[k] * dr, sm = BM * dm;
      w[k] += tv * (sc + sm) / (4 * Math.PI);
      if (lit) ss[k] += tv * ext(scratch, k) * (sc * pr + sm * pm);
    }
    vd[0] += dr / 2; vd[1] += dm / 2; vd[2] += dO / 2;
  }
  return { ss: ss.map((x) => x * SUN), w };
}

const lum = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
export const curve = (x) => Math.pow(1 - Math.exp(-x), 1 / 2.2);

/** Radiance over the LUT grid for a Sun at sunAlt (deg), and the mean over the sky. */
function table(sunAlt) {
  const rows = [], mean = [0, 0, 0];
  let nw = 0;
  for (let j = 0; j < LUT_H; j++) {
    const v = j / (LUT_H - 1), alt = LUT_ALT_MIN + LUT_ALT_SPAN * v * v;
    const cols = [];
    for (let i = 0; i < LUT_W; i++) cols.push(view(alt * DEG, (i / (LUT_W - 1)) * Math.PI, sunAlt * DEG));
    rows.push({ alt, cols });
    if (alt > 0) {
      const wt = Math.sin(alt * DEG) * Math.cos(alt * DEG) * (j ? v : 0);   // cosine-weighted, d(alt) ~ v dv
      for (const c of cols) for (let k = 0; k < 3; k++) mean[k] += c.ss[k] * wt;
      nw += wt * LUT_W;
    }
  }
  // The mean radiance the sky and the sunlit ground send into the air.
  const gT = sunTransmit(sunAlt, 0), sinS = Math.max(0, Math.sin(sunAlt * DEG));
  const src = mean.map((m, k) => (m / nw) * 0.5 + 0.5 * (GROUND_ALBEDO / Math.PI) * (SUN * gT[k] * sinS + Math.PI * m / nw));
  for (const r of rows) for (const c of r.cols) c.L = c.ss.map((s, k) => s + src[k] * c.w[k] * 4 * Math.PI);
  return { rows, mean: mean.map((m) => m / nw) };
}

function reference(rows) {
  let s = 0, n = 0;
  for (const r of rows) if (r.alt >= 8 && r.alt <= 60) for (const c of r.cols) { s += lum(c.L); n++; }
  return s / n;
}

let floorRef = null, dayRef = null;

/**
 * The sky for a Sun at altitude sunAlt (deg): { lut: RGBA8, LUT_W x LUT_H,
 * of display values; sunLin: a white surface facing the Sun, at the ground;
 * sunLow, sunHigh: the same at 2 and 8 km (the clouds); ambLin: a white
 * level surface under the sky alone; all exposed, linear }.
 */
export function skyModel(sunAlt) {
  if (floorRef == null) { floorRef = reference(table(FLOOR_SUN).rows); dayRef = reference(table(30).rows); }
  const alt = Math.max(sunAlt, -20);
  const { rows, mean } = table(alt);
  const ref = reference(rows), E = KEY / Math.max(ref, floorRef);
  // In dim light the eye shifts toward blue (the Purkinje effect): the blue hour.
  const dim = Math.min(1, Math.max(0, Math.log10(dayRef / ref) / 2.2));
  const tint = [1 - 0.38 * dim, 1 - 0.1 * dim, 1 + 0.3 * dim];
  const lut = new Uint8Array(LUT_W * LUT_H * 4);
  for (let j = 0; j < LUT_H; j++) for (let i = 0; i < LUT_W; i++) {
    const c = rows[j].cols[i].L, o = 4 * (j * LUT_W + i);
    const d = [0, 1, 2].map((k) => curve(c[k] * E * tint[k])), y = lum(d);
    for (let k = 0; k < 3; k++) lut[o + k] = Math.round(255 * STRENGTH * Math.min(1, Math.max(0, y + (d[k] - y) * SATURATION)));
    lut[o + 3] = 255;
  }
  const sun = (h) => sunTransmit(sunAlt, h).map((t, k) => (t * SUN * E * tint[k]) / Math.PI);
  return { lut, E, sunLin: sun(0.002), sunLow: sun(2), sunHigh: sun(8), ambLin: mean.map((m, k) => m * 1.6 * E * tint[k]), strength: STRENGTH };
}
