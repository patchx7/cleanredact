/**
 * faceDetector.js
 * 100% Client-Side Face Detection via TensorFlow.js BlazeFace.
 *
 * Runs locally in browser memory — zero uploads, zero server calls.
 * Applies a 15% safety padding outward to fully cover hair, ears, and chin.
 */

let _modelPromise = null;

/**
 * Initialize / return cached BlazeFace model instance.
 */
export async function getFaceModel() {
  if (_modelPromise) return _modelPromise;

  if (typeof window.blazeface === 'undefined') {
    throw new Error('Face detection library (BlazeFace) not loaded.');
  }

  _modelPromise = window.blazeface.load();
  return _modelPromise;
}

/**
 * Scan a canvas for human faces.
 *
 * @param {HTMLCanvasElement} canvas  full-res page canvas
 * @param {Object} [options]
 * @param {number} [options.minConfidence=0.85]  minimum detection score (0..1)
 * @param {number} [options.paddingRatio=0.15]   outward expansion (15% by default)
 * @returns {Promise<Array<{x:number, y:number, w:number, h:number, confidence:number}>>}
 */
export async function detectFaces(canvas, options = {}) {
  const minConfidence = options.minConfidence ?? 0.85;
  const paddingRatio  = options.paddingRatio  ?? 0.15;

  if (!canvas || canvas.width === 0 || canvas.height === 0) {
    return [];
  }

  const model = await getFaceModel();
  // estimateFaces(image, returnTensors, flipHorizontal, annotateFace)
  const predictions = await model.estimateFaces(canvas, false);

  if (!predictions || !predictions.length) {
    return [];
  }

  const results = [];
  const cw = canvas.width;
  const ch = canvas.height;

  for (const pred of predictions) {
    const prob = Array.isArray(pred.probability)
      ? pred.probability[0]
      : (typeof pred.probability === 'number' ? pred.probability : 1.0);

    if (prob < minConfidence) continue;

    const [x0, y0] = pred.topLeft;
    const [x1, y1] = pred.bottomRight;

    const rawW = x1 - x0;
    const rawH = y1 - y0;
    if (rawW <= 2 || rawH <= 2) continue;

    // Expand by 15% safety padding on all 4 sides so hair, ears, and chin are covered
    const padX = rawW * paddingRatio;
    const padY = rawH * paddingRatio;

    const x = Math.max(0, Math.round(x0 - padX));
    const y = Math.max(0, Math.round(y0 - padY));
    const w = Math.min(cw - x, Math.round(rawW + 2 * padX));
    const h = Math.min(ch - y, Math.round(rawH + 2 * padY));

    results.push({ x, y, w, h, confidence: prob });
  }

  return results;
}
