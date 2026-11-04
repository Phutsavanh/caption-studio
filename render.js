/* Caption renderer shared by the live preview, the preset thumbnails and the export.
   Everything is a pure function of (chunk, time, style), so a frame looks the same in preview and in the file.
   Text is drawn by the browser (correct Lao shaping) and only ever split at whole-word tokens. */
(function (root) {
  const DEFAULT_STYLE = {
    font: 'Noto Sans Lao', weight: 800, size: 84, letterSpacing: 0, lineHeight: 1.35, maxWidth: 0.86, align: 'center', tilt: 0,
    fillMode: 'solid', fill: '#FFFFFF', fill2: '#FFD400',
    stroke: '#000000', strokeW: 10, stroke2: '#FFFFFF', stroke2W: 0,
    shadow: '#000000', shadowA: 0.55, shadowBlur: 14, shadowX: 0, shadowY: 6,
    glow: '#FF2BD6', glowBlur: 0,
    depth: 0, depthColor: '#000000', depthAngle: 45, rgbSplit: 0,
    box: 'none', boxColor: '#000000', boxA: 0.75, boxRadius: 18, boxPadX: 26, boxPadY: 8,
    emphColor: '#FF1E1E', emphScale: 1.12,
    active: 'none', activeColor: '#FFD400', activeBox: '#FF1E1E', pending: 'show',
    animIn: 'pop', animOut: 'none', loop: 'none', unit: 'line', inDur: 0.22, outDur: 0.12, stagger: 0.07, loopAmt: 1,
  };

  const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
  const lerp = (a, b, p) => a + (b - a) * p;
  const easeOut = p => 1 - Math.pow(1 - p, 3);
  const expoOut = p => (p >= 1 ? 1 : 1 - Math.pow(2, -10 * p));
  const backOut = p => { const c = 1.9; return 1 + (c + 1) * Math.pow(p - 1, 3) + c * Math.pow(p - 1, 2); };
  const elasticOut = p => (p <= 0 ? 0 : p >= 1 ? 1 : Math.pow(2, -9 * p) * Math.sin((p * 8 - 0.75) * (2 * Math.PI) / 3) + 1);
  const bounceOut = p => {
    const n = 7.5625, d = 2.75;
    if (p < 1 / d) return n * p * p;
    if (p < 2 / d) return n * (p -= 1.5 / d) * p + 0.75;
    if (p < 2.5 / d) return n * (p -= 2.25 / d) * p + 0.9375;
    return n * (p -= 2.625 / d) * p + 0.984375;
  };
  const rnd = n => { const x = Math.sin(n * 12.9898) * 43758.5453; return x - Math.floor(x); };
  const quick = (p, f = 3) => Math.min(1, p * f);

  // Entrance: p goes 0 -> 1. a=alpha k=scale kx/ky=axis scale dx/dy=offset (base px) rot=radians blur=px clip=wipe jitter=px
  const IN = {
    none: () => ({}),
    fade: p => ({ a: p }),
    pop: p => ({ a: quick(p), k: lerp(0.55, 1, backOut(p)) }),
    bounce: p => ({ a: quick(p, 4), k: lerp(0.25, 1, elasticOut(p)) }),
    slam: p => ({ a: quick(p), k: lerp(2.4, 1, expoOut(p)) }),
    zoomIn: p => ({ a: quick(p), k: expoOut(p) }),
    slideUp: p => ({ a: quick(p, 2), dy: (1 - easeOut(p)) * 80 }),
    slideDown: p => ({ a: quick(p, 2), dy: -(1 - easeOut(p)) * 80 }),
    slideLeft: p => ({ a: quick(p, 2), dx: (1 - easeOut(p)) * 160 }),
    slideRight: p => ({ a: quick(p, 2), dx: -(1 - easeOut(p)) * 160 }),
    drop: p => ({ a: quick(p, 4), dy: -(1 - bounceOut(p)) * 220 }),
    flip: p => ({ a: quick(p, 4), ky: backOut(p) }),
    stretch: p => ({ a: quick(p, 4), kx: lerp(1.9, 1, backOut(p)), ky: lerp(0.35, 1, backOut(p)) }),
    swing: p => ({ a: quick(p, 3), rot: (1 - backOut(p)) * -0.35 }),
    spin: p => ({ a: quick(p, 3), rot: (1 - expoOut(p)) * 1.6, k: lerp(0.3, 1, expoOut(p)) }),
    blurIn: p => ({ a: p, blur: (1 - p) * 24 }),
    wipe: p => ({ clip: easeOut(p) }),
    typewriter: p => ({ a: p > 0 ? 1 : 0 }),
    glitch: p => ({ a: quick(p, 5), jitter: (1 - p) * 34 }),
  };
  // Exit: q goes 0 -> 1
  const OUT = {
    none: () => ({}),
    fade: q => ({ a: 1 - q }),
    popOut: q => ({ a: 1 - q, k: lerp(1, 0.6, q) }),
    zoomOut: q => ({ a: 1 - q, k: lerp(1, 1.5, q) }),
    slideUp: q => ({ a: 1 - q, dy: -q * 70 }),
    slideDown: q => ({ a: 1 - q, dy: q * 70 }),
    blurOut: q => ({ a: 1 - q, blur: q * 20 }),
  };
  // Continuous: t = seconds since the caption appeared, i = token index, amt = strength
  const LOOP = {
    none: () => ({}),
    float: (t, i, amt) => ({ dy: Math.sin(t * 3.2) * 9 * amt }),
    pulse: (t, i, amt) => ({ k: 1 + Math.sin(t * 7) * 0.035 * amt }),
    shake: (t, i, amt) => { const f = Math.floor(t * 24); return { dx: (rnd(f + i) - 0.5) * 7 * amt, dy: (rnd(f * 3.1 + i) - 0.5) * 7 * amt }; },
    wave: (t, i, amt) => ({ dy: Math.sin(t * 6 - i * 0.9) * 12 * amt }),
    swing: (t, i, amt) => ({ rot: Math.sin(t * 4) * 0.035 * amt }),
    flicker: (t, i, amt) => { const f = Math.floor(t * 18); return { a: rnd(f) < 0.1 * amt ? 0.45 : 1 }; },
    glitch: (t, i, amt) => { const f = Math.floor(t * 12); return rnd(f) < 0.16 * amt ? { dx: (rnd(f + 7) - 0.5) * 26, rgb: 8 } : {}; },
  };

  const merge = (...states) => {
    const o = { a: 1, k: 1, kx: 1, ky: 1, dx: 0, dy: 0, rot: 0, blur: 0, clip: 1, jitter: 0, rgb: 0 };
    for (const s of states) {
      if (s.a != null) o.a *= s.a;
      if (s.k != null) o.k *= s.k;
      if (s.kx != null) o.kx *= s.kx;
      if (s.ky != null) o.ky *= s.ky;
      if (s.dx) o.dx += s.dx;
      if (s.dy) o.dy += s.dy;
      if (s.rot) o.rot += s.rot;
      if (s.blur) o.blur += s.blur;
      if (s.clip != null) o.clip *= s.clip;
      if (s.jitter) o.jitter += s.jitter;
      if (s.rgb) o.rgb += s.rgb;
    }
    return o;
  };

  const fontStr = (st, size) => `${st.weight} ${size}px "${st.font}", "Noto Sans Lao", "Arial Black", sans-serif`;

  function layout(ctx, chunk, st, W, H, forcedScale) {
    const s = forcedScale || Math.min(W, H) / 1080, size = st.size * s;
    ctx.letterSpacing = `${(st.letterSpacing || 0) * s}px`;
    ctx.font = fontStr(st, size);
    const spaceW = ctx.measureText(' ').width || size * 0.28;
    const maxW = st.maxWidth * W;
    const lines = [[]];
    let curW = 0;
    chunk.words.forEach((w, i) => {
      const fs = size * (w.emph ? st.emphScale : 1);
      ctx.font = fontStr(st, fs);
      const tw = ctx.measureText(w.text).width;
      const gap = lines[lines.length - 1].length && chunk.words[i - 1].spaceAfter ? spaceW : 0;
      if (lines[lines.length - 1].length && curW + gap + tw > maxW) { lines.push([]); curW = 0; }
      const line = lines[lines.length - 1];
      const useGap = line.length && chunk.words[i - 1].spaceAfter ? spaceW : 0;
      line.push({ w, i, x: curW + useGap, width: tw, fs });
      curW += useGap + tw;
      line.width = curW;
    });
    const lh = size * st.lineHeight;
    const blockW = Math.max(...lines.map(l => l.width || 0));
    const blockH = lines.length * lh;
    const tokens = [];
    lines.forEach((line, li) => {
      const off = st.align === 'left' ? 0 : st.align === 'right' ? blockW - line.width : (blockW - line.width) / 2;
      line.x = off; line.y = li * lh;
      line.forEach(tk => { tk.x += off; tk.y = li * lh + lh / 2 + size * 0.34; tk.cx = tk.x + tk.width / 2; tk.cy = li * lh + lh / 2; tk.line = li; tokens.push(tk); });
    });
    return { s, size, lh, lines, tokens, blockW, blockH };
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, Math.min(r, h / 2, w / 2));
  }
  const hexA = (hex, a) => {
    const n = parseInt(String(hex).slice(1), 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  };

  function tokenTiming(tk, chunk, t, st) {
    const local = t - chunk.start, dur = Math.max(0.01, chunk.end - chunk.start);
    const inD = Math.max(0.001, Math.min(st.inDur, dur * 0.35));
    let delay = 0;
    const spoken = st.pending !== 'show';
    if (spoken) delay = Math.max(0, tk.w.start - chunk.start);
    else if (st.unit === 'word') delay = Math.min(tk.i * st.stagger, dur * 0.5);
    return { p: clamp((local - delay) / inD), started: local >= delay, delay };
  }

  /** Draw one caption at time t. Returns its bounding box in canvas pixels (used for dragging). */
  function drawChunk(ctx, W, H, chunk, t, st, pos, opts = {}) {
    if (!chunk || !chunk.words.length) return null;
    const L = layout(ctx, chunk, st, W, H, opts.s), s = L.s;
    const ox = pos.x * W - L.blockW / 2, oy = pos.y * H - L.blockH / 2;
    const dur = Math.max(0.01, chunk.end - chunk.start);
    const outD = Math.min(st.outDur, dur * 0.25);
    const local = t - chunk.start;
    const q = st.animOut !== 'none' && outD > 0 ? clamp((local - (dur - outD)) / outD) : 0;
    const tokenWise = st.unit === 'word' || st.pending !== 'show';
    const inFn = IN[st.animIn] || IN.none, outFn = OUT[st.animOut] || OUT.none, loopFn = LOOP[st.loop] || LOOP.none;
    const inD = Math.max(0.001, Math.min(st.inDur, dur * 0.35));
    const block = merge(
      tokenWise ? {} : inFn(clamp(local / inD)),
      outFn(q),
      st.loop === 'wave' ? {} : loopFn(local, 0, st.loopAmt),
      opts.ghost ? { a: 0.4 } : {},
    );
    const bx = pos.x * W, by = pos.y * H;

    const activeIdx = st.active === 'none' && st.pending === 'show' ? -1
      : chunk.words.findIndex(w => t >= w.start && t < w.end);

    const states = L.tokens.map(tk => {
      const parts = [];
      let hidden = false;
      if (tokenWise) {
        const tm = tokenTiming(tk, chunk, t, st);
        if (!tm.started && st.pending === 'hide') hidden = true;
        if (!tm.started && st.pending === 'dim') parts.push({ a: 0.35 });
        else if (st.pending === 'dim' && tm.started) parts.push({});
        else if (!tm.started && st.unit === 'word') hidden = true;
        else parts.push(inFn(tm.p));
      }
      if (st.loop === 'wave') parts.push(loopFn(local, tk.i, st.loopAmt));
      if (tk.i === activeIdx && st.active === 'scale') parts.push({ k: 1.16 });
      return { tk, hidden, state: merge(...parts) };
    });

    const withBlock = fn => {
      ctx.save();
      ctx.translate(bx + block.dx * s, by + block.dy * s);
      if (st.tilt) ctx.rotate(st.tilt * Math.PI / 180);
      if (block.rot) ctx.rotate(block.rot);
      ctx.scale(block.k * block.kx, block.k * block.ky);
      ctx.translate(-bx, -by);
      if (block.clip < 1) { ctx.beginPath(); ctx.rect(ox - 40 * s, oy - 40 * s, (L.blockW + 80 * s) * block.clip, L.blockH + 80 * s); ctx.clip(); }
      ctx.globalAlpha = clamp(block.a);
      if (block.blur > 0.3) ctx.filter = `blur(${block.blur * s}px)`;
      fn();
      ctx.restore();
    };
    const withToken = (entry, fn) => {
      if (entry.hidden) return;
      const { tk, state } = entry, c = state;
      ctx.save();
      const cx = ox + tk.cx, cy = oy + tk.cy;
      let jx = 0, jy = 0;
      const jit = c.jitter + block.jitter;
      if (jit > 0.5) { const f = Math.floor(t * 30) + tk.i * 13; jx = (rnd(f) - 0.5) * jit * s; jy = (rnd(f + 5) - 0.5) * jit * s * 0.5; }
      ctx.translate(cx + c.dx * s + jx, cy + c.dy * s + jy);
      if (c.rot) ctx.rotate(c.rot);
      ctx.scale(c.k * c.kx, c.k * c.ky);
      ctx.translate(-cx, -cy);
      if (c.clip < 1) { ctx.beginPath(); ctx.rect(ox + tk.x - 10 * s, oy + tk.cy - L.lh, (tk.width + 20 * s) * c.clip, L.lh * 2); ctx.clip(); }
      ctx.globalAlpha *= clamp(c.a);
      if (c.blur > 0.3) ctx.filter = `blur(${c.blur * s}px)`;
      fn(tk, ox + tk.x, oy + tk.y);
      ctx.restore();
    };

    ctx.save();
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.miterLimit = 2;
    ctx.letterSpacing = `${(st.letterSpacing || 0) * s}px`;

    withBlock(() => {
      // Background boxes
      if (st.box === 'block' || st.box === 'line') {
        ctx.fillStyle = hexA(st.boxColor, st.boxA);
        const px = st.boxPadX * s, py = st.boxPadY * s;
        if (st.box === 'block') { roundRect(ctx, ox - px, oy - py, L.blockW + 2 * px, L.blockH + 2 * py, st.boxRadius * s); ctx.fill(); }
        else L.lines.forEach(line => { roundRect(ctx, ox + line.x - px, oy + line.y - py + (L.lh * 0.04), line.width + 2 * px, L.lh + 2 * py - (L.lh * 0.08), st.boxRadius * s); ctx.fill(); });
      }
      states.forEach(e => withToken(e, tk => {
        const pad = st.boxPadX * s * 0.5, py = st.boxPadY * s;
        if (st.box === 'word') {
          ctx.fillStyle = hexA(st.boxColor, st.boxA);
          roundRect(ctx, ox + tk.x - pad, oy + tk.line * L.lh + py, tk.width + 2 * pad, L.lh - 2 * py, st.boxRadius * s); ctx.fill();
        }
        if (st.active === 'box' && tk.i === activeIdx) {
          ctx.fillStyle = st.activeBox;
          roundRect(ctx, ox + tk.x - pad, oy + tk.line * L.lh + py * 0.4, tk.width + 2 * pad, L.lh - py * 0.8, st.boxRadius * s); ctx.fill();
        }
      }));

      const setFont = tk => { ctx.font = fontStr(st, tk.fs); };
      const shadowOn = () => {
        if (st.shadowA > 0 && (st.shadowBlur > 0 || st.shadowX || st.shadowY)) {
          ctx.shadowColor = hexA(st.shadow, st.shadowA);
          ctx.shadowBlur = st.shadowBlur * s;
          ctx.shadowOffsetX = st.shadowX * s;
          ctx.shadowOffsetY = st.shadowY * s;
        }
      };
      const shadowOff = () => { ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; ctx.shadowOffsetX = 0; ctx.shadowOffsetY = 0; };

      // 3D extrusion
      if (st.depth > 0) {
        const ang = st.depthAngle * Math.PI / 180, steps = Math.ceil(st.depth);
        states.forEach(e => withToken(e, (tk, x, y) => {
          setFont(tk);
          ctx.fillStyle = st.depthColor; ctx.strokeStyle = st.depthColor;
          ctx.lineWidth = Math.max(st.strokeW, 0) * s;
          for (let d = steps; d >= 1; d--) {
            const ex = Math.cos(ang) * d * s, ey = Math.sin(ang) * d * s;
            if (d === steps) shadowOn(); else shadowOff();
            if (st.strokeW > 0) ctx.strokeText(tk.w.text, x + ex, y + ey);
            ctx.fillText(tk.w.text, x + ex, y + ey);
          }
          shadowOff();
        }));
      }
      // Outer outline
      if (st.stroke2W > 0) {
        states.forEach(e => withToken(e, (tk, x, y) => {
          setFont(tk);
          if (!st.depth) shadowOn();
          ctx.strokeStyle = st.stroke2;
          ctx.lineWidth = (st.strokeW + st.stroke2W * 2) * s;
          ctx.strokeText(tk.w.text, x, y);
          shadowOff();
        }));
      }
      // Glitch colour split
      const rgb = st.rgbSplit + block.rgb;
      if (rgb > 0) {
        states.forEach(e => withToken(e, (tk, x, y) => {
          setFont(tk);
          ctx.fillStyle = '#FF0044'; ctx.fillText(tk.w.text, x - rgb * s, y);
          ctx.fillStyle = '#00E5FF'; ctx.fillText(tk.w.text, x + rgb * s, y);
        }));
      }
      // Main outline
      if (st.strokeW > 0) {
        states.forEach(e => withToken(e, (tk, x, y) => {
          setFont(tk);
          if (!st.depth && !st.stroke2W) shadowOn();
          ctx.strokeStyle = st.stroke;
          ctx.lineWidth = st.strokeW * s;
          ctx.strokeText(tk.w.text, x, y);
          shadowOff();
        }));
      }
      // Fill (with glow)
      const fillFor = (tk, x, y) => {
        if (st.active === 'color' && tk.i === activeIdx) return st.activeColor;
        if (tk.w.emph) return st.emphColor;
        if (st.fillMode === 'gradient') {
          const g = ctx.createLinearGradient(0, y - tk.fs * 0.85, 0, y + tk.fs * 0.3);
          g.addColorStop(0, st.fill); g.addColorStop(1, st.fill2);
          return g;
        }
        return st.fill;
      };
      states.forEach(e => withToken(e, (tk, x, y) => {
        setFont(tk);
        ctx.fillStyle = fillFor(tk, x, y);
        if (st.glowBlur > 0) {
          ctx.shadowColor = st.glow;
          ctx.shadowBlur = st.glowBlur * s;
          ctx.fillText(tk.w.text, x, y);
          ctx.shadowBlur = st.glowBlur * s * 0.45;
          ctx.fillText(tk.w.text, x, y);
          shadowOff();
        } else if (!st.strokeW && !st.stroke2W && !st.depth) shadowOn();
        ctx.fillText(tk.w.text, x, y);
        shadowOff();
        if (st.active === 'underline' && tk.i === activeIdx) {
          ctx.fillStyle = st.activeColor;
          roundRect(ctx, x, y + tk.fs * 0.2, tk.width, Math.max(6 * s, tk.fs * 0.08), 4 * s); ctx.fill();
        }
      }));
    });
    ctx.restore();

    return { x: ox, y: oy, w: L.blockW, h: L.blockH, s };
  }

  /** A stable id when the frame is identical to its neighbours, so export can reuse the encoded image. */
  function frameKey(chunk, idx, t, st) {
    if (!chunk) return 'blank';
    if (st.loop !== 'none' || st.active !== 'none' || st.pending !== 'show') return null;
    const dur = chunk.end - chunk.start;
    const inD = Math.min(st.inDur, dur * 0.35), outD = st.animOut === 'none' ? 0 : Math.min(st.outDur, dur * 0.25);
    const delay = st.unit === 'word' ? Math.min((chunk.words.length - 1) * st.stagger, dur * 0.5) : 0;
    const local = t - chunk.start;
    return local >= inD + delay && local <= dur - outD ? `hold${idx}` : null;
  }

  root.CaptionRender = { DEFAULT_STYLE, IN, OUT, LOOP, drawChunk, frameKey };
})(window);
