import { initGeom } from './src/geom';
import { compute } from './src/engine';
import { defaultsFor } from './src/generators';
import { MOTIFS } from './src/motifs';
const js = process.argv[2]==='js';
await initGeom(js);
const base: any = { shape: 'rect', width: 300, height: 300, border: 14, material: 'birch', thickness: 3, rib: 1.8, minRib: 1.4, minOpening: 1.2, step: 2, stepCurve: 0, driftMode: 'in', drift: 0.6, lightAngle: -45, twist: 0, maxLayers: 12, back: true, kerf: 0.15, regHoles: true, regDia: 3, numbers: true, bedW: 900, bedH: 600, seed: 1618, gen:'bloom', params: defaultsFor('bloom'), spokes: 0, spokeTwist: 0, importMode: 'ribs', detailMode: 'symmetric', detailStart: 2, detailEvery: 2, detailSpacing: 5, detailVariety: 0.75 };
for (const m of [MOTIFS.map(m=>m.id), MOTIFS.map(m=>m.id).filter(x=>x!=='dots'), ['hatch']]) {
  const r = compute({ s: { ...base, motifs: m }, sketch: [], imported: [] });
  const sig = r.layers.map(l=>Math.round(l.cutLength)).join(' ');
  console.log(js?'js ':'wasm', m.length, Math.round(r.ms)+'ms', sig);
}
