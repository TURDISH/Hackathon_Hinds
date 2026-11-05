const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { createWorker } = require('tesseract.js');
const config = require('../config');
const { readForceCell, readTypedCell, isPlausibleForce } = require('./digitOcr');
const {
  readCellVision,
  readMeasurementGridBatch,
  probeVision,
  visionMode,
} = require('./visionOcr');
const { applySemanticDecode, isPlausibleForType } = require('./semanticDecode');

/**
 * Layout-aware handwritten grid extraction driven by template schema slotLayout.
 * 1) Deskew + contrast normalize
 * 2) Detect table H/V lines (ink projection)
 * 3) Propose cell ROIs from schema left/right tables
 * 4) Ink-vs-print: strip grid lines, score residual ink per cell
 * 5) Multi-pass digit OCR per cell with confidence
 */

function findPeaks(arr, from, to, thr, minGap) {
  const peaks = [];
  for (let i = from + 2; i < to - 2; i++) {
    if (arr[i] > thr && arr[i] >= arr[i - 1] && arr[i] >= arr[i + 1]) {
      if (!peaks.length || i - peaks[peaks.length - 1] > minGap) peaks.push(i);
      else if (arr[i] > arr[peaks[peaks.length - 1]]) peaks[peaks.length - 1] = i;
    }
  }
  return peaks;
}

function mergeClose(peaks, maxDist = 24) {
  const out = [];
  for (let i = 0; i < peaks.length; i++) {
    if (i + 1 < peaks.length && peaks[i + 1] - peaks[i] < maxDist) {
      out.push(Math.round((peaks[i] + peaks[i + 1]) / 2));
      i += 1;
    } else out.push(peaks[i]);
  }
  return out;
}

function resampleLines(lines, count) {
  if (!lines.length) return [];
  if (lines.length === count) return lines.slice();
  const first = lines[0];
  const last = lines[lines.length - 1];
  return Array.from({ length: count }, (_, i) =>
    Math.round(first + ((last - first) * i) / (count - 1))
  );
}

async function loadGray(imagePath) {
  const { data, info } = await sharp(imagePath)
    .greyscale()
    .normalize()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

function estimateSkew(data, width, height) {
  // Coarse skew search via horizontal projection variance
  let bestAngle = 0;
  let bestScore = -Infinity;
  for (let angle = -3; angle <= 3; angle += 0.5) {
    const rad = (angle * Math.PI) / 180;
    const proj = new Float32Array(height);
    for (let y = 0; y < height; y++) {
      let sum = 0;
      for (let x = Math.floor(width * 0.15); x < Math.floor(width * 0.85); x += 2) {
        const sx = Math.round(x * Math.cos(rad) - (y - height / 2) * Math.sin(rad));
        const sy = Math.round(x * Math.sin(rad) + (y - height / 2) * Math.cos(rad) + height / 2);
        if (sx < 0 || sy < 0 || sx >= width || sy >= height) continue;
        if (data[sy * width + sx] < 110) sum += 1;
      }
      proj[y] = sum;
    }
    // score = variance of top projections (sharper lines => higher peaks)
    let mean = 0;
    for (let y = 0; y < height; y++) mean += proj[y];
    mean /= height;
    let varsum = 0;
    for (let y = 0; y < height; y++) varsum += (proj[y] - mean) ** 2;
    if (varsum > bestScore) {
      bestScore = varsum;
      bestAngle = angle;
    }
  }
  return bestAngle;
}

async function deskewImage(imagePath, outPath) {
  const { data, width, height } = await loadGray(imagePath);
  const angle = estimateSkew(data, width, height);
  if (Math.abs(angle) < 0.25) {
    if (outPath !== imagePath) fs.copyFileSync(imagePath, outPath);
    return { path: outPath, angle: 0 };
  }
  await sharp(imagePath)
    .rotate(-angle, { background: '#ffffff' })
    .png()
    .toFile(outPath);
  return { path: outPath, angle };
}

function detectRowLines(data, width, height, targetEdges = 29) {
  // Include full dual-table body (header rule through last data rule). Starting
  // too low (~0.36) previously skipped shots 1–10 and pushed boxes into the footer.
  const y0 = Math.floor(height * 0.30);
  const y1 = Math.floor(height * 0.86);
  const x0 = Math.floor(width * 0.18);
  const x1 = Math.floor(width * 0.82);
  const score = new Float32Array(height);
  for (let y = y0; y < y1; y++) {
    let dark = 0;
    for (let x = x0; x < x1; x++) if (data[y * width + x] < 100) dark += 1;
    score[y] = dark / (x1 - x0);
  }
  const smooth = new Float32Array(height);
  for (let y = y0; y < y1; y++) {
    smooth[y] =
      (score[y - 2] + score[y - 1] + score[y] + score[y + 1] + score[y + 2]) / 5;
  }
  // Lower threshold + smaller gap to catch faint top rulings on phone photos
  const raw = findPeaks(smooth, y0, y1, 0.07, 8);
  let lines = mergeClose(raw, 18);
  const target = Math.max(20, targetEdges);

  // Prefer a span that covers ~table body: drop margin outliers, then resample
  if (lines.length >= 8) {
    const span = lines[lines.length - 1] - lines[0];
    const expectedSpan = height * 0.45;
    // If detected span is short (missing top/bottom), expand using ink-weighted bounds
    if (span < expectedSpan * 0.75) {
      let topBound = lines[0];
      let botBound = lines[lines.length - 1];
      for (let y = y0; y < lines[0]; y++) {
        if (smooth[y] > 0.06) {
          topBound = y;
          break;
        }
      }
      for (let y = y1 - 1; y > lines[lines.length - 1]; y--) {
        if (smooth[y] > 0.06) {
          botBound = y;
          break;
        }
      }
      lines = [topBound, ...lines, botBound];
      lines = [...new Set(lines.map((v) => Math.round(v)))].sort((a, b) => a - b);
      lines = mergeClose(lines, 16);
    }
  }

  if (lines.length >= target - 2 && lines.length <= target + 2) {
    return lines.length >= target ? lines.slice(0, target) : resampleLines(lines, target);
  }
  if (lines.length >= 8) {
    return resampleLines(lines, target);
  }
  // Last resort: synthesize across typical dual-table band
  return resampleLines(
    [Math.floor(height * 0.34), Math.floor(height * 0.82)],
    target
  );
}

function detectColLines(data, width, height, rowLines) {
  if (rowLines.length < 4) return [];
  const yA = rowLines[1];
  const yB = rowLines[Math.min(8, rowLines.length - 2)];
  const x0 = Math.floor(width * 0.06);
  const x1 = Math.floor(width * 0.94);
  const score = new Float32Array(width);
  for (let x = x0; x < x1; x++) {
    let dark = 0;
    for (let y = yA; y < yB; y++) if (data[y * width + x] < 100) dark += 1;
    score[x] = dark / Math.max(1, yB - yA);
  }
  const raw = findPeaks(score, x0, x1, 0.22, 28);
  return mergeClose(raw, 20);
}

function verticalInkProjection(data, width, height, x0, x1, y0, y1) {
  const lo = Math.max(0, Math.floor(x0));
  const hi = Math.min(width - 1, Math.ceil(x1));
  const top = Math.max(0, Math.floor(y0));
  const bot = Math.min(height - 1, Math.ceil(y1));
  const score = new Float32Array(width);
  const span = Math.max(1, bot - top);
  for (let x = lo; x <= hi; x++) {
    let dark = 0;
    for (let y = top; y <= bot; y++) if (data[y * width + x] < 105) dark += 1;
    score[x] = dark / span;
  }
  return score;
}

function findPeaksInRange(score, from, to, thr, minGap) {
  const peaks = [];
  const a = Math.max(2, Math.floor(from));
  const b = Math.min(score.length - 3, Math.ceil(to));
  for (let i = a; i <= b; i++) {
    if (score[i] > thr && score[i] >= score[i - 1] && score[i] >= score[i + 1]) {
      if (!peaks.length || i - peaks[peaks.length - 1] > minGap) peaks.push(i);
      else if (score[i] > score[peaks[peaks.length - 1]]) peaks[peaks.length - 1] = i;
    }
  }
  return peaks;
}

/**
 * Build 4 column edges (index | val1 | val2) for one table using ink/ruling projection.
 * Generic — no form-specific pixel maps.
 */
function refineTableCols(data, width, height, rowLines, outerL, outerR, valueColCount = 2) {
  const y0 = rowLines[Math.min(1, rowLines.length - 1)] || height * 0.4;
  const y1 = rowLines[Math.max(0, rowLines.length - 2)] || height * 0.85;
  const L = Math.max(0, Math.min(outerL, outerR));
  const R = Math.min(width - 1, Math.max(outerL, outerR));
  if (R - L < 80) return synthesizeCols(L, R, valueColCount);

  const score = verticalInkProjection(data, width, height, L, R, y0, y1);
  // Smooth
  const smooth = new Float32Array(width);
  for (let x = L; x <= R; x++) {
    let s = 0;
    let n = 0;
    for (let k = -2; k <= 2; k++) {
      const xx = x + k;
      if (xx < L || xx > R) continue;
      s += score[xx];
      n += 1;
    }
    smooth[x] = s / n;
  }

  const thr = 0.18;
  const minGap = Math.max(18, Math.floor((R - L) / 14));
  let peaks = findPeaksInRange(smooth, L + 4, R - 4, thr, minGap);

  // Need valueColCount + 1 interior boundaries ideally, or 4 total including outers
  const needInterior = valueColCount + 1; // index|v1, v1|v2, … plus maybe outer rulings inside
  if (peaks.length >= needInterior) {
    // Prefer peaks that maximize ink in the value columns (not the index)
    // Take strongest peaks, keep sorted, then pick a window of (valueColCount+1) with good spacing
    const ranked = peaks
      .map((x) => ({ x, v: smooth[x] }))
      .sort((a, b) => b.v - a.v);
    const chosen = [];
    for (const p of ranked) {
      if (chosen.every((c) => Math.abs(c - p.x) >= minGap)) chosen.push(p.x);
      if (chosen.length >= needInterior + 1) break;
    }
    chosen.sort((a, b) => a - b);
    // Use outer bounds + up to valueColCount interior splits from chosen
    let edges = [L, ...chosen, R];
    // Dedup / sort
    edges = [...new Set(edges.map((e) => Math.round(e)))].sort((a, b) => a - b);
    // Reduce to exactly valueColCount+2 edges (4 for dual values)
    const target = valueColCount + 2;
    if (edges.length > target) {
      // Keep first, last, and the strongest interiors
      const interior = edges.slice(1, -1)
        .map((x) => ({ x, v: smooth[x] || 0 }))
        .sort((a, b) => b.v - a.v)
        .slice(0, valueColCount)
        .map((o) => o.x)
        .sort((a, b) => a - b);
      edges = [edges[0], ...interior, edges[edges.length - 1]];
    }
    if (edges.length === target) {
      return sanitizeTableCols(edges, valueColCount);
    }
  }

  // Fallback: proportional synthesize from detected outers
  const outerPeaks = findPeaksInRange(smooth, L, R, 0.12, minGap);
  const leftEdge = outerPeaks[0] || L;
  const rightEdge = outerPeaks[outerPeaks.length - 1] || R;
  return sanitizeTableCols(synthesizeCols(leftEdge, rightEdge, valueColCount), valueColCount);
}

function inkInBand(data, width, height, x0, x1, y0, y1) {
  const lo = Math.max(0, Math.floor(x0));
  const hi = Math.min(width - 1, Math.ceil(x1));
  const top = Math.max(0, Math.floor(y0));
  const bot = Math.min(height - 1, Math.ceil(y1));
  if (hi <= lo || bot <= top) return 0;
  let dark = 0;
  let n = 0;
  for (let y = top; y <= bot; y += 2) {
    for (let x = lo; x <= hi; x += 2) {
      n += 1;
      if (data[y * width + x] < 120) dark += 1;
    }
  }
  return n ? dark / n : 0;
}

/**
 * Choose valueColCount+2 ruling edges from candidate peaks by maximizing
 * ink density in the value columns (generic dual-table grid fit).
 */
function pickTableEdgesFromPeaks(peaks, valueColCount, side, data = null, width = 0, height = 0, rowLines = []) {
  const target = valueColCount + 2;
  if (!peaks?.length) return null;
  const pts = [...new Set(peaks.map((p) => Math.round(p)))].sort((a, b) => a - b);
  if (pts.length < target) return null;

  const y0 = rowLines[Math.min(1, rowLines.length - 1)] || height * 0.4;
  const y1 = rowLines[Math.max(0, rowLines.length - 2)] || height * 0.85;

  function scoreEdges(edges) {
    if (edges.length !== target) return -1;
    const widths = [];
    for (let i = 0; i < edges.length - 1; i++) widths.push(edges[i + 1] - edges[i]);
    const indexW = widths[0];
    const valWs = widths.slice(1);
    const span = edges[edges.length - 1] - edges[0];
    // Dual FWD/AFT tables are typically ~25–32% of page width each
    if (span < width * 0.2 || span > width * 0.4) return -1;
    if (valWs.some((w) => w < 80) || indexW < 70) return -1;
    if (Math.max(...valWs) / Math.max(1, Math.min(...valWs)) > 1.8) return -1;
    // Index column (printed shot #s) is ~25–35% of table; reject gutter false-peaks
    const indexFrac = indexW / span;
    if (indexFrac < 0.22 || indexFrac > 0.4) return -1;
    let ink = 0;
    if (data && width && height) {
      for (let i = 1; i < edges.length - 1; i++) {
        ink += inkInBand(data, width, height, edges[i] + 2, edges[i + 1] - 2, y0, y1);
      }
    } else {
      ink = 1 / (1 + Math.abs(valWs[0] - valWs[valWs.length - 1]));
    }
    const balance = 1 / (1 + Math.abs(valWs[0] - valWs[valWs.length - 1]) / 30);
    const indexFit = 1 / (1 + Math.abs(indexFrac - 0.3) * 10);
    const spanFit = 1 / (1 + Math.abs(span / width - 0.28) * 6);
    return ink * 10 + balance * 3 + indexFit * 4 + spanFit * 3;
  }

  let best = null;
  let bestS = -1;
  // Enumerate combinations of `target` peaks (cap to avoid blow-up)
  const n = pts.length;
  if (n <= 12) {
    const pick = [];
    function rec(start, need) {
      if (need === 0) {
        const edges = pick.slice();
        const s = scoreEdges(edges);
        if (s > bestS) {
          bestS = s;
          best = edges;
        }
        return;
      }
      for (let i = start; i <= n - need; i++) {
        pick.push(pts[i]);
        rec(i + 1, need - 1);
        pick.pop();
      }
    }
    rec(0, target);
  } else {
    // Fallback window slide
    for (let i = 0; i <= n - target; i++) {
      const edges = pts.slice(i, i + target);
      const s = scoreEdges(edges);
      if (s > bestS) {
        bestS = s;
        best = edges;
      }
    }
  }

  if (!best) {
    // Last resort: side-biased slice
    const sliced = side === 'left' ? pts.slice(-target) : pts.slice(0, target);
    return sanitizeTableCols(sliced, valueColCount);
  }
  return sanitizeTableCols(best, valueColCount);
}

function splitTables(vLines, width, data = null, height = null, rowLines = [], valueColCount = 2) {
  let leftPeaks = [];
  let rightPeaks = [];

  if (vLines.length >= 4) {
    let splitAt = 0;
    let bestScore = -1;
    const mid = width / 2;
    // Dual-table gutter sits near page center — prefer gaps in the 42–58% band
    // over large right-margin voids (page edge / photo border).
    for (let i = 0; i < vLines.length - 1; i++) {
      const gap = vLines[i + 1] - vLines[i];
      const center = (vLines[i] + vLines[i + 1]) / 2;
      const midDist = Math.abs(center - mid) / width;
      if (midDist > 0.22) continue; // ignore far-side margins
      const midBonus = 1 - Math.min(1, midDist / 0.12);
      const score = gap * (0.35 + midBonus * 1.4);
      if (score > bestScore) {
        bestScore = score;
        splitAt = i;
      }
    }
    // Fallback: largest gap overall if nothing near mid
    if (bestScore < 0) {
      let bestGap = 0;
      for (let i = 0; i < vLines.length - 1; i++) {
        const gap = vLines[i + 1] - vLines[i];
        if (gap > bestGap) {
          bestGap = gap;
          splitAt = i;
        }
      }
    }
    leftPeaks = vLines.slice(0, splitAt + 1);
    rightPeaks = vLines.slice(splitAt + 1);
  }

  // Include the shared center divider; drop far gutters outside typical data tables
  const leftCand = leftPeaks
    .concat(rightPeaks[0] != null ? [rightPeaks[0]] : [])
    .filter((x) => x >= width * 0.12 && x <= width * 0.55);
  const rightCand = (leftPeaks.length ? [leftPeaks[leftPeaks.length - 1]] : [])
    .concat(rightPeaks)
    .filter((x) => x >= width * 0.45 && x <= width * 0.92);

  let left = pickTableEdgesFromPeaks(leftCand, valueColCount, 'left', data, width, height, rowLines)
    || synthesizeCols(Math.floor(width * 0.2), Math.floor(width * 0.47), valueColCount);
  let right = pickTableEdgesFromPeaks(rightCand, valueColCount, 'right', data, width, height, rowLines)
    || synthesizeCols(Math.floor(width * 0.5), Math.floor(width * 0.79), valueColCount);

  // Refine interiors from ink projection inside chosen outer bounds (generic, no hardcodes)
  if (data && height && rowLines?.length) {
    left = refineTableCols(data, width, height, rowLines, left[0], left[left.length - 1], valueColCount);
    right = refineTableCols(data, width, height, rowLines, right[0], right[right.length - 1], valueColCount);
  }

  if (process.env.DEBUG_GRID) {
    console.log('splitTables', { width, vLines, left, right, leftPeaks, rightPeaks, leftCand, rightCand });
  }
  return { left, right };
}

function synthesizeCols(outerL, outerR, valueColCount = 2) {
  const L = Math.round(outerL);
  const R = Math.round(outerR);
  const W = Math.max(40, R - L);
  // index ~28%, remaining split evenly across value columns
  const indexW = Math.round(W * 0.28);
  const rest = W - indexW;
  const edges = [L, L + indexW];
  for (let i = 1; i <= valueColCount; i++) {
    edges.push(L + indexW + Math.round((rest * i) / valueColCount));
  }
  edges[edges.length - 1] = R;
  return edges;
}

function sanitizeTableCols(cols, valueColCount = 2) {
  const target = valueColCount + 2;
  if (!cols || cols.length < target) {
    return synthesizeCols(cols?.[0] || 0, cols?.[cols.length - 1] || 100, valueColCount);
  }
  const edges = cols.slice(0, target).map((c) => Math.round(c));
  // Value columns must be reasonably wide and balanced
  const widths = [];
  for (let i = 1; i < edges.length - 1; i++) widths.push(edges[i + 1] - edges[i]);
  const minW = Math.min(...widths);
  const maxW = Math.max(...widths);
  if (minW < 70 || maxW / Math.max(1, minW) > 2.0) {
    return synthesizeCols(edges[0], edges[edges.length - 1], valueColCount);
  }
  // Also reject tiny index columns
  const indexW = edges[1] - edges[0];
  const span = edges[edges.length - 1] - edges[0];
  if (indexW < 70 || indexW / Math.max(1, span) < 0.2 || indexW / span > 0.42) {
    return synthesizeCols(edges[0], edges[edges.length - 1], valueColCount);
  }
  return edges;
}

function cellInkScore(data, width, height, box) {
  const pad = 3;
  const L = Math.max(0, box.x0 + pad);
  const R = Math.min(width - 1, box.x1 - pad);
  const T = Math.max(0, box.y0 + pad);
  const B = Math.min(height - 1, box.y1 - pad);
  if (R <= L || B <= T) return { inkRatio: 0, hasInk: false };

  // Copy cell and blank out near-full dark rows/cols (grid lines)
  const cw = R - L;
  const ch = B - T;
  const cell = new Uint8Array(cw * ch);
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      cell[y * cw + x] = data[(T + y) * width + (L + x)] < 130 ? 1 : 0;
    }
  }
  for (let y = 0; y < ch; y++) {
    let s = 0;
    for (let x = 0; x < cw; x++) s += cell[y * cw + x];
    if (s / cw > 0.5) for (let x = 0; x < cw; x++) cell[y * cw + x] = 0;
  }
  for (let x = 0; x < cw; x++) {
    let s = 0;
    for (let y = 0; y < ch; y++) s += cell[y * cw + x];
    if (s / ch > 0.5) for (let y = 0; y < ch; y++) cell[y * cw + x] = 0;
  }
  let ink = 0;
  for (let i = 0; i < cell.length; i++) ink += cell[i];
  const inkRatio = ink / cell.length;
  // Low threshold: light pencil / thin strokes still count as handwritten
  return { inkRatio, hasInk: inkRatio > 0.004, cell, cw, ch, L, T };
}

/**
 * Template-driven row register: read printed shot indices from the index
 * column and map each template shot → scan row band.
 */
async function mapShotsFromIndexColumn(worker, imagePath, rowLines, indexCol, {
  skipHeaderBand = true,
  expectedShots = [],
} = {}) {
  const start = skipHeaderBand && rowLines.length > 3 ? 1 : 0;
  const dataRows = Math.min(expectedShots.length || 27, rowLines.length - 1 - start);
  const shotToBand = new Map();

  function digitsFromConfused(text) {
    return String(text || '')
      .replace(/[OoD]/g, '0')
      .replace(/[Il|]/g, '1')
      .replace(/[Zz]/g, '2')
      .replace(/[Ss]/g, '5')
      .replace(/[Bb]/g, '8')
      .replace(/[Gg]/g, '6')
      .replace(/\D/g, '');
  }

  for (let r = 0; r < dataRows; r++) {
    const y0 = rowLines[start + r];
    const y1 = rowLines[start + r + 1];
    const pad = 2;
    // Prefer left portion of index column (shot numbers sit left)
    const left = indexCol[0] + pad;
    const right = Math.round(indexCol[0] + (indexCol[1] - indexCol[0]) * 0.55);
    const top = y0 + pad;
    const bottom = y1 - pad;
    if (right - left < 8 || bottom - top < 6) continue;
    try {
      const buf = await sharp(imagePath)
        .extract({
          left: Math.max(0, left),
          top: Math.max(0, top),
          width: Math.max(8, right - left),
          height: bottom - top,
        })
        .resize({ width: 160, height: 100, fit: 'fill' })
        .normalize()
        .sharpen()
        .png()
        .toBuffer();
      await worker.setParameters({
        tessedit_char_whitelist: '',
        tessedit_pageseg_mode: '7',
      });
      const { data: ocr } = await worker.recognize(buf, {}, { text: true });
      let digits = digitsFromConfused(ocr.text);
      if (!digits) {
        await worker.setParameters({
          tessedit_char_whitelist: '0123456789',
          tessedit_pageseg_mode: '8',
        });
        const { data: ocr2 } = await worker.recognize(buf, {}, { text: true });
        digits = (ocr2.text || '').replace(/\D/g, '');
      }
      const n = Number(digits);
      const maxShot = expectedShots.length
        ? Math.max(...expectedShots)
        : 200;
      if (Number.isFinite(n) && n >= 1 && n <= maxShot) {
        shotToBand.set(n, { y0, y1, rowIndex: r });
      }
    } catch {
      // ignore individual cell failures
    }
  }
  return shotToBand;
}

function valueRolesForTable(table, fallback = ['fwd', 'aft']) {
  const roles = (table?.valueColumns || []).filter(Boolean);
  return roles.length ? roles.slice(0, 2) : fallback;
}

function buildCellBoxes(rowLines, leftCols, rightCols, {
  skipHeaderBand = true,
  slotLayout = null,
  shotBands = null,
} = {}) {
  const boxes = [];
  if (rowLines.length < 2) return boxes;
  const start = skipHeaderBand && rowLines.length > 3 ? 1 : 0;

  // Slot inventory from cached template schema — empty schema ⇒ no silent 1–54 assumption
  const leftTable = slotLayout?.leftTable || null;
  const rightTable = slotLayout?.rightTable || null;
  if (!leftTable?.shots?.length && !rightTable?.shots?.length) {
    return boxes;
  }

  const leftShots = leftTable?.shots || [];
  const rightShots = rightTable?.shots || [];
  const leftRoles = valueRolesForTable(leftTable);
  const rightRoles = valueRolesForTable(rightTable);
  const dataRows = Math.min(
    Math.max(leftShots.length, rightShots.length),
    rowLines.length - 1 - start
  );

  function bandForShot(shot, fallbackIndex, peerOffset) {
    if (shotBands?.has(shot)) return shotBands.get(shot);
    if (peerOffset && shotBands?.has(shot - peerOffset)) {
      return shotBands.get(shot - peerOffset);
    }
    const y0 = rowLines[start + fallbackIndex];
    const y1 = rowLines[start + fallbackIndex + 1];
    return { y0, y1 };
  }

  function pushRoleBoxes(shots, roles, cols, r, peerOffset) {
    const shot = shots[r];
    if (shot == null || !cols || cols.length < 3) return;
    const { y0, y1 } = bandForShot(shot, r, peerOffset);
    for (let i = 0; i < roles.length && i + 2 < cols.length; i++) {
      const role = roles[i];
      boxes.push({
        id: `${role}_${shot}`,
        label: `Shot ${shot} ${String(role).toUpperCase()} (lb)`,
        fieldType: 'force_lb',
        x0: cols[i + 1],
        x1: cols[i + 2],
        y0,
        y1,
        shot,
        side: role,
      });
    }
  }

  const peerOffset =
    leftShots.length && rightShots.length
      ? Math.abs((rightShots[0] || 0) - (leftShots[0] || 0)) || leftShots.length
      : 0;

  for (let r = 0; r < dataRows; r++) {
    pushRoleBoxes(leftShots, leftRoles, leftCols, r, 0);
    pushRoleBoxes(rightShots, rightRoles, rightCols, r, peerOffset);
  }
  return boxes;
}

function contentBBox(cell, cw, ch) {
  let minx = cw, maxx = -1, miny = ch, maxy = -1;
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      if (!cell[y * cw + x]) continue;
      if (x < minx) minx = x;
      if (x > maxx) maxx = x;
      if (y < miny) miny = y;
      if (y > maxy) maxy = y;
    }
  }
  if (maxx < 0) return null;
  return { minx, maxx, miny, maxy };
}

async function ocrDigitCell(worker, imagePath, box, width, height, inkInfo) {
  const pad = 2;
  let left = Math.max(0, Math.floor(box.x0 + pad));
  let top = Math.max(0, Math.floor(box.y0 + pad));
  let right = Math.min(width, Math.ceil(box.x1 - pad));
  let bottom = Math.min(height, Math.ceil(box.y1 - pad));

  // Tighten to ink content bbox inside the cell when available
  if (inkInfo?.cell && inkInfo.cw) {
    const bb = contentBBox(inkInfo.cell, inkInfo.cw, inkInfo.ch);
    if (bb) {
      left = Math.max(0, inkInfo.L + bb.minx - 4);
      right = Math.min(width, inkInfo.L + bb.maxx + 5);
      top = Math.max(0, inkInfo.T + bb.miny - 4);
      bottom = Math.min(height, inkInfo.T + bb.maxy + 5);
    }
  }

  const w = right - left;
  const h = bottom - top;
  if (w < 8 || h < 8) return { text: '', confidence: 0 };

  // Build cleaned grayscale: wipe residual grid lines in-cell
  const { data: raw, info } = await sharp(imagePath)
    .extract({ left, top, width: w, height: h })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const cw = info.width;
  const ch = info.height;
  const cleaned = Buffer.from(raw);
  for (let y = 0; y < ch; y++) {
    let dark = 0;
    for (let x = 0; x < cw; x++) if (raw[y * cw + x] < 110) dark += 1;
    if (dark / cw > 0.55) for (let x = 0; x < cw; x++) cleaned[y * cw + x] = 255;
  }
  for (let x = 0; x < cw; x++) {
    let dark = 0;
    for (let y = 0; y < ch; y++) if (raw[y * cw + x] < 110) dark += 1;
    if (dark / ch > 0.55) for (let y = 0; y < ch; y++) cleaned[y * cw + x] = 255;
  }

  const cleanedPng = await sharp(cleaned, { raw: { width: cw, height: ch, channels: 1 } })
    .resize({
      width: Math.max(220, cw * 6),
      height: Math.max(110, ch * 6),
      fit: 'fill',
      kernel: sharp.kernel.lanczos3,
    })
    .normalize()
    .sharpen({ sigma: 1.4 })
    .png()
    .toBuffer();

  const variants = [
    cleanedPng,
    await sharp(cleanedPng).threshold(140).png().toBuffer(),
    await sharp(cleanedPng).threshold(160).png().toBuffer(),
    await sharp(cleanedPng).modulate({ brightness: 1.2 }).threshold(150).png().toBuffer(),
  ];

  function scoreOf(c) {
    const n = Number(c.text);
    const plausible = c.text.length >= 3 && c.text.length <= 4 && n >= 200 && n <= 3500;
    return (plausible ? 250 : 0) + (c.text.length === 4 ? 30 : 0) + c.confidence + c.text.length * 5;
  }

  async function consider(buf, psm) {
    await worker.setParameters({
      tessedit_char_whitelist: '0123456789',
      tessedit_pageseg_mode: psm,
    });
    const { data: ocr } = await worker.recognize(buf, {}, { text: true });
    let text = (ocr.text || '').replace(/\D/g, '');
    if (text.length > 5) {
      let pick = text.slice(0, 4);
      for (let i = 0; i <= text.length - 3; i++) {
        const sub4 = text.slice(i, i + 4);
        const n4 = Number(sub4);
        if (sub4.length === 4 && n4 >= 500 && n4 <= 3000) {
          pick = sub4;
          break;
        }
      }
      text = pick;
    }
    return { text, confidence: Number(ocr.confidence) || 0 };
  }

  let best = { text: '', confidence: -1 };
  for (const buf of variants.slice(0, 3)) {
    const cand = await consider(buf, '7');
    if (scoreOf(cand) > scoreOf(best)) best = cand;
  }
  const okN = Number(best.text);
  const ok = best.text.length >= 3 && best.text.length <= 4 && okN >= 200 && okN <= 3500;
  if (!ok) {
    for (const psm of ['8', '13']) {
      for (const buf of variants) {
        const cand = await consider(buf, psm);
        if (scoreOf(cand) > scoreOf(best)) best = cand;
      }
    }
  }

  let confidence = best.confidence;
  const n = Number(best.text);
  if (!best.text) confidence = 0;
  else if (!(best.text.length >= 3 && best.text.length <= 4 && n >= 200 && n <= 3500)) {
    confidence = Math.min(confidence, 45);
  }

  return {
    text: best.text,
    confidence,
    bbox: { x0: left, y0: top, x1: right, y1: bottom },
  };
}

async function extractGridFields(
  imagePath,
  { debugDir, template = null, detectOnly = false, onProgress = null } = {}
) {
  const report = (payload) => {
    try {
      if (typeof onProgress === 'function') onProgress(payload);
    } catch {
      /* ignore UI progress errors */
    }
  };

  fs.mkdirSync(path.dirname(imagePath), { recursive: true });
  const deskewedPath = path.join(path.dirname(imagePath), 'page-deskew.png');
  report({ phase: 'detect', detail: 'Deskewing page', fraction: 0.05 });
  const { path: workPath, angle } = await deskewImage(imagePath, deskewedPath);
  // Only honor explicit option — never process.env alone (leaks into the long-lived
  // server from bench shells and skips all cell OCR → empty Excel measurements).
  const geometryOnly = Boolean(detectOnly);
  const { data, width, height } = await loadGray(workPath);

  const slotLayout = template?.slotLayout || null;
  const expectedSlots = slotLayout?.measurementSlots
    || (template?.fields || []).filter((f) => f.kind === 'measurement').length
    || 0;
  if (!expectedSlots) {
    return {
      fields: [],
      meta: {
        angle: 0,
        cellSlots: 0,
        expectedSlots: 0,
        handwrittenCells: 0,
        ocrFilled: 0,
        plausible: 0,
        note: 'No measurement slots in template schema — skipped grid OCR',
      },
    };
  }

  // Row count from template dataRows (+1 header edge pair → resample targets)
  report({ phase: 'detect', detail: 'Finding row/column rulings', fraction: 0.35 });
  const targetEdges = (slotLayout?.dataRows || 27) + 2; // header top + data + bottom
  const rowLines = detectRowLines(data, width, height, targetEdges);
  const vLines = detectColLines(data, width, height, rowLines);
  const valueColCount = Math.max(
    1,
    slotLayout?.leftTable?.valueColumns?.length
      || slotLayout?.rightTable?.valueColumns?.length
      || 2
  );
  const { left, right } = splitTables(vLines, width, data, height, rowLines, valueColCount);
  report({ phase: 'detect', detail: 'Grid geometry ready', fraction: 1 });

  const worker = await createWorker('eng');
  await worker.setParameters({
    tessedit_char_whitelist: '0123456789',
    tessedit_pageseg_mode: '7',
  });

  async function ocrBoxes(boxes) {
    const mode = visionMode();
    const visionConcurrency = Math.max(1, Number(process.env.VISION_OCR_CONCURRENCY || 2));
    // batch: banded table crops; residual weak cells may get per-cell vision
    const batchCellFallback =
      (process.env.VISION_BATCH_CELL_FALLBACK || 'true').toLowerCase() !== 'false' &&
      (process.env.VISION_BATCH_CELL_FALLBACK || 'true').toLowerCase() !== '0';

    // Score ink first (sync), then run vision in a small pool; Tesseract stays serial.
    const prepared = boxes.map((box) => {
      const ink = cellInkScore(data, width, height, box);
      ink.pageWidth = width;
      ink.pageHeight = height;
      return { box, ink };
    });

    const visionByIndex = new Array(prepared.length).fill(null);
    const needVisionIdx = [];
    for (let i = 0; i < prepared.length; i++) {
      if (!prepared[i].ink.hasInk) continue;
      // primary: always vision; hybrid defer until after tess; batch uses banded crops
      if (mode === 'primary') needVisionIdx.push(i);
    }

    let cellsDone = 0;
    const cellsTotal = Math.max(1, prepared.filter((p) => p.ink.hasInk).length);
    const bumpCellProgress = (label) => {
      cellsDone += 1;
      report({
        phase: 'ocr',
        detail: label || `Handwriting cell ${cellsDone}/${cellsTotal}`,
        fraction: Math.min(1, cellsDone / cellsTotal),
        current: cellsDone,
        total: cellsTotal,
      });
    };
    let visionStarted = 0;
    const bumpVisionProgress = () => {
      visionStarted += 1;
      // During primary vision pool, show in-flight progress before cells are finalized
      report({
        phase: 'ocr',
        detail: `Vision OCR ${visionStarted}/${needVisionIdx.length || cellsTotal}`,
        fraction: Math.min(0.95, visionStarted / Math.max(1, needVisionIdx.length || cellsTotal)),
        current: visionStarted,
        total: needVisionIdx.length || cellsTotal,
      });
    };

    async function runPool(indices, fn, concurrency) {
      let cursor = 0;
      async function workerFn() {
        while (cursor < indices.length) {
          const my = cursor;
          cursor += 1;
          const idx = indices[my];
          visionByIndex[idx] = await fn(idx);
          bumpVisionProgress();
        }
      }
      const n = Math.min(concurrency, Math.max(1, indices.length));
      await Promise.all(Array.from({ length: n }, () => workerFn()));
    }

    if (mode === 'batch') {
      const inkedBoxes = prepared.filter((p) => p.ink.hasInk).map((p) => p.box);
      report({
        phase: 'ocr',
        detail: `Batch vision on ${inkedBoxes.length} inked cells (banded tables)`,
        fraction: 0.05,
        current: 0,
        total: Math.max(1, inkedBoxes.length),
      });
      const batchMap = await readMeasurementGridBatch(workPath, inkedBoxes, {
        pageWidth: width,
        pageHeight: height,
        onBand: ({ side, shots, index, total }) => {
          report({
            phase: 'ocr',
            detail: `Batch vision ${side} band ${index}/${total} (shots ${shots[0]}–${shots[shots.length - 1]})`,
            fraction: Math.min(0.85, (index / Math.max(1, total * 2)) * 0.8 + 0.05),
            current: index,
            total: total * 2,
          });
        },
      });
      const idToIdx = new Map(prepared.map((p, i) => [p.box.id, i]));
      for (const [id, result] of batchMap) {
        const idx = idToIdx.get(id);
        if (idx != null) visionByIndex[idx] = result;
      }
      report({
        phase: 'ocr',
        detail: `Batch vision filled ${batchMap.size}/${inkedBoxes.length}; refining residuals`,
        fraction: 0.88,
        current: batchMap.size,
        total: Math.max(1, inkedBoxes.length),
      });
    } else if (needVisionIdx.length) {
      await runPool(
        needVisionIdx,
        async (idx) => {
          const b = prepared[idx].box;
          return readCellVision(workPath, b, prepared[idx].ink, {
            fieldType: b.fieldType || 'force_lb',
            label: b.label,
            id: b.id,
          });
        },
        visionConcurrency
      );
    }

    const fields = [];
    let handwrittenCells = 0;
    let ocrFilled = 0;
    let plausible = 0;
    const hybridVisionQueue = [];
    const batchResidualIdx = [];

    for (let i = 0; i < prepared.length; i++) {
      const { box, ink } = prepared[i];
      let value = '';
      let confidence = 0;
      let bbox = { x0: box.x0, y0: box.y0, x1: box.x1, y1: box.y1 };
      let method = 'empty';
      let tess = null;
      let vision = visionByIndex[i];

      const fieldType = box.fieldType || 'force_lb';
      const fieldHint = { fieldType, label: box.label, id: box.id };
      const cellBBox = {
        x0: Math.round(box.x0),
        y0: Math.round(box.y0),
        x1: Math.round(box.x1),
        y1: Math.round(box.y1),
      };

      if (ink.hasInk) {
        handwrittenCells += 1;

        // Tess for hybrid always; for batch when vision miss/weak; for primary only as fallback
        if (mode === 'hybrid' || mode === 'off') {
          tess = await readTypedCell(worker, workPath, box, ink, fieldHint);
        } else if (mode === 'batch') {
          const batchOk =
            vision?.text &&
            isPlausibleForType(fieldType, vision.text) &&
            (vision.confidence || 0) >= 55;
          if (!batchOk) {
            tess = await readTypedCell(worker, workPath, box, ink, fieldHint);
          }
        }

        const tessOk =
          tess && isPlausibleForType(fieldType, tess.text) && (tess.confidence || 0) >= 55;
        if (mode === 'hybrid' && (!tess?.text || !tessOk)) {
          hybridVisionQueue.push(i);
          prepared[i]._tess = tess;
          prepared[i]._pendingHybrid = true;
          fields.push(null);
          continue;
        }

        if (mode === 'batch') {
          const batchOk =
            vision?.text &&
            isPlausibleForType(fieldType, vision.text) &&
            (vision.confidence || 0) >= 55;
          // Residual small cell crops only for weak/missing batch cells
          if (!batchOk && !tessOk && batchCellFallback) {
            batchResidualIdx.push(i);
            prepared[i]._tess = tess;
            prepared[i]._batch = vision;
            fields.push(null);
            continue;
          }
        }

        if (mode === 'primary' && (!vision?.text || !isPlausibleForType(fieldType, vision.text))) {
          tess = await readTypedCell(worker, workPath, box, ink, fieldHint);
        }

        const pick = (() => {
          if (vision?.text && isPlausibleForType(fieldType, vision.text)) return vision;
          if (tess?.text && isPlausibleForType(fieldType, tess.text)) return tess;
          if (vision?.text) return vision;
          if (tess?.text) return tess;
          if (tess?.candidates?.length) {
            const weak = [...tess.candidates].sort((a, b) => (b.confidence || 0) - (a.confidence || 0))[0];
            if (weak?.text) {
              return {
                text: weak.text,
                confidence: Math.min(38, weak.confidence || 25),
                method: `weak_${weak.method || 'cand'}`,
                bbox: tess.bbox,
              };
            }
          }
          return vision || tess || { text: '', confidence: 0, method: 'empty' };
        })();

        value = pick.text || '';
        confidence = pick.confidence || 0;
        bbox = cellBBox; // overlay uses full cell ROI (deskewed page space)
        method = pick.method || 'force_ensemble';
        if (value) ocrFilled += 1;
        if (!value) confidence = Math.min(35, Math.round(ink.inkRatio * 1000));
        if (isPlausibleForType(fieldType, value) || isPlausibleForce(value)) plausible += 1;
      }

      let field = {
        id: box.id,
        label: box.label,
        fieldType,
        kind: 'measurement',
        value,
        confidence: Number(confidence.toFixed(1)),
        lowConfidence: true,
        needsReview: true,
        source: {
          method,
          inkRatio: Number(ink.inkRatio.toFixed(4)),
          hasInk: ink.hasInk,
          cellBBox,
          valueBBoxes: value || ink.hasInk ? [cellBBox] : [],
          inkBBox: ink.hasInk ? bbox : undefined,
          templateSlot: true,
          coordSpace: 'deskewed',
        },
      };
      field = applySemanticDecode(field);
      field.lowConfidence =
        !field.value || field.confidence < config.confidenceThreshold || !ink.hasInk;
      field.needsReview = field.lowConfidence;
      fields.push(field);
      if (ink.hasInk) bumpCellProgress();
    }

    const residualQueues = [];
    if (hybridVisionQueue.length) residualQueues.push(hybridVisionQueue);
    if (batchResidualIdx.length) residualQueues.push(batchResidualIdx);

    for (const queue of residualQueues) {
      await runPool(
        queue,
        async (idx) => {
          const b = prepared[idx].box;
          return readCellVision(workPath, b, prepared[idx].ink, {
            fieldType: b.fieldType || 'force_lb',
            label: b.label,
            id: b.id,
          });
        },
        visionConcurrency
      );
      for (const i of queue) {
        const { box, ink } = prepared[i];
        const fieldType = box.fieldType || 'force_lb';
        const tess = prepared[i]._tess;
        const batch = prepared[i]._batch;
        const vision = visionByIndex[i];
        const cellBBox = {
          x0: Math.round(box.x0),
          y0: Math.round(box.y0),
          x1: Math.round(box.x1),
          y1: Math.round(box.y1),
        };
        const pick = (() => {
          // Prefer small-crop cell vision, then agreeing/plausible batch, then tess
          if (vision?.text && isPlausibleForType(fieldType, vision.text)) return vision;
          if (batch?.text && isPlausibleForType(fieldType, batch.text)) return batch;
          if (tess?.text && isPlausibleForType(fieldType, tess.text)) return tess;
          if (vision?.text) return vision;
          if (batch?.text) return batch;
          if (tess?.text) return tess;
          if (tess?.candidates?.length) {
            const weak = [...tess.candidates].sort((a, b) => (b.confidence || 0) - (a.confidence || 0))[0];
            if (weak?.text) {
              return {
                text: weak.text,
                confidence: Math.min(38, weak.confidence || 25),
                method: `weak_${weak.method || 'cand'}`,
                bbox: tess.bbox,
              };
            }
          }
          return vision || batch || tess || { text: '', confidence: 0, method: 'empty' };
        })();
        let value = pick.text || '';
        let confidence = pick.confidence || 0;
        const method = pick.method || 'force_ensemble';
        if (value) ocrFilled += 1;
        if (!value) confidence = Math.min(35, Math.round(ink.inkRatio * 1000));
        if (isPlausibleForType(fieldType, value) || isPlausibleForce(value)) plausible += 1;
        let field = {
          id: box.id,
          label: box.label,
          fieldType,
          kind: 'measurement',
          value,
          confidence: Number(confidence.toFixed(1)),
          lowConfidence: true,
          needsReview: true,
          source: {
            method,
            inkRatio: Number(ink.inkRatio.toFixed(4)),
            hasInk: ink.hasInk,
            cellBBox,
            valueBBoxes: value || ink.hasInk ? [cellBBox] : [],
            inkBBox: pick.bbox,
            templateSlot: true,
            coordSpace: 'deskewed',
          },
        };
        field = applySemanticDecode(field);
        field.lowConfidence =
          !field.value || field.confidence < config.confidenceThreshold || !ink.hasInk;
        field.needsReview = field.lowConfidence;
        fields[i] = field;
        bumpCellProgress();
      }
    }

    // Ensure every template measurement slot exists even if ROI grid was short
    if (template?.fields) {
      const have = new Set(fields.filter(Boolean).map((f) => f.id));
      for (const tf of template.fields) {
        if (tf.kind !== 'measurement' || have.has(tf.id)) continue;
        fields.push({
          id: tf.id,
          label: tf.label,
          fieldType: 'force_lb',
          kind: 'measurement',
          value: '',
          confidence: 0,
          lowConfidence: true,
          needsReview: true,
          source: {
            method: 'template_slot_unmapped',
            hasInk: false,
            valueBBoxes: [],
            templateSlot: true,
          },
        });
      }
    }

    return {
      fields: fields.filter(Boolean),
      handwrittenCells,
      ocrFilled,
      plausible,
    };
  }

  // Template prior: register rows using printed shot numbers from schema leftTable
  const expectedLeft = slotLayout?.leftTable?.shots || [];
  let shotBands = new Map();
  let useSkip = true;
  if (expectedLeft.length && left.length >= 2) {
    const bandsSkip = await mapShotsFromIndexColumn(
      worker,
      workPath,
      rowLines,
      [left[0], left[1]],
      { skipHeaderBand: true, expectedShots: expectedLeft }
    );
    const bandsNo = await mapShotsFromIndexColumn(
      worker,
      workPath,
      rowLines,
      [left[0], left[1]],
      { skipHeaderBand: false, expectedShots: expectedLeft }
    );
    useSkip = bandsSkip.size >= bandsNo.size;
    shotBands = useSkip ? bandsSkip : bandsNo;
    // Index-column OCR on phone photos is often wrong and scrambles overlay Y bands.
    // Only keep shotBands when nearly complete AND roughly monotonic with row order.
    const minIndexed = Math.max(20, Math.floor(expectedLeft.length * 0.75));
    let keepBands = shotBands.size >= minIndexed;
    if (keepBands) {
      const ordered = expectedLeft
        .filter((s) => shotBands.has(s))
        .map((s) => ({ s, y: shotBands.get(s).y0 }));
      let asc = 0;
      for (let i = 1; i < ordered.length; i++) {
        if (ordered[i].y >= ordered[i - 1].y - 8) asc += 1;
      }
      const mono = ordered.length > 1 ? asc / (ordered.length - 1) : 0;
      if (mono < 0.8) keepBands = false;
      if (process.env.DEBUG_GRID) {
        console.log('shotBands mono', Number(mono.toFixed(2)), 'keep', keepBands, 'n', shotBands.size);
      }
    }
    if (!keepBands) {
      if (process.env.DEBUG_GRID) {
        console.log('shotBands discarded → sequential rows', 'indexed', shotBands.size, 'need', minIndexed);
      }
      shotBands = new Map();
    }
  }
  const boxes = buildCellBoxes(rowLines, left, right, {
    slotLayout,
    skipHeaderBand: useSkip,
    shotBands,
  });

  // Fast geometry bench: skip per-cell OCR (still scores ink + writes overlay)
  if (geometryOnly) {
    await worker.terminate();
    let handwrittenCells = 0;
    const fields = boxes.map((box) => {
      const ink = cellInkScore(data, width, height, box);
      if (ink.hasInk) handwrittenCells += 1;
      const cellBBox = {
        x0: Math.round(box.x0),
        y0: Math.round(box.y0),
        x1: Math.round(box.x1),
        y1: Math.round(box.y1),
      };
      return {
        id: box.id,
        label: box.label,
        fieldType: box.fieldType || 'force_lb',
        kind: 'measurement',
        value: '',
        confidence: 0,
        lowConfidence: true,
        needsReview: true,
        source: {
          method: 'detect_only',
          inkRatio: Number(ink.inkRatio.toFixed(4)),
          hasInk: ink.hasInk,
          cellBBox,
          valueBBoxes: ink.hasInk ? [cellBBox] : [],
          templateSlot: true,
          coordSpace: 'deskewed',
        },
      };
    });
    if (debugDir) {
      fs.mkdirSync(debugDir, { recursive: true });
      const overlay = await sharp(workPath)
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      const px = overlay.data;
      const ww = overlay.info.width;
      const hh = overlay.info.height;
      const stroke = (x0, y0, x1, y1, rgba) => {
        for (let x = x0; x < x1; x++) {
          for (const y of [y0, y1 - 1]) {
            if (y < 0 || y >= hh || x < 0 || x >= ww) continue;
            const i = (y * ww + x) * 4;
            px[i] = rgba[0]; px[i + 1] = rgba[1]; px[i + 2] = rgba[2]; px[i + 3] = 255;
          }
        }
        for (let y = y0; y < y1; y++) {
          for (const x of [x0, x1 - 1]) {
            if (y < 0 || y >= hh || x < 0 || x >= ww) continue;
            const i = (y * ww + x) * 4;
            px[i] = rgba[0]; px[i + 1] = rgba[1]; px[i + 2] = rgba[2]; px[i + 3] = 255;
          }
        }
      };
      for (const f of fields) {
        const b = f.source.cellBBox || f.source.valueBBoxes?.[0];
        if (!b) continue;
        stroke(Math.round(b.x0), Math.round(b.y0), Math.round(b.x1), Math.round(b.y1), [180, 83, 9, 255]);
      }
      await sharp(px, { raw: { width: ww, height: hh, channels: 4 } })
        .png()
        .toFile(path.join(debugDir, 'grid-overlay.png'));
      fs.writeFileSync(
        path.join(debugDir, 'grid-meta.json'),
        JSON.stringify(
          {
            angle,
            width,
            height,
            rowLines,
            vLines,
            leftCols: left,
            rightCols: right,
            boxes: boxes.length,
            expectedSlots,
            handwrittenCells,
            detectOnly: true,
            indexedShots: shotBands.size,
          },
          null,
          2
        )
      );
    }
    const visionInfo = await probeVision();
    return {
      fields,
      meta: {
        angle,
        deskewedWidth: width,
        deskewedHeight: height,
        deskewedPath: workPath,
        rowCount: Math.max(0, rowLines.length - 1),
        cellSlots: boxes.length,
        expectedSlots,
        handwrittenCells,
        ocrFilled: 0,
        plausible: 0,
        detectOnly: true,
        skipHeaderBand: useSkip,
        indexedShots: shotBands.size,
        leftCols: left,
        rightCols: right,
        handwritingStack: { tesseract: true, vision: visionInfo, mode: visionMode() },
      },
    };
  }

  const { fields, handwrittenCells, ocrFilled, plausible } = await ocrBoxes(boxes);

  await worker.terminate();

  if (debugDir) {
    fs.mkdirSync(debugDir, { recursive: true });
    // Draw boxes overlay
    const overlay = await sharp(workPath)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const px = overlay.data;
    const ww = overlay.info.width;
    const hh = overlay.info.height;
    const stroke = (x0, y0, x1, y1, rgba, thickness = 3) => {
      for (let t = 0; t < thickness; t++) {
        for (let x = x0; x < x1; x++) {
          for (const y of [y0 + t, y1 - 1 - t]) {
            if (y < 0 || y >= hh || x < 0 || x >= ww) continue;
            const i = (y * ww + x) * 4;
            px[i] = rgba[0]; px[i + 1] = rgba[1]; px[i + 2] = rgba[2]; px[i + 3] = 255;
          }
        }
        for (let y = y0; y < y1; y++) {
          for (const x of [x0 + t, x1 - 1 - t]) {
            if (y < 0 || y >= hh || x < 0 || x >= ww) continue;
            const i = (y * ww + x) * 4;
            px[i] = rgba[0]; px[i + 1] = rgba[1]; px[i + 2] = rgba[2]; px[i + 3] = 255;
          }
        }
      }
    };
    for (const f of fields) {
      const b = f.source?.cellBBox || f.source?.valueBBoxes?.[0];
      if (!b) continue;
      // Orange for every extracted/inked cell (matches UI overlay)
      const color = f.value ? [180, 83, 9, 255] : [180, 83, 9, 200];
      stroke(Math.round(b.x0), Math.round(b.y0), Math.round(b.x1), Math.round(b.y1), color, 3);
    }
    await sharp(px, { raw: { width: ww, height: hh, channels: 4 } })
      .png()
      .toFile(path.join(debugDir, 'grid-overlay.png'));
    fs.writeFileSync(
      path.join(debugDir, 'grid-meta.json'),
      JSON.stringify(
        {
          angle,
          width,
          height,
          rowLines,
          vLines,
          leftCols: left,
          rightCols: right,
          boxes: boxes.length,
          expectedSlots,
          handwrittenCells,
          ocrFilled,
          plausible,
          skipHeaderBand: useSkip,
          slotSchema: slotLayout?.schema || null,
          indexedShots: shotBands.size,
        },
        null,
        2
      )
    );
  }

  const visionInfo = await probeVision();
  return {
    fields,
    meta: {
      angle,
      deskewedWidth: width,
      deskewedHeight: height,
      rowCount: Math.max(0, rowLines.length - 1),
      cellSlots: boxes.length,
      expectedSlots,
      handwrittenCells,
      ocrFilled,
      plausible,
      skipHeaderBand: useSkip,
      indexedShots: shotBands.size,
      slotSchema: slotLayout?.schema || null,
      leftCols: left,
      rightCols: right,
      deskewedPath: workPath,
      handwritingStack: {
        tesseract: true,
        vision: visionInfo,
        mode: visionMode(),
      },
    },
  };
}

module.exports = {
  extractGridFields,
  deskewImage,
};
