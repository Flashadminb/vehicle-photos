// Self-update: the program fetches its own newer version from the dashboard server, so the
// office computers never need a manual re-install. Only program files are replaced; config.json
// (the token) and the start scripts are never touched. Runs only while the program is idle.
import { createHash } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
// Files the updater may replace (anything else in a manifest is ignored).
const UPDATABLE = new Set(['agent.mjs', 'plate.mjs', 'provinces.mjs', 'update.mjs', 'test-image.mjs', 'package.json', 'README.md', 'config.example.json']);

export function newer(a, b) {
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

function npmInstall() {
  return new Promise((resolve) => {
    const p = spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '--omit=dev', '--no-audit', '--no-fund', '--loglevel=error'], { cwd: here, stdio: 'inherit', shell: process.platform === 'win32' });
    p.on('exit', (code) => resolve(code === 0));
    p.on('error', () => resolve(false));
  });
}

/**
 * Returns the new version if the program was updated (the caller then exits and the start
 * script restarts it), or null when already up to date / the update could not be completed.
 */
export async function selfUpdate(server, currentVersion, log = console.log) {
  const res = await fetch(`${server}/downloads/agent/manifest.json?t=${Date.now()}`, { cache: 'no-store' });
  if (!res.ok) return null;
  const manifest = await res.json();
  if (!manifest?.version || !newer(manifest.version, currentVersion)) return null;
  log(`พบโปรแกรมเวอร์ชันใหม่ ${manifest.version} — กำลังอัปเดตอัตโนมัติ…`);
  // Download and verify everything first; only then replace files (never a half-updated program).
  const files = [];
  for (const f of manifest.files ?? []) {
    if (!UPDATABLE.has(f.path)) continue;
    const r = await fetch(`${server}/downloads/agent/${f.path}?v=${manifest.version}`, { cache: 'no-store' });
    if (!r.ok) throw new Error(`download ${f.path} → ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());
    if (sha256(buf) !== f.sha256) throw new Error(`ไฟล์ ${f.path} เสียระหว่างดาวน์โหลด`);
    files.push({ path: f.path, buf });
  }
  if (!files.some((f) => f.path === 'agent.mjs')) throw new Error('manifest ไม่สมบูรณ์');
  const oldPkg = await readFile(join(here, 'package.json'), 'utf8').catch(() => '');
  for (const f of files) {
    const target = join(here, f.path);
    await writeFile(`${target}.new`, f.buf);
    await rename(`${target}.new`, target);
  }
  const newPkg = files.find((f) => f.path === 'package.json')?.buf.toString('utf8');
  const deps = (s) => { try { return JSON.stringify(JSON.parse(s).dependencies ?? {}); } catch { return ''; } };
  if (newPkg && deps(newPkg) !== deps(oldPkg)) {
    log('กำลังติดตั้งส่วนประกอบที่เปลี่ยนไป…');
    await npmInstall();
  }
  log(`อัปเดตเป็น ${manifest.version} แล้ว — กำลังเริ่มโปรแกรมใหม่`);
  return manifest.version;
}
