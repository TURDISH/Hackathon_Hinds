const fs = require('fs');
const path = require('path');
const { createCanvas } = require('@napi-rs/canvas');

let pdfjsPromise;

async function getPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import('pdfjs-dist/legacy/build/pdf.mjs');
  }
  return pdfjsPromise;
}

/**
 * Rasterize each page of a PDF (or pass through an image) to PNG files.
 */
async function rasterizeDocument(inputPath, outDir, { scale = 2 } = {}) {
  fs.mkdirSync(outDir, { recursive: true });
  const ext = path.extname(inputPath).toLowerCase();

  if (['.png', '.jpg', '.jpeg', '.webp', '.tif', '.tiff', '.bmp'].includes(ext)) {
    const dest = path.join(outDir, 'page-1.png');
    if (ext === '.png') {
      fs.copyFileSync(inputPath, dest);
    } else {
      const sharp = require('sharp');
      await sharp(inputPath).png().toFile(dest);
    }
    return [{ page: 1, path: dest }];
  }

  if (ext !== '.pdf') {
    throw new Error(`Unsupported file type: ${ext}`);
  }

  const pdfjs = await getPdfjs();
  const data = new Uint8Array(fs.readFileSync(inputPath));
  const doc = await pdfjs.getDocument({ data, useSystemFonts: true }).promise;
  const pages = [];

  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const viewport = page.getViewport({ scale });
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const ctx = canvas.getContext('2d');
    await page.render({ canvasContext: ctx, viewport }).promise;
    const outPath = path.join(outDir, `page-${i}.png`);
    fs.writeFileSync(outPath, canvas.toBuffer('image/png'));
    pages.push({ page: i, path: outPath, width: canvas.width, height: canvas.height });
  }

  return pages;
}

module.exports = { rasterizeDocument };
