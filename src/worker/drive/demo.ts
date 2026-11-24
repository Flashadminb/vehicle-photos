import type { Env } from '../env';
import type { DriveClient, DriveFile } from './types';

/**
 * DEMO MODE ONLY. Emulates the Drive subset used by the app with D1 + R2 so the
 * whole capture → upload → finalize → history flow can be run locally and in tests
 * without Google credentials. Enabled only when DRIVE_MODE=demo; both apps show a
 * visible "DEMO MODE" banner while it is active. Not a production storage backend.
 */
export const DEMO_ROOT_ID = 'demo-root';

export class DemoDrive implements DriveClient {
  readonly mode = 'demo' as const;
  /** Every call is recorded so tests can assert that no destructive call ever happens. */
  readonly calls: { op: string; args: unknown[] }[] = [];

  constructor(
    private env: Env,
    private baseUrl: string,
  ) {}

  private log(op: string, ...args: unknown[]) {
    this.calls.push({ op, args });
  }

  async ensureRoot() {
    await this.env.DB.prepare(
      `INSERT OR IGNORE INTO demo_drive_files (id, name, parent_id, mime_type, created_at) VALUES (?, 'Vehicle Photos (demo)', NULL, 'folder', ?)`,
    )
      .bind(DEMO_ROOT_ID, Date.now())
      .run();
  }

  private toFile(r: any): DriveFile {
    return {
      id: r.id,
      name: r.name,
      parents: r.parent_id ? [r.parent_id] : [],
      size: r.size ?? undefined,
      trashed: !!r.trashed,
      createdTime: new Date(r.created_at).toISOString(),
      mimeType: r.mime_type,
    };
  }

  async getFile(id: string) {
    this.log('getFile', id);
    if (id === DEMO_ROOT_ID) await this.ensureRoot();
    const r = await this.env.DB.prepare(`SELECT * FROM demo_drive_files WHERE id = ?`).bind(id).first();
    return r ? this.toFile(r) : null;
  }

  async findFolders(parentId: string, name: string) {
    this.log('findFolders', parentId, name);
    const { results } = await this.env.DB.prepare(
      `SELECT * FROM demo_drive_files WHERE parent_id = ? AND name = ? AND mime_type = 'folder' AND trashed = 0 ORDER BY created_at, id`,
    )
      .bind(parentId, name)
      .all();
    return results.map((r) => this.toFile(r));
  }

  async createFolder(parentId: string, name: string) {
    this.log('createFolder', parentId, name);
    const id = `demo-${crypto.randomUUID()}`;
    await this.env.DB.prepare(
      `INSERT INTO demo_drive_files (id, name, parent_id, mime_type, created_at) VALUES (?, ?, ?, 'folder', ?)`,
    )
      .bind(id, name, parentId, Date.now())
      .run();
    return (await this.getFile(id))!;
  }

  async rename(id: string, name: string) {
    this.log('rename', id, name);
    const r = await this.env.DB.prepare(`UPDATE demo_drive_files SET name = ? WHERE id = ?`).bind(name, id).run();
    if (!r.meta.changes) throw new Error(`Drive file ${id} not found`);
  }

  async move(id: string, fromParent: string, toParent: string, newName?: string) {
    this.log('move', id, fromParent, toParent, newName);
    await this.env.DB.prepare(
      `UPDATE demo_drive_files SET parent_id = ?, name = COALESCE(?, name) WHERE id = ? AND parent_id = ?`,
    )
      .bind(toParent, newName ?? null, id, fromParent)
      .run();
  }

  async createUploadSession(parentId: string, name: string, mimeType: string, origin: string | null) {
    this.log('createUploadSession', parentId, name);
    const id = crypto.randomUUID();
    await this.env.DB.prepare(
      `INSERT INTO demo_drive_sessions (id, parent_id, name, mime_type, created_at) VALUES (?, ?, ?, ?, ?)`,
    )
      .bind(id, parentId, name, mimeType, Date.now())
      .run();
    return `${origin || this.baseUrl}/api/demo-drive/upload/${id}`;
  }

  /** Handles the browser PUT to a demo upload URL. */
  static async receiveUpload(env: Env, sessionId: string, body: ArrayBuffer) {
    const s = await env.DB.prepare(`SELECT * FROM demo_drive_sessions WHERE id = ?`).bind(sessionId).first<any>();
    if (!s) return null;
    if (s.file_id) return { id: s.file_id as string, name: s.name as string, size: body.byteLength };
    const fileId = `demo-${crypto.randomUUID()}`;
    await env.CACHE!.put(`demo-drive/${fileId}`, body, { httpMetadata: { contentType: s.mime_type } });
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO demo_drive_files (id, name, parent_id, mime_type, size, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      ).bind(fileId, s.name, s.parent_id, s.mime_type, body.byteLength, Date.now()),
      env.DB.prepare(`UPDATE demo_drive_sessions SET file_id = ? WHERE id = ?`).bind(fileId, sessionId),
    ]);
    return { id: fileId, name: s.name as string, size: body.byteLength };
  }

  async download(id: string) {
    this.log('download', id);
    const obj = await this.env.CACHE!.get(`demo-drive/${id}`);
    if (!obj) throw new Error('Drive download 404');
    return new Response(obj.body, { headers: { 'Content-Type': obj.httpMetadata?.contentType ?? 'image/jpeg' } });
  }

  async shareWithUser(id: string, email: string, role: 'reader' | 'writer') {
    this.log('shareWithUser', id, email, role);
  }

  folderUrl(id: string) {
    return `/api/admin/demo-drive/folders/${encodeURIComponent(id)}`;
  }
}
