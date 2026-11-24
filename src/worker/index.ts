import { Hono } from 'hono';
import type { AppBindings, Env } from './env';
import { field } from './routes/field';
import { admin } from './routes/admin';
import { ApiError, badRequest, errorResponse, readJson, str, uuid } from './util';
import { createPasswordHash, validateNewPassword } from './auth/session';
import { DemoDrive } from './drive/demo';
import { isDemo } from './drive';
import { scheduled } from './services/maintenance';
import { audit } from './services/audit';

export const app = new Hono<AppBindings>();

app.use('/api/*', async (c, next) => {
  await next();
  c.header('Cache-Control', c.res.headers.get('Cache-Control') ?? 'no-store');
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', 'same-origin');
});

app.use('/api/*', async (c, next) => {
  if (isDemo(c.env)) await ensureDemoUsers(c.env);
  await next();
});

app.onError((err, c) => errorResponse(c, err));

app.get('/api/health', (c) => c.json({ ok: true, mode: isDemo(c.env) ? 'demo' : 'google', time: Date.now() }));

/** Whether the first Super Admin still has to be created (reveals nothing else). */
app.get('/api/setup/status', async (c) => {
  const n = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM users`).first<{ n: number }>();
  return c.json({ needed: (n?.n ?? 0) === 0, tokenConfigured: !!c.env.SETUP_TOKEN });
});

/**
 * First-run setup: creates the first Super Admin. Requires the SETUP_TOKEN secret and
 * only works while there are no users, so it cannot be used to take over a live system.
 */
app.post('/api/setup', async (c) => {
  const body = await readJson<{ token: string; username: string; displayName: string; password: string }>(c);
  if (!c.env.SETUP_TOKEN || body.token !== c.env.SETUP_TOKEN) throw new ApiError(403, 'forbidden', 'Setup token ไม่ถูกต้อง');
  const count = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM users`).first<{ n: number }>();
  if ((count?.n ?? 0) > 0) throw new ApiError(409, 'already_setup', 'ตั้งค่าครั้งแรกไปแล้ว');
  const now = Date.now();
  const id = uuid();
  const username = str(body.username, 'username', { min: 3, max: 40 });
  if (!/^[a-zA-Z0-9._-]+$/.test(username)) throw badRequest('Invalid username.');
  await c.env.DB.prepare(
    `INSERT INTO users (id, username, display_name, role, password_hash, created_at, updated_at) VALUES (?, ?, ?, 'super_admin', ?, ?, ?)`,
  )
    .bind(id, username, str(body.displayName, 'displayName', { max: 80 }), await createPasswordHash(c.env, validateNewPassword(body.password)), now, now)
    .run();
  await audit(c.env, { id, displayName: body.displayName }, 'setup.super_admin_created', { type: 'user', id });
  return c.json({ ok: true });
});

/** DEMO MODE ONLY: receives browser uploads that would go to Google Drive in production. */
app.put('/api/demo-drive/upload/:sessionId', async (c) => {
  if (!isDemo(c.env)) throw new ApiError(404, 'not_found', 'Not found.');
  const body = await c.req.arrayBuffer();
  if (body.byteLength > 20 * 1024 * 1024) throw badRequest('File too large.');
  const res = await DemoDrive.receiveUpload(c.env, c.req.param('sessionId'), body);
  if (!res) throw new ApiError(404, 'not_found', 'Upload session not found.');
  return c.json(res);
});

app.route('/api/field', field);
app.route('/api/admin', admin);

app.all('/api/*', (c) => c.json({ error: { code: 'not_found', message: 'Not found.' } }, 404));

// Static assets (field app at /, dashboard at /admin/) are served by Workers Static Assets.
app.all('*', async (c) => {
  if (c.env.ASSETS) return c.env.ASSETS.fetch(c.req.raw);
  return c.text('Not found', 404);
});

let demoUsersChecked = false;
/** DEMO MODE ONLY: create clearly-labelled demo accounts on first use. */
async function ensureDemoUsers(env: Env) {
  if (demoUsersChecked) return;
  const n = await env.DB.prepare(`SELECT COUNT(*) AS n FROM users`).first<{ n: number }>();
  if ((n?.n ?? 0) === 0) {
    const now = Date.now();
    const users: [string, string, string, string][] = [
      ['admin', 'Demo Super Admin', 'super_admin', 'demo-admin-1234'],
      ['reviewer', 'Demo Reviewer', 'reviewer', 'demo-review-1234'],
      ['operator', 'Demo Operator', 'operator', 'demo-op-1234'],
      ['operator2', 'Demo Operator 2', 'operator', 'demo-op-1234'],
    ];
    for (const [username, name, role, pw] of users) {
      await env.DB.prepare(
        `INSERT OR IGNORE INTO users (id, username, display_name, role, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind(uuid(), username, name, role, await createPasswordHash(env, pw), now, now)
        .run();
    }
  }
  demoUsersChecked = true;
}

export function resetDemoFlag() {
  demoUsersChecked = false;
}

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(scheduled(env));
  },
} satisfies ExportedHandler<Env>;
