import { api, ApiError } from '../shared/api';
import type { FieldTransport } from './engine';

export const httpTransport: FieldTransport = {
  begin: (req, signal) => api('POST', '/api/field/images/begin', req, { signal }),
  complete: (id, req, signal) => api('POST', `/api/field/images/${encodeURIComponent(id)}/complete`, req, { signal }),
  finalize: (roundId, key) => api('POST', `/api/field/rounds/${encodeURIComponent(roundId)}/finalize`, { idempotencyKey: key }),
  async putCache(imageId, kind, blob) {
    await api('PUT', `/api/field/images/${encodeURIComponent(imageId)}/cache/${kind}`, blob, { headers: { 'Content-Type': 'image/jpeg' } });
  },
  /**
   * PUT the bytes straight to the resumable upload URL created by the backend. The URL
   * carries no Google credential; the browser never sees an OAuth token.
   */
  async uploadToDrive(url, blob, signal) {
    let res: Response;
    try {
      res = await fetch(url, { method: 'PUT', body: blob, headers: { 'Content-Type': 'image/jpeg' }, signal });
    } catch (e) {
      if ((e as Error).name === 'AbortError') throw e;
      throw new ApiError(0, 'network', 'Network error while uploading to Drive.');
    }
    if (!res.ok) {
      // 404/410: session expired → retryable (the next attempt starts a fresh session).
      throw new ApiError(res.status >= 400 && res.status < 500 ? 503 : res.status, 'drive_upload', `Drive upload failed (${res.status}).`);
    }
    const body = (await res.json()) as { id?: string };
    if (!body.id) throw new ApiError(502, 'drive_upload', 'Drive did not return a file ID.');
    return body.id;
  },
};
