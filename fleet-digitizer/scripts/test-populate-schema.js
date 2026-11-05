/**
 * Smoke: populate an xlsx master via schema writeTargets only.
 */
const path = require('path');
const fs = require('fs');
const ExcelJS = require('exceljs');
const assert = require('assert');

const { getOrAnalyzeTemplateSchema } = require('../src/services/templateAnalyze');
const { populateTemplate } = require('../src/services/populate');

const TEMPLATES = path.resolve(__dirname, '..', '..', 'Templates');

async function main() {
  const xlsx = fs.readdirSync(TEMPLATES).find((f) => /\.xlsx$/i.test(f));
  assert.ok(xlsx, `No xlsx in ${TEMPLATES}`);
  const master = path.join(TEMPLATES, xlsx);

  const schema = await getOrAnalyzeTemplateSchema(master, { force: false });
  const header = schema.fields.find(
    (f) => f.kind !== 'measurement' && f.writeTarget?.address && f.fieldType !== 'force_lb'
  );
  const meas = schema.fields.find((f) => f.kind === 'measurement' && f.writeTarget?.address);
  assert.ok(header, 'Need a header writeTarget');

  const fields = [
    { id: header.id, value: header.fieldType === 'date' ? '04/11/2026' : '42' },
  ];
  if (meas) fields.push({ id: meas.id, value: '1500' });

  const template = {
    name: path.basename(master),
    path: master,
    type: 'xlsx',
    fields: schema.fields,
    schema,
  };
  const { outPath } = await populateTemplate(template, fields, 'schema-smoke');

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(outPath);
  const ws = wb.worksheets[0];
  const addr = header.writeTarget.address;
  assert.ok(ws.getCell(addr).value != null && String(ws.getCell(addr).value).length > 0);

  console.log(JSON.stringify({
    ok: true,
    template: path.basename(master),
    outPath,
    wrote: {
      [addr]: ws.getCell(addr).value,
      ...(meas ? { [meas.writeTarget.address]: ws.getCell(meas.writeTarget.address).value } : {}),
    },
    via: 'schema.writeTarget',
  }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
