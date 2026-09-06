/**
 * app.js — CleanRedact editor orchestrator
 *
 * Coordinates: fileHandler → renderer → redactor → autoScan → downloader
 * All state lives in the `state` object.
 */

import { initFileHandler, showToast }   from './fileHandler.js';
import { renderPDF, renderImage, makeThumbnail } from './renderer.js';
import { Redactor, attachDrawing }      from './redactor.js';
import { scanCanvas, scanCustomWord, PATTERNS } from './autoScan.js';
import { describeImageMeta }            from './metaCleaner.js';
import { downloadRedacted }             from './downloader.js';
import { detectFaces }                  from './faceDetector.js';
import { processBatchQueue }            from './batchProcessor.js';

// ── State ─────────────────────────────────────────────────────────────────

const state = {
  file:            null,
  fileType:        null,   // 'pdf' | 'image'
  mimeType:        null,
  pages:           [],     // [{canvas,width,height,pageNum}]
  redactor:        null,
  currentPage:     0,
  scale:           1.0,
  mode:            'draw', // 'draw' | 'select'
  faceMode:        'pixelate', // 'pixelate' | 'black'
  metaStripped:    false,
  drawCleanup:     [],     // detach functions from attachDrawing
  batchFiles:      [],     // File[] in batch mode
  batchProcessing: false,
};

const MAX_PAGES = 20;

// ── DOM refs ──────────────────────────────────────────────────────────────

const $ = id => document.getElementById(id);

const dropZoneEl          = $('drop-zone');
const fileInputEl         = $('file-input');
const mainEl              = $('app-main');
const pagesEl             = $('app-pages');
const sidebarEl           = $('app-sidebar');
const loadingEl           = $('loading-overlay');
const loadingTextEl       = $('loading-text');
const downloadBtn         = $('btn-download');
const newFileBtn          = $('btn-new');
const headerFilename      = $('header-filename');
const headerBadge         = $('header-badge');
const hintBar             = $('hint-bar');
const btnMetaStrip        = $('btn-meta-strip');
const metaInfoEl          = $('meta-info-text');
const btnZoomIn           = $('btn-zoom-in');
const btnZoomOut          = $('btn-zoom-out');
const btnZoomFit          = $('btn-zoom-fit');
const zoomInput           = $('zoom-input');
const pageCounter         = $('page-counter');
const modal               = $('modal-overlay');
const modalTitle          = $('modal-title');
const modalMsg            = $('modal-msg');
const modalConfirm        = $('modal-confirm');
const modalCancel         = $('modal-cancel');
const customRedactInput    = $('custom-redact-input');
const btnCustomRedact      = $('btn-custom-redact');
const customRedactFeedback = $('custom-redact-feedback');

// Batch mode DOM refs
const batchViewEl          = $('batch-view');
const batchFileCountEl     = $('batch-file-count');
const btnBatchAddMore      = $('btn-batch-add-more');
const btnBatchClear        = $('btn-batch-clear');
const btnProcessBatch      = $('btn-process-batch');
const batchProgressCard    = $('batch-progress-card');
const batchProgressText    = $('batch-progress-text');
const batchProgressPercent = $('batch-progress-percent');
const batchProgressBarFill = $('batch-progress-bar-fill');
const batchTableBody       = $('batch-table-body');
const batchRuleMeta        = $('batch-rule-meta');
const batchRuleIban        = $('batch-rule-iban');
const batchRuleEmail       = $('batch-rule-email');
const batchRuleAmount      = $('batch-rule-amount');
const batchRuleFace        = $('batch-rule-face');
const batchCustomWord      = $('batch-custom-word');

// ── Init ──────────────────────────────────────────────────────────────────

function init() {
  window.applyI18n?.();

  initFileHandler(dropZoneEl, fileInputEl, onFileLoaded, onBatchFiles, () => state.batchFiles && state.batchFiles.length > 0);

  // Batch action buttons
  if (btnBatchAddMore) {
    btnBatchAddMore.addEventListener('click', () => {
      fileInputEl.value = '';
      fileInputEl.click();
    });
  }
  if (btnBatchClear) {
    btnBatchClear.addEventListener('click', resetApp);
  }
  if (btnProcessBatch) {
    btnProcessBatch.addEventListener('click', onProcessBatchClick);
  }

  // Tool buttons
  document.querySelectorAll('[data-tool]').forEach(btn => {
    btn.addEventListener('click', () => onToolClick(btn.dataset.tool));
  });

  downloadBtn.addEventListener('click', onDownload);
  newFileBtn.addEventListener('click',  resetApp);

  btnZoomIn.addEventListener('click',  () => setZoom(state.scale + 0.15));
  btnZoomOut.addEventListener('click', () => setZoom(state.scale - 0.15));
  btnZoomFit.addEventListener('click', fitToWindow);

  // Editable Zoom input: click & type custom percentage
  if (zoomInput) {
    zoomInput.addEventListener('focus', () => zoomInput.select());
    zoomInput.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        applyZoomInput();
        zoomInput.blur();
      } else if (e.key === 'Escape') {
        zoomInput.value = `${Math.round(state.scale * 100)}%`;
        zoomInput.blur();
      }
    });
    zoomInput.addEventListener('blur', applyZoomInput);
  }

  btnMetaStrip.addEventListener('click', onStripMeta);

  // Custom Word / Name Redaction
  if (btnCustomRedact) {
    btnCustomRedact.addEventListener('click', onCustomRedact);
  }
  if (customRedactInput) {
    customRedactInput.addEventListener('keydown', e => {
      if (e.key === 'Enter') onCustomRedact();
    });
  }

  // Face Redaction Mode Toggle
  const btnModePixelate = $('face-mode-pixelate');
  const btnModeBlack    = $('face-mode-black');
  if (btnModePixelate && btnModeBlack) {
    btnModePixelate.addEventListener('click', () => setFaceMode('pixelate'));
    btnModeBlack.addEventListener('click', () => setFaceMode('black'));
  }

  // Modal
  modalCancel.addEventListener('click',  () => closeModal());

  // Legal & Privacy modal
  const legalModal  = $('legal-modal');
  const btnPrivacy  = $('app-btn-privacy');
  const btnTerms    = $('app-btn-terms');
  const btnClose    = $('legal-modal-close');
  const tabPrivacy  = $('tab-btn-privacy');
  const tabTerms    = $('tab-btn-terms');
  const secPrivacy  = $('legal-section-privacy');
  const secTerms    = $('legal-section-terms');

  function openLegal(tab) {
    if (!legalModal) return;
    legalModal.style.display = 'flex';
    if (tab === 'terms') {
      tabTerms?.classList.add('active');
      tabPrivacy?.classList.remove('active');
      if (secTerms) secTerms.style.display = 'block';
      if (secPrivacy) secPrivacy.style.display = 'none';
    } else {
      tabPrivacy?.classList.add('active');
      tabTerms?.classList.remove('active');
      if (secPrivacy) secPrivacy.style.display = 'block';
      if (secTerms) secTerms.style.display = 'none';
    }
  }

  btnPrivacy?.addEventListener('click', (e) => { e.preventDefault(); openLegal('privacy'); });
  btnTerms?.addEventListener('click', (e) => { e.preventDefault(); openLegal('terms'); });
  btnClose?.addEventListener('click', () => { if (legalModal) legalModal.style.display = 'none'; });
  legalModal?.addEventListener('click', (e) => {
    if (e.target === legalModal) legalModal.style.display = 'none';
  });
  tabPrivacy?.addEventListener('click', () => openLegal('privacy'));
  tabTerms?.addEventListener('click', () => openLegal('terms'));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && legalModal && legalModal.style.display !== 'none') {
      legalModal.style.display = 'none';
    }
  });

  // Translate static UI strings
  applyToolbarI18n();
}

// ── File loaded ───────────────────────────────────────────────────────────

async function onFileLoaded(file, buffer, fileType) {
  state.file     = file;
  state.fileType = fileType;
  state.mimeType = file.type;

  showLoading(window.__t('app_processing'));

  try {
    let pages, truncated = false, totalPDF = 0;

    if (fileType === 'pdf') {
      const result = await renderPDF(buffer, (cur, tot) => {
        showLoading(`${window.__t('app_processing')} ${cur}/${tot}`);
      });
      pages    = result.pages;
      truncated = result.truncated;
      totalPDF  = result.totalPDF;
    } else {
      pages = await renderImage(buffer, file.type);
    }

    state.pages       = pages;
    state.redactor    = new Redactor(pages);
    state.metaStripped= false;
    state.currentPage = 0;

    // Update header: ensure English look, replacing generic OS exports like "Unbenannt...", "Unbenanntes Dokument-2.pdf"
    let rawName = (file && file.name) ? file.name : 'Untitled Document.pdf';
    const displayName = rawName.replace(/^unbenannt(?:es)?(?:[\s\-_]*dokument)?/i, 'Untitled Document');
    headerFilename.textContent = displayName;
    headerFilename.title       = displayName;
    headerBadge.textContent    = `${pages.length} ${pages.length === 1 ? 'Page' : 'Pages'}`;

    // Build editor UI
    buildEditorUI();

    // Show page limit warning if truncated
    if (truncated) {
      setTimeout(() => {
        showConfirmModal(
          window.__t('app_limit_title'),
          `${window.__t('app_limit_msg')} (PDF had ${totalPDF} pages, showing first 20.)`,
          null, null, true
        );
      }, 300);
    }

    // Populate metadata info
    if (fileType === 'image') {
      metaInfoEl.textContent = describeImageMeta(buffer, file.type);
    } else {
      metaInfoEl.textContent = 'PDF: Author, Creator, Producer, Timestamps will be wiped.';
    }

    setMode('draw');
    hideLoading();

    showToast('File loaded. Draw boxes or use Auto-Scan.', 'success');

  } catch (err) {
    console.error(err);
    hideLoading();
    showToast('Failed to process file: ' + (err.message || err), 'error');
  }
}

// ── Build / refresh editor DOM ────────────────────────────────────────────

function buildEditorUI() {
  // Clean up previous drawing listeners
  state.drawCleanup.forEach(fn => fn());
  state.drawCleanup = [];

  // Remove existing page wrappers, leaving dropZoneEl and batchViewEl intact
  mainEl.querySelectorAll('.page-wrapper').forEach(el => el.remove());
  pagesEl.innerHTML  = '';

  dropZoneEl.style.display = 'none';
  if (batchViewEl) batchViewEl.style.display = 'none';
  mainEl.style.display     = 'flex';
  pagesEl.style.display    = 'flex';
  sidebarEl.style.pointerEvents = 'all';
  downloadBtn.disabled = false;

  state.pages.forEach((pageData, idx) => {
    const pageWrapper = buildPageWrapper(pageData, idx);
    mainEl.appendChild(pageWrapper);

    // Thumbnail
    const thumb = buildThumbnail(pageData, idx);
    pagesEl.appendChild(thumb);
  });

  // Scroll to current page
  scrollToPage(state.currentPage);
  updatePageCounter();

  // Set up scroll-based page tracking
  setupPageObserver();
}

function buildPageWrapper(pageData, idx) {
  const wrapper = document.createElement('div');
  wrapper.className = 'page-wrapper';
  wrapper.dataset.pageIdx = idx;
  wrapper.id = `page-wrapper-${idx}`;

  const displayCanvas = document.createElement('canvas');
  displayCanvas.className = 'page-canvas';
  displayCanvas.id = `page-canvas-${idx}`;

  wrapper.appendChild(displayCanvas);

  // Render display
  const cssWidth = computeDisplayWidth(pageData, state.scale);
  state.redactor.renderDisplay(idx, displayCanvas, cssWidth);

  // Attach drawing
  const cleanup = attachDrawing(displayCanvas, state.redactor, idx, onRedactApplied);
  state.drawCleanup.push(cleanup);

  // Page label
  const label = document.createElement('div');
  label.className = 'page-label';
  label.textContent = `${window.__t('app_page')} ${idx + 1}`;
  wrapper.appendChild(label);

  return wrapper;
}

function buildThumbnail(pageData, pageIdx) {
  const thumb = makeThumbnail(pageData.canvas, 100);
  thumb.className = `page-thumb ${pageIdx === state.currentPage ? 'active' : ''}`;
  thumb.id        = `page-thumb-${pageIdx}`;
  thumb.title     = `${window.__t('app_page')} ${pageIdx + 1}`;

  const label = document.createElement('span');
  label.className   = 'page-thumb-num';
  label.textContent = `${pageIdx + 1}`;
  thumb.appendChild(label);

  thumb.addEventListener('click', () => {
    state.currentPage = pageIdx;
    scrollToPage(pageIdx);
    setActiveThumb(pageIdx);
    updatePageCounter();
  });

  return thumb;
}

function setActiveThumb(pageIdx) {
  document.querySelectorAll('.page-thumb').forEach((el, i) => {
    el.classList.toggle('active', i === pageIdx);
  });
}

// ── Toolbar actions ───────────────────────────────────────────────────────

function onToolClick(tool) {
  switch (tool) {
    case 'draw':
      setMode('draw');
      break;
    case 'undo':
      onUndo();
      break;
    case 'clear':
      onClear();
      break;
    case 'iban':
    case 'email':
    case 'amount':
    case 'all':
      onAutoScan(tool);
      break;
    case 'face':
      onFaceRedact();
      break;
  }
}

function setMode(mode) {
  state.mode = mode;
  document.querySelectorAll('.tool-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.tool === mode);
  });

  if (mode === 'draw') {
    hintBar.textContent = window.__t('app_hint_draw');
  }
}

function onUndo() {
  if (!state.redactor) return;
  const changed = state.redactor.undo(state.currentPage);
  if (changed) {
    refreshPage(state.currentPage);
    showToast('Undid last redaction.', 'info');
  } else {
    showToast('Nothing to undo on this page.', 'info');
  }
}

function onClear() {
  if (!state.redactor) return;
  const rectCount = state.redactor.getRectCount(state.currentPage);
  if (rectCount === 0) {
    showToast('Page has no redactions.', 'info');
    return;
  }
  showConfirmModal(
    window.__t('app_tool_clear'),
    `Clear all ${rectCount} redaction(s) on Page ${state.currentPage + 1}?`,
    () => {
      state.redactor.clearPage(state.currentPage);
      refreshPage(state.currentPage);
      showToast('Page cleared.', 'info');
    }
  );
}

// ── Auto-Scan ─────────────────────────────────────────────────────────────

async function onAutoScan(patternKey) {
  if (!state.redactor || !state.pages.length) return;

  const { canvas: pageCanvas } = state.pages[state.currentPage];
  showLoading(window.__t('app_scanning'));

  try {
    const matches = await scanCanvas(
      pageCanvas,
      patternKey,
      msg => { if (loadingTextEl) loadingTextEl.textContent = msg; }
    );

    hideLoading();

    if (!matches || matches.length === 0) {
      showConfirmModal(
        'Auto-Scan',
        window.__t('app_scan_none'),
        null, null, true
      );
      return;
    }

    const patternLabel = PATTERNS[patternKey]?.label || 'Pattern';
    showConfirmModal(
      `Auto-Scan: ${patternLabel}`,
      `Found ${matches.length} ${patternLabel} match(es) on Page ${state.currentPage + 1}. Apply redactions?`,
      () => {
        matches.forEach(m => {
          state.redactor.addRect(state.currentPage, m);
        });
        refreshPage(state.currentPage);
        showToast(`Applied ${matches.length} redaction(s).`, 'success');
      }
    );

  } catch (err) {
    console.error(err);
    hideLoading();
    showToast('Scan failed: ' + (err.message || err), 'error');
  }
}

// ── Custom Word / Name Redaction ──────────────────────────────────────────

async function onCustomRedact() {
  if (!state.redactor || !state.pages.length) {
    showToast('Please load a document first.', 'info');
    return;
  }

  const query = customRedactInput ? customRedactInput.value.trim() : '';
  if (!query) {
    if (customRedactInput) customRedactInput.focus();
    return;
  }

  if (btnCustomRedact) btnCustomRedact.disabled = true;
  if (customRedactFeedback) {
    customRedactFeedback.textContent = 'Searching…';
    customRedactFeedback.className   = 'custom-redact-feedback';
  }

  try {
    const { canvas: pageCanvas } = state.pages[state.currentPage];
    const matches = await scanCustomWord(pageCanvas, query, msg => {
      if (loadingTextEl) loadingTextEl.textContent = msg;
    });

    if (!matches || matches.length === 0) {
      if (customRedactFeedback) {
        customRedactFeedback.textContent = 'No matches found';
        customRedactFeedback.className   = 'custom-redact-feedback empty';
      }
      showToast(`No matches found for "${query}" on Page ${state.currentPage + 1}.`, 'info');
    } else {
      matches.forEach(m => {
        state.redactor.addRect(state.currentPage, m);
      });
      refreshPage(state.currentPage);
      const timesText = matches.length === 1 ? '1 time' : `${matches.length} times`;
      if (customRedactFeedback) {
        customRedactFeedback.textContent = `Found & redacted: ${timesText}`;
        customRedactFeedback.className   = 'custom-redact-feedback success';
      }
      showToast(`Redacted ${matches.length} occurrence(s) of "${query}".`, 'success');
    }
  } catch (err) {
    console.error(err);
    if (customRedactFeedback) {
      customRedactFeedback.textContent = 'Scan failed';
      customRedactFeedback.className   = 'custom-redact-feedback empty';
    }
    showToast('Redaction failed: ' + (err.message || err), 'error');
  } finally {
    if (btnCustomRedact) btnCustomRedact.disabled = false;
  }
}

// ── Face Redaction & Blur ─────────────────────────────────────────────────

function setFaceMode(mode) {
  state.faceMode = mode;
  const btnPixel = $('face-mode-pixelate');
  const btnBlack = $('face-mode-black');
  if (btnPixel) btnPixel.classList.toggle('active', mode === 'pixelate');
  if (btnBlack) btnBlack.classList.toggle('active', mode === 'black');
}

async function onFaceRedact() {
  if (!state.redactor || !state.pages.length) {
    showToast('Please load a document first.', 'info');
    return;
  }

  const toolFaceBtn = $('tool-face');
  if (toolFaceBtn) toolFaceBtn.disabled = true;

  showLoading(window.__t('app_face_detecting'));

  try {
    const { canvas: pageCanvas } = state.pages[state.currentPage];
    const faces = await detectFaces(pageCanvas, {
      minConfidence: 0.85,
      paddingRatio: 0.15,
    });

    hideLoading();

    if (!faces || faces.length === 0) {
      showToast(window.__t('app_face_none'), 'info');
      return;
    }

    // 1. Show transient visual preview highlights for 1.2 seconds
    showFaceHighlightPreviews(faces, state.currentPage);

    // 2. Add permanent redaction rectangles to the page state
    const mode = state.faceMode || 'pixelate';
    faces.forEach(f => {
      state.redactor.addRect(state.currentPage, {
        x: f.x,
        y: f.y,
        w: f.w,
        h: f.h,
        type: mode,
      });
    });

    // 3. Re-render display canvas
    refreshPage(state.currentPage);

    const modeLabel = mode === 'pixelate' ? 'Pixelate' : 'Black Box';
    const faceText = faces.length === 1 ? '1 face' : `${faces.length} faces`;
    showToast(`Redacted ${faceText} (${modeLabel}).`, 'success');
  } catch (err) {
    hideLoading();
    console.error('Face detection failed:', err);
    showToast('Face detection failed: ' + (err.message || err), 'error');
  } finally {
    if (toolFaceBtn) toolFaceBtn.disabled = false;
  }
}

function showFaceHighlightPreviews(faces, pageIdx) {
  const wrapper = $(`page-wrapper-${pageIdx}`);
  const displayCanvas = $(`page-canvas-${pageIdx}`);
  if (!wrapper || !displayCanvas) return;

  const src = state.pages[pageIdx].canvas;
  const scale = displayCanvas.offsetWidth / src.width;

  const highlightElements = [];

  for (const f of faces) {
    const el = document.createElement('div');
    el.className = 'face-highlight-box';
    el.style.left   = `${Math.round(f.x * scale)}px`;
    el.style.top    = `${Math.round(f.y * scale)}px`;
    el.style.width  = `${Math.round(f.w * scale)}px`;
    el.style.height = `${Math.round(f.h * scale)}px`;
    wrapper.appendChild(el);
    highlightElements.push(el);
  }

  // Remove highlight boxes after 1.2s animation finishes
  setTimeout(() => {
    highlightElements.forEach(el => el.remove());
  }, 1250);
}

// ── Metadata ──────────────────────────────────────────────────────────────

function onStripMeta() {
  state.metaStripped = true;
  btnMetaStrip.textContent = window.__t('app_meta_done');
  btnMetaStrip.classList.add('done');
  btnMetaStrip.disabled = true;
  showToast('Metadata will be stripped on download.', 'success');
}

// ── Download ──────────────────────────────────────────────────────────────

async function onDownload() {
  if (!state.redactor) return;

  // Always strip meta silently on download
  state.metaStripped = true;
  btnMetaStrip.textContent = window.__t('app_meta_done');
  btnMetaStrip.classList.add('done');

  showLoading(window.__t('app_processing'));
  downloadBtn.disabled = true;

  try {
    const rawName = (state.file && state.file.name) ? state.file.name : 'Untitled Document';
    const exportName = rawName.replace(/^unbenannt(?:es)?(?:[\s\-_]*dokument)?/i, 'Untitled_Document');
    await downloadRedacted(
      state.redactor,
      state.fileType,
      exportName,
      state.mimeType,
      msg => { if (loadingTextEl) loadingTextEl.textContent = msg; }
    );
    showToast('Download started.', 'success');
  } catch (err) {
    console.error(err);
    showToast('Download failed: ' + (err.message || err), 'error');
  } finally {
    hideLoading();
    downloadBtn.disabled = false;
  }
}

// ── Zoom ──────────────────────────────────────────────────────────────────

function setZoom(newScale) {
  state.scale = Math.max(0.3, Math.min(3.0, newScale));
  if (zoomInput) {
    zoomInput.value = `${Math.round(state.scale * 100)}%`;
  }

  state.pages.forEach((pageData, idx) => {
    const canvas = document.getElementById(`page-canvas-${idx}`);
    if (!canvas) return;
    const cssWidth = computeDisplayWidth(pageData, state.scale);
    state.redactor.renderDisplay(idx, canvas, cssWidth);
  });
}

function applyZoomInput() {
  if (!zoomInput) return;
  const raw = zoomInput.value.replace(/[^0-9.]/g, '');
  const num = parseFloat(raw);
  if (!isNaN(num) && num > 0) {
    setZoom(num / 100);
  } else {
    zoomInput.value = `${Math.round(state.scale * 100)}%`;
  }
}

function fitToWindow() {
  if (!state.pages.length) return;
  const availableWidth = mainEl.clientWidth - 48;
  const pageWidth = state.pages[state.currentPage].width;
  setZoom(availableWidth / (pageWidth || 800));
}

function computeDisplayWidth(pageData, scale) {
  return Math.round(pageData.width * scale);
}

// ── Refresh ───────────────────────────────────────────────────────────────

function onRedactApplied(pageIdx) {
  refreshPage(pageIdx);
}

function refreshPage(pageIdx) {
  const canvas = document.getElementById(`page-canvas-${pageIdx}`);
  if (!canvas || !state.redactor) return;
  const cssWidth = computeDisplayWidth(state.pages[pageIdx], state.scale);
  state.redactor.renderDisplay(pageIdx, canvas, cssWidth);
}

// ── Navigation helpers ────────────────────────────────────────────────────

function scrollToPage(idx) {
  const wrapper = document.getElementById(`page-wrapper-${idx}`);
  if (wrapper) wrapper.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function updatePageCounter() {
  if (pageCounter) {
    pageCounter.textContent =
      `${window.__t('app_page')} ${state.currentPage + 1} ${window.__t('app_of')} ${state.pages.length}`;
  }
}

// ── Reset ─────────────────────────────────────────────────────────────────

function resetApp() {
  state.drawCleanup.forEach(fn => fn());
  Object.assign(state, {
    file: null, fileType: null, mimeType: null,
    pages: [], redactor: null, currentPage: 0, scale: 1.0,
    mode: 'draw', metaStripped: false, drawCleanup: [],
    batchFiles: [], batchProcessing: false,
  });

  mainEl.querySelectorAll('.page-wrapper').forEach(el => el.remove());
  pagesEl.innerHTML = '';
  dropZoneEl.style.display  = 'flex';
  if (batchViewEl) batchViewEl.style.display = 'none';
  if (batchProgressCard) batchProgressCard.style.display = 'none';
  if (batchTableBody) batchTableBody.innerHTML = '';
  mainEl.style.display      = 'flex';
  pagesEl.style.display     = 'none';
  downloadBtn.disabled      = true;
  headerFilename.textContent = '';
  headerFilename.title       = '';
  headerBadge.textContent    = '';
  if (pageCounter) pageCounter.textContent = '';
  btnMetaStrip.textContent  = window.__t('app_meta_btn');
  btnMetaStrip.classList.remove('done');
  btnMetaStrip.disabled     = false;
  metaInfoEl.textContent    = '';
  fileInputEl.value         = '';
  if (customRedactInput)    customRedactInput.value = '';
  if (customRedactFeedback) {
    customRedactFeedback.textContent = '';
    customRedactFeedback.className   = 'custom-redact-feedback';
  }
  if (btnProcessBatch) btnProcessBatch.disabled = false;
  if (btnBatchAddMore) btnBatchAddMore.disabled = false;
  if (btnBatchClear)   btnBatchClear.disabled = false;
}

// ── Batch Processing View & Controls ─────────────────────────────────────

function onBatchFiles(newFiles) {
  if (!newFiles || !newFiles.length) return;

  const current = state.batchFiles || [];
  const existingKeys = new Set(current.map(f => `${f.name}_${f.size}`));
  const fresh = newFiles.filter(f => !existingKeys.has(`${f.name}_${f.size}`));
  const combined = [...current, ...fresh].slice(0, 20);

  if (current.length + fresh.length > 20) {
    showToast('Batch limit reached: Maximum 20 files allowed.', 'info');
  }

  state.batchFiles = combined;
  state.file = null;
  state.pages = [];

  // Switch view
  mainEl.querySelectorAll('.page-wrapper').forEach(el => el.remove());
  dropZoneEl.style.display = 'none';
  pagesEl.style.display = 'none';
  mainEl.style.display = 'flex';
  if (batchViewEl) batchViewEl.style.display = 'flex';
  sidebarEl.style.pointerEvents = 'all';

  downloadBtn.disabled = true;
  headerFilename.textContent = `Batch Processing (${state.batchFiles.length} files)`;
  headerBadge.textContent = `${state.batchFiles.length} Files`;
  if (pageCounter) pageCounter.textContent = '';

  renderBatchTable();
}

function renderBatchTable() {
  if (!batchTableBody) return;
  batchTableBody.innerHTML = '';
  const count = state.batchFiles.length;
  if (batchFileCountEl) {
    batchFileCountEl.textContent = `${count} ${count === 1 ? 'file' : 'files'}`;
  }

  state.batchFiles.forEach((file, idx) => {
    const isPDF = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
    const tr = document.createElement('tr');
    tr.id = `batch-row-${idx}`;

    const docIconSvg = isPDF
      ? `<svg viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`
      : `<svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>`;

    const sizeText = file.size < 1024 * 1024
      ? `${Math.round(file.size / 1024)} KB`
      : `${(file.size / (1024 * 1024)).toFixed(1)} MB`;

    tr.innerHTML = `
      <td>
        <div class="batch-doc-name">
          <span class="batch-doc-icon">${docIconSvg}</span>
          <span class="batch-doc-title" title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</span>
        </div>
      </td>
      <td>${sizeText}</td>
      <td id="batch-pages-${idx}">${isPDF ? 'Detecting\u2026' : '1 Page'}</td>
      <td><span class="batch-status-badge ready" id="batch-status-${idx}">${window.__t('app_batch_status_ready')}</span></td>
      <td class="col-actions">
        <button type="button" class="btn-remove-row" data-idx="${idx}" title="Remove">
          <svg viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </td>
    `;

    const removeBtn = tr.querySelector('.btn-remove-row');
    removeBtn.addEventListener('click', () => {
      if (state.batchProcessing) return;
      state.batchFiles.splice(idx, 1);
      if (state.batchFiles.length === 0) {
        resetApp();
      } else {
        renderBatchTable();
        headerFilename.textContent = `Batch Processing (${state.batchFiles.length} files)`;
        headerBadge.textContent = `${state.batchFiles.length} Files`;
      }
    });

    batchTableBody.appendChild(tr);

    if (isPDF) {
      fetchPdfPageCount(file, idx);
    }
  });
}

async function fetchPdfPageCount(file, idx) {
  try {
    const pdfjsLib = window['pdfjs-dist/build/pdf'];
    if (!pdfjsLib) return;
    const buf = await file.arrayBuffer();
    const doc = await pdfjsLib.getDocument({ data: new Uint8Array(buf) }).promise;
    const cell = document.getElementById(`batch-pages-${idx}`);
    if (cell) {
      const count = doc.numPages;
      cell.textContent = `${count} ${count === 1 ? 'Page' : 'Pages'}${count > 20 ? ' (capped)' : ''}`;
    }
  } catch (e) {
    const cell = document.getElementById(`batch-pages-${idx}`);
    if (cell) cell.textContent = '—';
  }
}

async function onProcessBatchClick() {
  if (!state.batchFiles || state.batchFiles.length === 0) {
    showToast('No files in batch to process.', 'error');
    return;
  }
  if (state.batchProcessing) return;
  state.batchProcessing = true;

  if (btnProcessBatch) btnProcessBatch.disabled = true;
  if (btnBatchAddMore) btnBatchAddMore.disabled = true;
  if (btnBatchClear)   btnBatchClear.disabled = true;
  document.querySelectorAll('.btn-remove-row').forEach(b => b.disabled = true);

  const rules = {
    stripMeta:    batchRuleMeta    ? batchRuleMeta.checked    : true,
    redactIban:   batchRuleIban    ? batchRuleIban.checked    : true,
    redactEmail:  batchRuleEmail   ? batchRuleEmail.checked   : true,
    redactAmount: batchRuleAmount  ? batchRuleAmount.checked  : false,
    redactFaces:  batchRuleFace    ? batchRuleFace.checked    : false,
    customWord:   batchCustomWord  ? batchCustomWord.value.trim() : '',
  };

  if (batchProgressCard)    batchProgressCard.style.display = 'block';
  if (batchProgressText)    batchProgressText.textContent = 'Starting batch processing\u2026';
  if (batchProgressPercent) batchProgressPercent.textContent = '0%';
  if (batchProgressBarFill) batchProgressBarFill.style.width = '0%';

  await processBatchQueue(state.batchFiles, rules, {
    onProgress: (cur, tot, pct, msg) => {
      if (batchProgressText)    batchProgressText.textContent = msg;
      if (batchProgressPercent) batchProgressPercent.textContent = `${pct}%`;
      if (batchProgressBarFill) batchProgressBarFill.style.width = `${pct}%`;
    },
    onFileStatus: (fileIdx, status, detail) => {
      const badge = document.getElementById(`batch-status-${fileIdx}`);
      if (badge) {
        badge.className = `batch-status-badge ${status}`;
        badge.textContent = window.__t(`app_batch_status_${status}`) || detail;
      }
    },
    onComplete: (zipBlob, stats) => {
      state.batchProcessing = false;
      if (btnProcessBatch) btnProcessBatch.disabled = false;
      if (btnBatchAddMore) btnBatchAddMore.disabled = false;
      if (btnBatchClear)   btnBatchClear.disabled = false;
      document.querySelectorAll('.btn-remove-row').forEach(b => b.disabled = false);

      if (batchProgressPercent) batchProgressPercent.textContent = '100%';
      if (batchProgressBarFill) batchProgressBarFill.style.width = '100%';
      if (batchProgressText) {
        batchProgressText.textContent = `Completed! ${stats.succeeded} of ${stats.total} files exported.`;
      }
      showToast(`Batch complete: ${stats.succeeded} files downloaded in ZIP.`, 'success');
    },
    onError: (err) => {
      state.batchProcessing = false;
      if (btnProcessBatch) btnProcessBatch.disabled = false;
      if (btnBatchAddMore) btnBatchAddMore.disabled = false;
      if (btnBatchClear)   btnBatchClear.disabled = false;
      document.querySelectorAll('.btn-remove-row').forEach(b => b.disabled = false);
      showToast(`Batch failed: ${err.message || err}`, 'error');
    }
  });
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ── Modal ─────────────────────────────────────────────────────────────────

function showConfirmModal(title, msg, onConfirm, onCancel, infoOnly = false) {
  modalTitle.textContent   = title;
  modalMsg.textContent     = msg;
  modalConfirm.textContent = window.__t('app_confirm_apply');
  modalCancel.textContent  = infoOnly ? 'OK' : window.__t('app_confirm_skip');
  modalConfirm.style.display = infoOnly ? 'none' : '';

  modal.classList.add('visible');

  const doConfirm = () => {
    closeModal();
    if (onConfirm) onConfirm();
  };
  const doCancel = () => {
    closeModal();
    if (onCancel) onCancel();
  };

  modalConfirm._handler && modalConfirm.removeEventListener('click', modalConfirm._handler);
  modalCancel._handler  && modalCancel.removeEventListener('click',  modalCancel._handler);
  modalConfirm._handler = doConfirm;
  modalCancel._handler  = doCancel;
  modalConfirm.addEventListener('click', doConfirm);
  modalCancel.addEventListener('click',  doCancel);
}

function closeModal() {
  modal.classList.remove('visible');
}

// ── Loading overlay ───────────────────────────────────────────────────────

function showLoading(msg) {
  loadingEl.classList.remove('hidden');
  if (loadingTextEl && msg) loadingTextEl.textContent = msg;
}
function hideLoading() {
  loadingEl.classList.add('hidden');
}

// ── i18n helpers ─────────────────────────────────────────────────────────

function applyToolbarI18n() {
  const toolMap = {
    'tool-draw':   'app_tool_manual',
    'tool-undo':   'app_tool_undo',
    'tool-clear':  'app_tool_clear',
    'tool-iban':   'app_tool_iban',
    'tool-email':  'app_tool_email',
    'tool-amount': 'app_tool_amount',
    'tool-all':    'app_tool_all',
    'tool-face':   'app_tool_face',
  };
  Object.entries(toolMap).forEach(([id, key]) => {
    const el = document.getElementById(id);
    if (el) {
      const span = el.querySelector('.tool-label');
      if (span) span.textContent = window.__t(key);
    }
  });
}

// ── Intersection Observer: track current page ─────────────────────────────

function setupPageObserver() {
  const observer = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        const idx = parseInt(entry.target.dataset.pageIdx, 10);
        if (!isNaN(idx) && idx !== state.currentPage) {
          state.currentPage = idx;
          updatePageCounter();
          document.querySelectorAll('.page-thumb').forEach((t, i) =>
            t.classList.toggle('active', i === idx));
        }
      }
    });
  }, { root: mainEl, threshold: 0.5 });

  document.querySelectorAll('.page-wrapper').forEach(el => observer.observe(el));
  return observer;
}

// ── Bootstrap ─────────────────────────────────────────────────────────────
init();

