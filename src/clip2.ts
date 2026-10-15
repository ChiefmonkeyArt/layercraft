// Pure-JavaScript Clipper2 backend (no WebAssembly). Much faster than the old
// Clipper 1 JS port, and it uses {x, y} points natively so no conversion is needed.
// Mirrors the subset of the js-angusj-clipper wrapper API that geom.ts uses.
import { Clipper, ClipperOffset, ClipType, EndType, FillRule, JoinType, PolyTree64 } from '@countertype/clipper2-ts';

type P = { x: number; y: number }[];
const asPaths = (d: any): P[] => (d.length && !Array.isArray(d[0]) ? [d] : d);

const CT: Record<string, ClipType> = { union: ClipType.Union, difference: ClipType.Difference, intersection: ClipType.Intersection, xor: ClipType.Xor };
const FT: Record<string, FillRule> = { nonZero: FillRule.NonZero, evenOdd: FillRule.EvenOdd, positive: FillRule.Positive, negative: FillRule.Negative };
const JT: Record<string, JoinType> = { round: JoinType.Round, miter: JoinType.Miter, square: JoinType.Square };
const ET: Record<string, EndType> = { closedPolygon: EndType.Polygon, closedLine: EndType.Joined, openRound: EndType.Round, openSquare: EndType.Square, openButt: EndType.Butt };

function gather(inputs: any[] | undefined): P[] {
  const out: P[] = [];
  for (const s of inputs ?? []) for (const p of asPaths(s.data)) out.push(p);
  return out;
}

function wrapNode(n: any): any {
  return {
    get childs() { const a = []; for (let i = 0; i < n.count; i++) a.push(wrapNode(n.child(i))); return a; },
    get isHole() { return n.isHole; },
    get contour() { return n.polygon ?? []; },
  };
}

export const clip2 = {
  format: 'js2',
  clipToPaths(params: any) {
    const clip = gather(params.clipInputs);
    return Clipper.booleanOp(CT[params.clipType], gather(params.subjectInputs) as any, clip.length ? (clip as any) : null, FT[params.subjectFillType]);
  },
  clipToPolyTree(params: any) {
    const tree = new PolyTree64();
    const clip = gather(params.clipInputs);
    Clipper.booleanOpWithPolyTree(CT[params.clipType], gather(params.subjectInputs) as any, clip.length ? (clip as any) : null, tree, FT[params.subjectFillType]);
    return wrapNode(tree);
  },
  offsetToPaths(params: any) {
    const co = new ClipperOffset(params.miterLimit ?? 2, params.arcTolerance ?? 0.25);
    for (const i of params.offsetInputs) co.addPaths(asPaths(i.data) as any, JT[i.joinType], ET[i.endType]);
    const out: any[] = [];
    co.execute(params.delta, out);
    return out;
  },
  area(p: P) { return Clipper.area(p as any); },
  cleanPolygons(ps: P[], d = 1.1415) { return Clipper.simplifyPaths(ps as any, d, true); },
};
