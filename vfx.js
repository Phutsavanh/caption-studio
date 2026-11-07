/* Keyframes, colour grading, masks and video effects for clips and overlays, as in CapCut.
   One function draws an item; the preview and the export both use it, so what plays is what gets saved.
   Every effect is a pure function of the time, so a frame always comes out the same. */
(function () {
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const rnd = n => { const x = Math.sin(n * 12.9898) * 43758.5453; return x - Math.floor(x); };
  const EASE = { linear: p => p, ease: p => p * p * (3 - 2 * p), in: p => p * p, out: p => 1 - (1 - p) * (1 - p) };

  // ---------- Keyframes: item.kf = { prop: [{ t, v, e }] }, t in seconds from the item's start ----------
  const KF_PROPS = { clip: ['x', 'y', 'zoom', 'rot', 'opacity'], overlay: ['x', 'y', 'scale', 'rot', 'opacity'] };
  const DEFAULTS = { x: 0, y: 0, zoom: 1, scale: 0.35, rot: 0, opacity: 1 };
  const base = (item, prop) => (item[prop] ?? DEFAULTS[prop]);
  function value(item, prop, local) {
    const keys = item.kf && item.kf[prop];
    if (!keys || !keys.length) return base(item, prop);
    if (local <= keys[0].t) return keys[0].v;
    const last = keys[keys.length - 1];
    if (local >= last.t) return last.v;
    let i = 0;
    while (keys[i + 1].t < local) i++;
    const a = keys[i], b = keys[i + 1];
    const p = (local - a.t) / Math.max(1e-6, b.t - a.t);
    return a.v + (b.v - a.v) * (EASE[a.e] || EASE.ease)(p);
  }
  const NEAR = 1 / 60;
  function keyAt(item, prop, local) {
    const keys = item.kf && item.kf[prop];
    return keys ? keys.find(k => Math.abs(k.t - local) < NEAR) : null;
  }
  function setKey(item, prop, local, v) {
    item.kf = item.kf || {};
    const keys = item.kf[prop] = item.kf[prop] || [];
    const hit = keys.find(k => Math.abs(k.t - local) < NEAR);
    if (hit) hit.v = v; else { keys.push({ t: Math.max(0, local), v, e: 'ease' }); keys.sort((a, b) => a.t - b.t); }
  }
  function removeKey(item, prop, local) {
    const keys = item.kf && item.kf[prop];
    if (!keys) return;
    item.kf[prop] = keys.filter(k => Math.abs(k.t - local) >= NEAR);
    if (!item.kf[prop].length) delete item.kf[prop];
  }
  const keyTimes = item => [...new Set(Object.values(item.kf || {}).flat().map(k => Math.round(k.t * 1000) / 1000))].sort((a, b) => a - b);
  const hasKeys = item => Object.values(item.kf || {}).some(k => k.length);

  // ---------- Colour ----------
  // grade: exposure (EV), temp, tint (-1..1), hue (deg), sepia, fade, vignette, grain (0..1). Contrast and
  // saturation live on the item itself (bright/contrast/sat), as before.
  const FILTERS = {
    none: { l: 'ທຳມະດາ', g: {} },
    warm: { l: 'ອົບອຸ່ນ', g: { temp: 0.35 }, sat: 1.1 },
    cool: { l: 'ເຢັນ', g: { temp: -0.35 } },
    vivid: { l: 'ສົດໃສ', g: {}, sat: 1.45, contrast: 1.12 },
    bw: { l: 'ຂາວດຳ', g: {}, sat: 0, contrast: 1.2 },
    vintage: { l: 'ວິນເທຈ', g: { sepia: 0.45, fade: 0.15, vignette: 0.5 }, contrast: 0.92 },
    cinema: { l: 'ໜັງໂຮງ', g: { temp: -0.12, tint: 0.06, vignette: 0.35 }, sat: 0.85, contrast: 1.15 },
    moody: { l: 'ມືດໆ', g: { exposure: -0.3, vignette: 0.55 }, sat: 0.75, contrast: 1.2 },
    fade: { l: 'ຊີດ', g: { fade: 0.3 }, contrast: 0.88 },
    sunset: { l: 'ແສງແລງ', g: { temp: 0.5, tint: 0.15 }, sat: 1.2 },
    film: { l: 'ຟິມ', g: { grain: 0.35, fade: 0.1, sepia: 0.15 }, contrast: 1.05 },
    teal: { l: 'ຟ້າ-ສົ້ມ', g: { temp: 0.15, tint: -0.12, hue: -8 }, sat: 1.15, contrast: 1.1 },
  };
  function applyFilter(item, name) {
    const f = FILTERS[name] || FILTERS.none;
    item.grade = { ...f.g, filter: name };
    item.bright = f.bright ?? 1; item.contrast = f.contrast ?? 1; item.sat = f.sat ?? 1;
  }

  // ---------- Masks: item.mask = { type, x, y, w, h, rot, feather, round, invert } (fractions of the item) ----------
  const MASKS = { none: 'ບໍ່ມີ', circle: 'ວົງມົນ', rect: 'ສີ່ຫຼ່ຽມ', linear: 'ເສັ້ນ', mirror: 'ແຖບ', heart: 'ຫົວໃຈ', star: 'ດາວ' };
  function maskPath(g, m, r) {
    const cx = r.x + r.w / 2 + (m.x || 0) * r.w, cy = r.y + r.h / 2 + (m.y || 0) * r.h;
    const w = (m.w ?? 0.6) * r.w, h = (m.h ?? 0.6) * r.h, big = (r.w + r.h) * 3;
    g.translate(cx, cy);
    g.rotate(((m.rot || 0) * Math.PI) / 180);
    g.beginPath();
    if (m.type === 'circle') g.ellipse(0, 0, w / 2, h / 2, 0, 0, Math.PI * 2);
    else if (m.type === 'rect') g.roundRect(-w / 2, -h / 2, w, h, Math.min(w, h) / 2 * (m.round || 0));
    else if (m.type === 'linear') g.rect(-big, -big, big * 2, big);
    else if (m.type === 'mirror') g.rect(-big, -h / 2, big * 2, h);
    else if (m.type === 'heart') {
      const s = Math.min(w, h) / 32;
      for (let a = 0; a <= Math.PI * 2 + 0.01; a += 0.05) {
        const px = 16 * Math.sin(a) ** 3, py = -(13 * Math.cos(a) - 5 * Math.cos(2 * a) - 2 * Math.cos(3 * a) - Math.cos(4 * a));
        if (a === 0) g.moveTo(px * s, py * s); else g.lineTo(px * s, py * s);
      }
    } else if (m.type === 'star') {
      const R = Math.min(w, h) / 2, ri = R * 0.45;
      for (let i = 0; i < 10; i++) {
        const a = -Math.PI / 2 + (i * Math.PI) / 5, rr = i % 2 ? ri : R;
        if (i === 0) g.moveTo(Math.cos(a) * rr, Math.sin(a) * rr); else g.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
      }
      g.closePath();
    }
  }

  // ---------- Effects: item.fx = [{ type, amt }] ----------
  const EFFECTS = {
    blur: 'ມົວ', shake: 'ສັ່ນ', zoomPulse: 'ຊູມເຕັ້ນ', spin: 'ໝຸນ', flash: 'ແຟຼດຂາວ', strobe: 'ກະພິບ', glitch: 'ກລິດຊ໌',
    chroma: 'ແຍກສີ', vhs: 'VHS', grain: 'ເມັດຟິມ', pixel: 'ພິກເຊລ', mirror: 'ກະຈົກ', letterbox: 'ແຖບໜັງ', leak: 'ແສງຮົ່ວ', invert: 'ກັບສີ', vignette: 'ຂອບມືດ',
  };
  const fxAmt = (item, type) => { const f = (item.fx || []).find(x => x.type === type); return f ? (f.amt ?? 1) : 0; };

  // ---------- Drawing ----------
  const pool = [];
  function layer(i, W, H) {
    let c = pool[i];
    if (!c) {
      c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(W, H) : Object.assign(document.createElement('canvas'), { width: W, height: H });
      pool[i] = c;
    }
    if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
    const g = c.getContext('2d');
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalAlpha = 1; g.globalCompositeOperation = 'source-over'; g.filter = 'none';
    g.clearRect(0, 0, W, H);
    return { c, g };
  }
  let noiseFrame = -1, noiseCanvas = null;
  function noise(frame) {
    if (noiseFrame === frame && noiseCanvas) return noiseCanvas;
    const n = 192;
    noiseCanvas = noiseCanvas || (typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(n, n) : Object.assign(document.createElement('canvas'), { width: n, height: n }));
    const g = noiseCanvas.getContext('2d'), img = g.createImageData(n, n);
    for (let i = 0; i < n * n; i++) { const v = rnd(i * 0.37 + frame * 91.7) * 255; img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v; img.data[i * 4 + 3] = 255; }
    g.putImageData(img, 0, 0);
    noiseFrame = frame;
    return noiseCanvas;
  }
  const isPlain = item => !hasKeys(item) && !(item.mask && item.mask.type && item.mask.type !== 'none') && !(item.fx && item.fx.length)
    && !Object.entries(item.grade || {}).some(([k, v]) => k !== 'filter' && v) && !(item.rot) && (item.opacity ?? 1) === 1;

  /**
   * Draws one clip or overlay. o = { kind, item, img, iw, ih, local, alpha }. local = seconds since the item began.
   * The caller's transform and alpha (used by transitions) still apply.
   */
  function drawItem(ctx, W, H, o) {
    const { item, kind, img, iw, ih, local } = o;
    const frame = Math.floor(local * 30);
    const x = value(item, 'x', local), y = value(item, 'y', local), rot = value(item, 'rot', local);
    const opacity = clamp(value(item, 'opacity', local), 0, 1) * (o.alpha ?? 1);
    // Where the picture goes, before rotation.
    let r;
    if (kind === 'clip') {
      const fitScale = item.fit === 'contain' ? Math.min(W / iw, H / ih) : Math.max(W / iw, H / ih);
      const s = fitScale * value(item, 'zoom', local), dw = iw * s, dh = ih * s;
      r = { x: (W - dw) / 2 + x * W, y: (H - dh) / 2 + y * H, w: dw, h: dh };
    } else {
      const dw = value(item, 'scale', local) * W, dh = dw * ih / iw;
      r = { x: x * W - dw / 2, y: y * H - dh / 2, w: dw, h: dh };
    }
    const g0 = item.grade || {};
    const custom = item.bright !== 1 || item.contrast !== 1 || item.sat !== 1 || g0.exposure || g0.hue || g0.sepia;
    const filter = () => {
      const parts = [];
      const br = (item.bright ?? 1) * Math.pow(2, g0.exposure || 0);
      if (br !== 1) parts.push(`brightness(${br})`);
      if ((item.contrast ?? 1) !== 1) parts.push(`contrast(${item.contrast})`);
      if ((item.sat ?? 1) !== 1) parts.push(`saturate(${item.sat})`);
      if (g0.hue) parts.push(`hue-rotate(${g0.hue}deg)`);
      if (g0.sepia) parts.push(`sepia(${g0.sepia})`);
      const blur = fxAmt(item, 'blur'); if (blur) parts.push(`blur(${(blur * 14 * W) / 1080}px)`);
      if (fxAmt(item, 'invert')) parts.push(`invert(${fxAmt(item, 'invert')})`);
      return parts.length ? parts.join(' ') : 'none';
    };
    // Motion effects move the picture itself.
    let tx = 0, ty = 0, k = 1, spin = 0;
    const shake = fxAmt(item, 'shake');
    if (shake) { tx = (rnd(frame * 1.7) - 0.5) * 30 * shake * W / 1080; ty = (rnd(frame * 2.3 + 5) - 0.5) * 30 * shake * W / 1080; }
    const pulse = fxAmt(item, 'zoomPulse');
    if (pulse) k *= 1 + Math.max(0, Math.sin(local * Math.PI * 2 * 1.6)) * 0.08 * pulse;
    const sp = fxAmt(item, 'spin');
    if (sp) spin = local * 1.2 * sp;
    const transformed = rot || spin || k !== 1 || tx || ty;
    const place = g => {
      if (!transformed) return;
      const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
      g.translate(cx + tx, cy + ty); g.rotate(((rot * Math.PI) / 180) + spin); g.scale(k, k); g.translate(-cx, -cy);
    };

    if (isPlain(item) && !custom && !(item.fx && item.fx.length)) {
      ctx.drawImage(img, r.x, r.y, r.w, r.h);
      return;
    }
    // Everything else is drawn on its own layer first, then laid on the frame.
    const { c: L, g } = layer(0, W, H);
    g.save(); place(g); g.filter = filter(); g.drawImage(img, r.x, r.y, r.w, r.h); g.restore();
    g.filter = 'none';
    const pix = fxAmt(item, 'pixel');
    if (pix) {
      const { c: P, g: pg } = layer(1, Math.max(8, Math.round(W / (8 + pix * 40))), Math.max(8, Math.round(H / (8 + pix * 40))));
      pg.drawImage(L, 0, 0, P.width, P.height);
      g.clearRect(0, 0, W, H); g.imageSmoothingEnabled = false; g.drawImage(P, 0, 0, W, H); g.imageSmoothingEnabled = true;
    }
    if (fxAmt(item, 'mirror')) { g.save(); g.translate(W, 0); g.scale(-1, 1); g.drawImage(L, 0, 0, W / 2, H, 0, 0, W / 2, H); g.restore(); }
    // Colour washes and textures; the picture's own shape is kept afterwards.
    const temp = g0.temp || 0, tint = g0.tint || 0, fade = g0.fade || 0;
    const vig = Math.max(g0.vignette || 0, fxAmt(item, 'vignette')), grain = Math.max(g0.grain || 0, fxAmt(item, 'grain'));
    const vhs = fxAmt(item, 'vhs'), leak = fxAmt(item, 'leak');
    const split = Math.max(fxAmt(item, 'chroma') * 8, vhs * 4, fxAmt(item, 'glitch') && rnd(Math.floor(local * 12)) < 0.35 ? fxAmt(item, 'glitch') * 18 : 0) * W / 1080;
    if (split) {
      const { c: Rc, g: rg } = layer(2, W, H), { c: Cc, g: cg } = layer(3, W, H);
      rg.drawImage(L, 0, 0); rg.globalCompositeOperation = 'multiply'; rg.fillStyle = '#ff0000'; rg.fillRect(0, 0, W, H); rg.globalCompositeOperation = 'destination-in'; rg.drawImage(L, 0, 0);
      cg.drawImage(L, 0, 0); cg.globalCompositeOperation = 'multiply'; cg.fillStyle = '#00ffff'; cg.fillRect(0, 0, W, H); cg.globalCompositeOperation = 'destination-in'; cg.drawImage(L, 0, 0);
      const jitter = fxAmt(item, 'glitch') ? (rnd(frame) - 0.5) * split : 0;
      g.clearRect(0, 0, W, H);
      g.drawImage(Rc, -split + jitter, 0);
      g.globalCompositeOperation = 'lighter'; g.drawImage(Cc, split + jitter, 0); g.globalCompositeOperation = 'source-over';
    }
    if (temp || tint || fade || vig || grain || vhs || leak) {
      const { c: A, g: ag } = layer(4, W, H);
      ag.drawImage(L, 0, 0); // the picture's shape, restored at the end
      if (temp) { g.globalCompositeOperation = 'soft-light'; g.globalAlpha = Math.abs(temp) * 0.55; g.fillStyle = temp > 0 ? '#ff8a1e' : '#1e7bff'; g.fillRect(0, 0, W, H); }
      if (tint) { g.globalCompositeOperation = 'soft-light'; g.globalAlpha = Math.abs(tint) * 0.5; g.fillStyle = tint > 0 ? '#ff2bd6' : '#2bff6a'; g.fillRect(0, 0, W, H); }
      if (fade) { g.globalCompositeOperation = 'screen'; g.globalAlpha = fade * 0.45; g.fillStyle = '#5a5a5a'; g.fillRect(0, 0, W, H); }
      if (leak) {
        const lx = r.x + r.w * (0.5 + Math.sin(local * 0.9) * 0.4), ly = r.y + r.h * (0.3 + Math.cos(local * 0.7) * 0.25);
        const grd = g.createRadialGradient(lx, ly, 0, lx, ly, Math.max(r.w, r.h) * 0.6);
        grd.addColorStop(0, 'rgba(255,150,60,0.9)'); grd.addColorStop(0.5, 'rgba(255,60,90,0.35)'); grd.addColorStop(1, 'rgba(255,60,90,0)');
        g.globalCompositeOperation = 'screen'; g.globalAlpha = leak * 0.8; g.fillStyle = grd; g.fillRect(0, 0, W, H);
      }
      if (vig) {
        const cx = r.x + r.w / 2, cy = r.y + r.h / 2, R = Math.hypot(r.w, r.h) / 2;
        const grd = g.createRadialGradient(cx, cy, R * 0.35, cx, cy, R);
        grd.addColorStop(0, 'rgba(0,0,0,0)'); grd.addColorStop(1, 'rgba(0,0,0,1)');
        g.globalCompositeOperation = 'source-over'; g.globalAlpha = vig * 0.85; g.fillStyle = grd; g.fillRect(0, 0, W, H);
      }
      if (vhs) {
        g.globalCompositeOperation = 'source-over'; g.globalAlpha = 0.16 * vhs; g.fillStyle = '#000';
        const step = Math.max(2, Math.round(H / 320));
        for (let yy = (frame % 2) * step; yy < H; yy += step * 2) g.fillRect(0, yy, W, step);
      }
      if (grain || vhs) {
        g.globalCompositeOperation = 'overlay'; g.globalAlpha = Math.min(1, (grain + vhs * 0.5) * 0.55);
        const pat = g.createPattern(noise(frame), 'repeat');
        const s = Math.max(1, W / 540);
        g.save(); g.scale(s, s); g.fillStyle = pat; g.fillRect(0, 0, W / s, H / s); g.restore();
      }
      g.globalAlpha = 1; g.globalCompositeOperation = 'destination-in'; g.drawImage(A, 0, 0); g.globalCompositeOperation = 'source-over';
    }
    // Mask
    const m = item.mask;
    if (m && m.type && m.type !== 'none') {
      const { c: M, g: mg } = layer(5, W, H);
      const feather = (m.feather || 0) * Math.min(r.w, r.h) * 0.25;
      mg.save(); place(mg); if (feather > 0.5) mg.filter = `blur(${feather}px)`; mg.fillStyle = '#fff'; maskPath(mg, m, r); mg.fill(); mg.restore();
      g.globalCompositeOperation = m.invert ? 'destination-out' : 'destination-in'; g.drawImage(M, 0, 0); g.globalCompositeOperation = 'source-over';
    }
    if (fxAmt(item, 'letterbox')) { const bar = H * 0.11 * fxAmt(item, 'letterbox'); g.fillStyle = '#000'; g.fillRect(0, 0, W, bar); g.fillRect(0, H - bar, W, bar); }
    // Lay the layer on the frame, with flashes and flicker on top.
    let a = opacity;
    const strobe = fxAmt(item, 'strobe');
    if (strobe && Math.floor(local * 10) % 2) a *= 1 - 0.8 * strobe;
    ctx.save(); ctx.globalAlpha *= a; ctx.drawImage(L, 0, 0); ctx.restore();
    const flash = fxAmt(item, 'flash');
    if (flash) {
      const f = Math.max(0, 1 - local / 0.35) + Math.max(0, 1 - ((local % 1.2) / 0.12)) * 0.6;
      if (f > 0) { ctx.save(); ctx.globalAlpha *= clamp(f, 0, 1) * flash * a; ctx.fillStyle = '#fff'; ctx.fillRect(r.x, r.y, r.w, r.h); ctx.restore(); }
    }
  }

  window.VFX = { KF_PROPS, value, keyAt, setKey, removeKey, keyTimes, hasKeys, FILTERS, applyFilter, MASKS, EFFECTS, fxAmt, drawItem, isPlain };
})();
