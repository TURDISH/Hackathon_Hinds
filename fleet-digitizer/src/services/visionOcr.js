/**
 * Local vision-LLM handwriting reader via Ollama multimodal models.
 * Biased by template schema fieldType/label — NOT the same as template-schema text chat.
 */
const sharp = require('sharp');
const { isPlausibleForce } = require('./digitOcr');
const {
  ocrGuidance,
  normalizeOcrRaw,
  isPlausibleForType,
} = require('./semanticDecode');

function visionEnabled() {
  const v = (process.env.VISION_OCR_ENABLED || 'true').toLowerCase();
  return v !== '0' && v !== 'false' && v !== 'off';
}

function visionModel() {
  return process.env.VISION_OCR_MODEL || process.env.TEMPLATE_AI_MODEL || 'gemma4:e2b';
}

function visionMode() {
  // batch (default, fast) | primary | hybrid | off
  return (process.env.VISION_OCR_MODE || 'batch').toLowerCase();
}

function batchRows() {
  // Default ~9-row multi-role bands (pre–MTD-15 “larger column” experiment): ~6 calls/form
  return Math.max(4, Math.min(27, Number(process.env.VISION_BATCH_ROWS || 9)));
}

function baseUrl() {
  return (process.env.TEMPLATE_AI_BASE_URL || 'http://127.0.0.1:11434').replace(/\/$/, '');
}

function timeoutMs() {
  return Number(process.env.VISION_OCR_TIMEOUT_MS || 45000);
}

function batchTimeoutMs() {
  return Number(process.env.VISION_BATCH_TIMEOUT_MS || 180000);
}

let _probe = null;
async function probeVision() {
  if (_probe && Date.now() - _probe.at < 30000) return _probe;
  // Enabled flag only — VISION_OCR_MODE=off is honored by formGrid callers;
  // header typed refine may still call readCellVision explicitly.
  if (!visionEnabled()) {
    _probe = { available: false, reason: 'disabled', at: Date.now() };
    return _probe;
  }
  try {
    const res = await fetch(`${baseUrl()}/api/tags`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) {
      _probe = { available: false, reason: `http_${res.status}`, at: Date.now() };
      return _probe;
    }
    const data = await res.json();
    const names = (data.models || []).map((m) => m.name);
    const want = visionModel();
    const hit = names.find((n) => n === want || n.startsWith(`${want}:`) || want.startsWith(n.split(':')[0]));
    const installed = names.some((n) => n === want || n.startsWith(want.split(':')[0]));
    _probe = {
      available: Boolean(hit || installed),
      reason: hit || installed ? 'ollama_vision' : 'model_missing',
      model: want,
      installed: names,
      at: Date.now(),
    };
    return _probe;
  } catch (err) {
    _probe = { available: false, reason: err.message || 'unreachable', at: Date.now() };
    return _probe;
  }
}

async function cropCellPngBase64(imagePath, box, inkInfo) {
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
      left = Math.max(0, inkInfo.L + minx - 4);
      right = inkInfo.L + maxx + 5;
      top = Math.max(0, inkInfo.T + miny - 4);
      bottom = inkInfo.T + maxy + 5;
    }
  }

  const w = Math.max(8, right - left);
  const h = Math.max(8, bottom - top);
  const buf = await sharp(imagePath)
    .extract({ left, top, width: w, height: h })
    .resize({
      width: Math.max(120, w * 3),
      height: Math.max(80, h * 3),
      fit: 'fill',
      kernel: sharp.kernel.lanczos3,
    })
    .normalize()
    .sharpen()
    .png()
    .toBuffer();
  return {
    b64: buf.toString('base64'),
    bbox: { x0: left, y0: top, x1: left + w, y1: top + h },
  };
}

/**
 * @param {object} [fieldHint] - { fieldType, label, id } from template schema
 */
async function readCellVision(imagePath, box, inkInfo, fieldHint = {}) {
  const probe = await probeVision();
  if (!probe.available) {
    return { text: '', confidence: 0, method: 'vision_unavailable', reason: probe.reason };
  }

  const fieldType = fieldHint.fieldType || 'force_lb';
  const label = fieldHint.label || fieldHint.id || fieldType;
  const guide = ocrGuidance(fieldType, label);
  const { b64, bbox } = await cropCellPngBase64(imagePath, box, inkInfo);

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs());
  try {
    const res = await fetch(`${baseUrl()}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: ctrl.signal,
      body: JSON.stringify({
        model: visionModel(),
        stream: false,
        format: 'json',
        think: false,
        messages: [
          {
            role: 'user',
            content: guide.visionPrompt,
            images: [b64],
          },
        ],
      }),
    });
    if (!res.ok) {
      return { text: '', confidence: 0, method: 'vision_http', reason: `http_${res.status}`, bbox };
    }
    const data = await res.json();
    const content = data?.message?.content || '';
    let parsed = null;
    try {
      const start = content.indexOf('{');
      const end = content.lastIndexOf('}');
      if (start >= 0 && end > start) parsed = JSON.parse(content.slice(start, end + 1));
    } catch {
      parsed = null;
    }
    const rawVal = parsed?.value != null ? String(parsed.value) : content;
    const normalized = normalizeOcrRaw(fieldType, rawVal);
    const text = normalized.value || '';
    let confidence = 0;
    if (typeof parsed?.confidence === 'number') {
      confidence = Math.max(0, Math.min(100, parsed.confidence * 100));
    } else if (text) {
      confidence = isPlausibleForType(fieldType, text) ? 72 : 45;
    }
    confidence = Math.max(0, Math.min(100, confidence + (normalized.confidenceBoost || 0)));
    if (text && isPlausibleForType(fieldType, text)) confidence = Math.max(confidence, 68);
    if (text && !isPlausibleForType(fieldType, text)) confidence = Math.min(confidence || 40, 48);

    return {
      text,
      confidence,
      method: `vision_${visionModel()}_${fieldType}`,
      bbox,
      raw: content.slice(0, 200),
      fieldType,
      semantic: normalized.note,
    };
  } catch (err) {
    return {
      text: '',
      confidence: 0,
      method: 'vision_error',
      reason: err.message || 'failed',
      bbox,
      fieldType,
    };
  } finally {
    clearTimeout(t);
  }
}

/** Back-compat: force/load cells */
async function readForceCellVision(imagePath, box, inkInfo) {
  const r = await readCellVision(imagePath, box, inkInfo, {
    fieldType: 'force_lb',
    label: 'FWD/AFT (lb)',
  });
  // Keep force snap semantics for callers that check isPlausibleForce on .text
  if (r.text && !isPlausibleForce(r.text) && fieldLooksNumeric(r.raw)) {
    /* already normalized via decodeForceLb */
  }
  return r;
}

function fieldLooksNumeric(raw) {
  return /\d/.test(String(raw || ''));
}

/**
 * Crop a multi-row FWD/AFT band and read all force cells in one vision call.
 * Default path: ~9-row multi-role bands (not full-side / per-column mega-crops).
 * @param {object[]} slots - [{ id, shot, role: 'fwd'|'aft', box }]
 */
async function readForceBandVision(imagePath, slots, { pageWidth, pageHeight, sideLabel = 'table' } = {}) {
  const out = new Map();
  const probe = await probeVision();
  if (!probe.available || !slots?.length) return out;

  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const s of slots) {
    const b = s.box;
    x0 = Math.min(x0, b.x0);
    y0 = Math.min(y0, b.y0);
    x1 = Math.max(x1, b.x1);
    y1 = Math.max(y1, b.y1);
  }
  const pad = 6;
  const left = Math.max(0, Math.floor(x0 - pad));
  const top = Math.max(0, Math.floor(y0 - pad));
  const width = Math.max(8, Math.min(pageWidth || 1e9, Math.ceil(x1 + pad)) - left);
  const height = Math.max(8, Math.min(pageHeight || 1e9, Math.ceil(y1 + pad)) - top);

  const shots = [...new Set(slots.map((s) => s.shot))].sort((a, b) => a - b);
  const roles = [...new Set(slots.map((s) => s.role))];
  const buf = await sharp(imagePath)
    .extract({ left, top, width, height })
    .resize({
      width: Math.min(1400, Math.max(480, width * 2)),
      height: Math.min(1800, Math.max(320, height * 2)),
      fit: 'inside',
      kernel: sharp.kernel.lanczos3,
      withoutEnlargement: false,
    })
    .normalize()
    .sharpen()
    .png()
    .toBuffer();
  const b64 = buf.toString('base64');

  const prompt =
    `This image is a cropped band of a handwritten numeric form table (${sideLabel}). ` +
    `Columns are handwritten FORCE/LOAD values (lb) for roles: ${roles.join(', ').toUpperCase()}. ` +
    `Row shot numbers in order: ${shots.join(', ')}. ` +
    'Read ONLY handwritten digits in each value cell (typically 3–4 digits, roughly 500–2500). ' +
    'Never invent placeholder sequences (1234, 1111, 0000). Use "" if blank/unreadable. ' +
    'Reply with JSON only: {"rows":[{"shot":1,"fwd":"1400","aft":"1400"},...]} ' +
    'Include every listed shot. No markdown.';

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), batchTimeoutMs());
  try {
    const res = await fetch(`${baseUrl()}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: ctrl.signal,
      body: JSON.stringify({
        model: visionModel(),
        stream: false,
        format: 'json',
        think: false,
        messages: [{ role: 'user', content: prompt, images: [b64] }],
      }),
    });
    if (!res.ok) return out;
    const data = await res.json();
    const content = data?.message?.content || '';
    let parsed = null;
    try {
      const start = content.indexOf('{');
      const end = content.lastIndexOf('}');
      if (start >= 0 && end > start) parsed = JSON.parse(content.slice(start, end + 1));
    } catch {
      parsed = null;
    }
    const rows = Array.isArray(parsed?.rows) ? parsed.rows : [];
    const byShot = new Map();
    for (const row of rows) {
      const shot = Number(row.shot ?? row.Shot ?? row.index);
      if (!Number.isFinite(shot)) continue;
      byShot.set(shot, row);
    }

    for (const slot of slots) {
      const row = byShot.get(Number(slot.shot));
      if (!row) continue;
      const raw =
        row[slot.role] ??
        row[slot.role.toUpperCase()] ??
        row[`${slot.role}_lb`] ??
        row[slot.role === 'fwd' ? 'FWD' : 'AFT'];
      if (raw == null || raw === '') continue;
      const normalized = normalizeOcrRaw('force_lb', String(raw));
      const text = normalized.value || '';
      if (!text) continue;
      let confidence = isPlausibleForType('force_lb', text) ? 74 : 46;
      confidence = Math.max(0, Math.min(100, confidence + (normalized.confidenceBoost || 0)));
      out.set(slot.id, {
        text,
        confidence,
        method: `vision_batch_${visionModel()}`,
        bbox: slot.box,
        fieldType: 'force_lb',
        semantic: normalized.note,
        band: sideLabel,
      });
    }
    return out;
  } catch {
    return out;
  } finally {
    clearTimeout(t);
  }
}

/**
 * Split measurement boxes into left/right row bands (~9 rows) — few vision calls.
 */
async function readMeasurementGridBatch(imagePath, boxes, { pageWidth, pageHeight, onBand } = {}) {
  const filled = new Map();
  const probe = await probeVision();
  if (!probe.available) return filled;

  const slots = [];
  for (const box of boxes) {
    const m = String(box.id || '').match(/^(fwd|aft|inboard|outboard)_(\d+)$/i);
    if (!m) continue;
    slots.push({
      id: box.id,
      role: m[1].toLowerCase(),
      shot: Number(m[2]),
      box: {
        x0: box.x0,
        y0: box.y0,
        x1: box.x1,
        y1: box.y1,
      },
    });
  }
  if (!slots.length) return filled;

  const shots = [...new Set(slots.map((s) => s.shot))].sort((a, b) => a - b);
  let splitShot = null;
  for (let i = 0; i < shots.length - 1; i++) {
    if (shots[i + 1] - shots[i] >= 2 && shots[i] <= 30 && shots[i + 1] >= 20) {
      if (shots[i] === 27 && shots[i + 1] === 28) {
        splitShot = 27;
        break;
      }
      if (splitShot == null) splitShot = shots[i];
    }
  }
  const leftSlots = [];
  const rightSlots = [];
  if (splitShot != null) {
    for (const s of slots) (s.shot <= splitShot ? leftSlots : rightSlots).push(s);
  } else {
    const midX =
      slots.reduce((a, s) => a + (s.box.x0 + s.box.x1) / 2, 0) / Math.max(1, slots.length);
    for (const s of slots) {
      ((s.box.x0 + s.box.x1) / 2 <= midX ? leftSlots : rightSlots).push(s);
    }
  }

  const bandSize = batchRows();
  async function runSide(sideSlots, sideLabel) {
    if (!sideSlots.length) return;
    const shotList = [...new Set(sideSlots.map((s) => s.shot))].sort((a, b) => a - b);
    for (let i = 0; i < shotList.length; i += bandSize) {
      const bandShots = new Set(shotList.slice(i, i + bandSize));
      const band = sideSlots.filter((s) => bandShots.has(s.shot));
      if (typeof onBand === 'function') {
        onBand({
          side: sideLabel,
          shots: [...bandShots],
          index: Math.floor(i / bandSize) + 1,
          total: Math.ceil(shotList.length / bandSize),
        });
      }
      const part = await readForceBandVision(imagePath, band, {
        pageWidth,
        pageHeight,
        sideLabel: `${sideLabel} shots ${shotList[i]}-${shotList[Math.min(i + bandSize, shotList.length) - 1]}`,
      });
      for (const [k, v] of part) filled.set(k, v);
    }
  }

  await runSide(leftSlots, 'left');
  await runSide(rightSlots, 'right');
  return filled;
}

module.exports = {
  probeVision,
  readCellVision,
  readForceCellVision,
  readForceBandVision,
  readMeasurementGridBatch,
  visionEnabled,
  visionModel,
  visionMode,
  batchRows,
};
