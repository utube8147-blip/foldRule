'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { TakeoffProvider, useTakeoffData } from '@/context/TakeoffContext';
import { PresetProvider } from '@/context/PresetContext';

export function ProjectSession({ children }: { children: React.ReactNode }) {
  const projectId = useSearchParams().get('project');

  if (!projectId) {
    return (
      <StatusScreen
        title="No project open"
        body="Open a project from your dashboard, or create a new one."
      />
    );
  }

  return (
    <TakeoffProvider projectId={projectId}>
      <PresetProvider>
        <ProjectGate>{children}</ProjectGate>
      </PresetProvider>
    </TakeoffProvider>
  );
}

function ProjectGate({ children }: { children: React.ReactNode }) {
  const { loadStatus, loadError } = useTakeoffData();

  if (loadStatus === 'loading' || loadStatus === 'idle') {
    return (
      <div className="flex h-screen items-center justify-center bg-industrial-black text-sm text-zinc-400">
        Opening project…
      </div>
    );
  }
  if (loadStatus === 'not-found') {
    return (
      <StatusScreen
        title="Project not found"
        body="It may have been deleted, or it was created in a different browser. Projects are stored on this device."
      />
    );
  }
  if (loadStatus === 'error') {
    return (
      <StatusScreen
        title="Couldn’t open this project"
        body={`Local storage returned an error: ${loadError ?? 'unknown error'}. Private browsing modes can block storage.`}
      />
    );
  }
  return <>{children}</>;
}

function StatusScreen({ title, body }: { title: string; body: string }) {
  return (
    <main className="flex h-screen items-center justify-center bg-industrial-black px-6">
      <div className="max-w-md">
        <h1 className="text-lg font-semibold text-zinc-100">{title}</h1>
        <p className="mt-2 text-sm leading-relaxed text-zinc-400">{body}</p>
        <Link
          href="/dashboard"
          className="mt-6 inline-block border border-amber-400/70 px-4 py-2 text-sm font-semibold text-amber-300 hover:bg-amber-400 hover:text-black focus-visible:outline focus-visible:outline-2 focus-visible:outline-amber-300"
        >
          Go to projects
        </Link>
      </div>
    </main>
  );
}
