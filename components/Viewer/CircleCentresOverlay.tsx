'use client';

// ─── components/Viewer/CircleCentresOverlay.tsx ─────────────────────────────
//
//  Shown while the Circle tool is active (and nothing is being drawn):
//    • a marker at the centre of every full circle found on the page
//    • hover a marker → its circle(s) are highlighted with their diameter
//    • click a marker → the circle is measured with the drawing's exact radius;
//      if several circles share that centre, a small chooser offers each one
//      or all of them.
//
//  Drawn in page space inside the page wrapper, so it zooms and scrolls with
//  the drawing. Only the markers take pointer events; clicks anywhere else go
//  to the drawing as usual (manual circles still work).
// ─────────────────────────────────────────────────────────────────────────────

import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { PdfCircle } from '@/types/snapTypes';

interface Props {
  circles:       PdfCircle[];
  pdfDimensions: { w: number; h: number };
  /** Metres per PDF point for this page (1 when uncalibrated). */
  scaleFactor:   number;
  calibrated:    boolean;
  onPick:        (circles: PdfCircle[]) => void;
}

interface CentreGroup { key: string; x: number; y: number; circles: PdfCircle[] }

const PURPLE = '#8b5cf6';
const AMBER  = '#F2C230';

export function CircleCentresOverlay({ circles, pdfDimensions, scaleFactor, calibrated, onPick }: Props) {
  const { w, h } = pdfDimensions;
  const [hovered, setHovered] = useState<string | null>(null);
  const [chooser, setChooser] = useState<CentreGroup | null>(null);
  const chooserRef = useRef<HTMLDivElement>(null);

  // Circles sharing a centre (concentric rings) are one marker.
  const groups = useMemo<CentreGroup[]>(() => {
    const out: CentreGroup[] = [];
    for (const c of circles) {
      const x = c.nx * w, y = c.ny * h;
      const g = out.find(o => Math.hypot(o.x - x, o.y - y) < 2.5);
      if (g) g.circles.push(c);
      else out.push({ key: `${x.toFixed(1)}:${y.toFixed(1)}`, x, y, circles: [c] });
    }
    for (const g of out) g.circles.sort((a, b) => b.r - a.r);
    return out;
  }, [circles, w, h]);

  const diameter = (c: PdfCircle) => {
    const d = 2 * c.r * scaleFactor;
    return calibrated
      ? `Ø ${d >= 10 ? d.toFixed(1) : d.toFixed(2)} m`
      : `Ø ${Math.round(2 * c.r)} pt`;
  };

  // Close the chooser on outside click / Esc.
  useEffect(() => {
    if (!chooser) return;
    const onDown = (e: PointerEvent) => { if (!chooserRef.current?.contains(e.target as Node)) setChooser(null); };
    const onKey  = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setChooser(null); } };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    return () => { window.removeEventListener('pointerdown', onDown, true); window.removeEventListener('keydown', onKey, true); };
  }, [chooser]);

  if (!groups.length) return null;
  const hot = groups.find(g => g.key === (chooser?.key ?? hovered)) ?? null;

  return (
    <>
      <svg
        className="absolute inset-0 w-full h-full z-[55] pointer-events-none"
        viewBox={`0 0 ${w} ${h}`}
        aria-label="Circle centres"
      >
        {/* Highlighted circle(s) for the hovered centre */}
        {hot && hot.circles.map((c, i) => (
          <g key={i}>
            <circle cx={hot.x} cy={hot.y} r={c.nrx * w} fill={AMBER} fillOpacity={0.08} stroke={AMBER} strokeWidth={2.5} />
            <circle cx={hot.x} cy={hot.y} r={c.nrx * w} fill="none" stroke="#1D2125" strokeWidth={1} strokeDasharray="6 5" />
          </g>
        ))}
        {hot && (
          <g transform={`translate(${hot.x}, ${hot.y - hot.circles[0].nrx * w - 12})`}>
            {(() => {
              const text = hot.circles.length === 1 ? diameter(hot.circles[0]) : `${hot.circles.length} circles · click to choose`;
              const tw = text.length * 6.6 + 14;
              return (
                <>
                  <rect x={-tw / 2} y={-11} width={tw} height={20} rx={2} fill="#1D2125" />
                  <text x={0} y={3} textAnchor="middle" fontSize={11} fontWeight={700} fill={AMBER}
                    fontFamily="var(--font-jetbrains), ui-monospace, monospace">{text}</text>
                </>
              );
            })()}
          </g>
        )}

        {/* Centre markers */}
        {groups.map(g => {
          const isHot = g.key === hot?.key;
          const col = isHot ? AMBER : PURPLE;
          return (
            <g
              key={g.key}
              className="pointer-events-auto cursor-pointer"
              onPointerEnter={() => setHovered(g.key)}
              onPointerLeave={() => setHovered(k => (k === g.key ? null : k))}
              onPointerDown={e => e.stopPropagation()}
              onClick={e => {
                e.stopPropagation();
                if (g.circles.length === 1) onPick(g.circles);
                else setChooser(g);
              }}
              role="button"
              aria-label={`Measure circle ${g.circles.map(diameter).join(', ')}`}
            >
              <circle cx={g.x} cy={g.y} r={12} fill="transparent" />
              <circle cx={g.x} cy={g.y} r={isHot ? 6 : 4.5} fill={col} fillOpacity={isHot ? 1 : 0.85} stroke="#fff" strokeWidth={1.5} />
              <line x1={g.x - 9} y1={g.y} x2={g.x + 9} y2={g.y} stroke={col} strokeWidth={1.25} />
              <line x1={g.x} y1={g.y - 9} x2={g.x} y2={g.y + 9} stroke={col} strokeWidth={1.25} />
              {g.circles.length > 1 && (
                <text x={g.x + 9} y={g.y - 7} fontSize={10} fontWeight={700} fill={col}
                  fontFamily="var(--font-jetbrains), ui-monospace, monospace">×{g.circles.length}</text>
              )}
            </g>
          );
        })}
      </svg>

      {/* Chooser for concentric circles */}
      {chooser && (
        <div
          ref={chooserRef}
          className="absolute z-[60] bg-industrial-panel border border-industrial-border shadow-2xl font-mono text-[11px] min-w-[160px]"
          style={{ left: `${(chooser.x / w) * 100}%`, top: `${(chooser.y / h) * 100}%`, transform: 'translate(14px, 14px)' }}
          role="menu"
        >
          <p className="px-3 py-2 border-b border-industrial-border text-[9px] font-bold uppercase tracking-widest text-zinc-500">
            {chooser.circles.length} circles here
          </p>
          {chooser.circles.map((c, i) => (
            <button
              key={i}
              type="button"
              role="menuitem"
              onClick={() => { setChooser(null); onPick([c]); }}
              className="w-full text-left px-3 py-2 text-zinc-200 hover:bg-amber-400/10 hover:text-amber-300"
            >
              {diameter(c)} {i === 0 ? <span className="text-zinc-500">· outer</span> : i === chooser.circles.length - 1 ? <span className="text-zinc-500">· inner</span> : null}
            </button>
          ))}
          <button
            type="button"
            role="menuitem"
            onClick={() => { const cs = chooser.circles; setChooser(null); onPick(cs); }}
            className="w-full text-left px-3 py-2 border-t border-industrial-border font-bold uppercase tracking-widest text-[10px] text-amber-400 hover:bg-amber-400/10"
          >
            All {chooser.circles.length}
          </button>
        </div>
      )}
    </>
  );
}
