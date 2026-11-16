// The CHORD dishes in the ground and dome views: the 8 x 8 grid of 6 m
// paraboloids on their pedestals, every one tilted along the meridian to
// the beam's declination, so they turn when the pointing does.  Drawn on a
// 2D canvas between the sky and the overlay, far dishes first.  The
// observer stands on a rise north-east of the array, looking south.  The
// shape is approximate: f/D 0.21, the elevation axis 2.3 m up, three feed
// legs.
//
// Light comes from the same model as the sky (atmos.js): the Sun, the Moon
// and the skylight on each face, through the same display curve.

import { apply, cross, norm, dot } from "./astro.js";
import { project } from "./proj.js";

export const EYE_M = 10;                   // the eye above the array's ground
export const ARRAY_AT = [-40, -80];       // the array's centre east and north of the observer (m)
const F_OVER_D = 0.21, AXIS_M = 2.3;
const RIM_N = 40, LEG_ANGLES = [90, 210, 330];

const curve = (x, strength) => strength * Math.pow(1 - Math.exp(-Math.max(x, 0)), 1 / 2.2);

/** An rgb() string for albedo alb (grey) with normal n under light L: the
 *  Sun, the Moon, the sky above and the light the ground sends back. */
function shade(alb, n, L) {
  const s = Math.max(dot(n, L.sun), 0), m = Math.max(dot(n, L.moon), 0), up = 0.6 + 0.4 * n[2], down = 0.5 - 0.5 * n[2];
  const g = Math.max(L.sun[2], 0);
  const c = [0, 1, 2].map((k) => {
    const lin = L.sunLin[k] * s + L.ambLin[k] * up + 0.25 * (L.sunLin[k] * g + L.ambLin[k]) * down
      + L.moonLin[k] * m * 0.6 + [0.0015, 0.002, 0.0032][k];
    return Math.round(255 * curve(alb * lin, L.strength));
  });
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

/** Convex hull (monotone chain) of 2D points. */
function hull(pts) {
  const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const turn = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], hi = [];
  for (const q of p) { while (lo.length > 1 && turn(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
  for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (hi.length > 1 && turn(hi[hi.length - 2], hi[hi.length - 1], q) <= 0) hi.pop(); hi.push(q); }
  return lo.slice(0, -1).concat(hi.slice(0, -1));
}

function poly(ctx, pts) {
  ctx.beginPath();
  pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.closePath();
}

/**
 * S: { cam, dpr, ob, array: site.json array, bore: the beam (ENU), light:
 * { sun, moon (ENU), sunLin, ambLin, moonLin, strength } }.
 */
export function drawDishes(ctx, S) {
  const { cam, ob, array, bore: a, light: L } = S;
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
  // The Sun's direction across the dish, for the light's gradient on the back.
  const sp = add(L.sun, a, -dot(L.sun, a)), spn = Math.hypot(...sp) > 1e-3 ? norm(sp) : u;
  const backHi = shade(0.8, norm(add(a, spn, -1.4).map((x) => -x)), L);    // the back faces -a
  const backLo = shade(0.8, norm(add(a, spn, 1.4).map((x) => -x)), L);
  const inner = shade(0.8, a, L), innerDeep = shade(0.65, a, L), metal = shade(0.3, [0, 0, 1], L);
  const lip = shade(0.9, norm(add(a, [0, 0, 1], 1)), L);
  const edge = `rgba(150,170,210,${(0.22 * (1 - Math.min(1, L.ambLin[1] * 4))).toFixed(3)})`;   // a hint of rim at night

  const dishes = [];
  for (let i = 0; i < array.nx; i++) for (let j = 0; j < array.ny; j++) {
    const B = [ARRAY_AT[0] + (i - (array.nx - 1) / 2) * array.dx_m, ARRAY_AT[1] + (j - (array.ny - 1) / 2) * array.dy_m, -EYE_M];
    dishes.push({ B, V: [B[0], B[1], B[2] + AXIS_M], d: Math.hypot(B[0], B[1]) });
  }
  dishes.sort((p, q) => q.d - p.d);
  ctx.lineJoin = "round";
  for (const { B, V } of dishes) {
    const rim = [], body = [];
    let ok = true;
    for (let k = 0; k < RIM_N && ok; k++) { const q = scr(surf(V, R, (k * 360) / RIM_N)); if (!q) ok = false; else rim.push(q); }
    for (const r of [R * 0.66, R * 0.33]) for (let k = 0; k < 16 && ok; k++) { const q = scr(surf(V, r, k * 22.5)); if (!q) ok = false; else body.push(q); }
    const v0 = scr(V), base = scr(B);
    if (!ok || !v0 || !base) continue;
    const outline = hull(rim.concat(body, [v0]));
    const C = add(V, a, (R * R) / (4 * f)), toEye = norm(C.map((x) => -x));   // the aperture's centre
    const front = dot(a, toEye) > 0;
    const F = add(V, a, f), feed = [scr(add(F, a, -0.15)), scr(add(F, a, 0.45))];
    const m = scr(add(V, u, 1)), pxPerM = m ? Math.hypot(m[0] - v0[0], m[1] - v0[1]) : 1;

    // Pedestal, then legs and feed when they are behind the bowl.
    const side = norm([toEye[1], -toEye[0], 0]);
    const ped = [add(B, side, -0.8), add(B, side, 0.8), add(V, side, 0.4), add(V, side, -0.4)].map(scr);
    if (ped.every(Boolean)) { ctx.fillStyle = metal; poly(ctx, ped); ctx.fill(); }
    const legs = () => {
      ctx.strokeStyle = metal;
      ctx.lineWidth = Math.max(0.6, 0.08 * pxPerM);
      for (const phi of LEG_ANGLES) {
        const r0 = scr(surf(V, R * 0.98, phi)), mid = scr(add(surf(V, R * 0.6, phi), a, 0.4));
        if (!r0 || !mid || !feed[1]) continue;
        ctx.beginPath(); ctx.moveTo(r0[0], r0[1]); ctx.lineTo(mid[0], mid[1]); ctx.lineTo(feed[1][0], feed[1][1]); ctx.stroke();
      }
      if (feed[0] && feed[1]) {
        ctx.lineWidth = Math.max(1, 0.4 * pxPerM);
        ctx.beginPath(); ctx.moveTo(feed[0][0], feed[0][1]); ctx.lineTo(feed[1][0], feed[1][1]); ctx.stroke();
      }
    };
    const rimLine = () => {
      ctx.strokeStyle = lip;
      ctx.lineWidth = Math.max(1, 0.12 * pxPerM);
      poly(ctx, rim);
      ctx.stroke();
    };
    if (!front) { legs(); rimLine(); }

    // The bowl's back, lit from the Sun's side.
    const hiP = scr(add(C, spn, R)), loP = scr(add(C, spn, -R));
    let fill = backLo;
    if (hiP && loP) {
      fill = ctx.createLinearGradient(hiP[0], hiP[1], loP[0], loP[1]);
      fill.addColorStop(0, backHi);
      fill.addColorStop(1, backLo);
    }
    ctx.fillStyle = fill;
    poly(ctx, outline);
    ctx.fill();
    ctx.strokeStyle = edge;
    ctx.lineWidth = 1;
    ctx.stroke();
    if (!front) {                                          // the mount's plate on the back, in shadow
      const hub = [];
      for (let k = 0; k < 16; k++) { const q = scr(surf(V, R * 0.22, k * 22.5)); if (q) hub.push(q); }
      if (hub.length === 16) { ctx.fillStyle = metal; poly(ctx, hub); ctx.fill(); }
    }

    if (front) {
      ctx.fillStyle = inner;
      poly(ctx, rim);
      ctx.fill();
      const deep = [];
      for (let k = 0; k < 24; k++) { const q = scr(surf(V, R * 0.55, k * 15)); if (q) deep.push(q); }
      if (deep.length === 24) { ctx.fillStyle = innerDeep; poly(ctx, deep); ctx.fill(); }
      rimLine();
      legs();
    }
  }
}
