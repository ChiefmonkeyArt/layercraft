// Optional: keep the AI session on your other devices via Nostr.
// Uses a browser signer (NIP-07, e.g. Alby, nos2x, Keys.band) and NIP-44 encryption to yourself,
// stored as app data (kind 30078). Never required; nothing is shared unless you press the button.
const RELAYS = ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net'];
const D_TAG = 'layercraft/ai-session';

interface Nip07 {
  getPublicKey(): Promise<string>;
  signEvent(e: { kind: number; created_at: number; tags: string[][]; content: string }): Promise<any>;
  nip44?: { encrypt(pk: string, t: string): Promise<string>; decrypt(pk: string, c: string): Promise<string> };
}
const signer = (): Nip07 | null => ((window as any).nostr ?? null);
export const hasSigner = () => { const s = signer(); return !!(s && s.nip44); };

function publish(ev: any): Promise<number> {
  return new Promise((done) => {
    let ok = 0, left = RELAYS.length;
    const t = setTimeout(() => done(ok), 6000);
    for (const r of RELAYS) {
      let ws: WebSocket;
      const end = (good: boolean) => { if (good) ok++; try { ws.close(); } catch { /* closed */ } if (--left === 0) { clearTimeout(t); done(ok); } };
      try { ws = new WebSocket(r); } catch { end(false); continue; }
      ws.onopen = () => ws.send(JSON.stringify(['EVENT', ev]));
      ws.onmessage = (m) => { try { const d = JSON.parse(String(m.data)); if (d[0] === 'OK') end(!!d[2]); } catch { /* ignore */ } };
      ws.onerror = () => end(false);
    }
  });
}
function fetchLatest(pubkey: string): Promise<any | null> {
  return new Promise((done) => {
    let best: any = null, left = RELAYS.length;
    const t = setTimeout(() => done(best), 5000);
    for (const r of RELAYS) {
      let ws: WebSocket;
      const end = () => { try { ws.close(); } catch { /* closed */ } if (--left === 0) { clearTimeout(t); done(best); } };
      try { ws = new WebSocket(r); } catch { end(); continue; }
      ws.onopen = () => ws.send(JSON.stringify(['REQ', 'lc', { kinds: [30078], authors: [pubkey], '#d': [D_TAG], limit: 1 }]));
      ws.onmessage = (m) => {
        try { const d = JSON.parse(String(m.data)); if (d[0] === 'EVENT' && (!best || d[2].created_at > best.created_at)) best = d[2]; if (d[0] === 'EOSE') end(); } catch { /* ignore */ }
      };
      ws.onerror = end;
    }
  });
}

/** Save (or clear, with null) the session, encrypted so only you can read it. */
export async function pushSession(value: unknown | null): Promise<number> {
  const s = signer(); if (!s?.nip44) throw new Error('No Nostr signer with NIP-44 found in this browser');
  const pk = await s.getPublicKey();
  const content = await s.nip44.encrypt(pk, JSON.stringify({ v: 1, session: value }));
  const ev = await s.signEvent({ kind: 30078, created_at: Math.floor(Date.now() / 1000), tags: [['d', D_TAG]], content });
  return publish(ev);
}
export async function pullSession<T>(): Promise<T | null> {
  const s = signer(); if (!s?.nip44) throw new Error('No Nostr signer with NIP-44 found in this browser');
  const pk = await s.getPublicKey();
  const ev = await fetchLatest(pk);
  if (!ev) return null;
  try { return JSON.parse(await s.nip44.decrypt(pk, ev.content))?.session ?? null; } catch { return null; }
}
