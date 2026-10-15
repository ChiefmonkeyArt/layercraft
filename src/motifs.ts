// Detail motifs: fill patterns that appear inside individual openings on deeper sheets,
// so the stack is not just one shape echoed down, but patterns within patterns.
import * as G from './geom';
import type { Paths, Pt } from './geom';

export interface MotifDef { id: string; name: string }
export const MOTIFS: MotifDef[] = [
  { id: 'hatch', name: 'Hatching' },
  { id: 'chevron', name: 'Chevrons' },
  { id: 'lattice', name: 'Lattice' },
  { id: 'radial', name: 'Sunburst' },
  { id: 'arcs', name: 'Ripples' },
  { id: 'rosette', name: 'Rosettes' },
  { id: 'swirl', name: 'Scrolls' },
  { id: 'dots', name: 'Perforation' },
  { id: 'eyes', name: 'Eyes' },
];

export interface Cell {
  paths: Paths;          // outer + holes of the opening (scaled ints)
  c: Pt;                 // centroid (mm)
  dist: number; ang: number;
  rMin: number; rMax: number; aMin: number; aMax: number; // polar extent about the design centre
  size: number;          // sqrt(area) in mm
  inR: number;           // rough inner radius (mm)
  bb: [number, number, number, number];
  axis: number;          // direction of the cell's long axis (radians)
  len: number; wid: number; // extent along / across that axis (mm)
  local?: boolean;       // free mode: orient motifs to the cell, not the design centre
}

export function cellInfo(outer: G.Path, holes: G.Path[]): Cell {
  const c = G.centroid(outer);
  const ang = Math.atan2(c[1], c[0]);
  let rMin = Infinity, rMax = 0, aMin = Infinity, aMax = -Infinity;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const q of outer) {
    const x = q.x / G.SCALE, y = q.y / G.SCALE;
    const r = Math.hypot(x, y);
    let a = Math.atan2(y, x) - ang;
    a = Math.atan2(Math.sin(a), Math.cos(a));
    rMin = Math.min(rMin, r); rMax = Math.max(rMax, r);
    aMin = Math.min(aMin, a); aMax = Math.max(aMax, a);
    x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
  }
  const area = Math.abs(G.area(outer)) - holes.reduce((s, h) => s + Math.abs(G.area(h)), 0);
  const size = Math.sqrt(Math.max(0, area));
  // contains the origin? then it wraps all the way round
  if (aMax - aMin > 5.5 || rMin < 1e-3) { aMin = -Math.PI; aMax = Math.PI; rMin = 0; }
  const inR = Math.min(Math.sqrt(Math.max(0, area) / Math.PI) * 0.75, Math.min(x1 - x0, y1 - y0) / 2);
  // long axis from the second moments of the outline (edge-length weighted)
  let sxx = 0, syy = 0, sxy = 0, wsum = 0;
  for (let i = 0, n = outer.length; i < n; i++) {
    const a = outer[i], b = outer[(i + 1) % n];
    const w = Math.hypot(b.x - a.x, b.y - a.y) / G.SCALE;
    const x = (a.x + b.x) / 2 / G.SCALE - c[0], y = (a.y + b.y) / 2 / G.SCALE - c[1];
    sxx += w * x * x; syy += w * y * y; sxy += w * x * y; wsum += w;
  }
  const axis = wsum ? 0.5 * Math.atan2(2 * sxy, sxx - syy) : 0;
  const ux = Math.cos(axis), uy = Math.sin(axis);
  let l0 = Infinity, l1 = -Infinity, w0 = Infinity, w1 = -Infinity;
  for (const q of outer) {
    const x = q.x / G.SCALE - c[0], y = q.y / G.SCALE - c[1];
    const a = x * ux + y * uy, b = -x * uy + y * ux;
    l0 = Math.min(l0, a); l1 = Math.max(l1, a); w0 = Math.min(w0, b); w1 = Math.max(w1, b);
  }
  return { paths: [outer, ...holes], c, dist: Math.hypot(c[0], c[1]), ang, rMin, rMax, aMin, aMax, size, inR, bb: [x0, y0, x1, y1], axis, len: l1 - l0, wid: w1 - w0 };
}

function hatchLines(cell: Cell, theta: number, sp: number, phase = 0): Pt[][] {
  const [x0, y0, x1, y1] = cell.bb;
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, D = Math.hypot(x1 - x0, y1 - y0) / 2 + sp;
  const ux = Math.cos(theta), uy = Math.sin(theta), nx = -uy, ny = ux;
  const out: Pt[][] = [];
  // anchor the grid to the design centre so symmetric cells get symmetric lines
  const off = ((cx * nx + cy * ny) % sp) - phase * sp;
  for (let t = -D - off; t <= D; t += sp) {
    const px = cx + nx * t, py = cy + ny * t;
    out.push([[px - ux * D, py - uy * D], [px + ux * D, py + uy * D]]);
  }
  return out;
}

function halfPlane(cell: Cell, theta: number, side: 1 | -1): Paths {
  const [x0, y0, x1, y1] = cell.bb;
  const cx = cell.c[0], cy = cell.c[1], D = Math.hypot(x1 - x0, y1 - y0) + 10;
  const ux = Math.cos(theta), uy = Math.sin(theta), nx = -uy * side, ny = ux * side;
  return [G.toPath([[cx - ux * D, cy - uy * D], [cx + ux * D, cy + uy * D], [cx + ux * D + nx * D, cy + uy * D + ny * D], [cx - ux * D + nx * D, cy - uy * D + ny * D]])];
}

/** Returns the new openings for this cell: base (already stepped) with the motif applied. */
export function applyMotif(id: string, cell: Cell, base: Paths, sp: number, rib: number, flip: boolean): Paths {
  if (!base.length) return base;
  const tang = cell.ang + Math.PI / 2;
  const cutRibs = (lines: Pt[][]) => G.diff(base, G.bufferLines(lines, rib / 2));
  if (cell.local || id === 'eyes') { const r = localMotif(id, cell, base, sp, rib, flip, cutRibs); if (r) return r; }
  switch (id) {
    case 'hatch':
      return cutRibs(hatchLines(cell, tang, sp));
    case 'lattice':
      return cutRibs([...hatchLines(cell, cell.ang + Math.PI / 4, sp * 1.35), ...hatchLines(cell, cell.ang - Math.PI / 4, sp * 1.35)]);
    case 'chevron': {
      const k = 0.65;
      const a = G.inter(G.bufferLines(hatchLines(cell, tang + k, sp), rib / 2), halfPlane(cell, cell.ang, 1));
      const b = G.inter(G.bufferLines(hatchLines(cell, tang - k, sp), rib / 2), halfPlane(cell, cell.ang, -1));
      const spine = G.bufferLines([[[0, 0], [Math.cos(cell.ang) * (cell.rMax + 5), Math.sin(cell.ang) * (cell.rMax + 5)]]], rib / 2);
      return G.diff(base, G.union(a, [...b, ...spine]));
    }
    case 'radial': {
      const r0 = Math.max(0, cell.rMin - 2), r1 = cell.rMax + 2;
      const da = sp / Math.max(cell.dist, sp * 2);
      const lines: Pt[][] = [];
      for (let a = Math.floor((cell.ang + cell.aMin) / da) * da; a <= cell.ang + cell.aMax + da; a += da) {
        lines.push([[r0 * Math.cos(a), r0 * Math.sin(a)], [r1 * Math.cos(a), r1 * Math.sin(a)]]);
      }
      return cutRibs(lines);
    }
    case 'arcs': {
      const lines: Pt[][] = [];
      const a0 = cell.ang + cell.aMin - 0.05, a1 = cell.ang + cell.aMax + 0.05;
      for (let r = Math.ceil(Math.max(sp, cell.rMin) / sp) * sp; r <= cell.rMax; r += sp) {
        const n = Math.max(8, Math.ceil(((a1 - a0) * r) / 1.2));
        const l: Pt[] = [];
        for (let i = 0; i <= n; i++) { const a = a0 + ((a1 - a0) * i) / n; l.push([r * Math.cos(a), r * Math.sin(a)]); }
        lines.push(l);
      }
      // a couple of radial ties so rings are held by the frame
      for (const a of [cell.ang + cell.aMin * 0.5, cell.ang + cell.aMax * 0.5]) lines.push([[cell.rMin * Math.cos(a), cell.rMin * Math.sin(a)], [cell.rMax * Math.cos(a), cell.rMax * Math.sin(a)]]);
      return cutRibs(lines);
    }
    case 'rosette': {
      const R = cell.inR;
      if (R < sp * 1.2) return base;
      const [cx, cy] = cell.c, n = R > sp * 4 ? 8 : 6, rr = R * 0.5;
      const lines: Pt[][] = [];
      for (let i = 0; i < n; i++) {
        const a = cell.ang + (i / n) * Math.PI * 2;
        const ring = G.circle(cx + rr * Math.cos(a), cy + rr * Math.sin(a), rr, 72);
        lines.push([...ring, ring[0]]);
      }
      const hub = G.circle(cx, cy, rr * 0.38, 48); lines.push([...hub, hub[0]]);
      const halo = G.circle(cx, cy, R * 1.02, 120); lines.push([...halo, halo[0]]);
      return cutRibs(lines);
    }
    case 'swirl': {
      const R = cell.inR * 1.15;
      if (R < sp * 1.2) return base;
      const [cx, cy] = cell.c, turns = Math.max(1.2, Math.min(3, R / sp / 1.1)), dir = flip ? -1 : 1;
      const lines: Pt[][] = [];
      for (const ph of [0, Math.PI]) {
        const l: Pt[] = [];
        const n = Math.ceil(turns * 90);
        for (let i = 0; i <= n; i++) {
          const t = i / n, a = cell.ang + ph + dir * t * turns * Math.PI * 2, r = R * Math.pow(t, 0.9) * 1.05;
          l.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
        }
        lines.push(l);
      }
      return cutRibs(lines);
    }
    case 'dots': {
      const [x0, y0, x1, y1] = cell.bb;
      const d = sp * 0.62, rowH = sp * Math.sqrt(3) / 2;
      const holes: Paths = [];
      let row = Math.floor(y0 / rowH);
      for (let y = row * rowH; y <= y1 + rowH; y += rowH, row++) {
        const sh = (row & 1) * sp / 2;
        for (let x = Math.floor(x0 / sp) * sp + sh; x <= x1 + sp; x += sp) holes.push(G.toPath(G.circle(x, y, d / 2, 20)));
      }
      return G.inter(base, holes);
    }
  }
  return base;
}

/** Motifs oriented to the opening itself (free mode bands), and the Eyes motif everywhere. */
function localMotif(id: string, cell: Cell, base: Paths, sp: number, rib: number, flip: boolean, cutRibs: (l: Pt[][]) => Paths): Paths | null {
  const ax = cell.local ? cell.axis : cell.ang + Math.PI / 2;
  const [cx, cy] = cell.c;
  const ux = Math.cos(ax), uy = Math.sin(ax), nx = -uy, ny = ux;
  const D = Math.hypot(cell.bb[2] - cell.bb[0], cell.bb[3] - cell.bb[1]) / 2 + sp * 2;
  switch (id) {
    case 'hatch': // rungs across the band, like a ladder
      return cutRibs(hatchLines(cell, ax + Math.PI / 2, sp));
    case 'lattice':
      return cutRibs([...hatchLines(cell, ax + Math.PI / 4, sp * 1.35), ...hatchLines(cell, ax - Math.PI / 4, sp * 1.35)]);
    case 'chevron': {
      const k = 0.65, nrm = ax + Math.PI / 2;
      const a = G.inter(G.bufferLines(hatchLines(cell, nrm + k, sp), rib / 2), halfPlane(cell, ax, 1));
      const b = G.inter(G.bufferLines(hatchLines(cell, nrm - k, sp), rib / 2), halfPlane(cell, ax, -1));
      const spine = G.bufferLines([[[cx - ux * D, cy - uy * D], [cx + ux * D, cy + uy * D]]], rib / 2);
      return G.diff(base, G.union(a, [...b, ...spine]));
    }
    case 'radial': { // sunburst from the middle of the opening
      const r0 = sp * 0.9, n = Math.max(8, Math.round((Math.PI * 2 * Math.max(cell.inR, sp * 2)) / sp));
      const lines: Pt[][] = [];
      for (let i = 0; i < n; i++) { const a = ax + (i / n) * Math.PI * 2; lines.push([[cx + r0 * Math.cos(a), cy + r0 * Math.sin(a)], [cx + D * Math.cos(a), cy + D * Math.sin(a)]]); }
      const hub = G.circle(cx, cy, r0, 40); lines.push([...hub, hub[0]]);
      return cutRibs(lines);
    }
    case 'arcs': { // the opening's own shape echoed inwards
      const out: Paths = [];
      let ring = base;
      for (let k = 1; k < 40; k++) {
        const inner = G.offset(base, -k * sp);
        if (!inner.length) break;
        out.push(...G.diff(ring, G.offset(inner, rib / 2)));
        ring = G.offset(inner, -rib / 2);
        if (!ring.length) break;
      }
      out.push(...ring);
      // two ties along the axis so the rings stay attached
      return G.diff(G.union(out), G.bufferLines([[[cx - ux * D, cy - uy * D], [cx + ux * D, cy + uy * D]]], rib / 2));
    }
    case 'eyes': { // almond eyes with an iris, cut as holes so nothing comes loose
      const el = Math.max(sp * 2.4, rib * 7), eh = el * 0.48, ir = eh * 0.3;
      const holes: Paths = [], keep: Paths = [];
      const almond = (ex: number, ey: number) => {
        const pts: Pt[] = [], n = 28;
        for (let i = 0; i <= n; i++) { const t = -1 + (2 * i) / n, w = (eh / 2) * (1 - t * t) ** 0.85; pts.push([ex + ux * t * el / 2 + nx * w, ey + uy * t * el / 2 + ny * w]); }
        for (let i = n - 1; i > 0; i--) { const t = -1 + (2 * i) / n, w = (eh / 2) * (1 - t * t) ** 0.85; pts.push([ex + ux * t * el / 2 - nx * w, ey + uy * t * el / 2 - ny * w]); }
        holes.push(G.toPath(pts));
        keep.push(G.toPath(G.circle(ex, ey, ir, 28)));
        keep.push(...G.bufferLines([[[ex - nx * eh, ey - ny * eh], [ex + nx * eh, ey + ny * eh]]], rib / 2));
      };
      const stepA = el * 1.2, stepN = eh * 1.55;
      const flipOff = flip ? 0.5 : 0;
      for (let j = -Math.ceil(D / stepN); j <= Math.ceil(D / stepN); j++) {
        const sh = ((j & 1) * 0.5 + flipOff) * stepA;
        for (let i = -Math.ceil(D / stepA) - 1; i <= Math.ceil(D / stepA); i++) {
          const a = i * stepA + sh, b = j * stepN;
          almond(cx + ux * a + nx * b, cy + uy * a + ny * b);
        }
      }
      return G.inter(base, G.diff(holes, keep));
    }
  }
  return null;
}

/** Small deterministic hash -> [0,1). */
export function hash01(...v: number[]) {
  let h = 2166136261;
  for (const x of v) { h ^= Math.round(x * 1000) | 0; h = Math.imul(h, 16777619); h ^= h >>> 13; }
  h = Math.imul(h, 0x5bd1e995); h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}
