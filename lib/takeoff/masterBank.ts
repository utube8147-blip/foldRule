import { unitRateOf } from '@/lib/takeoff/materialRate';
// Master material bank: the estimator's own price list, kept on this computer and shared
// by every project in the same currency. A project has its own copy of each price, so a
// job can be priced differently without disturbing the master.
//
// The two are kept in step by one rule: an EMPTY price is filled from the other side;
// two different prices are never overwritten for you, only flagged, and you choose.

import type { Material } from '@/types';

export interface MasterBank {
  /** Materials that differ from the built-in catalogue (a price, a name…) or are your own. */
  items: Record<string, Material>;
}

export const rateOf = (m?: Pick<Material, 'materialCost' | 'laborCost' | 'equipmentCost' | 'unitRate' | 'wastePercent' | 'purchase'> | null): number => unitRateOf(m);

// Waste and the buying unit are part of the price: they travel with it between project and master.
const PRICE_KEYS = ['materialCost', 'laborCost', 'equipmentCost', 'unitRate', 'wastePercent', 'purchase'] as const;
type Prices = Pick<Material, typeof PRICE_KEYS[number]>;
export const pricesOf = (m: Material): Prices => ({
  materialCost: m.materialCost ?? 0, laborCost: m.laborCost ?? 0, equipmentCost: m.equipmentCost ?? 0, unitRate: rateOf(m),
  wastePercent: m.wastePercent, purchase: m.purchase,
});
const same = (a: number, b: number) => Math.abs(a - b) < 0.005;

export type PriceState = 'both-empty' | 'project-empty' | 'master-empty' | 'same' | 'differs';
export function priceState(project: Material | undefined, master: Material | undefined): PriceState {
  const p = rateOf(project), m = rateOf(master);
  if (!p && !m) return 'both-empty';
  if (!p) return 'project-empty';
  if (!m) return 'master-empty';
  return same(p, m) ? 'same' : 'differs';
}

/** The whole master list: the built-in catalogue with your prices on top, then your own materials. */
export function masterMaterials(bank: MasterBank, catalogue: Material[]): Material[] {
  const ids = new Set(catalogue.map(m => m.id));
  return [
    ...catalogue.map(m => (bank.items[m.id] ? { ...m, ...bank.items[m.id], builtIn: true } : m)),
    ...Object.values(bank.items).filter(m => !ids.has(m.id)),
  ];
}

export interface Reconciled {
  project: Material[];
  bank: MasterBank;
  /** Project prices that were empty and took the master's. */
  filledProject: string[];
  /** Master prices that were empty and took the project's. */
  filledMaster: string[];
  /** Both priced, differently: left alone for you to decide. */
  differs: string[];
}

/**
 * Bring a project's materials and the master bank into step. Empty prices are filled from
 * the other side, your own materials are shared both ways, and differing prices are reported.
 */
export function reconcile(project: Material[], bank: MasterBank, catalogue: Material[]): Reconciled {
  const master = new Map(masterMaterials(bank, catalogue).map(m => [m.id, m]));
  const items = { ...bank.items };
  const filledProject: string[] = [], filledMaster: string[] = [], differs: string[] = [];
  const seen = new Set<string>();

  const nextProject = project.map(p => {
    seen.add(p.id);
    const m = master.get(p.id);
    if (!m) {
      // A material made in this project: it joins the master so the next project has it.
      items[p.id] = { ...p, builtIn: false };
      if (rateOf(p)) filledMaster.push(p.id);
      return p;
    }
    switch (priceState(p, m)) {
      case 'project-empty': filledProject.push(p.id); return { ...p, ...pricesOf(m) };
      case 'master-empty': items[p.id] = { ...m, ...pricesOf(p) }; filledMaster.push(p.id); return p;
      case 'differs': differs.push(p.id); return p;
      default: return p;
    }
  });
  // Your own materials from other projects become available here too.
  const catalogueIds = new Set(catalogue.map(m => m.id));
  for (const m of Object.values(bank.items)) {
    if (!seen.has(m.id) && !catalogueIds.has(m.id)) nextProject.push({ ...m });
  }
  const changed = filledProject.length > 0 || nextProject.length !== project.length;
  return { project: changed ? nextProject : project, bank: { items }, filledProject, filledMaster, differs };
}

/** Set (or change) a material in the master. */
export function setMaster(bank: MasterBank, material: Material): MasterBank {
  return { items: { ...bank.items, [material.id]: { ...material, unitRate: rateOf(material) } } };
}
export function removeFromMaster(bank: MasterBank, id: string): MasterBank {
  const { [id]: _gone, ...rest } = bank.items;
  return { items: rest };
}

// ─── Storage (this computer, one bank per currency) ──────────────────────────

const key = (currency?: string | null) => `foldrule:master-bank:v1:${(currency || 'default').toUpperCase()}`;

/** Fired on `window` after the master bank was changed here (so it can be written to the project folder). */
export const MASTER_BANK_CHANGED = 'foldrule:master-bank-changed';
/** Fired on `window` after newer prices were brought in from the project folder. */
export const MASTER_BANK_PULLED = 'foldrule:master-bank-pulled';

/** The bank as kept on disk: each item carries the time it was last changed (or removed), so two computers can be merged. */
export interface StoredBank { items: Record<string, Material>; stamps: Record<string, number> }

const KEY_PREFIX = 'foldrule:master-bank:v1:';

function readStored(currency?: string | null): StoredBank {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(key(currency)) : null;
    const parsed = raw ? JSON.parse(raw) : null;
    if (parsed && typeof parsed.items === 'object' && parsed.items) {
      return { items: parsed.items, stamps: parsed.stamps && typeof parsed.stamps === 'object' ? parsed.stamps : {} };
    }
  } catch { /* unreadable: start empty */ }
  return { items: {}, stamps: {} };
}

export function loadMasterBank(currency?: string | null): MasterBank {
  return { items: readStored(currency).items };
}

export function saveMasterBank(bank: MasterBank, currency?: string | null): boolean {
  try {
    // Stamp whatever differs from what was stored: added, changed or removed.
    const prev = readStored(currency);
    const stamps = { ...prev.stamps };
    const now = Date.now();
    let changed = false;
    for (const id of new Set([...Object.keys(prev.items), ...Object.keys(bank.items)])) {
      if (JSON.stringify(prev.items[id]) !== JSON.stringify(bank.items[id])) { stamps[id] = now; changed = true; }
    }
    localStorage.setItem(key(currency), JSON.stringify({ items: bank.items, stamps }));
    if (changed && typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') window.dispatchEvent(new Event(MASTER_BANK_CHANGED));
    return true;
  } catch { return false; }
}

/**
 * Merge two copies of a bank item by item: the more recently changed side wins, and a removal
 * is remembered so it is not brought back. Says which side was missing something.
 */
export function mergeStoredBanks(local: StoredBank, remote: StoredBank): { merged: StoredBank; localChanged: boolean; remoteChanged: boolean } {
  const merged: StoredBank = { items: {}, stamps: {} };
  let localChanged = false, remoteChanged = false;
  for (const id of new Set([...Object.keys(local.items), ...Object.keys(remote.items), ...Object.keys(local.stamps), ...Object.keys(remote.stamps)])) {
    const l = local.stamps[id] ?? 0, r = remote.stamps[id] ?? 0;
    // Never stamped on either side (an old file): keep whichever has it, local first.
    const useRemote = r > l || (r === l && !(id in local.items) && id in remote.items);
    const from = useRemote ? remote : local;
    if (id in from.items) merged.items[id] = from.items[id];
    if (Math.max(l, r) > 0) merged.stamps[id] = Math.max(l, r);
    const same = (a: StoredBank) => JSON.stringify(a.items[id]) === JSON.stringify(merged.items[id]);
    if (!same(local)) localChanged = true;
    if (!same(remote) || r < l) remoteChanged = true;
  }
  return { merged, localChanged, remoteChanged };
}

/** Every bank on this computer, by currency. */
export function allStoredBanks(): Record<string, StoredBank> {
  const out: Record<string, StoredBank> = {};
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k?.startsWith(KEY_PREFIX)) out[k.slice(KEY_PREFIX.length)] = readStored(k.slice(KEY_PREFIX.length));
    }
  } catch { /* storage blocked */ }
  return out;
}

/**
 * Bring this computer's banks and a folder copy into step. Local storage is updated here;
 * the result says what the folder file should now hold and whether it needs rewriting.
 */
export function mergeBanksWithCopy(remote: Record<string, StoredBank>): { banks: Record<string, StoredBank>; localChanged: boolean; remoteChanged: boolean } {
  const local = allStoredBanks();
  const banks: Record<string, StoredBank> = {};
  let localChanged = false, remoteChanged = false;
  for (const cur of new Set([...Object.keys(local), ...Object.keys(remote)])) {
    const r = remote[cur] && typeof remote[cur].items === 'object' ? { items: remote[cur].items ?? {}, stamps: remote[cur].stamps ?? {} } : { items: {}, stamps: {} };
    const m = mergeStoredBanks(local[cur] ?? { items: {}, stamps: {} }, r);
    banks[cur] = m.merged;
    if (m.remoteChanged || !remote[cur]) remoteChanged = true;
    if (m.localChanged) {
      localChanged = true;
      try { localStorage.setItem(key(cur), JSON.stringify(m.merged)); } catch { /* full: the folder still has it */ }
    }
  }
  if (localChanged && typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') window.dispatchEvent(new Event(MASTER_BANK_PULLED));
  return { banks, localChanged, remoteChanged };
}

/**
 * A price set somewhere outside the bank screen (e.g. while proposing an alternative): the
 * master learns it by the usual rule. A material it has never seen is added; one it has
 * without a price takes this price; one it already prices is left alone. Returns what happened.
 */
export function rememberInMaster(material: Material, currency: string, catalogue: Material[]): 'added' | 'priced' | 'kept' {
  const bank = loadMasterBank(currency);
  const known = masterMaterials(bank, catalogue).find(m => m.id === material.id);
  if (!known) { saveMasterBank(setMaster(bank, { ...material, builtIn: false }), currency); return 'added'; }
  if (rateOf(known) === 0 && rateOf(material) > 0) { saveMasterBank(setMaster(bank, { ...known, ...pricesOf(material) }), currency); return 'priced'; }
  return 'kept';
}
