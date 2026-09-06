/**
 * redactor.js
 * Core redaction engine.
 *
 * Strategy:
 *  - Keep a list of {x,y,w,h} redaction rects PER PAGE (in canvas-pixel coords).
 *  - Re-render the display canvas on every change (original pixels + black rects).
 *  - On export: composite onto a fresh offscreen canvas → destructive flatten.
 *
 * The original page canvas is NEVER modified — full unlimited undo for free.
 */

export class Redactor {
  /**
   * @param {Array<{canvas,width,height,pageNum}>} pages
   */
  constructor(pages) {
    this.pages = pages;
    // Per-page redaction rects (in full-res canvas coordinates)
    this.rects = pages.map(() => []);
    // Undo stack per page
    this._undoStack = pages.map(() => []);
  }

  // ── Public API ─────────────────────────────────────────

  /** Get rects for a given page index */
  getRectsForPage(pageIdx) { return this.rects[pageIdx] || []; }

  /** Add a rect (already in canvas-px coords) with undo support */
  addRect(pageIdx, rect) {
    this._pushUndo(pageIdx);
    this.rects[pageIdx].push(rect);
  }

  /** Remove a specific rect by reference equality */
  removeRect(pageIdx, rect) {
    this._pushUndo(pageIdx);
    this.rects[pageIdx] = this.rects[pageIdx].filter(r => r !== rect);
  }

  /** Undo last operation on a page */
  undo(pageIdx) {
    const stack = this._undoStack[pageIdx];
    if (stack.length === 0) return false;
    this.rects[pageIdx] = stack.pop();
    return true;
  }

  /** Clear all rects for a page */
  clearPage(pageIdx) {
    this._pushUndo(pageIdx);
    this.rects[pageIdx] = [];
  }

  /** Clear all rects on ALL pages */
  clearAll() {
    this.pages.forEach((_, i) => this.clearPage(i));
  }

  /**
   * Render a display canvas: original pixels + black redaction rects.
   * The display canvas is SEPARATE from the original — original stays clean.
   * @param {number} pageIdx
   * @param {HTMLCanvasElement} displayCanvas  the canvas shown in the UI
   * @param {number} cssWidth   CSS display width of the canvas
   */
  renderDisplay(pageIdx, displayCanvas, cssWidth) {
    const { canvas: src } = this.pages[pageIdx];
    const ctx = displayCanvas.getContext('2d');

    // Match internal resolution to source
    displayCanvas.width  = src.width;
    displayCanvas.height = src.height;
    displayCanvas.style.width  = `${cssWidth}px`;
    displayCanvas.style.height = `${Math.round(src.height * cssWidth / src.width)}px`;

    // Draw original
    ctx.drawImage(src, 0, 0);

    // Draw redaction rects (supports both 'black' box and 'pixelate' mode)
    for (const r of this.rects[pageIdx]) {
      drawRedactionRect(ctx, src, r);
    }
  }

  /**
   * Return a destructively flattened canvas for a given page.
   * This is what gets exported — no text or facial data survives.
   * @param {number} pageIdx
   * @returns {HTMLCanvasElement}
   */
  getFlattenedCanvas(pageIdx) {
    const { canvas: src } = this.pages[pageIdx];
    const out = document.createElement('canvas');
    out.width  = src.width;
    out.height = src.height;
    const ctx = out.getContext('2d');

    ctx.drawImage(src, 0, 0);
    for (const r of this.rects[pageIdx]) {
      drawRedactionRect(ctx, src, r);
    }
    return out;
  }

  /** Convenience: flatten ALL pages */
  getAllFlattenedCanvases() {
    return this.pages.map((_, i) => this.getFlattenedCanvas(i));
  }

  // ── Mouse drawing helpers ──────────────────────────────

  /**
   * Convert CSS mouse coordinates to full-res canvas coordinates.
   * @param {MouseEvent} e
   * @param {HTMLCanvasElement} displayCanvas  the DOM canvas element
   * @param {number} pageIdx
   * @returns {{x,y}}
   */
  cssToCanvas(e, displayCanvas, pageIdx) {
    const rect  = displayCanvas.getBoundingClientRect();
    const scaleX = this.pages[pageIdx].canvas.width  / rect.width;
    const scaleY = this.pages[pageIdx].canvas.height / rect.height;
    return {
      x: (e.clientX - rect.left)  * scaleX,
      y: (e.clientY - rect.top)   * scaleY,
    };
  }

  // ── Private ───────────────────────────────────────────

  _pushUndo(pageIdx) {
    const stack = this._undoStack[pageIdx];
    // Clone current rect array (shallow copy of rect objects is fine — rects are immutable value objects)
    stack.push([...this.rects[pageIdx]]);
    if (stack.length > 20) stack.shift(); // limit undo depth
  }
}

/**
 * Attach mouse drawing behaviour to a display canvas.
 * Returns a cleanup function.
 *
 * @param {HTMLCanvasElement} canvas      the display canvas in the DOM
 * @param {Redactor}          redactor
 * @param {number}            pageIdx
 * @param {Function}          onRedact    called after each rect is committed
 * @returns {Function}  call to detach listeners
 */
export function attachDrawing(canvas, redactor, pageIdx, onRedact) {
  let isDrawing = false;
  let startX = 0, startY = 0;
  let drawBox = null; // temporary visual box element

  function getBox(e) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    };
  }

  function createDrawBox() {
    drawBox = document.createElement('div');
    drawBox.className = 'draw-box';
    // Positioned relative to the page-wrapper parent
    canvas.parentElement.appendChild(drawBox);
  }

  function updateDrawBox(startCss, curCss) {
    const x = Math.min(startCss.x, curCss.x);
    const y = Math.min(startCss.y, curCss.y);
    const w = Math.abs(curCss.x - startCss.x);
    const h = Math.abs(curCss.y - startCss.y);
    Object.assign(drawBox.style, {
      left: `${x}px`, top: `${y}px`,
      width: `${w}px`, height: `${h}px`,
    });
  }

  function onMouseDown(e) {
    if (e.button !== 0) return;
    isDrawing = true;
    const pos = getBox(e);
    startX = pos.x; startY = pos.y;
    createDrawBox();
    e.preventDefault();
  }

  function onMouseMove(e) {
    if (!isDrawing) return;
    updateDrawBox({ x: startX, y: startY }, getBox(e));
  }

  function onMouseUp(e) {
    if (!isDrawing) return;
    isDrawing = false;

    const pos = getBox(e);
    const cssRect = {
      x: Math.min(startX, pos.x),
      y: Math.min(startY, pos.y),
      w: Math.abs(pos.x - startX),
      h: Math.abs(pos.y - startY),
    };

    if (drawBox) { drawBox.remove(); drawBox = null; }

    // Ignore tiny accidental clicks
    if (cssRect.w < 4 || cssRect.h < 4) return;

    // Convert CSS px to canvas px
    const canvasRect = canvas.getBoundingClientRect();
    const scaleX = redactor.pages[pageIdx].canvas.width  / canvasRect.width;
    const scaleY = redactor.pages[pageIdx].canvas.height / canvasRect.height;

    const canvasR = {
      x: cssRect.x * scaleX,
      y: cssRect.y * scaleY,
      w: cssRect.w * scaleX,
      h: cssRect.h * scaleY,
    };

    redactor.addRect(pageIdx, canvasR);
    if (onRedact) onRedact(pageIdx);
  }

  function onMouseLeave(e) {
    if (isDrawing) onMouseUp(e);
  }

  canvas.addEventListener('mousedown', onMouseDown);
  canvas.addEventListener('mousemove', onMouseMove);
  canvas.addEventListener('mouseup',   onMouseUp);
  canvas.addEventListener('mouseleave',onMouseLeave);

  // Touch support
  function toMouse(touch) {
    return { clientX: touch.clientX, clientY: touch.clientY, button: 0 };
  }
  canvas.addEventListener('touchstart', e => { onMouseDown(toMouse(e.touches[0])); e.preventDefault(); }, { passive: false });
  canvas.addEventListener('touchmove',  e => { onMouseMove(toMouse(e.touches[0])); e.preventDefault(); }, { passive: false });
  canvas.addEventListener('touchend',   e => { onMouseUp(toMouse(e.changedTouches[0])); e.preventDefault(); }, { passive: false });

  return () => {
    canvas.removeEventListener('mousedown',  onMouseDown);
    canvas.removeEventListener('mousemove',  onMouseMove);
    canvas.removeEventListener('mouseup',    onMouseUp);
    canvas.removeEventListener('mouseleave', onMouseLeave);
  };
}

/**
 * Draw a single redaction rect onto target context.
 * Supports solid black boxes and mathematically irreversible heavy pixelation.
 */
export function drawRedactionRect(ctx, srcCanvas, r) {
  if (r.type === 'pixelate') {
    applyDestructivePixelate(ctx, srcCanvas, r.x, r.y, r.w, r.h);
  } else {
    ctx.fillStyle = '#000000';
    ctx.fillRect(r.x, r.y, r.w, r.h);
  }
}

/**
 * Irreversibly pixelates a region of srcCanvas onto ctx.
 * Downsamples the region to ~8-12% resolution onto an offscreen buffer,
 * permanently discarding high-frequency facial features and biometric markers,
 * then paints back as crisp mosaic blocks with smoothing disabled.
 */
export function applyDestructivePixelate(ctx, srcCanvas, x, y, w, h) {
  const rx = Math.max(0, Math.round(x));
  const ry = Math.max(0, Math.round(y));
  const rw = Math.min(ctx.canvas.width - rx, Math.round(w));
  const rh = Math.min(ctx.canvas.height - ry, Math.round(h));
  if (rw <= 0 || rh <= 0) return;

  // Block size: 12-20px for heavy irreversible anonymization
  const minDim = Math.min(rw, rh);
  const blockSize = Math.max(10, Math.min(24, Math.round(minDim / 8)));
  const cols = Math.max(2, Math.round(rw / blockSize));
  const rows = Math.max(2, Math.round(rh / blockSize));

  const off = document.createElement('canvas');
  off.width  = cols;
  off.height = rows;
  const offCtx = off.getContext('2d');

  // Downsample to destroy biometric micro-textures
  offCtx.drawImage(srcCanvas, rx, ry, rw, rh, 0, 0, cols, rows);

  // Paint coarse mosaic blocks back onto canvas
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.mozImageSmoothingEnabled = false;
  ctx.webkitImageSmoothingEnabled = false;
  ctx.msImageSmoothingEnabled = false;
  ctx.drawImage(off, 0, 0, cols, rows, rx, ry, rw, rh);
  ctx.restore();
}
