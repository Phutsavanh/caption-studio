/* The video editor: a timeline of clips, overlays and sound. Preview and export draw through the same compose(),
   so what plays is what gets saved. Captions stay attached to the footage when clips are cut or moved. */
(function () {
  const freshTracks = () => ({ video: { lock: false, mute: false }, overlay: { lock: false, hide: false }, audio: { lock: false, mute: false }, caps: { lock: false, hide: false } });
  const T = { canvas: { w: 1080, h: 1920, bg: '#000000' }, clips: [], overlays: [], audio: [], captionsFree: false, tracks: freshTracks() };
  const media = new Map();
  const ui = { pps: 40, selected: null, primaryWord: null, sel: new Set(), capSel: new Set(), multi: false, snap: true, clock: 0, playing: false, drag: null, marquee: null, lastNow: 0, lastPointer: 'mouse' };
  const uid = () => Math.random().toString(36).slice(2, 10);
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const el = id => document.getElementById(id);

  // ---------- Layout ----------
  function layout() {
    const items = [];
    let t = 0;
    T.clips.forEach((clip, i) => {
      const dur = Math.max(0.05, (clip.out - clip.in) / clip.speed);
      const prev = items[i - 1];
      const overlap = i > 0 && clip.trans !== 'none' ? Math.min(clip.transDur, dur / 2, (prev.end - prev.start) / 2) : 0;
      const start = t - overlap;
      items.push({ clip, start, end: start + dur, overlap });
      t = start + dur;
    });
    return { items, videoEnd: t };
  }
  function total() {
    let end = layout().videoEnd;
    T.overlays.forEach(o => { end = Math.max(end, o.start + o.dur); });
    T.audio.forEach(a => { end = Math.max(end, a.start + (a.out - a.in)); });
    return end;
  }

  // ---------- Captions follow the footage ----------
  function remapCaptions(before, after) {
    if (T.captionsFree || !S.words.length) return;
    const map = t => {
      const old = before.items.find(i => t >= i.start && t < i.end) || (t >= before.videoEnd ? before.items[before.items.length - 1] : null);
      if (!old) return null;
      const src = old.clip.in + (t - old.start) * old.clip.speed;
      const candidates = after.items.filter(i => i.clip.m === old.clip.m && src >= i.clip.in - 0.001 && src < i.clip.out);
      if (!candidates.length) return null;
      const hit = candidates.find(i => i.clip.id === old.clip.id) || candidates[0];
      return hit.start + (src - hit.clip.in) / hit.clip.speed;
    };
    const kept = [];
    for (const w of S.words) {
      const a = map(w.start);
      if (a == null) continue;
      const b = map(Math.max(w.start, w.end - 0.001));
      w.end = b == null || b < a ? a + (w.end - w.start) : b;
      w.start = a;
      kept.push(w);
    }
    kept.sort((x, y) => x.start - y.start);
    S.words = kept;
    rebuild();
  }
  /** Every change to the timeline goes through here. */
  function edit(fn, { keepCaptions = false } = {}) {
    const before = layout();
    fn();
    if (!keepCaptions) remapCaptions(before, layout());
    ui.clock = clamp(ui.clock, 0, total());
    syncVideo();
    render();
    renderInspector();
    commit();
  }
  function syncVideo() {
    if (!T.clips.length && !T.audio.length) { S.video = null; stage.classList.add('demo'); }
    else {
      const anyAudio = T.audio.length > 0 || T.clips.some(c => (media.get(c.m) || {}).hasAudio && !c.muted);
      S.video = { id: 'timeline', tl: true, name: (media.get((T.clips[0] || T.audio[0]).m) || { name: 'project' }).name, width: T.canvas.w, height: T.canvas.h, duration: total(), hasAudio: anyAudio };
      stage.classList.remove('demo');
    }
    $('clipName').textContent = S.video ? `${T.clips.length} ຄິບ` : '';
    fitStage();
  }

  // ---------- Bringing files in ----------
  async function addMedia(file) {
    const id = `${file.name}|${file.size}|${file.lastModified}`;
    if (media.has(id) && media.get(id).file) return media.get(id);
    const known = media.get(id) || {};
    const info = await window.CS_BACKEND.probe(file);
    const m = { ...known, id, name: file.name, file, url: URL.createObjectURL(file), ...info };
    media.set(id, m);
    window.CS_BACKEND.thumbnail(m).then(url => { m.thumb = url; render(); }).catch(() => {});
    return m;
  }
  async function addFiles(files) {
    const list = [...files];
    const wasEmpty = !T.clips.length;
    let added = 0;
    for (const f of list) {
      const id = `${f.name}|${f.size}|${f.lastModified}`;
      const relink = media.has(id) && !media.get(id).file;
      const m = await addMedia(f);
      if (relink) { added++; continue; }
      if (m.kind === 'audio') { addAudioItem(m, f.name); continue; }
      if (m.kind === 'image') {
        edit(() => { T.clips.push(newClip(m, 0, 4)); }, { keepCaptions: true });
      } else {
        if (wasEmpty && !added) { T.canvas.w = m.width - (m.width % 2); T.canvas.h = m.height - (m.height % 2); }
        edit(() => { T.clips.push(newClip(m, 0, m.duration)); }, { keepCaptions: true });
      }
      added++;
    }
    if (missingMedia().length) relinkNotice(); else if ($('notice').textContent.startsWith('ເລືອກໄຟລ໌ເດີມ')) setNotice('');
    render();
    return added;
  }
  const newClip = (m, a, b) => ({ id: uid(), m: m.id, in: a, out: b, speed: 1, volume: 1, muted: false, fit: 'cover', zoom: 1, x: 0, y: 0, bright: 1, contrast: 1, sat: 1, trans: 'none', transDur: 0.5 });
  function addAudioItem(m, name, opts = {}) {
    edit(() => {
      T.audio.push({ id: uid(), m: m.id, name, start: opts.start ?? ui.clock, in: 0, out: m.duration, volume: opts.volume ?? (/\b(voice|vo)\b/i.test(name) ? 1 : 0.35), fadeIn: 0, fadeOut: 0, kind: opts.kind || 'music' });
    }, { keepCaptions: true });
  }
  async function addOverlay(file) {
    const m = await addMedia(file);
    edit(() => {
      T.overlays.push({ id: uid(), m: m.id, start: ui.clock, in: 0, dur: m.kind === 'video' ? Math.min(m.duration, 5) : 3, x: 0.5, y: 0.25, scale: 0.35, opacity: 1, fadeIn: 0.2, fadeOut: 0.2 });
    }, { keepCaptions: true });
    select('overlay', T.overlays[T.overlays.length - 1].id);
  }
  /** Starts over. The clips themselves stay on the device: only the project is cleared. */
  function clearProject() {
    pauseAll();
    T.clips = []; T.overlays = []; T.audio = []; T.captionsFree = false;
    media.clear();
    els.clear(); auds.clear();
    clearSelection(); ui.clock = 0;
    T.tracks = freshTracks();
    S.words = []; S.script = ''; S.draft = false;
    $('script').value = '';
    setNotice('');
    rebuild();
    syncVideo(); render(); renderInspector(); commit();
  }
  function missingMedia() { return [...media.values()].filter(m => !m.file); }
  function relinkNotice() {
    const missing = missingMedia();
    if (missing.length) setNotice(`ເລືອກໄຟລ໌ເດີມຄືນເພື່ອເຮັດວຽກຕໍ່: ${missing.map(m => m.name).slice(0, 3).join(', ')}`);
  }

  // ---------- Drawing (shared by preview and export) ----------
  function drawFit(ctx, img, iw, ih, W, H, c) {
    const fitScale = c.fit === 'contain' ? Math.min(W / iw, H / ih) : Math.max(W / iw, H / ih);
    const s = fitScale * (c.zoom || 1), dw = iw * s, dh = ih * s;
    const dx = (W - dw) / 2 + (c.x || 0) * W, dy = (H - dh) / 2 + (c.y || 0) * H;
    const custom = c.bright !== 1 || c.contrast !== 1 || c.sat !== 1;
    if (custom) ctx.filter = `brightness(${c.bright}) contrast(${c.contrast}) saturate(${c.sat})`;
    ctx.drawImage(img, dx, dy, dw, dh);
    if (custom) ctx.filter = 'none';
  }
  /** getSource(kind, item, sourceSeconds) -> { img, w, h } or null */
  function compose(ctx, W, H, t, lay, getSource) {
    ctx.save();
    ctx.fillStyle = T.canvas.bg;
    ctx.fillRect(0, 0, W, H);
    const active = lay.items.filter(i => t >= i.start && t < i.end);
    if (!active.length && lay.items.length && t >= lay.videoEnd) active.push(lay.items[lay.items.length - 1]);
    for (const it of active) {
      const src = it.clip.in + (Math.min(t, it.end - 0.001) - it.start) * it.clip.speed;
      const s = getSource('clip', it.clip, src);
      if (!s) continue;
      const p = it.overlap > 0 ? clamp((t - it.start) / it.overlap, 0, 1) : 1;
      ctx.save();
      if (p < 1) {
        const type = it.clip.trans;
        if (type === 'fade') ctx.globalAlpha = p;
        else if (type === 'slide') ctx.translate((1 - p) ** 2 * W, 0);
        else if (type === 'slideUp') ctx.translate(0, (1 - p) ** 2 * H);
        else if (type === 'zoom') { const k = 1.35 - 0.35 * p; ctx.globalAlpha = p; ctx.translate(W / 2, H / 2); ctx.scale(k, k); ctx.translate(-W / 2, -H / 2); }
      }
      drawFit(ctx, s.img, s.w, s.h, W, H, it.clip);
      ctx.restore();
    }
    for (const o of T.tracks.overlay.hide ? [] : T.overlays) {
      if (t < o.start || t >= o.start + o.dur) continue;
      const s = getSource('overlay', o, o.in + (t - o.start));
      if (!s) continue;
      const local = t - o.start;
      let a = o.opacity;
      if (o.fadeIn > 0) a *= clamp(local / o.fadeIn, 0, 1);
      if (o.fadeOut > 0) a *= clamp((o.dur - local) / o.fadeOut, 0, 1);
      const dw = o.scale * W, dh = dw * s.h / s.w;
      ctx.globalAlpha = a;
      ctx.drawImage(s.img, o.x * W - dw / 2, o.y * H - dh / 2, dw, dh);
      ctx.globalAlpha = 1;
    }
    ctx.restore();
  }

  // ---------- Preview ----------
  let base = null, bctx = null;
  const els = new Map();   // clip/overlay id -> <video> or <img>
  const auds = new Map();  // audio item id -> <audio>
  function elementFor(item, muted) {
    let e = els.get(item.id);
    if (e && e.dataset.m === item.m) return e;
    const m = media.get(item.m);
    if (!m || !m.file) return null;
    if (m.kind === 'image') { e = new Image(); e.src = m.url; } else {
      e = document.createElement('video');
      e.playsInline = true; e.preload = 'auto'; e.muted = !!muted; e.src = m.url;
    }
    e.dataset.m = item.m;
    els.set(item.id, e);
    return e;
  }
  function previewSource(kind, item, src) {
    const e = elementFor(item, kind === 'overlay');
    if (!e) return null;
    if (e.tagName === 'IMG') return e.complete && e.naturalWidth ? { img: e, w: e.naturalWidth, h: e.naturalHeight } : null;
    if (e.readyState < 2) return null;
    return { img: e, w: e.videoWidth, h: e.videoHeight };
  }
  function syncVideoEl(e, src, rate, volume) {
    if (!e || e.tagName !== 'VIDEO') return;
    if (ui.playing) {
      if (e.playbackRate !== rate) e.playbackRate = rate;
      e.volume = clamp(volume, 0, 1);
      if (e.paused) e.play().catch(() => {});
      if (Math.abs(e.currentTime - src) > 0.3) e.currentTime = src;
    } else {
      if (!e.paused) e.pause();
      if (Math.abs(e.currentTime - src) > 0.03 && !e.seeking) e.currentTime = src;
    }
  }
  function tick(now) {
    if (!base || !S.video || exporting) return;
    const dt = (now - ui.lastNow) / 1000;
    ui.lastNow = now;
    const tot = total();
    if (ui.playing) {
      const heard = soundClock();
      ui.clock = heard != null ? heard : ui.clock + Math.min(dt, 0.25);
      if (ui.clock >= tot) { ui.clock = tot; ui.playing = false; pauseAll(); }
    }
    const lay = layout(), t = ui.clock;
    const r = base.getBoundingClientRect(), dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = Math.round(r.width * dpr), H = Math.round(r.height * dpr);
    if (base.width !== W || base.height !== H) { base.width = W; base.height = H; }
    const live = new Set();
    lay.items.forEach((it, i) => {
      const isActive = t >= it.start && t < it.end;
      const soon = t < it.start && it.start - t < 1.5;
      if (!isActive && !soon && !(i === lay.items.length - 1 && t >= it.end)) return;
      live.add(it.clip.id);
      const e = elementFor(it.clip, false);
      if (!isActive) {
        if (e && e.tagName === 'VIDEO') { if (!e.paused) e.pause(); if (Math.abs(e.currentTime - it.clip.in) > 0.2) e.currentTime = it.clip.in; }
        return;
      }
      const src = it.clip.in + (t - it.start) * it.clip.speed;
      const p = it.overlap > 0 ? clamp((t - it.start) / it.overlap, 0, 1) : 1;
      const next = lay.items[i + 1];
      const fadeOut = next && next.overlap > 0 ? clamp((it.end - t) / next.overlap, 0, 1) : 1;
      syncVideoEl(e, src, it.clip.speed, it.clip.muted || T.tracks.video.mute ? 0 : it.clip.volume * p * fadeOut);
    });
    for (const o of T.overlays) {
      if (t < o.start - 1 || t >= o.start + o.dur) continue;
      live.add(o.id);
      const e = elementFor(o, true);
      if (t >= o.start) syncVideoEl(e, o.in + (t - o.start), 1, 0);
    }
    for (const [id, e] of els) {
      if (!live.has(id)) { if (e.tagName === 'VIDEO') { e.pause(); e.removeAttribute('src'); e.load(); } els.delete(id); }
    }
    syncAudio(t);
    compose(bctx, W, H, t, lay, previewSource);
    drawPlayhead(t, tot);
  }
  /** The playing element's own position is the truth: a timer drifts away from what you actually hear. */
  function soundClock() {
    const t = ui.clock;
    const running = e => e && !e.paused && !e.seeking && e.readyState >= 3;
    for (const a of T.audio) {
      if (T.tracks.audio.mute || a.kind !== 'voice' || t < a.start || t >= a.start + (a.out - a.in)) continue;
      const e = auds.get(a.id);
      if (running(e)) return a.start + (e.currentTime - a.in);
    }
    for (const it of layout().items) {
      if (t < it.start || t >= it.end) continue;
      const e = els.get(it.clip.id);
      if (it.overlap <= 0 && running(e) && e.tagName === 'VIDEO' && !it.clip.muted && !T.tracks.video.mute) return it.start + (e.currentTime - it.clip.in) / it.clip.speed;
    }
    return null;
  }
  function syncAudio(t) {
    for (const a of T.audio) {
      const m = media.get(a.m);
      if (!m || !m.file) continue;
      let e = auds.get(a.id);
      if (!e) { e = new Audio(m.url); e.preload = 'auto'; auds.set(a.id, e); }
      const dur = a.out - a.in, local = t - a.start;
      if (!ui.playing || local < 0 || local >= dur) { if (!e.paused) e.pause(); continue; }
      let v = a.volume;
      if (a.fadeIn > 0) v *= clamp(local / a.fadeIn, 0, 1);
      if (a.fadeOut > 0) v *= clamp((dur - local) / a.fadeOut, 0, 1);
      e.volume = T.tracks.audio.mute ? 0 : clamp(v, 0, 1);
      if (e.paused) { e.currentTime = a.in + local; e.play().catch(() => {}); } else if (Math.abs(e.currentTime - (a.in + local)) > 0.3) e.currentTime = a.in + local;
    }
    for (const [id, e] of auds) if (!T.audio.some(a => a.id === id)) { e.pause(); auds.delete(id); }
  }
  function pauseAll() {
    ui.playing = false;
    for (const e of els.values()) if (e.tagName === 'VIDEO') e.pause();
    for (const e of auds.values()) e.pause();
  }

  // ---------- Timeline UI ----------
  const LANE = { clip: 44, overlay: 26, audio: 34, cap: 28 };
  const fmtT = v => (ui.pps > 90 ? `${Math.floor(v / 60)}:${(v % 60).toFixed(1).padStart(4, '0')}` : `${Math.floor(v / 60)}:${String(Math.floor(v % 60)).padStart(2, '0')}`);

  // ---- Selection: any number of items; the last one touched is "primary" and fills the inspector ----
  const keyOf = (kind, item) => (kind === 'cap' ? null : `${kind}:${item.id}`);
  const isSelected = (kind, item) => (kind === 'cap' ? ui.capSel.has(item.words[0]) : ui.sel.has(keyOf(kind, item)));
  const listFor = kind => (kind === 'clip' ? T.clips : kind === 'overlay' ? T.overlays : T.audio);
  const trackOf = kind => ({ clip: 'video', overlay: 'overlay', audio: 'audio', cap: 'caps' }[kind]);
  const locked = kind => T.tracks[trackOf(kind)].lock;
  function setPrimary(kind, item) {
    if (!item) { ui.selected = null; ui.primaryWord = null; return; }
    ui.primaryWord = kind === 'cap' ? item.words[0] : null;
    ui.selected = { kind, id: kind === 'cap' ? 'cap' : item.id };
  }
  const selectedItem = () => {
    if (!ui.selected) return null;
    if (ui.selected.kind === 'cap') return S.chunks.find(c => c.words[0] === ui.primaryWord) || null;
    return listFor(ui.selected.kind).find(x => x.id === ui.selected.id) || null;
  };
  function clearSelection() { ui.sel.clear(); ui.capSel.clear(); setPrimary(null); }
  function addToSelection(kind, item) {
    if (kind === 'cap') ui.capSel.add(item.words[0]); else ui.sel.add(keyOf(kind, item));
    setPrimary(kind, item);
  }
  function removeFromSelection(kind, item) {
    if (kind === 'cap') ui.capSel.delete(item.words[0]); else ui.sel.delete(keyOf(kind, item));
    const rest = selectionList();
    setPrimary(rest.length ? rest[rest.length - 1].kind : null, rest.length ? rest[rest.length - 1].item : null);
  }
  function selectionList() {
    const out = [];
    for (const kind of ['clip', 'overlay', 'audio']) for (const item of listFor(kind)) if (ui.sel.has(keyOf(kind, item))) out.push({ kind, item });
    for (const c of S.chunks) if (ui.capSel.has(c.words[0])) out.push({ kind: 'cap', item: c });
    return out;
  }
  /** Kept for callers that pick one item or none. */
  function select(kind, id) {
    clearSelection();
    if (id) {
      const item = kind === 'cap' ? S.chunks[Number(String(id).slice(1))] : listFor(kind).find(x => x.id === id);
      if (item) addToSelection(kind, item);
    }
    render(); renderInspector();
    if (id) showTab('clip');
  }
  function refreshAfterSelection(item, kind) {
    if (kind === 'cap' && item && selectionList().length === 1) { S.selected = item.idx; TL.seek(item.start + S.offset + 0.001); renderChunkList(); }
    render(); renderInspector();
    if (selectionList().length) showTab('clip');
  }
  /** Click logic shared by mouse and touch. Shift picks a run of captions; Ctrl or the multi button adds one. */
  function clickSelect(kind, item, e) {
    const add = e.ctrlKey || e.metaKey || ui.multi;
    if (e.shiftKey && kind === 'cap' && ui.primaryWord) {
      const from = S.chunks.findIndex(c => c.words[0] === ui.primaryWord), to = item.idx;
      for (let i = Math.min(from, to); i <= Math.max(from, to); i++) ui.capSel.add(S.chunks[i].words[0]);
      setPrimary(kind, item);
    } else if (add) {
      if (isSelected(kind, item)) removeFromSelection(kind, item); else addToSelection(kind, item);
    } else {
      clearSelection();
      addToSelection(kind, item);
    }
    refreshAfterSelection(item, kind);
  }
  const itemOfBlock = b => {
    const kind = b.dataset.kind;
    return { kind, item: kind === 'cap' ? S.chunks[Number(b.dataset.id.slice(1))] : listFor(kind).find(x => x.id === b.dataset.id) };
  };

  // ---- Waveforms ----
  const peaksFor = m => {
    if (!m || !m.file || !m.hasAudio) return null;
    if (m.peaks) return m.peaks;
    if (!m.peaksStarted) {
      m.peaksStarted = true;
      window.CS_BACKEND.peaks(m.file).then(p => { m.peaks = p; scheduleRender(); }).catch(() => {});
    }
    return null;
  };
  function drawWave(b, m, from, rate, width, color) {
    const peaks = peaksFor(m);
    if (!peaks || width < 4) return;
    const w = Math.min(4000, Math.floor(width)), h = b.clientHeight || 30;
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h; cv.className = 'tlwave';
    const g = cv.getContext('2d');
    g.fillStyle = color;
    const perPx = rate / ui.pps * 100; // peaks are stored at 100 per second
    for (let x = 0; x < w; x += 2) {
      const i = Math.floor(from * 100 + x * perPx), j = Math.max(i + 1, Math.floor(i + perPx * 2));
      let top = 0;
      for (let k = i; k < j && k < peaks.length; k++) if (peaks[k] > top) top = peaks[k];
      const bar = Math.max(1, Math.min(1, top * 1.4) * h);
      g.fillRect(x, h - bar, 1.5, bar);
    }
    b.appendChild(cv);
  }

  // ---- Drawing the tracks ----
  function lanes(items, startOf, endOf) {
    const ends = [], out = new Map();
    [...items].sort((a, b) => startOf(a) - startOf(b)).forEach(it => {
      let lane = ends.findIndex(e => e <= startOf(it) + 0.001);
      if (lane < 0) { lane = ends.length; ends.push(0); }
      ends[lane] = endOf(it);
      out.set(it, lane);
    });
    return { of: out, count: Math.max(1, ends.length) };
  }
  function block(kind, item, id, left, width, label, track, lane, laneH) {
    const b = document.createElement('div');
    const sel = isSelected(kind, item);
    const primary = sel && selectedItem() === item;
    b.className = `tlb ${kind}${sel ? ' on' : ''}${primary ? ' primary' : ''}${locked(kind) ? ' lock' : ''}`;
    b.style.left = `${left}px`; b.style.width = `${Math.max(6, width)}px`;
    b.style.top = `${lane * laneH + 1}px`; b.style.height = `${laneH - 2}px`;
    b.dataset.kind = kind; b.dataset.id = id;
    const m = kind === 'cap' ? null : media.get(item.m);
    if (m && m.thumb && kind === 'overlay') b.style.backgroundImage = `url(${m.thumb})`;
    if (kind !== 'cap' && (!m || !m.file)) b.classList.add('missing');
    const name = document.createElement('span'); name.textContent = label; b.appendChild(name);
    if (primary && !locked(kind)) {
      const l = document.createElement('i'); l.className = 'h l'; l.dataset.edge = 'l';
      const r = document.createElement('i'); r.className = 'h r'; r.dataset.edge = 'r';
      b.append(l, r);
    }
    track.appendChild(b);
    return b;
  }
  let renderQueued = false;
  function scheduleRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => { renderQueued = false; render(); });
  }
  function render() {
    const host = el('tlTracks');
    if (!host) return;
    const lay = layout(), tot = total(), pps = ui.pps;
    const inner = el('tlInner');
    inner.style.width = `${Math.max(host.clientWidth, (tot + 5) * pps)}px`;

    const ruler = el('tlRuler');
    ruler.textContent = '';
    const step = [0.1, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300].find(s => s * pps >= 64) || 600;
    const sub = step / (step >= 5 || step === 0.5 ? 5 : 2);
    for (let i = 0, end = tot + 5; i * sub <= end; i++) {
      const s = i * sub, major = Math.abs(s / step - Math.round(s / step)) < 1e-6;
      const k = document.createElement(major ? 'b' : 'u');
      k.style.left = `${s * pps}px`;
      if (major) k.textContent = fmtT(s);
      ruler.appendChild(k);
    }

    const rows = { video: el('tlVideo'), overlay: el('tlOverlay'), audio: el('tlAudio'), caps: el('tlCaps') };
    Object.values(rows).forEach(r => { r.textContent = ''; });
    rows.video.style.height = `${LANE.clip}px`;
    lay.items.forEach((it, i) => {
      const m = media.get(it.clip.m), w = (it.end - it.start) * pps;
      const b = block('clip', it.clip, it.clip.id, it.start * pps, w, `${it.clip.speed !== 1 ? `${it.clip.speed}x ` : ''}${m ? m.name : '?'}`, rows.video, 0, LANE.clip);
      if (m && m.thumb) { b.style.backgroundImage = `url(${m.thumb})`; }
      if (m && m.hasAudio && !it.clip.muted) drawWave(b, m, it.clip.in, it.clip.speed, w, 'rgba(120,255,190,.75)');
      if (i > 0 && it.clip.trans !== 'none') { const d = document.createElement('em'); d.textContent = '⧖'; b.appendChild(d); }
    });
    const ol = lanes(T.overlays, o => o.start, o => o.start + o.dur);
    const olH = T.overlays.length ? ol.count * LANE.overlay : 16; // empty tracks stay small so the captions remain in view
    rows.overlay.style.height = `${olH}px`;
    T.overlays.forEach(o => block('overlay', o, o.id, o.start * pps, o.dur * pps, (media.get(o.m) || {}).name || '?', rows.overlay, ol.of.get(o), LANE.overlay));
    const al = lanes(T.audio, a => a.start, a => a.start + (a.out - a.in));
    const alH = T.audio.length ? al.count * LANE.audio : 16;
    rows.audio.style.height = `${alH}px`;
    T.audio.forEach(a => {
      const w = (a.out - a.in) * pps, m = media.get(a.m);
      const b = block('audio', a, a.id, a.start * pps, w, `${a.kind === 'voice' ? '🎙' : '🎵'} ${a.name || ''}`, rows.audio, al.of.get(a), LANE.audio);
      if (m) drawWave(b, m, a.in, 1, w, 'rgba(190,255,225,.85)');
    });
    rows.caps.style.height = `${LANE.cap}px`;
    S.chunks.forEach((c, i) => {
      const b = block('cap', c, `c${i}`, (c.start + S.offset) * pps, (c.end - c.start) * pps - 1, c.text, rows.caps, 0, LANE.cap);
      b.title = c.text;
    });
    renderHeads({ video: LANE.clip, overlay: olH, audio: alH, caps: LANE.cap });

    const count = selectionList().length, any = T.clips.length + T.audio.length + S.chunks.length > 0;
    ['tlSplit', 'tlDup'].forEach(id => { el(id).disabled = !any; });
    el('tlDelete').disabled = !count;
    el('tlCount').textContent = count > 1 ? `ເລືອກ ${count}` : '';
    el('tlMulti').classList.toggle('active', !!ui.multi);
    el('tlSnapBtn').classList.toggle('active', ui.snap);
    drawPlayhead(ui.clock, tot);
  }
  function renderHeads(heights) {
    const host = el('tlHeads');
    host.textContent = '';
    const spacer = document.createElement('div'); spacer.className = 'tlhead ruler'; host.appendChild(spacer);
    [['video', '🎞', 'ວິດີໂອ', 'mute', '🔊', '🔇'], ['overlay', '🖼', 'ຊ້ອນ', 'hide', '👁', '🚫'], ['audio', '🎵', 'ສຽງ', 'mute', '🔊', '🔇'], ['caps', 'Aa', 'ຟ້ອນ', 'hide', '👁', '🚫']].forEach(([track, icon, label, prop, on, off]) => {
      const row = document.createElement('div');
      row.className = 'tlhead'; row.style.height = `${heights[track]}px`;
      const name = document.createElement('span'); name.className = 'nm'; name.innerHTML = `<b>${icon}</b> <small>${label}</small>`;
      const flag = document.createElement('button'); flag.textContent = T.tracks[track][prop] ? off : on; flag.title = prop === 'mute' ? 'ປິດ/ເປີດສຽງແຖວນີ້' : 'ເຊື່ອງ/ສະແດງແຖວນີ້';
      flag.classList.toggle('active', !!T.tracks[track][prop]);
      flag.onclick = () => { T.tracks[track][prop] = !T.tracks[track][prop]; render(); commit(); };
      const lock = document.createElement('button'); lock.textContent = T.tracks[track].lock ? '🔒' : '🔓'; lock.title = 'ລັອກແຖວນີ້ ບໍ່ໃຫ້ແກ້ໂດຍບັງເອີນ';
      lock.classList.toggle('active', !!T.tracks[track].lock);
      lock.onclick = () => { T.tracks[track].lock = !T.tracks[track].lock; render(); commit(); };
      row.append(name, flag, lock);
      host.appendChild(row);
    });
  }
  function drawPlayhead(t, tot) {
    const ph = el('tlHead');
    if (!ph) return;
    const x = t * ui.pps;
    ph.style.left = `${x}px`;
    const host = el('tlTracks');
    if (ui.playing && (x < host.scrollLeft + 20 || x > host.scrollLeft + host.clientWidth - 40)) host.scrollLeft = x - 40;
    el('tlTime').textContent = `${fmt(t)} / ${fmt(tot)}`;
  }
  const timeAtEvent = e => (e.clientX - el('tlInner').getBoundingClientRect().left) / ui.pps;
  const seekTrack = e => { TL.seek(Math.max(0, timeAtEvent(e))); drawPlayhead(ui.clock, total()); };
  function setZoom(pps, anchorX) {
    const host = el('tlTracks');
    const rect = host.getBoundingClientRect();
    const x = anchorX == null ? ui.clock * ui.pps - host.scrollLeft : anchorX - rect.left;
    const at = (host.scrollLeft + x) / ui.pps;
    ui.pps = clamp(pps, ZOOM_MIN, ZOOM_MAX);
    render();
    host.scrollLeft = at * ui.pps - x;
    syncZoomSlider();
  }
  // The zoom slider works on a log scale, so each step feels the same from the whole video down to single frames.
  const ZOOM_MIN = 4, ZOOM_MAX = 1200;
  const zoomToSlider = pps => Math.round(1000 * Math.log(pps / ZOOM_MIN) / Math.log(ZOOM_MAX / ZOOM_MIN));
  const sliderToZoom = v => ZOOM_MIN * Math.pow(ZOOM_MAX / ZOOM_MIN, v / 1000);
  function syncZoomSlider() { const z = el('tlZoom'); if (z) z.value = zoomToSlider(ui.pps); }
  function fitZoom() {
    const host = el('tlTracks');
    ui.pps = clamp((host.clientWidth - 30) / Math.max(1, total()), ZOOM_MIN, ZOOM_MAX);
    render();
    host.scrollLeft = 0;
    syncZoomSlider();
  }

  // ---- Snapping: edges stick to the playhead and to other items, as in an editor ----
  function snapPoints(skip) {
    const pts = [0, ui.clock];
    if (T.clips.length) layout().items.forEach(i => { if (!skip.has(i.clip)) pts.push(i.start, i.end); });
    T.overlays.forEach(o => { if (!skip.has(o)) pts.push(o.start, o.start + o.dur); });
    T.audio.forEach(a => { if (!skip.has(a)) pts.push(a.start, a.start + (a.out - a.in)); });
    S.chunks.forEach(c => { if (!skip.has(c.words[0])) pts.push(c.start, c.end); });
    return pts;
  }
  /** Returns the time nudged onto the nearest point, or unchanged when none is close. */
  function snapTo(times, pts) {
    el('tlGuide').style.display = 'none';
    if (!ui.snap) return 0;
    const reach = 8 / ui.pps;
    let best = 0, dist = reach, at = null;
    for (const t of times) for (const p of pts) {
      const d = Math.abs(p - t);
      if (d < dist) { dist = d; best = p - t; at = p; }
    }
    if (at != null) { const g = el('tlGuide'); g.style.left = `${at * ui.pps}px`; g.style.display = 'block'; }
    return best;
  }

  // ---- Toolbar actions ----
  function splitCaptionAt(c, t) {
    const inside = c.words.findIndex((w, i) => i > 0 && w.start >= t - 0.001);
    const at = inside > 0 ? inside : c.words.length - 1;
    if (c.words.length < 2) { setNotice('ຟ້ອນນີ້ມີຄຳດຽວ ຈຶ່ງຕັດບໍ່ໄດ້. ຕັດຟ້ອນໄດ້ສະເພາະລະຫວ່າງຄຳ'); return; }
    c.words[at - 1].brk = true;
    c.words[at - 1].glue = false;
    rebuild(); commit();
  }
  function split() {
    const lay = layout(), t = ui.clock, sel = selectedItem(), kind = ui.selected && ui.selected.kind;
    if (kind === 'cap' && sel) { splitCaptionAt(sel, t - S.offset); return; }
    if (kind === 'audio' && sel && t > sel.start && t < sel.start + (sel.out - sel.in)) {
      edit(() => { const at = sel.in + (t - sel.start); const b = { ...sel, id: uid(), in: at, start: t }; sel.out = at; T.audio.push(b); }, { keepCaptions: true });
      return;
    }
    if (kind === 'overlay' && sel && t > sel.start && t < sel.start + sel.dur) {
      edit(() => { const d = t - sel.start; const b = { ...sel, id: uid(), start: t, in: sel.in + d, dur: sel.dur - d }; sel.dur = d; T.overlays.push(b); }, { keepCaptions: true });
      return;
    }
    const it = lay.items.find(i => t > i.start + 0.03 && t < i.end - 0.03);
    if (!it) { setNotice('ວາງເສັ້ນເວລາໄວ້ເທິງຄິບກ່ອນ ແລ້ວກົດຕັດ'); return; }
    if (locked('clip')) { setNotice('ແຖວວິດີໂອຖືກລັອກຢູ່'); return; }
    edit(() => {
      const at = it.clip.in + (t - it.start) * it.clip.speed;
      const b = { ...it.clip, id: uid(), in: at, trans: 'none' };
      it.clip.out = at;
      T.clips.splice(T.clips.indexOf(it.clip) + 1, 0, b);
      clearSelection();
      addToSelection('clip', b);
    });
  }
  function removeSelected() {
    const list = selectionList().filter(x => !locked(x.kind));
    if (!list.length) { setNotice('ກົດເລືອກກ່ອນ'); return; }
    const anyClip = list.some(x => x.kind === 'clip');
    const words = new Set(list.filter(x => x.kind === 'cap').flatMap(x => x.item.words));
    // The captions on either side stay as they are, instead of re-flowing into each other.
    list.filter(x => x.kind === 'cap').forEach(({ item }) => { const prev = S.chunks[item.idx - 1]; if (prev) prev.words[prev.words.length - 1].brk = true; });
    const drop = kind => { const gone = new Set(list.filter(x => x.kind === kind).map(x => x.item)); return arr => arr.filter(i => !gone.has(i)); };
    if (words.size) S.words = S.words.filter(w => !words.has(w));
    clearSelection();
    edit(() => {
      T.clips = drop('clip')(T.clips);
      T.overlays = drop('overlay')(T.overlays);
      T.audio = drop('audio')(T.audio);
    }, { keepCaptions: !anyClip });
    if (words.size) rebuild();
  }
  function duplicate() {
    const list = selectionList().filter(x => x.kind !== 'cap');
    if (!list.length) { setNotice('ກົດເລືອກຄິບ, ພາບຊ້ອນ ຫຼື ສຽງກ່ອນ'); return; }
    edit(() => {
      clearSelection();
      for (const { kind, item } of list) {
        const b = { ...item, id: uid() };
        if (kind === 'clip') T.clips.splice(T.clips.indexOf(item) + 1, 0, b);
        else if (kind === 'overlay') { b.start = item.start + item.dur; T.overlays.push(b); } else { b.start = item.start + (item.out - item.in); T.audio.push(b); }
        addToSelection(kind, b);
      }
    });
  }
  /** Trims the selected item's start (or end) to the playhead. */
  function trimToPlayhead(side) {
    const sel = selectedItem(), kind = ui.selected && ui.selected.kind, t = ui.clock;
    if (!sel) { setNotice('ກົດເລືອກກ່ອນ'); return; }
    if (kind === 'cap') {
      const st = captionsState([sel]), a = side === 'l' ? t - S.offset : sel.start, b = side === 'r' ? t - S.offset : sel.end;
      if (b - a < MIN_CAP) return;
      applyCaptions(st, new Map([[sel.idx, [a, b]]]), false);
      commit();
      return;
    }
    edit(() => {
      if (kind === 'clip') {
        const it = layout().items.find(i => i.clip === sel);
        if (!it || t <= it.start || t >= it.end) return;
        const at = sel.in + (t - it.start) * sel.speed;
        if (side === 'l') sel.in = at; else sel.out = at;
      } else if (kind === 'overlay') {
        const end = sel.start + sel.dur;
        if (t <= sel.start || t >= end) return;
        if (side === 'l') { sel.in += t - sel.start; sel.dur = end - t; sel.start = t; } else sel.dur = t - sel.start;
      } else {
        const end = sel.start + (sel.out - sel.in);
        if (t <= sel.start || t >= end) return;
        if (side === 'l') { sel.in += t - sel.start; sel.start = t; } else sel.out = sel.in + (t - sel.start);
      }
    }, { keepCaptions: kind !== 'clip' });
  }
  function selectAll() {
    clearSelection();
    if (!locked('cap')) S.chunks.forEach(c => ui.capSel.add(c.words[0]));
    if (!locked('overlay')) T.overlays.forEach(o => ui.sel.add(keyOf('overlay', o)));
    if (!locked('audio')) T.audio.forEach(a => ui.sel.add(keyOf('audio', a)));
    const c = S.chunks[S.chunks.length - 1];
    if (c) setPrimary('cap', c);
    render(); renderInspector();
  }
  // ---- Caption editing from the timeline ----
  function addCaption() {
    // The new caption takes its room from its neighbours only, so the rest stay in time with the voice.
    // With "ripple" on, everything after it moves along instead.
    const id = Date.now(), ripple = !!ui.capRipple;
    const place = (c, a, b, pin) => {
      c.words[c.words.length - 1].brk = true;
      placeCaption({ words: snapWords(c.words), a: c.start, b: c.end }, a, b, pin);
    };
    let t = Math.max(0, ui.clock - S.offset);
    const cur = S.chunks.find(c => t >= c.start && t < c.end);
    if (cur) t = Math.min(Math.max(t, cur.start + MIN_CAP), cur.end);
    const next = S.chunks.find(c => c.start >= t && c !== cur);
    let end = t + 1;
    if (next && !ripple) end = Math.min(end, Math.max(next.start, next.end - MIN_CAP));
    end = Math.max(end, t + MIN_CAP);
    const w = { text: 'ຂໍ້ຄວາມໃໝ່', spaceAfter: false, line: id, emph: false, start: t, end, brk: true, fixedEnd: true };
    const later = S.chunks.filter(c => c.start >= t && c !== cur);
    if (cur) place(cur, cur.start, t, true);
    if (ripple && next) {
      const shift = Math.max(0, end - next.start);
      later.forEach(c => place(c, c.start + shift, c.end + shift, false));
    } else if (next && next.start < end) place(next, end, next.end, false);
    S.words.push(w);
    S.words.sort((a, b) => a.start - b.start);
    rebuild();
    clearSelection();
    addToSelection('cap', S.chunks.find(c => c.words[0] === w));
    render(); renderInspector(); showTab('clip');
    commit();
    const input = el('capText');
    if (input) { input.focus(); input.select(); }
  }
  function mergeCaptions() {
    const caps = selectionList().filter(x => x.kind === 'cap').map(x => x.item).sort((a, b) => a.idx - b.idx);
    if (caps.length < 2) return;
    for (let i = 1; i < caps.length; i++) if (caps[i].idx !== caps[i - 1].idx + 1) { setNotice('ຮວມໄດ້ສະເພາະຟ້ອນທີ່ຕິດກັນ'); return; }
    const words = caps.flatMap(c => c.words), line = words[0].line;
    words.forEach((w, i) => {
      w.line = line;
      w.brk = i === words.length - 1;
      w.glue = i < words.length - 1;
      if (i < words.length - 1) { w.fixedEnd = false; if (!w.spaceAfter && /[A-Za-z0-9]$/.test(w.text)) w.spaceAfter = true; }
    });
    clearSelection();
    rebuild();
    const merged = S.chunks.find(c => c.words[0] === words[0]);
    if (merged) addToSelection('cap', merged);
    render(); renderInspector(); commit();
  }

  // ---- Moving captions: selected ones move together; unselected neighbours give way at the shared edge. ----
  const MIN_CAP = 0.15;
  const snapWords = list => list.map(w => ({ w, start: w.start, end: w.end }));
  function captionsState(selected) {
    const picked = new Set(selected.map(c => c.idx));
    S.chunks.forEach((c, i) => {
      if (picked.has(i) || picked.has(i + 1)) c.words[c.words.length - 1].brk = true; // keep boundaries while times change
    });
    return { picked, all: S.chunks.map(c => ({ words: snapWords(c.words), a: c.start, b: c.end })) };
  }
  function placeCaption(s, a, b, pin) {
    const k = (b - a) / Math.max(0.01, s.b - s.a);
    for (const x of s.words) { x.w.start = a + (x.start - s.a) * k; x.w.end = a + (x.end - s.a) * k; }
    const last = s.words[s.words.length - 1].w;
    last.end = b;
    if (pin) last.fixedEnd = true;
  }
  /** moves: Map of caption index -> [start, end]. */
  function applyCaptions(st, moves, ripple) {
    const lastMoved = Math.max(...moves.keys());
    const shift = ripple ? moves.get(lastMoved)[1] - st.all[lastMoved].b : 0;
    const times = st.all.map((s, i) => {
      if (moves.has(i)) return moves.get(i);
      return i > lastMoved ? [s.a + shift, s.b + shift] : [s.a, s.b];
    });
    st.all.forEach((s, i) => {
      if (moves.has(i)) { placeCaption(s, times[i][0], times[i][1], true); return; }
      let [a, b] = times[i];
      if (moves.has(i - 1) && !(ripple && i > lastMoved)) a = Math.max(a, times[i - 1][1]);
      if (moves.has(i + 1)) b = Math.min(b, times[i + 1][0]);
      placeCaption(s, a, Math.max(b, a + 0.02), false);
    });
    rebuild();
  }
  function shiftLimits(st, ripple) {
    let lo = -Infinity, hi = Infinity;
    const n = st.all.length;
    for (let i = 0; i < n; i++) {
      if (!st.picked.has(i)) continue;
      if (!st.picked.has(i - 1)) lo = Math.max(lo, (i > 0 ? st.all[i - 1].a + MIN_CAP : 0) - st.all[i].a);
      if (!st.picked.has(i + 1) && !(ripple && i === Math.max(...st.picked)) && i + 1 < n) hi = Math.min(hi, st.all[i + 1].b - MIN_CAP - st.all[i].b);
    }
    return [lo, hi];
  }
  function shiftCaptions(st, shift, ripple) {
    const [lo, hi] = shiftLimits(st, ripple), s = clamp(shift, lo, hi), moves = new Map();
    st.picked.forEach(i => moves.set(i, [st.all[i].a + s, st.all[i].b + s]));
    applyCaptions(st, moves, ripple);
    return s;
  }
  /** Buttons: moves everything selected by the same amount. */
  function nudgeSelection(delta) {
    const list = selectionList().filter(x => !locked(x.kind));
    const caps = list.filter(x => x.kind === 'cap').map(x => x.item);
    if (caps.length) {
      const first = Math.min(...caps.map(c => c.start));
      const s = shiftCaptions(captionsState(caps), delta, !!ui.capRipple);
      if (list.length === 1) TL.seek(first + s + S.offset + 0.001);
    }
    for (const { kind, item } of list) if (kind === 'overlay' || kind === 'audio') item.start = Math.max(0, item.start + delta);
    render(); renderInspector(); commit();
  }

  // ---- Pointer handling ----
  function beginDrag(kind, item, edge, e) {
    const others = edge ? [{ kind, item }] : selectionList().filter(x => !locked(x.kind));
    const skip = new Set();
    others.forEach(o => skip.add(o.kind === 'cap' ? o.item.words[0] : o.item));
    const caps = others.filter(o => o.kind === 'cap').map(o => o.item);
    ui.drag = {
      kind, item, edge, x0: e.clientX, moved: false, before: layout(), pts: snapPoints(skip),
      snap: kind === 'cap' ? null : JSON.parse(JSON.stringify(item)),
      free: others.filter(o => o.kind === 'overlay' || o.kind === 'audio').map(o => ({ item: o.item, start: o.item.start })),
      capState: caps.length ? captionsState(caps) : null,
      capIdx: kind === 'cap' ? item.idx : -1,
    };
    if (caps.length) suspendList = true;
    el('tlInner').setPointerCapture(e.pointerId); // on the stable parent: blocks get redrawn during the drag
    e.preventDefault();
  }
  function pointerDown(e) {
    if (e.target.closest('#tlRuler')) return;
    const handle = e.target.closest('.h');
    const b = e.target.closest('.tlb');
    const mouse = e.pointerType === 'mouse';
    if (!b) {
      if (mouse && e.button === 0) startMarquee(e);
      return;
    }
    const { kind, item } = itemOfBlock(b);
    if (!item) return;
    if (locked(kind)) { if (mouse) clickSelect(kind, item, e); return; }
    if (handle) { beginDrag(kind, item, handle.dataset.edge, e); return; }
    const adding = e.ctrlKey || e.metaKey || e.shiftKey || ui.multi;
    if (isSelected(kind, item) && !e.shiftKey) {
      // Already selected: a drag moves the whole selection; a plain tap is resolved on release.
      setPrimary(kind, item);
      beginDrag(kind, item, null, e);
      ui.drag.tapAdds = adding;
      return;
    }
    if (!mouse) return; // touch selects on click, so a finger can still scroll the timeline
    clickSelect(kind, item, e);
    if (!adding) beginDrag(kind, item, null, e);
  }
  function pointerMove(e) {
    if (ui.marquee) { moveMarquee(e); return; }
    const d = ui.drag;
    if (!d) return;
    if (Math.abs(e.clientX - d.x0) > 4) d.moved = true;
    if (!d.moved) return;
    const dt = (e.clientX - d.x0) / ui.pps;
    autoScroll(e);
    const ripple = !!ui.capRipple;
    if (d.edge) { dragEdge(d, dt, ripple); return; }

    // Moving: the block under the pointer decides the snap; everything selected follows by the same amount.
    let shift = dt;
    const anchor = d.kind === 'cap' ? d.capState.all[d.capIdx] : null;
    if (d.kind === 'overlay' || d.kind === 'audio') {
      const len = d.kind === 'overlay' ? d.snap.dur : d.snap.out - d.snap.in;
      shift += snapTo([d.snap.start + dt, d.snap.start + dt + len], d.pts);
    } else if (anchor) {
      shift += snapTo([anchor.a + dt, anchor.b + dt], d.pts);
    }
    if (d.kind === 'clip') moveClip(d, e);
    if (d.free.length) {
      const least = Math.min(...d.free.map(f => f.start));
      const s = Math.max(shift, -least);
      d.free.forEach(f => { f.item.start = f.start + s; });
    }
    if (d.capState) shiftCaptions(d.capState, shift, ripple);
    syncVideo();
    scheduleRender();
  }
  function moveClip(d, e) {
    const lay = layout(), it = d.item, cur = T.clips.indexOf(it), x = timeAtEvent(e);
    let to = lay.items.findIndex(i => x < (i.start + i.end) / 2);
    if (to < 0) to = T.clips.length - 1;
    if (to !== cur) { T.clips.splice(cur, 1); T.clips.splice(to, 0, it); }
  }
  function dragEdge(d, dt, ripple) {
    if (d.kind === 'cap') {
      const st = d.capState, s = st.all[d.capIdx], left = d.edge === 'l';
      const prev = st.all[d.capIdx - 1], next = st.all[d.capIdx + 1];
      let v = (left ? s.a : s.b) + dt;
      v += snapTo([v], d.pts);
      const a = left ? clamp(v, prev ? prev.a + MIN_CAP : 0, s.b - MIN_CAP) : s.a;
      const b = left ? s.b : clamp(v, s.a + MIN_CAP, ripple || !next ? Infinity : next.b - MIN_CAP);
      applyCaptions(st, new Map([[d.capIdx, [a, b]]]), ripple);
      scheduleRender();
      return;
    }
    const m = media.get(d.item.m), s = d.snap, it = d.item;
    if (d.kind === 'clip') {
      const lay = d.before.items.find(i => i.clip === it);
      const edgeT = (d.edge === 'l' ? lay.start : lay.end) + dt;
      const adj = snapTo([edgeT], d.pts), use = dt + adj;
      if (d.edge === 'l') it.in = clamp(s.in + use * s.speed, 0, s.out - 0.1);
      else it.out = clamp(s.out + use * s.speed, s.in + 0.1, m && m.kind === 'video' ? m.duration : 3600);
    } else if (d.kind === 'overlay') {
      const edgeT = (d.edge === 'l' ? s.start : s.start + s.dur) + dt, use = dt + snapTo([edgeT], d.pts);
      if (d.edge === 'l') { const nd = clamp(s.dur - use, 0.2, 3600); it.start = s.start + (s.dur - nd); it.dur = nd; if (m && m.kind === 'video') it.in = Math.max(0, s.in + (s.dur - nd)); }
      else it.dur = clamp(s.dur + use, 0.2, m && m.kind === 'video' ? m.duration - s.in : 3600);
    } else {
      const edgeT = (d.edge === 'l' ? s.start : s.start + (s.out - s.in)) + dt, use = dt + snapTo([edgeT], d.pts);
      if (d.edge === 'l') { const delta = clamp(use, -s.in, s.out - s.in - 0.1); it.in = s.in + delta; it.start = s.start + delta; }
      else it.out = clamp(s.out + use, s.in + 0.1, m ? m.duration : 3600);
    }
    syncVideo();
    scheduleRender();
  }
  function autoScroll(e) {
    const host = el('tlTracks'), r = host.getBoundingClientRect();
    if (e.clientX < r.left + 24) host.scrollLeft -= 12;
    else if (e.clientX > r.right - 24) host.scrollLeft += 12;
  }
  function pointerUp(e) {
    if (ui.marquee) { endMarquee(e); return; }
    const d = ui.drag;
    ui.drag = null;
    el('tlGuide').style.display = 'none';
    if (!d) return;
    if (d.capState) { suspendList = false; rebuild(); }
    if (!d.moved) {
      if (d.tapAdds != null && !d.edge) { clickSelect(d.kind, d.item, { ctrlKey: d.tapAdds, metaKey: false, shiftKey: false }); ui.tapHandled = true; }
      return;
    }
    if (d.kind === 'clip') remapCaptions(d.before, layout());
    syncVideo(); render(); renderInspector(); commit();
  }
  // Touch selects on click, so that dragging a finger over an unselected block scrolls instead.
  function onClick(e) {
    if (ui.tapHandled) { ui.tapHandled = false; return; }
    if (ui.lastPointer === 'mouse') return;
    const b = e.target.closest('.tlb');
    if (!b) { if (!e.target.closest('#tlRuler')) { seekTrack(e); if (!ui.multi) { clearSelection(); render(); renderInspector(); } } return; }
    const { kind, item } = itemOfBlock(b);
    if (item && !isSelected(kind, item)) clickSelect(kind, item, e);
  }

  // ---- Marquee: drag on empty space to select everything it touches ----
  function startMarquee(e) {
    const r = el('tlInner').getBoundingClientRect();
    ui.marquee = { x0: e.clientX - r.left, y0: e.clientY - r.top, moved: false, base: e.ctrlKey || e.metaKey || ui.multi };
    el('tlInner').setPointerCapture(e.pointerId);
    e.preventDefault();
  }
  function moveMarquee(e) {
    const m = ui.marquee, r = el('tlInner').getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    if (Math.abs(x - m.x0) + Math.abs(y - m.y0) > 5) m.moved = true;
    if (!m.moved) return;
    autoScroll(e);
    const box = el('tlBox');
    Object.assign(box.style, { display: 'block', left: `${Math.min(x, m.x0)}px`, top: `${Math.min(y, m.y0)}px`, width: `${Math.abs(x - m.x0)}px`, height: `${Math.abs(y - m.y0)}px` });
    m.rect = [Math.min(x, m.x0) + r.left, Math.min(y, m.y0) + r.top, Math.max(x, m.x0) + r.left, Math.max(y, m.y0) + r.top];
    document.querySelectorAll('#tlInner .tlb').forEach(b => {
      const q = b.getBoundingClientRect();
      b.classList.toggle('band', !(q.right < m.rect[0] || q.left > m.rect[2] || q.bottom < m.rect[1] || q.top > m.rect[3]) && !locked(b.dataset.kind));
    });
  }
  function endMarquee(e) {
    const m = ui.marquee;
    ui.marquee = null;
    el('tlBox').style.display = 'none';
    if (!m.moved) {
      seekTrack(e);
      if (!m.base) clearSelection();
      render(); renderInspector();
      return;
    }
    if (!m.base) clearSelection();
    let last = null;
    document.querySelectorAll('#tlInner .tlb.band').forEach(b => {
      const { kind, item } = itemOfBlock(b);
      if (item) { addToSelection(kind, item); last = { kind, item }; }
    });
    if (last) showTab('clip');
    render(); renderInspector();
  }
  // Two fingers zoom; a wheel scrolls sideways, and with Ctrl it zooms at the pointer.
  function setupGestures(host) {
    const fingers = new Map();
    let startDist = 0, startPps = 0;
    host.addEventListener('pointerdown', e => {
      if (e.pointerType !== 'touch') return;
      fingers.set(e.pointerId, e.clientX);
      if (fingers.size === 2) { const [a, b] = [...fingers.values()]; startDist = Math.abs(a - b) || 1; startPps = ui.pps; ui.drag = null; suspendList = false; }
    }, true);
    host.addEventListener('pointermove', e => {
      if (!fingers.has(e.pointerId)) return;
      fingers.set(e.pointerId, e.clientX);
      if (fingers.size === 2) { const [a, b] = [...fingers.values()]; setZoom(startPps * (Math.abs(a - b) || 1) / startDist, (a + b) / 2); }
    }, true);
    const lift = e => fingers.delete(e.pointerId);
    host.addEventListener('pointerup', lift, true);
    host.addEventListener('pointercancel', lift, true);
    host.addEventListener('wheel', e => {
      if (e.ctrlKey || e.metaKey || e.altKey) { e.preventDefault(); setZoom(ui.pps * Math.pow(1.0015, -e.deltaY), e.clientX); return; }
      if (!e.shiftKey && Math.abs(e.deltaY) > Math.abs(e.deltaX)) { e.preventDefault(); host.scrollLeft += e.deltaY; }
    }, { passive: false });
    host.addEventListener('scroll', () => { el('tlHeads').scrollTop = host.scrollTop; });
  }

  // ---- Stage: drag an overlay directly on the picture ----
  function stagePointer(type, p, W, H) {
    if (type === 'down') {
      const sel = selectedItem();
      if (!sel || ui.selected.kind !== 'overlay' || ui.clock < sel.start || ui.clock >= sel.start + sel.dur) return false;
      const dw = sel.scale * W, m = media.get(sel.m), dh = dw * ((m && m.height) || 1) / ((m && m.width) || 1);
      if (Math.abs(p.x - sel.x * W) > dw / 2 || Math.abs(p.y - sel.y * H) > dh / 2) return false;
      ui.stageDrag = { sel, x0: p.x, y0: p.y, ox: sel.x, oy: sel.y };
      return true;
    }
    if (!ui.stageDrag) return false;
    const d = ui.stageDrag;
    if (type === 'move') { d.sel.x = clamp(d.ox + (p.x - d.x0) / W, 0, 1); d.sel.y = clamp(d.oy + (p.y - d.y0) / H, 0, 1); return true; }
    ui.stageDrag = null; commit(); renderInspector();
    return true;
  }

  // ---------- Inspector ----------
  function slider(label, min, max, step, get, set, opts = {}) {
    const row = document.createElement('div');
    row.className = 'ctl';
    const n = document.createElement('span'); n.textContent = label;
    const i = document.createElement('input'); i.type = 'range'; i.min = min; i.max = max; i.step = step; i.value = get();
    const o = document.createElement('output'); o.textContent = (+get()).toFixed(step < 0.1 ? 2 : 1);
    i.addEventListener('input', () => {
      const v = Number(i.value);
      o.textContent = v.toFixed(step < 0.1 ? 2 : 1);
      if (opts.structural) edit(() => set(v)); else { set(v); commit(); }
    });
    row.append(n, i, o);
    return row;
  }
  function choice(label, options, get, set, opts = {}) {
    const row = document.createElement('div');
    row.className = 'ctl';
    const n = document.createElement('span'); n.textContent = label;
    const seg = document.createElement('div'); seg.className = 'seg';
    options.forEach(([v, l]) => {
      const b = document.createElement('button');
      b.textContent = l; b.classList.toggle('on', get() === v);
      b.onclick = () => { if (opts.structural) edit(() => set(v)); else { set(v); commit(); renderInspector(); } };
      seg.appendChild(b);
    });
    row.append(n, seg);
    return row;
  }
  function group(host, title, ...rows) {
    const g = document.createElement('div'); g.className = 'group';
    const h = document.createElement('h4'); h.textContent = title; g.append(h, ...rows);
    host.appendChild(g);
  }
  function nudgeRow() {
    const row = document.createElement('div'); row.className = 'row wrap';
    [[-0.5, '−0.5'], [-0.1, '−0.1'], [0.1, '+0.1'], [0.5, '+0.5']].forEach(([v, l]) => {
      const b = document.createElement('button'); b.className = 'grow'; b.textContent = `${l} ວິ`;
      b.onclick = () => nudgeSelection(v);
      row.appendChild(b);
    });
    return row;
  }
  /** Where the selected captions sit on the picture. Only the selected ones move. */
  function moveCaptionPlace(dx, dy, y) {
    const caps = selectionList().filter(x => x.kind === 'cap' && !locked('cap')).map(x => x.item);
    if (!caps.length) return;
    for (const c of caps) {
      const base = c.pos || S.pos;
      const pos = { x: clamp(base.x + dx, 0.02, 0.98), y: clamp(y != null ? y : base.y + dy, 0.02, 0.98) };
      c.words.forEach(w => delete w.pos);
      c.words[0].pos = pos;
    }
    rebuild(); render(); renderInspector(); commit();
  }
  function unpinCaptions() {
    selectionList().filter(x => x.kind === 'cap').forEach(({ item }) => item.words.forEach(w => delete w.pos));
    rebuild(); render(); renderInspector(); commit();
  }
  function placeRows(caps) {
    const box = document.createElement('div');
    const h = document.createElement('div'); h.className = 'small muted'; h.style.marginTop = '8px';
    h.textContent = `ບ່ອນວາງໃນຄິບ (${caps.length} ຟ້ອນທີ່ເລືອກ, ອັນອື່ນບໍ່ປ່ຽນ). ລາກຟ້ອນໃນຄິບກໍໄດ້.`;
    const row = document.createElement('div'); row.className = 'row wrap';
    [['⬆', 0, -0.02, 'ຂຶ້ນ (Alt+↑)'], ['⬇', 0, 0.02, 'ລົງ (Alt+↓)'], ['⬅', -0.02, 0, 'ຊ້າຍ'], ['➡', 0.02, 0, 'ຂວາ']].forEach(([l, dx, dy, title]) => {
      const b = document.createElement('button'); b.textContent = l; b.title = title; b.onclick = () => moveCaptionPlace(dx, dy); row.appendChild(b);
    });
    [['ເທິງ', 0.21], ['ກາງ', 0.5], ['ລຸ່ມ', 0.7]].forEach(([l, y]) => {
      const b = document.createElement('button'); b.className = 'grow'; b.textContent = l; b.onclick = () => moveCaptionPlace(0, 0, y); row.appendChild(b);
    });
    const un = document.createElement('button'); un.textContent = '📌✕'; un.title = 'ກັບໄປໃຊ້ບ່ອນວາງຫຼັກ'; un.onclick = unpinCaptions; un.disabled = !caps.some(c => c.pos);
    row.appendChild(un);
    box.append(h, row);
    return box;
  }
  function rippleBox() {
    const lab = document.createElement('label'); lab.className = 'check small'; lab.style.marginTop = '8px';
    const cb = document.createElement('input'); cb.type = 'checkbox'; cb.id = 'capRipple'; cb.checked = !!ui.capRipple;
    cb.onchange = () => { ui.capRipple = cb.checked; };
    lab.append(cb, document.createTextNode(' ເລື່ອນຄຳທັງໝົດທີ່ຕາມຫຼັງໄປນຳ'));
    return lab;
  }
  function renderInspector() {
    const host = el('tab-clip');
    if (!host) return;
    host.textContent = '';
    const projectGroup = () => {
      group(host, 'ຂະໜາດຜົນງານ',
        choice('ອັດຕາສ່ວນ', [['9:16', '9:16'], ['16:9', '16:9'], ['1:1', '1:1'], ['4:5', '4:5']], () => {
          const { w, h } = T.canvas;
          return w * 16 === h * 9 ? '9:16' : w * 9 === h * 16 ? '16:9' : w === h ? '1:1' : w * 5 === h * 4 ? '4:5' : '';
        }, v => {
          T.canvas = { ...T.canvas, ...{ '9:16': { w: 1080, h: 1920 }, '16:9': { w: 1920, h: 1080 }, '1:1': { w: 1080, h: 1080 }, '4:5': { w: 1080, h: 1350 } }[v] };
          syncVideo(); renderInspector();
        }));
      const note = document.createElement('p');
      note.className = 'small muted';
      note.textContent = 'ກົດເລືອກຄິບໃນໄທມ໌ລາຍ ເພື່ອປັບຄວາມໄວ, ສຽງ, ສີ ແລະ ຕຳແໜ່ງ.';
      host.appendChild(note);
    };
    const sel = selectedItem();
    if (!sel) { projectGroup(); return; }
    const kind = ui.selected.kind;
    const many = selectionList();
    if (many.length > 1) {
      const g = document.createElement('div'); g.className = 'group';
      const caps = many.filter(x => x.kind === 'cap').length;
      const h = document.createElement('h4'); h.textContent = `ເລືອກໄວ້ ${many.length} ອັນ${caps ? ` (ຟ້ອນ ${caps})` : ''}`; g.appendChild(h);
      const t = document.createElement('p'); t.className = 'small muted'; t.textContent = 'ລາກອັນໃດອັນໜຶ່ງ ທຸກອັນທີ່ເລືອກຈະຍ້າຍພ້ອມກັນ.'; g.appendChild(t);
      g.appendChild(nudgeRow());
      if (caps) g.appendChild(placeRows(many.filter(x => x.kind === 'cap').map(x => x.item)));
      const row = document.createElement('div'); row.className = 'row wrap';
      if (caps > 1) { const m = document.createElement('button'); m.className = 'grow'; m.textContent = '⧉ ຮວມເປັນຟ້ອນດຽວ'; m.onclick = mergeCaptions; row.appendChild(m); }
      const d = document.createElement('button'); d.className = 'grow'; d.textContent = '🗑 ລົບທັງໝົດ'; d.onclick = removeSelected; row.appendChild(d);
      g.append(row, rippleBox());
      host.appendChild(g);
    } else if (kind === 'cap') {
      const g = document.createElement('div'); g.className = 'group';
      const h = document.createElement('h4'); h.textContent = 'ແກ້ຟ້ອນ'; g.appendChild(h);
      const input = document.createElement('input'); input.type = 'text'; input.id = 'capText'; input.value = sel.text;
      input.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') input.blur(); });
      input.addEventListener('change', () => {
        const at = S.words.indexOf(sel.words[0]), old = sel.words.length, before = S.words.length;
        replaceChunkText(sel, input.value);
        const fresh = S.words.slice(at, at + S.words.length - (before - old));
        fresh.forEach((w, i) => { w.glue = i < fresh.length - 1; w.brk = i === fresh.length - 1; });
        rebuild();
        clearSelection();
        const c = fresh.length && S.chunks.find(x => x.words[0] === fresh[0]);
        if (c) addToSelection('cap', c);
        render(); renderInspector(); commit();
      });
      g.appendChild(input);
      const t = document.createElement('p'); t.className = 'small muted'; t.textContent = `${sel.start.toFixed(2)} – ${sel.end.toFixed(2)} ວິ. ລາກເພື່ອຍ້າຍ, ລາກຂອບເຫຼືອງເພື່ອຍືດ-ຫົດ.`; g.appendChild(t);
      g.append(nudgeRow(), placeRows([sel]), rippleBox());
      const row = document.createElement('div'); row.className = 'row wrap';
      const cut = document.createElement('button'); cut.className = 'grow'; cut.textContent = '✂ ຕັດຟ້ອນຢູ່ເສັ້ນເວລາ'; cut.onclick = () => splitCaptionAt(sel, ui.clock - S.offset); row.appendChild(cut);
      const all = document.createElement('button'); all.className = 'grow'; all.textContent = 'ເລືອກທັງໝົດ'; all.onclick = selectAll; row.appendChild(all);
      g.appendChild(row);
      host.appendChild(g);
    } else if (kind === 'clip') {
      group(host, 'ຄວາມໄວ ແລະ ສຽງ',
        slider('ຄວາມໄວ', 0.25, 4, 0.05, () => sel.speed, v => { sel.speed = v; }, { structural: true }),
        choice('ສຽງຄິບ', [[false, 'ເປີດ'], [true, 'ປິດ']], () => sel.muted, v => { sel.muted = v; }),
        slider('ຄວາມດັງ', 0, 1, 0.05, () => sel.volume, v => { sel.volume = v; }));
      group(host, 'ຄອບພາບ',
        choice('ການວາງ', [['cover', 'ເຕັມຈໍ'], ['contain', 'ເຫັນຄົບ']], () => sel.fit, v => { sel.fit = v; }),
        slider('ຊູມ', 1, 4, 0.01, () => sel.zoom, v => { sel.zoom = v; }),
        slider('ຊ້າຍ-ຂວາ', -1, 1, 0.01, () => sel.x, v => { sel.x = v; }),
        slider('ເທິງ-ລຸ່ມ', -1, 1, 0.01, () => sel.y, v => { sel.y = v; }));
      group(host, 'ປັບສີ',
        slider('ຄວາມສະຫວ່າງ', 0.3, 1.8, 0.01, () => sel.bright, v => { sel.bright = v; }),
        slider('ຄວາມຄົມຊັດ', 0.3, 1.8, 0.01, () => sel.contrast, v => { sel.contrast = v; }),
        slider('ຄວາມສົດ', 0, 2, 0.01, () => sel.sat, v => { sel.sat = v; }));
      if (T.clips.indexOf(sel) > 0) {
        group(host, 'ທຣານຊິຊັນຈາກຄິບກ່ອນ',
          choice('ແບບ', [['none', 'ບໍ່ມີ'], ['fade', 'ຈາງ'], ['slide', 'ເລື່ອນຂ້າງ'], ['slideUp', 'ເລື່ອນຂຶ້ນ'], ['zoom', 'ຊູມ']], () => sel.trans, v => { sel.trans = v; }, { structural: true }),
          slider('ຍາວ (ວິ)', 0.1, 2, 0.05, () => sel.transDur, v => { sel.transDur = v; }, { structural: true }));
      }
    } else if (kind === 'overlay') {
      group(host, 'ພາບຊ້ອນ',
        slider('ຂະໜາດ', 0.05, 1, 0.01, () => sel.scale, v => { sel.scale = v; }),
        slider('ຊ້າຍ-ຂວາ', 0, 1, 0.01, () => sel.x, v => { sel.x = v; }),
        slider('ເທິງ-ລຸ່ມ', 0, 1, 0.01, () => sel.y, v => { sel.y = v; }),
        slider('ຄວາມທຶບ', 0, 1, 0.01, () => sel.opacity, v => { sel.opacity = v; }),
        slider('ຄ່ອຍໆຂຶ້ນ', 0, 2, 0.05, () => sel.fadeIn, v => { sel.fadeIn = v; }),
        slider('ຄ່ອຍໆຫາຍ', 0, 2, 0.05, () => sel.fadeOut, v => { sel.fadeOut = v; }));
    } else {
      group(host, 'ສຽງ',
        choice('ປະເພດ', [['music', 'ເພງ'], ['voice', 'ສຽງພາກ']], () => sel.kind, v => { sel.kind = v; }),
        slider('ຄວາມດັງ', 0, 1, 0.01, () => sel.volume, v => { sel.volume = v; }),
        slider('ຄ່ອຍໆຂຶ້ນ', 0, 5, 0.1, () => sel.fadeIn, v => { sel.fadeIn = v; }),
        slider('ຄ່ອຍໆຫາຍ', 0, 5, 0.1, () => sel.fadeOut, v => { sel.fadeOut = v; }));
    }
    const close = document.createElement('button');
    close.className = 'wide'; close.textContent = 'ຍົກເລີກການເລືອກ';
    close.onclick = () => { clearSelection(); render(); renderInspector(); };
    host.appendChild(close);
  }

  // ---------- Persistence ----------
  const serialize = () => ({ canvas: T.canvas, clips: T.clips, overlays: T.overlays, audio: T.audio, captionsFree: T.captionsFree, tracks: T.tracks, media: [...media.values()].map(({ id, name, kind, width, height, duration, hasAudio }) => ({ id, name, kind, width, height, duration, hasAudio })) });
  function load(data) {
    if (!data) return;
    Object.assign(T, { canvas: data.canvas, clips: data.clips, overlays: data.overlays, audio: data.audio, captionsFree: !!data.captionsFree, tracks: { ...freshTracks(), ...(data.tracks || {}) } });
    clearSelection();
    for (const m of data.media || []) {
      const cur = media.get(m.id);
      media.set(m.id, cur && cur.file ? cur : m);
    }
    syncVideo(); render(); renderInspector();
  }

  // ---------- Set up ----------
  function init() {
    const center = el('center');
    const box = document.createElement('div');
    box.id = 'tl';
    box.innerHTML = `
      <div id="tlGrip" title="ລາກເພື່ອປັບຄວາມສູງ"></div>
      <div class="tlbar">
        <button id="tlNew" title="ລ້າງໄທມ໌ລາຍ ເພື່ອເລີ່ມໂປຣເຈັກໃໝ່">🗋</button>
        <button id="tlAdd" title="ເພີ່ມຄິບ ຫຼື ຮູບ">＋ ຄິບ</button>
        <button id="tlAddAudio" title="ເພີ່ມເພງ ຫຼື ສຽງພາກ">🎵</button>
        <button id="tlAddOverlay" title="ເພີ່ມໂລໂກ້ ຫຼື ພາບຊ້ອນ">🖼</button>
        <button id="tlAddCap" title="ເພີ່ມຟ້ອນຢູ່ເສັ້ນເວລາ">＋ Aa</button>
        <i class="sep"></i>
        <button id="tlUndo" title="ຍ້ອນກັບ (Ctrl+Z)">↶</button>
        <button id="tlRedo" title="ເຮັດຄືນ (Ctrl+Y)">↷</button>
        <button id="tlSplit" title="ຕັດຢູ່ເສັ້ນເວລາ (S)">✂</button>
        <button id="tlTrimL" title="ຕັດຫົວຮອດເສັ້ນເວລາ (Q)">⇤</button>
        <button id="tlTrimR" title="ຕັດທ້າຍຮອດເສັ້ນເວລາ (W)">⇥</button>
        <button id="tlDelete" title="ລົບສິ່ງທີ່ເລືອກ (Delete)">🗑</button>
        <button id="tlDup" title="ສຳເນົາ (Ctrl+D)">⧉</button>
        <i class="sep"></i>
        <button id="tlMulti" title="ໂໝດເລືອກຫຼາຍອັນ: ກົດໄດ້ເທື່ອລະອັນ (ຄອມ: Ctrl+ກົດ, Shift+ກົດ ຫຼື ລາກກອບ)">☑</button>
        <button id="tlSnapBtn" title="ດູດຕິດເສັ້ນເວລາ ແລະ ຂອບອື່ນ">🧲</button>
        <span id="tlCount" class="small"></span>
        <span class="grow"></span>
        <span id="tlTime" class="mono small muted"></span>
        <button id="tlOut" title="ຍໍ່ (-)">−</button><input id="tlZoom" type="range" min="0" max="1000" title="ຊູມໄທມ໌ລາຍ (Ctrl ຫຼື Alt + ລໍ້ເມົາສ໌)"><button id="tlIn" title="ຂະຫຍາຍ (+)">＋</button><button id="tlFit" title="ເຫັນທັງໝົດ (Shift+Z)">⤢</button>
      </div>
      <div id="tlBody">
        <div id="tlHeads"></div>
        <div id="tlTracks"><div id="tlInner">
          <div id="tlRuler"></div>
          <div id="tlVideo" class="tltrack"></div>
          <div id="tlOverlay" class="tltrack"></div>
          <div id="tlAudio" class="tltrack"></div>
          <div id="tlCaps" class="tltrack"></div>
          <div id="tlGuide"></div>
          <div id="tlBox"></div>
          <div id="tlHead"></div>
        </div></div>
      </div>
      <input id="tlPickClip" type="file" accept="video/*,image/*" multiple class="hidden">
      <input id="tlPickAudio" type="file" accept="audio/*,video/*" multiple class="hidden">
      <input id="tlPickOverlay" type="file" accept="image/*,video/*" class="hidden">`;
    center.appendChild(box);
    const stageEl = el('stage');
    base = document.createElement('canvas');
    base.id = 'baseCanvas';
    stageEl.insertBefore(base, el('canvas'));
    bctx = base.getContext('2d');
    el('video').classList.add('hidden');
    const pick = (btn, input, fn) => {
      el(btn).onclick = () => el(input).click();
      el(input).onchange = async ev => {
        const files = [...ev.target.files];
        ev.target.value = '';
        try { await fn(files); } catch (err) { setNotice(err.message || 'ເປີດໄຟລ໌ບໍ່ໄດ້', 'bad'); }
      };
    };
    pick('tlAdd', 'tlPickClip', addFiles);
    pick('tlAddAudio', 'tlPickAudio', async files => { for (const f of files) addAudioItem(await addMedia(f), f.name); });
    pick('tlAddOverlay', 'tlPickOverlay', async files => { for (const f of files) await addOverlay(f); });
    el('tlNew').onclick = () => {
      const b = el('tlNew');
      if (b.dataset.sure !== '1') { // a second press confirms, so one stray tap can't wipe the work
        b.dataset.sure = '1'; b.textContent = 'ລ້າງແທ້ບໍ?';
        setTimeout(() => { b.dataset.sure = ''; b.textContent = '🗋 ໃໝ່'; }, 3000);
        return;
      }
      b.dataset.sure = ''; b.textContent = '🗋 ໃໝ່';
      clearProject();
    };
    el('tlSplit').onclick = split;
    el('tlDelete').onclick = removeSelected;
    el('tlDup').onclick = duplicate;
    el('tlTrimL').onclick = () => trimToPlayhead('l');
    el('tlTrimR').onclick = () => trimToPlayhead('r');
    el('tlAddCap').onclick = addCaption;
    el('tlUndo').onclick = () => undo();
    el('tlRedo').onclick = () => redo();
    el('tlMulti').onclick = () => { ui.multi = !ui.multi; render(); };
    el('tlSnapBtn').onclick = () => { ui.snap = !ui.snap; render(); };
    el('tlIn').onclick = () => setZoom(ui.pps * 1.5);
    el('tlOut').onclick = () => setZoom(ui.pps / 1.5);
    el('tlFit').onclick = fitZoom;
    el('tlZoom').addEventListener('input', e => setZoom(sliderToZoom(Number(e.target.value))));
    syncZoomSlider();
    // On a computer the timeline runs the full width under the panels, as in CapCut; on a phone it stays under the clip.
    const wide = matchMedia('(min-width: 1051px)');
    const placeTimeline = () => {
      const tl = el('tl'), want = wide.matches ? document.querySelector('main') : el('center');
      if (tl.parentElement !== want) { want.appendChild(tl); render(); fitStage(); }
    };
    wide.addEventListener('change', placeTimeline);
    placeTimeline();
    const inner = el('tlInner'), tracks = el('tlTracks');
    inner.addEventListener('pointerdown', e => { ui.lastPointer = e.pointerType; pointerDown(e); });
    inner.addEventListener('pointermove', pointerMove);
    inner.addEventListener('pointerup', pointerUp);
    inner.addEventListener('pointercancel', () => { ui.drag = null; ui.marquee = null; suspendList = false; el('tlBox').style.display = 'none'; el('tlGuide').style.display = 'none'; });
    inner.addEventListener('click', onClick);
    setupGestures(tracks);
    // The ruler always moves the playhead.
    let rulerDown = false;
    const ruler = el('tlRuler');
    ruler.addEventListener('pointerdown', e => { rulerDown = true; ruler.setPointerCapture(e.pointerId); seekTrack(e); e.stopPropagation(); });
    ruler.addEventListener('pointermove', e => { if (rulerDown) { seekTrack(e); autoScroll(e); } });
    ruler.addEventListener('pointerup', () => { rulerDown = false; });
    // Drag the top edge to give the timeline more or less room.
    const grip = el('tlGrip');
    const saved = Number(localStorage.getItem('cs.tlHeight'));
    if (saved) tracks.style.height = el('tlHeads').style.height = `${saved}px`;
    let gripY = null, gripH = 0;
    grip.addEventListener('pointerdown', e => { gripY = e.clientY; gripH = tracks.clientHeight; grip.setPointerCapture(e.pointerId); e.preventDefault(); });
    grip.addEventListener('pointermove', e => {
      if (gripY == null) return;
      const h = clamp(gripH + gripY - e.clientY, 90, 420);
      tracks.style.height = el('tlHeads').style.height = `${h}px`;
      fitStage();
    });
    grip.addEventListener('pointerup', () => { if (gripY != null) localStorage.setItem('cs.tlHeight', String(tracks.clientHeight)); gripY = null; });
    document.addEventListener('keydown', e => {
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
      const key = e.key.toLowerCase(), ctrl = e.ctrlKey || e.metaKey;
      const frame = e.shiftKey ? 1 : 1 / 30;
      if (ctrl && (key === '=' || key === '+')) { e.preventDefault(); setZoom(ui.pps * 1.25); }
      else if (ctrl && key === '-') { e.preventDefault(); setZoom(ui.pps / 1.25); }
      else if (ctrl && key === 'a') { e.preventDefault(); selectAll(); }
      else if (ctrl && key === 'd') { e.preventDefault(); duplicate(); }
      else if (ctrl && key === 'b') { e.preventDefault(); split(); }
      else if (ctrl) return;
      else if (key === 's') split();
      else if (key === 'q') trimToPlayhead('l');
      else if (key === 'w') trimToPlayhead('r');
      else if (key === 'n') { ui.snap = !ui.snap; render(); }
      else if (key === 'delete' || key === 'backspace') { e.preventDefault(); removeSelected(); }
      else if (key === 'escape') { clearSelection(); render(); renderInspector(); }
      else if (e.altKey && (key === 'arrowup' || key === 'arrowdown')) { e.preventDefault(); moveCaptionPlace(0, (key === 'arrowup' ? -1 : 1) * (e.shiftKey ? 0.05 : 0.01)); }
      else if (key === 'z' && e.shiftKey) fitZoom();
      else if (key === 'arrowleft') { e.preventDefault(); TL.seek(ui.clock - frame); drawPlayhead(ui.clock, total()); }
      else if (key === 'arrowright') { e.preventDefault(); TL.seek(ui.clock + frame); drawPlayhead(ui.clock, total()); }
      else if (key === 'home') TL.seek(0);
      else if (key === 'end') TL.seek(total());
      else if (key === '=' || key === '+') setZoom(ui.pps * 1.25);
      else if (key === '-') setZoom(ui.pps / 1.25);
    });
    render();
    renderInspector();
  }

  // ---------- Sound mix (export and listening share it) ----------
  async function renderMix(sampleRate, channels, { excludeMusic = false, onProgress } = {}) {
    const MB = await window.CS_BACKEND.mediabunny();
    const lay = layout(), length = Math.max(1, Math.ceil(total() * sampleRate));
    const ctx = new OfflineAudioContext(channels, length, sampleRate);
    const jobs = [];
    lay.items.forEach((it, i) => {
      const m = media.get(it.clip.m);
      if (!m || !m.file || !m.hasAudio || it.clip.muted || it.clip.volume <= 0 || T.tracks.video.mute) return;
      const next = lay.items[i + 1];
      jobs.push({ m, from: it.clip.in, to: it.clip.out, at: it.start, rate: it.clip.speed, volume: it.clip.volume, fadeIn: it.overlap, fadeOut: next ? next.overlap : 0 });
    });
    T.audio.forEach(a => {
      if ((excludeMusic && a.kind === 'music') || T.tracks.audio.mute) return;
      const m = media.get(a.m);
      if (m && m.file) jobs.push({ m, from: a.in, to: a.out, at: a.start, rate: 1, volume: a.volume, fadeIn: a.fadeIn, fadeOut: a.fadeOut });
    });
    let done = 0;
    for (const j of jobs) {
      const input = new MB.Input({ source: new MB.BlobSource(j.m.file), formats: MB.ALL_FORMATS });
      const track = await input.getPrimaryAudioTrack();
      if (track) {
        const gain = ctx.createGain();
        const dur = (j.to - j.from) / j.rate, end = j.at + dur;
        gain.gain.setValueAtTime(j.fadeIn > 0 ? 0 : j.volume, j.at);
        if (j.fadeIn > 0) gain.gain.linearRampToValueAtTime(j.volume, j.at + j.fadeIn);
        if (j.fadeOut > 0) { gain.gain.setValueAtTime(j.volume, Math.max(j.at, end - j.fadeOut)); gain.gain.linearRampToValueAtTime(0, end); }
        gain.connect(ctx.destination);
        const sink = new MB.AudioBufferSink(track);
        for await (const { buffer, timestamp } of sink.buffers(j.from, j.to)) {
          const src = ctx.createBufferSource();
          src.buffer = buffer;
          src.playbackRate.value = j.rate;
          src.connect(gain);
          const offset = Math.max(0, j.from - timestamp);
          const usable = Math.min(buffer.duration - offset, j.to - Math.max(timestamp, j.from));
          if (usable > 0) src.start(j.at + (Math.max(timestamp, j.from) - j.from) / j.rate, offset, usable);
        }
      }
      input.dispose?.();
      done++;
      if (onProgress) onProgress(done / jobs.length);
    }
    const mixed = await ctx.startRendering();
    // Voice, clip sound and music can add up past full scale: turn the whole mix down instead of letting it distort.
    let peak = 0;
    for (let c = 0; c < mixed.numberOfChannels; c++) { const d = mixed.getChannelData(c); for (let i = 0; i < d.length; i++) { const v = Math.abs(d[i]); if (v > peak) peak = v; } }
    if (peak > 0.97) { const k = 0.97 / peak; for (let c = 0; c < mixed.numberOfChannels; c++) { const d = mixed.getChannelData(c); for (let i = 0; i < d.length; i++) d[i] *= k; } }
    return mixed;
  }

  // ---------- Export ----------
  function isUntouchedSingleClip() {
    if (T.clips.length !== 1 || T.overlays.length || T.audio.length || T.tracks.video.mute) return null;
    const c = T.clips[0], m = media.get(c.m);
    const plain = m && m.kind === 'video' && c.in === 0 && Math.abs(c.out - m.duration) < 0.001 && c.speed === 1 && !c.muted && c.volume === 1 && c.zoom === 1 && !c.x && !c.y
      && c.bright === 1 && c.contrast === 1 && c.sat === 1 && T.canvas.w === m.width - (m.width % 2) && T.canvas.h === m.height - (m.height % 2);
    return plain ? m : null;
  }
  async function exportVideo(payload0, onProgress, isCancelled) {
    const payload = T.tracks.caps.hide ? { ...payload0, chunks: [] } : payload0;
    const single = isUntouchedSingleClip();
    if (single) return window.CS_BACKEND.exportMp4(payload, { file: single.file, name: single.name, width: single.width, height: single.height }, onProgress, isCancelled);
    if (missingMedia().some(m => T.clips.some(c => c.m === m.id) || T.overlays.some(o => o.m === m.id) || T.audio.some(a => a.m === m.id))) { relinkNotice(); throw new Error('ຍັງມີໄຟລ໌ທີ່ຕ້ອງເລືອກຄືນ'); }
    const { drawChunk } = window.CaptionRender;
    const B2 = window.CS_BACKEND, MB = await B2.mediabunny();
    const W = T.canvas.w, H = T.canvas.h, fps = payload.fps || 30, tot = total();
    let codec = null;
    for (const c of ['avc', 'hevc', 'vp9', 'av1']) if (await MB.canEncodeVideo(c, { width: W, height: H })) { codec = c; break; }
    if (!codec) throw new Error('browser ນີ້ບໍ່ຮອງຮັບການສ້າງວິດີໂອ ກະລຸນາໃຊ້ Chrome ລຸ້ນໃໝ່');
    onProgress(0);
    const mix = await renderMix(48000, 2, { onProgress: p => onProgress(p * 0.08) });
    if (isCancelled()) return null;
    const audioCodec = (await MB.canEncodeAudio('aac')) ? 'aac' : 'opus';
    const out = await B2.openTarget(MB);
    const output = new MB.Output({ format: new MB.Mp4OutputFormat({ fastStart: out.fastStart }), target: out.target });
    const canvas = new OffscreenCanvas(W, H), ctx = canvas.getContext('2d');
    const videoSource = new MB.CanvasSource(canvas, { codec, bitrate: MB.QUALITY_VERY_HIGH });
    output.addVideoTrack(videoSource, { frameRate: fps });
    const audioSource = new MB.AudioBufferSource({ codec: audioCodec, bitrate: MB.QUALITY_HIGH });
    output.addAudioTrack(audioSource);
    await output.start();
    await audioSource.add(mix);
    audioSource.close();

    // Decoding: each clip and video overlay reads forward through its frames as the timeline advances.
    const readers = new Map(), bitmaps = new Map(), inputs = [];
    const openReader = async (item, kind) => {
      const m = media.get(item.m);
      if (m.kind === 'image') {
        if (!bitmaps.has(m.id)) bitmaps.set(m.id, await createImageBitmap(m.file));
        return { image: bitmaps.get(m.id) };
      }
      const input = new MB.Input({ source: new MB.BlobSource(m.file), formats: MB.ALL_FORMATS });
      inputs.push(input);
      const track = await input.getPrimaryVideoTrack();
      const sink = new MB.CanvasSink(track, { poolSize: 4 });
      const from = kind === 'clip' ? item.in : item.in;
      const to = kind === 'clip' ? item.out : item.in + item.dur;
      const gen = sink.canvases(from, to + 0.2);
      const first = await gen.next();
      const second = first.done ? { done: true } : await gen.next();
      return { gen, cur: first.done ? null : first.value, next: second.done ? null : second.value };
    };
    const frameAt = async (r, src) => {
      if (r.image) return r;
      while (r.next && r.next.timestamp <= src) {
        r.cur = r.next;
        const n = await r.gen.next();
        r.next = n.done ? null : n.value;
      }
      return r;
    };
    const lay = layout();
    const totalFrames = Math.ceil(tot * fps);
    const wanted = new Map();
    const getSource = (kind, item) => {
      const r = wanted.get(item.id);
      if (!r) return null;
      if (r.image) return { img: r.image, w: r.image.width, h: r.image.height };
      if (!r.cur) return null;
      return { img: r.cur.canvas, w: r.cur.canvas.width, h: r.cur.canvas.height };
    };
    try {
      for (let f = 0; f < totalFrames; f++) {
        if (isCancelled()) { await output.cancel(); await out.discard(); return null; }
        const t = f / fps;
        wanted.clear();
        for (const it of lay.items) {
          const lastOne = it === lay.items[lay.items.length - 1] && t >= it.end;
          if ((t >= it.start && t < it.end) || lastOne) {
            if (!readers.has(it.clip.id)) readers.set(it.clip.id, await openReader(it.clip, 'clip'));
            const r = readers.get(it.clip.id);
            await frameAt(r, it.clip.in + (Math.min(t, it.end - 0.001) - it.start) * it.clip.speed);
            wanted.set(it.clip.id, r);
          } else if (t >= it.end && readers.has(it.clip.id)) {
            const r = readers.get(it.clip.id);
            if (r.gen) await r.gen.return();
            readers.delete(it.clip.id);
          }
        }
        for (const o of T.overlays) {
          if (t >= o.start && t < o.start + o.dur) {
            if (!readers.has(o.id)) readers.set(o.id, await openReader(o, 'overlay'));
            const r = readers.get(o.id);
            await frameAt(r, o.in + (t - o.start));
            wanted.set(o.id, r);
          }
        }
        compose(ctx, W, H, t, lay, getSource);
        const ct = t - payload.offset;
        const ch = payload.chunks.find(c => ct >= c.start && ct < c.end);
        if (ch) drawChunk(ctx, W, H, ch, ct, payload.style, ch.pos || payload.pos);
        await videoSource.add(t, 1 / fps);
        if (f % 5 === 0) onProgress(0.08 + 0.91 * f / totalFrames);
      }
      videoSource.close();
      await output.finalize();
    } catch (e) {
      await output.cancel().catch(() => {});
      await out.discard();
      throw e;
    } finally {
      for (const r of readers.values()) if (r.gen) r.gen.return().catch(() => {});
      for (const i of inputs) i.dispose?.();
    }
    const blob = await out.finish();
    const name = `${(media.get(T.clips[0] ? T.clips[0].m : T.audio[0].m).name).replace(/\.[^.]+$/, '')}_edit.mp4`;
    return B2.finishExport(blob, name, codec);
  }

  window.TL = {
    clearProject, init, load, serialize, tick, render, renderInspector, syncVideo, addFiles, addMedia, addAudioItem, edit, renderMix, exportVideo, stagePointer,
    isReady: () => !!S.video,
    duration: () => total(),
    time: () => ui.clock,
    playing: () => ui.playing,
    seek: t => { ui.clock = clamp(t, 0, total()); ui.lastNow = performance.now(); },
    toggle: () => { if (ui.clock >= total() - 0.02) ui.clock = 0; ui.playing = !ui.playing; ui.lastNow = performance.now(); if (!ui.playing) pauseAll(); },
    pause: pauseAll,
    setCaptionsFree: v => { T.captionsFree = v; },
    relinkNotice,
    hasMissing: () => missingMedia().length > 0,
    capsHidden: () => T.tracks.caps.hide,
    selectedCaptions: () => selectionList().filter(x => x.kind === 'cap' && !locked('cap')).map(x => x.item),
  };
})();
