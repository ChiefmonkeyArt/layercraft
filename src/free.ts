// Free mode: hand-drawn outlines, flow strokes and scroll stems, with mirror symmetry.
// Everything here works on plain polylines (mm, centred at 0,0); the engine buffers
// the resulting lines into ribs and uses the outlines as the top-sheet window.
import type { Pt } from './geom';

export interface FreeArt { outlines: Pt[][]; flows: Pt[][]; scrolls: Pt[][] }
export type MirrorMode = 'off' | 'lr' | 'ud' | 'quad';
export const emptyFree = (): FreeArt => ({ outlines: [], flows: [], scrolls: [] });

export interface FreeSettings {
  freeMirror: MirrorMode; flowEchoes: number; flowSpacing: number;
  scrollSize: number; scrollGap: number; rib: number;
}

/** Chaikin corner cutting: turns wobbly finger strokes into smooth curves. */
export function smooth(l: Pt[], iters = 2, closed = false): Pt[] {
  let p = l;
  for (let k = 0; k < iters && p.length > 2; k++) {
    const o: Pt[] = closed ? [] : [p[0]];
    const n = p.length, m = closed ? n : n - 1;
    for (let i = 0; i < m; i++) {
      const a = p[i], b = p[(i + 1) % n];
      o.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25], [a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75]);
    }
    if (!closed) o.push(p[n - 1]);
    p = o;
  }
  return p;
}

/** Smooth curve from any stroke, whether dense (finger) or sparse (a few clicks). */
export function soften(l: Pt[], closed = false): Pt[] {
  const r = resample(closed ? [...l, l[0]] : l, 3);
  if (closed) r.pop();
  return smooth(r, 3, closed);
}

/** Even spacing along a polyline so offsets and curls behave. */
export function resample(l: Pt[], step: number): Pt[] {
  if (l.length < 2) return l.slice();
  const o: Pt[] = [l[0]];
  let carry = 0;
  for (let i = 1; i < l.length; i++) {
    const a = l[i - 1], b = l[i];
    const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
    let t = step - carry;
    while (t <= d) { o.push([a[0] + ((b[0] - a[0]) * t) / d, a[1] + ((b[1] - a[1]) * t) / d]); t += step; }
    carry = d - (t - step);
  }
  const last = l[l.length - 1], pl = o[o.length - 1];
  if (Math.hypot(last[0] - pl[0], last[1] - pl[1]) > step * 0.3) o.push(last);
  return o;
}

export function mirrorLines(lines: Pt[][], mode: MirrorMode): Pt[][] {
  if (mode === 'off') return lines;
  const out: Pt[][] = [...lines];
  const add = (fx: number, fy: number) => { for (const l of lines) out.push(l.map(([x, y]) => [x * fx, y * fy] as Pt)); };
  if (mode === 'lr' || mode === 'quad') add(-1, 1);
  if (mode === 'ud' || mode === 'quad') add(1, -1);
  if (mode === 'quad') add(-1, -1);
  return out;
}

const segDist = (p: Pt, a: Pt, b: Pt) => {
  const dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy;
  let t = L ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - a[0] - dx * t, p[1] - a[1] - dy * t);
};

/** A parallel copy of a line at distance d, with the folded parts of tight bends removed. */
export function offsetLine(l: Pt[], d: number): Pt[] {
  const n = l.length;
  if (n < 2) return [];
  const pts: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const a = l[Math.max(0, i - 1)], b = l[Math.min(n - 1, i + 1)];
    let tx = b[0] - a[0], ty = b[1] - a[1];
    const m = Math.hypot(tx, ty) || 1; tx /= m; ty /= m;
    pts.push([l[i][0] - ty * d, l[i][1] + tx * d]);
  }
  const lim = Math.abs(d) * 0.94;
  return pts.filter((p) => {
    for (let j = 1; j < n; j++) if (segDist(p, l[j - 1], l[j]) < lim) return false;
    return true;
  });
}

/** A flow stroke and its echoes on both sides: the swirling bands. */
export function flowLines(l: Pt[], echoes: number, spacing: number): Pt[][] {
  const base = resample(soften(l), Math.max(0.6, spacing / 4));
  const out: Pt[][] = [base];
  for (let k = 1; k <= echoes; k++) for (const sg of [1, -1]) {
    const o = offsetLine(base, sg * k * spacing);
    if (o.length > 2) out.push(o);
  }
  return out;
}

const hash = (a: number, b: number) => { let h = Math.imul(a * 2654435761 ^ b * 40503, 0x5bd1e995); h ^= h >>> 15; return (h >>> 0) / 4294967296; };

/** One curl: an arc that tightens as it goes, like the end of a fern or a carved scroll. */
export function curl(p: Pt, heading: number, turn: number, size: number): Pt[] {
  const L = size * 4, ds = Math.max(0.35, size / 45);
  const out: Pt[] = [p];
  let x = p[0], y = p[1], th = heading;
  for (let u = 0; u < L; u += ds) {
    th += (turn * (0.35 + (3.1 * u) / L) / size) * ds;
    x += Math.cos(th) * ds; y += Math.sin(th) * ds;
    out.push([x, y]);
  }
  return out;
}

/** A scroll stem: the stroke itself plus curls branching off alternate sides and one at the tip. */
export function scrollLines(l: Pt[], size: number, gap: number, seed = 0, startSide = 1): Pt[][] {
  const stem = resample(soften(l), 0.8);
  if (stem.length < 3) return [stem];
  const out: Pt[][] = [stem];
  const cum: number[] = [0];
  for (let i = 1; i < stem.length; i++) cum.push(cum[i - 1] + Math.hypot(stem[i][0] - stem[i - 1][0], stem[i][1] - stem[i - 1][1]));
  const total = cum[cum.length - 1];
  const tangent = (i: number) => {
    const a = stem[Math.max(0, i - 2)], b = stem[Math.min(stem.length - 1, i + 2)];
    return Math.atan2(b[1] - a[1], b[0] - a[0]);
  };
  let side = startSide, k = 0;
  for (let s = gap * 0.7; s < total - size * 0.8; s += gap, k++) {
    let i = 0;
    while (i < cum.length - 1 && cum[i] < s) i++;
    const sz = size * (0.85 + 0.3 * hash(seed + 7, k));
    // branch leaves the stem at an angle, then curls back the other way
    out.push(curl(stem[i], tangent(i) + side * 0.6, -side, sz));
    side = -side;
  }
  // a larger curl that carries on from the tip
  out.push(curl(stem[stem.length - 1], tangent(stem.length - 1), side, size * 1.25));
  return out;
}

/** All rib lines for Free mode, already mirrored. */
export function freeStrokes(s: FreeSettings, f: FreeArt | undefined): Pt[][] {
  if (!f) return [];
  const lines: Pt[][] = [];
  const sp = Math.max(s.flowSpacing, s.rib + 0.6);
  for (const l of f.flows) if (l.length > 1) lines.push(...flowLines(l, Math.round(s.flowEchoes), sp));
  f.scrolls.forEach((l, i) => { if (l.length > 1) lines.push(...scrollLines(l, s.scrollSize, Math.max(s.scrollGap, s.scrollSize * 0.6), i * 31)); });
  return mirrorLines(lines, s.freeMirror);
}

/** Outline windows for Free mode, smoothed, closed and mirrored. */
export function freeOutlines(s: FreeSettings, f: FreeArt | undefined): Pt[][] {
  if (!f) return [];
  const shapes = f.outlines.filter((l) => l.length > 2).map((l) => soften(l, true));
  return mirrorLines(shapes, s.freeMirror);
}

/** A starter design so Free mode never opens on a blank panel. */
export function exampleFree(w: number, h: number): FreeArt {
  const W = w / 2, H = h / 2;
  const P = (pts: [number, number][]) => pts.map(([x, y]) => [x * W, y * H] as Pt);
  // right half of a flame / wing shape; mirror left-right completes it
  const outline = P([[0, -0.86], [0.18, -0.7], [0.46, -0.78], [0.78, -0.6], [0.7, -0.3], [0.86, -0.02], [0.64, 0.2], [0.5, 0.48], [0.26, 0.62], [0.12, 0.84], [0, 0.9], [-0.02, 0.2], [-0.02, -0.5]]);
  const flows = [
    P([[0.04, -0.8], [0.22, -0.52], [0.5, -0.5], [0.62, -0.28], [0.44, -0.12], [0.3, -0.22], [0.36, -0.32]]),
    P([[0.04, 0.82], [0.2, 0.5], [0.42, 0.32], [0.62, 0.06], [0.5, -0.06], [0.4, 0.04]]),
  ];
  const scrolls = [P([[0.02, -0.1], [0.12, 0.06], [0.2, 0.24], [0.16, 0.4]])];
  return { outlines: [outline], flows, scrolls };
}
