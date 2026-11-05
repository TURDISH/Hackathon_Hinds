const POPUP_CONF_THRESHOLD = 50;

const state = {
  job: null,
  templates: [],
  onlyLow: true,
  reviewQueue: [],
  reviewIndex: 0,
  reviewOpen: false,
  reviewAutoStarted: false,
};

const $ = (sel) => document.querySelector(sel);

async function api(path, opts = {}) {
  let res;
  try {
    res = await fetch(path, opts);
  } catch (err) {
    const msg = String(err?.message || err);
    if (/failed to fetch|networkerror|load failed/i.test(msg)) {
      throw new Error(
        `Cannot reach digitizer server (http://localhost:3847). Is it running? Start with: npm start`
      );
    }
    throw err;
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText || `HTTP ${res.status}`);
  return data;
}

function setStatus(msg, isError = false) {
  const el = $('#statusBar');
  el.textContent = msg;
  el.classList.remove('hidden');
  el.classList.toggle('error', isError);
}

function clearStatus() {
  $('#statusBar').classList.add('hidden');
}

function showProgressPanel(show) {
  $('#progressPanel').classList.toggle('hidden', !show);
}

function renderProgress(progress) {
  if (!progress) return;
  showProgressPanel(true);
  const pct = Math.max(0, Math.min(100, Number(progress.percent) || 0));
  $('#progressStep').textContent = progress.label || progress.step || 'Processing…';
  $('#progressPct').textContent = `${pct.toFixed(pct >= 10 ? 0 : 1)}%`;
  $('#progressFill').style.width = `${pct}%`;
  $('#progressTrack').setAttribute('aria-valuenow', String(Math.round(pct)));
  let detail = progress.detail || '';
  if (progress.fraction?.total) {
    detail = detail
      ? `${detail} · ${progress.fraction.current}/${progress.fraction.total}`
      : `${progress.fraction.current}/${progress.fraction.total}`;
  }
  $('#progressDetail').textContent = detail || 'Working…';
  const eta =
    progress.etaLabel ||
    (progress.etaSeconds == null
      ? 'Estimating time…'
      : progress.etaSeconds <= 0
        ? 'Almost done'
        : `ETA ${progress.etaLabel || `~${progress.etaSeconds}s`}`);
  $('#progressEta').textContent = eta;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function pollJobUntilDone(id, { intervalMs = 800 } = {}) {
  let job = null;
  for (;;) {
    const data = await api(`/api/jobs/${id}`);
    job = data.job;
    if (job.progress) renderProgress(job.progress);
    if (job.status === 'review' || job.status === 'finalized') return job;
    if (job.status === 'error') {
      throw new Error(job.error || 'Processing failed');
    }
    await sleep(intervalMs);
  }
}

function switchTab(name) {
  document.querySelectorAll('.tab').forEach((t) => {
    t.classList.toggle('active', t.dataset.tab === name);
  });
  document.querySelectorAll('.panel').forEach((p) => {
    p.classList.toggle('active', p.id === `panel-${name}`);
  });
}

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => switchTab(tab.dataset.tab));
});

function formatStackLine(h) {
  if (h.stackNote) {
    return `${h.stackNote} · review <${h.threshold}% · ${h.templatesDir}`;
  }
  const hand = h.handwritingOcr || h.ocrProvider || 'tesseract';
  const ai = h.templateAi?.available
    ? `${h.templateAi.provider || 'ollama'}/${h.templateAi.model || 'local'} (schema only)`
    : 'off (structural schema only)';
  return `Handwriting: ${hand} · Template AI: ${ai} · review <${h.threshold}% · ${h.templatesDir}`;
}

async function loadHealth() {
  try {
    const h = await api('/api/health');
    $('#healthLine').textContent = formatStackLine(h);
  } catch (err) {
    $('#healthLine').textContent = `Health check failed: ${err.message}`;
  }
}

async function loadTemplates() {
  const data = await api('/api/templates');
  state.templates = data.templates || [];
  renderTemplates();
  if (state.job) renderMatch();
}

function renderTemplates() {
  const root = $('#tplList');
  if (!state.templates.length) {
    root.innerHTML = '<p class="meta">No templates yet. Upload a .docx or .xlsx master.</p>';
    return;
  }
  root.innerHTML = state.templates
    .map(
      (t) => `
      <article class="tpl">
        <h3>${escapeHtml(t.name)}</h3>
        <div class="tags">
          <span class="tag">${escapeHtml(t.type)}</span>
          <span class="tag">${t.fieldCount} fields</span>
          ${(t.titleHints || []).map((h) => `<span class="tag">${escapeHtml(h)}</span>`).join('')}
        </div>
        <div class="tpl-actions">
          <button class="btn danger" data-del="${t.id}" type="button">Remove</button>
        </div>
      </article>`
    )
    .join('');

  root.querySelectorAll('[data-del]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('Delete this template from the repository?')) return;
      await api(`/api/templates/${btn.dataset.del}`, { method: 'DELETE' });
      await loadTemplates();
    });
  });
}

$('#tplInput').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  const fd = new FormData();
  fd.append('file', file);
  setStatus(`Uploading template ${file.name}…`);
  try {
    await api('/api/templates', { method: 'POST', body: fd });
    await loadTemplates();
    setStatus(`Template added: ${file.name}`);
  } catch (err) {
    setStatus(err.message, true);
  } finally {
    e.target.value = '';
  }
});

const drop = $('#dropzone');
const scanInput = $('#scanInput');

['dragenter', 'dragover'].forEach((ev) => {
  drop.addEventListener(ev, (e) => {
    e.preventDefault();
    drop.classList.add('drag');
  });
});
['dragleave', 'drop'].forEach((ev) => {
  drop.addEventListener(ev, (e) => {
    e.preventDefault();
    drop.classList.remove('drag');
  });
});
drop.addEventListener('drop', (e) => {
  const file = e.dataTransfer.files?.[0];
  if (file) handleScan(file);
});
scanInput.addEventListener('change', (e) => {
  const file = e.target.files?.[0];
  if (file) handleScan(file);
});

async function handleScan(file) {
  const fd = new FormData();
  fd.append('file', file);
  $('#workspace').classList.add('hidden');
  $('#btnFinalize').disabled = true;
  showProgressPanel(true);
  renderProgress({
    step: 'queued',
    label: 'Uploading scan',
    detail: file.name,
    percent: 1,
    etaSeconds: null,
  });
  setStatus(`Uploading ${file.name}…`);

  try {
    const { job: started } = await api('/api/jobs', { method: 'POST', body: fd });
    setStatus(`Processing ${file.name}…`);
    if (started.progress) renderProgress(started.progress);
    const job = await pollJobUntilDone(started.id);
    state.job = job;
    state.reviewAutoStarted = false;
    renderWorkspace();
    showProgressPanel(false);
    const popupN = fieldsNeedingPopupReview().length;
    setStatus(
      `Matched “${state.job.selectedTemplateName || 'none'}” · ${popupN} handwriting field${popupN === 1 ? '' : 's'} under ${POPUP_CONF_THRESHOLD}% for popup review`
    );
    maybeStartReviewPopup();
  } catch (err) {
    showProgressPanel(false);
    setStatus(err.message, true);
  }
}

async function refreshJob(id) {
  const { job } = await api(`/api/jobs/${id}`);
  state.job = job;
  renderWorkspace();
}

function renderWorkspace() {
  const job = state.job;
  if (!job) return;
  $('#workspace').classList.remove('hidden');
  $('#scanMeta').textContent = job.originalName || '';
  $('#ocrText').textContent = job.ocr?.text || '';
  const page = job.pages?.[0];
  const img = $('#scanPreview');
  img.onload = () => {
    if (state.reviewOpen) paintReviewCrop(currentReviewField());
  };
  img.src = page?.url || '';
  renderMatch();
  renderFields();
  $('#btnFinalize').disabled = job.status === 'error' || !job.selectedTemplateId;
  const popupN = fieldsNeedingPopupReview().length;
  const btnReview = $('#btnReviewLow');
  if (btnReview) {
    btnReview.disabled = popupN === 0 || job.status === 'error';
    btnReview.textContent =
      popupN > 0 ? `Review <${POPUP_CONF_THRESHOLD}% (${popupN})` : `Review <${POPUP_CONF_THRESHOLD}%`;
  }
  const stats = job.mappingStats || {};
  const vision = job.grid?.handwritingStack?.vision;
  const vMode = job.grid?.handwritingStack?.mode;
  const hand = vision?.available
    ? (vMode === 'batch'
      ? `vision/${vision.model || 'local'} batch bands (+ residual)`
      : vMode === 'primary'
        ? `vision/${vision.model || 'local'} primary (+ Tesseract fallback)`
        : `Tesseract + vision/${vision.model || 'local'} (${vMode || 'hybrid'})`)
    : (job.ocr?.provider || 'tesseract');
  const tplAi = job.templateSchema?.ai?.used
    ? `${job.templateSchema.ai.provider || 'ollama'}/${job.templateSchema.ai.model || 'local'} (schema)`
    : (job.templateSchema ? 'schema cache' : '—');
  $('#reviewMeta').textContent = job.ocr
    ? `Handwriting: ${hand} · Template AI: ${tplAi} · grid filled ${stats.measurementFilled || 0}/${stats.measurementSlots || 0} · ink ${job.grid?.handwrittenCells ?? '—'} · popup <${POPUP_CONF_THRESHOLD}%: ${popupN}`
    : '';
  const note = $('#stackNote');
  if (note) {
    note.textContent = `Handwriting: ${hand} · Template AI: ${tplAi}`;
  }
}

/** Handwritten / OCR cells for sequential popup — gate is confidence < 50%. */
function isHandwritingField(f) {
  if (!f) return false;
  if (f.kind === 'measurement') return true;
  if (f.source?.hasInk) return true;
  if (f.source?.typedOcr) return true;
  const m = String(f.source?.method || '');
  return /vision|tess|ocr|force|weak|batch|digit/i.test(m);
}

function fieldsNeedingPopupReview() {
  const fields = state.job?.fields || [];
  return fields.filter((f) => {
    if (!isHandwritingField(f)) return false;
    if (f.source?.method === 'human_corrected' || f.source?.method === 'human_reviewed') return false;
    const conf = Number(f.confidence) || 0;
    return conf < POPUP_CONF_THRESHOLD;
  });
}

function maybeStartReviewPopup() {
  if (state.reviewAutoStarted) return;
  const queue = fieldsNeedingPopupReview();
  if (!queue.length) return;
  state.reviewAutoStarted = true;
  openReviewPopup(queue);
}

function openReviewPopup(queue) {
  state.reviewQueue = queue.map((f) => f.id);
  state.reviewIndex = 0;
  state.reviewOpen = true;
  $('#reviewModal').classList.remove('hidden');
  showReviewStep();
  const input = $('#reviewValueInput');
  input?.focus();
  input?.select();
}

function closeReviewPopup() {
  state.reviewOpen = false;
  state.reviewQueue = [];
  state.reviewIndex = 0;
  $('#reviewModal').classList.add('hidden');
  renderFields();
  const left = fieldsNeedingPopupReview().length;
  const btnReview = $('#btnReviewLow');
  if (btnReview) {
    btnReview.disabled = left === 0;
    btnReview.textContent =
      left > 0 ? `Review <${POPUP_CONF_THRESHOLD}% (${left})` : `Review <${POPUP_CONF_THRESHOLD}%`;
  }
  if (left === 0) {
    setStatus('All <50% handwriting fields reviewed — ready to finalize');
  }
}

function currentReviewField() {
  const id = state.reviewQueue[state.reviewIndex];
  return (state.job?.fields || []).find((f) => f.id === id) || null;
}

function fieldCropBox(f) {
  if (!f?.source) return null;
  if (f.source.cellBBox) return f.source.cellBBox;
  if (f.source.inkBBox) return f.source.inkBBox;
  if (f.source.valueBBoxes?.length) return f.source.valueBBoxes[0];
  return null;
}

function paintReviewCrop(field) {
  const canvas = $('#reviewCrop');
  const img = $('#scanPreview');
  const hint = $('#reviewCropHint');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const box = fieldCropBox(field);
  if (!img?.naturalWidth || !box || box.x1 <= box.x0 || box.y1 <= box.y0) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (hint) hint.textContent = 'No cell snap for this field';
    return;
  }
  const pad = 4;
  const sx = Math.max(0, Math.floor(box.x0 - pad));
  const sy = Math.max(0, Math.floor(box.y0 - pad));
  const sw = Math.min(img.naturalWidth - sx, Math.ceil(box.x1 - box.x0 + pad * 2));
  const sh = Math.min(img.naturalHeight - sy, Math.ceil(box.y1 - box.y0 + pad * 2));
  const maxW = 320;
  const maxH = 160;
  const scale = Math.min(maxW / Math.max(1, sw), maxH / Math.max(1, sh), 4);
  const dw = Math.max(1, Math.round(sw * scale));
  const dh = Math.max(1, Math.round(sh * scale));
  canvas.width = dw;
  canvas.height = dh;
  ctx.imageSmoothingEnabled = true;
  ctx.clearRect(0, 0, dw, dh);
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, dw, dh);
  if (hint) hint.textContent = `${Math.round(sw)}×${Math.round(sh)}px snap`;
}

function showReviewStep() {
  const field = currentReviewField();
  const total = state.reviewQueue.length;
  const n = state.reviewIndex + 1;
  $('#reviewModalProgress').textContent = total ? `${n} / ${total}` : '';
  if (!field) {
    closeReviewPopup();
    return;
  }
  $('#reviewModalLabel').textContent =
    `${field.label || field.id} · OCR ${Math.round(Number(field.confidence) || 0)}%` +
    (field.value ? ` · “${field.value}”` : ' · blank');
  const input = $('#reviewValueInput');
  input.value = field.value || '';
  paintReviewCrop(field);
  const nextBtn = $('#btnReviewNext');
  if (nextBtn) nextBtn.textContent = n >= total ? 'Done' : 'Next';
  input.focus();
  input.select();
}

function applyReviewValue({ skip = false } = {}) {
  const field = currentReviewField();
  if (!field) {
    closeReviewPopup();
    return;
  }
  if (!skip) {
    const input = $('#reviewValueInput');
    field.value = (input?.value || '').trim();
    field.confidence = 100;
    field.lowConfidence = false;
    field.needsReview = false;
    field.source = {
      ...(field.source || {}),
      method: 'human_reviewed',
      reviewedAt: new Date().toISOString(),
    };
  }
  state.reviewIndex += 1;
  if (state.reviewIndex >= state.reviewQueue.length) {
    closeReviewPopup();
    // Persist corrections so finalize/download uses them even if page refreshes mid-session
    persistReviewedFields().catch(() => {});
    return;
  }
  showReviewStep();
}

async function persistReviewedFields() {
  if (!state.job?.id) return;
  await api(`/api/jobs/${state.job.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: state.job.fields }),
  });
}

function renderMatch() {
  const job = state.job;
  const root = $('#matchCard');
  if (!job?.match?.best) {
    root.innerHTML = '<p>No template match yet.</p>';
    return;
  }
  const opts = (job.match.candidates || [])
    .map(
      (c) =>
        `<option value="${c.templateId}" ${c.templateId === job.selectedTemplateId ? 'selected' : ''}>${escapeHtml(c.name)} — score ${c.score}</option>`
    )
    .join('');
  const reasons = (job.match.best.reasons || [])
    .map((r) => `<li>${escapeHtml(r)}</li>`)
    .join('');

  root.innerHTML = `
    <h3>Best match: ${escapeHtml(job.match.best.name)} <span class="meta">(${job.match.best.score}/100)</span></h3>
    <ul>${reasons || '<li>Scored by printed labels / title fingerprint</li>'}</ul>
    <label class="meta">Override template
      <select id="tplSelect">${opts}</select>
    </label>
  `;
  $('#tplSelect')?.addEventListener('change', async (e) => {
    await api(`/api/jobs/${job.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ templateId: e.target.value }),
    });
    await refreshJob(job.id);
  });
}

function sortedFields() {
  const fields = [...(state.job?.fields || [])];
  // Prefer header / signature fields in review; measurements after
  fields.sort((a, b) => {
    const al = a.lowConfidence || a.needsReview ? 0 : 1;
    const bl = b.lowConfidence || b.needsReview ? 0 : 1;
    if (state.onlyLow && al !== bl) return al - bl;
    const am = a.id.startsWith('fwd_') || a.id.startsWith('aft_') ? 1 : 0;
    const bm = b.id.startsWith('fwd_') || b.id.startsWith('aft_') ? 1 : 0;
    if (am !== bm) return am - bm;
    return String(a.label || a.id).localeCompare(String(b.label || b.id));
  });
  if (state.onlyLow) {
    const low = fields.filter((f) => f.lowConfidence || f.needsReview || !f.value);
    const headers = fields.filter(
      (f) =>
        !f.id.startsWith('fwd_') &&
        !f.id.startsWith('aft_') &&
        !low.includes(f)
    );
    // Cap list but keep all low-confidence measurements visible first
    return [...low, ...headers].slice(0, 200);
  }
  return fields.slice(0, 250);
}

function renderFields() {
  const root = $('#fieldList');
  const fields = sortedFields();
  root.innerHTML = fields
    .map((f) => {
      const low = f.lowConfidence || f.needsReview || Number(f.confidence) < (state.job.threshold || 70);
      return `
        <div class="field ${low ? 'low' : ''}" data-id="${escapeHtml(f.id)}">
          <label>${escapeHtml(f.label || f.id)}</label>
          <input type="text" value="${escapeAttr(f.value || '')}" data-field="${escapeHtml(f.id)}" />
          <span class="conf">${Math.round(Number(f.confidence) || 0)}%</span>
        </div>`;
    })
    .join('');

  root.querySelectorAll('input[data-field]').forEach((input) => {
    input.addEventListener('change', () => {
      const id = input.dataset.field;
      const field = state.job.fields.find((f) => f.id === id);
      if (!field) return;
      field.value = input.value;
      field.confidence = 100;
      field.lowConfidence = false;
      field.needsReview = false;
      field.source = { ...(field.source || {}), method: 'human_corrected' };
      input.closest('.field').classList.remove('low');
      input.closest('.field').querySelector('.conf').textContent = '100%';
    });
  });
}

$('#onlyLow').addEventListener('change', (e) => {
  state.onlyLow = e.target.checked;
  renderFields();
});

$('#btnReviewLow')?.addEventListener('click', () => {
  const queue = fieldsNeedingPopupReview();
  if (!queue.length) {
    setStatus('No handwriting fields under 50% confidence');
    return;
  }
  openReviewPopup(queue);
});

$('#btnReviewNext')?.addEventListener('click', () => applyReviewValue({ skip: false }));
$('#btnReviewSkip')?.addEventListener('click', () => applyReviewValue({ skip: true }));

$('#reviewValueInput')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    applyReviewValue({ skip: false });
  } else if (e.key === 'Escape') {
    e.preventDefault();
    closeReviewPopup();
  }
});

$('#btnFinalize').addEventListener('click', async () => {
  if (!state.job) return;
  setStatus('Writing populated template…');
  try {
    const { job } = await api(`/api/jobs/${state.job.id}/finalize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fields: state.job.fields,
        templateId: state.job.selectedTemplateId,
      }),
    });
    state.job = job;
    setStatus(`Saved ${job.output.name} — downloading…`);
    window.location.href = job.output.url;
  } catch (err) {
    setStatus(err.message, true);
  }
});

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
function escapeAttr(s) {
  return escapeHtml(s).replace(/'/g, '&#39;');
}

loadHealth();
loadTemplates();
