/**
 * Curve fitting for traced outlines, the way font tracers work: find the real corners, then fit
 * the fewest smooth cubic curves between them that stay within a small tolerance of the traced
 * edge. Pixel wobble (smaller than the tolerance) disappears; corners stay sharp; curves are
 * smooth and joined without kinks. (Least-squares cubic fitting after P. J. Schneider,
 * "An Algorithm for Automatically Fitting Digitized Curves", Graphics Gems, 1990.)
 */
export type Pt = [number, number];

const sub = (a: Pt, b: Pt): Pt => [a[0] - b[0], a[1] - b[1]];
const add = (a: Pt, b: Pt): Pt => [a[0] + b[0], a[1] + b[1]];
const mul = (a: Pt, s: number): Pt => [a[0] * s, a[1] * s];
const dot = (a: Pt, b: Pt) => a[0] * b[0] + a[1] * b[1];
const len = (a: Pt) => Math.hypot(a[0], a[1]);
const unit = (a: Pt): Pt => { const l = len(a) || 1; return [a[0] / l, a[1] / l]; };

type Bez = [Pt, Pt, Pt, Pt];
const bez = (b: Bez, t: number): Pt => {
  const u = 1 - t, a = u * u * u, c = 3 * u * u * t, d = 3 * u * t * t, e = t * t * t;
  return [a * b[0][0] + c * b[1][0] + d * b[2][0] + e * b[3][0], a * b[0][1] + c * b[1][1] + d * b[2][1] + e * b[3][1]];
};
const bez1 = (b: Bez, t: number): Pt => {
  const u = 1 - t;
  return [3 * (u * u * (b[1][0] - b[0][0]) + 2 * u * t * (b[2][0] - b[1][0]) + t * t * (b[3][0] - b[2][0])),
    3 * (u * u * (b[1][1] - b[0][1]) + 2 * u * t * (b[2][1] - b[1][1]) + t * t * (b[3][1] - b[2][1]))];
};
const bez2 = (b: Bez, t: number): Pt => {
  const u = 1 - t;
  return [6 * (u * (b[2][0] - 2 * b[1][0] + b[0][0]) + t * (b[3][0] - 2 * b[2][0] + b[1][0])),
    6 * (u * (b[2][1] - 2 * b[1][1] + b[0][1]) + t * (b[3][1] - 2 * b[2][1] + b[1][1]))];
};

function chordParams(p: Pt[]): number[] {
  const u = [0];
  for (let i = 1; i < p.length; i++) u.push(u[i - 1] + len(sub(p[i], p[i - 1])));
  const L = u[u.length - 1] || 1;
  return u.map((v) => v / L);
}

function generate(p: Pt[], u: number[], t1: Pt, t2: Pt): Bez {
  const a = p[0], b = p[p.length - 1];
  let c00 = 0, c01 = 0, c11 = 0, x0 = 0, x1 = 0;
  for (let i = 0; i < p.length; i++) {
    const t = u[i], s = 1 - t, b0 = s * s * s, b1 = 3 * s * s * t, b2 = 3 * s * t * t, b3 = t * t * t;
    const A1 = mul(t1, b1), A2 = mul(t2, b2);
    c00 += dot(A1, A1); c01 += dot(A1, A2); c11 += dot(A2, A2);
    const tmp = sub(p[i], add(mul(a, b0 + b1), mul(b, b2 + b3)));
    x0 += dot(A1, tmp); x1 += dot(A2, tmp);
  }
  const det = c00 * c11 - c01 * c01;
  let al = det ? (x0 * c11 - x1 * c01) / det : 0, ar = det ? (c00 * x1 - c01 * x0) / det : 0;
  const seg = len(sub(b, a)), eps = 1e-6 * seg;
  if (al < eps || ar < eps || al > seg * 2 || ar > seg * 2) { al = ar = seg / 3; }
  return [a, add(a, mul(t1, al)), add(b, mul(t2, ar)), b];
}

function maxError(p: Pt[], b: Bez, u: number[]): [number, number] {
  let md = 0, mi = Math.floor(p.length / 2);
  for (let i = 1; i < p.length - 1; i++) { const d = len(sub(bez(b, u[i]), p[i])); if (d > md) { md = d; mi = i; } }
  return [md, mi];
}

function reparam(p: Pt[], u: number[], b: Bez): number[] {
  return u.map((t, i) => {
    const d = sub(bez(b, t), p[i]), q1 = bez1(b, t), q2 = bez2(b, t);
    const num = dot(d, q1), den = dot(q1, q1) + dot(d, q2);
    const nt = den ? t - num / den : t;
    return Math.max(0, Math.min(1, nt));
  });
}

function fitCubic(p: Pt[], t1: Pt, t2: Pt, tol: number, out: Bez[], depth = 0) {
  if (p.length === 2) { const d = len(sub(p[1], p[0])) / 3; out.push([p[0], add(p[0], mul(t1, d)), add(p[1], mul(t2, d)), p[1]]); return; }
  let u = chordParams(p), b = generate(p, u, t1, t2);
  let [err, split] = maxError(p, b, u);
  if (err <= tol) { out.push(b); return; }
  if (err <= tol * 4) {
    for (let k = 0; k < 6; k++) {
      u = reparam(p, u, b); b = generate(p, u, t1, t2);
      [err, split] = maxError(p, b, u);
      if (err <= tol) { out.push(b); return; }
    }
  }
  if (depth > 18 || p.length < 4) { out.push(b); return; }
  split = Math.max(1, Math.min(p.length - 2, split));
  const tc = unit(sub(p[split - 1], p[split + 1]));
  fitCubic(p.slice(0, split + 1), t1, tc, tol, out, depth + 1);
  fitCubic(p.slice(split), mul(tc, -1), t2, tol, out, depth + 1);
}

/** evenly spaced points along a closed ring */
function resample(p: Pt[], step: number): Pt[] {
  const out: Pt[] = [];
  let carry = 0;
  for (let i = 0; i < p.length; i++) {
    const a = p[i], b = p[(i + 1) % p.length], L = len(sub(b, a));
    let t = carry;
    while (t < L) { out.push([a[0] + (b[0] - a[0]) * t / L, a[1] + (b[1] - a[1]) * t / L]); t += step; }
    carry = t - L;
  }
  return out;
}

/**
 * Fit smooth curves to a closed traced ring (pixel units).
 * tol: how far (px) the curve may stray from the traced edge (pixel wobble below this goes);
 * cornerDeg: a turn sharper than this over ~2 px on each side is a real corner and stays sharp.
 * Returns a dense polyline of the fitted curves (step px apart).
 */
export function fitRing(ring: Pt[], tol = 0.7, cornerDeg = 50, step = 0.35): Pt[] {
  if (ring.length < 8) return ring;
  const per = ring.reduce((a, q, i) => a + len(sub(ring[(i + 1) % ring.length], q)), 0);
  if (per < 6) return ring;
  const ds = 0.5;
  // light de-jitter of the marching-squares staircase (keeps shape; corners found after)
  let p = resample(ring, ds);
  const n = p.length;
  if (n < 12) return ring;
  {
    const q = p.map((_, i) => {
      const a = p[(i - 1 + n) % n], b = p[i], c = p[(i + 1) % n];
      return [(a[0] + 2 * b[0] + c[0]) / 4, (a[1] + 2 * b[1] + c[1]) / 4] as Pt;
    });
    p = q;
  }
  // corners: sharp turn between the chords 2 px back and 2 px ahead, local maximum
  const k = Math.max(2, Math.round(2 / ds));
  const turn = p.map((_, i) => {
    const a = p[(i - k + n) % n], b = p[i], c = p[(i + k) % n];
    const v1 = unit(sub(b, a)), v2 = unit(sub(c, b));
    return Math.acos(Math.max(-1, Math.min(1, dot(v1, v2)))) * 180 / Math.PI;
  });
  const corners: number[] = [];
  for (let i = 0; i < n; i++) {
    if (turn[i] < cornerDeg) continue;
    let isMax = true;
    for (let j = -k; j <= k; j++) { if (j && turn[(i + j + n) % n] > turn[i]) { isMax = false; break; } if (j > 0 && j && turn[(i + j + n) % n] === turn[i]) { isMax = false; break; } }
    if (isMax) corners.push(i);
  }
  const tangentAt = (i: number) => unit(sub(p[(i + 2) % n], p[(i - 2 + n) % n]));
  const bezs: Bez[] = [];
  const spans: [number, number, Pt, Pt][] = [];
  if (!corners.length) {
    // smooth loop: split into four spans with shared (continuous) tangents
    const idx = [0, Math.floor(n / 4), Math.floor(n / 2), Math.floor(3 * n / 4)];
    for (let s = 0; s < 4; s++) { const a = idx[s], b = idx[(s + 1) % 4]; const ta = tangentAt(a), tb = tangentAt(b); spans.push([a, b, ta, mul(tb, -1)]); }
  } else {
    for (let s = 0; s < corners.length; s++) {
      const a = corners[s], b = corners[(s + 1) % corners.length];
      const span = ((b - a + n) % n) || n;
      // one-sided tangents at corners (the curve leaves/arrives along its own side)
      const m = Math.min(Math.max(2, Math.round(1.5 / ds)), Math.max(1, Math.floor(span / 3)));
      const ta = unit(sub(p[(a + m) % n], p[a])), tb = unit(sub(p[(b - m + n) % n], p[b]));
      spans.push([a, b, ta, tb]);
    }
  }
  for (const [a, b, ta, tb] of spans) {
    const pts: Pt[] = [];
    const span = ((b - a + n) % n) || n;
    for (let j = 0; j <= span; j++) pts.push(p[(a + j) % n]);
    if (pts.length < 2) continue;
    fitCubic(pts, ta, tb, tol, bezs);
  }
  // sample the curves
  const out: Pt[] = [];
  for (const b of bezs) {
    const L = len(sub(b[1], b[0])) + len(sub(b[2], b[1])) + len(sub(b[3], b[2]));
    const m = Math.max(2, Math.ceil(L / step));
    for (let j = 0; j < m; j++) out.push(bez(b, j / m));
  }
  return out.length >= 3 ? out : ring;
}
