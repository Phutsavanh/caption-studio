/* Everything the local server does, done inside the browser instead, so the app can live on any free static host.
   Clips never leave the device. */
(function () {
  const loadMb = () => import('./mediabunny.min.mjs');
  const DB_NAME = 'caption-studio';

  // ---- Fonts the user added from their own device (IndexedDB) ------------------------------
  const db = () => new Promise((ok, no) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => r.result.createObjectStore('fonts', { keyPath: 'family' });
    r.onsuccess = () => ok(r.result);
    r.onerror = () => no(r.error);
  });
  const store = async mode => (await db()).transaction('fonts', mode).objectStore('fonts');
  const req = r => new Promise((ok, no) => { r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });

  async function fonts() {
    const list = await (await fetch('fonts/fonts.json')).json();
    const own = await req((await store('readonly')).getAll()).catch(() => []);
    own.forEach(f => list.push({ family: f.family, weight: 400, url: URL.createObjectURL(new Blob([f.data])), own: true }));
    return list;
  }
  async function addFont(file) {
    const family = file.name.replace(/\.(ttf|otf|woff2?)$/i, '').replace(/["'\\]/g, '').trim() || 'My font';
    const data = await file.arrayBuffer();
    await new FontFace(family, data).load(); // rejects when it isn't a real font
    await req((await store('readwrite')).put({ family, data }));
    return family;
  }

  // ---- Presets ------------------------------------------------------------------------------
  const loadPresets = async () => JSON.parse(localStorage.getItem('cs.presets') || '[]');
  const savePresets = async list => localStorage.setItem('cs.presets', JSON.stringify(list));

  // ---- Opening a clip -----------------------------------------------------------------------
  async function openFile(file) {
    const MB = await loadMb();
    const input = new MB.Input({ source: new MB.BlobSource(file), formats: MB.ALL_FORMATS });
    try {
      const track = await input.getPrimaryVideoTrack();
      if (!track) throw new Error('ໄຟລ໌ນີ້ບໍ່ມີພາບວິດີໂອ');
      const audio = await input.getPrimaryAudioTrack();
      return {
        id: `${file.name}|${file.size}|${file.lastModified}`,
        name: file.name,
        width: track.displayWidth,
        height: track.displayHeight,
        duration: await input.computeDuration(),
        hasAudio: !!audio,
        file,
      };
    } catch (e) {
      if (e.message && /[\u0E80-\u0EFF]/.test(e.message)) throw e;
      throw new Error('ອ່ານໄຟລ໌ວິດີໂອນີ້ບໍ່ໄດ້');
    } finally { input.dispose?.(); }
  }

  // ---- Listening ---------------------------------------------------------------------------
  async function probe(file) {
    if (file.type.startsWith('image/') || /\.(png|jpe?g|webp|gif)$/i.test(file.name)) {
      const bmp = await createImageBitmap(file);
      const info = { kind: 'image', width: bmp.width, height: bmp.height, duration: 3600, hasAudio: false };
      bmp.close();
      return info;
    }
    const MB = await loadMb();
    const input = new MB.Input({ source: new MB.BlobSource(file), formats: MB.ALL_FORMATS });
    try {
      const v = await input.getPrimaryVideoTrack(), a = await input.getPrimaryAudioTrack();
      if (!v && !a) throw new Error('none');
      return { kind: v ? 'video' : 'audio', width: v ? v.displayWidth : 0, height: v ? v.displayHeight : 0, duration: await input.computeDuration(), hasAudio: !!a };
    } catch { throw new Error(`ອ່ານໄຟລ໌ນີ້ບໍ່ໄດ້: ${file.name}`); } finally { input.dispose?.(); }
  }
  async function thumbnail(m) {
    if (m.kind === 'audio') return null;
    const toUrl = async cv => URL.createObjectURL(await cv.convertToBlob({ type: 'image/jpeg', quality: 0.6 }));
    const cv = new OffscreenCanvas(64, 64), g = cv.getContext('2d');
    if (m.kind === 'image') {
      const bmp = await createImageBitmap(m.file);
      g.drawImage(bmp, 0, 0, 64, 64); bmp.close();
      return toUrl(cv);
    }
    const MB = await loadMb();
    const input = new MB.Input({ source: new MB.BlobSource(m.file), formats: MB.ALL_FORMATS });
    try {
      const track = await input.getPrimaryVideoTrack();
      const frame = await new MB.CanvasSink(track, { width: 64, height: 64, fit: 'cover' }).getCanvas(Math.min(0.2, m.duration / 2));
      if (!frame) return null;
      g.drawImage(frame.canvas, 0, 0);
      return toUrl(cv);
    } finally { input.dispose?.(); }
  }
  /** Loudest level per 1/100 s, for drawing the waveform on the timeline. */
  async function peaks(file) {
    const MB = await loadMb();
    const input = new MB.Input({ source: new MB.BlobSource(file), formats: MB.ALL_FORMATS });
    try {
      const track = await input.getPrimaryAudioTrack();
      if (!track) return null;
      const out = new Float32Array(Math.ceil((await input.computeDuration()) * 100) + 1);
      const sink = new MB.AudioBufferSink(track);
      let n = 0;
      for await (const { buffer, timestamp } of sink.buffers()) {
        const d = buffer.getChannelData(0), rate = buffer.sampleRate;
        for (let i = 0; i < d.length; i += 8) {
          const k = Math.floor((timestamp + i / rate) * 100), v = Math.abs(d[i]);
          if (k >= 0 && k < out.length && v > out[k]) out[k] = v;
        }
        if (++n % 200 === 0) await new Promise(r => setTimeout(r)); // stay responsive on long files
      }
      return out;
    } finally { input.dispose?.(); }
  }
  async function extractPcm(file, onProgress) {
    const MB = await loadMb();
    const input = new MB.Input({ source: new MB.BlobSource(file), formats: MB.ALL_FORMATS });
    const track = await input.getPrimaryAudioTrack();
    if (!track) throw new Error('ຄິບນີ້ບໍ່ມີສຽງ');
    const target = new MB.BufferTarget();
    const output = new MB.Output({ format: new MB.WavOutputFormat(), target });
    const conversion = await MB.Conversion.init({
      input, output,
      video: { discard: true },
      audio: { numberOfChannels: 1, sampleRate: 16000, codec: 'pcm-f32', forceTranscode: true },
    });
    conversion.onProgress = onProgress;
    await conversion.execute();
    // A WAV header is followed by raw 32-bit floats: find the data chunk.
    const buf = target.buffer, view = new DataView(buf);
    let at = 12;
    while (at + 8 <= buf.byteLength) {
      const id = String.fromCharCode(view.getUint8(at), view.getUint8(at + 1), view.getUint8(at + 2), view.getUint8(at + 3));
      const size = view.getUint32(at + 4, true);
      if (id === 'data') return new Float32Array(buf.slice(at + 8, at + 8 + Math.min(size, buf.byteLength - at - 8)));
      at += 8 + size + (size % 2);
    }
    throw new Error('ອ່ານສຽງບໍ່ໄດ້');
  }

  let worker = null;
  function cancelTranscribe() { if (worker) { worker.terminate(); worker = null; } }
  async function transcribe(video, script, getPcm, onStatus) {
    onStatus('ກຳລັງແຍກສຽງ', 0);
    const fresh = getPcm ? await getPcm() : await extractPcm(video.file, p => onStatus('ກຳລັງແຍກສຽງ', p));
    const audio = new Float32Array(fresh); // its own buffer, so it can be handed to the worker
    return new Promise((ok, no) => {
      cancelTranscribe();
      worker = new Worker('ctc-worker.js', { type: 'module' });
      worker.onerror = e => { cancelTranscribe(); no(new Error(`ເປີດຕົວຟັງສຽງບໍ່ໄດ້ ກະລຸນາກວດເນັດ (${e.message || 'worker'})`)); };
      worker.onmessage = ({ data }) => {
        if (data.type === 'download') onStatus(`ໂຫຼດຕົວຟັງສຽງ (ຄັ້ງທຳອິດເທົ່ານັ້ນ) ${(data.loaded / 1048576).toFixed(0)}/${(data.total / 1048576).toFixed(0)} MB`, data.loaded / data.total);
        else if (data.type === 'ready') { console.log('speech threads:', data.threads); onStatus('ກຳລັງຟັງສຽງ', 0); }
        else if (data.type === 'progress') onStatus('ກຳລັງຟັງສຽງ', data.p);
        else if (data.type === 'done') {
          cancelTranscribe();
          ok(data.aligned || window.LaoAlign.buildResultFromChars(script || '', data.chars, video.duration));
        } else if (data.type === 'error') { cancelTranscribe(); no(new Error(`ຟັງສຽງບໍ່ສຳເລັດ ກະລຸນາກວດເນັດແລ້ວລອງໃໝ່ (${data.error})`)); }
      };
      worker.postMessage({ audio, base: new URL('./', location.href).href, script: (script || '').trim() }, [audio.buffer]);
    });
  }

  // ---- Export: decode, draw captions, encode, keep the audio as it is ------------------------
  let lastExportFile = null;
  async function openTarget(MB) {
    // Writing to the browser's private disk keeps long clips out of memory.
    try {
      const dir = await navigator.storage.getDirectory();
      for await (const name of dir.keys()) if (name.startsWith('cs-export-')) await dir.removeEntry(name).catch(() => {});
      const name = `cs-export-${Date.now()}.mp4`;
      const handle = await dir.getFileHandle(name, { create: true });
      const writable = await handle.createWritable();
      return { target: new MB.StreamTarget(writable, { chunked: true }), finish: () => handle.getFile(), fastStart: false, discard: () => dir.removeEntry(name).catch(() => {}) };
    } catch {
      const target = new MB.BufferTarget();
      return { target, finish: async () => new Blob([target.buffer], { type: 'video/mp4' }), fastStart: 'in-memory', discard: async () => {} };
    }
  }
  async function exportMp4(payload, video, onProgress, isCancelled) {
    const { drawChunk } = window.CaptionRender;
    const MB = await loadMb();
    const W = video.width - (video.width % 2), H = video.height - (video.height % 2);
    let codec = null;
    for (const c of ['avc', 'hevc', 'vp9', 'av1']) {
      if (await MB.canEncodeVideo(c, { width: W, height: H })) { codec = c; break; }
    }
    if (!codec) throw new Error('browser ນີ້ບໍ່ຮອງຮັບການສ້າງວິດີໂອ ກະລຸນາໃຊ້ Chrome ລຸ້ນໃໝ່');
    const input = new MB.Input({ source: new MB.BlobSource(video.file), formats: MB.ALL_FORMATS });
    const out = await openTarget(MB);
    const output = new MB.Output({ format: new MB.Mp4OutputFormat({ fastStart: out.fastStart }), target: out.target });
    const canvas = new OffscreenCanvas(W, H);
    const ctx = canvas.getContext('2d');
    const { chunks, style, pos, offset } = payload;
    const chunkAt = t => chunks.find(c => t >= c.start && t < c.end) || null;
    const conversion = await MB.Conversion.init({
      input, output,
      video: {
        codec,
        bitrate: MB.QUALITY_VERY_HIGH,
        forceTranscode: true,
        processedWidth: W,
        processedHeight: H,
        process: sample => {
          sample.drawWithFit(ctx, { fit: 'fill' });
          const t = sample.timestamp - offset;
          const ch = chunkAt(t);
          if (ch) drawChunk(ctx, W, H, ch, t, style, ch.pos || pos);
          return canvas;
        },
      },
    });
    if (!conversion.isValid) throw new Error('ສ້າງວິດີໂອຈາກຄິບນີ້ບໍ່ໄດ້');
    conversion.onProgress = p => {
      onProgress(p);
      if (isCancelled()) conversion.cancel();
    };
    try {
      await conversion.execute();
    } catch (e) {
      await out.discard();
      if (e instanceof MB.ConversionCanceledError || isCancelled()) return null;
      throw e;
    }
    if (isCancelled()) { await out.discard(); return null; }
    return finishExport(await out.finish(), `${video.name.replace(/\.[^.]+$/, '')}_caps.mp4`, codec);
  }
  function finishExport(blob, name, codec) {
    const file = new File([blob], name, { type: 'video/mp4' });
    lastExportFile = file;
    return { file: file.name, size: file.size, url: URL.createObjectURL(file), blob: file, codec };
  }
  const shareLastExport = () => navigator.share({ files: [lastExportFile], title: lastExportFile.name });
  const canShare = () => !!(lastExportFile && navigator.canShare && navigator.canShare({ files: [lastExportFile] }));

  window.CS_BACKEND = { peaks, mediabunny: loadMb, openTarget, finishExport, probe, thumbnail, fonts, addFont, loadPresets, savePresets, openFile, transcribe, cancelTranscribe, exportMp4, shareLastExport, canShare };

  // The old Whisper model isn't used any more: give its 300 MB back to the phone.
  if (self.caches) ['transformers-cache', 'caption-studio-v1'].forEach(name => caches.delete(name).catch(() => {}));

  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js').then(async reg => {
      if (self.crossOriginIsolated) return;
      // Not isolated yet (first visit, or an older helper was in charge): once the new one is active, reload so
      // the speech model can use all CPU cores. Two tries at most, so it can never loop.
      const tries = Number(sessionStorage.getItem('cs.isolating') || 0);
      if (tries >= 2) return;
      const pending = reg.installing || reg.waiting;
      if (pending) await new Promise(ok => pending.addEventListener('statechange', () => { if (pending.state === 'activated') ok(); }));
      if (!navigator.serviceWorker.controller) await new Promise(ok => navigator.serviceWorker.addEventListener('controllerchange', ok, { once: true }));
      sessionStorage.setItem('cs.isolating', String(tries + 1));
      location.reload();
    }).catch(() => {});
  }
})();
