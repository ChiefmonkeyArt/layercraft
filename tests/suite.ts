/**
 * Layercraft test pictures: real designs traced the way the app traces them, scored against the
 * photo or against the last accepted result. Run `npm run test:trace`; any change to the tracer or
 * to the built-in lessons must keep every picture passing.
 */
import { readFileSync, existsSync } from 'fs';
import { PNG } from 'pngjs';
import { trace } from '../src/trace';
import type { Pt } from '../src/geom';

const DIR = new URL('.', import.meta.url).pathname;
export const FIX = (f: string) => `${DIR}fixtures/${f}`;
export const BASE = (f: string) => `${DIR}baselines/${f}`;

export interface Img { w: number; h: number; data: Uint8ClampedArray }
export const loadPng = (f: string): Img => { const p = PNG.sync.read(readFileSync(FIX(f))); return { w: p.width, h: p.height, data: new Uint8ClampedArray(p.data.buffer, p.data.byteOffset, p.data.length) }; };

export interface Sheets { W: number; H: number; outline: Pt[]; openings: Pt[][][]; palette: string[]; order: number[] }
export interface Check { name: string; pass: boolean; value: string; limit: string }
export interface CaseResult { name: string; checks: Check[]; sheets: Sheets; ms: number }

// ---- raster helpers ----
/** even-odd fill of rings (mm, centred) at `s` px per mm into a w×h mask */
export function fill(rings: Pt[][], W: number, H: number, sx: number, sy: number, w: number, h: number): Uint8Array {
  const m = new Uint8Array(w * h);
  const xs: number[] = [];
  for (let y = 0; y < h; y++) {
    const yc = y + 0.5; xs.length = 0;
    for (const r of rings) for (let i = 0, n = r.length; i < n; i++) {
      const a = r[i], b = r[(i + 1) % n];
      const ay = (a[1] + H / 2) * sy, by = (b[1] + H / 2) * sy;
      if ((ay <= yc) !== (by <= yc)) { const ax = (a[0] + W / 2) * sx, bx = (b[0] + W / 2) * sx; xs.push(ax + ((yc - ay) / (by - ay)) * (bx - ax)); }
    }
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const x0 = Math.max(0, Math.ceil(xs[k] - 0.5)), x1 = Math.min(w - 1, Math.floor(xs[k + 1] - 0.5));
      for (let x = x0; x <= x1; x++) m[y * w + x] ^= 1;
    }
  }
  return m;
}
/** material of each sheet, top first (the bottom sheet is the whole outline) */
export function sheetMasks(s: Sheets, w: number, h: number): Uint8Array[] {
  const sx = w / s.W, sy = h / s.H, out: Uint8Array[] = [];
  for (const op of s.openings) out.push(fill([s.outline, ...op], s.W, s.H, sx, sy, w, h));
  out.push(fill([s.outline], s.W, s.H, sx, sy, w, h));
  return out;
}
const edgeOf = (m: Uint8Array, w: number, h: number) => {
  const e = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x; if (!m[i]) continue;
    if (x === 0 || y === 0 || x === w - 1 || y === h - 1 || !m[i - 1] || !m[i + 1] || !m[i - w] || !m[i + w]) e[i] = 1;
  }
  return e;
};
/** exact Euclidean distance to the nearest set pixel (Felzenszwalb & Huttenlocher) */
export function edt(src: Uint8Array, w: number, h: number): Float32Array {
  const INF = 1e12, f = new Float64Array(Math.max(w, h)), d = new Float64Array(Math.max(w, h)), v = new Int32Array(Math.max(w, h)), z = new Float64Array(Math.max(w, h) + 1);
  const g = new Float64Array(w * h);
  for (let i = 0; i < w * h; i++) g[i] = src[i] ? 0 : INF;
  const pass = (n: number, get: (i: number) => number, set: (i: number, x: number) => void) => {
    for (let i = 0; i < n; i++) f[i] = get(i);
    let k = 0; v[0] = 0; z[0] = -INF; z[1] = INF;
    for (let q = 1; q < n; q++) {
      let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      while (s <= z[k]) { k--; s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]); }
      k++; v[k] = q; z[k] = s; z[k + 1] = INF;
    }
    k = 0;
    for (let q = 0; q < n; q++) { while (z[k + 1] < q) k++; d[q] = (q - v[k]) * (q - v[k]) + f[v[k]]; }
    for (let i = 0; i < n; i++) set(i, d[i]);
  };
  for (let x = 0; x < w; x++) pass(h, (i) => g[i * w + x], (i, val) => { g[i * w + x] = val; });
  for (let y = 0; y < h; y++) pass(w, (i) => g[y * w + i], (i, val) => { g[y * w + i] = val; });
  const out = new Float32Array(w * h); for (let i = 0; i < w * h; i++) out[i] = Math.sqrt(g[i]); return out;
}
const pct = (a: number[], p: number) => { if (!a.length) return 0; const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]; };
const mean = (a: number[]) => a.reduce((t, v) => t + v, 0) / Math.max(1, a.length);

/**
 * How closely the top sheet's cut follows the photo's own edge: the photo edge is where whiteness
 * (the lowest of R, G, B) crosses halfway between the white face and the blue around it, found at
 * 4× with bilinear sampling. Returns distances in photo pixels both ways (ours→photo, photo→ours).
 */
export function letterEdgeError(photo: Img, s: Sheets, box: [number, number, number, number]) {
  const S = 4, { w, h, data } = photo, W4 = w * S, H4 = h * S;
  const wh = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) wh[i] = Math.min(data[4 * i], data[4 * i + 1], data[4 * i + 2]);
  // the white face and the blue around it, from the lettering area
  const hiV: number[] = [], loV: number[] = [];
  for (let y = 180; y < 700; y++) for (let x = 150; x < 720; x++) { const v = wh[y * w + x]; if (v > 170) hiV.push(v); else if (v < 90 && v > 3) loV.push(v); }
  const iso = (pct(hiV, 50) + pct(loV, 50)) / 2;
  const [bx0, by0, bx1, by1] = box.map((v) => v * S);
  const pm = new Uint8Array(W4 * H4);
  for (let Y = by0; Y < by1; Y++) for (let X = bx0; X < bx1; X++) {
    const fx = Math.min(w - 1.001, Math.max(0, (X + 0.5) / S - 0.5)), fy = Math.min(h - 1.001, Math.max(0, (Y + 0.5) / S - 0.5));
    const x0 = fx | 0, y0 = fy | 0, tx = fx - x0, ty = fy - y0, i = y0 * w + x0;
    const v = (wh[i] * (1 - tx) + wh[i + 1] * tx) * (1 - ty) + (wh[i + w] * (1 - tx) + wh[i + w + 1] * tx) * ty;
    pm[Y * W4 + X] = v > iso ? 1 : 0;
  }
  const top = sheetMasks({ ...s, openings: [s.openings[0]] }, W4, H4)[0];
  const inBox = (i: number) => { const x = i % W4, y = (i / W4) | 0; return x > bx0 && x < bx1 - 1 && y > by0 && y < by1 - 1; };
  const eo = edgeOf(top, W4, H4), ep = edgeOf(pm, W4, H4);
  for (let i = 0; i < W4 * H4; i++) { if (!inBox(i)) { eo[i] = 0; ep[i] = 0; } }
  const dP = edt(ep, W4, H4), dO = edt(eo, W4, H4);
  const a: number[] = [], b: number[] = [];
  for (let i = 0; i < W4 * H4; i++) { if (eo[i]) a.push(dP[i] / S); if (ep[i] && dO[i] / S < 8) b.push(dO[i] / S); }
  return { oursMean: mean(a), oursP95: pct(a, 95), photoMean: mean(b), photoP95: pct(b, 95) };
}

/** how much each sheet still matches the accepted result: shared area / combined area */
export function sheetMatch(a: Sheets, b: Sheets, w = 1200): number[] {
  const h = Math.round((w * a.H) / a.W), ma = sheetMasks(a, w, h), mb = sheetMasks(b, w, h), out: number[] = [];
  for (let k = 0; k < Math.max(ma.length, mb.length); k++) {
    const x = ma[k], y = mb[k]; if (!x || !y) { out.push(0); continue; }
    let i = 0, u = 0; for (let j = 0; j < x.length; j++) { if (x[j] & y[j]) i++; if (x[j] | y[j]) u++; }
    out.push(u ? i / u : 1);
  }
  return out;
}

const round = (s: Sheets): Sheets => {
  const r = (p: Pt[]) => p.map(([x, y]) => [Math.round(x * 100) / 100, Math.round(y * 100) / 100] as Pt);
  return { ...s, outline: r(s.outline), openings: s.openings.map((o) => o.map(r)) };
};
const run = (img: Img, opts: any, map?: Img): Sheets => {
  const out = trace(img, map ? { ...opts, depthMap: map } : opts);
  return round({ W: opts.widthMm, H: opts.heightMm, outline: out.outline!, openings: out.openings, palette: out.palette, order: out.order });
};
const hexD = (p: string, q: string) => { const a = parseInt(p.slice(1), 16), b = parseInt(q.slice(1), 16); return Math.hypot((a >> 16) - (b >> 16), ((a >> 8) & 255) - ((b >> 8) & 255), (a & 255) - (b & 255)); };
export const loadBase = (f: string): Sheets | null => (existsSync(BASE(f)) ? JSON.parse(readFileSync(BASE(f), 'utf8')) : null);

/** the limits: a change may only make these better (tighten them when the tracer improves) */
export const LIMITS = { letterMean: 0.40, letterP95: 1.05, photoMean: 0.45, photoP95: 1.15, sheetMatch: 0.99 };

const redrawOpts = (img: Img, colours: number) => ({ colours, smooth: 0.6, minPiece: 25, rib: 1.4, slot: 1.2, widthMm: 292, heightMm: (292 * img.h) / img.w, shape: 'rect', follow: true, rimMm: 4, merge: 11, fair: 1.2, darkFirst: true, depth: 'shapes' });

export interface Case { name: string; base: string; run: () => { sheets: Sheets; checks: Check[] } }
export const CASES: Case[] = [
  {
    name: 'FTFF photo + AI layer map', base: 'ftff-photo.json',
    run: () => {
      const photo = loadPng('ftff-photo.png'), map = loadPng('ftff-layer-map.png');
      const meta = JSON.parse(readFileSync(FIX('ftff-photo.opts.json'), 'utf8'));
      const sheets = run(photo, meta.opts, map);
      const cols = sheets.order.map((k) => sheets.palette[k]);
      const want = ['#f6f6f7', '#18619d', '#36ce6a', '#d8271c', '#f9116a', '#f28836', '#cfda3e', '#303f30']; // white, blue, green, red, pink, orange, lime, black
      const orderOk = cols.length === want.length && cols.every((c, i) => hexD(c, want[i]) < 60);
      const e = letterEdgeError(photo, sheets, [150, 180, 720, 700]);
      return { sheets, checks: [
        { name: 'sheets', pass: sheets.openings.length + 1 === 8, value: String(sheets.openings.length + 1), limit: '8' },
        { name: 'sheet order (white letters on top … black rim at the bottom)', pass: orderOk, value: cols.join(' '), limit: want.join(' ') },
        { name: 'letter cut → photo edge, mean px', pass: e.oursMean <= LIMITS.letterMean, value: e.oursMean.toFixed(3), limit: `≤ ${LIMITS.letterMean}` },
        { name: 'letter cut → photo edge, worst 5% px', pass: e.oursP95 <= LIMITS.letterP95, value: e.oursP95.toFixed(3), limit: `≤ ${LIMITS.letterP95}` },
        { name: 'photo edge → letter cut, mean px', pass: e.photoMean <= LIMITS.photoMean, value: e.photoMean.toFixed(3), limit: `≤ ${LIMITS.photoMean}` },
        { name: 'photo edge → letter cut, worst 5% px', pass: e.photoP95 <= LIMITS.photoP95, value: e.photoP95.toFixed(3), limit: `≤ ${LIMITS.photoP95}` },
      ] };
    },
  },
  ...([['FTFF flat redraw', 'ftff-redraw', 9], ['Daruma flat redraw', 'daruma-redraw', 8]] as const).map(([name, f, colours]): Case => ({
    name, base: `${f}.json`,
    run: () => {
      const img = loadPng(`${f}.png`), sheets = run(img, redrawOpts(img, colours)), base = loadBase(`${f}.json`);
      const checks: Check[] = [];
      if (!base) checks.push({ name: 'accepted result', pass: false, value: 'none yet', limit: 'run with --update once' });
      else {
        checks.push({ name: 'sheets', pass: sheets.openings.length === base.openings.length, value: String(sheets.openings.length + 1), limit: String(base.openings.length + 1) });
        const m = sheetMatch(sheets, base), lo = Math.min(...m);
        checks.push({ name: 'every sheet matches the accepted result', pass: lo >= LIMITS.sheetMatch, value: `lowest ${(lo * 100).toFixed(2)}%`, limit: `≥ ${LIMITS.sheetMatch * 100}%` });
        checks.push({ name: 'top sheet colour unchanged', pass: hexD(sheets.palette[sheets.order[0]], base.palette[base.order[0]]) < 40, value: sheets.palette[sheets.order[0]], limit: base.palette[base.order[0]] });
      }
      return { sheets, checks };
    },
  })),
];
