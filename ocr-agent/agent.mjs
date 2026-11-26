// Vehicle Photos — Local OCR computer.
// Asks the server for plate photos, reads them here (OpenCV + Tesseract), sends back the result.
// Run on as many computers as you like: whichever is switched on takes the next plate.
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { hostname } from 'node:os';
import { readDocument, readPlate, shutdown } from './plate.mjs';
import { selfUpdate } from './update.mjs';

const VERSION = '1.6.0';
const cfgFile = new URL('./config.json', import.meta.url);
const exampleFile = new URL('./config.example.json', import.meta.url);

/** First run without config.json: ask for the token here and create the file. */
async function firstRunSetup() {
  const example = existsSync(exampleFile) ? JSON.parse(await readFile(exampleFile, 'utf8')) : {};
  const server = (process.env.VP_SERVER || example.server || '').replace(/\/$/, '');
  console.log('=== ตั้งค่าครั้งแรก / First-time setup ===');
  console.log('ในแดชบอร์ด: เมนู "อ่านป้ายทะเบียน (OCR)" -> + เพิ่มเครื่อง -> คัดลอก token (ขึ้นต้นด้วย vpa_)');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  rl.setPrompt('วาง token แล้วกด Enter (คลิกขวาเพื่อวาง) / Paste token: ');
  rl.prompt();
  // Read line by line so a pasted multi-line block (the whole config from the dashboard) works too.
  for await (const line of rl) {
    const text = line.trim();
    const token = /"token"\s*:\s*"([^"]+)"/.exec(text)?.[1] ?? (/^"?vpa_/.test(text) ? text.replace(/^"|"[,]?$/g, '') : null);
    if (!token) {
      // Other lines of a pasted JSON block ({, "server": …, }) are simply skipped.
      if (text && !/^[{}]|"server"|"minConfidence"/.test(text)) console.log('token ไม่ถูกต้อง ต้องขึ้นต้นด้วย vpa_ ลองใหม่');
      if (!/^[{}]|"server"|"minConfidence"/.test(text)) rl.prompt();
      continue;
    }
    const res = await fetch(`${server}/api/ocr-agent/ping`, { headers: { Authorization: `Bearer ${token}` } }).catch((e) => ({ ok: false, status: e.message }));
    if (!res.ok) {
      console.log(`เชื่อมต่อไม่สำเร็จ (${res.status}) — ตรวจว่าคัดลอก token ครบ และเครื่องนี้ไม่ได้ถูกลบในแดชบอร์ด`);
      rl.prompt();
      continue;
    }
    const { name } = await res.json();
    const cfg = { server, token, minConfidence: example.minConfidence ?? 0.7 };
    await writeFile(cfgFile, JSON.stringify(cfg, null, 2));
    console.log(`บันทึก config.json แล้ว — เครื่องนี้คือ "${name}"\n`);
    rl.close();
    return cfg;
  }
  console.log('ยกเลิกการตั้งค่า');
  process.exit(1);
}

const cfg = existsSync(cfgFile)
  ? JSON.parse((await readFile(cfgFile, 'utf8')).replace(/^\uFEFF/, ''))
  : process.stdin.isTTY
    ? await firstRunSetup()
    : {};
const SERVER = (process.env.VP_SERVER || cfg.server || '').replace(/\/$/, '');
const TOKEN = process.env.VP_TOKEN || cfg.token || '';
// Below this confidence the plate is not filled in (it stays "ไม่ระบุ" for an admin to check).
const MIN_CONFIDENCE = Number(process.env.VP_MIN_CONFIDENCE || cfg.minConfidence || 0.7);

if (!SERVER || !TOKEN) {
  console.error('ยังไม่ได้ตั้งค่า: คัดลอก config.example.json เป็น config.json แล้วใส่ server และ token จากแดชบอร์ด');
  process.exit(1);
}

const headers = { Authorization: `Bearer ${TOKEN}`, 'X-Agent-Version': `${VERSION} ${hostname()}`.slice(0, 40) };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => new Date().toLocaleTimeString('th-TH');

async function api(method, path, body) {
  const res = await fetch(SERVER + path, {
    method,
    headers: { ...headers, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    console.error(`[${now()}] token ไม่ถูกต้องหรือเครื่องนี้ถูกปิดใช้งานในแดชบอร์ด`);
    process.exit(2);
  }
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res;
}

let stopping = false;
process.on('SIGINT', () => { stopping = true; console.log('\nกำลังหยุด…'); });

console.log(`Local OCR v${VERSION} — เชื่อมต่อ ${SERVER}`);
console.log('กำลังเตรียม OpenCV + Tesseract (ครั้งแรกอาจใช้เวลาสักครู่)…');
let failures = 0;
let announcedIdle = false;
// Self-update check: at start, then every 3 hours, and only between jobs. config.json "autoUpdate": false turns it off.
const AUTO_UPDATE = cfg.autoUpdate !== false && process.env.VP_AUTO_UPDATE !== '0';
let nextUpdateCheck = 0;
while (!stopping) {
  if (AUTO_UPDATE && Date.now() >= nextUpdateCheck) {
    nextUpdateCheck = Date.now() + 3 * 3600_000;
    try {
      if (await selfUpdate(SERVER, VERSION, (m) => console.log(`[${now()}] ${m}`))) {
        await shutdown();
        process.exit(0); // the start script starts the new version in a few seconds
      }
    } catch (e) {
      console.error(`[${now()}] อัปเดตอัตโนมัติไม่สำเร็จ (${e.message}) — ใช้เวอร์ชันเดิมต่อ`);
    }
  }
  try {
    const { job, pollSeconds } = await (await api('POST', '/api/ocr-agent/poll', {})).json();
    failures = 0;
    if (!job) {
      if (!announcedIdle) { console.log(`[${now()}] พร้อมทำงาน — รอป้ายใหม่ (ถามทุก ${pollSeconds} วินาที)`); announcedIdle = true; }
      await sleep(pollSeconds * 1000);
      continue;
    }
    announcedIdle = false;
    try {
      const img = Buffer.from(await (await api('GET', job.imageUrl)).arrayBuffer());
      const r = job.kind === 'document' ? await readDocument(img) : await readPlate(img);
      const plate = r.plate && r.confidence >= MIN_CONFIDENCE ? r.plate : null;
      await api('POST', `/api/ocr-agent/jobs/${job.id}/result`, { text: r.text, plate, confidence: r.confidence, barCode: r.barCode ?? null });
      console.log(`[${now()}] ${job.publicId ?? job.id}${job.kind === 'document' ? ' (ใบบาร์รถ)' : ''}: ${plate ?? `ไม่แน่ใจ (${r.plate ?? 'อ่านไม่ได้'})`} · ${Math.round(r.confidence * 100)}%${r.barCode ? ` · บาร์ ${r.barCode}` : ''} · ${r.timings.totalMs} ms`);
    } catch (e) {
      console.error(`[${now()}] อ่านป้าย ${job.publicId ?? job.id} ไม่สำเร็จ: ${e.message}`);
      await api('POST', `/api/ocr-agent/jobs/${job.id}/result`, { error: String(e.message).slice(0, 300) }).catch(() => {});
    }
  } catch (e) {
    failures++;
    const wait = Math.min(300, 5 * 2 ** Math.min(failures, 6));
    console.error(`[${now()}] ติดต่อเซิร์ฟเวอร์ไม่ได้ (${e.message}) — ลองใหม่ใน ${wait} วินาที`);
    await sleep(wait * 1000);
  }
}
await shutdown();
