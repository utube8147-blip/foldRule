'use client';

// ─── Tool rail with fly-out modes ──────────────────────────────────────────────────
//
//  The rail is organised by WHAT you measure, not by shape:
//
//      Select · Area · Length · Count · Magic fill · More
//
//  Each of Area / Length / Count offers a few ways to draw ("modes"). They open
//  in a panel beside the button when you hover it (or focus it), each with a
//  one-line "what do I click" hint; clicking the button itself re-uses the mode
//  last chosen there. A mode is just one of the underlying tools plus a DrawMode flag (see
//  lib/geometry/pathShapes.ts) — e.g. "Area · With curves" is the line+curve
//  path tool told to close into an area.

import React from 'react';
import {
  MousePointer2, Pentagon, Square, Circle, Hexagon, Spline, Pencil, Hash, MapPin, Grid3x3,
  Wand2, Minus, Plus, Route, CircleDashed,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ToolType } from '@/types';
import { AdvancedToolsDropdown } from './AdvancedToolsDropdown';
import { DEFAULT_DRAW_MODE, MIN_SIDES, MAX_SIDES, type DrawMode } from '@/lib/geometry/pathShapes';

interface Mode {
  key:   string;
  label: string;
  icon:  LucideIcon;
  tool:  ToolType;
  mode?: Partial<DrawMode>;
  /** Plain-language "what do I click". */
  hint:  string;
  shortcut?: string;
}

interface Group {
  id:       'select' | 'area' | 'length' | 'count' | 'magic';
  label:    string;
  icon:     LucideIcon;
  shortcut: string;
  /** What this group is for, shown in the rail tooltip. */
  about:    string;
  modes:    Mode[];
  /** Extra how-to lines for single-mode tools: [what, how]. */
  tips?:    [string, string][];
}

export const TOOL_GROUPS: Group[] = [
  {
    id: 'select', label: 'Select', icon: MousePointer2, shortcut: 'V',
    about: 'Pick and adjust what you have measured',
    modes: [{
      key: 'select', label: 'Select', icon: MousePointer2, tool: 'select',
      hint: 'Click a shape to select it and its row. Drag a corner to adjust it. Hold Space and drag to move the drawing.',
    }],
  },
  {
    id: 'area', label: 'Area', icon: Pentagon, shortcut: 'P',
    about: 'Floors, ceilings, slabs, walls in elevation',
    modes: [
      // One path tool for straight and curved edges: it starts straight, and A
      // switches the NEXT edge at any point — so you never have to restart a
      // shape because you picked the wrong kind of tool.
      { key: 'path', label: 'Draw outline', icon: Pentagon, tool: 'polyarc', mode: { area: true }, shortcut: 'P',
        hint: 'Click each corner; click the first corner again or press Enter to finish. Need a curved edge? Press A, click a point on the curve, then where it ends. A again goes back to straight.' },
      { key: 'rectangle', label: 'Rectangle', icon: Square, tool: 'rectangle', shortcut: 'R',
        hint: 'Click one corner, then the opposite corner.' },
      { key: 'circle', label: 'Circle', icon: Circle, tool: 'radius', mode: { area: true }, shortcut: 'C',
        hint: 'Click the centre, then the edge. Enter to finish.' },
      { key: 'regular', label: 'Regular', icon: Hexagon, tool: 'polygon', mode: { regular: true },
        hint: 'Set the number of sides, click the centre, then one corner.' },
    ],
  },
  {
    id: 'length', label: 'Length', icon: Pencil, shortcut: 'L',
    about: 'Walls, skirting, pipes, kerbs, edges',
    modes: [
      { key: 'path', label: 'Draw run', icon: Route, tool: 'polyarc', shortcut: 'L',
        hint: 'Click each point along the run; Enter to finish. Need a curved stretch? Press A, click a point on the curve, then where it ends. A again goes back to straight.' },
      { key: 'arc', label: 'Single arc', icon: Spline, tool: 'arc', shortcut: 'B',
        hint: 'Click the start, a point on the curve, then the end. Enter to finish.' },
      { key: 'circle', label: 'Circle', icon: CircleDashed, tool: 'radius',
        hint: 'Measures the distance around: click the centre, then the edge. Enter to finish.' },
    ],
  },
  {
    id: 'count', label: 'Count', icon: Hash, shortcut: 'N',
    about: 'Doors, fittings, sockets — anything you count',
    modes: [
      { key: 'count', label: 'Items', icon: Hash, tool: 'count', shortcut: 'N',
        hint: 'Click each item. Enter to finish the group.' },
      { key: 'grid', label: 'On a grid', icon: Grid3x3, tool: 'grid-count', shortcut: 'G',
        hint: 'Draw around an area — items are counted on an evenly spaced grid inside it (tiles, ceiling panels).' },
      { key: 'marker', label: 'Marker', icon: MapPin, tool: 'point', shortcut: 'T',
        hint: 'Click to drop a single reference marker.' },
    ],
  },
  {
    id: 'magic', label: 'Magic fill', icon: Wand2, shortcut: 'M',
    about: 'Click inside a room to measure it',
    modes: [{
      key: 'magic', label: 'Magic fill', icon: Wand2, tool: 'magic-fill', shortcut: 'M',
      hint: 'Rooms are found for you — point at one to see its outline.',
    }],
    tips: [
      ['One room', 'Click inside it.'],
      ['Several rooms at once', 'Hold Space and click points around them, then click the first point again. Every room the loop touches is filled.'],
      ['Keep them', 'Press Enter (or Finish) to add the fills to the takeoff.'],
    ],
  },
];

/**
 * The mode last chosen in each group, so the rail button reopens it. Recorded
 * only on an explicit pick (not derived while rendering: the tool and its draw
 * mode arrive in separate updates, and the in-between state is misleading).
 */
const lastPicked: Record<string, string> = {};

/** Which group and mode the current tool + draw mode correspond to. */
export function activeGroupAndMode(activeTool: string, drawMode: DrawMode): { group: Group; mode: Mode } | null {
  for (const group of TOOL_GROUPS) {
    for (const mode of group.modes) {
      if (mode.tool !== activeTool) continue;
      const want = { ...DEFAULT_DRAW_MODE, ...mode.mode };
      if (want.area === drawMode.area && want.regular === drawMode.regular) return { group, mode };
    }
  }
  return null;
}

interface CommonProps {
  activeTool:  ToolType;
  drawMode?:   DrawMode;
  setToolMode: (tool: ToolType, mode?: Partial<DrawMode>) => void;
}

// ─── Rail ────────────────────────────────────────────────────────────────────

export function ToolRail({
  activeTool, drawMode = DEFAULT_DRAW_MODE, setToolMode, setActiveTool, leading,
  polyarcMode, togglePolyarcMode,
}: CommonProps & {
  /** Plain tool switch, for the "More tools" menu. */
  setActiveTool: (tool: ToolType) => void;
  leading?: React.ReactNode;
  polyarcMode?: 'line' | 'arc';
  togglePolyarcMode?: () => void;
}) {
  const current = activeGroupAndMode(activeTool, drawMode);

  // Sub-options open beside a button while the pointer is over it (or it has
  // keyboard focus) and close shortly after leaving, so the pointer can travel
  // from the button into the panel.
  const [openId, setOpenId] = React.useState<string | null>(null);
  const closeTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelClose = () => { if (closeTimer.current) { clearTimeout(closeTimer.current); closeTimer.current = null; } };
  const open  = (id: string) => { cancelClose(); setOpenId(id); };
  const close = (delay = 180) => { cancelClose(); closeTimer.current = setTimeout(() => setOpenId(null), delay); };
  React.useEffect(() => cancelClose, []);

  const pickMode = (g: Group, m: Mode, keepOpen = false) => {
    lastPicked[g.id] = m.key;
    setToolMode(m.tool, m.mode);
    if (!keepOpen) { cancelClose(); setOpenId(null); }
  };

  return (
    <nav
      aria-label="Measuring tools"
      className="w-14 flex-shrink-0 bg-industrial-panel border-r border-industrial-border flex flex-col items-center gap-1 py-2 z-[60] relative"
      onKeyDown={e => { if (e.key === 'Escape') setOpenId(null); }}
    >
      {leading}
      {TOOL_GROUPS.map((g, i) => {
        const isActive = current?.group.id === g.id;
        const isOpen   = openId === g.id;
        const hasModes = g.modes.length > 1;
        const shown    = isActive ? current!.mode : (g.modes.find(x => x.key === lastPicked[g.id]) ?? g.modes[0]);
        return (
          <React.Fragment key={g.id}>
            {i === 1 && <div className="h-px w-8 bg-zinc-700/60 my-0.5" aria-hidden />}
            <div
              className="relative"
              onMouseEnter={() => open(g.id)}
              onMouseLeave={() => close()}
              onFocus={() => open(g.id)}
              onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) close(0); }}
            >
              <button
                type="button"
                onClick={() => {
                  // Already on this tool: the click just shows / hides its options
                  // (this is how they open on a touch screen). Otherwise pick it.
                  if (isActive && hasModes) { if (isOpen) setOpenId(null); else open(g.id); }
                  else pickMode(g, shown);
                }}
                aria-pressed={isActive}
                aria-haspopup={hasModes ? 'menu' : undefined}
                aria-expanded={hasModes ? isOpen : undefined}
                aria-label={g.label}
                className={cn(
                  'w-12 h-12 flex flex-col items-center justify-center gap-1 border transition-colors relative',
                  isActive
                    ? 'bg-zinc-800 border-amber-400 text-amber-400'
                    : 'border-transparent text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800/50',
                )}
              >
                {/* The icon shows the way of drawing currently chosen in this group. */}
                {React.createElement(isActive ? shown.icon : g.icon, { className: 'w-[18px] h-[18px]', 'aria-hidden': true })}
                <span className="text-[9px] font-mono font-bold uppercase tracking-wide leading-none">
                  {g.id === 'magic' ? 'Magic' : g.label}
                </span>
                {hasModes && (
                  <span aria-hidden className="absolute right-0.5 bottom-0.5 w-0 h-0 border-l-[5px] border-l-transparent border-b-[5px] border-b-current opacity-60" />
                )}
              </button>

              {isOpen && (
                // pl-2 is the "bridge": the pointer never leaves this wrapper on its way across.
                <div className="absolute left-full top-0 pl-2 z-[80]">
                  <div
                    role={hasModes ? 'menu' : 'tooltip'}
                    aria-label={hasModes ? `${g.label}: ways to draw` : undefined}
                    className="w-72 bg-industrial-panel border border-industrial-border shadow-2xl"
                  >
                    <div className="px-3 py-2 border-b border-industrial-border flex items-baseline justify-between gap-3">
                      <span className="text-xs font-semibold text-zinc-100">{g.label}</span>
                      <span className="text-[11px] text-zinc-500 truncate">{g.about}</span>
                    </div>

                    {!hasModes && (
                      <p className="px-3 py-2.5 text-xs text-zinc-400 leading-relaxed">
                        {g.modes[0].hint}
                        <kbd className="ml-2 font-mono text-[10px] text-zinc-500 border border-zinc-700 px-1">{g.shortcut}</kbd>
                      </p>
                    )}
                    {g.tips && (
                      <dl className="border-t border-industrial-border/60">
                        {g.tips.map(([what, how]) => (
                          <div key={what} className="px-3 py-2 border-b border-industrial-border/60 last:border-b-0">
                            <dt className="text-xs font-semibold text-zinc-100">{what}</dt>
                            <dd className="text-[11px] text-zinc-500 leading-snug mt-0.5">{how}</dd>
                          </div>
                        ))}
                      </dl>
                    )}

                    {hasModes && g.modes.map(m => {
                      const on = isActive && m.key === current!.mode.key;
                      return (
                        <div key={m.key} className={cn('border-b border-industrial-border/60 last:border-b-0', on && 'bg-amber-400/10')}>
                          <button
                            type="button"
                            role="menuitemradio"
                            aria-checked={on}
                            onClick={() => pickMode(g, m)}
                            className="w-full flex items-start gap-3 px-3 py-2.5 text-left hover:bg-zinc-800/60 focus-visible:bg-zinc-800/60 outline-none"
                          >
                            <m.icon className={cn('w-4 h-4 mt-0.5 flex-shrink-0', on ? 'text-amber-400' : 'text-zinc-400')} aria-hidden />
                            <span className="min-w-0 flex-1">
                              <span className="flex items-center justify-between gap-2">
                                <span className={cn('text-xs font-semibold', on ? 'text-amber-300' : 'text-zinc-100')}>{m.label}</span>
                                {m.shortcut && <kbd className="font-mono text-[10px] text-zinc-500 border border-zinc-700 px-1">{m.shortcut}</kbd>}
                              </span>
                              <span className="block text-[11px] text-zinc-500 leading-snug mt-0.5">{m.hint}</span>
                            </span>
                          </button>

                          {/* Regular polygon: number of sides */}
                          {m.key === 'regular' && (
                            <div className="flex items-center gap-2 pl-10 pr-3 pb-2.5">
                              <span className="text-[11px] text-zinc-500">Sides</span>
                              <div className="flex items-center border border-industrial-border">
                                <button type="button" aria-label="Fewer sides" disabled={drawMode.sides <= MIN_SIDES}
                                  onClick={() => pickMode(g, { ...m, mode: { regular: true, sides: drawMode.sides - 1 } }, true)}
                                  className="h-6 w-6 flex items-center justify-center text-zinc-400 hover:text-zinc-100 disabled:opacity-30">
                                  <Minus className="w-3 h-3" />
                                </button>
                                <input
                                  type="number" min={MIN_SIDES} max={MAX_SIDES} value={drawMode.sides}
                                  aria-label="Number of sides"
                                  onChange={e => pickMode(g, { ...m, mode: { regular: true, sides: Number(e.target.value) } }, true)}
                                  className="h-6 w-10 bg-industrial-black text-center text-xs font-mono font-bold text-amber-400 outline-none border-x border-industrial-border [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none"
                                />
                                <button type="button" aria-label="More sides" disabled={drawMode.sides >= MAX_SIDES}
                                  onClick={() => pickMode(g, { ...m, mode: { regular: true, sides: drawMode.sides + 1 } }, true)}
                                  className="h-6 w-6 flex items-center justify-center text-zinc-400 hover:text-zinc-100 disabled:opacity-30">
                                  <Plus className="w-3 h-3" />
                                </button>
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>

            {/* Path with curves: what the NEXT edge will be (press A) */}
            {isActive && activeTool === 'polyarc' && polyarcMode && togglePolyarcMode && (
              <button
                type="button"
                onClick={togglePolyarcMode}
                title={`Next edge: ${polyarcMode === 'arc' ? 'curve' : 'straight'} — click or press A to switch`}
                className={cn(
                  'w-12 h-6 flex items-center justify-center border text-[9px] font-mono font-bold uppercase tracking-wide transition-colors',
                  polyarcMode === 'arc'
                    ? 'border-teal-400 text-teal-300 bg-teal-400/10'
                    : 'border-zinc-600 text-zinc-300 bg-zinc-800',
                )}
              >
                {polyarcMode === 'arc' ? 'Curve' : 'Straight'}
              </button>
            )}
          </React.Fragment>
        );
      })}

      <div className="h-px w-8 bg-zinc-700/60 my-0.5" aria-hidden />
      <AdvancedToolsDropdown activeTool={activeTool} setActiveTool={setActiveTool} placement="right" />
    </nav>
  );
}
