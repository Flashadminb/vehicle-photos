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
