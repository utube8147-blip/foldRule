// Pick a room's name from the text printed inside it on the drawing
// ("BEDROOM 1", "Kitchen") — ignoring dimensions, levels and other numbers.

export interface TextItem { text: string; x: number; y: number; size: number }

const looksLikeName = (t: string) => {
  const s = t.trim();
  if (s.length < 2 || s.length > 40) return false;
  const letters = (s.match(/\p{L}/gu) ?? []).length;
  if (letters < 2) return false;                       // "3000", "2.4", "A"
  if (letters / s.replace(/\s/g, '').length < 0.5) return false;   // "3000x2400mm", "FFL +0.150"
  return !/^(ffl|ssl|rl|typ|nts|mm|cm|m2|m²|sqm|sq\.?\s?m)\b/i.test(s);
};

/** `inside(x, y)` says whether a point is in the room. Returns '' when no name is found. */
export function pickRoomLabel(items: TextItem[], inside: (x: number, y: number) => boolean): string {
  const cands = items.filter(i => looksLikeName(i.text) && inside(i.x, i.y));
  if (!cands.length) return '';
  const top = Math.max(...cands.map(c => c.size));
  const lines = cands.filter(c => c.size >= top * 0.8)
    .sort((a, b) => (Math.abs(a.y - b.y) > top * 0.6 ? a.y - b.y : a.x - b.x))
    .slice(0, 3);
  const name = lines.map(l => l.text.trim()).join(' ').replace(/\s+/g, ' ');
  return name.length > 40 ? name.slice(0, 40).trim() : name;
}
