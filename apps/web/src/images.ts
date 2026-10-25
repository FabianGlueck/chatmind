import { IMAGE_TYPES } from '@chatmind/core/graph';

/** An image waiting in the composer: what the send carries (base64) plus a data URL for the thumbnail. */
export interface PendingImage { mediaType: string; data: string; url: string }

/** Spec M13: larger images are scaled down to this long side and re-encoded as JPEG before sending. */
export const MAX_SIDE = 2048;
export const MAX_RAW_BYTES = 4 * 1024 * 1024;

export const isSupportedImage = (f: { type: string }): boolean => IMAGE_TYPES[f.type] !== undefined;

function dataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error ?? new Error('could not read the image'));
    r.readAsDataURL(blob);
  });
}

/** Scaled to ≤ MAX_SIDE as JPEG when too large in pixels or bytes; otherwise the file itself. */
async function shrink(file: Blob): Promise<Blob> {
  if (typeof createImageBitmap !== 'function') return file;
  const bmp = await createImageBitmap(file);
  const side = Math.max(bmp.width, bmp.height);
  if (side <= MAX_SIDE && file.size <= MAX_RAW_BYTES) { bmp.close(); return file; }
  const k = Math.min(1, MAX_SIDE / side);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bmp.width * k);
  canvas.height = Math.round(bmp.height * k);
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#fff'; // JPEG has no alpha — transparent screenshots get a white ground
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close();
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('could not encode the image'))), 'image/jpeg', 0.9));
}

/** Spec M13: a pasted, dropped or picked file ready for the send. */
export async function prepareImage(file: Blob): Promise<PendingImage> {
  const blob = await shrink(file);
  const url = await dataUrl(blob);
  return { mediaType: blob.type, data: url.slice(url.indexOf(',') + 1), url };
}
