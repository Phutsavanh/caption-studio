/* Runs Whisper on this device. Lao is transcribed in Thai mode in ~10 s pieces cut at quiet moments, which gives
   stable word timings (see the lao-subtitles skill). The model downloads once, then stays in the browser cache. */
import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.2';

env.allowLocalModels = false;
const MODEL = 'onnx-community/whisper-small_timestamped';
const SR = 16000;
let asr = null, device = null;

async function canUseWebGpu() {
  if (!self.navigator.gpu) return false;
  try {
    const adapter = await self.navigator.gpu.requestAdapter();
    return !!adapter && adapter.features.has('shader-f16');
  } catch { return false; }
}

async function load(force) {
  if (asr) return;
  const files = new Map();
  const progress_callback = p => {
    if (p.status === 'progress' && p.total) {
      files.set(p.file, [p.loaded, p.total]);
      let a = 0, b = 0;
      for (const [x, y] of files.values()) { a += x; b += y; }
      self.postMessage({ type: 'download', loaded: a, total: b });
    }
  };
  const useGpu = force !== 'wasm' && await canUseWebGpu();
  try {
    asr = await pipeline('automatic-speech-recognition', MODEL, useGpu
      ? { device: 'webgpu', dtype: { encoder_model: 'fp16', decoder_model_merged: 'q4f16' }, progress_callback }
      : { device: 'wasm', dtype: { encoder_model: 'q8', decoder_model_merged: 'q8' }, progress_callback });
    device = useGpu ? 'webgpu' : 'wasm';
  } catch (e) {
    if (useGpu) { asr = null; return load('wasm'); }
    throw e;
  }
  return undefined;
}

function cutPoints(audio) {
  const dur = audio.length / SR, fr = 320;
  const energy = new Float32Array(Math.floor(audio.length / fr));
  for (let i = 0; i < energy.length; i++) {
    let sum = 0;
    for (let j = 0; j < fr; j++) { const v = audio[i * fr + j]; sum += v * v; }
    energy[i] = Math.sqrt(sum / fr);
  }
  const cuts = [0];
  while (cuts[cuts.length - 1] + 12 < dur) {
    const last = cuts[cuts.length - 1];
    const lo = Math.floor((last + 7) * SR / fr), hi = Math.floor((last + 11) * SR / fr);
    let best = lo;
    for (let i = lo; i < hi; i++) if (energy[i] < energy[best]) best = i;
    cuts.push(best * fr / SR);
  }
  cuts.push(dur);
  return cuts;
}

self.onmessage = async ({ data }) => {
  try {
    const audio = data.audio;
    await load(data.force);
    self.postMessage({ type: 'ready', device });
    const cuts = cutPoints(audio);
    const words = [], segs = [];
    for (let c = 0; c + 1 < cuts.length; c++) {
      const a = cuts[c], b = cuts[c + 1];
      const started = performance.now();
      const res = await asr(audio.subarray(Math.floor(a * SR), Math.floor(b * SR)), { language: 'thai', task: 'transcribe', return_timestamps: 'word' });
      const seg = { s: a, e: b, words: [] };
      for (const w of res.chunks || []) {
        const s = w.timestamp[0], e = w.timestamp[1];
        if (s == null) continue;
        const item = { w: w.text, s: a + s, e: a + (e == null ? s + 0.2 : e) };
        words.push(item);
        seg.words.push(item);
      }
      segs.push(seg);
      self.postMessage({ type: 'progress', p: b / cuts[cuts.length - 1], secPerSec: (performance.now() - started) / 1000 / Math.max(0.1, b - a) });
    }
    self.postMessage({ type: 'done', words, segs, device });
  } catch (e) {
    self.postMessage({ type: 'error', error: e.message || String(e) });
  }
};
