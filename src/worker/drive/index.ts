import type { Env } from '../env';
import { DemoDrive, DEMO_ROOT_ID } from './demo';
import { GoogleDrive } from './google';
import type { DriveClient } from './types';

export function isDemo(env: Env) {
  return env.DRIVE_MODE === 'demo';
}

/** Test hook: lets tests inject a recording/faulty Drive. */
let override: ((env: Env) => DriveClient) | null = null;
export function setDriveOverride(fn: ((env: Env) => DriveClient) | null) {
  override = fn;
}

export function getDrive(env: Env, baseUrl = ''): DriveClient {
  if (override) return override(env);
  return isDemo(env) ? new DemoDrive(env, baseUrl) : new GoogleDrive(env);
}

export function effectiveRoot(env: Env, configuredRoot: string): string {
  if (isDemo(env)) return DEMO_ROOT_ID;
  return configuredRoot;
}
