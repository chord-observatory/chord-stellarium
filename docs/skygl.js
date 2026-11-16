// The sky layer: one WebGL1 fragment shader that, for each pixel, inverts
// the projection (proj.js), looks up the 408 MHz sky (sky.png), adds the
// daylight and twilight (atmos.js) and the beam, and shades the ground.
// The radio sky shows through the daylight and the clouds, as radio waves
// pass through both.  The Clouds and Landscape layers are made up: clouds
// from fractal noise, drifting on a steady wind; hills under the real
// skyline; a plain of grass that the wind sweeps; a lake that mirrors the
// sky, radio sky included.
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

// The made-up terrain's height maps: half-width (m) and height range (m).
export const MAPS = [{ half: 128, range: [-8, 24], octaves: 8 }, { half: 512, range: [-8, 56], octaves: 6 },
  { half: 2048, range: [-8, 136], octaves: 4 }];
const MAP_N = 512;
const WATER_LEVEL = -0.8;          // the lake's surface (m)

// Shared by the sky shader and the map builder.
const TERRAIN = `
// Value noise from the random texture, smooth across texels.
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return texture2D(uNoise, (i + f + 0.5) / 256.0).r;
}

// Fractal noise of n octaves, about 0..1.
float tfbm(vec2 p, int n) {
  float a = 0.5, s = 0.0, w = 0.0;
  for (int k = 0; k < 9; k++) {
    if (k >= n) break;
    s += a * noise(p);
    w += a;
    p = mat2(1.6, 1.2, -1.2, 1.6) * p + 17.0;
    a *= 0.5;
  }
  return s / w;
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
    vec2 r = texture2D(uNoise, (mod(g, 256.0) + 0.5) / 256.0).gb;
    vec2 d = p - g - r;
    if (length(d) < best.x) { best = vec3(length(d), r); off = d; }
  }
  return best;
}

// 1 below a, 0 above b (a < b), smooth between.
float under(float a, float b, float x) { return 1.0 - smoothstep(a, b, x); }

// The larger of a and b, rounded over k.
float smax(float a, float b, float k) { float t = clamp(0.5 + 0.5 * (a - b) / k, 0.0, 1.0); return mix(b, a, t) + k * t * (1.0 - t); }

// The made-up terrain at P (m east and north of the observer), to n octaves:
// (height above the array's ground (m), rock 0..1, moisture 0..1, brush:
// 1 on a shrub, or with n < 7, the share of ground the shrubs cover).
// Broad swells, knolls with rocky crests and boulders, ground rising toward
// the real hills; levelled for the array's pad and the sight lines to the
// array and the lake; a hollow that holds the lake, with a ragged shore;
// sagebrush in patches; and the knoll the observer stands on, falling away
// in every direction.
vec4 terrainAt(vec2 P, int n) {
  float r = length(P);
  float swell = (tfbm(P * 0.005 + 3.1, n) - 0.5) * 30.0;
  float ridged = 1.0 - abs(2.0 * tfbm(P * 0.017 + 9.7, n) - 1.0);
  float crest = smoothstep(0.62, 0.9, ridged);
  float boulders = crest * pow(max(tfbm(P * 0.12 + 1.3, n) - 0.45, 0.0) * 2.4, 1.6) * 4.0;
  float h = swell + pow(ridged, 4.0) * 13.0 + boulders + smoothstep(350.0, 2000.0, r) * 80.0;
  vec2 q = abs(P - uArrayBox.xy) - uArrayBox.zw;
  float pad = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0);
  float level = max(under(4.0, 30.0, pad), under(26.0, 48.0, segDist(P, vec2(0.0), uArrayBox.xy)));
  level = max(level, under(16.0, 34.0, segDist(P, vec2(0.0), uLake.xy)));
  h = smax(h, -0.2, 3.0);                                   // dry hollows silt up into flats
  h = mix(h, min(h, 0.0) * 0.3, level);
  h = mix(h, 0.0, under(0.0, 8.0, pad));                    // the pad is level with the dishes' feet
  float ld = length((P - uLake.xy) / uLake.zw) + (tfbm(P * 0.045 + 5.0, n) - 0.5) * 1.1;
  float bed = -3.2 + (tfbm(P * 0.03 + 2.0, n) - 0.5) * 4.0;
  h = mix(h, min(h, bed), under(0.55, 1.3, ld));
  float m = max(1.0 - r / 55.0, 0.0);
  if (m > 0.0) h = max(h, (uEyeH - 1.7) * m * m);
  float rock = clamp(crest * 1.2 + boulders * 0.4, 0.0, 1.0) * (1.0 - level);
  float moist = clamp(under(1.0, 1.7, ld) + under(-9.0, -2.0, swell) * 0.6, 0.0, 1.0);
  float brush = smoothstep(0.5, 0.78, noise(P * 0.012 + 30.0) + moist * 0.25) * (1.0 - rock)
              * smoothstep(0.0, 4.0, pad) * smoothstep(0.3, 0.8, h - (${WATER_LEVEL.toFixed(1)}));
  if (n >= 7 && brush > 0.0) {
    vec2 off;
    vec3 c = cells(P * 0.35, off);
    float rad = (0.3 + 0.25 * c.z) * step(c.y, 0.7 * brush);
    float d = rad > 0.0 ? c.x / rad : 2.0;
    float dome = sqrt(max(1.0 - d * d, 0.0));
    h += dome * (0.55 + 0.6 * c.z) * (0.85 + 0.3 * noise(P * 3.0));
    brush = step(d, 1.0);
  } else brush *= 0.35;
  return vec4(h, rock, moist, brush);
}
`;

const MAP_FRAG = `
precision highp float;
uniform sampler2D uNoise;
uniform vec4 uLake;
uniform vec4 uArrayBox;
uniform float uEyeH;
uniform float uHalf;
uniform vec2 uRange;
uniform int uOctaves;
${TERRAIN}
void main() {
  vec2 P = (gl_FragCoord.xy / ${MAP_N}.0 - 0.5) * 2.0 * uHalf;
  vec4 t = terrainAt(P, uOctaves);
  gl_FragColor = vec4(clamp((t.x - uRange.x) / (uRange.y - uRange.x), 0.0, 1.0), t.y, t.z, t.w);
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
uniform vec4 uLake;         // the lake: centre east, north and radii (m) from the eye
uniform vec4 uArrayBox;     // the array's pad: centre east, north and half-sizes (m) from the eye
uniform float uSunOverHills; // 1 when the Sun is above the real skyline, 0 behind it
uniform sampler2D uMap0;    // the made-up terrain's height maps (MAPS)
uniform sampler2D uMap1;
uniform sampler2D uMap2;

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

${TERRAIN}
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
         + uMoonLin * max(dot(n, uMoon), 0.0) * 0.6 * sun + vec3(0.0015, 0.002, 0.0032);
  return curve(alb * l);
}

// The air in front of the terrain toward horizontal direction hd.
vec3 hazeAt(vec2 hd) { return skyAt(normalize(vec3(hd, 0.03))); }

// The real skyline's hills, made up in detail: ridges and gullies, grass
// low down, pine on the upper slopes, hazy with distance.
vec3 hillsAt(vec3 e, float alt, float hz, float pix) {
  vec2 hd = length(e.xy) > 1e-5 ? normalize(e.xy) : vec2(0.0, 1.0);
  float az = atan(e.x, e.y), up = clamp(alt / max(hz, 0.5), 0.0, 1.0);
  float gully = fbm(vec2(az * 30.0, alt * DEG * 8.0), pix * 30.0);           // ridges and gullies run downhill
  float patch = fbm(vec2(az * 70.0, alt * DEG * 160.0), pix * 160.0);
  float pine = smoothstep(0.52, 0.66, patch + up * 0.25 + (gully - 0.5) * 0.6);
  vec3 alb = mix(vec3(0.24, 0.20, 0.13), vec3(0.08, 0.11, 0.07), pine);
  alb *= 0.85 + 0.3 * patch;
  vec3 n = normalize(vec3(-hd * 0.6 + vec2(-hd.y, hd.x) * (gully - 0.5) * 1.4, 0.8));
  vec3 c = litS(alb, n, uSunOverHills, 1.0);
  return mix(c, hazeAt(hd), 0.42 + 0.18 * up);
}

// ---- the made-up terrain, ray-marched through its height maps

const float WATER = ${WATER_LEVEL.toFixed(1)};

// Terrain from the maps (built once from terrainAt; skygl.js): near, middle
// and far, each 512 x 512 around the observer.
vec4 mapTexel(vec2 P, out vec2 range) {
  float a = max(abs(P.x), abs(P.y));
  if (a < ${MAPS[0].half * 0.98}) { range = vec2(${MAPS[0].range[0]}.0, ${MAPS[0].range[1] - MAPS[0].range[0]}.0); return texture2D(uMap0, P / ${2 * MAPS[0].half}.0 + 0.5); }
  if (a < ${MAPS[1].half * 0.98}) { range = vec2(${MAPS[1].range[0]}.0, ${MAPS[1].range[1] - MAPS[1].range[0]}.0); return texture2D(uMap1, P / ${2 * MAPS[1].half}.0 + 0.5); }
  range = vec2(${MAPS[2].range[0]}.0, ${MAPS[2].range[1] - MAPS[2].range[0]}.0);
  return texture2D(uMap2, P / ${2 * MAPS[2].half}.0 + 0.5);
}
float mapH(vec2 P) { vec2 r; float h = mapTexel(P, r).r; return h * r.y + r.x; }
vec3 mapAt(vec2 P) { vec2 r; vec4 t = mapTexel(P, r); return vec3(t.r * r.y + r.x, t.g, t.b); }

// Distance along rd from ro to the ground or the water, or -1; tLo: a
// distance short of the ground.
float hitGround(vec3 ro, vec3 rd, float tMax, out float tLo) {
  float t = 0.2, tPrev = 0.0, dPrev = ro.z - max(mapH(ro.xy), WATER);
  tLo = 0.0;
  float climb = rd.z / max(length(rd.xy), 1e-4);
  for (int i = 0; i < 128; i++) {
    vec3 p = ro + rd * t;
    float d = p.z - max(mapH(p.xy), WATER);
    if (d < 0.0) { tLo = tPrev; return mix(tPrev, t, dPrev / (dPrev - d)); }
    if (climb > 0.05 && p.z > 45.0 + 80.0 * smoothstep(350.0, 2000.0, length(p.xy))) return -1.0;
    tPrev = t; dPrev = d;
    t += max(0.045 * t + 0.08, 0.5 * d);
    if (t > tMax) return -1.0;
  }
  return -1.0;
}

// The hit moved onto the full-detail surface (the maps are 8-bit), between a and b.
float refineHit(vec3 ro, vec3 rd, float a, float b) {
  b = b + (b - a) * 0.5;
  for (int i = 0; i < 6; i++) {
    float m = 0.5 * (a + b);
    vec3 p = ro + rd * m;
    if (p.z > max(terrainAt(p.xy, 7).x, WATER)) a = m; else b = m;
  }
  return 0.5 * (a + b);
}

// Sunlight reaching p past the terrain, softened (0 .. 1); far points
// start further out, past the maps' coarser steps.
float sunPast(vec3 p, float far) {
  if (uSun.z < -0.03) return 0.0;
  float res = 1.0, t = 1.2 + 0.02 * far;
  for (int i = 0; i < 22; i++) {
    vec3 q = p + uSun * t;
    float d = q.z - mapH(q.xy);
    res = min(res, 4.0 * d / t);
    if (res < 0.0 || q.z > 130.0) break;
    t += max(0.8, t * 0.3);
  }
  return clamp(res, 0.0, 1.0) * uSunOverHills;
}

// A cheap view of the terrain, from the maps alone (in the lake's mirror).
vec3 terrainCheap(vec3 p) {
  vec3 m = mapAt(p.xy);
  float s = 3.0;
  vec3 n = normalize(vec3(mapH(p.xy - vec2(s, 0.0)) - mapH(p.xy + vec2(s, 0.0)), mapH(p.xy - vec2(0.0, s)) - mapH(p.xy + vec2(0.0, s)), 2.0 * s));
  vec3 alb = mix(mix(vec3(0.30, 0.245, 0.14), vec3(0.17, 0.21, 0.10), m.b * 0.8), vec3(0.30, 0.29, 0.27), m.g);
  return litS(alb, n, uSunOverHills, 1.0);
}

// What the water mirrors along r from p.
vec3 mirrored(vec3 p, vec3 r, float pix) {
  float tLo, t = hitGround(p + vec3(0.0, 0.0, 0.05), r, 1800.0, tLo);
  if (t > 0.0) {
    vec3 q = p + r * t;
    return mix(terrainCheap(q), hazeAt(normalize(r.xy + 1e-6)), 1.0 - exp(-t / 6000.0));
  }
  float ralt = asin(r.z) / DEG, rhz = skyline(atan(r.x, r.y) / DEG);
  if (ralt < rhz) return hillsAt(r, ralt, rhz, pix);
  vec3 sky = skyAt(r), radio = washed(radioAt(uFromEnu * r), sky);
  vec4 cl = cloudsAt(r, pix, sky + radio * 0.3);
  return cl.rgb + sky * (1.0 - cl.a) + radio;
}

// The terrain where the view ray e meets it at distance t (metres).
vec3 groundAt(vec3 e, float t, float pix) {
  vec3 p = vec3(0.0, 0.0, uEyeH) + e * t;
  vec2 P = p.xy;
  vec2 hd = length(e.xy) > 1e-5 ? normalize(e.xy) : vec2(0.0, 1.0);
  float lod = t * pix / max(-e.z, 0.12);                  // metres per pixel along the ground, about
  int oct = int(clamp(9.0 - log2(max(lod, 0.01) * 40.0), 3.0, 9.0));
  vec4 T = terrainAt(P, oct);
  float gust = fbm(P * 0.06 - uWind * uTime * 0.25, lod * 0.06);
  vec3 c;
  if (T.x < WATER && p.z <= WATER + 0.05) {
    // Water: wind ripples in gusts, the mirror, and the bed in the shallows.
    vec2 rp = P * 1.1 - uWind * uTime * 1.2;
    float h0 = noise(rp), hx = noise(rp + vec2(0.1, 0.0)), hy = noise(rp + vec2(0.0, 0.1));
    float amp = (0.004 + 0.02 * smoothstep(0.5, 0.75, gust)) * clamp(1.5 - lod * 2.2, 0.0, 1.0);
    vec3 n = normalize(vec3(-(vec2(hx, hy) - h0) * 10.0 * amp, 1.0));
    vec3 r = reflect(e, n);
    r = normalize(vec3(r.xy, max(r.z, 0.002)));
    float F = 0.02 + 0.98 * pow(1.0 - max(dot(-e, n), 0.0), 5.0);
    float depth = WATER - T.x;
    vec3 bed = litS(mix(vec3(0.34, 0.33, 0.28), vec3(0.03, 0.06, 0.06), smoothstep(0.1, 2.0, depth)), vec3(0.0, 0.0, 1.0), sunPast(p, t), 1.0);
    c = mix(bed, mirrored(p, r, pix), F);
  } else {
    float e1 = max(lod, 0.06);
    vec3 n = normalize(vec3(T.x - terrainAt(P + vec2(e1, 0.0), oct).x, T.x - terrainAt(P + vec2(0.0, e1), oct).x, e1));
    float near = clamp(1.5 - lod * 2.5, 0.0, 1.0);           // detail fades out with distance
    float slope = 1.0 - n.z;
    // Grass: dry gold, greener where it is wet; bunches; the pale side shows where gusts bend it.
    float patches = fbm(P * 0.03, lod * 0.03);
    vec3 alb = mix(vec3(0.31, 0.25, 0.14), vec3(0.15, 0.19, 0.08), clamp(T.z * 0.9 + (patches - 0.5) * 0.8, 0.0, 1.0));
    alb *= 0.78 + 0.44 * mix(0.5, noise(P * 9.0 + 3.0), clamp(1.5 - lod * 20.0, 0.0, 1.0));
    float sheen = smoothstep(0.45, 0.75, gust);
    // Close by: tufts, and blades laid over by the wind, swaying.
    if (lod < 0.06) {
      float sway = sin(uTime * 2.6 + dot(P, uWind) * 1.3) * (0.3 + sheen) * 0.04;
      vec2 off;
      vec3 tf = cells(P * 6.0 - uWind * sway * 6.0, off);
      vec2 w = vec2(dot(P, uWind), dot(P, vec2(-uWind.y, uWind.x)));
      float blades = noise(vec2(w.x * 9.0, w.y * 18.0) + uWind * sway * 20.0);
      float k = clamp(1.5 - lod * 40.0, 0.0, 1.0);
      alb *= mix(1.0, (0.7 + 0.45 * under(0.1, 0.55, tf.x)) * (0.8 + 0.4 * blades), k);
    }
    alb = mix(alb, alb * 1.4 + vec3(0.03, 0.03, 0.02), sheen * 0.7);
    // Bare soil on the steeper slopes.
    alb = mix(alb, vec3(0.27, 0.22, 0.17), smoothstep(0.12, 0.3, slope) * 0.6);
    // Rock: crests and boulders, cracked, with lichen.
    float rock = clamp(T.y * smoothstep(0.12, 0.3, slope) * 1.6 + smoothstep(0.35, 0.55, slope), 0.0, 1.0);
    if (rock > 0.01) {
      float crack = 1.0 - abs(2.0 * fbm(P * 0.9 + 4.0, lod * 0.9) - 1.0);
      float vein = fbm(P * 0.15 + 8.0, lod * 0.15);
      vec3 stone = mix(vec3(0.20, 0.18, 0.16), vec3(0.32, 0.30, 0.27), vein) * (0.65 + 0.5 * fbm(P * 0.6, lod * 0.6));
      stone = mix(stone, vec3(0.38, 0.32, 0.12), smoothstep(0.72, 0.8, noise(P * 3.0 + 9.0)) * near * 0.7);   // lichen
      stone *= 1.0 - 0.6 * smoothstep(0.9, 0.98, crack) * near;
      alb = mix(alb, stone, smoothstep(0.3, 0.6, rock));
      n = normalize(n + vec3((fbm(P * 0.7 + 2.0, lod * 0.7) - 0.5), (fbm(P * 0.7 + 7.0, lod * 0.7) - 0.5), 0.0) * 0.9 * rock * near);
    }
    // The array's gravel pad.
    vec2 pq = abs(P - uArrayBox.xy) - uArrayBox.zw + 2.0;
    float onPad = 1.0 - smoothstep(-0.5, 0.5, max(pq.x, pq.y));
    alb = mix(alb, vec3(0.30, 0.29, 0.27) * (0.85 + 0.3 * noise(P * 4.0)), onPad);
    // The alkali crust and the wet band along the shore.
    float above = T.x - WATER;
    alb = mix(alb, vec3(0.50, 0.48, 0.42), (1.0 - smoothstep(0.25, 0.6, above)) * (1.0 - rock));
    alb = mix(alb, vec3(0.13, 0.13, 0.11), 1.0 - smoothstep(0.03, 0.18, above));
    float ao = 1.0;
    // Sagebrush and antelope-brush (in the terrain's shape near by; far off, a tint).
    vec3 leaf = mix(vec3(0.24, 0.27, 0.22), vec3(0.30, 0.29, 0.21), noise(P * 0.5)) * (0.75 + 0.5 * noise(P * 7.0));
    alb = mix(alb, leaf, T.w);
    // Flowers: balsamroot yellow, lupine violet and yarrow white, nodding in
    // the wind; far off, a tint where they grow.
    float bloom = smoothstep(0.5, 0.75, noise(P * 0.08 + 60.0) + T.z * 0.25) * step(0.4, above) * (1.0 - rock) * (1.0 - T.w);
    if (bloom > 0.0 && lod < 0.12) {
      vec2 sway = uWind * 0.06 * sin(uTime * 2.2 + dot(P, uWind) * 0.9) * (0.4 + sheen), foff;
      vec3 fc = cells((P - sway) * 2.0, foff);
      float rad = 0.2 * step(fc.y, 0.55) * bloom;
      if (fc.x < rad) {
        vec3 petal = fc.z < 0.45 ? vec3(0.80, 0.62, 0.06) : fc.z < 0.8 ? vec3(0.36, 0.24, 0.62) : vec3(0.78, 0.78, 0.72);
        alb = mix(alb, petal, clamp(1.5 - lod * 12.0, 0.0, 1.0) * smoothstep(rad, rad * 0.6, fc.x));
      }
    }
    alb = mix(alb, vec3(0.62, 0.50, 0.20), bloom * 0.12 * clamp(lod * 12.0 - 0.5, 0.0, 1.0));
    float sun = sunPast(p + n * (0.35 + 0.004 * t), t);
    c = litS(alb, n, sun, ao * (0.75 + 0.25 * n.z));
    float back = pow(max(dot(hd, normalize(uSun.xy + 1e-6)), 0.0), 3.0) * max(uSun.z + 0.05, 0.0);   // light through the blades
    c += curve(uSunLin * vec3(0.30, 0.25, 0.08) * back * (0.4 + sheen) * sun * (1.0 - rock)) * 0.5;
  }
  return mix(c, hazeAt(hd), 1.0 - exp(-t / 7000.0));
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
    float tLo;
    tLand = hitGround(vec3(0.0, 0.0, uEyeH), e, 2600.0, tLo);
    if (tLand > 0.0 && tLand < 200.0) tLand = refineHit(vec3(0.0, 0.0, uEyeH), e, tLo, tLand);
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

  /** Bake the made-up terrain into its height maps (MAPS), once; t: { lake, arrayBox, eyeH }. */
  buildTerrain(t) {
    if (this.maps) return;
    const { gl } = this, { prog, u } = link(gl, MAP_FRAG), fb = gl.createFramebuffer();
    gl.useProgram(prog);
    gl.uniform1i(u.uNoise, 3);
    gl.uniform4fv(u.uLake, t.lake);
    gl.uniform4fv(u.uArrayBox, t.arrayBox);
    gl.uniform1f(u.uEyeH, t.eyeH);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.viewport(0, 0, MAP_N, MAP_N);
    this.maps = MAPS.map((m, i) => {
      gl.activeTexture(gl.TEXTURE4 + i);
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, MAP_N, MAP_N, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR],
        [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      gl.uniform1f(u.uHalf, m.half);
      gl.uniform2f(u.uRange, m.range[0], m.range[1]);
      gl.uniform1i(u.uOctaves, m.octaves);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      return tex;
    });
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(fb);
    gl.deleteProgram(prog);
    gl.activeTexture(gl.TEXTURE0);
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
   *       wind, eyeH, lake: [east, north, radius east, radius north], arrayBox:
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
    gl.uniform4fv(u.uLake, p.lake);
    gl.uniform4fv(u.uArrayBox, p.arrayBox);
    gl.uniform1f(u.uSunOverHills, p.sunOverHills);
    for (let i = 0; i < MAPS.length; i++) gl.uniform1i(u[`uMap${i}`], 4 + i);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
}
