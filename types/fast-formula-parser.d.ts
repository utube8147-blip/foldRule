// Minimal typings for fast-formula-parser (MIT) — only what lib/export/studio uses.
declare module 'fast-formula-parser' {
  interface Position { sheet: string; row: number; col: number }
  interface CellRef { sheet: string; row: number; col: number }
  interface RangeRef { sheet: string; from: { row: number; col: number }; to: { row: number; col: number } }
  interface Config {
    onCell?: (ref: CellRef) => unknown;
    onRange?: (ref: RangeRef) => unknown[][];
    functions?: Record<string, (...args: unknown[]) => unknown>;
  }
  class DepParser {
    constructor(config?: { onVariable?: (name: string, sheet: string) => unknown });
    parse(formula: string, position: Position, ignoreError?: boolean): Array<CellRef | RangeRef>;
  }
  class FormulaParser {
    constructor(config?: Config);
    parse(formula: string, position?: Position, allowReturnArray?: boolean): unknown;
    static DepParser: typeof DepParser;
  }
  export default FormulaParser;
}
