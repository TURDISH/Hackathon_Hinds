/**
 * End-to-end form 1: upload path → finalize → count filled xlsx measurement cells.
 * Usage: node scripts/e2e-form1-fill.js
 */
const path = require('path');
const fs = require('fs');
const ExcelJS = require('exceljs');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

// Hard-clear so this script never inherits a leaked detect-only flag
delete process.env.GRID_DETECT_ONLY;
process.env.OLLAMA_NUM_GPU = process.env.OLLAMA_NUM_GPU || '0';
process.env.VISION_OCR_MODE = process.env.VISION_OCR_MODE || 'batch';

const { processUpload, finalizeJob } = require('../src/services/pipeline');

async function countXlsxData(outPath) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(outPath);
  const ws = wb.worksheets[0];
  let dateCells = 0;
  let forceLike = 0;
  let other = 0;
  const samples = [];
  ws.eachRow({ includeEmpty: false }, (row) => {
    row.eachCell({ includeEmpty: false }, (cell) => {
      const v = cell.value;
      if (v == null || v === '') return;
      const s = typeof v === 'object' && v.result != null ? String(v.result) : String(v);
      if (!s.trim()) return;
      // Template labels are long text — count short numeric / date-like values
      if (/^\d{3,4}$/.test(s.trim()) && Number(s) >= 500 && Number(s) <= 3000) {
        forceLike += 1;
        if (samples.length < 8) samples.push({ addr: cell.address, v: s });
      } else if (/^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(s.trim()) || /^\d{1,2}[A-Za-z]{3}\d{2,4}$/.test(s.trim())) {
        dateCells += 1;
        samples.push({ addr: cell.address, v: s, kind: 'date' });
      } else if (s.length <= 16 && !/trough|fwd|aft|catapult|date|shot|jsn|period|center|shuttle|hot|cold|cdi|inspector|chief|officer/i.test(s)) {
        other += 1;
      }
    });
  });
  return { forceLike, dateCells, other, samples };
}

async function main() {
  const scan = path.resolve(__dirname, '..', '..', 'ScannedDocs', 'filled out form 1.pdf');
  console.log('VISION_OCR_MODE', process.env.VISION_OCR_MODE);
  console.log('GRID_DETECT_ONLY', process.env.GRID_DETECT_ONLY || '(unset)');
  const t0 = Date.now();
  const job = await processUpload(scan, 'filled out form 1.pdf');
  const fields = job.fields || [];
  const meas = fields.filter((f) => f.kind === 'measurement');
  const measFilled = meas.filter((f) => f.value);
  const detectOnly = meas.filter((f) => f.source?.method === 'detect_only').length;
  console.log(
    JSON.stringify(
      {
        jobId: job.id,
        msToReview: Date.now() - t0,
        mappingStats: job.mappingStats,
        grid: {
          handwrittenCells: job.grid?.handwrittenCells,
          ocrFilled: job.grid?.ocrFilled,
          plausible: job.grid?.plausible,
          mode: job.grid?.handwritingStack?.mode,
        },
        measFilled: measFilled.length,
        detectOnlyMethods: detectOnly,
        date: fields.find((f) => f.fieldType === 'date' || f.id === 'date'),
        sampleMeas: measFilled.slice(0, 5).map((f) => ({
          id: f.id,
          value: f.value,
          method: f.source?.method,
        })),
      },
      null,
      2
    )
  );

  if (detectOnly > 0) {
    throw new Error(`REGRESSION: ${detectOnly} measurement fields still method=detect_only`);
  }
  if (measFilled.length < 50) {
    console.warn('WARNING: measurement fill < 50 — vision/tess may still be weak');
  }

  const finalized = await finalizeJob(job.id);
  const xlsx = await countXlsxData(finalized.output.path);
  const out = {
    output: finalized.output.name,
    path: finalized.output.path,
    jobMeasFilled: measFilled.length,
    xlsxForceLike: xlsx.forceLike,
    xlsxDateCells: xlsx.dateCells,
    xlsxOtherShort: xlsx.other,
    samples: xlsx.samples,
    totalMs: Date.now() - t0,
  };
  console.log(JSON.stringify(out, null, 2));
  const dir = path.join(__dirname, '..', 'data', 'uploads', 'e2e-form1');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'e2e-fill.json'), JSON.stringify(out, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
