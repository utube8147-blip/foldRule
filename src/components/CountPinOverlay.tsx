// ─── CountPinOverlay.tsx ──────────────────────────────────────────────────────
//
//  Renders count/point measurement pins as tiny HTML dots layered over the PDF
//  canvas. On hover, a magnified icon bubble pops up above the pin so the user
//  can identify the entity type without the icons permanently obscuring the
//  drawing underneath.
//
//  FIX: For grouped measurements, render pins from children, not from parent
//       (parent has empty points array to prevent connecting lines)
//
// ─────────────────────────────────────────────────────────────────────────────

import React, { useState, useCallback, useRef } from 'react';
import { TakeoffRow } from '@/types';

// ─── Icon SVGs (inline, 24×24 viewBox) ───────────────────────────────────────

function IconDoor({ color }: { color: string }) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none"
      stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 20V3H21V20H3Z" />
      <path d="M3 3L13 3L13 20" />
      <path d="M13 3C13 3 21 3 21 11" />
      <circle cx="11" cy="12" r="1.2" fill={color} stroke="none" />
    </svg>
  );
}

function IconWindow({ color }: { color: string }) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none"
      stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" />
      <line x1="12" y1="3" x2="12" y2="21" />
      <line x1="3" y1="12" x2="21" y2="12" />
    </svg>
  );
}

function IconFan({ color }: { color: string }) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none"
      stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="2" />
      <path d="M12 2a2 2 0 0 1 2 2c0 3-2 4-2 4s-2-1-2-4a2 2 0 0 1 2-2z" />
      <path d="M22 12a2 2 0 0 1-2 2c-3 0-4-2-4-2s1-2 4-2a2 2 0 0 1 2 2z" />
      <path d="M12 22a2 2 0 0 1-2-2c0-3 2-4 2-4s2 1 2 4a2 2 0 0 1-2 2z" />
      <path d="M2 12a2 2 0 0 1 2-2c3 0 4 2 4 2s-1 2-4 2a2 2 0 0 1-2-2z" />
    </svg>
  );
}

function IconAC({ color }: { color: string }) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none"
      stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="13,2 4.5,13.5 11,13.5 11,22 19.5,10.5 13,10.5" />
    </svg>
  );
}

function IconOutlet({ color }: { color: string }) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none"
      stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <line x1="9"  y1="8.5" x2="9"  y2="12" />
      <line x1="15" y1="8.5" x2="15" y2="12" />
      <circle cx="12" cy="15.5" r="1.3" />
    </svg>
  );
}

function IconDot({ color }: { color: string }) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24">
      <circle cx="12" cy="12" r="6" fill={color} />
    </svg>
  );
}

const ICON_COMPONENTS: Record<string, React.FC<{ color: string }>> = {
  door:   IconDoor,
  window: IconWindow,
  fan:    IconFan,
  ac:     IconAC,
  outlet: IconOutlet,
};

function CountIcon({ iconId, color }: { iconId?: string; color: string }) {
  const Comp = ICON_COMPONENTS[iconId ?? ''] ?? IconDot;
  return <Comp color={color} />;
}

// ─── Bubble background tint: derive from hex color ───────────────────────────

function hexToRgba(hex: string, alpha: number): string {
  const h = hex.replace('#', '');
  const r = parseInt(h.substring(0, 2), 16);
  const g = parseInt(h.substring(2, 4), 16);
  const b = parseInt(h.substring(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

// ─── Single pin ───────────────────────────────────────────────────────────────

interface PinProps {
  x: number;          // CSS px from left
  y: number;          // CSS px from top
  color: string;
  iconId?: string;
  label: string;
  index: number;      // 1-based display index within group
  isPoint?: boolean;  // Point tool (no index badge)
}

function CountPin({ x, y, color, iconId, label, index, isPoint }: PinProps) {
  const [hovered, setHovered] = useState(false);
  // Track if bubble should flip to bottom (pin too close to top)
  const aboveThreshold = y < 90;

  return (
    <div
      style={{
        position: 'absolute',
        left: x,
        top: y,
        transform: 'translate(-50%, -50%)',
        pointerEvents: 'auto',
        zIndex: 30,
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* Pulse ring — always visible, subtle */}
      <div style={{
        position: 'absolute',
        inset: 0,
        width: 10,
        height: 10,
        borderRadius: '50%',
        border: `1.5px solid ${color}`,
        opacity: 0.3,
        transform: 'translate(-50%, -50%) scale(2)',
        left: '50%',
        top: '50%',
        pointerEvents: 'none',
      }} />

      {/* Dot */}
      <div style={{
        width: 10,
        height: 10,
        borderRadius: '50%',
        background: color,
        border: `1.5px solid ${hexToRgba(color, 0.4)}`,
        boxShadow: `0 0 0 3px ${hexToRgba(color, 0.15)}`,
        cursor: 'pointer',
        transition: 'transform 0.12s ease, box-shadow 0.12s ease',
        transform: hovered ? 'scale(1.5)' : 'scale(1)',
        position: 'relative',
        zIndex: 2,
      }} />

      {/* Index badge on dot (for count, not point) */}
      {!isPoint && (
        <div style={{
          position: 'absolute',
          top: -6,
          right: -6,
          minWidth: 14,
          height: 14,
          borderRadius: 7,
          background: color,
          color: '#fff',
          fontSize: 8,
          fontWeight: 700,
          fontFamily: 'monospace',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '0 2px',
          pointerEvents: 'none',
          zIndex: 3,
          lineHeight: 1,
        }}>
          {index}
        </div>
      )}

      {/* Hover bubble */}
      {hovered && (
        <div style={{
          position: 'absolute',
          left: '50%',
          ...(aboveThreshold
            ? { top: 'calc(100% + 12px)', bottom: 'auto' }
            : { bottom: 'calc(100% + 12px)', top: 'auto' }
          ),
          transform: 'translateX(-50%)',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          pointerEvents: 'none',
          zIndex: 50,
          animation: 'countPinPop 0.18s cubic-bezier(0.34,1.56,0.64,1) both',
        }}>
          {/* Tail (top) — only when bubble is below */}
          {aboveThreshold && (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', marginBottom: -1 }}>
              <div style={{ width: 0, height: 0, borderLeft: '7px solid transparent', borderRight: '7px solid transparent', borderBottom: `7px solid ${hexToRgba(color, 0.25)}` }} />
              <div style={{ width: 0, height: 0, borderLeft: '6px solid transparent', borderRight: '6px solid transparent', borderBottom: '6px solid var(--bubble-bg, #fff)', marginTop: -6, marginLeft: 0 }} />
            </div>
          )}

          {/* Card */}
          <div style={{
            background: 'var(--color-background-primary, #fff)',
            border: `1px solid ${hexToRgba(color, 0.35)}`,
            borderRadius: 12,
            padding: '10px 14px',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 5,
            minWidth: 80,
            boxShadow: `0 4px 20px ${hexToRgba(color, 0.18)}, 0 1px 4px rgba(0,0,0,0.08)`,
          }}>
            {/* Icon circle */}
            <div style={{
              width: 44,
              height: 44,
              borderRadius: '50%',
              background: hexToRgba(color, 0.12),
              border: `1px solid ${hexToRgba(color, 0.25)}`,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}>
              <CountIcon iconId={iconId} color={color} />
            </div>

            {/* Label */}
            <div style={{
              fontSize: 11,
              fontWeight: 600,
              fontFamily: 'monospace',
              color: 'var(--color-text-secondary, #666)',
              whiteSpace: 'nowrap',
              letterSpacing: '0.04em',
              textTransform: 'uppercase',
            }}>
              {label}
            </div>

            {/* Index */}
            {!isPoint && (
              <div style={{
                fontSize: 11,
                fontFamily: 'monospace',
                fontWeight: 700,
                color: color,
                letterSpacing: '0.06em',
              }}>
                #{index}
              </div>
            )}
          </div>

          {/* Tail (bottom) — only when bubble is above */}
          {!aboveThreshold && (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', marginTop: -1 }}>
              <div style={{ width: 0, height: 0, borderLeft: '7px solid transparent', borderRight: '7px solid transparent', borderTop: `7px solid ${hexToRgba(color, 0.25)}` }} />
              <div style={{ width: 0, height: 0, borderLeft: '6px solid transparent', borderRight: '6px solid transparent', borderTop: '6px solid var(--color-background-primary, #fff)', marginTop: -6 }} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Props ────────────────────────────────────────────────────────────────────

interface CountPinOverlayProps {
  measurements:    TakeoffRow[];
  pdfDimensions:   { w: number; h: number } | null;
  toCanvas:        (normX: number, normY: number) => { x: number; y: number };
  activeDrawingId: string | null;
  activeTool:      string;
}

// ─── Overlay ──────────────────────────────────────────────────────────────────

export function CountPinOverlay({
  measurements,
  pdfDimensions,
  toCanvas,
  activeDrawingId,
  activeTool,
}: CountPinOverlayProps) {
  if (!pdfDimensions) return null;

  // Build a quick id→row lookup so children can read label data from their parent
  const byId = new Map<string, TakeoffRow>();
  measurements.forEach(m => byId.set(m.id, m));

  const pins: PinProps[] = [];

  measurements.forEach(m => {
    if (!m.isVisible) return;
    if (m.drawingId !== activeDrawingId) return;
    if (m.type !== 'Count' && m.type !== 'Point') return;

    // FIX: For group headers, render pins from children instead
    // Parent has empty points array (FIX 1 from earlier), so we need to get points from children
    if (m.isGroupHeader && m.childIds && m.childIds.length > 0) {
      // Get all children of this group
      const children = m.childIds.map(id => byId.get(id)).filter(c => c);
      
      // Render a pin for each child (each child has exactly one point)
      children.forEach((child, idx) => {
        if (child && child.points && child.points.length > 0) {
          const { x, y } = toCanvas(child.points[0].x, child.points[0].y);
          pins.push({
            x, y,
            color:   m.color,
            iconId:  undefined,
            label:   m.description || 'Count',
            index:   idx + 1,
            isPoint: false,
          });
        }
      });
      return;
    }

    // Child rows (parentId set) - skip because parent already renders them
    if (m.parentId) return;

    // Standalone rows (no parent, no isGroupHeader) — e.g. single Point markers
    m.points.forEach((pt, idx) => {
      const { x, y } = toCanvas(pt.x, pt.y);
      pins.push({
        x, y,
        color:   m.color,
        iconId:  undefined,
        label:   m.description || (m.type === 'Point' ? 'Point' : 'Count'),
        index:   idx + 1,
        isPoint: m.type === 'Point',
      });
    });
  });

  return (
    <>
      <style>{`
        @keyframes countPinPop {
          from { opacity: 0; transform: translateX(-50%) scale(0.72) translateY(6px); }
          to   { opacity: 1; transform: translateX(-50%) scale(1)    translateY(0);   }
        }
      `}</style>
      <div
        style={{
          position:      'absolute',
          inset:         0,
          width:         pdfDimensions.w,
          height:        pdfDimensions.h,
          pointerEvents: 'none',
          zIndex:        25,
          overflow:      'visible',
        }}
      >
        {pins.map((pin, i) => (
          <CountPin key={i} {...pin} />
        ))}
      </div>
    </>
  );
}