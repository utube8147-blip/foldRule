'use client';
// Top-left of the drawing while a measuring tool is active: what the shapes
// you draw are being added to, and a way to change it.

import React, { useEffect, useRef, useState } from 'react';
import { ChevronDown, Layers, Plus } from 'lucide-react';
import type { ActiveItemApi } from '@/hooks/shapes/useActiveItem';

const EXAMPLE = { area: 'Tile – 1st floor', length: 'Skirting – 1st floor', count: 'Doors – 1st floor' } as const;
const fmt = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 2 });

export function ActiveItemBar({ api, hidden, nudge = 0, onLeave }: {
  api: ActiveItemApi; hidden?: boolean;
  /** Goes up each time the user tries to draw before naming — the box flashes. */
  nudge?: number;
  /** Esc on the first question: leave the tool (skipping must be chosen on purpose). */
  onLeave?: () => void;
}) {
  const [name, setName] = useState('');
  const [menu, setMenu] = useState(false);
  const [naming, setNaming] = useState(false);      // "New item…" picked from the menu
  const inputRef = useRef<HTMLInputElement>(null);
  const asking = api.needsName || naming;

  useEffect(() => { if (asking) { setName(''); const t = setTimeout(() => inputRef.current?.focus(), 30); return () => clearTimeout(t); } }, [asking, api.kind]);
  useEffect(() => { setMenu(false); setNaming(false); }, [api.kind]);
  // Tried to draw before answering → the box flashes and takes the typing cursor back.
  useEffect(() => { if (nudge > 0) { const t = setTimeout(() => inputRef.current?.focus(), 40); return () => clearTimeout(t); } }, [nudge]);

  if (!api.kind || hidden) return null;
  const stop = { onPointerDown: (e: React.PointerEvent) => e.stopPropagation(), onClick: (e: React.MouseEvent) => e.stopPropagation() };

  return (
    <div className="absolute top-16 left-3 z-[72] max-w-[min(30rem,80%)]" {...stop}>
      {asking ? (
        <form
          key={nudge}
          className={`bg-zinc-900 border-2 border-amber-400 shadow-2xl p-3 space-y-2 ${nudge > 0 ? 'animate-[itemnudge_0.45s_ease-in-out]' : ''}`}
          onSubmit={e => { e.preventDefault(); if (name.trim()) { api.start(name); setNaming(false); } }}
          onKeyDown={e => {
            e.stopPropagation();                         // typing here must not trigger tool shortcuts
            if (e.key === 'Escape') { e.preventDefault(); if (naming) setNaming(false); else onLeave?.(); }
          }}
        >
          <label htmlFor="active-item-name" className="block text-[10px] font-mono uppercase tracking-widest text-amber-400">
            What are you measuring? ({api.what})
          </label>
          <div className="flex gap-2">
            <input
              id="active-item-name" ref={inputRef} value={name} onChange={e => setName(e.target.value)}
              placeholder={`e.g. ${EXAMPLE[api.kind]}`}
              className="flex-1 min-w-0 w-64 bg-zinc-800 border border-zinc-600 px-2 py-1.5 text-sm text-zinc-100 focus:outline-none focus:border-amber-400"
            />
            <button type="submit" disabled={!name.trim()}
              className="text-[10px] font-mono font-bold uppercase tracking-widest px-3 bg-amber-400 text-black hover:bg-amber-300 disabled:opacity-40">Start</button>
          </div>
          <p className="text-[11px] text-zinc-400 leading-snug">
            Everything you draw next is added to it and totalled, until you pick another item.
          </p>
          {nudge > 0 && !naming && (
            <p role="alert" className="text-[11px] text-amber-300 font-semibold">Name it first — or choose “Skip” below — then you can measure.</p>
          )}
          <div className="flex flex-wrap gap-1.5 items-center">
            {api.existing.slice(0, 4).map(g => (
              <button key={g.id} type="button" onClick={() => { api.use(g.id); setNaming(false); }}
                className="text-[11px] px-2 py-1 border border-zinc-600 text-zinc-200 hover:border-amber-400 truncate max-w-[12rem]">
                Continue “{g.name}”
              </button>
            ))}
            <button type="button" onClick={() => { setNaming(false); api.clear('none'); }}
              className="text-[11px] text-zinc-400 underline hover:text-zinc-200 ml-auto">Skip — name each shape as I go</button>
          </div>
        </form>
      ) : api.item ? (
        <div className="relative">
          <button
            onClick={() => setMenu(m => !m)} aria-haspopup="menu" aria-expanded={menu}
            title="Shapes you draw are added to this item. Click to change."
            className="flex items-center gap-2 bg-zinc-900 border border-zinc-600 hover:border-amber-400 shadow-xl px-2.5 py-1.5 max-w-full"
          >
            <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: api.item.color }} />
            <span className="text-[10px] font-mono uppercase tracking-widest text-zinc-500 shrink-0">Adding to</span>
            <span className="text-xs text-zinc-100 font-semibold truncate">{api.item.name}</span>
            <span className="text-[11px] text-amber-300 font-mono whitespace-nowrap">
              {api.header ? `${fmt(api.header.quantity)} ${api.header.unit} · ${api.header.childIds?.length ?? 0}` : 'empty'}
            </span>
            <ChevronDown className="w-3.5 h-3.5 text-zinc-400 shrink-0" />
          </button>
          {menu && (
            <div role="menu" className="absolute top-full left-0 mt-1 min-w-[16rem] max-h-72 overflow-y-auto custom-scrollbar bg-zinc-900 border border-zinc-600 shadow-2xl py-1">
              <button role="menuitem" onClick={() => { setMenu(false); setNaming(true); }}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-amber-300 hover:bg-zinc-800">
                <Plus className="w-3.5 h-3.5" /> New item…
              </button>
              {api.existing.filter(g => g.id !== api.item!.id).map(g => (
                <button key={g.id} role="menuitem" onClick={() => { setMenu(false); api.use(g.id); }}
                  className="w-full flex items-center justify-between gap-3 px-3 py-1.5 text-xs text-zinc-100 hover:bg-zinc-800">
                  <span className="truncate">{g.name}</span>
                  <span className="text-[11px] text-zinc-500 font-mono whitespace-nowrap">{fmt(g.quantity)} {g.unit}</span>
                </button>
              ))}
              <button role="menuitem" onClick={() => { setMenu(false); api.clear('none'); }}
                className="w-full text-left px-3 py-1.5 text-xs text-zinc-400 hover:bg-zinc-800 border-t border-zinc-700 mt-1">
                No item — name each shape separately
              </button>
            </div>
          )}
        </div>
      ) : (
        <button onClick={() => api.clear('ask')}
          className="flex items-center gap-2 bg-zinc-900/90 border border-zinc-700 hover:border-amber-400 text-[11px] text-zinc-400 px-2.5 py-1.5">
          <Layers className="w-3.5 h-3.5" /> Add shapes to a named item…
        </button>
      )}
    </div>
  );
}
