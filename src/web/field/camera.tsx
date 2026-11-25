import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * In-app camera: a live viewfinder inside the field app, so taking a photo is a single tap
 * (no camera app to open, no "use this photo" confirmation). Falls back to the phone's own
 * camera app (file input) when the browser cannot provide a camera stream or permission is
 * denied. The stream runs only while a capture step is on screen and the app is visible.
 */
export type CameraStatus = 'off' | 'starting' | 'live' | 'denied' | 'unsupported' | 'error';

export function useCamera(active: boolean, maxEdge = 1920) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [status, setStatus] = useState<CameraStatus>('off');
  const [torch, setTorch] = useState({ supported: false, on: false });
  const [visible, setVisible] = useState(() => (typeof document === 'undefined' ? true : document.visibilityState === 'visible'));

  useEffect(() => {
    const onVis = () => setVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  const stop = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setTorch({ supported: false, on: false });
  }, []);

  useEffect(() => {
    if (!active || !visible) {
      stop();
      setStatus((s) => (s === 'denied' || s === 'unsupported' ? s : 'off'));
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      setStatus('unsupported');
      return;
    }
    let cancelled = false;
    setStatus('starting');
    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          // Enough for plates and slips framed in the guide; smaller frames upload much faster.
          video: { facingMode: { ideal: 'environment' }, width: { ideal: maxEdge }, height: { ideal: Math.round((maxEdge * 9) / 16) } },
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        const video = videoRef.current;
        if (video) {
          video.srcObject = stream;
          await video.play().catch(() => undefined);
        }
        const track = stream.getVideoTracks()[0];
        const caps = (track?.getCapabilities?.() ?? {}) as MediaTrackCapabilities & { torch?: boolean };
        setTorch({ supported: !!caps.torch, on: false });
        setStatus('live');
      } catch (e) {
        if (cancelled) return;
        const name = (e as Error).name;
        setStatus(name === 'NotAllowedError' || name === 'SecurityError' ? 'denied' : name === 'NotFoundError' ? 'unsupported' : 'error');
      }
    })();
    return () => {
      cancelled = true;
      stop();
    };
  }, [active, visible, stop, maxEdge]);

  /** Grab the current frame as a JPEG. Fast: no shutter delay, no extra camera app. */
  const capture = useCallback(async (): Promise<Blob> => {
    const video = videoRef.current;
    if (!video || !video.videoWidth) throw new Error('camera_not_ready');
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d')!.drawImage(video, 0, 0);
    return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('encode_failed'))), 'image/jpeg', 0.92));
  }, []);

  const toggleTorch = useCallback(async () => {
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track) return;
    const on = !torch.on;
    try {
      await track.applyConstraints({ advanced: [{ torch: on } as MediaTrackConstraintSet] });
      setTorch((t) => ({ ...t, on }));
    } catch {
      setTorch({ supported: false, on: false });
    }
  }, [torch.on]);

  return { videoRef, status, capture, torch, toggleTorch };
}

export function Viewfinder({
  camera,
  guide,
  t,
  flashKey,
}: {
  camera: ReturnType<typeof useCamera>;
  guide: 'plate' | 'slip' | 'slip_line' | null;
  t: (k: string) => string;
  flashKey: number;
}) {
  const { status } = camera;
  if (status === 'denied' || status === 'unsupported' || status === 'error') {
    return <div className="fa-vf fa-vf-off small">{status === 'denied' ? t('camera_denied') : t('camera_unavailable')}</div>;
  }
  return (
    <div className="fa-vf">
      <video ref={camera.videoRef} playsInline muted autoPlay aria-label={t('take_photo')} />
      {status !== 'live' && <div className="fa-vf-msg small">{t('camera_starting')}</div>}
      {guide && status === 'live' && (
        <div className={`fa-vf-guide ${guide === 'slip' ? 'is-doc' : guide === 'slip_line' ? 'is-line' : ''}`} aria-hidden>
          <span>{t(guide === 'slip' ? 'doc_guide' : guide === 'slip_line' ? 'slip_line_guide' : 'plate_guide')}</span>
        </div>
      )}
      {camera.torch.supported && (
        <button type="button" className={`btn btn-sm fa-vf-torch ${camera.torch.on ? 'is-on' : ''}`} onClick={() => void camera.toggleTorch()} aria-pressed={camera.torch.on}>
          🔦 {t('torch')}
        </button>
      )}
      {flashKey > 0 && <div key={flashKey} className="fa-vf-flash" aria-hidden />}
    </div>
  );
}

/** Keep the screen on while a set is in progress (otherwise phones pause uploads when the screen sleeps). */
export function useWakeLock(enabled: boolean) {
  useEffect(() => {
    if (!enabled || !('wakeLock' in navigator)) return;
    let lock: WakeLockSentinel | null = null;
    let cancelled = false;
    const acquire = async () => {
      try {
        if (document.visibilityState === 'visible' && !cancelled) lock = await navigator.wakeLock.request('screen');
      } catch {
        /* not allowed (e.g. low battery mode) */
      }
    };
    const onVis = () => {
      if (document.visibilityState === 'visible') void acquire();
    };
    void acquire();
    document.addEventListener('visibilitychange', onVis);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVis);
      void lock?.release().catch(() => undefined);
    };
  }, [enabled]);
}

export function vibrate(pattern: number | number[]) {
  try {
    navigator.vibrate?.(pattern);
  } catch {
    /* unsupported (iOS) */
  }
}
