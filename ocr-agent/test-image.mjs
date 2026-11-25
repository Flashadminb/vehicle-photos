// Try the plate reader on your own photos — no server needed.
//   node test-image.mjs photo1.jpg photo2.jpg ...
//   node test-image.mjs folder-with-photos
// Name files with the true plate (e.g. "กข1234.jpg") to get an accuracy score.
import { readFile, readdir, stat } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { readDocument, readPlate, shutdown } from './plate.mjs';

// --doc: the photos are printed slips (ใบบาร์รถ) instead of licence plates.
const docMode = process.argv.includes('--doc');
const args = process.argv.slice(2).filter((a) => a !== '--doc');
if (!args.length) {
  console.log('วิธีใช้: node test-image.mjs <รูป.jpg | โฟลเดอร์>');
  process.exit(1);
}
const files = [];
for (const a of args) {
  if ((await stat(a)).isDirectory()) {
    for (const f of await readdir(a)) if (/\.(jpe?g|png|webp|heic)$/i.test(f)) files.push(join(a, f));
  } else files.push(a);
}
const norm = (s) => (s || '').replace(/[\s-]/g, '');
let scored = 0, correct = 0;
for (const f of files) {
  const r = await (docMode ? readDocument : readPlate)(await readFile(f), { debugDir: files.length === 1 ? 'debug' : undefined });
  const expected = basename(f, extname(f)).split(/[_ ]/)[0];
  const hasLabel = (/[ก-ฮ]/.test(expected) && /\d/.test(expected)) || /^\d{2}-?\d{4}$/.test(expected);
  let mark = '';
  if (hasLabel) {
    scored++;
    if (norm(r.plate) === norm(expected)) { correct++; mark = '✅'; } else mark = `❌ (ควรเป็น ${expected})`;
  }
  console.log(`${basename(f)} → ${r.plate ?? 'อ่านไม่ได้'} ${r.province ? '· ' + r.province : ''} · มั่นใจ ${(r.confidence * 100).toFixed(0)}% · ${r.plateFound ? 'เจอกรอบป้าย' : 'ไม่เจอกรอบ (ใช้กลางภาพ)'} · ${r.timings.totalMs} ms ${mark}`);
}
if (scored) console.log(`\nความแม่นยำ: ${correct}/${scored} = ${((correct / scored) * 100).toFixed(0)}%`);
if (files.length === 1) console.log('ภาพที่ใช้อ่าน บันทึกไว้ในโฟลเดอร์ debug/');
await shutdown();
