'use client';

// Captures the browser's install offer (Edge/Chrome fire `beforeinstallprompt`
// when the app is installable) so an "Install app" button can use it later.
// Nothing is shown automatically.

interface InstallState {
  /** The browser has offered installation and it hasn't been used yet. */
  canInstall: boolean;
  /** Running as the installed app (its own window). */
  installed:  boolean;
}

let deferred: BeforeInstallPromptEvent | null = null;
let state: InstallState = { canInstall: false, installed: false };
const listeners = new Set<() => void>();
const emit = (patch: Partial<InstallState>) => { state = { ...state, ...patch }; listeners.forEach(l => l()); };

let started = false;
export function startInstallWatcher(): void {
  if (started || typeof window === 'undefined') return;
  started = true;
  const standalone = () =>
    window.matchMedia?.('(display-mode: standalone)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true;
  emit({ installed: standalone() });

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();          // keep the browser's own mini-bar from popping up
    deferred = e;
    emit({ canInstall: true });
  });
  window.addEventListener('appinstalled', () => {
    deferred = null;
    emit({ canInstall: false, installed: true });
  });
  window.matchMedia?.('(display-mode: standalone)').addEventListener?.('change', () => emit({ installed: standalone() }));
}

export const subscribeInstall = (cb: () => void) => { listeners.add(cb); return () => { listeners.delete(cb); }; };
export const getInstallState = () => state;
const serverState: InstallState = { canInstall: false, installed: false };
export const getServerInstallState = () => serverState;

/** Show the browser's install dialog. Returns true if the user accepted. */
export async function promptInstall(): Promise<boolean> {
  if (!deferred) return false;
  const e = deferred;
  deferred = null;
  emit({ canInstall: false });
  await e.prompt();
  const { outcome } = await e.userChoice;
  return outcome === 'accepted';
}
