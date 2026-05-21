/**
 * PatternPainter.tsx  v1.0
 * ─────────────────────────
 * Two exports:
 *
 *  PatternPainterOverlay  — SVG layer that renders fill + outline for every
 *                           visible pattern's matches in its assigned colour.
 *                           Sits above the base canvas, below snap pins.
 *
 *  PatternPainterSidebar  — Sidebar tab UI:
 *    • Pattern list with colour swatch, name (editable), match count,
 *      visibility toggle, threshold slider, re-run button, delete button.
 *    • "Add pattern" → enters rubber-band draw mode → auto-names → runs match.
 *    • "Repaint all" button.
 *    • Live worker phase + per-pattern running indicator.
 *    • Template thumbnail for each pattern.
 */

import React, { useEffect, useRef, useState, useCallback } from 'react';
import type { Pattern, UsePatternPainterReturn } from '@/hooks/usePatternPainter';

// ─── Coord helper ─────────────────────────────────────────────────────────────

function toVP(cx: number, cy: number, zoom: number, pan: { x: number; y: number }) {
  return { x: cx * zoom + pan.x, y: cy * zoom + pan.y };
}

// ─── PatternPainterOverlay ────────────────────────────────────────────────────

interface PatternPainterOverlayProps {
  painter: UsePatternPainterReturn;
  zoom:    number;
  pan:     { x: number; y: number };
}

export function PatternPainterOverlay({ painter, zoom, pan }: PatternPainterOverlayProps) {
  const visible = painter.patterns.filter(p => p.visible && p.matches.length > 0);
  if (visible.length === 0) return null;

  return (
    <svg
      style={{
        position:      'absolute',
        inset:         0,
        pointerEvents: 'none',
        zIndex:        32,
        overflow:      'visible',
      }}
      width="100%"
      height="100%"
    >
      <defs>
        {visible.map(pattern => (
          <filter key={`glow-${pattern.id}`} id={`pp-glow-${pattern.id}`}>
            <feGaussianBlur stdDeviation="3" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        ))}
      </defs>

      {visible.map(pattern =>
        pattern.matches.map((match, idx) => {
          const { bbox } = match;
          const tl = toVP(bbox.x,           bbox.y,           zoom, pan);
          const br = toVP(bbox.x + bbox.w,   bbox.y + bbox.h,  zoom, pan);
          const vw = br.x - tl.x;
          const vh = br.y - tl.y;
          const col = pattern.color;

          return (
            <g key={match.id} filter={`url(#pp-glow-${pattern.id})`}>
              {/* Fill */}
              <rect
                x={tl.x} y={tl.y} width={vw} height={vh}
                fill={`${col}28`}
                stroke={col}
                strokeWidth={1.5}
                rx={2}
              />
              {/* Corner ticks */}
              {[
                [tl.x, tl.y],
                [tl.x + vw, tl.y],
                [tl.x, tl.y + vh],
                [tl.x + vw, tl.y + vh],
              ].map(([cx, cy], ci) => {
                const dx = ci % 2 === 0 ? 1 : -1;
                const dy = ci < 2 ? 1 : -1;
                const len = Math.min(8, vw / 3, vh / 3);
                return (
                  <g key={ci}>
                    <line x1={cx} y1={cy} x2={cx + dx * len} y2={cy}            stroke={col} strokeWidth={2} />
                    <line x1={cx} y1={cy} x2={cx}            y2={cy + dy * len} stroke={col} strokeWidth={2} />
                  </g>
                );
              })}

              {/* Score badge */}
              <rect
                x={tl.x} y={tl.y - 17} width={58} height={15}
                fill={col} rx={2}
              />
              <text
                x={tl.x + 29} y={tl.y - 7}
                textAnchor="middle" fontSize={7.5}
                fill="#fff" fontFamily="'Courier New', monospace" fontWeight={700}
              >
                {Math.round(match.score * 100)}% #{idx + 1}
              </text>
            </g>
          );
        })
      )}
    </svg>
  );
}

// ─── Template thumbnail canvas ────────────────────────────────────────────────

function TemplateThumbnail({ crop, color }: { crop: ImageData; color: string }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const maxDim = 56;
    const scale  = Math.min(maxDim / crop.width, maxDim / crop.height, 1);
    canvas.width  = Math.round(crop.width  * scale);
    canvas.height = Math.round(crop.height * scale);
    const ctx = canvas.getContext('2d')!;
    const tmp = document.createElement('canvas');
    tmp.width  = crop.width;
    tmp.height = crop.height;
    tmp.getContext('2d')!.putImageData(crop, 0, 0);
    ctx.drawImage(tmp, 0, 0, canvas.width, canvas.height);
  }, [crop]);

  return (
    <canvas
      ref={ref}
      style={{
        display:         'block',
        border:          `1px solid ${color}55`,
        background:      '#fff',
        imageRendering:  'pixelated',
        flexShrink:      0,
        width:           56,
        height:          'auto',
      }}
    />
  );
}

// ─── Inline editable name ─────────────────────────────────────────────────────

function EditableName({
  value, color, onChange,
}: { value: string; color: string; onChange: (v: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft,   setDraft]   = useState(value);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { if (editing) inputRef.current?.focus(); }, [editing]);

  if (editing) {
    return (
      <input
        ref={inputRef}
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onBlur={() => { onChange(draft); setEditing(false); }}
        onKeyDown={e => { if (e.key === 'Enter') { onChange(draft); setEditing(false); } if (e.key === 'Escape') { setDraft(value); setEditing(false); } }}
        style={{
          background:     'transparent',
          border:         `1px solid ${color}`,
          color:          '#e5e5e5',
          fontSize:       9,
          fontFamily:     "'Courier New', monospace",
          padding:        '1px 4px',
          outline:        'none',
          width:          '100%',
          textTransform:  'uppercase',
          letterSpacing:  '.06em',
        }}
      />
    );
  }

  return (
    <span
      onClick={() => { setDraft(value); setEditing(true); }}
      title="Click to rename"
      style={{
        fontSize:      9,
        color:         '#ccc',
        textTransform: 'uppercase',
        letterSpacing: '.07em',
        cursor:        'text',
        flex:          1,
        overflow:      'hidden',
        textOverflow:  'ellipsis',
        whiteSpace:    'nowrap',
      }}
    >
      {value}
    </span>
  );
}

// ─── Pattern card ─────────────────────────────────────────────────────────────

interface PatternCardProps {
  pattern:         Pattern;
  isActive:        boolean;
  onToggleVisible: () => void;
  onRename:        (name: string) => void;
  onColorChange:   (color: string) => void;
  onThreshold:     (v: number) => void;
  onRematch:       () => void;
  onDelete:        () => void;
}

function PatternCard({
  pattern, isActive,
  onToggleVisible, onRename, onColorChange,
  onThreshold, onRematch, onDelete,
}: PatternCardProps) {
  const col = pattern.color;
  const [expanded, setExpanded] = useState(false);

  return (
    <div style={{
      border:         `1px solid ${col}44`,
      background:     `${col}06`,
      marginBottom:   5,
      position:       'relative',
    }}>
      {/* Running pulse strip */}
      {(pattern.isRunning || isActive) && (
        <>
          <style>{`@keyframes pp-pulse{0%,100%{opacity:.15}50%{opacity:.45}}`}</style>
          <div style={{
            position:   'absolute',
            inset:      0,
            background: col,
            animation:  'pp-pulse .9s ease-in-out infinite',
            pointerEvents: 'none',
          }} />
        </>
      )}

      {/* Header row */}
      <div style={{
        display:    'flex',
        alignItems: 'center',
        gap:        6,
        padding:    '5px 7px',
        position:   'relative',
      }}>
        {/* Colour swatch / picker */}
        <label title="Change colour" style={{ position: 'relative', flexShrink: 0, cursor: 'pointer' }}>
          <div style={{
            width:        14,
            height:       14,
            borderRadius: 2,
            background:   col,
            border:       `1px solid ${col}88`,
          }} />
          <input
            type="color"
            value={col}
            onChange={e => onColorChange(e.target.value)}
            style={{
              position: 'absolute',
              opacity:  0,
              width:    0,
              height:   0,
              top:      0,
              left:     0,
              pointerEvents: 'none',
            }}
          />
        </label>

        {/* Visibility toggle */}
        <button
          onClick={onToggleVisible}
          title={pattern.visible ? 'Hide overlay' : 'Show overlay'}
          style={{
            background:    'transparent',
            border:        'none',
            color:         pattern.visible ? col : '#444',
            fontSize:      10,
            cursor:        'pointer',
            padding:       0,
            flexShrink:    0,
            lineHeight:    1,
          }}
        >
          {pattern.visible ? '◉' : '○'}
        </button>

        {/* Name */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <EditableName value={pattern.name} color={col} onChange={onRename} />
        </div>

        {/* Match count badge */}
        <span style={{
          fontSize:   8,
          color:      col,
          border:     `1px solid ${col}55`,
          padding:    '1px 5px',
          fontFamily: "'Courier New', monospace",
          flexShrink: 0,
        }}>
          {pattern.isRunning ? '…' : pattern.matches.length}
        </span>

        {/* Expand toggle */}
        <button
          onClick={() => setExpanded(v => !v)}
          style={{
            background: 'transparent',
            border:     'none',
            color:      '#555',
            fontSize:   9,
            cursor:     'pointer',
            padding:    0,
            flexShrink: 0,
          }}
        >
          {expanded ? '▲' : '▼'}
        </button>

        {/* Delete */}
        <button
          onClick={onDelete}
          style={{
            background: 'transparent',
            border:     'none',
            color:      '#3a3a3a',
            fontSize:   12,
            cursor:     'pointer',
            padding:    '0 2px',
            flexShrink: 0,
            lineHeight: 1,
          }}
          title="Remove pattern"
        >
          ×
        </button>
      </div>

      {/* Expanded detail */}
      {expanded && (
        <div style={{
          padding:     '0 7px 7px 7px',
          borderTop:   `1px solid ${col}22`,
          position:    'relative',
        }}>
          {/* Thumbnail + stats row */}
          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', marginTop: 6, marginBottom: 8 }}>
            <TemplateThumbnail crop={pattern.rawTemplate} color={col} />
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 6, color: '#555', textTransform: 'uppercase', letterSpacing: '.07em', marginBottom: 3 }}>
                Template
              </div>
              <div style={{ fontSize: 7, color: '#444' }}>
                {pattern.template.width}×{pattern.template.height}px
              </div>
              <div style={{ fontSize: 6, color: '#333', marginTop: 3 }}>
                {pattern.matches.length} instance{pattern.matches.length !== 1 ? 's' : ''} found
              </div>
              {pattern.matches.length > 0 && (
                <div style={{ fontSize: 6, color: col, marginTop: 2 }}>
                  best: {Math.round(Math.max(...pattern.matches.map(m => m.score)) * 100)}%
                </div>
              )}
            </div>
          </div>

          {/* Threshold slider */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
            <span style={{ fontSize: 7, color: '#555', textTransform: 'uppercase', letterSpacing: '.06em', minWidth: 52 }}>
              Threshold
            </span>
            <input
              type="range" min={30} max={95} step={1}
              value={Math.round(pattern.threshold * 100)}
              onChange={e => onThreshold(+e.target.value / 100)}
              style={{ flex: 1, accentColor: col }}
            />
            <span style={{ fontSize: 8, color: col, minWidth: 28 }}>
              {Math.round(pattern.threshold * 100)}%
            </span>
          </div>

          {/* Re-run button */}
          <button
            onClick={onRematch}
            disabled={pattern.isRunning}
            style={{
              width:         '100%',
              fontSize:      7,
              textTransform: 'uppercase',
              letterSpacing: '.08em',
              border:        `1px solid ${col}55`,
              background:    pattern.isRunning ? `${col}08` : `${col}15`,
              color:         pattern.isRunning ? '#444' : col,
              padding:       '3px 0',
              cursor:        pattern.isRunning ? 'default' : 'pointer',
              fontFamily:    "'Courier New', monospace",
            }}
          >
            {pattern.isRunning ? '⟳ running…' : '⟳ rematch'}
          </button>
        </div>
      )}
    </div>
  );
}

// ─── PatternPainterSidebar ────────────────────────────────────────────────────

type DrawState = 'idle' | 'drawing' | 'naming';

interface PatternPainterSidebarProps {
  painter:       UsePatternPainterReturn;
  drawState:     DrawState;
  onEnterDraw:   () => void;
  onCancelDraw:  () => void;
  /** Called when the user confirms the pattern name after drawing */
  onConfirmName: (name: string) => void;
  /** Options passed to addPattern */
  rotations:     number[];
  onRotations:   (v: number[]) => void;
  flips:         boolean[];
  onFlips:       (v: boolean[]) => void;
  removeText:    boolean;
  onRemoveText:  (v: boolean) => void;
  canvasRef:     React.RefObject<HTMLCanvasElement | null>;
}

const ALL_ROTS = [0, 90, 180, 270];

export function PatternPainterSidebar({
  painter, drawState, onEnterDraw, onCancelDraw, onConfirmName,
  rotations, onRotations, flips, onFlips, removeText, onRemoveText,
  canvasRef,
}: PatternPainterSidebarProps) {
  const COL = '#38bdf8';
  const [nameInput, setNameInput] = useState('');
  const nameInputRef = useRef<HTMLInputElement>(null);

  // Focus name input when entering naming state
  useEffect(() => {
    if (drawState === 'naming') {
      setNameInput(`Pattern ${painter.patterns.length + 1}`);
      setTimeout(() => nameInputRef.current?.focus(), 50);
    }
  }, [drawState, painter.patterns.length]);

  const totalMatches = painter.patterns.reduce((s, p) => s + p.matches.length, 0);
  const anyRunning   = painter.patterns.some(p => p.isRunning);

  const handleConfirm = useCallback(() => {
    onConfirmName(nameInput.trim() || `Pattern ${painter.patterns.length + 1}`);
    setNameInput('');
  }, [nameInput, onConfirmName, painter.patterns.length]);

  return (
    <>
      {/* ── Header ── */}
      <div style={{ padding: '8px 10px', borderBottom: '1px solid #1a1a1a', flexShrink: 0 }}>
        <div style={{ fontSize: 8, color: '#3a3a3a', textTransform: 'uppercase', letterSpacing: '.1em', marginBottom: 8 }}>
          Pattern Painter
        </div>

        {/* Worker status */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10, background: 'rgba(56,189,248,0.06)', border: '1px solid #38bdf822', padding: '4px 8px' }}>
          <div style={{ width: 7, height: 7, borderRadius: '50%', background: painter.workerReady ? '#22c55e' : '#f59e0b', flexShrink: 0 }} />
          <span style={{ fontSize: 7, color: painter.workerReady ? '#22c55e' : '#f59e0b', textTransform: 'uppercase', letterSpacing: '.07em', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {painter.workerPhase || (painter.workerReady ? 'Ready' : 'Loading…')}
          </span>
          {anyRunning && (
            <>
              <style>{`@keyframes cvspin{from{transform:rotate(0)}to{transform:rotate(360deg)}}`}</style>
              <div style={{ width: 7, height: 7, border: '1px solid transparent', borderTopColor: COL, borderRadius: '50%', animation: 'cvspin .6s linear infinite', flexShrink: 0 }} />
            </>
          )}
        </div>

        {/* Summary */}
        <div style={{ display: 'flex', gap: 12, alignItems: 'baseline', marginBottom: 10 }}>
          <div>
            <span style={{ fontSize: 8, color: '#555' }}>Patterns </span>
            <span style={{ fontSize: 14, color: COL, fontWeight: 700 }}>{painter.patterns.length}</span>
          </div>
          <div>
            <span style={{ fontSize: 8, color: '#555' }}>Instances </span>
            <span style={{ fontSize: 14, color: '#f43f5e', fontWeight: 700 }}>{totalMatches}</span>
          </div>
        </div>

        {/* Draw state UI */}
        {drawState === 'idle' && (
          <div style={{ display: 'flex', gap: 4 }}>
            <button
              onClick={onEnterDraw}
              style={{
                flex:          1,
                fontSize:      8,
                textTransform: 'uppercase',
                letterSpacing: '.08em',
                border:        `1px solid ${COL}`,
                background:    `${COL}12`,
                color:         COL,
                padding:       '4px 0',
                cursor:        'pointer',
                fontFamily:    "'Courier New', monospace",
              }}
            >
              ⊡ Add Pattern
            </button>
            {painter.patterns.length > 0 && (
              <button
                onClick={() => canvasRef.current && painter.rematchAll(canvasRef.current, { rotations, flips, removeText })}
                disabled={anyRunning}
                style={{
                  fontSize:      8,
                  textTransform: 'uppercase',
                  letterSpacing: '.07em',
                  border:        '1px solid #2a2a2a',
                  background:    'transparent',
                  color:         anyRunning ? '#333' : '#888',
                  padding:       '4px 8px',
                  cursor:        anyRunning ? 'default' : 'pointer',
                  fontFamily:    "'Courier New', monospace",
                  flexShrink:    0,
                }}
              >
                ⟳ all
              </button>
            )}
          </div>
        )}

        {drawState === 'drawing' && (
          <div>
            <div style={{ fontSize: 7, color: COL, textTransform: 'uppercase', letterSpacing: '.07em', lineHeight: 1.9, marginBottom: 6 }}>
              Drag a tight box around<br />ONE symbol on the canvas
            </div>
            <button
              onClick={onCancelDraw}
              style={{ fontSize: 7, textTransform: 'uppercase', letterSpacing: '.07em', border: '1px solid #2a2a2a', background: 'transparent', color: '#555', padding: '3px 8px', cursor: 'pointer', fontFamily: "'Courier New', monospace" }}
            >
              cancel
            </button>
          </div>
        )}

        {drawState === 'naming' && (
          <div>
            <div style={{ fontSize: 7, color: '#888', textTransform: 'uppercase', letterSpacing: '.07em', marginBottom: 5 }}>
              Name this pattern:
            </div>
            <div style={{ display: 'flex', gap: 4 }}>
              <input
                ref={nameInputRef}
                value={nameInput}
                onChange={e => setNameInput(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') handleConfirm(); if (e.key === 'Escape') onCancelDraw(); }}
                style={{
                  flex:          1,
                  background:    '#0a0a0a',
                  border:        `1px solid ${COL}88`,
                  color:         '#e5e5e5',
                  fontSize:      9,
                  fontFamily:    "'Courier New', monospace",
                  padding:       '3px 6px',
                  outline:       'none',
                  textTransform: 'uppercase',
                  letterSpacing: '.06em',
                }}
              />
              <button
                onClick={handleConfirm}
                style={{
                  fontSize:      8,
                  border:        `1px solid ${COL}`,
                  background:    `${COL}15`,
                  color:         COL,
                  padding:       '3px 8px',
                  cursor:        'pointer',
                  fontFamily:    "'Courier New', monospace",
                  textTransform: 'uppercase',
                  flexShrink:    0,
                }}
              >
                ✓
              </button>
            </div>
          </div>
        )}
      </div>

      {/* ── Settings ── */}
      <div style={{ padding: '6px 10px', borderBottom: '1px solid #1a1a1a', flexShrink: 0 }}>
        <div style={{ fontSize: 7, color: '#333', textTransform: 'uppercase', letterSpacing: '.08em', marginBottom: 6 }}>
          Match settings
        </div>

        {/* Rotations */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 6 }}>
          <span style={{ fontSize: 7, color: '#555', textTransform: 'uppercase', letterSpacing: '.06em', minWidth: 56 }}>Rotations</span>
          {ALL_ROTS.map(deg => {
            const on = rotations.includes(deg);
            return (
              <button
                key={deg}
                onClick={() => onRotations(on ? rotations.filter(r => r !== deg) : [...rotations, deg])}
                style={{ fontSize: 7, padding: '2px 5px', cursor: 'pointer', border: `1px solid ${on ? COL : '#2a2a2a'}`, background: on ? `${COL}15` : 'transparent', color: on ? COL : '#444', fontFamily: 'inherit', textTransform: 'uppercase' }}
              >
                {deg}°
              </button>
            );
          })}
        </div>

        {/* Mirror */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 6 }}>
          <span style={{ fontSize: 7, color: '#555', textTransform: 'uppercase', letterSpacing: '.06em', minWidth: 56 }}>Mirror</span>
          {([false, true] as const).map(f => {
            const on  = flips.includes(f);
            const lbl = f ? '↔ flip' : 'normal';
            return (
              <button key={String(f)} onClick={() => onFlips(on ? flips.filter(x => x !== f) : [...flips, f])}
                style={{ fontSize: 7, padding: '2px 5px', cursor: 'pointer', border: `1px solid ${on ? COL : '#2a2a2a'}`, background: on ? `${COL}15` : 'transparent', color: on ? COL : '#444', fontFamily: 'inherit', textTransform: 'uppercase' }}>
                {lbl}
              </button>
            );
          })}
        </div>

        {/* Remove text */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <span style={{ fontSize: 7, color: '#555', textTransform: 'uppercase', letterSpacing: '.06em', minWidth: 56 }}>Text</span>
          <button
            onClick={() => onRemoveText(!removeText)}
            style={{ fontSize: 7, padding: '2px 5px', cursor: 'pointer', border: `1px solid ${removeText ? '#f43f5e' : '#2a2a2a'}`, background: removeText ? 'rgba(244,63,94,0.1)' : 'transparent', color: removeText ? '#f43f5e' : '#444', fontFamily: 'inherit', textTransform: 'uppercase' }}
          >
            {removeText ? '✕ strip text' : '· keep text'}
          </button>
        </div>
      </div>

      {/* ── Pattern list ── */}
      <div style={{ flex: 1, overflowY: 'auto', padding: 6 }}>
        {painter.patterns.length === 0 ? (
          <p style={{ fontSize: 8, color: '#2a2a2a', textAlign: 'center', textTransform: 'uppercase', letterSpacing: '.08em', padding: '28px 8px', lineHeight: 2.4 }}>
            No patterns yet.<br />Click "Add Pattern" and<br />draw a box around a symbol.
          </p>
        ) : (
          painter.patterns.map(pattern => (
            <PatternCard
              key={pattern.id}
              pattern={pattern}
              isActive={painter.activePatternId === pattern.id}
              onToggleVisible={() => painter.togglePatternVisible(pattern.id)}
              onRename={name => painter.updatePatternName(pattern.id, name)}
              onColorChange={color => painter.updatePatternColor(pattern.id, color)}
              onThreshold={v => painter.updatePatternThreshold(pattern.id, v)}
              onRematch={() => canvasRef.current && painter.rematchPattern(pattern.id, canvasRef.current, { rotations, flips, removeText })}
              onDelete={() => painter.removePattern(pattern.id)}
            />
          ))
        )}

        {painter.patterns.length > 0 && (
          <button
            onClick={() => painter.clearAll()}
            style={{ width: '100%', marginTop: 4, fontSize: 7, textTransform: 'uppercase', letterSpacing: '.08em', border: '1px solid #1e1e1e', background: 'transparent', color: '#2a2a2a', padding: '3px 0', cursor: 'pointer', fontFamily: "'Courier New', monospace" }}
          >
            clear all patterns
          </button>
        )}
      </div>
    </>
  );
}

// ─── Rubber-band draw hook (reusable, same logic as useCVRubberBand) ──────────

const MAX_BOX_VP_FRAC = 0.35;

export interface DrawBox { x: number; y: number; w: number; h: number }

export function usePatternRubberBand(
  viewportRef: React.RefObject<HTMLDivElement | null>,
  enabled:     boolean,
  onCommit:    (box: DrawBox) => void,
) {
  const [drawBox,   setDrawBox]   = useState<DrawBox | null>(null);
  const [isDrawing, setIsDrawing] = useState(false);
  const [tooLarge,  setTooLarge]  = useState(false);
  const startRef  = useRef<{ x: number; y: number } | null>(null);
  const activeRef = useRef(false);

  const isTooLarge = useCallback((box: DrawBox): boolean => {
    const vp = viewportRef.current; if (!vp) return false;
    const vr = vp.getBoundingClientRect();
    return box.w > vr.width * MAX_BOX_VP_FRAC || box.h > vr.height * MAX_BOX_VP_FRAC;
  }, [viewportRef]);

  const startDraw = useCallback((e: React.PointerEvent) => {
    if (!enabled) return;
    const vr = viewportRef.current!.getBoundingClientRect();
    startRef.current  = { x: e.clientX - vr.left, y: e.clientY - vr.top };
    activeRef.current = true;
    setIsDrawing(true); setTooLarge(false);
    setDrawBox({ x: startRef.current.x, y: startRef.current.y, w: 0, h: 0 });
  }, [enabled, viewportRef]);

  useEffect(() => {
    if (!enabled) return;
    const vp = viewportRef.current; if (!vp) return;

    const onMove = (e: PointerEvent) => {
      if (!activeRef.current || !startRef.current) return;
      const vr  = vp.getBoundingClientRect();
      const box: DrawBox = {
        x: Math.min(startRef.current.x, e.clientX - vr.left),
        y: Math.min(startRef.current.y, e.clientY - vr.top),
        w: Math.abs(e.clientX - vr.left - startRef.current.x),
        h: Math.abs(e.clientY - vr.top  - startRef.current.y),
      };
      setDrawBox(box); setTooLarge(isTooLarge(box));
    };

    const onUp = (e: PointerEvent) => {
      if (!activeRef.current || !startRef.current) return;
      const vr  = vp.getBoundingClientRect();
      const box: DrawBox = {
        x: Math.min(startRef.current.x, e.clientX - vr.left),
        y: Math.min(startRef.current.y, e.clientY - vr.top),
        w: Math.abs(e.clientX - vr.left - startRef.current.x),
        h: Math.abs(e.clientY - vr.top  - startRef.current.y),
      };
      activeRef.current = false;
      setIsDrawing(false); setDrawBox(null); setTooLarge(false); startRef.current = null;
      if (box.w > 5 && box.h > 5 && !isTooLarge(box)) onCommit(box);
    };

    vp.addEventListener('pointermove', onMove);
    vp.addEventListener('pointerup',   onUp);
    return () => { vp.removeEventListener('pointermove', onMove); vp.removeEventListener('pointerup', onUp); };
  }, [enabled, viewportRef, onCommit, isTooLarge]);

  return { drawBox, isDrawing, tooLarge, startDraw };
}

// ─── Rubber-band SVG overlay ──────────────────────────────────────────────────

interface PatternRubberBandProps {
  isDrawing: boolean;
  drawBox:   DrawBox | null;
  tooLarge:  boolean;
}

export function PatternRubberBand({ isDrawing, drawBox, tooLarge }: PatternRubberBandProps) {
  if (!isDrawing || !drawBox) return null;
  const col = tooLarge ? '#f43f5e' : '#38bdf8';
  return (
    <svg style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 35, overflow: 'visible' }} width="100%" height="100%">
      <defs>
        <pattern id="pp-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <line x1="0" y1="0" x2="0" y2="6" stroke={col} strokeWidth="1" strokeOpacity="0.25" />
        </pattern>
      </defs>
      <rect x={drawBox.x} y={drawBox.y} width={drawBox.w} height={drawBox.h}
        fill="url(#pp-hatch)" stroke={col} strokeWidth={1.5} strokeDasharray={tooLarge ? '6 3' : '5 3'} />
      {[[drawBox.x, drawBox.y], [drawBox.x + drawBox.w, drawBox.y], [drawBox.x, drawBox.y + drawBox.h], [drawBox.x + drawBox.w, drawBox.y + drawBox.h]].map(([cx, cy], i) => (
        <g key={i}>
          <line x1={cx - 5} y1={cy} x2={cx + 5} y2={cy} stroke={col} strokeWidth={1.5} />
          <line x1={cx} y1={cy - 5} x2={cx} y2={cy + 5} stroke={col} strokeWidth={1.5} />
        </g>
      ))}
      <text x={drawBox.x + drawBox.w / 2} y={drawBox.y - 6} textAnchor="middle" fill={col} fontSize={9} fontFamily="'Courier New',monospace">
        {tooLarge ? 'Zoom in — box too large' : `${drawBox.w.toFixed(0)} × ${drawBox.h.toFixed(0)} vp`}
      </text>
    </svg>
  );
}

// ─── Worker progress banner ───────────────────────────────────────────────────

interface PatternWorkerBannerProps {
  painter: UsePatternPainterReturn;
}

export function PatternWorkerBanner({ painter }: PatternWorkerBannerProps) {
  const anyRunning = painter.patterns.some(p => p.isRunning) || !!painter.activePatternId;
  if (!anyRunning) return null;

  const activePattern = painter.patterns.find(p => p.id === painter.activePatternId);
  const col = activePattern?.color ?? '#a78bfa';

  return (
    <div style={{
      position:      'absolute',
      top:           48,
      left:          '50%',
      transform:     'translateX(-50%)',
      background:    'rgba(13,13,13,0.96)',
      border:        `1px solid ${col}44`,
      padding:       '6px 14px',
      display:       'flex',
      flexDirection: 'column',
      alignItems:    'center',
      gap:           4,
      zIndex:        50,
      pointerEvents: 'none',
      minWidth:      240,
    }}>
      <style>{`@keyframes ppbspin{from{transform:rotate(0)}to{transform:rotate(360deg)}}`}</style>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{ width: 10, height: 10, border: '1.5px solid transparent', borderTopColor: col, borderRadius: '50%', animation: 'ppbspin .6s linear infinite', flexShrink: 0 }} />
        <span style={{ fontSize: 8, color: col, textTransform: 'uppercase', letterSpacing: '.1em', fontFamily: "'Courier New', monospace" }}>
          {activePattern ? `[${activePattern.name}] ` : ''}{painter.workerPhase || 'Working…'}
        </span>
      </div>
      {painter.workerDetail && (
        <span style={{ fontSize: 7, color: '#555', textTransform: 'uppercase', letterSpacing: '.07em', fontFamily: "'Courier New', monospace" }}>
          {painter.workerDetail}
        </span>
      )}
    </div>
  );
}