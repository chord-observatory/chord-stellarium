// The things built on the site, drawn as triangle meshes in WebGL on their
// own canvas between the sky and the overlay: the CHORD dishes and the
// buildings (layout.js).
// The shader is small, so it compiles at once anywhere (the sky's is the
// slow one); the meshes are cheap to draw.  Nothing here is hidden by the
// terrain (the site is level and kept clear of trees).
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

// Materials: 0 the bowl (its inside and outside), 1 the white box, 2 steel,
// 3 the rim, 4 concrete wall, 5 flat roof.
const VERT = `
attribute vec3 aPos;      // m east, north, up of the dish's foot
attribute vec3 aNorm;
attribute float aMat;
attribute vec2 aLoc;      // on the bowl: r / R and the angle about its axis
uniform vec3 uAt;         // the foot, from the eye (m)
uniform mat3 uCam;        // ENU -> camera (right, up, forward)
uniform float uScale;     // CSS px per projection unit
uniform vec2 uCentre, uPan, uSize;
varying vec3 vPos, vNorm;
varying float vMat;
varying vec2 vLoc;
void main() {
  vec3 p = aPos + uAt;
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
void main() {
  vec3 view = normalize(-vPos), n = normalize(vNorm);
  int mat = int(vMat + 0.5);
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
    vec3 alb = mat == 1 ? vec3(0.8) : mat == 2 ? vec3(0.3) : mat == 3 ? vec3(0.9) : mat == 4 ? vec3(0.56, 0.53, 0.47)
      : vec3(0.30, 0.29, 0.27) * (0.93 + 0.14 * fract(sin(dot(floor(vPos.xy * 8.0), vec2(12.9898, 78.233))) * 43758.5453));   // gravel
    col = shade(alb, n, uCloud, 0.0);
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

/** A flat-roofed building, its foot's middle at the origin: half sizes
 *  east and north, and height (m).  A low parapet round the roof, and a
 *  plant box on it. */
function buildingMesh(hx, hy, h) {
  const M = new Mesh(), t = 0.15, p = 0.45;
  M.box([0, 0, h / 2], [hx, 0, 0], [0, hy, 0], [0, 0, h / 2], 4);
  M.quad([-hx, -hy, h + 0.01], [hx, -hy, h + 0.01], [hx, hy, h + 0.01], [-hx, hy, h + 0.01], 5);
  for (const [o, x, y] of [[[0, hy - t, 0], [hx, 0, 0], [0, t, 0]], [[0, -hy + t, 0], [hx, 0, 0], [0, t, 0]],
    [[hx - t, 0, 0], [t, 0, 0], [0, hy, 0]], [[-hx + t, 0, 0], [t, 0, 0], [0, hy, 0]]]) M.box([o[0], o[1], h + p / 2], x, y, [0, 0, p / 2], 4);
  M.box([hx * 0.35, -hy * 0.4, h + 0.55], [1.1, 0, 0], [0, 0.8, 0], [0, 0, 0.55], 1);
  return new Float32Array(M.v);
}

export class Models {
  constructor(canvas) {
    const gl = canvas.getContext("webgl", { antialias: true, premultipliedAlpha: true, alpha: true, depth: true });
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
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
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

  /**
   * S: { cam, ob, dish: site.json array, dishes: [{ at }], buildings: [{ at,
   * half, h }] (layout.js; taken once),
   * bore: the beam (ENU), light: { sun, moon (ENU), sunLin, ambLin, moonLin,
   * strength, cloud(P): the share of sunlight the clouds let through to P
   * (m east, north of the eye) } }
   */
  draw(S) {
    const { gl, p: { prog, u } } = this, { cam, light: L } = S;
    this.clear();
    gl.enable(gl.DEPTH_TEST);
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
    const attrs = [["aPos", 3, 0], ["aNorm", 3, 3], ["aMat", 1, 6], ["aLoc", 2, 7]].map(([n, size, off]) => [gl.getAttribLocation(prog, n), size, off]);
    let bound = null;
    const put = (m, at) => {
      if (m !== bound) {
        gl.bindBuffer(gl.ARRAY_BUFFER, m.buf);
        for (const [loc, size, off] of attrs) {
          gl.enableVertexAttribArray(loc);
          gl.vertexAttribPointer(loc, size, gl.FLOAT, false, STRIDE * 4, off * 4);
        }
        bound = m;
      }
      gl.uniform3f(u.uAt, at[0], at[1], -EYE_M);
      gl.uniform1f(u.uCloud, L.cloud(at));
      gl.drawArrays(gl.TRIANGLES, 0, m.n);
    };
    for (const { at } of S.dishes) put(cam.s / Math.hypot(at[0], at[1], EYE_M) > 6 ? meshes[0] : meshes[1], at);   // by px per metre, about
    this.buildings ??= S.buildings.map((b) => ({ at: b.at, m: this.upload(buildingMesh(b.half[0], b.half[1], b.h)) }));
    for (const b of this.buildings) put(b.m, b.at);
  }

  upload(data) {
    const { gl } = this, buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    return { buf, n: data.length / STRIDE };
  }
}
