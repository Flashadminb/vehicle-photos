import { useEffect, useState } from 'react';
import { api } from '../shared/api';
import { formatBangkok } from '../../shared/time';
import type { Role } from '../../shared/types';
import { useMe } from './context';

const ROLE_LABEL: Record<Role, string> = { super_admin: 'Super Admin', admin: 'Admin', reviewer: 'Reviewer', operator: 'Field Operator' };
const ROLE_HELP: Record<Role, string> = {
  super_admin: 'Everything, incl. Drive connection, storage, restoring removed sets, managing admins.',
  admin: 'History, hide/remove, plate correction, workflow & languages, reviewers and operators.',
  reviewer: 'Read-only history, set details and Excel export.',
  operator: 'Field app only. No dashboard access.',
};

export function Members() {
  const me = useMe();
  const [users, setUsers] = useState<any[]>([]);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [form, setForm] = useState({ username: '', displayName: '', role: 'operator' as Role });

  const load = () => api<{ users: any[] }>('GET', '/api/admin/users').then((r) => setUsers(r.users), (e) => setMsg({ ok: false, text: e.message }));
  useEffect(() => void load(), []);

  async function run(fn: () => Promise<any>, ok: (r: any) => string) {
    setMsg(null);
    try {
      const r = await fn();
      setMsg({ ok: true, text: ok(r) });
      await load();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    }
  }

  const canManage = (role: Role) => me.manageableRoles.includes(role);

  return (
    <div className="page">
      <div className="page-head">
        <h1>Members & permissions</h1>
        <span className="muted small">Roles are enforced on the server for every action.</span>
      </div>
      {msg && (
        <p className={`banner ${msg.ok ? 'banner-ok' : 'banner-bad'}`} role="status">
          {msg.text}
        </p>
      )}
      <section className="card section">
        <h2>Add a member</h2>
        <form
          className="form-grid"
          onSubmit={(e) => {
            e.preventDefault();
            void run(
              () => api('POST', '/api/admin/users', form),
              (r) => `Created ${form.username}. Temporary password: ${r.temporaryPassword} — share it privately; they must change it at first sign-in.`,
            );
            setForm({ username: '', displayName: '', role: 'operator' });
          }}
        >
          <label className="field">
            <span>Username</span>
            <input className="input" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} pattern="[A-Za-z0-9._\-]{3,40}" required />
          </label>
          <label className="field">
            <span>Display name</span>
            <input className="input" value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} required />
          </label>
          <label className="field">
            <span>Role</span>
            <select className="input" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as Role })}>
              {me.manageableRoles.map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABEL[r]}
                </option>
              ))}
            </select>
          </label>
          <div className="field">
            <span>&nbsp;</span>
            <button className="btn btn-primary">Create member</button>
          </div>
          <p className="small muted span-all">{ROLE_HELP[form.role]}</p>
        </form>
      </section>

      <section className="card table-card">
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>Member</th>
                <th>Role</th>
                <th>Status</th>
                <th>Last active</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => {
                const editable = canManage(u.role) && u.id !== me.user.id;
                return (
                  <tr key={u.id} className={u.disabled ? 'muted' : ''}>
                    <td>
                      <strong>{u.display_name}</strong>
                      <div className="small muted mono">{u.username}</div>
                    </td>
                    <td>
                      {editable ? (
                        <select className="input input-sm" value={u.role} onChange={(e) => void run(() => api('PATCH', `/api/admin/users/${u.id}`, { role: e.target.value }), () => 'Role changed; their sessions were signed out.')} aria-label={`Role of ${u.username}`}>
                          {me.manageableRoles.map((r) => (
                            <option key={r} value={r}>
                              {ROLE_LABEL[r]}
                            </option>
                          ))}
                        </select>
                      ) : (
                        ROLE_LABEL[u.role as Role]
                      )}
                    </td>
                    <td>
                      <div className="pills">
                        {u.disabled ? <span className="pill pill-bad">Disabled</span> : <span className="pill pill-ok">Active</span>}
                        {u.must_change_password ? <span className="pill pill-warn">Temp password</span> : null}
                        {u.has_pin ? <span className="pill">PIN set</span> : null}
                        {u.active_sessions > 0 && <span className="pill pill-info">{u.active_sessions} session(s)</span>}
                      </div>
                    </td>
                    <td className="small">{u.last_seen_at ? formatBangkok(u.last_seen_at) : '—'}</td>
                    <td>
                      {editable && (
                        <div className="row-actions">
                          <button className="btn btn-sm" onClick={() => confirm(`Reset password for ${u.username}?`) && void run(() => api('POST', `/api/admin/users/${u.id}/reset-password`), (r) => `Temporary password for ${u.username}: ${r.temporaryPassword}`)}>
                            Reset password
                          </button>
                          <button className="btn btn-sm" onClick={() => void run(() => api('POST', `/api/admin/users/${u.id}/revoke-sessions`), () => `Signed ${u.username} out everywhere.`)}>
                            Revoke access
                          </button>
                          <button
                            className="btn btn-sm"
                            onClick={() => {
                              const pin = prompt(`New 4–8 digit PIN for ${u.username} (leave empty to remove):`);
                              if (pin === null) return;
                              void run(() => api('PUT', `/api/admin/users/${u.id}/pin`, { pin: pin.trim() || null }), () => (pin.trim() ? 'PIN set.' : 'PIN removed.'));
                            }}
                          >
                            Set PIN
                          </button>
                          <button
                            className={`btn btn-sm ${u.disabled ? '' : 'btn-danger'}`}
                            onClick={() => void run(() => api('PATCH', `/api/admin/users/${u.id}`, { disabled: !u.disabled }), () => (u.disabled ? 'Member enabled.' : 'Member disabled and signed out.'))}
                          >
                            {u.disabled ? 'Enable' : 'Disable'}
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
