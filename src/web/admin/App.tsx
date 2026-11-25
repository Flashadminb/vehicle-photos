import { useCallback, useEffect, useMemo, useState } from 'react';
import { usePresence } from '../shared/presence';
import { api, ApiError } from '../shared/api';
import { MeContext, type Me } from './context';
import { History } from './History';
import { FieldConfig } from './FieldConfig';
import { WorkflowConfig } from './WorkflowConfig';
import { Members } from './Members';
import { DriveStorage } from './DriveStorage';
import { AuditLog } from './AuditLog';
import { OcrPage } from './OcrPage';

const ROLE_TH: Record<string, string> = { super_admin: 'ผู้ดูแลสูงสุด', admin: 'ผู้ดูแล', reviewer: 'ผู้ตรวจสอบ', operator: 'พนักงานภาคสนาม' };

const NAV = [
  { path: 'history', label: 'ประวัติชุดรูป', perm: 'sets.view', icon: 'M4 6h16M4 12h16M4 18h10' },
  { path: 'field', label: 'ตั้งค่าแอปภาคสนาม', perm: 'config.edit', icon: 'M8 3h8a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zM11 18h2' },
  { path: 'workflow', label: 'ขั้นตอนการถ่ายและภาษา', perm: 'config.edit', icon: 'M5 6h4v4H5zM15 6h4v4h-4zM10 16h4v4h-4zM7 10v3h10v-3M12 13v3' },
  { path: 'members', label: 'สมาชิกและสิทธิ์', perm: 'users.manage', icon: 'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM2 21a7 7 0 0 1 14 0M17 11a3 3 0 1 0 0-6M22 21a6 6 0 0 0-4-5.6' },
  { path: 'ocr', label: 'อ่านป้ายทะเบียน (OCR)', perm: 'sets.view', icon: 'M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2M7 9h10v6H7z' },
  { path: 'drive', label: 'Google Drive และการเก็บรักษา', perm: 'storage.view', icon: 'M8 3h8l6 10-4 7H6l-4-7zM2 13h20M8 3l8 17M16 3 8 20' },
  { path: 'audit', label: 'บันทึกการใช้งาน', perm: 'audit.view', icon: 'M6 3h9l4 4v14H6zM9 12h7M9 16h7M9 8h3' },
];

function useHashRoute() {
  const get = () => (location.hash.replace(/^#\/?/, '').split('?')[0] || 'history').split('/')[0];
  const [route, setRoute] = useState(get);
  useEffect(() => {
    const h = () => setRoute(get());
    window.addEventListener('hashchange', h);
    return () => window.removeEventListener('hashchange', h);
  }, []);
  return route;
}

export function App() {
  const [me, setMe] = useState<Omit<Me, 'can'> | null>(null);
  const [state, setState] = useState<'loading' | 'login' | 'ready'>('loading');
  const route = useHashRoute();

  const load = useCallback(async () => {
    try {
      setMe(await api('GET', '/api/admin/me'));
      setState('ready');
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) setState('login');
      else setState('login');
    }
  }, []);
  useEffect(() => void load(), [load]);
  usePresence(me ? '/api/admin/ping' : null);

  const value = useMemo<Me | null>(() => (me ? { ...me, can: (p: string) => me.permissions.includes(p) } : null), [me]);

  if (state === 'loading') return <div className="center"><span className="spinner" aria-label="กำลังโหลด" /></div>;
  if (state === 'login' || !value) return <Login onDone={load} />;
  if (value.user.mustChangePassword) return <ChangePassword onDone={load} />;

  const allowed = NAV.filter((n) => value.can(n.perm));
  const active = allowed.find((n) => n.path === route) ?? allowed[0];

  return (
    <MeContext.Provider value={value}>
      <div className="shell">
        <aside className="sidebar">
          <div className="brand">
            <span className="brand-mark" aria-hidden>◉</span>
            <div>
              <div className="brand-name">Vehicle Photos</div>
              <div className="small muted">แดชบอร์ดผู้ดูแล</div>
            </div>
          </div>
          <nav aria-label="เมนูหลัก">
            {allowed.map((n) => (
              <a key={n.path} href={`#/${n.path}`} className={`nav-link ${active?.path === n.path ? 'is-active' : ''}`} aria-current={active?.path === n.path ? 'page' : undefined}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d={n.icon} />
                </svg>
                {n.label}
              </a>
            ))}
          </nav>
          <div className="sidebar-foot">
            <div className="small">
              <strong>{value.user.displayName}</strong>
              <div className="muted">{ROLE_TH[value.user.role] ?? value.user.role}</div>
            </div>
            <button
              className="btn btn-sm"
              onClick={async () => {
                await api('POST', '/api/admin/logout').catch(() => undefined);
                setState('login');
              }}
            >
              ออกจากระบบ
            </button>
          </div>
        </aside>
        <main className="content">
          {value.demo && <div className="banner banner-demo">โหมด DEMO — Google Drive ถูกจำลองในเครื่องและมีบัญชีทดสอบ ห้ามใช้กับข้อมูลจริง</div>}
          {active?.path === 'history' && <History />}
          {active?.path === 'field' && <FieldConfig />}
          {active?.path === 'workflow' && <WorkflowConfig />}
          {active?.path === 'members' && <Members />}
          {active?.path === 'ocr' && <OcrPage />}
          {active?.path === 'drive' && <DriveStorage />}
          {active?.path === 'audit' && <AuditLog />}
        </main>
      </div>
    </MeContext.Provider>
  );
}

function Login({ onDone }: { onDone: () => void }) {
  const [setup, setSetup] = useState<{ needed: boolean; tokenConfigured: boolean } | null>(null);
  useEffect(() => {
    api('GET', '/api/setup/status').then(setSetup, () => setSetup(null));
  }, []);
  if (setup?.needed) return <FirstSetup tokenConfigured={setup.tokenConfigured} onDone={() => setSetup({ ...setup, needed: false })} />;
  return <LoginForm onDone={onDone} />;
}

/** First run on a fresh deployment: create the first Super Admin with the SETUP_TOKEN secret. */
function FirstSetup({ tokenConfigured, onDone }: { tokenConfigured: boolean; onDone: () => void }) {
  const [f, setF] = useState({ token: '', username: '', displayName: '', password: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <div className="center">
      <form
        className="card auth-card"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError('');
          try {
            await api('POST', '/api/setup', f);
            onDone();
          } catch (err) {
            setError((err as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <h1>ตั้งค่าครั้งแรก</h1>
        <p className="muted small">ระบบยังไม่มีผู้ใช้ สร้างผู้ดูแลสูงสุด (Super Admin) คนแรกที่นี่ ใช้ได้ครั้งเดียวเท่านั้น</p>
        {!tokenConfigured && <p className="banner banner-warn small">ยังไม่ได้ตั้ง secret SETUP_TOKEN ใน Worker — ดู README</p>}
        <label className="field">
          <span>Setup token (ค่า SETUP_TOKEN ที่ตั้งไว้)</span>
          <input className="input" type="password" value={f.token} onChange={(e) => setF({ ...f, token: e.target.value })} required />
        </label>
        <label className="field">
          <span>ชื่อผู้ใช้</span>
          <input className="input" autoComplete="username" pattern="[A-Za-z0-9._\-]{3,40}" value={f.username} onChange={(e) => setF({ ...f, username: e.target.value })} required />
        </label>
        <label className="field">
          <span>ชื่อที่แสดง</span>
          <input className="input" value={f.displayName} onChange={(e) => setF({ ...f, displayName: e.target.value })} required />
        </label>
        <label className="field">
          <span>รหัสผ่าน (อย่างน้อย 8 ตัวอักษร)</span>
          <input className="input" type="password" autoComplete="new-password" minLength={8} value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} required />
        </label>
        {error && <p className="banner banner-bad" role="alert">{error}</p>}
        <button className="btn btn-primary" disabled={busy}>{busy ? <span className="spinner" /> : 'สร้างผู้ดูแลสูงสุด'}</button>
      </form>
    </div>
  );
}

function LoginForm({ onDone }: { onDone: () => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <div className="center">
      <form
        className="card auth-card"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError('');
          try {
            await api('POST', '/api/admin/login', { username, password });
            onDone();
          } catch (err) {
            setError((err as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <h1>แดชบอร์ดผู้ดูแล</h1>
        <p className="muted small">Vehicle Photos — เข้าสู่ระบบด้วยบัญชีผู้ดูแลหรือผู้ตรวจสอบ</p>
        <label className="field">
          <span>ชื่อผู้ใช้</span>
          <input className="input" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required />
        </label>
        <label className="field">
          <span>รหัสผ่าน</span>
          <input className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </label>
        {error && <p className="banner banner-bad" role="alert">{error}</p>}
        <button className="btn btn-primary" disabled={busy}>{busy ? <span className="spinner" /> : 'เข้าสู่ระบบ'}</button>
      </form>
    </div>
  );
}

function ChangePassword({ onDone }: { onDone: () => void }) {
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [error, setError] = useState('');
  return (
    <div className="center">
      <form
        className="card auth-card"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            await api('POST', '/api/admin/me/password', { currentPassword: cur, newPassword: next });
            onDone();
          } catch (err) {
            setError((err as Error).message);
          }
        }}
      >
        <h1>ตั้งรหัสผ่านใหม่</h1>
        <p className="small muted">รหัสผ่านนี้ถูกตั้งโดยผู้ดูแล กรุณาตั้งรหัสผ่านของคุณเองก่อนใช้งาน</p>
        <label className="field">
          <span>รหัสผ่านชั่วคราว</span>
          <input className="input" type="password" autoComplete="current-password" value={cur} onChange={(e) => setCur(e.target.value)} required />
        </label>
        <label className="field">
          <span>รหัสผ่านใหม่ (อย่างน้อย 8 ตัวอักษร)</span>
          <input className="input" type="password" autoComplete="new-password" minLength={8} value={next} onChange={(e) => setNext(e.target.value)} required />
        </label>
        {error && <p className="banner banner-bad">{error}</p>}
        <button className="btn btn-primary">บันทึกรหัสผ่าน</button>
      </form>
    </div>
  );
}
