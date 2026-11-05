/**
 * Local AI consult during template preprocessing.
 *
 * Providers (first that works):
 *  1. Ollama — http://127.0.0.1:11434/api/chat (TEMPLATE_AI_PROVIDER=ollama)
 *  2. OpenAI-compatible local server — TEMPLATE_AI_BASE_URL + /chat/completions
 *  3. Structural-only fallback (no network) when AI unavailable
 *
 * Env:
 *  TEMPLATE_AI_ENABLED=true|false   (default: true — tries local, falls back)
 *  TEMPLATE_AI_PROVIDER=ollama|openai_compat|off
 *  TEMPLATE_AI_BASE_URL=http://127.0.0.1:11434
 *  TEMPLATE_AI_MODEL=llama3.2
 *  TEMPLATE_AI_API_KEY=             (optional for local servers)
 *  TEMPLATE_AI_TIMEOUT_MS=12000
 */

const DEFAULT_TIMEOUT = Number(process.env.TEMPLATE_AI_TIMEOUT_MS || 180000);

function enabled() {
  const v = (process.env.TEMPLATE_AI_ENABLED || 'true').toLowerCase();
  return v !== '0' && v !== 'false' && v !== 'off';
}

function provider() {
  return (process.env.TEMPLATE_AI_PROVIDER || 'ollama').toLowerCase();
}

function modelName() {
  return process.env.TEMPLATE_AI_MODEL || 'gemma4:e2b';
}

function baseUrl() {
  return (process.env.TEMPLATE_AI_BASE_URL || 'http://127.0.0.1:11434').replace(/\/$/, '');
}

async function fetchWithTimeout(url, options, ms = DEFAULT_TIMEOUT) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

function buildPrompt(structural) {
  // Keep prompt small — large grids blow CPU latency on local LLMs
  const headerFields = (structural.fields || []).filter((f) => f.kind !== 'measurement');
  const sampleMeas = (structural.fields || []).filter((f) => f.kind === 'measurement').slice(0, 8);
  const compact = {
    type: structural.type,
    labels: (structural.labels || []).slice(0, 40).map((l) => ({
      text: l.text,
      address: l.address,
    })),
    fields: [...headerFields.slice(0, 40), ...sampleMeas].map((f) => ({
      id: f.id,
      label: f.label,
      write: f.writeTarget?.address || f.writeTarget?.placeholder,
      kind: f.kind,
      fieldType: f.fieldType,
      grid: f.grid ? { index: f.grid.index, role: f.grid.columnRole } : undefined,
    })),
    measurementSlots: (structural.fields || []).filter((f) => f.kind === 'measurement').length,
    slotLayout: {
      schema: structural.slotLayout?.schema,
      headerSlots: structural.slotLayout?.headerSlots,
      measurementSlots: structural.slotLayout?.measurementSlots,
      dataRows: structural.slotLayout?.dataRows,
    },
    titleHints: structural.titleHints,
  };

  return `You are analyzing a fleet SOP form master template. Return ONLY valid JSON (no markdown).

Given the structural analysis below, refine:
1) fieldType for each field — one of: date, force_lb, small_int, id_code, name_or_initials, text, measurement_grid, checkbox, unknown
2) aliases — short synonyms from the printed label (array of strings)
3) writeTarget confirmations — keep existing addresses unless clearly wrong
4) titleHints — keywords that identify this form family
5) confidence — 0..1 for the overall schema quality

Respond with:
{
  "fields": [ { "id": "...", "fieldType": "...", "aliases": ["..."], "notes": "..." } ],
  "titleHints": ["..."],
  "confidence": 0.0,
  "summary": "one sentence"
}

STRUCTURAL_ANALYSIS:
${JSON.stringify(compact)}`;
}

function extractJson(text) {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = fenced ? fenced[1] : text;
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end < 0) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
}

async function callOllama(prompt) {
  const url = `${baseUrl()}/api/chat`;
  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: modelName(),
      stream: false,
      format: 'json',
      think: false,
      options: { temperature: 0.1 },
      messages: [
        { role: 'system', content: 'You refine form template schemas. Reply with JSON only. No chain-of-thought.' },
        { role: 'user', content: prompt },
      ],
    }),
  });
  if (!res.ok) throw new Error(`Ollama HTTP ${res.status}`);
  const data = await res.json();
  return data?.message?.content || '';
}

async function callOpenAiCompat(prompt) {
  const url = `${baseUrl()}/chat/completions`;
  const headers = { 'Content-Type': 'application/json' };
  if (process.env.TEMPLATE_AI_API_KEY) {
    headers.Authorization = `Bearer ${process.env.TEMPLATE_AI_API_KEY}`;
  }
  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: modelName(),
      temperature: 0.1,
      messages: [
        { role: 'system', content: 'You refine form template schemas. Reply with JSON only.' },
        { role: 'user', content: prompt },
      ],
    }),
  });
  if (!res.ok) throw new Error(`OpenAI-compat HTTP ${res.status}`);
  const data = await res.json();
  return data?.choices?.[0]?.message?.content || '';
}

async function probeLocalAi() {
  if (!enabled() || provider() === 'off') {
    return { available: false, reason: 'disabled' };
  }
  try {
    if (provider() === 'openai_compat') {
      const res = await fetchWithTimeout(`${baseUrl()}/models`, { method: 'GET' }, 3000);
      return { available: res.ok, reason: res.ok ? 'openai_compat' : `http_${res.status}` };
    }
    const res = await fetchWithTimeout(`${baseUrl()}/api/tags`, { method: 'GET' }, 3000);
    return { available: res.ok, reason: res.ok ? 'ollama' : `http_${res.status}` };
  } catch (err) {
    return { available: false, reason: err.message || 'unreachable' };
  }
}

function mergeAiIntoStructural(structural, ai) {
  if (!ai || typeof ai !== 'object') {
    return {
      ...structural,
      ai: { used: false, reason: 'no_parse' },
    };
  }

  const byId = new Map((ai.fields || []).map((f) => [f.id, f]));
  const fields = (structural.fields || []).map((f) => {
    const patch = byId.get(f.id);
    if (!patch) return f;
    return {
      ...f,
      fieldType: patch.fieldType || f.fieldType,
      aliases: Array.isArray(patch.aliases) && patch.aliases.length
        ? [...new Set([...(f.aliases || []), ...patch.aliases])]
        : f.aliases,
      aiNotes: patch.notes || undefined,
    };
  });

  const titleHints = [
    ...new Set([...(structural.titleHints || []), ...(ai.titleHints || [])]),
  ];

  return {
    ...structural,
    fields,
    titleHints,
    ai: {
      used: true,
      confidence: typeof ai.confidence === 'number' ? ai.confidence : null,
      summary: ai.summary || null,
      provider: provider(),
      model: modelName(),
    },
  };
}

/**
 * Enrich structural schema with local LLM when available.
 * Never throws — always returns a usable schema object.
 */
async function consultLocalAi(structural, templatePath) {
  const probe = await probeLocalAi();
  if (!probe.available) {
    return {
      ...structural,
      ai: {
        used: false,
        reason: probe.reason,
        note: 'Structural analyzer only. Start Ollama or set TEMPLATE_AI_* to enable enrichment.',
      },
    };
  }

  try {
    const prompt = buildPrompt(structural);
    const raw =
      provider() === 'openai_compat'
        ? await callOpenAiCompat(prompt)
        : await callOllama(prompt);
    const parsed = extractJson(raw);
    if (!parsed) {
      return {
        ...structural,
        ai: { used: false, reason: 'unparseable_response', provider: provider() },
      };
    }
    return mergeAiIntoStructural(structural, parsed);
  } catch (err) {
    return {
      ...structural,
      ai: {
        used: false,
        reason: err.message || 'consult_failed',
        provider: provider(),
        templatePath,
      },
    };
  }
}

module.exports = {
  consultLocalAi,
  probeLocalAi,
  buildPrompt,
  extractJson,
  mergeAiIntoStructural,
};
