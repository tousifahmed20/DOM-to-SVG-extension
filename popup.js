'use strict';

const $ = id => document.getElementById(id);

// Hide Figma logo if the icon file is missing (no inline onerror allowed in MV3)
document.getElementById('figma-logo-img')
  ?.addEventListener('error', e => { e.target.style.display = 'none'; });

// ── DOM refs ─────────────────────────────────────────────────────
const btnFullPage     = $('btn-fullpage');
const btnViewport     = $('btn-viewport');
const btnAreaSelect   = $('btn-area-select');
const btnGenerate     = $('btn-generate');
const btnDownload     = $('btn-download');
const btnCopySvg      = $('btn-copy-svg');
const btnFigmaConnect = $('btn-figma-connect');
const btnFigmaPaste   = $('btn-figma-paste');
const btnFigmaDisc    = $('btn-figma-disconnect');
const selectedInfo    = $('selected-info');
const selectedTag     = $('selected-tag');
const statusBanner    = $('status-banner');
const progressBar     = $('progress-bar');
const previewContainer= $('preview-container');
const svgPreview      = $('svg-preview');
const previewSize     = $('preview-size');
const figmaConnected  = $('figma-connected');
const figmaNotConn    = $('figma-not-connected');
const figmaUserEl     = $('figma-user');
const optChildren     = $('opt-include-children');
const optImages       = $('opt-include-images');
const optShadows      = $('opt-include-shadows');
const optShadowDom    = $('opt-shadow-dom');

// ── State ────────────────────────────────────────────────────────
let currentSVG           = null;
let currentSelector      = null;   // '__fullpage__' | '__viewport__' | '__area__'
let currentAreaSelection = null;   // { x, y, w, h } page-absolute coords — only for __area__

// ═══════════════════════════════════════════════════════════════
// Init
// ═══════════════════════════════════════════════════════════════
(async function init() {
  // Read pending area-selection state FIRST — before any async Figma check.
  // If FigmaUploader.getConnectedUser() runs first it can block for several
  // seconds while the service worker wakes up, leaving the button disabled.
  chrome.storage.session.get(['areaSelection'], result => {
    if (result.areaSelection) {
      currentAreaSelection = result.areaSelection;
      chrome.storage.session.remove(['areaSelection']);
      const { w, h } = currentAreaSelection;
      setElementSelected('area', `${Math.round(w)} × ${Math.round(h)} px`, '__area__');
      setBanner('Area captured! Click "Generate SVG" to export.', 'success');
    }
  });

  // Figma check is intentionally after the storage read — it may be slow.
  const user = await FigmaUploader.getConnectedUser().catch(() => null);
  if (user) setFigmaConnected(user);
})();

// ═══════════════════════════════════════════════════════════════
// Button Listeners
// ═══════════════════════════════════════════════════════════════

btnFullPage.addEventListener('click', async () => {
  setElementSelected('html', 'Entire Page', '__fullpage__');
  await generateSVG();
});

btnViewport.addEventListener('click', async () => {
  setElementSelected('viewport', 'Visible Screen', '__viewport__');
  await generateSVG();
});

// Closes popup so the user can draw a rectangle on the page.
// The content script stores the area coords and sends REOPEN_POPUP when done.
btnAreaSelect.addEventListener('click', async () => {
  await sendToContentScript({ type: 'ACTIVATE_AREA_SELECTOR' });
  setBanner('Draw a rectangle on the page… (Esc to cancel)', 'picking');
  setTimeout(() => window.close(), 400);
});

btnGenerate.addEventListener('click', generateSVG);

btnDownload.addEventListener('click', downloadSVG);

btnCopySvg.addEventListener('click', async () => {
  if (!currentSVG) return;
  const ok = await FigmaUploader.copyToClipboard(currentSVG);
  setBanner(
    ok ? 'SVG copied! Paste into Figma with Ctrl+V.' : 'Clipboard copy failed.',
    ok ? 'success' : 'error'
  );
});

btnFigmaConnect.addEventListener('click', async () => {
  const user = await FigmaUploader.connect();
  if (user) setFigmaConnected(user);
});

btnFigmaDisc.addEventListener('click', async () => {
  await FigmaUploader.disconnect();
  figmaConnected.classList.add('hidden');
  figmaNotConn.classList.remove('hidden');
  setBanner('Figma disconnected.', 'info');
});

btnFigmaPaste.addEventListener('click', async () => {
  if (!currentSVG) return;
  await FigmaUploader.copyToClipboard(currentSVG);
  FigmaUploader.openFigma();
  setBanner('SVG copied! Paste (Ctrl+V) anywhere on the Figma canvas.', 'success');
});

// ═══════════════════════════════════════════════════════════════
// Core: Generate SVG
// ═══════════════════════════════════════════════════════════════

async function generateSVG() {
  if (!currentSelector) {
    setBanner('Choose a capture mode above first.', 'error');
    return;
  }

  const options = {
    includeChildren: optChildren.checked,
    includeImages:   optImages.checked,
    includeShadows:  optShadows.checked,
    shadowDOM:       optShadowDom.checked,
  };

  showProgress();
  setBanner(
    currentSelector === '__fullpage__'
      ? 'Capturing entire page — may take a few seconds…'
      : 'Generating SVG…',
    'info'
  );
  btnGenerate.disabled = true;
  btnFullPage.disabled = true;
  currentSVG = null;

  try {
    const res = await sendToContentScript({
      type:          'GENERATE_SVG',
      selector:      currentSelector,
      areaSelection: currentAreaSelection,
      options,
    });

    if (res?.error) {
      setBanner(`Error: ${res.error}`, 'error');
      return;
    }
    if (!res?.svg || res.svg.trim() === '') {
      setBanner('SVG came back empty. Try a different area or check the console.', 'error');
      return;
    }

    currentSVG = res.svg;
    showPreview(currentSVG);
    setBanner('Done! Download or copy the SVG below.', 'success');
    btnDownload.classList.remove('hidden');
    btnCopySvg.classList.remove('hidden');
    if (!figmaConnected.classList.contains('hidden')) btnFigmaPaste.disabled = false;

  } catch (err) {
    setBanner(`Unexpected error: ${err.message}`, 'error');
  } finally {
    hideProgress();
    btnGenerate.disabled = false;
    btnFullPage.disabled = false;
  }
}

// ═══════════════════════════════════════════════════════════════
// Download
// ═══════════════════════════════════════════════════════════════

function downloadSVG() {
  if (!currentSVG) return;
  const blob     = new Blob([currentSVG], { type: 'image/svg+xml' });
  const url      = URL.createObjectURL(blob);
  const filename = `dom-export-${Date.now()}.svg`;

  chrome.downloads.download({ url, filename, saveAs: false }, () => {
    URL.revokeObjectURL(url);
    if (chrome.runtime.lastError) {
      setBanner(`Download failed: ${chrome.runtime.lastError.message}`, 'error');
    } else {
      setBanner(`Saved as ${filename}`, 'success');
    }
  });
}

// ═══════════════════════════════════════════════════════════════
// UI helpers
// ═══════════════════════════════════════════════════════════════

// displayText is shown in the UI; selectorValue is the sentinel sent to content script.
function setElementSelected(tag, displayText, selectorValue) {
  currentSelector = selectorValue !== undefined ? selectorValue : displayText;
  selectedTag.textContent = `<${tag}>  ${displayText}`;
  selectedInfo.classList.remove('hidden');
  btnGenerate.disabled = false;
}

function setFigmaConnected(user) {
  figmaUserEl.textContent = user.handle || user.email || 'user';
  figmaConnected.classList.remove('hidden');
  figmaNotConn.classList.add('hidden');
}

function showPreview(svgString) {
  svgPreview.innerHTML = svgString;
  const svgEl = svgPreview.querySelector('svg');
  if (svgEl) {
    svgEl.style.maxWidth  = '100%';
    svgEl.style.maxHeight = '110px';
  }
  const bytes = new Blob([svgString]).size;
  previewSize.textContent = formatBytes(bytes);
  previewContainer.classList.remove('hidden');
}

function formatBytes(b) {
  if (b < 1024)        return `${b} B`;
  if (b < 1024 * 1024) return `${(b/1024).toFixed(1)} KB`;
  return `${(b/1024/1024).toFixed(2)} MB`;
}

function setBanner(text, type = 'info') {
  statusBanner.textContent = text;
  statusBanner.className   = `banner ${type}`;
  statusBanner.classList.remove('hidden');
}

function showProgress() { progressBar.classList.remove('hidden'); }
function hideProgress()  { progressBar.classList.add('hidden'); }

// ═══════════════════════════════════════════════════════════════
// Messaging
// ═══════════════════════════════════════════════════════════════

function _postMessage(tabId, message) {
  return new Promise(resolve => {
    chrome.tabs.sendMessage(tabId, message, res => {
      if (chrome.runtime.lastError) {
        resolve({ error: chrome.runtime.lastError.message });
      } else {
        resolve(res);
      }
    });
  });
}

async function sendToContentScript(message) {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return { error: 'No active tab.' };

    if (tab.url?.startsWith('chrome://') ||
        tab.url?.startsWith('chrome-extension://') ||
        tab.url?.startsWith('about:')) {
      return { error: 'Cannot run on Chrome internal pages. Navigate to a regular website first.' };
    }

    const first = await _postMessage(tab.id, message);

    const notLoaded =
      first?.error?.includes('Receiving end does not exist') ||
      first?.error?.includes('Could not establish connection');

    if (!notLoaded) return first;

    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['content_script.js'],
      });
    } catch (injectErr) {
      return { error: `Could not inject content script: ${injectErr.message}` };
    }

    await new Promise(r => setTimeout(r, 150));
    return _postMessage(tab.id, message);

  } catch (err) {
    return { error: err.message };
  }
}
