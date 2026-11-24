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
      setMsg({ ok: true, text: 'Interface text saved. Field apps pick it up on their next load or after the next DONE.' });
      await load();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    }
  }

  async function saveSettings(patch: Partial<AppSettings>) {
    setMsg(null);
    try {
      setSettings(await api('PUT', '/api/admin/settings', patch));
      setMsg({ ok: true, text: 'Settings saved.' });
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    }
  }

  const keys = i18n.keys.filter((k) => !filter || k.includes(filter) || (draft[lang]?.[k] ?? placeholder(lang, k)).toLowerCase().includes(filter.toLowerCase()));

  return (
    <div className="page">
      <div className="page-head">
        <h1>Field app configuration</h1>
        <span className="muted small">App name, every label and helper text, and field behaviour. Operators cannot change these.</span>
      </div>
      {msg && <p className={`banner ${msg.ok ? 'banner-ok' : 'banner-bad'}`}>{msg.text}</p>}
      <div className="split">
        <div className="split-main">
          <section className="card section">
            <h2>Behaviour</h2>
            <div className="form-grid">
              <label className="field">
                <span>Unknown plate label (future rounds)</span>
                <input className="input" defaultValue={settings.unknownPlateLabel} onBlur={(e) => e.target.value !== settings.unknownPlateLabel && void saveSettings({ unknownPlateLabel: e.target.value })} />
              </label>
              <label className="field">
                <span>Mark unfinished rounds abandoned after (hours)</span>
                <input className="input" type="number" min={1} defaultValue={settings.abandonAfterHours} onBlur={(e) => Number(e.target.value) !== settings.abandonAfterHours && void saveSettings({ abandonAfterHours: Number(e.target.value) })} />
              </label>
              <label className="checkbox">
                <input type="checkbox" checked={settings.pinLockEnabled} onChange={(e) => void saveSettings({ pinLockEnabled: e.target.checked })} />
                PIN app lock after inactivity (for users with a PIN)
              </label>
              <label className="field">
                <span>Lock after (minutes)</span>
                <input className="input" type="number" min={1} defaultValue={settings.pinLockMinutes} onBlur={(e) => Number(e.target.value) !== settings.pinLockMinutes && void saveSettings({ pinLockMinutes: Number(e.target.value) })} />
              </label>
              <label className="checkbox">
                <input type="checkbox" checked={settings.ocrBlocksDone} onChange={(e) => void saveSettings({ ocrBlocksDone: e.target.checked })} disabled={settings.ocrProvider === 'none'} />
                Wait for plate recognition before DONE (not recommended)
              </label>
            </div>
          </section>

          <section className="card section">
            <div className="section-head">
              <h2>Interface text</h2>
              <label className="field-inline small">
                Language
                <select className="input input-sm" value={lang} onChange={(e) => setLang(e.target.value)}>
                  {i18n.languages.map((l) => (
                    <option key={l.code} value={l.code}>
                      {l.name} ({l.code})
                    </option>
                  ))}
                </select>
              </label>
              <input className="input input-sm" type="search" placeholder="Filter…" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter texts" />
            </div>
            <p className="small muted">Leave a field empty to use the built-in text (grey placeholder). Use {'{current}'} and {'{total}'} in the step progress text.</p>
            <div className="i18n-table">
              {keys.map((k) => (
                <label key={k} className="i18n-row">
                  <span className="mono small">{k}</span>
                  <input className="input" value={value(lang, k)} placeholder={placeholder(lang, k)} onChange={(e) => setValue(lang, k, e.target.value)} />
                </label>
              ))}
            </div>
            <div className="section-foot">
              <button className="btn btn-primary" onClick={() => void saveTexts()}>Save interface text</button>
              <button className="btn" onClick={() => setDraft(structuredClone(i18n.overrides))}>Discard changes</button>
            </div>
          </section>
        </div>
        <aside className="split-side">
          <FieldPreview steps={workflow.steps} overrides={draft} languages={i18n.languages} fallbackLanguage={settings.fallbackLanguage} initialLang={lang} key={lang} />
          <p className="small muted">Preview updates as you type. Nothing is visible to operators until you save.</p>
          {me.demo && <p className="small muted">Demo mode: changes affect only the local demo database.</p>}
        </aside>
      </div>
    </div>
  );
}
