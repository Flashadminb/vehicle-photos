import type { Imaging, Watermark } from './engine';
import { formatBangkok } from '../../shared/time';

/**
 * Image processing in the browser (the free Worker has no CPU budget for it).
 *  - Original: longest edge ≤ 2560 px, JPEG q=0.9 — keeps Thai plate characters crisp.
 *  - Display copy: ≤ 1600 px, q=0.85, with a visible, accurately labelled timestamp band.
 *  - Thumbnail: ≤ 360 px, q=0.72 (recent-view cache only).
 */
const ORIGINAL_EDGE = 2560;
const DISPLAY_EDGE = 1600;
const THUMB_EDGE = 360;

async function decode(blob: Blob): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(blob, { imageOrientation: 'from-image' });
  } catch {
    // Older Safari: fall back to an <img> element.
    const url = URL.createObjectURL(blob);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return await createImageBitmap(img);
    } finally {
      URL.revokeObjectURL(url);
    }
  }
}

function canvasFor(w: number, h: number): { canvas: HTMLCanvasElement | OffscreenCanvas; ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D } {
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(w, h);
    return { canvas, ctx: canvas.getContext('2d')! };
  }
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  return { canvas, ctx: canvas.getContext('2d')! };
}

async function toBlob(canvas: HTMLCanvasElement | OffscreenCanvas, quality: number): Promise<Blob> {
  if ('convertToBlob' in canvas) return canvas.convertToBlob({ type: 'image/jpeg', quality });
  return new Promise((res, rej) => (canvas as HTMLCanvasElement).toBlob((b) => (b ? res(b) : rej(new Error('encode failed'))), 'image/jpeg', quality));
}

function fit(w: number, h: number, edge: number) {
  const s = Math.min(1, edge / Math.max(w, h));
  return { w: Math.round(w * s), h: Math.round(h * s) };
}

async function encode(bmp: ImageBitmap, edge: number, quality: number, draw?: (ctx: any, w: number, h: number) => void) {
  const { w, h } = fit(bmp.width, bmp.height, edge);
  const { canvas, ctx } = canvasFor(w, h);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, 0, 0, w, h);
  draw?.(ctx, w, h);
  return { blob: await toBlob(canvas, quality), w, h };
}

export function watermarkLines(wm: Watermark): string[] {
  const lines: string[] = [];
  if (wm.source === 'camera') {
    lines.push(`CAPTURED (device clock): ${formatBangkok(wm.captureTime)} ICT`);
  } else {
    lines.push('UPLOADED FILE — original capture time NOT verified');
    if (wm.exifTime) lines.push(`EXIF time (unverified): ${wm.exifTime}`);
  }
  lines.push(`RECEIVED BY SERVER: ${formatBangkok(wm.serverReceivedAt)} ICT`);
  lines.push(`${wm.publicId} · ${String(wm.stepNumber).padStart(2, '0')} ${wm.stepLabel}`);
  return lines;
}

function drawWatermark(ctx: CanvasRenderingContext2D, w: number, h: number, lines: string[]) {
  const size = Math.max(14, Math.round(Math.min(w, h) * 0.032));
  const pad = Math.round(size * 0.6);
  const lineH = Math.round(size * 1.3);
  const bandH = pad * 2 + lineH * lines.length;
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.fillRect(0, h - bandH, w, bandH);
  ctx.font = `600 ${size}px system-ui, 'Noto Sans Thai', 'Leelawadee UI', sans-serif`;
  ctx.fillStyle = '#fff';
  ctx.textBaseline = 'top';
  lines.forEach((line, i) => ctx.fillText(line, pad, h - bandH + pad + i * lineH, w - pad * 2));
}

export const browserImaging: Imaging = {
  async prepare(blob) {
    const bmp = await decode(blob);
    try {
      const small = Math.max(bmp.width, bmp.height) <= ORIGINAL_EDGE;
      // Keep already-reasonable JPEGs byte-for-byte (best evidence, no recompression loss).
      if (small && blob.type === 'image/jpeg' && blob.size < 2.5 * 1024 * 1024) {
        return { original: blob, width: bmp.width, height: bmp.height };
      }
      const out = await encode(bmp, ORIGINAL_EDGE, 0.9);
      return { original: out.blob, width: out.w, height: out.h };
    } finally {
      bmp.close();
    }
  },
  async render(original, wm) {
    const bmp = await decode(original);
    try {
      const lines = watermarkLines(wm);
      const display = await encode(bmp, DISPLAY_EDGE, 0.85, (ctx, w, h) => drawWatermark(ctx, w, h, lines));
      const thumb = await encode(bmp, THUMB_EDGE, 0.72);
      return { display: display.blob, thumb: thumb.blob };
    } finally {
      bmp.close();
    }
  },
};

/** EXIF DateTimeOriginal of an uploaded file — stored as UNVERIFIED metadata only. */
export async function readExifTime(file: Blob): Promise<string | null> {
  try {
    const { parse } = await import('exifr');
    const data = await parse(file, ['DateTimeOriginal', 'CreateDate']);
    const d: Date | undefined = data?.DateTimeOriginal ?? data?.CreateDate;
    if (!d || Number.isNaN(d.getTime())) return null;
    // EXIF has no timezone: keep the wall-clock value as written in the file.
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  } catch {
    return null;
  }
}
