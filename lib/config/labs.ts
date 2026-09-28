/**
 * Lab / test-bench routes (app/(test)/*) and experimental API routes are
 * available in development automatically. In a production build they return
 * 404 unless you explicitly opt in with NEXT_PUBLIC_ENABLE_LABS=true.
 */
export const LABS_ENABLED =
  process.env.NODE_ENV !== 'production' ||
  process.env.NEXT_PUBLIC_ENABLE_LABS === 'true';
