export interface DriveFile {
  id: string;
  name: string;
  parents: string[];
  size?: number;
  trashed?: boolean;
  createdTime?: string;
  mimeType?: string;
}

/**
 * The subset of Google Drive the application uses.
 *
 * There is deliberately NO delete or trash method: hiding/removing photo sets in the
 * app must never delete Drive files, and that guarantee is enforced by construction.
 */
export interface DriveClient {
  readonly mode: 'google' | 'demo';
  getFile(id: string): Promise<DriveFile | null>;
  /** Folders with an exact name inside a parent, oldest first. */
  findFolders(parentId: string, name: string): Promise<DriveFile[]>;
  createFolder(parentId: string, name: string): Promise<DriveFile>;
  rename(id: string, name: string): Promise<void>;
  move(id: string, fromParent: string, toParent: string, newName?: string): Promise<void>;
  /**
   * Start a resumable upload. The returned URL lets the browser PUT the bytes
   * directly to storage without ever seeing a Google credential.
   */
  createUploadSession(parentId: string, name: string, mimeType: string, origin: string | null): Promise<string>;
  download(id: string): Promise<Response>;
  shareWithUser(id: string, email: string, role: 'reader' | 'writer'): Promise<void>;
  folderUrl(id: string): string;
}

export class DriveNotConnectedError extends Error {
  constructor(msg = 'Google Drive is not connected. A Super Admin must connect it in Drive settings.') {
    super(msg);
  }
}
