/**
 * Template-driven semantic decoding: bias raw OCR toward the field type
 * declared by the master template schema (date, force_lb, id_code, name, etc.).
 * Prefer schema.fieldType; otherwise generic id/label patterns only.
 */

const MONTHS = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
  january: '01', february: '02', march: '03', april: '04', june: '06',
  july: '07', august: '08', september: '09', october: '10', november: '11', december: '12',
};

/**
 * Resolve field type from schema field object first, then generic id patterns.
 */
function resolveFieldType(fieldOrId, kind) {
  if (fieldOrId && typeof fieldOrId === 'object') {
    if (fieldOrId.fieldType) return fieldOrId.fieldType;
    if (fieldOrId.kind === 'measurement') return 'force_lb';
    return resolveFieldType(fieldOrId.id, fieldOrId.kind || kind);
  }
  const fieldId = String(fieldOrId || '');
  if (kind === 'measurement') return 'force_lb';
  if (/^(fwd|aft|inboard|outboard|force_\d+)_\d+$/i.test(fieldId)) return 'force_lb';
  if (/date/i.test(fieldId)) return 'date';
  if (/jsn|periodicity|serial|code/i.test(fieldId)) return 'id_code';
  if (/shot|catapult|insp|qty|count|number|no$/i.test(fieldId)) return 'small_int';
  if (/cdi|chief|inspector|officer|name|sign|initial/i.test(fieldId)) return 'name_or_initials';
  return 'text';
}

function decodeDate(raw) {
  const s = String(raw || '').trim();
  if (!s) return { value: '', confidenceBoost: 0, note: 'empty' };

  // 3SEP26 / 3-SEP-26 / 03 Sep 2026
  let m = s.match(/(\d{1,2})\s*[-/]?\s*([A-Za-z]{3,9})\s*[-/]?\s*(\d{2,4})/);
  if (m) {
    const dd = m[1].padStart(2, '0');
    const mon = MONTHS[m[2].toLowerCase()];
    if (mon) {
      let yy = m[3];
      if (yy.length === 2) yy = `20${yy}`;
      return { value: `${dd}/${mon}/${yy}`, confidenceBoost: 25, note: 'day_mon_year' };
    }
  }

  // 9/3/26 or 09-03-2026
  m = s.match(/(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})/);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    let yy = m[3];
    if (yy.length === 2) yy = `20${yy}`;
    // Prefer D/M/Y when first > 12; else keep as written (US often M/D/Y)
    if (a > 12 && b <= 12) {
      return {
        value: `${String(a).padStart(2, '0')}/${String(b).padStart(2, '0')}/${yy}`,
        confidenceBoost: 20,
        note: 'numeric_dmy',
      };
    }
    return {
      value: `${String(a).padStart(2, '0')}/${String(b).padStart(2, '0')}/${yy}`,
      confidenceBoost: 15,
      note: 'numeric_date',
    };
  }

  // OCR garbage that still has digit+letter patterns — keep digits/letters only
  const cleaned = s.replace(/[^A-Za-z0-9\/\-]/g, '');
  if (/^\d{1,2}[A-Za-z]{3}\d{2,4}$/.test(cleaned)) {
    return decodeDate(cleaned.replace(/([A-Za-z]{3})/, '-$1-'));
  }

  // Fuzzy month recovery for noisy handwriting OCR (e.g. "FselZ6" ≈ "3SEP26")
  const fuzzy = cleaned.toLowerCase();
  const monthHints = [
    ['jan', '01'], ['feb', '02'], ['mar', '03'], ['apr', '04'], ['may', '05'], ['jun', '06'],
    ['jul', '07'], ['aug', '08'], ['sep', '09'], ['oct', '10'], ['nov', '11'], ['dec', '12'],
    ['sel', '09'], ['sep', '09'], ['5ep', '09'], ['s3p', '09'],
  ];
  for (const [hint, mon] of monthHints) {
    const idx = fuzzy.indexOf(hint);
    if (idx < 0) continue;
    const before = fuzzy.slice(0, idx).replace(/\D/g, '');
    const after = fuzzy.slice(idx + hint.length).replace(/\D/g, '');
    const dd = (before.slice(-2) || before || '1').padStart(2, '0');
    let yy = after.slice(0, 4);
    if (yy.length === 1) yy = '';
    if (yy.length === 2) yy = `20${yy}`;
    if (yy.length === 3) yy = `2${yy}`;
    if (yy.length === 4) {
      return {
        value: `${dd}/${mon}/${yy}`,
        confidenceBoost: 10,
        note: 'fuzzy_month_date',
      };
    }
  }

  return { value: cleaned, confidenceBoost: -15, note: 'unparsed_date' };
}

function decodeSmallInt(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (!digits) return { value: '', confidenceBoost: 0 };
  // Catapult / shot numbers are typically 1–3 digits
  const v = digits.length > 3 ? digits.slice(-3) : digits;
  const n = Number(v);
  const ok = n >= 0 && n <= 999;
  return { value: String(n), confidenceBoost: ok ? 20 : -10, note: 'small_int' };
}

function decodeIdCode(raw) {
  const v = String(raw || '')
    .toUpperCase()
    .replace(/[^A-Z0-9\-]/g, '');
  if (!v) return { value: '', confidenceBoost: 0 };
  return {
    value: v.slice(0, 16),
    confidenceBoost: /^[A-Z0-9\-]{2,}$/.test(v) ? 15 : -10,
    note: 'id_code',
  };
}

function decodeNameOrInitials(raw) {
  let v = String(raw || '').trim();
  // Prefer letter runs / dotted initials
  v = v.replace(/[^A-Za-z.\s\-']/g, '').replace(/\s+/g, ' ').trim();
  if (!v) return { value: '', confidenceBoost: 0 };
  // Single junk letter from grid noise → empty
  if (v.length === 1 && !/[A-Z]/i.test(v)) {
    return { value: '', confidenceBoost: -20 };
  }
  return {
    value: v.slice(0, 40),
    confidenceBoost: /[A-Za-z]{2,}/.test(v) || /^[A-Z](\.[A-Z])*\.?$/i.test(v) ? 15 : -5,
    note: 'name',
  };
}

function decodeForceLb(raw) {
  const { snapForcePrior, isPlausibleForce, isLikelyHallucinatedDigits } = require('./digitOcr');
  const snapped = snapForcePrior(raw);
  // 1–2 digit fragments are almost never force/load — keep for residual, don't boost
  if (snapped && String(snapped).length <= 2) {
    return { value: snapped, confidenceBoost: -25, note: 'force_too_short' };
  }
  if (snapped && isLikelyHallucinatedDigits(snapped)) {
    return { value: '', confidenceBoost: -40, note: 'force_hallucination' };
  }
  return {
    value: snapped,
    confidenceBoost: isPlausibleForce(snapped) ? 20 : snapped ? -10 : 0,
    note: 'force_lb',
  };
}

function decodeByType(fieldType, raw) {
  switch (fieldType) {
    case 'date':
      return decodeDate(raw);
    case 'small_int':
      return decodeSmallInt(raw);
    case 'id_code':
      return decodeIdCode(raw);
    case 'name_or_initials':
      return decodeNameOrInitials(raw);
    case 'force_lb':
      return decodeForceLb(raw);
    default:
      return { value: String(raw || '').trim(), confidenceBoost: 0, note: 'text' };
  }
}

function applySemanticDecode(field) {
  const fieldType = field.fieldType || resolveFieldType(field);
  const decoded = decodeByType(fieldType, field.value);
  const confidence = Math.max(
    0,
    Math.min(100, Number(field.confidence || 0) + (decoded.confidenceBoost || 0))
  );
  return {
    ...field,
    fieldType,
    value: decoded.value,
    confidence: Number(confidence.toFixed(1)),
    source: {
      ...(field.source || {}),
      semantic: decoded.note,
      rawValue: field.value,
    },
  };
}

/**
 * Schema-driven OCR guidance used WHILE reading a cell (vision prompt + Tesseract whitelist).
 */
function ocrGuidance(fieldType, label = '') {
  const type = fieldType || 'text';
  const lab = String(label || '').trim() || type;
  switch (type) {
    case 'date':
      return {
        fieldType: type,
        visionPrompt:
          `This image is a handwritten DATE field labeled "${lab}" on a maintenance form. ` +
          'Read the handwritten date only. Prefer day+month+year forms like 3SEP26, 03-SEP-2026, or 9/3/26. ' +
          'Reply JSON only: {"value":"3SEP26","confidence":0.0} (confidence 0..1). ' +
          'If blank/unreadable: {"value":"","confidence":0}.',
        tessWhitelist: '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz/-. ',
        expect: 'date',
      };
    case 'force_lb':
      return {
        fieldType: type,
        visionPrompt:
          `This image is a handwritten FORCE/LOAD (lb) cell labeled "${lab}". ` +
          'Read ONLY the handwritten digits actually visible (typically 3–4 digits, roughly 500–2500). ' +
          'Never invent placeholder sequences (e.g. 1234, 1111, 0000). If unsure or blank, return empty. ' +
          'Reply JSON only: {"value":"1400","confidence":0.0} (confidence 0..1). ' +
          'If blank/unreadable: {"value":"","confidence":0}.',
        tessWhitelist: '0123456789',
        expect: 'force_lb',
      };
    case 'small_int':
      return {
        fieldType: type,
        visionPrompt:
          `This image is a handwritten small integer field labeled "${lab}" (e.g. catapult/shot number). ` +
          'Read ONLY the handwritten digits (usually 1–3 digits). ' +
          'Reply JSON only: {"value":"3","confidence":0.0}. If blank: {"value":"","confidence":0}.',
        tessWhitelist: '0123456789',
        expect: 'small_int',
      };
    case 'id_code':
      return {
        fieldType: type,
        visionPrompt:
          `This image is a handwritten ID/code field labeled "${lab}". ` +
          'Read alphanumeric code characters (letters, digits, hyphens). ' +
          'Reply JSON only: {"value":"ABC-12","confidence":0.0}. If blank: {"value":"","confidence":0}.',
        tessWhitelist: '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-',
        expect: 'id_code',
      };
    case 'name_or_initials':
      return {
        fieldType: type,
        visionPrompt:
          `This image is a handwritten name or initials field labeled "${lab}". ` +
          'Read letters / dotted initials only (no digits unless part of the name). ' +
          'Reply JSON only: {"value":"J.S.","confidence":0.0}. If blank: {"value":"","confidence":0}.',
        tessWhitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz. '-",
        expect: 'name_or_initials',
      };
    default:
      return {
        fieldType: type,
        visionPrompt:
          `This image is a handwritten form field labeled "${lab}". ` +
          'Read the handwritten value only. Reply JSON only: {"value":"...","confidence":0.0}. ' +
          'If blank/unreadable: {"value":"","confidence":0}.',
        tessWhitelist: '',
        expect: 'text',
      };
  }
}

/** Normalize a raw OCR string using schema field type (during or after read). */
function normalizeOcrRaw(fieldType, raw) {
  return decodeByType(fieldType || 'text', raw);
}

/** Whether a candidate value looks plausible for this schema field type. */
function isPlausibleForType(fieldType, text) {
  if (!text) return false;
  const decoded = decodeByType(fieldType || 'text', text);
  if (!decoded.value) return false;
  if (fieldType === 'force_lb') {
    const { isPlausibleForce } = require('./digitOcr');
    return isPlausibleForce(decoded.value);
  }
  if (fieldType === 'date') {
    return decoded.note !== 'unparsed_date' && (decoded.confidenceBoost || 0) >= 10;
  }
  if (fieldType === 'small_int') {
    return /^\d{1,3}$/.test(decoded.value);
  }
  if (fieldType === 'id_code') {
    return /^[A-Z0-9\-]{2,}$/i.test(decoded.value);
  }
  if (fieldType === 'name_or_initials') {
    return /[A-Za-z]{1,}/.test(decoded.value);
  }
  return decoded.value.length > 0;
}

module.exports = {
  resolveFieldType,
  decodeByType,
  applySemanticDecode,
  decodeDate,
  decodeForceLb,
  ocrGuidance,
  normalizeOcrRaw,
  isPlausibleForType,
};
