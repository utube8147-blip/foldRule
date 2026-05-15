'use client';

// ─── app/svg-compare/page.tsx — Redesigned ───────────────────────────────────
//
// DESIGN:
//   • Dark industrial UI everywhere (bg, sidebar, toolbar, status bar)
//     — matches the Viewer.tsx aesthetic (bg-industrial-black, zinc palette,
//       font-mono, uppercase tracking-widest, 10px labels)
//   • Canvas only: warm white (#FAF9F7) with dot grid — drawings read on white
//   • Room fills: vivid high-chroma palette, fill-opacity reset to 1 on each
//     element, single layer-opacity multiplier. No double-stacking.
//   • Per-room color swatch in sidebar list matches canvas fill exactly.
//   • Room fill opacity: dedicated slider with gradient track in sidebar.
// ─────────────────────────────────────────────────────────────────────────────

import React, {
  useState, useEffect, useRef, useCallback,
} from 'react';
import {
  Eye, EyeOff, Upload, BarChart2,
  ZoomIn, ZoomOut, Maximize2, Info, Layers,
} from 'lucide-react';
import { cn } from '@/lib/utils';

// ─── Types ────────────────────────────────────────────────────────────────────

interface RoomSummary  { face_id: number; area: number; centroid: [number, number]; n_walls: number; }
interface WallSummary  { wall_id: string; orientation: 'H' | 'V' | 'D'; length: number; compass: string; }
interface GroupSummary { group_id: number; count: number; signature: number[]; template: { face_id: number; area: number }; }

interface Report {
  source:  string;
  summary: { elements_parsed: number; segments_final: number; rooms: number; walls: number; shape_groups: number; };
  rooms:   RoomSummary[];
  walls:   WallSummary[];
  groups:  GroupSummary[];
}

// ─── Room fill palette — vivid, high-chroma, clearly distinct ────────────────
// fill-opacity on each element is reset to 1.
// Only the layer group opacity controls overall transparency — no double-stacking.

const ROOM_PALETTE = [
  '#7C3AED', // violet
  '#0284C7', // sky
  '#059669', // emerald
  '#D97706', // amber
  '#DC2626', // red
  '#9333EA', // purple
  '#0891B2', // cyan
  '#16A34A', // green
  '#EA580C', // orange
  '#0EA5E9', // light blue
  '#CA8A04', // yellow
  '#C026D3', // fuchsia
];

function getRoomColor(index: number) {
  return ROOM_PALETTE[index % ROOM_PALETTE.length];
}

// ─── Annotation layers ────────────────────────────────────────────────────────

const ANNOT_LAYERS = [
  { id: 'rooms',       label: 'Room fills',   color: '#7C3AED' },
  { id: 'walls',       label: 'Wall lines',   color: '#60a5fa' },
  { id: 'room-labels', label: 'Room labels',  color: '#34d399' },
  { id: 'wall-labels', label: 'Wall labels',  color: '#fbbf24' },
  { id: 'legend',      label: 'Legend',       color: '#f87171' },
] as const;
type AnnotLayerId = typeof ANNOT_LAYERS[number]['id'];

const ORIENT_COLOR: Record<string, string> = { H: '#60a5fa', V: '#f87171', D: '#34d399' };

function formatArea(a: number) {
  return a >= 1000 ? `${(a / 1000).toFixed(2)}k` : a.toFixed(0);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function readFileAsText(file: File): Promise<string> {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload  = () => res(r.result as string);
    r.onerror = rej;
    r.readAsText(file);
  });
}

function namespaceIds(svgString: string, prefix: string): string {
  let out = svgString.replace(/\bid="([^"]+)"/g, `id="${prefix}-$1"`);
  out = out.replace(/url\(#([^)]+)\)/g, `url(#${prefix}-$1)`);
  out = out.replace(/(xlink:href|href)="#([^"]+)"/g, `$1="#${prefix}-$2"`);
  return out;
}

/**
 * Re-colorise every filled shape inside the room layer with vivid palette colors.
 * Resets fill-opacity + opacity to 1 on each element so only the layer-level
 * opacity (set separately) controls transparency. No double-stacking.
 */
function coloriseRoomFills(svg: SVGSVGElement, prefix: string) {
  const roomLayer = svg.getElementById(`${prefix}-layer-rooms`);
  if (!roomLayer) return;

  const shapes = Array.from(
    roomLayer.querySelectorAll('polygon, path, rect, circle, ellipse'),
  ).filter(el => {
    const fill = el.getAttribute('fill');
    return fill && fill !== 'none' && fill !== 'transparent';
  });

  shapes.forEach((el, i) => {
    (el as SVGElement).setAttribute('fill', getRoomColor(i));
    (el as SVGElement).setAttribute('fill-opacity', '1');
    (el as SVGElement).setAttribute('opacity', '1');
  });
}

function parseSvg(
  raw: string,
  idPrefix: string,
  isAnnotated: boolean,
): SVGSVGElement | null {
  const namespacedRaw = namespaceIds(raw, idPrefix);
  const parser = new DOMParser();
  const doc    = parser.parseFromString(namespacedRaw, 'image/svg+xml');
  if (doc.querySelector('parsererror')) return null;

  const svg = doc.querySelector('svg');
  if (!svg) return null;

  svg.setAttribute('width',  '100%');
  svg.setAttribute('height', '100%');
  svg.style.width    = '100%';
  svg.style.height   = '100%';
  svg.style.position = 'absolute';
  svg.style.inset    = '0';
  svg.style.backgroundColor = 'transparent';

  if (!isAnnotated) {
    svg.querySelectorAll('*').forEach(el => {
      if (!(el instanceof SVGElement)) return;
      const fill   = el.getAttribute('fill');
      const stroke = el.getAttribute('stroke');
      if (fill   && ['#000', '#000000', 'black'].includes(fill))   el.setAttribute('fill',   '#1C1917');
      if (stroke && ['#000', '#000000', 'black'].includes(stroke)) el.setAttribute('stroke', '#1C1917');
    });
  } else {
    coloriseRoomFills(svg as SVGSVGElement, idPrefix);

    // Single opacity on the layer — vivid colors at 55% are clearly readable
    const roomLayer = svg.getElementById(`${idPrefix}-layer-rooms`);
    if (roomLayer) roomLayer.setAttribute('opacity', '0.55');

    const wallLayer = svg.getElementById(`${idPrefix}-layer-walls`);
    if (wallLayer) wallLayer.setAttribute('opacity', '0.9');
  }

  return svg as SVGSVGElement;
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function SvgComparePage() {

  const [originalSvgRaw,  setOriginalSvgRaw]  = useState<string | null>(null);
  const [annotatedSvgRaw, setAnnotatedSvgRaw] = useState<string | null>(null);
  const [report,          setReport]          = useState<Report | null>(null);
  const [originalName,    setOriginalName]    = useState('original.svg');
  const [annotatedName,   setAnnotatedName]   = useState('annotated.svg');

  const [origVisible,  setOrigVisible]  = useState(true);
  const [annotVisible, setAnnotVisible] = useState(true);
  const [origOpacity,  setOrigOpacity]  = useState(1);
  const [annotOpacity, setAnnotOpacity] = useState(1);
  const [roomFillOpacity, setRoomFillOpacity] = useState(55);

  const [annotLayers, setAnnotLayers] = useState<Record<AnnotLayerId, boolean>>({
    'rooms':       true,
    'walls':       true,
    'room-labels': true,
    'wall-labels': false,
    'legend':      true,
  });

  const [zoom,       setZoom]       = useState(1);
  const [pan,        setPan]        = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const dragStart = useRef({ mx: 0, my: 0, px: 0, py: 0 });

  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [activeTab,   setActiveTab]   = useState<'rooms' | 'walls' | 'groups'>('rooms');

  const origContainerRef  = useRef<HTMLDivElement>(null);
  const annotContainerRef = useRef<HTMLDivElement>(null);

  // ── Inject original SVG ────────────────────────────────────────────────────

  useEffect(() => {
    const c = origContainerRef.current;
    if (!c) return;
    c.innerHTML = '';
    if (!originalSvgRaw) return;
    const svg = parseSvg(originalSvgRaw, 'orig', false);
    if (svg) c.appendChild(svg);
  }, [originalSvgRaw]);

  // ── Inject annotated SVG ───────────────────────────────────────────────────

  useEffect(() => {
    const c = annotContainerRef.current;
    if (!c) return;
    c.innerHTML = '';
    if (!annotatedSvgRaw) return;
    const svg = parseSvg(annotatedSvgRaw, 'annot', true);
    if (svg) {
      c.appendChild(svg);
      ANNOT_LAYERS.forEach(({ id }) => {
        const el = svg.getElementById(`annot-layer-${id}`);
        if (el) el.style.display = annotLayers[id] ? '' : 'none';
      });
      const roomLayer = svg.getElementById('annot-layer-rooms');
      if (roomLayer) roomLayer.setAttribute('opacity', String(roomFillOpacity / 100));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [annotatedSvgRaw]);

  // ── Sync annotation layer visibility ──────────────────────────────────────

  useEffect(() => {
    const svg = annotContainerRef.current?.querySelector('svg');
    if (!svg) return;
    ANNOT_LAYERS.forEach(({ id }) => {
      const el = svg.getElementById(`annot-layer-${id}`);
      if (el) el.style.display = annotLayers[id] ? '' : 'none';
    });
  }, [annotLayers]);

  // ── Room fill opacity live-sync ────────────────────────────────────────────

  useEffect(() => {
    const svg = annotContainerRef.current?.querySelector('svg');
    if (!svg) return;
    const layer = svg.getElementById('annot-layer-rooms');
    if (layer) layer.setAttribute('opacity', String(roomFillOpacity / 100));
  }, [roomFillOpacity]);

  // ── Upload handlers ────────────────────────────────────────────────────────

  const handleOrigUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]; if (!file) return;
    setOriginalName(file.name);
    setOriginalSvgRaw(await readFileAsText(file));
  }, []);

  const handleAnnotUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]; if (!file) return;
    setAnnotatedName(file.name);
    setAnnotatedSvgRaw(await readFileAsText(file));
  }, []);

  const handleReportUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]; if (!file) return;
    try { setReport(JSON.parse(await readFileAsText(file)) as Report); } catch { /* ignore */ }
  }, []);

  const toggleAnnotLayer = (id: AnnotLayerId) =>
    setAnnotLayers(prev => ({ ...prev, [id]: !prev[id] }));

  // ── Pan / zoom ─────────────────────────────────────────────────────────────

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    setZoom(z => Math.min(10, Math.max(0.1, z * (e.deltaY > 0 ? 0.9 : 1.1))));
  }, []);

  const handlePointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    setIsDragging(true);
    dragStart.current = { mx: e.clientX, my: e.clientY, px: pan.x, py: pan.y };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }, [pan]);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!isDragging) return;
    setPan({ x: dragStart.current.px + e.clientX - dragStart.current.mx, y: dragStart.current.py + e.clientY - dragStart.current.my });
  }, [isDragging]);

  const handlePointerUp = useCallback(() => setIsDragging(false), []);
  const resetView = () => { setZoom(1); setPan({ x: 0, y: 0 }); };

  const hasAny = !!originalSvgRaw || !!annotatedSvgRaw;
  const stats  = report?.summary;

  // ─────────────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col h-screen overflow-hidden bg-industrial-black font-mono text-zinc-300">

      {/* ── Toolbar — matches Viewer.tsx header style ─────────────────────── */}
      <header className="flex-shrink-0 h-11 bg-industrial-panel border-b border-industrial-border flex items-center px-4 gap-2 z-50 shadow-sm">

        <div className="flex items-center gap-2 mr-2 flex-shrink-0">
          <div className="w-5 h-5 bg-zinc-700 border border-zinc-600 flex items-center justify-center">
            <Layers className="w-3 h-3 text-zinc-300" />
          </div>
          <span className="text-[10px] font-bold text-zinc-400 uppercase tracking-widest">SVG Viewer</span>
        </div>

        <div className="w-px h-4 bg-industrial-border flex-shrink-0" />

        <label className="flex items-center gap-1.5 px-2.5 py-1 border border-zinc-700 text-zinc-400 hover:text-zinc-200 hover:border-zinc-500 cursor-pointer text-[9px] uppercase tracking-widest transition-all">
          <Upload className="w-3 h-3" /> Original
          <input type="file" accept=".svg" className="hidden" onChange={handleOrigUpload} />
        </label>

        <label className="flex items-center gap-1.5 px-2.5 py-1 border border-amber-500/50 text-amber-400 hover:bg-amber-500/10 hover:border-amber-400 cursor-pointer text-[9px] uppercase tracking-widest transition-all">
          <Upload className="w-3 h-3" /> Annotated
          <input type="file" accept=".svg" className="hidden" onChange={handleAnnotUpload} />
        </label>

        <label className="flex items-center gap-1.5 px-2.5 py-1 border border-zinc-700 text-zinc-400 hover:text-zinc-200 hover:border-zinc-500 cursor-pointer text-[9px] uppercase tracking-widest transition-all">
          <BarChart2 className="w-3 h-3" /> Report
          <input type="file" accept=".json" className="hidden" onChange={handleReportUpload} />
        </label>

        <div className="w-px h-4 bg-industrial-border flex-shrink-0" />

        {/* Layer visibility + opacity */}
        {[
          { label: originalName.replace(/\.svg$/i, ''), color: '#60a5fa', visible: origVisible, setV: setOrigVisible, opacity: origOpacity, setO: setOrigOpacity },
          { label: annotatedName.replace(/\.svg$/i, ''), color: '#fbbf24', visible: annotVisible, setV: setAnnotVisible, opacity: annotOpacity, setO: setAnnotOpacity },
        ].map(({ label, color, visible, setV, opacity, setO }) => (
          <div key={label} className="flex items-center gap-1.5">
            <button
              onClick={() => setV(!visible)}
              className={cn(
                'flex items-center gap-1.5 px-2 py-1 border text-[9px] uppercase tracking-widest transition-all',
                visible ? 'border-zinc-600 text-zinc-300' : 'border-zinc-800 text-zinc-600 opacity-50',
              )}
            >
              <span className="w-2 h-2 rounded-sm inline-block" style={{ backgroundColor: color }} />
              <span className="max-w-[72px] truncate">{label}</span>
              {visible ? <Eye className="w-3 h-3" /> : <EyeOff className="w-3 h-3" />}
            </button>
            <input
              type="range" min={0} max={100} step={1}
              value={Math.round(opacity * 100)}
              onChange={e => setO(+e.target.value / 100)}
              className="w-14 accent-zinc-400"
            />
            <span className="text-[9px] text-zinc-600 w-7">{Math.round(opacity * 100)}%</span>
          </div>
        ))}

        <div className="flex-1" />

        <button onClick={() => setZoom(z => Math.max(0.1, z - 0.2))} className="p-1 text-zinc-500 hover:text-zinc-200 transition-colors"><ZoomOut className="w-3.5 h-3.5" /></button>
        <span className="text-[9px] text-zinc-500 w-10 text-center">{Math.round(zoom * 100)}%</span>
        <button onClick={() => setZoom(z => Math.min(10, z + 0.2))} className="p-1 text-zinc-500 hover:text-zinc-200 transition-colors"><ZoomIn className="w-3.5 h-3.5" /></button>
        <button onClick={resetView} className="p-1 text-zinc-500 hover:text-zinc-200 transition-colors" title="Reset view"><Maximize2 className="w-3.5 h-3.5" /></button>

        <div className="w-px h-4 bg-industrial-border" />

        <button
          onClick={() => setSidebarOpen(s => !s)}
          className="p-1.5 text-zinc-500 hover:text-amber-400 border border-zinc-800 hover:border-zinc-600 transition-all"
        >
          <Layers className="w-3.5 h-3.5" />
        </button>
      </header>

      {/* ── Stats bar ─────────────────────────────────────────────────────── */}
      {stats && (
        <div className="flex-shrink-0 h-7 bg-industrial-black border-b border-industrial-border flex items-center px-5 gap-6">
          {[
            ['Elements', stats.elements_parsed.toLocaleString()],
            ['Segments', stats.segments_final.toLocaleString()],
            ['Rooms',    String(stats.rooms)],
            ['Walls',    stats.walls.toLocaleString()],
            ['Groups',   String(stats.shape_groups)],
          ].map(([label, value]) => (
            <div key={label} className="flex items-center gap-1.5">
              <span className="text-[8px] text-zinc-600 uppercase tracking-widest">{label}:</span>
              <span className="text-[9px] text-amber-400 font-bold">{value}</span>
            </div>
          ))}
        </div>
      )}

      {/* ── Main ─────────────────────────────────────────────────────────── */}
      <div className="flex flex-1 overflow-hidden min-h-0">

        {/* ── Canvas — ONLY this area is light ────────────────────────────── */}
        <div
          className="flex-1 relative overflow-hidden select-none"
          style={{
            background: '#FAF9F7',
            cursor: isDragging ? 'grabbing' : 'grab',
            backgroundImage: 'radial-gradient(circle, #D6D3CD 1px, transparent 1px)',
            backgroundSize: '24px 24px',
          }}
          onWheel={handleWheel}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
        >
          {!hasAny ? (
            <div className="absolute inset-0 flex items-center justify-center">
              <div className="border border-dashed border-zinc-300 bg-white/80 p-10 flex flex-col items-center gap-4 max-w-sm text-center">
                <Layers className="w-8 h-8 text-zinc-400" />
                <p className="text-xs font-bold text-zinc-500 uppercase tracking-widest font-mono">No SVG loaded</p>
                <p className="text-[10px] text-zinc-400 leading-relaxed font-sans">
                  Upload your original and annotated SVG files using the toolbar above.
                </p>
                <p className="text-[9px] text-zinc-300 uppercase tracking-widest font-mono">Drag to pan · Scroll to zoom</p>
              </div>
            </div>
          ) : (
            <div
              className="absolute inset-0"
              style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`, transformOrigin: 'center center', willChange: 'transform' }}
            >
              <div ref={origContainerRef}  className="absolute inset-0" style={{ opacity: origVisible  ? origOpacity  : 0, transition: 'opacity 0.15s', pointerEvents: 'none' }} />
              <div ref={annotContainerRef} className="absolute inset-0" style={{ opacity: annotVisible ? annotOpacity : 0, transition: 'opacity 0.15s', pointerEvents: 'none' }} />
            </div>
          )}

          {originalSvgRaw && (
            <div className="absolute top-3 left-3 z-10 pointer-events-none">
              <span className="bg-white/90 border border-zinc-300 text-zinc-600 text-[9px] font-mono px-2 py-1 uppercase tracking-widest shadow-sm">
                {originalName}
              </span>
            </div>
          )}
          {annotatedSvgRaw && (
            <div className="absolute top-3 right-3 z-10 pointer-events-none">
              <span className="bg-white/90 border border-amber-400/60 text-amber-700 text-[9px] font-mono px-2 py-1 uppercase tracking-widest shadow-sm">
                {annotatedName}
              </span>
            </div>
          )}
        </div>

        {/* ── Sidebar — dark industrial, matches Viewer.tsx ────────────────── */}
        {sidebarOpen && (
          <div className="flex-shrink-0 w-64 bg-industrial-panel border-l border-industrial-border flex flex-col overflow-hidden">

            <div className="flex-shrink-0 border-b border-industrial-border p-3">
              <p className="text-[9px] text-zinc-600 uppercase tracking-widest mb-2 font-bold">
                Annotation layers
              </p>
              <div className="flex flex-col gap-1">
                {ANNOT_LAYERS.map(layer => (
                  <button
                    key={layer.id}
                    onClick={() => toggleAnnotLayer(layer.id)}
                    className={cn(
                      'flex w-full items-center gap-2 px-2 py-1.5 border text-left transition-all',
                      annotLayers[layer.id]
                        ? 'border-zinc-700 bg-zinc-900 text-zinc-300'
                        : 'border-zinc-800 bg-transparent text-zinc-600 opacity-40',
                    )}
                  >
                    <span className="w-2 h-2 rounded-sm flex-shrink-0" style={{ backgroundColor: layer.color }} />
                    <span className="text-[10px] flex-1 uppercase tracking-wider">{layer.label}</span>
                    {annotLayers[layer.id]
                      ? <Eye className="w-3 h-3 text-zinc-500" />
                      : <EyeOff className="w-3 h-3 text-zinc-700" />}
                  </button>
                ))}
              </div>

              {/* Room fill opacity — gradient track, violet accent */}
              <div className="mt-3 pt-3 border-t border-zinc-800">
                <div className="flex items-center justify-between mb-2">
                  <p className="text-[8px] text-zinc-600 uppercase tracking-widest">Room fill opacity</p>
                  <span className="text-[9px] font-bold text-violet-400">{roomFillOpacity}%</span>
                </div>
                <div className="relative h-5 flex items-center">
                  <div
                    className="absolute inset-x-0 h-1.5 rounded-full"
                    style={{ background: 'linear-gradient(to right, rgba(124,58,237,0.08), rgba(124,58,237,0.85))' }}
                  />
                  <input
                    type="range" min={0} max={100} step={1}
                    value={roomFillOpacity}
                    onChange={e => setRoomFillOpacity(+e.target.value)}
                    className="relative w-full h-5 opacity-0 cursor-pointer"
                    style={{ zIndex: 2 }}
                  />
                  <div
                    className="absolute w-3 h-3 rounded-full bg-violet-500 border border-violet-300/30 shadow pointer-events-none"
                    style={{ left: `calc(${roomFillOpacity}% - 6px)`, zIndex: 1 }}
                  />
                </div>
                <div className="flex justify-between mt-1">
                  <span className="text-[8px] text-zinc-700">transparent</span>
                  <span className="text-[8px] text-zinc-700">solid</span>
                </div>
              </div>
            </div>

            {/* Report tabs */}
            {report ? (
              <>
                <div className="flex-shrink-0 flex border-b border-industrial-border">
                  {(['rooms', 'walls', 'groups'] as const).map(tab => (
                    <button
                      key={tab}
                      onClick={() => setActiveTab(tab)}
                      className={cn(
                        'flex-1 py-2 text-[9px] uppercase tracking-widest font-bold border-b-2 transition-all',
                        activeTab === tab
                          ? 'border-amber-400 text-amber-400'
                          : 'border-transparent text-zinc-600 hover:text-zinc-400',
                      )}
                    >
                      {tab}
                    </button>
                  ))}
                </div>

                <div className="flex-1 overflow-y-auto">
                  {activeTab === 'rooms' && (
                    <div className="p-2 flex flex-col gap-1">
                      {report.rooms.map((room, i) => (
                        <div key={room.face_id} className="flex items-center gap-2 px-2 py-2 border border-zinc-800 hover:border-zinc-700 hover:bg-zinc-900/50 transition-all">
                          {/* Tall swatch — exact same color as canvas fill */}
                          <span
                            className="w-1.5 h-8 rounded-sm flex-shrink-0"
                            style={{ backgroundColor: getRoomColor(i) }}
                          />
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center justify-between">
                              <span className="text-[10px] font-bold text-zinc-300">
                                R{String(room.face_id).padStart(2, '0')}
                              </span>
                              <span className="text-[9px] text-zinc-600">{formatArea(room.area)} u²</span>
                            </div>
                            <div className="flex gap-2 mt-0.5">
                              <span className="text-[8px] text-zinc-700">{room.n_walls} walls</span>
                              <span className="text-[8px] text-zinc-700">cx={room.centroid[0].toFixed(0)} cy={room.centroid[1].toFixed(0)}</span>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}

                  {activeTab === 'walls' && (
                    <div className="p-2 flex flex-col gap-1">
                      <p className="text-[8px] text-zinc-700 px-1 mb-1">First 200 of {report.walls.length.toLocaleString()}</p>
                      {report.walls.slice(0, 200).map(wall => (
                        <div key={wall.wall_id} className="flex items-center gap-2 px-2 py-1 border border-zinc-800">
                          <span className="w-1.5 h-1.5 rounded-sm flex-shrink-0" style={{ backgroundColor: ORIENT_COLOR[wall.orientation] ?? '#888' }} />
                          <span className="text-[9px] text-zinc-500 w-14 flex-shrink-0">{wall.wall_id}</span>
                          <span className="text-[9px] text-zinc-400 flex-1">{wall.length.toFixed(1)} u</span>
                          <span className="text-[8px] text-zinc-600">{wall.compass}</span>
                          <span className="text-[8px] font-bold" style={{ color: ORIENT_COLOR[wall.orientation] ?? '#888' }}>{wall.orientation}</span>
                        </div>
                      ))}
                    </div>
                  )}

                  {activeTab === 'groups' && (
                    <div className="p-2 flex flex-col gap-2">
                      {report.groups.length === 0
                        ? <p className="text-[9px] text-zinc-700 px-1 py-4 text-center">No repeated shape groups detected.</p>
                        : report.groups.map((grp, i) => (
                          <div key={grp.group_id} className="border border-zinc-800 p-2">
                            <div className="flex items-center gap-2 mb-1">
                              <span className="w-3 h-3 rounded-sm" style={{ backgroundColor: `hsl(${(i * 67) % 360},60%,65%)` }} />
                              <span className="text-[10px] font-bold text-zinc-200">Group {grp.group_id}</span>
                              <span className="text-[9px] text-amber-400 font-bold ml-auto">×{grp.count}</span>
                            </div>
                            <div className="flex gap-4 text-[8px] text-zinc-600">
                              <span>Template: R{grp.template.face_id}</span>
                              <span>Area: {formatArea(grp.template.area)} u²</span>
                            </div>
                          </div>
                        ))
                      }
                    </div>
                  )}
                </div>
              </>
            ) : (
              <div className="flex-1 flex flex-col items-center justify-center gap-3 p-6 text-center">
                <Info className="w-6 h-6 text-zinc-700" />
                <p className="text-[9px] text-zinc-700 leading-relaxed uppercase tracking-widest">
                  Upload <span className="text-zinc-500">_report.json</span> to see room & wall details.
                </p>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── Status bar — matches Viewer.tsx footer exactly ───────────────── */}
      <footer className="flex-shrink-0 h-10 bg-industrial-panel border-t border-industrial-border px-4 flex items-center justify-between z-20 shadow-sm">
        <div className="flex items-center gap-4 text-[9px] text-zinc-500 uppercase tracking-widest">
          <span>Drag to pan</span>
          <div className="w-px h-3 bg-industrial-border" />
          <span>Scroll to zoom</span>
        </div>
        <div className="flex items-center gap-3 text-[9px] uppercase tracking-widest">
          <span className="text-zinc-600">{originalName}</span>
          <div className="w-px h-3 bg-industrial-border" />
          <span className="text-amber-500/70">{annotatedName}</span>
        </div>
      </footer>
    </div>
  );
}