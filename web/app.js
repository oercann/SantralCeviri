(() => {
  const $ = (id) => document.getElementById(id);
  const store = {
    get server() { return localStorage.getItem('server') || location.origin; },
    get token() { return sessionStorage.getItem('token') || localStorage.getItem('token') || ''; },
    save(s, t) { localStorage.setItem('server', s); localStorage.setItem('token', t); },
  };
  let ws = null, myDid = '', partialEl = null;

  const api = async (path, body) => {
    const r = await fetch(store.server.replace(/\/$/, '') + path, {
      method: body ? 'POST' : 'GET',
      headers: { Authorization: 'Bearer ' + store.token, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (r.status === 401) throw new Error('Anahtar hatalı');
    return r.json();
  };

  function setConn(on, label) {
    const el = $('conn');
    el.className = 'pill ' + (on ? 'on' : 'off');
    el.textContent = label || (on ? 'bağlı' : 'bağlı değil');
  }

  function showMain(show) {
    $('setup').classList.toggle('hidden', show);
    $('dialer').classList.toggle('hidden', !show);
    $('transcript').classList.toggle('hidden', !show);
    $('typebox').classList.toggle('hidden', !show);
  }

  function addLine(t) {
    const box = $('lines');
    if (t.type === 'speaking') {
      if (partialEl) partialEl.remove();
      partialEl = document.createElement('div');
      partialEl.className = 'line partial ' + t.speaker;
      partialEl.textContent = t.speaker === 'user' ? 'Sen konuşuyorsun…' : 'Karşı taraf konuşuyor…';
      box.appendChild(partialEl);
    } else if (t.type === 'partial') {
      if (!partialEl) { partialEl = document.createElement('div'); partialEl.className = 'line partial ' + t.speaker; box.appendChild(partialEl); }
      if (partialEl.dataset.started !== '1') { partialEl.textContent = ''; partialEl.dataset.started = '1'; }
      partialEl.textContent += t.text;
    } else if (t.type === 'final') {
      if (partialEl) { partialEl.remove(); partialEl = null; }
      const el = document.createElement('div');
      el.className = 'line ' + t.speaker;
      el.dataset.orig = t.text;
      el.innerHTML = `<div class="orig"></div><div class="tr">…</div>`;
      el.querySelector('.orig').textContent = t.text;
      box.appendChild(el);
    } else if (t.type === 'translated') {
      const els = box.querySelectorAll('.line.' + t.speaker);
      const el = [...els].reverse().find((e) => e.dataset.orig === t.original) || els[els.length - 1];
      if (el) el.querySelector('.tr').textContent = t.text;
    } else if (t.type === 'error') {
      const el = document.createElement('div');
      el.className = 'line error'; el.textContent = t.text; box.appendChild(el);
    }
    box.scrollTop = box.scrollHeight;
    window.scrollTo(0, document.body.scrollHeight);
  }

  const STATES = { idle: 'Beklemede', init: 'Hazırlanıyor', auth: 'PIN bekleniyor', 'dialing-prompt': 'Numara bekleniyor', ringing: 'Aranıyor…', connected: 'Görüşme sürüyor — Türkçe konuş', ended: 'Görüşme bitti' };

  function connectWs() {
    if (ws) { ws.onclose = null; ws.close(); }
    const base = store.server.replace(/^http/, 'ws').replace(/\/$/, '');
    ws = new WebSocket(`${base}/ws?token=${encodeURIComponent(store.token)}`);
    ws.onopen = () => setConn(true);
    ws.onclose = () => { setConn(false); setTimeout(connectWs, 3000); };
    ws.onmessage = (m) => {
      const ev = JSON.parse(m.data);
      if (ev.type === 'status') {
        $('state').textContent = STATES[ev.state] || ev.state;
        if (ev.target) $('hint').textContent = 'Hedef: ' + ev.target;
        if (ev.state === 'init') $('lines').innerHTML = '';
      } else if (ev.type === 'transcript') addLine(ev);
      else if (ev.type === 'ended') { $('state').textContent = 'Görüşme bitti (' + ev.reason + ')'; }
    };
  }

  async function init() {
    $('server').value = store.server;
    $('token').value = store.token;
    if (!store.token) return showMain(false);
    try {
      const st = await api('/api/status');
      myDid = st.myDid || '';
      $('callme').href = 'tel:' + myDid;
      $('state').textContent = STATES[st.state] || st.state;
      if (st.target) $('hint').textContent = 'Hedef: ' + st.target;
      showMain(true);
      connectWs();
    } catch (e) {
      setConn(false, e.message);
      showMain(false);
    }
  }

  $('save').onclick = () => { store.save($('server').value.trim(), $('token').value.trim()); init(); };
  $('dial').onclick = async () => {
    try {
      const r = await api('/api/dial', { number: $('number').value });
      $('hint').textContent = r.error || r.hint;
    } catch (e) { $('hint').textContent = e.message; }
  };
  $('hangup').onclick = () => api('/api/hangup', {}).catch(() => {});
  $('send').onclick = async () => {
    const text = $('typed').value.trim();
    if (!text) return;
    $('typed').value = '';
    await api('/api/say', { text }).catch((e) => addLine({ type: 'error', text: e.message }));
  };
  $('typed').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('send').click(); });

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  init();
})();
