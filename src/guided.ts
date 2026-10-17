// Guided mode: the default first-run experience. One step per screen, only the
// controls that step needs. Everything else lives in Advanced (the full app).
import type { Settings } from './engine';

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
  pickPicture: () => void;
  loadDemo: () => Promise<void>;
  traced: () => { sheets: number; pieces: number } | null;
  traceStatus: HTMLElement;
  traceList: HTMLElement;
  drawTraceList: () => void;
  autoOrder: () => void;
  colourPanel: () => HTMLElement;
  redrawPrompt: () => string;
  setMaterial: (id: string) => void;
  showView: (v: View) => void;
  changed: (resetOrder?: boolean) => void; // settings changed: re-trace / recompute
  exportNow: () => void;
  setAdvanced: (on: boolean) => void;
}

interface Step { id: string; label: string; view: View; needsPicture: boolean; body: () => Node[] }

const LS_STEP = 'lc.guided.step';

export function createGuided(api: GuidedApi) {
  const { S, h } = api;
  const host = h('aside', { class: 'gpanel', id: 'gpanel', 'aria-label': 'Guided steps' });
  const bar = h('nav', { class: 'gsteps', 'aria-label': 'Progress' });
  let step = Math.max(0, Math.min(7, Number(store.get(LS_STEP) ?? 0) | 0));
  if (step > 0 && !api.hasPicture()) step = 0;

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

  const STEPS: Step[] = [
    { id: 'start', label: 'Start', view: 'stack', needsPicture: false, body: () => [
      h('h2', {}, 'Make something layered'),
      lead('Turn a picture into a stack of laser-cut sheets. Every colour becomes its own layer.'),
      h('div', { class: 'gcards' },
        h('button', { class: 'gcard hero', onclick: async () => { await api.loadDemo(); go(1); } },
          h('img', { src: './demo/daruma.webp', alt: '', loading: 'lazy' }),
          h('span', {}, h('b', {}, 'Try the Daruma demo'), h('small', {}, 'A trippy perseverance doll, ready to trace'))),
        h('button', { class: 'gcard', onclick: () => api.pickPicture() },
          h('span', {}, h('b', {}, 'Use my own picture'), h('small', {}, 'PNG, JPEG or WebP. Flat colours work best'))),
        h('div', { class: 'gcard off', 'aria-disabled': 'true' },
          h('span', {}, h('b', {}, 'Describe an idea'), h('small', {}, 'AI creates the picture. Pay per use with Bitcoin, no account. Coming soon'))),
      ),
    ] },
    { id: 'picture', label: 'Picture', view: 'stack', needsPicture: true, body: () => {
      const p = api.picture();
      return [
        h('h2', {}, 'Your picture'),
        lead('This is what the layers are made from. The preview shows the first trace.'),
        h('figure', { class: 'gpic' }, h('img', { src: p.src, alt: p.name || 'Your picture' }), h('figcaption', {}, p.name || 'Picture')),
        h('div', { class: 'gbtns' }, h('button', { class: 'btn', onclick: () => api.pickPicture() }, 'Choose a different picture')),
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
        soon('Flatten with AI', 'One tap redraws your picture in flat, cut-ready colours. Pay per use with Bitcoin (Lightning or Cashu), no account.'),
        h('details', { class: 'gmore' }, h('summary', {}, 'Do it yourself now'),
          h('p', { class: 'note' }, 'Open Gemini, choose Nano Banana Pro, attach your picture and paste this prompt. Then choose the result as your picture.'),
          h('button', { class: 'btn small', onclick: copy }, 'Copy redraw prompt'),
          h('button', { class: 'btn small ghost', onclick: () => api.pickPicture() }, 'Choose the flat picture')),
      ];
    } },
    { id: 'trace', label: 'Trace', view: 'stack', needsPicture: true, body: () => [
      h('h2', {}, 'Trace and outline'),
      lead('Pick how many colours to find. Each colour becomes one sheet.'),
      chips('Colours', [[5, '5'], [7, '7'], [9, '9'], [12, '12']], () => S.traceColours, (v) => { S.traceColours = v; api.changed(true); }),
      chips('Edges', [[0.9, 'Soft', 'flowing curves'], [0.45, 'Crisp', 'more detail']], () => (S.traceSmooth >= 0.55 ? 0.9 : 0.45), (v) => { S.traceSmooth = v; api.changed(); }),
      chips('Outline', [['rect', 'Rectangle'], ['circle', 'Circle']], () => (S.shape === 'circle' ? 'circle' : 'rect'), (v) => { S.shape = v as Settings['shape']; api.changed(); }),
      soon('Follow the picture', 'The outer cut follows the shape of your artwork, like the Daruma, instead of a plate.'),
      api.traceStatus,
    ] },
    { id: 'layers', label: 'Layers', view: '3d', needsPicture: true, body: () => {
      api.drawTraceList();
      return [
        h('h2', {}, 'Layers'),
        lead('The top sheet is first. Move a colour up or down to change its depth. Drag the 3D view to look around.'),
        chips('Material', [['birch', 'Birch ply', '3 mm'], ['paper', 'Card', '0.4 mm']], () => (S.material === 'paper' ? 'paper' : 'birch'), (v) => { api.setMaterial(v); api.changed(); }),
        h('div', { class: 'gfield' }, h('div', { class: 'glab' }, 'Order, top to bottom'), api.traceList,
          h('button', { class: 'btn small ghost', onclick: () => api.autoOrder() }, 'Auto order (fewest loose pieces)')),
      ];
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
        h('button', { class: 'btn primary gbig', onclick: () => api.exportNow() }, 'Download SVG files'),
        h('p', { class: 'note' }, 'A ZIP with one SVG per layer, sheets packed for your laser bed, a colour list and the project file.'),
        soon('One SVG with every layer', 'A single file with each sheet as its own named layer, for Inkscape or LightBurn.'),
        h('div', { class: 'gok' }, h('b', {}, 'Want to fine-tune?'), h('p', {}, 'Advanced has every setting: sizes, kerf, ribs, alignment holes and more.'),
          h('button', { class: 'btn small', onclick: () => api.setAdvanced(true) }, 'Open in Advanced')),
      ];
    } },
  ];

  const content = h('div', { class: 'gbody' });
  const nav = h('div', { class: 'gnav' });
  host.append(content, nav);

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
