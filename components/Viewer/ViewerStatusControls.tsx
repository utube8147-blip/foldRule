'use client';

// Drawing aids and zoom, shown in the bar under the drawing (next to the page
// controls): Snap and Angle lock toggles, one "Show" menu for the overlays,
// and zoom. Kept small on purpose — the tools themselves live in the left rail.

import React from 'react';
import { ZoomIn, ZoomOut, Maximize, Magnet, Eye, Check, ChevronUp } from 'lucide-react';
import { cn } from '@/lib/utils';

interface Props {
  snapEnabled:   boolean;
  setSnapEnabled: (v: boolean) => void;
  orthoEnabled:  boolean;
  setOrthoEnabled: (v: boolean) => void;
  showPins:      boolean;
  setShowPins:   (v: boolean) => void;
  showLabels:    boolean;
  setShowLabels: (v: boolean) => void;
  showGeometry:  boolean;
  setShowGeometry: (v: boolean) => void;
  scale:         number;
  zoomIn:        () => void;
  zoomOut:       () => void;
  fitToScreen:   () => void;
}

const sep = <span className="w-px h-4 bg-industrial-border" aria-hidden />;

function Toggle({ on, onClick, title, tone, children }: {
  on: boolean; onClick: () => void; title: string; tone: 'green' | 'sky'; children: React.ReactNode;
}) {
  const onClass = tone === 'green'
    ? 'border-green-500/50 bg-green-500/10 text-green-400'
    : 'border-sky-500/50 bg-sky-500/10 text-sky-300';
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      title={title}
      className={cn(
        'h-6 px-2 flex items-center gap-1.5 border text-[10px] font-mono font-bold uppercase tracking-widest transition-colors',
        on ? onClass : 'border-zinc-700 text-zinc-500 hover:text-zinc-300 hover:border-zinc-500',
      )}
    >
      {children}
    </button>
  );
}

export function ViewerStatusControls(p: Props) {
  const [open, setOpen] = React.useState(false);
  const boxRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => { if (!boxRef.current?.contains(e.target as Node)) setOpen(false); };
    const onKey  = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('pointerdown', onDown); window.removeEventListener('keydown', onKey); };
  }, [open]);

  const layers: { label: string; hint: string; on: boolean; set: (v: boolean) => void }[] = [
    { label: 'Quantity labels', hint: 'Each quantity written on its shape',        on: p.showLabels,   set: p.setShowLabels },
    { label: 'Snap pins',       hint: 'Snap points near the cursor',               on: p.showPins,     set: p.setShowPins },
    { label: 'PDF geometry',    hint: 'The lines and arcs snapping reads',         on: p.showGeometry, set: p.setShowGeometry },
  ];
  const shown = layers.filter(l => l.on).length;

  return (
    <div className="flex items-center gap-2">
      {/* Zoom */}
      <div className="flex items-center">
        <button type="button" onClick={p.zoomOut} title="Zoom out (Ctrl/Cmd –)" aria-label="Zoom out"
          className="p-1 text-zinc-500 hover:text-zinc-200 transition-colors">
          <ZoomOut className="w-4 h-4" />
        </button>
        <span className="w-11 text-center text-[11px] font-mono font-bold text-zinc-400 tabular-nums">
          {Math.round(p.scale * 100)}%
        </span>
        <button type="button" onClick={p.zoomIn} title="Zoom in (Ctrl/Cmd +)" aria-label="Zoom in"
          className="p-1 text-zinc-500 hover:text-zinc-200 transition-colors">
          <ZoomIn className="w-4 h-4" />
        </button>
        <button type="button" onClick={p.fitToScreen} title="Fit to screen (Ctrl/Cmd 0)" aria-label="Fit to screen"
          className="p-1 ml-0.5 text-zinc-500 hover:text-zinc-200 transition-colors">
          <Maximize className="w-3.5 h-3.5" />
        </button>
      </div>

      {sep}

      <Toggle on={p.snapEnabled} tone="green" onClick={() => p.setSnapEnabled(!p.snapEnabled)}
        title={`Snap to the drawing’s lines: ${p.snapEnabled ? 'on' : 'off'} — toggle with S`}>
        <Magnet className="w-3 h-3" aria-hidden />
        Snap
      </Toggle>
      <Toggle on={p.orthoEnabled} tone="sky" onClick={() => p.setOrthoEnabled(!p.orthoEnabled)}
        title={`Angle lock: ${p.orthoEnabled ? 'on' : 'off'} — keeps line and polygon edges at 0° / 45° / 90° from the last point. Toggle with F8. Exact snap points still win.`}>
        <span aria-hidden className="text-[11px] leading-none">∟</span>
        Angle
      </Toggle>

      {/* Show menu */}
      <div className="relative" ref={boxRef}>
        <button
          type="button"
          onClick={() => setOpen(o => !o)}
          aria-expanded={open}
          aria-haspopup="menu"
          title="Choose what is drawn over the PDF"
          className={cn(
            'h-6 px-2 flex items-center gap-1.5 border text-[10px] font-mono font-bold uppercase tracking-widest transition-colors',
            open || shown > 0
              ? 'border-amber-400/50 bg-amber-400/10 text-amber-300'
              : 'border-zinc-700 text-zinc-500 hover:text-zinc-300 hover:border-zinc-500',
          )}
        >
          <Eye className="w-3 h-3" aria-hidden />
          Show{shown > 0 ? ` · ${shown}` : ''}
          <ChevronUp className={cn('w-3 h-3 transition-transform', !open && 'rotate-180')} aria-hidden />
        </button>
        {open && (
          <div role="menu" className="absolute bottom-8 left-0 z-[80] w-60 bg-industrial-panel border border-industrial-border shadow-2xl py-1 normal-case tracking-normal">
            {layers.map(l => (
              <button
                key={l.label}
                type="button"
                role="menuitemcheckbox"
                aria-checked={l.on}
                onClick={() => l.set(!l.on)}
                className="w-full flex items-start gap-2.5 px-3 py-2 text-left hover:bg-zinc-800/60"
              >
                <span className={cn(
                  'mt-0.5 w-3.5 h-3.5 border flex items-center justify-center shrink-0',
                  l.on ? 'bg-amber-400 border-amber-400 text-black' : 'border-zinc-600',
                )}>
                  {l.on && <Check className="w-3 h-3" aria-hidden />}
                </span>
                <span>
                  <span className="block text-xs font-semibold text-zinc-200">{l.label}</span>
                  <span className="block text-[11px] text-zinc-500">{l.hint}</span>
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
