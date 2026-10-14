'use client';

// Step 1 of the export: the details that go on the Summary cover and in every
// sheet's heading. Saved straight into the project; can be skipped.

import React from 'react';
import { Plus, Trash2, Check } from 'lucide-react';
import type { ProjectState, ScopeAssumption, ExcludedItem, Stakeholders } from '@/context/TakeoffContext';
import { CURRENCIES, currencyInfo } from '@/lib/takeoff/currency';

type Meta = Partial<Omit<ProjectState, 'drawings' | 'activeDrawingId' | 'measurements' | 'materials'>>;

interface Props {
  ps: ProjectState;
  update: (m: Meta) => void;
  onContinue: () => void;
  onSkip: () => void;
}

/** Which details are filled in, for the progress bar. */
export function detailsProgress(ps: ProjectState): { done: number; total: number } {
  const checks = [
    ps.projectName, ps.projectNumber, ps.projectLocation, ps.documentTitle, ps.revision, ps.documentDate, ps.currency,
    ps.stakeholders?.client, ps.stakeholders?.mainContractor, ps.stakeholders?.designConsultant,
    (ps.drawingReferences ?? []).filter(Boolean).length ? 'y' : '',
  ];
  return { done: checks.filter(v => !!(v && String(v).trim())).length, total: checks.length };
}

export function ProjectDetailsStep({ ps, update, onContinue, onSkip }: Props) {
  const { done, total } = detailsProgress(ps);
  const st = ps.stakeholders ?? {};
  const setPerson = (k: keyof Stakeholders, v: string) => update({ stakeholders: { ...st, [k]: v || undefined } });
  const refs = ps.drawingReferences ?? [];
  const assumptions = ps.generalAssumptions ?? [];
  const exclusions = ps.excludedItems ?? [];
  const nextId = (list: Array<{ id: number }>) => list.reduce((m, x) => Math.max(m, x.id), 0) + 1;

  return (
    <div className="flex-1 overflow-auto bg-[#0d0d0d]" style={{ scrollbarWidth: 'thin', scrollbarColor: '#2a2a2a transparent' }}>
      <div className="max-w-4xl mx-auto px-6 py-8">
        <div className="flex items-end justify-between gap-6 mb-6">
          <div>
            <div className="text-[10px] text-amber-accent font-bold uppercase tracking-widest mb-1">Step 1 of 2</div>
            <h1 className="text-xl font-black text-zinc-100">Project details for the workbook</h1>
            <p className="text-zinc-500 text-xs mt-1 max-w-xl leading-relaxed">
              These go on the Summary cover and in the heading of every sheet. Everything is optional — fill in what you have, and you can come back to this step at any time.
            </p>
          </div>
          <div className="w-48 shrink-0">
            <div className="flex justify-between text-[10px] uppercase tracking-widest font-bold text-zinc-500 mb-1">
              <span>Filled in</span><span className="text-zinc-300 tabular-nums">{done} / {total}</span>
            </div>
            <div className="h-1.5 bg-zinc-800"><div className="h-full bg-amber-accent transition-all" style={{ width: `${(done / total) * 100}%` }} /></div>
          </div>
        </div>

        <Section title="Document">
          <Field label="Title on the workbook" hint="e.g. D01 — Door schedule, or Bill of quantities" value={ps.documentTitle} onChange={v => update({ documentTitle: v || undefined })} />
          <Field label="Revision" value={ps.revision} onChange={v => update({ revision: v || undefined })} small />
          <Field label="Date" type="date" value={ps.documentDate} onChange={v => update({ documentDate: v || undefined })} small />
        </Section>

        <Section title="Project">
          <Field label="Project name" value={ps.projectName} onChange={v => update({ projectName: v || 'Untitled project' })} />
          <Field label="Project number" value={ps.projectNumber} onChange={v => update({ projectNumber: v })} small />
          <Field label="Location" value={ps.projectLocation} onChange={v => update({ projectLocation: v || undefined })} />
          <Field label="Phase" value={ps.projectPhase} onChange={v => update({ projectPhase: v || undefined })} small />
          <Field label="Type" hint="Unit / door / kitchen type" value={ps.kitchenType} onChange={v => update({ kitchenType: v || undefined })} small />
          <Field label="Number of units" hint="1" type="number" value={ps.totalUnits ? String(ps.totalUnits) : ''}
            onChange={v => { const n = Number(v); update({ totalUnits: Number.isFinite(n) && n > 0 ? n : undefined }); }} small />
        </Section>

        <Section title="Money">
          <label className="block">
            <span className="block text-[10px] uppercase tracking-widest font-bold text-zinc-500 mb-1">Currency</span>
            <select
              className="w-full bg-zinc-950 border border-zinc-800 focus:border-amber-accent outline-none px-3 py-2 text-[13px] text-zinc-100"
              value={ps.currency ?? ''}
              onChange={e => { const info = currencyInfo(e.target.value); update({ currency: e.target.value || undefined, ...(info ? { vatPercent: info.vat } : {}) }); }}
            >
              <option value="">Not set</option>
              {CURRENCIES.map(c => <option key={c.code} value={c.code}>{c.code} — {c.name}</option>)}
            </select>
          </label>
          <Field label="VAT %" type="number" value={ps.vatPercent === undefined ? '' : String(ps.vatPercent)}
            onChange={v => { const n = parseFloat(v); update({ vatPercent: Number.isFinite(n) && n >= 0 ? n : undefined }); }} small />
        </Section>

        <Section title="People">
          <Field label="Client" value={st.client} onChange={v => setPerson('client', v)} />
          <Field label="Main contractor" value={st.mainContractor} onChange={v => setPerson('mainContractor', v)} />
          <Field label="Design consultant" value={st.designConsultant} onChange={v => setPerson('designConsultant', v)} />
          <Field label="Supervision" value={st.supervision} onChange={v => setPerson('supervision', v)} />
          <Field label="Project manager" value={st.projectManager} onChange={v => setPerson('projectManager', v)} />
        </Section>

        <Section title="Drawing references" action={
          <div className="flex gap-2">
            {ps.drawings.length > 0 && (
              <SmallButton onClick={() => update({ drawingReferences: ps.drawings.filter(d => !d.supersededBy).map(d => d.name.replace(/\.pdf$/i, '')) })}>Use drawing names</SmallButton>
            )}
            <SmallButton onClick={() => update({ drawingReferences: [...refs, ''] })}><Plus size={12} /> Add</SmallButton>
          </div>
        } wide>
          {refs.length === 0 && <p className="text-zinc-600 text-xs">None yet. Without references, the Summary lists the drawings in the project.</p>}
          {refs.map((r, i) => (
            <Row key={i} onRemove={() => update({ drawingReferences: refs.filter((_, j) => j !== i) })}>
              <input className={input} placeholder={`Ref ${String(i + 1).padStart(2, '0')} — e.g. A-101 Rev B`} value={r}
                onChange={e => update({ drawingReferences: refs.map((x, j) => (j === i ? e.target.value : x)) })} />
            </Row>
          ))}
        </Section>

        <Section title="General assumptions" action={<SmallButton onClick={() => update({ generalAssumptions: [...assumptions, { id: nextId(assumptions), category: '', content: '' }] })}><Plus size={12} /> Add</SmallButton>} wide>
          {assumptions.length === 0 && <p className="text-zinc-600 text-xs">e.g. “Rates — Supply and fix, ex-VAT”.</p>}
          {assumptions.map((a: ScopeAssumption) => (
            <Row key={a.id} onRemove={() => update({ generalAssumptions: assumptions.filter(x => x.id !== a.id) })}>
              <input className={`${input} w-48 shrink-0`} placeholder="Topic" value={a.category}
                onChange={e => update({ generalAssumptions: assumptions.map(x => (x.id === a.id ? { ...x, category: e.target.value } : x)) })} />
              <input className={input} placeholder="Assumption" value={a.content}
                onChange={e => update({ generalAssumptions: assumptions.map(x => (x.id === a.id ? { ...x, content: e.target.value } : x)) })} />
            </Row>
          ))}
        </Section>

        <Section title="Excluded from scope" action={<SmallButton onClick={() => update({ excludedItems: [...exclusions, { id: nextId(exclusions), item: '', reason: '' }] })}><Plus size={12} /> Add</SmallButton>} wide>
          {exclusions.length === 0 && <p className="text-zinc-600 text-xs">e.g. “Ironmongery — by others”.</p>}
          {exclusions.map((x: ExcludedItem) => (
            <Row key={x.id} onRemove={() => update({ excludedItems: exclusions.filter(y => y.id !== x.id) })}>
              <input className={`${input} w-48 shrink-0`} placeholder="Item" value={x.item}
                onChange={e => update({ excludedItems: exclusions.map(y => (y.id === x.id ? { ...y, item: e.target.value } : y)) })} />
              <input className={input} placeholder="Reason" value={x.reason}
                onChange={e => update({ excludedItems: exclusions.map(y => (y.id === x.id ? { ...y, reason: e.target.value } : y)) })} />
            </Row>
          ))}
        </Section>

        <div className="flex items-center justify-end gap-3 pt-2 pb-10">
          <button onClick={onSkip} className="px-4 py-2 text-[11px] font-black uppercase tracking-widest text-zinc-400 hover:text-zinc-100">Skip for now</button>
          <button onClick={onContinue} className="bg-amber-accent hover:bg-[#F7D354] text-zinc-950 px-5 py-2.5 text-[11px] font-black uppercase tracking-widest inline-flex items-center gap-2">
            <Check size={14} strokeWidth={3} /> Continue to sheets
          </button>
        </div>
      </div>
    </div>
  );
}

const input = 'w-full bg-zinc-950 border border-zinc-800 focus:border-amber-accent outline-none px-3 py-2 text-[13px] text-zinc-100 placeholder:text-zinc-700';

function Section({ title, children, action, wide }: { title: string; children: React.ReactNode; action?: React.ReactNode; wide?: boolean }) {
  return (
    <section className="border border-zinc-800 bg-zinc-900 mb-4">
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-zinc-800">
        <h2 className="text-[10px] text-amber-accent font-bold uppercase tracking-widest">{title}</h2>
        {action}
      </div>
      <div className={wide ? 'p-4 space-y-2' : 'p-4 grid gap-3'} style={wide ? undefined : { gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))' }}>{children}</div>
    </section>
  );
}

function Field({ label, value, onChange, hint, type = 'text', small }: { label: string; value?: string; onChange: (v: string) => void; hint?: string; type?: string; small?: boolean }) {
  return (
    <label className={small ? 'block' : 'block col-span-2'} style={small ? undefined : { gridColumn: 'span 2' }}>
      <span className="block text-[10px] uppercase tracking-widest font-bold text-zinc-500 mb-1">{label}</span>
      <input type={type} className={input} value={value ?? ''} placeholder={hint} onChange={e => onChange(e.target.value)} />
    </label>
  );
}

function Row({ children, onRemove }: { children: React.ReactNode; onRemove: () => void }) {
  return (
    <div className="flex items-center gap-2">
      {children}
      <button onClick={onRemove} aria-label="Remove" className="p-2 text-zinc-600 hover:text-red-400"><Trash2 size={14} /></button>
    </div>
  );
}

function SmallButton({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <button onClick={onClick} className="inline-flex items-center gap-1 border border-zinc-700 hover:border-amber-accent hover:text-amber-accent text-zinc-300 px-2 py-1 text-[10px] font-bold uppercase tracking-widest">
      {children}
    </button>
  );
}
