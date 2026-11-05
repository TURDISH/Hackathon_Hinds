const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { v4: uuidv4 } = require('uuid');
const config = require('../config');
const { rasterizeDocument } = require('./pdf');
const { runOcr } = require('./ocr');
const { listTemplates, getTemplateById } = require('./templates');
const { matchTemplates } = require('./match');
const { mapFields } = require('./mapFields');
const { extractGridFields } = require('./formGrid');
const { populateTemplate } = require('./populate');
const { refineHeadersWithTypedOcr } = require('./headerTypedOcr');
const { originalToDeskew } = require('./geom');
const { buildProgress, saveTimingSample } = require('./jobProgress');

function jobPath(id) {
  return path.join(config.paths.jobs, `${id}.json`);
}

function saveJob(job) {
  fs.mkdirSync(config.paths.jobs, { recursive: true });
  fs.writeFileSync(jobPath(job.id), JSON.stringify(job, null, 2));
  return job;
}

function loadJob(id) {
  const p = jobPath(id);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

/** In-memory per-job clocks (not written to disk). */
const progressClocks = new Map();

function getClock(jobId, createdAt) {
  if (!progressClocks.has(jobId)) {
    progressClocks.set(jobId, {
      startedAtMs: Date.parse(createdAt) || Date.now(),
      stepStartedAt: {},
      stepMs: {},
      lastStep: null,
    });
  }
  return progressClocks.get(jobId);
}

function touchProgress(job, stepId, { detail, fraction, current, total } = {}) {
  const clock = getClock(job.id, job.createdAt);
  if (clock.lastStep && clock.lastStep !== stepId && clock.stepStartedAt[clock.lastStep]) {
    clock.stepMs[clock.lastStep] =
      (clock.stepMs[clock.lastStep] || 0) +
      (Date.now() - clock.stepStartedAt[clock.lastStep]);
  }
  if (!clock.stepStartedAt[stepId] || clock.lastStep !== stepId) {
    clock.stepStartedAt[stepId] = Date.now();
  }
  clock.lastStep = stepId;

  job.progress = buildProgress({
    stepId,
    detail,
    fraction,
    current,
    total,
    startedAtMs: clock.startedAtMs,
    stepStartedAt: clock.stepStartedAt,
  });
  job.updatedAt = new Date().toISOString();
  saveJob(job);
  return job;
}

/**
 * Create a processing job and return immediately (for HTTP). Background runner
 * continues via runJobPipeline. Scripts can await processUpload() instead.
 */
function createUploadJob(filePath, originalName) {
  const id = uuidv4();
  const workDir = path.join(config.paths.uploads, id);
  fs.mkdirSync(workDir, { recursive: true });
  const createdAt = new Date().toISOString();
  const job = {
    id,
    status: 'processing',
    originalName,
    sourcePath: filePath,
    workDir,
    createdAt,
    updatedAt: createdAt,
    steps: [{ step: 'queued', at: createdAt }],
  };
  getClock(id, createdAt);
  touchProgress(job, 'queued', { detail: originalName || 'upload', fraction: 0 });
  return job;
}

function startUploadJob(filePath, originalName) {
  const job = createUploadJob(filePath, originalName);
  setImmediate(() => {
    runJobPipeline(job.id).catch((err) => {
      console.error('Job pipeline failed', job.id, err);
    });
  });
  return loadJob(job.id);
}

/** Sync helper for CLI/e2e: create + await full pipeline. */
async function processUpload(filePath, originalName) {
  const job = createUploadJob(filePath, originalName);
  return runJobPipeline(job.id);
}

async function runJobPipeline(id) {
  let job = loadJob(id);
  if (!job) throw new Error('Job not found');
  const filePath = job.sourcePath;
  const workDir = job.workDir || path.join(config.paths.uploads, id);
  fs.mkdirSync(workDir, { recursive: true });

  getClock(id, job.createdAt);

  try {
    touchProgress(job, 'rasterize', { detail: 'Rendering PDF/image pages', fraction: 0 });
    job.steps.push({ step: 'rasterize', at: new Date().toISOString() });
    saveJob(job);
    const pages = await rasterizeDocument(filePath, workDir, { scale: 3 });
    job = loadJob(id);
    job.pages = pages.map((p) => ({
      page: p.page,
      url: `/media/uploads/${id}/${path.basename(p.path)}`,
      path: p.path,
      width: p.width,
      height: p.height,
    }));
    touchProgress(job, 'rasterize', { detail: `${pages.length} page(s)`, fraction: 1 });

    touchProgress(job, 'page_ocr', { detail: 'Tesseract page text', fraction: 0 });
    job.steps.push({ step: 'ocr', at: new Date().toISOString() });
    const ocr = await runOcr(pages[0].path);
    job = loadJob(id);
    job.pages = job.pages || pages.map((p) => ({
      page: p.page,
      url: `/media/uploads/${id}/${path.basename(p.path)}`,
      path: p.path,
      width: p.width,
      height: p.height,
    }));
    job.ocr = {
      provider: ocr.provider,
      stub: ocr.stub || false,
      fallbackFrom: ocr.fallbackFrom,
      azureNote: ocr.azureNote,
      text: ocr.text,
      confidence: ocr.confidence,
      wordCount: (ocr.words || []).length,
      words: ocr.words,
    };
    touchProgress(job, 'page_ocr', {
      detail: `${job.ocr.wordCount} tokens`,
      fraction: 1,
    });

    touchProgress(job, 'template_match', { fraction: 0 });
    job.steps.push({ step: 'template_match', at: new Date().toISOString() });
    const templates = await listTemplates();
    const match = matchTemplates(ocr, templates);
    job.match = match;
    const best = match.best
      ? templates.find((t) => t.id === match.best.templateId)
      : null;
    job.selectedTemplateId = best?.id || null;
    job.selectedTemplateName = best?.name || null;
    touchProgress(job, 'template_match', {
      detail: best?.name || 'no match',
      fraction: 1,
    });

    let gridResult = null;
    const hasMeasurementGrid =
      best?.type === 'xlsx' &&
      ((best.slotLayout?.measurementSlots || 0) > 0 ||
        best.slotLayout?.hasMeasurementGrid ||
        (best.fields || []).some((f) => f.kind === 'measurement'));

    job.steps.push({ step: 'grid_cell_ocr', at: new Date().toISOString() });
    if (hasMeasurementGrid) {
      touchProgress(job, 'grid_detect', { detail: 'Deskew + ruling lines', fraction: 0 });
      // grid_detect → grid_ocr continuum reported from extractGridFields
      gridResult = await extractGridFields(pages[0].path, {
        debugDir: path.join(workDir, 'grid-debug'),
        template: best,
        onProgress: (p) => {
          const fresh = loadJob(id);
          if (!fresh || fresh.status !== 'processing') return;
          if (p.phase === 'detect') {
            touchProgress(fresh, 'grid_detect', {
              detail: p.detail,
              fraction: p.fraction ?? 0.5,
            });
          } else {
            touchProgress(fresh, 'grid_ocr', {
              detail: p.detail,
              fraction: p.fraction ?? 0,
              current: p.current,
              total: p.total,
            });
          }
        },
      });
      job = loadJob(id);
      job.grid = gridResult.meta;
      job.pages = job.pages || [];
      if (!job.pages[0] && pages[0]) {
        job.pages[0] = {
          page: pages[0].page,
          url: `/media/uploads/${id}/${path.basename(pages[0].path)}`,
          path: pages[0].path,
          width: pages[0].width,
          height: pages[0].height,
        };
      }
      if (gridResult.meta?.deskewedPath && fs.existsSync(gridResult.meta.deskewedPath)) {
        const deskewPath = gridResult.meta.deskewedPath;
        const deskewName = path.basename(deskewPath);
        job.pages[0].deskewUrl = `/media/uploads/${id}/${deskewName}`;
        const deskewMeta = await sharp(deskewPath).metadata();
        job.pages[0].url = job.pages[0].deskewUrl;
        job.pages[0].width = deskewMeta.width || gridResult.meta.deskewedWidth || job.pages[0].width;
        job.pages[0].height = deskewMeta.height || gridResult.meta.deskewedHeight || job.pages[0].height;
        job.pages[0].coordSpace = 'deskewed';
        job.pages[0].deskewAngle = gridResult.meta.angle || 0;
        if (fs.existsSync(path.join(workDir, 'grid-debug', 'grid-overlay.png'))) {
          job.gridOverlayUrl = `/media/uploads/${id}/grid-debug/grid-overlay.png`;
        }
      }
      touchProgress(job, 'grid_ocr', {
        detail: `${gridResult.meta?.ocrFilled ?? 0} cells filled`,
        fraction: 1,
        current: gridResult.meta?.ocrFilled,
        total: gridResult.meta?.cellSlots,
      });
    } else {
      touchProgress(job, 'grid_ocr', { detail: 'No measurement grid in schema', fraction: 1 });
    }

    job.templateSchema = best
      ? {
          cachePath: best.schemaCachePath || null,
          cacheHit: best.schemaCacheHit,
          analyzedAt: best.schemaAnalyzedAt,
          ai: best.schemaAi,
          measurementSlots: best.slotLayout?.measurementSlots || 0,
          headerSlots: best.slotLayout?.headerSlots || 0,
          schema: best.slotLayout?.schema || null,
        }
      : null;

    touchProgress(job, 'field_map', { fraction: 0 });
    job.steps.push({ step: 'field_map', at: new Date().toISOString() });
    const mapped = mapFields(ocr, best, gridResult);

    const origW = pages[0].width;
    const origH = pages[0].height;
    const angle = gridResult?.meta?.angle || 0;
    let fields = mapped.fields;
    if (job.pages?.[0]?.coordSpace === 'deskewed' && Math.abs(angle) >= 0.01) {
      fields = fields.map((f) => {
        if (f.source?.coordSpace === 'deskewed' || f.source?.templateSlot) return f;
        const src = { ...(f.source || {}) };
        if (src.labelBBox) src.labelBBox = originalToDeskew(src.labelBBox, angle, origW, origH);
        if (src.valueBBoxes?.length) {
          src.valueBBoxes = src.valueBBoxes.map((b) => originalToDeskew(b, angle, origW, origH));
        }
        if (src.cellBBox) src.cellBBox = originalToDeskew(src.cellBBox, angle, origW, origH);
        src.coordSpace = 'deskewed';
        return { ...f, source: src };
      });
    }
    touchProgress(job, 'field_map', { detail: `${fields.length} fields`, fraction: 1 });

    touchProgress(job, 'typed_header_ocr', { detail: 'Date / IDs / names', fraction: 0 });
    job.steps.push({ step: 'typed_header_ocr', at: new Date().toISOString() });
    const headerImage =
      gridResult?.meta?.deskewedPath && fs.existsSync(gridResult.meta.deskewedPath)
        ? gridResult.meta.deskewedPath
        : pages[0].path;
    fields = await refineHeadersWithTypedOcr(fields, {
      imagePath: headerImage,
      pageWidth: job.pages[0].width,
      pageHeight: job.pages[0].height,
    });
    touchProgress(job, 'typed_header_ocr', { fraction: 1 });

    const filled = fields.filter((f) => f.value).length;
    const lowCount = fields.filter((f) => f.lowConfidence || f.needsReview).length;
    job.fields = fields;
    job.mappingStats = {
      ...mapped.stats,
      filled,
      lowConfidence: fields.filter((f) => f.confidence > 0 && f.confidence < mapped.threshold).length,
      overlayBoxes: fields.filter(
        (f) => f.value && (f.source?.cellBBox || f.source?.valueBBoxes?.length)
      ).length,
    };
    job.threshold = mapped.threshold;
    job.lowConfidenceCount = lowCount;

    touchProgress(job, 'complete', { detail: 'Review ready', fraction: 1 });
    const clock = getClock(id, job.createdAt);
    if (clock.lastStep && clock.stepStartedAt[clock.lastStep]) {
      clock.stepMs[clock.lastStep] =
        (clock.stepMs[clock.lastStep] || 0) +
        (Date.now() - clock.stepStartedAt[clock.lastStep]);
    }
    saveTimingSample({
      at: new Date().toISOString(),
      totalMs: Date.now() - clock.startedAtMs,
      stepMs: { ...clock.stepMs },
      hadGrid: Boolean(hasMeasurementGrid),
      visionMode: process.env.VISION_OCR_MODE || 'batch',
    });
    progressClocks.delete(id);

    job.status = 'review';
    job.updatedAt = new Date().toISOString();
    return saveJob(job);
  } catch (err) {
    job = loadJob(id) || job;
    job.status = 'error';
    job.error = err.message;
    job.progress = {
      ...(job.progress || {}),
      step: 'error',
      label: 'Failed',
      detail: err.message,
      percent: job.progress?.percent || 0,
      etaSeconds: null,
      updatedAt: new Date().toISOString(),
    };
    job.updatedAt = new Date().toISOString();
    progressClocks.delete(id);
    saveJob(job);
    throw err;
  }
}

function updateJobFields(id, fields, templateId) {
  const job = loadJob(id);
  if (!job) throw new Error('Job not found');
  if (fields) {
    job.fields = fields.map((f) => ({
      ...f,
      confidence: Number(f.confidence ?? 100),
      lowConfidence: Number(f.confidence ?? 100) < (job.threshold || config.confidenceThreshold),
      needsReview: Number(f.confidence ?? 100) < (job.threshold || config.confidenceThreshold),
    }));
    job.lowConfidenceCount = job.fields.filter((f) => f.lowConfidence).length;
  }
  if (templateId) {
    job.selectedTemplateId = templateId;
  }
  job.updatedAt = new Date().toISOString();
  return saveJob(job);
}

async function finalizeJob(id) {
  const job = loadJob(id);
  if (!job) throw new Error('Job not found');

  const template = await getTemplateById(job.selectedTemplateId);
  if (!template) throw new Error('Selected template not found');

  job.progress = {
    step: 'populate',
    label: 'Writing Excel/Word output',
    detail: template.name,
    percent: 99,
    etaSeconds: 5,
    updatedAt: new Date().toISOString(),
  };
  saveJob(job);

  const { outPath, outName } = await populateTemplate(template, job.fields || [], id);
  job.status = 'finalized';
  job.output = {
    name: outName,
    path: outPath,
    url: `/api/jobs/${id}/download`,
  };
  job.progress = {
    step: 'complete',
    label: 'Download ready',
    detail: outName,
    percent: 100,
    etaSeconds: 0,
    updatedAt: new Date().toISOString(),
  };
  job.updatedAt = new Date().toISOString();
  return saveJob(job);
}

function publicJob(job) {
  if (!job) return null;
  return job;
}

module.exports = {
  processUpload,
  startUploadJob,
  createUploadJob,
  runJobPipeline,
  loadJob,
  saveJob,
  updateJobFields,
  finalizeJob,
  publicJob,
};
