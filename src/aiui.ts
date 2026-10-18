// The AI credit sheet: pay with Lightning (QR) or Cashu, see what's left, top up, end and refund.
import QRCode from 'qrcode';
import {
  MODELS, NodeOffer, Session, balance, btcUsd, createInvoice, findOffers, fmtSats, fmtUsd, generateImage, getSession,
  invoiceStatus, parseSessionCode, redeemCashu, refund, sessionCode, setSession, shrinkForUpload, topupCashu,
} from './ai';
import { store } from './guided';
import { hasSigner, pullSession, pushSession } from './nostrsync';

type H = (tag: string, attrs?: Record<string, any>, ...kids: (Node | string | null | undefined)[]) => HTMLElement;
const AMOUNTS = [1000, 2500, 5000];
const ASPECTS: [string, number][] = [['1:1', 1], ['2:3', 2 / 3], ['3:2', 1.5], ['3:4', 0.75], ['4:3', 4 / 3], ['4:5', 0.8], ['5:4', 1.25], ['9:16', 9 / 16], ['16:9', 16 / 9]];
export const nearestAspect = (w: number, h: number) => ASPECTS.reduce((b, a) => (Math.abs(Math.log(a[1] / (w / h))) < Math.abs(Math.log(b[1] / (w / h))) ? a : b))[0];

export function createAiUi(h: H, toast: (m: string) => void) {
  let usd: number | null = null;
  let credit: number | null = null;
  let offers: NodeOffer[] = [];
  let offer: NodeOffer | null = null;
  let model = MODELS.some((m) => m.id === store.get('lc.ai.model')) ? store.get('lc.ai.model')! : MODELS[0].id;
  let amount = AMOUNTS[0];
  let poll = 0;
  let afterPay: (() => void) | null = null;
  const listeners = new Set<() => void>();
  const changed = () => { drawBadge(); listeners.forEach((f) => f()); };

  const badge = h('button', { class: 'btn ghost aibadge', hidden: true, title: 'AI credit', onclick: () => open() });
  const drawBadge = () => {
    const s = getSession();
    badge.hidden = !s;
    badge.textContent = s ? (credit == null ? 'AI credit' : `${fmtSats(credit)}`) : '';
    badge.setAttribute('aria-label', credit == null ? 'AI credit' : `AI credit: ${fmtSats(credit)}`);
  };

  const dlg = h('dialog', { class: 'aisheet', 'aria-label': 'AI credit' }) as HTMLDialogElement;
  dlg.addEventListener('close', () => { clearInterval(poll); });
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
  document.body.append(dlg);
  const body = h('div', { class: 'aibody' });
  dlg.append(h('div', { class: 'aihead' }, h('b', {}, 'AI credit'), h('button', { class: 'gpdel', 'aria-label': 'Close', onclick: () => dlg.close() }, '×')), body);

  const privacy = () => h('p', { class: 'note aipriv' },
    'Bitcoin only, no account. You pay a public Routstr node directly; it sees your prompt and the picture you send, and forwards them to the model. Layercraft never sees your payment or your key.');
  const usdOf = (sats: number) => { const t = fmtUsd(sats, usd); return t ? ` · ${t}` : ''; };

  async function refreshCredit() {
    const s = getSession();
    if (!s) { credit = null; changed(); return; }
    try { credit = (await balance(s)).sats; } catch (e: any) { if (e?.status === 401) { credit = null; toast('That AI session is no longer valid on its node'); } }
    changed();
  }

  async function loadOffers() {
    offers = await findOffers(model);
    offer = offers.find((o) => o.url === store.get('lc.ai.node')) ?? offers[0] ?? null;
    if (offer && amount < offer.maxSats * 1.2) amount = AMOUNTS.find((a) => a >= offer!.maxSats * 1.2) ?? AMOUNTS[AMOUNTS.length - 1];
  }

  function chipRow(items: [string, string, string?, boolean?][], cur: string, set: (v: string) => void) {
    const row = h('div', { class: 'gchips', role: 'radiogroup' });
    for (const [v, name, sub, off] of items) row.append(h('button', { class: 'gchip' + (v === cur ? ' on' : ''), role: 'radio', 'aria-checked': v === cur ? 'true' : 'false', disabled: off ? true : undefined, onclick: () => set(v) }, h('b', {}, name), sub ? h('small', {}, sub) : null));
    return row;
  }

  // ---------- views ----------
  async function viewBuy(topup = false) {
    clearInterval(poll);
    body.innerHTML = '';
    body.append(h('p', { class: 'aistate' }, 'Finding AI nodes on Nostr…'));
    usd = await btcUsd();
    if (!topup) await loadOffers();
    body.innerHTML = '';
    const s = getSession();
    if (!topup) {
      body.append(h('p', { class: 'glead' }, 'Pay as you go with Bitcoin. Add a little credit, use it for AI pictures, and get back what you don\'t use.'));
      body.append(h('div', { class: 'glab' }, 'Model'), chipRow(MODELS.map((m) => [m.id, m.label, m.note]), model, (v) => { model = v; store.set('lc.ai.model', v); void viewBuy(); }));
      if (!offer) {
        body.append(h('p', { class: 'aistate warn' }, 'No node offering this model answered just now. Try again in a minute, or choose the other model.'),
          h('button', { class: 'btn', onclick: () => { void viewBuy(); } }, 'Try again'), privacy());
        return;
      }
      const sel = h('select', { class: 'aisel', 'aria-label': 'Node', onchange: (e: Event) => { offer = offers.find((o) => o.url === (e.target as HTMLSelectElement).value) ?? offer; store.set('lc.ai.node', offer!.url); void viewBuy(); } },
        ...offers.slice(0, 12).map((o) => h('option', { value: o.url, selected: o === offer ? true : undefined }, `${o.name} — up to ${fmtSats(o.maxSats)}`)));
      body.append(h('div', { class: 'glab' }, 'Node (cheapest first)'), sel,
        h('p', { class: 'note' }, `Each picture holds up to ${fmtSats(offer.maxSats)}${usdOf(offer.maxSats)} while it is made, then only the actual cost is taken. Usually much less.`));
    } else {
      body.append(h('p', { class: 'glead' }, `Top up your credit on ${s?.name ?? 'this node'}.`));
    }
    body.append(h('div', { class: 'glab' }, 'Amount'), chipRow(AMOUNTS.map((a) => [String(a), fmtSats(a), fmtUsd(a, usd) || undefined, !topup && !!offer && a < offer.maxSats * 1.05]), String(amount), (v) => { amount = Number(v); void viewBuy(topup); }));
    const node = topup ? s!.node : offer!.url;
    body.append(h('div', { class: 'gbtns' },
      h('button', { class: 'btn primary', onclick: () => void viewLightning(node, amount, topup ? s!.key : undefined) }, 'Pay with Lightning'),
      h('button', { class: 'btn', onclick: () => viewCashu(node, topup) }, 'Pay with Cashu')));
    if (!topup) {
      const restore = h('details', { class: 'gmore' }, h('summary', {}, 'Restore a saved session'));
      const inp = h('input', { class: 'aiinp', placeholder: 'https://node…#sk-…', 'aria-label': 'Session code' }) as HTMLInputElement;
      restore.append(inp, h('button', { class: 'btn small', onclick: async () => {
        const ss = parseSessionCode(inp.value); if (!ss) { toast('That is not a session code'); return; }
        try { await balance(ss); setSession(ss); await refreshCredit(); viewSession(); toast('Session restored'); } catch { toast('That session was not found on its node'); }
      } }, 'Restore'));
      if (hasSigner()) restore.append(h('button', { class: 'btn small ghost', onclick: async () => {
        try {
          const ss = await pullSession<Session>();
          if (!ss || !ss.node || !/^sk-/.test(ss.key)) { toast('No saved session found on Nostr'); return; }
          await balance(ss); setSession(ss); store.set('lc.ai.synced', '1'); await refreshCredit(); viewSession(); toast('Session restored from Nostr');
        } catch (e: any) { toast(e?.status ? 'That session has ended on its node' : `Nostr: ${e.message}`); }
      } }, 'Restore from Nostr'));
      body.append(restore);
    } else body.append(h('button', { class: 'btn small ghost', onclick: () => viewSession() }, 'Back'));
    body.append(privacy());
  }

  async function viewLightning(node: string, sats: number, topupKey?: string) {
    body.innerHTML = '';
    body.append(h('p', { class: 'aistate' }, 'Asking the node for an invoice…'));
    let inv;
    try { inv = await createInvoice(node, sats, topupKey); } catch (e: any) { body.innerHTML = ''; body.append(h('p', { class: 'aistate warn' }, `The node could not make an invoice: ${e.message}`), h('button', { class: 'btn', onclick: () => void viewBuy(!!topupKey) }, 'Back')); return; }
    const uri = `lightning:${inv.bolt11.toUpperCase()}`;
    const cv = h('canvas', { class: 'aiqr', 'aria-label': 'Lightning invoice QR code' }) as HTMLCanvasElement;
    try { await QRCode.toCanvas(cv, uri, { margin: 2, width: 260, errorCorrectionLevel: 'M', color: { dark: '#000000', light: '#ffffff' } }); } catch { /* text fallback below */ }
    const st = h('p', { class: 'aistate' }, 'Waiting for payment…');
    body.innerHTML = '';
    body.append(h('p', { class: 'glead' }, `Scan with any Lightning wallet to pay ${fmtSats(inv.amount_sats)}${usdOf(inv.amount_sats)}.`), cv,
      h('div', { class: 'gbtns' },
        h('a', { class: 'btn primary', href: uri }, 'Open wallet'),
        h('button', { class: 'btn', onclick: async () => { try { await navigator.clipboard.writeText(inv!.bolt11); toast('Invoice copied'); } catch { toast('Copy blocked here'); } } }, 'Copy invoice')),
      st, h('button', { class: 'btn small ghost', onclick: () => { clearInterval(poll); void viewBuy(!!topupKey); } }, 'Cancel'), privacy());
    clearInterval(poll);
    let busy = false;
    poll = window.setInterval(async () => {
      if (busy) return; busy = true;
      try {
        const left = inv!.expires_at - Date.now() / 1000;
        if (left <= 0) { clearInterval(poll); st.textContent = 'This invoice expired. Make a new one.'; return; }
        const r = await invoiceStatus(node, inv!.invoice_id);
        st.textContent = `Waiting for payment… expires in ${Math.floor(left / 60)}:${String(Math.floor(left % 60)).padStart(2, '0')}`;
        if (r.status === 'paid') {
          clearInterval(poll);
          if (!topupKey) {
            if (!r.api_key) { st.textContent = 'Paid. Waiting for the node to open your session…'; return; }
            setSession({ node, name: offer?.name ?? new URL(node).hostname, key: r.api_key, created: Date.now() });
          }
          await refreshCredit(); toast('Payment received'); paid();
        }
      } catch { /* keep polling */ } finally { busy = false; }
    }, 2500);
  }

  function viewCashu(node: string, topup: boolean) {
    clearInterval(poll);
    body.innerHTML = '';
    const ta = h('textarea', { class: 'aiinp', rows: 5, placeholder: 'cashuB…', 'aria-label': 'Cashu token' }) as HTMLTextAreaElement;
    const st = h('p', { class: 'aistate' });
    body.append(h('p', { class: 'glead' }, 'Send a Cashu token from your wallet (Minibits, Cashu.me, Macadamia…) and paste it here.'), ta,
      h('div', { class: 'gbtns' },
        h('button', { class: 'btn primary', onclick: async () => {
          st.textContent = 'Adding credit…';
          try {
            const s = getSession();
            if (topup && s) await topupCashu(s, ta.value);
            else setSession({ node, name: offer?.name ?? new URL(node).hostname, key: await redeemCashu(node, ta.value), created: Date.now() });
            await refreshCredit(); toast('Credit added'); paid();
          } catch (e: any) { st.textContent = e?.status ? `Not accepted: ${e.message}. The node may not take tokens from that mint.` : e.message; }
        } }, 'Add credit'),
        h('button', { class: 'btn small ghost', onclick: () => void viewBuy(topup) }, 'Back')),
      st, privacy());
  }

  function paid() {
    const go = afterPay; afterPay = null;
    if (go) { dlg.close(); go(); } else viewSession();
  }

  function viewSession() {
    clearInterval(poll);
    const s = getSession();
    if (!s) { void viewBuy(); return; }
    body.innerHTML = '';
    const amt = credit ?? 0;
    body.append(
      h('div', { class: 'aicredit' }, h('b', {}, credit == null ? '…' : fmtSats(amt)), h('small', {}, fmtUsd(amt, usd) || ''), h('span', {}, `on ${s.name}`)),
      h('p', { class: 'note' }, 'Your credit stays here, even after you close the tab, until you end the session.'),
      h('div', { class: 'gbtns' },
        h('button', { class: 'btn', onclick: () => void viewBuy(true) }, 'Top up'),
        h('button', { class: 'btn', onclick: async () => { try { await navigator.clipboard.writeText(sessionCode(s)); toast('Session code copied. Anyone with it can spend this credit.'); } catch { toast('Copy blocked here'); } } }, 'Save session code')),
    );
    if (hasSigner()) body.append(h('button', { class: 'btn small ghost', onclick: async () => {
      try { const n = await pushSession(s); if (n) { store.set('lc.ai.synced', '1'); toast(`Saved to Nostr, encrypted to you (${n} relays)`); } else toast('No relay accepted it. Try again later.'); }
      catch (e: any) { toast(`Nostr: ${e.message}`); }
    } }, store.get('lc.ai.synced') ? 'Update on my other devices (Nostr)' : 'Keep on my other devices (Nostr)'));
    const ln = h('input', { class: 'aiinp', placeholder: 'you@wallet.com (optional)', 'aria-label': 'Lightning address for the refund', autocomplete: 'off' }) as HTMLInputElement;
    const st = h('p', { class: 'aistate' });
    const end = h('details', { class: 'gmore' }, h('summary', {}, 'End session and refund'),
      h('p', { class: 'note' }, 'Leave the address empty to get a Cashu token you can paste into any Cashu wallet.'), ln,
      h('button', { class: 'btn small', onclick: async () => {
        st.textContent = 'Refunding…';
        try {
          const r = await refund(s, ln.value || undefined);
          setSession(null); credit = null; changed();
          if (store.get('lc.ai.synced') && hasSigner()) { void pushSession(null).catch(() => undefined); store.set('lc.ai.synced', ''); }
          if (r.token) viewToken(r.token, r.sats);
          else { body.innerHTML = ''; body.append(h('p', { class: 'glead' }, `Refunded ${r.sats ? fmtSats(Number(r.sats)) : 'your credit'} to ${r.recipient ?? ln.value}. Session ended.`), h('button', { class: 'btn', onclick: () => dlg.close() }, 'Done')); }
        } catch (e: any) {
          if (e?.status === 409) st.textContent = 'A refund is already in progress. Try again in a moment.';
          else st.textContent = `Refund failed: ${e.message}. Your session is kept, so nothing is lost.`;
        }
      } }, 'End session and refund'), st);
    body.append(end, privacy());
    void refreshCredit().then(() => { if (dlg.open && body.contains(end)) { const b = body.querySelector('.aicredit b'); if (b) b.textContent = fmtSats(credit ?? 0); const sm = body.querySelector('.aicredit small'); if (sm) sm.textContent = fmtUsd(credit ?? 0, usd); } });
  }

  async function viewToken(token: string, sats?: string) {
    body.innerHTML = '';
    const cv = h('canvas', { class: 'aiqr' }) as HTMLCanvasElement;
    try { await QRCode.toCanvas(cv, token, { margin: 2, width: 260, errorCorrectionLevel: 'L' }); } catch { cv.hidden = true; }
    body.append(h('p', { class: 'glead' }, `Here is your refund${sats ? ` of ${fmtSats(Number(sats))}` : ''}. Paste or scan it into a Cashu wallet now; it is shown only once.`), cv,
      h('textarea', { class: 'aiinp', rows: 4, readonly: true }, token),
      h('div', { class: 'gbtns' }, h('button', { class: 'btn primary', onclick: async () => { try { await navigator.clipboard.writeText(token); toast('Token copied'); } catch { toast('Copy blocked: select the text instead'); } } }, 'Copy token'),
        h('button', { class: 'btn', onclick: () => dlg.close() }, 'Done')));
  }

  function open(then?: () => void) {
    afterPay = then ?? null;
    if (!dlg.open) dlg.showModal();
    if (getSession()) viewSession(); else void viewBuy();
  }

  /** Make one picture; asks for credit first if there is none. */
  async function create(prompt: string, ref: string | undefined, aspect: string, onStart: () => void): Promise<string | null> {
    const s = getSession();
    if (!s) { open(() => toast('Credit added. Press the button again to create.')); return null; }
    onStart();
    try {
      const refUrl = ref ? await shrinkForUpload(ref) : undefined;
      const url = await generateImage(s, model, prompt, refUrl, aspect);
      void refreshCredit();
      return url;
    } catch (e: any) {
      void refreshCredit();
      if (e?.status === 402 || /balance|insufficient/i.test(e?.message ?? '')) { toast('Not enough credit for this picture. Top up to continue.'); open(); }
      else toast(`The AI could not make it: ${e.message}`);
      return null;
    }
  }

  const modelLabel = () => MODELS.find((m) => m.id === model)?.label ?? model;
  const maxCost = async () => { if (!offers.length) { try { await loadOffers(); } catch { /* offline */ } } const s = getSession(); return (offers.find((o) => o.url === s?.node) ?? offer)?.maxSats ?? null; };

  if (getSession()) void refreshCredit(); else drawBadge();
  void btcUsd().then((v) => { usd = v; });
  return { badge, open, create, refreshCredit, credit: () => credit, usd: () => usd, hasSession: () => !!getSession(), onChange: (f: () => void) => listeners.add(f), modelLabel, maxCost };
}
export type AiUi = ReturnType<typeof createAiUi>;
