import { useEffect, useState } from 'react';
import { api } from '../shared/api';
import type { AppSettings, Language, WorkflowVersion } from '../../shared/types';
import { FieldPreview } from './Preview';
import { useMe } from './context';

interface I18nData {
  keys: string[];
  builtin: Record<string, Record<string, string>>;
  languages: Language[];
  overrides: Record<string, Record<string, string>>;
}

export function FieldConfig() {
  const me = useMe();
  const [i18n, setI18n] = useState<I18nData | null>(null);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [workflow, setWorkflow] = useState<WorkflowVersion | null>(null);
  const [draft, setDraft] = useState<Record<string, Record<string, string>>>({});
  const [lang, setLang] = useState('th');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [filter, setFilter] = useState('');

  async function load() {
    const [i, s, w] = await Promise.all([api<I18nData>('GET', '/api/admin/i18n'), api<AppSettings>('GET', '/api/admin/settings'), api<{ current: WorkflowVersion }>('GET', '/api/admin/workflow')]);
    setI18n(i);
    setSettings(s);
    setWorkflow(w.current);
    setDraft(structuredClone(i.overrides));
    setLang(s.defaultLanguage);
  }
  useEffect(() => void load().catch((e) => setMsg({ ok: false, text: e.message })), []);

  if (!i18n || !settings || !workflow) return <div className="page"><span className="spinner" /></div>;

  const value = (l: string, k: string) => draft[l]?.[k] ?? '';
  const placeholder = (l: string, k: string) => i18n.builtin[l]?.[k] ?? i18n.builtin[settings.fallbackLanguage]?.[k] ?? i18n.builtin.en?.[k] ?? '';
  const setValue = (l: string, k: string, v: string) => setDraft((d) => ({ ...d, [l]: { ...(d[l] ?? {}), [k]: v } }));

  async function saveTexts() {
    setMsg(null);
    try {
      // Send every key of the edited language; empty strings remove overrides (fall back to built-in).
      const payload: Record<string, Record<string, string>> = {};
      for (const l of i18n!.languages) {
        payload[l.code] = {};
        for (const k of i18n!.keys) payload[l.code][k] = draft[l.code]?.[k] ?? '';
      }
      await api('PUT', '/api/admin/translations', payload);
      setMsg({ ok: true, text: 'บันทึกข้อความแล้ว แอปภาคสนามจะใช้ข้อความใหม่เมื่อเปิดแอปครั้งถัดไปหรือหลังกดเสร็จสิ้นครั้งถัดไป' });
      await load();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    }
  }

  async function saveSettings(patch: Partial<AppSettings>) {
    setMsg(null);
    try {
      setSettings(await api('PUT', '/api/admin/settings', patch));
      setMsg({ ok: true, text: 'บันทึกการตั้งค่าแล้ว' });
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    }
  }

  const keys = i18n.keys.filter((k) => !filter || k.includes(filter) || (draft[lang]?.[k] ?? placeholder(lang, k)).toLowerCase().includes(filter.toLowerCase()));

  return (
    <div className="page">
      <div className="page-head">
        <h1>ตั้งค่าแอปภาคสนาม</h1>
        <span className="muted small">ชื่อแอป ข้อความทุกจุด และการทำงานของแอปภาคสนาม พนักงานภาคสนามแก้ส่วนนี้ไม่ได้</span>
      </div>
      {msg && <p className={`banner ${msg.ok ? 'banner-ok' : 'banner-bad'}`}>{msg.text}</p>}
      <div className="split">
        <div className="split-main">
          <section className="card section">
            <h2>การทำงาน</h2>
            <div className="form-grid">
              <label className="field">
                <span>คำแทนเมื่อไม่ทราบทะเบียน (มีผลกับรอบใหม่)</span>
                <input className="input" defaultValue={settings.unknownPlateLabel} onBlur={(e) => e.target.value !== settings.unknownPlateLabel && void saveSettings({ unknownPlateLabel: e.target.value })} />
              </label>
              <label className="field">
                <span>ถือว่ารอบที่ค้างถูกทิ้งไว้หลังจาก (ชั่วโมง)</span>
                <input className="input" type="number" min={1} defaultValue={settings.abandonAfterHours} onBlur={(e) => Number(e.target.value) !== settings.abandonAfterHours && void saveSettings({ abandonAfterHours: Number(e.target.value) })} />
              </label>
              <label className="checkbox">
                <input type="checkbox" checked={settings.pinLockEnabled} onChange={(e) => void saveSettings({ pinLockEnabled: e.target.checked })} />
                ล็อกแอปด้วย PIN เมื่อไม่มีการใช้งาน (เฉพาะผู้ใช้ที่ตั้ง PIN)
              </label>
              <label className="field">
                <span>ล็อกหลังจาก (นาที)</span>
                <input className="input" type="number" min={1} defaultValue={settings.pinLockMinutes} onBlur={(e) => Number(e.target.value) !== settings.pinLockMinutes && void saveSettings({ pinLockMinutes: Number(e.target.value) })} />
              </label>
              <label className="checkbox">
                <input type="checkbox" checked={settings.ocrBlocksDone} onChange={(e) => void saveSettings({ ocrBlocksDone: e.target.checked })} disabled={settings.ocrProvider === 'none'} />
                รอให้อ่านป้ายทะเบียนเสร็จก่อนกดเสร็จสิ้น (ไม่แนะนำ)
              </label>
            </div>
          </section>

          <section className="card section">
            <div className="section-head">
              <h2>ข้อความในแอป</h2>
              <label className="field-inline small">
                ภาษา
                <select className="input input-sm" value={lang} onChange={(e) => setLang(e.target.value)}>
                  {i18n.languages.map((l) => (
                    <option key={l.code} value={l.code}>
                      {l.name} ({l.code})
                    </option>
                  ))}
                </select>
              </label>
              <input className="input input-sm" type="search" placeholder="ค้นหา…" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="ค้นหาข้อความ" />
            </div>
            <p className="small muted">เว้นว่างไว้เพื่อใช้ข้อความเริ่มต้น (ตัวอักษรสีเทา) ในข้อความความคืบหน้าให้ใช้ {'{current}'} และ {'{total}'}</p>
            <div className="i18n-table">
              {keys.map((k) => (
                <label key={k} className="i18n-row">
                  <span className="mono small">{k}</span>
                  <input className="input" value={value(lang, k)} placeholder={placeholder(lang, k)} onChange={(e) => setValue(lang, k, e.target.value)} />
                </label>
              ))}
            </div>
            <div className="section-foot">
              <button className="btn btn-primary" onClick={() => void saveTexts()}>บันทึกข้อความ</button>
              <button className="btn" onClick={() => setDraft(structuredClone(i18n.overrides))}>ยกเลิกการแก้ไข</button>
            </div>
          </section>
        </div>
        <aside className="split-side">
          <FieldPreview steps={workflow.steps} overrides={draft} languages={i18n.languages} fallbackLanguage={settings.fallbackLanguage} initialLang={lang} key={lang} />
          <p className="small muted">ตัวอย่างอัปเดตทันทีขณะพิมพ์ พนักงานจะยังไม่เห็นจนกว่าจะกดบันทึก</p>
          {me.demo && <p className="small muted">โหมด demo: การแก้ไขมีผลกับฐานข้อมูลทดสอบในเครื่องเท่านั้น</p>}
        </aside>
      </div>
    </div>
  );
}
