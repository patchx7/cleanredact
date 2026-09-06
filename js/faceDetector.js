/**
 * faceDetector.js
 * 100% Client-Side Face Detection via TensorFlow.js BlazeFace.
 *
 * Runs locally in browser memory — zero uploads, zero server calls.
 * Preserves document aspect ratio via letterboxing before inference to prevent
 * coordinate stretching on non-square documents (e.g. ID cards, landscape scans).
 * Derives precise facial boundaries using facial landmarks to cover hair & chin
 * without bleeding into adjacent document text.
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
 * @returns {Promise<Array<{x:number, y:number, w:number, h:number, confidence:number}>>}
 */
export async function detectFaces(canvas, options = {}) {
  const minConfidence = options.minConfidence ?? 0.85;

  if (!canvas || canvas.width === 0 || canvas.height === 0) {
    return [];
  }

  const model = await getFaceModel();
  const cw = canvas.width;
  const ch = canvas.height;

  // 1. Aspect-Ratio Preservation via Letterboxed Canvas:
  // BlazeFace internally resizes all inputs to 128x128 pixels without aspect ratio preservation.
  // On wide documents (like ID cards or landscape scans), this squashes the image horizontally,
  // causing BlazeFace's square anchor boxes to be stretched horizontally by (cw / ch) when unscaled,
  // which causes the redaction box to bleed far to the right into document text.
  // Feeding a 1:1 square canvas prevents all aspect ratio distortion.
  const maxDim = Math.max(cw, ch);
  let inferenceCanvas = canvas;
  let offsetX = 0;
  let offsetY = 0;

  if (cw !== ch) {
    inferenceCanvas = document.createElement('canvas');
    inferenceCanvas.width = maxDim;
    inferenceCanvas.height = maxDim;
    const sqCtx = inferenceCanvas.getContext('2d');
    sqCtx.fillStyle = '#808080'; // neutral gray background
    sqCtx.fillRect(0, 0, maxDim, maxDim);
    sqCtx.drawImage(canvas, 0, 0);
  }

  const predictions = await model.estimateFaces(inferenceCanvas, false);

  if (!predictions || !predictions.length) {
    return [];
  }

  const results = [];

  for (const pred of predictions) {
    const prob = Array.isArray(pred.probability)
      ? pred.probability[0]
      : (typeof pred.probability === 'number' ? pred.probability : 1.0);

    if (prob < minConfidence) continue;

    let targetX0, targetY0, targetX1, targetY1;

    // 2. Landmark-derived bounding box:
    // BlazeFace provides 6 facial keypoints:
    // [0]=right eye, [1]=left eye, [2]=nose, [3]=mouth, [4]=right ear tragion, [5]=left ear tragion.
    // Using landmarks guarantees we tightly follow real human facial geometry rather than
    // a coarse, unrefined square anchor box.
    if (pred.landmarks && pred.landmarks.length >= 6) {
      const lm = pred.landmarks;
      const rightEye = lm[0];
      const leftEye  = lm[1];
      const mouth    = lm[3];

      const allX = lm.map(p => p[0]);
      const minX = Math.min(...allX);
      const maxX = Math.max(...allX);
      const landmarkW = maxX - minX;

      const eyeCenterY = (rightEye[1] + leftEye[1]) / 2;
      const eyeMouthDist = Math.max(8, Math.abs(mouth[1] - eyeCenterY));

      // Side padding: 12% of ear-to-ear width (fully covers earlobes/hair sides without spilling into text)
      const padSide = Math.max(6, landmarkW * 0.12);
      targetX0 = minX - padSide;
      targetX1 = maxX + padSide;

      // Forehead & hair: extends ~1.3x eye-to-mouth distance above the eye line
      targetY0 = eyeCenterY - eyeMouthDist * 1.30;
      // Chin: extends ~0.7x eye-to-mouth distance below the mouth
      targetY1 = mouth[1] + eyeMouthDist * 0.70;

      // Ensure model's raw detected edges are covered if they slightly exceed landmarks
      targetX0 = Math.min(targetX0, pred.topLeft[0]);
      targetX1 = Math.max(targetX1, pred.bottomRight[0]);
      targetY1 = Math.max(targetY1, pred.bottomRight[1]);
    } else {
      // Fallback if landmarks are unavailable
      const rawW = pred.bottomRight[0] - pred.topLeft[0];
      const rawH = pred.bottomRight[1] - pred.topLeft[1];
      const padX = rawW * 0.10;
      targetX0 = pred.topLeft[0] - padX;
      targetX1 = pred.bottomRight[0] + padX;
      targetY0 = pred.topLeft[1] - rawH * 0.35; // Forehead/hair
      targetY1 = pred.bottomRight[1] + rawH * 0.15; // Chin
    }

    // Adjust for offset if any (offsetX=0, offsetY=0 here, but good practice)
    targetX0 -= offsetX;
    targetX1 -= offsetX;
    targetY0 -= offsetY;
    targetY1 -= offsetY;

    // 3. Strict non-bleeding clamping:
    // Independent boundary clamping prevents left padding from being pushed to the right
    const left   = Math.max(0, Math.round(targetX0));
    const right  = Math.min(cw, Math.round(targetX1));
    const top    = Math.max(0, Math.round(targetY0));
    const bottom = Math.min(ch, Math.round(targetY1));

    const x = left;
    const y = top;
    const w = Math.max(1, right - left);
    const h = Math.max(1, bottom - top);

    if (w <= 4 || h <= 4) continue;

    results.push({ x, y, w, h, confidence: prob });
  }

  return results;
}
