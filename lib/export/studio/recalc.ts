// ─── lib/export/studio/recalc.ts ─────────────────────────────────────────────
//
//  Works out every formula in the workbook, across sheets, so the preview shows
//  live results and the saved file carries them. Formulas are ordered by their
//  dependencies first (fast-formula-parser's DepParser), then evaluated once
//  each — no re-entrant parsing. Circular references come out as #CYCLE!.
// ─────────────────────────────────────────────────────────────────────────────

import FormulaParser from 'fast-formula-parser';
import { key, type Scalar, type SheetModel } from './sheetModel';

export type Values = Map<string, Map<string, Scalar>>;

interface CellRef { sheet?: string; row: number; col: number }
interface RangeRef { sheet?: string; from: { row: number; col: number }; to: { row: number; col: number } }
type Ref = CellRef | RangeRef;
const isRange = (r: Ref): r is RangeRef => 'from' in r;

/** Sheet names are matched without regard to case, as in Excel. */
const norm = (s: string) => s.toLowerCase();

function toScalar(x: unknown): Scalar {
  if (x === null || x === undefined) return null;
  if (typeof x === 'number') return Number.isFinite(x) ? x : '#NUM!';
  if (typeof x === 'string' || typeof x === 'boolean') return x;
  if (Array.isArray(x)) return toScalar(Array.isArray(x[0]) ? x[0][0] : x[0]);
  if (typeof x === 'object' && x && 'error' in x) return String((x as { error: string }).error);
  if (typeof x === 'object' && x && '_error' in x) return String((x as { _error: string })._error);
  return String(x);
}

// fast-formula-parser compares an empty cell with "" differently from Excel (Excel: equal).
// Rewrite `ref<>""` / `ref=""` for evaluation only; the saved formula is not changed.
const REF = String.raw`((?:'[^']+'|[A-Za-z_][\w.]*)!)?\$?[A-Za-z]{1,3}\$?\d+`;
const NOT_BLANK = new RegExp(`(${REF})\\s*<>\\s*""`, 'g');
const IS_BLANK = new RegExp(`(${REF})\\s*=\\s*""`, 'g');
export const excelBlanks = (f: string) =>
  f.replace(NOT_BLANK, 'AND(NOT(ISBLANK($1)),$1<>"")').replace(IS_BLANK, 'OR(ISBLANK($1),$1="")');

let parsers: { calc: FormulaParser; deps: InstanceType<typeof FormulaParser.DepParser> } | null = null;
let read: (sheet: string, row: number, col: number) => Scalar = () => null;

function engine() {
  if (!parsers) {
    const get = (sheet: string, row: number, col: number) => read(sheet, row, col);
    parsers = {
      calc: new FormulaParser({
        onCell: ({ sheet, row, col }: CellRef & { sheet: string }) => get(sheet, row, col),
        onRange: (r: RangeRef & { sheet: string }) => {
          const out: Scalar[][] = [];
          for (let row = r.from.row; row <= r.to.row; row++) {
            const line: Scalar[] = [];
            for (let col = r.from.col; col <= r.to.col; col++) line.push(get(r.sheet, row, col));
            out.push(line);
          }
          return out;
        },
      }),
      deps: new FormulaParser.DepParser(),
    };
  }
  return parsers;
}

/** Sheets a formula reads from (its own sheet included when it has unqualified references). */
export function sheetsReferenced(formula: string, own: string): string[] {
  try {
    const refs = engine().deps.parse(formula, { sheet: own, row: 1, col: 1 }) as Ref[];
    return [...new Set(refs.map(r => r.sheet ?? own))];
  } catch {
    return [];
  }
}

export function recalc(sheets: SheetModel[]): Values {
  const { calc, deps } = engine();
  const byName = new Map(sheets.map(s => [norm(s.name), s]));
  const values: Values = new Map(sheets.map(s => [s.name, new Map<string, Scalar>()]));

  // Every formula cell, and the formula cells it depends on.
  type Node = { sheet: SheetModel; r: number; c: number; f: string; id: string };
  const nodes = new Map<string, Node>();
  const formulaCells = new Map<string, Array<{ r: number; c: number }>>();
  for (const s of sheets) {
    const list: Array<{ r: number; c: number }> = [];
    for (const [k, cell] of s.cells) {
      if (!cell.f) continue;
      const [r, c] = k.split(':').map(Number);
      list.push({ r, c });
      nodes.set(`${norm(s.name)}!${k}`, { sheet: s, r, c, f: cell.f, id: `${norm(s.name)}!${k}` });
    }
    formulaCells.set(norm(s.name), list);
  }
  const edges = new Map<string, string[]>();
  for (const n of nodes.values()) {
    const out: string[] = [];
    let refs: Ref[] = [];
    try { refs = deps.parse(n.f, { sheet: n.sheet.name, row: n.r, col: n.c }) as Ref[]; } catch { refs = []; }
    for (const ref of refs) {
      const sn = norm(ref.sheet ?? n.sheet.name);
      if (isRange(ref)) {
        for (const fc of formulaCells.get(sn) ?? []) {
          if (fc.r >= ref.from.row && fc.r <= ref.to.row && fc.c >= ref.from.col && fc.c <= ref.to.col) out.push(`${sn}!${key(fc.r, fc.c)}`);
        }
      } else if (nodes.has(`${sn}!${key(ref.row, ref.col)}`)) out.push(`${sn}!${key(ref.row, ref.col)}`);
    }
    edges.set(n.id, out);
  }

  // Depth-first topological order; cycles are marked.
  const order: Node[] = [];
  const state = new Map<string, 1 | 2>();
  const cyclic = new Set<string>();
  const visit = (id: string, stack: string[]) => {
    const st = state.get(id);
    if (st === 2) return;
    if (st === 1) { for (const x of stack.slice(stack.indexOf(id))) cyclic.add(x); return; }
    state.set(id, 1);
    stack.push(id);
    for (const d of edges.get(id) ?? []) visit(d, stack);
    stack.pop();
    state.set(id, 2);
    order.push(nodes.get(id)!);
  };
  for (const id of nodes.keys()) visit(id, []);

  read = (sheet, row, col) => {
    const s = byName.get(norm(sheet));
    if (!s) return '#REF!';
    const k = key(row, col);
    const computed = values.get(s.name)!;
    if (computed.has(k)) return computed.get(k)!;
    const cell = s.cells.get(k);
    return cell && !cell.f ? cell.v : null;
  };
  for (const n of order) {
    let v: Scalar;
    if (cyclic.has(n.id)) v = '#CYCLE!';
    else {
      try { v = toScalar(calc.parse(excelBlanks(n.f), { sheet: n.sheet.name, row: n.r, col: n.c })); }
      catch (e) { v = (e as { _error?: string; error?: string })?._error ?? (e as { error?: string })?.error ?? '#ERROR!'; }
    }
    values.get(n.sheet.name)!.set(key(n.r, n.c), v);
  }
  read = () => null;
  return values;
}

/** Value to show for a cell: computed for formulas, typed-in otherwise. */
export function valueAt(values: Values, sheet: SheetModel, r: number, c: number): Scalar {
  const cell = sheet.cells.get(key(r, c));
  if (!cell) return null;
  if (cell.f) return values.get(sheet.name)?.get(key(r, c)) ?? null;
  return cell.v;
}
