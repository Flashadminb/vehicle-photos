import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client, createUser, loggedIn, putToDrive, rid, testEnv } from './helpers';
import { getCurrentWorkflow, getSettings, publishWorkflow, saveSettings, validateSteps } from '../../src/worker/services/config';
import { setVisionOverride } from '../../src/worker/services/ocr';
import { extractSlipPlate } from '../../src/shared/plate';
import type { WorkflowVersion } from '../../src/shared/types';

describe('extractSlipPlate', () => {
  it('reads "บร7865(เพชรบุรี)" and ignores dates, barcodes and IDs', () => {
    expect(extractSlipPlate('Proof of Van Dispatching\nบร7865(เพชรบุรี) 2026-11-25\nSAM1VFBZ63')).toEqual({ plate: 'บร 7865', province: 'เพชรบุรี' });
    expect(extractSlipPlate('1กข 2345 (กรุงเทพมหานคร)')).toEqual({ plate: '1กข 2345', province: 'กรุงเทพมหานคร' });
    expect(extractSlipPlate('70-1234(ชลบุรี)')).toEqual({ plate: '70-1234', province: 'ชลบุรี' });
    expect(extractSlipPlate('15 บร7865(เพชรบุรี)')).toEqual({ plate: 'บร 7865', province: 'เพชรบุรี' });
    expect(extractSlipPlate('3 ฒช6128(กรุงเทพ)')).toEqual({ plate: '3ฒช 6128', province: 'กรุงเทพมหานคร' });
    expect(extractSlipPlate('66 - 0632(กรุงเทพ)')).toEqual({ plate: '66-0632', province: 'กรุงเทพมหานคร' });
    expect(extractSlipPlate('2026-11-25 SAM1VFBZ63 21BPLL')).toBeNull();
  });

  it('keeps every printed form: digits inside letters, dashes, split groups, Latin', () => {
    const p = (s: string) => extractSlipPlate(s)?.plate ?? null;
    expect(p('กท12-345(กรุงเทพมหานคร)')).toBe('กท 12-345');
    expect(p('1 กข 1234 (กรุงเทพมหานคร)')).toBe('1กข 1234');
    expect(p('12ก345(ชลบุรี)')).toBe('12ก 345');
    expect(p('ABC-1234(ระยอง)')).toBe('ABC-1234');
    expect(p('7250 6772 3224 (พระนครศรีอยุธยา)')).toBe('725067723224');
    expect(p('70–1234（ชลบุรี）')).toBe('70-1234'); // en dash, full-width brackets
    expect(p('ทะเบียน บร7865(เพชรบุรี)')).toBe('บร 7865'); // the word before is not part of it
  });

  it('falls back to whatever is printed on the plate line (any format), with lower confidence', async () => {
    const { resultFromText } = await import('../../src/worker/services/ocr');
    const raw = 'Proof of Van Dispatching\nZ9/X-777 2026-11-25\nSAM1VFME63';
    const r = resultFromText(raw, 0.93, 'document');
    expect(r.plate).toBe('Z9/X-777');
    expect(r.confidence).toBe(0.75); // capped: not a recognised plate(province)
    expect(resultFromText('Proof of Van Dispatching\nAB 1234 2026-11-25', 0.5, 'document').plate).toBe('AB1234');
    // OCR noise from a wrong rotation is not taken: too few digits.
    expect(resultFromText('Proof of Van Dispatching\nขยง (งจ)\n40 (ค) 2026-11-25', 0.9, 'document').plate).toBeNull();
    // Never the barcode code under the bars, never a made-up province from an upside-down read.
    expect(resultFromText('Proof of Van Dispatching\nBKK1VFAX09', 0.9, 'document').plate).toBeNull();
    expect(resultFromText('ร 9-ร 096ร (กรงเทรา฿) SZ-11-9202', 0.9, 'document').plate).toBeNull();
    // Strict matches keep their higher confidence.
    expect(resultFromText('700-9296(กรุงเทพ) 2026-11-25', 0.9, 'document')).toMatchObject({ plate: '700-9296 (กรุงเทพมหานคร)', confidence: 0.9 });
    // Nothing on a plate line: nothing invented.
    expect(resultFromText('Proof of Van Dispatching\n|||| ||| 2026-11-25', 0.9, 'document').plate).toBeNull();
  });

  it('understands short province names printed on slips', () => {
    expect(extractSlipPlate('66-0632(กรุงเทพ) 2026-11-25')).toEqual({ plate: '66-0632', province: 'กรุงเทพมหานคร' });
    expect(extractSlipPlate('3ฒช6128(กรุงเทพ)')).toEqual({ plate: '3ฒช 6128', province: 'กรุงเทพมหานคร' });
    expect(extractSlipPlate('69-5096(กรุงเทพฯ)')).toEqual({ plate: '69-5096', province: 'กรุงเทพมหานคร' });
    expect(extractSlipPlate('725067723224(กทม)')).toEqual({ plate: '725067723224', province: 'กรุงเทพมหานคร' });
  });

  it('search digits ignore the province', async () => {
    const { plateDigits, plateCore } = await import('../../src/shared/plate');
    expect(plateDigits('บร 7865 (เพชรบุรี)')).toBe('7865');
    expect(plateDigits('725067723224 (พระนครศรีอยุธยา)')).toBe('725067723224');
    expect(plateCore('บร 7865 (เพชรบุรี)')).toBe(plateCore('บร7865'));
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
      const o = (b.body.uploads.original ? await putToDrive(field, b.body.uploads.original.url) : null);
      await field.json('POST', `/api/field/images/${b.body.image.id}/complete`, { displayFileId: d, originalFileId: o });
    }
    return roundId;
  }
  const round = (id: string) => testEnv.DB.prepare(`SELECT * FROM rounds WHERE id = ?`).bind(id).first<any>();

  it('a confident slip reading sets the plate and the plate photo is not sent to Vision', async () => {
    answers = {
      document: { raw: 'Proof of Van Dispatching\nบร7865(เพชรบุรี)\n2026-11-25', plate: 'บร 7865 (เพชรบุรี)', confidence: 0.9 },
      plate: { raw: 'x', plate: 'บร 7866', confidence: 0.95 },
    };
    const { client } = await loggedIn('field', 'operator');
    const r = await captureRound(client);
    expect(visionCalls).toEqual(['document']); // plate photo skipped: saves a Vision call
    const row = await round(r);
    expect(row.plate_text).toBe('บร 7865 (เพชรบุรี)');
    expect(row.drive_folder_name).toContain('บร7865');
  });

  it('a failed plate-photo reading never erases the slip result; a weaker one does not replace it', async () => {
    answers = {
      document: { raw: 'บร7865(เพชรบุรี)', plate: 'บร 7865 (เพชรบุรี)', confidence: 0.5 }, // score 0.65: plate photo still read
      plate: { raw: 'noise', plate: null, confidence: 0.2 },
    };
    const { client } = await loggedIn('field', 'operator');
    const r = await captureRound(client);
    expect(visionCalls).toEqual(['document', 'plate']);
    expect((await round(r)).plate_text).toBe('บร 7865 (เพชรบุรี)');
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

describe('step frame and photo size options', () => {
  it('are kept when publishing a workflow; unknown values are dropped', async () => {
    const before = await getCurrentWorkflow(testEnv);
    const admin = await createUser('admin');
    const steps = before.steps.map((s, i) =>
      i === 0 ? { ...s, guide: 'slip_line', imageSize: 'small' } : i === 1 ? { ...s, guide: 'bogus', imageSize: 'huge', imageEdge: 1234 } : { ...s, imageEdge: 1600 },
    );
    await publishWorkflow(testEnv, validateSteps(steps, ['th', 'en']), 'frame test', admin.user.id, Date.now());
    const wf = await getCurrentWorkflow(testEnv);
    expect(wf.steps[0].guide).toBe('slip_line');
    expect(wf.steps[0].imageSize).toBe('small');
    expect(wf.steps[1].guide).toBeUndefined();
    expect(wf.steps[1].imageSize).toBeUndefined();
    expect(wf.steps[1].imageEdge).toBeUndefined();
    expect(wf.steps[2].imageEdge).toBe(1600);
    await publishWorkflow(testEnv, before.steps, 'restore', admin.user.id, Date.now());
  });
});

describe('slip: any registration before a province', () => {
  it('reads a long number followed by a province', () => {
    expect(extractSlipPlate('Proof of Van Dispatching\n725067723224(พระนครศรีอยุธยา)\n2026-11-25')).toEqual({ plate: '725067723224', province: 'พระนครศรีอยุธยา' });
    // OCR spacing and a slightly misread province still work.
    expect(extractSlipPlate('7250 6772 3224 (พระนครศรีอยุรยา)')).toEqual({ plate: '725067723224', province: 'พระนครศรีอยุธยา' });
  });
  it('ignores brackets that are not a province, and short/letter-only tokens', () => {
    expect(extractSlipPlate('SAM1VFKD36 (ตัวอย่างเอกสาร)')).toBeNull();
    expect(extractSlipPlate('ABC (ชลบุรี)')).toBeNull();
  });
});
