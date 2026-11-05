const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const ROOT = path.resolve(__dirname, '..');
const HACKATHON = path.resolve(ROOT, '..');

module.exports = {
  port: Number(process.env.PORT || 3847),
  confidenceThreshold: Number(process.env.CONFIDENCE_THRESHOLD || 70),
  ocrProvider: (process.env.OCR_PROVIDER || 'tesseract').toLowerCase(),
  azure: {
    endpoint: process.env.AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT || '',
    key: process.env.AZURE_DOCUMENT_INTELLIGENCE_KEY || '',
  },
  paths: {
    root: ROOT,
    hackathon: HACKATHON,
    templates: process.env.TEMPLATES_DIR
      ? path.resolve(process.env.TEMPLATES_DIR)
      : path.join(HACKATHON, 'Templates'),
    scans: path.join(HACKATHON, 'ScannedDocs'),
    outputs: path.join(HACKATHON, 'AutoCreatedDocs'),
    uploads: path.join(ROOT, 'data', 'uploads'),
    jobs: path.join(ROOT, 'data', 'jobs'),
  },
};
