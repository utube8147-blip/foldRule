'use client';

// Step 2 of the export: choose sheets and colours, look at and edit the workbook
// exactly as it will be saved, then download.

import React, { useMemo, useState } from 'react';
import { AlertTriangle, Check, Eye, EyeOff, RotateCcw, Loader2 } from 'lucide-react';
import { excelMoneyFormat } from '@/lib/takeoff/currency';
import { THEME_PRESETS, THEME_FONTS, presetColors, type ThemeColors } from '@/lib/export/theme';
import type { CellEdit } from '@/lib/export/studio/edits';
import { SheetGrid } from './SheetGrid';
import type { Studio } from './useStudio';

const ROLES: Array<{ key: keyof ThemeColors; label: string }> = [
  { key: 'primary', label: 'Title bars' },
  { key: 'secondary', label: 'Headers' },
  { key: 'accent', label: 'Accent' },
  { key: 'group', label: 'Group rows' },
  { key: 'quantity', label: 'Quantities' },
  { key: 'input', label: 'Inputs to fill' },
];

export function WorkbookStep({ studio }: { studio: Studio }) {
  const { state, settings, save, building, error } = studio;
  const [current, setCurrent] = useState<string>('Summary');
  const [jump, setJump] = useState<{ addr: string; n: number } | undefined>();
  const exclude = useMemo(() => new Set(settings.exclude ?? []), [settings.exclude]);
  const sheets = state?.sheets ?? [];
  const sheet = sheets.find(s => s.name === current) ?? sheets[0];
  const included = sheets.filter(s => !exclude.has(s.name)).length;
  const theme = settings.theme ?? {};
  const colors: ThemeColors = { ...presetColors(theme.preset), ...(theme.colors ?? {}) };

  const toggleSheet = (name: string) => {
    const next = new Set(exclude);
    if (next.has(name)) next.delete(name);
    else { if (included <= 1) return; next.add(name); }
    save({ exclude: [...next] });
  };
  const goTo = (e: CellEdit) => { setCurrent(e.sheet); setJump(j => ({ addr: e.addr, n: (j?.n ?? 0) + 1 })); };
  const edited = useMemo(() => new Set((state?.applied ?? []).filter(e => e.sheet === sheet?.name).map(e => e.addr)), [state, sheet]);

  if (error) return <Centered><AlertTriangle className="text-red-400 mb-2" />Could not build the workbook: {error}</Centered>;
  if (!state || !sheet) return <Centered><Loader2 className="animate-spin text-amber-accent mb-2" />Building the workbook…</Centered>;

  return (
    <div className="flex-1 min-h-0 flex">
      {/* ── Side panel ─────────────────────────────────────────────────────── */}
      <aside className="w-72 shrink-0 border-r border-zinc-800 bg-zinc-900 overflow-y-auto" style={{ scrollbarWidth: 'thin', scrollbarColor: '#2a2a2a transparent' }}>
        <Panel title="Sheets in the file" note={`${included} of ${sheets.length}`}>
          <ul className="space-y-0.5">
            {sheets.map(s => {
              const on = !exclude.has(s.name);
              return (
                <li key={s.name} className={`flex items-center gap-2 px-2 py-1.5 cursor-pointer ${s.name === sheet.name ? 'bg-zinc-800' : 'hover:bg-zinc-800/60'}`} onClick={() => setCurrent(s.name)}>
                  <button
                    aria-label={on ? `Leave out ${s.name}` : `Include ${s.name}`}
                    onClick={e => { e.stopPropagation(); toggleSheet(s.name); }}
                    className={`w-4 h-4 shrink-0 border flex items-center justify-center ${on ? 'bg-amber-accent border-amber-accent' : 'border-zinc-600'}`}
                  >{on && <Check size={11} strokeWidth={4} className="text-zinc-950" />}</button>
                  <span className="w-1.5 h-4 shrink-0" style={{ background: s.tab ?? '#555' }} />
                  <span className={`text-[12px] truncate ${on ? 'text-zinc-200' : 'text-zinc-600 line-through'}`}>{s.name}</span>
                </li>
              );
            })}
          </ul>
          <p className="text-[10px] text-zinc-600 mt-2 leading-relaxed">Links from an included sheet into a left-out one are saved as plain values, so nothing shows #REF!.</p>
        </Panel>

        <Panel title="Colours" note={building ? 'updating…' : undefined}>
          <div className="grid grid-cols-2 gap-1.5 mb-3">
            {THEME_PRESETS.map(p => {
              const on = (theme.preset ?? 'navy-gold') === p.id && !Object.keys(theme.colors ?? {}).length;
              return (
                <button key={p.id} onClick={() => save({ theme: { ...theme, preset: p.id, colors: undefined } })}
                  className={`border px-2 py-1.5 text-left ${on ? 'border-amber-accent' : 'border-zinc-800 hover:border-zinc-600'}`}>
                  <div className="flex h-3 mb-1">
                    {[p.colors.primary, p.colors.secondary, p.colors.accent, p.colors.group].map((c, i) => <span key={i} className="flex-1" style={{ background: c }} />)}
                  </div>
                  <span className="text-[10px] text-zinc-300">{p.name}</span>
                </button>
              );
            })}
          </div>
          <div className="space-y-1.5">
            {ROLES.map(r => (
              <label key={r.key} className="flex items-center justify-between gap-2 text-[11px] text-zinc-400">
                <span>{r.label}</span>
                <span className="flex items-center gap-1.5">
                  <span className="font-mono text-[10px] text-zinc-600">{colors[r.key].toUpperCase()}</span>
                  <input type="color" className="w-7 h-5 bg-transparent border border-zinc-700 cursor-pointer" value={colors[r.key]}
                    onChange={e => save({ theme: { ...theme, colors: { ...(theme.colors ?? {}), [r.key]: e.target.value.toUpperCase() } } })} />
                </span>
              </label>
            ))}
          </div>
          <label className="flex items-center justify-between gap-2 text-[11px] text-zinc-400 mt-3">
            <span>Font</span>
            <select className="bg-zinc-950 border border-zinc-800 text-zinc-200 text-[11px] px-1 py-0.5" value={theme.font ?? 'Calibri'}
              onChange={e => save({ theme: { ...theme, font: e.target.value } })}>
              {THEME_FONTS.map(f => <option key={f}>{f}</option>)}
            </select>
          </label>
          {(theme.colors || theme.font || (theme.preset && theme.preset !== 'navy-gold')) && (
            <button onClick={() => save({ theme: undefined })} className="mt-3 inline-flex items-center gap-1 text-[10px] uppercase tracking-widest font-bold text-zinc-500 hover:text-amber-accent">
              <RotateCcw size={11} /> Original colours
            </button>
          )}
        </Panel>

        <Panel title="Your changes" note={state.applied.length ? `${state.applied.length} cell${state.applied.length === 1 ? '' : 's'}` : undefined}>
          {state.stale.length > 0 && (
            <div className="border border-amber-700/60 bg-amber-950/30 p-2 mb-3">
              <div className="flex items-center gap-1.5 text-[11px] font-bold text-amber-300 mb-1"><AlertTriangle size={12} /> {state.stale.length} change{state.stale.length === 1 ? '' : 's'} on hold</div>
              <p className="text-[10px] text-amber-200/70 leading-relaxed mb-2">The takeoff changed since these were made, so the cell may now hold a different item. Check each one.</p>
              <ul className="space-y-1.5">
                {state.stale.map(e => (
                  <li key={`${e.sheet}!${e.addr}`} className="text-[11px]">
                    <div className="text-zinc-300 truncate"><span className="font-mono">{e.sheet}!{e.addr}</span> → {e.input !== undefined ? <b>{e.input || '(empty)'}</b> : 'formatting'}</div>
                    <div className="text-zinc-500 truncate">was “{e.was || 'empty'}” when changed</div>
                    <div className="flex gap-3 mt-0.5">
                      <button className="text-amber-accent hover:underline" onClick={() => studio.forceEdit(e)}>Apply anyway</button>
                      <button className="text-zinc-400 hover:underline" onClick={() => studio.dropEdit(e)}>Discard</button>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {state.applied.length === 0 && !state.stale.length && (
            <p className="text-[11px] text-zinc-500 leading-relaxed">Click any cell and type to change it — a rate, a description, a percentage or a formula. Changes are saved with the project and go into every export.</p>
          )}
          <ul className="space-y-0.5 max-h-56 overflow-y-auto">
            {state.applied.map(e => (
              <li key={`${e.sheet}!${e.addr}`}>
                <button onClick={() => goTo(e)} className="w-full text-left px-1.5 py-1 hover:bg-zinc-800 text-[11px] flex gap-2">
                  <span className="font-mono text-zinc-500 shrink-0">{abbrev(e.sheet)}!{e.addr}</span>
                  <span className="text-zinc-300 truncate">{e.input !== undefined ? (e.input || '(cleared)') : ''}{e.style ? <span className="text-zinc-500">{e.input !== undefined ? ' + ' : ''}format</span> : null}</span>
                </button>
              </li>
            ))}
          </ul>
          {state.applied.length > 0 && (
            <button onClick={studio.resetEdits} className="mt-2 inline-flex items-center gap-1 text-[10px] uppercase tracking-widest font-bold text-zinc-500 hover:text-red-400">
              <RotateCcw size={11} /> Undo all changes
            </button>
          )}
        </Panel>
      </aside>

      {/* ── Sheet ──────────────────────────────────────────────────────────── */}
      <section className="flex-1 min-w-0 flex flex-col">
        {exclude.has(sheet.name) && (
          <div className="flex items-center gap-3 px-3 py-1.5 bg-zinc-800 text-[11px] text-zinc-300 border-b border-zinc-700">
            <EyeOff size={13} className="text-zinc-500" /> This sheet is left out of the file.
            <button onClick={() => toggleSheet(sheet.name)} className="text-amber-accent font-bold hover:underline inline-flex items-center gap-1"><Eye size={12} /> Include it</button>
          </div>
        )}
        <div className={`flex-1 min-h-0 relative ${building ? 'opacity-80' : ''}`}>
          <SheetGrid
            key={sheet.name}
            sheet={sheet}
            values={state.values}
            edited={edited}
            money={excelMoneyFormat(studio.ps.currency)}
            onCells={entries => studio.setCells(sheet.name, entries)}
            onStyle={(addrs, style) => studio.setStyle(sheet.name, addrs, style)}
            onClearStyle={addrs => studio.clearStyle(sheet.name, addrs)}
            onRevert={addrs => studio.revertCells(sheet.name, addrs)}
            undo={studio.undo} redo={studio.redo} canUndo={studio.canUndo} canRedo={studio.canRedo}
            jump={jump && jump.addr ? jump : undefined}
          />
        </div>
        {/* Sheet tabs, as in Excel */}
        <div className="flex items-end gap-px px-2 bg-[#E9EBEE] border-t border-zinc-300 overflow-x-auto" style={{ scrollbarWidth: 'thin' }}>
          {sheets.map(s => {
            const on = s.name === sheet.name, out = exclude.has(s.name);
            return (
              <button key={s.name} onClick={() => setCurrent(s.name)}
                className={`px-3 py-1 text-[12px] whitespace-nowrap border-x border-b-[3px] ${on ? 'bg-white text-zinc-900 font-semibold border-zinc-300' : 'bg-[#E9EBEE] text-zinc-600 hover:bg-zinc-100 border-transparent'} ${out ? 'line-through opacity-50' : ''}`}
                style={{ borderBottomColor: s.tab ?? 'transparent' }}
              >{s.name}</button>
            );
          })}
        </div>
      </section>
    </div>
  );
}

const abbrev = (name: string) => (name.length > 12 ? name.split(/[\s_]/).map(w => w[0]).join('') : name);

function Panel({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <div className="border-b border-zinc-800 p-3">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-[10px] text-amber-accent font-bold uppercase tracking-widest">{title}</h3>
        {note && <span className="text-[10px] text-zinc-500">{note}</span>}
      </div>
      {children}
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="flex-1 flex flex-col items-center justify-center text-sm text-zinc-400 bg-[#0d0d0d]">{children}</div>;
}
