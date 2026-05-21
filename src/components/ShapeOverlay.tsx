/**
 * ShapeOverlayAdapted.tsx  v2.0  (integrated)
 * ─────────────────────────────────────────────
 * Renders detected shape regions as labeled bounding boxes
 * ON TOP of the snap engine's canvas viewport.
 *
 * Key difference from v1.0:
 *   toPixel() now uses pan + zoom + pdfDims — matching exactly how the
 *   snap engine's pinCanvasRef draws snap points — instead of using
 *   svgRef.getBoundingClientRect() (which was the hidden SVG, not the canvas).
 *
 * Props:
 *   regions    — from useShapeDetector
 *   pdfDims    — { w, h } from SnapEnginePage state
 *   zoom       — current zoom level
 *   pan        — { x, y } current pan offset
 *   isScanning — from useShapeDetector
 *   onRescan   — call useShapeDetector.rescan()
 *   visible    — toggle from toolbar
 *   filter     — optional ShapeLabel[] whitelist
 */

import React, { useMemo, useState, useCallback } from 'react';
import type { DetectedRegion, ShapeLabel } from '@/hooks/useShapeDetector';

// ─── Label config ─────────────────────────────────────────────────────────────

export const LABEL_CONFIG: Record<ShapeLabel, { icon: string; name: string }> = {
  text:    { icon: 'T',  name: 'Text'    },
  door:    { icon: '▭',  name: 'Door'    },
  window:  { icon: '⬜', name: 'Window'  },
  toilet:  { icon: '◎',  name: 'Toilet'  },
  sink:    { icon: '⊡',  name: 'Sink'    },
  bathtub: { icon: '▬',  name: 'Bathtub' },
  stair:   { icon: '≡',  name: 'Stair'   },
  table:   { icon: '⬛', name: 'Table'   },
  chair:   { icon: '⌒',  name: 'Chair'   },
  fixture: { icon: '⊛',  name: 'Fixture' },
  unknown: { icon: '?',  name: 'Unknown' },
};

// ─── Types ────────────────────────────────────────────────────────────────────

interface PdfDimensions { w: number; h: number }

interface ShapeOverlayAdaptedProps {
  regions:    DetectedRegion[];
  pdfDims:    PdfDimensions | null;
  zoom:       number;
  pan:        { x: number; y: number };
  isScanning: boolean;
  onRescan:   () => void;
  visible?:   boolean;
  filter?:    ShapeLabel[];
}

// ─── Coordinate mapping ───────────────────────────────────────────────────────
// Mirrors exactly how snap engine converts normalised → viewport coords:
//   canvasX = normX * pdfDims.w
//   viewportX = canvasX * zoom + pan.x

function toViewport(
  region:  DetectedRegion,
  pdfDims: PdfDimensions,
  zoom:    number,
  pan:     { x: number; y: number },
) {
  return {
    left:   region.normX * pdfDims.w * zoom + pan.x,
    top:    region.normY * pdfDims.h * zoom + pan.y,
    width:  region.normW * pdfDims.w * zoom,
    height: region.normH * pdfDims.h * zoom,
  };
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const S = {
  overlay: {
    position: 'absolute' as const,
    inset: 0,
    pointerEvents: 'none' as const,
    overflow: 'hidden',
    zIndex: 30,
  },
  regionBox: (color: string, selected: boolean): React.CSSProperties => ({
    position: 'absolute',
    border: `${selected ? 2 : 1}px ${selected ? 'solid' : 'dashed'} ${color}`,
    borderRadius: 2,
    pointerEvents: 'auto' as const,
    cursor: 'pointer',
    boxSizing: 'border-box' as const,
    background: selected ? `${color}18` : `${color}08`,
    transition: 'border 0.12s, background 0.12s',
  }),
  chip: (color: string): React.CSSProperties => ({
    position: 'absolute',
    top: -18,
    left: -1,
    background: color,
    color: '#fff',
    fontSize: 9,
    fontWeight: 700,
    padding: '1px 5px',
    borderRadius: '3px 3px 3px 0',
    whiteSpace: 'nowrap' as const,
    userSelect: 'none' as const,
    lineHeight: '15px',
    display: 'flex',
    gap: 4,
    alignItems: 'center',
    fontFamily: "'Courier New', monospace",
    letterSpacing: '.04em',
    textTransform: 'uppercase' as const,
  }),
  popup: {
    position: 'absolute' as const,
    top: '100%',
    left: 0,
    marginTop: 4,
    background: '#0d0d0d',
    color: '#ccc',
    fontSize: 9,
    padding: '8px 10px',
    borderRadius: 3,
    zIndex: 1000,
    minWidth: 160,
    border: '1px solid #2a2a2a',
    lineHeight: '1.8',
    pointerEvents: 'auto' as const,
    fontFamily: "'Courier New', monospace",
  },
  panel: {
    position: 'absolute' as const,
    bottom: 36,
    right: 248,
    background: '#0d0d0d',
    color: '#ccc',
    border: '1px solid #2a2a2a',
    borderRadius: 3,
    padding: '8px 12px',
    fontSize: 9,
    zIndex: 500,
    minWidth: 170,
    fontFamily: "'Courier New', monospace",
    pointerEvents: 'auto' as const,
    userSelect: 'none' as const,
  },
  panelTitle: {
    fontSize: 8,
    color: '#555',
    textTransform: 'uppercase' as const,
    letterSpacing: '.1em',
    marginBottom: 8,
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  rescanBtn: (scanning: boolean): React.CSSProperties => ({
    background: 'transparent',
    color: scanning ? '#444' : '#f59e0b',
    border: `1px solid ${scanning ? '#2a2a2a' : '#f59e0b44'}`,
    padding: '2px 7px',
    cursor: scanning ? 'default' : 'pointer',
    fontSize: 8,
    fontFamily: "'Courier New', monospace",
    letterSpacing: '.06em',
    textTransform: 'uppercase' as const,
  }),
  toggleRow: (hidden: boolean): React.CSSProperties => ({
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    cursor: 'pointer',
    opacity: hidden ? 0.35 : 1,
    marginBottom: 4,
    fontSize: 8,
    textTransform: 'uppercase' as const,
    letterSpacing: '.07em',
  }),
  dot: (color: string): React.CSSProperties => ({
    width: 8,
    height: 8,
    borderRadius: 1,
    background: color,
    flexShrink: 0,
  }),
};

// ─── Component ────────────────────────────────────────────────────────────────

export function ShapeOverlayAdapted({
  regions,
  pdfDims,
  zoom,
  pan,
  isScanning,
  onRescan,
  visible  = true,
  filter,
}: ShapeOverlayAdaptedProps) {
  const [selected,    setSelected]    = useState<string | null>(null);
  const [hiddenTypes, setHiddenTypes] = useState<Set<ShapeLabel>>(new Set());

  const toggleType = useCallback((label: ShapeLabel) => {
    setHiddenTypes(prev => {
      const next = new Set(prev);
      next.has(label) ? next.delete(label) : next.add(label);
      return next;
    });
  }, []);

  const displayed = useMemo(() => {
    let r = regions;
    if (filter?.length)   r = r.filter(x => filter.includes(x.label));
    if (hiddenTypes.size) r = r.filter(x => !hiddenTypes.has(x.label));
    return r;
  }, [regions, filter, hiddenTypes]);

  const allLabels = useMemo(
    () => [...new Set(regions.map(r => r.label))] as ShapeLabel[],
    [regions],
  );

  if (!visible || !pdfDims) return null;

  return (
    <>
      {/* ── Region boxes ── */}
      <div style={S.overlay}>
        {displayed.map(region => {
          const vp    = toViewport(region, pdfDims, zoom, pan);
          const cfg   = LABEL_CONFIG[region.label];
          const isSel = selected === region.id;

          if (vp.width < 2 || vp.height < 2) return null;

          return (
            <div
              key={region.id}
              style={{ ...S.regionBox(region.color, isSel), ...vp }}
              onClick={e => { e.stopPropagation(); setSelected(isSel ? null : region.id); }}
            >
              {vp.height > 10 && (
                <div style={S.chip(region.color)}>
                  <span>{cfg.icon}</span>
                  <span>{cfg.name}</span>
                  <span style={{ opacity: 0.75 }}>{Math.round(region.confidence * 100)}%</span>
                </div>
              )}

              {isSel && (
                <div style={S.popup}>
                  <div style={{ color: region.color, fontWeight: 700, marginBottom: 5, textTransform: 'uppercase', letterSpacing: '.08em' }}>
                    {cfg.icon} {cfg.name}
                  </div>
                  <div style={{ height: 1, background: '#1e1e1e', marginBottom: 5 }} />
                  <PopRow label="Confidence" value={`${(region.confidence * 100).toFixed(1)}%`} />
                  <PopRow label="Paths"      value={`${region.pathCount}`} />
                  <PopRow label="Size"       value={`${region.bbox.w.toFixed(0)} × ${region.bbox.h.toFixed(0)}`} />
                  <PopRow label="Norm XY"    value={`${region.normX.toFixed(3)}, ${region.normY.toFixed(3)}`} />
                  <PopRow label="Norm WH"    value={`${region.normW.toFixed(3)}, ${region.normH.toFixed(3)}`} />
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* ── Floating control panel ── */}
      <div style={S.panel}>
        <div style={S.panelTitle}>
          <span>Shape detector</span>
          <button style={S.rescanBtn(isScanning)} onClick={onRescan} disabled={isScanning}>
            {isScanning ? '⟳ scanning' : '⟳ rescan'}
          </button>
        </div>

        {allLabels.length === 0 ? (
          <div style={{ fontSize: 8, color: '#333', textTransform: 'uppercase', letterSpacing: '.07em' }}>
            No shapes detected
          </div>
        ) : (
          allLabels.map(label => {
            const cfg    = LABEL_CONFIG[label];
            const count  = regions.filter(r => r.label === label).length;
            const color  = regions.find(r => r.label === label)?.color ?? '#555';
            const hidden = hiddenTypes.has(label);
            return (
              <div
                key={label}
                style={S.toggleRow(hidden)}
                onClick={() => toggleType(label)}
              >
                <div style={S.dot(color)} />
                <span style={{ flex: 1, color: '#777' }}>{cfg.icon} {cfg.name}</span>
                <span style={{ color: '#444' }}>{count}</span>
              </div>
            );
          })
        )}

        <div style={{ marginTop: 6, paddingTop: 6, borderTop: '1px solid #1a1a1a', fontSize: 7, color: '#333', textTransform: 'uppercase', letterSpacing: '.08em' }}>
          {displayed.length} / {regions.length} shown
        </div>
      </div>
    </>
  );
}

// ─── Small helper ─────────────────────────────────────────────────────────────

function PopRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2 }}>
      <span style={{ fontSize: 7, color: '#555', textTransform: 'uppercase', letterSpacing: '.07em' }}>{label}</span>
      <span style={{ fontSize: 8, color: '#e5e5e5', fontWeight: 700 }}>{value}</span>
    </div>
  );
}