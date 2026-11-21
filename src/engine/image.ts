// Canvas image operations that run in the browser, on the device.

import type { ImageOps } from '../threats/location';
import { findFaces } from './faces';

/** A photo Throwaway cannot check, in plain words for the person who picked it. */
export class PhotoInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PhotoInputError';
  }
}

export const PHOTO_LIMITS = {
  /** Larger files are not phone photos (and decoding them can run a tab out of memory). */
  maxBytes: 40 * 1024 * 1024,
  /** Below this, a 4×4 grid has cells of a few pixels: nothing to find, nothing to mask. */
  minSide: 64,
  maxPixels: 100_000_000,
};

/** Checks a file before decoding it: empty, too big, HEIC (Chrome cannot decode it), not an image, SVG. */
export function checkPhotoFile(f: { size: number; type?: string; name?: string }) {
  const type = (f.type ?? '').toLowerCase();
  const name = (f.name ?? '').toLowerCase();
  if (!f.size) throw new PhotoInputError('That file is empty.');
  if (f.size > PHOTO_LIMITS.maxBytes) {
    throw new PhotoInputError(`That file is ${Math.round(f.size / 1024 / 1024)} MB; photos up to ${PHOTO_LIMITS.maxBytes / 1024 / 1024} MB can be checked.`);
  }
  if (/hei[cf]/.test(type) || /\.hei[cf]$/.test(name)) {
    throw new PhotoInputError('This browser cannot open HEIC photos. Export it as JPEG first (on an iPhone: Settings → Camera → Formats → Most Compatible).');
  }
  if (type === 'image/svg+xml' || name.endsWith('.svg')) throw new PhotoInputError('That is a drawing (SVG), not a photo. Use a JPEG, PNG or WebP photo.');
  if (type && !type.startsWith('image/')) throw new PhotoInputError('That file is not an image. Use a JPEG, PNG or WebP photo.');
}

/** Checks the decoded size and returns the size to draw at: at most `maxSide` on the long side, never upscaled. */
export function fitPhoto(width: number, height: number, maxSide = 1280): { width: number; height: number } {
  if (!(width > 0 && height > 0)) throw new PhotoInputError('That image has no pixels to check.');
  if (Math.min(width, height) < PHOTO_LIMITS.minSide) {
    throw new PhotoInputError(`That image is only ${width} × ${height} pixels, too small to check. Use a photo at least ${PHOTO_LIMITS.minSide} pixels on each side.`);
  }
  if (width * height > PHOTO_LIMITS.maxPixels) throw new PhotoInputError(`That image is ${Math.round((width * height) / 1e6)} megapixels; up to 100 can be checked.`);
  const scale = Math.min(1, maxSide / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/**
 * The pixels of a grid cell (1 = top left), edges rounded outwards so neighbouring cells overlap by at most a pixel and
 * never leave an unmasked strip between them (rounding both edges did, on sizes not divisible by the grid).
 */
export function cellRect(cell: number, n: number, width: number, height: number): { x: number; y: number; w: number; h: number } {
  const r = Math.floor((cell - 1) / n);
  const k = (cell - 1) % n;
  const x = Math.floor((k * width) / n);
  const y = Math.floor((r * height) / n);
  return { x, y, w: Math.ceil(((k + 1) * width) / n) - x, h: Math.ceil(((r + 1) * height) / n) - y };
}

/** The colour of the boxes that hide what can be read in a photo: a dark slate, the same on every photo. */
export const MASK_COLOUR = '#3b4150';
const MASK_VEIL = 'rgba(59, 65, 80, 0.22)';

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

  async size(png) {
    const img = await decode(png);
    const size = { width: img.width, height: img.height };
    img.close();
    return size;
  },

  faces: findFaces,

  async crop(png, r) {
    const img = await decode(png);
    try {
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(r.w));
      c.height = Math.max(1, Math.round(r.h));
      c.getContext('2d')!.drawImage(img, r.x, r.y, r.w, r.h, 0, 0, c.width, c.height);
      return encode(c);
    } finally {
      img.close();
    }
  },

  async paint(png, regions) {
    const img = await decode(png);
    try {
      const { c, ctx } = canvasFor(img);
      // One strength for the whole photo, a twentieth of its short side (about 40 px at 1280 × 853): no letter of a sign
      // or a plate survives it, however thin the strip left beside a face.
      const radius = Math.max(14, Math.round(Math.min(c.width, c.height) / 20));
      // Blurs first, from the untouched photo (a blur reads the pixels around it); then the boxes, which hide all.
      for (const g of regions.filter((r) => r.style === 'blur')) {
        const { x, y, w, h } = g.rect;
        ctx.save();
        ctx.beginPath();
        ctx.rect(x, y, w, h);
        ctx.clip();
        ctx.filter = `blur(${radius}px)`;
        ctx.drawImage(img, 0, 0);
        ctx.filter = 'none';
        // A light veil of the box colour, so a hidden part reads as hidden on purpose, not as a smudge.
        ctx.fillStyle = MASK_VEIL;
        ctx.fillRect(x, y, w, h);
        ctx.restore();
      }
      // One flat colour, whatever was under it: pixelating kept a blue plate blue and a sign's shape (21-nov review).
      ctx.fillStyle = MASK_COLOUR;
      for (const g of regions.filter((r) => r.style === 'box')) ctx.fillRect(g.rect.x, g.rect.y, g.rect.w, g.rect.h);
      return encode(c);
    } finally {
      img.close();
    }
  },

  async maskCells(png, cells, n) {
    const img = await decode(png);
    const { c, ctx } = canvasFor(img);
    const small = document.createElement('canvas');
    const sctx = small.getContext('2d')!;
    for (const cell of cells) {
      const { x, y, w, h } = cellRect(cell, n, c.width, c.height);
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
 * Re-encoding through a canvas also drops EXIF metadata (including GPS), before anything else happens. The EXIF
 * rotation is applied first (a phone photo is stored sideways), and transparency is flattened onto white, so what is
 * checked and sent is what the person sees: nothing hides in transparent pixels.
 */
export async function normalizeToPng(file: Blob, maxSide = 1280): Promise<{ png: Uint8Array; width: number; height: number }> {
  checkPhotoFile({ size: file.size, type: file.type, name: (file as File).name });
  let img: ImageBitmap;
  try {
    img = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    throw new PhotoInputError('That file could not be read as an image. Use a JPEG, PNG or WebP photo.');
  }
  try {
    const size = fitPhoto(img.width, img.height, maxSide);
    const c = document.createElement('canvas');
    c.width = size.width;
    c.height = size.height;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(img, 0, 0, c.width, c.height);
    return { png: await encode(c), width: c.width, height: c.height };
  } finally {
    img.close(); // a 12-megapixel bitmap is ~48 MB until it is closed
  }
}
