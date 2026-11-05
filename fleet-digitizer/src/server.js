const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const config = require('./config');

// Bench scripts may set GRID_DETECT_ONLY in a shared shell; never let that skip
// real cell OCR inside the long-lived digitizer process.
delete process.env.GRID_DETECT_ONLY;
const {
  listTemplates,
  saveUploadedTemplate,
  deleteTemplate,
  getTemplateById,
  reprocessTemplates,
  summarizeTemplate,
} = require('./services/templates');
const { probeLocalAi } = require('./services/templateAiConsult');
const { schemaDir } = require('./services/templateSchema');
const {
  startUploadJob,
  loadJob,
  updateJobFields,
  finalizeJob,
} = require('./services/pipeline');
const { formatEta } = require('./services/jobProgress');

for (const p of [
  config.paths.uploads,
  config.paths.jobs,
  config.paths.templates,
  config.paths.outputs,
]) {
  fs.mkdirSync(p, { recursive: true });
}

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use('/media/uploads', express.static(config.paths.uploads));

const upload = multer({
  dest: config.paths.uploads,
  limits: { fileSize: 40 * 1024 * 1024 },
});

app.get('/api/health', async (_req, res) => {
  const ai = await probeLocalAi();
  const { probeVision, visionModel, visionMode } = require('./services/visionOcr');
  const vision = await probeVision();
  const templateAi = {
    ...ai,
    model: process.env.TEMPLATE_AI_MODEL || 'gemma4:e2b',
    provider: process.env.TEMPLATE_AI_PROVIDER || 'ollama',
    role: 'template_schema_enrichment_only',
  };
  const vMode = visionMode();
  let handwritingOcr = config.ocrProvider;
  if (vision.available && vMode === 'batch') {
    handwritingOcr = `vision ${visionModel()} batch bands (+ ${config.ocrProvider}/cell residual)`;
  } else if (vision.available && vMode === 'primary') {
    handwritingOcr = `vision ${visionModel()} primary (+ ${config.ocrProvider} fallback)`;
  } else if (vision.available && vMode !== 'off') {
    handwritingOcr = `${config.ocrProvider} + vision ${visionModel()} (${vMode})`;
  }
  res.json({
    ok: true,
    ocrProvider: config.ocrProvider,
    handwritingOcr,
    handwritingVision: vision,
    visionMode: vMode,
    threshold: config.confidenceThreshold,
    templatesDir: config.paths.templates,
    outputsDir: config.paths.outputs,
    schemaCacheDir: schemaDir(),
    templateAi,
    stackNote: `Handwriting: ${handwritingOcr} · Template AI: ${
      ai.available ? `${templateAi.provider}/${templateAi.model} (schema only)` : 'off'
    }`,
  });
});


app.get('/api/templates', async (_req, res) => {
  try {
    const templates = await listTemplates();
    res.json({
      templates: templates.map((t) => ({
        id: t.id,
        name: t.name,
        type: t.type,
        size: t.size,
        titleHints: t.titleHints,
        fieldCount: t.fields?.length || 0,
        labelCount: t.labels?.length || 0,
        measurementSlots: t.slotLayout?.measurementSlots || 0,
        schemaCachePath: t.schemaCachePath,
        schemaCacheHit: t.schemaCacheHit,
        schemaAi: t.schemaAi,
        slotSchema: t.slotLayout?.schema || null,
        error: t.error,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/templates/:id/schema', async (req, res) => {
  try {
    const tpl = await getTemplateById(req.params.id);
    if (!tpl) return res.status(404).json({ error: 'Not found' });
    res.json({
      template: summarizeTemplate(tpl),
      schema: tpl.schema || null,
      slotLayout: tpl.slotLayout,
      fieldAliases: tpl.fieldAliases,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/templates/reprocess', async (req, res) => {
  try {
    const result = await reprocessTemplates({ id: req.body?.id || null });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/templates', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'file required' });
    const ext = path.extname(req.file.originalname).toLowerCase();
    if (!['.xlsx', '.docx'].includes(ext)) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: 'Only .xlsx and .docx templates are supported' });
    }
    const buf = fs.readFileSync(req.file.path);
    const dest = saveUploadedTemplate(req.file.originalname, buf);
    fs.unlinkSync(req.file.path);
    // Force analyze newly uploaded master once
    const templates = await listTemplates({ force: true });
    const created = templates.find((t) => t.path === dest);
    res.json({
      ok: true,
      template: created ? summarizeTemplate(created) : null,
      schemaCachePath: created?.schemaCachePath,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/templates/:id', async (req, res) => {
  try {
    const ok = await deleteTemplate(req.params.id);
    if (!ok) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/jobs', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'file required' });
    const ext = path.extname(req.file.originalname).toLowerCase();
    if (!['.pdf', '.png', '.jpg', '.jpeg', '.webp', '.tif', '.tiff', '.bmp'].includes(ext)) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: 'Upload a PDF or image scan' });
    }
    // Keep stable extension for rasterizer
    const stable = req.file.path + ext;
    fs.renameSync(req.file.path, stable);
    // Return immediately so the UI can poll progress during long vision runs
    const job = startUploadJob(stable, req.file.originalname);
    res.status(202).json({ job: summarizeJob(job) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/jobs/:id', (req, res) => {
  const job = loadJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Not found' });
  res.json({ job: summarizeJob(job, true) });
});

app.patch('/api/jobs/:id', async (req, res) => {
  try {
    const job = updateJobFields(req.params.id, req.body.fields, req.body.templateId);
    if (req.body.templateId) {
      const tpl = await getTemplateById(req.body.templateId);
      job.selectedTemplateName = tpl?.name || job.selectedTemplateName;
      require('./services/pipeline').saveJob(job);
    }
    res.json({ job: summarizeJob(job, true) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/jobs/:id/finalize', async (req, res) => {
  try {
    if (req.body?.fields) {
      updateJobFields(req.params.id, req.body.fields, req.body.templateId);
    } else if (req.body?.templateId) {
      updateJobFields(req.params.id, null, req.body.templateId);
    }
    const job = await finalizeJob(req.params.id);
    res.json({ job: summarizeJob(job, true) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/jobs/:id/download', (req, res) => {
  const job = loadJob(req.params.id);
  if (!job?.output?.path || !fs.existsSync(job.output.path)) {
    return res.status(404).json({ error: 'Output not ready' });
  }
  res.download(job.output.path, job.output.name);
});

function summarizeJob(job, includeWords = false) {
  const progress = job.progress
    ? {
        ...job.progress,
        etaLabel: formatEta(job.progress.etaSeconds),
      }
    : undefined;
  return {
    id: job.id,
    status: job.status,
    originalName: job.originalName,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    error: job.error,
    progress,
    pages: job.pages,
    ocr: job.ocr
      ? {
          provider: job.ocr.provider,
          stub: job.ocr.stub,
          fallbackFrom: job.ocr.fallbackFrom,
          azureNote: job.ocr.azureNote,
          text: job.ocr.text,
          confidence: job.ocr.confidence,
          wordCount: job.ocr.wordCount,
          words: includeWords ? job.ocr.words : undefined,
        }
      : undefined,
    match: job.match,
    selectedTemplateId: job.selectedTemplateId,
    selectedTemplateName: job.selectedTemplateName,
    fields: job.fields,
    mappingStats: job.mappingStats,
    threshold: job.threshold,
    lowConfidenceCount: job.lowConfidenceCount,
    grid: job.grid,
    gridOverlayUrl: job.gridOverlayUrl,
    templateSchema: job.templateSchema,
    output: job.output,
    steps: job.steps,
  };
}

app.listen(config.port, () => {
  console.log(`Fleet SOP Digitizer running at http://localhost:${config.port}`);
  console.log(`Templates: ${config.paths.templates}`);
  console.log(`Outputs:   ${config.paths.outputs}`);
  console.log(`OCR:       ${config.ocrProvider} (threshold ${config.confidenceThreshold}%)`);
});
