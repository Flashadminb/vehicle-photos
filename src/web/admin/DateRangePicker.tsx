import { useEffect, useRef, useState } from 'react';
import { compareDates } from '../../shared/time';

export interface DateRange {
  start: string; // YYYY-MM-DD
  end: string;
}

const MONTHS = ['มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน', 'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'];
const MONTHS_SHORT = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
const DOW = ['จ', 'อ', 'พ', 'พฤ', 'ศ', 'ส', 'อา'];
const pad = (n: number) => String(n).padStart(2, '0');
const iso = (y: number, m: number, d: number) => `${y}-${pad(m + 1)}-${pad(d)}`;

export function formatDate(d: string) {
  const [y, m, day] = d.split('-').map(Number);
  return `${day} ${MONTHS_SHORT[m - 1]} ${y}`;
}

export function formatRange(r: DateRange | null) {
  if (!r) return 'ทุกวันที่';
  return r.start === r.end ? formatDate(r.start) : `${formatDate(r.start)} – ${formatDate(r.end)}`;
}

/**
 * ONE button that opens ONE calendar. First click = start, second click = end
 * (clicking an earlier day swaps them), the range is highlighted, the same day may
 * be both ends, months/years can be crossed, and "Apply date range" confirms.
 */
export function DateRangePicker({ value, onApply, today }: { value: DateRange | null; onApply: (r: DateRange | null) => void; today: string }) {
  const [open, setOpen] = useState(false);
  const [draftStart, setDraftStart] = useState<string | null>(value?.start ?? null);
  const [draftEnd, setDraftEnd] = useState<string | null>(value?.end ?? null);
  const [hover, setHover] = useState<string | null>(null);
  const init = (value?.end ?? today).split('-').map(Number);
  const [view, setView] = useState({ y: init[0], m: init[1] - 1 });
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  function openPicker() {
    setDraftStart(value?.start ?? null);
    setDraftEnd(value?.end ?? null);
    const v = (value?.end ?? today).split('-').map(Number);
    setView({ y: v[0], m: v[1] - 1 });
    setOpen(true);
  }

  function pick(d: string) {
    if (!draftStart || draftEnd) {
      setDraftStart(d);
      setDraftEnd(null);
    } else if (compareDates(d, draftStart) < 0) {
      setDraftEnd(draftStart);
      setDraftStart(d);
    } else {
      setDraftEnd(d);
    }
  }

  const effEnd = draftEnd ?? (draftStart && hover && compareDates(hover, draftStart) >= 0 ? hover : null);
  const inRange = (d: string) => !!draftStart && !!effEnd && compareDates(d, draftStart) >= 0 && compareDates(d, effEnd) <= 0;

  const months = [view, view.m === 11 ? { y: view.y + 1, m: 0 } : { y: view.y, m: view.m + 1 }];
  const shift = (delta: number) =>
    setView((v) => {
      const t = v.y * 12 + v.m + delta;
      return { y: Math.floor(t / 12), m: ((t % 12) + 12) % 12 };
    });

  return (
    <div className="drp" ref={ref}>
      <button type="button" className="btn drp-button" aria-haspopup="dialog" aria-expanded={open} onClick={() => (open ? setOpen(false) : openPicker())}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
          <rect x="3" y="5" width="18" height="16" rx="3" />
          <path d="M3 10h18M8 3v4M16 3v4" />
        </svg>
        {formatRange(value)}
      </button>
      {open && (
        <div className="drp-pop card" role="dialog" aria-label="เลือกช่วงวันที่">
          <div className="drp-head">
            <button type="button" className="btn btn-sm btn-icon" onClick={() => shift(-12)} aria-label="ปีก่อนหน้า">«</button>
            <button type="button" className="btn btn-sm btn-icon" onClick={() => shift(-1)} aria-label="เดือนก่อนหน้า">‹</button>
            <span className="drp-hint small muted">
              {!draftStart ? 'คลิกวันเริ่มต้น' : !draftEnd ? 'คลิกวันสิ้นสุด' : formatRange({ start: draftStart, end: draftEnd })}
            </span>
            <button type="button" className="btn btn-sm btn-icon" onClick={() => shift(1)} aria-label="เดือนถัดไป">›</button>
            <button type="button" className="btn btn-sm btn-icon" onClick={() => shift(12)} aria-label="ปีถัดไป">»</button>
          </div>
          <div className="drp-months">
            {months.map(({ y, m }) => {
              const first = new Date(Date.UTC(y, m, 1)).getUTCDay(); // 0 = Sun
              const offset = (first + 6) % 7;
              const days = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
              const cells: (string | null)[] = [...Array(offset).fill(null), ...Array.from({ length: days }, (_, i) => iso(y, m, i + 1))];
              return (
                <div key={`${y}-${m}`} className="drp-month">
                  <div className="drp-title">
                    {MONTHS[m]} {y}
                  </div>
                  <div className="drp-grid" role="grid">
                    {DOW.map((d) => (
                      <span key={d} className="drp-dow" aria-hidden>
                        {d}
                      </span>
                    ))}
                    {cells.map((d, i) =>
                      d ? (
                        <button
                          key={d}
                          type="button"
                          className={[
                            'drp-day',
                            inRange(d) ? 'in-range' : '',
                            d === draftStart ? 'is-start' : '',
                            d === effEnd ? 'is-end' : '',
                            d === today ? 'is-today' : '',
                          ].join(' ')}
                          aria-pressed={d === draftStart || d === draftEnd}
                          aria-label={formatDate(d)}
                          onClick={() => pick(d)}
                          onMouseEnter={() => setHover(d)}
                          onFocus={() => setHover(d)}
                        >
                          {Number(d.slice(8))}
                        </button>
                      ) : (
                        <span key={`e${i}`} />
                      ),
                    )}
                  </div>
                </div>
              );
            })}
          </div>
          <div className="drp-foot">
            <button type="button" className="btn btn-sm" onClick={() => { setDraftStart(today); setDraftEnd(today); }}>วันนี้</button>
            <button type="button" className="btn btn-sm" onClick={() => { onApply(null); setOpen(false); }}>ทุกวันที่</button>
            <span style={{ flex: 1 }} />
            <button type="button" className="btn btn-sm" onClick={() => setOpen(false)}>ยกเลิก</button>
            <button
              type="button"
              className="btn btn-sm btn-primary"
              disabled={!draftStart}
              onClick={() => {
                if (!draftStart) return;
                onApply({ start: draftStart, end: draftEnd ?? draftStart });
                setOpen(false);
              }}
            >
              ใช้ช่วงวันที่นี้
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
