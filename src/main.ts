import './style.css';
import type { Pt } from './geom';
import { initGeom } from './geom';
import type { EngineResult, Settings } from './engine';
import { GENERATORS, defaultsFor, genById, randomParams, rng } from './generators';
import { CUSTOM, PALETTES, VIEW, drawFree, palette, drawLayer, drawSketch, drawStack, drawTilted, screenToMm } from './render2d';
import type { FreeArt } from './free';
import { emptyFree, exampleFree, soften } from './free';
import type { Stack3D } from './render3d';
// Three.js is large; it is only loaded the first time full 3D is opened.
let Stack3DClass: typeof Stack3D | null = null;
let loading3d = false;
import { MOTIFS } from './motifs';
import type { TraceOpts, TraceOut } from './trace';
import { REDRAW_PROMPT, analysePicture, hexDist, trace as traceNow } from './trace';
import type { PictureCheck } from './ai';
import { lineShapes, pickFont, splitLines } from './lettering';
import { allLayersSVG, download, exportZip, layerSVG, parseSVG, planSheets, simplify } from './svgio';
import { createGuided, store } from './guided';
import { createAiUi } from './aiui';
import { deleteProject, getProject, listProjects, newId, saveProject } from './projects';

// ---------------- materials ----------------
const MATERIALS: Record<string, { name: string; s: Partial<Settings> }> = {
  birch: { name: 'Birch ply', s: { thickness: 3, rib: 1.8, minRib: 1.4, minOpening: 1.2, step: 2, kerf: 0.15, maxLayers: 12, regDia: 3, detailSpacing: 5 } },
  oak: { name: 'Oak ply', s: { thickness: 3, rib: 1.8, minRib: 1.4, minOpening: 1.2, step: 2, kerf: 0.15, maxLayers: 12, regDia: 3, detailSpacing: 5 } },
  paper: { name: 'Paper / card', s: { thickness: 0.4, rib: 1.2, minRib: 0.9, minOpening: 0.8, step: 1.2, kerf: 0.08, maxLayers: 24, regDia: 3, detailSpacing: 3 } },
  custom: { name: 'Custom', s: {} },
};

const S: Settings = {
  shape: 'rect', width: 300, height: 300, border: 14,
  material: 'birch', thickness: 3, rib: 1.8, minRib: 1.4, minOpening: 1.2,
  step: 2, stepCurve: 0, driftMode: 'in', drift: 0.6, lightAngle: -45, twist: 0,
  maxLayers: 12, back: true,
  kerf: 0.15, regHoles: true, regDia: 3, numbers: true,
  bedW: 900, bedH: 600,
  gen: 'bloom', seed: 1618, params: defaultsFor('bloom'),
  spokes: 0, spokeTwist: 0, importMode: 'ribs',
  detailMode: 'symmetric', detailStart: 2, detailEvery: 2, detailSpacing: 5, detailVariety: 0.75,
  motifs: MOTIFS.map((m) => m.id),
  repeat: 'centre', freeMirror: 'lr', flowEchoes: 4, flowSpacing: 4, scrollSize: 14, scrollGap: 22,
  traceColours: 12, traceSmooth: 0.6, traceMinPiece: 25, traceDarkFirst: true, traceFollow: false, traceFont: '',
  corners: false, cornerSize: 0.9, cornerRings: 3, cornerGap: 4.5, cornerCurl: 30, cornerBars: true,
};
// Free mode drawing: raw strokes per tool (mirroring is applied when the design is built)
type Tool = 'outline' | 'flow' | 'scroll';
const TOOL_KEY = { outline: 'outlines', flow: 'flows', scroll: 'scrolls' } as const;
let free: FreeArt = emptyFree();
const freeUndo: Tool[] = [];
let tool: Tool = 'outline';
let penSeen = false; // once a stylus is used, fingers pan and zoom instead of drawing
const FREE_COL = { outline: '#7ad7ff', flow: '#ff7a3d', scroll: '#c99bff' };

let sketch: Pt[][] = [];
const sketchUndo: number[] = [];
let imported: Pt[][] = [];
let importName = '';
let result: EngineResult | null = null;
let colourway = 'custom';
// colourway id passed to renderers; the custom one carries a version so cached 3D colours refresh
const colourKey = () => (colourway === 'custom' ? `custom#${CUSTOM.version}` : colourway);
let view: 'stack' | '3d' | 'layers' | 'sketch' = 'stack';
let guided: ReturnType<typeof createGuided> | null = null;
let guidedOn = false;
let pictureCheck: PictureCheck | null = null; // what the AI picture check said about this picture
let checkOrderPending = false; // apply the AI's layer order after the next trace
let pictureInfo: { colours: number; shaded: boolean; plainBg: boolean; found: { hex: string; share: number }[] } | null = null;
let booted = false, touched = false; // autosave only once the user has changed something
let projectId = '';
let layerIdx = 0;
let sym = 8, mirror = true;
let projectName = 'Untitled stack';
// Phones default to the WebGL-free 3D view; full WebGL 3D is one tap away.
let simple3d = matchMedia('(pointer: coarse)').matches && Math.min(screen.width, screen.height) < 820;
const tiltView = { rot: 0.45, tilt: 0.95, explode: 0, zoom: 1 };

// ---------------- dom helpers ----------------
const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector(sel) as T;
function h(tag: string, attrs: Record<string, any> = {}, ...kids: (Node | string | null | undefined)[]) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, '');
    else if (v !== false && v != null) el.setAttribute(k, String(v));
  }
  for (const c of kids) if (c != null) el.append(c);
  return el;
}

const LOGO = `<svg viewBox="0 0 40 40" width="30" height="30" aria-label="Layercraft Stack" fill="none">
  <rect x="3" y="3" width="34" height="34" rx="3" stroke="currentColor" stroke-width="2.2"/>
  <rect x="9" y="8" width="24" height="24" rx="2.5" stroke="currentColor" stroke-width="2.2" opacity=".75"/>
  <rect x="15" y="13" width="14" height="14" rx="2" stroke="currentColor" stroke-width="2.2" opacity=".5"/>
  <rect x="20.5" y="18" width="5" height="5" rx="1" fill="var(--accent)"/>
</svg>`;

// ---------------- layout ----------------
const app = $('#app');
app.innerHTML = `
<header class="top">
  <div class="brand">${LOGO}<div><div class="name">Layercraft <span>Stack</span></div><div class="tag">Layered laser-cut art generator</div></div></div>
  <input class="pname" id="pname" value="${projectName}" aria-label="Project name" spellcheck="false"/>
  <button class="btn ghost modebtn" id="mode" aria-pressed="false">Advanced</button>
  <div class="actions">
    <button class="btn ghost" id="surprise" title="Random psychedelic design">Surprise me</button>
    <button class="btn ghost" id="open">Open</button>
    <button class="btn ghost" id="save">Save project</button>
    <button class="btn primary" id="export">Export SVGs</button>
    <input type="file" id="openfile" accept=".json,application/json" hidden />
  </div>
</header>
<div class="body">
  <aside class="panel" id="panel"></aside>
  <main class="stage">
    <div id="gbarhost"></div>
    <nav class="tabs" role="tablist">
      <button data-v="stack" class="on">Stack</button>
      <button data-v="3d">3D</button>
      <button data-v="layers">Layers</button>
      <button data-v="sketch">Draw</button>
      <div class="spacer"></div>
      <div class="busy" id="busy"><i></i>Computing</div>
    </nav>
    <div class="viewport" id="viewport">
      <canvas id="cv"></canvas>
      <div id="three" class="three" hidden></div>
      <div class="empty" id="empty" hidden></div>
    </div>
    <div class="toolbar" id="toolbar"></div>
    <footer class="status">
      <div class="stats" id="stats"></div>
      <div class="warn" id="warn"></div>
    </footer>
  </main>
</div>
<div class="toast" id="toast"></div>`;

const cv = $<HTMLCanvasElement>('#cv');
const panel = $('#panel');
const toolbar = $('#toolbar');
let stack3d: Stack3D | null = null;

function toast(msg: string) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('on');
  clearTimeout((t as any)._h);
  (t as any)._h = setTimeout(() => t.classList.remove('on'), 2600);
}

// ---------------- controls ----------------
type Ctl = { el: HTMLElement; sync: () => void };
const ctls: Ctl[] = [];

function slider(label: string, get: () => number, set: (v: number) => void, min: number, max: number, step: number, unit = '', hint = '') {
  const input = h('input', { type: 'range', min, max, step }) as HTMLInputElement;
  const num = h('input', { type: 'number', min, max, step, class: 'num' }) as HTMLInputElement;
  const row = h('label', { class: 'row', title: hint }, h('span', { class: 'lab' }, label), input, h('span', { class: 'numwrap' }, num, unit ? h('em', {}, unit) : null));
  const sync = () => { input.value = String(get()); num.value = String(+get().toFixed(3)); };
  input.addEventListener('input', () => { set(+input.value); num.value = input.value; schedule(); });
  num.addEventListener('change', () => { const v = +num.value; if (isFinite(v)) { set(v); input.value = String(v); schedule(); } });
  sync();
  ctls.push({ el: row, sync });
  return row;
}

function select(label: string, get: () => string, set: (v: string) => void, opts: [string, string][], after?: () => void) {
  const sel = h('select', {}, ...opts.map(([v, t]) => h('option', { value: v }, t))) as HTMLSelectElement;
  const row = h('label', { class: 'row sel' }, h('span', { class: 'lab' }, label), sel);
  const sync = () => { sel.value = get(); };
  sel.addEventListener('change', () => { set(sel.value); after?.(); schedule(); });
  sync();
  ctls.push({ el: row, sync });
  return row;
}

function toggle(label: string, get: () => boolean, set: (v: boolean) => void) {
  const cb = h('input', { type: 'checkbox' }) as HTMLInputElement;
  const row = h('label', { class: 'row tog' }, h('span', { class: 'lab' }, label), h('span', { class: 'switch' }, cb, h('i')));
  const sync = () => { cb.checked = get(); };
  cb.addEventListener('change', () => { set(cb.checked); schedule(); });
  sync();
  ctls.push({ el: row, sync });
  return row;
}

function section(title: string, open: boolean, ...kids: (Node | null)[]) {
  const d = h('details', { class: 'sec', open }, h('summary', {}, title), h('div', { class: 'secbody' }, ...kids));
  return d;
}

const genParamsHost = h('div', { class: 'genparams' });
function buildGenParams() {
  genParamsHost.innerHTML = '';
  if (S.gen === 'none') { genParamsHost.append(h('p', { class: 'note' }, 'No generated pattern. Use Sketch or Import to draw the top layer.')); return; }
  const g = genById(S.gen);
  genParamsHost.append(h('p', { class: 'note' }, g.blurb));
  for (const d of g.params) genParamsHost.append(slider(d.label, () => S.params[d.key] ?? d.def, (v) => (S.params[d.key] = v), d.min, d.max, d.step));
}

const importInfo = h('div', { class: 'note' });
function updateImportInfo() {
  importInfo.textContent = imported.length ? `${importName}: ${imported.length} path${imported.length > 1 ? 's' : ''} loaded.` : 'Import an SVG line drawing (e.g. from Inkscape). Lines become wooden ribs, or closed shapes become openings.';
}

function buildPanel() {
  panel.innerHTML = '';
  ctls.length = 0;
  const seedRow = h('div', { class: 'row seedrow' },
    h('span', { class: 'lab' }, 'Seed'),
    (() => { const i = h('input', { type: 'number', class: 'num wide', value: S.seed }) as HTMLInputElement; i.addEventListener('change', () => { S.seed = +i.value | 0; schedule(); }); ctls.push({ el: i, sync: () => (i.value = String(S.seed)) }); return i; })(),
    h('button', { class: 'btn small', onclick: () => { S.seed = (Math.random() * 1e6) | 0; syncAll(); schedule(); } }, 'Reroll'),
  );
  const fileIn = h('input', { type: 'file', accept: '.svg,image/svg+xml', hidden: true }) as HTMLInputElement;
  fileIn.addEventListener('change', async () => {
    const f = fileIn.files?.[0];
    if (!f) return;
    try {
      const txt = await f.text();
      const r = parseSVG(txt, S.width - 2 * S.border, S.height - 2 * S.border);
      imported = r.lines; importName = f.name;
      updateImportInfo(); schedule(); toast(`Imported ${r.count} paths from ${f.name}`);
    } catch (e: any) { toast(e.message || 'Could not read that SVG'); }
    fileIn.value = '';
  });
  updateImportInfo();

  panel.append(...[
    section('Pattern', true,
      select('Repeat', () => S.repeat, (v) => setRepeat(v as any), [['centre', 'Centre — mandala'], ['free', 'Free — draw your own'], ['trace', 'Trace an image']]),
      ...(S.repeat === 'trace' ? traceControls() : S.repeat === 'free' ? freeControls() : [
        select('Generator', () => S.gen, (v) => { S.gen = v; S.params = v === 'none' ? {} : defaultsFor(v); }, [...GENERATORS.map((g) => [g.id, g.name] as [string, string]), ['none', 'None (sketch / import only)']], buildGenParams),
        seedRow,
        genParamsHost,
        slider('Extra spokes', () => S.spokes, (v) => (S.spokes = v), 0, 48, 1, '', 'Radial ribs that tie floating rings to the frame'),
        slider('Spoke twist', () => S.spokeTwist, (v) => (S.spokeTwist = v), -3, 3, 0.05, 'rad'),
      ]),
    ),
    section('Layer colours', true, colourPanel()),
    S.repeat === 'trace' ? null : section('Frame corners', false,
      h('p', { class: 'note' }, S.shape === 'rect' ? 'Scrollwork in the four corners, like a carved frame. The main design stays inside the curved divider.' : 'Corner scrolls need the Rectangle outline.'),
      toggle('Corner scrolls', () => S.corners, (v) => (S.corners = v)),
      slider('Corner size', () => S.cornerSize, (v) => (S.cornerSize = v), 0, 1, 0.01, '', 'How far the corner scrollwork reaches in towards the middle'),
      slider('Scroll ribs', () => S.cornerRings, (v) => (S.cornerRings = v), 0, 8, 1, 'each side', 'Parallel ribs either side of each scroll'),
      slider('Rib spacing', () => S.cornerGap, (v) => (S.cornerGap = v), 2, 20, 0.1, 'mm'),
      slider('Curl size', () => S.cornerCurl, (v) => (S.cornerCurl = v), 5, 80, 0.5, 'mm', 'Size of the spiral at the end of each scroll (limited by the space available)'),
      toggle('Diagonal bars', () => S.cornerBars, (v) => (S.cornerBars = v)),
    ),
    S.repeat === 'trace' ? null : section('Your own artwork', false,
      importInfo,
      h('div', { class: 'btnrow' },
        h('button', { class: 'btn small', onclick: () => fileIn.click() }, 'Import SVG'),
        h('button', { class: 'btn small ghost', onclick: () => { imported = []; importName = ''; updateImportInfo(); schedule(); } }, 'Clear import'),
      ),
      select('SVG means', () => S.importMode, (v) => (S.importMode = v as any), [['ribs', 'Lines are wooden ribs'], ['openings', 'Closed shapes are openings']]),
      h('p', { class: 'note' }, 'Or open the Draw tab to draw with symmetry on top of any pattern.'),
      fileIn,
    ),
    section('Material & size', true,
      select('Material', () => S.material, (v) => { S.material = v; Object.assign(S, MATERIALS[v].s); syncAll(); }, Object.entries(MATERIALS).map(([k, m]) => [k, m.name])),
      slider('Sheet thickness', () => S.thickness, (v) => (S.thickness = v), 0.1, 12, 0.05, 'mm'),
      select('Outline', () => S.shape, (v) => (S.shape = v as any), [['rect', 'Rectangle'], ['circle', 'Circle'], ['hex', 'Hexagon']], buildPanel),
      slider('Width', () => S.width, (v) => (S.width = v), 60, 1200, 1, 'mm'),
      slider('Height', () => S.height, (v) => (S.height = v), 60, 1200, 1, 'mm'),
      slider('Frame border', () => S.border, (v) => (S.border = v), 2, 60, 0.5, 'mm'),
    ),
    S.repeat === 'trace' ? null : section('Layer rule', true,
      h('p', { class: 'note' }, 'Every sheet is the sheet above with its openings shrunk by the step, then nudged by drift and twist.'),
      slider('Step per layer', () => S.step, (v) => (S.step = v), 0.3, 10, 0.1, 'mm', 'How far each opening shrinks per sheet'),
      slider('Step acceleration', () => S.stepCurve, (v) => (S.stepCurve = v), -0.3, 0.6, 0.01, '', 'Positive = deeper steps grow, a tunnel effect'),
      select('Drift', () => S.driftMode, (v) => (S.driftMode = v as any), [['none', 'None — even terraces'], ['in', 'Toward centre'], ['out', 'Away from centre'], ['light', 'One direction (shading)']]),
      slider('Drift amount', () => S.drift, (v) => (S.drift = v), 0, 2, 0.05, '× step'),
      slider('Drift angle', () => S.lightAngle, (v) => (S.lightAngle = v), -180, 180, 1, '°', 'Direction for one-direction drift, and preview light'),
      slider('Twist per layer', () => S.twist, (v) => (S.twist = v), -10, 10, 0.1, '°', 'Rotates each sheet’s openings for a spiral staircase'),
      slider('Max layers', () => S.maxLayers, (v) => (S.maxLayers = v), 2, 60, 1, '', 'Stops early once every opening has closed'),
      toggle('Solid back panel', () => S.back, (v) => (S.back = v)),
    ),
    S.repeat === 'trace' ? null : section('Detail layers', true,
      h('p', { class: 'note' }, 'Deeper sheets switch to a different fill inside each opening, so you get patterns within patterns rather than one shape echoed down.'),
      select('Detail', () => S.detailMode, (v) => (S.detailMode = v as any), [['symmetric', 'Mixed, keeps symmetry'], ['same', 'One motif per level'], ['random', 'Mixed, every cell different'], ['off', 'Off — plain echoes']]),
      slider('First detail at layer', () => S.detailStart, (v) => (S.detailStart = v), 1, 20, 1, '', 'How many plain echo layers before details begin'),
      slider('New detail every', () => S.detailEvery, (v) => (S.detailEvery = v), 1, 10, 1, 'layers', 'Each new level nests another motif inside the last'),
      slider('Detail spacing', () => S.detailSpacing, (v) => (S.detailSpacing = v), 2, 20, 0.1, 'mm', 'Gap between motif lines; shrinks a little each level'),
      slider('Detail coverage', () => S.detailVariety, (v) => (S.detailVariety = v), 0, 1, 0.05, '', 'Share of openings that get a motif; the rest keep echoing'),
      motifChips(),
    ),
    section('Fabrication', false,
      slider('Rib width', () => S.rib, (v) => (S.rib = v), 0.4, 8, 0.05, 'mm', 'Width of the wooden lines on the top sheet'),
      slider('Minimum rib', () => S.minRib, (v) => (S.minRib = v), 0.3, 5, 0.05, 'mm', 'Thinner material is flagged in red'),
      slider('Minimum opening', () => S.minOpening, (v) => (S.minOpening = v), 0.2, 6, 0.05, 'mm', 'Slivers thinner than this are filled in'),
      slider('Kerf', () => S.kerf, (v) => (S.kerf = v), 0, 0.6, 0.01, 'mm', 'Beam width. Exported cuts are offset by half of this'),
      toggle('Alignment holes', () => S.regHoles, (v) => (S.regHoles = v)),
      slider('Hole diameter', () => S.regDia, (v) => (S.regDia = v), 1, 10, 0.1, 'mm'),
      toggle('Engrave layer numbers', () => S.numbers, (v) => (S.numbers = v)),
      slider('Bed width', () => S.bedW, (v) => (S.bedW = v), 100, 2000, 1, 'mm'),
      slider('Bed height', () => S.bedH, (v) => (S.bedH = v), 100, 2000, 1, 'mm'),
    ),
  ].filter((x): x is HTMLElement => !!x));
  buildGenParams();
  if (guidedOn) guided?.refresh();
}

// ---------------- layer colours ----------------
// One panel: the gradient, then every sheet as a tappable swatch, then the detail sheets
// listed with one-tap Gradient / Contrast / pick-a-colour choices.
const colourHost = h('div', { class: 'colours' });
let colourSig = '';
function colourChanged() { CUSTOM.version++; colourSig = ''; refreshColours(); render(); if (booted) { touched = true; autosave(); } }
/** Live colour edit: repaint without rebuilding the panel, so the picker stays open. */
function colourLive() { CUSTOM.version++; render(); }
const nm = (id: string) => MOTIFS.find((m) => m.id === id)?.name ?? id;
const toHex = (c: string) => { const x = document.createElement('canvas').getContext('2d')!; x.fillStyle = '#000'; x.fillStyle = c; return String(x.fillStyle); };
/** Sheet colours as #rrggbb, top to bottom, for the swatches and the export. */
function sheetColours(): string[] {
  if (!result) return [];
  const P = palette(colourKey()), n = result.layers.length;
  return result.layers.map((_, i) => toHex(P.colour(i, n, S.material)));
}
function picker(get: () => string, onPick: (v: string) => void, label: string, cls = '') {
  const i = h('input', { type: 'color', value: get(), 'aria-label': label, class: cls }) as HTMLInputElement;
  i.addEventListener('input', () => { onPick(i.value); colourLive(); });
  i.addEventListener('change', () => { onPick(i.value); colourLive(); });
  (i as any)._get = get;
  return i;
}
let swatchEls: { el: HTMLElement; inp: HTMLInputElement; i: number }[] = [];
let detailEls: { layer: number; inp: HTMLInputElement; btns: HTMLButtonElement[] }[] = [];
function openColours() {
  const sec = colourHost.closest('details') as HTMLDetailsElement | null;
  if (sec) { sec.open = true; panel.scrollTo({ top: sec.offsetTop - panel.offsetTop - 4, behavior: 'smooth' }); }
}
function updateSwatches() {
  if (gbar) gbar.style.background = `linear-gradient(90deg, ${CUSTOM.top}, ${CUSTOM.bottom})`;
  if (!result) return;
  const cols = sheetColours();
  const det = new Set((result.details ?? []).map((d) => d.layer));
  for (const sw of swatchEls) {
    const c = cols[sw.i] ?? '#000000';
    sw.el.style.background = c;
    sw.el.classList.toggle('det', det.has(sw.i + 1));
    sw.el.classList.toggle('own', !!CUSTOM.sheet[sw.i + 1]);
    if (document.activeElement !== sw.inp) sw.inp.value = c;
  }
  for (const d of detailEls) {
    const o = CUSTOM.sheet[d.layer];
    const mode = !o ? 'gradient' : o === 'contrast' ? 'contrast' : 'own';
    d.btns.forEach((b) => b.classList.toggle('on', b.dataset.m === mode));
    if (document.activeElement !== d.inp) d.inp.value = cols[d.layer - 1] ?? '#000000';
  }
}
function colourPanel() { colourSig = ''; refreshColours(); return colourHost; }
let gbar: HTMLElement | null = null;
function refreshColours() {
  const n = result?.layers.length ?? 0;
  const det = result?.details ?? [];
  // rebuild only when the layout changes, so a colour picker stays open while you drag it
  const sig = JSON.stringify([colourway, n, det]);
  if (sig === colourSig) { updateSwatches(); return; }
  colourSig = sig;
  colourHost.innerHTML = '';
  swatchEls = []; detailEls = [];
  const sel = h('select', {}, ...PALETTES.map((p) => h('option', { value: p.id }, p.name))) as HTMLSelectElement;
  sel.value = colourway;
  sel.addEventListener('change', () => { colourway = sel.value; colourChanged(); });
  colourHost.append(h('label', { class: 'row sel' }, h('span', { class: 'lab' }, 'Colourway'), sel));
  gbar = null;
  if (colourway !== 'custom') {
    colourHost.append(h('p', { class: 'note' }, 'To choose your own colours, including for detail sheets, pick “Your gradient”.'),
      h('button', { class: 'btn small', onclick: () => { colourway = 'custom'; colourChanged(); } }, 'Use my own colours'));
  } else {
    colourHost.append(
      h('div', { class: 'grad' },
        h('label', { class: 'gend' }, picker(() => CUSTOM.top, (v) => (CUSTOM.top = v), 'Top sheet colour'), h('span', {}, 'Top')),
        (gbar = h('span', { class: 'gbar' })),
        h('label', { class: 'gend' }, picker(() => CUSTOM.bottom, (v) => (CUSTOM.bottom = v), 'Bottom sheet colour'), h('span', {}, 'Bottom')),
        h('button', { class: 'btn small ghost', onclick: () => { [CUSTOM.top, CUSTOM.bottom] = [CUSTOM.bottom, CUSTOM.top]; colourChanged(); } }, 'Swap'),
      ),
    );
  }
  if (n) {
    const strip = h('div', { class: 'swatches', 'aria-label': 'Sheet colours, top to bottom' });
    for (let i = 0; i < n; i++) {
      const isBack = result!.layers[i].isBack;
      const inp = picker(() => sheetColours()[i], (v) => { CUSTOM.sheet[i + 1] = v; }, `${isBack ? 'Back panel' : `Sheet ${i + 1}`} colour`, 'swin');
      const el = h('label', { class: 'sw', title: isBack ? 'Back panel' : `Sheet ${i + 1}` }, inp, h('b', {}, isBack ? 'B' : String(i + 1)));
      if (colourway !== 'custom') inp.disabled = true;
      strip.append(el);
      swatchEls.push({ el, inp, i });
    }
    colourHost.append(h('div', { class: 'row col' },
      h('span', { class: 'lab' }, colourway === 'custom' ? 'Sheets, top to bottom — tap one to change it' : 'Sheets, top to bottom'), strip,
      h('div', { class: 'legend' }, h('i', { class: 'k det' }), 'detail sheet', h('i', { class: 'k own' }), 'your own colour')));
  }
  if (colourway === 'custom' && S.repeat !== 'trace') {
    colourHost.append(h('div', { class: 'subhead' }, 'Detail sheets'));
    if (!det.length) colourHost.append(h('p', { class: 'note' }, 'This stack has no detail sheets yet. Turn on Detail layers to get them, then colour them here.'));
    else {
      colourHost.append(h('div', { class: 'btnrow' },
        h('button', { class: 'btn small', onclick: () => { for (const d of det) CUSTOM.sheet[d.layer] = 'contrast'; colourChanged(); } }, 'Contrast all'),
        h('button', { class: 'btn small ghost', onclick: () => { for (const d of det) delete CUSTOM.sheet[d.layer]; colourChanged(); } }, 'All follow gradient'),
      ));
      for (const d of det) {
        const mk = (m: string, label: string, f: () => void) => { const b = h('button', { class: 'seg-b', 'data-m': m, onclick: () => { f(); colourLive(); } }, label) as HTMLButtonElement; return b; };
        const btns = [
          mk('gradient', 'Gradient', () => { delete CUSTOM.sheet[d.layer]; }),
          mk('contrast', 'Contrast', () => { CUSTOM.sheet[d.layer] = 'contrast'; }),
        ];
        const inp = picker(() => sheetColours()[d.layer - 1], (v) => { CUSTOM.sheet[d.layer] = v; }, `Colour for detail sheet ${d.layer}`);
        const own = h('label', { class: 'seg-b pick', 'data-m': 'own', title: 'Pick any colour' }, inp, h('span', {}, 'Pick')) as unknown as HTMLButtonElement;
        btns.push(own);
        colourHost.append(h('div', { class: 'drow' },
          h('div', { class: 'dlab' }, h('b', {}, `Sheet ${d.layer}`), h('span', {}, d.motifs.map(nm).join(', '))),
          h('div', { class: 'dseg' }, ...btns),
        ));
        detailEls.push({ layer: d.layer, inp, btns });
      }
    }
    if (Object.keys(CUSTOM.sheet).length) colourHost.append(h('button', { class: 'btn small ghost', onclick: () => { CUSTOM.sheet = {}; colourChanged(); } }, 'Reset every sheet to the gradient'));
  }
  colourHost.append(h('p', { class: 'note' }, 'For coloured card, painted or stained layers. The cut files are the same either way; the export includes a colours list.'));
  updateSwatches();
}

const MIRRORS: [string, string][] = [['off', 'Off'], ['lr', 'Left–right'], ['ud', 'Top–bottom'], ['quad', 'Four-way'], ['rot2', 'Rotate 180°']];
function freeControls(): Node[] {
  return [
    h('p', { class: 'note' }, 'Draw in the Draw tab. Outline cuts the window through the top sheet, Flow adds swirling bands that step down each layer, Scroll adds curling stems.'),
    select('Symmetry', () => S.freeMirror, (v) => (S.freeMirror = v as any), MIRRORS),
    slider('Flow echoes', () => S.flowEchoes, (v) => (S.flowEchoes = v), 0, 12, 1, 'each side', 'Parallel ribs either side of every flow stroke'),
    slider('Echo spacing', () => S.flowSpacing, (v) => (S.flowSpacing = v), 2, 20, 0.1, 'mm', 'Gap between the parallel flow ribs'),
    slider('Scroll size', () => S.scrollSize, (v) => (S.scrollSize = v), 4, 60, 0.5, 'mm', 'Size of each curl on a scroll stem'),
    slider('Scroll spacing', () => S.scrollGap, (v) => (S.scrollGap = v), 4, 120, 0.5, 'mm', 'Distance between curls along a stem'),
    h('div', { class: 'btnrow' },
      h('button', { class: 'btn small', onclick: () => showView('sketch') }, 'Open Draw tab'),
      h('button', { class: 'btn small ghost', onclick: () => { free = exampleFree(S.width - 2 * S.border, S.height - 2 * S.border); freeUndo.length = 0; schedule(0); render(); } }, 'Load example'),
      h('button', { class: 'btn small ghost', onclick: () => { free = emptyFree(); freeUndo.length = 0; schedule(0); render(); } }, 'Clear drawing'),
    ),
  ];
}
let softCache: { src: FreeArt; out: FreeArt } | null = null;
/** Strokes as the engine sees them (smoothed), so the Draw view matches the cut. */
function softArt(): FreeArt {
  if (softCache?.src !== free) softCache = { src: free, out: { outlines: free.outlines.map((l) => soften(l, true)), flows: free.flows.map((l) => soften(l)), scrolls: free.scrolls.map((l) => soften(l)) } };
  return softCache.out;
}
const freeEmpty = () => !free.outlines.length && !free.flows.length && !free.scrolls.length;
function setRepeat(v: 'centre' | 'free' | 'trace') {
  S.repeat = v;
  if (v === 'free' && freeEmpty()) free = exampleFree(S.width - 2 * S.border, S.height - 2 * S.border);
  if (v === 'trace') { S.back = true; if (traceRes) applyTraceColours(); }
  buildPanel();
  if (v === 'free') showView('sketch');
  else if (view === 'sketch') showView('stack');
}

// ---------------- trace an image ----------------
// Upload a flat-colour picture; every colour becomes one sheet at its own depth.
let traceSrc = '';               // the picture, as a data URL (kept in the project file)
let traceName = '';
let traceCrop: [number, number, number, number] | null = null; // artwork bounding box in the picture (px)
let traceRes: TraceOut | null = null;
let traceKey = '', traceRunKey = '';
let traceOrder: number[] | null = null;   // your own colour order (palette indices)
let tracePalette: string[] | null = null; // colours kept steady between re-traces
let traceMsg = 'No image yet.';
let traceImgEl: HTMLImageElement | null = null;
const traceStatus = h('p', { class: 'note tstatus', 'aria-live': 'polite' });
const traceList = h('div', { class: 'tlist' });
function setTraceMsg(m: string) { traceMsg = m; traceStatus.textContent = m; }

function traceArea() {
  const b = S.border;
  if (S.traceFollow) return [S.width - 2 * b, S.height - 2 * b];
  if (S.shape === 'circle') { const d = Math.min(S.width, S.height) - 2 * b; return [d, d]; }
  if (S.shape === 'hex') { const r = Math.min(S.width / 2, S.height / 2 / (Math.sqrt(3) / 2)); return [2 * r - 2 * b, Math.sqrt(3) * r - 2 * b]; }
  return [S.width - 2 * b, S.height - 2 * b];
}
function traceOpts(): TraceOpts {
  const [wm, hm] = traceArea();
  return { colours: S.traceColours, smooth: S.traceSmooth, minPiece: S.traceMinPiece, rib: S.minRib, slot: S.minOpening,
    widthMm: wm, heightMm: hm, shape: S.traceFollow ? 'rect' : S.shape, follow: !!S.traceFollow, rimMm: S.border, merge: pictureInfo?.shaded || pictureCheck?.photo ? 16 : 11, fair: S.traceSmooth * 2, darkFirst: S.traceDarkFirst, order: traceOrder ?? undefined, palette: tracePalette ?? undefined, lettering: letteringOpts() };
}
/** Font lettering: the AI check found text and a font is chosen. */
let letterLineCount = 0; // lines of lettering the last trace found
let letterWidths: number[] | undefined;
function letteringOpts(): TraceOpts['lettering'] {
  const c = pictureCheck;
  if (!S.traceFont || !c?.text) return undefined;
  const ink = c.inks.find((k) => /text|letter/i.test(k.role)) ?? c.inks[c.inks.length - 1];
  const n = letterLineCount || c.textLines?.length || 1;
  return { hex: ink.hex, font: S.traceFont, lines: splitLines(c.text, c.textLines, n, letterWidths) };
}
const traceKeyOf = (o: TraceOpts) => JSON.stringify([o, traceSrc.length, traceSrc.slice(-64), traceCrop], (k, v) => (k === 'shapes' ? undefined : v));

function loadImg(src: string): Promise<HTMLImageElement> {
  return new Promise((res, rej) => { const im = new Image(); im.crossOrigin = 'anonymous'; im.onload = () => res(im); im.onerror = () => rej(new Error('Could not read that image')); im.src = src; });
}
/** Box around the artwork: everything that differs from the colour in the corners. */
function autoCrop(im: HTMLImageElement): [number, number, number, number] {
  const sc = Math.min(1, 400 / Math.max(im.naturalWidth, im.naturalHeight));
  const w = Math.max(1, Math.round(im.naturalWidth * sc)), hh = Math.max(1, Math.round(im.naturalHeight * sc));
  const c = document.createElement('canvas'); c.width = w; c.height = hh;
  const x = c.getContext('2d')!; x.drawImage(im, 0, 0, w, hh);
  let d: Uint8ClampedArray;
  try { d = x.getImageData(0, 0, w, hh).data; } catch { return [0, 0, im.naturalWidth, im.naturalHeight]; }
  const at = (px: number, py: number) => { const i = (py * w + px) * 4; return [d[i], d[i + 1], d[i + 2], d[i + 3]]; };
  const corners = [at(1, 1), at(w - 2, 1), at(1, hh - 2), at(w - 2, hh - 2)];
  const bg = [0, 1, 2].map((k) => corners.map((q) => q[k]).sort((a, b) => a - b)[1]);
  let x0 = w, y0 = hh, x1 = -1, y1 = -1;
  for (let py = 0; py < hh; py++) for (let px = 0; px < w; px++) {
    const q = at(px, py);
    if (q[3] < 20) continue;
    if (Math.abs(q[0] - bg[0]) + Math.abs(q[1] - bg[1]) + Math.abs(q[2] - bg[2]) > 60) { if (px < x0) x0 = px; if (px > x1) x1 = px; if (py < y0) y0 = py; if (py > y1) y1 = py; }
  }
  if (x1 - x0 < w * 0.2 || y1 - y0 < hh * 0.2) return [0, 0, im.naturalWidth, im.naturalHeight];
  // keep a little background all round, so a follow outline can tell artwork from background
  const m = Math.round(Math.max(x1 - x0, y1 - y0) * 0.02) + 2;
  x0 = Math.max(0, x0 - m); y0 = Math.max(0, y0 - m); x1 = Math.min(w - 1, x1 + m); y1 = Math.min(hh - 1, y1 + m);
  return [x0 / sc, y0 / sc, (x1 - x0 + 1) / sc, (y1 - y0 + 1) / sc];
}
const MAX_IMAGE_BYTES = 30 * 1024 * 1024, MAX_IMAGE_PIXELS = 50e6, MAX_PROJECT_BYTES = 60 * 1024 * 1024;
async function onTraceFile(f: File, demo = false, keepCheck: PictureCheck | null = null) {
  try {
    if (f.size > MAX_IMAGE_BYTES) throw new Error('That picture is over 30 MB — save a smaller copy and try again');
    const url = await new Promise<string>((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = () => rej(new Error('Could not read that file')); r.readAsDataURL(f); });
    let im = await loadImg(url);
    if (im.naturalWidth * im.naturalHeight > MAX_IMAGE_PIXELS) throw new Error('That picture is too large (over 50 megapixels) — resize it and try again');
    // keep a manageable copy (it is saved inside the project file)
    const long = Math.max(im.naturalWidth, im.naturalHeight);
    let src = url;
    if (long > 1600) {
      const sc = 1600 / long, c = document.createElement('canvas');
      c.width = Math.round(im.naturalWidth * sc); c.height = Math.round(im.naturalHeight * sc);
      c.getContext('2d')!.drawImage(im, 0, 0, c.width, c.height);
      try { src = c.toDataURL('image/png'); im = await loadImg(src); } catch { /* keep the original */ }
    }
    // a new picture after the demo is a new project, not an edit of the Daruma
    const wasDemo = !demo && traceName === 'trippy-daruma.webp';
    if (wasDemo) startNew();
    traceSrc = src; traceName = f.name; traceImgEl = im; pictureCheck = null; checkOrderPending = false; letterLineCount = 0; letterWidths = undefined; S.traceFont = '';
    const carried = keepCheck ? { ...keepCheck, photo: false, kind: 'flat AI redraw' } : null;
    traceCrop = autoCrop(im);
    if (wasDemo || projectName === 'Untitled stack') {
      const base = f.name.replace(/\.[a-z0-9]+$/i, '').replace(/[-_]+/g, ' ').trim().slice(0, 40) || 'Untitled stack';
      projectName = base; $<HTMLInputElement>('#pname').value = base;
    }
    // settings that suit this picture, not the previous one
    const a = readPicture(im);
    if (a) {
      const shaded = pictureInfo!.shaded;
      if (!demo) {
        S.traceColours = shaded ? 9 : Math.max(2, Math.min(12, a.colours));
        S.traceFollow = a.plainBg;
        if (S.traceFollow && S.border > 6) S.border = 4; // a slim rim round a shaped piece, not a plate frame
        syncAll();
      }
    }
    if (S.traceFollow) fitToArtwork();
    traceOrder = null; tracePalette = null; traceRes = null; traceKey = '';
    if (carried) applyCheck(carried); // same artwork, now flat: keep the AI's colours and layer order
    if (S.repeat !== 'trace') setRepeat('trace'); else buildPanel();
    schedule(0);
    guided?.pictureChosen();
  } catch (e: any) { toast(e.message || 'Could not read that image'); }
}
/** The AI's stacking (top to back, as colours) mapped onto the traced colours. */
function stackOrder(out: TraceOut, stack: string[]): number[] | null {
  const live = out.order;
  const pairs: [number, number, number][] = [];
  stack.forEach((hx, si) => live.forEach((c) => pairs.push([hexDist(hx, out.palette[c]), si, c])));
  pairs.sort((a, b) => a[0] - b[0]);
  const bySlot = new Map<number, number>(), used = new Set<number>();
  for (const [d, si, c] of pairs) { if (d > 45 || bySlot.has(si) || used.has(c)) continue; bySlot.set(si, c); used.add(c); }
  if (bySlot.size < 2) return null;
  const ord = [...bySlot.entries()].sort((a, b) => a[0] - b[0]).map((e) => e[1]);
  // colours the AI did not name keep their place next to the colour traced just above them
  live.forEach((c, i) => {
    if (used.has(c)) return;
    let at = 0; for (let j = i - 1; j >= 0; j--) { const k = ord.indexOf(live[j]); if (k >= 0) { at = k + 1; break; } }
    ord.splice(at, 0, c); used.add(c);
  });
  return ord;
}
/** Use what the AI check found: how many colours, the background, the layer order. */
function applyCheck(c: PictureCheck) {
  pictureCheck = c;
  const bgReused = !!c.background && c.inks.some((k) => hexDist(k.hex, c.background!) < 12);
  S.traceColours = Math.max(2, Math.min(12, c.inks.length + (c.background && !bgReused ? 1 : 0)));
  S.traceFont = c.text ? pickFont(c.font) : ''; letterLineCount = 0; letterWidths = undefined;
  if (c.plainBackground) { S.traceFollow = true; if (S.border > 6) S.border = 4; fitToArtwork(); }
  traceOrder = null; tracePalette = null; checkOrderPending = true;
  syncAll(); schedule(0); autosave();
}
/** How many flat colours the picture has, and whether it has shading or a plain background. */
function readPicture(im: HTMLImageElement) {
  pictureInfo = null;
  try {
    const k = Math.min(1, 1000 / Math.max(im.naturalWidth, im.naturalHeight));
    const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(im.naturalWidth * k)); c.height = Math.max(1, Math.round(im.naturalHeight * k));
    const x = c.getContext('2d')!; x.drawImage(im, 0, 0, c.width, c.height);
    const a = analysePicture({ w: c.width, h: c.height, data: x.getImageData(0, 0, c.width, c.height).data });
    pictureInfo = { colours: Math.min(12, a.colours), shaded: a.colours > 12 || a.flat < 0.55, plainBg: a.plainBg, found: a.found.slice(0, a.colours) };
    return a;
  } catch { return null; } // the picture can't be read here: keep the current settings
}
/** Follow mode: keep the width, and set the height to the artwork's proportions. */
function fitToArtwork() {
  if (!traceCrop) return;
  const [, , cw, ch] = traceCrop;
  if (cw > 0 && ch > 0) S.height = Math.round(Math.min(1200, Math.max(60, (S.width - 2 * S.border) * (ch / cw) / 0.97 + 2 * S.border)));
  syncAll();
}
/** Pixels of the picture, fitted (cover) to the trace area at a working resolution. */
async function traceImage(o: TraceOpts) {
  const im = traceImgEl ?? (traceImgEl = await loadImg(traceSrc));
  if (im.naturalWidth * im.naturalHeight > MAX_IMAGE_PIXELS) throw new Error('too large');
  const long = Math.max(o.widthMm, o.heightMm);
  const px = Math.min(0.45, Math.max(0.16, long / 1300));
  const w = Math.max(32, Math.round(o.widthMm / px)), hh = Math.max(32, Math.round(o.heightMm / px));
  const c = document.createElement('canvas'); c.width = w; c.height = hh;
  const x = c.getContext('2d')!;
  const [cx, cy, cw, ch] = traceCrop ?? [0, 0, im.naturalWidth, im.naturalHeight];
  // a plate is covered edge to edge; a followed outline fits the whole artwork, with a little background round it
  const sc = o.follow ? Math.min(w / cw, hh / ch) * 0.97 : Math.max(w / cw, hh / ch);
  const dw = cw * sc, dh = ch * sc;
  {
    // the background colour: the median round the picture's edge (one corner pixel can be a stray)
    const t = document.createElement('canvas'); t.width = t.height = 64;
    const tx = t.getContext('2d')!; tx.drawImage(im, cx, cy, cw, ch, 0, 0, 64, 64);
    const td = tx.getImageData(0, 0, 64, 64).data, ch3: number[][] = [[], [], []];
    let clear = 0;
    for (let i = 0; i < 64; i++) for (const q of [i, 63 * 64 + i, i * 64, i * 64 + 63]) { if (td[q * 4 + 3] < 128) { clear++; continue; } for (let k = 0; k < 3; k++) ch3[k].push(td[q * 4 + k]); }
    let [r, g, b] = ch3.map((v) => v.sort((p, q) => p - q)[v.length >> 1] ?? 255);
    if (clear > 128) {
      // a cut-out on a transparent background: fill with white or black, whichever the artwork's edge is not
      let sum = 0, n = 0;
      for (let y = 0; y < 64; y++) for (const dir of [1, -1]) {
        for (let x = dir > 0 ? 0 : 63; x >= 0 && x < 64; x += dir) { const q = (y * 64 + x) * 4; if (td[q + 3] >= 128) { sum += td[q] + td[q + 1] + td[q + 2]; n++; break; } }
      }
      const v = n && sum / n / 3 > 128 ? 0 : 255; r = g = b = v;
    }
    x.fillStyle = `rgb(${r},${g},${b})`; x.fillRect(0, 0, w, hh);
  }
  x.imageSmoothingQuality = 'high';
  x.drawImage(im, cx, cy, cw, ch, (w - dw) / 2, (hh - dh) / 2, dw, dh);
  const d = x.getImageData(0, 0, w, hh); // throws if the browser blocks reading the picture
  return { w, h: hh, data: d.data };
}
let traceWorker: Worker | null | undefined;
let traceJob = 0, traceBusy = false, traceTimer = 0;
async function runTrace() {
  if (!traceSrc) return;
  const o = traceOpts(), key = traceKeyOf(o);
  traceRunKey = key;
  const job = ++traceJob;
  traceBusy = true;
  setTraceMsg('Tracing…');
  $('#busy').classList.add('on');
  let img: { w: number; h: number; data: Uint8ClampedArray };
  if (o.lettering) { try { o.lettering.shapes = await lineShapes(o.lettering.font, o.lettering.lines); } catch { o.lettering = undefined; } }
  if (job !== traceJob) return;
  try { img = await traceImage(o); } catch (e: any) { traceBusy = false; setTraceMsg('This browser would not let the app read the picture. Try another image file.'); return; }
  const t0 = performance.now();
  const done = (out: TraceOut) => {
    if (job !== traceJob) return;
    traceBusy = false;
    traceRes = out;
    tracePalette = out.palette;
    traceKey = traceKeyOf(traceOpts());
    // the picture has a different number of lettering lines than guessed: split again and re-trace
    if (out.letterLines && o.lettering && !out.lettered && out.letterLines !== letterLineCount) { letterLineCount = out.letterLines; letterWidths = out.letterWidths; }
    if (checkOrderPending && pictureCheck) {
      checkOrderPending = false;
      // a followed outline shows the top sheet as the rim, so the outermost ink stays on top as the frame
      const st = pictureCheck.stack.slice(), outer = pictureCheck.inks[0]?.hex;
      if (S.traceFollow && outer) { const i = st.indexOf(outer); if (i > 0) { st.splice(i, 1); st.unshift(outer); } }
      const ord = stackOrder(out, st);
      if (ord && ord.join() !== out.order.join()) traceOrder = ord; // the next schedule re-traces in this order
    }
    applyTraceColours();
    setTraceMsg(`Traced ${out.order.length} colours into ${out.order.length} sheets in ${((performance.now() - t0) / 1000).toFixed(1)} s.`);
    drawTraceList();
    schedule(0);
    guided?.traced();
  };
  const fail = (msg: string) => { if (job !== traceJob) return; traceBusy = false; setTraceMsg('Trace failed: ' + msg); $('#busy').classList.remove('on'); };
  const inline = () => setTimeout(() => { try { done(traceNow(img, o, (m) => setTraceMsg(m))); } catch (e: any) { fail(String(e?.message ?? e)); } }, 30);
  if (traceWorker === undefined || traceWorker) {
    // a newer trace replaces a running one
    if (traceWorker) traceWorker.terminate();
    try { const make = await workerFactory(); traceWorker = make ? make() : null; } catch { traceWorker = null; }
  }
  if (!traceWorker) { inline(); return; }
  const w = traceWorker;
  w.onmessage = (e) => {
    const m = e.data;
    if (m.traceJob !== job) return;
    if (m.progress) { setTraceMsg(m.progress); return; }
    if (m.error) { fail(m.error); return; }
    done(m.out);
  };
  w.onerror = () => { if (traceWorker === w) traceWorker = null; inline(); };
  w.postMessage({ traceJob: job, img, opts: o }, [img.data.buffer]);
}
/** Re-trace when anything the trace depends on has changed (called from schedule). */
function traceFresh(): boolean {
  if (S.repeat !== 'trace' || !traceSrc) return true;
  const key = traceKeyOf(traceOpts());
  if (key === traceKey) return true;
  if (key !== traceRunKey || !traceBusy) { clearTimeout(traceTimer); traceTimer = window.setTimeout(runTrace, 250); traceRunKey = key; }
  return false;
}
function applyTraceColours() {
  if (!traceRes) return;
  colourway = 'custom';
  CUSTOM.sheet = {};
  traceRes.order.forEach((c, d) => { CUSTOM.sheet[d + 1] = traceRes!.palette[c]; });
  colourChanged();
}
function moveTrace(d: number, by: number) {
  if (!traceRes) return;
  const o = traceRes.order.slice();
  const j = d + by;
  if (j < 0 || j >= o.length) return;
  [o[d], o[j]] = [o[j], o[d]];
  traceOrder = o; tracePalette = traceRes.palette;
  schedule(0);
}
function drawTraceList() {
  traceList.innerHTML = '';
  if (!traceRes) return;
  const { order, palette: pal, share, pieces } = traceRes;
  order.forEach((c, d) => {
    const last = d === order.length - 1;
    traceList.append(h('div', { class: 'trow' },
      h('i', { class: 'tsw', style: `background:${pal[c]}` }),
      h('span', { class: 'tname' }, h('b', {}, last ? 'Back' : `Sheet ${d + 1}`), ` ${share[c]}%`, !last && pieces[d] ? h('em', {}, ` · ${pieces[d]} glue-in`) : null),
      h('button', { class: 'btn tiny ghost', 'aria-label': `Move ${last ? 'back panel' : 'sheet ' + (d + 1)} colour up`, disabled: d === 0, onclick: () => moveTrace(d, -1) }, '↑'),
      h('button', { class: 'btn tiny ghost', 'aria-label': `Move ${last ? 'back panel' : 'sheet ' + (d + 1)} colour down`, disabled: last, onclick: () => moveTrace(d, 1) }, '↓'),
    ));
  });
}
function traceControls(): Node[] {
  const fileIn = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif', hidden: true }) as HTMLInputElement;
  fileIn.addEventListener('change', () => { const f = fileIn.files?.[0]; if (f) void onTraceFile(f); fileIn.value = ''; });
  const thumb = traceSrc
    ? h('img', { class: 'tthumb', src: traceSrc, alt: traceName ? `Traced image: ${traceName}` : 'Traced image' })
    : h('button', { class: 'tthumb empty', onclick: () => fileIn.click() }, 'Choose a picture');
  const copy = async () => {
    const txt = REDRAW_PROMPT(S.traceColours, pictureCheck);
    try { await navigator.clipboard.writeText(txt); toast('Prompt copied. Paste it into Gemini (Nano Banana Pro) with your picture.'); }
    catch { toast('Copy blocked here — select the prompt text below instead'); }
  };
  setTraceMsg(traceSrc ? traceMsg : 'No image yet.');
  drawTraceList();
  return [
    h('p', { class: 'note' }, 'Each flat colour in the picture becomes one sheet. The darkest colour is the top face; the deepest is the solid back.'),
    h('div', { class: 'tbox' }, thumb, h('div', { class: 'btncol' },
      h('button', { class: 'btn small', onclick: () => fileIn.click() }, traceSrc ? 'Change picture' : 'Upload picture'),
      h('button', { class: 'btn small ghost', onclick: copy }, 'Copy AI redraw prompt'),
    )),
    traceStatus,
    h('details', { class: 'tprompt' }, h('summary', {}, 'Photo or shaded art? Redraw it first'),
      h('p', { class: 'note' }, 'Shading and texture trace badly. Open Gemini, choose Nano Banana Pro (the image model), attach your picture and paste this prompt. Then upload the result here.'),
      h('textarea', { class: 'ptext', readonly: true, rows: 6 }, REDRAW_PROMPT(S.traceColours, pictureCheck))),
    slider('Colours (sheets)', () => S.traceColours, (v) => { S.traceColours = v; traceOrder = null; tracePalette = null; }, 3, 16, 1, '', 'How many flat colours to find; each one is a sheet'),
    slider('Smoothness', () => S.traceSmooth, (v) => (S.traceSmooth = v), 0, 2, 0.05, 'mm', 'Fairs every edge into smooth curves (corners stay sharp); higher loses fine detail'),
    slider('Smallest loose piece', () => S.traceMinPiece, (v) => (S.traceMinPiece = v), 2, 200, 1, 'mm²', 'Loose pieces smaller than this blend into the colour around them'),
    toggle('Outline follows the picture', () => !!S.traceFollow, (v) => { S.traceFollow = v; }),
    toggle('Darkest colour on top', () => S.traceDarkFirst, (v) => { S.traceDarkFirst = v; traceOrder = null; }),
    h('div', { class: 'row col' }, h('span', { class: 'lab' }, 'Layer order, top to bottom'), traceList,
      h('button', { class: 'btn small ghost', onclick: () => { traceOrder = null; schedule(0); } }, 'Auto order (fewest loose pieces)')),
    fileIn,
  ];
}

function motifChips() {
  const wrap = h('div', { class: 'chips' });
  const draw = () => {
    wrap.innerHTML = '';
    for (const m of MOTIFS) {
      const on = S.motifs.includes(m.id);
      wrap.append(h('button', { class: 'chip' + (on ? ' on' : ''), 'aria-pressed': on ? 'true' : 'false', onclick: () => {
        S.motifs = on ? S.motifs.filter((x) => x !== m.id) : [...S.motifs, m.id];
        if (!S.motifs.length) S.motifs = [m.id];
        draw(); schedule(120);
      } }, m.name));
    }
  };
  draw();
  ctls.push({ el: wrap, sync: draw });
  return h('div', { class: 'row col' }, h('span', { class: 'lab' }, 'Motifs'), wrap);
}

function syncAll() { ctls.forEach((c) => c.sync()); }

// ---------------- worker ----------------
import { Stale, computeAsync, pendingThinInput } from './engine';
import { Pool } from './pool';
import workerUrl from './worker.ts?worker&url';

// The preview pane runs in a sandboxed (opaque-origin) iframe where `new Worker(url)` is
// blocked. Try a direct worker, then a blob-URL worker, then fall back to the main thread.
let worker: Worker | null = null;
let pool: Pool | null = null;
let reqId = 0, pending = false, timer = 0;
let lastMsg = 0;
function onResult(data: { id: number; result?: EngineResult; error?: string; partial?: EngineResult; thin?: { thin: EngineResult['thin']; warning: string } }) {
  if (data.id !== reqId) return;
  if (data.thin) {
    if (result) { result = { ...result, thin: data.thin.thin, warnings: data.thin.warning ? [data.thin.warning, ...result.warnings] : result.warnings }; render(); }
    return;
  }
  lastMsg = performance.now();
  if (data.partial) {
    // show the sheets computed so far while the rest are still being worked out
    result = data.partial;
    layerIdx = Math.min(layerIdx, result.layers.length - 1);
    render();
    return;
  }
  pending = false;
  $('#busy').classList.remove('on');
  if (data.error) { toast('Geometry error: ' + data.error); return; }
  result = data.result!;
  layerIdx = Math.min(layerIdx, result.layers.length - 1);
  render();
  guided?.computed();
  autosave();
}
// Build workers the same way the single worker is built: direct URL, else a blob copy.
let blobUrl: string | null = null;
async function workerFactory(): Promise<(() => Worker) | null> {
  const direct = () => new Worker(new URL(workerUrl, import.meta.url));
  try { direct().terminate(); return direct; } catch { /* sandboxed */ }
  try {
    const code = await (await fetch(new URL(workerUrl, import.meta.url))).text();
    blobUrl = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
    const u = blobUrl;
    return () => new Worker(u);
  } catch { return null; }
}
/** Use every spare core: a pool of workers, coordinated from this thread. */
async function startPool() {
  // iOS reports at most 2 cores to web pages; iPhones have 6 (2 fast + 4 efficiency)
  const ios = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const hc = navigator.hardwareConcurrency || 4;
  const n = ios && hc <= 2 ? 4 : Math.min(6, Math.max(2, hc - 1));
  let make = await workerFactory();
  if (!make) return;
  pool = await Pool.create(make, n, forceJs);
  if (!pool && !blobUrl) {
    // a direct worker can construct but fail to load in sandboxed viewers; try the blob copy
    try {
      const code = await (await fetch(new URL(workerUrl, import.meta.url))).text();
      blobUrl = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
      const u = blobUrl;
      make = () => new Worker(u);
      pool = await Pool.create(make, n, forceJs);
    } catch { /* no pool */ }
  }
}
async function startWorker() {
  const attach = (w: Worker) => { w.onmessage = (e) => { if (e.data.error && worker) { console.warn('worker error, using main thread:', e.data.error); worker.terminate(); worker = null; runRequest(reqId, lastInput); return; } onResult(e.data); }; w.onerror = (ev) => { console.warn('worker failed, using main thread:', (ev as ErrorEvent).message); worker = null; if (pending) runRequest(reqId, lastInput); }; return w; };
  try { worker = attach(new Worker(new URL(workerUrl, import.meta.url))); return; } catch { /* sandboxed */ }
  try {
    const code = await (await fetch(new URL(workerUrl, import.meta.url))).text();
    worker = attach(new Worker(URL.createObjectURL(new Blob([code], { type: 'text/javascript' }))));
  } catch (err) { console.warn('no worker available:', err); worker = null; }
}
let lastInput: unknown = null;
function runRequest(id: number, input: unknown) {
  lastInput = input;
  if (pool) {
    const p = pool;
    const stale = () => reqId !== id;
    computeAsync(input as any, { runner: p.runner(stale), onProgress: (partial) => onResult({ id, partial }), deferThin: true, stale })
      .then((res) => {
        onResult({ id, result: res });
        const t = pendingThinInput();
        if (t) p.thin(t.top, t.minRib, stale).then((r) => { t.store(r.thin); onResult({ id, thin: r }); }).catch(() => {});
      })
      .catch((err) => {
        if (err instanceof Stale) return;
        console.warn('worker pool failed, using a single worker:', err);
        p.terminate();
        if (pool === p) pool = null;
        if (reqId === id) runRequest(id, input);
      });
    return;
  }
  if (worker) {
    worker.postMessage({ id, input, forceJs });
    // watchdog: if the worker never answers, compute on the main thread instead
    lastMsg = performance.now();
    const watch = () => {
      if (!(pending && reqId === id && worker)) return;
      if (performance.now() - lastMsg > 45000) { worker.terminate(); worker = null; runRequest(id, input); }
      else setTimeout(watch, 5000);
    };
    setTimeout(watch, 5000);
    return;
  }
  setTimeout(async () => {
    try { await initGeom(); onResult({ id, result: await computeAsync(input as any) }); }
    catch (err: any) { onResult({ id, error: String(err?.message ?? err) }); }
  }, 16);
}
function schedule(delay = 140) {
  if (booted) touched = true;
  clearTimeout(timer);
  timer = window.setTimeout(() => {
    reqId++;
    pending = true;
    $('#busy').classList.add('on');
    if (!traceFresh()) { pending = false; return; } // the trace finishes first, then schedules again
    const tr = S.repeat === 'trace' && traceRes ? { sig: traceKey, openings: traceRes.openings, outline: traceRes.outline } : null;
    runRequest(reqId, { s: JSON.parse(JSON.stringify(S)), sketch, imported, free, trace: tr });
  }, delay);
}

// ---------------- rendering ----------------
function sizeCanvas() {
  const vp = $('#viewport');
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  cv.width = Math.max(10, vp.clientWidth * dpr);
  cv.height = Math.max(10, vp.clientHeight * dpr);
  cv.style.width = vp.clientWidth + 'px';
  cv.style.height = vp.clientHeight + 'px';
}

const css = (v: string) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

let drawMs = 0;
function render() {
  const t = performance.now();
  renderInner();
  drawMs = performance.now() - t;
  const dm = document.getElementById('drawms');
  if (dm) dm.textContent = `draw ${drawMs.toFixed(0)} ms`;
  try { updateZoomBtn(); } catch { /* gesture layer not set up yet */ }
}
function renderInner() {
  sizeCanvas();
  CUSTOM.detailLayers = result?.details?.map((d) => d.layer) ?? [];
  refreshColours();
  const three = $('#three');
  const useGL = view === '3d' && !simple3d;
  three.hidden = !useGL;
  cv.hidden = useGL;
  if (useGL) {
    if (!Stack3DClass) {
      if (!loading3d) {
        loading3d = true;
        import('./render3d').then((m) => { Stack3DClass = m.Stack3D; render(); })
          .catch(() => { simple3d = true; toast('Full 3D could not load here, so Simple 3D is shown'); render(); })
          .finally(() => { loading3d = false; });
      }
      return;
    }
    try {
      if (!stack3d) {
        stack3d = new Stack3DClass(three);
        stack3d.onLost = () => { simple3d = true; stack3d?.stop(); toast('Full 3D was interrupted on this device, so Simple 3D is shown'); render(); };
      }
      stack3d.resize();
      if (result) stack3d.build(result, S, colourKey());
      stack3d.setExplode(tiltView.explode);
      stack3d.start();
    } catch {
      simple3d = true;
      stack3d = null;
      three.innerHTML = '';
      toast('This viewer cannot run full 3D, so Simple 3D is shown');
      render();
      return;
    }
  } else stack3d?.stop();
  if (view === '3d' && simple3d && result) drawTilted(cv, result, S, colourKey(), tiltView);
  if (result) {
    if (view === 'stack') drawStack(cv, result, S, colourKey(), { light: S.lightAngle, showThin: true, isPaper: S.material === 'paper' });
    if (view === 'layers') drawLayer(cv, result, S, layerIdx, { cut: css('--cut'), fill: css('--sheet'), ghost: css('--ghost'), island: css('--island'), bg: css('--bg') });
  }
  if (view === 'sketch' && S.repeat === 'free') drawFree(cv, result, S, softArt(), liveStroke ? [liveStroke] : [], tool, { fill: css('--sheet'), ...FREE_COL, guide: css('--ghost') });
  else if (view === 'sketch') drawSketch(cv, result, S, sketch, liveStroke ? symCopies(liveStroke) : [], sym, mirror, { fill: css('--sheet'), stroke: css('--accent'), live: css('--accent-2'), guide: css('--ghost') });
  renderToolbar();
  renderStatus();
}

function renderStatus() {
  const st = $('#stats'), w = $('#warn');
  if (!result) { st.textContent = 'Generating…'; w.innerHTML = ''; return; }
  const n = result.layers.length;
  const cut = result.layers.reduce((a, l) => a + l.cutLength, 0) / 1000;
  const plan = planSheets(result, S);
  st.innerHTML = [
    `<b>${n}</b> sheets`,
    `<b>${(n * S.thickness).toFixed(1)}</b> mm deep`,
    S.repeat === 'trace' ? `<b>${result.layers.length}</b> colours` : `<b>${result.openingsTop}</b> openings on top`,
    `<b>${cut.toFixed(1)}</b> m of cutting`,
    plan.fits ? `<b>${plan.sheets.length}</b> bed sheet${plan.sheets.length > 1 ? 's' : ''}` : `<span class="bad">Larger than bed</span>`,
    `<span class="dim">compute ${result.ms.toFixed(0)} ms · <span id="drawms">draw ${drawMs.toFixed(0)} ms</span> · ${result.backend === 'js' ? 'JS engine' : result.backend === 'asmJsOnly' ? 'asm.js engine' : 'fast engine'}${pool ? ` · ${pool.size} cores` : worker ? '' : ' (main thread)'}</span>`,
  ].map((x) => `<span>${x}</span>`).join('');
  const nm = (id: string) => MOTIFS.find((m) => m.id === id)?.name ?? id;
  if (result.details?.length) st.innerHTML += `<div class="details">Details: ${result.details.map((d) => `layer ${d.layer} — ${d.motifs.map(nm).join(', ')}`).join(' · ')}</div>`;
  if (result.backend === 'js') st.innerHTML += `<div class="details">This device blocks the fast geometry engine (iPhone Lockdown Mode does this), so edits are slower. Excluding this app or site from Lockdown Mode makes it many times faster.</div>`;
  if (!result.details?.length && S.detailMode !== 'off' && S.repeat !== 'trace') st.innerHTML += `<div class="details">No detail layers in this stack — try a lower “First detail at layer” or wider spacing.</div>`;
  w.innerHTML = result.warnings.map((x) => `<div>${x}</div>`).join('');
}

function renderToolbar() {
  toolbar.innerHTML = '';
  if (view === 'stack') {
    toolbar.append(h('button', { class: 'btn small', onclick: openColours }, 'Colours'), h('span', { class: 'hint' }, 'Top-down render of the finished stack. Red marks material thinner than the minimum rib. Pinch or scroll to zoom, double-tap to reset.'));
  } else if (view === '3d') {
    const r = h('input', { type: 'range', min: 0, max: 1, step: 0.01, value: tiltView.explode }) as HTMLInputElement;
    r.addEventListener('input', () => { tiltView.explode = +r.value; if (simple3d) render(); else stack3d?.setExplode(+r.value); });
    toolbar.append(
      h('label', { class: 'inline' }, 'Explode', r),
      h('button', { class: 'btn small ghost', onclick: () => { simple3d = !simple3d; render(); } }, simple3d ? 'Try full 3D' : 'Simple 3D'),
      h('span', { class: 'hint' }, simple3d ? 'Drag to turn and tilt, pinch to zoom.' : 'Drag to orbit, pinch or scroll to zoom.'),
    );
  } else if (view === 'layers' && result) {
    const n = result.layers.length;
    const L = result.layers[layerIdx];
    const r = h('input', { type: 'range', min: 0, max: n - 1, step: 1, value: layerIdx, class: 'grow' }) as HTMLInputElement;
    r.addEventListener('input', () => { layerIdx = +r.value; render(); });
    toolbar.append(
      h('button', { class: 'btn small ghost', onclick: () => { layerIdx = Math.max(0, layerIdx - 1); render(); }, 'aria-label': 'Previous layer' }, '‹'),
      r,
      h('button', { class: 'btn small ghost', onclick: () => { layerIdx = Math.min(n - 1, layerIdx + 1); render(); }, 'aria-label': 'Next layer' }, '›'),
      h('span', { class: 'lnum' }, L.isBack ? 'Back panel' : `Sheet ${layerIdx + 1} of ${n - (S.back ? 1 : 0)}`),
      h('span', { class: 'hint' }, `${(L.cutLength / 1000).toFixed(2)} m cut${L.islands ? ` · ${L.islands} loose piece${L.islands > 1 ? 's' : ''} (amber)` : ''}`),
      h('button', { class: 'btn small', onclick: async () => { await initGeom(forceJs); download(new Blob([layerSVG(result!, S, layerIdx)], { type: 'image/svg+xml' }), `${slug()}-${String(layerIdx + 1).padStart(2, '0')}.svg`); } }, 'Download this sheet'),
    );
  } else if (view === 'sketch' && S.repeat === 'free') {
    const tb = (t: Tool, label: string) => h('button', { class: 'btn small tool' + (tool === t ? ' on' : ''), style: `--tc:${FREE_COL[t]}`, 'aria-pressed': tool === t ? 'true' : 'false', onclick: () => { tool = t; render(); } }, label);
    const ms = h('select', { class: 'mini', 'aria-label': 'Symmetry' }, ...MIRRORS.map(([v, t]) => h('option', { value: v }, t))) as HTMLSelectElement;
    ms.value = S.freeMirror;
    ms.addEventListener('change', () => { S.freeMirror = ms.value as any; syncAll(); schedule(0); render(); });
    const n = free.outlines.length + free.flows.length + free.scrolls.length;
    toolbar.append(
      h('div', { class: 'seg' }, tb('outline', 'Outline'), tb('flow', 'Flow'), tb('scroll', 'Scroll')),
      h('label', { class: 'inline' }, 'Symmetry', ms),
      h('button', { class: 'btn small ghost', onclick: () => { const t = freeUndo.pop(); if (t) { const k = TOOL_KEY[t]; free = { ...free, [k]: free[k].slice(0, -1) }; schedule(0); render(); } } }, 'Undo'),
      h('button', { class: 'btn small ghost', onclick: () => { free = emptyFree(); freeUndo.length = 0; schedule(0); render(); } }, 'Clear'),
      h('span', { class: 'hint' }, tool === 'outline' ? 'Draw a closed shape: it becomes the window cut through the top sheet.' : tool === 'flow' ? 'Draw a curve: it becomes a band of parallel ribs that steps down each layer.' : 'Draw a stem: curls sprout along it and at its tip.'),
      h('span', { class: 'hint dim' }, `${n} stroke${n === 1 ? '' : 's'}${penSeen ? ' · pen draws, fingers pan and zoom' : ''}`),
    );
  } else if (view === 'sketch') {
    const sr = h('input', { type: 'range', min: 1, max: 24, step: 1, value: sym }) as HTMLInputElement;
    const sv = h('b', {}, String(sym));
    sr.addEventListener('input', () => { sym = +sr.value; sv.textContent = String(sym); render(); });
    const mb = h('input', { type: 'checkbox' }) as HTMLInputElement;
    mb.checked = mirror;
    mb.addEventListener('change', () => { mirror = mb.checked; });
    toolbar.append(
      h('label', { class: 'inline' }, 'Symmetry', sr, sv),
      h('label', { class: 'inline' }, mb, 'Mirror'),
      h('button', { class: 'btn small ghost', onclick: () => { const k = sketchUndo.pop(); if (k) { sketch = sketch.slice(0, sketch.length - k); schedule(0); } } }, 'Undo'),
      h('button', { class: 'btn small ghost', onclick: () => { sketch = []; sketchUndo.length = 0; schedule(0); } }, 'Clear sketch'),
      h('span', { class: 'hint' }, sketch.length ? `${sketchUndo.length} stroke${sketchUndo.length === 1 ? '' : 's'}` : 'Draw lines — each one becomes a rib, repeated around the centre.'),
    );
  }
}

// ---------------- sketch input ----------------
let liveStroke: Pt[] | null = null;
function symCopies(l: Pt[]): Pt[][] {
  const out: Pt[][] = [];
  for (let k = 0; k < sym; k++) {
    const a = (k / sym) * Math.PI * 2, c = Math.cos(a), s = Math.sin(a);
    out.push(l.map(([x, y]) => [x * c - y * s, x * s + y * c]));
    if (mirror) out.push(l.map(([x, y]) => [x * c + y * s, x * s - y * c] as Pt).map(([x, y]) => [x, y]));
  }
  return out;
}
// ---------------- gestures: sketch, simple-3D orbit, pinch zoom & pan ----------------
const ptrs = new Map<number, { x: number; y: number }>();
let pinch: { d0: number; mx: number; my: number; z0: number; px0: number; py0: number } | null = null;
let drag: { x: number; y: number } | null = null;
let lastTap = 0;
let raf = 0;
const redraw = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; render(); updateZoomBtn(); }); };
const local = (e: { clientX: number; clientY: number }) => {
  const r = cv.getBoundingClientRect();
  return { x: e.clientX - r.left - r.width / 2, y: e.clientY - r.top - r.height / 2 };
};
function zoomAt(mx: number, my: number, z: number) {
  z = Math.min(10, Math.max(0.5, z));
  // keep the point under the fingers / cursor fixed
  VIEW.px = mx - ((mx - VIEW.px) * z) / VIEW.z;
  VIEW.py = my - ((my - VIEW.py) * z) / VIEW.z;
  VIEW.z = z;
}
function resetZoom() { VIEW.z = 1; VIEW.px = 0; VIEW.py = 0; redraw(); }
const zoomBtn = h('button', { class: 'zoomreset', hidden: true, onclick: resetZoom, title: 'Reset zoom' }, 'Reset zoom');
$('#viewport').append(zoomBtn);
function updateZoomBtn() { zoomBtn.hidden = !(VIEW.z !== 1 || VIEW.px || VIEW.py) || (view === '3d' && !simple3d); }

cv.addEventListener('pointerdown', (e) => {
  cv.setPointerCapture(e.pointerId);
  ptrs.set(e.pointerId, local(e));
  if (ptrs.size === 2) {
    // second finger: switch to pinch, abandon any stroke or orbit in progress
    liveStroke = null; drag = null;
    const [a, b] = [...ptrs.values()];
    pinch = { d0: Math.hypot(a.x - b.x, a.y - b.y) || 1, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2, z0: VIEW.z, px0: VIEW.px, py0: VIEW.py };
    redraw();
    return;
  }
  if (ptrs.size > 2) return;
  const now = performance.now();
  if (view !== 'sketch' && now - lastTap < 300) { resetZoom(); lastTap = 0; return; }
  lastTap = now;
  if (e.pointerType === 'pen') penSeen = true;
  const drawing = view === 'sketch' && !(penSeen && e.pointerType === 'touch');
  if (drawing) liveStroke = [screenToMm(cv, S, e.clientX, e.clientY)];
  else drag = { x: e.clientX, y: e.clientY };
});
cv.addEventListener('pointermove', (e) => {
  if (!ptrs.has(e.pointerId)) return;
  ptrs.set(e.pointerId, local(e));
  if (pinch && ptrs.size >= 2) {
    const [a, b] = [...ptrs.values()];
    const d = Math.hypot(a.x - b.x, a.y - b.y), mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    VIEW.z = pinch.z0; VIEW.px = pinch.px0 + (mx - pinch.mx); VIEW.py = pinch.py0 + (my - pinch.my);
    zoomAt(mx, my, pinch.z0 * (d / pinch.d0));
    redraw();
    return;
  }
  if (view === 'sketch' && liveStroke) {
    const p = screenToMm(cv, S, e.clientX, e.clientY);
    const q = liveStroke[liveStroke.length - 1];
    if (Math.hypot(p[0] - q[0], p[1] - q[1]) > 0.4) { liveStroke.push(p); redraw(); }
    return;
  }
  if (!drag) return;
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
  drag = { x: e.clientX, y: e.clientY };
  if (view === '3d' && simple3d) {
    tiltView.rot += dx * 0.01;
    tiltView.tilt = Math.min(1.35, Math.max(0, tiltView.tilt - dy * 0.006));
  } else if (VIEW.z > 1 || view === 'sketch') { VIEW.px += dx; VIEW.py += dy; } // pan when zoomed in, or with a finger while using a pen
  else return;
  redraw();
});
const endPtr = (e: PointerEvent) => {
  ptrs.delete(e.pointerId);
  if (ptrs.size < 2) pinch = null;
  if (ptrs.size) return;
  drag = null;
  if (liveStroke) {
    if (liveStroke.length > 1 && S.repeat === 'free') {
      const k = TOOL_KEY[tool];
      free = { ...free, [k]: [...free[k], simplify(liveStroke, 0.25)] };
      freeUndo.push(tool);
      schedule(0);
    } else if (liveStroke.length > 1) {
      const copies = symCopies(simplify(liveStroke, 0.25));
      sketch = [...sketch, ...copies];
      sketchUndo.push(copies.length);
      schedule(0);
    }
    liveStroke = null;
    render();
  }
};
cv.addEventListener('pointerup', endPtr);
cv.addEventListener('pointercancel', endPtr);
cv.addEventListener('wheel', (e) => {
  if (view === '3d' && !simple3d) return;
  e.preventDefault();
  const m = local(e);
  zoomAt(m.x, m.y, VIEW.z * (e.deltaY > 0 ? 0.9 : 1.1));
  redraw();
}, { passive: false });

// ---------------- tabs & actions ----------------
function showView(v: typeof view) {
  view = v;
  document.querySelectorAll<HTMLButtonElement>('.tabs [data-v]').forEach((x) => x.classList.toggle('on', x.dataset.v === v));
  cv.classList.toggle('draw', view === 'sketch');
  render();
}
document.querySelectorAll<HTMLButtonElement>('.tabs [data-v]').forEach((b) => b.addEventListener('click', () => showView(b.dataset.v as any)));

function applyProject(d: any) {
    Object.assign(S, { detailMode: 'off', repeat: 'centre', corners: false, traceColours: 12, traceSmooth: 0.6, traceMinPiece: 25, traceDarkFirst: true, traceFollow: false, traceFont: '' }, d.settings); // older projects had no detail layers or Free mode
    free = d.free ?? emptyFree(); freeUndo.length = 0;
    colourway = d.colourway ?? 'natural';
    if (d.colours) { CUSTOM.top = d.colours.top ?? CUSTOM.top; CUSTOM.bottom = d.colours.bottom ?? CUSTOM.bottom; CUSTOM.sheet = { ...(d.colours.sheet ?? d.colours.detail ?? {}) }; }
    colourChanged();
    sketch = d.sketch ?? []; sketchUndo.length = 0; if (sketch.length) sketchUndo.push(sketch.length);
    imported = d.imported ?? []; importName = d.importName ?? '';
    traceSrc = d.trace?.src ?? ''; traceName = d.trace?.name ?? ''; traceCrop = d.trace?.crop ?? null;
    traceOrder = d.trace?.order ?? null; tracePalette = d.trace?.palette ?? null; traceRes = null; traceKey = ''; traceImgEl = null; pictureInfo = null; pictureCheck = d.trace?.check ?? null; checkOrderPending = false;
    if (traceSrc && (typeof traceSrc !== 'string' || traceSrc.length > MAX_IMAGE_BYTES * 1.4 || !/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(traceSrc))) traceSrc = '';
    if (traceCrop && !(Array.isArray(traceCrop) && traceCrop.length === 4 && traceCrop.every((v) => typeof v === 'number' && isFinite(v)))) traceCrop = null;
    projectName = d.name ?? 'Untitled stack';
    $<HTMLInputElement>('#pname').value = projectName;
    buildPanel(); schedule(0);
    if (traceSrc) { const src = traceSrc; void loadImg(src).then((im) => { if (traceSrc === src) { readPicture(im); guided?.refresh(); } }).catch(() => undefined); }
}
const slug = () => projectName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'stack';
const projectData = () => ({ app: 'layercraft-stack', version: 2, name: projectName, settings: S, colourway, colours: { top: CUSTOM.top, bottom: CUSTOM.bottom, sheet: CUSTOM.sheet }, sketch, imported, importName, free, trace: traceSrc ? { src: traceSrc, name: traceName, crop: traceCrop, order: traceOrder, palette: tracePalette, check: pictureCheck } : null });

$('#pname').addEventListener('input', (e) => { projectName = (e.target as HTMLInputElement).value || 'Untitled stack'; touched = true; autosave(); });
$('#save').addEventListener('click', () => download(new Blob([JSON.stringify(projectData())], { type: 'application/json' }), `${slug()}.layercraft.json`));
$('#open').addEventListener('click', () => $('#openfile').click());
$<HTMLInputElement>('#openfile').addEventListener('change', async (e) => {
  const inp = e.target as HTMLInputElement;
  const f = inp.files?.[0];
  if (!f) return;
  if (f.size > MAX_PROJECT_BYTES) { toast('That project file is too large to open'); inp.value = ''; return; }
  try {
    const d = JSON.parse(await f.text());
    applyProject(d);
    projectId = newId(); touched = true; store.set('lc.current', projectId);
    toast(`Opened ${projectName}`);
  } catch { toast('That file is not a Layercraft project'); }
  inp.value = '';
});

$('#export').addEventListener('click', async () => {
  if (!result || pending) { toast('Still computing — try again in a moment'); return; }
  await initGeom(forceJs);
  const prev = view;
  if (view !== 'stack') { view = 'stack'; render(); }
  const png = cv.toDataURL('image/png');
  if (prev !== 'stack') { view = prev; render(); }
  toast('Packing SVGs…');
  const blob = await exportZip(result, S, projectData(), png, projectName, colourway === 'natural' ? undefined : sheetColours());
  download(blob, `${slug()}-laser-svgs.zip`);
  toast(`Exported ${result.layers.length} sheets`);
});

// ---------------- autosave (this browser only) ----------------
let saveTimer = 0;
function thumbOf(): string {
  try {
    const t = document.createElement('canvas'), k = 220 / Math.max(cv.width, cv.height);
    t.width = Math.max(1, Math.round(cv.width * k)); t.height = Math.max(1, Math.round(cv.height * k));
    const x = t.getContext('2d')!; x.fillStyle = '#11100e'; x.fillRect(0, 0, t.width, t.height); x.drawImage(cv, 0, 0, t.width, t.height);
    return t.toDataURL('image/jpeg', 0.75);
  } catch { return ''; }
}
function autosave() {
  if (!touched || !booted) return;
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(async () => {
    if (!projectId) { projectId = newId(); store.set('lc.current', projectId); }
    const ok = await saveProject({ id: projectId, name: projectName, updated: Date.now(), thumb: view === 'stack' ? thumbOf() : ((await getProject(projectId))?.thumb ?? thumbOf()), data: projectData() });
    if (!ok) console.warn('autosave failed');
  }, 1200);
}
async function openSaved(id: string) {
  const p = await getProject(id);
  if (!p) { toast('That project is no longer saved here'); return false; }
  applyProject(p.data); projectId = id; store.set('lc.current', id); touched = false;
  return true;
}
function startNew() { projectId = newId(); store.set('lc.current', projectId); touched = true; }

async function exportAllLayers() {
  if (!result || pending) { toast('Still computing — try again in a moment'); return; }
  await initGeom(forceJs);
  const svg = allLayersSVG(result, S, projectName, colourway === 'natural' ? undefined : sheetColours());
  download(new Blob([svg], { type: 'image/svg+xml' }), `${slug()}-all-layers.svg`);
  toast(`Saved one SVG with ${result.layers.length} layers`);
}

$('#surprise').addEventListener('click', () => {
  if (S.repeat === 'trace') { toast('Surprise me works on the Centre and Free patterns — switch Repeat to try it'); return; }
  const r = rng((Math.random() * 1e9) | 0);
  const pick = <T,>(a: T[]) => a[Math.floor(r() * a.length)];
  if (S.repeat === 'free') {
    // keep your drawing; shake up how it is echoed and mirrored
    if (freeEmpty()) free = exampleFree(S.width - 2 * S.border, S.height - 2 * S.border);
    S.freeMirror = pick(['lr', 'lr', 'quad', 'ud', 'rot2', 'off'] as const);
    S.flowEchoes = 2 + Math.floor(r() * 7);
    S.flowSpacing = +((S.material === 'paper' ? 2.4 : 3.2) + r() * 3).toFixed(1);
    S.scrollSize = +(8 + r() * 18).toFixed(1);
    S.scrollGap = +(S.scrollSize * (1.2 + r())).toFixed(1);
  } else {
    S.gen = pick(GENERATORS).id;
    S.params = randomParams(S.gen, r);
  }
  S.seed = (r() * 1e6) | 0;
  S.driftMode = pick(['in', 'in', 'out', 'light', 'none'] as const);
  S.drift = +(0.3 + r() * 0.9).toFixed(2);
  S.twist = r() < 0.45 ? +((r() - 0.5) * 6).toFixed(1) : 0;
  S.stepCurve = r() < 0.4 ? +(r() * 0.25).toFixed(2) : 0;
  S.spokes = r() < 0.3 ? pick([6, 8, 12, 16, 24]) : 0;
  S.spokeTwist = S.spokes ? +((r() - 0.5) * 3).toFixed(2) : 0;
  S.detailMode = pick(['symmetric', 'symmetric', 'symmetric', 'same', 'random'] as const);
  S.detailStart = 2 + Math.floor(r() * 3);
  S.detailEvery = 2 + Math.floor(r() * 3);
  S.detailVariety = +(0.55 + r() * 0.45).toFixed(2);
  S.detailSpacing = +((S.material === 'paper' ? 2.4 : 4) + r() * 3).toFixed(1);
  { const all = MOTIFS.map((m) => m.id).sort(() => r() - 0.5); S.motifs = all.slice(0, 3 + Math.floor(r() * 4)); }
  if (r() < 0.6) {
    // a fresh gradient: two hues far apart on the colour wheel
    const h0 = r() * 360, h1 = h0 + 120 + r() * 120;
    const hsl = (hh: number, l: number) => { const c = document.createElement('canvas').getContext('2d')!; c.fillStyle = `hsl(${hh % 360}, 85%, ${l}%)`; return String(c.fillStyle); };
    colourway = 'custom'; CUSTOM.top = hsl(h0, 68); CUSTOM.bottom = hsl(h1, 24);
  } else colourway = pick(PALETTES.filter((p) => p.id !== 'custom')).id;
  colourChanged();
  buildPanel();
  syncAll();
  schedule(0);
  toast(S.repeat === 'free' ? `Free · ${MIRRORS.find((m) => m[0] === S.freeMirror)?.[1]} · ${S.flowEchoes} echoes` : `${genById(S.gen).name} · seed ${S.seed}`);
});

let rz = 0;
new ResizeObserver(() => { cancelAnimationFrame(rz); rz = requestAnimationFrame(() => render()); }).observe($('#viewport'));

// ---------------- guided mode (the default) ----------------
const gFile = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif', hidden: true }) as HTMLInputElement;
gFile.addEventListener('change', () => { const f = gFile.files?.[0]; if (f) void onTraceFile(f); gFile.value = ''; });
document.body.append(gFile);
async function loadDemo() {
  try {
    const r = await fetch('./demo/daruma.webp');
    if (!r.ok) throw new Error('demo missing');
    const f = new File([await r.blob()], 'trippy-daruma.webp', { type: 'image/webp' });
    Object.assign(S, MATERIALS.birch.s, { material: 'birch', shape: 'rect', width: 300, height: 400, border: 4,
      traceColours: 7, traceSmooth: 0.6, traceMinPiece: 25, traceDarkFirst: true, traceFollow: true, back: true });
    startNew();
    projectName = 'Trippy Daruma'; $<HTMLInputElement>('#pname').value = projectName;
    syncAll();
    await onTraceFile(f, true);
  } catch { toast('Could not load the demo picture'); }
}
const aiUi = createAiUi(h, toast);
$('#mode').before(aiUi.badge);
guided = createGuided({
  S, h, toast, ai: aiUi,
  usePicture: async (url: string, name: string, sameArt = false) => {
    const b = await (await fetch(url)).blob();
    await onTraceFile(new File([b], name, { type: b.type || 'image/png' }), false, sameArt ? pictureCheck : null);
  },
  setName: (n: string) => { projectName = n; $<HTMLInputElement>('#pname').value = n; },
  hasPicture: () => !!traceSrc && S.repeat === 'trace',
  picture: () => ({ src: traceSrc, name: traceName }),
  pictureInfo: () => pictureInfo,
  pictureCheck: () => pictureCheck,
  applyCheck,
  pickPicture: () => gFile.click(),
  loadDemo,
  traced: () => (traceRes && result ? { sheets: result.layers.length, pieces: result.layers.reduce((a, l) => a + l.islands, 0) } : null),
  traceStatus, traceList, drawTraceList,
  autoOrder: () => { traceOrder = null; schedule(0); },
  colourPanel,
  redrawPrompt: () => REDRAW_PROMPT(S.traceColours, pictureCheck),
  setMaterial: (v) => { S.material = v; Object.assign(S, MATERIALS[v].s); },
  fitToArtwork,
  showView,
  changed: (resetOrder) => { if (resetOrder) { traceOrder = null; tracePalette = null; } syncAll(); schedule(); },
  exportNow: () => $('#export').click(),
  exportAllLayers: () => void exportAllLayers(),
  projects: { list: listProjects, open: openSaved, remove: async (id: string) => { await deleteProject(id); if (id === projectId) { projectId = ''; store.set('lc.current', ''); } }, current: () => projectId, startNew },
  setAdvanced: (on) => setMode(!on),
});
$('#gbarhost').append(guided.bar);
$('.body').prepend(guided.host);
function setMode(g: boolean) {
  guidedOn = g;
  store.set('lc.mode', g ? 'guided' : 'advanced');
  document.body.classList.toggle('guided', g);
  const b = $('#mode'); b.textContent = g ? 'Advanced' : 'Guided'; b.setAttribute('aria-pressed', g ? 'false' : 'true');
  b.title = g ? 'Every setting, for fine-tuning' : 'Step by step, only the essentials';
  buildPanel();
  if (g) guided?.enter();
  render();
}
$('#mode').addEventListener('click', () => setMode(!guidedOn));
{
  const last = store.get('lc.current');
  if (last && (await getProject(last))) await openSaved(last);
}
setMode(store.get('lc.mode') !== 'advanced');
render();
const forceJs = new URLSearchParams(location.search).has('js');
// the coordinator needs geometry on this thread too (hashing, outlines)
await initGeom(forceJs);
if (!new URLSearchParams(location.search).has('single')) await startPool();
if (!pool) await startWorker();
schedule(0);
setTimeout(() => { booted = true; }, 0);
// main-thread geometry is only needed for export (kerf offsets); load it in the background
void initGeom(forceJs);
