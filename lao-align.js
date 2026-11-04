/* Lines up a Lao script with Whisper's Thai-script word timings by consonant class.
   Same scoring as scripts/align_words.py and the lao-subtitles skill; only the language differs. */
(function (root) {
  const GROUPS = ['กขฃคฅฆง', 'จฉชซฌญย', 'ฎฏดตฐฑฒณทธนถ', 'บปผฝพฟภมว', 'รลฬ', 'สศษห', 'อฮ'];
  const CLASS = new Map();
  GROUPS.forEach((g, i) => { for (const c of g) CLASS.set(c, 'ABCDEFG'[i]); });
  const SPECIAL = { 'ຫ': 'ห', 'ຼ': 'ล', 'ໜ': 'หน', 'ໝ': 'หม', 'ວ': 'ว', 'ຍ': 'ย', 'ຣ': 'ร', 'ລ': 'ล' };
  const lao2thai = s => {
    let out = '';
    for (const c of s) {
      const code = c.codePointAt(0);
      out += SPECIAL[c] || (code >= 0x0E80 && code <= 0x0EFF ? String.fromCodePoint(code - 0x80) : c);
    }
    return out;
  };
  const skel = s => {
    let out = '';
    for (const c of s) {
      if (CLASS.has(c)) out += CLASS.get(c);
      else if (/\d/.test(c)) out += '9';
      else if (/[A-Za-z]/.test(c)) out += 'L';
    }
    return out;
  };

  /** lines: string[], words: [{w, s, e}] -> for each line, [[charIndex, seconds], ...] */
  function alignChars(lines, words) {
    const S = [], lineOf = [], charOf = [];
    lines.forEach((ln, li) => {
      let ci = 0;
      for (const ch of ln) {
        for (const k of skel(lao2thai(ch))) { S.push(k); lineOf.push(li); charOf.push(ci); }
        ci += ch.length;
      }
    });
    const W = [], T = [];
    for (const w of words) {
      const k = skel(w.w);
      if (!k) continue;
      const d = (w.e - w.s) / k.length;
      [...k].forEach((c, j) => { W.push(c); T.push(w.s + d * (j + 0.5)); });
    }
    const n = S.length, m = W.length;
    const timeOf = new Array(n).fill(null);
    if (n && m) {
      const MATCH = 2, MISM = -1, GAP = -1.2;
      const bt = new Int8Array((n + 1) * (m + 1));
      let prev = new Float32Array(m + 1), row = new Float32Array(m + 1);
      for (let j = 0; j <= m; j++) { prev[j] = j * GAP * 0.3; if (j) bt[j] = 2; }
      for (let i = 1; i <= n; i++) {
        row[0] = i * GAP;
        const base = i * (m + 1);
        bt[base] = 1;
        for (let j = 1; j <= m; j++) {
          const diag = prev[j - 1] + (W[j - 1] === S[i - 1] ? MATCH : MISM);
          const up = prev[j] + GAP;
          const left = row[j - 1] + GAP;
          const best = diag >= up ? diag : up;
          if (left > best) { row[j] = left; bt[base + j] = 2; } else { row[j] = best; bt[base + j] = diag >= up ? 0 : 1; }
        }
        [prev, row] = [row, prev];
      }
      let i = n, j = m;
      while (i > 0 && j > 0) {
        const c = bt[i * (m + 1) + j];
        if (c === 0) { if (S[i - 1] === W[j - 1]) timeOf[i - 1] = T[j - 1]; i--; j--; } else if (c === 1) i--; else j--;
      }
    }
    const perLine = lines.map(() => []);
    for (let k = 0; k < n; k++) if (timeOf[k] != null) perLine[lineOf[k]].push([charOf[k], Math.round(timeOf[k] * 1000) / 1000]);
    return perLine;
  }

  // ---- Draft text when there is no script: Thai letters -> Lao letters. Always needs proofreading. ----
  const TH2LO = {
    ก: 'ກ', ข: 'ຂ', ฃ: 'ຂ', ค: 'ຄ', ฅ: 'ຄ', ฆ: 'ຄ', ง: 'ງ', จ: 'ຈ', ฉ: 'ສ', ช: 'ຊ', ซ: 'ຊ', ฌ: 'ຊ', ญ: 'ຍ', ฎ: 'ດ', ฏ: 'ຕ', ฐ: 'ຖ', ฑ: 'ທ', ฒ: 'ທ', ณ: 'ນ',
    ด: 'ດ', ต: 'ຕ', ถ: 'ຖ', ท: 'ທ', ธ: 'ທ', น: 'ນ', บ: 'ບ', ป: 'ປ', ผ: 'ຜ', ฝ: 'ຝ', พ: 'ພ', ฟ: 'ຟ', ภ: 'ພ', ม: 'ມ', ย: 'ຍ', ร: 'ຮ', ล: 'ລ', ฬ: 'ລ', ว: 'ວ', ศ: 'ສ', ษ: 'ສ', ส: 'ສ',
    ห: 'ຫ', อ: 'ອ', ฮ: 'ຮ', 'ะ': 'ະ', 'ั': 'ັ', 'า': 'າ', 'ำ': 'ຳ', 'ิ': 'ິ', 'ี': 'ີ', 'ึ': 'ຶ', 'ื': 'ື', 'ุ': 'ຸ', 'ู': 'ູ', 'เ': 'ເ', 'แ': 'ແ', 'โ': 'ໂ', 'ใ': 'ໃ', 'ไ': 'ໄ',
    '็': 'ັ', '่': '່', '้': '້', '๊': '໊', '๋': '໋', 'ๆ': 'ໆ', 'ฯ': '', '์': '', '๐': '0', '๑': '1', '๒': '2', '๓': '3', '๔': '4', '๕': '5', '๖': '6', '๗': '7', '๘': '8', '๙': '9',
  };
  const CONS = 'ກຂຄງຈສຊຍດຕຖທນບປຜຝພຟມຢຣລວຫອຮໜໝ', TONE = '່້໊໋', VOW = 'ັາິີຶືຸູົ';
  function thai2lao(text) {
    let s = text.replace(/[ก-ฮ][ิุ]?์/g, '').replace(/หน/g, 'ໜ').replace(/หม/g, 'ໝ').replace(/หล/g, 'ຫຼ');
    s = [...s].map(c => (c in TH2LO ? TH2LO[c] : c)).join('');
    s = s.replace(new RegExp(`ເ([${CONS}])([${TONE}]?)າ`, 'g'), 'ເ$1ົ$2າ');
    s = s.replace(new RegExp(`ເ([${CONS}])ີ([${TONE}]?)ຍ`, 'g'), '§$1$2ຍ');
    s = s.replace(new RegExp(`ເ([${CONS}])([${TONE}]?)ຍ(?![າະິີຶືຸູ])`, 'g'), 'ເ$1ີ$2ຍ');
    s = s.replace(/§/g, 'ເ');
    s = s.replace(new RegExp(`(?<![ເແໂ])([${CONS}])([${TONE}]?)ອ(?![${CONS}າະິີຶືຸູ])`, 'g'), '$1ໍ$2');
    return s.replace(/ຫມ/g, 'ໝ').replace(/ຫນ/g, 'ໜ').replace(/ຫລ/g, 'ຫຼ').replace(/\s+ໆ/g, 'ໆ')
      .replace(new RegExp(`(?<=[${VOW}])ຮ(?![${VOW}ະຳ${TONE}])`, 'g'), 'ນ')
      .replace(new RegExp(`(?<=[${VOW}])[ຕສທຊ](?![${VOW}ະຳ${TONE}])`, 'g'), 'ດ');
  }

  /** Whisper result -> the same shape the local server returns. */
  function buildResult(script, words, segs, duration) {
    const lines = script.split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length) {
      const perLine = alignChars(lines, words);
      return {
        draft: false,
        duration,
        lines: lines.map((text, i) => ({ text, times: perLine[i], anchored: perLine[i].length >= Math.max(1, Math.floor(skel(lao2thai(text)).length / 3)) })),
      };
    }
    const out = [];
    for (const seg of segs) {
      let text = '';
      const times = [];
      for (const w of seg.words) {
        const lo = thai2lao(w.w.trim());
        if (!lo) continue;
        if (text && /^\s/.test(w.w)) text += ' ';
        times.push([text.length, Math.round(w.s * 1000) / 1000]);
        text += lo;
      }
      if (text.trim()) out.push({ text, times, anchored: true });
    }
    return { draft: true, duration, lines: out };
  }

  root.LaoAlign = { alignChars, thai2lao, buildResult, skel, lao2thai };
})(typeof self !== 'undefined' ? self : window);
