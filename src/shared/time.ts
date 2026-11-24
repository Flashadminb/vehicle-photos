/**
 * Time helpers. Storage is always UTC epoch milliseconds.
 * Operational dates and displayed times use Asia/Bangkok, which is a fixed
 * UTC+07:00 offset with no daylight-saving time, so the arithmetic below is exact.
 */
export const BANGKOK_TZ = 'Asia/Bangkok';
export const BANGKOK_OFFSET_MS = 7 * 60 * 60 * 1000;
export const DAY_MS = 24 * 60 * 60 * 1000;

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/** Calendar parts of a UTC instant as seen in Bangkok. */
export function bangkokParts(utcMs: number) {
  const d = new Date(utcMs + BANGKOK_OFFSET_MS);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    second: d.getUTCSeconds(),
  };
}

/** YYYY-MM-DD in Bangkok. */
export function bangkokDate(utcMs: number): string {
  const p = bangkokParts(utcMs);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** HH-mm-ss in Bangkok (folder-name safe). */
export function bangkokTimeForName(utcMs: number): string {
  const p = bangkokParts(utcMs);
  return `${pad(p.hour)}-${pad(p.minute)}-${pad(p.second)}`;
}

/** "YYYY-MM-DD HH:mm:ss" in Bangkok. */
export function formatBangkok(utcMs: number | null | undefined): string {
  if (utcMs == null) return '';
  const p = bangkokParts(utcMs);
  return `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}`;
}

export function isValidDateString(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

export function isValidTimeString(s: string): boolean {
  const m = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(s);
  if (!m) return false;
  const h = Number(m[1]), mi = Number(m[2]), se = Number(m[3] ?? '0');
  return h < 24 && mi < 60 && se < 60;
}

/** Convert a Bangkok wall-clock date + time (seconds precision) to UTC ms. */
export function bangkokToUtc(date: string, time: string): number {
  if (!isValidDateString(date)) throw new Error(`Invalid date: ${date}`);
  if (!isValidTimeString(time)) throw new Error(`Invalid time: ${time}`);
  const [y, m, d] = date.split('-').map(Number);
  const [h, mi, s = 0] = time.split(':').map(Number);
  return Date.UTC(y, m - 1, d, h, mi, s) - BANGKOK_OFFSET_MS;
}

export interface Interval {
  fromMs: number;
  /** Inclusive upper bound: the last millisecond of the end second. */
  toMs: number;
}

/**
 * Build ONE continuous interval [startDate startTime, endDate endTime].
 * July 10 08:30 → July 12 17:45 means a single span, not a daily window.
 * The end second is inclusive (17:45:00 includes 17:45:00.999).
 */
export function buildInterval(
  startDate: string,
  endDate: string,
  startTime = '00:00:00',
  endTime = '23:59:59',
): Interval {
  const fromMs = bangkokToUtc(startDate, startTime);
  const toMs = bangkokToUtc(endDate, endTime) + 999;
  if (toMs < fromMs) {
    throw new Error('The end of the interval is before its start.');
  }
  return { fromMs, toMs };
}

/** Add days to a YYYY-MM-DD string. */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const t = Date.UTC(y, m - 1, d) + days * DAY_MS;
  const dt = new Date(t);
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

/** Compare YYYY-MM-DD strings. */
export function compareDates(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
