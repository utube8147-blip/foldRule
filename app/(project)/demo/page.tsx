'use client';

// EXPERIMENTS PAGE (/demo?project=…). Three features on trial, outside the workspace.
// Everything it uses lives in lib/demo, hooks/demo and components/demo: see lib/demo/README.md
// for how to delete the lot.

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, FlaskConical } from 'lucide-react';
import { useTakeoffData } from '@/context/TakeoffContext';
import type { Drawing, TakeoffRow } from '@/types';
import { useDemoPage } from '@/hooks/demo/useDemoPage';
import { TemplatePanel } from '@/components/demo/TemplatePanel';
import { SymbolCountPanel } from '@/components/demo/SymbolCountPanel';
import { RoomsPanel } from '@/components/demo/RoomsPanel';

type Tab = 'count' | 'rooms' | 'template';
const TABS: [Tab, string, string][] = [
  ['count', 'Count symbols', 'Box one door or socket, find the rest'],
  ['rooms', 'Rooms from text', 'Room names and areas printed on the drawing'],
  ['template', 'Project as a template', 'Start a new project from a past one'],
];
const uid = () => crypto.randomUUID();

export default function DemoPage() {
  const { projectState: ps, replaceMeasurements } = useTakeoffData();
  const [projectId, setProjectId] = useState<string | null>(null);
  useEffect(() => { setProjectId(new URLSearchParams(window.location.search).get('project')); }, []);
  const drawings = ps.drawings.filter(d => !d.supersededBy);
  const [tab, setTab] = useState<Tab>('count');
  const [drawingId, setDrawingId] = useState<string>('');
  const [pageNumber, setPageNumber] = useState(1);
  // Any other PDF can be tried here without adding it to the project.
  const [tryFile, setTryFile] = useState<File | null>(null);
  const tryDrawing = React.useMemo(() => (tryFile ? ({ id: 'try', name: tryFile.name, file: tryFile, fileUrl: '', scaleFactor: 1, pageCount: 1 } as Drawing) : null), [tryFile]);
  const drawing = tryDrawing ?? drawings.find(d => d.id === drawingId) ?? drawings[0];
  const page = useDemoPage(tab === 'template' ? undefined : drawing, pageNumber);
  const q = projectId ? `?project=${projectId}` : '';

  const base = (o: Partial<TakeoffRow>): TakeoffRow => ({
    id: uid(), drawingId: drawing?.id ?? '', pageNumber, description: '', type: 'Count', quantity: 0, unit: 'EA', unitRate: 0, notes: '',
    points: [], isOverridden: false, childIds: [], color: '#34D399', isVisible: true, ...o,
  } as TakeoffRow);

  const addCount = (points: { x: number; y: number }[], name: string) =>
    replaceMeasurements([], [base({ description: name, label: name, type: 'Count', quantity: points.length, unit: 'EA', points, notes: 'Counted by symbol match (experiment)' })]);

  const addRooms = (rooms: { name: string; area: number; x: number; y: number }[]) => {
    const header = base({ id: uid(), isGroupHeader: true, description: 'Rooms (as stated on the drawing)', label: 'Rooms (as stated on the drawing)', type: 'Area', unit: 'm²', color: '#F2C230' });
    const rows = rooms.map(r => base({ description: r.name, label: r.name, type: 'Area', unit: 'm²', quantity: r.area, isOverridden: true, parentId: header.id, groupName: header.description, notes: 'Area as printed on the drawing, not measured (experiment)', color: '#F2C230' }));
    header.childIds = rows.map(r => r.id);
    header.quantity = rows.reduce((s, r) => s + r.quantity, 0);
    replaceMeasurements([], [header, ...rows]);
  };

  return (
    <div className="min-h-screen bg-[#0d0d0d] text-zinc-200 font-mono">
      <header className="h-14 px-6 flex items-center gap-4 border-b border-zinc-800 bg-zinc-950">
        <Link href={`/takeoff-full${q}`} className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-widest text-zinc-400 hover:text-amber-accent"><ArrowLeft className="w-3.5 h-3.5" /> Summary</Link>
        <FlaskConical className="w-4 h-4 text-amber-accent" />
        <h1 className="text-sm font-black uppercase tracking-widest text-amber-accent">Experiments</h1>
        <span className="text-[11px] text-zinc-500 truncate">{ps.projectName} · on trial, not part of the workspace yet</span>
      </header>
      <div className="px-6 pt-4 flex flex-wrap items-end gap-4 border-b border-zinc-800">
        <div role="tablist" className="flex">
          {TABS.map(([k, label, hint]) => (
            <button key={k} role="tab" aria-selected={tab === k} title={hint} onClick={() => setTab(k)}
              className={`px-4 py-2.5 text-[11px] font-bold uppercase tracking-widest border-b-2 ${tab === k ? 'text-amber-accent border-amber-accent' : 'text-zinc-500 border-transparent hover:text-zinc-300'}`}>{label}</button>
          ))}
        </div>
        {tab !== 'template' && (
          <div className="ml-auto flex items-center gap-2 pb-2 text-xs">
            <select aria-label="Drawing" value={tryFile ? 'try' : drawing?.id ?? ''} onChange={e => { setTryFile(null); setDrawingId(e.target.value); setPageNumber(1); }} className="bg-zinc-950 border border-zinc-700 px-2 py-1.5 text-zinc-100 max-w-[260px]">
              {tryFile && <option value="try">{tryFile.name} (trying, not in the project)</option>}
              {drawings.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
            <label className="px-2 py-1.5 border border-zinc-700 text-[11px] font-bold uppercase tracking-widest text-zinc-300 hover:border-amber-accent hover:text-amber-accent cursor-pointer" title="Try the experiments on any PDF. It is not added to the project.">
              Open another PDF
              <input type="file" accept="application/pdf,.pdf" aria-label="Open another PDF" className="hidden" onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) { setTryFile(f); setPageNumber(1); } }} />
            </label>
            <span className="text-zinc-500">page</span>
            <input type="number" aria-label="Page" min={1} max={page.pages || 1} value={pageNumber} onChange={e => setPageNumber(Math.max(1, Math.min(page.pages || 1, parseInt(e.target.value) || 1)))} className="w-14 bg-zinc-950 border border-zinc-700 px-2 py-1.5 text-zinc-100" />
            <span className="text-zinc-600">of {page.pages || '…'}</span>
          </div>
        )}
      </div>
      <main className="p-6">
        {tab === 'template' ? <TemplatePanel currentId={projectId} />
          : !drawing ? <p className="text-xs text-zinc-500">This project has no drawing yet. Use “Open another PDF” to try one, or add a drawing in the workspace.</p>
          : page.status === 'error' ? <p role="alert" className="text-xs text-red-400">{page.error}</p>
          : page.status !== 'ready' ? <p className="text-xs text-zinc-500">Opening the page…</p>
          : tab === 'count' ? <SymbolCountPanel key={`${drawing?.id}:${pageNumber}`} page={page} onAdd={tryFile ? undefined : addCount} />
          : <RoomsPanel key={`${drawing?.id}:${pageNumber}`} page={page} onAdd={tryFile ? undefined : addRooms} />}
      </main>
    </div>
  );
}
