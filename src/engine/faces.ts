// Faces in a photo, found on the device with MediaPipe's face detector (BlazeFace, full range: faces up to about 5 m).
// The photo lab never hides a face: on the photo bench, Gemini Nano's own idea of where people were missed faces in 4 of
// 7 photos and saw people where there were none (21-nov). The detector and its WebAssembly are served by this site
// (public/mediapipe, see scripts/copy-mediapipe.mjs) and load only when a photo is masked.

import type { Rect } from '../threats/location';

declare const __MEDIAPIPE_VERSION__: string; // set in vite.config.ts

type Detector = { detect(image: ImageBitmap): { detections: { boundingBox?: { originX: number; originY: number; width: number; height: number } }[] } };

let detector: Promise<Detector> | null = null;

function load(): Promise<Detector> {
  detector ??= (async () => {
    const { FaceDetector, FilesetResolver } = await import('@mediapipe/tasks-vision');
    const files = await FilesetResolver.forVisionTasks(`/mediapipe/wasm-${__MEDIAPIPE_VERSION__}`);
    return FaceDetector.createFromOptions(files, {
      baseOptions: { modelAssetPath: '/mediapipe/blaze_face_full_range.tflite', delegate: 'CPU' },
      runningMode: 'IMAGE',
      // Lower than the default 0.5: a face the detector is unsure of is still kept out of the masks.
      minDetectionConfidence: 0.35,
    });
  })().catch((e) => {
    detector = null; // let the next photo try again
    throw e;
  });
  return detector;
}

/**
 * The faces in a PNG, each widened to the whole head (the detector's box runs from the eyebrows to the chin): a mask
 * must not cut a forehead or a chin either.
 */
export async function findFaces(png: Uint8Array): Promise<Rect[]> {
  const d = await load();
  const bitmap = await createImageBitmap(new Blob([png.slice()], { type: 'image/png' }));
  try {
    const { width, height } = bitmap;
    return d
      .detect(bitmap)
      .detections.map((x) => x.boundingBox)
      .filter((b): b is NonNullable<typeof b> => !!b && b.width > 0 && b.height > 0)
      .map((b) => {
        const x = Math.max(0, b.originX - 0.25 * b.width);
        const y = Math.max(0, b.originY - 0.55 * b.height);
        const right = Math.min(width, b.originX + 1.25 * b.width);
        const bottom = Math.min(height, b.originY + 1.2 * b.height);
        return { x: Math.floor(x), y: Math.floor(y), w: Math.ceil(right - x), h: Math.ceil(bottom - y) };
      });
  } finally {
    bitmap.close();
  }
}
