import type { AuthUser, Env } from '../env';
import type {
  BeginImageRequest,
  BeginImageResponse,
  CompleteImageRequest,
  CompleteImageResponse,
  FinalizeResponse,
  WorkflowVersion,
} from '../../shared/types';
import { bangkokDate } from '../../shared/time';
import { publicIdFromSeq, stepFileName } from '../../shared/names';
import { stepLabel } from '../../shared/i18n';
import { ApiError, badRequest, conflict, forbidden, notFound, unavailable, uuid } from '../util';
import { getSettings, getWorkflow } from './config';
import { getDrive, effectiveRoot } from '../drive';
import { ensureRoundFolder } from '../drive/folders';
import { DriveNotConnectedError, type DriveClient } from '../drive/types';
import { enqueueStmt } from './jobs';

const MAX_DEVICE_AGE_MS = 24 * 3600_000;
const MAX_DEVICE_FUTURE_MS = 2 * 60_000;

/**
 * The round's start time is the first accepted image time. We use the device's
 * acceptance time when it is plausible (the image may have been queued offline), and
 * fall back to server receipt time when the device clock is clearly wrong. The source
 * is recorded so the two are never confused.
 */
export function pickStartedAt(acceptedAtDevice: number | undefined, serverNow: number) {
  if (
    typeof acceptedAtDevice === 'number' &&
    acceptedAtDevice <= serverNow + MAX_DEVICE_FUTURE_MS &&
    acceptedAtDevice >= serverNow - MAX_DEVICE_AGE_MS
  ) {
    return { startedAt: Math.min(acceptedAtDevice, serverNow), source: 'device' as const };
  }
  return { startedAt: serverNow, source: 'server' as const };
}

function driveError(e: unknown): never {
  if (e instanceof ApiError) throw e;
  if (e instanceof DriveNotConnectedError) throw unavailable('drive_not_connected', e.message);
  console.error('Drive error', e);
  throw unavailable('drive_error', 'Google Drive ใช้งานไม่ได้ชั่วคราว ระบบจะลองอัปโหลดใหม่เอง');
}

async function loadRoundForOperator(env: Env, user: AuthUser, roundId: string) {
  const r = await env.DB.prepare(`SELECT * FROM rounds WHERE id = ?`).bind(roundId).first<any>();
  if (!r) throw notFound('Round not found.');
  if (r.operator_id !== user.id) throw forbidden('รอบนี้เป็นของพนักงานคนอื่น');
  return r;
}

async function recountStmt(env: Env, roundId: string, now: number) {
  return env.DB.prepare(
    `UPDATE rounds SET
       active_count = (SELECT COUNT(*) FROM images WHERE round_id = ?1 AND active = 1),
       uploaded_count = (SELECT COUNT(*) FROM images WHERE round_id = ?1 AND active = 1 AND status = 'uploaded'),
       updated_at = ?2
     WHERE id = ?1`,
  ).bind(roundId, now);
}

export async function beginImage(
  env: Env,
  user: AuthUser,
  input: BeginImageRequest,
  opts: { origin: string | null; baseUrl: string; now?: number; drive?: DriveClient },
): Promise<BeginImageResponse> {
  const now = opts.now ?? Date.now();
  if (!input?.clientRoundId || !input.clientImageId || !input.stepId) throw badRequest('Missing identifiers.');
  if (!['camera', 'upload'].includes(input.source)) throw badRequest('source must be camera or upload.');
  if (!/^[\w-]{8,64}$/.test(input.clientRoundId) || !/^[\w-]{8,64}$/.test(input.clientImageId)) {
    throw badRequest('Invalid identifiers.');
  }
  const settings = await getSettings(env);
  const drive = opts.drive ?? getDrive(env, opts.baseUrl);

  // 1. Round: created when the first image is accepted, idempotent on client_round_id.
  let round = await env.DB.prepare(`SELECT * FROM rounds WHERE client_round_id = ?`).bind(input.clientRoundId).first<any>();
  if (round && round.operator_id !== user.id) throw forbidden('รอบนี้เป็นของพนักงานคนอื่น');
  let workflow: WorkflowVersion | null;
  if (!round) {
    workflow = await getWorkflow(env, input.workflowVersionId);
    if (!workflow) throw badRequest('Unknown workflow version.');
    const { startedAt, source } = pickStartedAt(input.acceptedAtDevice, now);
    const seqRow = await env.DB.prepare(`UPDATE counters SET value = value + 1 WHERE name = 'round' RETURNING value`).first<{ value: number }>();
    const seq = seqRow!.value;
    const id = uuid();
    const root = effectiveRoot(env, settings.driveRootFolderId);
    await env.DB.prepare(
      `INSERT INTO rounds (id, seq, public_id, client_round_id, operator_id, workflow_version_id, started_at, started_at_source,
         created_at, op_date, status, required_count, unknown_label, drive_root_folder_id, ocr_status, updated_at, workflow_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?)
       ON CONFLICT(client_round_id) DO NOTHING`,
    )
      .bind(
        id,
        seq,
        publicIdFromSeq(seq),
        input.clientRoundId,
        user.id,
        workflow.id,
        startedAt,
        source,
        now,
        bangkokDate(startedAt),
        workflow.steps.filter((s) => s.required).length,
        settings.unknownPlateLabel,
        root,
        settings.ocrProvider === 'none' ? 'disabled' : 'none',
        now,
        workflow.workflowId ?? 'default',
      )
      .run();
    round = await env.DB.prepare(`SELECT * FROM rounds WHERE client_round_id = ?`).bind(input.clientRoundId).first<any>();
    if (round.operator_id !== user.id) throw forbidden('รอบนี้เป็นของพนักงานคนอื่น');
  }
  // The round's workflow is frozen: later admin edits never change it.
  workflow = await getWorkflow(env, round.workflow_version_id);
  if (!workflow) throw new Error('Workflow version missing');
  if (round.status === 'finalized') throw conflict('round_finalized', 'ชุดนี้ถูกบันทึกไปแล้ว');
  if (round.drive_trashed_at) throw conflict('round_trashed', 'รูปของชุดนี้ถูกย้ายไปถังขยะ Drive แล้ว กรุณาเริ่มชุดใหม่');
  if (round.status === 'abandoned') {
    await env.DB.prepare(`UPDATE rounds SET status = 'open', updated_at = ? WHERE id = ?`).bind(now, round.id).run();
  }

  const stepIndex = workflow.steps.findIndex((s) => s.id === input.stepId);
  if (stepIndex < 0) throw badRequest('This step is not part of the round’s workflow.');
  const step = workflow.steps[stepIndex];
  if (input.source === 'upload' && !step.allowUpload) {
    throw new ApiError(403, 'upload_not_allowed', 'ขั้นตอนนี้ไม่อนุญาตให้อัปโหลดไฟล์');
  }
  const label = stepLabel(step.labels, settings.defaultLanguage, settings.fallbackLanguage);
  const fileName = stepFileName(stepIndex, label);

  // 2. Folder must exist before uploads can start (created early, on the first image).
  let folderId: string;
  try {
    folderId = await ensureRoundFolder(env, drive, round.id, round.drive_root_folder_id || effectiveRoot(env, settings.driveRootFolderId));
  } catch (e) {
    driveError(e);
  }

  // 3. Image row — idempotent on client_image_id.
  let image = await env.DB.prepare(`SELECT * FROM images WHERE client_image_id = ?`).bind(input.clientImageId).first<any>();
  if (image && image.round_id !== round.id) throw conflict('image_conflict', 'Image ID already used in another round.');
  if (!image) {
    const imageId = uuid();
    const vrow = await env.DB.prepare(`SELECT COALESCE(MAX(version), 0) AS v FROM images WHERE round_id = ? AND step_id = ?`)
      .bind(round.id, step.id)
      .first<{ v: number }>();
    const version = (vrow?.v ?? 0) + 1;
    const superseded = await env.DB.prepare(
      `SELECT id, uploaded_at FROM images WHERE round_id = ? AND step_id = ? AND active = 1`,
    )
      .bind(round.id, step.id)
      .all<{ id: string; uploaded_at: number | null }>();
    // Atomic replacement: the previous active image is invalidated in the same transaction
    // that inserts the new one, so there is never more than one active image per step.
    const stmts = [
      env.DB.prepare(
        `UPDATE images SET active = 0, status = 'superseded', superseded_at = ?, superseded_by = ?
         WHERE round_id = ? AND step_id = ? AND active = 1`,
      ).bind(now, imageId, round.id, step.id),
      env.DB.prepare(
        `INSERT INTO images (id, client_image_id, round_id, step_id, step_index, version, active, status, source, operator_id,
           server_received_at, accepted_at_device, capture_time_device, exif_time, file_name, width, height, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        imageId,
        input.clientImageId,
        round.id,
        step.id,
        stepIndex,
        version,
        input.source,
        user.id,
        now,
        Number.isFinite(input.acceptedAtDevice) ? input.acceptedAtDevice : null,
        input.source === 'camera' && Number.isFinite(input.captureTimeDevice) ? input.captureTimeDevice : null,
        input.exifTime ? String(input.exifTime).slice(0, 40) : null,
        fileName,
        Number.isFinite(input.width) ? input.width : null,
        Number.isFinite(input.height) ? input.height : null,
        now,
      ),
      await recountStmt(env, round.id, now),
    ];
    for (const s of superseded.results) {
      if (s.uploaded_at) stmts.push(enqueueStmt(env, 'move_replaced', s.id, null, now));
    }
    await env.DB.batch(stmts);
    image = await env.DB.prepare(`SELECT * FROM images WHERE id = ?`).bind(imageId).first<any>();
  }

  const response: BeginImageResponse = {
    round: { id: round.id, publicId: round.public_id, startedAt: round.started_at },
    image: { id: image.id, version: image.version, fileName: image.file_name, status: image.status, active: !!image.active },
    serverReceivedAt: image.server_received_at,
    stepLabel: label,
  };

  // 4. Fresh resumable upload sessions (Drive session URLs never expose credentials).
  if (image.status === 'pending' && image.active) {
    try {
      // A sharper copy is kept for every photo (keepOriginals) or only for photos read by OCR.
      const wantOriginal = settings.keepOriginals || (step.ocr && settings.ocrHighRes && settings.ocrProvider !== 'none');
      // Both sessions are created in parallel to cut a Drive round trip.
      const origName = image.file_name.replace(/\.jpg$/, '_original.jpg');
      const [display, original] = await Promise.all([
        drive.createUploadSession(folderId, image.file_name, 'image/jpeg', opts.origin),
        wantOriginal ? drive.createUploadSession(folderId, origName, 'image/jpeg', opts.origin) : Promise.resolve(null),
      ]);
      const uploads: BeginImageResponse['uploads'] = { display: { url: display, name: image.file_name } };
      if (original) uploads.original = { url: original, name: origName };
      response.uploads = uploads;
    } catch (e) {
      driveError(e);
    }
  }
  return response;
}

export async function completeImage(
  env: Env,
  user: AuthUser,
  imageId: string,
  input: CompleteImageRequest,
  opts: { now?: number; drive?: DriveClient; baseUrl: string },
): Promise<CompleteImageResponse> {
  const now = opts.now ?? Date.now();
  const image = await env.DB.prepare(`SELECT * FROM images WHERE id = ?`).bind(imageId).first<any>();
  if (!image) throw notFound('Image not found.');
  const round = await loadRoundForOperator(env, user, image.round_id);
  if (!input?.displayFileId) throw badRequest('displayFileId is required.');

  if (image.uploaded_at) {
    if (image.drive_display_file_id !== input.displayFileId) throw conflict('already_completed', 'This image was already completed with another file.');
    return { imageId, active: !!image.active, status: image.active ? 'uploaded' : 'superseded', uploadedAt: image.uploaded_at };
  }

  // Verify with Drive that the files really exist in this round's folder before acknowledging.
  const settings = await getSettings(env);
  const drive = opts.drive ?? getDrive(env, opts.baseUrl);
  try {
    // Verify every file the phone reports (display always; original when it was uploaded), in parallel.
    const ids = [input.displayFileId, ...(input.originalFileId ? [input.originalFileId] : [])];
    const files = await Promise.all(ids.map((id) => drive.getFile(id)));
    for (const f of files) {
      if (!f || f.trashed || !f.parents.includes(round.drive_folder_id)) {
        throw new ApiError(422, 'upload_not_verified', 'ตรวจสอบไฟล์ใน Drive ไม่ได้ ระบบจะอัปโหลดใหม่');
      }
    }
  } catch (e) {
    driveError(e);
  }

  // The status depends on whether this image is STILL the active one. An old upload that
  // finishes after a retake is stored as superseded and can never displace the replacement.
  const stmts = [
    env.DB.prepare(
      `UPDATE images SET status = CASE WHEN active = 1 THEN 'uploaded' ELSE 'superseded' END,
         drive_display_file_id = ?, drive_file_id = ?, display_bytes = ?, original_bytes = ?, uploaded_at = ?
       WHERE id = ? AND uploaded_at IS NULL`,
    ).bind(
      input.displayFileId,
      input.originalFileId ?? null,
      Number.isFinite(input.displayBytes) ? input.displayBytes : null,
      Number.isFinite(input.originalBytes) ? input.originalBytes : null,
      now,
      imageId,
    ),
    await recountStmt(env, round.id, now),
  ];
  await env.DB.batch(stmts);
  const after = await env.DB.prepare(`SELECT active, status, uploaded_at FROM images WHERE id = ?`).bind(imageId).first<any>();
  const workflow = await getWorkflow(env, round.workflow_version_id);
  const step = workflow?.steps.find((s) => s.id === image.step_id);
  if (!after.active) {
    await enqueueStmt(env, 'move_replaced', imageId, null, now).run();
  } else if (step?.ocr && settings.ocrProvider !== 'none' && round.plate_source !== 'manual') {
    await env.DB.batch([
      enqueueStmt(env, 'ocr', round.id, { imageId, kind: step.ocrKind ?? 'plate' }, now),
      env.DB.prepare(`UPDATE rounds SET ocr_status = 'pending' WHERE id = ?`).bind(round.id),
    ]);
  }
  return { imageId, active: !!after.active, status: after.active ? 'uploaded' : 'superseded', uploadedAt: after.uploaded_at };
}

export async function finalizeRound(
  env: Env,
  user: AuthUser,
  roundId: string,
  idempotencyKey: string,
  now = Date.now(),
): Promise<FinalizeResponse> {
  const round = await loadRoundForOperator(env, user, roundId);
  if (round.status === 'finalized') return { ok: true, publicId: round.public_id, alreadyFinalized: true };
  const workflow = await getWorkflow(env, round.workflow_version_id);
  if (!workflow) throw new Error('Workflow version missing');
  const { results } = await env.DB.prepare(`SELECT step_id, status FROM images WHERE round_id = ? AND active = 1`)
    .bind(roundId)
    .all<{ step_id: string; status: string }>();
  const byStep = new Map(results.map((r) => [r.step_id, r.status]));
  const missing = workflow.steps.filter((s) => s.required && !byStep.has(s.id)).map((s) => s.id);
  const notUploaded = results.filter((r) => r.status !== 'uploaded').map((r) => r.step_id);
  if (missing.length || notUploaded.length) {
    throw conflict('incomplete', 'ยังขาดรูปหรือรูปยังอัปโหลดไม่เสร็จ', { missing, notUploaded });
  }
  const settings = await getSettings(env);
  if (settings.ocrBlocksDone && round.ocr_status === 'pending') {
    throw conflict('ocr_pending', 'Plate recognition is still running.');
  }
  await env.DB.prepare(
    `UPDATE rounds SET status = 'finalized', finalized_at = ?, finalize_key = ?, updated_at = ? WHERE id = ? AND status != 'finalized'`,
  )
    .bind(now, idempotencyKey.slice(0, 64), now, roundId)
    .run();
  return { ok: true, publicId: round.public_id, alreadyFinalized: false };
}

/** Server view of a round, used by the field app to reconcile after a reload. */
export async function roundState(env: Env, user: AuthUser, clientRoundId: string) {
  const round = await env.DB.prepare(`SELECT * FROM rounds WHERE client_round_id = ?`).bind(clientRoundId).first<any>();
  if (!round) return null;
  if (round.operator_id !== user.id) throw forbidden();
  const { results } = await env.DB.prepare(
    `SELECT id, client_image_id, step_id, version, active, status, uploaded_at FROM images WHERE round_id = ? ORDER BY step_index, version`,
  )
    .bind(round.id)
    .all();
  return {
    id: round.id,
    publicId: round.public_id,
    status: round.status,
    workflowVersionId: round.workflow_version_id,
    images: results,
  };
}
