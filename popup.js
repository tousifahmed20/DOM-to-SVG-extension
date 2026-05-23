/**
 * popup.js — Extension Popup Controller (v2)
 *
 * UX changes:
 *  - "Capture Full Page" is now PRIMARY — clicking it immediately starts
 *    SVG generation (no separate "Generate" step needed).
 *  - Element picker stores its result in chrome.storage.session.
 *    On popup open, we read storage to restore any pending selection.
 *  - "Generate SVG" button remains for element/selector mode.
 */

'use strict';

const $ = id => document.getElementById(id);

// Hide Figma logo if the icon file is missing (no inline onerror allowed in MV3)
document.getElementById('figma-logo-img')
  ?.addEventListener('error', e => { e.target.style.display = 'none'; });

// ── DOM refs ─────────────────────────────────────────────────────
const btnPick         = $('btn-pick');
const btnSelector     = $('btn-selector');
const btnFullPage     = $('btn-fullpage');
const btnGenerate     = $('btn-generate');
const btnDownload     = $('btn-download');
const btnCopySvg      = $('btn-copy-svg');
const btnFigmaConnect = $('btn-figma-connect');
const btnFigmaPaste   = $('btn-figma-paste');
const btnFigmaDisc    = $('btn-figma-disconnect');
const inputSelector   = $('input-selector');
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
let currentSVG      = null;
let currentSelector = null;  // '__fullpage__' or a CSS/XPath string

// ═══════════════════════════════════════════════════════════════
// Init
// ═══════════════════════════════════════════════════════════════
(async function init() {
  // Check for Figma connection
  const user = await FigmaUploader.getConnectedUser();
  if (user) setFigmaConnected(user);

  // FIX: Check if element picker stored a result while the popup was closed.
  // The content script saves to session storage after a click, then asks the
  // background worker to reopen the popup. We read that result here.
  chrome.storage.session.get(['pickedSelector', 'pickedTag'], result => {
    if (result.pickedSelector) {
      setElementSelected(result.pickedTag || '?', result.pickedSelector);
      // Clear it so it doesn't persist on next open
      chrome.storage.session.remove(['pickedSelector', 'pickedTag']);
      setBanner('Element selected! Click "Generate SVG" when ready.', 'success');
    }
  });
})();

// ═══════════════════════════════════════════════════════════════
// Button Listeners
// ═══════════════════════════════════════════════════════════════

// PRIMARY BUTTON — Capture Full Page → immediately generate SVG
btnFullPage.addEventListener('click', async () => {
  currentSelector = '__fullpage__';
  setElementSelected('html', 'Entire Page');
  await generateSVG();   // start immediately, no extra click needed
});

// Element picker — closes popup, user clicks element, popup reopens via background
btnPick.addEventListener('click', async () => {
  await sendToContentScript({ type: 'ACTIVATE_PICKER' });
  setBanner('Hover over any element and click it…  (Esc to cancel)', 'picking');
  // Close popup so the user can interact with the page.
  // The content script will trigger a reopen once element is clicked.
  setTimeout(() => window.close(), 400);
});

// Manual CSS selector
btnSelector.addEventListener('click', async () => {
  const val = inputSelector.value.trim();
  if (!val) return;
  const res = await sendToContentScript({ type: 'RESOLVE_SELECTOR', selector: val });
  if (res?.error) { setBanner(res.error, 'error'); return; }
  if (res?.ok) setElementSelected(res.tag, res.selector || val);
});
inputSelector.addEventListener('keydown', e => { if (e.key === 'Enter') btnSelector.click(); });

// Generate SVG (used for element/selector mode — full page auto-generates above)
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
    setBanner('Pick an element, enter a selector, or click "Capture Full Page".', 'error');
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
      type:     'GENERATE_SVG',
      selector: currentSelector,
      options,
    });

    if (res?.error) {
      setBanner(`Error: ${res.error}`, 'error');
      return;
    }
    if (!res?.svg || res.svg.trim() === '') {
      setBanner('SVG came back empty. Try a different element or check the console.', 'error');
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

function setElementSelected(tag, selector) {
  currentSelector = selector;
  selectedTag.textContent = `<${tag}>  ${selector}`;
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

/**
 * Low-level: send a message to the content script in tabId.
 * Returns the response, or { error: '...' } on failure.
 */
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

/**
 * Sends a message to the content script on the active tab.
 *
 * If the content script isn't running yet (tab was open before the extension
 * was installed/reloaded), this injects it on-the-fly using chrome.scripting,
 * then retries the message once.
 */
async function sendToContentScript(message) {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return { error: 'No active tab.' };

    // chrome:// and extension pages block content script injection entirely
    if (tab.url?.startsWith('chrome://') ||
        tab.url?.startsWith('chrome-extension://') ||
        tab.url?.startsWith('about:')) {
      return { error: 'Cannot run on Chrome internal pages. Navigate to a regular website first.' };
    }

    // First attempt
    const first = await _postMessage(tab.id, message);

    // If the content script isn't loaded ("Receiving end does not exist"),
    // inject it now and retry once.
    const notLoaded =
      first?.error?.includes('Receiving end does not exist') ||
      first?.error?.includes('Could not establish connection');

    if (!notLoaded) return first;

    // Inject the content script programmatically (scripting permission is in manifest)
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['content_script.js'],
      });
    } catch (injectErr) {
      return { error: `Could not inject content script: ${injectErr.message}` };
    }

    // Give the script a moment to register its message listener
    await new Promise(r => setTimeout(r, 150));

    return _postMessage(tab.id, message);

  } catch (err) {
    return { error: err.message };
  }
}
