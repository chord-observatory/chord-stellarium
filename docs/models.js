// The things built on the site, drawn as triangle meshes in WebGL on their
// own canvas between the sky and the overlay: the CHORD dishes, CHIME's
// cylinders, the Galt 26 m dish, the buildings and containers, and the
// paving (layout.js).  The shader is
// small, so it compiles at once anywhere (the sky's is the slow one); the
// meshes are cheap to draw.  Nothing here is hidden by the terrain (the
// site is level and kept clear of trees), so the paving lies on this
// canvas over the ground, and each model's shadow is the model flattened
// onto the ground along the Sun, drawn as a veil over what is below.
//
// The dishes follow photographs of the first ones: a deep white bowl (f/D
// 0.21, so the feed sits inside it on three short legs), a white box at its
// back, and a low dark steel cradle.  Every dish is tilted along the
// meridian to the beam's declination, so they turn when the pointing does.
//
// Light comes from the same model as the sky (atmos.js): the Sun, the Moon
// and the skylight, through the same display curve.

import { cross, norm, dot } from "./astro.js";
import { EYE_M } from "./layout.js";

const F_OVER_D = 0.21, AXIS_M = 2.0;
const LEG_ANGLES = [90, 210, 330];
const FAR_M = 4000;                       // depth: distances up to this
const STRIDE = 9;                         // floats per vertex: position, normal, material, (r / R, phi)

// Materials: 0 the bowl (its inside and outside), 1 white paint (the
// dish's box, containers), 2 steel, 3 the rim, 4 wall, 5 flat roof,
// 6 asphalt, 7 wire-mesh reflector (seen through: drawn last, part
// transparent), 8 white steel.
const VERT = `
attribute vec3 aPos;      // m east, north, up of the dish's foot
attribute vec3 aNorm;
attribute float aMat;
attribute vec2 aLoc;      // on the bowl: r / R and the angle about its axis
uniform vec3 uAt;         // the foot, from the eye (m)
uniform mat3 uCam;        // ENU -> camera (right, up, forward)
uniform float uScale;     // CSS px per projection unit
uniform vec2 uCentre, uPan, uSize;
uniform vec3 uSun;
uniform float uFlat;      // 1: flattened onto the ground along the Sun (a shadow)
varying vec3 vPos, vNorm;
varying float vMat;
varying vec2 vLoc;
void main() {
  vec3 p = aPos + uAt;
  if (uFlat > 0.5) p -= uSun * (aPos.z - 0.03) / uSun.z;
  vPos = p; vNorm = aNorm; vMat = aMat; vLoc = aLoc;
  vec3 c = uCam * normalize(p);
  if (c.z < -0.5) { gl_Position = vec4(0.0, 0.0, 2.0, 1.0); return; }   // behind the eye
  vec2 q = 2.0 / (1.0 + c.z) * c.xy;                     // stereographic, as proj.js
  vec2 s = uCentre + uScale * (q - uPan) * vec2(1.0, -1.0);
  gl_Position = vec4(2.0 * s.x / uSize.x - 1.0, 1.0 - 2.0 * s.y / uSize.y, 2.0 * length(p) / ${FAR_M.toFixed(1)} - 1.0, 1.0);
}`;

const FRAG = `
precision highp float;
uniform vec3 uSun, uMoon, uSunLin, uAmbLin, uMoonLin;
uniform float uStrength, uCloud;
uniform float uShadowA;   // a shadow: how much it darkens what is below
uniform float uPass;      // 0: all but the wire mesh; 1: the wire mesh only
const float MESH_A = 0.55; // how much of the light a wire-mesh reflector stops
uniform vec3 uSl;         // the Sun in the bowl's frame (u, w, axis)
varying vec3 vPos, vNorm;
varying float vMat;
varying vec2 vLoc;
const float R = 3.0, F = ${(F_OVER_D * 6).toFixed(3)};
vec3 curve(vec3 x) { return uStrength * pow(1.0 - exp(-max(x, 0.0)), vec3(1.0 / 2.2)); }
// As the 2D dishes had it: the Sun (sun: the share that reaches here;
// gloss: its glint), the Moon, the sky above, the light the ground sends
// back, and at night the sky's own soft light.
vec3 shade(vec3 alb, vec3 n, float sun, float gloss) {
  float s = max(dot(n, uSun), 0.0) * sun, m = max(dot(n, uMoon), 0.0), down = 0.5 - 0.5 * n.z;
  float sh = max(length(uSun.xy), 1e-6), toSun = dot(n.xy, uSun.xy) / sh;
  float up = 0.3 + 0.7 * (0.5 + 0.5 * n.z) + 0.25 * max(toSun, 0.0) * (1.0 - abs(n.z));
  float g = max(uSun.z, 0.0), tn = clamp((uSun.z + 0.22) / 0.2, 0.0, 1.0), night = 1.0 - tn * tn * (3.0 - 2.0 * tn);
  vec3 lin = uSunLin * s + uAmbLin * up + 0.3 * (uSunLin * g + uAmbLin) * down * vec3(1.0, 0.86, 0.6)
    + uMoonLin * m * 0.6 + vec3(0.075, 0.07, 0.21) * night * (0.75 + 0.25 * n.z) + vec3(0.0015, 0.002, 0.0032);
  return curve(alb * lin + gloss * uSunLin * sun);
}
float grain(vec2 P, float k) { return fract(sin(dot(floor(P * k), vec2(12.9898, 78.233))) * 43758.5453); }
void main() {
  if (uShadowA > 0.0) { gl_FragColor = vec4(0.0, 0.0, 0.0, uShadowA); return; }
  vec3 view = normalize(-vPos), n = normalize(vNorm);
  int mat = int(vMat + 0.5);
  if ((mat == 7) != (uPass > 0.5)) discard;
  vec3 col;
  if (mat == 0) {
    bool inside = dot(n, view) > 0.0;                     // n is the bowl's inward normal
    if (inside) {
      // Does the Sun reach this point past the rim?
      float lit = 0.0;
      if (uSl.z > 0.02) {
        float r = vLoc.x * R, z = r * r / (4.0 * F), t = (R * R / (4.0 * F) - z) / uSl.z;
        lit = clamp((R - length(vec2(r * cos(vLoc.y), r * sin(vLoc.y)) + uSl.xy * t)) / 0.5 + 0.5, 0.0, 1.0);
      }
      col = shade(vec3(0.84 * (0.72 + 0.28 * vLoc.x)), n, lit * uCloud, 0.0);
    } else {
      vec3 h = normalize(uSun + view);
      float glint = 0.22 * pow(max(dot(-n, h), 0.0), 24.0);
      col = shade(vec3(0.82 * (0.8 + 0.2 * min(1.0, vLoc.x * 2.5))), -n, uCloud, glint);
    }
  } else {
    if (dot(n, view) < 0.0) n = -n;
    vec3 alb = mat == 1 ? vec3(0.8) : mat == 2 ? vec3(0.3) : mat == 3 ? vec3(0.9) : mat == 4 ? vec3(0.62, 0.58, 0.5)
      : mat == 5 ? vec3(0.46, 0.45, 0.42) * (0.93 + 0.14 * grain(vPos.xy, 8.0))                     // gravel on the roof
      : mat == 6 ? vec3(0.15, 0.15, 0.15) * (0.9 + 0.2 * grain(vPos.xy, 3.0))                     // asphalt
      : mat == 7 ? vec3(0.42, 0.43, 0.45) : vec3(0.86);
    col = shade(alb, n, uCloud, 0.0);
    if (mat == 7) { gl_FragColor = vec4(col * MESH_A, MESH_A); return; }
  }
  gl_FragColor = vec4(col, 1.0);
}`;

function program(gl) {
  const prog = gl.createProgram();
  for (const [type, src] of [[gl.VERTEX_SHADER, VERT], [gl.FRAGMENT_SHADER, FRAG]]) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    gl.attachShader(prog, sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh));
  }
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
  const u = {}, n = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) { const { name } = gl.getActiveUniform(prog, i); u[name] = gl.getUniformLocation(prog, name); }
  return { prog, u };
}

/** A mesh under construction: triangles of (position, normal, material, loc). */
class Mesh {
  constructor() { this.v = []; }
  vert(p, n, mat, loc = [0, 0]) { this.v.push(p[0], p[1], p[2], n[0], n[1], n[2], mat, loc[0], loc[1]); }
  tri(a, b, c, n, mat) { for (const p of [a, b, c]) this.vert(p, n, mat); }
  quad(a, b, c, d, mat) {
    const n = norm(cross(sub(b, a), sub(d, a)));
    this.tri(a, b, c, n, mat); this.tri(a, c, d, n, mat);
  }
  /** A square beam of side t from p to q. */
  beam(p, q, t, mat) {
    const ax = norm(sub(q, p)), s = norm(cross(ax, Math.abs(ax[2]) > 0.9 ? [1, 0, 0] : [0, 0, 1])), r = cross(ax, s);
    const c = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([x, y]) => add(s.map((v) => (v * x * t) / 2), r, (y * t) / 2));
    for (let k = 0; k < 4; k++) {
      const a = c[k], b = c[(k + 1) % 4];
      this.quad(add(p, a, 1), add(p, b, 1), add(q, b, 1), add(q, a, 1), mat);
    }
  }
  /** A box: centre, and its three half axes. */
  box(o, x, y, z, mat) {
    const P = (i, j, k) => add(add(add(o, x, i), y, j), z, k);
    for (const [a, b, c, d] of [
      [P(-1, -1, -1), P(-1, 1, -1), P(1, 1, -1), P(1, -1, -1)], [P(-1, -1, 1), P(1, -1, 1), P(1, 1, 1), P(-1, 1, 1)],
      [P(-1, -1, -1), P(1, -1, -1), P(1, -1, 1), P(-1, -1, 1)], [P(-1, 1, -1), P(-1, 1, 1), P(1, 1, 1), P(1, 1, -1)],
      [P(-1, -1, -1), P(-1, -1, 1), P(-1, 1, 1), P(-1, 1, -1)], [P(1, -1, -1), P(1, 1, -1), P(1, 1, 1), P(1, -1, 1)]]) this.quad(a, b, c, d, mat);
  }
}
const add = (p, v, k = 1) => [p[0] + v[0] * k, p[1] + v[1] * k, p[2] + v[2] * k];
const sub = (p, q) => [p[0] - q[0], p[1] - q[1], p[2] - q[2]];

/** One dish, its foot at the origin, the bowl's axis a (u, w across it):
 *  nr rings x ns sectors on the bowl. */
function dishMesh(a, u, w, D, nr, ns) {
  const M = new Mesh(), R = D / 2, f = F_OVER_D * D, V = [0, 0, AXIS_M];
  const surf = (r, phi) => add(add(add(V, a, (r * r) / (4 * f)), u, r * Math.cos(phi)), w, r * Math.sin(phi));
  const nIn = (r, phi) => norm(a.map((x, k) => x - (r / (2 * f)) * (u[k] * Math.cos(phi) + w[k] * Math.sin(phi))));
  for (let i = 0; i < nr; i++) for (let j = 0; j < ns; j++) {
    const ring = [i, i + 1].map((k) => (k / nr) * R), ph = [j, j + 1].map((k) => (k / ns) * 2 * Math.PI);
    const pts = [[0, 0], [1, 0], [1, 1], [0, 1]];
    const corner = ([ri, pj]) => [surf(ring[ri], ph[pj]), nIn(ring[ri], ph[pj]), 0, [ring[ri] / R, ph[pj]]];
    const [A, B, C, Dd] = pts.map(corner);
    for (const t of [[A, B, C], [A, C, Dd]]) for (const [p, n, m, l] of t) M.vert(p, n, m, l);
  }
  const lip = 0.08;
  for (let j = 0; j < ns; j++) {
    const p0 = (j / ns) * 2 * Math.PI, p1 = ((j + 1) / ns) * 2 * Math.PI;
    M.quad(surf(R, p0), surf(R, p1), add(surf(R, p1), a, lip), add(surf(R, p0), a, lip), 3);
  }
  // The box behind the bowl, the cradle under it and the braces out to its feet.
  M.box(add(V, a, -0.45), [u[0] * 0.75, u[1] * 0.75, u[2] * 0.75], [w[0] * 0.95, w[1] * 0.95, w[2] * 0.95], [a[0] * 0.35, a[1] * 0.35, a[2] * 0.35], 1);
  const side = [1, 0, 0], H = add(V, a, -0.7);
  M.quad(add([0, 0, 0], side, -1.5), add([0, 0, 0], side, 1.5), add(H, side, 0.6), add(H, side, -0.6), 2);
  for (const k of [-2.2, 2.2]) M.beam(add([0, 0, 0], side, k), add(V, side, k * 0.45), 0.12, 2);
  // The feed on its three legs.
  const Fp = add(V, a, f);
  for (const phi of LEG_ANGLES) M.beam(surf(R * 0.3, (phi * Math.PI) / 180), add(Fp, a, -0.25), 0.05, 2);
  M.beam(add(Fp, a, -0.3), Fp, 0.3, 2);
  return new Float32Array(M.v);
}

/** Triangles over a simple polygon (counter-clockwise): ear clipping. */
function triangulate(P) {
  const idx = P.map((_, i) => i), out = [];
  const cr = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  for (let guard = 0; idx.length > 3 && guard < 1000; guard++) {
    for (let k = 0; k < idx.length; k++) {
      const a = P[idx[(k + idx.length - 1) % idx.length]], b = P[idx[k]], c = P[idx[(k + 1) % idx.length]];
      if (cr(a, b, c) <= 0) continue;
      if (idx.some((j) => { const q = P[j]; return q !== a && q !== b && q !== c && cr(a, b, q) > 0 && cr(b, c, q) > 0 && cr(c, a, q) > 0; })) continue;
      out.push([a, b, c]);
      idx.splice(k, 1);
      break;
    }
  }
  out.push(idx.map((j) => P[j]));
  return out;
}

/** A building: its outline (m east and north of the eye, counter-
 *  clockwise), walls to a flat roof at h, a low parapet round it. */
function buildingMesh(pts, h) {
  const M = new Mesh(), p = 0.45;
  pts.forEach((a, i) => {
    const b = pts[(i + 1) % pts.length];
    M.quad([a[0], a[1], 0], [b[0], b[1], 0], [b[0], b[1], h + p], [a[0], a[1], h + p], 4);
  });
  for (const t of triangulate(pts)) M.tri(...t.map((q) => [q[0], q[1], h]), [0, 0, 1], 5);
  return new Float32Array(M.v);
}

/** A tapered post: a square of half side r0 at z0 to r1 at z1, about x, y. */
function frustum(M, x, y, z0, z1, r0, r1, mat) {
  const c = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
  for (let k = 0; k < 4; k++) {
    const [a, b] = [c[k], c[(k + 1) % 4]];
    M.quad([x + a[0] * r0, y + a[1] * r0, z0], [x + b[0] * r0, y + b[1] * r0, z0], [x + b[0] * r1, y + b[1] * r1, z1], [x + a[0] * r1, y + a[1] * r1, z1], mat);
  }
  M.quad([x - r1, y - r1, z1], [x + r1, y - r1, z1], [x + r1, y + r1, z1], [x - r1, y + r1, z1], mat);
}

/** A CHIME cylinder, its middle at the origin, its axis north-south: a
 *  wire-mesh parabolic trough (half width hw, half length hl, focal
 *  length f) on white steel arcs every 5 m, posts under them, A-frames
 *  every 10 m carrying the walkway along the focal line, with railings
 *  (as the user's photograph). */
function chimeMesh(hw, hl, f) {
  const M = new Mesh(), z0 = 1.0, zf = z0 + f, zAt = (x) => z0 + (x * x) / (4 * f);
  const NX = 16, NY = 10;
  for (let i = 0; i < NX; i++) for (let j = 0; j < NY; j++) {
    const x = [i, i + 1].map((k) => -hw + (2 * hw * k) / NX), y = [j, j + 1].map((k) => -hl + (2 * hl * k) / NY);
    const P = (a, b) => [x[a], y[b], zAt(x[a])], nn = (a) => norm([-x[a] / (2 * f), 0, 1]);
    for (const t of [[[0, 0], [1, 0], [1, 1]], [[0, 0], [1, 1], [0, 1]]]) for (const [a, b] of t) M.vert(P(a, b), nn(a), 7);
  }
  for (let y = -hl; y <= hl + 0.01; y += 5) {
    for (let k = 0; k < 8; k++) {
      const xa = -hw + (2 * hw * k) / 8, xb = -hw + (2 * hw * (k + 1)) / 8;
      M.beam([xa, y, zAt(xa) - 0.15], [xb, y, zAt(xb) - 0.15], 0.14, 8);
    }
    for (const x of [-8, -4, 0, 4, 8]) M.beam([x, y, 0], [x, y, zAt(x) - 0.15], 0.1, 8);
  }
  for (const x of [-hw, -hw / 2, 0, hw / 2, hw]) M.beam([x, -hl, zAt(x) - 0.2], [x, hl, zAt(x) - 0.2], 0.12, 8);
  for (let y = -hl; y <= hl + 0.01; y += 10) for (const s of [-1, 1]) M.beam([s * 6, y, 0], [s * 0.4, y, zf], 0.22, 8);
  for (const x of [-0.5, 0.5]) {
    M.beam([x, -hl, zf], [x, hl, zf], 0.2, 8);
    M.beam([x, -hl, zf + 1.0], [x, hl, zf + 1.0], 0.06, 8);
    for (let y = -hl; y <= hl + 0.01; y += 2.5) M.beam([x, y, zf], [x, y, zf + 1.0], 0.05, 8);
  }
  M.quad([-0.5, -hl, zf + 0.1], [0.5, -hl, zf + 0.1], [0.5, hl, zf + 0.1], [-0.5, hl, zf + 0.1], 2);
  return new Float32Array(M.v);
}

/** The Galt 26 m dish, its pedestal's middle at the origin: a tapered
 *  white tower, the mount, and the dish stowed at the zenith: a wire-mesh
 *  paraboloid (f/D 0.3) on white radial ribs and rings, the feed on four
 *  legs; a small hut at the foot (as the user's photograph). */
function galtMesh(D) {
  const M = new Mesh(), R = D / 2, f = 0.3 * D, zv = 17, NR = 8, NS = 48;
  frustum(M, 0, 0, 0, 12, 3.6, 1.9, 1);
  M.box([0, 0, 14], [2.6, 0, 0], [0, 1.6, 0], [0, 0, 2], 1);
  const surf = (r, phi) => [r * Math.cos(phi), r * Math.sin(phi), zv + (r * r) / (4 * f)];
  const nUp = (r, phi) => norm([(-r / (2 * f)) * Math.cos(phi), (-r / (2 * f)) * Math.sin(phi), 1]);
  for (let i = 0; i < NR; i++) for (let j = 0; j < NS; j++) {
    const r = [i, i + 1].map((k) => (k / NR) * R), ph = [j, j + 1].map((k) => (k / NS) * 2 * Math.PI);
    for (const t of [[[0, 0], [1, 0], [1, 1]], [[0, 0], [1, 1], [0, 1]]]) for (const [a, b] of t) M.vert(surf(r[a], ph[b]), nUp(r[a], ph[b]), 7);
  }
  for (let j = 0; j < 24; j++) {
    const phi = (j / 24) * 2 * Math.PI;
    for (let k = 0; k < 6; k++) M.beam(add(surf((k / 6) * R, phi), [0, 0, -0.35], 1), add(surf(((k + 1) / 6) * R, phi), [0, 0, -0.35], 1), 0.18, 8);
  }
  for (const rr of [0.35, 0.7, 1]) for (let j = 0; j < 36; j++) {
    const a = (j / 36) * 2 * Math.PI, b = ((j + 1) / 36) * 2 * Math.PI;
    M.beam(add(surf(rr * R, a), [0, 0, -0.3], 1), add(surf(rr * R, b), [0, 0, -0.3], 1), 0.16, 8);
  }
  const Fz = zv + f;
  for (let j = 0; j < 4; j++) M.beam(surf(0.6 * R, (j / 4) * 2 * Math.PI + Math.PI / 4), [0, 0, Fz - 0.6], 0.16, 8);
  M.box([0, 0, Fz - 0.3], [0.5, 0, 0], [0, 0.5, 0], [0, 0, 0.5], 1);
  M.box([0, 0, zv - 0.6], [2.2, 0, 0], [0, 2.2, 0], [0, 0, 0.8], 1);
  M.box([-6.5, -1, 1.5], [2.5, 0, 0], [0, 2, 0], [0, 0, 1.5], 1);
  return new Float32Array(M.v);
}

/** A shipping container, its foot's middle at the origin. */
function containerMesh(hx, hy) {
  const M = new Mesh();
  M.box([0, 0, 1.3], [hx, 0, 0], [0, hy, 0], [0, 0, 1.3], 1);
  return new Float32Array(M.v);
}

/** Paving: a polygon on the ground (m east and north of the eye). */
function pavedMesh(pts) {
  const M = new Mesh();
  for (const t of triangulate(pts)) M.tri(...t.map((q) => [q[0], q[1], 0.04]), [0, 0, 1], 6);
  return new Float32Array(M.v);
}

export class Models {
  constructor(canvas) {
    const gl = canvas.getContext("webgl", { antialias: true, premultipliedAlpha: true, alpha: true, depth: true, stencil: true });
    if (!gl) throw new Error("WebGL is not available");
    this.gl = gl;
    this.canvas = canvas;
    this.p = program(gl);
    this.meshes = null;
    this.key = "";
  }

  clear() {
    const { gl } = this;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
  }

  /** The dish meshes for the beam's axis a: fine and coarse. */
  dishMeshes(a, D) {
    const key = a.map((x) => x.toFixed(4)).join();
    if (key === this.key) return this.meshes;
    const { gl } = this;
    for (const m of this.meshes || []) gl.deleteBuffer(m.buf);
    const u = Math.abs(a[2]) > 0.999 ? [1, 0, 0] : norm(cross(a, [0, 0, 1])), w = cross(a, u);
    this.uw = [u, w];
    this.meshes = [[8, 40], [3, 16]].map(([nr, ns]) => this.upload(dishMesh(a, u, w, D, nr, ns)));
    this.key = key;
    return this.meshes;
  }

  /** The site's buildings, containers and paving (layout.js siteModels),
   *  as meshes: once, and again when the full array's containers come or
   *  go.  Each with where to take its cloud shade. */
  siteMeshes(site, full) {
    if (this.site?.full === full) return this.site;
    const { gl } = this;
    for (const m of new Set([...(this.site?.solids || []), ...(this.site?.paved || [])].map((it) => it.m))) gl.deleteBuffer(m.buf);
    const mid = (pts) => [pts.reduce((s, q) => s + q[0], 0) / pts.length, pts.reduce((s, q) => s + q[1], 0) / pts.length];
    const solids = [
      ...site.buildings.map((b) => ({ m: this.upload(buildingMesh(b.pts, b.h)), at: [0, 0], c: mid(b.pts) })),
      ...site.containers.map((c) => ({ m: this.upload(containerMesh(c.half[0], c.half[1])), at: c.at, c: c.at })),
    ];
    const ch = site.chime, chime = this.upload(chimeMesh(ch.half[0], ch.half[1], ch.f));
    solids.push(...ch.at.map((at) => ({ m: chime, at, c: at, veil: 0.6 })));
    solids.push({ m: this.upload(galtMesh(site.galt.D)), at: site.galt.at, c: site.galt.at, veil: 0.6 });
    const paved = site.paved.map((pts) => ({ m: this.upload(pavedMesh(pts)), at: [0, 0], c: mid(pts) }));
    for (const r of site.roads) {
      // A strip per stretch, each a little longer than its stretch to close the bends.
      for (let i = 0; i + 1 < r.pts.length; i++) {
        const [a, b] = [r.pts[i], r.pts[i + 1]], L = Math.hypot(b[0] - a[0], b[1] - a[1]);
        const d = [(b[0] - a[0]) / L, (b[1] - a[1]) / L], n = [-d[1] * r.width / 2, d[0] * r.width / 2], e = r.width / 2;
        const A = [a[0] - d[0] * e, a[1] - d[1] * e], B = [b[0] + d[0] * e, b[1] + d[1] * e];
        const pts = [[A[0] - n[0], A[1] - n[1]], [B[0] - n[0], B[1] - n[1]], [B[0] + n[0], B[1] + n[1]], [A[0] + n[0], A[1] + n[1]]];
        paved.push({ m: this.upload(pavedMesh(pts)), at: [0, 0], c: mid([a, b]) });
      }
    }
    return (this.site = { full, solids, paved });
  }

  /**
   * S: { cam, ob, dish: site.json array, dishes: [{ at }], site:
   * layout.js siteModels(full), full, bore: the beam (ENU), light: { sun,
   * moon (ENU), sunLin, ambLin, moonLin, strength, cloud(P): the share of
   * sunlight the clouds let through to P (m east, north of the eye) } }
   */
  draw(S) {
    const { gl, p: { prog, u } } = this, { cam, light: L } = S;
    this.clear();
    gl.useProgram(prog);
    // ENU -> camera: (M^T fromEnu), column-major for uniformMatrix3fv.
    const C = [0, 1, 2].map((r) => [0, 1, 2].map((c) => [0, 1, 2].reduce((s, k) => s + cam.Mt[r * 3 + k] * S.ob.fromEnu[k * 3 + c], 0)));
    gl.uniformMatrix3fv(u.uCam, false, new Float32Array([C[0][0], C[1][0], C[2][0], C[0][1], C[1][1], C[2][1], C[0][2], C[1][2], C[2][2]]));
    gl.uniform1f(u.uScale, cam.s);
    gl.uniform2f(u.uCentre, cam.cx, cam.cy);
    gl.uniform2f(u.uPan, cam.pan[0], cam.pan[1]);
    gl.uniform2f(u.uSize, cam.w, cam.h);
    gl.uniform3fv(u.uSun, L.sun);
    gl.uniform3fv(u.uMoon, L.moon);
    gl.uniform3fv(u.uSunLin, L.sunLin);
    gl.uniform3fv(u.uAmbLin, L.ambLin);
    gl.uniform3fv(u.uMoonLin, L.moonLin);
    gl.uniform1f(u.uStrength, L.strength);
    const a = S.bore, meshes = this.dishMeshes(a, S.dish.dish_diameter_m), [uu, ww] = this.uw;
    gl.uniform3f(u.uSl, dot(L.sun, uu), dot(L.sun, ww), dot(L.sun, a));
    const site = this.siteMeshes(S.site, S.full);
    const attrs = [["aPos", 3, 0], ["aNorm", 3, 3], ["aMat", 1, 6], ["aLoc", 2, 7]].map(([n, size, off]) => [gl.getAttribLocation(prog, n), size, off]);
    let bound = null;
    const put = (m, at, cloud) => {
      if (m !== bound) {
        gl.bindBuffer(gl.ARRAY_BUFFER, m.buf);
        for (const [loc, size, off] of attrs) {
          gl.enableVertexAttribArray(loc);
          gl.vertexAttribPointer(loc, size, gl.FLOAT, false, STRIDE * 4, off * 4);
        }
        bound = m;
      }
      gl.uniform3f(u.uAt, at[0], at[1], -EYE_M);
      gl.uniform1f(u.uCloud, cloud);
      gl.drawArrays(gl.TRIANGLES, 0, m.n);
    };
    const dishes = S.dishes.map(({ at }) => ({ at, c: at, cloud: L.cloud(at), m: cam.s / Math.hypot(at[0], at[1], EYE_M) > 6 ? meshes[0] : meshes[1] }));   // by px per metre, about
    for (const it of [...site.solids, ...site.paved]) it.cloud = L.cloud(it.c);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    // The paving, on the ground under all else.
    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.uniform1f(u.uFlat, 0);
    gl.uniform1f(u.uShadowA, 0);
    gl.uniform1f(u.uPass, 0);
    for (const it of site.paved) put(it.m, it.at, it.cloud);

    // The shadows: each pixel darkened once (the stencil), by what the
    // direct sunlight adds to the skylight on the ground.
    const fade = Math.min(1, Math.max(0, (L.sun[2] - 0.03) / 0.09));
    if (fade > 0) {
      const mean = (v) => (v[0] + v[1] + v[2]) / 3, look = (x) => Math.pow(1 - Math.exp(-0.35 * x), 1 / 2.2);
      const amb = mean(L.ambLin), sun = mean(L.sunLin) * L.sun[2];
      gl.enable(gl.STENCIL_TEST);
      gl.stencilFunc(gl.EQUAL, 0, 0xff);
      gl.stencilOp(gl.KEEP, gl.KEEP, gl.INCR);
      gl.uniform1f(u.uFlat, 1);
      for (const it of [...site.solids, ...dishes]) {
        gl.uniform1f(u.uShadowA, Math.min(0.8, fade * (it.veil ?? 1) * (1 - look(amb) / look(amb + sun * it.cloud))) + 1e-4);
        put(it.m === meshes[0] ? meshes[1] : it.m, it.at, it.cloud);
      }
      gl.disable(gl.STENCIL_TEST);
      gl.uniform1f(u.uFlat, 0);
      gl.uniform1f(u.uShadowA, 0);
    }

    // The buildings, containers and dishes; then again the wire mesh
    // (material 7), seen through, over what is behind it.
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(true);
    gl.uniform1f(u.uPass, 0);
    for (const it of [...site.solids, ...dishes]) put(it.m, it.at, it.cloud);
    gl.depthMask(false);
    gl.uniform1f(u.uPass, 1);
    for (const it of site.solids) if (it.veil) put(it.m, it.at, it.cloud);
    gl.depthMask(true);
  }

  upload(data) {
    const { gl } = this, buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    return { buf, n: data.length / STRIDE };
  }
}
