import { Hono } from 'hono';
import type { Env } from '../env';
import { ApiError, clientIp, notFound, readJson, sha256Hex } from '../util';
import { getSettings } from '../services/config';
import { applyOcrResult, ocrImageResponse, resultFromText } from '../services/ocr';
import { getDrive } from '../drive';

/**
 * API for Local OCR computers ("agents"). Agents PULL work: any number of computers can
 * run the agent; whichever is switched on takes the next plate. A job is leased to one
 * agent for 5 minutes, so two computers never read the same plate, and a computer that is
 * switched off mid-job simply lets the lease expire and another one takes over.
 * Auth: a per-computer token created in the dashboard (only its SHA-256 is stored).
 */
type AgentVars = { Bindings: Env; Variables: { agent: { id: string; name: string } } };
export const agent = new Hono<AgentVars>();

const LEASE_MS = 5 * 60_000;
const MAX_LOCAL_ATTEMPTS = 5;

agent.use('/*', async (c, next) => {
  const auth = c.req.header('Authorization') ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!token) throw new ApiError(401, 'unauthenticated', 'Missing agent token.');
  const row = await c.env.DB.prepare(`SELECT * FROM ocr_agents WHERE token_hash = ?`).bind(await sha256Hex(token)).first<any>();
  if (!row || row.disabled) throw new ApiError(401, 'unauthenticated', 'Unknown or disabled agent token.');
  const now = Date.now();
  // Heartbeat, written at most every 20 s to save D1 writes.
  if (!row.last_seen_at || now - row.last_seen_at > 20_000) {
    await c.env.DB.prepare(`UPDATE ocr_agents SET last_seen_at = ?, last_ip = ?, version = ? WHERE id = ?`)
      .bind(now, clientIp(c), (c.req.header('X-Agent-Version') ?? '').slice(0, 40), row.id)
      .run();
  }
  c.set('agent', { id: row.id, name: row.name });
  await next();
});

/** Used by the first-run setup to check a token (also counts as a heartbeat). */
agent.get('/ping', (c) => c.json({ ok: true, name: c.get('agent').name }));

/** Ask for the next plate. Returns { job: null } when there is nothing to do. */
agent.post('/poll', async (c) => {
  const settings = await getSettings(c.env);
  const now = Date.now();
  const a = c.get('agent');
  const job = await c.env.DB.prepare(
    `UPDATE jobs SET status = 'local_running', agent_id = ?1, next_run_at = ?2 + ?3, attempts = attempts + 1, updated_at = ?2
     WHERE id = (SELECT id FROM jobs WHERE kind = 'ocr'
                   AND (status = 'local' OR (status = 'local_running' AND next_run_at < ?2))
                 ORDER BY created_at LIMIT 1)
     RETURNING id, ref_id, payload, attempts`,
  )
    .bind(a.id, now, LEASE_MS)
    .first<any>();
  const pollSeconds = settings.agentPollSeconds;
  if (!job) return c.json({ job: null, pollSeconds });
  const round = await c.env.DB.prepare(`SELECT public_id FROM rounds WHERE id = ?`).bind(job.ref_id).first<any>();
  return c.json({
    job: { id: job.id, publicId: round?.public_id ?? null, imageUrl: `/api/ocr-agent/jobs/${job.id}/image`, attempt: job.attempts },
    pollSeconds,
  });
});

async function heldJob(c: any) {
  const id = Number(c.req.param('id'));
  const job = await c.env.DB.prepare(`SELECT * FROM jobs WHERE id = ? AND kind = 'ocr'`).bind(id).first();
  if (!job) throw notFound('Job not found.');
  if (job.status !== 'local_running' || job.agent_id !== c.get('agent').id) {
    throw new ApiError(409, 'not_held', 'This job is not leased to this computer (it may have expired).');
  }
  return job;
}

agent.get('/jobs/:id/image', async (c) => {
  const job = await heldJob(c);
  const { imageId } = JSON.parse(job.payload ?? '{}');
  const img = await c.env.DB.prepare(`SELECT * FROM images WHERE id = ?`).bind(imageId).first<any>();
  if (!img) throw notFound('Image not found.');
  const res = await ocrImageResponse(c.env, getDrive(c.env, new URL(c.req.url).origin), img);
  return new Response(res.body, { headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' } });
});

/** Report the result: { text, plate?, confidence? } or { error }. */
agent.post('/jobs/:id/result', async (c) => {
  const job = await heldJob(c);
  const body = await readJson<{ text?: string; plate?: string | null; confidence?: number | null; error?: string }>(c);
  const now = Date.now();
  const a = c.get('agent');
  if (body.error) {
    const dead = job.attempts >= MAX_LOCAL_ATTEMPTS;
    await c.env.DB.batch([
      c.env.DB.prepare(`UPDATE jobs SET status = ?, agent_id = NULL, last_error = ?, next_run_at = ?, updated_at = ? WHERE id = ?`).bind(
        dead ? 'failed' : 'local',
        `${a.name}: ${String(body.error).slice(0, 300)}`,
        now + 30_000,
        now,
        job.id,
      ),
      ...(dead ? [c.env.DB.prepare(`UPDATE rounds SET ocr_status = 'failed' WHERE id = ?`).bind(job.ref_id)] : []),
    ]);
    return c.json({ ok: true, retry: !dead });
  }
  const raw = String(body.text ?? '').slice(0, 2000);
  const parsed = resultFromText(raw, typeof body.confidence === 'number' ? Math.max(0, Math.min(1, body.confidence)) : null);
  // Prefer the agent's own plate parse when it matches the Thai plate pattern.
  const agentPlate = body.plate ? resultFromText(String(body.plate), null).plate : null;
  const result = { ...parsed, plate: agentPlate ?? parsed.plate };
  await applyOcrResult(c.env, getDrive(c.env, new URL(c.req.url).origin), job.ref_id, result, `ocr:local:${a.name}`.slice(0, 60), now);
  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE jobs SET status = 'done', updated_at = ? WHERE id = ?`).bind(now, job.id),
    c.env.DB.prepare(`UPDATE ocr_agents SET jobs_done = jobs_done + 1 WHERE id = ?`).bind(a.id),
  ]);
  return c.json({ ok: true, plate: result.plate });
});
