// A small pool of geometry workers. The coordinator (engine.computeAsync on the main
// thread) keeps the cache and bookkeeping; the heavy per-opening work is spread across
// workers so phones with several cores use all of them.
import type { EngineInput, Runner, Settings, StepJob } from './engine';
import { Stale, designStrokes, windowShapes } from './engine';
import type { Group, Paths } from './geom';

type Task = { msg: any; weight: number; resolve: (v: any) => void; reject: (e: any) => void; stale: () => boolean };
type Slot = { w: Worker; busy: Task | null; dead: boolean };

export class Pool {
  private slots: Slot[] = [];
  private queue: Task[] = [];
  private seq = 0;
  backend = 'js';
  get size() { return this.slots.filter((s) => !s.dead).length; }

  private constructor(workers: Worker[]) {
    for (const w of workers) {
      const slot: Slot = { w, busy: null, dead: false };
      w.onmessage = (e) => {
        const t = slot.busy;
        slot.busy = null;
        if (e.data.work !== undefined) (slot as any).work = e.data.work;
        if (t) e.data.error ? t.reject(new Error(e.data.error)) : t.resolve(e.data.out);
        this.pump();
      };
      w.onerror = (ev) => {
        slot.dead = true;
        const t = slot.busy;
        slot.busy = null;
        t?.reject(new Error('worker failed: ' + ((ev as ErrorEvent).message ?? '')));
        if (!this.size) for (const q of this.queue.splice(0)) q.reject(new Error('no workers left'));
        this.pump();
      };
      this.slots.push(slot);
    }
  }

  /** Start up to n workers and keep the ones that answer; null if fewer than two work. */
  static async create(make: () => Worker, n: number, forceJs: boolean): Promise<Pool | null> {
    const ws: Worker[] = [];
    for (let i = 0; i < n; i++) { try { ws.push(make()); } catch { break; } }
    if (ws.length < 2) { ws.forEach((w) => w.terminate()); return null; }
    const ok = await Promise.all(ws.map((w) => new Promise<string | null>((res) => {
      const t = setTimeout(() => res(null), 10000);
      w.onmessage = (e) => { clearTimeout(t); res(e.data?.out ?? null); };
      w.onerror = () => { clearTimeout(t); res(null); };
      w.postMessage({ job: -1, kind: 'ping', forceJs });
    })));
    const good = ws.filter((_, i) => ok[i]);
    ws.filter((_, i) => !ok[i]).forEach((w) => w.terminate());
    if (good.length < 2) { good.forEach((w) => w.terminate()); return null; }
    const p = new Pool(good);
    p.backend = ok.find((x) => x) ?? 'js';
    return p;
  }

  workTotals() { return this.slots.map((s) => Math.round((s as any).work ?? 0)); }
  terminate() {
    for (const s of this.slots) { s.dead = true; s.w.terminate(); }
    for (const q of this.queue.splice(0)) q.reject(new Error('pool closed'));
  }

  private pump() {
    for (const slot of this.slots) {
      if (slot.dead || slot.busy) continue;
      let t: Task | undefined;
      while ((t = this.queue.shift()) && t.stale()) t.reject(new Stale('superseded'));
      if (!t) return;
      slot.busy = t;
      slot.w.postMessage({ ...t.msg, job: ++this.seq });
    }
  }

  private run<T>(msg: any, stale: () => boolean, weight = 1): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (!this.size) { reject(new Error('no workers')); return; }
      this.queue.push({ msg, weight, resolve, reject, stale });
      this.pump();
    });
  }

  thin(top: Paths, minRib: number, stale: () => boolean) {
    return this.run<{ thin: Paths; warning: string }>({ kind: 'thin', top, minRib }, stale);
  }

  /** Split items into about `per` batches per worker, balanced by weight. */
  private split<T>(items: T[], weight: (t: T) => number, per: number): T[][] {
    const n = Math.max(1, Math.min(items.length, this.size * per));
    const bins: { items: T[]; w: number }[] = Array.from({ length: n }, () => ({ items: [], w: 0 }));
    const order = items.map((t) => ({ t, w: weight(t) })).sort((a, b) => b.w - a.w);
    for (const o of order) { let b = bins[0]; for (const x of bins) if (x.w < b.w) b = x; b.items.push(o.t); b.w += o.w; }
    return bins.filter((b) => b.items.length).map((b) => b.items);
  }

  /** A Runner for one request; queued work is dropped once the request is superseded. */
  runner(stale: () => boolean): Runner {
    return {
      name: this.backend,
      top: async ({ s, sketch, imported, free }: EngineInput) => {
        // 1) buffer the design lines in parallel, 2) cut them out of the panel on one
        // worker, 3) clean up slivers per opening in parallel
        const strokes = designStrokes(s, sketch, imported, free).filter((l) => l.length > 1);
        const ribBatches = this.split(strokes, (l) => l.length, 2);
        const ribs = (await Promise.all(ribBatches.map((b) => this.run<Paths>({ kind: 'ribs', lines: b, half: s.rib / 2 }, stale)))).flat();
        const groups = await this.run<Group[]>({ kind: 'cut', s, ribs, win: windowShapes(s, imported, free), hasStrokes: strokes.length > 0 }, stale);
        const tidyBatches = this.split(groups, (g) => g.outer.length + g.holes.reduce((a, h) => a + h.length, 0), 2);
        const parts = await Promise.all(tidyBatches.map((b) => this.run<{ o: Paths; y: Paths }>({ kind: 'tidy', s, groups: b }, stale)));
        return { open0: parts.flatMap((p) => p.o), open0Y: parts.flatMap((p) => p.y) };
      },
      steps: async (s: Settings, jobs: StepJob[]) => {
        // balance by size: biggest openings first, about three batches per worker
        const w = (j: StepJob) => j.g.outer.length + j.g.holes.reduce((a, h) => a + h.length, 0) + (j.motifLayer ? 400 : 0);
        const order = jobs.map((j, i) => ({ i, w: w(j) })).sort((a, b) => b.w - a.w);
        const total = order.reduce((a, o) => a + o.w, 0);
        const target = Math.max(1, total / (this.size * 3));
        const batches: { idx: number[]; w: number }[] = [];
        let cur: { idx: number[]; w: number } = { idx: [], w: 0 };
        for (const o of order) {
          cur.idx.push(o.i); cur.w += o.w;
          if (cur.w >= target) { batches.push(cur); cur = { idx: [], w: 0 }; }
        }
        if (cur.idx.length) batches.push(cur);
        const out: any[] = new Array(jobs.length);
        const t0 = performance.now();
        await Promise.all(batches.map(async (b) => {
          const res = await this.run<any[]>({ kind: 'steps', s, jobs: b.idx.map((i) => jobs[i]), t: performance.now() }, stale, b.w);
          b.idx.forEach((i, k) => { out[i] = res[k]; });
        }));
        return out;
      },
    };
  }
}
