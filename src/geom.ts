// Typed wrapper around Clipper (WASM build): integer polygon booleans + offsets.
// Units: 1 mm = SCALE integer units. Call initGeom() once before use.
import * as clipperLib from 'js-angusj-clipper/web/index.js';

import { clip2 } from './clip2';

let C: clipperLib.ClipperLibWrapper;
export let geomBackend = 'none';
const withTimeout = <T,>(p: Promise<T>, ms: number) =>
  Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);

/** Instant check: some in-app viewers block WebAssembly entirely (CSP or Lockdown Mode). */
function wasmAllowed(): boolean {
  try {
    if (typeof WebAssembly !== 'object') return false;
    const m = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
    return m instanceof WebAssembly.Module;
  } catch { return false; }
}

/** Load the fastest available Clipper: WebAssembly, else pure-JavaScript Clipper2. */
export async function initGeom(forceJs = false) {
  if (C) return geomBackend;
  if (!forceJs && wasmAllowed()) {
    try {
      const lib = await withTimeout(clipperLib.loadNativeClipperLibInstanceAsync(clipperLib.NativeClipperLibRequestedFormat.WasmOnly), 4000);
      if (lib) { C = lib; geomBackend = 'wasmOnly'; return geomBackend; }
    } catch { /* fall through to pure JS */ }
  }
  C = clip2 as unknown as clipperLib.ClipperLibWrapper;
  geomBackend = 'js';
  return geomBackend;
}

export const SCALE = 1000;
export type IPt = { x: number; y: number };
export type Path = IPt[];
export type Paths = Path[];
export type Pt = [number, number];

export interface Group { outer: Path; holes: Path[] }

export let ARC_TOL = 0.08 * SCALE;
export function setArcTol(mm: number) { ARC_TOL = mm * SCALE; }
const NZ = clipperLib.PolyFillType.NonZero;

export function toPath(pts: Pt[]): Path {
  return pts.map(([x, y]) => ({ x: Math.round(x * SCALE), y: Math.round(y * SCALE) }));
}

function exec(clipType: clipperLib.ClipType, subj: Paths, clip: Paths = [], fill = NZ): Paths {
  if (!subj.length) return [];
  return C.clipToPaths({
    clipType, subjectFillType: fill, clipFillType: fill,
    subjectInputs: [{ data: subj, closed: true }],
    clipInputs: clip.length ? [{ data: clip }] : [],
  }) as Paths;
}

export const union = (a: Paths, b: Paths = []) => exec(clipperLib.ClipType.Union, [...a, ...b]);
export const diff = (a: Paths, b: Paths) => (b.length ? exec(clipperLib.ClipType.Difference, a, b) : union(a));
export const inter = (a: Paths, b: Paths) => (a.length && b.length ? exec(clipperLib.ClipType.Intersection, a, b) : []);
export const unionEvenOdd = (a: Paths) => exec(clipperLib.ClipType.Union, a, [], clipperLib.PolyFillType.EvenOdd);

export function offset(paths: Paths, deltaMm: number, join: 'round' | 'miter' = 'round'): Paths {
  if (!paths.length) return [];
  if (Math.abs(deltaMm) < 1e-6) return paths;
  return (C.offsetToPaths({
    delta: deltaMm * SCALE, arcTolerance: ARC_TOL, miterLimit: 2,
    offsetInputs: [{ data: paths, joinType: join === 'round' ? clipperLib.JoinType.Round : clipperLib.JoinType.Miter, endType: clipperLib.EndType.ClosedPolygon }],
  }) ?? []) as Paths;
}

/** Buffer open polylines into solid ribs of the given half-width. */
export function bufferLines(lines: Pt[][], halfWidthMm: number): Paths {
  const paths = lines.filter((l) => l.length > 1).map(toPath);
  if (!paths.length) return [];
  return (C.offsetToPaths({
    delta: halfWidthMm * SCALE, arcTolerance: ARC_TOL, miterLimit: 2,
    offsetInputs: [{ data: paths, joinType: clipperLib.JoinType.Miter, endType: clipperLib.EndType.OpenRound }],
  }) ?? []) as Paths;
}

export function area(p: Path): number {
  return C.area(p) / (SCALE * SCALE);
}

export function clean(paths: Paths, distMm = 0.02): Paths {
  return C.cleanPolygons(paths, distMm * SCALE) as Paths;
}

export function dropSmall(paths: Paths, minAreaMm2: number): Paths {
  return paths.filter((p) => Math.abs(area(p)) >= minAreaMm2);
}

/** Buffer each line on its own (no global union); callers clip with non-zero fill. */
export function bufferLinesRaw(lines: Pt[][], halfWidthMm: number): Paths {
  const out: Paths = [];
  for (const l of lines) {
    if (l.length < 2) continue;
    const r = C.offsetToPaths({
      delta: halfWidthMm * SCALE, arcTolerance: ARC_TOL, miterLimit: 2,
      offsetInputs: [{ data: [toPath(l)], joinType: clipperLib.JoinType.Miter, endType: clipperLib.EndType.OpenRound }],
    }) as Paths | undefined;
    if (r) out.push(...r);
  }
  return out;
}

/** Morphological opening: removes features thinner than 2*r. */
export function morphOpen(paths: Paths, rMm: number, join: 'round' | 'miter' = 'round'): Paths {
  if (rMm <= 0) return paths;
  return offset(offset(paths, -rMm, join), rMm, join);
}

/** Groups closed paths into outer contours with their direct holes (all depths). */
export function groups(paths: Paths): Group[] {
  if (!paths.length) return [];
  const tree = C.clipToPolyTree({ clipType: clipperLib.ClipType.Union, subjectFillType: NZ, subjectInputs: [{ data: paths, closed: true }] });
  const res: Group[] = [];
  const walk = (node: clipperLib.PolyNode) => {
    for (const ch of node.childs) {
      if (!ch.isHole) {
        const holes: Path[] = [];
        for (const h of ch.childs) { holes.push(h.contour as Path); walk(h); }
        res.push({ outer: ch.contour as Path, holes });
      }
    }
  };
  walk(tree);
  return res;
}

export function centroid(p: Path): Pt {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0, n = p.length; i < n; i++) {
    const p0 = p[i], p1 = p[(i + 1) % n];
    const f = p0.x * p1.y - p1.x * p0.y;
    a += f; cx += (p0.x + p1.x) * f; cy += (p0.y + p1.y) * f;
  }
  if (Math.abs(a) < 1e-9) {
    const s = p.reduce((acc, q) => [acc[0] + q.x, acc[1] + q.y], [0, 0]);
    return [s[0] / p.length / SCALE, s[1] / p.length / SCALE];
  }
  return [cx / (3 * a) / SCALE, cy / (3 * a) / SCALE];
}

export function transform(p: Path, cos: number, sin: number, dx: number, dy: number): Path {
  const tx = dx * SCALE, ty = dy * SCALE;
  return p.map((q) => ({ x: Math.round(q.x * cos - q.y * sin + tx), y: Math.round(q.x * sin + q.y * cos + ty) }));
}

export function perimeter(paths: Paths): number {
  let L = 0;
  for (const p of paths) for (let i = 0; i < p.length; i++) {
    const a = p[i], b = p[(i + 1) % p.length];
    L += Math.hypot(a.x - b.x, a.y - b.y);
  }
  return L / SCALE;
}

export function totalArea(paths: Paths): number {
  return paths.reduce((s, p) => s + area(p), 0);
}

export function circle(cx: number, cy: number, r: number, seg = 0): Pt[] {
  const n = seg || Math.max(24, Math.ceil(r * 2.5));
  const out: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2;
    out.push([cx + r * Math.cos(t), cy + r * Math.sin(t)]);
  }
  return out;
}

/** Orient a path: positive area for outers, negative for holes. */
export function orient(p: Path, positive: boolean): Path {
  return (C.area(p) > 0) === positive ? p : p.slice().reverse();
}

/**
 * Openings split into groups, plus the material islands they enclose and the
 * top-level outlines, from a single polytree pass.
 * - groups: each opening (outer + its holes), flattened across nesting levels
 * - islands: material inside an opening's hole (outer = that hole, holes = openings nested in it)
 * - tops: outer contours of openings that are not inside any island
 */
export function openingTree(paths: Paths): { groups: Group[]; islands: Group[]; tops: Path[] } {
  const groups: Group[] = [], islands: Group[] = [], tops: Path[] = [];
  if (!paths.length) return { groups, islands, tops };
  const tree = C.clipToPolyTree({ clipType: clipperLib.ClipType.Union, subjectFillType: NZ, subjectInputs: [{ data: paths, closed: true }] });
  const walk = (node: clipperLib.PolyNode, top: boolean) => {
    for (const ch of node.childs) {
      if (ch.isHole) continue;
      const outer = orient(ch.contour as Path, true);
      if (top) tops.push(outer);
      const holes: Path[] = [];
      for (const hn of ch.childs) {
        const hole = orient(hn.contour as Path, false);
        holes.push(hole);
        islands.push({ outer: orient(hole, true), holes: hn.childs.filter((k) => !k.isHole).map((k) => orient(k.contour as Path, false)) });
        walk(hn, false);
      }
      groups.push({ outer, holes });
    }
  };
  walk(tree, true);
  return { groups, islands, tops };
}

/** Cheap content hash of a group, used to memoise per-opening work across edits. */
export function groupHash(g: Group): string {
  let a = 0x811c9dc5 | 0, b = 0x9e3779b9 | 0, n = 0;
  for (const p of [g.outer, ...g.holes]) {
    a = Math.imul(a ^ p.length, 16777619); n += p.length;
    for (const q of p) { a = Math.imul(a ^ q.x, 16777619); b = Math.imul(b ^ q.y, 2246822507) + (b >>> 13); }
  }
  return `${n}:${(a >>> 0).toString(36)}:${(b >>> 0).toString(36)}`;
}

export function pathsHash(ps: Paths): string {
  let a = 0x811c9dc5 | 0, n = 0;
  for (const p of ps) { n += p.length; for (let i = 0; i < p.length; i += 7) a = Math.imul(a ^ (p[i].x + 31 * p[i].y), 16777619); }
  return `${ps.length}:${n}:${(a >>> 0).toString(36)}`;
}

export function bbox(ps: Paths): [number, number, number, number] {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of ps) for (const q of p) { if (q.x < x0) x0 = q.x; if (q.x > x1) x1 = q.x; if (q.y < y0) y0 = q.y; if (q.y > y1) y1 = q.y; }
  return [x0, y0, x1, y1];
}
