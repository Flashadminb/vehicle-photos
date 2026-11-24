import { useEffect, useState } from 'react';
import { api } from '../shared/api';
import { formatBangkok } from '../../shared/time';
import type { Role } from '../../shared/types';
import { useMe } from './context';

const ROLE_LABEL: Record<Role, string> = { super_admin: 'ผู้ดูแลสูงสุด', admin: 'ผู้ดูแล', reviewer: 'ผู้ตรวจสอบ', operator: 'พนักงานภาคสนาม' };
const ROLE_HELP: Record<Role, string> = {
  super_admin: 'ทำได้ทุกอย่าง รวมถึงเชื่อม Drive, จัดการพื้นที่, กู้คืนชุดที่ลบ และจัดการผู้ดูแล',
  admin: 'ดูประวัติ, ซ่อน/ลบชุด, แก้ทะเบียน, ตั้งค่าขั้นตอนและภาษา, จัดการผู้ตรวจสอบและพนักงาน',
  reviewer: 'ดูประวัติ รายละเอียด และส่งออก Excel ได้อย่างเดียว',
  operator: 'ใช้ได้เฉพาะแอปภาคสนาม เข้าแดชบอร์ดไม่ได้',
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
        <h1>สมาชิกและสิทธิ์</h1>
        <span className="muted small">สิทธิ์ถูกตรวจสอบที่เซิร์ฟเวอร์ทุกครั้ง</span>
      </div>
      {msg && (
        <p className={`banner ${msg.ok ? 'banner-ok' : 'banner-bad'}`} role="status">
          {msg.text}
        </p>
      )}
      <section className="card section">
        <h2>เพิ่มสมาชิก</h2>
        <form
          className="form-grid"
          onSubmit={(e) => {
            e.preventDefault();
            void run(
              () => api('POST', '/api/admin/users', form),
              (r) => `สร้าง ${form.username} แล้ว รหัสผ่านชั่วคราว: ${r.temporaryPassword} — ส่งให้เจ้าตัวแบบส่วนตัว และต้องเปลี่ยนรหัสเมื่อเข้าระบบครั้งแรก`,
            );
            setForm({ username: '', displayName: '', role: 'operator' });
          }}
        >
          <label className="field">
            <span>ชื่อผู้ใช้</span>
            <input className="input" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} pattern="[A-Za-z0-9._\-]{3,40}" required />
          </label>
          <label className="field">
            <span>ชื่อที่แสดง</span>
            <input className="input" value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} required />
          </label>
          <label className="field">
            <span>บทบาท</span>
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
            <button className="btn btn-primary">สร้างสมาชิก</button>
          </div>
          <p className="small muted span-all">{ROLE_HELP[form.role]}</p>
        </form>
      </section>

      <section className="card table-card">
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>สมาชิก</th>
                <th>บทบาท</th>
                <th>สถานะ</th>
                <th>ใช้งานล่าสุด</th>
                <th>การจัดการ</th>
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
                        <select className="input input-sm" value={u.role} onChange={(e) => void run(() => api('PATCH', `/api/admin/users/${u.id}`, { role: e.target.value }), () => 'เปลี่ยนบทบาทแล้ว และออกจากระบบทุกอุปกรณ์ของผู้ใช้นี้')} aria-label={`บทบาทของ ${u.username}`}>
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
                        {u.disabled ? <span className="pill pill-bad">ปิดใช้งาน</span> : <span className="pill pill-ok">ใช้งานอยู่</span>}
                        {u.must_change_password ? <span className="pill pill-warn">รหัสผ่านชั่วคราว</span> : null}
                        {u.has_pin ? <span className="pill">ตั้ง PIN แล้ว</span> : null}
                        {u.active_sessions > 0 && <span className="pill pill-info">เข้าระบบอยู่ {u.active_sessions} อุปกรณ์</span>}
                      </div>
                    </td>
                    <td className="small">{u.last_seen_at ? formatBangkok(u.last_seen_at) : '—'}</td>
                    <td>
                      {editable && (
                        <div className="row-actions">
                          <button className="btn btn-sm" onClick={() => confirm(`รีเซ็ตรหัสผ่านของ ${u.username}?`) && void run(() => api('POST', `/api/admin/users/${u.id}/reset-password`), (r) => `รหัสผ่านชั่วคราวของ ${u.username}: ${r.temporaryPassword}`)}>
                            รีเซ็ตรหัสผ่าน
                          </button>
                          <button className="btn btn-sm" onClick={() => void run(() => api('POST', `/api/admin/users/${u.id}/revoke-sessions`), () => `ออกจากระบบ ${u.username} ทุกอุปกรณ์แล้ว`)}>
                            เพิกถอนการเข้าถึง
                          </button>
                          <button
                            className="btn btn-sm"
                            onClick={() => {
                              const pin = prompt(`PIN ใหม่ 4–8 หลักสำหรับ ${u.username} (เว้นว่างเพื่อลบ PIN):`);
                              if (pin === null) return;
                              void run(() => api('PUT', `/api/admin/users/${u.id}/pin`, { pin: pin.trim() || null }), () => (pin.trim() ? 'ตั้ง PIN แล้ว' : 'ลบ PIN แล้ว'));
                            }}
                          >
                            ตั้ง PIN
                          </button>
                          <button
                            className={`btn btn-sm ${u.disabled ? '' : 'btn-danger'}`}
                            onClick={() => void run(() => api('PATCH', `/api/admin/users/${u.id}`, { disabled: !u.disabled }), () => (u.disabled ? 'เปิดใช้งานสมาชิกแล้ว' : 'ปิดใช้งานและออกจากระบบแล้ว'))}
                          >
                            {u.disabled ? 'เปิดใช้งาน' : 'ปิดใช้งาน'}
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
