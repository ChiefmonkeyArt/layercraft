// Procedural pattern generators. Each returns open/closed polylines (mm, centred at 0,0)
// which become the wooden "ribs" of the top layer.
import { Delaunay } from 'd3-delaunay';
import type { Pt } from './geom';

export interface ParamDef { key: string; label: string; min: number; max: number; step: number; def: number }
export interface GenCtx { w: number; h: number; R: number; seed: number; p: Record<string, number> }
export interface GenDef { id: string; name: string; blurb: string; params: ParamDef[]; run: (c: GenCtx) => Pt[][] }

export function rng(seed: number) {
  let a = seed >>> 0 || 1;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TAU = Math.PI * 2;
const pol = (r: number, a: number): Pt => [r * Math.cos(a), r * Math.sin(a)];

function circ(cx: number, cy: number, r: number): Pt[] {
  const n = Math.max(48, Math.ceil(r * 1.6));
  const o: Pt[] = [];
  for (let i = 0; i <= n; i++) { const t = (i / n) * TAU; o.push([cx + r * Math.cos(t), cy + r * Math.sin(t)]); }
  return o;
}

function rotate(lines: Pt[][], n: number, mirror = false): Pt[][] {
  const out: Pt[][] = [];
  for (let k = 0; k < n; k++) {
    const a = (k / n) * TAU, c = Math.cos(a), s = Math.sin(a);
    for (const l of lines) {
      out.push(l.map(([x, y]) => [x * c - y * s, x * s + y * c]));
      if (mirror) out.push(l.map(([x, y]) => [x * c + y * s, x * s - y * c]));
    }
  }
  return out;
}

const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);

export const GENERATORS: GenDef[] = [
  {
    id: 'bloom', name: 'Bloom', blurb: 'Interlocking circle petals, like a carved rosette.',
    params: [
      { key: 'petals', label: 'Petals', min: 5, max: 36, step: 1, def: 16 },
      { key: 'families', label: 'Petal families', min: 1, max: 4, step: 1, def: 1 },
      { key: 'rings', label: 'Rings', min: 0, max: 10, step: 1, def: 2 },
      { key: 'reach', label: 'Reach', min: 0.3, max: 1.4, step: 0.01, def: 0.9 },
      { key: 'hub', label: 'Open heart', min: 0, max: 0.4, step: 0.01, def: 0.1 },
    ],
    run: ({ R, p }) => {
      const out: Pt[][] = [];
      const n = p.petals, base = R * p.reach * 0.5;
      for (let j = 0; j < p.families; j++) {
        const r = base * (1 + j * 0.55), off = (j * Math.PI) / n;
        for (let k = 0; k < n; k++) { const [cx, cy] = pol(r, (k / n) * TAU + off); out.push(circ(cx, cy, r * (1 - p.hub))); }
      }
      for (let i = 1; i <= p.rings; i++) out.push(circ(0, 0, R * 0.08 + (R * 0.95 * i) / (p.rings + 1)));
      const seedR = R * 0.05;
      for (let k = 0; k < 6; k++) { const [cx, cy] = pol(seedR, (k / 6) * TAU); out.push(circ(cx, cy, seedR)); }
      out.push(circ(0, 0, seedR * 2));
      return out;
    },
  },
  {
    id: 'lotus', name: 'Lotus', blurb: 'Concentric rings of pointed petals, mandala style.',
    params: [
      { key: 'petals', label: 'Petals', min: 4, max: 32, step: 1, def: 12 },
      { key: 'tiers', label: 'Tiers', min: 2, max: 8, step: 1, def: 4 },
      { key: 'sharp', label: 'Sharpness', min: 0.3, max: 3, step: 0.05, def: 1.4 },
      { key: 'overlap', label: 'Overlap', min: 1, max: 2.2, step: 0.05, def: 1.5 },
    ],
    run: ({ R, p }) => {
      const out: Pt[][] = [];
      const n = p.petals, m = p.tiers;
      const r0 = R * 0.1;
      for (let i = 0; i < m; i++) {
        const rin = r0 + ((R - r0) * i) / m;
        const rout = Math.min(R * 1.05, rin + (((R - r0) / m) * p.overlap));
        const off = i % 2 ? Math.PI / n : 0;
        const w = (Math.PI / n) * 0.98;
        for (let k = 0; k < n; k++) {
          const th = (k / n) * TAU + off;
          const pts: Pt[] = [];
          const S = 40;
          for (let s = 0; s <= S; s++) { const t = s / S; const a = th - w * (1 - Math.pow(t, p.sharp)) * Math.sin(Math.PI * (0.5 + t * 0.5)) ; pts.push(pol(rin + (rout - rin) * t, a)); }
          for (let s = S; s >= 0; s--) { const t = s / S; const a = th + w * (1 - Math.pow(t, p.sharp)) * Math.sin(Math.PI * (0.5 + t * 0.5)); pts.push(pol(rin + (rout - rin) * t, a)); }
          pts.push(pts[0]);
          out.push(pts);
        }
        out.push(circ(0, 0, rin));
      }
      out.push(circ(0, 0, r0 * 0.5));
      return out;
    },
  },
  {
    id: 'spiral', name: 'Sunflower', blurb: 'Counter-rotating spirals that weave diamond cells.',
    params: [
      { key: 'arms', label: 'Arms', min: 5, max: 40, step: 1, def: 21 },
      { key: 'counter', label: 'Counter arms', min: 0, max: 40, step: 1, def: 13 },
      { key: 'pitch', label: 'Pitch', min: 0.1, max: 0.6, step: 0.01, def: 0.26 },
      { key: 'core', label: 'Core', min: 0.02, max: 0.3, step: 0.01, def: 0.08 },
    ],
    run: ({ R, p }) => {
      const out: Pt[][] = [];
      const rmin = R * p.core, k = p.pitch;
      const thMax = Math.log((R * 1.05) / rmin) / k;
      const spiral = (dir: number, off: number) => {
        const pts: Pt[] = [];
        const N = 260;
        for (let i = 0; i <= N; i++) { const th = (i / N) * thMax; pts.push(pol(rmin * Math.exp(k * th), dir * th + off)); }
        return pts;
      };
      for (let j = 0; j < p.arms; j++) out.push(spiral(1, (j / p.arms) * TAU));
      for (let j = 0; j < p.counter; j++) out.push(spiral(-1, (j / p.counter) * TAU));
      out.push(circ(0, 0, rmin));
      return out;
    },
  },
  {
    id: 'spiro', name: 'Spirograph', blurb: 'Looping hypotrochoids — the most psychedelic one.',
    params: [
      { key: 'lobes', label: 'Lobes', min: 3, max: 24, step: 1, def: 9 },
      { key: 'turns', label: 'Wheel', min: 2, max: 13, step: 1, def: 4 },
      { key: 'pen', label: 'Pen offset', min: 0.2, max: 1.6, step: 0.01, def: 0.85 },
      { key: 'copies', label: 'Copies', min: 1, max: 4, step: 1, def: 2 },
    ],
    run: ({ R, p }) => {
      const out: Pt[][] = [];
      for (let c = 0; c < p.copies; c++) {
        const big = p.lobes * p.turns, small = p.turns + c; // ring/wheel teeth
        const Rr = big, r = small, d = r * p.pen * (1 - c * 0.18);
        const period = (r / gcd(Rr, r)) * TAU;
        const N = Math.min(9000, Math.ceil(period * 60));
        const raw: Pt[] = [];
        let maxR = 0;
        for (let i = 0; i <= N; i++) {
          const t = (i / N) * period;
          const x = (Rr - r) * Math.cos(t) + d * Math.cos(((Rr - r) / r) * t);
          const y = (Rr - r) * Math.sin(t) - d * Math.sin(((Rr - r) / r) * t);
          raw.push([x, y]); maxR = Math.max(maxR, Math.hypot(x, y));
        }
        const s = (R * (0.98 - c * 0.22)) / maxR, rot = (c * Math.PI) / p.lobes;
        const cs = Math.cos(rot), sn = Math.sin(rot);
        out.push(raw.map(([x, y]) => [(x * cs - y * sn) * s, (x * sn + y * cs) * s]));
      }
      out.push(circ(0, 0, R * 0.04));
      return out;
    },
  },
  {
    id: 'ripple', name: 'Ripple tunnel', blurb: 'Warped rings and bending spokes for a vortex.',
    params: [
      { key: 'rings', label: 'Rings', min: 3, max: 20, step: 1, def: 9 },
      { key: 'waves', label: 'Waves', min: 0, max: 16, step: 1, def: 6 },
      { key: 'amp', label: 'Wobble', min: 0, max: 0.3, step: 0.005, def: 0.09 },
      { key: 'twist', label: 'Twist', min: 0, max: 1.5, step: 0.01, def: 0.35 },
      { key: 'spokes', label: 'Spokes', min: 0, max: 48, step: 1, def: 18 },
      { key: 'bend', label: 'Spoke bend', min: -3, max: 3, step: 0.05, def: 1.2 },
    ],
    run: ({ R, p }) => {
      const out: Pt[][] = [];
      const r0 = R * 0.07;
      for (let k = 0; k < p.rings; k++) {
        const rk = r0 + ((R * 1.05 - r0) * Math.pow((k + 1) / p.rings, 1.25));
        const pts: Pt[] = [];
        const N = 360;
        for (let i = 0; i <= N; i++) { const th = (i / N) * TAU; pts.push(pol(rk * (1 + p.amp * Math.sin(p.waves * th + k * p.twist)), th)); }
        out.push(pts);
      }
      for (let s = 0; s < p.spokes; s++) {
        const pts: Pt[] = [];
        const a0 = (s / p.spokes) * TAU;
        for (let i = 0; i <= 120; i++) { const t = i / 120; const r = r0 + (R * 1.1 - r0) * t; pts.push(pol(r, a0 + p.bend * t * t)); }
        out.push(pts);
      }
      out.push(circ(0, 0, r0));
      return out;
    },
  },
  {
    id: 'flower', name: 'Flower of life', blurb: 'Hexagonal lattice of overlapping circles.',
    params: [
      { key: 'radius', label: 'Circle size', min: 0.05, max: 0.5, step: 0.005, def: 0.18 },
      { key: 'extent', label: 'Extent', min: 1, max: 6, step: 1, def: 3 },
      { key: 'halo', label: 'Halo rings', min: 0, max: 4, step: 1, def: 1 },
    ],
    run: ({ R, p }) => {
      const out: Pt[][] = [];
      const r = R * p.radius;
      const E = p.extent;
      for (let q = -E; q <= E; q++) for (let s = -E; s <= E; s++) {
        if (Math.abs(q + s) > E) continue;
        const x = r * (q + s / 2), y = r * (s * Math.sqrt(3) / 2);
        out.push(circ(x, y, r));
      }
      for (let i = 1; i <= p.halo; i++) out.push(circ(0, 0, r * (E + i * 0.55)));
      return out;
    },
  },
  {
    id: 'truchet', name: 'Truchet maze', blurb: 'Random quarter-arc tiles mirrored into a kaleidoscope.',
    params: [
      { key: 'tile', label: 'Tile size (mm)', min: 8, max: 60, step: 1, def: 24 },
      { key: 'mirror', label: 'Mirror (0/1/2)', min: 0, max: 2, step: 1, def: 2 },
      { key: 'grid', label: 'Grid lines', min: 0, max: 1, step: 1, def: 1 },
    ],
    run: ({ w, h, seed, p }) => {
      const out: Pt[][] = [];
      const rand = rng(seed);
      const t = p.tile;
      const nx = Math.ceil(w / 2 / t) + 1, ny = Math.ceil(h / 2 / t) + 1;
      const arc = (cx: number, cy: number, a0: number): Pt[] => {
        const pts: Pt[] = [];
        for (let i = 0; i <= 16; i++) { const a = a0 + (i / 16) * (Math.PI / 2); pts.push([cx + (t / 2) * Math.cos(a), cy + (t / 2) * Math.sin(a)]); }
        return pts;
      };
      const flips = new Map<string, boolean>();
      const flip = (i: number, j: number) => {
        const key = p.mirror >= 2 ? `${Math.abs(i + 0.5)},${Math.abs(j + 0.5)}` : p.mirror >= 1 ? `${Math.abs(i + 0.5)},${j}` : `${i},${j}`;
        if (!flips.has(key)) flips.set(key, rand() < 0.5);
        const f = flips.get(key)!;
        const mx = p.mirror >= 1 && i < 0, my = p.mirror >= 2 && j < 0;
        return f !== (mx !== my);
      };
      for (let i = -nx; i < nx; i++) for (let j = -ny; j < ny; j++) {
        const x0 = i * t, y0 = j * t;
        if (flip(i, j)) { out.push(arc(x0, y0, 0)); out.push(arc(x0 + t, y0 + t, Math.PI)); }
        else { out.push(arc(x0 + t, y0, Math.PI / 2)); out.push(arc(x0, y0 + t, -Math.PI / 2)); }
      }
      if (p.grid) {
        for (let i = -nx; i <= nx; i++) out.push([[i * t, -ny * t], [i * t, ny * t]]);
        for (let j = -ny; j <= ny; j++) out.push([[-nx * t, j * t], [nx * t, j * t]]);
      }
      return out;
    },
  },
  {
    id: 'voronoi', name: 'Kaleido cells', blurb: 'Organic Voronoi cells folded with rotational symmetry.',
    params: [
      { key: 'cells', label: 'Cells per slice', min: 3, max: 60, step: 1, def: 14 },
      { key: 'sym', label: 'Symmetry', min: 1, max: 16, step: 1, def: 8 },
      { key: 'mirror', label: 'Mirror', min: 0, max: 1, step: 1, def: 1 },
      { key: 'relax', label: 'Smoothness', min: 0, max: 6, step: 1, def: 2 },
    ],
    run: ({ w, h, R, seed, p }) => {
      const rand = rng(seed);
      const n = p.sym;
      const wedge = TAU / n / (p.mirror ? 2 : 1);
      let base: Pt[] = [];
      for (let i = 0; i < p.cells; i++) { const r = R * Math.sqrt(0.02 + 0.98 * rand()) * 1.05; base.push(pol(r, rand() * wedge)); }
      const expand = (pts: Pt[]) => {
        const all: Pt[] = [];
        for (let k = 0; k < n; k++) {
          const a = (k / n) * TAU, c = Math.cos(a), s = Math.sin(a);
          for (const [x, y] of pts) {
            all.push([x * c - y * s, x * s + y * c]);
            if (p.mirror) all.push([x * c + y * s, x * s - y * c]);
          }
        }
        return all;
      };
      const bounds: [number, number, number, number] = [-w / 2 - 20, -h / 2 - 20, w / 2 + 20, h / 2 + 20];
      for (let it = 0; it < p.relax; it++) {
        const all = expand(base);
        const v = Delaunay.from(all).voronoi(bounds);
        base = base.map((_, i) => {
          const idx = i * (p.mirror ? 2 : 1);
          const poly = v.cellPolygon(idx);
          if (!poly) return base[i];
          let cx = 0, cy = 0; for (const [x, y] of poly) { cx += x; cy += y; }
          const c: Pt = [cx / poly.length, cy / poly.length];
          const a = Math.atan2(c[1], c[0]);
          // keep the seed inside its wedge so symmetry stays clean
          const aa = Math.min(wedge * 0.98, Math.max(wedge * 0.02, a));
          return pol(Math.hypot(c[0], c[1]), aa);
        });
      }
      const all = expand(base);
      const v = Delaunay.from(all).voronoi(bounds);
      const out: Pt[][] = [];
      for (const poly of v.cellPolygons()) out.push(poly.map(([x, y]) => [x, y] as Pt));
      return out;
    },
  },
];

export function genById(id: string) { return GENERATORS.find((g) => g.id === id) ?? GENERATORS[0]; }

export function defaultsFor(id: string): Record<string, number> {
  const o: Record<string, number> = {};
  for (const d of genById(id).params) o[d.key] = d.def;
  return o;
}

export function randomParams(id: string, rand: () => number): Record<string, number> {
  const o: Record<string, number> = {};
  for (const d of genById(id).params) {
    const span = d.max - d.min;
    // bias toward the middle of the range so results stay cuttable
    const t = 0.15 + 0.7 * rand();
    o[d.key] = Math.round((d.min + span * t) / d.step) * d.step;
    o[d.key] = +o[d.key].toFixed(4);
  }
  return o;
}

export { rotate, circ };
