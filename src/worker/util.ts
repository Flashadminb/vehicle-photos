import type { Context } from 'hono';

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (msg: string, details?: unknown) => new ApiError(400, 'bad_request', msg, details);
export const forbidden = (msg = 'คุณไม่มีสิทธิ์ทำรายการนี้') => new ApiError(403, 'forbidden', msg);
export const notFound = (msg = 'Not found.') => new ApiError(404, 'not_found', msg);
export const conflict = (code: string, msg: string, details?: unknown) => new ApiError(409, code, msg, details);
/** Temporary failure; the client should retry later. */
export const unavailable = (code: string, msg: string) => new ApiError(503, code, msg);

export function errorResponse(c: Context, err: unknown) {
  if (err instanceof ApiError) {
    return c.json({ error: { code: err.code, message: err.message, details: err.details } }, err.status as 400);
  }
  console.error('Unhandled error', err);
  return c.json({ error: { code: 'internal', message: 'Internal server error.' } }, 500);
}

export function uuid(): string {
  return crypto.randomUUID();
}

export function randomToken(bytes = 32): string {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return b64url(b);
}

export function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const x of bytes) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64(bytes: Uint8Array): string {
  let s = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) s += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(s);
}

export function fromB64(s: string): Uint8Array<ArrayBuffer> {
  const norm = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(norm + '='.repeat((4 - (norm.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function clientIp(c: Context): string {
  return c.req.header('CF-Connecting-IP') || c.req.header('X-Forwarded-For')?.split(',')[0].trim() || 'unknown';
}

export async function readJson<T>(c: Context): Promise<T> {
  try {
    return (await c.req.json()) as T;
  } catch {
    throw badRequest('Request body must be JSON.');
  }
}

export function str(v: unknown, name: string, opts: { max?: number; min?: number; optional?: boolean } = {}): string {
  if (v == null || v === '') {
    if (opts.optional) return '';
    throw badRequest(`${name} is required.`);
  }
  if (typeof v !== 'string') throw badRequest(`${name} must be a string.`);
  const s = v.trim();
  if (opts.min && s.length < opts.min) throw badRequest(`${name} must be at least ${opts.min} characters.`);
  if (s.length > (opts.max ?? 500)) throw badRequest(`${name} is too long.`);
  return s;
}

export function int(v: unknown, name: string, opts: { min?: number; max?: number; optional?: boolean } = {}): number {
  if (v == null || v === '') {
    if (opts.optional) return NaN;
    throw badRequest(`${name} is required.`);
  }
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n) || !Number.isInteger(n)) throw badRequest(`${name} must be an integer.`);
  if (opts.min != null && n < opts.min) throw badRequest(`${name} must be ≥ ${opts.min}.`);
  if (opts.max != null && n > opts.max) throw badRequest(`${name} must be ≤ ${opts.max}.`);
  return n;
}
