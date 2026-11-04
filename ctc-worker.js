/* Lao speech recognition on this device, using a model trained on Lao (SiangLao/xlsr-53-lao-asr, Apache-2.0,
   National University of Laos thesis work). It writes Lao letters directly and gives each letter a time, so no
   Thai-to-Lao conversion is needed. The model downloads once in parts, then stays in the browser cache. */
import * as ort from 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.23.0/dist/ort.wasm.bundle.min.mjs';

const SR = 16000, FRAME = 0.02, CACHE = 'caption-studio-model-v1';
let session = null, vocab = null;

async function fetchPart(cache, url) {
  const hit = await cache.match(url);
  if (hit) return new Uint8Array(await hit.arrayBuffer());
  for (let tries = 0; ; tries++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const copy = res.clone();
      const bytes = new Uint8Array(await res.arrayBuffer());
      await cache.put(url, copy).catch(() => {});
      return bytes;
    } catch (e) {
      if (tries >= 3) throw e;
      await new Promise(r => setTimeout(r, 2000 * (tries + 1)));
    }
  }
}

async function load(base) {
  if (session) return;
  const manifest = await (await fetch(`${base}model/manifest.json`)).json();
  vocab = manifest.vocab;
  const cache = await caches.open(CACHE);
  const whole = new Uint8Array(manifest.size);
  let at = 0;
  for (const part of manifest.parts) {
    const bytes = await fetchPart(cache, `${base}model/${part}`);
    whole.set(bytes, at);
    at += bytes.length;
    self.postMessage({ type: 'download', loaded: at, total: manifest.size });
  }
  ort.env.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.23.0/dist/';
  ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(6, self.navigator.hardwareConcurrency || 2) : 1;
  session = await ort.InferenceSession.create(whole, { executionProviders: ['wasm'] });
}

// Pieces of up to 20 s, cut at a quiet moment so no word is split.
function windows(audio) {
  const fr = 320, out = [];
  let start = 0;
  while (audio.length - start > 20 * SR) {
    let best = start + 16 * SR, low = Infinity;
    for (let p = start + 16 * SR; p + fr < start + 20 * SR; p += fr) {
      let e = 0;
      for (let j = 0; j < fr; j += 4) e += audio[p + j] * audio[p + j];
      if (e < low) { low = e; best = p; }
    }
    out.push([start, best]);
    start = best;
  }
  out.push([start, audio.length]);
  return out;
}

function normalise(seg) {
  let mean = 0;
  for (let i = 0; i < seg.length; i++) mean += seg[i];
  mean /= seg.length || 1;
  let v = 0;
  for (let i = 0; i < seg.length; i++) v += (seg[i] - mean) ** 2;
  const std = Math.sqrt(v / (seg.length || 1) + 1e-7);
  const out = new Float32Array(seg.length);
  for (let i = 0; i < seg.length; i++) out[i] = (seg[i] - mean) / std;
  return out;
}

/** Greedy CTC decoding that remembers when each letter was heard. */
function decode(logits, frames, classes, offset, chars) {
  let prev = -1;
  for (let f = 0; f < frames; f++) {
    let best = 0, score = -Infinity;
    for (let c = 0; c < classes; c++) {
      const v = logits[f * classes + c];
      if (v > score) { score = v; best = c; }
    }
    if (best !== prev && best !== vocab.pad) {
      const ch = vocab.id2char[best];
      if (ch === vocab.delim) chars.push({ c: ' ', t: offset + f * FRAME });
      else if (!ch.startsWith('<')) chars.push({ c: ch, t: offset + f * FRAME });
    }
    prev = best;
  }
}

self.onmessage = async ({ data }) => {
  try {
    await load(data.base);
    self.postMessage({ type: 'ready', threads: ort.env.wasm.numThreads });
    const audio = data.audio, chars = [], win = windows(audio);
    for (let w = 0; w < win.length; w++) {
      const [a, b] = win[w];
      if (b - a < SR / 4) continue;
      const input = new ort.Tensor('float32', normalise(audio.subarray(a, b)), [1, b - a]);
      const out = await session.run({ input_values: input });
      const logits = out.logits;
      decode(logits.data, logits.dims[1], logits.dims[2], a / SR, chars);
      input.dispose?.();
      logits.dispose?.();
      self.postMessage({ type: 'progress', p: b / audio.length });
    }
    self.postMessage({ type: 'done', chars });
  } catch (e) {
    self.postMessage({ type: 'error', error: e.message || String(e) });
  }
};
