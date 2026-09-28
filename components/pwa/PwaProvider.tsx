'use client';

// Registers the service worker (production only — a dev service worker would
// cache stale code) and starts listening for the browser's install offer.

import { useEffect } from 'react';
import { startInstallWatcher } from '@/lib/pwa/install';

export function PwaProvider() {
  useEffect(() => {
    startInstallWatcher();
    if (process.env.NODE_ENV !== 'production' || !('serviceWorker' in navigator)) return;
    const register = () => navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(err => {
      console.warn('[pwa] service worker registration failed', err);
    });
    if (document.readyState === 'complete') register();
    else window.addEventListener('load', register, { once: true });
  }, []);
  return null;
}
