'use client';
// Right-click menu for a takeoff row or group: the same actions wherever the takeoff is listed.

import React, { useEffect } from 'react';
import type { TakeoffRow } from '@/types';
import { canJoin, groupRows, kindOf, type RowOps } from '@/hooks/shapes/useRowOps';

export interface RowMenuState { x: number; y: number; rowId: string }

interface Props {
  menu: RowMenuState;
  measurements: TakeoffRow[];
  ops: RowOps;
  onClose: () => void;
  /** Show the row (or group) in the page's drawing preview. */
  onPreview?: (id: string) => void;
  /** Open the workspace with this row selected on its drawing. */
  onOpenInWorkspace?: (id: string) => void;
  /** Ask which material to use for this row or group. */
  onPickMaterial: (id: string) => void;
  /** Start a value engineering alternative for this material. */
  onProposeAlternative?: (materialId: string) => void;
  onConfirmDelete: (row: TakeoffRow) => void;
}

function Item({ label, hint, onClick, danger, close }: { label: React.ReactNode; hint?: string; onClick: () => void; danger?: boolean; close: () => void }) {
  return (
    <button role="menuitem" title={hint} onClick={() => { close(); onClick(); }}
      className={`w-full px-3 py-1.5 text-left truncate hover:bg-zinc-800 ${danger ? 'text-red-400' : 'text-zinc-100'}`}>{label}</button>
  );
}
const Divider = () => <div className="my-1 border-t border-zinc-700" />;
const Title = ({ children }: { children: React.ReactNode }) => <div className="px-3 py-1 text-[10px] uppercase tracking-widest text-zinc-500 truncate">{children}</div>;

const shell = 'fixed z-[170] min-w-[15rem] max-w-[19rem] max-h-[80vh] overflow-y-auto bg-zinc-900 border border-zinc-600 shadow-2xl py-1 text-xs font-mono';

export function RowContextMenu({ menu, measurements, ops, onClose, onPreview, onOpenInWorkspace, onPickMaterial, onProposeAlternative, onConfirmDelete }: Props) {
  useEffect(() => {
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent && e.key !== 'Escape') return;
      if (!(e instanceof KeyboardEvent) && (e.target as HTMLElement | null)?.closest?.('[data-row-menu]')) return;
      onClose();
    };
    window.addEventListener('pointerdown', close, true); window.addEventListener('keydown', close, true); window.addEventListener('wheel', close, true);
    return () => { window.removeEventListener('pointerdown', close, true); window.removeEventListener('keydown', close, true); window.removeEventListener('wheel', close, true); };
  }, [onClose]);

  const row = measurements.find(m => m.id === menu.rowId);
  if (!row) return null;
  const place = (rows: number) => ({
    left: Math.min(menu.x, window.innerWidth - 320),
    top: Math.max(8, Math.min(menu.y, window.innerHeight - 24 - rows * 30)),
  });

  if (row.isGroupHeader) {
    const items = groupRows(row, measurements);
    const name = row.groupName || row.label || row.description || 'Group';
    const allVisible = items.every(i => i.isVisible !== false);
    return (
      <div data-row-menu role="menu" className={shell} style={place(11)} onContextMenu={e => e.preventDefault()}>
        <Title>{name} · {items.length} {items.length === 1 ? 'row' : 'rows'}</Title>
        {onPreview && <Item close={onClose} label="Show on the drawing" hint="Shows every shape of this group in the Visual Reference box" onClick={() => onPreview(row.id)} />}
        {onOpenInWorkspace && items.some(i => i.points?.length) && <Item close={onClose} label="Open in the workspace" hint="Go to the drawing with this group selected" onClick={() => onOpenInWorkspace(items.find(i => i.points?.length)!.id)} />}
        <Divider />
        <Item close={onClose} label="Set material for the whole group" hint="One material and its rate for every row in the group" onClick={() => onPickMaterial(row.id)} />
        {(row.materialId || items.some(i => i.materialId)) && <Item close={onClose} label="Remove the material from the group" hint="Clears the material and rate on every row in it" onClick={() => ops.setMaterial(row.id, null)} />}
        {onProposeAlternative && row.materialId && <Item close={onClose} label="Propose a cheaper alternative" hint="Value engineering for the group’s material" onClick={() => onProposeAlternative(row.materialId!)} />}
        <Divider />
        <Item close={onClose} label={allVisible ? 'Hide the group on the drawing' : 'Show the group on the drawing'} onClick={() => ops.setGroupVisible(row.id, !allVisible)} />
        <Item close={onClose} label="Duplicate as an empty group" hint="Same material, rate and unit, ready for the next floor or area" onClick={() => ops.duplicateGroup(row.id, false)} />
        <Item close={onClose} label="Duplicate with its shapes" hint="Copies every shape too, placed just beside the originals" onClick={() => ops.duplicateGroup(row.id, true)} />
        <Item close={onClose} label="Ungroup" hint="Keep the rows, remove the group" onClick={() => ops.ungroup(row.id)} />
        <Divider />
        <Item close={onClose} danger label="Delete group" hint="Deletes the group and its rows. Ctrl+Z brings it back." onClick={() => onConfirmDelete(row)} />
      </div>
    );
  }

  const targets = measurements.filter(h => canJoin(row, h));
  const source = row.points?.length ? row : row.derived ? measurements.find(m => m.id === row.derived!.sourceId) : undefined;
  return (
    <div data-row-menu role="menu" className={shell} style={place(10 + Math.min(8, targets.length + 1))} onContextMenu={e => e.preventDefault()}>
      <Title>{row.description || row.label}</Title>
      {onPreview && <Item close={onClose} label="Show on the drawing" hint="Shows where this row is in the Visual Reference box" onClick={() => onPreview(row.id)} />}
      {onOpenInWorkspace && source && <Item close={onClose} label="Open in the workspace" hint="Go to the drawing with this shape selected" onClick={() => onOpenInWorkspace(source.id)} />}
      <Divider />
      <Item close={onClose} label={row.materialId ? 'Change material' : 'Set material'} hint="For this row only" onClick={() => onPickMaterial(row.id)} />
      {row.materialId && <Item close={onClose} label="Remove material" onClick={() => ops.setMaterial(row.id, null)} />}
      {onProposeAlternative && row.materialId && <Item close={onClose} label="Propose a cheaper alternative" hint="Value engineering: applies to every row on this material" onClick={() => onProposeAlternative(row.materialId!)} />}
      {row.review?.status === 'check' && <Item close={onClose} label="Mark as checked" hint="Tick this row off the revision check list" onClick={() => ops.markChecked(row.id)} />}
      <Divider />
      {(row.points?.length ?? 0) > 0 && <Item close={onClose} label={row.isVisible === false ? 'Show on the drawing again' : 'Hide on the drawing'} onClick={() => ops.toggleVisibility(row.id)} />}
      {(row.points?.length ?? 0) > 0 && <Item close={onClose} label="Duplicate" hint="A copy just beside it, in the same group" onClick={() => ops.duplicateRow(row.id)} />}
      {targets.length > 0 && <><Divider /><Title>Move to</Title></>}
      {targets.map(h => (
        <button key={h.id} role="menuitem" onClick={() => { onClose(); ops.moveRow(row.id, h.id); }}
          className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-zinc-100 hover:bg-zinc-800">
          <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: h.color }} />
          <span className="truncate">{h.groupName || h.label || h.description}</span>
        </button>
      ))}
      {row.parentId && <Item close={onClose} label="Take it out of its group" onClick={() => ops.moveRow(row.id, null)} />}
      {!row.parentId && ['area', 'length', 'count'].includes(kindOf(row.type)) && (row.points?.length ?? 0) > 0 &&
        <Item close={onClose} label="Make it a group" hint="Turns this row into a group of its own, so more can be added to it" onClick={() => ops.makeGroupFrom(row.id)} />}
      <Divider />
      <Item close={onClose} danger label="Delete" hint="Ctrl+Z brings it back" onClick={() => onConfirmDelete(row)} />
    </div>
  );
}
