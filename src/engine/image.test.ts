// The decisions behind the canvas operations, checked without a canvas: which files are refused before decoding, the
// size a photo is drawn at, and the pixels of each grid cell.

import { describe, expect, it } from 'vitest';
import { cellRect, checkPhotoFile, fitPhoto, PhotoInputError } from './image';

describe('photos that are not worth checking, refused in plain words before decoding', () => {
  it.each([
    [{ size: 0, type: 'image/jpeg' }, /empty/],
    [{ size: 60 * 1024 * 1024, type: 'image/jpeg' }, /60 MB; photos up to 40 MB/],
    [{ size: 2e6, type: 'image/heic' }, /HEIC/],
    [{ size: 2e6, type: '', name: 'IMG_0042.HEIC' }, /HEIC/],
    [{ size: 2e4, type: 'image/svg+xml' }, /drawing \(SVG\)/],
    [{ size: 2e5, type: 'application/pdf', name: 'scan.pdf' }, /not an image/],
  ])('%o', (file, message) => {
    expect(() => checkPhotoFile(file)).toThrow(PhotoInputError);
    expect(() => checkPhotoFile(file)).toThrow(message);
  });

  it('lets photos through, and files whose type the browser did not say (decoding decides)', () => {
    for (const f of [{ size: 3e6, type: 'image/jpeg' }, { size: 3e6, type: 'image/webp' }, { size: 3e6, type: '' }]) expect(() => checkPhotoFile(f)).not.toThrow();
  });
});

describe('the size a photo is checked at', () => {
  it('scales the long side down to 1280 px, never up', () => {
    expect(fitPhoto(4000, 3000)).toEqual({ width: 1280, height: 960 });
    expect(fitPhoto(3000, 4000)).toEqual({ width: 960, height: 1280 }); // a portrait phone photo, after EXIF rotation
    expect(fitPhoto(800, 600)).toEqual({ width: 800, height: 600 });
  });

  it('refuses images too small to grid, or too large to decode safely', () => {
    expect(() => fitPhoto(8, 8)).toThrow(/only 8 × 8 pixels, too small/);
    expect(() => fitPhoto(1200, 40)).toThrow(/too small/);
    expect(() => fitPhoto(20_000, 20_000)).toThrow(/400 megapixels/);
    expect(() => fitPhoto(0, 0)).toThrow(PhotoInputError);
    expect(fitPhoto(64, 64)).toEqual({ width: 64, height: 64 });
  });
});

describe('grid cells', () => {
  it('match the demo scene exactly (960×720: 240×180 cells)', () => {
    expect(cellRect(1, 4, 960, 720)).toEqual({ x: 0, y: 0, w: 240, h: 180 });
    expect(cellRect(7, 4, 960, 720)).toEqual({ x: 480, y: 180, w: 240, h: 180 });
    expect(cellRect(16, 4, 960, 720)).toEqual({ x: 720, y: 540, w: 240, h: 180 });
  });

  it('cover every pixel on sizes the grid does not divide (rounding both edges left 1 px strips unmasked)', () => {
    for (const [width, height] of [[1281, 961], [1279, 959], [1001, 667], [65, 67]]) {
      const covered = new Uint8Array(width * height);
      for (let cell = 1; cell <= 16; cell++) {
        const r = cellRect(cell, 4, width, height);
        expect(r.x + r.w).toBeLessThanOrEqual(width);
        expect(r.y + r.h).toBeLessThanOrEqual(height);
        for (let y = r.y; y < r.y + r.h; y++) covered.fill(1, y * width + r.x, y * width + r.x + r.w);
      }
      expect(covered.every((v) => v === 1)).toBe(true);
    }
  });
});
