'use client';

// Gate for the app screens (dashboard, workspace, …). Signed-out visitors are
// sent to /login and brought back afterwards. In local mode (accounts not
// configured) everything is open.
//
// Note: projects are stored on the user's own computer, so this gate is about
// who may use the tool on this deployment, not about protecting data on a
// server. Anything that must be enforced (paid plans, cloud sync) has to be
// checked server-side when those features are added.

import { useEffect } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useAuth } from '@/context/AuthContext';

/**
 * Where to go when the user logs out on purpose (instead of "log in to see
 * this page"). Set just before calling signOut().
 */
let afterSignOut: string | null = null;
export function goAfterSignOut(path: string): void { afterSignOut = path; }

export function RequireAuth({ children }: { children: React.ReactNode }) {
  const { status } = useAuth();
  const router   = useRouter();
  const pathname = usePathname();
  const search   = useSearchParams();

  useEffect(() => {
    if (status !== 'signed-out') return;
    if (afterSignOut) { const to = afterSignOut; afterSignOut = null; router.replace(to); return; }
    const here = pathname + (search.size ? `?${search.toString()}` : '');
    router.replace(`/login?next=${encodeURIComponent(here)}`);
  }, [status, pathname, search, router]);

  if (status === 'signed-in' || status === 'local') return <>{children}</>;
  return (
    <div className="flex h-screen items-center justify-center bg-industrial-black text-sm text-zinc-500" role="status">
      {status === 'loading' ? 'Checking your account…' : 'Taking you to log in…'}
    </div>
  );
}
