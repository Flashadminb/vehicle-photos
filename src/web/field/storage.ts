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
  async putImage(img: StoredImage) {
    await (await this.db).put('images', img);
  }
  async getImage(localId: string) {
    return ((await (await this.db).get('images', localId)) as StoredImage | undefined) ?? null;
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
