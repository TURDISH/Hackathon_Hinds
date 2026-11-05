const sharp = require('sharp');
const { ocrGuidance, normalizeOcrRaw, isPlausibleForType } = require('./semanticDecode');

/**
 * Digit-focused HTR helpers: ink cleanup, connected-component segmentation,
 * single-char + whole-cell Tesseract ensemble, and force/length priors.
 * Typed reads use schema fieldType whitelist + semantic normalize during OCR.
 */

const FORCE_MIN = 500;
const FORCE_MAX = 2500; // Soft upper prior for 3–4 digit force/load cells

/** Generic LLM / OCR filler patterns — not form-specific answers. */
function isLikelyHallucinatedDigits(text) {
  const d = String(text || '').replace(/\D/g, '');
  if (!d) return false;
  if (/^(?:0?1234|1234|2345|0123|12345)$/.test(d)) return true;
  if (/^(\d)\1{2,}$/.test(d)) return true; // 1111, 0000, 222…
  if (/^(\d{2})\1$/.test(d)) return true; // 1212, 0000-like pairs
  return false;
}

function isPlausibleForce(text) {
  if (!/^\d{3,4}$/.test(text)) return false;
  if (isLikelyHallucinatedDigits(text)) return false;
  const n = Number(text);
  return n >= FORCE_MIN && n <= FORCE_MAX;
}

function forceScore(text, confidence = 0) {
  if (!text) return -1000;
  const n = Number(text);
  let s = confidence + text.length * 12;
  if (isPlausibleForce(text)) s += 300;
  if (/^\d{4}$/.test(text)) s += 40;
  // Tow-test values are often round hundreds
  if (Number.isFinite(n) && n % 100 === 0 && n >= 700 && n <= 2500) s += 80;
  if (Number.isFinite(n) && n % 50 === 0 && n >= 700 && n <= 2500) s += 25;
  // Soft penalties — keep fragments available for review
  if (/^0\d/.test(text)) s -= 25;
  if (text.length <= 2) s -= 35;
  return s;
}

function snapForcePrior(text, { allowHundredSnap = true } = {}) {
  if (!text) return text;
  let digits = String(text).replace(/\D/g, '');
  if (!digits) return '';

  // Extract best 3–4 digit window
  if (digits.length > 4) {
    let best = digits.slice(0, 4);
    let bestS = forceScore(best);
    for (let i = 0; i <= digits.length - 3; i++) {
      for (const len of [4, 3]) {
        if (i + len > digits.length) continue;
        const sub = digits.slice(i, i + len);
        const s = forceScore(sub, 50);
        if (s > bestS) {
          best = sub;
          bestS = s;
        }
      }
    }
    digits = best;
  }

  const n = Number(digits);
  if (!Number.isFinite(n)) return digits;

  // If 1–2 digits with no other signal, don't invent thousands
  if (digits.length <= 2) return digits;

  // Soft snap to nearest hundred only when already very close (avoid inventing)
  if (allowHundredSnap && n >= FORCE_MIN && n <= FORCE_MAX) {
    const snapped = Math.round(n / 100) * 100;
    if (Math.abs(snapped - n) <= 15 && snapped >= FORCE_MIN && snapped <= FORCE_MAX) {
      return String(snapped);
    }
  }
  return digits;
}

function wipeGridLines(raw, cw, ch, thr = 110) {
  const cleaned = Buffer.from(raw);
  for (let y = 0; y < ch; y++) {
    let dark = 0;
    for (let x = 0; x < cw; x++) if (raw[y * cw + x] < thr) dark += 1;
    if (dark / cw > 0.5) for (let x = 0; x < cw; x++) cleaned[y * cw + x] = 255;
  }
  for (let x = 0; x < cw; x++) {
    let dark = 0;
    for (let y = 0; y < ch; y++) if (raw[y * cw + x] < thr) dark += 1;
    if (dark / ch > 0.5) for (let y = 0; y < ch; y++) cleaned[y * cw + x] = 255;
  }
  return cleaned;
}

function binarize(raw, cw, ch, thr = 135) {
  const bin = new Uint8Array(cw * ch);
  for (let i = 0; i < raw.length; i++) bin[i] = raw[i] < thr ? 1 : 0;
  return bin;
}

function connectedComponents(bin, cw, ch) {
  const seen = new Uint8Array(cw * ch);
  const comps = [];
  const stack = [];
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      const i0 = y * cw + x;
      if (!bin[i0] || seen[i0]) continue;
      let minx = x;
      let maxx = x;
      let miny = y;
      let maxy = y;
      let count = 0;
      stack.length = 0;
      stack.push(i0);
      seen[i0] = 1;
      while (stack.length) {
        const i = stack.pop();
        const cx = i % cw;
        const cy = (i - cx) / cw;
        count += 1;
        if (cx < minx) minx = cx;
        if (cx > maxx) maxx = cx;
        if (cy < miny) miny = cy;
        if (cy > maxy) maxy = cy;
        for (const [dx, dy] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
          [1, 1],
          [-1, -1],
          [1, -1],
          [-1, 1],
        ]) {
          const nx = cx + dx;
          const ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= cw || ny >= ch) continue;
          const ni = ny * cw + nx;
          if (bin[ni] && !seen[ni]) {
            seen[ni] = 1;
            stack.push(ni);
          }
        }
      }
      const ww = maxx - minx + 1;
      const hh = maxy - miny + 1;
      if (count >= 12 && ww >= 2 && hh >= 8 && ww < cw * 0.95 && hh < ch * 0.98) {
        comps.push({ minx, maxx, miny, maxy, w: ww, h: hh, count, cx: (minx + maxx) / 2 });
      }
    }
  }
  comps.sort((a, b) => a.cx - b.cx);
  return comps;
}

/** Merge fragments that belong to one digit; split oversized blobs by valleys. */
function groupDigitBlobs(comps, cw) {
  if (!comps.length) return [];
  const medianH =
    comps.map((c) => c.h).sort((a, b) => a - b)[Math.floor(comps.length / 2)] || 20;
  const maxDigitW = Math.max(18, medianH * 0.95);

  // Merge close fragments
  const merged = [];
  let cur = { ...comps[0], parts: [comps[0]] };
  for (let i = 1; i < comps.length; i++) {
    const c = comps[i];
    const gap = c.minx - cur.maxx;
    const combinedW = c.maxx - cur.minx + 1;
    if (gap <= 4 && combinedW <= maxDigitW * 1.15) {
      cur.maxx = Math.max(cur.maxx, c.maxx);
      cur.minx = Math.min(cur.minx, c.minx);
      cur.miny = Math.min(cur.miny, c.miny);
      cur.maxy = Math.max(cur.maxy, c.maxy);
      cur.w = cur.maxx - cur.minx + 1;
      cur.h = cur.maxy - cur.miny + 1;
      cur.cx = (cur.minx + cur.maxx) / 2;
      cur.parts.push(c);
    } else {
      merged.push(cur);
      cur = { ...c, parts: [c] };
    }
  }
  merged.push(cur);

  // Prefer 3–4 digit groups: if too many tiny blobs, keep widest 4
  if (merged.length > 5) {
    return merged
      .slice()
      .sort((a, b) => b.count - a.count)
      .slice(0, 4)
      .sort((a, b) => a.cx - b.cx);
  }
  // If only 1–2 blobs but wide, try vertical-projection splits later upstream
  return merged.filter((m) => m.w < cw * 0.9);
}

function verticalSplitWideBlob(bin, cw, ch, blob, targetParts = 4) {
  if (blob.w < 28) return [blob];
  const colInk = new Float32Array(blob.w);
  for (let x = blob.minx; x <= blob.maxx; x++) {
    let s = 0;
    for (let y = blob.miny; y <= blob.maxy; y++) s += bin[y * cw + x];
    colInk[x - blob.minx] = s;
  }
  // Smooth
  const smooth = new Float32Array(blob.w);
  for (let i = 0; i < blob.w; i++) {
    const a = colInk[Math.max(0, i - 1)];
    const b = colInk[i];
    const c = colInk[Math.min(blob.w - 1, i + 1)];
    smooth[i] = (a + b + c) / 3;
  }
  const cuts = [];
  const minGap = Math.max(4, Math.floor(blob.w / (targetParts * 2)));
  for (let i = 3; i < blob.w - 3; i++) {
    if (smooth[i] <= smooth[i - 1] && smooth[i] <= smooth[i + 1] && smooth[i] < median(smooth) * 0.55) {
      if (!cuts.length || i - cuts[cuts.length - 1] >= minGap) cuts.push(i);
    }
  }
  // Keep up to targetParts-1 deepest valleys
  const ranked = cuts
    .map((i) => ({ i, v: smooth[i] }))
    .sort((a, b) => a.v - b.v)
    .slice(0, Math.max(0, targetParts - 1))
    .map((x) => x.i)
    .sort((a, b) => a - b);
  if (!ranked.length) return [blob];

  const parts = [];
  let start = 0;
  for (const cut of ranked) {
    parts.push({
      minx: blob.minx + start,
      maxx: blob.minx + cut,
      miny: blob.miny,
      maxy: blob.maxy,
      w: cut - start + 1,
      h: blob.h,
      cx: blob.minx + (start + cut) / 2,
      count: 1,
    });
    start = cut + 1;
  }
  parts.push({
    minx: blob.minx + start,
    maxx: blob.maxx,
    miny: blob.miny,
    maxy: blob.maxy,
    w: blob.maxx - (blob.minx + start) + 1,
    h: blob.h,
    cx: (blob.minx + start + blob.maxx) / 2,
    count: 1,
  });
  return parts.filter((p) => p.w >= 3);
}

function median(arr) {
  const a = [...arr].sort((x, y) => x - y);
  return a[Math.floor(a.length / 2)] || 0;
}

async function pngFromGray(raw, cw, ch, { scale = 5, threshold = null } = {}) {
  let img = sharp(raw, { raw: { width: cw, height: ch, channels: 1 } })
    .resize({
      width: Math.max(40, cw * scale),
      height: Math.max(60, ch * scale),
      fit: 'fill',
      kernel: sharp.kernel.lanczos3,
    })
    .normalize()
    .sharpen({ sigma: 1.2 });
  if (threshold != null) img = img.threshold(threshold);
  return img.png().toBuffer();
}

async function ocrBuffer(worker, buf, { psm = '7', whitelist = '0123456789' } = {}) {
  await worker.setParameters({
    tessedit_char_whitelist: whitelist,
    tessedit_pageseg_mode: psm,
  });
  const { data } = await worker.recognize(buf, {}, { text: true });
  return {
    text: (data.text || '').replace(/\s+/g, ''),
    digits: (data.text || '').replace(/\D/g, ''),
    confidence: Number(data.confidence) || 0,
  };
}

/**
 * Read a measurement cell as a force (lb) value.
 */
async function readForceCell(worker, imagePath, box, inkInfo) {
  const pad = 2;
  let left = Math.max(0, Math.floor(box.x0 + pad));
  let top = Math.max(0, Math.floor(box.y0 + pad));
  let right = Math.min(inkInfo?.pageWidth || 1e9, Math.ceil(box.x1 - pad));
  let bottom = Math.min(inkInfo?.pageHeight || 1e9, Math.ceil(box.y1 - pad));

  if (inkInfo?.cell && inkInfo.cw) {
    // content bbox already relative to cell
    let minx = inkInfo.cw;
    let maxx = -1;
    let miny = inkInfo.ch;
    let maxy = -1;
    for (let y = 0; y < inkInfo.ch; y++) {
      for (let x = 0; x < inkInfo.cw; x++) {
        if (!inkInfo.cell[y * inkInfo.cw + x]) continue;
        if (x < minx) minx = x;
        if (x > maxx) maxx = x;
        if (y < miny) miny = y;
        if (y > maxy) maxy = y;
      }
    }
    if (maxx >= 0) {
      left = Math.max(0, inkInfo.L + minx - 3);
      right = inkInfo.L + maxx + 4;
      top = Math.max(0, inkInfo.T + miny - 3);
      bottom = inkInfo.T + maxy + 4;
    }
  }

  const w = right - left;
  const h = bottom - top;
  if (w < 6 || h < 6) return { text: '', confidence: 0, method: 'empty' };

  const { data: raw, info } = await sharp(imagePath)
    .extract({ left, top, width: w, height: h })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const cw = info.width;
  const ch = info.height;
  const cleaned = wipeGridLines(raw, cw, ch, 115);

  const candidates = [];

  // Whole-cell ensemble (fast + digit-constrained)
  for (const thr of [null, 135, 145, 160, 175]) {
    const buf = await pngFromGray(cleaned, cw, ch, { scale: 7, threshold: thr });
    for (const psm of ['7', '8', '13']) {
      const r = await ocrBuffer(worker, buf, { psm, whitelist: '0123456789' });
      if (r.digits) {
        candidates.push({
          text: snapForcePrior(r.digits),
          confidence: r.confidence,
          method: `whole_psm${psm}_t${thr ?? 'raw'}`,
        });
        const rawWin = r.digits.length > 4 ? r.digits.slice(0, 4) : r.digits;
        if (rawWin && rawWin !== snapForcePrior(r.digits)) {
          candidates.push({
            text: rawWin,
            confidence: Math.max(0, r.confidence - 10),
            method: `whole_raw_psm${psm}`,
          });
        }
      }
    }
  }

  // Digit segmentation ensemble (helps glued handwriting)
  for (const thr of [140]) {
    const bin = binarize(cleaned, cw, ch, thr);
    let comps = connectedComponents(bin, cw, ch);
    comps = groupDigitBlobs(comps, cw);
    if (comps.length === 1 && comps[0].w > Math.max(30, ch * 1.2)) {
      comps = verticalSplitWideBlob(bin, cw, ch, comps[0], 4);
    }
    // If 2 blobs, maybe 3–4 digits glued — try split widest
    if (comps.length === 2) {
      const wide = comps.reduce((a, b) => (a.w >= b.w ? a : b));
      if (wide.w > ch * 0.9) {
        const parts = verticalSplitWideBlob(bin, cw, ch, wide, 3);
        comps = comps.filter((c) => c !== wide).concat(parts).sort((a, b) => a.cx - b.cx);
      }
    }

    if (comps.length >= 3 && comps.length <= 5) {
      let built = '';
      let confSum = 0;
      let ok = 0;
      for (const c of comps.slice(0, 4)) {
        const dw = c.maxx - c.minx + 1;
        const dh = c.maxy - c.miny + 1;
        const slice = Buffer.alloc(dw * dh, 255);
        for (let y = 0; y < dh; y++) {
          for (let x = 0; x < dw; x++) {
            const src = cleaned[(c.miny + y) * cw + (c.minx + x)];
            slice[y * dw + x] = src;
          }
        }
        // Pad digit on white canvas
        const padX = 6;
        const padY = 6;
        const pw = dw + padX * 2;
        const ph = dh + padY * 2;
        const padded = Buffer.alloc(pw * ph, 255);
        for (let y = 0; y < dh; y++) {
          for (let x = 0; x < dw; x++) {
            padded[(y + padY) * pw + (x + padX)] = slice[y * dw + x];
          }
        }
        const digitPng = await pngFromGray(padded, pw, ph, { scale: 8, threshold: 150 });
        let r = await ocrBuffer(worker, digitPng, { psm: '10', whitelist: '0123456789' });
        let d = (r.digits || '').slice(0, 1);
        if (!d) {
          r = await ocrBuffer(worker, digitPng, { psm: '10', whitelist: '' });
          d = String(r.text || '')
            .replace(/[OoD]/g, '0')
            .replace(/[Il|]/g, '1')
            .replace(/[Zz]/g, '2')
            .replace(/[Ss]/g, '5')
            .replace(/[Bb]/g, '8')
            .replace(/\D/g, '')
            .slice(0, 1);
        }
        if (d) {
          built += d;
          confSum += r.confidence;
          ok += 1;
        }
      }
      if (built) {
        const snapped = snapForcePrior(built);
        candidates.push({
          text: snapped,
          confidence: ok ? confSum / ok : 0,
          method: `seg_t${thr}_n${comps.length}`,
        });
      }
    }
  }

  // Vote by forceScore — never prefer empty over a non-empty weak read
  let best = { text: '', confidence: 0, method: 'none' };
  let bestS = Number.NEGATIVE_INFINITY;
  const votes = new Map();
  for (const c of candidates) {
    if (!c.text) continue;
    const s = forceScore(c.text, c.confidence);
    votes.set(c.text, (votes.get(c.text) || 0) + (isPlausibleForce(c.text) ? 2 : 1));
    if (s > bestS) {
      bestS = s;
      best = { ...c };
    }
  }
  for (const [text, count] of votes.entries()) {
    if (count >= 2 && isPlausibleForce(text)) {
      const s = forceScore(text, 70) + count * 50;
      if (s > bestS) {
        bestS = s;
        best = { text, confidence: Math.min(95, 55 + count * 12), method: `vote_x${count}` };
      }
    }
  }

  // Fallback: longest raw digits among candidates if nothing plausible
  if (!isPlausibleForce(best.text)) {
    const rawBest = candidates
      .filter((c) => c.text && c.text.length >= 3)
      .sort((a, b) => forceScore(b.text, b.confidence) - forceScore(a.text, a.confidence))[0];
    if (rawBest && forceScore(rawBest.text, rawBest.confidence) > forceScore(best.text, best.confidence)) {
      best = rawBest;
    }
  }

  // Confidence: require multi-method agreement for high scores
  const agree = [...votes.entries()].find(([t, c]) => t === best.text && c >= 3);
  let confidence = best.confidence;
  if (!best.text) confidence = 0;
  else if (!isPlausibleForce(best.text)) confidence = Math.min(confidence, 40);
  else if (agree) confidence = Math.max(confidence, Math.min(90, 60 + agree[1] * 8));
  else if (best.method.startsWith('vote')) confidence = Math.min(Math.max(confidence, 65), 78);
  else confidence = Math.min(confidence, 68);

  return {
    text: best.text,
    confidence,
    method: best.method,
    bbox: { x0: left, y0: top, x1: right, y1: bottom },
    candidates: candidates.filter((c) => c.text).slice(0, 8),
  };
}

/**
 * Schema-typed cell OCR. Force cells use the full ensemble; other types use
 * whitelist/PSM biased by template fieldType, then semantic normalize.
 */
async function readTypedCell(worker, imagePath, box, inkInfo, fieldHint = {}) {
  const fieldType = fieldHint.fieldType || 'force_lb';
  if (fieldType === 'force_lb') {
    return readForceCell(worker, imagePath, box, inkInfo);
  }

  const guide = ocrGuidance(fieldType, fieldHint.label || fieldHint.id || fieldType);
  const pad = 2;
  let left = Math.max(0, Math.floor(box.x0 + pad));
  let top = Math.max(0, Math.floor(box.y0 + pad));
  let right = Math.min(inkInfo?.pageWidth || 1e9, Math.ceil(box.x1 - pad));
  let bottom = Math.min(inkInfo?.pageHeight || 1e9, Math.ceil(box.y1 - pad));

  if (inkInfo?.cell && inkInfo.cw) {
    let minx = inkInfo.cw;
    let maxx = -1;
    let miny = inkInfo.ch;
    let maxy = -1;
    for (let y = 0; y < inkInfo.ch; y++) {
      for (let x = 0; x < inkInfo.cw; x++) {
        if (!inkInfo.cell[y * inkInfo.cw + x]) continue;
        if (x < minx) minx = x;
        if (x > maxx) maxx = x;
        if (y < miny) miny = y;
        if (y > maxy) maxy = y;
      }
    }
    if (maxx >= 0) {
      left = Math.max(0, inkInfo.L + minx - 3);
      right = inkInfo.L + maxx + 4;
      top = Math.max(0, inkInfo.T + miny - 3);
      bottom = inkInfo.T + maxy + 4;
    }
  }

  const w = right - left;
  const h = bottom - top;
  if (w < 6 || h < 6) {
    return { text: '', confidence: 0, method: 'empty', bbox: { x0: left, y0: top, x1: right, y1: bottom } };
  }

  const { data: raw, info } = await sharp(imagePath)
    .extract({ left, top, width: w, height: h })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const cleaned = wipeGridLines(raw, info.width, info.height, 115);

  const candidates = [];
  for (const thr of [null, 145, 165]) {
    const buf = await pngFromGray(cleaned, info.width, info.height, { scale: 6, threshold: thr });
    for (const psm of ['7', '8', '6']) {
      const r = await ocrBuffer(worker, buf, {
        psm,
        whitelist: guide.tessWhitelist || undefined,
      });
      const rawText = (r.text || '').trim() || r.digits || '';
      if (!rawText) continue;
      const norm = normalizeOcrRaw(fieldType, rawText);
      if (!norm.value) continue;
      candidates.push({
        text: norm.value,
        confidence: r.confidence + (norm.confidenceBoost || 0),
        method: `typed_${fieldType}_psm${psm}_t${thr ?? 'raw'}`,
        note: norm.note,
      });
    }
  }

  let best = { text: '', confidence: 0, method: 'none' };
  for (const c of candidates) {
    const boost = isPlausibleForType(fieldType, c.text) ? 40 : 0;
    if (c.confidence + boost > (best.confidence || 0) + (best.text ? 0 : -1)) {
      best = { ...c, confidence: Math.min(95, c.confidence + boost) };
    }
  }
  if (best.text && !isPlausibleForType(fieldType, best.text)) {
    best.confidence = Math.min(best.confidence, 45);
  }

  return {
    text: best.text,
    confidence: best.confidence,
    method: best.method || `typed_${fieldType}`,
    bbox: { x0: left, y0: top, x1: right, y1: bottom },
    fieldType,
    candidates: candidates.slice(0, 6),
  };
}

module.exports = {
  readForceCell,
  readTypedCell,
  snapForcePrior,
  isPlausibleForce,
  isLikelyHallucinatedDigits,
  forceScore,
  wipeGridLines,
};
