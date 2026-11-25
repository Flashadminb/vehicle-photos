import { useEffect, useState } from 'react';
import { api } from '../shared/api';
import type { AppSettings, Language, WorkflowStep, WorkflowVersion } from '../../shared/types';
import { FieldPreview } from './Preview';
import { STEP_IMAGE_EDGES, stepImageEdge } from '../../shared/types';

/** Rough JPEG size of a watermarked photo per long edge (q 0.82). */
const EDGE_MB: Record<number, string> = { 640: '0.1', 800: '0.15', 960: '0.2', 1280: '0.35', 1600: '0.5', 1920: '0.7', 2048: '0.8' };
import { formatBangkok } from '../../shared/time';

type Profile = { id: string; name: string; user_count: number; current_version: number | null };

export function WorkflowConfig() {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [profileId, setProfileId] = useState('default');
  const [current, setCurrent] = useState<WorkflowVersion | null>(null);
  const [versions, setVersions] = useState<any[]>([]);
  const [steps, setSteps] = useState<WorkflowStep[]>([]);
  const [languages, setLanguages] = useState<Language[]>([]);
  const [overrides, setOverrides] = useState<Record<string, Record<string, string>>>({});
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [note, setNote] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [newLang, setNewLang] = useState({ code: '', name: '' });

  async function load(pid = profileId) {
    const [w, i, s, p] = await Promise.all([
      api<{ current: WorkflowVersion; versions: any[] }>('GET', `/api/admin/workflow?workflowId=${encodeURIComponent(pid)}`),
      api<{ languages: Language[]; overrides: Record<string, Record<string, string>> }>('GET', '/api/admin/i18n'),
      api<AppSettings>('GET', '/api/admin/settings'),
      api<{ profiles: Profile[] }>('GET', '/api/admin/workflows'),
    ]);
    setProfiles(p.profiles);
    setProfileId(pid);
    setCurrent(w.current);
    setVersions(w.versions);
    setSteps(structuredClone(w.current.steps));
    setLanguages(i.languages);
    setOverrides(i.overrides);
    setSettings(s);
  }
  useEffect(() => void load().catch((e) => setMsg({ ok: false, text: e.message })), []);

  if (!current || !settings) return <div className="page"><span className="spinner" /></div>;

  const dirty = JSON.stringify(steps) !== JSON.stringify(current.steps);
  const profile = profiles.find((p) => p.id === profileId);

  async function switchProfile(pid: string) {
    if (pid === profileId) return;
    if (dirty && !confirm('มีขั้นตอนที่แก้ไว้แต่ยังไม่ได้เผยแพร่ เปลี่ยนรูปแบบแล้วการแก้ไขจะหาย ต้องการเปลี่ยนไหม?')) return;
    setMsg(null);
    await load(pid).catch((e) => setMsg({ ok: false, text: e.message }));
  }

  async function addProfile() {
    const name = prompt('ชื่อรูปแบบการถ่ายใหม่ เช่น ป้อมยาม (จะคัดลอกขั้นตอนจากรูปแบบที่เปิดอยู่ไปเป็นจุดเริ่มต้น)');
    if (!name?.trim()) return;
    try {
      const r = await api<{ id: string }>('POST', '/api/admin/workflows', { name: name.trim(), copyFrom: profileId });
      await load(r.id);
      setMsg({ ok: true, text: `สร้างรูปแบบ “${name.trim()}” แล้ว แก้ขั้นตอนแล้วกดเผยแพร่ จากนั้นไปที่ “สมาชิกและสิทธิ์” เพื่อเลือกว่าใครใช้รูปแบบนี้` });
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    }
  }

  async function renameProfile() {
    const name = prompt('ชื่อใหม่', profile?.name ?? '');
    if (!name?.trim()) return;
    try {
      await api('PATCH', `/api/admin/workflows/${profileId}`, { name: name.trim() });
      await load();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    }
  }

  async function archiveProfile() {
    if (!confirm(`ลบรูปแบบ “${profile?.name}”? ชุดรูปที่ถ่ายไปแล้วยังอยู่ในประวัติ`)) return;
    try {
      await api('DELETE', `/api/admin/workflows/${profileId}`);
      await load('default');
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    }
  }
  const update = (i: number, patch: Partial<WorkflowStep>) => setSteps((s) => s.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const move = (i: number, d: number) =>
    setSteps((s) => {
      const n = [...s];
      const j = i + d;
      if (j < 0 || j >= n.length) return s;
      [n[i], n[j]] = [n[j], n[i]];
      return n;
    });

  async function publish() {
    setMsg(null);
    try {
      const r = await api<{ id: number }>('POST', '/api/admin/workflow', { steps, note, workflowId: profileId });
      setMsg({ ok: true, text: `เผยแพร่ขั้นตอนเวอร์ชัน v${r.id} แล้ว รอบที่กำลังถ่ายอยู่ยังใช้เวอร์ชันเดิม รอบใหม่จะใช้ v${r.id}` });
      setNote('');
      await load();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    }
  }

  async function saveLanguage(l: { code: string; name: string; enabled?: boolean; sort?: number }) {
    setMsg(null);
    try {
      await api('PUT', `/api/admin/languages/${encodeURIComponent(l.code)}`, l);
      await load();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    }
  }

  async function setDefaults(patch: Partial<AppSettings>) {
    setMsg(null);
    try {
      setSettings(await api('PUT', '/api/admin/settings', patch));
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    }
  }

  return (
    <div className="page">
      <div className="page-head">
        <h1>ขั้นตอนการถ่ายและภาษา</h1>
        <span className="muted small">เวอร์ชันปัจจุบัน v{current.id} การเผยแพร่จะสร้างเวอร์ชันใหม่ที่ใช้กับรอบใหม่เท่านั้น</span>
      </div>
      {msg && <p className={`banner ${msg.ok ? 'banner-ok' : 'banner-bad'}`}>{msg.text}</p>}
      <section className="card section profiles-bar">
        <div className="profiles-head">
          <h2>รูปแบบการถ่าย</h2>
          <span className="small muted">แต่ละรูปแบบมีขั้นตอนของตัวเอง เช่น หน้างาน กับ ป้อมยาม · เลือกว่าใครใช้รูปแบบไหนที่ “สมาชิกและสิทธิ์”</span>
        </div>
        <div className="profiles-tabs" role="tablist">
          {profiles.map((p) => (
            <button key={p.id} role="tab" aria-selected={p.id === profileId} className={`btn btn-sm ${p.id === profileId ? 'btn-primary' : ''}`} onClick={() => void switchProfile(p.id)}>
              {p.name} <span className="profile-count">{p.user_count} คน</span>
            </button>
          ))}
          <button className="btn btn-sm" onClick={() => void addProfile()}>+ เพิ่มรูปแบบ</button>
          <span style={{ flex: 1 }} />
          <button className="btn btn-sm" onClick={() => void renameProfile()}>เปลี่ยนชื่อ</button>
          {profileId !== 'default' && <button className="btn btn-sm btn-danger" onClick={() => void archiveProfile()}>ลบรูปแบบนี้</button>}
        </div>
      </section>
      <div className="split">
        <div className="split-main">
          <section className="card section">
            <h2>ขั้นตอน · {profile?.name ?? ''}</h2>
            <ol className="steps-editor">
              {steps.map((s, i) => (
                <li key={s.id} className="step-card">
                  <div className="step-card-head">
                    <span className="step-num">{String(i + 1).padStart(2, '0')}</span>
                    <span className="mono small muted">{s.id}</span>
                    <span style={{ flex: 1 }} />
                    <button className="btn btn-sm btn-icon" onClick={() => move(i, -1)} disabled={i === 0} aria-label="เลื่อนขึ้น">↑</button>
                    <button className="btn btn-sm btn-icon" onClick={() => move(i, 1)} disabled={i === steps.length - 1} aria-label="เลื่อนลง">↓</button>
                    <button className="btn btn-sm btn-danger" onClick={() => setSteps((x) => x.filter((_, j) => j !== i))} disabled={steps.length <= 1}>
                      ลบขั้นตอน
                    </button>
                  </div>
                  <div className="form-grid">
                    {languages.map((l) => (
                      <label key={l.code} className="field">
                        <span>ชื่อขั้นตอน · {l.name}</span>
                        <input className="input" value={s.labels[l.code] ?? ''} onChange={(e) => update(i, { labels: { ...s.labels, [l.code]: e.target.value } })} />
                      </label>
                    ))}
                  </div>
                  <div className="step-flags">
                    <label className="checkbox">
                      <input type="checkbox" checked={s.required} onChange={(e) => update(i, { required: e.target.checked })} /> บังคับ
                    </label>
                    <label className="checkbox">
                      <input type="checkbox" checked={s.allowUpload} onChange={(e) => update(i, { allowUpload: e.target.checked })} /> อนุญาตให้อัปโหลดไฟล์
                    </label>
                    <label className="checkbox">
                      <input type="checkbox" checked={s.ocr} onChange={(e) => update(i, { ocr: e.target.checked, ocrKind: s.ocrKind ?? 'plate' })} /> อ่านป้ายทะเบียน (OCR)
                    </label>
                    {s.ocr && (
                      <label className="field-inline small">
                        รูปนี้คือ
                        <select className="input input-sm" value={s.ocrKind ?? 'plate'} onChange={(e) => update(i, { ocrKind: e.target.value as 'plate' | 'document' })}>
                          <option value="plate">ป้ายทะเบียนรถ</option>
                          <option value="document">เอกสาร/ใบบาร์รถ ที่พิมพ์ทะเบียน เช่น บร7865(เพชรบุรี)</option>
                        </select>
                      </label>
                    )}
                    <label className="field-inline small">
                      กรอบเล็ง
                      <select className="input input-sm" value={s.guide ?? ''} onChange={(e) => update(i, { guide: (e.target.value || undefined) as WorkflowStep['guide'] })}>
                        <option value="">อัตโนมัติ (ตาม OCR)</option>
                        <option value="none">ไม่มีกรอบ</option>
                        <option value="plate">ป้ายทะเบียน</option>
                        <option value="slip">ใบบาร์ทั้งใบ (แนวนอน)</option>
                        <option value="slip_line">ซูมบรรทัดทะเบียนบนใบบาร์</option>
                      </select>
                    </label>
                    <label className="field-inline small">
                      ขนาดรูป
                      <select
                        className="input input-sm"
                        value={stepImageEdge(s) ?? ''}
                        onChange={(e) => update(i, { imageEdge: e.target.value ? Number(e.target.value) : undefined, imageSize: undefined })}
                      >
                        <option value="">ตามค่ากลาง ({settings?.imageDisplayEdge ?? 1280} px)</option>
                        {STEP_IMAGE_EDGES.map((px) => (
                          <option key={px} value={px}>
                            {px} px · ~{EDGE_MB[px]} MB{px <= 960 ? ' (ประหยัด)' : px >= 1600 ? ' (คมชัด)' : ''}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                </li>
              ))}
            </ol>
            <button
              className="btn"
              onClick={() =>
                setSteps((s) => [...s, { id: `step_${Math.random().toString(36).slice(2, 8)}`, required: false, allowUpload: true, ocr: false, labels: { th: 'ขั้นตอนใหม่', en: 'New step' } }])
              }
            >
              + เพิ่มขั้นตอน
            </button>
            <div className="section-foot">
              <input className="input" placeholder="หมายเหตุการเปลี่ยนแปลง (ไม่บังคับ)" value={note} onChange={(e) => setNote(e.target.value)} aria-label="หมายเหตุการเปลี่ยนแปลง" />
              <button className="btn btn-primary" disabled={!dirty} onClick={() => void publish()}>
                เผยแพร่เวอร์ชันใหม่
              </button>
              <button className="btn" disabled={!dirty} onClick={() => setSteps(structuredClone(current.steps))}>
                ยกเลิกการแก้ไข
              </button>
            </div>
          </section>

          <section className="card section">
            <h2>ภาษา</h2>
            <div className="form-grid">
              <label className="field">
                <span>ภาษาเริ่มต้น</span>
                <select className="input" value={settings.defaultLanguage} onChange={(e) => void setDefaults({ defaultLanguage: e.target.value })}>
                  {languages.map((l) => (
                    <option key={l.code} value={l.code}>{l.name}</option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>ภาษาสำรองเมื่อไม่มีคำแปล</span>
                <select className="input" value={settings.fallbackLanguage} onChange={(e) => void setDefaults({ fallbackLanguage: e.target.value })}>
                  {languages.map((l) => (
                    <option key={l.code} value={l.code}>{l.name}</option>
                  ))}
                </select>
              </label>
            </div>
            <table className="table table-compact">
              <thead>
                <tr>
                  <th>รหัส</th>
                  <th>ชื่อ</th>
                  <th>ให้พนักงานเลือกได้</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {languages.map((l) => (
                  <tr key={l.code}>
                    <td className="mono">{l.code}</td>
                    <td>
                      <input className="input input-sm" defaultValue={l.name} onBlur={(e) => e.target.value !== l.name && void saveLanguage({ ...l, name: e.target.value })} aria-label={`ชื่อของ ${l.code}`} />
                    </td>
                    <td>
                      <input type="checkbox" checked={l.enabled} onChange={(e) => void saveLanguage({ ...l, enabled: e.target.checked })} aria-label={`เปิดใช้ ${l.code}`} />
                    </td>
                    <td>
                      <button
                        className="btn btn-sm btn-danger"
                        disabled={l.code === settings.defaultLanguage || l.code === settings.fallbackLanguage}
                        onClick={async () => {
                          if (!confirm(`ลบภาษา ${l.name} และคำแปลทั้งหมด?`)) return;
                          try {
                            await api('DELETE', `/api/admin/languages/${l.code}`);
                            await load();
                          } catch (e) {
                            setMsg({ ok: false, text: (e as Error).message });
                          }
                        }}
                      >
                        ลบ
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <form
              className="inline-form"
              onSubmit={(e) => {
                e.preventDefault();
                void saveLanguage({ code: newLang.code.trim(), name: newLang.name.trim(), enabled: true, sort: languages.length });
                setNewLang({ code: '', name: '' });
              }}
            >
              <input className="input input-sm" placeholder="รหัส (เช่น my, lo, zh)" value={newLang.code} onChange={(e) => setNewLang({ ...newLang, code: e.target.value })} required aria-label="รหัสภาษาใหม่" />
              <input className="input input-sm" placeholder="ชื่อ (เช่น မြန်မာ)" value={newLang.name} onChange={(e) => setNewLang({ ...newLang, name: e.target.value })} required aria-label="ชื่อภาษาใหม่" />
              <button className="btn btn-sm">+ เพิ่มภาษา</button>
            </form>
            <p className="small muted">หลังเพิ่มภาษา ให้แปลข้อความในหน้า “ตั้งค่าแอปภาคสนาม” และชื่อขั้นตอนด้านบน</p>
          </section>

          <section className="card section">
            <h2>ประวัติเวอร์ชัน</h2>
            <table className="table table-compact">
              <thead>
                <tr>
                  <th>เวอร์ชัน</th>
                  <th>เผยแพร่เมื่อ</th>
                  <th>โดย</th>
                  <th>หมายเหตุ</th>
                  <th>จำนวนรอบ</th>
                </tr>
              </thead>
              <tbody>
                {versions.map((v) => (
                  <tr key={v.id}>
                    <td>v{v.id}</td>
                    <td>{v.created_at ? formatBangkok(v.created_at) : 'ค่าเริ่มต้น'}</td>
                    <td>{v.created_by_name ?? '—'}</td>
                    <td>{v.note ?? ''}</td>
                    <td>{v.round_count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </div>
        <aside className="split-side">
          <FieldPreview steps={steps} overrides={overrides} languages={languages} fallbackLanguage={settings.fallbackLanguage} initialLang={settings.defaultLanguage} />
          <p className="small muted">ตัวอย่างสดของฉบับร่างที่ยังไม่เผยแพร่</p>
        </aside>
      </div>
    </div>
  );
}
