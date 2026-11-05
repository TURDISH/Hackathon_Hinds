/**
 * Eval digitize output vs ground-truth Excel (benchmark only — not used at runtime).
 * Usage:
 *   node scripts/eval-gt-form1.js [jobId|path-to-job.json|path-to-filled.xlsx]
 * Defaults: latest job in data/jobs, GT from env GT_XLSX or Project store / ComparisonExample.
 */
const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');

const ROOT = path.join(__dirname, '..');
const DEFAULT_GT_CANDIDATES = [
  process.env.GT_XLSX,
  path.join(
    process.env.USERPROFILE || '',
    'AppData/Local/Cursor/AgentStores/cursor_agent_stores/bc-d98f305b-c275-46be-8f7d-dff1c72b5f5a/files/internal/uploads/ground-truth-form1.xlsx'
  ),
  path.join(ROOT, '..', 'ComparisonExample', 'Shuttle Tow Test Example 1 Correct Filled Out.xlsx'),
  path.join(ROOT, 'data', 'eval', 'ground-truth-form1.xlsx'),
].filter(Boolean);

function cellStr(cell) {
  const v = cell?.value;
  if (v == null || v === '') return '';
  if (typeof v === 'object' && v.result != null) return String(v.result).trim();
  if (v instanceof Date) {
    const mm = String(v.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(v.getUTCDate()).padStart(2, '0');
    const yy = v.getUTCFullYear();
    return `${mm}/${dd}/${yy}`;
  }
  return String(v).trim();
}

function normForce(s) {
  const d = String(s || '').replace(/\D/g, '');
  if (!d) return '';
  // Keep last 3–4 digits typical for force
  if (d.length > 4) return d.slice(-4);
  return d;
}

function normDate(s) {
  const t = String(s || '').trim();
  if (!t) return '';
  // ISO → M/D/Y comparable
  const iso = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[2]}/${iso[3]}/${iso[1]}`;
  const m = t.match(/(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})/);
  if (m) {
    let yy = m[3];
    if (yy.length === 2) yy = `20${yy}`;
    return `${m[1].padStart(2, '0')}/${m[2].padStart(2, '0')}/${yy}`;
  }
  return t.toLowerCase();
}

async function loadGtMap(gtPath) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(gtPath);
  const ws = wb.worksheets[0];
  const map = new Map();
  // Generic layout from schema-shaped tow sheet: left C/D/E shots 1.., right G/H/I
  for (let r = 5; r <= 60; r++) {
    const shotL = cellStr(ws.getCell(`C${r}`));
    const shotR = cellStr(ws.getCell(`G${r}`));
    if (/^\d+$/.test(shotL)) {
      map.set(`fwd_${shotL}`, normForce(cellStr(ws.getCell(`D${r}`))));
      map.set(`aft_${shotL}`, normForce(cellStr(ws.getCell(`E${r}`))));
    }
    if (/^\d+$/.test(shotR)) {
      map.set(`fwd_${shotR}`, normForce(cellStr(ws.getCell(`H${r}`))));
      map.set(`aft_${shotR}`, normForce(cellStr(ws.getCell(`I${r}`))));
    }
  }
  map.set('__date__', normDate(cellStr(ws.getCell('G2'))));
  map.set('__catapult__', cellStr(ws.getCell('D2')).replace(/\D/g, ''));
  return map;
}

function loadJobFields(arg) {
  const jobsDir = path.join(ROOT, 'data', 'jobs');
  let jobPath = arg;
  if (!jobPath) {
    const files = fs
      .readdirSync(jobsDir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => ({ f, t: fs.statSync(path.join(jobsDir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    if (!files.length) throw new Error('No jobs found');
    jobPath = path.join(jobsDir, files[0].f);
  } else if (!path.isAbsolute(jobPath) && !jobPath.includes('\\') && !jobPath.includes('/')) {
    jobPath = path.join(jobsDir, `${jobPath}.json`);
  }
  const job = JSON.parse(fs.readFileSync(jobPath, 'utf8'));
  return { job, jobPath };
}

function score(fields, gt) {
  const measIds = [...gt.keys()].filter((k) => /^(fwd|aft)_/.test(k));
  let exact = 0;
  let filled = 0;
  let gtFilled = 0;
  let missing = 0;
  let wrong = 0;
  const mismatches = [];
  for (const id of measIds) {
    const g = gt.get(id) || '';
    if (g) gtFilled += 1;
    const f = fields.find((x) => x.id === id);
    const got = normForce(f?.value || '');
    if (got) filled += 1;
    if (g && got && g === got) exact += 1;
    else if (g && !got) {
      missing += 1;
      if (mismatches.length < 40) mismatches.push({ id, gt: g, got: '', kind: 'missing' });
    } else if (g && got && g !== got) {
      wrong += 1;
      if (mismatches.length < 40) mismatches.push({ id, gt: g, got, kind: 'wrong' });
    }
  }
  const dateField = fields.find((f) => f.fieldType === 'date' || f.id === 'date');
  const dateMatch = normDate(dateField?.value || '') === (gt.get('__date__') || '');
  return {
    measurementSlots: measIds.length,
    gtFilled,
    predFilled: filled,
    exactMatch: exact,
    exactRate: gtFilled ? exact / gtFilled : 0,
    missing,
    wrong,
    dateMatch,
    predDate: dateField?.value || '',
    gtDate: gt.get('__date__') || '',
    mismatches,
  };
}

async function main() {
  const gtPath = DEFAULT_GT_CANDIDATES.find((p) => p && fs.existsSync(p));
  if (!gtPath) throw new Error('Ground-truth xlsx not found');
  const gt = await loadGtMap(gtPath);
  const { job, jobPath } = loadJobFields(process.argv[2]);
  const fields = job.fields || [];
  const s = score(fields, gt);
  const out = {
    gtPath,
    jobPath,
    jobId: job.id,
    status: job.status,
    wallMsHint: job.updatedAt && job.createdAt
      ? Date.parse(job.updatedAt) - Date.parse(job.createdAt)
      : null,
    mode: job.grid?.handwritingStack?.mode || process.env.VISION_OCR_MODE,
    mappingStats: job.mappingStats,
    ...s,
    exactPct: Number((s.exactRate * 100).toFixed(1)),
  };
  console.log(JSON.stringify(out, null, 2));
  const dir = path.join(ROOT, 'data', 'eval');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'last-gt-eval.json'), JSON.stringify(out, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
