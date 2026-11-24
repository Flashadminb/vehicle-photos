import type { Env } from '../env';
import type { OcrProvider } from '../../shared/types';
import { extractThaiPlate } from '../../shared/plate';
import { b64 } from '../util';

export interface OcrResult {
  raw: string;
  plate: string | null;
  confidence: number | null;
}

/**
 * Plate recognition providers. Recognition is never perfect: results are stored as
 * raw text + a normalised plate + confidence, never block capture or DONE (unless an
 * admin enables ocrBlocksDone), and can always be corrected by an administrator.
 *
 * IMPORTANT: validate the chosen provider with real representative plate photos before
 * relying on it. The AI for Thai response format below is parsed defensively and is
 * marked experimental in the README.
 */
export async function recognizePlate(env: Env, provider: OcrProvider, image: ArrayBuffer): Promise<OcrResult> {
  if (provider === 'google_vision') return googleVision(env, image);
  if (provider === 'aiforthai') return aiForThai(env, image);
  throw new Error('OCR is disabled.');
}

async function googleVision(env: Env, image: ArrayBuffer): Promise<OcrResult> {
  if (!env.GOOGLE_VISION_API_KEY) throw new Error('GOOGLE_VISION_API_KEY is not configured.');
  const res = await fetch(`https://vision.googleapis.com/v1/images:annotate?key=${encodeURIComponent(env.GOOGLE_VISION_API_KEY)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      requests: [
        {
          image: { content: b64(new Uint8Array(image)) },
          features: [{ type: 'TEXT_DETECTION' }],
          imageContext: { languageHints: ['th', 'en'] },
        },
      ],
    }),
  });
  const body = (await res.json()) as any;
  if (!res.ok || body.responses?.[0]?.error) {
    throw new Error(`Vision API error: ${body.error?.message ?? body.responses?.[0]?.error?.message ?? res.status}`);
  }
  const text: string = body.responses?.[0]?.fullTextAnnotation?.text ?? body.responses?.[0]?.textAnnotations?.[0]?.description ?? '';
  // Vision gives per-page confidence for the full text annotation when available.
  const conf = body.responses?.[0]?.fullTextAnnotation?.pages?.[0]?.confidence;
  return { raw: text.slice(0, 2000), plate: extractThaiPlate(text), confidence: typeof conf === 'number' ? conf : null };
}

async function aiForThai(env: Env, image: ArrayBuffer): Promise<OcrResult> {
  if (!env.AIFORTHAI_API_KEY) throw new Error('AIFORTHAI_API_KEY is not configured.');
  const form = new FormData();
  form.append('image', new Blob([image], { type: 'image/jpeg' }), 'plate.jpg');
  form.append('crop', '1');
  form.append('rotate', '1');
  const res = await fetch('https://api.aiforthai.in.th/lpr-v2', {
    method: 'POST',
    headers: { Apikey: env.AIFORTHAI_API_KEY },
    body: form,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`AI for Thai error ${res.status}: ${text.slice(0, 200)}`);
  let plate: string | null = null;
  let confidence: number | null = null;
  try {
    const body = JSON.parse(text);
    const first = Array.isArray(body) ? body[0] : body;
    const candidate: string = first?.lpr ?? first?.plate ?? first?.license_plate ?? '';
    plate = extractThaiPlate(candidate) ?? (candidate ? candidate.split(/\s+/).slice(0, 2).join(' ') : null);
    const c = first?.conf ?? first?.confidence;
    confidence = typeof c === 'number' ? (c > 1 ? c / 100 : c) : null;
  } catch {
    plate = extractThaiPlate(text);
  }
  return { raw: text.slice(0, 2000), plate, confidence };
}
