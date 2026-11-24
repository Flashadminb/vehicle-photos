import { describe, expect, it } from 'vitest';
import { Client, createUser, loggedIn, testEnv } from './helpers';

describe('authentication & role enforcement', () => {
  it('field users cannot access administrator APIs', async () => {
    const { client } = await loggedIn('field', 'operator');
    // Field cookie is path-scoped to /api/field, so admin APIs see no session at all...
    expect((await client.json('GET', '/api/admin/sets')).status).toBe(401);
    // ...and even forging the cookie onto the admin path is rejected (wrong session kind).
    const fieldCookie = client.cookies.get('vp_field')!;
    const forged = new Client();
    forged.cookies.set('vp_admin', { value: fieldCookie.value, path: '/api/admin' });
    expect((await forged.json('GET', '/api/admin/sets')).status).toBe(401);
    expect((await forged.json('GET', '/api/admin/users')).status).toBe(401);
  });

  it('operators cannot sign in to the dashboard', async () => {
    const { username, password } = await createUser('operator');
    const r = await new Client().json('POST', '/api/admin/login', { username, password });
    expect(r.status).toBe(403);
  });

  it('reviewers can view history but cannot hide sets or manage users', async () => {
    const { client } = await loggedIn('admin', 'reviewer');
    expect((await client.json('GET', '/api/admin/sets')).status).toBe(200);
    expect((await client.json('POST', '/api/admin/sets/x/hide')).status).toBe(403);
    expect((await client.json('GET', '/api/admin/users')).status).toBe(403);
    expect((await client.json('PUT', '/api/admin/settings', { unknownPlateLabel: 'x' })).status).toBe(403);
  });

  it('admins cannot create super admins', async () => {
    const { client } = await loggedIn('admin', 'admin');
    const r = await client.json('POST', '/api/admin/users', { username: 'evil_su', displayName: 'x', role: 'super_admin' });
    expect(r.status).toBe(403);
  });

  it('mutations without the client header are rejected (CSRF defence)', async () => {
    const { client } = await loggedIn('admin', 'super_admin');
    const r = await client.json('PUT', '/api/admin/settings', { unknownPlateLabel: 'x' }, { 'X-VP-Client': '0' });
    expect(r.status).toBe(403);
  });

  it('disabling a user revokes their sessions immediately', async () => {
    const op = await loggedIn('field', 'operator');
    const { client: su } = await loggedIn('admin', 'super_admin');
    expect((await op.client.json('GET', '/api/field/bootstrap')).status).toBe(200);
    expect((await su.json('PATCH', `/api/admin/users/${op.user.id}`, { disabled: true })).status).toBe(200);
    expect((await op.client.json('GET', '/api/field/bootstrap')).status).toBe(401);
  });

  it('password reset issues a temporary password and forces a change', async () => {
    const { user } = await createUser('operator');
    const { client: su } = await loggedIn('admin', 'super_admin');
    const r = await su.json('POST', `/api/admin/users/${user.id}/reset-password`);
    expect(r.status).toBe(200);
    const c = new Client();
    const login = await c.json('POST', '/api/field/login', { username: user.username, password: r.body.temporaryPassword });
    expect(login.status).toBe(200);
    expect(login.body.user.mustChangePassword).toBe(true);
  });

  it('locks login after repeated failures', async () => {
    const { username } = await createUser('operator');
    const c = new Client();
    for (let i = 0; i < 5; i++) {
      expect((await c.json('POST', '/api/field/login', { username, password: 'wrong-password' })).status).toBe(401);
    }
    expect((await c.json('POST', '/api/field/login', { username, password: 'wrong-password' })).status).toBe(429);
    await testEnv.DB.prepare(`DELETE FROM login_attempts`).run();
  });
});
