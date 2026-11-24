import { formatBangkok } from '../../shared/time';
import { api } from '../shared/api';

interface ExportSet {
  id: string;
  publicId: string;
  startedAt: number;
  plateDisplay: string;
  operator: { name: string };
  activeCount: number;
  requiredCount: number;
  status: string;
  driveUrl: string | null;
  steps: { id: string; label: string; image: { id: string; source: string; captureTimeDevice: number | null; serverReceivedAt: number; uploadedAt: number } | null }[];
}

const IMG_W = 200;
const IMG_H = 150;

/**
 * Build an .xlsx with the photos embedded (not links) entirely in the browser.
 * The server only grants an audited, 1-hour export token and serves the display copies
 * (from the R2 cache when present, otherwise streamed from Drive). Display copies
 * (~1600 px) are scaled into cells to keep the workbook a manageable size.
 */
export async function exportSetsToExcel(
  setIds: string[],
  onProgress: (done: number, total: number) => void,
  signal: AbortSignal,
): Promise<void> {
  const { exportId, sets } = await api<{ exportId: string; sets: ExportSet[] }>('POST', '/api/admin/exports', { setIds });
  const mod: any = await import('exceljs/dist/exceljs.min.js');
  const ExcelJS = mod.default ?? mod;
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Vehicle Photos';
  wb.created = new Date();
  const ws = wb.addWorksheet('Photo sets', { views: [{ state: 'frozen', ySplit: 1 }] });

  // One image column per step label (sets may come from different workflow versions).
  const stepLabels: string[] = [];
  for (const s of sets) for (const st of s.steps) if (!stepLabels.includes(st.label)) stepLabels.push(st.label);
  const fixed = ['Round start (Asia/Bangkok)', 'Photo set ID', 'License plate', 'Operator', 'Images', 'Status'];
  ws.columns = [
    ...fixed.map((h, i) => ({ header: h, key: `c${i}`, width: [22, 14, 16, 20, 10, 12][i] })),
    ...stepLabels.map((h) => ({ header: h, key: `s:${h}`, width: IMG_W / 7 + 2 })),
    { header: 'Drive folder', key: 'drive', width: 18 },
  ];
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).alignment = { vertical: 'middle' };

  const total = sets.reduce((n, s) => n + s.steps.filter((x) => x.image).length, 0);
  let done = 0;
  onProgress(0, total);

  for (let r = 0; r < sets.length; r++) {
    if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
    const s = sets[r];
    const rowIndex = r + 2;
    const row = ws.getRow(rowIndex);
    row.values = [formatBangkok(s.startedAt), s.publicId, s.plateDisplay, s.operator.name, `${s.activeCount}/${s.requiredCount}`, s.status];
    row.height = IMG_H * 0.75 + 6; // points
    row.alignment = { vertical: 'middle', wrapText: true };
    if (s.driveUrl) {
      const url = s.driveUrl.startsWith('http') ? s.driveUrl : location.origin + s.driveUrl;
      row.getCell(fixed.length + stepLabels.length + 1).value = { text: 'Open folder', hyperlink: url };
    }
    // Fetch this set's images with limited parallelism.
    const jobs = s.steps.filter((st) => st.image).map((st) => async () => {
      const res = await fetch(`/api/admin/exports/${exportId}/images/${st.image!.id}`, { signal, credentials: 'same-origin' });
      if (!res.ok) throw new Error(`Image ${s.publicId}/${st.label} failed (${res.status})`);
      const buf = await res.arrayBuffer();
      const bmp = await createImageBitmap(new Blob([buf]));
      const scale = Math.min(IMG_W / bmp.width, IMG_H / bmp.height);
      const ext = { width: Math.round(bmp.width * scale), height: Math.round(bmp.height * scale) };
      bmp.close();
      const imageId = wb.addImage({ buffer: buf, extension: 'jpeg' });
      const col = fixed.length + stepLabels.indexOf(st.label);
      ws.addImage(imageId, { tl: { col: col + 0.05, row: rowIndex - 1 + 0.05 }, ext, editAs: 'oneCell' });
      done++;
      onProgress(done, total);
    });
    for (let i = 0; i < jobs.length; i += 3) await Promise.all(jobs.slice(i, i + 3).map((j) => j()));
  }

  const out = await wb.xlsx.writeBuffer();
  const blob = new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  const stamp = formatBangkok(Date.now()).replace(/[: ]/g, '-');
  a.download = `photo-sets_${stamp}.xlsx`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}
