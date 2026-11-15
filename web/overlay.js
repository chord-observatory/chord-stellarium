// Lines, markers and labels drawn over the sky on a 2D canvas.  Everything
// is a J2000 unit vector until project() puts it on the screen.

import {
  DEG, ICRS_TO_GAL, ECL_TO_ICRS, apply, transpose, vec, cross, norm, dot,
  enuFromAltaz, enuFromHaDec, hpbwDeg,
} from "./astro.js";
import { project, copies, maxJump } from "./proj.js";

const GAL_TO_ICRS = transpose(ICRS_TO_GAL);
const SIDEREAL_DEG_PER_HOUR = 15.0410686;

export const COLORS = {
  eqGrid: "rgba(150,175,225,0.20)",
  altazGrid: "rgba(130,205,165,0.20)",
  galGrid: "rgba(225,165,125,0.20)",
  galPlane: "rgba(225,165,125,0.42)",
  ecliptic: "rgba(240,205,110,0.42)",
  horizon: "rgba(150,220,175,0.75)",
  constellation: "rgba(150,170,215,0.30)",
  conName: "rgba(165,180,220,0.50)",
  source: "rgba(255,180,110,0.80)",
  calibrator: "#ffd479",
  pulsar: "#7fdfff",
  dump: "#ff86d8",
  strip: "rgba(255,255,255,0.55)",
  stripEdge: "rgba(255,255,255,0.22)",
  tick: "rgba(255,255,255,0.70)",
  label: "rgba(225,232,245,0.88)",
  dim: "rgba(190,200,220,0.55)",
  sun: "#ffe08a",
  select: "#ffffff",
};

// Tints for the band edges, matching skygl.js's bandTint at s = 0 and 1.
export const LOW_TINT = "rgb(255,92,74)", HIGH_TINT = "rgb(196,92,255)";

// ---- geometry helpers ----

/** Points on a small circle of radius rDeg about unit vector c. */
export function smallCircle(c, rDeg, n = 96) {
  const a = Math.abs(c[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const u = norm(cross(c, a)), w = cross(c, u);
  const cr = Math.cos(rDeg * DEG), sr = Math.sin(rDeg * DEG), out = [];
  for (let i = 0; i <= n; i++) {
    const t = (2 * Math.PI * i) / n, ct = Math.cos(t) * sr, st = Math.sin(t) * sr;
    out.push([c[0] * cr + u[0] * ct + w[0] * st, c[1] * cr + u[1] * ct + w[1] * st, c[2] * cr + u[2] * ct + w[2] * st]);
  }
  return out;
}

const range = (a, b, step) => { const o = []; for (let x = a; x <= b + 1e-9; x += step) o.push(x); return o; };

// ---- labels ----

class Labels {
  constructor(w, h) { this.w = w; this.h = h; this.items = []; this.boxes = []; }
  add(text, x, y, o = {}) { this.items.push({ text, x, y, prio: o.prio ?? 0, color: o.color ?? COLORS.label, font: o.font ?? "11px var(--font)", gap: o.gap ?? 6, center: o.center }); }
  free(b) {
    if (b.x0 < 2 || b.y0 < 2 || b.x1 > this.w - 2 || b.y1 > this.h - 2) return false;
    for (const o of this.boxes) if (b.x0 < o.x1 && b.x1 > o.x0 && b.y0 < o.y1 && b.y1 > o.y0) return false;
    return true;
  }
  draw(ctx) {
    this.items.sort((a, b) => b.prio - a.prio);
    ctx.textBaseline = "middle";
    for (const it of this.items) {
      ctx.font = it.font.replace("var(--font)", FONT);
      const tw = ctx.measureText(it.text).width, th = parseFloat(it.font.match(/([\d.]+)px/)[1]) + 2, g = it.gap;
      const tries = it.center ? [[-tw / 2, 0]] : [[g, 0], [-g - tw, 0], [-tw / 2, -th / 2 - g], [-tw / 2, th / 2 + g]];
      for (const [dx, dy] of tries) {
        const b = { x0: it.x + dx - 2, x1: it.x + dx + tw + 2, y0: it.y + dy - th / 2, y1: it.y + dy + th / 2 };
        if (!this.free(b)) continue;
        this.boxes.push(b);
        ctx.fillStyle = "rgba(4,7,16,0.55)";
        ctx.fillText(it.text, it.x + dx + 0.7, it.y + dy + 0.7);
        ctx.fillStyle = it.color;
        ctx.fillText(it.text, it.x + dx, it.y + dy);
        break;
      }
    }
  }
}

let FONT = "system-ui, sans-serif";
export const setFont = (f) => { FONT = f; };

// ---- the overlay ----

export class Overlay {
  constructor(canvas) { this.canvas = canvas; this.ctx = canvas.getContext("2d"); }

  /** Draw everything for scene S; returns { hits, pulsars } for picking and blinking. */
  draw(S) {
    const { ctx } = this, { cam, dpr } = S;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cam.w, cam.h);
    this.S = S;
    // In the ground and dome views, the terrain hides what is below the skyline.
    const T = S.ob.toEnu;
    this.hidden = S.dome ? (v) => {
      const e = apply(T, v);
      if (e[2] > 0.25) return false;                        // above every hill: skip the lookup
      return Math.asin(Math.max(-1, e[2])) / DEG < S.skyline(Math.atan2(e[0], e[1]) / DEG) - 0.05;
    } : () => false;
    this.hits = [];
    this.blink = [];
    this.labels = new Labels(cam.w, cam.h);
    const L = S.layers, zoom = S.zoom;

    if (L.grid_eq) this.gridEq();
    if (L.grid_gal) this.gridGal();
    if (L.grid_altaz) this.gridAltaz();
    if (L.ecliptic) this.ecliptic();
    if (L.constellations) this.constellations();
    if (L.stars) this.stars();
    if (L.horizon) this.horizon();
    if (L.strip) this.strip();
    if (L.sources) this.sources();
    if (L.pulsars) this.pulsars();
    if (L.dumps) this.dumps();
    if (L.sunmoon) this.sunMoon();
    if (L.beam || L.strip) this.beamOutline();
    if (S.selected) this.selection(S.selected);
    if (L.labels) this.labels.draw(ctx);
    return { hits: this.hits, pulsars: this.blink, zoom };
  }

  // Polyline through J2000 points, broken at wraps and where points do not show.
  line(points, style, width = 1, dash = null) {
    const { ctx } = this, cam = this.S.cam, jump = maxJump(cam) * cam.s;
    ctx.strokeStyle = style;
    ctx.lineWidth = width;
    ctx.setLineDash(dash || []);
    const scr = points.map((v) => (this.hidden(v) ? null : project(cam, v)));
    for (const dx of copies(cam)) {
      ctx.beginPath();
      let prev = null;
      for (const p of scr) {
        if (!p) { prev = null; continue; }
        if (prev && Math.hypot(p[0] - prev[0], p[1] - prev[1]) < jump) ctx.lineTo(p[0] + dx, p[1]);
        else ctx.moveTo(p[0] + dx, p[1]);
        prev = p;
      }
      ctx.stroke();
    }
    ctx.setLineDash([]);
  }

  // Calls fn(x, y) at each on-screen copy of a J2000 point.
  at(v, fn, margin = 20, always = false) {
    if (!always && this.hidden(v)) return;
    const cam = this.S.cam, p = project(cam, v);
    if (!p) return;
    for (const dx of copies(cam)) {
      const x = p[0] + dx, y = p[1];
      if (x > -margin && x < cam.w + margin && y > -margin && y < cam.h + margin) fn(x, y);
    }
  }

  hit(x, y, r, obj) { this.hits.push({ x, y, r: Math.max(r, 7), obj }); }

  gridEq() {
    const z = this.S.zoom, ra = z > 3 ? 15 : 30, dec = z > 3 ? 10 : 30;
    for (const r of range(0, 360 - ra, ra)) this.line(range(-80, 80, 2).map((d) => vec(r, d)), COLORS.eqGrid);
    for (const d of range(-90 + dec, 90 - dec, dec)) this.line(range(0, 360, 2).map((r) => vec(r, d)), d === 0 ? "rgba(150,175,225,0.38)" : COLORS.eqGrid);
    if (this.S.layers.labels) {
      for (const r of range(0, 360 - ra, ra)) this.at(vec(r, 0), (x, y) => this.labels.add(`${Math.round(r / 15)}h`, x, y, { prio: 2, color: "rgba(160,185,235,0.65)", font: "10px var(--font)", center: true }));
      for (const d of range(-60, 60, 30)) if (d) this.at(vec(this.S.lon0Label, d), (x, y) => this.labels.add(`${d > 0 ? "+" : ""}${d}°`, x, y, { prio: 2, color: "rgba(160,185,235,0.65)", font: "10px var(--font)" }));
    }
  }

  gridGal() {
    for (const l of range(0, 330, 30)) this.line(range(-80, 80, 2).map((b) => apply(GAL_TO_ICRS, vec(l, b))), COLORS.galGrid);
    for (const b of [-60, -30, 30, 60]) this.line(range(0, 360, 2).map((l) => apply(GAL_TO_ICRS, vec(l, b))), COLORS.galGrid);
    this.line(range(0, 360, 1).map((l) => apply(GAL_TO_ICRS, vec(l, 0))), COLORS.galPlane, 1.2);
    if (this.S.layers.labels) this.at(apply(GAL_TO_ICRS, vec(0, 0)), (x, y) => this.labels.add("Galactic centre", x, y, { prio: 6, color: "rgba(235,180,140,0.8)" }));
  }

  gridAltaz() {
    const F = this.S.ob.fromEnu, en = (az, alt) => apply(F, enuFromAltaz(az, alt));
    for (const alt of [15, 30, 45, 60, 75]) this.line(range(0, 360, 2).map((az) => en(az, alt)), COLORS.altazGrid);
    for (const az of range(0, 330, 30)) this.line(range(0, 88, 2).map((alt) => en(az, alt)), COLORS.altazGrid);
  }

  // The terrain skyline, with compass points (and, in the ground view,
  // azimuth ticks) just below it.
  horizon() {
    const S = this.S, F = S.ob.fromEnu, en = (az, alt) => apply(F, enuFromAltaz(az, alt));
    const sky = range(0, 360, 0.5).map((az) => en(az, S.skyline(az)));
    if (S.dome) this.line(sky, "rgba(150,220,175,0.12)", 5);
    this.line(sky, COLORS.horizon, 1.3);
    const below = S.dome ? -3.2 : 2;
    const points = [[0, "N"], [45, "NE"], [90, "E"], [135, "SE"], [180, "S"], [225, "SW"], [270, "W"], [315, "NW"]];
    for (const [az, t] of points) {
      const major = t.length === 1;
      this.at(en(az, S.skyline(az) + below), (x, y) => this.labels.add(t, x, y, {
        prio: major ? 90 : 40, center: true,
        color: major ? COLORS.horizon : "rgba(150,220,175,0.6)", font: major ? "600 14px var(--font)" : "600 11px var(--font)",
      }), 20, true);
    }
    if (S.ground) {
      const c = this.ctx;
      c.strokeStyle = "rgba(150,220,175,0.45)"; c.lineWidth = 1;
      for (const az of range(0, 355, 5)) {
        const hz = S.skyline(az), a = project(S.cam, en(az, hz)), b = project(S.cam, en(az, hz - (az % 15 ? 0.6 : 1.2)));
        if (!a || !b) continue;
        c.beginPath(); c.moveTo(a[0], a[1]); c.lineTo(b[0], b[1]); c.stroke();
        if (az % 45 && az % 15 === 0 && S.layers.labels)
          this.at(en(az, hz - 2.4), (x, y) => this.labels.add(`${az}°`, x, y, { prio: 30, center: true, color: "rgba(150,220,175,0.55)", font: "10px var(--font)" }), 20, true);
      }
    }
    this.at(en(0, 90), (x, y) => {
      const c = this.ctx;
      c.strokeStyle = "rgba(150,220,175,0.5)"; c.lineWidth = 1;
      c.beginPath(); c.moveTo(x - 5, y); c.lineTo(x + 5, y); c.moveTo(x, y - 5); c.lineTo(x, y + 5); c.stroke();
      this.labels.add("zenith", x, y, { prio: 3, color: "rgba(150,220,175,0.6)", font: "10px var(--font)" });
    });
  }

  ecliptic() {
    this.line(range(0, 360, 1).map((l) => apply(ECL_TO_ICRS, vec(l, 0))), COLORS.ecliptic, 1, [5, 4]);
    const c = this.ctx;
    for (const m of this.S.sunMonths) {
      this.at(m.v, (x, y) => {
        c.fillStyle = COLORS.ecliptic;
        c.beginPath(); c.arc(x, y, 2.2, 0, 2 * Math.PI); c.fill();
        this.labels.add(m.label, x, y, { prio: 4, color: "rgba(240,205,110,0.75)", font: "10px var(--font)" });
      });
    }
  }

  constellations() {
    for (const seg of this.S.data.conLines) this.line(seg, COLORS.constellation, 0.8);
    if (this.S.layers.labels && this.S.zoom > 0.9)
      for (const c of this.S.data.conNames)
        this.at(c.v, (x, y) => this.labels.add(c.name, x, y, { prio: 1, color: COLORS.conName, font: "italic 10px var(--font)", center: true }));
  }

  stars() {
    const { ctx } = this, S = this.S, z = S.zoom;
    const magLim = Math.min(6, 4.6 + 1.3 * Math.log2(Math.max(z, 0.5)));
    const fade = S.dome ? 1 - 0.85 * S.day : 1;
    if (fade < 0.05) return;
    const grow = 1 + 0.18 * Math.log2(Math.max(z, 1));
    for (const s of S.data.stars) {
      if (s.mag > magLim) break;                          // sorted by magnitude
      this.at(s.v, (x, y) => {
        const r = (0.5 + 0.38 * (magLim - s.mag)) * grow;
        const a = Math.min(1, 0.3 + 0.16 * (magLim - s.mag)) * fade;
        ctx.fillStyle = `rgba(${s.rgb[0]},${s.rgb[1]},${s.rgb[2]},${a.toFixed(3)})`;
        ctx.beginPath(); ctx.arc(x, y, r, 0, 2 * Math.PI); ctx.fill();
        if (s.name) {
          this.hit(x, y, r + 3, s.obj);
          if (S.layers.labels) this.labels.add(s.name, x, y, { prio: 5 - s.mag, color: `rgba(215,220,240,${(0.65 * fade).toFixed(2)})`, font: "10px var(--font)" });
        }
      }, 4);
    }
  }

  sources() {
    const { ctx } = this, S = this.S, z = S.zoom;
    for (const s of S.data.sources3c) {
      this.at(s.v, (x, y) => {
        const r = 2 + 1.3 * Math.log10(s.s178 / 10);
        ctx.strokeStyle = COLORS.source; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.arc(x, y, r, 0, 2 * Math.PI); ctx.stroke();
        this.hit(x, y, r + 2, s.obj);
        if (S.layers.labels && s.s178 * z * z > 45) this.labels.add(s.name, x, y, { prio: 10 + Math.log10(s.s178), color: "rgba(255,200,150,0.85)", font: "10px var(--font)" });
      });
    }
    for (const s of S.data.calibrators) {
      this.at(s.v, (x, y) => {
        ctx.strokeStyle = COLORS.calibrator; ctx.lineWidth = 1.4;
        ctx.beginPath(); ctx.arc(x, y, 6, 0, 2 * Math.PI);
        for (const [a, b] of [[8, 12]]) {
          ctx.moveTo(x + a, y); ctx.lineTo(x + b, y); ctx.moveTo(x - a, y); ctx.lineTo(x - b, y);
          ctx.moveTo(x, y + a); ctx.lineTo(x, y + b); ctx.moveTo(x, y - a); ctx.lineTo(x, y - b);
        }
        ctx.stroke();
        this.hit(x, y, 10, s.obj);
        if (S.layers.labels) this.labels.add(s.name, x, y, { prio: 100, color: COLORS.calibrator, font: "600 12px var(--font)", gap: 13 });
      });
    }
  }

  pulsars() {
    const { ctx } = this, S = this.S, z = S.zoom, min = 25 / (z * z);
    for (const p of S.data.pulsars) {
      if (!p.highlight && p.flux < min) continue;
      this.at(p.v, (x, y) => {
        const r = p.highlight ? 4 : 1.8 + 0.7 * Math.log10(Math.max(p.flux, 1));
        ctx.strokeStyle = p.highlight ? COLORS.pulsar : "rgba(127,223,255,0.55)"; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(x - r, y); ctx.lineTo(x + r, y); ctx.moveTo(x, y - r); ctx.lineTo(x, y + r); ctx.stroke();
        if (p.highlight || p.flux >= 40) this.blink.push({ x, y, r, p0: p.p0 });
        this.hit(x, y, r + 2, p.obj);
        if (S.layers.labels && (p.highlight || p.flux * z * z > 400))
          this.labels.add(p.name, x, y, { prio: p.highlight ? 60 : 8 + Math.log10(p.flux), color: p.highlight ? COLORS.pulsar : "rgba(127,223,255,0.7)", font: p.highlight ? "11px var(--font)" : "10px var(--font)" });
      });
    }
  }

  dumps() {
    const { ctx } = this, S = this.S;
    for (const d of S.data.dumps) {
      this.at(d.v, (x, y) => {
        ctx.strokeStyle = COLORS.dump; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(x, y - 7); ctx.lineTo(x + 7, y); ctx.lineTo(x, y + 7); ctx.lineTo(x - 7, y); ctx.closePath(); ctx.stroke();
        this.hit(x, y, 9, d.obj);
        if (S.layers.labels) this.labels.add(d.label, x, y, { prio: 70, color: COLORS.dump, gap: 11 });
      });
    }
  }

  sunMoon() {
    const { ctx } = this, S = this.S, cam = S.cam;
    const radiusPx = (deg) => Math.max(deg * DEG * cam.s, 0);
    this.at(S.sun.j2000, (x, y) => {
      const r = Math.max(radiusPx(0.267), 5);
      const g = ctx.createRadialGradient(x, y, r * 0.6, x, y, r * 4);
      g.addColorStop(0, "rgba(255,224,138,0.55)"); g.addColorStop(1, "rgba(255,224,138,0)");
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r * 4, 0, 2 * Math.PI); ctx.fill();
      ctx.fillStyle = COLORS.sun; ctx.beginPath(); ctx.arc(x, y, r, 0, 2 * Math.PI); ctx.fill();
      this.hit(x, y, r + 3, S.sunObj);
      if (S.layers.labels) this.labels.add("Sun", x, y, { prio: 95, color: COLORS.sun, font: "600 12px var(--font)", gap: r + 5 });
    });
    // Direction of the Sun from the Moon on screen: a short step toward it.
    const m = S.moon.j2000, sm = dot(S.sun.j2000, m);
    const p0 = project(cam, m), q = project(cam, norm(m.map((c, k) => c + 0.01 * (S.sun.j2000[k] - sm * c))));
    const ang = p0 && q ? Math.atan2(q[1] - p0[1], q[0] - p0[0]) : 0;
    this.at(m, (x, y) => {
      const r = Math.max(radiusPx(0.259), 5.5);
      drawMoon(ctx, x, y, r, S.phase.phaseDeg, ang);
      this.hit(x, y, r + 3, S.moonObj);
      if (S.layers.labels) this.labels.add("Moon", x, y, { prio: 94, color: "rgba(230,232,240,0.9)", font: "600 12px var(--font)", gap: r + 5 });
    });
  }

  // The drift strip: the beam centre's declination circle, its half-power
  // edges at both ends of the band, and hour ticks where the beam will be.
  strip() {
    const S = this.S, ob = S.ob, dec = S.decBore, F = ob.fromEnu;
    const circle = (d) => range(-180, 180, 1).map((ha) => apply(F, enuFromHaDec(ob, ha, d)));
    this.line(circle(dec), COLORS.strip, 1.1);
    const [lo, hi] = S.band, wLo = hpbwDeg(S.array, lo) / 2, wHi = hpbwDeg(S.array, hi) / 2;
    for (const sgn of [-1, 1]) {
      this.line(circle(dec + sgn * wLo), LOW_TINT.replace("rgb", "rgba").replace(")", ",0.45)"), 1, [3, 4]);
      if (hi - lo >= 1) this.line(circle(dec + sgn * wHi), HIGH_TINT.replace("rgb", "rgba").replace(")", ",0.45)"), 1, [3, 4]);
    }
    // Ticks at whole local hours: the sky now at hour angle -15.04 deg per
    // hour is at the beam that many hours from now.
    const { ctx } = this, step = S.zoom > 2.5 ? 1 : 2, hour = 3600000;
    const first = Math.ceil((ob.ms + 60000) / hour) * hour;
    for (let k = 0; k < 24; k++) {
      const t = first + k * hour, lbl = S.clock(t), major = parseInt(lbl, 10) % step === 0;
      const v = apply(F, enuFromHaDec(ob, (-SIDEREAL_DEG_PER_HOUR * (t - ob.ms)) / hour, dec));
      this.at(v, (x, y) => {
        ctx.fillStyle = COLORS.tick;
        ctx.beginPath(); ctx.arc(x, y, major ? 2.4 : 1.4, 0, 2 * Math.PI); ctx.fill();
        if (S.layers.labels && major) this.labels.add(lbl, x, y, { prio: 20 - k / 2, color: "rgba(235,240,250,0.75)", font: "10px var(--font)" });
      });
    }
  }

  beamOutline() {
    const S = this.S, [lo, hi] = S.band;
    const ring = (f, color) => this.line(smallCircle(S.boreJ2000, hpbwDeg(S.array, f) / 2), color, 1.3);
    if (hi - lo < 1) ring(lo, "rgba(255,255,255,0.85)");
    else { ring(lo, LOW_TINT); ring(hi, HIGH_TINT); }
    this.at(S.boreJ2000, (x, y) => {
      const c = this.ctx;
      c.strokeStyle = "rgba(255,255,255,0.9)"; c.lineWidth = 1;
      c.beginPath(); c.moveTo(x - 4, y); c.lineTo(x + 4, y); c.moveTo(x, y - 4); c.lineTo(x, y + 4); c.stroke();
      if (S.layers.labels) this.labels.add("beam now", x, y, { prio: 98, color: "rgba(255,255,255,0.9)", font: "600 11px var(--font)", gap: 8 });
    });
  }

  selection(obj) {
    if (!obj.v) return;
    this.at(obj.v, (x, y) => {
      const c = this.ctx;
      c.strokeStyle = COLORS.select; c.lineWidth = 1.2; c.setLineDash([3, 3]);
      c.beginPath(); c.arc(x, y, 14, 0, 2 * Math.PI); c.stroke(); c.setLineDash([]);
    });
  }
}

/** The Moon's disc with its phase: lit side toward screen angle ang (radians). */
function drawMoon(ctx, x, y, r, phaseDeg, ang) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(ang);
  ctx.fillStyle = "rgba(40,44,56,0.9)";
  ctx.beginPath(); ctx.arc(0, 0, r, 0, 2 * Math.PI); ctx.fill();
  const k = Math.cos(phaseDeg * DEG), rx = Math.abs(k) * r;
  ctx.fillStyle = "#e9e6dc";
  ctx.beginPath();
  ctx.arc(0, 0, r, -Math.PI / 2, Math.PI / 2, false);     // the lit half, toward +x
  ctx.ellipse(0, 0, Math.max(rx, 0.01), r, 0, Math.PI / 2, -Math.PI / 2, k < 0); // the terminator
  ctx.fill();
  ctx.restore();
}

/** Blink the pulsars on the effects canvas: a flash once per period (the
 *  fastest held at a steady glow).  nowS: page time in seconds. */
export function drawPulsarBlink(ctx, list, nowS, dpr, w, h, reduced) {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  for (const p of list) {
    let a;
    if (reduced || p.p0 < 0.12) a = 0.35;
    else {
      const ph = (nowS / p.p0) % 1;
      a = Math.exp(-((Math.min(ph, 1 - ph) / Math.min(0.08, 0.05 / p.p0 + 0.02)) ** 2));
    }
    if (a < 0.02) continue;
    const R = p.r * 2.4;
    const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, R);
    g.addColorStop(0, `rgba(200,248,255,${(0.8 * a).toFixed(3)})`);
    g.addColorStop(1, "rgba(127,223,255,0)");
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(p.x, p.y, R, 0, 2 * Math.PI); ctx.fill();
  }
}
