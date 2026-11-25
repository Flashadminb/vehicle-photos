import { Hono } from 'hono';
import type { AppBindings, AuthUser } from '../env';
import type { AppSettings, Role } from '../../shared/types';
import { ROLES } from '../../shared/types';
import { buildInterval } from '../../shared/time';
import { BUILTIN_TRANSLATIONS, TRANSLATION_KEYS } from '../../shared/i18n';
import {
  login,
  logout,
  requireSession,
  requirePermission,
  createPasswordHash,
  validateNewPassword,
  revokeUserSessions,
} from '../auth/session';
import { can, manageableRoles, permissionsFor } from '../auth/permissions';
import { hashPassword, verifyPassword } from '../crypto';
import { ApiError, badRequest, clientIp, forbidden, int, notFound, randomToken, readJson, sha256Hex, str, uuid } from '../util';
import {
  getCurrentWorkflow,
  getWorkflow,
  getLanguages,
  getSettings,
  getTranslationOverrides,
  listWorkflowVersions,
  publishWorkflow,
  saveSettings,
  validateSettingsPatch,
  validateSteps,
} from '../services/config';
import { listSets, type HistoryQuery, isRecent } from '../services/history';
import { changeVisibility, loadVisibleSet, setDetails, updatePlate, type SetAction } from '../services/sets';
import { cacheUsage, evictCache, getCache, type CacheKind } from '../services/cache';
import { audit } from '../services/audit';
import { processJobs } from '../services/maintenance';
import { onlineWindowMs, visionCap, visionPeriod, visionUsage } from '../services/ocr';
import { getDrive, isDemo, effectiveRoot } from '../drive';
import { buildAuthUrl, clearToken, exchangeCode, loadToken, oauthRedirectUri, saveToken } from '../drive/google';
import { syncRoundFolderName } from '../drive/folders';
import { publicIdFromSeq } from '../../shared/names';
import { bangkokDate } from '../../shared/time';

export const admin = new Hono<AppBindings>();
const baseUrl = (url: string) => new URL(url).origin;

// ---------- Auth ----------
admin.post('/login', async (c) => {
  const body = await readJson<{ username: string; password: string }>(c);
  const user = await login(c, 'admin', str(body.username, 'username', { max: 64 }), str(body.password, 'password', { max: 200 }), clientIp(c));
  await audit(c.env, user, 'admin.login', { type: 'user', id: user.id }, undefined, clientIp(c));
  return c.json({ user });
});

admin.post('/logout', async (c) => {
  await logout(c, 'admin');
  return c.json({ ok: true });
});

/**
 * Google OAuth callback. It arrives as a cross-site navigation from Google, so the
 * SameSite=Strict admin cookie is not sent; the request is instead authorised by the
 * single-use, short-lived `state` value created by a Super Admin in /drive/oauth/start.
 */
admin.get('/drive/oauth/callback', async (c) => {
  const state = c.req.query('state') ?? '';
  const code = c.req.query('code') ?? '';
  const row = await c.env.DB.prepare(`SELECT value FROM settings WHERE key = 'oauth_state'`).first<{ value: string }>();
  await c.env.DB.prepare(`DELETE FROM settings WHERE key = 'oauth_state'`).run();
  const saved = row ? JSON.parse(row.value) : null;
  if (!saved || saved.state !== state || saved.expiresAt < Date.now() || !code) {
    return c.redirect('/admin/#/drive?error=' + encodeURIComponent('OAuth state invalid or expired. Try connecting again.'));
  }
  try {
    const tok = await exchangeCode(c.env, code, oauthRedirectUri(c.env, c.req.url));
    await saveToken(c.env, { ...tok, connectedAt: Date.now() }, saved.userId);
    await audit(c.env, { id: saved.userId, displayName: saved.userName }, 'drive.connected', {}, { email: tok.connectedEmail }, clientIp(c));
    return c.redirect('/admin/#/drive?connected=1');
  } catch (e) {
    return c.redirect('/admin/#/drive?error=' + encodeURIComponent((e as Error).message));
  }
});

admin.use('/*', requireSession('admin'));

admin.get('/me', async (c) => {
  const user = c.get('user');
  const settings = await getSettings(c.env);
  return c.json({
    user,
    permissions: permissionsFor(user.role),
    manageableRoles: manageableRoles(user.role),
    demo: isDemo(c.env),
    settings: { defaultLanguage: settings.defaultLanguage, exportMaxSets: settings.exportMaxSets, unknownPlateLabel: settings.unknownPlateLabel },
    today: bangkokDate(Date.now()),
  });
});

admin.post('/me/password', async (c) => {
  const { currentPassword, newPassword } = await readJson<{ currentPassword: string; newPassword: string }>(c);
  const user = c.get('user');
  const row = await c.env.DB.prepare(`SELECT password_hash FROM users WHERE id = ?`).bind(user.id).first<any>();
  if (!(await verifyPassword(String(currentPassword ?? ''), row.password_hash))) throw new ApiError(400, 'wrong_password', 'รหัสผ่านปัจจุบันไม่ถูกต้อง');
  const hash = await createPasswordHash(c.env, validateNewPassword(newPassword));
  await c.env.DB.prepare(`UPDATE users SET password_hash = ?, must_change_password = 0, updated_at = ? WHERE id = ?`).bind(hash, Date.now(), user.id).run();
  await audit(c.env, user, 'user.password_changed', { type: 'user', id: user.id }, undefined, clientIp(c));
  return c.json({ ok: true });
});

// ---------- Photo set history ----------
function parseHistoryQuery(q: Record<string, string>): HistoryQuery {
  const out: HistoryQuery = {};
  if (q.startDate || q.endDate) {
    try {
      const iv = buildInterval(q.startDate, q.endDate || q.startDate, q.startTime || '00:00:00', q.endTime || '23:59:59');
      out.fromMs = iv.fromMs;
      out.toMs = iv.toMs;
    } catch (e) {
      throw badRequest((e as Error).message);
    }
  }
  if (q.q) out.q = q.q;
  if (q.status) {
    if (!['finalized', 'open', 'abandoned', 'all'].includes(q.status)) throw badRequest('Invalid status filter.');
    out.status = q.status as HistoryQuery['status'];
  }
  if (q.visibility) {
    if (!['normal', 'hidden', 'removed', 'all'].includes(q.visibility)) throw badRequest('Invalid visibility filter.');
    out.visibility = q.visibility as HistoryQuery['visibility'];
  }
  if (q.pageSize) out.pageSize = Number(q.pageSize);
  if (q.cursor) out.cursor = q.cursor;
  if (q.direction) {
    if (!['first', 'next', 'prev', 'last'].includes(q.direction)) throw badRequest('Invalid direction.');
    out.direction = q.direction as HistoryQuery['direction'];
  }
  if (q.sort) {
    if (!['newest', 'oldest'].includes(q.sort)) throw badRequest('Invalid sort.');
    out.sort = q.sort as HistoryQuery['sort'];
  }
  return out;
}

admin.get('/sets', requirePermission('sets.view'), async (c) => {
  const settings = await getSettings(c.env);
  const res = await listSets(c.env, c.get('user'), parseHistoryQuery(c.req.query()), settings, getDrive(c.env, baseUrl(c.req.url)));
  return c.json(res);
});

admin.get('/sets/:id', requirePermission('sets.view'), async (c) => {
  const settings = await getSettings(c.env);
  return c.json(await setDetails(c.env, c.get('user'), c.req.param('id'), settings, getDrive(c.env, baseUrl(c.req.url))));
});

admin.post('/sets/:id/:action{hide|unhide|remove|restore}', async (c) => {
  await changeVisibility(c.env, c.get('user'), c.req.param('id'), c.req.param('action') as SetAction, clientIp(c));
  return c.json({ ok: true });
});

admin.put('/sets/:id/plate', requirePermission('sets.editPlate'), async (c) => {
  const { plate } = await readJson<{ plate: string }>(c);
  const id = c.req.param('id');
  await updatePlate(c.env, c.get('user'), id, String(plate ?? ''), clientIp(c));
  // Rename right away when possible; the queued job retries if Drive is unavailable.
  let renamed: { folderId: string; name: string } | null = null;
  try {
    renamed = await syncRoundFolderName(c.env, getDrive(c.env, baseUrl(c.req.url)), id);
  } catch (e) {
    console.warn('Immediate folder rename failed; job will retry', e);
  }
  return c.json({ ok: true, folder: renamed });
});

// ---------- Images (recent sets only) ----------
async function serveImage(c: any, imageId: string, kind: CacheKind, allowOld: boolean) {
  const env = c.env;
  const img = await env.DB.prepare(`SELECT * FROM images WHERE id = ?`).bind(imageId).first();
  if (!img || !img.uploaded_at) throw notFound('Image not available.');
  const round = await loadVisibleSet(env, c.get('user'), img.round_id);
  const settings = await getSettings(env);
  const recent = isRecent(round.op_date, settings, Date.now());
  if (!allowOld && !recent && settings.imageDisplayMode !== 'cache') {
    throw new ApiError(403, 'old_set', 'ชุดเก่าไม่โหลดรูปในหน้านี้ กรุณาเปิดชุดใน Drive');
  }
  const cached = (await getCache(env, imageId, kind)) ?? (kind === 'thumb' ? await getCache(env, imageId, 'display') : null);
  if (cached) {
    return new Response(cached.body, {
      headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=3600', 'X-Image-Source': 'cache' },
    });
  }
  if (!recent && !allowOld) throw new ApiError(404, 'not_cached', 'รูปนี้ไม่อยู่ในแคชแล้ว กรุณาเปิดชุดใน Drive');
  const res = await getDrive(env, baseUrl(c.req.url)).download(img.drive_display_file_id);
  return new Response(res.body, {
    headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=3600', 'X-Image-Source': 'drive' },
  });
}

admin.get('/images/:id/:kind{thumb|display}', requirePermission('sets.view'), async (c) => {
  return serveImage(c, c.req.param('id'), c.req.param('kind') as CacheKind, false);
});

// ---------- Excel export (explicit, audited) ----------
admin.post('/exports', requirePermission('sets.export'), async (c) => {
  const { setIds } = await readJson<{ setIds: string[] }>(c);
  const settings = await getSettings(c.env);
  if (!Array.isArray(setIds) || setIds.length === 0) throw badRequest('กรุณาเลือกอย่างน้อย 1 ชุด');
  if (setIds.length > settings.exportMaxSets) throw badRequest(`ส่งออกได้สูงสุด ${settings.exportMaxSets} ชุดต่อครั้ง`);
  const user = c.get('user');
  const drive = getDrive(c.env, baseUrl(c.req.url));
  const sets = [];
  for (const id of [...new Set(setIds)]) {
    const d = await setDetails(c.env, user, String(id), settings, drive);
    sets.push({
      ...d.set,
      steps: d.steps.map((s) => {
        const active = s.images.find((i) => i.active && i.uploadedAt);
        return {
          id: s.id,
          label: s.label,
          image: active
            ? { id: active.id, source: active.source, captureTimeDevice: active.captureTimeDevice, serverReceivedAt: active.serverReceivedAt, uploadedAt: active.uploadedAt }
            : null,
        };
      }),
    });
  }
  const exportId = randomToken(18);
  const now = Date.now();
  await c.env.DB.prepare(`INSERT INTO exports (id, user_id, round_ids, created_at, expires_at) VALUES (?, ?, ?, ?, ?)`)
    .bind(exportId, user.id, JSON.stringify(sets.map((s) => s.id)), now, now + 3600_000)
    .run();
  await audit(c.env, user, 'sets.export', { type: 'export', id: exportId }, { count: sets.length, publicIds: sets.map((s) => s.publicId) }, clientIp(c), now);
  return c.json({ exportId, sets });
});

admin.get('/exports/:exportId/images/:imageId', requirePermission('sets.export'), async (c) => {
  const grant = await c.env.DB.prepare(`SELECT * FROM exports WHERE id = ?`).bind(c.req.param('exportId')).first<any>();
  if (!grant || grant.user_id !== c.get('user').id || grant.expires_at < Date.now()) throw forbidden('Export expired.');
  const img = await c.env.DB.prepare(`SELECT round_id FROM images WHERE id = ?`).bind(c.req.param('imageId')).first<any>();
  if (!img || !JSON.parse(grant.round_ids).includes(img.round_id)) throw forbidden();
  return serveImage(c, c.req.param('imageId'), 'display', true);
});

// ---------- Settings ----------
admin.get('/settings', requirePermission('config.edit'), async (c) => c.json(await getSettings(c.env)));

admin.put('/settings', requirePermission('config.edit'), async (c) => {
  const patch = await readJson<Partial<AppSettings>>(c);
  const user = c.get('user');
  const current = await getSettings(c.env);
  // Storage/Drive-related settings are Super Admin only.
  const superOnly: (keyof AppSettings)[] = ['driveRootFolderId', 'cacheQuotaBytes', 'cacheThresholdPct', 'cacheTargetPct', 'dbQuotaBytes', 'dbThresholdPct', 'keepOriginals', 'ocrProvider', 'visionMonthlyFree', 'visionCapPct'];
  for (const k of superOnly) {
    if (k in patch && patch[k] !== current[k] && !can(user.role, 'drive.manage')) throw forbidden(`Only a Super Admin can change ${k}.`);
  }
  const next = validateSettingsPatch(patch, current);
  if (next.driveRootFolderId !== current.driveRootFolderId && !isDemo(c.env)) {
    const f = await getDrive(c.env).getFile(next.driveRootFolderId);
    if (!f) throw badRequest('That Drive folder ID is not accessible with the connected Google account.');
  }
  const langs = await getLanguages(c.env);
  if (!langs.some((l) => l.code === next.defaultLanguage)) throw badRequest('Default language does not exist.');
  if (!langs.some((l) => l.code === next.fallbackLanguage)) throw badRequest('Fallback language does not exist.');
  await saveSettings(c.env, next, user.id, Date.now());
  const changed = Object.keys(patch).filter((k) => (patch as any)[k] !== (current as any)[k]);
  await audit(c.env, user, 'settings.updated', { type: 'settings' }, { changed }, clientIp(c));
  return c.json(next);
});

// ---------- Workflow (versioned) ----------
admin.get('/workflow', requirePermission('config.edit'), async (c) => {
  return c.json({ current: await getCurrentWorkflow(c.env), versions: await listWorkflowVersions(c.env) });
});

/**
 * Publishing creates a NEW immutable version. Rounds already in progress keep the
 * version they started with; only rounds started afterwards use the new one.
 */
admin.post('/workflow', requirePermission('config.edit'), async (c) => {
  const { steps, note } = await readJson<{ steps: unknown; note?: string }>(c);
  const langs = (await getLanguages(c.env)).map((l) => l.code);
  const valid = validateSteps(steps, langs);
  const id = await publishWorkflow(c.env, valid, String(note ?? '').slice(0, 200), c.get('user').id, Date.now());
  await audit(c.env, c.get('user'), 'workflow.published', { type: 'workflow', id: String(id) }, { steps: valid.map((s) => s.id) }, clientIp(c));
  return c.json({ id });
});

// ---------- Languages & translations ----------
admin.get('/i18n', requirePermission('config.edit'), async (c) => {
  return c.json({
    keys: TRANSLATION_KEYS,
    builtin: BUILTIN_TRANSLATIONS,
    languages: await getLanguages(c.env),
    overrides: await getTranslationOverrides(c.env),
  });
});

admin.put('/languages/:code', requirePermission('config.edit'), async (c) => {
  const code = c.req.param('code');
  if (!/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/.test(code)) throw badRequest('Language code must look like "th", "en" or "zh-Hans".');
  const body = await readJson<{ name: string; enabled?: boolean; sort?: number }>(c);
  const name = str(body.name, 'name', { max: 40 });
  await c.env.DB.prepare(
    `INSERT INTO languages (code, name, enabled, sort) VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT(code) DO UPDATE SET name = ?2, enabled = ?3, sort = ?4`,
  )
    .bind(code, name, body.enabled === false ? 0 : 1, Number.isFinite(body.sort) ? body.sort : 50)
    .run();
  await audit(c.env, c.get('user'), 'language.saved', { type: 'language', id: code }, { name }, clientIp(c));
  return c.json({ ok: true });
});

admin.delete('/languages/:code', requirePermission('config.edit'), async (c) => {
  const code = c.req.param('code');
  const s = await getSettings(c.env);
  if (code === s.defaultLanguage || code === s.fallbackLanguage) throw badRequest('Change the default/fallback language first.');
  await c.env.DB.batch([
    c.env.DB.prepare(`DELETE FROM translations WHERE lang = ?`).bind(code),
    c.env.DB.prepare(`DELETE FROM languages WHERE code = ?`).bind(code),
  ]);
  await audit(c.env, c.get('user'), 'language.removed', { type: 'language', id: code }, undefined, clientIp(c));
  return c.json({ ok: true });
});

/** Upsert translation overrides: { lang: { key: value } }. An empty string removes the override. */
admin.put('/translations', requirePermission('config.edit'), async (c) => {
  const body = await readJson<Record<string, Record<string, string>>>(c);
  const langs = new Set((await getLanguages(c.env)).map((l) => l.code));
  const stmts = [];
  for (const [lang, entries] of Object.entries(body ?? {})) {
    if (!langs.has(lang)) throw badRequest(`Unknown language ${lang}.`);
    for (const [key, value] of Object.entries(entries ?? {})) {
      if (!(TRANSLATION_KEYS as readonly string[]).includes(key)) throw badRequest(`Unknown key ${key}.`);
      if (typeof value !== 'string' || value.length > 300) throw badRequest(`Invalid text for ${key}.`);
      stmts.push(
        value.trim() === ''
          ? c.env.DB.prepare(`DELETE FROM translations WHERE lang = ? AND key = ?`).bind(lang, key)
          : c.env.DB.prepare(
              `INSERT INTO translations (lang, key, value) VALUES (?1, ?2, ?3) ON CONFLICT(lang, key) DO UPDATE SET value = ?3`,
            ).bind(lang, key, value.trim()),
      );
    }
  }
  if (stmts.length) await c.env.DB.batch(stmts);
  await audit(c.env, c.get('user'), 'translations.updated', { type: 'translations' }, { count: stmts.length }, clientIp(c));
  return c.json({ ok: true, count: stmts.length });
});

// ---------- Members & permissions ----------
function assertCanManage(actor: AuthUser, targetRole: Role, newRole?: Role) {
  const roles = manageableRoles(actor.role);
  if (!roles.includes(targetRole) || (newRole && !roles.includes(newRole))) throw forbidden('คุณจัดการผู้ใช้บทบาทนี้ไม่ได้');
}

function tempPassword() {
  return randomToken(9).replace(/[-_]/g, 'x');
}

admin.get('/users', requirePermission('users.manage'), async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT u.id, u.username, u.display_name, u.role, u.disabled, u.must_change_password, u.language, u.created_at,
       (u.pin_hash IS NOT NULL) AS has_pin,
       (SELECT MAX(last_seen_at) FROM sessions s WHERE s.user_id = u.id) AS last_seen_at,
       (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id AND s.revoked_at IS NULL AND s.expires_at > ?) AS active_sessions
     FROM users u ORDER BY u.disabled, u.role, u.display_name LIMIT 1000`,
  )
    .bind(Date.now())
    .all();
  return c.json({ users: results });
});

admin.post('/users', requirePermission('users.manage'), async (c) => {
  const body = await readJson<{ username: string; displayName: string; role: Role; password?: string }>(c);
  const actor = c.get('user');
  const username = str(body.username, 'username', { min: 3, max: 40 });
  if (!/^[a-zA-Z0-9._-]+$/.test(username)) throw badRequest('Username may contain letters, digits, dot, dash and underscore.');
  if (!ROLES.includes(body.role)) throw badRequest('Invalid role.');
  assertCanManage(actor, body.role);
  const generated = body.password ? null : tempPassword();
  const password = body.password ? validateNewPassword(body.password) : generated!;
  const now = Date.now();
  const id = uuid();
  try {
    await c.env.DB.prepare(
      `INSERT INTO users (id, username, display_name, role, password_hash, disabled, must_change_password, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 0, 1, ?, ?)`,
    )
      .bind(id, username, str(body.displayName, 'displayName', { max: 80 }), body.role, await createPasswordHash(c.env, password), now, now)
      .run();
  } catch (e) {
    if (String(e).includes('UNIQUE')) throw new ApiError(409, 'username_taken', 'ชื่อผู้ใช้นี้ถูกใช้แล้ว');
    throw e;
  }
  await audit(c.env, actor, 'user.created', { type: 'user', id }, { username, role: body.role }, clientIp(c));
  return c.json({ id, temporaryPassword: generated });
});

admin.patch('/users/:id', requirePermission('users.manage'), async (c) => {
  const actor = c.get('user');
  const id = c.req.param('id');
  const body = await readJson<{ displayName?: string; role?: Role; disabled?: boolean }>(c);
  const target = await c.env.DB.prepare(`SELECT * FROM users WHERE id = ?`).bind(id).first<any>();
  if (!target) throw notFound('User not found.');
  if (body.role && !ROLES.includes(body.role)) throw badRequest('Invalid role.');
  assertCanManage(actor, target.role, body.role);
  if (id === actor.id && (body.disabled || (body.role && body.role !== actor.role))) {
    throw badRequest('ปิดใช้งานตัวเองหรือเปลี่ยนบทบาทตัวเองไม่ได้');
  }
  if (target.role === 'super_admin' && (body.disabled || (body.role && body.role !== 'super_admin'))) {
    const n = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM users WHERE role = 'super_admin' AND disabled = 0`).first<{ n: number }>();
    if ((n?.n ?? 0) <= 1) throw badRequest('ต้องมีผู้ดูแลสูงสุดที่ใช้งานอยู่อย่างน้อย 1 คน');
  }
  const now = Date.now();
  await c.env.DB.prepare(
    `UPDATE users SET display_name = COALESCE(?, display_name), role = COALESCE(?, role), disabled = COALESCE(?, disabled), updated_at = ? WHERE id = ?`,
  )
    .bind(body.displayName ? str(body.displayName, 'displayName', { max: 80 }) : null, body.role ?? null, body.disabled == null ? null : body.disabled ? 1 : 0, now, id)
    .run();
  // Disabling or changing the role ends existing sessions immediately.
  if (body.disabled || (body.role && body.role !== target.role)) await revokeUserSessions(c.env, id, now);
  await audit(c.env, actor, 'user.updated', { type: 'user', id }, body, clientIp(c), now);
  return c.json({ ok: true });
});

admin.post('/users/:id/reset-password', requirePermission('users.manage'), async (c) => {
  const actor = c.get('user');
  const id = c.req.param('id');
  const target = await c.env.DB.prepare(`SELECT * FROM users WHERE id = ?`).bind(id).first<any>();
  if (!target) throw notFound('User not found.');
  assertCanManage(actor, target.role);
  const pw = tempPassword();
  const now = Date.now();
  await c.env.DB.prepare(`UPDATE users SET password_hash = ?, must_change_password = 1, updated_at = ? WHERE id = ?`)
    .bind(await createPasswordHash(c.env, pw), now, id)
    .run();
  await revokeUserSessions(c.env, id, now);
  await audit(c.env, actor, 'user.password_reset', { type: 'user', id }, undefined, clientIp(c), now);
  return c.json({ temporaryPassword: pw });
});

admin.post('/users/:id/revoke-sessions', requirePermission('users.manage'), async (c) => {
  const actor = c.get('user');
  const id = c.req.param('id');
  const target = await c.env.DB.prepare(`SELECT role FROM users WHERE id = ?`).bind(id).first<any>();
  if (!target) throw notFound('User not found.');
  assertCanManage(actor, target.role);
  await revokeUserSessions(c.env, id);
  await audit(c.env, actor, 'user.sessions_revoked', { type: 'user', id }, undefined, clientIp(c));
  return c.json({ ok: true });
});

admin.put('/users/:id/pin', requirePermission('users.manage'), async (c) => {
  const actor = c.get('user');
  const id = c.req.param('id');
  const { pin } = await readJson<{ pin: string | null }>(c);
  const target = await c.env.DB.prepare(`SELECT role FROM users WHERE id = ?`).bind(id).first<any>();
  if (!target) throw notFound('User not found.');
  assertCanManage(actor, target.role);
  if (pin != null && !/^\d{4,8}$/.test(pin)) throw badRequest('PIN must be 4–8 digits.');
  // PINs use fewer PBKDF2 iterations; they are rate-limited server-side (see /api/field/unlock).
  await c.env.DB.prepare(`UPDATE users SET pin_hash = ?, updated_at = ? WHERE id = ?`)
    .bind(pin == null ? null : await hashPassword(pin, 20_000), Date.now(), id)
    .run();
  await audit(c.env, actor, pin == null ? 'user.pin_cleared' : 'user.pin_set', { type: 'user', id }, undefined, clientIp(c));
  return c.json({ ok: true });
});

// ---------- Google Drive ----------
admin.get('/drive/status', requirePermission('storage.view'), async (c) => {
  const settings = await getSettings(c.env);
  if (isDemo(c.env)) {
    return c.json({ mode: 'demo', connected: true, email: null, rootFolderId: effectiveRoot(c.env, settings.driveRootFolderId), rootOk: true, rootName: 'Vehicle Photos (demo)' });
  }
  const configured = !!(c.env.GOOGLE_CLIENT_ID && c.env.GOOGLE_CLIENT_SECRET && c.env.TOKEN_ENC_KEY);
  let token = null;
  try {
    token = configured ? await loadToken(c.env) : null;
  } catch {
    token = null;
  }
  let rootOk = false;
  let rootName: string | null = null;
  let error: string | null = null;
  if (token && settings.driveRootFolderId) {
    try {
      const f = await getDrive(c.env).getFile(settings.driveRootFolderId);
      rootOk = !!f && !f.trashed;
      rootName = f?.name ?? null;
    } catch (e) {
      error = (e as Error).message;
    }
  }
  return c.json({
    mode: 'google',
    oauthConfigured: configured,
    connected: !!token,
    email: token?.connectedEmail ?? null,
    connectedAt: token?.connectedAt ?? null,
    rootFolderId: settings.driveRootFolderId,
    rootOk,
    rootName,
    error,
    redirectUri: oauthRedirectUri(c.env, c.req.url),
  });
});

admin.post('/drive/oauth/start', requirePermission('drive.manage'), async (c) => {
  if (isDemo(c.env)) throw badRequest('Drive is emulated in demo mode.');
  if (!c.env.GOOGLE_CLIENT_ID || !c.env.GOOGLE_CLIENT_SECRET || !c.env.TOKEN_ENC_KEY) {
    throw badRequest('GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and TOKEN_ENC_KEY must be configured as Worker secrets first.');
  }
  const state = randomToken();
  const user = c.get('user');
  await c.env.DB.prepare(
    `INSERT INTO settings (key, value, updated_at, updated_by) VALUES ('oauth_state', ?1, ?2, ?3)
     ON CONFLICT(key) DO UPDATE SET value = ?1, updated_at = ?2, updated_by = ?3`,
  )
    .bind(JSON.stringify({ state, userId: user.id, userName: user.displayName, expiresAt: Date.now() + 10 * 60_000 }), Date.now(), user.id)
    .run();
  return c.json({ url: buildAuthUrl(c.env, oauthRedirectUri(c.env, c.req.url), state) });
});

admin.post('/drive/disconnect', requirePermission('drive.manage'), async (c) => {
  await clearToken(c.env);
  await audit(c.env, c.get('user'), 'drive.disconnected', {}, undefined, clientIp(c));
  return c.json({ ok: true });
});

/** Give an administrator's Google account private access to the root folder (no public links). */
admin.post('/drive/share', requirePermission('drive.manage'), async (c) => {
  const { email, role } = await readJson<{ email: string; role?: 'reader' | 'writer' }>(c);
  const e = str(email, 'email', { max: 200 });
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) throw badRequest('Enter a valid Google account email.');
  const settings = await getSettings(c.env);
  await getDrive(c.env, baseUrl(c.req.url)).shareWithUser(effectiveRoot(c.env, settings.driveRootFolderId), e, role === 'writer' ? 'writer' : 'reader');
  await audit(c.env, c.get('user'), 'drive.shared', { type: 'drive_folder', id: settings.driveRootFolderId }, { email: e, role: role ?? 'reader' }, clientIp(c));
  return c.json({ ok: true });
});

// ---------- Storage & jobs ----------
admin.get('/storage', requirePermission('storage.view'), async (c) => {
  const settings = await getSettings(c.env);
  const cache = await cacheUsage(c.env);
  const sizeRes = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM rounds`).run();
  const rounds = (sizeRes.results[0] as any)?.n ?? 0;
  const dbBytes = (sizeRes.meta as any)?.size_after ?? null;
  const { results: jobs } = await c.env.DB.prepare(`SELECT status, COUNT(*) AS n FROM jobs GROUP BY status`).all();
  const { results: failedJobs } = await c.env.DB.prepare(
    `SELECT id, kind, ref_id, attempts, last_error, updated_at FROM jobs WHERE status = 'failed' OR (status = 'pending' AND attempts > 0) ORDER BY updated_at DESC LIMIT 20`,
  ).all();
  return c.json({
    cache: { ...cache, enabled: !!c.env.CACHE, quotaBytes: settings.cacheQuotaBytes, thresholdPct: settings.cacheThresholdPct, targetPct: settings.cacheTargetPct },
    db: { bytes: dbBytes, quotaBytes: settings.dbQuotaBytes, thresholdPct: settings.dbThresholdPct, rounds },
    jobs,
    failedJobs,
  });
});

admin.post('/storage/evict', requirePermission('storage.manage'), async (c) => {
  const res = await evictCache(c.env, await getSettings(c.env));
  await audit(c.env, c.get('user'), 'storage.evict', {}, res, clientIp(c));
  return c.json(res);
});

admin.post('/jobs/run', requirePermission('storage.manage'), async (c) => {
  return c.json(await processJobs(c.env, 10, baseUrl(c.req.url)));
});

admin.post('/jobs/:id/retry', requirePermission('storage.manage'), async (c) => {
  await c.env.DB.prepare(`UPDATE jobs SET status = 'pending', next_run_at = ?, attempts = 0 WHERE id = ?`).bind(Date.now(), int(c.req.param('id'), 'id')).run();
  return c.json({ ok: true });
});

// ---------- Audit log (keyset paginated) ----------
admin.get('/audit', requirePermission('audit.view'), async (c) => {
  const before = c.req.query('before');
  const pageSize = [20, 50, 100].includes(Number(c.req.query('pageSize'))) ? Number(c.req.query('pageSize')) : 50;
  const action = c.req.query('action');
  const where: string[] = [];
  const binds: unknown[] = [];
  if (before) {
    where.push('id < ?');
    binds.push(int(before, 'before'));
  }
  if (action) {
    where.push('action LIKE ?');
    binds.push(action.replace(/[%_]/g, '') + '%');
  }
  const { results } = await c.env.DB.prepare(
    `SELECT * FROM audit_log ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`,
  )
    .bind(...binds, pageSize + 1)
    .all<any>();
  const hasMore = results.length > pageSize;
  const rows = results.slice(0, pageSize);
  return c.json({ rows, nextBefore: hasMore ? rows[rows.length - 1].id : null });
});

// ---------- Plate recognition (OCR) ----------
admin.get('/ocr/status', requirePermission('sets.view'), async (c) => {
  const settings = await getSettings(c.env);
  const now = Date.now();
  const { results: agents } = await c.env.DB.prepare(
    `SELECT id, name, disabled, created_at, last_seen_at, last_ip, version, jobs_done FROM ocr_agents ORDER BY created_at`,
  ).all<any>();
  const { results: queue } = await c.env.DB.prepare(`SELECT status, COUNT(*) AS n FROM jobs WHERE kind = 'ocr' AND status != 'done' GROUP BY status`).all<any>();
  const onlineMs = onlineWindowMs(settings);
  return c.json({
    mode: settings.ocrProvider,
    visionKeyConfigured: !!c.env.GOOGLE_VISION_API_KEY,
    vision: { used: await visionUsage(c.env, now), cap: visionCap(settings), free: settings.visionMonthlyFree, capPct: settings.visionCapPct, period: visionPeriod(now).slice(7) },
    agents: agents.map((a) => ({ ...a, online: !a.disabled && !!a.last_seen_at && now - a.last_seen_at < onlineMs })),
    queue: Object.fromEntries(queue.map((q) => [q.status, q.n])),
    pollSeconds: settings.agentPollSeconds,
  });
});

admin.post('/ocr/agents', requirePermission('drive.manage'), async (c) => {
  const { name } = await readJson<{ name: string }>(c);
  const token = `vpa_${randomToken(24)}`;
  const id = uuid();
  await c.env.DB.prepare(`INSERT INTO ocr_agents (id, name, token_hash, created_at, created_by) VALUES (?, ?, ?, ?, ?)`)
    .bind(id, str(name, 'name', { max: 40 }), await sha256Hex(token), Date.now(), c.get('user').id)
    .run();
  await audit(c.env, c.get('user'), 'ocr.agent_created', { type: 'ocr_agent', id }, { name }, clientIp(c));
  // The token is shown once; only its hash is stored.
  return c.json({ id, token });
});

admin.patch('/ocr/agents/:id', requirePermission('drive.manage'), async (c) => {
  const { disabled } = await readJson<{ disabled: boolean }>(c);
  await c.env.DB.prepare(`UPDATE ocr_agents SET disabled = ? WHERE id = ?`).bind(disabled ? 1 : 0, c.req.param('id')).run();
  if (disabled) {
    // Give its leased jobs back to the queue immediately.
    await c.env.DB.prepare(`UPDATE jobs SET status = 'local', agent_id = NULL WHERE agent_id = ? AND status = 'local_running'`).bind(c.req.param('id')).run();
  }
  await audit(c.env, c.get('user'), disabled ? 'ocr.agent_disabled' : 'ocr.agent_enabled', { type: 'ocr_agent', id: c.req.param('id') }, undefined, clientIp(c));
  return c.json({ ok: true });
});

admin.delete('/ocr/agents/:id', requirePermission('drive.manage'), async (c) => {
  const id = c.req.param('id');
  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE jobs SET status = 'local', agent_id = NULL WHERE agent_id = ? AND status = 'local_running'`).bind(id),
    c.env.DB.prepare(`DELETE FROM ocr_agents WHERE id = ?`).bind(id),
  ]);
  await audit(c.env, c.get('user'), 'ocr.agent_deleted', { type: 'ocr_agent', id }, undefined, clientIp(c));
  return c.json({ ok: true });
});

/** "Send waiting plates to Local OCR": parked (Vision cap reached), failed and not-yet-run plates. */
admin.post('/ocr/send-to-local', requirePermission('sets.editPlate'), async (c) => {
  const now = Date.now();
  const { results } = await c.env.DB.prepare(
    `UPDATE jobs SET status = 'local', agent_id = NULL, attempts = 0, last_error = NULL, next_run_at = ?1, updated_at = ?1
     WHERE kind = 'ocr' AND status IN ('wait_quota', 'failed', 'pending') RETURNING ref_id`,
  )
    .bind(now)
    .all<{ ref_id: string }>();
  for (let i = 0; i < results.length; i += 50) {
    const ids = results.slice(i, i + 50).map((r) => r.ref_id);
    await c.env.DB.prepare(`UPDATE rounds SET ocr_status = 'waiting_local' WHERE id IN (${ids.map(() => '?').join(',')})`).bind(...ids).run();
  }
  await audit(c.env, c.get('user'), 'ocr.sent_to_local', {}, { count: results.length }, clientIp(c), now);
  return c.json({ moved: results.length });
});

/** Read one set's plate again (target 'auto' follows the OCR mode; 'local' forces Local OCR). */
admin.post('/sets/:id/ocr', requirePermission('sets.editPlate'), async (c) => {
  const { target } = await readJson<{ target?: 'auto' | 'local' }>(c).catch(() => ({ target: 'auto' as const }));
  const id = c.req.param('id');
  const round = await loadVisibleSet(c.env, c.get('user'), id);
  const settings = await getSettings(c.env);
  if (settings.ocrProvider === 'none' && target !== 'local') throw badRequest('เปิดใช้การอ่านป้ายทะเบียนก่อน (หน้า อ่านป้ายทะเบียน)');
  const wf = await getWorkflow(c.env, round.workflow_version_id);
  const ocrSteps = (wf?.steps ?? []).filter((s) => s.ocr).map((s) => s.id);
  if (!ocrSteps.length) throw badRequest('ขั้นตอนของชุดนี้ไม่มีขั้นตอนที่ตั้งให้อ่านป้าย');
  const img = await c.env.DB.prepare(
    `SELECT id FROM images WHERE round_id = ? AND active = 1 AND uploaded_at IS NOT NULL AND step_id IN (${ocrSteps.map(() => '?').join(',')}) LIMIT 1`,
  )
    .bind(id, ...ocrSteps)
    .first<{ id: string }>();
  if (!img) throw badRequest('ยังไม่มีรูปป้ายทะเบียนที่อัปโหลดเสร็จ');
  const now = Date.now();
  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE jobs SET status = 'done', updated_at = ? WHERE kind = 'ocr' AND ref_id = ? AND status != 'done'`).bind(now, id),
    c.env.DB.prepare(
      `INSERT INTO jobs (kind, ref_id, payload, status, attempts, next_run_at, created_at, updated_at) VALUES ('ocr', ?, ?, ?, 0, ?, ?, ?)`,
    ).bind(id, JSON.stringify({ imageId: img.id, force: true }), target === 'local' ? 'local' : 'pending', now, now, now),
    c.env.DB.prepare(`UPDATE rounds SET ocr_status = ? WHERE id = ?`).bind(target === 'local' ? 'waiting_local' : 'pending', id),
  ]);
  if (target !== 'local') {
    try {
      c.executionCtx.waitUntil(processJobs(c.env, 3, new URL(c.req.url).origin).catch(() => undefined));
    } catch {
      /* tests */
    }
  }
  await audit(c.env, c.get('user'), 'ocr.rerun', { type: 'set', id }, { target: target ?? 'auto' }, clientIp(c), now);
  return c.json({ ok: true });
});

// ---------- Demo mode helpers (only when DRIVE_MODE=demo) ----------
admin.post('/demo/seed-history', requirePermission('demo.seed'), async (c) => {
  if (!isDemo(c.env)) throw forbidden('Only available in demo mode.');
  const { count = 500, days = 120 } = await readJson<{ count?: number; days?: number }>(c);
  const n = Math.min(5000, Math.max(1, Number(count)));
  const wf = await getCurrentWorkflow(c.env);
  const settings = await getSettings(c.env);
  const operators = (await c.env.DB.prepare(`SELECT id FROM users WHERE role = 'operator'`).all<{ id: string }>()).results;
  if (!operators.length) throw badRequest('Create an operator first.');
  const now = Date.now();
  const letters = 'กขคงจฉชซญฎฐฑณดตถทธนบปผพฟภมยรลวศษสหฬอฮ';
  let inserted = 0;
  for (let start = 0; start < n; start += 50) {
    const stmts = [];
    const chunk = Math.min(50, n - start);
    const seqRow = await c.env.DB.prepare(`UPDATE counters SET value = value + ? WHERE name = 'round' RETURNING value`).bind(chunk).first<{ value: number }>();
    for (let i = 0; i < chunk; i++) {
      const seq = seqRow!.value - chunk + 1 + i;
      const startedAt = now - Math.floor(Math.random() * days * 86400_000);
      const hasPlate = Math.random() > 0.15;
      const plate = hasPlate
        ? `${letters[Math.floor(Math.random() * letters.length)]}${letters[Math.floor(Math.random() * letters.length)]} ${1000 + Math.floor(Math.random() * 9000)}`
        : null;
      stmts.push(
        c.env.DB.prepare(
          `INSERT INTO rounds (id, seq, public_id, client_round_id, operator_id, workflow_version_id, started_at, started_at_source, created_at,
             op_date, status, finalized_at, required_count, active_count, uploaded_count, plate_text, plate_norm, plate_digits, plate_source,
             unknown_label, folder_status, drive_folder_id, drive_folder_name, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'server', ?, ?, 'finalized', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?, ?)`,
        ).bind(
          uuid(),
          seq,
          publicIdFromSeq(seq),
          `demo-${uuid()}`,
          operators[i % operators.length].id,
          wf.id,
          startedAt,
          startedAt,
          bangkokDate(startedAt),
          startedAt + 60_000,
          wf.steps.filter((s) => s.required).length,
          wf.steps.length,
          wf.steps.length,
          plate,
          plate ? plate.replace(/\s/g, '') : null,
          plate ? plate.split(' ')[1] : null,
          plate ? 'ocr' : 'none',
          settings.unknownPlateLabel,
          `demo-seeded-${seq}`,
          `demo seeded ${seq}`,
          startedAt,
        ),
      );
    }
    await c.env.DB.batch(stmts);
    inserted += chunk;
  }
  await audit(c.env, c.get('user'), 'demo.seed_history', {}, { inserted }, clientIp(c));
  return c.json({ inserted });
});

/** Simple listing page that stands in for drive.google.com in demo mode. */
admin.get('/demo-drive/folders/:id', requirePermission('sets.view'), async (c) => {
  if (!isDemo(c.env)) throw notFound();
  const id = c.req.param('id');
  const folder = await c.env.DB.prepare(`SELECT * FROM demo_drive_files WHERE id = ?`).bind(id).first<any>();
  if (!folder) return c.html('<p>Demo folder not found (seeded demo rows have no files).</p>', 404);
  const { results } = await c.env.DB.prepare(`SELECT * FROM demo_drive_files WHERE parent_id = ? ORDER BY name`).bind(id).all<any>();
  const esc = (s: string) => s.replace(/[&<>"]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[m]!);
  const items = results
    .map((f) =>
      f.mime_type === 'folder'
        ? `<li>📁 <a href="./${encodeURIComponent(f.id)}">${esc(f.name)}</a></li>`
        : `<li>🖼️ <a href="../files/${encodeURIComponent(f.id)}" target="_blank">${esc(f.name)}</a> <small>${Math.round((f.size ?? 0) / 1024)} KB</small></li>`,
    )
    .join('');
  return c.html(
    `<!doctype html><meta charset="utf-8"><title>Demo Drive</title><body style="font-family:system-ui;padding:24px;background:#f5f6f4">
     <p style="background:#fff3cd;padding:8px 12px;border-radius:8px">DEMO MODE — emulated Google Drive folder</p>
     <h2>📁 ${esc(folder.name)}</h2><ul>${items || '<li>(empty)</li>'}</ul></body>`,
  );
});

admin.get('/demo-drive/files/:id', requirePermission('sets.view'), async (c) => {
  if (!isDemo(c.env)) throw notFound();
  const obj = await c.env.CACHE!.get(`demo-drive/${c.req.param('id')}`);
  if (!obj) throw notFound();
  return new Response(obj.body, { headers: { 'Content-Type': 'image/jpeg' } });
});
