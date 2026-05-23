/**
 * background.js — Service Worker
 *
 * Responsibilities:
 *  1. Relay fetch requests from content_script (bypasses CORS for images)
 *  2. Handle Figma OAuth token exchange
 *  3. Cache Figma user info
 *
 * WHY a service worker?
 *  Content scripts run inside the web page's security context, so they are
 *  blocked by CORS when trying to fetch images from other domains.
 *  The service worker runs in the extension context and can fetch anything.
 */

'use strict';

// ──────────────────────────────────────────────────────────────
// Message router
// ──────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  switch (message.type) {
    case 'FETCH_IMAGE_AS_DATA_URI':
      fetchImageAsDataURI(message.url).then(sendResponse);
      return true;

    // FIX: After the user clicks an element during picking, the popup is
    // closed (user had to close it to interact with the page). The content
    // script fires REOPEN_POPUP → we call chrome.action.openPopup() here.
    // The popup will then read the stored selector from chrome.storage.session.
    case 'REOPEN_POPUP':
      chrome.action.openPopup().catch(() => {
        // openPopup() can fail if called outside a user gesture context.
        // As a fallback, update the badge so the user knows to click the icon.
        chrome.action.setBadgeText({ text: '!' });
        chrome.action.setBadgeBackgroundColor({ color: '#6366f1' });
        setTimeout(() => chrome.action.setBadgeText({ text: '' }), 5000);
      });
      sendResponse({ ok: true });
      break;

    case 'CAPTURE_VISIBLE_TAB':
      chrome.tabs.captureVisibleTab(null, { format: 'png' }, dataUrl => {
        if (chrome.runtime.lastError) {
          sendResponse({ error: chrome.runtime.lastError.message });
        } else {
          sendResponse({ dataUrl });
        }
      });
      return true;

    case 'FIGMA_EXCHANGE_TOKEN':
      exchangeFigmaToken(message.code, message.redirectUri).then(sendResponse);
      return true;

    case 'FIGMA_GET_ME':
      figmaGetMe(message.token).then(sendResponse);
      return true;

    case 'FIGMA_LIST_FILES':
      figmaListFiles(message.token).then(sendResponse);
      return true;
  }
});

// ──────────────────────────────────────────────────────────────
// Image fetching (CORS bypass)
// ──────────────────────────────────────────────────────────────

/**
 * Fetches an image URL and returns it as a Base64 data URI.
 * The content script calls this when it encounters a cross-origin image.
 *
 * @param {string} url — the image URL to fetch
 * @returns {Promise<{dataURI: string|null, error: string|null}>}
 */
async function fetchImageAsDataURI(url) {
  try {
    // Validate URL to avoid fetching arbitrary internal resources
    const parsed = new URL(url);
    if (!['http:', 'https:', 'data:'].includes(parsed.protocol)) {
      return { dataURI: null, error: 'Unsupported protocol' };
    }

    const response = await fetch(url, { mode: 'cors', credentials: 'omit' });
    if (!response.ok) {
      // Try no-cors as last resort (will return opaque body — can't read)
      return { dataURI: null, error: `HTTP ${response.status}` };
    }

    const blob = await response.blob();
    const dataURI = await blobToDataURI(blob);
    return { dataURI };
  } catch (err) {
    return { dataURI: null, error: err.message };
  }
}

/** Converts a Blob to a Base64 data URI using FileReader */
function blobToDataURI(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('FileReader error'));
    reader.readAsDataURL(blob);
  });
}

// ──────────────────────────────────────────────────────────────
// Figma REST API helpers
// ──────────────────────────────────────────────────────────────
const FIGMA_API = 'https://api.figma.com/v1';

/**
 * Exchanges a Figma OAuth authorization code for an access token.
 * You need to set up a tiny redirect server or use Figma's implicit flow.
 * For simplicity we support the Personal Access Token approach here too.
 */
async function exchangeFigmaToken(code, redirectUri) {
  // NOTE: Real OAuth token exchange requires a backend because it needs
  // your client_secret. For a client-only extension, use a Personal Access
  // Token instead (entered by the user in the popup).
  // This function is a placeholder for when you add a backend proxy.
  return { error: 'Token exchange requires a backend proxy. Use a Personal Access Token.' };
}

/**
 * Gets the authenticated Figma user's info.
 * @param {string} token — Figma personal access token or OAuth bearer token
 */
async function figmaGetMe(token) {
  try {
    const res = await fetch(`${FIGMA_API}/me`, {
      headers: { 'X-Figma-Token': token }
    });
    if (!res.ok) return { error: `Figma API error: ${res.status}` };
    const data = await res.json();
    return { user: data };
  } catch (err) {
    return { error: err.message };
  }
}

/**
 * Lists the Figma files the user has access to (recent files).
 * @param {string} token
 */
async function figmaListFiles(token) {
  try {
    // Figma doesn't have a "list all files" endpoint for regular users.
    // We fetch recent projects from the user's teams instead.
    const meRes = await fetch(`${FIGMA_API}/me`, {
      headers: { 'X-Figma-Token': token }
    });
    if (!meRes.ok) return { error: `Figma API error: ${meRes.status}` };
    const me = await meRes.json();
    return { user: me, note: 'Use Figma desktop/web to browse files. Extension exports SVG you can paste directly into Figma.' };
  } catch (err) {
    return { error: err.message };
  }
}
