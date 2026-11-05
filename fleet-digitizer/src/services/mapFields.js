const { normalize, aliasesFromSchema } = require('./templates');
const config = require('../config');
const { applySemanticDecode, resolveFieldType } = require('./semanticDecode');

/**
 * Bind OCR tokens to template fields by schema aliases + nearby context.
 */

function findLabelWord(words, aliases) {
  const hits = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const n = normalize(w.text);
    for (const alias of aliases) {
      const aliasParts = String(alias).split(/\s+/).filter(Boolean);
      if (!aliasParts.length) continue;
      const window = words
        .slice(i, i + aliasParts.length)
        .map((x) => normalize(x.text))
        .join(' ');
      if (window === alias || n === alias || (alias.length > 3 && window.includes(alias))) {
        hits.push({ index: i, word: w, alias, span: aliasParts.length });
      }
    }
  }
  return hits;
}

function looksLikeLabel(text, aliasMap) {
  const n = normalize(text);
  if (/:$/.test(text)) return true;
  for (const aliases of Object.values(aliasMap || {})) {
    if (aliases.some((a) => a === n || (a.length > 3 && n.includes(a)))) return true;
  }
  return false;
}

function tokensRightOf(words, labelHit, aliasMap, { maxDx = 220, maxDy = 22, limit = 4 } = {}) {
  const lb = labelHit.word.bbox;
  const labelRight = words[labelHit.index + labelHit.span - 1]?.bbox?.x1 ?? lb.x1;
  const midY = (lb.y0 + lb.y1) / 2;

  const ordered = words
    .map((w, index) => ({ w, index }))
    .filter(({ w, index }) => {
      if (index <= labelHit.index + labelHit.span - 1) return false;
      const bx = w.bbox;
      const cy = (bx.y0 + bx.y1) / 2;
      if (Math.abs(cy - midY) > maxDy) return false;
      if (bx.x0 < labelRight - 4) return false;
      if (bx.x0 - labelRight > maxDx) return false;
      return true;
    })
    .sort((a, b) => a.w.bbox.x0 - b.w.bbox.x0);

  const collected = [];
  for (const item of ordered) {
    if (looksLikeLabel(item.w.text, aliasMap)) break;
    collected.push(item.w);
    if (collected.length >= limit) break;
  }
  return collected;
}

function cleanValue(tokens, fieldType) {
  const raw = tokens.map((t) => t.text).join(' ').replace(/\s+/g, ' ').trim();
  const conf = tokens.length
    ? tokens.reduce((s, t) => s + t.confidence, 0) / tokens.length
    : 0;

  let value = raw.replace(/^[:\-–—]+\s*/, '');

  if (fieldType === 'date') {
    const m = value.match(/(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}|\d{1,2}\s*[A-Za-z]{3}\s*\d{2,4})/);
    if (m) value = m[1].replace(/\s+/g, '');
  }
  if (fieldType === 'small_int' || fieldType === 'id_code') {
    const m = value.match(/[A-Za-z0-9\-]+/);
    if (m) value = m[0];
  }

  return { value: value.trim(), confidence: conf, tokens };
}

function resolveAliasMap(template) {
  if (template?.fieldAliases && Object.keys(template.fieldAliases).length) {
    return template.fieldAliases;
  }
  if (template?.schema || template?.fields) {
    return aliasesFromSchema(template.schema || template);
  }
  return {};
}

function extractHeaderFields(words, template) {
  const fields = [];
  const aliasMap = resolveAliasMap(template);
  const schemaById = new Map((template?.fields || []).map((f) => [f.id, f]));

  for (const [fieldId, aliases] of Object.entries(aliasMap)) {
    const schemaField = schemaById.get(fieldId);
    if (schemaField?.kind === 'measurement') continue;

    const hits = findLabelWord(words, aliases);
    if (!hits.length) continue;
    hits.sort((a, b) => b.word.confidence - a.word.confidence);
    const hit = hits[0];
    const fieldType = resolveFieldType(schemaField || { id: fieldId });
    const valueTokens = tokensRightOf(words, hit, aliasMap);
    const { value, confidence, tokens } = cleanValue(valueTokens, fieldType);

    const kind = schemaField?.kind
      || (['date', 'small_int', 'id_code'].includes(fieldType) ? 'header' : 'signature_or_meta');

    let field = {
      id: fieldId,
      label: schemaField?.label || hit.word.text || fieldId,
      fieldType,
      kind,
      value,
      confidence: Number(confidence.toFixed(1)),
      source: {
        method: 'semantic_label_proximity',
        labelText: hit.word.text,
        labelConfidence: hit.word.confidence,
        labelBBox: hit.word.bbox,
        valueBBoxes: tokens.map((t) => t.bbox),
        schemaDriven: true,
      },
    };
    field = applySemanticDecode(field);
    field.lowConfidence = field.confidence < config.confidenceThreshold || !field.value;
    field.needsReview = field.lowConfidence;
    fields.push(field);
  }

  return fields;
}

function isMeasurementId(id, schemaFields) {
  const sf = schemaFields?.find((f) => f.id === id);
  if (sf?.kind === 'measurement' || sf?.fieldType === 'force_lb') return true;
  return /^(fwd|aft|inboard|outboard|force_\d+)_\d+$/i.test(id);
}

function mapFields(ocr, template, gridResult = null) {
  const words = ocr.words || [];
  const header = extractHeaderFields(words, template);
  const measurements = gridResult?.fields || [];

  const byId = new Map();
  for (const f of [...header, ...measurements]) {
    if (!byId.has(f.id) || (f.value && !byId.get(f.id).value)) {
      byId.set(f.id, f);
    }
  }

  if (template?.fields) {
    for (const tf of template.fields) {
      if (!byId.has(tf.id)) {
        byId.set(tf.id, {
          id: tf.id,
          label: tf.label,
          fieldType: tf.fieldType,
          kind: tf.kind,
          value: '',
          confidence: 0,
          lowConfidence: true,
          source: { method: 'missing', note: 'No value bound from OCR/grid' },
          needsReview: true,
        });
      }
    }
  }

  let fields = [...byId.values()].map((f) => {
    if (f.source?.method === 'grid_cell_ocr' || f.source?.templateSlot) return f;
    const schemaField = template?.fields?.find((tf) => tf.id === f.id);
    const decoded = applySemanticDecode({
      ...f,
      fieldType: f.fieldType || schemaField?.fieldType || resolveFieldType(f),
      kind: f.kind || schemaField?.kind,
    });
    decoded.lowConfidence =
      !decoded.value || decoded.confidence < config.confidenceThreshold;
    decoded.needsReview = decoded.lowConfidence;
    return decoded;
  });

  const lowCount = fields.filter((f) => f.lowConfidence || f.needsReview).length;
  const meas = fields.filter((f) => isMeasurementId(f.id, template?.fields));
  const plausible = meas.filter((f) => {
    const n = Number(f.value);
    return /^\d{3,4}$/.test(f.value || '') && n >= 500 && n <= 3000;
  }).length;
  return {
    fields,
    threshold: config.confidenceThreshold,
    lowConfidenceCount: lowCount,
    stats: {
      total: fields.length,
      filled: fields.filter((f) => f.value).length,
      lowConfidence: fields.filter((f) => f.confidence > 0 && f.confidence < config.confidenceThreshold).length,
      measurementSlots: meas.length,
      measurementFilled: meas.filter((f) => f.value).length,
      measurementPlausible: plausible,
      expectedSlots: template?.slotLayout?.expectedHandwrittenDataCells
        ?? gridResult?.meta?.expectedSlots
        ?? null,
      handwrittenCells: gridResult?.meta?.handwrittenCells ?? null,
      gridOcrFilled: gridResult?.meta?.ocrFilled ?? null,
      schemaDriven: Boolean(template?.schema || template?.fieldAliases),
    },
  };
}

module.exports = { mapFields, extractHeaderFields, resolveAliasMap };
