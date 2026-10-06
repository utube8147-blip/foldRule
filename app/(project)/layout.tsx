// Route-group layout for /workspace, /takeoff-full and /presets.
// Reads ?project=<id>, loads that project from local storage (IndexedDB) and
// autosaves it while you work. The URL segment is unaffected by the (project) group.

import type { Metadata } from 'next';
import { Suspense } from 'react';
import { ProjectSession } from './ProjectSession';
import { RequireAuth } from '@/components/auth/RequireAuth';

export const metadata: Metadata = {
  title:  'Workspace',
  robots: { index: false, follow: false },
};

export default function ProjectLayout({ children }: { children: React.ReactNode }) {
  return (
    <Suspense fallback={<ProjectLoading />}>
      <RequireAuth>
        <ProjectSession>{children}</ProjectSession>
      </RequireAuth>
    </Suspense>
  );
}

function ProjectLoading() {
  return (
    <div className="flex h-screen items-center justify-center bg-industrial-black text-sm text-zinc-400">
      Opening project…
    </div>
  );
}
