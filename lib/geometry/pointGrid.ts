// Grid index over snap points (page units) — finds the few points near the
// cursor without scanning thousands. Used to draw the PINS near the pointer.

export interface GridPoint { x: number; y: number; type: string }

const CELL = 40;

export function buildPointGrid(points: GridPoint[]) {
  const grid = new Map<string, GridPoint[]>();
  for (const p of points) {
    const k = `${Math.floor(p.x / CELL)},${Math.floor(p.y / CELL)}`;
    (grid.get(k) ?? grid.set(k, []).get(k)!).push(p);
  }
  return {
    /** Points within `r` of `p` (at most `limit`, nearest first). */
    near(p: { x: number; y: number }, r: number, limit = 150): GridPoint[] {
      const out: { pt: GridPoint; d: number }[] = [];
      const x0 = Math.floor((p.x - r) / CELL), x1 = Math.floor((p.x + r) / CELL);
      const y0 = Math.floor((p.y - r) / CELL), y1 = Math.floor((p.y + r) / CELL);
      for (let cx = x0; cx <= x1; cx++) {
        for (let cy = y0; cy <= y1; cy++) {
          const cell = grid.get(`${cx},${cy}`);
          if (!cell) continue;
          for (const pt of cell) {
            const d = Math.hypot(pt.x - p.x, pt.y - p.y);
            if (d <= r) out.push({ pt, d });
          }
        }
      }
      out.sort((a, b) => a.d - b.d);
      return out.slice(0, limit).map(o => o.pt);
    },
  };
}
