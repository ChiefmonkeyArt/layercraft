import JSZip from 'jszip';
import * as G from './geom';
import type { Group, Pt } from './geom';
import { SCALE } from './geom';
import { bottomEdge, type EngineResult, type Settings } from './engine';

// ---------- single-stroke engraving font (for layer numbers) ----------
// glyphs on a 4 x 6 grid, y down
const GLYPHS: Record<string, number[][][]> = {
  '0': [[[0, 0], [4, 0], [4, 6], [0, 6], [0, 0]], [[4, 0], [0, 6]]],
  '1': [[[1, 1], [2, 0], [2, 6]], [[1, 6], [3, 6]]],
  '2': [[[0, 0], [4, 0], [4, 3], [0, 3], [0, 6], [4, 6]]],
  '3': [[[0, 0], [4, 0], [4, 6], [0, 6]], [[1, 3], [4, 3]]],
  '4': [[[0, 0], [0, 3], [4, 3]], [[4, 0], [4, 6]]],
  '5': [[[4, 0], [0, 0], [0, 3], [4, 3], [4, 6], [0, 6]]],
  '6': [[[4, 0], [0, 0], [0, 6], [4, 6], [4, 3], [0, 3]]],
  '7': [[[0, 0], [4, 0], [1.5, 6]]],
  '8': [[[0, 0], [4, 0], [4, 6], [0, 6], [0, 0]], [[0, 3], [4, 3]]],
  '9': [[[4, 3], [0, 3], [0, 0], [4, 0], [4, 6], [0, 6]]],
  '/': [[[0, 6], [4, 0]]],
  B: [[[0, 0], [3, 0], [4, 1.5], [3, 3], [0, 3]], [[3, 3], [4, 4.5], [3, 6], [0, 6], [0, 0]]],
  A: [[[0, 6], [2, 0], [4, 6]], [[0.8, 3.8], [3.2, 3.8]]],
  C: [[[4, 0], [0, 0], [0, 6], [4, 6]]],
  K: [[[0, 0], [0, 6]], [[4, 0], [0, 3.5], [4, 6]], ],
  '^': [[[0, 4], [2, 0], [4, 4], [0, 4]]],
};

export function strokeText(text: string, cx: number, cy: number, height: number): Pt[][] {
  const k = height / 6, adv = 5.6 * k;
  const width = text.length * adv - 1.6 * k;
  let x0 = cx - width / 2;
  const out: Pt[][] = [];
  for (const ch of text) {
    const g = GLYPHS[ch];
    if (g) for (const l of g) out.push(l.map(([x, y]) => [x0 + x * k, cy - height / 2 + y * k]));
    x0 += adv;
  }
  return out;
}

// ---------- export ----------
const f = (n: number) => +n.toFixed(3);

function groupsD(groups: Group[], dx: number, dy: number): string {
  // holes (inner cuts) first, then outer contours — the laser should cut inside-out
  const holes: string[] = [], outers: string[] = [];
  for (const g of groups) {
    for (const h of g.holes) holes.push(ringD(h, dx, dy));
    outers.push(ringD(g.outer, dx, dy));
  }
  return [...holes, ...outers].join('');
}
function ringD(c: { x: number; y: number }[], dx: number, dy: number) {
  if (!c.length) return '';
  const p = c.map((q) => [q.x / SCALE + dx, q.y / SCALE + dy] as Pt);
  return curveRingD(p);
}
/**
 * A closed ring as smooth cubic curves: Catmull-Rom through the points, with sharp corners
 * and long straight edges kept as they are. Lasers cut these as true curves, not tiny steps.
 */
export function curveRingD(p: Pt[]): string {
  const n = p.length;
  const P = (q: Pt) => `${f(q[0])} ${f(q[1])}`;
  if (n < 6) return 'M' + p.map(P).join('L') + 'Z';
  const len = (a: Pt, b: Pt) => Math.hypot(b[0] - a[0], b[1] - a[1]);
  const sharp = p.map((b, i) => {
    const a = p[(i - 1 + n) % n], c = p[(i + 1) % n];
    const la = len(a, b), lc = len(b, c);
    if (!la || !lc) return true;
    const cos = ((b[0] - a[0]) * (c[0] - b[0]) + (b[1] - a[1]) * (c[1] - b[1])) / (la * lc);
    return cos < Math.cos((40 * Math.PI) / 180) || la > 4 * lc || lc > 4 * la;
  });
  let d = 'M' + P(p[0]);
  for (let i = 0; i < n; i++) {
    const p0 = p[(i - 1 + n) % n], p1 = p[i], p2 = p[(i + 1) % n], p3 = p[(i + 2) % n];
    if (sharp[i] && sharp[(i + 1) % n]) { d += 'L' + P(p2); continue; }
    // tangents scaled to the segment, so short and long neighbours do not overshoot
    const l12 = len(p1, p2);
    const t1 = sharp[i] ? [0, 0] : (() => { const l = len(p0, p2) || 1; return [((p2[0] - p0[0]) / l) * l12 / 3, ((p2[1] - p0[1]) / l) * l12 / 3]; })();
    const t2 = sharp[(i + 1) % n] ? [0, 0] : (() => { const l = len(p1, p3) || 1; return [((p3[0] - p1[0]) / l) * l12 / 3, ((p3[1] - p1[1]) / l) * l12 / 3]; })();
    d += `C${f(p1[0] + t1[0])} ${f(p1[1] + t1[1])} ${f(p2[0] - t2[0])} ${f(p2[1] - t2[1])} ${P(p2)}`;
  }
  return d + 'Z';
}
const linesD = (ls: Pt[][], dx: number, dy: number) => ls.map((l) => 'M' + l.map(([x, y]) => `${f(x + dx)} ${f(y + dy)}`).join('L')).join('');

export const CUT = '#FF0000', ENGRAVE = '#0000FF';

function labelFor(i: number, r: EngineResult) {
  const L = r.layers[i];
  const cutCount = r.layers.filter((l) => !l.isBack).length;
  return L.isBack ? 'BACK' : `${String(i + 1).padStart(2, '0')}/${String(cutCount).padStart(2, '0')}`;
}

function labelPos(s: Settings): [number, number, number] {
  const h = Math.min(4, s.border * 0.38);
  return [0, bottomEdge(s) - s.border / 2, h];
}

export function layerContent(r: EngineResult, s: Settings, i: number, dx: number, dy: number): string {
  const L = r.layers[i];
  const groups = s.kerf > 0 ? G.groups(G.offset(L.material, s.kerf / 2, 'miter')) : L.groups;
  let out = `<path fill="none" stroke="${CUT}" stroke-width="0.1" d="${groupsD(groups, dx, dy)}"/>`;
  if (s.numbers && r.labelAt) {
    // outline follows the picture: engrave small numbers just inside the bottom edge
    const text = labelFor(i, r) + ' ^';
    out += `<path fill="none" stroke="${ENGRAVE}" stroke-width="0.1" stroke-linecap="round" d="${linesD(strokeText(text, r.labelAt[0], r.labelAt[1], 1.6), dx, dy)}"/>`;
  } else if (s.numbers && s.border >= 6) {
    const [x, y, h] = labelPos(s);
    const text = labelFor(i, r) + ' ^';
    out += `<path fill="none" stroke="${ENGRAVE}" stroke-width="0.1" stroke-linecap="round" d="${linesD(strokeText(text, x, y, h), dx, dy)}"/>`;
  }
  return out;
}

const header = (w: number, h: number, title: string) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${f(w)}mm" height="${f(h)}mm" viewBox="0 0 ${f(w)} ${f(h)}">\n<title>${title}</title>\n`;

export function layerSVG(r: EngineResult, s: Settings, i: number): string {
  return header(s.width, s.height, `Layer ${labelFor(i, r)}`) +
    `<g id="layer-${i + 1}">${layerContent(r, s, i, s.width / 2, s.height / 2)}</g>\n</svg>\n`;
}

const esc = (t: string) => t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
/**
 * Every sheet in one file, stacked in place, each as its own named layer
 * (Inkscape layers; LightBurn and Illustrator read them as groups). Top sheet first in the
 * layer list; the colour is noted in each layer's name for painting or choosing card.
 */
export function allLayersSVG(r: EngineResult, s: Settings, name: string, sheetColours?: string[]): string {
  const n = r.layers.length;
  let body = '';
  // SVG paints later elements on top, so write the back first and the top sheet last
  for (let i = n - 1; i >= 0; i--) {
    const L = r.layers[i];
    const tag = L.isBack ? 'back' : i === 0 ? 'top' : 'layer';
    const col = sheetColours?.[i] ? ` ${sheetColours[i].toUpperCase()}` : '';
    const label = `${String(i + 1).padStart(2, '0')} ${tag}${col}`;
    body += `<g id="sheet-${String(i + 1).padStart(2, '0')}" inkscape:groupmode="layer" inkscape:label="${esc(label)}">${layerContent(r, s, i, s.width / 2, s.height / 2)}</g>\n`;
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" width="${f(s.width)}mm" height="${f(s.height)}mm" viewBox="0 0 ${f(s.width)} ${f(s.height)}">\n<title>${esc(name)} — all ${n} sheets</title>\n` + body + '</svg>\n';
}

export interface SheetPlan { sheets: number[][]; cols: number; rows: number; fits: boolean }
export function planSheets(r: EngineResult, s: Settings, gap = 6): SheetPlan {
  const cols = Math.floor((s.bedW - 10 + gap) / (s.width + gap));
  const rows = Math.floor((s.bedH - 10 + gap) / (s.height + gap));
  const per = cols * rows;
  if (per < 1) return { sheets: [], cols, rows, fits: false };
  const sheets: number[][] = [];
  for (let i = 0; i < r.layers.length; i++) { if (i % per === 0) sheets.push([]); sheets[sheets.length - 1].push(i); }
  return { sheets, cols, rows, fits: true };
}

export function sheetSVG(r: EngineResult, s: Settings, idxs: number[], cols: number, gap = 6): string {
  let body = '';
  idxs.forEach((li, k) => {
    const cx = 5 + (k % cols) * (s.width + gap) + s.width / 2;
    const cy = 5 + Math.floor(k / cols) * (s.height + gap) + s.height / 2;
    body += `<g id="layer-${li + 1}">${layerContent(r, s, li, cx, cy)}</g>\n`;
  });
  return header(s.bedW, s.bedH, 'Bed sheet') + body + '</svg>\n';
}

export async function exportZip(r: EngineResult, s: Settings, project: unknown, previewPng: string | null, name: string, sheetColours?: string[]): Promise<Blob> {
  const zip = new JSZip();
  const L = zip.folder('layers')!;
  const n = r.layers.length;
  r.layers.forEach((l, i) => {
    const tag = l.isBack ? 'back' : i === 0 ? 'top' : 'layer';
    L.file(`${String(i + 1).padStart(2, '0')}-${tag}.svg`, layerSVG(r, s, i));
  });
  zip.file('all-layers.svg', allLayersSVG(r, s, name, sheetColours));
  const plan = planSheets(r, s);
  if (plan.fits) {
    const S = zip.folder('bed-sheets')!;
    plan.sheets.forEach((idxs, k) => S.file(`sheet-${k + 1}.svg`, sheetSVG(r, s, idxs, plan.cols)));
  }
  zip.file('project.json', JSON.stringify(project, null, 2));
  if (sheetColours?.length) zip.file('colours.txt', [`Sheet colours for ${name} (for coloured card or painting)`, '', ...sheetColours.map((c, i) => `${String(i + 1).padStart(2, '0')}  ${r.layers[i]?.isBack ? 'back ' : i === 0 ? 'top  ' : 'layer'}  ${c.toUpperCase()}`)].join('\n'));
  if (previewPng) zip.file('preview.png', previewPng.split(',')[1], { base64: true });
  const depth = (n * s.thickness).toFixed(1);
  zip.file('README.txt', [
    `${name}`,
    `${'='.repeat(name.length)}`,
    ``,
    `${n} sheets of ${s.material} at ${s.thickness} mm  ->  ${depth} mm deep stack`,
    `Size ${s.width} x ${s.height} mm, ${s.shape}. Kerf compensation ${s.kerf} mm (already applied).`,
    ``,
    `Colours`,
    `  RED  #FF0000  cut through`,
    `  BLUE #0000FF  engrave / score (layer number + orientation arrow). Low power, or delete for paper.`,
    ``,
    `Order`,
    `  01 is the top (face) sheet. Higher numbers sit deeper. BACK is the solid backing panel.`,
    `  Keep every arrow pointing the same way so drift / twist effects line up.`,
    s.regHoles ? `  Pass ${s.regDia} mm dowels (or pins for paper) through the corner holes to align the stack while gluing.` : null,
    ``,
    `Files`,
    `  all-layers.svg  every sheet in one file, stacked in place, one named layer per sheet (Inkscape / LightBurn)`,
    `  layers/       one SVG per sheet at true size (mm)`,
    plan.fits ? `  bed-sheets/   sheets nested onto your ${s.bedW} x ${s.bedH} mm bed (${plan.cols * plan.rows} per sheet)` : `  (artwork is larger than the bed, so no bed sheets were made)`,
    `  project.json  re-open in Layercraft Stack to edit`,
    ``,
    `Do a test cut of the top sheet first and check rib strength and kerf before cutting the whole stack.`,
  ].filter((x) => x !== null).join('\n'));
  return zip.generateAsync({ type: 'blob' });
}

// ---------- import ----------
export interface ImportResult { lines: Pt[][]; count: number }

// Only geometry-bearing, inert SVG elements and attributes survive import.
const SAFE_ELS = new Set(['svg', 'g', 'path', 'circle', 'ellipse', 'rect', 'line', 'polyline', 'polygon', 'defs', 'clippath', 'mask', 'symbol', 'use', 'title', 'desc']);
const SAFE_ATTRS = new Set(['id', 'viewbox', 'width', 'height', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'd', 'points', 'transform', 'preserveaspectratio', 'pathlength', 'href', 'xlink:href', 'xmlns', 'xmlns:xlink', 'version']);

function sanitizeSVG(root: Element) {
  const all = [root, ...Array.from(root.querySelectorAll('*'))];
  for (const el of all) {
    if (el !== root && !el.isConnected) continue;
    if (!SAFE_ELS.has(el.localName.toLowerCase()) || el.namespaceURI !== 'http://www.w3.org/2000/svg') { el.remove(); continue; }
    for (const a of Array.from(el.attributes)) {
      const n = a.name.toLowerCase();
      if (!SAFE_ATTRS.has(n)) { el.removeAttributeNode(a); continue; }
      if ((n === 'href' || n === 'xlink:href') && !a.value.trim().startsWith('#')) el.removeAttributeNode(a);
    }
  }
}

export function parseSVG(text: string, fitW: number, fitH: number): ImportResult {
  const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
  const svg = doc.querySelector('svg');
  if (!svg) throw new Error('Not an SVG file');
  sanitizeSVG(svg);
  const host = document.createElement('div');
  host.style.cssText = 'position:absolute;left:-99999px;top:0;width:10px;height:10px;overflow:hidden';
  const live = document.importNode(svg, true) as SVGSVGElement;
  host.appendChild(live);
  document.body.appendChild(host);
  const raw: Pt[][] = [];
  try {
    const els = live.querySelectorAll<SVGGeometryElement>('path,circle,ellipse,rect,line,polyline,polygon');
    els.forEach((el) => {
      if (el.closest('defs,clipPath,mask,symbol')) return;
      let len = 0;
      try { len = el.getTotalLength(); } catch { return; }
      if (!isFinite(len) || len <= 0) return;
      const m = el.getCTM();
      const N = Math.min(6000, Math.max(16, Math.ceil(len / 0.6)));
      const stepLen = len / N;
      let cur: Pt[] = [];
      let prev: DOMPoint | null = null;
      for (let i = 0; i <= N; i++) {
        let p = el.getPointAtLength(i * stepLen);
        if (m) p = p.matrixTransform(m);
        if (prev && Math.hypot(p.x - prev.x, p.y - prev.y) > stepLen * 4 * (m ? Math.hypot(m.a, m.b) : 1) + 1e-6) {
          if (cur.length > 1) raw.push(cur);
          cur = [];
        }
        cur.push([p.x, p.y]);
        prev = p;
      }
      if (cur.length > 1) raw.push(cur);
    });
  } finally {
    host.remove();
  }
  if (!raw.length) throw new Error('No drawable shapes found in that SVG');
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const l of raw) for (const [x, y] of l) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  const k = Math.min(fitW / (x1 - x0 || 1), fitH / (y1 - y0 || 1));
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const lines = raw.map((l) => simplify(l.map(([x, y]) => [(x - cx) * k, (y - cy) * k] as Pt), 0.08));
  return { lines, count: lines.length };
}

/** Ramer–Douglas–Peucker */
export function simplify(pts: Pt[], eps: number): Pt[] {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const [ax, ay] = pts[a], [bx, by] = pts[b];
    const dx = bx - ax, dy = by - ay, L = Math.hypot(dx, dy) || 1e-9;
    let md = 0, mi = -1;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((pts[i][0] - ax) * dy - (pts[i][1] - ay) * dx) / L;
      if (d > md) { md = d; mi = i; }
    }
    if (md > eps && mi > 0) { keep[mi] = 1; stack.push([a, mi], [mi, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}

export function download(blob: Blob, name: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
}
