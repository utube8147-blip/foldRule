'use client';

import { useEffect, useState } from 'react';
import { useTakeoffData, useSaveStatus } from '@/context/TakeoffContext';

function ago(ts: number, now: number): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 10) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** Small status line: "Saved just now" / "Saving…" / "Couldn't save — retry". */
export function SaveIndicator() {
  const { saveNow, projectId } = useTakeoffData();
  const { saveStatus, lastSavedAt } = useSaveStatus();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(t);
  }, []);

  if (!projectId) return null;

  if (saveStatus === 'error') {
    return (
      <button
        type="button"
        onClick={() => void saveNow()}
        className="flex items-center gap-1.5 text-[10px] font-semibold text-red-400 hover:text-red-300"
        title="Local storage refused the save. Free up disk space or leave private browsing, then retry."
      >
        <span className="h-1.5 w-1.5 rounded-full bg-red-500" aria-hidden />
        Couldn’t save — retry
      </button>
    );
  }

  const label =
    saveStatus === 'saving'  ? 'Saving…' :
    saveStatus === 'unsaved' ? 'Unsaved changes' :
    lastSavedAt              ? `Saved ${ago(lastSavedAt, now)}` : 'Saved';

  const dot =
    saveStatus === 'saved' ? 'bg-emerald-500' :
    saveStatus === 'saving' ? 'bg-amber-400 animate-pulse' : 'bg-zinc-500';

  return (
    <span role="status" aria-live="polite" className="flex items-center gap-1.5 text-[10px] font-semibold text-zinc-500">
      <span className={`h-1.5 w-1.5 rounded-full ${dot}`} aria-hidden />
      {label}
    </span>
  );
}
