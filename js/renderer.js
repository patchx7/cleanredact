/**
 * renderer.js
 * PDF.js + Image Canvas rendering.
 * Returns an array of { canvas, width, height, pageNum } objects.
 *
 * PDF.js CDN: https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js
 */

const MAX_PAGES = 20;
const RENDER_SCALE = 2.0; // High-DPI canvas (retina-quality)

/**
 * Render a PDF ArrayBuffer into an array of canvas elements.
 * @param {ArrayBuffer} buffer
 * @param {Function} onProgress  (currentPage, totalPages)
 * @returns {Promise<Array<{canvas:HTMLCanvasElement,width:number,height:number,pageNum:number}>>}
 */
export async function renderPDF(buffer, onProgress) {
  const pdfjsLib = window['pdfjs-dist/build/pdf'];

  const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(buffer) });
  const pdf = await loadingTask.promise;

  const totalPages = Math.min(pdf.numPages, MAX_PAGES);
  const pages = [];

  for (let i = 1; i <= totalPages; i++) {
    if (onProgress) onProgress(i, totalPages);
    const page = await pdf.getPage(i);

    const viewport = page.getViewport({ scale: RENDER_SCALE });
    const canvas   = document.createElement('canvas');
    const ctx      = canvas.getContext('2d');

    canvas.width  = viewport.width;
    canvas.height = viewport.height;

    // White background (important for later PNG export)
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    await page.render({ canvasContext: ctx, viewport }).promise;

    // Logical CSS dimensions at 1x (we scale down via CSS)
    pages.push({
      canvas,
      width:   Math.round(viewport.width  / RENDER_SCALE),
      height:  Math.round(viewport.height / RENDER_SCALE),
      pageNum: i,
    });
  }

  return { pages, truncated: pdf.numPages > MAX_PAGES, totalPDF: pdf.numPages };
}

/**
 * Render an image ArrayBuffer (PNG/JPG/WEBP) into a single-element array.
 * @param {ArrayBuffer} buffer
 * @param {string} mimeType
 * @returns {Promise<Array<{canvas,width,height,pageNum}>>}
 */
export function renderImage(buffer, mimeType) {
  return new Promise((resolve, reject) => {
    const blob = new Blob([buffer], { type: mimeType });
    const url  = URL.createObjectURL(blob);
    const img  = new Image();

    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width  = img.naturalWidth;
      canvas.height = img.naturalHeight;

      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0);

      URL.revokeObjectURL(url);

      const MAX_DISPLAY_W = 1200; // cap display width
      const scale = img.naturalWidth > MAX_DISPLAY_W
        ? MAX_DISPLAY_W / img.naturalWidth : 1;

      resolve([{
        canvas,
        width:   Math.round(img.naturalWidth  * scale),
        height:  Math.round(img.naturalHeight * scale),
        pageNum: 1,
      }]);
    };
    img.onerror = reject;
    img.src = url;
  });
}

/**
 * Create a low-res thumbnail canvas from a full-res page canvas.
 * Used for the right-side page navigator.
 * @param {HTMLCanvasElement} srcCanvas
 * @param {number} thumbWidth  target display width in px
 * @returns {HTMLCanvasElement}
 */
export function makeThumbnail(srcCanvas, thumbWidth = 88) {
  const ratio  = srcCanvas.height / srcCanvas.width;
  const thumb  = document.createElement('canvas');
  thumb.width  = thumbWidth * 2;           // 2x for retina
  thumb.height = Math.round(thumbWidth * ratio * 2);

  const ctx = thumb.getContext('2d');
  ctx.drawImage(srcCanvas, 0, 0, thumb.width, thumb.height);
  thumb.style.width  = `${thumbWidth}px`;
  thumb.style.height = 'auto';
  return thumb;
}
