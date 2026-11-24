// Used by .github/workflows/deploy.yml. Finds or creates the D1 database and R2 bucket
// in the target Cloudflare account (from CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID)
// and writes the database ID into wrangler.jsonc. If R2 is not enabled on the account,
// the R2 binding is removed: the app then streams recent images from Drive instead.
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';

const sh = (cmd) => execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const summary = (line) => process.env.GITHUB_STEP_SUMMARY && appendFileSync(process.env.GITHUB_STEP_SUMMARY, line + '\n');
let cfg = readFileSync('wrangler.jsonc', 'utf8');

// D1
let dbs = JSON.parse(sh('npx wrangler d1 list --json'));
let db = dbs.find((d) => d.name === 'vehicle-photos');
if (!db) {
  console.log('Creating D1 database vehicle-photos…');
  sh('npx wrangler d1 create vehicle-photos');
  dbs = JSON.parse(sh('npx wrangler d1 list --json'));
  db = dbs.find((d) => d.name === 'vehicle-photos');
}
if (!db) throw new Error('Could not find or create the D1 database.');
cfg = cfg.replace('00000000-0000-0000-0000-000000000000', db.uuid);
console.log('D1 database:', db.uuid);

// R2 (optional)
let r2 = true;
try {
  const list = sh('npx wrangler r2 bucket list');
  if (!list.includes('vehicle-photos-cache')) sh('npx wrangler r2 bucket create vehicle-photos-cache');
  console.log('R2 bucket ready.');
} catch (e) {
  r2 = false;
  console.warn('R2 is not available on this account; deploying without the image cache.', String(e.stderr || e).slice(0, 300));
  const block = /\n  "r2_buckets": \[\n    \{\n      "binding": "CACHE",\n      "bucket_name": "vehicle-photos-cache"\n    \}\n  \],/;
  if (!block.test(cfg)) throw new Error('Could not remove the R2 binding from wrangler.jsonc');
  cfg = cfg.replace(block, '');
  summary('> ⚠️ R2 is not enabled on this Cloudflare account, so the app was deployed **without the image cache** (recent images load from Drive, slower). Enable R2 in the Cloudflare dashboard and re-run this workflow to turn it on.');
}
writeFileSync('wrangler.jsonc', cfg);
writeFileSync(process.env.GITHUB_OUTPUT ?? '/dev/null', `r2=${r2}\n`, { flag: 'a' });
