// Frame corners: scrollwork in the corners of a rectangular panel, like carved frame
// decoration. A curved divider separates the main design from the corner zones; each
// zone gets rings of C-scrolls that curl at their tips, mirrored into all four corners.
import type { Pt } from './geom';
import { curl, flowLines, mirrorLines, resample } from './free';

export interface CornerSettings {
  shape: string; width: number; height: number; border: number; rib: number;
  corners: boolean; cornerSize: number; cornerRings: number; cornerGap: number; cornerCurl: number; cornerBars: boolean;
}

export const cornersOn = (s: CornerSettings) => !!s.corners && s.shape === 'rect';
/** Divider size: the ellipse (x/a)^2 + (y/b)^2 = k^2; k = 1 touches the middle of each edge. */
export const dividerK = (s: CornerSettings) => 1.35 - 0.5 * Math.max(0, Math.min(1, s.cornerSize));
const half = (s: CornerSettings) => ({ a: s.width / 2 - s.border, b: s.height / 2 - s.border });

/** True if a point (mm) lies inside the divider, where the main design lives. */
export function insideDivider(s: CornerSettings, p: Pt, pad = 0): boolean {
  const { a, b } = half(s), k = dividerK(s);
  return Math.hypot(p[0] / a, p[1] / b) < k - pad;
}

/** The corner zones as one closed shape set: the inner panel minus the divider (for Free mode windows). */
export function dividerEllipse(s: CornerSettings): Pt[] {
  const { a, b } = half(s);
  return ellipse(a, b, dividerK(s)).slice(0, -1);
}

/** Keep only the parts of each line where keep() holds, splitting lines as needed. */
export function clipLines(lines: Pt[][], keep: (p: Pt) => boolean, step = 1): Pt[][] {
  const out: Pt[][] = [];
  for (const l0 of lines) {
    if (l0.length < 2) continue;
    const l = resample(l0, step);
    let cur: Pt[] = [];
    for (const p of l) {
      if (keep(p)) cur.push(p);
      else { if (cur.length > 1) out.push(cur); cur = []; }
    }
    if (cur.length > 1) out.push(cur);
  }
  return out;
}

function ellipse(a: number, b: number, k: number): Pt[] {
  const n = 360, o: Pt[] = [];
  for (let i = 0; i <= n; i++) { const t = (i / n) * Math.PI * 2; o.push([a * k * Math.cos(t), b * k * Math.sin(t)]); }
  return o;
}

/** All rib lines for the corner decoration, already mirrored into the four corners. */
export function cornerStrokes(s: CornerSettings): Pt[][] {
  if (!cornersOn(s)) return [];
  const { a, b } = half(s);
  const k = dividerK(s), m = Math.min(a, b);
  const sp = Math.max(s.cornerGap, s.rib + 1.4);
  const k2 = k + (s.rib * 2 + 1.6) / m;                       // second line of the divider band
  const lines: Pt[][] = [ellipse(a, b, k), ellipse(a, b, k2)];
  const inZone = (p: Pt) => Math.hypot(p[0] / a, p[1] / b) > k2;
  const quarter: Pt[][] = [];
  // one sweeping scroll per edge: it runs along the middle of the corner zone from the
  // diagonal towards the middle of the edge, then rolls up into a spiral
  for (const swap of [false, true]) {
    const B = swap ? a : b;                                 // across-edge half size
    const map = (u: number, v: number): Pt => (swap ? [v * a, -u * b] : [u * a, -v * b]);
    const vd = (u: number) => (u < k2 ? Math.sqrt(k2 * k2 - u * u) : 0);
    const vm = (u: number) => (vd(u) + 1) / 2;
    const thick = (u: number) => (1 - vd(u)) * B;           // zone thickness in mm at this point
    // where the zone's midline meets the diagonal (u = v in panel units)
    let us = 0.8;
    for (let i = 0; i < 60; i++) us = 0.5 * (us + vm(us));
    const curlMax = s.cornerCurl;
    let ue = us;
    while (ue > 0.02 && thick(ue - 0.01) > Math.min(curlMax, thick(us)) * 1.6) ue -= 0.01;
    if (us - ue < 0.06) ue = Math.max(0.02, us - 0.06);
    const stem: Pt[] = [];
    for (let i = 0; i <= 60; i++) { const u = us - ((us - ue) * i) / 60; stem.push(map(u, vm(u))); }
    const size = Math.max(4, Math.min(curlMax, thick(ue) * 0.42));
    const e = stem[stem.length - 1], q = stem[stem.length - 4];
    const hd = Math.atan2(e[1] - q[1], e[0] - q[0]);
    // roll the spiral whichever way stays inside the corner zone
    const pick = [1, -1].map((t) => curl(e, hd, t, size)).map((c) => ({ c, n: c.filter((p) => inZone(p) && Math.abs(p[0]) < a && Math.abs(p[1]) < b).length }));
    const tip = pick[0].n >= pick[1].n ? pick[0].c : pick[1].c;
    const path = [...stem, ...tip.slice(1)];
    quarter.push(...flowLines(path, Math.round(s.cornerRings), sp));
  }
  const bars: Pt[][] = [];
  const mapTR = (u: number, v: number): Pt => [u * a, -v * b];
  if (s.cornerBars) {
    // diagonal bar from the divider to the frame corner ties everything to the frame
    bars.push([mapTR(k * Math.SQRT1_2, k * Math.SQRT1_2), mapTR(1.02, 1.02)]);
    if (k < 1) for (const [u, v] of [[1, 0], [0, 1]]) bars.push([mapTR(u * k, v * k), mapTR(u * 1.02, v * 1.02)]);
  }
  // a small ring in the corner itself
  const rc = m * 0.06;
  const [cx, cy] = mapTR(1 - (rc * 1.9) / a, 1 - (rc * 1.9) / b);
  if (Math.hypot(cx / a, cy / b) > k2 + (rc * 1.5) / m) {
    const c: Pt[] = [];
    for (let i = 0; i <= 48; i++) { const t = (i / 48) * Math.PI * 2; c.push([cx + rc * Math.cos(t), cy + rc * Math.sin(t)]); }
    bars.push(c);
  }
  // keep scrolls in the corner zones, off the main design
  const zone = clipLines(quarter, inZone);
  return [...lines, ...mirrorLines([...zone, ...bars], 'quad')];
}
