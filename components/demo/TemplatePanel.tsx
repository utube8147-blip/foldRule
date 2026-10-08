'use client';

// EXPERIMENT 1 UI: start a new project from a past one.

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { listProjects, getProject, createProject, saveProjectState, emptyProjectState, type ProjectSummary } from '@/lib/storage/projectDb';
import { pushProjectToFolder } from '@/lib/storage/folderSync';
import { templateFromProject, summariseTemplate, type TemplateSummary } from '@/lib/demo/template';
import type { ProjectState } from '@/context/TakeoffContext';

export function TemplatePanel({ currentId }: { currentId: string | null }) {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [from, setFrom] = useState<string>(currentId ?? '');
  const [summary, setSummary] = useState<TemplateSummary | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [made, setMade] = useState<{ id: string; name: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { void listProjects().then(p => setProjects([...p].sort((a, b) => b.updatedAt - a.updatedAt))).catch(() => setError('Your projects could not be listed.')); }, [made]);
  useEffect(() => {
    setSummary(null);
    if (!from) return;
    let off = false;
    void getProject(from).then(r => { if (!off && r) setSummary(summariseTemplate(r.state)); });
    return () => { off = true; };
  }, [from]);

  const create = async () => {
    setBusy(true); setError(null);
    try {
      const src = await getProject(from);
      if (!src) throw new Error('That project could not be opened.');
      const rec = await createProject(name.trim() || `${src.name} (copy of setup)`);
      await saveProjectState(rec.id, templateFromProject(src.state, emptyProjectState(rec.name, rec.number)) as unknown as ProjectState);
      await pushProjectToFolder(rec.id).catch(() => {});
      setMade({ id: rec.id, name: rec.name }); setName('');
    } catch (e) { setError(e instanceof Error ? e.message : 'The project could not be created.'); }
    setBusy(false);
  };

  const field = 'w-full bg-zinc-950 border border-zinc-700 px-3 py-2 text-xs text-zinc-100 outline-none focus:border-amber-accent';
  return (
    <div className="max-w-2xl space-y-5 text-xs">
      <p className="text-zinc-400 leading-relaxed">
        Start a new project with the setup of an old one. The <b className="text-zinc-200">groups</b> come across empty but already carrying their material and rate, with the
        <b className="text-zinc-200"> price list, markups, currency, VAT and notes</b>. Measurements, drawings, revisions and the change log stay behind. The old project is not changed.
      </p>
      <label className="block">
        <span className="block mb-1 text-[10px] uppercase tracking-widest text-zinc-500">Copy the setup of</span>
        <select aria-label="Project to copy from" value={from} onChange={e => { setFrom(e.target.value); setMade(null); }} className={field}>
          <option value="">Choose a project…</option>
          {projects.map(p => <option key={p.id} value={p.id}>{p.name}{p.id === currentId ? ' (this project)' : ''} · {p.measurementCount} measurements</option>)}
        </select>
      </label>
      {summary && (
        <ul className="grid grid-cols-2 gap-2">
          {[
            ['Groups carried over', String(summary.groups)],
            ['Materials in use', String(summary.materialsUsed)],
            ['Markups', summary.hasMarkups ? 'yes' : 'none set'],
            ['Currency and VAT', summary.currency ? `${summary.currency}${summary.vatPercent !== undefined ? ` · ${summary.vatPercent}%` : ''}` : 'not set'],
          ].map(([k, v]) => (
            <li key={k} className="border border-zinc-800 bg-zinc-900 px-3 py-2">
              <span className="block text-[10px] uppercase tracking-widest text-zinc-500">{k}</span>
              <span className="text-sm font-bold text-zinc-100">{v}</span>
            </li>
          ))}
        </ul>
      )}
      <label className="block">
        <span className="block mb-1 text-[10px] uppercase tracking-widest text-zinc-500">Name of the new project</span>
        <input aria-label="New project name" value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Villa B" maxLength={120} className={field} />
      </label>
      <button type="button" disabled={!from || busy || (summary?.groups ?? 0) === 0 && (summary?.materialsUsed ?? 0) === 0} onClick={() => void create()}
        className="px-4 py-2 bg-amber-accent text-black text-[11px] font-bold uppercase tracking-widest hover:bg-amber-400 disabled:opacity-40">
        {busy ? 'Creating…' : 'Create the new project'}
      </button>
      {summary && summary.groups === 0 && summary.materialsUsed === 0 && <p className="text-zinc-500">That project has no groups or materials to hand on.</p>}
      {error && <p role="alert" className="text-red-400">{error}</p>}
      {made && (
        <p role="status" className="border border-emerald-700/60 bg-emerald-500/5 px-3 py-2 text-emerald-300">
          “{made.name}” was created. <Link href={`/workspace?project=${made.id}`} className="underline underline-offset-2 text-emerald-200 hover:text-white">Open it</Link> and add its drawing.
        </p>
      )}
    </div>
  );
}
