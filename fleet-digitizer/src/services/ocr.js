const { createWorker } = require('tesseract.js');
const config = require('../config');

let workerPromise;

async function getWorker() {
  if (!workerPromise) {
    workerPromise = createWorker('eng');
  }
  return workerPromise;
}

function walkWords(blocks = []) {
  const words = [];
  for (const block of blocks) {
    for (const para of block.paragraphs || []) {
      for (const line of para.lines || []) {
        for (const word of line.words || []) {
          const text = (word.text || '').trim();
          if (!text) continue;
          const conf = typeof word.confidence === 'number' ? word.confidence : 0;
          words.push({
            text,
            confidence: conf,
            bbox: word.bbox,
            lineText: (line.text || '').trim(),
          });
        }
      }
    }
  }
  return words;
}

/**
 * Local handwriting/print OCR via Tesseract.js with per-token confidence.
 */
async function ocrWithTesseract(imagePath) {
  const worker = await getWorker();
  const { data } = await worker.recognize(
    imagePath,
    {},
    { text: true, blocks: true, tsv: true }
  );

  const words = walkWords(data.blocks || []);
  return {
    provider: 'tesseract',
    text: data.text || '',
    confidence: data.confidence ?? averageConfidence(words),
    words,
    stub: false,
  };
}

function averageConfidence(words) {
  if (!words.length) return 0;
  return words.reduce((s, w) => s + w.confidence, 0) / words.length;
}

/**
 * Optional Azure Document Intelligence path (requires keys in .env).
 * STUB/optional: falls back with a clear flag when keys are missing.
 */
async function ocrWithAzure(imagePath) {
  const { endpoint, key } = config.azure;
  if (!endpoint || !key) {
    return {
      provider: 'azure',
      stub: true,
      error: 'AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT / KEY not set — falling back to tesseract',
      text: '',
      confidence: 0,
      words: [],
    };
  }

  // Read image as base64 and call prebuilt-read
  const fs = require('fs');
  const buf = fs.readFileSync(imagePath);
  const url = `${endpoint.replace(/\/$/, '')}/documentintelligence/documentModels/prebuilt-read:analyze?api-version=2024-11-30`;

  const start = await fetch(url, {
    method: 'POST',
    headers: {
      'Ocp-Apim-Subscription-Key': key,
      'Content-Type': 'application/octet-stream',
    },
    body: buf,
  });

  if (!start.ok) {
    const body = await start.text();
    throw new Error(`Azure analyze failed: ${start.status} ${body}`);
  }

  const op = start.headers.get('operation-location');
  if (!op) throw new Error('Azure response missing operation-location');

  let result;
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const poll = await fetch(op, {
      headers: { 'Ocp-Apim-Subscription-Key': key },
    });
    result = await poll.json();
    if (result.status === 'succeeded') break;
    if (result.status === 'failed') throw new Error('Azure analyze failed');
  }

  const words = [];
  const pages = result.analyzeResult?.pages || [];
  for (const page of pages) {
    for (const w of page.words || []) {
      const poly = w.polygon || [];
      const xs = poly.filter((_, i) => i % 2 === 0);
      const ys = poly.filter((_, i) => i % 2 === 1);
      words.push({
        text: w.content,
        confidence: (w.confidence ?? 0) * 100,
        bbox: {
          x0: Math.min(...xs),
          y0: Math.min(...ys),
          x1: Math.max(...xs),
          y1: Math.max(...ys),
        },
      });
    }
  }

  return {
    provider: 'azure',
    stub: false,
    text: result.analyzeResult?.content || words.map((w) => w.text).join(' '),
    confidence: averageConfidence(words),
    words,
  };
}

async function runOcr(imagePath, provider = config.ocrProvider) {
  if (provider === 'azure') {
    const azure = await ocrWithAzure(imagePath);
    if (!azure.stub) return azure;
    const local = await ocrWithTesseract(imagePath);
    return { ...local, fallbackFrom: 'azure', azureNote: azure.error };
  }
  return ocrWithTesseract(imagePath);
}

module.exports = { runOcr, ocrWithTesseract, getWorker };
