import type { Env } from '../env';
import type { AppSettings } from '../../shared/types';

/**
 * R2 is a disposable read cache for recent display copies and thumbnails. Google
 * Drive is the system of record. Cache usage is tracked in D1 (no bucket listing), and
 * when usage passes the threshold (default 70% of the configured quota) the oldest
 * objects are evicted down to the target (default 60%). Evicting never touches Drive.
 */
export type CacheKind = 'thumb' | 'display';
export const MAX_CACHE_OBJECT_BYTES = 3 * 1024 * 1024;

export const cacheKey = (imageId: string, kind: CacheKind) => `cache/${imageId}/${kind}.jpg`;

export async function putCache(env: Env, imageId: string, kind: CacheKind, body: ArrayBuffer, now = Date.now()) {
  const key = cacheKey(imageId, kind);
  await env.CACHE.put(key, body, { httpMetadata: { contentType: 'image/jpeg' } });
  await env.DB.prepare(
    `INSERT INTO cache_objects (key, image_id, kind, bytes, created_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET bytes = excluded.bytes, created_at = excluded.created_at`,
  )
    .bind(key, imageId, kind, body.byteLength, now)
    .run();
}

export async function getCache(env: Env, imageId: string, kind: CacheKind) {
  return env.CACHE.get(cacheKey(imageId, kind));
}

export async function cacheUsage(env: Env) {
  const r = await env.DB.prepare(`SELECT COALESCE(SUM(bytes), 0) AS bytes, COUNT(*) AS objects FROM cache_objects`).first<{
    bytes: number;
    objects: number;
  }>();
  return { bytes: r?.bytes ?? 0, objects: r?.objects ?? 0 };
}

export async function evictCache(env: Env, settings: AppSettings, maxBatches = 5) {
  const threshold = (settings.cacheQuotaBytes * settings.cacheThresholdPct) / 100;
  const target = (settings.cacheQuotaBytes * settings.cacheTargetPct) / 100;
  let { bytes } = await cacheUsage(env);
  let evicted = 0;
  if (bytes <= threshold) return { evicted, bytes };
  for (let i = 0; i < maxBatches && bytes > target; i++) {
    const { results } = await env.DB.prepare(`SELECT key, bytes FROM cache_objects ORDER BY created_at ASC LIMIT 200`).all<{
      key: string;
      bytes: number;
    }>();
    if (!results.length) break;
    const batch: string[] = [];
    for (const r of results) {
      if (bytes <= target) break;
      batch.push(r.key);
      bytes -= r.bytes;
    }
    if (!batch.length) break;
    await env.CACHE.delete(batch);
    await env.DB.prepare(`DELETE FROM cache_objects WHERE key IN (${batch.map(() => '?').join(',')})`).bind(...batch).run();
    evicted += batch.length;
  }
  return { evicted, bytes };
}

export async function cachedKinds(env: Env, imageIds: string[]): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>();
  if (!imageIds.length) return out;
  const { results } = await env.DB.prepare(
    `SELECT image_id, kind FROM cache_objects WHERE image_id IN (${imageIds.map(() => '?').join(',')})`,
  )
    .bind(...imageIds)
    .all<{ image_id: string; kind: string }>();
  for (const r of results) {
    if (!out.has(r.image_id)) out.set(r.image_id, new Set());
    out.get(r.image_id)!.add(r.kind);
  }
  return out;
}
