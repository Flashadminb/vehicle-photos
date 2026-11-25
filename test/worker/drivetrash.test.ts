import { beforeAll, describe, expect, it } from 'vitest';
import { createUser, loggedIn, rid, testEnv, Client, recordingDrive } from './helpers';
import { publicIdFromSeq } from '../../src/shared/names';
import { getCurrentWorkflow } from '../../src/worker/services/config';
import { processJobs } from '../../src/worker/services/maintenance';
import { DEMO_ROOT_ID } from '../../src/worker/drive/demo';

let operatorId: string;
let su: Client;
let admin: Client;

/** A finished round with a real (demo) Drive folder holding one photo. */
async function insertRound(opDate: string, status: 'finalized' | 'open' | 'abandoned' = 'finalized') {
  const drive = recordingDrive();
  await drive.ensureRoot();
  const folder = await drive.createFolder(DEMO_ROOT_ID, `set-${rid()}`);
  await testEnv.DB.prepare(`INSERT INTO demo_drive_files (id, name, parent_id, mime_type, size, created_at) VALUES (?, '01.jpg', ?, 'image/jpeg', 1000, ?)`)
    .bind(`f-${rid()}`, folder.id, Date.now())
    .run();
  const wf = await getCurrentWorkflow(testEnv);
  const seq = (await testEnv.DB.prepare(`UPDATE counters SET value = value + 1 WHERE name = 'round' RETURNING value`).first<{ value: number }>())!.value;
  const id = rid();
  const t = Date.parse(`${opDate}T03:00:00Z`);
  await testEnv.DB.prepare(
    `INSERT INTO rounds (id, seq, public_id, client_round_id, operator_id, workflow_version_id, started_at, started_at_source, created_at, op_date,
       status, required_count, active_count, uploaded_count, plate_source, unknown_label, drive_folder_id, folder_status, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'server', ?, ?, ?, 3, 3, 3, 'none', 'ไม่ระบุ', ?, 'ready', ?)`,
  )
    .bind(id, seq, publicIdFromSeq(seq), rid(), operatorId, wf.id, t, t, opDate, status, folder.id, t)
    .run();
  return { id, folderId: folder.id, publicId: publicIdFromSeq(seq) };
}

const trashed = async (folderId: string) =>
  (await testEnv.DB.prepare(`SELECT trashed FROM demo_drive_files WHERE parent_id = ?`).bind(folderId).first<any>())!.trashed;

beforeAll(async () => {
  operatorId = (await createUser('operator')).user.id;
  su = (await loggedIn('admin', 'super_admin')).client;
  admin = (await loggedIn('admin', 'admin')).client;
});

describe('free up Drive space (trash only, recoverable)', () => {
  it('only Super Admin can trash; trash + restore round-trips and is audited', async () => {
    const s = await insertRound('2026-01-05');
    expect((await admin.json('POST', `/api/admin/sets/${s.id}/drive-trash`)).status).toBe(403);
    expect((await su.json('POST', `/api/admin/sets/${s.id}/drive-trash`)).status).toBe(200);
    expect(await trashed(s.folderId)).toBe(1); // contents follow the folder into the trash
    const d = await su.json('GET', `/api/admin/sets/${s.id}`);
    expect(d.body.driveTrashedAt).toBeTruthy();
    expect(d.body.set.driveTrashed).toBe(true);
    expect(d.body.set.imagesAllowed).toBe(false);
    // The set's record stays in history.
    const list = await su.json('GET', `/api/admin/sets?q=${s.publicId}&status=all`);
    expect(list.body.rows[0].driveTrashed).toBe(true);

    expect((await su.json('POST', `/api/admin/sets/${s.id}/drive-restore`)).status).toBe(200);
    expect(await trashed(s.folderId)).toBe(0);
    const audit = await testEnv.DB.prepare(`SELECT action FROM audit_log WHERE target_id = ? ORDER BY id`).bind(s.id).all<any>();
    expect(audit.results.map((r) => r.action)).toEqual(['set.drive_trashed', 'set.drive_restored']);
  });

  it('never trashes a set that is still being captured', async () => {
    const s = await insertRound('2026-01-06', 'open');
    expect((await su.json('POST', `/api/admin/sets/${s.id}/drive-trash`)).status).toBe(409);
    expect(await trashed(s.folderId)).toBe(0);
  });

  it('bulk clean-up needs typed confirmation, a minimum age, and only touches old finished sets', async () => {
    const old1 = await insertRound('2020-01-01');
    const old2 = await insertRound('2020-01-02', 'abandoned');
    const oldOpen = await insertRound('2020-01-03', 'open');
    const recent = await insertRound('2026-11-01');
    const days = 365 * 5; // cut-off well after 2020, well before 2026

    expect((await su.json('GET', `/api/admin/drive/cleanup-preview?days=3`)).status).toBe(400);
    const pv = await su.json('GET', `/api/admin/drive/cleanup-preview?days=${days}`);
    expect(pv.body.sets).toBe(2);
    expect(pv.body.oldest).toBe('2020-01-01');

    expect((await su.json('POST', '/api/admin/drive/cleanup', { days, confirm: 'yes' })).status).toBe(400);
    expect((await admin.json('POST', '/api/admin/drive/cleanup', { days, confirm: 'ย้ายไปถังขยะ' })).status).toBe(403);
    const r = await su.json('POST', '/api/admin/drive/cleanup', { days, confirm: 'ย้ายไปถังขยะ' });
    expect(r.body.queued).toBe(2);
    await processJobs(testEnv, 50);

    expect(await trashed(old1.folderId)).toBe(1);
    expect(await trashed(old2.folderId)).toBe(1);
    expect(await trashed(oldOpen.folderId)).toBe(0);
    expect(await trashed(recent.folderId)).toBe(0);
    expect((await su.json('GET', `/api/admin/drive/cleanup-preview?days=${days}`)).body.sets).toBe(0);
  });

  it('a set restored before its queued job runs is not trashed', async () => {
    const s = await insertRound('2019-06-01');
    await su.json('POST', '/api/admin/drive/cleanup', { days: 365 * 6, confirm: 'ย้ายไปถังขยะ' });
    await su.json('POST', `/api/admin/sets/${s.id}/drive-restore`);
    await processJobs(testEnv, 50);
    expect(await trashed(s.folderId)).toBe(0);
  });

  it('reports Drive usage', async () => {
    const u = await admin.json('GET', '/api/admin/drive/usage');
    expect(u.status).toBe(200);
    expect(u.body.limit).toBeGreaterThan(0);
    expect(u.body.usage).toBeGreaterThan(0);
  });
});
