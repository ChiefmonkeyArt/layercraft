// Guided mode: the default first-run experience. One step per screen, only the
// controls that step needs. Everything else lives in Advanced (the full app).
import type { Settings } from './engine';
import type { AiUi } from './aiui';
import { IDEA_PROMPT, fmtSats, fmtUsd, type PictureCheck } from './ai';
import { nearestAspect } from './aiui';
import { FONTS } from './lettering';
import { RAMPS, blendPalette, colourName, fixPrompt, rampPalette } from './cutready';
import type { CutReport } from './cutready';
import { createStudio } from './studio';

/** localStorage that never throws (sandboxed frames and private modes can block it). */
export const store = {
  get(k: string): string | null { try { return window.localStorage.getItem(k); } catch { return null; } },
  set(k: string, v: string) { try { window.localStorage.setItem(k, v); } catch { /* not available here */ } },
};

type View = 'stack' | '3d' | 'layers' | 'sketch';
export interface GuidedApi {
  S: Settings;
  h: (tag: string, attrs?: Record<string, any>, ...kids: (Node | string | null | undefined)[]) => HTMLElement;
  toast: (m: string) => void;
  hasPicture: () => boolean;
  picture: () => { src: string; name: string };
  pictureInfo: () => { colours: number; shaded: boolean; plainBg: boolean; found: { hex: string; share: number }[] } | null;
  pictureCheck: () => PictureCheck | null;
  applyCheck: (c: PictureCheck) => void;
  pickPicture: () => void;
  loadDemo: () => Promise<void>;
  traced: () => { sheets: number; pieces: number; colours: number } | null;
  traceStatus: HTMLElement;
  traceList: HTMLElement;
  drawTraceList: () => void;
  autoOrder: () => void;
  colourPanel: () => HTMLElement;
  redrawPrompt: () => string;
  layerMapPrompt: () => string;
  layerMap: () => { src: string; kind: 'flat' | 'photo' } | null;
  useLayerMap: (url: string, kind: 'flat' | 'photo') => Promise<void>;
  readDepth: (onMsg: (m: string) => void) => Promise<boolean>;
  fixMode: () => boolean;
  setFixMode: (on: boolean) => void;
  fixCount: () => number;
  clearFixes: () => void;
  learnCount: () => number;
  forgetLearning: () => void;
  builtInLessons: () => number;
  saveLessons: () => void;
  setMaterial: (id: string) => void;
  fitToArtwork: () => void;
  showView: (v: View) => void;
  changed: (resetOrder?: boolean) => void; // settings changed: re-trace / recompute
  relayer: () => void; // the sheet count or depth style changed: recolour the sheets and recompute
  exportNow: () => void;
  exportAllLayers: () => void;
  projects: {
    list: () => Promise<{ id: string; name: string; updated: number; thumb: string }[]>;
    open: (id: string) => Promise<boolean>;
    remove: (id: string) => Promise<void>;
    current: () => string;
    startNew: () => void;
  };
  setAdvanced: (on: boolean) => void;
  ai: AiUi;
  usePicture: (url: string, name: string, sameArt?: boolean | PictureCheck) => Promise<void>;
  parseColours: (text: string) => string[];
  forgetPalette: () => void;
  cutReady: (url: string, plan: string[] | null, levels: number) => Promise<{ url: string; cols: string[]; plan: string[]; report: CutReport; check: PictureCheck } | null>;
  setName: (n: string) => void;
  art: () => unknown;
  setArt: (a: unknown) => void;
  useComposite: (colour: string, map: string, n: number, palette: string[], name: string) => Promise<void>;
}

interface Step { id: string; label: string; view: View; needsPicture: boolean; hidden?: boolean; body: () => Node[] }

const LS_STEP = 'lc.guided.step';

export function createGuided(api: GuidedApi) {
  const { S, h } = api;
  const host = h('aside', { class: 'gpanel', id: 'gpanel', 'aria-label': 'Guided steps' });
  const bar = h('nav', { class: 'gsteps', 'aria-label': 'Progress' });
  let step = 0; // set from the saved step id once the steps exist

  const chips = <T,>(label: string, opts: [T, string, string?][], get: () => T, set: (v: T) => void) => {
    const wrap = h('div', { class: 'gchips', role: 'radiogroup', 'aria-label': label });
    const draw = () => {
      wrap.innerHTML = '';
      for (const [v, name, sub] of opts) {
        const on = get() === v;
        wrap.append(h('button', { class: 'gchip' + (on ? ' on' : ''), role: 'radio', 'aria-checked': on ? 'true' : 'false',
          onclick: () => { set(v); draw(); } }, h('b', {}, name), sub ? h('small', {}, sub) : null));
      }
    };
    draw();
    return h('div', { class: 'gfield' }, h('div', { class: 'glab' }, label), wrap);
  };
  const soon = (title: string, text: string) =>
    h('div', { class: 'gsoon' }, h('b', {}, title), h('span', { class: 'gbadge' }, 'Coming soon'), h('p', {}, text));
  const lead = (t: string) => h('p', { class: 'glead' }, t);
  let ideaOpen = false, ideaText = store.get('lc.ai.idea') ?? '', busyMsg = '';
  const busyEl = h('div', { class: 'gbusy', role: 'status', 'aria-live': 'polite', hidden: true });
  const busy = (m: string) => {
    busyMsg = m; busyEl.hidden = !m;
    busyEl.innerHTML = ''; if (m) busyEl.append(h('span', { class: 'spin' }), h('b', {}, m), h('small', {}, 'Usually 20 to 60 seconds. Keep this tab open.'));
    host.querySelectorAll<HTMLButtonElement>('.aibtn').forEach((b) => { b.disabled = !!m; });
  };
  /** A paid AI action: shows the price, asks for credit when there is none. */
  function aiButton(label: string, run: () => Promise<void>, cost: () => Promise<number | null> = api.ai.maxCost, cls = 'primary') {
    const price = h('small', {}, '');
    const b = h('button', { class: `btn ${cls} gbig aibtn`, disabled: busyMsg ? true : undefined, onclick: () => { if (!busyMsg) void run(); } }, h('b', {}, label), price) as HTMLButtonElement;
    void cost().then((m) => { if (m) { const u = fmtUsd(m, api.ai.usd()); price.textContent = `up to ${fmtSats(m)}${u ? ` · ${u}` : ''}`; } });
    return b;
  }
  /** Redraw the picture in flat, cut-ready colours (Nano Banana Pro unless changed), then use the redraw. */
  async function flatten() {
    const p = api.picture();
    const im = await new Promise<HTMLImageElement>((res) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => res(i); i.src = p.src; });
    const url = await api.ai.create(api.redrawPrompt(), p.src, nearestAspect(im.naturalWidth || 3, im.naturalHeight || 4), () => busy(`Redrawing in flat colours with ${api.ai.flat.label()}…`), api.ai.flat.model());
    if (url) { await api.usePicture(url, `${(p.name || 'picture').replace(/\.[a-z]+$/i, '')}-flat.png`, true); api.toast('Flat redraw ready. Compare it with the trace, or press Next.'); }
    busy('');
    draw();
  }
  /** AI layer map: Nano Banana Pro paints one grey per physical sheet. */
  async function makeLayerMap() {
    const p = api.picture();
    const im = await new Promise<HTMLImageElement>((res) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => res(i); i.src = p.src; });
    const url = await api.ai.create(api.layerMapPrompt(), p.src, nearestAspect(im.naturalWidth || 3, im.naturalHeight || 4), () => busy(`Mapping the layers with ${api.ai.flat.label()}…`), api.ai.flat.model());
    if (url) { await api.useLayerMap(url, 'flat'); api.toast('Layer map ready. The sheets now follow it.'); }
    busy(''); draw();
  }
  async function depthFromPhoto() {
    busy('Loading the depth model…');
    const ok = await api.readDepth((m) => busy(m));
    busy('');
    if (ok) api.toast('Depth read on this device. The sheets now follow it.');
    draw();
  }
  function layerHelp() {
    const m = api.layerMap();
    return h('details', { class: 'gmore' }, h('summary', {}, m ? 'Layer map in use' : 'Better layers for photos and complex art'),
      m ? h('div', { class: 'tbox' }, h('img', { class: 'tthumb', src: m.src, alt: 'Layer map: lighter is higher' }),
        h('p', { class: 'note' }, m.kind === 'photo' ? 'Depth read from the photo on this device. Lighter is higher.' : 'AI layer map: one grey per sheet, lighter is higher.')) : null,
      h('p', { class: 'note' }, 'An AI layer map paints each physical sheet one grey, from how the pieces sit, not their colours.'),
      aiButton('Make an AI layer map', makeLayerMap, api.ai.flat.cost, ''),
      h('p', { class: 'note' }, 'For a photo of a real layered piece, read its depth here on your device instead. Free; the 27 MB model downloads from this site once and your picture is never uploaded.'),
      h('button', { class: 'btn aibtn', disabled: busyMsg ? true : undefined, onclick: () => { if (!busyMsg) void depthFromPhoto(); } }, 'Read depth from the photo'));
  }
  const isRedraw = () => /-flat\.png$/i.test(api.picture().name || '');
  /** Photos and shaded art: the recommended first step is the AI flat redraw. */
  function flattenFirstCard() {
    const c = api.pictureCheck();
    return h('div', { class: 'gok warn gflatfirst' },
      h('b', {}, 'Recommended first step: flatten it'),
      h('p', {}, `This looks like a photo or shaded art, which traces with ragged edges. ${api.ai.flat.label()} redraws it as clean flat colours with smooth, even curves, then it traces cleanly.`),
      aiButton(`Flatten with ${api.ai.flat.label()}`, flatten, api.ai.flat.cost),
      h('p', { class: 'note' }, c ? `Uses the AI check below: ${c.inks.length} inks${c.text ? ' and the exact lettering' : ''}.` : 'For the most faithful redraw, run Check with AI below first (a few sats); it tells the redraw the exact inks and lettering.'));
  }
  /** The AI picture check: a vision model reads the shapes and inks, ignoring light and shade. */
  function checkCard() {
    const c = api.pictureCheck();
    const run = async () => {
      const r = await api.ai.check(api.picture().src, () => busy('Reading the shapes and colours…'));
      busy('');
      if (r) { api.applyCheck(r); api.toast(`AI check: ${r.inks.length} inks. Settings applied.`); draw(); }
    };
    if (!c) return h('div', { class: 'gfield gcheck' },
      h('div', { class: 'glab' }, 'Check with AI'),
      h('p', { class: 'note' }, 'An AI looks at the overall shapes, ignores light, shade and texture, and sets the colours, background and layer order for you.'),
      aiButton('Check picture with AI', run, api.ai.visionCost, 'gcheckbtn'));
    const sw = h('div', { class: 'gswatches gnamed', 'aria-label': 'Inks the AI found' });
    for (const k of c.inks) sw.append(h('span', { class: 'gink' }, h('i', { style: `background:${k.hex}` }), h('small', {}, k.name || k.hex)));
    return h('div', { class: 'gok gcheck' },
      h('b', {}, `AI check: ${c.inks.length} inks${c.kind ? ` · ${c.kind}` : ''}`),
      sw,
      c.shapes ? h('p', {}, c.shapes) : null,
      c.text ? h('p', {}, `Lettering: “${c.text}”${c.font ? ` in a ${c.font} style` : ''}.`) : null,
      h('p', {}, `Applied: colour count, background and layer order (top to back)${c.text ? ', and the lettering redrawn in a real font' : ''}. Change any of them on the Trace and Layers steps.`),
      h('div', { class: 'gbtns' }, h('button', { class: 'btn small', onclick: () => { api.applyCheck(c); api.toast('AI settings applied again'); } }, 'Apply again'),
        aiButton('Check again', run, api.ai.visionCost, 'small ghost')));
  }
  /** A number you type or step, with no upper limit. */
  function stepper(label: string, get: () => number, set: (v: number) => void, note: () => string, min = 2) {
    const inp = h('input', { type: 'number', min: String(min), step: '1', inputmode: 'numeric', class: 'gnum', 'aria-label': label, value: String(get()) }) as HTMLInputElement;
    const hint = h('small', { class: 'note' }, note());
    const put = (v: number) => { const n = Math.max(min, Math.round(v) || min); inp.value = String(n); set(n); hint.textContent = note(); };
    inp.addEventListener('change', () => put(Number(inp.value)));
    return h('div', { class: 'gfield' }, h('div', { class: 'glab' }, label),
      h('div', { class: 'gstepper' },
        h('button', { class: 'btn small', 'aria-label': `Fewer ${label.toLowerCase()}`, onclick: () => put(get() - 1) }, '−'), inp,
        h('button', { class: 'btn small', 'aria-label': `More ${label.toLowerCase()}`, onclick: () => put(get() + 1) }, '+')),
      hint);
  }
  const depthNote = (n: number) => `${n} sheets, about ${Math.round(n * S.thickness * 10) / 10} mm deep in ${S.thickness} mm ${S.material === 'paper' ? 'card' : 'ply'}.`;
  /** How extra sheets are made when there are more sheets than traced colours. */
  const depthChips = (onChange: () => void) => h('div', {},
    chips<'extend' | 'repeat'>('Extra sheets', [['extend', 'Extend', 'each shape steps in'], ['repeat', 'Repeat', 'thicker shapes']],
      () => S.traceDepth ?? 'extend', (v) => { S.traceDepth = v; onChange(); }),
    chips('Step', [[0.8, '0.8 mm'], [1.5, '1.5 mm'], [3, '3 mm'], [5, '5 mm']], () => S.traceStepMm ?? 1.5, (v) => { S.traceStepMm = v; onChange(); }));
  let ideaLayers = Math.max(2, Number(store.get('lc.ai.layers')) || 8);
  let ideaColours = store.get('lc.ai.colours') ?? '';
  let ideaMine = !!ideaColours;
  let ideaLevels = Number(store.get('lc.ai.levels')) || 0; // 0 = auto
  let ideaRamp = store.get('lc.ai.ramp') || 'sunset';
  /** the last AI design made cut-ready: its plan, the original drawing and what the check found */
  let cut: { src: string; original: string; plan: string[]; report: CutReport; w: number; h: number; name: string; aspect: string } | null = null;
  /** the exact colours the AI is asked for, back sheet first (null: the user's words were not colours) */
  const planFor = (levels: number): string[] | null => {
    if (!ideaMine) return rampPalette(levels, ideaRamp);
    const own = api.parseColours(ideaColours);
    return own.length ? blendPalette(own, levels) : null;
  };
  const autoLevels = () => Math.min(ideaLayers, 8);
  /** clean an AI design to its planned colours, check it can be cut, fix what can be fixed here */
  async function useDesign(url: string, plan: string[] | null, levels: number, name: string, aspect: string) {
    // colours the AI chose itself are left to the tracer: cleaning only helps when the app planned them
    if (!plan) { await api.usePicture(url, name); cut = null; return; }
    busy('Checking it can be cut…');
    const r = await api.cutReady(url, plan, levels);
    if (!r) { await api.usePicture(url, name); cut = null; return; }
    S.traceDepthBy = 'colour';
    await api.usePicture(r.url, name, r.check);
    const im = await new Promise<HTMLImageElement>((res) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => res(i); i.src = r.url; });
    cut = { src: api.picture().src, original: url, plan: r.plan, report: r.report, w: im.naturalWidth, h: im.naturalHeight, name, aspect };
  }
  /** what the cut check found, in plain words; big problems offer an AI redraw with a precise note */
  function cutCard() {
    if (!cut || api.picture().src !== cut.src) return null;
    const c = cut, r = c.report, n = c.plan.length - r.missing.length;
    const done: string[] = [`Cleaned to exactly ${n} flat colour${n === 1 ? '' : 's'}, one per sheet`];
    if (r.specks) done.push(r.specks > 200 ? 'removed stray specks' : `removed ${r.specks} speck${r.specks === 1 ? '' : 's'}`);
    if (r.thickened) done.push(`strengthened ${r.thickened} thin part${r.thickened === 1 ? '' : 's'} so ${r.thickened === 1 ? 'it survives' : 'they survive'} cutting`);
    const left: string[] = [];
    for (const k of r.missing) left.push(`Sheet ${k + 1} (${colourName(c.plan[k])}) is missing from the drawing.`);
    for (const [a, b] of r.merged) left.push(`Sheets ${a + 1} and ${b + 1} came out the same colour.`);
    if (r.unknown >= 0.03) left.push(`${Math.round(r.unknown * 100)}% of the design uses colours that were not asked for; they joined the nearest sheet.`);
    const redo = async () => {
      const url = await api.ai.create(fixPrompt(c.plan, r), c.original, c.aspect, () => busy('Asking the AI to fix it…'));
      if (url) { await useDesign(url, c.plan, c.plan.length, c.name, c.aspect); api.changed(true); api.toast(cut?.report.ready ? 'Fixed. Ready to cut.' : 'Redrawn. See what is left to fix.'); }
      busy(''); draw();
    };
    return h('div', { class: 'gok' + (r.ready ? '' : ' warn') },
      h('b', {}, r.ready ? 'Ready to cut' : 'Nearly ready to cut'),
      h('p', {}, done.join(', ') + '.'),
      ...left.map((t) => h('p', {}, t)),
      r.thickened ? h('p', {}, 'Rings on the picture show where parts were strengthened.') : null,
      r.ready ? null : aiButton('Ask the AI to fix it', redo, undefined, ''),
      r.ready ? null : h('p', { class: 'note' }, 'Or press Next: the app cuts what is there.'));
  }
  /** the cleaned picture, with rings where thin parts were strengthened */
  function cutFigure(src: string, alt: string) {
    const box = h('div', { class: 'gcutbox' }, h('img', { src, alt }));
    const fig = h('figure', { class: 'gpic' }, box);
    if (cut && cut.src === src && cut.report.spots.length) {
      const ns = 'http://www.w3.org/2000/svg', svg = document.createElementNS(ns, 'svg');
      svg.setAttribute('viewBox', `0 0 ${cut.w} ${cut.h}`); svg.setAttribute('preserveAspectRatio', 'xMidYMid meet'); svg.setAttribute('aria-hidden', 'true');
      for (const p of cut.report.spots.slice(0, 40)) {
        const e = document.createElementNS(ns, 'circle');
        e.setAttribute('cx', String(p.x)); e.setAttribute('cy', String(p.y)); e.setAttribute('r', String(Math.max(cut.w / 28, p.r)));
        svg.append(e);
      }
      box.append(svg);
    }
    return fig;
  }
  const ago = (t: number) => {
    const m = Math.round((Date.now() - t) / 60000);
    if (m < 1) return 'just now'; if (m < 60) return `${m} min ago`;
    const hr = Math.round(m / 60); if (hr < 24) return `${hr} h ago`;
    const d = Math.round(hr / 24); return d < 14 ? `${d} day${d > 1 ? 's' : ''} ago` : new Date(t).toLocaleDateString();
  };
  /** Projects saved in this browser, newest first. */
  function projectList() {
    const wrap = h('div', { class: 'gfield gprojects', hidden: true });
    void api.projects.list().then((ps) => {
      if (!ps.length) return;
      wrap.hidden = false;
      const list = h('div', { class: 'gplist' });
      for (const p of ps.slice(0, 12)) {
        const del = h('button', { class: 'gpdel', 'aria-label': `Delete ${p.name}`, title: 'Delete from this browser',
          onclick: async (e: Event) => { e.stopPropagation(); if (!confirm(`Delete “${p.name}” from this browser?`)) return; await api.projects.remove(p.id); draw(); } }, '×');
        list.append(h('div', { class: 'gproj' + (p.id === api.projects.current() ? ' on' : ''), role: 'button', tabindex: '0',
          onclick: async () => { if (await api.projects.open(p.id)) { studio.reload(); go(api.hasPicture() ? (studio.shot('hero') ? 'arrange' : 'trace') : 'hero'); } },
          onkeydown: async (e: KeyboardEvent) => { if (e.key === 'Enter' && (await api.projects.open(p.id))) { studio.reload(); go(api.hasPicture() ? (studio.shot('hero') ? 'arrange' : 'trace') : 'hero'); } } },
          p.thumb ? h('img', { src: p.thumb, alt: '' }) : h('i', {}),
          h('span', {}, h('b', {}, p.name), h('small', {}, ago(p.updated))), del));
      }
      wrap.append(h('div', { class: 'glab' }, 'Continue a project'), list, h('p', { class: 'note' }, 'Saved automatically in this browser. Nothing leaves your device.'));
    });
    return wrap;
  }

  const studio = createStudio({ api, h, busy, aiButton, chips, stepper, draw: () => draw(), go: (id) => go(id) });
  const STEPS: Step[] = [
    { id: 'hero', label: 'Hero', view: 'stack', needsPicture: false, body: () => {
      const has = !!studio.shot('hero');
      return [
        h('h2', {}, has ? 'Your Hero' : 'What would you like to create?'),
        lead(has ? 'The main design: the message, the characters or the mandala structure. Keep chatting until it is right, then add a Pop.'
          : 'Describe what you see in layers: a silhouette scene, a character, a pattern. The AI draws it flat and ready to cut, and you refine it together.'),
        studio.chat('hero'),
        has ? h('div', { class: 'gbtns' }, h('button', { class: 'btn primary', onclick: () => { studio.popRamp(); go('pop'); } }, 'Next: add a Pop'),
          h('button', { class: 'btn ghost', onclick: () => { studio.skipPop(); go('arrange'); } }, 'No Pop, just the Hero')) : null,
        has ? null : projectList(),
      ].filter((x): x is HTMLElement => !!x);
    } },
    { id: 'pop', label: 'Pop', view: 'stack', needsPicture: true, body: () => [
      h('h2', {}, studio.shot('pop') ? 'Your Pop' : 'Add a Pop'),
      lead('The complementary design: scenery behind, an accent pattern, a second mandala ring. It is drawn to line up with your Hero, with its own layers.'),
      studio.chat('pop'),
      h('div', { class: 'gbtns' },
        studio.shot('pop') ? h('button', { class: 'btn primary', onclick: () => go('arrange') }, 'Next: arrange the layers') : null,
        h('button', { class: 'btn ghost', onclick: () => { studio.skipPop(); go('arrange'); } }, studio.shot('pop') ? 'Leave the Pop out' : 'Skip the Pop')),
    ] },
    { id: 'arrange', label: 'Arrange', view: 'stack', needsPicture: true, body: () => [
      h('h2', {}, 'Arrange the layers'),
      lead('See the Hero and Pop overlaid. Interlace the Pop through the Hero, stack it on top, or merge layers together.'),
      ...studio.arrange(),
      api.traceStatus,
      h('details', { class: 'gmore' }, h('summary', {}, 'More settings'),
        h('div', { class: 'gbtns' },
          h('button', { class: 'btn small', onclick: () => go('trace') }, 'Edges and outline'),
          h('button', { class: 'btn small', onclick: () => go('layers') }, 'Material and 3D'),
          h('button', { class: 'btn small', onclick: () => go('details') }, 'Fine detail'),
          h('button', { class: 'btn small', onclick: () => api.setAdvanced(true) }, 'Advanced'))),
    ] },
    { id: 'picture', label: 'Picture', view: 'stack', needsPicture: true, hidden: true, body: () => {
      const p = api.picture();
      return [
        h('h2', {}, 'Your picture'),
        lead('This is what the layers are made from. The preview shows the first trace.'),
        (() => { const f = cutFigure(p.src, p.name || 'Your picture'); f.append(h('figcaption', {}, p.name || 'Picture')); return f; })(),
        ...[cutCard()].filter((x): x is HTMLElement => !!x),
        h('div', { class: 'gbtns' }, h('button', { class: 'btn', onclick: () => api.pickPicture() }, 'Choose a different picture')),
        ...(() => {
          const info = api.pictureInfo();
          if (!info || (cut && cut.src === p.src)) return [];
          if (info.shaded) return isRedraw() ? [] : [flattenFirstCard()];
          const sw = h('div', { class: 'gswatches', 'aria-label': 'Colours found' });
          for (const f of info.found) sw.append(h('i', { style: `background:${f.hex}`, title: f.hex }));
          return [h('div', { class: 'gfield' }, h('div', { class: 'glab' }, `Found ${info.colours} flat colours`), sw,
            h('p', { class: 'note' }, info.plainBg ? 'The plain background is left out and the outline follows your artwork. Each other colour becomes a sheet.' : 'Each colour becomes a sheet.'))];
        })(),
        ...(cut && cut.src === p.src ? [] : [checkCard()]),
      ];
    } },
    { id: 'flat', label: 'Flatten', view: 'stack', needsPicture: true, hidden: true, body: () => {
      const copy = async () => {
        try { await navigator.clipboard.writeText(api.redrawPrompt()); api.toast('Prompt copied. Paste it into Gemini (Nano Banana Pro) with your picture.'); }
        catch { api.toast('Copy blocked here. Select the prompt text instead.'); }
      };
      return [
        h('h2', {}, 'Make it flat'),
        lead('Laser layers need flat colour areas. Shading, texture and photos trace badly.'),
        h('div', { class: 'gok' }, h('b', {}, 'Already flat colours?'), h('p', {}, 'Like the Daruma demo. Just press Next.')),
        h('div', { class: 'gfield' },
          aiButton(`Flatten with ${api.ai.flat.label()}`, flatten, api.ai.flat.cost),
          (() => {
            const c = api.pictureCheck();
            if (!c) return h('p', { class: 'note' }, `Redraws your picture in ${S.traceColours} flat, cut-ready colours with ${api.ai.flat.label()}. Pay per use with Bitcoin. Tip: run Check with AI on the Picture step first for a much more faithful redraw.`);
            const sw = h('div', { class: 'gswatches gnamed' });
            for (const k of c.inks) sw.append(h('span', { class: 'gink' }, h('i', { style: `background:${k.hex}` }), h('small', {}, k.name || k.hex)));
            return h('div', {}, h('p', { class: 'note' }, `Uses the AI check: exactly these ${c.inks.length} inks${c.text ? ', the same lettering' : ''}, smooth even curves, no light or shade. With ${api.ai.flat.label()}, pay per use with Bitcoin.`), sw);
          })()),
        h('details', { class: 'gmore' }, h('summary', {}, 'Redraw model'),
          chips<string>('Model', api.ai.flat.choices().map((m) => [m.id, m.label, m.id === 'gemini-3-pro-image' ? 'recommended' : m.note] as [string, string, string]), () => api.ai.flat.model(), (v) => { api.ai.flat.set(v); draw(); }),
          h('p', { class: 'note' }, 'Nano Banana Pro gave the cleanest bands and lettering in our tests. Newer models appear here when an AI node offers them.')),
        h('details', { class: 'gmore' }, h('summary', {}, 'Do it yourself now'),
          h('p', { class: 'note' }, 'Open Gemini, choose Nano Banana Pro, attach your picture and paste this prompt. Then choose the result as your picture.'),
          h('button', { class: 'btn small', onclick: copy }, 'Copy redraw prompt'),
          h('button', { class: 'btn small ghost', onclick: () => api.pickPicture() }, 'Choose the flat picture')),
      ];
    } },
    { id: 'trace', label: 'Trace', view: 'stack', needsPicture: true, hidden: true, body: () => [
      h('h2', {}, 'Trace and outline'),
      lead('Layers come from how the shapes sit on each other, not just their colours. One sheet can carry several colours.'),
      chips<string>('Layers from', [['shapes', 'How pieces sit', 'shape on shape'], ['colour', 'Colours', 'one sheet each'],
        ...(api.layerMap() ? [['map', 'Layer map', api.layerMap()!.kind === 'photo' ? 'photo depth' : 'AI greys'] as [string, string, string]] : [])],
        () => (S.traceDepthBy === 'colour' ? 'colour' : S.traceDepthBy === 'map' && api.layerMap() ? 'map' : 'shapes'),
        (v) => { S.traceDepthBy = v as Settings['traceDepthBy']; api.changed(true); draw(); }),
      layerHelp(),
      ...(S.traceDepthBy !== 'colour' ? [chips<string>('Highest', [['centre', 'Middle', 'a mound'], ['edge', 'Outside', 'a tunnel']], () => S.traceRaise ?? 'centre', (v) => { S.traceRaise = v as Settings['traceRaise']; api.changed(); })] : []),
      (() => {
        const info = api.pictureInfo();
        const opts: [number, string, string?][] = [];
        if (info && !info.shaded) opts.push([info.colours, `${info.colours}`, 'as found']);
        for (const n of [5, 7, 9, 12]) if (!opts.some((o) => o[0] === n)) opts.push([n, String(n)]);
        opts.sort((a, b) => a[0] - b[0]);
        return chips('Colours', opts, () => S.traceColours, (v) => { S.traceColours = v; api.forgetPalette(); api.changed(true); });
      })(),
      ...(api.pictureCheck()?.text ? [chips<string>('Lettering', [['', 'As traced'], ...FONTS.map((f) => [f.id, f.label] as [string, string])], () => S.traceFont ?? '', (v) => { S.traceFont = v; api.changed(); })] : []),
      chips('Edges', [[0.9, 'Soft', 'flowing curves'], [0.45, 'Crisp', 'more detail'], [0.3, 'Exact', 'clean flat art']], () => (S.traceSmooth >= 0.55 ? 0.9 : S.traceSmooth >= 0.38 ? 0.45 : 0.3), (v) => { S.traceSmooth = v; api.changed(); }),
      chips('Outline', [['follow', 'Follow the picture', 'background removed'], ['rect', 'Rectangle'], ['circle', 'Circle']],
        () => (S.traceFollow ? 'follow' : S.shape === 'circle' ? 'circle' : 'rect'),
        (v) => { if (v === 'follow') { S.traceFollow = true; api.fitToArtwork(); } else { S.traceFollow = false; S.shape = v as Settings['shape']; } api.changed(); }),
      api.traceStatus,
    ] },
    { id: 'layers', label: 'Layers', view: '3d', needsPicture: true, hidden: true, body: () => {
      api.drawTraceList();
      return ([
        h('h2', {}, 'Layers'),
        lead(S.traceDepthBy === 'colour' ? 'The top sheet is first. Move a colour up or down to change its depth. Drag the 3D view to look around.' : 'The top sheet is first, with the colours on each. Drag the 3D view to look around.'),
        chips('Material', [['birch', 'Birch ply', '3 mm'], ['paper', 'Card', '0.4 mm']], () => (S.material === 'paper' ? 'paper' : 'birch'), (v) => { api.setMaterial(v); api.changed(); }),
        (() => {
          const colours = () => api.traced()?.colours ?? S.traceColours;
          const get = () => (S.traceLayers && S.traceLayers > 1 ? S.traceLayers : colours());
          const extra = h('div', { hidden: get() <= colours() }, depthChips(() => api.relayer()));
          const f = stepper('Sheets', get, (v) => { S.traceLayers = v; extra.hidden = v <= colours(); api.relayer(); },
            () => `${depthNote(get())} ${get() > colours() ? `${colours()} traced colours; the other sheets extend or repeat them.` : get() < colours() ? 'Fewer sheets than colours: similar colours are merged.' : 'One sheet per colour.'}`);
          return h('div', {}, f, extra);
        })(),
        S.traceDepthBy !== 'colour' ? (() => {
          const on = api.fixMode();
          const n = api.learnCount();
          return h('div', { class: 'gfield' }, h('div', { class: 'glab' }, 'Fix a layer'),
            h('button', { class: `btn ${on ? 'primary' : ''}`, 'aria-pressed': on ? 'true' : 'false', onclick: () => { api.setFixMode(!on); draw(); } }, on ? 'Done fixing' : 'Tap a shape to fix it'),
            h('p', { class: 'note' }, on ? 'Tap any shape in the preview and say how it sits. Similar shapes follow, and the app remembers for your next pictures.' : 'Wrong sheet somewhere? Correct it, and the app learns from you.'),
            h('p', { class: 'note' }, `${api.fixCount() ? `${api.fixCount()} fixes on this picture. ` : ''}${n ? `Learnt from ${n} fix${n === 1 ? '' : 'es'}, stored only in this browser.` : ''}${api.builtInLessons() ? ` Starts from ${api.builtInLessons()} built-in lessons.` : ''}`),
            api.fixCount() ? h('button', { class: 'btn small ghost', onclick: () => { api.clearFixes(); draw(); } }, 'Undo fixes on this picture') : null,
            n ? h('button', { class: 'btn small ghost', onclick: () => { if (confirm('Forget everything the app has learnt from your fixes?')) { api.forgetLearning(); draw(); } } }, 'Forget what it learnt') : null);
        })() : null,
        h('div', { class: 'gfield' }, h('div', { class: 'glab' }, 'Order, top to bottom'), api.traceList,
          S.traceDepthBy === 'colour' ? h('button', { class: 'btn small ghost', onclick: () => api.autoOrder() }, 'Auto order (fewest loose pieces)') : null),
      ] as (Node | null)[]).filter((x): x is Node => !!x);
    } },
    { id: 'details', label: 'Details', view: 'layers', needsPicture: true, hidden: true, body: () => [
      h('h2', {}, 'Details'),
      lead('Small islands become loose pieces you glue in place. Choose how much fine detail to keep.'),
      chips('Fine detail', [[60, 'Simple', 'fewer pieces'], [25, 'Balanced'], [8, 'Intricate', 'more pieces']],
        () => (S.traceMinPiece >= 45 ? 60 : S.traceMinPiece <= 14 ? 8 : 25), (v) => { S.traceMinPiece = v; api.changed(); }),
      soon('Draw your own details', 'Add swirls and lines on top of any layer with symmetry, right here.'),
      api.traceStatus,
    ] },
    { id: 'colour', label: 'Touch up', view: 'stack', needsPicture: true, body: () => [
      h('h2', {}, 'Touch up'),
      lead('Change the colours, draw shapes or move pieces between layers by hand.'),
      ...studio.touchUp(),
      h('details', { class: 'gmore' }, h('summary', {}, 'Paint and card colours'),
        h('p', { class: 'note' }, 'The colour of each cut sheet, for painting or choosing card.'), api.colourPanel()),
    ] },
    { id: 'export', label: 'Export', view: 'stack', needsPicture: true, body: () => {
      const t = api.traced();
      return [
        h('h2', {}, 'Ready to cut'),
        lead(t ? `${t.sheets} sheets${t.pieces ? `, ${t.pieces} loose pieces to glue in` : ''}.` : 'Still tracing…'),
        h('button', { class: 'btn primary gbig', onclick: () => api.exportNow() }, 'Download everything (ZIP)'),
        h('p', { class: 'note' }, 'One SVG with every layer, one SVG per layer, sheets packed for your laser bed, a colour list and the project file.'),
        h('button', { class: 'btn', onclick: () => api.exportAllLayers() }, 'Just the one SVG with every layer'),
        h('p', { class: 'note' }, 'Each sheet is its own named layer, stacked in place, for Inkscape or LightBurn.'),
        h('div', { class: 'gok' }, h('b', {}, 'Want to fine-tune?'), h('p', {}, 'Advanced has every setting: sizes, kerf, ribs, alignment holes and more.'),
          h('button', { class: 'btn small', onclick: () => api.setAdvanced(true) }, 'Open in Advanced')),
      ];
    } },
  ];

  { const saved = store.get(LS_STEP) ?? ''; const k = STEPS.findIndex((x) => x.id === saved); step = k >= 0 ? k : 0; }
  const content = h('div', { class: 'gbody' });
  const nav = h('div', { class: 'gnav' });
  host.append(content, busyEl, nav);

  const visible = () => STEPS.filter((s) => !s.hidden);
  const idx = (id: string) => STEPS.findIndex((s) => s.id === id);
  function drawBar() {
    bar.innerHTML = '';
    const ol = h('ol', {});
    const cur = STEPS[step].hidden ? idx('arrange') : step;
    visible().forEach((s, n) => {
      const i = STEPS.indexOf(s), can = !s.needsPicture || api.hasPicture();
      ol.append(h('li', {}, h('button', { class: 'gstep' + (i === cur ? ' on' : '') + (i < cur ? ' done' : ''), disabled: !can,
        'aria-current': i === cur ? 'step' : null, onclick: () => go(i) }, h('i', { 'aria-hidden': 'true' }, String(n + 1)), h('span', {}, s.label))));
    });
    bar.append(ol);
  }
  function drawNav() {
    nav.innerHTML = '';
    const vis = visible(), s = STEPS[step];
    if (s.hidden) {
      nav.append(h('button', { class: 'btn ghost', onclick: () => go('arrange') }, 'Back to Arrange'), h('span', { class: 'gcount' }, ''), h('span', {}));
      return;
    }
    const n = vis.indexOf(s), last = n === vis.length - 1;
    const nextOk = s.id === 'hero' ? !!studio.shot('hero') : true;
    nav.append(
      h('button', { class: 'btn ghost', disabled: n === 0, onclick: () => go(STEPS.indexOf(vis[n - 1])) }, 'Back'),
      h('span', { class: 'gcount' }, `Step ${n + 1} of ${vis.length}`),
      last ? h('button', { class: 'btn', onclick: () => api.setAdvanced(true) }, 'Advanced')
        : h('button', { class: 'btn primary', disabled: !nextOk, onclick: () => { if (s.id === 'hero') studio.popRamp(); go(STEPS.indexOf(vis[n + 1])); } }, 'Next'),
    );
  }
  function draw() {
    const s = STEPS[step];
    const keep = content.querySelector('.gchat');
    const atEnd = keep ? keep.scrollTop + keep.clientHeight >= keep.scrollHeight - 8 : true;
    content.innerHTML = '';
    content.append(...s.body());
    const log = content.querySelector('.gchat');
    if (log && atEnd) log.scrollTop = log.scrollHeight;
    drawBar(); drawNav();
    const blank = s.id === 'hero' && !studio.shot('hero');
    document.body.classList.toggle('gnohero', blank);
    const vp = document.getElementById('viewport');
    if (vp && !vp.querySelector('.gblank')) vp.append(h('div', { class: 'gblank' }, h('b', {}, 'Your design appears here'),
      h('span', {}, 'Describe it and press Create. You see every layer stacked as you go.')));
  }
  function go(to: number | string) {
    let i = typeof to === 'string' ? idx(to) : to;
    if (studio.editing() && STEPS[i]?.id !== 'colour') void studio.closeEditor(true);
    i = Math.max(0, Math.min(STEPS.length - 1, i));
    if (STEPS[i].needsPicture && !api.hasPicture()) { api.toast('Make your Hero first'); i = 0; }
    step = i;
    store.set(LS_STEP, STEPS[i].id);
    api.showView(STEPS[i].view);
    draw();
    content.scrollTop = 0;
  }

  return {
    host, bar,
    /** Re-render the current step (after a trace, a new picture, or a settings change elsewhere). */
    refresh() { if (STEPS[step].needsPicture && !api.hasPicture()) step = 0; draw(); },
    /** A saved project was opened: its Hero and Pop come with it. */
    loaded() { studio.reload(); draw(); },
    /** A picture was chosen: move on to the Picture step if we were at Start. */
    pictureChosen() { if (!['hero', 'pop'].includes(STEPS[step].id)) draw(); },
    enter() { if (STEPS[step].needsPicture && !api.hasPicture()) step = 0; api.showView(STEPS[step].view); draw(); },
    /** A trace finished: steps that show trace results redraw. */
    traced() { if (['arrange', 'picture', 'trace', 'layers', 'details', 'export'].includes(STEPS[step].id)) draw(); },
    /** The stack finished computing: the export summary uses its numbers. */
    computed() { if (STEPS[step].id === 'export') draw(); },
    get step() { return step; },
  };
}
