// Pay-per-use AI through Routstr: Bitcoin only (Lightning or Cashu), no account.
// The app talks straight to a public Routstr node found on Nostr; nothing goes through us.
// The node sees the prompt and the picture it is sent, and forwards them to the model.
import { store } from './guided';
import { colourName } from './cutready';

export interface AiModel { id: string; label: string; note: string }
export const MODELS: AiModel[] = [
  { id: 'gemini-3-pro-image', label: 'Nano Banana Pro', note: 'best detail' },
  { id: 'gemini-3.1-flash-image', label: 'Nano Banana 2', note: 'cheaper, faster' },
];
/** The model that redraws pictures in flat colours: Nano Banana Pro gave by far the cleanest bands and lettering. */
export const FLAT_MODEL = 'gemini-3-pro-image';

/** Image models newer than the ones above that a node lists (e.g. a later Gemini pro image); offered to try, never picked silently. */
const newer = new Map<string, AiModel>();
const NEWER = /^(?:google\/)?gemini-(\d+(?:\.\d+)?)-pro-image(?:-preview)?$/;
function noteNewer(id: string) {
  const m = id.match(NEWER);
  if (!m || +m[1] <= 3 || MODELS.some((x) => x.id === id)) return;
  newer.set(id, { id, label: `Gemini ${m[1]} Pro Image`, note: 'newer, untested' });
}
export const newerModels = () => [...newer.values()];

const RELAYS = ['wss://relay.routstr.com', 'wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net'];
// used if the relays can't be reached; each one is still checked live before use
const BOOTSTRAP = ['https://routstr.nostrnative.com', 'https://ai.redsh1ft.com', 'https://api.nonkycai.com', 'https://routstr1.purpleprometheus.com', 'https://routstr.otrta.me', 'https://llm.satsandsports.cash'];

export interface NodeOffer { url: string; name: string; maxSats: number }
export interface Session { node: string; name: string; key: string; created: number }
const LS_SESSION = 'lc.ai.session';

const clean = (u: string) => u.trim().replace(/\/+$/, '');
const okUrl = (u: string) => {
  try {
    const x = new URL(u);
    return x.protocol === 'https:' && !/\.onion$|^localhost$|^127\.|^10\.|^192\.168\.|^\d+\.\d+\.\d+\.\d+$/.test(x.hostname) && !x.port;
  } catch { return false; }
};

async function timed(url: string, init: RequestInit = {}, ms = 9000): Promise<Response> {
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), ms);
  try { return await fetch(url, { ...init, signal: ac.signal }); } finally { clearTimeout(t); }
}

/** Routstr nodes announced on Nostr (kind 38421), newest first. */
export function nostrNodes(wait = 4500): Promise<{ url: string; name: string }[]> {
  const found = new Map<string, { url: string; name: string; at: number }>();
  return new Promise((done) => {
    let open = RELAYS.length;
    const finish = () => done([...found.values()].sort((a, b) => b.at - a.at).map(({ url, name }) => ({ url, name })));
    const timer = setTimeout(finish, wait);
    for (const r of RELAYS) {
      let ws: WebSocket;
      const end = () => { try { ws.close(); } catch { /* closed */ } if (--open === 0) { clearTimeout(timer); finish(); } };
      try { ws = new WebSocket(r); } catch { if (--open === 0) { clearTimeout(timer); finish(); } continue; }
      ws.onopen = () => ws.send(JSON.stringify(['REQ', 'lc', { kinds: [38421], limit: 150 }]));
      ws.onerror = end;
      ws.onmessage = (m) => {
        try {
          const d = JSON.parse(String(m.data));
          if (d[0] === 'EOSE') return end();
          if (d[0] !== 'EVENT') return;
          const e = d[2]; let name = '';
          try { name = JSON.parse(e.content)?.name ?? ''; } catch { /* no metadata */ }
          for (const t of e.tags as string[][]) if (t[0] === 'u' && okUrl(t[1])) {
            const u = clean(t[1]), prev = found.get(u);
            if (!prev || prev.at < e.created_at) found.set(u, { url: u, name: String(name).slice(0, 60), at: e.created_at });
          }
        } catch { /* ignore bad events */ }
      };
    }
  });
}

const offersCache = new Map<string, { at: number; offers: NodeOffer[] }>();
/** Live nodes that offer the model, cheapest first. */
export async function findOffers(model: string): Promise<NodeOffer[]> {
  const hit = offersCache.get(model);
  if (hit && Date.now() - hit.at < 10 * 60e3) return hit.offers;
  const announced = await nostrNodes();
  const names = new Map(announced.map((n) => [n.url, n.name]));
  const urls = [...new Set([...announced.map((n) => n.url), ...BOOTSTRAP])].slice(0, 30);
  const offers: NodeOffer[] = [];
  await Promise.all(urls.map(async (u) => {
    try {
      const r = await timed(`${u}/v1/models`, {}, 7000);
      if (!r.ok) return;
      const j = await r.json();
      const list = (j.data ?? j) as any[];
      for (const x of list) if (x?.enabled !== false && typeof x?.id === 'string') noteNewer(x.id);
      const m = list.find((x: any) => x?.id === model && x.enabled !== false);
      const max = Number(m?.sats_pricing?.max_cost);
      if (m && isFinite(max) && max > 0) offers.push({ url: u, name: names.get(u) || new URL(u).hostname, maxSats: Math.ceil(max) });
    } catch { /* node offline or blocked */ }
  }));
  offers.sort((a, b) => a.maxSats - b.maxSats);
  offersCache.set(model, { at: Date.now(), offers });
  return offers;
}

// ---------------- session (kept until End / Refund) ----------------
export function getSession(): Session | null {
  try { const s = JSON.parse(store.get(LS_SESSION) || 'null'); return s && s.node && /^sk-/.test(s.key) ? s : null; } catch { return null; }
}
export function setSession(s: Session | null) { store.set(LS_SESSION, s ? JSON.stringify(s) : ''); }
/** A short text the user can keep to restore the session elsewhere. */
export const sessionCode = (s: Session) => `${s.node}#${s.key}`;
export function parseSessionCode(t: string): Session | null {
  const m = t.trim().match(/^(https:\/\/[^\s#]+)#(sk-[A-Za-z0-9_-]+)$/);
  return m && okUrl(m[1]) ? { node: clean(m[1]), name: new URL(m[1]).hostname, key: m[2], created: Date.now() } : null;
}

async function json(r: Response) {
  const t = await r.text(); let j: any = null; try { j = JSON.parse(t); } catch { /* not json */ }
  if (!r.ok) {
    const d = j?.detail ?? j?.error?.message ?? j?.error ?? j?.message ?? t;
    const msg = typeof d === 'string' ? d : JSON.stringify(d);
    const e = new Error(msg.slice(0, 240) || `HTTP ${r.status}`) as Error & { status: number }; e.status = r.status; throw e;
  }
  return j;
}

export interface Invoice { invoice_id: string; bolt11: string; amount_sats: number; expires_at: number }
export async function createInvoice(node: string, sats: number, topupKey?: string): Promise<Invoice> {
  return json(await timed(`${node}/lightning/invoice`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(topupKey ? { authorization: `Bearer ${topupKey}` } : {}) },
    body: JSON.stringify({ amount_sats: sats, purpose: topupKey ? 'topup' : 'create' }),
  }));
}
export async function invoiceStatus(node: string, id: string): Promise<{ status: string; api_key: string | null }> {
  return json(await timed(`${node}/lightning/invoice/${encodeURIComponent(id)}/status`, {}, 8000));
}
export async function redeemCashu(node: string, token: string): Promise<string> {
  const t = token.replace(/\s+/g, '');
  if (!/^cashu[AB]/.test(t)) throw new Error('That does not look like a Cashu token (it starts with cashuA or cashuB)');
  const j = await json(await timed(`${node}/v1/balance/create`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ initial_balance_token: t }) }, 20000));
  if (!/^sk-/.test(j?.api_key)) throw new Error('The node did not return a session');
  return j.api_key;
}
export async function topupCashu(s: Session, token: string) {
  return json(await timed(`${s.node}/v1/balance/topup`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${s.key}` }, body: JSON.stringify({ cashu_token: token.replace(/\s+/g, '') }) }, 20000));
}
/** Credit left, in sats. */
export async function balance(s: Session): Promise<{ sats: number; reserved: number; spent: number }> {
  const j = await json(await timed(`${s.node}/v1/balance/info`, { headers: { authorization: `Bearer ${s.key}` } }));
  return { sats: Math.floor((j.balance ?? 0) / 1000), reserved: Math.floor((j.reserved ?? 0) / 1000), spent: Math.floor((j.total_spent ?? 0) / 1000) };
}
/** Return what's left: to a Lightning address, or as a Cashu token to paste into a wallet. */
export async function refund(s: Session, lightningAddress?: string): Promise<{ token?: string; recipient?: string; sats?: string; status?: string }> {
  const body = lightningAddress ? JSON.stringify({ lightning_address: lightningAddress.trim() }) : undefined;
  return json(await timed(`${s.node}/v1/balance/refund`, { method: 'POST', headers: { authorization: `Bearer ${s.key}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body }, 45000));
}

/** One picture from a prompt, optionally with a reference picture. Returns a data URL. */
export async function generateImage(s: Session, model: string, prompt: string, ref?: string | string[], aspect = '3:4'): Promise<string> {
  const content: any[] = [{ type: 'text', text: prompt }];
  for (const r of (Array.isArray(ref) ? ref : ref ? [ref] : [])) content.push({ type: 'image_url', image_url: { url: r } });
  const j = await json(await timed(`${s.node}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${s.key}` },
    body: JSON.stringify({ model, messages: [{ role: 'user', content }], modalities: ['image', 'text'], image_config: { aspect_ratio: aspect }, stream: false }),
  }, 180000));
  const msg = j?.choices?.[0]?.message;
  const img = msg?.images?.[0]?.image_url?.url ?? msg?.images?.[0]?.url
    ?? (Array.isArray(msg?.content) ? msg.content.find((c: any) => c?.type === 'image_url')?.image_url?.url : null)
    ?? (j?.data?.[0]?.b64_json ? `data:image/png;base64,${j.data[0].b64_json}` : null);
  if (typeof img !== 'string' || !/^data:image\/|^https:\/\//.test(img)) {
    const said = typeof msg?.content === 'string' ? msg.content.slice(0, 160) : '';
    throw new Error(said ? `No picture came back. The model said: ${said}` : 'No picture came back. Try again or rephrase.');
  }
  return img;
}

// ---------------- prices ----------------
let usdCache: { at: number; usd: number } | null = null;
/** US dollars per bitcoin, from free public APIs (mempool.space, then CoinGecko). */
export async function btcUsd(): Promise<number | null> {
  if (usdCache && Date.now() - usdCache.at < 10 * 60e3) return usdCache.usd;
  const tries: [string, (j: any) => number][] = [
    ['https://mempool.space/api/v1/prices', (j) => j.USD],
    ['https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd', (j) => j.bitcoin.usd],
  ];
  for (const [u, pick] of tries) {
    try { const v = Number(pick(await (await timed(u, {}, 6000)).json())); if (v > 0) { usdCache = { at: Date.now(), usd: v }; return v; } } catch { /* next */ }
  }
  return null;
}
export const fmtSats = (n: number) => `${Math.round(n).toLocaleString('en-GB')} sats`;
export function fmtUsd(sats: number, usd: number | null) {
  if (!usd) return '';
  const d = (sats / 1e8) * usd;
  return d < 0.995 ? `$${d.toFixed(2)}` : `$${d.toFixed(d < 10 ? 2 : 0)}`;
}

/** Shrink a picture before sending it (JPEG, longest side 1024 px). */
export async function shrinkForUpload(src: string, long = 1024): Promise<string> {
  const im = await new Promise<HTMLImageElement>((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('Could not read the picture')); i.src = src; });
  const k = Math.min(1, long / Math.max(im.naturalWidth, im.naturalHeight));
  const c = document.createElement('canvas'); c.width = Math.round(im.naturalWidth * k); c.height = Math.round(im.naturalHeight * k);
  const x = c.getContext('2d')!; x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height); x.drawImage(im, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.9);
}

export interface IdeaOpts { levels: number; layers: number; colours?: string; plan?: string[] | null } // colours: '' = a gradient that suits the design; plan: the exact colours, back sheet first
/** The prompt for "Describe an idea": the user's own description, built up as stacked cut sheets. */
export const IDEA_PROMPT = (idea: string, o: IdeaOpts) => {
  const d = idea.trim().replace(/\s+/g, ' ').replace(/[.\s]*$/, '');
  const quoted = /["“”'‘’«»「」]/.test(d);
  const n = Math.max(2, Math.round(o.levels));
  const own = (o.colours ?? '').trim();
  return [
    'Create artwork for a layered laser-cut wooden piece: flat shapes cut from stacked sheets of wood.',
    `The design: ${d}.`,
    'Straight-on front view. One bold design, centred and filling the frame, on a plain flat white background.',
    `Build it as exactly ${n} depth levels, from the back sheet to the top sheet. Each level is one flat colour and is cut as its own sheet. The back level is one solid shape that frames the whole design with an even margin. Each level above it is a clear, solid shape that sits on the level behind; larger shapes further back, finer details on top.`,
    o.plan?.length
      ? `Colours: use exactly these ${o.plan.length} flat colours and no others, one per level, from the back level to the top level: ${o.plan.map((c, k) => `${k + 1} ${c} (${colourName(c)})`).join(', ')}. Match the codes as closely as you can; the background stays pure white #ffffff and is not one of the levels.`
      : own
      ? `Colours: ${own}. Use exactly ${n} flat colours in total, one per level${n > 3 ? '; where there are more levels than colours named, use clearly distinct in-between shades' : ''}.`
      : `Colours: a smooth gradient of ${n} clearly distinct flat tones, darkest at the back and lightest on top, in hues that suit the design.`,
    'No shading, gradients within a shape, texture, glow, shadows, reflections or 3D effects: every level is one flat colour.',
    'Every edge is a crisp, smooth curve or clean straight line, with no specks, noise or jagged edges. Neighbouring colours touch directly; do not outline colour areas with thin lines.',
    'The smallest detail, gap or line is at least 1/150 of the picture width, so a laser can cut it.',
    quoted ? 'Lettering in quotes is spelled exactly as written, in a bold style; letters either overlap solidly or have clear gaps between them.' : 'No text or lettering unless the design asks for it.',
    'No extra elements, watermark or signature.',
  ].join(' ');
};

const colourLine = (plan: string[]) => `Use exactly these ${plan.length} flat colours and no others, one per level, from the back level to the top level: ${plan.map((c, k) => `${k + 1} ${c} (${colourName(c)})`).join(', ')}. Match the codes as closely as you can; the background stays pure white #ffffff and is not one of the levels.`;
const FLAT_RULES = [
  'No shading, gradients within a shape, texture, glow, shadows, reflections or 3D effects: every level is one flat colour.',
  'Every edge is a crisp, smooth curve or clean straight line, with no specks, noise or jagged edges. Neighbouring colours touch directly; do not outline colour areas with thin lines.',
  'The smallest detail, gap or line is at least 1/150 of the picture width, so a laser can cut it.',
  'No extra elements, watermark or signature.',
].join(' ');
const tidy = (t: string) => t.trim().replace(/\s+/g, ' ').replace(/[.\s]*$/, '');

/** The Hero: a first drawing from the chat, optionally from an attached reference picture. */
export const HERO_PROMPT = (idea: string, plan: string[], layers: number, withRef: boolean) => [
  IDEA_PROMPT(idea, { levels: plan.length, layers, plan }),
  withRef ? 'The attached picture is a reference from the user: follow its subject, silhouette and composition, redrawn in the flat levels and colours above.' : '',
].filter(Boolean).join(' ');

/** Change the current Hero drawing (the first attached picture) as the user asks. */
export const HERO_REFINE_PROMPT = (change: string, plan: string[], withRef: boolean) => [
  'The first attached picture is artwork for a layered laser-cut wooden piece: flat shapes cut from stacked sheets, one flat colour per sheet.',
  `Redraw it with this change: ${tidy(change)}.`,
  'Keep everything else the same: the composition, framing, size and position of every shape, and the plain white background.',
  `Use exactly ${plan.length} depth levels. ${colourLine(plan)}`,
  withRef ? 'The second attached picture is a reference from the user for the change.' : '',
  FLAT_RULES,
].filter(Boolean).join(' ');

/** The Pop: a complementary design drawn to line up with the Hero (the first attached picture). */
export const POP_PROMPT = (idea: string, plan: string[], withRef: boolean) => [
  'The first attached picture is the main design (the Hero) of a layered laser-cut wooden piece.',
  `Draw a second, complementary design (the Pop) that will be cut on its own sheets and stacked together with the Hero: ${tidy(idea)}.`,
  'Use exactly the same canvas, framing and scale as the Hero so the two line up when stacked; place the Pop where it complements the Hero (around it, behind it or across it), but draw only the Pop: do not redraw the Hero.',
  'Everything that is not part of the Pop is pure white #ffffff.',
  `Build the Pop as exactly ${plan.length} depth levels, from its back to its top; larger shapes further back, finer details on top, each level sitting on the one behind. ${colourLine(plan)}`,
  withRef ? 'The second attached picture is a reference from the user for the Pop.' : '',
  FLAT_RULES,
].filter(Boolean).join(' ');

/** Change the current Pop (first attached picture); the Hero (second) is only for alignment. */
export const POP_REFINE_PROMPT = (change: string, plan: string[], withRef: boolean) => [
  'The first attached picture is the Pop: a complementary design for a layered laser-cut wooden piece, drawn to line up with the main design (the second attached picture).',
  `Redraw the Pop with this change: ${tidy(change)}.`,
  'Keep the same canvas and framing as before and draw only the Pop, never the main design; everything else is pure white #ffffff.',
  `Use exactly ${plan.length} depth levels. ${colourLine(plan)}`,
  withRef ? 'The third attached picture is a reference from the user for the change.' : '',
  FLAT_RULES,
].filter(Boolean).join(' ');

// ---------------- picture check (a cheap vision model reads the picture) ----------------
/** Vision models to try, cheapest good one first. */
export const VISION_MODELS = ['gpt-4o-mini', 'gemini-2.5-flash-lite', 'gemma-3-27b-it', 'gpt-4.1-mini'];
export interface PictureCheck {
  kind: string;                 // e.g. "flat digital art", "photo of a layered piece"
  photo: boolean;               // shading, lighting or texture from a camera
  background: string | null;    // #rrggbb, or null if the artwork fills the picture
  plainBackground: boolean;
  inks: { hex: string; name: string; role: string }[]; // the artwork's flat colours, outermost first
  stack: string[];              // the same inks from the top (nearest the viewer) to the back
  text: string;                 // any lettering, exactly as written
  textLines?: string[];         // the lettering line by line, top to bottom
  font: string;                 // closest well-known typeface for the lettering
  shapes: string;               // one sentence on the overall shapes
  palette?: string[];           // exact colours to trace with (a cleaned, cut-ready design), background included
}
export const CHECK_PROMPT = `You are preparing a picture for multi-layer laser cutting, where every flat colour becomes one cut sheet. Look at the overall shapes, not pixel noise: ignore shading, lighting, shadows between layers, paper or wood texture and camera blur - they are not colours. Reply with JSON only, no prose, in exactly this shape:
{"kind": "short description, e.g. flat digital art / photo of a layered piece / photo / drawing",
 "photo": true or false (true if it is a camera photo with lighting or shading),
 "background": "#rrggbb of the plain background around the artwork, or null if the artwork fills the picture",
 "plainBackground": true or false,
 "inks": [{"hex": "#rrggbb", "name": "plain colour name", "role": "outline | band | shape | text | detail"}],
 "stack": ["#rrggbb", ...],
 "text": "any lettering exactly as written, or empty",
 "textLines": ["each line of the lettering, top to bottom, exactly as written"],
 "font": "closest well-known typeface for the lettering, e.g. Cooper Black; add the word italic if the letters slant; or empty",
 "shapes": "one sentence on the overall shapes, e.g. concentric rounded bands around three lines of bold text"}
Rules: inks are the distinct flat paint or material colours of the artwork only (not the background, not shadows), listed from the outermost to the innermost; if the background colour is reused inside the artwork (for example white letters on a white background) include it as an ink too. Give each ink its true clean colour as printed, not the shaded colour in the photo. stack lists the same hex values from the layer nearest the viewer (raised highest) to the back layer, as the piece would be built from stacked sheets. Never more than 12 inks.`;

/** Which vision model this node offers, and its most it can cost. */
export async function visionOffer(node: string): Promise<{ model: string; maxSats: number } | null> {
  try {
    const j = await (await timed(`${node}/v1/models`, {}, 8000)).json();
    const list = (j.data ?? j) as any[];
    for (const id of VISION_MODELS) {
      const m = list.find((x) => x?.id === id && x.enabled !== false);
      const max = Number(m?.sats_pricing?.max_cost);
      if (m && isFinite(max) && max > 0) return { model: id, maxSats: Math.ceil(max) };
    }
  } catch { /* offline */ }
  return null;
}

const HEX = /^#[0-9a-f]{6}$/i;
/** Ask the vision model about the picture. */
export async function checkPicture(s: Session, model: string, img: string): Promise<PictureCheck> {
  const j = await json(await timed(`${s.node}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${s.key}` },
    body: JSON.stringify({ model, temperature: 0, max_tokens: 900, stream: false,
      messages: [{ role: 'user', content: [{ type: 'text', text: CHECK_PROMPT }, { type: 'image_url', image_url: { url: img } }] }] }),
  }, 90000));
  const c = j?.choices?.[0]?.message?.content;
  const t = typeof c === 'string' ? c : Array.isArray(c) ? c.map((x: any) => x?.text ?? '').join('') : '';
  const m = t.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('The AI did not describe the picture. Try again.');
  let r: any; try { r = JSON.parse(m[0]); } catch { throw new Error('The AI reply could not be read. Try again.'); }
  const inks = (Array.isArray(r.inks) ? r.inks : []).filter((k: any) => HEX.test(k?.hex)).slice(0, 12)
    .map((k: any) => ({ hex: String(k.hex).toLowerCase(), name: String(k.name ?? '').slice(0, 30), role: String(k.role ?? '').slice(0, 20) }));
  if (inks.length < 2) throw new Error('The AI found fewer than two colours. Try again.');
  const stack = (Array.isArray(r.stack) ? r.stack : []).map((x: any) => String(x).toLowerCase()).filter((x: string) => HEX.test(x));
  return {
    kind: String(r.kind ?? '').slice(0, 80), photo: !!r.photo,
    background: HEX.test(r.background) ? String(r.background).toLowerCase() : null, plainBackground: !!r.plainBackground,
    inks, stack: stack.length ? stack : inks.map((k: any) => k.hex),
    text: String(r.text ?? '').slice(0, 200), textLines: Array.isArray(r.textLines) ? r.textLines.map((x: any) => String(x).slice(0, 80)).filter(Boolean).slice(0, 8) : undefined, font: String(r.font ?? '').slice(0, 60), shapes: String(r.shapes ?? '').slice(0, 200),
  };
}
