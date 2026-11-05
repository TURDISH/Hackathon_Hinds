/**
 * Pipeline progress model: weighted steps + ETA from elapsed / recent timings.
 */
const fs = require('fs');
const path = require('path');
const config = require('../config');

/** Ordered digitize steps with relative weights (vision OCR dominates). */
const STEPS = [
  { id: 'queued', label: 'Queued', weight: 1 },
  { id: 'rasterize', label: 'Rasterizing scan', weight: 6 },
  { id: 'page_ocr', label: 'Reading page labels (Tesseract)', weight: 8 },
  { id: 'template_match', label: 'Matching template', weight: 3 },
  { id: 'grid_detect', label: 'Detecting measurement grid', weight: 8 },
  { id: 'grid_ocr', label: 'Reading handwritten cells', weight: 55 },
  { id: 'field_map', label: 'Mapping fields to template', weight: 4 },
  { id: 'typed_header_ocr', label: 'Refining header fields', weight: 12 },
  { id: 'complete', label: 'Ready for review', weight: 3 },
];

const weightSum = STEPS.reduce((s, x) => s + x.weight, 0);

function stepRange(stepId) {
  let start = 0;
  for (const s of STEPS) {
    const end = start + s.weight / weightSum;
    if (s.id === stepId) return { start, end, step: s };
    start = end;
  }
  return { start: 0, end: 1, step: STEPS[0] };
}

function timingPath() {
  return path.join(config.paths.root, 'data', 'timing-stats.json');
}

function loadTimingStats() {
  try {
    const p = timingPath();
    if (!fs.existsSync(p)) return { samples: [] };
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return { samples: [] };
  }
}

function saveTimingSample(sample) {
  try {
    const stats = loadTimingStats();
    stats.samples = [...(stats.samples || []), sample].slice(-40);
    fs.mkdirSync(path.dirname(timingPath()), { recursive: true });
    fs.writeFileSync(timingPath(), JSON.stringify(stats, null, 2));
  } catch {
    /* non-fatal */
  }
}

function avgStepMs(stats, stepId) {
  const vals = (stats.samples || [])
    .map((s) => s.stepMs?.[stepId])
    .filter((n) => Number.isFinite(n) && n > 0);
  if (!vals.length) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

/**
 * @param {object} opts
 * @param {string} opts.stepId
 * @param {string} [opts.detail]
 * @param {number} [opts.fraction] 0..1 within current step
 * @param {number} [opts.current]
 * @param {number} [opts.total]
 * @param {number} opts.startedAtMs
 * @param {object} [opts.stepStartedAt] map stepId -> ms
 */
function buildProgress({
  stepId,
  detail = '',
  fraction = 0,
  current = null,
  total = null,
  startedAtMs,
  stepStartedAt = {},
}) {
  const { start, end, step } = stepRange(stepId);
  const frac = Math.max(0, Math.min(1, Number(fraction) || 0));
  const percent = Math.round((start + (end - start) * frac) * 1000) / 10;
  const elapsedMs = Math.max(0, Date.now() - (startedAtMs || Date.now()));

  let etaSeconds = null;
  const stats = loadTimingStats();

  // Prefer historical remaining-step averages when available
  let histRemain = 0;
  let histKnown = false;
  let passedCurrent = false;
  for (const s of STEPS) {
    if (s.id === stepId) {
      passedCurrent = true;
      const avg = avgStepMs(stats, s.id);
      if (avg != null) {
        histRemain += avg * (1 - frac);
        histKnown = true;
      }
      continue;
    }
    if (!passedCurrent) continue;
    const avg = avgStepMs(stats, s.id);
    if (avg != null) {
      histRemain += avg;
      histKnown = true;
    }
  }

  if (histKnown && histRemain > 0) {
    etaSeconds = Math.round(histRemain / 1000);
  } else if (percent > 2 && percent < 99.5) {
    // Linear extrapolation from elapsed
    const etaMs = (elapsedMs / percent) * (100 - percent);
    etaSeconds = Math.round(etaMs / 1000);
  }

  // Clamp absurd ETAs early in the job
  if (etaSeconds != null && percent < 5) {
    etaSeconds = Math.min(etaSeconds, 45 * 60);
  }

  return {
    step: stepId,
    label: step.label,
    detail: detail || null,
    percent,
    fraction: current != null && total ? { current, total } : null,
    elapsedMs,
    etaSeconds,
    updatedAt: new Date().toISOString(),
    stepStartedAt: stepStartedAt[stepId] || null,
  };
}

function formatEta(seconds) {
  if (seconds == null || !Number.isFinite(seconds)) return null;
  if (seconds < 5) return 'a few seconds';
  if (seconds < 60) return `~${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m < 60) return s >= 15 ? `~${m}m ${s}s` : `~${m}m`;
  const h = Math.floor(m / 60);
  return `~${h}h ${m % 60}m`;
}

module.exports = {
  STEPS,
  buildProgress,
  saveTimingSample,
  loadTimingStats,
  formatEta,
  stepRange,
};
