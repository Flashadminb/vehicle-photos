import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client, createUser, loggedIn, putToDrive, rid, testEnv } from './helpers';
import { getCurrentWorkflow, getSettings, publishWorkflow, saveSettings } from '../../src/worker/services/config';
import { setVisionOverride } from '../../src/worker/services/ocr';
import { extractSlipPlate } from '../../src/shared/plate';
import type { WorkflowVersion } from '../../src/shared/types';

describe('extractSlipPlate', () => {
  it('reads "บร7865(เพชรบุรี)" and ignores dates, barcodes and IDs', () => {
    expect(extractSlipPlate('Proof of Van Dispatching\nบร7865(เพชรบุรี) 2026-11-25\nSAM1VFBZ63')).toEqual({ plate: 'บร 7865', province: 'เพชรบุรี' });
    expect(extractSlipPlate('1กข 2345 (กรุงเทพมหานคร)')).toEqual({ plate: '1กข 2345', province: 'กรุงเทพมหานคร' });
    expect(extractSlipPlate('70-1234(ชลบุรี)')).toEqual({ plate: '70-1234', province: 'ชลบุรี' });
    expect(extractSlipPlate('5 บร7865(เพชรบุรี)')).toEqual({ plate: 'บร 7865', province: 'เพชรบุรี' });
    expect(extractSlipPlate('2026-11-25 SAM1VFBZ63 21BPLL')).toBeNull();
  });
});

describe('slip + plate photo', () => {
  let original: WorkflowVersion;
  let visionCalls: string[] = [];
  let answers: Record<string, { raw: string; plate: string | null; confidence: number | null }> = {};

  beforeEach(async () => {
    original = await getCurrentWorkflow(testEnv);
    const admin = await createUser('admin');
    await publishWorkflow(
      testEnv,
      original.steps.map((s) => (s.id === 'step_bar' ? { ...s, ocr: true, ocrKind: 'document' } : s.id === 'step_plate' ? { ...s, ocr: true, ocrKind: 'plate' } : s)),
      'slip test',
      admin.user.id,
      Date.now(),
    );
    const st = await getSettings(testEnv);
    await saveSettings(testEnv, { ...st, ocrProvider: 'google_vision', visionMonthlyFree: 100000, visionCapPct: 90 }, 't', Date.now());
    visionCalls = [];
    setVisionOverride(async (_env, _src, kind) => {
      visionCalls.push(kind ?? 'plate');
      return answers[kind ?? 'plate'];
    });
    await testEnv.DB.prepare(`UPDATE jobs SET status = 'done' WHERE kind = 'ocr'`).run();
  });
  afterEach(async () => {
    setVisionOverride(null);
    const st = await getSettings(testEnv);
    await saveSettings(testEnv, { ...st, ocrProvider: 'none' }, 't', Date.now());
    const admin = await createUser('admin');
    await publishWorkflow(testEnv, original.steps, 'restore', admin.user.id, Date.now());
  });

  async function captureRound(field: Client) {
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
    return roundId;
  }
  const round = (id: string) => testEnv.DB.prepare(`SELECT * FROM rounds WHERE id = ?`).bind(id).first<any>();

  it('a confident slip reading sets the plate and the plate photo is not sent to Vision', async () => {
    answers = {
      document: { raw: 'Proof of Van Dispatching\nบร7865(เพชรบุรี)\n2026-11-25', plate: 'บร 7865', confidence: 0.9 },
      plate: { raw: 'x', plate: 'บร 7866', confidence: 0.95 },
    };
    const { client } = await loggedIn('field', 'operator');
    const r = await captureRound(client);
    expect(visionCalls).toEqual(['document']); // plate photo skipped: saves a Vision call
    const row = await round(r);
    expect(row.plate_text).toBe('บร 7865');
    expect(row.drive_folder_name).toContain('บร7865');
  });

  it('a failed plate-photo reading never erases the slip result; a weaker one does not replace it', async () => {
    answers = {
      document: { raw: 'บร7865(เพชรบุรี)', plate: 'บร 7865', confidence: 0.5 }, // score 0.65: plate photo still read
      plate: { raw: 'noise', plate: null, confidence: 0.2 },
    };
    const { client } = await loggedIn('field', 'operator');
    const r = await captureRound(client);
    expect(visionCalls).toEqual(['document', 'plate']);
    expect((await round(r)).plate_text).toBe('บร 7865');
  });

  it('a better plate-photo reading can replace a weak slip reading', async () => {
    answers = {
      document: { raw: 'บร7865(เพชรบุรี)', plate: 'บร 7865', confidence: 0.4 },
      plate: { raw: 'บร 7856', plate: 'บร 7856', confidence: 0.95 },
    };
    const { client } = await loggedIn('field', 'operator');
    const r = await captureRound(client);
    expect((await round(r)).plate_text).toBe('บร 7856');
  });
});
