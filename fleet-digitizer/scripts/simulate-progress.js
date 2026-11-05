/**
 * Simulate job progress updates (no full vision run) to verify progress API shape.
 */
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });
delete process.env.GRID_DETECT_ONLY;

const { buildProgress, formatEta, STEPS } = require('../src/services/jobProgress');
const { saveJob } = require('../src/services/pipeline');

async function main() {
  const id = 'progress-sim-demo';
  const startedAtMs = Date.now() - 120000; // pretend 2 min elapsed
  const out = [];
  for (const step of STEPS) {
    for (const frac of step.id === 'grid_ocr' ? [0, 0.25, 0.6, 1] : [0, 1]) {
      const progress = buildProgress({
        stepId: step.id,
        detail:
          step.id === 'grid_ocr'
            ? `Vision OCR ${Math.round(frac * 103)}/103`
            : step.label,
        fraction: frac,
        current: step.id === 'grid_ocr' ? Math.round(frac * 103) : null,
        total: step.id === 'grid_ocr' ? 103 : null,
        startedAtMs,
      });
      out.push({
        ...progress,
        etaLabel: formatEta(progress.etaSeconds),
      });
    }
  }
  const job = {
    id,
    status: 'processing',
    originalName: 'filled out form 1.pdf',
    createdAt: new Date(startedAtMs).toISOString(),
    updatedAt: new Date().toISOString(),
    progress: out[out.length - 3],
    steps: STEPS.map((s) => ({ step: s.id, at: new Date().toISOString() })),
  };
  saveJob(job);
  const dir = path.join(__dirname, '..', 'data', 'uploads', 'progress-sim');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'samples.json'), JSON.stringify(out, null, 2));
  console.log(JSON.stringify({ jobId: id, samples: out.length, mid: out[Math.floor(out.length / 2)] }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
