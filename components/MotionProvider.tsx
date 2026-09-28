'use client';

// Loads only the animation features the app uses (enter/exit/hover/tap) via
// LazyMotion, instead of the full `motion` bundle. Components import the
// lightweight `m` elements as `motion` from 'motion/react-m'.
// `strict` makes any accidental full `motion.*` import throw in development.

import { LazyMotion, domAnimation } from 'motion/react';

export function MotionProvider({ children }: { children: React.ReactNode }) {
  return (
    <LazyMotion features={domAnimation} strict>
      {children}
    </LazyMotion>
  );
}
