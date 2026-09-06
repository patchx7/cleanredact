/**
 * batchProcessor.js
 * Sequential, client-side batch redaction engine with JSZip packaging.
 *
 * Core capabilities:
 *  - Processes up to 20 documents sequentially to prevent browser memory exhaustion.
 *  - Strips metadata and burns redactions destructively into raw image layers.
 *  - Supports IBANs, Emails/Phones, Monetary Amounts, Custom Terms, and Face Pixelation.
 *  - Compiles clean documents into a single downloadable .zip archive.
 */

import { renderImage } from './renderer.js';
import { scanCanvas, scanCustomWord } from './autoScan.js';
import { detectFaces } from './faceDetector.js';
import { applyDestructivePixelate } from './redactor.js';
import { stripPDFMeta } from './metaCleaner.js';

const MAX_PAGES_PER_DOC = 20;
const PDF_RENDER_SCALE  = 2.0;

/**
 * Process a queue of files with selected redaction rules.
 *
 * @param {File[]} files
 * @param {Object} rules
 * @param {boolean} rules.stripMeta
 * @param {boolean} rules.redactIban
 * @param {boolean} rules.redactEmail
 * @param {boolean} rules.redactAmount
 * @param {boolean} rules.redactFaces
 * @param {string}  rules.customWord
 * @param {Object}  callbacks
 * @param {Function} callbacks.onProgress   (currentFileIdx, totalFiles, overallPercent, message) => void
 * @param {Function} callbacks.onFileStatus (fileIdx, status: 'processing'|'done'|'error', message: string) => void
 * @param {Function} callbacks.onComplete   (zipBlob, stats: { total, succeeded, failed }) => void
 * @param {Function} callbacks.onError      (error) => void
 */
export async function processBatchQueue(files, rules, { onProgress, onFileStatus, onComplete, onError }) {
  const ZipConstructor = window.JSZip || (typeof JSZip !== 'undefined' ? JSZip : null);
  if (!ZipConstructor) {
    const err = new Error('JSZip library is not loaded.');
    if (onError) onError(err);
    return;
  }

  const zip = new ZipConstructor();
  const total = files.length;
  let succeeded = 0;
  let failed = 0;

  for (let i = 0; i < total; i++) {
    const file = files[i];
    if (onFileStatus) onFileStatus(i, 'processing', 'Processing\u2026');

    try {
      const baseProgress = (i / total) * 95; // 0% to 95% allocated to files
      const fileWeight   = (1 / total) * 95;

      const onPageProg = (pageIndex, pageCount) => {
        const fraction = pageCount > 0 ? (pageIndex / pageCount) : 1;
        const currentPct = Math.round(baseProgress + fraction * fileWeight);
        const msg = `Processing file ${i + 1} of ${total}: ${file.name} (${pageIndex}/${pageCount})`;
        if (onProgress) onProgress(i + 1, total, currentPct, msg);
      };

      await processSingleBatchFile(file, rules, zip, onPageProg);

      succeeded++;
      if (onFileStatus) onFileStatus(i, 'done', 'Done \u2713');
    } catch (fileErr) {
      console.error(`Batch error on file "${file.name}":`, fileErr);
      failed++;
      if (onFileStatus) onFileStatus(i, 'error', fileErr.message || 'Error');
    }
  }

  if (succeeded === 0) {
    const err = new Error('All files in batch failed to process.');
    if (onError) onError(err);
    return;
  }

  // Generate and download ZIP
  if (onProgress) onProgress(total, total, 96, 'Building ZIP archive\u2026');

  try {
    const zipBlob = await zip.generateAsync(
      { type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } },
      meta => {
        const zipPct = 96 + Math.round((meta.percent / 100) * 4);
        if (onProgress) onProgress(total, total, Math.min(100, zipPct), `Compressing ZIP: ${Math.round(meta.percent)}%`);
      }
    );

    triggerBatchDownload(zipBlob, 'CleanRedact_Batch_Export.zip');

    if (onComplete) {
      onComplete(zipBlob, { total, succeeded, failed });
    }
  } catch (zipErr) {
    console.error('Failed generating batch ZIP:', zipErr);
    if (onError) onError(zipErr);
  }
}

/**
 * Process an individual file destructively and store it in the ZIP.
 */
async function processSingleBatchFile(file, rules, zip, onPageProgress) {
  const isPDF = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
  const buffer = await file.arrayBuffer();

  const baseName = sanitizeFilename(file.name.replace(/\.[^.]+$/, ''));

  if (isPDF) {
    await processPdfDocument(buffer, baseName, rules, zip, onPageProgress);
  } else {
    await processImageDocument(buffer, file.type, baseName, rules, zip, onPageProgress);
  }
}

/**
 * Render PDF pages sequentially, apply redactions, re-embed into a fresh raster PDF, and add to ZIP.
 */
async function processPdfDocument(buffer, baseName, rules, zip, onPageProgress) {
  const pdfjsLib = window['pdfjs-dist/build/pdf'];
  if (!pdfjsLib) throw new Error('PDF.js library is not available.');
  const { PDFDocument } = window.PDFLib || (typeof PDFLib !== 'undefined' ? PDFLib : {});
  if (!PDFDocument) throw new Error('pdf-lib library is not available.');

  const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(buffer) });
  const pdf = await loadingTask.promise;
  const numPages = Math.min(pdf.numPages, MAX_PAGES_PER_DOC);

  const outDoc = await PDFDocument.create();

  for (let p = 1; p <= numPages; p++) {
    if (onPageProgress) onPageProgress(p, numPages);

    const page = await pdf.getPage(p);
    const viewport = page.getViewport({ scale: PDF_RENDER_SCALE });

    const canvas = document.createElement('canvas');
    canvas.width  = viewport.width;
    canvas.height = viewport.height;
    const ctx = canvas.getContext('2d');

    // Force opaque white background
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    await page.render({ canvasContext: ctx, viewport }).promise;

    // Apply auto-scan text patterns & custom terms
    await applyRulesToCanvas(canvas, ctx, rules);

    // Convert redacted canvas to JPEG buffer (high quality, small footprint)
    const jpegBytes = await canvasToBuffer(canvas, 'image/jpeg', 0.92);
    const embeddedImg = await outDoc.embedJpg(jpegBytes);

    const pageW = viewport.width / PDF_RENDER_SCALE;
    const pageH = viewport.height / PDF_RENDER_SCALE;
    const newPage = outDoc.addPage([pageW, pageH]);
    newPage.drawImage(embeddedImg, { x: 0, y: 0, width: pageW, height: pageH });

    // Explicitly zero canvas to free memory immediately
    canvas.width = 0;
    canvas.height = 0;
  }

  if (rules.stripMeta) {
    stripPDFMeta(outDoc);
  }

  const pdfBytes = await outDoc.save();
  zip.file(`redacted_${baseName}.pdf`, pdfBytes);
}

/**
 * Render image file, apply redactions, export to clean PNG, and add to ZIP.
 */
async function processImageDocument(buffer, mimeType, baseName, rules, zip, onPageProgress) {
  if (onPageProgress) onPageProgress(1, 1);

  const pages = await renderImage(buffer, mimeType || 'image/png');
  const canvas = pages[0].canvas;
  const ctx = canvas.getContext('2d');

  // Apply auto-scan text patterns & custom terms
  await applyRulesToCanvas(canvas, ctx, rules);

  // Export to clean PNG (lossless, canvas export discards all original metadata)
  const pngBytes = await canvasToBuffer(canvas, 'image/png');
  zip.file(`redacted_${baseName}.png`, pngBytes);

  // Zero canvas to free memory
  canvas.width = 0;
  canvas.height = 0;
}

/**
 * Scan canvas and apply solid black boxes or face pixelation based on active rules.
 */
async function applyRulesToCanvas(canvas, ctx, rules) {
  const activePatterns = [];
  if (rules.redactIban)   activePatterns.push('iban');
  if (rules.redactEmail)  activePatterns.push('email');
  if (rules.redactAmount) activePatterns.push('amount');

  // 1. Text patterns
  for (const patKey of activePatterns) {
    try {
      const matches = await scanCanvas(canvas, patKey);
      if (matches && matches.length) {
        ctx.fillStyle = '#000000';
        for (const m of matches) {
          ctx.fillRect(m.x, m.y, m.w, m.h);
        }
      }
    } catch (e) {
      console.warn(`Pattern scan "${patKey}" failed on page:`, e);
    }
  }

  // 2. Custom word / name
  if (rules.customWord && rules.customWord.trim()) {
    try {
      const customMatches = await scanCustomWord(canvas, rules.customWord.trim());
      if (customMatches && customMatches.length) {
        ctx.fillStyle = '#000000';
        for (const m of customMatches) {
          ctx.fillRect(m.x, m.y, m.w, m.h);
        }
      }
    } catch (e) {
      console.warn('Custom word scan failed on page:', e);
    }
  }

  // 3. Facial detection & destructive pixelation
  if (rules.redactFaces) {
    try {
      const faceMatches = await detectFaces(canvas);
      if (faceMatches && faceMatches.length) {
        for (const f of faceMatches) {
          applyDestructivePixelate(ctx, canvas, f.x, f.y, f.w, f.h);
        }
      }
    } catch (e) {
      console.warn('Face detection failed on page:', e);
    }
  }
}

/**
 * Convert HTMLCanvasElement to Uint8Array buffer without large string allocations.
 */
function canvasToBuffer(canvas, type = 'image/png', quality = 0.92) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(async blob => {
      if (!blob) {
        return reject(new Error('Canvas toBlob returned null'));
      }
      try {
        const buf = await blob.arrayBuffer();
        resolve(new Uint8Array(buf));
      } catch (err) {
        reject(err);
      }
    }, type, quality);
  });
}

/**
 * Trigger immediate browser download of the generated ZIP Blob.
 */
function triggerBatchDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    if (a.parentNode) a.parentNode.removeChild(a);
    URL.revokeObjectURL(url);
  }, 2000);
}

/**
 * Sanitize filename to prevent illegal filesystem characters.
 */
function sanitizeFilename(name) {
  return name.replace(/[^a-zA-Z0-9_\-\.]/g, '_');
}
