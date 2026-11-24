import { Hono } from 'hono';
import type { AppBindings } from '../env';
import type { BeginImageRequest, CompleteImageRequest, FieldBootstrap } from '../../shared/types';
import { login, logout, requireSession, validateNewPassword, createPasswordHash, revokeUserSessions } from '../auth/session';
import { verifyPassword } from '../crypto';
import { ApiError, badRequest, clientIp, forbidden, notFound, readJson, str } from '../util';
import { getCurrentWorkflow, getLanguages, getSettings, getTranslationOverrides } from '../services/config';
import { beginImage, completeImage, finalizeRound, roundState } from '../services/rounds';
import { MAX_CACHE_OBJECT_BYTES, putCache } from '../services/cache';
import { isDemo } from '../drive';

export const field = new Hono<AppBindings>();

const baseUrl = (url: string) => new URL(url).origin;

field.post('/login', async (c) => {
  const body = await readJson<{ username: string; password: string }>(c);
  const user = await login(c, 'field', str(body.username, 'username', { max: 64 }), str(body.password, 'password', { max: 200 }), clientIp(c));
  return c.json({ user });
});

field.post('/logout', async (c) => {
  await logout(c, 'field');
  return c.json({ ok: true });
});

field.use('/*', requireSession('field'));

field.get('/bootstrap', async (c) => {
  const [workflow, languages, overrides, settings] = await Promise.all([
    getCurrentWorkflow(c.env),
    getLanguages(c.env),
    getTranslationOverrides(c.env),
    getSettings(c.env),
  ]);
  const body: FieldBootstrap = {
    user: { ...c.get('user') },
    workflow,
    languages: languages.filter((l) => l.enabled),
    translations: overrides,
    settings: {
      unknownPlateLabel: settings.unknownPlateLabel,
      defaultLanguage: settings.defaultLanguage,
      fallbackLanguage: settings.fallbackLanguage,
      pinLockEnabled: settings.pinLockEnabled,
      pinLockMinutes: settings.pinLockMinutes,
      ocrBlocksDone: settings.ocrBlocksDone,
    },
    driveMode: isDemo(c.env) ? 'demo' : 'google',
    serverTime: Date.now(),
  };
  return c.json({ ...body, mustChangePassword: c.get('user').mustChangePassword });
});

/** Operators may choose their own interface language; they cannot edit global settings. */
field.put('/me/language', async (c) => {
  const { language } = await readJson<{ language: string }>(c);
  const langs = await getLanguages(c.env);
  if (!langs.some((l) => l.code === language && l.enabled)) throw badRequest('Unknown language.');
  await c.env.DB.prepare(`UPDATE users SET language = ?, updated_at = ? WHERE id = ?`).bind(language, Date.now(), c.get('user').id).run();
  return c.json({ ok: true });
});

field.post('/me/password', async (c) => {
  const { currentPassword, newPassword } = await readJson<{ currentPassword: string; newPassword: string }>(c);
  const user = c.get('user');
  const row = await c.env.DB.prepare(`SELECT password_hash FROM users WHERE id = ?`).bind(user.id).first<any>();
  if (!(await verifyPassword(String(currentPassword ?? ''), row.password_hash))) throw new ApiError(400, 'wrong_password', 'Current password is incorrect.');
  const hash = await createPasswordHash(c.env, validateNewPassword(newPassword));
  await c.env.DB.prepare(`UPDATE users SET password_hash = ?, must_change_password = 0, updated_at = ? WHERE id = ?`).bind(hash, Date.now(), user.id).run();
  return c.json({ ok: true });
});

/**
 * App-lock PIN check. The lock screen is a convenience lock for a shared/unattended
 * phone; uploads keep running underneath it. After 5 wrong PINs the sessions on this
 * account are revoked and a full sign-in is required.
 */
field.post('/unlock', async (c) => {
  const { pin } = await readJson<{ pin: string }>(c);
  const user = c.get('user');
  const row = await c.env.DB.prepare(`SELECT pin_hash FROM users WHERE id = ?`).bind(user.id).first<any>();
  if (!row?.pin_hash) return c.json({ ok: true });
  const key = `pin:${user.id}`;
  if (await verifyPassword(String(pin ?? ''), row.pin_hash)) {
    await c.env.DB.prepare(`DELETE FROM login_attempts WHERE key = ?`).bind(key).run();
    return c.json({ ok: true });
  }
  const now = Date.now();
  const r = await c.env.DB.prepare(
    `INSERT INTO login_attempts (key, fails, updated_at) VALUES (?1, 1, ?2)
     ON CONFLICT(key) DO UPDATE SET fails = login_attempts.fails + 1, updated_at = ?2 RETURNING fails`,
  )
    .bind(key, now)
    .first<{ fails: number }>();
  if ((r?.fails ?? 0) >= 5) {
    await revokeUserSessions(c.env, user.id, now);
    await c.env.DB.prepare(`DELETE FROM login_attempts WHERE key = ?`).bind(key).run();
    throw new ApiError(401, 'unauthenticated', 'Too many wrong PINs. Please sign in again.');
  }
  throw new ApiError(400, 'wrong_pin', 'Incorrect PIN.');
});

field.post('/images/begin', async (c) => {
  const body = await readJson<BeginImageRequest>(c);
  const res = await beginImage(c.env, c.get('user'), body, {
    origin: c.req.header('Origin') ?? null,
    baseUrl: baseUrl(c.req.url),
  });
  return c.json(res);
});

field.post('/images/:id/complete', async (c) => {
  const body = await readJson<CompleteImageRequest>(c);
  const res = await completeImage(c.env, c.get('user'), c.req.param('id'), body, { baseUrl: baseUrl(c.req.url) });
  return c.json(res);
});

/** Best-effort upload of the recent-view cache copies (thumb / display) to R2. */
field.put('/images/:id/cache/:kind', async (c) => {
  const kind = c.req.param('kind');
  if (kind !== 'thumb' && kind !== 'display') throw notFound();
  const id = c.req.param('id');
  const img = await c.env.DB.prepare(
    `SELECT i.id, r.operator_id FROM images i JOIN rounds r ON r.id = i.round_id WHERE i.id = ?`,
  )
    .bind(id)
    .first<any>();
  if (!img) throw notFound();
  if (img.operator_id !== c.get('user').id) throw forbidden();
  const len = Number(c.req.header('Content-Length') ?? '0');
  if (len > MAX_CACHE_OBJECT_BYTES) throw badRequest('Cache image too large.');
  const body = await c.req.arrayBuffer();
  if (body.byteLength === 0 || body.byteLength > MAX_CACHE_OBJECT_BYTES) throw badRequest('Invalid cache image.');
  await putCache(c.env, id, kind, body);
  return c.json({ ok: true });
});

field.post('/rounds/:id/finalize', async (c) => {
  const { idempotencyKey } = await readJson<{ idempotencyKey: string }>(c);
  const res = await finalizeRound(c.env, c.get('user'), c.req.param('id'), str(idempotencyKey, 'idempotencyKey', { max: 64 }));
  return c.json(res);
});

field.get('/rounds/by-client/:clientRoundId', async (c) => {
  const state = await roundState(c.env, c.get('user'), c.req.param('clientRoundId'));
  if (!state) throw notFound('Round not on server yet.');
  return c.json(state);
});
