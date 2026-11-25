import type { Env } from '../env';
import type { AppSettings } from '../../shared/types';
import { extractSlipPlate, extractThaiPlate, normalizePlate, plateCore, plateDigits } from '../../shared/plate';
import { b64, fromB64 } from '../util';
import type { DriveClient } from '../drive/types';
import { syncRoundFolderName } from '../drive/folders';
import { getCache } from './cache';

export interface OcrResult {
  raw: string;
  plate: string | null;
  confidence: number | null;
}

/**
 * Plate recognition. Results are stored as raw text + normalised plate + confidence,
 * never block capture or DONE (unless ocrBlocksDone), and an administrator's manual
 * correction always wins. Recognition is never perfect: validate with real plates.
 *
 * Routing between Google Vision and the Local OCR computers is decided by
 * decideRoute(); Vision is hard-capped at visionCapPct % of the monthly free units.
 */

// ---------- test hook ----------
type VisionFn = (env: Env, src: { url?: string; bytes?: () => Promise<ArrayBuffer> }, kind?: OcrKind) => Promise<OcrResult>;
let visionOverride: VisionFn | null = null;
export function setVisionOverride(fn: VisionFn | null) {
  visionOverride = fn;
}

// ---------- text clean-up ----------
/** Drop the lines our own timestamp watermark adds, so they are never mistaken for a plate. */
export function stripWatermarkLines(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((l) => !/(PF-\d|ถ่ายเมื่อ|เซิร์ฟเวอร์|Captured|Server received|EXIF|ไฟล์อัปโหลด|Uploaded file|\d{1,2}\/\d{1,2}\/\d{4})/i.test(l))
    .join('\n');
}

export type OcrKind = 'plate' | 'document';

export function resultFromText(raw: string, confidence: number | null, kind: OcrKind = 'plate'): OcrResult {
  if (kind === 'document') {
    // Only the "บร7865(เพชรบุรี)" pattern counts on a slip; other text (dates, IDs) is ignored.
    const slip = extractSlipPlate(stripWatermarkLines(raw));
    // Keep everything that was printed, province included: "725067723224 (พระนครศรีอยุธยา)".
    return { raw: raw.slice(0, 2000), plate: slip ? `${slip.plate} (${slip.province})` : null, confidence: slip ? (confidence ?? 0.85) : confidence };
  }
  return { raw: raw.slice(0, 2000), plate: extractThaiPlate(stripWatermarkLines(raw)), confidence };
}

/**
 * Score used to decide whether a new automatic reading may replace the current one.
 * Printed slips get a bonus over plate photos (clean print, province cross-check).
 */
export function ocrScore(confidence: number | null, kind: OcrKind) {
  return (confidence ?? 0.5) + (kind === 'document' ? 0.15 : 0);
}

/** A plate photo is not read again when a slip reading this good already exists. */
export const SKIP_PLATE_SCORE = 0.85;

/** Plate-photo readings below this confidence never fill in the plate. */
export const MIN_PLATE_CONFIDENCE = 0.5;

// ---------- Vision usage cap ----------
export function visionPeriod(now: number) {
  // Google's free tier is per calendar month; UTC is used here and the 90 % cap leaves a margin.
  return `vision:${new Date(now).toISOString().slice(0, 7)}`;
}

export function visionCap(settings: AppSettings) {
  return Math.floor((settings.visionMonthlyFree * settings.visionCapPct) / 100);
}

export async function visionUsage(env: Env, now = Date.now()) {
  const r = await env.DB.prepare(`SELECT count FROM ocr_usage WHERE period = ?`).bind(visionPeriod(now)).first<{ count: number }>();
  return r?.count ?? 0;
}

/** Atomically reserve one Vision call. Returns false once the cap is reached. */
export async function reserveVisionCall(env: Env, settings: AppSettings, now = Date.now()): Promise<boolean> {
  const cap = visionCap(settings);
  if (cap <= 0) return false;
  const r = await env.DB.prepare(
    `INSERT INTO ocr_usage (period, count, updated_at) VALUES (?1, 1, ?2)
     ON CONFLICT(period) DO UPDATE SET count = ocr_usage.count + 1, updated_at = ?2 WHERE ocr_usage.count < ?3
     RETURNING count`,
  )
    .bind(visionPeriod(now), now, cap)
    .first<{ count: number }>();
  return !!r;
}

// ---------- online Local OCR computers ----------
/** A computer is "online" if it polled recently; the window always covers at least 2.5 poll intervals. */
export function onlineWindowMs(settings: AppSettings) {
  return Math.max(settings.agentOnlineSeconds, settings.agentPollSeconds * 2.5) * 1000;
}

export async function onlineAgents(env: Env, settings: AppSettings, now = Date.now()) {
  const r = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ocr_agents WHERE disabled = 0 AND last_seen_at > ?`)
    .bind(now - onlineWindowMs(settings))
    .first<{ n: number }>();
  return r?.n ?? 0;
}

export type Route = 'vision' | 'aiforthai' | 'local' | 'wait_quota' | 'off';

/**
 * Decide who reads this plate.
 *  - vision_then_local: Vision while under the cap, otherwise wait for a Local OCR computer.
 *  - local_then_vision: a Local OCR computer if any is online, otherwise Vision within the cap,
 *    otherwise wait for a computer.
 *  - google_vision: Vision within the cap, otherwise wait for next month (or the admin button).
 * Vision calls are reserved atomically, so concurrent jobs can never go over the cap.
 */
export async function decideRoute(env: Env, settings: AppSettings, now = Date.now()): Promise<Route> {
  switch (settings.ocrProvider) {
    case 'none':
      return 'off';
    case 'aiforthai':
      return 'aiforthai';
    case 'local':
      return 'local';
    case 'google_vision':
      return (await reserveVisionCall(env, settings, now)) ? 'vision' : 'wait_quota';
    case 'vision_then_local':
      return (await reserveVisionCall(env, settings, now)) ? 'vision' : 'local';
    case 'local_then_vision':
      if ((await onlineAgents(env, settings, now)) > 0) return 'local';
      return (await reserveVisionCall(env, settings, now)) ? 'vision' : 'local';
  }
}

// ---------- signed image links (let Google fetch the photo itself) ----------
async function hmac(key: string, data: string) {
  const k = await crypto.subtle.importKey('raw', fromB64(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(data));
  return b64(new Uint8Array(sig)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function signedImageUrl(env: Env, baseUrl: string, imageId: string, now = Date.now()) {
  if (!env.TOKEN_ENC_KEY || !baseUrl) return null;
  const exp = now + 10 * 60_000;
  const sig = await hmac(env.TOKEN_ENC_KEY, `${imageId}.${exp}`);
  return `${baseUrl.replace(/\/$/, '')}/api/ocr-image/${encodeURIComponent(imageId)}?exp=${exp}&sig=${sig}`;
}

export async function verifyImageSig(env: Env, imageId: string, exp: string, sig: string, now = Date.now()) {
  if (!env.TOKEN_ENC_KEY || Number(exp) < now) return false;
  const expected = await hmac(env.TOKEN_ENC_KEY, `${imageId}.${exp}`);
  if (expected.length !== sig.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  return diff === 0;
}

/** The best copy for recognition: the un-watermarked original if kept, else the display copy. */
export async function ocrImageResponse(env: Env, drive: DriveClient, img: any): Promise<Response> {
  if (img.drive_file_id) return drive.download(img.drive_file_id);
  const cached = await getCache(env, img.id, 'display');
  if (cached) return new Response(cached.body, { headers: { 'Content-Type': 'image/jpeg' } });
  return drive.download(img.drive_display_file_id);
}

// ---------- providers ----------
export async function googleVision(env: Env, kind: OcrKind, src: { url?: string; bytes?: () => Promise<ArrayBuffer> }): Promise<OcrResult> {
  if (visionOverride) return visionOverride(env, src, kind);
  if (!env.GOOGLE_VISION_API_KEY) throw new Error('GOOGLE_VISION_API_KEY is not configured.');
  const call = async (image: Record<string, unknown>) => {
    const res = await fetch(`https://vision.googleapis.com/v1/images:annotate?key=${encodeURIComponent(env.GOOGLE_VISION_API_KEY!)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requests: [{ image, features: [{ type: 'TEXT_DETECTION' }], imageContext: { languageHints: ['th', 'en'] } }] }),
    });
    return { res, body: (await res.json()) as any };
  };
  // Prefer a signed URL: Google downloads the photo itself, so the Worker never has to
  // base64-encode megabytes (which would exceed the free plan's 10 ms CPU budget).
  let { res, body } = src.url ? await call({ source: { imageUri: src.url } }) : { res: null as Response | null, body: null as any };
  if (!res || !res.ok || body?.responses?.[0]?.error) {
    if (!src.bytes) throw new Error(`Vision API error: ${body?.error?.message ?? body?.responses?.[0]?.error?.message ?? res?.status}`);
    ({ res, body } = await call({ content: b64(new Uint8Array(await src.bytes())) }));
  }
  if (!res.ok || body.responses?.[0]?.error) {
    throw new Error(`Vision API error: ${body.error?.message ?? body.responses?.[0]?.error?.message ?? res.status}`);
  }
  const text: string = body.responses?.[0]?.fullTextAnnotation?.text ?? body.responses?.[0]?.textAnnotations?.[0]?.description ?? '';
  const conf = body.responses?.[0]?.fullTextAnnotation?.pages?.[0]?.confidence;
  // Vision handles rotated documents itself (fullTextAnnotation follows the text orientation).
  return resultFromText(text, typeof conf === 'number' ? conf : null, kind);
}

export async function aiForThai(env: Env, image: ArrayBuffer): Promise<OcrResult> {
  if (!env.AIFORTHAI_API_KEY) throw new Error('AIFORTHAI_API_KEY is not configured.');
  const form = new FormData();
  form.append('image', new Blob([image], { type: 'image/jpeg' }), 'plate.jpg');
  form.append('crop', '1');
  form.append('rotate', '1');
  const res = await fetch('https://api.aiforthai.in.th/lpr-v2', { method: 'POST', headers: { Apikey: env.AIFORTHAI_API_KEY }, body: form });
  const text = await res.text();
  if (!res.ok) throw new Error(`AI for Thai error ${res.status}: ${text.slice(0, 200)}`);
  try {
    const body = JSON.parse(text);
    const first = Array.isArray(body) ? body[0] : body;
    const candidate: string = first?.lpr ?? first?.plate ?? first?.license_plate ?? '';
    const c = first?.conf ?? first?.confidence;
    return {
      raw: text.slice(0, 2000),
      plate: extractThaiPlate(candidate) ?? (candidate ? candidate.split(/\s+/).slice(0, 2).join(' ') : null),
      confidence: typeof c === 'number' ? (c > 1 ? c / 100 : c) : null,
    };
  } catch {
    return resultFromText(text, null);
  }
}

// ---------- applying a result ----------
/**
 * Store an OCR result on the round (unless an admin already corrected the plate by hand),
 * record it in the plate history, and rename the Drive folder (same folder ID).
 */
export async function applyOcrResult(
  env: Env,
  drive: DriveClient,
  roundId: string,
  result: OcrResult,
  source: string,
  now = Date.now(),
  kind: OcrKind = 'plate',
) {
  const round = await env.DB.prepare(`SELECT plate_text, plate_norm, plate_source, plate_ocr_score FROM rounds WHERE id = ?`).bind(roundId).first<any>();
  if (!round) return;
  // A plate-photo reading this unsure is noise, not a plate: keep it only as raw text for the admin.
  const tooUnsure = kind === 'plate' && result.confidence != null && result.confidence < MIN_PLATE_CONFIDENCE;
  const plate = result.plate && !tooUnsure ? result.plate.normalize('NFC').replace(/\s+/g, ' ').trim().slice(0, 30) : null;
  let score = ocrScore(result.confidence, kind);
  // Two readings (slip + plate photo) that agree reinforce each other.
  if (plate && round.plate_source === 'ocr' && plateCore(round.plate_text) === plateCore(plate)) score = Math.max(score, round.plate_ocr_score ?? 0) + 0.05;
  // Replace the plate only if: not corrected by hand, this reading found a plate, and it is
  // at least as trustworthy as the current automatic one. A failed reading never erases a good one.
  const replace = !!plate && round.plate_source !== 'manual' && (round.plate_source !== 'ocr' || score >= (round.plate_ocr_score ?? 0));
  if (replace) {
    await env.DB.prepare(
      `UPDATE rounds SET plate_raw = ?, plate_confidence = ?, plate_ocr_score = ?, ocr_status = 'done',
         plate_text = ?, plate_norm = ?, plate_digits = ?, plate_source = 'ocr', plate_updated_at = ?, updated_at = ?
       WHERE id = ? AND plate_source != 'manual'`,
    )
      .bind(result.raw, result.confidence, score, plate, normalizePlate(plate), plateDigits(plate) || null, now, now, roundId)
      .run();
  } else {
    await env.DB.prepare(
      `UPDATE rounds SET ocr_status = CASE WHEN plate_source = 'none' THEN 'done' ELSE ocr_status END,
         plate_raw = CASE WHEN plate_source = 'none' THEN ? ELSE plate_raw END, updated_at = ? WHERE id = ?`,
    )
      .bind(result.raw, now, roundId)
      .run();
  }
  await env.DB.prepare(
    `INSERT INTO plate_history (round_id, at, actor_id, source, old_text, new_text, raw, confidence) VALUES (?, ?, NULL, ?, ?, ?, ?, ?)`,
  )
    .bind(roundId, now, source.slice(0, 60), round.plate_text, plate, result.raw.slice(0, 500), result.confidence)
    .run();
  if (replace) await syncRoundFolderName(env, drive, roundId);
}
