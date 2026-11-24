import type { Env } from '../env';
import { getDrive } from '../drive';
import { ensureReplacedFolder, syncRoundFolderName } from '../drive/folders';
import type { DriveClient } from '../drive/types';
import { normalizePlate, plateDigits } from '../../shared/plate';
import { getSettings } from './config';
import { claimDueJobs, completeJob, failJob, enqueue, type JobRow } from './jobs';
import { recognizePlate } from './ocr';
import { evictCache, getCache } from './cache';
import { audit } from './audit';

export async function runJob(env: Env, drive: DriveClient, job: JobRow) {
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
    if (settings.ocrProvider === 'none' || round.plate_source === 'manual') {
      await env.DB.prepare(`UPDATE rounds SET ocr_status = 'skipped' WHERE id = ?`).bind(round.id).run();
      return;
    }
    const { imageId } = JSON.parse(job.payload ?? '{}');
    const img = await env.DB.prepare(`SELECT * FROM images WHERE id = ? AND active = 1`).bind(imageId).first<any>();
    if (!img) return; // replaced since; the replacement enqueues its own OCR job
    // Prefer the un-watermarked original for recognition; fall back to the cached display copy.
    let bytes: ArrayBuffer;
    if (img.drive_file_id) bytes = await (await drive.download(img.drive_file_id)).arrayBuffer();
    else {
      const cached = await getCache(env, img.id, 'display');
      bytes = cached ? await cached.arrayBuffer() : await (await drive.download(img.drive_display_file_id)).arrayBuffer();
    }
    let result;
    try {
      result = await recognizePlate(env, settings.ocrProvider, bytes);
    } catch (e) {
      if (job.attempts >= 3) await env.DB.prepare(`UPDATE rounds SET ocr_status = 'failed' WHERE id = ?`).bind(round.id).run();
      throw e;
    }
    const now = Date.now();
    // Re-check: a manual correction made while OCR was running always wins.
    const upd = await env.DB.prepare(
      `UPDATE rounds SET plate_raw = ?, plate_confidence = ?, ocr_status = 'done',
         plate_text = CASE WHEN plate_source = 'manual' THEN plate_text ELSE ? END,
         plate_norm = CASE WHEN plate_source = 'manual' THEN plate_norm ELSE ? END,
         plate_digits = CASE WHEN plate_source = 'manual' THEN plate_digits ELSE ? END,
         plate_source = CASE WHEN plate_source = 'manual' THEN 'manual' WHEN ? IS NULL THEN 'none' ELSE 'ocr' END,
         plate_updated_at = ?, updated_at = ?
       WHERE id = ?`,
    )
      .bind(
        result.raw,
        result.confidence,
        result.plate,
        result.plate ? normalizePlate(result.plate) : null,
        result.plate ? plateDigits(result.plate) || null : null,
        result.plate,
        now,
        now,
        round.id,
      )
      .run();
    if (upd.meta.changes) {
      await env.DB.prepare(
        `INSERT INTO plate_history (round_id, at, actor_id, source, old_text, new_text, raw, confidence) VALUES (?, ?, NULL, 'ocr', ?, ?, ?, ?)`,
      )
        .bind(round.id, now, round.plate_text, result.plate, result.raw.slice(0, 500), result.confidence)
        .run();
      await syncRoundFolderName(env, drive, round.id);
    }
    return;
  }
}

export async function processJobs(env: Env, limit = 10, baseUrl = '') {
  const drive = getDrive(env, baseUrl);
  const jobs = await claimDueJobs(env, limit);
  let done = 0;
  for (const job of jobs) {
    try {
      await runJob(env, drive, job);
      await completeJob(env, job.id);
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

export async function scheduled(env: Env) {
  const settings = await getSettings(env);
  await processJobs(env, 10);
  await evictCache(env, settings);
  await markAbandoned(env, settings.abandonAfterHours);
  await cleanupExpired(env);
}

export { enqueue };
