// public/maskWorker.js
// Receives: { type:'build', buffer: ArrayBuffer, width, height }
// Posts back: { type:'ready', labelMap: Uint32Array buffer, regionCount,
//               regionPixels: serialised map, skeletonBuffer }

self.onmessage = (e) => {
  if (e.data.type === 'build') buildMask(e.data);
};

// ─── Sobel edge detection ────────────────────────────────────────────────────
function sobelEdges(data, w, h) {
  const mag = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const luma = (i) => {
        const o = i * 4;
        return 0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2];
      };
      const tl = luma((y-1)*w+(x-1)), tc = luma((y-1)*w+x), tr = luma((y-1)*w+(x+1));
      const ml = luma(  y  *w+(x-1)),                        mr = luma(  y  *w+(x+1));
      const bl = luma((y+1)*w+(x-1)), bc = luma((y+1)*w+x), br = luma((y+1)*w+(x+1));
      const gx = -tl - 2*ml - bl + tr + 2*mr + br;
      const gy = -tl - 2*tc - tr + bl + 2*bc + br;
      mag[y * w + x] = Math.sqrt(gx*gx + gy*gy);
    }
  }
  return mag;
}

// ─── Adaptive threshold on Sobel magnitude ───────────────────────────────────
// Tile-based: each 32×32 block gets its own threshold = mean + k*std
function adaptiveEdgeMask(mag, w, h, k = 0.5) {
  const TILE = 32;
  const wall = new Uint8Array(w * h);
  for (let ty = 0; ty < h; ty += TILE) {
    for (let tx = 0; tx < w; tx += TILE) {
      let sum = 0, count = 0;
      for (let dy = 0; dy < TILE && ty+dy < h; dy++)
        for (let dx = 0; dx < TILE && tx+dx < w; dx++) {
          sum += mag[(ty+dy)*w+(tx+dx)]; count++;
        }
      const mean = sum / count;
      let variance = 0;
      for (let dy = 0; dy < TILE && ty+dy < h; dy++)
        for (let dx = 0; dx < TILE && tx+dx < w; dx++)
          variance += (mag[(ty+dy)*w+(tx+dx)] - mean) ** 2;
      const std = Math.sqrt(variance / count);
      const thresh = mean + k * std;
      for (let dy = 0; dy < TILE && ty+dy < h; dy++)
        for (let dx = 0; dx < TILE && tx+dx < w; dx++) {
          const i = (ty+dy)*w+(tx+dx);
          if (mag[i] > thresh) wall[i] = 1;
        }
    }
  }
  return wall;
}

// ─── Zhang-Suen thinning ─────────────────────────────────────────────────────
// Iteratively strips wall pixels until skeleton is 1px wide
function zhangSuen(src, w, h) {
  const img = new Uint8Array(src);
  let changed = true;
  while (changed) {
    changed = false;
    for (let pass = 0; pass < 2; pass++) {
      const toDelete = [];
      for (let y = 1; y < h-1; y++) {
        for (let x = 1; x < w-1; x++) {
          if (!img[y*w+x]) continue;
          const p2=img[(y-1)*w+x], p3=img[(y-1)*w+(x+1)], p4=img[y*w+(x+1)],
                p5=img[(y+1)*w+(x+1)], p6=img[(y+1)*w+x], p7=img[(y+1)*w+(x-1)],
                p8=img[y*w+(x-1)], p9=img[(y-1)*w+(x-1)];
          const neighbors = p2+p3+p4+p5+p6+p7+p8+p9;
          if (neighbors < 2 || neighbors > 6) continue;
          const transitions = (!p2&&p3?1:0)+(!p3&&p4?1:0)+(!p4&&p5?1:0)+(!p5&&p6?1:0)+
                              (!p6&&p7?1:0)+(!p7&&p8?1:0)+(!p8&&p9?1:0)+(!p9&&p2?1:0);
          if (transitions !== 1) continue;
          if (pass === 0 && p2*p4*p6 !== 0) continue;
          if (pass === 0 && p4*p6*p8 !== 0) continue;
          if (pass === 1 && p2*p4*p8 !== 0) continue;
          if (pass === 1 && p2*p6*p8 !== 0) continue;
          toDelete.push(y*w+x);
        }
      }
      for (const i of toDelete) { img[i] = 0; changed = true; }
    }
  }
  return img;
}

// ─── Connected component labeling (union-find, two-pass) ────────────────────
function labelRegions(wall, w, h) {
  const label  = new Int32Array(w * h).fill(-1);
  const parent = [];
  const find   = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const union  = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[b] = a; };

  let nextLabel = 0;

  // First pass
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (wall[y*w+x]) continue; // skip wall pixels
      const up   = y > 0 ? label[(y-1)*w+x]   : -1;
      const left = x > 0 ? label[y*w+(x-1)]   : -1;
      if (up === -1 && left === -1) {
        label[y*w+x] = nextLabel;
        parent.push(nextLabel);
        nextLabel++;
      } else if (up !== -1 && left === -1) {
        label[y*w+x] = up;
      } else if (up === -1 && left !== -1) {
        label[y*w+x] = left;
      } else {
        label[y*w+x] = Math.min(up, left);
        union(up, left);
      }
    }
  }

  // Second pass — flatten labels
  const remap = new Int32Array(nextLabel).fill(-1);
  let regionCount = 0;
  for (let i = 0; i < w*h; i++) {
    if (label[i] === -1) continue;
    const root = find(label[i]);
    if (remap[root] === -1) remap[root] = regionCount++;
    label[i] = remap[root];
  }

  return { label, regionCount };
}

// ─── Filter tiny noise regions (text blobs, specks) ─────────────────────────
function filterSmallRegions(label, regionCount, w, h, minPx = 200) {
  const sizes = new Int32Array(regionCount);
  for (let i = 0; i < w*h; i++) if (label[i] >= 0) sizes[label[i]]++;
  const remap = new Int32Array(regionCount).fill(-1);
  let newCount = 0;
  for (let r = 0; r < regionCount; r++)
    if (sizes[r] >= minPx) remap[r] = newCount++;
  const out = new Int32Array(w*h).fill(-1);
  for (let i = 0; i < w*h; i++)
    if (label[i] >= 0 && remap[label[i]] >= 0) out[i] = remap[label[i]];
  return { label: out, regionCount: newCount };
}

// ─── Build per-region pixel lists ────────────────────────────────────────────
function buildRegionPixels(label, regionCount, w, h) {
  const sizes = new Int32Array(regionCount);
  for (let i = 0; i < w*h; i++) if (label[i] >= 0) sizes[label[i]]++;
  const offsets = new Int32Array(regionCount + 1);
  for (let r = 0; r < regionCount; r++) offsets[r+1] = offsets[r] + sizes[r];
  const pixels = new Int32Array(offsets[regionCount]);
  const cursors = new Int32Array(offsets); // copy
  for (let i = 0; i < w*h; i++) {
    const r = label[i]; if (r < 0) continue;
    pixels[cursors[r]++] = i;
  }
  return { pixels, offsets };
}

// ─── Main ────────────────────────────────────────────────────────────────────
function buildMask({ buffer, width: w, height: h }) {
  const data = new Uint8ClampedArray(buffer);

  // 1. Sobel magnitude
  const mag = sobelEdges(data, w, h);

  // 2. Adaptive threshold → binary wall mask
  let wall = adaptiveEdgeMask(mag, w, h, 0.6);

  // 3. Zhang-Suen skeletonization → 1px-wide walls
  wall = zhangSuen(wall, w, h);

  // 4. CCL
  let { label, regionCount } = labelRegions(wall, w, h);

  // 5. Remove specks (text glyphs, noise)
  ({ label, regionCount } = filterSmallRegions(label, regionCount, w, h, 300));

  // 6. Build pixel lists for instant painting
  const { pixels, offsets } = buildRegionPixels(label, regionCount, w, h);

  // Serialise label as Uint32Array (−1 → 0xFFFFFFFF sentinel)
  const labelMap = new Uint32Array(w * h);
  for (let i = 0; i < w*h; i++)
    labelMap[i] = label[i] < 0 ? 0xFFFFFFFF : label[i];

  self.postMessage(
    { type: 'ready', labelMap: labelMap.buffer,
      pixelsBuf: pixels.buffer, offsetsBuf: offsets.buffer,
      regionCount, width: w, height: h },
    [labelMap.buffer, pixels.buffer, offsets.buffer]
  );
}