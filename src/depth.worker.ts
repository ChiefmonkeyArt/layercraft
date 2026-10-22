/// <reference lib="webworker" />
// Reads depth from a photo on this device with Depth Anything V2 Small (Apache-2.0).
// The model and runtime are served by this site; nothing is fetched from anywhere else and the
// picture never leaves the device.
import { AutoModel, AutoProcessor, env, RawImage } from '@huggingface/transformers';
// the runtime is bundled with the app, so nothing is fetched from a CDN
import ortWasm from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url';
import ortMjs from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs?url';

type In = { w: number; h: number; data: Uint8ClampedArray; base: string };
let pipe: any = null;

self.onmessage = async (e: MessageEvent<In>) => {
  const { w, h, data, base } = e.data;
  try {
    env.allowRemoteModels = false;
    env.allowLocalModels = true;
    env.localModelPath = new URL('models/', base).href;
    const onnx = (env.backends as any).onnx;
    if (onnx?.wasm) { onnx.wasm.wasmPaths = { wasm: new URL(ortWasm, self.location.href).href, mjs: new URL(ortMjs, self.location.href).href }; onnx.wasm.proxy = false; }
    if (!pipe) {
      const progress = (p: any) => { if (p?.status === 'progress' && p.total) self.postMessage({ type: 'progress', loaded: p.loaded, total: p.total }); };
      let gpu = false;
      try { gpu = !!(await (navigator as any).gpu?.requestAdapter?.()); } catch { gpu = false; }
      const id = 'depth-anything-v2-small';
      const processor = await AutoProcessor.from_pretrained(id);
      let model: any;
      try { model = await AutoModel.from_pretrained(id, { device: gpu ? 'webgpu' : 'wasm', dtype: 'q8', progress_callback: progress } as any); }
      catch (err) { if (!gpu) throw err; model = await AutoModel.from_pretrained(id, { device: 'wasm', dtype: 'q8', progress_callback: progress } as any); }
      pipe = { processor, model };
    }
    self.postMessage({ type: 'status', text: 'Reading the depth…' });
    const img = new RawImage(data, w, h, 4);
    const inputs = await pipe.processor(img);
    const { predicted_depth } = await pipe.model(inputs);
    const [dh, dw] = predicted_depth.dims.slice(-2);
    const v = predicted_depth.data as Float32Array;
    let lo = Infinity, hi = -Infinity; for (let i = 0; i < dw * dh; i++) { if (v[i] < lo) lo = v[i]; if (v[i] > hi) hi = v[i]; }
    const g = new Uint8ClampedArray(dw * dh);
    for (let i = 0; i < dw * dh; i++) g[i] = Math.round(((v[i] - lo) / (hi - lo || 1)) * 255); // lighter = nearer
    const r = await new RawImage(g, dw, dh, 1).resize(w, h);
    self.postMessage({ type: 'done', w: r.width, h: r.height, depth: r.data }, [ (r.data as Uint8Array).buffer ] as any);
  } catch (err: any) {
    self.postMessage({ type: 'error', text: String(err?.message ?? err), stack: String(err?.stack ?? '') });
  }
};
