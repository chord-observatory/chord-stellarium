// The CHORD dishes in the ground and dome views: the 8 x 8 grid of 6 m
// paraboloids on their pedestals, every one tilted along the meridian to
// the beam's declination, so they turn when the pointing does.  Drawn on a
// 2D canvas between the sky and the overlay, far dishes first.  The
// observer stands on a rise north-east of the array, looking south.  The
// shape follows photographs of the first dishes: a deep white bowl (f/D
// 0.21, so the feed sits inside it on three short legs), a white box at its
// back, and a low dark steel cradle.
//
// Light comes from the same model as the sky (atmos.js): the Sun, the Moon
// and the skylight, through the same display curve.  Each bowl is a mesh of
// facets shaded one by one, finer for the nearer dishes.

import { apply, cross, norm, dot } from "./astro.js";
import { project } from "./proj.js";

export const EYE_M = 10;                   // the eye above the array's ground
export const ARRAY_AT = [-40, -80];       // the array's centre east and north of the observer (m)
const F_OVER_D = 0.21, AXIS_M = 2.0;
const LEG_ANGLES = [90, 210, 330];

const curve = (x, strength) => strength * Math.pow(1 - Math.exp(-Math.max(x, 0)), 1 / 2.2);

/** An rgb() string for albedo alb (grey) with normal n under light L: the
 *  Sun (sun: the share that reaches the surface; gloss: its glint), the
 *  Moon, the sky above, the light the ground sends back, and at night the
 *  sky's own soft light. */
function shade(alb, n, L, sun = 1, gloss = 0) {
  const s = Math.max(dot(n, L.sun), 0) * sun, m = Math.max(dot(n, L.moon), 0), down = 0.5 - 0.5 * n[2];
  // Skylight: more from above, and more from the Sun's side of the sky.
  const sh = Math.hypot(L.sun[0], L.sun[1]) || 1, toSun = (n[0] * L.sun[0] + n[1] * L.sun[1]) / sh;
  const up = 0.3 + 0.7 * (0.5 + 0.5 * n[2]) + 0.25 * Math.max(toSun, 0) * (1 - Math.abs(n[2]));
  const g = Math.max(L.sun[2], 0);
  const tn = Math.min(1, Math.max(0, (L.sun[2] + 0.22) / 0.2)), night = 1 - tn * tn * (3 - 2 * tn);
  const c = [0, 1, 2].map((k) => {
    const lin = L.sunLin[k] * s + L.ambLin[k] * up + 0.3 * (L.sunLin[k] * g + L.ambLin[k]) * down * [1, 0.86, 0.6][k]   // off the straw
      + L.moonLin[k] * m * 0.6 + [0.075, 0.07, 0.21][k] * night * (0.75 + 0.25 * n[2]) + [0.0015, 0.002, 0.0032][k];
    return Math.round(255 * curve(alb * lin + gloss * L.sunLin[k] * sun, L.strength));
  });
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

function poly(ctx, pts) {
  ctx.beginPath();
  pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.closePath();
}

// A stable random number 0..1 for a cell of the bowl's surface.
const speck = (i, j) => { const x = Math.sin(i * 127.1 + j * 311.7) * 43758.5453; return x - Math.floor(x); };

/** The bowl's surface as rings x sectors of facets, the same for every dish:
 *  each facet's inward normal, and its colour seen from inside and from
 *  outside.  Inside, the bowl's own wall shades it; outside, the white
 *  gelcoat has a soft glint and is a little weathered, with rain streaks
 *  below the rim. */
function facets(nr, ns, R, f, a, u, w, L, view) {
  const depth = (R * R) / (4 * f), sl = [dot(L.sun, u), dot(L.sun, w), dot(L.sun, a)];
  const out = [];
  for (let i = 0; i < nr; i++) {
    const r = ((i + 0.5) / nr) * R, z = (r * r) / (4 * f);
    for (let j = 0; j < ns; j++) {
      const phi = ((j + 0.5) / ns) * 2 * Math.PI, c = Math.cos(phi), s = Math.sin(phi);
      const rad = [u[0] * c + w[0] * s, u[1] * c + w[1] * s, u[2] * c + w[2] * s];
      const k = r / (2 * f);
      const nIn = norm([a[0] - k * rad[0], a[1] - k * rad[1], a[2] - k * rad[2]]), nOut = nIn.map((x) => -x);
      // Inside: does the Sun reach this point past the rim?
      let lit = 0;
      if (sl[2] > 0.02) {
        const t = (depth - z) / sl[2], x = r * c + sl[0] * t, y = r * s + sl[1] * t;
        lit = Math.min(1, Math.max(0, (R - Math.hypot(x, y)) / 0.5 + 0.5));
      }
      const grime = (1 - 0.06 * speck(i, j) - 0.2 * speck(99, j) * (i / nr) * Math.max(0, -rad[2])) * (0.8 + 0.2 * Math.min(1, (i + 0.5) / nr * 2.5))
        * (nr > 4 && i === Math.round(nr * 0.6) ? 0.9 : 1);   // streaks below the rim, shade by the box, a seam
      const h = norm([L.sun[0] + view[0], L.sun[1] + view[1], L.sun[2] + view[2]]);
      const glint = 0.22 * Math.pow(Math.max(dot(nOut, h), 0), 24);
      out.push({ nIn, inside: shade(0.84 * (0.72 + 0.28 * (i + 0.5) / nr), nIn, L, lit), outside: shade(0.82 * grime, nOut, L, 1, glint) });
    }
  }
  return out;
}

/**
 * S: { cam, dpr, ob, array: site.json array, bore: the beam (ENU), light:
 * { sun, moon (ENU), sunLin, ambLin, moonLin, strength, cloud(P): the share
 * of sunlight the clouds let through to P (m east, north) } }.
 */
export function drawDishes(ctx, S) {
  const { cam, ob, array, bore: a, light: L0 } = S;
  ctx.setTransform(S.dpr, 0, 0, S.dpr, 0, 0);
  ctx.clearRect(0, 0, cam.w, cam.h);
  const scr = (P) => project(cam, apply(ob.fromEnu, norm(P)));
  const add = (P, v, k) => [P[0] + v[0] * k, P[1] + v[1] * k, P[2] + v[2] * k];
  const u = Math.abs(a[2]) > 0.999 ? [1, 0, 0] : norm(cross(a, [0, 0, 1]));
  const w = cross(a, u);
  const R = array.dish_diameter_m / 2, f = F_OVER_D * array.dish_diameter_m;
  const surf = (V, r, phi) => {
    const c = Math.cos(phi * Math.PI / 180) * r, s = Math.sin(phi * Math.PI / 180) * r;
    return [V[0] + a[0] * r * r / (4 * f) + u[0] * c + w[0] * s, V[1] + a[1] * r * r / (4 * f) + u[1] * c + w[1] * s,
      V[2] + a[2] * r * r / (4 * f) + u[2] * c + w[2] * s];
  };
  const view = norm([-ARRAY_AT[0], -ARRAY_AT[1], EYE_M]);       // from the array to the eye
  // A cloud's shadow crosses the array dish by dish: the colours are worked
  // out once for each of a few levels of sunlight, and each dish takes the
  // level of the shadow where it stands.
  const LEVELS = 8, levels = [];
  const level = (B) => {
    const k = Math.round(L0.cloud(B) * LEVELS);
    if (!levels[k]) {
      const L = { ...L0, sunLin: L0.sunLin.map((x) => (x * k) / LEVELS) };
      levels[k] = { L, meshes: {}, metal: shade(0.3, [0, 0, 1], L), box: shade(0.8, norm(add([0, 0, 0.3], a, -1)), L),
        lip: shade(0.9, norm(add(a, [0, 0, 1], 1)), L) };
    }
    return levels[k];
  };

  const dishes = [];
  for (let i = 0; i < array.nx; i++) for (let j = 0; j < array.ny; j++) {
    const B = [ARRAY_AT[0] + (i - (array.nx - 1) / 2) * array.dx_m, ARRAY_AT[1] + (j - (array.ny - 1) / 2) * array.dy_m, -EYE_M];
    dishes.push({ B, V: [B[0], B[1], B[2] + AXIS_M], d: Math.hypot(B[0], B[1]) });
  }
  dishes.sort((p, q) => q.d - p.d);
  ctx.lineJoin = "round";
  for (const { B, V } of dishes) {
    const v0 = scr(V), base = scr(B), m1 = scr(add(V, u, 1));
    if (!v0 || !base || !m1) continue;
    const pxPerM = Math.hypot(m1[0] - v0[0], m1[1] - v0[1]);
    const lv = level(B), { metal, box, lip } = lv;
    const mesh = (nr, ns) => (lv.meshes[nr] ??= { nr, ns, f: facets(nr, ns, R, f, a, u, w, lv.L, view) });
    const M = pxPerM > 9 ? mesh(7, 32) : pxPerM > 3 ? mesh(4, 20) : mesh(2, 12);
    // The facets' corners on screen: ring i (0 the vertex .. nr the rim), sector j.
    const P = [], W = [];
    let ok = true;
    for (let i = 0; i <= M.nr && ok; i++) for (let j = 0; j < M.ns; j++) {
      const p3 = surf(V, (i / M.nr) * R, (j * 360) / M.ns), q = scr(p3);
      if (!q) { ok = false; break; }
      P.push(q); W.push(p3);
    }
    if (!ok) continue;
    const C = add(V, a, (R * R) / (4 * f));                 // the aperture's centre
    const front = dot(a, norm(C.map((x) => -x))) > 0;
    const F = add(V, a, f), feed = [scr(add(F, a, -0.25)), scr(F)];

    // The cradle and the box behind the bowl.
    const side = norm([-C[1], C[0], 0]);
    const H = add(V, a, -0.7);
    const ped = [add(B, side, -1.5), add(B, side, 1.5), add(H, side, 0.6), add(H, side, -0.6)].map(scr);
    if (ped.every(Boolean)) {
      ctx.fillStyle = metal; poly(ctx, ped); ctx.fill();
      ctx.strokeStyle = metal; ctx.lineWidth = Math.max(0.6, 0.1 * pxPerM);   // braces out to the feet
      for (const k of [-2.2, 2.2]) {
        const g = scr(add(B, side, k)), top = scr(add(V, side, k * 0.45));
        if (g && top) { ctx.beginPath(); ctx.moveTo(g[0], g[1]); ctx.lineTo(top[0], top[1]); ctx.stroke(); }
      }
    }
    const bx = [add(H, side, -0.75), add(H, side, 0.75), add(V, side, 0.95), add(V, side, -0.95)].map(scr);
    if (bx.every(Boolean)) { ctx.fillStyle = box; poly(ctx, bx); ctx.fill(); }

    // The bowl: each facet from the side that faces the eye; inside first,
    // then the feed, then the outside (which is nearer where they overlap).
    ctx.lineWidth = 0.8;
    const face = (inside) => {
      for (let i = 0; i < M.nr; i++) for (let j = 0; j < M.ns; j++) {
        const j1 = (j + 1) % M.ns, k00 = i * M.ns + j, k11 = (i + 1) * M.ns + j1;
        const fc = M.f[i * M.ns + j], mid = W[k00], mid2 = W[k11];
        const toEye = -(fc.nIn[0] * (mid[0] + mid2[0]) + fc.nIn[1] * (mid[1] + mid2[1]) + fc.nIn[2] * (mid[2] + mid2[2]));
        if ((toEye > 0) !== inside) continue;
        ctx.fillStyle = ctx.strokeStyle = inside ? fc.inside : fc.outside;
        poly(ctx, [P[k00], P[i * M.ns + j1], P[k11], P[(i + 1) * M.ns + j]]);
        ctx.fill(); ctx.stroke();
      }
    };
    face(true);
    if (front && feed[0] && feed[1]) {
      ctx.strokeStyle = metal;
      ctx.lineWidth = Math.max(0.5, 0.05 * pxPerM);
      for (const phi of LEG_ANGLES) {
        const r0 = scr(surf(V, R * 0.3, phi));
        if (r0) { ctx.beginPath(); ctx.moveTo(r0[0], r0[1]); ctx.lineTo(feed[0][0], feed[0][1]); ctx.stroke(); }
      }
      ctx.lineWidth = Math.max(1, 0.3 * pxPerM);
      ctx.beginPath(); ctx.moveTo(feed[0][0], feed[0][1]); ctx.lineTo(feed[1][0], feed[1][1]); ctx.stroke();
      ctx.lineWidth = 0.8;
    }
    const rim = () => {
      ctx.strokeStyle = lip;
      ctx.lineWidth = Math.max(0.8, 0.1 * pxPerM);
      poly(ctx, P.slice(M.nr * M.ns));
      ctx.stroke();
      ctx.lineWidth = 0.8;
    };
    if (!front) rim();                                     // seen from behind, the bowl hides the near rim
    face(false);
    if (front) rim();
  }
}
