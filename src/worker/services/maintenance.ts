import type { Env } from '../env';
import { getDrive } from '../drive';
import { ensureReplacedFolder, syncRoundFolderName } from '../drive/folders';
import type { DriveClient } from '../drive/types';
import { getSettings } from './config';
import { claimDueJobs, completeJob, failJob, enqueue, type JobRow } from './jobs';
import { aiForThai, applyOcrResult, decideRoute, googleVision, ocrImageResponse, signedImageUrl, visionCap, visionUsage } from './ocr';
import { evictCache, getCache } from './cache';
import { audit } from './audit';

export async function runJob(env: Env, drive: DriveClient, job: JobRow, baseUrl = ''): Promise<void | 'deferred'> {
  if (job.kind === 'rename_folder') {
    await syncRoundFolderName(env, drive, job.ref_id);
    return;
  }
  if (job.kind === 'move_replaced') {
    // Invalidated images are kept (never deleted) but moved out of the set's main view.
    const img = await env.DB.prepare(
      `SELECT i.*, r.drive_folder_id FROM images i JOIN rounds r ON r.id = i.round_id WHERE i.id = ?`,
    )
      .bind(job.ref_id)
      .first<any>();
    if (!img || img.active || img.replaced_moved || !img.drive_folder_id) return;
    if (!img.drive_display_file_id && !img.drive_file_id) return;
    const replaced = await ensureReplacedFolder(drive, img.drive_folder_id);
    const base = img.file_name.replace(/\.jpg$/, '');
    if (img.drive_display_file_id) await drive.move(img.drive_display_file_id, img.drive_folder_id, replaced, `${base}_v${img.version}.jpg`);
    if (img.drive_file_id) await drive.move(img.drive_file_id, img.drive_folder_id, replaced, `${base}_v${img.version}_original.jpg`);
    await env.DB.prepare(`UPDATE images SET replaced_moved = 1 WHERE id = ?`).bind(img.id).run();
    return;
  }
  if (job.kind === 'ocr') {
    const settings = await getSettings(env);
    const round = await env.DB.prepare(`SELECT * FROM rounds WHERE id = ?`).bind(job.ref_id).first<any>();
    if (!round) return;
    const { imageId, force } = JSON.parse(job.payload ?? '{}');
    if (settings.ocrProvider === 'none' || (round.plate_source === 'manual' && !force)) {
      await env.DB.prepare(`UPDATE rounds SET ocr_status = 'skipped' WHERE id = ?`).bind(round.id).run();
      return;
    }
    const img = await env.DB.prepare(`SELECT * FROM images WHERE id = ? AND active = 1`).bind(imageId).first<any>();
    if (!img) return; // replaced since; the replacement enqueues its own OCR job
    const now = Date.now();
    const route = await decideRoute(env, settings, now);
    if (route === 'off') return;
    if (route === 'local' || route === 'wait_quota') {
      // Hand over to the Local OCR computers (they pull work), or park until quota is available.
      const status = route === 'local' ? 'local' : 'wait_quota';
      await env.DB.batch([
        env.DB.prepare(`UPDATE jobs SET status = ?, agent_id = NULL, next_run_at = ?, updated_at = ? WHERE id = ?`).bind(status, now, now, job.id),
        env.DB.prepare(`UPDATE rounds SET ocr_status = ? WHERE id = ?`).bind(route === 'local' ? 'waiting_local' : 'waiting_quota', round.id),
      ]);
      return 'deferred';
    }
    let result;
    try {
      if (route === 'vision') {
        const url = await signedImageUrl(env, baseUrl || env.PUBLIC_BASE_URL || '', img.id, now);
        result = await googleVision(env, {
          url: url ?? undefined,
          // Fallback: the smaller display copy keeps the base64 work light.
          bytes: async () => {
            const cached = await getCache(env, img.id, 'display');
            return cached ? cached.arrayBuffer() : (await drive.download(img.drive_display_file_id)).arrayBuffer();
          },
        });
      } else {
        result = await aiForThai(env, await (await ocrImageResponse(env, drive, img)).arrayBuffer());
      }
    } catch (e) {
      if (job.attempts >= 3) await env.DB.prepare(`UPDATE rounds SET ocr_status = 'failed' WHERE id = ?`).bind(round.id).run();
      throw e;
    }
    await applyOcrResult(env, drive, round.id, result, route === 'vision' ? 'ocr:google_vision' : 'ocr:aiforthai', Date.now());
    return;
  }
}

export async function processJobs(env: Env, limit = 10, baseUrl = '') {
  const drive = getDrive(env, baseUrl);
  const jobs = await claimDueJobs(env, limit);
  let done = 0;
  for (const job of jobs) {
    try {
      const r = await runJob(env, drive, job, baseUrl || env.PUBLIC_BASE_URL || '');
      if (r !== 'deferred') await completeJob(env, job.id);
      done++;
    } catch (e) {
      console.error(`Job ${job.id} (${job.kind}) failed`, e);
      await failJob(env, job, e);
    }
  }
  return { claimed: jobs.length, done };
}

/**
 * Rounds left open with no activity past the configured age are marked abandoned.
 * Their Drive folder and files are kept (never deleted); they stay visible to admins
 * under the "Abandoned" status filter, and resume automatically if the device uploads again.
 */
export async function markAbandoned(env: Env, hours: number, now = Date.now()) {
  const r = await env.DB.prepare(
    `UPDATE rounds SET status = 'abandoned', updated_at = ?1 WHERE status = 'open' AND updated_at < ?2`,
  )
    .bind(now, now - hours * 3600_000)
    .run();
  if (r.meta.changes) await audit(env, null, 'rounds.abandoned', {}, { count: r.meta.changes }, undefined, now);
  return r.meta.changes;
}

export async function cleanupExpired(env: Env, now = Date.now()) {
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM sessions WHERE expires_at < ? OR (revoked_at IS NOT NULL AND revoked_at < ?)`).bind(now, now - 7 * 86400_000),
    env.DB.prepare(`DELETE FROM exports WHERE expires_at < ?`).bind(now),
    env.DB.prepare(`DELETE FROM login_attempts WHERE updated_at < ?`).bind(now - 86400_000),
    env.DB.prepare(`DELETE FROM jobs WHERE status = 'done' AND updated_at < ?`).bind(now - 7 * 86400_000),
  ]);
}

/** Plates parked because Vision hit its cap go back in the queue once quota is available again (new month). */
export async function releaseWaitingQuota(env: Env) {
  const settings = await getSettings(env);
  if ((await visionUsage(env)) >= visionCap(settings)) return 0;
  const r = await env.DB.prepare(
    `UPDATE jobs SET status = 'pending', next_run_at = ?1, updated_at = ?1
     WHERE id IN (SELECT id FROM jobs WHERE kind = 'ocr' AND status = 'wait_quota' ORDER BY created_at LIMIT 50)`,
  )
    .bind(Date.now())
    .run();
  return r.meta.changes;
}

export async function scheduled(env: Env) {
  const settings = await getSettings(env);
  await releaseWaitingQuota(env);
  await processJobs(env, 10);
  await evictCache(env, settings);
  await markAbandoned(env, settings.abandonAfterHours);
  await cleanupExpired(env);
}

export { enqueue };
