/**
 * removeTextFromMat.ts
 * ─────────────────────
 * Removes small text-like blobs from a grayscale OpenCV Mat before
 * template matching, so symbols with different text labels inside them
 * still match the template correctly.
 *
 * Strategy:
 *  1. Threshold the grayscale mat to binary (dark strokes on white bg)
 *  2. Find connected components (blobs)
 *  3. Classify each blob as "text-like" based on:
 *       - Small bounding box (text chars are small)
 *       - High aspect-ratio variance (letters are taller than wide, unlike lines)
 *       - Not too elongated (rules out actual line segments)
 *  4. Paint those blobs WHITE (erase them) in the grayscale mat
 *  5. Return the cleaned mat for use in matchTemplate
 *
 * This runs on both the SOURCE mat and the TEMPLATE mat so both
 * are text-free before correlation.
 */

// ─── Blob classification thresholds ──────────────────────────────────────────

const TEXT_REMOVAL_CONFIG = {
  /** Max blob bounding-box area in pixels to be considered a text character.
   *  At 100dpi a typical char is ~8×12 px → area ~96. Use generous 600. */
  maxCharArea: 600,

  /** Min blob area — ignore single-pixel noise */
  minCharArea: 4,

  /** Max width of a text character in pixels */
  maxCharWidth: 40,

  /** Max height of a text character in pixels */
  maxCharHeight: 50,

  /** Aspect ratio range for text (h/w).
   *  Most capital letters: 0.8–3.0. Lines are >> 3 or << 0.3. */
  minAspect: 0.3,
  maxAspect: 4.0,

  /** Minimum pixel density (filled/bbox) to be a char vs a stray line */
  minDensity: 0.05,

  /** Binarisation threshold (0-255, pixels darker than this = foreground) */
  binaryThreshold: 200,
};

/**
 * Remove text-like blobs from a grayscale Mat IN PLACE.
 * The Mat is modified: text blob pixels are set to 255 (white).
 *
 * @param cv      - window.cv (OpenCV.js)
 * @param grayMat - grayscale Mat (CV_8UC1). Modified in place.
 */
export function removeTextFromMat(cv: any, grayMat: any): void {
  const cfg = TEXT_REMOVAL_CONFIG;

  // ── 1. Binarise: dark strokes → 255 (foreground), bg → 0 ─────────────────
  const binary = new cv.Mat();
  cv.threshold(grayMat, binary, cfg.binaryThreshold, 255, cv.THRESH_BINARY_INV);

  // ── 2. Connected components ───────────────────────────────────────────────
  const labels  = new cv.Mat();
  const stats   = new cv.Mat();   // CC_STAT_* columns
  const centroids = new cv.Mat();
  const numLabels = cv.connectedComponentsWithStats(binary, labels, stats, centroids);

  // stats layout: [left, top, width, height, area] per label (row)
  const s = stats.data32S;

  // ── 3 & 4. Classify and erase text blobs ─────────────────────────────────
  const labelsData = labels.data32S;
  const matCols    = grayMat.cols;
  const matRows    = grayMat.rows;

  // Build a set of label ids that are text-like
  const textLabels = new Set<number>();

  for (let lbl = 1; lbl < numLabels; lbl++) {   // skip label 0 = background
    const left   = s[lbl * 5 + 0]; // CC_STAT_LEFT
    const top    = s[lbl * 5 + 1]; // CC_STAT_TOP
    const width  = s[lbl * 5 + 2]; // CC_STAT_WIDTH
    const height = s[lbl * 5 + 3]; // CC_STAT_HEIGHT
    const area   = s[lbl * 5 + 4]; // CC_STAT_AREA

    if (area   < cfg.minCharArea)   continue;
    if (area   > cfg.maxCharArea)   continue;
    if (width  > cfg.maxCharWidth)  continue;
    if (height > cfg.maxCharHeight) continue;

    const aspect  = height / Math.max(width, 1);
    if (aspect < cfg.minAspect || aspect > cfg.maxAspect) continue;

    const bboxArea = width * height;
    const density  = area / Math.max(bboxArea, 1);
    if (density < cfg.minDensity) continue;

    textLabels.add(lbl);
  }

  // Erase text pixels: set them to 255 (white) in the grayscale mat
  if (textLabels.size > 0) {
    const grayData = grayMat.data;
    for (let i = 0; i < matRows * matCols; i++) {
      if (textLabels.has(labelsData[i])) {
        grayData[i] = 255;
      }
    }
  }

  // ── Cleanup ───────────────────────────────────────────────────────────────
  binary.delete();
  labels.delete();
  stats.delete();
  centroids.delete();
}

/**
 * Convenience: clone a Mat, remove text from the clone, return it.
 * Caller must .delete() the returned Mat.
 */
export function matWithoutText(cv: any, grayMat: any): any {
  const clone = grayMat.clone();
  removeTextFromMat(cv, clone);
  return clone;
}