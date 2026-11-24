import type { Env } from '../env';

export type JobKind = 'move_replaced' | 'ocr' | 'rename_folder';

export function enqueueStmt(env: Env, kind: JobKind, refId: string, payload: unknown = null, now = Date.now(), delayMs = 0) {
  return env.DB.prepare(
    `INSERT INTO jobs (kind, ref_id, payload, status, attempts, next_run_at, created_at, updated_at)
     VALUES (?, ?, ?, 'pending', 0, ?, ?, ?)`,
  ).bind(kind, refId, payload == null ? null : JSON.stringify(payload), now + delayMs, now, now);
}

export async function enqueue(env: Env, kind: JobKind, refId: string, payload: unknown = null, now = Date.now()) {
  await enqueueStmt(env, kind, refId, payload, now).run();
}

export interface JobRow {
  id: number;
  kind: JobKind;
  ref_id: string;
  payload: string | null;
  attempts: number;
}

/** Claim up to `limit` due jobs. A claimed job is invisible to other runners for 2 minutes. */
export async function claimDueJobs(env: Env, limit: number, now = Date.now()): Promise<JobRow[]> {
  const { results } = await env.DB.prepare(
    `UPDATE jobs SET status = 'running', next_run_at = ?1 + 120000, updated_at = ?1
     WHERE id IN (SELECT id FROM jobs WHERE status IN ('pending','running') AND next_run_at <= ?1 ORDER BY next_run_at LIMIT ?2)
     RETURNING id, kind, ref_id, payload, attempts`,
  )
    .bind(now, limit)
    .all<JobRow>();
  return results;
}

export async function completeJob(env: Env, id: number) {
  await env.DB.prepare(`UPDATE jobs SET status = 'done', updated_at = ? WHERE id = ?`).bind(Date.now(), id).run();
}

export async function failJob(env: Env, job: JobRow, err: unknown) {
  const attempts = job.attempts + 1;
  const dead = attempts >= 8;
  const backoff = Math.min(6 * 3600_000, 60_000 * 2 ** attempts);
  await env.DB.prepare(
    `UPDATE jobs SET status = ?, attempts = ?, last_error = ?, next_run_at = ?, updated_at = ? WHERE id = ?`,
  )
    .bind(dead ? 'failed' : 'pending', attempts, String((err as Error)?.message ?? err).slice(0, 500), Date.now() + backoff, Date.now(), job.id)
    .run();
}
