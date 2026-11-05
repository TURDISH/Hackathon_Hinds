const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../config');

const SCHEMA_VERSION = 2;

function schemaDir() {
  const dir = process.env.SCHEMA_CACHE_DIR
    ? path.resolve(process.env.SCHEMA_CACHE_DIR)
    : path.join(config.paths.root, 'data', 'schemas');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function fileHash(filePath) {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function schemaCachePath(templatePath) {
  const base = path.basename(templatePath);
  const safe = base.replace(/[^\w.\- ()]/g, '_');
  return path.join(schemaDir(), `${safe}.schema.json`);
}

function loadCachedSchema(templatePath) {
  const cachePath = schemaCachePath(templatePath);
  if (!fs.existsSync(cachePath)) return null;
  try {
    const schema = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    const hash = fileHash(templatePath);
    if (schema.templateHash !== hash) return null;
    if (schema.version !== SCHEMA_VERSION) return null;
    schema._cachePath = cachePath;
    schema._cacheHit = true;
    return schema;
  } catch {
    return null;
  }
}

function saveSchema(templatePath, schema) {
  const cachePath = schemaCachePath(templatePath);
  const out = {
    ...schema,
    version: SCHEMA_VERSION,
    templateFile: path.basename(templatePath),
    templateHash: fileHash(templatePath),
    analyzedAt: new Date().toISOString(),
  };
  fs.writeFileSync(cachePath, JSON.stringify(out, null, 2));
  out._cachePath = cachePath;
  out._cacheHit = false;
  return out;
}

function slugId(label, fallback = 'field') {
  const s = String(label || '')
    .toLowerCase()
    .replace(/\(.*?\)/g, ' ')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 48);
  return s || fallback;
}

function inferFieldTypeFromLabel(label) {
  const n = String(label || '').toLowerCase();
  if (/\bdate\b/.test(n)) return 'date';
  if (/\b(lb|lbs|force|fwd|aft|load|elong)\b/.test(n)) return 'force_lb';
  if (/\b(shot\s*no|catapult|shot since|no\.?$)\b/.test(n)) return 'small_int';
  if (/\b(jsn|periodicity|code|serial|id)\b/.test(n)) return 'id_code';
  if (/\b(cdi|chief|inspector|officer|cpo|name|sign)\b/.test(n)) return 'name_or_initials';
  if (/\b(location|place)\b/.test(n)) return 'text';
  return 'text';
}

function buildAliasList(label) {
  const raw = String(label || '').replace(/:$/, '').trim();
  const norm = raw.toLowerCase();
  const aliases = new Set([norm]);
  aliases.add(norm.replace(/[^a-z0-9]+/g, ' ').trim());
  // short tokens
  for (const part of norm.split(/[^a-z0-9]+/)) {
    if (part.length >= 3) aliases.add(part);
  }
  return [...aliases].filter(Boolean);
}

module.exports = {
  SCHEMA_VERSION,
  schemaDir,
  schemaCachePath,
  fileHash,
  loadCachedSchema,
  saveSchema,
  slugId,
  inferFieldTypeFromLabel,
  buildAliasList,
};
