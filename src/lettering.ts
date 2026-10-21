// Real font lettering: the traced letters are replaced by the outlines of a bundled free font,
// fitted line by line to where the lettering sits in the picture. Fonts are served by the app
// itself (no font services are contacted).
import opentype from 'opentype.js';
import type { Pt } from './geom';

export interface LetterFont { id: string; label: string; file: string }
export const FONTS: LetterFont[] = [
  { id: 'cooper-italic', label: 'Cooper italic', file: 'lettering-cooper-italic.ttf' },
  { id: 'cooper', label: 'Cooper style', file: 'lettering-cooper.ttf' },
  { id: 'round', label: 'Rounded', file: 'lettering-round.ttf' },
  { id: 'sans', label: 'Bold sans', file: 'lettering-sans.ttf' },
];

/** The bundled font closest to what the AI said the lettering looks like. */
export function pickFont(name: string): string {
  const n = name.toLowerCase();
  if (/italic|swash|script|brush|oblique/.test(n)) return 'cooper-italic';
  if (/cooper|windsor|souvenir|bookman|serif|recoleta|fraunces|goudy|groovy|retro|70s|seventies/.test(n)) return 'cooper';
  if (/round|nunito|vag|arial rounded|comfortaa|quicksand|bubble/.test(n)) return 'round';
  return n ? 'sans' : 'cooper';
}

const cache = new Map<string, Promise<any>>();
function load(id: string): Promise<any> {
  const f = FONTS.find((x) => x.id === id) ?? FONTS[0];
  let p = cache.get(f.id);
  if (!p) {
    p = fetch(`${import.meta.env.BASE_URL}fonts/${f.file}`).then((r) => { if (!r.ok) throw new Error('font missing'); return r.arrayBuffer(); }).then((b) => opentype.parse(b));
    cache.set(f.id, p); p.catch(() => cache.delete(f.id));
  }
  return p;
}

/** Each line of text as closed outlines (font units, y down), ready to fit into the picture. */
export async function lineShapes(fontId: string, lines: string[]): Promise<Pt[][][]> {
  const font = await load(fontId);
  return lines.map((line) => {
    const path = font.getPath(line, 0, 0, 1000, { kerning: true });
    const rings: Pt[][] = []; let cur: Pt[] = []; let x0 = 0, y0 = 0;
    const seg = (n: number, f: (t: number) => Pt) => { for (let i = 1; i <= n; i++) cur.push(f(i / n)); };
    for (const c of path.commands as any[]) {
      if (c.type === 'M') { if (cur.length > 2) rings.push(cur); cur = [[c.x, c.y]]; x0 = c.x; y0 = c.y; }
      else if (c.type === 'L') { cur.push([c.x, c.y]); x0 = c.x; y0 = c.y; }
      else if (c.type === 'Q') { const ax = x0, ay = y0; seg(10, (t) => { const u = 1 - t; return [u * u * ax + 2 * u * t * c.x1 + t * t * c.x, u * u * ay + 2 * u * t * c.y1 + t * t * c.y]; }); x0 = c.x; y0 = c.y; }
      else if (c.type === 'C') { const ax = x0, ay = y0; seg(14, (t) => { const u = 1 - t; return [u * u * u * ax + 3 * u * u * t * c.x1 + 3 * u * t * t * c.x2 + t * t * t * c.x, u * u * u * ay + 3 * u * u * t * c.y1 + 3 * u * t * t * c.y2 + t * t * t * c.y]; }); x0 = c.x; y0 = c.y; }
      else if (c.type === 'Z') { if (cur.length > 2) rings.push(cur); cur = []; }
    }
    if (cur.length > 2) rings.push(cur);
    return rings;
  });
}

/** Split the lettering into the number of lines found in the picture, keeping words whole;
 *  with the lines' widths, pick the split whose line lengths match them best. */
export function splitLines(text: string, given: string[] | undefined, n: number, widths?: number[]): string[] {
  if (given && given.length === n) return given;
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (n <= 1 || words.length <= 1) return [words.join(' ')];
  if (words.length <= n) return words;
  if (widths && widths.length === n && words.length <= 14) {
    const tot = widths.reduce((a, b) => a + b, 0);
    let best: string[] | null = null, bs = Infinity;
    const rec = (start: number, left: number, acc: string[]) => {
      if (left === 1) {
        const out = [...acc, words.slice(start).join(' ')];
        const len = out.map((l) => l.length), lt = len.reduce((a, b) => a + b, 0);
        const sc = out.reduce((a, _, i) => a + (len[i] / lt - widths[i] / tot) ** 2, 0);
        if (sc < bs) { bs = sc; best = out; }
        return;
      }
      for (let e = start + 1; e <= words.length - left + 1 - 0; e++) { if (words.length - e < left - 1) break; rec(e, left - 1, [...acc, words.slice(start, e).join(' ')]); }
    };
    rec(0, n, []);
    if (best) return best;
  }
  // balance by character count
  const total = words.join(' ').length, out: string[] = []; let cur: string[] = [];
  for (const w of words) {
    const left = n - out.length;
    if (cur.length && left > 1 && (cur.join(' ').length + w.length / 2) > total / n) { out.push(cur.join(' ')); cur = []; }
    cur.push(w);
  }
  out.push(cur.join(' '));
  return out;
}
