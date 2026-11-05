/**
 * Verify dynamic template schemas via generic analyzer (no form-specific hardcodes).
 * Uses whatever .xlsx masters exist in ../Templates — expects at least two for divergence.
 */
const path = require('path');
const fs = require('fs');
const assert = require('assert');

const { getOrAnalyzeTemplateSchema } = require('../src/services/templateAnalyze');
const { schemaCachePath, SCHEMA_VERSION } = require('../src/services/templateSchema');
const { aliasesFromSchema } = require('../src/services/templates');

const TEMPLATES = path.resolve(__dirname, '..', '..', 'Templates');

function summarize(schema, name) {
  const headers = (schema.fields || []).filter((f) => f.kind !== 'measurement');
  const meas = (schema.fields || []).filter((f) => f.kind === 'measurement');
  return {
    name,
    version: schema.version,
    analyzer: schema.analyzer,
    aiUsed: schema.ai?.used || false,
    titleHints: schema.titleHints,
    headerCount: headers.length,
    measurementCount: meas.length,
    slotSchema: schema.slotLayout?.schema,
    leftShotCount: schema.slotLayout?.leftTable?.shots?.length || 0,
    rightShotCount: schema.slotLayout?.rightTable?.shots?.length || 0,
    headerWrites: headers
      .filter((f) => f.writeTarget?.address)
      .slice(0, 10)
      .map((f) => `${f.id}→${f.writeTarget.address}`),
    cachePath: schema._cachePath,
  };
}

async function main() {
  const xlsx = fs
    .readdirSync(TEMPLATES)
    .filter((f) => /\.xlsx$/i.test(f))
    .map((f) => path.join(TEMPLATES, f));
  assert.ok(xlsx.length >= 2, `Need ≥2 xlsx templates in ${TEMPLATES}`);

  for (const p of xlsx) {
    const c = schemaCachePath(p);
    if (fs.existsSync(c)) fs.unlinkSync(c);
  }

  const schemas = [];
  for (const p of xlsx) {
    schemas.push({ path: p, schema: await getOrAnalyzeTemplateSchema(p, { force: true }) });
  }

  const summaries = schemas.map((s) => summarize(s.schema, path.basename(s.path)));
  console.log(JSON.stringify({ SCHEMA_VERSION, templates: summaries }, null, 2));

  for (const { path: p, schema } of schemas) {
    assert.ok(schema.fields.length > 0, `${path.basename(p)} should discover fields`);
    const withWrite = schema.fields.filter((f) => f.writeTarget?.address || f.writeTarget?.placeholder);
    assert.ok(withWrite.length > 0, `${path.basename(p)} needs writeTargets`);
    assert.ok(Object.keys(aliasesFromSchema(schema)).length >= 1 || schema.fields.some((f) => f.kind === 'measurement'));
  }

  const a = schemas[0].schema;
  const b = schemas[1].schema;
  const aIds = new Set(a.fields.map((f) => f.id));
  const bIds = new Set(b.fields.map((f) => f.id));
  const onlyA = [...aIds].filter((id) => !bIds.has(id));
  const onlyB = [...bIds].filter((id) => !aIds.has(id));
  assert.ok(
    onlyA.length + onlyB.length > 0 ||
      a.slotLayout?.measurementSlots !== b.slotLayout?.measurementSlots ||
      JSON.stringify(a.titleHints) !== JSON.stringify(b.titleHints),
    'Two different masters should yield divergent schemas'
  );

  const again = await getOrAnalyzeTemplateSchema(schemas[0].path, { force: false });
  assert.strictEqual(again._cacheHit, true, 'Second load should hit schema cache');

  // Source hygiene: no form-specific fallback symbols in runtime modules
  const srcRoot = path.join(__dirname, '..', 'src');
  // Built so this test file itself doesn't contain the banned identifiers as plain text
  const forbiddenRes = [
    new RegExp(['ALLOW_', 'SHUT', 'TLE_FALLBACK'].join('')),
    new RegExp(['LEGACY_', 'SHUT', 'TLE'].join('')),
    new RegExp(['\\bFIELD_', 'ALIASES\\b'].join('')),
    new RegExp(['\\bheader', 'Cells\\b'].join('')),
    new RegExp(['legacy', 'Shut', 'tle', 'Field', 'Type', 'For', 'Id'].join('')),
    new RegExp(['shut', 'tle', 'Fallback', 'Allowed'].join('')),
    new RegExp(['applyLegacy', 'Shut', 'tle', 'Header', 'Fallback'].join('')),
  ];
  function walk(dir) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (/\.js$/i.test(ent.name)) {
        const text = fs.readFileSync(p, 'utf8');
        for (const re of forbiddenRes) {
          assert.ok(!re.test(text), `${p} matches forbidden pattern ${re}`);
        }
      }
    }
  }
  walk(srcRoot);

  console.log('\nOK: generic schemas verified');
  console.log(`Divergence: onlyA=${onlyA.length} onlyB=${onlyB.length}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
