import type { Metadata } from 'next';
import { Suspense } from 'react';
import { RequireAuth } from '@/components/auth/RequireAuth';

export const metadata: Metadata = { title: 'Opening file', robots: { index: false, follow: false } };

export default function OpenLayout({ children }: { children: React.ReactNode }) {
  return <Suspense fallback={null}><RequireAuth>{children}</RequireAuth></Suspense>;
}
