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
  const ICON_FONT_RE = /material.?icon|material.?symbol|font.?awesome|fontawesome|glyphicon|ionicon|feather|remixicon|lucide|bootstrap.?icon|themify|typicon/i;

  function isIconFont(fontFamily) {
    return fontFamily ? ICON_FONT_RE.test(fontFamily) : false;
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

  // ═══════════════════════════════════════════════════════════════
  // SECTION 5 — DOM layer collection
  //
  // Walks the DOM in depth-first order. Each visible element becomes
  // a "layer" with canvas-relative x,y coordinates and an effective
  // z-index that inherits from ancestors — so children of a high-z
  // parent always appear above lower-z siblings.
  // ═══════════════════════════════════════════════════════════════

  function collectLayers(rootEl, originX, originY) {
    const layers = [];
    let   domIdx = 0;

    (function walk(el, inheritedZ) {
      if (!el || el.nodeType !== Node.ELEMENT_NODE) return;
      if (el === highlightDiv || el === tooltipDiv)  return;

      const st = window.getComputedStyle(el);
      if (st.display === 'none' || st.visibility === 'hidden') return;

      const br  = el.getBoundingClientRect();
      const pos = st.position;
      const vp  = pos === 'fixed' || pos === 'sticky'; // already viewport-relative
      const x   = br.left + (vp ? 0 : window.scrollX) - originX;
      const y   = br.top  + (vp ? 0 : window.scrollY) - originY;
      const w   = br.width;
      const h   = br.height;

      // Effective z: child z-index adds onto parent's effective z so that
      // z-index stacking contexts are respected in a simplified way.
      const ownZ      = parseInt(st.zIndex); // NaN when 'auto'
      const effectiveZ = isNaN(ownZ) ? inheritedZ : inheritedZ + ownZ;

      layers.push({ el, st, x, y, w, h, z: effectiveZ, dom: domIdx++, ox: originX, oy: originY });

      // Skip walking children of leaf visual elements
      const tag = el.tagName;
      if (tag === 'IMG' || tag === 'SVG' || tag === 'CANVAS' ||
          tag === 'VIDEO' || tag === 'INPUT' || tag === 'TEXTAREA') return;

      for (const child of el.children) walk(child, effectiveZ);
    })(rootEl, 0);

    // Sort: primary = effective z-index, secondary = DOM order
    layers.sort((a, b) => a.z !== b.z ? a.z - b.z : a.dom - b.dom);
    return layers;
  }

  // ═══════════════════════════════════════════════════════════════
  // SECTION 6 — SVG element builders
  // ═══════════════════════════════════════════════════════════════

  // ── Background rect + gradient ──────────────────────────────────

  function buildBackground(layer, defs, ids) {
    const { st, x, y, w, h } = layer;
    const br   = parseBR(st, w, h);
    const rxry = br ? ` rx="${br.rx}" ry="${br.ry}"` : '';
    const out  = [];

    const bgColor = st.backgroundColor;
    if (!isTransparent(bgColor)) {
      out.push(`<rect x="${r(x)}" y="${r(y)}" width="${r(w)}" height="${r(h)}"${rxry} fill="${xe(bgColor)}"/>`);
    }

    const bgImg = st.backgroundImage;
    if (bgImg && bgImg !== 'none') {
      const grad = tryGradient(bgImg, x, y, w, h, defs, ids);
      if (grad) out.push(grad);
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

  async function buildText(layer) {
    const { el, st, x, y, w, h, ox, oy } = layer;
    const nodes = Array.from(el.childNodes)
      .filter(n => n.nodeType === Node.TEXT_NODE && n.textContent.trim());
    if (!nodes.length) return '';

    const text = nodes.map(n => n.textContent.trim()).join(' ');

    // Icon fonts: the text content is a ligature name (e.g. "expand_more") or a
    // glyph codepoint — not real text. Rasterize via canvas so the actual icon
    // glyph is captured (the page already has the font loaded).
    if (isIconFont(st.fontFamily)) {
      return await buildIconViaCanvas(layer);
    }

    const fs     = st.fontSize     || '14px';
    const ff     = (st.fontFamily  || 'sans-serif').replace(/"/g, "'");
    const fw     = st.fontWeight   || '400';
    const fi     = st.fontStyle    || 'normal';
    const color  = st.color        || '#000000';
    const align  = st.textAlign    || 'left';
    const decor  = st.textDecorationLine || 'none';
    const anchor = align === 'center' ? 'middle' : align === 'right' ? 'end' : 'start';
    const dAttr  = decor !== 'none' ? ` text-decoration="${xe(decor)}"` : '';

    // Use the Range API to get the actual rendered bounding rect of the text
    // node. This is far more accurate than estimating from padding + font-size,
    // because it respects flexbox centering, line-height, transforms, etc.
    let tx, ty;
    try {
      const range = document.createRange();
      range.selectNode(nodes[0]);
      const tr = range.getBoundingClientRect();
      if (tr.width > 0 || tr.height > 0) {
        const pos = st.position;
        const vp  = pos === 'fixed' || pos === 'sticky';
        const sx  = vp ? 0 : window.scrollX;
        const sy  = vp ? 0 : window.scrollY;
        const absL = tr.left + sx - ox;
        const absT = tr.top  + sy - oy;
        tx = align === 'center' ? r(absL + tr.width / 2)
           : align === 'right'  ? r(absL + tr.width)
           : r(absL);
        ty = r(absT);
      } else {
        throw new Error('zero-size rect');
      }
    } catch (_) {
      // Fallback: estimate from element bounds + padding
      const padL = parseFloat(st.paddingLeft) || 0;
      const padT = parseFloat(st.paddingTop)  || 0;
      tx = align === 'center' ? r(x + w / 2) : align === 'right' ? r(x + w - padL) : r(x + padL);
      ty = r(y + padT);
    }

    return (
      `<text x="${tx}" y="${ty}" font-family="${xe(ff)}" font-size="${xe(fs)}" ` +
      `font-weight="${fw}" font-style="${fi}" fill="${xe(color)}" ` +
      `text-anchor="${anchor}" dominant-baseline="hanging"${dAttr}>${xe(text)}</text>`
    );
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

  // ── Inline <svg> passthrough ──────────────────────────────────────

  function buildInlineSVG(layer) {
    const { el, x, y, w, h } = layer;
    try {
      const xml   = new XMLSerializer().serializeToString(el);
      const bytes = new TextEncoder().encode(xml);
      // Avoid spread-operator stack overflow on large SVGs by using a loop
      let bin = '';
      for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
      const enc = btoa(bin);
      return `<image href="data:image/svg+xml;base64,${enc}" x="${r(x)}" y="${r(y)}" width="${r(w)}" height="${r(h)}"/>`;
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

  async function generateSVG(rootEl, _options = {}) {
    const isFullPage = (rootEl === document.documentElement || rootEl === document.body);

    const svgW = isFullPage
      ? Math.max(document.documentElement.scrollWidth,  document.body.scrollWidth)
      : Math.ceil(rootEl.getBoundingClientRect().width)  || 1;
    const svgH = isFullPage
      ? Math.max(document.documentElement.scrollHeight, document.body.scrollHeight)
      : Math.ceil(rootEl.getBoundingClientRect().height) || 1;

    // Origin: top-left of what we're capturing, in page-absolute coords
    let originX = 0, originY = 0;
    if (!isFullPage) {
      const br  = rootEl.getBoundingClientRect();
      const pos = window.getComputedStyle(rootEl).position;
      const vp  = pos === 'fixed' || pos === 'sticky';
      originX = br.left + (vp ? 0 : window.scrollX);
      originY = br.top  + (vp ? 0 : window.scrollY);
    }

    const defs  = [];
    let   idN   = 0;
    const ids   = { next: () => ++idN };
    const parts = [];

    // Page background for full-page captures
    if (isFullPage) {
      const bg   = window.getComputedStyle(document.body).backgroundColor;
      const fill = isTransparent(bg) ? '#ffffff' : bg;
      parts.push(`<rect width="${svgW}" height="${svgH}" fill="${xe(fill)}"/>`);
    }

    // Collect all layers and render each one
    const layers = collectLayers(rootEl, originX, originY);

    for (const layer of layers) {
      const { x, y, w, h } = layer;

      // Skip elements outside the capture bounds
      if (x + w < 0 || y + h < 0 || x > svgW || y > svgH) continue;

      const pieces = [];

      // Background
      pieces.push(buildBackground(layer, defs, ids));

      // Border
      pieces.push(buildBorder(layer));

      // Element-type-specific content
      switch (layer.el.tagName) {
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

      case 'RESOLVE_SELECTOR': {
        const el = resolveSelector(msg.selector);
        if (!el) { sendResponse({ error: 'No element matched.' }); break; }
        sendResponse({ ok: true, tag: el.tagName.toLowerCase(), selector: getStableSelector(el) });
        break;
      }

      case 'GENERATE_SVG': {
        const targetEl = msg.selector === '__fullpage__'
          ? document.documentElement
          : (resolveSelector(msg.selector) || document.documentElement);

        generateSVG(targetEl, msg.options)
          .then(svg => sendResponse({ svg }))
          .catch(err => sendResponse({ error: err.message }));
        return true;   // keep async channel open
      }
    }
  });

})();
