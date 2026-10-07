// Read the stated scale off a drawing's text: "SCALE 1:100", "1 : 50 @ A1", "Scale: 1/200".
// Only ever an offer; the user confirms and should still check a dimension.

export interface ScaleFound { ratio: number; text: string; confident: boolean }

const COMMON = new Set([1, 2, 5, 10, 20, 25, 50, 75, 100, 125, 150, 200, 250, 300, 400, 500, 750, 1000, 1250, 2000, 2500, 5000]);

/** Scales written on a page, likeliest first. `texts` are the page's text items in reading order. */
export function findScales(texts: string[]): ScaleFound[] {
  const found = new Map<number, ScaleFound & { votes: number }>();
  const joined = texts.join(' \n ');
  const re = /(scale|scales|sc\.?|echelle|مقياس)?[\s:=\-–]{0,4}\b1\s*[:/]\s*(\d{1,4}(?:[.,]\d)?)\b/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(joined))) {
    const ratio = parseFloat(m[2].replace(',', '.'));
    if (!(ratio >= 1 && ratio <= 5000)) continue;
    // "1:2" inside a mix ratio (1:2:4 concrete) or a slope (1:12 ramp) is not a drawing scale.
    const after = joined.slice(m.index + m[0].length, m.index + m[0].length + 3);
    if (/^\s*[:/]\s*\d/.test(after)) continue;
    const labelled = !!m[1];
    if (!labelled && !COMMON.has(ratio)) continue;
    const prev = found.get(ratio);
    const votes = (prev?.votes ?? 0) + (labelled ? 3 : 1) + (COMMON.has(ratio) && ratio >= 20 ? 1 : 0);
    found.set(ratio, { ratio, text: `1:${ratio}`, confident: labelled || (prev?.confident ?? false), votes });
  }
  return [...found.values()].sort((a, b) => b.votes - a.votes).map(({ ratio, text, confident }) => ({ ratio, text, confident }));
}
