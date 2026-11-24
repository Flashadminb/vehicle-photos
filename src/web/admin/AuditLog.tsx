import { useEffect, useState } from 'react';
import { api } from '../shared/api';
import { formatBangkok } from '../../shared/time';

export function AuditLog() {
  const [rows, setRows] = useState<any[]>([]);
  const [stack, setStack] = useState<(number | null)[]>([null]);
  const [next, setNext] = useState<number | null>(null);
  const [action, setAction] = useState('');
  const [error, setError] = useState('');

  const before = stack[stack.length - 1];
  useEffect(() => {
    const p = new URLSearchParams({ pageSize: '50' });
    if (before) p.set('before', String(before));
    if (action) p.set('action', action);
    api('GET', `/api/admin/audit?${p}`).then(
      (r) => {
        setRows(r.rows);
        setNext(r.nextBefore);
      },
      (e) => setError(e.message),
    );
  }, [before, action]);

  return (
    <div className="page">
      <div className="page-head">
        <h1>บันทึกการใช้งาน</h1>
        <span className="muted small">ทุกการเปลี่ยนแปลงโดยผู้ดูแล เรียงจากล่าสุด</span>
      </div>
      <section className="card table-card">
        <div className="table-toolbar">
          <label className="field-inline small">
            ประเภท
            <select
              className="input input-sm"
              value={action}
              onChange={(e) => {
                setAction(e.target.value);
                setStack([null]);
              }}
            >
              <option value="">ทั้งหมด</option>
              <option value="set.">ชุดรูป</option>
              <option value="user.">สมาชิก</option>
              <option value="workflow.">ขั้นตอนการถ่าย</option>
              <option value="translations.">คำแปล</option>
              <option value="settings.">การตั้งค่า</option>
              <option value="drive.">Drive</option>
              <option value="sets.export">การส่งออก</option>
              <option value="admin.login">การเข้าระบบ</option>
            </select>
          </label>
        </div>
        {error && <p className="banner banner-bad">{error}</p>}
        <div className="table-scroll">
          <table className="table table-compact">
            <thead>
              <tr>
                <th>เวลา</th>
                <th>ผู้ทำ</th>
                <th>การกระทำ</th>
                <th>เป้าหมาย</th>
                <th>รายละเอียด</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="nowrap">{formatBangkok(r.at)}</td>
                  <td>{r.actor_name ?? 'ระบบ'}</td>
                  <td className="mono small">{r.action}</td>
                  <td className="mono small">{r.target_type ? `${r.target_type}:${r.target_id ?? ''}` : ''}</td>
                  <td className="small details-cell">{r.details}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <nav className="pager">
          <button className="btn btn-sm" disabled={stack.length <= 1} onClick={() => setStack((s) => s.slice(0, -1))}>‹ ใหม่กว่า</button>
          <button className="btn btn-sm" disabled={!next} onClick={() => setStack((s) => [...s, next])}>เก่ากว่า ›</button>
        </nav>
      </section>
    </div>
  );
}
