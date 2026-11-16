// Canvas image operations that run in the browser, on the device.

import type { ImageOps } from '../threats/location';

async function decode(png: Uint8Array): Promise<ImageBitmap> {
  return createImageBitmap(new Blob([png.slice()], { type: 'image/png' }));
}

async function encode(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('encode failed'))), 'image/png'));
  return new Uint8Array(await blob.arrayBuffer());
}

function canvasFor(img: ImageBitmap) {
  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  const ctx = c.getContext('2d')!;
  ctx.drawImage(img, 0, 0);
  return { c, ctx };
}

export const browserImageOps: ImageOps = {
  async withGrid(png, n) {
    const img = await decode(png);
    const { c, ctx } = canvasFor(img);
    const cw = c.width / n;
    const ch = c.height / n;
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.lineWidth = Math.max(2, c.width / 400);
    for (let i = 1; i < n; i++) {
      ctx.beginPath();
      ctx.moveTo(i * cw, 0);
      ctx.lineTo(i * cw, c.height);
      ctx.moveTo(0, i * ch);
      ctx.lineTo(c.width, i * ch);
      ctx.stroke();
    }
    const fs = Math.round(Math.min(cw, ch) / 6);
    ctx.font = `700 ${fs}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let r = 0; r < n; r++)
      for (let k = 0; k < n; k++) {
        const x = k * cw + fs * 0.9;
        const y = r * ch + fs * 0.9;
        ctx.fillStyle = 'rgba(0,0,0,0.75)';
        ctx.beginPath();
        ctx.arc(x, y, fs * 0.75, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.fillText(String(r * n + k + 1), x, y + 1);
      }
    return encode(c);
  },

  async maskCells(png, cells, n) {
    const img = await decode(png);
    const { c, ctx } = canvasFor(img);
    const cw = c.width / n;
    const ch = c.height / n;
    const small = document.createElement('canvas');
    const sctx = small.getContext('2d')!;
    for (const cell of cells) {
      const r = Math.floor((cell - 1) / n);
      const k = (cell - 1) % n;
      const x = Math.round(k * cw);
      const y = Math.round(r * ch);
      const w = Math.round(cw);
      const h = Math.round(ch);
      // Heavy pixelation: 10 blocks across the cell, then upscale without smoothing.
      small.width = 10;
      small.height = Math.max(1, Math.round((10 * h) / w));
      sctx.imageSmoothingEnabled = true;
      sctx.drawImage(c, x, y, w, h, 0, 0, small.width, small.height);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(small, 0, 0, small.width, small.height, x, y, w, h);
    }
    return encode(c);
  },
};

/** Renders an SVG string to PNG bytes (used for the illustrated demo scene). */
export async function svgToPng(svg: string, width: number, height: number): Promise<Uint8Array> {
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  try {
    const img = new Image();
    img.decoding = 'sync';
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('svg load failed'));
      img.src = url;
    });
    const c = document.createElement('canvas');
    c.width = width;
    c.height = height;
    c.getContext('2d')!.drawImage(img, 0, 0, width, height);
    return encode(c);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Decodes a user's photo (JPEG/PNG/WebP) and re-encodes it as PNG on the device, at most `maxSide` pixels wide or tall.
 * Re-encoding through a canvas also drops EXIF metadata (including GPS), before anything else happens.
 */
export async function normalizeToPng(file: Blob, maxSide = 1280): Promise<{ png: Uint8Array; width: number; height: number }> {
  const img = await createImageBitmap(file);
  const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
  const c = document.createElement('canvas');
  c.width = Math.round(img.width * scale);
  c.height = Math.round(img.height * scale);
  c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
  return { png: await encode(c), width: c.width, height: c.height };
}
