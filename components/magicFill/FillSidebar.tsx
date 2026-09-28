// components/magicFill/FillSidebar.tsx
'use client';

import React from 'react';
import { Fill, fmtArea, fmtPerim } from '@/hooks/fill/magicFill/usePdfFill';

// ── Small reusable rows ───────────────────────────────────────────────────────

export function MeasRow({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div style={{ display:'flex', justifyContent:'space-between', alignItems:'baseline', marginBottom:3 }}>
      <span style={{ fontSize:8, color:'#555', textTransform:'uppercase', letterSpacing:'.07em' }}>{label}</span>
      <div style={{ textAlign:'right' }}>
        <span style={{ fontSize:9, color:'#e5e5e5', fontWeight:700 }}>{value}</span>
        {sub && <div style={{ fontSize:7, color:'#333' }}>{sub}</div>}
      </div>
    </div>
  );
}

function FillMeasRow({ icon, label, value }: { icon: string; label: string; value: string }) {
  return (
    <div style={{ display:'flex', alignItems:'center', gap:4 }}>
      <span style={{ fontSize:7, color:'#2e2e2e', minWidth:10 }}>{icon}</span>
      <span style={{ fontSize:7, color:'#444', minWidth:36, textTransform:'uppercase' }}>{label}</span>
      <span style={{ fontSize:8, color:'#aaa', marginLeft:'auto' }}>{value}</span>
    </div>
  );
}

const sectionLabel: React.CSSProperties = {
  fontSize:8, color:'#3a3a3a', textTransform:'uppercase', letterSpacing:'.1em', marginBottom:8,
};

// ── Helpers ───────────────────────────────────────────────────────────────────

/** True corner count: uses svgCornerIndices for SVG fills, polygon.length for raster. */
function cornerCount(f: Fill): number {
  return f.svgCornerIndices ? f.svgCornerIndices.size : f.polygon.length;
}

// ── Props ─────────────────────────────────────────────────────────────────────

interface FillSidebarProps {
  activeColor: string;
  fillOpacity: number;
  fills: Fill[];
  hiddenIds: Set<number>;
  selectedId: number | null;
  selectedGroup: number | null;
  hoveredId: number | null;
  holesClosedIds: Set<number>;
  pxPerM: number | null;
  isSvgMode: boolean;
  svgFillsList: Fill[];
  setSelectedId: (id: number | null) => void;
  setSelectedGroup: (g: number | null) => void;
  toggleHidden: (id: number) => void;
  handleDeleteFill: (id: number) => void;
  onCloseHoles: (id: number) => void;
  handleExport: () => void;
  handleSvgExport: () => void;
}

// ── Component ─────────────────────────────────────────────────────────────────

export function FillSidebar({
  activeColor, fillOpacity,
  fills, hiddenIds, selectedId, selectedGroup, hoveredId, holesClosedIds,
  pxPerM, isSvgMode, svgFillsList,
  setSelectedId, setSelectedGroup, toggleHidden, handleDeleteFill,
  onCloseHoles,
  handleExport, handleSvgExport,
}: FillSidebarProps) {
  return (
    <div style={{
      width:220, background:'#0f0f0f', borderLeft:'1px solid #1e1e1e',
      display:'flex', flexDirection:'column', flexShrink:0, overflow:'hidden',
    }}>
      {/* Active fill swatch */}
      <div style={{ padding:10, borderBottom:'1px solid #1a1a1a' }}>
        <div style={sectionLabel}>Active fill</div>
        <div style={{ display:'flex', alignItems:'center', gap:8 }}>
          <div style={{ width:28, height:28, borderRadius:3, background:activeColor, border:'1px solid #333' }}/>
          <div>
            <div style={{ fontSize:10, color:'#ccc' }}>{activeColor}</div>
            <div style={{ fontSize:9, color:'#555' }}>{fillOpacity}% opacity</div>
          </div>
        </div>
      </div>

      {/* Quick help */}
      <div style={{ padding:'6px 10px', borderBottom:'1px solid #1a1a1a', background:'#16191C' }}>
        <div style={{ fontSize:7, color:'#2e2e2e', textTransform:'uppercase', letterSpacing:'.07em', lineHeight:2 }}>
          {isSvgMode ? (
            <>Click · fill vector shape<br/>Drag · pan canvas<br/>Space+drag · batch select shapes</>
          ) : (
            <>Left-click · fill single room<br/>Drag · pan canvas<br/>Space+drag · batch select</>
          )}
        </div>
      </div>

      {/* Totals */}
      {fills.length > 0 && (
        <div style={{ padding:10, borderBottom:'1px solid #1a1a1a' }}>
          <div style={sectionLabel}>Totals — {fills.length} fills</div>
          <MeasRow
            label="Area"
            value={fmtArea(fills.reduce((s,f) => s + f.areaPx, 0), pxPerM)}
            sub={`${fills.reduce((s,f) => s + f.areaPx, 0).toLocaleString()} px²`}
          />
          <MeasRow
            label="Perimeter"
            value={fmtPerim(fills.reduce((s,f) => s + f.perimPx, 0), pxPerM)}
            sub={`${fills.reduce((s,f) => s + f.perimPx, 0).toLocaleString()} px`}
          />
        </div>
      )}

      {/* Fills list header */}
      <div style={{ padding:'6px 10px', borderBottom:'1px solid #1a1a1a', display:'flex', alignItems:'center', justifyContent:'space-between' }}>
        <span style={{ fontSize:8, color:'#3a3a3a', textTransform:'uppercase', letterSpacing:'.09em' }}>Fills ({fills.length})</span>
        {isSvgMode && svgFillsList.length > 0 && (
          <span style={{ fontSize:7, color:'#34d399', border:'1px solid rgba(52,211,153,.3)', padding:'1px 5px' }}>
            {svgFillsList.length} vec
          </span>
        )}
      </div>

      {/* Fills list */}
      <div style={{ flex:1, overflowY:'auto', padding:6, display:'flex', flexDirection:'column', gap:3 }}>
        {fills.length === 0 ? (
          <p style={{ fontSize:8, color:'#2a2a2a', textAlign:'center', textTransform:'uppercase', letterSpacing:'.08em', padding:'28px 8px', lineHeight:2.2 }}>
            {isSvgMode
              ? 'Click a shape to fill it\nSpace+drag to select multiple'
              : 'Left-click to fill a room\nSpace+drag to select multiple'}
          </p>
        ) : fills.map(f => {
          const isGrouped = f.groupId != null;
          const isInSel   = f.id === selectedId || (selectedGroup != null && f.groupId === selectedGroup);
          return (
            <div
              key={f.id}
              onClick={() => { setSelectedId(f.id); setSelectedGroup(null); }}
              style={{
                border: `1px solid ${isInSel ? (isGrouped ? '#60a5fa' : '#F2C230') : hoveredId === f.id ? '#555' : '#1e1e1e'}`,
                padding: '5px 6px', fontSize:9,
                opacity: hiddenIds.has(f.id) ? .35 : 1,
                cursor: 'pointer',
                background: isInSel ? (isGrouped ? 'rgba(96,165,250,.04)' : 'rgba(242,194,48,.04)') : hoveredId === f.id ? 'rgba(255,255,255,.02)' : 'transparent',
                transition: 'border-color .1s,background .1s',
              }}
            >
              {/* Row header */}
              <div style={{ display:'flex', alignItems:'center', gap:6, marginBottom:3 }}>
                <div style={{ width:10, height:10, borderRadius:2, background:f.color, flexShrink:0 }}/>
                <span style={{ flex:1, color:'#777' }}>{f.label}</span>
                {f.svgMode && <span style={{ fontSize:6, color:'#34d399', border:'1px solid rgba(52,211,153,.3)', padding:'0 2px' }}>V</span>}
                {isGrouped && <span style={{ fontSize:7, color:'#60a5fa', padding:'1px 3px', border:'1px solid rgba(96,165,250,.3)' }}>G{f.groupId}</span>}
                <span style={{ color:'#444', fontSize:8 }}>{f.opacity}%</span>

                {/* Visibility toggle */}
                <button
                  onClick={e => { e.stopPropagation(); toggleHidden(f.id); }}
                  style={{ background:'none', border:'none', color:'#444', cursor:'pointer', fontSize:11, padding:'0 2px', lineHeight:1 }}>
                  {hiddenIds.has(f.id) ? '○' : '●'}
                </button>

                {/* Delete */}
                <button
                  onClick={e => { e.stopPropagation(); handleDeleteFill(f.id); }}
                  style={{ background:'none', border:'none', color:'#444', cursor:'pointer', fontSize:11, padding:'0 2px', lineHeight:1 }}>✕</button>
              </div>

              {/* Measurements */}
              <div style={{ paddingLeft:16, display:'flex', flexDirection:'column', gap:2 }}>
                <FillMeasRow icon="▣" label="Area"    value={fmtArea(f.areaPx,   pxPerM)}/>
                <FillMeasRow icon="◻" label="Perim"   value={fmtPerim(f.perimPx, pxPerM)}/>
                {/* Use svgCornerIndices.size for SVG fills so curve intermediates
                    are not counted — falls back to polygon.length for raster fills */}
                <FillMeasRow icon="⬡" label="Corners" value={String(cornerCount(f))}/>
              </div>

              {/* Close holes button — raster fills only */}
              {!f.svgMode && (
                <div style={{ paddingLeft:16, marginTop:4 }}>
                  <button
                    onClick={e => { e.stopPropagation(); onCloseHoles(f.id); }}
                    style={{
                      background:'none', border:'1px solid #2a2a2a', color: holesClosedIds.has(f.id) ? '#34d399' : '#555',
                      cursor:'pointer', fontSize:7, padding:'2px 6px', fontFamily:'inherit',
                      textTransform:'uppercase', letterSpacing:'.07em',
                    }}>
                    {holesClosedIds.has(f.id) ? '⊞ holes closed' : '⊞ close holes'}
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Export buttons */}
      {fills.length > 0 && (
        <div style={{ padding:8, borderTop:'1px solid #1a1a1a', flexShrink:0, display:'flex', flexDirection:'column', gap:4 }}>
          <button
            onClick={handleExport}
            style={{ width:'100%', fontSize:8, textTransform:'uppercase', letterSpacing:'.07em', border:'1px solid rgba(242,194,48,.4)', color:'#F2C230', background:'transparent', padding:'7px 0', cursor:'pointer', fontFamily:'inherit' }}
            onMouseEnter={e => (e.currentTarget.style.background = 'rgba(242,194,48,.07)')}
            onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
            ↓ Export PNG
          </button>
          {isSvgMode && svgFillsList.length > 0 && (
            <button
              onClick={handleSvgExport}
              style={{ width:'100%', fontSize:8, textTransform:'uppercase', letterSpacing:'.07em', border:'1px solid rgba(52,211,153,.4)', color:'#34d399', background:'transparent', padding:'7px 0', cursor:'pointer', fontFamily:'inherit' }}
              onMouseEnter={e => (e.currentTarget.style.background = 'rgba(52,211,153,.07)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
              ↓ Export SVG
            </button>
          )}
        </div>
      )}
    </div>
  );
}