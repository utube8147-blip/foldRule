// src/workers/maskWorker.js

self.onerror = function (e) {
  console.error('[MaskWorker] uncaught error:', e.message, 'line:', e.lineno);
};

self.onmessage = function (e) {
  if (e.data.type === 'build') {
    try {
      buildMask(e.data);
    } catch (err) {
      console.error('[MaskWorker] buildMask threw:', err);
      self.postMessage({ type: 'error', message: String(err) });
    }
  }
};

// ── Sobel edge detection ─────────────────────────────────────────────────────
function sobelEdges(data, w, h) {
  var mag = new Float32Array(w * h);
  for (var y = 1; y < h - 1; y++) {
    for (var x = 1; x < w - 1; x++) {
      var tl = luma(data, (y - 1) * w + (x - 1));
      var tc = luma(data, (y - 1) * w + x);
      var tr = luma(data, (y - 1) * w + (x + 1));
      var ml = luma(data, y * w + (x - 1));
      var mr = luma(data, y * w + (x + 1));
      var bl = luma(data, (y + 1) * w + (x - 1));
      var bc = luma(data, (y + 1) * w + x);
      var br = luma(data, (y + 1) * w + (x + 1));
      var gx = -tl - 2 * ml - bl + tr + 2 * mr + br;
      var gy = -tl - 2 * tc - tr + bl + 2 * bc + br;
      mag[y * w + x] = Math.sqrt(gx * gx + gy * gy);
    }
  }
  return mag;
}

function luma(data, idx) {
  var o = idx * 4;
  if (data[o + 3] < 20) return 255; // transparent → treat as white (open space)
  return 0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2];
}

// ── Adaptive threshold on Sobel magnitude ────────────────────────────────────
function adaptiveEdgeMask(mag, w, h, k) {
  k = k || 0.5;
  var TILE = 32;
  var wall = new Uint8Array(w * h);
  for (var ty = 0; ty < h; ty += TILE) {
    for (var tx = 0; tx < w; tx += TILE) {
      var sum = 0, count = 0;
      for (var dy = 0; dy < TILE && ty + dy < h; dy++)
        for (var dx = 0; dx < TILE && tx + dx < w; dx++) {
          sum += mag[(ty + dy) * w + (tx + dx)];
          count++;
        }
      var mean = sum / count;
      var variance = 0;
      for (var dy2 = 0; dy2 < TILE && ty + dy2 < h; dy2++)
        for (var dx2 = 0; dx2 < TILE && tx + dx2 < w; dx2++)
          variance += Math.pow(mag[(ty + dy2) * w + (tx + dx2)] - mean, 2);
      var std = Math.sqrt(variance / count);
      var thresh = mean + k * std;
      for (var dy3 = 0; dy3 < TILE && ty + dy3 < h; dy3++)
        for (var dx3 = 0; dx3 < TILE && tx + dx3 < w; dx3++) {
          var i = (ty + dy3) * w + (tx + dx3);
          if (mag[i] > thresh) wall[i] = 1;
        }
    }
  }
  return wall;
}

// ── Zhang-Suen thinning ──────────────────────────────────────────────────────
function zhangSuen(src, w, h) {
  var img = new Uint8Array(src);
  var changed = true;
  while (changed) {
    changed = false;
    for (var pass = 0; pass < 2; pass++) {
      var toDelete = [];
      for (var y = 1; y < h - 1; y++) {
        for (var x = 1; x < w - 1; x++) {
          if (!img[y * w + x]) continue;
          var p2 = img[(y - 1) * w + x],
            p3 = img[(y - 1) * w + (x + 1)],
            p4 = img[y * w + (x + 1)],
            p5 = img[(y + 1) * w + (x + 1)],
            p6 = img[(y + 1) * w + x],
            p7 = img[(y + 1) * w + (x - 1)],
            p8 = img[y * w + (x - 1)],
            p9 = img[(y - 1) * w + (x - 1)];
          var nb = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9;
          if (nb < 2 || nb > 6) continue;
          var tr =
            (!p2 && p3 ? 1 : 0) +
            (!p3 && p4 ? 1 : 0) +
            (!p4 && p5 ? 1 : 0) +
            (!p5 && p6 ? 1 : 0) +
            (!p6 && p7 ? 1 : 0) +
            (!p7 && p8 ? 1 : 0) +
            (!p8 && p9 ? 1 : 0) +
            (!p9 && p2 ? 1 : 0);
          if (tr !== 1) continue;
          if (pass === 0 && p2 * p4 * p6 !== 0) continue;
          if (pass === 0 && p4 * p6 * p8 !== 0) continue;
          if (pass === 1 && p2 * p4 * p8 !== 0) continue;
          if (pass === 1 && p2 * p6 * p8 !== 0) continue;
          toDelete.push(y * w + x);
        }
      }
      for (var k2 = 0; k2 < toDelete.length; k2++) {
        img[toDelete[k2]] = 0;
        changed = true;
      }
    }
  }
  return img;
}

// ── Connected component labeling (two-pass union-find) ───────────────────────
function labelRegions(wall, w, h) {
  var label = new Int32Array(w * h).fill(-1);
  var parent = [];

  function find(x) {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  }
  function union(a, b) {
    a = find(a);
    b = find(b);
    if (a !== b) parent[b] = a;
  }

  var nextLabel = 0;
  for (var y = 0; y < h; y++) {
    for (var x = 0; x < w; x++) {
      if (wall[y * w + x]) continue;
      var up = y > 0 ? label[(y - 1) * w + x] : -1;
      var left = x > 0 ? label[y * w + (x - 1)] : -1;
      if (up === -1 && left === -1) {
        label[y * w + x] = nextLabel;
        parent.push(nextLabel);
        nextLabel++;
      } else if (up !== -1 && left === -1) {
        label[y * w + x] = up;
      } else if (up === -1 && left !== -1) {
        label[y * w + x] = left;
      } else {
        label[y * w + x] = Math.min(up, left);
        union(up, left);
      }
    }
  }

  // Second pass — flatten
  var remap = new Int32Array(nextLabel).fill(-1);
  var regionCount = 0;
  for (var i = 0; i < w * h; i++) {
    if (label[i] === -1) continue;
    var root = find(label[i]);
    if (remap[root] === -1) remap[root] = regionCount++;
    label[i] = remap[root];
  }

  return { label: label, regionCount: regionCount };
}

// ── Filter tiny noise regions (text blobs, specks) ───────────────────────────
function filterSmallRegions(label, regionCount, w, h, minPx) {
  minPx = minPx || 200;
  var sizes = new Int32Array(regionCount);
  for (var i = 0; i < w * h; i++) if (label[i] >= 0) sizes[label[i]]++;
  var remap = new Int32Array(regionCount).fill(-1);
  var newCount = 0;
  for (var r = 0; r < regionCount; r++)
    if (sizes[r] >= minPx) remap[r] = newCount++;
  var out = new Int32Array(w * h).fill(-1);
  for (var i2 = 0; i2 < w * h; i2++)
    if (label[i2] >= 0 && remap[label[i2]] >= 0) out[i2] = remap[label[i2]];
  return { label: out, regionCount: newCount };
}

// ── Build per-region pixel lists ─────────────────────────────────────────────
function buildRegionPixels(label, regionCount, w, h) {
  var sizes = new Int32Array(regionCount);
  for (var i = 0; i < w * h; i++) if (label[i] >= 0) sizes[label[i]]++;
  var offsets = new Int32Array(regionCount + 1);
  for (var r = 0; r < regionCount; r++) offsets[r + 1] = offsets[r] + sizes[r];
  var pixels = new Int32Array(offsets[regionCount]);
  var cursors = new Int32Array(offsets);
  for (var i2 = 0; i2 < w * h; i2++) {
    var rid = label[i2];
    if (rid < 0) continue;
    pixels[cursors[rid]++] = i2;
  }
  return { pixels: pixels, offsets: offsets };
}

// ── Entry point ──────────────────────────────────────────────────────────────
function buildMask(msg) {
  var w = msg.width,
    h = msg.height;
  var data = new Uint8ClampedArray(msg.buffer);

  console.log('[MaskWorker] buildMask start', w, 'x', h,
    'pixels:', w * h, 'data bytes:', data.byteLength);

  var mag = sobelEdges(data, w, h);
  console.log('[MaskWorker] Sobel done');

  var wall = adaptiveEdgeMask(mag, w, h, 0.5);
  var wallCount = 0;
  for (var i = 0; i < wall.length; i++) if (wall[i]) wallCount++;
  console.log('[MaskWorker] Adaptive threshold done — wall pixels:', wallCount);

  wall = zhangSuen(wall, w, h);
  var skelCount = 0;
  for (var j = 0; j < wall.length; j++) if (wall[j]) skelCount++;
  console.log('[MaskWorker] Zhang-Suen done — skeleton pixels:', skelCount);

  var ccl = labelRegions(wall, w, h);
  console.log('[MaskWorker] CCL done — raw regions:', ccl.regionCount);

  var filtered = filterSmallRegions(ccl.label, ccl.regionCount, w, h, 300);
  console.log('[MaskWorker] Filter done — final regions:', filtered.regionCount);

  var rp = buildRegionPixels(filtered.label, filtered.regionCount, w, h);
  console.log('[MaskWorker] Pixel lists done');

  // Serialise label map (−1 sentinel → 0xFFFFFFFF)
  var labelMap = new Uint32Array(w * h);
  for (var k = 0; k < w * h; k++)
    labelMap[k] = filtered.label[k] < 0 ? 0xFFFFFFFF : filtered.label[k];

  console.log('[MaskWorker] posting ready');
  self.postMessage(
    {
      type: 'ready',
      labelMap: labelMap.buffer,
      pixelsBuf: rp.pixels.buffer,
      offsetsBuf: rp.offsets.buffer,
      regionCount: filtered.regionCount,
      width: w,
      height: h,
    },
    [labelMap.buffer, rp.pixels.buffer, rp.offsets.buffer]
  );
}