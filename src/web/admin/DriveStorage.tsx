import { useEffect, useState } from 'react';
import { api } from '../shared/api';
import type { AppSettings } from '../../shared/types';
import { formatBangkok } from '../../shared/time';
import { useMe } from './context';

const GB = 1024 ** 3;
const MB = 1024 ** 2;
const fmtBytes = (n: number | null | undefined) => (n == null ? '—' : n >= GB ? `${(n / GB).toFixed(2)} GB` : `${(n / MB).toFixed(1)} MB`);

function Meter({ used, quota, threshold, label }: { used: number | null; quota: number; threshold: number; label: string }) {
  const pct = used == null ? 0 : Math.min(100, (used / quota) * 100);
  const over = pct >= threshold;
  return (
    <div className="meter-block">
      <div className="meter-label">
        <span>{label}</span>
        <span className={over ? 'text-bad' : 'muted'}>
          {fmtBytes(used)} จาก {fmtBytes(quota)} ({pct.toFixed(1)}%)
        </span>
      </div>
      <div className="meter" role="meter" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100} aria-label={label}>
        <div className={`meter-fill ${over ? 'is-over' : ''}`} style={{ width: `${pct}%` }} />
        <div className="meter-mark" style={{ left: `${threshold}%` }} title={`เกณฑ์ ${threshold}%`} />
      </div>
    </div>
  );
}

/** Drive storage meter + "free up space" (Super Admin). Drive is only read when this page opens. */
function DriveSpace({ connected }: { connected: boolean }) {
  const me = useMe();
  const [usage, setUsage] = useState<any>(null);
  const [err, setErr] = useState('');
  const [days, setDays] = useState(180);
  const [preview, setPreview] = useState<any>(null);
  const [confirmText, setConfirmText] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState('');
  const CONFIRM = 'ย้ายไปถังขยะ';

  const loadUsage = () => api('GET', '/api/admin/drive/usage').then(setUsage, (e) => setErr(e.message));
  useEffect(() => {
    if (connected) void loadUsage();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected]);
  if (!connected) return null;

  const pct = usage?.limit ? (usage.usage / usage.limit) * 100 : null;
  return (
    <section className="card section">
      <h2>พื้นที่ Google Drive</h2>
      {err && <p className="banner banner-bad small">{err}</p>}
      {!usage && !err && <span className="spinner" />}
      {usage && (
        <>
          {usage.limit ? (
            <Meter label="ทั้งบัญชี (Drive + Gmail + Photos)" used={usage.usage} quota={usage.limit} threshold={70} />
          ) : (
            <p className="small">ใช้ไป {fmtBytes(usage.usage)} (บัญชีนี้ไม่จำกัดพื้นที่)</p>
          )}
          <p className="small muted">
            รูปของแอปนี้ประมาณ {fmtBytes(usage.appBytes)} · อยู่ในถังขยะ Drive {fmtBytes(usage.usageInTrash)}
            {usage.pendingTrash > 0 && <> · กำลังย้ายไปถังขยะอีก {usage.pendingTrash} ชุด</>}
          </p>
          {pct != null && pct >= 70 && (
            <p className="banner banner-warn small">
              Drive ใช้ไปเกิน 70% แล้ว — เมื่อเต็ม การอัปโหลดรูปจากหน้างานจะล้มเหลว ควรย้ายรูปชุดเก่าไปถังขยะ แล้ว “ล้างถังขยะ” ใน Google Drive (พื้นที่จะคืนหลังล้างถังขยะเท่านั้น)
            </p>
          )}
        </>
      )}

      {me.can('drive.trash') && (
        <div className="cleanup">
          <h3>คืนพื้นที่: ย้ายรูปชุดเก่าไปถังขยะ Drive</h3>
          <p className="small muted">
            ย้ายโฟลเดอร์รูปของชุดที่เสร็จแล้วและเก่ากว่าที่กำหนดไปถังขยะ Google Drive ข้อมูลชุด (รหัส ทะเบียน เวลา ผู้ถ่าย) ยังค้นหาได้ในประวัติ
            กู้คืนรายชุดได้ภายใน 30 วันจากหน้ารายละเอียดชุด · แอปไม่ลบถาวรเอง พื้นที่จะคืนเมื่อถังขยะถูกล้าง (Google ล้างเองหลัง 30 วัน หรือกดล้างเองใน Drive)
          </p>
          <div className="toolbar">
            <label className="field">
              <span>เก่ากว่า (วัน, อย่างน้อย 7)</span>
              <input className="input" type="number" min={7} value={days} onChange={(e) => { setDays(Number(e.target.value)); setPreview(null); }} />
            </label>
            <button
              className="btn"
              disabled={busy}
              onClick={async () => {
                setErr('');
                setDone('');
                try {
                  setPreview(await api('GET', `/api/admin/drive/cleanup-preview?days=${days}`));
                } catch (e) {
                  setErr((e as Error).message);
                }
              }}
            >
              ตรวจดูว่ามีกี่ชุด
            </button>
          </div>
          {preview && (
            preview.sets === 0 ? (
              <p className="small">ไม่มีชุดที่เก่ากว่า {days} วัน (ก่อนวันที่ {preview.before})</p>
            ) : (
              <div className="banner banner-warn small">
                <p>
                  พบ <strong>{preview.sets.toLocaleString()}</strong> ชุด (วันที่ {preview.oldest} ถึง {preview.newest}) ประมาณ <strong>{fmtBytes(preview.bytes)}</strong>
                  {preview.sets > preview.maxPerRun && <> · ครั้งนี้จะทำ {preview.maxPerRun} ชุดที่เก่าที่สุดก่อน กดซ้ำเพื่อทำต่อ</>}
                </p>
                <label className="field">
                  <span>พิมพ์ “{CONFIRM}” เพื่อยืนยัน</span>
                  <input className="input" value={confirmText} onChange={(e) => setConfirmText(e.target.value)} />
                </label>
                <button
                  className="btn btn-danger"
                  disabled={busy || confirmText.trim() !== CONFIRM}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      const r = await api('POST', '/api/admin/drive/cleanup', { days, confirm: confirmText.trim() });
                      setDone(`กำลังย้าย ${r.queued} ชุดไปถังขยะ Drive (ทำในเบื้องหลัง: ทันที 8 ชุด แล้วต่ออีกราว 10 ชุดทุก 15 นาที)`);
                      setPreview(null);
                      setConfirmText('');
                      void loadUsage();
                    } catch (e) {
                      setErr((e as Error).message);
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  ย้าย {Math.min(preview.sets, preview.maxPerRun).toLocaleString()} ชุดไปถังขยะ
                </button>
              </div>
            )
          )}
          {done && <p className="banner banner-ok small">{done}</p>}
        </div>
      )}
    </section>
  );
}

export function DriveStorage() {
  const me = useMe();
  const [drive, setDrive] = useState<any>(null);
  const [storage, setStorage] = useState<any>(null);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [shareEmail, setShareEmail] = useState('');
  const canManage = me.can('drive.manage');

  async function load() {
    const [d, s, st] = await Promise.all([
      api('GET', '/api/admin/drive/status'),
      api('GET', '/api/admin/storage'),
      me.can('config.edit') ? api<AppSettings>('GET', '/api/admin/settings') : Promise.resolve(null),
    ]);
    setDrive(d);
    setStorage(s);
    setSettings(st);
  }
  useEffect(() => {
    void load().catch((e) => setMsg({ ok: false, text: e.message }));
    const h = new URLSearchParams(location.hash.split('?')[1] ?? '');
    if (h.get('connected')) setMsg({ ok: true, text: 'เชื่อมต่อ Google Drive แล้ว' });
    if (h.get('error')) setMsg({ ok: false, text: h.get('error')! });
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

  if (!drive || !storage) return <div className="page"><span className="spinner" /></div>;
  const s = settings;

  return (
    <div className="page">
      <div className="page-head">
        <h1>Google Drive และการเก็บรักษา</h1>
      </div>
      {msg && <p className={`banner ${msg.ok ? 'banner-ok' : 'banner-bad'}`}>{msg.text}</p>}

      <section className="card section">
        <h2>การเชื่อมต่อ Google Drive</h2>
        {drive.mode === 'demo' ? (
          <p className="banner banner-demo">โหมด demo — Drive ถูกจำลอง ตั้งค่า DRIVE_MODE=google เพื่อใช้ Google Drive จริง</p>
        ) : (
          <>
            <dl className="kv">
              <dt>สถานะ</dt>
              <dd>{drive.connected ? <span className="pill pill-ok">เชื่อมต่อแล้ว{drive.email ? ` (${drive.email})` : ''}</span> : <span className="pill pill-bad">ยังไม่ได้เชื่อมต่อ</span>}</dd>
              {drive.connectedAt && (
                <>
                  <dt>เชื่อมต่อเมื่อ</dt>
                  <dd>{formatBangkok(drive.connectedAt)}</dd>
                </>
              )}
              <dt>โฟลเดอร์หลัก</dt>
              <dd>
                <span className="mono small">{drive.rootFolderId || '—'}</span> {drive.rootOk ? <span className="pill pill-ok">{drive.rootName}</span> : drive.connected ? <span className="pill pill-bad">เข้าถึงไม่ได้</span> : null}
                {drive.rootFolderId && (
                  <a className="btn btn-sm" href={`https://drive.google.com/drive/folders/${drive.rootFolderId}`} target="_blank" rel="noopener noreferrer">
                    เปิดโฟลเดอร์หลัก ↗
                  </a>
                )}
              </dd>
              <dt>OAuth redirect URI (ใส่ใน Google Cloud)</dt>
              <dd className="mono small">{drive.redirectUri}</dd>
            </dl>
            {drive.error && <p className="banner banner-bad small">{drive.error}</p>}
            {!drive.oauthConfigured && <p className="banner banner-warn small">ต้องตั้งค่า secret GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET และ TOKEN_ENC_KEY ใน Worker ก่อน (ดู README)</p>}
            {canManage && (
              <div className="section-foot">
                <button
                  className="btn btn-primary"
                  disabled={!drive.oauthConfigured}
                  onClick={async () => {
                    try {
                      const r = await api<{ url: string }>('POST', '/api/admin/drive/oauth/start');
                      location.href = r.url;
                    } catch (e) {
                      setMsg({ ok: false, text: (e as Error).message });
                    }
                  }}
                >
                  {drive.connected ? 'เชื่อมต่อ Google Drive ใหม่' : 'เชื่อมต่อ Google Drive'}
                </button>
                {drive.connected && (
                  <button className="btn btn-danger" onClick={async () => confirm('ยกเลิกการเชื่อมต่อ Drive? การอัปโหลดจะหยุดจนกว่าจะเชื่อมต่อใหม่ ไฟล์จะไม่ถูกลบ') && (await api('POST', '/api/admin/drive/disconnect'), await load())}>
                    ยกเลิกการเชื่อมต่อ
                  </button>
                )}
              </div>
            )}
          </>
        )}
        {canManage && s && (
          <div className="form-grid">
            <label className="field">
              <span>ID โฟลเดอร์หลัก (มีผลกับรอบใหม่)</span>
              <input className="input mono" defaultValue={s.driveRootFolderId} onBlur={(e) => e.target.value !== s.driveRootFolderId && void save({ driveRootFolderId: e.target.value.trim() })} />
            </label>
            <label className="checkbox">
              <input type="checkbox" checked={s.keepOriginals} onChange={(e) => void save({ keepOriginals: e.target.checked })} />
              เก็บรูปต้นฉบับที่ไม่มีลายน้ำด้วย (สำหรับตรวจสอบ / OCR) — อัปโหลดช้าลงและใช้พื้นที่ Drive ประมาณ 3–4 เท่า
            </label>
            <label className="field">
              <span>ขนาดรูปที่เก็บใน Drive (มีลายน้ำ)</span>
              <select className="input" value={s.imageDisplayEdge} onChange={(e) => void save({ imageDisplayEdge: Number(e.target.value) })}>
                <option value={1024}>1024 px — เล็กสุด เร็วสุด</option>
                <option value={1280}>1280 px — แนะนำ</option>
                <option value={1600}>1600 px</option>
                <option value={2048}>2048 px — ละเอียด ช้ากว่า</option>
              </select>
            </label>
            <label className="field">
              <span>ความละเอียดกล้องในแอป</span>
              <select className="input" value={s.cameraMaxEdge} onChange={(e) => void save({ cameraMaxEdge: Number(e.target.value) })}>
                <option value={1280}>1280 px</option>
                <option value={1920}>1920 px — แนะนำ</option>
                <option value={2560}>2560 px</option>
                <option value={3840}>3840 px — สูงสุดเท่าที่กล้องให้</option>
              </select>
            </label>
            {s.keepOriginals && (
              <label className="field">
                <span>ขนาดรูปต้นฉบับ</span>
                <select className="input" value={s.imageOriginalEdge} onChange={(e) => void save({ imageOriginalEdge: Number(e.target.value) })}>
                  <option value={2048}>2048 px</option>
                  <option value={2560}>2560 px</option>
                  <option value={3200}>3200 px</option>
                </select>
              </label>
            )}
            <p className="small muted span-all">
              ประมาณการต่อชุด (3 รูป): ~{(3 * (s.imageDisplayEdge / 1280) ** 2 * 0.25 + (s.keepOriginals ? 3 * (s.imageOriginalEdge / 2560) ** 2 * 1.1 : 0)).toFixed(1)} MB
              · ยิ่งเล็กยิ่งอัปโหลดเร็วและประหยัด Drive · มีผลกับมือถือเมื่อเปิดแอปใหม่
            </p>
          </div>
        )}
        <h3 style={{ marginTop: 18 }}>สิทธิ์เข้าถึงแบบส่วนตัวสำหรับผู้ดูแล</h3>
        <p className="small muted">
          รูปไม่เคยเปิดเป็นสาธารณะ ปุ่ม “เปิดชุดใน Drive” จะเปิดโฟลเดอร์ของรอบนั้นบน drive.google.com ซึ่ง Google จะแสดงให้เฉพาะบัญชี Google ที่ได้รับแชร์โฟลเดอร์หลักเท่านั้น
          การเข้าสู่ระบบแดชบอร์ดไม่ได้ให้สิทธิ์ Drive โดยอัตโนมัติ — ต้องแชร์โฟลเดอร์หลักให้บัญชี Google ของผู้ดูแลแต่ละคน:
        </p>
        {canManage && (
          <form
            className="inline-form"
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                await api('POST', '/api/admin/drive/share', { email: shareEmail, role: 'reader' });
                setMsg({ ok: true, text: `แชร์โฟลเดอร์หลักแบบส่วนตัวให้ ${shareEmail} แล้ว (ดูอย่างเดียว)` });
                setShareEmail('');
              } catch (err) {
                setMsg({ ok: false, text: (err as Error).message });
              }
            }}
          >
            <input className="input" type="email" placeholder="admin@example.com" value={shareEmail} onChange={(e) => setShareEmail(e.target.value)} required aria-label="อีเมลบัญชี Google" />
            <button className="btn">ให้สิทธิ์ดู</button>
          </form>
        )}
      </section>

      <DriveSpace connected={drive.mode === 'demo' || (drive.connected && drive.rootOk)} />

      <section className="card section">
        <h2>พื้นที่บนโฮสต์</h2>
        <p className="small muted">
          Cloudflare R2 เก็บแค่แคชชั่วคราวของรูปล่าสุดและภาพย่อ รูปจริงอยู่ใน Google Drive เมื่อแคชเกินเกณฑ์ ระบบจะลบสำเนาที่เก่าที่สุดออกจากแคช (ไม่แตะไฟล์ใน Drive)
          จนลดลงถึงระดับเป้าหมาย
        </p>
        {storage.cache.enabled === false && <p className="banner banner-warn small">ยังไม่ได้เปิดใช้ R2 — ระบบทำงานได้ปกติ แต่รูปของวันล่าสุดจะโหลดจาก Google Drive โดยตรง (ช้ากว่า) ดูวิธีเปิด R2 ใน README</p>}
        <Meter label="แคชรูป R2" used={storage.cache.bytes} quota={storage.cache.quotaBytes} threshold={storage.cache.thresholdPct} />
        <p className="small muted">แคชอยู่ {storage.cache.objects.toLocaleString()} ไฟล์ · หลังล้างจะเหลือ {storage.cache.targetPct}%</p>
        <Meter label="ฐานข้อมูล D1 (metadata)" used={storage.db.bytes} quota={storage.db.quotaBytes} threshold={storage.db.thresholdPct} />
        <p className="small muted">มีชุดรูปในระบบ {storage.db.rounds.toLocaleString()} ชุด</p>
        {storage.db.bytes != null && storage.db.bytes / storage.db.quotaBytes * 100 >= storage.db.thresholdPct && (
          <p className="banner banner-warn small">ฐานข้อมูลใช้พื้นที่เกินเกณฑ์แล้ว ดูทางเลือกใน docs/ARCHITECTURE.md หัวข้อ “Metadata archiving” ข้อมูลที่ย้ายออกไปจะค้นหาในแอปไม่ได้ถ้าไม่มีระบบเพิ่ม</p>
        )}
        {me.can('storage.manage') && (
          <div className="section-foot">
            <button className="btn" onClick={async () => { const r = await api('POST', '/api/admin/storage/evict'); setMsg({ ok: true, text: `ล้างแคชแล้ว ลบไป ${r.evicted} ไฟล์` }); await load(); }}>
              ล้างแคชตอนนี้
            </button>
            <button className="btn" onClick={async () => { const r = await api('POST', '/api/admin/jobs/run'); setMsg({ ok: true, text: `งานเบื้องหลัง: เสร็จ ${r.done}/${r.claimed} งาน` }); await load(); }}>
              รันงานเบื้องหลังตอนนี้
            </button>
          </div>
        )}
        {canManage && s && (
          <div className="form-grid">
            <label className="field">
              <span>โควต้าแคช (GB)</span>
              <input className="input" type="number" step="0.5" min={0.1} defaultValue={s.cacheQuotaBytes / GB} onBlur={(e) => void save({ cacheQuotaBytes: Math.round(Number(e.target.value) * GB) })} />
            </label>
            <label className="field">
              <span>เกณฑ์เริ่มล้างแคช (%)</span>
              <input className="input" type="number" min={10} max={95} defaultValue={s.cacheThresholdPct} onBlur={(e) => void save({ cacheThresholdPct: Number(e.target.value) })} />
            </label>
            <label className="field">
              <span>ล้างจนเหลือ (%)</span>
              <input className="input" type="number" min={5} max={90} defaultValue={s.cacheTargetPct} onBlur={(e) => void save({ cacheTargetPct: Number(e.target.value) })} />
            </label>
            <label className="field">
              <span>โควต้าฐานข้อมูล (MB)</span>
              <input className="input" type="number" min={1} defaultValue={s.dbQuotaBytes / MB} onBlur={(e) => void save({ dbQuotaBytes: Math.round(Number(e.target.value) * MB) })} />
            </label>
          </div>
        )}
        {storage.failedJobs?.length > 0 && (
          <>
            <h3>งานที่ต้องตรวจสอบ</h3>
            <table className="table table-compact">
              <tbody>
                {storage.failedJobs.map((j: any) => (
                  <tr key={j.id}>
                    <td>{j.kind}</td>
                    <td className="mono small">{j.ref_id}</td>
                    <td>ลอง {j.attempts} ครั้ง</td>
                    <td className="small">{j.last_error}</td>
                    <td>{me.can('storage.manage') && <button className="btn btn-sm" onClick={async () => { await api('POST', `/api/admin/jobs/${j.id}/retry`); await load(); }}>ลองใหม่</button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </section>

      {s && me.can('config.edit') && (
        <section className="card section">
          <h2>การแสดงรูปในแดชบอร์ด</h2>
          <div className="form-grid">
            <label className="field">
              <span>แสดงรูปของ</span>
              <select className="input" value={s.imageDisplayMode} onChange={(e) => void save({ imageDisplayMode: e.target.value as AppSettings['imageDisplayMode'] })}>
                <option value="window">เฉพาะวันล่าสุด (ค่าเริ่มต้น)</option>
                <option value="cache">วันล่าสุด + ชุดที่ยังอยู่ในแคช</option>
              </select>
            </label>
            <label className="field">
              <span>ช่วงล่าสุด (วัน, 1 = เฉพาะวันนี้)</span>
              <input className="input" type="number" min={1} defaultValue={s.recentImageDays} onBlur={(e) => void save({ recentImageDays: Number(e.target.value) })} />
            </label>
            <label className="field">
              <span>ส่งออก Excel ได้สูงสุด (ชุดต่อครั้ง)</span>
              <input className="input" type="number" min={1} max={500} defaultValue={s.exportMaxSets} onBlur={(e) => void save({ exportMaxSets: Number(e.target.value) })} />
            </label>
          </div>
          <p className="small muted">ชุดเก่าจะไม่โหลดรูปหรือภาพย่อในแดชบอร์ด แสดงเฉพาะข้อมูลและปุ่ม “เปิดชุดใน Drive” · ตั้งค่าการอ่านป้ายทะเบียนอยู่ที่เมนู <a href="#/ocr">อ่านป้ายทะเบียน (OCR)</a></p>
        </section>
      )}

      <section className="card section">
        <h2>นโยบายการเก็บรักษา</h2>
        <ul className="small policy">
          <li><strong>รูป</strong> เก็บใน Google Drive ถาวร แอปไม่ลบไฟล์ถาวร ทางเดียวที่เอารูปออกคือ Super Admin กด “ย้ายไปถังขยะ” (กู้คืนได้ 30 วัน, บันทึกใน log ทุกครั้ง)</li>
          <li><strong>ซ่อน / ลบ</strong> เปลี่ยนแค่การแสดงผลในแอป ยังเก็บข้อมูลขั้นต่ำ (รหัสชุด, เวลา, ทะเบียน, ID โฟลเดอร์ Drive) และบันทึกการใช้งานไว้</li>
          <li><strong>รูปที่ถูกถ่ายซ้ำแทน</strong> ถ้าขึ้น Drive แล้วจะย้ายไปโฟลเดอร์ย่อย <code>_replaced</code> และเก็บไว้ ถ้ายังไม่ออกจากมือถือจะถูกทิ้งในเครื่อง</li>
          <li><strong>รอบที่ถูกทิ้งไว้</strong> (ไม่มีความเคลื่อนไหว {s?.abandonAfterHours ?? 48} ชม.) จะถูกทำเครื่องหมาย “ถูกทิ้งไว้” โฟลเดอร์ Drive ยังอยู่ และกลับมาทำต่อได้ถ้ามือถืออัปโหลดอีก</li>
          <li><strong>แคช R2</strong> เป็นสำเนาชั่วคราว ถูกล้างอัตโนมัติเมื่อถึงเกณฑ์</li>
          <li><strong>มือถือ</strong> จะลบรูปในเครื่องหลังจากเซิร์ฟเวอร์ยืนยันว่าเก็บใน Drive แล้วเท่านั้น</li>
        </ul>
      </section>
    </div>
  );
}
