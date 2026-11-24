import type { Env } from '../env';
import type { DriveClient } from './types';
import { roundFolderName } from '../../shared/names';
import { unavailable } from '../util';

const LOCK_MS = 30_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Get-or-create the YYYY-MM-DD folder under the root.
 *
 * Drive allows duplicate names, so concurrent requests could create two folders with
 * the same date. We prevent that with a short D1 lease per (root, date): only the lease
 * holder talks to Drive; others wait for the stored folder ID. The holder also looks for
 * an existing folder first (crash recovery) and, after creating, re-lists and keeps the
 * OLDEST folder if a duplicate slipped in (e.g. a folder created outside the app).
 */
export async function ensureDateFolder(env: Env, drive: DriveClient, rootId: string, opDate: string): Promise<string> {
  for (let attempt = 0; attempt < 12; attempt++) {
    const now = Date.now();
    const row = await env.DB.prepare(`SELECT folder_id FROM drive_date_folders WHERE root_folder_id = ? AND op_date = ?`)
      .bind(rootId, opDate)
      .first<{ folder_id: string | null }>();
    if (row?.folder_id) return row.folder_id;

    const lease = await env.DB.prepare(
      `INSERT INTO drive_date_folders (root_folder_id, op_date, folder_id, lock_until, created_at) VALUES (?1, ?2, NULL, ?3, ?4)
       ON CONFLICT(root_folder_id, op_date) DO UPDATE SET lock_until = ?3
       WHERE drive_date_folders.folder_id IS NULL AND (drive_date_folders.lock_until IS NULL OR drive_date_folders.lock_until < ?4)`,
    )
      .bind(rootId, opDate, now + LOCK_MS, now)
      .run();

    if (lease.meta.changes === 1) {
      try {
        let folders = await drive.findFolders(rootId, opDate);
        if (folders.length === 0) {
          await drive.createFolder(rootId, opDate);
          folders = await drive.findFolders(rootId, opDate);
        }
        const chosen = folders[0];
        if (!chosen) throw new Error('Date folder creation did not persist.');
        await env.DB.prepare(
          `UPDATE drive_date_folders SET folder_id = ?, lock_until = NULL WHERE root_folder_id = ? AND op_date = ?`,
        )
          .bind(chosen.id, rootId, opDate)
          .run();
        return chosen.id;
      } catch (e) {
        await env.DB.prepare(`UPDATE drive_date_folders SET lock_until = NULL WHERE root_folder_id = ? AND op_date = ? AND folder_id IS NULL`)
          .bind(rootId, opDate)
          .run();
        throw e;
      }
    }
    await sleep(250 + attempt * 100);
  }
  throw unavailable('drive_busy', 'Drive folder is being prepared. Retrying shortly.');
}

/** Get-or-create the round folder. Same lease pattern, stored on the round row. */
export async function ensureRoundFolder(env: Env, drive: DriveClient, roundId: string, rootId: string): Promise<string> {
  for (let attempt = 0; attempt < 12; attempt++) {
    const now = Date.now();
    const r = await env.DB.prepare(`SELECT * FROM rounds WHERE id = ?`).bind(roundId).first<any>();
    if (!r) throw new Error('Round not found');
    if (r.drive_folder_id) return r.drive_folder_id;

    const lease = await env.DB.prepare(
      `UPDATE rounds SET folder_lock_until = ?1 WHERE id = ?2 AND drive_folder_id IS NULL
         AND (folder_lock_until IS NULL OR folder_lock_until < ?3)`,
    )
      .bind(now + LOCK_MS, roundId, now)
      .run();

    if (lease.meta.changes === 1) {
      try {
        const dateFolderId = await ensureDateFolder(env, drive, rootId, r.op_date);
        const name = roundFolderName(r.started_at, r.plate_text || r.unknown_label, r.public_id);
        // Reuse a folder from an earlier attempt that created it but crashed before saving.
        const existing = (await drive.findFolders(dateFolderId, name))[0];
        const folder = existing ?? (await drive.createFolder(dateFolderId, name));
        await env.DB.prepare(
          `UPDATE rounds SET drive_root_folder_id = ?, drive_date_folder_id = ?, drive_folder_id = ?, drive_folder_name = ?,
             folder_status = 'ready', folder_lock_until = NULL, updated_at = ? WHERE id = ?`,
        )
          .bind(rootId, dateFolderId, folder.id, name, Date.now(), roundId)
          .run();
        return folder.id;
      } catch (e) {
        await env.DB.prepare(`UPDATE rounds SET folder_lock_until = NULL, folder_status = 'error' WHERE id = ? AND drive_folder_id IS NULL`)
          .bind(roundId)
          .run();
        throw e;
      }
    }
    await sleep(250 + attempt * 100);
  }
  throw unavailable('drive_busy', 'Drive folder is being prepared. Retrying shortly.');
}

/**
 * Rename the round's existing folder to reflect the current plate. The folder ID never
 * changes, so stored links keep working. The date folder never changes either: a round
 * that crosses midnight stays where it started.
 */
export async function syncRoundFolderName(env: Env, drive: DriveClient, roundId: string) {
  const r = await env.DB.prepare(`SELECT * FROM rounds WHERE id = ?`).bind(roundId).first<any>();
  if (!r?.drive_folder_id) return null;
  const name = roundFolderName(r.started_at, r.plate_text || r.unknown_label, r.public_id);
  if (name !== r.drive_folder_name) {
    await drive.rename(r.drive_folder_id, name);
    await env.DB.prepare(`UPDATE rounds SET drive_folder_name = ?, updated_at = ? WHERE id = ?`).bind(name, Date.now(), roundId).run();
  }
  return { folderId: r.drive_folder_id as string, name };
}

/** Lazily create the `_replaced` subfolder used for invalidated images. */
export async function ensureReplacedFolder(drive: DriveClient, roundFolderId: string): Promise<string> {
  const found = await drive.findFolders(roundFolderId, '_replaced');
  if (found[0]) return found[0].id;
  await drive.createFolder(roundFolderId, '_replaced');
  return (await drive.findFolders(roundFolderId, '_replaced'))[0].id;
}
