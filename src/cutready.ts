/**
 * Cut-ready AI pictures.
 *  1. plan:  the app chooses the exact colours, one per sheet, back to top, before the AI draws
 *  2. snap:  every pixel becomes one of those colours (soft edges split at their midpoint, specks gone)
 *  3. check: thin necks and strands, tiny bits, missing or merged sheets, colours that were not asked for
 *  4. fix:   small problems are fixed here; big ones become a precise note for the AI to redraw
 * Pure functions on RGBA pixels, so they run the same in the browser and in tests.
 */
import { hex, hexRgb, lab } from './trace';

export interface Img { w: number; h: number; data: Uint8ClampedArray }
export const BG = '#ffffff';

// ---------------- 1. planned colours ----------------
const lin = (c: number) => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
const gam = (c: number) => 255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
function toOk(hx: string): [number, number, number] {
  const [r, g, b] = hexRgb(hx).map(lin);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b), m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b), s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}
function okRgb(L: number, a: number, b: number): [number, number, number] {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3, m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3, s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
}
/** OKLCH to #rrggbb, lowering the chroma until the colour can be shown */
function lch(L: number, C: number, H: number): string {
  for (let c = C; c >= 0; c -= 0.005) {
    const rgb = okRgb(L, c * Math.cos((H * Math.PI) / 180), c * Math.sin((H * Math.PI) / 180));
    if (rgb.every((v) => v >= -0.001 && v <= 1.001)) return hex(...(rgb.map((v) => gam(Math.max(0, Math.min(1, v)))) as [number, number, number]));
  }
  return hex(...(okRgb(L, 0, 0).map((v) => gam(Math.max(0, Math.min(1, v)))) as [number, number, number]));
}
/** gradients from the back sheet (dark) to the top (light); the top stays clearly off-white */
export const RAMPS: Record<string, { label: string; stops: [number, number, number][] }> = {
  sunset: { label: 'Sunset', stops: [[0.3, 0.13, 290], [0.46, 0.2, 340], [0.62, 0.2, 28], [0.77, 0.16, 62], [0.9, 0.14, 98]] },
  ocean: { label: 'Ocean', stops: [[0.28, 0.09, 268], [0.44, 0.13, 250], [0.6, 0.12, 222], [0.76, 0.11, 195], [0.9, 0.08, 175]] },
  forest: { label: 'Forest', stops: [[0.28, 0.06, 155], [0.44, 0.11, 148], [0.6, 0.14, 135], [0.76, 0.15, 118], [0.9, 0.12, 102]] },
  fire: { label: 'Fire', stops: [[0.3, 0.11, 18], [0.47, 0.19, 27], [0.63, 0.19, 44], [0.78, 0.16, 70], [0.91, 0.13, 98]] },
  rainbow: { label: 'Rainbow', stops: [[0.32, 0.14, 300], [0.45, 0.15, 255], [0.6, 0.15, 180], [0.72, 0.17, 140], [0.82, 0.17, 95], [0.72, 0.18, 55], [0.62, 0.22, 25]] },
  wood: { label: 'Wood tones', stops: [[0.28, 0.04, 50], [0.45, 0.07, 55], [0.62, 0.08, 65], [0.77, 0.07, 75], [0.9, 0.05, 85]] },
};
export function rampPalette(n: number, ramp = 'sunset'): string[] {
  const st = (RAMPS[ramp] ?? RAMPS.sunset).stops, out: string[] = [];
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 1 : (i / (n - 1)) * (st.length - 1), k = Math.min(st.length - 2, Math.floor(t)), f = t - k, a = st[k], b = st[k + 1];
    let dh = b[2] - a[2]; if (dh > 180) dh -= 360; if (dh < -180) dh += 360;
    out.push(lch(a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + dh * f));
  }
  return out;
}
/** the user's own colours, spread over n sheets: darkest at the back, blended in between */
export function blendPalette(cols: string[], n: number): string[] {
  const ok = cols.map(toOk).sort((p, q) => p[0] - q[0]);
  if (!ok.length) return rampPalette(n);
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? ok.length - 1 : (i / (n - 1)) * (ok.length - 1), k = Math.min(ok.length - 1, Math.floor(t)), f = t - k, a = ok[k], b = ok[Math.min(ok.length - 1, k + 1)];
    const rgb = okRgb(a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f);
    out.push(hex(...(rgb.map((v) => gam(Math.max(0, Math.min(1, v)))) as [number, number, number])));
  }
  // keep neighbours apart: nudge lightness where two came out nearly the same
  for (let i = 1; i < out.length; i++) if (dE(out[i], out[i - 1]) < 9) { const [L, a, b] = toOk(out[i]); const rgb = okRgb(Math.min(0.95, L + 0.06), a, b); out[i] = hex(...(rgb.map((v) => gam(Math.max(0, Math.min(1, v)))) as [number, number, number])); }
  return out;
}
/** "teal, coral and gold" → hex colours (parse is the browser's CSS colour reader) */
export function parseColourList(text: string, parse: (s: string) => string | null): string[] {
  return text.split(/,|;|\/|\band\b|\n/i).map((s) => s.trim()).filter(Boolean).map(parse).filter((v): v is string => !!v);
}
/** a plain colour name, to help the AI read the hex code */
export function colourName(hx: string): string {
  const [L, a, b] = toOk(hx), C = Math.hypot(a, b), H = ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360;
  const tone = L < 0.38 ? 'deep ' : L < 0.55 ? 'dark ' : L > 0.86 ? 'pale ' : L > 0.72 ? 'light ' : '';
  if (C < 0.03) return L < 0.3 ? 'near black' : L > 0.9 ? 'off-white' : `${tone}grey`.trim();
  const names: [number, string][] = [[20, 'crimson'], [40, 'red'], [60, 'orange'], [80, 'amber'], [105, 'yellow'], [130, 'lime'], [160, 'green'], [190, 'teal'], [225, 'cyan blue'], [265, 'blue'], [295, 'indigo'], [325, 'purple'], [350, 'magenta'], [361, 'pink']];
  return `${tone}${(names.find(([h]) => H < h) ?? names[0])[1]}`;
}
export const dE = (p: string, q: string) => { const a = lab(...hexRgb(p)), b = lab(...hexRgb(q)); return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]); };

/** no plan: the picture's own main colours, darkest at the back. White is kept as a level too (white
 *  inside the design, like lettering, stays white; white reaching the edge is still background) */
export function planFromPicture(found: { hex: string; share: number }[], levels: number): string[] {
  return found.slice(0, Math.max(2, levels + 1)).map((f) => f.hex).filter((c, i, all) => all.findIndex((d) => dE(c, d) < 15) === i)
    .slice(0, Math.max(2, levels)).sort((p, q) => toOk(p)[0] - toOk(q)[0]);
}

// ---------------- 2. snap to the plan ----------------
const LIN = new Float32Array(256).map((_, c) => lin(c));
const cb = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
/** the same Lab as the tracer, with a lookup table for speed */
function fastLab(r: number, g: number, b: number, out: Float32Array, o: number) {
  const R = LIN[r], G = LIN[g], B = LIN[b];
  const X = cb((R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047), Y = cb(R * 0.2126 + G * 0.7152 + B * 0.0722), Z = cb((R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883);
  out[o] = 116 * Y - 16; out[o + 1] = 500 * (X - Y); out[o + 2] = 200 * (Y - Z);
}
/** distance (px) from every pixel to the nearest set pixel: two-pass 5-7-11 chamfer, within ~2% of exact */
export function chamfer(feature: Uint8Array, w: number, h: number): Float32Array {
  const P = w + 4, H = h + 4, d = new Float32Array(P * H).fill(1e9);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (feature[y * w + x]) d[(y + 2) * P + x + 2] = 0;
  const A = 1, B = 1.4, C = 2.2; // the 5-7-11 mask in pixels
  const a1 = -1, b1 = -P - 1, a2 = -P, b2 = -P + 1, c1 = -P - 2, c2 = -2 * P - 1, c3 = -2 * P + 1, c4 = -P + 2;
  for (let y = 2; y < h + 2; y++) for (let x = 2, i = y * P + 2; x < w + 2; x++, i++) {
    let v = d[i]; if (v === 0) continue;
    let t = d[i + a1] + A; if (t < v) v = t; t = d[i + a2] + A; if (t < v) v = t;
    t = d[i + b1] + B; if (t < v) v = t; t = d[i + b2] + B; if (t < v) v = t;
    t = d[i + c1] + C; if (t < v) v = t; t = d[i + c2] + C; if (t < v) v = t; t = d[i + c3] + C; if (t < v) v = t; t = d[i + c4] + C; if (t < v) v = t;
    d[i] = v;
  }
  for (let y = h + 1; y >= 2; y--) for (let x = w + 1, i = y * P + w + 1; x >= 2; x--, i--) {
    let v = d[i]; if (v === 0) continue;
    let t = d[i - a1] + A; if (t < v) v = t; t = d[i - a2] + A; if (t < v) v = t;
    t = d[i - b1] + B; if (t < v) v = t; t = d[i - b2] + B; if (t < v) v = t;
    t = d[i - c1] + C; if (t < v) v = t; t = d[i - c2] + C; if (t < v) v = t; t = d[i - c3] + C; if (t < v) v = t; t = d[i - c4] + C; if (t < v) v = t;
    d[i] = v;
  }
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) out.set(d.subarray((y + 2) * P + 2, (y + 2) * P + 2 + w), y * w);
  return out;
}
export interface Snap { w: number; h: number; labels: Int16Array; cols: string[]; unknown: number; art: number }
/** labels: -1 background, 0 … n-1 sheet levels from the back */
export function snapToPlan(img: Img, plan: string[], bg = BG): Snap {
  const { w, h, data } = img, N = w * h, n = plan.length;
  const P = new Float32Array(N * 3), alpha = new Uint8Array(N);
  for (let i = 0; i < N; i++) { fastLab(data[4 * i], data[4 * i + 1], data[4 * i + 2], P, 3 * i); alpha[i] = data[4 * i + 3] > 8 ? 1 : 0; }
  const planned = [bg, ...plan].map((x) => lab(...hexRgb(x)));
  const C = planned.map((c) => c.slice());
  const lbl = new Int16Array(N), dist = new Float32Array(N);
  const assign = () => {
    for (let i = 0; i < N; i++) {
      if (!alpha[i]) { lbl[i] = 0; dist[i] = 0; continue; }
      let best = 0, bd = 1e9;
      for (let k = 0; k < C.length; k++) { const d = (P[3 * i] - C[k][0]) ** 2 + (P[3 * i + 1] - C[k][1]) ** 2 + (P[3 * i + 2] - C[k][2]) ** 2; if (d < bd) { bd = d; best = k; } }
      lbl[i] = best; dist[i] = Math.sqrt(bd);
    }
  };
  // the AI never hits the codes exactly: let each colour settle on what was really drawn, close to the plan
  for (let it = 0; it < 5; it++) {
    assign();
    const S = C.map(() => [0, 0, 0, 0]);
    for (let i = 0; i < N; i++) if (alpha[i] && dist[i] < 18) { const s = S[lbl[i]]; s[0] += P[3 * i]; s[1] += P[3 * i + 1]; s[2] += P[3 * i + 2]; s[3]++; }
    S.forEach((s, k) => {
      if (k === 0 || s[3] < 20) return;
      const m = [s[0] / s[3], s[1] / s[3], s[2] / s[3]];
      if (Math.hypot(m[0] - planned[k][0], m[1] - planned[k][1], m[2] - planned[k][2]) < 32) C[k] = m;
    });
  }
  assign();
  // soft edges: a pixel between two colours goes to whichever confident neighbour it is closer to,
  // which splits the blend at its midpoint instead of inventing a third colour along the edge
  const conf = (i: number) => dist[i] < 9;
  // a sheet as white as the background (white lettering): decided by where it is, not by its shade
  const bgLike = C.map((c, k) => k === 0 || Math.hypot(c[0] - C[0][0], c[1] - C[0][1], c[2] - C[0][2]) < 8);
  const whiteSheet = bgLike.findIndex((v, k) => v && k > 0);
  const out = new Int16Array(N);
  let unknown = 0, art = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (!alpha[i]) { out[i] = -1; continue; }
    if (conf(i)) { out[i] = bgLike[lbl[i]] ? -1 : lbl[i] - 1; continue; }
    let best = -2, bd = 1e9;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const X = x + dx, Y = y + dy; if (X < 0 || Y < 0 || X >= w || Y >= h) continue;
      const j = Y * w + X; if (!alpha[j] || !conf(j)) continue;
      const k = lbl[j], d = (P[3 * i] - C[k][0]) ** 2 + (P[3 * i + 1] - C[k][1]) ** 2 + (P[3 * i + 2] - C[k][2]) ** 2;
      if (d < bd) { bd = d; best = k; }
    }
    if (best === -2) { best = lbl[i]; if (dist[i] > 22) unknown++; }
    out[i] = bgLike[best] ? -1 : best - 1;
  }
  // the background is only what reaches the picture's edge; white inside the design joins its nearest sheet
  const outside = flood(out, w, h, (v) => v === -1);
  for (let i = 0; i < N; i++) {
    if (out[i] === -1 && !outside[i] && whiteSheet > 0) { out[i] = whiteSheet - 1; }
    else if (out[i] === -1 && !outside[i]) {
      let best = 0, bd = 1e9;
      for (let k = 1; k < C.length; k++) { const d = (P[3 * i] - C[k][0]) ** 2 + (P[3 * i + 1] - C[k][1]) ** 2 + (P[3 * i + 2] - C[k][2]) ** 2; if (d < bd) { bd = d; best = k; } }
      out[i] = best - 1; unknown++;
    }
    if (out[i] >= 0) art++;
  }
  const cols = C.slice(1).map((c, k) => (plan[k] && Math.hypot(c[0] - planned[k + 1][0], c[1] - planned[k + 1][1], c[2] - planned[k + 1][2]) < 0.5 ? plan[k] : labHex(c)));
  return { w, h, labels: out, cols, unknown: art ? unknown / art : 0, art };
}
function labHex(c: number[]): string {
  // Lab → sRGB (D65)
  const fy = (c[0] + 16) / 116, fx = fy + c[1] / 500, fz = fy - c[2] / 200;
  const inv = (t: number) => (t ** 3 > 0.008856 ? t ** 3 : (t - 16 / 116) / 7.787);
  const X = inv(fx) * 0.95047, Y = inv(fy), Z = inv(fz) * 1.08883;
  const r = 3.2406 * X - 1.5372 * Y - 0.4986 * Z, g = -0.9689 * X + 1.8758 * Y + 0.0415 * Z, b = 0.0557 * X - 0.204 * Y + 1.057 * Z;
  return hex(gam(Math.max(0, Math.min(1, r))), gam(Math.max(0, Math.min(1, g))), gam(Math.max(0, Math.min(1, b))));
}
/** pixels matching `pick` that connect to the picture's edge */
function flood(lbl: Int16Array, w: number, h: number, pick: (v: number) => boolean): Uint8Array {
  const seen = new Uint8Array(w * h), st: number[] = [];
  const push = (i: number) => { if (!seen[i] && pick(lbl[i])) { seen[i] = 1; st.push(i); } };
  for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
  while (st.length) { const i = st.pop()!, x = i % w; if (x > 0) push(i - 1); if (x < w - 1) push(i + 1); if (i >= w) push(i - w); if (i < w * (h - 1)) push(i + w); }
  return seen;
}
/** connected areas of one colour (4-neighbour): id per pixel, size and bounding box of each */
function same(L: Int16Array, w: number, h: number): { id: Int32Array; size: number[]; box: number[][] } {
  const id = new Int32Array(w * h).fill(-1), size: number[] = [], box: number[][] = [], st: number[] = [];
  for (let s = 0; s < w * h; s++) {
    if (id[s] >= 0) continue;
    const k = size.length, v = L[s]; size.push(0); box.push([w, h, 0, 0]); id[s] = k; st.push(s);
    while (st.length) {
      const i = st.pop()!, x = i % w, y = (i / w) | 0, b = box[k]; size[k]++;
      if (x < b[0]) b[0] = x; if (y < b[1]) b[1] = y; if (x > b[2]) b[2] = x; if (y > b[3]) b[3] = y;
      if (x > 0 && id[i - 1] < 0 && L[i - 1] === v) { id[i - 1] = k; st.push(i - 1); }
      if (x < w - 1 && id[i + 1] < 0 && L[i + 1] === v) { id[i + 1] = k; st.push(i + 1); }
      if (y > 0 && id[i - w] < 0 && L[i - w] === v) { id[i - w] = k; st.push(i - w); }
      if (y < h - 1 && id[i + w] < 0 && L[i + w] === v) { id[i + w] = k; st.push(i + w); }
    }
  }
  return { id, size, box };
}
/** connected parts of a mask (8-neighbour): id per pixel (0 = not in mask), and each part's size */
function parts(m: Uint8Array, w: number, h: number): { id: Int32Array; size: number[] } {
  const id = new Int32Array(w * h), size = [0], st: number[] = [];
  for (let s = 0; s < w * h; s++) {
    if (!m[s] || id[s]) continue;
    const k = size.length; size.push(0); id[s] = k; st.push(s);
    while (st.length) {
      const i = st.pop()!, x = i % w, y = (i / w) | 0; size[k]++;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const X = x + dx, Y = y + dy; if (X < 0 || Y < 0 || X >= w || Y >= h) continue;
        const j = Y * w + X; if (m[j] && !id[j]) { id[j] = k; st.push(j); }
      }
    }
  }
  return { id, size };
}

// ---------------- 3 + 4. check and fix ----------------
export interface Spot { x: number; y: number; r: number; kind: 'fixed' | 'thin' | 'gap' }
export interface CutReport {
  ready: boolean;          // nothing left that needs the AI
  specks: number;          // tiny bits removed
  thickened: number;       // thin necks and strands made strong enough to cut
  missing: number[];       // planned sheets the AI left out (levels from the back)
  absent: number[];        // colours from the picture that ended up unused (not a problem)
  merged: [number, number][]; // planned sheets the AI drew in the same colour
  unknown: number;         // share of the design in colours that were not asked for
  pieces: number[];        // loose pieces per sheet above the back
  spots: Spot[];           // where things were fixed or need a look (pixels)
}
export interface CutOpts { mmPerPx: number; rib: number; speckMm2?: number; optional?: boolean } // optional: the colours came from the picture, so an absent one is not a problem

export function checkAndFix(s: Snap, o: CutOpts): { labels: Int16Array; report: CutReport } {
  const { w, h } = s, N = w * h, n = s.cols.length, L = s.labels.slice();
  const spots: Spot[] = [];
  // tiny compact bits of any colour (including background specks inside the design) join what
  // surrounds them; long thin fragments are kept, they are part of a line
  const speckPx = Math.max(6, Math.round((o.speckMm2 ?? 2) / (o.mmPerPx * o.mmPerPx)));
  const { id, size, box } = same(L, w, h);
  const votes = new Map<number, Map<number, number>>();
  for (let i = 0; i < N; i++) {
    const c = id[i]; if (size[c] >= speckPx) continue;
    const b = box[c]; if (Math.max(b[2] - b[0], b[3] - b[1]) + 1 > 2.5 * Math.sqrt(speckPx)) continue;
    const x = i % w, y = (i / w) | 0;
    for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1]) {
      if (j < 0 || id[j] === c) continue;
      const t = votes.get(c) ?? new Map<number, number>(); t.set(L[j], (t.get(L[j]) ?? 0) + 1); votes.set(c, t);
    }
  }
  const to = new Map<number, number>();
  for (const [c, t] of votes) { let b = -9, bn = -1; for (const [v, cnt] of t) if (cnt > bn) { bn = cnt; b = v; } to.set(c, b); }
  for (let i = 0; i < N; i++) { const t = to.get(id[i]); if (t !== undefined) L[i] = t; }
  const specks = to.size;
  // thin necks and strands: each sheet's material must be at least `rib` wide to survive cutting.
  // Pointed tips are left alone (they taper by design, and the laser cuts what it can).
  const r = o.rib / 2 / o.mmPerPx;
  let thickened = 0;
  const pieces: number[] = [];
  const pad = Math.ceil(2 * r) + 3;
  for (let k = n - 1; k >= 0 && r >= 1; k--) {
    // work only around this sheet's material
    let bx0 = w, by0 = h, bx1 = -1, by1 = -1;
    for (let y = 0; y < h; y++) for (let x = 0, i = y * w; x < w; x++, i++) if (L[i] >= k) { if (x < bx0) bx0 = x; if (x > bx1) bx1 = x; if (y < by0) by0 = y; if (y > by1) by1 = y; }
    if (bx1 < 0) { if (k >= 1) pieces.unshift(0); continue; }
    bx0 = Math.max(0, bx0 - pad); by0 = Math.max(0, by0 - pad); bx1 = Math.min(w - 1, bx1 + pad); by1 = Math.min(h - 1, by1 + pad);
    const bw = bx1 - bx0 + 1, bh = by1 - by0 + 1, BN = bw * bh, G = (li: number) => (by0 + ((li / bw) | 0)) * w + bx0 + (li % bw);
    const M = new Uint8Array(BN), notM = new Uint8Array(BN);
    for (let li = 0; li < BN; li++) { M[li] = L[G(li)] >= k ? 1 : 0; notM[li] = 1 - M[li]; }
    const dIn = chamfer(notM, bw, bh); // distance from material to the nearest non-material
    const core = new Uint8Array(BN); for (let li = 0; li < BN; li++) core[li] = M[li] && dIn[li] > r ? 1 : 0;
    const dCore = chamfer(core, bw, bh);
    const thin = new Uint8Array(BN); for (let li = 0; li < BN; li++) thin[li] = M[li] && dCore[li] > r + 0.5 ? 1 : 0;
    const T = parts(thin, bw, bh), C = parts(core, bw, bh);
    const touch = T.size.map(() => new Set<number>()), widest = T.size.map(() => 0), at = T.size.map(() => [0, 0, 0]);
    for (let li = 0; li < BN; li++) {
      const c = T.id[li]; if (!c) continue;
      const x = li % bw, y = (li / bw) | 0;
      widest[c] = Math.max(widest[c], dIn[li]); at[c][0] += x + bx0; at[c][1] += y + by0; at[c][2]++;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const X = x + dx, Y = y + dy; if (X < 0 || Y < 0 || X >= bw || Y >= bh) continue;
        const q = C.id[Y * bw + X]; if (q) touch[c].add(q);
      }
    }
    const grow = new Uint8Array(BN), pick = new Uint8Array(T.size.length); let g = 0, need = 0;
    for (let c = 1; c < T.size.length; c++) {
      if (T.size[c] < 4) continue;
      const neck = touch[c].size >= 2, strand = touch[c].size === 0 && T.size[c] > 2 * r * r;
      if (!neck && !strand) continue;
      need = Math.max(need, Math.ceil(r - widest[c]) + 1);
      g++; spots.push({ x: at[c][0] / at[c][2], y: at[c][1] / at[c][2], r: Math.max(6, Math.sqrt(T.size[c])), kind: 'fixed' });
      pick[c] = 1;
    }
    if (g) {
      for (let li = 0; li < BN; li++) if (pick[T.id[li]]) grow[li] = 1;
      const dG = chamfer(grow, bw, bh);
      for (let li = 0; li < BN; li++) { const i = G(li); if (dG[li] <= need && L[i] < k && (L[i] >= 0 || k === 0)) L[i] = k; }
      thickened += g;
    }
    if (k >= 1) pieces.unshift(parts(M, bw, bh).size.filter((v, i) => i > 0 && v >= speckPx).length);
  }
  // missing and merged sheets, colours nobody asked for
  const share = new Array(n).fill(0); let art = 0;
  for (let i = 0; i < N; i++) if (L[i] >= 0) { share[L[i]]++; art++; }
  const missing = share.map((v, k) => (v / Math.max(1, art) < 0.0015 ? k : -1)).filter((k) => k >= 0);
  const merged: [number, number][] = [];
  for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) if (dE(s.cols[a], s.cols[b]) < 7 && !missing.includes(a) && !missing.includes(b)) merged.push([a, b]);
  const absent = o.optional ? missing.splice(0) : [];
  const report: CutReport = { ready: !missing.length && !merged.length && s.unknown < 0.03, specks, thickened, missing, absent, merged, unknown: s.unknown, pieces, spots };
  return { labels: L, report };
}

/** the cleaned picture: exactly the planned colours, background white */
export function render(labels: Int16Array, w: number, h: number, cols: string[], bg = BG): Img {
  const data = new Uint8ClampedArray(w * h * 4), rgb = [bg, ...cols].map(hexRgb);
  for (let i = 0; i < w * h; i++) { const c = rgb[labels[i] + 1]; data[4 * i] = c[0]; data[4 * i + 1] = c[1]; data[4 * i + 2] = c[2]; data[4 * i + 3] = 255; }
  return { w, h, data };
}

/** what to tell the AI when the picture needs redrawing */
export function fixPrompt(plan: string[], rep: CutReport, minFrac = 150): string {
  const list = plan.map((c, k) => `${k + 1} ${c} (${colourName(c)})`).join(', ');
  const asks: string[] = [];
  for (const k of rep.missing) asks.push(`sheet ${k + 1} (${plan[k]}, ${colourName(plan[k])}) is missing: add it as a clear solid shape between sheet ${k} and sheet ${k + 2}`);
  for (const [a, b] of rep.merged) asks.push(`sheets ${a + 1} and ${b + 1} came out the same colour: use ${plan[a]} for sheet ${a + 1} and ${plan[b]} for sheet ${b + 1}`);
  if (rep.unknown >= 0.03) asks.push('some areas use colours that are not in the list: repaint them with the nearest listed colour');
  return [
    'Redraw this exact artwork for a layered laser-cut piece. Keep the same design, composition, shapes and proportions.',
    `Use only these flat colours, from the back sheet to the top sheet: ${list}, on a plain pure white #ffffff background.`,
    `Fix: ${asks.join('; ') || 'make every colour match the list exactly'}.`,
    'No shading, gradients, texture, outlines or shadows. Crisp smooth edges.',
    `The smallest detail, gap or line is at least 1/${minFrac} of the picture width.`,
  ].join(' ');
}
