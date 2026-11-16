// The sky layer: one WebGL1 fragment shader that, for each pixel, inverts
// the projection (proj.js), looks up the 408 MHz sky (sky.png), adds the
// daylight and twilight (atmos.js) and the beam, and shades the ground.
// The radio sky shows through the daylight and the clouds, as radio waves
// pass through both.  The Landscape layer is part real, part made up: the
// hills from 700 m out are the real terrain (terrain.png), with made-up
// detail and firs; nearer, a made-up plain of bunchgrass that the wind
// sweeps, with firs, brush and boulders; over it, clouds from fractal
// noise on a steady wind.
//
// The beam is drawn over the band: BAND_SAMPLES frequencies between the
// two slider handles, evenly spaced in 1/f, each tinted by its place in
// the band (red at the low end, violet at the high end); see beam() for
// how they combine.  Features that move with frequency (the beam edge,
// the grating lobes) spread into colour.  Primary beam: a Gaussian of the
// dish's HPBW.  Array beam: that times the 8 x 8 grid's array factor,
// phased to the boresight.

import { STEREO, MOLL, CAR } from "./proj.js";
import { LUT_W, LUT_H, LUT_ALT_MIN, LUT_ALT_SPAN } from "./atmos.js";

export const BAND_SAMPLES = 24;
// Skyline texture encoding: altitude HZ_MIN .. HZ_MIN + HZ_SPAN deg in 16 bits.
const HZ_MIN = "-10.0", HZ_SPAN = "40.0";

// The terrain's height maps: half-widths (m) around the observer, texels
// across, and the span of heights (m) that each holds in 16 bits.
const MAPS = [40, 250, 1400, 8000], MAP_NS = [1024, 2048, 2048, 2048];
const MAP_H = [[-12, 40], [-40, 120], [-80, 460], [-260, 1100]];
// The real terrain (terrain.png; tools/make_terrain.py): half-width (m),
// samples across, and metres per unit of R * 256 + G.
const DEM = { half: 8000, n: 512, unit: 0.1 };
const glf = (x) => Number(x).toFixed(4);

const SKYLINE = `
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
`;

// Shared by the sky shader and the map builder.
const NOISE = `
// Value noise from the random texture, smooth across texels.
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return texture2D(uNoise, (i + f + 0.5) / 256.0).r;
}

// Fractal noise, about 0..1.  lod: one pixel in units of p; octaves finer
// than about two pixels fade to their mean, so far detail does not shimmer.
float fbm(vec2 p, float lod) {
  float a = 0.5, s = 0.0;
  for (int k = 0; k < 6; k++) {
    s += a * mix(0.5, noise(p), clamp(1.5 - 2.0 * lod, 0.0, 1.0));
    p = mat2(1.6, 1.2, -1.2, 1.6) * p + 17.0;
    lod *= 2.0;
    a *= 0.5;
  }
  return s / 0.984;
}

float segDist(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a, ba = b - a;
  return length(pa - ba * clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0));
}

// The nearest of the random points scattered one per unit cell: (distance,
// id x, id y); off: from that point to p.
vec3 cells(vec2 p, out vec2 off) {
  vec2 c = floor(p);
  vec3 best = vec3(9.0, 0.0, 0.0);
  off = vec2(0.0);
  for (int i = -1; i <= 1; i++) for (int j = -1; j <= 1; j++) {
    vec2 g = c + vec2(float(i), float(j));
    vec2 r = texture2D(uNoise, (g + 0.5) / 256.0).gb;
    vec2 d = p - g - r;
    if (length(d) < best.x) { best = vec3(length(d), r); off = d; }
  }
  return best;
}

// 1 below a, 0 above b (a < b), smooth between.
float under(float a, float b, float x) { return 1.0 - smoothstep(a, b, x); }

// The larger of a and b, rounded over k.
float smax(float a, float b, float k) { float t = clamp(0.5 + 0.5 * (a - b) / k, 0.0, 1.0); return mix(b, a, t) + k * t * (1.0 - t); }
`;

// The map builder's terrain.
const TERRAIN = `
float rnd(vec2 g) { return texture2D(uNoise, (g + 0.5) / 256.0).r; }

// Value noise with its gradient.
vec3 noised(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f), du = 6.0 * f * (1.0 - f);
  float a = rnd(i), b = rnd(i + vec2(1.0, 0.0)), c = rnd(i + vec2(0.0, 1.0)), d = rnd(i + vec2(1.0, 1.0));
  return vec3(a + (b - a) * u.x + (c - a) * u.y + (a - b - c + d) * u.x * u.y,
              du * (vec2(b - a, c - a) + (a - b - c + d) * u.yx));
}

// Fractal noise whose detail thins out where the slope is steep, as on
// eroded hills (after I. Quilez); about 0..1.
float eroded(vec2 p, float lod) {
  float a = 0.5, s = 0.0;
  vec2 d = vec2(0.0);
  for (int k = 0; k < 9; k++) {
    if (lod > 0.5) break;
    vec3 n = noised(p);
    d += n.yz;
    s += a * n.x / (1.0 + dot(d, d));
    p = mat2(1.6, 1.2, -1.2, 1.6) * p + 17.0;
    lod *= 2.0;
    a *= 0.5;
  }
  return s;
}

// The real terrain's height above the site's ground (m) at P, smoothed
// over its 30 m samples.
float demAt(vec2 P) {
  vec4 t = texture2D(uDem, vec2(0.5 + P.x / ${glf(2 * DEM.half)}, 0.5 - P.y / ${glf(2 * DEM.half)}));
  return (t.r * 65280.0 + t.g * 255.0) * ${glf(DEM.unit)};
}
float demSmooth(vec2 P) {
  const float o = ${glf(DEM.half / DEM.n)};
  return 0.25 * (demAt(P + vec2(o, o)) + demAt(P + vec2(-o, o)) + demAt(P + vec2(o, -o)) + demAt(P - vec2(o, o)));
}
float realH(vec2 P) { return demSmooth(P) - demSmooth(vec2(0.0)); }

// The chance that a tree stands at S: stands and stragglers near by; on the
// real hills, more on slopes that face north and higher up.
float treesAt(vec2 S) {
  float sw = fbm(S * 0.006 + 70.0, 0.0);
  float p = smoothstep(0.47, 0.64, sw) * 0.5 + smoothstep(0.38, 0.47, sw) * 0.05;
  float real = smoothstep(260.0, 700.0, length(S));
  if (real > 0.0) {
    float north = (demSmooth(S - vec2(0.0, 45.0)) - demSmooth(S + vec2(0.0, 45.0))) / 90.0;   // the slope down to the north
    float up = demSmooth(S) - demSmooth(vec2(0.0));
    p = mix(p, (0.55 * smoothstep(0.05, 0.3, north) + 0.3 * smoothstep(150.0, 600.0, up)) * (0.4 + 1.2 * sw), real);
  }
  return clamp(p, 0.0, 1.0);
}

// The terrain at P (m east and north of the observer), for a map of
// uTexel metres per texel: (height above the array's ground (m); tall: 1 in
// a tree, falling over 6 m from it, and above 0 wherever trees may stand; cover: 0 rock, 0.5 grass, 0.75
// brush, 1 tree; beyond 750 m 0.5 .. 1 is the share of trees).  Near
// the observer it is made up: a plain of low swells; knolls with crags,
// boulders and stands of fir.  From 260 m to 700 m out it turns into the
// real terrain, with made-up detail and trees.  The near part is levelled for
// the array's pad and the sight line to the array;
// sagebrush in patches; and the knoll the observer stands on.
vec3 terrainAt(vec2 P) {
  float r = length(P), px = uTexel;
  float swell = (fbm(P * 0.004 + 3.1, px * 0.004) - 0.5) * 18.0;
  float real = smoothstep(260.0, 700.0, r);                  // the real terrain takes over
  float hills = smoothstep(0.38, 0.62, fbm(P * 0.0017 + 7.3, px * 0.0017)) * smoothstep(70.0, 300.0, r) * (1.0 - real);
  float crag = max(hills, real) * smoothstep(0.48, 0.66, fbm(P * 0.011 + 21.0, px * 0.011));
  float ridged = 1.0 - abs(2.0 * fbm(P * 0.03 + 9.7, px * 0.03) - 1.0);
  float outcrop = crag * smoothstep(0.78, 0.97, ridged);     // ledges along lines
  float h = swell + hills * eroded(P * 0.0055 + 11.0, px * 0.0055) * 60.0;
  // The real hills, with made-up gullies and bumps finer than their 30 m samples.
  h = mix(h, realH(P) + (eroded(P * 0.004 + 31.0, px * 0.004) - 0.33) * 45.0 + (fbm(P * 0.02 + 3.0, px * 0.02) - 0.5) * 8.0, real)
    + outcrop * (2.0 + 4.0 * fbm(P * 0.3 + 2.0, px * 0.3));

  vec2 q = abs(P - uArrayBox.xy) - uArrayBox.zw;
  float pad = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0);
  float level = max(under(4.0, 30.0, pad), under(26.0, 48.0, segDist(P, vec2(0.0), uArrayBox.xy)));
  h = smax(h, -0.2, 3.0);                                   // dry hollows silt up into flats
  h = mix(h, min(h, 0.0) * 0.3, level);
  h += (fbm(P * 0.21 + 14.0, px * 0.21) - 0.5) * 0.5;       // hummocks
  h = mix(h, 0.0, under(0.0, 8.0, pad));                    // the pad is level with the dishes' feet

  float m = max(1.0 - r * r / 2500.0, 0.0);                 // the observer's knoll, 50 m across
  if (m > 0.0) h = max(h, (uEyeH - 1.7) * m * m);

  float dry = smoothstep(0.0, 4.0, pad);
  float stone = clamp(outcrop * 2.5, 0.0, 1.0) * (1.0 - level);
  float woody = 0.0, tall = 0.0;
  vec2 off;

  // Boulders, brush and trees stand at random sites.  Whether a site holds
  // one is decided at the site, so each stands whole.
  if (px < 0.5) {
    // Boulders, in fields.
    vec3 b = cells(P * 0.25, off);
    vec2 S = P - off * 4.0;
    float stony = max(under(0.3, 0.45, noise(S * 0.013 + 50.0)) * 0.4, smoothstep(0.55, 0.7, noise(S * 0.02 + 21.0)) * 0.7);
    float rad = (0.1 + 0.3 * b.z * b.z) * step(b.y, stony * 0.6) * step(14.0, length(S));
    float d = rad > 0.0 ? b.x / rad : 2.0;
    h += sqrt(max(1.0 - d * d, 0.0)) * rad * 3.2 * (0.8 + 0.4 * noise(P * 1.7)) * dry;
    stone = max(stone, under(1.0, 1.3, d) * dry);

    // Sagebrush, in patches.
    vec3 c = cells(P * 0.35, off);
    S = P - off / 0.35;
    rad = (0.3 + 0.25 * c.z) * step(c.y, 0.7 * smoothstep(0.45, 0.7, noise(S * 0.012 + 30.0)));
    d = rad > 0.0 ? c.x / rad : 2.0;
    float bush = dry * (1.0 - stone);
    h += sqrt(max(1.0 - d * d, 0.0)) * (0.55 + 0.6 * c.z) * (0.75 + 0.5 * noise(P * 3.0)) * bush;
    woody = 0.5 * under(1.0, 1.35, d) * step(0.5, bush);
  }

  // Firs.
  {
    vec2 g0 = floor(P / 7.0);
    float crown = 0.0, edge = 9.0;
    for (int i = -1; i <= 1; i++) for (int j = -1; j <= 1; j++) {
      vec2 g = g0 + vec2(float(i), float(j));
      vec4 t = texture2D(uNoise, (g + 0.5) / 256.0);
      vec2 S = (g + t.gb) * 7.0;
      vec2 sq = abs(S - uArrayBox.xy) - uArrayBox.zw;
      float open = step(55.0, length(S)) * step(34.0, max(sq.x, sq.y)) * step(52.0, segDist(S, vec2(0.0), uArrayBox.xy));
      if (t.r < treesAt(S) * open) {
        float ht = 5.0 + 11.0 * t.a * t.a, rad = ht * (0.16 + 0.12 * fract(t.a * 7.0));
        if (px > 0.5) rad = max(rad * 1.25, 2.4);              // far off, stout enough for the map
        vec2 o = P - S;
        float d = length(o) / (0.8 + 0.4 * noise(o * 1.1 + t.gb * 40.0));       // lopsided
        float x = d / rad, c;
        if (fract(t.a * 13.0) < 0.0) {
          // A pine: a round crown of clumps on a stout column.
          rad *= 1.15;
          x = d / rad;
          c = ht * pow(max(1.0 - x * x, 0.0), 0.35) * (0.62 + 0.38 * fbm(o * 0.55 + t.gb * 70.0, px * 0.55));
          if (px < 0.5) c *= 0.86 + 0.14 * noise(o * 2.4 + t.gb * 20.0);
        } else if (px < 0.5) {
          // A fir, close by: tiers of boughs, each drooping to a ragged edge.
          float n = clamp(floor(ht / 2.2), 3.0, 6.0);
          float th = atan(o.y, o.x);
          float tier = floor(min(x, 0.999) * n);
          float xs = x * (1.0 + 0.16 * sin(th * (5.0 + tier) + tier * 2.4 + t.a * 30.0)) + 0.05 * (noise(o * 3.1) - 0.5);
          tier = floor(clamp(xs, 0.0, 0.999) * n);
          float f = fract(clamp(xs, 0.0, 0.999) * n);
          c = xs < 1.0 ? ht * (1.0 - (tier + f * f * f) / n) * (1.0 - 0.12 * xs) : 0.0;
        } else c = ht * pow(max(1.0 - x, 0.0), 0.35 + 0.55 * fract(t.a * 13.0));
        crown = max(crown, c);
        edge = min(edge, d - rad);
      }
    }
    if (px < 2.0 && r < 750.0) {
      h += crown * (0.9 + 0.2 * noise(P * 2.3));
      woody = max(woody, under(px, 2.0 * px + 0.3, edge));
      tall = max(clamp(1.0 - edge / 6.0, 0.0, 1.0), 0.03 * step(0.001, treesAt(P) + treesAt(P + 12.0) + treesAt(P - 12.0)) * step(35.0, r));
    } else woody = treesAt(P) * 1.6;                           // beyond 750 m the map only knows how many
  }
  return vec3(h, tall, woody > 0.0 ? 0.5 + 0.5 * woody : 0.5 - 0.5 * stone);
}
`;

const MAP_FRAG = `
precision highp float;
uniform sampler2D uNoise;
uniform vec4 uArrayBox;
uniform float uEyeH;
uniform float uHalf;
uniform float uTexel;       // metres per texel of the map being built
uniform sampler2D uDem;     // the real terrain (DEM)
uniform float uSize;        // texels across the map being built
uniform vec2 uSpan;         // the heights it holds (m)
${NOISE}
${TERRAIN}
void main() {
  vec2 P = (gl_FragCoord.xy / uSize - 0.5) * 2.0 * uHalf;
  vec3 t = terrainAt(P);
  float v = clamp((t.x - uSpan.x) / (uSpan.y - uSpan.x), 0.0, 1.0) * 255.0;
  gl_FragColor = vec4(floor(v) / 255.0, fract(v), t.y, t.z);   // the two height bytes add up under the texture filter
}
`;

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
uniform sampler2D uLut;     // the daylight sky (atmos.js), display values
uniform sampler2D uNoise;   // 256 x 256 random values
uniform mat3 uFromEnu;      // ENU -> J2000
uniform vec3 uSun;          // ENU unit vectors
uniform vec3 uMoon;
uniform vec3 uSunLin;       // light: a white surface facing the Sun, exposed linear (atmos.js)
uniform vec3 uSunLow;       // the same at the cumulus (2 km) and the cirrus (8 km)
uniform vec3 uSunHigh;
uniform vec3 uAmbLin;       // a white level surface under the sky alone
uniform vec3 uMoonLin;      // a white surface facing the Moon (made bright enough to see by)
uniform float uStrength;    // the optical sky's share of the display
uniform float uLand;        // the Landscape layer: daylight, clouds, terrain
uniform float uTime;        // seconds, for the wind
uniform vec2 uWind;         // the wind's direction (east, north)
uniform float uEyeH;        // the eye above the plain (m)
uniform vec4 uArrayBox;     // the array's pad: centre east, north and half-sizes (m) from the eye
uniform float uSunOverHills; // 1 when the Sun is above the real skyline, 0 behind it
uniform sampler2D uMap0;    // the made-up terrain's height maps (MAPS)
uniform sampler2D uMap1;
uniform sampler2D uMap2;
uniform sampler2D uMap3;

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

${SKYLINE}
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

${NOISE}
// ---- the optical sky, the clouds and the landscape (ground and dome views)

vec3 curve(vec3 x) { return uStrength * pow(1.0 - exp(-max(x, 0.0)), vec3(1.0 / 2.2)); }

// The radio sky (display values) toward J2000 unit vector v.
vec3 radioAt(vec3 v) {
  float ra = atan(v.y, v.x);
  float dec = asin(clamp(v.z, -1.0, 1.0));
  float raw = texture2D(uSky, vec2(fract(ra / (2.0 * PI) + 1.0), (0.5 * PI - dec) / PI)).r;
  float t = clamp((raw - uStretch.x) / (uStretch.y - uStretch.x), 0.0, 1.0);
  return vec3(0.012, 0.016, 0.035) + inferno(pow(t, 1.15)) * uSkyGain;
}

// The daylight and twilight sky toward ENU e (display values; atmos.js),
// with the Moon's halo.
vec3 skyAt(vec3 e) {
  float alt = asin(clamp(e.z, -1.0, 1.0)) / DEG;
  float v = sqrt(clamp((alt - ${LUT_ALT_MIN.toFixed(1)}) / ${LUT_ALT_SPAN.toFixed(1)}, 0.0, 1.0));
  float ch = length(e.xy), cs = length(uSun.xy);
  float cphi = ch > 1e-5 && cs > 1e-5 ? dot(e.xy, uSun.xy) / (ch * cs) : 1.0;
  float u = acos(clamp(cphi, -1.0, 1.0)) / PI;
  vec3 c = texture2D(uLut, vec2((u * ${LUT_W - 1}.0 + 0.5) / ${LUT_W}.0, (v * ${LUT_H - 1}.0 + 0.5) / ${LUT_H}.0)).rgb;
  float m = max(dot(e, uMoon), 0.0);
  return c + curve(uMoonLin * (0.6 * pow(m, 2000.0) + 0.04 * pow(m, 40.0)));
}

// The radio sky against a bright sky: its faint background washes out, as
// the stars do, and the bright Galactic plane still shows.
vec3 washed(vec3 radio, vec3 sky) {
  float w = clamp(dot(sky, vec3(0.2126, 0.7152, 0.0722)) / 0.28, 0.0, 1.0);
  return max(radio - w * inferno(0.4) * uSkyGain, 0.0);
}

// Henyey-Greenstein phase, 1 for isotropic scattering.
float hg(float mu, float g) { float g2 = g * g; return (1.0 - g2) / pow(1.0 + g2 - 2.0 * g * mu, 1.5); }

// Distance (km) along e to a cloud deck h km up, on a curved Earth.
float deck(vec3 e, float h) { float b = 6371.0 * e.z; return sqrt(b * b + 2.0 * 6371.0 * h + h * h) - b; }

float cumulus(vec2 q, float lod) {
  float cover = 0.5 + 0.24 * (noise(q * 0.02 + 40.0) - 0.5);
  return smoothstep(cover, cover + 0.2, fbm(q * 0.45 - uWind * uTime * 0.0027, lod));
}

// Made-up clouds toward e: a cirrus deck at 8 km and cumulus at 2 km, lit by
// the Sun (reddened as it reaches them), the Moon and the sky; behind: what
// shows through them.  Premultiplied colour and coverage.
vec4 cloudsAt(vec3 e, float pix, vec3 behind) {
  if (e.z < -0.01) return vec4(0.0);
  vec2 sunH = length(uSun.xy) > 1e-4 ? normalize(uSun.xy) : vec2(0.0, 1.0);
  float mu = dot(e, uSun), muM = dot(e, uMoon);
  vec3 floorLight = vec3(0.0012, 0.0016, 0.0026);
  vec3 pre = vec3(0.0);
  float a = 0.0;

  float d8 = deck(e, 8.0);
  vec2 q8 = e.xy * d8, wp = vec2(-uWind.y, uWind.x);
  vec2 qs = vec2(dot(q8, uWind) * 0.05, dot(q8, wp) * 0.4) - vec2(uTime * 0.0006, 0.0);
  float c8 = smoothstep(0.55, 0.85, fbm(qs, d8 * pix / max(e.z, 0.04) * 0.4)) * 0.6;
  c8 *= smoothstep(0.0, 0.1, e.z) * exp(-d8 / 300.0);
  if (c8 > 0.002) {
    vec3 lin = uSunHigh * (0.5 + 0.5 * hg(mu, 0.7)) + uAmbLin * 1.3 + uMoonLin * hg(muM, 0.7) * 0.4 + floorLight;
    pre = (curve(lin) + behind * 0.35) * c8;
    a = c8;
  }

  float d2 = deck(e, 2.0);
  vec2 q = e.xy * d2;
  float lod = d2 * pix / max(e.z, 0.04) * 0.45;
  float dens = cumulus(q, lod) * smoothstep(-0.005, 0.06, e.z) * exp(-d2 / 150.0);
  if (dens > 0.002) {
    float shade = exp(-2.4 * cumulus(q + sunH * 0.5, lod));
    float thin = 1.0 - dens;
    vec3 lin = uSunLow * mix(0.6, hg(mu, 0.6), 0.25 + 0.6 * thin) * (0.15 + 0.85 * shade)
             + uAmbLin * (1.4 - 0.7 * dens)
             + uMoonLin * mix(0.5, hg(muM, 0.6), thin) * (0.3 + 0.7 * shade) * 0.6 + floorLight;
    vec3 c = curve(lin) + behind * 0.55 * thin;          // thin edges glow with the sky behind them
    c = mix(c, behind, 1.0 - exp(-d2 / 90.0));           // far clouds fade into the air
    pre = c * dens + pre * (1.0 - dens);
    a = dens + a * (1.0 - dens);
  }
  return vec4(pre, a);
}

// A surface of albedo alb and normal n, on display: sunlight (sun: 0 in
// shadow .. 1), moonlight, skylight (ao: 0 hidden .. 1 open) and the light
// the ground sends back.
vec3 litS(vec3 alb, vec3 n, float sun, float ao) {
  vec3 l = uSunLin * max(dot(n, uSun), 0.0) * sun
         + (uAmbLin * (0.6 + 0.4 * n.z) + 0.15 * (uSunLin * max(uSun.z, 0.0) + uAmbLin) * (0.5 - 0.5 * n.z)) * ao
         + uMoonLin * max(dot(n, uMoon), 0.0) * 0.6 * sun
         + vec3(0.075, 0.07, 0.21) * under(-0.22, -0.02, uSun.z) * (0.75 + 0.25 * n.z) * ao   // the night sky's own soft light
         + vec3(0.0015, 0.002, 0.0032);
  return curve(alb * l);
}

// The air in front of the terrain toward horizontal direction hd.
vec3 hazeAt(vec2 hd) { return skyAt(normalize(vec3(hd, 0.03))); }

// Mist lies in the low ground, thickest about sunrise and sunset, thin by
// day.  mistTo: how much of the view from the eye to p, t away, it hides.
float mistAmount() { return 0.2 + 0.8 * under(0.05, 0.25, abs(uSun.z)); }
vec3 mistColour() {
  return curve((uAmbLin * 1.1 + uSunLin * 0.3 * uSunOverHills * smoothstep(-0.02, 0.1, uSun.z) + uMoonLin * 0.5) * 0.85 + vec3(0.0012, 0.0016, 0.0026));
}
float mistTo(vec3 p, float t) {
  float a = exp(-(uEyeH + 1.0) / 5.0), b = exp(-(p.z + 1.0) / 5.0);
  float mean = abs(p.z - uEyeH) > 0.01 ? (a - b) * 5.0 / (p.z - uEyeH) : a;      // mean density along the ray
  float patch = smoothstep(0.3, 0.7, fbm(p.xy * 0.006 - uWind * uTime * 0.004, 0.02));
  return 1.0 - exp(-t * mean * mistAmount() * (0.2 + patch) * 0.008);
}

// The real skyline's hills, made up in detail: two nearer ridges in front
// of the skyline, each with gullies, grass low down and fir above, hazier
// with distance.
vec3 hillsAt(vec3 e, float alt, float hz, float pix) {
  vec2 hd = length(e.xy) > 1e-5 ? normalize(e.xy) : vec2(0.0, 1.0);
  float r1 = hz * (0.30 + 0.30 * fbm(hd * 7.0 + 3.0, pix * 7.0));
  float r2 = hz * (0.58 + 0.30 * fbm(hd * 4.5 + 11.0, pix * 4.5));
  float layer = alt < r1 ? 0.0 : alt < r2 ? 1.0 : 2.0;
  float top = layer < 0.5 ? r1 : layer < 1.5 ? r2 : hz;
  float up = clamp(alt / max(top, 0.5), 0.0, 1.0);
  vec2 q = hd * (26.0 + 6.0 * layer) + layer * 19.0;
  float y = alt * DEG;
  q += (vec2(fbm(q * 0.6 + 3.0, pix * 18.0), fbm(q * 0.6 + 8.0, pix * 18.0)) - 0.5) * 2.0;
  float gully = fbm(q + y * vec2(3.0, 5.0), pix * 30.0);                     // ridges and gullies run downhill
  float patch = fbm(q * 2.6 + y * vec2(40.0, 60.0), pix * 80.0);
  float pine = smoothstep(0.50, 0.64, patch + up * 0.22 + (gully - 0.5) * 0.7 + layer * 0.03);
  vec3 alb = mix(vec3(0.27, 0.22, 0.13), vec3(0.07, 0.10, 0.06), pine);
  alb *= 0.8 + 0.4 * patch;
  vec3 n = normalize(vec3(-hd * 0.6 + vec2(-hd.y, hd.x) * (gully - 0.5) * 1.8, 0.8));
  vec3 c = litS(alb, n, uSunOverHills, 1.0);
  float haze = 0.30 + 0.15 * layer + 0.10 * smoothstep(0.6, 1.0, up);       // each ridge fades toward its crest
  c = mix(c, hazeAt(hd), haze);
  // Wisps of cloud cling to the slopes and drift.
  float wisp = smoothstep(0.52, 0.78, fbm(hd * 9.0 + y * vec2(70.0, 110.0) + layer * 5.0 - uWind * uTime * 0.0015, pix * 40.0));
  wisp *= smoothstep(0.12, 0.35, up) * under(0.5, 0.85, up) * (0.25 + 0.75 * mistAmount());
  return mix(c, mistColour(), wisp * 0.85);
}

// ---- the made-up terrain, ray-marched through its height maps

const float GRASS = 0.45;                // the tallest bunchgrass (m)

// The terrain's maps (built once from terrainAt; skygl.js) around the
// observer, as stored: (height high byte, low byte, tall, cover).
vec4 mapRaw(vec2 P, out vec2 span) {
  float a = max(abs(P.x), abs(P.y));
  if (a < ${glf(MAPS[0] * 0.98)}) { span = vec2(${glf(MAP_H[0][0])}, ${glf(MAP_H[0][1] - MAP_H[0][0])}); return texture2D(uMap0, P / ${glf(2 * MAPS[0])} + 0.5); }
  if (a < ${glf(MAPS[1] * 0.98)}) { span = vec2(${glf(MAP_H[1][0])}, ${glf(MAP_H[1][1] - MAP_H[1][0])}); return texture2D(uMap1, P / ${glf(2 * MAPS[1])} + 0.5); }
  if (a < ${glf(MAPS[2] * 0.98)}) { span = vec2(${glf(MAP_H[2][0])}, ${glf(MAP_H[2][1] - MAP_H[2][0])}); return texture2D(uMap2, P / ${glf(2 * MAPS[2])} + 0.5); }
  span = vec2(${glf(MAP_H[3][0])}, ${glf(MAP_H[3][1] - MAP_H[3][0])});
  return texture2D(uMap3, P / ${glf(2 * MAPS[3])} + 0.5);
}
// The same with the height (m) in r: (height, -, tall, cover).
vec4 mapTexel(vec2 P) {
  vec2 span;
  vec4 m = mapRaw(P, span);
  return vec4((m.r + m.g / 255.0) * span.y + span.x, 0.0, m.b, m.a);
}
// Metres per texel of the map that covers P.
float mapEps(vec2 P) {
  float a = max(abs(P.x), abs(P.y));
  return a < ${glf(MAPS[0] * 0.98)} ? ${glf(2 * MAPS[0] / MAP_NS[0])} : a < ${glf(MAPS[1] * 0.98)} ? ${glf(2 * MAPS[1] / MAP_NS[1])} : a < ${glf(MAPS[2] * 0.98)} ? ${glf(2 * MAPS[2] / MAP_NS[2])} : ${glf(2 * MAPS[3] / MAP_NS[3])};
}
float heightOf(vec4 m) { return m.r; }
float mapH(vec2 P) { return heightOf(mapTexel(P)); }

// Distance along rd from ro to the ground, or -1.  The steps
// grow with distance; they stay short near things that are thin.
float hitGround(vec3 ro, vec3 rd, float tMax) {
  float t = 0.2, tPrev = 0.0;
  float climb = rd.z / max(length(rd.xy), 1e-4);
  float d = 9.0;
  for (int i = 0; i < 256; i++) {
    vec3 p = ro + rd * t;
    vec4 m = mapTexel(p.xy);
    d = p.z - heightOf(m);
    if (d < 0.0) {
      float a = tPrev, b = t;
      for (int k = 0; k < 6; k++) {
        float mid = 0.5 * (a + b);
        vec3 q = ro + rd * mid;
        if (q.z > mapH(q.xy)) a = mid; else b = mid;
      }
      return 0.5 * (a + b);
    }
    if (max(abs(p.x), abs(p.y)) > ${glf(MAPS[3] * 0.98)} || (climb > 0.05 && p.z > 45.0 + 0.2 * length(p.xy))) return -1.0;
    tPrev = t;
    float st = max(0.045 * t + 0.08, 0.5 * d);
    if (m.b > 0.01) st = min(st, max(max(5.4 * (1.0 - m.b), 0.5 * (d - 18.0)), min(0.4 * d, 0.7)));   // not past the nearest tree
    if (d < 3.0) st = min(st, 0.012 * t + 0.35);             // nor past boulders and brush, low down
    t += max(st, 0.003 * t + 0.1);
    if (t > tMax) return -1.0;
  }
  return d < 12.0 ? t : -1.0;
}

// Sunlight reaching p past the terrain, softened (0 .. 1).
float sunPast(vec3 p) {
  if (uSun.z < -0.03) return 0.0;
  float res = 1.0, t = 0.5;
  for (int i = 0; i < 30; i++) {
    vec3 q = p + uSun * t;
    float d = q.z - mapH(q.xy);
    res = min(res, 6.0 * d / t);
    if (res < 0.0 || q.z > 45.0 + 0.2 * length(q.xy)) break;
    t += max(0.9, 0.13 * t);
  }
  return clamp(res, 0.0, 1.0) * uSunOverHills;
}

// Sunlight the cumulus lets through to the ground at P (m).
float cloudShade(vec2 P) {
  if (uSun.z < 0.02) return 1.0;
  return 1.0 - 0.8 * cumulus(P / 1000.0 + uSun.xy / max(uSun.z, 0.08) * 2.0, 0.1);
}

// Sunlight past the dishes at P on the ground (m): each dish shades a disc.
float dishShade(vec2 P) {
  if (uSun.z < 0.03) return 1.0;
  vec2 g = (P + uSun.xy / uSun.z * 2.4 - uArrayBox.xy) / uSpacing + 0.5 * (uCount - 1.0);
  vec2 i = clamp(floor(g + 0.5), vec2(0.0), uCount - 1.0);
  return 0.12 + 0.88 * smoothstep(2.6, 3.3, length((g - i) * uSpacing));
}

// The bunchgrass standing at Q (m): its height, 0..1 of GRASS.
float grassH(vec2 Q) {
  float bunch = smoothstep(0.15, 0.5, noise(Q * 6.0));
  return bunch * (0.3 + 0.7 * noise(mat2(0.8, 0.6, -0.6, 0.8) * Q * 41.0));
}

// The cover of the ground from a map texel: rock, brush and tree, each 0..1.
vec3 coverOf(vec4 m, vec2 P, float lod) {
  float woody = clamp(2.0 * m.a - 1.0, 0.0, 1.0);
  if (length(P) >= 750.0) {                                 // far off: the share of trees, painted as dots
    float dots = fbm(P * 0.09 + 5.0, lod * 0.09) * 0.5 + noise(P * 0.021) * 0.5;
    return vec3(clamp(1.0 - 2.0 * m.a, 0.0, 1.0), 0.0, smoothstep(-0.06, 0.06, woody - dots));
  }
  float tree = smoothstep(0.6, 0.85, woody);
  return vec3(clamp(1.0 - 2.0 * m.a, 0.0, 1.0), smoothstep(0.1, 0.35, woody) * (1.0 - tree), tree);
}

// The terrain where the view ray e meets it at distance t (metres).
vec3 groundAt(vec3 e, float t, float pix) {
  vec3 p = vec3(0.0, 0.0, uEyeH) + e * t;
  vec2 P = p.xy;
  vec2 hd = length(e.xy) > 1e-5 ? normalize(e.xy) : vec2(0.0, 1.0);
  vec4 m = mapTexel(P);
  float h = heightOf(m);
  float lod = t * pix / max(-e.z, 0.12);                  // metres per pixel along the ground, about
  float gust = fbm(P * 0.06 - uWind * uTime * 0.25, lod * 0.06);
  float sheen = smoothstep(0.45, 0.75, gust);
  float shade = cloudShade(P);
  vec3 c;
  {
    float ep = max(1.5 * mapEps(P), lod);
    vec4 nb = vec4(mapH(P - vec2(ep, 0.0)), mapH(P + vec2(ep, 0.0)), mapH(P - vec2(0.0, ep)), mapH(P + vec2(0.0, ep)));
    vec3 n = normalize(vec3(nb.x - nb.y, nb.z - nb.w, 2.0 * ep));
    float cavity = clamp(1.0 - 0.9 * (dot(nb, vec4(0.25)) - h) / ep, 0.35, 1.15);   // darker in hollows, lighter on tips
    lod = t * pix / max(dot(-e, n), 0.15);
    float near = clamp(1.5 - lod * 2.5, 0.0, 1.0);           // detail fades out with distance
    float slope = 1.0 - n.z;
    vec3 cov = coverOf(m, P, lod);
    float woody = max(cov.y, cov.z);
    float rock = clamp(max(cov.x * 1.6, smoothstep(0.28, 0.5, slope)) * (1.0 - smoothstep(0.0, 0.2, woody)), 0.0, 1.0);
    vec2 pq = abs(P - uArrayBox.xy) - uArrayBox.zw + 2.0;
    float onPad = 1.0 - smoothstep(-0.5, 0.5, max(pq.x, pq.y));
    float grassy = (1.0 - rock) * (1.0 - onPad) * (1.0 - woody);
    float bloom = smoothstep(0.5, 0.75, noise(P * 0.08 + 60.0)) * grassy;

    // Grass.  Close by it stands in relief: the ray is marched down through
    // the bunches, bent by the wind, with flowers among them.  f: how high
    // in the grass the ray stops (0 the soil .. 1); Q: where; fl: 0, or a
    // flower's kind (1 .. 2); lit: sunlight past the bunches next to it.
    float f = grassH(P) * near + 0.34 * (1.0 - near), fl = 0.0, lit = 1.0;
    vec2 Q = P;
    float k = clamp(1.6 - t / 30.0, 0.0, 1.0) * step(0.5, grassy);
    if (k > 0.0) {
      float Hm = GRASS * k * (0.5 + 0.5 * noise(P * 0.9 + 9.0));       // taller and shorter stands
      float rate = max(dot(-n.xy / max(n.z, 0.2), e.xy) - e.z, 0.03);    // height lost per metre of ray
      float back = min(1.3 * Hm / rate, 5.0), dt = back / 26.0;
      float jit = texture2D(uNoise, gl_FragCoord.xy / 256.0).a;
      float bend = (0.05 + 0.12 * sheen) * (0.7 + 0.3 * sin(uTime * 2.6 + dot(P, uWind) * 1.3));
      f = 0.0;
      for (int i = 0; i < 26; i++) {
        float tau = back - (float(i) + jit) * dt;            // metres short of the ground
        float s = tau * rate / Hm;
        vec2 q = P - e.xy * tau - uWind * bend * s * s;
        if (bloom > 0.0) {
          vec2 gi = floor(q * 3.0);
          vec4 rr = texture2D(uNoise, (gi + 0.5) / 256.0);
          float top = 0.75 + 0.5 * rr.a;
          if (rr.r < bloom * 0.4 && s < top && length(q * 3.0 - gi - 0.25 - 0.5 * rr.gb) < 0.11) {
            f = s; Q = q; fl = s > top - 0.2 - 0.25 * step(0.45, rr.a) ? 1.0 + rr.a : 0.5;
            break;
          }
        }
        if (s < grassH(q)) {
          float a = tau + dt, b = tau;                       // close in on the blade's edge
          for (int j = 0; j < 4; j++) {
            float mid = 0.5 * (a + b), sm = mid * rate / Hm;
            if (sm < grassH(P - e.xy * mid - uWind * bend * sm * sm)) b = mid; else a = mid;
          }
          f = b * rate / Hm; Q = P - e.xy * b - uWind * bend * f * f;
          break;
        }
      }
      if (uSun.z > 0.03) {
        vec2 sd = normalize(uSun.xy + 1e-6);
        float rise = uSun.z / max(length(uSun.xy), 0.05) / Hm;
        for (int j = 1; j <= 5; j++) {
          float d = 0.05 * float(j), s2 = f + d * rise;
          if (s2 < 1.0 && s2 < grassH(Q + sd * d)) lit -= 0.19;
        }
      }
    }
    float fine = mix(0.5, noise(Q * 31.0), clamp(1.5 - lod * 60.0, 0.0, 1.0));
    float tex = fbm(Q * 1.7 + 5.0, lod * 1.7);
    float patches = fbm(P * 0.025 + 1.0, lod * 0.025);
    vec3 straw = mix(vec3(0.52, 0.42, 0.21), vec3(0.36, 0.25, 0.12), smoothstep(0.3, 0.7, tex));   // cured blades, pale to russet
    straw = mix(straw, vec3(0.19, 0.24, 0.09), clamp((patches - 0.55) * 1.5, 0.0, 0.85));   // greener patches
    // Sage on the slopes, far off: grey-green in mottled patches.
    float sage = smoothstep(0.45, 0.62, fbm(P * 0.04 + 13.0, lod * 0.04)) * smoothstep(0.02, 0.10, slope) * (1.0 - near);
    straw = mix(straw, vec3(0.25, 0.26, 0.19) * (0.7 + 0.6 * fbm(P * 0.7 + 3.0, lod * 0.7)), sage * 0.75);
    straw *= 0.75 + 0.5 * fine;
    straw = mix(straw, straw * 1.35 + vec3(0.03, 0.03, 0.02), sheen * 0.6 * smoothstep(0.3, 0.9, f));   // gusts show the pale side
    vec3 soil = mix(vec3(0.15, 0.115, 0.08), straw * 0.55, smoothstep(0.45, 0.7, noise(Q * 19.0 + 7.0)) * near);   // soil and litter
    vec3 alb = mix(soil, straw, smoothstep(0.0, 0.2, f));
    float ao = 0.4 + 0.6 * smoothstep(0.0, 0.7, f);
    if (fl > 0.9) {
      // Balsamroot yellow, lupine violet and yarrow white.
      alb = fl < 1.45 ? vec3(0.85, 0.63, 0.05) : fl < 1.8 ? vec3(0.37, 0.25, 0.66) : vec3(0.80, 0.80, 0.74);
      ao = 1.0; lit = 1.0;
    } else if (fl > 0.0) { alb = vec3(0.16, 0.22, 0.08); ao = 0.8; }
    alb = mix(alb, vec3(0.64, 0.52, 0.20), bloom * 0.12 * (1.0 - k));        // far off, a tint where the flowers grow

    // Rock: crags, boulders and steep faces; bedded, cracked, with lichen.
    if (rock > 0.01) {
      float warp = fbm(P * 0.25 + 4.0, lod * 0.25);
      float beds = fbm(vec2(p.z * 2.2 + warp * 3.0, dot(P, vec2(0.05, 0.03))), lod * 2.2);
      float crack = 1.0 - abs(2.0 * fbm(P * 0.9 + 4.0, lod * 0.9) - 1.0);
      vec3 stone = mix(vec3(0.17, 0.16, 0.15), vec3(0.37, 0.34, 0.30), beds) * (0.7 + 0.5 * fbm(P * 2.3, lod * 2.3));
      stone = mix(stone, vec3(0.40, 0.33, 0.11), smoothstep(0.70, 0.78, noise(P * 3.0 + 9.0)) * near * 0.7);   // lichen
      stone = mix(stone, vec3(0.30, 0.36, 0.30), smoothstep(0.74, 0.80, noise(P * 4.1 + 31.0)) * near * 0.5);
      stone *= 1.0 - 0.6 * smoothstep(0.9, 0.98, crack) * near;
      alb = mix(alb, stone, smoothstep(0.25, 0.6, rock));
      ao = mix(ao, 0.75 + 0.25 * beds, smoothstep(0.25, 0.6, rock));
      n = normalize(n + vec3(fbm(P * 1.1 + 2.0, lod * 1.1) - 0.5, fbm(P * 1.1 + 7.0, lod * 1.1) - 0.5, 0.0) * 1.1 * rock * near);
    }
    // The array's gravel pad.
    alb = mix(alb, vec3(0.31, 0.30, 0.28) * (0.8 + 0.25 * noise(P * 4.0) + 0.2 * fine), onPad);
    ao = mix(ao, 1.0, onPad);
    // Sagebrush: clumps of leaves over dark gaps.
    if (cov.y > 0.0) {
      float clump = fbm(P * 5.0 + 3.0, lod * 5.0), leaves = mix(0.5, noise(P * 37.0), clamp(1.5 - lod * 70.0, 0.0, 1.0));
      vec3 leaf = mix(vec3(0.27, 0.31, 0.25), vec3(0.33, 0.31, 0.21), noise(P * 0.5));
      leaf *= (0.45 + 0.9 * smoothstep(0.3, 0.7, clump)) * (0.8 + 0.4 * leaves);
      alb = mix(alb, leaf, cov.y);
      ao = mix(ao, 0.55 + 0.45 * smoothstep(0.3, 0.7, clump), cov.y);
    }
    // Trees: sprays of needles, lighter at the tips of the boughs and dark
    // in the gaps between them; each stand its own green.
    if (cov.z > 0.0) {
      vec2 a1 = vec2(dot(P, vec2(0.8, 0.6)), p.z * 1.3), a2 = vec2(dot(P, vec2(-0.6, 0.8)), p.z * 1.3 + 7.0);
      float spray = 0.5 * (fbm(a1 * 2.1, lod * 2.1) + fbm(a2 * 2.1, lod * 2.1));
      float needles = 0.5 * (noise(a1 * 13.0) + noise(a2 * 13.0));
      needles = mix(0.5, needles, clamp(1.5 - lod * 26.0, 0.0, 1.0));
      float kind = noise(P * 0.11 + 40.0);
      vec3 deep = mix(vec3(0.016, 0.034, 0.028), vec3(0.03, 0.04, 0.02), kind);
      vec3 tip = mix(vec3(0.06, 0.12, 0.075), vec3(0.11, 0.14, 0.06), kind);
      vec3 tree = mix(deep, tip, smoothstep(0.3, 0.75, spray * 0.6 + needles * 0.4) * smoothstep(0.5, 1.05, cavity));
      alb = mix(alb, tree, cov.z);
      ao = mix(ao, 0.35 + 0.65 * smoothstep(0.45, 1.05, cavity), cov.z);
      n = normalize(mix(n, n + vec3(spray - 0.5, needles - 0.5, 0.0) * 1.2 * near, cov.z));
    }
    ao *= mix(1.0, min(cavity, 1.0), (1.0 - cov.z) * step(0.5, max(woody, rock)));   // hollows in brush and rock
    float sun = sunPast(p + n * (0.3 + 0.004 * t) + vec3(0.0, 0.0, GRASS * k * f)) * shade * lit;
    if (onPad > 0.0 || length(P - uArrayBox.xy) < 90.0) sun *= dishShade(P);
    c = litS(alb, n, sun, ao * (0.75 + 0.25 * n.z));
    float back = pow(max(dot(hd, normalize(uSun.xy + 1e-6)), 0.0), 3.0) * max(uSun.z + 0.05, 0.0);   // light through the blades
    c += curve(uSunLin * vec3(0.30, 0.25, 0.08) * back * (0.3 + sheen) * sun * grassy * smoothstep(0.2, 0.8, f)) * 0.5;
  }
  c = mix(c, hazeAt(hd), 1.0 - exp(-t / 5000.0));
  return mix(c, mistColour(), mistTo(p, t));
}

void main() {
  vec2 px = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y);
  vec2 p = vec2(px.x - uView.x, uView.y - px.y) / uView.z + uPan;
  vec3 c;
  if (!cameraOf(p, c)) { gl_FragColor = vec4(0.0); return; }
  vec3 v = normalize(uCam * c);
  vec3 e = uToEnu * v;
  float pix = (1.0 + c.z) * 0.5 / uView.z;                    // radians per device pixel (stereographic)

  vec3 col = radioAt(v);
  float alt = asin(clamp(e.z, -1.0, 1.0)) / DEG;
  float hz = skyline(atan(e.x, e.y) / DEG);
  bool below = alt < hz;
  float tLand = -1.0;
  if (uDome > 0.5 && uGround > 0.5 && uLand > 0.5 && alt < hz + 4.0) {
    tLand = hitGround(vec3(0.0, 0.0, uEyeH), e, 11000.0);
  }
  if (uDome > 0.5 && uLand > 0.5 && (!below || uGround < 0.5) && tLand < 0.0) {
    vec3 sky = skyAt(e);
    col = washed(col, sky);
    vec4 cl = cloudsAt(e, pix, sky + col * 0.3);
    col += cl.rgb + sky * (1.0 - cl.a);                        // radio waves pass through air and cloud
  }
  if (uBeamMode > 0 && tLand < 0.0) col += beam(e) * uBeamGain;
  if (tLand > 0.0) col = groundAt(e, tLand, pix);
  else if (below && uGround > 0.5) {
    if (uDome < 0.5) col *= 0.5;
    else if (uLand > 0.5) col = hillsAt(e, alt, hz, pix);
    else {
      // The plain ground: darker downward, with a band of haze along the
      // skyline (the same in every direction: below the skyline the
      // distance to the terrain is not known).
      float depth = clamp((hz - alt) / 35.0, 0.0, 1.0);
      vec3 g = mix(vec3(0.034, 0.042, 0.040), vec3(0.016, 0.020, 0.020), sqrt(depth));
      col = mix(g, vec3(0.06, 0.08, 0.11), 0.35 * exp(-(hz - alt) / 1.2));
    }
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

/** A program over the full-screen triangle (aPos at location 0) and its uniforms by name. */
function link(gl, frag) {
  const prog = gl.createProgram();
  gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT));
  gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, frag));
  gl.bindAttribLocation(prog, 0, "aPos");
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
  const u = {};
  for (let i = 0, n = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS); i < n; i++) {
    const name = gl.getActiveUniform(prog, i).name;
    u[name] = gl.getUniformLocation(prog, name);
  }
  return { prog, u };
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
    const { prog, u } = link(gl, FRAG);
    gl.useProgram(prog);
    this.prog = prog;
    this.u = u;
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    const tex = this.skyTex = gl.createTexture();
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
    this.hzN = hn;

    gl.activeTexture(gl.TEXTURE2);
    this.lut = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.lut);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, LUT_W, LUT_H, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(LUT_W * LUT_H * 4));
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR],
      [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);

    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
    const noise = new Uint8Array(256 * 256 * 4);
    let seed = 0x9e3779b9;                                    // xorshift: the same clouds on every load
    for (let i = 0; i < noise.length; i++) { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; noise[i] = seed & 255; }
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, 256, 0, gl.RGBA, gl.UNSIGNED_BYTE, noise);
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR],
      [gl.TEXTURE_WRAP_S, gl.REPEAT], [gl.TEXTURE_WRAP_T, gl.REPEAT]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
    gl.activeTexture(gl.TEXTURE0);
  }

  /** Bake the terrain into its height maps (MAPS), once; t: { arrayBox,
   *  eyeH, terrain: the image terrain.png }. */
  buildTerrain(t) {
    if (this.maps) return;
    const { gl } = this, { prog, u } = link(gl, MAP_FRAG), fb = gl.createFramebuffer();
    gl.useProgram(prog);
    gl.uniform1i(u.uNoise, 3);
    const dem = gl.createTexture();                          // on unit 0 while the maps are built
    gl.bindTexture(gl.TEXTURE_2D, dem);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, t.terrain);
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR],
      [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
    gl.uniform1i(u.uDem, 0);
    gl.uniform4fv(u.uArrayBox, t.arrayBox);
    gl.uniform1f(u.uEyeH, t.eyeH);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    this.maps = MAPS.map((half, i) => {
      gl.activeTexture(gl.TEXTURE4 + i);
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      const n = MAP_NS[i];
      gl.viewport(0, 0, n, n);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, n, n, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR],
        [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      gl.uniform1f(u.uHalf, half);
      gl.uniform1f(u.uTexel, 2 * half / n);
      gl.uniform1f(u.uSize, n);
      gl.uniform2f(u.uSpan, MAP_H[i][0], MAP_H[i][1]);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      return tex;
    });
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(fb);
    gl.deleteProgram(prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.skyTex);
    gl.deleteTexture(dem);
    gl.useProgram(this.prog);
  }

  /** The daylight sky and its light (atmos.js skyModel). */
  setSky(m) {
    const { gl } = this;
    if (this.skyModel === m) return;
    this.skyModel = m;
    gl.activeTexture(gl.TEXTURE2);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, LUT_W, LUT_H, gl.RGBA, gl.UNSIGNED_BYTE, m.lut);
    gl.activeTexture(gl.TEXTURE0);
  }

  /** p: { cam, ob, dpr, stretch, skyGain, dome, ground, bore, beamMode, beamGain,
   *       band: [lo, hi], array, sun, moon (ENU), moonLin, land, time,
   *       wind, eyeH, arrayBox:
   *       [east, north, half east, half north], sunOverHills (0 .. 1) } */
  draw(p) {
    if (p.land) this.buildTerrain(p);
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
    const m = this.skyModel;
    gl.uniform1i(u.uLut, 2);
    gl.uniform1i(u.uNoise, 3);
    gl.uniformMatrix3fv(u.uFromEnu, false, glMat(p.ob.fromEnu));
    gl.uniform3fv(u.uSun, p.sun);
    gl.uniform3fv(u.uMoon, p.moon);
    gl.uniform3fv(u.uMoonLin, p.moonLin);
    if (m) {
      gl.uniform3fv(u.uSunLin, m.sunLin);
      gl.uniform3fv(u.uSunLow, m.sunLow);
      gl.uniform3fv(u.uSunHigh, m.sunHigh);
      gl.uniform3fv(u.uAmbLin, m.ambLin);
      gl.uniform1f(u.uStrength, m.strength);
    }
    gl.uniform1f(u.uLand, p.land ? 1 : 0);
    gl.uniform1f(u.uTime, p.time);
    gl.uniform2fv(u.uWind, p.wind);
    gl.uniform1f(u.uEyeH, p.eyeH);
    gl.uniform4fv(u.uArrayBox, p.arrayBox);
    gl.uniform1f(u.uSunOverHills, p.sunOverHills);
    for (let i = 0; i < MAPS.length; i++) gl.uniform1i(u[`uMap${i}`], 4 + i);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
}
