// image-resize.ts — client-side screenshot compression for the "Report a
// problem" attachment picker (ReportProblemDialog.tsx). The pure sizing math
// (computeTargetDimensions) is separated from the DOM/canvas-touching
// compression call so it can be covered by a plain vitest test — mirrors the
// pricing.ts pure-logic pattern.

/** Caps enforced on the FE before a file is even sent to the edge function.
 *  The edge function (`report-problem`) re-enforces its own caps server-side
 *  — these are UX-only, not a security boundary. Keep in sync with the
 *  server's `MAX_ATTACHMENTS` / `MAX_ATTACHMENT_BYTES`
 *  (supabase/functions/_shared/attachment-validation.ts) if either changes. */
export const MAX_ATTACHMENTS = 3;
export const MAX_ATTACHMENT_BYTES = 2 * 1024 * 1024; // 2MB, post-compression
export const MAX_ATTACHMENT_EDGE_PX = 1600;
export const JPEG_QUALITY = 0.8;

/** Given an image's natural width/height, returns the dimensions to draw it
 *  at so the longer edge is capped at `maxEdge` — preserves aspect ratio,
 *  never upscales a smaller image, and always returns whole pixels. */
export function computeTargetDimensions(
  naturalWidth: number,
  naturalHeight: number,
  maxEdge = MAX_ATTACHMENT_EDGE_PX,
): { width: number; height: number } {
  if (naturalWidth <= 0 || naturalHeight <= 0) return { width: 0, height: 0 };
  const longEdge = Math.max(naturalWidth, naturalHeight);
  if (longEdge <= maxEdge) return { width: Math.round(naturalWidth), height: Math.round(naturalHeight) };
  const scale = maxEdge / longEdge;
  return { width: Math.round(naturalWidth * scale), height: Math.round(naturalHeight * scale) };
}

function loadImage(file: File): Promise<{ img: HTMLImageElement; url: string }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => resolve({ img, url });
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error(`Could not read ${file.name || 'the image'}.`)); };
    img.src = url;
  });
}

export interface CompressedImage {
  /** Base64 payload with no `data:` prefix, ready for the edge function. */
  dataBase64: string;
  sizeBytes: number;
}

/** Draws `file` onto a canvas capped at `maxEdge` on the long edge and
 *  re-encodes it as JPEG at `quality`. Not unit-tested (needs a DOM/canvas) —
 *  the pure dimension math above is; this is exercised via manual/E2E check. */
export async function compressImageToJpeg(
  file: File,
  maxEdge = MAX_ATTACHMENT_EDGE_PX,
  quality = JPEG_QUALITY,
): Promise<CompressedImage> {
  const { img, url } = await loadImage(file);
  try {
    const { width, height } = computeTargetDimensions(img.naturalWidth || img.width, img.naturalHeight || img.height, maxEdge);
    if (width <= 0 || height <= 0) throw new Error(`${file.name || 'That file'} is not a readable image.`);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Image compression is not supported in this browser.');
    ctx.drawImage(img, 0, 0, width, height);
    const dataUrl = canvas.toDataURL('image/jpeg', quality);
    const dataBase64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
    const sizeBytes = atob(dataBase64).length;
    return { dataBase64, sizeBytes };
  } finally {
    URL.revokeObjectURL(url);
  }
}
