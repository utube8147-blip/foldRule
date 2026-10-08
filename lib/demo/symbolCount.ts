// EXPERIMENT 2: count repeated symbols. Drag a box round one door or socket; every place on the
// page whose ink looks the same is found, at any quarter turn. Plain arithmetic on a black-and-white
// copy of the page, so it runs anywhere, but it does not handle scaled or mirrored copies.
// (The workspace already has "Find & count", which uses OpenCV; this is the lightweight comparison.)

export interface Ink { w: number; h: number; data: Uint8Array }
export interface Box { x: number; y: number; w: number; h: number }
export interface Match extends Box { score: number; turn: 0 | 90 | 180 | 270 }

/** RGBA pixels → 1 where there is ink (dark), 0 for paper. */
export function toInk(rgba: Uint8ClampedArray | Uint8Array, w: number, h: number, threshold = 170): Ink {
  const data = new Uint8Array(w * h);
  for (let i = 0, p = 0; i < data.length; i++, p += 4) {
    const a = rgba[p + 3];
    const lum = a === 0 ? 255 : (rgba[p] * 299 + rgba[p + 1] * 587 + rgba[p + 2] * 114) / 1000;
    data[i] = lum < threshold ? 1 : 0;
  }
  return { w, h, data };
}

export function crop(ink: Ink, b: Box): Ink {
  const x0 = Math.max(0, Math.round(b.x)), y0 = Math.max(0, Math.round(b.y));
  const w = Math.max(1, Math.min(ink.w - x0, Math.round(b.w))), h = Math.max(1, Math.min(ink.h - y0, Math.round(b.h)));
  const data = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) data.set(ink.data.subarray((y0 + y) * ink.w + x0, (y0 + y) * ink.w + x0 + w), y * w);
  return { w, h, data };
}

/** Quarter turn clockwise. */
export function rotate90(t: Ink): Ink {
  const out = new Uint8Array(t.w * t.h);
  for (let y = 0; y < t.h; y++) for (let x = 0; x < t.w; x++) out[x * t.h + (t.h - 1 - y)] = t.data[y * t.w + x];
  return { w: t.h, h: t.w, data: out };
}

/** Each ink pixel spread to its eight neighbours: forgives a one-pixel misalignment. */
function dilate(ink: Ink): Ink {
  const { w, h, data } = ink, out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (!data[y * w + x]) continue;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx >= 0 && yy >= 0 && xx < w && yy < h) out[yy * w + xx] = 1;
    }
  }
  return { w, h, data: out };
}

/** Summed-area table: ink in any rectangle in four look-ups. */
function integral(ink: Ink): Uint32Array {
  const W = ink.w + 1, s = new Uint32Array(W * (ink.h + 1));
  for (let y = 0; y < ink.h; y++) {
    let row = 0;
    for (let x = 0; x < ink.w; x++) { row += ink.data[y * ink.w + x]; s[(y + 1) * W + x + 1] = s[y * W + x + 1] + row; }
  }
  return s;
}

export interface FindOptions { minScore?: number; turns?: boolean; max?: number }

/**
 * Every place on `page` that looks like the symbol in `box` (which must be on the same page).
 * Score is 0–1: how much of the two patches' ink coincides. The sample itself comes back as a match.
 */
export function findSymbols(page: Ink, box: Box, { minScore = 0.8, turns = true, max = 500 }: FindOptions = {}): Match[] {
  let tpl = crop(page, box);
  const dil = dilate(page), sum = integral(page), W = page.w + 1;
  const count = (x: number, y: number, w: number, h: number) => sum[(y + h) * W + x + w] - sum[y * W + x + w] - sum[(y + h) * W + x] + sum[y * W + x];
  const found: Match[] = [];
  for (const turn of (turns ? [0, 90, 180, 270] : [0]) as Match['turn'][]) {
    if (turn) tpl = rotate90(tpl);
    const pts: number[] = [];
    for (let y = 0; y < tpl.h; y++) for (let x = 0; x < tpl.w; x++) if (tpl.data[y * tpl.w + x]) pts.push(x, y);
    const c = pts.length / 2;
    if (c < 6) continue;                                    // an empty box matches everywhere
    const slack = Math.max(4, c * 0.3);
    for (let y = 0; y + tpl.h <= page.h; y++) {
      for (let x = 0; x + tpl.w <= page.w; x++) {
        const n = count(x, y, tpl.w, tpl.h);
        if (Math.abs(n - c) > slack) continue;              // wrong amount of ink: cannot be it
        let hits = 0;
        const need = minScore * (c + n) / 2;
        for (let i = 0; i < pts.length; i += 2) {
          if (dil.data[(y + pts[i + 1]) * page.w + x + pts[i]]) hits++;
          else if (hits + (pts.length - i) / 2 < need) break; // cannot reach the score any more
        }
        const loose = Math.min(1, (2 * hits) / (c + n));
        if (loose < minScore) continue;
        // Rank by the exact overlap, so of two neighbouring positions the truly aligned one wins.
        let exact = 0;
        for (let i = 0; i < pts.length; i += 2) if (page.data[(y + pts[i + 1]) * page.w + x + pts[i]]) exact++;
        const score = Math.min(1, (loose + (2 * exact) / (c + n)) / 2);
        if (score >= minScore - 0.1) found.push({ x, y, w: tpl.w, h: tpl.h, score, turn });
      }
    }
  }
  // Keep the best of each cluster of overlapping hits.
  found.sort((a, b) => b.score - a.score);
  const kept: Match[] = [];
  const near = Math.max(3, Math.min(box.w, box.h) * 0.5);
  for (const m of found) {
    const cx = m.x + m.w / 2, cy = m.y + m.h / 2;
    if (!kept.some(k => Math.abs(k.x + k.w / 2 - cx) < near && Math.abs(k.y + k.h / 2 - cy) < near)) kept.push(m);
    if (kept.length >= max) break;
  }
  return kept;
}
