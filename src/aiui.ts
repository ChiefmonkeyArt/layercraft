// The AI credit sheet: pay with Lightning (QR) or Cashu, see what's left, top up, end and refund.
import QRCode from 'qrcode';
import {
  FLAT_MODEL, MODELS, newerModels, NodeOffer, Session, balance, btcUsd, createInvoice, findOffers, fmtSats, fmtUsd, generateImage, getSession,
  invoiceStatus, findPayment, payments, savePayment, Payment, parseSessionCode, redeemCashu, refund, sessionCode, setSession, shrinkForUpload, topupCashu,
  checkPicture, visionOffer, type PictureCheck,
} from './ai';
import { store, storageOk } from './guided';
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
  // the flat redraw has its own model, Nano Banana Pro unless changed on the Flatten step
  let flatModel = store.get('lc.ai.flatModel') || FLAT_MODEL;
  let amount = AMOUNTS[0];
  let poll = 0;
  let afterPay: (() => void) | null = null;
  const listeners = new Set<() => void>();
  const changed = () => { drawBadge(); listeners.forEach((f) => f()); };

  const WALLET = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H18v3"/><rect x="3" y="7.5" width="18" height="12" rx="2.5"/><path d="M16.5 13.5h.01"/></svg>';
  const badge = h('button', { class: 'btn ghost aibadge', title: 'Your AI credit', onclick: () => open() });
  const badgeAmt = h('span', { class: 'aiamt' });
  badge.innerHTML = WALLET; badge.append(badgeAmt);
  let shown: number | null = null;
  const drawBadge = () => {
    const s = getSession();
    badge.classList.toggle('empty', !s);
    badgeAmt.textContent = !s ? 'Add credit' : credit == null ? 'Credit' : fmtSats(credit);
    badge.setAttribute('aria-label', !s ? 'Add AI credit' : credit == null ? 'Your AI credit' : `Your AI credit: ${fmtSats(credit)}. Open for details, top up or refund.`);
    // credit went up: a small "+N" rises from the chip
    if (s && credit != null && shown != null && credit > shown) {
      const f = h('span', { class: 'aiplus', 'aria-hidden': 'true' }, `+${(credit - shown).toLocaleString('en-GB')}`);
      badge.append(f); badge.classList.remove('bump'); void badge.offsetWidth; badge.classList.add('bump');
      setTimeout(() => f.remove(), 1800);
    }
    shown = s ? credit : null;
  };

  const dlg = h('dialog', { class: 'aisheet', 'aria-label': 'AI credit' }) as HTMLDialogElement;
  /** a paused action waiting for the user to pay: resolved true when credit arrives, false if they close the sheet */
  let payWait: ((ok: boolean) => void) | null = null;
  dlg.addEventListener('close', () => { clearInterval(poll); const w = payWait; payWait = null; w?.(false); });
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
  document.body.append(dlg);
  const body = h('div', { class: 'aibody' });
  dlg.append(h('div', { class: 'aihead' }, h('b', {}, 'Your AI credit'), h('button', { class: 'gpdel', 'aria-label': 'Close', onclick: () => dlg.close() }, '×')), body);

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
    if (!storageOk()) body.append(storageWarn(null));
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
      body.append(restore, recoverBox());
      if (payments().length) body.append(history());
    } else body.append(h('button', { class: 'btn small ghost', onclick: () => viewSession() }, 'Back'));
    body.append(privacy());
  }

  async function viewLightning(node: string, sats: number, topupKey?: string) {
    body.innerHTML = '';
    body.append(h('p', { class: 'aistate' }, 'Asking the node for an invoice…'));
    let inv;
    try { inv = await createInvoice(node, sats, topupKey); } catch (e: any) { body.innerHTML = ''; body.append(h('p', { class: 'aistate warn' }, `The node could not make an invoice: ${e.message}`), h('button', { class: 'btn', onclick: () => void viewBuy(!!topupKey) }, 'Back')); return; }
    const pay: Payment = { node, name: offer?.name ?? getSession()?.name ?? new URL(node).hostname, bolt11: inv.bolt11, id: inv.invoice_id, sats: inv.amount_sats, at: Date.now(), topup: !!topupKey, status: 'pending' };
    savePayment(pay); // kept before payment: if anything goes wrong the invoice can still be recovered
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
        if (left <= 0) { clearInterval(poll); st.textContent = 'This invoice expired. Make a new one.'; savePayment({ ...pay, status: 'expired' }); return; }
        const r = await invoiceStatus(node, inv!.invoice_id);
        st.textContent = `Waiting for payment… expires in ${Math.floor(left / 60)}:${String(Math.floor(left % 60)).padStart(2, '0')}`;
        if (r.status === 'paid') {
          clearInterval(poll);
          if (!topupKey) {
            if (!r.api_key) { st.textContent = 'Paid. Waiting for the node to open your session…'; return; }
            setSession({ node, name: pay.name, key: r.api_key, created: Date.now() });
          }
          savePayment({ ...pay, status: 'paid', key: r.api_key ?? topupKey });
          const prev = credit ?? 0; await refreshCredit(); paid(Math.max(0, (credit ?? 0) - prev) || sats);
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
            const prev = topup ? credit ?? 0 : 0; await refreshCredit(); paid(Math.max(0, (credit ?? 0) - prev));
          } catch (e: any) { st.textContent = e?.status ? `Not accepted: ${e.message}. The node may not take tokens from that mint.` : e.message; }
        } }, 'Add credit'),
        h('button', { class: 'btn small ghost', onclick: () => void viewBuy(topup) }, 'Back')),
      st, privacy());
  }

  /** Payment arrived: a short thank-you, then straight back to what the user was doing. */
  function paid(added: number) {
    const w = payWait, go = afterPay; payWait = null; afterPay = null;
    thanks(added, !!w);
    const done = () => {
      if (w) { dlg.close(); w(true); }
      else if (go) { dlg.close(); go(); }
      else viewSession();
    };
    setTimeout(done, matchMedia('(prefers-reduced-motion: reduce)').matches ? 1200 : 2100);
  }
  function thanks(added: number, cont: boolean) {
    clearInterval(poll);
    body.innerHTML = '';
    const num = h('span', {}, '0');
    const card = h('div', { class: 'aithanks', role: 'status', 'aria-live': 'polite' });
    card.innerHTML = '<svg class="aitick" viewBox="0 0 72 72" aria-hidden="true"><circle class="ring" cx="36" cy="36" r="30"/><path class="bolt" d="M39 14 24 39h11l-3 19 16-26H37z"/><path class="tick" d="M22 37l9 9 19-20"/></svg>';
    card.append(h('b', {}, 'Thank you'), h('p', { class: 'aiadded' }, '+', num, ' sats added'),
      h('small', {}, `Balance ${fmtSats(credit ?? added)}${usdOf(credit ?? added)}`),
      cont ? h('p', { class: 'aistate' }, 'Starting your picture…') : '');
    body.append(card);
    const t0 = performance.now(), T = 900;
    const step = (t: number) => { const k = Math.min(1, (t - t0) / T), e = 1 - (1 - k) ** 3; num.textContent = Math.round(added * e).toLocaleString('en-GB'); if (k < 1) requestAnimationFrame(step); };
    requestAnimationFrame(step);
  }
  /** Ask for credit and wait: resolves true once paid (the caller carries on), false if the sheet is closed. */
  function askForCredit(topup = false): Promise<boolean> {
    return new Promise((res) => {
      const old = payWait; payWait = null; old?.(false);
      afterPay = null;
      if (!dlg.open) dlg.showModal();
      payWait = res;
      if (topup && getSession()) void viewBuy(true); else if (getSession()) viewSession(); else void viewBuy();
    });
  }

  function viewSession() {
    clearInterval(poll);
    const s = getSession();
    if (!s) { void viewBuy(); return; }
    body.innerHTML = '';
    const amt = credit ?? 0;
    const per = (offers.find((o) => o.url === s.node) ?? null)?.maxSats ?? null;
    const left = h('p', { class: 'note' }, per && credit != null ? `Enough for about ${Math.max(0, Math.floor(amt / per))} picture${Math.floor(amt / per) === 1 ? '' : 's'} at up to ${fmtSats(per)} each. Usually less is taken.` : '');
    if (!per) void loadOffers().then(() => { const m = (offers.find((o) => o.url === s.node))?.maxSats; if (m && credit != null && body.contains(left)) left.textContent = `Enough for about ${Math.floor((credit ?? 0) / m)} picture${Math.floor((credit ?? 0) / m) === 1 ? '' : 's'} at up to ${fmtSats(m)} each. Usually less is taken.`; }).catch(() => undefined);
    const refundBox = h('div', { class: 'airefund', hidden: true });
    body.append(
      h('div', { class: 'aiwallet' },
        h('div', { class: 'aicredit' }, h('b', {}, credit == null ? '…' : fmtSats(amt)), h('small', {}, fmtUsd(amt, usd) || '')),
        h('span', { class: 'ainode' }, `Held on ${s.name}, a Routstr node. Only this browser has the key.`)),
      left,
      storageOk() ? h('p', { class: 'note' }, 'Your credit stays here, even after you close the tab, until you refund it.') : storageWarn(s),
      h('div', { class: 'gbtns' },
        h('button', { class: 'btn primary', onclick: () => void viewBuy(true) }, 'Top up'),
        h('button', { class: 'btn', 'aria-expanded': 'false', onclick: (e: Event) => { refundBox.hidden = !refundBox.hidden; (e.currentTarget as HTMLElement).setAttribute('aria-expanded', String(!refundBox.hidden)); if (!refundBox.hidden) (refundBox.querySelector('input') as HTMLInputElement | null)?.focus(); } }, 'Refund')),
      refundBox,
      h('details', { class: 'gmore' }, h('summary', {}, 'Use this credit on another device'),
        h('p', { class: 'note' }, 'A session code moves this credit to another browser. Anyone with it can spend the credit, so keep it private.'),
        h('button', { class: 'btn small', onclick: async () => { try { await navigator.clipboard.writeText(sessionCode(s)); toast('Session code copied. Anyone with it can spend this credit.'); } catch { toast('Copy blocked here'); } } }, 'Copy session code')),
    );
    if (hasSigner()) body.append(h('button', { class: 'btn small ghost', onclick: async () => {
      try { const n = await pushSession(s); if (n) { store.set('lc.ai.synced', '1'); toast(`Saved to Nostr, encrypted to you (${n} relays)`); } else toast('No relay accepted it. Try again later.'); }
      catch (e: any) { toast(`Nostr: ${e.message}`); }
    } }, store.get('lc.ai.synced') ? 'Update on my other devices (Nostr)' : 'Keep on my other devices (Nostr)'));
    const end = refundForm(s, true);
    refundBox.append(end);
    body.append(history(), recoverBox(), privacy());
    void refreshCredit().then(() => { if (dlg.open && body.contains(end)) { const b = body.querySelector('.aicredit b'); if (b) b.textContent = fmtSats(credit ?? 0); const sm = body.querySelector('.aicredit small'); if (sm) sm.textContent = fmtUsd(credit ?? 0, usd); } });
  }

  /** Refund a session: to a Lightning address, or as a Cashu token. */
  function refundForm(s: Session, current: boolean) {
    const ln = h('input', { class: 'aiinp', placeholder: 'you@wallet.com (optional)', 'aria-label': 'Lightning address for the refund', autocomplete: 'off', value: store.get('lc.ai.refundTo') ?? '' }) as HTMLInputElement;
    const st = h('p', { class: 'aistate' });
    return h('div', { class: 'airefundin' },
      h('p', { class: 'note' }, 'Send what is left back to you and end the session. Enter a Lightning address, or leave it empty to get a Cashu token for any Cashu wallet.'), ln,
      h('button', { class: 'btn small primary', onclick: async () => {
        st.textContent = 'Refunding…';
        try {
          if (ln.value.trim()) store.set('lc.ai.refundTo', ln.value.trim());
          const r = await refund(s, ln.value || undefined);
          for (const p of payments()) if (p.key === s.key) savePayment({ ...p, status: 'refunded' });
          if (current) {
            setSession(null); credit = null; changed();
            if (store.get('lc.ai.synced') && hasSigner()) { void pushSession(null).catch(() => undefined); store.set('lc.ai.synced', ''); }
          }
          if (r.token) void viewToken(r.token, r.sats);
          else { body.innerHTML = ''; body.append(h('p', { class: 'glead' }, `Refunded ${r.sats ? fmtSats(Number(r.sats)) : 'your credit'} to ${r.recipient ?? ln.value}.${current ? ' Session ended.' : ''}`), h('button', { class: 'btn', onclick: () => dlg.close() }, 'Done')); }
        } catch (e: any) {
          if (e?.status === 409) st.textContent = 'A refund is already in progress. Try again in a moment.';
          else if (e?.status === 400 && /balance|zero|empty/i.test(e.message)) st.textContent = 'There is nothing left to refund on this key.';
          else st.textContent = `Refund failed: ${e.message}. The credit is kept, so nothing is lost.`;
        }
      } }, current ? 'Refund and end session' : 'Refund this payment'), st);
  }
  function storageWarn(s: Session | null) {
    const url = location.href;
    return h('div', { class: 'aiwarn', role: 'note' },
      h('b', {}, 'This window can’t keep your credit'),
      h('p', {}, s ? 'Your browser blocks storage for embedded pages, so this credit is only held until you close the tab. Copy the session code, or refund before you leave.'
        : 'Your browser blocks storage for embedded pages here. Credit you add works in this tab, but is not kept after you close it. For credit that stays, open Layercraft in its own tab.'),
      h('div', { class: 'gbtns' },
        s ? h('button', { class: 'btn small', onclick: async () => { try { await navigator.clipboard.writeText(sessionCode(s)); toast('Session code copied. Paste it under “Restore a saved session” in the new tab.'); } catch { toast('Copy blocked here'); } } }, 'Copy session code') : null,
        h('a', { class: 'btn small', href: url, target: '_blank', rel: 'noopener' }, 'Open in its own tab')));
  }
  /** Use a recovered key: as the session if there is none (or it is empty), otherwise offer its refund. */
  async function adopt(node: string, name: string, key: string) {
    const ss: Session = { node, name, key, created: Date.now() };
    let sats = 0;
    try { sats = (await balance(ss)).sats; } catch (e: any) { toast(e?.status === 401 ? 'That payment’s session has ended on its node' : 'Its node did not answer. Try again in a minute.'); return; }
    const cur = getSession();
    if (cur && cur.key === key) { await refreshCredit(); viewSession(); toast('That payment is already your credit'); return; }
    let curSats = 0; if (cur) { try { curSats = (await balance(cur)).sats; } catch { curSats = 0; } }
    if (!cur || curSats <= 0) { setSession(ss); await refreshCredit(); viewSession(); toast(`Recovered ${fmtSats(sats)}`); return; }
    body.innerHTML = '';
    body.append(h('p', { class: 'glead' }, `Recovered ${fmtSats(sats)}${usdOf(sats)} on ${name}. You already have credit in use, so refund this one back to you.`),
      refundForm(ss, false), h('button', { class: 'btn small ghost', onclick: () => viewSession() }, 'Back'));
  }
  function recoverBox() {
    const box = h('details', { class: 'gmore' }, h('summary', {}, 'Paid but no credit? Recover a payment'));
    const ta = h('textarea', { class: 'aiinp', rows: 3, placeholder: 'lnbc…', 'aria-label': 'Paid Lightning invoice' }) as HTMLTextAreaElement;
    const st = h('p', { class: 'aistate' });
    box.append(h('p', { class: 'note' }, 'Open the payment in your Lightning wallet’s history and copy its invoice (it starts with lnbc). Paste it here: the node that issued it gives your credit back.'), ta,
      h('button', { class: 'btn small primary', onclick: async () => {
        const b = ta.value.trim().replace(/^lightning:/i, '').toLowerCase();
        if (!/^ln(bc|tb|bcrt)[0-9a-z]+$/i.test(b)) { st.textContent = 'That does not look like a Lightning invoice.'; return; }
        st.textContent = 'Asking the nodes…';
        const known = payments().find((p) => p.bolt11.toLowerCase() === b.toLowerCase());
        const r = await findPayment(b, known ? [known.node] : payments().map((p) => p.node));
        if (!r) { st.textContent = 'No node recognised that invoice. Check you copied the whole thing.'; return; }
        if (r.status !== 'paid') { st.textContent = r.status === 'pending' ? 'The node has not seen this payment arrive yet. Try again in a minute.' : `The node says this invoice is ${r.status}.`; return; }
        if (!r.key) { st.textContent = 'Paid, but the node gave no key for it. Ask the node operator.'; return; }
        savePayment({ node: r.node, name: r.name, bolt11: b, id: known?.id ?? b.slice(-16), sats: r.sats ?? known?.sats ?? 0, at: known?.at ?? Date.now(), topup: known?.topup ?? false, status: 'paid', key: r.key });
        await adopt(r.node, r.name, r.key);
      } }, 'Recover'), st);
    return box;
  }
  function history() {
    const list = payments();
    const box = h('details', { class: 'gmore' }, h('summary', {}, `Payments (${list.length})`));
    if (!list.length) { box.append(h('p', { class: 'note' }, 'None yet.')); return box; }
    const label = { pending: 'Waiting', paid: 'Paid', expired: 'Expired, not paid', refunded: 'Refunded' } as const;
    const ul = h('ul', { class: 'aipays' });
    for (const p of list) {
      const cur = getSession();
      const lost = p.status === 'paid' && p.key && (!cur || cur.key !== p.key);
      ul.append(h('li', {},
        h('span', {}, h('b', {}, fmtSats(p.sats)), h('small', {}, `${new Date(p.at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })} · ${p.name}`)),
        h('span', { class: 'aipst ' + p.status }, label[p.status] ?? p.status),
        lost ? h('button', { class: 'btn small', onclick: () => void adopt(p.node, p.name, p.key!) }, 'Recover') :
        p.status === 'pending' ? h('button', { class: 'btn small', onclick: async () => { await checkPending(true); viewSessionOrBuy(); } }, 'Check') : null));
    }
    box.append(ul);
    return box;
  }
  const viewSessionOrBuy = () => { if (getSession()) viewSession(); else void viewBuy(); };
  /** A payment made in a tab that closed (or a frame that could not save): pick its key up from the node. */
  async function checkPending(say = false) {
    const cut = Date.now() - 48 * 3600e3;
    let got = false;
    for (const p of payments().filter((x) => x.status === 'pending' && x.at > cut)) {
      try {
        const r = await invoiceStatus(p.node, p.id);
        if (r.status === 'paid') { savePayment({ ...p, status: 'paid', key: r.api_key ?? p.key }); got = true; }
        else if (r.status === 'expired') savePayment({ ...p, status: 'expired' });
      } catch { /* node offline: try later */ }
    }
    if (!getSession()) {
      for (const p of payments().filter((x) => x.status === 'paid' && x.key && !x.topup)) {
        const ss: Session = { node: p.node, name: p.name, key: p.key!, created: p.at };
        try { const b = await balance(ss); if (b.sats > 0) { setSession(ss); await refreshCredit(); toast(`Your payment arrived: ${fmtSats(b.sats)} credit`); got = true; break; } } catch { /* ended */ }
      }
    }
    if (say && !got) toast('Nothing new yet');
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

  /** Make one picture; asks for credit first if there is none. `use` overrides the model (the flat redraw). */
  async function create(prompt: string, ref: string | string[] | undefined, aspect: string, onStart: () => void, use?: string, again = false): Promise<string | null> {
    if (!getSession() && !(await askForCredit())) return null; // pays, then carries straight on
    const s = getSession();
    if (!s) return null;
    let m = use ?? model;
    // the credit lives on one node: if it doesn't offer this model, fall back to one it does
    if (use) {
      const has = async (id: string) => { try { return (await findOffers(id)).some((o) => o.url === s.node); } catch { return true; } };
      if (!(await has(m))) {
        const alt = MODELS.find((x) => x.id !== m && x.id !== use) ?? MODELS.find((x) => x.id !== m);
        if (alt && (await has(alt.id))) { toast(`${s.name} doesn't offer ${labelOf(m)} right now, so ${alt.label} is used.`); m = alt.id; }
      }
    }
    onStart();
    try {
      const refUrl = Array.isArray(ref) ? await Promise.all(ref.map((r) => shrinkForUpload(r))) : ref ? await shrinkForUpload(ref) : undefined;
      const url = await generateImage(s, m, prompt, refUrl, aspect);
      void refreshCredit();
      return url;
    } catch (e: any) {
      void refreshCredit();
      if (e?.status === 402 || /balance|insufficient/i.test(e?.message ?? '')) {
        toast('Not enough credit for this picture. Top up and it carries on.');
        if (!again && (await askForCredit(true))) return create(prompt, ref, aspect, onStart, use, true);
      } else toast(`The AI could not make it: ${e.message}`);
      return null;
    }
  }

  /** Check the picture with a vision model; asks for credit first if there is none. */
  let vis: { node: string; model: string; maxSats: number } | null = null;
  const visionCost = async () => {
    const s = getSession(), node = s?.node ?? (offers[0] ?? offer)?.url;
    if (!node) { try { await loadOffers(); } catch { /* offline */ } }
    const n = s?.node ?? (offer ?? offers[0])?.url; if (!n) return null;
    if (!vis || vis.node !== n) { const v = await visionOffer(n); vis = v ? { node: n, ...v } : null; }
    return vis?.maxSats ?? null;
  };
  async function check(ref: string, onStart: () => void): Promise<PictureCheck | null> {
    if (!getSession() && !(await askForCredit())) return null;
    const s = getSession();
    if (!s) return null;
    await visionCost();
    if (!vis) { toast('This AI node has no picture-reading model right now. Try again later.'); return null; }
    onStart();
    try {
      const r = await checkPicture(s, vis.model, await shrinkForUpload(ref, 1024));
      void refreshCredit();
      return r;
    } catch (e: any) {
      void refreshCredit();
      if (e?.status === 402 || /balance|insufficient/i.test(e?.message ?? '')) { toast('Not enough credit. Top up and press Check again.'); open(); }
      else toast(`The AI could not check it: ${e.message}`);
      return null;
    }
  }

  const labelOf = (id: string) => [...MODELS, ...newerModels()].find((m) => m.id === id)?.label ?? id;
  const modelLabel = () => labelOf(model);
  const maxCost = async () => { if (!offers.length) { try { await loadOffers(); } catch { /* offline */ } } const s = getSession(); return (offers.find((o) => o.url === s?.node) ?? offer)?.maxSats ?? null; };
  /** Most a flat redraw can cost: on the credit's node, else the cheapest node. */
  const flatCost = async () => { try { const o = await findOffers(flatModel); const s = getSession(); return (o.find((x) => x.url === s?.node) ?? o[0])?.maxSats ?? null; } catch { return null; } };
  const flat = {
    model: () => flatModel, label: () => labelOf(flatModel), cost: flatCost,
    choices: () => [...MODELS, ...newerModels()],
    set: (id: string) => { flatModel = id; store.set('lc.ai.flatModel', id === FLAT_MODEL ? '' : id); },
  };

  if (getSession()) void refreshCredit(); else drawBadge();
  // payments that were made but never reached a saved session come back on their own
  setTimeout(() => void checkPending(), 1500);
  void btcUsd().then((v) => { usd = v; });
  return { badge, open, create, check, visionCost, refreshCredit, credit: () => credit, usd: () => usd, hasSession: () => !!getSession(), onChange: (f: () => void) => listeners.add(f), modelLabel, maxCost, flat };
}
export type AiUi = ReturnType<typeof createAiUi>;
