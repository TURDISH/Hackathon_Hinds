const { normalize } = require('./templates');

/**
 * Score OCR text against each template using schema fingerprint /
 * titleHints / field aliases from the master template.
 */
function matchTemplates(ocr, templates) {
  const ocrNorm = normalize(ocr.text || '');
  const ocrTokens = new Set(ocrNorm.split(/\s+/).filter(Boolean));
  const strong = (ocr.words || [])
    .filter((w) => w.confidence >= 60)
    .map((w) => normalize(w.text))
    .filter(Boolean);
  const strongSet = new Set(strong.join(' ').split(/\s+/));

  const scored = templates.map((tpl) => {
    const reasons = [];
    let score = 0;

    for (const hint of tpl.titleHints || []) {
      const h = normalize(String(hint).replace(/_/g, ' '));
      if (!h) continue;
      if (ocrNorm.includes(h) || h.split(/\s+/).every((p) => ocrTokens.has(p) || strongSet.has(p))) {
        score += Math.min(20, 8 + h.length);
        reasons.push(`Matched schema title hint "${hint}"`);
      }
    }

    const fp = (tpl.fingerprint || []).map(normalize).filter((t) => t.length > 2);
    let hits = 0;
    for (const term of fp) {
      const parts = term.split(/\s+/);
      const ok = parts.every((p) => ocrTokens.has(p) || strongSet.has(p) || ocrNorm.includes(p));
      if (ok) hits += 1;
    }
    const overlap = fp.length ? hits / fp.length : 0;
    score += Math.round(overlap * 40);
    if (overlap > 0.2) reasons.push(`Label fingerprint overlap ${(overlap * 100).toFixed(0)}%`);

    const aliasMap = tpl.fieldAliases || {};
    let aliasHits = 0;
    for (const aliases of Object.values(aliasMap)) {
      if ((aliases || []).some((a) => a && ocrNorm.includes(a))) aliasHits += 1;
    }
    if (aliasHits) reasons.push(`Recognized ${aliasHits} schema field labels`);
    score += Math.min(aliasHits, 10);

    const nameNorm = normalize(tpl.name);
    for (const token of nameNorm.split(/\s+/)) {
      if (
        token.length >= 4 &&
        ocrNorm.includes(token) &&
        !['test', 'template', 'empty', 'wrong', 'form', 'docx', 'xlsx'].includes(token)
      ) {
        score += 4;
      }
    }

    if (tpl.schemaFailed || tpl.error) {
      score -= 20;
      reasons.push('Schema analysis incomplete (penalty)');
    }
    if (tpl.slotLayout?.measurementSlots > 0) {
      const roles = (tpl.slotLayout?.leftTable?.valueColumns || [])
        .concat(tpl.slotLayout?.rightTable?.valueColumns || [])
        .map((r) => normalize(String(r)));
      const roleHit = roles.some((r) => r && ocrNorm.includes(r));
      if (roleHit || /\b(fwd|aft|lb|force|load|elong)\b/i.test(ocrNorm)) {
        score += 8;
        reasons.push('Measurement-grid template vs OCR grid markers');
      }
    }

    return {
      templateId: tpl.id,
      name: tpl.name,
      type: tpl.type,
      score: Math.max(0, Math.min(100, score)),
      reasons,
      titleHints: tpl.titleHints,
      schemaCacheHit: tpl.schemaCacheHit,
    };
  });

  scored.sort((a, b) => b.score - a.score);
  return {
    best: scored[0] || null,
    candidates: scored,
  };
}

module.exports = { matchTemplates };
