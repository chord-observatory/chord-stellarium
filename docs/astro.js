// Positions on the sky for the CHORD observatory page.  Pure functions,
// no DOM, so test_astro.mjs can run them under node.
//
// Frames: catalogue positions are ICRS (J2000) unit vectors.  The
// observer's frame is ENU (x east, y north, z up) at the site.  J2000 ->
// ENU is precession (IAU 1976), nutation (the four largest terms), the
// Earth's rotation (apparent sidereal time) and the site's latitude.
// Aberration (20") and refraction are left out.  The Sun and the Moon
// follow Meeus, "Astronomical Algorithms" (2nd ed., 1998), chs. 25 and
// 47.  test_astro.mjs checks all of this against astropy.

export const DEG = Math.PI / 180;
const ARCSEC = DEG / 3600;
const TT_MINUS_UTC_S = 69.184;       // 37 leap seconds + 32.184 s, since 2017-01-01
const SIDEREAL_DEG_PER_DAY = 360.98564736629;

export const mod360 = (a) => ((a % 360) + 360) % 360;

// ---- 3-vectors and 3x3 matrices (row-major arrays of 9) ----

export const vec = (lonDeg, latDeg) => {
  const l = lonDeg * DEG, b = latDeg * DEG, c = Math.cos(b);
  return [c * Math.cos(l), c * Math.sin(l), Math.sin(b)];
};
export const lonlat = (v) => {
  const r = Math.hypot(v[0], v[1], v[2]);
  return [mod360(Math.atan2(v[1], v[0]) / DEG), Math.asin(Math.max(-1, Math.min(1, v[2] / r))) / DEG];
};
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const norm = (v) => { const r = Math.hypot(v[0], v[1], v[2]); return [v[0] / r, v[1] / r, v[2] / r]; };
export const sepDeg = (a, b) => Math.atan2(Math.hypot(...cross(a, b)), dot(a, b)) / DEG;

export const apply = (m, v) => [
  m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
  m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
  m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
];
export const mul = (a, b) => {
  const r = new Array(9);
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++)
      r[3 * i + j] = a[3 * i] * b[j] + a[3 * i + 1] * b[3 + j] + a[3 * i + 2] * b[6 + j];
  return r;
};
export const transpose = (m) => [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];
export const fromColumns = (a, b, c) => [a[0], b[0], c[0], a[1], b[1], c[1], a[2], b[2], c[2]];

// Frame rotations (IAU convention: rotate the axes by +a).
const R1 = (a) => { const c = Math.cos(a), s = Math.sin(a); return [1, 0, 0, 0, c, s, 0, -s, c]; };
const R2 = (a) => { const c = Math.cos(a), s = Math.sin(a); return [c, 0, -s, 0, 1, 0, s, 0, c]; };
export const R3 = (a) => { const c = Math.cos(a), s = Math.sin(a); return [c, s, 0, -s, c, 0, 0, 0, 1]; };

// ICRS -> Galactic (Hipparcos, ESA 1997, vol. 1, sec. 1.5.3).
export const ICRS_TO_GAL = [
  -0.0548755604, -0.8734370902, -0.4838350155,
  +0.4941094279, -0.4448296300, +0.7469822445,
  -0.8676661490, -0.1980763734, +0.4559837762,
];

// J2000 mean ecliptic -> ICRS (obliquity 23.4392911 deg).
export const ECL_TO_ICRS = R1(-23.4392911 * DEG);

// ---- Time ----

export const julianDay = (ms) => ms / 86400000 + 2440587.5;
const centuriesTT = (ms) => (julianDay(ms) + TT_MINUS_UTC_S / 86400 - 2451545.0) / 36525;

/** Greenwich mean sidereal time, degrees (IAU 1982; UT1 taken as UTC). */
export function gmstDeg(ms) {
  const d = julianDay(ms) - 2451545.0, T = d / 36525;
  return mod360(280.46061837 + SIDEREAL_DEG_PER_DAY * d + T * T * (0.000387933 - T / 38710000));
}

/** Mean obliquity of the ecliptic, radians. */
const obliquity = (T) => (23.439291111 - (46.8150 * T + 0.00059 * T * T - 0.001813 * T * T * T) / 3600) * DEG;

/** Nutation in longitude and obliquity, radians (Meeus ch. 22, ~0.5"). */
function nutation(T) {
  const om = (125.04452 - 1934.136261 * T) * DEG;
  const L = (280.4665 + 36000.7698 * T) * DEG;
  const Lm = (218.3165 + 481267.8813 * T) * DEG;
  return {
    dpsi: (-17.20 * Math.sin(om) - 1.32 * Math.sin(2 * L) - 0.23 * Math.sin(2 * Lm) + 0.21 * Math.sin(2 * om)) * ARCSEC,
    deps: (9.20 * Math.cos(om) + 0.57 * Math.cos(2 * L) + 0.10 * Math.cos(2 * Lm) - 0.09 * Math.cos(2 * om)) * ARCSEC,
  };
}

/** Precession J2000 -> mean equator and equinox of date (IAU 1976). */
function precession(T) {
  const zeta = (2306.2181 * T + 0.30188 * T * T + 0.017998 * T * T * T) * ARCSEC;
  const z = (2306.2181 * T + 1.09468 * T * T + 0.018203 * T * T * T) * ARCSEC;
  const theta = (2004.3109 * T - 0.42665 * T * T - 0.041833 * T * T * T) * ARCSEC;
  return mul(R3(-z), mul(R2(theta), R3(-zeta)));
}

// ---- The observer ----

/** Geocentric position of the site in ENU, Earth radii (Meeus ch. 11). */
function siteGeocentricEnu(latDeg, heightM) {
  const phi = latDeg * DEG, ba = 0.99664719;            // b/a for the WGS84 flattening
  const u = Math.atan(ba * Math.tan(phi)), h = heightM / 6378140;
  const rs = ba * Math.sin(u) + h * Math.sin(phi);      // rho sin(phi')
  const rc = Math.cos(u) + h * Math.cos(phi);           // rho cos(phi')
  const rho = Math.hypot(rs, rc), tilt = phi - Math.atan2(rs, rc);
  return [0, -rho * Math.sin(tilt), rho * Math.cos(tilt)];
}

/**
 * Everything that depends on the time and the site:
 *   T     Julian centuries (TT) from J2000
 *   last  local apparent sidereal time, degrees
 *   PN    J2000 -> true equator and equinox of date
 *   toEnu J2000 -> ENU; fromEnu its inverse
 *   eps   mean obliquity of date, radians
 */
export function observer(ms, site) {
  const T = centuriesTT(ms);
  const eps = obliquity(T);
  const { dpsi, deps } = nutation(T);
  const P = precession(T);
  const N = mul(R1(-(eps + deps)), mul(R3(-dpsi), R1(eps)));
  const PN = mul(N, P);
  const last = mod360(gmstDeg(ms) + (dpsi * Math.cos(eps)) / DEG + site.lon);
  const phi = site.lat * DEG, sp = Math.sin(phi), cp = Math.cos(phi);
  const H = [0, 1, 0, -sp, 0, cp, cp, 0, sp];            // hour-angle frame -> ENU
  const dateToEnu = mul(H, R3(last * DEG));
  const toEnu = mul(dateToEnu, PN);
  return {
    ms, T, eps, last, P, N, PN, toEnu, fromEnu: transpose(toEnu), dateToEnu,
    meanToEnu: mul(dateToEnu, N),
    site, siteEnu: siteGeocentricEnu(site.lat, site.height_m || 0),
  };
}

/** ENU unit vector -> [azimuth (N through E), altitude], degrees. */
export const altaz = (e) => [mod360(Math.atan2(e[0], e[1]) / DEG), Math.asin(Math.max(-1, Math.min(1, e[2]))) / DEG];
export const enuFromAltaz = (azDeg, altDeg) => {
  const a = azDeg * DEG, h = altDeg * DEG;
  return [Math.cos(h) * Math.sin(a), Math.cos(h) * Math.cos(a), Math.sin(h)];
};

/** A point of the true equator of date, (ha, dec) in degrees, as ENU. */
export const enuFromHaDec = (ob, haDeg, decDeg) =>
  apply(ob.dateToEnu, vec(ob.last - haDeg, decDeg));

/** Declination of date of a J2000 vector, degrees. */
export const decOfDate = (ob, v) => lonlat(apply(ob.PN, v))[1];

/** Milliseconds until the J2000 vector next crosses the meridian (upper transit). */
export function msToTransit(ob, v) {
  const ra = lonlat(apply(ob.PN, v))[0];
  return (mod360(ra - ob.last) / SIDEREAL_DEG_PER_DAY) * 86400000;
}

/** The beam centre for a transit telescope pointed on the meridian at declination
 *  decDeg (of date): an ENU unit vector, south of zenith when dec < latitude. */
export function boresightEnu(site, decDeg) {
  const d = (decDeg - site.lat) * DEG;
  return [0, Math.sin(d), Math.cos(d)];
}

// ---- Sun and Moon ----

/** Apparent geocentric Sun: J2000 and ENU unit vectors, distance in km (Meeus ch. 25). */
export function sun(ob) {
  const T = ob.T;
  const L0 = 280.46646 + 36000.76983 * T + 0.0003032 * T * T;
  const M = (357.52911 + 35999.05029 * T - 0.0001537 * T * T) * DEG;
  const e = 0.016708634 - 0.000042037 * T - 0.0000001267 * T * T;
  const C = (1.914602 - 0.004817 * T - 0.000014 * T * T) * Math.sin(M)
    + (0.019993 - 0.000101 * T) * Math.sin(2 * M) + 0.000289 * Math.sin(3 * M);
  const nu = M + C * DEG;
  const R = (1.000001018 * (1 - e * e)) / (1 + e * Math.cos(nu));
  const lam = (L0 + C - 0.00569) * DEG;                   // aberration; nutation is in N
  const mean = apply(R1(-ob.eps), [Math.cos(lam), Math.sin(lam), 0]);
  return { j2000: apply(transpose(ob.P), mean), enu: apply(ob.meanToEnu, mean), km: R * 149597870.7 };
}

// Meeus table 47.A: [D, M, M', F, sum_l (1e-6 deg), sum_r (1e-3 km)]
const MOON_LR = [
  [0, 0, 1, 0, 6288774, -20905355], [2, 0, -1, 0, 1274027, -3699111], [2, 0, 0, 0, 658314, -2955968],
  [0, 0, 2, 0, 213618, -569925], [0, 1, 0, 0, -185116, 48888], [0, 0, 0, 2, -114332, -3149],
  [2, 0, -2, 0, 58793, 246158], [2, -1, -1, 0, 57066, -152138], [2, 0, 1, 0, 53322, -170733],
  [2, -1, 0, 0, 45758, -204586], [0, 1, -1, 0, -40923, -129620], [1, 0, 0, 0, -34720, 108743],
  [0, 1, 1, 0, -30383, 104755], [2, 0, 0, -2, 15327, 10321], [0, 0, 1, 2, -12528, 0],
  [0, 0, 1, -2, 10980, 79661], [4, 0, -1, 0, 10675, -34782], [0, 0, 3, 0, 10034, -23210],
  [4, 0, -2, 0, 8548, -21636], [2, 1, -1, 0, -7888, 24208], [2, 1, 0, 0, -6766, 30824],
  [1, 0, -1, 0, -5163, -8379], [1, 1, 0, 0, 4987, -16675], [2, -1, 1, 0, 4036, -12831],
  [2, 0, 2, 0, 3994, -10445], [4, 0, 0, 0, 3861, -11650], [2, 0, -3, 0, 3665, 14403],
  [0, 1, -2, 0, -2689, -7003], [2, 0, -1, 2, -2602, 0], [2, -1, -2, 0, 2390, 10056],
  [1, 0, 1, 0, -2348, 6322], [2, -2, 0, 0, 2236, -9884], [0, 1, 2, 0, -2120, 5751],
  [0, 2, 0, 0, -2069, 0], [2, -2, -1, 0, 2048, -4950], [2, 0, 1, -2, -1773, 4130],
  [2, 0, 0, 2, -1595, 0], [4, -1, -1, 0, 1215, -3958], [0, 0, 2, 2, -1110, 0],
  [3, 0, -1, 0, -892, 3258], [2, 1, 1, 0, -810, 2616], [4, -1, -2, 0, 759, -1897],
  [0, 2, -1, 0, -713, -2117], [2, 2, -1, 0, -700, 2354], [2, 1, -2, 0, 691, 0],
  [2, -1, 0, -2, 596, 0], [4, 0, 1, 0, 549, -1423], [0, 0, 4, 0, 537, -1117],
  [4, -1, 0, 0, 520, -1571], [1, 0, -2, 0, -487, -1739], [2, 1, 0, -2, -399, 0],
  [0, 0, 2, -2, -381, -4421], [1, 1, 1, 0, 351, 0], [3, 0, -2, 0, -340, 0],
  [4, 0, -3, 0, 330, 0], [2, -1, 2, 0, 327, 0], [0, 2, 1, 0, -323, 1165],
  [1, 1, -1, 0, 299, 0], [2, 0, 3, 0, 294, 0], [2, 0, -1, -2, 0, 8752],
];
// Meeus table 47.B: [D, M, M', F, sum_b (1e-6 deg)]
const MOON_B = [
  [0, 0, 0, 1, 5128122], [0, 0, 1, 1, 280602], [0, 0, 1, -1, 277693], [2, 0, 0, -1, 173237],
  [2, 0, -1, 1, 55413], [2, 0, -1, -1, 46271], [2, 0, 0, 1, 32573], [0, 0, 2, 1, 17198],
  [2, 0, 1, -1, 9266], [0, 0, 2, -1, 8822], [2, -1, 0, -1, 8216], [2, 0, -2, -1, 4324],
  [2, 0, 1, 1, 4200], [2, 1, 0, -1, -3359], [2, -1, -1, 1, 2463], [2, -1, 0, 1, 2211],
  [2, -1, -1, -1, 2065], [0, 1, -1, -1, -1870], [4, 0, -1, -1, 1828], [0, 1, 0, 1, -1794],
  [0, 0, 0, 3, -1749], [0, 1, -1, 1, -1565], [1, 0, 0, 1, -1491], [0, 1, 1, 1, -1475],
  [0, 1, 1, -1, -1410], [0, 1, 0, -1, -1344], [1, 0, 0, -1, -1335], [0, 0, 3, 1, 1107],
  [4, 0, 0, -1, 1021], [4, 0, -1, 1, 833],
];

/** Topocentric Moon: J2000 and ENU unit vectors, geocentric distance in km (Meeus ch. 47). */
export function moon(ob) {
  const T = ob.T, T2 = T * T, T3 = T2 * T, T4 = T3 * T;
  const Lp = 218.3164477 + 481267.88123421 * T - 0.0015786 * T2 + T3 / 538841 - T4 / 65194000;
  const D = (297.8501921 + 445267.1114034 * T - 0.0018819 * T2 + T3 / 545868 - T4 / 113065000) * DEG;
  const M = (357.5291092 + 35999.0502909 * T - 0.0001536 * T2 + T3 / 24490000) * DEG;
  const Mp = (134.9633964 + 477198.8675055 * T + 0.0087414 * T2 + T3 / 69699 - T4 / 14712000) * DEG;
  const F = (93.2720950 + 483202.0175233 * T - 0.0036539 * T2 - T3 / 3526000 + T4 / 863310000) * DEG;
  const E = 1 - 0.002516 * T - 0.0000074 * T2;
  const A1 = (119.75 + 131.849 * T) * DEG, A2 = (53.09 + 479264.290 * T) * DEG, A3 = (313.45 + 481266.484 * T) * DEG;
  const ecc = (m) => (Math.abs(m) === 2 ? E * E : Math.abs(m) === 1 ? E : 1);
  let sl = 0, sr = 0, sb = 0;
  for (const [d, m, mp, f, l, r] of MOON_LR) {
    const arg = d * D + m * M + mp * Mp + f * F, k = ecc(m);
    sl += l * k * Math.sin(arg);
    sr += r * k * Math.cos(arg);
  }
  for (const [d, m, mp, f, b] of MOON_B) sb += b * ecc(m) * Math.sin(d * D + m * M + mp * Mp + f * F);
  const LpR = Lp * DEG;
  sl += 3958 * Math.sin(A1) + 1962 * Math.sin(LpR - F) + 318 * Math.sin(A2);
  sb += -2235 * Math.sin(LpR) + 382 * Math.sin(A3) + 175 * Math.sin(A1 - F) + 175 * Math.sin(A1 + F)
    + 127 * Math.sin(LpR - Mp) - 115 * Math.sin(LpR + Mp);
  const lam = (Lp + sl / 1e6) * DEG, bet = (sb / 1e6) * DEG, km = 385000.56 + sr / 1000;
  const ecl = [Math.cos(bet) * Math.cos(lam), Math.cos(bet) * Math.sin(lam), Math.sin(bet)];
  const mean = apply(R1(-ob.eps), ecl);
  const geo = apply(ob.meanToEnu, mean);
  const re = 6378.14;
  const t = [geo[0] * km - ob.siteEnu[0] * re, geo[1] * km - ob.siteEnu[1] * re, geo[2] * km - ob.siteEnu[2] * re];
  const topo = norm(t);
  return { j2000: apply(ob.fromEnu, topo), enu: topo, km, topoKm: Math.hypot(...t) };
}

/** Moon phase: illuminated fraction and phase angle (degrees) from the two bodies. */
export function moonPhase(s, m) {
  const psi = Math.acos(Math.max(-1, Math.min(1, dot(s.enu, m.enu))));
  const i = Math.atan2(s.km * Math.sin(psi), m.km - s.km * Math.cos(psi));
  return { illuminated: (1 + Math.cos(i)) / 2, phaseDeg: i / DEG };
}

// ---- Planets ----

// E. M. Standish, "Keplerian Elements for Approximate Positions of the
// Major Planets" (JPL), table 1: valid 1800-2050, mean ecliptic and equinox
// of J2000.  Per body: [a (au), e, I, L, longitude of perihelion, longitude
// of the node (deg)] and their rates per Julian century.  EMB is the
// Earth-Moon barycentre.
const PLANET_ELEMENTS = {
  Mercury: [[0.38709927, 0.20563593, 7.00497902, 252.25032350, 77.45779628, 48.33076593],
    [0.00000037, 0.00001906, -0.00594749, 149472.67411175, 0.16047689, -0.12534081]],
  Venus: [[0.72333566, 0.00677672, 3.39467605, 181.97909950, 131.60246718, 76.67984255],
    [0.00000390, -0.00004107, -0.00078890, 58517.81538729, 0.00268329, -0.27769418]],
  EMB: [[1.00000261, 0.01671123, -0.00001531, 100.46457166, 102.93768193, 0.0],
    [0.00000562, -0.00004392, -0.01294668, 35999.37244981, 0.32327364, 0.0]],
  Mars: [[1.52371034, 0.09339410, 1.84969142, -4.55343205, -23.94362959, 49.55953891],
    [0.00001847, 0.00007882, -0.00813131, 19140.30268499, 0.44441088, -0.29257343]],
  Jupiter: [[5.20288700, 0.04838624, 1.30439695, 34.39644051, 14.72847983, 100.47390909],
    [-0.00011607, -0.00013253, -0.00183714, 3034.74612775, 0.21252668, 0.20469106]],
  Saturn: [[9.53667594, 0.05386179, 2.48599187, 49.95424423, 92.59887831, 113.66242448],
    [-0.00125060, -0.00050991, 0.00193609, 1222.49362201, -0.41897216, -0.28867794]],
  Uranus: [[19.18916464, 0.04725744, 0.77263783, 313.23810451, 170.95427630, 74.01692503],
    [-0.00196176, -0.00004397, -0.00242939, 428.48202785, 0.40805281, 0.04240589]],
  Neptune: [[30.06992276, 0.00859048, 1.77004347, -55.12002969, 44.96476227, 131.78422574],
    [0.00026291, 0.00005105, 0.00035372, 218.45945325, -0.32241464, -0.00508664]],
};
export const PLANETS = ["Mercury", "Venus", "Mars", "Jupiter", "Saturn", "Uranus", "Neptune"];
const LIGHT_AU_PER_CENTURY = 173.1446327 * 36525;

/** Heliocentric J2000 equatorial position (au) of a body at T centuries (TT). */
function heliocentric(name, T) {
  const [el, rate] = PLANET_ELEMENTS[name];
  const [a, e, I, L, peri, node] = el.map((x, i) => x + rate[i] * T);
  const w = (peri - node) * DEG, M = (mod360(L - peri + 180) - 180) * DEG;
  let E = M + e * Math.sin(M);
  for (let k = 0; k < 12; k++) {
    const d = (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
    E -= d;
    if (Math.abs(d) < 1e-12) break;
  }
  const xp = a * (Math.cos(E) - e), yp = a * Math.sqrt(1 - e * e) * Math.sin(E);
  const cw = Math.cos(w), sw = Math.sin(w), cn = Math.cos(node * DEG), sn = Math.sin(node * DEG);
  const ci = Math.cos(I * DEG), si = Math.sin(I * DEG);
  return apply(ECL_TO_ICRS, [
    (cw * cn - sw * sn * ci) * xp + (-sw * cn - cw * sn * ci) * yp,
    (cw * sn + sw * cn * ci) * xp + (-sw * sn + cw * cn * ci) * yp,
    sw * si * xp + cw * si * yp,
  ]);
}

/** The planets as seen from the Earth (geocentric, light time included):
 *  [{ name, j2000, enu, au }].  Good to about an arcminute in 1800-2050. */
export function planets(ob) {
  const earth = heliocentric("EMB", ob.T);
  return PLANETS.map((name) => {
    let p = heliocentric(name, ob.T);
    let d = [p[0] - earth[0], p[1] - earth[1], p[2] - earth[2]];
    p = heliocentric(name, ob.T - Math.hypot(...d) / LIGHT_AU_PER_CENTURY);   // where the light left
    d = [p[0] - earth[0], p[1] - earth[1], p[2] - earth[2]];
    const v = norm(d);
    return { name, j2000: v, enu: apply(ob.toEnu, v), au: Math.hypot(...d) };
  });
}

// ---- Instrument and cosmology ----

export const HI_REST_MHZ = 1420.405751768;

/** Lookback time in Gyr to redshift z (flat LCDM, Planck 2018: H0 67.66, Om 0.3111). */
export function lookbackGyr(z) {
  const H0 = 67.66, Om = 0.3111, hubbleGyr = 977.792 / H0, n = 400;
  const f = (x) => 1 / ((1 + x) * Math.sqrt(Om * (1 + x) ** 3 + 1 - Om));
  let s = f(0) + f(z);
  for (let k = 1; k < n; k++) s += (k % 2 ? 4 : 2) * f((z * k) / n);
  return (hubbleGyr * s * z) / (3 * n);
}

/** Frequencies for the band average: n samples evenly spaced in 1/f, low to high. */
export function bandSamples(loMHz, hiMHz, n) {
  const out = [];
  for (let k = 0; k < n; k++) {
    const s = n === 1 ? 0.5 : k / (n - 1);
    out.push(1 / (1 / loMHz + s * (1 / hiMHz - 1 / loMHz)));
  }
  return out;
}

/** Primary-beam half-power width, degrees, scaled as 1/f from the 300 MHz value. */
export const hpbwDeg = (array, fMHz) => (array.hpbw_deg_at_300mhz * 300) / fMHz;

/** Primary beam power at offset thetaDeg (Gaussian main lobe). */
export const primaryBeam = (array, fMHz, thetaDeg) => {
  const w = hpbwDeg(array, fMHz);
  return Math.exp((-4 * Math.LN2 * thetaDeg * thetaDeg) / (w * w));
};
