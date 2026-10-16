// Trace an image into a colour-per-depth layer stack.
// Every flat colour in the picture gets one depth: sheet k keeps material wherever the
// colour sits at depth <= k, so looking down the stack you see the picture.
// Pure functions on plain arrays, so this runs in a worker or on the main thread.
import type { Pt } from './geom';

export interface TraceImage { w: number; h: number; data: Uint8ClampedArray }
export interface TraceOpts {
  colours: number;          // how many flat colours (= sheets including the back)
  smooth: number;           // mm: edge rounding into flowing curves
  minPiece: number;         // mm²: loose pieces smaller than this merge into their surroundings
  rib: number;              // mm: thinnest material allowed
  slot: number;             // mm: narrowest opening allowed
  widthMm: number; heightMm: number; // area the image covers (the inner area of the outline)
  shape: 'rect' | 'circle' | 'hex';
  darkFirst: boolean;       // keep the darkest colour as the top sheet
  order?: number[];         // manual order: palette indices, top to bottom
  palette?: string[];       // reuse these colours instead of finding new ones
}
export interface TraceOut {
  palette: string[];        // found colours (#rrggbb), in palette index order
  share: number[];          // % of the area per palette colour
  order: number[];          // palette indices, top sheet first; the last one is the back panel
  openings: Pt[][][];       // per cut sheet (all but the back): rings of the openings, mm, centred
  pieces: number[];         // loose glue-in pieces per sheet
  ms: number;
}

// ---------- colour ----------
function srgb2lin(c: number) { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
function lab(r: number, g: number, b: number): [number, number, number] {
  const R = srgb2lin(r), G = srgb2lin(g), B = srgb2lin(b);
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const X = f((R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047), Y = f(R * 0.2126 + G * 0.7152 + B * 0.0722), Z = f((R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883);
  return [116 * Y - 16, 500 * (X - Y), 200 * (Y - Z)];
}
const hex = (r: number, g: number, b: number) => '#' + [r, g, b].map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');
function hexRgb(h: string): [number, number, number] { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
function rand(seed: number) { let s = seed >>> 0; return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296); }

// ---------- raster helpers ----------
type Mask = Uint8Array;

/** Squared Euclidean distance to the nearest pixel where `feature` is set (Felzenszwalb). */
export function edt(feature: Mask, w: number, h: number): Float32Array {
  const INF = 1e20, n = Math.max(w, h);
  const out = new Float32Array(w * h);
  const f = new Float64Array(n), d = new Float64Array(n), z = new Float64Array(n + 1); const v = new Int32Array(n);
  const pass = (len: number) => {
    let k = 0; v[0] = 0; z[0] = -INF; z[1] = INF;
    for (let q = 1; q < len; q++) {
      let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      while (s <= z[k]) { k--; s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]); }
      k++; v[k] = q; z[k] = s; z[k + 1] = INF;
    }
    k = 0;
    for (let q = 0; q < len; q++) { while (z[k + 1] < q) k++; d[q] = (q - v[k]) * (q - v[k]) + f[v[k]]; }
  };
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = feature[y * w + x] ? 0 : INF;
    pass(h);
    for (let y = 0; y < h; y++) out[y * w + x] = d[y];
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) f[x] = out[y * w + x];
    pass(w);
    for (let x = 0; x < w; x++) out[y * w + x] = d[x];
  }
  return out;
}
export function dilate(m: Mask, w: number, h: number, r: number): Mask {
  const d = edt(m, w, h), o = new Uint8Array(w * h), r2 = r * r;
  for (let i = 0; i < o.length; i++) o[i] = d[i] <= r2 ? 1 : 0;
  return o;
}
export function erode(m: Mask, w: number, h: number, r: number): Mask {
  const inv = new Uint8Array(w * h);
  for (let i = 0; i < inv.length; i++) inv[i] = m[i] ? 0 : 1;
  const d = edt(inv, w, h), o = new Uint8Array(w * h), r2 = r * r;
  for (let i = 0; i < o.length; i++) o[i] = m[i] && d[i] > r2 ? 1 : 0;
  return o;
}
const open = (m: Mask, w: number, h: number, r: number) => dilate(erode(m, w, h, r), w, h, r);
const close = (m: Mask, w: number, h: number, r: number) => erode(dilate(m, w, h, r), w, h, r);

/** Connected components (8-connected). Returns labels (0 = background) and sizes. */
function components(m: Mask, w: number, h: number): { lab: Int32Array; n: number; size: number[] } {
  const lab = new Int32Array(w * h); const size: number[] = [0]; let n = 0;
  const stack = new Int32Array(w * h);
  for (let i = 0; i < m.length; i++) {
    if (!m[i] || lab[i]) continue;
    n++; let sp = 0, cnt = 0; stack[sp++] = i; lab[i] = n;
    while (sp) {
      const p = stack[--sp]; cnt++;
      const x = p % w, y = (p - x) / w;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy; if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx; if (xx < 0 || xx >= w) continue;
          const q = yy * w + xx;
          if (m[q] && !lab[q]) { lab[q] = n; stack[sp++] = q; }
        }
      }
    }
    size.push(cnt);
  }
  return { lab, n, size };
}

/** Box blur, three passes (close to a Gaussian of the given sigma, in px). */
export function blur(src: Float32Array, w: number, h: number, sigma: number): Float32Array {
  if (sigma < 0.3) return src.slice();
  const r = Math.max(1, Math.round(Math.sqrt((12 * sigma * sigma) / 3 + 1) / 2));
  let a = src.slice(), b = new Float32Array(w * h);
  const inv = 1 / (2 * r + 1);
  for (let pass = 0; pass < 3; pass++) {
    for (let y = 0; y < h; y++) {
      const o = y * w; let acc = 0;
      for (let x = -r; x <= r; x++) acc += a[o + Math.min(w - 1, Math.max(0, x))];
      for (let x = 0; x < w; x++) {
        b[o + x] = acc * inv;
        acc += a[o + Math.min(w - 1, x + r + 1)] - a[o + Math.max(0, x - r)];
      }
    }
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let y = -r; y <= r; y++) acc += b[Math.min(h - 1, Math.max(0, y)) * w + x];
      for (let y = 0; y < h; y++) {
        a[y * w + x] = acc * inv;
        acc += b[Math.min(h - 1, y + r + 1) * w + x] - b[Math.max(0, y - r) * w + x];
      }
    }
  }
  return a;
}

/** Fill unknown pixels from their nearest known neighbour (breadth-first growth). */
function fillUnknown(lbl: Int32Array, known: Mask, w: number, h: number) {
  let front: number[] = [];
  for (let i = 0; i < known.length; i++) if (known[i]) {
    const x = i % w;
    if ((x > 0 && !known[i - 1]) || (x < w - 1 && !known[i + 1]) || (i >= w && !known[i - w]) || (i < w * (h - 1) && !known[i + w])) front.push(i);
  }
  const k = known.slice();
  while (front.length) {
    const nx: number[] = [];
    for (const p of front) {
      const x = p % w;
      const nb = [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, p - w, p + w];
      for (const q of nb) if (q >= 0 && q < k.length && !k[q]) { k[q] = 1; lbl[q] = lbl[p]; nx.push(q); }
    }
    front = nx;
  }
}

// ---------- contours (marching squares on a smooth field) ----------
/** Closed rings around the region where field < 0.5. The field must be >= 0.5 on its border. */
export function contours(f: Float32Array, w: number, h: number): Pt[][] {
  // edge ids: horizontal edge (x,y)-(x+1,y) = 2*(y*w+x), vertical (x,y)-(x,y+1) = 2*(y*w+x)+1
  const N = 2 * w * h;
  const a = new Int32Array(N).fill(-1), b = new Int32Array(N).fill(-1);
  const link = (e1: number, e2: number) => { if (a[e1] < 0) a[e1] = e2; else b[e1] = e2; if (a[e2] < 0) a[e2] = e1; else b[e2] = e1; };
  const T = 0.5;
  for (let y = 0; y < h - 1; y++) for (let x = 0; x < w - 1; x++) {
    const i = y * w + x;
    const v0 = f[i] < T ? 1 : 0, v1 = f[i + 1] < T ? 1 : 0, v2 = f[i + w + 1] < T ? 1 : 0, v3 = f[i + w] < T ? 1 : 0;
    const c = v0 | (v1 << 1) | (v2 << 2) | (v3 << 3);
    if (c === 0 || c === 15) continue;
    const top = 2 * i, right = 2 * (i + 1) + 1, bottom = 2 * (i + w), left = 2 * i + 1;
    switch (c) {
      case 1: case 14: link(left, top); break;
      case 2: case 13: link(top, right); break;
      case 3: case 12: link(left, right); break;
      case 4: case 11: link(right, bottom); break;
      case 6: case 9: link(top, bottom); break;
      case 7: case 8: link(left, bottom); break;
      case 5: case 10: {
        const mid = (f[i] + f[i + 1] + f[i + w] + f[i + w + 1]) / 4 < T ? 1 : 0;
        if ((c === 5) === !!mid) { link(left, bottom); link(top, right); } else { link(left, top); link(right, bottom); }
        break;
      }
    }
  }
  const pt = (e: number): Pt => {
    const i = e >> 1, x = i % w, y = (i - x) / w;
    if (e & 1) { const f0 = f[i], f1 = f[i + w]; const t = (T - f0) / (f1 - f0 || 1e-9); return [x, y + t]; }
    const f0 = f[i], f1 = f[i + 1]; const t = (T - f0) / (f1 - f0 || 1e-9); return [x + t, y];
  };
  const seen = new Uint8Array(N);
  const rings: Pt[][] = [];
  for (let e = 0; e < N; e++) {
    if (a[e] < 0 || seen[e]) continue;
    const ring: Pt[] = [];
    let prev = -1, cur = e;
    while (cur >= 0 && !seen[cur]) {
      seen[cur] = 1; ring.push(pt(cur));
      const nx = a[cur] !== prev ? a[cur] : b[cur];
      prev = cur; cur = nx;
    }
    if (ring.length >= 4) rings.push(ring);
  }
  return rings;
}

function rdp(pts: Pt[], eps: number): Pt[] {
  if (pts.length < 4) return pts;
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const st: [number, number][] = [[0, pts.length - 1]];
  while (st.length) {
    const [i0, i1] = st.pop()!;
    const [ax, ay] = pts[i0], [bx, by] = pts[i1];
    const dx = bx - ax, dy = by - ay, L = Math.hypot(dx, dy) || 1e-9;
    let md = -1, mi = -1;
    for (let i = i0 + 1; i < i1; i++) { const d = Math.abs((pts[i][0] - ax) * dy - (pts[i][1] - ay) * dx) / L; if (d > md) { md = d; mi = i; } }
    if (md > eps) { keep[mi] = 1; st.push([i0, mi], [mi, i1]); }
  }
  return pts.filter((_, i) => keep[i]);
}
/** Simplify a closed ring: split it at the point farthest from the start, simplify both halves. */
function rdpClosed(p: Pt[], eps: number): Pt[] {
  if (p.length < 6) return p;
  let j = 0, md = -1;
  for (let i = 1; i < p.length; i++) { const d = (p[i][0] - p[0][0]) ** 2 + (p[i][1] - p[0][1]) ** 2; if (d > md) { md = d; j = i; } }
  const a = rdp(p.slice(0, j + 1), eps), b = rdp([...p.slice(j), p[0]], eps);
  return [...a, ...b.slice(1, -1)];
}
/** Gaussian smoothing along a closed ring. */
function smoothRing(p: Pt[], sigma: number): Pt[] {
  const n = p.length; if (n < 8 || sigma < 0.3) return p;
  const k = Math.min(Math.floor(n / 3), Math.ceil(sigma * 2.5));
  const wts: number[] = []; let s = 0;
  for (let i = -k; i <= k; i++) { const v = Math.exp(-(i * i) / (2 * sigma * sigma)); wts.push(v); s += v; }
  return p.map((_, i) => { let x = 0, y = 0; for (let j = -k; j <= k; j++) { const q = p[(i + j + n) % n], ww = wts[j + k]; x += q[0] * ww; y += q[1] * ww; } return [x / s, y / s] as Pt; });
}

// ---------- the trace ----------
export function trace(img: TraceImage, o: TraceOpts, progress?: (msg: string) => void): TraceOut {
  const t0 = performance.now();
  const { w, h, data } = img;
  const px = o.widthMm / w; // mm per pixel
  const N = w * h;
  // inside mask (the outline shape, inscribed in the image area)
  const inside = new Uint8Array(N);
  const cx = w / 2, cy = h / 2;
  const R = Math.min(w, h) / 2;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const dx = x + 0.5 - cx, dy = y + 0.5 - cy;
    let ok = true;
    if (o.shape === 'circle') ok = dx * dx + dy * dy < R * R;
    else if (o.shape === 'hex') { const ax = Math.abs(dx), ay = Math.abs(dy), rr = Math.min(w / 2, h / 2 / (Math.sqrt(3) / 2)); ok = ay < rr * Math.sqrt(3) / 2 && ax * Math.sqrt(3) / 2 + ay / 2 < rr * Math.sqrt(3) / 2; }
    inside[y * w + x] = ok && data[(y * w + x) * 4 + 3] > 8 ? 1 : 0;
  }
  // Lab pixels
  const L = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) { const c = lab(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]); L[i * 3] = c[0]; L[i * 3 + 1] = c[1]; L[i * 3 + 2] = c[2]; }

  // palette: fixed, or k-means++ in Lab
  progress?.('Finding colours…');
  let cent: number[][];
  const K = o.palette?.length ? o.palette.length : Math.max(2, Math.min(16, o.colours));
  if (o.palette?.length) cent = o.palette.map((p) => lab(...hexRgb(p)));
  else {
    // work on a half-size copy: k-means with spare clusters, then drop the clusters that
    // only appear as thin anti-aliased rims between two real colours
    const f = Math.max(1, Math.round(Math.max(w, h) / 650));
    const sw = Math.floor(w / f), sh = Math.floor(h / f);
    const SL = new Float32Array(sw * sh * 3), sIn = new Uint8Array(sw * sh);
    for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
      let l = 0, a = 0, b = 0, cnt = 0, ins = 0;
      for (let dy = 0; dy < f; dy++) for (let dx = 0; dx < f; dx++) { const q = (y * f + dy) * w + x * f + dx; l += L[q * 3]; a += L[q * 3 + 1]; b += L[q * 3 + 2]; cnt++; ins += inside[q]; }
      const j = y * sw + x; SL[j * 3] = (l / cnt) * 0.8; SL[j * 3 + 1] = a / cnt; SL[j * 3 + 2] = b / cnt; sIn[j] = ins === cnt ? 1 : 0;
    }
    const pix: number[] = []; for (let j = 0; j < sw * sh; j++) if (sIn[j]) pix.push(j);
    const r = rand(7);
    const d2p = (j: number, c: number[]) => (SL[j * 3] - c[0]) ** 2 + (SL[j * 3 + 1] - c[1]) ** 2 + (SL[j * 3 + 2] - c[2]) ** 2;
    const K2 = Math.min(28, K + 10);
    // k-means++ seeding on a sample
    const samp = pix.filter((_, i) => i % Math.max(1, Math.floor(pix.length / 30000)) === 0);
    const at = (j: number) => [SL[j * 3], SL[j * 3 + 1], SL[j * 3 + 2]];
    cent = [at(samp[Math.floor(r() * samp.length)])];
    const best = samp.map((j) => d2p(j, cent[0]));
    while (cent.length < K2) {
      let tot = 0; for (const v of best) tot += v;
      let t = r() * tot, i = 0;
      for (; i < samp.length - 1; i++) { t -= best[i]; if (t <= 0) break; }
      const c = at(samp[i]); cent.push(c);
      for (let k = 0; k < samp.length; k++) best[k] = Math.min(best[k], d2p(samp[k], c));
    }
    const asg = new Int32Array(sw * sh).fill(-1);
    const run = (it: number) => {
      for (let iter = 0; iter < it; iter++) {
        const sum = cent.map(() => [0, 0, 0, 0]);
        for (const j of pix) {
          let bi = 0, bd = Infinity;
          for (let c = 0; c < cent.length; c++) { const d = d2p(j, cent[c]); if (d < bd) { bd = d; bi = c; } }
          asg[j] = bi; const s4 = sum[bi]; s4[0] += SL[j * 3]; s4[1] += SL[j * 3 + 1]; s4[2] += SL[j * 3 + 2]; s4[3]++;
        }
        cent = cent.map((c, k) => (sum[k][3] ? [sum[k][0] / sum[k][3], sum[k][1] / sum[k][3], sum[k][2] / sum[k][3]] : c));
      }
    };
    run(10);
    while (cent.length > K) {
      // solid share: pixels whose 4 neighbours all carry the same colour
      const solid = cent.map(() => 0);
      for (const j of pix) {
        const c = asg[j], x = j % sw;
        if (x > 0 && x < sw - 1 && j >= sw && j < sw * (sh - 1) && asg[j - 1] === c && asg[j + 1] === c && asg[j - sw] === c && asg[j + sw] === c) solid[c]++;
      }
      let worst = 0; for (let c = 1; c < cent.length; c++) if (solid[c] < solid[worst]) worst = c;
      cent.splice(worst, 1);
      run(3);
    }
    cent = cent.map((c) => [c[0] / 0.8, c[1], c[2]]);
  }
  const P = cent;
  const Kp = P.length;

  // label every pixel; anti-aliased fringes and slivers go to the nearest confident colour
  progress?.('Separating colours…');
  let lbl = new Int32Array(N);
  const known = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    const l = L[i * 3], a = L[i * 3 + 1], b = L[i * 3 + 2];
    let bi = 0, bd = Infinity;
    for (let c = 0; c < Kp; c++) { const d = 0.6 * (l - P[c][0]) ** 2 + (a - P[c][1]) ** 2 + (b - P[c][2]) ** 2; if (d < bd) { bd = d; bi = c; } }
    lbl[i] = bi; known[i] = bd < 16 * 16 ? 1 : 0;
  }
  const fr = Math.max(1, 0.35 / px);
  for (let c = 0; c < Kp; c++) {
    const m = new Uint8Array(N); let any = false;
    for (let i = 0; i < N; i++) if (lbl[i] === c) { m[i] = 1; any = true; }
    if (!any) continue;
    const op = open(m, w, h, fr);
    for (let i = 0; i < N; i++) if (m[i] && !op[i]) known[i] = 0;
  }
  fillUnknown(lbl, known, w, h);
  // round the colour boundaries: blurred one-hot, then the strongest colour wins
  {
    const sig = Math.max(0.6, 0.45 / px);
    const bestV = new Float32Array(N).fill(-1), bestL = new Int32Array(N);
    for (let c = 0; c < Kp; c++) {
      const f = new Float32Array(N); for (let i = 0; i < N; i++) f[i] = lbl[i] === c ? 1 : 0;
      const g = blur(f, w, h, sig);
      for (let i = 0; i < N; i++) if (g[i] > bestV[i]) { bestV[i] = g[i]; bestL[i] = c; }
    }
    lbl = bestL;
  }
  const share = P.map(() => 0); let nin = 0;
  for (let i = 0; i < N; i++) if (inside[i]) { share[lbl[i]]++; nin++; }
  for (let c = 0; c < Kp; c++) share[c] = +(share[c] * 100 / Math.max(1, nin)).toFixed(1);
  // colours that barely appear are not worth a sheet
  const live = P.map((_, c) => share[c] >= 0.15);

  // depth order: fewest loose pieces, found by local search on a small copy
  progress?.('Choosing the layer order…');
  const liveIdx = P.map((_, c) => c).filter((c) => live[c]);
  const darkest = liveIdx.reduce((a, c) => (P[c][0] < P[a][0] ? c : a), liveIdx[0]);
  let order: number[];
  if (o.order && o.order.length === liveIdx.length && o.order.every((c) => live[c])) order = o.order.slice();
  else {
    const sw = Math.max(48, Math.round(Math.min(280, w))), sh = Math.max(48, Math.round(sw * h / w));
    const small = new Int32Array(sw * sh), sin = new Uint8Array(sw * sh);
    for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) { const q = Math.floor((y + 0.5) * h / sh) * w + Math.floor((x + 0.5) * w / sw); small[y * sw + x] = lbl[q]; sin[y * sw + x] = inside[q]; }
    const minSmall = (o.minPiece / (px * px)) * (sw / w) * (sw / w);
    // a sheet depends only on which colours sit above it, so remember each colour set's count
    const memo = new Map<number, number>();
    const m = new Uint8Array(sw * sh);
    const sheetScore = (set: number) => {
      let v = memo.get(set);
      if (v !== undefined) return v;
      // the frame outside the outline is material too, so pieces touching it are attached
      for (let i = 0; i < m.length; i++) m[i] = !sin[i] || (set >> small[i]) & 1 ? 1 : 0;
      const cc = components(m, sw, sh);
      let main = 1; for (let j = 2; j <= cc.n; j++) if (cc.size[j] > cc.size[main]) main = j;
      v = 0;
      for (let j = 1; j <= cc.n; j++) if (j !== main) v += cc.size[j] < minSmall ? 0.4 : 1;
      memo.set(set, v);
      return v;
    };
    const score = (ord: number[]) => {
      let s = 0, set = 0;
      for (let k = 0; k < ord.length - 1; k++) { set |= 1 << ord[k]; s += sheetScore(set); }
      return s;
    };
    const rest = liveIdx.filter((c) => !(o.darkFirst && c === darkest));
    const head = o.darkFirst ? [darkest] : [];
    const r = rand(11);
    let best: { s: number; ord: number[] } | null = null;
    const starts = rest.length <= 6 ? 3 : 5;
    for (let st = 0; st < starts; st++) {
      // first start: by share (big colours near the top), then random
      let cur = st === 0 ? rest.slice().sort((a, b) => share[b] - share[a]) : rest.slice().sort(() => r() - 0.5);
      let cs = score([...head, ...cur]);
      let improved = true, guard = 0;
      while (improved && guard++ < 8) {
        improved = false;
        for (let i = 0; i < cur.length; i++) for (let j = 0; j < cur.length; j++) {
          if (i === j) continue;
          const cand = cur.slice(); const [c] = cand.splice(i, 1); cand.splice(j, 0, c);
          const sc = score([...head, ...cand]);
          if (sc < cs - 1e-9) { cur = cand; cs = sc; improved = true; }
        }
      }
      if (!best || cs < best.s) best = { s: cs, ord: [...head, ...cur] };
    }
    order = best!.ord;
  }
  const n = order.length;
  const depth = new Int32Array(Kp).fill(n - 1); order.forEach((c, d) => (depth[c] = d));
  const D = new Int32Array(N);
  for (let i = 0; i < N; i++) D[i] = depth[lbl[i]];

  // merge loose pieces that are too small to glue, or thin black outline strokes
  progress?.('Tidying loose pieces…');
  const minPx = o.minPiece / (px * px);
  for (let k = 0; k < n - 1; k++) {
    const m = new Uint8Array(N);
    for (let i = 0; i < N; i++) m[i] = !inside[i] || D[i] <= k ? 1 : 0;
    const cc = components(m, w, h);
    let main = 1; for (let j = 2; j <= cc.n; j++) if (cc.size[j] > cc.size[main]) main = j;
    if (cc.n <= 1) continue;
    // perimeter per component, for the mean stroke width
    const per = new Float64Array(cc.n + 1);
    for (let i = 0; i < N; i++) { const l = cc.lab[i]; if (!l) continue; const x = i % w; if (x === 0 || !m[i - 1]) per[l]++; if (x === w - 1 || !m[i + 1]) per[l]++; if (i < w || !m[i - w]) per[l]++; if (i >= N - w || !m[i + w]) per[l]++; }
    const drop = new Uint8Array(cc.n + 1);
    for (let j = 1; j <= cc.n; j++) {
      if (j === main) continue;
      const meanW = (2 * cc.size[j] / Math.max(1, per[j])) * px;
      if (cc.size[j] < minPx || (k === 0 && meanW < 2.2)) drop[j] = 1;
    }
    // recolour dropped pieces with the most common depth around them
    const votes = new Map<number, Map<number, number>>();
    for (let i = 0; i < N; i++) {
      const l = cc.lab[i]; if (!l || !drop[l]) continue;
      const x = i % w;
      for (const q of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i - w, i + w]) {
        if (q < 0 || q >= N || m[q]) continue;
        let v = votes.get(l); if (!v) votes.set(l, (v = new Map()));
        v.set(D[q], (v.get(D[q]) ?? 0) + 1);
      }
    }
    for (let i = 0; i < N; i++) {
      const l = cc.lab[i]; if (!l || !drop[l]) continue;
      const v = votes.get(l); if (!v) continue;
      let bd = k + 1, bc = -1; for (const [d, c] of v) if (c > bc) { bc = c; bd = d; }
      D[i] = bd;
    }
  }

  // build each cut sheet, fix thin ribs and narrow slots, then trace smooth outlines
  const openings: Pt[][][] = [], pieces: number[] = [];
  let prev: Mask | null = null;
  const ribR = o.rib / 2 / px, slotR = o.slot / 2 / px, sig = Math.max(0.5, o.smooth / px);
  const holePx = 2 / (px * px);
  for (let k = 0; k < n - 1; k++) {
    progress?.(`Tracing sheet ${k + 1} of ${n}…`);
    let m: Mask = new Uint8Array(N);
    for (let i = 0; i < N; i++) m[i] = !inside[i] || D[i] <= k || (prev && prev[i]) ? 1 : 0;
    // thin ribs: anything that would not survive an opening at the rib width gets widened
    const op = open(m, w, h, ribR);
    const thin = new Uint8Array(N); let anyThin = false;
    for (let i = 0; i < N; i++) if (m[i] && !op[i]) { thin[i] = 1; anyThin = true; }
    if (anyThin) { const g = dilate(thin, w, h, ribR * 0.8); for (let i = 0; i < N; i++) if (g[i]) m[i] = 1; }
    if (slotR >= 0.5) m = close(m, w, h, slotR);
    // fill tiny holes
    const inv = new Uint8Array(N); for (let i = 0; i < N; i++) inv[i] = m[i] ? 0 : 1;
    const hc = components(inv, w, h);
    for (let i = 0; i < N; i++) { const l = hc.lab[i]; if (l && hc.size[l] < holePx) m[i] = 1; }
    if (prev) for (let i = 0; i < N; i++) if (prev[i]) m[i] = 1;
    for (let i = 0; i < N; i++) if (!inside[i]) m[i] = 1;
    const cc = components(m, w, h);
    pieces.push(Math.max(0, cc.n - 1));
    prev = m;
    // smooth field; pad with material so every ring closes
    const pw = w + 2, ph = h + 2;
    const f = new Float32Array(pw * ph).fill(1);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) f[(y + 1) * pw + x + 1] = m[y * w + x];
    const g = blur(f, pw, ph, sig);
    for (let x = 0; x < pw; x++) { g[x] = 1; g[(ph - 1) * pw + x] = 1; }
    for (let y = 0; y < ph; y++) { g[y * pw] = 1; g[y * pw + pw - 1] = 1; }
    const rings = contours(g, pw, ph)
      .map((r) => smoothRing(r, 1.2))
      .map((r) => rdpClosed(r, 0.04 / px))
      .filter((r) => r.length >= 3)
      .map((r) => r.map(([x, y]) => [(x - 1 + 0.5 - w / 2) * px, (y - 1 + 0.5 - h / 2) * px] as Pt));
    openings.push(rings);
  }
  return { palette: P.map((c) => { const [r, g, b] = labToRgb(c); return hex(r, g, b); }), share, order, openings, pieces, ms: performance.now() - t0 };
}

function labToRgb([l, a, b]: number[]): [number, number, number] {
  const fy = (l + 16) / 116, fx = fy + a / 500, fz = fy - b / 200;
  const fi = (t: number) => (t ** 3 > 0.008856 ? t ** 3 : (t - 16 / 116) / 7.787);
  const X = fi(fx) * 0.95047, Y = fi(fy), Z = fi(fz) * 1.08883;
  const R = X * 3.2406 - Y * 1.5372 - Z * 0.4986, G = -X * 0.9689 + Y * 1.8758 + Z * 0.0415, B = X * 0.0557 - Y * 0.204 + Z * 1.057;
  const g = (c: number) => 255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(Math.max(0, c), 1 / 2.4) - 0.055);
  return [g(R), g(G), g(B)];
}

/** Prompt for an image AI (Nano Banana Pro / Gemini) to redraw a picture as flat colours first. */
export const REDRAW_PROMPT = (n: number) => `Redraw the attached image as a flat colour-separation drawing for multi-layer laser cutting. Straight-on front view, same composition, every shape in the same place - do not redesign. Use exactly ${n} flat colours: no shading, gradients, texture, glow or shadows. Every edge a smooth, flowing, organic curve with crisp edges - no jagged edges, specks or noise. Do not outline colour areas with thin black lines; neighbouring colours touch directly. Plain flat background outside the artwork.`;
