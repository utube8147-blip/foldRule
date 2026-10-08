'use client';

// ─── Dashboard: local projects ───────────────────────────────────────────────
//  Projects live in this browser (IndexedDB) — see lib/storage/projectDb.ts.
//  Backups (.foldrule files; older .qsproj files still import) move a project between browsers/devices.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  FolderOpen, Plus, Search, Upload, Download, Copy, Trash2, Pencil, ArrowDownUp, BoxSelect, FileText, UserRound,
} from 'lucide-react';
import * as motion from 'motion/react-m';
import { useAuth } from '@/context/AuthContext';
import { useStorageMode, useFolderStatus } from '@/components/pwa/hooks';
import { connectFolder, resumeFolder } from '@/lib/storage/folderSync';
import { initFolderSync, syncFolder, removeProjectFromFolder } from '@/lib/storage/folderSync';
import { useConfirm } from '@/components/common/ConfirmDialog';
import { InstallAppButton, StorageButton, FolderPermissionStrip, StorageDialog, StorageModeBanner } from '@/components/pwa/FolderControls';
import Link from 'next/link';
import { cn } from '@/lib/utils';
import { Logo } from '@/components/brand/Logo';
import { projectHref } from '@/lib/nav/projectHref';
import {
  listProjects, createProject, deleteProject, renameProject, duplicateProject,
  exportProjectBackup, importProjectBackup, downloadBlob, isStorageAvailable,
  type ProjectSummary,
} from '@/lib/storage/projectDb';

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

function formatWhen(ts: number): string {
  const diff = Date.now() - ts;
  const min = Math.round(diff / 60_000);
  if (min < 1)  return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 24)   return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d < 7)    return `${d} d ago`;
  return new Date(ts).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function formatBytes(n: number): string {
  if (n < 1024 ** 2) return `${Math.round(n / 1024)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}

export default function Dashboard() {
  const router = useRouter();
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [error,    setError]    = useState<string | null>(null);
  const [query,    setQuery]    = useState('');
  const [sortBy,   setSortBy]   = useState<'recent' | 'name'>('recent');
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [busyId,   setBusyId]   = useState<string | null>(null);
  const [usage,    setUsage]    = useState<{ used: number; quota: number } | null>(null);
  const { user, status: authStatus } = useAuth();
  const storageMode = useStorageMode();
  const [showStorage, setShowStorage] = useState(false);
  const { confirm } = useConfirm();
  const importRef = useRef<HTMLInputElement>(null);


  const refresh = useCallback(async () => {
    try {
      // Pull in / push out folder copies first (no-op without folder access).
      await initFolderSync();
      await syncFolder();
      setProjects(await listProjects());
      setError(null);
      // Storage usage is only a nicety for the header. The browser can fail to
      // work it out (it does when its own storage is broken, e.g. a full disk) —
      // that must never hide the project list or show as an error.
      try {
        const est = await navigator.storage?.estimate?.();
        if (est?.usage != null && est.quota) setUsage({ used: est.usage, quota: est.quota });
        else setUsage(null);
      } catch {
        setUsage(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setProjects([]);
    }
  }, []);

  useEffect(() => {
    if (!isStorageAvailable()) {
      setError('This browser does not allow local storage, so projects can’t be saved. Private browsing modes often block it.');
      setProjects([]);
      return;
    }
    void refresh();
  }, [refresh]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!projects) return [];
    const list = q
      ? projects.filter(p => p.name.toLowerCase().includes(q) || p.number.toLowerCase().includes(q))
      : [...projects];
    if (sortBy === 'name') list.sort((a, b) => a.name.localeCompare(b.name));
    else list.sort((a, b) => b.updatedAt - a.updatedAt);
    return list;
  }, [projects, query, sortBy]);

  const open = (id: string) => router.push(projectHref('/workspace', id));

  const handleCreate = async (name: string, number: string) => {
    try {
      const rec = await createProject(name, number);
      open(rec.id);
    } catch (err) {
      setError(`Couldn’t create the project: ${err instanceof Error ? err.message : err}`);
    }
  };

  const run = async (id: string, fn: () => Promise<unknown>, failMsg: string) => {
    setBusyId(id);
    try { await fn(); await refresh(); }
    catch (err) { setError(`${failMsg}: ${err instanceof Error ? err.message : err}`); }
    finally { setBusyId(null); }
  };

  const handleDelete = async (p: ProjectSummary) => {
    const ok = await confirm({
      title: 'Delete project',
      message: <>Delete <span className="text-zinc-100 font-bold">{p.name}</span>?</>,
      detail: `Its drawings and ${p.measurementCount} measurement${p.measurementCount === 1 ? '' : 's'} will be removed from this browser (and from your projects folder, if you use one). This can’t be undone — download a backup first if you might need it.`,
      confirmText: 'Delete project',
    });
    if (ok) void run(p.id, async () => { await deleteProject(p.id); await removeProjectFromFolder(p.id); }, 'Couldn’t delete the project');
  };

  const handleBackup = (p: ProjectSummary) =>
    run(p.id, async () => {
      const { blob, filename } = await exportProjectBackup(p.id);
      downloadBlob(blob, filename);
    }, 'Couldn’t create the backup');

  const handleImport = async (file: File | undefined) => {
    if (!file) return;
    try {
      const rec = await importProjectBackup(file);
      await refresh();
      setQuery('');
      setError(null);
      setBusyId(rec.id);
      setTimeout(() => setBusyId(null), 1200);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (importRef.current) importRef.current.value = '';
    }
  };

  const WEEK = 7 * 24 * 60 * 60 * 1000;

  return (
    <div className="min-h-screen bg-industrial-black flex flex-col font-mono text-zinc-200">
      <header className="h-16 border-b border-industrial-border bg-industrial-panel px-6 flex items-center justify-between sticky top-0 z-50">
        <div className="flex items-center gap-6 h-full">
          <Link
            href="/"
            aria-label="Foldrule home"
            className="flex items-center gap-3 border-r border-industrial-border pr-6 focus-visible:outline focus-visible:outline-2 focus-visible:outline-amber-300"
          >
            <Logo size={24} />
          </Link>

          <span className="text-sm font-semibold text-zinc-300">My projects</span>
        </div>

        <div className="flex items-center gap-4">
          <InstallAppButton />
          <div className="relative">
            <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500" aria-hidden />
            <input
              type="search"
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Search projects..."
              aria-label="Search projects"
              className="bg-stone-900 border border-industrial-border pl-9 pr-4 py-1.5 text-xs focus:border-amber-accent outline-none w-48 transition-all focus:w-64"
            />
          </div>

          <div className="w-px h-6 bg-industrial-border mx-2" />

          {user ? (
            <Link href="/account" title="Your account" className="flex items-center gap-3 group/profile">
              <span className="text-right flex flex-col">
                <span className="text-xs font-bold text-zinc-300 leading-tight group-hover/profile:text-white">{user.name}</span>
                <span className="text-[11px] text-zinc-500">{user.firm || user.email}</span>
              </span>
              <span className="w-8 h-8 bg-zinc-800 border border-industrial-border flex items-center justify-center text-xs font-bold text-amber-accent group-hover/profile:border-amber-accent/60" aria-hidden>
                {initials(user.name)}
              </span>
            </Link>
          ) : authStatus === 'local' ? (
            <span className="flex items-center gap-2 text-xs font-semibold text-zinc-500" title="Accounts are not configured on this deployment — projects are simply saved on this computer.">
              <UserRound className="w-4 h-4" aria-hidden />
              Local mode
            </span>
          ) : null}
        </div>
      </header>

      <StorageModeBanner onAfterConnect={() => void refresh()} />
      <FolderPermissionStrip onAfterResume={() => void refresh()} />

      <main className="flex-1 overflow-auto p-8 max-w-screen-2xl mx-auto w-full">
        <div className="flex flex-wrap justify-between items-end gap-4 mb-8">
          <div>
            <h1 className="text-3xl font-semibold tracking-tight text-white mb-2">Projects</h1>
            <p className="text-xs text-zinc-500 tracking-widest uppercase">
              {projects?.length ?? 0} project{projects?.length === 1 ? '' : 's'}{' '}
              {storageMode === 'browser'
                ? <>on this computer{usage && <> · {formatBytes(usage.used)} of {formatBytes(usage.quota)} used in this browser</>}</>
                : 'in your projects folder'}
            </p>
          </div>
          <div className="flex items-center gap-3">
            <input
              ref={importRef}
              type="file"
              accept=".foldrule,.qsproj,application/json"
              className="hidden"
              onChange={e => void handleImport(e.target.files?.[0])}
            />
            <StorageButton onClick={() => setShowStorage(true)} />
            <button
              type="button"
              onClick={() => setSortBy(s => (s === 'recent' ? 'name' : 'recent'))}
              title={sortBy === 'recent' ? 'Sorted by last edited — click for A–Z' : 'Sorted A–Z — click for last edited'}
              className="flex items-center gap-2 text-[11px] font-bold border border-industrial-border px-3 py-2 text-zinc-400 hover:text-zinc-200 hover:border-zinc-500 uppercase tracking-widest transition-colors"
            >
              <ArrowDownUp className="w-3.5 h-3.5" aria-hidden />
              {sortBy === 'recent' ? 'Sort: Recent' : 'Sort: A–Z'}
            </button>
            <button
              type="button"
              onClick={() => importRef.current?.click()}
              className="flex items-center gap-2 text-[11px] font-bold border border-industrial-border px-3 py-2 text-zinc-400 hover:text-zinc-200 hover:border-zinc-500 uppercase tracking-widest transition-colors"
            >
              <Upload className="w-3.5 h-3.5" aria-hidden />
              Import backup
            </button>
            <button
              type="button"
              onClick={() => setCreating(true)}
              className="flex items-center gap-2 text-[11px] font-bold bg-amber-accent hover:bg-amber-400 text-black px-4 py-2 uppercase tracking-widest transition-all"
            >
              <Plus className="w-3.5 h-3.5" aria-hidden />
              New Project
            </button>
          </div>
        </div>

        {error && (
          <div role="alert" className="mb-6 flex items-start justify-between gap-4 border border-red-500/40 bg-red-500/10 px-4 py-3 text-xs text-red-200">
            <span>{error}</span>
            <button type="button" onClick={() => setError(null)} className="text-red-300 hover:text-white" aria-label="Dismiss">✕</button>
          </div>
        )}

        {projects === null ? (
          <p className="text-xs text-zinc-500 uppercase tracking-widest">Loading projects…</p>
        ) : (
          <>
            {query && filtered.length === 0 && (
              <p className="mb-6 text-xs text-zinc-500 uppercase tracking-widest">No projects match “{query}”.</p>
            )}
            {projects.length === 0 && !error && (
              <div className="border border-industrial-border bg-industrial-panel px-6 py-12 md:py-16 flex flex-col items-center text-center font-sans">
                <span className="w-14 h-14 border border-amber-accent/50 text-amber-accent flex items-center justify-center mb-6">
                  <FileText className="w-6 h-6" aria-hidden />
                </span>
                <h2 className="text-xl font-semibold text-white">Start your first takeoff</h2>
                <p className="mt-2 text-sm text-zinc-400 max-w-md leading-relaxed">
                  Create a project, drop in a PDF drawing, set its scale, and start measuring.
                  Everything saves on this computer as you go.
                </p>
                <div className="mt-7 flex flex-wrap justify-center gap-3">
                  <button type="button" onClick={() => setCreating(true)}
                    className="flex items-center gap-2 bg-amber-accent hover:bg-amber-400 text-black text-sm font-bold px-5 py-2.5 transition-colors">
                    <Plus className="w-4 h-4" aria-hidden />
                    New project
                  </button>
                  <button type="button" onClick={() => importRef.current?.click()}
                    className="flex items-center gap-2 border border-industrial-border hover:border-zinc-500 text-zinc-300 text-sm font-semibold px-5 py-2.5 transition-colors">
                    <Upload className="w-4 h-4" aria-hidden />
                    Import a backup
                  </button>
                </div>
              </div>
            )}
            <div className={cn('grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6', projects.length === 0 && 'hidden')}>
              {filtered.map((project, i) => {
                const active = Date.now() - project.updatedAt < WEEK;
                return (
                  <motion.div
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: Math.min(i, 12) * 0.05 }}
                    key={project.id}
                    className={cn(
                      'group bg-industrial-panel border border-industrial-border hover:border-amber-accent/50 transition-all hover:shadow-2xl flex flex-col',
                      busyId === project.id && 'opacity-60',
                    )}
                  >
                    <button
                      type="button"
                      onClick={() => open(project.id)}
                      aria-label={`Open ${project.name}`}
                      className="h-32 bg-stone-900 border-b border-industrial-border relative overflow-hidden flex items-center justify-center focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-amber-300"
                    >
                      <span className="absolute inset-0 blueprint-grid opacity-30 group-hover:opacity-50 transition-opacity" aria-hidden />
                      <span className="z-10 flex flex-col items-center gap-2 text-zinc-600 group-hover:text-amber-accent/70 transition-colors">
                        {project.drawingCount > 0
                          ? <FileText className="w-9 h-9" aria-hidden />
                          : <FolderOpen className="w-9 h-9" aria-hidden />}
                        <span className="text-[11px] font-bold uppercase tracking-widest">
                          {project.drawingCount > 0
                            ? `${project.drawingCount} drawing${project.drawingCount === 1 ? '' : 's'}`
                            : 'No drawings yet'}
                        </span>
                      </span>
                      {active && (
                        <span className="absolute top-3 right-3 flex items-center gap-1.5 px-2 py-0.5 bg-emerald-500/10 border border-emerald-500/30 text-[10px] font-bold text-emerald-400 uppercase tracking-widest">
                          <span className="w-1.5 h-1.5 bg-emerald-500 rounded-full animate-pulse" />
                          Recent
                        </span>
                      )}
                    </button>

                    <div className="p-4 flex-1 flex flex-col justify-between">
                      <div>
                        {renaming === project.id ? (
                          <RenameField
                            initial={project.name}
                            onCancel={() => setRenaming(null)}
                            onSave={name => { setRenaming(null); void run(project.id, () => renameProject(project.id, name), 'Couldn’t rename'); }}
                          />
                        ) : (
                          <button
                            type="button"
                            onClick={() => open(project.id)}
                            className="block text-left font-bold text-sm tracking-tight text-zinc-100 uppercase group-hover:text-amber-accent transition-colors max-w-full truncate"
                            title={project.name}
                          >
                            {project.name}
                          </button>
                        )}
                        <div className="flex items-center gap-2 mt-2 text-[11px] text-zinc-500 tracking-widest uppercase">
                          <span>Created: {new Date(project.createdAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}</span>
                          {project.number && <span>· No. {project.number}</span>}
                        </div>
                      </div>

                      <div className="mt-6 pt-4 border-t border-industrial-border/50 flex justify-between items-center text-[11px] uppercase font-bold tracking-widest">
                        <span className="text-zinc-600 flex items-center gap-1.5">
                          <BoxSelect className="w-3.5 h-3.5" aria-hidden />
                          {project.measurementCount} Quantities
                        </span>
                        <span className="text-amber-accent/70">{formatWhen(project.updatedAt)}</span>
                      </div>

                      <div className="mt-3 flex items-center gap-1">
                        <IconButton label="Rename" onClick={() => setRenaming(project.id)} icon={<Pencil className="w-3.5 h-3.5" />} />
                        <IconButton label="Duplicate" onClick={() => void run(project.id, () => duplicateProject(project.id), 'Couldn’t duplicate')} icon={<Copy className="w-3.5 h-3.5" />} />
                        <IconButton label="Download backup" onClick={() => void handleBackup(project)} icon={<Download className="w-3.5 h-3.5" />} />
                        <span className="flex-1" />
                        <IconButton label="Delete" danger onClick={() => void handleDelete(project)} icon={<Trash2 className="w-3.5 h-3.5" />} />
                      </div>
                    </div>
                  </motion.div>
                );
              })}

              <button
                type="button"
                onClick={() => setCreating(true)}
                className="border-2 border-dashed border-industrial-border hover:border-amber-accent/40 bg-industrial-panel/30 hover:bg-amber-accent/5 flex flex-col items-center justify-center min-h-[260px] text-zinc-600 hover:text-amber-accent transition-all"
              >
                <Plus className="w-8 h-8 mb-4 border border-current rounded-none" aria-hidden />
                <span className="text-sm font-bold uppercase tracking-widest">New project</span>
              </button>
            </div>
          </>
        )}
      </main>

      {showStorage && (
        <StorageDialog onClose={() => setShowStorage(false)} onChanged={() => void refresh()} />
      )}

      {creating && (
        <NewProjectDialog
          onCancel={() => setCreating(false)}
          onCreate={(name, number) => { setCreating(false); void handleCreate(name, number); }}
        />
      )}
    </div>
  );
}

function IconButton({ label, icon, onClick, danger }: { label: string; icon: React.ReactNode; onClick: () => void; danger?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className={cn(
        'p-1.5 text-zinc-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-amber-300',
        danger ? 'hover:text-red-400' : 'hover:text-zinc-200',
      )}
    >
      {icon}
    </button>
  );
}

function RenameField({ initial, onSave, onCancel }: { initial: string; onSave: (v: string) => void; onCancel: () => void }) {
  const [value, setValue] = useState(initial);
  return (
    <form onSubmit={e => { e.preventDefault(); if (value.trim()) onSave(value); }}>
      <input
        autoFocus
        value={value}
        maxLength={120}
        onChange={e => setValue(e.target.value)}
        onBlur={() => (value.trim() && value !== initial ? onSave(value) : onCancel())}
        onKeyDown={e => { if (e.key === 'Escape') onCancel(); }}
        aria-label="Project name"
        className="w-full bg-stone-900 border border-amber-accent px-2 py-1 text-sm outline-none"
      />
    </form>
  );
}

function NewProjectDialog({ onCreate, onCancel }: { onCreate: (name: string, number: string) => void; onCancel: () => void }) {
  const [name,   setName]   = useState('');
  const [number, setNumber] = useState('');
  // A project needs somewhere safe to live first: a folder on this computer (or a synced
  // drive), which also holds the price bank. Browser-only storage is a deliberate exception.
  const folder = useFolderStatus();
  const [browserOnly, setBrowserOnly] = useState(false);
  const [busy, setBusy] = useState(false);
  const inFolder = !!folder.folderName && folder.permission === 'granted';
  const ready = inFolder || browserOnly || (folder.loaded && !folder.supported);
  const pick = async (fn: () => Promise<boolean>) => { setBusy(true); try { await fn(); } finally { setBusy(false); } };
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="new-project-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4"
      onKeyDown={e => { if (e.key === 'Escape') onCancel(); }}
    >
      <form
        onSubmit={e => { e.preventDefault(); if (name.trim() && ready) onCreate(name, number); }}
        className="w-full max-w-md bg-industrial-panel border border-industrial-border p-6"
      >
        <h2 id="new-project-title" className="text-lg font-semibold">New project</h2>

        <div className={`mt-4 border p-3 text-xs leading-relaxed ${inFolder ? 'border-emerald-700/60 bg-emerald-500/5' : 'border-amber-accent/60 bg-amber-accent/10'}`} role="group" aria-label="Where projects are saved">
          <div className="font-bold uppercase tracking-widest text-[10px] text-zinc-400 mb-1">1 · Where it is saved</div>
          {!folder.loaded ? (
            <p className="text-zinc-500">Checking…</p>
          ) : inFolder ? (
            <p className="text-emerald-400">Saved in your folder “{folder.folderName}”, with the drawings and your price bank.</p>
          ) : !folder.supported ? (
            <p className="text-amber-200">This browser cannot save to a folder (Edge and Chrome can). The project will be kept in this browser only: download a backup from the project list regularly.</p>
          ) : (
            <>
              <p className="text-amber-100">
                {folder.folderName
                  ? <>Your projects folder “{folder.folderName}” needs access allowed again.</>
                  : <>Choose a folder for your projects first. Drawings, measurements and your price bank are saved there as ordinary files, so nothing is lost if the browser is cleared. A OneDrive or Google Drive folder also backs them up.</>}
              </p>
              <div className="mt-2 flex flex-wrap items-center gap-3">
                <button type="button" disabled={busy} onClick={() => void pick(folder.folderName ? resumeFolder : connectFolder)}
                  className="bg-amber-accent hover:bg-amber-400 disabled:opacity-50 text-black text-xs font-bold px-3 py-1.5">
                  {busy ? 'Waiting…' : folder.folderName ? 'Allow access' : 'Choose a folder'}
                </button>
                {folder.folderName && (
                  <button type="button" disabled={busy} onClick={() => void pick(connectFolder)} className="text-zinc-300 underline underline-offset-2 hover:text-white">Choose a different folder</button>
                )}
                {!browserOnly && (
                  <button type="button" onClick={() => setBrowserOnly(true)} className="text-zinc-500 underline underline-offset-2 hover:text-zinc-300"
                    title="Not recommended: clearing the browser's data deletes the project and your prices">
                    Not now, keep it in this browser only
                  </button>
                )}
              </div>
              {browserOnly && <p className="mt-2 text-amber-300">Browser only: clearing this browser’s data will delete the project and your prices. You can choose a folder later from “Storage”.</p>}
              {folder.error && <p className="mt-2 text-red-400">{folder.error}</p>}
            </>
          )}
        </div>
        <div className="mt-4 font-bold uppercase tracking-widest text-[10px] text-zinc-400">2 · The project</div>
        <label className="mt-2 block text-xs font-semibold text-zinc-400" htmlFor="np-name">Project name</label>
        <input
          id="np-name"
          autoFocus
          required
          maxLength={120}
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder="e.g. Colombo Residence — Kitchen fit-out"
          className="mt-1 w-full bg-stone-900 border border-industrial-border px-3 py-2 text-sm outline-none focus:border-amber-accent"
        />
        <label className="mt-4 block text-xs font-semibold text-zinc-400" htmlFor="np-number">Project number <span className="font-normal text-zinc-500">(optional)</span></label>
        <input
          id="np-number"
          maxLength={60}
          value={number}
          onChange={e => setNumber(e.target.value)}
          className="mt-1 w-full bg-stone-900 border border-industrial-border px-3 py-2 text-sm outline-none focus:border-amber-accent"
        />
        <div className="mt-6 flex justify-end gap-3">
          <button type="button" onClick={onCancel} className="px-4 py-2 text-xs font-semibold text-zinc-400 hover:text-zinc-200">
            Cancel
          </button>
          <button
            type="submit"
            disabled={!name.trim() || !ready}
            title={ready ? undefined : 'Choose where the project is saved first'}
            className="bg-amber-accent hover:bg-amber-400 disabled:opacity-40 text-black text-xs font-bold px-4 py-2"
          >
            Create project
          </button>
        </div>
      </form>
    </div>
  );
}
