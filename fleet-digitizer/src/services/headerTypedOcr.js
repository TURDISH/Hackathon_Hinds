/**
 * Re-read header fields with schema-typed vision/Tesseract using label proximity crops.
 * Runs AFTER page OCR mapping so date / small_int / id / name benefit from fieldType bias.
 */
const { createWorker } = require('tesseract.js');
const { readCellVision, probeVision } = require('./visionOcr');
const { readTypedCell } = require('./digitOcr');
const { isPlausibleForType, applySemanticDecode } = require('./semanticDecode');
const config = require('../config');

function valueBoxFromLabel(labelBBox, pageW, pageH, { maxDx = 280, padY = 6 } = {}) {
  if (!labelBBox) return null;
  const x0 = Math.max(0, Math.floor(labelBBox.x1 + 4));
  const x1 = Math.min(pageW, Math.floor(labelBBox.x1 + maxDx));
  const y0 = Math.max(0, Math.floor(labelBBox.y0 - padY));
  const y1 = Math.min(pageH, Math.ceil(labelBBox.y1 + padY));
  if (x1 - x0 < 12 || y1 - y0 < 8) return null;
  return { x0, y0, x1, y1 };
}

/**
 * @param {object[]} fields
 * @param {{ imagePath: string, pageWidth: number, pageHeight: number }} opts
 */
async function refineHeadersWithTypedOcr(fields, { imagePath, pageWidth, pageHeight }) {
  if (!imagePath || !fields?.length) return fields;

  const vision = await probeVision();
  const worker = await createWorker('eng');
  const out = [];

  try {
    for (const f of fields) {
      if (f.kind === 'measurement' || f.source?.templateSlot) {
        out.push(f);
        continue;
      }
      const fieldType = f.fieldType || 'text';
      if (!['date', 'small_int', 'id_code', 'name_or_initials'].includes(fieldType)) {
        out.push(f);
        continue;
      }

      // Already plausible from page OCR — keep bbox, skip expensive re-read
      if (f.value && isPlausibleForType(fieldType, f.value) && (f.confidence || 0) >= 55) {
        out.push({
          ...f,
          source: {
            ...(f.source || {}),
            cellBBox: f.source?.cellBBox || f.source?.valueBBoxes?.[0] || f.source?.labelBBox,
            valueBBoxes:
              f.source?.valueBBoxes?.length
                ? f.source.valueBBoxes
                : f.source?.labelBBox
                  ? [f.source.labelBBox]
                  : [],
            coordSpace: f.source?.coordSpace || 'page',
          },
        });
        continue;
      }

      const labelBox = f.source?.labelBBox;
      const existing = f.source?.valueBBoxes?.[0];
      const box =
        existing && existing.x1 > existing.x0
          ? existing
          : valueBoxFromLabel(labelBox, pageWidth, pageHeight);
      if (!box) {
        out.push(f);
        continue;
      }

      const ink = { hasInk: true, pageWidth, pageHeight };
      const hint = { fieldType, label: f.label, id: f.id };
      let visionRead = null;
      let tessRead = null;

      // Prefer cheap typed Tesseract first; vision only if still weak (CPU vision is slow)
      tessRead = await readTypedCell(worker, imagePath, box, ink, hint);
      const tessOk =
        tessRead?.text &&
        isPlausibleForType(fieldType, tessRead.text) &&
        (tessRead.confidence || 0) >= 55;
      if (!tessOk && vision.available) {
        visionRead = await readCellVision(imagePath, box, ink, hint);
      }

      const pick =
        visionRead?.text && isPlausibleForType(fieldType, visionRead.text)
          ? visionRead
          : tessRead?.text && isPlausibleForType(fieldType, tessRead.text)
            ? tessRead
            : visionRead?.text
              ? visionRead
              : tessRead?.text
                ? tessRead
                : null;

      if (!pick?.text) {
        // Keep prior page-OCR value if any
        out.push({
          ...f,
          source: {
            ...(f.source || {}),
            cellBBox: box,
            valueBBoxes: f.source?.valueBBoxes?.length ? f.source.valueBBoxes : [box],
            coordSpace: f.source?.coordSpace || 'page',
          },
        });
        continue;
      }

      // Prefer typed re-read when better/plausible; else keep existing if stronger
      const keepExisting =
        f.value &&
        isPlausibleForType(fieldType, f.value) &&
        (f.confidence || 0) >= (pick.confidence || 0) + 5;

      let next = {
        ...f,
        value: keepExisting ? f.value : pick.text,
        confidence: keepExisting ? f.confidence : pick.confidence,
        source: {
          ...(f.source || {}),
          method: keepExisting
            ? f.source?.method
            : pick.method || `typed_header_${fieldType}`,
          cellBBox: box,
          valueBBoxes: [box],
          priorValue: f.value,
          typedOcr: true,
          coordSpace: f.source?.coordSpace || 'page',
        },
      };
      next = applySemanticDecode(next);
      next.lowConfidence =
        !next.value || next.confidence < config.confidenceThreshold;
      next.needsReview = next.lowConfidence;
      out.push(next);
    }
  } finally {
    await worker.terminate();
  }

  return out;
}

module.exports = { refineHeadersWithTypedOcr, valueBoxFromLabel };
