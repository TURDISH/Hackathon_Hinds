# Fleet SOP Digitizer

Localhost web app that turns scanned handwritten checkout logs (PDF/image) into populated Word/Excel masters — **any** uploaded template, via dynamic schema analysis (no form-specific hardcodes).

## What it does

1. **Upload** a scan (PDF preferred; PNG/JPEG also OK).
2. **Match** it to the best master template using that template’s **cached schema** (fingerprint + aliases).
3. **Read handwriting** with a **local vision LLM** (Gemma 4) as primary and **Tesseract** as fallback, **biased by the template schema field type** (date / force_lb / small_int / …) during the read — not only cleaned afterward. Page labels still use Tesseract.
4. **Map** tokens into schema fields by label aliases and nearby context.
5. **Review** UI draws an orange overlay on **each extracted field** (aligned to deskewed cell ROIs) and highlights anything under **70%** confidence; edit before finalize.
6. **Export** a filled `.xlsx` / `.docx` into `../AutoCreatedDocs` using schema **writeTargets**.

## Quick start (Windows)

Requires **Node.js 18+**.

```powershell
cd C:\Users\thind\OneDrive\Desktop\HACKATHON\fleet-digitizer
npm install
npm start
```

Open **http://localhost:3847**

Optional: copy `.env.example` → `.env` for port, OCR, or local AI settings.

### If `npm` is missing but `nvm` is installed

```powershell
nvm install 22.14.0
nvm use 22.14.0
```

## Dynamic template schemas

Master templates (Word/Excel in `../Templates`) are the source of form structure — **not** the scanned PDF.

On first use (or when the file hash changes), the app:

1. **Structurally analyzes** the master (labels, Excel write cells, measurement grids).
2. Optionally **consults a local LLM** (Ollama / OpenAI-compatible) to refine field types, aliases, and title hints.
3. **Caches** the schema under `data/schemas/<template-file>.schema.json`.
4. Digitization **consumes that cache** for header placement, aliases, field types, and slot layout.

A brand-new master + matching scan should work without editing JS source. If analysis fails, the app reports an error and asks you to re-preprocess — it does **not** fall back to any built-in form layout.

### Local AI configuration

Two separate roles share Ollama — do not confuse them:

| Role | Env | What it does |
|------|-----|----------------|
| **Template AI** (text) | `TEMPLATE_AI_*` | Enrich cached template schemas (aliases, types). Never reads handwriting. |
| **Vision HTR** (multimodal) | `VISION_OCR_*` | Reads handwritten digits from cell crops. Primary over Tesseract when available. |

| Env | Default | Meaning |
|-----|---------|---------|
| `TEMPLATE_AI_ENABLED` | `true` | Try local AI; structural-only if unreachable |
| `TEMPLATE_AI_PROVIDER` | `ollama` | `ollama` \| `openai_compat` \| `off` |
| `TEMPLATE_AI_BASE_URL` | `http://127.0.0.1:11434` | Ollama or OpenAI-compatible base URL |
| `TEMPLATE_AI_MODEL` | `gemma4:e2b` | Text + vision model tag |
| `TEMPLATE_AI_TIMEOUT_MS` | `300000` | Schema consult timeout |
| `VISION_OCR_ENABLED` | `true` | Per-cell vision HTR |
| `VISION_OCR_MODEL` | `gemma4:e2b` | Multimodal model (same tag OK) |
| `VISION_OCR_MODE` | `primary` | `primary` \| `hybrid` \| `off` |
| `VISION_OCR_TIMEOUT_MS` | `60000` | Per-cell vision timeout |
| `VISION_OCR_CONCURRENCY` | `2` | Parallel vision cell reads |
| `SCHEMA_CACHE_DIR` | `data/schemas` | Override cache directory |

**Ollama (Windows):** install from https://ollama.com/download, `ollama pull gemma4:e2b`, keep the tray app running. On this laptop GPU/CUDA may crash — set user env `OLLAMA_NUM_GPU=0` (CPU) and use `scripts\start-ollama-cpu.ps1`. Confirm with `GET /api/health` → `templateAi.model: gemma4:e2b` and `handwritingVision.available: true`.

### Schema cache & re-preprocess

- Cache: `data/schemas/*.schema.json` (invalidated when the master file hash or schema version changes).
- Force re-analysis: `POST /api/templates/reprocess` or `npm run reprocess-templates`.
- Inspect: `GET /api/templates/:id/schema`

### Verify

```powershell
npm run test:schema
npm run test:populate-schema
```

## Demo path

1. `npm start` → http://localhost:3847
2. Templates tab lists masters from `HACKATHON\Templates` (upload more anytime).
3. Digitise tab → upload a scan from `HACKATHON\ScannedDocs` (or any matching PDF/image). A **progress bar** shows the current step, percent, and ETA (vision OCR can take several minutes on CPU).
4. Confirm the matched template, review low-confidence fields, **Finalize & download**.
5. Output also lands in `HACKATHON\AutoCreatedDocs`.

## Adding templates

- Templates tab → Upload, **or** copy `.docx` / `.xlsx` into `HACKATHON\Templates` and refresh.
- Upload triggers a fresh schema analysis automatically.

## Project layout

| Path | Role |
|------|------|
| `src/server.js` | Express API + static UI |
| `src/services/templateSchema.js` | Schema cache |
| `src/services/templateAnalyze.js` | Structural master analyzer |
| `src/services/templateAiConsult.js` | Optional local LLM enrichment |
| `src/services/templates.js` | Template list + schema load |
| `src/services/formGrid.js` | Deskew, grid ROIs, Tesseract + vision cell HTR |
| `src/services/visionOcr.js` | Ollama multimodal cell reader |
| `src/services/digitOcr.js` | Tesseract digit ensemble + priors |
| `src/services/match.js` | Schema-driven template matching |
| `src/services/mapFields.js` | Schema alias binding + grid merge |
| `src/services/populate.js` | Write filled Office files via writeTargets |
| `scripts/bench-grid.js` | Form-1 coverage bench (pass `detectOnly: true` via scripts for geometry-only) |
| `scripts/start-ollama-cpu.ps1` | Start Ollama with `OLLAMA_NUM_GPU=0` |
| `data/schemas/` | Cached per-template schemas |
| `../Templates` | Master templates |
| `../ScannedDocs` | Sample scans |
| `../AutoCreatedDocs` | Generated outputs |

## Form 1 coverage (Shuttle Tow, `filled out form 1.pdf`)

| Stage | cellSlots | inked | filled/108 | plausible |
|-------|-----------|-------|------------|-----------|
| Before grid fix (mid MTD-7) | ~80 | ~59 | ~59 | low |
| After grid fix (Tesseract only) | **108** | **103** | **87** | 21 |
| After + vision primary (`gemma4:e2b`) | **108** | **104** | **104** | **87** |

Confidence &lt;70% stays highlighted for review. Among inked cells, fill is **104/104**; **4/108** still miss ink detection (geometry). Plausible digits rose 21 → 87; remaining wrong/low-confidence values need human review.

## Known limitations

- Vision HTR on CPU (`OLLAMA_NUM_GPU=0`) is slow (~tens of seconds per cell); prefer GPU when stable, or `VISION_OCR_MODE=hybrid`.
- Tesseract alone fills many cells but plausible-force rate stays low on dense handwriting — keep &lt;70% review.
- Shot-index registration from printed numbers is weak on phone photos; sequential row bands are the fallback.
- Without a local LLM, structural analysis still produces a usable schema; vision HTR falls back to Tesseract.
- Word templates without `{{placeholders}}` get an appended values block.
- Single-process localhost app — not hardened for multi-user production.

## API sketch

- `GET /api/health`
- `GET|POST /api/templates` · `DELETE /api/templates/:id`
- `GET /api/templates/:id/schema`
- `POST /api/templates/reprocess`
- `POST /api/jobs` · `GET|PATCH /api/jobs/:id`
- `POST /api/jobs/:id/finalize` · `GET /api/jobs/:id/download`
