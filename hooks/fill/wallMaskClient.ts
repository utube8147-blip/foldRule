'use client';
// Runs the wall-mask pixel work in workers/wallMask.worker.js and caches the
// result per PDF page, so re-opening a page (or switching plans back and
// forth with Magic Fill selected) doesn't rebuild it.

export interface WallMask { mask: Uint8Array; w: number; h: number }

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, { resolve: (m: Uint8Array) => void; reject: (e: Error) => void }>();

function getWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL('../../workers/wallMask.worker.js', import.meta.url));
  worker.onmessage = (e: MessageEvent<{ id: number; mask?: Uint8Array; error?: string }>) => {
    const p = pending.get(e.data.id);
    if (!p) return;
    pending.delete(e.data.id);
    if (e.data.mask) p.resolve(e.data.mask); else p.reject(new Error(e.data.error || 'mask worker failed'));
  };
  worker.onerror = (err) => {
    for (const p of pending.values()) p.reject(new Error(err.message || 'mask worker crashed'));
    pending.clear();
    worker?.terminate();
    worker = null;
  };
  return worker;
}

/** Build a wall mask from RGBA pixels in a worker (the pixel buffer is transferred). */
export function buildWallMaskInWorker(data: Uint8ClampedArray, w: number, h: number): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    getWorker().postMessage({ id, data, w, h }, [data.buffer]);
  });
}

/** Masks by PDF page object — entries go away with the page / document. */
export const maskCache = new WeakMap<object, WallMask>();
