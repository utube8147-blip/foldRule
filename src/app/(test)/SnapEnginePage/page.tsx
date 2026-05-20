'use client';

import React, {
  useState, useEffect, useRef, useCallback,
} from 'react';

import { useSvgSnapPoints, type SvgSnapPoint } from '@/hooks/useSvgSnapPoints';
import { useSnapEngine } from '@/hooks/useSnapEngine';
import type { SvgLine } from '@/hooks/useSvgInteraction';
import type { PdfDimensions } from '@/types/viewerTypes';

// ── Constants ─────────────────────────────────────────────────────────────────

const SNAP_COLOURS: Record<SvgSnapPoint['type'], string> = {
  endpoint:     '#f59e0b',
  midpoint:     '#10b981',
  centroid:     '#8b5cf6',
  intersection: '#f43f5e',
};

const LOAD_LINES = [
  'Reading SVG document',
  'Extracting vector geometry',
  'Classifying stroke connectivity',
  'Computing snap point candidates',
  'Building line index',
  'Deduplicating intersection points',
];

const DRAG_THRESHOLD = 5;

// ── Helpers ───────────────────────────────────────────────────────────────────

const yieldFrame = () => new Promise<void>(r => requestAnimationFrame(() => r()));

// ── SVG line extractor ────────────────────────────────────────────────────────

function numA(el: Element, n: string, fb = 0): number {
  const v = parseFloat(el.getAttribute(n) ?? ''); return isNaN(v) ? fb : v;
}
function identMat() { return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }; }
function mulMat(m1: any, m2: any) {
  return {
    a: m1.a * m2.a + m1.c * m2.b, b: m1.b * m2.a + m1.d * m2.b,
    c: m1.a * m2.c + m1.c * m2.d, d: m1.b * m2.c + m1.d * m2.d,
    e: m1.a * m2.e + m1.c * m2.f + m1.e, f: m1.b * m2.e + m1.d * m2.f + m1.f,
  };
}
function applyMat(m: any, x: number, y: number) {
  return { x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f };
}
function parseTfm(t: string | null): any {
  if (!t) return identMat();
  const re = /(matrix|translate|scale|rotate)\(([^)]*)\)/g;
  const mats: any[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(t)) !== null) {
    const args = m[2].trim().split(/[\s,]+/).map(parseFloat);
    let mat = identMat();
    if (m[1] === 'matrix')         mat = { a: args[0], b: args[1], c: args[2], d: args[3], e: args[4], f: args[5] };
    else if (m[1] === 'translate') mat = { ...identMat(), e: args[0] ?? 0, f: args[1] ?? 0 };
    else if (m[1] === 'scale')     { const s = args[0] ?? 1, sy = args[1] ?? s; mat = { a: s, b: 0, c: 0, d: sy, e: 0, f: 0 }; }
    else if (m[1] === 'rotate')    { const a = (args[0] ?? 0) * Math.PI / 180, cos = Math.cos(a), sin = Math.sin(a); mat = { a: cos, b: sin, c: -sin, d: cos, e: 0, f: 0 }; }
    mats.push(mat);
  }
  return mats.reduce((acc, m) => mulMat(acc, m), identMat());
}
function getCTM(el: Element, root: Element): any {
  const mats: any[] = [];
  let node: Element | null = el;
  while (node && node !== root.parentElement) {
    const t = node.getAttribute('transform');
    if (t) mats.unshift(parseTfm(t));
    node = node.parentElement;
  }
  return mats.reduce((acc, m) => mulMat(acc, m), identMat());
}

function pathToPairs(d: string): Array<[number, number, number, number]> {
  const pairs: Array<[number, number, number, number]> = [];
  let cx = 0, cy = 0, sx = 0, sy = 0;
  const re = /([MmLlHhVvCcSsQqTtZz])([^MmLlHhVvCcSsQqTtZz]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(d)) !== null) {
    const cmd = m[1];
    const rel = cmd === cmd.toLowerCase() && cmd !== 'Z' && cmd !== 'z';
    const args = m[2].trim() === '' ? [] : m[2].trim().split(/[\s,]+/).map(parseFloat).filter(n => !isNaN(n));
    const ox = rel ? cx : 0, oy = rel ? cy : 0;
    switch (cmd.toUpperCase()) {
      case 'M':
        for (let i = 0; i + 1 < args.length; i += 2) {
          const nx = args[i] + (i === 0 ? ox : (rel ? cx : 0));
          const ny = args[i + 1] + (i === 0 ? oy : (rel ? cy : 0));
          if (i === 0) { cx = nx; cy = ny; sx = cx; sy = cy; }
          else { pairs.push([cx, cy, nx, ny]); cx = nx; cy = ny; }
        } break;
      case 'L':
        for (let i = 0; i + 1 < args.length; i += 2) {
          const nx = args[i] + ox, ny = args[i + 1] + oy;
          pairs.push([cx, cy, nx, ny]); cx = nx; cy = ny;
        } break;
      case 'H': for (const ax of args) { const nx = ax + ox; pairs.push([cx, cy, nx, cy]); cx = nx; } break;
      case 'V': for (const ay of args) { const ny = ay + oy; pairs.push([cx, cy, cx, ny]); cy = ny; } break;
      case 'C':
        for (let i = 0; i + 5 < args.length; i += 6) {
          const ex = args[i + 4] + ox, ey = args[i + 5] + oy;
          pairs.push([cx, cy, ex, ey]); cx = ex; cy = ey;
        } break;
      case 'S':
        for (let i = 0; i + 3 < args.length; i += 4) {
          const ex = args[i + 2] + ox, ey = args[i + 3] + oy;
          pairs.push([cx, cy, ex, ey]); cx = ex; cy = ey;
        } break;
      case 'Q':
        for (let i = 0; i + 3 < args.length; i += 4) {
          const ex = args[i + 2] + ox, ey = args[i + 3] + oy;
          pairs.push([cx, cy, ex, ey]); cx = ex; cy = ey;
        } break;
      case 'A':
        for (let i = 0; i + 6 < args.length; i += 7) {
          const ex = args[i + 5] + ox, ey = args[i + 6] + oy;
          pairs.push([cx, cy, ex, ey]); cx = ex; cy = ey;
        } break;
      case 'Z':
        if (cx !== sx || cy !== sy) pairs.push([cx, cy, sx, sy]);
        cx = sx; cy = sy; break;
    }
  }
  return pairs;
}

export function extractSvgLines(svgText: string, pdfW: number, pdfH: number): SvgLine[] {
  const parser = new DOMParser();
  const doc    = parser.parseFromString(svgText, 'image/svg+xml');
  if (doc.querySelector('parsererror')) return [];
  const svgEl = doc.querySelector('svg');
  if (!svgEl) return [];

  let sx = 1, sy = 1, tx = 0, ty = 0;
  const vb = svgEl.getAttribute('viewBox');
  if (vb) {
    const [minX, minY, vbW, vbH] = vb.trim().split(/[\s,]+/).map(parseFloat);
    if (vbW > 0 && vbH > 0) { sx = pdfW / vbW; sy = pdfH / vbH; tx = -minX * sx; ty = -minY * sy; }
  } else {
    const wa = parseFloat(svgEl.getAttribute('width') ?? '0') || pdfW;
    const ha = parseFloat(svgEl.getAttribute('height') ?? '0') || pdfH;
    sx = pdfW / wa; sy = pdfH / ha;
  }
  const toCanvas = (x: number, y: number, ctm: any) => {
    const p = applyMat(ctm, x, y);
    return { x: p.x * sx + tx, y: p.y * sy + ty };
  };

  const lines: SvgLine[] = [];

  const pushLine = (ax: number, ay: number, bx: number, by: number, ctm: any) => {
    const a = toCanvas(ax, ay, ctm), b = toCanvas(bx, by, ctm);
    if (Math.hypot(a.x - b.x, a.y - b.y) < 0.5) return;
    lines.push(({ nx1: a.x / pdfW, ny1: a.y / pdfH, nx2: b.x / pdfW, ny2: b.y / pdfH } as unknown) as SvgLine);
  };

  svgEl.querySelectorAll('line, polyline, polygon, path, rect').forEach(el => {
    const tag = el.tagName.toLowerCase();
    const ctm = getCTM(el, svgEl);

    if (tag === 'line') {
      pushLine(numA(el, 'x1'), numA(el, 'y1'), numA(el, 'x2'), numA(el, 'y2'), ctm);
    } else if (tag === 'polyline' || tag === 'polygon') {
      const raw  = el.getAttribute('points') ?? '';
      const nums = raw.trim().split(/[\s,]+/).map(parseFloat).filter(n => !isNaN(n));
      for (let i = 0; i + 3 < nums.length; i += 2) pushLine(nums[i], nums[i + 1], nums[i + 2], nums[i + 3], ctm);
      if (tag === 'polygon' && nums.length >= 4) pushLine(nums[nums.length - 2], nums[nums.length - 1], nums[0], nums[1], ctm);
    } else if (tag === 'path') {
      const pairs = pathToPairs(el.getAttribute('d') ?? '');
      for (const [ax, ay, bx, by] of pairs) pushLine(ax, ay, bx, by, ctm);
    } else if (tag === 'rect') {
      const x = numA(el, 'x'), y = numA(el, 'y'), w = numA(el, 'width'), h = numA(el, 'height');
      if (w > 0 && h > 0) {
        pushLine(x, y, x + w, y, ctm);
        pushLine(x + w, y, x + w, y + h, ctm);
        pushLine(x + w, y + h, x, y + h, ctm);
        pushLine(x, y + h, x, y, ctm);
      }
    }
  });

  return lines;
}

// ── Styles ────────────────────────────────────────────────────────────────────

const S = {
  root:      { display: 'flex', flexDirection: 'column' as const, height: '100vh', background: '#151515', color: '#ccc', fontFamily: "'Courier New', monospace", overflow: 'hidden' },
  toolbar:   { display: 'flex', alignItems: 'center', gap: 5, padding: '5px 10px', background: '#0d0d0d', borderBottom: '1px solid #222', flexShrink: 0, height: 42, flexWrap: 'nowrap' as const, overflow: 'hidden' },
  main:      { display: 'flex', flex: 1, overflow: 'hidden', minHeight: 0 },
  viewport:  { flex: 1, position: 'relative' as const, overflow: 'hidden', background: '#F8F7F3', backgroundImage: 'radial-gradient(circle, #D0CEC8 1px, transparent 1px)', backgroundSize: '20px 20px', userSelect: 'none' as const },
  canvasWrap:{ position: 'absolute' as const, top: 0, left: 0, transformOrigin: '0 0', willChange: 'transform' },
  sidebar:   { width: 240, background: '#0f0f0f', borderLeft: '1px solid #1e1e1e', display: 'flex', flexDirection: 'column' as const, flexShrink: 0, overflow: 'hidden' },
  statusbar: { height: 24, background: '#0a0a0a', borderTop: '1px solid #1a1a1a', display: 'flex', alignItems: 'center', padding: '0 10px', gap: 12, flexShrink: 0 },
  sep:       { width: 1, height: 18, background: '#222', flexShrink: 0 },
  barSep:    { width: 1, height: 12, background: '#1e1e1e' },
  lblStyle:  { fontSize: 8, color: '#444', textTransform: 'uppercase' as const, letterSpacing: '.08em', whiteSpace: 'nowrap' as const },
  sbLabel:   { fontSize: 8, color: '#3a3a3a', textTransform: 'uppercase' as const, letterSpacing: '.1em', marginBottom: 8 },
  statusTxt: { fontSize: 8, color: '#555', textTransform: 'uppercase' as const, letterSpacing: '.07em', maxWidth: 340, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const },
};

function tbBtn(active: boolean, colour?: string): React.CSSProperties {
  const c = colour ?? '#f59e0b';
  return {
    fontSize: 8, textTransform: 'uppercase', letterSpacing: '.07em',
    border: `1px solid ${active ? c : '#2a2a2a'}`,
    background: active ? `${c}12` : 'transparent',
    color: active ? c : '#777',
    padding: '3px 7px', cursor: 'pointer', fontFamily: 'inherit',
    whiteSpace: 'nowrap', flexShrink: 0,
  };
}

// ── Loading overlay ───────────────────────────────────────────────────────────

function LoadingOverlay({ active, fileName }: { active: boolean; fileName: string }) {
  const [dots, setDots] = useState('');
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!active) { setTick(0); setDots(''); return; }
    const id = setInterval(() => { setDots(d => d.length >= 3 ? '' : d + '.'); setTick(t => (t + 1) % (LOAD_LINES.length * 3)); }, 380);
    return () => clearInterval(id);
  }, [active]);
  if (!active) return null;
  const lineIdx = tick % LOAD_LINES.length;
  return (
    <div style={{ position: 'absolute', inset: 0, zIndex: 90, background: 'rgba(10,10,10,0.72)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' }}>
      <style>{`@keyframes sp{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}`}</style>
      <div style={{ background: '#0d0d0d', border: '1px solid #2a2a2a', padding: '20px 32px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14, minWidth: 260 }}>
        <div style={{ position: 'relative', width: 36, height: 36 }}>
          <div style={{ position: 'absolute', inset: 0, border: '1.5px solid #1c1c1c', borderRadius: '50%' }} />
          <div style={{ position: 'absolute', inset: 0, border: '1.5px solid transparent', borderTopColor: '#f59e0b', borderRadius: '50%', animation: 'sp .8s linear infinite' }} />
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14, color: '#f59e0b' }}>⊕</div>
        </div>
        <div style={{ fontSize: 9, color: '#444', textTransform: 'uppercase', letterSpacing: '.09em', maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{fileName}</div>
        <div style={{ width: '100%' }}>
          {LOAD_LINES.map((line, i) => {
            const isActive = i === lineIdx, isDone = i < lineIdx;
            return (
              <div key={line} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '2px 0', opacity: isActive ? 1 : isDone ? 0.3 : 0.1, transition: 'opacity .3s' }}>
                <span style={{ fontSize: 10, color: isActive ? '#f59e0b' : isDone ? '#444' : '#222', minWidth: 10 }}>{isActive ? '›' : isDone ? '✓' : '·'}</span>
                <span style={{ fontSize: 8, color: isActive ? '#bbb' : '#444', textTransform: 'uppercase', letterSpacing: '.07em' }}>{line}{isActive ? dots : ''}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ── Idle screen ───────────────────────────────────────────────────────────────

function IdleScreen() {
  return (
    <div style={{ position: 'absolute', inset: 0, zIndex: 80, background: '#0c0c0c', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', fontFamily: "'Courier New', monospace" }}>
      <style>{`@keyframes gm{from{background-position:0 0}to{background-position:40px 40px}}`}</style>
      <div style={{ position: 'absolute', inset: 0, opacity: .04, backgroundImage: 'linear-gradient(#f59e0b 1px,transparent 1px),linear-gradient(90deg,#f59e0b 1px,transparent 1px)', backgroundSize: '40px 40px', animation: 'gm 6s linear infinite', pointerEvents: 'none' }} />
      <div style={{ position: 'relative', zIndex: 1, textAlign: 'center', width: 320 }}>
        <div style={{ fontSize: 28, color: '#f59e0b', marginBottom: 18 }}>⊕</div>
        <div style={{ fontSize: 10, fontWeight: 700, color: '#f59e0b', textTransform: 'uppercase', letterSpacing: '.18em', marginBottom: 6 }}>SVG Snap Engine</div>
        <p style={{ fontSize: 8, color: '#444', textTransform: 'uppercase', letterSpacing: '.1em', margin: '12px 0 20px', lineHeight: 2 }}>Load a floor plan SVG to begin</p>
        <p style={{ fontSize: 8, color: '#222', textTransform: 'uppercase', letterSpacing: '.07em', marginTop: 20, lineHeight: 2 }}>Hover: reveal snaps · Click: snap / chain<br />Ctrl+scroll: zoom · Drag: pan</p>
      </div>
    </div>
  );
}

// ── Tooltip helpers ───────────────────────────────────────────────────────────

function TRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
      <span style={{ fontSize: 7, color: '#555', textTransform: 'uppercase', letterSpacing: '.07em' }}>{label}</span>
      <span style={{ fontSize: 8, color: '#e5e5e5', fontWeight: 700 }}>{value}</span>
    </div>
  );
}

function SnapTooltip({ point, pdfDims, pos }: { point: SvgSnapPoint | null; pdfDims: PdfDimensions | null; pos: { x: number; y: number } }) {
  if (!point || !pdfDims) return null;
  const col = SNAP_COLOURS[point.type];
  return (
    <div style={{ position: 'absolute', left: pos.x + 18, top: pos.y - 10, background: 'rgba(10,10,10,.97)', border: '1px solid #2a2a2a', padding: '9px 13px', pointerEvents: 'none', minWidth: 200, zIndex: 60 }}>
      <div style={{ fontSize: 8, color: col, textTransform: 'uppercase', letterSpacing: '.1em', marginBottom: 7, display: 'flex', alignItems: 'center', gap: 6 }}>
        <div style={{ width: 9, height: 9, borderRadius: 1, background: col, flexShrink: 0 }} />
        {point.type}
      </div>
      <div style={{ height: 1, background: '#1e1e1e', marginBottom: 7 }} />
      <TRow label="Shape"      value={point.shapeId.length > 20 ? point.shapeId.slice(0, 20) + '…' : point.shapeId} />
      <TRow label="Canvas XY"  value={`${(point.nx * pdfDims.w).toFixed(1)}, ${(point.ny * pdfDims.h).toFixed(1)}`} />
      <TRow label="Normalized" value={`${point.nx.toFixed(4)}, ${point.ny.toFixed(4)}`} />
      <TRow label="Stroke W"   value={`${point.strokeWidth.toFixed(1)}px`} />
    </div>
  );
}

// ── Flash ─────────────────────────────────────────────────────────────────────

interface Flash { id: number; x: number; y: number; color: string }

function SnapFlashes({ flashes }: { flashes: Flash[] }) {
  return (
    <>
      <style>{`@keyframes sfade{0%{opacity:.9;transform:scale(1)}100%{opacity:0;transform:scale(2.8)}}`}</style>
      {flashes.map(f => (
        <div key={f.id} style={{ position: 'absolute', left: f.x - 10, top: f.y - 10, width: 20, height: 20, borderRadius: '50%', background: f.color, animation: 'sfade .6s ease-out forwards', pointerEvents: 'none', zIndex: 50 }} />
      ))}
    </>
  );
}

// ── Chain sidebar ─────────────────────────────────────────────────────────────

function ChainSidebar({
  chain, pdfDims, onRemove, onJump,
}: {
  chain: ReturnType<typeof useSnapEngine>['linearChain'];
  pdfDims: PdfDimensions | null;
  onRemove: (i: number) => void;
  onJump: (i: number) => void;
}) {
  const totalLen = chain.length >= 2
    ? chain.reduce((sum, p, i) => i === 0 ? 0 : sum + Math.hypot(p.x - chain[i - 1].x, p.y - chain[i - 1].y), 0)
    : 0;

  return (
    <>
      <div style={{ padding: '8px 10px', borderBottom: '1px solid #1a1a1a', flexShrink: 0 }}>
        <div style={{ fontSize: 8, color: '#3a3a3a', textTransform: 'uppercase', letterSpacing: '.1em', marginBottom: 6 }}>Linear chain</div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'baseline' }}>
          <span style={{ fontSize: 8, color: '#555' }}>Pts</span>
          <span style={{ fontSize: 13, color: '#f59e0b', fontWeight: 700 }}>{chain.length}</span>
          <span style={{ fontSize: 8, color: '#555', marginLeft: 6 }}>Total</span>
          <span style={{ fontSize: 11, color: '#38bdf8', fontWeight: 700 }}>{chain.length >= 2 ? totalLen.toFixed(1) : '—'}</span>
        </div>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: 6, display: 'flex', flexDirection: 'column', gap: 2 }}>
        {chain.length === 0 ? (
          <p style={{ fontSize: 8, color: '#2a2a2a', textAlign: 'center', textTransform: 'uppercase', letterSpacing: '.08em', padding: '20px 8px', lineHeight: 2.2 }}>
            Enable Linear mode<br />click corners to chain
          </p>
        ) : (
          chain.map((p, i) => {
            const col = p.type !== 'free' ? SNAP_COLOURS[p.type as SvgSnapPoint['type']] : '#f59e0b';
            return (
              <React.Fragment key={i}>
                <div
                  onClick={() => onJump(i)}
                  style={{ border: '1px solid #1e1e1e', padding: '4px 6px', fontSize: 8, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6 }}
                >
                  <div style={{ width: 7, height: 7, borderRadius: '50%', background: col, flexShrink: 0 }} />
                  <span style={{ color: '#f59e0b', minWidth: 12 }}>{i + 1}</span>
                  <span style={{ flex: 1, color: '#555', fontSize: 7 }}>{p.x.toFixed(1)}, {p.y.toFixed(1)}</span>
                  <span
                    onClick={e => { e.stopPropagation(); onRemove(i); }}
                    style={{ color: '#2a2a2a', cursor: 'pointer', padding: '0 2px', fontSize: 11, lineHeight: 1 }}
                    title="remove"
                  >×</span>
                </div>
                {i > 0 && (
                  <div style={{ border: '1px solid #0e2a33', background: 'rgba(56,189,248,.02)', padding: '3px 6px', fontSize: 7, display: 'flex', justifyContent: 'space-between', marginLeft: 8 }}>
                    <span style={{ color: '#38bdf8' }}>{Math.hypot(p.x - chain[i - 1].x, p.y - chain[i - 1].y).toFixed(1)}</span>
                    <span style={{ color: '#333' }}>units</span>
                  </div>
                )}
              </React.Fragment>
            );
          })
        )}
      </div>
    </>
  );
}

// ── Snap point list sidebar ───────────────────────────────────────────────────

function PointItem({ point, pdfDims, isHighlighted, onClick }: { point: SvgSnapPoint; pdfDims: PdfDimensions | null; isHighlighted: boolean; onClick: () => void }) {
  const col = SNAP_COLOURS[point.type];
  const px  = pdfDims ? (point.nx * pdfDims.w).toFixed(1) : '—';
  const py  = pdfDims ? (point.ny * pdfDims.h).toFixed(1) : '—';
  return (
    <div onClick={onClick} style={{ border: `1px solid ${isHighlighted ? '#f59e0b' : '#1e1e1e'}`, padding: '5px 7px', fontSize: 9, cursor: 'pointer', background: isHighlighted ? 'rgba(245,158,11,.04)' : 'transparent', transition: 'border-color .1s' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
        <div style={{ width: 9, height: 9, borderRadius: 1, background: col, flexShrink: 0 }} />
        <span style={{ flex: 1, color: '#888', textTransform: 'uppercase', letterSpacing: '.05em' }}>{point.type}</span>
        <span style={{ fontSize: 7, border: '1px solid #2a2a2a', padding: '1px 4px', color: '#555', textTransform: 'uppercase' }}>{point.shapeId.length > 12 ? point.shapeId.slice(0, 12) + '…' : point.shapeId}</span>
      </div>
      <div style={{ paddingLeft: 15, fontSize: 7, color: '#444' }}>x:{px} y:{py} · sw:{point.strokeWidth.toFixed(1)}</div>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function SnapEnginePage() {
  const [svgContent,   setSvgContent]   = useState<string | null>(null);
  const [svgLines,     setSvgLines]     = useState<SvgLine[]>([]);
  const [pdfDims,      setPdfDims]      = useState<PdfDimensions | null>(null);
  const [fileName,     setFileName]     = useState('');
  const [isLoading,    setIsLoading]    = useState(false);
  const [isIdle,       setIsIdle]       = useState(true);
  const [status,       setStatus]       = useState('');
  const [zoom,         setZoom]         = useState(1);
  const [pan,          setPan]          = useState({ x: 0, y: 0 });
  const [snapEnabled,  setSnapEnabled]  = useState(true);
  const [showPins,     setShowPins]     = useState(true);
  const [snapThresh,   setSnapThresh]   = useState(22);
  const [showLines,    setShowLines]    = useState(true);
  const [proximityRadius, setProximityRadius] = useState(120);
  const [linearMode,   setLinearMode]   = useState(true);
  const [sidebarTab,   setSidebarTab]   = useState<'chain' | 'points'>('chain');
  const [highlightIdx, setHighlightIdx] = useState<number | null>(null);
  const [hoveredPoint, setHoveredPoint] = useState<SvgSnapPoint | null>(null);
  const [hoverPos,     setHoverPos]     = useState({ x: 0, y: 0 });
  const [flashes,      setFlashes]      = useState<Flash[]>([]);

  const viewportRef   = useRef<HTMLDivElement>(null);
  const wrapRef       = useRef<HTMLDivElement>(null);
  const baseCanvasRef = useRef<HTMLCanvasElement>(null);
  // FIX: pinCanvasRef is now a SIBLING of wrapRef (viewport-sized overlay),
  // NOT a child of wrapRef (which is CSS-scaled). This eliminates all blur.
  const pinCanvasRef  = useRef<HTMLCanvasElement>(null);
  const fileInputRef  = useRef<HTMLInputElement>(null);

  const pointerDownRef  = useRef(false);
  const isDraggingRef   = useRef(false);
  const dragRef         = useRef({ mx: 0, my: 0, px: 0, py: 0 });

  const panRef        = useRef(pan);
  const zoomRef       = useRef(zoom);
  const flashIdRef    = useRef(0);
  const pdfDimsRef    = useRef<PdfDimensions | null>(null);
  const pageNumberRef = useRef(1);

  useEffect(() => { panRef.current    = pan;     }, [pan]);
  useEffect(() => { zoomRef.current   = zoom;    }, [zoom]);
  useEffect(() => { pdfDimsRef.current = pdfDims; }, [pdfDims]);

  const snapPoints = useSvgSnapPoints(svgContent, pdfDims);

  const engine = useSnapEngine({
    pinCanvasRef:     pinCanvasRef as React.RefObject<HTMLCanvasElement>,
    viewportRef:      viewportRef  as React.RefObject<HTMLDivElement>,
    pdfDimensionsRef: pdfDimsRef,
    pageNumberRef,
    snapEnabled,
    showPins,
    snapThreshold:    snapThresh,
    confidenceFilter: 0,
    proximityRadius,
    linearMode,
    svgSnapPoints:    snapPoints,
    svgLines:         showLines ? svgLines : [],
    svgAreas:         [],
    zoom,
    pan,
  });

  // Apply CSS transform only to the base-canvas wrapper — NOT the pin canvas
  useEffect(() => {
    if (wrapRef.current)
      wrapRef.current.style.transform = `translate(${pan.x}px,${pan.y}px) scale(${zoom})`;
  }, [pan, zoom]);

  const fitCanvas = useCallback(() => {
    const vp = viewportRef.current, bc = baseCanvasRef.current;
    if (!vp || !bc) return;
    const vr = vp.getBoundingClientRect();
    const fz = Math.min((vr.width * .9) / bc.width, (vr.height * .9) / bc.height, 2);
    setZoom(fz);
    setPan({ x: (vr.width - bc.width * fz) / 2, y: (vr.height - bc.height * fz) / 2 });
  }, []);

  const loadSvgText = useCallback(async (text: string, name: string) => {
    setFileName(name); setIsLoading(true); setIsIdle(false);
    await yieldFrame();
    try {
      const parser = new DOMParser();
      const doc    = parser.parseFromString(text, 'image/svg+xml');
      if (doc.querySelector('parsererror')) throw new Error('Invalid SVG');
      const svgEl  = doc.querySelector('svg') as SVGSVGElement | null;
      if (!svgEl) throw new Error('No <svg> element');

      let w = 800, h = 600;
      const vb = svgEl.getAttribute('viewBox');
      if (vb) {
        const parts = vb.trim().split(/[\s,]+/).map(parseFloat);
        if (parts.length >= 4 && parts[2] > 0 && parts[3] > 0) { w = parts[2]; h = parts[3]; }
      } else {
        const wa = parseFloat(svgEl.getAttribute('width')  ?? '0'); if (wa > 0) w = wa;
        const ha = parseFloat(svgEl.getAttribute('height') ?? '0'); if (ha > 0) h = ha;
      }

      const dims: PdfDimensions = { w, h };
      setPdfDims(dims); pdfDimsRef.current = dims;

      const lines = extractSvgLines(text, w, h);
      setSvgLines(lines);

      const blob = new Blob([text], { type: 'image/svg+xml' });
      const url  = URL.createObjectURL(blob);
      const img  = new Image();
      await new Promise<void>((res, rej) => {
        img.onload  = () => res();
        img.onerror = () => rej(new Error('Render failed'));
        img.src = url;
      });
      URL.revokeObjectURL(url);

      // Draw base canvas at native SVG resolution — no DPR scaling here,
      // the base canvas is purely for raster reference; the pin canvas handles crisp overlay.
      const bc = baseCanvasRef.current!; bc.width = w; bc.height = h;
      const ctx = bc.getContext('2d')!;
      ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);

      setSvgContent(text);
      engine.clearChain();
      setIsLoading(false);
      fitCanvas();
      setStatus(`Loaded · ${w.toFixed(0)}×${h.toFixed(0)}px · ${lines.length} line segs · parsing snaps…`);
    } catch (err) {
      setIsLoading(false); setIsIdle(true);
      setStatus(`Error: ${(err as Error).message}`);
    }
  }, [fitCanvas, engine]);

  useEffect(() => {
    if (snapPoints.length === 0 || !pdfDims) return;
    const counts  = snapPoints.reduce((acc, p) => { acc[p.type] = (acc[p.type] ?? 0) + 1; return acc; }, {} as Record<string, number>);
    const summary = (Object.entries(counts) as [string, number][]).map(([k, v]) => `${k}:${v}`).join(' · ');
    setStatus(`${snapPoints.length} snap pts · ${svgLines.length} line segs — ${summary}`);
  }, [snapPoints, pdfDims, svgLines.length]);

  const handleUpload = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]; if (!file) return;
    e.target.value = '';
    const reader = new FileReader();
    reader.onload = ev => loadSvgText(ev.target!.result as string, file.name);
    reader.readAsText(file);
  }, [loadSvgText]);

  // getCanvasXY: returns SVG-unit coordinates from a pointer event
  const getCanvasXY = useCallback((e: React.PointerEvent | MouseEvent) => {
    const vr = viewportRef.current!.getBoundingClientRect();
    return {
      x: (e.clientX - vr.left - panRef.current.x) / zoomRef.current,
      y: (e.clientY - vr.top  - panRef.current.y) / zoomRef.current,
    };
  }, []);

  // getViewportXY: returns CSS-pixel coordinates relative to the viewport
  const getViewportXY = useCallback((e: React.PointerEvent | MouseEvent) => {
    const vr = viewportRef.current!.getBoundingClientRect();
    return { x: e.clientX - vr.left, y: e.clientY - vr.top };
  }, []);

  const findNearestSnapPoint = useCallback((svgX: number, svgY: number): SvgSnapPoint | null => {
    if (!pdfDimsRef.current || snapPoints.length === 0) return null;
    const dims  = pdfDimsRef.current;
    // threshold in SVG units
    const limit = snapThresh / zoomRef.current;
    let best: SvgSnapPoint | null = null, bestD = limit;
    for (const p of snapPoints) {
      const px = p.nx * dims.w, py = p.ny * dims.h;
      const d  = Math.hypot(px - svgX, py - svgY);
      if (d < bestD) { bestD = d; best = p; }
    }
    return best;
  }, [snapPoints, snapThresh]);

  // ── Pointer handlers ──────────────────────────────────────────────────────

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return;
    pointerDownRef.current = true;
    isDraggingRef.current  = false;
    dragRef.current = { mx: e.clientX, my: e.clientY, px: panRef.current.x, py: panRef.current.y };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }, []);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (pointerDownRef.current && !isDraggingRef.current) {
      const dx = e.clientX - dragRef.current.mx;
      const dy = e.clientY - dragRef.current.my;
      if (Math.hypot(dx, dy) > DRAG_THRESHOLD) isDraggingRef.current = true;
    }

    if (isDraggingRef.current) {
      setPan({ x: dragRef.current.px + (e.clientX - dragRef.current.mx), y: dragRef.current.py + (e.clientY - dragRef.current.my) });
      return;
    }

    if (!pdfDimsRef.current) return;
    const cxy = getCanvasXY(e);
    const vxy = getViewportXY(e);
    engine.cursorPointRef.current = cxy;
    const result    = engine.snapToCorner(cxy.x, cxy.y);
    const snappedPt = result.snapped ? findNearestSnapPoint(result.point.x, result.point.y) : null;
    setHoveredPoint(snappedPt);
    setHoverPos(vxy);
    engine.redrawPinCanvas();
  }, [engine, getCanvasXY, getViewportXY, findNearestSnapPoint]);

  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    const wasActualDrag = isDraggingRef.current;
    pointerDownRef.current = false;
    isDraggingRef.current  = false;

    if (wasActualDrag) return;
    if (!pdfDimsRef.current) return;

    const cxy    = getCanvasXY(e);
    const vxy    = getViewportXY(e);
    const result = engine.snapToCorner(cxy.x, cxy.y);

    if (linearMode) {
      const snappedPt = result.snapped ? findNearestSnapPoint(result.point.x, result.point.y) : null;
      const px = result.snapped ? result.point.x : cxy.x;
      const py = result.snapped ? result.point.y : cxy.y;
      engine.addChainPoint(px, py, snappedPt?.type ?? 'free');
      const color = snappedPt ? SNAP_COLOURS[snappedPt.type] : '#f59e0b';
      const id    = ++flashIdRef.current;
      setFlashes(prev => [...prev, { id, x: vxy.x, y: vxy.y, color }]);
      setTimeout(() => setFlashes(prev => prev.filter(f => f.id !== id)), 700);
      setStatus(`Chain pt added: (${px.toFixed(1)}, ${py.toFixed(1)})${snappedPt ? ' · ' + snappedPt.type : ' · free'}`);
    } else {
      if (!result.snapped) return;
      const snappedPt = findNearestSnapPoint(result.point.x, result.point.y);
      const color     = snappedPt ? SNAP_COLOURS[snappedPt.type] : '#f59e0b';
      const id        = ++flashIdRef.current;
      setFlashes(prev => [...prev, { id, x: vxy.x, y: vxy.y, color }]);
      setTimeout(() => setFlashes(prev => prev.filter(f => f.id !== id)), 700);
      engine.triggerSnapFlash(result.point.x, result.point.y);
      setStatus(`Snapped → ${snappedPt?.type ?? 'point'} · (${result.point.x.toFixed(1)}, ${result.point.y.toFixed(1)})`);
    }
  }, [linearMode, snapPoints, engine, getCanvasXY, getViewportXY, findNearestSnapPoint]);

  const handlePointerLeave = useCallback(() => {
    pointerDownRef.current = false;
    isDraggingRef.current  = false;
    setHoveredPoint(null);
    engine.cursorPointRef.current = null;
    engine.redrawPinCanvas();
  }, [engine]);

  const wheelRef = useRef<(e: WheelEvent) => void>(() => {});
  useEffect(() => {
    wheelRef.current = (e: WheelEvent) => {
      e.preventDefault();
      const vp = viewportRef.current; if (!vp) return;
      const vr = vp.getBoundingClientRect();
      if (e.ctrlKey) {
        const mx = e.clientX - vr.left, my = e.clientY - vr.top;
        const f  = e.deltaY > 0 ? .9 : 1.1;
        setZoom(z => {
          const nz = Math.min(20, Math.max(0.05, z * f));
          setPan(p => ({ x: mx - (mx - p.x) * (nz / z), y: my - (my - p.y) * (nz / z) }));
          return nz;
        });
      } else {
        setPan(p => ({ x: p.x - e.deltaX, y: p.y - e.deltaY }));
      }
      engine.redrawPinCanvas();
    };
  });
  useEffect(() => {
    const vp = viewportRef.current; if (!vp) return;
    const h = (e: WheelEvent) => wheelRef.current(e);
    vp.addEventListener('wheel', h, { passive: false });
    return () => vp.removeEventListener('wheel', h);
  }, []);

  useEffect(() => { engine.redrawPinCanvas(); }, [zoom, pan, showLines, engine]);

  const jumpToPoint = useCallback((idx: number) => {
    const p = snapPoints[idx]; if (!p || !pdfDims) return;
    setHighlightIdx(idx);
    const px = p.nx * pdfDims.w, py = p.ny * pdfDims.h;
    const vr = viewportRef.current!.getBoundingClientRect();
    setPan({ x: (vr.width / 2) - px * zoomRef.current, y: (vr.height / 2) - py * zoomRef.current });
    const color = SNAP_COLOURS[p.type];
    const id    = ++flashIdRef.current;
    setFlashes(prev => [...prev, { id, x: vr.width / 2, y: vr.height / 2, color }]);
    setTimeout(() => setFlashes(prev => prev.filter(f => f.id !== id)), 700);
    engine.redrawPinCanvas();
  }, [snapPoints, pdfDims, engine]);

  const jumpToChainPoint = useCallback((idx: number) => {
    const p = engine.linearChain[idx]; if (!p) return;
    const vr = viewportRef.current!.getBoundingClientRect();
    setPan({ x: (vr.width / 2) - p.x * zoomRef.current, y: (vr.height / 2) - p.y * zoomRef.current });
    engine.redrawPinCanvas();
  }, [engine]);

  const removeChainPoint = useCallback((idx: number) => {
    const updated = engine.linearChain.filter((_, i) => i !== idx);
    engine.clearChain();
    updated.forEach(p => engine.addChainPoint(p.x, p.y, p.type));
  }, [engine]);

  const typeCounts = snapPoints.reduce((acc, p) => { acc[p.type] = (acc[p.type] ?? 0) + 1; return acc; }, {} as Record<string, number>);
  const cursor     = isDraggingRef.current ? 'grabbing' : pdfDims ? 'crosshair' : 'default';

  return (
    <div style={S.root}>
      {/* Toolbar */}
      <div style={S.toolbar}>
        <span style={{ fontSize: 9, fontWeight: 700, color: '#555', textTransform: 'uppercase', letterSpacing: '.1em', marginRight: 4 }}>⊕ Snap Engine</span>
        <div style={S.sep} />
        <label style={{ fontSize: 8, textTransform: 'uppercase', letterSpacing: '.07em', border: '1px solid #383838', background: 'transparent', color: '#999', padding: '3px 9px', cursor: 'pointer', fontFamily: 'inherit', flexShrink: 0 }}>
          ↑ Load SVG
          <input ref={fileInputRef} type="file" accept=".svg" style={{ display: 'none' }} onChange={handleUpload} />
        </label>
        <div style={S.sep} />
        <button onClick={() => setSnapEnabled(v => !v)} style={tbBtn(snapEnabled)}>Snap {snapEnabled ? '●' : '○'}</button>
        <button onClick={() => setShowPins(v => !v)}    style={tbBtn(showPins)}>Pins {showPins ? '●' : '○'}</button>
        <button onClick={() => setShowLines(v => !v)}   style={tbBtn(showLines, '#38bdf8')}>Lines {showLines ? '●' : '○'}</button>
        <div style={S.sep} />
        <button
          onClick={() => { setLinearMode(v => !v); setSidebarTab('chain'); }}
          style={tbBtn(linearMode, '#a78bfa')}
        >Linear {linearMode ? '●' : '○'}</button>
        {linearMode && (
          <>
            <button onClick={() => engine.undoChainPoint()} style={tbBtn(false)}>Undo</button>
            <button onClick={() => engine.clearChain()} style={{ ...tbBtn(false), color: '#f43f5e', borderColor: engine.linearChain.length > 0 ? '#f43f5e44' : '#2a2a2a' }}>Clear</button>
            <span style={{ fontSize: 8, border: '1px solid #2a2a2a', padding: '2px 6px', color: engine.linearChain.length > 0 ? '#a78bfa' : '#333' }}>
              {engine.linearChain.length} pts
            </span>
          </>
        )}
        <div style={S.sep} />
        <span style={S.lblStyle}>Threshold</span>
        <input type="range" min={8} max={80} step={1} value={snapThresh} onChange={e => setSnapThresh(+e.target.value)} style={{ width: 56, accentColor: '#f59e0b' }} />
        <span style={{ fontSize: 8, color: '#f59e0b', minWidth: 28 }}>{snapThresh}px</span>
        <div style={S.sep} />
        <span style={S.lblStyle}>Radius</span>
        <input type="range" min={40} max={300} step={5} value={proximityRadius} onChange={e => setProximityRadius(+e.target.value)} style={{ width: 56, accentColor: '#38bdf8' }} />
        <span style={{ fontSize: 8, color: '#38bdf8', minWidth: 32 }}>{proximityRadius}px</span>
        <div style={S.sep} />
        <span style={{ fontSize: 8, border: '1px solid #2a2a2a', padding: '2px 6px', color: snapPoints.length > 0 ? '#f59e0b' : '#333', letterSpacing: '.07em', flexShrink: 0 }}>
          {snapPoints.length} pts
        </span>
        <div style={{ flex: 1 }} />
        <span style={S.statusTxt}>{status}</span>
        <div style={S.sep} />
        <button onClick={() => setZoom(z => Math.max(.05, z * .85))} style={tbBtn(false)}>−</button>
        <span style={{ fontSize: 8, color: '#555', minWidth: 38, textAlign: 'center' }}>{Math.round(zoom * 100)}%</span>
        <button onClick={() => setZoom(z => Math.min(20, z * 1.15))} style={tbBtn(false)}>+</button>
        <button onClick={fitCanvas} style={tbBtn(false)}>⊡</button>
      </div>

      {/* Main */}
      <div style={S.main}>
        {/* Viewport */}
        <div
          ref={viewportRef}
          style={{ ...S.viewport, cursor }}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerLeave={handlePointerLeave}
          onContextMenu={e => e.preventDefault()}
        >
          {isIdle    && <IdleScreen />}
          {isLoading && <LoadingOverlay active={isLoading} fileName={fileName} />}

          {/* Base canvas: inside wrapRef so it zooms/pans with CSS transform */}
          <div ref={wrapRef} style={S.canvasWrap}>
            <canvas ref={baseCanvasRef} style={{ display: 'block', imageRendering: 'auto' }} />
          </div>

          {/*
            FIX: Pin canvas is NOT inside wrapRef.
            It is a viewport-sized overlay drawn in physical pixels.
            The engine converts SVG-unit snap point coords → viewport pixels
            using zoom/pan, so it always aligns perfectly and is never blurry.
          */}
          <canvas
            ref={pinCanvasRef}
            style={{
              position: 'absolute',
              top: 0, left: 0,
              pointerEvents: 'none',
              // CSS size matches viewport; actual pixel size set by engine (×DPR)
              width: '100%',
              height: '100%',
            }}
          />

          <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 40 }}>
            <SnapFlashes flashes={flashes} />
          </div>

          <SnapTooltip point={hoveredPoint} pdfDims={pdfDims} pos={hoverPos} />

          {!isIdle && !isLoading && fileName && (
            <div style={{ position: 'absolute', bottom: 10, left: 10, background: 'rgba(255,255,255,.92)', border: '1px solid #ccc', padding: '3px 8px', fontSize: 9, color: '#666', textTransform: 'uppercase', letterSpacing: '.08em', pointerEvents: 'none' }}>
              {fileName}
            </div>
          )}

          {linearMode && (
            <div style={{ position: 'absolute', top: 10, left: 10, background: 'rgba(167,139,250,.15)', border: '1px solid rgba(167,139,250,.4)', padding: '3px 8px', fontSize: 8, color: '#a78bfa', textTransform: 'uppercase', letterSpacing: '.1em', pointerEvents: 'none' }}>
              Linear mode · click to chain
            </div>
          )}

          {hoveredPoint && pdfDims && (
            <div style={{ position: 'absolute', bottom: 10, right: 10, background: 'rgba(13,13,13,.95)', border: `1px solid ${SNAP_COLOURS[hoveredPoint.type]}44`, padding: '8px 12px', pointerEvents: 'none', minWidth: 180 }}>
              <div style={{ fontSize: 8, color: SNAP_COLOURS[hoveredPoint.type], textTransform: 'uppercase', letterSpacing: '.1em', marginBottom: 5, display: 'flex', alignItems: 'center', gap: 6 }}>
                <div style={{ width: 7, height: 7, borderRadius: 1, background: SNAP_COLOURS[hoveredPoint.type] }} />
                {hoveredPoint.type}
              </div>
              <div style={{ height: 1, background: '#1e1e1e', marginBottom: 6 }} />
              <TRow label="nx" value={hoveredPoint.nx.toFixed(5)} />
              <TRow label="ny" value={hoveredPoint.ny.toFixed(5)} />
              <TRow label="px" value={(hoveredPoint.nx * pdfDims.w).toFixed(1)} />
              <TRow label="py" value={(hoveredPoint.ny * pdfDims.h).toFixed(1)} />
            </div>
          )}
        </div>

        {/* Sidebar */}
        <div style={S.sidebar}>
          <div style={{ display: 'flex', borderBottom: '1px solid #1a1a1a', flexShrink: 0 }}>
            {(['chain', 'points'] as const).map(tab => (
              <button
                key={tab}
                onClick={() => setSidebarTab(tab)}
                style={{ flex: 1, fontSize: 8, textTransform: 'uppercase', letterSpacing: '.08em', padding: '6px 0', border: 'none', background: sidebarTab === tab ? '#111' : 'transparent', color: sidebarTab === tab ? (tab === 'chain' ? '#a78bfa' : '#f59e0b') : '#333', cursor: 'pointer', borderBottom: sidebarTab === tab ? `1px solid ${tab === 'chain' ? '#a78bfa' : '#f59e0b'}` : '1px solid transparent', fontFamily: 'inherit' }}
              >
                {tab === 'chain' ? `Chain (${engine.linearChain.length})` : `Snaps (${snapPoints.length})`}
              </button>
            ))}
          </div>

          {sidebarTab === 'chain' ? (
            <ChainSidebar
              chain={engine.linearChain}
              pdfDims={pdfDims}
              onRemove={removeChainPoint}
              onJump={jumpToChainPoint}
            />
          ) : (
            <>
              <div style={{ padding: 10, borderBottom: '1px solid #1a1a1a' }}>
                <div style={S.sbLabel}>Snap types</div>
                {(Object.entries(SNAP_COLOURS) as [SvgSnapPoint['type'], string][]).map(([type, col]) => (
                  <div key={type} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 5 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <div style={{ width: 9, height: 9, borderRadius: 2, background: col, flexShrink: 0 }} />
                      <span style={{ fontSize: 8, color: '#777', textTransform: 'uppercase', letterSpacing: '.06em' }}>{type}</span>
                    </div>
                    <span style={{ fontSize: 8, color: '#444' }}>{typeCounts[type] ?? 0}</span>
                  </div>
                ))}
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 3 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <div style={{ width: 9, height: 3, background: '#38bdf8', flexShrink: 0 }} />
                    <span style={{ fontSize: 8, color: '#777', textTransform: 'uppercase', letterSpacing: '.06em' }}>lines</span>
                  </div>
                  <span style={{ fontSize: 8, color: '#444' }}>{svgLines.length}</span>
                </div>
              </div>

              <div style={{ padding: '6px 10px', borderBottom: '1px solid #1a1a1a' }}>
                <span style={{ fontSize: 8, color: '#3a3a3a', textTransform: 'uppercase', letterSpacing: '.09em' }}>
                  Points ({snapPoints.length}{snapPoints.length > 300 ? ', showing 300' : ''})
                </span>
              </div>

              <div style={{ flex: 1, overflowY: 'auto', padding: 6, display: 'flex', flexDirection: 'column', gap: 3 }}>
                {snapPoints.length === 0
                  ? <p style={{ fontSize: 8, color: '#2a2a2a', textAlign: 'center', textTransform: 'uppercase', letterSpacing: '.08em', padding: '28px 8px', lineHeight: 2.2 }}>Load an SVG to see<br />detected snap points</p>
                  : snapPoints.slice(0, 300).map((p, i) => (
                    <PointItem key={`${p.nx.toFixed(5)}-${p.ny.toFixed(5)}-${p.type}-${i}`} point={p} pdfDims={pdfDims} isHighlighted={highlightIdx === i} onClick={() => jumpToPoint(i)} />
                  ))
                }
              </div>
            </>
          )}
        </div>
      </div>

      {/* Status bar */}
      <div style={S.statusbar}>
        {(linearMode
          ? ['Hover: reveal snaps', 'Click: add chain point', 'Ctrl+scroll: zoom', 'Drag: pan']
          : ['Hover: reveal snaps', 'Click: snap indicator', 'Ctrl+scroll: zoom', 'Drag: pan']
        ).map((h, i) => (
          <React.Fragment key={h}>
            {i > 0 && <div style={S.barSep} />}
            <span style={{ fontSize: 8, color: '#2e2e2e', textTransform: 'uppercase', letterSpacing: '.07em' }}>{h}</span>
          </React.Fragment>
        ))}
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 8, color: '#2e2e2e', textTransform: 'uppercase', letterSpacing: '.07em' }}>{fileName}</span>
      </div>
    </div>
  );
}