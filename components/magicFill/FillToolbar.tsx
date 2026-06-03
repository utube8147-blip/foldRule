'use client';

import React, { useState } from 'react';
import { COLORS, fmtArea, fmtPerim, Fill, LoadStage } from '@/hooks/fill/magicFill/usePdfFill';


// ── Shared micro-styles ───────────────────────────────────────────────────────

export const lblStyle: React.CSSProperties = {
  fontSize: 8, color: '#444', textTransform: 'uppercase',
  letterSpacing: '.08em', whiteSpace: 'nowrap',
};

export const uploadStyle: React.CSSProperties = {
  fontSize: 8, textTransform: 'uppercase', letterSpacing: '.07em',
  border: '1px solid #383838', background: 'transparent', color: '#999',
  padding: '3px 9px', cursor: 'pointer', fontFamily: 'inherit',
  flexShrink: 0, whiteSpace: 'nowrap',
};

export function tbBtn(active: boolean): React.CSSProperties {
  return {
    fontSize: 8, textTransform: 'uppercase', letterSpacing: '.07em',
    border: `1px solid ${active ? '#f59e0b' : '#2a2a2a'}`,
    background: active ? 'rgba(245,158,11,.07)' : 'transparent',
    color: active ? '#f59e0b' : '#777',
    padding: '3px 7px', cursor: 'pointer', fontFamily: 'inherit',
    whiteSpace: 'nowrap', flexShrink: 0,
  };
}

export const Sep = () => (
  <div style={{ width: 1, height: 18, background: '#222', flexShrink: 0 }}/>
);

// ── Scale bar ─────────────────────────────────────────────────────────────────

function ScaleBar({ pxPerM, onChange }: { pxPerM: number | null; onChange: (v: number | null) => void }) {
  const [raw,     setRaw]     = useState('');
  const [editing, setEditing] = useState(false);
  const commit = () => {
    const n = parseFloat(raw);
    onChange(isFinite(n) && n > 0 ? n : null);
    setEditing(false);
  };
  return (
    <div style={{ display:'flex', alignItems:'center', gap:4, flexShrink:0 }}>
      <span style={lblStyle}>px/m</span>
      {editing ? (
        <input
          autoFocus value={raw}
          onChange={e => setRaw(e.target.value)}
          onBlur={commit}
          onKeyDown={e => { if (e.key==='Enter') commit(); if (e.key==='Escape') setEditing(false); }}
          style={{ width:52, fontSize:8, fontFamily:'inherit', background:'#111', color:'#f59e0b', border:'1px solid #f59e0b', padding:'2px 4px', textAlign:'right' }}
          placeholder="e.g. 120"
        />
      ) : (
        <button
          onClick={() => { setRaw(pxPerM != null ? String(pxPerM) : ''); setEditing(true); }}
          style={{ ...tbBtn(pxPerM != null), minWidth:52, textAlign:'right' as const }}>
          {pxPerM != null ? pxPerM : '— set —'}
        </button>
      )}
      {pxPerM != null && (
        <button onClick={() => onChange(null)} style={{ ...tbBtn(false), color:'#555', padding:'3px 4px' }}>✕</button>
      )}
    </div>
  );
}

// ── Props ─────────────────────────────────────────────────────────────────────

interface FillToolbarProps {
  // identity
  isSvgMode: boolean;
  loadStage: LoadStage;
  fileName: string;
  // tool state
  mode: 'fill' | 'pan';
  setMode: (m: 'fill' | 'pan') => void;
  batchMode: boolean;
  setBatchMode: (v: boolean) => void;
  batchModeRef: React.MutableRefObject<boolean>;
  spaceHeld: boolean;
  activeColor: string;
  setActiveColor: (c: string) => void;
  fillOpacity: number;
  setFillOpacity: (v: number) => void;
  showPolygon: boolean;
  setShowPolygon: (v: boolean) => void;
  pxPerM: number | null;
  setPxPerM: (v: number | null) => void;
  // zoom
  zoom: number;
  setZoom: (fn: (z: number) => number) => void;
  centerCanvas: () => void;
  // fills
  fills: Fill[];
  hasSelection: boolean;
  selectedFill: Fill | null;
  selectedGroup: number | null;
  groupFills: Fill[];
  isFilling: boolean;
  status: string;
  // actions
  handleUndo: () => void;
  handleFillHoles: () => void;
  handleClearAll: () => void;
  // file input ref
  fileInputRef: React.RefObject<HTMLInputElement>;
  handleUpload: (e: React.ChangeEvent<HTMLInputElement>) => void;
}

// ── Component ─────────────────────────────────────────────────────────────────

export function FillToolbar({
  isSvgMode, loadStage, fileName,
  mode, setMode,
  batchMode, setBatchMode, batchModeRef,
  spaceHeld,
  activeColor, setActiveColor,
  fillOpacity, setFillOpacity,
  showPolygon, setShowPolygon,
  pxPerM, setPxPerM,
  zoom, setZoom, centerCanvas,
  fills, hasSelection, selectedFill, selectedGroup, groupFills,
  isFilling, status,
  handleUndo, handleFillHoles, handleClearAll,
  fileInputRef, handleUpload,
}: FillToolbarProps) {
  return (
    <div style={{
      display:'flex', alignItems:'center', gap:5,
      padding:'5px 10px', background:'#0d0d0d',
      borderBottom:'1px solid #222', flexShrink:0, height:42,
      flexWrap:'nowrap', overflow:'hidden',
    }}>
      {/* Brand */}
      <span style={{ fontSize:9, fontWeight:700, color:'#555', textTransform:'uppercase', letterSpacing:'.1em', marginRight:4 }}>
        ⊕ FloodFill
        {isSvgMode && (
          <span style={{ marginLeft:6, color:'#34d399', fontSize:7, border:'1px solid rgba(52,211,153,.4)', padding:'1px 4px' }}>VEC</span>
        )}
      </span>
      <Sep/>

      {/* Load */}
      <label style={uploadStyle}>
        ↑ Load PDF / SVG
        <input
          ref={fileInputRef} type="file" accept=".pdf,.svg"
          style={{ display:'none' }} onChange={handleUpload}
        />
      </label>
      <Sep/>

      {/* Mode */}
      {(['fill','pan'] as const).map(m => (
        <button key={m} onClick={() => setMode(m)} style={tbBtn(mode === m)}>
          {m === 'fill' ? 'Fill ⊕' : 'Pan ⊙'}
        </button>
      ))}

      {/* Batch toggle */}
      {mode === 'fill' && (
        <button
          onClick={() => { const next = !batchMode; setBatchMode(next); batchModeRef.current = next; }}
          style={{ ...tbBtn(batchMode), color:batchMode?'#60a5fa':'#555', borderColor:batchMode?'rgba(96,165,250,.6)':'#2a2a2a', background:batchMode?'rgba(96,165,250,.08)':'transparent' }}
          title="Double-click canvas to toggle">
          ⊞ Batch {batchMode ? '●' : '○'}
        </button>
      )}

      {/* Space-select indicator */}
      {mode === 'fill' && spaceHeld && (
        <span style={{ fontSize:7, color:'#60a5fa', border:'1px solid rgba(96,165,250,.4)', padding:'2px 6px', textTransform:'uppercase', letterSpacing:'.08em', flexShrink:0 }}>
          ␣ Select
        </span>
      )}
      <Sep/>

      {/* Colour palette */}
      <div style={{ display:'flex', gap:3, alignItems:'center' }}>
        {COLORS.map(c => (
          <button key={c} onClick={() => setActiveColor(c)} style={{
            width:15, height:15, borderRadius:2, background:c, cursor:'pointer', flexShrink:0,
            border: activeColor === c ? '2px solid #fff' : '2px solid transparent',
            transform: activeColor === c ? 'scale(1.3)' : 'scale(1)',
            transition: 'transform .1s',
          }}/>
        ))}
      </div>
      <Sep/>

      {/* Opacity */}
      <span style={lblStyle}>Opacity</span>
      <input
        type="range" min={10} max={100} step={1} value={fillOpacity}
        onChange={e => setFillOpacity(+e.target.value)}
        style={{ width:60, accentColor:'#f59e0b' }}
      />
      <span style={{ fontSize:8, color:'#f59e0b', fontWeight:700, minWidth:28 }}>{fillOpacity}%</span>
      <Sep/>

      {/* Outline toggle */}
      <button onClick={() => setShowPolygon(!showPolygon)} style={tbBtn(showPolygon)}>
        Outline {showPolygon ? '●' : '○'}
      </button>
      <Sep/>

      {/* Scale */}
      <ScaleBar pxPerM={pxPerM} onChange={setPxPerM}/>
      <Sep/>

      {/* Action buttons */}
      {fills.length > 0 && (
        <button onClick={handleUndo} style={tbBtn(false)}>↩ Undo</button>
      )}

      {fills.length > 0 && (
        <button onClick={handleClearAll} style={{ ...tbBtn(false), color:'#f87171' }}>✕ Clear</button>
      )}

      <div style={{ flex:1 }}/>

      {/* Status */}
      <span style={{ fontSize:8, color:'#555', textTransform:'uppercase', letterSpacing:'.07em', maxWidth:300, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
        {isFilling && <span style={{ color:'#f59e0b', marginRight:4 }}>●</span>}
        {status}
      </span>
      <Sep/>

      {/* Zoom */}
      <button onClick={() => setZoom(z => Math.max(0.05, z * .85))} style={tbBtn(false)}>−</button>
      <span style={{ fontSize:8, color:'#555', minWidth:36, textAlign:'center' }}>{Math.round(zoom * 100)}%</span>
      <button onClick={() => setZoom(z => Math.min(20, z * 1.15))} style={tbBtn(false)}>+</button>
      <button onClick={centerCanvas} style={tbBtn(false)} title="Fit">⊡</button>
    </div>
  );
}
