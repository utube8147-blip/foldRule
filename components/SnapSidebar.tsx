'use client';

import type { SnapPoint, PdfDimensions, SelectedEntity } from '@/types/snapTypes';
import type { UseSnapEngineReturn } from '@/hooks/useSnapEngine';

const SNAP_COLOURS: Record<SnapPoint['type'], string> = {
  endpoint: '#f59e0b',
  midpoint: '#10b981',
  centroid: '#8b5cf6',
  intersection: '#f43f5e',
  'curve-node': '#38bdf8',
};

const SNAP_LABELS: Record<SnapPoint['type'], string> = {
  endpoint: 'Endpoints',
  midpoint: 'Midpoints',
  centroid: 'Centroids',
  intersection: 'Intersections',
  'curve-node': 'Curve nodes',
};

const SELECT_KIND_COLOURS: Record<SelectedEntity['kind'], string> = {
  line: '#38bdf8',
  curve: '#38bdf8',
  snap: '#f59e0b',
};

const SELECT_KIND_LABELS: Record<SelectedEntity['kind'], string> = {
  line: 'Line',
  curve: 'Curve / arc',
  snap: 'Snap point',
};

function TypeCountRow({ type, count }: { type: SnapPoint['type']; count: number }) {
  return (
    <div className="flex items-center justify-between mb-[5px]">
      <div className="flex items-center gap-2">
        <div className="w-[9px] h-[9px] rounded-[2px] flex-shrink-0" style={{ background: SNAP_COLOURS[type] }} />
        <span className="text-[8px] text-[#777] uppercase tracking-[.06em]">{SNAP_LABELS[type]}</span>
      </div>
      <span className="text-[8px] text-[#444]">{count}</span>
    </div>
  );
}

function ChainRow({
  point,
  index,
  prevPoint,
  onJump,
  onRemove,
}: {
  point: { x: number; y: number; type: SnapPoint['type'] | 'free' };
  index: number;
  prevPoint: { x: number; y: number } | null;
  onJump: () => void;
  onRemove: () => void;
}) {
  const col = point.type !== 'free' ? SNAP_COLOURS[point.type as SnapPoint['type']] : '#f59e0b';
  const dist = prevPoint ? Math.hypot(point.x - prevPoint.x, point.y - prevPoint.y) : null;
  return (
    <>
      <div
        onClick={onJump}
        className="border border-[#1e1e1e] px-[6px] py-[4px] text-[8px] cursor-pointer flex items-center gap-[6px] hover:border-[#333]"
      >
        <div className="w-[7px] h-[7px] rounded-full flex-shrink-0" style={{ background: col }} />
        <span className="text-[#f59e0b] min-w-[12px]">{index + 1}</span>
        <span className="flex-1 text-[#555] text-[7px]">
          {point.x.toFixed(1)}, {point.y.toFixed(1)}
        </span>
        <span
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          className="text-[#2a2a2a] cursor-pointer px-[2px] text-[11px] leading-none hover:text-[#f43f5e]"
          title="remove"
        >
          ×
        </span>
      </div>
      {dist !== null && (
        <div className="border border-[#0e2a33] bg-[rgba(56,189,248,.02)] px-[6px] py-[3px] text-[7px] flex justify-between ml-[8px]">
          <span className="text-[#38bdf8]">{dist.toFixed(1)}</span>
          <span className="text-[#333]">pt units</span>
        </div>
      )}
    </>
  );
}

function SelectionPanel({
  selected,
  onJump,
  onClear,
}: {
  selected: SelectedEntity | null;
  onJump: () => void;
  onClear: () => void;
}) {
  if (!selected) {
    return (
      <p className="text-[8px] text-[#2a2a2a] text-center uppercase tracking-[.08em] px-[8px] py-[28px] leading-[2.2]">
        Click a line, curve, arc
        <br />
        or snap point to select it
      </p>
    );
  }

  const colour = SELECT_KIND_COLOURS[selected.kind];

  return (
    <div className="p-[10px] flex flex-col gap-[10px]">
      <div className="border border-[#1e1e1e] px-[10px] py-[10px]">
        <div className="flex items-center gap-[7px] mb-[8px]">
          <div className="w-[9px] h-[9px] rounded-[2px] flex-shrink-0" style={{ background: colour }} />
          <span className="text-[9px] uppercase tracking-[.08em] font-bold" style={{ color: colour }}>
            {SELECT_KIND_LABELS[selected.kind]}
          </span>
        </div>

        <div className="flex flex-col gap-[5px] text-[8px]">
          <div className="flex justify-between">
            <span className="text-[#555] uppercase tracking-[.05em]">Source</span>
            <span className="text-[#888]">{selected.sourceId.length > 16 ? selected.sourceId.slice(0, 16) + '…' : selected.sourceId}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-[#555] uppercase tracking-[.05em]">Position</span>
            <span className="text-[#888]">{selected.x.toFixed(1)}, {selected.y.toFixed(1)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-[#555] uppercase tracking-[.05em]">Stroke width</span>
            <span className="text-[#888]">{selected.strokeWidth.toFixed(2)}</span>
          </div>
          {selected.kind === 'line' && selected.length !== undefined && (
            <div className="flex justify-between">
              <span className="text-[#555] uppercase tracking-[.05em]">Length</span>
              <span className="text-[#38bdf8]">{selected.length.toFixed(1)} pt units</span>
            </div>
          )}
          {selected.kind === 'curve' && selected.approxLength !== undefined && (
            <div className="flex justify-between">
              <span className="text-[#555] uppercase tracking-[.05em]">Approx. length</span>
              <span className="text-[#38bdf8]">{selected.approxLength.toFixed(1)} pt units</span>
            </div>
          )}
          {selected.kind === 'snap' && selected.snapType && (
            <div className="flex justify-between">
              <span className="text-[#555] uppercase tracking-[.05em]">Snap type</span>
              <span style={{ color: SNAP_COLOURS[selected.snapType] }}>{SNAP_LABELS[selected.snapType]}</span>
            </div>
          )}
        </div>
      </div>

      <div className="flex gap-[6px]">
        <button
          onClick={onJump}
          className="flex-1 text-[8px] uppercase tracking-[.07em] border border-[#2a2a2a] text-[#999] px-[8px] py-[5px] hover:border-[#444]"
        >
          Jump to
        </button>
        <button
          onClick={onClear}
          className="flex-1 text-[8px] uppercase tracking-[.07em] border border-[#3a1f24] text-[#f43f5e] px-[8px] py-[5px] hover:border-[#f43f5e44]"
        >
          Clear
        </button>
      </div>

      <p className="text-[7px] text-[#2e2e2e] uppercase tracking-[.06em] leading-[1.8] px-[2px]">
        Click empty space, press Esc, or click another item to change the selection.
      </p>
    </div>
  );
}

export function SnapSidebar({
  engine,
  snapPoints,
  lineCount,
  curveCount,
  dims,
  tab,
  setTab,
  onJumpChain,
  onRemoveChain,
  onJumpSelection,
}: {
  engine: UseSnapEngineReturn;
  snapPoints: SnapPoint[];
  lineCount: number;
  curveCount: number;
  dims: PdfDimensions | null;
  tab: 'chain' | 'points' | 'select';
  setTab: (t: 'chain' | 'points' | 'select') => void;
  onJumpChain: (i: number) => void;
  onRemoveChain: (i: number) => void;
  onJumpSelection: () => void;
}) {
  const typeCounts = snapPoints.reduce((acc, p) => {
    acc[p.type] = (acc[p.type] ?? 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  const totalLen =
    engine.linearChain.length >= 2
      ? engine.linearChain.reduce(
          (sum, p, i) => (i === 0 ? 0 : sum + Math.hypot(p.x - engine.linearChain[i - 1].x, p.y - engine.linearChain[i - 1].y)),
          0,
        )
      : 0;

  return (
    <div className="w-[240px] bg-[#0f0f0f] border-l border-[#1e1e1e] flex flex-col flex-shrink-0 overflow-hidden">
      {/* sub-tabs */}
      <div className="flex border-b border-[#1a1a1a] flex-shrink-0">
        {([
          ['chain', 'Chain', '#a78bfa'],
          ['points', 'Points', '#f59e0b'],
          ['select', 'Select', '#ffffff'],
        ] as const).map(([key, label, color]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className="flex-1 text-[7px] uppercase tracking-[.05em] py-[6px] font-mono"
            style={{
              background: tab === key ? '#111' : 'transparent',
              color: tab === key ? color : '#333',
              borderBottom: tab === key ? `1px solid ${color}` : '1px solid transparent',
            }}
          >
            {label}
            {key === 'chain' ? ` (${engine.linearChain.length})` : ''}
            {key === 'points' ? ` (${snapPoints.length})` : ''}
            {key === 'select' && engine.selected ? ' (1)' : ''}
          </button>
        ))}
      </div>

      {tab === 'chain' && (
        <>
          <div className="px-[10px] py-[8px] border-b border-[#1a1a1a] flex-shrink-0">
            <div className="text-[8px] text-[#3a3a3a] uppercase tracking-[.1em] mb-[4px]">Linear Chain</div>
            <div className="flex gap-[10px] items-baseline">
              <span className="text-[8px] text-[#555]">Pts</span>
              <span className="text-[13px] text-[#f59e0b] font-bold">{engine.linearChain.length}</span>
              <span className="text-[8px] text-[#555] ml-[6px]">Total</span>
              <span className="text-[11px] text-[#38bdf8] font-bold">
                {engine.linearChain.length >= 2 ? totalLen.toFixed(1) : '—'}
              </span>
            </div>
          </div>
          <div className="flex-1 overflow-y-auto p-[6px] flex flex-col gap-[2px]">
            {engine.linearChain.length === 0 ? (
              <p className="text-[8px] text-[#2a2a2a] text-center uppercase tracking-[.08em] px-[8px] py-[20px] leading-[2.2]">
                Click corners on the plan
                <br />
                to build a chain
              </p>
            ) : (
              engine.linearChain.map((p, i) => (
                <ChainRow
                  key={i}
                  point={p}
                  index={i}
                  prevPoint={i > 0 ? engine.linearChain[i - 1] : null}
                  onJump={() => onJumpChain(i)}
                  onRemove={() => onRemoveChain(i)}
                />
              ))
            )}
          </div>
        </>
      )}

      {tab === 'points' && (
        <>
          <div className="p-[10px] border-b border-[#1a1a1a]">
            <div className="text-[8px] text-[#3a3a3a] uppercase tracking-[.1em] mb-[6px]">Snap types</div>
            {(Object.keys(SNAP_COLOURS) as SnapPoint['type'][]).map((type) => (
              <TypeCountRow key={type} type={type} count={typeCounts[type] ?? 0} />
            ))}
            <div className="flex items-center justify-between mt-[3px]">
              <div className="flex items-center gap-2">
                <div className="w-[9px] h-[3px] bg-[#38bdf8] flex-shrink-0" />
                <span className="text-[8px] text-[#777] uppercase tracking-[.06em]">lines</span>
              </div>
              <span className="text-[8px] text-[#444]">{lineCount}</span>
            </div>
            <div className="flex items-center justify-between mt-[3px]">
              <div className="flex items-center gap-2">
                <div className="w-[9px] h-[3px] bg-[#38bdf8] rounded-[1px] flex-shrink-0 opacity-60" />
                <span className="text-[8px] text-[#777] uppercase tracking-[.06em]">curves</span>
              </div>
              <span className="text-[8px] text-[#444]">{curveCount}</span>
            </div>
          </div>
          <div className="px-[10px] py-[6px] border-b border-[#1a1a1a]">
            <span className="text-[8px] text-[#3a3a3a] uppercase tracking-[.09em]">
              Points ({snapPoints.length}{snapPoints.length > 300 ? ', showing 300' : ''})
            </span>
          </div>
          <div className="flex-1 overflow-y-auto p-[6px] flex flex-col gap-[3px]">
            {snapPoints.length === 0 ? (
              <p className="text-[8px] text-[#2a2a2a] text-center uppercase tracking-[.08em] px-[8px] py-[28px] leading-[2.2]">
                Load a PDF to see
                <br />
                detected snap points
              </p>
            ) : (
              snapPoints.slice(0, 300).map((p, i) => {
                const px = dims ? (p.nx * dims.w).toFixed(1) : '—';
                const py = dims ? (p.ny * dims.h).toFixed(1) : '—';
                return (
                  <div key={`${p.nx.toFixed(5)}-${p.ny.toFixed(5)}-${p.type}-${i}`} className="border border-[#1e1e1e] px-[7px] py-[5px] text-[9px]">
                    <div className="flex items-center gap-[6px] mb-[3px]">
                      <div className="w-[9px] h-[9px] rounded-[1px] flex-shrink-0" style={{ background: SNAP_COLOURS[p.type] }} />
                      <span className="flex-1 text-[#888] uppercase tracking-[.05em]">{p.type}</span>
                      <span className="text-[7px] border border-[#2a2a2a] px-[4px] py-[1px] text-[#555] uppercase">
                        {p.sourceId.length > 12 ? p.sourceId.slice(0, 12) + '…' : p.sourceId}
                      </span>
                    </div>
                    <div className="pl-[15px] text-[7px] text-[#444]">
                      x:{px} y:{py} · sw:{p.strokeWidth.toFixed(1)}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </>
      )}

      {tab === 'select' && (
        <div className="flex-1 overflow-y-auto">
          <SelectionPanel selected={engine.selected} onJump={onJumpSelection} onClear={engine.clearSelection} />
        </div>
      )}
    </div>
  );
}