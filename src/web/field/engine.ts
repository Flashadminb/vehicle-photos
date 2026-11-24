import type { BeginImageRequest, BeginImageResponse, CompleteImageRequest, CompleteImageResponse, FinalizeResponse, ImageSource, WorkflowVersion } from '../../shared/types';

/**
 * CaptureEngine — the field app's round state machine and durable upload queue.
 *
 * Guarantees:
 *  - Capture never waits for uploads: accept() persists the photo locally, advances to
 *    the next step immediately, and the queue uploads in the background (2 at a time).
 *  - Exactly one active image per step. Retaking invalidates the previous image; any
 *    callback for an invalidated image is ignored (checked by local ID at every await),
 *    and the server independently refuses to let it become active again.
 *  - A local photo is deleted only after the backend acknowledged it in Drive.
 *  - The round (and its photos) survive reloads/offline periods via the store (IndexedDB).
 *  - DONE is possible only when every required step has an image and every active image
 *    is acknowledged; finalization is idempotent, and failure keeps the round intact.
 */

export type SlotStatus = 'empty' | 'queued' | 'uploading' | 'uploaded' | 'failed' | 'skipped';

export interface Slot {
  status: SlotStatus;
  localId?: string;
  error?: string;
  /** Object URL for showing the current round's own photo (never historical sets). */
  previewUrl?: string;
}

export interface StoredImage {
  localId: string;
  clientRoundId: string;
  stepId: string;
  source: ImageSource;
  blob: Blob | null;
  thumb: Blob | null;
  acceptedAt: number;
  captureTime: number | null;
  exifTime: string | null;
  status: 'queued' | 'uploading' | 'uploaded' | 'failed' | 'superseded';
  attempts: number;
  error?: string;
  serverImageId?: string;
}

export interface StoredRound {
  clientRoundId: string;
  workflow: WorkflowVersion;
  createdAt: number;
  finalizeKey: string;
  serverRoundId?: string;
  publicId?: string;
  stepIndex: number;
  slots: Record<string, { localId?: string; skipped?: boolean }>;
}

export interface EngineStore {
  loadRound(): Promise<StoredRound | null>;
  saveRound(round: StoredRound): Promise<void>;
  clearRound(clientRoundId: string): Promise<void>;
  putImage(img: StoredImage): Promise<void>;
  getImage(localId: string): Promise<StoredImage | null>;
  deleteImage(localId: string): Promise<void>;
}

export interface Watermark {
  source: ImageSource;
  captureTime: number | null;
  exifTime: string | null;
  serverReceivedAt: number;
  publicId: string;
  stepLabel: string;
  stepNumber: number;
}

export interface Imaging {
  /** Compress the original at a quality that keeps plates readable. */
  prepare(blob: Blob): Promise<{ original: Blob; width: number; height: number }>;
  /** Watermarked display copy + small thumbnail. */
  render(original: Blob, wm: Watermark): Promise<{ display: Blob; thumb: Blob }>;
}

export interface FieldTransport {
  begin(req: BeginImageRequest, signal?: AbortSignal): Promise<BeginImageResponse>;
  uploadToDrive(url: string, blob: Blob, signal?: AbortSignal): Promise<string>;
  putCache(imageId: string, kind: 'thumb' | 'display', blob: Blob): Promise<void>;
  complete(imageId: string, req: CompleteImageRequest, signal?: AbortSignal): Promise<CompleteImageResponse>;
  finalize(serverRoundId: string, key: string): Promise<FinalizeResponse>;
}

export interface EngineDeps {
  transport: FieldTransport;
  store: EngineStore;
  imaging: Imaging;
  now?: () => number;
  uuid?: () => string;
  isOnline?: () => boolean;
  createObjectURL?: (b: Blob) => string;
  revokeObjectURL?: (u: string) => void;
  /** Retry delays in ms for temporary failures. */
  backoff?: number[];
  concurrency?: number;
  stepLabel: (step: WorkflowVersion['steps'][number]) => string;
}

export interface EngineState {
  workflow: WorkflowVersion;
  clientRoundId: string | null;
  publicId: string | null;
  stepIndex: number;
  slots: Record<string, Slot>;
  finalize: { status: 'idle' | 'pending' | 'failed'; error?: string };
  flash: string | null;
}

type Listener = (s: EngineState) => void;

interface ErrorLike {
  status?: number;
  code?: string;
  message?: string;
  retryable?: boolean;
  name?: string;
}

export class CaptureEngine {
  private state: EngineState;
  private round: StoredRound | null = null;
  private latestWorkflow: WorkflowVersion;
  private listeners = new Set<Listener>();
  private inflight = new Map<string, AbortController>();
  private retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private now: () => number;
  private uuid: () => string;
  private isOnline: () => boolean;
  private createObjectURL: (b: Blob) => string;
  private revokeObjectURL: (u: string) => void;
  private backoff: number[];
  private concurrency: number;
  private flashTimer: ReturnType<typeof setTimeout> | null = null;
  /** Serialises store writes for the round record. */
  private chain: Promise<unknown> = Promise.resolve();
  private disposed = false;

  constructor(
    private deps: EngineDeps,
    workflow: WorkflowVersion,
  ) {
    this.latestWorkflow = workflow;
    this.now = deps.now ?? (() => Date.now());
    this.uuid = deps.uuid ?? (() => crypto.randomUUID());
    this.isOnline = deps.isOnline ?? (() => (typeof navigator === 'undefined' ? true : navigator.onLine));
    this.createObjectURL = deps.createObjectURL ?? ((b) => URL.createObjectURL(b));
    this.revokeObjectURL = deps.revokeObjectURL ?? ((u) => URL.revokeObjectURL(u));
    this.backoff = deps.backoff ?? [2000, 5000, 15000, 30000, 60000];
    this.concurrency = deps.concurrency ?? 2;
    this.state = this.emptyState(workflow);
  }

  // ---------- public API ----------
  getState() {
    return this.state;
  }

  subscribe(fn: Listener) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  get workflow() {
    return this.state.workflow;
  }

  get currentStep() {
    return this.state.workflow.steps[this.state.stepIndex] ?? null;
  }

  get isReview() {
    return this.state.stepIndex >= this.state.workflow.steps.length;
  }

  /** DONE is enabled only if every required step has an image and every active image is acknowledged. */
  canFinish(s: EngineState = this.state): boolean {
    if (!s.clientRoundId || s.finalize.status === 'pending') return false;
    for (const step of s.workflow.steps) {
      const slot = s.slots[step.id];
      if (step.required && slot?.status !== 'uploaded') return false;
      if (!step.required && slot && !['uploaded', 'skipped', 'empty'].includes(slot.status)) return false;
    }
    return true;
  }

  doneBlocker(s: EngineState = this.state): 'missing' | 'uploading' | null {
    const missing = s.workflow.steps.some((st) => st.required && ['empty', 'skipped'].includes(s.slots[st.id]?.status ?? 'empty'));
    if (missing) return 'missing';
    return this.canFinish(s) ? null : 'uploading';
  }

  /** Restore an unfinished round after reload / app restart. */
  async init() {
    const saved = await this.deps.store.loadRound();
    if (!saved) {
      this.emit();
      return;
    }
    this.round = saved;
    const slots: Record<string, Slot> = {};
    for (const step of saved.workflow.steps) {
      const s = saved.slots[step.id];
      if (s?.skipped) slots[step.id] = { status: 'skipped' };
      else if (s?.localId) {
        const img = await this.deps.store.getImage(s.localId);
        if (!img) slots[step.id] = { status: 'empty' };
        else {
          const status: SlotStatus = img.status === 'uploaded' ? 'uploaded' : img.status === 'failed' ? 'failed' : 'queued';
          if (img.status === 'uploading') await this.deps.store.putImage({ ...img, status: 'queued' });
          const preview = img.thumb ?? img.blob;
          slots[step.id] = { status, localId: img.localId, error: img.error, previewUrl: preview ? this.createObjectURL(preview) : undefined };
        }
      } else slots[step.id] = { status: 'empty' };
    }
    this.state = {
      workflow: saved.workflow,
      clientRoundId: saved.clientRoundId,
      publicId: saved.publicId ?? null,
      stepIndex: Math.min(saved.stepIndex, saved.workflow.steps.length),
      slots,
      finalize: { status: 'idle' },
      flash: null,
    };
    this.emit();
    this.pump();
  }

  /** Newer config from the server. Applies to the NEXT round only. */
  setLatestWorkflow(wf: WorkflowVersion) {
    this.latestWorkflow = wf;
    if (!this.round) {
      this.state = { ...this.emptyState(wf), flash: this.state.flash };
      this.emit();
    }
  }

  /** Accept a photo for a step. Returns immediately after it is persisted locally. */
  async accept(stepId: string, blob: Blob, source: ImageSource, meta: { captureTime?: number | null; exifTime?: string | null } = {}) {
    if (this.state.finalize.status === 'pending') return;
    const wf = this.round?.workflow ?? this.latestWorkflow;
    const step = wf.steps.find((s) => s.id === stepId);
    if (!step) throw new Error('Unknown step');
    if (source === 'upload' && !step.allowUpload) throw new Error('upload_not_allowed');

    if (!this.round) {
      // The internal round ID is created when the first image is accepted.
      this.round = {
        clientRoundId: this.uuid(),
        workflow: wf,
        createdAt: this.now(),
        finalizeKey: this.uuid(),
        stepIndex: 0,
        slots: {},
      };
      this.state = { ...this.emptyState(wf), clientRoundId: this.round.clientRoundId };
    }

    const localId = this.uuid();
    const img: StoredImage = {
      localId,
      clientRoundId: this.round.clientRoundId,
      stepId,
      source,
      blob,
      thumb: null,
      acceptedAt: this.now(),
      captureTime: source === 'camera' ? (meta.captureTime ?? this.now()) : null,
      exifTime: meta.exifTime ?? null,
      status: 'queued',
      attempts: 0,
    };
    await this.deps.store.putImage(img);

    // Invalidate the previous image of this step (if any).
    const prev = this.state.slots[stepId];
    if (prev?.localId) await this.invalidate(prev.localId);
    if (prev?.previewUrl) this.revokeObjectURL(prev.previewUrl);

    this.round.slots[stepId] = { localId };
    const slots = { ...this.state.slots, [stepId]: { status: 'queued' as SlotStatus, localId, previewUrl: this.createObjectURL(blob) } };
    const stepIndex = this.nextStepIndex(wf, slots, wf.steps.findIndex((s) => s.id === stepId));
    this.round.stepIndex = stepIndex;
    this.state = { ...this.state, slots, stepIndex, finalize: { status: 'idle' } };
    await this.persistRound();
    this.emit();
    this.pump();
  }

  /** Optional steps only. Required steps can never be skipped. */
  async skip(stepId: string) {
    const wf = this.round?.workflow ?? this.latestWorkflow;
    const idx = wf.steps.findIndex((s) => s.id === stepId);
    const step = wf.steps[idx];
    if (!step || step.required) return;
    const prev = this.state.slots[stepId];
    if (prev?.localId) await this.invalidate(prev.localId);
    if (prev?.previewUrl) this.revokeObjectURL(prev.previewUrl);
    const slots = { ...this.state.slots, [stepId]: { status: 'skipped' as SlotStatus } };
    const stepIndex = this.nextStepIndex(wf, slots, idx);
    if (this.round) {
      this.round.slots[stepId] = { skipped: true };
      this.round.stepIndex = stepIndex;
      await this.persistRound();
    }
    this.state = { ...this.state, slots, stepIndex };
    this.emit();
  }

  /** Jump to any step (e.g. to retake) or to the review screen. */
  goTo(stepIndex: number) {
    const max = this.state.workflow.steps.length;
    const idx = Math.max(0, Math.min(max, stepIndex));
    this.state = { ...this.state, stepIndex: idx };
    if (this.round) {
      this.round.stepIndex = idx;
      void this.persistRound();
    }
    this.emit();
  }

  /** Retry a failed upload now (also used by the retry button). */
  retry(stepId: string) {
    const slot = this.state.slots[stepId];
    if (!slot?.localId || slot.status !== 'failed') return;
    const t = this.retryTimers.get(slot.localId);
    if (t) clearTimeout(t);
    this.retryTimers.delete(slot.localId);
    this.setSlot(stepId, slot.localId, { status: 'queued', error: undefined });
    void this.updateImage(slot.localId, { status: 'queued', error: undefined }).then(() => this.pump());
  }

  /** Called on 'online' events. */
  resume() {
    for (const [stepId, slot] of Object.entries(this.state.slots)) {
      if (slot.status === 'failed' && slot.localId) this.retry(stepId);
    }
    this.pump();
  }

  async finalize() {
    if (!this.canFinish() || !this.round) return;
    const round = this.round;
    if (!round.serverRoundId) return;
    this.state = { ...this.state, finalize: { status: 'pending' } };
    this.emit();
    try {
      await this.deps.transport.finalize(round.serverRoundId, round.finalizeKey);
    } catch (e) {
      // Keep the round exactly as it is; the operator can retry.
      this.state = { ...this.state, finalize: { status: 'failed', error: (e as ErrorLike)?.message ?? 'error' } };
      this.emit();
      return;
    }
    // Success: only now reset to the first step of a fresh round.
    for (const slot of Object.values(this.state.slots)) if (slot.previewUrl) this.revokeObjectURL(slot.previewUrl);
    const ids = Object.values(round.slots).map((s) => s.localId).filter(Boolean) as string[];
    this.round = null;
    await this.enqueueStore(() => this.deps.store.clearRound(round.clientRoundId));
    for (const id of ids) await this.deps.store.deleteImage(id);
    this.state = { ...this.emptyState(this.latestWorkflow), flash: 'set_saved' };
    this.emit();
    if (this.flashTimer) clearTimeout(this.flashTimer);
    this.flashTimer = setTimeout(() => {
      this.state = { ...this.state, flash: null };
      this.emit();
    }, 3500);
  }

  dispose() {
    this.disposed = true;
    for (const c of this.inflight.values()) c.abort();
    for (const t of this.retryTimers.values()) clearTimeout(t);
    if (this.flashTimer) clearTimeout(this.flashTimer);
  }

  // ---------- internals ----------
  private emptyState(wf: WorkflowVersion): EngineState {
    const slots: Record<string, Slot> = {};
    for (const s of wf.steps) slots[s.id] = { status: 'empty' };
    return { workflow: wf, clientRoundId: null, publicId: null, stepIndex: 0, slots, finalize: { status: 'idle' }, flash: null };
  }

  private emit() {
    for (const l of this.listeners) l(this.state);
  }

  private nextStepIndex(wf: WorkflowVersion, slots: Record<string, Slot>, from: number) {
    const open = (i: number) => {
      const st = slots[wf.steps[i].id]?.status ?? 'empty';
      return st === 'empty';
    };
    for (let i = from + 1; i < wf.steps.length; i++) if (open(i)) return i;
    for (let i = 0; i < wf.steps.length; i++) if (open(i) && wf.steps[i].required) return i;
    return wf.steps.length; // review / DONE screen
  }

  private isActive(localId: string) {
    return Object.values(this.state.slots).some((s) => s.localId === localId);
  }

  private stepOf(localId: string) {
    return Object.entries(this.state.slots).find(([, s]) => s.localId === localId)?.[0];
  }

  private setSlot(stepId: string, localId: string, patch: Partial<Slot>) {
    const cur = this.state.slots[stepId];
    if (!cur || cur.localId !== localId) return; // stale callback: ignore
    this.state = { ...this.state, slots: { ...this.state.slots, [stepId]: { ...cur, ...patch } } };
    this.emit();
  }

  private async invalidate(localId: string) {
    this.inflight.get(localId)?.abort();
    this.inflight.delete(localId);
    const t = this.retryTimers.get(localId);
    if (t) clearTimeout(t);
    this.retryTimers.delete(localId);
    // The replaced photo was intentionally discarded by the operator; if it already
    // reached the server, the server keeps it as "superseded" and moves it to _replaced.
    await this.deps.store.deleteImage(localId);
  }

  private enqueueStore<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.chain.then(fn, fn);
    this.chain = p.catch(() => undefined);
    return p;
  }

  private persistRound() {
    const r = this.round;
    if (!r) return Promise.resolve();
    const snapshot = structuredClone(r);
    return this.enqueueStore(() => this.deps.store.saveRound(snapshot));
  }

  private async updateImage(localId: string, patch: Partial<StoredImage>) {
    const img = await this.deps.store.getImage(localId);
    if (img) await this.deps.store.putImage({ ...img, ...patch });
  }

  private pump() {
    if (this.disposed) return;
    if (!this.isOnline()) return;
    const queued = Object.entries(this.state.slots).filter(([, s]) => s.status === 'queued' && s.localId && !this.inflight.has(s.localId));
    for (const [stepId, slot] of queued) {
      if (this.inflight.size >= this.concurrency) break;
      void this.upload(stepId, slot.localId!);
    }
  }

  private async upload(stepId: string, localId: string) {
    const ctrl = new AbortController();
    this.inflight.set(localId, ctrl);
    const round = this.round!;
    const wf = round.workflow;
    const step = wf.steps.find((s) => s.id === stepId)!;
    const stillActive = () => !ctrl.signal.aborted && this.isActive(localId);
    this.setSlot(stepId, localId, { status: 'uploading', error: undefined });
    try {
      const img = await this.deps.store.getImage(localId);
      if (!stillActive()) return;
      if (!img?.blob) {
        if (img?.status === 'uploaded') this.setSlot(stepId, localId, { status: 'uploaded' });
        else this.setSlot(stepId, localId, { status: 'failed', error: 'The photo is no longer on this device. Retake it.' });
        return;
      }
      await this.deps.store.putImage({ ...img, status: 'uploading' });

      const prepared = await this.deps.imaging.prepare(img.blob);
      if (!stillActive()) return;

      const begin = await this.deps.transport.begin(
        {
          clientRoundId: round.clientRoundId,
          clientImageId: localId,
          workflowVersionId: wf.id,
          stepId,
          source: img.source,
          acceptedAtDevice: img.acceptedAt,
          captureTimeDevice: img.captureTime,
          exifTime: img.exifTime,
          width: prepared.width,
          height: prepared.height,
        },
        ctrl.signal,
      );
      if (!round.serverRoundId) {
        round.serverRoundId = begin.round.id;
        round.publicId = begin.round.publicId;
        await this.persistRound();
        this.state = { ...this.state, publicId: begin.round.publicId };
        this.emit();
      }
      if (!begin.image.active) {
        // The server already knows this image was replaced.
        await this.deps.store.deleteImage(localId);
        return;
      }
      if (!stillActive()) return;

      if (begin.image.status !== 'uploaded' && begin.uploads) {
        const rendered = await this.deps.imaging.render(prepared.original, {
          source: img.source,
          captureTime: img.captureTime,
          exifTime: img.exifTime,
          serverReceivedAt: begin.serverReceivedAt,
          publicId: begin.round.publicId,
          stepLabel: begin.stepLabel || this.deps.stepLabel(step),
          stepNumber: wf.steps.indexOf(step) + 1,
        });
        if (!stillActive()) return;
        const displayFileId = await this.deps.transport.uploadToDrive(begin.uploads.display.url, rendered.display, ctrl.signal);
        let originalFileId: string | null = null;
        if (begin.uploads.original) {
          originalFileId = await this.deps.transport.uploadToDrive(begin.uploads.original.url, prepared.original, ctrl.signal);
        }
        // Recent-view cache copies are best effort; Drive is the system of record.
        await Promise.allSettled([
          this.deps.transport.putCache(begin.image.id, 'thumb', rendered.thumb),
          this.deps.transport.putCache(begin.image.id, 'display', rendered.display),
        ]);
        const done = await this.deps.transport.complete(
          begin.image.id,
          { displayFileId, originalFileId, displayBytes: rendered.display.size, originalBytes: prepared.original.size },
          ctrl.signal,
        );
        if (!done.active || !this.isActive(localId)) return;
        // Acknowledged: now (and only now) the full-size local copy can go.
        await this.deps.store.putImage({ ...img, blob: null, thumb: rendered.thumb, status: 'uploaded', serverImageId: begin.image.id, error: undefined });
      } else {
        await this.deps.store.putImage({ ...img, blob: null, status: 'uploaded', serverImageId: begin.image.id });
      }
      this.setSlot(stepId, localId, { status: 'uploaded', error: undefined });
    } catch (e) {
      const err = e as ErrorLike;
      if (err?.name === 'AbortError' || !this.isActive(localId)) return;
      const img = await this.deps.store.getImage(localId);
      const attempts = (img?.attempts ?? 0) + 1;
      const message = err?.message ?? 'Upload failed';
      if (img) await this.deps.store.putImage({ ...img, status: 'failed', attempts, error: message });
      this.setSlot(stepId, localId, { status: 'failed', error: message });
      const retryable = err?.retryable ?? (err?.status == null || err.status === 0 || err.status >= 500 || err.status === 429 || err.status === 422);
      if (retryable) {
        const delay = this.backoff[Math.min(attempts - 1, this.backoff.length - 1)];
        this.retryTimers.set(
          localId,
          setTimeout(() => {
            this.retryTimers.delete(localId);
            if (this.isOnline()) this.retry(stepId);
          }, delay),
        );
      }
    } finally {
      if (this.inflight.get(localId) === ctrl) this.inflight.delete(localId);
      this.pump();
    }
  }
}
