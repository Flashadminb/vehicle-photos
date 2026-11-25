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
export function extractSlipPlate(raw: string | null | undefined): { plate: string; province: string } | null {
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
    if (!hasDigit && !shortThai) break; // a word such as "Dispatching" or "ทะเบียน" ends the ID
    // "บร7865" is already a whole plate: a separate number before it is noise (e.g. "5 บร7865").
    if (picked.length && /^[ก-ฮ]+\d/.test(picked[0]) && /^\d+$/.test(t)) break;
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
