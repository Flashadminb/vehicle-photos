import { describe, expect, it } from 'vitest';
import { loggedIn, putToDrive, rid, testEnv, createUser, recordingDrive, ORIGIN } from './helpers';
import { beginImage, completeImage, finalizeRound } from '../../src/worker/services/rounds';
import { getCurrentWorkflow, publishWorkflow } from '../../src/worker/services/config';
import { bangkokToUtc } from '../../src/shared/time';

async function current() {
  return getCurrentWorkflow(testEnv);
}

describe('capture flow (HTTP, demo Drive)', () => {
  it('captures step 2 while step 1 is still uploading, then finalizes', async () => {
    const { client } = await loggedIn('field', 'operator');
    const wf = await current();
    const round = rid();
    const begin = (stepId: string) =>
      client.json('POST', '/api/field/images/begin', {
        clientRoundId: round,
        clientImageId: rid(),
        workflowVersionId: wf.id,
        stepId,
        source: 'camera',
        acceptedAtDevice: Date.now(),
        captureTimeDevice: Date.now(),
      });
    // Step 1 accepted; its upload has NOT finished.
    const b1 = await begin(wf.steps[0].id);
    expect(b1.status).toBe(200);
    expect(b1.body.round.publicId).toMatch(/^PF-\d{6}$/);
    // Step 2 accepted while step 1 is still pending — no waiting required.
    const b2 = await begin(wf.steps[1].id);
    expect(b2.status).toBe(200);
    expect(b2.body.round.id).toBe(b1.body.round.id);

    // DONE must fail: step 3 missing and uploads not finished.
    const early = await client.json('POST', `/api/field/rounds/${b1.body.round.id}/finalize`, { idempotencyKey: 'k1' });
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe('incomplete');

    const b3 = await begin(wf.steps[2].id);
    for (const b of [b2, b3, b1]) {
      const disp = await putToDrive(client, b.body.uploads.display.url);
      const orig = await putToDrive(client, b.body.uploads.original.url);
      const done = await client.json('POST', `/api/field/images/${b.body.image.id}/complete`, { displayFileId: disp, originalFileId: orig });
      expect(done.status).toBe(200);
      expect(done.body.active).toBe(true);
    }
    const fin = await client.json('POST', `/api/field/rounds/${b1.body.round.id}/finalize`, { idempotencyKey: 'k1' });
    expect(fin.status).toBe(200);
    expect(fin.body.alreadyFinalized).toBe(false);
    // Idempotent: a duplicate DONE does not create anything new.
    const again = await client.json('POST', `/api/field/rounds/${b1.body.round.id}/finalize`, { idempotencyKey: 'k1' });
    expect(again.status).toBe(200);
    expect(again.body.alreadyFinalized).toBe(true);
    // A finalized round accepts no more images.
    expect((await begin(wf.steps[0].id)).status).toBe(409);
  });

  it('rejects completion when the file is not really in the round folder', async () => {
    const { client } = await loggedIn('field', 'operator');
    const wf = await current();
    const b = await client.json('POST', '/api/field/images/begin', {
      clientRoundId: rid(), clientImageId: rid(), workflowVersionId: wf.id, stepId: wf.steps[0].id, source: 'camera', acceptedAtDevice: Date.now(),
    });
    const r = await client.json('POST', `/api/field/images/${b.body.image.id}/complete`, { displayFileId: 'not-a-file', originalFileId: 'nope' });
    expect(r.status).toBe(422);
  });

  it('an operator cannot touch another operator’s round', async () => {
    const a = await loggedIn('field', 'operator');
    const b = await loggedIn('field', 'operator');
    const wf = await current();
    const round = rid();
    const x = await a.client.json('POST', '/api/field/images/begin', {
      clientRoundId: round, clientImageId: rid(), workflowVersionId: wf.id, stepId: wf.steps[0].id, source: 'camera', acceptedAtDevice: Date.now(),
    });
    expect(x.status).toBe(200);
    const y = await b.client.json('POST', '/api/field/images/begin', {
      clientRoundId: round, clientImageId: rid(), workflowVersionId: wf.id, stepId: wf.steps[1].id, source: 'camera', acceptedAtDevice: Date.now(),
    });
    expect(y.status).toBe(403);
    expect((await b.client.json('POST', `/api/field/rounds/${x.body.round.id}/finalize`, { idempotencyKey: 'z' })).status).toBe(403);
  });
});

describe('replacement safety', () => {
  it('an old upload finishing after a retake can never replace the new photo', async () => {
    const { user } = await createUser('operator');
    const drive = recordingDrive();
    const wf = await current();
    const round = rid();
    const base = { clientRoundId: round, workflowVersionId: wf.id, source: 'camera' as const, acceptedAtDevice: Date.now() };
    const opts = { origin: ORIGIN, baseUrl: ORIGIN, drive };
    const v1 = await beginImage(testEnv, user, { ...base, clientImageId: rid(), stepId: wf.steps[0].id }, opts);
    const v2 = await beginImage(testEnv, user, { ...base, clientImageId: rid(), stepId: wf.steps[0].id }, opts);
    expect(v2.image.version).toBe(2);

    // v2 completes first...
    const up = async (url: string) => (await import('../../src/worker/drive/demo')).DemoDrive.receiveUpload(testEnv, url.split('/').pop()!, new ArrayBuffer(10));
    const d2 = await up(v2.uploads!.display.url);
    const o2 = await up(v2.uploads!.original!.url);
    const c2 = await completeImage(testEnv, user, v2.image.id, { displayFileId: d2!.id, originalFileId: o2!.id }, { drive, baseUrl: ORIGIN });
    expect(c2.active).toBe(true);

    // ...then the stale v1 upload callback arrives late.
    const d1 = await up(v1.uploads!.display.url);
    const c1 = await completeImage(testEnv, user, v1.image.id, { displayFileId: d1!.id }, { drive, baseUrl: ORIGIN });
    expect(c1.active).toBe(false);
    expect(c1.status).toBe('superseded');

    const rows = (
      await testEnv.DB.prepare(`SELECT id, active, status FROM images WHERE round_id = ? AND step_id = ? ORDER BY version`)
        .bind(v1.round.id, wf.steps[0].id)
        .all<any>()
    ).results;
    expect(rows).toEqual([
      { id: v1.image.id, active: 0, status: 'superseded' },
      { id: v2.image.id, active: 1, status: 'uploaded' },
    ]);
    // The late v1 file is queued to be moved into _replaced — never deleted.
    const job = await testEnv.DB.prepare(`SELECT * FROM jobs WHERE kind = 'move_replaced' AND ref_id = ?`).bind(v1.image.id).first();
    expect(job).toBeTruthy();
  });

  it('retaking a step before its upload begins returns no upload target for the stale image', async () => {
    const { user } = await createUser('operator');
    const drive = recordingDrive();
    const wf = await current();
    const round = rid();
    const imgId = rid();
    const base = { clientRoundId: round, workflowVersionId: wf.id, source: 'camera' as const, acceptedAtDevice: Date.now() };
    const opts = { origin: ORIGIN, baseUrl: ORIGIN, drive };
    await beginImage(testEnv, user, { ...base, clientImageId: imgId, stepId: wf.steps[1].id }, opts);
    await beginImage(testEnv, user, { ...base, clientImageId: rid(), stepId: wf.steps[1].id }, opts);
    // Replaying begin for the stale image (e.g. after a reload) yields no upload sessions.
    const replay = await beginImage(testEnv, user, { ...base, clientImageId: imgId, stepId: wf.steps[1].id }, opts);
    expect(replay.image.active).toBe(false);
    expect(replay.uploads).toBeUndefined();
  });
});

describe('workflow versioning', () => {
  it('a mid-round workflow change does not alter that round', async () => {
    const { user } = await createUser('operator');
    const { user: adminUser } = await createUser('admin');
    const drive = recordingDrive();
    const wf = await current();
    const round = rid();
    const opts = { origin: ORIGIN, baseUrl: ORIGIN, drive };
    const base = { clientRoundId: round, workflowVersionId: wf.id, source: 'camera' as const, acceptedAtDevice: Date.now() };
    const first = await beginImage(testEnv, user, { ...base, clientImageId: rid(), stepId: wf.steps[0].id }, opts);

    // Admin removes step 2, renames step 1, adds a new required step.
    const newId = await publishWorkflow(
      testEnv,
      [
        { ...wf.steps[0], labels: { th: 'ชื่อใหม่', en: 'Renamed' } },
        wf.steps[2],
        { id: 'step_new', required: true, allowUpload: false, ocr: false, labels: { th: 'ใหม่', en: 'New' } },
      ],
      'test change',
      adminUser.id,
      Date.now(),
    );
    expect(newId).toBeGreaterThan(wf.id);

    // The in-progress round still accepts the removed step and keeps its original labels/file names.
    const step2 = await beginImage(testEnv, user, { ...base, clientImageId: rid(), stepId: wf.steps[1].id }, opts);
    expect(step2.round.id).toBe(first.round.id);
    expect(step2.image.fileName).toBe('02_ด้านหลังรถ.jpg');
    // The new step does not exist for this round.
    await expect(beginImage(testEnv, user, { ...base, clientImageId: rid(), stepId: 'step_new' }, opts)).rejects.toThrow(/not part/);
    const row = await testEnv.DB.prepare(`SELECT workflow_version_id, required_count FROM rounds WHERE id = ?`).bind(first.round.id).first<any>();
    expect(row.workflow_version_id).toBe(wf.id);
    expect(row.required_count).toBe(3);

    // Restore the default for other tests.
    await publishWorkflow(testEnv, wf.steps, 'restore', adminUser.id, Date.now());
  });
});

describe('Drive folders', () => {
  it('a round crossing midnight stays in one folder', async () => {
    const { user } = await createUser('operator');
    const drive = recordingDrive();
    const wf = await current();
    const round = rid();
    const opts = { origin: ORIGIN, baseUrl: ORIGIN, drive };
    const beforeMidnight = bangkokToUtc('2026-07-10', '23:59:50');
    const afterMidnight = bangkokToUtc('2026-07-11', '00:00:20');
    const base = { clientRoundId: round, workflowVersionId: wf.id, source: 'camera' as const };
    const a = await beginImage(testEnv, user, { ...base, clientImageId: rid(), stepId: wf.steps[0].id, acceptedAtDevice: beforeMidnight }, { ...opts, now: beforeMidnight + 1000 });
    const b = await beginImage(testEnv, user, { ...base, clientImageId: rid(), stepId: wf.steps[1].id, acceptedAtDevice: afterMidnight }, { ...opts, now: afterMidnight + 1000 });
    expect(b.round.id).toBe(a.round.id);
    const r = await testEnv.DB.prepare(`SELECT * FROM rounds WHERE id = ?`).bind(a.round.id).first<any>();
    expect(r.op_date).toBe('2026-07-10');
    expect(r.drive_folder_name).toMatch(/^23-59-50_ไม่ระบุ_PF-\d{6}$/);
    const folder = await drive.getFile(r.drive_folder_id);
    const dateFolder = await drive.getFile(folder!.parents[0]);
    expect(dateFolder!.name).toBe('2026-07-10');
    // Both images were uploaded into the same round folder.
    const sessions = drive.calls.filter((c) => c.op === 'createUploadSession').map((c) => c.args[0]);
    expect(new Set(sessions)).toEqual(new Set([r.drive_folder_id]));
    // No folder was ever created for 2026-07-11.
    expect(drive.calls.some((c) => c.op === 'createFolder' && c.args[1] === '2026-07-11')).toBe(false);
  });

  it('concurrent rounds on the same day share ONE date folder', async () => {
    const { user } = await createUser('operator');
    const drive = recordingDrive();
    const wf = await current();
    const when = bangkokToUtc('2026-08-01', '09:00:00');
    const opts = { origin: ORIGIN, baseUrl: ORIGIN, drive, now: when + 5000 };
    await Promise.all(
      Array.from({ length: 5 }, () =>
        beginImage(testEnv, user, { clientRoundId: rid(), clientImageId: rid(), workflowVersionId: wf.id, stepId: wf.steps[0].id, source: 'camera', acceptedAtDevice: when }, opts),
      ),
    );
    const folders = await drive.findFolders('demo-root', '2026-08-01');
    expect(folders).toHaveLength(1);
  });

  it('upload is refused for steps that disallow it', async () => {
    const { user } = await createUser('operator');
    const { user: adminUser } = await createUser('admin');
    const wf = await current();
    const steps = wf.steps.map((s, i) => (i === 0 ? { ...s, allowUpload: false } : s));
    const id = await publishWorkflow(testEnv, steps, 'no upload', adminUser.id, Date.now());
    await expect(
      beginImage(testEnv, user, { clientRoundId: rid(), clientImageId: rid(), workflowVersionId: id, stepId: steps[0].id, source: 'upload', acceptedAtDevice: Date.now() }, { origin: ORIGIN, baseUrl: ORIGIN, drive: recordingDrive() }),
    ).rejects.toThrow(/ไม่อนุญาต/);
    await publishWorkflow(testEnv, wf.steps, 'restore', adminUser.id, Date.now());
  });
});

describe('finalization', () => {
  it('failed finalization changes nothing and can be retried', async () => {
    const { user } = await createUser('operator');
    const drive = recordingDrive();
    const wf = await current();
    const round = rid();
    const opts = { origin: ORIGIN, baseUrl: ORIGIN, drive };
    const b = await beginImage(testEnv, user, { clientRoundId: round, clientImageId: rid(), workflowVersionId: wf.id, stepId: wf.steps[0].id, source: 'camera', acceptedAtDevice: Date.now() }, opts);
    await expect(finalizeRound(testEnv, user, b.round.id, 'key')).rejects.toThrow(/ยังขาดรูป/);
    const r = await testEnv.DB.prepare(`SELECT status FROM rounds WHERE id = ?`).bind(b.round.id).first<any>();
    expect(r.status).toBe('open');
  });
});

describe('date folder pre-creation', () => {
  it('creates today’s date folder once; later runs do not touch Drive', async () => {
    const { precreateDateFolders } = await import('../../src/worker/services/maintenance');
    const { setDriveOverride } = await import('../../src/worker/drive');
    const drive = recordingDrive();
    setDriveOverride(() => drive);
    try {
      const when = bangkokToUtc('2026-09-01', '00:05:00');
      await precreateDateFolders(testEnv, when);
      expect((await drive.findFolders('demo-root', '2026-09-01')).length).toBe(1);
      const calls = drive.calls.length;
      await precreateDateFolders(testEnv, when + 15 * 60_000);
      expect(drive.calls.length).toBe(calls); // D1 says it exists: no Drive call
      // Last hour of the day: tomorrow's folder is prepared too.
      await precreateDateFolders(testEnv, bangkokToUtc('2026-09-01', '23:10:00'));
      expect((await drive.findFolders('demo-root', '2026-09-02')).length).toBe(1);
    } finally {
      setDriveOverride(null);
    }
  });
});
