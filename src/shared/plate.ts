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
  // The province in "บร 7865 (เพชรบุรี)" is not part of the serial.
  const norm = normalizePlate((text ?? '').replace(/\s*[(（].*$/, ''));
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
export function extractSlipPlate(raw: string | null | undefined): { plate: string; province: string; fallback?: true } | null {
  if (!raw) return null;
  const text = raw.normalize('NFC').replace(/[–—]/g, '-').replace(/\s+/g, ' ');
  for (const m of text.matchAll(/[(（]\s*([\u0E00-\u0E7F ]{2,30}?)\s*[)）]/g)) {
    const id = slipIdBefore(text.slice(0, m.index));
    if (!id) continue;
    const province = matchProvince(m[1]);
    // A real province is required, except for a classic "letters + digits" plate.
    const classic = /^[0-9]?[ก-ฮ]{1,3} ?-?\d{1,4}$/.test(id) || /^\d{2}-\d{4}$/.test(id);
    const cleaned = m[1].replace(/\s/g, '');
    if (province || (classic && cleaned.length >= 3)) return { plate: prettySlipId(id), province: province ?? cleaned };
  }
  // Last resort: whatever is printed where the plate goes, in any format.
  return slipLineFallback(raw);
}

const SLIP_DATE = /(?:19|20)\d{2}\s*[-/.]\s*\d{1,2}\s*[-/.]\s*\d{1,2}/;

/**
 * Format-agnostic fallback for the dispatch slip: take the text printed on the plate line —
 * the line right under "Proof of Van Dispatching", or the line that carries the date and a
 * bracket — minus the date, whatever its format. Marked `fallback` (lower confidence).
 */
export function slipLineFallback(raw: string): { plate: string; province: string; fallback: true } | null {
  const lines = raw
    .normalize('NFC')
    .replace(/[–—]/g, '-')
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  const candidates: string[] = [];
  const anchor = lines.findIndex((l) => /proof\s*of\s*van|van\s*dispatch/i.test(l));
  if (anchor >= 0) candidates.push(...lines.slice(anchor + 1, anchor + 3));
  candidates.push(...lines.filter((l) => SLIP_DATE.test(l) && /[(（]/.test(l)));
  for (const line of candidates) {
    const t = line.replace(SLIP_DATE, ' ').trim();
    const open = t.search(/[(（]/);
    const before = (open >= 0 ? t.slice(0, open) : t).trim();
    const inside = open >= 0 ? t.slice(open + 1).replace(/[)）].*$/, '') : '';
    // The ID is the run of letters/digits/dashes right before the bracket (spaces from OCR removed).
    const idMatch = /([0-9A-Za-zก-ฮ][0-9A-Za-zก-ฮ ./-]*)$/.exec(before);
    const id = (idMatch?.[1] ?? '').replace(/\s+/g, '').replace(/^[-./]+|[-./]+$/g, '').slice(-24);
    // Any format, but it must look like an ID: at least 3 digits (rejects OCR noise like "ขยง" or "40").
    if ((id.match(/\d/g)?.length ?? 0) < 3) continue;
    const thaiRaw = inside.replace(/[^\u0E00-\u0E7F]/g, '');
    const province = thaiRaw.length >= 3 ? matchProvince(thaiRaw) : null;
    // Guard against OCR noise (e.g. an upside-down read, or the barcode code under the bars):
    // with a bracket the province must be real; without one the line must also carry the date.
    if (open >= 0 ? !province : !SLIP_DATE.test(line)) continue;
    return { plate: prettySlipId(id), province: province ?? '', fallback: true };
  }
  return null;
}

/**
 * Everything printed right before the bracket that belongs to the registration: up to 5
 * space-separated pieces (OCR often splits "7250 6772 3224" or "1 กข 1234"), each made of
 * digits / Thai consonants / Latin letters / "-" "." "/", stopping at ordinary words.
 */
function slipIdBefore(before: string): string | null {
  const tokens = before.trimEnd().split(' ');
  const picked: string[] = [];
  for (let i = tokens.length - 1; i >= 0 && picked.length < 5; i--) {
    const t = tokens[i];
    if (!/^[0-9A-Za-zก-ฮ./-]+$/.test(t)) break;
    const hasDigit = /\d/.test(t);
    const shortThai = /^[ก-ฮ]{1,3}$/.test(t);
    const joiner = /^[-./]+$/.test(t); // "66 - 0632": OCR split the dash off
    if (!hasDigit && !shortThai && !joiner) break; // a word such as "Dispatching" or "ทะเบียน" ends the ID
    // Before a whole "บร7865" only a single-digit prefix belongs to it ("3 ฒช6128" → "3ฒช6128").
    if (picked.length && /^[ก-ฮ]+\d/.test(picked[0]) && /^\d{2,}$/.test(t)) break;
    picked.unshift(t);
  }
  const id = picked.join('').replace(/^[-./]+|[-./]+$/g, '');
  if (id.length < 2 || id.length > 24) return null;
  const digits = id.match(/\d/g)?.length ?? 0;
  if (digits < 1 || (digits < 3 && !/[ก-ฮ]/.test(id))) return null;
  return id;
}

/** "บร7865" → "บร 7865", "1กข1234" → "1กข 1234"; long numbers and other IDs stay as printed. */
function prettySlipId(id: string) {
  return id.replace(/([ก-ฮ])(?=\d)/g, '$1 ');
}

/** The registration without a trailing "(province)" / province, for comparing readings. */
export function plateCore(text: string | null | undefined): string {
  return normalizePlate((text ?? '').replace(/\s*[(（].*$/, ''));
}

function levenshtein(a: string, b: string) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

/** Closest of the 77 provinces if the OCR text is reasonably close to one (tolerates OCR slips). */
/** Short forms printed on slips. */
const PROVINCE_ALIASES: Record<string, string> = { กรุงเทพ: 'กรุงเทพมหานคร', กรุงเทพฯ: 'กรุงเทพมหานคร', กทม: 'กรุงเทพมหานคร', อยุธยา: 'พระนครศรีอยุธยา' };

export function matchProvince(text: string): string | null {
  const t = (text || '').replace(/[^\u0E00-\u0E7F]/g, '');
  if (t.length < 3) return null;
  if (PROVINCE_ALIASES[t]) return PROVINCE_ALIASES[t];
  const bare = t.replace(/ฯ$/, '');
  if (PROVINCE_ALIASES[bare]) return PROVINCE_ALIASES[bare];
  // A shortened name ("กรุงเทพ", "นครศรี") that starts exactly one province.
  if (bare.length >= 4) {
    const starts = PROVINCES.filter((p) => p.startsWith(bare));
    if (starts.length === 1) return starts[0];
  }
  let best: { name: string; dist: number } | null = null;
  for (const p of PROVINCES) {
    const dist = levenshtein(t, p) / Math.max(t.length, p.length);
    if (!best || dist < best.dist) best = { name: p, dist };
  }
  return best && best.dist <= 0.35 ? best.name : null;
}

/**
 * Bar number printed under the dispatch-slip barcode ("เลขบาร์รถ"), e.g. SAM1VFKD36, BKK1VFAX09:
 * 3 letters, a digit, then 5–7 letters/digits (at least one letter).
 */
const BAR_TOKEN = /(?:^|[^A-Z0-9])([A-Z]{3}[0-9][A-Z0-9]{5,7})(?![A-Z0-9])/g;

export function normalizeBarCode(text: string | null | undefined): string {
  return (text ?? '').normalize('NFC').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 20);
}

export function isBarCode(code: string): boolean {
  return /^[A-Z]{3}[0-9][A-Z0-9]{5,7}$/.test(code) && /[A-Z]/.test(code.slice(4));
}

/** Find the bar number in OCR text (also when OCR split it with a space, e.g. "SAM1VF KD36"). */
export function extractBarCode(raw: string | null | undefined): string | null {
  if (!raw) return null;
  // OCR often reads the "1" after the 3-letter prefix as I / l / |.
  const text = raw
    .normalize('NFC')
    .toUpperCase()
    .replace(/(?<![A-Z0-9])([A-Z]{3})[IL|!]([A-Z0-9]{5,7})(?![A-Z0-9])/g, '$11$2');
  const found: string[] = [];
  for (const m of text.matchAll(BAR_TOKEN)) if (isBarCode(m[1])) found.push(m[1]);
  if (!found.length) {
    for (const line of text.split(/\r?\n/)) {
      const compact = line.replace(/\s+/g, '');
      if (compact.length >= 9 && compact.length <= 11 && isBarCode(compact)) found.push(compact);
    }
  }
  // Prefer the usual 10-character form.
  return found.sort((a, b) => Math.abs(a.length - 10) - Math.abs(b.length - 10))[0] ?? null;
}

export function reverseText(s: string): string {
  return [...s].reverse().join('');
}
