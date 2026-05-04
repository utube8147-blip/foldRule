// FILE: src/context/TakeoffContext.tsx
// NEW FILE — Creates the shared context that replaces direct useTakeoff() calls.
// Both Workspace and TakeoffFullPage consume this so they share one state instance.

'use client';

import React, { createContext, useContext, ReactNode } from 'react';
import { useTakeoff } from '@/hooks/useTakeoff';

// Automatically infer the full return type of useTakeoff —
// no need to manually redeclare every field.
type TakeoffContextValue = ReturnType<typeof useTakeoff>;

const TakeoffContext = createContext<TakeoffContextValue | null>(null);

// ─── Provider ────────────────────────────────────────────────────────────────
// useTakeoff() is called ONCE here. Every consumer reads the same instance.
// Place this in the shared layout so it wraps both /workspace and /takeoff-full.
export function TakeoffProvider({ children }: { children: ReactNode }) {
  const takeoff = useTakeoff();
  return (
    <TakeoffContext.Provider value={takeoff}>
      {children}
    </TakeoffContext.Provider>
  );
}

// ─── Consumer hook ───────────────────────────────────────────────────────────
// Drop-in replacement for useTakeoff() in any component inside the provider.
// Throws early if accidentally used outside the provider tree.
export function useTakeoffContext(): TakeoffContextValue {
  const ctx = useContext(TakeoffContext);
  if (!ctx) {
    throw new Error('useTakeoffContext must be used inside <TakeoffProvider>');
  }
  return ctx;
}