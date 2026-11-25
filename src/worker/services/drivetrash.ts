import type { AuthUser, Env } from '../env';
import type { DriveClient } from '../drive/types';
import { badRequest, conflict, notFound } from '../util';
import { audit } from './audit';
import { cacheKey } from './cache';
import { enqueueStmt } from './jobs';
import { bangkokDate } from '../../shared/time';

/**
 * "Free up Drive space". A Super Admin can move a set's Drive folder to the Drive trash.
 * - Only the Drive TRASH is used (recoverable for 30 days, restorable from the dashboard).
 *   There is no permanent-delete code path; emptying the trash is done by a person in Drive.
 * - Only finished sets (finalized / abandoned) can be trashed; open sets never.
 * - The set's record (plate, times, operator, audit) stays in the history; only its photos go.
 * - Hide / remove never call this.
 */
export const CLEANUP_MIN_DAYS = 7;
export const CLEANUP_MAX_SETS = 500;
export const CLEANUP_CONFIRM = 'ย้ายไปถังขยะ';

async function dropCache(env: Env, roundId: string) {
  const { results } = await env.DB.prepare(`SELECT id FROM images WHERE round_id = ?`).bind(roundId).all<{ id: string }>();
  if (!results.length) return;
  const keys = results.flatMap((i) => [cacheKey(i.id, 'thumb'), cacheKey(i.id, 'display')]);
  if (env.CACHE) await env.CACHE.delete(keys);
  await env.DB.prepare(`DELETE FROM cache_objects WHERE key IN (${keys.map(() => '?').join(',')})`).bind(...keys).run();
}

async function loadRound(env: Env, id: string) {
  const r = await env.DB.prepare(`SELECT * FROM rounds WHERE id = ?`).bind(id).first<any>();
  if (!r) throw notFound('Photo set not found.');
  return r;
}

export async function trashRound(env: Env, drive: DriveClient, user: AuthUser, id: string, ip: string, now = Date.now()) {
  const r = await loadRound(env, id);
  if (r.status === 'open') throw conflict('set_open', 'ชุดที่ยังถ่ายไม่เสร็จ ย้ายไปถังขยะไม่ได้');
  if (r.drive_trashed_at) return { ok: true, already: true };
  if (!r.drive_folder_id) throw badRequest('ชุดนี้ไม่มีโฟลเดอร์ใน Drive');
  await drive.setTrashed(r.drive_folder_id, true);
  await env.DB.prepare(`UPDATE rounds SET drive_trashed_at = ?, drive_trashed_by = ?, updated_at = ? WHERE id = ?`).bind(now, user.id, now, id).run();
  await dropCache(env, id);
  await audit(env, user, 'set.drive_trashed', { type: 'set', id }, { publicId: r.public_id, driveFolderId: r.drive_folder_id }, ip, now);
  return { ok: true };
}

export async function restoreRound(env: Env, drive: DriveClient, user: AuthUser, id: string, ip: string, now = Date.now()) {
  const r = await loadRound(env, id);
  if (!r.drive_trashed_at) return { ok: true, already: true };
  try {
    await drive.setTrashed(r.drive_folder_id, false);
  } catch (e) {
    throw conflict('restore_failed', `กู้คืนไม่ได้ (อาจถูกลบถาวรจากถังขยะแล้ว หรือเกิน 30 วัน): ${(e as Error).message.slice(0, 120)}`);
  }
  await env.DB.prepare(`UPDATE rounds SET drive_trashed_at = NULL, drive_trashed_by = NULL, updated_at = ? WHERE id = ?`).bind(now, id).run();
  await audit(env, user, 'set.drive_restored', { type: 'set', id }, { publicId: r.public_id, driveFolderId: r.drive_folder_id }, ip, now);
  return { ok: true };
}

function cutoffDate(days: number, now: number) {
  if (!Number.isInteger(days) || days < CLEANUP_MIN_DAYS || days > 3650) throw badRequest(`จำนวนวันต้องอยู่ระหว่าง ${CLEANUP_MIN_DAYS}–3650`);
  return bangkokDate(now - days * 86400_000);
}

const CANDIDATES = `FROM rounds r WHERE r.status IN ('finalized','abandoned') AND r.drive_trashed_at IS NULL
  AND r.drive_folder_id IS NOT NULL AND r.op_date < ?`;

export async function cleanupPreview(env: Env, days: number, now = Date.now()) {
  const before = cutoffDate(days, now);
  const r = await env.DB.prepare(
    `SELECT COUNT(*) AS sets, MIN(op_date) AS oldest, MAX(op_date) AS newest,
            (SELECT COALESCE(SUM(COALESCE(i.original_bytes,0) + COALESCE(i.display_bytes,0)), 0) FROM images i
              WHERE i.round_id IN (SELECT r.id ${CANDIDATES})) AS bytes
     ${CANDIDATES}`,
  )
    .bind(before, before)
    .first<{ sets: number; oldest: string | null; newest: string | null; bytes: number }>();
  return { before, sets: r?.sets ?? 0, oldest: r?.oldest ?? null, newest: r?.newest ?? null, bytes: r?.bytes ?? 0, maxPerRun: CLEANUP_MAX_SETS };
}

/** Marks up to CLEANUP_MAX_SETS sets and queues one Drive call per set (run by the job worker). */
export async function cleanupOlderThan(env: Env, user: AuthUser, days: number, confirm: string, ip: string, now = Date.now()) {
  if (confirm !== CLEANUP_CONFIRM) throw badRequest(`พิมพ์คำว่า "${CLEANUP_CONFIRM}" เพื่อยืนยัน`);
  const before = cutoffDate(days, now);
  const { results } = await env.DB.prepare(`SELECT r.id, r.public_id ${CANDIDATES} ORDER BY r.op_date LIMIT ?`)
    .bind(before, CLEANUP_MAX_SETS)
    .all<{ id: string; public_id: string }>();
  if (!results.length) return { queued: 0 };
  const stmts = results.flatMap((s) => [
    env.DB.prepare(`UPDATE rounds SET drive_trashed_at = ?, drive_trashed_by = ?, updated_at = ? WHERE id = ? AND drive_trashed_at IS NULL`).bind(now, user.id, now, s.id),
    enqueueStmt(env, 'drive_trash', s.id, null, now),
  ]);
  for (let i = 0; i < stmts.length; i += 100) await env.DB.batch(stmts.slice(i, i + 100));
  await audit(env, user, 'drive.cleanup', {}, { days, before, count: results.length, first: results[0].public_id, last: results.at(-1)!.public_id }, ip, now);
  return { queued: results.length };
}

/** Job: perform the Drive call for a set marked by cleanupOlderThan (skipped if it was restored meanwhile). */
export async function runTrashJob(env: Env, drive: DriveClient, roundId: string) {
  const r = await env.DB.prepare(`SELECT drive_folder_id, drive_trashed_at FROM rounds WHERE id = ?`).bind(roundId).first<any>();
  if (!r?.drive_trashed_at || !r.drive_folder_id) return;
  await drive.setTrashed(r.drive_folder_id, true);
  await dropCache(env, roundId);
}

export async function driveUsage(env: Env, drive: DriveClient) {
  const quota = await drive.storageQuota();
  const app = await env.DB.prepare(
    `SELECT COALESCE(SUM(COALESCE(i.original_bytes,0) + COALESCE(i.display_bytes,0)), 0) AS bytes
     FROM images i JOIN rounds r ON r.id = i.round_id WHERE i.uploaded_at IS NOT NULL AND r.drive_trashed_at IS NULL`,
  ).first<{ bytes: number }>();
  const pending = await env.DB.prepare(`SELECT COUNT(*) AS n FROM jobs WHERE kind = 'drive_trash' AND status IN ('pending','running')`).first<{ n: number }>();
  return { ...quota, appBytes: app?.bytes ?? 0, pendingTrash: pending?.n ?? 0 };
}
