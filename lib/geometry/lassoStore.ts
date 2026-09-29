// Tiny external store for the in-progress Magic Fill lasso (CSS/page px).
// The lasso changes on every mouse move; keeping it here means only the
// preview overlay re-renders — not the whole Viewer.

export type LassoPoints = [number, number][] | null;

export function createLassoStore() {
  let value: LassoPoints = null;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set: (next: LassoPoints) => { value = next; listeners.forEach(l => l()); },
    subscribe: (cb: () => void) => { listeners.add(cb); return () => { listeners.delete(cb); }; },
  };
}
export type LassoStore = ReturnType<typeof createLassoStore>;
