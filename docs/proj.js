// Projections for the observatory page.  A camera maps J2000 unit vectors
// to screen pixels and back; skygl.js does the inverse per pixel on the
// GPU with the same numbers, overlay.js the forward map for lines and
// labels.
//
// Camera coordinates c are a rotation (and, for charts, a mirror) of
// J2000.  Ground and dome (the same camera, aimed at the horizon or the
// zenith): c = (right, up, forward) about the view direction, drawn
// stereographically.  Chart: c is the equatorial or Galactic frame turned
// to the centre longitude and mirrored so longitude grows to the left
// (the sky seen from inside), drawn as Mollweide or plate carree.

import { DEG, ICRS_TO_GAL, cross, fromColumns, mul, transpose, apply } from "./astro.js";

export const STEREO = 0, MOLL = 1, CAR = 2;
const SQRT2 = Math.SQRT2;
const IDENT = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const MIRROR = [1, 0, 0, 0, -1, 0, 0, 0, 1];
const Rz = (a) => { const c = Math.cos(a), s = Math.sin(a); return [c, -s, 0, s, c, 0, 0, 0, 1]; };

/** Pixels per projection unit that fit the whole projection on screen. */
export function fitScale(proj, w, h) {
  if (proj === STEREO) return Math.min(w, h) / 4.25;      // horizon (radius 2) with a margin
  if (proj === MOLL) return Math.min(w / (4 * SQRT2 * 1.03), h / (2 * SQRT2 * 1.06));
  return Math.min(w / (2 * Math.PI), h / (Math.PI * 1.04));
}

/**
 * view: { kind: "ground" | "dome" | "chart", proj (charts), frame: "eq" | "gal",
 *         az0, alt0 (ground and dome, degrees), lon0 (chart, degrees),
 *         zoom, pan: [x, y] (projection units), w, h, insetL, insetB (CSS px) }
 */
export function makeCamera(view, ob) {
  let M, proj;
  if (view.kind !== "chart") {                            // ground and dome: a camera at the site
    proj = STEREO;
    const a = view.az0 * DEG, h = view.alt0 * DEG;
    const fwd = [Math.cos(h) * Math.sin(a), Math.cos(h) * Math.cos(a), Math.sin(h)];
    const up = [-Math.sin(h) * Math.sin(a), -Math.sin(h) * Math.cos(a), Math.cos(h)];
    M = mul(ob.fromEnu, fromColumns(cross(fwd, up), up, fwd));
  } else {
    proj = view.proj;
    const F = view.frame === "gal" ? transpose(ICRS_TO_GAL) : IDENT;
    M = mul(F, mul(Rz(view.lon0 * DEG), MIRROR));
  }
  // The free area: right of the panel (insetL) and above the trace (insetB).
  const il = view.insetL || 0, iw = view.w - il, ih = view.h - (view.insetB || 0);
  const s = fitScale(proj, iw, ih) * view.zoom;
  return { proj, M, Mt: transpose(M), s, cx: il + iw / 2, cy: ih / 2, pan: view.pan, w: view.w, h: view.h };
}

/** Projection plane coordinates of camera vector c, or null where it does not show. */
export function planeOf(proj, c) {
  if (proj === STEREO) {
    if (c[2] < -0.95) return null;
    const k = 2 / (1 + c[2]);
    return [k * c[0], k * c[1]];
  }
  const lam = Math.atan2(c[1], c[0]), phi = Math.asin(Math.max(-1, Math.min(1, c[2])));
  if (proj === CAR) return [lam, phi];
  let t = phi;                                            // Mollweide: 2t + sin 2t = pi sin phi
  const target = Math.PI * Math.sin(phi);
  if (Math.abs(phi) > 1.5707) t = Math.sign(phi) * Math.PI / 2;
  else for (let i = 0; i < 12; i++) {
    const d = (2 * t + Math.sin(2 * t) - target) / (2 + 2 * Math.cos(2 * t));
    t -= d;
    if (Math.abs(d) < 1e-9) break;
  }
  return [(2 * SQRT2 / Math.PI) * lam * Math.cos(t), SQRT2 * Math.sin(t)];
}

/** Camera vector at projection plane point p, or null outside the projection. */
export function cameraOf(proj, p) {
  const [x, y] = p;
  if (proj === STEREO) {
    const r2 = x * x + y * y, z = (4 - r2) / (4 + r2);
    return [x * (1 + z) / 2, y * (1 + z) / 2, z];
  }
  let lam, phi;
  if (proj === CAR) {
    if (Math.abs(y) > Math.PI / 2) return null;
    lam = x; phi = y;
  } else {
    if (Math.abs(y) > SQRT2) return null;
    const t = Math.asin(y / SQRT2), ct = Math.cos(t);
    lam = (Math.PI * x) / (2 * SQRT2 * Math.max(ct, 1e-9));
    if (Math.abs(lam) > Math.PI) return null;
    phi = Math.asin(Math.max(-1, Math.min(1, (2 * t + Math.sin(2 * t)) / Math.PI)));
  }
  return [Math.cos(phi) * Math.cos(lam), Math.cos(phi) * Math.sin(lam), Math.sin(phi)];
}

export const toScreen = (cam, p) => [cam.cx + cam.s * (p[0] - cam.pan[0]), cam.cy - cam.s * (p[1] - cam.pan[1])];
export const toPlane = (cam, x, y) => [(x - cam.cx) / cam.s + cam.pan[0], (cam.cy - y) / cam.s + cam.pan[1]];

/** Screen position of a J2000 vector: [x, y] in CSS px, or null. */
export function project(cam, v) {
  const p = planeOf(cam.proj, apply(cam.Mt, v));
  return p && toScreen(cam, p);
}

/** J2000 vector under the screen point, or null. */
export function unproject(cam, x, y) {
  const c = cameraOf(cam.proj, toPlane(cam, x, y));
  return c && apply(cam.M, c);
}

/** Horizontal copies to draw: plate carree repeats every 2 pi. */
export function copies(cam) {
  if (cam.proj !== CAR) return [0];
  const period = 2 * Math.PI * cam.s, out = [];
  for (let k = -2; k <= 2; k++) {
    const dx = k * period;
    if (cam.cx + dx - Math.PI * cam.s < cam.w && cam.cx + dx + Math.PI * cam.s > 0) out.push(dx);
  }
  return out;
}

/** The longest plausible jump between neighbouring points, in plane units; a
 *  longer one is a wrap (Mollweide, plate carree) or a pass behind (stereo). */
export const maxJump = (cam) => (cam.proj === STEREO ? 1.5 : 1.0);
