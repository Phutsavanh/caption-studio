/* Voice presets: save a voice once, then turn any script into speech. The voice model needs a GPU, so it runs in the
   Caption Studio program on the PC. The web version talks to that program when both are on the same PC. */
(function () {
  const base = () => (window.CS_BACKEND ? 'http://localhost:8097' : '');
  const $v = id => document.getElementById(id);
  let voices = [], lastResult = null, polling = false;
  const call = async (path, body, raw) => {
    const opt = body === undefined ? {} : raw
      ? { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body }
      : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
    const r = await fetch(base() + path, opt);
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || 'ເກີດຂໍ້ຜິດພາດ');
    return j;
  };
  const say = (text, cls = '') => { const n = $v('vcNote'); n.className = `notice ${cls}`; n.textContent = text; n.classList.toggle('hidden', !text); };

  function shell() {
    const host = $v('tab-voice');
    host.innerHTML = `
      <div class="card notice-lic small">⚠ ຕົວໂຄຣນສຽງ OmniVoice ຫ້າມໃຊ້ເພື່ອການຄ້າ (CC-BY-NC) ແລະ ຫ້າມໂຄຣນສຽງຄົນທີ່ບໍ່ໄດ້ອະນຸຍາດ.</div>
      <div id="vcOffline" class="card hidden"></div>
      <div id="vcMain" class="hidden">
        <div class="card">
          <label class="lbl">ສຽງທີ່ຈະໃຊ້</label>
          <div id="vcList" class="vclist"></div>
          <button id="vcShowAdd" class="wide">+ ເພີ່ມພຣີເຊັດສຽງໃໝ່</button>
          <div id="vcAdd" class="hidden">
            <label class="lbl">ຊື່ພຣີເຊັດ</label><input id="vcName" type="text" placeholder="ເຊັ່ນ ສຽງຮ້ານ 99TH">
            <label class="lbl">ໄຟລ໌ສຽງຕົວຢ່າງ 3–15 ວິນາທີ <span class="muted small">(ສຽງຄົນດຽວ ຊັດເຈນ ບໍ່ມີເພງ)</span></label>
            <input id="vcFile" type="file" accept="audio/*,video/*">
            <label class="lbl">ຄຳເວົ້າໃນໄຟລ໌ນັ້ນ <span class="muted small">(ຂຽນໃຫ້ກົງທຸກຄຳ)</span></label>
            <textarea id="vcRefText" rows="3" placeholder="ພິມຄຳທີ່ເວົ້າໃນໄຟລ໌ສຽງ"></textarea>
            <label class="check vcconsent"><input type="checkbox" id="vcConsent"> ນີ້ແມ່ນສຽງຂອງຂ້ອຍ ຫຼື ເຈົ້າຂອງສຽງອະນຸຍາດແລ້ວ</label>
            <div class="row"><button id="vcSave" class="primary grow">ບັນທຶກພຣີເຊັດ</button><button id="vcCancel">ຍົກເລີກ</button></div>
          </div>
        </div>
        <div class="card">
          <label class="lbl">ສະຄຣິບທີ່ຈະພາກ <span class="muted small">(ຂຶ້ນແຖວໃໝ່ = ຢຸດພັກສັ້ນໆ)</span></label>
          <textarea id="vcScript" rows="6" placeholder="ວາງສະຄຣິບລາວຢູ່ນີ້"></textarea>
          <div class="ctl"><span>ຄວາມໄວ</span><input id="vcSpeed" type="range" min="0.7" max="1.3" step="0.05" value="1"><output id="vcSpeedOut">1.00</output></div>
          <button id="vcGo" class="primary wide">🎙 ພາກສຽງ</button>
          <div id="vcJob" class="hidden"><div class="bar"><i id="vcBar"></i></div><div id="vcJobText" class="small muted"></div></div>
          <div id="vcResult" class="hidden">
            <audio id="vcAudio" controls></audio>
            <div class="row wrap">
              <button id="vcUse" class="primary grow">ໃສ່ໄທມ໌ລາຍ ພ້ອມຟ້ອນ</button>
              <a id="vcDownload" class="linkbtn alt">ດາວໂຫຼດ</a>
            </div>
          </div>
        </div>
      </div>
      <div id="vcNote" class="notice hidden"></div>`;
    $v('vcShowAdd').onclick = () => $v('vcAdd').classList.toggle('hidden');
    $v('vcCancel').onclick = () => $v('vcAdd').classList.add('hidden');
    $v('vcSave').onclick = () => savePreset().catch(e => say(e.message, 'bad'));
    $v('vcGo').onclick = () => generate().catch(e => { say(e.message, 'bad'); $v('vcJob').classList.add('hidden'); $v('vcGo').disabled = false; });
    $v('vcUse').onclick = () => useResult().catch(e => say(e.message, 'bad'));
    $v('vcSpeed').oninput = e => { $v('vcSpeedOut').textContent = Number(e.target.value).toFixed(2); };
    ['vcName', 'vcRefText', 'vcScript'].forEach(id => $v(id).addEventListener('keydown', e => e.stopPropagation()));
  }

  function renderVoices() {
    const list = $v('vcList');
    list.textContent = '';
    if (!voices.length) { list.innerHTML = '<p class="small muted">ຍັງບໍ່ມີພຣີເຊັດສຽງ. ກົດເພີ່ມດ້ານລຸ່ມ.</p>'; return; }
    const current = localStorage.getItem('cs.voice') || voices[0].id;
    voices.forEach(v => {
      const row = document.createElement('label');
      row.className = 'vcitem';
      const r = document.createElement('input');
      r.type = 'radio'; r.name = 'vcVoice'; r.value = v.id; r.checked = v.id === current;
      r.onchange = () => localStorage.setItem('cs.voice', v.id);
      const name = document.createElement('span'); name.className = 'grow'; name.textContent = v.name;
      const play = document.createElement('button'); play.className = 'tiny'; play.textContent = '▶';
      play.onclick = e => { e.preventDefault(); new Audio(base() + v.url).play(); };
      const del = document.createElement('button'); del.className = 'tiny'; del.textContent = '✕';
      del.onclick = async e => {
        e.preventDefault();
        if (del.dataset.sure !== '1') { del.dataset.sure = '1'; del.textContent = 'ລົບ?'; return; }
        await call(`/api/voice/presets/${v.id}/delete`, {});
        refresh();
      };
      row.append(r, name, play, del);
      list.appendChild(row);
    });
  }
  async function refresh() {
    try {
      const st = await call('/api/voice/status');
      if (!st.available) throw Object.assign(new Error('no engine'), { engine: true });
      voices = await call('/api/voice/presets');
      $v('vcOffline').classList.add('hidden');
      $v('vcMain').classList.remove('hidden');
      renderVoices();
      if (!$v('vcScript').value) $v('vcScript').value = (typeof S !== 'undefined' && S.script) || '';
    } catch (e) {
      const box = $v('vcOffline');
      box.classList.remove('hidden');
      $v('vcMain').classList.add('hidden');
      box.innerHTML = e.engine
        ? '<b>ຄອມນີ້ຍັງບໍ່ໄດ້ຕິດຕັ້ງຕົວໂຄຣນສຽງ.</b>'
        : `<b>ພາກສຽງໄດ້ຕອນເຊື່ອມກັບຄອມເທົ່ານັ້ນ.</b><p class="small">ຕົວໂຄຣນສຽງຕ້ອງໃຊ້ GPU ຈຶ່ງແລ່ນໃນໂທລະສັບບໍ່ໄດ້. ເປີດໂປຣແກຣມ Caption Studio ໃນຄອມ ແລ້ວເປີດໜ້ານີ້ໃນ Chrome ຂອງຄອມ. ຖ້າ Chrome ຖາມເລື່ອງເຄືອຂ່າຍໃນເຄື່ອງ ໃຫ້ກົດອະນຸຍາດ.</p><button id="vcRetry" class="wide">ລອງເຊື່ອມໃໝ່</button>`;
      const retry = $v('vcRetry');
      if (retry) retry.onclick = refresh;
    }
  }
  async function savePreset() {
    const name = $v('vcName').value.trim(), file = $v('vcFile').files[0], refText = $v('vcRefText').value.trim();
    if (!name || !file || !refText) throw new Error('ກະລຸນາໃສ່ຊື່, ໄຟລ໌ສຽງ ແລະ ຄຳເວົ້າໃນໄຟລ໌ໃຫ້ຄົບ');
    if (!$v('vcConsent').checked) throw new Error('ຕ້ອງຢືນຢັນວ່າເປັນສຽງຂອງທ່ານ ຫຼື ເຈົ້າຂອງອະນຸຍາດແລ້ວ');
    say('ກຳລັງບັນທຶກ...');
    const q = new URLSearchParams({ name, refText, consent: '1' });
    const v = await call(`/api/voice/presets?${q}`, await file.arrayBuffer(), true);
    localStorage.setItem('cs.voice', v.id);
    say(`✓ ບັນທຶກ "${v.name}" ແລ້ວ`, 'good');
    $v('vcAdd').classList.add('hidden');
    $v('vcName').value = ''; $v('vcRefText').value = ''; $v('vcFile').value = ''; $v('vcConsent').checked = false;
    refresh();
  }
  async function generate() {
    const picked = document.querySelector('input[name=vcVoice]:checked');
    const text = $v('vcScript').value.trim();
    if (!picked) throw new Error('ເພີ່ມ ຫຼື ເລືອກພຣີເຊັດສຽງກ່ອນ');
    if (!text) throw new Error('ວາງສະຄຣິບກ່ອນ');
    say('');
    $v('vcGo').disabled = true;
    $v('vcResult').classList.add('hidden');
    $v('vcJob').classList.remove('hidden');
    $v('vcJobText').textContent = 'ກຳລັງກຽມ...';
    const { job } = await call('/api/voice/generate', { voice: picked.value, text, speed: Number($v('vcSpeed').value) });
    polling = true;
    while (polling) {
      const j = await call(`/api/job/${job}`);
      $v('vcBar').style.width = `${Math.round(j.progress * 100)}%`;
      $v('vcJobText').textContent = j.progress > 0 ? `ກຳລັງພາກສຽງ ${Math.round(j.progress * 100)}%` : 'ກຳລັງໂຫຼດຕົວໂຄຣນສຽງ (ຄັ້ງທຳອິດອາດໃຊ້ເວລາ 1–3 ນາທີ)...';
      if (j.state === 'error') throw new Error(j.error);
      if (j.state === 'done') { lastResult = j.result; break; }
      await new Promise(r => setTimeout(r, 700));
    }
    polling = false;
    $v('vcJob').classList.add('hidden');
    $v('vcGo').disabled = false;
    $v('vcAudio').src = base() + lastResult.url;
    $v('vcDownload').href = `${base()}${lastResult.url}?dl=1`;
    $v('vcDownload').download = lastResult.file;
    $v('vcUse').classList.toggle('hidden', !window.TL);
    $v('vcResult').classList.remove('hidden');
  }
  async function useResult() {
    if (!window.TL) return;
    const blob = await (await fetch(base() + lastResult.url)).blob();
    const file = new File([blob], lastResult.file, { type: 'audio/wav', lastModified: Date.now() });
    const m = await TL.addMedia(file);
    const start = TL.duration() > 0 && TL.time() < TL.duration() ? TL.time() : 0;
    TL.addAudioItem(m, lastResult.file, { start, kind: 'voice', volume: 1 });
    TL.setCaptionsFree(true);
    applyTimedLines(lastResult.lines.map(l => ({ text: l.text, start: l.start + start, end: l.end + start })));
    say('✓ ໃສ່ສຽງພາກ ແລະ ຟ້ອນໃນໄທມ໌ລາຍແລ້ວ', 'good');
  }
  window.VoiceUI = { init() { shell(); refresh(); }, refresh };
})();
