'use client';

// An Excel-like view of one worksheet of the export: the real colours, merges,
// widths and number formats, with live formula results. Click / drag / shift to
// select; type, F2 or double-click to edit; Enter, Tab and arrows move; Delete
// clears; Ctrl+C / Ctrl+V copy and paste; Ctrl+Z / Ctrl+Y undo; Ctrl+B / Ctrl+I.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Bold, Italic, AlignLeft, AlignCenter, AlignRight, Undo2, Redo2, WrapText, PaintBucket, Baseline,
  Eraser, ZoomIn, ZoomOut, Grid3x3, RotateCcw, Sigma,
} from 'lucide-react';
import { addr, colName, key, masterOf, type CellModel, type CellStyle, type SheetModel, type Merge } from '@/lib/export/studio/sheetModel';
import { valueAt, type Values } from '@/lib/export/studio/recalc';
import { display, formatChoices, isError } from '@/lib/export/studio/format';

interface Props {
  sheet: SheetModel;
  values: Values;
  /** Addresses on this sheet that carry an edit. */
  edited: Set<string>;
  /** Number format for money in this project (for the format menu). */
  money: string;
  onCells: (entries: Array<[string, string]>) => void;
  onStyle: (addrs: string[], style: Partial<CellStyle>) => void;
  onClearStyle: (addrs: string[]) => void;
  onRevert: (addrs: string[]) => void;
  undo: () => void; redo: () => void; canUndo: boolean; canRedo: boolean;
  /** Select this cell (n changes on every request, so the same cell can be asked for twice). */
  jump?: { addr: string; n: number };
}

interface Pos { r: number; c: number }
const HEAD_H = 20, HEAD_W = 44, EXTRA_ROWS = 15, EXTRA_COLS = 3;
const pxW = (w: number) => Math.round(w * 7 + 5);
const pxH = (pt: number) => Math.round(pt * 4 / 3);

const rawText = (cell?: CellModel) => (!cell ? '' : cell.f ? `=${cell.f}` : cell.v === null || cell.v === undefined ? '' : String(cell.v));
const cssBorder = (b?: { w: number; c: string }) => (b ? `${b.w}px solid ${b.c}` : undefined);

export function SheetGrid(p: Props) {
  const { sheet, values } = p;
  const nRows = sheet.nRows + EXTRA_ROWS;
  const nCols = sheet.nCols + EXTRA_COLS;

  const [anchor, setAnchor] = useState<Pos>({ r: 1, c: 2 });
  const [focus, setFocus] = useState<Pos>({ r: 1, c: 2 });
  const [editing, setEditing] = useState<{ text: string; from: 'cell' | 'bar' } | null>(null);
  const [zoom, setZoom] = useState(1);
  const [grid, setGrid] = useState(true);
  const [formulas, setFormulas] = useState(false);
  const dragging = useRef(false);
  const box = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!p.jump) return;
    const m = /^([A-Z]+)(\d+)$/.exec(p.jump.addr);
    if (!m) return;
    const at = { r: Number(m[2]), c: colNum(m[1]) };
    setAnchor(at); setFocus(at); setEditing(null);
    box.current?.focus();
  }, [p.jump]);
  useEffect(() => { const up = () => { dragging.current = false; }; window.addEventListener('mouseup', up); return () => window.removeEventListener('mouseup', up); }, []);

  // ── Geometry ──────────────────────────────────────────────────────────────
  const widths = useMemo(() => {
    const w: number[] = [0];
    for (let c = 1; c <= nCols; c++) w.push(c <= sheet.nCols ? (sheet.colWidths[c] ? pxW(sheet.colWidths[c]) : 0) : pxW(9));
    return w;
  }, [sheet, nCols]);
  const heights = useMemo(() => {
    const h: number[] = [0];
    for (let r = 1; r <= nRows; r++) h.push(pxH(sheet.rowHeights[r] || 15));
    return h;
  }, [sheet, nRows]);
  const { masters, covered } = useMemo(() => {
    const masters = new Map<string, Merge>(), covered = new Set<string>();
    for (const m of sheet.merges) {
      masters.set(key(m.r1, m.c1), m);
      for (let r = m.r1; r <= m.r2; r++) for (let c = m.c1; c <= m.c2; c++) if (r !== m.r1 || c !== m.c1) covered.add(key(r, c));
    }
    return { masters, covered };
  }, [sheet]);
  // ── Selection ─────────────────────────────────────────────────────────────
  const range = useMemo(() => ({
    r1: Math.min(anchor.r, focus.r), r2: Math.max(anchor.r, focus.r),
    c1: Math.min(anchor.c, focus.c), c2: Math.max(anchor.c, focus.c),
  }), [anchor, focus]);
  const active = useMemo(() => masterOf(sheet, anchor.r, anchor.c), [sheet, anchor]);
  const activeCell = sheet.cells.get(key(active.r, active.c));
  const selected = useCallback(() => {
    const out: string[] = [];
    for (let r = range.r1; r <= range.r2; r++) for (let c = range.c1; c <= range.c2; c++) if (!covered.has(key(r, c))) out.push(addr(r, c));
    return out;
  }, [range, covered]);

  const shown = useCallback((r: number, c: number): string => {
    const cell = sheet.cells.get(key(r, c));
    if (!cell) return '';
    if (formulas && cell.f) return `=${cell.f}`;
    return display(valueAt(values, sheet, r, c), cell.s.numFmt);
  }, [sheet, values, formulas]);

  const move = useCallback((dr: number, dc: number, extend: boolean) => {
    const from = extend ? focus : active;
    let r = from.r, c = from.c;
    const start = masterOf(sheet, r, c);
    do {
      r = Math.min(nRows, Math.max(1, r + dr)); c = Math.min(nCols, Math.max(1, c + dc));
      if (r === 1 && dr < 0 || c === 1 && dc < 0 || r === nRows && dr > 0 || c === nCols && dc > 0) break;
    } while (!extend && masterOf(sheet, r, c).r === start.r && masterOf(sheet, r, c).c === start.c);
    const to = extend ? { r, c } : masterOf(sheet, r, c);
    setFocus(to);
    if (!extend) setAnchor(to);
  }, [focus, active, sheet, nRows, nCols]);

  // Keep the focused cell on screen.
  useEffect(() => {
    const el = scroller.current?.querySelector<HTMLElement>(`[data-k="${focus.r}:${focus.c}"]`) ?? scroller.current?.querySelector<HTMLElement>(`[data-k="${active.r}:${active.c}"]`);
    el?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [focus, active]);

  // ── Editing ───────────────────────────────────────────────────────────────
  const commit = useCallback((dr = 0, dc = 0) => {
    if (!editing) return;
    p.onCells([[addr(active.r, active.c), editing.text]]);
    setEditing(null);
    if (dr || dc) move(dr, dc, false);
    box.current?.focus();
  }, [editing, active, p, move]);

  const startEdit = (text: string, from: 'cell' | 'bar' = 'cell') => setEditing({ text, from });

  const toggle = (prop: 'bold' | 'italic') => p.onStyle(selected(), { [prop]: !activeCell?.s[prop] });

  const onKey = (e: React.KeyboardEvent) => {
    if (editing) return;
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key;
    if (mod && (k === 'z' || k === 'Z')) { e.preventDefault(); if (e.shiftKey) p.redo(); else p.undo(); return; }
    if (mod && (k === 'y' || k === 'Y')) { e.preventDefault(); p.redo(); return; }
    if (mod && (k === 'b' || k === 'B')) { e.preventDefault(); toggle('bold'); return; }
    if (mod && (k === 'i' || k === 'I')) { e.preventDefault(); toggle('italic'); return; }
    if (mod && k === '`') { e.preventDefault(); setFormulas(f => !f); return; }
    if (mod && (k === 'a' || k === 'A')) { e.preventDefault(); setAnchor({ r: 1, c: 1 }); setFocus({ r: sheet.nRows, c: sheet.nCols }); return; }
    if (mod) return;
    const arrows: Record<string, [number, number]> = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
    if (arrows[k]) { e.preventDefault(); move(arrows[k][0], arrows[k][1], e.shiftKey); return; }
    if (k === 'Enter') { e.preventDefault(); move(e.shiftKey ? -1 : 1, 0, false); return; }
    if (k === 'Tab') { e.preventDefault(); move(0, e.shiftKey ? -1 : 1, false); return; }
    if (k === 'F2') { e.preventDefault(); startEdit(rawText(activeCell)); return; }
    if (k === 'Delete' || k === 'Backspace') {
      e.preventDefault();
      const entries = selected().filter(a => { const at = /^([A-Z]+)(\d+)$/.exec(a)!; return !!rawText(sheet.cells.get(key(Number(at[2]), colNum(at[1])))); }).map(a => [a, ''] as [string, string]);
      if (entries.length) p.onCells(entries);
      return;
    }
    if (k.length === 1 && !e.altKey) { e.preventDefault(); startEdit(k); }
  };

  const onCopy = (e: React.ClipboardEvent) => {
    if (editing) return;
    e.preventDefault();
    const lines: string[] = [];
    for (let r = range.r1; r <= range.r2; r++) {
      const line: string[] = [];
      for (let c = range.c1; c <= range.c2; c++) line.push(covered.has(key(r, c)) ? '' : shown(r, c));
      lines.push(line.join('\t'));
    }
    e.clipboardData.setData('text/plain', lines.join('\n'));
  };
  const onPaste = (e: React.ClipboardEvent) => {
    if (editing) return;
    e.preventDefault();
    const text = e.clipboardData.getData('text/plain');
    if (!text) return;
    const rows = text.replace(/\r/g, '').replace(/\n$/, '').split('\n').map(l => l.split('\t'));
    const entries: Array<[string, string]> = [];
    rows.forEach((line, i) => line.forEach((t, j) => {
      const r = range.r1 + i, c = range.c1 + j;
      if (r <= nRows && c <= nCols && !covered.has(key(r, c))) entries.push([addr(r, c), t]);
    }));
    if (entries.length) p.onCells(entries);
  };

  // ── Status bar: sum / average / count of numbers selected ─────────────────
  const stats = useMemo(() => {
    let sum = 0, n = 0, count = 0;
    for (let r = range.r1; r <= range.r2; r++) for (let c = range.c1; c <= range.c2; c++) {
      const v = valueAt(values, sheet, r, c);
      if (v !== null && v !== '') count++;
      if (typeof v === 'number') { sum += v; n++; }
    }
    return { sum, n, count };
  }, [range, values, sheet]);

  const fmtList = formatChoices(p.money);
  const currentFmt = activeCell?.s.numFmt ?? 'General';
  const sel = selected();
  const anyEdited = sel.some(a => p.edited.has(a));

  // ── Render ────────────────────────────────────────────────────────────────
  const visibleCols: number[] = [];
  for (let c = 1; c <= nCols; c++) if (widths[c] > 0) visibleCols.push(c);
  const spanCols = (m: Merge) => visibleCols.filter(c => c >= m.c1 && c <= m.c2).length;
  const spanHeight = (m: Merge) => { let h = 0; for (let r = m.r1; r <= m.r2; r++) h += heights[r]; return h * zoom; };
  const gridColor = grid ? '#E2E5E9' : 'transparent';

  return (
    <div className="flex flex-col h-full min-h-0 bg-white">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-1 px-2 py-1.5 border-b border-zinc-300 bg-[#F3F4F6] text-zinc-700">
        <Tool title="Undo (Ctrl+Z)" onClick={p.undo} disabled={!p.canUndo}><Undo2 size={15} /></Tool>
        <Tool title="Redo (Ctrl+Y)" onClick={p.redo} disabled={!p.canRedo}><Redo2 size={15} /></Tool>
        <Sep />
        <Tool title="Bold (Ctrl+B)" on={!!activeCell?.s.bold} onClick={() => toggle('bold')}><Bold size={15} /></Tool>
        <Tool title="Italic (Ctrl+I)" on={!!activeCell?.s.italic} onClick={() => toggle('italic')}><Italic size={15} /></Tool>
        <ColorTool title="Text colour" icon={<Baseline size={15} />} value={activeCell?.s.color ?? '#1C1C1C'} onPick={c => p.onStyle(sel, { color: c })} />
        <ColorTool title="Fill colour" icon={<PaintBucket size={15} />} value={activeCell?.s.bg ?? '#FFFFFF'} onPick={c => p.onStyle(sel, { bg: c })}
          extra={<button className="text-[10px] px-1.5 hover:underline" onClick={() => p.onStyle(sel, { bg: '' })}>No fill</button>} />
        <Sep />
        <Tool title="Align left" on={activeCell?.s.h === 'left'} onClick={() => p.onStyle(sel, { h: 'left' })}><AlignLeft size={15} /></Tool>
        <Tool title="Centre" on={activeCell?.s.h === 'center'} onClick={() => p.onStyle(sel, { h: 'center' })}><AlignCenter size={15} /></Tool>
        <Tool title="Align right" on={activeCell?.s.h === 'right'} onClick={() => p.onStyle(sel, { h: 'right' })}><AlignRight size={15} /></Tool>
        <Tool title="Wrap text" on={!!activeCell?.s.wrap} onClick={() => p.onStyle(sel, { wrap: !activeCell?.s.wrap })}><WrapText size={15} /></Tool>
        <Sep />
        <select
          title="Number format"
          className="h-7 text-[12px] border border-zinc-300 bg-white px-1 rounded-sm"
          value={fmtList.some(f => f.fmt === currentFmt) ? currentFmt : '__current'}
          onChange={e => p.onStyle(sel, { numFmt: e.target.value })}
        >
          {!fmtList.some(f => f.fmt === currentFmt) && <option value="__current">{currentFmt}</option>}
          {fmtList.map(f => <option key={f.id} value={f.fmt}>{f.label}</option>)}
        </select>
        <Sep />
        <Tool title="Clear formatting changes" onClick={() => p.onClearStyle(sel)}><Eraser size={15} /></Tool>
        <Tool title="Put back as generated (content and formatting)" disabled={!anyEdited} onClick={() => p.onRevert(sel)}><RotateCcw size={15} /></Tool>
        <div className="flex-1" />
        <Tool title="Show formulas (Ctrl+`)" on={formulas} onClick={() => setFormulas(f => !f)}><Sigma size={15} /></Tool>
        <Tool title="Gridlines" on={grid} onClick={() => setGrid(g => !g)}><Grid3x3 size={15} /></Tool>
        <Tool title="Zoom out" onClick={() => setZoom(z => Math.max(0.5, +(z - 0.1).toFixed(2)))}><ZoomOut size={15} /></Tool>
        <span className="text-[11px] w-10 text-center tabular-nums">{Math.round(zoom * 100)}%</span>
        <Tool title="Zoom in" onClick={() => setZoom(z => Math.min(2, +(z + 0.1).toFixed(2)))}><ZoomIn size={15} /></Tool>
      </div>

      {/* Formula bar */}
      <div className="flex items-center border-b border-zinc-300 bg-white text-[13px]">
        <div className="w-20 shrink-0 px-2 py-1 border-r border-zinc-300 font-mono text-zinc-600 text-[12px]">
          {range.r1 === range.r2 && range.c1 === range.c2 ? addr(active.r, active.c) : `${addr(range.r1, range.c1)}:${addr(range.r2, range.c2)}`}
        </div>
        <div className="px-2 text-zinc-400 italic font-serif select-none">fx</div>
        <input
          aria-label="Cell contents"
          className="flex-1 px-2 py-1 outline-none font-mono text-[12px] text-zinc-800"
          value={editing ? editing.text : rawText(activeCell)}
          onFocus={() => { if (!editing) startEdit(rawText(activeCell), 'bar'); }}
          onChange={e => setEditing({ text: e.target.value, from: 'bar' })}
          onKeyDown={e => {
            if (e.key === 'Enter') { e.preventDefault(); commit(1, 0); }
            else if (e.key === 'Escape') { e.preventDefault(); setEditing(null); box.current?.focus(); }
            else if (e.key === 'Tab') { e.preventDefault(); commit(0, e.shiftKey ? -1 : 1); }
          }}
          onBlur={() => { if (editing?.from === 'bar') commit(); }}
        />
      </div>

      {/* Grid */}
      <div
        ref={box}
        tabIndex={0}
        onKeyDown={onKey}
        onCopy={onCopy}
        onPaste={onPaste}
        className="flex-1 min-h-0 outline-none relative"
      >
        <div ref={scroller} className="absolute inset-0 overflow-auto bg-white" style={{ scrollbarWidth: 'thin' }}>
          <table className="border-separate select-none" style={{ borderSpacing: 0, tableLayout: 'fixed', width: HEAD_W + visibleCols.reduce((s, c) => s + widths[c] * zoom, 0) }}>
            <colgroup>
              <col style={{ width: HEAD_W }} />
              {visibleCols.map(c => <col key={c} style={{ width: widths[c] * zoom }} />)}
            </colgroup>
            <thead>
              <tr style={{ height: HEAD_H }}>
                <th className="sticky top-0 left-0 z-40 bg-[#E9EBEE] border-r border-b border-zinc-300" />
                {visibleCols.map(c => {
                  const inSel = c >= range.c1 && c <= range.c2;
                  return (
                    <th key={c}
                      onMouseDown={e => { e.preventDefault(); setAnchor({ r: 1, c }); setFocus({ r: nRows, c }); box.current?.focus(); }}
                      className="sticky top-0 z-30 border-r border-b border-zinc-300 text-[11px] font-normal text-zinc-600 cursor-s-resize"
                      style={{ background: inSel ? '#D3E3D9' : '#E9EBEE' }}
                    >{colName(c)}</th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {Array.from({ length: nRows }, (_, i) => i + 1).map(r => {
                const inRowSel = r >= range.r1 && r <= range.r2;
                return (
                  <tr key={r} style={{ height: heights[r] * zoom }}>
                    <th
                      onMouseDown={e => { e.preventDefault(); setAnchor({ r, c: 1 }); setFocus({ r, c: nCols }); box.current?.focus(); }}
                      className="sticky left-0 border-r border-b border-zinc-300 text-[11px] font-normal text-zinc-600 cursor-e-resize"
                      style={{ background: inRowSel ? '#D3E3D9' : '#E9EBEE', zIndex: 25 }}
                    >{r}</th>
                    {visibleCols.map(c => {
                      const k = key(r, c);
                      if (covered.has(k)) return null;
                      const m = masters.get(k);
                      const cell = sheet.cells.get(k);
                      const s: CellStyle = cell?.s ?? {};
                      const isActive = active.r === r && active.c === c;
                      const inSel = r >= range.r1 && r <= range.r2 && c >= range.c1 && c <= range.c2;
                      const v = cell ? valueAt(values, sheet, r, c) : null;
                      const text = shown(r, c);
                      const a = addr(r, c);
                      const h = s.h ?? (typeof v === 'number' && !(formulas && cell?.f) ? 'right' : isError(v) ? 'center' : 'left');
                      const style: React.CSSProperties = {
                        background: s.bg || '#FFFFFF',
                        color: isError(v) ? '#B91C1C' : s.color ?? '#1C1C1C',
                        fontWeight: s.bold ? 700 : 400,
                        fontStyle: s.italic ? 'italic' : undefined,
                        fontSize: Math.max(7, (s.size ?? 11) * 4 / 3 * zoom),
                        fontFamily: `${s.font ? `"${s.font}", ` : ''}Calibri, Carlito, "Segoe UI", Arial, sans-serif`,
                        textAlign: h,
                        verticalAlign: s.v === 'top' ? 'top' : s.v === 'middle' ? 'middle' : 'bottom',
                        whiteSpace: s.wrap ? 'pre-wrap' : 'pre',
                        overflow: 'hidden',
                        textOverflow: 'clip',
                        lineHeight: 1.15,
                        padding: `0 ${3 * zoom}px`,
                        borderTop: cssBorder(s.bt),
                        borderLeft: cssBorder(s.bl),
                        borderBottom: cssBorder(s.bb) ?? `1px solid ${gridColor}`,
                        borderRight: cssBorder(s.br) ?? `1px solid ${gridColor}`,
                        position: 'relative',
                        boxShadow: inSel && !isActive ? 'inset 0 0 0 9999px rgba(33,115,70,0.13)' : undefined,
                        outline: isActive ? '2px solid #217346' : undefined,
                        outlineOffset: isActive ? -2 : undefined,
                        cursor: 'cell',
                        maxHeight: m ? spanHeight(m) : heights[r] * zoom,
                      };
                      return (
                        <td
                          key={c}
                          data-k={k}
                          rowSpan={m ? m.r2 - m.r1 + 1 : undefined}
                          colSpan={m ? spanCols(m) : undefined}
                          style={style}
                          title={cell?.f && !formulas ? `=${cell.f}` : undefined}
                          onMouseDown={e => {
                            if (editing) commit();
                            dragging.current = true;
                            if (e.shiftKey) setFocus({ r, c });
                            else { setAnchor({ r, c }); setFocus({ r, c }); }
                            box.current?.focus();
                          }}
                          onMouseEnter={() => { if (dragging.current) setFocus({ r, c }); }}
                          onDoubleClick={() => startEdit(rawText(cell))}
                        >
                          {isActive && editing?.from === 'cell' ? (
                            <input
                              autoFocus
                              className="absolute left-0 top-0 h-full outline-none px-1 bg-white text-zinc-900 shadow-[0_0_0_2px_#217346] z-50"
                              style={{ minWidth: '100%', width: Math.max(80, editing.text.length * 8 + 16), fontSize: style.fontSize, fontFamily: 'ui-monospace, monospace' }}
                              value={editing.text}
                              onChange={e => setEditing({ text: e.target.value, from: 'cell' })}
                              onKeyDown={e => {
                                if (e.key === 'Enter') { e.preventDefault(); commit(e.shiftKey ? -1 : 1, 0); }
                                else if (e.key === 'Tab') { e.preventDefault(); commit(0, e.shiftKey ? -1 : 1); }
                                else if (e.key === 'Escape') { e.preventDefault(); setEditing(null); box.current?.focus(); }
                              }}
                              onBlur={() => commit()}
                            />
                          ) : text}
                          {p.edited.has(a) && (
                            <span aria-label="Edited" className="absolute right-0 top-0 w-0 h-0 pointer-events-none"
                              style={{ borderTop: '7px solid #E8A33D', borderLeft: '7px solid transparent' }} />
                          )}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Status bar */}
      <div className="flex items-center gap-4 px-3 h-6 border-t border-zinc-300 bg-[#F3F4F6] text-[11px] text-zinc-600 tabular-nums">
        <span className="truncate">{editing ? 'Edit — Enter to keep, Esc to cancel' : 'Ready — type to replace, F2 to edit, Ctrl+C / Ctrl+V'}</span>
        <div className="flex-1" />
        {stats.count > 1 && <span>Count: {stats.count}</span>}
        {stats.n > 1 && <span>Average: {(stats.sum / stats.n).toLocaleString(undefined, { maximumFractionDigits: 4 })}</span>}
        {stats.n > 0 && <span>Sum: {stats.sum.toLocaleString(undefined, { maximumFractionDigits: 4 })}</span>}
      </div>
    </div>
  );
}

function colNum(letters: string): number {
  let c = 0;
  for (const ch of letters) c = c * 26 + (ch.charCodeAt(0) - 64);
  return c;
}

function Tool({ children, title, onClick, on, disabled }: { children: React.ReactNode; title: string; onClick: () => void; on?: boolean; disabled?: boolean }) {
  return (
    <button
      type="button" title={title} aria-label={title} aria-pressed={on} disabled={disabled}
      onMouseDown={e => e.preventDefault()}
      onClick={onClick}
      className={`h-7 w-7 inline-flex items-center justify-center rounded-sm border ${on ? 'bg-[#D3E3D9] border-[#9CC3AC]' : 'border-transparent hover:bg-zinc-200'} disabled:opacity-35 disabled:hover:bg-transparent`}
    >{children}</button>
  );
}

function ColorTool({ title, icon, value, onPick, extra }: { title: string; icon: React.ReactNode; value: string; onPick: (c: string) => void; extra?: React.ReactNode }) {
  return (
    <span className="inline-flex items-center">
      <label title={title} className="h-7 w-8 inline-flex flex-col items-center justify-center rounded-sm hover:bg-zinc-200 cursor-pointer relative">
        {icon}
        <span className="block h-[3px] w-4 -mt-0.5" style={{ background: value }} />
        <input type="color" aria-label={title} className="absolute inset-0 opacity-0 cursor-pointer" value={/^#[0-9a-f]{6}$/i.test(value) ? value : '#000000'}
          onChange={e => onPick(e.target.value.toUpperCase())} />
      </label>
      {extra}
    </span>
  );
}

const Sep = () => <span className="mx-1 h-5 w-px bg-zinc-300" />;
