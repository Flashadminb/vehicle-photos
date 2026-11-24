import type { Env, AuthUser } from '../env';

export async function audit(
  env: Env,
  actor: Pick<AuthUser, 'id' | 'displayName'> | null,
  action: string,
  target: { type?: string; id?: string } = {},
  details?: unknown,
  ip?: string,
  now = Date.now(),
) {
  await env.DB.prepare(
    `INSERT INTO audit_log (at, actor_id, actor_name, action, target_type, target_id, details, ip)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      now,
      actor?.id ?? null,
      actor?.displayName ?? null,
      action,
      target.type ?? null,
      target.id ?? null,
      details === undefined ? null : JSON.stringify(details),
      ip ?? null,
    )
    .run();
}
