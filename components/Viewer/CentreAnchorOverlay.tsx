'use client';

// ─── components/Viewer/CentreAnchorOverlay.tsx ──────────────────────────────
//
//  Circle and Arc tools: centre markers → anchor → shape.
//
//    1. Markers sit on every circle centre (Circle tool) or arc centre (Arc
//       tool). Hovering one highlights every circle / arc around it.
//    2. Clicking a marker anchors the centre.
//    3. With a centre anchored, the drawn circles / arcs around it stay
//       visible; the one under the cursor lights up. Clicking it measures that
//       exact shape — clicking anywhere else draws your own from that centre
//       (the Viewer handles the clicks; this layer only draws).
//
//  Drawn in page space inside the page wrapper (zooms and scrolls with the
//  plan). Only the markers take pointer events.
// ─────────────────────────────────────────────────────────────────────────────

import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { PdfArc, PdfCircle } from '@/types/snapTypes';

export type AnchorMode = 'circle' | 'arc';

export interface CentreGroup {
  key:     string;
  nx:      number;
  ny:      number;
  circles: PdfCircle[];
  arcs:    PdfArc[];
}

export interface Anchor extends CentreGroup { kind: AnchorMode }

interface Props {
  mode:          AnchorMode;
  circles:       PdfCircle[];
  arcs:          PdfArc[];
  pdfDimensions: { w: number; h: number };
  /** Metres per PDF point (1 when uncalibrated). */
  scaleFactor:   number;
  calibrated:    boolean;
  anchor:        Anchor | null;
  /** Arc tool, own arc: the start point (normalised) once placed. */
  arcStart:      { x: number; y: number } | null;
  /** Own arc: sweep so far (radians, signed) — follows the mouse round the centre. */
  arcSweep?:     number;
  /** Show the centre markers (hidden while another shape is mid-draw). */
  showMarkers:   boolean;
  onPickCentre:  (g: CentreGroup) => void;
  /** Committed canvas px per PDF point (for labelling your own arc's radius). */
  pxPerPoint:    number;
  /** Screen-px tolerance for "on the circle / arc". */
  tolerancePx?:  number;
}

const PURPLE = '#8b5cf6';
const AMBER  = '#F2C230';
const INK    = '#1D2125';
const TAU    = Math.PI * 2;
const normA  = (a: number) => ((a % TAU) + TAU) % TAU;

/**
 * Final sweep for an arc drawn from a centre: the exact angle from start (a0)
 * to the click (a1), taken the same way round — and the same number of turns —
 * as the sweep tracked while the mouse moved. Lets arcs go past 180°.
 */
export function alignSweep(tracked: number, a0: number, a1: number): number {
  let exact = a1 - a0;
  while (exact - tracked >  Math.PI) exact -= TAU;
  while (exact - tracked < -Math.PI) exact += TAU;
  return exact;
}

/** Is angle `a` inside the arc [start, start + sweep]? */
export function angleInArc(a: number, start: number, sweep: number): boolean {
  return normA(a - start) <= sweep + 1e-6;
}

/** SVG path for an arc (angles in page coords, y down; sweep may be negative). */
function arcPath(cx: number, cy: number, r: number, a0: number, sweep: number): string {
  const a1 = a0 + sweep;
  const x0 = cx + r * Math.cos(a0), y0 = cy + r * Math.sin(a0);
  const x1 = cx + r * Math.cos(a1), y1 = cy + r * Math.sin(a1);
  const large = Math.abs(sweep) > Math.PI ? 1 : 0;
  const dir = sweep >= 0 ? 1 : 0;
  return `M ${x0} ${y0} A ${r} ${r} 0 ${large} ${dir} ${x1} ${y1}`;
}

export function groupByCentre(circles: PdfCircle[], arcs: PdfArc[], w: number, h: number): CentreGroup[] {
  const out: CentreGroup[] = [];
  const find = (x: number, y: number) => out.find(g => Math.hypot(g.nx * w - x, g.ny * h - y) < 2.5);
  for (const c of circles) {
    const x = c.nx * w, y = c.ny * h;
    const g = find(x, y) ?? (out.push({ key: `${x.toFixed(1)}:${y.toFixed(1)}`, nx: c.nx, ny: c.ny, circles: [], arcs: [] }), out[out.length - 1]);
    g.circles.push(c);
  }
  for (const a of arcs) {
    const x = a.nx * w, y = a.ny * h;
    const g = find(x, y) ?? (out.push({ key: `${x.toFixed(1)}:${y.toFixed(1)}`, nx: a.nx, ny: a.ny, circles: [], arcs: [] }), out[out.length - 1]);
    g.arcs.push(a);
  }
  for (const g of out) { g.circles.sort((a, b) => b.r - a.r); g.arcs.sort((a, b) => b.r - a.r); }
  return out;
}

export function CentreAnchorOverlay({
  mode, circles, arcs, pdfDimensions, scaleFactor, calibrated, anchor, arcStart, arcSweep, showMarkers, onPickCentre,
  pxPerPoint, tolerancePx = 12,
}: Props) {
  const { w, h } = pdfDimensions;
  const svgRef = useRef<SVGSVGElement>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);   // page px (committed)

  const groups = useMemo(
    () => groupByCentre(mode === 'circle' ? circles : [], mode === 'arc' ? arcs : [], w, h)
      .filter(g => (mode === 'circle' ? g.circles.length : g.arcs.length) > 0),
    [mode, circles, arcs, w, h],
  );

  // Track the cursor over the page while a centre is anchored (for highlight / preview).
  useEffect(() => {
    if (!anchor) { setCursor(null); return; }
    const host = svgRef.current?.parentElement;
    if (!host) return;
    let raf = 0;
    const onMove = (e: PointerEvent) => {
      const r = host.getBoundingClientRect();
      const x = ((e.clientX - r.left) / r.width) * w;
      const y = ((e.clientY - r.top) / r.height) * h;
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => setCursor({ x, y }));
    };
    const onLeave = () => setCursor(null);
    host.addEventListener('pointermove', onMove);
    host.addEventListener('pointerleave', onLeave);
    return () => { cancelAnimationFrame(raf); host.removeEventListener('pointermove', onMove); host.removeEventListener('pointerleave', onLeave); };
  }, [anchor, w, h]);

  const fmtLen = (pt: number) => {
    const m = pt * scaleFactor;
    return calibrated ? `${m >= 10 ? m.toFixed(1) : m.toFixed(2)} m` : `${Math.round(pt)} pt`;
  };

  // ── Anchored: which drawn shape is under the cursor? ──────────────────────
  const tol = tolerancePx;
  const anchorX = anchor ? anchor.nx * w : 0, anchorY = anchor ? anchor.ny * h : 0;
  let hotCircle: PdfCircle | null = null;
  let hotArc: PdfArc | null = null;
  if (anchor && cursor && !arcStart) {
    const d = Math.hypot(cursor.x - anchorX, cursor.y - anchorY);
    const ang = Math.atan2(cursor.y - anchorY, cursor.x - anchorX);
    if (anchor.kind === 'circle') {
      hotCircle = anchor.circles.find(c => Math.abs(d - c.nrx * w) < tol) ?? null;
    } else {
      hotArc = anchor.arcs.find(a => Math.abs(d - a.nrx * w) < tol && angleInArc(ang, a.start, a.sweep)) ?? null;
    }
  }

  const hotGroup = !anchor ? groups.find(g => g.key === hovered) ?? null : null;

  return (
    <svg ref={svgRef} className="absolute inset-0 w-full h-full z-[55] pointer-events-none" viewBox={`0 0 ${w} ${h}`}>
      {/* ── Hover preview of a centre (not anchored) ── */}
      {hotGroup && (
        <g>
          {hotGroup.circles.map((c, i) => (
            <circle key={`c${i}`} cx={hotGroup.nx * w} cy={hotGroup.ny * h} r={c.nrx * w}
              fill={AMBER} fillOpacity={0.06} stroke={AMBER} strokeWidth={2} />
          ))}
          {hotGroup.arcs.map((a, i) => (
            <path key={`a${i}`} d={arcPath(hotGroup.nx * w, hotGroup.ny * h, a.nrx * w, a.start, a.sweep)}
              fill="none" stroke={AMBER} strokeWidth={2.5} />
          ))}
          <Label x={hotGroup.nx * w} y={hotGroup.ny * h - 16}
            text={mode === 'circle'
              ? (hotGroup.circles.length === 1 ? `Ø ${fmtLen(2 * hotGroup.circles[0].r)}` : `${hotGroup.circles.length} circles — click centre`)
              : (hotGroup.arcs.length === 1 ? `R ${fmtLen(hotGroup.arcs[0].r)} · ${Math.round((hotGroup.arcs[0].sweep * 180) / Math.PI)}°` : `${hotGroup.arcs.length} arcs — click centre`)} />
        </g>
      )}

      {/* ── Anchored centre ── */}
      {anchor && (
        <g>
          {anchor.kind === 'circle' && anchor.circles.map((c, i) => {
            const hot = c === hotCircle;
            return <circle key={i} cx={anchorX} cy={anchorY} r={c.nrx * w} fill={hot ? AMBER : 'none'} fillOpacity={0.08}
              stroke={hot ? AMBER : PURPLE} strokeOpacity={hot ? 1 : 0.55} strokeWidth={hot ? 3 : 1.5} strokeDasharray={hot ? undefined : '6 5'} />;
          })}
          {anchor.kind === 'arc' && anchor.arcs.map((a, i) => {
            const hot = a === hotArc;
            const r = a.nrx * w;
            const ends = [a.start, a.start + a.sweep].map(t => ({ x: anchorX + r * Math.cos(t), y: anchorY + r * Math.sin(t) }));
            return (
              <g key={i} opacity={arcStart ? 0.45 : 1}>
                <path d={arcPath(anchorX, anchorY, r, a.start, a.sweep)} fill="none"
                  stroke={hot ? AMBER : PURPLE} strokeOpacity={hot ? 1 : 0.6} strokeWidth={hot ? 3 : 1.75} strokeDasharray={hot ? undefined : '6 5'} />
                {/* the arc's ends — click-able start / end points */}
                {ends.map((p, j) => (
                  <circle key={j} cx={p.x} cy={p.y} r={4} fill={hot ? AMBER : PURPLE} stroke="#fff" strokeWidth={1.25} />
                ))}
              </g>
            );
          })}

          {/* Own arc: guide circle + live preview (shorter way round) */}
          {anchor.kind === 'arc' && arcStart && (() => {
            const sx = arcStart.x * w, sy = arcStart.y * h;
            const r = Math.hypot(sx - anchorX, sy - anchorY);
            const a0 = Math.atan2(sy - anchorY, sx - anchorX);
            const a1 = cursor ? Math.atan2(cursor.y - anchorY, cursor.x - anchorX) : a0;
            let sweep = normA(a1 - a0);
            if (sweep > Math.PI) sweep -= TAU;
            if (typeof arcSweep === 'number' && arcSweep !== 0) sweep = arcSweep;   // tracked: can exceed 180°
            return (
              <g>
                <circle cx={anchorX} cy={anchorY} r={r} fill="none" stroke={PURPLE} strokeOpacity={0.35} strokeDasharray="4 6" />
                <line x1={anchorX} y1={anchorY} x2={sx} y2={sy} stroke={PURPLE} strokeOpacity={0.5} strokeDasharray="3 4" />
                {Math.abs(sweep) > 0.01 && <path d={arcPath(anchorX, anchorY, r, a0, sweep)} fill="none" stroke={AMBER} strokeWidth={3} />}
                <circle cx={sx} cy={sy} r={4} fill={AMBER} stroke="#fff" strokeWidth={1.5} />
                {cursor && (
                  <Label x={anchorX} y={anchorY - r - 16}
                    text={Math.abs(sweep) > 0.01
                      ? `R ${fmtLen(r / (pxPerPoint || 1))} · ${Math.round((Math.abs(sweep) * 180) / Math.PI)}° — click where it ends`
                      : 'Move round the centre, then click where the arc ends'} />
                )}
              </g>
            );
          })()}

          {/* Hot shape label */}
          {hotCircle && <Label x={anchorX} y={anchorY - hotCircle.nrx * w - 16} text={`Ø ${fmtLen(2 * hotCircle.r)} — click to measure`} />}
          {hotArc && <Label x={anchorX} y={anchorY - hotArc.nrx * w - 16} text={`R ${fmtLen(hotArc.r)} · ${Math.round((hotArc.sweep * 180) / Math.PI)}° — click the start point (Shift-click: whole arc)`} />}
          {!hotCircle && !hotArc && cursor && !arcStart && (
            <Label x={anchorX} y={anchorY + 22}
              text={anchor.kind === 'circle' ? 'Click a highlighted circle — or anywhere for your own radius' : 'Click the arc’s start point — on a drawn arc or anywhere'} muted />
          )}

          <Crosshair x={anchorX} y={anchorY} colour={AMBER} big />
        </g>
      )}

      {/* ── Centre markers ── */}
      {showMarkers && !anchor && groups.map(g => {
        const isHot = g.key === hovered;
        const n = mode === 'circle' ? g.circles.length : g.arcs.length;
        return (
          <g
            key={g.key}
            className="pointer-events-auto cursor-pointer"
            onPointerEnter={() => setHovered(g.key)}
            onPointerLeave={() => setHovered(k => (k === g.key ? null : k))}
            onPointerDown={e => e.stopPropagation()}
            onClick={e => { e.stopPropagation(); setHovered(null); onPickCentre(g); }}
            role="button"
            aria-label={mode === 'circle' ? 'Use this circle centre' : 'Use this arc centre'}
          >
            <circle cx={g.nx * w} cy={g.ny * h} r={12} fill="transparent" />
            <Crosshair x={g.nx * w} y={g.ny * h} colour={isHot ? AMBER : PURPLE} big={isHot} />
            {n > 1 && (
              <text x={g.nx * w + 9} y={g.ny * h - 7} fontSize={10} fontWeight={700} fill={isHot ? AMBER : PURPLE}
                style={{ fontFamily: 'var(--font-jetbrains), ui-monospace, monospace' }}>×{n}</text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

function Crosshair({ x, y, colour, big }: { x: number; y: number; colour: string; big?: boolean }) {
  return (
    <g>
      <circle cx={x} cy={y} r={big ? 6 : 4.5} fill={colour} fillOpacity={big ? 1 : 0.85} stroke="#fff" strokeWidth={1.5} />
      <line x1={x - 9} y1={y} x2={x + 9} y2={y} stroke={colour} strokeWidth={1.25} />
      <line x1={x} y1={y - 9} x2={x} y2={y + 9} stroke={colour} strokeWidth={1.25} />
    </g>
  );
}

function Label({ x, y, text, muted }: { x: number; y: number; text: string; muted?: boolean }) {
  const tw = text.length * 6.4 + 14;
  return (
    <g transform={`translate(${x}, ${y})`}>
      <rect x={-tw / 2} y={-11} width={tw} height={20} rx={2} fill={INK} fillOpacity={0.92} />
      <text x={0} y={3} textAnchor="middle" fontSize={11} fontWeight={700} fill={muted ? '#C3C9CF' : AMBER}
        style={{ fontFamily: 'var(--font-jetbrains), ui-monospace, monospace' }}>{text}</text>
    </g>
  );
}
