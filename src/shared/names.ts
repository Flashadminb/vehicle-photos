import { bangkokTimeForName } from './time';

/**
 * Make a string safe as a Google Drive file/folder name and readable in any OS
 * when the folder is downloaded: strip path separators, reserved characters,
 * control characters, collapse whitespace, trim dots/spaces, cap the length.
 */
export function sanitizeName(input: string, maxLength = 80): string {
  let s = (input ?? '').normalize('NFC');
  s = s.replace(/[\u0000-\u001f\u007f]/g, '');
  s = s.replace(/[\\/:*?"<>|#%{}^~[\]`]/g, '-');
  s = s.replace(/\s+/g, ' ').trim();
  s = s.replace(/^[.\s-]+|[.\s]+$/g, '');
  if (s.length > maxLength) s = s.slice(0, maxLength).trim();
  return s || '-';
}

/** HH-mm-ss_PLATE[_BAR]_ROUND-ID using the round's first accepted image time (Bangkok). */
export function roundFolderName(startedAtMs: number, plateOrLabel: string, publicId: string, barCode?: string | null): string {
  const plate = sanitizeName(plateOrLabel, 50).replace(/ /g, '');
  const bar = barCode ? `_${sanitizeName(barCode, 20)}` : '';
  return `${bangkokTimeForName(startedAtMs)}_${plate}${bar}_${sanitizeName(publicId, 20)}`;
}

/** 01_STEP-NAME.jpg */
export function stepFileName(stepIndex: number, stepLabel: string, suffix = ''): string {
  const n = String(stepIndex + 1).padStart(2, '0');
  const label = sanitizeName(stepLabel, 50).replace(/ /g, '-');
  return `${n}_${label}${suffix}.jpg`;
}

export function publicIdFromSeq(seq: number): string {
  return `PF-${String(seq).padStart(6, '0')}`;
}
