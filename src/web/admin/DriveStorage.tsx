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
          {fmtBytes(used)} of {fmtBytes(quota)} ({pct.toFixed(1)}%)
        </span>
      </div>
      <div className="meter" role="meter" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100} aria-label={label}>
        <div className={`meter-fill ${over ? 'is-over' : ''}`} style={{ width: `${pct}%` }} />
        <div className="meter-mark" style={{ left: `${threshold}%` }} title={`Threshold ${threshold}%`} />
      </div>
    </div>
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
    if (h.get('connected')) setMsg({ ok: true, text: 'Google Drive connected.' });
    if (h.get('error')) setMsg({ ok: false, text: h.get('error')! });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function save(patch: Partial<AppSettings>) {
    setMsg(null);
    try {
      setSettings(await api('PUT', '/api/admin/settings', patch));
      setMsg({ ok: true, text: 'Saved.' });
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
        <h1>Google Drive & retention</h1>
      </div>
      {msg && <p className={`banner ${msg.ok ? 'banner-ok' : 'banner-bad'}`}>{msg.text}</p>}

      <section className="card section">
        <h2>Google Drive connection</h2>
        {drive.mode === 'demo' ? (
          <p className="banner banner-demo">Demo mode — Drive is emulated. Set DRIVE_MODE=google to use real Google Drive.</p>
        ) : (
          <>
            <dl className="kv">
              <dt>Status</dt>
              <dd>{drive.connected ? <span className="pill pill-ok">Connected{drive.email ? ` as ${drive.email}` : ''}</span> : <span className="pill pill-bad">Not connected</span>}</dd>
              {drive.connectedAt && (
                <>
                  <dt>Connected at</dt>
                  <dd>{formatBangkok(drive.connectedAt)}</dd>
                </>
              )}
              <dt>Root folder</dt>
              <dd>
                <span className="mono small">{drive.rootFolderId || '—'}</span> {drive.rootOk ? <span className="pill pill-ok">{drive.rootName}</span> : drive.connected ? <span className="pill pill-bad">Not accessible</span> : null}
                {drive.rootFolderId && (
                  <a className="btn btn-sm" href={`https://drive.google.com/drive/folders/${drive.rootFolderId}`} target="_blank" rel="noopener noreferrer">
                    Open root ↗
                  </a>
                )}
              </dd>
              <dt>OAuth redirect URI</dt>
              <dd className="mono small">{drive.redirectUri}</dd>
            </dl>
            {drive.error && <p className="banner banner-bad small">{drive.error}</p>}
            {!drive.oauthConfigured && <p className="banner banner-warn small">Set the GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and TOKEN_ENC_KEY Worker secrets first (see README).</p>}
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
                  {drive.connected ? 'Reconnect Google Drive' : 'Connect Google Drive'}
                </button>
                {drive.connected && (
                  <button className="btn btn-danger" onClick={async () => confirm('Disconnect Drive? Uploads will stop until reconnected. No files are deleted.') && (await api('POST', '/api/admin/drive/disconnect'), await load())}>
                    Disconnect
                  </button>
                )}
              </div>
            )}
          </>
        )}
        {canManage && s && (
          <div className="form-grid">
            <label className="field">
              <span>Root folder ID (new rounds)</span>
              <input className="input mono" defaultValue={s.driveRootFolderId} onBlur={(e) => e.target.value !== s.driveRootFolderId && void save({ driveRootFolderId: e.target.value.trim() })} />
            </label>
            <label className="checkbox">
              <input type="checkbox" checked={s.keepOriginals} onChange={(e) => void save({ keepOriginals: e.target.checked })} />
              Also keep un-watermarked originals (for audit / OCR) — roughly doubles Drive usage
            </label>
          </div>
        )}
        <h3 style={{ marginTop: 18 }}>Private access for administrators</h3>
        <p className="small muted">
          Photos are never public. “Open set in Drive” opens the round folder on drive.google.com, which Google only shows to Google accounts that have been given access to the root folder. Signing in to this dashboard does not
          grant Drive access by itself — share the root folder with each administrator’s Google account:
        </p>
        {canManage && (
          <form
            className="inline-form"
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                await api('POST', '/api/admin/drive/share', { email: shareEmail, role: 'reader' });
                setMsg({ ok: true, text: `Shared the root folder privately with ${shareEmail} (view only).` });
                setShareEmail('');
              } catch (err) {
                setMsg({ ok: false, text: (err as Error).message });
              }
            }}
          >
            <input className="input" type="email" placeholder="admin@example.com" value={shareEmail} onChange={(e) => setShareEmail(e.target.value)} required aria-label="Google account email" />
            <button className="btn">Give view access</button>
          </form>
        )}
      </section>

      <section className="card section">
        <h2>Host storage</h2>
        <p className="small muted">
          Cloudflare R2 only holds a disposable cache of recent display copies and thumbnails; Google Drive keeps the photos. When cache usage passes the threshold, the oldest cached copies are removed (never the Drive files)
          until usage drops to the target.
        </p>
        <Meter label="R2 image cache" used={storage.cache.bytes} quota={storage.cache.quotaBytes} threshold={storage.cache.thresholdPct} />
        <p className="small muted">{storage.cache.objects.toLocaleString()} cached objects · target after cleanup {storage.cache.targetPct}%</p>
        <Meter label="D1 database (metadata)" used={storage.db.bytes} quota={storage.db.quotaBytes} threshold={storage.db.thresholdPct} />
        <p className="small muted">{storage.db.rounds.toLocaleString()} photo sets indexed.</p>
        {storage.db.bytes != null && storage.db.bytes / storage.db.quotaBytes * 100 >= storage.db.thresholdPct && (
          <p className="banner banner-warn small">Database usage passed the threshold. See README → “Metadata archiving” for the options; archived records are not searchable without extra infrastructure.</p>
        )}
        {me.can('storage.manage') && (
          <div className="section-foot">
            <button className="btn" onClick={async () => { const r = await api('POST', '/api/admin/storage/evict'); setMsg({ ok: true, text: `Cache cleanup: ${r.evicted} objects removed.` }); await load(); }}>
              Run cache cleanup now
            </button>
            <button className="btn" onClick={async () => { const r = await api('POST', '/api/admin/jobs/run'); setMsg({ ok: true, text: `Background jobs: ${r.done}/${r.claimed} done.` }); await load(); }}>
              Run background jobs now
            </button>
          </div>
        )}
        {canManage && s && (
          <div className="form-grid">
            <label className="field">
              <span>Cache quota (GB)</span>
              <input className="input" type="number" step="0.5" min={0.1} defaultValue={s.cacheQuotaBytes / GB} onBlur={(e) => void save({ cacheQuotaBytes: Math.round(Number(e.target.value) * GB) })} />
            </label>
            <label className="field">
              <span>Cleanup threshold (%)</span>
              <input className="input" type="number" min={10} max={95} defaultValue={s.cacheThresholdPct} onBlur={(e) => void save({ cacheThresholdPct: Number(e.target.value) })} />
            </label>
            <label className="field">
              <span>Clean down to (%)</span>
              <input className="input" type="number" min={5} max={90} defaultValue={s.cacheTargetPct} onBlur={(e) => void save({ cacheTargetPct: Number(e.target.value) })} />
            </label>
            <label className="field">
              <span>Database quota (MB)</span>
              <input className="input" type="number" min={1} defaultValue={s.dbQuotaBytes / MB} onBlur={(e) => void save({ dbQuotaBytes: Math.round(Number(e.target.value) * MB) })} />
            </label>
          </div>
        )}
        {storage.failedJobs?.length > 0 && (
          <>
            <h3>Jobs needing attention</h3>
            <table className="table table-compact">
              <tbody>
                {storage.failedJobs.map((j: any) => (
                  <tr key={j.id}>
                    <td>{j.kind}</td>
                    <td className="mono small">{j.ref_id}</td>
                    <td>{j.attempts} attempts</td>
                    <td className="small">{j.last_error}</td>
                    <td>{me.can('storage.manage') && <button className="btn btn-sm" onClick={async () => { await api('POST', `/api/admin/jobs/${j.id}/retry`); await load(); }}>Retry</button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </section>

      {s && me.can('config.edit') && (
        <section className="card section">
          <h2>Images in the dashboard</h2>
          <div className="form-grid">
            <label className="field">
              <span>Show images for</span>
              <select className="input" value={s.imageDisplayMode} onChange={(e) => void save({ imageDisplayMode: e.target.value as AppSettings['imageDisplayMode'] })}>
                <option value="window">Recent days only (default)</option>
                <option value="cache">Recent days + anything still in the cache</option>
              </select>
            </label>
            <label className="field">
              <span>Recent window (days, 1 = today only)</span>
              <input className="input" type="number" min={1} defaultValue={s.recentImageDays} onBlur={(e) => void save({ recentImageDays: Number(e.target.value) })} />
            </label>
            <label className="field">
              <span>Max sets per Excel export</span>
              <input className="input" type="number" min={1} max={500} defaultValue={s.exportMaxSets} onBlur={(e) => void save({ exportMaxSets: Number(e.target.value) })} />
            </label>
            {canManage && (
              <label className="field">
                <span>Plate recognition (OCR)</span>
                <select className="input" value={s.ocrProvider} onChange={(e) => void save({ ocrProvider: e.target.value as AppSettings['ocrProvider'] })}>
                  <option value="none">Off — enter plates manually</option>
                  <option value="google_vision">Google Cloud Vision</option>
                  <option value="aiforthai">AI for Thai LPR (experimental)</option>
                </select>
              </label>
            )}
          </div>
          <p className="small muted">Older sets never load images or thumbnails in the dashboard; they show metadata and an “Open set in Drive” button.</p>
        </section>
      )}

      <section className="card section">
        <h2>Retention policy</h2>
        <ul className="small policy">
          <li><strong>Photos</strong> live in Google Drive permanently. The app never deletes Drive files or folders; there is no delete action.</li>
          <li><strong>Hide / Remove</strong> only change visibility in the app. A minimal record (set ID, times, plate, Drive folder ID) and the audit trail are kept.</li>
          <li><strong>Replaced photos</strong> that already reached Drive are moved into the set’s <code>_replaced</code> subfolder and kept. Replaced photos that never left the phone are discarded on the phone.</li>
          <li><strong>Abandoned rounds</strong> (no activity for {s?.abandonAfterHours ?? 48}h) are marked “Abandoned”; their Drive folder is kept and they resume if the phone uploads again.</li>
          <li><strong>R2 cache</strong> copies are disposable and evicted automatically at the threshold.</li>
          <li><strong>Phones</strong> delete a local photo only after the server confirms it is stored in Drive.</li>
        </ul>
      </section>
    </div>
  );
}
