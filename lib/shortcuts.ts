// Keyboard shortcuts the user can change. Single keys only (letters, digits,
// F-keys, punctuation); saved on this device.

import { useSyncExternalStore } from 'react';

export type ShortcutId =
  | 'select' | 'area' | 'rectangle' | 'circle' | 'ellipse' | 'length' | 'arc'
  | 'count' | 'findCount' | 'grid' | 'marker' | 'magic' | 'scale' | 'offset'
  | 'curve' | 'snap' | 'angle' | 'swap' | 'close' | 'drawer' | 'takeoff' | 'help';

export const SHORTCUT_LIST: { id: ShortcutId; label: string; group: 'Tools' | 'While drawing' | 'Panels'; key: string }[] = [
  { id: 'select',    label: 'Select / move',                 group: 'Tools', key: 'v' },
  { id: 'area',      label: 'Area — draw outline',           group: 'Tools', key: 'p' },
  { id: 'rectangle', label: 'Area — rectangle',              group: 'Tools', key: 'r' },
  { id: 'circle',    label: 'Area — circle',                 group: 'Tools', key: 'c' },
  { id: 'ellipse',   label: 'Area — ellipse',                group: 'Tools', key: 'e' },
  { id: 'length',    label: 'Length — draw run',             group: 'Tools', key: 'l' },
  { id: 'arc',       label: 'Length — single arc',           group: 'Tools', key: 'b' },
  { id: 'count',     label: 'Count — items',                 group: 'Tools', key: 'n' },
  { id: 'findCount', label: 'Count — find & count',          group: 'Tools', key: 'f' },
  { id: 'grid',      label: 'Count — on a grid',             group: 'Tools', key: 'g' },
  { id: 'marker',    label: 'Marker',                        group: 'Tools', key: 't' },
  { id: 'magic',     label: 'Magic fill',                    group: 'Tools', key: 'm' },
  { id: 'scale',     label: 'Set scale',                     group: 'Tools', key: 'k' },
  { id: 'offset',    label: 'Perimeter offset',              group: 'Tools', key: 'o' },
  { id: 'curve',     label: 'Next edge straight ↔ curved',   group: 'While drawing', key: 'a' },
  { id: 'snap',      label: 'Snap on / off',                 group: 'While drawing', key: 's' },
  { id: 'angle',     label: 'Angle lock (0° / 45° / 90°)',   group: 'While drawing', key: 'f8' },
  { id: 'swap',      label: 'Pause / resume: swap with Select (Space always does this too)', group: 'While drawing', key: '' },
  { id: 'close',     label: 'Finish the shape (Enter always does this too)',                  group: 'While drawing', key: '' },
  { id: 'drawer',    label: 'Drawings & project details',    group: 'Panels', key: '[' },
  { id: 'takeoff',   label: 'Show / hide takeoff panel',     group: 'Panels', key: ']' },
  { id: 'help',      label: 'This list',                     group: 'Panels', key: '?' },
];

export type WheelMode = 'zoom' | 'scroll';     // what the plain wheel does (Ctrl + wheel does the other)
interface Saved { keys: Partial<Record<ShortcutId, string>>; wheel: WheelMode }

const STORE = 'foldrule:shortcuts';
const DEFAULTS = Object.fromEntries(SHORTCUT_LIST.map(s => [s.id, s.key])) as Record<ShortcutId, string>;
/** Keys that already mean something fixed and can't be reassigned. */
const RESERVED = new Set(['enter', 'escape', 'delete', 'backspace', ' ', 'tab', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'shift', 'control', 'alt', 'meta', 'capslock']);

let saved: Saved = { keys: {}, wheel: 'zoom' };
let snapshot = 0;
let loaded = false;
const listeners = new Set<() => void>();

function load() {
  if (loaded || typeof window === 'undefined') return;
  loaded = true;
  try {
    const raw = JSON.parse(window.localStorage.getItem(STORE) ?? 'null');
    if (raw && typeof raw === 'object') {
      const keys: Saved['keys'] = {};
      for (const s of SHORTCUT_LIST) {
        const k = raw.keys?.[s.id];
        if (typeof k === 'string' && !RESERVED.has(k)) keys[s.id] = k;
      }
      saved = { keys, wheel: raw.wheel === 'scroll' ? 'scroll' : 'zoom' };
    }
  } catch { /* unreadable settings → defaults */ }
}
function commit(next: Saved) {
  saved = next; snapshot += 1;
  try { window.localStorage.setItem(STORE, JSON.stringify(saved)); } catch { /* private window: lasts for this visit */ }
  listeners.forEach(l => l());
}

/**
 * Ready-made sets. "planswift" follows PlanSwift's defaults where this app has
 * the same action: 1 / 2 / 4 start Area / Linear / Count, R pauses and resumes,
 * C closes the shape, A is an arc point, F3 snap, F8 angle. Keys that would
 * clash are moved (Rectangle → Q, Circle → W); everything else stays.
 */
export const PRESETS: Record<'foldrule' | 'planswift', { label: string; keys: Partial<Record<ShortcutId, string>> }> = {
  foldrule:  { label: 'Foldrule', keys: {} },
  planswift: { label: 'PlanSwift style', keys: { area: '1', length: '2', count: '4', swap: 'r', close: 'c', rectangle: 'q', circle: 'w', snap: 'f3' } },
};
export function applyPreset(name: keyof typeof PRESETS) { load(); commit({ ...saved, keys: { ...PRESETS[name].keys } }); }
export function activePreset(): keyof typeof PRESETS | null {
  load();
  for (const name of Object.keys(PRESETS) as (keyof typeof PRESETS)[]) {
    if (SHORTCUT_LIST.every(s => shortcutKey(s.id) === (PRESETS[name].keys[s.id] ?? DEFAULTS[s.id]))) return name;
  }
  return null;
}
/** Leave an action without a key. */
export function clearShortcut(id: ShortcutId) { load(); commit({ ...saved, keys: { ...saved.keys, [id]: '' } }); }

export const normaliseKey = (key: string) => (key.length === 1 ? key.toLowerCase() : key.toLowerCase());
export const canAssign = (key: string) => !!key && !RESERVED.has(normaliseKey(key));

export function shortcutKey(id: ShortcutId): string { load(); return saved.keys[id] ?? DEFAULTS[id]; }
/** How a key is shown: "P", "F8", "[". */
export function keyLabel(id: ShortcutId): string { const k = shortcutKey(id); return k ? k.toUpperCase() : '—'; }
export function actionForKey(key: string): ShortcutId | undefined {
  load();
  const k = normaliseKey(key);
  if (!k) return undefined;
  return SHORTCUT_LIST.find(s => shortcutKey(s.id) === k)?.id;
}
/** Give an action a new key. If another action had that key, the two swap. Returns the action it swapped with. */
export function setShortcut(id: ShortcutId, key: string): ShortcutId | undefined {
  load();
  const k = normaliseKey(key);
  if (!canAssign(k)) return undefined;
  const old = shortcutKey(id);
  const other = SHORTCUT_LIST.find(s => s.id !== id && shortcutKey(s.id) === k)?.id;
  const keys = { ...saved.keys, [id]: k };
  if (other) keys[other] = old;
  commit({ ...saved, keys });
  return other;
}
export function wheelMode(): WheelMode { load(); return saved.wheel; }
export function setWheelMode(wheel: WheelMode) { load(); commit({ ...saved, wheel }); }
export function resetShortcuts() { load(); commit({ keys: {}, wheel: 'zoom' }); }
export const isCustomised = () => { load(); return activePreset() !== 'foldrule' || saved.wheel !== 'zoom'; };

/** Re-render when shortcuts change. */
export function useShortcuts(): number {
  return useSyncExternalStore(
    cb => { listeners.add(cb); return () => { listeners.delete(cb); }; },
    () => { load(); return snapshot; },
    () => 0,
  );
}
/** For tests. */
export function __resetShortcutsForTests() { saved = { keys: {}, wheel: 'zoom' }; loaded = true; snapshot += 1; }

/**
 * Is this key press "delete"? Laptops differ: some send Delete, older ones
 * "Del", and on keyboards where Del and Ins share one key the plain press can
 * arrive as Insert (Del only with Fn). All of them count, as does Backspace.
 */
export function isDeleteKey(e: { key: string; code?: string }): boolean {
  return e.key === 'Delete' || e.key === 'Del' || e.key === 'Backspace' || e.key === 'Insert' ||
    e.code === 'Delete' || (e.code === 'NumpadDecimal' && e.key !== '.' && e.key !== ',');
}
