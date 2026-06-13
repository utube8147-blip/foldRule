"""
Construction Plan Image Search Pipeline
========================================
Finds all occurrences of a reference image inside a PDF (construction plans).

Handles:
  - Scale changes
  - Rotation (any angle)
  - Flips (horizontal / vertical)

Matcher: SIFT + FLANN + RANSAC  (pure OpenCV, no model downloads)

Dependencies:
    pip install pymupdf opencv-python numpy
"""

import cv2
import fitz                      # PyMuPDF
import numpy as np
from pathlib import Path
from dataclasses import dataclass, field
from typing import Optional
import argparse
import json
import sys


# ─────────────────────────────────────────────
# Configuration
# ─────────────────────────────────────────────

@dataclass
class Config:
    dpi: int = 300
    ransac_reproj_threshold: float = 4.0
    min_inliers: int = 12
    lowe_ratio: float = 0.75          # Lowe's ratio test threshold


CFG = Config()


# ─────────────────────────────────────────────
# Result dataclass
# ─────────────────────────────────────────────

@dataclass
class MatchResult:
    page_number: int
    confidence: float
    inlier_count: int
    bounding_box: list
    homography: list
    rotation_deg: float
    scale: float
    flipped_h: bool
    flipped_v: bool


# ─────────────────────────────────────────────
# PDF utilities
# ─────────────────────────────────────────────

def pdf_to_images(pdf_path: str, dpi: int = 300) -> list:
    doc = fitz.open(pdf_path)
    pages = []
    mat = fitz.Matrix(dpi / 72, dpi / 72)
    for page in doc:
        pix = page.get_pixmap(matrix=mat, colorspace=fitz.csRGB)
        img = np.frombuffer(pix.samples, dtype=np.uint8).reshape(
            pix.height, pix.width, 3)
        pages.append(cv2.cvtColor(img, cv2.COLOR_RGB2BGR))
    doc.close()
    print(f"[PDF] Loaded {len(pages)} pages at {dpi} DPI")
    return pages


# ─────────────────────────────────────────────
# Preprocessing
# ─────────────────────────────────────────────

def preprocess(img_bgr: np.ndarray) -> np.ndarray:
    """Grayscale → CLAHE → Gaussian denoise. Returns uint8 grayscale."""
    gray = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2GRAY)
    clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
    enhanced = clahe.apply(gray)
    return cv2.GaussianBlur(enhanced, (3, 3), 0)


# ─────────────────────────────────────────────
# SIFT + FLANN matching
# ─────────────────────────────────────────────

_sift = None

def get_sift():
    global _sift
    if _sift is None:
        _sift = cv2.SIFT_create(nfeatures=0, contrastThreshold=0.03)
    return _sift


def sift_match(img0_gray: np.ndarray, img1_gray: np.ndarray) -> tuple:
    """
    Detect SIFT keypoints, match with FLANN, apply Lowe's ratio test.
    Returns (pts0, pts1) as float32 arrays of matched point coordinates.
    """
    sift = get_sift()

    kp0, des0 = sift.detectAndCompute(img0_gray, None)
    kp1, des1 = sift.detectAndCompute(img1_gray, None)

    if des0 is None or des1 is None or len(kp0) < 4 or len(kp1) < 4:
        return np.array([]), np.array([])

    # FLANN parameters for SIFT (float descriptors)
    index_params  = dict(algorithm=1, trees=5)   # FLANN_INDEX_KDTREE = 1
    search_params = dict(checks=50)
    flann = cv2.FlannBasedMatcher(index_params, search_params)

    raw_matches = flann.knnMatch(des0, des1, k=2)

    # Lowe's ratio test
    good = []
    for pair in raw_matches:
        if len(pair) == 2:
            m, n = pair
            if m.distance < CFG.lowe_ratio * n.distance:
                good.append(m)

    if len(good) < 4:
        return np.array([]), np.array([])

    pts0 = np.float32([kp0[m.queryIdx].pt for m in good])
    pts1 = np.float32([kp1[m.trainIdx].pt for m in good])
    return pts0, pts1


# ─────────────────────────────────────────────
# Homography & transform decomposition
# ─────────────────────────────────────────────

def decompose_homography(H: np.ndarray) -> dict:
    A = H[:2, :2] / H[2, 2]
    sx = float(np.linalg.norm(A[:, 0]))
    sy = float(np.linalg.norm(A[:, 1]))
    scale = (sx + sy) / 2.0
    det = float(np.linalg.det(A))
    flipped_h = det < 0
    angle_rad = float(np.arctan2(A[1, 0], A[0, 0]))
    rotation_deg = float(np.degrees(angle_rad)) % 360
    return {
        "rotation_deg": round(rotation_deg, 1),
        "scale": round(scale, 3),
        "flipped_h": flipped_h,
        "flipped_v": False,
    }


def compute_homography(src_pts: np.ndarray, dst_pts: np.ndarray) -> tuple:
    if len(src_pts) < 4:
        return None, np.array([])
    H, mask = cv2.findHomography(
        src_pts, dst_pts,
        cv2.RANSAC,
        CFG.ransac_reproj_threshold,
        confidence=0.995,
        maxIters=2000,
    )
    return H, mask


def project_bbox(ref_shape: tuple, H: np.ndarray) -> list:
    h, w = ref_shape[:2]
    corners = np.float32([[0, 0], [w, 0], [w, h], [0, h]]).reshape(-1, 1, 2)
    projected = cv2.perspectiveTransform(corners, H).reshape(-1, 2)
    x, y = projected.min(axis=0)
    xmax, ymax = projected.max(axis=0)
    return [int(x), int(y), int(xmax - x), int(ymax - y)]


# ─────────────────────────────────────────────
# Flip variants
# ─────────────────────────────────────────────

def reference_variants(ref_bgr: np.ndarray) -> list:
    return [
        (ref_bgr,               "original"),
        (cv2.flip(ref_bgr, 1),  "flip_h"),
        (cv2.flip(ref_bgr, 0),  "flip_v"),
        (cv2.flip(ref_bgr, -1), "flip_hv"),
    ]


# ─────────────────────────────────────────────
# Main search
# ─────────────────────────────────────────────

def search(pdf_path: str,
           ref_image_path: str,
           output_json: Optional[str] = None) -> list:

    pages_bgr = pdf_to_images(pdf_path, dpi=CFG.dpi)

    ref_bgr = cv2.imread(ref_image_path)
    if ref_bgr is None:
        raise FileNotFoundError(f"Cannot read reference image: {ref_image_path}")

    ref_gray = preprocess(ref_bgr)

    results = []

    for page_idx, page_bgr in enumerate(pages_bgr):
        page_num = page_idx + 1
        print(f"\n[Page {page_num}/{len(pages_bgr)}] Processing …")

        page_gray = preprocess(page_bgr)
        best: Optional[MatchResult] = None

        for variant_img, variant_name in reference_variants(ref_bgr):
            variant_gray = preprocess(variant_img)

            pts_ref, pts_page = sift_match(variant_gray, page_gray)
            n = len(pts_ref)
            print(f"  [{variant_name}] SIFT matches after ratio test: {n}")

            if n < CFG.min_inliers:
                continue

            H, inlier_mask = compute_homography(pts_ref, pts_page)
            if H is None:
                continue

            inlier_count = int(inlier_mask.sum())
            inlier_ratio = inlier_count / max(n, 1)
            print(f"  [{variant_name}] RANSAC inliers: {inlier_count}  "
                  f"ratio: {inlier_ratio:.2f}")

            if inlier_count < CFG.min_inliers:
                continue

            if best is None or inlier_ratio > best.confidence:
                decomp = decompose_homography(H)
                bbox   = project_bbox(variant_img.shape, H)
                flip_h = (variant_name in ("flip_h", "flip_hv")) ^ decomp["flipped_h"]
                flip_v = (variant_name in ("flip_v", "flip_hv")) ^ decomp["flipped_v"]

                best = MatchResult(
                    page_number  = page_num,
                    confidence   = round(inlier_ratio, 4),
                    inlier_count = inlier_count,
                    bounding_box = bbox,
                    homography   = H.tolist(),
                    rotation_deg = decomp["rotation_deg"],
                    scale        = decomp["scale"],
                    flipped_h    = flip_h,
                    flipped_v    = flip_v,
                )

        if best:
            print(f"  ✓ MATCH  conf={best.confidence}  "
                  f"rot={best.rotation_deg}°  scale={best.scale}  "
                  f"flip_h={best.flipped_h}  flip_v={best.flipped_v}")
            results.append(best)
        else:
            print(f"  ✗ No match on page {page_num}")

    results.sort(key=lambda r: r.confidence, reverse=True)

    if output_json:
        import dataclasses
        Path(output_json).write_text(
            json.dumps([dataclasses.asdict(r) for r in results], indent=2)
        )
        print(f"\n[Output] Saved → {output_json}")

    return results


# ─────────────────────────────────────────────
# Visualisation
# ─────────────────────────────────────────────

def draw_results(pdf_path: str, results: list, out_dir: str = "matches") -> None:
    pages = pdf_to_images(pdf_path, dpi=CFG.dpi)
    Path(out_dir).mkdir(parents=True, exist_ok=True)

    for r in results:
        img = pages[r.page_number - 1].copy()
        x, y, w, h = r.bounding_box
        cv2.rectangle(img, (x, y), (x + w, y + h), (0, 0, 255), 6)
        label = (f"p{r.page_number}  rot={r.rotation_deg}  "
                 f"scale={r.scale}  conf={r.confidence}")
        cv2.putText(img, label, (max(x, 10), max(y - 10, 30)),
                    cv2.FONT_HERSHEY_SIMPLEX, 1.2, (0, 0, 255), 3)
        out_path = Path(out_dir) / f"match_page_{r.page_number:03d}.jpg"
        cv2.imwrite(str(out_path), img)
        print(f"[Viz] Saved {out_path}")


# ─────────────────────────────────────────────
# CLI
# ─────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="Find a reference image inside a construction-plan PDF."
    )
    parser.add_argument("pdf",               help="Path to PDF file")
    parser.add_argument("reference",         help="Path to reference image")
    parser.add_argument("--output",          default="results.json")
    parser.add_argument("--viz-dir",         default="matches")
    parser.add_argument("--dpi",             type=int,   default=300)
    parser.add_argument("--min-inliers",     type=int,   default=12)
    parser.add_argument("--lowe-ratio",      type=float, default=0.75)
    parser.add_argument("--ransac-threshold",type=float, default=4.0)
    args = parser.parse_args()

    CFG.dpi                    = args.dpi
    CFG.min_inliers            = args.min_inliers
    CFG.lowe_ratio             = args.lowe_ratio
    CFG.ransac_reproj_threshold = args.ransac_threshold

    results = search(
        pdf_path       = args.pdf,
        ref_image_path = args.reference,
        output_json    = args.output,
    )

    print(f"\n{'─'*50}")
    print(f"Found {len(results)} match(es):")
    for r in results:
        print(f"  Page {r.page_number:3d}  conf={r.confidence:.3f}  "
              f"rot={r.rotation_deg:6.1f}°  scale={r.scale:.3f}  "
              f"flip_h={r.flipped_h}  flip_v={r.flipped_v}")

    if results:
        draw_results(args.pdf, results, out_dir=args.viz_dir)

    return 0 if results else 1


if __name__ == "__main__":
    sys.exit(main())