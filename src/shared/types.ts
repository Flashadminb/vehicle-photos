export type Role = 'super_admin' | 'admin' | 'reviewer' | 'operator';
export const ROLES: Role[] = ['super_admin', 'admin', 'reviewer', 'operator'];
export const FIELD_ROLES: Role[] = ['super_admin', 'admin', 'operator'];
export const ADMIN_ROLES: Role[] = ['super_admin', 'admin', 'reviewer'];

export type ImageSource = 'camera' | 'upload';

export interface WorkflowStep {
  /** Stable ID; survives renames and reorders. */
  id: string;
  required: boolean;
  allowUpload: boolean;
  /** Run plate recognition on this step's image. */
  ocr: boolean;
  /** Label per language code. */
  labels: Record<string, string>;
}

export interface WorkflowVersion {
  id: number;
  steps: WorkflowStep[];
  note?: string | null;
  createdAt: number;
}

export interface Language {
  code: string;
  name: string;
  enabled: boolean;
  sort: number;
}

export type ImageDisplayMode = 'window' | 'cache';
export type OcrProvider = 'none' | 'google_vision' | 'aiforthai';

export interface AppSettings {
  unknownPlateLabel: string;
  defaultLanguage: string;
  fallbackLanguage: string;
  /** 'window': images only for sets inside the recent window. 'cache': also while still in the R2 cache. */
  imageDisplayMode: ImageDisplayMode;
  /** Number of operational days whose images may be shown. 1 = today only. */
  recentImageDays: number;
  cacheQuotaBytes: number;
  cacheThresholdPct: number;
  cacheTargetPct: number;
  dbQuotaBytes: number;
  dbThresholdPct: number;
  keepOriginals: boolean;
  ocrProvider: OcrProvider;
  ocrBlocksDone: boolean;
  pinLockEnabled: boolean;
  pinLockMinutes: number;
  abandonAfterHours: number;
  exportMaxSets: number;
  driveRootFolderId: string;
}

export const DEFAULT_SETTINGS: AppSettings = {
  unknownPlateLabel: 'ไม่ระบุ',
  defaultLanguage: 'th',
  fallbackLanguage: 'en',
  imageDisplayMode: 'window',
  recentImageDays: 1,
  cacheQuotaBytes: 10 * 1024 * 1024 * 1024,
  cacheThresholdPct: 70,
  cacheTargetPct: 60,
  dbQuotaBytes: 500 * 1024 * 1024,
  dbThresholdPct: 70,
  keepOriginals: true,
  ocrProvider: 'none',
  ocrBlocksDone: false,
  pinLockEnabled: false,
  pinLockMinutes: 5,
  abandonAfterHours: 48,
  exportMaxSets: 100,
  driveRootFolderId: '',
};

export interface FieldBootstrap {
  user: { id: string; username: string; displayName: string; role: Role; language: string | null; hasPin: boolean };
  workflow: WorkflowVersion;
  languages: Language[];
  translations: Record<string, Record<string, string>>;
  settings: Pick<AppSettings, 'unknownPlateLabel' | 'defaultLanguage' | 'fallbackLanguage' | 'pinLockEnabled' | 'pinLockMinutes' | 'ocrBlocksDone'>;
  driveMode: 'google' | 'demo';
  /** False when R2 is not configured: the phone then skips uploading cache copies. */
  cacheEnabled: boolean;
  serverTime: number;
}

export interface BeginImageRequest {
  clientRoundId: string;
  clientImageId: string;
  workflowVersionId: number;
  stepId: string;
  source: ImageSource;
  acceptedAtDevice: number;
  captureTimeDevice?: number | null;
  exifTime?: string | null;
  width?: number;
  height?: number;
}

export interface UploadTarget {
  url: string;
  name: string;
}

export interface BeginImageResponse {
  round: { id: string; publicId: string; startedAt: number };
  image: { id: string; version: number; fileName: string; status: 'pending' | 'uploaded' | 'superseded'; active: boolean };
  serverReceivedAt: number;
  /** Absent when the image is already uploaded (idempotent replay). */
  uploads?: { display: UploadTarget; original?: UploadTarget };
  stepLabel: string;
}

export interface CompleteImageRequest {
  displayFileId: string;
  originalFileId?: string | null;
  displayBytes?: number;
  originalBytes?: number;
}

export interface CompleteImageResponse {
  imageId: string;
  active: boolean;
  status: 'uploaded' | 'superseded';
  uploadedAt: number;
}

export interface FinalizeResponse {
  ok: true;
  publicId: string;
  alreadyFinalized: boolean;
}

export interface ApiErrorBody {
  error: { code: string; message: string; details?: unknown };
}

export interface SetRow {
  id: string;
  publicId: string;
  startedAt: number;
  opDate: string;
  plate: string | null;
  plateDisplay: string;
  plateSource: 'none' | 'ocr' | 'manual';
  operator: { id: string; name: string };
  activeCount: number;
  requiredCount: number;
  uploadedCount: number;
  status: 'open' | 'finalized' | 'abandoned';
  folderStatus: string;
  driveUrl: string | null;
  hidden: boolean;
  removed: boolean;
  imagesAllowed: boolean;
}

export interface SetListResponse {
  rows: SetRow[];
  total: number;
  pageSize: number;
  nextCursor: string | null;
  prevCursor: string | null;
}
