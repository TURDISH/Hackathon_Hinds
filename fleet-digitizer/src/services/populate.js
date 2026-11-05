const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');
const PizZip = require('pizzip');
const Docxtemplater = require('docxtemplater');
const config = require('../config');

function colLetter(col) {
  let n = col;
  let s = '';
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/**
 * Write field values using the cached template schema writeTargets only.
 */
async function populateXlsx(templatePath, fields, outPath, schema = null) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(templatePath);
  const ws = wb.worksheets[0];

  const byId = Object.fromEntries(fields.map((f) => [f.id, f]));
  const schemaFields = schema?.fields || [];

  if (!schemaFields.length) {
    throw new Error(
      'No template schema write targets available. Re-preprocess the master template (POST /api/templates/reprocess).'
    );
  }

  let wrote = 0;
  for (const sf of schemaFields) {
    const val = byId[sf.id]?.value;
    if (val == null || val === '') continue;
    const target = sf.writeTarget || sf.valueTarget;
    if (!target) continue;
    let address = target.address;
    if (!address && target.row && target.col) {
      address = `${colLetter(target.col)}${target.row}`;
    }
    if (!address) continue;
    const numeric = Number(val);
    ws.getCell(address).value =
      sf.fieldType === 'force_lb' && isFinite(numeric) ? numeric : val;
    wrote += 1;
  }

  if (wrote === 0 && fields.some((f) => f.value)) {
    throw new Error(
      'Schema has no usable write targets for filled fields. Re-preprocess the master template.'
    );
  }

  await wb.xlsx.writeFile(outPath);
  return outPath;
}

async function populateDocx(templatePath, fields, outPath, schema = null) {
  const content = fs.readFileSync(templatePath);
  const zip = new PizZip(content);

  const hasPlaceholders = content.toString('utf8').includes('{{');

  if (hasPlaceholders) {
    const doc = new Docxtemplater(zip, {
      paragraphLoop: true,
      linebreaks: true,
      delimiters: { start: '{{', end: '}}' },
    });
    const data = {};
    for (const f of fields) data[f.id] = f.value || '';
    for (const sf of schema?.fields || []) {
      const ph = sf.writeTarget?.placeholder;
      if (ph) {
        const key = ph.replace(/^\{\{|\}\}$/g, '');
        data[key] = byIdValue(fields, sf.id);
      }
    }
    doc.render(data);
    const buf = doc.getZip().generate({ type: 'nodebuffer' });
    fs.writeFileSync(outPath, buf);
    return outPath;
  }

  let xml = zip.file('word/document.xml').asText();
  const rows = fields
    .filter((f) => f.value && f.kind !== 'measurement')
    .map(
      (f) =>
        `<w:p><w:r><w:t>${escapeXml(f.label || f.id)}: ${escapeXml(f.value)}</w:t></w:r></w:p>`
    )
    .join('');

  const block = `<w:p><w:r><w:t>—— Digitized field values ——</w:t></w:r></w:p>${rows}`;
  if (xml.includes('</w:body>')) {
    xml = xml.replace('</w:body>', `${block}</w:body>`);
  } else {
    xml += block;
  }
  zip.file('word/document.xml', xml);
  fs.writeFileSync(outPath, zip.generate({ type: 'nodebuffer' }));
  return outPath;
}

function byIdValue(fields, id) {
  const f = fields.find((x) => x.id === id);
  return f?.value || '';
}

function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function populateTemplate(template, fields, jobId) {
  fs.mkdirSync(config.paths.outputs, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const base = path.parse(template.name).name;
  const ext = template.type === 'xlsx' ? '.xlsx' : '.docx';
  const outName = `${base}__filled__${stamp}${ext}`;
  const outPath = path.join(config.paths.outputs, outName);

  const schema = template.schema || {
    fields: template.fields,
    slotLayout: template.slotLayout,
  };

  if (template.type === 'xlsx') {
    await populateXlsx(template.path, fields, outPath, schema);
  } else {
    await populateDocx(template.path, fields, outPath, schema);
  }

  return { outPath, outName };
}

module.exports = { populateTemplate };
