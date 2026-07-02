'use strict';

const video = document.getElementById('video');
const canvas = document.getElementById('canvas');
const previewImg = document.getElementById('preview-img');
const placeholder = document.getElementById('placeholder');
const scanOverlay = document.getElementById('scan-overlay');
const analyzingOverlay = document.getElementById('analyzing-overlay');
const startCameraBtn = document.getElementById('start-camera-btn');
const captureBtn = document.getElementById('capture-btn');
const retakeBtn = document.getElementById('retake-btn');
const analyzeBtn = document.getElementById('analyze-btn');
const fileInput = document.getElementById('file-input');
const resultsSection = document.getElementById('results-section');
const errorCard = document.getElementById('error-card');
const errorMsg = document.getElementById('error-msg');
const scanAgainBtn = document.getElementById('scan-again-btn');
const describeBtn = document.getElementById('describe-btn');
const cardDescription = document.getElementById('card-description');

let stream = null;
let capturedImageData = null;
let capturedMediaType = 'image/jpeg';
let cameraActive = false;

async function startCamera() {
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 960 } },
      audio: false,
    });
    video.srcObject = stream;
    await video.play();
    cameraActive = true;
    placeholder.style.display = 'none';
    video.style.display = 'block';
    scanOverlay.classList.add('active');
    startCameraBtn.style.display = 'none';
    captureBtn.style.display = 'flex';
    retakeBtn.style.display = 'none';
    analyzeBtn.disabled = true;
  } catch (err) {
    showError('Camera access denied or unavailable. Please upload an image instead.');
  }
}

function captureFrame() {
  const w = video.videoWidth;
  const h = video.videoHeight;
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(video, 0, 0, w, h);

  capturedMediaType = 'image/jpeg';
  capturedImageData = canvas.toDataURL('image/jpeg', 0.85).split(',')[1];

  previewImg.src = canvas.toDataURL('image/jpeg', 0.85);
  previewImg.style.display = 'block';
  video.style.display = 'none';
  scanOverlay.classList.remove('active');

  stopCamera();
  cameraActive = false;
  captureBtn.style.display = 'none';
  retakeBtn.style.display = 'inline-flex';
  analyzeBtn.disabled = false;
}

function stopCamera() {
  if (stream) {
    stream.getTracks().forEach((t) => t.stop());
    stream = null;
  }
}

function retake() {
  capturedImageData = null;
  previewImg.style.display = 'none';
  previewImg.src = '';
  retakeBtn.style.display = 'none';
  analyzeBtn.disabled = true;
  hideResults();
  startCamera();
}

function handleFileUpload(e) {
  const file = e.target.files[0];
  if (!file) return;
  stopCamera();
  cameraActive = false;

  capturedMediaType = file.type || 'image/jpeg';
  const reader = new FileReader();
  reader.onload = (ev) => {
    const dataUrl = ev.target.result;
    capturedImageData = dataUrl.split(',')[1];
    previewImg.src = dataUrl;
    previewImg.style.display = 'block';
    video.style.display = 'none';
    placeholder.style.display = 'none';
    scanOverlay.classList.remove('active');
    startCameraBtn.style.display = 'none';
    captureBtn.style.display = 'none';
    retakeBtn.style.display = 'inline-flex';
    analyzeBtn.disabled = false;
    hideResults();
  };
  reader.readAsDataURL(file);
  fileInput.value = '';
}

async function analyzeCard() {
  if (!capturedImageData) return;

  analyzingOverlay.classList.add('active');
  analyzeBtn.disabled = true;
  hideResults();

  try {
    const res = await fetch('/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ imageData: capturedImageData, mediaType: capturedMediaType }),
    });

    const data = await res.json();

    if (!res.ok || data.error) {
      throw new Error(data.error || 'Server error');
    }

    if (data.card) {
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

function displayResults(card) {
  resultsSection.classList.add('visible');
  errorCard.classList.remove('visible');

  document.getElementById('card-player').textContent = card.player || 'Unknown Player';
  document.getElementById('card-meta').textContent = [card.year, card.brand, card.cardNumber ? `#${card.cardNumber}` : null]
    .filter(Boolean)
    .join(' · ');

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
    tr.innerHTML = `
      <td>${label}</td>
      <td>${fmt(p?.low)}</td>
      <td>${fmt(p?.high)}</td>
    `;
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
  capturedImageData = null;
  previewImg.style.display = 'none';
  previewImg.src = '';
  video.style.display = 'none';
  placeholder.style.display = 'flex';
  scanOverlay.classList.remove('active');
  startCameraBtn.style.display = 'inline-flex';
  captureBtn.style.display = 'none';
  retakeBtn.style.display = 'none';
  analyzeBtn.disabled = true;
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
      body: JSON.stringify({ description: text }),
    });

    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || 'Server error');

    if (data.card) {
      displayResults(data.card);
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
fileInput.addEventListener('change', handleFileUpload);
scanAgainBtn.addEventListener('click', resetToStart);
describeBtn.addEventListener('click', lookUpByDescription);

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
