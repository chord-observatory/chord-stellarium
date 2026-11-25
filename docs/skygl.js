// The sky layer: one WebGL1 fragment shader that, for each pixel, inverts
// the projection (proj.js), looks up the 408 MHz sky (sky.png), adds the
// daylight and twilight (atmos.js) and the beam, and shades the ground.
// The radio sky shows through the daylight and the clouds, as radio waves
// pass through both.  The Landscape layer is part real, part made up: the
// hills from 700 m out are the real terrain (terrain.png), with made-up
// detail and firs; nearer, a made-up plain of bunchgrass that the wind
// sweeps, with firs, brush and boulders, flowers and snow by the season;
// over it, clouds from fractal noise on a steady wind.
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
const BAKE_ROWS = 256;                   // rows of a map baked in one go (SkyGL.bake)
// The real terrain (terrain.png; tools/make_terrain.py): half-width (m),
// samples across, and metres per unit of R * 256 + G.
const DEM = { half: 8000, n: 512, unit: 0.1 };
const glf = (x) => Number(x).toFixed(4);

const SKYLINE = `
// The terrain skyline's altitude (deg) at azimuth azDeg, linear between
// samples.  The texture is NEAREST; the interpolation is here so the
// 16-bit altitude is decoded before it is mixed.  far: 1 where the terrain
// that sets the skyline lies beyond the height maps, 0 within them.
float skyline(float azDeg, out float far) {
  float x = mod(azDeg, 360.0) / 360.0 * uHzN;
  float i0 = floor(x), f = x - i0, i1 = mod(i0 + 1.0, uHzN);
  vec4 a = texture2D(uHz, vec2((i0 + 0.5) / uHzN, 0.5));
  vec4 b = texture2D(uHz, vec2((i1 + 0.5) / uHzN, 0.5));
  float ha = (a.r * 65280.0 + a.g * 255.0) / 65535.0 * ${HZ_SPAN} + ${HZ_MIN};
  float hb = (b.r * 65280.0 + b.g * 255.0) / 65535.0 * ${HZ_SPAN} + ${HZ_MIN};
  far = mix(a.b, b.b, f);
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

// A tree from its site's random numbers: (height, the radius of its outline,
// 1 for a pine or 0 for a fir), in metres.
vec3 treeOf(vec4 t) {
  float ht = 7.0 + 15.0 * t.a * t.a, pine = step(fract(t.a * 13.0), 0.4);
  return vec3(ht, min(ht * (0.16 + 0.12 * fract(t.a * 7.0)) * (1.0 + 0.15 * pine), 3.4), pine);
}

// Whether the tree of cell g (its random numbers t) gives way to a taller
// one that it would overlap.  Trees then stand apart (two cells are 7 m
// and an outline is at most 3.4 m), and a site inside another tree's
// outline is never a tree itself.
bool crowded(vec2 g, vec4 t) {
  float rad = treeOf(t).y;
  for (int i = -1; i <= 1; i++) for (int j = -1; j <= 1; j++) {
    vec2 o = vec2(float(i), float(j));
    vec4 u = texture2D(uNoise, (g + o + 0.5) / 256.0);
    if (u.a > t.a && length(o + u.gb - t.gb) * 7.0 < rad + treeOf(u).y) return true;
  }
  return false;
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
    p = mix(p, (0.07 + 0.55 * smoothstep(0.05, 0.3, north) + 0.3 * smoothstep(150.0, 600.0, up)) * (0.4 + 1.2 * sw), real);
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
  if (real > 0.0) {
    // The real hills are benched and cut: bands of cliff along the contours
    // where the rock crops out, and gullies between spurs.
    float gl = 1.0 - abs(2.0 * fbm(P * 0.0045 + 41.0, px * 0.0045) - 1.0);
    h -= real * 22.0 * gl * gl * gl * smoothstep(0.0, 60.0, h);
    float st = 26.0, hs = h / st + 5.0 * fbm(P * 0.004 + 55.0, px * 0.004);
    float bench = (floor(hs) + smoothstep(0.3, 0.7, fract(hs)) - hs) * st;
    h += 0.65 * bench * real * smoothstep(0.42, 0.62, fbm(P * 0.0023 + 21.0, px * 0.0023)) * smoothstep(20.0, 80.0, h);
  }

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
    float crown = 0.0, edge = 9.0, leafy = 9.0;
    for (int i = -1; i <= 1; i++) for (int j = -1; j <= 1; j++) {
      vec2 g = g0 + vec2(float(i), float(j));
      vec4 t = texture2D(uNoise, (g + 0.5) / 256.0);
      vec2 S = (g + t.gb) * 7.0;
      vec2 sq = abs(S - uArrayBox.xy) - uArrayBox.zw;
      float open = step(55.0, length(S)) * step(34.0, max(sq.x, sq.y)) * step(52.0, segDist(S, vec2(0.0), uArrayBox.xy));
      if (t.r < treesAt(S) * open && !(r < 800.0 && crowded(g, t))) {
        // In the map a tree is only its outline, a cone or a dome; close by
        // the sky shader traces the tree inside it (treeTrace).
        vec3 T = treeOf(t);
        float ht = T.x, rad = T.y;
        if (px > 0.5) rad = max(rad * 1.25, 2.4);              // far off, stout enough for the map
        float d = length(P - S), x = d / rad;
        // A pine traced inside it (within 240 m) has a flat-topped outline,
        // room for its crown; beyond, the outline is all there is: a dome.
        // Where no trees are traced (TREES 0), a dome everywhere.
        float c = T.z < 0.5 ? ht * max(1.0 - x, 0.0)
                : ht * (TREES > 0 && length(S) < 240.0 ? pow(max(1.0 - x * x * x * x, 0.0), 0.25) : pow(max(1.0 - x * x, 0.0), 0.35));
        if (px > 0.5) c = ht * pow(max(1.0 - x, 0.0), 0.75) * (0.7 + 0.6 * noise(P * 0.45 + S * 0.37));   // far off, a ragged spire
        crown = max(crown, c);
        edge = min(edge, d - rad);
        leafy = min(leafy, length(S) < 240.0 ? d - rad + 0.9 : d - rad);   // a traced tree's needles: inside the outline
      }
    }
    if (px < 2.0 && r < 750.0) {
      h += crown;
      woody = max(woody, px < 0.5 ? under(0.3, 0.6, leafy) : under(px, 2.0 * px + 0.3, edge));   // near, the grass grows up to a traced outline (and its texels' blur stays inside)
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

// The sky shader, built twice (SkyGL): with LAND 1 for the Landscape layer
// (daylight, clouds, terrain), and with LAND 0 for the radio sky alone.  The
// Landscape's code would slow the sky alone even where it does not run: a
// GPU sets up every pixel for the longest path through the shader.
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
uniform sampler2D uHz;      // skyline: per azimuth step, altitude in 16 bits (R, G), beyond the maps (B)
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
uniform float uTime;        // seconds, for the wind
uniform vec2 uWind;         // the wind's direction (east, north)
uniform float uEyeH;        // the eye above the plain (m)
uniform vec4 uArrayBox;     // the array's pad: centre east, north and half-sizes (m) from the eye
uniform float uSunOverHills; // 1 when the Sun is above the real skyline, 0 behind it
uniform vec4 uBloom;        // the season (app.js): balsamroot, lupine, yarrow, rabbitbrush in flower (0 .. 1)
uniform float uGreen;       // the bunchgrass greening (0 .. 1)
uniform float uSnow;        // the snow lying (0 .. 1)
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
  vec3 floorLight = vec3(0.0012, 0.0016, 0.0026) + vec3(0.016, 0.016, 0.04) * under(-0.22, -0.02, uSun.z);   // and the night sky's soft light
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
  vec3 alb = mix(mix(vec3(0.27, 0.22, 0.13), vec3(0.17, 0.21, 0.09), 0.5 * uGreen), vec3(0.07, 0.10, 0.06), pine);
  alb *= 0.8 + 0.4 * patch;
  alb = mix(alb, vec3(0.80, 0.83, 0.88), uSnow * (0.55 + 0.45 * up) * (1.0 - 0.75 * pine));
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

const float GRASS = 0.26;                // the tallest bunchgrass (m)

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
  float bunch = smoothstep(0.3, 0.58, noise(Q * 6.0));
  return bunch * (0.3 + 0.7 * noise(mat2(0.8, 0.6, -0.6, 0.8) * Q * 41.0));
}

// The wildflower that may stand in the half-metre cell g, in flower as the
// season has it (uBloom), more of them in some tracts than others.  rr:
// the cell's random numbers (rr.a the kind: under 0.45 arrowleaf
// balsamroot, a yellow daisy; under 0.8 lupine, a violet spike; else
// yarrow, a low white dome); c: where it stands; top: the top of its head
// (m); RV: the head's radius and half-height (m).  False where none.
// Whether it grows depends on its own place, not on the pixel's.
bool flowerIn(vec2 g, out vec4 rr, out vec2 c, out float top, out vec2 RV) {
  rr = texture2D(uNoise, (g + 0.5) / 256.0);
  c = (g + 0.15 + 0.7 * rr.gb) * 0.5;
  top = 0.22 + 0.16 * fract(rr.a * 7.0);
  RV = rr.a < 0.45 ? vec2(0.055, 0.03) : rr.a < 0.8 ? vec2(0.024, 0.10) : vec2(0.055, 0.026);
  if (rr.r >= 0.4) return false;
  float on = rr.a < 0.45 ? uBloom.x : rr.a < 0.8 ? uBloom.y : 0.5 * uBloom.z;
  return rr.r < 0.4 * on * (0.3 + 0.7 * smoothstep(0.2, 0.8, noise(c * 0.12 + 60.0)));
}

// The cover of the ground from a map texel: rock, brush and tree, each 0..1.
vec3 coverOf(vec4 m, vec2 P, float lod) {
  float woody = clamp(2.0 * m.a - 1.0, 0.0, 1.0);
  if (length(P) >= 750.0) return vec3(clamp(1.0 - 2.0 * m.a, 0.0, 1.0), 0.0, 0.0);   // far off, the trees are farTrees'
  float tree = smoothstep(0.6, 0.85, woody);
  return vec3(clamp(1.0 - 2.0 * m.a, 0.0, 1.0), smoothstep(0.1, 0.35, woody) * (1.0 - tree), tree);
}

// How thick the far trees stand at P, in clumps and gaps, for share (0..1)
// of the ground: 0 .. 2 share, share on average.
float clumpAt(vec2 P, float share) { return share * 2.0 * smoothstep(0.3, 0.7, noise(P * 0.02 + 70.0)); }

// Far off (from 750 m, where the maps hold only the share of trees) the
// trees stand one to a 12 m cell, in clumpAt of the cells, and are drawn
// where they stand in front of the slope.  The ray to P passes a
// trunk a (m) short of P along the ground, at a * rise above the slope
// (rise: the slope's rise across the ray, per metre), and b to its side;
// the tree hides P if b is inside its crown at that height.  The cells are
// looked up every 6 m back along the ray, up to 48 m.  lod: metres per
// pixel across.  Returns the cover (0..1); side: where across the crown
// (-1..1); up: how high up the tree (0..1).
float farTrees(vec2 P, vec2 hd, float rise, float share, float lod, out float side, out float up) {
  float cover = 0.0, best = -99.0;
  side = 0.0; up = 0.5;
  vec2 hp = vec2(-hd.y, hd.x);
  for (int k = 0; k < 8; k++) {
    vec2 g = floor((P - hd * (6.0 * float(k))) / 12.0);
    vec4 t = texture2D(uNoise, (g + 0.5) / 256.0);
    if (t.r >= 2.0 * share) continue;
    vec2 S = (g + 0.29 + 0.42 * t.gb) * 12.0;                // the trunk, with the crown inside the cell
    if (t.r >= clumpAt(S, share)) continue;
    vec3 T = treeOf(t);
    vec2 D = P - S;
    float a = dot(D, hd), b = dot(D, hp), z = max(a, 0.0) * rise / T.x;
    if (a < -T.y || z > 1.0 || a < best) continue;
    float w = T.z < 0.5 ? T.y * (1.0 - z) * (0.8 + 0.2 * sin(z * 31.0 + t.a * 40.0))        // a fir: a ragged cone
                        : z < 0.5 ? 0.12 * T.y : T.y * sqrt(max(1.0 - pow((z - 0.75) * 4.0, 2.0), 0.0));   // a pine: a trunk under a crown
    float c = smoothstep(-lod, lod, w - abs(b));
    if (c > 0.0) { cover = max(cover, c); best = a; side = clamp(b / max(w, 0.01), -1.0, 1.0); up = z; }
  }
  return cover;
}

// The air and the mist between the eye and p, t away, over colour c.
vec3 aired(vec3 c, vec3 p, float t, vec2 hd) {
  c = mix(c, hazeAt(hd), 1.0 - exp(-t / 11000.0));
  return mix(c, mistColour(), mistTo(p, t));
}

// The height of a traced tree's outline in the maps (terrainAt's) x of its
// radii from the trunk.  T: treeOf.
float outlineOf(float x, vec3 T) {
#if TREES
  return T.x * (T.z < 0.5 ? max(1.0 - x, 0.0) : pow(max(1.0 - x * x * x * x, 0.0), 0.25));
#else
  return T.x * (T.z < 0.5 ? max(1.0 - x, 0.0) : pow(max(1.0 - x * x, 0.0), 0.35));
#endif
}
// The ground at P, by the tree at S (T: treeOf; T.x = 0 for none) whose
// outline the map adds to it there.  Where the outline drops steeply to the
// ground (a pine's edge, a fir's foot) the texels blur it, so the ground is
// read just outside, unless that is at another tree's outline.
float groundH(vec2 P, vec2 S, vec3 T) {
  if (T.x <= 0.0) return mapH(P);
  vec2 D = P - S;
  float x = length(D) / T.y, xo = 1.0 + 2.0 * mapEps(P) / T.y, inside = mapH(P) - outlineOf(x, T);
  float lo = T.z > 0.5 ? 0.8 : 2.0 - xo;
  if (x < xo && x > lo) {
    vec4 mo = mapTexel(S + D * (xo / x));
    float outer = mo.b > 0.97 ? min(heightOf(mo), inside) : heightOf(mo);
    return mix(inside, outer, smoothstep(lo, lo + 0.08, x));
  }
  return inside;
}

// The snow lying at p (m) on ground of normal n (0 .. 1, by uSnow): a
// dusting on the plain, in drifts and bare patches, thicker up the hills
// and on slopes that face north, none on steep faces.  lod: metres per pixel.
const vec3 SNOW = vec3(0.80, 0.83, 0.88);
float snowAt(vec3 p, vec3 n, float lod) {
  if (uSnow <= 0.0) return 0.0;
  float depth = uSnow * (0.5 + 0.6 * smoothstep(80.0, 400.0, p.z) + 0.3 * clamp(n.y * 3.0, -0.5, 1.0));
  return smoothstep(0.4, 0.6, depth + 0.6 * (fbm(p.xy * 0.4 + 81.0, lod * 0.4) - 0.5)) * smoothstep(0.5, 0.8, n.z);
}

// The grassland's colour at P, Q where the ray meets the blades, for lod
// metres per pixel; near: 1 where the blades stand in relief, slope: 1 -
// the normal's z, fine: the finest grain (0..1).
vec3 strawAt(vec2 P, vec2 Q, float lod, float near, float slope, float fine) {
  float tex = fbm(Q * 1.7 + 5.0, lod * 1.7);
  float patches = fbm(P * 0.025 + 1.0, lod * 0.025);
  vec3 straw = mix(vec3(0.56, 0.47, 0.27), vec3(0.39, 0.29, 0.15), smoothstep(0.3, 0.7, tex));   // cured blades, pale to russet
  straw = mix(straw, vec3(0.19, 0.24, 0.09), clamp((patches - 0.55) * 1.5, 0.0, 0.4));   // greener patches
  straw = mix(straw, vec3(0.15, 0.26, 0.11) * (0.8 + 0.4 * tex), uGreen * (0.45 + 0.35 * patches));   // in spring, new blades among last year's
  // Sage on the slopes, far off: grey-green in mottled patches.
  float sage = smoothstep(0.45, 0.62, fbm(P * 0.04 + 13.0, lod * 0.04)) * smoothstep(0.02, 0.10, slope) * (1.0 - near);
  straw = mix(straw, vec3(0.25, 0.26, 0.19) * (0.7 + 0.6 * fbm(P * 0.7 + 3.0, lod * 0.7)), sage * 0.75);
  straw *= 0.75 + 0.5 * fine;
  float tufts = fbm(P * 0.33 + 23.0, lod * 0.33);
  straw *= mix((0.52 + 0.6 * smoothstep(0.35, 0.65, patches)) * (0.7 + 0.6 * smoothstep(0.3, 0.7, tufts)), 1.0, near);   // far off: tufts, and lighter and darker tracts
  return mix(straw, vec3(0.33, 0.28, 0.21), smoothstep(0.6, 0.75, tufts) * 0.6 * (1.0 - near));     // and bare ground
}

// The tree whose outline in the map holds P, or is nearest within 2.5 of
// its radii: its site and treeOf.
bool treeNear(vec2 P, out vec2 S, out vec3 T) {
  vec2 g0 = floor(P / 7.0);
  float best = 2.5;
  bool found = false;
  for (int i = -1; i <= 1; i++) for (int j = -1; j <= 1; j++) {
    vec2 g = g0 + vec2(float(i), float(j));
    vec4 t = texture2D(uNoise, (g + 0.5) / 256.0);
    vec2 s = (g + t.gb) * 7.0;
    vec3 tr = treeOf(t);
    float x = length(P - s) / tr.y;
    if (x < best && mapTexel(s).a > 0.9 && !crowded(g, t)) { best = x; S = s; T = tr; found = true; }
  }
  return found;
}

float segDist3(vec3 p, vec3 a, vec3 b) {
  vec3 pa = p - a, ba = b - a;
  return length(pa - ba * clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0));
}

// Roughly the distance from q to a tree (never more than the true one); q
// is from the foot of the trunk.  T: treeOf.  bark: 1 where the trunk or a
// limb is nearer than the needles.  A fir (Douglas fir) is tiers of
// boughs, uneven and tilted, each widest at its foot and drooping to a
// ragged edge, with here and there a bough missing.  A pine (ponderosa) is
// a tall bare trunk under a crown of needle tufts at the ends of upswept
// limbs, with sky between them.
float treeSdf(vec3 q, vec3 T, float seed, out float bark) {
  float ht = T.x, rad = T.y, r = length(q.xy), z = q.z / ht;
  float th = atan(q.y, q.x), bole, leaf;
  vec2 dir = q.xy / max(r, 0.001);                          // for noise round the trunk without a seam
  if (T.z < 0.5) {
    bole = max(r - 0.03 * ht * (1.0 - 0.8 * z) - 0.04, q.z - 0.93 * ht);
    float n = clamp(floor(ht / 1.25), 4.0, 11.0);
    float zz = (z - 0.1) / 0.9 + (noise(dir * 1.6 + vec2(seed * 13.0, z * 3.0)) - 0.5) * 0.6 / n;
    float k = floor(zz * n), f = zz * n - k;
    float reach = rad * 0.82 * (1.0 - k / n) * (1.0 - 0.55 * f) * (0.85 + 0.2 * fract(sin(k * 12.9898 + seed * 78.233) * 43758.5453));
    reach *= 0.78 + 0.22 * sin(th * (5.0 + mod(k, 3.0)) + k * 2.3 + seed * 31.0);
    reach *= 0.45 + 0.55 * smoothstep(0.2, 0.55, noise(dir * 2.4 + vec2(k * 7.0 + seed * 9.0, q.z * 1.7)));
    leaf = zz < 0.0 ? 9.0 : zz > 1.0 ? q.z - ht : (r - reach) * 0.55;
  } else {
#if LIMBS
    bole = max(r - 0.035 * ht * (1.0 - 0.6 * z) - 0.05, q.z - 0.9 * ht);
    float cb = (0.45 + 0.13 * fract(seed * 7.3)) * ht;      // where the crown starts
    leaf = max(r - rad, cb - 0.5 * rad - q.z);               // away from the crown, its bound will do
    if (leaf < 0.6) {
      leaf = 9.0;
      for (int i = 0; i < 9; i++) {
        float u = (float(i) + 0.5) / 9.0, a = seed * 40.0 + float(i) * 2.39996;
        float zi = mix(cb, 0.86 * ht, u) + (fract(seed * 17.0 + float(i) * 0.371) - 0.5) * 0.07 * ht;
        float s = rad * (0.24 + 0.1 * fract(seed * 5.0 + float(i) * 0.29)) * (1.15 - 0.35 * u);
        float top = min((zi + 0.15 * rad + 0.65 * s) / ht, 1.0);
        float ri = max(rad * sqrt(sqrt(1.0 - top * top * top * top)) - 1.05 * s, 0.1 * rad) * (0.7 + 0.3 * fract(seed * 23.0 + float(i) * 0.613));
        vec3 tip = vec3(cos(a) * ri, sin(a) * ri, zi + 0.25 * ri);
        bole = min(bole, segDist3(q, vec3(0.0, 0.0, zi - 0.25 * ri), tip) - 0.03 - 0.006 * ht * (1.0 - u));
        leaf = min(leaf, (length((q - tip) / vec3(s, s, 0.65 * s)) - 1.0) * 0.65 * s);
      }
      leaf = min(leaf, (length((q - vec3(0.0, 0.0, 0.9 * ht)) / vec3(0.3 * rad, 0.3 * rad, 0.09 * ht)) - 1.0) * 0.3 * rad);
      float tuft = noise(q.xy * 2.6 + vec2(q.z * 2.1, seed * 40.0)) + 0.5 * noise(vec2(q.x - q.y, q.z) * 6.3 + 9.0);
      leaf = (leaf + (tuft - 0.75) * 0.22 * rad) * 0.7;
    }
#else
    // A plain crown: one body and three boughs.
    bole = max(r - 0.04 * ht * (1.0 - 0.6 * z) - 0.05, q.z - 0.8 * ht);
    vec3 c = vec3(0.0, 0.0, 0.72 * ht);
    leaf = (length((q - c) / vec3(0.62 * rad, 0.62 * rad, 0.26 * ht)) - 1.0) * 0.55 * rad;
    for (int i = 0; i < 3; i++) {
      float a = seed * 6.28 + float(i) * 2.1;
      c = vec3(cos(a) * 0.38 * rad, sin(a) * 0.38 * rad, (0.48 + 0.08 * float(i)) * ht);
      leaf = min(leaf, (length((q - c) / vec3(0.4 * rad, 0.4 * rad, 0.13 * ht)) - 1.0) * 0.36 * rad);
    }
    float lump = noise(q.xy * 1.6 + vec2(q.z * 1.3, seed * 40.0)) + noise(vec2(q.x - q.y, q.z * 1.5) * 1.4 + 9.0);
    leaf = (leaf + (lump - 1.0) * 0.28 * rad) * 0.7;
#endif
  }
  bark = step(bole, leaf);
  return min(bole, leaf);
}

// A tree's bulk, for its shadow: the trunk, and the crown as one ragged
// body with holes (treeSdf has every bough, and is too much code to have
// here as well: see treeTrace).  q, T, seed: as treeSdf.
float treeBulk(vec3 q, vec3 T, float seed) {
  float ht = T.x, rad = T.y, r = length(q.xy), z = q.z / ht, leaf;
  float bole = max(r - 0.035 * ht * (1.0 - 0.7 * z) - 0.045, q.z - 0.9 * ht);
  float rag = (noise(q.xy * 1.1 + vec2(q.z * 1.7, seed * 40.0)) - 0.5) * 0.7 * rad;
  if (T.z < 0.5) leaf = z < 0.1 ? 9.0 : z > 1.0 ? q.z - ht : (r - 0.62 * rad * (1.0 - (z - 0.1) / 0.9)) * 0.55;
  else {
    float cb = (0.45 + 0.13 * fract(seed * 7.3)) * ht, hc = 0.5 * (0.95 * ht - cb);
    leaf = (length((q - vec3(0.0, 0.0, cb + hc)) / vec3(0.8 * rad, 0.8 * rad, hc)) - 1.0) * min(0.8 * rad, hc);
  }
  return min(bole, leaf + rag);
}

// Sunlight reaching p past the terrain, softened (0 .. 1).  Within 240 m
// a tree's outline in the map is only its bound: inside it the tree itself
// casts the shadow, with light through its gaps.
float sunPast(vec3 p) {
  if (uSun.z < -0.03) return 0.0;
  float res = 1.0, t = 0.5, base = 0.0, seed = 0.0;
  vec2 S = vec2(1e5);
  vec3 T = vec3(0.0);
  for (int i = 0; i < 30; i++) {
    vec3 q = p + uSun * t;
    vec4 m = mapTexel(q.xy);
    float d = q.z - heightOf(m);
    if (d < 0.0 && m.b > 0.95 && dot(q.xy, q.xy) < 57600.0) {
      if (length(q.xy - S) > 1.25 * T.y) {
        if (treeNear(q.xy, S, T) && dot(S, S) < 57600.0) { base = mapH(S) - T.x; seed = fract(S.x * 0.137 + S.y * 0.291); }
        else { S = vec2(1e5); T = vec3(0.0); }
      }
#if TREES && BULK
      if (T.x > 0.0) d = treeBulk(q - vec3(S, base), T, seed);
#endif
    }
    res = min(res, 6.0 * d / t);
    if (res < 0.0 || q.z > 45.0 + 0.2 * length(q.xy)) break;
    t += max(0.9, 0.13 * t);
  }
  return clamp(res, 0.0, 1.0) * uSunOverHills;
}

// A near tree, traced inside its outline, which the ray meets at t0.
// Returns 1 with its colour, 2 when the ray goes through it (out again at
// tOut), or 0 when there is no tree to trace here.
float treeTrace(vec3 ro, vec3 rd, float t0, float pix, out vec3 col, out float tOut) {
  vec3 p0 = ro + rd * t0;
  col = vec3(0.0);
  tOut = t0;
  if (t0 > 245.0 || mapEps(p0.xy) > 0.3 || mapTexel(p0.xy).b < 0.9) return 0.0;
  vec2 S;
  vec3 T;
  if (!treeNear(p0.xy, S, T) || dot(S, S) > 57600.0) return 0.0;
  float base = mapH(S) - T.x, seed = fract(S.x * 0.137 + S.y * 0.291);
  // The wind rocks the top.
  vec2 sway = uWind * 0.012 * T.x * sin(uTime * 1.3 + seed * 20.0) * (0.5 + 0.5 * sin(uTime * 0.31 + seed * 7.0));
  float t = t0 - 0.15, tEnd = t0 + 2.6 * T.y / max(length(rd.xy), 0.3) + 1.0, bark, d = 1.0, above = 1.0;
  vec3 q;
  bool hit = false;
  int at = 0;
  // The march to the tree (56 steps at most), then at the hit its normal
  // (four samples), how open it is there (one) and the tree's own shade
  // (four).  All take treeSdf by the one call: a compiler copies it in
  // at every call, and the time it takes goes as the copies.
  float b2, open = 1.0, lit = 1.0, ahead = 0.0;             // open: 0 deep among the boughs
  const vec2 k = vec2(1.0, -1.0);
  vec3 n = vec3(0.0), o = vec3(0.0);
  for (int i = 0; i < 65; i++) {
    int j = i - at;                                           // the sample, once on the tree
    vec3 qs;
    float s = 0.25 * float(j - 4) * float(j - 4);
    if (!hit) {
      vec3 w = ro + rd * t;
      q = w - vec3(S, base);
      float x = length(q.xy) / T.y;
      // The ground (in and about the outline the map holds it plus the outline).
#if FOOT
      if (q.z < 3.0) {
        above = w.z - groundH(w.xy, S, T);
        if (above < 0.0) { t += max(above / max(-rd.z, 0.05), -0.4); break; }
      }
#endif
      // Out of the outline and going away (or out of steps: beside the trunk
      // they are short): on to what is behind, from where the ray leaves the
      // circle of the outline and its blur in the map (a ray along its side
      // would meet it again), not past the ground.
      float rOut = T.y + 2.0 * mapEps(w.xy), aa = max(dot(rd.xy, rd.xy), 1e-6), bb = dot(q.xy, rd.xy);
      ahead = max((-bb + sqrt(max(bb * bb - aa * (dot(q.xy, q.xy) - rOut * rOut), 0.0))) / aa, 0.3);
      if (q.z < 3.0) ahead = clamp(above / max(-rd.z, 0.01) - 0.05, 0.0, ahead);
      if ((dot(q.xy, rd.xy) > 0.0 && (x > 1.05 || q.z > 0.3 + outlineOf(x, T))) || i >= 55) { tOut = t + ahead; return 2.0; }
      q.xy -= sway * (q.z / T.x) * (q.z / T.x);
      qs = q;
    } else {
#if !SHADE
      n = vec3(0.0, 0.0, 1.0);
      break;
#endif
      if (j > 8 || (j > 4 && uSun.z <= 0.0)) break;
      o = j == 0 ? k.xyy : j == 1 ? k.yyx : j == 2 ? k.yxy : k.xxx;
      qs = q + (j < 4 ? o * 0.03 : j == 4 ? n * 0.45 : n * 0.05 + uSun * s);
    }
    float v = treeSdf(qs, T, seed, b2);
    if (!hit) {
      d = v;
      bark = b2;
      if (d < 0.6 * t * pix + 0.01) { hit = true; at = i + 1; continue; }
      t += clamp(d, 0.03, 0.4);
      if (t > tEnd) { tOut = t + ahead; return 2.0; }
    }
    else if (j < 4) { n += o * v; if (j == 3) n = normalize(n); }
    else if (j == 4) open = clamp(v / 0.45, 0.0, 1.0);
    else lit = min(lit, 0.3 + 3.0 * v / s);
  }
  vec3 p = ro + rd * t;
  vec2 hd = length(rd.xy) > 1e-5 ? normalize(rd.xy) : vec2(0.0, 1.0);
  float shade = sunPast(hit ? vec3(S, base + T.x + 0.5) : p + vec3(0.0, 0.0, 0.3 + 0.004 * t));
  if (hit) shade *= cloudShade(S);
#if !UNDER
  if (!hit) { col = vec3(0.2, 0.17, 0.1); return 1.0; }
#endif
  if (!hit) {
    // The ground under the tree: the grassland (as groundAt has it there),
    // giving way to the tree's needles toward the trunk, in its own shade.
    float lod = t * pix / max(-rd.z, 0.15), fine = mix(0.5, noise(p.xy * 31.0), clamp(1.5 - lod * 60.0, 0.0, 1.0));
    float x = length(p.xy - S) / T.y + 0.4 * (noise(p.xy * 1.3 + seed * 50.0) - 0.5);
    vec3 alb = mix(vec3(0.22, 0.14, 0.075) * (0.75 + 0.5 * fine), strawAt(p.xy, p.xy, lod, clamp(1.5 - lod * 2.5, 0.0, 1.0), 0.0, fine), smoothstep(0.35, 1.0, x));
    alb = mix(alb, SNOW, snowAt(p, vec3(0.0, 0.0, 1.0), lod) * smoothstep(0.3, 1.0, x));   // less under the boughs
    float sun = shade * cloudShade(p.xy);
    col = aired(litS(alb, vec3(0.0, 0.0, 1.0), sun, 0.78 * (0.6 + 0.4 * smoothstep(0.3, 1.0, x))), p, t, hd);
    return 1.0;
  }
  lit = clamp(lit, 0.0, 1.0);
  float lod = t * pix, near = clamp(1.5 - lod * 30.0, 0.0, 1.0);
  vec3 alb;
  if (bark > 0.5) {
    float furrow = noise(vec2(atan(q.y, q.x) * 7.0, q.z * 1.8) + seed * 30.0);
    alb = mix(vec3(0.10, 0.08, 0.07), T.z > 0.5 ? vec3(0.30, 0.17, 0.09) : vec3(0.17, 0.13, 0.10), smoothstep(0.3, 0.7, furrow));
  } else {
    float needles = mix(0.5, noise(vec2(q.x - q.y, q.z * 1.4) * 11.0) * 0.5 + noise(q.xy * 12.0 + q.z * 3.0) * 0.5, near);
    float kind = noise(S * 0.11 + 40.0);
    vec3 deep = mix(vec3(0.010, 0.020, 0.018), vec3(0.018, 0.024, 0.014), kind);
    vec3 tip = T.z > 0.5 ? mix(vec3(0.050, 0.072, 0.040), vec3(0.064, 0.080, 0.042), kind) : mix(vec3(0.030, 0.058, 0.046), vec3(0.042, 0.066, 0.044), kind);
    alb = mix(deep, tip, smoothstep(0.15, 0.9, open * 0.65 + needles * 0.45));
    alb = mix(alb, SNOW, uSnow * 0.5 * open * smoothstep(0.55, 0.9, n.z) * smoothstep(0.35, 0.65, needles));   // snow on the boughs' tops
    n = normalize(n + (needles - 0.5) * 0.6 * near);
  }
  col = litS(alb, n, shade * lit, 0.2 + 0.8 * open);
  // Low sunlight through the needles' edges.
  float back = pow(max(dot(hd, normalize(uSun.xy + 1e-6)), 0.0), 3.0) * max(uSun.z + 0.05, 0.0);
  col += curve(uSunLin * vec3(0.10, 0.16, 0.04) * back * shade * open * (1.0 - bark)) * 0.4;
  col = aired(col, p, t, hd);
  return 1.0;
}

// The terrain where the view ray e meets it at distance t (metres).
vec3 groundAt(vec3 e, float t, float pix) {
  vec3 p = vec3(0.0, 0.0, uEyeH) + e * t;
  vec2 P = p.xy;
  vec2 hd = length(e.xy) > 1e-5 ? normalize(e.xy) : vec2(0.0, 1.0);
  vec4 m = mapTexel(P);
  // Beside a traced tree (within 1.5 m of its outline, which the slope and
  // hollows below sample) the map holds the outline too; the ground is without it.
  vec2 S = vec2(0.0);
  vec3 T = vec3(0.0);
  if (m.b < 0.75 || t > 245.0 || !treeNear(P, S, T) || dot(S, S) > 57600.0) T = vec3(0.0);
  float h = groundH(P, S, T);
  if (T.x > 0.0) p.z = h;                                  // not up the outline's blurred foot
  float lod = t * pix / max(-e.z, 0.12);                  // metres per pixel along the ground, about
  float gust = fbm(P * 0.06 - uWind * uTime * 0.25, lod * 0.06);
  float sheen = smoothstep(0.45, 0.75, gust);
  float shade = cloudShade(P);
  vec3 c;
  {
    float ep = max(1.5 * mapEps(P), lod);
    vec4 nb = vec4(groundH(P - vec2(ep, 0.0), S, T), groundH(P + vec2(ep, 0.0), S, T), groundH(P - vec2(0.0, ep), S, T), groundH(P + vec2(0.0, ep), S, T));
    vec3 n = normalize(vec3(nb.x - nb.y, nb.z - nb.w, 2.0 * ep));
    float cavity = clamp(1.0 - 0.9 * (dot(nb, vec4(0.25)) - h) / ep, 0.35, 1.15);   // darker in hollows, lighter on tips
    lod = t * pix / max(dot(-e, n), 0.15);
    float near = clamp(1.5 - lod * 2.5, 0.0, 1.0);           // detail fades out with distance
    float slope = 1.0 - n.z;
    vec3 cov = coverOf(m, P, lod);
    float woody = max(cov.y, cov.z);
    float rock = clamp(max(cov.x * 1.6, smoothstep(mix(0.13, 0.28, near), mix(0.3, 0.5, near), slope)) * (1.0 - smoothstep(0.0, 0.2, woody)), 0.0, 1.0);
    vec2 pq = abs(P - uArrayBox.xy) - uArrayBox.zw + 2.0;
    float onPad = 1.0 - smoothstep(-0.5, 0.5, max(pq.x, pq.y));
    float grassy = (1.0 - rock) * (1.0 - onPad) * (1.0 - woody);
    float inFlower = dot(uBloom.xyz, vec3(1.0, 1.0, 0.5));
#if FLOWERS
    bool flowers = inFlower > 0.01 && grassy > 0.5;
#else
    const bool flowers = false;
#endif

    // Grass.  Close by it stands in relief: the ray is marched down through
    // the bunches, bent by the wind, with flowers among them.  f: how high
    // in the grass the ray stops (0 the soil .. 1); Q: where; fl: 0, 0.5 on
    // a flower's stem, 1 on its head (flCol: the head's colour there); lit:
    // sunlight past the bunches next to it.
    float f = grassH(P) * near + 0.34 * (1.0 - near), fl = 0.0, lit = 1.0;
    vec2 Q = P;
    vec3 flCol = vec3(0.0);
    float k = clamp(1.6 - t / 30.0, 0.0, 1.0) * step(0.5, grassy);
    if (k > 0.0) {
      float Hm = GRASS * k * (0.5 + 0.5 * noise(P * 0.9 + 9.0));       // taller and shorter stands
      float rate = max(dot(-n.xy / max(n.z, 0.2), e.xy) - e.z, 0.03);    // height lost per metre of ray
      // Where flowers may grow the march starts above the tallest of them.
      bool fls = flowers && t < 36.0;
      float back = min(max(1.3 * Hm, fls ? 0.42 : 0.0) / rate, 5.0), dt = back / 26.0;
      float jit = texture2D(uNoise, gl_FragCoord.xy / 256.0).a;
      float bend = (0.05 + 0.12 * sheen) * (0.7 + 0.3 * sin(uTime * 2.6 + dot(P, uWind) * 1.3));
      f = 0.0;
      for (int i = 0; i < 26; i++) {
        float tau = back - (float(i) + jit) * dt;            // metres short of the ground
        float s = tau * rate / Hm;
        vec2 q = P - e.xy * tau - uWind * bend * s * s;
        if (fls) {
          // A flower (flowerIn) is a head on a thin stem.  The head is an
          // ellipsoid, met exactly by the piece of the ray since the last
          // step (looked for in the cells at both of its ends), so its
          // outline is clean.
          float sP = (tau + dt) * rate / Hm;
          vec2 qP = P - e.xy * (tau + dt) - uWind * bend * sP * sP;
          for (int w = 0; w < 2; w++) {
            vec4 rr;
            vec2 c, RV;
            float top;
            if (!flowerIn(floor((w == 0 ? qP : q) * 2.0), rr, c, top, RV) || dot(c, c) >= 900.0) continue;
            vec3 sc = vec3(1.0, 1.0, RV.x / RV.y), C = vec3(c, top - RV.y);
            vec3 a3 = (vec3(qP, sP * Hm) - C) * sc, d3 = (vec3(q, s * Hm) - C) * sc - a3;
            float aa = dot(d3, d3), bb = dot(a3, d3), cc = dot(a3, a3) - RV.x * RV.x;
            float disc = bb * bb - aa * cc, u = disc > 0.0 ? max((-bb - sqrt(disc)) / aa, 0.0) : 2.0;
            if (u <= 1.0 && (cc < 0.0 || bb < 0.0)) {
              vec3 l = (a3 + d3 * u) / RV.x;                 // on the unit sphere: east, north, up
              float th = atan(l.y, l.x) + rr.g * 6.28;
              if (rr.a < 0.45) {
                // The face looks up and to one side; rays about a darker centre, green behind.
                vec3 ax = normalize(vec3(cos(rr.b * 6.28), sin(rr.b * 6.28), 1.3));
                vec3 bx = normalize(cross(ax, vec3(0.0, 0.0, 1.0))), by = cross(ax, bx);
                float ca = dot(l, ax), pet = abs(sin(atan(dot(l, by), dot(l, bx)) * 6.5));
                flCol = ca > 0.9 ? vec3(0.50, 0.30, 0.03)
                      : ca > -0.6 ? vec3(0.95, 0.68, 0.04) * (0.62 + 0.38 * smoothstep(0.0, 0.5, pet)) * (0.75 + 0.25 * ca)
                      : vec3(0.22, 0.27, 0.10);
              } else if (rr.a < 0.8) {
                float whorl = sin(l.z * 12.0 + 0.5 * sin(th * 4.0));   // rings of pea flowers up the spike
                flCol = mix(vec3(0.17, 0.09, 0.50), vec3(0.40, 0.29, 0.80), smoothstep(-0.3, 0.6, whorl));
                flCol = mix(flCol, vec3(0.40, 0.45, 0.32), smoothstep(0.65, 0.95, l.z));   // buds at the tip
              } else {
                float florets = sin(l.x * 13.0 + rr.b * 9.0) * sin(l.y * 13.0 + rr.g * 9.0);
                flCol = mix(vec3(0.58, 0.58, 0.46), vec3(0.90, 0.89, 0.80), smoothstep(-0.5, 0.3, florets));
                flCol = mix(vec3(0.25, 0.30, 0.14), flCol, smoothstep(-0.5, -0.1, l.z));    // green beneath
              }
              flCol *= 0.66 + 0.34 * smoothstep(-0.7, 0.5, l.z);
              f = mix(sP, s, u); Q = mix(qP, q, u); fl = 1.0;
              break;
            }
            vec2 ad = c - qP, dd = q - qP;
            float us = clamp(dot(ad, dd) / max(dot(dd, dd), 1e-8), 0.0, 1.0), zs = mix(sP, s, us) * Hm;
            if (lod < 0.02 && length(ad - dd * us) < 0.006 && zs < top - RV.y) {
              f = zs / Hm; Q = mix(qP, q, us); fl = 0.5;
              break;
            }
          }
          if (fl > 0.0) break;
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
    // From 30 m out the flowers are not marched for (the march leaves them
    // out) but drawn on the ground where they stand, each head stretched
    // along the ray as the ground is foreshortened (drop: the height the
    // ray falls per metre), so it shows at its own size.  It covers the
    // pixel smoothly over a pixel, and fades once smaller than one.
    float flCov = 0.0;
    if (flowers && t >= 29.0 && t * pix < 0.3) {
      float drop = max(-e.z / max(length(e.xy), 1e-4), 0.02);
      for (int w = 0; w < 3; w++) {
        vec4 rr;
        vec2 c, RV;
        float top;
        if (!flowerIn(floor((P + hd * (0.5 * float(w) - 0.5)) * 2.0), rr, c, top, RV) || dot(c, c) < 900.0) continue;
        vec2 D = P - c;
        float a = dot(D, hd) * drop, b = dot(D, vec2(-hd.y, hd.x));
        float d = length(vec2(b / RV.x, a / RV.y)), r = min(RV.x, RV.y) / (t * pix);   // d: 1 at its edge; r: its radius in pixels
        float cv = clamp(0.5 + (1.0 - d) * r, 0.0, 1.0) * min(sqrt(RV.x * RV.y) / (t * pix), 1.0);
        if (cv > flCov) { flCov = cv; flCol = rr.a < 0.45 ? vec3(0.80, 0.57, 0.04) : rr.a < 0.8 ? vec3(0.28, 0.19, 0.65) : vec3(0.84, 0.83, 0.74); }
      }
    }
    float fine = mix(0.5, noise(Q * 31.0), clamp(1.5 - lod * 60.0, 0.0, 1.0));
    vec3 straw = strawAt(P, Q, lod, near, slope, fine);
    straw = mix(straw, straw * 1.35 + vec3(0.03, 0.03, 0.02), sheen * 0.6 * smoothstep(0.3, 0.9, f));   // gusts show the pale side
    vec3 soil = mix(vec3(0.33, 0.28, 0.21), straw * 0.7, smoothstep(0.45, 0.7, noise(Q * 19.0 + 7.0)) * near);   // soil and litter
    vec3 alb = mix(soil, straw, smoothstep(0.0, 0.2, f));
    float ao = 0.58 + 0.42 * smoothstep(0.0, 0.7, f);
    if (fl > 0.9) {
      alb = flCol;
      ao = 1.0; lit = 1.0;
    } else if (fl > 0.0) { alb = vec3(0.17, 0.21, 0.08); ao = 0.8; }
    alb = mix(alb, flCol, flCov);
    ao = mix(ao, 1.0, flCov);
    lit = mix(lit, 1.0, flCov);
    // Farther still, the flowers in season tint the grass, and rabbitbrush
    // gilds it in the autumn.
    vec3 tint = uBloom.x * vec3(0.80, 0.57, 0.04) + uBloom.y * vec3(0.28, 0.19, 0.65) + 0.5 * uBloom.z * vec3(0.84, 0.83, 0.74) + uBloom.w * vec3(0.80, 0.60, 0.10);
    float tints = inFlower + uBloom.w;
    if (tints > 0.01) alb = mix(alb, tint / tints, min(tints, 1.0) * 0.08 * grassy * smoothstep(0.15, 0.4, t * pix));

    // Rock: crags, boulders and steep faces; bedded, cracked, with lichen.
    if (rock > 0.01) {
      float warp = fbm(P * 0.25 + 4.0, lod * 0.25);
      float beds = fbm(vec2(p.z * 2.2 + warp * 3.0, dot(P, vec2(0.05, 0.03))), lod * 2.2);
      float crack = 1.0 - abs(2.0 * fbm(P * 0.9 + 4.0, lod * 0.9) - 1.0);
      vec3 stone = mix(vec3(0.17, 0.16, 0.15), vec3(0.37, 0.34, 0.30), beds) * (0.7 + 0.5 * fbm(P * 2.3, lod * 2.3));
      stone = mix(stone, vec3(0.40, 0.33, 0.11), smoothstep(0.70, 0.78, noise(P * 3.0 + 9.0)) * near * 0.7);   // lichen
      stone = mix(stone, vec3(0.30, 0.36, 0.30), smoothstep(0.74, 0.80, noise(P * 4.1 + 31.0)) * near * 0.5);
      stone *= 1.0 - 0.6 * smoothstep(0.9, 0.98, crack) * near;
      stone *= mix(vec3(0.72, 0.62, 0.52), vec3(1.0), near);     // far off, weathered brown faces
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
      // Rabbitbrush among the sage, in patches, golden on top in flower.
      float gold = smoothstep(0.55, 0.6, noise(P * 0.13 + 77.0)) * uBloom.w * smoothstep(0.4, 0.75, clump) * smoothstep(0.4, 0.8, n.z);
      leaf = mix(leaf, vec3(0.80, 0.60, 0.10) * (0.6 + 0.5 * leaves), gold);
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
      vec3 deep = mix(vec3(0.012, 0.024, 0.021), vec3(0.021, 0.028, 0.016), kind);
      vec3 tip = mix(vec3(0.036, 0.068, 0.052), vec3(0.060, 0.080, 0.045), kind);
      vec3 tree = mix(deep, tip, smoothstep(0.3, 0.75, spray * 0.6 + needles * 0.4) * smoothstep(0.5, 1.05, cavity));
      alb = mix(alb, tree * (0.5 + 0.5 * near), cov.z);                     // far stands read dark
      ao = mix(ao, 0.35 + 0.65 * smoothstep(0.45, 1.05, cavity), cov.z);
      n = normalize(mix(n, n + vec3(spray - 0.5, needles - 0.5, 0.0) * 1.2 * near, cov.z));
    }
    // Far off, the trees in front of the slope, over a floor of shade and
    // litter that closes up where they stand thick; farther still (a pixel
    // wider than 3 m), their share of the view.
    float ft = 0.0;
    if (m.a > 0.5 && length(P) >= 750.0) {
      float share = clamp(2.0 * m.a - 1.0, 0.0, 1.0), across = t * pix, side, up;
      float rise = max(-dot(n.xy, hd) / max(n.z, 0.2) - e.z / max(length(e.xy), 1e-4), 0.03);
#if FARTREES
      ft = farTrees(P, hd, rise, share, across, side, up);
#else
      side = up = 0.0;
#endif
      ft = mix(ft, share * min(0.3 / rise, 0.9), smoothstep(3.0, 8.0, across));
      float kind = noise(P * 0.11 + 40.0);
      vec3 deep = mix(vec3(0.012, 0.024, 0.021), vec3(0.021, 0.028, 0.016), kind);
      vec3 tip = mix(vec3(0.036, 0.068, 0.052), vec3(0.060, 0.080, 0.045), kind);
      vec3 nt = normalize(vec3(-hd * sqrt(max(1.0 - side * side, 0.0)) + vec2(-hd.y, hd.x) * side, 0.3 + 0.5 * up));
      alb = mix(alb, deep + vec3(0.008, 0.006, 0.003), smoothstep(0.25, 0.85, clumpAt(P, share)) * 0.95);
      alb = mix(alb, mix(deep, tip, 0.3 + 0.5 * up) * 0.6, ft);
      n = normalize(mix(n, nt, ft));
      ao = mix(ao, 0.5 + 0.3 * up, ft);
    }
    // Snow: on the soil and the tops of things; the grass stands through
    // it (close by, where the ray met a blade; farther off, more of the
    // view the lower the ray), and trees and brush shed most of it.
    if (uSnow > 0.0) {
      float low = mix(0.75, 0.3, smoothstep(0.05, 0.5, -e.z / max(length(e.xy), 1e-4)));
      float stand = mix(low * grassy, 0.8 * smoothstep(0.35, 0.9, f), k) * (1.0 - onPad) * under(80.0, 400.0, p.z);   // up the hills it lies deeper
      float snow = snowAt(p, n, lod) * (1.0 - stand) * (1.0 - 0.6 * max(cov.z, ft)) * (1.0 - 0.5 * cov.y);
      alb = mix(alb, SNOW, snow);
      ao = mix(ao, 0.9, snow);
    }
    ao *= mix(1.0, min(cavity, 1.0), (1.0 - cov.z) * max(step(0.5, max(woody, rock)), 1.0 - near));   // hollows in brush and rock
    float sun = sunPast(p + n * (0.3 + 0.004 * t) + vec3(0.0, 0.0, GRASS * k * f)) * shade * lit;
    if (onPad > 0.0 || length(P - uArrayBox.xy) < 90.0) sun *= dishShade(P);
    c = litS(alb, n, sun, ao * (0.75 + 0.25 * n.z));
    float back = pow(max(dot(hd, normalize(uSun.xy + 1e-6)), 0.0), 3.0) * max(uSun.z + 0.05, 0.0);   // light through the blades
    c += curve(uSunLin * vec3(0.30, 0.25, 0.08) * back * (0.3 + sheen) * sun * grassy * smoothstep(0.2, 0.8, f)) * 0.5;
  }
  return aired(c, p, t, hd);
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
  float far;
  float hz = skyline(atan(e.x, e.y) / DEG, far);
  bool below = alt < hz;
  float tLand = -1.0;
#if LAND
  vec3 tree;
  bool onTree = false;
  if (uDome > 0.5 && uGround > 0.5 && alt < hz + 4.0) {
    // The march over the maps.  A near tree's outline is in them: where
    // the ray meets one, treeTrace has the tree itself, and through its
    // gaps the march goes on to what is behind (up to five trees deep;
    // after that, what is there is ground).  One loop, so that the march
    // and treeTrace are in the shader once: a compiler may write a short
    // loop round them out in full, and takes that many times as long.
    vec3 ro = vec3(0.0, 0.0, uEyeH);
    float t = 0.2, tPrev = 0.0, d = 9.0, tOut;
    float climb = e.z / max(length(e.xy), 1e-4);
    int pass = 0;
    bool done = false;
    for (int i = 0; i < 480; i++) {
      vec3 p = ro + e * t;
      vec4 m = mapTexel(p.xy);
      d = p.z - heightOf(m);
      if (d < 0.0) {
        float a = tPrev, b = t;
        for (int k = 0; k < 6; k++) {
          float mid = 0.5 * (a + b);
          vec3 q = ro + e * mid;
          if (q.z > mapH(q.xy)) a = mid; else b = mid;
        }
        tLand = 0.5 * (a + b);
#if TREES
        if (pass < 5) {
          float kind = treeTrace(ro, e, tLand, pix, tree, tOut);
          if (kind > 1.5) { pass++; tLand = -1.0; tPrev = tOut; t = tOut + 0.2; continue; }
          onTree = kind > 0.5;
        }
#endif
        done = true;
        break;
      }
      if (max(abs(p.x), abs(p.y)) > ${glf(MAPS[3] * 0.98)} || (climb > 0.05 && p.z > 45.0 + 0.2 * length(p.xy))) { done = true; break; }
      tPrev = t;
      float st = max(0.045 * t + 0.08, 0.5 * d);
      if (m.b > 0.01) st = min(st, max(max(5.4 * (1.0 - m.b), 0.5 * (d - 24.0)), min(0.4 * d, 0.7)));   // not past the nearest tree
      if (d < 3.0) st = min(st, 0.012 * t + 0.35);             // nor past boulders and brush, low down
      t += max(st, 0.003 * t + 0.1);
      if (t > 11000.0) { done = true; break; }
    }
    if (!done && d < 12.0) tLand = t;
    // Where the maps hold the terrain that sets the skyline, a ray that
    // misses it is in the sky.
    if (far < 0.5) below = false;
  }
  if (uDome > 0.5 && (!below || uGround < 0.5) && tLand < 0.0) {
    vec3 sky = skyAt(e);
    col = washed(col, sky);
    vec4 cl = cloudsAt(e, pix, sky + col * 0.3);
    col += cl.rgb + sky * (1.0 - cl.a);                        // radio waves pass through air and cloud
  }
#endif
  if (uBeamMode > 0 && tLand < 0.0) col += beam(e) * uBeamGain;
#if LAND
  if (tLand > 0.0) col = onTree ? tree : groundAt(e, tLand, pix);
  else
#endif
  if (below && uGround > 0.5) {
    if (uDome < 0.5) col *= 0.5;
#if LAND
    else col = hillsAt(e, alt, hz, pix);
#else
    else {
      // The plain ground: darker downward, with a band of haze along the
      // skyline (the same in every direction: below the skyline the
      // distance to the terrain is not known).
      float depth = clamp((hz - alt) / 35.0, 0.0, 1.0);
      vec3 g = mix(vec3(0.034, 0.042, 0.040), vec3(0.016, 0.020, 0.020), sqrt(depth));
      col = mix(g, vec3(0.06, 0.08, 0.11), 0.35 * exp(-(hz - alt) / 1.2));
    }
#endif
  }
  gl_FragColor = vec4(col, 1.0);
}
`;

/** Start building a program over the full-screen triangle (aPos at
 *  location 0).  The browser may compile it in the background; asking
 *  for its status (linked) waits for it. */
function start(gl, frag) {
  const prog = gl.createProgram(), shaders = [];
  for (const [type, src] of [[gl.VERTEX_SHADER, VERT], [gl.FRAGMENT_SHADER, frag]]) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    gl.attachShader(prog, sh);
    shaders.push(sh);
  }
  gl.bindAttribLocation(prog, 0, "aPos");
  gl.linkProgram(prog);
  return { prog, shaders };
}

/** A started program, linked, and its uniforms by name. */
function linked(gl, { prog, shaders }) {
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS))
    throw new Error(shaders.map((sh) => gl.getShaderInfoLog(sh)).join("") || gl.getProgramInfoLog(prog));
  const u = {};
  for (let i = 0, n = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS); i < n; i++) {
    const name = gl.getActiveUniform(prog, i).name;
    u[name] = gl.getUniformLocation(prog, name);
  }
  return { prog, u };
}
const link = (gl, frag) => linked(gl, start(gl, frag));

// Row-major 3x3 (astro.js) -> column-major for uniformMatrix3fv.
const glMat = (m) => new Float32Array([m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]]);

/** Parts of the Landscape that can be left out of its shader, to find
 *  what a slow compiler (Direct3D's, on Windows) is slow on, and to do
 *  without it there: the near trees in 3D; of those, the pines' limbs
 *  (a plain crown instead), the ground at a tree's foot, the ground
 *  under it, its shading samples, its shadow's shape; the flowers; the
 *  far trees. */
export const CUTS = { trees: "TREES", limbs: "LIMBS", foot: "FOOT", under: "UNDER", shade: "SHADE", bulk: "BULK", flowers: "FLOWERS", far: "FARTREES" };

/** The sky's fragment shader: land 1 with the Landscape, 0 without. */
export const fragment = (land, cut = []) =>
  `#define LAND ${land}\n${Object.entries(CUTS).map(([k, m]) => `#define ${m} ${cut.includes(k) ? 0 : 1}\n`).join("")}${FRAG}`;

/** The maps' fragment shader, for a sky shader with that cut. */
const mapFragment = (cut) => `#define TREES ${cut.includes("trees") ? 0 : 1}\n${MAP_FRAG}`;

/** Milliseconds to compile and link a fragment shader (blocking). */
export function compileMs(gl, frag) {
  const t0 = performance.now(), { prog } = linked(gl, start(gl, frag));
  gl.deleteProgram(prog);
  return performance.now() - t0;
}

export class SkyGL {
  /** Sunlight the cumulus lets through to the ground at P (m east, north of
   *  the observer): the shader's cloudShade(), for what is drawn outside it
   *  (the dishes).  sun: ENU unit vector; time, wind: as given to draw(). */
  cloudShade(P, sun, time, wind) {
    if (sun[2] < 0.02) return 1;
    const N = this.noise;
    const noise = (x, y) => {
      const ix = Math.floor(x), iy = Math.floor(y);
      let fx = x - ix, fy = y - iy;
      fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy);
      const at = (i, j) => N[(((j % 256) + 256) % 256 * 256 + ((i % 256) + 256) % 256) * 4] / 255;
      return (1 - fy) * ((1 - fx) * at(ix, iy) + fx * at(ix + 1, iy)) + fy * ((1 - fx) * at(ix, iy + 1) + fx * at(ix + 1, iy + 1));
    };
    const k = 2 / Math.max(sun[2], 0.08), qx = P[0] / 1000 + sun[0] * k, qy = P[1] / 1000 + sun[1] * k;
    const cover = 0.5 + 0.24 * (noise(qx * 0.02 + 40, qy * 0.02 + 40) - 0.5);
    let x = qx * 0.45 - wind[0] * time * 0.0027, y = qy * 0.45 - wind[1] * time * 0.0027, a = 0.5, s = 0, lod = 0.1;
    for (let o = 0; o < 6; o++) {                             // fbm(), as in the shader
      const w = Math.min(1, Math.max(0, 1.5 - 2 * lod));
      s += a * (0.5 + (noise(x, y) - 0.5) * w);
      [x, y] = [1.6 * x - 1.2 * y + 17, 1.2 * x + 1.6 * y + 17];
      lod *= 2; a *= 0.5;
    }
    const t = Math.min(1, Math.max(0, (s / 0.984 - cover) / 0.2));
    return 1 - 0.8 * t * t * (3 - 2 * t);
  }

  /** horizon: { alt: skyline altitude (deg) per azimuth step, from north
   *  through east; dist: distance (km) to the terrain that sets it, or
   *  null: all beyond the maps };  cut: parts of the Landscape left out
   *  of its shader (CUTS), or null: the near trees, unless this machine
   *  can take their compile (landProgram) */
  constructor(canvas, image, horizon, cut = null) {
    const gl = canvas.getContext("webgl", { antialias: false, premultipliedAlpha: false, preserveDrawingBuffer: true, powerPreference: "high-performance" });
    if (!gl) throw new Error("WebGL is not available");
    this.gl = gl;
    this.canvas = canvas;
    // The sky alone at once.  The Landscape's shaders are larger, and some
    // browsers take all compiles in turn, so theirs start only when the
    // Landscape is wanted and a first frame is out (landProgram).
    // onReady: called once the Landscape can be drawn.
    this.parallel = gl.getExtension("KHR_parallel_shader_compile");
    this.cut = cut;
    this.sky = link(gl, fragment(0, cut ?? []));
    this.onReady = null;
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
      const az = (i / hn) * 2 * Math.PI, edge = (MAPS[3] * 0.98) / Math.max(Math.abs(Math.sin(az)), Math.abs(Math.cos(az)));
      px.set([v >> 8, v & 255, !horizon.dist || horizon.dist[i] * 1000 > edge ? 255 : 0, 255], 4 * i);
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
    this.noise = noise;
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR],
      [gl.TEXTURE_WRAP_S, gl.REPEAT], [gl.TEXTURE_WRAP_T, gl.REPEAT]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
    gl.activeTexture(gl.TEXTURE0);
  }

  /** Bake the terrain into its height maps (MAPS), a strip at a time:
   *  each next() draws one strip and leaves the state as draw expects
   *  it, so frames can be drawn in between, with the maps there were;
   *  the last puts the new maps in their place.  job: the maps' program
   *  (start); t: { arrayBox, eyeH, terrain: the image terrain.png }. */
  *bake(job, t) {
    const { gl } = this, { prog, u } = linked(gl, job), fb = gl.createFramebuffer(), maps = [];
    const set = (tex) => {
      gl.bindTexture(gl.TEXTURE_2D, tex);
      for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR],
        [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
    };
    const dem = gl.createTexture();                          // on unit 0 while a strip is drawn
    set(dem);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, t.terrain);
    gl.bindTexture(gl.TEXTURE_2D, this.skyTex);
    gl.useProgram(prog);
    gl.uniform1i(u.uNoise, 3);
    gl.uniform1i(u.uDem, 0);
    gl.uniform4fv(u.uArrayBox, t.arrayBox);
    gl.uniform1f(u.uEyeH, t.eyeH);
    for (let i = 0; i < MAPS.length; i++) {
      const half = MAPS[i], n = MAP_NS[i], tex = gl.createTexture();
      maps.push(tex);
      set(tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, n, n, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.bindTexture(gl.TEXTURE_2D, this.skyTex);
      for (let y = 0; y < n; y += BAKE_ROWS) {
        gl.useProgram(prog);
        gl.bindTexture(gl.TEXTURE_2D, dem);
        gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
        gl.viewport(0, 0, n, n);
        gl.enable(gl.SCISSOR_TEST);
        gl.scissor(0, y, n, BAKE_ROWS);
        gl.uniform1f(u.uHalf, half);
        gl.uniform1f(u.uTexel, 2 * half / n);
        gl.uniform1f(u.uSize, n);
        gl.uniform2f(u.uSpan, MAP_H[i][0], MAP_H[i][1]);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        gl.readPixels(0, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));   // wait for it
        gl.disable(gl.SCISSOR_TEST);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.bindTexture(gl.TEXTURE_2D, this.skyTex);
        yield;
      }
    }
    gl.deleteFramebuffer(fb);
    gl.deleteProgram(prog);
    gl.deleteTexture(dem);
    for (const old of this.maps || []) gl.deleteTexture(old);
    this.maps = maps;
    maps.forEach((tex, i) => { gl.activeTexture(gl.TEXTURE4 + i); gl.bindTexture(gl.TEXTURE_2D, tex); });
    gl.activeTexture(gl.TEXTURE0);
  }

  /** The Landscape's program and uniforms, or null until it is ready (it
   *  then calls onReady) or if it failed.  The first call starts the
   *  work, after its frame is out: the compiles (this program and the
   *  maps'), in the background where the browser can
   *  (KHR_parallel_shader_compile), then the maps, a strip between
   *  frames; onStage is called with where that work is.  t: as for bake.
   *
   *  Where the cut is left to this class, the Landscape comes first
   *  without the near trees, the largest part of its shader and the
   *  slowest to draw.  How that went says whether they follow
   *  (moreTrees, for the caller to call with the time a frame of it
   *  took at 0.25 px per CSS px, if it has one): the frame under 8 ms,
   *  and the compile either quick (under 3 s; under 1 s with Direct3D's
   *  compiler, which takes 3.5 times as long over the trees: 3.9 s and
   *  13.5 s on the user's laptop) or in the background with the page
   *  kept going (no 50 ms tick over 0.4 s late).  With the trees
   *  compiled, onReady is called again. */
  landProgram(t) {
    if (this.land === undefined) {
      this.land = null;
      const { gl } = this;
      const done = (job) => !this.parallel || gl.getProgramParameter(job.prog, this.parallel.COMPLETION_STATUS_KHR);
      const fail = (err) => console.error(`The Landscape failed: ${err.message}`);
      let t0, land, strips, nStrip = 0, last, late = 0;
      const tick = () => { const now = performance.now(); late = Math.max(late, now - last - 50); last = now; };
      const trees = (frameMs) => {
        this.moreTrees = null;
        if (frameMs > 8) return;
        if (!(this.compileMs < (/Direct3D/.test(this.renderer()) ? 1000 : 3000) || (this.parallel && late < 400))) return;
        const t1 = performance.now(), job = start(gl, fragment(1, [])), mapJob = start(gl, mapFragment([]));
        const strip = () => {                               // the maps again, with the outlines the trees are traced in
          try {
            if (!strips.next().done) return setTimeout(strip, 0);
          } catch (err) { return fail(err); }
          this.treesMs = performance.now() - t1;
          this.land = land;
          this.onReady?.();
        };
        const poll = () => {
          this.onStage?.(`compiling the near trees, ${Math.round((performance.now() - t1) / 1000)} s`);
          if (!done(job) || !done(mapJob)) return setTimeout(poll, 50);
          try { land = linked(gl, job); } catch (err) { return fail(err); }
          strips = this.bake(mapJob, t);
          strip();
        };
        poll();
      };
      const strip = () => {
        try {
          this.onStage?.(`building the terrain, ${Math.round((100 * ++nStrip) / MAP_NS.reduce((a, n) => a + n / BAKE_ROWS, 0))} %`);
          if (!strips.next().done) return setTimeout(strip, 0);
        } catch (err) { return fail(err); }
        this.bakeMs = performance.now() - t0 - this.compileMs;
        this.land = land;
        if (!this.cut) this.moreTrees = trees;
        this.onReady?.();
      };
      const poll = () => {
        tick();
        this.onStage?.(`compiling its shaders, ${Math.round((performance.now() - t0) / 1000)} s`);
        if (!done(this.landJob) || !done(this.mapJob)) return setTimeout(poll, 50);
        try { land = linked(gl, this.landJob); } catch (err) { return fail(err); }
        this.compileMs = performance.now() - t0;
        strips = this.bake(this.mapJob, t);
        strip();
      };
      setTimeout(() => {
        t0 = last = performance.now();
        this.landJob = start(gl, fragment(1, this.cut ?? ["trees"]));
        this.mapJob = start(gl, mapFragment(this.cut ?? ["trees"]));
        poll();
      }, 150);
    }
    return this.land;
  }

  /** Wait until the GPU has drawn everything asked of it. */
  sync() { this.gl.readPixels(0, 0, 1, 1, this.gl.RGBA, this.gl.UNSIGNED_BYTE, new Uint8Array(4)); }

  /** The GPU's name, where the browser gives it. */
  renderer() {
    const x = this.gl.getExtension("WEBGL_debug_renderer_info");
    return this.gl.getParameter(x ? x.UNMASKED_RENDERER_WEBGL : this.gl.RENDERER);
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
   *       [east, north, half east, half north], sunOverHills (0 .. 1),
   *       season: { bloom: [4], green, snow } (app.js season) } */
  draw(p) {
    const { gl } = this, d = p.dpr, cam = p.cam;
    const land = p.land && this.landProgram(p);
    const { prog, u } = land || this.sky;                    // the sky alone until the Landscape's is compiled
    gl.useProgram(prog);
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
    gl.uniform1f(u.uTime, p.time);
    gl.uniform2fv(u.uWind, p.wind);
    gl.uniform1f(u.uEyeH, p.eyeH);
    gl.uniform4fv(u.uArrayBox, p.arrayBox);
    gl.uniform1f(u.uSunOverHills, p.sunOverHills);
    gl.uniform4fv(u.uBloom, p.season.bloom);
    gl.uniform1f(u.uGreen, p.season.green);
    gl.uniform1f(u.uSnow, p.season.snow);
    for (let i = 0; i < MAPS.length; i++) gl.uniform1i(u[`uMap${i}`], 4 + i);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
}
