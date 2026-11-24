import type { AuthUser, Env } from '../env';
import type { AppSettings } from '../../shared/types';
import { normalizePlate, plateDigits } from '../../shared/plate';
import { stepLabel } from '../../shared/i18n';
import { can } from '../auth/permissions';
import { badRequest, conflict, forbidden, notFound } from '../util';
import { getWorkflow } from './config';
import { isRecent, toSetRow } from './history';
import { cachedKinds } from './cache';
import { audit } from './audit';
import { enqueueStmt } from './jobs';
import type { DriveClient } from '../drive/types';

/** Load a set and enforce that the caller may see it given hidden/removed state. */
export async function loadVisibleSet(env: Env, user: AuthUser, id: string) {
  const r = await env.DB.prepare(
    `SELECT r.*, u.display_name AS operator_name FROM rounds r JOIN users u ON u.id = r.operator_id WHERE r.id = ?`,
  )
    .bind(id)
    .first<any>();
  if (!r) throw notFound('Photo set not found.');
  if (r.removed_at && !can(user.role, 'sets.viewRemoved')) throw notFound('Photo set not found.');
  if (r.hidden_at && !can(user.role, 'sets.viewHidden')) throw notFound('Photo set not found.');
  return r;
}

/**
 * Full details of one set. For old sets no image URLs are returned at all, so the
 * dashboard has nothing to fetch; the set is opened in Drive instead.
 */
export async function setDetails(env: Env, user: AuthUser, id: string, settings: AppSettings, drive: DriveClient, now = Date.now()) {
  const r = await loadVisibleSet(env, user, id);
  const workflow = await getWorkflow(env, r.workflow_version_id);
  const { results: images } = await env.DB.prepare(
    `SELECT * FROM images WHERE round_id = ? ORDER BY step_index, version`,
  )
    .bind(id)
    .all<any>();
  const recent = isRecent(r.op_date, settings, now);
  const cacheMode = settings.imageDisplayMode === 'cache';
  const cached = recent || cacheMode ? await cachedKinds(env, images.map((i) => i.id)) : new Map();
  const { results: plateHistory } = await env.DB.prepare(
    `SELECT p.*, u.display_name AS actor_name FROM plate_history p LEFT JOIN users u ON u.id = p.actor_id WHERE round_id = ? ORDER BY at DESC LIMIT 50`,
  )
    .bind(id)
    .all();

  const steps = (workflow?.steps ?? []).map((s, index) => {
    const imgs = images.filter((i) => i.step_id === s.id);
    return {
      id: s.id,
      index,
      label: stepLabel(s.labels, settings.defaultLanguage, settings.fallbackLanguage),
      labels: s.labels,
      required: s.required,
      images: imgs.map((i) => {
        const kinds = cached.get(i.id) ?? new Set<string>();
        // Recent sets: images come from cache or fall back to Drive. Cache mode: only cached copies.
        const canShow = i.active && i.uploaded_at && (recent || kinds.has('display') || kinds.has('thumb'));
        return {
          id: i.id,
          version: i.version,
          active: !!i.active,
          status: i.status,
          source: i.source,
          fileName: i.file_name,
          serverReceivedAt: i.server_received_at,
          acceptedAtDevice: i.accepted_at_device,
          captureTimeDevice: i.capture_time_device,
          exifTimeUnverified: i.exif_time,
          uploadedAt: i.uploaded_at,
          supersededAt: i.superseded_at,
          originalBytes: i.original_bytes,
          displayBytes: i.display_bytes,
          thumbUrl: canShow ? `/api/admin/images/${i.id}/thumb` : null,
          displayUrl: canShow ? `/api/admin/images/${i.id}/display` : null,
        };
      }),
    };
  });

  return {
    set: toSetRow(r, settings, drive, now),
    recent,
    imagesAvailable: steps.some((s) => s.images.some((i) => i.displayUrl)),
    workflowVersionId: r.workflow_version_id,
    startedAtSource: r.started_at_source,
    createdAt: r.created_at,
    finalizedAt: r.finalized_at,
    plate: {
      text: r.plate_text,
      raw: r.plate_raw,
      confidence: r.plate_confidence,
      source: r.plate_source,
      ocrStatus: r.ocr_status,
      unknownLabel: r.unknown_label,
      history: plateHistory,
    },
    drive: { folderId: r.drive_folder_id, folderName: r.drive_folder_name, dateFolderId: r.drive_date_folder_id, status: r.folder_status },
    hiddenAt: r.hidden_at,
    removedAt: r.removed_at,
    steps,
  };
}

export type SetAction = 'hide' | 'unhide' | 'remove' | 'restore';

/**
 * Hide / remove apply to the WHOLE set and only change application visibility.
 * Nothing here talks to Drive: files and folders are never deleted.
 */
export async function changeVisibility(env: Env, user: AuthUser, id: string, action: SetAction, ip: string, now = Date.now()) {
  const perm = action === 'hide' || action === 'unhide' ? 'sets.hide' : action === 'remove' ? 'sets.remove' : 'sets.restore';
  if (!can(user.role, perm)) throw forbidden();
  const r = await loadVisibleSet(env, user, id);
  const sql = {
    hide: `UPDATE rounds SET hidden_at = ?1, hidden_by = ?2, updated_at = ?1 WHERE id = ?3`,
    unhide: `UPDATE rounds SET hidden_at = NULL, hidden_by = NULL, updated_at = ?1 WHERE id = ?3 AND ?2 IS NOT NULL`,
    remove: `UPDATE rounds SET removed_at = ?1, removed_by = ?2, updated_at = ?1 WHERE id = ?3`,
    restore: `UPDATE rounds SET removed_at = NULL, removed_by = NULL, updated_at = ?1 WHERE id = ?3 AND ?2 IS NOT NULL`,
  }[action];
  await env.DB.prepare(sql).bind(now, user.id, id).run();
  await audit(env, user, `set.${action}`, { type: 'set', id }, { publicId: r.public_id, driveFolderId: r.drive_folder_id }, ip, now);
}

export async function updatePlate(env: Env, user: AuthUser, id: string, text: string, ip: string, now = Date.now()) {
  if (!can(user.role, 'sets.editPlate')) throw forbidden();
  const r = await loadVisibleSet(env, user, id);
  const clean = (text ?? '').normalize('NFC').replace(/\s+/g, ' ').trim();
  if (clean.length > 30) throw badRequest('Plate text is too long.');
  if (clean && !/[0-9]/.test(clean)) throw badRequest('A plate should contain digits.');
  if (r.status === 'open') throw conflict('round_open', 'Wait until the set is saved before correcting the plate.');
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE rounds SET plate_text = ?, plate_norm = ?, plate_digits = ?, plate_source = ?, plate_updated_at = ?, plate_updated_by = ?, updated_at = ? WHERE id = ?`,
    ).bind(clean || null, normalizePlate(clean) || null, plateDigits(clean) || null, clean ? 'manual' : 'none', now, user.id, now, id),
    env.DB.prepare(
      `INSERT INTO plate_history (round_id, at, actor_id, source, old_text, new_text) VALUES (?, ?, ?, 'manual', ?, ?)`,
    ).bind(id, now, user.id, r.plate_text, clean || null),
    enqueueStmt(env, 'rename_folder', id, null, now),
  ]);
  await audit(env, user, 'set.plate_corrected', { type: 'set', id }, { from: r.plate_text, to: clean || null }, ip, now);
}
