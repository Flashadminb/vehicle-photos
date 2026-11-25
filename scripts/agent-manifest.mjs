// Publishes the Local OCR program files for self-update: dist/downloads/agent/<file> + manifest.json
// (version + sha256 of each file). No config.json, no token, no node_modules.
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const FILES = ['agent.mjs', 'plate.mjs', 'provinces.mjs', 'update.mjs', 'test-image.mjs', 'package.json', 'README.md', 'config.example.json'];
const out = 'dist/downloads/agent';
await mkdir(out, { recursive: true });
const pkg = JSON.parse(await readFile('ocr-agent/package.json', 'utf8'));
const agentSrc = await readFile('ocr-agent/agent.mjs', 'utf8');
const m = /const VERSION = '([^']+)'/.exec(agentSrc);
if (!m || m[1] !== pkg.version) throw new Error(`agent.mjs VERSION (${m?.[1]}) must equal package.json version (${pkg.version})`);
const files = [];
for (const f of FILES) {
  const buf = await readFile(`ocr-agent/${f}`);
  await writeFile(`${out}/${f}`, buf);
  files.push({ path: f, sha256: createHash('sha256').update(buf).digest('hex') });
}
await writeFile(`${out}/manifest.json`, JSON.stringify({ version: pkg.version, files }, null, 2));
console.log(`agent ${pkg.version}: ${files.length} files`);
