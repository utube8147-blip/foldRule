'use client';

// Registers the service worker in production builds and starts listening for
// the browser's install offer.
//
// In development it does the opposite: it removes any service worker left over
// from a production run on the same address (e.g. localhost:3000) and clears
// its caches, so `npm run dev` always serves fresh code. Saved projects live in
// IndexedDB and are NOT touched.

import { useEffect } from 'react';
import { startInstallWatcher } from '@/lib/pwa/install';

const BUILD_ID = process.env.NEXT_PUBLIC_BUILD_ID ?? 'dev';

async function removeStaleServiceWorkers(): Promise<boolean> {
  const regs = await navigator.serviceWorker.getRegistrations();
  await Promise.all(regs.map(r => r.unregister()));
  if ('caches' in window) {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k.startsWith('foldrule-')).map(k => caches.delete(k)));
  }
  return regs.length > 0;
}

export function PwaProvider() {
  useEffect(() => {
    startInstallWatcher();
    if (!('serviceWorker' in navigator)) return;

    if (process.env.NODE_ENV !== 'production') {
      void removeStaleServiceWorkers().then(removed => {
        // If an old worker was serving this page, reload once to get fresh code.
        if (removed && navigator.serviceWorker.controller && !sessionStorage.getItem('foldrule:sw-cleared')) {
          sessionStorage.setItem('foldrule:sw-cleared', '1');
          window.location.reload();
        }
      });
      return;
    }

    // A new build id changes the worker's URL, so every deploy installs a fresh
    // worker that drops the previous build's caches.
    const register = () => navigator.serviceWorker
      .register(`/sw.js?v=${encodeURIComponent(BUILD_ID)}`, { scope: '/' })
      .catch(err => console.warn('[pwa] service worker registration failed', err));
    if (document.readyState === 'complete') register();
    else window.addEventListener('load', register, { once: true });
  }, []);
  return null;
}
