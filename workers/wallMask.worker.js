// Magic Fill wall mask, built off the main thread.
// Plain JS on purpose: the build copies worker files as-is (it does not bundle
// TypeScript workers), so this is a faithful port of buildWallMask /
// dilateMask / erodeMask in hooks/fill/fillMaskAndSvgPath.ts.
// tests/wallMaskWorker.test.ts checks both give identical masks.
const WALL_LUMA = 120;
const STROKE_NEIGHBOR_MIN = 0.4;
const DILATE_R = 2;
const ERODE_R = 2;

function buildWallMask(data, w, h) {
  const dark = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    if (data[i * 4 + 3] < 20) continue;
    const luma = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
    if (luma < WALL_LUMA) dark[i] = 1;
  }
  const mask = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!dark[y * w + x]) continue;
      let n = 0;
      if (x > 0 && dark[y * w + x - 1]) n++;
      if (x < w - 1 && dark[y * w + x + 1]) n++;
      if (y > 0 && dark[(y - 1) * w + x]) n++;
      if (y < h - 1 && dark[(y + 1) * w + x]) n++;
      if (x > 0 && y > 0 && dark[(y - 1) * w + x - 1]) n++;
      if (x < w - 1 && y > 0 && dark[(y - 1) * w + x + 1]) n++;
      if (x > 0 && y < h - 1 && dark[(y + 1) * w + x - 1]) n++;
      if (x < w - 1 && y < h - 1 && dark[(y + 1) * w + x + 1]) n++;
      if (n >= STROKE_NEIGHBOR_MIN) mask[y * w + x] = 1;
    }
  }
  return mask;
}

function dilateMask(src, w, h, r) {
  const horiz = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    let count = 0;
    for (let x = 0; x < r && x < w; x++) if (src[y * w + x]) count++;
    for (let x = 0; x < w; x++) {
      const add = x + r; if (add < w && src[y * w + add]) count++;
      if (count > 0) horiz[y * w + x] = 1;
      const rem = x - r; if (rem >= 0 && src[y * w + rem]) count--;
    }
  }
  const out = new Uint8Array(w * h);
  for (let x = 0; x < w; x++) {
    let count = 0;
    for (let y = 0; y < r && y < h; y++) if (horiz[y * w + x]) count++;
    for (let y = 0; y < h; y++) {
      const add = y + r; if (add < h && horiz[add * w + x]) count++;
      if (count > 0) out[y * w + x] = 1;
      const rem = y - r; if (rem >= 0 && horiz[rem * w + x]) count--;
    }
  }
  return out;
}

function erodeMask(src, w, h, r) {
  const horiz = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    let zeros = 0;
    for (let x = 0; x < r && x < w; x++) if (!src[y * w + x]) zeros++;
    for (let x = 0; x < w; x++) {
      const add = x + r; if (add < w && !src[y * w + add]) zeros++;
      if (zeros === 0) horiz[y * w + x] = 1;
      const rem = x - r; if (rem >= 0 && !src[y * w + rem]) zeros--;
    }
  }
  const out = new Uint8Array(w * h);
  for (let x = 0; x < w; x++) {
    let zeros = 0;
    for (let y = 0; y < r && y < h; y++) if (!horiz[y * w + x]) zeros++;
    for (let y = 0; y < h; y++) {
      const add = y + r; if (add < h && !horiz[add * w + x]) zeros++;
      if (zeros === 0) out[y * w + x] = 1;
      const rem = y - r; if (rem >= 0 && !horiz[rem * w + x]) zeros--;
    }
  }
  return out;
}

self.onmessage = (e) => {
  const { id, data, w, h } = e.data;
  try {
    const mask = erodeMask(dilateMask(buildWallMask(data, w, h), w, h, DILATE_R), w, h, ERODE_R);
    self.postMessage({ id, mask }, [mask.buffer]);
  } catch (err) {
    self.postMessage({ id, error: String(err) });
  }
};
