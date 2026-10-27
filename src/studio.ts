// The guided creation flow: chat with the AI to draw the Hero (the main design), then the Pop
// (the complementary one), arrange the Pop's layers among the Hero's, then touch up by hand.
// Every AI drawing is cleaned to its exact planned colours and checked for cutting; the two are
// combined into one stack (see compose.ts) and traced exactly.
import type { GuidedApi } from './guided';
import { HERO_PROMPT, HERO_REFINE_PROMPT, POP_PROMPT, POP_REFINE_PROMPT } from './ai';
import { RAMPS, blendPalette, colourName, fixPrompt, rampPalette, type CutReport } from './cutready';
import { compose, labelsOf, mergePlace, nudge, slotsOf, spreadPlace, topPlace, type PopPlace } from './compose';
import { nearestAspect } from './aiui';
import { hexRgb as hexToRgb } from './trace';

export interface Shot { src: string; plan: string[]; report: CutReport; w: number; h: number }
export interface Msg { you: boolean; text: string; img?: string; imgs?: string[]; shot?: number }
export interface Part { chat: Msg[]; shots: Shot[]; pick: number; layers: number; ramp: string; mine: boolean; colours: string; draft: string }
export interface Art { v: 1; hero: Part; pop: Part; place: PopPlace[]; noPop?: boolean; name?: string; frame?: boolean }
export type Which = 'hero' | 'pop';

const part = (layers: number, ramp: string): Part => ({ chat: [], shots: [], pick: -1, layers, ramp, mine: false, colours: '', draft: '' });
const POP_RAMP: Record<string, string> = { sunset: 'ocean', ocean: 'fire', forest: 'sunset', fire: 'ocean', rainbow: 'wood', wood: 'forest' };
export const newArt = (): Art => ({ v: 1, hero: part(8, 'sunset'), pop: part(3, 'ocean'), place: [] });
const KEEP_SHOTS = 6; // pictures kept per chat (older ones keep their message, not the picture)

type H = GuidedApi['h'];
export interface StudioCtx {
  api: GuidedApi; h: H;
  busy: (m: string) => void;
  aiButton: (label: string, run: () => Promise<void>, cost?: () => Promise<number | null>, cls?: string) => HTMLButtonElement;
  chips: <T>(label: string, opts: [T, string, string?][], get: () => T, set: (v: T) => void) => HTMLElement;
  stepper: (label: string, get: () => number, set: (v: number) => void, note: () => string, min?: number) => HTMLElement;
  draw: () => void;
  go: (id: string) => void;
}

const loadImg = (src: string) => new Promise<HTMLImageElement>((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('Could not read that picture')); i.src = src; });
async function pixels(src: string, w: number, h: number) {
  const im = await loadImg(src), c = document.createElement('canvas'); c.width = w; c.height = h;
  const x = c.getContext('2d', { willReadFrequently: true })!; x.imageSmoothingEnabled = false; x.drawImage(im, 0, 0, w, h);
  return x.getImageData(0, 0, w, h).data;
}
function toUrl(r: { width: number; height: number; data: Uint8ClampedArray }) {
  const c = document.createElement('canvas'); c.width = r.width; c.height = r.height;
  c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(r.data), r.width, r.height), 0, 0);
  return c.toDataURL('image/png');
}
async function shrink(src: string, long: number, type = 'image/png') {
  const im = await loadImg(src), s = Math.min(1, long / Math.max(im.naturalWidth, im.naturalHeight));
  const c = document.createElement('canvas'); c.width = Math.round(im.naturalWidth * s); c.height = Math.round(im.naturalHeight * s);
  c.getContext('2d')!.drawImage(im, 0, 0, c.width, c.height);
  return c.toDataURL(type, 0.85);
}

export function createStudio(x: StudioCtx) {
  const { api, h } = x;
  let art: Art = valid(api.art()) ?? newArt();
  const MAX_ATTACH = 3;
  const attach: Record<Which, string[]> = { hero: [], pop: [] };
  let rebuildTimer = 0;
  function valid(a: unknown): Art | null {
    const o = a as Art;
    return o && o.v === 1 && o.hero && o.pop && Array.isArray(o.hero.chat) && Array.isArray(o.place) ? o : null;
  }
  const save = () => api.setArt(art);
  const levelsOf = (p: Part) => Math.max(2, Math.min(p.layers, 8));
  /** the exact colours the AI is asked for, back level first */
  const planOf = (p: Part) => {
    const n = levelsOf(p);
    if (p.mine) { const own = api.parseColours(p.colours); if (own.length) return blendPalette(own, n); }
    return rampPalette(n, p.ramp);
  };
  const shot = (w: Which) => { const p = art[w]; return p.pick >= 0 ? p.shots[p.pick] ?? null : null; };
  const hasPop = () => !art.noPop && !!shot('pop');

  function summary(r: CutReport, plan: string[]) {
    if (r.ready) return `Ready to cut: ${plan.length} sheets${r.thickened ? `, ${r.thickened} thin part${r.thickened === 1 ? '' : 's'} strengthened` : ''}.`;
    const left: string[] = [];
    for (const k of r.missing) left.push(`sheet ${k + 1} (${colourName(plan[k])}) is missing`);
    for (const [a, b] of r.merged) left.push(`sheets ${a + 1} and ${b + 1} came out the same colour`);
    if (r.unknown >= 0.03) left.push(`${Math.round(r.unknown * 100)}% used other colours`);
    return `Nearly ready: ${left.join(', ')}. Ask the AI to fix it, or carry on and the app cuts what is there.`;
  }

  /** combine the chosen Hero (and Pop) into one stack and trace it */
  async function rebuild() {
    const H = shot('hero');
    if (!H) return;
    const P = hasPop() ? shot('pop') : null;
    const w = H.w, hh = H.h, N = w * hh;
    const hl = labelsOf(await pixels(H.src, w, hh), N, H.plan);
    let pl: Int8Array | null = null;
    if (P) {
      pl = labelsOf(await pixels(P.src, w, hh), N, P.plan);
      if (art.place.length !== P.plan.length) art.place = spreadPlace(H.plan.length, P.plan.length);
    }
    const c = compose(w, hh, hl, H.plan, pl, P?.plan ?? [], art.place, art.frame !== false);
    const extra = Math.max(0, art.hero.layers - H.plan.length) + (P ? Math.max(0, art.pop.layers - P.plan.length) : 0);
    api.S.traceLayers = extra ? c.n + extra : 0;
    api.S.traceDarkFirst = false; api.S.traceColourMode = 'picture';
    await api.useComposite(toUrl(c.colour), toUrl(c.map), c.n, c.palette, `${art.name || 'design'}.png`);
    save();
  }
  const rebuildSoon = () => { clearTimeout(rebuildTimer); rebuildTimer = window.setTimeout(() => void rebuild(), 600); };

  async function send(which: Which, text: string) {
    const p = art[which], cur = shot(which), H = shot('hero'), ref = attach[which];
    if (which === 'pop' && !H) { api.toast('Make the Hero first'); return; }
    if (text.trim().length < 3) { api.toast(cur ? 'Say what to change' : 'Describe what you see first'); return; }
    const plan = planOf(p);
    let prompt: string, refs: string[];
    if (which === 'hero') {
      if (cur) { prompt = HERO_REFINE_PROMPT(text, plan, ref.length); refs = [cur.src, ...ref]; }
      else { prompt = HERO_PROMPT(text, plan, p.layers, ref.length); refs = [...ref]; }
    } else if (cur) { prompt = POP_REFINE_PROMPT(text, plan, ref.length); refs = [cur.src, H!.src, ...ref]; }
    else { prompt = POP_PROMPT(text, plan, ref.length); refs = [H!.src, ...ref]; }
    const aspect = H ? nearestAspect(H.w, H.h) : '3:4';
    const url = await api.ai.create(prompt, refs.length ? refs : undefined, aspect, () => x.busy(which === 'hero' ? (cur ? 'Changing your Hero…' : 'Drawing your Hero…') : (cur ? 'Changing the Pop…' : 'Drawing the Pop…')));
    if (!url) { x.busy(''); x.draw(); return; } // no credit, or the AI failed (it said why); the message stays in the box
    if (which === 'hero' && !art.hero.shots.length) {
      // a new piece: its own project, named from the first words
      api.projects.startNew();
      art = { ...art, name: text.split(/\s+/).slice(0, 4).join(' ').replace(/[^\p{L}\p{N} '-]/gu, '').slice(0, 40) || 'AI design' };
      api.setName(art.name!.charAt(0).toUpperCase() + art.name!.slice(1));
    }
    const imgs = await Promise.all(ref.map((r) => shrink(r, 240, 'image/jpeg')));
    p.chat.push({ you: true, text: text.trim(), img: imgs[0], imgs: imgs.length > 1 ? imgs : undefined });
    p.draft = ''; attach[which] = [];
    await addShot(which, url, plan);
  }
  async function addShot(which: Which, url: string, plan: string[]) {
    const p = art[which];
    x.busy('Checking it can be cut…');
    const r = await api.cutReady(url, plan, plan.length);
    if (!r) { x.busy(''); p.chat.push({ you: false, text: 'That picture could not be read. Try again.' }); save(); x.draw(); return; }
    const im = await loadImg(r.url);
    p.shots.push({ src: r.url, plan: r.plan, report: r.report, w: im.naturalWidth, h: im.naturalHeight });
    p.pick = p.shots.length - 1;
    p.chat.push({ you: false, text: summary(r.report, r.plan), shot: p.pick });
    for (let k = 0; k < p.shots.length - KEEP_SHOTS; k++) if (k !== p.pick) p.shots[k].src = '';
    if (which === 'pop' || (which === 'hero' && shot('pop'))) art.place = shot('pop') ? (art.place.length === shot('pop')!.plan.length ? art.place : spreadPlace(shot('hero')!.plan.length, shot('pop')!.plan.length)) : [];
    if (which === 'pop') art.noPop = false;
    x.busy('Building the stack…');
    await rebuild();
    x.busy(''); x.draw();
  }
  async function fix(which: Which) {
    const s = shot(which);
    if (!s) return;
    const url = await api.ai.create(fixPrompt(s.plan, s.report), s.src, nearestAspect(s.w, s.h), () => x.busy('Asking the AI to fix it…'));
    if (!url) { x.busy(''); return; }
    art[which].chat.push({ you: true, text: 'Fix what the cut check found.' });
    await addShot(which, url, s.plan);
  }

  // ---------- the chat panel ----------
  const fileIn = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp', multiple: true, hidden: true }) as HTMLInputElement;
  let fileFor: Which = 'hero';
  fileIn.addEventListener('change', async () => {
    const fs = [...(fileIn.files ?? [])]; fileIn.value = '';
    for (const f of fs) {
      if (attach[fileFor].length >= MAX_ATTACH) { api.toast(`Up to ${MAX_ATTACH} pictures per message`); break; }
      if (f.size > 30e6) { api.toast('That picture is over 30 MB'); continue; }
      const url = await new Promise<string>((res) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.readAsDataURL(f); });
      try { attach[fileFor].push(await shrink(url, 1600, 'image/jpeg')); } catch { api.toast('Could not read that picture'); }
    }
    x.draw();
  });
  const EXAMPLES: Record<Which, string[]> = {
    hero: ['A fox silhouette under a full moon', 'A mandala of lotus petals, art nouveau curves', 'A koi fish curling round a lotus flower'],
    pop: ['Stars and a crescent moon around it', 'An outer ring of petals', 'Rolling hills and pine trees behind'],
  };
  function chat(which: Which) {
    const p = art[which], cur = shot(which);
    const log = h('div', { class: 'gchat', role: 'log', 'aria-label': which === 'hero' ? 'Hero chat' : 'Pop chat' });
    if (!p.chat.length) {
      const ex = h('div', { class: 'gexamples' }, h('small', {}, 'For example'));
      for (const e of EXAMPLES[which]) ex.append(h('button', { class: 'gchip', onclick: () => { p.draft = e; x.draw(); (document.querySelector('.gcompose textarea') as HTMLTextAreaElement | null)?.focus(); } }, e));
      log.append(ex);
    }
    p.chat.forEach((m, i) => {
      if (m.you) { const im = m.imgs ?? (m.img ? [m.img] : []); log.append(h('div', { class: 'gmsg you' }, im.length ? h('div', { class: 'gthumbs' }, ...im.map((src) => h('img', { src, alt: 'Your attached picture' }))) : null, h('p', {}, m.text))); return; }
      const s = m.shot != null ? p.shots[m.shot] : null, on = m.shot === p.pick;
      log.append(h('div', { class: 'gmsg ai' + (on ? ' on' : '') },
        s?.src ? h('button', { class: 'gshot', 'aria-label': on ? 'This version is in use' : 'Use this version', 'aria-pressed': on ? 'true' : 'false',
          onclick: async () => { if (on) return; p.pick = m.shot!; save(); x.busy('Building the stack…'); await rebuild(); x.busy(''); x.draw(); } },
          h('img', { src: s.src, alt: `${which === 'hero' ? 'Hero' : 'Pop'} drawing ${i}` }), on ? h('span', { class: 'gbadge' }, 'In use') : h('span', { class: 'gbadge ghost' }, 'Use this')) : null,
        h('p', {}, m.text),
        on && s && !s.report.ready ? x.aiButton('Ask the AI to fix it', () => fix(which), undefined, 'small') : null));
    });
    const ta = h('textarea', { rows: 3, maxlength: 1200, 'aria-label': which === 'hero' ? 'Describe your Hero' : 'Describe your Pop',
      placeholder: cur ? 'Say what to change, e.g. make the moon bigger' : which === 'hero' ? 'Describe what you see: a silhouette scene, a character, a pattern in layers…' : 'Describe the Pop: scenery behind, an accent pattern, a second mandala ring…' }) as HTMLTextAreaElement;
    ta.value = p.draft;
    ta.addEventListener('input', () => { p.draft = ta.value; });
    ta.addEventListener('change', save);
    ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); sendBtn.click(); } });
    const full = attach[which].length >= MAX_ATTACH;
    const plus = h('button', { class: 'gplus', 'aria-label': 'Attach pictures', title: full ? `Up to ${MAX_ATTACH} pictures per message` : 'Attach pictures', disabled: full, onclick: () => { fileFor = which; fileIn.click(); } }, '+');
    const chip = attach[which].length ? h('div', { class: 'gattach' }, ...attach[which].map((src, k) => h('span', { class: 'gatt' }, h('img', { src, alt: `Picture ${k + 1} to send` }),
      h('button', { class: 'gpdel', 'aria-label': `Remove picture ${k + 1}`, onclick: () => { attach[which].splice(k, 1); x.draw(); } }, '×'))),
      h('small', {}, attach[which].length === 1 ? 'Attached' : `${attach[which].length} attached`)) : null;
    const sendBtn = x.aiButton(cur ? 'Send change' : which === 'hero' ? 'Create' : 'Create the Pop', () => send(which, ta.value));
    const plan = planOf(p);
    const sw = h('div', { class: 'gswatches', 'aria-label': 'Colours, back sheet first' });
    for (const c of plan) sw.append(h('i', { style: `background:${c}`, title: `${c} ${colourName(c)}` }));
    const own = h('input', { type: 'text', class: 'aiinp', placeholder: 'e.g. teal, coral and gold', 'aria-label': 'Your colours', value: p.colours, hidden: !p.mine }) as HTMLInputElement;
    own.addEventListener('change', () => { p.colours = own.value; save(); x.draw(); });
    const settings = h('details', { class: 'gmore gset' },
      h('summary', {}, h('span', {}, `${p.layers} layers · ${p.mine ? 'my colours' : (RAMPS[p.ramp]?.label ?? 'Sunset')}`), sw),
      x.stepper('Layers', () => p.layers, (v) => { p.layers = v; save(); x.draw(); }, () => `${levelsOf(p)} drawn shape${levelsOf(p) === 1 ? '' : 's'}${p.layers > levelsOf(p) ? `; the other ${p.layers - levelsOf(p)} sheets extend them` : ', one per sheet'}.`),
      x.chips<string>('Colours', [...Object.entries(RAMPS).map(([k, r]) => [k, r.label] as [string, string]), ['mine', 'My colours']], () => (p.mine ? 'mine' : p.ramp),
        (v) => { if (v === 'mine') p.mine = true; else { p.mine = false; p.ramp = v; } save(); x.draw(); }),
      own,
      h('p', { class: 'note' }, 'The AI is given these exact colours, one per sheet from the back. The app cleans its drawing to them and checks it can be cut.'));
    (settings as HTMLDetailsElement).open = !p.chat.length;
    return h('div', { class: 'gstudio' }, log,
      h('div', { class: 'gcompose' }, chip, ta, h('div', { class: 'growbtns' }, plus, sendBtn)),
      settings, fileIn);
  }

  // ---------- arrange ----------
  function arrange() {
    const H = shot('hero'), P = hasPop() ? shot('pop') : null;
    if (!H) return [h('p', { class: 'note' }, 'Make the Hero first.')];
    const frameCh = x.chips<boolean>('Frame', [[true, 'Raised on top', 'hides every sheet’s edge'], [false, 'Flat at the back']], () => art.frame !== false,
      (v) => { art.frame = v; save(); rebuildSoon(); x.draw(); });
    if (!P) return [frameCh, h('div', { class: 'gok' }, h('b', {}, 'No Pop yet'), h('p', {}, 'The stack is the Hero on its own. Add a Pop to layer a second design through it.'),
      h('button', { class: 'btn small', onclick: () => x.go('pop') }, 'Add a Pop'))];
    const nH = H.plan.length, slots = [...slotsOf(nH, art.place).slots, ...(art.frame === false ? [] : [{ pops: [], frame: true }])];
    const move = (j: number, d: 1 | -1) => { art.place = art.place.map((p, k) => (k === j ? nudge(p, d, nH) : p)); save(); rebuildSoon(); x.draw(); };
    const list = h('ol', { class: 'garrange', 'aria-label': 'The stack, top sheet first' });
    for (let s = slots.length - 1; s >= 0; s--) {
      const sl = slots[s], sw = h('span', { class: 'gsw' });
      if (sl.hero != null) sw.append(h('i', { style: `background:${H.plan[sl.hero]}`, title: 'Hero' }));
      for (const j of sl.pops) sw.append(h('i', { class: 'pop', style: `background:${P.plan[j]}`, title: 'Pop' }));
      if (sl.frame) sw.append(h('i', { style: `background:${H.plan[0]}`, title: 'Frame' }));
      const name = sl.frame ? 'Frame (the Hero’s outer edge)' : [sl.hero != null ? `Hero ${sl.hero + 1}` : '', ...sl.pops.map((j) => `Pop ${j + 1}`)].filter(Boolean).join(' + ');
      const ctl = h('span', { class: 'gmove' });
      for (const j of sl.pops) ctl.append(h('span', { class: 'gmv' }, sl.hero != null || sl.pops.length > 1 ? h('small', {}, `Pop ${j + 1}`) : null,
        h('button', { class: 'btn small', 'aria-label': `Move Pop ${j + 1} up`, onclick: () => move(j, 1) }, '▲'),
        h('button', { class: 'btn small', 'aria-label': `Move Pop ${j + 1} down`, onclick: () => move(j, -1) }, '▼')));
      list.append(h('li', { class: sl.hero == null ? 'popsheet' : sl.pops.length ? 'merged' : '' }, h('b', {}, String(s + 1)), sw, h('span', { class: 'gname' }, name), ctl));
    }
    const preset = (f: (a: number, b: number) => PopPlace[]) => { art.place = f(nH, P.plan.length); save(); rebuildSoon(); x.draw(); };
    return [
      frameCh,
      h('div', { class: 'gfield' }, h('div', { class: 'glab' }, 'Quick layouts'),
        h('div', { class: 'gbtns' },
          h('button', { class: 'btn small', onclick: () => preset(spreadPlace) }, 'Spread through'),
          h('button', { class: 'btn small', onclick: () => preset(mergePlace) }, 'Merge onto Hero'),
          h('button', { class: 'btn small', onclick: () => preset(topPlace) }, 'All on top'))),
      h('div', { class: 'gfield' }, h('div', { class: 'glab' }, `${slots.length} sheets, top first`), list,
        h('p', { class: 'note' }, 'Move a Pop layer with the arrows: on its own sheet, or merged onto a Hero sheet (cut as one piece, painted in two colours). A Pop shape always stands on solid material below it, so it can sit anywhere.')),
    ];
  }

  // ---------- touch up: hand tools on the Hero and Pop drawings ----------
  type Tool = 'brush' | 'circle' | 'rect' | 'erase' | 'fill';
  const ed = {
    on: false, tool: 'brush' as Tool, size: 24, target: { which: 'hero' as Which, k: 0 },
    w: 0, h: 0, L: { hero: null as Int8Array | null, pop: null as Int8Array | null }, undo: [] as { hero: Int8Array; pop: Int8Array | null }[], dirty: false,
    host: null as HTMLElement | null, cv: null as HTMLCanvasElement | null,
  };
  function drawEditor() {
    const H = shot('hero'); if (!ed.cv || !H || !ed.L.hero) return;
    const P = hasPop() ? shot('pop') : null;
    const c = compose(ed.w, ed.h, ed.L.hero, H.plan, P ? ed.L.pop : null, P?.plan ?? [], art.place, false);
    ed.cv.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(c.colour.data), ed.w, ed.h), 0, 0);
  }
  async function openEditor() {
    const H = shot('hero'); if (!H) return;
    const P = hasPop() ? shot('pop') : null;
    ed.w = H.w; ed.h = H.h;
    ed.L.hero = labelsOf(await pixels(H.src, ed.w, ed.h), ed.w * ed.h, H.plan);
    ed.L.pop = P ? labelsOf(await pixels(P.src, ed.w, ed.h), ed.w * ed.h, P.plan) : null;
    ed.undo = []; ed.dirty = false; ed.on = true;
    const vp = document.getElementById('viewport')!;
    ed.host?.remove();
    const cv = h('canvas', { class: 'geditcv', width: ed.w, height: ed.h, 'aria-label': 'Drawing area: draw on the chosen layer' }) as HTMLCanvasElement;
    ed.cv = cv; ed.host = h('div', { class: 'gedit' }, cv);
    vp.append(ed.host);
    let down = false, start: [number, number] | null = null, before: { hero: Int8Array; pop: Int8Array | null } | null = null;
    const at = (e: PointerEvent): [number, number] => { const r = cv.getBoundingClientRect(); return [((e.clientX - r.left) / r.width) * ed.w, ((e.clientY - r.top) / r.height) * ed.h]; };
    const snap = () => ({ hero: ed.L.hero!.slice(), pop: ed.L.pop ? ed.L.pop.slice() : null });
    const R = () => ed.size * ed.w / 900; // brush sizes are relative to a 900 px wide picture
    const stamp = (L: Int8Array, v: number, test: (x: number, y: number) => boolean, x0: number, y0: number, x1: number, y1: number) => {
      for (let y = Math.max(0, Math.floor(y0)); y <= Math.min(ed.h - 1, Math.ceil(y1)); y++) for (let x = Math.max(0, Math.floor(x0)); x <= Math.min(ed.w - 1, Math.ceil(x1)); x++) if (test(x, y)) L[y * ed.w + x] = v;
    };
    const dab = (x: number, y: number) => {
      const L = ed.L[ed.target.which]; if (!L) return;
      const r = R(), v = ed.tool === 'erase' ? -1 : ed.target.k, w = ed.w;
      // the move brush only changes shapes already there; it never adds material
      const inside = (X: number, Y: number) => (X - x) ** 2 + (Y - y) ** 2 <= r * r;
      stamp(L, v, ed.tool === 'fill' ? (X, Y) => inside(X, Y) && L[Y * w + X] >= 0 : inside, x - r, y - r, x + r, y + r);
    };
    let last: [number, number] | null = null, moved = false;
    cv.addEventListener('pointerdown', (e) => {
      cv.setPointerCapture(e.pointerId); down = true; const p = at(e); before = snap();
      start = p; last = p; moved = false; if (ed.tool === 'brush' || ed.tool === 'erase') { dab(p[0], p[1]); drawEditor(); }
    });
    cv.addEventListener('pointermove', (e) => {
      if (!down) return; const p = at(e);
      if (ed.tool === 'fill' && !moved) { if (Math.hypot(p[0] - start![0], p[1] - start![1]) < R() * 0.6) return; moved = true; dab(start![0], start![1]); }
      if (ed.tool === 'brush' || ed.tool === 'erase' || ed.tool === 'fill') {
        const d = Math.hypot(p[0] - last![0], p[1] - last![1]), st = Math.max(1, R() / 3);
        for (let t = st; t <= d; t += st) dab(last![0] + (p[0] - last![0]) * t / d, last![1] + (p[1] - last![1]) * t / d);
        dab(p[0], p[1]); last = p; drawEditor();
      } else if (start && before) {
        // shapes: redraw from the state before the drag
        ed.L.hero = before.hero.slice(); ed.L.pop = before.pop ? before.pop.slice() : null;
        const L = ed.L[ed.target.which]; if (!L) return;
        const [ax, ay] = start, [bx, by] = p;
        if (ed.tool === 'rect') stamp(L, ed.target.k, () => true, Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by));
        else { const cx = (ax + bx) / 2, cy = (ay + by) / 2, rx = Math.abs(bx - ax) / 2 || 1, ry = Math.abs(by - ay) / 2 || 1; stamp(L, ed.target.k, (X, Y) => ((X - cx) / rx) ** 2 + ((Y - cy) / ry) ** 2 <= 1, cx - rx, cy - ry, cx + rx, cy + ry); }
        drawEditor();
      }
    });
    const up = () => { if (!down) return; down = false;
      if (ed.tool === 'fill' && !moved && start) { fillAt(start[0], start[1]); drawEditor(); } if (before) push(before); before = null; start = null; x.draw(); };
    cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', up);
    drawEditor(); x.draw();
  }
  const push = (b: { hero: Int8Array; pop: Int8Array | null }) => { ed.undo.push(b); if (ed.undo.length > 12) ed.undo.shift(); ed.dirty = true; };
  /** fill: the element under the tap (in the chosen design) moves to the chosen layer */
  function fillAt(fx: number, fy: number) {
    const L = ed.L[ed.target.which]; if (!L) return;
    const x0 = Math.floor(fx), y0 = Math.floor(fy); if (x0 < 0 || y0 < 0 || x0 >= ed.w || y0 >= ed.h) return;
    const i0 = y0 * ed.w + x0, from = L[i0];
    if (from < 0) { api.toast(`Tap a shape of the ${ed.target.which === 'hero' ? 'Hero' : 'Pop'}`); return; }
    if (from === ed.target.k) return;
    const q = [i0]; L[i0] = ed.target.k;
    while (q.length) { const i = q.pop()!, xx = i % ed.w; for (const j of [xx > 0 ? i - 1 : -1, xx < ed.w - 1 ? i + 1 : -1, i - ed.w, i + ed.w]) if (j >= 0 && j < L.length && L[j] === from) { L[j] = ed.target.k; q.push(j); } }
  }
  async function closeEditor(apply: boolean) {
    const H = shot('hero'), P = hasPop() ? shot('pop') : null;
    if (apply && ed.dirty && H && ed.L.hero) {
      const paint = (L: Int8Array, plan: string[]) => { const rgb = plan.map(hexToRgb), d = new Uint8ClampedArray(L.length * 4); for (let i = 0; i < L.length; i++) { const c = L[i] >= 0 ? rgb[L[i]] : [255, 255, 255]; d[i * 4] = c[0]; d[i * 4 + 1] = c[1]; d[i * 4 + 2] = c[2]; d[i * 4 + 3] = 255; } return toUrl({ width: ed.w, height: ed.h, data: d }); };
      H.src = paint(ed.L.hero, H.plan);
      if (P && ed.L.pop) { P.src = paint(ed.L.pop, P.plan); P.w = ed.w; P.h = ed.h; }
    }
    ed.on = false; ed.host?.remove(); ed.host = null; ed.cv = null; ed.L.hero = ed.L.pop = null; ed.undo = [];
    if (apply && ed.dirty) { ed.dirty = false; save(); x.busy('Building the stack…'); await rebuild(); x.busy(''); }
    x.draw();
  }
  /** a layer's colour changed: repaint that design and rebuild */
  async function recolour(which: Which, k: number, hex: string) {
    const s0 = shot(which); if (!s0) return;
    const L = labelsOf(await pixels(s0.src, s0.w, s0.h), s0.w * s0.h, s0.plan);
    s0.plan = s0.plan.map((c, j) => (j === k ? hex : c));
    const rgb = s0.plan.map(hexToRgb), d = new Uint8ClampedArray(L.length * 4);
    for (let i = 0; i < L.length; i++) { const c = L[i] >= 0 ? rgb[L[i]] : [255, 255, 255]; d[i * 4] = c[0]; d[i * 4 + 1] = c[1]; d[i * 4 + 2] = c[2]; d[i * 4 + 3] = 255; }
    s0.src = toUrl({ width: s0.w, height: s0.h, data: d });
    save(); x.busy('Building the stack…'); await rebuild(); x.busy(''); x.draw();
  }
  function touchUp() {
    const H = shot('hero'); if (!H) return [h('p', { class: 'note' }, 'Make the Hero first.')];
    const P = hasPop() ? shot('pop') : null;
    const layerRow = (which: Which, plan: string[]) => {
      const row = h('div', { class: 'glayers' });
      plan.forEach((c, k) => {
        const on = ed.on && ed.target.which === which && ed.target.k === k;
        const inp = h('input', { type: 'color', value: c, 'aria-label': `Colour of ${which === 'hero' ? 'Hero' : 'Pop'} ${k + 1}` }) as HTMLInputElement;
        inp.addEventListener('change', () => void recolour(which, k, inp.value));
        row.append(h('span', { class: 'glayer' + (on ? ' on' : '') },
          ed.on ? h('button', { class: 'gpick', 'aria-pressed': on ? 'true' : 'false', title: 'Draw on this layer', onclick: () => { ed.target = { which, k }; x.draw(); } }, `${k + 1}`) : h('small', {}, `${k + 1}`),
          inp));
      });
      return h('div', { class: 'gfield' }, h('div', { class: 'glab' }, which === 'hero' ? 'Hero layers, back first' : 'Pop layers, back first'), row);
    };
    const tools: [Tool, string][] = [['brush', 'Brush'], ['circle', 'Circle'], ['rect', 'Rectangle'], ['erase', 'Eraser'], ['fill', 'Move to layer']];
    return [
      layerRow('hero', H.plan), P ? layerRow('pop', P.plan) : null,
      h('p', { class: 'note' }, 'Tap a colour to change it. Each layer is one sheet, so this recolours that sheet everywhere.'),
      ed.on ? h('div', { class: 'gfield' },
        x.chips<Tool>('Tool', tools, () => ed.tool, (v) => { ed.tool = v; x.draw(); }),
        x.chips<number>('Size', [[10, 'Fine'], [24, 'Medium'], [50, 'Bold']], () => ed.size, (v) => { ed.size = v; }),
        h('p', { class: 'note' }, ed.tool === 'fill' ? 'Tap a shape to move all of it onto the chosen layer, or brush over part of it to move just that part. It takes that layer’s colour and depth.' : `Drawing on ${ed.target.which === 'hero' ? 'Hero' : 'Pop'} ${ed.target.k + 1}. Pick a layer number above to change it. Everything you draw stands on the layers below it.`),
        h('div', { class: 'gbtns' },
          h('button', { class: 'btn primary', onclick: () => void closeEditor(true) }, 'Done'),
          h('button', { class: 'btn small', disabled: !ed.undo.length, onclick: () => { const b = ed.undo.pop(); if (b) { ed.L.hero = b.hero; ed.L.pop = b.pop; drawEditor(); x.draw(); } } }, 'Undo'),
          h('button', { class: 'btn small ghost', onclick: () => void closeEditor(false) }, 'Cancel')))
        : h('div', { class: 'gfield' }, h('button', { class: 'btn', onclick: () => void openEditor() }, 'Draw and add shapes'),
          h('p', { class: 'note' }, 'Brush, circles, rectangles, an eraser, and a tap to move any shape to another layer.')),
    ].filter((n): n is HTMLElement => !!n);
  }

  return {
    get art() { return art; },
    touchUp, editing: () => ed.on, closeEditor,
    reload() { art = valid(api.art()) ?? newArt(); },
    reset() { art = newArt(); attach.hero = []; attach.pop = []; },
    shot, hasPop, chat, arrange, rebuild,
    skipPop() { art.noPop = true; save(); void rebuild(); },
    popRamp() { if (!art.pop.chat.length) { art.pop.ramp = POP_RAMP[art.hero.ramp] ?? 'ocean'; } },
  };
}
export type Studio = ReturnType<typeof createStudio>;
