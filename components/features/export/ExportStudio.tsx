'use client';

// /export — the export page. Step 1: project details (skippable). Step 2: pick
// sheets and colours, preview and edit the workbook like Excel, download.

import React, { useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Download, Loader2, FileSpreadsheet } from 'lucide-react';
import { useProjectHref } from '@/lib/nav/projectHref';
import { exportProjectToExcel, exportFilename } from '@/lib/export/clientExport';
import { useSaveStatus, useTakeoffData } from '@/context/TakeoffContext';
import { ProjectDetailsStep, detailsProgress } from './ProjectDetailsStep';
import { WorkbookStep } from './WorkbookStep';
import { useStudio } from './useStudio';

export function ExportStudio() {
  const studio = useStudio();
  const { updateProjectMeta } = useTakeoffData();
  const { ps, settings, save, state } = studio;
  const href = useProjectHref();
  const [step, setStep] = useState<'details' | 'workbook'>(settings.detailsReviewed ? 'workbook' : 'details');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const { saveStatus } = useSaveStatus();
  const progress = detailsProgress(ps);

  const leaveDetails = () => { save({ detailsReviewed: true }); setStep('workbook'); };

  const download = async () => {
    setBusy(true); setMessage(null);
    try {
      const name = await exportProjectToExcel(ps, settings.filename, settings);
      setMessage({ tone: 'ok', text: `Saved ${name}` });
    } catch (e) {
      setMessage({ tone: 'error', text: `Export failed: ${e instanceof Error ? e.message : String(e)}` });
    } finally { setBusy(false); }
  };

  return (
    <div className="h-screen flex flex-col bg-industrial-black text-zinc-200">
      {/* Top bar */}
      <header className="h-14 shrink-0 flex items-center gap-4 px-4 border-b border-zinc-800 bg-[#121417]">
        <Link href={href('/workspace')} className="inline-flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-widest text-zinc-400 hover:text-amber-accent">
          <ArrowLeft size={14} /> Workspace
        </Link>
        <div className="h-6 w-px bg-zinc-800" />
        <div className="flex items-center gap-2 min-w-0">
          <FileSpreadsheet size={16} className="text-amber-accent shrink-0" />
          <div className="min-w-0">
            <div className="text-[13px] font-black text-zinc-100 truncate">Export to Excel</div>
            <div className="text-[10px] text-zinc-500 truncate">{ps.projectName}{saveStatus === 'saving' ? ' · saving…' : saveStatus === 'saved' ? ' · saved' : ''}</div>
          </div>
        </div>

        <nav className="flex items-center gap-1 ml-4" aria-label="Steps">
          <StepTab n={1} label="Project details" sub={`${progress.done}/${progress.total}`} on={step === 'details'} onClick={() => setStep('details')} />
          <span className="w-6 h-px bg-zinc-700" />
          <StepTab n={2} label="Sheets & preview" sub={state ? `${state.sheets.length - (settings.exclude?.length ?? 0)} sheets` : ''} on={step === 'workbook'} onClick={leaveDetails} />
        </nav>

        <div className="flex-1" />
        {message && <span className={`text-[11px] ${message.tone === 'ok' ? 'text-emerald-400' : 'text-red-400'} truncate max-w-xs`}>{message.text}</span>}
        <label className="hidden md:flex items-center bg-zinc-950 border border-zinc-800 focus-within:border-amber-accent">
          <input
            aria-label="File name"
            className="bg-transparent outline-none px-2 py-1.5 text-[12px] text-zinc-200 w-56"
            value={settings.filename ?? ''}
            placeholder={exportFilename(ps).replace(/\.xlsx$/, '')}
            onChange={e => save({ filename: e.target.value || undefined })}
          />
          <span className="pr-2 text-[11px] text-zinc-600">.xlsx</span>
        </label>
        <button onClick={download} disabled={busy}
          className="bg-amber-accent hover:bg-[#F7D354] text-zinc-950 px-4 py-2 text-[11px] font-black uppercase tracking-widest inline-flex items-center gap-2 disabled:opacity-60">
          {busy ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} strokeWidth={3} />} Download .xlsx
        </button>
      </header>

      {step === 'details'
        ? <ProjectDetailsStep ps={ps} update={updateProjectMeta} onContinue={leaveDetails} onSkip={leaveDetails} />
        : <WorkbookStep studio={studio} />}
    </div>
  );
}

function StepTab({ n, label, sub, on, onClick }: { n: number; label: string; sub?: string; on: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} className={`flex items-center gap-2 px-2.5 py-1.5 ${on ? 'bg-zinc-800' : 'hover:bg-zinc-900'}`}>
      <span className={`w-5 h-5 flex items-center justify-center text-[10px] font-black ${on ? 'bg-amber-accent text-zinc-950' : 'bg-zinc-800 text-zinc-400'}`}>{n}</span>
      <span className="text-left">
        <span className={`block text-[11px] font-bold ${on ? 'text-zinc-100' : 'text-zinc-400'}`}>{label}</span>
        {sub && <span className="block text-[9px] text-zinc-500 uppercase tracking-widest">{sub}</span>}
      </span>
    </button>
  );
}
