'use client';

// ─── Dashboard: local projects ───────────────────────────────────────────────
//  Projects live in this browser (IndexedDB) — see lib/storage/projectDb.ts.
//  Backups (.qsproj) move a project between browsers/devices.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  HardHat, FolderOpen, Plus, Search, Upload, Download, Copy, Trash2, Pencil, HardDrive,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { projectHref } from '@/lib/nav/projectHref';
import {
  listProjects, createProject, deleteProject, renameProject, duplicateProject,
  exportProjectBackup, importProjectBackup, downloadBlob, isStorageAvailable,
  type ProjectSummary,
} from '@/lib/storage/projectDb';

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
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [busyId,   setBusyId]   = useState<string | null>(null);
  const [usage,    setUsage]    = useState<{ used: number; quota: number } | null>(null);
  const importRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    try {
      setProjects(await listProjects());
      setError(null);
      const est = await navigator.storage?.estimate?.();
      if (est?.usage != null && est.quota) setUsage({ used: est.usage, quota: est.quota });
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
    if (!q) return projects;
    return projects.filter(p => p.name.toLowerCase().includes(q) || p.number.toLowerCase().includes(q));
  }, [projects, query]);

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

  const handleDelete = (p: ProjectSummary) => {
    const ok = window.confirm(
      `Delete “${p.name}”?\n\nIts drawings and ${p.measurementCount} measurements will be removed from this browser. This can’t be undone — download a backup first if you might need it.`,
    );
    if (ok) void run(p.id, () => deleteProject(p.id), 'Couldn’t delete the project');
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

  return (
    <div className="min-h-screen bg-industrial-black flex flex-col text-zinc-200">
      <header className="h-16 border-b border-industrial-border bg-industrial-panel px-6 flex items-center justify-between sticky top-0 z-40 gap-4">
        <div className="flex items-center gap-3">
          <HardHat className="w-7 h-7 text-amber-accent" aria-hidden />
          <span className="text-xl font-black tracking-tighter text-amber-accent font-mono uppercase">Quantity Savior</span>
        </div>

        <div className="relative">
          <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500" aria-hidden />
          <input
            type="search"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search projects"
            aria-label="Search projects"
            className="bg-stone-900 border border-industrial-border pl-9 pr-4 py-1.5 text-xs outline-none focus:border-amber-accent w-56"
          />
        </div>
      </header>

      <main className="flex-1 p-6 md:p-8 max-w-screen-2xl mx-auto w-full">
        <div className="flex flex-wrap justify-between items-end gap-4 mb-8">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Projects</h1>
            <p className="mt-1 text-sm text-zinc-500">
              Saved in this browser.{' '}
              {usage && <span>Using {formatBytes(usage.used)} of {formatBytes(usage.quota)} available.</span>}
            </p>
          </div>
          <div className="flex items-center gap-3">
            <input
              ref={importRef}
              type="file"
              accept=".qsproj,application/json"
              className="hidden"
              onChange={e => void handleImport(e.target.files?.[0])}
            />
            <button
              type="button"
              onClick={() => importRef.current?.click()}
              className="flex items-center gap-2 text-xs font-semibold border border-industrial-border px-3 py-2 text-zinc-300 hover:border-zinc-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-amber-300"
            >
              <Upload className="w-3.5 h-3.5" aria-hidden />
              Import backup
            </button>
            <button
              type="button"
              onClick={() => setCreating(true)}
              className="flex items-center gap-2 text-xs font-bold bg-amber-accent hover:bg-amber-400 text-black px-4 py-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-300"
            >
              <Plus className="w-3.5 h-3.5" aria-hidden />
              New project
            </button>
          </div>
        </div>

        {error && (
          <div role="alert" className="mb-6 flex items-start justify-between gap-4 border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-200">
            <span>{error}</span>
            <button type="button" onClick={() => setError(null)} className="text-red-300 hover:text-white" aria-label="Dismiss">✕</button>
          </div>
        )}

        {projects === null ? (
          <p className="text-sm text-zinc-500">Loading projects…</p>
        ) : projects.length === 0 ? (
          <EmptyState onCreate={() => setCreating(true)} onImport={() => importRef.current?.click()} />
        ) : filtered.length === 0 ? (
          <p className="text-sm text-zinc-500">No projects match “{query}”.</p>
        ) : (
          <ul className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-5">
            {filtered.map(p => (
              <li
                key={p.id}
                className={cn(
                  'group bg-industrial-panel border border-industrial-border hover:border-amber-accent/50 flex flex-col',
                  busyId === p.id && 'opacity-60',
                )}
              >
                <button
                  type="button"
                  onClick={() => open(p.id)}
                  className="h-28 bg-stone-900 border-b border-industrial-border relative overflow-hidden flex items-center justify-center focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-amber-300"
                  aria-label={`Open ${p.name}`}
                >
                  <span className="absolute inset-0 blueprint-grid opacity-30 group-hover:opacity-50" aria-hidden />
                  <FolderOpen className="w-9 h-9 text-zinc-700 group-hover:text-amber-accent/60 z-10" aria-hidden />
                </button>

                <div className="p-4 flex-1 flex flex-col">
                  {renaming === p.id ? (
                    <RenameField
                      initial={p.name}
                      onCancel={() => setRenaming(null)}
                      onSave={name => { setRenaming(null); void run(p.id, () => renameProject(p.id, name), 'Couldn’t rename'); }}
                    />
                  ) : (
                    <button
                      type="button"
                      onClick={() => open(p.id)}
                      className="text-left font-semibold text-sm text-zinc-100 group-hover:text-amber-accent truncate"
                      title={p.name}
                    >
                      {p.name}
                    </button>
                  )}
                  <p className="mt-1 text-xs text-zinc-500">
                    {p.number ? `No. ${p.number} · ` : ''}Edited {formatWhen(p.updatedAt)}
                  </p>
                  <p className="mt-3 text-xs text-zinc-400">
                    {p.drawingCount} {p.drawingCount === 1 ? 'drawing' : 'drawings'}, {p.measurementCount} {p.measurementCount === 1 ? 'measurement' : 'measurements'}
                  </p>

                  <div className="mt-4 pt-3 border-t border-industrial-border/60 flex items-center gap-1">
                    <IconButton label="Rename" onClick={() => setRenaming(p.id)} icon={<Pencil className="w-3.5 h-3.5" />} />
                    <IconButton label="Duplicate" onClick={() => void run(p.id, () => duplicateProject(p.id), 'Couldn’t duplicate')} icon={<Copy className="w-3.5 h-3.5" />} />
                    <IconButton label="Download backup" onClick={() => void handleBackup(p)} icon={<Download className="w-3.5 h-3.5" />} />
                    <span className="flex-1" />
                    <IconButton label="Delete" danger onClick={() => handleDelete(p)} icon={<Trash2 className="w-3.5 h-3.5" />} />
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </main>

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

function EmptyState({ onCreate, onImport }: { onCreate: () => void; onImport: () => void }) {
  return (
    <div className="border border-dashed border-industrial-border px-8 py-16 max-w-xl">
      <HardDrive className="w-8 h-8 text-zinc-600" aria-hidden />
      <h2 className="mt-4 text-lg font-semibold">Start your first takeoff</h2>
      <p className="mt-2 text-sm leading-relaxed text-zinc-400">
        Create a project, add a PDF drawing, set the scale, and measure. Everything is saved in this browser
        as you work. Download a backup to move a project to another computer.
      </p>
      <div className="mt-6 flex gap-3">
        <button type="button" onClick={onCreate} className="bg-amber-accent hover:bg-amber-400 text-black text-xs font-bold px-4 py-2">
          New project
        </button>
        <button type="button" onClick={onImport} className="border border-industrial-border text-xs font-semibold px-4 py-2 text-zinc-300 hover:border-zinc-500">
          Import backup
        </button>
      </div>
    </div>
  );
}

function NewProjectDialog({ onCreate, onCancel }: { onCreate: (name: string, number: string) => void; onCancel: () => void }) {
  const [name,   setName]   = useState('');
  const [number, setNumber] = useState('');
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="new-project-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4"
      onKeyDown={e => { if (e.key === 'Escape') onCancel(); }}
    >
      <form
        onSubmit={e => { e.preventDefault(); if (name.trim()) onCreate(name, number); }}
        className="w-full max-w-md bg-industrial-panel border border-industrial-border p-6"
      >
        <h2 id="new-project-title" className="text-lg font-semibold">New project</h2>
        <label className="mt-5 block text-xs font-semibold text-zinc-400" htmlFor="np-name">Project name</label>
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
            disabled={!name.trim()}
            className="bg-amber-accent hover:bg-amber-400 disabled:opacity-40 text-black text-xs font-bold px-4 py-2"
          >
            Create project
          </button>
        </div>
      </form>
    </div>
  );
}
