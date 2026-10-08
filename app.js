/* GD Arena client — voice-first UI over a WebSocket (falls back to an in-tab engine). */
(() => {
  'use strict';
  const E = window.GDEngine;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const RM = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const words = t => E.wordsOf(t).length;
  const fmtTime = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

  /* ---------------- storage ---------------- */
  const store = {
    get(k, d) { try { const v = localStorage.getItem('gda:' + k); return v ? JSON.parse(v) : d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem('gda:' + k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
    del(k) { try { localStorage.removeItem('gda:' + k); } catch { /* ignore */ } }
  };

  const params = new URLSearchParams(location.search);
  const WATCH = (params.get('watch') || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

  const A = {
    role: WATCH ? 'viewer' : 'host',
    profile: store.get('profile', null),
    history: store.get('history', []),
    settings: Object.assign({ voices: true, autoSend: true }, store.get('settings', {})),
    room: null, viewers: 0, mode: null, transport: null, latency: null,
    s: null, analysis: null, challenge: null, result: null,
    replaying: false, demo: null, fast: false, viewerAudio: false, loopStep: -1, filter: 'All', pendingTopic: null
  };
  function newSession() {
    return { topic: null, phase: 'r1', round: 1, startedAt: Date.now(), floorOpen: false, turns: 0, readyAt: 0, firstKeyAt: 0, savedId: null, endArmed: false };
  }

  /* ---------------- toasts ---------------- */
  function toast(msg, kind) {
    const t = document.createElement('div');
    t.className = 'toast ' + (kind || ''); t.textContent = msg;
    $('#toasts').appendChild(t);
    setTimeout(() => t.remove(), kind === 'badge' ? 5200 : 3800);
  }

  /* ---------------- router ---------------- */
  const ROUTES = ['home', 'profile', 'topics', 'arena', 'report', 'dashboard'];
  const RENDER = {
    profile: renderProfile, topics: renderTopics, dashboard: renderDashboard,
    arena: () => { const live = !!(A.s && A.s.topic); $('#arena-empty').hidden = live; $('#arena-live').hidden = !live; },
    report: () => { const has = !!(A.analysis || A.result); $('#report-empty').hidden = has; $('#report-live').hidden = !has; }
  };
  function route() {
    let r = location.hash.replace(/^#\/?/, '') || 'home';
    if (!ROUTES.includes(r)) r = 'home';
    if (A.role === 'viewer' && !['home', 'arena', 'report'].includes(r)) r = 'arena';
    $$('.view').forEach(v => { v.hidden = v.dataset.view !== r; });
    $$('#tabs a').forEach(a => a.classList.toggle('on', a.dataset.route === r));
    if (RENDER[r]) RENDER[r]();
    window.scrollTo({ top: 0, behavior: 'auto' });
  }
  function go(r) { if (location.hash !== '#/' + r) location.hash = '#/' + r; else route(); }

  /* ---------------- engine loop visual ---------------- */
  const LOOP = [['Practice', 'GD round 1 with four AI voices'], ['Analyze', 'Score communication behaviour'], ['Identify Weakness', 'Lowest of five core skills'],
    ['Adaptive Challenge', 'Next round rebuilt for it'], ['Improve', 'Measure the change']];
  function renderLoops() {
    $$('[data-loop]').forEach(el => {
      el.innerHTML = LOOP.map((s, i) => `<div class="step" data-i="${i}"><span class="n">0${i + 1}</span><b>${s[0]}</b><span>${s[1]}</span></div>`).join('')
        + (el.classList.contains('big') ? '<div class="back"><em>Repeat with the next weakness</em></div>' : '');
    });
    setLoop(A.loopStep);
  }
  function setLoop(i) {
    A.loopStep = i;
    $$('[data-loop]:not(.big) .step').forEach(s => { const k = +s.dataset.i; s.classList.toggle('done', k < i); s.classList.toggle('active', k === i); });
  }
  let bigStep = 0;
  setInterval(() => {
    if (RM) return;
    bigStep = (bigStep + 1) % 5;
    $$('[data-loop].big .step').forEach(s => { const k = +s.dataset.i; s.classList.toggle('done', k < bigStep); s.classList.toggle('active', k === bigStep); });
  }, 1700);

  /* ---------------- transport ---------------- */
  function setConn(kind, text) {
    const c = $('#conn'); c.className = 'conn ' + kind;
    $('#conn-text').textContent = text || ({ live: 'Live · WebSocket', local: 'Offline mode', down: 'Disconnected' }[kind] || 'Connecting…');
    c.title = kind === 'local' ? 'No server found, so the engine runs inside this tab. Run node server.js for WebSockets and live viewers.' : 'WebSocket connection to the GD Arena server';
    renderNet();
  }
  function send(m) { if (A.transport) A.transport.send(m); }

  class WSTransport {
    constructor() { this.q = []; this.tries = 0; this.ws = null; }
    url() { return (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws'; }
    connect() {
      return new Promise((resolve, reject) => {
        let ok = false;
        const ws = new WebSocket(this.url()); this.ws = ws;
        const timer = setTimeout(() => { if (!ok) { try { ws.close(); } catch { /* */ } reject(new Error('timeout')); } }, 3000);
        ws.onopen = () => {
          ok = true; clearTimeout(timer); this.tries = 0; setConn('live');
          ws.send(JSON.stringify(A.role === 'viewer' ? { t: 'hello', role: 'viewer', room: WATCH } : { t: 'hello', role: 'host', room: A.room, name: A.profile && A.profile.name }));
          this.q.splice(0).forEach(m => ws.send(m));
          resolve();
        };
        ws.onmessage = e => { let m; try { m = JSON.parse(e.data); } catch { return; } onEvent(m); };
        ws.onclose = () => { if (!ok) { clearTimeout(timer); reject(new Error('closed')); return; } setConn('down', 'Reconnecting…'); this.reconnect(); };
        ws.onerror = () => {};
      });
    }
    reconnect() {
      if (this.tries > 8) { setConn('down', 'Disconnected'); toast('Lost the connection to the server. Refresh to try again.', 'bad'); return; }
      const d = Math.min(8000, 500 * 2 ** this.tries++);
      setTimeout(() => this.connect().catch(() => this.reconnect()), d);
    }
    send(m) {
      const s = JSON.stringify(m);
      if (this.ws && this.ws.readyState === 1) this.ws.send(s);
      else if (m.t !== 'interim') this.q.push(s);
    }
  }
  class LocalTransport {
    constructor() { this.session = null; }
    connect() { setConn('local'); setTimeout(() => onEvent({ t: 'welcome', role: 'host', room: null, local: true }), 0); return Promise.resolve(); }
    send(m) {
      const emit = ev => setTimeout(() => onEvent(ev), 0);
      if (m.t === 'ping') return emit({ t: 'pong', ts: m.ts });
      if (m.t === 'hello') return;
      if (m.t === 'start') {
        if (this.session) this.session.dispose();
        this.session = new E.Session({ topicId: m.topicId, profile: m.profile, idle: m.idle !== false, emit });
        emit({ t: 'reset' }); this.session.handle({ t: 'start' }); return;
      }
      if (this.session) this.session.handle(m);
    }
  }
  async function connect() {
    const httpish = /^https?:$/.test(location.protocol);
    if (A.role === 'viewer') {
      if (!httpish) { $('#viewer-text').textContent = 'Live view needs the GD Arena server.'; return; }
      A.transport = new WSTransport(); A.mode = 'ws';
      try { await A.transport.connect(); } catch { setConn('down'); $('#viewer-text').textContent = 'Could not reach the GD Arena server for this live room.'; }
      return;
    }
    if (httpish) {
      const ws = new WSTransport();
      try { await ws.connect(); A.transport = ws; A.mode = 'ws'; return; } catch { /* fall through to local */ }
    }
    A.transport = new LocalTransport(); A.mode = 'local';
    await A.transport.connect();
  }
  setInterval(() => { if (A.mode === 'ws') send({ t: 'ping', ts: Date.now() }); }, 5000);
  function renderNet() {
    const n = $('#net'); if (!n) return;
    if (A.mode === 'ws') n.textContent = `WebSocket${A.room ? ' · room ' + A.room : ''}${A.latency != null ? ' · ' + A.latency + ' ms' : ''}`;
    else if (A.mode === 'local') n.textContent = 'Offline mode · engine running in this tab';
    else n.textContent = '';
  }

  /* ---------------- voice out (TTS) ---------------- */
  const TTS = {
    ok: 'speechSynthesis' in window, voices: [], map: {}, token: 0, busy: false,
    init() {
      if (!this.ok) return;
      const load = () => { this.voices = speechSynthesis.getVoices().filter(v => /^en/i.test(v.lang)); this.assign(); };
      load(); speechSynthesis.onvoiceschanged = load;
    },
    assign() {
      const F = /female|samantha|victoria|karen|moira|tessa|veena|heera|zira|susan|fiona|serena|aria|jenny|neerja|kate|libby|sonia|natasha|google us english/i;
      const M = /\bmale\b|daniel|alex|rishi|ravi|david|mark|george|guy|prabhat|fred|arthur|oliver|ryan|thomas|aaron/i;
      const rank = v => (v.lang === 'en-IN' ? 0 : /en-GB/i.test(v.lang) ? 1 : 2);
      const all = [...this.voices].sort((a, b) => rank(a) - rank(b));
      const fem = all.filter(v => F.test(v.name));
      const male = all.filter(v => M.test(v.name) && !/female/i.test(v.name));
      const other = all.filter(v => !fem.includes(v) && !male.includes(v));
      const pick = (...c) => c.find(Boolean) || all[0] || null;
      this.map = {
        aarav: pick(male[0], other[0]), kabir: pick(male[1], other[1], male[0]),
        riya: pick(fem[0], other[2], other[0]), meera: pick(fem[1], fem[0], other[3]),
        student: pick(other.find(v => ![male[0], male[1], fem[0], fem[1]].includes(v)), male[2], fem[2], all[all.length - 1])
      };
    },
    unlock() { if (!this.ok) return; try { const u = new SpeechSynthesisUtterance(' '); u.volume = 0; speechSynthesis.speak(u); } catch { /* */ } },
    chunks(text) { return (String(text).match(/[^.!?]+[.!?]*/g) || [text]).map(s => s.trim()).filter(Boolean); },
    speak(pid, text, onstart) {
      if (!this.ok) return Promise.resolve();
      const tok = ++this.token; this.busy = true;
      const v = this.map[pid]; const P = E.PARTICIPANTS[pid];
      const conf = P ? P.voice : { pitch: 1, rate: 1.03 };
      const parts = this.chunks(text);
      return new Promise(resolve => {
        let i = 0, started = false;
        const done = () => { if (tok === this.token) this.busy = false; resolve(); };
        const next = () => {
          if (tok !== this.token) return done();
          if (i >= parts.length) return done();
          const u = new SpeechSynthesisUtterance(parts[i++]);
          if (v) { u.voice = v; u.lang = v.lang; }
          u.pitch = conf.pitch; u.rate = conf.rate;
          const safety = setTimeout(next, 1800 + words(u.text) * 520);
          u.onstart = () => { if (!started) { started = true; if (onstart) onstart(); } };
          u.onend = u.onerror = () => { clearTimeout(safety); next(); };
          speechSynthesis.speak(u);
        };
        next();
      });
    },
    cancel() { this.token++; this.busy = false; if (this.ok) speechSynthesis.cancel(); }
  };

  /* ---------------- voice in (STT + mic meter) ---------------- */
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const Mic = {
    on: false, stopping: false, finals: '', interim: '', startedAt: 0, voicedMs: 0, pauses: 0, firstSpeechAt: 0, lastSend: 0,
    rec: null, stream: null, ctx: null, raf: 0, noMeter: false, finishFn: null,
    available() { return !!SR && window.isSecureContext; },
    reason() {
      if (!SR) return 'Voice input needs Chrome or Edge. You can still type your responses.';
      if (!window.isSecureContext) return 'Voice input needs localhost or HTTPS. Open the app at http://localhost:3000.';
      return '';
    },
    text() { return (this.finals + ' ' + this.interim).replace(/\s+/g, ' ').trim(); },
    start() {
      if (this.on) return;
      if (!this.available()) { toast(this.reason(), 'bad'); return; }
      TTS.cancel();
      Object.assign(this, { on: true, stopping: false, finals: '', interim: '', voicedMs: 0, pauses: 0, firstSpeechAt: 0, startedAt: performance.now(), startWall: Date.now(), noMeter: false });
      send({ t: 'speaking', on: true });
      const rec = new SR(); this.rec = rec;
      rec.lang = (A.profile && A.profile.lang) || 'en-IN'; rec.continuous = true; rec.interimResults = true;
      rec.onresult = e => {
        let inter = '';
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const r = e.results[i];
          if (r.isFinal) this.finals += (this.finals ? ' ' : '') + r[0].transcript.trim();
          else inter += r[0].transcript;
        }
        this.interim = inter.trim();
        if (!this.firstSpeechAt) this.firstSpeechAt = Date.now();
        showLive('You', this.text() || 'Listening…');
        const now = Date.now();
        if (now - this.lastSend > 280) { this.lastSend = now; send({ t: 'interim', text: this.text() }); }
      };
      rec.onerror = e => {
        if (e.error === 'no-speech' || e.error === 'aborted') return;
        const msg = {
          'not-allowed': 'Microphone access was blocked. Allow it from the address bar, or type your response.',
          'service-not-allowed': 'Speech recognition is blocked in this browser. Type your response instead.',
          'network': 'Chrome’s speech recognition needs an internet connection. Type your response instead.',
          'audio-capture': 'No microphone was found.'
        }[e.error] || 'Speech recognition stopped: ' + e.error;
        toast(msg, 'bad'); this.stop(true).then(r => r);
      };
      rec.onend = () => {
        if (this.on && !this.stopping) { try { rec.start(); } catch { /* restarting too fast */ } }
        else if (this.finishFn) this.finishFn();
      };
      try { rec.start(); } catch { toast('Could not start speech recognition.', 'bad'); this.on = false; send({ t: 'speaking', on: false }); return; }
      uiRecording(true);
      showLive('You', 'Listening…');
      this.meter();
    },
    async meter() {
      try {
        this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
        if (!this.on) { this.stream.getTracks().forEach(t => t.stop()); return; }
        const ctx = new (window.AudioContext || window.webkitAudioContext)(); this.ctx = ctx;
        const an = ctx.createAnalyser(); an.fftSize = 1024;
        ctx.createMediaStreamSource(this.stream).connect(an);
        const buf = new Float32Array(an.fftSize);
        const cv = $('#wave'), g = cv.getContext('2d');
        let last = performance.now(), silentSince = null, spoke = false;
        const loop = now => {
          if (!this.on) return;
          an.getFloatTimeDomainData(buf);
          let sum = 0; for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
          const rms = Math.sqrt(sum / buf.length), dt = now - last; last = now;
          const voiced = rms > 0.018;
          if (voiced) {
            this.voicedMs += dt;
            if (!this.firstSpeechAt) this.firstSpeechAt = Date.now();
            if (silentSince && spoke && now - silentSince > 1500) this.pauses++;
            silentSince = null; spoke = true;
          } else if (!silentSince) silentSince = now;
          drawWave(g, cv, buf, voiced);
          this.raf = requestAnimationFrame(loop);
        };
        this.raf = requestAnimationFrame(loop);
      } catch { this.noMeter = true; }
    },
    stop(discard) {
      if (!this.on) return Promise.resolve(null);
      this.stopping = true;
      return new Promise(resolve => {
        let finished = false;
        const finish = () => {
          if (finished) return; finished = true; this.finishFn = null;
          cancelAnimationFrame(this.raf);
          if (this.stream) this.stream.getTracks().forEach(t => t.stop());
          if (this.ctx) this.ctx.close().catch(() => {});
          this.stream = null; this.ctx = null;
          const dur = Math.round(performance.now() - this.startedAt);
          const out = { text: this.text(), durationMs: dur, voicedMs: Math.round(this.noMeter ? dur : this.voicedMs), pauses: this.pauses, firstSpeechAt: this.firstSpeechAt || this.startWall };
          this.on = false; this.stopping = false;
          uiRecording(false); hideLive();
          send({ t: 'speaking', on: false });
          resolve(discard ? null : out);
        };
        this.finishFn = finish;
        try { this.rec.stop(); } catch { finish(); }
        setTimeout(finish, 1300);
      });
    }
  };
  function drawWave(g, cv, buf, voiced) {
    const w = cv.width, h = cv.height;
    g.clearRect(0, 0, w, h);
    g.strokeStyle = voiced ? '#F4B547' : '#666A82'; g.lineWidth = 2; g.beginPath();
    const step = Math.floor(buf.length / w);
    for (let x = 0; x < w; x++) { const y = h / 2 + buf[x * step] * h * 1.6; x ? g.lineTo(x, y) : g.moveTo(x, y); }
    g.stroke();
  }
  function uiRecording(on) {
    const b = $('#speak'); b.classList.toggle('rec', on);
    $('#speak-label').textContent = on ? (A.settings.autoSend ? 'Stop & send' : 'Stop') : 'Speak';
  }
  function showLive(who, text) { $('#live-line').hidden = false; $('#live-who').textContent = who; $('#live-text').textContent = text; }
  function hideLive() { $('#live-line').hidden = true; }

  /* ---------------- event dispatcher ---------------- */
  function onEvent(ev) {
    const h = HANDLERS[ev.t];
    if (h) { try { h(ev); } catch (e) { console.error('event', ev.t, e); } }
  }
  const HANDLERS = {
    welcome(ev) {
      A.room = ev.room || null; renderNet(); renderShare();
      if (ev.role === 'viewer') {
        A.replaying = ev.replay > 0; A.hostName = ev.host;
        $('#viewer-text').textContent = `Watching ${ev.host || 'a'}’s live GD room ${ev.room}. Read-only.`;
        go('arena');
      }
    },
    presence(ev) {
      A.viewers = ev.viewers; renderShare();
      if (A.role === 'viewer' && !ev.hostOnline) $('#viewer-text').textContent = 'The host is offline. This view will update when they return.';
    },
    'replay-done'() { A.replaying = false; },
    'host-left'() { if (A.role === 'viewer') $('#viewer-text').textContent = 'The host disconnected.'; },
    pong(ev) { A.latency = Date.now() - ev.ts; renderNet(); },
    error(ev) { toast(ev.msg, 'bad'); if (ev.fatal && A.role === 'viewer') $('#viewer-text').textContent = ev.msg; },
    reset() {
      TTS.cancel();
      A.s = newSession();
      A.analysis = A.challenge = A.result = null;
      $('#feed').innerHTML = ''; $('#challenge').hidden = true; hideLive();
      renderMetrics({ speakingSec: 0, speakingEstimated: true, contributions: 0, arguments: 0, counters: 0, examples: 0, share: 0, wpm: null, fillers: 0, hedges: 0 });
      $('#perf-src').textContent = 'Waiting';
      $('#end').hidden = false; $('#end').textContent = 'End Discussion';
      setLoop(0);
    },
    session(ev) {
      if (!A.s) A.s = newSession();
      A.s.topic = ev.topic; A.s.round = 1; A.s.phase = 'r1'; A.s.startedAt = Date.now();
      $('#arena-title').textContent = ev.topic.title;
      $('#round-chip').textContent = 'Round 1 · Open discussion'; $('#round-chip').className = 'chip';
      $('#rep-topic').textContent = ev.topic.title;
      renderPeople(ev.participants);
      addSys('Round 1 · Open discussion · 5 participants');
      $('#perf-src').textContent = 'Live';
      setComposer();
      if (location.hash !== '#/arena') go('arena'); else RENDER.arena();
    },
    typing(ev) {
      if (!A.s) return; A.s.floorOpen = false;
      setCard(ev.pid, 'thinking');
      if (!$(`#feed .msg.typing-${ev.pid}`)) addAI(ev.pid, null);
    },
    say(ev) {
      if (!A.s) return; A.s.floorOpen = false;
      const el = $(`#feed .msg.typing-${ev.pid}`) || addAI(ev.pid, null);
      el.classList.remove('typing-' + ev.pid); el.dataset.id = ev.id;
      if (ev.kind === 'challenge') el.classList.add('challenge-line');
      $('.bubble', el).textContent = ev.text;
      scrollFeed();
      playSay(ev, el);
    },
    floor() { if (!A.s) return; A.s.floorOpen = true; $$('.pcard').forEach(c => { if (!c.classList.contains('speaking')) setCard(c.dataset.pid, 'idle'); }); setComposer(); },
    bargein() { TTS.cancel(); },
    nudge(ev) { if (A.s && A.s.phase === 'r1') addSys(ev.text, 'nudge'); },
    live(ev) {
      if (A.role === 'viewer' && ev.interim) showLive(A.hostName || 'Speaker', ev.interim);
      if (ev.metrics) renderMetrics(ev.metrics);
    },
    user(ev) {
      if (!A.s) return;
      A.s.turns++; A.s.floorOpen = false;
      if (A.role === 'viewer') hideLive();
      addUser(ev.text, ev.mode, ev.by);
      setComposer();
    },
    metrics(ev) { renderMetrics(ev.metrics); },
    analysis(ev) {
      if (!A.s) A.s = newSession();
      A.analysis = ev; A.s.phase = 'analysis';
      TTS.cancel(); setComposer();
      addSys('Round 1 ended · analysing');
      renderAnalysis(ev);
      go('report');
    },
    challenge(ev) {
      if (!A.s) return;
      A.challenge = ev; A.s.phase = 'r2wait'; A.s.round = ev.round; A.s.firstKeyAt = 0;
      renderChallenge(ev);
      addSys(`Round ${ev.round} · Challenge Mode · ${ev.skillName}`, 'hot');
      setLoop(3); setComposer();
      go('arena');
    },
    'challenge:ready'(ev) {
      if (!A.s) return;
      A.s.phase = 'r2'; A.s.readyAt = Date.now();
      setComposer();
      if (ev.timed) startCountdown(ev.timed);
      if (A.role === 'host' && !A.demo) $('#answer').focus({ preventScroll: true });
    },
    result(ev) {
      if (!A.s) A.s = newSession();
      A.result = ev; A.s.phase = 'result';
      stopCountdown(); setComposer();
      if (A.role === 'host' && !ev.replay) saveResult(ev);
      renderResult(ev);
      setLoop(4);
      go('report');
    }
  };

  async function playSay(ev, el) {
    const speakIt = A.role === 'host' ? (A.settings.voices && !A.fast) : (A.viewerAudio && !ev.replay && !A.replaying);
    if (ev.replay) return;
    if (speakIt && TTS.ok) {
      await TTS.speak(ev.pid, ev.text, () => { setCard(ev.pid, 'speaking'); el.classList.add('speaking'); });
    } else {
      setCard(ev.pid, 'speaking'); el.classList.add('speaking');
      await sleep(A.fast ? 300 + words(ev.text) * 25 : Math.min(5000, 900 + words(ev.text) * 140));
    }
    el.classList.remove('speaking'); setCard(ev.pid, 'idle');
    if (A.role === 'host') send({ t: 'tts:done', id: ev.id });
  }

  /* ---------------- arena rendering ---------------- */
  function renderPeople(list) {
    $('#people').innerHTML = list.map(p => `
      <div class="pcard" data-pid="${p.id}" style="--c:${p.color}">
        <div class="top"><span class="av">${esc(p.name[0])}</span><div class="who"><b>${esc(p.name)}</b><span>${esc(p.role)}</span></div></div>
        <p>${esc(p.trait)}</p>
        <div class="state"><span class="eq"><i></i><i></i><i></i><i></i></span><span class="st">Listening</span></div>
      </div>`).join('') + `
      <div class="pcard you" data-pid="you" style="--c:var(--accent)">
        <div class="top"><span class="av you">You</span><div class="who"><b>${esc((A.role === 'host' ? A.profile && A.profile.name : A.hostName) || 'Candidate')}</b><span>Candidate</span></div></div>
        <p>Speak or type. You can interrupt anyone.</p>
        <div class="state"><span class="eq"><i></i><i></i><i></i><i></i></span><span class="st">Your turn when ready</span></div>
      </div>`;
  }
  function setCard(pid, state) {
    const c = $(`.pcard[data-pid="${pid}"]`); if (!c) return;
    c.classList.toggle('speaking', state === 'speaking'); c.classList.toggle('thinking', state === 'thinking');
    const st = $('.st', c); if (st) st.textContent = state === 'speaking' ? 'Speaking' : state === 'thinking' ? 'Thinking…' : (pid === 'you' ? 'Your turn when ready' : 'Listening');
  }
  function scrollFeed() { const f = $('#feed'); f.scrollTop = f.scrollHeight; }
  function addSys(text, kind) { const d = document.createElement('div'); d.className = 'sys ' + (kind || ''); d.textContent = text; $('#feed').appendChild(d); scrollFeed(); }
  function addAI(pid, text) {
    const p = E.PARTICIPANTS[pid];
    const d = document.createElement('div');
    d.className = 'msg ai' + (text == null ? ' typing-' + pid : ''); d.style.setProperty('--c', p.color);
    d.innerHTML = `<span class="av" style="--c:${p.color}">${esc(p.name[0])}</span><div><div class="meta-l"><b>${esc(p.name)}</b><span>${esc(p.role)}</span></div><div class="bubble">${text == null ? '<span class="typing"><i></i><i></i><i></i></span>' : esc(text)}</div></div>`;
    $('#feed').appendChild(d); scrollFeed(); return d;
  }
  function addUser(text, mode, by) {
    const d = document.createElement('div'); d.className = 'msg you';
    d.innerHTML = `<div class="body"><div class="meta-l"><i>${mode === 'voice' ? 'Spoken' : 'Typed'}</i><b>${esc(by || 'You')}</b></div><div class="bubble">${esc(text)}</div></div><span class="av you">You</span>`;
    $('#feed').appendChild(d); scrollFeed();
  }
  let lastM = {};
  function renderMetrics(m) {
    if (!m) return;
    const set = (id, v, key) => { const el = $('#' + id); const prev = lastM[key]; el.textContent = v; const stat = el.closest('.stat'); if (stat && prev != null && m[key] > prev) { stat.classList.add('bump'); setTimeout(() => stat.classList.remove('bump'), 900); } };
    set('m-time', fmtTime(m.speakingSec || 0), 'speakingSec');
    $('#m-time-s').textContent = m.contributions ? (m.speakingEstimated ? 'estimated from typed words' : 'measured from your voice') : '—';
    set('m-contrib', m.contributions, 'contributions');
    set('m-args', m.arguments, 'arguments');
    set('m-counter', m.counters, 'counters');
    set('m-ex', m.examples, 'examples');
    $('#m-wpm').textContent = m.wpm || '—';
    $('#m-wpm-s').textContent = m.wpm ? (m.wpm < 105 ? 'a little slow' : m.wpm > 175 ? 'a little fast' : 'comfortable pace') : 'speak to measure';
    $('#m-share').textContent = m.share + '%';
    $('#m-share-bar').style.width = Math.min(100, m.share) + '%';
    $('#m-share-s').textContent = m.share < 12 ? 'Below your fair share. Get into the discussion.' : m.share > 40 ? 'You are dominating. Leave room for others.' : 'Healthy share for a group of five.';
    $('#m-fill').textContent = (m.fillers || 0) + (m.hedges || 0);
    lastM = { ...m };
  }
  function setComposer() {
    const host = A.role === 'host', s = A.s;
    const phase = s ? s.phase : 'none';
    const active = host && (phase === 'r1' || phase === 'r2');
    $('#answer').disabled = !active; $('#submit').disabled = !active;
    $('#speak').disabled = !active || !Mic.available();
    $('#end').disabled = !(host && phase === 'r1');
    $('#end').hidden = phase !== 'r1' && phase !== 'none';
    $('#answer').placeholder = phase === 'r2wait' ? 'Listen to the challenge…' : phase === 'r2' ? 'Type or speak your response to the challenge…' : phase === 'r1' ? 'Type your response…' : 'Discussion closed';
    $('#mic-note').textContent = Mic.available() ? 'Tip: click Speak anytime, even while someone else is talking.' : Mic.reason();
    if (!active && Mic.on) Mic.stop(true);
  }
  function renderChallenge(ch) {
    $('#round-chip').textContent = `Round ${ch.round} · Challenge Mode`; $('#round-chip').className = 'chip hot';
    $('#ch-chip').textContent = `Challenge Mode · ${ch.skillName}`;
    $('#ch-base').textContent = `Baseline ${ch.baseline}`;
    $('#ch-task').textContent = ch.task;
    $('#ch-moves').innerHTML = (ch.moves || []).map((m, i) => `<button type="button" data-ins="${esc(m[1])}"><b>${i + 1}</b>${esc(m[0])}</button>`).join('');
    $('#ch-count').hidden = !ch.timed; $('#ch-count').textContent = ch.timed || '';
    $('#challenge').hidden = false;
  }
  let cdTimer = 0;
  function startCountdown(sec) {
    stopCountdown(); const el = $('#ch-count'); el.hidden = false; el.classList.remove('late');
    const end = Date.now() + sec * 1000;
    cdTimer = setInterval(() => {
      const left = Math.ceil((end - Date.now()) / 1000);
      if (left <= 0) { el.textContent = 'Late'; el.classList.add('late'); stopCountdown(); return; }
      el.textContent = left;
    }, 250);
  }
  function stopCountdown() { clearInterval(cdTimer); }
  setInterval(() => {
    if (A.s && A.s.topic && (A.s.phase === 'r1' || A.s.phase === 'r2' || A.s.phase === 'r2wait')) {
      const s = (Date.now() - A.s.startedAt) / 1000; $('#timer').textContent = fmtTime(s);
    }
  }, 1000);
  function renderShare() {
    const b = $('#share'); if (!b) return;
    const ok = A.mode === 'ws' && A.room;
    b.disabled = !ok;
    b.title = ok ? 'Let others watch this discussion live' : 'Live view needs the WebSocket server (run node server.js)';
    $('#share-url').value = ok ? `${location.origin}${location.pathname}?watch=${A.room}` : '';
    $('#watchers').textContent = `${A.viewers} watching`;
    b.textContent = A.viewers ? `Share live view · ${A.viewers} watching` : 'Share live view';
  }

  /* ---------------- turns ---------------- */
  function sendTurn(text, voice) {
    if (!A.s) return;
    if (A.s.phase === 'r1') {
      A.s.floorOpen = false;
      send(Object.assign({ t: 'turn', text, mode: voice ? 'voice' : 'text' }, voice || {}));
    } else if (A.s.phase === 'r2') {
      const startAt = voice ? (voice.firstSpeechAt || Date.now()) : (A.s.firstKeyAt || Date.now());
      send(Object.assign({ t: 'challenge:submit', text, mode: voice ? 'voice' : 'text', latencyMs: Math.max(0, startAt - A.s.readyAt) }, voice || {}));
    }
  }
  let pendingVoice = null;
  function submitTyped() {
    const ta = $('#answer'); const text = ta.value.trim();
    if (words(text) < 3) { toast('Say a little more: at least one full sentence.', 'bad'); ta.focus(); return; }
    sendTurn(text, pendingVoice); pendingVoice = null;
    ta.value = ''; updateWC();
  }
  async function toggleMic() {
    if (!Mic.on) { Mic.start(); return; }
    const r = await Mic.stop(false);
    if (!r) return;
    if (words(r.text) < 3) { toast('I did not catch enough. Try again, or type your response.', 'bad'); return; }
    if (A.settings.autoSend) sendTurn(r.text, r);
    else { const ta = $('#answer'); ta.value = (ta.value ? ta.value + ' ' : '') + r.text; pendingVoice = r; updateWC(); ta.focus(); }
  }
  function updateWC() { $('#wc').textContent = `${words($('#answer').value)} words`; }

  /* ---------------- report rendering ---------------- */
  function barHTML(name, value, color, cls) {
    return `<div class="bar ${cls || ''}"><span class="lbl">${esc(name)}</span><div class="track"><i style="--c:${color || 'var(--accent)'}" data-w="${value}"></i></div><span class="val mono">${value}</span></div>`;
  }
  function animateBars(root) { requestAnimationFrame(() => requestAnimationFrame(() => $$('.track i[data-w]', root).forEach(i => { i.style.width = i.dataset.w + '%'; }))); }
  const SKILL_COLOR = { content: '#7AA8FF', reasoning: '#B79CFF', evidence: '#43D9B0', counter: '#FF8A5C', leadership: '#F4B547', participation: '#5CCFF0', communication: '#E7A6FF', confidence: '#FFD166', listening: '#8FE3CF' };
  function countUp(el, from, to, ms) {
    if (RM) { el.textContent = to; return; }
    const t0 = performance.now();
    const step = now => { const p = Math.min(1, (now - t0) / ms), e = 1 - Math.pow(1 - p, 3); el.textContent = Math.round(from + (to - from) * e); if (p < 1) requestAnimationFrame(step); };
    requestAnimationFrame(step);
  }

  async function renderAnalysis(ev) {
    $('#report-empty').hidden = true; $('#report-live').hidden = false;
    $('#analysis').hidden = false; $('#result').hidden = true;
    $('#scanning').hidden = false; $('#weak-body').hidden = true;
    const order = ['content', 'reasoning', 'evidence', 'counter', 'leadership', 'participation', 'communication', 'confidence', 'listening'];
    $('#r1-bars').innerHTML = order.map(k => barHTML(E.SKILLS[k].name, ev.scores[k], SKILL_COLOR[k], k === ev.weakness ? 'is-weak' : '')).join('');
    $('#r1-overall').textContent = `Overall ${ev.report.overall}`;
    const rules = ev.rules.slice().sort((a, b) => (b.skill === ev.weakness) - (a.skill === ev.weakness) || b.hit - a.hit);
    $('#rules').innerHTML = rules.map(r => `<li class="${r.hit ? 'hit' : ''} ${r.skill === ev.weakness ? 'top' : ''}"><span class="ic">${r.hit ? '!' : '✓'}</span><span>${esc(r.label)} → ${esc(E.SKILLS[r.skill].name)}<em>${esc(r.detail)}${r.skill === ev.weakness ? ' · lowest score, chosen as the weakness' : ''}</em></span><small>${ev.scores[r.skill]}</small></li>`).join('');
    setLoop(1);
    const steps = ['Analysing communication behaviour…', 'Detecting arguments, rebuttals and examples…', 'Checking five weakness rules…'];
    for (const s of steps) { $('#scan-text').textContent = s; await sleep(ev.replay ? 0 : 650); }
    $('#scanning').hidden = true; $('#weak-body').hidden = false;
    $('#weak-title').textContent = ev.label;
    $('#weak-exp').textContent = ev.explanation;
    animateBars($('#analysis'));
    setLoop(2);
  }

  function renderResult(ev) {
    $('#report-empty').hidden = true; $('#report-live').hidden = false;
    $('#analysis').hidden = true; $('#result').hidden = false;
    const d = ev.delta;
    $('#delta').classList.toggle('neg', d <= 0);
    $('#d-skill').textContent = `${ev.skillName} · Round 1 vs Challenge Mode`;
    $('#d-before').textContent = ev.before; $('#d-after').textContent = ev.before;
    const st = $('#stamp'); st.classList.remove('show');
    st.textContent = d > 0 ? `+${d} IMPROVEMENT` : d === 0 ? 'NO CHANGE YET' : `${d} THIS ROUND`;
    setTimeout(() => countUp($('#d-after'), ev.before, ev.after, 1200), 300);
    setTimeout(() => st.classList.add('show'), RM ? 0 : 1500);
    $('#ev-b-note').textContent = ev.evidenceBefore.note; $('#ev-a-note').textContent = ev.evidenceAfter.note;
    const qs = a => a.length ? a.map(x => `<q>${esc(x)}</q>`).join('') : '<span class="small muted">No signals found</span>';
    $('#ev-b').innerHTML = qs(ev.evidenceBefore.found); $('#ev-a').innerHTML = qs(ev.evidenceAfter.found);

    const who = A.role === 'host' && A.profile && A.profile.name ? `${A.profile.name}’s report` : 'Performance report';
    $('#rep-name').textContent = who;
    $('#rep-meta').textContent = `${ev.topic.title} · ${new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}${A.profile && A.profile.target && A.role === 'host' ? ' · Target: ' + A.profile.target : ''}`;
    $('#o-num').textContent = '0'; countUp($('#o-num'), 0, ev.report.overall, 1200);
    const ring = $('#o-val'); ring.style.strokeDashoffset = 314.16;
    requestAnimationFrame(() => requestAnimationFrame(() => { ring.style.strokeDashoffset = 314.16 * (1 - ev.report.overall / 100); }));
    $('#rep-bars').innerHTML = ev.report.bars.map(b => barHTML(b.name, b.value, SKILL_COLOR[b.key], b.key === ev.skill && d > 0 ? 'up' : '')).join('');
    $('#strengths').innerHTML = ev.report.strengths.map(s => `<li>${esc(s)}</li>`).join('');
    $('#improve').innerHTML = ev.report.improve.map(s => `<li>${esc(s)}</li>`).join('');

    const dna = ev.dna;
    $('#dna-top').textContent = dna.top;
    const code = { critical: 'CT', collab: 'CO', leader: 'LE', persuader: 'PE', listener: 'AL' };
    $('#dna-code').textContent = dna.traits.map(t => code[t.key] + t.value).join(' · ');
    $('#dna-bars').innerHTML = dna.traits.map(t => barHTML(t.name, t.value, t.name === dna.top ? 'var(--accent)' : '#9A9DB4')).join('');
    $('#dna-text').textContent = dna.text;
    drawRadar(dna.traits);
    $('#train-next').textContent = `Train my next weakness: ${E.SKILLS[ev.nextWeakness].name}`;
    animateBars($('#result'));
  }
  function drawRadar(traits) {
    const cx = 130, cy = 140, R = 100, n = traits.length;
    const pt = (i, v) => { const a = -Math.PI / 2 + i * 2 * Math.PI / n; return [cx + Math.cos(a) * R * v / 100, cy + Math.sin(a) * R * v / 100]; };
    let g = '';
    [25, 50, 75, 100].forEach(v => { g += `<polygon class="grid" points="${traits.map((t, i) => pt(i, v).map(x => x.toFixed(1)).join(',')).join(' ')}"/>`; });
    traits.forEach((t, i) => { const [x, y] = pt(i, 100); g += `<line class="axis" x1="${cx}" y1="${cy}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}"/>`; });
    g += `<polygon class="shape" points="${traits.map((t, i) => pt(i, t.value).map(x => x.toFixed(1)).join(',')).join(' ')}"/>`;
    traits.forEach((t, i) => { const [x, y] = pt(i, t.value); g += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="4" fill="#F4B547"/>`; });
    traits.forEach((t, i) => {
      const a = -Math.PI / 2 + i * 2 * Math.PI / n, x = cx + Math.cos(a) * (R + 18), y = cy + Math.sin(a) * (R + 18);
      const anchor = Math.abs(Math.cos(a)) < 0.2 ? 'middle' : Math.cos(a) > 0 ? 'start' : 'end';
      const dy = Math.sin(a) < -0.5 ? -8 : Math.sin(a) > 0.5 ? 14 : 0;
      g += `<text x="${x.toFixed(1)}" y="${(y + dy).toFixed(1)}" text-anchor="${anchor}">${esc(t.name)}</text><text class="v" x="${x.toFixed(1)}" y="${(y + dy + 15).toFixed(1)}" text-anchor="${anchor}">${t.value}%</text>`;
    });
    $('#radar').innerHTML = g;
  }

  /* ---------------- history, XP, badges ---------------- */
  const BADGES = [
    { id: 'first', name: 'First Discussion', desc: 'Complete a full GD loop', ic: '1' },
    { id: 'counter', name: 'Counterargument Master', desc: 'Counterargument score of 75+', ic: '⇄' },
    { id: 'confident', name: 'Confident Speaker', desc: 'Confidence 80+ with 2+ spoken turns', ic: '◉' },
    { id: 'leader', name: 'Discussion Leader', desc: 'Leadership score of 75+', ic: '★' },
    { id: 'voice', name: 'Voice Pioneer', desc: '3+ turns spoken aloud', ic: '♪' },
    { id: 'comeback', name: 'Comeback', desc: 'Improve a skill by 15+ in one challenge', ic: '↑' },
    { id: 'evidence', name: 'Evidence Hunter', desc: 'Evidence score of 80+', ic: '§' },
    { id: 'streak', name: 'On a Roll', desc: 'Practise 3 days in a row', ic: '≡' }
  ];
  const LEVELS = ['Rookie', 'Speaker', 'Debater', 'Moderator', 'Leader', 'GD Champion'];
  function realEntries() { return A.history.filter(h => !h.sample); }
  function xpOf(h) { return 100 + (h.gains || []).reduce((a, g) => a + Math.max(0, g) * 3, 0) + Math.min(h.voiceTurns || 0, 6) * 15 + (h.overall >= 75 ? 50 : 0); }
  function stats() {
    const real = realEntries();
    const xp = real.reduce((a, h) => a + xpOf(h), 0);
    const level = 1 + Math.floor(xp / 400);
    const days = [...new Set(real.map(h => h.date.slice(0, 10)))].sort().reverse();
    let streak = 0;
    if (days.length) {
      const d0 = new Date(); const today = d0.toISOString().slice(0, 10);
      const yest = new Date(d0.getTime() - 864e5).toISOString().slice(0, 10);
      if (days[0] === today || days[0] === yest) {
        streak = 1;
        for (let i = 1; i < days.length; i++) { const prev = new Date(days[i - 1]), cur = new Date(days[i]); if ((prev - cur) / 864e5 === 1) streak++; else break; }
      }
    }
    const has = {
      first: real.length >= 1,
      counter: real.some(h => h.scores.counter >= 75),
      confident: real.some(h => h.scores.confidence >= 80 && (h.voiceTurns || 0) >= 2),
      leader: real.some(h => h.scores.leadership >= 75),
      voice: real.reduce((a, h) => a + (h.voiceTurns || 0), 0) >= 3,
      comeback: real.some(h => (h.gains || []).some(g => g >= 15)),
      evidence: real.some(h => h.scores.evidence >= 80),
      streak: streak >= 3
    };
    return { xp, level, levelName: LEVELS[Math.min(level, LEVELS.length) - 1], into: xp % 400, streak, has };
  }
  function saveResult(ev) {
    const before = stats();
    let entry = A.s.savedId && A.history.find(h => h.id === A.s.savedId);
    if (!entry) {
      entry = { id: Date.now(), date: new Date().toISOString(), topicId: ev.topic.id, topicTitle: ev.topic.title, gains: [], targets: [], demo: !!A.demo };
      A.history.push(entry); A.s.savedId = entry.id;
    }
    Object.assign(entry, { overall: ev.report.overall, scores: ev.scores, profile: ev.profile, r1Overall: entry.r1Overall || reportOverall(ev.r1), voiceTurns: ev.voiceTurns });
    entry.gains.push(ev.delta); entry.targets.push({ skill: ev.skill, before: ev.before, after: ev.after });
    store.set('history', A.history);
    const after = stats();
    const gained = after.xp - before.xp;
    if (gained > 0) toast(`+${gained} XP${after.level > before.level ? ` · Level up: ${after.levelName}` : ''}`, 'good');
    const fresh = BADGES.filter(b => after.has[b.id] && !before.has[b.id]).map(b => b.name);
    if (fresh.length) toast(`${fresh.length > 1 ? 'Badges' : 'Badge'} unlocked: ${fresh.join(', ')}`, 'badge');
    renderXPChip();
  }
  function reportOverall(scores) { return Math.round(E.REPORT_SKILLS.reduce((a, k) => a + scores[k], 0) / E.REPORT_SKILLS.length); }
  function renderXPChip() { const s = stats(); $('#xp-chip').textContent = `Lv ${s.level} · ${s.xp} XP`; }
  function levelBox(el) {
    const s = stats();
    el.innerHTML = `<div class="lv"><b>Level ${s.level} · ${esc(s.levelName)}</b><span>${s.xp} XP</span></div><div class="xpbar"><i style="width:${(s.into / 400) * 100}%"></i></div><span class="small muted">${400 - s.into} XP to level ${s.level + 1} · ${s.streak}-day streak</span>`;
  }
  function seedSamples() {
    const mk = (daysAgo, overall, skill, before, after, tweak) => {
      const base = { content: overall + 6, reasoning: overall + 2, evidence: overall - 3, counter: overall - 6, leadership: overall - 8, participation: overall + 1, communication: overall + 4, confidence: overall + 3, listening: overall - 5, ...tweak };
      base[skill] = after;
      const date = new Date(Date.now() - daysAgo * 864e5).toISOString();
      return { id: Date.now() - daysAgo * 1000, date, topicId: 'sample', topicTitle: 'Sample session', overall, scores: base, profile: {}, gains: [after - before], targets: [{ skill, before, after }], voiceTurns: 2, sample: true };
    };
    A.history = [mk(21, 58, 'participation', 44, 58), mk(14, 63, 'evidence', 51, 63), mk(7, 67, 'reasoning', 60, 69)];
    store.set('history', A.history);
  }

  /* ---------------- profile ---------------- */
  function renderProfile() {
    const p = A.profile || {};
    $('#pf-name').value = p.name || ''; $('#pf-college').value = p.college || '';
    if (p.year) $('#pf-year').value = p.year; if (p.target) $('#pf-target').value = p.target; if (p.lang) $('#pf-lang').value = p.lang;
    const last = A.history.slice().reverse().find(h => h.profile && Object.keys(h.profile).length) || A.history.slice().reverse()[0];
    const vals = last ? E.PROFILE_SKILLS.reduce((o, k) => (o[k] = (last.profile && last.profile[k]) || last.scores[k], o), {}) : null;
    $('#cp-bars').innerHTML = E.PROFILE_SKILLS.map(k => barHTML(E.SKILLS[k].name, vals ? vals[k] : 0, SKILL_COLOR[k])).join('');
    $('#cp-src').textContent = !last ? 'Not measured yet' : last.sample ? 'Sample data' : 'From your last GD';
    $('#cp-note').textContent = last ? 'Updated after every discussion. Confidence uses your speaking pace, fillers and hedges.' : 'Complete your first discussion to measure these six skills.';
    $('#cp-note').hidden = false;
    levelBox($('#pf-level'));
    animateBars($('#cp-bars').parentElement);
    if (A.pendingTopic) { $('#pf-err').hidden = false; $('#pf-err').textContent = 'Add your name to start the discussion.'; }
  }
  function saveProfile(e) {
    e.preventDefault();
    const name = $('#pf-name').value.trim();
    if (!name) { $('#pf-err').hidden = false; $('#pf-err').textContent = 'Enter your name so the AI participants can address you.'; $('#pf-name').focus(); return; }
    A.profile = { name: name.slice(0, 40), college: $('#pf-college').value.trim().slice(0, 80), year: $('#pf-year').value, target: $('#pf-target').value, lang: $('#pf-lang').value };
    store.set('profile', A.profile);
    $('#pf-err').hidden = true; $('#pf-saved').textContent = 'Saved';
    if (A.pendingTopic) { const t = A.pendingTopic; A.pendingTopic = null; startGD(t); } else go('topics');
  }

  /* ---------------- topics ---------------- */
  function renderTopics() {
    const vc = $('#voice-check');
    const micOk = Mic.available(), ttsOk = TTS.ok;
    vc.className = 'voice-check ' + (micOk && ttsOk ? 'ok' : 'warn');
    vc.innerHTML = `<span class="chip ${micOk ? 'good' : 'hot'}">${micOk ? 'Voice input ready' : 'Voice input unavailable'}</span><span>${micOk ? 'Click <b>Speak</b> in the arena and talk. Your transcript streams live to the engine.' : esc(Mic.reason())}</span><span class="chip ${ttsOk ? 'good' : 'hot'}">${ttsOk ? `AI voices: ${TTS.voices.length || 'system'}` : 'AI voices unavailable'}</span>`;
    const cats = ['All', ...E.CATEGORIES];
    $('#filters').innerHTML = cats.map(c => `<button type="button" role="tab" aria-selected="${c === A.filter}" data-cat="${esc(c)}">${esc(c)}</button>`).join('');
    const list = E.TOPICS.filter(t => A.filter === 'All' || t.cat === A.filter);
    $('#topic-grid').innerHTML = list.map(t => `
      <article class="card topic ${t.featured ? 'featured' : ''}" data-topic="${t.id}">
        <span class="cat">${esc(t.cat)}${t.featured ? ' · Demo topic' : ''}</span>
        <h3>${esc(t.title)}</h3>
        <div class="facts"><span class="chip diff-${t.difficulty}">${t.difficulty}</span><span class="chip mono">${t.mins} min</span></div>
        <p class="skills">Skills tested: <b>${t.skills.map(esc).join(', ')}</b></p>
        <button class="btn sm primary" type="button" data-start="${t.id}">Start discussion</button>
      </article>`).join('');
  }

  /* ---------------- dashboard ---------------- */
  function renderDashboard() {
    const H = A.history, s = stats();
    $('#dash-title').textContent = A.profile && A.profile.name ? `${A.profile.name}’s dashboard` : 'Dashboard';
    $('#dash-sample').hidden = !H.some(h => h.sample);
    const avg = H.length ? Math.round(H.reduce((a, h) => a + h.overall, 0) / H.length) : 0;
    const best = H.length ? Math.max(...H.map(h => h.overall)) : 0;
    const imp = H.length > 1 ? Math.round((H[H.length - 1].overall - H[0].overall) / H[0].overall * 100) : 0;
    const skAvg = k => H.length ? H.reduce((a, h) => a + (h.scores[k] || 0), 0) / H.length : 0;
    const weakest = H.length ? E.WEAKNESS_SKILLS.slice().sort((a, b) => skAvg(a) - skAvg(b))[0] : null;
    const strongest = H.length ? Object.keys(E.SKILLS).sort((a, b) => skAvg(b) - skAvg(a))[0] : null;
    const tile = (k, v, sub, mono) => `<div class="card tile"><span class="k">${k}</span><b class="${mono ? 'mono' : ''}">${v}</b><span class="s">${sub}</span></div>`;
    $('#tiles').innerHTML = [
      tile('Total GDs', H.length, `${realEntries().length} by you`, true),
      tile('Average score', H.length ? avg : '—', 'overall, out of 100', true),
      tile('Best score', H.length ? best : '—', 'single session', true),
      tile('Improvement', H.length > 1 ? (imp > 0 ? '+' : '') + imp + '%' : '—', 'first session to latest', true),
      tile('Weakest skill', weakest ? E.SKILLS[weakest].name : '—', weakest ? `avg ${Math.round(skAvg(weakest))}` : 'needs one GD'),
      tile('Strongest skill', strongest ? E.SKILLS[strongest].name : '—', strongest ? `avg ${Math.round(skAvg(strongest))}` : 'needs one GD')
    ].join('');
    drawChart(H);
    $('#streak').textContent = `${s.streak}-day streak`;
    levelBox($('#dash-level'));
    $('#badges').innerHTML = BADGES.map(b => `<div class="badge ${s.has[b.id] ? 'on' : ''}" title="${esc(b.desc)}"><span class="ic">${b.ic}</span><div><b>${esc(b.name)}</b><span>${s.has[b.id] ? 'Unlocked' : esc(b.desc)}</span></div></div>`).join('');
    $('#hist').innerHTML = H.length ? `<thead><tr><th>Date</th><th>Topic</th><th>Overall</th><th>Trained skill</th><th>Before → After</th><th>Change</th><th>Spoken turns</th></tr></thead><tbody>${H.slice().reverse().map(h => {
      const t = h.targets[h.targets.length - 1]; const g = t.after - t.before;
      return `<tr><td>${new Date(h.date).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}</td><td>${esc(h.topicTitle)}${h.sample ? ' <span class="chip">sample</span>' : h.demo ? ' <span class="chip">demo</span>' : ''}</td><td class="mono">${h.overall}</td><td>${esc(E.SKILLS[t.skill].name)}${h.targets.length > 1 ? ` +${h.targets.length - 1} more` : ''}</td><td class="mono">${t.before} → ${t.after}</td><td class="${g >= 0 ? 'up' : 'down'}">${g > 0 ? '+' : ''}${g}</td><td class="mono">${h.voiceTurns || 0}</td></tr>`;
    }).join('')}</tbody>` : '<tbody><tr><td class="muted">No sessions yet. Finish a discussion to start tracking progress.</td></tr></tbody>';
  }
  function drawChart(H) {
    const W = 640, Ht = 260, L = 44, Rp = 20, T = 24, B = 40;
    const iw = W - L - Rp, ih = Ht - T - B;
    let g = '<defs><linearGradient id="areaFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#F4B547" stop-opacity=".28"/><stop offset="1" stop-color="#F4B547" stop-opacity="0"/></linearGradient></defs>';
    [0, 25, 50, 75, 100].forEach(v => { const y = T + ih - ih * v / 100; g += `<line class="gl" x1="${L}" x2="${W - Rp}" y1="${y}" y2="${y}"/><text class="gt" x="${L - 10}" y="${y + 4}" text-anchor="end">${v}</text>`; });
    if (!H.length) { g += `<text class="empty-t" x="${W / 2}" y="${Ht / 2}" text-anchor="middle">Your progress line appears after your first discussion.</text>`; $('#chart').innerHTML = g; return; }
    const xs = i => H.length === 1 ? L + iw / 2 : L + iw * i / (H.length - 1);
    const ys = v => T + ih - ih * v / 100;
    const pts = H.map((h, i) => [xs(i), ys(h.overall)]);
    if (pts.length > 1) {
      g += `<path class="area" d="M${pts[0][0]},${T + ih} ${pts.map(p => `L${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ')} L${pts[pts.length - 1][0]},${T + ih} Z"/>`;
      g += `<path class="line" d="${pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ')}"/>`;
    }
    H.forEach((h, i) => {
      const [x, y] = pts[i];
      g += `<circle class="pt ${h.sample ? 'sample' : ''}" cx="${x}" cy="${y}" r="5"><title>${esc(h.topicTitle)}: ${h.overall}</title></circle><text class="lab" x="${x}" y="${y - 12}" text-anchor="middle">${h.overall}</text>`;
      g += `<text class="gt" x="${x}" y="${T + ih + 22}" text-anchor="middle">${new Date(h.date).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}</text>`;
    });
    $('#chart').innerHTML = g;
  }

  /* ---------------- start a GD ---------------- */
  function startGD(topicId, opts) {
    opts = opts || {};
    if (A.role !== 'host') return;
    if (!A.profile || !A.profile.name) { A.pendingTopic = topicId; go('profile'); return; }
    TTS.unlock();
    if (Mic.on) Mic.stop(true);
    A.s = newSession();
    A.analysis = A.challenge = A.result = null;
    send({ t: 'start', topicId, profile: A.profile, idle: !opts.demo });
  }

  /* ---------------- demo ---------------- */
  function demoLabel(t) { $('#demo-text').textContent = t; }
  function stopDemo(silent) {
    const was = !!A.demo; A.demo = null; A.fast = false; $('#demo-pill').hidden = true;
    if (was && !silent) toast('Demo stopped. You can carry on from here yourself.');
  }
  async function waitFor(run, cond, ms) {
    const t0 = Date.now();
    while (!cond()) { if (A.demo !== run) throw new Error('stopped'); if (Date.now() - t0 > (ms || 120000)) throw new Error('timeout'); await sleep(120); }
    if (A.demo !== run) throw new Error('stopped');
  }
  async function demoSpeak(text, run) {
    const ws = text.split(/\s+/); const t0 = Date.now();
    send({ t: 'speaking', on: true }); A.s.floorOpen = false;
    setCard('you', 'speaking');
    const voiced = A.settings.voices && TTS.ok && !A.fast;
    const per = voiced ? 60000 / 170 : 55;
    const ttsP = voiced ? TTS.speak('student', text) : Promise.resolve();
    for (let i = 0; i < ws.length; i++) {
      if (A.demo !== run) break;
      const partial = ws.slice(0, i + 1).join(' ');
      showLive('You · demo voice (simulated)', partial);
      if (i % 3 === 2) send({ t: 'interim', text: partial });
      await sleep(per);
    }
    await ttsP;
    hideLive(); setCard('you', 'idle');
    send({ t: 'speaking', on: false });
    if (A.demo !== run) throw new Error('stopped');
    // simulated speech is timed at a natural ~155 words per minute, even when the demo runs fast
    const dur = Math.max(Date.now() - t0, Math.round(ws.length / 155 * 60000));
    sendTurn(text, { durationMs: dur, voicedMs: Math.round(dur * 0.88), pauses: 0, firstSpeechAt: t0 });
  }
  async function runDemo() {
    if (A.role !== 'host') return;
    stopDemo(true);
    const run = { id: Date.now() }; A.demo = run;
    A.fast = !$('#demo-voices').checked;
    $('#demo-pill').hidden = false;
    TTS.unlock();
    try {
      if (!A.profile || !A.profile.name) { A.profile = { name: 'Demo Student', college: 'Sample College', year: '3rd year', target: 'Placement', lang: 'en-IN' }; store.set('profile', A.profile); }
      if (!A.history.length) seedSamples();
      demoLabel('Choosing a topic: “Is AI going to replace jobs?”');
      A.filter = 'All'; go('topics'); await sleep(1100);
      const card = $('[data-topic="ai"]'); if (card) card.scrollIntoView({ block: 'center', behavior: RM ? 'auto' : 'smooth' });
      await sleep(800); if (A.demo !== run) return;
      startGD('ai', { demo: true });
      demoLabel('Four AI participants open the discussion');
      await waitFor(run, () => A.s && A.s.topic && A.s.floorOpen);
      for (let i = 0; i < E.DEMO.turns.length; i++) {
        demoLabel(`Student speaks · turn ${i + 1} of ${E.DEMO.turns.length}`);
        await sleep(500);
        await demoSpeak(E.DEMO.turns[i], run);
        demoLabel('AI participants react to what was said');
        await sleep(300);
        await waitFor(run, () => A.s.floorOpen && !TTS.busy);
      }
      demoLabel('Ending round 1 · analysing communication behaviour');
      await sleep(600); send({ t: 'end' });
      await waitFor(run, () => A.analysis);
      await sleep(5200);
      demoLabel('Challenge Mode rebuilt for the weakest skill');
      send({ t: 'challenge:start' });
      await waitFor(run, () => A.s.phase === 'r2');
      await sleep(700);
      demoLabel('Student answers the challenge');
      const ch = A.challenge;
      await demoSpeak(E.DEMO.challenge[ch.skill] || E.DEMO.challenge.counter, run);
      await waitFor(run, () => A.result);
      demoLabel('Improvement measured · report and Communication DNA');
      await sleep(4800); if (A.demo !== run) return;
      $('#result .report').scrollIntoView({ behavior: RM ? 'auto' : 'smooth', block: 'start' });
      await sleep(3800); if (A.demo !== run) return;
      $('#result .dna').scrollIntoView({ behavior: RM ? 'auto' : 'smooth', block: 'start' });
      await sleep(2500);
      stopDemo(true);
      toast('Demo complete. Open the dashboard to see XP, badges and progress.', 'good');
    } catch (e) { if (e.message === 'timeout') { stopDemo(true); toast('The demo timed out waiting for the discussion. You can continue manually.', 'bad'); } }
  }

  /* ---------------- bind UI ---------------- */
  function bind() {
    window.addEventListener('hashchange', route);
    document.addEventListener('click', e => {
      const goBtn = e.target.closest('[data-go]'); if (goBtn) { go(goBtn.dataset.go); return; }
      const st = e.target.closest('[data-start]'); if (st) { startGD(st.dataset.start); return; }
      const cat = e.target.closest('[data-cat]'); if (cat) { A.filter = cat.dataset.cat; renderTopics(); return; }
      const ins = e.target.closest('[data-ins]');
      if (ins) {
        const ta = $('#answer'); if (ta.disabled) return;
        const v = ta.value, pos = ta.selectionStart != null ? ta.selectionStart : v.length;
        const pre = v.slice(0, pos), sep = pre && !/\s$/.test(pre) ? ' ' : '';
        ta.value = pre + sep + ins.dataset.ins + v.slice(ta.selectionEnd != null ? ta.selectionEnd : pos);
        const np = (pre + sep + ins.dataset.ins).length; ta.focus(); ta.setSelectionRange(np, np);
        ta.dispatchEvent(new Event('input'));
      }
    });
    $('#home-enter').addEventListener('click', () => { TTS.unlock(); go(A.profile && A.profile.name ? 'topics' : 'profile'); });
    $('#home-demo').addEventListener('click', runDemo);
    $('#nav-demo').addEventListener('click', runDemo);
    $('#demo-stop').addEventListener('click', () => { stopDemo(false); TTS.cancel(); });
    $('#demo-voices').addEventListener('change', e => { A.fast = !e.target.checked; if (A.fast) TTS.cancel(); });
    $('#profile-form').addEventListener('submit', saveProfile);
    $('#submit').addEventListener('click', submitTyped);
    $('#speak').addEventListener('click', toggleMic);
    $('#answer').addEventListener('input', () => {
      updateWC();
      if (A.s && A.s.phase === 'r2' && !A.s.firstKeyAt && $('#answer').value.trim()) A.s.firstKeyAt = Date.now();
      if (!$('#answer').value.trim()) pendingVoice = null;
    });
    $('#answer').addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !$('#submit').disabled) { e.preventDefault(); submitTyped(); } });
    $('#end').addEventListener('click', () => {
      if (!A.s || A.s.phase !== 'r1') return;
      if (A.s.turns === 0 && !A.s.endArmed) {
        A.s.endArmed = true; $('#end').textContent = 'End anyway? You have not spoken';
        setTimeout(() => { if (A.s) { A.s.endArmed = false; $('#end').textContent = 'End Discussion'; } }, 4000);
        return;
      }
      if (Mic.on) Mic.stop(true);
      send({ t: 'end' });
    });
    $('#start-challenge').addEventListener('click', () => send({ t: 'challenge:start' }));
    $('#train-next').addEventListener('click', () => send({ t: 'challenge:next' }));
    $('#opt-voices').checked = A.settings.voices; $('#opt-autosend').checked = A.settings.autoSend;
    $('#opt-voices').addEventListener('change', e => { A.settings.voices = e.target.checked; store.set('settings', A.settings); if (!e.target.checked) TTS.cancel(); });
    $('#opt-autosend').addEventListener('change', e => { A.settings.autoSend = e.target.checked; store.set('settings', A.settings); uiRecording(Mic.on); });
    $('#share').addEventListener('click', () => { $('#share-pop').hidden = !$('#share-pop').hidden; renderShare(); });
    $('#share-copy').addEventListener('click', () => {
      const u = $('#share-url').value; if (!u) return;
      const fallback = () => { $('#share-url').select(); toast('Copy blocked. The link is selected, press Ctrl+C.'); };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(u).then(() => toast('Live view link copied', 'good'), fallback); else fallback();
    });
    $('#viewer-audio').addEventListener('click', () => {
      A.viewerAudio = !A.viewerAudio; if (A.viewerAudio) TTS.unlock(); else TTS.cancel();
      $('#viewer-audio').textContent = A.viewerAudio ? 'Mute AI voices' : 'Turn on AI voices';
    });
    $('#reset-progress').addEventListener('click', () => { $('#reset-confirm').hidden = false; });
    $('#reset-no').addEventListener('click', () => { $('#reset-confirm').hidden = true; });
    $('#reset-yes').addEventListener('click', () => {
      A.history = []; store.del('history'); $('#reset-confirm').hidden = true; renderDashboard(); renderXPChip(); toast('Progress deleted');
    });
  }
  function applyRole() {
    if (A.role === 'viewer') {
      $$('[data-host]').forEach(el => { el.hidden = true; });
      $('#viewer-bar').hidden = false;
    }
  }

  /* ---------------- boot ---------------- */
  renderLoops();
  TTS.init();
  bind();
  applyRole();
  renderXPChip();
  route();
  connect();
})();
