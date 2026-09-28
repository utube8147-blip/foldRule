// Test-bench routes: /magicFill, /PdfCVMatchPage, /Snap
// Build and try features here, then wire them into the production workspace.
// Hidden (404) in production builds unless NEXT_PUBLIC_ENABLE_LABS=true.

import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

export const metadata: Metadata = { robots: { index: false, follow: false } };
import { LABS_ENABLED } from '@/lib/config/labs';

export default function LabsLayout({ children }: { children: React.ReactNode }) {
  if (!LABS_ENABLED) notFound();
  return (
    <>
      <div className="fixed bottom-2 right-2 z-[9999] pointer-events-none select-none rounded bg-fuchsia-600/90 px-2 py-0.5 text-[10px] font-semibold text-white">
        Lab build — not production
      </div>
      {children}
    </>
  );
}
