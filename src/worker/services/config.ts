import type { Env } from '../env';
import { OCR_PROVIDERS, DEFAULT_SETTINGS, type AppSettings, type Language, type WorkflowStep, type WorkflowVersion } from '../../shared/types';
import { badRequest } from '../util';

export async function getSettings(env: Env): Promise<AppSettings> {
  const row = await env.DB.prepare(`SELECT value FROM settings WHERE key = 'app'`).first<{ value: string }>();
  const stored = row ? (JSON.parse(row.value) as Partial<AppSettings>) : {};
  const merged = { ...DEFAULT_SETTINGS, ...stored };
  if (!merged.driveRootFolderId) merged.driveRootFolderId = env.DRIVE_ROOT_FOLDER_ID ?? '';
  return merged;
}

const NUMERIC_LIMITS: Partial<Record<keyof AppSettings, [number, number]>> = {
  recentImageDays: [1, 3650],
  cacheQuotaBytes: [1024 * 1024, 10 * 1024 ** 4],
  cacheThresholdPct: [10, 95],
  cacheTargetPct: [5, 90],
  dbQuotaBytes: [1024 * 1024, 10 * 1024 ** 4],
  dbThresholdPct: [10, 95],
  pinLockMinutes: [1, 240],
  abandonAfterHours: [1, 24 * 90],
  exportMaxSets: [1, 500],
  visionMonthlyFree: [0, 100000],
  imageDisplayEdge: [800, 2560],
  imageOriginalEdge: [1280, 4096],
  cameraMaxEdge: [1280, 3840],
  visionCapPct: [1, 100],
  agentOnlineSeconds: [30, 3600],
  agentPollSeconds: [10, 600],
};

export function validateSettingsPatch(patch: Partial<AppSettings>, current: AppSettings): AppSettings {
  const next: AppSettings = { ...current };
  for (const [k, v] of Object.entries(patch) as [keyof AppSettings, unknown][]) {
    if (!(k in DEFAULT_SETTINGS)) throw badRequest(`Unknown setting: ${k}`);
    const def = DEFAULT_SETTINGS[k];
    if (typeof def === 'number') {
      const n = Number(v);
      const lim = NUMERIC_LIMITS[k];
      if (!Number.isFinite(n) || (lim && (n < lim[0] || n > lim[1]))) throw badRequest(`Invalid value for ${k}.`);
      (next as unknown as Record<string, unknown>)[k] = n;
    } else if (typeof def === 'boolean') {
      (next as unknown as Record<string, unknown>)[k] = Boolean(v);
    } else {
      if (typeof v !== 'string' || v.length > 200) throw badRequest(`Invalid value for ${k}.`);
      (next as unknown as Record<string, unknown>)[k] = v.trim();
    }
  }
  if (!['window', 'cache'].includes(next.imageDisplayMode)) throw badRequest('imageDisplayMode must be window or cache.');
  if (!OCR_PROVIDERS.includes(next.ocrProvider)) throw badRequest('Unknown OCR provider.');
  if (next.cacheTargetPct >= next.cacheThresholdPct) throw badRequest('Cache target must be below the threshold.');
  if (!next.unknownPlateLabel) throw badRequest('The unknown-plate label cannot be empty.');
  return next;
}

export async function saveSettings(env: Env, settings: AppSettings, actorId: string, now: number) {
  await env.DB.prepare(
    `INSERT INTO settings (key, value, updated_at, updated_by) VALUES ('app', ?1, ?2, ?3)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
  )
    .bind(JSON.stringify(settings), now, actorId)
    .run();
}

function rowToWorkflow(r: { id: number; steps: string; note: string | null; created_at: number }): WorkflowVersion {
  return { id: r.id, steps: JSON.parse(r.steps), note: r.note, createdAt: r.created_at };
}

export async function getCurrentWorkflow(env: Env): Promise<WorkflowVersion> {
  const r = await env.DB.prepare(`SELECT * FROM workflow_versions ORDER BY id DESC LIMIT 1`).first<any>();
  if (!r) throw new Error('No workflow configured');
  return rowToWorkflow(r);
}

export async function getWorkflow(env: Env, id: number): Promise<WorkflowVersion | null> {
  const r = await env.DB.prepare(`SELECT * FROM workflow_versions WHERE id = ?`).bind(id).first<any>();
  return r ? rowToWorkflow(r) : null;
}

export async function listWorkflowVersions(env: Env, limit = 20) {
  const { results } = await env.DB.prepare(
    `SELECT w.id, w.note, w.created_at, u.display_name AS created_by_name,
            (SELECT COUNT(*) FROM rounds r WHERE r.workflow_version_id = w.id) AS round_count
     FROM workflow_versions w LEFT JOIN users u ON u.id = w.created_by ORDER BY w.id DESC LIMIT ?`,
  )
    .bind(limit)
    .all();
  return results;
}

export function validateSteps(steps: unknown, languages: string[]): WorkflowStep[] {
  if (!Array.isArray(steps) || steps.length === 0) throw badRequest('The workflow needs at least one step.');
  if (steps.length > 30) throw badRequest('Too many steps (max 30).');
  const seen = new Set<string>();
  const out: WorkflowStep[] = [];
  for (const raw of steps as any[]) {
    const id = typeof raw?.id === 'string' && /^[a-z0-9_-]{3,40}$/i.test(raw.id) ? raw.id : null;
    if (!id) throw badRequest('Each step needs a valid id.');
    if (seen.has(id)) throw badRequest(`Duplicate step id ${id}.`);
    seen.add(id);
    const labels: Record<string, string> = {};
    for (const [lang, label] of Object.entries(raw.labels ?? {})) {
      if (typeof label === 'string' && label.trim()) labels[lang] = label.trim().slice(0, 60);
    }
    if (!languages.some((l) => labels[l])) throw badRequest(`Step ${id} needs a label.`);
    out.push({ id, required: Boolean(raw.required), allowUpload: Boolean(raw.allowUpload), ocr: Boolean(raw.ocr), ocrKind: raw.ocrKind === 'document' ? 'document' : 'plate',
      ...(['none', 'plate', 'slip', 'slip_line'].includes(raw.guide) ? { guide: raw.guide } : {}),
      ...(raw.imageSize === 'small' ? { imageSize: 'small' as const } : {}),
      labels });
  }
  if (!out.some((s) => s.required)) throw badRequest('At least one step must be required.');
  return out;
}

export async function publishWorkflow(env: Env, steps: WorkflowStep[], note: string, actorId: string, now: number) {
  const r = await env.DB.prepare(
    `INSERT INTO workflow_versions (steps, note, created_at, created_by) VALUES (?, ?, ?, ?) RETURNING id`,
  )
    .bind(JSON.stringify(steps), note || null, now, actorId)
    .first<{ id: number }>();
  return r!.id;
}

export async function getLanguages(env: Env): Promise<Language[]> {
  const { results } = await env.DB.prepare(`SELECT * FROM languages ORDER BY sort, code`).all<any>();
  return results.map((r) => ({ code: r.code, name: r.name, enabled: !!r.enabled, sort: r.sort }));
}

export async function getTranslationOverrides(env: Env): Promise<Record<string, Record<string, string>>> {
  const { results } = await env.DB.prepare(`SELECT lang, key, value FROM translations`).all<any>();
  const out: Record<string, Record<string, string>> = {};
  for (const r of results) (out[r.lang] ??= {})[r.key] = r.value;
  return out;
}
