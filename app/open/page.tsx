'use client';

// Target of the installed app's file handler: double-clicking a .foldrule
// backup or choosing "Open with Foldrule" on a PDF in File Explorer lands here.
// Visiting /open directly just goes to the dashboard.

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Logo } from '@/components/brand/Logo';
import { projectHref } from '@/lib/nav/projectHref';
import { importProjectBackup, createProjectFromPdfs } from '@/lib/storage/projectDb';
import { initFolderSync, pushProjectToFolder } from '@/lib/storage/folderSync';

export default function OpenFilePage() {
  const router = useRouter();
  const [message, setMessage] = useState('Opening file…');
  const [error,   setError]   = useState<string | null>(null);

  useEffect(() => {
    if (!window.launchQueue) { router.replace('/dashboard'); return; }
    let handled = false;

    window.launchQueue.setConsumer(async ({ files }) => {
      if (!files?.length) return;
      handled = true;
      try {
        const opened = await Promise.all(files.map(h => h.getFile()));
        const backups = opened.filter(f => /\.(foldrule|qsproj|json)$/i.test(f.name));
        const pdfs    = opened.filter(f => /\.pdf$/i.test(f.name) || f.type === 'application/pdf');

        let projectId: string | null = null;
        if (backups.length) {
          setMessage(`Importing ${backups[0].name}…`);
          for (const b of backups) projectId = (await importProjectBackup(b)).id;
        }
        if (pdfs.length) {
          setMessage(`Creating a project from ${pdfs[0].name}${pdfs.length > 1 ? ` and ${pdfs.length - 1} more` : ''}…`);
          projectId = (await createProjectFromPdfs(pdfs)).id;
        }
        if (!projectId) throw new Error('Foldrule can open PDF drawings and .foldrule backups.');

        await initFolderSync();
        void pushProjectToFolder(projectId);
        router.replace(projectHref('/workspace', projectId));
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    });

    // Opened without a file (e.g. typed the URL): continue to the dashboard.
    const t = setTimeout(() => { if (!handled) router.replace('/dashboard'); }, 1500);
    return () => clearTimeout(t);
  }, [router]);

  return (
    <main className="min-h-screen bg-industrial-black flex flex-col items-center justify-center gap-6 font-mono text-zinc-300 px-6">
      <Logo size={24} />
      {error ? (
        <div role="alert" className="max-w-md text-center space-y-4">
          <p className="text-sm text-red-300">{error}</p>
          <Link href="/dashboard" className="inline-block border border-amber-accent text-amber-accent hover:bg-amber-accent/10 px-4 py-2 text-[11px] font-bold uppercase tracking-widest">
            Go to projects
          </Link>
        </div>
      ) : (
        <p role="status" className="text-xs uppercase tracking-widest text-zinc-500">{message}</p>
      )}
    </main>
  );
}
