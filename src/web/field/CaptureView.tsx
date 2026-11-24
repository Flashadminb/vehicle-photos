import type { Slot, SlotStatus } from './engine';

export interface ViewStep {
  id: string;
  label: string;
  required: boolean;
  allowUpload: boolean;
}

export interface CaptureViewProps {
  t: (key: string, vars?: Record<string, string | number>) => string;
  appName: string;
  steps: ViewStep[];
  stepIndex: number;
  slots: Record<string, Slot>;
  online: boolean;
  publicId: string | null;
  doneEnabled: boolean;
  doneBlocker: 'missing' | 'uploading' | null;
  finalize: { status: 'idle' | 'pending' | 'failed'; error?: string };
  flash: string | null;
  demo?: boolean;
  preview?: boolean;
  headerRight?: React.ReactNode;
  onTake(): void;
  onUpload(): void;
  onSkip(stepId: string): void;
  onSelectStep(index: number): void;
  onRetry(stepId: string): void;
  onDone(): void;
}

const ICON: Record<SlotStatus, string> = {
  empty: '○',
  queued: '◷',
  uploading: '↑',
  uploaded: '✓',
  failed: '!',
  skipped: '–',
};

function statusKey(s: SlotStatus) {
  return s === 'empty' ? 'status_missing' : `status_${s}`;
}

function StatusChip({ status, t }: { status: SlotStatus; t: CaptureViewProps['t'] }) {
  const cls = status === 'uploaded' ? 'pill-ok' : status === 'failed' ? 'pill-bad' : status === 'uploading' || status === 'queued' ? 'pill-info' : '';
  return (
    <span className={`pill ${cls}`}>
      {status === 'uploading' ? <span className="spinner" aria-hidden /> : <span aria-hidden>{ICON[status]}</span>}
      {t(statusKey(status))}
    </span>
  );
}

export function CaptureView(p: CaptureViewProps) {
  const { t, steps, stepIndex, slots } = p;
  const review = stepIndex >= steps.length;
  const step = steps[stepIndex];
  const slot = step ? slots[step.id] : undefined;
  const counts = Object.values(slots).reduce(
    (acc, s) => {
      if (s.status === 'queued' || s.status === 'uploading') acc.busy++;
      if (s.status === 'failed') acc.failed++;
      return acc;
    },
    { busy: 0, failed: 0 },
  );
  const failedStep = steps.find((s) => slots[s.id]?.status === 'failed');

  return (
    <div className={`fa ${p.preview ? 'fa-preview' : ''}`}>
      {p.demo && <div className="banner banner-demo fa-demo">DEMO MODE — Drive is emulated</div>}
      <header className="fa-header">
        <div className="fa-title">{p.appName}</div>
        <div className="fa-header-right">
          <span className={`pill ${p.online ? 'pill-ok' : 'pill-warn'}`} aria-live="polite">
            <span aria-hidden>●</span> {p.online ? 'Online' : 'Offline'}
          </span>
          {p.headerRight}
        </div>
      </header>

      {!p.online && <div className="banner banner-warn fa-offline">{t('offline_banner')}</div>}

      <nav className="fa-steps" aria-label="Steps">
        {steps.map((s, i) => {
          const st = slots[s.id]?.status ?? 'empty';
          return (
            <button
              key={s.id}
              type="button"
              className={`fa-step ${i === stepIndex ? 'is-current' : ''} st-${st}`}
              aria-current={i === stepIndex ? 'step' : undefined}
              onClick={() => p.onSelectStep(i)}
              disabled={p.finalize.status === 'pending'}
            >
              <span className="fa-step-n">{i + 1}</span>
              <span className="fa-step-label">{s.label}</span>
              <span className="fa-step-icon" aria-label={t(statusKey(st))}>
                {st === 'uploading' ? <span className="spinner" /> : ICON[st]}
              </span>
            </button>
          );
        })}
        <button
          type="button"
          className={`fa-step fa-step-review ${review ? 'is-current' : ''}`}
          onClick={() => p.onSelectStep(steps.length)}
          aria-current={review ? 'step' : undefined}
        >
          <span className="fa-step-n">✓</span>
          <span className="fa-step-label">{t('done')}</span>
        </button>
      </nav>

      <main className="fa-main">
        {!review && step && (
          <section className="card fa-capture" aria-labelledby="fa-step-name">
            <div className="fa-progress">
              <span>{t('step_progress', { current: stepIndex + 1, total: steps.length })}</span>
              <span className={`pill ${step.required ? '' : 'pill-info'}`}>{step.required ? t('required') : t('optional')}</span>
            </div>
            <div className="fa-progressbar" aria-hidden>
              <div style={{ width: `${((stepIndex + 1) / steps.length) * 100}%` }} />
            </div>
            <h1 id="fa-step-name" className="fa-step-name">
              {step.label}
            </h1>
            {slot?.previewUrl && slot.status !== 'empty' && (
              <div className="fa-current-photo">
                <img src={slot.previewUrl} alt="" />
                <div>
                  <StatusChip status={slot.status} t={t} />
                  <div className="small muted">{t('replace_photo')} ↓</div>
                </div>
              </div>
            )}
            <div className="fa-actions">
              <button type="button" className="btn btn-primary fa-take" onClick={p.onTake} disabled={p.finalize.status === 'pending'}>
                <svg width="28" height="28" viewBox="0 0 24 24" aria-hidden fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M4 8h3l2-3h6l2 3h3v11H4z" />
                  <circle cx="12" cy="13" r="3.5" />
                </svg>
                {slot?.localId ? t('retake') : t('take_photo')}
              </button>
              <div className="fa-secondary">
                {step.allowUpload && (
                  <button type="button" className="btn" onClick={p.onUpload} disabled={p.finalize.status === 'pending'}>
                    {t('upload_photo')}
                  </button>
                )}
                {!step.required && (
                  <button type="button" className="btn" onClick={() => p.onSkip(step.id)}>
                    {t('skip_step')}
                  </button>
                )}
              </div>
            </div>
          </section>
        )}

        {review && (
          <section className="card fa-review" aria-labelledby="fa-review-title">
            <h1 id="fa-review-title">{t('review_title')}</h1>
            <p className="muted small">{t('review_hint')}</p>
            <ul className="fa-review-list">
              {steps.map((s, i) => {
                const sl = slots[s.id] ?? { status: 'empty' as SlotStatus };
                return (
                  <li key={s.id}>
                    <button type="button" className="fa-review-item" onClick={() => p.onSelectStep(i)} disabled={p.finalize.status === 'pending'}>
                      {sl.previewUrl ? <img src={sl.previewUrl} alt="" /> : <span className="fa-thumb-empty" aria-hidden>{i + 1}</span>}
                      <span className="fa-review-label">
                        {s.label}
                        {!s.required && <span className="muted small"> · {t('optional')}</span>}
                      </span>
                      <StatusChip status={sl.status} t={t} />
                    </button>
                  </li>
                );
              })}
            </ul>
            <button
              type="button"
              className={`btn btn-lg btn-block fa-done ${p.doneEnabled ? 'is-ready' : ''}`}
              disabled={!p.doneEnabled}
              onClick={p.onDone}
              aria-describedby="fa-done-hint"
            >
              {p.finalize.status === 'pending' ? (
                <>
                  <span className="spinner" aria-hidden /> {t('finalizing')}
                </>
              ) : (
                t('done')
              )}
            </button>
            <p id="fa-done-hint" className="small fa-done-hint" aria-live="polite">
              {p.finalize.status === 'failed'
                ? t('finalize_failed')
                : p.doneBlocker === 'missing'
                  ? t('done_hint_missing')
                  : p.doneBlocker === 'uploading'
                    ? t('done_hint_uploading')
                    : ''}
            </p>
          </section>
        )}
      </main>

      <footer className="fa-footer" aria-live="polite">
        {counts.busy > 0 && (
          <span className="pill pill-info">
            <span className="spinner" aria-hidden /> {counts.busy} {t('status_uploading')}
          </span>
        )}
        {counts.failed > 0 && failedStep && (
          <span className="fa-failed">
            <span className="pill pill-bad">
              ! {counts.failed} {t('status_failed')}
            </span>
            <button type="button" className="btn btn-sm" onClick={() => p.onRetry(failedStep.id)}>
              {t('retry')}
            </button>
            {slots[failedStep.id]?.error && <span className="small muted fa-error">{slots[failedStep.id]?.error}</span>}
          </span>
        )}
        {p.publicId && <span className="small muted mono">{p.publicId}</span>}
      </footer>

      {p.flash && (
        <div className="fa-flash" role="status">
          ✓ {t(p.flash)}
        </div>
      )}
    </div>
  );
}
