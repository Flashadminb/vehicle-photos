/**
 * Decode the dispatch-slip barcode on the phone itself (Chrome on Android has a built-in
 * BarcodeDetector). Free, offline and exact; on phones without it (e.g. iPhone) this returns
 * null and the bar number is read from the photo text on the server / office computer instead.
 */
const BAR = /^[A-Z]{3}[0-9][A-Z0-9]{5,7}$/;

type Detector = { detect(src: ImageBitmapSource): Promise<{ rawValue: string; format: string }[]> };

let detector: Detector | null | undefined;
async function getDetector(): Promise<Detector | null> {
  if (detector !== undefined) return detector;
  try {
    const BD = (globalThis as any).BarcodeDetector;
    if (!BD) return (detector = null);
    const formats: string[] = await BD.getSupportedFormats();
    const wanted = ['code_128', 'code_39', 'code_93', 'codabar', 'itf'].filter((f) => formats.includes(f));
    detector = wanted.length ? new BD({ formats: wanted }) : null;
  } catch {
    detector = null;
  }
  return detector ?? null;
}

export async function decodeSlipBarcode(blob: Blob, timeoutMs = 800): Promise<string | null> {
  const d = await getDetector();
  if (!d) return null;
  const work = (async () => {
    const bmp = await createImageBitmap(blob);
    try {
      const codes = await d.detect(bmp);
      const hit = codes.map((c) => (c.rawValue || '').trim().toUpperCase()).find((v) => BAR.test(v));
      return hit ?? null;
    } finally {
      bmp.close();
    }
  })().catch(() => null);
  return Promise.race([work, new Promise<null>((r) => setTimeout(() => r(null), timeoutMs))]);
}
