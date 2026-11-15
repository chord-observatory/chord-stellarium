// The sky layer: one WebGL1 fragment shader that, for each pixel, inverts
// the projection (proj.js), looks up the 408 MHz sky (sky.png), shades the
// ground and the daylight, and adds the beam.
//
// The beam is drawn over the band: BAND_SAMPLES frequencies between the
// two slider handles, evenly spaced in 1/f, each tinted by its place in
// the band (red at the low end, violet at the high end); see beam() for
// how they combine.  Features that move with frequency (the beam edge,
// the grating lobes) spread into colour.  Primary beam: a Gaussian of the
// dish's HPBW.  Array beam: that times the 8 x 8 grid's array factor,
// phased to the boresight.

import { STEREO, MOLL, CAR } from "./proj.js";

export const BAND_SAMPLES = 24;
// Skyline texture encoding: altitude HZ_MIN .. HZ_MIN + HZ_SPAN deg in 16 bits.
const HZ_MIN = "-10.0", HZ_SPAN = "40.0";

const VERT = `
attribute vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }
`;

const FRAG = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform sampler2D uSky;
uniform vec2 uRes;          // drawing buffer, device px
uniform vec3 uView;         // centre x, centre y, scale (device px)
uniform vec2 uPan;
uniform int uProj;
uniform mat3 uCam;          // camera -> J2000
uniform mat3 uToEnu;        // J2000 -> ENU
uniform vec2 uStretch;      // texture value shown as black and as white
uniform float uSkyGain;
uniform float uDay;         // 0 night .. 1 full day (ground and dome views)
uniform float uDome;        // 1 in the ground and dome views, 0 in charts
uniform float uGround;      // the Horizon layer: the ground is opaque (ground, dome) or the
                            // sky below the skyline dimmed (charts); off, the sky shows through
uniform sampler2D uHz;      // skyline: per azimuth step, altitude in 16 bits (R, G)
uniform float uHzN;
uniform vec3 uBore;         // beam centre, ENU
uniform int uBeamMode;      // 0 off, 1 primary, 2 array
uniform float uBeamGain;
uniform float uFlo;
uniform float uFhi;
uniform float uHpbw300;     // deg
uniform vec2 uSpacing;      // grid spacing east, north (m)
uniform vec2 uCount;        // dishes east-west, north-south

const float PI = 3.14159265359;
const float SQRT2 = 1.41421356237;
const float DEG = 0.01745329252;

vec3 inferno(float t) {
  t = clamp(t, 0.0, 1.0) * 5.0;
  vec3 c0 = vec3(0.000, 0.000, 0.016), c1 = vec3(0.259, 0.039, 0.408), c2 = vec3(0.576, 0.149, 0.404);
  vec3 c3 = vec3(0.867, 0.318, 0.227), c4 = vec3(0.988, 0.647, 0.039), c5 = vec3(0.988, 1.000, 0.643);
  if (t < 1.0) return mix(c0, c1, t);
  if (t < 2.0) return mix(c1, c2, t - 1.0);
  if (t < 3.0) return mix(c2, c3, t - 2.0);
  if (t < 4.0) return mix(c3, c4, t - 3.0);
  return mix(c4, c5, t - 4.0);
}

// Red (s = 0, low frequency) through yellow, green and blue to violet (s = 1).
vec3 bandTint(float s) {
  float h = s * 0.78;
  vec3 k = clamp(abs(fract(vec3(h) + vec3(0.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0) - 1.0, 0.0, 1.0);
  return mix(vec3(1.0), k, 0.85);
}

bool cameraOf(vec2 p, out vec3 c) {
  if (uProj == ${STEREO}) {
    float r2 = dot(p, p), z = (4.0 - r2) / (4.0 + r2);
    c = vec3(p * (1.0 + z) * 0.5, z);
    return true;
  }
  float lam, phi;
  if (uProj == ${CAR}) {
    if (abs(p.y) > PI * 0.5) return false;
    lam = p.x; phi = p.y;
  } else {
    if (abs(p.y) > SQRT2) return false;
    float t = asin(p.y / SQRT2);
    lam = PI * p.x / (2.0 * SQRT2 * max(cos(t), 1e-6));
    if (abs(lam) > PI) return false;
    phi = asin(clamp((2.0 * t + sin(2.0 * t)) / PI, -1.0, 1.0));
  }
  c = vec3(cos(phi) * cos(lam), cos(phi) * sin(lam), sin(phi));
  return true;
}

// The terrain skyline's altitude (deg) at azimuth azDeg, linear between
// samples.  The texture is NEAREST; the interpolation is here so the
// 16-bit altitude is decoded before it is mixed.
float skyline(float azDeg) {
  float x = mod(azDeg, 360.0) / 360.0 * uHzN;
  float i0 = floor(x), f = x - i0, i1 = mod(i0 + 1.0, uHzN);
  vec4 a = texture2D(uHz, vec2((i0 + 0.5) / uHzN, 0.5));
  vec4 b = texture2D(uHz, vec2((i1 + 0.5) / uHzN, 0.5));
  float ha = (a.r * 65280.0 + a.g * 255.0) / 65535.0 * ${HZ_SPAN} + ${HZ_MIN};
  float hb = (b.r * 65280.0 + b.g * 255.0) / 65535.0 * ${HZ_SPAN} + ${HZ_MIN};
  return mix(ha, hb, f);
}

float arrayFactor(float psi, float n) {
  float d = sin(psi);
  if (abs(d) < 1e-4) return 1.0;
  float a = sin(n * psi) / (n * d);
  return a * a;
}

// The beam over the band: brightness is the envelope (the strongest
// response of any frequency), so a feature only a few frequencies reach,
// such as one grating lobe, is as bright as in a single-frequency view,
// and the main lobe looks the same for any band.  The colour is the mean
// tint weighted by p^4, which picks the frequencies that dominate here:
// white where all respond alike, the band colour where one does.
vec3 beam(vec3 e) {
  float cosOff = dot(e, uBore);
  float wMax = uHpbw300 * 300.0 / uFlo;                     // widest HPBW in the band, deg
  float reach = min(wMax * 2.6, 89.0);
  if (cosOff < cos(reach * DEG) || e.z < 0.0) return vec3(0.0);
  float off = acos(clamp(cosOff, -1.0, 1.0)) / DEG;
  vec2 du = e.xy - uBore.xy;                                  // direction-cosine offsets (east, north)
  vec3 chroma = vec3(0.0), norm = vec3(0.0);
  float env = 0.0;
  for (int k = 0; k < ${BAND_SAMPLES}; k++) {
    float s = float(k) / float(${BAND_SAMPLES - 1});
    float f = 1.0 / mix(1.0 / uFlo, 1.0 / uFhi, s);
    float w = uHpbw300 * 300.0 / f;
    float p = exp(-2.7725887 * off * off / (w * w));
    if (uBeamMode == 2) {
      float lam = 299.792458 / f;
      p *= arrayFactor(PI * uSpacing.x * du.x / lam, uCount.x) * arrayFactor(PI * uSpacing.y * du.y / lam, uCount.y);
    }
    vec3 tint = uFhi - uFlo < 1.0 ? vec3(1.0) : bandTint(s);
    float p2 = p * p;
    chroma += tint * p2 * p2;
    norm += tint;
    env = max(env, p);
  }
  chroma /= norm;
  float m = max(max(chroma.r, chroma.g), chroma.b);
  vec3 hue = m > 0.0 ? chroma / m : vec3(1.0);
  return uBeamMode == 2 ? hue * pow(env, 0.45) * 1.2 : hue * env * 0.32;
}

void main() {
  vec2 px = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y);
  vec2 p = vec2(px.x - uView.x, uView.y - px.y) / uView.z + uPan;
  vec3 c;
  if (!cameraOf(p, c)) { gl_FragColor = vec4(0.0); return; }
  vec3 v = normalize(uCam * c);
  vec3 e = uToEnu * v;

  float ra = atan(v.y, v.x);
  float dec = asin(clamp(v.z, -1.0, 1.0));
  float raw = texture2D(uSky, vec2(fract(ra / (2.0 * PI) + 1.0), (0.5 * PI - dec) / PI)).r;
  float t = clamp((raw - uStretch.x) / (uStretch.y - uStretch.x), 0.0, 1.0);
  vec3 col = vec3(0.012, 0.016, 0.035) + inferno(pow(t, 1.15)) * uSkyGain;

  float alt = asin(clamp(e.z, -1.0, 1.0)) / DEG;
  float hz = skyline(atan(e.x, e.y) / DEG);
  bool below = alt < hz;
  if (uDome > 0.5 && !below) {
    float air = 1.0 - e.z;                                    // brighter toward the horizon
    col += uDay * mix(vec3(0.05, 0.11, 0.24), vec3(0.16, 0.24, 0.36), air * air);
  }
  if (uBeamMode > 0) col += beam(e) * uBeamGain;
  if (below && uGround > 0.5) {
    if (uDome > 0.5) {
      // The ground: darker downward, with a band of haze along the skyline
      // (the same in every direction: below the skyline the distance to
      // the terrain is not known), stronger by day.
      float depth = clamp((hz - alt) / 35.0, 0.0, 1.0);
      vec3 near = mix(vec3(0.034, 0.042, 0.040), vec3(0.20, 0.23, 0.20), uDay);
      vec3 deep = mix(vec3(0.016, 0.020, 0.020), vec3(0.09, 0.11, 0.09), uDay);
      vec3 g = mix(near, deep, sqrt(depth));
      float haze = exp(-(hz - alt) / 1.2);
      g = mix(g, mix(vec3(0.06, 0.08, 0.11), vec3(0.42, 0.50, 0.58), uDay), 0.35 * haze);
      col = g;
    } else col *= 0.5;
  }
  gl_FragColor = vec4(col, 1.0);
}
`;

function compile(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh));
  return sh;
}

// Row-major 3x3 (astro.js) -> column-major for uniformMatrix3fv.
const glMat = (m) => new Float32Array([m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]]);

export class SkyGL {
  /** horizon: { alt: skyline altitude (deg) per azimuth step, from north through east } */
  constructor(canvas, image, horizon) {
    const gl = canvas.getContext("webgl", { antialias: false, premultipliedAlpha: false, preserveDrawingBuffer: true });
    if (!gl) throw new Error("WebGL is not available");
    this.gl = gl;
    this.canvas = canvas;
    const prog = gl.createProgram();
    gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    gl.useProgram(prog);
    this.prog = prog;
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, "aPos");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);   // the values are data, not colours
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, gl.LUMINANCE, gl.UNSIGNED_BYTE, image);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    const hn = horizon.alt.length, px = new Uint8Array(4 * hn);
    for (let i = 0; i < hn; i++) {
      const v = Math.round(Math.max(0, Math.min(1, (horizon.alt[i] - Number(HZ_MIN)) / Number(HZ_SPAN))) * 65535);
      px.set([v >> 8, v & 255, 0, 255], 4 * i);
    }
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, hn, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, px);
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.NEAREST], [gl.TEXTURE_MAG_FILTER, gl.NEAREST],
      [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
    gl.activeTexture(gl.TEXTURE0);
    this.hzN = hn;

    this.u = {};
    const n = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
      const name = gl.getActiveUniform(prog, i).name;
      this.u[name] = gl.getUniformLocation(prog, name);
    }
  }

  /** p: { cam, ob, dpr, stretch, skyGain, day, dome, ground, bore, beamMode, beamGain,
   *       band: [lo, hi], array } */
  draw(p) {
    const { gl, u } = this, d = p.dpr, cam = p.cam;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.uniform2f(u.uRes, this.canvas.width, this.canvas.height);
    gl.uniform3f(u.uView, cam.cx * d, cam.cy * d, cam.s * d);
    gl.uniform2f(u.uPan, cam.pan[0], cam.pan[1]);
    gl.uniform1i(u.uProj, cam.proj);
    gl.uniformMatrix3fv(u.uCam, false, glMat(cam.M));
    gl.uniformMatrix3fv(u.uToEnu, false, glMat(p.ob.toEnu));
    gl.uniform2f(u.uStretch, p.stretch[0], p.stretch[1]);
    gl.uniform1f(u.uSkyGain, p.skyGain);
    gl.uniform1f(u.uDay, p.day);
    gl.uniform1f(u.uDome, p.dome ? 1 : 0);
    gl.uniform1f(u.uGround, p.ground ? 1 : 0);
    gl.uniform3f(u.uBore, p.bore[0], p.bore[1], p.bore[2]);
    gl.uniform1i(u.uBeamMode, p.beamMode);
    gl.uniform1f(u.uBeamGain, p.beamGain);
    gl.uniform1f(u.uFlo, p.band[0]);
    gl.uniform1f(u.uFhi, p.band[1]);
    gl.uniform1f(u.uHpbw300, p.array.hpbw_deg_at_300mhz);
    gl.uniform2f(u.uSpacing, p.array.dx_m, p.array.dy_m);
    gl.uniform2f(u.uCount, p.array.nx, p.array.ny);
    gl.uniform1i(u.uSky, 0);
    gl.uniform1i(u.uHz, 1);
    gl.uniform1f(u.uHzN, this.hzN);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
}
