// The layer engine: top layer design -> N iterated layers -> solid back.
import * as G from './geom';
import type { Paths, Pt } from './geom';
import { genById } from './generators';
import { MOTIFS, applyMotif, cellInfo, hash01 } from './motifs';
import type { FreeArt, MirrorMode } from './free';
import { freeOutlines, freeStrokes } from './free';
import { clipLines, cornerStrokes, cornersOn, dividerEllipse, insideDivider } from './corners';

export type Shape = 'rect' | 'circle' | 'hex';
export type DriftMode = 'none' | 'light' | 'in' | 'out';

export interface Settings {
  shape: Shape; width: number; height: number; border: number;
  material: string; thickness: number;
  rib: number; minRib: number; minOpening: number;
  step: number; stepCurve: number;
  driftMode: DriftMode; drift: number; lightAngle: number; twist: number;
  maxLayers: number; back: boolean;
  kerf: number; regHoles: boolean; regDia: number; numbers: boolean;
  bedW: number; bedH: number;
  gen: string; seed: number; params: Record<string, number>;
  spokes: number; spokeTwist: number;
  importMode: 'ribs' | 'openings';
  // detail layers: patterns within patterns
  detailMode: 'off' | 'symmetric' | 'same' | 'random';
  detailStart: number; detailEvery: number; detailSpacing: number; detailVariety: number;
  motifs: string[];
  // repeat: centre = mandala generators; free = hand-drawn outlines, flows and scrolls
  repeat: 'centre' | 'free' | 'trace';
  freeMirror: MirrorMode; flowEchoes: number; flowSpacing: number; scrollSize: number; scrollGap: number;
  // frame corners: scrollwork in the corners of a rectangular panel
  // trace: an uploaded image, one flat colour per sheet
  traceColours: number; traceSmooth: number; traceMinPiece: number; traceDarkFirst: boolean;
  corners: boolean; cornerSize: number; cornerRings: number; cornerGap: number; cornerCurl: number; cornerBars: boolean;
}

export interface TraceInput { sig: string; openings: Pt[][][] }
export interface EngineInput { s: Settings; sketch: Pt[][]; imported: Pt[][]; free?: FreeArt; trace?: TraceInput | null }

export interface LayerOut { material: Paths; groups: G.Group[]; islands: number; cutLength: number; isBack: boolean }
export interface EngineResult {
  layers: LayerOut[]; outer: Paths; reg: Pt[]; thin: Paths;
  warnings: string[]; ms: number; openingsTop: number;
  details: { layer: number; motifs: string[] }[];
  backend?: string;
  partial?: boolean;
}

export function outerShape(s: Settings): Pt[] {
  const w = s.width / 2, h = s.height / 2;
  if (s.shape === 'circle') return G.circle(0, 0, Math.min(w, h), 360);
  if (s.shape === 'hex') {
    const r = Math.min(w, h / (Math.sqrt(3) / 2));
    const o: Pt[] = [];
    for (let i = 0; i < 6; i++) { const a = (i / 6) * Math.PI * 2; o.push([r * Math.cos(a), r * Math.sin(a)]); }
    return o;
  }
  return [[-w, -h], [w, -h], [w, h], [-w, h]];
}

function regPoints(s: Settings): Pt[] {
  const w = s.width / 2, h = s.height / 2, b = s.border / 2;
  if (s.shape === 'rect') return [[-w + b, -h + b], [w - b, -h + b], [w - b, h - b], [-w + b, h - b]];
  const inR = s.shape === 'hex' ? Math.min(w, h / (Math.sqrt(3) / 2)) * (Math.sqrt(3) / 2) : Math.min(w, h);
  const angles = s.shape === 'hex' ? [30, 150, 210, 330] : [45, 135, 225, 315];
  return angles.map((d) => [(inR - b) * Math.cos((d * Math.PI) / 180), (inR - b) * Math.sin((d * Math.PI) / 180)] as Pt);
}

/** Distance from centre to the bottom edge of the outline. */
export function bottomEdge(s: Settings): number {
  if (s.shape === 'rect') return s.height / 2;
  if (s.shape === 'hex') return Math.min(s.width / 2, s.height / 2 / (Math.sqrt(3) / 2)) * (Math.sqrt(3) / 2);
  return Math.min(s.width, s.height) / 2;
}

export function designStrokes(s: Settings, sketch: Pt[][], imported: Pt[][], free?: FreeArt): Pt[][] {
  if (s.repeat === 'free') {
    const strokes = freeStrokes(s, free);
    if (s.importMode === 'ribs') strokes.push(...imported);
    strokes.push(...cornerStrokes(s));
    return strokes;
  }
  const iw = s.width - 2 * s.border, ih = s.height - 2 * s.border;
  const R = s.shape === 'rect' ? Math.hypot(iw, ih) / 2 : Math.min(iw, ih) / 2;
  const strokes: Pt[][] = [];
  if (s.gen !== 'none') strokes.push(...genById(s.gen).run({ w: iw, h: ih, R, seed: s.seed, p: s.params }));
  if (s.spokes > 0) {
    const r0 = R * 0.04;
    for (let i = 0; i < s.spokes; i++) {
      const a0 = (i / s.spokes) * Math.PI * 2, line: Pt[] = [];
      for (let k = 0; k <= 60; k++) { const t = k / 60, r = r0 + (R * 1.15 - r0) * t, a = a0 + s.spokeTwist * t; line.push([r * Math.cos(a), r * Math.sin(a)]); }
      strokes.push(line);
    }
  }
  strokes.push(...sketch);
  if (s.importMode === 'ribs') strokes.push(...imported);
  if (!cornersOn(s)) return strokes;
  // the main design stays inside the divider; the corners get scrollwork instead
  return [...clipLines(strokes, (p) => insideDivider(s, p)), ...cornerStrokes(s)];
}

// Layers above the first detail layer don't depend on the detail settings, so they are
// cached and reused when only motifs / detail options change. This keeps tweaks fast.
export let RAWRIBS = true;
export function setRawRibs(v: boolean) { RAWRIBS = v; }
export let TIDY_JOIN: 'round' | 'miter' = 'miter';
export function setTidyJoin(j: 'round' | 'miter') { TIDY_JOIN = j; }
function thinOf(top: Paths, minRib: number) {
  return G.dropSmall(G.diff(top, G.morphOpen(top, (minRib / 2) * 0.97)), minRib * minRib);
}
export function thinWarning(thin: Paths, minRib: number) {
  return thin.length ? `${thin.length} spot${thin.length > 1 ? 's' : ''} on the top sheet are thinner than ${minRib} mm (${G.totalArea(thin).toFixed(0)} mm²) — shown in red. Increase rib width or simplify.` : '';
}
/** Thin-rib check for the most recent design, run after it is already on screen. */
export function pendingThin(): { thin: Paths; warning: string } | null {
  const C = CACHE;
  if (C.thin || !C.top) return null;
  C.thin = thinOf(C.top, C.minRib!);
  return { thin: C.thin, warning: thinWarning(C.thin, C.minRib!) };
}
const DETAIL_KEYS = ['detailMode', 'detailStart', 'detailEvery', 'detailSpacing', 'detailVariety', 'motifs'];
type Cell = ReturnType<typeof cellInfo>;
/** One opening stepped down by one sheet: its child openings, enclosed islands, eroded core. */
type Step = { groups: G.Group[]; islands: G.Group[]; tops: G.Path[]; Y: Paths; motif: string | null };
type Cache = {
  key: string; open0?: Paths; open0Y?: Paths; thin?: Paths; top?: Paths; minRib?: number;
  top0?: { groups: G.Group[]; islands: G.Group[]; tops: G.Path[] };
  memo: Map<string, Step>; cells: Map<string, Cell>; hashes: WeakMap<object, string>;
};
const newCache = (key: string): Cache => ({ key, memo: new Map(), cells: new Map(), hashes: new WeakMap() });
let CACHE: Cache = newCache('');
const YBOX = new WeakMap<Paths, [number, number, number, number][]>();

const ROUND_MOTIFS = ['arcs', 'radial', 'rosette', 'dots'];
const strHash = (seed: number, k: number, key: string, salt: number) =>
  hash01(seed, k, salt, key.length, ...[...key].map((ch) => ch.charCodeAt(0)));
/** Stable pick: each cell kind prefers motifs in a fixed order, so toggling one motif only moves the cells that used it. */
const rendezvous = (seed: number, k: number, key: string, options: string[]) => {
  let best = options[0], bv = -1;
  for (const m of options) { const v = strHash(seed, k, key, 101 + MOTIFS.findIndex((x) => x.id === m)); if (v > bv) { bv = v; best = m; } }
  return best;
};

// ---------------- work units (run inline or on a pool of workers) ----------------
type CellLite = Omit<Cell, 'paths'>;
export interface StepJob {
  n: number; g: G.Group; Y: Paths; c: CellLite; id: string | null; sp: number; flip: boolean;
  detailOn: boolean; motifLayer: boolean; stepN: number;
}
const tidyFns = (s: Settings) => {
  const minA = Math.max(0.5, s.minOpening * s.minOpening * 1.5);
  const rO = s.minOpening / 2;
  // Opening (erode then dilate) removes slivers too thin to cut. The eroded set Y is
  // kept so the next sheet can fold its own erosion into the step-down offset.
  const dilate = (y: Paths) => G.dropSmall(G.clean(G.offset(y, rO, TIDY_JOIN)), minA);
  const tidyY = (p: Paths) => { const y = G.offset(p, -rO, TIDY_JOIN); return { o: dilate(y), y }; };
  return { rO, dilate, tidyY };
};

/** Closed shapes that limit where the top sheet is open (free outlines or imported openings). */
export interface Windows { shapes: Pt[][]; evenOdd: boolean; corners?: Pt[] }
export function windowShapes(s: Settings, imported: Pt[][], free?: FreeArt): Windows | null {
  if (s.repeat === 'free') {
    const o = freeOutlines(s, free);
    if (o.length) return { shapes: o, evenOdd: false, corners: cornersOn(s) ? dividerEllipse(s) : undefined };
  }
  if (s.importMode === 'openings' && imported.length) return { shapes: imported.filter((l) => l.length > 2), evenOdd: true };
  return null;
}
function cutOpen(s: Settings, ribs: Paths, win: Windows | null, hasStrokes: boolean): Paths {
  const outer = [G.toPath(outerShape(s))];
  const inner = G.offset(outer, -s.border, 'miter');
  let area = inner;
  if (win) {
    // free outlines overlap and merge (wings, mirrored halves); imported shapes keep even-odd holes
    const shapes = win.evenOdd ? G.unionEvenOdd(win.shapes.map(G.toPath)) : G.union(win.shapes.map((l) => G.orient(G.toPath(l), true)));
    area = G.inter(inner, shapes);
    // corner scrollwork stays open even when the drawn outline does not reach the corners
    if (win.corners) area = G.union(area, G.diff(inner, [G.orient(G.toPath(win.corners), true)]));
  }
  return hasStrokes ? G.diff(area, ribs) : win ? area : inner;
}

/** The top sheet: design strokes become ribs, the rest of the inner area is open. */
export function topLayer({ s, sketch, imported, free }: EngineInput): { open0: Paths; open0Y: Paths } {
  const { tidyY } = tidyFns(s);
  const strokes = designStrokes(s, sketch, imported, free);
  const ribs = RAWRIBS ? G.bufferLinesRaw(strokes, s.rib / 2) : G.bufferLines(strokes, s.rib / 2);
  const open0 = cutOpen(s, ribs, windowShapes(s, imported, free), strokes.length > 0);
  const t = tidyY(open0);
  return { open0: t.o, open0Y: t.y };
}

/** Top sheet in parts, so a worker pool can spread the line buffering and the cleanup. */
export function topRibs(lines: Pt[][], half: number): Paths { return G.bufferLinesRaw(lines, half); }
export function topCut(s: Settings, ribs: Paths, win: Windows | null, hasStrokes: boolean): G.Group[] {
  return G.openingTree(cutOpen(s, ribs, win, hasStrokes)).groups;
}
/** Sliver cleanup per opening; openings never overlap, so this matches cleaning them all at once. */
export function topTidy(s: Settings, groups: G.Group[]): { o: Paths; y: Paths } {
  const { tidyY } = tidyFns(s);
  const o: Paths = [], y: Paths = [];
  for (const g of groups) { const t = tidyY([g.outer, ...g.holes]); o.push(...t.o); y.push(...t.y); }
  return { o, y };
}

/** Step one opening down by one sheet (drift, shrink, optional motif, sliver cleanup). */
export function stepNode(s: Settings, j: StepJob): Step {
  const { rO, dilate, tidyY } = tidyFns(s);
  const g = j.g;
  const R = Math.min(s.width, s.height) / 2;
  const ang = (s.twist * Math.PI) / 180, cos = Math.cos(ang), sin = Math.sin(ang);
  const d = s.drift * j.stepN;
  let dx = 0, dy = 0;
  if (s.driftMode === 'in' || s.driftMode === 'out') {
    const [cx, cy] = G.centroid(g.outer);
    const dist = Math.hypot(cx, cy);
    const kk = dist < 1e-6 ? 0 : ((s.driftMode === 'in' ? -1 : 1) * d * Math.min(1, dist / (R * 0.15))) / dist;
    dx = cx * kk; dy = cy * kk;
  } else if (s.driftMode === 'light') {
    const la = (s.lightAngle * Math.PI) / 180;
    dx = d * Math.cos(la); dy = d * Math.sin(la);
  }
  const own = [g.outer, ...g.holes];
  const T = s.twist !== 0 || dx || dy ? own.map((p) => G.transform(p, cos, sin, dx, dy)) : own;
  // fine detail cells step down more gently so they last several sheets
  const step = j.detailOn ? Math.min(j.stepN, Math.max(s.minOpening * 0.6, j.c.inR * 0.3)) : j.stepN;
  let o: Paths, Y: Paths;
  if (!j.motifLayer && j.Y.length) {
    // plain sheet: one offset covers both the step-down and the sliver erosion
    Y = G.inter(G.offset(T, -(step + rO)), j.Y);
    o = Y.length ? dilate(Y) : [];
  } else {
    let base = G.inter(G.offset(T, -step), own);
    if (j.id && base.length) base = applyMotif(j.id, { ...j.c, paths: own, local: s.repeat === 'free' }, base, j.sp, s.rib, j.flip);
    const t = tidyY(base);
    o = t.o; Y = t.y;
  }
  return { ...G.openingTree(o), Y, motif: j.id };
}

export function thinCheck(top: Paths, minRib: number) {
  const thin = thinOf(top, minRib);
  return { thin, warning: thinWarning(thin, minRib) };
}

/** Where work units run: inline (this thread) or spread across worker threads. */
export interface Runner {
  top(input: EngineInput): Promise<{ open0: Paths; open0Y: Paths }>;
  steps(s: Settings, jobs: StepJob[]): Promise<Step[]>;
  name?: string;
}
export const inlineRunner: Runner = {
  top: async (input) => topLayer(input),
  steps: async (s, jobs) => jobs.map((j) => stepNode(s, j)),
};

export class Stale extends Error {}
export const PERF = { wait: 0, jobs: 0 };

export async function computeAsync(
  { s, sketch, imported, free, trace }: EngineInput,
  opts: { runner?: Runner; onProgress?: (partial: EngineResult) => void; deferThin?: boolean; stale?: () => boolean } = {},
): Promise<EngineResult> {
  const runner = opts.runner ?? inlineRunner;
  PERF.wait = 0; PERF.jobs = 0;
  const onProgress = opts.onProgress;
  const check = () => { if (opts.stale?.()) throw new Stale('superseded'); };
  const t0 = performance.now();
  const warnings: string[] = [];
  const baseS: Record<string, unknown> = { ...s };
  for (const k of DETAIL_KEYS) delete baseS[k];
  const key = s.repeat === 'trace' ? JSON.stringify([baseS, trace?.sig ?? '']) : JSON.stringify([baseS, s.repeat === 'free' ? [] : sketch, imported, s.repeat === 'free' ? free : null]);
  if (CACHE.key !== key || CACHE.memo.size > 40000) CACHE = newCache(key);
  const C = CACHE;
  const detailsOn = !!s.detailMode && s.detailMode !== 'off';
  const dStart = s.detailStart ?? 2, dEvery = Math.max(1, s.detailEvery);
  const outerP = G.orient(G.toPath(outerShape(s)), true);
  const outer = [outerP];


  const reg: Pt[] = [];
  let regPaths: Paths = [];
  if (s.regHoles) {
    if (s.border >= s.regDia + 3) {
      reg.push(...regPoints(s));
      regPaths = reg.map(([x, y]) => G.orient(G.toPath(G.circle(x, y, s.regDia / 2, 48)), false));
    } else warnings.push(`Border is too narrow for ${s.regDia} mm alignment holes — widen it to at least ${(s.regDia + 3).toFixed(1)} mm.`);
  }
  const fixedCut = G.perimeter(outer) + G.perimeter(regPaths);

  // A sheet is the outline minus its openings; built directly, no whole-sheet clipping.
  const mkLayer = (groups: G.Group[], islands: G.Group[], tops: G.Path[]): LayerOut => {
    const mg: G.Group[] = [{ outer: outerP, holes: [...tops.map((t) => G.orient(t, false)), ...regPaths] }, ...islands];
    const material: Paths = [];
    for (const g of mg) material.push(g.outer, ...g.holes);
    let cut = fixedCut;
    for (const g of groups) cut += G.perimeter([g.outer, ...g.holes]);
    return { material, groups: mg, islands: islands.length, cutLength: cut, isBack: false };
  };

  if (s.repeat === 'trace') {
    // traced image: each sheet's openings come straight from the tracer
    const inner = G.offset(outer, -s.border);
    const layers: LayerOut[] = [];
    if (trace) trace.openings.forEach((rings, k) => {
      const mk = `trace|${k}`;
      let t = C.memo.get(mk) as unknown as ReturnType<typeof G.openingTree> | undefined;
      if (!t) {
        const op = G.inter(G.unionEvenOdd(rings.map((r) => G.toPath(r))), inner);
        t = G.openingTree(op);
        C.memo.set(mk, t as any);
      }
      layers.push(mkLayer(t.groups, t.islands, t.tops));
    });
    else warnings.push('Upload an image to trace: each flat colour becomes one sheet.');
    layers.push({ material: [outerP, ...regPaths], groups: [{ outer: outerP, holes: regPaths }], islands: 0, cutLength: fixedCut, isBack: true });
    let thin: Paths = [];
    if (layers.length > 1) {
      const top = layers[0].material;
      C.top = top; C.minRib = s.minRib;
      if (C.thin || !opts.deferThin) {
        thin = C.thin ??= thinOf(top, s.minRib);
        const w = thinWarning(thin, s.minRib);
        if (w) warnings.push(w);
      }
    }
    const isl = layers.reduce((a, l) => a + l.islands, 0);
    if (isl) warnings.push(`${isl} loose piece${isl > 1 ? 's' : ''} across all sheets. Each one glues onto the solid sheet behind it, in the same place it was cut from.`);
    return { layers, outer, reg, thin, warnings, ms: performance.now() - t0, openingsTop: layers[0]?.groups.length ?? 0, details: [], backend: G.geomBackend };
  }

  if (!C.open0) {
    const tw = performance.now();
    const t = await runner.top({ s, sketch, imported, free });
    PERF.wait += performance.now() - tw;
    check();
    if (CACHE !== C) throw new Stale('superseded');
    C.open0 = t.open0; C.open0Y = t.open0Y;
  }
  const open0 = C.open0!;

  const hashOf = (o: object, f: () => string) => { let h = C.hashes.get(o); if (!h) { h = f(); C.hashes.set(o, h); } return h; };
  const cellOf = (g: G.Group, h: string) => { let c = C.cells.get(h); if (!c) { c = cellInfo(g.outer, g.holes); C.cells.set(h, c); } return c; };

  const top0 = C.top0 ??= G.openingTree(open0);
  const layers: LayerOut[] = [mkLayer(top0.groups, top0.islands, top0.tops)];
  const details: { layer: number; motifs: string[] }[] = [];
  let lastEmit = t0;
  // stream partial stacks so slow devices show the design while deeper sheets compute
  const emit = () => {
    if (!onProgress) return;
    const now = performance.now();
    if (now - lastEmit < 250) return;
    lastEmit = now;
    onProgress({ layers: layers.slice(), outer, reg, thin: C.thin ?? [], warnings: [], ms: now - t0, openingsTop: open0.length, details: details.slice(), backend: G.geomBackend, partial: true });
  };
  emit();

  const R = Math.min(s.width, s.height) / 2;
  const enabled = (s.motifs?.length ? s.motifs : MOTIFS.map((m) => m.id)).filter((id) => MOTIFS.some((m) => m.id === id));
  const minSp = s.rib + 2 * s.minOpening + 0.4;
  const ringW = Math.max(4, R * 0.06);
  type Node = { g: G.Group; Y: Paths };
  let cur: Node[] = top0.groups.map((g) => ({ g, Y: C.open0Y ?? [] }));
  let stillOpen = cur.length > 0;

  for (let n = 1; n < s.maxLayers && cur.length; n++) {
    const stepN = s.step * Math.pow(1 + s.stepCurve, n - 1);
    const detailOn = detailsOn && n > dStart;
    const lvl = n - dStart;
    const motifLayer = detailsOn && lvl >= 0 && lvl % dEvery === 0;
    const k = lvl / dEvery;
    const sp0 = Math.max(minSp, s.detailSpacing * Math.pow(0.85, k));
    const hs = cur.map((nd) => hashOf(nd.g, () => G.groupHash(nd.g)));
    const cells = cur.map((nd, i) => cellOf(nd.g, hs[i]));

    // motif per cell kind (only on detail sheets)
    const pick: (string | null)[] = cur.map(() => null);
    const flips: boolean[] = cur.map(() => false);
    if (motifLayer && enabled.length) {
      const kindOf = (c: Cell) => s.detailMode === 'same' ? 'all'
        : s.detailMode === 'random' ? `${Math.round(c.c[0] * 10)},${Math.round(c.c[1] * 10)}`
        : `${Math.round(c.dist / ringW)}:${Math.round(Math.log2(c.size + 1) * 2)}`;
      const kinds = cells.map((c) => (c.size >= minSp * 2 ? kindOf(c) : null));
      const keys = [...new Set(kinds.filter((x): x is string => !!x))].sort((a, b) => strHash(s.seed, k, a, 1) - strHash(s.seed, k, b, 1));
      const nOn = Math.max(1, Math.round(keys.length * s.detailVariety));
      const assign = new Map<string, string>();
      keys.slice(0, nOn).forEach((kk) => assign.set(kk, rendezvous(s.seed, k, kk, enabled)));
      // make sure every selected motif shows somewhere, moving as few kinds as possible
      const count = new Map<string, number>();
      for (const m of assign.values()) count.set(m, (count.get(m) ?? 0) + 1);
      for (const m of enabled) {
        if (count.get(m)) continue;
        let bestK: string | null = null, bv = -1;
        for (const [kk, mm] of assign) if ((count.get(mm) ?? 0) > 1) { const v = strHash(s.seed, k, kk, 301 + MOTIFS.findIndex((x) => x.id === m)); if (v > bv) { bv = v; bestK = kk; } }
        if (!bestK) break;
        const old = assign.get(bestK)!;
        count.set(old, count.get(old)! - 1); count.set(m, 1); assign.set(bestK, m);
      }
      const round = enabled.filter((m) => ROUND_MOTIFS.includes(m));
      cur.forEach((_, i) => {
        const kk = kinds[i];
        if (!kk) return;
        let id = assign.get(kk) ?? null;
        if (id && s.repeat !== 'free' && cells[i].rMin === 0 && !ROUND_MOTIFS.includes(id)) id = round.length ? rendezvous(s.seed, k, kk, round) : 'arcs';
        pick[i] = id;
        flips[i] = hash01(s.seed, k, kk.length) < 0.5;
      });
    }

    // look up remembered results; collect the rest as work units
    const steps: (Step | undefined)[] = [];
    const keysN: string[] = [];
    const jobs: StepJob[] = [], jobIdx: number[] = [];
    cur.forEach((nd, i) => {
      const c = cells[i];
      const id = pick[i];
      const sp = Math.max(minSp, Math.min(sp0, c.size / 2.6));
      const yh = hashOf(nd.Y, () => G.pathsHash(nd.Y));
      const mk = `${n}|${hs[i]}|${yh}|${detailOn ? 1 : 0}${motifLayer ? 1 : 0}|${id ? `${id}|${sp.toFixed(3)}|${flips[i]}` : '-'}`;
      keysN.push(mk);
      const hit = C.memo.get(mk);
      steps.push(hit);
      if (hit) return;
      let Y: Paths = [];
      if (!motifLayer && nd.Y.length) {
        const [bx0, by0, bx1, by1] = G.bbox([nd.g.outer]);
        let boxes = YBOX.get(nd.Y);
        if (!boxes) { boxes = nd.Y.map((p) => G.bbox([p])); YBOX.set(nd.Y, boxes); }
        const bxs = boxes;
        Y = nd.Y.filter((_, j) => { const [x0, y0, x1, y1] = bxs[j]; return x1 >= bx0 && x0 <= bx1 && y1 >= by0 && y0 <= by1; });
        if (!Y.length) { const empty: Step = { groups: [], islands: [], tops: [], Y: [], motif: id }; steps[i] = empty; C.memo.set(mk, empty); return; }
      }
      const { paths: _p, ...lite } = c;
      jobs.push({ n, g: nd.g, Y, c: lite, id, sp, flip: flips[i], detailOn, motifLayer, stepN });
      jobIdx.push(i);
    });
    if (jobs.length) {
      const tw = performance.now();
      const out = await runner.steps(s, jobs);
      PERF.wait += performance.now() - tw; PERF.jobs += jobs.length;
      check();
      if (CACHE !== C) throw new Stale('superseded');
      out.forEach((st, j) => { steps[jobIdx[j]] = st; C.memo.set(keysN[jobIdx[j]], st); });
    }

    const next: Node[] = [];
    const groups: G.Group[] = [], islands: G.Group[] = [], tops: G.Path[] = [];
    const used = new Set<string>();
    for (const st of steps as Step[]) {
      if (st.motif) used.add(st.motif);
      for (const cg of st.groups) { groups.push(cg); next.push({ g: cg, Y: st.Y }); }
      islands.push(...st.islands); tops.push(...st.tops);
    }
    if (used.size) details.push({ layer: n + 1, motifs: enabled.filter((m) => used.has(m)).concat([...used].filter((m) => !enabled.includes(m))) });
    cur = next;
    if (!groups.length) { stillOpen = false; break; }
    layers.push(mkLayer(groups, islands, tops));
    emit();
  }
  const nOpen = layers.length;

  if (s.back) layers.push({ material: [outerP, ...regPaths], groups: [{ outer: outerP, holes: regPaths }], islands: 0, cutLength: fixedCut, isBack: true });

  // thin-rib check on the top sheet (lower sheets only gain material)
  let thin: Paths = [];
  if (layers.length) {
    const top = layers[0].material;
    C.top = top; C.minRib = s.minRib;
    if (C.thin || !opts.deferThin) {
      thin = C.thin ??= thinOf(top, s.minRib);
      const w = thinWarning(thin, s.minRib);
      if (w) warnings.push(w);
    }
  }
  if (s.rib < s.minRib) warnings.push(`Rib width ${s.rib} mm is below the ${s.minRib} mm minimum for this material.`);
  const isl = layers.reduce((a, l) => a + l.islands, 0);
  if (isl) warnings.push(`${isl} loose piece${isl > 1 ? 's' : ''} across all sheets. They glue down onto the sheet below, but keep them with their sheet when you unload the bed.`);
  if (nOpen === s.maxLayers && stillOpen && cur.length) warnings.push(`Openings are still open at the max of ${s.maxLayers} layers — raise the max or the step for a fully closed stack.`);
  if (!open0.length) warnings.push('No openings left after cleanup. Try a thinner rib, fewer details, or a smaller minimum opening.');

  // only report details on sheets that survived
  const kept = details.filter((d) => d.layer <= nOpen);
  return { layers, outer, reg, thin, warnings, ms: performance.now() - t0, openingsTop: open0.length, details: kept, backend: runner.name ?? G.geomBackend };
}

/** Thin-rib check pending for the latest design: returns its inputs (for a worker) and stores the answer. */
export function pendingThinInput(): { top: Paths; minRib: number; store: (t: Paths) => void } | null {
  const C = CACHE;
  if (C.thin || !C.top) return null;
  return { top: C.top, minRib: C.minRib!, store: (t) => { if (CACHE === C) C.thin = t; } };
}
