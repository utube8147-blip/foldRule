'use client';

// Storage + install controls. Design rules:
//  • Nothing opens on its own. Browser permission prompts only follow a click.
//  • If folder access lapses, one inline strip explains it; "Not now" hides it
//    for the rest of the session. Work keeps saving in the browser meanwhile.
//  • "Install app" only appears when the browser can actually install.

import { useEffect, useState } from 'react';
import { FolderOpen, FolderSync, HardDrive, MonitorDown, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useFolderStatus, useInstallState } from './hooks';
import { connectFolder, resumeFolder, disconnectFolder, syncFolder } from '@/lib/storage/folderSync';
import { promptInstall } from '@/lib/pwa/install';

const DISMISS_KEY = 'foldrule:folder-strip-dismissed';

function when(ts: number | null): string {
  if (!ts) return 'not yet';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 10) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min ago` : new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// ── Install ──────────────────────────────────────────────────────────────────

export function InstallAppButton({ className }: { className?: string }) {
  const { canInstall, installed } = useInstallState();
  if (!canInstall || installed) return null;
  return (
    <button
      type="button"
      onClick={() => void promptInstall()}
      title="Install Foldrule as an app on this computer"
      className={cn(
        'flex items-center gap-2 text-[11px] font-bold border border-industrial-border px-3 py-1.5 text-zinc-400 hover:text-amber-accent hover:border-amber-accent/60 uppercase tracking-widest transition-colors',
        className,
      )}
    >
      <MonitorDown className="w-3.5 h-3.5" aria-hidden />
      Install app
    </button>
  );
}

// ── Dashboard button that opens the storage dialog ───────────────────────────

export function StorageButton({ onClick }: { onClick: () => void }) {
  const f = useFolderStatus();
  if (!f.loaded) return null;
  const connected = !!f.folderName;
  const dot =
    !connected ? null :
    f.error || f.permission === 'denied' ? 'bg-red-500' :
    f.permission === 'granted' ? 'bg-emerald-500' : 'bg-amber-400';
  return (
    <button
      type="button"
      onClick={onClick}
      title={connected ? `Projects are also saved to the folder “${f.folderName}”` : 'Choose where projects are saved'}
      className="flex items-center gap-2 text-[11px] font-bold border border-industrial-border px-3 py-2 text-zinc-400 hover:text-zinc-200 hover:border-zinc-500 uppercase tracking-widest transition-colors max-w-[220px]"
    >
      {connected ? <FolderSync className="w-3.5 h-3.5 shrink-0" aria-hidden /> : <HardDrive className="w-3.5 h-3.5 shrink-0" aria-hidden />}
      <span className="truncate">{connected ? f.folderName : 'Save location'}</span>
      {dot && <span className={cn('w-1.5 h-1.5 rounded-full shrink-0', dot)} aria-hidden />}
    </button>
  );
}

// ── Inline strip when folder access needs attention ──────────────────────────

export function FolderPermissionStrip({ onAfterResume }: { onAfterResume?: () => void }) {
  const f = useFolderStatus();
  const [dismissed, setDismissed] = useState(true);

  useEffect(() => {
    try { setDismissed(sessionStorage.getItem(DISMISS_KEY) === '1'); } catch { setDismissed(false); }
  }, []);

  const needsAttention = !!f.folderName && (f.permission === 'prompt' || f.permission === 'denied' || !!f.error);
  if (!needsAttention || dismissed) return null;

  const dismiss = () => {
    setDismissed(true);
    try { sessionStorage.setItem(DISMISS_KEY, '1'); } catch { /* ignore */ }
  };

  const blocked = f.permission === 'denied' || !!f.error;
  return (
    <div role="status" className="border-b border-amber-400/30 bg-amber-400/[0.07] px-6 py-2.5 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs font-mono">
      <FolderSync className="w-4 h-4 text-amber-400 shrink-0" aria-hidden />
      <span className="text-amber-100/90 flex-1 min-w-[240px]">
        {blocked
          ? <>{f.error ?? <>Saving to the folder “{f.folderName}” is blocked by the browser.</>} Your work is still saved in this browser.</>
          : <>Saving to the folder “{f.folderName}” is paused until you allow it again. Your work is still saved in this browser.</>}
      </span>
      {blocked ? (
        <>
          <button type="button" onClick={() => void connectFolder().then(ok => ok && onAfterResume?.())}
            className="bg-amber-accent hover:bg-amber-400 text-black font-bold uppercase tracking-widest px-3 py-1.5 text-[11px]">
            Choose folder again
          </button>
          <button type="button" onClick={() => void disconnectFolder()}
            className="text-zinc-400 hover:text-zinc-200 uppercase tracking-widest text-[11px] font-bold">
            Stop using folder
          </button>
        </>
      ) : (
        <button type="button" onClick={() => void resumeFolder().then(ok => ok && onAfterResume?.())}
          className="bg-amber-accent hover:bg-amber-400 text-black font-bold uppercase tracking-widest px-3 py-1.5 text-[11px]">
          Allow access
        </button>
      )}
      <button type="button" onClick={dismiss} aria-label="Hide for now"
        className="text-zinc-500 hover:text-zinc-200 uppercase tracking-widest text-[11px] font-bold">
        Not now
      </button>
    </div>
  );
}

// ── Storage dialog ───────────────────────────────────────────────────────────

export function StorageDialog({ onClose, onChanged }: { onClose: () => void; onChanged?: () => void }) {
  const f = useFolderStatus();
  const { canInstall, installed } = useInstallState();
  const [busy, setBusy] = useState(false);
  const connected = !!f.folderName;

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try { await fn(); onChanged?.(); } finally { setBusy(false); }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const statusText =
    f.syncing ? 'Syncing…' :
    f.error ? f.error :
    f.permission === 'granted' ? `Saving here · last synced ${when(f.lastSyncAt)}` :
    f.permission === 'denied' ? 'Blocked by the browser' :
    'Paused — needs your OK';

  return (
    <div role="dialog" aria-modal="true" aria-labelledby="storage-title"
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/70 px-4"
      onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="w-full max-w-lg bg-industrial-panel border border-industrial-border font-mono text-zinc-300">
        <div className="flex items-center justify-between px-6 py-4 border-b border-industrial-border">
          <h2 id="storage-title" className="text-sm font-bold uppercase tracking-widest text-zinc-100">Where projects are saved</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="p-1 text-zinc-500 hover:text-zinc-200">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-6 space-y-6 text-xs leading-relaxed">
          <section className="flex gap-3">
            <HardDrive className="w-5 h-5 text-emerald-400 shrink-0 mt-0.5" aria-hidden />
            <div>
              <h3 className="font-bold uppercase tracking-widest text-zinc-200 text-xs">This browser · always on</h3>
              <p className="mt-1 text-zinc-400">
                Every change saves here automatically, including offline. This is what the app works from.
              </p>
            </div>
          </section>

          <section className="flex gap-3">
            <FolderOpen className={cn('w-5 h-5 shrink-0 mt-0.5', connected ? 'text-amber-accent' : 'text-zinc-500')} aria-hidden />
            <div className="flex-1">
              <h3 className="font-bold uppercase tracking-widest text-zinc-200 text-xs">
                A folder on this computer {connected ? '' : '· optional'}
              </h3>

              {!f.supported ? (
                <p className="mt-1 text-zinc-400">
                  This browser can’t save to folders. Use Microsoft Edge or Google Chrome for this, or keep copies with
                  “Download backup” on each project.
                </p>
              ) : connected ? (
                <>
                  <p className="mt-1 text-zinc-200 break-all">“{f.folderName}”</p>
                  <p className={cn('mt-0.5', f.error || f.permission === 'denied' ? 'text-red-300' : f.permission === 'granted' ? 'text-zinc-500' : 'text-amber-300')}>
                    {statusText}
                  </p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {f.permission === 'granted' ? (
                      <button type="button" disabled={busy || f.syncing} onClick={() => void act(syncFolder)}
                        className="border border-industrial-border px-3 py-1.5 text-[11px] font-bold uppercase tracking-widest hover:border-zinc-500 disabled:opacity-50">
                        Sync now
                      </button>
                    ) : f.permission === 'prompt' && !f.error ? (
                      <button type="button" disabled={busy} onClick={() => void act(resumeFolder)}
                        className="bg-amber-accent hover:bg-amber-400 text-black px-3 py-1.5 text-[11px] font-bold uppercase tracking-widest disabled:opacity-50">
                        Allow access
                      </button>
                    ) : null}
                    <button type="button" disabled={busy} onClick={() => void act(connectFolder)}
                      className="border border-industrial-border px-3 py-1.5 text-[11px] font-bold uppercase tracking-widest hover:border-zinc-500 disabled:opacity-50">
                      Change folder
                    </button>
                    <button type="button" disabled={busy} onClick={() => void act(disconnectFolder)}
                      className="px-3 py-1.5 text-[11px] font-bold uppercase tracking-widest text-zinc-500 hover:text-red-300 disabled:opacity-50">
                      Stop saving to folder
                    </button>
                  </div>
                  <p className="mt-3 text-zinc-500">
                    This folder is used by Foldrule everywhere on this computer — the browser tab and the installed
                    app share it, so you only choose it once.{' '}
                    Each project is a sub-folder with a <span className="text-zinc-300">project.json</span> and its PDFs.
                    Point this at a OneDrive or Google Drive folder to keep projects in sync across computers.
                    Stopping leaves the files where they are.
                  </p>
                </>
              ) : (
                <>
                  <p className="mt-1 text-zinc-400">
                    Keep a copy of every project as real files in a folder you choose — easy to back up, or to sync
                    between computers through OneDrive or Google Drive. Your browser will ask once to allow access.
                  </p>
                  <button type="button" disabled={busy} onClick={() => void act(connectFolder)}
                    className="mt-3 flex items-center gap-2 bg-amber-accent hover:bg-amber-400 text-black px-4 py-2 text-[11px] font-bold uppercase tracking-widest disabled:opacity-50">
                    <FolderOpen className="w-3.5 h-3.5" aria-hidden />
                    Choose folder
                  </button>
                </>
              )}
            </div>
          </section>

          {f.supported && !installed && (
            <section className="border-t border-industrial-border pt-5 flex gap-3">
              <MonitorDown className="w-5 h-5 text-zinc-500 shrink-0 mt-0.5" aria-hidden />
              <div className="flex-1">
                <h3 className="font-bold uppercase tracking-widest text-zinc-200 text-xs">Tip: install Foldrule</h3>
                <p className="mt-1 text-zinc-400">
                  As an installed app, your browser can remember folder access (“Allow on every visit”), so you’re not asked
                  again. It also gets its own window, works offline, and opens PDFs and .foldrule files from File Explorer.
                </p>
                {canInstall ? (
                  <button type="button" onClick={() => void promptInstall()}
                    className="mt-3 flex items-center gap-2 border border-amber-accent text-amber-accent hover:bg-amber-accent/10 px-3 py-1.5 text-[11px] font-bold uppercase tracking-widest">
                    <MonitorDown className="w-3.5 h-3.5" aria-hidden />
                    Install app
                  </button>
                ) : (
                  <p className="mt-2 text-zinc-500">Use the install icon in the browser’s address bar.</p>
                )}
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Compact status for the workspace save indicator ──────────────────────────

export function FolderSaveHint() {
  const f = useFolderStatus();
  if (!f.folderName) return null;
  if (f.permission === 'granted' && !f.error) {
    return <span className="text-[11px] text-zinc-600 font-semibold" title={`Also saved to the folder “${f.folderName}”`}>· folder</span>;
  }
  if (f.permission === 'prompt' && !f.error) {
    return (
      <button type="button" onClick={() => void resumeFolder()}
        title={`Saving to “${f.folderName}” is paused. Click to allow it again.`}
        className="text-[11px] font-bold text-amber-400 hover:text-amber-300 border border-amber-400/40 px-1.5 py-0.5">
        Folder paused · Allow
      </button>
    );
  }
  return <span className="text-[11px] font-semibold text-red-400" title={f.error ?? 'Folder access blocked'}>· folder not saving</span>;
}
