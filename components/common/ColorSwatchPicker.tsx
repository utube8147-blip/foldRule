'use client';
// Pick a colour from a fixed palette of clearly different colours (instead of
// a free colour field, where two picks easily end up looking the same).

import React, { useEffect, useRef, useState } from 'react';
import { PALETTE_GRID } from '@/hooks/measurements/useMeasurements/colors';

export function ColorSwatchPicker({ value, used = [], onChange, label = 'Colour' }: {
  value: string;
  /** Colours other rows already use — marked, so a free one is easy to spot. */
  used?: string[];
  onChange: (color: string) => void;
  label?: string;
}) {
  const [open, setOpen] = useState<{ left: number; top: number } | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const cur = (value || '').toLowerCase();
  const taken = new Set(used.map(c => (c || '').toLowerCase()).filter(c => c !== cur));

  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent) { if (e.key === 'Escape') { e.stopPropagation(); setOpen(null); } return; }
      if (pop.current?.contains(e.target as Node) || btn.current?.contains(e.target as Node)) return;
      setOpen(null);
    };
    window.addEventListener('pointerdown', close, true);
    window.addEventListener('keydown', close, true);
    window.addEventListener('wheel', close, true);
    return () => { window.removeEventListener('pointerdown', close, true); window.removeEventListener('keydown', close, true); window.removeEventListener('wheel', close, true); };
  }, [open]);

  const W = 12 + PALETTE_GRID.length * 20, H = 150;
  return (
    <>
      <button
        ref={btn} type="button" aria-label={`${label}: change`} aria-haspopup="dialog" aria-expanded={!!open} title="Change colour"
        onClick={e => {
          e.stopPropagation();
          if (open) { setOpen(null); return; }
          const r = e.currentTarget.getBoundingClientRect();
          setOpen({ left: Math.max(8, Math.min(window.innerWidth - W - 8, r.right - W)), top: r.bottom + 6 + H > window.innerHeight ? r.top - H - 6 : r.bottom + 6 });
        }}
        className="w-3.5 h-3.5 rounded-full shadow-sm hover:scale-125 transition-transform ring-1 ring-black/40 shrink-0"
        style={{ backgroundColor: value }}
      />
      {open && (
        <div
          ref={pop} role="dialog" aria-label="Choose a colour"
          className="fixed z-[200] bg-zinc-900 border border-zinc-600 shadow-2xl p-1.5"
          style={{ left: open.left, top: open.top }}
          onClick={e => e.stopPropagation()}
        >
          <div className="flex gap-[2px]">
            {PALETTE_GRID.map(h => (
              <div key={h.name} className="flex flex-col gap-[2px]">
                {h.shades.map(c => {
                  const isCur = c.toLowerCase() === cur, isTaken = taken.has(c.toLowerCase());
                  return (
                    <button
                      key={c} type="button"
                      title={`${h.name}${isCur ? ' — current' : isTaken ? ' — already used' : ''}`}
                      aria-label={`${h.name} ${c}${isTaken ? ', already used' : ''}`} aria-pressed={isCur}
                      onClick={() => { onChange(c); setOpen(null); }}
                      className={`relative w-[18px] h-[18px] hover:scale-125 hover:z-10 transition-transform ${isCur ? 'ring-2 ring-white z-10' : ''}`}
                      style={{ backgroundColor: c }}
                    >
                      {isTaken && <span className="absolute inset-0 m-auto w-1.5 h-1.5 rounded-full bg-black/70 ring-1 ring-white/70" />}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
          <div className="mt-1.5 flex items-center gap-1.5 text-[10px] text-zinc-400">
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-black/70 ring-1 ring-white/70" /> already used by another row
          </div>
        </div>
      )}
    </>
  );
}
