/* The video editor: a timeline of clips, overlays and sound. Preview and export draw through the same compose(),
   so what plays is what gets saved. Captions stay attached to the footage when clips are cut or moved. */
(function () {
  const T = { canvas: { w: 1080, h: 1920, bg: '#000000' }, clips: [], overlays: [], audio: [], captionsFree: false };
  const media = new Map();
  const ui = { pps: 40, selected: null, clock: 0, playing: false, drag: null, lastNow: 0 };
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
    ui.selected = null; ui.clock = 0;
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
    for (const o of T.overlays) {
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
      syncVideoEl(e, src, it.clip.speed, it.clip.muted ? 0 : it.clip.volume * p * fadeOut);
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
      if (a.kind !== 'voice' || t < a.start || t >= a.start + (a.out - a.in)) continue;
      const e = auds.get(a.id);
      if (running(e)) return a.start + (e.currentTime - a.in);
    }
    for (const it of layout().items) {
      if (t < it.start || t >= it.end) continue;
      const e = els.get(it.clip.id);
      if (it.overlap <= 0 && running(e) && e.tagName === 'VIDEO' && !it.clip.muted) return it.start + (e.currentTime - it.clip.in) / it.clip.speed;
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
      e.volume = clamp(v, 0, 1);
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
  const fmtT = v => `${Math.floor(v / 60)}:${String(Math.floor(v % 60)).padStart(2, '0')}`;
  function select(kind, id) { ui.selected = id ? { kind, id } : null; render(); renderInspector(); if (id) showTab('clip'); }
  const selectedItem = () => {
    if (!ui.selected) return null;
    const list = ui.selected.kind === 'clip' ? T.clips : ui.selected.kind === 'overlay' ? T.overlays : T.audio;
    return list.find(x => x.id === ui.selected.id) || null;
  };
  function block(kind, item, left, width, label, track) {
    const b = document.createElement('div');
    const sel = ui.selected && ui.selected.id === item.id;
    b.className = `tlb ${kind}${sel ? ' on' : ''}`;
    b.style.left = `${left}px`; b.style.width = `${Math.max(6, width)}px`;
    b.dataset.kind = kind; b.dataset.id = item.id;
    const m = media.get(item.m);
    if (m && m.thumb && kind !== 'audio') b.style.backgroundImage = `url(${m.thumb})`;
    if (!m || !m.file) b.classList.add('missing');
    const name = document.createElement('span'); name.textContent = label; b.appendChild(name);
    if (sel) {
      const l = document.createElement('i'); l.className = 'h l'; l.dataset.edge = 'l';
      const r = document.createElement('i'); r.className = 'h r'; r.dataset.edge = 'r';
      b.append(l, r);
    }
    track.appendChild(b);
    return b;
  }
  function render() {
    const host = el('tlTracks');
    if (!host) return;
    const lay = layout(), tot = total(), pps = ui.pps;
    const inner = el('tlInner');
    inner.style.width = `${Math.max(host.clientWidth, (tot + 3) * pps)}px`;
    const ruler = el('tlRuler');
    ruler.textContent = '';
    const step = pps > 60 ? 1 : pps > 20 ? 5 : 15;
    for (let s = 0; s <= tot + 3; s += step) {
      const k = document.createElement('b'); k.style.left = `${s * pps}px`; k.textContent = fmtT(s); ruler.appendChild(k);
    }
    const tv = el('tlVideo'), to = el('tlOverlay'), ta = el('tlAudio'), tc = el('tlCaps');
    tv.textContent = ''; to.textContent = ''; ta.textContent = ''; tc.textContent = '';
    lay.items.forEach((it, i) => {
      const m = media.get(it.clip.m);
      const b = block('clip', it.clip, it.start * pps, (it.end - it.start) * pps, `${it.clip.speed !== 1 ? `${it.clip.speed}x ` : ''}${m ? m.name : '?'}`, tv);
      if (i > 0 && it.clip.trans !== 'none') { const d = document.createElement('em'); d.textContent = '⧖'; b.appendChild(d); }
    });
    T.overlays.forEach(o => block('overlay', o, o.start * pps, o.dur * pps, (media.get(o.m) || {}).name || '?', to));
    T.audio.forEach(a => block('audio', a, a.start * pps, (a.out - a.in) * pps, `${a.kind === 'voice' ? '🎙' : '🎵'} ${a.name || ''}`, ta));
    S.chunks.forEach(c => {
      const d = document.createElement('div');
      d.className = 'tlcap'; d.style.left = `${c.start * pps}px`; d.style.width = `${Math.max(2, (c.end - c.start) * pps - 1)}px`;
      d.title = c.text; tc.appendChild(d);
    });
    const hasStuff = T.clips.length + T.audio.length > 0;
    ['tlSplit', 'tlDelete', 'tlDup'].forEach(id => { el(id).disabled = !hasStuff; });
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
  const seekTrack = e => {
    const r = el('tlInner').getBoundingClientRect();
    TL.seek((e.clientX - r.left) / ui.pps);
    render();
  };

  // ---- Toolbar actions ----
  function split() {
    const lay = layout(), t = ui.clock;
    const sel = selectedItem();
    if (ui.selected && ui.selected.kind === 'audio' && sel && t > sel.start && t < sel.start + (sel.out - sel.in)) {
      edit(() => { const at = sel.in + (t - sel.start); const b = { ...sel, id: uid(), in: at, start: t }; sel.out = at; T.audio.push(b); }, { keepCaptions: true });
      return;
    }
    if (ui.selected && ui.selected.kind === 'overlay' && sel && t > sel.start && t < sel.start + sel.dur) {
      edit(() => { const d = t - sel.start; const b = { ...sel, id: uid(), start: t, in: sel.in + d, dur: sel.dur - d }; sel.dur = d; T.overlays.push(b); }, { keepCaptions: true });
      return;
    }
    const it = lay.items.find(i => t > i.start + 0.03 && t < i.end - 0.03);
    if (!it) { setNotice('ວາງເສັ້ນເວລາໄວ້ເທິງຄິບກ່ອນ ແລ້ວກົດຕັດ'); return; }
    edit(() => {
      const at = it.clip.in + (t - it.start) * it.clip.speed;
      const b = { ...it.clip, id: uid(), in: at, trans: 'none' };
      it.clip.out = at;
      T.clips.splice(T.clips.indexOf(it.clip) + 1, 0, b);
      ui.selected = { kind: 'clip', id: b.id };
    });
  }
  function removeSelected() {
    const sel = selectedItem();
    if (!sel) { setNotice('ກົດເລືອກຄິບກ່ອນ'); return; }
    const kind = ui.selected.kind;
    edit(() => {
      if (kind === 'clip') T.clips.splice(T.clips.indexOf(sel), 1);
      else if (kind === 'overlay') T.overlays.splice(T.overlays.indexOf(sel), 1);
      else T.audio.splice(T.audio.indexOf(sel), 1);
      ui.selected = null;
    }, { keepCaptions: kind !== 'clip' });
  }
  function duplicate() {
    const sel = selectedItem();
    if (!sel) { setNotice('ກົດເລືອກຄິບກ່ອນ'); return; }
    edit(() => {
      const b = { ...sel, id: uid() };
      if (ui.selected.kind === 'clip') T.clips.splice(T.clips.indexOf(sel) + 1, 0, b);
      else if (ui.selected.kind === 'overlay') { b.start = sel.start + sel.dur; T.overlays.push(b); } else { b.start = sel.start + (sel.out - sel.in); T.audio.push(b); }
      ui.selected = { kind: ui.selected.kind, id: b.id };
    });
  }

  // ---- Dragging: only an already selected block moves, so a finger can still scroll the timeline ----
  function pointerDown(e) {
    const handle = e.target.closest('.h');
    const b = e.target.closest('.tlb');
    if (!b) return;
    const id = b.dataset.id, kind = b.dataset.kind;
    if (!ui.selected || ui.selected.id !== id) { select(kind, id); return; }
    const item = selectedItem();
    ui.drag = { kind, item, edge: handle ? handle.dataset.edge : null, x0: e.clientX, snap: JSON.parse(JSON.stringify(item)), moved: false, before: layout() };
    e.target.setPointerCapture(e.pointerId);
    e.preventDefault();
  }
  function pointerMove(e) {
    const d = ui.drag;
    if (!d) return;
    const dt = (e.clientX - d.x0) / ui.pps;
    if (Math.abs(e.clientX - d.x0) > 4) d.moved = true;
    if (!d.moved) return;
    const m = media.get(d.item.m), s = d.snap, it = d.item;
    if (d.kind === 'clip') {
      if (d.edge === 'l') it.in = clamp(s.in + dt * s.speed, 0, s.out - 0.1);
      else if (d.edge === 'r') it.out = clamp(s.out + dt * s.speed, s.in + 0.1, m && m.kind === 'video' ? m.duration : 3600);
      else {
        const lay = layout(), cur = T.clips.indexOf(it);
        const r = el('tlInner').getBoundingClientRect(), x = (e.clientX - r.left) / ui.pps;
        let to = lay.items.findIndex(i => x < (i.start + i.end) / 2);
        if (to < 0) to = T.clips.length - 1;
        if (to !== cur) { T.clips.splice(cur, 1); T.clips.splice(to, 0, it); }
      }
    } else if (d.kind === 'overlay') {
      if (d.edge === 'l') { const nd = clamp(s.dur - dt, 0.2, 3600); it.start = s.start + (s.dur - nd); it.dur = nd; if (m && m.kind === 'video') it.in = Math.max(0, s.in + (s.dur - nd)); }
      else if (d.edge === 'r') it.dur = clamp(s.dur + dt, 0.2, m && m.kind === 'video' ? m.duration - s.in : 3600);
      else it.start = Math.max(0, s.start + dt);
    } else if (d.edge === 'l') {
      const delta = clamp(dt, -s.in, s.out - s.in - 0.1); it.in = s.in + delta; it.start = s.start + delta;
    } else if (d.edge === 'r') it.out = clamp(s.out + dt, s.in + 0.1, m ? m.duration : 3600);
    else it.start = Math.max(0, s.start + dt);
    syncVideo();
    render();
  }
  function pointerUp() {
    const d = ui.drag;
    ui.drag = null;
    if (!d || !d.moved) return;
    if (d.kind === 'clip') { remapCaptions(d.before, layout()); }
    syncVideo(); render(); renderInspector(); commit();
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
    if (kind === 'clip') {
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
    close.onclick = () => select(null, null);
    host.appendChild(close);
  }

  // ---------- Persistence ----------
  const serialize = () => ({ canvas: T.canvas, clips: T.clips, overlays: T.overlays, audio: T.audio, captionsFree: T.captionsFree, media: [...media.values()].map(({ id, name, kind, width, height, duration, hasAudio }) => ({ id, name, kind, width, height, duration, hasAudio })) });
  function load(data) {
    if (!data) return;
    Object.assign(T, { canvas: data.canvas, clips: data.clips, overlays: data.overlays, audio: data.audio, captionsFree: !!data.captionsFree });
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
      <div class="tlbar">
        <button id="tlNew" title="ລ້າງໄທມ໌ລາຍ ເພື່ອເລີ່ມໂປຣເຈັກໃໝ່">🗋 ໃໝ່</button>
        <button id="tlAdd" title="ເພີ່ມຄິບ ຫຼື ຮູບ">＋ ຄິບ</button>
        <button id="tlSplit" title="ຕັດຄິບຢູ່ເສັ້ນເວລາ">✂ ຕັດ</button>
        <button id="tlDelete" title="ລົບສິ່ງທີ່ເລືອກ">🗑</button>
        <button id="tlDup" title="ສຳເນົາສິ່ງທີ່ເລືອກ">⧉</button>
        <button id="tlAddAudio" title="ເພີ່ມເພງ ຫຼື ສຽງພາກ">🎵 ສຽງ</button>
        <button id="tlAddOverlay" title="ເພີ່ມໂລໂກ້ ຫຼື ພາບຊ້ອນ">🖼 ຊ້ອນ</button>
        <span class="grow"></span>
        <span id="tlTime" class="mono small muted"></span>
        <button id="tlOut" title="ຍໍ່">−</button><button id="tlIn" title="ຂະຫຍາຍ">＋</button>
      </div>
      <div id="tlTracks"><div id="tlInner">
        <div id="tlRuler"></div>
        <div id="tlVideo" class="tltrack"></div>
        <div id="tlOverlay" class="tltrack slim"></div>
        <div id="tlAudio" class="tltrack slim"></div>
        <div id="tlCaps" class="tltrack caps"></div>
        <div id="tlHead"></div>
      </div></div>
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
    el('tlIn').onclick = () => { ui.pps = Math.min(240, ui.pps * 1.5); render(); };
    el('tlOut').onclick = () => { ui.pps = Math.max(4, ui.pps / 1.5); render(); };
    const inner = el('tlInner');
    inner.addEventListener('pointerdown', pointerDown);
    inner.addEventListener('pointermove', pointerMove);
    inner.addEventListener('pointerup', pointerUp);
    inner.addEventListener('pointercancel', pointerUp);
    let rulerDown = false;
    const ruler = el('tlRuler');
    ruler.addEventListener('pointerdown', e => { rulerDown = true; ruler.setPointerCapture(e.pointerId); seekTrack(e); });
    ruler.addEventListener('pointermove', e => { if (rulerDown) seekTrack(e); });
    ruler.addEventListener('pointerup', () => { rulerDown = false; });
    el('tlVideo').addEventListener('click', e => { if (!e.target.closest('.tlb')) { seekTrack(e); select(null, null); } });
    document.addEventListener('keydown', e => {
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
      if (e.key === 's' || e.key === 'S') split();
      if (e.key === 'Delete' || e.key === 'Backspace') removeSelected();
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
      if (!m || !m.file || !m.hasAudio || it.clip.muted || it.clip.volume <= 0) return;
      const next = lay.items[i + 1];
      jobs.push({ m, from: it.clip.in, to: it.clip.out, at: it.start, rate: it.clip.speed, volume: it.clip.volume, fadeIn: it.overlap, fadeOut: next ? next.overlap : 0 });
    });
    T.audio.forEach(a => {
      if (excludeMusic && a.kind === 'music') return;
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
    if (T.clips.length !== 1 || T.overlays.length || T.audio.length) return null;
    const c = T.clips[0], m = media.get(c.m);
    const plain = m && m.kind === 'video' && c.in === 0 && Math.abs(c.out - m.duration) < 0.001 && c.speed === 1 && !c.muted && c.volume === 1 && c.zoom === 1 && !c.x && !c.y
      && c.bright === 1 && c.contrast === 1 && c.sat === 1 && T.canvas.w === m.width - (m.width % 2) && T.canvas.h === m.height - (m.height % 2);
    return plain ? m : null;
  }
  async function exportVideo(payload, onProgress, isCancelled) {
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
  };
})();
