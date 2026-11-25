import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { api, ApiError } from '../shared/api';
import { makeTranslator, stepLabel } from '../../shared/i18n';
import type { FieldBootstrap } from '../../shared/types';
import { CaptureEngine } from './engine';
import { CaptureView } from './CaptureView';
import { IdbStore, requestPersistentStorage } from './storage';
import { httpTransport } from './transport';
import { browserImaging, readExifTime } from './imaging';

type Boot = FieldBootstrap & { mustChangePassword: boolean };

function useOnline() {
  return useSyncExternalStore(
    (cb) => {
      window.addEventListener('online', cb);
      window.addEventListener('offline', cb);
      return () => {
        window.removeEventListener('online', cb);
        window.removeEventListener('offline', cb);
      };
    },
    () => navigator.onLine,
  );
}

export function App() {
  const [boot, setBoot] = useState<Boot | null>(null);
  const [state, setState] = useState<'loading' | 'login' | 'ready' | 'error'>('loading');
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const b = await api<Boot>('GET', '/api/field/bootstrap');
      setBoot(b);
      setState('ready');
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) setState('login');
      else {
        setError((e as Error).message);
        setState('error');
      }
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (state === 'loading') return <div className="fa-auth"><span className="spinner" aria-label="Loading" /></div>;
  if (state === 'login') return <Login onDone={load} />;
  if (state === 'error' || !boot)
    return (
      <div className="fa-auth">
        <div className="card">
          <p className="banner banner-bad">{error || 'Could not load the app.'}</p>
          <button className="btn btn-primary" onClick={() => void load()}>Retry</button>
        </div>
      </div>
    );
  if (boot.mustChangePassword) return <ChangePassword boot={boot} onDone={load} />;
  return <Capture boot={boot} reload={load} onSignedOut={() => setState('login')} />;
}

function Login({ onDone }: { onDone: () => void }) {
  const t = makeTranslator({}, navigator.language.startsWith('en') ? 'en' : 'th', 'en');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return (
    <div className="fa-auth">
      <form
        className="card"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError('');
          try {
            await api('POST', '/api/field/login', { username, password });
            onDone();
          } catch (err) {
            setError((err as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <h1>{t('app_name')}</h1>
        <p className="muted">{t('login_title')}</p>
        <label className="field">
          <span>{t('username')}</span>
          <input className="input" autoComplete="username" autoCapitalize="none" value={username} onChange={(e) => setUsername(e.target.value)} required />
        </label>
        <label className="field">
          <span>{t('password')}</span>
          <input className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </label>
        {error && <p className="banner banner-bad" role="alert">{error}</p>}
        <button className="btn btn-primary btn-lg" disabled={busy}>{busy ? <span className="spinner" /> : t('sign_in')}</button>
      </form>
    </div>
  );
}

function ChangePassword({ boot, onDone }: { boot: Boot; onDone: () => void }) {
  const lang = boot.user.language || boot.settings.defaultLanguage;
  const t = makeTranslator(boot.translations, lang, boot.settings.fallbackLanguage);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [error, setError] = useState('');
  return (
    <div className="fa-auth">
      <form
        className="card"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            await api('POST', '/api/field/me/password', { currentPassword: current, newPassword: next });
            onDone();
          } catch (err) {
            setError((err as Error).message);
          }
        }}
      >
        <h1>{t('change_password_title')}</h1>
        <label className="field">
          <span>{t('password')}</span>
          <input className="input" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
        </label>
        <label className="field">
          <span>{t('new_password')}</span>
          <input className="input" type="password" autoComplete="new-password" minLength={8} value={next} onChange={(e) => setNext(e.target.value)} required />
        </label>
        {error && <p className="banner banner-bad" role="alert">{error}</p>}
        <button className="btn btn-primary btn-lg">{t('save')}</button>
      </form>
    </div>
  );
}

function Capture({ boot, reload, onSignedOut }: { boot: Boot; reload: () => Promise<void>; onSignedOut: () => void }) {
  const [lang, setLang] = useState(boot.user.language || boot.settings.defaultLanguage);
  const t = useMemo(() => makeTranslator(boot.translations, lang, boot.settings.fallbackLanguage), [boot.translations, lang, boot.settings.fallbackLanguage]);
  const online = useOnline();
  const cameraInput = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [locked, setLocked] = useState(false);
  const [notice, setNotice] = useState('');

  const engine = useMemo(
    () =>
      new CaptureEngine(
        {
          transport: httpTransport,
          store: new IdbStore(boot.user.id),
          imaging: browserImaging,
          cacheEnabled: boot.cacheEnabled !== false,
          stepLabel: (s) => stepLabel(s.labels, boot.settings.defaultLanguage, boot.settings.fallbackLanguage),
        },
        boot.workflow,
      ),
    // One engine per signed-in operator.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [boot.user.id],
  );
  const s = useSyncExternalStore(
    (cb) => engine.subscribe(cb),
    () => engine.getState(),
  );

  useEffect(() => {
    void engine.init();
    void requestPersistentStorage();
    return () => engine.dispose();
  }, [engine]);

  // New workflow config applies to the next round only.
  useEffect(() => engine.setLatestWorkflow(boot.workflow), [engine, boot.workflow]);

  useEffect(() => {
    if (online) engine.resume();
  }, [online, engine]);

  // After a successful DONE, pick up any configuration changes for the next round.
  useEffect(() => {
    if (s.flash === 'set_saved') void reload();
  }, [s.flash, reload]);

  // Warn before closing the page while photos are still only on this device.
  useEffect(() => {
    const busy = Object.values(s.slots).some((x) => ['queued', 'uploading', 'failed'].includes(x.status));
    const handler = (e: BeforeUnloadEvent) => {
      if (busy) e.preventDefault();
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [s.slots]);

  // Optional PIN app-lock after inactivity (uploads continue underneath).
  useEffect(() => {
    if (!boot.settings.pinLockEnabled || !boot.user.hasPin) return;
    let timer: ReturnType<typeof setTimeout>;
    const reset = () => {
      clearTimeout(timer);
      timer = setTimeout(() => setLocked(true), boot.settings.pinLockMinutes * 60_000);
    };
    const events = ['pointerdown', 'keydown', 'visibilitychange'];
    events.forEach((e) => window.addEventListener(e, reset));
    reset();
    return () => {
      clearTimeout(timer);
      events.forEach((e) => window.removeEventListener(e, reset));
    };
  }, [boot.settings.pinLockEnabled, boot.settings.pinLockMinutes, boot.user.hasPin]);

  const step = s.workflow.steps[s.stepIndex];
  const steps = s.workflow.steps.map((x) => ({ id: x.id, label: stepLabel(x.labels, lang, boot.settings.fallbackLanguage), required: x.required, allowUpload: x.allowUpload }));

  async function onFile(e: React.ChangeEvent<HTMLInputElement>, source: 'camera' | 'upload') {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || !step) return;
    const captureTime = source === 'camera' ? Date.now() : null;
    try {
      const exifTime = source === 'upload' ? await readExifTime(file) : null;
      await engine.accept(step.id, file, source, { captureTime, exifTime });
    } catch (err) {
      setNotice((err as Error).message === 'upload_not_allowed' ? t('upload_not_allowed') : t('error_generic'));
    }
  }

  async function signOut() {
    const pending = Object.values(s.slots).some((x) => x.status !== 'empty');
    if (pending && !confirm('An unfinished set is kept on this device and will continue after you sign in again. Sign out?')) return;
    await api('POST', '/api/field/logout').catch(() => undefined);
    engine.dispose();
    onSignedOut();
  }

  return (
    <>
      <CaptureView
        t={t}
        appName={t('app_name')}
        steps={steps}
        stepIndex={s.stepIndex}
        slots={s.slots}
        online={online}
        publicId={s.publicId}
        hasRound={!!s.clientRoundId}
        canReview={!!s.clientRoundId && engine.doneBlocker(s) !== 'missing'}
        savedPublicId={s.savedPublicId ?? null}
        doneEnabled={engine.canFinish(s)}
        doneBlocker={engine.doneBlocker(s)}
        finalize={s.finalize}
        flash={s.flash}
        demo={boot.driveMode === 'demo'}
        onTake={() => cameraInput.current?.click()}
        onUpload={() => fileInput.current?.click()}
        onSkip={(id) => void engine.skip(id)}
        onSelectStep={(i) => engine.goTo(i)}
        onRetry={(id) => engine.retry(id)}
        onDone={() => void engine.finalize()}
        headerRight={
          <div className="fa-menu">
            <button className="btn btn-sm btn-icon" aria-label="Menu" aria-expanded={menuOpen} onClick={() => setMenuOpen((v) => !v)}>
              ☰
            </button>
            {menuOpen && (
              <div className="fa-menu-panel">
                <div className="small muted">{boot.user.displayName}</div>
                <label className="field">
                  <span>{t('language')}</span>
                  <select
                    className="input"
                    value={lang}
                    onChange={async (e) => {
                      setLang(e.target.value);
                      await api('PUT', '/api/field/me/language', { language: e.target.value }).catch(() => undefined);
                    }}
                  >
                    {boot.languages.map((l) => (
                      <option key={l.code} value={l.code}>
                        {l.name}
                      </option>
                    ))}
                  </select>
                </label>
                <button className="btn" onClick={() => void signOut()}>{t('sign_out')}</button>
              </div>
            )}
          </div>
        }
      />
      {notice && (
        <div className="fa-flash" role="alert" onClick={() => setNotice('')} style={{ background: 'var(--danger)' }}>
          {notice}
        </div>
      )}
      <input ref={cameraInput} type="file" accept="image/*" capture="environment" hidden onChange={(e) => void onFile(e, 'camera')} />
      <input ref={fileInput} type="file" accept="image/jpeg,image/png,image/heic,image/heif,image/webp" hidden onChange={(e) => void onFile(e, 'upload')} />
      {locked && <LockScreen t={t} onUnlocked={() => setLocked(false)} onSignedOut={onSignedOut} />}
    </>
  );
}

function LockScreen({ t, onUnlocked, onSignedOut }: { t: (k: string) => string; onUnlocked: () => void; onSignedOut: () => void }) {
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  return (
    <div className="fa-lock" role="dialog" aria-modal="true" aria-labelledby="lock-title">
      <form
        className="card"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            await api('POST', '/api/field/unlock', { pin });
            onUnlocked();
          } catch (err) {
            if (err instanceof ApiError && err.status === 401) onSignedOut();
            else setError(t('wrong_pin'));
            setPin('');
          }
        }}
      >
        <h1 id="lock-title">{t('locked_title')}</h1>
        <label className="field">
          <span>{t('enter_pin')}</span>
          <input className="input" inputMode="numeric" autoComplete="one-time-code" type="password" value={pin} onChange={(e) => setPin(e.target.value)} autoFocus />
        </label>
        {error && <p className="banner banner-bad" role="alert">{error}</p>}
        <button className="btn btn-primary btn-lg">{t('unlock')}</button>
      </form>
    </div>
  );
}
