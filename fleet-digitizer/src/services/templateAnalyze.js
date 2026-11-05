const ExcelJS = require('exceljs');
const mammoth = require('mammoth');
const {
  slugId,
  inferFieldTypeFromLabel,
  buildAliasList,
  saveSchema,
  loadCachedSchema,
} = require('./templateSchema');
const { consultLocalAi } = require('./templateAiConsult');

function cellText(value) {
  if (value == null) return '';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (typeof value === 'object') {
    if (value.richText) return value.richText.map((r) => r.text).join('');
    if (value.text) return value.text;
    if (value.result != null) return String(value.result);
  }
  return String(value);
}

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

function addr(row, col) {
  return `${colLetter(col)}${row}`;
}

function isEmptyCell(ws, row, col) {
  const v = ws.getCell(row, col).value;
  if (v == null || v === '') return true;
  const t = cellText(v).trim();
  return !t;
}

function findWriteTargetRight(ws, row, startCol, maxLook = 6) {
  // Skip duplicate/merged copies of the same label, then take first empty cell
  const labelText = cellText(ws.getCell(row, startCol).value).trim();
  let col = startCol + 1;
  let skipped = 0;
  while (col <= startCol + maxLook) {
    const t = cellText(ws.getCell(row, col).value).trim();
    if (!t) {
      return { row, col, address: addr(row, col), strategy: 'right_of_label' };
    }
    // identical label text = merged visual label, keep scanning
    if (t === labelText || t.replace(/:$/, '') === labelText.replace(/:$/, '')) {
      skipped += 1;
      col += 1;
      continue;
    }
    // occupied by another label — stop
    if (/:$/.test(t) || t.length > 2) break;
    col += 1;
  }
  // fallback: two columns right of label (common merged-label pattern)
  const fb = startCol + Math.max(2, skipped + 1);
  return { row, col: fb, address: addr(row, fb), strategy: 'right_of_label_fallback' };
}

/**
 * Structural analysis of an Excel master — discovers labels, write cells, and grids
 * from the template itself (not scan coordinates).
 */
async function analyzeXlsxStructure(templatePath) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(templatePath);
  const ws = wb.worksheets[0];

  const matrix = [];
  const maxRow = ws.rowCount || 80;
  const maxCol = ws.columnCount || 20;
  for (let r = 1; r <= maxRow; r++) {
    const row = [];
    for (let c = 1; c <= maxCol; c++) {
      row.push(cellText(ws.getCell(r, c).value).trim());
    }
    matrix.push(row);
  }

  const fingerprint = new Set();
  const labels = [];
  const fields = [];
  const usedWrite = new Set();
  const usedIds = new Set();

  // 1) Header / meta labels ending with : or short form labels
  for (let r = 1; r <= maxRow; r++) {
    for (let c = 1; c <= maxCol; c++) {
      const text = matrix[r - 1][c - 1];
      if (!text) continue;
      fingerprint.add(text.toLowerCase());
      const looksLabel =
        /:$/.test(text) ||
        (/^[A-Za-z][A-Za-z0-9 .\/\-()]{1,40}$/.test(text) &&
          text.length <= 28 &&
          !/^\d+$/.test(text) &&
          isEmptyCell(ws, r, c + 1));
      if (!looksLabel) continue;
      // Skip pure column headers that are part of grids (FWD/AFT alone handled below)
      if (/^(fwd|aft)\b/i.test(text) && /\(.*lb/i.test(text)) continue;

      const write = findWriteTargetRight(ws, r, c);
      if (usedWrite.has(write.address)) continue;
      // Avoid treating grid index numbers' neighbors as headers
      if (/^\d+$/.test(text)) continue;

      let id = slugId(text);
      if (usedIds.has(id)) {
        let i = 2;
        while (usedIds.has(`${id}_${i}`)) i += 1;
        id = `${id}_${i}`;
      }
      usedIds.add(id);
      usedWrite.add(write.address);

      const fieldType = inferFieldTypeFromLabel(text);
      const kind = ['date', 'small_int', 'id_code'].includes(fieldType)
        ? 'header'
        : fieldType === 'name_or_initials'
          ? 'signature_or_meta'
          : 'header';

      const field = {
        id,
        label: text,
        labelNorm: text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(),
        aliases: buildAliasList(text),
        labelAddress: addr(r, c),
        writeTarget: {
          type: 'xlsx_cell',
          address: write.address,
          row: write.row,
          col: write.col,
          strategy: write.strategy,
        },
        kind,
        fieldType,
      };
      labels.push({
        text,
        norm: field.labelNorm,
        address: field.labelAddress,
        row: r,
        col: c,
      });
      fields.push(field);
    }
  }

  // 2) Detect measurement grids: column of consecutive integers + empty cells to the right
  const grids = detectMeasurementGrids(ws, matrix, maxRow, maxCol);
  for (const g of grids) {
    for (const slot of g.slots) {
      if (usedIds.has(slot.id)) continue;
      usedIds.add(slot.id);
      fields.push(slot);
    }
  }

  const slotLayout = buildSlotLayoutFromFields(fields, grids);
  const titleHints = deriveTitleHints([...fingerprint]);

  return {
    type: 'xlsx',
    sheetName: ws.name,
    labels,
    fields,
    fingerprint: [...fingerprint].filter(Boolean),
    titleHints,
    slotLayout,
    grids,
    analyzer: 'structural',
  };
}

function detectMeasurementGrids(ws, matrix, maxRow, maxCol) {
  const grids = [];
  // Find columns that look like 1..N sequence
  for (let c = 1; c <= maxCol; c++) {
    const runs = [];
    let run = [];
    for (let r = 1; r <= maxRow; r++) {
      const t = matrix[r - 1][c - 1];
      const n = Number(t);
      if (t !== '' && Number.isInteger(n) && n > 0 && n < 500) {
        if (!run.length || n === run[run.length - 1].n + 1) {
          run.push({ row: r, n });
        } else {
          if (run.length >= 5) runs.push(run);
          run = [{ row: r, n }];
        }
      } else if (run.length) {
        if (run.length >= 5) runs.push(run);
        run = [];
      }
    }
    if (run.length >= 5) runs.push(run);

    for (const seq of runs) {
      // Look at header cells above sequence for column roles
      const headerRow = Math.max(1, seq[0].row - 1);
      const roles = [];
      for (let dc = 1; dc <= 3; dc++) {
        const hc = c + dc;
        if (hc > maxCol) break;
        const ht = matrix[headerRow - 1]?.[hc - 1] || '';
        const ht2 = matrix[Math.max(0, headerRow - 2)]?.[hc - 1] || '';
        const combined = `${ht} ${ht2}`.toLowerCase();
        let role = `col${dc}`;
        if (/\bfwd\b/.test(combined)) role = 'fwd';
        else if (/\baft\b/.test(combined)) role = 'aft';
        else if (/\binboard\b/.test(combined)) role = 'inboard';
        else if (/\boutboard\b/.test(combined)) role = 'outboard';
        else if (/\b(lb|force|load)\b/.test(combined)) role = `force_${dc}`;
        // Only keep columns that are empty in first data row (writable)
        if (isEmptyCell(ws, seq[0].row, hc) || true) {
          roles.push({ col: hc, role, header: ht || ht2 });
        }
      }
      // Need at least one writable value column
      const valueRoles = roles.filter((r) => r.role !== `col${r.col}` || /\blb|force|fwd|aft/i.test(r.header));
      const useRoles = valueRoles.length ? valueRoles.slice(0, 2) : roles.slice(0, 2);
      if (!useRoles.length) continue;

      const slots = [];
      for (const item of seq) {
        for (const vr of useRoles) {
          const id = `${vr.role}_${item.n}`;
          slots.push({
            id,
            label: `${vr.header || vr.role} #${item.n}`,
            labelNorm: `${vr.role} ${item.n}`,
            aliases: [vr.role, String(item.n), `${vr.role} ${item.n}`],
            labelAddress: addr(item.row, c),
            writeTarget: {
              type: 'xlsx_cell',
              address: addr(item.row, vr.col),
              row: item.row,
              col: vr.col,
              strategy: 'grid',
            },
            kind: 'measurement',
            fieldType: 'force_lb',
            grid: {
              indexCol: c,
              index: item.n,
              columnRole: vr.role,
              valueCol: vr.col,
            },
          });
        }
      }

      grids.push({
        indexCol: c,
        startRow: seq[0].row,
        endRow: seq[seq.length - 1].row,
        indices: seq.map((s) => s.n),
        valueColumns: useRoles,
        slots,
      });
    }
  }

  // Deduplicate overlapping grids (prefer longer runs)
  grids.sort((a, b) => b.slots.length - a.slots.length);
  const kept = [];
  const claimed = new Set();
  for (const g of grids) {
    const key = `${g.indexCol}:${g.startRow}-${g.endRow}`;
    const overlap = g.indices.some((n) => claimed.has(`${g.indexCol}:${n}`));
    if (overlap) continue;
    for (const n of g.indices) claimed.add(`${g.indexCol}:${n}`);
    kept.push(g);
  }
  return kept;
}

function buildSlotLayoutFromFields(fields, grids) {
  const measurements = fields.filter((f) => f.kind === 'measurement');
  const headers = fields.filter((f) => f.kind !== 'measurement');
  const sorted = [...grids].sort((a, b) => a.indexCol - b.indexCol);
  const tableSummaries = sorted.map((g, i) => ({
    id: `grid_${i + 1}`,
    indexCol: g.indexCol,
    indices: g.indices,
    valueColumns: g.valueColumns.map((v) => ({
      col: v.col,
      role: v.role,
      header: v.header,
    })),
    slotCount: g.slots.length,
  }));

  // Dual-table scan geometry (left/right) derived from detected template grids
  const left = sorted[0] || null;
  const right = sorted[1] || null;
  function tableView(g) {
    if (!g) return null;
    const roles = g.valueColumns.map((v) => v.role);
    return {
      shots: g.indices.slice(),
      columns: ['index', ...roles],
      valueColumns: roles,
      indexCol: g.indexCol,
      excelValueCols: g.valueColumns.map((v) => ({ role: v.role, col: v.col })),
    };
  }

  return {
    schema:
      sorted.length >= 2
        ? 'multi_grid'
        : sorted.length === 1
          ? 'single_grid'
          : 'generic',
    headerSlots: headers.length,
    measurementSlots: measurements.length,
    expectedHandwrittenDataCells: measurements.length,
    grids: tableSummaries,
    leftTable: tableView(left),
    rightTable: tableView(right),
    dataRows: sorted.reduce((m, g) => Math.max(m, g.indices.length), 0),
    hasMeasurementGrid: measurements.length > 0,
  };
}

function deriveTitleHints(terms) {
  // Extract distinctive tokens from the template fingerprint itself (no form-specific allowlist)
  const STOP = new Set([
    'the', 'and', 'for', 'with', 'from', 'that', 'this', 'test', 'form', 'empty',
    'template', 'sheet', 'page', 'note', 'notes', 'of', 'to', 'in', 'on', 'at',
    'lb', 'lbs', 'no', 'or', 'by', 'as', 'an', 'a',
  ]);
  const counts = new Map();
  for (const term of terms || []) {
    for (const tok of String(term).toLowerCase().split(/[^a-z0-9]+/)) {
      if (tok.length < 3 || STOP.has(tok) || /^\d+$/.test(tok)) continue;
      counts.set(tok, (counts.get(tok) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 16)
    .map(([tok]) => tok);
}

async function analyzeDocxStructure(templatePath) {
  const result = await mammoth.extractRawText({ path: templatePath });
  const text = result.value || '';
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const fingerprint = lines.map((l) => l.toLowerCase());
  const fields = [];
  const labels = [];
  const used = new Set();

  for (const line of lines) {
    const matches = [...line.matchAll(/([A-Za-z][A-Za-z0-9 .\/\-()]{1,40}):/g)];
    for (const m of matches) {
      const label = m[1].trim() + ':';
      let id = slugId(label);
      if (used.has(id)) continue;
      used.add(id);
      labels.push({ text: label, norm: id.replace(/_/g, ' '), address: null });
      fields.push({
        id,
        label,
        labelNorm: id.replace(/_/g, ' '),
        aliases: buildAliasList(label),
        labelAddress: null,
        writeTarget: {
          type: 'docx_placeholder',
          placeholder: `{{${id}}}`,
          strategy: 'named_placeholder',
        },
        kind: 'header',
        fieldType: inferFieldTypeFromLabel(label),
      });
    }
  }

  return {
    type: 'docx',
    labels,
    fields,
    fingerprint,
    titleHints: deriveTitleHints(fingerprint),
    slotLayout: buildSlotLayoutFromFields(fields, []),
    grids: [],
    rawText: text,
    analyzer: 'structural',
  };
}

/**
 * Analyze template → schema (cache-aware). Optional local LLM enrichment.
 */
async function getOrAnalyzeTemplateSchema(templatePath, { force = false } = {}) {
  if (!force) {
    const cached = loadCachedSchema(templatePath);
    if (cached) return cached;
  }

  const ext = templatePath.toLowerCase().slice(templatePath.lastIndexOf('.'));
  let structural =
    ext === '.xlsx'
      ? await analyzeXlsxStructure(templatePath)
      : await analyzeDocxStructure(templatePath);

  const enriched = await consultLocalAi(structural, templatePath);
  const schema = saveSchema(templatePath, {
    ...enriched,
    sourcePath: templatePath,
  });
  return schema;
}

module.exports = {
  analyzeXlsxStructure,
  analyzeDocxStructure,
  getOrAnalyzeTemplateSchema,
  detectMeasurementGrids,
  deriveTitleHints,
};
