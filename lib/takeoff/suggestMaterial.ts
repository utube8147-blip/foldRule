// Guess the material from what a group or row is called: "Tile 1 floor area" → ceramic floor tiles.
// A ranked shortlist, never applied without a click.

import type { Material } from '@/types';

/** What people write → words found in material names. */
const SYNONYMS: [RegExp, string[]][] = [
  [/\btil(e|es|ing)\b/, ['tile', 'tiles', 'ceramic', 'porcelain']],
  [/\b(wall|walls|blockwork|block|partition)\b/, ['block', 'wall', 'blockwork', 'partition', 'drywall']],
  [/\b(door|doors)\b/, ['door']],
  [/\b(window|windows|glazing)\b/, ['window', 'glazing', 'glass']],
  [/\b(paint|painting)\b/, ['paint', 'emulsion']],
  [/\b(plaster|render)\b/, ['plaster', 'render']],
  [/\b(skirting)\b/, ['skirting']],
  [/\b(ceiling)\b/, ['ceiling', 'gypsum', 'acoustic']],
  [/\b(slab|concrete|footing|column|beam)\b/, ['concrete', 'slab', 'formwork', 'reinforcement']],
  [/\b(step|steps|stair|stairs)\b/, ['stair', 'step', 'tread']],
  [/\b(carpet)\b/, ['carpet']],
  [/\b(vinyl|lvt)\b/, ['vinyl']],
  [/\b(marble|granite|stone)\b/, ['marble', 'granite', 'stone']],
  [/\b(pipe|plumbing|drain)\b/, ['pipe', 'drain']],
  [/\b(cable|socket|light|lighting|electrical)\b/, ['cable', 'socket', 'light', 'luminaire']],
  [/\b(sofa|sofas|furniture|chair|table)\b/, ['furniture', 'seating', 'sofa', 'chair', 'table']],
  [/\b(waterproof|membrane)\b/, ['waterproofing', 'membrane']],
  [/\b(roof|roofing)\b/, ['roof', 'roofing']],
  [/\b(floor|flooring)\b/, ['floor', 'flooring', 'screed']],
];
const STOP = new Set(['area', 'the', 'and', 'for', 'of', 'in', 'to', 'group', 'new', 'another', 'level', 'room', 'type', 'no']);
const UNIT = (u: string) => {
  const s = (u || '').toLowerCase().trim();
  if (['sq m', 'm²', 'm2', 'sqm'].includes(s)) return 'm2';
  if (['cu m', 'm³', 'm3'].includes(s)) return 'm3';
  if (['ea', 'each', 'nr', 'no', 'pcs'].includes(s)) return 'nr';
  return s;
};
const words = (s: string) => s.toLowerCase().replace(/[^a-z]+/g, ' ').split(' ').filter(w => w.length > 2 && !STOP.has(w));
const stem = (w: string) => w.replace(/(ing|es|s)$/, '');

export interface Suggestion { material: Material; score: number }

/**
 * Materials that fit a name, best first. `unit` (the unit the rows are measured in) and
 * `preferIds` (materials this project or the master bank already prices) break ties.
 */
export function suggestMaterials(name: string, materials: Material[], opts: { unit?: string; preferIds?: Set<string>; limit?: number } = {}): Suggestion[] {
  const text = ` ${name.toLowerCase()} `;
  const want = new Map<string, number>();
  for (const w of words(name)) want.set(stem(w), 2);                 // their own words count most
  for (const [re, add] of SYNONYMS) if (re.test(text)) for (const a of add) if (!want.has(stem(a))) want.set(stem(a), 1);
  if (!want.size) return [];
  const unit = opts.unit ? UNIT(opts.unit) : '';
  const out: Suggestion[] = [];
  for (const m of materials) {
    const have = new Set(words(m.name).map(stem));
    let score = 0;
    for (const [w, weight] of want) if (have.has(w)) score += weight;
    if (score === 0) continue;
    if (unit) score += UNIT(m.unit) === unit ? 1.5 : -1.5;         // a floor area wants a per-m² material
    if (opts.preferIds?.has(m.id)) score += 1;
    score -= have.size * 0.05;                                      // a plainer name is the likelier match
    if (score > 0.9) out.push({ material: m, score });
  }
  return out.sort((a, b) => b.score - a.score || a.material.name.localeCompare(b.material.name)).slice(0, opts.limit ?? 4);
}
