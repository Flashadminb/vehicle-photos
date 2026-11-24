export interface Env {
  DB: D1Database;
  /**
   * Optional R2 image cache. Without it (e.g. R2 not enabled on the account) the app
   * still works: recent images are streamed from Drive instead of the cache.
   */
  CACHE?: R2Bucket;
  ASSETS?: Fetcher;

  /** 'google' (production) or 'demo' (explicitly labelled demo mode, emulated Drive). */
  DRIVE_MODE: string;
  /** Default root folder for photo sets (can be changed in the dashboard). */
  DRIVE_ROOT_FOLDER_ID?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  /** Public base URL used for the OAuth redirect, e.g. https://photos.example.workers.dev */
  PUBLIC_BASE_URL?: string;
  /** 32-byte key (base64) used to encrypt the Google refresh token at rest. */
  TOKEN_ENC_KEY?: string;
  /** One-time token required to create the first Super Admin via /api/setup. */
  SETUP_TOKEN?: string;
  GOOGLE_VISION_API_KEY?: string;
  AIFORTHAI_API_KEY?: string;
  /** PBKDF2 iterations for new password hashes (Workers cap: 100000). */
  PASSWORD_ITERATIONS?: string;
}

export type AppBindings = { Bindings: Env; Variables: { user: AuthUser; sessionId: string; now: number } };

export interface AuthUser {
  id: string;
  username: string;
  displayName: string;
  role: import('../shared/types').Role;
  language: string | null;
  hasPin: boolean;
  mustChangePassword: boolean;
}
