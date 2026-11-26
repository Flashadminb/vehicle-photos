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
  const [form, setForm] = useState({ username: '', displayName: '', role: 'operator' as Role, workflowId: 'default', password: '' });
  /** Login details to hand over after creating / resetting a member (shown once). */
  const [cred, setCred] = useState<{ username: string; password: string } | null>(null);
  const [profiles, setProfiles] = useState<{ id: string; name: string }[]>([]);

  const load = () => api<{ users: any[] }>('GET', '/api/admin/users').then((r) => setUsers(r.users), (e) => setMsg({ ok: false, text: e.message }));
  useEffect(() => {
    void load();
    api<{ profiles: { id: string; name: string }[] }>('GET', '/api/admin/workflows').then((r) => setProfiles(r.profiles), () => undefined);
  }, []);
  /** Roles that use the field app (and so a capture profile). */
  const capturing = (role: Role) => role !== 'reviewer';

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
      {cred && (
        <section className="card section cred-card" aria-live="polite">
          <h2>ข้อมูลเข้าระบบ (แสดงครั้งเดียว)</h2>
          <dl>
            <dt>ลิงก์แอปหน้างาน</dt>
            <dd className="mono">{location.origin}/</dd>
            <dt>ชื่อผู้ใช้</dt>
            <dd className="mono cred-big">{cred.username}</dd>
            <dt>รหัสผ่าน</dt>
            <dd className="mono cred-big">{cred.password}</dd>
          </dl>
          <p className="small muted">ตัวพิมพ์เล็กทั้งหมด ไม่มีเลข 0/1 หรือตัว o/l ให้สับสน · เจ้าตัวต้องตั้งรหัสใหม่เมื่อเข้าครั้งแรก · ส่งแบบส่วนตัวเท่านั้น</p>
          <div className="details-actions">
            <button
              className="btn btn-primary"
              onClick={() => void navigator.clipboard?.writeText(`แอปถ่ายรูปรถ: ${location.origin}/\nชื่อผู้ใช้: ${cred.username}\nรหัสผ่าน: ${cred.password}`).then(() => setMsg({ ok: true, text: 'คัดลอกแล้ว วางส่งในแชทส่วนตัวได้เลย' }))}
            >
              คัดลอกข้อความสำหรับส่ง
            </button>
            <button className="btn" onClick={() => setCred(null)}>ปิด</button>
          </div>
        </section>
      )}
      <section className="card section">
        <h2>เพิ่มสมาชิก</h2>
        <form
          className="form-grid"
          onSubmit={(e) => {
            e.preventDefault();
            void run(
              () => api('POST', '/api/admin/users', { ...form, password: form.password || undefined }),
              (r) => {
                setCred({ username: r.username, password: r.temporaryPassword });
                return `สร้าง ${r.username} แล้ว`;
              },
            );
            setForm({ username: '', displayName: '', role: 'operator', workflowId: form.workflowId, password: '' });
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
          {profiles.length > 1 && capturing(form.role) && (
            <label className="field">
              <span>รูปแบบการถ่าย</span>
              <select className="input" value={form.workflowId} onChange={(e) => setForm({ ...form, workflowId: e.target.value })}>
                {profiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="field">
            <span>รหัสผ่านเริ่มต้น (ไม่บังคับ)</span>
            <input className="input" value={form.password} minLength={8} placeholder="เว้นว่าง = สุ่มให้" autoComplete="off" onChange={(e) => setForm({ ...form, password: e.target.value })} />
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
                {profiles.length > 1 && <th>รูปแบบการถ่าย</th>}
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
                    {profiles.length > 1 && (
                      <td>
                        {!capturing(u.role) ? (
                          <span className="muted">—</span>
                        ) : canManage(u.role) ? (
                          <select
                            className="input input-sm"
                            value={u.workflow_id ?? 'default'}
                            onChange={(e) =>
                              void run(
                                () => api('PATCH', `/api/admin/users/${u.id}`, { workflowId: e.target.value }),
                                () => `${u.display_name} ใช้รูปแบบ “${profiles.find((p) => p.id === e.target.value)?.name}” แล้ว (มีผลกับรอบถัดไป หลังเปิดแอปใหม่)`,
                              )
                            }
                            aria-label={`รูปแบบการถ่ายของ ${u.username}`}
                          >
                            {profiles.map((p) => (
                              <option key={p.id} value={p.id}>
                                {p.name}
                              </option>
                            ))}
                          </select>
                        ) : (
                          profiles.find((p) => p.id === u.workflow_id)?.name ?? 'ทั่วไป'
                        )}
                      </td>
                    )}
                    <td>
                      <div className="pills">
                        {u.disabled ? <span className="pill pill-bad">ปิดใช้งาน</span> : <span className="pill pill-ok">ใช้งานอยู่</span>}
                        {u.must_change_password ? <span className="pill pill-warn">รหัสผ่านชั่วคราว</span> : null}
                        {u.has_pin ? <span className="pill">ตั้ง PIN แล้ว</span> : null}
                        {u.online_sessions > 0 && (
                          <span className="pill pill-ok" title="เปิดแอปอยู่ภายใน ~10 นาทีที่ผ่านมา">
                            <span className="dot-online" aria-hidden /> ออนไลน์ตอนนี้ {u.online_sessions} อุปกรณ์
                          </span>
                        )}
                        {u.active_sessions > 0 && (
                          <span className="pill" title="จำนวนอุปกรณ์ที่ยังล็อกอินค้างไว้ (รวมที่ปิดแอปไปแล้ว) กด “เพิกถอนการเข้าถึง” เพื่อออกจากระบบทุกเครื่อง">
                            ล็อกอินค้างไว้ {u.active_sessions} อุปกรณ์
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="small">{u.last_seen_at ? formatBangkok(u.last_seen_at) : '—'}</td>
                    <td>
                      {editable && (
                        <div className="row-actions">
                          <button
                            className="btn btn-sm"
                            onClick={() => {
                              const pw = prompt(`รีเซ็ตรหัสผ่านของ ${u.username}\n\nพิมพ์รหัสใหม่เอง (อย่างน้อย 8 ตัว) หรือเว้นว่างแล้วกด OK เพื่อให้ระบบสุ่มให้\n(เจ้าตัวต้องเปลี่ยนรหัสเมื่อเข้าระบบครั้งแรก)`, '');
                              if (pw == null) return;
                              void run(
                                () => api('POST', `/api/admin/users/${u.id}/reset-password`, pw.trim() ? { password: pw.trim() } : {}),
                                (r) => {
                                  setCred({ username: r.username, password: r.temporaryPassword });
                                  return `ตั้งรหัสผ่านใหม่ให้ ${u.username} แล้ว`;
                                },
                              );
                            }}
                          >
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
                          <button
                            className="btn btn-sm btn-danger"
                            title="ลบบัญชีถาวร (ย้อนกลับไม่ได้)"
                            onClick={() => {
                              const typed = prompt(
                                `ลบ “${u.display_name}” ถาวร — ย้อนกลับไม่ได้\n\n` +
                                  `• บัญชี รหัสผ่าน PIN และการเข้าระบบทุกเครื่องถูกลบ ชื่อผู้ใช้นำไปใช้ใหม่ได้\n` +
                                  `• ชุดรูปที่คนนี้เคยถ่ายยังอยู่ในประวัติ (แสดงชื่อเดิม) รูปใน Drive ไม่ถูกแตะ\n\n` +
                                  `พิมพ์ชื่อผู้ใช้ “${u.username}” เพื่อยืนยัน`,
                              );
                              if (typed == null) return;
                              void run(
                                () => api('DELETE', `/api/admin/users/${u.id}`, { confirm: typed }),
                                () => `ลบ ${u.display_name} ถาวรแล้ว`,
                              );
                            }}
                          >
                            ลบถาวร
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
