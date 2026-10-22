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
  follow?: boolean;         // the outer cut follows the artwork's silhouette (background removed)
  rimMm?: number;           // follow: solid rim around the silhouette, mm
  merge?: number;
  fair?: number;
  gaps?: 'keep' | 'widen' | 'fill'; // narrow gaps and thin ribs: keep them as drawn and let the laser cut what it can (default), widen them to the minimum, or fill them
  lettering?: { hex: string; font: string; lines: string[]; shapes?: Pt[][][] }; // replace traced letters with font outlines            // curve fairing scale, mm: ripples shorter than this are smoothed into curves (0 = off)           // colours closer than this (ΔE) are one ink; larger for photos of prints
}
export interface TraceOut {
  palette: string[];        // found colours (#rrggbb), in palette index order
  share: number[];          // % of the area per palette colour
  order: number[];          // palette indices, top sheet first; the last one is the back panel
  openings: Pt[][][];       // per cut sheet (all but the back): rings of the openings, mm, centred
  pieces: number[];         // loose glue-in pieces per sheet
  outline?: Pt[];           // follow: the outer cut, mm, centred on the image area
  framed?: boolean;         // follow: the artwork has its own frame colour, so no rim was added
  letterLines?: number;     // lines of lettering found in the picture
  letterWidths?: number[];  // how wide each of those lines is (relative)
  lettered?: boolean;       // the font lettering was placed
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
/** Colour difference (ΔE76) between two #rrggbb colours. */
export function hexDist(a: string, b: string) { const p = lab(...hexRgb(a)), q = lab(...hexRgb(b)); return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]); }
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

/**
 * Fair a closed ring into smooth curves: resample evenly, find the real corners, then
 * smooth each stretch between corners without shrinking it (2·G − G·G). Ripples shorter
 * than about `scale` disappear; curves keep their size and corners stay sharp.
 */
export function fairRing(p: Pt[], scale: number, cornerDeg = 55): Pt[] {
  if (p.length < 6 || scale < 0.5) return p;
  // even resampling
  let len = 0; const seg: number[] = [];
  for (let i = 0; i < p.length; i++) { const a = p[i], b = p[(i + 1) % p.length]; const d = Math.hypot(b[0] - a[0], b[1] - a[1]); seg.push(d); len += d; }
  const hS = Math.max(0.35, Math.min(scale / 4, len / 40));
  const n = Math.max(12, Math.round(len / hS)), step = len / n;
  const q: Pt[] = []; let si = 0, acc = 0;
  for (let k = 0; k < n; k++) {
    const t = k * step;
    while (si < p.length - 1 && acc + seg[si] < t) { acc += seg[si]; si++; }
    const a = p[si], b = p[(si + 1) % p.length], u = seg[si] ? (t - acc) / seg[si] : 0;
    q.push([a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u]);
  }
  // corners: a sharp turn over a short window, kept at the local maximum
  const W = Math.max(2, Math.round(0.5 * scale / step));
  const turn = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = q[(i - W + n) % n], b = q[i], c = q[(i + W) % n];
    const a1 = Math.atan2(b[1] - a[1], b[0] - a[0]), a2 = Math.atan2(c[1] - b[1], c[0] - b[0]);
    let d = Math.abs(a2 - a1); if (d > Math.PI) d = 2 * Math.PI - d; turn[i] = d;
  }
  const lim = (cornerDeg * Math.PI) / 180, corners: number[] = [];
  for (let i = 0; i < n; i++) {
    if (turn[i] < lim) continue;
    let peak = true; for (let j = 1; j <= W; j++) if (turn[(i + j) % n] > turn[i] || turn[(i - j + n) % n] >= turn[i]) { peak = false; break; }
    if (peak) corners.push(i);
  }
  const sig = scale / step;
  const gauss = (src: Pt[], closed: boolean): Pt[] => {
    const m = src.length, k = Math.min(Math.ceil(sig * 2.5), closed ? Math.floor(m / 2) - 1 : m - 1);
    if (k < 1) return src;
    const wts: number[] = []; for (let j = -k; j <= k; j++) wts.push(Math.exp(-(j * j) / (2 * sig * sig)));
    const at = (i: number): Pt => {
      if (closed) return src[((i % m) + m) % m];
      if (i < 0) { const r = src[Math.min(m - 1, -i)]; return [2 * src[0][0] - r[0], 2 * src[0][1] - r[1]]; } // odd reflection keeps the end fixed
      if (i >= m) { const r = src[Math.max(0, 2 * (m - 1) - i)]; return [2 * src[m - 1][0] - r[0], 2 * src[m - 1][1] - r[1]]; }
      return src[i];
    };
    return src.map((_, i) => { let x = 0, y = 0, s = 0; for (let j = -k; j <= k; j++) { const v = at(i + j), ww = wts[j + k]; x += v[0] * ww; y += v[1] * ww; s += ww; } return [x / s, y / s] as Pt; });
  };
  const fair = (src: Pt[], closed: boolean): Pt[] => {
    const g1 = gauss(src, closed), g2 = gauss(g1, closed);
    const out = g1.map((v, i) => [2 * v[0] - g2[i][0], 2 * v[1] - g2[i][1]] as Pt);
    if (!closed) { out[0] = src[0]; out[out.length - 1] = src[src.length - 1]; }
    return out;
  };
  if (!corners.length) return fair(q, true);
  const out: Pt[] = [];
  for (let c = 0; c < corners.length; c++) {
    const a = corners[c], b = corners[(c + 1) % corners.length];
    const part: Pt[] = [q[a]]; for (let i = (a + 1) % n; ; i = (i + 1) % n) { part.push(q[i]); if (i === b) break; }
    const f = part.length > 3 ? fair(part, false) : part;
    out.push(...f.slice(0, -1));
  }
  return out;
}

/** Fill closed rings (pixel coords) with the nonzero rule; returns a mask. */
function fillRings(rings: Pt[][], w: number, h: number): Mask {
  const m = new Uint8Array(w * h);
  let y0 = h, y1 = 0;
  for (const r of rings) for (const [, y] of r) { y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  for (let y = Math.max(0, Math.floor(y0)); y <= Math.min(h - 1, Math.ceil(y1)); y++) {
    const yc = y + 0.5, xs: [number, number][] = [];
    for (const r of rings) for (let i = 0; i < r.length; i++) {
      const a = r[i], b = r[(i + 1) % r.length];
      if ((a[1] <= yc) === (b[1] <= yc)) continue;
      xs.push([a[0] + ((yc - a[1]) / (b[1] - a[1])) * (b[0] - a[0]), b[1] > a[1] ? 1 : -1]);
    }
    xs.sort((p, q) => p[0] - q[0]);
    let wnd = 0;
    for (let i = 0; i < xs.length - 1; i++) {
      wnd += xs[i][1];
      if (!wnd) continue;
      for (let x = Math.max(0, Math.ceil(xs[i][0] - 0.5)); x <= Math.min(w - 1, Math.floor(xs[i + 1][0] - 0.5)); x++) m[y * w + x] = 1;
    }
  }
  return m;
}

/**
 * Swap the traced lettering for font outlines: find the letters (the text colour, away from the
 * picture's edge), group them into lines, fit each line of font outlines to its line's box, and
 * give the old letter pixels to the colour around them.
 */
function placeLettering(lbl: Int32Array, inside: Mask, w: number, h: number, P: number[][], L: NonNullable<TraceOpts['lettering']>): { lines: number; widths?: number[]; placed: boolean } {
  const want = lab(...hexRgb(L.hex));
  let tc = 0, bd = Infinity;
  P.forEach((c, i) => { const d = (c[0] - want[0]) ** 2 + (c[1] - want[1]) ** 2 + (c[2] - want[2]) ** 2; if (d < bd) { bd = d; tc = i; } });
  const N = w * h, m = new Uint8Array(N);
  for (let i = 0; i < N; i++) m[i] = inside[i] && lbl[i] === tc ? 1 : 0;
  const cc = components(m, w, h);
  // letters: pieces of the text colour that do not touch the edge and are not huge or specks
  const bx = Array.from({ length: cc.n + 1 }, () => [w, h, -1, -1, 0]);
  for (let i = 0; i < N; i++) { const l = cc.lab[i]; if (!l) continue; const x = i % w, y = (i / w) | 0, b = bx[l]; b[0] = Math.min(b[0], x); b[1] = Math.min(b[1], y); b[2] = Math.max(b[2], x); b[3] = Math.max(b[3], y); }
  const edge = new Uint8Array(cc.n + 1);
  for (let l = 1; l <= cc.n; l++) { const b = bx[l]; if (b[0] <= 1 || b[1] <= 1 || b[2] >= w - 2 || b[3] >= h - 2) edge[l] = 1; }
  const letters: number[] = [];
  for (let l = 1; l <= cc.n; l++) if (!edge[l] && cc.size[l] > N * 0.00005 && cc.size[l] < N * 0.08) letters.push(l);
  if (!letters.length) return { lines: 0, placed: false };
  // lines: letters whose heights overlap enough
  letters.sort((a, b) => (bx[a][1] + bx[a][3]) - (bx[b][1] + bx[b][3]));
  const groups: { ids: number[]; y0: number; y1: number }[] = [];
  for (const l of letters) {
    const [, y0, , y1] = bx[l], hgt = y1 - y0 + 1;
    const g = groups.find((g) => Math.min(g.y1, y1) - Math.max(g.y0, y0) > 0.45 * Math.min(hgt, g.y1 - g.y0 + 1));
    if (g) { g.ids.push(l); g.y0 = Math.min(g.y0, y0); g.y1 = Math.max(g.y1, y1); } else groups.push({ ids: [l], y0, y1 });
  }
  // a line holds most of the lettering's area; drop stray bits that formed their own "line"
  const area = (g: { ids: number[] }) => g.ids.reduce((a, l) => a + cc.size[l], 0);
  const big = Math.max(...groups.map(area));
  const lines = groups.filter((g) => area(g) > big * 0.12).sort((a, b) => a.y0 - b.y0);
  const widths = lines.map((g) => { let a = w, b = 0; for (const l of g.ids) { a = Math.min(a, bx[l][0]); b = Math.max(b, bx[l][2] + 1); } return (b - a) / w; });
  if (!L.shapes || L.shapes.length !== lines.length) return { lines: lines.length, widths, placed: false };
  // clear the old letters, letting the colour around them flow in
  const known = new Uint8Array(N).fill(1);
  for (const g of lines) for (const l of g.ids) { const b = bx[l]; for (let y = b[1]; y <= b[3]; y++) for (let x = b[0]; x <= b[2]; x++) if (cc.lab[y * w + x] === l) known[y * w + x] = 0; }
  fillUnknown(lbl, known, w, h);
  // fit each line of font outlines to its box
  lines.forEach((g, k) => {
    let x0 = w, x1 = 0; for (const l of g.ids) { x0 = Math.min(x0, bx[l][0]); x1 = Math.max(x1, bx[l][2] + 1); }
    const y0 = g.y0, y1 = g.y1 + 1;
    const rings = L.shapes![k]; if (!rings.length) return;
    let gx0 = Infinity, gy0 = Infinity, gx1 = -Infinity, gy1 = -Infinity;
    for (const r of rings) for (const [x, y] of r) { gx0 = Math.min(gx0, x); gx1 = Math.max(gx1, x); gy0 = Math.min(gy0, y); gy1 = Math.max(gy1, y); }
    const sx = (x1 - x0) / Math.max(1e-6, gx1 - gx0), sy = (y1 - y0) / Math.max(1e-6, gy1 - gy0);
    let mk = fillRings(rings.map((r) => r.map(([x, y]) => [x0 + (x - gx0) * sx, y0 + (y - gy0) * sy] as Pt)), w, h);
    // match the weight of the original lettering: grow (or thin) until the ink area is the same
    const oldA = g.ids.reduce((a, l) => a + cc.size[l], 0);
    let newA = 0, per = 0;
    for (let i = 0; i < N; i++) if (mk[i]) { newA++; const x = i % w; if (x === 0 || !mk[i - 1] || x === w - 1 || !mk[i + 1] || i < w || !mk[i - w] || i >= N - w || !mk[i + w]) per++; }
    const dlt = Math.max(-0.02, Math.min(0.02, 0.7 * (oldA - newA) / Math.max(1, per) / (y1 - y0))) * (y1 - y0);
    if (dlt > 0.4) mk = dilate(mk, w, h, dlt); else if (dlt < -0.4) mk = erode(mk, w, h, -dlt);
    for (let i = 0; i < N; i++) if (mk[i] && inside[i]) lbl[i] = tc;
  });
  return { lines: lines.length, widths, placed: true };
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
      // the cheapest colour to lose: few solid pixels AND close to another colour.
      // A thin black outline has few pixels but nothing like it, so it stays;
      // a light-grey copy of white (photo shading) is close to white, so it goes.
      const near = cent.map((c, i) => { let m = Infinity; cent.forEach((q, j) => { if (j !== i) m = Math.min(m, (c[0] - q[0]) ** 2 + (c[1] - q[1]) ** 2 + (c[2] - q[2]) ** 2); }); return m; });
      const cost = (c: number) => (solid[c] + 1) * Math.min(near[c], 60 * 60);
      let worst = 0; for (let c = 1; c < cent.length; c++) if (cost(c) < cost(worst)) worst = c;
      cent.splice(worst, 1);
      run(3);
    }
    // colours that are really the same ink (shading, print or photo noise) become one
    for (;;) {
      let bi = -1, bj = -1, bd = (o.merge ?? 11) ** 2;
      for (let i = 0; i < cent.length; i++) for (let j = i + 1; j < cent.length; j++) {
        const d = (cent[i][0] - cent[j][0]) ** 2 + (cent[i][1] - cent[j][1]) ** 2 + (cent[i][2] - cent[j][2]) ** 2;
        if (d < bd) { bd = d; bi = i; bj = j; }
      }
      if (bi < 0 || cent.length <= 2) break;
      cent.splice(bj, 1); run(3);
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
  const keep = (o.gaps ?? 'keep') === 'keep';
  const fr = Math.max(1, 0.35 / px);
  // keep: thin strips that are part of the drawing (a gap between two letters, a fine line) stay;
  // they touch only one other colour. Anti-aliased fringes sit between two colours and go.
  const lines = keep ? new Int32Array(N) : null;
  for (let c = 0; c < Kp; c++) {
    const m = new Uint8Array(N); let any = false;
    for (let i = 0; i < N; i++) if (lbl[i] === c) { m[i] = 1; any = true; }
    if (!any) continue;
    const op = open(m, w, h, fr);
    const thin = new Uint8Array(N); let anyThin = false;
    for (let i = 0; i < N; i++) if (m[i] && !op[i]) { thin[i] = 1; anyThin = true; known[i] = 0; }
    if (!lines || !anyThin) continue;
    const tc = components(thin, w, h);
    const side = new Int32Array(tc.n + 1).fill(-1), many = new Uint8Array(tc.n + 1);
    for (let i = 0; i < N; i++) {
      const l = tc.lab[i]; if (!l) continue;
      const x = i % w;
      for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i - w, i + w]) {
        if (j < 0 || j >= N || lbl[j] === c) continue;
        if (side[l] < 0) side[l] = lbl[j]; else if (side[l] !== lbl[j]) many[l] = 1;
      }
    }
    const minLen = 0.6 / px; // a line, not a speck
    for (let i = 0; i < N; i++) {
      const l = tc.lab[i];
      if (l && !many[l] && side[l] >= 0 && tc.size[l] >= minLen) { known[i] = 1; lines[i] = c + 1; }
    }
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
    if (lines) for (let i = 0; i < N; i++) if (lines[i]) lbl[i] = lines[i] - 1;
  }
  let letterLines: number | undefined, letterWidths: number[] | undefined, lettered = false;
  if (o.lettering) {
    const r = placeLettering(lbl, inside, w, h, P, o.lettering);
    letterLines = r.lines; letterWidths = r.widths; lettered = r.placed;
  }
  // follow the picture: the background is the colour that fills the picture's edge,
  // flood-filled inwards; everything else is the artwork's silhouette
  let outline: Pt[] | undefined, framed = false;
  if (o.follow) {
    progress?.('Finding the outline…');
    const cnt = new Map<number, number>();
    for (let x = 0; x < w; x++) for (const y of [0, h - 1]) { const c = lbl[y * w + x]; cnt.set(c, (cnt.get(c) ?? 0) + 1); }
    for (let y = 0; y < h; y++) for (const x of [0, w - 1]) { const c = lbl[y * w + x]; cnt.set(c, (cnt.get(c) ?? 0) + 1); }
    let bg = 0, bc = -1; for (const [c, v] of cnt) if (v > bc) { bc = v; bg = c; }
    const bgm = new Uint8Array(N), st = new Int32Array(N); let sp = 0;
    const push = (i: number) => { if (!bgm[i] && lbl[i] === bg) { bgm[i] = 1; st[sp++] = i; } };
    for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
    for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
    while (sp) { const i = st[--sp], x = i % w; if (x > 0) push(i - 1); if (x < w - 1) push(i + 1); if (i >= w) push(i - w); if (i < N - w) push(i + w); }
    let sil: Mask = new Uint8Array(N); for (let i = 0; i < N; i++) sil[i] = bgm[i] ? 0 : 1;
    // keep the biggest piece and fill its holes, then round off tiny notches
    const cs = components(sil, w, h);
    let big = 1; for (let j = 2; j <= cs.n; j++) if (cs.size[j] > cs.size[big]) big = j;
    for (let i = 0; i < N; i++) sil[i] = cs.lab[i] === big ? 1 : 0;
    const inv = new Uint8Array(N); for (let i = 0; i < N; i++) inv[i] = sil[i] ? 0 : 1;
    const hc = components(inv, w, h);
    const edge = new Set<number>(); for (let x = 0; x < w; x++) { edge.add(hc.lab[x]); edge.add(hc.lab[(h - 1) * w + x]); } for (let y = 0; y < h; y++) { edge.add(hc.lab[y * w]); edge.add(hc.lab[y * w + w - 1]); }
    for (let i = 0; i < N; i++) if (hc.lab[i] && !edge.has(hc.lab[i])) sil[i] = 1;
    if (cs.n > 0 && cs.size[big] > N * 0.02) {
      sil = close(sil, w, h, Math.max(1, 1.2 / px));
      for (let i = 0; i < N; i++) inside[i] = inside[i] && sil[i] ? 1 : 0;
      // outline: silhouette grown by the rim, traced on a padded field so it may leave the picture
      // artwork that already has its own frame (one colour all round its edge, like a black outline)
      // is cut along that frame; otherwise a solid rim is added round it
      const ec = new Map<number, number>(); let en = 0;
      for (let i = 0; i < N; i++) {
        if (!sil[i]) continue; const x = i % w;
        if ((x > 0 && !sil[i - 1]) || (x < w - 1 && !sil[i + 1]) || (i >= w && !sil[i - w]) || (i < N - w && !sil[i + w])) { ec.set(lbl[i], (ec.get(lbl[i]) ?? 0) + 1); en++; }
      }
      const frameShare = en ? Math.max(...ec.values()) / en : 0;
      framed = frameShare >= 0.85;
      const rim = (framed ? Math.min(0.3, Math.max(0, o.rimMm ?? 3)) : Math.max(0, o.rimMm ?? 3)) / px, pad = Math.ceil(rim) + 3;
      const pw = w + 2 * pad, ph = h + 2 * pad;
      const pm = new Uint8Array(pw * ph);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) pm[(y + pad) * pw + x + pad] = sil[y * w + x];
      const grown = rim > 0.5 ? dilate(pm, pw, ph, rim) : pm;
      const fld = new Float32Array(pw * ph); for (let i = 0; i < fld.length; i++) fld[i] = grown[i] ? 0 : 1;
      const g = blur(fld, pw, ph, Math.max(0.8, 0.8 / px));
      for (let x = 0; x < pw; x++) { g[x] = 1; g[(ph - 1) * pw + x] = 1; }
      for (let y = 0; y < ph; y++) { g[y * pw] = 1; g[y * pw + pw - 1] = 1; }
      const rings = contours(g, pw, ph).map((r) => rdpClosed(fairRing(smoothRing(r, 1.2), (o.fair ?? 1) * 1.5 / px), 0.03 / px)).filter((r) => r.length >= 3);
      const area = (r: Pt[]) => { let a = 0; for (let i = 0; i < r.length; i++) { const [x1, y1] = r[i], [x2, y2] = r[(i + 1) % r.length]; a += x1 * y2 - x2 * y1; } return Math.abs(a / 2); };
      const best = rings.sort((a, b) => area(b) - area(a))[0];
      if (best) outline = best.map(([x, y]) => [(x - pad + 0.5 - w / 2) * px, (y - pad + 0.5 - h / 2) * px] as Pt);
    }
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
      if (cc.size[j] < minPx || (!keep && k === 0 && meanW < 2.2)) drop[j] = 1;
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
  const ribR = o.rib / 2 / px, slotR = o.slot / 2 / px;
  // keep: a light blur, so a gap a pixel or two wide survives; the curve fairing does the smoothing
  const sig = keep ? Math.max(0.5, Math.min(o.smooth, 0.08) / px) : Math.max(0.5, o.smooth / px);
  const holePx = (keep ? 0.3 : 2) / (px * px);
  // where a sheet's edge lies on the edge of a sheet above, pull it back under that sheet, so the two
  // separately smoothed curves can never drift apart and show a sliver of the lower sheet
  const tuck = 1.0 / px, top = new Int16Array(N).fill(-1);
  for (let k = 0; k < n - 1; k++) {
    progress?.(`Tracing sheet ${k + 1} of ${n}…`);
    let m: Mask = new Uint8Array(N);
    for (let i = 0; i < N; i++) m[i] = !inside[i] || D[i] <= k || (prev && prev[i]) ? 1 : 0;
    // thin ribs: anything that would not survive an opening at the rib width gets widened
    if (!keep) {
      const op = open(m, w, h, ribR);
      const thin = new Uint8Array(N); let anyThin = false;
      for (let i = 0; i < N; i++) if (m[i] && !op[i]) { thin[i] = 1; anyThin = true; }
      if (anyThin) { const g = dilate(thin, w, h, ribR * 0.8); for (let i = 0; i < N; i++) if (g[i]) m[i] = 1; }
    }
    if (slotR >= 0.5 && !keep) {
      // narrow openings are filled, except right beside a sheet above: there this sheet's edge is
      // tucked under that sheet, so the opening is not really narrow (and filling would show)
      const m0 = m;
      m = close(m, w, h, slotR);
      if (prev) {
        const nearUp = dilate(prev, w, h, slotR * 2);
        for (let i = 0; i < N; i++) if (m[i] && !m0[i] && nearUp[i] && !prev[i]) m[i] = 0;
      }
      if (o.gaps !== 'fill') {
        // gaps that are part of the design (between and inside letters) are widened to the minimum
        // opening instead of filled; tiny fillets in corners stay filled
        const add = new Uint8Array(N); for (let i = 0; i < N; i++) add[i] = m[i] && !m0[i] ? 1 : 0;
        const ac = components(add, w, h), big = Math.PI * slotR * slotR;
        const gap = new Uint8Array(N); let any = false;
        for (let i = 0; i < N; i++) { const l = ac.lab[i]; if (l && ac.size[l] >= big) { gap[i] = 1; any = true; } }
        if (any) {
          const wide = dilate(gap, w, h, slotR * 0.75);
          for (let i = 0; i < N; i++) if (wide[i] && !(prev && prev[i])) m[i] = 0;
        }
      }
    }
    // fill tiny holes
    const inv = new Uint8Array(N); for (let i = 0; i < N; i++) inv[i] = m[i] ? 0 : 1;
    const hc = components(inv, w, h);
    for (let i = 0; i < N; i++) { const l = hc.lab[i]; if (l && hc.size[l] < holePx) m[i] = 1; }
    if (prev) for (let i = 0; i < N; i++) if (prev[i]) m[i] = 1;
    for (let i = 0; i < N; i++) if (!inside[i]) m[i] = 1;
    const cc = components(m, w, h);
    pieces.push(Math.max(0, cc.n - 1));
    prev = m;
    // the cut: material already held by a sheet above may step back from this sheet's openings
    // (one tuck per sheet between, so stacked shared edges stay nested)
    for (let i = 0; i < N; i++) if (m[i] && top[i] < 0 && inside[i]) top[i] = k;
    let cut: Mask = m;
    if (k > 0 && tuck >= 0.5) {
      const hole = new Uint8Array(N); let anyHole = false;
      for (let i = 0; i < N; i++) if (!m[i]) { hole[i] = 1; anyHole = true; }
      if (anyHole) {
        const d2 = edt(hole, w, h);
        cut = new Uint8Array(N);
        for (let i = 0; i < N; i++) {
          if (!m[i]) continue;
          const t = top[i];
          if (t >= 0 && t < k) { const r = tuck * Math.min(2, k - t); if (d2[i] < r * r) continue; }
          cut[i] = 1;
        }
      }
    }
    // smooth field; pad with material so every ring closes
    const pw = w + 2, ph = h + 2;
    const cutRings = (cm: Mask) => {
      const f = new Float32Array(pw * ph).fill(1);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) f[(y + 1) * pw + x + 1] = cm[y * w + x];
      const g = blur(f, pw, ph, sig);
      for (let x = 0; x < pw; x++) { g[x] = 1; g[(ph - 1) * pw + x] = 1; }
      for (let y = 0; y < ph; y++) { g[y * pw] = 1; g[y * pw + pw - 1] = 1; }
      return contours(g, pw, ph)
        .map((r) => fairRing(smoothRing(r, 1.2), (o.fair ?? 1) / px))
        .map((r) => rdpClosed(r, 0.03 / px))
        .filter((r) => r.length >= 3);
    };
    const pxRings = cutRings(cut);
    const rings = pxRings.map((r) => r.map(([x, y]) => [(x - 1 + 0.5 - w / 2) * px, (y - 1 + 0.5 - h / 2) * px] as Pt));
    openings.push(rings);
  }
  return { palette: P.map((c) => { const [r, g, b] = labToRgb(c); return hex(r, g, b); }), share, order, openings, pieces, outline, framed, letterLines, letterWidths, lettered, ms: performance.now() - t0 };
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
export interface RedrawHints { inks: { hex: string; name: string; role: string }[]; background: string | null; text: string; font: string; shapes: string; kind?: string; photo?: boolean; textLines?: string[] }
/** The prompt for an AI redraw in flat, cut-ready colours; much sharper when the AI picture check has run. */
export const REDRAW_PROMPT = (n: number, c?: RedrawHints | null) => {
  if (!c) return `Redraw the attached image as a flat colour-separation drawing for multi-layer laser cutting. Straight-on front view, same composition, every shape in the same place - do not redesign. Use exactly ${n} flat colours: no shading, gradients, texture, glow or shadows. Every edge a smooth, flowing, organic curve with crisp edges - no jagged edges, specks or noise. Do not outline colour areas with thin black lines; neighbouring colours touch directly. It will be cut from sheets by a laser, so every gap and detail must be bold: no hairline gaps, cracks or thin slivers. Plain flat background outside the artwork.`;
  const inks = c.inks.map((k) => `${k.name || 'colour'} ${k.hex}${k.role ? ` (${k.role})` : ''}`).join(', ');
  const hasOutline = c.inks.some((k) => /outline/i.test(k.role));
  const bands = c.inks.filter((k) => !/text|letter/i.test(k.role));
  const lines = c.textLines;
  const said = lines && lines.length > 1 ? `, on ${lines.length} lines: ${lines.map((l) => `"${l}"`).join(' / ')}` : `: "${c.text}"`;
  return [
    `The attached image is ${c.photo ? 'a photo of a real piece' : 'a picture'}${c.kind ? ` (${c.kind})` : ''}. Redraw it as clean flat vector-style artwork for multi-layer laser cutting. Straight-on front view, same composition, outline shape and proportions, every shape in exactly the same place - do not redesign or restyle it.`,
    c.shapes ? `The artwork is: ${c.shapes.replace(/[.\s]*$/, "")}.` : '',
    `Use exactly these ${c.inks.length} flat colours and no others: ${inks}.`,
    bands.length >= 3 && /band|offset|concentric|layer|ring/i.test(c.shapes) ? `From the outside in, the bands are: ${bands.map((k) => k.name || k.hex).join(', ')}.` : '',
    'Remove everything that comes from the camera or the material: lighting, shading, shadows between layers, reflections, texture, grain and blur.',
    'Every edge must be a crisp, perfectly smooth curve. Rounded shapes stay perfectly rounded; bands that run alongside each other keep an even width all the way round, like clean offset paths. No jagged edges, wobbles, specks or noise.',
    c.text ? `Keep the lettering exactly as written${said}${c.font ? `, in a clean ${c.font} style` : ''}, same size, weight and position, with crisp letter shapes, exact spelling and clear gaps between letters.` : '',
    'This will be cut from sheets by a laser: every gap, line and detail must be bold. Neighbouring letters either overlap solidly or have a clear gap between them at least half as wide as a letter stroke; no hairline gaps, hairline cracks or thin slivers anywhere.',
    hasOutline ? 'Keep the outline as one even, smooth band.' : 'Do not add thin black outlines; neighbouring colours touch directly.',
    `Plain flat ${c.background ? c.background : 'white'} background outside the artwork. No extra elements, no drop shadow, no 3D effect.`,
  ].filter(Boolean).join(' ');
};

/**
 * Look at a picture before tracing: how many flat colours it really has (background included),
 * how much of it is flat colour at all, and whether it sits on a plain background.
 * Only "flat" pixels count (all 8 neighbours nearly the same), so anti-aliased edges and
 * gradients don't add colours.
 */
export function analysePicture(img: TraceImage): { colours: number; flat: number; plainBg: boolean; found: { hex: string; share: number }[] } {
  const { w, h, data } = img, N = w * h;
  const Lb = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) { const c = lab(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]); Lb[i * 3] = c[0]; Lb[i * 3 + 1] = c[1]; Lb[i * 3 + 2] = c[2]; }
  const d2 = (i: number, j: number) => (Lb[i * 3] - Lb[j * 3]) ** 2 + (Lb[i * 3 + 1] - Lb[j * 3 + 1]) ** 2 + (Lb[i * 3 + 2] - Lb[j * 3 + 2]) ** 2;
  // histogram of flat pixels in coarse Lab bins
  const bins = new Map<number, { n: number; l: number; a: number; b: number }>();
  let flatN = 0, opaque = 0;
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    if (data[i * 4 + 3] < 128) continue;
    opaque++;
    let flat = true;
    for (const q of [i - 1, i + 1, i - w, i + w]) if (d2(i, q) > 5 * 5) { flat = false; break; }
    if (!flat) continue;
    flatN++;
    const l = Lb[i * 3], a = Lb[i * 3 + 1], b = Lb[i * 3 + 2];
    const k = (Math.round(l / 4) * 64 + Math.round(a / 4) + 32) * 64 + Math.round(b / 4) + 32;
    const e = bins.get(k); if (e) { e.n++; e.l += l; e.a += a; e.b += b; } else bins.set(k, { n: 1, l, a, b });
  }
  // greedy peaks: biggest bins first; anything within ΔE 14 joins an existing colour
  const peaks: { n: number; c: number[] }[] = [];
  for (const e of [...bins.values()].sort((p, q) => q.n - p.n)) {
    const c = [e.l / e.n, e.a / e.n, e.b / e.n];
    const near = peaks.find((p) => (p.c[0] - c[0]) ** 2 + (p.c[1] - c[1]) ** 2 + (p.c[2] - c[2]) ** 2 < 12 * 12);
    if (near) near.n += e.n; else peaks.push({ n: e.n, c });
  }
  const found = peaks.slice(0, 20).map((p) => { const [r, g, b] = labToRgb(p.c); return { hex: hex(r, g, b), share: +(p.n * 100 / Math.max(1, flatN)).toFixed(2) }; });
  // plain background: most of the picture's edge is one flat colour
  const edge: number[] = [];
  for (let x = 0; x < w; x += 2) edge.push(x, (h - 1) * w + x);
  for (let y = 0; y < h; y += 2) edge.push(y * w, y * w + w - 1);
  let same = 0; const ref = edge[0];
  // compare against the median-ish corner colour: pick the edge pixel most others match
  let bestRef = ref, bestCount = -1;
  for (const cand of [edge[0], edge[1], edge[Math.floor(edge.length / 2)], edge[edge.length - 1]]) {
    let n = 0; for (const q of edge) if (d2(cand, q) < 10 * 10) n++;
    if (n > bestCount) { bestCount = n; bestRef = cand; }
  }
  for (const q of edge) if (d2(bestRef, q) < 10 * 10) same++;
  const plainBg = same / edge.length > 0.9;
  // small colours count against the artwork, not the background around it
  const art = Math.max(1, flatN - (plainBg && peaks[0] ? peaks[0].n : 0));
  const colours = peaks.filter((p, i) => (plainBg && i === 0) || p.n >= Math.max(20, art * 0.0025)).length;
  return { colours: Math.max(2, Math.min(16, colours)), flat: opaque ? flatN / opaque : 0, plainBg, found };
}
