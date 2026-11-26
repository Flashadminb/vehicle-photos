import { openDB, type IDBPDatabase } from 'idb';
import type { EngineStore, StoredImage, StoredRound } from './engine';

/**
 * Durable local queue in IndexedDB. Photos stay here until the backend confirms they
 * are in Drive, so a dropped connection, a reload or the browser being killed does not
 * lose them. The unfinished round is stored per operator.
 */
export class IdbStore implements EngineStore {
  private db: Promise<IDBPDatabase>;

  constructor(private userId: string) {
    this.db = openDB('vehicle-photos', 1, {
      upgrade(db) {
        db.createObjectStore('rounds');
        db.createObjectStore('images', { keyPath: 'localId' });
      },
    });
  }

  async loadRound() {
    return ((await (await this.db).get('rounds', this.userId)) as StoredRound | undefined) ?? null;
  }
  async saveRound(round: StoredRound) {
    await (await this.db).put('rounds', round, this.userId);
  }
  async clearRound() {
    await (await this.db).delete('rounds', this.userId);
  }
  /**
   * Photos are stored as raw bytes, not Blob objects: iPhone Safari can lose the data behind a
   * Blob kept in IndexedDB ("Loading error."), while plain bytes read back reliably.
   */
  async putImage(img: StoredImage) {
    const toBytes = async (b: Blob | null) => {
      if (!b) return null;
      try {
        return { bytes: await b.arrayBuffer(), type: b.type || 'image/jpeg' };
      } catch {
        return null; // an older stored copy that Safari can no longer read
      }
    };
    const { blob, thumb, ...rest } = img;
    await (await this.db).put('images', { ...rest, blob: null, thumb: null, blobBytes: await toBytes(blob), thumbBytes: await toBytes(thumb) });
  }
  async getImage(localId: string) {
    const r = (await (await this.db).get('images', localId)) as any;
    if (!r) return null;
    const fromBytes = (x: { bytes: ArrayBuffer; type: string } | null | undefined, legacy: Blob | null) => (x ? new Blob([x.bytes], { type: x.type }) : legacy ?? null);
    const { blobBytes, thumbBytes, ...rest } = r;
    return { ...rest, blob: fromBytes(blobBytes, r.blob), thumb: fromBytes(thumbBytes, r.thumb) } as StoredImage;
  }
  async deleteImage(localId: string) {
    await (await this.db).delete('images', localId);
  }
}

/** Ask the browser not to evict our storage under pressure (best effort). */
export async function requestPersistentStorage() {
  try {
    if (navigator.storage?.persist && !(await navigator.storage.persisted())) await navigator.storage.persist();
  } catch {
    /* not supported */
  }
}
