// The drift trace: a model of the sky brightness the beam sees over the
// next day.  For each time step the beam centre is a point on the
// declination strip; the 408 MHz sky (sky.png) is averaged over the
// primary beam (Gaussian of the HPBW), scaled to each frequency of the
// band as T ~ f^-2.55 (the CMB held fixed) and averaged over the band.
// The quiet Sun is added on top, through the same main lobe (no
// sidelobes).  It is the total-power (autocorrelation) view of one dish,
// not of the array beam.

import * as A from "./astro.js";

const STEP_MIN = 5, BEFORE_H = 2, SPAN_H = 24, T_CMB = 2.725, BETA = -2.55;
const BAND_SAMPLES = 6, RINGS = 10, SPOKES = 20, LST_STEPS = 720;

// The quiet Sun: about 25 sfu at 400 MHz, rising as f^0.8 (typical quiet
// levels at the RSTN frequencies, 245-2695 MHz).  Active regions add a few
// times that; bursts, orders of magnitude.  1 sfu = 1e-22 W m^-2 Hz^-1.
export const SUN_SFU_400 = 25, SUN_INDEX = 0.8;
const BOLTZMANN = 1.380649e-23;

/** Antenna temperature (K) of the quiet Sun, offDeg from the centre of a
 *  Gaussian beam of half-power width hpbwDeg: T = S A_e / 2k, with the
 *  effective area lambda^2 / Omega of the same beam. */
export function sunKelvin(fMHz, hpbwDeg, offDeg) {
  const flux = SUN_SFU_400 * (fMHz / 400) ** SUN_INDEX * 1e-22;
  const lam = 299.792458 / fMHz, w = hpbwDeg * A.DEG;
  const omega = 1.1331 * w * w;                                  // Gaussian beam solid angle
  return ((flux * lam * lam) / (2 * BOLTZMANN * omega)) * Math.exp((-4 * Math.LN2 * offDeg * offDeg) / (hpbwDeg * hpbwDeg));
}

export class Trace {
  constructor(canvas, image, meta) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    const c = document.createElement("canvas");
    c.width = image.width; c.height = image.height;
    const g = c.getContext("2d", { willReadFrequently: true });
    g.drawImage(image, 0, 0);
    const rgba = g.getImageData(0, 0, c.width, c.height).data;
    this.w = c.width; this.h = c.height;
    this.temp = new Float32Array(this.w * this.h);
    for (let i = 0; i < this.temp.length; i++)
      this.temp[i] = 10 ** (meta.log10_t_lo + (rgba[4 * i] / 255) * (meta.log10_t_hi - meta.log10_t_lo));
    this.freq408 = meta.freq_mhz;
    this.key = "";
  }

  /** 408 MHz brightness (K) at a J2000 unit vector, bilinear. */
  t408(v) {
    const [ra, dec] = A.lonlat(v);
    const fx = (ra / 360) * this.w - 0.5, fy = Math.min(this.h - 1, Math.max(0, ((90 - dec) / 180) * this.h - 0.5));
    const x0 = Math.floor(fx), y0 = Math.floor(fy), ax = fx - x0, ay = fy - y0;
    const xa = (x0 + this.w) % this.w, xb = (x0 + 1) % this.w, ya = y0 * this.w, yb = Math.min(y0 + 1, this.h - 1) * this.w;
    const T = this.temp;
    return (1 - ay) * ((1 - ax) * T[ya + xa] + ax * T[ya + xb]) + ay * ((1 - ax) * T[yb + xa] + ax * T[yb + xb]);
  }

  /** Beam-averaged 408 MHz brightness about J2000 centre b for HPBW w (deg). */
  beamAverage(b, w) {
    const a = Math.abs(b[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
    const u = A.norm(A.cross(b, a)), q = A.cross(b, u);
    let sum = this.t408(b), wsum = 1;
    for (let j = 1; j <= RINGS; j++) {
      const r = ((j / RINGS) * 1.4 * w) * A.DEG, cr = Math.cos(r), sr = Math.sin(r);
      const wt = Math.exp((-4 * Math.LN2 * (r / A.DEG) ** 2) / (w * w)) * j;   // beam x ring area
      for (let k = 0; k < SPOKES; k++) {
        const t = (2 * Math.PI * (k + 0.5 * (j % 2))) / SPOKES, ct = Math.cos(t) * sr, st = Math.sin(t) * sr;
        sum += wt * this.t408([b[0] * cr + u[0] * ct + q[0] * st, b[1] * cr + u[1] * ct + q[1] * st, b[2] * cr + u[2] * ct + q[2] * st]);
        wsum += wt;
      }
    }
    return sum / wsum;
  }

  /** The model depends only on where the beam is on the sky, so it is a
   *  table over local sidereal time, rebuilt when the band, the pointing
   *  or the year changes; the window is then looked up in it. */
  update(ob, decBore, band, array) {
    const key = `${decBore.toFixed(3)}|${band[0]}|${band[1]}|${new Date(ob.ms).getUTCFullYear()}`;
    if (key !== this.key) {
      this.key = key;
      const PNt = A.transpose(ob.PN), freqs = A.bandSamples(band[0], band[1], band[1] - band[0] < 1 ? 1 : BAND_SAMPLES);
      this.table = new Float32Array(LST_STEPS + 1);
      for (let k = 0; k < LST_STEPS; k++) {
        const b = A.apply(PNt, A.vec((360 * k) / LST_STEPS, decBore));
        let T = 0;
        for (const f of freqs) T += (this.beamAverage(b, A.hpbwDeg(array, f)) - T_CMB) * (f / this.freq408) ** BETA + T_CMB;
        this.table[k] = T / freqs.length;
      }
      this.table[LST_STEPS] = this.table[0];
    }
    const t0 = Math.floor(ob.ms / (STEP_MIN * 60000)) * STEP_MIN * 60000 - BEFORE_H * 3600000;
    if (t0 === this.t0 && key === this.ptsKey) return;
    this.ptsKey = key;
    // The Sun moves about a degree a day: its offset from the beam is
    // worked out per step (its position every hour, linear between).
    const PNt = A.transpose(ob.PN), freqs = A.bandSamples(band[0], band[1], band[1] - band[0] < 1 ? 1 : BAND_SAMPLES);
    const sunAt = [];
    for (let h = 0; h <= SPAN_H + 1; h++) sunAt.push(A.sun(A.observer(t0 + h * 3600000, ob.site)).j2000);
    const n = (SPAN_H * 60) / STEP_MIN + 1, pts = [];
    for (let i = 0; i < n; i++) {
      const t = t0 + i * STEP_MIN * 60000;
      const last = ob.last + (360.98564736629 * (t - ob.ms)) / 86400000;
      const x = (A.mod360(last) / 360) * LST_STEPS;
      const k = Math.floor(x), a = x - k;
      const sky = (1 - a) * this.table[k] + a * this.table[k + 1];
      const hh = (t - t0) / 3600000, h0 = Math.floor(hh), f = hh - h0;
      const s = A.norm(sunAt[h0].map((c, j) => c + f * (sunAt[h0 + 1][j] - c)));
      const off = A.sepDeg(s, A.apply(PNt, A.vec(last, decBore)));
      let sun = 0;
      for (const fr of freqs) sun += sunKelvin(fr, A.hpbwDeg(array, fr), off);
      pts.push([t, sky, sun / freqs.length]);
    }
    this.t0 = t0;
    this.pts = pts;
  }

  /** marks: [{ ms, label, color }] drawn as ticks along the top. */
  draw({ dpr, x0, w, h, now, clock, marks }) {
    const { canvas, ctx } = this;
    const cw = Math.round(w * dpr), ch = Math.round(h * dpr);
    if (canvas.width !== cw || canvas.height !== ch) {
      canvas.width = cw; canvas.height = ch;
      canvas.style.width = `${w}px`; canvas.style.height = `${h}px`; canvas.style.left = `${x0}px`;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const font = getComputedStyle(document.documentElement).getPropertyValue("--font");
    const L = 46, R = 12, T = 26, B = 18, pw = w - L - R, ph = h - T - B;
    const t1 = this.t0 + SPAN_H * 3600000;
    const X = (t) => L + ((t - this.t0) / (t1 - this.t0)) * pw;
    const sky = this.pts.map((p) => p[1]), total = this.pts.map((p) => p[1] + p[2]);
    const lo = Math.min(...sky), hi = Math.max(...sky), peak = Math.max(...total);
    // When the Sun passes through the beam it outshines the sky many times
    // over: the axis turns logarithmic so the sky's own structure stays.
    const log = peak > 6 * hi;
    let Y, ticks;
    if (log) {
      const b = Math.log10(lo * 0.8), tp = Math.log10(peak * 1.3);
      Y = (v) => T + ph - ((Math.log10(Math.max(v, 1e-3)) - b) / (tp - b)) * ph;
      ticks = [];
      for (let d = Math.ceil(b); d <= tp; d++) ticks.push(10 ** d);
    } else {
      const top = niceCeil(hi * 1.08), bot = Math.max(0, niceFloor(lo * 0.9));
      Y = (v) => T + ph - ((v - bot) / (top - bot)) * ph;
      ticks = [bot, (bot + top) / 2, top];
    }
    const yBase = T + ph;

    ctx.font = `10px ${font}`;
    ctx.textBaseline = "middle";
    ctx.strokeStyle = "rgba(255,255,255,0.07)"; ctx.fillStyle = "rgba(160,170,190,0.8)";
    for (const v of ticks) {
      ctx.beginPath(); ctx.moveTo(L, Y(v)); ctx.lineTo(L + pw, Y(v)); ctx.stroke();
      ctx.textAlign = "right"; ctx.fillText(`${Math.round(v)} K`, L - 6, Y(v));
    }
    ctx.textAlign = "center"; ctx.textBaseline = "top";
    const hour = 3600000;
    for (let t = Math.ceil(this.t0 / hour) * hour; t <= t1; t += hour) {
      const x = X(t), lbl = clock(t), hh = parseInt(lbl, 10);
      ctx.strokeStyle = "rgba(255,255,255,0.06)";
      ctx.beginPath(); ctx.moveTo(x, T); ctx.lineTo(x, T + ph); ctx.stroke();
      if (hh % 3 === 0) ctx.fillText(lbl, x, T + ph + 4);
    }

    const g = ctx.createLinearGradient(0, T, 0, T + ph);
    g.addColorStop(0, "rgba(252,165,10,0.40)"); g.addColorStop(1, "rgba(66,10,104,0.10)");
    const first = X(this.pts[0][0]), last = X(this.pts[this.pts.length - 1][0]);
    ctx.beginPath(); ctx.moveTo(first, yBase);
    for (const [t, v] of this.pts) ctx.lineTo(X(t), Y(v));
    ctx.lineTo(last, yBase); ctx.closePath();
    ctx.fillStyle = g; ctx.fill();
    if (peak > hi * 1.01) {                                  // the Sun's share, above the sky
      ctx.beginPath();
      this.pts.forEach(([t, v, s], i) => (i ? ctx.lineTo(X(t), Y(v + s)) : ctx.moveTo(X(t), Y(v + s))));
      for (let i = this.pts.length - 1; i >= 0; i--) ctx.lineTo(X(this.pts[i][0]), Y(this.pts[i][1]));
      ctx.closePath();
      ctx.fillStyle = "rgba(255,224,138,0.55)"; ctx.fill();
    }
    ctx.beginPath();
    this.pts.forEach(([t, v, s], i) => (i ? ctx.lineTo(X(t), Y(v + s)) : ctx.moveTo(X(t), Y(v + s))));
    ctx.strokeStyle = "rgba(255,205,120,0.95)"; ctx.lineWidth = 1.4; ctx.stroke();

    ctx.textBaseline = "bottom"; ctx.textAlign = "center";
    const used = [];
    for (const m of marks.sort((a, b) => (b.prio ?? 0) - (a.prio ?? 0))) {
      if (m.ms < this.t0 || m.ms > t1) continue;
      const x = X(m.ms);
      ctx.strokeStyle = m.color; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, T - 3); ctx.lineTo(x, T + ph); ctx.globalAlpha = 0.35; ctx.stroke(); ctx.globalAlpha = 1;
      const tw = ctx.measureText(m.label).width;
      if (used.some(([a, b]) => x - tw / 2 < b && x + tw / 2 > a)) continue;
      used.push([x - tw / 2 - 4, x + tw / 2 + 4]);
      ctx.fillStyle = m.color; ctx.fillText(m.label, x, T - 4);
    }

    const xn = X(now);
    ctx.strokeStyle = "rgba(255,255,255,0.9)"; ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.moveTo(xn, T - 2); ctx.lineTo(xn, T + ph); ctx.stroke();
    ctx.fillStyle = "rgba(170,180,200,0.85)"; ctx.textAlign = "left"; ctx.textBaseline = "top";
    ctx.fillText(`Sky in the beam, model (one dish, band average, quiet Sun${log ? "; log scale" : ""})`, L, 3);
  }
}

function niceCeil(x) { const p = 10 ** Math.floor(Math.log10(x)); return Math.ceil(x / p) * p; }
function niceFloor(x) { if (x <= 0) return 0; const p = 10 ** Math.floor(Math.log10(x)); return Math.floor(x / p) * p; }
