import type { Context, MiddlewareHandler } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import type { AppBindings, AuthUser, Env } from '../env';
import { ADMIN_ROLES, FIELD_ROLES, type Role } from '../../shared/types';
import { ApiError, forbidden, randomToken, sha256Hex } from '../util';
import { can, type Permission } from './permissions';
import { hashPassword, verifyPassword } from '../crypto';

export type SessionKind = 'field' | 'admin';

/**
 * Field and admin sessions use different cookies scoped to different paths, so an
 * operator's field cookie is never even sent to /api/admin/*. Authorization is
 * still checked server-side on every request.
 */
export const COOKIE: Record<SessionKind, { name: string; path: string; ttlMs: number }> = {
  field: { name: 'vp_field', path: '/api/field', ttlMs: 30 * 24 * 3600_000 },
  admin: { name: 'vp_admin', path: '/api/admin', ttlMs: 12 * 3600_000 },
};

const ALLOWED_ROLES: Record<SessionKind, Role[]> = { field: FIELD_ROLES, admin: ADMIN_ROLES };
/** Per-account lock after 5 failures; per-IP lock is looser because field teams often share one NAT IP. */
const lockFailsFor = (key: string) => (key.startsWith('ip:') ? 30 : 5);
const LOCK_MS = 15 * 60_000;

function isSecure(c: Context) {
  return new URL(c.req.url).protocol === 'https:';
}

export function passwordIterations(env: Env) {
  const n = Number(env.PASSWORD_ITERATIONS || 100_000);
  return Math.min(100_000, Math.max(10_000, n));
}

export async function createPasswordHash(env: Env, password: string) {
  return hashPassword(password, passwordIterations(env));
}

export function validateNewPassword(pw: unknown): string {
  if (typeof pw !== 'string' || pw.length < 8 || pw.length > 200) {
    throw new ApiError(400, 'weak_password', 'รหัสผ่านต้องยาว 8–200 ตัวอักษร');
  }
  return pw;
}

async function checkLock(env: Env, keys: string[], now: number) {
  for (const key of keys) {
    const r = await env.DB.prepare(`SELECT locked_until FROM login_attempts WHERE key = ?`).bind(key).first<{ locked_until: number | null }>();
    if (r?.locked_until && r.locked_until > now) {
      throw new ApiError(429, 'locked', 'ใส่รหัสผิดหลายครั้งเกินไป กรุณาลองใหม่ภายหลัง');
    }
  }
}

async function recordFail(env: Env, keys: string[], now: number) {
  for (const key of keys) {
    await env.DB.prepare(
      `INSERT INTO login_attempts (key, fails, locked_until, updated_at) VALUES (?1, 1, NULL, ?2)
       ON CONFLICT(key) DO UPDATE SET
         fails = CASE WHEN login_attempts.updated_at < ?2 - ?4 THEN 1 ELSE login_attempts.fails + 1 END,
         locked_until = CASE WHEN (CASE WHEN login_attempts.updated_at < ?2 - ?4 THEN 1 ELSE login_attempts.fails + 1 END) >= ?3 THEN ?2 + ?4 ELSE NULL END,
         updated_at = ?2`,
    )
      .bind(key, now, lockFailsFor(key), LOCK_MS)
      .run();
  }
}

export async function login(c: Context<AppBindings>, kind: SessionKind, username: string, password: string, ip: string) {
  const env = c.env;
  const now = Date.now();
  const keys = [`u:${kind}:${username.toLowerCase()}`, `ip:${ip}`];
  await checkLock(env, keys, now);
  const row = await env.DB.prepare(`SELECT * FROM users WHERE username = ?`).bind(username).first<any>();
  const ok = row ? await verifyPassword(password, row.password_hash) : false;
  if (!row || !ok) {
    await recordFail(env, keys, now);
    throw new ApiError(401, 'invalid_credentials', 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง');
  }
  if (row.disabled) throw new ApiError(403, 'disabled', 'บัญชีนี้ถูกปิดใช้งาน');
  if (!ALLOWED_ROLES[kind].includes(row.role)) {
    throw forbidden(kind === 'admin' ? 'บัญชีนี้ไม่มีสิทธิ์ใช้แดชบอร์ดผู้ดูแล' : 'บัญชีนี้ไม่มีสิทธิ์ใช้แอปภาคสนาม');
  }
  await env.DB.prepare(`DELETE FROM login_attempts WHERE key = ?`).bind(keys[0]).run();
  const token = randomToken();
  const id = await sha256Hex(token);
  const cfg = COOKIE[kind];
  await env.DB.prepare(
    `INSERT INTO sessions (id, user_id, kind, created_at, expires_at, last_seen_at, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, row.id, kind, now, now + cfg.ttlMs, now, (c.req.header('User-Agent') ?? '').slice(0, 200))
    .run();
  setCookie(c, cfg.name, token, {
    path: cfg.path,
    httpOnly: true,
    secure: isSecure(c),
    sameSite: 'Strict',
    maxAge: Math.floor(cfg.ttlMs / 1000),
  });
  return toAuthUser(row);
}

export async function logout(c: Context<AppBindings>, kind: SessionKind) {
  const token = getCookie(c, COOKIE[kind].name);
  if (token) {
    await c.env.DB.prepare(`UPDATE sessions SET revoked_at = ? WHERE id = ?`).bind(Date.now(), await sha256Hex(token)).run();
  }
  deleteCookie(c, COOKIE[kind].name, { path: COOKIE[kind].path });
}

export function toAuthUser(row: any): AuthUser {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    role: row.role,
    language: row.language ?? null,
    hasPin: !!row.pin_hash,
    mustChangePassword: !!row.must_change_password,
  };
}

/** Requires a valid, unexpired, unrevoked session of the given kind for an enabled user with an allowed role. */
export function requireSession(kind: SessionKind): MiddlewareHandler<AppBindings> {
  return async (c, next) => {
    const now = Date.now();
    c.set('now', now);
    // CSRF defence in depth (cookies are also SameSite=Strict): mutating requests must carry our header.
    if (!['GET', 'HEAD'].includes(c.req.method) && c.req.header('X-VP-Client') !== '1') {
      throw new ApiError(403, 'csrf', 'Missing client header.');
    }
    const token = getCookie(c, COOKIE[kind].name);
    if (!token) throw new ApiError(401, 'unauthenticated', 'กรุณาเข้าสู่ระบบ');
    const id = await sha256Hex(token);
    const row = await c.env.DB.prepare(
      `SELECT s.id AS sid, s.kind, s.expires_at, s.revoked_at, s.last_seen_at, u.*
       FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?`,
    )
      .bind(id)
      .first<any>();
    if (!row || row.kind !== kind || row.revoked_at || row.expires_at < now) {
      throw new ApiError(401, 'unauthenticated', 'หมดเวลาการใช้งาน กรุณาเข้าสู่ระบบใหม่');
    }
    if (row.disabled) throw new ApiError(401, 'unauthenticated', 'This account is disabled.');
    if (!ALLOWED_ROLES[kind].includes(row.role)) throw forbidden();
    // Sliding expiry, written at most every 5 minutes to save D1 writes.
    if (now - row.last_seen_at > 5 * 60_000) {
      await c.env.DB.prepare(`UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?`)
        .bind(now, now + COOKIE[kind].ttlMs, id)
        .run();
    }
    c.set('user', toAuthUser(row));
    c.set('sessionId', id);
    await next();
  };
}

export function requirePermission(perm: Permission): MiddlewareHandler<AppBindings> {
  return async (c, next) => {
    const user = c.get('user');
    if (!user || !can(user.role, perm)) throw forbidden();
    await next();
  };
}

export function assertPermission(user: AuthUser, perm: Permission) {
  if (!can(user.role, perm)) throw forbidden();
}

export async function revokeUserSessions(env: Env, userId: string, now = Date.now()) {
  await env.DB.prepare(`UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL`).bind(now, userId).run();
}
