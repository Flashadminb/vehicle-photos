import { env } from 'cloudflare:test';
import { app } from '../../src/worker/index';
import type { Env, AuthUser } from '../../src/worker/env';
import { DemoDrive } from '../../src/worker/drive/demo';
import { createPasswordHash } from '../../src/worker/auth/session';

export const testEnv = env as unknown as Env;
export const ORIGIN = 'http://test.local';

/** Minimal browser-like client: path-scoped cookies, our CSRF header, JSON helpers. */
export class Client {
  cookies = new Map<string, { value: string; path: string }>();

  async req(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const h = new Headers(headers);
    h.set('Origin', ORIGIN);
    if (method !== 'GET') h.set('X-VP-Client', h.get('X-VP-Client') ?? '1');
    if (body !== undefined && !(body instanceof ArrayBuffer)) h.set('Content-Type', 'application/json');
    const cookie = [...this.cookies.entries()]
      .filter(([, c]) => path.startsWith(c.path))
      .map(([k, c]) => `${k}=${c.value}`)
      .join('; ');
    if (cookie) h.set('Cookie', cookie);
    const res = await app.fetch(
      new Request(`${ORIGIN}${path}`, {
        method,
        headers: h,
        body: body === undefined ? undefined : body instanceof ArrayBuffer ? body : JSON.stringify(body),
      }),
      testEnv,
      { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext,
    );
    for (const sc of res.headers.getSetCookie?.() ?? []) {
      const [pair, ...attrs] = sc.split(';');
      const [k, v] = pair.split('=');
      const p = attrs.map((a) => a.trim()).find((a) => a.toLowerCase().startsWith('path='));
      if (v === '' || /max-age=0/i.test(sc)) this.cookies.delete(k);
      else this.cookies.set(k, { value: v, path: p ? p.slice(5) : '/' });
    }
    return res;
  }
  async json<T = any>(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<{ status: number; body: T }> {
    const res = await this.req(method, path, body, headers);
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : (null as T) };
  }
}

let n = 0;
export async function createUser(role: AuthUser['role'], password = 'password-1234') {
  const id = crypto.randomUUID();
  const username = `${role}_${Date.now().toString(36)}_${n++}`;
  const now = Date.now();
  await testEnv.DB.prepare(
    `INSERT INTO users (id, username, display_name, role, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, username, `Test ${role} ${n}`, role, await createPasswordHash(testEnv, password), now, now)
    .run();
  const user: AuthUser = { id, username, displayName: `Test ${role} ${n}`, role, language: null, hasPin: false, mustChangePassword: false };
  return { user, username, password };
}

export async function loggedIn(kind: 'field' | 'admin', role: AuthUser['role']) {
  const { user, username, password } = await createUser(role);
  const client = new Client();
  const r = await client.json('POST', `/api/${kind}/login`, { username, password });
  if (r.status !== 200) throw new Error(`login failed ${r.status} ${JSON.stringify(r.body)}`);
  return { client, user };
}

/** Upload bytes to a demo upload URL as the browser would, returning the Drive file id. */
export async function putToDrive(client: Client, url: string, bytes = new Uint8Array([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9])) {
  const path = url.replace(ORIGIN, '');
  const r = await client.json('PUT', path, bytes.buffer.slice(0) as ArrayBuffer);
  if (r.status !== 200) throw new Error(`upload failed ${r.status}`);
  return r.body.id as string;
}

export const rid = () => crypto.randomUUID();

export function recordingDrive() {
  return new DemoDrive(testEnv, ORIGIN);
}
