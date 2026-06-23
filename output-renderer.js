'use strict';

const video = document.getElementById('output-video');
const noOutput = document.getElementById('no-output');
const cogBtn = document.getElementById('output-cog');
const outputMenu = document.getElementById('output-menu');
const btnReturnMain = document.getElementById('btn-return-main');

const outExposure = document.getElementById('out-exposure');
const outExposureVal = document.getElementById('out-exposure-val');
const outContrast = document.getElementById('out-contrast');
const outContrastVal = document.getElementById('out-contrast-val');
const outSaturation = document.getElementById('out-saturation');
const outSaturationVal = document.getElementById('out-saturation-val');

if (cogBtn && outputMenu) {
  cogBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    outputMenu.classList.toggle('hidden');
  });
  document.body.addEventListener('click', () => outputMenu.classList.add('hidden'));
  outputMenu.addEventListener('click', (e) => e.stopPropagation());
}

if (btnReturnMain) {
  btnReturnMain.addEventListener('click', () => {
    if (window.electronAPI?.closeOutputWindow) {
      window.electronAPI.closeOutputWindow();
    } else {
      window.close();
    }
  });
}

function safeGetAdjustment(name, fallback) {
  try {
    if (window.opener && typeof window.opener.getVideoAdjustment === 'function') {
      return window.opener.getVideoAdjustment(name);
    }
  } catch {}
  return fallback;
}

function safeSetAdjustment(name, value) {
  try {
    if (window.opener && typeof window.opener.setVideoAdjustment === 'function') {
      window.opener.setVideoAdjustment(name, value);
    }
  } catch {}
}

function syncOutputSlider(input, valueEl, value) {
  if (input) input.value = value;
  if (valueEl) valueEl.textContent = value;
}

function initSliders() {
  const exposure = safeGetAdjustment('exposure', 0);
  const contrast = safeGetAdjustment('contrast', 0);
  const saturation = safeGetAdjustment('saturation', 0);
  syncOutputSlider(outExposure, outExposureVal, exposure);
  syncOutputSlider(outContrast, outContrastVal, contrast);
  syncOutputSlider(outSaturation, outSaturationVal, saturation);
}

function bindOutputSlider(input, valueEl, name) {
  if (!input) return;
  input.addEventListener('input', (e) => {
    const val = parseInt(e.target.value, 10);
    if (valueEl) valueEl.textContent = val;
    safeSetAdjustment(name, val);
  });
}

bindOutputSlider(outExposure, outExposureVal, 'exposure');
bindOutputSlider(outContrast, outContrastVal, 'contrast');
bindOutputSlider(outSaturation, outSaturationVal, 'saturation');

function startCapture() {
  if (!window.opener) {
    noOutput.textContent = 'Output window must be opened from the main window.';
    return;
  }
  try {
    const canvas = window.opener.document.getElementById('vcam-canvas');
    if (!canvas) {
      noOutput.textContent = 'No processed video canvas found in the main window.';
      return;
    }
    const stream = canvas.captureStream(30);
    video.srcObject = stream;
    noOutput.classList.add('hidden');
    video.classList.remove('hidden');
    console.log('[output] canvas stream started');
  } catch (err) {
    noOutput.textContent = 'Failed to capture output: ' + err.message;
    console.error('[output] capture error:', err.name, err.message, err.code);
  }
}

startCapture();
initSliders();
