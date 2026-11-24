import { createRoot } from 'react-dom/client';
import '../shared/theme.css';
import './field.css';
import { App } from './App';

createRoot(document.getElementById('root')!).render(<App />);

// Offline app shell (the upload queue itself lives in IndexedDB, not the service worker).
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => undefined);
  });
}
