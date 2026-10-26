import { rampPalette, snapToPlan, checkAndFix, render, colourName, dE } from '../src/cutready';
import { hexRgb } from '../src/trace';
import { PNG } from 'pngjs';
import { writeFileSync } from 'fs';
// a 900×1200 AI-like picture: soft edges, noise, colour drift, specks, a thin neck and a thin strand
export function synth(plan: string[], skip = -1, shade = 0) {
  const W = 900, H = 1200, S = 3, n = plan.length;
  const level = (x: number, y: number) => {
    const cx = 450, cy = 600; let l = -1;
    if (((x - cx) / 380) ** 2 + ((y - cy) / 520) ** 2 < 1) l = 0;
    if (((x - cx) / 320) ** 2 + ((y - cy) / 450) ** 2 < 1) l = 1;
    if ((x - 330) ** 2 + (y - 520) ** 2 < 90 ** 2 || (x - 570) ** 2 + (y - 520) ** 2 < 90 ** 2 || (Math.abs(y - 520) < 1.2 && x > 330 && x < 570)) l = 2; // two eyes joined by a 2.4 px neck
    if (Math.abs(y - (800 + 40 * Math.sin(x / 40))) < 1.0 && x > 250 && x < 650) l = 3; // a hairline strand
    if ((x - 450) ** 2 + (y - 700) ** 2 < 60 ** 2) l = 3;
    if ((x - 330) ** 2 + (y - 520) ** 2 < 35 ** 2 || (x - 570) ** 2 + (y - 520) ** 2 < 35 ** 2) l = 4;
    if (skip >= 0 && l === skip) l = l - 1;
    return l;
  };
  const rgb = ['#ffffff', ...plan].map(hexRgb).map((c, k) => k ? c.map((v, j) => v + [6, -5, 4][j]) : c); // the AI drifts off the codes
  const data = new Uint8ClampedArray(W * H * 4); let r = 7;
  const rnd = () => ((r = (r * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const acc = [0, 0, 0];
    for (let sy = 0; sy < S; sy++) for (let sx = 0; sx < S; sx++) { const c = rgb[level(x + (sx + 0.5) / S, y + (sy + 0.5) / S) + 1]; acc[0] += c[0]; acc[1] += c[1]; acc[2] += c[2]; }
    const i = (y * W + x) * 4, nz = (rnd() - 0.5) * 8 + shade * Math.sin(x / 90) * Math.cos(y / 110);
    data[i] = acc[0] / S / S + nz; data[i + 1] = acc[1] / S / S + nz; data[i + 2] = acc[2] / S / S + nz; data[i + 3] = 255;
  }
  for (let k = 0; k < 40; k++) { const x = 150 + ((rnd() * 600) | 0), y = 200 + ((rnd() * 800) | 0), c = hexRgb(plan[(rnd() * n) | 0]); for (let d = 0; d < 4; d++) { const i = ((y + (d >> 1)) * W + x + (d & 1)) * 4; data[i] = c[0]; data[i + 1] = c[1]; data[i + 2] = c[2]; } }
  return { w: W, h: H, data };
}
const savePng = (img: { w: number; h: number; data: Uint8ClampedArray }, f: string) => { const p = new PNG({ width: img.w, height: img.h }); p.data = Buffer.from(img.data.buffer); writeFileSync(f, PNG.sync.write(p)); };
if (process.argv[1]?.endsWith('cutready-synth.ts')) {
  const plan = rampPalette(5, 'sunset');
  console.log(plan.map((c) => `${c} ${colourName(c)}`).join(' | '));
  console.log('neighbour ΔE', plan.slice(1).map((c, i) => dE(c, plan[i]).toFixed(0)).join(' '));
  for (const [skip, shade] of [[-1, 0], [3, 0], [-1, 18]]) {
    const img = synth(plan, skip, shade); const t0 = Date.now();
    const s = snapToPlan(img, plan); const { labels, report } = checkAndFix(s, { mmPerPx: 292 / 760, rib: 1.4 });
    console.log(`skip ${skip} shade ${shade}: ${Date.now() - t0} ms`, JSON.stringify({ ...report, spots: report.spots.length }));
    if (skip < 0) { savePng(img, `/tmp/tt/synth-in${shade}.png`); savePng(render(labels, img.w, img.h, s.cols), `/tmp/tt/synth-out${shade}.png`); }
  }
}
