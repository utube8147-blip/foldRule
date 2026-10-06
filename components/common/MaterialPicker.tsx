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

// ── Unit compatibility ───────────────────────────────────────────────────────
type UnitKind = 'length' | 'area' | 'volume' | 'count' | 'other';

export function unitKind(unit: string | undefined): UnitKind {
  const u = (unit || '').trim().toLowerCase().replace(/\s|\./g, '');
  if (['m', 'lm', 'rm', 'metre', 'meter', 'lin.m', 'linm', 'mm'].includes(u)) return 'length';
  if (['m²', 'm2', 'sqm', 'sq.m', 'sqm2'].includes(u)) return 'area';
  if (['m³', 'm3', 'cum', 'cu.m'].includes(u)) return 'volume';
  if (['ea', 'nr', 'no', 'nos', 'pcs', 'pc', 'each', 'set', 'pair', 'unit', 'units'].includes(u)) return 'count';
  return 'other';
}

/** Which unit kind a measurement of this type is priced in. */
export function kindForMeasurement(type: string | undefined): UnitKind | null {
  switch (type) {
    case 'Length':                                  return 'length';
    case 'Area': case 'Polygon': case 'Rectangle':  return 'area';
    case 'Count': case 'Point':                     return 'count';
    default:                                        return null;
  }
}

const KIND_LABEL: Record<UnitKind, string> = {
  length: 'per metre', area: 'per m²', volume: 'per m³', count: 'per piece / set', other: '',
};

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
  /**
   * Type of the measurement being priced ('Length', 'Area', 'Count' …). When
   * given, only materials in a matching unit are listed (a length shows
   * per-metre items, not m²), with a one-click "show all units".
   */
  measurementType?: string;
}

type Entry =
  | { kind: 'none' }
  | { kind: 'header'; label: string; count: number; open: boolean }
  | { kind: 'item'; m: Material; group: string };

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
  measurementType,
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

  // ── Unit filter ────────────────────────────────────────────────────────────
  const wantKind = kindForMeasurement(measurementType);
  const [allUnits, setAllUnits] = useState(false);
  const unitFiltered = useMemo(() => {
    if (!wantKind || allUnits) return materials;
    return materials.filter(m => unitKind(m.unit) === wantKind || m.id === value);
  }, [materials, wantKind, allUnits, value]);

  // ── Groups: collapsed; hovering (or clicking) a division opens it ──────────
  const selectedGroup = useMemo(() => {
    if (!selected) return null;
    return groupMaterialsByDivision([selected])[0]?.label ?? null;
  }, [selected]);
  const [openGroup, setOpenGroup] = useState<string | null>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Entries (memoised; ~250 items is cheap) ────────────────────────────────
  const entries = useMemo<Entry[]>(() => {
    const q = query.trim().toLowerCase();
    const searching = q.length > 0;
    const match = (m: Material) =>
      !q || m.name.toLowerCase().includes(q) || (m.code || '').toLowerCase().includes(q) ||
      (m.category || '').toLowerCase().includes(q);
    const out: Entry[] = [];
    if (!searching) out.push({ kind: 'none' });
    for (const g of groupMaterialsByDivision(unitFiltered.filter(match))) {
      const open = searching || g.label === openGroup;
      out.push({ kind: 'header', label: g.label, count: g.items.length, open });
      if (open) for (const m of g.items) out.push({ kind: 'item', m, group: g.label });
    }
    return out;
  }, [unitFiltered, query, openGroup]);
  const matchCount = useMemo(() => entries.reduce((n, e) => n + (e.kind === 'header' ? e.count : 0), 0), [entries]);

  // ── Open / close ───────────────────────────────────────────────────────────
  const openList = useCallback(() => {
    setQuery('');
    setOpenGroup(selectedGroup);          // show where the current choice lives
    setOpen(true);
  }, [selectedGroup]);

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
    if (query) { setActive(entries.findIndex(e => e.kind === 'item')); return; }
    const idx = entries.findIndex(e => (e.kind === 'item' && e.m.id === value) || (e.kind === 'none' && !value));
    setActive(Math.max(0, idx));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, query]);

  useEffect(() => () => { if (hoverTimer.current) clearTimeout(hoverTimer.current); }, []);
  const hoverGroup = (label: string) => {
    if (query) return;
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    // Small hover intent delay so sweeping the pointer across headings doesn't flicker.
    hoverTimer.current = setTimeout(() => setOpenGroup(label), 110);
  };
  const toggleGroup = (label: string) => setOpenGroup(g => (g === label ? null : label));

  // ── Position: below the field, or above if there's no room ────────────────
  const place = useCallback(() => {
    const el = wrapRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const below = window.innerHeight - r.bottom - EDGE;
    const above = r.top - EDGE;
    const up = below < 220 && above > below;
    const FOOTER = 40 + (wantKind ? 30 : 0); // footer row (+ unit bar)
    const maxH = Math.max(140, Math.min(MAX_LIST_H, (up ? above : below) - 6 - FOOTER));
    const width = Math.max(r.width, 320);
    const left = Math.min(Math.max(EDGE, r.left), window.innerWidth - width - EDGE);
    setPos({ left, top: up ? r.top - 6 : r.bottom + 6, width, maxH, up });
  }, [wantKind]);

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
    const cur = entries[active];
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(i => Math.min(entries.length - 1, i + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(i => Math.max(0, i - 1)); }
    else if (e.key === 'Home') { e.preventDefault(); setActive(0); }
    else if (e.key === 'End') { e.preventDefault(); setActive(entries.length - 1); }
    else if (e.key === 'ArrowRight' && cur?.kind === 'header' && !query) { e.preventDefault(); setOpenGroup(cur.label); }
    else if (e.key === 'ArrowLeft' && !query && (cur?.kind === 'header' || cur?.kind === 'item')) {
      e.preventDefault();
      const label = cur.kind === 'header' ? cur.label : cur.group;
      setOpenGroup(null);
      setActive(Math.max(0, entries.findIndex(x => x.kind === 'header' && x.label === label)));
    }
    else if (e.key === 'Enter') {
      e.preventDefault();
      if (!cur) return;
      if (cur.kind === 'header') { if (!query) toggleGroup(cur.label); }
      else pick(cur.kind === 'item' ? cur.m : null);
    }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeList(); }
    else if (e.key === 'Tab') { closeList(); }
  };

  const selectedLabel = selected ? selected.name : '';
  const selectedRate  = selected ? materialRate(selected) : 0;
  const h = size === 'sm' ? 'h-8 text-xs' : 'h-10 text-sm';

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
          aria-activedescendant={open && entries.length ? `${listId}-opt-${active}` : undefined}
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
          <span className={cn('shrink-0 font-mono text-[11px]', selectedRate ? 'text-amber-400' : 'text-zinc-500')}>
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
          {wantKind && (
            <div className="flex items-center justify-between gap-3 border-b border-industrial-border px-3 py-1.5 text-[11px] text-zinc-500">
              <span>
                {allUnits ? 'All units' : <>Materials priced <span className="text-zinc-300">{KIND_LABEL[wantKind]}</span></>}
              </span>
              <button
                type="button"
                onClick={() => setAllUnits(v => !v)}
                className="font-bold uppercase tracking-widest text-amber-400 hover:text-amber-300"
              >
                {allUnits ? `Only ${KIND_LABEL[wantKind]}` : 'Show all units'}
              </button>
            </div>
          )}
          <div id={listId} role="listbox" aria-label="Materials" style={{ maxHeight: pos.maxH }} className="overflow-y-auto custom-scrollbar py-1">
            {matchCount === 0 && (
              <p className="px-3 py-6 text-center text-xs text-zinc-500">
                {query ? <>No materials match “{query}”.</> : 'No materials in this unit yet.'}
                {wantKind && !allUnits && (
                  <button type="button" onClick={() => setAllUnits(true)} className="block mx-auto mt-2 font-bold uppercase tracking-widest text-[11px] text-amber-400 hover:text-amber-300">
                    Show all units
                  </button>
                )}
              </p>
            )}
            {entries.map((e, idx) => {
              const isActive = idx === active;
              if (e.kind === 'header') {
                return (
                  <div
                    key={`h-${e.label}`} id={`${listId}-opt-${idx}`} data-opt={idx}
                    role="option" aria-selected={false} aria-expanded={e.open}
                    onMouseEnter={() => { setActive(idx); hoverGroup(e.label); }}
                    onClick={() => { if (!query) toggleGroup(e.label); }}
                    className={cn(
                      'flex items-center gap-2 px-3 py-2 cursor-pointer select-none text-[11px] font-bold uppercase tracking-widest border-b border-industrial-border/40',
                      e.open ? 'text-amber-300 bg-zinc-800/40' : 'text-zinc-400',
                      isActive && 'bg-amber-400/10 text-zinc-100',
                    )}
                  >
                    <ChevronDown className={cn('w-3 h-3 shrink-0 transition-transform', !e.open && '-rotate-90')} aria-hidden />
                    <span className="flex-1 min-w-0 truncate">{e.label}</span>
                    <span className="text-zinc-600 tabular-nums">{e.count}</span>
                  </div>
                );
              }
              if (e.kind === 'none') {
                return (
                  <div
                    key="none" id={`${listId}-opt-${idx}`} data-opt={idx} role="option" aria-selected={!value}
                    onMouseEnter={() => setActive(idx)} onClick={() => pick(null)}
                    className={cn('px-3 py-2 text-xs cursor-pointer text-zinc-400 border-b border-industrial-border/40', isActive && 'bg-amber-400/10 text-zinc-100')}
                  >
                    — No material —
                  </div>
                );
              }
              const m = e.m;
              const rate = materialRate(m);
              return (
                <div
                  key={m.id} id={`${listId}-opt-${idx}`} data-opt={idx} role="option" aria-selected={m.id === value}
                  onMouseEnter={() => setActive(idx)} onClick={() => pick(m)}
                  className={cn(
                    'flex items-center gap-3 pl-7 pr-3 py-1.5 cursor-pointer border-l-2',
                    isActive ? 'bg-amber-400/10 border-amber-400' : 'border-transparent',
                    m.id === value && !isActive && 'bg-zinc-800/60',
                  )}
                >
                  <span className="flex-1 min-w-0">
                    <span className="block truncate text-[12px] text-zinc-100"><Highlight text={m.name} query={query.trim()} /></span>
                    <span className="block truncate text-[10px] text-zinc-500"><Highlight text={m.code || ''} query={query.trim()} /></span>
                  </span>
                  {rate > 0 ? (
                    <span className="shrink-0 text-right text-xs text-amber-400 tabular-nums">
                      {formatCurrency(rate)}<span className="text-zinc-500">/{m.unit}</span>
                    </span>
                  ) : (
                    <span className="shrink-0 text-right text-[11px] text-zinc-500">
                      Set rate <span className="text-zinc-600">· {m.unit}</span>
                    </span>
                  )}
                </div>
              );
            })}
          </div>
          <div className="flex items-center justify-between gap-3 border-t border-industrial-border px-3 py-2 text-[11px] text-zinc-500">
            <span className="hidden sm:inline">Type to search · ↑↓ move · → open · Enter choose</span>
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
