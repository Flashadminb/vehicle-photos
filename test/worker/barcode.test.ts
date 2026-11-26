import { describe, expect, it } from 'vitest';
import { loggedIn, putToDrive, rid, testEnv, Client } from './helpers';
import { extractBarCode } from '../../src/shared/plate';
import { roundFolderName } from '../../src/shared/names';
import { resultFromText } from '../../src/worker/services/ocr';

describe('bar number (เลขบาร์รถ)', () => {
  it('is found in slip text, including OCR slips', () => {
    expect(extractBarCode('Proof of Van Dispatching\n725067723224(พระนครศรีอยุธยา) 2026-11-25\nSAM1VFKD36')).toBe('SAM1VFKD36');
    expect(extractBarCode('BKKIVFAX09')).toBe('BKK1VFAX09'); // I read for 1
    expect(extractBarCode('SAM1VF KD36')).toBe('SAM1VFKD36'); // split by OCR
    expect(extractBarCode('2026-11-25 PF-000027 21BPLL')).toBeNull();
    expect(resultFromText('700-9296(กรุงเทพ) 2026-11-25\nSAS1VFME63', 0.9, 'document').barCode).toBe('SAS1VFME63');
  });

  it('goes into the Drive folder name', () => {
    expect(roundFolderName(Date.UTC(2026, 10, 25, 3, 4, 5), '725067723224 (พระนครศรีอยุธยา)', 'PF-000011', 'SAM1VFKD36')).toMatch(/_SAM1VFKD36_PF-000011$/);
  });

  it('phone-decoded > OCR; typed by hand wins; search by start or end; filter sets without it', async () => {
    const { client: admin } = await loggedIn('admin', 'super_admin');
    const op = await loggedIn('field', 'operator');
    const field: Client = op.client;
    const boot = await field.json('GET', '/api/field/bootstrap');
    const wf = boot.body.workflow;
    const round = rid();
    let roundId = '';
    for (const [i, step] of wf.steps.entries()) {
      const b = await field.json('POST', '/api/field/images/begin', { clientRoundId: round, clientImageId: rid(), workflowVersionId: wf.id, stepId: step.id, source: 'camera', acceptedAtDevice: Date.now() });
      roundId = b.body.round.id;
      const d = await putToDrive(field, b.body.uploads.display.url);
      await field.json('POST', `/api/field/images/${b.body.image.id}/complete`, { displayFileId: d, barCode: i === 0 ? 'SAM1VFKD36' : undefined });
    }
    const row = await testEnv.DB.prepare(`SELECT bar_code, bar_code_source, drive_folder_id FROM rounds WHERE id = ?`).bind(roundId).first<any>();
    expect(row).toMatchObject({ bar_code: 'SAM1VFKD36', bar_code_source: 'device' });

    // An OCR reading does not override the phone-decoded one.
    const { applyBarCode } = await import('../../src/worker/services/ocr');
    expect(await applyBarCode(testEnv, roundId, 'SAM1VFKD99', 'ocr')).toBe(false);

    const q = (s: string) => admin.json('GET', `/api/admin/sets?status=all&q=${encodeURIComponent(s)}&operatorId=${op.user.id}`);
    expect((await q('SAM1VF')).body.total).toBe(1); // starts with
    expect((await q('vfkd36')).body.total).toBe(1); // ends with, any case
    expect((await q('SAM1VFXX')).body.total).toBe(0);
    expect((await admin.json('GET', `/api/admin/sets?status=all&plate=nobar&operatorId=${op.user.id}`)).body.total).toBe(0);

    // Typed by hand wins and renames the folder.
    const put = await admin.json('PUT', `/api/admin/sets/${roundId}/barcode`, { barCode: 'bkk1vfax09' });
    expect(put.body.barCode).toBe('BKK1VFAX09');
    const f = await testEnv.DB.prepare(`SELECT name FROM demo_drive_files WHERE id = ?`).bind(row.drive_folder_id).first<any>();
    expect(f.name).toContain('BKK1VFAX09');
    expect(await applyBarCode(testEnv, roundId, 'SAM1VFKD36', 'device')).toBe(false);
    // Cleared by hand → shows up under "no bar number".
    await admin.json('PUT', `/api/admin/sets/${roundId}/barcode`, { barCode: '' });
    expect((await admin.json('GET', `/api/admin/sets?status=all&plate=nobar&operatorId=${op.user.id}`)).body.total).toBe(1);
  });
});
