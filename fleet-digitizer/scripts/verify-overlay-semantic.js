/**
 * Verify: (1) deskewed cell ROIs for overlay count (2) date-typed vision bias
 * Usage: node scripts/verify-overlay-semantic.js
 */
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });
process.env.OLLAMA_NUM_GPU = process.env.OLLAMA_NUM_GPU || '0';

const { rasterizeDocument } = require('../src/services/pdf');
const { listTemplates } = require('../src/services/templates');
const { extractGridFields } = require('../src/services/formGrid');
const { readCellVision, probeVision } = require('../src/services/visionOcr');
const { isPlausibleForType, normalizeOcrRaw } = require('../src/services/semanticDecode');

async function main() {
  const scan = path.resolve(__dirname, '..', '..', 'ScannedDocs', 'filled out form 1.pdf');
  const workDir = path.join(__dirname, '..', 'data', 'uploads', 'verify-overlay');
  fs.mkdirSync(workDir, { recursive: true });

  const pages = await rasterizeDocument(scan, workDir, { scale: 3 });
  const templates = await listTemplates();
  const tpl =
    templates.find((t) => t.name.toLowerCase().includes('shuttle') && t.type === 'xlsx') ||
    templates.find((t) => t.type === 'xlsx');
  const detect = await extractGridFields(pages[0].path, {
    debugDir: path.join(workDir, 'grid-debug'),
    template: tpl,
    detectOnly: true,
  });

  const withBoxes = detect.fields.filter(
    (f) => f.source?.cellBBox || f.source?.valueBBoxes?.length
  );
  const inked = detect.fields.filter((f) => f.source?.hasInk);
  console.log(
    JSON.stringify(
      {
        cellSlots: detect.meta.cellSlots,
        inked: inked.length,
        overlayCandidateBoxes: withBoxes.length,
        angle: detect.meta.angle,
        deskewed: {
          w: detect.meta.deskewedWidth,
          h: detect.meta.deskewedHeight,
          path: detect.meta.deskewedPath,
        },
        sampleCell: withBoxes[0]?.source?.cellBBox,
      },
      null,
      2
    )
  );

  // Draw orange overlay on deskewed page for every inked cell ROI
  const deskew = detect.meta.deskewedPath;
  const { data, info } = await sharp(deskew).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const px = data;
  const stroke = (x0, y0, x1, y1) => {
    const rgba = [180, 83, 9, 255];
    for (let x = x0; x < x1; x++) {
      for (const y of [y0, y1 - 1]) {
        if (y < 0 || y >= info.height || x < 0 || x >= info.width) continue;
        const i = (y * info.width + x) * 4;
        px[i] = rgba[0]; px[i + 1] = rgba[1]; px[i + 2] = rgba[2]; px[i + 3] = 255;
      }
    }
    for (let y = y0; y < y1; y++) {
      for (const x of [x0, x1 - 1]) {
        if (y < 0 || y >= info.height || x < 0 || x >= info.width) continue;
        const i = (y * info.width + x) * 4;
        px[i] = rgba[0]; px[i + 1] = rgba[1]; px[i + 2] = rgba[2]; px[i + 3] = 255;
      }
    }
  };
  for (const f of inked) {
    const b = f.source.cellBBox || f.source.valueBBoxes?.[0];
    if (!b) continue;
    stroke(Math.round(b.x0), Math.round(b.y0), Math.round(b.x1), Math.round(b.y1));
  }
  const overlayOut = path.join(workDir, 'orange-all-cells.png');
  await sharp(px, { raw: { width: info.width, height: info.height, channels: 4 } })
    .png()
    .toFile(overlayOut);

  // Date-typed vision on a header crop (approximate Date field on Shuttle form)
  const probe = await probeVision();
  let dateResult = { skipped: true, reason: probe.reason };
  if (probe.available) {
    // Heuristic crop near top-right of header (Date sits right of Catapult area)
    const w = info.width;
    const h = info.height;
    const dateBox = {
      x0: Math.floor(w * 0.42),
      y0: Math.floor(h * 0.14),
      x1: Math.floor(w * 0.58),
      y1: Math.floor(h * 0.2),
    };
    const r = await readCellVision(deskew, dateBox, { hasInk: true, pageWidth: w, pageHeight: h }, {
      fieldType: 'date',
      label: 'Date',
      id: 'date',
    });
    const forceBiased = await readCellVision(deskew, dateBox, { hasInk: true, pageWidth: w, pageHeight: h }, {
      fieldType: 'force_lb',
      label: 'FWD (lb)',
      id: 'fwd_1',
    });
    dateResult = {
      dateTyped: {
        text: r.text,
        confidence: r.confidence,
        method: r.method,
        plausible: isPlausibleForType('date', r.text),
        normalized: normalizeOcrRaw('date', r.text || r.raw || ''),
      },
      forceTypedSameCrop: {
        text: forceBiased.text,
        confidence: forceBiased.confidence,
        method: forceBiased.method,
      },
      note: 'Same crop with date vs force_lb prompts — date bias should prefer date-like output',
    };
  }

  const summary = {
    overlayPng: overlayOut,
    inkedBoxesDrawn: inked.length,
    dateResult,
  };
  console.log(JSON.stringify(summary, null, 2));
  fs.writeFileSync(path.join(workDir, 'verify.json'), JSON.stringify({ detect: detect.meta, summary }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
