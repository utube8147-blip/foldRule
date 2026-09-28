// Route-group layout for /workspace, /takeoff-full and /presets.
// Reads ?project=<id>, loads that project from local storage (IndexedDB) and
// autosaves it while you work. The URL segment is unaffected by the (project) group.

import { Suspense } from 'react';
import { ProjectSession } from './ProjectSession';

export default function ProjectLayout({ children }: { children: React.ReactNode }) {
  return (
    <Suspense fallback={<ProjectLoading />}>
      <ProjectSession>{children}</ProjectSession>
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
