// Geometry worker. Two roles:
//  - single mode: { id, input } computes a whole design here
//  - pool mode:   { job, kind, ... } runs one batch of work units for a coordinator
import { initGeom, geomBackend } from './geom';
import { trace } from './trace';
import { Stale, computeAsync, pendingThin, stepNode, thinCheck, topCut, topLayer, topRibs, topTidy } from './engine';
let ready: Promise<unknown> | null = null;
let latest = 0;
let WORK = 0;
const post = (m: unknown) => (self as any).postMessage(m);

self.onmessage = async (e: MessageEvent<any>) => {
  const m = e.data;
  if (m.traceJob !== undefined) {
    // image tracing needs no geometry library
    try { post({ traceJob: m.traceJob, out: trace(m.img, m.opts, (msg) => post({ traceJob: m.traceJob, progress: msg })) }); }
    catch (err: any) { post({ traceJob: m.traceJob, error: String(err?.message ?? err) }); }
    return;
  }
  await (ready ??= initGeom(!!m.forceJs));
  if (m.job !== undefined) {
    try {
      let out: unknown;
      if (m.kind === 'ping') out = geomBackend;
      else if (m.kind === 'top') out = topLayer(m.input);
      else if (m.kind === 'ribs') out = topRibs(m.lines, m.half);
      else if (m.kind === 'cut') out = topCut(m.s, m.ribs, m.win, m.hasStrokes);
      else if (m.kind === 'tidy') out = topTidy(m.s, m.groups);
      else if (m.kind === 'steps') { const t = performance.now(); out = m.jobs.map((j: any) => stepNode(m.s, j)); WORK += performance.now() - t; post({ job: m.job, out, work: WORK }); return; }
      else if (m.kind === 'thin') out = thinCheck(m.top, m.minRib);
      post({ job: m.job, out });
    } catch (err: any) {
      post({ job: m.job, error: String(err?.message ?? err) });
    }
    return;
  }
  const { id } = m;
  latest = id;
  try {
    const result = await computeAsync(m.input, { onProgress: (partial) => post({ id, partial }), deferThin: true, stale: () => latest !== id });
    post({ id, result });
    // the thin-rib check runs after the design is on screen; skip it if a newer edit arrived
    setTimeout(() => {
      if (latest !== id) return;
      const t = pendingThin();
      if (t) post({ id, thin: t });
    }, 0);
  } catch (err: any) {
    if (err instanceof Stale) return;
    post({ id, error: String(err?.message ?? err) });
  }
};
