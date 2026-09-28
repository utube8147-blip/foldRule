'use client';

// ─── components/common/MaterialPicker.tsx ────────────────────────────────────
//
//  Searchable material picker (combobox). Type to filter by name, code or
//  division; ↑/↓ to move, Enter to pick, Esc to close. Shows each item's rate
//  per unit, or "Set rate" when it has none (still selectable).
//
//  The list is portalled to <body> with fixed positioning, so it's never
//  clipped by scrolling panels, opens upward when there's no room below, and
//  keeps a margin from the screen edges.
// ─────────────────────────────────────────────────────────────────────────────

import React, { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, Library, Search, X } from 'lucide-react';
import type { Material } from '@/types';
import { cn, formatCurrency } from '@/lib/utils';
import { groupMaterialsByDivision } from '@/data/materials';

export const materialRate = (m: Material) =>
  (m.materialCost ?? 0) + (m.laborCost ?? 0) + (m.equipmentCost ?? 0) || m.unitRate || 0;

interface MaterialPickerProps {
  materials:   Material[];
  value:       string | null | undefined;
  onChange:    (id: string | null) => void;
  /** Shown as an action at the bottom of the list. */
  onOpenBank?: () => void;
  /** Open the list immediately (e.g. when used as an inline editor). */
  autoOpen?:   boolean;
  /** Called when the list closes (pick, Esc or click outside). */
  onClose?:    () => void;
  size?:       'md' | 'sm';
  id?:         string;
  className?:  string;
}

type Row =
  | { kind: 'header'; label: string }
  | { kind: 'none' }
  | { kind: 'item'; m: Material };

const MAX_LIST_H = 320;
const EDGE = 12;

function Highlight({ text, query }: { text: string; query: string }) {
  if (!query) return <>{text}</>;
  const i = text.toLowerCase().indexOf(query.toLowerCase());
  if (i < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, i)}
      <mark className="bg-amber-400/25 text-amber-200 rounded-[2px]">{text.slice(i, i + query.length)}</mark>
      {text.slice(i + query.length)}
    </>
  );
}

export function MaterialPicker({
  materials, value, onChange, onOpenBank, autoOpen = false, onClose, size = 'md', id, className,
}: MaterialPickerProps) {
  const listId   = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const wrapRef  = useRef<HTMLDivElement>(null);
  const listRef  = useRef<HTMLDivElement>(null);
  const [open,   setOpen]   = useState(false);
  const [query,  setQuery]  = useState('');
  const [active, setActive] = useState(0);
  const [pos,    setPos]    = useState<{ left: number; top: number; width: number; maxH: number; up: boolean } | null>(null);

  const selected = useMemo(() => materials.find(m => m.id === value) ?? null, [materials, value]);

  // ── Filtering (memoised; ~250 items is cheap) ──────────────────────────────
  const { rows, options } = useMemo(() => {
    const q = query.trim().toLowerCase();
    const match = (m: Material) =>
      !q || m.name.toLowerCase().includes(q) || (m.code || '').toLowerCase().includes(q) ||
      (m.category || '').toLowerCase().includes(q);
    const out: Row[] = [];
    const opts: (Material | null)[] = [];
    if (!q) { out.push({ kind: 'none' }); opts.push(null); }
    for (const g of groupMaterialsByDivision(materials.filter(match))) {
      out.push({ kind: 'header', label: g.label });
      for (const m of g.items) { out.push({ kind: 'item', m }); opts.push(m); }
    }
    return { rows: out, options: opts };
  }, [materials, query]);

  // ── Open / close ───────────────────────────────────────────────────────────
  const openList = useCallback(() => {
    setQuery('');
    setOpen(true);
  }, []);

  const closeList = useCallback(() => {
    setOpen(false);
    setQuery('');
    onClose?.();
  }, [onClose]);

  const pick = useCallback((m: Material | null) => {
    onChange(m ? m.id : null);
    setOpen(false);
    setQuery('');
    onClose?.();
  }, [onChange, onClose]);

  useEffect(() => {
    if (autoOpen) { openList(); requestAnimationFrame(() => inputRef.current?.focus()); }
  }, [autoOpen, openList]);

  // Start on the current value (or the first match while typing).
  useEffect(() => {
    if (!open) return;
    const idx = query ? 0 : Math.max(0, options.findIndex(o => (o?.id ?? null) === (value ?? null)));
    setActive(idx);
  }, [open, query, options, value]);

  // ── Position: below the field, or above if there's no room ────────────────
  const place = useCallback(() => {
    const el = wrapRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const below = window.innerHeight - r.bottom - EDGE;
    const above = r.top - EDGE;
    const up = below < 220 && above > below;
    const FOOTER = 40; // the hint / material-bank row under the list
    const maxH = Math.max(140, Math.min(MAX_LIST_H, (up ? above : below) - 6 - FOOTER));
    const width = Math.max(r.width, 320);
    const left = Math.min(Math.max(EDGE, r.left), window.innerWidth - width - EDGE);
    setPos({ left, top: up ? r.top - 6 : r.bottom + 6, width, maxH, up });
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    place();
    const onMove = () => place();
    window.addEventListener('resize', onMove);
    window.addEventListener('scroll', onMove, true);
    return () => { window.removeEventListener('resize', onMove); window.removeEventListener('scroll', onMove, true); };
  }, [open, place]);

  // Close on outside pointer-down.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (wrapRef.current?.contains(t) || listRef.current?.contains(t)) return;
      closeList();
    };
    window.addEventListener('pointerdown', onDown, true);
    return () => window.removeEventListener('pointerdown', onDown, true);
  }, [open, closeList]);

  // Keep the active option in view.
  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector<HTMLElement>(`[data-opt="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active, open]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!open && (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault(); openList(); return;
    }
    if (!open) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(i => Math.min(options.length - 1, i + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(i => Math.max(0, i - 1)); }
    else if (e.key === 'Home') { e.preventDefault(); setActive(0); }
    else if (e.key === 'End') { e.preventDefault(); setActive(options.length - 1); }
    else if (e.key === 'Enter') { e.preventDefault(); if (options.length) pick(options[active] ?? null); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeList(); }
    else if (e.key === 'Tab') { closeList(); }
  };

  const selectedLabel = selected ? selected.name : '';
  const selectedRate  = selected ? materialRate(selected) : 0;
  const h = size === 'sm' ? 'h-8 text-[11px]' : 'h-10 text-sm';

  let optIndex = -1;

  return (
    <div ref={wrapRef} className={cn('relative', className)}>
      <div
        className={cn(
          'flex items-center gap-2 bg-zinc-800 border px-3 transition-colors cursor-text',
          open ? 'border-amber-400' : 'border-industrial-border hover:border-zinc-500',
          h,
        )}
        onClick={() => { if (!open) openList(); inputRef.current?.focus(); }}
      >
        {open ? <Search className="w-3.5 h-3.5 text-zinc-500 shrink-0" aria-hidden /> : null}
        <input
          ref={inputRef}
          id={id}
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={open && options.length ? `${listId}-opt-${active}` : undefined}
          value={open ? query : selectedLabel}
          placeholder={open ? 'Type to search materials…' : 'No material'}
          onChange={e => { if (!open) setOpen(true); setQuery(e.target.value); }}
          onFocus={() => { if (!open && !autoOpen) openList(); }}
          onKeyDown={onKeyDown}
          className="flex-1 min-w-0 bg-transparent outline-none font-mono text-zinc-200 placeholder:text-zinc-500"
          autoComplete="off"
          spellCheck={false}
        />
        {!open && selected && (
          <span className={cn('shrink-0 font-mono text-[10px]', selectedRate ? 'text-amber-400' : 'text-zinc-500')}>
            {selectedRate ? `${formatCurrency(selectedRate)}/${selected.unit}` : 'no rate'}
          </span>
        )}
        {!open && selected && (
          <button
            type="button"
            onClick={e => { e.stopPropagation(); pick(null); }}
            aria-label="Clear material"
            title="Clear material"
            className="shrink-0 text-zinc-500 hover:text-zinc-200"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        )}
        <ChevronDown className={cn('w-3.5 h-3.5 text-zinc-500 shrink-0 transition-transform', open && 'rotate-180')} aria-hidden />
      </div>

      {open && pos && createPortal(
        <div
          ref={listRef}
          style={{
            position: 'fixed', left: pos.left, width: pos.width,
            ...(pos.up ? { bottom: window.innerHeight - pos.top } : { top: pos.top }),
          }}
          className="z-[150] bg-industrial-panel border border-industrial-border shadow-2xl font-mono flex flex-col"
          onMouseDown={e => e.preventDefault() /* keep focus in the search box */}
        >
          <div id={listId} role="listbox" aria-label="Materials" style={{ maxHeight: pos.maxH }} className="overflow-y-auto custom-scrollbar py-1">
            {options.length === 0 && (
              <p className="px-3 py-6 text-center text-[11px] text-zinc-500">
                No materials match “{query}”.
              </p>
            )}
            {rows.map((row, i) => {
              if (row.kind === 'header') {
                return (
                  <div key={`h-${row.label}`} className="sticky top-0 z-10 bg-industrial-panel/95 backdrop-blur px-3 pt-2.5 pb-1 text-[9px] font-bold uppercase tracking-widest text-zinc-500 border-b border-industrial-border/60">
                    {row.label}
                  </div>
                );
              }
              optIndex += 1;
              const idx = optIndex;
              const isActive = idx === active;
              if (row.kind === 'none') {
                return (
                  <div
                    key="none" id={`${listId}-opt-${idx}`} data-opt={idx} role="option" aria-selected={!value}
                    onMouseEnter={() => setActive(idx)} onClick={() => pick(null)}
                    className={cn('px-3 py-2 text-[11px] cursor-pointer text-zinc-400', isActive && 'bg-amber-400/10 text-zinc-100')}
                  >
                    — No material —
                  </div>
                );
              }
              const m = row.m;
              const rate = materialRate(m);
              return (
                <div
                  key={m.id + i} id={`${listId}-opt-${idx}`} data-opt={idx} role="option" aria-selected={m.id === value}
                  onMouseEnter={() => setActive(idx)} onClick={() => pick(m)}
                  className={cn(
                    'flex items-center gap-3 px-3 py-1.5 cursor-pointer border-l-2',
                    isActive ? 'bg-amber-400/10 border-amber-400' : 'border-transparent',
                    m.id === value && !isActive && 'bg-zinc-800/60',
                  )}
                >
                  <span className="flex-1 min-w-0">
                    <span className="block truncate text-[12px] text-zinc-100"><Highlight text={m.name} query={query.trim()} /></span>
                    <span className="block truncate text-[9px] text-zinc-500"><Highlight text={m.code || ''} query={query.trim()} /></span>
                  </span>
                  {rate > 0 ? (
                    <span className="shrink-0 text-right text-[11px] text-amber-400 tabular-nums">
                      {formatCurrency(rate)}<span className="text-zinc-500">/{m.unit}</span>
                    </span>
                  ) : (
                    <span className="shrink-0 text-right text-[10px] text-zinc-500">
                      Set rate <span className="text-zinc-600">· {m.unit}</span>
                    </span>
                  )}
                </div>
              );
            })}
          </div>
          <div className="flex items-center justify-between gap-3 border-t border-industrial-border px-3 py-2 text-[10px] text-zinc-500">
            <span className="hidden sm:inline">↑↓ move · Enter choose · Esc close</span>
            {onOpenBank && (
              <button
                type="button"
                onClick={() => { closeList(); onOpenBank(); }}
                className="flex items-center gap-1.5 font-bold uppercase tracking-widest text-amber-400 hover:text-amber-300"
              >
                <Library className="w-3.5 h-3.5" /> Material bank
              </button>
            )}
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
