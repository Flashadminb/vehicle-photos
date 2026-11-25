import { PROVINCES } from './provinces';
/**
 * Thai license plate helpers.
 * Thai plates contain letters AND digits, e.g. "กข 1234", "1กข 1234", "70-1234".
 * We never assume digits only.
 */

const THAI_CONSONANTS = 'ก-ฮ';

/** Normalised form used for indexing/search: no spaces or dashes, Latin upper-cased. */
export function normalizePlate(text: string | null | undefined): string {
  if (!text) return '';
  return text
    .normalize('NFC')
    .replace(/[\s\-–—._·]/g, '')
    .replace(/[^0-9A-Za-z฀-๿]/g, '')
    .toUpperCase();
}

/** The trailing digit group (the serial), used for digit-only searches like "1234". */
export function plateDigits(text: string | null | undefined): string {
  const norm = normalizePlate(text);
  const m = /(\d+)$/.exec(norm);
  return m ? m[1] : '';
}

/**
 * Pull the most plate-like token out of free OCR text.
 * Returns the cleaned plate (letters + digits, with a single space between the
 * letter prefix and the serial) or null if nothing plausible was found.
 */
export function extractThaiPlate(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const text = raw.normalize('NFC').replace(/\r/g, '\n');
  const re = new RegExp(
    `(?:^|[^0-9${THAI_CONSONANTS}])([0-9]?\\s?[${THAI_CONSONANTS}]{1,3})\\s*-?\\s*([0-9]{1,4})(?![0-9])`,
    'g',
  );
  let best: string | null = null;
  let bestScore = -1;
  for (const m of text.matchAll(re)) {
    const prefix = m[1].replace(/\s/g, '');
    const serial = m[2];
    const score = serial.length * 2 + prefix.length;
    if (score > bestScore) {
      bestScore = score;
      best = `${prefix} ${serial}`;
    }
  }
  if (best) return best;
  // Numeric-prefix plates like "70-1234" (trucks/vans).
  const num = /(?:^|\D)(\d{2})\s*-\s*(\d{4})(?!\d)/.exec(text);
  return num ? `${num[1]}-${num[2]}` : null;
}

/**
 * Printed slips (e.g. the dispatch slip) show the registration followed by the province in
 * brackets: "บร7865(เพชรบุรี)", "70-1234(ชลบุรี)" or any other ID such as
 * "725067723224(พระนครศรีอยุธยา)". The generic form is only accepted when the bracket holds a
 * real province, so dates, barcodes and other IDs on the slip are ignored.
 */
export function extractSlipPlate(raw: string | null | undefined): { plate: string; province: string } | null {
  if (!raw) return null;
  const text = raw.normalize('NFC').replace(/\s+/g, ' ');
  const re = /(?:^|[^0-9ก-ฮ])([0-9]?[ก-ฮ]{1,3})\s*-?\s*(\d{1,4})\s*[(（]\s*([\u0E00-\u0E7F\s]{3,30}?)\s*[)）]/g;
  for (const m of text.matchAll(re)) {
    const province = m[3].replace(/\s/g, '');
    if (province.length >= 3) return { plate: `${m[1].replace(/\s/g, '')} ${m[2]}`, province };
  }
  // Truck format on a slip: "70-1234(ชลบุรี)".
  const t = /(?:^|\D)(\d{2})\s*-\s*(\d{4})\s*[(（]\s*([\u0E00-\u0E7F\s]{3,30}?)\s*[)）]/.exec(text);
  if (t) return { plate: `${t[1]}-${t[2]}`, province: t[3].replace(/\s/g, '') };
  // Any other registration printed before a province, e.g. "725067723224(พระนครศรีอยุธยา)".
  // Only accepted when the bracket really holds one of the 77 provinces (so "(ตัวอย่าง)" is ignored).
  // The token right before the bracket; groups of digits split by OCR spaces are joined.
  const g = /((?:\d+ )*[0-9A-Za-zก-ฮ-]*\d[0-9A-Za-zก-ฮ-]*)\s*[(（]\s*([\u0E00-\u0E7F\s]{3,30}?)\s*[)）]/g;
  for (const m of text.matchAll(g)) {
    const province = matchProvince(m[2]);
    const id = m[1].replace(/\s+/g, '').replace(/^-+|-+$/g, '');
    if (province && id.length >= 3 && id.length <= 20 && (id.match(/\d/g)?.length ?? 0) >= 3) return { plate: id, province };
  }
  return null;
}

function levenshtein(a: string, b: string) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

/** Closest of the 77 provinces if the OCR text is reasonably close to one (tolerates OCR slips). */
export function matchProvince(text: string): string | null {
  const t = (text || '').replace(/[^\u0E00-\u0E7F]/g, '');
  if (t.length < 3) return null;
  let best: { name: string; dist: number } | null = null;
  for (const p of PROVINCES) {
    const dist = levenshtein(t, p) / Math.max(t.length, p.length);
    if (!best || dist < best.dist) best = { name: p, dist };
  }
  return best && best.dist <= 0.35 ? best.name : null;
}
