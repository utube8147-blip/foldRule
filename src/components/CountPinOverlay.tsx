// ─── CountPinOverlay.tsx ──────────────────────────────────────────────────────

import React, { useState } from 'react';
import { TakeoffRow } from '@/types';

// ─── Inline icon SVGs ─────────────────────────────────────────────────────────

function IconDoor({ color }: { color: string }) {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none"
      stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="2" width="18" height="20" rx="1" />
      <path d="M3 2L14 2L14 22" />
      <circle cx="11.5" cy="12" r="1.2" fill={color} stroke="none" />
    </svg>
  );
}

function IconWindow({ color }: { color: string }) {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none"
      stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="1" />
      <line x1="12" y1="3" x2="12" y2="21" />
      <line x1="3" y1="12" x2="21" y2="12" />
    </svg>
  );
}

function IconFan({ color }: { color: string }) {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none"
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
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none"
      stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="13,2 4.5,13.5 11,13.5 11,22 19.5,10.5 13,10.5" />
    </svg>
  );
}

function IconOutlet({ color }: { color: string }) {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none"
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
    <svg width="20" height="20" viewBox="0 0 24 24">
      <circle cx="12" cy="12" r="7" fill={color} opacity="0.9" />
      <circle cx="12" cy="12" r="3.5" fill="#fff" opacity="0.6" />
    </svg>
  );
}

const ICON_MAP: Record<string, React.FC<{ color: string }>> = {
  door:   IconDoor,
  window: IconWindow,
  fan:    IconFan,
  ac:     IconAC,
  outlet: IconOutlet,
};

function CountIcon({ iconId, color }: { iconId?: string; color: string }) {
  const Comp = ICON_MAP[iconId ?? ''] ?? IconDot;
  return <Comp color={color} />;
}

// ─── Color helpers ────────────────────────────────────────────────────────────

function hexToRgba(hex: string, alpha: number): string {
  const h = hex.replace('#', '').padEnd(6, '0');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

// ─── Single Pin ───────────────────────────────────────────────────────────────

interface PinProps {
  x:        number;
  y:        number;
  color:    string;
  iconId?:  string;
  label:    string;
  index:    number;
  isPoint?: boolean;
}

function CountPin({ x, y, color, iconId, label, index, isPoint }: PinProps) {
  const [hovered, setHovered] = useState(false);
  const flipDown = y < 110;
  const hasIcon = !!iconId && ICON_MAP[iconId];

  return (
    <div
      style={{
        position:      'absolute',
        left:          x,
        top:           y,
        transform:     'translate(-50%, -50%)',
        pointerEvents: 'auto',
        zIndex:        30,
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* Outer glow ring */}
      <div style={{
        position:     'absolute',
        left:         '50%',
        top:          '50%',
        width:        18,
        height:       18,
        marginLeft:   -9,
        marginTop:    -9,
        borderRadius: '50%',
        border:       `1.5px solid ${color}`,
        opacity:      hovered ? 0.5 : 0.2,
        transform:    `scale(${hovered ? 1.8 : 1.4})`,
        transition:   'transform 0.15s ease, opacity 0.15s ease',
        pointerEvents:'none',
      }} />

      {/* Core dot */}
      <div style={{
        width:        10,
        height:       10,
        borderRadius: '50%',
        background:   color,
        boxShadow:    `0 0 0 2px ${hexToRgba(color, 0.2)}, 0 1px 4px rgba(0,0,0,0.5)`,
        cursor:       'pointer',
        transition:   'transform 0.12s ease',
        transform:    hovered ? 'scale(1.45)' : 'scale(1)',
        position:     'relative',
        zIndex:       2,
      }} />

      {/* Index badge */}
      {!isPoint && (
        <div style={{
          position:       'absolute',
          top:            -7,
          right:          -7,
          minWidth:       13,
          height:         13,
          borderRadius:   7,
          background:     '#111',
          border:         `1px solid ${color}`,
          color:          color,
          fontSize:       7,
          fontWeight:     800,
          fontFamily:     'monospace',
          display:        'flex',
          alignItems:     'center',
          justifyContent: 'center',
          padding:        '0 2px',
          pointerEvents:  'none',
          zIndex:         3,
          letterSpacing:  '0.02em',
        }}>
          {index}
        </div>
      )}

      {/* Hover bubble — dark industrial style */}
      {hovered && (
        <div style={{
          position:      'absolute',
          left:          '50%',
          ...(flipDown
            ? { top: 'calc(100% + 10px)', bottom: 'auto' }
            : { bottom: 'calc(100% + 10px)', top: 'auto' }
          ),
          transform:     'translateX(-50%)',
          display:       'flex',
          flexDirection: 'column',
          alignItems:    'center',
          pointerEvents: 'none',
          zIndex:        50,
          animation:     'pinPop 0.16s cubic-bezier(0.34,1.56,0.64,1) both',
        }}>

          {/* Top tail (when bubble is below pin) */}
          {flipDown && (
            <div style={{ marginBottom: -1 }}>
              <div style={{
                width: 0, height: 0,
                borderLeft:   '6px solid transparent',
                borderRight:  '6px solid transparent',
                borderBottom: `6px solid ${hexToRgba(color, 0.5)}`,
              }} />
            </div>
          )}

          {/* Card */}
          <div style={{
            background:   '#0f0f0f',
            border:       `1px solid ${hexToRgba(color, 0.45)}`,
            borderRadius: 4,
            padding:      '8px 12px',
            display:      'flex',
            flexDirection:'column',
            alignItems:   'center',
            gap:          6,
            minWidth:     76,
            boxShadow:    `0 4px 24px rgba(0,0,0,0.7), 0 0 0 1px rgba(255,255,255,0.04), inset 0 1px 0 ${hexToRgba(color, 0.08)}`,
          }}>

            {/* Icon circle */}
            <div style={{
              width:          40,
              height:         40,
              borderRadius:   '50%',
              background:     hexToRgba(color, 0.08),
              border:         `1px solid ${hexToRgba(color, 0.3)}`,
              display:        'flex',
              alignItems:     'center',
              justifyContent: 'center',
              boxShadow:      `inset 0 1px 0 ${hexToRgba(color, 0.15)}`,
            }}>
              <CountIcon iconId={iconId} color={color} />
            </div>

            {/* Label */}
            <div style={{
              fontSize:      9,
              fontWeight:    700,
              fontFamily:    'monospace',
              color:         '#a1a1aa',
              whiteSpace:    'nowrap',
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
              maxWidth:      100,
              overflow:      'hidden',
              textOverflow:  'ellipsis',
            }}>
              {label}
            </div>

            {/* Index pill */}
            {!isPoint && (
              <div style={{
                fontSize:       9,
                fontFamily:     'monospace',
                fontWeight:     800,
                color:          color,
                letterSpacing:  '0.1em',
                background:     hexToRgba(color, 0.1),
                border:         `1px solid ${hexToRgba(color, 0.3)}`,
                borderRadius:   3,
                padding:        '1px 6px',
                lineHeight:     1.6,
              }}>
                #{String(index).padStart(2, '0')}
              </div>
            )}
          </div>

          {/* Bottom tail (when bubble is above pin) */}
          {!flipDown && (
            <div style={{ marginTop: -1 }}>
              <div style={{
                width: 0, height: 0,
                borderLeft:  '6px solid transparent',
                borderRight: '6px solid transparent',
                borderTop:   `6px solid ${hexToRgba(color, 0.5)}`,
              }} />
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

  // Build id → row lookup
  const byId = new Map<string, TakeoffRow>();
  measurements.forEach(m => byId.set(m.id, m));

  const pins: (PinProps & { key: string })[] = [];

  measurements.forEach(m => {
    if (!m.isVisible) return;
    if (m.drawingId !== activeDrawingId) return;
    if (m.type !== 'Count' && m.type !== 'Point') return;

    // ── Group header: render pins from children ───────────────────────────────
    if (m.isGroupHeader && m.childIds && m.childIds.length > 0) {
      m.childIds.forEach((childId, idx) => {
        const child = byId.get(childId);
        if (!child || !child.points || child.points.length === 0) return;
        const { x, y } = toCanvas(child.points[0].x, child.points[0].y);
        pins.push({
          key:     `${m.id}-child-${childId}`,
          x, y,
          color:   m.color,
          iconId:  m.icon,           // ← read icon from GROUP header
          label:   m.label || m.description || 'Count',
          index:   idx + 1,
          isPoint: false,
        });
      });
      return;
    }

    // ── Child rows: skip — rendered by parent above ───────────────────────────
    if (m.parentId) return;

    // ── Standalone rows (single Point markers or ungrouped Count) ─────────────
    m.points?.forEach((pt, idx) => {
      const { x, y } = toCanvas(pt.x, pt.y);
      pins.push({
        key:     `${m.id}-pt-${idx}`,
        x, y,
        color:   m.color,
        iconId:  m.icon,             // ← read icon from row itself
        label:   m.label || m.description || (m.type === 'Point' ? 'Point' : 'Count'),
        index:   idx + 1,
        isPoint: m.type === 'Point',
      });
    });
  });

  return (
    <>
      <style>{`
        @keyframes pinPop {
          from { opacity: 0; transform: translateX(-50%) scale(0.75) translateY(4px); }
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
        {pins.map(({ key, ...pin }) => (
          <CountPin key={key} {...pin} />
        ))}
      </div>
    </>
  );
}