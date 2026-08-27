'use client';

import { useEffect } from 'react';

/**
 * Registers the service worker, and keeps it honest.
 *
 * Two deliberate choices here. It registers only in production, because a
 * worker left running against a dev server serves yesterday's build and costs
 * an hour of confusion. And when a new worker is waiting, it is told to take
 * over immediately rather than lingering until every tab is closed — a stale
 * worker outliving a deploy is the classic way a fixed bug appears unfixed.
 *
 * Nothing here blocks rendering or gates any feature: if registration fails,
 * or the browser has no service worker at all, the site behaves exactly as it
 * always has.
 */
export function PwaRegister() {
  useEffect(() => {
    if (process.env.NODE_ENV !== 'production') return;
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;

    const register = async () => {
      try {
        const registration = await navigator.serviceWorker.register('/sw.js', { scope: '/' });

        if (registration.waiting) registration.waiting.postMessage('skip-waiting');

        registration.addEventListener('updatefound', () => {
          const installing = registration.installing;
          if (!installing) return;
          installing.addEventListener('statechange', () => {
            if (installing.state === 'installed' && navigator.serviceWorker.controller) {
              installing.postMessage('skip-waiting');
            }
          });
        });
      } catch {
        // A failed registration is not a failure of the application.
      }
    };

    void register();
  }, []);

  return null;
}
