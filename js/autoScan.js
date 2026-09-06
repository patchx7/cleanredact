/**
 * autoScan.js
 * OCR + Regex pattern detection.
 *
 * Uses Tesseract.js to extract words with bounding boxes from a rendered canvas,
 * then runs regex patterns to identify sensitive data.
 *
 * Returns matched word-boxes in full-res canvas coordinates.
 */

// ── Patterns ────────────────────────────────────────────────────────────────

export const PATTERNS = {
  iban: {
    label: 'IBAN',
    // 2-letter country code + 2 check digits + alphanumeric groups (spaced or unspaced)
    regex: /\b[A-Z]{2}\d{2}(?:(?:\s[A-Z0-9]{4}){2,7}\s?[A-Z0-9]{1,4}|[A-Z0-9]{10,30})\b/g,
    multiWord: true,
  },

  email: {
    label: 'Email / Phone',
    // Phone rules:
    //   International (+): \+CC with optional (0) prefix and separators, e.g. +43(0)1-555-8912, +1 (800) 555-0199
    //   German mobile: 015x, 016x, or 017x + 7-8 subscriber digits
    //   German landline: 0[2-9] + 1-3 area digits + MIN 5 subscriber digits (eliminates IBAN fragment "0517 5407")
    regex: new RegExp(
      // ── Email ──────────────────────────────────────────────────────────
      '([a-zA-Z0-9._%+\\-]+@[a-zA-Z0-9.\\-]+\\.[a-zA-Z]{2,})'
      + '|'
      // ── International phone: +CC then optional (0) and digit groups with separators
      + '(\\+\\d{1,3}[\\s\\-./]*(?:\\(0\\)[\\s\\-./]*)?\\(?\\d{1,4}\\)?[\\s\\-./]?\\d{1,5}[\\s\\-./]?\\d{2,9})'
      + '|'
      // ── German mobile: 015x / 016x / 017x + 7–8 subscriber digits (11 total)
      + '(\\b01[5-7]\\d[\\s\\-]?\\d{7,8}\\b)'
      + '|'
      // ── German landline: 0[2-9] + 1–3 area digits + MIN 5 subscriber digits
      + '(\\b0[2-9]\\d{1,3}[\\s\\-\\/]?\\d{5,9}\\b)',
      'g'
    ),
    multiWord: false,
  },

  amount: {
    label: 'Monetary Amount',
    // Currency symbol or ISO code is REQUIRED.
    // Supports:
    //   1. Symbol before: € 750,00 | $3,500.50 | $ 12,000.00 | €16,820.50
    //   2. Symbol after (no \b, since €/$ are non-word chars): 120,00€ | 120,00 €
    //   3. ISO code after (with \b): 450 EUR | 4.850,00 EUR | 12.500,00 USD
    regex: new RegExp(
      // ── Currency symbol BEFORE the number ──────────────────────────────
      '(?:€|\\$|£)\\s*\\d{1,3}(?:[.,]\\d{3})*(?:[.,]\\d{1,2})?'
      + '|'
      + '(?:€|\\$|£)\\s*\\d+(?:[.,]\\d{1,2})?'
      + '|'
      // ── Currency symbol AFTER the number (NO trailing \b) ──────────────
      + '\\b\\d{1,3}(?:[.,]\\d{3})*(?:[.,]\\d{1,2})?\\s*(?:€|\\$|£)'
      + '|'
      + '\\b\\d+(?:[.,]\\d{1,2})?\\s*(?:€|\\$|£)'
      + '|'
      // ── ISO Currency code AFTER the number (WITH trailing \b) ──────────
      + '\\b\\d{1,3}(?:[.,]\\d{3})*(?:[.,]\\d{1,2})?\\s*(?:EUR|USD|GBP|CHF|SEK|NOK|DKK|JPY|CNY)\\b'
      + '|'
      + '\\b\\d+(?:[.,]\\d{1,2})?\\s*(?:EUR|USD|GBP|CHF|SEK|NOK|DKK|JPY|CNY)\\b',
      'g'
    ),
    multiWord: true, // currency code is often a separate OCR word
  },

  all: {
    label: 'All Patterns',
    regex: null, // combined at runtime
    multiWord: true,
  },
};

// ── Main API ──────────────────────────────────────────────────────────────

/**
 * Extract words with bounding boxes via OCR (cached per canvas for instantaneous repeat searches).
 */
export async function getWordsFromCanvas(srcCanvas, onProgress) {
  if (srcCanvas._cachedWords && srcCanvas._cachedWords.length) {
    return srcCanvas._cachedWords;
  }
  if (onProgress) onProgress('Running OCR on document…');

  const { data } = await Tesseract.recognize(srcCanvas, 'eng+deu', {
    logger: m => {
      if (m.status === 'recognizing text' && onProgress) {
        onProgress(`OCR: ${Math.round(m.progress * 100)}%`);
      }
    },
  });

  const words = data.words || [];
  srcCanvas._cachedWords = words;
  return words;
}

/**
 * Run OCR on a canvas, then apply a pattern to detect sensitive regions.
 *
 * @param {HTMLCanvasElement} srcCanvas   full-res original page canvas
 * @param {string}            patternKey  key in PATTERNS
 * @param {Function}          onProgress  optional (msg:string) => void
 * @returns {Promise<Array<{x,y,w,h,text}>>}  matched regions in canvas-px coords
 */
export async function scanCanvas(srcCanvas, patternKey, onProgress) {
  const words = await getWordsFromCanvas(srcCanvas, onProgress);

  if (onProgress) onProgress('Searching for patterns…');
  const matches = [];

  if (patternKey === 'all') {
    // Run all individual patterns
    const combined = [
      ...findInWords(words, PATTERNS.iban.regex,   srcCanvas, true),
      ...findInWords(words, PATTERNS.email.regex,  srcCanvas, false),
      ...findInWords(words, PATTERNS.amount.regex, srcCanvas, false),
    ];
    // Deduplicate by position (coarse)
    const seen = new Set();
    for (const m of combined) {
      const key = `${Math.round(m.x)},${Math.round(m.y)}`;
      if (!seen.has(key)) { seen.add(key); matches.push(m); }
    }
  } else {
    const pat = PATTERNS[patternKey];
    matches.push(...findInWords(words, pat.regex, srcCanvas, pat.multiWord));
  }

  return matches;
}

/**
 * Search and match a custom word or phrase across a page.
 *
 * @param {HTMLCanvasElement} srcCanvas
 * @param {string}            query
 * @param {Function}          onProgress
 * @returns {Promise<Array<{x,y,w,h,text}>>}
 */
export async function scanCustomWord(srcCanvas, query, onProgress) {
  if (!query || !query.trim()) return [];
  const text = query.trim();

  // Escape regex special characters: . * + ? ^ $ { } ( ) | [ ] \
  const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // Word boundary logic:
  // If the query begins/ends with a word char (\w), add word boundaries (\b)
  // Allows finding words ("Dennis") as well as symbols ("$100", "(Vertrag)") safely
  const startsWord = /^\w/i.test(text);
  const endsWord   = /\w$/i.test(text);
  const pattern = `${startsWord ? '\\b' : ''}${escaped}${endsWord ? '\\b' : ''}`;
  const regex = new RegExp(pattern, 'gi');

  const words = await getWordsFromCanvas(srcCanvas, onProgress);
  if (onProgress) onProgress('Searching for word…');

  return findInWords(words, regex, srcCanvas, true);
}

// ── Internal helpers ──────────────────────────────────────────────────────

/**
 * Join all words into a text string, try to match regex,
 * then map back to word/character bounding boxes.
 * Handles sub-word matches (e.g. "Dennis" inside "dennis.privat@domain.com")
 * so only the matched characters are redacted, not the surrounding word.
 */
function findInWords(words, regex, srcCanvas, multiWord) {
  if (!words.length) return [];

  // Build a joined text with word positions tracked
  let text = words.map(w => w.text).join(' ');
  const results = [];
  let match;

  // Clone regex to reset lastIndex
  const re = new RegExp(regex.source, regex.flags.replace('g','') + 'g');

  while ((match = re.exec(text)) !== null) {
    const matchedText = match[0].trim();
    if (!matchedText || matchedText.length < 1) continue;

    const matchStart = match.index;
    const matchEnd   = match.index + match[0].length;

    // Find which words span this match and extract the sub-box for each word
    let charPos = 0;
    const matchedPieceBoxes = [];

    for (const word of words) {
      const wordStart = charPos;
      const wordEnd   = charPos + word.text.length;

      // Check if this word overlaps with the match range
      const overlapStart = Math.max(wordStart, matchStart);
      const overlapEnd   = Math.min(wordEnd, matchEnd);

      if (overlapEnd > overlapStart) {
        const charStart = overlapStart - wordStart;
        const charEnd   = overlapEnd - wordStart;
        const pieceBbox = getSubWordBbox(word, charStart, charEnd);
        if (pieceBbox) {
          matchedPieceBoxes.push(pieceBbox);
        }
      }

      charPos += word.text.length + 1; // +1 for space
    }

    if (matchedPieceBoxes.length === 0) continue;

    // Group boxes by line to avoid giant boxes if a match wraps across lines
    const lineGroups = groupBoxesByLine(matchedPieceBoxes);
    for (const lineBoxes of lineGroups) {
      const bbox = mergeBboxes(lineBoxes, srcCanvas);
      if (bbox) {
        results.push({ ...bbox, text: matchedText });
      }
    }
  }

  return results;
}

/**
 * Relative typographic character weights for Latin proportional fonts.
 * Narrow characters (i, l, ., etc.) receive smaller widths (~0.45),
 * wide characters (m, w, @, etc.) receive larger widths (~1.4),
 * capitals receive ~1.15, standard lowercase receive ~0.95.
 */
function getCharWeight(c) {
  if ('iljt1.,:;!|/\'"`^()[]{}'.includes(c)) return 0.45;
  if ('rf-'.includes(c)) return 0.65;
  if ('mwMW@%#&'.includes(c)) return 1.4;
  if (c >= 'A' && c <= 'Z') return 1.15;
  if (c >= '0' && c <= '9') return 1.0;
  return 0.95;
}

/**
 * Compute the horizontal start and end ratio [0..1] of a substring [start, end)
 * within a full token text using typographical character weighting.
 */
function getSliceRatio(text, start, end) {
  if (start <= 0 && end >= text.length) return { startRatio: 0, endRatio: 1 };
  const weights = [];
  let totalWeight = 0;
  for (let i = 0; i < text.length; i++) {
    const w = getCharWeight(text[i]);
    weights.push(w);
    totalWeight += w;
  }
  if (totalWeight <= 0) return { startRatio: 0, endRatio: 1 };

  let startWeight = 0;
  for (let i = 0; i < start && i < weights.length; i++) {
    startWeight += weights[i];
  }

  let endWeight = 0;
  for (let i = 0; i < end && i < weights.length; i++) {
    endWeight += weights[i];
  }

  return {
    startRatio: Math.max(0, Math.min(1, startWeight / totalWeight)),
    endRatio:   Math.max(0, Math.min(1, endWeight / totalWeight)),
  };
}

/**
 * Extract sub-word bounding box for character range [charStart, charEnd) within a word.
 * For full words, returns the exact word.bbox from OCR.
 * For partial sub-words (e.g. "Dennis" in "dennis.privat@domain.com"),
 * uses proportional typographic font weighting to accurately slice the bounding box,
 * preventing Tesseract's noisy symbol segmentation bugs from leaving characters uncovered
 * or swallowing adjacent punctuation.
 */
function getSubWordBbox(word, charStart, charEnd) {
  if (!word || !word.bbox) return null;

  const text = word.text || '';
  const textLen = text.length;
  if (textLen === 0) return { ...word.bbox };

  // If full word or wider, return entire word bbox directly
  if (charStart <= 0 && charEnd >= textLen) {
    return {
      x0: word.bbox.x0,
      y0: word.bbox.y0,
      x1: word.bbox.x1,
      y1: word.bbox.y1,
    };
  }

  const { startRatio, endRatio } = getSliceRatio(text, charStart, charEnd);
  const totalW = word.bbox.x1 - word.bbox.x0;

  return {
    x0: word.bbox.x0 + startRatio * totalW,
    y0: word.bbox.y0,
    x1: word.bbox.x0 + endRatio * totalW,
    y1: word.bbox.y1,
  };
}

/**
 * Group bounding boxes by line based on vertical overlap.
 */
function groupBoxesByLine(boxes) {
  if (boxes.length <= 1) return [boxes];

  const sorted = [...boxes].sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
  const lines = [];
  let currentLine = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    const curr = sorted[i];
    const lineY0 = Math.min(...currentLine.map(b => b.y0));
    const lineY1 = Math.max(...currentLine.map(b => b.y1));
    const overlapY = Math.min(lineY1, curr.y1) - Math.max(lineY0, curr.y0);
    const minH = Math.min(lineY1 - lineY0, curr.y1 - curr.y0);

    if (overlapY > minH * 0.4) {
      currentLine.push(curr);
    } else {
      lines.push(currentLine);
      currentLine = [curr];
    }
  }
  lines.push(currentLine);
  return lines;
}

/**
 * Merge multiple word bboxes into one, scaled to full canvas resolution.
 * Tesseract returns bbox in the coordinate space of the canvas it was given.
 */
function mergeBboxes(bboxes, canvas) {
  if (!bboxes.length) return null;

  const x0 = Math.min(...bboxes.map(b => b.x0));
  const y0 = Math.min(...bboxes.map(b => b.y0));
  const x1 = Math.max(...bboxes.map(b => b.x1));
  const y1 = Math.max(...bboxes.map(b => b.y1));

  // Balanced padding:
  // - Top: -3px (1.5 CSS px) covers all ascenders (d, l, t, f, h, etc.)
  // - Bottom: +3px (1.5 CSS px) covers all descenders (g, p, y, q, etc.)
  // - Left: -2px (1 CSS px) cleanly swallows leading '+' or punctuation without reaching preceding colons (:)
  // - Right: +3px covers trailing glyph bounds
  // Result: Completely solid black bars with zero 'Ausrisse', yet with clean white gaps between lines.
  const padTop    = 3;
  const padBottom = 3;
  const padLeft   = 2;
  const padRight  = 2;

  const x = Math.max(0, x0 - padLeft);
  const y = Math.max(0, y0 - padTop);
  const w = Math.min(canvas.width - x, (x1 - x0) + padLeft + padRight);
  const h = Math.min(canvas.height - y, (y1 - y0) + padTop + padBottom);

  return { x, y, w, h };
}
