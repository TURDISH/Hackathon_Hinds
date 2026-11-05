/**
 * Benchmark measurement-grid coverage on a scan PDF against a master template schema.
 * Usage: node scripts/bench-grid.js [scanPath] [templateNameSubstring]
 */
const path = require('path');
const fs = require('fs');
const { rasterizeDocument } = require('../src/services/pdf');
const { listTemplates } = require('../src/services/templates');
const { extractGridFields } = require('../src/services/formGrid');

async function main() {
  const scan =
    process.argv[2] ||
    path.resolve(__dirname, '..', '..', 'ScannedDocs', 'filled out form 1.pdf');
  const tip = (process.argv[3] || 'Shuttle').toLowerCase();
  const workDir = path.join(__dirname, '..', 'data', 'uploads', 'bench-grid');
  fs.mkdirSync(workDir, { recursive: true });

  console.log('scan', scan);
  const pages = await rasterizeDocument(scan, workDir, { scale: 3 });
  const templates = await listTemplates();
  const tpl =
    templates.find((t) => t.name.toLowerCase().includes(tip) && t.type === 'xlsx') ||
    templates.find((t) => t.type === 'xlsx');
  if (!tpl) throw new Error('No xlsx template');
  console.log('template', tpl.name, 'slots', tpl.slotLayout?.measurementSlots);

  const t0 = Date.now();
  const result = await extractGridFields(pages[0].path, {
    debugDir: path.join(workDir, 'grid-debug'),
    template: tpl,
  });
  const meta = result.meta || {};
  const filled = result.fields.filter((f) => f.value).length;
  const withInk = result.fields.filter((f) => f.source?.hasInk).length;
  const out = {
    ms: Date.now() - t0,
    expectedSlots: meta.expectedSlots,
    cellSlots: meta.cellSlots,
    handwrittenCells: meta.handwrittenCells ?? withInk,
    ocrFilled: meta.ocrFilled ?? filled,
    plausible: meta.plausible,
    measurementFilled: filled,
    leftCols: meta.leftCols,
    rightCols: meta.rightCols,
    indexedShots: meta.indexedShots,
    overlay: path.join(workDir, 'grid-debug', 'grid-overlay.png'),
  };
  console.log(JSON.stringify(out, null, 2));
  fs.writeFileSync(path.join(workDir, 'bench.json'), JSON.stringify(out, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
