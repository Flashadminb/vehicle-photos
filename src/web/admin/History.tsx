import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../shared/api';
import { formatBangkok, isValidTimeString } from '../../shared/time';
import type { SetListResponse, SetRow } from '../../shared/types';
import { DateRangePicker, type DateRange } from './DateRangePicker';
import { useMe } from './context';
import { exportSetsToExcel } from './excel';
import { ocrSourceLabel } from './OcrPage';

type Dir = 'first' | 'next' | 'prev' | 'last';

const STATUS_TH: Record<string, string> = { finalized: 'เสร็จสมบูรณ์', open: 'กำลังถ่าย', abandoned: 'ถูกทิ้งไว้' };
const OCR_STATUS_TH: Record<string, string> = { none: 'ยังไม่เริ่ม', disabled: 'ปิดอยู่', pending: 'รออ่าน', waiting_local: 'รอคอม Local OCR', waiting_quota: 'พักไว้ (Vision เต็ม)', done: 'อ่านแล้ว', failed: 'อ่านไม่สำเร็จ', skipped: 'ข้าม (แก้มือแล้ว)' };
const PLATE_SRC_TH: Record<string, string> = { none: 'ยังไม่มี', ocr: 'OCR', manual: 'ผู้ดูแลแก้ไข' };

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
      ? 'เวลาต้องอยู่ในรูปแบบ ชช:นน:วว'
      : range && range.start === range.end && endTime < startTime
        ? 'ถ้าเลือกวันเดียว เวลาสิ้นสุดต้องอยู่หลังเวลาเริ่มต้น'
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
      if ((e as Error).name !== 'AbortError') alert(`ส่งออกไม่สำเร็จ: ${(e as Error).message}`);
    } finally {
      setExporting(null);
    }
  }

  return (
    <div className="page">
      <div className="page-head">
        <h1>ประวัติชุดรูป</h1>
        <span className="muted small">1 แถว = 1 ชุดรูปที่สมบูรณ์ · เวลาเป็นเวลาประเทศไทย (Asia/Bangkok)</span>
      </div>

      <section className="card filters" aria-label="ตัวกรอง">
        <div className="field">
          <span>ช่วงวันที่</span>
          <DateRangePicker value={range} onApply={setRange} today={me.today} />
        </div>
        <label className="field">
          <span>เวลาเริ่มต้น</span>
          <input className="input" type="time" step={1} value={startTime} onChange={(e) => setStartTime(e.target.value.length === 5 ? e.target.value + ':00' : e.target.value)} disabled={!range} />
        </label>
        <label className="field">
          <span>เวลาสิ้นสุด</span>
          <input className="input" type="time" step={1} value={endTime} onChange={(e) => setEndTime(e.target.value.length === 5 ? e.target.value + ':00' : e.target.value)} disabled={!range} />
        </label>
        <label className="field grow">
          <span>ค้นหาทะเบียน ผู้ถ่าย หรือรหัสชุด</span>
          <input className="input" type="search" placeholder="เช่น กข 1234, 1234, PF-000123, สมชาย" value={q} onChange={(e) => setQ(e.target.value)} />
        </label>
        <label className="field">
          <span>สถานะ</span>
          <select className="input" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="finalized">เสร็จสมบูรณ์</option>
            <option value="open">กำลังถ่าย</option>
            <option value="abandoned">ถูกทิ้งไว้</option>
            <option value="all">ทั้งหมด</option>
          </select>
        </label>
        {me.can('sets.viewHidden') && (
          <label className="field">
            <span>การแสดงผล</span>
            <select className="input" value={visibility} onChange={(e) => setVisibility(e.target.value)}>
              <option value="normal">ปกติ</option>
              <option value="hidden">ซ่อนอยู่</option>
              {me.can('sets.viewRemoved') && <option value="removed">ลบออกจากประวัติแล้ว</option>}
              {me.can('sets.viewRemoved') && <option value="all">ทั้งหมด</option>}
            </select>
          </label>
        )}
        {range && (
          <p className="small muted filters-note">
            ช่วงเวลา: <strong>{range.start} {startTime}</strong> → <strong>{range.end} {endTime}</strong> (เป็นช่วงต่อเนื่องช่วงเดียว รวมวินาทีสุดท้าย)
          </p>
        )}
        {timeError && <p className="banner banner-bad small filters-note" role="alert">{timeError}</p>}
      </section>

      <section className="card table-card">
        <div className="table-toolbar">
          <span className="small muted" aria-live="polite">
            {loading ? <span className="spinner" /> : total === 0 ? 'ไม่พบรายการ' : `แสดง ${offset + 1}–${offset + rows.length} จาก ${total.toLocaleString()} ชุด`}
          </span>
          <span style={{ flex: 1 }} />
          {me.can('sets.export') && (
            <button className="btn btn-sm" disabled={selected.size === 0 || !!exporting || selected.size > me.settings.exportMaxSets} onClick={() => void runExport()} title={`ได้สูงสุด ${me.settings.exportMaxSets} ชุดต่อครั้ง`}>
              ⬇ ส่งออก Excel {selected.size ? `(${selected.size} ชุด)` : ''}
            </button>
          )}
          <label className="field-inline small">
            เรียง
            <select className="input input-sm" value={sort} onChange={(e) => setSort(e.target.value as 'newest' | 'oldest')}>
              <option value="newest">ใหม่สุดก่อน</option>
              <option value="oldest">เก่าสุดก่อน</option>
            </select>
          </label>
          <label className="field-inline small">
            แถวต่อหน้า
            <select className="input input-sm" value={pageSize} onChange={(e) => setPageSize(Number(e.target.value))}>
              {[20, 50, 100].map((n) => (
                <option key={n}>{n}</option>
              ))}
            </select>
          </label>
        </div>
        {exporting && (
          <div className="banner banner-ok export-progress">
            กำลังสร้างไฟล์ Excel… {exporting.done}/{exporting.total || '…'} รูป
            <progress max={exporting.total || 1} value={exporting.done} />
            <button className="btn btn-sm" onClick={() => exporting.ctrl.abort()}>ยกเลิก</button>
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
                    aria-label="เลือกทั้งหมดในหน้านี้"
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
                <th>เริ่มรอบ</th>
                <th>รหัสชุดรูป</th>
                <th>ทะเบียนรถ</th>
                <th>ผู้ถ่าย</th>
                <th>รูป</th>
                <th>การจัดเก็บ</th>
                <th>การจัดการ</th>
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
                  <td colSpan={8} className="empty">ไม่มีชุดรูปที่ตรงกับตัวกรอง</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <nav className="pager" aria-label="เปลี่ยนหน้า">
          <button className="btn btn-sm" disabled={!data?.prevCursor || loading} onClick={() => void load('first')}>« หน้าแรก</button>
          <button className="btn btn-sm" disabled={!data?.prevCursor || loading} onClick={() => void load('prev', data!.prevCursor, { offset, count: rows.length })}>‹ ก่อนหน้า</button>
          <span className="small muted">หน้า {page.toLocaleString()} จาก {pages.toLocaleString()}</span>
          <button className="btn btn-sm" disabled={!data?.nextCursor || loading} onClick={() => void load('next', data!.nextCursor, { offset, count: rows.length })}>ถัดไป ›</button>
          <button className="btn btn-sm" disabled={!data?.nextCursor || loading} onClick={() => void load('last')}>หน้าสุดท้าย »</button>
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
  else pills.push(<span key="d" className="pill pill-warn">Drive: {r.folderStatus === 'pending' ? 'รอสร้างโฟลเดอร์' : r.folderStatus === 'error' ? 'ผิดพลาด' : r.folderStatus}</span>);
  pills.push(r.imagesAllowed ? <span key="r" className="pill pill-info">ล่าสุด</span> : <span key="r" className="pill">เก่า · ดูใน Drive</span>);
  if (r.hidden) pills.push(<span key="h" className="pill pill-warn">ซ่อนอยู่</span>);
  if (r.removed) pills.push(<span key="x" className="pill pill-bad">ลบจากประวัติแล้ว</span>);
  if (r.driveTrashed) pills.push(<span key="t" className="pill pill-bad" title="รูปอยู่ในถังขยะ Google Drive (กู้คืนได้ภายใน 30 วัน)">รูปอยู่ในถังขยะ</span>);
  if (r.status !== 'finalized') pills.push(<span key="s" className="pill pill-warn">{r.status === 'open' ? 'กำลังถ่าย' : 'ถูกทิ้งไว้'}</span>);
  return <div className="pills">{pills}</div>;
}

function Row({ r, checked, onCheck, onView, onDetails }: { r: SetRow; checked: boolean; onCheck: () => void; onView: () => void; onDetails: () => void }) {
  const complete = r.activeCount >= r.requiredCount;
  return (
    <tr className={checked ? 'is-selected' : ''}>
      <td className="col-check">
        <input type="checkbox" checked={checked} onChange={onCheck} aria-label={`เลือก ${r.publicId}`} />
      </td>
      <td className="nowrap">{formatBangkok(r.startedAt)}</td>
      <td className="mono nowrap">{r.publicId}</td>
      <td className="nowrap">
        {r.plate ? <strong>{r.plate}</strong> : <span className="muted">{r.plateDisplay}</span>}
        {r.plateSource === 'manual' && <span className="pill pill-info tiny" title="แก้ไขโดยผู้ดูแล">แก้ไขแล้ว</span>}
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
          <button className="btn btn-sm" onClick={onView} disabled={!r.imagesAllowed} title={r.imagesAllowed ? 'ดูรูปทั้งชุด' : 'ชุดเก่า — ไม่โหลดรูปในหน้านี้ กรุณาเปิดใน Drive'}>
            ดูชุดรูป
          </button>
          <button className="btn btn-sm" onClick={onDetails}>รายละเอียด</button>
          {r.driveUrl ? (
            <a className="btn btn-sm btn-primary" href={r.driveUrl} target="_blank" rel="noopener noreferrer">
              เปิดชุดใน Drive ↗
            </a>
          ) : (
            <button className="btn btn-sm" disabled>เปิดชุดใน Drive</button>
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
          <button className="btn btn-sm btn-icon" onClick={onClose} aria-label="ปิด" autoFocus>
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
    <Modal title={d ? `${d.set.publicId} · ${d.set.plateDisplay}` : 'ชุดรูป'} onClose={onClose} wide>
      {error && <p className="banner banner-bad">{error}</p>}
      {!d && !error && <span className="spinner" />}
      {d && !d.imagesAvailable && (
        <div className="banner banner-warn">
          ชุดนี้ไม่โหลดรูปในหน้านี้ {d.set.driveUrl && <a className="btn btn-sm btn-primary" href={d.set.driveUrl} target="_blank" rel="noopener noreferrer">เปิดชุดใน Drive ↗</a>}
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
                  <div className="set-photo-missing">{s.required ? 'ไม่มีรูป' : 'ข้ามขั้นตอน'}</div>
                )}
                <figcaption>
                  <strong>{String(s.index + 1).padStart(2, '0')} {s.label}</strong>
                  {img && <span className="small muted">{img.source === 'camera' ? 'กล้อง' : 'อัปโหลดไฟล์'} · เซิร์ฟเวอร์รับ {formatBangkok(img.serverReceivedAt)}</span>}
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
    <Modal title={d ? `รายละเอียด · ${d.set.publicId}` : 'รายละเอียด'} onClose={onClose} wide>
      {error && <p className="banner banner-bad">{error}</p>}
      {!d && !error && <span className="spinner" />}
      {d && (
        <div className="details">
          {!d.recent && (
            <p className="banner banner-warn">
              ชุดเก่า: แดชบอร์ดจะไม่โหลดรูปและภาพย่อ ดูรูปครบทั้งชุดได้ในโฟลเดอร์ Drive
            </p>
          )}
          <dl className="kv">
            <dt>เริ่มรอบ</dt>
            <dd>
              {formatBangkok(d.set.startedAt)} <span className="muted small">({d.startedAtSource === 'device' ? 'รูปแรก ตามนาฬิกาเครื่อง' : 'เวลาที่เซิร์ฟเวอร์รับ'})</span>
            </dd>
            <dt>วันที่ปฏิบัติงาน</dt>
            <dd>{d.set.opDate}</dd>
            <dt>ผู้ถ่าย</dt>
            <dd>{d.set.operator.name}</dd>
            <dt>สถานะ</dt>
            <dd>
              {STATUS_TH[d.set.status] ?? d.set.status} {d.finalizedAt && <span className="muted small">· บันทึกเมื่อ {formatBangkok(d.finalizedAt)}</span>}
            </dd>
            <dt>รูป</dt>
            <dd>
              ใช้งาน {d.set.activeCount} รูป / บังคับ {d.set.requiredCount} รูป
            </dd>
            <dt>เวอร์ชันขั้นตอน</dt>
            <dd>v{d.workflowVersionId}</dd>
            <dt>โฟลเดอร์ Drive</dt>
            <dd>
              <span className="mono small">{d.drive.folderName ?? '—'}</span>{' '}
              {d.set.driveUrl && (
                <a className="btn btn-sm btn-primary" href={d.set.driveUrl} target="_blank" rel="noopener noreferrer">
                  เปิดชุดใน Drive ↗
                </a>
              )}
            </dd>
          </dl>

          <section className="sub-card">
            <h3>ทะเบียนรถ</h3>
            <p className="small muted">
              ที่มา: {PLATE_SRC_TH[d.plate.source] ?? d.plate.source}
              {d.plate.confidence != null && ` · ความมั่นใจ OCR ${(d.plate.confidence * 100).toFixed(0)}%`} · สถานะ OCR: {OCR_STATUS_TH[d.plate.ocrStatus] ?? d.plate.ocrStatus} · คำแทนเมื่อไม่ทราบทะเบียน: “{d.plate.unknownLabel}”
            </p>
            {d.plate.raw && (
              <details>
                <summary className="small">ผลลัพธ์ OCR ดิบ</summary>
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
                    setMsg('บันทึกทะเบียนแล้ว โฟลเดอร์ใน Drive ถูกเปลี่ยนชื่อ โดยยังเป็นโฟลเดอร์เดิม (ID เดิม)');
                    reload();
                    onChanged();
                  } catch (err) {
                    setMsg((err as Error).message);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                <input className="input" value={plate} onChange={(e) => setPlate(e.target.value)} placeholder="เช่น 1กข 2345" aria-label="ทะเบียนที่แก้ไข" />
                <button className="btn btn-primary btn-sm" disabled={busy || d.set.status === 'open'}>บันทึกการแก้ไข</button>
              </form>
            )}
            {me.can('sets.editPlate') && d.set.status !== 'open' && (
              <div className="row-actions">
                <button
                  className="btn btn-sm"
                  disabled={busy}
                  onClick={async () => {
                    setMsg('');
                    try {
                      await api('POST', `/api/admin/sets/${id}/ocr`, { target: 'auto' });
                      setMsg('ส่งอ่านป้ายใหม่แล้ว ผลจะขึ้นภายในไม่กี่วินาทีถึงไม่กี่นาที');
                      setTimeout(reload, 4000);
                    } catch (err) {
                      setMsg((err as Error).message);
                    }
                  }}
                >
                  อ่านป้ายใหม่
                </button>
                <button
                  className="btn btn-sm"
                  disabled={busy}
                  onClick={async () => {
                    setMsg('');
                    try {
                      await api('POST', `/api/admin/sets/${id}/ocr`, { target: 'local' });
                      setMsg('ส่งให้คอม Local OCR แล้ว จะอ่านเมื่อมีคอมเปิดอยู่');
                    } catch (err) {
                      setMsg((err as Error).message);
                    }
                  }}
                >
                  อ่านด้วย Local OCR
                </button>
                {d.plate.source === 'manual' && <span className="small muted">ทะเบียนนี้แก้มือแล้ว ผล OCR ใหม่จะไม่ทับ</span>}
              </div>
            )}
            {d.plate.history.length > 0 && (
              <ul className="history-list small">
                {d.plate.history.map((h: any) => (
                  <li key={h.id}>
                    {formatBangkok(h.at)} · {h.source === 'manual' ? `แก้ไขโดย ${h.actor_name ?? '?'}` : ocrSourceLabel(h.source)}: “{h.old_text ?? '—'}” → “{h.new_text ?? '—'}”
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="sub-card">
            <h3>รูปและเวลา</h3>
            <div className="table-scroll">
              <table className="table table-compact">
                <thead>
                  <tr>
                    <th>ขั้นตอน</th>
                    <th>ครั้งที่</th>
                    <th>สถานะ</th>
                    <th>ที่มา</th>
                    <th>เวลาถ่าย (นาฬิกาเครื่อง)</th>
                    <th>เซิร์ฟเวอร์รับ</th>
                    <th>บันทึกลง Drive</th>
                    <th>EXIF (ไม่ได้ยืนยัน)</th>
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
                            <td>{i.active ? (i.uploadedAt ? 'ใช้งาน' : 'กำลังอัปโหลด') : 'ถูกแทนที่'}</td>
                            <td>{i.source === 'camera' ? 'กล้อง' : 'อัปโหลดไฟล์'}</td>
                            <td>{i.source === 'camera' ? formatBangkok(i.captureTimeDevice) : <span className="muted">ไม่มีข้อมูล</span>}</td>
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
                              {s.required ? 'ไม่มีรูป' : 'ข้ามขั้นตอน'}
                            </td>
                          </tr>,
                        ],
                  )}
                </tbody>
              </table>
            </div>
            <p className="small muted">“เวลาถ่าย” คือนาฬิกาของมือถือขณะถ่าย ส่วน “เซิร์ฟเวอร์รับ” และ “บันทึกลง Drive” เป็นเวลาของเซิร์ฟเวอร์ วันที่ EXIF ในไฟล์ที่อัปโหลดไม่ถือเป็นหลักฐานเวลาถ่ายจริง</p>
          </section>

          {msg && <p className="banner banner-ok">{msg}</p>}

          <div className="details-actions">
            {me.can('sets.hide') && !d.hiddenAt && !d.removedAt && (
              <button className="btn" disabled={busy} onClick={() => void act('hide', 'ซ่อนชุดนี้ทั้งชุดจากประวัติปกติ? ไฟล์ใน Drive จะไม่ถูกแตะต้อง')}>ซ่อนชุด</button>
            )}
            {me.can('sets.hide') && d.hiddenAt && !d.removedAt && (
              <button className="btn" disabled={busy} onClick={() => void act('unhide', 'แสดงชุดนี้ในประวัติปกติอีกครั้ง?')}>เลิกซ่อน</button>
            )}
            {me.can('sets.remove') && !d.removedAt && (
              <button className="btn btn-danger" disabled={busy} onClick={() => void act('remove', 'ลบชุดนี้ทั้งชุดออกจากประวัติในแอป? โฟลเดอร์และไฟล์ใน Drive จะไม่ถูกลบ')}>
                ลบออกจากประวัติ
              </button>
            )}
            {me.can('sets.restore') && d.removedAt && (
              <button className="btn" disabled={busy} onClick={() => void act('restore', 'กู้คืนชุดนี้กลับเข้าประวัติ?')}>กู้คืนชุด</button>
            )}
            <span className="small muted">การซ่อน/ลบมีผลกับทั้งชุด และไม่ลบอะไรออกจาก Google Drive</span>
          </div>

          {me.can('drive.trash') && d.set.status !== 'open' && d.drive.folderId && (
            <section className="card section details-danger">
              <h3>พื้นที่ Google Drive</h3>
              {d.driveTrashedAt ? (
                <>
                  <p className="small">
                    รูปของชุดนี้ถูกย้ายไปถังขยะ Drive เมื่อ {formatBangkok(d.driveTrashedAt)} · กู้คืนได้ภายใน 30 วัน (หลังจากนั้น Google ลบถาวรเอง)
                  </p>
                  <button
                    className="btn"
                    disabled={busy}
                    onClick={async () => {
                      setBusy(true);
                      try {
                        await api('POST', `/api/admin/sets/${id}/drive-restore`);
                        setMsg('กู้คืนรูปจากถังขยะ Drive แล้ว');
                        onChanged();
                        reload();
                      } catch (e) {
                        setMsg((e as Error).message);
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    กู้คืนรูปจากถังขยะ
                  </button>
                </>
              ) : (
                <>
                  <p className="small muted">
                    ย้ายโฟลเดอร์รูปของชุดนี้ไปถังขยะ Google Drive เพื่อคืนพื้นที่ ข้อมูลชุด (ทะเบียน เวลา ผู้ถ่าย) ยังอยู่ในประวัติ กู้คืนได้ภายใน 30 วัน
                  </p>
                  <button
                    className="btn btn-danger"
                    disabled={busy}
                    onClick={async () => {
                      const typed = prompt(`พิมพ์รหัสชุด ${d.set.publicId} เพื่อยืนยันย้ายรูปทั้งหมดของชุดนี้ไปถังขยะ Drive`);
                      if (typed == null) return;
                      if (typed.trim().toUpperCase() !== d.set.publicId.toUpperCase()) return setMsg('รหัสชุดไม่ตรง ยกเลิกแล้ว');
                      setBusy(true);
                      try {
                        await api('POST', `/api/admin/sets/${id}/drive-trash`);
                        setMsg('ย้ายรูปไปถังขยะ Drive แล้ว');
                        onChanged();
                        reload();
                      } catch (e) {
                        setMsg((e as Error).message);
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    ย้ายรูปชุดนี้ไปถังขยะ Drive
                  </button>
                </>
              )}
            </section>
          )}
        </div>
      )}
    </Modal>
  );
}
