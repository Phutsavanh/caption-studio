/* Caption Studio UI. Data model: a flat list of words, each with its own timing. Captions ("chunks") are always
   derived from it, so changing 2/3/4 words per caption never loses edits, emphasis or timing. */
const { DEFAULT_STYLE, IN, OUT, LOOP, drawChunk } = window.CaptionRender;
const $ = id => document.getElementById(id);
const api = async (url, body) => {
  const r = await fetch(url, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || 'ເກີດຂໍ້ຜິດພາດ');
  return j;
};

const B = window.CS_BACKEND || null; // set on the serverless web version
const DEMO_SCRIPT = 'ບອກເລີຍວ່າ ຖ້າໃຜຍັງບໍ່ເຄິຍລອງ Speedcat ຖືວ່າພາດແຮງ!!\nເພາະສອງຄູ່ນີ້ ເຮັດໃຫ້ເບິ່ງຂາຍາວຂຶ້ນ';
const S = {
  video: null, words: [], chunks: [], n: 3, countMode: 'auto', style: { ...DEFAULT_STYLE }, pos: { x: 0.5, y: 0.7 }, offset: 0,
  presetId: 'classic99', selected: 0, draft: false, demo: true, script: '',
};
const video = $('video'), canvas = $('canvas'), ctx = canvas.getContext('2d'), stage = $('stage');
let myPresets = [], fontsList = [], demoT = 0, demoPlaying = true, lastTick = performance.now(), replay = null, bbox = null, drag = null, snapGuide = false;

// ---------- Tokenising: split Lao only at real word boundaries, never by character count ----------
const segmenter = new Intl.Segmenter('lo', { granularity: 'word' });
const OPENERS = /^[("'“‘\[{«]+$/;
const LAO_MARK_START = /^[ັິ-ຼ່-ໍ]/;
const LONE_CONSONANT = /^[ກ-ຮໜ-ໟ]$/;

function tokenize(text, mode) {
  const out = [];
  if (mode === 'space') {
    for (const m of text.matchAll(/\S+/g)) out.push({ text: m[0], i: m.index, len: m[0].length, spaceAfter: true });
  } else {
    let prefix = '', prefixAt = -1;
    for (const s of segmenter.segment(text)) {
      if (s.isWordLike) {
        out.push({ text: prefix + s.segment, i: prefix ? prefixAt : s.index, len: s.segment.length + prefix.length, spaceAfter: false });
        prefix = '';
      } else {
        let k = s.index;
        for (const ch of s.segment) {
          if (/\s/.test(ch)) { if (out.length) out[out.length - 1].spaceAfter = true; }
          else if (OPENERS.test(ch) || !out.length) { if (!prefix) prefixAt = k; prefix += ch; }
          else { out[out.length - 1].text += ch; out[out.length - 1].len++; }
          k += ch.length;
        }
      }
    }
    if (prefix && out.length) out[out.length - 1].text += prefix;
    // Safety net: never leave a floating mark or lone consonant as its own "word".
    for (let i = out.length - 1; i > 0; i--) {
      if (LAO_MARK_START.test(out[i].text) || /^ໆ/.test(out[i].text) || (LONE_CONSONANT.test(out[i].text) && !out[i - 1].spaceAfter)) {
        out[i - 1].text += out[i].text; out[i - 1].len += out[i].len; out[i - 1].spaceAfter = out[i].spaceAfter;
        out.splice(i, 1);
      }
    }
  }
  return out;
}

function timeAt(anchors, i, fallback) {
  if (!anchors.length) return fallback;
  if (i <= anchors[0][0]) return anchors[0][1];
  for (let k = 1; k < anchors.length; k++) {
    if (i <= anchors[k][0]) {
      const [a, ta] = anchors[k - 1], [b, tb] = anchors[k];
      return ta + (tb - ta) * (b === a ? 0 : (i - a) / (b - a));
    }
  }
  return anchors[anchors.length - 1][1];
}

/** line {text, times:[[charIndex,sec]...]} -> words with their own start/end. */
function wordsFromLine(line, lineId, mode, nextStart) {
  const tokens = tokenize(line.text, mode);
  const words = tokens.map(tk => ({
    text: tk.text, spaceAfter: tk.spaceAfter, line: lineId, emph: /!/.test(tk.text),
    start: timeAt(line.times, tk.i, 0), charLen: [...tk.text].length,
  }));
  for (let i = 1; i < words.length; i++) words[i].start = Math.max(words[i].start, words[i - 1].start + 0.05);
  words.forEach((w, i) => {
    const next = i + 1 < words.length ? words[i + 1].start : nextStart;
    const natural = Math.max(0.3, w.charLen * 0.13);
    w.end = Math.min(next ?? w.start + natural, Math.max(w.start + natural, w.start + 0.12));
    if (next != null && next - w.start < natural) w.end = next;
    delete w.charLen;
  });
  return words;
}

/** Fill in lines the aligner could not place, then turn all lines into words. */
function linesToWords(lines, duration, mode) {
  const cum = [0];
  lines.forEach(l => cum.push(cum[cum.length - 1] + Math.max(1, l.text.length)));
  const starts = lines.map(l => (l.times && l.times.length ? l.times[0][1] : null));
  lines.forEach((l, k) => {
    if (starts[k] != null) return;
    let lo = k - 1; while (lo >= 0 && starts[lo] == null) lo--;
    let hi = k + 1; while (hi < lines.length && starts[hi] == null) hi++;
    const ta = lo >= 0 ? starts[lo] : 0, ca = lo >= 0 ? cum[lo] : 0;
    const tb = hi < lines.length ? starts[hi] : duration, cb = hi < lines.length ? cum[hi] : cum[lines.length];
    const s = ta + (tb - ta) * (cum[k] - ca) / Math.max(1, cb - ca);
    const e = ta + (tb - ta) * (cum[k + 1] - ca) / Math.max(1, cb - ca);
    l.times = [[0, s], [l.text.length, e]];
    starts[k] = s;
  });
  const words = [];
  lines.forEach((l, k) => words.push(...wordsFromLine(l, k, mode, k + 1 < lines.length ? starts[k + 1] : duration)));
  return words;
}

function evenLines(text, duration) {
  const raw = text.split('\n').map(x => x.trim()).filter(Boolean);
  const total = raw.reduce((a, l) => a + l.length, 0) || 1;
  let t = 0;
  return raw.map(l => {
    const d = duration * l.length / total;
    const line = { text: l, times: [[0, t], [l.length, t + d]] };
    t += d;
    return line;
  });
}

/** Rebuild words from the current words when the counting method changes, keeping their timing. */
function retokenize() {
  const groups = new Map();
  S.words.forEach(w => { if (!groups.has(w.line)) groups.set(w.line, []); groups.get(w.line).push(w); });
  const dur = duration();
  const lines = [...groups.values()].map(ws => {
    let text = ''; const times = [];
    ws.forEach(w => { times.push([text.length, w.start]); text += w.text + (w.spaceAfter ? ' ' : ''); });
    times.push([text.trimEnd().length, ws[ws.length - 1].end]);
    return { text: text.trimEnd(), times };
  });
  const old = S.words;
  S.words = linesToWords(lines, dur, S.countMode);
  S.words.forEach(w => { const m = old.find(o => o.text === w.text && Math.abs(o.start - w.start) < 0.3); if (m) { w.emph = m.emph; w.pos = m.pos; } });
}

// ---------- Captions from words ----------
function rebuild() {
  const n = S.n > 0 ? S.n : Infinity;
  const chunks = [];
  let cur = [], count = 0;
  const flush = () => { if (cur.length) chunks.push({ words: cur }); cur = []; count = 0; };
  S.words.forEach((w, i) => {
    const prev = S.words[i - 1];
    if (prev && cur.length) {
      const pause = w.start - prev.end > 0.6 && !prev.glue;
      if (prev.line !== w.line || prev.brk || pause) flush();
      else if (!prev.glue && count >= n) flush();
    }
    cur.push(w);
    if (!w.glue) count++;
  });
  if (cur.length && cur[cur.length - 1].glue) count++;
  flush();
  chunks.forEach((c, i) => {
    c.idx = i;
    c.start = c.words[0].start;
    c.end = Math.max(c.words[c.words.length - 1].end, c.start + 0.3);
    c.text = c.words.map((w, k) => w.text + (w.spaceAfter && k < c.words.length - 1 ? ' ' : '')).join('');
    const pinned = c.words.find(w => w.pos);
    c.pos = pinned ? pinned.pos : null;
  });
  // No gaps that flicker and no overlaps between neighbours.
  for (let i = 0; i + 1 < chunks.length; i++) {
    const gap = chunks[i + 1].start - chunks[i].end;
    if (gap < 0.3) chunks[i].end = chunks[i + 1].start;
  }
  S.chunks = chunks;
  S.selected = Math.min(S.selected, Math.max(0, chunks.length - 1));
  renderChunkList();
}
const chunkAt = t => S.chunks.find(c => t >= c.start && t < c.end) || null;

// ---------- History & persistence ----------
const snapshot = () => JSON.stringify({ words: S.words, n: S.n, countMode: S.countMode, style: S.style, pos: S.pos, offset: S.offset, presetId: S.presetId, draft: S.draft, script: S.script });
let history = [], saveTimer = null;
function restore(json) {
  Object.assign(S, JSON.parse(json));
  syncControls();
  rebuild();
  renderStylePanels();
  markPreset();
  ensureFont();
}
function commit() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const snap = snapshot();
    if (history[history.length - 1] !== snap) { history.push(snap); if (history.length > 60) history.shift(); }
    if (S.video) localStorage.setItem(`cs.project.${S.video.id}`, snap);
    else localStorage.setItem('cs.project.demo', snap);
  }, 300);
}
function undo() {
  if (history.length < 2) return;
  history.pop();
  restore(history[history.length - 1]);
  if (S.video) localStorage.setItem(`cs.project.${S.video.id}`, history[history.length - 1]);
}

// ---------- Clock ----------
const duration = () => (S.video ? S.video.duration || video.duration || 1 : 9);
const currentTime = () => (S.video ? video.currentTime : demoT);
const isPlaying = () => (S.video ? !video.paused : demoPlaying);
function seek(t) { t = Math.max(0, Math.min(duration(), t)); if (S.video) video.currentTime = t; else demoT = t; replay = null; }
function togglePlay() {
  replay = null;
  if (S.video) { if (video.paused) video.play(); else video.pause(); } else demoPlaying = !demoPlaying;
}
const fmt = t => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}`;
const fmt2 = t => t.toFixed(2);

// ---------- Stage & draw loop ----------
function fitStage() {
  const wrap = $('stageWrap').getBoundingClientRect();
  const vw = S.video ? S.video.width : 1080, vh = S.video ? S.video.height : 1920;
  const k = Math.min(wrap.width / vw, wrap.height / vh);
  const w = Math.max(10, Math.floor(vw * k)), h = Math.max(10, Math.floor(vh * k));
  stage.style.width = `${w}px`; stage.style.height = `${h}px`;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
}
new ResizeObserver(fitStage).observe($('stageWrap'));

function drawOverlayUI(t) {
  const W = canvas.width, H = canvas.height;
  if ($('safe').checked) {
    ctx.save();
    ctx.fillStyle = 'rgba(255,60,60,.13)';
    ctx.fillRect(0, 0, W, H * 0.073);
    ctx.fillRect(0, H * 0.83, W, H * 0.17);
    ctx.fillRect(W * 0.87, H * 0.38, W * 0.13, H * 0.45);
    ctx.restore();
  }
  if (snapGuide) { ctx.save(); ctx.strokeStyle = '#3dd8ff'; ctx.setLineDash([8, 6]); ctx.beginPath(); ctx.moveTo(W / 2, 0); ctx.lineTo(W / 2, H); ctx.stroke(); ctx.restore(); }
  if (bbox && (!isPlaying() || drag)) {
    const px = 10, k = canvas.width / canvas.getBoundingClientRect().width;
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,.75)';
    ctx.setLineDash([6, 5]);
    ctx.strokeRect(bbox.x - px, bbox.y - px, bbox.w + 2 * px, bbox.h + 2 * px);
    ctx.setLineDash([]);
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = '#000';
    const hx = bbox.x + bbox.w + px, hy = bbox.y + bbox.h + px;
    ctx.beginPath(); ctx.arc(hx, hy, (S.remote ? 11 : 8) * k, 0, 7); ctx.fill(); ctx.stroke();
    ctx.restore();
  }
}

function frame(now) {
  requestAnimationFrame(frame);
  const dt = (now - lastTick) / 1000; lastTick = now;
  if (!S.video && demoPlaying && !exporting) { demoT += dt; if (demoT >= duration()) demoT = 0; }
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  let t = currentTime() - S.offset;
  let ch = chunkAt(t), ghost = false;
  if (replay) {
    const rt = replay.chunk.start + (now - replay.t0) / 1000;
    if (rt >= replay.chunk.end) replay = null;
    else { t = rt; ch = replay.chunk; }
  }
  if (!ch && !isPlaying() && S.chunks.length) {
    ch = S.chunks[S.selected]; t = ch ? (ch.start + ch.end) / 2 : t; ghost = true;
  }
  bbox = ch ? drawChunk(ctx, W, H, ch, t, S.style, ch.pos || S.pos, { ghost }) : null;
  if (ch && !ghost && ch.idx !== S.selected && isPlaying()) selectChunk(ch.idx, false);
  drawOverlayUI(t);
  if (!scrubbing) $('scrub').value = Math.round(currentTime() / duration() * 1000);
  $('time').textContent = fmt(currentTime());
  $('btnPlay').textContent = isPlaying() ? '❚❚' : '▶';
  drawThumbs(now);
}

// ---------- Dragging captions on the clip ----------
const toCanvas = e => { const r = canvas.getBoundingClientRect(); return { x: (e.clientX - r.left) * canvas.width / r.width, y: (e.clientY - r.top) * canvas.height / r.height }; };
function hit(p) {
  if (!bbox) return null;
  const hx = bbox.x + bbox.w + 10, hy = bbox.y + bbox.h + 10;
  const k = canvas.width / canvas.getBoundingClientRect().width, grab = (S.remote ? 30 : 22) * k, pad = 16 * k;
  if (Math.hypot(p.x - hx, p.y - hy) < grab) return 'resize';
  return p.x > bbox.x - pad && p.x < bbox.x + bbox.w + pad && p.y > bbox.y - pad && p.y < bbox.y + bbox.h + pad ? 'move' : null;
}
canvas.addEventListener('pointerdown', e => {
  const p = toCanvas(e), what = hit(p);
  if (!what) { togglePlay(); return; }
  canvas.setPointerCapture(e.pointerId);
  const ch = S.chunks[S.selected];
  const base = $('dragOne').checked && ch ? (ch.pos || S.pos) : S.pos;
  drag = { what, p0: p, pos0: { ...base }, size0: S.style.size, w0: bbox.w };
  if (video && S.video && !video.paused) video.pause();
  demoPlaying = false;
});
canvas.addEventListener('pointermove', e => {
  const p = toCanvas(e);
  if (!drag) { canvas.style.cursor = hit(p) === 'resize' ? 'nwse-resize' : hit(p) ? 'move' : 'pointer'; return; }
  if (drag.what === 'resize') {
    const k = 1 + (p.x - drag.p0.x) / Math.max(40, drag.w0 / 2);
    S.style.size = Math.round(Math.max(24, Math.min(260, drag.size0 * k)));
    updatePanelValue('size');
  } else {
    let x = drag.pos0.x + (p.x - drag.p0.x) / canvas.width;
    const y = Math.max(0.02, Math.min(0.98, drag.pos0.y + (p.y - drag.p0.y) / canvas.height));
    snapGuide = Math.abs(x - 0.5) < 0.015;
    if (snapGuide) x = 0.5;
    x = Math.max(0.02, Math.min(0.98, x));
    const ch = S.chunks[S.selected];
    if ($('dragOne').checked && ch) { ch.words[0].pos = { x, y }; ch.pos = ch.words[0].pos; } else S.pos = { x, y };
    markPosSeg();
  }
});
const endDrag = () => { if (drag) { drag = null; snapGuide = false; renderChunkList(); commit(); } };
canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);
canvas.addEventListener('wheel', e => {
  if (!bbox) return;
  e.preventDefault();
  S.style.size = Math.max(24, Math.min(260, S.style.size + (e.deltaY < 0 ? 3 : -3)));
  updatePanelValue('size');
  commit();
}, { passive: false });

// ---------- Caption list ----------
function selectChunk(i, doSeek = true) {
  const prev = S.selected;
  S.selected = i;
  if (doSeek && S.chunks[i]) { seek(S.chunks[i].start + S.offset + 0.001); if (S.video) video.pause(); else demoPlaying = false; }
  if (prev !== i || doSeek) renderChunkList();
}
function chunkDom(c) {
  const el = document.createElement('div');
  el.className = `chunk${c.idx === S.selected ? ' on' : ''}`;
  el.dataset.i = c.idx;
  el.innerHTML = `<div class="head"><span class="t">${fmt2(c.start)}</span><span class="txt"></span>${c.pos ? '<span class="pinned" title="ຍ້າຍສະເພາະປະໂຫຍກນີ້">📌</span>' : ''}</div>`;
  el.querySelector('.txt').textContent = c.text;
  return el;
}
function renderChunkList() {
  const list = $('chunkList');
  const scroll = list.parentElement.scrollTop;
  list.textContent = '';
  S.chunks.forEach(c => {
    const el = chunkDom(c);
    el.addEventListener('click', e => { if (!e.target.closest('.edit')) selectChunk(c.idx); });
    if (c.idx === S.selected) el.appendChild(editorFor(c));
    list.appendChild(el);
  });
  list.parentElement.scrollTop = scroll;
  const on = list.querySelector('.chunk.on');
  if (on && isPlaying()) on.scrollIntoView({ block: 'nearest' });
}
function editorFor(c) {
  const box = document.createElement('div');
  box.className = 'edit';
  const input = document.createElement('input');
  input.type = 'text'; input.value = c.text; input.title = 'ແກ້ຄຳຢູ່ນີ້ແລ້ວກົດ Enter';
  input.addEventListener('keydown', e => { if (e.key === 'Enter') input.blur(); e.stopPropagation(); });
  input.addEventListener('change', () => replaceChunkText(c, input.value));
  box.appendChild(input);

  const chips = document.createElement('div');
  chips.className = 'chips';
  c.words.forEach((w, i) => {
    const b = document.createElement('button');
    b.className = `chip${w.emph ? ' emph' : ''}`; b.textContent = w.text; b.title = 'ກົດເພື່ອເນັ້ນຄຳນີ້';
    b.onclick = () => { w.emph = !w.emph; rebuild(); commit(); };
    chips.appendChild(b);
    const j = document.createElement('button');
    const next = S.words[S.words.indexOf(w) + 1];
    if (next && next.line === w.line) {
      j.className = `joint${w.glue ? ' glue' : w.brk ? ' brk' : ''}`;
      j.textContent = w.glue ? '＋' : w.brk ? '✂' : '·';
      j.title = 'ກົດ: ＋ ຕິດຄຳຖັດໄປເປັນຄຳດຽວ / ✂ ຕັດປະໂຫຍກທີ່ນີ້';
      j.onclick = () => { if (w.glue) { w.glue = false; w.brk = true; } else if (w.brk) w.brk = false; else w.glue = true; rebuild(); commit(); };
      chips.appendChild(j);
    }
  });
  box.appendChild(chips);

  const times = document.createElement('div');
  times.className = 'times';
  const mk = (val, fn) => { const i = document.createElement('input'); i.type = 'number'; i.step = '0.05'; i.value = fmt2(val); i.addEventListener('keydown', e => e.stopPropagation()); i.addEventListener('change', () => fn(Number(i.value))); return i; };
  times.appendChild(mk(c.start, v => retimeChunk(c, v, c.end)));
  times.appendChild(mk(c.end, v => retimeChunk(c, c.start, v)));
  const unpin = document.createElement('button');
  unpin.className = 'tiny'; unpin.textContent = '📌✕'; unpin.title = 'ກັບໄປໃຊ້ບ່ອນວາງຫຼັກ'; unpin.disabled = !c.pos;
  unpin.onclick = () => { c.words.forEach(w => delete w.pos); rebuild(); commit(); };
  const del = document.createElement('button');
  del.className = 'tiny'; del.textContent = 'ລົບ';
  del.onclick = () => { S.words = S.words.filter(w => !c.words.includes(w)); rebuild(); commit(); };
  times.append(unpin, del);
  box.appendChild(times);
  return box;
}
function replaceChunkText(c, text) {
  text = text.trim();
  const at = S.words.indexOf(c.words[0]);
  if (at < 0) return;
  const line = c.words[0].line;
  const next = S.words[at + c.words.length];
  const end = c.end;
  const fresh = text ? wordsFromLine({ text, times: [[0, c.start], [text.length, end]] }, line, S.countMode, end) : [];
  if (fresh.length) fresh[fresh.length - 1].end = end;
  if (c.pos && fresh.length) fresh[0].pos = c.pos;
  const lastOld = c.words[c.words.length - 1];
  if (fresh.length && next && next.line === line) fresh[fresh.length - 1].spaceAfter = lastOld.spaceAfter;
  S.words.splice(at, c.words.length, ...fresh);
  S.draftEdited = true;
  rebuild(); commit();
}
function retimeChunk(c, a, b) {
  if (!(b > a)) { renderChunkList(); return; }
  const k = (b - a) / Math.max(0.01, c.end - c.start);
  const a0 = c.start;
  c.words.forEach(w => { w.start = a + (w.start - a0) * k; w.end = a + (w.end - a0) * k; });
  c.words[c.words.length - 1].end = b;
  rebuild(); commit();
}

// ---------- Style panels ----------
const opts = (o) => Object.entries(o).map(([v, l]) => ({ v, l }));
const LABEL_IN = { none: 'ບໍ່ມີ', pop: 'ປັອບ', bounce: 'ເດັ້ງ', slam: 'ກະແທກ', zoomIn: 'ຊູມເຂົ້າ', fade: 'ຄ່ອຍໆຂຶ້ນ', slideUp: 'ຂຶ້ນຈາກລຸ່ມ', slideDown: 'ລົງຈາກເທິງ', slideLeft: 'ເຂົ້າຈາກຂວາ', slideRight: 'ເຂົ້າຈາກຊ້າຍ', drop: 'ຕົກລົງ', flip: 'ພິກ', stretch: 'ຍືດ', swing: 'ແກວ່ງ', spin: 'ໝຸນ', blurIn: 'ມົວໄປຊັດ', wipe: 'ປາດເຂົ້າ', typewriter: 'ພິມດີດ', glitch: 'ກລິດຊ໌' };
const LABEL_OUT = { none: 'ບໍ່ມີ', fade: 'ຄ່ອຍໆຫາຍ', popOut: 'ຫົດຫາຍ', zoomOut: 'ຊູມອອກ', slideUp: 'ຂຶ້ນເທິງ', slideDown: 'ລົງລຸ່ມ', blurOut: 'ມົວຫາຍ' };
const LABEL_LOOP = { none: 'ບໍ່ມີ', float: 'ລອຍ', pulse: 'ເຕັ້ນ', shake: 'ສັ່ນ', wave: 'ຄື້ນ', swing: 'ໂຍກ', flicker: 'ກະພິບ', glitch: 'ກລິດຊ໌' };

const DECOR = [
  ['ຂະໜາດ ແລະ ຮູບແບບ', [
    { k: 'weight', l: 'ຄວາມໜາ', t: 'seg', o: [{ v: 400, l: 'ບາງ' }, { v: 500, l: 'ກາງ' }, { v: 700, l: 'ໜາ' }, { v: 800, l: 'ໜາກວ່າ' }, { v: 900, l: 'ສຸດ' }] },
    { k: 'size', l: 'ຂະໜາດ', t: 'r', min: 24, max: 260, step: 1 },
    { k: 'letterSpacing', l: 'ຫ່າງຕົວອັກສອນ', t: 'r', min: 0, max: 30, step: 1 },
    { k: 'lineHeight', l: 'ຄວາມສູງແຖວ', t: 'r', min: 1, max: 2, step: 0.05 },
    { k: 'maxWidth', l: 'ກວ້າງສູງສຸດ', t: 'r', min: 0.3, max: 1, step: 0.01 },
    { k: 'align', l: 'ຈັດວາງ', t: 'seg', o: [{ v: 'left', l: 'ຊ້າຍ' }, { v: 'center', l: 'ກາງ' }, { v: 'right', l: 'ຂວາ' }] },
    { k: 'tilt', l: 'ອຽງ', t: 'r', min: -25, max: 25, step: 1 },
  ]],
  ['ສີຕົວໜັງສື', [
    { k: 'fillMode', l: 'ແບບສີ', t: 'seg', o: [{ v: 'solid', l: 'ສີດຽວ' }, { v: 'gradient', l: 'ໄລ່ສີ' }] },
    { k: 'fill', l: 'ສີຫຼັກ', t: 'c' }, { k: 'fill2', l: 'ສີລຸ່ມ (ໄລ່ສີ)', t: 'c' },
  ]],
  ['ຂອບ', [
    { k: 'stroke', l: 'ສີຂອບ', t: 'c' }, { k: 'strokeW', l: 'ຄວາມໜາ', t: 'r', min: 0, max: 40, step: 1 },
    { k: 'stroke2', l: 'ສີຂອບນອກ', t: 'c' }, { k: 'stroke2W', l: 'ຂອບນອກ', t: 'r', min: 0, max: 24, step: 1 },
  ]],
  ['ເງົາ', [
    { k: 'shadow', l: 'ສີເງົາ', t: 'c' }, { k: 'shadowA', l: 'ຄວາມເຂັ້ມ', t: 'r', min: 0, max: 1, step: 0.05 },
    { k: 'shadowBlur', l: 'ຟຸ້ງ', t: 'r', min: 0, max: 60, step: 1 },
    { k: 'shadowX', l: 'ຊ້າຍ-ຂວາ', t: 'r', min: -40, max: 40, step: 1 }, { k: 'shadowY', l: 'ເທິງ-ລຸ່ມ', t: 'r', min: -40, max: 40, step: 1 },
  ]],
  ['ແສງເຮືອງ ແລະ 3D', [
    { k: 'glow', l: 'ສີແສງ', t: 'c' }, { k: 'glowBlur', l: 'ແສງເຮືອງ', t: 'r', min: 0, max: 80, step: 1 },
    { k: 'depthColor', l: 'ສີ 3D', t: 'c' }, { k: 'depth', l: 'ຄວາມໜາ 3D', t: 'r', min: 0, max: 40, step: 1 },
    { k: 'depthAngle', l: 'ມຸມ 3D', t: 'r', min: 0, max: 360, step: 5 },
    { k: 'rgbSplit', l: 'ສີແຕກ (RGB)', t: 'r', min: 0, max: 20, step: 1 },
  ]],
  ['ກ່ອງພື້ນຫຼັງ', [
    { k: 'box', l: 'ແບບກ່ອງ', t: 'seg', o: [{ v: 'none', l: 'ບໍ່ມີ' }, { v: 'line', l: 'ແຖວ' }, { v: 'block', l: 'ກ້ອນດຽວ' }, { v: 'word', l: 'ແຍກຄຳ' }] },
    { k: 'boxColor', l: 'ສີກ່ອງ', t: 'c' }, { k: 'boxA', l: 'ຄວາມທຶບ', t: 'r', min: 0, max: 1, step: 0.05 },
    { k: 'boxRadius', l: 'ມົນ', t: 'r', min: 0, max: 60, step: 1 },
    { k: 'boxPadX', l: 'ຂອບຂ້າງ', t: 'r', min: 0, max: 80, step: 1 }, { k: 'boxPadY', l: 'ຂອບເທິງ-ລຸ່ມ', t: 'r', min: 0, max: 40, step: 1 },
  ]],
  ['ຄຳເນັ້ນ ແລະ ຄຳທີ່ກຳລັງເວົ້າ', [
    { k: 'emphColor', l: 'ສີຄຳເນັ້ນ', t: 'c' }, { k: 'emphScale', l: 'ຂະຫຍາຍຄຳເນັ້ນ', t: 'r', min: 1, max: 1.7, step: 0.01 },
    { k: 'active', l: 'ຄຳກຳລັງເວົ້າ', t: 'seg', o: [{ v: 'none', l: 'ບໍ່ມີ' }, { v: 'color', l: 'ປ່ຽນສີ' }, { v: 'box', l: 'ກ່ອງ' }, { v: 'scale', l: 'ຂະຫຍາຍ' }, { v: 'underline', l: 'ຂີດກ້ອງ' }] },
    { k: 'activeColor', l: 'ສີຄຳເວົ້າ', t: 'c' }, { k: 'activeBox', l: 'ສີກ່ອງຄຳເວົ້າ', t: 'c' },
  ]],
];
const ANIM = [
  ['ລູກຫຼິ້ນຕອນຂຶ້ນ', [
    { k: 'animIn', t: 'grid', o: Object.keys(IN).map(v => ({ v, l: LABEL_IN[v] || v })) },
    { k: 'inDur', l: 'ຄວາມໄວ (ວິ)', t: 'r', min: 0.02, max: 1.2, step: 0.01 },
    { k: 'unit', l: 'ຂຶ້ນແບບ', t: 'seg', o: [{ v: 'line', l: 'ທັງກ້ອນ' }, { v: 'word', l: 'ທີລະຄຳ' }] },
    { k: 'stagger', l: 'ຫ່າງແຕ່ລະຄຳ', t: 'r', min: 0, max: 0.4, step: 0.01 },
    { k: 'pending', l: 'ຄຳທີ່ຍັງບໍ່ເວົ້າ', t: 'seg', o: [{ v: 'show', l: 'ສະແດງເລີຍ' }, { v: 'dim', l: 'ຈາງໄວ້' }, { v: 'hide', l: 'ຂຶ້ນຕາມສຽງ' }] },
  ]],
  ['ລູກຫຼິ້ນຕອນຫາຍ', [
    { k: 'animOut', t: 'grid', o: Object.keys(OUT).map(v => ({ v, l: LABEL_OUT[v] || v })) },
    { k: 'outDur', l: 'ຄວາມໄວ (ວິ)', t: 'r', min: 0.02, max: 0.8, step: 0.01 },
  ]],
  ['ລູກຫຼິ້ນຕະຫຼອດ', [
    { k: 'loop', t: 'grid', o: Object.keys(LOOP).map(v => ({ v, l: LABEL_LOOP[v] || v })) },
    { k: 'loopAmt', l: 'ຄວາມແຮງ', t: 'r', min: 0.1, max: 3, step: 0.1 },
  ]],
];
const panelInputs = {};
function setStyle(k, v, replayIt) {
  S.style[k] = v;
  S.presetDirty = true;
  if (k === 'font' || k === 'weight') ensureFont();
  if (replayIt) replayCurrent();
  commit();
}
function replayCurrent() {
  const ch = S.chunks[S.selected];
  if (!ch) return;
  if (S.video) video.pause(); else demoPlaying = false;
  replay = { chunk: ch, t0: performance.now() };
}
function buildControl(c) {
  const row = document.createElement('div');
  if (c.t === 'grid') {
    row.className = 'animgrid';
    c.o.forEach(o => {
      const b = document.createElement('button');
      b.textContent = o.l; b.dataset.v = o.v;
      b.onclick = () => { setStyle(c.k, o.v, true); paint(); };
      row.appendChild(b);
    });
    const paint = () => row.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.v === String(S.style[c.k])));
    panelInputs[c.k] = paint; paint();
    return row;
  }
  row.className = 'ctl';
  const label = document.createElement('span'); label.textContent = c.l; row.appendChild(label);
  if (c.t === 'r') {
    const i = document.createElement('input'); i.type = 'range'; i.min = c.min; i.max = c.max; i.step = c.step;
    const o = document.createElement('output');
    const paint = () => { i.value = S.style[c.k]; o.textContent = S.style[c.k]; };
    i.addEventListener('input', () => { setStyle(c.k, Number(i.value), ['inDur', 'outDur', 'stagger'].includes(c.k)); o.textContent = i.value; });
    row.append(i, o); panelInputs[c.k] = paint; paint();
  } else if (c.t === 'c') {
    const i = document.createElement('input'); i.type = 'color';
    const o = document.createElement('output');
    const paint = () => { i.value = S.style[c.k]; };
    i.addEventListener('input', () => setStyle(c.k, i.value));
    row.append(i, o); panelInputs[c.k] = paint; paint();
  } else if (c.t === 'seg') {
    const seg = document.createElement('div'); seg.className = 'seg';
    c.o.forEach(o => { const b = document.createElement('button'); b.textContent = o.l; b.dataset.v = o.v; b.onclick = () => { const raw = o.v; setStyle(c.k, raw, c.k === 'unit' || c.k === 'pending'); paint(); }; seg.appendChild(b); });
    const paint = () => seg.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.v === String(S.style[c.k])));
    row.appendChild(seg); panelInputs[c.k] = paint; paint();
  }
  return row;
}
const updatePanelValue = k => { if (panelInputs[k]) panelInputs[k](); };
function buildFontList() {
  const box = document.createElement('div'); box.className = 'fontlist';
  const families = [...new Set(fontsList.map(f => f.family))];
  families.forEach(fam => {
    const b = document.createElement('button');
    b.className = 'fontitem'; b.dataset.f = fam;
    b.innerHTML = `<b style="font-family:'${fam}'">ເກີບແທ້ 99</b><small>${fam}</small>`;
    b.onclick = () => { setStyle('font', fam); paint(); };
    box.appendChild(b);
  });
  const paint = () => box.querySelectorAll('.fontitem').forEach(b => b.classList.toggle('on', b.dataset.f === S.style.font));
  panelInputs.font = paint; paint();
  if (B) {
    const add = document.createElement('button');
    add.textContent = '+ ເພີ່ມຟ້ອນຈາກເຄື່ອງນີ້ (.ttf .otf)';
    const pick = document.createElement('input');
    pick.type = 'file'; pick.accept = '.ttf,.otf,.woff,.woff2'; pick.className = 'hidden';
    add.onclick = () => pick.click();
    pick.onchange = async () => {
      const f = pick.files[0];
      if (!f) return;
      try {
        const family = await B.addFont(f);
        await loadFonts();
        S.style.font = family;
        renderStylePanels();
        ensureFont();
        commit();
      } catch { setNotice('ໄຟລ໌ນີ້ບໍ່ແມ່ນຟ້ອນ', 'bad'); }
    };
    box.append(add, pick);
  }
  return box;
}
function renderStylePanels() {
  const build = (host, groups, withFonts) => {
    host.textContent = '';
    if (withFonts) {
      const g = document.createElement('div'); g.className = 'group';
      g.innerHTML = '<h4>ຟ້ອນ</h4>'; g.appendChild(buildFontList()); host.appendChild(g);
    }
    groups.forEach(([title, ctls]) => {
      const g = document.createElement('div'); g.className = 'group';
      const h = document.createElement('h4'); h.textContent = title; g.appendChild(h);
      ctls.forEach(c => g.appendChild(buildControl(c)));
      host.appendChild(g);
    });
  };
  build($('tab-decor'), DECOR, true);
  build($('tab-anim'), ANIM, false);
}

// ---------- Fonts ----------
async function ensureFont(style = S.style) {
  try { await document.fonts.load(`${style.weight} 40px "${style.font}"`, 'ກ'); } catch { /* falls back to Noto */ }
}
async function loadFonts() {
  fontsList = B ? await B.fonts() : await api('/api/fonts');
  fontsList.forEach(f => {
    const face = new FontFace(f.family, `url(${f.url})`, { weight: String(f.weight), display: 'swap' });
    document.fonts.add(face);
  });
  // Weights a family doesn't have are synthesised by the browser; load what the UI and presets use now.
  const need = new Set(fontsList.map(f => f.family));
  await Promise.all([...need].map(fam => document.fonts.load(`400 24px "${fam}"`, 'ກ').catch(() => {})));
  const known = new Set(fontsList.map(f => f.family));
  await Promise.all(window.BUILTIN_PRESETS.filter(p => !(p.style || {}).font || known.has(p.style.font)).map(p => ensureFont({ ...DEFAULT_STYLE, ...p.style })));
  thumbsDirty = true;
}

// ---------- Preset gallery ----------
let thumbs = [], thumbsDirty = true, lastThumb = 0;
const thumbChunk = { start: 0, end: 1.7, words: [
  { text: 'ເກີບແທ້', spaceAfter: true, start: 0, end: 0.8 },
  { text: '99TH', emph: true, start: 0.8, end: 1.7 },
] };
function presetCard(p, container, removable) {
  const b = document.createElement('div');
  b.className = 'preset'; b.tabIndex = 0;
  const cv = document.createElement('canvas'); cv.width = 320; cv.height = 160;
  const label = document.createElement('span'); label.textContent = p.name;
  b.append(cv, label);
  const entry = { p, cv, ctx: cv.getContext('2d'), el: b, hover: false, style: { ...DEFAULT_STYLE, ...p.style, size: Math.min((p.style || {}).size || DEFAULT_STYLE.size, 88), maxWidth: 1 } };
  b.onmouseenter = () => { entry.hover = true; };
  b.onmouseleave = () => { entry.hover = false; drawThumb(entry, 1.2); };
  b.onclick = () => applyPreset(p);
  if (removable) {
    const d = document.createElement('button');
    d.className = 'del'; d.textContent = '✕';
    d.onclick = async e => { e.stopPropagation(); myPresets = myPresets.filter(x => x.id !== p.id); await (B ? B.savePresets(myPresets) : api('/api/presets', myPresets)); renderPresets(); };
    b.appendChild(d);
  }
  container.appendChild(b);
  thumbs.push(entry);
  return entry;
}
function drawThumb(e, t) {
  const c = e.ctx;
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.clearRect(0, 0, 320, 160);
  if (t >= thumbChunk.end) return; // short blank gap so the entrance animation is visible when it restarts
  c.setTransform(0.5, 0, 0, 0.5, 0, 0);
  drawChunk(c, 640, 320, thumbChunk, t, e.style, { x: 0.5, y: 0.5 }, { s: 1 });
}
function drawThumbs(now) {
  if (exporting) return;
  const paused = now - lastThumb < 40;
  if (paused && !thumbsDirty) return;
  lastThumb = now;
  const t = (now / 1000) % 2.2;
  thumbs.forEach(e => {
    const live = e.hover || e.p.id === S.presetId;
    if (live) drawThumb(e, t);
    else if (thumbsDirty) drawThumb(e, 1.2);
  });
  thumbsDirty = false;
}
function renderPresets() {
  thumbs = [];
  $('presets').textContent = '';
  $('myPresets').textContent = '';
  const have = new Set(fontsList.map(f => f.family));
  window.BUILTIN_PRESETS.forEach(p => {
    const font = (p.style || {}).font;
    if (B && font && !have.has(font)) {
      if (p.id === 'brush') return; // its look depends on that brush font
      presetCard({ ...p, style: { ...p.style, font: 'Noto Sans Lao Looped' } }, $('presets'));
    } else presetCard(p, $('presets'));
  });
  myPresets.forEach(p => presetCard(p, $('myPresets'), true));
  thumbsDirty = true;
  markPreset();
}
function markPreset() { thumbs.forEach(e => e.el.classList.toggle('on', e.p.id === S.presetId)); }
function applyPreset(p) {
  S.style = { ...DEFAULT_STYLE, ...p.style };
  S.presetId = p.id;
  if (p.pos) S.pos = { ...p.pos };
  if (p.n !== undefined) { S.n = p.n; syncControls(); rebuild(); }
  ensureFont();
  markPreset();
  renderStylePanels();
  markPosSeg();
  replayCurrent();
  commit();
}
function askPresetName() {
  $('btnSavePreset').classList.add('hidden');
  $('presetNameBox').classList.remove('hidden');
  $('presetName').value = '';
  $('presetName').focus();
}
function closePresetName() {
  $('presetNameBox').classList.add('hidden');
  $('btnSavePreset').classList.remove('hidden');
}
async function savePreset() {
  const name = $('presetName').value.trim() || `ສະໄຕຣ໌ ${myPresets.length + 1}`;
  const p = { id: `my-${Date.now()}`, name, style: { ...S.style }, pos: { ...S.pos }, n: S.n };
  myPresets.push(p);
  await (B ? B.savePresets(myPresets) : api('/api/presets', myPresets));
  S.presetId = p.id;
  closePresetName();
  renderPresets();
  commit();
}

// ---------- Opening clips ----------
function setNotice(text, cls = '') {
  const n = $('notice');
  n.className = `notice ${cls}`;
  n.textContent = text;
  n.classList.toggle('hidden', !text);
}
async function pollJob(id, onProgress) {
  let failures = 0;
  for (;;) {
    let j = null;
    try { j = await api(`/api/job/${id}`); failures = 0; } catch (e) {
      if (!(e instanceof TypeError) || ++failures > 150) throw e instanceof TypeError ? new Error('ຕິດຕໍ່ຄອມບໍ່ໄດ້') : e;
    }
    if (j) {
      onProgress(j.progress);
      if (j.state === 'done') return j.result;
      if (j.state === 'error') throw new Error(j.error);
    }
    await new Promise(r => setTimeout(r, 800));
  }
}
async function waitJob(id, label) {
  $('jobBox').classList.remove('hidden');
  $('jobCancel').classList.remove('hidden');
  $('jobCancel').onclick = () => api(`/api/job/${id}/cancel`, {});
  try {
    return await pollJob(id, p => {
      $('jobBar').style.width = `${Math.round(p * 100)}%`;
      $('jobText').textContent = `${label} ${Math.round(p * 100)}%`;
    });
  } finally { $('jobBox').classList.add('hidden'); }
}
let blobUrl = null;
async function loadVideo(v, localFile) {
  if (v.previewJob) { await waitJob(v.previewJob, 'ກຽມພຣີວິວ'); }
  S.video = v; S.demo = false;
  stage.classList.remove('demo');
  const serverSrc = `${v.url}?t=${Date.now()}`;
  if (blobUrl) { URL.revokeObjectURL(blobUrl); blobUrl = null; }
  // A clip chosen on this device previews from the device itself, without streaming it back over Wi-Fi.
  if (localFile && !v.previewJob) {
    blobUrl = URL.createObjectURL(localFile);
    video.onerror = () => {
      video.onerror = null;
      if (B) setNotice('ເຄື່ອງນີ້ສະແດງພຣີວິວຄິບນີ້ບໍ່ໄດ້ ແຕ່ຍັງລອງສົ່ງອອກໄດ້', 'bad');
      else { video.src = serverSrc; video.load(); }
    };
    video.src = blobUrl;
  } else { video.onerror = null; video.src = serverSrc; }
  video.load();
  $('clipName').textContent = v.name;
  if (!B) localStorage.setItem('cs.last', v.id);
  fitStage();
  const saved = localStorage.getItem(`cs.project.${v.id}`);
  history = [];
  if (saved) restore(saved);
  else { S.words = []; S.draft = false; S.script = ''; S.offset = 0; rebuild(); syncControls(); }
  $('script').value = S.script || '';
  setNotice(S.draft ? DRAFT_NOTE : '');
  commit();
}
async function openClip() {
  if (S.remote) { $('fileInput').click(); return; }
  $('btnOpen').disabled = true;
  try {
    const v = await api('/api/pick', {});
    if (!v.cancelled) await loadVideo(v);
  } catch (e) { setNotice(e.message, 'bad'); } finally { $('btnOpen').disabled = false; }
}
function uploadFile(file) {
  return new Promise((ok, no) => {
    const x = new XMLHttpRequest();
    x.open('POST', `/api/upload?name=${encodeURIComponent(file.name)}`);
    x.setRequestHeader('Content-Type', 'application/octet-stream');
    $('jobBox').classList.remove('hidden');
    $('jobCancel').classList.remove('hidden');
    $('jobCancel').onclick = () => x.abort();
    x.onabort = () => { $('jobBox').classList.add('hidden'); no(new Error('ຍົກເລີກແລ້ວ')); };
    showTab('text');
    x.upload.onprogress = e => { const p = Math.round(e.loaded / e.total * 100); $('jobBar').style.width = `${p}%`; $('jobText').textContent = `ກຳລັງໂຫຼດຄິບໄປຄອມ ${p}% (ຢ່າປິດໜ້າຈໍ)`; };
    x.onload = () => { $('jobBox').classList.add('hidden'); const j = JSON.parse(x.responseText); x.status < 300 ? ok(j) : no(new Error(j.error)); };
    x.onerror = () => { $('jobBox').classList.add('hidden'); no(new Error('ໂຫຼດຄິບບໍ່ສຳເລັດ')); };
    x.send(file);
  });
}
['dragenter', 'dragover'].forEach(n => document.addEventListener(n, e => { e.preventDefault(); $('dropHint').classList.remove('hidden'); }));
document.addEventListener('dragleave', e => { if (!e.relatedTarget) $('dropHint').classList.add('hidden'); });
document.addEventListener('drop', async e => {
  e.preventDefault();
  $('dropHint').classList.add('hidden');
  const f = e.dataTransfer.files[0];
  if (!f) return;
  if (/\.(srt|vtt)$/i.test(f.name)) { importSrt(f).catch(err => setNotice(err.message, 'bad')); return; }
  try { await loadVideo(B ? await B.openFile(f) : await uploadFile(f), f); } catch (err) { setNotice(err.message, 'bad'); }
});
$('fileInput').addEventListener('change', async e => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  $('btnOpen').disabled = true;
  try { await loadVideo(B ? await B.openFile(f) : await uploadFile(f), f); } catch (err) { setNotice(err.message, 'bad'); } finally { $('btnOpen').disabled = false; }
});

// ---------- Auto captions ----------
const DRAFT_NOTE = B ? '⚠ ຄຳຮ່າງຈາກສຽງ: ຍັງມີຄຳຜິດບາງຄຳ ກະລຸນາກວດກ່ອນສົ່ງອອກ ຫຼື ວາງສະຄຣິບແລ້ວກົດໃໝ່ ເພື່ອສະກົດຖືກ 100%' : '⚠ ຄຳຮ່າງຈາກສຽງ: Whisper ຟັງລາວເປັນໄທ ແລ້ວແປງຕົວອັກສອນໃຫ້ ຄຳອາດຜິດ ກະລຸນາກວດກ່ອນສົ່ງອອກ ຫຼື ວາງສະຄຣິບແລ້ວກົດໃໝ່';
async function autoCaption() {
  if (!S.video) { setNotice('ເປີດຄິບກ່ອນ ຈຶ່ງຈະຟັງສຽງໄດ້ (ຕອນນີ້ເປັນຕົວຢ່າງ)', ''); return; }
  $('btnAuto').disabled = true;
  S.script = $('script').value;
  setNotice('');
  try {
    const res = B ? await listenOnDevice() : await waitJob((await api('/api/transcribe', { id: S.video.id, script: S.script })).job, 'ກຳລັງຟັງສຽງ');
    S.draft = res.draft;
    S.words = linesToWords(res.lines, duration(), S.countMode);
    rebuild();
    const ok = res.lines.filter(l => l.anchored).length;
    if (res.draft) setNotice(DRAFT_NOTE);
    else if (ok / res.lines.length >= 0.9) setNotice(`✓ ຈັບເວລາກົງກັບສຽງ ${ok}/${res.lines.length} ແຖວ`, 'good');
    else setNotice(`⚠ ຈັບເວລາໄດ້ພຽງ ${ok}/${res.lines.length} ແຖວ ສະຄຣິບອາດບໍ່ກົງກັບສຽງ ກະລຸນາກວດເວລາ`);
    commit();
  } catch (e) { setNotice(e.message, 'bad'); } finally { $('btnAuto').disabled = false; }
}
async function listenOnDevice() {
  if (!S.video.hasAudio) throw new Error('ຄິບນີ້ບໍ່ມີສຽງ');
  let cancelled = false;
  const box = $('jobBox');
  box.classList.remove('hidden');
  return new Promise((ok, no) => {
    $('jobCancel').onclick = () => { cancelled = true; B.cancelTranscribe(); no(new Error('ຍົກເລີກແລ້ວ')); };
    B.transcribe(S.video, S.script, (label, p) => {
      $('jobBar').style.width = `${Math.round(p * 100)}%`;
      $('jobText').textContent = /MB$/.test(label) ? label : `${label} ${Math.round(p * 100)}%`;
    }).then(r => { if (!cancelled) ok(r); }, e => { if (!cancelled) no(e); });
  }).finally(() => box.classList.add('hidden'));
}
// ---------- Opening an .srt file: its text and timing are used as they are ----------
function parseSrt(text) {
  const time = v => { const m = /(\d+):(\d\d):(\d\d)[,.](\d{1,3})|(\d+):(\d\d)[,.](\d{1,3})/.exec(v); if (!m) return null; return m[1] !== undefined ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(`0.${m[4]}`) : Number(m[5]) * 60 + Number(m[6]) + Number(`0.${m[7]}`); };
  const out = [];
  for (const block of text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split(/\n\s*\n/)) {
    const rows = block.split('\n').map(x => x.trim()).filter(Boolean);
    const at = rows.findIndex(r => r.includes('-->'));
    if (at < 0) continue;
    const [a, b] = rows[at].split('-->');
    const start = time(a), end = time(b);
    const body = rows.slice(at + 1).join(' ').replace(/<[^>]+>|\{[^}]*\}/g, '').replace(/\s+/g, ' ').trim();
    if (start != null && end != null && end > start && body) out.push({ start, end, text: body });
  }
  return out.sort((x, y) => x.start - y.start);
}
async function decodeTextFile(file) {
  const buf = await file.arrayBuffer(), b = new Uint8Array(buf);
  if (b[0] === 0xFF && b[1] === 0xFE) return new TextDecoder('utf-16le').decode(buf);
  if (b[0] === 0xFE && b[1] === 0xFF) return new TextDecoder('utf-16be').decode(buf);
  return new TextDecoder('utf-8').decode(buf);
}
async function importSrt(file) {
  const entries = parseSrt(await decodeTextFile(file));
  if (!entries.length) { setNotice('ອ່ານໄຟລ໌ນີ້ບໍ່ໄດ້ ຫຼື ບໍ່ມີຂໍ້ຄວາມ ກະລຸນາກວດວ່າເປັນໄຟລ໌ .srt', 'bad'); return; }
  const words = [];
  entries.forEach((e, k) => {
    const ws = wordsFromLine({ text: e.text, times: [[0, e.start], [e.text.length, e.end]] }, k, S.countMode, e.end);
    if (ws.length) ws[ws.length - 1].end = e.end;
    words.push(...ws);
  });
  S.words = words;
  S.draft = false;
  S.script = entries.map(e => e.text).join('\n');
  $('script').value = S.script;
  rebuild();
  showTab('text');
  const last = entries[entries.length - 1].end;
  if (S.video && last > duration() + 0.5) setNotice(`⚠ ເປີດ ${entries.length} ແຖວແລ້ວ ແຕ່ເວລາໃນໄຟລ໌ຍາວກວ່າຄິບ (${fmt(last)} ກັບ ${fmt(duration())}) ອາດບໍ່ແມ່ນຄູ່ກັນ`);
  else setNotice(`✓ ເປີດ ${file.name} ແລ້ວ: ${entries.length} ແຖວ ໃຊ້ເວລາຕາມໄຟລ໌`, 'good');
  commit();
}
function manualCaption() {
  S.script = $('script').value;
  if (!S.script.trim()) { setNotice('ພິມ ຫຼື ວາງຂໍ້ຄວາມໃນຊ່ອງກ່ອນ'); return; }
  S.words = linesToWords(evenLines(S.script, duration()), duration(), S.countMode);
  S.draft = false;
  rebuild();
  setNotice('ແບ່ງເວລາຕາມຄວາມຍາວຂໍ້ຄວາມ (ບໍ່ໄດ້ຟັງສຽງ)');
  commit();
}

// ---------- Export ----------
let exporting = false, exportCancelled = false, lastOutput = null;
const pad = (n, l = 2) => String(n).padStart(l, '0');
function srtTime(t) { const ms = Math.round(Math.max(0, t) * 1000); return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor(ms / 60000) % 60)}:${pad(Math.floor(ms / 1000) % 60)},${pad(ms % 1000, 3)}`; }
function downloadSrt() {
  const text = S.chunks.map((c, i) => `${i + 1}\n${srtTime(c.start + S.offset)} --> ${srtTime(c.end + S.offset)}\n${c.text}\n`).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  a.download = `${(S.video ? S.video.name.replace(/\.[^.]+$/, '') : 'captions')}.srt`;
  a.click();
  URL.revokeObjectURL(a.href);
}
function showExport(view) { ['exportChoices', 'exportRun', 'exportDone'].forEach(id => $(id).classList.toggle('hidden', id !== view)); }
function showExportError(text) { $('exportError').textContent = text; $('exportError').classList.remove('hidden'); }
async function runExport(mode, fps) {
  $('exportError').classList.add('hidden');
  if (mode === 'burn' && !S.video) { showExportError('ເປີດຄິບກ່ອນ ຈຶ່ງຈະສົ່ງອອກ MP4 ໄດ້'); return; }
  if (!S.chunks.length) { showExportError('ຍັງບໍ່ມີຟ້ອນ'); return; }
  if (S.video) video.pause();
  exporting = true; exportCancelled = false;
  showExport('exportRun');
  const payload = {
    id: S.video && S.video.id, mode, fps, width: S.video ? S.video.width : 1080, height: S.video ? S.video.height : 1920,
    duration: duration(), offset: S.offset, style: S.style, pos: S.pos,
    chunks: S.chunks.map(c => ({ start: c.start, end: c.end, idx: c.idx, pos: c.pos, words: c.words })),
  };
  const started = performance.now();
  const progress = p => {
    const sec = (performance.now() - started) / 1000;
    $('exportBar').style.width = `${Math.round(p * 100)}%`;
    $('exportText').textContent = `${Math.round(p * 100)}%${p > 0.01 ? ` · ເຫຼືອປະມານ ${Math.ceil(sec / p - sec)} ວິນາທີ` : ''}`;
  };
  try {
    // Phones let the PC do the rendering, so a slow phone or a locked screen doesn't matter.
    const onPc = S.remote && !B ? await api('/api/export/pc', payload) : null;
    if (B) {
      await ensureFont();
      const res = await B.exportMp4(payload, S.video, progress, () => exportCancelled);
      if (res) showExportResult(res); else showExport('exportChoices');
    } else if (onPc && onPc.job) {
      exportCancelHook = () => api(`/api/job/${onPc.job}/cancel`, {});
      $('exportText').textContent = 'ຄອມກຳລັງສົ່ງອອກ...';
      try { showExportResult(await pollJob(onPc.job, progress)); } catch (e) {
        if (exportCancelled) showExport('exportChoices'); else throw e;
      }
    } else {
      await ensureFont();
      const { job } = await api('/api/export/start', payload);
      const finished = await window.CaptionExport.renderFrames({
        ...payload, exportId: job, onProgress: progress, isCancelled: () => exportCancelled,
      });
      if (!finished) {
        await api(`/api/export/${job}/cancel`, {});
        showExport('exportChoices');
      } else {
        $('exportText').textContent = 'ກຳລັງປິດໄຟລ໌...';
        showExportResult(await api(`/api/export/${job}/finish`, {}));
      }
    }
  } catch (e) {
    showExport('exportChoices');
    showExportError(`ສົ່ງອອກບໍ່ສຳເລັດ: ${e.message}`);
  } finally { exporting = false; exportCancelHook = null; }
}
let exportCancelHook = null;
function showExportResult(res) {
  lastOutput = res.file;
  $('exportResult').textContent = S.remote
    ? `✓ ສຳເລັດ: ${res.file} (${(res.size / 1048576).toFixed(1)} MB)`
    : `✓ ບັນທຶກແລ້ວ: ${res.file} (${(res.size / 1048576).toFixed(1)} MB) ໃນ ${res.dir}`;
  $('exportDownload').href = B ? res.url : `${res.url}?dl=1`;
  $('exportDownload').download = res.file;
  $('exportShare').classList.toggle('hidden', !(B && B.canShare()));
  showExport('exportDone');
}
async function refreshExportFiles() {
  const box = $('exportFiles');
  box.classList.toggle('hidden', !S.remote || !!B);
  if (!S.remote || B) return;
  const list = await api('/api/outputs').catch(() => []);
  box.textContent = '';
  if (!list.length) { box.classList.add('hidden'); return; }
  const h = document.createElement('div'); h.className = 'small muted'; h.textContent = 'ໄຟລ໌ທີ່ສົ່ງອອກແລ້ວ';
  box.appendChild(h);
  list.forEach(f => {
    const a = document.createElement('a');
    a.href = `${f.url}?dl=1`;
    a.textContent = `⬇ ${f.file} (${(f.size / 1048576).toFixed(0)} MB)`;
    box.appendChild(a);
  });
}

// ---------- Wiring ----------
let scrubbing = false;
function syncControls() {
  document.querySelectorAll('#wpc button').forEach(b => b.classList.toggle('on', Number(b.dataset.n) === S.n));
  document.querySelectorAll('#countMode button').forEach(b => b.classList.toggle('on', b.dataset.m === S.countMode));
  $('offset').value = S.offset;
  $('offsetVal').textContent = `${S.offset >= 0 ? '+' : ''}${Number(S.offset).toFixed(2)}s`;
  markPosSeg();
}
function markPosSeg() {
  document.querySelectorAll('#posSeg button').forEach(b => b.classList.toggle('on', Math.abs(Number(b.dataset.y) - S.pos.y) < 0.012 && Math.abs(S.pos.x - 0.5) < 0.012));
}
$('wpc').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  S.n = Number(b.dataset.n); syncControls(); rebuild(); replayCurrent(); commit();
});
$('countMode').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  S.countMode = b.dataset.m; retokenize(); syncControls(); rebuild(); commit();
});
$('posSeg').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  const y = Number(b.dataset.y);
  const ch = S.chunks[S.selected];
  if ($('dragOne').checked && ch) { ch.words[0].pos = { x: 0.5, y }; rebuild(); } else S.pos = { x: 0.5, y };
  markPosSeg(); commit();
});
$('offset').addEventListener('input', e => { S.offset = Number(e.target.value); $('offsetVal').textContent = `${S.offset >= 0 ? '+' : ''}${S.offset.toFixed(2)}s`; commit(); });
function showTab(name) {
  document.querySelectorAll('#tabs button').forEach(x => x.classList.toggle('on', x.dataset.tab === name));
  document.querySelectorAll('.tab').forEach(x => x.classList.toggle('hidden', x.id !== `tab-${name}`));
}
$('tabs').addEventListener('click', e => { const b = e.target.closest('button'); if (b) showTab(b.dataset.tab); });
// On a phone the preset gallery lives in its own tab under the clip.
const narrow = matchMedia('(max-width: 1050px)');
function placePresets() {
  if (narrow.matches) $('tab-style').appendChild($('left'));
  else {
    document.querySelector('main').prepend($('left'));
    if (document.querySelector('#tabs button.on').dataset.tab === 'style') showTab('text');
  }
}
narrow.addEventListener('change', placePresets);
placePresets();
async function showPhoneLinks() {
  $('phoneModal').classList.remove('hidden');
  const box = $('phoneLinks');
  box.textContent = 'ກຳລັງໂຫຼດ...';
  const links = await api('/api/phone-links');
  box.textContent = links.length ? '' : 'ຄອມນີ້ຍັງບໍ່ໄດ້ຕໍ່ເນັດ';
  links.forEach(l => {
    const el = document.createElement('div'); el.className = 'qr';
    el.innerHTML = l.svg;
    const cap = document.createElement('div'); cap.className = 'small';
    cap.textContent = l.kind === 'tailscale' ? 'ຢູ່ໄກ (ຜ່ານ Tailscale)' : 'Wi-Fi ດຽວກັນ';
    el.appendChild(cap);
    box.appendChild(el);
  });
}
$('btnPhone').onclick = () => showPhoneLinks().catch(e => setNotice(e.message, 'bad'));
$('phoneClose').onclick = () => $('phoneModal').classList.add('hidden');
$('phoneReset').onclick = async () => { await api('/api/phone-links/reset', {}); showPhoneLinks(); };
$('btnOpen').onclick = openClip;
$('btnPlay').onclick = togglePlay;
$('btnUndo').onclick = undo;
$('btnAuto').onclick = autoCaption;
$('btnManual').onclick = manualCaption;
$('btnSrt').onclick = () => $('srtInput').click();
$('srtInput').addEventListener('change', e => {
  const f = e.target.files[0];
  e.target.value = '';
  if (f) importSrt(f).catch(err => setNotice(err.message, 'bad'));
});
$('btnSavePreset').onclick = askPresetName;
$('presetOk').onclick = savePreset;
$('presetCancel').onclick = closePresetName;
$('presetName').addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') savePreset(); if (e.key === 'Escape') closePresetName(); });
$('script').addEventListener('input', e => { S.script = e.target.value; commit(); });
$('scrub').addEventListener('input', e => { scrubbing = true; seek(Number(e.target.value) / 1000 * duration()); });
$('scrub').addEventListener('change', () => { scrubbing = false; });
$('btnExport').onclick = () => { showExport('exportChoices'); $('exportError').classList.add('hidden'); refreshExportFiles(); $('exportModal').classList.remove('hidden'); };
$('exportClose').onclick = () => $('exportModal').classList.add('hidden');
$('exportBack').onclick = () => $('exportModal').classList.add('hidden');
$('exportCancel').onclick = () => { exportCancelled = true; if (exportCancelHook) exportCancelHook(); };
$('exportShare').onclick = () => B.shareLastExport().catch(() => {});
$('exportReveal').onclick = () => api('/api/reveal', { file: lastOutput });
$('fpsSeg').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; document.querySelectorAll('#fpsSeg button').forEach(x => x.classList.toggle('on', x === b)); });
document.querySelectorAll('.choice').forEach(b => b.addEventListener('click', () => {
  const fps = Number(document.querySelector('#fpsSeg button.on').dataset.fps);
  if (b.dataset.mode === 'srt') { downloadSrt(); return; }
  runExport(b.dataset.mode, fps);
}));
document.addEventListener('keydown', e => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
  if (e.code === 'Space' && !typing) { e.preventDefault(); togglePlay(); }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !typing) { e.preventDefault(); undo(); }
  if (!typing && e.key === 'ArrowRight') seek(currentTime() + 0.2);
  if (!typing && e.key === 'ArrowLeft') seek(currentTime() - 0.2);
});

(async function init() {
  stage.classList.add('demo');
  try {
    const who = B ? { local: false, whisper: true } : await api('/api/whoami');
    S.remote = !who.local;
    document.body.classList.toggle('remote', S.remote);
    document.body.classList.toggle('static', !!B);
    if (!who.whisper) $('btnAuto').title = 'ເຄື່ອງນີ້ຍັງບໍ່ມີຕົວຟັງສຽງ';
  } catch { /* offline: the page will show its own errors */ }
  await loadFonts().catch(() => {});
  try { myPresets = B ? await B.loadPresets() : await api('/api/presets'); } catch { myPresets = []; }
  renderPresets();
  renderStylePanels();
  const savedDemo = localStorage.getItem('cs.project.demo');
  S.words = linesToWords(evenLines(DEMO_SCRIPT, 8.5), 8.5, S.countMode);
  rebuild();
  if (savedDemo) { try { const d = JSON.parse(savedDemo); Object.assign(S, { style: d.style, pos: d.pos, n: d.n, presetId: d.presetId }); rebuild(); renderStylePanels(); markPreset(); } catch { /* ignore */ } }
  syncControls();
  fitStage();
  ensureFont();
  commit();
  const last = B ? null : localStorage.getItem('cs.last');
  if (last) { try { await loadVideo(await api(`/api/video/${last}`)); } catch { localStorage.removeItem('cs.last'); } }
  requestAnimationFrame(frame);
})();
