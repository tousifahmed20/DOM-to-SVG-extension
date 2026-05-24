/**
 * content_script.js — DOM Capture & SVG Generation (v4 — flat, editable SVG)
 *
 * Produces a FLAT SVG (no deep nesting) so every shape is independently
 * selectable and editable in Figma:
 *
 *  1. Walk the DOM in depth-first order, collecting all visible elements.
 *  2. Sort them by CSS paint order (inherited z-index aware).
 *  3. Emit each element as SVG primitives: <rect>, <text>, <image>, etc.
 *
 * No foreignObject — Figma can handle every element in the output.
 */

(function () {
  'use strict';

  // ═══════════════════════════════════════════════════════════════
  // SECTION 1 — State
  // ═══════════════════════════════════════════════════════════════

  let pickerActive = false;
  let hoveredEl    = null;
  let highlightDiv = null;
  let tooltipDiv   = null;
  let _svgInlineSeq = 0; // unique prefix for namespacing IDs inside inlined SVGs

  let areaSelectorActive = false;
  let areaStartX         = 0;
  let areaStartY         = 0;
  let areaOverlayDiv     = null;
  let areaRectDiv        = null;

  // ═══════════════════════════════════════════════════════════════
  // SECTION 2 — Element Picker
  // ═══════════════════════════════════════════════════════════════

  function activatePicker() {
    if (pickerActive) return;
    pickerActive = true;

    highlightDiv = document.createElement('div');
    Object.assign(highlightDiv.style, {
      position:      'fixed',
      zIndex:        '2147483646',
      pointerEvents: 'none',
      border:        '2px solid #6366f1',
      background:    'rgba(99,102,241,0.08)',
      borderRadius:  '3px',
      boxShadow:     '0 0 0 1px rgba(99,102,241,0.3)',
      display:       'none',
      boxSizing:     'border-box',
    });
    document.documentElement.appendChild(highlightDiv);

    tooltipDiv = document.createElement('div');
    Object.assign(tooltipDiv.style, {
      position:      'fixed',
      zIndex:        '2147483647',
      pointerEvents: 'none',
      background:    '#6366f1',
      color:         '#fff',
      fontSize:      '11px',
      fontFamily:    'monospace',
      padding:       '2px 7px',
      borderRadius:  '3px',
      display:       'none',
      maxWidth:      '300px',
      overflow:      'hidden',
      textOverflow:  'ellipsis',
      whiteSpace:    'nowrap',
    });
    document.documentElement.appendChild(tooltipDiv);

    document.addEventListener('mousemove', onPickerMove,  true);
    document.addEventListener('click',     onPickerClick, true);
    document.addEventListener('keydown',   onPickerKey,   true);
  }

  function deactivatePicker() {
    pickerActive = false;
    document.removeEventListener('mousemove', onPickerMove,  true);
    document.removeEventListener('click',     onPickerClick, true);
    document.removeEventListener('keydown',   onPickerKey,   true);
    highlightDiv?.remove(); highlightDiv = null;
    tooltipDiv?.remove();   tooltipDiv   = null;
    hoveredEl = null;
  }

  function onPickerMove(e) {
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || el === hoveredEl) return;
    hoveredEl = el;
    const rect = el.getBoundingClientRect();
    Object.assign(highlightDiv.style, {
      display: 'block',
      top:    `${rect.top}px`,
      left:   `${rect.left}px`,
      width:  `${rect.width}px`,
      height: `${rect.height}px`,
    });
    tooltipDiv.textContent = `<${el.tagName.toLowerCase()}> ${getStableSelector(el)}`;
    Object.assign(tooltipDiv.style, {
      display: 'block',
      top:    `${Math.max(0, rect.top - 24)}px`,
      left:   `${Math.max(0, rect.left)}px`,
    });
  }

  function onPickerClick(e) {
    e.preventDefault();
    e.stopPropagation();
    const el       = e.target;
    const selector = getStableSelector(el);
    deactivatePicker();
    chrome.storage.session.set({
      pickedSelector: selector,
      pickedTag:      el.tagName.toLowerCase(),
    }, () => chrome.runtime.sendMessage({ type: 'REOPEN_POPUP' }));
  }

  function onPickerKey(e) {
    if (e.key === 'Escape') {
      deactivatePicker();
      chrome.storage.session.remove(['pickedSelector', 'pickedTag']);
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // SECTION 2b — Area Selector (drag-to-capture)
  // ═══════════════════════════════════════════════════════════════

  function activateAreaSelector() {
    if (areaSelectorActive) return;
    areaSelectorActive = true;

    // Transparent full-screen overlay to intercept all mouse events
    areaOverlayDiv = document.createElement('div');
    Object.assign(areaOverlayDiv.style, {
      position:   'fixed',
      inset:      '0',
      zIndex:     '2147483646',
      cursor:     'crosshair',
    });
    document.documentElement.appendChild(areaOverlayDiv);

    // The rubber-band selection rectangle
    areaRectDiv = document.createElement('div');
    Object.assign(areaRectDiv.style, {
      position:      'fixed',
      zIndex:        '2147483647',
      border:        '2px solid #6366f1',
      background:    'rgba(99,102,241,0.08)',
      boxShadow:     '0 0 0 1px rgba(99,102,241,0.3)',
      display:       'none',
      pointerEvents: 'none',
      boxSizing:     'border-box',
    });
    document.documentElement.appendChild(areaRectDiv);

    areaOverlayDiv.addEventListener('mousedown', onAreaDown, true);
    document.addEventListener('keydown', onAreaKey, true);
  }

  function deactivateAreaSelector() {
    areaSelectorActive = false;
    areaOverlayDiv?.removeEventListener('mousedown', onAreaDown, true);
    document.removeEventListener('keydown', onAreaKey, true);
    areaOverlayDiv?.remove(); areaOverlayDiv = null;
    areaRectDiv?.remove();    areaRectDiv    = null;
  }

  function onAreaDown(e) {
    e.preventDefault();
    areaStartX = e.clientX;
    areaStartY = e.clientY;
    Object.assign(areaRectDiv.style, {
      display: 'block',
      left: `${areaStartX}px`, top: `${areaStartY}px`,
      width: '0', height: '0',
    });
    areaOverlayDiv.addEventListener('mousemove', onAreaMove, true);
    areaOverlayDiv.addEventListener('mouseup',   onAreaUp,   true);
  }

  function onAreaMove(e) {
    const x = Math.min(e.clientX, areaStartX);
    const y = Math.min(e.clientY, areaStartY);
    const w = Math.abs(e.clientX - areaStartX);
    const h = Math.abs(e.clientY - areaStartY);
    Object.assign(areaRectDiv.style, {
      left: `${x}px`, top: `${y}px`,
      width: `${w}px`, height: `${h}px`,
    });
  }

  function onAreaUp(e) {
    areaOverlayDiv.removeEventListener('mousemove', onAreaMove, true);
    areaOverlayDiv.removeEventListener('mouseup',   onAreaUp,   true);

    const x = Math.min(e.clientX, areaStartX);
    const y = Math.min(e.clientY, areaStartY);
    const w = Math.abs(e.clientX - areaStartX);
    const h = Math.abs(e.clientY - areaStartY);

    deactivateAreaSelector();

    if (w < 8 || h < 8) {
      chrome.storage.session.remove(['areaSelection']);
      return;
    }

    // Store as page-absolute coords (viewport coords + scroll offset)
    chrome.storage.session.set({
      areaSelection: { x: x + window.scrollX, y: y + window.scrollY, w, h },
    }, () => {
      // Try to reopen the popup. On Chrome 127+ openPopup() requires a direct
      // user-gesture context in the service worker, so it may fail — we show a
      // prominent toast so the user knows to click the extension icon manually.
      chrome.runtime.sendMessage({ type: 'REOPEN_POPUP' });
      showAreaCaptureToast(Math.round(w), Math.round(h));
    });
  }

  function showAreaCaptureToast(w, h) {
    const toast = document.createElement('div');
    Object.assign(toast.style, {
      position:      'fixed',
      bottom:        '20px',
      right:         '20px',
      zIndex:        '2147483647',
      background:    '#6366f1',
      color:         '#fff',
      padding:       '10px 16px',
      borderRadius:  '8px',
      fontFamily:    'system-ui, -apple-system, sans-serif',
      fontSize:      '13px',
      fontWeight:    '500',
      boxShadow:     '0 4px 16px rgba(0,0,0,0.35)',
      opacity:       '1',
      transition:    'opacity 0.4s',
      pointerEvents: 'none',
      lineHeight:    '1.4',
    });
    toast.textContent = `✓ Area captured (${w} × ${h} px) — click the extension icon to generate SVG`;
    document.documentElement.appendChild(toast);
    setTimeout(() => { toast.style.opacity = '0'; setTimeout(() => toast.remove(), 400); }, 5000);
  }

  function onAreaKey(e) {
    if (e.key === 'Escape') {
      deactivateAreaSelector();
      chrome.storage.session.remove(['areaSelection']);
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // SECTION 3 — Stable Selector (Angular-aware)
  // ═══════════════════════════════════════════════════════════════

  function getStableSelector(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return '';
    for (const attr of ['data-testid', 'data-cy', 'data-qa', 'data-id']) {
      const v = el.getAttribute(attr);
      if (v) return `[${attr}="${CSS.escape(v)}"]`;
    }
    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel) return `[aria-label="${CSS.escape(ariaLabel)}"]`;
    const tag = el.tagName.toLowerCase();
    if (tag.includes('-')) {
      const sibs = Array.from(el.parentElement?.children || []).filter(c => c.tagName === el.tagName);
      return sibs.length === 1 ? tag : `${tag}:nth-of-type(${sibs.indexOf(el) + 1})`;
    }
    if (el.classList.length) {
      const stables = Array.from(el.classList)
        .filter(c => !c.startsWith('_ng') && !c.startsWith('ng-') && !/\d{3,}/.test(c));
      if (stables.length) {
        const sel = `.${stables.slice(0, 2).map(CSS.escape).join('.')}`;
        try { if (document.querySelectorAll(sel).length === 1) return sel; } catch (_) {}
      }
    }
    const role = el.getAttribute('role');
    if (role) return `[role="${role}"]`;
    return getXPath(el);
  }

  function getXPath(el) {
    const parts = [];
    let node = el;
    while (node && node.nodeType === Node.ELEMENT_NODE && node !== document.documentElement) {
      const tag    = node.tagName.toLowerCase();
      const parent = node.parentElement;
      if (parent) {
        const sibs = Array.from(parent.children).filter(c => c.tagName === node.tagName);
        parts.unshift(sibs.length > 1 ? `${tag}[${sibs.indexOf(node) + 1}]` : tag);
      } else {
        parts.unshift(tag);
      }
      node = parent;
    }
    return '//' + parts.join('/');
  }

  function resolveSelector(sel) {
    if (!sel) return null;
    if (sel === '__fullpage__') return document.documentElement;
    if (sel.startsWith('//') || sel.startsWith('/html')) {
      return document.evaluate(sel, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
    }
    try { return document.querySelector(sel); } catch (_) { return null; }
  }

  // ═══════════════════════════════════════════════════════════════
  // SECTION 4 — Core utilities
  // ═══════════════════════════════════════════════════════════════

  /** Round to 2 decimal places */
  const r = n => Math.round(n * 100) / 100;

  /** Escape XML special chars */
  const xe = s => String(s ?? '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

  /** True if color string is fully transparent */
  function isTransparent(c) {
    return !c || c === 'transparent' || c === 'rgba(0, 0, 0, 0)';
  }

  /** Parse border-radius → {rx, ry} or null */
  function parseBR(st, w, h) {
    const raw = parseFloat(st.borderTopLeftRadius) || 0;
    if (!raw) return null;
    return { rx: r(Math.min(raw, w / 2)), ry: r(Math.min(raw, h / 2)) };
  }

  /**
   * Detects icon fonts (Material Icons, Font Awesome, etc.) whose text content
   * is ligature names or Unicode codepoints, not readable text.
   * These must be rasterized via canvas so the actual glyph is captured.
   */
  const ICON_FONT_RE = /material.?icon|material.?symbol|google.?symbol|google.?icon|font.?awesome|fontawesome|glyphicon|ionicon|feather|remixicon|lucide|bootstrap.?icon|themify|typicon/i;

  function isIconFont(fontFamily) {
    return fontFamily ? ICON_FONT_RE.test(fontFamily) : false;
  }

  // Google Font family names we can auto-detect by name and fetch from the public API.
  const KNOWN_GOOGLE_FONTS = [
    'Google Sans','Google Sans Text','Google Sans Display','Google Sans Mono',
    'Product Sans','Roboto','Roboto Mono','Roboto Slab','Open Sans','Lato',
    'Montserrat','Noto Sans','Noto Serif','Poppins','Inter','Nunito','Nunito Sans',
    'Raleway','Ubuntu','Oswald','Merriweather','PT Sans','Source Sans Pro','Source Sans 3',
  ];

  /**
   * Given the set of font families actually used in the captured layers, fetches
   * the matching @font-face CSS from Google Fonts and returns it as a string ready
   * to embed inside an SVG <style><![CDATA[...]]></style> block.
   *
   * Detection priority:
   *  1. <link rel="stylesheet"> pointing to fonts.googleapis.com
   *  2. @import rules inside <style> blocks
   *  3. Family name match against KNOWN_GOOGLE_FONTS → constructs a URL automatically
   *
   * Fetching the CSS (rather than doing @import) inlines the @font-face rules with
   * absolute fonts.gstatic.com URLs, so the SVG renders correctly in any browser
   * without needing to re-download the Google Fonts stylesheet.
   */
  async function buildFontStyleCSS(usedFamilies) {
    const gfUrls = new Set();

    // (1) <link rel="stylesheet" href="https://fonts.googleapis.com/...">
    for (const el of document.querySelectorAll('link[rel="stylesheet"][href]')) {
      try { if (new URL(el.href).hostname === 'fonts.googleapis.com') gfUrls.add(el.href); }
      catch {}
    }
    // (2) @import url('https://fonts.googleapis.com/...') inside <style> blocks
    for (const style of document.querySelectorAll('style')) {
      for (const m of style.textContent.matchAll(
        /@import\s+url\(['"](https:\/\/fonts\.googleapis\.com[^'"]+)['"]\)/g)) {
        gfUrls.add(m[1]);
      }
    }
    // (3) No link found — detect Google Font families from computed styles and build URL
    if (!gfUrls.size) {
      const detected = [];
      for (const raw of usedFamilies) {
        const family = raw.replace(/['"]/g, '').trim();
        if (KNOWN_GOOGLE_FONTS.some(g => g.toLowerCase() === family.toLowerCase())) {
          detected.push(family);
        }
      }
      if (detected.length) {
        const params = detected
          .map(f => `family=${encodeURIComponent(f)}:ital,wght@0,100..900;1,100..900`)
          .join('&');
        gfUrls.add(`https://fonts.googleapis.com/css2?${params}&display=swap`);
      }
    }

    if (!gfUrls.size) return '';

    // Fetch each Google Fonts CSS URL and extract the @font-face blocks.
    // Content scripts with <all_urls> host permission can make these cross-origin requests.
    const fontFaceRules = [];
    for (const url of gfUrls) {
      try {
        const resp = await fetch(url, { mode: 'cors' });
        if (!resp.ok) continue;
        const css = await resp.text();
        // @font-face rules in Google Fonts CSS never contain nested braces, so this is safe.
        const blocks = css.match(/@font-face\s*\{[^}]+\}/g) || [];
        for (const block of blocks) {
          // Only keep rules for families we actually use
          const m = block.match(/font-family\s*:\s*['"]?([^'";,]+)/);
          const family = m?.[1]?.replace(/['"]/g, '').trim();
          if (!family || usedFamilies.has(family)) fontFaceRules.push(block);
        }
      } catch {}
    }

    return fontFaceRules.join('\n');
  }

  /**
   * Renders an icon-font element onto a canvas and returns an SVG <image>.
   * The page already has the icon font loaded, so canvas.fillText() will draw
   * the actual glyph — not the ligature name like "expand_more".
   */
  async function buildIconViaCanvas(layer) {
    const { el, st, x, y, w, h } = layer;
    const text = el.textContent?.trim();
    if (!text || w < 1 || h < 1) return '';
    const dpr    = window.devicePixelRatio || 1;
    const canvas = document.createElement('canvas');
    canvas.width  = Math.max(Math.ceil(w * dpr), 1);
    canvas.height = Math.max(Math.ceil(h * dpr), 1);
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.font         = `${st.fontWeight || '400'} ${st.fontSize || '24px'} ${st.fontFamily}`;
    ctx.fillStyle    = st.color || '#000000';
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, w / 2, h / 2);
    const dataUrl = canvas.toDataURL('image/png');
    return `<image href="${dataUrl}" x="${r(x)}" y="${r(y)}" width="${r(w)}" height="${r(h)}" preserveAspectRatio="xMidYMid meet"/>`;
  }

  /**
   * Renders a CSS mask-image icon to a canvas PNG by compositing the fill colour
   * through the mask's alpha channel.  Returns a data URI.
   *
   * WHY: SVG <mask> elements are silently dropped by Figma's importer, so any
   * icon that fails vector extraction would be invisible in Figma. A canvas PNG
   * is universally supported.
   *
   * maskHref MUST be a data URI (already resolved by the service worker).
   */
  async function maskToColoredPng(maskHref, fillColor, w, h) {
    const dpr = window.devicePixelRatio || 1;
    const pw  = Math.max(Math.ceil(w * dpr), 1);
    const ph  = Math.max(Math.ceil(h * dpr), 1);

    const img = await new Promise((resolve, reject) => {
      const i  = new Image();
      i.onload  = () => resolve(i);
      i.onerror = () => reject(new Error('mask img load failed'));
      i.src = maskHref;
    });

    const cv  = document.createElement('canvas');
    cv.width  = pw;
    cv.height = ph;
    const ctx = cv.getContext('2d');
    ctx.scale(dpr, dpr);

    // 1. Fill with the target icon colour
    ctx.fillStyle = fillColor;
    ctx.fillRect(0, 0, w, h);

    // 2. Use destination-in to clip the fill through the mask image alpha channel
    ctx.globalCompositeOperation = 'destination-in';
    ctx.drawImage(img, 0, 0, w, h);

    return cv.toDataURL('image/png');
  }

  /**
   * Renders a CSS pseudo-element icon (::before / ::after) onto a canvas.
   * Handles icon-font elements that are empty in the DOM but have their glyph
   * set via CSS content (e.g. Angular Material's <i class="material-icons-extended">).
   */
  async function buildPseudoIconViaCanvas(layer) {
    const { el, st, x, y, w, h } = layer;
    if (w < 1 || h < 1) return '';

    for (const pseudo of ['::before', '::after']) {
      const ps  = window.getComputedStyle(el, pseudo);
      const raw = ps.content;
      if (!raw || raw === 'none' || raw === 'normal') continue;

      // CSS content is a quoted string: '"notifications"' or '"\e7f4"'
      const m        = raw.match(/^"([\s\S]*)"$/) || raw.match(/^'([\s\S]*)'$/);
      const iconChar = m ? m[1] : '';
      if (!iconChar) continue;

      const ff    = (ps.fontFamily  || st.fontFamily  || 'sans-serif');
      const fs    = ps.fontSize     || st.fontSize     || '24px';
      const fw    = ps.fontWeight   || st.fontWeight   || '400';
      const color = ps.color        || st.color        || '#000000';

      const dpr = window.devicePixelRatio || 1;
      const cv  = document.createElement('canvas');
      cv.width  = Math.max(Math.ceil(w * dpr), 1);
      cv.height = Math.max(Math.ceil(h * dpr), 1);
      const ctx = cv.getContext('2d');
      ctx.scale(dpr, dpr);
      ctx.font         = `${fw} ${fs} ${ff}`;
      ctx.fillStyle    = color;
      ctx.textAlign    = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(iconChar, w / 2, h / 2);
      return `<image href="${cv.toDataURL('image/png')}" x="${r(x)}" y="${r(y)}" width="${r(w)}" height="${r(h)}" preserveAspectRatio="xMidYMid meet"/>`;
    }

    return '';
  }

  // ═══════════════════════════════════════════════════════════════
  // SECTION 5 — DOM layer collection
  //
  // Walks the DOM in depth-first order. Each visible element becomes
  // a "layer" with canvas-relative x,y coordinates and an effective
  // z-index that inherits from ancestors — so children of a high-z
  // parent always appear above lower-z siblings.
  // ═══════════════════════════════════════════════════════════════

  // fixedScrollX/Y: the scroll offset to ADD to fixed-position elements so they land
  // at the correct page-absolute position. For full-page (origin = 0,0) fixed elements
  // are already viewport-relative, so fixedScrollX = 0. For viewport/area captures the
  // origin IS the scroll position, so we pass scrollX/Y to compensate.
  function collectLayers(rootEl, originX, originY, fixedScrollX = 0, fixedScrollY = 0, opts = {}) {
    const layers = [];
    let   domIdx = 0;

    (function walk(el, inheritedZ) {
      if (!el || el.nodeType !== Node.ELEMENT_NODE) return;
      if (el === highlightDiv || el === tooltipDiv || el === areaOverlayDiv || el === areaRectDiv) return;

      const st = window.getComputedStyle(el);
      if (st.display === 'none') return;  // display:none hides element and all descendants

      // visibility:hidden hides this element but children can override with visibility:visible.
      // Don't add this element to layers, but still walk children below.
      const isVisHidden = st.visibility === 'hidden';

      const br  = el.getBoundingClientRect();
      const pos = st.position;
      const vp  = pos === 'fixed' || pos === 'sticky'; // already viewport-relative
      const x   = br.left + (vp ? fixedScrollX : window.scrollX) - originX;
      const y   = br.top  + (vp ? fixedScrollY : window.scrollY) - originY;
      const w   = br.width;
      const h   = br.height;

      // Effective z: child z-index adds onto parent's effective z so that
      // z-index stacking contexts are respected in a simplified way.
      const ownZ       = parseInt(st.zIndex); // NaN when 'auto'
      const effectiveZ = isNaN(ownZ) ? inheritedZ : inheritedZ + ownZ;

      if (!isVisHidden) {
        // Visually-hidden accessibility nodes (.sr-only, .visually-hidden, CDK overlay helpers)
        // use the pattern: width/height ≤ 1px + overflow:hidden. Their text IS real TEXT_NODEs
        // so buildText would capture them as floating text in the SVG — skip them entirely.
        const skipNode = (w <= 1 && h <= 1 && st.overflow === 'hidden');

        // Skip browser-extension-injected overlays (ad blockers, dev tools, etc.).
        // Extensions typically claim z-index near INT_MAX and are fixed direct children of <html>/<body>.
        const rawZIdx = parseInt(st.zIndex);
        const isExtOverlay = (!isNaN(rawZIdx) && rawZIdx >= 2000000 &&
            (pos === 'fixed' || pos === 'absolute') &&
            (el.parentElement === document.documentElement || el.parentElement === document.body));

        const elId  = (el.id  || '').toLowerCase();
        const elCls = (typeof el.className === 'string' ? el.className : '').toLowerCase();
        const isExtClass = /\b(ubo-|ublock|adblock|abp-|adguard|ghostery)\b/.test(elId + ' ' + elCls);

        if (!skipNode && !isExtOverlay && !isExtClass) {
          layers.push({ el, st, x, y, w, h, z: effectiveZ, dom: domIdx++, ox: originX, oy: originY });
        }
      }

      // Skip walking children of leaf visual elements.
      // SVG elements in HTML documents return lowercase tagName ('svg', 'path', etc.)
      // while HTML elements return uppercase ('IMG', 'CANVAS', etc.) — normalise before comparing.
      const tag   = el.tagName;
      const tagUC = tag.toUpperCase();
      if (tagUC === 'IMG' || tagUC === 'SVG' || tagUC === 'CANVAS' ||
          tagUC === 'VIDEO' || tagUC === 'INPUT' || tagUC === 'TEXTAREA') return;

      for (const child of el.children) walk(child, effectiveZ);

      // Traverse Shadow DOM (Angular Material, web components, etc.)
      if (opts.shadowDOM && el.shadowRoot) {
        for (const child of el.shadowRoot.children) walk(child, effectiveZ);
      }
    })(rootEl, 0);

    // Sort: primary = effective z-index, secondary = DOM order
    layers.sort((a, b) => a.z !== b.z ? a.z - b.z : a.dom - b.dom);
    return layers;
  }

  // ═══════════════════════════════════════════════════════════════
  // SECTION 6 — SVG element builders
  // ═══════════════════════════════════════════════════════════════

  // ── Background rect + gradient + image URL ──────────────────────

  async function buildBackground(layer, defs, ids, shadowAttr = '') {
    const { st, x, y, w, h } = layer;
    const br      = parseBR(st, w, h);
    const rxry    = br ? ` rx="${br.rx}" ry="${br.ry}"` : '';
    const bgColor = st.backgroundColor;
    const out     = [];

    // ── CSS mask-image (Google icon pattern): background-color shown through an SVG mask shape ──
    // Common in Google products: background-color sets the icon colour, mask-image clips it.
    const maskImgCss   = st.maskImage || st.webkitMaskImage || '';
    const maskUrlMatch = (maskImgCss && maskImgCss !== 'none')
      ? maskImgCss.match(/url\(['"]?([^'")\s]+)['"]?\)/)
      : null;

    if (maskUrlMatch) {
      let maskSrc;
      try { maskSrc = new URL(maskUrlMatch[1], location.href).href; } catch { maskSrc = maskUrlMatch[1]; }
      // data: URIs can be used directly; everything else goes through the background fetcher
      const maskHref = maskSrc.startsWith('data:')
        ? maskSrc
        : await new Promise(resolve =>
            chrome.runtime.sendMessage({ type: 'FETCH_IMAGE_AS_DATA_URI', url: maskSrc },
              res => resolve(res?.dataURI || null)));
      if (maskHref) {
        const iconFill = !isTransparent(bgColor) ? bgColor : (st.color || '#000000');
        let vectorized = false;

        // Preferred path: extract vector shapes from SVG masks so the icon is editable in Figma.
        // Figma cannot render SVG data URIs inside <image> elements or <mask> children.
        if (maskHref.startsWith('data:image/svg+xml')) {
          try {
            const svgStr = maskHref.startsWith('data:image/svg+xml;base64,')
              ? decodeURIComponent(escape(atob(maskHref.slice('data:image/svg+xml;base64,'.length))))
              : decodeURIComponent(maskHref.slice(maskHref.indexOf(',') + 1));

            const maskDoc  = new DOMParser().parseFromString(svgStr, 'image/svg+xml');
            const maskRoot = maskDoc.documentElement;

            // Compute scale from the mask SVG's coordinate space to our output space
            let mvw = parseFloat(maskRoot.getAttribute('width'))  || w;
            let mvh = parseFloat(maskRoot.getAttribute('height')) || h;
            const mvb = maskRoot.getAttribute('viewBox');
            if (mvb) {
              const vbp = mvb.trim().split(/[\s,]+/).map(Number);
              if (vbp.length >= 4 && vbp[2] > 0 && vbp[3] > 0) { mvw = vbp[2]; mvh = vbp[3]; }
            }
            const msx = mvw > 0 ? w / mvw : 1;
            const msy = mvh > 0 ? h / mvh : 1;

            const shapeSer = new XMLSerializer();
            const shapes = Array.from(
              maskRoot.querySelectorAll('path, circle, rect, ellipse, polygon, polyline, line')
            ).filter(shape => {
              // Skip shapes explicitly marked fill="none" — they are bounding-box helpers
              // in icon SVGs (e.g. the transparent 24×24 background rect). If we filled them
              // they would cover the entire icon area with a solid colour, hiding the shape.
              return shape.getAttribute('fill') !== 'none';
            }).map(shape => {
              const c = shape.cloneNode(true);
              c.setAttribute('fill', iconFill);
              // Strip attributes that browsers handle but Figma silently ignores,
              // which would make shapes invisible or incorrectly clipped in Figma.
              for (const attr of ['stroke', 'class', 'clip-path', 'filter', 'mask']) {
                c.removeAttribute(attr);
              }
              return shapeSer.serializeToString(c).replace(/ xmlns(?::[a-z]+)?="[^"]*"/g, '');
            });

            if (shapes.length) {
              const mt = (msx !== 1 || msy !== 1)
                ? `translate(${r(x)},${r(y)}) scale(${msx.toFixed(6)},${msy.toFixed(6)})`
                : `translate(${r(x)},${r(y)})`;
              out.push(`<g transform="${mt}">${shapes.join('')}</g>`);
              vectorized = true;
            }
          } catch (_) { /* fall through to SVG mask fallback */ }
        }

        if (!vectorized) {
          // Canvas PNG fallback — Figma supports <image> PNGs; SVG <mask> is silently dropped.
          // maskHref is always a data URI here so canvas compositing is CORS-safe.
          try {
            const pngDataUri = await maskToColoredPng(maskHref, iconFill, w, h);
            out.push(`<image href="${pngDataUri}" x="${r(x)}" y="${r(y)}" width="${r(w)}" height="${r(h)}" preserveAspectRatio="xMidYMid meet"/>`);
          } catch (_) {
            // Absolute last resort: SVG mask — renders in browsers only, invisible in Figma
            const maskId = `m${ids.next()}`;
            defs.push(
              `<mask id="${maskId}" maskUnits="userSpaceOnUse" maskContentUnits="userSpaceOnUse" mask-type="alpha">` +
              `<image href="${maskHref}" x="${r(x)}" y="${r(y)}" width="${r(w)}" height="${r(h)}" preserveAspectRatio="xMidYMid meet"/>` +
              `</mask>`
            );
            out.push(`<rect x="${r(x)}" y="${r(y)}" width="${r(w)}" height="${r(h)}"${rxry} fill="${xe(iconFill)}" mask="url(#${maskId})"/>`);
          }
        }
      } else if (!isTransparent(bgColor)) {
        // Mask fetch failed — render plain background so at least the colour shows
        out.push(`<rect x="${r(x)}" y="${r(y)}" width="${r(w)}" height="${r(h)}"${rxry} fill="${xe(bgColor)}"${shadowAttr}/>`);
      }
    } else if (!isTransparent(bgColor)) {
      out.push(`<rect x="${r(x)}" y="${r(y)}" width="${r(w)}" height="${r(h)}"${rxry} fill="${xe(bgColor)}"${shadowAttr}/>`);
    }

    // ── background-image: gradient or url(...) ──────────────────────────────────────────────────
    const bgImg = st.backgroundImage;
    if (bgImg && bgImg !== 'none') {
      const grad = tryGradient(bgImg, x, y, w, h, defs, ids);
      if (grad) {
        out.push(grad);
      } else {
        const urlMatch = bgImg.match(/url\(['"]?([^'")\s]+)['"]?\)/);
        if (urlMatch) {
          let src;
          try { src = new URL(urlMatch[1], location.href).href; } catch { src = urlMatch[1]; }
          const pAR = (st.backgroundSize || '').includes('cover') ? 'xMidYMid slice' : 'xMidYMid meet';
          // data: URIs are already embeddable — no background round-trip needed
          const href = src.startsWith('data:')
            ? src
            : await new Promise(resolve =>
                chrome.runtime.sendMessage({ type: 'FETCH_IMAGE_AS_DATA_URI', url: src },
                  res => resolve(res?.dataURI || null)));
          if (href) {
            if (br) {
              const clipId = `c${ids.next()}`;
              defs.push(`<clipPath id="${clipId}"><rect x="${r(x)}" y="${r(y)}" width="${r(w)}" height="${r(h)}"${rxry}/></clipPath>`);
              out.push(`<image href="${href}" x="${r(x)}" y="${r(y)}" width="${r(w)}" height="${r(h)}" preserveAspectRatio="${pAR}" clip-path="url(#${clipId})"/>`);
            } else {
              out.push(`<image href="${href}" x="${r(x)}" y="${r(y)}" width="${r(w)}" height="${r(h)}" preserveAspectRatio="${pAR}"/>`);
            }
          }
        }
      }
    }

    return out.join('');
  }

  function tryGradient(css, x, y, w, h, defs, ids) {
    const id  = `g${ids.next()}`;
    const lin = css.match(/linear-gradient\((.+)\)/s);
    if (lin) {
      const stops = gradStops(lin[1]);
      if (!stops.length) return null;
      let x1='0%', y1='0%', x2='100%', y2='0%';
      if (/to\s+bottom/i.test(lin[1])) { x2='0%'; y2='100%'; }
      else if (/to\s+left/i.test(lin[1])) { x1='100%'; x2='0%'; }
      defs.push(
        `<linearGradient id="${id}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}">` +
        stops.map(s => `<stop offset="${s.p}%" stop-color="${xe(s.c)}"/>`).join('') +
        `</linearGradient>`
      );
      return `<rect x="${r(x)}" y="${r(y)}" width="${r(w)}" height="${r(h)}" fill="url(#${id})"/>`;
    }
    const rad = css.match(/radial-gradient\((.+)\)/s);
    if (rad) {
      const stops = gradStops(rad[1]);
      if (!stops.length) return null;
      defs.push(
        `<radialGradient id="${id}" cx="50%" cy="50%" r="50%">` +
        stops.map(s => `<stop offset="${s.p}%" stop-color="${xe(s.c)}"/>`).join('') +
        `</radialGradient>`
      );
      return `<rect x="${r(x)}" y="${r(y)}" width="${r(w)}" height="${r(h)}" fill="url(#${id})"/>`;
    }
    return null;
  }

  function gradStops(inner) {
    const tokens = splitCSV(inner).filter(t => /^(rgb|hsl|#|[a-z])/i.test(t.trim()));
    return tokens.map((tok, i) => {
      const pm  = tok.match(/([\d.]+)%/);
      const p   = pm ? parseFloat(pm[1]) : (i / Math.max(tokens.length - 1, 1)) * 100;
      const c   = tok.replace(/\s*[\d.]+%\s*/g, '').trim();
      return c ? { c, p: r(p) } : null;
    }).filter(Boolean);
  }

  function splitCSV(s) {
    const out = []; let depth = 0, start = 0;
    for (let i = 0; i < s.length; i++) {
      if      (s[i] === '(') depth++;
      else if (s[i] === ')') depth--;
      else if (s[i] === ',' && depth === 0) { out.push(s.slice(start, i).trim()); start = i + 1; }
    }
    out.push(s.slice(start).trim());
    return out;
  }

  // ── Box shadow → SVG filter ──────────────────────────────────────

  function buildBoxShadow(layer, defs, ids) {
    const { st, x, y, w, h } = layer;
    const raw = st.boxShadow;
    if (!raw || raw === 'none') return '';

    // Parse the first shadow value only (multiple shadows would need multiple filters).
    // Format: "h-offset v-offset blur spread color [inset]"
    const m = raw.match(/(-?[\d.]+px)\s+(-?[\d.]+px)\s+([\d.]+px)(?:\s+([\d.]+px))?\s+(rgba?\([^)]+\)|#[\da-f]+|[a-z]+)/i);
    if (!m) return '';
    const inset = /\binset\b/.test(raw);
    if (inset) return ''; // inset shadows need clip-path masks — not worth the complexity

    const dx    = parseFloat(m[1]);
    const dy    = parseFloat(m[2]);
    const blur  = parseFloat(m[3]);
    const color = m[5];

    const filterId = `f${ids.next()}`;
    // Expand the filter region so the shadow is never clipped
    const pad = Math.max(Math.abs(dx), Math.abs(dy), blur) * 2 + 10;
    const pct = v => `${r((v / Math.max(w, h)) * 100 + (pad / Math.max(w, h)) * 100)}%`;
    defs.push(
      `<filter id="${filterId}" x="-${r(pad/w*100)}%" y="-${r(pad/h*100)}%" ` +
      `width="${r((w + pad*2)/w*100)}%" height="${r((h + pad*2)/h*100)}%">` +
      `<feDropShadow dx="${dx}" dy="${dy}" stdDeviation="${r(blur/2)}" flood-color="${xe(color)}"/>` +
      `</filter>`
    );
    return ` filter="url(#${filterId})"`;
  }

  // ── Border ───────────────────────────────────────────────────────

  function buildBorder(layer) {
    const { st, x, y, w, h } = layer;
    const bw = parseFloat(st.borderTopWidth) || 0;
    if (!bw) return '';
    const color = st.borderTopColor;
    const style = st.borderTopStyle;
    if (style === 'none' || isTransparent(color)) return '';
    const br   = parseBR(st, w, h);
    const rxry = br ? ` rx="${br.rx}" ry="${br.ry}"` : '';
    const ins  = bw / 2;
    const dash = style === 'dashed' ? ` stroke-dasharray="${bw * 4} ${bw * 2}"` :
                 style === 'dotted' ? ` stroke-dasharray="${bw} ${bw}"` : '';
    return (
      `<rect x="${r(x+ins)}" y="${r(y+ins)}" width="${r(w-bw)}" height="${r(h-bw)}"` +
      `${rxry} fill="none" stroke="${xe(color)}" stroke-width="${r(bw)}"${dash}/>`
    );
  }

  // ── Text ─────────────────────────────────────────────────────────

  /**
   * Returns one entry per visual line of a text node, with the viewport-coordinate
   * position of each line.  Used to emit <tspan> elements for wrapped text.
   *
   * Fast path: if getClientRects() shows only one line we skip the character scan.
   * Bail-out: text longer than 500 chars falls back to single-line (performance).
   */
  function getVisualLines(textNode) {
    const text = textNode.textContent;
    if (!text) return [];

    const range = document.createRange();
    range.selectNodeContents(textNode);
    const allRects = Array.from(range.getClientRects());

    // Count unique top values (within 2 px tolerance) to detect line count
    const uniqueTops = [];
    for (const rect of allRects) {
      if (!uniqueTops.some(t => Math.abs(t - rect.top) < 2)) uniqueTops.push(rect.top);
    }

    if (uniqueTops.length <= 1 || text.length > 500) {
      const br = range.getBoundingClientRect();
      return [{ text, top: br.top, left: br.left, width: br.width }];
    }

    // Multiple lines — character scan to find break indices
    const lines   = [];
    let   start   = 0;
    let   prevTop = null;
    let   lineLeft = null;

    for (let i = 0; i < text.length; i++) {
      range.setStart(textNode, i);
      range.setEnd(textNode, i + 1);
      const rect = range.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue; // collapsed whitespace / \n

      if (prevTop === null) {
        prevTop  = rect.top;
        lineLeft = rect.left;
      } else if (rect.top > prevTop + 2) {
        // Line break detected — record completed line
        range.setStart(textNode, start);
        range.setEnd(textNode, i);
        const lineRect = range.getBoundingClientRect();
        lines.push({ text: text.slice(start, i), top: prevTop, left: lineLeft, width: lineRect.width });
        start    = i;
        prevTop  = rect.top;
        lineLeft = rect.left;
      }
    }

    // Last (or only) line
    range.setStart(textNode, start);
    range.setEnd(textNode, text.length);
    const lastRect = range.getBoundingClientRect();
    lines.push({ text: text.slice(start), top: lastRect.top, left: lastRect.left, width: lastRect.width });

    return lines;
  }

  async function buildText(layer) {
    const { el, st, x, y, w, h, ox, oy } = layer;
    const nodes = Array.from(el.childNodes)
      .filter(n => n.nodeType === Node.TEXT_NODE && n.textContent.trim());

    if (isIconFont(st.fontFamily)) {
      if (nodes.length || el.textContent?.trim()) {
        return await buildIconViaCanvas(layer);
      }
      // Icon font element with no text — the glyph likely comes from a CSS pseudo-element.
      return await buildPseudoIconViaCanvas(layer);
    }

    if (!nodes.length) return '';

    // SVG renderers don't honour CSS text-transform — apply it to the string directly.
    const tt = st.textTransform;
    const applyTT = s => {
      if (tt === 'uppercase')  return s.toUpperCase();
      if (tt === 'lowercase')  return s.toLowerCase();
      if (tt === 'capitalize') return s.replace(/\b\w/g, c => c.toUpperCase());
      return s;
    };

    const fs     = st.fontSize     || '14px';
    const ff     = (st.fontFamily  || 'sans-serif').replace(/"/g, "'");
    const fw     = st.fontWeight   || '400';
    const fi     = st.fontStyle    || 'normal';
    const color  = st.color        || '#000000';
    const align  = st.textAlign    || 'left';
    const decor  = st.textDecorationLine || 'none';
    const anchor = align === 'center' ? 'middle' : align === 'right' ? 'end' : 'start';
    const dAttr  = decor !== 'none' ? ` text-decoration="${xe(decor)}"` : '';

    // Consolidate typographic CSS properties with no SVG attribute equivalent.
    const styleProps = [];
    const ls = st.letterSpacing;
    if (ls && ls !== 'normal') styleProps.push(`letter-spacing:${ls}`);
    const ws = st.wordSpacing;
    if (ws && ws !== 'normal') styleProps.push(`word-spacing:${ws}`);
    const fvs = st.fontVariationSettings;
    if (fvs && fvs !== 'normal') styleProps.push(`font-variation-settings:${fvs}`);
    const styleAttr = styleProps.length ? ` style="${xe(styleProps.join(';'))}"` : '';

    // fixed/sticky elements are already in viewport coords; others need scroll offset.
    const pos = st.position;
    const vp  = pos === 'fixed' || pos === 'sticky';
    const sx  = vp ? 0 : window.scrollX;
    const sy  = vp ? 0 : window.scrollY;

    // Detect visual line breaks (CSS text wrapping) via the Range API.
    // getVisualLines returns [{text, top, left, width}] in viewport coordinates.
    const lines = getVisualLines(nodes[0]);

    // Measure font ascent so we can express y as the alphabetic baseline.
    // SVG text default is "alphabetic" baseline; Figma ignores dominant-baseline="hanging",
    // so using hanging + visual-top y shifts text ~ascent pixels upward in Figma.
    // Fix: drop dominant-baseline and offset y by the actual ascent.
    const fsSz  = parseFloat(fs) || 14;
    const _tCtx = document.createElement('canvas').getContext('2d');
    _tCtx.font  = `${fw} ${fi} ${fsSz}px ${ff.split(',')[0].replace(/['"]/g, '').trim()}`;
    const _tm   = _tCtx.measureText('Mg');
    const ascent = _tm.fontBoundingBoxAscent ?? _tm.actualBoundingBoxAscent ?? fsSz * 0.8;

    const textAttrs = (
      `font-family="${xe(ff)}" font-size="${xe(fs)}" font-weight="${fw}" ` +
      `font-style="${fi}" fill="${xe(color)}" text-anchor="${anchor}"` +
      `${dAttr}${styleAttr}`
    );

    if (lines.length <= 1) {
      // Single line — use the Range bounding rect for accurate placement.
      let tx, ty;
      try {
        const range = document.createRange();
        range.selectNode(nodes[0]);
        const tr = range.getBoundingClientRect();
        if (tr.width > 0 || tr.height > 0) {
          const absLx = tr.left + sx - ox;
          const absT  = tr.top  + sy - oy;
          tx = align === 'center' ? r(absLx + tr.width / 2)
             : align === 'right'  ? r(absLx + tr.width)
             : r(absLx);
          ty = r(absT + ascent);
        } else {
          throw new Error('zero');
        }
      } catch (_) {
        const padL = parseFloat(st.paddingLeft) || 0;
        const padT = parseFloat(st.paddingTop)  || 0;
        tx = align === 'center' ? r(x + w / 2) : align === 'right' ? r(x + w - padL) : r(x + padL);
        ty = r(y + padT + ascent);
      }
      const singleText = applyTT(nodes[0].textContent.trim());
      return `<text x="${tx}" y="${ty}" ${textAttrs}>${xe(singleText)}</text>`;
    }

    // Multi-line: emit one <tspan> per visual line with absolute x/y coordinates.
    // Each tspan uses the actual rendered position of that line — no dy guessing.
    const tspans = lines.map(line => {
      const absLx = line.left + sx - ox;
      const absT  = line.top  + sy - oy;
      const lx = align === 'center' ? r(absLx + line.width / 2)
               : align === 'right'  ? r(x + w)
               : r(absLx);
      const ly = r(absT + ascent);
      return `<tspan x="${lx}" y="${ly}">${xe(applyTT(line.text))}</tspan>`;
    });

    return `<text ${textAttrs}>${tspans.join('')}</text>`;
  }

  // ── Input / textarea value ────────────────────────────────────────

  function buildInputText(layer) {
    const { el, st, x, y } = layer;
    const val = el.value || el.placeholder || '';
    if (!val) return '';
    const isPlaceholder = !el.value && el.placeholder;
    const fs   = st.fontSize || '14px';
    const padL = parseFloat(st.paddingLeft) || 4;
    const padT = parseFloat(st.paddingTop)  || 4;
    const m    = (st.color || '').match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    const fill = isPlaceholder
      ? (m ? `rgba(${m[1]},${m[2]},${m[3]},0.5)` : '#999')
      : (st.color || '#000');
    return (
      `<text x="${r(x + padL)}" y="${r(y + padT + parseFloat(fs))}" ` +
      `font-family="${xe((st.fontFamily || 'sans-serif').replace(/"/g,"'"))}" ` +
      `font-size="${xe(fs)}" fill="${xe(fill)}">${xe(val.slice(0, 120))}</text>`
    );
  }

  // ── <img> element ─────────────────────────────────────────────────

  async function buildImg(layer) {
    const { el, x, y, w, h } = layer;
    const src = el.currentSrc || el.src;
    if (!src) return '';
    let href = src;
    // Try to embed as Base64 (avoids broken-image references in the SVG)
    try {
      const c = document.createElement('canvas');
      c.width  = el.naturalWidth  || Math.ceil(w) || 1;
      c.height = el.naturalHeight || Math.ceil(h) || 1;
      c.getContext('2d').drawImage(el, 0, 0);
      href = c.toDataURL('image/png');
    } catch (_) {
      // Cross-origin image — ask background to fetch it
      href = await new Promise(resolve => {
        chrome.runtime.sendMessage({ type: 'FETCH_IMAGE_AS_DATA_URI', url: src },
          res => resolve(res?.dataURI || src));
      });
    }
    const alt = el.alt ? ` aria-label="${xe(el.alt)}"` : '';
    return `<image href="${href}" x="${r(x)}" y="${r(y)}" width="${r(w)}" height="${r(h)}" preserveAspectRatio="xMidYMid meet"${alt}/>`;
  }

  // ── Inline <svg> — emit vector <g> children (Figma-compatible) ────────

  function buildInlineSVG(layer) {
    const { el, x, y, w, h } = layer;
    if (w <= 0 || h <= 0) return '';
    try {
      // Resolve SVG coordinate space: viewBox takes priority over width/height attributes.
      let vminX = 0, vminY = 0, vw = w, vh = h;
      const vbAttr = el.getAttribute('viewBox');
      if (vbAttr) {
        const vbp = vbAttr.trim().split(/[\s,]+/).map(Number);
        if (vbp.length >= 4 && vbp[2] > 0 && vbp[3] > 0) {
          [vminX, vminY, vw, vh] = vbp;
        }
      } else {
        const aw = parseFloat(el.getAttribute('width'));
        const ah = parseFloat(el.getAttribute('height'));
        if (aw > 0) vw = aw;
        if (ah > 0) vh = ah;
      }
      const sx = vw > 0 ? w / vw : 1;
      const sy = vh > 0 ? h / vh : 1;

      // Clone and inline computed fill/stroke/opacity on every descendant.
      // getComputedStyle resolves currentColor, CSS variables, and inheritance —
      // these would all be lost if we serialised without inlining.
      const clone    = el.cloneNode(true);
      const origEls  = el.querySelectorAll('*');
      const cloneEls = clone.querySelectorAll('*');
      const rootColor = window.getComputedStyle(el).color;

      for (let i = 0; i < origEls.length; i++) {
        const cs = window.getComputedStyle(origEls[i]);
        const fill          = cs.fill;
        const stroke        = cs.stroke;
        const fillOpacity   = cs.fillOpacity;
        const strokeOpacity = cs.strokeOpacity;
        const opacity       = cs.opacity;
        if (fill)                                    cloneEls[i].setAttribute('fill',           fill);
        if (stroke)                                  cloneEls[i].setAttribute('stroke',         stroke);
        if (fillOpacity   && fillOpacity   !== '1') cloneEls[i].setAttribute('fill-opacity',   fillOpacity);
        if (strokeOpacity && strokeOpacity !== '1') cloneEls[i].setAttribute('stroke-opacity', strokeOpacity);
        if (opacity       && opacity       !== '1') cloneEls[i].setAttribute('opacity',         opacity);
      }

      // Unique prefix to namespace every ID in this SVG, preventing collisions
      // when multiple SVGs appear in the same output document.
      const uid  = `si${++_svgInlineSeq}`;
      const ser  = new XMLSerializer();
      const parts = [];

      for (const child of clone.children) {
        let xml = ser.serializeToString(child);
        // Strip redundant namespace re-declarations that serialiser adds to child elements
        xml = xml.replace(/ xmlns(?::[a-z]+)?="[^"]*"/g, '');
        // Namespace IDs and all references to them
        xml = xml
          .replace(/\bid="([^"]+)"/g,    `id="${uid}-$1"`)
          .replace(/href="#([^"]+)"/g,    `href="#${uid}-$1"`)
          .replace(/url\(#([^)]+)\)/g,   `url(#${uid}-$1)`);
        // Replace any remaining currentColor with the resolved colour
        if (rootColor) xml = xml.replace(/\bcurrentColor\b/gi, rootColor);
        parts.push(xml);
      }

      // Build the composite transform: position at (x,y) and scale from SVG space
      const tx = r(x - vminX * sx);
      const ty = r(y - vminY * sy);
      const transform = (sx !== 1 || sy !== 1)
        ? `translate(${tx},${ty}) scale(${sx.toFixed(6)},${sy.toFixed(6)})`
        : `translate(${tx},${ty})`;

      return `<g transform="${transform}">${parts.join('')}</g>`;
    } catch (_) { return ''; }
  }

  // ── <canvas> snapshot ─────────────────────────────────────────────

  function buildCanvas(layer) {
    const { el, x, y, w, h } = layer;
    try {
      const href = el.toDataURL('image/png');
      return `<image href="${href}" x="${r(x)}" y="${r(y)}" width="${r(w)}" height="${r(h)}"/>`;
    } catch (_) { return ''; }
  }

  // ═══════════════════════════════════════════════════════════════
  // SECTION 7 — Main SVG generation
  // ═══════════════════════════════════════════════════════════════

  async function generateSVG(rootEl, options = {}) {
    const captureMode = options.captureMode || 'fullpage'; // 'fullpage' | 'viewport' | 'area' | 'element'
    const isFullPage  = captureMode === 'fullpage';
    const isViewport  = captureMode === 'viewport';
    const isArea      = captureMode === 'area';

    let originX = 0, originY = 0;
    let svgW, svgH;
    let fixedScrollX = 0, fixedScrollY = 0;

    if (isFullPage) {
      // Seed with DOM scroll dimensions; expand below from actual layer extents.
      svgW = Math.max(document.documentElement.scrollWidth,  document.body.scrollWidth,  window.innerWidth);
      svgH = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight, window.innerHeight);
      // fixedScrollX/Y stay 0 — fixed elements in full-page use raw viewport coords

    } else if (isViewport) {
      // Capture only what is currently visible in the browser window
      originX      = window.scrollX;
      originY      = window.scrollY;
      svgW         = window.innerWidth;
      svgH         = window.innerHeight;
      fixedScrollX = window.scrollX;
      fixedScrollY = window.scrollY;

    } else if (isArea) {
      // Capture the user-drawn rectangle (page-absolute coords stored by onAreaUp)
      const area   = options.areaSelection;
      originX      = area.x;
      originY      = area.y;
      svgW         = Math.ceil(area.w);
      svgH         = Math.ceil(area.h);
      fixedScrollX = window.scrollX;
      fixedScrollY = window.scrollY;

    } else {
      // Element capture — rootEl is the specific targeted element
      const br  = rootEl.getBoundingClientRect();
      const pos = window.getComputedStyle(rootEl).position;
      const vp  = pos === 'fixed' || pos === 'sticky';
      originX = br.left + (vp ? 0 : window.scrollX);
      originY = br.top  + (vp ? 0 : window.scrollY);
      svgW = Math.ceil(br.width)  || 1;
      svgH = Math.ceil(br.height) || 1;
      // fixedScrollX/Y stay 0 (preserves existing behaviour for element mode)
    }

    const defs  = [];
    let   idN   = 0;
    const ids   = { next: () => ++idN };
    const parts = [];

    const layers = collectLayers(rootEl, originX, originY, fixedScrollX, fixedScrollY, options);

    // Collect the font families actually present in the captured layers, then fetch
    // and inline their @font-face CSS so the SVG renders with the correct typeface.
    // CDATA wrapper is required: & in CDN URLs would otherwise be invalid SVG XML.
    const usedFamilies = new Set();
    for (const layer of layers) {
      if (!layer.st.fontFamily) continue;
      for (const part of layer.st.fontFamily.split(','))
        usedFamilies.add(part.replace(/['"]/g, '').trim());
    }
    const fontCSS = await buildFontStyleCSS(usedFamilies);
    if (fontCSS) defs.push(`<style><![CDATA[\n${fontCSS}\n]]></style>`);

    // Full-page only: expand svgW/svgH to actual element extents, then add background.
    // Viewport/area have fixed dimensions; their bounds filter below handles clipping.
    if (isFullPage) {
      for (const layer of layers) {
        if (layer.x + layer.w > svgW) svgW = Math.ceil(layer.x + layer.w);
        if (layer.y + layer.h > svgH) svgH = Math.ceil(layer.y + layer.h);
      }
      const bg   = window.getComputedStyle(document.body).backgroundColor;
      const fill = isTransparent(bg) ? '#ffffff' : bg;
      parts.push(`<rect width="${svgW}" height="${svgH}" fill="${xe(fill)}"/>`);
    }

    for (const layer of layers) {
      const { x, y, w, h } = layer;

      // Skip elements outside the capture bounds
      if (x + w < 0 || y + h < 0 || x > svgW || y > svgH) continue;

      const pieces = [];

      // Background (+ optional box-shadow filter injected onto the rect via shadowAttr)
      const shadowAttr = options.includeShadows ? buildBoxShadow(layer, defs, ids) : '';
      pieces.push(await buildBackground(layer, defs, ids, shadowAttr));

      // Border
      pieces.push(buildBorder(layer));

      // Element-type-specific content
      switch (layer.el.tagName.toUpperCase()) {
        case 'IMG':      pieces.push(await buildImg(layer));     break;
        case 'SVG':      pieces.push(buildInlineSVG(layer));     break;
        case 'CANVAS':   pieces.push(buildCanvas(layer));        break;
        case 'INPUT':
        case 'TEXTAREA': pieces.push(buildInputText(layer));     break;
      }

      // Direct text nodes (async — icon fonts are rasterized via canvas)
      pieces.push(await buildText(layer));

      const inner = pieces.filter(Boolean).join('');
      if (!inner) continue;

      // Wrap with opacity if needed
      const op = parseFloat(layer.st.opacity);
      parts.push(
        (op < 1 && op >= 0)
          ? `<g opacity="${r(op)}">${inner}</g>`
          : inner
      );
    }

    return (
`<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"
     width="${svgW}" height="${svgH}" viewBox="0 0 ${svgW} ${svgH}">
  <defs>
    ${defs.join('\n    ')}
  </defs>
  ${parts.join('\n  ')}
</svg>`
    );
  }

  // ═══════════════════════════════════════════════════════════════
  // SECTION 8 — Message handler (receives commands from popup.js)
  // ═══════════════════════════════════════════════════════════════

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    switch (msg.type) {

      case 'ACTIVATE_PICKER':
        activatePicker();
        sendResponse({ ok: true });
        break;

      case 'ACTIVATE_AREA_SELECTOR':
        activateAreaSelector();
        sendResponse({ ok: true });
        break;

      case 'RESOLVE_SELECTOR': {
        const el = resolveSelector(msg.selector);
        if (!el) { sendResponse({ error: 'No element matched.' }); break; }
        sendResponse({ ok: true, tag: el.tagName.toLowerCase(), selector: getStableSelector(el) });
        break;
      }

      case 'GENERATE_SVG': {
        const specialSelectors = ['__fullpage__', '__viewport__', '__area__'];
        const targetEl = specialSelectors.includes(msg.selector)
          ? document.documentElement
          : (resolveSelector(msg.selector) || document.documentElement);

        const captureMode = msg.selector === '__viewport__' ? 'viewport'
                          : msg.selector === '__area__'     ? 'area'
                          : msg.selector === '__fullpage__' ? 'fullpage'
                          : 'element';

        generateSVG(targetEl, { ...msg.options, captureMode, areaSelection: msg.areaSelection })
          .then(svg => sendResponse({ svg }))
          .catch(err => sendResponse({ error: err.message }));
        return true;   // keep async channel open
      }
    }
  });

})();
