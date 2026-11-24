// The observatory page: state, controls, the render loop and the panels.

import * as A from "./astro.js";
import { makeCamera, fitScale, unproject, toPlane, STEREO, MOLL, CAR } from "./proj.js";
import { SkyGL } from "./skygl.js";
import { Overlay, drawPulsarBlink, setFont, COLORS } from "./overlay.js";
import { Trace } from "./trace.js";
import { skyModel } from "./atmos.js";
import { drawDishes, EYE_M, ARRAY_AT } from "./dishes.js";

const $ = (id) => document.getElementById(id);
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const fmt = (x, d = 1) => (x == null ? "–" : (Math.abs(x) < 0.5 * 10 ** -d ? 0 : Number(x)).toFixed(d));

const LAYERS = [
  ["stars", "Stars", true, "#e8ecff"],
  ["constellations", "Constellations", true, "rgba(150,170,215,0.7)"],
  ["calib", "Calibrators", true, "#ffd479"],
  ["sources", "3CRR sources", true, "#ffb46e"],
  ["nvss", "NVSS sources", true, "#b9a7ff"],
  ["snrs", "Supernova remnants", true, "#b6e58a"],
  ["pulsars", "Pulsars", true, "#7fdfff"],
  ["frbs", "Fast radio bursts", true, "#e2c4d4"],
  ["dumps", "Baseband dumps", true, "#ff86d8"],
  ["sunmoon", "Sun and Moon", true, "#ffe08a"],
  ["planets", "Planets", true, "#eed8b2"],
  ["strip", "Drift strip", true, "#ffffff"],
  ["trace", "Drift trace", true, "rgb(255,205,120)"],
  ["horizon", "Horizon", true, "rgb(150,220,175)"],
  ["land", "Landscape", true, "#c8b27a"],
  ["ecliptic", "Ecliptic", true, "rgb(240,205,110)"],
  ["grid_eq", "RA / Dec grid", false, "rgb(150,175,225)"],
  ["grid_gal", "Galactic grid", false, "rgb(225,165,125)"],
  ["grid_altaz", "Alt-az grid", false, "rgb(130,205,165)"],
  ["labels", "Labels", true, "#c9d3ea"],
];
const SPEEDS = [1, 60, 600, 3600, 21600];
const SKY_STRETCH = [0.06, 0.86];       // sky.png values shown as black and as white
const PANEL_W = 336, TRACE_H = 120;
// Where each camera view starts: facing south (the beam), at the horizon
// or the zenith.  The ground view's tilt (null here) depends on the beam.
const AIM = { ground: { az0: 180, alt0: null }, dome: { az0: 180, alt0: 90 } };
const GROUND_FOV = 100;                  // degrees across the free area at the ground view's start
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
const WIND = [0.92, 0.38];               // the made-up wind blows toward east-northeast (unit vector)
const MOON_LIGHT = [0.13, 0.145, 0.165]; // full moonlight on a white surface, exposed linear (bright enough to see by)
const ANIM_MS = 33;                      // frame interval while the wind blows
const RES_START = 1, RES_MIN = 0.35;     // sky pixels per CSS pixel while the wind blows: at first at most, and the least (see govern, landProbe)
const RES_PROBE = 0.25;                  // and for the frame that measures the GPU (landProbe)

const st = {
  live: true, t: Date.now(), playing: true, speed: 1,
  pointing: null, customDec: null,
  view: { kind: "ground", proj: MOLL, frame: "eq", az0: 180, alt0: null, lon0: 0, zoom: null, pan: [0, 0], w: 0, h: 0 },
  band: [400, 800], beamMode: "dish", skyGain: 0.85,
  layers: Object.fromEntries(LAYERS.map(([k, , on]) => [k, on])),
  selected: null,
};

let site, cat, frbCat, skyMeta, horizon, gl, overlay, trace, data, cam, frame, glParams, dpr = 1;
let glScale = 1, scaleAt = 0, scaleHold = 0, scaleOk = 0, windOn = false, windSkip = false, windDts = [], windStalls = 0;   // the sky canvas's resolution while the wind blows (see govern)
let dirty = true, lastDraw = 0, lastWind = 0, lastPanels = 0, lastHash = 0, hits = [], blink = [];
const nameIndex = new Map();             // search names -> objects

// ---------------------------------------------------------------- loading

async function load() {
  const get = (u) => fetch(u).then((r) => { if (!r.ok) throw new Error(`${u}: ${r.status}`); return r.json(); });
  const img = new Image();
  const imgLoaded = new Promise((ok, bad) => { img.onload = ok; img.onerror = () => bad(new Error("sky.png did not load")); });
  img.src = "sky.png";
  // The skyline is optional: without it the horizon is flat.
  const flat = { alt_deg: new Array(720).fill(0), dist_km: new Array(720).fill(0), step_deg: 0.5, flat: true };
  // The fast radio bursts are optional too: without them the layer is empty.
  [site, cat, skyMeta, horizon, frbCat] = await Promise.all([get("site.json"), get("catalog.json"), get("sky.json"),
    get("horizon.json").catch(() => flat), get("frbs.json").catch(() => null), imgLoaded]);
  return img;
}

/** Altitude (deg) of the terrain skyline at azimuth az (deg from north through east). */
function skyline(az) {
  const a = horizon.alt_deg, n = a.length, x = (A.mod360(az) / 360) * n, i = Math.floor(x) % n, f = x - Math.floor(x);
  return a[i] + f * (a[(i + 1) % n] - a[i]);
}

function buildData() {
  const hl = new Set(site.highlight_pulsars);
  const rows = (t) => t.rows.map((r) => Object.fromEntries(t.cols.map((c, i) => [c, r[i]])));
  const calibrators = site.calibrators.map((c) => ({ ...c, v: A.vec(c.ra, c.dec) }));
  const calNames = new Set(calibrators.flatMap((c) => [c.name, c.alias]));
  calibrators.forEach((c) => (c.obj = { type: "calibrator", ...c }));
  const sources3c = rows(cat.sources_3crr).filter((s) => !calNames.has(s.name)).map((s) => {
    const o = { type: "3crr", name: s.name, ra: s.ra, dec: s.dec, s178: s.s178_jy, z: s.z, alpha: s.alpha, fr: s.fr, v: A.vec(s.ra, s.dec) };
    return { ...o, obj: o };
  });
  const snrs = rows(cat.snrs).map((s) => {
    const others = s.other ? s.other.split(",").map((x) => x.trim()).filter(Boolean) : [];
    const v = A.vec(s.ra, s.dec);
    const o = { type: "snr", name: others[0] || s.name, gname: s.name, others, ra: s.ra, dec: s.dec,
      size: [s.size_a_arcmin, s.size_b_arcmin], kind: s.type, s1000: s.s1000_jy, alpha: s.alpha, v,
      atCalibrator: calibrators.some((c) => A.sepDeg(c.v, v) < 0.2) };   // Cas A, the Crab: the calibrator's label covers it
    return { ...o, obj: o };
  });
  // A compact remnant (10' or less) is the NVSS source on it: with both
  // layers on, the remnant is drawn.  A large one is not: NVSS resolves it
  // out, and what it lists there (W51 in W51C) is something else.
  const compactSnrs = snrs.filter((s) => Math.sqrt(s.size[0] * s.size[1]) <= 10);
  const nvss = rows(cat.sources_nvss).map((s) => {
    const v = A.vec(s.ra, s.dec);
    const snr = compactSnrs.find((r) => A.sepDeg(r.v, v) * 60 <= Math.sqrt(r.size[0] * r.size[1]) / 2 + 1);
    const o = { type: "nvss", name: s.name, nvssName: s.nvss, threec: s.threec, ra: s.ra, dec: s.dec, s1400: s.s1400_jy,
      s150: s.s150_jy, alpha: s.alpha, components: s.components, crr: s.crr, inSnr: snr ? snr.name : "", v };
    return { ...o, obj: o };
  });
  const pulsars = rows(cat.pulsars).map((p) => {
    // Flux at 400 MHz, or the 1400 MHz flux scaled with a spectral index of -1.6.
    const flux = p.s400_mjy ?? p.s1400_mjy * (1400 / 400) ** 1.6;
    const o = { type: "pulsar", name: p.name, jname: p.jname, ra: p.ra, dec: p.dec, p0: p.p0_s, dm: p.dm,
      s400: p.s400_mjy, s1400: p.s1400_mjy, assoc: p.assoc, v: A.vec(p.ra, p.dec), highlight: hl.has(p.name) };
    return { ...o, flux, obj: o };
  });
  const stars = rows(cat.stars).map((s) => {
    const o = { type: "star", name: s.name, ra: s.ra, dec: s.dec, mag: s.mag, bv: s.bv, v: A.vec(s.ra, s.dec) };
    return { ...o, rgb: starRGB(s.bv), obj: s.name ? o : null };
  });
  const conLines = cat.constellations.lines.map((seg) => {
    const out = [];
    for (let i = 0; i + 1 < seg.length; i += 2) {
      const a = A.vec(seg[i], seg[i + 1]);
      if (out.length) {                                     // densify long segments so they curve
        const b = out[out.length - 1], n = Math.ceil(A.sepDeg(a, b) / 2);
        for (let k = 1; k < n; k++) out.push(A.norm(b.map((x, j) => x + ((a[j] - x) * k) / n)));
      }
      out.push(a);
    }
    return out;
  });
  const conNames = cat.constellations.names.map(([abbr, name, ra, dec]) => ({ abbr, name, v: A.vec(ra, dec) }));
  const dumps = site.dumps.map((d) => {
    const ms = Date.parse(d.utc), ob = A.observer(ms, site.site);
    const dec = pointingDec(ob, d.pointing);
    const v = A.apply(ob.fromEnu, A.boresightEnu(site.site, dec));
    const [ra, dd] = A.lonlat(v);
    const o = { type: "dump", name: d.name, ms, note: d.note, ra, dec: dd, v };
    return { ...o, label: `dump ${d.utc.slice(5, 10)} ${d.utc.slice(11, 16)}Z`, obj: o };
  });
  // One-off bursts, then the repeating sources (one entry each).
  const frb = (f, repeater) => {
    const o = { type: "frb", name: f.name, ra: f.ra, dec: f.dec, v: A.vec(f.ra, f.dec), err: f.err_deg, dm: f.dm, dmExc: f.dm_exc,
      repeater, fluence: repeater ? f.fluence_max_jy_ms : f.fluence_jy_ms, mjd: repeater ? null : f.mjd,
      bursts: repeater ? f.bursts : 1, first: f.mjd_first, last: f.mjd_last };
    return { ...o, obj: o };
  };
  const frbs = frbCat ? [...rows(frbCat.bursts).map((f) => frb(f, false)), ...rows(frbCat.repeaters).map((f) => frb(f, true))] : [];
  return { calibrators, sources3c, nvss, snrs, pulsars, frbs, stars, conLines, conNames, dumps };
}

/** Flux density (Jy) of a catalogue source at f MHz, from its catalogue
 *  flux and spectral index.  Without an index the catalogue's own flux
 *  stands, not extrapolated (the NVSS sources TGSS missed, many of them
 *  HII regions with flat spectra; Green's SNRs without an index). */
function fluxAt(o, f) {
  if (o.type === "3crr") return o.s178 != null ? o.s178 * (f / 178) ** -(o.alpha ?? 0.8) : null;   // 3CRR: S ~ f^-alpha
  if (o.type === "nvss") return o.alpha != null ? o.s1400 * (f / 1400) ** o.alpha : o.s1400;
  if (o.type === "snr") return o.s1000 == null ? null : o.alpha != null ? o.s1000 * (f / 1000) ** o.alpha : o.s1000;
  return null;
}

function starRGB(bv) {
  const stops = [[-0.3, [155, 176, 255]], [0, [202, 215, 255]], [0.3, [248, 247, 255]], [0.6, [255, 244, 232]], [1.0, [255, 210, 161]], [1.6, [255, 173, 81]]];
  if (bv == null) return [240, 240, 255];
  if (bv <= stops[0][0]) return stops[0][1];
  for (let i = 1; i < stops.length; i++) {
    if (bv <= stops[i][0]) {
      const [b0, c0] = stops[i - 1], [b1, c1] = stops[i], t = (bv - b0) / (b1 - b0);
      return c0.map((v, k) => Math.round(v + t * (c1[k] - v)));
    }
  }
  return stops[stops.length - 1][1];
}

// ---------------------------------------------------------------- the pointing

function pointingSource(id) {
  const p = site.pointings.find((q) => q.id === id);
  return p && site.calibrators.find((c) => c.name === p.source);
}

/** Declination of date the dishes point at, for pointing id (or the custom one). */
function pointingDec(ob, id = st.pointing) {
  if (id === "custom") return st.customDec;
  const src = pointingSource(id);
  return A.decOfDate(ob, A.vec(src.ra, src.dec));
}

// ---------------------------------------------------------------- time

const tz = () => site.site.tz;
const clockFmt = new Map();
function clock(ms, opts) {
  const key = JSON.stringify(opts);
  if (!clockFmt.has(key)) clockFmt.set(key, new Intl.DateTimeFormat("en-CA", { timeZone: tz(), ...opts }));
  return clockFmt.get(key).format(new Date(ms));
}
const hhmm = (ms) => clock(ms, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const hms = (deg) => {
  const s = Math.floor((A.mod360(deg) / 15) * 3600);
  return [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60].map((x) => String(x).padStart(2, "0")).join(":");
};
function inWords(ms) {
  const m = Math.round(Math.abs(ms) / 60000);
  const s = m < 60 ? `${m} min` : m < 2880 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${Math.round(m / 1440)} days`;
  return ms >= 0 ? `in ${s}` : `${s} ago`;
}

function setTime(ms, { live = false, play } = {}) {
  st.t = ms;
  st.live = live;
  if (play !== undefined) st.playing = play;
  if (live) { st.speed = 1; st.playing = true; }
  dirty = true;
  syncTimeControls();
}

// ---------------------------------------------------------------- rendering

function resize() {
  dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = window.innerWidth, h = window.innerHeight;
  for (const id of ["fg", "ov", "fx"]) { const c = $(id); c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
  st.view.w = w; st.view.h = h;
  sizeSky();
  insets();
}

const wide = () => window.innerWidth > 720;
const kiosk = () => document.body.classList.contains("kiosk");
function insets() {
  st.view.insetL = wide() && !kiosk() ? PANEL_W : 0;
  st.view.insetB = wide() && st.layers.trace ? TRACE_H : 0;
  $("trace").style.display = st.view.insetB ? "" : "none";
  dirty = true;
}

const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

/** The Landscape's season at time ms, by the day of the year (as in the
 *  South Okanagan grassland, a typical year): bloom: how far in flower
 *  are arrowleaf balsamroot (mid-April to May), silky lupine (May to
 *  June), yarrow (June, July) and rabbitbrush (September, October), each
 *  0 .. 1; green: the bunchgrass greening in spring (0 cured .. 1); snow:
 *  the snow lying, from late November to early March (0 .. 1). */
function season(ms) {
  const d = (ms - Date.UTC(new Date(ms).getUTCFullYear(), 0, 1)) / 864e5;
  const span = (a, b, c, e) => smooth(a, b, d) * (1 - smooth(c, e, d));      // rises over a .. b, falls over c .. e
  return {
    bloom: [span(98, 112, 140, 158), span(128, 142, 172, 190), span(152, 168, 200, 222), span(243, 256, 288, 305)],
    green: span(70, 105, 150, 190),
    snow: Math.max(1 - smooth(42, 72, d), smooth(325, 352, d)),
  };
}

function computeFrame() {
  const ob = A.observer(st.t, site.site);
  const sun = A.sun(ob), moon = A.moon(ob), phase = A.moonPhase(sun, moon);
  const decBore = pointingDec(ob);
  const boreEnu = A.boresightEnu(site.site, decBore);
  const boreJ2000 = A.apply(ob.fromEnu, boreEnu);
  const sunAlt = A.altaz(sun.enu)[1];
  const planets = A.planets(ob).map((p) => ({ ...p, obj: { type: "planet", name: p.name, v: p.j2000, au: p.au } }));
  const day = smooth(-12, 4, sunAlt), moonUp = smooth(-2, 6, A.altaz(moon.enu)[1]);
  const moonLin = MOON_LIGHT.map((x) => x * phase.illuminated * moonUp * (1 - day));
  const sunOverHills = smooth(-0.4, 0.4, sunAlt - skyline(A.altaz(sun.enu)[0]));
  return { ob, sun, moon, phase, planets, decBore, boreEnu, boreJ2000, sunAlt, day, sky: st.layers.land ? skyFor(sunAlt) : null, moonLin, sunOverHills };
}

// The real terrain's heights (terrain.png), fetched when the Landscape is first shown.
let terrain = null, terrainAsked = false;
function wantTerrain() {
  if (terrainAsked) return;
  terrainAsked = true;
  const img = new Image();
  img.onload = () => { terrain = img; dirty = true; };
  img.src = "terrain.png";
}

// The daylight sky for each Sun altitude, to 0.2 deg (atmos.js takes tens of ms).
const skyCache = new Map();
function skyFor(sunAlt) {
  const k = Math.round(sunAlt * 5) / 5;
  let m = skyCache.get(k);
  if (!m) {
    m = skyModel(k);
    if (skyCache.size >= 300) skyCache.delete(skyCache.keys().next().value);
    skyCache.set(k, m);
  }
  return m;
}

let monthsCache = { year: null, list: [] };
function sunMonths(ms) {
  const year = new Date(ms).getUTCFullYear();
  if (monthsCache.year !== year) {
    const names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    monthsCache = { year, list: names.map((label, m) => ({ label, v: A.sun(A.observer(Date.UTC(year, m, 1), site.site)).j2000 })) };
  }
  return monthsCache.list;
}

/** The span of altitude the ground view starts on: from just below the
 *  southern skyline, or below the dishes, to above the beam (63 deg up for
 *  Tau A, 81 for Cyg A). */
function groundSpan() {
  const beamAlt = 90 - Math.abs(site.site.lat - pointingDec(A.observer(st.t, site.site)));
  const lo = st.layers.land ? -15 : skyline(180) - 4;
  return [lo, Math.min(beamAlt + 8, 95)];
}

/** Start of a camera view; the ground view is centred on groundSpan(). */
function aim(kind) {
  const a = { ...AIM[kind] };
  if (a.alt0 == null) { const [lo, hi] = groundSpan(); a.alt0 = Math.round((lo + hi) / 2); }
  return a;
}

/** The ground view starts GROUND_FOV wide across the free area, or wider if
 *  groundSpan() needs it; the other views fit the whole sky. */
function defaultZoom(kind) {
  if (kind !== "ground") return 1;
  const v = st.view, iw = v.w - (v.insetL || 0), ih = v.h - (v.insetB || 0);
  const [lo, hi] = groundSpan();
  const across = iw / (4 * Math.tan((GROUND_FOV / 4) * A.DEG));        // stereographic: x = 2 tan(theta / 2)
  const upDown = ih / (4 * Math.tan(((hi - lo) / 4) * A.DEG));
  return Math.min(across, upDown) / fitScale(STEREO, iw, ih);
}

function render() {
  if (st.layers.land) wantTerrain();
  frame = computeFrame();
  const v = st.view, onSite = v.kind !== "chart";
  if (v.zoom == null) v.zoom = defaultZoom(v.kind);
  cam = makeCamera(v, frame.ob);
  const zoom = cam.s / 180;            // detail level: pixels per radian against a desktop's full view
  glParams = {
    cam, ob: frame.ob, dpr: dpr * glScale, stretch: SKY_STRETCH, skyGain: st.skyGain,
    dome: onSite, ground: st.layers.horizon, bore: frame.boreEnu,
    beamMode: { off: 0, dish: 1, array: 2 }[st.beamMode], beamGain: 1, band: st.band, array: site.array,
    sun: frame.sun.enu, moon: frame.moon.enu, moonLin: frame.moonLin,
    land: st.layers.land && !!terrain, terrain, time: windTime(), wind: WIND, eyeH: EYE_M,
    arrayBox: arrayBox(), sunOverHills: frame.sunOverHills, season: season(st.t),
  };
  if (frame.sky) gl.setSky(frame.sky);
  gl.draw(glParams);
  const fg = $("fg").getContext("2d");
  if (onSite && st.layers.land) {
    drawDishes(fg, {
      cam, dpr, ob: frame.ob, array: site.array, bore: frame.boreEnu,
      light: { sun: frame.sun.enu, moon: frame.moon.enu, sunLin: frame.sky.sunLin.map((x) => x * frame.sunOverHills),
        ambLin: frame.sky.ambLin, moonLin: frame.moonLin, strength: frame.sky.strength,
        cloud: (P) => gl.cloudShade(P, frame.sun.enu, glParams.time, WIND) },
    });
  } else fg.clearRect(0, 0, $("fg").width, $("fg").height);
  const centre = unproject(cam, v.w / 2, v.h / 2);
  const res = overlay.draw({
    cam, dpr, ob: frame.ob, zoom, layers: { ...st.layers, beam: st.beamMode !== "off" }, data, skyline,
    dome: onSite, ground: v.kind === "ground", day: frame.day, sun: frame.sun, moon: frame.moon, phase: frame.phase,
    sunObj: { type: "sun", name: "Sun", v: frame.sun.j2000 }, moonObj: { type: "moon", name: "Moon", v: frame.moon.j2000 },
    planets: frame.planets, flux: (o) => fluxAt(o, fCentre()),
    decBore: frame.decBore, boreJ2000: frame.boreJ2000, band: st.band, array: site.array,
    sunMonths: sunMonths(st.t), clock: hhmm, selected: st.selected,
    lon0Label: centre ? A.lonlat(centre)[0] : 0,
  });
  hits = res.hits;
  blink = res.pulsars;
  if (st.view.insetB) drawTrace();
}

function drawTrace() {
  const ob = frame.ob, half = A.hpbwDeg(site.array, st.band[0]) / 2, day = 86164091;
  trace.update(ob, frame.decBore, st.band, site.array);
  const marks = [];
  const mark = (v, label, color, prio) => {
    if (Math.abs(A.decOfDate(ob, v) - frame.decBore) > half) return;
    const dt = A.msToTransit(ob, v);
    for (const t of [dt - day, dt]) marks.push({ ms: st.t + t, label, color, prio });
  };
  const fc = fCentre(), L = st.layers;
  if (L.calib) for (const c of data.calibrators) mark(c.v, c.name, COLORS.calibrator, 100);
  if (L.sources) for (const s of data.sources3c) if (fluxAt(s, fc) >= 20) mark(s.v, s.name, "rgb(255,190,130)", fluxAt(s, fc));
  if (L.nvss) for (const s of data.nvss) if (!(L.sources && s.crr) && !(L.snrs && s.inSnr) && fluxAt(s, fc) >= 20) mark(s.v, s.name, "rgb(185,167,255)", fluxAt(s, fc));
  if (L.snrs) for (const s of data.snrs) if (!s.atCalibrator && fluxAt(s, fc) >= 50) mark(s.v, s.name, "rgb(182,229,138)", fluxAt(s, fc));
  for (const p of data.pulsars) if (p.highlight) mark(p.v, p.name, COLORS.pulsar, 50);
  mark(frame.sun.j2000, "Sun", COLORS.sun, 200);
  trace.draw({ dpr, x0: st.view.insetL, w: st.view.w - st.view.insetL, h: TRACE_H, now: st.t, clock: hhmm, marks });
}

/** The array's pad with a margin: centre east, north and half-sizes (m) from the observer. */
function arrayBox() {
  const a = site.array, r = a.dish_diameter_m / 2 + 3;
  return [ARRAY_AT[0], ARRAY_AT[1], ((a.nx - 1) / 2) * a.dx_m + r, ((a.ny - 1) / 2) * a.dy_m + r];
}

function sizeSky() {
  const c = $("sky"), s = dpr * glScale;
  c.width = Math.round(st.view.w * s);
  c.height = Math.round(st.view.h * s);
  dirty = true;
}

/** While the wind blows the sky redraws every ANIM_MS.  A GPU that cannot
 *  keep up stretches the interval to its time per frame, and that time
 *  goes as the pixels drawn.  So, from the median of six intervals: when
 *  behind, the sky canvas shrinks at once to the size that keeps up (to
 *  RES_MIN at least), or back to the last size that kept up if that is
 *  larger (the interval counts whole display frames, so it overstates the
 *  cost); when keeping up, it grows a step toward the screen's resolution.  The steps follow each other at once until one has to be
 *  undone; after that each waits 2 s, then twice as long after each undo
 *  (to 1 min).  An interval over 0.5 s is a stall and not the wind's
 *  cost, unless the next is too: then the canvas shrinks on those two.
 *  dt: ms since the last wind frame. */
function govern(dt, now) {
  if (windSkip) { windSkip = false; return false; }   // after a full render
  let m;
  if (dt > 500) {
    if (++windStalls < 2) return false;
    m = dt;
  } else {
    windStalls = 0;
    windDts.push(dt);
    if (windDts.length < 6) return false;
    m = windDts.sort((a, b) => a - b)[3];
  }
  const r = dpr * glScale;
  windDts.length = 0;
  let next = r;
  if (m > 1.35 * ANIM_MS) {
    next = Math.max(RES_MIN, r * Math.sqrt((0.9 * ANIM_MS) / m), scaleOk < r ? scaleOk : 0);
    scaleHold = Math.min(60000, Math.max(2000, 2 * scaleHold));
  } else if (m < 1.15 * ANIM_MS) {
    scaleOk = r;
    if (now - scaleAt > scaleHold) next = Math.min(dpr, r * 1.25);
  }
  if (Math.abs(next - r) < 0.01) return false;
  glScale = next / dpr;
  scaleAt = now;
  sizeSky();
  return true;
}

/** Once the Landscape can be drawn: draw it small, time a frame of it,
 *  and start the wind at the resolution this GPU can keep up with (the
 *  time goes as the pixels), so a slow GPU does not first freeze on a
 *  full-size frame.  govern takes over from there. */
function landProbe() {
  if (!windOn) return;
  const sync = () => { gl.sync(); return performance.now(); };
  glScale = RES_PROBE / dpr;
  sizeSky();
  const t0 = performance.now();
  render();
  const t1 = sync();
  gl.draw(glParams);
  const ms = sync() - t1;
  const r = Math.min(dpr, RES_START, Math.max(RES_MIN, RES_PROBE * Math.sqrt((0.6 * ANIM_MS) / ms)));
  console.info(`Landscape: compiled in ${Math.round(gl.compileMs)} ms, maps built in ${Math.round(gl.bakeMs)} ms, first frame ${Math.round(t1 - t0)} ms, ` +
    `${ms.toFixed(1)} ms a frame at ${RES_PROBE} px, so ${r.toFixed(2)} px; ${gl.renderer()}`);
  glScale = r / dpr;
  scaleHold = scaleOk = 0;
  windDts.length = 0;
  windSkip = true;
  sizeSky();
}

/** Seconds of wind (wall clock, not the page's clock; wraps daily). */
const windTime = () => (performance.now() / 1000) % 86400;
const windBlows = () => st.layers.land && !!terrain && st.view.kind !== "chart" && !reducedMotion;

function loop(now) {
  requestAnimationFrame(loop);
  const dt = now - (loop.prev ?? now);
  loop.prev = now;
  if (st.live) {
    const t = Date.now();
    if (t - st.t > 1000) { st.t = t; dirty = true; }
  } else if (st.playing) {
    st.t += dt * st.speed;
    if (st.speed > 1 || st.speed < 0) dirty = true;
    else if (now - lastDraw > 1000) dirty = true;
  }
  if (windBlows() !== windOn) {           // the Landscape starts or stops moving
    windOn = !windOn;
    glScale = windOn ? Math.min(1, RES_START / dpr) : 1;
    scaleHold = scaleOk = 0;
    windDts.length = 0;
    sizeSky();
  }
  if (dirty) {
    dirty = false;
    lastDraw = lastWind = now;
    windSkip = true;
    render();
    if (now - lastPanels > (st.playing && Math.abs(st.speed) > 1 ? 250 : 900)) { lastPanels = now; panels(); }
    if (now - lastHash > 700) { lastHash = now; writeHash(); }
  } else if (glParams && windOn && now - lastWind > ANIM_MS) {
    const resized = govern(now - lastWind, now);
    lastWind = now;
    glParams.time = windTime();
    if (resized) { dirty = false; windSkip = true; render(); } else gl.draw(glParams);
  }
  if (st.layers.pulsars && blink.length) drawPulsarBlink($("fx").getContext("2d"), blink, now / 1000, dpr, st.view.w, st.view.h, reducedMotion);
  else if (loop.blinked) $("fx").getContext("2d").clearRect(0, 0, $("fx").width, $("fx").height);
  loop.blinked = st.layers.pulsars && blink.length > 0;
}

// ---------------------------------------------------------------- panels

function panels() {
  const f = frame, ob = f.ob;
  $("t-local").textContent = clock(st.t, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23", timeZoneName: "short" });
  $("t-utc").textContent = `UTC ${new Date(st.t).toISOString().slice(0, 19).replace("T", " ")}`;
  $("t-lst").textContent = `LST ${hms(ob.last)} · Sun ${fmt(f.sunAlt, 0)}° · Moon ${Math.round(f.phase.illuminated * 100)}%`;
  if (document.activeElement !== $("t-input")) $("t-input").value = new Date(st.t).toISOString().slice(0, 19);
  bandFacts();
  inBeam();
  upNext();
  if (st.selected) card(st.selected);
}

const fCentre = () => Math.sqrt(st.band[0] * st.band[1]);

function bandFacts() {
  const [lo, hi] = st.band, a = site.array, single = hi - lo < 1;
  const zr = (f) => A.HI_REST_MHZ / f - 1;
  const lam = (f) => 299.792458 / f;
  const pair = (fn, d) => (single ? fmt(fn(lo), d) : `${fmt(fn(lo), d)} – ${fmt(fn(hi), d)}`);
  $("band-text").textContent = single ? `${lo} MHz` : `${lo} – ${hi} MHz`;
  const x0 = (lo - 150) / 1450 * 100, x1 = (hi - 150) / 1450 * 100;
  $("band-fill").style.left = `${x0}%`;
  $("band-fill").style.width = `${Math.max(x1 - x0, 0.6)}%`;
  const rows = [
    ["Beam width", `${pair((f) => A.hpbwDeg(a, f), 1)}°`],
    ["Lobe spacing", `${pair((f) => lam(f) / a.dx_m / A.DEG, 1)}° E–W, ${pair((f) => lam(f) / a.dy_m / A.DEG, 1)}° N–S`],
  ];
  if (hi < A.HI_REST_MHZ) {
    rows.push(["HI redshift", pair((f) => Math.max(zr(f), 0), 2)]);
    rows.push(["Lookback", `${pair((f) => A.lookbackGyr(Math.max(zr(f), 0)), 1)} Gyr`]);
  } else if (lo < A.HI_REST_MHZ) {
    rows.push(["HI redshift", `0 – ${fmt(zr(lo), 2)}`]);
  } else rows.push(["HI", "above 1420 MHz: no redshifted HI"]);
  $("band-facts").innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("");
}

function tagFor(o) {
  return { calibrator: ["cal", "t-cal"], "3crr": ["3C", "t-src"], pulsar: ["PSR", "t-psr"], frb: ["FRB", "t-frb"], dump: ["dump", "t-dump"],
    planet: ["planet", "t-planet"], nvss: ["NVSS", "t-nvss"], snr: ["SNR", "t-snr"],
    sun: ["Sun", "t-sun"], moon: ["Moon", "t-moon"], star: ["star", "t-star"] }[o.type];
}
const tagHtml = (o) => { const [t, c] = tagFor(o); return `<span class="tag ${c}">${t}</span>`; };
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

/** What the in-beam and coming-up lists consider: the catalogues whose
 *  layers are on (an NVSS source that is also a 3CRR one counts once). */
function candidates() {
  const L = st.layers;
  return [
    ...(L.calib ? data.calibrators.map((c) => c.obj) : []),
    ...(L.sources ? data.sources3c.map((s) => s.obj) : []),
    ...(L.nvss ? data.nvss.filter((s) => !(L.sources && s.crr) && !(L.snrs && s.inSnr)).map((s) => s.obj) : []),
    ...(L.snrs ? data.snrs.filter((s) => !s.atCalibrator).map((s) => s.obj) : []),
    ...data.pulsars.filter((p) => p.highlight || p.flux >= 20).map((p) => p.obj),
    ...(L.frbs ? data.frbs.filter((f) => f.repeater && f.bursts >= 10).map((f) => f.obj) : []),   // the busy repeaters
    { type: "sun", name: "Sun", v: frame.sun.j2000 },
    { type: "moon", name: "Moon", v: frame.moon.j2000 },
    ...frame.planets.map((p) => p.obj),
  ];
}

function listItems(el, items, empty) {
  el.innerHTML = items.length ? "" : `<li class="empty">${empty}</li>`;
  for (const it of items) {
    const li = document.createElement("li");
    li.innerHTML = `<span class="n">${tagHtml(it.o)}${esc(it.o.name)}</span><span class="v">${it.v}</span>${it.d ? `<span class="d">${it.d}</span>` : ""}`;
    li.onclick = () => select(it.o, true);
    el.appendChild(li);
  }
}

function inBeam() {
  const fc = fCentre(), half = A.hpbwDeg(site.array, st.band[0]) / 2;
  $("inbeam-f").textContent = `gain at ${Math.round(fc)} MHz`;
  const items = [];
  for (const o of candidates()) {
    const off = A.sepDeg(o.v, frame.boreJ2000);
    if (off > half) continue;
    const db = 10 * Math.log10(Math.max(A.primaryBeam(site.array, fc, off), 1e-9));
    items.push({ o, off, v: `${fmt(off, 1)}° · ${fmt(db, 1)} dB` });
  }
  items.sort((a, b) => a.off - b.off);
  listItems($("inbeam"), items.slice(0, 8), "Nothing catalogued within the half-power width.");
}

function upNext() {
  const ob = frame.ob, half = A.hpbwDeg(site.array, st.band[0]) / 2;
  const items = [];
  for (const o of candidates()) {
    const d = A.decOfDate(ob, o.v) - frame.decBore;
    if (Math.abs(d) > half) continue;
    const s = fluxAt(o, fCentre());
    if (s != null && s < 10) continue;                       // the bright ones only
    const dt = A.msToTransit(ob, o.v);
    if (dt < 60000) continue;
    items.push({ o, dt, v: hhmm(st.t + dt), d: `${inWords(dt)} · ${fmt(Math.abs(d), 1)}° ${d >= 0 ? "N" : "S"} of centre` });
  }
  items.sort((a, b) => a.dt - b.dt);
  listItems($("upnext"), items.slice(0, 7), "Nothing bright crosses the strip in the next day.");
  $("sun-note").textContent = sunNote();
}

let sunNoteCache = { key: "", text: "" };
function sunNote() {
  const half = A.hpbwDeg(site.array, st.band[0]) / 2;
  const key = `${st.pointing}|${st.customDec}|${st.band[0]}|${new Date(st.t).toISOString().slice(0, 10)}`;
  if (sunNoteCache.key === key) return sunNoteCache.text;
  const day0 = Math.floor(st.t / 86400000) * 86400000 + 20 * 3600000;   // about local noon at DRAO
  const spans = [];
  let start = null;
  for (let k = 0; k <= 366; k++) {
    const ob = A.observer(day0 + k * 86400000, site.site);
    const inside = Math.abs(A.decOfDate(ob, A.sun(ob).j2000) - pointingDec(ob)) < half;
    if (inside && start === null) start = k;
    if ((!inside || k === 366) && start !== null) { spans.push([start, k - 1]); start = null; }
  }
  const d = (k) => clock(day0 + k * 86400000, { month: "short", day: "numeric" });
  let text;
  if (!spans.length) text = "The Sun stays outside the strip all year at this band.";
  else if (spans[0][0] === 0 && spans[0][1] >= 365) text = "The Sun crosses the strip every day of the year.";
  else text = `The Sun crosses the strip ${spans.map(([a, b]) => (a === 0 ? `now to ${d(b)}` : `${d(a)} – ${d(b)}`)).join(" and ")}.`;
  sunNoteCache = { key, text };
  return text;
}

// ---------------------------------------------------------------- the card

function select(o, focus = false) {
  st.selected = o;
  dirty = true;
  if (!o) { $("card").hidden = true; return; }
  if (focus) lookAt(o.v);
  card(o);
}

function lookAt(v) {
  const view = st.view;
  if (view.kind !== "chart") {
    const [az, alt] = A.altaz(A.apply(frame.ob.toEnu, v));
    view.az0 = az; view.alt0 = clamp(alt, -90, 90);
  } else {
    const [lon] = A.lonlat(view.frame === "gal" ? A.apply(A.ICRS_TO_GAL, v) : v);
    view.lon0 = lon; view.pan = [0, 0];
  }
  dirty = true;
}

function card(o) {
  const ob = frame.ob, el = $("card"), fc = fCentre();
  if (o.type === "sun") o.v = frame.sun.j2000;           // they move: follow the current frame
  if (o.type === "moon") o.v = frame.moon.j2000;
  if (o.type === "planet") Object.assign(o, frame.planets.find((p) => p.name === o.name).obj);
  const [ra, dec] = A.lonlat(o.v);
  const [az, alt] = A.altaz(A.apply(ob.toEnu, o.v));
  const off = A.sepDeg(o.v, frame.boreJ2000);
  const ddec = A.decOfDate(ob, o.v) - frame.decBore;
  const dt = A.msToTransit(ob, o.v);
  const decStr = `${dec >= 0 ? "+" : "−"}${fmt(Math.abs(dec), 2)}°`;
  const rows = [];
  let kind = "", note = "";
  if (o.type === "calibrator") { kind = `Calibrator · ${o.kind}${o.alias ? ` · ${o.alias}` : ""}`; }
  // Spectral indices are shown one way for every catalogue: S ~ f^alpha.
  const atBand = (s, note = "") => rows.push([`Flux, ${Math.round(fc)} MHz`, s == null ? "–" : `${fmt(s, s < 10 ? 2 : 1)} Jy${note}`]);
  if (o.type === "3crr") {
    kind = "Radio source · 3CRR";
    rows.push(["Flux, 178 MHz", `${fmt(o.s178, 1)} Jy`]);
    if (o.alpha != null) rows.push(["Spectral index", `${fmt(-o.alpha, 2)} (178–750 MHz)`]);
    atBand(fluxAt(o, fc), o.alpha == null ? " (index −0.8 assumed)" : "");
    if (o.z != null) rows.push(["Redshift", fmt(o.z, 3)]);
    rows.push(["Class", { 1: "FR I", 2: "FR II" }[o.fr] ?? "compact"]);
  }
  if (o.type === "nvss") {
    const also = [o.crr || o.threec, o.nvssName].filter((n) => n && n !== o.name);
    kind = `Radio source · NVSS${o.components > 1 ? `, ${o.components} components` : ""}${also.length ? ` · ${also.join(" · ")}` : ""}`;
    if (o.inSnr) rows.push(["In", `the supernova remnant ${esc(o.inSnr)}`]);
    rows.push(["Flux, 1.4 GHz", `${fmt(o.s1400, 2)} Jy`]);
    rows.push(["Flux, 150 MHz", o.s150 != null ? `${fmt(o.s150, 2)} Jy (TGSS)` : "no TGSS match"]);
    rows.push(["Spectral index", o.alpha != null ? `${fmt(o.alpha, 2)} (150 MHz–1.4 GHz)` : "unknown"]);
    atBand(fluxAt(o, fc), o.alpha == null ? " (the 1.4 GHz flux: not extrapolated)" : "");
  }
  if (o.type === "snr") {
    kind = `Supernova remnant · ${o.gname}${o.kind ? ` · type ${o.kind}` : ""}`;
    if (o.others.length > 1) rows.push(["Also", esc(o.others.slice(1).join(", "))]);
    rows.push(["Size", `${fmt(o.size[0], 1)}${o.size[1] !== o.size[0] ? ` × ${fmt(o.size[1], 1)}` : ""}′`]);
    rows.push(["Flux, 1 GHz", o.s1000 != null ? `${fmt(o.s1000, 1)} Jy` : "–"]);
    rows.push(["Spectral index", o.alpha != null ? fmt(o.alpha, 2) : "unknown"]);
    atBand(fluxAt(o, fc), o.alpha == null && o.s1000 != null ? " (the 1 GHz flux: not extrapolated)" : "");
  }
  if (o.type === "pulsar") {
    kind = `Pulsar · ${o.jname}${o.assoc ? ` · ${o.assoc.replace(/,/g, ", ")}` : ""}`;
    rows.push(["Period", o.p0 < 0.1 ? `${fmt(o.p0 * 1000, 2)} ms` : `${fmt(o.p0, 4)} s`]);
    rows.push(["DM", o.dm != null ? `${fmt(o.dm, 2)} pc cm⁻³` : "–"]);
    rows.push(["Flux", `${o.s400 != null ? `${fmt(o.s400, 1)} mJy at 400 MHz` : ""}${o.s400 != null && o.s1400 != null ? ", " : ""}${o.s1400 != null ? `${fmt(o.s1400, 2)} mJy at 1400` : ""}`]);
  }
  if (o.type === "frb") {
    const utc = (mjd, n) => new Date((mjd - 40587) * 86400000).toISOString().slice(0, n).replace("T", " ");
    kind = `${o.repeater ? "Repeating fast radio burst" : "Fast radio burst"} · CHIME/FRB`;
    if (o.repeater) {
      rows.push(["Bursts", `${o.bursts} in the catalogue`]);
      rows.push(["Seen", `${utc(o.first, 10)} to ${utc(o.last, 10)}`]);
    } else rows.push(["Arrived", `${utc(o.mjd, 19)} UTC, once`]);
    rows.push(["DM", `${fmt(o.dm, 1)} pc cm⁻³${o.dmExc != null ? ` (${fmt(Math.max(o.dmExc, 0), 0)} from beyond the Galaxy)` : ""}`]);
    if (o.fluence != null) rows.push([o.repeater ? "Brightest burst" : "Fluence", `${fmt(o.fluence, o.fluence < 10 ? 1 : 0)} Jy ms (400–800 MHz)`]);
    if (o.err != null) rows.push(["Position", o.err < 0.005 ? "known to better than 0.01°" : `good to about ${fmt(o.err, 2)}°`]);
    note = o.repeater ? "A source that has burst more than once. Nobody can say when the next burst will come."
      : "A single flash a few milliseconds long, almost certainly from another galaxy. The catalogue has no second burst from here.";
  }
  if (o.type === "star") { kind = "Star"; rows.push(["Magnitude", fmt(o.mag, 2)]); }
  if (o.type === "dump") {
    kind = "Baseband dump";
    rows.push(["Taken", `${new Date(o.ms).toISOString().slice(0, 19).replace("T", " ")} UTC`]);
    note = o.note;
  }
  if (o.type === "sun") kind = `Altitude ${fmt(alt, 1)}°`;
  if (o.type === "moon") kind = `${Math.round(frame.phase.illuminated * 100)}% illuminated · altitude ${fmt(alt, 1)}°`;
  if (o.type === "planet") {
    kind = "Planet";
    rows.push(["Distance", `${fmt(o.au, 3)} au · light ${fmt((o.au * 499.005) / 60, 1)} min`]);
  }
  rows.push(["RA, Dec (J2000)", `${hms(ra)}, ${decStr}`]);
  rows.push(["Alt, az now", `${fmt(alt, 1)}°, ${fmt(az, 1)}°`]);
  rows.push(["Next transit", `${hhmm(st.t + dt)} (${inWords(dt)})`]);
  rows.push(["From the strip", `${fmt(Math.abs(ddec), 2)}° ${ddec >= 0 ? "north" : "south"}`]);
  const g = A.primaryBeam(site.array, fc, off);
  rows.push(["From the beam", `${fmt(off, 2)}°${g > 1e-4 ? ` (${fmt(10 * Math.log10(g), 1)} dB at ${Math.round(fc)} MHz)` : ""}`]);
  const facts = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("");
  // Rebuild only for a new object; a refresh changes the numbers alone, so a
  // button is never replaced under the pointer.
  if (el.dataset.obj === `${o.type}:${o.name}` && !el.hidden) {
    el.querySelector(".kind").textContent = kind;
    el.querySelector(".facts").innerHTML = facts;
    return;
  }
  el.dataset.obj = `${o.type}:${o.name}`;
  el.innerHTML = `<button class="close" aria-label="Close">×</button><h3>${esc(o.name)}</h3><div class="kind">${esc(kind)}</div>`
    + `<dl class="facts">${facts}</dl>`
    + (note ? `<p>${esc(note)}</p>` : "")
    + `<div class="row"><button class="btn" id="go-transit">Go to the transit</button>${o.type === "dump" ? '<button class="btn" id="go-dump">Go to the dump</button>' : ""}</div>`;
  el.hidden = false;
  el.querySelector(".close").onclick = () => select(null);
  el.querySelector("#go-transit").onclick = () => {
    const sel = st.selected;
    if (!sel) return;
    setTime(st.t + A.msToTransit(frame.ob, sel.v), { play: false });
    lookAt(frame.boreJ2000);
  };
  const gd = el.querySelector("#go-dump");
  if (gd) gd.onclick = () => { setTime(o.ms, { play: false }); };
}

// ---------------------------------------------------------------- controls

function syncTimeControls() {
  $("live").setAttribute("aria-pressed", String(st.live));
  $("play").textContent = st.playing ? "❚❚" : "▶";
  const s = st.speed, abs = Math.abs(s);
  $("speed").textContent = !st.playing ? "paused" : `${s < 0 ? "−" : ""}${abs >= 3600 ? `${abs / 3600} h/s` : abs >= 60 ? `${abs / 60} min/s` : `${abs}×`}`;
}

function stepSpeed(dir) {
  const i = SPEEDS.indexOf(Math.abs(st.speed)), sign = Math.sign(st.speed) || 1;
  let s;
  if (sign === dir) s = dir * SPEEDS[Math.min(i + 1, SPEEDS.length - 1)];
  else s = i > 0 ? sign * SPEEDS[i - 1] : dir;
  st.live = false; st.playing = true; st.speed = s;
  syncTimeControls();
}

function setPointing(id, dec) {
  st.pointing = id;
  if (id === "custom") st.customDec = dec;
  for (const b of $("pointings").children) b.setAttribute("aria-pressed", String(b.dataset.id === id));
  const p = site.pointings.find((q) => q.id === id);
  $("point-note").textContent = p ? p.note : "custom declination";
  $("dec-input").value = fmt(pointingDec(A.observer(st.t, site.site), id), 2);
  sunNoteCache.key = "";
  dirty = true;
}

function setView(kind) {
  const v = st.view;
  if (kind !== v.kind) {
    v.kind = kind; v.zoom = defaultZoom(kind); v.pan = [0, 0];
    if (AIM[kind]) Object.assign(v, aim(kind));
    if (kind === "chart" && frame) lookAt(frame.boreJ2000);
  }
  for (const b of document.querySelectorAll("[data-view]")) b.setAttribute("aria-pressed", String(b.dataset.view === v.kind));
  for (const b of document.querySelectorAll("[data-frame]")) b.setAttribute("aria-pressed", String(b.dataset.frame === v.frame));
  for (const b of document.querySelectorAll("[data-proj]")) b.setAttribute("aria-pressed", String(Number(b.dataset.proj) === v.proj));
  $("chart-opts").style.display = v.kind === "chart" ? "" : "none";
  dirty = true;
}

function setBand(lo, hi) {
  lo = clamp(Math.round(lo), 150, 1600); hi = clamp(Math.round(hi), 150, 1600);
  if (lo > hi) [lo, hi] = [hi, lo];
  st.band = [lo, hi];
  $("f-lo").value = lo; $("f-hi").value = hi;
  sunNoteCache.key = "";
  dirty = true;
  bandFacts();
}

function setBeam(mode) {
  st.beamMode = mode;
  for (const b of document.querySelectorAll("[data-beam]")) b.setAttribute("aria-pressed", String(b.dataset.beam === mode));
  dirty = true;
}

function wireControls() {
  $("site-name").textContent = site.site.name;
  $("live").onclick = () => setTime(Date.now(), { live: true });
  $("play").onclick = () => { if (st.live) { st.live = false; st.playing = false; } else st.playing = !st.playing; syncTimeControls(); dirty = true; };
  $("ffw").onclick = () => stepSpeed(1);
  $("rew").onclick = () => stepSpeed(-1);
  $("t-input").onchange = (e) => { const ms = Date.parse(`${e.target.value}Z`); if (!Number.isNaN(ms)) setTime(ms, { play: false }); };

  for (const p of site.pointings) {
    const b = document.createElement("button");
    b.className = "btn"; b.dataset.id = p.id; b.textContent = p.label;
    b.onclick = () => setPointing(p.id);
    $("pointings").appendChild(b);
  }
  $("dec-input").onchange = (e) => { const d = parseFloat(e.target.value); if (Number.isFinite(d)) setPointing("custom", clamp(d, -30, 90)); };

  for (const b of document.querySelectorAll("[data-view]")) b.onclick = () => setView(b.dataset.view);
  for (const b of document.querySelectorAll("[data-frame]")) b.onclick = () => { st.view.frame = b.dataset.frame; if (frame) lookAt(frame.boreJ2000); setView(st.view.kind); };
  for (const b of document.querySelectorAll("[data-proj]")) b.onclick = () => { st.view.proj = Number(b.dataset.proj); st.view.zoom = 1; st.view.pan = [0, 0]; setView(st.view.kind); };
  for (const b of document.querySelectorAll("[data-beam]")) b.onclick = () => setBeam(b.dataset.beam);

  $("f-lo").oninput = () => setBand(Math.min(+$("f-lo").value, +$("f-hi").value), Math.max(+$("f-lo").value, +$("f-hi").value));
  $("f-hi").oninput = $("f-lo").oninput;

  const box = $("layers");
  for (const [k, label, , color] of LAYERS) {
    const l = document.createElement("label");
    l.innerHTML = `<input type="checkbox" data-layer="${k}"><span class="sw" style="background:${color}"></span>${label}`;
    const cb = l.querySelector("input");
    cb.checked = st.layers[k];
    cb.onchange = () => { st.layers[k] = cb.checked; if (k === "trace") insets(); dirty = true; };
    box.appendChild(l);
  }
  $("sky-gain").value = Math.round(st.skyGain * 100);
  $("sky-gain").oninput = (e) => { st.skyGain = e.target.value / 100; dirty = true; };

  const names = nameIndex;
  const add = (o) => { if (o && o.name && !names.has(o.name)) names.set(o.name, o); };
  data.calibrators.forEach((c) => { add(c.obj); if (c.alias) names.set(c.alias, c.obj); });
  data.dumps.forEach((d) => add(d.obj));
  data.sources3c.forEach((s) => add(s.obj));
  data.nvss.forEach((s) => { add(s.obj); for (const n of [s.threec, s.nvssName]) if (n && !names.has(n)) names.set(n, s.obj); });
  data.snrs.forEach((s) => { add(s.obj); for (const n of [s.gname, ...s.others]) if (!names.has(n)) names.set(n, s.obj); });
  data.pulsars.forEach((p) => { add(p.obj); if (p.jname !== p.name) names.set(p.jname, p.obj); });
  data.frbs.forEach((f) => add(f.obj));
  data.stars.forEach((s) => add(s.obj));
  $("names").innerHTML = ["Sun", "Moon", ...A.PLANETS, ...names.keys()].map((n) => `<option value="${esc(n)}">`).join("");
  $("search").onchange = (e) => {
    const q = e.target.value.trim();
    const planet = frame.planets.find((p) => p.name === q);
    const o = q === "Sun" ? { type: "sun", name: "Sun", v: frame.sun.j2000 } : q === "Moon" ? { type: "moon", name: "Moon", v: frame.moon.j2000 }
      : planet ? planet.obj : names.get(q);
    if (o) { select(o, true); e.target.value = ""; e.target.blur(); }
  };

  $("toggle").onclick = () => { const open = document.body.classList.toggle("panel-open"); $("toggle").setAttribute("aria-expanded", String(open)); };
  $("credits-btn").onclick = () => $("credits").showModal();
  $("credits-close").onclick = () => $("credits").close();
  wireExplain();
  credits();

  window.addEventListener("keydown", (e) => {
    if (e.target.matches("input, select, textarea")) return;
    if (e.key === " ") { e.preventDefault(); $("play").click(); }
    else if (e.key === "n" || e.key === "N") $("live").click();
    else if (e.key === "d" || e.key === "D") setView({ ground: "dome", dome: "chart", chart: "ground" }[st.view.kind]);
    else if (e.key === "+" || e.key === "=") zoomBy(1.25, st.view.w / 2, st.view.h / 2);
    else if (e.key === "-") zoomBy(0.8, st.view.w / 2, st.view.h / 2);
    else if (e.key === "Escape") select(null);
    else if (e.key.startsWith("Arrow")) {
      const d = { ArrowLeft: [40, 0], ArrowRight: [-40, 0], ArrowUp: [0, 40], ArrowDown: [0, -40] }[e.key];
      panBy(d[0], d[1]);
    }
  });
}

// ---------------------------------------------------------------- pointer: drag, zoom, pick

function panBy(dx, dy) {
  const v = st.view, s = cam.s;
  $("hint").hidden = true;                                  // they have found it
  if (v.kind !== "chart") {
    // Turning by the angle dragged at the centre: a turn in azimuth covers
    // less sky toward the zenith and nadir, so it is scaled up there.
    v.az0 = A.mod360(v.az0 - (dx / s) / A.DEG / Math.max(Math.cos(v.alt0 * A.DEG), 0.25));
    v.alt0 = clamp(v.alt0 + (dy / s) / A.DEG, -90, 90);
  } else {
    v.pan = [v.pan[0] - dx / s, v.pan[1] + dy / s];
  }
  dirty = true;
}

function zoomBy(k, x, y) {
  const v = st.view;
  $("hint").hidden = true;
  const before = cam && unproject(cam, x, y);
  const pBefore = cam && toPlane(cam, x, y);
  v.zoom = clamp(v.zoom * k, 0.6, 60);
  cam = makeCamera(v, frame.ob);
  if (v.kind === "chart" && pBefore) {
    const pAfter = toPlane(cam, x, y);
    v.pan = [v.pan[0] + pBefore[0] - pAfter[0], v.pan[1] + pBefore[1] - pAfter[1]];
  } else if (v.kind !== "chart" && before) {
    const after = unproject(cam, x, y);
    if (after) {
      const [az1, alt1] = A.altaz(A.apply(frame.ob.toEnu, before)), [az2, alt2] = A.altaz(A.apply(frame.ob.toEnu, after));
      if (Math.abs(v.alt0) < 85) v.az0 = A.mod360(v.az0 + ((az1 - az2 + 540) % 360) - 180);
      v.alt0 = clamp(v.alt0 + alt1 - alt2, -90, 90);
    }
  }
  dirty = true;
}

function wirePointer() {
  const c = $("sky"), ptrs = new Map();
  let moved = 0, pinch = null;
  c.addEventListener("pointerdown", (e) => {
    c.setPointerCapture(e.pointerId);
    ptrs.set(e.pointerId, [e.clientX, e.clientY]);
    moved = 0;
    if (ptrs.size === 2) { const [a, b] = [...ptrs.values()]; pinch = Math.hypot(a[0] - b[0], a[1] - b[1]); }
    c.classList.add("dragging");
  });
  c.addEventListener("pointermove", (e) => {
    if (!ptrs.has(e.pointerId)) return;
    const [x0, y0] = ptrs.get(e.pointerId);
    ptrs.set(e.pointerId, [e.clientX, e.clientY]);
    if (ptrs.size === 2 && pinch) {
      const [a, b] = [...ptrs.values()], d = Math.hypot(a[0] - b[0], a[1] - b[1]);
      zoomBy(d / pinch, (a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
      pinch = d; moved += 10;
      return;
    }
    const dx = e.clientX - x0, dy = e.clientY - y0;
    moved += Math.abs(dx) + Math.abs(dy);
    if (moved > 3) panBy(dx, dy);
  });
  const up = (e) => {
    if (!ptrs.has(e.pointerId)) return;
    ptrs.delete(e.pointerId);
    if (ptrs.size < 2) pinch = null;
    c.classList.remove("dragging");
    if (moved <= 3 && e.type === "pointerup") pick(e.clientX, e.clientY);
  };
  c.addEventListener("pointerup", up);
  c.addEventListener("pointercancel", up);
  c.addEventListener("wheel", (e) => { e.preventDefault(); zoomBy(Math.exp(-e.deltaY * 0.0015), e.clientX, e.clientY); }, { passive: false });
  c.addEventListener("dblclick", (e) => { const v = unproject(cam, e.clientX, e.clientY); if (v) lookAt(v); });
}

function pick(x, y) {
  let best = null, bd = Infinity;
  for (const h of hits) {
    const d = Math.hypot(h.x - x, h.y - y);
    if (d <= h.r && d < bd) { best = h; bd = d; }
  }
  select(best ? best.obj : null);
}

// ---------------------------------------------------------------- URL fragment

function readHash() {
  const raw = location.hash.slice(1);
  const q = new URLSearchParams(raw);
  if (raw === "kiosk" || q.has("kiosk")) document.body.classList.add("kiosk");
  if (q.get("t")) { const ms = Date.parse(q.get("t")); if (!Number.isNaN(ms)) { st.t = ms; st.live = false; st.playing = false; } }
  const p = q.get("p");
  if (p && site.pointings.some((x) => x.id === p)) st.pointing = p;
  else if (p && /^-?\d+(\.\d+)?$/.test(p)) { st.pointing = "custom"; st.customDec = clamp(parseFloat(p), -30, 90); }
  if (["ground", "dome", "chart"].includes(q.get("v"))) st.view.kind = q.get("v");
  if (AIM[st.view.kind]) Object.assign(st.view, AIM[st.view.kind]);
  if (q.get("proj") === "rect") st.view.proj = CAR;
  if (q.get("fr") === "gal") st.view.frame = "gal";
  const f = (q.get("f") || "").split("-").map(Number);
  if (f.length === 2 && f.every(Number.isFinite)) st.band = [clamp(Math.min(...f), 150, 1600), clamp(Math.max(...f), 150, 1600)];
  if (["off", "dish", "array"].includes(q.get("beam"))) st.beamMode = q.get("beam");
  for (const k of (q.get("on") || "").split(",")) if (k in st.layers) st.layers[k] = true;
  for (const k of (q.get("off") || "").split(",")) if (k in st.layers) st.layers[k] = false;
  const num = (k, lo, hi) => { const x = parseFloat(q.get(k)); return Number.isFinite(x) ? clamp(x, lo, hi) : null; };
  st.view.zoom = num("zoom", 0.6, 60);                  // null: the view's default, once the size is known
  st.view.az0 = num("az", 0, 360) ?? st.view.az0;
  st.view.alt0 = num("alt", -90, 90) ?? st.view.alt0;
  st.view.lon0 = num("lon", 0, 360);
  readHash.sel = q.get("sel");
  readHash.cut = (q.get("cut") || "").split(",");
}

function writeHash() {
  const q = new URLSearchParams();
  if (document.body.classList.contains("kiosk")) q.set("kiosk", "");
  if (!st.live) q.set("t", new Date(Math.round(st.t / 1000) * 1000).toISOString().replace(".000", ""));
  q.set("p", st.pointing === "custom" ? fmt(st.customDec, 2) : st.pointing);
  const v = st.view;
  q.set("v", v.kind);
  if (v.kind === "chart") { q.set("fr", v.frame); q.set("proj", v.proj === CAR ? "rect" : "moll"); q.set("lon", fmt(v.lon0, 1)); }
  else if (v.az0 !== aim(v.kind).az0 || v.alt0 !== aim(v.kind).alt0) { q.set("az", fmt(v.az0, 1)); q.set("alt", fmt(v.alt0, 1)); }
  if (Math.abs(v.zoom - defaultZoom(v.kind)) > 0.01) q.set("zoom", fmt(v.zoom, 2));
  if (st.selected && !["sun", "moon"].includes(st.selected.type)) q.set("sel", st.selected.name);
  q.set("f", `${st.band[0]}-${st.band[1]}`);
  q.set("beam", st.beamMode);
  const on = LAYERS.filter(([k, , d]) => st.layers[k] && !d).map(([k]) => k);
  const off = LAYERS.filter(([k, , d]) => !st.layers[k] && d).map(([k]) => k);
  if (on.length) q.set("on", on.join(","));
  if (off.length) q.set("off", off.join(","));
  if (readHash.cut.some((k) => k)) q.set("cut", readHash.cut.join(","));
  const h = `#${q.toString().replace(/%2C/g, ",").replace(/%3A/g, ":").replace("kiosk=&", "kiosk&").replace(/kiosk=$/, "kiosk")}`;
  if (h !== location.hash) history.replaceState(null, "", h);
}

// ---------------------------------------------------------------- explain and credits

const STEPS = [
  ["The sky above the dishes", "You are standing at the CHORD pathfinder at the Dominion Radio Astrophysical Observatory, near Penticton, BC. Drag to look in any direction; scroll to zoom. The hills are the real terrain around the site, and the dishes tilt to the pointing; the grass, the trees and the clouds are made up. The colours in the sky show the radio sky at 408 MHz. The bright band is the Milky Way, where most of the radio emission comes from. Turn off the Landscape layer to see the radio sky alone."],
  ["The beam", "The 64 dishes do not move. They all point at one declination on the meridian, the line from north to south through the zenith. The rings show where the beam has half its peak sensitivity, at the two ends of the chosen band. Low frequencies (red) see a wider patch of sky than high frequencies (violet)."],
  ["A drift scan", "The Earth turns, and the sky drifts through the beam once a day. The dashed lines show the strip of sky that passes through the beam. The dots along it show where the beam will point in the hours ahead, in local time."],
  ["Radio sees in daylight", "In the ground and dome views the stars fade during the day, but the radio sky does not: radio waves pass through the daylit atmosphere, and through clouds too. The Sun is still a very bright radio source, so the panel tells you when it crosses the strip."],
  ["Frequency is distance", "Hydrogen gas emits at 1420 MHz. The expansion of the universe stretches that line to lower frequencies, so each frequency in the band sees hydrogen at one distance and one time in the past. The band panel shows the redshift and the lookback time."],
  ["The array beam", "Set the beam to Array to see the 8 × 8 grid of dishes added together. The narrow peaks repeat across the sky (grating lobes) because the dishes are evenly spaced. Over a wide band each lobe spreads into a small rainbow, because each frequency puts it at a different place."],
  ["Explore", "Select any object for its details, or search for it by name. Pulsars flash at their own period; the fastest show as a steady glow. A faint dot is a fast radio burst that CHIME, the telescope next door, caught once; a ringed dot is a source that has burst again. Use the time controls to watch a day go by, or select a baseband dump to see where the dishes pointed when it was taken."],
];
function wireExplain() {
  let i = 0;
  const show = () => {
    $("ex-title").textContent = STEPS[i][0];
    $("ex-body").textContent = STEPS[i][1];
    $("ex-count").textContent = `${i + 1} / ${STEPS.length}`;
    $("ex-prev").disabled = i === 0;
    $("ex-next").textContent = i === STEPS.length - 1 ? "Close" : "Next";
  };
  $("explain-btn").onclick = () => { i = 0; show(); $("explain").showModal(); };
  $("ex-prev").onclick = () => { i = Math.max(0, i - 1); show(); };
  $("ex-next").onclick = () => { if (i === STEPS.length - 1) $("explain").close(); else { i++; show(); } };
}

function credits() {
  const items = [
    `Radio sky: ${skyMeta.map}. Resampled from the HEALPix map (NSIDE ${skyMeta.nside}).`,
    `Radio sources: ${cat.credits["3crr"]}.`,
    `Bright radio sources: ${cat.credits.nvss}. Kept: brighter than 5 Jy at 400 MHz, north of −40°; components within 4′ are one source.`,
    `Supernova remnants: ${cat.credits.snrs}.`,
    `Pulsars: ${cat.credits.pulsars}.`,
    ...(frbCat ? [`Fast radio bursts: ${frbCat.credit}. The bursts CHIME saw from the same site up to September 2023; a repeater is drawn once, at its best-measured position.`] : []),
    `Stars and constellations: ${cat.credits.stars}. Licence below.`,
    ...(horizon.flat ? [] : [`Skyline: computed from ${horizon.source} (https://registry.opendata.aws/terrain-tiles/).`]),
    "The Moon's face: NASA's Scientific Visualization Studio, CGI Moon Kit, from the Lunar Reconnaissance Orbiter camera's mosaic (https://svs.gsfc.nasa.gov/4720).",
    "Positions of the Sun and the Moon: J. Meeus, Astronomical Algorithms, 2nd ed. (1998); precession IAU 1976. Checked against astropy.",
    "Planets: E. M. Standish, Keplerian Elements for Approximate Positions of the Major Planets (JPL), valid 1800–2050; within 2′ of astropy, Jupiter and Saturn within 10′.",
    "The drift trace's Sun is a quiet Sun of about 25 sfu at 400 MHz, rising as f^0.8, seen through the main lobe only. The active Sun is a few times brighter, and bursts far more.",
    "Cosmology: flat ΛCDM with H₀ = 67.66 km/s/Mpc and Ωm = 0.3111 (Planck 2018).",
    "Daylight and twilight: single scattering by air and aerosol, with ozone absorption, in a spherical atmosphere, plus an estimate of the higher orders; coefficients from E. Bruneton, A Qualitative and Quantitative Evaluation of 8 Clear Sky Models (2017). In the Landscape layer the hills are the real terrain (the skyline's SRTM data) with made-up detail and trees; the ground near you, the mist and the clouds are made up; the dishes follow photographs.",
    "The beam is a model: a Gaussian main lobe for each dish, times the array factor of an ideal 8 × 8 grid. The real beam has sidelobes and errors not shown here.",
    `Catalogue built ${cat.generated}.`,
  ];
  $("credit-list").innerHTML = items.map((t) => `<li>${esc(t).replace(/(https:\/\/[^\s,]+)/g, '<a href="$1" rel="noopener">$1</a>')}</li>`).join("");
  $("d3c-license").textContent = cat.credits.d3_celestial_license;
}

// ---------------------------------------------------------------- start

async function main() {
  setFont(getComputedStyle(document.documentElement).getPropertyValue("--font").trim() || "system-ui");
  let img;
  try { img = await load(); } catch (err) { fail(`Could not load the sky data: ${err.message}`); return; }
  data = buildData();
  st.pointing = site.default_pointing;
  st.band = site.default_band_mhz.slice();
  readHash();
  resize();
  try { gl = new SkyGL($("sky"), img, { alt: horizon.alt_deg, dist: horizon.flat ? null : horizon.dist_km }, readHash.cut); } catch (err) { fail(`This page needs WebGL. ${err.message}`); return; }
  const hint = $("hint").textContent;
  gl.onStage = (s) => { $("hint").textContent = `Landscape: ${s}`; };
  gl.onReady = () => {                                  // the Landscape can be drawn
    dirty = true;
    landProbe();
    $("hint").textContent = `Landscape ready: shaders ${(gl.compileMs / 1000).toFixed(1)} s, terrain ${(gl.bakeMs / 1000).toFixed(1)} s, on ${gl.renderer()}`;
    setTimeout(() => { $("hint").textContent = hint; }, 20000);
  };
  overlay = new Overlay($("ov"));
  trace = new Trace($("trace"), img, skyMeta);
  wireControls();
  wirePointer();
  setPointing(st.pointing, st.customDec);
  setBand(...st.band);
  setBeam(st.beamMode);
  frame = computeFrame();
  setView(st.view.kind);
  if (st.view.kind !== "chart" && st.view.alt0 == null) st.view.alt0 = aim(st.view.kind).alt0;
  if (st.view.lon0 == null) { st.view.lon0 = 0; if (st.view.kind === "chart") lookAt(frame.boreJ2000); }
  syncTimeControls();
  window.addEventListener("resize", resize);
  render();
  if (readHash.sel && nameIndex.has(readHash.sel)) select(nameIndex.get(readHash.sel));
  panels();
  requestAnimationFrame(loop);
}

function fail(msg) {
  $("error").style.display = "grid";
  $("error").textContent = msg;
  $("panel").style.display = "none";
}

main();
