// ── PDF.js setup ────────────────────────────────────────────
// pdf.js is loaded as a global via the CDN script tag
const pdfjsLib = globalThis.pdfjsLib;
if (pdfjsLib) {
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.4.168/pdf.worker.min.mjs';
}

// ── State (all in frontend) ─────────────────────────────────
const state = {
  // PDF
  pdfFile: null,
  pdfDoc: null,
  text: '',
  words: [],          // plain word strings from parsed text

  // TTS timing
  wordTimings: [],    // { word, startTime, endTime } from ElevenLabs alignment
  currentWordIndex: -1,

  // Playback
  isPlaying: false,
  isStopped: true,
  audioElement: null,
  mediaSource: null,
  sourceBuffer: null,
  audioQueue: [],     // queued ArrayBuffers waiting to be appended
  isAppending: false,
  allAudioReceived: false,

  // WebSocket
  ws: null,

  // Settings
  windowSize: 7,

  // Highlight loop
  animFrameId: null,
};

// ── DOM refs ────────────────────────────────────────────────
const $dropZone     = document.getElementById('drop-zone');
const $fileInput    = document.getElementById('file-input');
const $fileBtn      = document.getElementById('file-btn');
const $pdfViewer    = document.getElementById('pdf-viewer');
const $pdfPages     = document.getElementById('pdf-pages');
const $wordWindow   = document.getElementById('word-window');
const $wordsContainer = document.getElementById('words-container');
const $controls     = document.getElementById('controls');
const $playBtn      = document.getElementById('play-btn');
const $stopBtn      = document.getElementById('stop-btn');
const $iconPlay     = document.getElementById('icon-play');
const $iconPause    = document.getElementById('icon-pause');
const $wordCounter  = document.getElementById('word-counter');
const $windowSize   = document.getElementById('window-size');
const $newPdfBtn    = document.getElementById('new-pdf-btn');
const $statusOverlay = document.getElementById('status-overlay');
const $statusMessage = document.getElementById('status-message');
const $themeBtn      = document.getElementById('theme-btn');
const $iconMoon      = document.getElementById('icon-moon');
const $iconSun       = document.getElementById('icon-sun');

// ── Helpers ─────────────────────────────────────────────────
function showStatus(msg, isError = false) {
  $statusMessage.textContent = msg;
  $statusOverlay.classList.toggle('error', isError);
  $statusOverlay.classList.remove('hidden');
  clearTimeout(showStatus._timer);
  showStatus._timer = setTimeout(() => $statusOverlay.classList.add('hidden'), 4000);
}

function base64ToUint8Array(b64) {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}

// ── File Handling ───────────────────────────────────────────
$dropZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
  $dropZone.classList.add('dragover');
});

$dropZone.addEventListener('dragleave', (e) => {
  e.preventDefault();
  $dropZone.classList.remove('dragover');
});

$dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  $dropZone.classList.remove('dragover');
  const file = e.dataTransfer.files[0];
  if (file && file.type === 'application/pdf') {
    handleFile(file);
  } else {
    showStatus('Please drop a PDF file', true);
  }
});

$fileBtn.addEventListener('click', () => $fileInput.click());
$fileInput.addEventListener('change', (e) => {
  if (e.target.files[0]) handleFile(e.target.files[0]);
  e.target.value = ''; // allow re-selecting same file
});

async function handleFile(file) {
  showStatus('Parsing PDF...');

  // Extract text on the server
  const formData = new FormData();
  formData.append('pdf', file);

  let data;
  try {
    const res = await fetch('/api/parse-pdf', { method: 'POST', body: formData });
    data = await res.json();
  } catch (err) {
    showStatus('Server error - is the backend running?', true);
    return;
  }

  if (data.error) {
    showStatus(data.error, true);
    return;
  }

  state.pdfFile = file;
  state.text = data.text;
  state.words = data.text.split(/\s+/).filter(w => w.length > 0);

  // Render PDF in browser
  try {
    const arrayBuffer = await file.arrayBuffer();
    state.pdfDoc = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    await renderAllPages();
  } catch (err) {
    showStatus('Failed to render PDF', true);
    return;
  }

  // Show UI
  $dropZone.classList.add('hidden');
  $pdfViewer.classList.remove('hidden');
  $controls.classList.remove('hidden');
  $wordWindow.classList.remove('hidden');
  $statusOverlay.classList.add('hidden');

  $wordCounter.textContent = `0 / ${state.words.length} words`;
  renderWindow();
}

// ── PDF Rendering ───────────────────────────────────────────
async function renderAllPages() {
  $pdfPages.innerHTML = '';
  const numPages = state.pdfDoc.numPages;
  for (let i = 1; i <= numPages; i++) {
    const page = await state.pdfDoc.getPage(i);
    const scale = Math.min(1.5, (window.innerWidth - 80) / page.getViewport({ scale: 1 }).width);
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    $pdfPages.appendChild(canvas);
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
  }
}

// ── Play / Pause / Stop ─────────────────────────────────────
$playBtn.addEventListener('click', togglePlay);
$stopBtn.addEventListener('click', stopPlayback);

function togglePlay() {
  if (state.isPlaying) {
    pause();
  } else {
    play();
  }
}

function play() {
  if (state.words.length === 0) return;

  state.isPlaying = true;
  $iconPlay.classList.add('hidden');
  $iconPause.classList.remove('hidden');

  if (state.isStopped) {
    // Fresh start
    state.isStopped = false;
    startTTS();
  } else if (state.audioElement) {
    // Resume
    state.audioElement.play();
    startHighlightLoop();
  }
}

function pause() {
  state.isPlaying = false;
  $iconPlay.classList.remove('hidden');
  $iconPause.classList.add('hidden');

  if (state.audioElement) {
    state.audioElement.pause();
  }
  cancelAnimationFrame(state.animFrameId);
}

function stopPlayback() {
  state.isPlaying = false;
  state.isStopped = true;
  state.currentWordIndex = -1;
  state.wordTimings = [];
  state.audioQueue = [];
  state.isAppending = false;
  state.allAudioReceived = false;

  $iconPlay.classList.remove('hidden');
  $iconPause.classList.add('hidden');
  cancelAnimationFrame(state.animFrameId);

  if (state.ws) {
    state.ws.close();
    state.ws = null;
  }
  if (state.audioElement) {
    state.audioElement.pause();
    state.audioElement.removeAttribute('src');
    state.audioElement.load();
    state.audioElement = null;
  }
  state.mediaSource = null;
  state.sourceBuffer = null;

  $wordCounter.textContent = `0 / ${state.words.length} words`;
  renderWindow();
}

// ── New PDF ─────────────────────────────────────────────────
$newPdfBtn.addEventListener('click', () => {
  stopPlayback();
  state.pdfFile = null;
  state.pdfDoc = null;
  state.text = '';
  state.words = [];
  $pdfPages.innerHTML = '';
  $pdfViewer.classList.add('hidden');
  $controls.classList.add('hidden');
  $wordWindow.classList.add('hidden');
  $dropZone.classList.remove('hidden');
});

// ── Settings ────────────────────────────────────────────────
$windowSize.addEventListener('change', () => {
  let v = parseInt($windowSize.value, 10);
  if (isNaN(v) || v < 3) v = 3;
  if (v > 21) v = 21;
  if (v % 2 === 0) v += 1; // keep odd so current word is centered
  $windowSize.value = v;
  state.windowSize = v;
  renderWindow();
});

// ── TTS Streaming via WebSocket ─────────────────────────────
function startTTS() {
  // Set up audio pipeline: MediaSource → Audio element
  state.audioElement = new Audio();
  state.mediaSource = new MediaSource();
  state.audioElement.src = URL.createObjectURL(state.mediaSource);
  state.audioQueue = [];
  state.isAppending = false;
  state.allAudioReceived = false;
  state.wordTimings = [];
  state.currentWordIndex = -1;

  state.mediaSource.addEventListener('sourceopen', () => {
    try {
      state.sourceBuffer = state.mediaSource.addSourceBuffer('audio/mpeg');
      state.sourceBuffer.addEventListener('updateend', flushAudioQueue);
    } catch (err) {
      console.error('MediaSource error:', err);
      showStatus('Browser does not support streaming audio playback', true);
      return;
    }

    // Open WebSocket and request TTS
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    state.ws = new WebSocket(`${proto}//${location.host}`);

    state.ws.addEventListener('open', () => {
      state.ws.send(JSON.stringify({
        action: 'speak',
        text: state.text,
      }));
    });

    state.ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);

      if (msg.type === 'audio') {
        const audioData = base64ToUint8Array(msg.audio);
        state.audioQueue.push(audioData.buffer);
        flushAudioQueue();

        // Auto-play once we have the first chunk
        if (state.audioElement.paused && state.isPlaying) {
          state.audioElement.play().catch(() => {});
          startHighlightLoop();
        }
      }

      if (msg.type === 'timing') {
        // Accumulate word-level timing data
        state.wordTimings.push(...msg.words);
      }

      if (msg.type === 'done') {
        state.allAudioReceived = true;
        // End the stream once all buffered audio is appended
        flushAudioQueue();
      }

      if (msg.type === 'error') {
        showStatus(msg.message, true);
        stopPlayback();
      }
    });

    state.ws.addEventListener('error', () => {
      showStatus('WebSocket connection failed', true);
      stopPlayback();
    });

    state.ws.addEventListener('close', () => {
      state.allAudioReceived = true;
      flushAudioQueue();
    });
  });
}

function flushAudioQueue() {
  if (!state.sourceBuffer || state.sourceBuffer.updating || state.isAppending) return;

  if (state.audioQueue.length > 0) {
    state.isAppending = true;
    const chunk = state.audioQueue.shift();
    try {
      state.sourceBuffer.appendBuffer(chunk);
    } catch (err) {
      console.error('appendBuffer error:', err);
    }
    state.isAppending = false;
    // updateend event will call flushAudioQueue again
  } else if (state.allAudioReceived && state.mediaSource && state.mediaSource.readyState === 'open') {
    try {
      state.mediaSource.endOfStream();
    } catch {}
  }
}

// ── Highlight Loop ──────────────────────────────────────────
function startHighlightLoop() {
  cancelAnimationFrame(state.animFrameId);
  function loop() {
    if (!state.isPlaying) return;

    const currentTime = state.audioElement?.currentTime || 0;

    // Find the word at the current playback time
    let idx = -1;
    for (let i = 0; i < state.wordTimings.length; i++) {
      const wt = state.wordTimings[i];
      if (currentTime >= wt.startTime && currentTime < wt.endTime) {
        idx = i;
        break;
      }
      // If we've passed this word but haven't reached the next, still show this word
      if (currentTime >= wt.startTime && (i === state.wordTimings.length - 1 || currentTime < state.wordTimings[i + 1].startTime)) {
        idx = i;
        break;
      }
    }

    if (idx !== -1 && idx !== state.currentWordIndex) {
      state.currentWordIndex = idx;
      $wordCounter.textContent = `${idx + 1} / ${state.wordTimings.length} words`;
      renderWindow();
    }

    // Check if playback finished
    if (state.audioElement && state.audioElement.ended) {
      state.isPlaying = false;
      state.isStopped = true;
      $iconPlay.classList.remove('hidden');
      $iconPause.classList.add('hidden');
      return;
    }

    state.animFrameId = requestAnimationFrame(loop);
  }
  state.animFrameId = requestAnimationFrame(loop);
}

// ── Sliding Window Renderer ─────────────────────────────────
function renderWindow() {
  $wordsContainer.innerHTML = '';

  // Use timing-derived words if available, otherwise fall back to parsed words
  const wordList = state.wordTimings.length > 0
    ? state.wordTimings.map(wt => wt.word)
    : state.words;

  if (wordList.length === 0) return;

  const idx = Math.max(0, state.currentWordIndex);
  const half = Math.floor(state.windowSize / 2);

  // Center the window on the current word
  let start = idx - half;
  let end = idx + half + 1;

  // Clamp to bounds
  if (start < 0) {
    start = 0;
    end = Math.min(state.windowSize, wordList.length);
  }
  if (end > wordList.length) {
    end = wordList.length;
    start = Math.max(0, end - state.windowSize);
  }

  for (let i = start; i < end; i++) {
    const span = document.createElement('span');
    span.textContent = wordList[i];

    const classes = ['word'];
    if (i === idx && state.currentWordIndex >= 0) {
      classes.push('current');
    } else if (Math.abs(i - idx) <= 1) {
      classes.push('near');
    }
    span.className = classes.join(' ');
    $wordsContainer.appendChild(span);
  }
}

// ── Theme Toggle ────────────────────────────────────────────
function applyTheme(light) {
  document.documentElement.classList.toggle('light', light);
  $iconMoon.classList.toggle('hidden', light);
  $iconSun.classList.toggle('hidden', !light);
}

// Restore saved preference (default: dark)
applyTheme(localStorage.getItem('theme') === 'light');

$themeBtn.addEventListener('click', () => {
  const isLight = document.documentElement.classList.toggle('light');
  $iconMoon.classList.toggle('hidden', isLight);
  $iconSun.classList.toggle('hidden', !isLight);
  localStorage.setItem('theme', isLight ? 'light' : 'dark');
});

// ── Keyboard shortcuts ──────────────────────────────────────
document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  if (e.code === 'Space') {
    e.preventDefault();
    if (!$controls.classList.contains('hidden')) togglePlay();
  }
});
