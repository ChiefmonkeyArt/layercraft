// Guided mode: the default first-run experience. One step per screen, only the
// controls that step needs. Everything else lives in Advanced (the full app).
import type { Settings } from './engine';
import type { AiUi } from './aiui';
import { IDEA_PROMPT, fmtSats, fmtUsd, type PictureCheck } from './ai';
import { nearestAspect } from './aiui';
import { FONTS } from './lettering';

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
  usePicture: (url: string, name: string, sameArt?: boolean) => Promise<void>;
  setName: (n: string) => void;
}

interface Step { id: string; label: string; view: View; needsPicture: boolean; body: () => Node[] }

const LS_STEP = 'lc.guided.step';

export function createGuided(api: GuidedApi) {
  const { S, h } = api;
  const host = h('aside', { class: 'gpanel', id: 'gpanel', 'aria-label': 'Guided steps' });
  const bar = h('nav', { class: 'gsteps', 'aria-label': 'Progress' });
  let step = Math.max(0, Math.min(7, Number(store.get(LS_STEP) ?? 0) | 0));

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
  const autoLevels = () => Math.min(ideaLayers, 8);
  function ideaForm() {
    const ta = h('textarea', { class: 'aiinp', rows: 4, placeholder: 'Describe the design and the art you want, e.g. a koi fish curling round a lotus, art nouveau curves, with the words “Go with the flow”', 'aria-label': 'Describe your design', maxlength: 1200 }) as HTMLTextAreaElement;
    ta.value = ideaText;
    ta.addEventListener('input', () => { ideaText = ta.value; store.set('lc.ai.idea', ta.value); });
    const own = h('input', { type: 'text', class: 'aiinp', placeholder: 'e.g. teal, coral and gold', 'aria-label': 'Your colours', value: ideaColours, hidden: !ideaMine }) as HTMLInputElement;
    own.addEventListener('input', () => { ideaColours = own.value; store.set('lc.ai.colours', own.value); });
    const levelsNote = () => ideaLevels
      ? `The AI draws ${ideaLevels} shapes; ${ideaLayers > ideaLevels ? `the other ${ideaLayers - ideaLevels} sheets extend or repeat them.` : 'one per sheet.'}`
      : ideaLayers > 8 ? `The AI draws 8 shapes; the other ${ideaLayers - 8} sheets extend or repeat them.` : 'One drawn shape per sheet.';
    const lvNote = h('p', { class: 'note' }, levelsNote());
    return h('div', { class: 'gfield gidea' },
      h('div', { class: 'glab' }, 'Your design'), ta,
      stepper('Layers', () => ideaLayers, (v) => { ideaLayers = v; store.set('lc.ai.layers', String(v)); lvNote.textContent = levelsNote(); }, () => depthNote(ideaLayers)),
      chips<boolean>('Colours', [[false, 'Gradient', 'suits the design'], [true, 'My colours']], () => ideaMine, (v) => { ideaMine = v; own.hidden = !v; if (v) own.focus(); }),
      own,
      h('details', { class: 'gmore' }, h('summary', {}, 'More options'),
        chips<number>('Shapes the AI draws', [[0, 'Auto'], [3, '3'], [5, '5'], [8, '8'], [12, '12']], () => ideaLevels, (v) => { ideaLevels = v; store.set('lc.ai.levels', String(v)); lvNote.textContent = levelsNote(); }),
        lvNote,
        depthChips(() => {}),
        h('p', { class: 'note' }, 'Laser artists often stack more sheets than colours: Extend steps each shape in for a terraced edge, Repeat stacks copies for depth. Change it any time on the Layers step.')),
      aiButton('Create picture', async () => {
        const idea = ideaText.trim();
        if (idea.length < 3) { api.toast('Describe your design first'); ta.focus(); return; }
        const levels = Math.max(2, Math.min(ideaLayers, ideaLevels || autoLevels()));
        const mine = ideaMine ? ideaColours.trim() : '';
        const url = await api.ai.create(IDEA_PROMPT(idea, { levels, layers: ideaLayers, colours: mine }), undefined, '3:4', () => busy('Drawing your design…'));
        if (url) {
          api.projects.startNew();
          const name = idea.split(/\s+/).slice(0, 4).join(' ').replace(/[^\p{L}\p{N} '-]/gu, '').slice(0, 40) || 'AI idea';
          S.traceColours = levels; S.traceLayers = ideaLayers; S.traceColourMode = mine ? 'picture' : 'gradient'; S.traceDarkFirst = false;
          await api.usePicture(url, `${name}.png`);
          S.traceColours = levels; S.traceLayers = ideaLayers; S.traceColourMode = mine ? 'picture' : 'gradient'; S.traceDarkFirst = false;
          api.setName(name.charAt(0).toUpperCase() + name.slice(1));
          if (!S.traceFollow) { S.traceFollow = true; api.fitToArtwork(); }
          api.changed(true);
          busy(''); ideaOpen = false; go(1); return;
        }
        busy('');
      }),
      h('p', { class: 'note' }, `Made with ${api.ai.modelLabel()} from your description, in flat colours ready to trace.`));
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
          onclick: async () => { if (await api.projects.open(p.id)) go(api.hasPicture() ? 1 : 0); },
          onkeydown: async (e: KeyboardEvent) => { if (e.key === 'Enter' && (await api.projects.open(p.id))) go(api.hasPicture() ? 1 : 0); } },
          p.thumb ? h('img', { src: p.thumb, alt: '' }) : h('i', {}),
          h('span', {}, h('b', {}, p.name), h('small', {}, ago(p.updated))), del));
      }
      wrap.append(h('div', { class: 'glab' }, 'Continue a project'), list, h('p', { class: 'note' }, 'Saved automatically in this browser. Nothing leaves your device.'));
    });
    return wrap;
  }

  const STEPS: Step[] = [
    { id: 'start', label: 'Start', view: 'stack', needsPicture: false, body: () => [
      h('h2', {}, 'Make something layered'),
      lead('Turn a picture into a stack of laser-cut sheets. Every colour becomes its own layer.'),
      projectList(),
      h('div', { class: 'gcards' },
        h('button', { class: 'gcard hero', onclick: async () => { await api.loadDemo(); go(1); } },
          h('img', { src: './demo/daruma.webp', alt: '', loading: 'lazy' }),
          h('span', {}, h('b', {}, 'Try the Daruma demo'), h('small', {}, 'A trippy perseverance doll, ready to trace'))),
        h('button', { class: 'gcard', onclick: () => { api.projects.startNew(); api.pickPicture(); } },
          h('span', {}, h('b', {}, 'Use my own picture'), h('small', {}, 'PNG, JPEG or WebP. Flat colours work best'))),
        h('button', { class: 'gcard' + (ideaOpen ? ' on' : ''), 'aria-expanded': ideaOpen ? 'true' : 'false', onclick: () => { ideaOpen = !ideaOpen; draw(); } },
          h('span', {}, h('b', {}, 'Describe an idea'), h('small', {}, 'AI draws it for you. Pay per use with Bitcoin, no account'))),
      ),
      ...(ideaOpen ? [ideaForm()] : []),
    ] },
    { id: 'picture', label: 'Picture', view: 'stack', needsPicture: true, body: () => {
      const p = api.picture();
      return [
        h('h2', {}, 'Your picture'),
        lead('This is what the layers are made from. The preview shows the first trace.'),
        h('figure', { class: 'gpic' }, h('img', { src: p.src, alt: p.name || 'Your picture' }), h('figcaption', {}, p.name || 'Picture')),
        h('div', { class: 'gbtns' }, h('button', { class: 'btn', onclick: () => api.pickPicture() }, 'Choose a different picture')),
        ...(() => {
          const info = api.pictureInfo();
          if (!info) return [];
          if (info.shaded) return isRedraw() ? [] : [flattenFirstCard()];
          const sw = h('div', { class: 'gswatches', 'aria-label': 'Colours found' });
          for (const f of info.found) sw.append(h('i', { style: `background:${f.hex}`, title: f.hex }));
          return [h('div', { class: 'gfield' }, h('div', { class: 'glab' }, `Found ${info.colours} flat colours`), sw,
            h('p', { class: 'note' }, info.plainBg ? 'The plain background is left out and the outline follows your artwork. Each other colour becomes a sheet.' : 'Each colour becomes a sheet.'))];
        })(),
        checkCard(),
      ];
    } },
    { id: 'flat', label: 'Flatten', view: 'stack', needsPicture: true, body: () => {
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
    { id: 'trace', label: 'Trace', view: 'stack', needsPicture: true, body: () => [
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
        return chips('Colours', opts, () => S.traceColours, (v) => { S.traceColours = v; api.changed(true); });
      })(),
      ...(api.pictureCheck()?.text ? [chips<string>('Lettering', [['', 'As traced'], ...FONTS.map((f) => [f.id, f.label] as [string, string])], () => S.traceFont ?? '', (v) => { S.traceFont = v; api.changed(); })] : []),
      chips('Edges', [[0.9, 'Soft', 'flowing curves'], [0.45, 'Crisp', 'more detail'], [0.3, 'Exact', 'clean flat art']], () => (S.traceSmooth >= 0.55 ? 0.9 : S.traceSmooth >= 0.38 ? 0.45 : 0.3), (v) => { S.traceSmooth = v; api.changed(); }),
      chips('Outline', [['follow', 'Follow the picture', 'background removed'], ['rect', 'Rectangle'], ['circle', 'Circle']],
        () => (S.traceFollow ? 'follow' : S.shape === 'circle' ? 'circle' : 'rect'),
        (v) => { if (v === 'follow') { S.traceFollow = true; api.fitToArtwork(); } else { S.traceFollow = false; S.shape = v as Settings['shape']; } api.changed(); }),
      api.traceStatus,
    ] },
    { id: 'layers', label: 'Layers', view: '3d', needsPicture: true, body: () => {
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
            n ? h('button', { class: 'btn small ghost', title: 'Numbers only: how each fixed shape sat and what you chose. No pictures.', onclick: () => api.saveLessons() }, 'Save my lessons') : null,
            api.fixCount() ? h('button', { class: 'btn small ghost', onclick: () => { api.clearFixes(); draw(); } }, 'Undo fixes on this picture') : null,
            n ? h('button', { class: 'btn small ghost', onclick: () => { if (confirm('Forget everything the app has learnt from your fixes?')) { api.forgetLearning(); draw(); } } }, 'Forget what it learnt') : null);
        })() : null,
        h('div', { class: 'gfield' }, h('div', { class: 'glab' }, 'Order, top to bottom'), api.traceList,
          S.traceDepthBy === 'colour' ? h('button', { class: 'btn small ghost', onclick: () => api.autoOrder() }, 'Auto order (fewest loose pieces)') : null),
      ] as (Node | null)[]).filter((x): x is Node => !!x);
    } },
    { id: 'details', label: 'Details', view: 'layers', needsPicture: true, body: () => [
      h('h2', {}, 'Details'),
      lead('Small islands become loose pieces you glue in place. Choose how much fine detail to keep.'),
      chips('Fine detail', [[60, 'Simple', 'fewer pieces'], [25, 'Balanced'], [8, 'Intricate', 'more pieces']],
        () => (S.traceMinPiece >= 45 ? 60 : S.traceMinPiece <= 14 ? 8 : 25), (v) => { S.traceMinPiece = v; api.changed(); }),
      soon('Draw your own details', 'Add swirls and lines on top of any layer with symmetry, right here.'),
      api.traceStatus,
    ] },
    { id: 'colour', label: 'Colour', view: 'stack', needsPicture: true, body: () => [
      h('h2', {}, 'Colour'),
      lead('Tap a sheet to change its colour. These are the colours for painting or choosing card.'),
      api.colourPanel(),
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

  const content = h('div', { class: 'gbody' });
  const nav = h('div', { class: 'gnav' });
  host.append(content, busyEl, nav);

  function drawBar() {
    bar.innerHTML = '';
    const ol = h('ol', {});
    STEPS.forEach((s, i) => {
      const can = !s.needsPicture || api.hasPicture();
      ol.append(h('li', {}, h('button', { class: 'gstep' + (i === step ? ' on' : '') + (i < step ? ' done' : ''), disabled: !can,
        'aria-current': i === step ? 'step' : null, onclick: () => go(i) }, h('i', { 'aria-hidden': 'true' }, i ? String(i) : '•'), h('span', {}, s.label))));
    });
    bar.append(ol);
  }
  function drawNav() {
    nav.innerHTML = '';
    const last = step === STEPS.length - 1;
    const nextOk = step === 0 ? api.hasPicture() : true;
    nav.append(
      h('button', { class: 'btn ghost', disabled: step === 0, onclick: () => go(step - 1) }, 'Back'),
      h('span', { class: 'gcount' }, step ? `Step ${step} of ${STEPS.length - 1}` : ''),
      last ? h('button', { class: 'btn', onclick: () => api.setAdvanced(true) }, 'Advanced')
        : h('button', { class: 'btn primary', disabled: !nextOk, onclick: () => go(step + 1) }, step === 0 ? 'Continue' : 'Next'),
    );
  }
  function draw() {
    const s = STEPS[step];
    content.innerHTML = '';
    content.append(...s.body());
    drawBar(); drawNav();
  }
  function go(i: number) {
    i = Math.max(0, Math.min(STEPS.length - 1, i));
    if (STEPS[i].needsPicture && !api.hasPicture()) { api.toast('Choose a picture first'); return; }
    step = i;
    store.set(LS_STEP, String(step));
    api.showView(STEPS[i].view);
    draw();
    content.scrollTop = 0;
  }

  return {
    host, bar,
    /** Re-render the current step (after a trace, a new picture, or a settings change elsewhere). */
    refresh() { if (step > 0 && !api.hasPicture()) step = 0; draw(); },
    /** A picture was chosen: move on to the Picture step if we were at Start. */
    pictureChosen() { if (step === 0) go(1); else draw(); },
    enter() { if (step > 0 && !api.hasPicture()) step = 0; api.showView(STEPS[step].view); draw(); },
    /** A trace finished: steps that show trace results redraw. */
    traced() { if (['picture', 'trace', 'layers', 'details', 'export'].includes(STEPS[step].id)) draw(); },
    /** The stack finished computing: the export summary uses its numbers. */
    computed() { if (STEPS[step].id === 'export') draw(); },
    get step() { return step; },
  };
}
