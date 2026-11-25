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
  /**
   * Zoom: the camera's own (optical/sensor) zoom when the phone exposes it (most Android
   * Chrome), otherwise a digital zoom: the preview is scaled and the shot is cropped to match.
   */
  const [zoom, setZoomState] = useState({ value: 1, min: 1, max: 4, step: 0.1, hardware: false });
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
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
        const caps = (track?.getCapabilities?.() ?? {}) as MediaTrackCapabilities & { torch?: boolean; zoom?: { min: number; max: number; step?: number } };
        setTorch({ supported: !!caps.torch, on: false });
        if (caps.zoom && caps.zoom.max > caps.zoom.min) {
          const max = Math.min(caps.zoom.max, 10);
          setZoomState({ value: caps.zoom.min, min: caps.zoom.min, max, step: caps.zoom.step || 0.1, hardware: true });
        } else {
          setZoomState({ value: 1, min: 1, max: 4, step: 0.1, hardware: false });
        }
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
    const z = zoomRef.current;
    const digital = z.hardware ? 1 : Math.max(1, z.value);
    // Digital zoom: keep the centre of the frame (what the scaled preview shows).
    const sw = Math.round(video.videoWidth / digital), sh = Math.round(video.videoHeight / digital);
    canvas.width = sw;
    canvas.height = sh;
    canvas.getContext('2d')!.drawImage(video, (video.videoWidth - sw) / 2, (video.videoHeight - sh) / 2, sw, sh, 0, 0, sw, sh);
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

  const setZoom = useCallback(async (v: number) => {
    const z = zoomRef.current;
    const value = Math.min(z.max, Math.max(z.min, Math.round(v / z.step) * z.step));
    setZoomState((s) => ({ ...s, value }));
    if (z.hardware) {
      const track = streamRef.current?.getVideoTracks()[0];
      try {
        await track?.applyConstraints({ advanced: [{ zoom: value } as MediaTrackConstraintSet] });
      } catch {
        /* the camera refused this value: the slider still shows it, the next change retries */
      }
    }
  }, []);

  return { videoRef, status, capture, torch, toggleTorch, zoom, setZoom };
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
      <video
        ref={camera.videoRef}
        playsInline
        muted
        autoPlay
        aria-label={t('take_photo')}
        style={!camera.zoom.hardware && camera.zoom.value > 1 ? { transform: `scale(${camera.zoom.value})` } : undefined}
      />
      {status === 'live' && <PinchZoom camera={camera} />}
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
      {status === 'live' && <ZoomControls camera={camera} t={t} />}
      {flashKey > 0 && <div key={flashKey} className="fa-vf-flash" aria-hidden />}
    </div>
  );
}

/** Zoom presets (1×, 2×, 3×) plus a slider for fine control. */
function ZoomControls({ camera, t }: { camera: ReturnType<typeof useCamera>; t: (k: string) => string }) {
  const { zoom, setZoom } = camera;
  const presets = [1, 2, 3, 5].filter((p) => p >= zoom.min && p <= zoom.max);
  const label = `${zoom.value.toFixed(zoom.value < 10 ? 1 : 0).replace(/\.0$/, '')}×`;
  return (
    <div className="fa-vf-zoom">
      <div className="fa-vf-zoom-presets" role="group" aria-label={t('zoom')}>
        {presets.map((p) => (
          <button
            key={p}
            type="button"
            className={`fa-vf-zoom-btn ${Math.abs(zoom.value - p) < 0.05 ? 'is-on' : ''}`}
            onClick={() => void setZoom(p)}
          >
            {p}×
          </button>
        ))}
      </div>
      <input
        className="fa-vf-zoom-slider"
        type="range"
        min={zoom.min}
        max={zoom.max}
        step={zoom.step}
        value={zoom.value}
        onChange={(e) => void setZoom(Number(e.target.value))}
        aria-label={`${t('zoom')} ${label}`}
      />
      <span className="fa-vf-zoom-value" aria-hidden>{label}</span>
    </div>
  );
}

/** Two-finger pinch on the viewfinder changes the zoom. */
function PinchZoom({ camera }: { camera: ReturnType<typeof useCamera> }) {
  const start = useRef<{ dist: number; zoom: number } | null>(null);
  const dist = (e: React.TouchEvent) => Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
  return (
    <div
      className="fa-vf-pinch"
      onTouchStart={(e) => {
        if (e.touches.length === 2) start.current = { dist: dist(e), zoom: camera.zoom.value };
      }}
      onTouchMove={(e) => {
        if (e.touches.length === 2 && start.current) void camera.setZoom(start.current.zoom * (dist(e) / start.current.dist));
      }}
      onTouchEnd={() => (start.current = null)}
    />
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
