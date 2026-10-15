import type { Group, Paths, Pt } from './geom';
import { SCALE } from './geom';
import type { EngineResult, Settings } from './engine';

export interface Palette { id: string; name: string; colour: (i: number, n: number, mat: string) => string }

const MAT_BASE: Record<string, [number, number, number]> = {
  birch: [236, 217, 180], oak: [200, 151, 92], paper: [246, 243, 236], custom: [226, 200, 160],
};

const shade = ([r, g, b]: [number, number, number], k: number) => `rgb(${Math.round(r * k)},${Math.round(g * k)},${Math.round(b * k)})`;

export const PALETTES: Palette[] = [
  { id: 'natural', name: 'Natural', colour: (i, n, m) => shade(MAT_BASE[m] ?? MAT_BASE.custom, 1 - (0.32 * i) / Math.max(1, n - 1)) },
  { id: 'rainbow', name: 'Rainbow', colour: (i, n) => `hsl(${(i / Math.max(1, n)) * 300 + 330}, 78%, ${62 - (i / n) * 14}%)` },
  { id: 'acid', name: 'Acid', colour: (i, n) => `hsl(${[95, 300, 180, 50, 330, 140][i % 6]}, 90%, ${60 - (i / n) * 18}%)` },
  { id: 'sunset', name: 'Sunset', colour: (i, n) => `hsl(${48 - (i / Math.max(1, n - 1)) * 70}, 88%, ${66 - (i / n) * 30}%)` },
  { id: 'deep', name: 'Deep sea', colour: (i, n) => `hsl(${170 + (i / Math.max(1, n - 1)) * 70}, 65%, ${70 - (i / n) * 48}%)` },
  { id: 'mono', name: 'Two-tone', colour: (i, _n, m) => (i % 2 ? '#2a2420' : shade(MAT_BASE[m] ?? MAT_BASE.custom, 1)) },
];

// ---- your own colours: a stepped gradient, with optional colours for detail sheets ----
export const CUSTOM = {
  top: '#ffd27a', bottom: '#3b1a6e',
  // per-sheet overrides, sheet number (1 = top) -> '#rrggbb' or 'contrast' (automatic contrasting colour)
  sheet: {} as Record<number, string>,
  detailLayers: [] as number[],           // detail sheets in the current stack
  version: 0,
};
const hexRgb = (h: string): [number, number, number] => { const v = parseInt(h.replace('#', '').padEnd(6, '0').slice(0, 6), 16); return [(v >> 16) & 255, (v >> 8) & 255, v & 255]; };
const lin = (c: number) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const gam = (c: number) => Math.round(255 * Math.min(1, Math.max(0, c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055)));
function toLab(hex: string): [number, number, number] {
  const [r, g, b] = hexRgb(hex).map(lin);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}
function fromLab([L, A, B]: [number, number, number]): string {
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3, m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3, s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  const r = gam(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s), g = gam(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s), b = gam(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s);
  return '#' + [r, g, b].map((x) => x.toString(16).padStart(2, '0')).join('');
}
/** Even steps between two colours, blended in a perceptual colour space so the middle stays vivid. */
export function gradientAt(top: string, bottom: string, t: number): string {
  const a = toLab(top), b = toLab(bottom);
  return fromLab([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]);
}
/** A colour that stands out against the gradient at this depth: opposite hue, similar lightness, stronger. */
export function contrastFor(hex: string): string {
  const [L, A, B] = toLab(hex);
  const C = Math.max(0.12, Math.hypot(A, B) * 1.2), h = Math.atan2(B, A) + Math.PI;
  return fromLab([Math.min(0.85, Math.max(0.45, L < 0.5 ? L + 0.25 : L - 0.15)), C * Math.cos(h), C * Math.sin(h)]);
}
export function customColour(i: number, n: number): string {
  const base = gradientAt(CUSTOM.top, CUSTOM.bottom, n > 1 ? i / (n - 1) : 0);
  const o = CUSTOM.sheet[i + 1];
  return !o ? base : o === 'contrast' ? contrastFor(base) : o;
}
PALETTES.unshift({ id: 'custom', name: 'Your gradient', colour: (i, n) => customColour(i, n) });

/** Colourway ids may carry a version suffix (custom#3) so cached 3D materials refresh. */
export function palette(id: string) { const k = id.split('#')[0]; return PALETTES.find((p) => p.id === k) ?? PALETTES[1]; }

export function groupsToPath2D(groups: Group[]): Path2D {
  const p = new Path2D();
  for (const g of groups) for (const c of [g.outer, ...g.holes]) {
    if (!c.length) continue;
    p.moveTo(c[0].x / SCALE, c[0].y / SCALE);
    for (let i = 1; i < c.length; i++) p.lineTo(c[i].x / SCALE, c[i].y / SCALE);
    p.closePath();
  }
  return p;
}

export function pathsToPath2D(paths: Paths): Path2D {
  const p = new Path2D();
  for (const c of paths) {
    if (!c.length) continue;
    p.moveTo(c[0].x / SCALE, c[0].y / SCALE);
    for (let i = 1; i < c.length; i++) p.lineTo(c[i].x / SCALE, c[i].y / SCALE);
    p.closePath();
  }
  return p;
}

let grainCanvas: HTMLCanvasElement | null = null;
function grain(): HTMLCanvasElement {
  if (grainCanvas) return grainCanvas;
  const c = document.createElement('canvas');
  c.width = 512; c.height = 512;
  const g = c.getContext('2d')!;
  g.fillStyle = '#808080'; g.fillRect(0, 0, 512, 512);
  for (let i = 0; i < 260; i++) {
    const y = Math.random() * 512, amp = 2 + Math.random() * 6, f = 0.004 + Math.random() * 0.01;
    g.strokeStyle = Math.random() < 0.5 ? 'rgba(60,40,20,0.22)' : 'rgba(255,240,220,0.18)';
    g.lineWidth = 0.5 + Math.random() * 1.6;
    g.beginPath();
    for (let x = 0; x <= 512; x += 8) g.lineTo(x, y + Math.sin(x * f + i) * amp);
    g.stroke();
  }
  grainCanvas = c;
  return c;
}

export interface View { scale: number; ox: number; oy: number }

/** User zoom / pan for the 2D previews (pinch, wheel). Pan is in CSS pixels. */
export const VIEW = { z: 1, px: 0, py: 0 };

export function fitView(canvas: HTMLCanvasElement, s: Settings, pad = 28): View {
  const w = canvas.width, h = canvas.height;
  const dpr = canvas.clientWidth ? w / canvas.clientWidth : 1;
  const scale = Math.min((w - pad * 2) / s.width, (h - pad * 2) / s.height) * VIEW.z;
  return { scale, ox: w / 2 + VIEW.px * dpr, oy: h / 2 + VIEW.py * dpr };
}

export interface StackCache { key: EngineResult | null; paths: Path2D[]; thin: Path2D | null }
export const stackCache: StackCache = { key: null, paths: [], thin: null };

function ensureCache(r: EngineResult) {
  if (stackCache.key === r) return;
  stackCache.key = r;
  stackCache.paths = r.layers.map((l) => groupsToPath2D(l.groups));
  stackCache.thin = r.thin.length ? pathsToPath2D(r.thin) : null;
}

export function drawStack(cv: HTMLCanvasElement, r: EngineResult, s: Settings, pal: string, opts: { light: number; showThin: boolean; isPaper: boolean }) {
  ensureCache(r);
  const ctx = cv.getContext('2d')!;
  const v = fitView(cv, s);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, cv.width, cv.height);
  const n = r.layers.length;
  const P = palette(pal);
  const dpr = cv.width / cv.clientWidth || 1;
  const la = (opts.light * Math.PI) / 180;
  const sd = Math.max(1.2, v.scale * s.thickness * 0.55); // shadow length in device px per layer
  const pattern = ctx.createPattern(grain(), 'repeat')!;
  for (let i = n - 1; i >= 0; i--) {
    const path = stackCache.paths[i];
    ctx.save();
    ctx.setTransform(v.scale, 0, 0, v.scale, v.ox, v.oy);
    ctx.shadowColor = i === n - 1 ? 'rgba(0,0,0,0.55)' : 'rgba(10,5,0,0.55)';
    ctx.shadowBlur = i === n - 1 ? 18 * dpr : sd * 1.6;
    ctx.shadowOffsetX = -Math.cos(la) * (i === n - 1 ? 6 * dpr : sd);
    ctx.shadowOffsetY = -Math.sin(la) * (i === n - 1 ? 6 * dpr : sd);
    ctx.fillStyle = P.colour(i, n, s.material);
    ctx.fill(path, 'evenodd');
    ctx.shadowColor = 'transparent';
    if (!opts.isPaper && pal === 'natural') {
      ctx.clip(path, 'evenodd');
      ctx.globalAlpha = 0.35;
      ctx.globalCompositeOperation = 'overlay';
      ctx.setTransform(v.scale * 0.35, 0, 0, v.scale * 0.35, v.ox + i * 37, v.oy + i * 53);
      ctx.fillStyle = pattern;
      ctx.fillRect(-4000, -4000, 8000, 8000);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
      ctx.setTransform(v.scale, 0, 0, v.scale, v.ox, v.oy);
    }
    // lit top edge
    ctx.lineWidth = Math.max(0.6, dpr * 0.7) / v.scale;
    ctx.strokeStyle = 'rgba(255,255,255,0.22)';
    ctx.stroke(path);
    ctx.restore();
  }
  if (opts.showThin && stackCache.thin) {
    ctx.save();
    ctx.setTransform(v.scale, 0, 0, v.scale, v.ox, v.oy);
    ctx.fillStyle = 'rgba(255,40,40,0.9)';
    ctx.fill(stackCache.thin, 'nonzero');
    ctx.restore();
  }
}

export function drawLayer(cv: HTMLCanvasElement, r: EngineResult, s: Settings, idx: number, colours: { cut: string; fill: string; ghost: string; island: string; bg: string }) {
  ensureCache(r);
  const ctx = cv.getContext('2d')!;
  const v = fitView(cv, s);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, cv.width, cv.height);
  const dpr = cv.width / cv.clientWidth || 1;
  ctx.setTransform(v.scale, 0, 0, v.scale, v.ox, v.oy);
  const L = r.layers[idx];
  if (!L) return;
  ctx.fillStyle = colours.fill;
  ctx.fill(stackCache.paths[idx], 'evenodd');
  if (L.islands) {
    ctx.fillStyle = colours.island;
    for (const g of L.groups.slice(1)) ctx.fill(groupsToPath2D([g]), 'evenodd');
  }
  if (idx > 0) {
    ctx.setLineDash([3 / v.scale * dpr, 3 / v.scale * dpr]);
    ctx.lineWidth = dpr / v.scale;
    ctx.strokeStyle = colours.ghost;
    ctx.stroke(stackCache.paths[idx - 1]);
    ctx.setLineDash([]);
  }
  ctx.lineWidth = (1.1 * dpr) / v.scale;
  ctx.strokeStyle = colours.cut;
  ctx.stroke(stackCache.paths[idx]);
  if (idx === 0 && stackCache.thin) {
    ctx.fillStyle = 'rgba(255,40,40,0.95)';
    ctx.fill(stackCache.thin);
  }
}

export function drawSketch(cv: HTMLCanvasElement, r: EngineResult | null, s: Settings, strokes: Pt[][], live: Pt[][], sym: number, mirror: boolean, colours: { fill: string; stroke: string; live: string; guide: string }) {
  const ctx = cv.getContext('2d')!;
  const v = fitView(cv, s);
  const dpr = cv.width / cv.clientWidth || 1;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, cv.width, cv.height);
  ctx.setTransform(v.scale, 0, 0, v.scale, v.ox, v.oy);
  if (r && r.layers[0]) {
    ensureCache(r);
    ctx.fillStyle = colours.fill;
    ctx.fill(stackCache.paths[0], 'evenodd');
  }
  // symmetry guides
  const R = Math.hypot(s.width, s.height) / 2;
  ctx.strokeStyle = colours.guide;
  ctx.lineWidth = dpr / v.scale;
  ctx.setLineDash([4 / v.scale, 6 / v.scale]);
  for (let k = 0; k < sym; k++) {
    const a = (k / sym) * Math.PI * 2 - Math.PI / 2;
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(R * Math.cos(a), R * Math.sin(a)); ctx.stroke();
  }
  ctx.setLineDash([]);
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.lineWidth = s.rib;
  const drawLines = (ls: Pt[][], col: string) => {
    ctx.strokeStyle = col;
    for (const l of ls) {
      if (l.length < 2) continue;
      ctx.beginPath(); ctx.moveTo(l[0][0], l[0][1]);
      for (const p of l) ctx.lineTo(p[0], p[1]);
      ctx.stroke();
    }
  };
  drawLines(strokes, colours.stroke);
  drawLines(live, colours.live);
  void mirror;
}

export function screenToMm(cv: HTMLCanvasElement, s: Settings, clientX: number, clientY: number): Pt {
  const rect = cv.getBoundingClientRect();
  const dpr = cv.width / rect.width;
  const v = fitView(cv, s);
  return [((clientX - rect.left) * dpr - v.ox) / v.scale, ((clientY - rect.top) * dpr - v.oy) / v.scale];
}

/** WebGL-free 3D: tilted, rotatable stack drawn with the 2D canvas. */
export function drawTilted(cv: HTMLCanvasElement, r: EngineResult, s: Settings, pal: string, o: { rot: number; tilt: number; explode: number; zoom: number }) {
  ensureCache(r);
  const ctx = cv.getContext('2d')!;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, cv.width, cv.height);
  const n = r.layers.length;
  const P = palette(pal);
  const base = fitView(cv, s, 24);
  const sc = base.scale * 0.82 * o.zoom;
  const ct = Math.cos(o.tilt), st = Math.sin(o.tilt);
  const cr = Math.cos(o.rot), sr = Math.sin(o.rot);
  const a = sc * cr, b = sc * ct * sr, c = -sc * sr, d = sc * ct * cr;
  const pitch = s.thickness * (1 + o.explode * 6) * 1.6; // mild exaggeration so steps read on a phone
  const totalZ = n * pitch;
  const oy = base.oy - (totalZ * sc * st) / 2;
  const dpr = cv.width / cv.clientWidth || 1;
  for (let i = n - 1; i >= 0; i--) {
    const path = stackCache.paths[i];
    const zTop = -i * pitch, zBot = zTop - s.thickness * 1.6;
    const col = P.colour(i, n, s.material);
    // side walls: stacked dark copies between bottom and top face
    const steps = Math.max(2, Math.min(8, Math.round((s.thickness * 1.6 * sc * st) / (1.5 * dpr))));
    ctx.fillStyle = 'rgba(20,12,6,0.9)';
    for (let k = 0; k <= steps; k++) {
      const z = zBot + ((zTop - zBot) * k) / steps;
      ctx.setTransform(a, b, c, d, base.ox, oy - z * sc * st);
      ctx.fill(path, 'evenodd');
    }
    ctx.setTransform(a, b, c, d, base.ox, oy - zTop * sc * st);
    ctx.shadowColor = 'rgba(0,0,0,0.45)';
    ctx.shadowBlur = 6 * dpr;
    ctx.fillStyle = col;
    ctx.fill(path, 'evenodd');
    ctx.shadowColor = 'transparent';
    ctx.lineWidth = (0.7 * dpr) / sc;
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.stroke(path);
  }
}

/** Free-mode drawing view: the current top sheet, mirror guides, and your raw strokes by tool. */
export function drawFree(cv: HTMLCanvasElement, r: EngineResult | null, s: Settings,
  art: { outlines: Pt[][]; flows: Pt[][]; scrolls: Pt[][] }, live: Pt[][], liveTool: string,
  colours: { fill: string; outline: string; flow: string; scroll: string; guide: string }) {
  const ctx = cv.getContext('2d')!;
  const v = fitView(cv, s);
  const dpr = cv.width / cv.clientWidth || 1;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, cv.width, cv.height);
  ctx.setTransform(v.scale, 0, 0, v.scale, v.ox, v.oy);
  if (r && r.layers[0]) {
    ensureCache(r);
    ctx.fillStyle = colours.fill;
    ctx.fill(stackCache.paths[0], 'evenodd');
  }
  const W = s.width / 2, H = s.height / 2, px = dpr / v.scale;
  ctx.strokeStyle = colours.guide;
  ctx.lineWidth = px;
  ctx.setLineDash([4 * px, 6 * px]);
  const m = s.freeMirror;
  if (m === 'lr' || m === 'quad') { ctx.beginPath(); ctx.moveTo(0, -H); ctx.lineTo(0, H); ctx.stroke(); }
  if (m === 'ud' || m === 'quad') { ctx.beginPath(); ctx.moveTo(-W, 0); ctx.lineTo(W, 0); ctx.stroke(); }
  ctx.setLineDash([]);
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  const mirror = (ls: Pt[][]) => {
    const out = [...ls];
    const add = (fx: number, fy: number) => { for (const l of ls) out.push(l.map(([x, y]) => [x * fx, y * fy] as Pt)); };
    if (m === 'lr' || m === 'quad') add(-1, 1);
    if (m === 'ud' || m === 'quad') add(1, -1);
    if (m === 'quad') add(-1, -1);
    return out;
  };
  const lines = (ls: Pt[][], col: string, w: number, dash: number[] = [], close = false) => {
    ctx.strokeStyle = col; ctx.lineWidth = w; ctx.setLineDash(dash);
    for (const l of ls) {
      if (l.length < 2) continue;
      ctx.beginPath(); ctx.moveTo(l[0][0], l[0][1]);
      for (const p of l) ctx.lineTo(p[0], p[1]);
      if (close) ctx.closePath();
      ctx.stroke();
    }
    ctx.setLineDash([]);
  };
  // your own strokes stay bright; mirrored copies are faint
  ctx.globalAlpha = 0.35;
  const mo = mirror(art.outlines).slice(art.outlines.length), mf = mirror(art.flows).slice(art.flows.length), ms = mirror(art.scrolls).slice(art.scrolls.length);
  lines(mo, colours.outline, 2 * px, [6 * px, 4 * px], true);
  lines(mf, colours.flow, 2 * px);
  lines(ms, colours.scroll, 2 * px);
  ctx.globalAlpha = 1;
  lines(art.outlines, colours.outline, 2.5 * px, [6 * px, 4 * px], true);
  lines(art.flows, colours.flow, 2.5 * px);
  lines(art.scrolls, colours.scroll, 2.5 * px);
  const lc = liveTool === 'outline' ? colours.outline : liveTool === 'scroll' ? colours.scroll : colours.flow;
  lines(mirror(live), lc, 3 * px, liveTool === 'outline' ? [6 * px, 4 * px] : []);
}
