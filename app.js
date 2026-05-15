// ── Glitter stars background ──────────────────────────────────────────
(function initStars() {
  const canvas = document.getElementById('stars-canvas');
  const ctx    = canvas.getContext('2d');
  let stars   = [];

  function resize() {
    canvas.width  = window.innerWidth;
    canvas.height = window.innerHeight;
  }

  function createStars() {
    stars = Array.from({ length: 250 }, (_, i) => ({
      x:         Math.random() * canvas.width,
      y:         Math.random() * canvas.height,
      r:         i < 20
                   ? Math.random() * 1.2 + 1.0
                   : Math.random() * 1.0 + 0.4,
      baseAlpha: i < 20
                   ? Math.random() * 0.3  + 0.5
                   : Math.random() * 0.35 + 0.20,
      speed:     i < 40
                   ? Math.random() * 0.007  + 0.004
                   : Math.random() * 0.0015 + 0.0004,
      phase:     Math.random() * Math.PI * 2,
      sparkle:   i < 40,
    }));
  }

  function draw(t) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    stars.forEach(s => {
      const pulse = 0.5 + 0.5 * Math.sin(t * s.speed + s.phase);
      const alpha = s.sparkle
        ? Math.pow(pulse, 4) * 0.9
        : s.baseAlpha * (0.35 + 0.65 * pulse);
      ctx.globalAlpha = alpha;
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
    });
    ctx.globalAlpha = 1;
    requestAnimationFrame(draw);
  }

  resize();
  createStars();
  window.addEventListener('resize', () => { resize(); createStars(); });
  requestAnimationFrame(draw);
})();

// ── State ─────────────────────────────────────────────────────────────
const state = {
  audioFile:     null,
  transcript:    null,
  metrics:       null,
  mediaRecorder: null,
  recordChunks:  [],
  recordTimer:   null,
  recordSeconds: 0,
  chatMode:      false,
  chatHistory:   [],
};

// ── Transitions ───────────────────────────────────────────────────────
function goTo(nextId) {
  const current = document.querySelector('.step.active');
  const next    = document.getElementById(nextId);
  if (!current || !next || current === next) return;

  current.classList.add('leaving');
  current.classList.remove('active');

  current.addEventListener('transitionend', function handler(e) {
    if (e.propertyName !== 'opacity') return;
    current.removeEventListener('transitionend', handler);
    current.classList.remove('leaving');
    next.classList.add('active');
    updateDots(next);
    animateAgentText(next.querySelector('.agent-text'));
  });
}

function updateDots(stepEl) {
  const num = parseInt(stepEl.id.split('-')[1]);
  document.querySelectorAll('.step-pill').forEach(pill => {
    const s = parseInt(pill.dataset.step);
    pill.classList.toggle('active', s === num);
    pill.classList.toggle('done',   s < num);
  });
}

function animateAgentText(el) {
  if (!el) return;
  const words = el.textContent.trim().split(/\s+/);
  el.innerHTML = words
    .map((w, i) => `<span class="word" style="animation-delay:${i * 40}ms">${w}</span>`)
    .join(' ');
}

animateAgentText(document.getElementById('agent-1'));

// ── Step 1: Drop / Record ─────────────────────────────────────────────
const dropzone    = document.getElementById('dropzone');
const fileInput   = document.getElementById('file-input');
const recordBtn   = document.getElementById('record-btn');
const recordRow   = document.getElementById('record-row');
const recordStat  = document.getElementById('record-status');
const recordTimer = document.getElementById('record-timer');
const errorMsg    = document.getElementById('error-msg');

function showError(msg) {
  errorMsg.textContent = msg;
  errorMsg.classList.add('visible');
}
function clearError() {
  errorMsg.classList.remove('visible');
}

dropzone.addEventListener('dragover', e => {
  e.preventDefault();
  dropzone.classList.add('drag-over');
});
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('drag-over'));
dropzone.addEventListener('drop', e => {
  e.preventDefault();
  dropzone.classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (file) handleFile(file);
});
fileInput.addEventListener('change', e => {
  const file = e.target.files[0];
  if (file) handleFile(file);
});

function handleFile(file) {
  clearError();
  if (!file.type.startsWith('audio/')) {
    showError('Solo se admiten archivos de audio (WAV, MP3, WebM, M4A).');
    return;
  }
  state.audioFile = file;
  startProcessing();
}

recordBtn.addEventListener('click', async () => {
  if (state.mediaRecorder && state.mediaRecorder.state === 'recording') {
    stopRecording();
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    state.recordChunks  = [];
    state.recordSeconds = 0;
    state.mediaRecorder = new MediaRecorder(stream);
    state.mediaRecorder.ondataavailable = e => state.recordChunks.push(e.data);
    state.mediaRecorder.onstop = () => {
      stream.getTracks().forEach(t => t.stop());
      const blob = new Blob(state.recordChunks, { type: 'audio/webm' });
      state.audioFile = new File([blob], 'grabacion.webm', { type: 'audio/webm' });
      startProcessing();
    };
    state.mediaRecorder.start();

    recordRow.classList.add('recording');
    document.getElementById('record-icon').innerHTML =
      '<rect width="12" height="12" x="4" y="4" rx="2"/>';
    recordStat.textContent = 'Grabando';

    state.recordTimer = setInterval(() => {
      state.recordSeconds++;
      const m = Math.floor(state.recordSeconds / 60).toString().padStart(2, '0');
      const s = (state.recordSeconds % 60).toString().padStart(2, '0');
      recordTimer.textContent = `${m}:${s}`;
      if (state.recordSeconds >= 600) stopRecording();
    }, 1000);
  } catch {
    showError('No se pudo acceder al micrófono. Verifica los permisos del navegador.');
  }
});

function stopRecording() {
  clearInterval(state.recordTimer);
  if (state.mediaRecorder) state.mediaRecorder.stop();
  recordRow.classList.remove('recording');
  document.getElementById('record-icon').innerHTML = '<circle cx="10" cy="10" r="6"/>';
  recordStat.textContent  = 'Grabar desde el micrófono';
  recordTimer.textContent = '';
}

// ── Step 2: Processing wave ───────────────────────────────────────────
function buildWavePath() {
  const A      = 30;
  const period = 100;
  const pts    = [];
  for (let x = -period; x <= 640 + period; x += 3) {
    const y = 100 + A * Math.sin((x / period) * 2 * Math.PI);
    pts.push(x === -period ? `M${x},${y}` : `L${x},${y}`);
  }
  return pts.join(' ');
}

function initWave() {
  document.getElementById('wave-path').setAttribute('d', buildWavePath());
}

// ── API calls ─────────────────────────────────────────────────────────
async function startProcessing() {
  goTo('step-2');

  const line = document.getElementById('progress-line');
  line.classList.remove('running');
  line.getBoundingClientRect();
  line.classList.add('running');

  setTimeout(initWave, 30);

  const form1 = new FormData();
  form1.append('audio', state.audioFile);
  const form2 = new FormData();
  form2.append('audio', state.audioFile);

  try {
    const [r1, r2] = await Promise.all([
      fetch('http://localhost:8000/transcribe', { method: 'POST', body: form1 }),
      fetch('http://localhost:8000/analyze',    { method: 'POST', body: form2 }),
    ]);

    if (!r1.ok) throw new Error((await r1.json()).detail || r1.statusText);
    if (!r2.ok) throw new Error((await r2.json()).detail || r2.statusText);

    const [t, m] = await Promise.all([r1.json(), r2.json()]);
    state.transcript = t.text;
    state.metrics    = m;

    populateResults();
    goTo('step-3');
  } catch (err) {
    document.getElementById('progress-line').classList.remove('running');
    goTo('step-1');
    showError(`Error: ${err.message || 'Verifica que el servidor esté corriendo en :8000.'}`);
  }
}

// ── Step 3: Results ───────────────────────────────────────────────────
function populateResults() {
  const m = state.metrics;

  document.getElementById('m-pitch').textContent = `${Math.round(m.pitch_mean)} Hz`;
  document.getElementById('m-std').textContent   = `±${Math.round(m.pitch_std)} Hz`;
  document.getElementById('m-rate').textContent  = `${Math.round(m.speaking_rate)}/min`;
  document.getElementById('m-down').textContent  = `${Math.round(m.downward_ratio * 100)}%`;

  setTimeout(() => animateGauge(m.confidence_score), 300);
  drawPitchCanvas(m.pitch_contour, m.inflection_segments);

  const row = document.getElementById('chips-row');
  row.innerHTML = '';
  m.inflection_segments.forEach((seg, i) => {
    const arrow = seg.direction === 'downward' ? '↓' : seg.direction === 'upward' ? '↑' : '→';
    const chip  = document.createElement('div');
    chip.className = `chip ${seg.direction}`;
    chip.style.setProperty('--i', i);
    chip.textContent = `${fmt(seg.start_sec)}–${fmt(seg.end_sec)}  ${arrow}`;
    row.appendChild(chip);
  });

  document.getElementById('transcript-body').textContent =
    state.transcript || '(sin transcripción disponible)';
}

function fmt(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

function animateGauge(score) {
  const arc   = document.getElementById('gauge-arc');
  const numEl = document.getElementById('gauge-number');
  const C      = 2 * Math.PI * 54;
  const arc270 = (270 / 360) * C;
  const target = (score / 100) * arc270;
  const start  = performance.now();
  const dur    = 1100;

  function ease(t) { return 1 - Math.pow(1 - t, 3); }

  (function tick(now) {
    const t = Math.min((now - start) / dur, 1);
    const e = ease(t);
    arc.setAttribute('stroke-dasharray', `${target * e} ${C}`);
    numEl.textContent = Math.round(score * e);
    if (t < 1) requestAnimationFrame(tick);
  })(start);
}

function drawPitchCanvas(contour, segments) {
  const canvas = document.getElementById('pitch-canvas');
  const dpr    = window.devicePixelRatio || 1;
  const W      = canvas.offsetWidth || 600;
  const H      = 120;
  canvas.width  = W * dpr;
  canvas.height = H * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  if (!contour || !contour.length) return;

  const times = contour.map(p => p[0]);
  const freqs = contour.map(p => p[1]);
  const minT  = Math.min(...times);
  const maxT  = Math.max(...times);
  const minF  = Math.min(...freqs) * 0.92;
  const maxF  = Math.max(...freqs) * 1.08;
  const pad   = 12;

  const toX = t => ((t - minT) / (maxT - minT || 1)) * (W - pad * 2) + pad;
  const toY = f => H - pad - ((f - minF) / (maxF - minF || 1)) * (H - pad * 2);

  ctx.strokeStyle = '#191919';
  ctx.lineWidth   = 1;
  for (let i = 1; i < 4; i++) {
    const y = (H / 4) * i;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(W, y);
    ctx.stroke();
  }

  function colorAt(t) {
    for (const seg of segments) {
      if (t >= seg.start_sec && t <= seg.end_sec) {
        if (seg.direction === 'downward') return '#30D158';
        if (seg.direction === 'upward')   return '#FF9F0A';
        return '#636366';
      }
    }
    return '#636366';
  }

  for (let i = 1; i < contour.length; i++) {
    const [t0, f0] = contour[i - 1];
    const [t1, f1] = contour[i];
    ctx.beginPath();
    ctx.strokeStyle = colorAt((t0 + t1) / 2);
    ctx.lineWidth   = 2;
    ctx.lineJoin    = 'round';
    ctx.lineCap     = 'round';
    ctx.moveTo(toX(t0), toY(f0));
    ctx.lineTo(toX(t1), toY(f1));
    ctx.stroke();
  }
}

new ResizeObserver(() => {
  if (state.metrics) {
    drawPitchCanvas(state.metrics.pitch_contour, state.metrics.inflection_segments);
  }
}).observe(document.getElementById('pitch-canvas'));

// ── Event listeners ───────────────────────────────────────────────────
document.getElementById('transcript-toggle').addEventListener('click', function () {
  const body  = document.getElementById('transcript-body');
  const arrow = document.getElementById('transcript-arrow');
  const open  = body.classList.toggle('open');
  this.setAttribute('aria-expanded', open);
  arrow.style.transform = open ? 'rotate(180deg)' : '';
});

document.getElementById('coach-btn').addEventListener('click', () => {
  state.chatMode = false;
  state.chatHistory = [];
  document.getElementById('rec-cards').innerHTML = '';
  document.getElementById('coach-input').value       = '';
  document.getElementById('coach-input').placeholder = 'Cuéntame qué estabas presentando…';
  document.getElementById('coach-send').textContent  = 'Analizar';
  goTo('step-4');
  setTimeout(() => document.getElementById('coach-input').focus(), 360);
});

document.getElementById('back-btn').addEventListener('click', () => {
  state.chatMode = false;
  state.chatHistory = [];
  goTo('step-3');
});

document.getElementById('restart-btn').addEventListener('click', () => {
  state.audioFile  = null;
  state.transcript = null;
  state.metrics    = null;
  fileInput.value  = '';
  clearError();
  document.getElementById('chips-row').innerHTML = '';
  document.getElementById('transcript-body').classList.remove('open');
  document.getElementById('transcript-body').textContent = '';
  document.getElementById('gauge-arc').setAttribute('stroke-dasharray', '0 339.29');
  document.getElementById('gauge-number').textContent = '0';
  document.getElementById('progress-line').classList.remove('running');
  goTo('step-1');
});

// ── Step 4: Coach ─────────────────────────────────────────────────────
document.getElementById('coach-send').addEventListener('click', sendCoach);
document.getElementById('coach-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') sendCoach();
});

async function sendCoach() {
  if (state.chatMode) return sendFollowUp();

  const input   = document.getElementById('coach-input');
  const sendBtn = document.getElementById('coach-send');
  const cards   = document.getElementById('rec-cards');
  cards.innerHTML = '';

  sendBtn.disabled    = true;
  sendBtn.textContent = 'Analizando…';

  const extra      = input.value.trim();
  const transcript = extra
    ? `${state.transcript || ''}\n\nContexto: ${extra}`
    : (state.transcript || '');

  try {
    const res = await fetch('http://localhost:8000/feedback', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ metrics: state.metrics, transcript }),
    });
    if (!res.ok) throw new Error((await res.json()).detail || res.statusText);
    const { recommendations } = await res.json();
    streamRecs(recommendations || [], cards, activateChatMode);
  } catch (err) {
    cards.innerHTML =
      `<p style="color:var(--danger);font-size:0.875rem;">Error: ${err.message}</p>`;
  } finally {
    sendBtn.disabled    = false;
    sendBtn.textContent = 'Analizar';
  }
}

function activateChatMode() {
  state.chatMode = true;
  const input = document.getElementById('coach-input');
  const btn   = document.getElementById('coach-send');
  input.placeholder = 'Pregunta algo al coach…';
  btn.textContent   = 'Preguntar';
  input.value = '';
  input.focus();
}

async function sendFollowUp() {
  const input   = document.getElementById('coach-input');
  const sendBtn = document.getElementById('coach-send');
  const cards   = document.getElementById('rec-cards');
  const question = input.value.trim();
  if (!question) return;

  input.value         = '';
  sendBtn.disabled    = true;
  sendBtn.textContent = 'Pensando…';

  appendFollowUpThread(question, cards);

  try {
    const res = await fetch('http://localhost:8000/chat', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        metrics:    state.metrics,
        transcript: state.transcript || '',
        question,
        history:    state.chatHistory,
      }),
    });
    if (!res.ok) throw new Error((await res.json()).detail || res.statusText);
    const { answer } = await res.json();

    state.chatHistory.push({ role: 'user',      content: question });
    state.chatHistory.push({ role: 'assistant', content: answer  });

    streamFollowUpAnswer(answer, cards.lastElementChild);
  } catch (err) {
    const textEl = cards.lastElementChild.querySelector('.rec-text');
    if (textEl) {
      textEl.textContent = `Error: ${err.message}`;
      textEl.style.color = 'var(--danger)';
    }
  } finally {
    sendBtn.disabled    = false;
    sendBtn.textContent = 'Preguntar';
  }
}

function appendFollowUpThread(question, container) {
  const label = document.createElement('p');
  label.className   = 'followup-label';
  label.textContent = 'Tu pregunta';

  const q = document.createElement('p');
  q.className   = 'followup-q';
  q.textContent = question;

  const card   = document.createElement('div');
  card.className = 'rec-card rec-card--answer';
  const textEl = document.createElement('span');
  textEl.className = 'rec-text';
  const cursor = document.createElement('span');
  cursor.className = 'cursor';
  textEl.appendChild(cursor);
  card.appendChild(textEl);

  container.appendChild(label);
  container.appendChild(q);
  container.appendChild(card);
  requestAnimationFrame(() => card.classList.add('visible'));
}

function streamFollowUpAnswer(text, card) {
  const textEl = card.querySelector('.rec-text');
  const cursor = card.querySelector('.cursor');
  if (!textEl || !cursor) return;
  let ci = 0;
  (function tick() {
    if (ci < text.length) {
      cursor.insertAdjacentText('beforebegin', text[ci++]);
      setTimeout(tick, 15);
    } else {
      cursor.remove();
    }
  })();
}

function streamRecs(recs, container, onDone) {
  function typeCard(idx) {
    if (idx >= recs.length) {
      if (typeof onDone === 'function') onDone();
      return;
    }

    const card   = document.createElement('div');
    card.className = 'rec-card';
    const num    = document.createElement('span');
    num.className  = 'rec-num';
    num.textContent = `0${idx + 1}`;
    const textEl = document.createElement('span');
    textEl.className = 'rec-text';
    const cursor = document.createElement('span');
    cursor.className = 'cursor';
    textEl.appendChild(cursor);
    card.appendChild(num);
    card.appendChild(textEl);
    container.appendChild(card);

    requestAnimationFrame(() => card.classList.add('visible'));

    const text = recs[idx] || '';
    let ci = 0;

    (function typeChar() {
      if (ci < text.length) {
        cursor.insertAdjacentText('beforebegin', text[ci++]);
        setTimeout(typeChar, 15);
      } else {
        cursor.remove();
        setTimeout(() => typeCard(idx + 1), 200);
      }
    })();
  }
  typeCard(0);
}
