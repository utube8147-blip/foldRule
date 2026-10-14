'use client';

// State of the export page: the generated workbook (rebuilt when the project, the
// colours or the sheet choice change), the edits laid over it, live results, and
// session undo / redo of edits. Settings are saved with the project.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTakeoffData } from '@/context/TakeoffContext';
import { projectExportInput } from '@/lib/export/clientExport';
import { addEdit, snapshot, type CellEdit, type ExportSettings } from '@/lib/export/studio/edits';
import type { SheetModel, CellStyle } from '@/lib/export/studio/sheetModel';
import { key, parseAddr } from '@/lib/export/studio/sheetModel';
import type { StudioState } from '@/lib/export/studio/pipeline';

type Pipeline = typeof import('@/lib/export/studio/pipeline');

export function useStudio() {
  const { projectState: ps, updateProjectMeta } = useTakeoffData();
  const settings = useMemo<ExportSettings>(() => ps.exportSettings ?? {}, [ps.exportSettings]);
  const latest = useRef(settings);
  useEffect(() => { latest.current = settings; }, [settings]);

  const save = useCallback((patch: Partial<ExportSettings>) => {
    const next = { ...latest.current, ...patch };
    latest.current = next;
    updateProjectMeta({ exportSettings: next });
  }, [updateProjectMeta]);

  // ── Generated workbook ────────────────────────────────────────────────────
  const [pipeline, setPipeline] = useState<Pipeline | null>(null);
  const [base, setBase] = useState<SheetModel[] | null>(null);
  const [building, setBuilding] = useState(true);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { import('@/lib/export/studio/pipeline').then(setPipeline).catch(e => setError(String(e))); }, []);

  const themeKey = JSON.stringify(settings.theme ?? {});
  const excludeKey = JSON.stringify(settings.exclude ?? []);
  const input = useMemo(
    () => projectExportInput({ ...ps, exportSettings: undefined }),
    // Everything that reaches the workbook — not the export settings themselves.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ps.measurements, ps.materials, ps.drawings, ps.projectName, ps.projectNumber, ps.projectLocation, ps.projectPhase, ps.kitchenType,
     ps.totalUnits, ps.documentTitle, ps.documentDate, ps.revision, ps.currency, ps.vatPercent, ps.stakeholders, ps.drawingReferences,
     ps.generalAssumptions, ps.excludedItems, ps.revisionLog, ps.veProposals, ps.markups, ps.auditLog],
  );

  useEffect(() => {
    if (!pipeline) return;
    let live = true;
    setBuilding(true);
    const t = setTimeout(() => {
      pipeline.buildBase(input, { theme: JSON.parse(themeKey), exclude: JSON.parse(excludeKey) })
        .then(b => { if (live) { setBase(b); setError(null); } })
        .catch(e => { if (live) setError(e instanceof Error ? e.message : String(e)); })
        .finally(() => { if (live) setBuilding(false); });
    }, 200);
    return () => { live = false; clearTimeout(t); };
  }, [pipeline, input, themeKey, excludeKey]);

  const state: StudioState | null = useMemo(
    () => (pipeline && base ? pipeline.studioState(base, settings.edits) : null),
    [pipeline, base, settings.edits],
  );

  // ── Edits with undo / redo (this visit) ───────────────────────────────────
  const past = useRef<CellEdit[][]>([]);
  const future = useRef<CellEdit[][]>([]);
  const [history, setHistory] = useState({ undo: 0, redo: 0 });
  const bump = () => setHistory({ undo: past.current.length, redo: future.current.length });
  const setEdits = useCallback((next: CellEdit[]) => {
    past.current.push(latest.current.edits ?? []);
    if (past.current.length > 200) past.current.shift();
    future.current = [];
    save({ edits: next });
    bump();
  }, [save]);
  const undo = useCallback(() => {
    const prev = past.current.pop();
    if (!prev) return;
    future.current.push(latest.current.edits ?? []);
    save({ edits: prev }); bump();
  }, [save]);
  const redo = useCallback(() => {
    const next = future.current.pop();
    if (!next) return;
    past.current.push(latest.current.edits ?? []);
    save({ edits: next }); bump();
  }, [save]);

  const generated = useCallback((sheet: string, a: string) => {
    const s = base?.find(x => x.name === sheet);
    const at = parseAddr(a);
    return s && at ? s.cells.get(key(at.r, at.c)) : undefined;
  }, [base]);

  /** Type into cells: [address, text] pairs on one sheet. Typing back the generated content removes the edit. */
  const setCells = useCallback((sheet: string, entries: Array<[string, string]>) => {
    let edits = latest.current.edits ?? [];
    for (const [a, text] of entries) {
      const now = snapshot(generated(sheet, a));
      const existing = edits.find(e => e.sheet === sheet && e.addr === a);
      if (text === now) {
        // Back to what the takeoff gives: keep only a formatting change, if any.
        if (existing) edits = existing.style ? edits.map(e => (e === existing ? { ...e, input: undefined } : e)) : edits.filter(e => e !== existing);
        continue;
      }
      edits = addEdit(edits, { sheet, addr: a, input: text, was: existing?.was ?? now });
    }
    setEdits(edits);
  }, [generated, setEdits]);

  const setStyle = useCallback((sheet: string, addrs: string[], style: Partial<CellStyle>) => {
    let edits = latest.current.edits ?? [];
    for (const a of addrs) {
      const existing = edits.find(e => e.sheet === sheet && e.addr === a);
      edits = addEdit(edits, { sheet, addr: a, style, was: existing?.was ?? snapshot(generated(sheet, a)) });
    }
    setEdits(edits);
  }, [generated, setEdits]);

  /** Put cells back as generated (content and formatting). */
  const revertCells = useCallback((sheet: string, addrs: string[]) => {
    const drop = new Set(addrs);
    setEdits((latest.current.edits ?? []).filter(e => !(e.sheet === sheet && drop.has(e.addr))));
  }, [setEdits]);

  const clearStyle = useCallback((sheet: string, addrs: string[]) => {
    const drop = new Set(addrs);
    setEdits((latest.current.edits ?? [])
      .map(e => (e.sheet === sheet && drop.has(e.addr) ? { ...e, style: undefined } : e))
      .filter(e => e.input !== undefined || e.style));
  }, [setEdits]);

  const forceEdit = useCallback((e: CellEdit) => {
    setEdits((latest.current.edits ?? []).map(x => (x === e || (x.sheet === e.sheet && x.addr === e.addr) ? { ...x, force: true } : x)));
  }, [setEdits]);
  const dropEdit = useCallback((e: CellEdit) => {
    setEdits((latest.current.edits ?? []).filter(x => !(x.sheet === e.sheet && x.addr === e.addr)));
  }, [setEdits]);

  return {
    ps, settings, save, input, base, state, building, error,
    setCells, setStyle, revertCells, clearStyle, forceEdit, dropEdit,
    undo, redo, canUndo: history.undo > 0, canRedo: history.redo > 0,
    resetEdits: () => setEdits([]),
  };
}

export type Studio = ReturnType<typeof useStudio>;
