'use strict';

// --- Password gate ---
let sessionPassword = sessionStorage.getItem('cs_password') || '';

function updateScansDisplay(remaining) {
  const el = document.getElementById('scans-remaining');
  if (el) el.textContent = `${remaining} scan${remaining === 1 ? '' : 's'} left`;
}

async function submitPassword() {
  const input = document.getElementById('password-input');
  const errEl = document.getElementById('password-error');
  const pw = input.value.trim();
  if (!pw) return;

  try {
    const res = await fetch('/api/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: pw }),
    });
    const data = await res.json();
    if (!res.ok) {
      errEl.textContent = data.error || 'Invalid password';
      errEl.style.display = 'block';
      return;
    }
    sessionPassword = pw;
    sessionStorage.setItem('cs_password', pw);
    showApp(data.remaining);
  } catch {
    errEl.textContent = 'Could not connect. Try again.';
    errEl.style.display = 'block';
  }
}

function showApp(remaining) {
  document.getElementById('password-gate').style.display = 'none';
  document.getElementById('main-content').style.display = 'block';
  updateScansDisplay(remaining);
  renderHistoryList();
}

if (sessionPassword) {
  fetch('/api/auth', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: sessionPassword }),
  })
    .then((r) => r.json())
    .then((data) => {
      if (data.success) showApp(data.remaining);
      else { sessionStorage.removeItem('cs_password'); sessionPassword = ''; }
    })
    .catch(() => {});
}

document.getElementById('password-submit').addEventListener('click', submitPassword);
document.getElementById('password-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') submitPassword();
});

// --- Tab bar ---
document.getElementById('tab-scanner').addEventListener('click', () => switchTab('scanner'));
document.getElementById('tab-history').addEventListener('click', () => {
  switchTab('history');
  renderHistoryList();
});

function switchTab(tab) {
  document.getElementById('tab-scanner').classList.toggle('active', tab === 'scanner');
  document.getElementById('tab-history').classList.toggle('active', tab === 'history');
  document.getElementById('scanner-tab').style.display = tab === 'scanner' ? '' : 'none';
  document.getElementById('history-tab').style.display = tab === 'history' ? '' : 'none';
  if (tab === 'history') showHistoryList();
}

// --- History storage ---
function historyKey() {
  return `cs_history_${sessionPassword}`;
}

function loadHistory() {
  try { return JSON.parse(localStorage.getItem(historyKey()) || '[]'); } catch { return []; }
}

function saveHistory(items) {
  localStorage.setItem(historyKey(), JSON.stringify(items.slice(0, 50)));
}

function addToHistory(card, image, source) {
  const items = loadHistory();
  items.unshift({
    id: Date.now(),
    ts: new Date().toISOString(),
    source, // 'scan' or 'description'
    card,
    image: image || null,
  });
  saveHistory(items);
}

// --- History UI ---
function showHistoryList() {
  document.getElementById('history-list').style.display = 'block';
  document.getElementById('history-result').style.display = 'none';
}

function renderHistoryList() {
  const items = loadHistory();
  const listEl = document.getElementById('history-list');
  const emptyEl = document.getElementById('history-empty');

  listEl.innerHTML = '';
  if (items.length === 0) {
    emptyEl.style.display = 'flex';
    listEl.style.display = 'none';
    return;
  }

  emptyEl.style.display = 'none';
  listEl.style.display = 'block';

  items.forEach((item) => {
    const card = item.card;
    const date = new Date(item.ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    const rawLow = card.prices?.raw?.low;
    const psa10High = card.prices?.psa10?.high;
    const fmt = (v) => v == null ? '' : v >= 1000 ? `$${(v/1000).toFixed(1)}K` : `$${v}`;

    const el = document.createElement('div');
    el.className = 'history-item';
    el.innerHTML = `
      <div class="history-item-info">
        <div class="history-item-player">${card.player || 'Unknown'}</div>
        <div class="history-item-meta">${[card.year, card.brand].filter(Boolean).join(' · ')}</div>
        <div class="history-item-date">${date} · ${item.source === 'scan' ? '📷 Scan' : '🔍 Description'}</div>
      </div>
      <div class="history-item-price">
        ${rawLow != null ? `<span class="history-price-label">Raw</span><span>${fmt(rawLow)}</span>` : ''}
        ${psa10High != null ? `<span class="history-price-label">PSA 10</span><span>${fmt(psa10High)}</span>` : ''}
      </div>
    `;
    el.addEventListener('click', () => showHistoryResult(item));
    listEl.appendChild(el);
  });
}

function showHistoryResult(item) {
  document.getElementById('history-list').style.display = 'none';
  document.getElementById('history-empty').style.display = 'none';
  const resultEl = document.getElementById('history-result');
  resultEl.style.display = 'block';

  const { card, image } = item;

  const imgSection = document.getElementById('h-card-image-section');
  const imgEl = document.getElementById('h-card-result-img');
  if (image && image.data) {
    imgEl.src = `data:${image.contentType};base64,${image.data}`;
    imgSection.style.display = 'block';
  } else {
    imgSection.style.display = 'none';
  }

  document.getElementById('h-card-player').textContent = card.player || 'Unknown Player';
  document.getElementById('h-card-meta').textContent = [card.year, card.brand, card.cardNumber ? `#${card.cardNumber}` : null]
    .filter(Boolean).join(' · ');

  const badge = document.getElementById('h-confidence-badge');
  badge.textContent = card.confidence || 'low';
  badge.className = `confidence-badge confidence-${card.confidence || 'low'}`;

  const attrsEl = document.getElementById('h-attributes-list');
  attrsEl.innerHTML = '';
  const attrs = card.attributes || [];
  if (attrs.length > 0) {
    document.getElementById('h-attributes-section').style.display = 'flex';
    attrs.forEach((a) => {
      const span = document.createElement('span');
      span.className = 'attr-tag';
      span.textContent = a;
      attrsEl.appendChild(span);
    });
  } else {
    document.getElementById('h-attributes-section').style.display = 'none';
  }

  const fmt = (v) => v == null ? 'N/A' : v >= 1000 ? `$${(v / 1000).toFixed(1)}K` : `$${v}`;
  const grades = [
    { label: 'Raw (Ungraded)', key: 'raw' },
    { label: 'PSA 7', key: 'psa7' },
    { label: 'PSA 8', key: 'psa8' },
    { label: 'PSA 9', key: 'psa9' },
    { label: 'PSA 10', key: 'psa10' },
  ];

  const tbody = document.getElementById('h-price-table-body');
  tbody.innerHTML = '';
  grades.forEach(({ label, key }) => {
    const p = card.prices?.[key];
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${label}</td><td>${fmt(p?.low)}</td><td>${fmt(p?.high)}</td>`;
    tbody.appendChild(tr);
  });

  document.getElementById('h-pricing-notes').textContent = card.pricingNotes || '';
  resultEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

document.getElementById('history-back-btn').addEventListener('click', showHistoryList);

// --- Main app ---
const video = document.getElementById('video');
const canvas = document.getElementById('canvas');
const placeholder = document.getElementById('placeholder');
const scanOverlay = document.getElementById('scan-overlay');
const analyzingOverlay = document.getElementById('analyzing-overlay');
const startCameraBtn = document.getElementById('start-camera-btn');
const captureBtn = document.getElementById('capture-btn');
const retakeBtn = document.getElementById('retake-btn');
const analyzeBtn = document.getElementById('analyze-btn');
const resultsSection = document.getElementById('results-section');
const errorCard = document.getElementById('error-card');
const errorMsg = document.getElementById('error-msg');
const scanAgainBtn = document.getElementById('scan-again-btn');
const describeBtn = document.getElementById('describe-btn');
const cardDescription = document.getElementById('card-description');
const frontPreviewImg = document.getElementById('front-preview-img');
const backPreviewImg = document.getElementById('back-preview-img');
const scanInstruction = document.getElementById('scan-instruction');

let stream = null;
let capturedFront = null;
let capturedBack = null;
let scanStep = 'front';
let scanMode = 'both';

document.getElementById('mode-both').addEventListener('click', () => setScanMode('both'));
document.getElementById('mode-one').addEventListener('click', () => setScanMode('one'));

function setScanMode(mode) {
  scanMode = mode;
  document.getElementById('mode-both').classList.toggle('active', mode === 'both');
  document.getElementById('mode-one').classList.toggle('active', mode === 'one');
  document.getElementById('scan-steps').style.display = mode === 'both' ? 'flex' : 'none';
  document.getElementById('placeholder-text').textContent =
    mode === 'both' ? 'Open your camera to scan both sides of the card'
                    : 'Open your camera to scan the front of the card';
  resetToStart();
}

function setStep(step) {
  scanStep = step;
  const frontDot = document.querySelector('#step-front .step-dot');
  const backDot = document.querySelector('#step-back .step-dot');
  if (step === 'front') {
    scanInstruction.innerHTML = 'Scan the <strong>front</strong> of the card';
    frontDot.className = 'step-dot active';
    backDot.className = 'step-dot';
  } else {
    scanInstruction.innerHTML = 'Now scan the <strong>back</strong> of the card';
    frontDot.className = 'step-dot done';
    backDot.className = 'step-dot active';
  }
}

async function startCamera() {
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 960 } },
      audio: false,
    });
    video.srcObject = stream;
    await video.play();
    placeholder.style.display = 'none';
    video.style.display = 'block';
    scanOverlay.classList.add('active');
    startCameraBtn.style.display = 'none';
    captureBtn.style.display = 'flex';
    retakeBtn.style.display = scanStep === 'back' ? 'inline-flex' : 'none';
    analyzeBtn.disabled = true;
  } catch {
    showError('Camera access denied or unavailable. Please use the description lookup instead.');
  }
}

function captureFrame() {
  const w = video.videoWidth;
  const h = video.videoHeight;
  canvas.width = w;
  canvas.height = h;
  canvas.getContext('2d').drawImage(video, 0, 0, w, h);
  const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
  const imageData = dataUrl.split(',')[1];

  const sidePreviews = document.querySelector('.side-previews');
  if (scanMode === 'one' || scanStep === 'back') {
    if (scanMode === 'one') {
      capturedFront = imageData;
      frontPreviewImg.src = dataUrl;
      frontPreviewImg.style.display = 'block';
      sidePreviews.classList.add('visible');
    } else {
      capturedBack = imageData;
      backPreviewImg.src = dataUrl;
      backPreviewImg.style.display = 'block';
    }
    stopCamera();
    video.style.display = 'none';
    scanOverlay.classList.remove('active');
    captureBtn.style.display = 'none';
    retakeBtn.style.display = 'inline-flex';
    analyzeBtn.disabled = false;
  } else {
    capturedFront = imageData;
    frontPreviewImg.src = dataUrl;
    frontPreviewImg.style.display = 'block';
    sidePreviews.classList.add('visible');
    setStep('back');
    retakeBtn.style.display = 'inline-flex';
  }
}

function stopCamera() {
  if (stream) {
    stream.getTracks().forEach((t) => t.stop());
    stream = null;
  }
}

function retake() {
  hideResults();
  // If the back has already been captured (analyze ready), retaking means starting over from the front.
  // If we're mid-flow on the back step (camera live), only clear the back.
  // In both-sides mode, retake always goes back to front regardless of step
  if (scanMode === 'both') {
    resetToStart();
    startCamera();
  } else {
    capturedFront = null;
    frontPreviewImg.style.display = 'none';
    frontPreviewImg.src = '';
    retakeBtn.style.display = 'none';
    startCamera();
  }
}

async function analyzeCard() {
  if (!capturedFront) return;
  if (scanMode === 'both' && !capturedBack) return;

  analyzingOverlay.classList.add('active');
  analyzeBtn.disabled = true;
  hideResults();

  try {
    const res = await fetch('/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        frontData: capturedFront,
        backData: scanMode === 'both' ? capturedBack : null,
        password: sessionPassword,
      }),
    });

    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || 'Server error');

    if (data.remaining != null) updateScansDisplay(data.remaining);
    if (data.card) {
      addToHistory(data.card, null, 'scan');
      displayResults(data.card);
    } else if (data.raw) {
      showError('Could not parse card data. Raw response: ' + data.raw.substring(0, 200));
    } else {
      showError('No card data returned.');
    }
  } catch (err) {
    showError(err.message || 'Failed to analyze card. Please try again.');
  } finally {
    analyzingOverlay.classList.remove('active');
    analyzeBtn.disabled = false;
  }
}

function displayResults(card, image) {
  resultsSection.classList.add('visible');
  errorCard.classList.remove('visible');

  const cardImageSection = document.getElementById('card-image-section');
  const cardResultImg = document.getElementById('card-result-img');
  if (image && image.data) {
    cardResultImg.src = `data:${image.contentType};base64,${image.data}`;
    cardImageSection.style.display = 'block';
  } else {
    cardImageSection.style.display = 'none';
  }

  document.getElementById('card-player').textContent = card.player || 'Unknown Player';
  document.getElementById('card-meta').textContent = [card.year, card.brand, card.cardNumber ? `#${card.cardNumber}` : null]
    .filter(Boolean).join(' · ');

  const confidence = card.confidence || 'low';
  const badge = document.getElementById('confidence-badge');
  badge.textContent = confidence;
  badge.className = `confidence-badge confidence-${confidence}`;

  const attrsEl = document.getElementById('attributes-list');
  attrsEl.innerHTML = '';
  const attrs = card.attributes || [];
  if (attrs.length > 0) {
    document.getElementById('attributes-section').style.display = 'flex';
    attrs.forEach((a) => {
      const span = document.createElement('span');
      span.className = 'attr-tag';
      span.textContent = a;
      attrsEl.appendChild(span);
    });
  } else {
    document.getElementById('attributes-section').style.display = 'none';
  }

  const fmt = (v) => v == null ? 'N/A' : v >= 1000 ? `$${(v / 1000).toFixed(1)}K` : `$${v}`;
  const grades = [
    { label: 'Raw (Ungraded)', key: 'raw' },
    { label: 'PSA 7', key: 'psa7' },
    { label: 'PSA 8', key: 'psa8' },
    { label: 'PSA 9', key: 'psa9' },
    { label: 'PSA 10', key: 'psa10' },
  ];

  const tbody = document.getElementById('price-table-body');
  tbody.innerHTML = '';
  grades.forEach(({ label, key }) => {
    const p = card.prices?.[key];
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${label}</td><td>${fmt(p?.low)}</td><td>${fmt(p?.high)}</td>`;
    tbody.appendChild(tr);
  });

  document.getElementById('pricing-notes').textContent = card.pricingNotes || '';
  resultsSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function hideResults() {
  resultsSection.classList.remove('visible');
  errorCard.classList.remove('visible');
}

function showError(msg) {
  errorCard.classList.add('visible');
  errorMsg.textContent = msg;
  resultsSection.classList.remove('visible');
  errorCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function resetToStart() {
  stopCamera();
  capturedFront = null;
  capturedBack = null;
  frontPreviewImg.style.display = 'none';
  frontPreviewImg.src = '';
  backPreviewImg.style.display = 'none';
  backPreviewImg.src = '';
  video.style.display = 'none';
  placeholder.style.display = 'flex';
  scanOverlay.classList.remove('active');
  startCameraBtn.style.display = 'inline-flex';
  captureBtn.style.display = 'none';
  retakeBtn.style.display = 'none';
  analyzeBtn.disabled = true;
  document.querySelector('.side-previews').classList.remove('visible');
  setStep('front');
  hideResults();
}

async function lookUpByDescription() {
  const text = cardDescription.value.trim();
  if (!text) return;

  analyzingOverlay.classList.add('active');
  describeBtn.disabled = true;
  hideResults();

  try {
    const res = await fetch('/api/lookup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description: text, password: sessionPassword }),
    });

    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || 'Server error');

    if (data.remaining != null) updateScansDisplay(data.remaining);
    if (data.card) {
      addToHistory(data.card, data.image || null, 'description');
      displayResults(data.card, data.image);
    } else {
      showError('Could not find pricing data for that description. Try adding more detail.');
    }
  } catch (err) {
    showError(err.message || 'Failed to look up card. Please try again.');
  } finally {
    analyzingOverlay.classList.remove('active');
    describeBtn.disabled = false;
  }
}

startCameraBtn.addEventListener('click', startCamera);
captureBtn.addEventListener('click', captureFrame);
retakeBtn.addEventListener('click', retake);
analyzeBtn.addEventListener('click', analyzeCard);
scanAgainBtn.addEventListener('click', resetToStart);
describeBtn.addEventListener('click', lookUpByDescription);

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

fetch('/api/version')
  .then((r) => r.json())
  .then(({ version }) => {
    const el = document.getElementById('app-version');
    if (el) el.textContent = `v${version}`;
  })
  .catch(() => {});
