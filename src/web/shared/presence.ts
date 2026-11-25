import { useEffect } from 'react';
import { api } from './api';

/** Light "I'm here" ping while the page is visible, so admins can see who is online right now.
 *  The server writes last-seen at most every 5 minutes, so this costs ~1 D1 write per device per ~6 min. */
export const PRESENCE_PING_MS = 3 * 60_000;

export function usePresence(url: string | null) {
  useEffect(() => {
    if (!url) return;
    const ping = () => {
      if (document.visibilityState === 'visible' && navigator.onLine !== false) void api('GET', url).catch(() => undefined);
    };
    const t = setInterval(ping, PRESENCE_PING_MS);
    document.addEventListener('visibilitychange', ping);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', ping);
    };
  }, [url]);
}
