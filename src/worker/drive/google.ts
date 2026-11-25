import type { Env } from '../env';
import { decryptSecret, encryptSecret } from '../crypto';
import { DriveNotConnectedError, type DriveClient, type DriveFile } from './types';

const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive';
const FILE_FIELDS = 'id,name,parents,size,trashed,createdTime,mimeType';

interface StoredToken {
  refreshToken: string;
  accessToken?: string;
  accessExpiresAt?: number;
  connectedEmail?: string;
  connectedAt: number;
}

export async function loadToken(env: Env): Promise<StoredToken | null> {
  const row = await env.DB.prepare(`SELECT value FROM settings WHERE key = 'drive_token'`).first<{ value: string }>();
  if (!row) return null;
  if (!env.TOKEN_ENC_KEY) throw new Error('TOKEN_ENC_KEY secret is not configured.');
  return JSON.parse(await decryptSecret(row.value, env.TOKEN_ENC_KEY));
}

export async function saveToken(env: Env, token: StoredToken, actorId: string | null) {
  if (!env.TOKEN_ENC_KEY) throw new Error('TOKEN_ENC_KEY secret is not configured.');
  const value = await encryptSecret(JSON.stringify(token), env.TOKEN_ENC_KEY);
  await env.DB.prepare(
    `INSERT INTO settings (key, value, updated_at, updated_by) VALUES ('drive_token', ?1, ?2, ?3)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
  )
    .bind(value, Date.now(), actorId)
    .run();
}

export async function clearToken(env: Env) {
  await env.DB.prepare(`DELETE FROM settings WHERE key = 'drive_token'`).run();
}

export function oauthRedirectUri(env: Env, requestUrl: string) {
  const base = env.PUBLIC_BASE_URL || new URL(requestUrl).origin;
  return `${base.replace(/\/$/, '')}/api/admin/drive/oauth/callback`;
}

export function buildAuthUrl(env: Env, redirectUri: string, state: string) {
  const p = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID ?? '',
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: `${DRIVE_SCOPE} openid email`,
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${p}`;
}

export async function exchangeCode(env: Env, code: string, redirectUri: string) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID ?? '',
      client_secret: env.GOOGLE_CLIENT_SECRET ?? '',
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  });
  const body = (await res.json()) as any;
  if (!res.ok) throw new Error(`Google token exchange failed: ${body.error_description || body.error || res.status}`);
  if (!body.refresh_token) throw new Error('Google did not return a refresh token. Remove the app from your Google account permissions and connect again.');
  let email: string | undefined;
  if (body.id_token) {
    try {
      email = JSON.parse(atob(body.id_token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).email;
    } catch {
      /* ignore */
    }
  }
  return {
    refreshToken: body.refresh_token as string,
    accessToken: body.access_token as string,
    accessExpiresAt: Date.now() + (body.expires_in - 60) * 1000,
    connectedEmail: email,
  };
}

export class GoogleDrive implements DriveClient {
  readonly mode = 'google' as const;
  private token: StoredToken | null = null;

  constructor(private env: Env) {}

  private async accessToken(): Promise<string> {
    if (!this.token) this.token = await loadToken(this.env);
    if (!this.token) throw new DriveNotConnectedError();
    if (this.token.accessToken && (this.token.accessExpiresAt ?? 0) > Date.now()) return this.token.accessToken;
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.env.GOOGLE_CLIENT_ID ?? '',
        client_secret: this.env.GOOGLE_CLIENT_SECRET ?? '',
        refresh_token: this.token.refreshToken,
        grant_type: 'refresh_token',
      }),
    });
    const body = (await res.json()) as any;
    if (!res.ok) {
      if (body.error === 'invalid_grant') throw new DriveNotConnectedError('Google Drive access was revoked or expired. Reconnect Drive in settings.');
      throw new Error(`Google token refresh failed: ${body.error || res.status}`);
    }
    this.token = { ...this.token, accessToken: body.access_token, accessExpiresAt: Date.now() + (body.expires_in - 60) * 1000 };
    await saveToken(this.env, this.token, null);
    return this.token.accessToken!;
  }

  private async call(path: string, init: RequestInit = {}, base = API): Promise<Response> {
    const token = await this.accessToken();
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${token}`);
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(`${base}${path}`, { ...init, headers });
      // Back off on rate limits / transient errors (Drive returns 403 rateLimitExceeded too).
      if ((res.status === 429 || res.status >= 500 || res.status === 403) && attempt < 2) {
        const text = await res.clone().text();
        if (res.status !== 403 || /rate|quota/i.test(text)) {
          await new Promise((r) => setTimeout(r, 400 * 2 ** attempt));
          continue;
        }
      }
      return res;
    }
  }

  private async json<T>(path: string, init?: RequestInit, base?: string): Promise<T> {
    const res = await this.call(path, init, base);
    if (!res.ok) throw new Error(`Drive API ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return (await res.json()) as T;
  }

  async getFile(id: string): Promise<DriveFile | null> {
    const res = await this.call(`/files/${encodeURIComponent(id)}?fields=${FILE_FIELDS}&supportsAllDrives=true`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Drive API ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const f = (await res.json()) as any;
    return { ...f, size: f.size != null ? Number(f.size) : undefined, parents: f.parents ?? [] };
  }

  async findFolders(parentId: string, name: string): Promise<DriveFile[]> {
    const q = `'${parentId.replace(/'/g, "\\'")}' in parents and name = '${name.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}' and mimeType = '${FOLDER_MIME}' and trashed = false`;
    const p = new URLSearchParams({
      q,
      fields: `files(${FILE_FIELDS})`,
      orderBy: 'createdTime',
      pageSize: '10',
      supportsAllDrives: 'true',
      includeItemsFromAllDrives: 'true',
    });
    const r = await this.json<{ files: DriveFile[] }>(`/files?${p}`);
    return r.files.map((f) => ({ ...f, parents: f.parents ?? [] }));
  }

  async createFolder(parentId: string, name: string): Promise<DriveFile> {
    return this.json<DriveFile>(`/files?fields=${FILE_FIELDS}&supportsAllDrives=true`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentId] }),
    });
  }

  async rename(id: string, name: string): Promise<void> {
    await this.json(`/files/${encodeURIComponent(id)}?fields=id&supportsAllDrives=true`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
  }

  async move(id: string, fromParent: string, toParent: string, newName?: string): Promise<void> {
    const p = new URLSearchParams({ addParents: toParent, removeParents: fromParent, fields: 'id', supportsAllDrives: 'true' });
    await this.json(`/files/${encodeURIComponent(id)}?${p}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(newName ? { name: newName } : {}),
    });
  }

  async createUploadSession(parentId: string, name: string, mimeType: string, origin: string | null): Promise<string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Type': mimeType,
    };
    // Google only returns CORS headers on the session URL if the session was started with the browser's Origin.
    if (origin) headers.Origin = origin;
    const res = await this.call(
      `/files?uploadType=resumable&supportsAllDrives=true&fields=id,name,size,parents`,
      { method: 'POST', headers, body: JSON.stringify({ name, parents: [parentId], mimeType }) },
      UPLOAD,
    );
    if (!res.ok) throw new Error(`Drive upload session ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const url = res.headers.get('Location');
    if (!url) throw new Error('Drive did not return an upload URL.');
    return url;
  }

  async download(id: string): Promise<Response> {
    const res = await this.call(`/files/${encodeURIComponent(id)}?alt=media&supportsAllDrives=true`);
    if (!res.ok) throw new Error(`Drive download ${res.status}`);
    return res;
  }

  async shareWithUser(id: string, email: string, role: 'reader' | 'writer'): Promise<void> {
    await this.json(`/files/${encodeURIComponent(id)}/permissions?sendNotificationEmail=false&supportsAllDrives=true`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'user', role, emailAddress: email }),
    });
  }

  async setTrashed(id: string, trashed: boolean): Promise<void> {
    await this.json(`/files/${encodeURIComponent(id)}?fields=id,trashed&supportsAllDrives=true`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ trashed }),
    });
  }

  async storageQuota() {
    const r = await this.json<{ storageQuota: { usage?: string; limit?: string; usageInDrive?: string; usageInDriveTrash?: string } }>(
      `/about?fields=storageQuota`,
    );
    const q = r.storageQuota ?? {};
    return {
      usage: Number(q.usage ?? 0),
      limit: q.limit != null ? Number(q.limit) : null,
      usageInDrive: Number(q.usageInDrive ?? 0),
      usageInTrash: Number(q.usageInDriveTrash ?? 0),
    };
  }

  folderUrl(id: string) {
    return `https://drive.google.com/drive/folders/${encodeURIComponent(id)}`;
  }
}
