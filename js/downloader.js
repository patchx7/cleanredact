/**
 * downloader.js
 * Generates the final, destructively flattened output file and triggers download.
 *
 * Output strategy:
 *  - Single-page images → PNG (lossless, no metadata from canvas export)
 *  - PDFs → pdf-lib document where each page is replaced by a PNG image
 *    (full text layer gone, metadata zeroed)
 */

import { stripPDFMeta } from './metaCleaner.js';

/**
 * Download the redacted document.
 *
 * @param {Redactor}      redactor    instance with flattening capability
 * @param {'pdf'|'image'} fileType
 * @param {string}        originalName  original filename for naming output
 * @param {string}        mimeType      for images: 'image/jpeg' etc.
 * @param {Function}      onProgress    (msg:string) => void
 */
export async function downloadRedacted(redactor, fileType, originalName, mimeType, onProgress) {
  const baseName = stripExtension(originalName);

  if (fileType === 'image') {
    await downloadImage(redactor, baseName, mimeType, onProgress);
  } else {
    await downloadPDF(redactor, baseName, onProgress);
  }
}

// ── Image output ──────────────────────────────────────────────────────────

async function downloadImage(redactor, baseName, mimeType, onProgress) {
  if (onProgress) onProgress('Flattening image…');

  const flat = redactor.getFlattenedCanvas(0);

  // Always export as PNG (lossless, no EXIF injected by canvas)
  const blob = await canvasToBlob(flat, 'image/png');

  if (onProgress) onProgress('Preparing download…');
  triggerDownload(blob, `cleanredact_${baseName}.png`);
}

// ── PDF output ─────────────────────────────────────────────────────────────

async function downloadPDF(redactor, baseName, onProgress) {
  if (onProgress) onProgress('Creating PDF…');

  const { PDFDocument } = PDFLib;
  const outDoc = await PDFDocument.create();

  const flatCanvases = redactor.getAllFlattenedCanvases();

  for (let i = 0; i < flatCanvases.length; i++) {
    if (onProgress) onProgress(`Encoding page ${i + 1} of ${flatCanvases.length}…`);

    const canvas = flatCanvases[i];
    const pngDataUrl = canvas.toDataURL('image/png');
    const pngBase64  = pngDataUrl.split(',')[1];
    const pngBytes   = Uint8Array.from(atob(pngBase64), c => c.charCodeAt(0));

    const pngImage = await outDoc.embedPng(pngBytes);

    // Create page exactly the size of the image (72 dpi equivalent)
    // We rendered at 2x, so divide by 2 for standard PDF points
    const { width: imgW, height: imgH } = pngImage.scale(1);
    const pageW = imgW / 2;
    const pageH = imgH / 2;

    const page = outDoc.addPage([pageW, pageH]);
    page.drawImage(pngImage, {
      x: 0, y: 0,
      width:  pageW,
      height: pageH,
    });
  }

  // Wipe all metadata
  stripPDFMeta(outDoc);

  if (onProgress) onProgress('Saving…');

  const pdfBytes = await outDoc.save();
  const blob = new Blob([pdfBytes], { type: 'application/pdf' });
  triggerDownload(blob, `cleanredact_${baseName}.pdf`);
}

// ── Helpers ───────────────────────────────────────────────────────────────

function canvasToBlob(canvas, type) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Canvas toBlob failed')), type);
  });
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a   = document.createElement('a');
  a.href     = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 1000);
}

function stripExtension(name) {
  return name.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_\-]/g, '_');
}
