import { describe, expect, it } from 'vitest';
import { loggedIn, putToDrive, rid, testEnv, Client } from './helpers';

/** Capture one full set with whatever workflow the field app is given. */
async function captureWithBootstrap(field: Client) {
  const boot = await field.json('GET', '/api/field/bootstrap');
  const wf = boot.body.workflow;
  const round = rid();
  let roundId = '';
  for (const step of wf.steps) {
    const b = await field.json('POST', '/api/field/images/begin', { clientRoundId: round, clientImageId: rid(), workflowVersionId: wf.id, stepId: step.id, source: 'camera', acceptedAtDevice: Date.now() });
    roundId = b.body.round.id;
    const d = await putToDrive(field, b.body.uploads.display.url);
    await field.json('POST', `/api/field/images/${b.body.image.id}/complete`, { displayFileId: d });
  }
  return { roundId, steps: wf.steps.map((s: any) => s.id) };
}

describe('capture profiles (รูปแบบการถ่าย)', () => {
  it('each user gets the steps of their own profile; history filters by profile and by person', async () => {
    const { client: admin } = await loggedIn('admin', 'super_admin');
    // A "gate" profile with just one step.
    const created = await admin.json('POST', '/api/admin/workflows', { name: 'ป้อมยาม' });
    expect(created.status).toBe(200);
    const gateId = created.body.id;
    const cur = await admin.json('GET', `/api/admin/workflow?workflowId=${gateId}`);
    const oneStep = [{ ...cur.body.current.steps[0], id: 'gate_photo', required: true, labels: { th: 'รถเข้าประตู', en: 'Gate' } }];
    expect((await admin.json('POST', '/api/admin/workflow', { workflowId: gateId, steps: oneStep })).status).toBe(200);

    const guard = await loggedIn('field', 'operator');
    const worker = await loggedIn('field', 'operator');
    expect((await admin.json('PATCH', `/api/admin/users/${guard.user.id}`, { workflowId: gateId })).status).toBe(200);

    const g = await captureWithBootstrap(guard.client);
    const w = await captureWithBootstrap(worker.client);
    expect(g.steps).toEqual(['gate_photo']);
    expect(w.steps.length).toBeGreaterThan(1); // default profile unchanged

    const byProfile = await admin.json('GET', `/api/admin/sets?status=all&workflowId=${gateId}`);
    expect(byProfile.body.rows.map((r: any) => r.id)).toEqual([g.roundId]);
    const byPerson = await admin.json('GET', `/api/admin/sets?status=all&operatorId=${worker.user.id}`);
    expect(byPerson.body.rows.map((r: any) => r.id)).toEqual([w.roundId]);

    // The default profile cannot be archived; a profile in use cannot either.
    expect((await admin.json('DELETE', '/api/admin/workflows/default')).status).toBe(400);
    expect((await admin.json('DELETE', `/api/admin/workflows/${gateId}`)).status).toBe(400);
    await admin.json('PATCH', `/api/admin/users/${guard.user.id}`, { workflowId: 'default' });
    expect((await admin.json('DELETE', `/api/admin/workflows/${gateId}`)).status).toBe(200);
  });

  it('a reviewer can list profiles and operators for the filters but not edit them', async () => {
    const { client } = await loggedIn('admin', 'reviewer');
    expect((await client.json('GET', '/api/admin/workflows')).status).toBe(200);
    expect((await client.json('GET', '/api/admin/operators')).status).toBe(200);
    expect((await client.json('POST', '/api/admin/workflows', { name: 'x' })).status).toBe(403);
  });

  it('re-reading an old set taken before OCR was on uses today\'s OCR settings for the same steps', async () => {
    const { client: admin } = await loggedIn('admin', 'super_admin');
    await admin.json('PUT', '/api/admin/settings', { ocrProvider: 'local' });
    const before = (await admin.json('GET', '/api/admin/workflow?workflowId=default')).body.current;
    const noOcr = before.steps.map((s: any) => ({ ...s, ocr: false }));
    await admin.json('POST', '/api/admin/workflow', { workflowId: 'default', steps: noOcr });
    const op = await loggedIn('field', 'operator');
    const { roundId } = await captureWithBootstrap(op.client);
    // Now switch OCR on for the first step (as a slip) and re-read the old set.
    const withOcr = before.steps.map((s: any, i: number) => ({ ...s, ocr: i === 0, ocrKind: 'document' }));
    await admin.json('POST', '/api/admin/workflow', { workflowId: 'default', steps: withOcr });
    const r = await admin.json('POST', `/api/admin/sets/${roundId}/ocr`, { target: 'local', bulk: true });
    expect(r.status).toBe(200);
    const job = await testEnv.DB.prepare(`SELECT payload, status FROM jobs WHERE kind = 'ocr' AND ref_id = ? ORDER BY id DESC`).bind(roundId).first<any>();
    expect(JSON.parse(job.payload).kind).toBe('document');
    expect(job.status).toBe('local');
    await admin.json('POST', '/api/admin/workflow', { workflowId: 'default', steps: before.steps });
  });

  it('history can show only sets whose plate is still "ไม่ระบุ" or unsure', async () => {
    const { client: admin } = await loggedIn('admin', 'super_admin');
    const op = await loggedIn('field', 'operator');
    const { roundId } = await captureWithBootstrap(op.client);
    await testEnv.DB.prepare(`UPDATE rounds SET status = 'finalized' WHERE id = ?`).bind(roundId).run();
    const missing = await admin.json('GET', `/api/admin/sets?status=all&plate=missing&operatorId=${op.user.id}`);
    expect(missing.body.rows.map((r: any) => r.id)).toEqual([roundId]);
    expect((await admin.json('PUT', `/api/admin/sets/${roundId}/plate`, { plate: '725067723224 (พระนครศรีอยุธยา)' })).status).toBe(200);
    expect((await admin.json('GET', `/api/admin/sets?status=all&plate=missing&operatorId=${op.user.id}`)).body.total).toBe(0);
    await testEnv.DB.prepare(`UPDATE rounds SET plate_source = 'ocr', plate_confidence = 0.6 WHERE id = ?`).bind(roundId).run();
    expect((await admin.json('GET', `/api/admin/sets?status=all&plate=unsure&operatorId=${op.user.id}`)).body.total).toBe(1);
    expect((await admin.json('GET', '/api/admin/sets?plate=bogus')).status).toBe(400);
  });

  it('re-reading clears an unsure automatic plate but keeps sure and hand-typed ones', async () => {
    const { client: admin } = await loggedIn('admin', 'super_admin');
    await admin.json('PUT', '/api/admin/settings', { ocrProvider: 'local' });
    const op = await loggedIn('field', 'operator');
    const { roundId } = await captureWithBootstrap(op.client);
    await testEnv.DB.prepare(`UPDATE rounds SET status = 'finalized', plate_text = '40 (ค)', plate_source = 'ocr', plate_confidence = 0.75 WHERE id = ?`).bind(roundId).run();
    await admin.json('POST', `/api/admin/sets/${roundId}/ocr`, { target: 'local', bulk: true });
    expect((await testEnv.DB.prepare(`SELECT plate_text FROM rounds WHERE id = ?`).bind(roundId).first<any>()).plate_text).toBeNull();
    await testEnv.DB.prepare(`UPDATE rounds SET plate_text = '70-1234 (ชลบุรี)', plate_source = 'ocr', plate_confidence = 0.9 WHERE id = ?`).bind(roundId).run();
    await admin.json('POST', `/api/admin/sets/${roundId}/ocr`, { target: 'local', bulk: true });
    expect((await testEnv.DB.prepare(`SELECT plate_text FROM rounds WHERE id = ?`).bind(roundId).first<any>()).plate_text).toBe('70-1234 (ชลบุรี)');
  });
});
