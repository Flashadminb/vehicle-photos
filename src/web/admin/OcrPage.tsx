import { useEffect, useState } from 'react';
import { api } from '../shared/api';
import type { AppSettings, OcrProvider } from '../../shared/types';
import { formatBangkok } from '../../shared/time';
import { useMe } from './context';

const MODES: { value: OcrProvider; title: string; desc: string }[] = [
  { value: 'none', title: 'ปิด', desc: 'ไม่อ่านป้ายอัตโนมัติ ผู้ดูแลกรอกทะเบียนเองในหน้ารายละเอียด' },
  { value: 'vision_then_local', title: 'Google Vision ก่อน → Local OCR เมื่อโควต้าเต็ม', desc: 'ใช้ Vision จนถึงเพดานที่ตั้ง (เช่น 90%) จากนั้นป้ายที่เหลือรอให้คอม Local OCR อ่าน' },
  { value: 'local_then_vision', title: 'Local OCR ก่อน → Google Vision เมื่อไม่มีคอมเปิด', desc: 'ถ้ามีคอมเปิดอยู่ ให้คอมอ่าน (ประหยัดโควต้า Vision) ถ้าไม่มีคอมเปิด ใช้ Vision ภายในเพดาน' },
  { value: 'local', title: 'Local OCR อย่างเดียว', desc: 'ใช้แต่คอมในออฟฟิศ ไม่มีค่าใช้จ่าย ป้ายจะรอจนกว่ามีคอมเปิด' },
  { value: 'google_vision', title: 'Google Vision อย่างเดียว', desc: 'เมื่อถึงเพดาน ป้ายจะพักไว้จนเดือนใหม่ (หรือกดส่งให้ Local OCR)' },
];

/** "ocr:local:PC-ออฟฟิศ" → "Local OCR · PC-ออฟฟิศ" */
export function ocrSourceLabel(source: string): string {
  if (source === 'ocr:google_vision') return 'Google Vision';
  if (source === 'ocr:aiforthai') return 'AI for Thai';
  if (source.startsWith('ocr:local:')) return `Local OCR · ${source.slice(10)}`;
  if (source === 'ocr') return 'OCR';
  return source;
}

const QUEUE_LABEL: Record<string, string> = {
  pending: 'รอเริ่ม',
  running: 'กำลังส่ง Vision',
  local: 'รอคอม Local OCR',
  local_running: 'คอมกำลังอ่าน',
  wait_quota: 'พักไว้ (Vision เต็ม)',
  failed: 'ล้มเหลว',
};

export function OcrPage() {
  const me = useMe();
  const [st, setSt] = useState<any>(null);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [newName, setNewName] = useState('');
  const [newToken, setNewToken] = useState<{ name: string; token: string } | null>(null);
  const canManage = me.can('drive.manage');

  async function load() {
    const [s, cfg] = await Promise.all([api('GET', '/api/admin/ocr/status'), me.can('config.edit') ? api<AppSettings>('GET', '/api/admin/settings') : Promise.resolve(null)]);
    setSt(s);
    setSettings(cfg);
  }
  useEffect(() => {
    void load().catch((e) => setMsg({ ok: false, text: e.message }));
    const t = setInterval(() => void load().catch(() => undefined), 15_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function save(patch: Partial<AppSettings>) {
    setMsg(null);
    try {
      setSettings(await api('PUT', '/api/admin/settings', patch));
      setMsg({ ok: true, text: 'บันทึกแล้ว' });
      await load();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    }
  }

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

  if (!st) return <div className="page"><span className="spinner" /></div>;
  const pct = st.vision.cap ? Math.min(100, (st.vision.used / st.vision.cap) * 100) : 0;
  const waiting = (st.queue.local ?? 0) + (st.queue.wait_quota ?? 0) + (st.queue.failed ?? 0) + (st.queue.pending ?? 0);
  const online = st.agents.filter((a: any) => a.online).length;
  const usesVision = ['google_vision', 'vision_then_local', 'local_then_vision'].includes(st.mode);

  return (
    <div className="page">
      <div className="page-head">
        <h1>อ่านป้ายทะเบียน (OCR)</h1>
        <span className="muted small">อ่านป้ายเบื้องหลังหลังรูปป้ายอัปโหลดเสร็จ ไม่ทำให้การถ่ายช้า ผู้ดูแลแก้ทะเบียนเองได้เสมอ และการแก้มือจะไม่ถูก OCR ทับ</span>
      </div>
      {msg && <p className={`banner ${msg.ok ? 'banner-ok' : 'banner-bad'}`}>{msg.text}</p>}

      <section className="card section">
        <h2>โหมดการอ่าน</h2>
        <div className="mode-list">
          {MODES.map((m) => (
            <label key={m.value} className={`mode-item ${st.mode === m.value ? 'is-active' : ''}`}>
              <input type="radio" name="ocr-mode" checked={st.mode === m.value} disabled={!canManage} onChange={() => void save({ ocrProvider: m.value })} />
              <span>
                <strong>{m.title}</strong>
                <span className="small muted">{m.desc}</span>
              </span>
            </label>
          ))}
        </div>
        {!canManage && <p className="small muted">เฉพาะผู้ดูแลสูงสุดเปลี่ยนโหมดได้</p>}
      </section>

      <div className="grid-2">
        <section className="card section">
          <h2>Google Vision — เดือน {st.vision.period}</h2>
          {!st.visionKeyConfigured && <p className="banner banner-warn small">ยังไม่ได้ใส่ GOOGLE_VISION_API_KEY (ใส่ใน GitHub secrets แล้วรัน Deploy ใหม่)</p>}
          <div className="meter-block">
            <div className="meter-label">
              <span>ใช้ไปเดือนนี้</span>
              <span className={pct >= 100 ? 'text-bad' : 'muted'}>
                {st.vision.used.toLocaleString()} / {st.vision.cap.toLocaleString()} ครั้ง (เพดาน {st.vision.capPct}% ของฟรี {st.vision.free.toLocaleString()})
              </span>
            </div>
            <div className="meter" role="meter" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100} aria-label="โควต้า Vision">
              <div className={`meter-fill ${pct >= 100 ? 'is-over' : ''}`} style={{ width: `${pct}%` }} />
            </div>
          </div>
          <p className="small muted">
            ระบบหยุดเรียก Vision ทันทีที่ถึงเพดาน (นับแบบกันชนกันได้ จึงไม่มีทางเกิน) เริ่มนับใหม่ทุกต้นเดือน (เวลา UTC) {!usesVision && '· โหมดปัจจุบันไม่ได้ใช้ Vision'}
          </p>
          {canManage && settings && (
            <div className="form-grid">
              <label className="field">
                <span>ฟรีต่อเดือน (ครั้ง)</span>
                <input className="input" type="number" min={0} defaultValue={settings.visionMonthlyFree} onBlur={(e) => Number(e.target.value) !== settings.visionMonthlyFree && void save({ visionMonthlyFree: Number(e.target.value) })} />
              </label>
              <label className="field">
                <span>ใช้ได้ถึง (% ของฟรี)</span>
                <input className="input" type="number" min={1} max={100} defaultValue={settings.visionCapPct} onBlur={(e) => Number(e.target.value) !== settings.visionCapPct && void save({ visionCapPct: Number(e.target.value) })} />
              </label>
            </div>
          )}
        </section>

        <section className="card section">
          <h2>คิวป้ายที่รออ่าน</h2>
          {Object.keys(st.queue).length === 0 ? (
            <p className="muted">ไม่มีป้ายค้าง ✓</p>
          ) : (
            <ul className="queue-list">
              {Object.entries(st.queue).map(([k, n]) => (
                <li key={k}>
                  <span>{QUEUE_LABEL[k] ?? k}</span>
                  <strong>{String(n)}</strong>
                </li>
              ))}
            </ul>
          )}
          {me.can('sets.editPlate') && (
            <button
              className="btn btn-primary"
              disabled={waiting === 0}
              onClick={() => void run(() => api('POST', '/api/admin/ocr/send-to-local'), (r) => `ส่งให้ Local OCR แล้ว ${r.moved} ป้าย${online ? '' : ' — ตอนนี้ยังไม่มีคอมเปิด ป้ายจะรอจนกว่ามีคอมเปิด'}`)}
            >
              ส่งงานที่ค้างให้ Local OCR
            </button>
          )}
          <p className="small muted">ส่งป้ายที่พักไว้เพราะ Vision เต็ม ป้ายที่ล้มเหลว และป้ายที่ยังไม่เริ่ม ไปให้คอม Local OCR อ่าน</p>
        </section>
      </div>

      <section className="card section">
        <div className="section-head">
          <h2>คอม Local OCR</h2>
          <span className={`pill ${online ? 'pill-ok' : 'pill-warn'}`}>เปิดอยู่ {online} เครื่อง</span>
        </div>
        <p className="small muted">
          เปิดคอมเครื่องไหนก็ได้ที่ติดตั้งโปรแกรมไว้ เครื่องจะมารับป้ายไปอ่านเอง มีกี่เครื่องก็ได้ ระบบไม่ให้สองเครื่องอ่านป้ายเดียวกัน ถ้าปิดเครื่องกลางคัน เครื่องอื่นจะรับต่อภายใน 5 นาที
        </p>
        <div className="table-scroll">
          <table className="table table-compact">
            <thead>
              <tr>
                <th>เครื่อง</th>
                <th>สถานะ</th>
                <th>ติดต่อล่าสุด</th>
                <th>กำลังอ่าน</th>
                <th>อ่านไปแล้ว</th>
                <th>เวอร์ชัน</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {st.agents.map((a: any) => (
                <tr key={a.id} className={a.disabled ? 'muted' : ''}>
                  <td><strong>{a.name}</strong></td>
                  <td>{a.disabled ? <span className="pill">ปิดใช้งาน</span> : a.online ? <span className="pill pill-ok">● เปิดอยู่</span> : <span className="pill">ออฟไลน์</span>}</td>
                  <td className="small">{a.last_seen_at ? formatBangkok(a.last_seen_at) : 'ยังไม่เคยเชื่อมต่อ'}</td>
                  <td>{a.working ? <span className="pill pill-info"><span className="spinner" aria-hidden /> {a.working}</span> : <span className="muted small">ว่าง</span>}</td>
                  <td>{a.jobs_done.toLocaleString()} ป้าย</td>
                  <td className="small mono">{a.version ?? ''}</td>
                  <td>
                    {canManage && (
                      <div className="row-actions">
                        <button className="btn btn-sm" onClick={() => void run(() => api('PATCH', `/api/admin/ocr/agents/${a.id}`, { disabled: !a.disabled }), () => (a.disabled ? 'เปิดใช้งานแล้ว' : 'ปิดใช้งานแล้ว'))}>
                          {a.disabled ? 'เปิดใช้งาน' : 'ปิดใช้งาน'}
                        </button>
                        <button className="btn btn-sm btn-danger" onClick={() => confirm(`ลบเครื่อง ${a.name}? token ของเครื่องนี้จะใช้ไม่ได้อีก`) && void run(() => api('DELETE', `/api/admin/ocr/agents/${a.id}`), () => 'ลบเครื่องแล้ว')}>
                          ลบ
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
              {st.agents.length === 0 && (
                <tr>
                  <td colSpan={7} className="empty">ยังไม่มีคอม Local OCR</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {canManage && settings && (
          <div className="form-grid">
            <label className="field">
              <span>คอมที่ว่างถามหางานทุก (วินาที)</span>
              <input className="input" type="number" min={10} max={600} defaultValue={settings.agentPollSeconds} onBlur={(e) => Number(e.target.value) !== settings.agentPollSeconds && void save({ agentPollSeconds: Number(e.target.value) })} />
            </label>
            <p className="small muted span-all">
              โควต้า: เครื่องละประมาณ {Math.round(86400 / settings.agentPollSeconds).toLocaleString()} ครั้ง/วัน ถ้าเปิด 24 ชม. (จาก 100,000 ครั้ง/วันของ Workers ฟรี)
              {st.agents.length > 0 && ` · ${st.agents.filter((a: any) => !a.disabled).length} เครื่อง ≈ ${Math.round(((86400 / settings.agentPollSeconds) * st.agents.filter((a: any) => !a.disabled).length) / 1000)}% ของโควต้า`}
              {' '}— ถ้ามีมากกว่า 5 เครื่อง แนะนำตั้ง 60 วินาที (ป้ายจะถูกอ่านช้าลงไม่เกิน 1 นาที)
            </p>
          </div>
        )}
        {canManage && (
          <form
            className="inline-form"
            onSubmit={(e) => {
              e.preventDefault();
              const name = newName.trim();
              void run(
                async () => {
                  const r = await api('POST', '/api/admin/ocr/agents', { name });
                  setNewToken({ name, token: r.token });
                  return r;
                },
                () => `เพิ่มเครื่อง ${name} แล้ว — คัดลอก token ด้านล่างไปใส่ในคอมเครื่องนั้น`,
              );
              setNewName('');
            }}
          >
            <input className="input" placeholder="ชื่อเครื่อง เช่น PC-ออฟฟิศ" value={newName} onChange={(e) => setNewName(e.target.value)} required maxLength={40} aria-label="ชื่อเครื่อง" />
            <button className="btn">+ เพิ่มเครื่อง</button>
          </form>
        )}
        {newToken && (
          <div className="sub-card">
            <strong>config.json สำหรับ {newToken.name}</strong>
            <p className="small muted">token นี้แสดงครั้งเดียว ให้คัดลอกทั้งหมดไปวางในไฟล์ <code>config.json</code> ในโฟลเดอร์โปรแกรมบนคอมเครื่องนั้น</p>
            <pre className="raw">{JSON.stringify({ server: location.origin, token: newToken.token, minConfidence: 0.6 }, null, 2)}</pre>
            <div className="row-actions">
              <button className="btn btn-sm" onClick={() => void navigator.clipboard.writeText(JSON.stringify({ server: location.origin, token: newToken.token, minConfidence: 0.6 }, null, 2))}>คัดลอก</button>
              <button className="btn btn-sm" onClick={() => setNewToken(null)}>ปิด</button>
            </div>
          </div>
        )}
      </section>

      <section className="card section">
        <h2>ผลการอ่านล่าสุด</h2>
        <p className="small muted">ใครอ่านป้ายไหน: Google Vision หรือคอมเครื่องไหน (อัปเดตทุก 15 วินาที)</p>
        <div className="table-scroll">
          <table className="table table-compact">
            <thead>
              <tr>
                <th>เวลา</th>
                <th>ชุด</th>
                <th>ผลที่อ่านได้</th>
                <th>ความมั่นใจ</th>
                <th>อ่านโดย</th>
              </tr>
            </thead>
            <tbody>
              {st.recent.map((r: any, i: number) => (
                <tr key={i}>
                  <td className="nowrap small">{formatBangkok(r.at)}</td>
                  <td className="mono small">{r.public_id}</td>
                  <td>{r.new_text ? <strong>{r.new_text}</strong> : <span className="muted">อ่านไม่ได้ / ไม่แน่ใจ</span>}</td>
                  <td className="small">{r.confidence != null ? `${Math.round(r.confidence * 100)}%` : '—'}</td>
                  <td>
                    <span className={`pill ${r.source.startsWith('ocr:local:') ? 'pill-ok' : 'pill-info'}`}>{ocrSourceLabel(r.source)}</span>
                  </td>
                </tr>
              ))}
              {st.recent.length === 0 && (
                <tr>
                  <td colSpan={5} className="empty">ยังไม่มีผลการอ่าน</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card section">
        <h2>วิธีติดตั้งบนคอม (Windows)</h2>
        <ol className="small policy">
          <li>ติดตั้ง <a href="https://nodejs.org" target="_blank" rel="noopener noreferrer">Node.js</a> เวอร์ชัน LTS (กด Next จนเสร็จ)</li>
          <li>
            ดาวน์โหลดโปรแกรม: <a className="btn btn-sm" href="/downloads/ocr-agent.zip">⬇ ocr-agent.zip</a> แล้วแตกไฟล์ไว้ในโฟลเดอร์ เช่น <code>C:\ocr-agent</code>
          </li>
          <li>กด “+ เพิ่มเครื่อง” ด้านบน แล้วกด <strong>คัดลอก</strong></li>
          <li>ดับเบิลคลิก <code>start-windows.bat</code> → ครั้งแรกจะถามหา token ให้<strong>คลิกขวาในหน้าต่างดำเพื่อวาง</strong> แล้วกด Enter (โปรแกรมสร้าง config.json ให้เอง) → ติดตั้งประมาณ 1–3 นาที เมื่อขึ้น “พร้อมทำงาน” สถานะเครื่องในหน้านี้จะเป็น “เปิดอยู่”</li>
          <li>(ไม่บังคับ) ให้เปิดอัตโนมัติตอนเปิดคอม: กด Win+R พิมพ์ <code>shell:startup</code> แล้ววาง shortcut ของ start-windows.bat</li>
          <li>ทดสอบความแม่นกับรูปของคุณ: เปิด Command Prompt ในโฟลเดอร์ แล้วพิมพ์ <code>node test-image.mjs โฟลเดอร์รูป</code> (ตั้งชื่อไฟล์เป็นทะเบียนจริง เช่น <code>กข1234.jpg</code> จะได้คะแนนความแม่น)</li>
        </ol>
      </section>
    </div>
  );
}
