import type { Imaging, Watermark } from './engine';
import { formatBangkok } from '../../shared/time';

/**
 * Image processing in the browser (the free Worker has no CPU budget for it).
 *  - Original (only if originals are kept): longest edge ≤ originalEdge (2560), q=0.88.
 *  - Display copy: ≤ displayEdge (1280 by default, set in the dashboard), q=0.82, with a
 *    visible, accurately labelled timestamp band.
 *  - Thumbnail: ≤ 360 px, q=0.75, made from the stamped display copy.
 */
const THUMB_EDGE = 360;

export interface ImagingOptions {
  /** Longest edge of the watermarked display copy (default 1280). */
  displayEdge: number;
  /** Longest edge of the original copy (default 2560). */
  originalEdge: number;
  /** Whether an original copy is uploaded at all (if not, skip encoding it). */
  keepOriginals: boolean;
}

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

const pad2 = (n: number) => String(n).padStart(2, '0');

/** "25/11/2026 10:45:12" in Asia/Bangkok. */
export function stampTime(utcMs: number): string {
  const s = formatBangkok(utcMs); // YYYY-MM-DD HH:mm:ss
  const [d, t] = s.split(' ');
  const [y, m, day] = d.split('-');
  return `${day}/${m}/${y} ${t}`;
}

/**
 * The visible timestamp stamped on every stored display copy. Labels say exactly which
 * clock the time came from:
 *  - camera photo: the phone clock at capture ("ถ่ายเมื่อ … (เวลามือถือ)")
 *  - uploaded file: the real capture time is unknown, so the big time is the SERVER
 *    receipt time and the label says so; any EXIF date is shown as unverified.
 */
export function watermarkLines(wm: Watermark): { big: string; small: string[] } {
  const received = stampTime(wm.serverReceivedAt);
  const step = `${wm.publicId} · ${pad2(wm.stepNumber)} ${wm.stepLabel}`;
  if (wm.source === 'camera' && wm.captureTime != null) {
    return {
      big: stampTime(wm.captureTime),
      small: ['ถ่ายเมื่อ (เวลามือถือ) · Captured (device clock)', `เซิร์ฟเวอร์รับ ${received}`, step],
    };
  }
  const small = ['ไฟล์อัปโหลด — ไม่ทราบเวลาถ่ายจริง · Uploaded file, capture time unknown'];
  if (wm.exifTime) small.push(`EXIF (ไม่ได้ยืนยัน) ${wm.exifTime}`);
  small.push(`เวลาที่เซิร์ฟเวอร์รับ · Server received`, step);
  return { big: received, small };
}

const FONT = `system-ui, 'Noto Sans Thai', 'Leelawadee UI', Thonburi, sans-serif`;

function drawWatermark(ctx: CanvasRenderingContext2D, w: number, h: number, wm: Watermark) {
  const { big, small } = watermarkLines(wm);
  const unit = Math.min(w, h);
  const bigSize = Math.max(22, Math.round(unit * 0.065));
  const smallSize = Math.max(13, Math.round(unit * 0.028));
  const pad = Math.round(unit * 0.03);
  const gap = Math.round(smallSize * 0.35);
  const bandH = pad * 2 + bigSize + gap + small.length * (smallSize + gap);
  // Soft dark band across the bottom so the stamp is readable on any photo.
  const grad = ctx.createLinearGradient(0, h - bandH - pad, 0, h);
  grad.addColorStop(0, 'rgba(0,0,0,0)');
  grad.addColorStop(0.25, 'rgba(0,0,0,0.55)');
  grad.addColorStop(1, 'rgba(0,0,0,0.7)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, h - bandH - pad, w, bandH + pad);
  ctx.textBaseline = 'top';
  ctx.shadowColor = 'rgba(0,0,0,0.6)';
  ctx.shadowBlur = Math.round(unit * 0.004);
  let y = h - bandH + pad;
  ctx.fillStyle = '#ffd54a';
  ctx.font = `700 ${bigSize}px ${FONT}`;
  ctx.fillText(big, pad, y, w - pad * 2);
  y += bigSize + gap;
  ctx.fillStyle = '#ffffff';
  ctx.font = `600 ${smallSize}px ${FONT}`;
  for (const line of small) {
    ctx.fillText(line, pad, y, w - pad * 2);
    y += smallSize + gap;
  }
  ctx.shadowBlur = 0;
}

/** Decoded bitmaps kept between prepare() and render() so each photo is decoded once. */
const decoded = new WeakMap<Blob, ImageBitmap>();

export function createImaging(opts: ImagingOptions): Imaging {
  return {
    async prepare(blob, o) {
      const bmp = await decode(blob);
      decoded.set(blob, bmp);
      const small = Math.max(bmp.width, bmp.height) <= opts.originalEdge;
      const wanted = opts.keepOriginals || !!o?.original;
      // No original is uploaded, or the JPEG is already small: no extra encoding work.
      if (!wanted || (small && blob.type === 'image/jpeg' && blob.size < 2.5 * 1024 * 1024)) {
        return { original: blob, width: bmp.width, height: bmp.height };
      }
      decoded.delete(blob);
      const out = await encode(bmp, opts.originalEdge, 0.88);
      decoded.set(out.blob, bmp);
      return { original: out.blob, width: out.w, height: out.h };
    },
    async render(original, wm, ro) {
      const bmp = decoded.get(original) ?? (await decode(original));
      decoded.delete(original);
      try {
        // Display copy with the timestamp…
        const { w, h } = fit(bmp.width, bmp.height, ro?.displayEdge ?? opts.displayEdge);
        const { canvas, ctx } = canvasFor(w, h);
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(bmp, 0, 0, w, h);
        drawWatermark(ctx as CanvasRenderingContext2D, w, h, wm);
        const display = await toBlob(canvas, 0.82);
        // …and the thumbnail made from it, so the stamp shows there too.
        const t = fit(w, h, THUMB_EDGE);
        const th = canvasFor(t.w, t.h);
        th.ctx.imageSmoothingQuality = 'high';
        th.ctx.drawImage(canvas as CanvasImageSource, 0, 0, t.w, t.h);
        const thumb = await toBlob(th.canvas, 0.75);
        return { display, thumb };
      } finally {
        bmp.close();
      }
    },
  };
}

/** Defaults (used when the server did not send image settings). */
export const browserImaging: Imaging = createImaging({ displayEdge: 1280, originalEdge: 2560, keepOriginals: false });

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
