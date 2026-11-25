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
  async uploadToDrive(url, blob, signal, onProgress) {
    // XMLHttpRequest (not fetch) so upload progress can be shown on the phone.
    const { status, text } = await new Promise<{ status: number; text: string }>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', url);
      xhr.setRequestHeader('Content-Type', 'image/jpeg');
      if (onProgress) xhr.upload.onprogress = (e) => onProgress(e.loaded);
      xhr.onload = () => resolve({ status: xhr.status, text: xhr.responseText });
      xhr.onerror = () => reject(new ApiError(0, 'network', 'เครือข่ายขัดข้องระหว่างอัปโหลดขึ้น Drive'));
      xhr.onabort = () => reject(new DOMException('Aborted', 'AbortError'));
      if (signal) {
        if (signal.aborted) return reject(new DOMException('Aborted', 'AbortError'));
        signal.addEventListener('abort', () => xhr.abort(), { once: true });
      }
      xhr.send(blob);
    });
    if (status < 200 || status >= 300) {
      // 404/410: session expired → retryable (the next attempt starts a fresh session).
      throw new ApiError(status >= 400 && status < 500 ? 503 : status || 0, 'drive_upload', `อัปโหลดขึ้น Drive ไม่สำเร็จ (${status}) ระบบจะลองใหม่`);
    }
    let body: { id?: string } = {};
    try {
      body = JSON.parse(text);
    } catch {
      /* handled below */
    }
    if (!body.id) throw new ApiError(502, 'drive_upload', 'Drive did not return a file ID.');
    onProgress?.(blob.size);
    return body.id;
  },
};
