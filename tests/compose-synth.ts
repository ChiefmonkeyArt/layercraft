// Hero + Pop combined into one stack, traced through the exact height map: every traced sheet must
// match the planned heights (a Pop shape on sheet s is material on every sheet below it).
import { PNG } from 'pngjs';
import { readFileSync, writeFileSync } from 'fs';
import { rampPalette, snapToPlan, checkAndFix, render } from '../src/cutready';
import { compose, labelsOf, spreadPlace, mergePlace, type PopPlace } from '../src/compose';
import { trace } from '../src/trace';
import { sheetMasks } from './suite';
import { synth } from './cutready-synth';

const save = (r: { width: number; height: number; data: Uint8ClampedArray }, f: string) => { const p = new PNG({ width: r.width, height: r.height }); p.data = Buffer.from(r.data.buffer); writeFileSync(f, PNG.sync.write(p)); };
const heroPlan = rampPalette(5, 'sunset'), popPlan = rampPalette(3, 'ocean');
const W = 900, H = 1200, N = W * H;
// Hero: the synthetic face, cleaned
const hs = snapToPlan(synth(heroPlan, -1, 0), heroPlan);
const hc = checkAndFix(hs, { mmPerPx: 292 / 760, rib: 1.4 });
const hero = labelsOf(render(hc.labels, W, H, hs.cols).data, N, heroPlan);
// Pop: stars around the face and a band across it (partly outside the Hero)
const pop = new Int8Array(N).fill(-1);
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  const i = y * W + x;
  if (Math.abs(y - 300 - 0.15 * (x - 450)) < 40 && x > 40 && x < 860) pop[i] = 0;          // a band, beyond the face edge too
  for (const [cx, cy] of [[200, 950], [700, 950], [450, 1080]]) if ((x - cx) ** 2 + (y - cy) ** 2 < 55 ** 2) pop[i] = 0;
  for (const [cx, cy] of [[200, 950], [700, 950], [450, 1080]]) if ((x - cx) ** 2 + (y - cy) ** 2 < 30 ** 2) pop[i] = 1;
  if ((x - 450) ** 2 + (y - 1080) ** 2 < 14 ** 2) pop[i] = 2;
}
let fail = 0;
for (const [name, place] of [['spread', spreadPlace(5, 3)], ['merge', mergePlace(5, 3)], ['8-14-21 style', [{ hero: 0, own: true }, { hero: 2, own: true }, { hero: 4, own: true }] as PopPlace[]]] as [string, PopPlace[]][]) {
  const c = compose(W, H, hero, heroPlan, pop, popPlan, place);
  save(c.colour, `/tmp/tt/comp-${name.split(' ')[0]}.png`); save(c.map, `/tmp/tt/compmap-${name.split(' ')[0]}.png`);
  const widthMm = 300, heightMm = 400;
  const t0 = Date.now();
  const out = trace({ w: W, h: H, data: c.colour.data }, { depth: 'map', depthMap: { w: W, h: H, data: c.map.data }, mapLevels: c.n, mapKind: 'flat', colours: c.palette.length, palette: c.palette, smooth: 0.3, minPiece: 25, rib: 1.4, slot: 1.2, widthMm, heightMm, shape: 'rect', follow: true, rimMm: 4, merge: 11, fair: 0.21, darkFirst: false, gaps: 'keep' } as any);
  // expected sheet s (top first) material: height >= n-1-s
  const greys = c.map.data;
  const masks = sheetMasks({ W: widthMm, H: heightMm, outline: out.outline!, openings: out.openings, palette: [], order: [] }, 300, 400);
  const res: string[] = [];
  // the rim each sheet keeps round the outline is not part of the comparison
  const back = masks[masks.length - 1], core = new Uint8Array(300 * 400), R = 6;
  for (let y = R; y < 400 - R; y++) for (let x = R; x < 300 - R; x++) {
    let all = 1; for (let dy = -R; dy <= R && all; dy += 2) for (let dx = -R; dx <= R; dx += 2) if (!back[(y + dy) * 300 + x + dx]) { all = 0; break; }
    core[y * 300 + x] = all;
  }
  for (let s = 0; s < out.openings.length; s++) {
    const lvl = c.n - 1 - s; let inter = 0, uni = 0;
    for (let y = 0; y < 400; y++) for (let x = 0; x < 300; x++) {
      const gx = Math.min(W - 1, Math.floor((x + 0.5) * W / 300)), gy = Math.min(H - 1, Math.floor((y + 0.5) * H / 400));
      const g = greys[(gy * W + gx) * 4], want = g >= Math.round(255 * (lvl + 1) / c.n) - 3 && greys[(gy * W + gx) * 4 + 3] && g > 0;
      if (!core[y * 300 + x]) continue;
      const got = !!masks[s][y * 300 + x];
      if (want && got) inter++; if (want || got) uni++;
    }
    res.push((100 * inter / Math.max(1, uni)).toFixed(1));
    if (inter / Math.max(1, uni) < 0.8) fail++;
  }
  console.log(`${name}: ${c.n} sheets planned, ${out.openings.length + 1} traced in ${Date.now() - t0} ms; sheet match (top first): ${res.join(' ')}%; colours ${out.order.map((k) => out.palette[k]).join(' ')}`);
  if (out.openings.length + 1 !== c.n) fail++;
}
console.log(fail ? `FAIL (${fail})` : 'all combined stacks match');
process.exit(fail ? 1 : 0);
