import { b64, fromB64 } from './util';

const enc = new TextEncoder();

/**
 * Password hashing with PBKDF2-SHA256 (WebCrypto; available in Workers).
 * Format: pbkdf2$<iterations>$<salt b64>$<hash b64>. Iterations are stored per hash,
 * so the cost can be raised later without breaking existing passwords.
 */
export async function hashPassword(password: string, iterations = 100_000): Promise<string> {
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  const hash = await pbkdf2(password, salt, iterations);
  return `pbkdf2$${iterations}$${b64(salt)}$${b64(hash)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [alg, iterStr, saltB64, hashB64] = stored.split('$');
  if (alg !== 'pbkdf2') return false;
  const expected = fromB64(hashB64);
  const actual = await pbkdf2(password, fromB64(saltB64), Number(iterStr));
  return timingSafeEqual(actual, expected);
}

async function pbkdf2(password: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
  return new Uint8Array(bits);
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** AES-GCM encryption for secrets at rest (Google refresh token). */
async function aesKey(keyB64: string): Promise<CryptoKey> {
  const raw = fromB64(keyB64);
  if (raw.length !== 32) throw new Error('TOKEN_ENC_KEY must be 32 bytes, base64 encoded.');
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function encryptSecret(plain: string, keyB64: string): Promise<string> {
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(keyB64), enc.encode(plain));
  return `${b64(iv)}.${b64(new Uint8Array(ct))}`;
}

export async function decryptSecret(payload: string, keyB64: string): Promise<string> {
  const [ivB64, ctB64] = payload.split('.');
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(ivB64) }, await aesKey(keyB64), fromB64(ctB64));
  return new TextDecoder().decode(pt);
}
