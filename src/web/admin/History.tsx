import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../shared/api';
import { formatBangkok, isValidTimeString } from '../../shared/time';
import type { SetListResponse, SetRow } from '../../shared/types';
import { DateRangePicker, type DateRange } from './DateRangePicker';
import { useMe } from './context';
import { exportSetsToExcel } from './excel';

type Dir = 'first' | 'next' | 'prev' | 'last';

export function History() {
  const me = useMe();
  const [range, setRange] = useState<DateRange | null>({ start: me.today, end: me.today });
  const [startTime, setStartTime] = useState('00:00:00');
  const [endTime, setEndTime] = useState('23:59:59');
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('finalized');
  const [visibility, setVisibility] = useState('normal');
  const [pageSize, setPageSize] = useState(20);
  const [sort, setSort] = useState<'newest' | 'oldest'>('newest');
  const [data, setData] = useState<SetListResponse | null>(null);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [viewing, setViewing] = useState<string | null>(null);
  const [details, setDetails] = useState<string | null>(null);
  const [exporting, setExporting] = useState<{ done: number; total: number; ctrl: AbortController } | null>(null);
  const reqId = useRef(0);

  const timeError =
    !isValidTimeString(startTime) || !isValidTimeString(endTime)
      ? 'Times must be HH:MM:SS.'
      : range && range.start === range.end && endTime < startTime
        ? 'On a single day the end time must be after the start time.'
        : '';

  const load = useCallback(
    async (dir: Dir, cursor?: string | null, prev?: { offset: number; count: number }) => {
      if (timeError) return;
      const id = ++reqId.current;
      setLoading(true);
      setError('');
      const params = new URLSearchParams({ pageSize: String(pageSize), status, visibility, sort, direction: dir });
      if (range) {
        params.set('startDate', range.start);
        params.set('endDate', range.end);
        params.set('startTime', startTime);
        params.set('endTime', endTime);
      }
      if (q.trim()) params.set('q', q.trim());
      if (cursor) params.set('cursor', cursor);
      try {
        const res = await api<SetListResponse>('GET', `/api/admin/sets?${params}`);
        if (id !== reqId.current) return;
        setData(res);
        setOffset(
          dir === 'first' ? 0 : dir === 'last' ? Math.max(0, res.total - res.rows.length) : dir === 'next' ? prev!.offset + prev!.count : Math.max(0, prev!.offset - res.rows.length),
        );
      } catch (e) {
        if (id === reqId.current) setError((e as Error).message);
      } finally {
        if (id === reqId.current) setLoading(false);
      }
    },
    [pageSize, status, visibility, sort, range, startTime, endTime, q, timeError],
  );

  // Any filter change restarts at the first page (debounced for typing).
  useEffect(() => {
    const t = setTimeout(() => void load('first'), 250);
    return () => clearTimeout(t);
  }, [load]);

  const rows = data?.rows ?? [];
  const total = data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(pages, Math.floor(offset / pageSize) + 1);
  const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.id));

  async function runExport() {
    const ctrl = new AbortController();
    setExporting({ done: 0, total: 0, ctrl });
    try {
      await exportSetsToExcel([...selected], (done, total) => setExporting({ done, total, ctrl }), ctrl.signal);
    } catch (e) {
      if ((e as Error).name !== 'AbortError') alert(`Export failed: ${(e as Error).message}`);
    } finally {
      setExporting(null);
    }
  }

  return (
    <div className="page">
      <div className="page-head">
        <h1>Photo set history</h1>
        <span className="muted small">One row = one complete photo set · times in Asia/Bangkok</span>
      </div>

      <section className="card filters" aria-label="Filters">
        <div className="field">
          <span>Date range</span>
          <DateRangePicker value={range} onApply={setRange} today={me.today} />
        </div>
        <label className="field">
          <span>Start time</span>
          <input className="input" type="time" step={1} value={startTime} onChange={(e) => setStartTime(e.target.value.length === 5 ? e.target.value + ':00' : e.target.value)} disabled={!range} />
        </label>
        <label className="field">
          <span>End time</span>
          <input className="input" type="time" step={1} value={endTime} onChange={(e) => setEndTime(e.target.value.length === 5 ? e.target.value + ':00' : e.target.value)} disabled={!range} />
        </label>
        <label className="field grow">
          <span>Search plate, operator or set ID</span>
          <input className="input" type="search" placeholder="e.g. กข 1234, 1234, PF-000123, Somchai" value={q} onChange={(e) => setQ(e.target.value)} />
        </label>
        <label className="field">
          <span>Status</span>
          <select className="input" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="finalized">Completed</option>
            <option value="open">In progress</option>
            <option value="abandoned">Abandoned</option>
            <option value="all">All</option>
          </select>
        </label>
        {me.can('sets.viewHidden') && (
          <label className="field">
            <span>Visibility</span>
            <select className="input" value={visibility} onChange={(e) => setVisibility(e.target.value)}>
              <option value="normal">Normal</option>
              <option value="hidden">Hidden</option>
              {me.can('sets.viewRemoved') && <option value="removed">Removed</option>}
              {me.can('sets.viewRemoved') && <option value="all">All</option>}
            </select>
          </label>
        )}
        {range && (
          <p className="small muted filters-note">
            Interval: <strong>{range.start} {startTime}</strong> → <strong>{range.end} {endTime}</strong> (one continuous span, inclusive)
          </p>
        )}
        {timeError && <p className="banner banner-bad small filters-note" role="alert">{timeError}</p>}
      </section>

      <section className="card table-card">
        <div className="table-toolbar">
          <span className="small muted" aria-live="polite">
            {loading ? <span className="spinner" /> : total === 0 ? 'No results' : `Showing ${offset + 1}–${offset + rows.length} of ${total.toLocaleString()}`}
          </span>
          <span style={{ flex: 1 }} />
          {me.can('sets.export') && (
            <button className="btn btn-sm" disabled={selected.size === 0 || !!exporting || selected.size > me.settings.exportMaxSets} onClick={() => void runExport()} title={`Up to ${me.settings.exportMaxSets} sets`}>
              ⬇ Export {selected.size || ''} to Excel
            </button>
          )}
          <label className="field-inline small">
            Sort
            <select className="input input-sm" value={sort} onChange={(e) => setSort(e.target.value as 'newest' | 'oldest')}>
              <option value="newest">Newest first</option>
              <option value="oldest">Oldest first</option>
            </select>
          </label>
          <label className="field-inline small">
            Rows
            <select className="input input-sm" value={pageSize} onChange={(e) => setPageSize(Number(e.target.value))}>
              {[20, 50, 100].map((n) => (
                <option key={n}>{n}</option>
              ))}
            </select>
          </label>
        </div>
        {exporting && (
          <div className="banner banner-ok export-progress">
            Building Excel… {exporting.done}/{exporting.total || '…'} images
            <progress max={exporting.total || 1} value={exporting.done} />
            <button className="btn btn-sm" onClick={() => exporting.ctrl.abort()}>Cancel</button>
          </div>
        )}
        {error && <p className="banner banner-bad">{error}</p>}
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th className="col-check">
                  <input
                    type="checkbox"
                    aria-label="Select all on this page"
                    checked={allSelected}
                    onChange={() =>
                      setSelected((s) => {
                        const n = new Set(s);
                        rows.forEach((r) => (allSelected ? n.delete(r.id) : n.add(r.id)));
                        return n;
                      })
                    }
                  />
                </th>
                <th>Round start</th>
                <th>Photo set ID</th>
                <th>License plate</th>
                <th>Operator</th>
                <th>Images</th>
                <th>Storage</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <Row
                  key={r.id}
                  r={r}
                  checked={selected.has(r.id)}
                  onCheck={() =>
                    setSelected((s) => {
                      const n = new Set(s);
                      n.has(r.id) ? n.delete(r.id) : n.add(r.id);
                      return n;
                    })
                  }
                  onView={() => setViewing(r.id)}
                  onDetails={() => setDetails(r.id)}
                />
              ))}
              {!loading && rows.length === 0 && (
                <tr>
                  <td colSpan={8} className="empty">No photo sets match these filters.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <nav className="pager" aria-label="Pagination">
          <button className="btn btn-sm" disabled={!data?.prevCursor || loading} onClick={() => void load('first')}>« First</button>
          <button className="btn btn-sm" disabled={!data?.prevCursor || loading} onClick={() => void load('prev', data!.prevCursor, { offset, count: rows.length })}>‹ Prev</button>
          <span className="small muted">Page {page.toLocaleString()} of {pages.toLocaleString()}</span>
          <button className="btn btn-sm" disabled={!data?.nextCursor || loading} onClick={() => void load('next', data!.nextCursor, { offset, count: rows.length })}>Next ›</button>
          <button className="btn btn-sm" disabled={!data?.nextCursor || loading} onClick={() => void load('last')}>Last »</button>
        </nav>
      </section>

      {viewing && <SetViewer id={viewing} onClose={() => setViewing(null)} />}
      {details && <SetDetails id={details} onClose={() => setDetails(null)} onChanged={() => void load('first')} />}
    </div>
  );
}

function storageLabel(r: SetRow) {
  const pills = [];
  if (r.folderStatus === 'ready') pills.push(<span key="d" className="pill pill-ok">Drive ✓</span>);
  else pills.push(<span key="d" className="pill pill-warn">Drive: {r.folderStatus}</span>);
  pills.push(r.imagesAllowed ? <span key="r" className="pill pill-info">Recent</span> : <span key="r" className="pill">Archived · Drive only</span>);
  if (r.hidden) pills.push(<span key="h" className="pill pill-warn">Hidden</span>);
  if (r.removed) pills.push(<span key="x" className="pill pill-bad">Removed</span>);
  if (r.status !== 'finalized') pills.push(<span key="s" className="pill pill-warn">{r.status === 'open' ? 'In progress' : 'Abandoned'}</span>);
  return <div className="pills">{pills}</div>;
}

function Row({ r, checked, onCheck, onView, onDetails }: { r: SetRow; checked: boolean; onCheck: () => void; onView: () => void; onDetails: () => void }) {
  const complete = r.activeCount >= r.requiredCount;
  return (
    <tr className={checked ? 'is-selected' : ''}>
      <td className="col-check">
        <input type="checkbox" checked={checked} onChange={onCheck} aria-label={`Select ${r.publicId}`} />
      </td>
      <td className="nowrap">{formatBangkok(r.startedAt)}</td>
      <td className="mono nowrap">{r.publicId}</td>
      <td className="nowrap">
        {r.plate ? <strong>{r.plate}</strong> : <span className="muted">{r.plateDisplay}</span>}
        {r.plateSource === 'manual' && <span className="pill pill-info tiny" title="Corrected by an administrator">edited</span>}
      </td>
      <td>{r.operator.name}</td>
      <td className="nowrap">
        <span className={`pill ${complete ? 'pill-ok' : 'pill-warn'}`}>
          {r.activeCount} / {r.requiredCount}
        </span>
      </td>
      <td>{storageLabel(r)}</td>
      <td>
        <div className="row-actions">
          <button className="btn btn-sm" onClick={onView} disabled={!r.imagesAllowed} title={r.imagesAllowed ? 'View the whole set' : 'Older set — images are not loaded here. Open it in Drive.'}>
            View photo set
          </button>
          <button className="btn btn-sm" onClick={onDetails}>Details</button>
          {r.driveUrl ? (
            <a className="btn btn-sm btn-primary" href={r.driveUrl} target="_blank" rel="noopener noreferrer">
              Open set in Drive ↗
            </a>
          ) : (
            <button className="btn btn-sm" disabled>Open set in Drive</button>
          )}
        </div>
      </td>
    </tr>
  );
}

function useSetDetails(id: string) {
  const [d, setD] = useState<any>(null);
  const [error, setError] = useState('');
  const reload = useCallback(() => {
    api('GET', `/api/admin/sets/${id}`).then(setD, (e) => setError(e.message));
  }, [id]);
  useEffect(reload, [reload]);
  return { d, error, reload };
}

function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: React.ReactNode; wide?: boolean }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', k);
    return () => document.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal card ${wide ? 'modal-wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="btn btn-sm btn-icon" onClick={onClose} aria-label="Close" autoFocus>
            ✕
          </button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

/** Shows the entire set together (recent sets only). */
function SetViewer({ id, onClose }: { id: string; onClose: () => void }) {
  const { d, error } = useSetDetails(id);
  return (
    <Modal title={d ? `${d.set.publicId} · ${d.set.plateDisplay}` : 'Photo set'} onClose={onClose} wide>
      {error && <p className="banner banner-bad">{error}</p>}
      {!d && !error && <span className="spinner" />}
      {d && !d.imagesAvailable && (
        <div className="banner banner-warn">
          Images of this set are not loaded here. {d.set.driveUrl && <a className="btn btn-sm btn-primary" href={d.set.driveUrl} target="_blank" rel="noopener noreferrer">Open set in Drive ↗</a>}
        </div>
      )}
      {d?.imagesAvailable && (
        <div className="set-grid">
          {d.steps.map((s: any) => {
            const img = s.images.find((i: any) => i.active);
            return (
              <figure key={s.id} className="set-photo">
                {img?.displayUrl ? (
                  <a href={img.displayUrl} target="_blank" rel="noopener noreferrer">
                    <img src={img.displayUrl} alt={`${s.label} — ${d.set.publicId}`} loading="lazy" />
                  </a>
                ) : (
                  <div className="set-photo-missing">{s.required ? 'Missing' : 'Skipped'}</div>
                )}
                <figcaption>
                  <strong>{String(s.index + 1).padStart(2, '0')} {s.label}</strong>
                  {img && <span className="small muted">{img.source === 'camera' ? 'Camera' : 'Uploaded file'} · received {formatBangkok(img.serverReceivedAt)}</span>}
                </figcaption>
              </figure>
            );
          })}
        </div>
      )}
    </Modal>
  );
}

function SetDetails({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const me = useMe();
  const { d, error, reload } = useSetDetails(id);
  const [plate, setPlate] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  useEffect(() => setPlate(d?.plate.text ?? ''), [d?.plate.text]);

  async function act(action: string, confirmText: string) {
    if (!confirm(confirmText)) return;
    setBusy(true);
    try {
      await api('POST', `/api/admin/sets/${id}/${action}`);
      onChanged();
      reload();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={d ? `Details · ${d.set.publicId}` : 'Details'} onClose={onClose} wide>
      {error && <p className="banner banner-bad">{error}</p>}
      {!d && !error && <span className="spinner" />}
      {d && (
        <div className="details">
          {!d.recent && (
            <p className="banner banner-warn">
              Older set: images and thumbnails are not loaded in the dashboard. The full set is in its Drive folder.
            </p>
          )}
          <dl className="kv">
            <dt>Round start</dt>
            <dd>
              {formatBangkok(d.set.startedAt)} <span className="muted small">({d.startedAtSource === 'device' ? 'first image, device clock' : 'server receipt time'})</span>
            </dd>
            <dt>Operational date</dt>
            <dd>{d.set.opDate}</dd>
            <dt>Operator</dt>
            <dd>{d.set.operator.name}</dd>
            <dt>Status</dt>
            <dd>
              {d.set.status} {d.finalizedAt && <span className="muted small">· saved {formatBangkok(d.finalizedAt)}</span>}
            </dd>
            <dt>Images</dt>
            <dd>
              {d.set.activeCount} active / {d.set.requiredCount} required
            </dd>
            <dt>Workflow version</dt>
            <dd>v{d.workflowVersionId}</dd>
            <dt>Drive folder</dt>
            <dd>
              <span className="mono small">{d.drive.folderName ?? '—'}</span>{' '}
              {d.set.driveUrl && (
                <a className="btn btn-sm btn-primary" href={d.set.driveUrl} target="_blank" rel="noopener noreferrer">
                  Open set in Drive ↗
                </a>
              )}
            </dd>
          </dl>

          <section className="sub-card">
            <h3>License plate</h3>
            <p className="small muted">
              Source: {d.plate.source}
              {d.plate.confidence != null && ` · OCR confidence ${(d.plate.confidence * 100).toFixed(0)}%`} · OCR: {d.plate.ocrStatus} · Fallback label: “{d.plate.unknownLabel}”
            </p>
            {d.plate.raw && (
              <details>
                <summary className="small">Raw OCR output</summary>
                <pre className="raw">{d.plate.raw}</pre>
              </details>
            )}
            {me.can('sets.editPlate') && (
              <form
                className="inline-form"
                onSubmit={async (e) => {
                  e.preventDefault();
                  setBusy(true);
                  setMsg('');
                  try {
                    await api('PUT', `/api/admin/sets/${id}/plate`, { plate });
                    setMsg('Plate saved. The Drive folder keeps the same ID and is renamed.');
                    reload();
                    onChanged();
                  } catch (err) {
                    setMsg((err as Error).message);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                <input className="input" value={plate} onChange={(e) => setPlate(e.target.value)} placeholder="e.g. 1กข 2345" aria-label="Corrected plate" />
                <button className="btn btn-primary btn-sm" disabled={busy || d.set.status === 'open'}>Save correction</button>
              </form>
            )}
            {d.plate.history.length > 0 && (
              <ul className="history-list small">
                {d.plate.history.map((h: any) => (
                  <li key={h.id}>
                    {formatBangkok(h.at)} · {h.source === 'manual' ? `corrected by ${h.actor_name ?? '?'}` : 'OCR'}: “{h.old_text ?? '—'}” → “{h.new_text ?? '—'}”
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="sub-card">
            <h3>Images and timestamps</h3>
            <div className="table-scroll">
              <table className="table table-compact">
                <thead>
                  <tr>
                    <th>Step</th>
                    <th>Ver.</th>
                    <th>State</th>
                    <th>Source</th>
                    <th>Captured (device clock)</th>
                    <th>Server received</th>
                    <th>Stored in Drive</th>
                    <th>EXIF (unverified)</th>
                  </tr>
                </thead>
                <tbody>
                  {d.steps.flatMap((s: any) =>
                    s.images.length
                      ? s.images.map((i: any) => (
                          <tr key={i.id} className={i.active ? '' : 'muted'}>
                            <td>
                              {String(s.index + 1).padStart(2, '0')} {s.label}
                            </td>
                            <td>v{i.version}</td>
                            <td>{i.active ? (i.uploadedAt ? 'active' : 'uploading') : 'replaced'}</td>
                            <td>{i.source === 'camera' ? 'Camera' : 'Uploaded file'}</td>
                            <td>{i.source === 'camera' ? formatBangkok(i.captureTimeDevice) : <span className="muted">not available</span>}</td>
                            <td>{formatBangkok(i.serverReceivedAt)}</td>
                            <td>{i.uploadedAt ? formatBangkok(i.uploadedAt) : '—'}</td>
                            <td>{i.exifTimeUnverified ?? '—'}</td>
                          </tr>
                        ))
                      : [
                          <tr key={s.id}>
                            <td>
                              {String(s.index + 1).padStart(2, '0')} {s.label}
                            </td>
                            <td colSpan={7} className="muted">
                              {s.required ? 'missing' : 'skipped'}
                            </td>
                          </tr>,
                        ],
                  )}
                </tbody>
              </table>
            </div>
            <p className="small muted">“Captured” is the phone’s clock at the moment of capture. “Server received” and “Stored in Drive” are server times. EXIF dates of uploaded files are never treated as proof of capture time.</p>
          </section>

          {msg && <p className="banner banner-ok">{msg}</p>}

          <div className="details-actions">
            {me.can('sets.hide') && !d.hiddenAt && !d.removedAt && (
              <button className="btn" disabled={busy} onClick={() => void act('hide', 'Hide this whole set from normal history? Drive files are not touched.')}>Hide set</button>
            )}
            {me.can('sets.hide') && d.hiddenAt && !d.removedAt && (
              <button className="btn" disabled={busy} onClick={() => void act('unhide', 'Show this set in normal history again?')}>Unhide set</button>
            )}
            {me.can('sets.remove') && !d.removedAt && (
              <button className="btn btn-danger" disabled={busy} onClick={() => void act('remove', 'Remove this whole set from application history? Its Drive folder and files are NOT deleted.')}>
                Remove from history
              </button>
            )}
            {me.can('sets.restore') && d.removedAt && (
              <button className="btn" disabled={busy} onClick={() => void act('restore', 'Restore this set to application history?')}>Restore set</button>
            )}
            <span className="small muted">Hide/remove apply to the whole set and never delete anything from Google Drive.</span>
          </div>
        </div>
      )}
    </Modal>
  );
}
