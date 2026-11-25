import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client, loggedIn, putToDrive, rid, testEnv, ORIGIN } from './helpers';
import { getCurrentWorkflow, getSettings, saveSettings } from '../../src/worker/services/config';
import { reserveVisionCall, setVisionOverride, visionPeriod } from '../../src/worker/services/ocr';
import { processJobs } from '../../src/worker/services/maintenance';
import type { AppSettings } from '../../src/shared/types';

let visionCalls = 0;
let admin: Client;

async function setSettings(patch: Partial<AppSettings>) {
  const s = await getSettings(testEnv);
  await saveSettings(testEnv, { ...s, ...patch }, 'test', Date.now());
}

async function setVisionUsed(n: number) {
  await testEnv.DB.prepare(`INSERT INTO ocr_usage (period, count, updated_at) VALUES (?1, ?2, 0) ON CONFLICT(period) DO UPDATE SET count = ?2`)
    .bind(visionPeriod(Date.now()), n)
    .run();
}

/** Capture and finalize a full round through the field API; returns the round id. */
async function captureRound(field: Client) {
  const wf = await getCurrentWorkflow(testEnv);
  const round = rid();
  let roundId = '';
  for (const step of wf.steps) {
    const b = await field.json('POST', '/api/field/images/begin', { clientRoundId: round, clientImageId: rid(), workflowVersionId: wf.id, stepId: step.id, source: 'camera', acceptedAtDevice: Date.now() });
    roundId = b.body.round.id;
    const d = await putToDrive(field, b.body.uploads.display.url);
    const o = (b.body.uploads.original ? await putToDrive(field, b.body.uploads.original.url) : null);
    await field.json('POST', `/api/field/images/${b.body.image.id}/complete`, { displayFileId: d, originalFileId: o });
  }
  await field.json('POST', `/api/field/rounds/${roundId}/finalize`, { idempotencyKey: 'k' });
  return roundId;
}

const round = (id: string) => testEnv.DB.prepare(`SELECT * FROM rounds WHERE id = ?`).bind(id).first<any>();
const ocrJob = (id: string) => testEnv.DB.prepare(`SELECT * FROM jobs WHERE kind = 'ocr' AND ref_id = ? ORDER BY id DESC LIMIT 1`).bind(id).first<any>();

async function newAgent(name: string) {
  const r = await admin.json('POST', '/api/admin/ocr/agents', { name });
  expect(r.status).toBe(200);
  const token = r.body.token as string;
  const call = (method: string, path: string, body?: unknown) => {
    const c = new Client();
    return c.json(method, path, body, { Authorization: `Bearer ${token}` });
  };
  return { id: r.body.id as string, token, call };
}

beforeEach(async () => {
  visionCalls = 0;
  setVisionOverride(async () => {
    visionCalls++;
    return { raw: 'กข 1234\nกรุงเทพมหานคร', plate: 'กข 1234', confidence: 0.93 };
  });
  admin = (await loggedIn('admin', 'super_admin')).client;
  await testEnv.DB.prepare(`UPDATE jobs SET status = 'done' WHERE kind = 'ocr'`).run();
  await testEnv.DB.prepare(`UPDATE ocr_agents SET disabled = 1`).run();
});
afterEach(async () => {
  setVisionOverride(null);
  await setSettings({ ocrProvider: 'none' });
  await setVisionUsed(0);
});

describe('Google Vision cap', () => {
  it('never exceeds the cap, even with concurrent calls', async () => {
    await setVisionUsed(0);
    const s = { ...(await getSettings(testEnv)), visionMonthlyFree: 10, visionCapPct: 90 };
    const results = await Promise.all(Array.from({ length: 20 }, () => reserveVisionCall(testEnv, s)));
    expect(results.filter(Boolean)).toHaveLength(9);
  });

  it('vision_then_local: uses Vision until 90 %, then hands plates to Local OCR', async () => {
    await setSettings({ ocrProvider: 'vision_then_local', visionMonthlyFree: 10, visionCapPct: 90 });
    await setVisionUsed(8);
    const { client: field } = await loggedIn('field', 'operator');
    const r1 = await captureRound(field);
    expect(visionCalls).toBe(1);
    expect((await round(r1)).plate_text).toBe('กข 1234');
    expect((await round(r1)).drive_folder_name).toContain('กข1234');
    // Cap (9) reached: the next plate waits for a Local OCR computer, Vision is not called.
    const r2 = await captureRound(field);
    expect(visionCalls).toBe(1);
    expect((await round(r2)).ocr_status).toBe('waiting_local');
    expect((await ocrJob(r2)).status).toBe('local');
  });

  it('google_vision only: parks plates when the cap is reached; the admin button sends them to Local OCR', async () => {
    await setSettings({ ocrProvider: 'google_vision', visionMonthlyFree: 10, visionCapPct: 90 });
    await setVisionUsed(9);
    const { client: field } = await loggedIn('field', 'operator');
    const r = await captureRound(field);
    expect(visionCalls).toBe(0);
    expect((await ocrJob(r)).status).toBe('wait_quota');
    const moved = await admin.json('POST', '/api/admin/ocr/send-to-local');
    expect(moved.body.moved).toBeGreaterThanOrEqual(1);
    expect((await ocrJob(r)).status).toBe('local');
    expect((await round(r)).ocr_status).toBe('waiting_local');
  });
});

describe('Local OCR computers', () => {
  it('whichever computer is on takes the job; two computers never get the same plate', async () => {
    await setSettings({ ocrProvider: 'local' });
    const a = await newAgent('PC-office');
    const b = await newAgent('PC-warehouse');
    const { client: field } = await loggedIn('field', 'operator');
    const r = await captureRound(field);
    expect((await ocrJob(r)).status).toBe('local');

    const pa = await a.call('POST', '/api/ocr-agent/poll', {});
    expect(pa.body.job).toBeTruthy();
    const pb = await b.call('POST', '/api/ocr-agent/poll', {});
    expect(pb.body.job).toBeNull(); // leased to A

    const img = await new Client().req('GET', pa.body.job.imageUrl, undefined, { Authorization: `Bearer ${a.token}` });
    expect(img.status).toBe(200);
    // B may not read or answer A's job.
    expect((await b.call('POST', `/api/ocr-agent/jobs/${pa.body.job.id}/result`, { text: 'x' })).status).toBe(409);

    const res = await a.call('POST', `/api/ocr-agent/jobs/${pa.body.job.id}/result`, { text: '1กข 2345\nเชียงใหม่', confidence: 0.81 });
    expect(res.status).toBe(200);
    const row = await round(r);
    expect(row.plate_text).toBe('1กข 2345');
    expect(row.drive_folder_name).toContain('1กข2345');
    const hist = await testEnv.DB.prepare(`SELECT source FROM plate_history WHERE round_id = ? ORDER BY id DESC`).bind(r).first<any>();
    expect(hist.source).toBe('ocr:local:PC-office');
    const status = await admin.json('GET', '/api/admin/ocr/status');
    expect(status.body.agents.find((x: any) => x.name === 'PC-office').jobs_done).toBe(1);
  });

  it('if a computer is switched off mid-job, another one takes over after the lease expires', async () => {
    await setSettings({ ocrProvider: 'local' });
    const a = await newAgent('PC-A');
    const b = await newAgent('PC-B');
    const { client: field } = await loggedIn('field', 'operator');
    const r = await captureRound(field);
    const pa = await a.call('POST', '/api/ocr-agent/poll', {});
    await testEnv.DB.prepare(`UPDATE jobs SET next_run_at = 0 WHERE id = ?`).bind(pa.body.job.id).run(); // lease expired
    const pb = await b.call('POST', '/api/ocr-agent/poll', {});
    expect(pb.body.job.id).toBe(pa.body.job.id);
    expect((await a.call('POST', `/api/ocr-agent/jobs/${pa.body.job.id}/result`, { text: 'กข 1' })).status).toBe(409);
    expect((await b.call('POST', `/api/ocr-agent/jobs/${pb.body.job.id}/result`, { text: 'ขค 777' })).status).toBe(200);
    expect((await round(r)).plate_text).toBe('ขค 777');
  });

  it('an unsure plate reading (e.g. noise "ร 4" at 8%) never fills in the plate', async () => {
    await setSettings({ ocrProvider: 'local' });
    const a = await newAgent('PC-unsure');
    const { client: field } = await loggedIn('field', 'operator');
    const r = await captureRound(field);
    const p = await a.call('POST', '/api/ocr-agent/poll', {});
    // The agent judged it too unsure (plate: null) — the server must not re-parse "ร 4" out of the text.
    expect((await a.call('POST', `/api/ocr-agent/jobs/${p.body.job.id}/result`, { text: 'ร 4\nFLASH', plate: null, confidence: 0.08 })).status).toBe(200);
    const row = await round(r);
    expect(row.plate_text).toBeNull();
    expect(row.plate_source).toBe('none');
    expect(row.plate_raw).toContain('ร 4'); // kept for the admin to look at
  });

  it('local_then_vision: prefers an online computer, falls back to Vision when none is on', async () => {
    await setSettings({ ocrProvider: 'local_then_vision', visionMonthlyFree: 1000, visionCapPct: 90 });
    const { client: field } = await loggedIn('field', 'operator');
    // No computer online → Vision.
    const r1 = await captureRound(field);
    expect(visionCalls).toBe(1);
    expect((await round(r1)).plate_text).toBe('กข 1234');
    // A computer comes online → it gets the next plate, Vision is not used.
    const a = await newAgent('PC-online');
    await a.call('POST', '/api/ocr-agent/poll', {});
    const r2 = await captureRound(field);
    expect(visionCalls).toBe(1);
    expect((await ocrJob(r2)).status).toBe('local');
  });

  it('rejects unknown or disabled computers', async () => {
    expect((await new Client().json('POST', '/api/ocr-agent/poll', {}, { Authorization: 'Bearer nope' })).status).toBe(401);
    const a = await newAgent('PC-x');
    await admin.json('PATCH', `/api/admin/ocr/agents/${a.id}`, { disabled: true });
    expect((await a.call('POST', '/api/ocr-agent/poll', {})).status).toBe(401);
  });

  it('a manual correction always wins over OCR', async () => {
    await setSettings({ ocrProvider: 'local' });
    const a = await newAgent('PC-m');
    const { client: field } = await loggedIn('field', 'operator');
    const r = await captureRound(field);
    expect((await admin.json('PUT', `/api/admin/sets/${r}/plate`, { plate: 'ฮฮ 9999' })).status).toBe(200);
    const p = await a.call('POST', '/api/ocr-agent/poll', {});
    if (p.body.job) await a.call('POST', `/api/ocr-agent/jobs/${p.body.job.id}/result`, { text: 'กข 1234' });
    expect((await round(r)).plate_text).toBe('ฮฮ 9999');
  });

  it('admins can re-read a set with Local OCR', async () => {
    await setSettings({ ocrProvider: 'vision_then_local', visionMonthlyFree: 1000 });
    const { client: field } = await loggedIn('field', 'operator');
    const r = await captureRound(field);
    const res = await admin.json('POST', `/api/admin/sets/${r}/ocr`, { target: 'local' });
    expect(res.status).toBe(200);
    expect((await ocrJob(r)).status).toBe('local');
    void processJobs;
    void ORIGIN;
  });
});
