/**
 * figma_uploader.js
 *
 * Handles all Figma-related logic in the popup:
 *  - Personal Access Token storage
 *  - Verifying the token with Figma's /me endpoint
 *  - "Open in Figma" flow (copies SVG to clipboard; user pastes into Figma)
 *
 * WHY clipboard instead of direct API insert?
 * The Figma REST API is READ-ONLY for node creation — you cannot programmatically
 * create vector nodes in a file via REST. The only programmatic way to INSERT nodes
 * is through the Figma Plugin API, which runs INSIDE Figma. From a Chrome extension,
 * the cleanest approach is to copy the SVG to the clipboard. Figma recognises SVG
 * paste natively and converts every element into Figma vector nodes automatically.
 */

'use strict';

const STORAGE_KEY_TOKEN = 'figma_pat'; // PAT = Personal Access Token
const STORAGE_KEY_USER  = 'figma_user';

// ──────────────────────────────────────────────────────────────
// Public API (called by popup.js)
// ──────────────────────────────────────────────────────────────
const FigmaUploader = {

  /**
   * Checks storage for a saved token and validates it with Figma.
   * Returns the user object if valid, null otherwise.
   */
  async getConnectedUser() {
    const token = await getStoredToken();
    if (!token) return null;
    return validateToken(token);
  },

  /**
   * Prompts the user for their Figma Personal Access Token,
   * validates it, and stores it.
   */
  async connect() {
    const token = prompt(
      'Enter your Figma Personal Access Token.\n\n' +
      'Get one at: Figma → Account Settings → Personal access tokens\n\n' +
      'The token is stored locally in this extension only.'
    );
    if (!token) return null;

    const user = await validateToken(token.trim());
    if (!user) {
      alert('Could not verify the token. Please check it and try again.');
      return null;
    }

    await chrome.storage.local.set({ [STORAGE_KEY_TOKEN]: token.trim(), [STORAGE_KEY_USER]: user });
    return user;
  },

  /** Removes stored token and user */
  async disconnect() {
    await chrome.storage.local.remove([STORAGE_KEY_TOKEN, STORAGE_KEY_USER]);
  },

  /**
   * Copies the SVG string to the clipboard so the user can paste it into Figma.
   * Figma accepts SVG paste on the canvas and converts it to vector nodes.
   *
   * @param {string} svgString — the full SVG markup
   * @returns {Promise<boolean>} true if successful
   */
  async copyToClipboard(svgString) {
    try {
      // Modern Clipboard API
      await navigator.clipboard.writeText(svgString);
      return true;
    } catch (_) {
      // Fallback for older environments
      const ta = document.createElement('textarea');
      ta.value = svgString;
      ta.style.position = 'fixed';
      ta.style.opacity  = '0';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    }
  },

  /**
   * Opens Figma in a new tab. The user pastes the SVG (already in clipboard).
   * Figma URL: https://www.figma.com
   */
  openFigma() {
    chrome.tabs.create({ url: 'https://www.figma.com' });
  }
};

// ──────────────────────────────────────────────────────────────
// Internal helpers
// ──────────────────────────────────────────────────────────────

async function getStoredToken() {
  return new Promise(resolve => {
    chrome.storage.local.get(STORAGE_KEY_TOKEN, result => {
      resolve(result[STORAGE_KEY_TOKEN] || null);
    });
  });
}

/**
 * Calls Figma /me endpoint via the background service worker
 * (which can make cross-origin requests).
 */
async function validateToken(token) {
  return new Promise(resolve => {
    chrome.runtime.sendMessage({ type: 'FIGMA_GET_ME', token }, response => {
      if (response && response.user && response.user.handle) {
        resolve(response.user);
      } else {
        resolve(null);
      }
    });
  });
}
