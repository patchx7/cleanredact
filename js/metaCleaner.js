/**
 * metaCleaner.js
 * Strip EXIF (images) and PDF metadata (pdf-lib).
 *
 * For PNG files: re-exporting from canvas already strips all metadata.
 * For JPEG files: use piexifjs to zero out all EXIF tags.
 * For PDFs: use pdf-lib to wipe InfoDict fields.
 */

/**
 * Strip metadata from an image ArrayBuffer.
 * @param {ArrayBuffer} buffer
 * @param {string}      mimeType   'image/jpeg' | 'image/png' | 'image/webp'
 * @returns {ArrayBuffer}  cleaned buffer  (or original if no action needed)
 */
export function stripImageMeta(buffer, mimeType) {
  if (mimeType === 'image/jpeg' || mimeType === 'image/jpg') {
    return stripJpegExif(buffer);
  }
  // PNG/WEBP: canvas export already removes metadata — nothing to do here
  return buffer;
}

/**
 * Use piexifjs to zero all EXIF tags from a JPEG buffer.
 */
function stripJpegExif(buffer) {
  try {
    const binary = arrayBufferToBinary(buffer);
    const cleaned = piexif.remove(binary);
    return binaryToArrayBuffer(cleaned);
  } catch (e) {
    console.warn('EXIF strip failed, returning original:', e);
    return buffer;
  }
}

/**
 * Build a clean PDF from an existing pdf-lib PDFDocument,
 * wiping all metadata fields.
 * @param {import('pdf-lib').PDFDocument} pdfDoc
 */
export function stripPDFMeta(pdfDoc) {
  const epoch = new Date(0); // 1970-01-01 — neutral timestamp

  try { pdfDoc.setTitle('');            } catch {}
  try { pdfDoc.setAuthor('');           } catch {}
  try { pdfDoc.setSubject('');          } catch {}
  try { pdfDoc.setKeywords([]);         } catch {}
  try { pdfDoc.setProducer('');         } catch {}
  try { pdfDoc.setCreator('');          } catch {}
  try { pdfDoc.setCreationDate(epoch);  } catch {}
  try { pdfDoc.setModificationDate(epoch); } catch {}

  // Remove XMP metadata stream if present
  try {
    const context = pdfDoc.context;
    const catalog = pdfDoc.catalog;
    if (catalog.has(PDFLib.PDFName.of('Metadata'))) {
      catalog.delete(PDFLib.PDFName.of('Metadata'));
    }
  } catch {}
}

/**
 * Describe what metadata was found in an image buffer.
 * Returns a human-readable summary string.
 * @param {ArrayBuffer} buffer
 * @param {string}      mimeType
 * @returns {string}
 */
export function describeImageMeta(buffer, mimeType) {
  if (mimeType !== 'image/jpeg' && mimeType !== 'image/jpg') {
    return 'PNG/WebP: No embedded EXIF metadata.';
  }
  try {
    const binary = arrayBufferToBinary(buffer);
    const exifData = piexif.load(binary);
    const fields = [];

    const gps = exifData['GPS'];
    if (gps && Object.keys(gps).length > 0) fields.push('GPS location');

    const img = exifData['0th'];
    if (img) {
      if (img[piexif.ImageIFD.Make])     fields.push('Camera make');
      if (img[piexif.ImageIFD.Model])    fields.push('Camera model');
      if (img[piexif.ImageIFD.Software]) fields.push('Software');
      if (img[piexif.ImageIFD.Artist])   fields.push('Artist/Author');
      if (img[piexif.ImageIFD.Copyright])fields.push('Copyright');
    }

    const exif = exifData['Exif'];
    if (exif) {
      if (exif[piexif.ExifIFD.DateTimeOriginal]) fields.push('Capture date/time');
      if (exif[piexif.ExifIFD.LensModel])        fields.push('Lens model');
      if (exif[piexif.ExifIFD.BodySerialNumber]) fields.push('Camera serial number');
    }

    if (fields.length === 0) return 'JPEG: No sensitive EXIF fields detected.';
    return `JPEG EXIF found: ${fields.join(', ')}.`;
  } catch {
    return 'Could not parse EXIF data.';
  }
}

// ── Utility ───────────────────────────────────────────────────────────────

function arrayBufferToBinary(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return binary;
}

function binaryToArrayBuffer(binary) {
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}
