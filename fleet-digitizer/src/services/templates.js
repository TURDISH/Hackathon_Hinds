const fs = require('fs');
const path = require('path');
const config = require('../config');
const { getOrAnalyzeTemplateSchema } = require('./templateAnalyze');
const {
  schemaCachePath,
  loadCachedSchema,
  SCHEMA_VERSION,
} = require('./templateSchema');

function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Build alias lookup from analyzed schema fields (dynamic).
 */
function aliasesFromSchema(schema) {
  const map = {};
  for (const f of schema?.fields || []) {
    if (f.kind === 'measurement') continue;
    const aliases = [
      ...(f.aliases || []),
      f.labelNorm,
      normalize(f.label),
      f.id.replace(/_/g, ' '),
    ].filter(Boolean);
    map[f.id] = [...new Set(aliases.map((a) => normalize(a)).filter(Boolean))];
  }
  return map;
}

function compactSchemaMeta(schema, filePath) {
  return {
    schemaVersion: schema.version || SCHEMA_VERSION,
    schemaCachePath: schema._cachePath || schemaCachePath(filePath),
    schemaCacheHit: Boolean(schema._cacheHit),
    schemaAnalyzedAt: schema.analyzedAt || null,
    schemaAi: schema.ai || null,
    analyzer: schema.analyzer || null,
  };
}

async function loadTemplateMeta(filePath, { force = false } = {}) {
  const ext = path.extname(filePath).toLowerCase();
  try {
    const schema = await getOrAnalyzeTemplateSchema(filePath, { force });
    return {
      type: schema.type || ext.slice(1),
      sheetName: schema.sheetName,
      labels: schema.labels || [],
      fields: (schema.fields || []).map((f) => ({
        ...f,
        valueTarget: f.writeTarget
          ? {
              row: f.writeTarget.row,
              col: f.writeTarget.col,
              address: f.writeTarget.address,
              placeholder: f.writeTarget.placeholder,
              strategy: f.writeTarget.strategy,
            }
          : f.valueTarget,
        writeTarget: f.writeTarget,
      })),
      fingerprint: schema.fingerprint || [],
      titleHints: schema.titleHints || [],
      slotLayout: schema.slotLayout || null,
      grids: schema.grids || [],
      fieldAliases: aliasesFromSchema(schema),
      schema,
      ...compactSchemaMeta(schema, filePath),
    };
  } catch (err) {
    // Fail closed — no hardcoded form assumptions
    return {
      type: ext.slice(1),
      error: `Template schema analysis failed: ${err.message}. Re-preprocess or check the master file.`,
      labels: [],
      fields: [],
      fingerprint: [normalize(path.basename(filePath))],
      titleHints: [],
      slotLayout: null,
      fieldAliases: {},
      schemaFailed: true,
    };
  }
}

async function listTemplates({ force = false } = {}) {
  const dir = config.paths.templates;
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const files = fs.readdirSync(dir).filter((f) => /\.(xlsx|docx)$/i.test(f));
  const items = [];

  for (const file of files) {
    const filePath = path.join(dir, file);
    const meta = await loadTemplateMeta(filePath, { force });
    items.push({
      id: Buffer.from(file).toString('base64url'),
      name: file,
      path: filePath,
      size: fs.statSync(filePath).size,
      ...meta,
    });
  }

  return items;
}

async function getTemplateById(id, { force = false } = {}) {
  const all = await listTemplates({ force });
  return all.find((t) => t.id === id) || null;
}

function saveUploadedTemplate(originalName, buffer) {
  const safe = path.basename(originalName).replace(/[^\w.\- ()]/g, '_');
  const dest = path.join(config.paths.templates, safe);
  fs.writeFileSync(dest, buffer);
  const cache = schemaCachePath(dest);
  if (fs.existsSync(cache)) fs.unlinkSync(cache);
  return dest;
}

function deleteTemplate(id) {
  return listTemplates().then((all) => {
    const t = all.find((x) => x.id === id);
    if (!t) return false;
    fs.unlinkSync(t.path);
    const cache = schemaCachePath(t.path);
    if (fs.existsSync(cache)) fs.unlinkSync(cache);
    return true;
  });
}

async function reprocessTemplates({ id = null } = {}) {
  if (id) {
    const tpl = await getTemplateById(id, { force: true });
    return { ok: Boolean(tpl), templates: tpl ? [summarizeTemplate(tpl)] : [] };
  }
  const templates = await listTemplates({ force: true });
  return { ok: true, templates: templates.map(summarizeTemplate) };
}

function summarizeTemplate(t) {
  return {
    id: t.id,
    name: t.name,
    type: t.type,
    fieldCount: t.fields?.length || 0,
    measurementSlots: t.slotLayout?.measurementSlots || 0,
    headerSlots: t.slotLayout?.headerSlots || 0,
    schemaCachePath: t.schemaCachePath,
    schemaCacheHit: t.schemaCacheHit,
    schemaAi: t.schemaAi,
    titleHints: t.titleHints,
    error: t.error,
  };
}

module.exports = {
  listTemplates,
  getTemplateById,
  saveUploadedTemplate,
  deleteTemplate,
  reprocessTemplates,
  loadTemplateMeta,
  normalize,
  aliasesFromSchema,
  loadCachedSchema,
  summarizeTemplate,
};
