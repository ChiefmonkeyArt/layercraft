// Hero and Pop: two cut-ready designs combined into one physical stack.
//
// Each design is a set of flat colours, one per level (back first), where a pixel of level k is
// material on that design's sheets 0..k. The combined stack gives every pixel a height: the
// highest final sheet that has material there. A Pop shape placed on sheet 14 therefore stands on
// a column of material all the way down (it is supported), and hides only what is under it.
// The result is a colour picture (the visible face of every pixel) and an exact grey height map,
// which the tracer reads without guessing.
import { hexRgb } from './trace';

/** Where one Pop level goes: merged onto a Hero sheet, or on its own sheet just above it. */
export interface PopPlace { hero: number; own: boolean } // hero: Hero level index (0 = back)

export interface Slot { hero?: number; pops: number[] } // one final sheet, back first

/** The final sheets, back first. Pop levels on their own sheets above the same Hero level stay in Pop order. */
export function slotsOf(nHero: number, place: PopPlace[]): { slots: Slot[]; heroSlot: number[]; popSlot: number[] } {
  const slots: Slot[] = [], heroSlot: number[] = [], popSlot: number[] = new Array(place.length).fill(0);
  const P = place.map((p) => ({ hero: Math.max(0, Math.min(nHero - 1, p.hero)), own: p.own }));
  for (let i = 0; i < nHero; i++) {
    heroSlot[i] = slots.length;
    const merged = P.map((p, j) => (!p.own && p.hero === i ? j : -1)).filter((j) => j >= 0);
    for (const j of merged) popSlot[j] = slots.length;
    slots.push({ hero: i, pops: merged });
    for (let j = 0; j < P.length; j++) if (P[j].own && P[j].hero === i) { popSlot[j] = slots.length; slots.push({ pops: [j] }); }
  }
  return { slots, heroSlot, popSlot };
}

/** Pop levels spread evenly through the Hero, each on its own sheet. */
export function spreadPlace(nHero: number, nPop: number): PopPlace[] {
  return Array.from({ length: nPop }, (_, j) => ({ hero: Math.min(nHero - 1, Math.max(0, Math.round(((j + 1) * nHero) / (nPop + 1)) - 1)), own: true }));
}
/** Pop levels merged onto the Hero's top sheets (fewest extra sheets). */
export function mergePlace(nHero: number, nPop: number): PopPlace[] {
  return Array.from({ length: nPop }, (_, j) => ({ hero: Math.max(0, nHero - nPop + j), own: false }));
}
/** Pop levels stacked on top of the Hero. */
export function topPlace(nHero: number, nPop: number): PopPlace[] {
  return Array.from({ length: nPop }, () => ({ hero: nHero - 1, own: true }));
}

/** One step up or down through the positions: merged with Hero i, own sheet above Hero i, merged with Hero i+1, … */
export function nudge(p: PopPlace, dir: 1 | -1, nHero: number): PopPlace {
  const v = Math.max(0, Math.min(nHero * 2 - 1, p.hero * 2 + (p.own ? 1 : 0) + dir));
  return { hero: Math.floor(v / 2), own: v % 2 === 1 };
}

/** Level per pixel of a cleaned design (exact plan colours; anything else is background). */
export function labelsOf(data: Uint8ClampedArray, n: number, plan: string[]): Int8Array {
  const L = new Int8Array(n).fill(-1), P = plan.map(hexRgb);
  for (let i = 0; i < n; i++) {
    const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2];
    let best = -1, bd = 40 * 40 * 3; // the cleaned picture is exact; allow a little for resampling
    for (let k = 0; k < P.length; k++) { const d = (P[k][0] - r) ** 2 + (P[k][1] - g) ** 2 + (P[k][2] - b) ** 2; if (d < bd) { bd = d; best = k; } }
    L[i] = best;
  }
  return L;
}

export interface Raster { width: number; height: number; data: Uint8ClampedArray }
export interface Composite { colour: Raster; map: Raster; n: number; palette: string[]; slots: Slot[]; heroSlot: number[]; popSlot: number[] }

/** Hero and Pop (labels on the same grid) combined into a colour picture and an exact height map. */
export function compose(w: number, h: number, hero: Int8Array, heroPlan: string[], pop: Int8Array | null, popPlan: string[], place: PopPlace[]): Composite {
  const { slots, heroSlot, popSlot } = slotsOf(heroPlan.length, pop ? place : []);
  const n = slots.length, N = w * h;
  // a Pop pixel of level k is material on Pop sheets 0..k: its height is the highest of their slots
  const popTop = popSlot.map((_, k) => Math.max(...popSlot.slice(0, k + 1)));
  const colour: Raster = { width: w, height: h, data: new Uint8ClampedArray(N * 4) }, map: Raster = { width: w, height: h, data: new Uint8ClampedArray(N * 4) };
  const HC = heroPlan.map(hexRgb), PC = popPlan.map(hexRgb);
  const grey = Array.from({ length: n }, (_, s) => Math.round(255 * (s + 1) / n));
  for (let i = 0; i < N; i++) {
    const hl = hero[i], pl = pop ? pop[i] : -1;
    const hh = hl >= 0 ? heroSlot[hl] : -1, ph = pl >= 0 ? popTop[pl] : -1;
    const o = i * 4;
    if (hh < 0 && ph < 0) { colour.data[o] = colour.data[o + 1] = colour.data[o + 2] = 255; colour.data[o + 3] = 255; map.data[o + 3] = 255; continue; }
    const c = ph >= hh ? PC[pl] : HC[hl], g = grey[Math.max(hh, ph)];
    colour.data[o] = c[0]; colour.data[o + 1] = c[1]; colour.data[o + 2] = c[2]; colour.data[o + 3] = 255;
    map.data[o] = map.data[o + 1] = map.data[o + 2] = g; map.data[o + 3] = 255;
  }
  const palette = ['#ffffff', ...heroPlan, ...popPlan].filter((c, i, a) => a.indexOf(c) === i);
  return { colour, map, n, palette, slots, heroSlot, popSlot };
}
