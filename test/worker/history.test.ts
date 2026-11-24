import { beforeAll, describe, expect, it } from 'vitest';
import { createUser, loggedIn, rid, testEnv, Client, recordingDrive, ORIGIN, putToDrive } from './helpers';
import { bangkokToUtc } from '../../src/shared/time';
import { publicIdFromSeq } from '../../src/shared/names';
import { getCurrentWorkflow } from '../../src/worker/services/config';
import { normalizePlate, plateDigits } from '../../src/shared/plate';

let operatorId: string;
let admin: Client;
const TAG = 'HIST';

/** Insert a finalized round directly (fast fixture for large datasets). */
async function insertRound(startedAt: number, plate: string | null, opts: { opDate?: string } = {}) {
  const wf = await getCurrentWorkflow(testEnv);
  const seq = (await testEnv.DB.prepare(`UPDATE counters SET value = value + 1 WHERE name = 'round' RETURNING value`).first<{ value: number }>())!.value;
  const id = rid();
  const d = new Date(startedAt + 7 * 3600_000);
  const opDate = opts.opDate ?? d.toISOString().slice(0, 10);
  await testEnv.DB.prepare(
    `INSERT INTO rounds (id, seq, public_id, client_round_id, operator_id, workflow_version_id, started_at, started_at_source, created_at, op_date,
       status, required_count, active_count, uploaded_count, plate_text, plate_norm, plate_digits, plate_source, unknown_label, drive_folder_id, folder_status, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'server', ?, ?, 'finalized', 3, 3, 3, ?, ?, ?, ?, 'ไม่ระบุ', ?, 'ready', ?)`,
  )
    .bind(id, seq, publicIdFromSeq(seq), rid(), operatorId, wf.id, startedAt, startedAt, opDate, plate, plate ? normalizePlate(plate) : null, plate ? plateDigits(plate) : null, plate ? 'ocr' : 'none', `folder-${id}`, startedAt)
    .run();
  return { id, seq };
}

beforeAll(async () => {
  const op = await createUser('operator');
  operatorId = op.user.id;
  await testEnv.DB.prepare(`UPDATE users SET display_name = 'Somchai ${TAG}' WHERE id = ?`).bind(operatorId).run();
  // 250 rounds, one every 20 minutes starting 2026-07-09 00:10 Bangkok (~3.5 days).
  const t0 = bangkokToUtc('2026-07-09', '00:10:00');
  const stmts = [];
  for (let i = 0; i < 250; i++) stmts.push(insertRound(t0 + i * 20 * 60_000, i % 10 === 0 ? null : `กข ${String(1000 + i)}`));
  await Promise.all(stmts);
  admin = (await loggedIn('admin', 'admin')).client;
});

const q = (params: Record<string, string>) => `/api/admin/sets?${new URLSearchParams({ q: '', ...params })}`;

describe('history filters', () => {
  it('interprets date + time as ONE continuous interval (not a daily window)', async () => {
    // July 10 08:30:00 → July 12 17:45:00, inclusive.
    const r = await admin.json('GET', q({ startDate: '2026-07-10', endDate: '2026-07-12', startTime: '08:30:00', endTime: '17:45:00', pageSize: '100', status: 'all' }));
    expect(r.status).toBe(200);
    const from = bangkokToUtc('2026-07-10', '08:30:00');
    const to = bangkokToUtc('2026-07-12', '17:45:00') + 999;
    const t0 = bangkokToUtc('2026-07-09', '00:10:00');
    const expected = Array.from({ length: 250 }, (_, i) => t0 + i * 1_200_000).filter((t) => t >= from && t <= to).length;
    expect(r.body.total).toBe(expected);
    // A daily-window interpretation would exclude e.g. July 11 03:10 — the continuous interval includes it.
    const night = bangkokToUtc('2026-07-11', '03:10:00');
    const all: number[] = [];
    let cursor: string | null = null;
    let dir = 'first';
    do {
      const page: any = await admin.json('GET', q({ startDate: '2026-07-10', endDate: '2026-07-12', startTime: '08:30:00', endTime: '17:45:00', pageSize: '100', status: 'all', ...(cursor ? { cursor, direction: dir } : {}) }));
      all.push(...page.body.rows.map((x: any) => x.startedAt));
      cursor = page.body.nextCursor;
      dir = 'next';
    } while (cursor);
    expect(all).toContain(night);
    expect(all.length).toBe(expected);
  });

  it('handles inclusive boundaries to the second', async () => {
    const exact = bangkokToUtc('2026-07-09', '00:30:00'); // a round starts exactly here
    const inc = await admin.json('GET', q({ startDate: '2026-07-09', endDate: '2026-07-09', startTime: '00:30:00', endTime: '00:30:00' }));
    expect(inc.body.total).toBe(1);
    expect(inc.body.rows[0].startedAt).toBe(exact);
    const exc = await admin.json('GET', q({ startDate: '2026-07-09', endDate: '2026-07-09', startTime: '00:30:01', endTime: '00:49:59' }));
    expect(exc.body.total).toBe(0);
  });

  it('same-day ranges work and reversed intervals are rejected', async () => {
    const day = await admin.json('GET', q({ startDate: '2026-07-10', endDate: '2026-07-10' }));
    expect(day.body.total).toBe(72); // every 20 minutes for 24h
    const bad = await admin.json('GET', q({ startDate: '2026-07-10', endDate: '2026-07-10', startTime: '10:00:00', endTime: '09:00:00' }));
    expect(bad.status).toBe(400);
    const badDate = await admin.json('GET', q({ startDate: '2026-02-30', endDate: '2026-03-01' }));
    expect(badDate.status).toBe(400);
  });

  it('supports ranges across months and years', async () => {
    const r = await admin.json('GET', q({ startDate: '2025-12-30', endDate: '2026-07-09', startTime: '00:00:00', endTime: '01:00:00' }));
    expect(r.body.total).toBe(3); // 00:10, 00:30, 00:50 on July 9
  });

  it('searches by plate (letters+digits or digits), photo set ID and operator', async () => {
    const plate = await admin.json('GET', q({ q: 'กข1005' }));
    expect(plate.body.rows.map((r: any) => r.plate)).toContain('กข 1005');
    const digits = await admin.json('GET', q({ q: '1005' }));
    expect(digits.body.rows.some((r: any) => r.plate === 'กข 1005')).toBe(true);
    const anyRow = (await admin.json('GET', q({ startDate: '2026-07-09', endDate: '2026-07-09', pageSize: '20' }))).body.rows[0];
    const byId = await admin.json('GET', q({ q: anyRow.publicId }));
    expect(byId.body.rows.map((r: any) => r.id)).toContain(anyRow.id);
    const byOperator = await admin.json('GET', q({ q: `Somchai ${TAG}`, pageSize: '20' }));
    expect(byOperator.body.total).toBe(250);
  });
});

describe('server-side pagination', () => {
  const range = { startDate: '2026-07-09', endDate: '2026-07-13' };

  it('returns bounded pages with totals, newest first by default', async () => {
    const p1 = await admin.json('GET', q({ ...range, pageSize: '20' }));
    expect(p1.body.rows).toHaveLength(20);
    expect(p1.body.total).toBe(250);
    const times = p1.body.rows.map((r: any) => r.startedAt);
    expect([...times].sort((a, b) => b - a)).toEqual(times);
    expect(p1.body.prevCursor).toBeNull();
    expect(p1.body.nextCursor).toBeTruthy();
  });

  it('walks forward and back consistently, and jumps to the last page', async () => {
    const p1 = await admin.json('GET', q({ ...range, pageSize: '50' }));
    const p2 = await admin.json('GET', q({ ...range, pageSize: '50', cursor: p1.body.nextCursor, direction: 'next' }));
    const back = await admin.json('GET', q({ ...range, pageSize: '50', cursor: p2.body.prevCursor, direction: 'prev' }));
    expect(back.body.rows.map((r: any) => r.id)).toEqual(p1.body.rows.map((r: any) => r.id));
    const last = await admin.json('GET', q({ ...range, pageSize: '100', direction: 'last' }));
    expect(last.body.rows).toHaveLength(100);
    expect(last.body.nextCursor).toBeNull();
    expect(last.body.rows[99].startedAt).toBe(bangkokToUtc('2026-07-09', '00:10:00'));
    const ids = new Set([...p1.body.rows, ...p2.body.rows].map((r: any) => r.id));
    expect(ids.size).toBe(100);
  });

  it('only accepts 20, 50 or 100 rows per page', async () => {
    expect((await admin.json('GET', q({ pageSize: '5000' }))).status).toBe(400);
  });

  it('queries use the date index (no full table scan)', async () => {
    const plan = await testEnv.DB.prepare(
      `EXPLAIN QUERY PLAN SELECT * FROM rounds r WHERE r.started_at >= ? AND r.started_at <= ? AND r.status = 'finalized' AND r.removed_at IS NULL AND r.hidden_at IS NULL ORDER BY r.started_at DESC, r.id DESC LIMIT 21`,
    )
      .bind(0, 1)
      .all<any>();
    const detail = plan.results.map((r) => r.detail).join(' | ');
    expect(detail).toMatch(/USING (COVERING )?INDEX/);
    expect(detail).not.toMatch(/^SCAN r$/);
  });
});

describe('old sets', () => {
  it('never expose image URLs, and image requests are refused', async () => {
    const { client: field, user } = await loggedIn('field', 'operator');
    const wf = await getCurrentWorkflow(testEnv);
    // A real uploaded round...
    const round = rid();
    let roundId = '';
    for (const step of wf.steps) {
      const b = await field.json('POST', '/api/field/images/begin', { clientRoundId: round, clientImageId: rid(), workflowVersionId: wf.id, stepId: step.id, source: 'camera', acceptedAtDevice: Date.now() });
      roundId = b.body.round.id;
      const d = await putToDrive(field, b.body.uploads.display.url);
      const o = await putToDrive(field, b.body.uploads.original.url);
      await field.json('POST', `/api/field/images/${b.body.image.id}/complete`, { displayFileId: d, originalFileId: o });
      await field.req('PUT', `/api/field/images/${b.body.image.id}/cache/thumb`, new Uint8Array([1, 2, 3]).buffer as ArrayBuffer);
    }
    await field.json('POST', `/api/field/rounds/${roundId}/finalize`, { idempotencyKey: 'x' });

    // Today: images available.
    const today = await admin.json('GET', `/api/admin/sets/${roundId}`);
    expect(today.body.recent).toBe(true);
    const imgId = today.body.steps[0].images[0].id;
    expect(today.body.steps[0].images[0].thumbUrl).toBeTruthy();
    expect((await admin.req('GET', `/api/admin/images/${imgId}/thumb`)).status).toBe(200);

    // ...now make it yesterday's set.
    await testEnv.DB.prepare(`UPDATE rounds SET op_date = '2020-01-01' WHERE id = ?`).bind(roundId).run();
    const old = await admin.json('GET', `/api/admin/sets/${roundId}`);
    expect(old.body.recent).toBe(false);
    expect(old.body.imagesAvailable).toBe(false);
    for (const s of old.body.steps) for (const i of s.images) {
      expect(i.thumbUrl).toBeNull();
      expect(i.displayUrl).toBeNull();
    }
    expect(old.body.set.driveUrl).toContain(old.body.drive.folderId);
    const img = await admin.json('GET', `/api/admin/images/${imgId}/thumb`);
    expect(img.status).toBe(403);
    expect(img.body.error.code).toBe('old_set');
    // The list marks it as metadata-only.
    const list = await admin.json('GET', q({ q: old.body.set.publicId, status: 'all' }));
    expect(list.body.rows[0].imagesAllowed).toBe(false);
    void user;
  });
});

describe('hide / remove / plate correction', () => {
  it('hide and remove act on the whole set and never delete Drive files', async () => {
    const drive = recordingDrive();
    const { setDriveOverride } = await import('../../src/worker/drive');
    setDriveOverride(() => drive);
    try {
      const { id } = await insertRound(bangkokToUtc('2026-07-09', '05:05:05'), 'ขค 7777');
      const before = (await testEnv.DB.prepare(`SELECT COUNT(*) AS n FROM demo_drive_files`).first<any>()).n;
      expect((await admin.json('POST', `/api/admin/sets/${id}/hide`)).status).toBe(200);
      let list = await admin.json('GET', q({ q: 'ขค7777' }));
      expect(list.body.total).toBe(0);
      list = await admin.json('GET', q({ q: 'ขค7777', visibility: 'hidden' }));
      expect(list.body.total).toBe(1);
      expect((await admin.json('POST', `/api/admin/sets/${id}/remove`)).status).toBe(200);
      // Admins cannot see removed sets; only super admins can.
      expect((await admin.json('GET', q({ q: 'ขค7777', visibility: 'removed' }))).status).toBe(403);
      const su = (await loggedIn('admin', 'super_admin')).client;
      expect((await su.json('GET', q({ q: 'ขค7777', visibility: 'removed' }))).body.total).toBe(1);
      // Drive untouched: no destructive calls exist, and the file count is unchanged.
      expect(drive.calls.map((c) => c.op)).not.toContain('delete');
      expect(drive.calls.map((c) => c.op)).not.toContain('trash');
      const after = (await testEnv.DB.prepare(`SELECT COUNT(*) AS n FROM demo_drive_files`).first<any>()).n;
      expect(after).toBe(before);
      expect(typeof (drive as any).delete).toBe('undefined');
      const audit = await testEnv.DB.prepare(`SELECT action FROM audit_log WHERE target_id = ? ORDER BY id`).bind(id).all<any>();
      expect(audit.results.map((r) => r.action)).toEqual(['set.hide', 'set.remove']);
    } finally {
      setDriveOverride(null);
    }
  });

  it('changing a plate renames the SAME Drive folder (ID unchanged)', async () => {
    const { client: field } = await loggedIn('field', 'operator');
    const wf = await getCurrentWorkflow(testEnv);
    const round = rid();
    let roundId = '';
    for (const step of wf.steps) {
      const b = await field.json('POST', '/api/field/images/begin', { clientRoundId: round, clientImageId: rid(), workflowVersionId: wf.id, stepId: step.id, source: 'camera', acceptedAtDevice: Date.now() });
      roundId = b.body.round.id;
      const d = await putToDrive(field, b.body.uploads.display.url);
      const o = await putToDrive(field, b.body.uploads.original.url);
      await field.json('POST', `/api/field/images/${b.body.image.id}/complete`, { displayFileId: d, originalFileId: o });
    }
    await field.json('POST', `/api/field/rounds/${roundId}/finalize`, { idempotencyKey: 'p' });
    const before = await testEnv.DB.prepare(`SELECT * FROM rounds WHERE id = ?`).bind(roundId).first<any>();
    expect(before.drive_folder_name).toContain('ไม่ระบุ');

    const r = await admin.json('PUT', `/api/admin/sets/${roundId}/plate`, { plate: '1กข 2345' });
    expect(r.status).toBe(200);
    const after = await testEnv.DB.prepare(`SELECT * FROM rounds WHERE id = ?`).bind(roundId).first<any>();
    expect(after.drive_folder_id).toBe(before.drive_folder_id);
    expect(after.drive_folder_name).toContain('1กข2345');
    const folder = await recordingDrive().getFile(after.drive_folder_id);
    expect(folder!.name).toBe(after.drive_folder_name);
    expect(after.plate_source).toBe('manual');
    const hist = await testEnv.DB.prepare(`SELECT * FROM plate_history WHERE round_id = ?`).bind(roundId).all<any>();
    expect(hist.results[0].new_text).toBe('1กข 2345');
  });
});
