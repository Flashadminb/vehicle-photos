import { describe, expect, it, beforeEach } from 'vitest';
import { CaptureEngine, type EngineStore, type FieldTransport, type StoredImage, type StoredRound } from '../../src/web/field/engine';
import type { WorkflowVersion } from '../../src/shared/types';

const wf = (id = 1): WorkflowVersion => ({
  id,
  createdAt: 0,
  steps: [
    { id: 'bar', required: true, allowUpload: true, ocr: false, labels: { en: 'Vehicle bar' } },
    { id: 'rear', required: true, allowUpload: true, ocr: false, labels: { en: 'Rear' } },
    { id: 'extra', required: false, allowUpload: false, ocr: false, labels: { en: 'Extra' } },
    { id: 'plate', required: true, allowUpload: true, ocr: true, labels: { en: 'Plate' } },
  ],
});

function deferred<T>() {
  let resolve!: (v: T) => void, reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
}

const tick = () => new Promise((r) => setTimeout(r, 0));
async function settle(n = 10) {
  for (let i = 0; i < n; i++) await tick();
}

class MemStore implements EngineStore {
  round: StoredRound | null = null;
  images = new Map<string, StoredImage>();
  async loadRound() { return this.round ? structuredClone(this.round) : null; }
  async saveRound(r: StoredRound) { this.round = structuredClone(r); }
  async clearRound() { this.round = null; }
  async putImage(i: StoredImage) { this.images.set(i.localId, { ...i }); }
  async getImage(id: string) { const i = this.images.get(id); return i ? { ...i } : null; }
  async deleteImage(id: string) { this.images.delete(id); }
}

/** Simulates the server's rules + lets each Drive upload be resolved manually. */
class FakeServer implements FieldTransport {
  uploads: { url: string; d: ReturnType<typeof deferred<string>> }[] = [];
  active = new Map<string, string>(); // stepId -> serverImageId
  images = new Map<string, { stepId: string; uploaded: boolean }>();
  byClient = new Map<string, string>();
  finalizeCalls = 0;
  failFinalize = false;
  failBegin = 0;
  n = 0;
  async begin(req: any) {
    if (this.failBegin > 0) {
      this.failBegin--;
      throw Object.assign(new Error('Network error'), { status: 0, retryable: true });
    }
    let id = this.byClient.get(req.clientImageId);
    if (!id) {
      id = `img${++this.n}`;
      this.byClient.set(req.clientImageId, id);
      this.images.set(id, { stepId: req.stepId, uploaded: false });
      this.active.set(req.stepId, id);
    }
    const isActive = this.active.get(req.stepId) === id;
    return {
      round: { id: 'srv-round', publicId: 'PF-000001', startedAt: 0 },
      image: { id, version: 1, fileName: 'x.jpg', status: this.images.get(id)!.uploaded ? 'uploaded' : 'pending', active: isActive },
      serverReceivedAt: 1,
      uploads: isActive ? { display: { url: `display:${id}`, name: 'x' }, original: { url: `original:${id}`, name: 'y' } } : undefined,
      stepLabel: 'x',
    } as any;
  }
  released: string[] = [];
  uploadToDrive(url: string) {
    const d = deferred<string>();
    this.uploads.push({ url, d });
    if (this.released.some((m) => url.includes(m))) d.resolve(`drive-${url}`);
    return d.promise;
  }
  async putCache() {}
  async complete(imageId: string) {
    const img = this.images.get(imageId)!;
    img.uploaded = true;
    const active = this.active.get(img.stepId) === imageId;
    return { imageId, active, status: active ? 'uploaded' : 'superseded', uploadedAt: 1 } as any;
  }
  async finalize() {
    this.finalizeCalls++;
    if (this.failFinalize) throw Object.assign(new Error('Server unavailable'), { status: 503 });
    return { ok: true, publicId: 'PF-000001', alreadyFinalized: false } as const;
  }
  /** Resolve every pending Drive upload whose URL contains `match`. */
  finish(match: string) {
    this.released.push(match);
    for (const u of this.uploads.filter((u) => u.url.includes(match))) u.d.resolve(`drive-${u.url}`);
  }
}

let server: FakeServer;
let store: MemStore;
let engine: CaptureEngine;
let ids = 0;

function makeEngine(workflow = wf()) {
  return new CaptureEngine(
    {
      transport: server,
      store,
      imaging: {
        prepare: async (b) => ({ original: b, width: 10, height: 10 }),
        render: async (b) => ({ display: b, thumb: b }),
      },
      uuid: () => `id-${++ids}-xxxxxxxx`,
      isOnline: () => true,
      createObjectURL: () => 'blob:x',
      revokeObjectURL: () => {},
      backoff: [5, 5, 5],
      stepLabel: (s) => s.labels.en,
    },
    workflow,
  );
}

const photo = () => new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' });

beforeEach(() => {
  server = new FakeServer();
  store = new MemStore();
  engine = makeEngine();
});

describe('CaptureEngine', () => {
  it('starts on step 1 with no round until the first image is accepted', async () => {
    await engine.init();
    expect(engine.getState().stepIndex).toBe(0);
    expect(engine.getState().clientRoundId).toBeNull();
    await engine.accept('bar', photo(), 'camera');
    expect(engine.getState().clientRoundId).toBeTruthy();
  });

  it('lets the operator capture step 2 while step 1 is still uploading', async () => {
    await engine.accept('bar', photo(), 'camera');
    await settle();
    expect(engine.getState().slots.bar.status).toBe('uploading');
    // Immediately on the next step — no confirmation screen, no waiting.
    expect(engine.currentStep?.id).toBe('rear');
    await engine.accept('rear', photo(), 'camera');
    await settle();
    expect(engine.getState().slots.bar.status).toBe('uploading');
    expect(engine.getState().slots.rear.status).toBe('uploading');
    expect(engine.currentStep?.id).toBe('extra');
  });

  it('DONE stays disabled until every active image is acknowledged', async () => {
    await engine.accept('bar', photo(), 'camera');
    await engine.accept('rear', photo(), 'camera');
    await engine.skip('extra');
    await engine.accept('plate', photo(), 'camera');
    await settle();
    expect(engine.isReview).toBe(true);
    expect(engine.canFinish()).toBe(false);
    expect(engine.doneBlocker()).toBe('uploading');
    server.finish('img1');
    server.finish('img2');
    await settle();
    expect(engine.canFinish()).toBe(false); // plate still uploading
    server.finish('img');
    await settle();
    expect(engine.canFinish()).toBe(true);
  });

  it('required steps cannot be skipped; optional ones can', async () => {
    await engine.accept('bar', photo(), 'camera');
    await engine.skip('rear');
    expect(engine.getState().slots.rear.status).toBe('empty');
    await engine.skip('extra');
    expect(engine.getState().slots.extra.status).toBe('skipped');
  });

  it('reports missing required photos before uploads', async () => {
    await engine.accept('bar', photo(), 'camera');
    engine.goTo(4);
    expect(engine.doneBlocker()).toBe('missing');
  });

  it('retake: a late completion of the old image never overwrites the replacement', async () => {
    await engine.accept('bar', photo(), 'camera');
    await settle();
    const oldLocal = engine.getState().slots.bar.localId;
    engine.goTo(0);
    await engine.accept('bar', photo(), 'camera'); // retake while v1 still uploading
    await settle();
    const newLocal = engine.getState().slots.bar.localId;
    expect(newLocal).not.toBe(oldLocal);
    // Old upload finishes late — must be ignored.
    server.finish('img1');
    await settle();
    expect(engine.getState().slots.bar.localId).toBe(newLocal);
    expect(engine.getState().slots.bar.status).toBe('uploading');
    expect(store.images.has(oldLocal!)).toBe(false);
    server.finish('img2');
    await settle();
    expect(engine.getState().slots.bar.status).toBe('uploaded');
    expect(server.active.get('bar')).toBe('img2');
  });

  it('keeps the local photo until the backend acknowledges it', async () => {
    await engine.accept('bar', photo(), 'camera');
    await settle();
    const id = engine.getState().slots.bar.localId!;
    expect(store.images.get(id)!.blob).not.toBeNull();
    server.finish('img1');
    await settle();
    expect(store.images.get(id)!.blob).toBeNull();
    expect(store.images.get(id)!.status).toBe('uploaded');
  });

  it('retries failed uploads automatically', async () => {
    server.failBegin = 1;
    await engine.accept('bar', photo(), 'camera');
    await settle();
    expect(['failed', 'queued', 'uploading']).toContain(engine.getState().slots.bar.status);
    await new Promise((r) => setTimeout(r, 30));
    await settle();
    expect(engine.getState().slots.bar.status).toBe('uploading');
    server.finish('img1');
    await settle();
    expect(engine.getState().slots.bar.status).toBe('uploaded');
  });

  async function completeRound() {
    await engine.accept('bar', photo(), 'camera');
    await engine.accept('rear', photo(), 'camera');
    await engine.skip('extra');
    await engine.accept('plate', photo(), 'camera');
    await settle();
    server.finish('img');
    await settle();
    expect(engine.canFinish()).toBe(true);
  }

  it('failed finalization preserves the round and allows retry', async () => {
    await completeRound();
    const before = engine.getState();
    server.failFinalize = true;
    await engine.finalize();
    const s = engine.getState();
    expect(s.finalize.status).toBe('failed');
    expect(s.clientRoundId).toBe(before.clientRoundId);
    expect(s.slots.bar.status).toBe('uploaded');
    expect(store.round).not.toBeNull();
    // Retry succeeds, with the same idempotency key.
    server.failFinalize = false;
    await engine.finalize();
    expect(server.finalizeCalls).toBe(2);
    expect(engine.getState().clientRoundId).toBeNull();
  });

  it('successful DONE returns directly to the first step with a confirmation flash', async () => {
    await completeRound();
    await engine.finalize();
    const s = engine.getState();
    expect(s.stepIndex).toBe(0);
    expect(s.clientRoundId).toBeNull();
    expect(Object.values(s.slots).every((x) => x.status === 'empty')).toBe(true);
    expect(s.flash).toBe('set_saved');
    expect(store.round).toBeNull();
    expect(store.images.size).toBe(0);
  });

  it('prevents duplicate submissions while finalizing', async () => {
    await completeRound();
    const p1 = engine.finalize();
    const p2 = engine.finalize();
    await Promise.all([p1, p2]);
    expect(server.finalizeCalls).toBe(1);
  });

  it('a workflow change during a round does not alter that round', async () => {
    await engine.accept('bar', photo(), 'camera');
    engine.setLatestWorkflow({ id: 2, createdAt: 0, steps: [{ id: 'only', required: true, allowUpload: true, ocr: false, labels: { en: 'Only' } }] });
    expect(engine.getState().workflow.id).toBe(1);
    expect(engine.currentStep?.id).toBe('rear');
    await engine.accept('rear', photo(), 'camera');
    await engine.skip('extra');
    await engine.accept('plate', photo(), 'camera');
    await settle();
    server.finish('img');
    await settle();
    await engine.finalize();
    // The next round uses the new workflow.
    expect(engine.getState().workflow.id).toBe(2);
    expect(engine.currentStep?.id).toBe('only');
  });

  it('restores an unfinished round after a reload and resumes uploading', async () => {
    await engine.accept('bar', photo(), 'camera');
    await engine.accept('rear', photo(), 'camera');
    await settle();
    server.finish('img1');
    await settle();
    engine.dispose();
    // "Reload": a new engine over the same durable store.
    server.uploads = [];
    const e2 = makeEngine();
    await e2.init();
    await settle();
    expect(e2.getState().slots.bar.status).toBe('uploaded');
    expect(['queued', 'uploading']).toContain(e2.getState().slots.rear.status);
    expect(e2.currentStep?.id).toBe('extra');
    server.finish('img2');
    await settle();
    expect(e2.getState().slots.rear.status).toBe('uploaded');
  });

  it('refuses file uploads for steps that disallow them', async () => {
    await expect(engine.accept('extra', photo(), 'upload')).rejects.toThrow('upload_not_allowed');
  });
});
