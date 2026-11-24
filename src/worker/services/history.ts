import type { AuthUser, Env } from '../env';
import type { AppSettings, SetListResponse, SetRow } from '../../shared/types';
import { addDays, bangkokDate } from '../../shared/time';
import { normalizePlate } from '../../shared/plate';
import { can } from '../auth/permissions';
import { badRequest, forbidden } from '../util';
import type { DriveClient } from '../drive/types';

export const PAGE_SIZES = [20, 50, 100] as const;

export interface HistoryQuery {
  fromMs?: number;
  toMs?: number;
  q?: string;
  status?: 'finalized' | 'open' | 'abandoned' | 'all';
  visibility?: 'normal' | 'hidden' | 'removed' | 'all';
  pageSize?: number;
  cursor?: string | null;
  direction?: 'next' | 'prev' | 'first' | 'last';
  sort?: 'newest' | 'oldest';
}

/**
 * Whether images may be fetched for a set. By default only sets from the current
 * Bangkok operational day are "recent"; everything older is metadata-only and opened in
 * Drive. Administrators can widen the window, or choose 'cache' mode to also show
 * images that are still present in the R2 cache.
 */
export function isRecent(opDate: string, settings: AppSettings, now: number): boolean {
  const today = bangkokDate(now);
  const oldestRecent = addDays(today, -(Math.max(1, settings.recentImageDays) - 1));
  return opDate >= oldestRecent;
}

interface Cursor {
  s: number;
  id: string;
}
const encodeCursor = (c: Cursor) => btoa(JSON.stringify(c)).replace(/=+$/, '');
function decodeCursor(s: string): Cursor {
  try {
    const c = JSON.parse(atob(s));
    if (typeof c.s !== 'number' || typeof c.id !== 'string') throw new Error();
    return c;
  } catch {
    throw badRequest('Invalid page cursor.');
  }
}

export function buildWhere(user: AuthUser, q: HistoryQuery): { sql: string; binds: unknown[] } {
  const where: string[] = [];
  const binds: unknown[] = [];
  if (q.fromMs != null || q.toMs != null) {
    if (q.fromMs == null || q.toMs == null) throw badRequest('Both ends of the interval are required.');
    if (!Number.isFinite(q.fromMs) || !Number.isFinite(q.toMs)) throw badRequest('Invalid interval.');
    if (q.toMs < q.fromMs) throw badRequest('The end of the interval is before its start.');
    // Inclusive on both ends; the client sends toMs as the last millisecond of the end second.
    where.push('r.started_at >= ? AND r.started_at <= ?');
    binds.push(q.fromMs, q.toMs);
  }
  const status = q.status ?? 'finalized';
  if (status !== 'all') {
    where.push('r.status = ?');
    binds.push(status);
  }
  const vis = q.visibility ?? 'normal';
  if (vis === 'normal') where.push('r.removed_at IS NULL AND r.hidden_at IS NULL');
  else if (vis === 'hidden') {
    if (!can(user.role, 'sets.viewHidden')) throw forbidden();
    where.push('r.removed_at IS NULL AND r.hidden_at IS NOT NULL');
  } else if (vis === 'removed') {
    if (!can(user.role, 'sets.viewRemoved')) throw forbidden();
    where.push('r.removed_at IS NOT NULL');
  } else {
    if (!can(user.role, 'sets.viewRemoved')) throw forbidden();
  }
  const text = (q.q ?? '').trim();
  if (text) {
    if (text.length > 60) throw badRequest('Search text is too long.');
    const ors: string[] = [];
    const idMatch = /^(?:pf-?)?0*(\d{1,9})$/i.exec(text);
    if (idMatch) {
      ors.push('r.seq = ?');
      binds.push(Number(idMatch[1]));
    }
    const norm = normalizePlate(text);
    if (norm) {
      // Prefix range scans use the plate indexes (LIKE '%x%' could not).
      ors.push('(r.plate_norm >= ? AND r.plate_norm < ?)', '(r.plate_digits >= ? AND r.plate_digits < ?)');
      binds.push(norm, norm + '￿', norm, norm + '￿');
    }
    ors.push(
      `r.operator_id IN (SELECT id FROM users WHERE username LIKE ? ESCAPE '\\' OR display_name LIKE ? ESCAPE '\\')`,
    );
    const like = text.replace(/[\\%_]/g, (m) => '\\' + m) + '%';
    binds.push(like, like);
    where.push(`(${ors.join(' OR ')})`);
  }
  return { sql: where.length ? `WHERE ${where.join(' AND ')}` : '', binds };
}

export async function listSets(
  env: Env,
  user: AuthUser,
  q: HistoryQuery,
  settings: AppSettings,
  drive: Pick<DriveClient, 'folderUrl'>,
  now = Date.now(),
): Promise<SetListResponse> {
  const pageSize = q.pageSize ?? 20;
  if (!(PAGE_SIZES as readonly number[]).includes(pageSize)) throw badRequest('pageSize must be 20, 50 or 100.');
  const { sql: whereSql, binds } = buildWhere(user, q);
  const newestFirst = (q.sort ?? 'newest') === 'newest';

  // Keyset pagination on (started_at, id): constant cost per page regardless of depth,
  // so deep pages never scan the skipped rows.
  let dir = q.direction ?? 'first';
  let cursorSql = '';
  const cursorBinds: unknown[] = [];
  if ((dir === 'next' || dir === 'prev') && q.cursor) {
    const c = decodeCursor(q.cursor);
    const forward = dir === 'next';
    const op = forward === newestFirst ? '<' : '>';
    cursorSql = `${whereSql ? ' AND' : 'WHERE'} (r.started_at, r.id) ${op} (?, ?)`;
    cursorBinds.push(c.s, c.id);
  } else if (dir === 'next' || dir === 'prev') {
    dir = 'first';
  }
  // Reverse the scan order when walking backwards or jumping to the last page.
  const reverse = dir === 'prev' || dir === 'last';
  const desc = newestFirst !== reverse;
  const order = desc ? 'DESC' : 'ASC';

  const rowsSql = `SELECT r.*, u.display_name AS operator_name FROM rounds r JOIN users u ON u.id = r.operator_id
    ${whereSql}${cursorSql} ORDER BY r.started_at ${order}, r.id ${order} LIMIT ?`;
  const countSql = `SELECT COUNT(*) AS n FROM rounds r ${whereSql}`;

  const [rowsRes, countRes] = await env.DB.batch([
    env.DB.prepare(rowsSql).bind(...binds, ...cursorBinds, pageSize + 1),
    env.DB.prepare(countSql).bind(...binds),
  ]);
  let rows = rowsRes.results as any[];
  const total = (countRes.results[0] as any).n as number;
  const hasMore = rows.length > pageSize;
  rows = rows.slice(0, pageSize);
  if (reverse) rows.reverse();

  let hasNext: boolean, hasPrev: boolean;
  if (dir === 'first') {
    hasPrev = false;
    hasNext = hasMore;
  } else if (dir === 'last') {
    hasNext = false;
    hasPrev = hasMore;
  } else if (dir === 'next') {
    hasPrev = true;
    hasNext = hasMore;
  } else {
    hasNext = true;
    hasPrev = hasMore;
  }
  const first = rows[0];
  const last = rows[rows.length - 1];
  return {
    rows: rows.map((r) => toSetRow(r, settings, drive, now)),
    total,
    pageSize,
    nextCursor: hasNext && last ? encodeCursor({ s: last.started_at, id: last.id }) : null,
    prevCursor: hasPrev && first ? encodeCursor({ s: first.started_at, id: first.id }) : null,
  };
}

export function toSetRow(r: any, settings: AppSettings, drive: Pick<DriveClient, 'folderUrl'>, now: number): SetRow {
  return {
    id: r.id,
    publicId: r.public_id,
    startedAt: r.started_at,
    opDate: r.op_date,
    plate: r.plate_text ?? null,
    plateDisplay: r.plate_text || r.unknown_label,
    plateSource: r.plate_source,
    operator: { id: r.operator_id, name: r.operator_name ?? '' },
    activeCount: r.active_count,
    requiredCount: r.required_count,
    uploadedCount: r.uploaded_count,
    status: r.status,
    folderStatus: r.folder_status,
    driveUrl: r.drive_folder_id ? drive.folderUrl(r.drive_folder_id) : null,
    hidden: !!r.hidden_at,
    removed: !!r.removed_at,
    imagesAllowed: isRecent(r.op_date, settings, now) || settings.imageDisplayMode === 'cache',
  };
}
