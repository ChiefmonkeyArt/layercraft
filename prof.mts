import * as G from './src/geom';
import { compute } from './src/engine';
import { defaultsFor } from './src/generators';
import { MOTIFS } from './src/motifs';
const js = process.argv[2]==='js';
await G.initGeom(js);
const base: any = { shape: 'rect', width: 300, height: 300, border: 14, material: 'birch', thickness: 3, rib: 1.8, minRib: 1.4, minOpening: 1.2, step: 2, stepCurve: 0, driftMode: 'in', drift: 0.6, lightAngle: -45, twist: 0, maxLayers: 12, back: true, kerf: 0.15, regHoles: true, regDia: 3, numbers: true, bedW: 900, bedH: 600, seed: 1618, gen:'bloom', params: defaultsFor('bloom'), spokes: 0, spokeTwist: 0, importMode: 'ribs', detailMode: 'symmetric', detailStart: 2, detailEvery: 2, detailSpacing: 5, detailVariety: 0.75, motifs: MOTIFS.map(m=>m.id) };
const a = compute({ s: base, sketch: [], imported: [] });
const b = compute({ s: {...base, motifs: base.motifs.filter((x:string)=>x!=='dots')}, sketch: [], imported: [] });
const c = compute({ s: {...base, motifs: base.motifs.filter((x:string)=>x!=='dots')}, sketch: [], imported: [] });
// verify cached equals fresh
const sig = (r:any)=>r.layers.map((l:any)=>Math.round(l.cutLength)).join(' ');
const ref = (await import('./src/engine')).compute({ s: {...base, seed: 1618, motifs: base.motifs.filter((x:string)=>x!=='dots'), maxLayers: 12}, sketch: [], imported: [] });
console.log(js?'js':'wasm', 'full', Math.round(a.ms), 'toggle', Math.round(b.ms), 'same', Math.round(c.ms), sig(b)===sig(ref));
