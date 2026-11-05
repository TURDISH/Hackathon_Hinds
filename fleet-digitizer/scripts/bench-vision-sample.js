/**
 * Sample N inked measurement cells with vision-primary HTR (faster than full 108 on CPU).
 * Usage: node scripts/bench-vision-sample.js [limit=16]
 */
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });
process.env.VISION_OCR_MODE = process.env.VISION_OCR_MODE || 'primary';
process.env.OLLAMA_NUM_GPU = process.env.OLLAMA_NUM_GPU || '0';

const { rasterizeDocument } = require('../src/services/pdf');
const { listTemplates } = require('../src/services/templates');
const { extractGridFields } = require('../src/services/formGrid');
const { readForceCellVision, probeVision } = require('../src/services/visionOcr');
const { isPlausibleForce } = require('../src/services/digitOcr');

async function main() {
  const limit = Math.max(1, Number(process.argv[2] || 16));
  const scan = path.resolve(__dirname, '..', '..', 'ScannedDocs', 'filled out form 1.pdf');
  const workDir = path.join(__dirname, '..', 'data', 'uploads', 'bench-vision-sample');
  fs.mkdirSync(workDir, { recursive: true });

  const probe = await probeVision();
  console.log('probe', JSON.stringify(probe));
  if (!probe.available) throw new Error(`vision unavailable: ${probe.reason}`);

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

  const inked = detect.fields.filter((f) => f.source?.hasInk);
  const sample = inked.slice(0, limit);
  console.log(
    JSON.stringify(
      {
        cellSlots: detect.meta.cellSlots,
        handwrittenCells: detect.meta.handwrittenCells,
        sampleSize: sample.length,
        leftCols: detect.meta.leftCols,
        rightCols: detect.meta.rightCols,
      },
      null,
      2
    )
  );

  const concurrency = Math.max(1, Number(process.env.VISION_OCR_CONCURRENCY || 2));
  const results = [];
  let cursor = 0;
  async function worker() {
    while (cursor < sample.length) {
      const i = cursor;
      cursor += 1;
      const f = sample[i];
      const box = f.source.valueBBoxes?.[0] || null;
      if (!box) {
        results[i] = { id: f.id, text: '', confidence: 0, method: 'no_box' };
        continue;
      }
      const t0 = Date.now();
      const ink = {
        hasInk: true,
        inkRatio: f.source.inkRatio,
        pageWidth: 1836,
        pageHeight: 3000,
      };
      const r = await readForceCellVision(pages[0].path, box, ink);
      results[i] = {
        id: f.id,
        ms: Date.now() - t0,
        text: r.text || '',
        confidence: r.confidence || 0,
        method: r.method,
        plausible: isPlausibleForce(r.text || ''),
        lowConfidence: !r.text || (r.confidence || 0) < 70,
        reason: r.reason,
      };
      console.log(
        `[${i + 1}/${sample.length}] ${f.id} → ${results[i].text || '(empty)'} conf=${results[i].confidence} ${results[i].ms}ms`
      );
    }
  }
  const t0 = Date.now();
  await Promise.all(Array.from({ length: Math.min(concurrency, sample.length) }, () => worker()));
  const filled = results.filter((r) => r.text).length;
  const plausible = results.filter((r) => r.plausible).length;
  const low = results.filter((r) => r.lowConfidence).length;
  const out = {
    ms: Date.now() - t0,
    mode: 'primary',
    model: probe.model,
    detect: {
      cellSlots: detect.meta.cellSlots,
      handwrittenCells: detect.meta.handwrittenCells,
      expectedSlots: detect.meta.expectedSlots,
    },
    sample: {
      n: sample.length,
      filled,
      plausible,
      lowConfidence: low,
      avgMs: Math.round(results.reduce((s, r) => s + (r.ms || 0), 0) / Math.max(1, results.length)),
    },
    results,
  };
  console.log(JSON.stringify({ ...out, results: undefined }, null, 2));
  fs.writeFileSync(path.join(workDir, 'sample.json'), JSON.stringify(out, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
