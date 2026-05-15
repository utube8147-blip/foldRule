"""
Stage 4 — Point Snapper & Deduplicator
Fixes floating-point drift so the graph in Stage 5 actually connects.

KEY FIX in this version
-----------------------
  T-JUNCTION SPLITTER (new pass 8):
    After collinear merge, partition-wall endpoints that lie ON an outer wall
    segment (but aren't a node there) cause the DCEL to skip that branch and
    produce one giant face instead of individual rooms.
    The new split_at_t_junctions() pass scans every endpoint against every
    segment and splits any segment where an endpoint lies on its interior.
    This restores all T-nodes so the DCEL can route correctly around each room.

Previous fixes retained
-----------------------
  1. area_shape elements (circles, ellipses) excluded from wall graph.
  2. Closed small rectangles excluded (column symbols, legend swatches).
  3. Outer document-border rectangle excluded.
  4. STRUCTURAL_ONLY=True (only Stage-1 structural elements enter graph).
  5. MIN_WALL_LENGTH=5.0 (stubs from T-junctions dropped).
  6. Gap-aware collinear merge.
"""

from __future__ import annotations
import math
import copy
from typing import Any
from collections import defaultdict

try:
    from scipy.spatial import KDTree
    HAS_SCIPY = True
except ImportError:
    HAS_SCIPY = False
    print("[Stage 4] WARNING: scipy not installed. Falling back to O(n²) snapping.")

SNAP_EPSILON   = 0.5
COLLINEAR_TOL  = 0.1
MIN_SEG_LENGTH = 0.01
MERGE_GAP_MAX  = SNAP_EPSILON * 3

STRUCTURAL_ONLY = True
MIN_WALL_LENGTH = 5.0

# ── Element-level pre-filters ─────────────────────────────────────────────────

SMALL_CLOSED_SHAPE_MAX_AREA = 100.0
BORDER_COVERAGE_THRESHOLD   = 0.80
EXCLUDE_AREA_SHAPES         = True


# ─────────────────────────────────────────────────────────────────────────────
# Union-Find
# ─────────────────────────────────────────────────────────────────────────────

class UnionFind:
    def __init__(self, n: int):
        self.parent = list(range(n))
        self.rank   = [0] * n

    def find(self, x: int) -> int:
        while self.parent[x] != x:
            self.parent[x] = self.parent[self.parent[x]]
            x = self.parent[x]
        return x

    def union(self, x: int, y: int) -> None:
        rx, ry = self.find(x), self.find(y)
        if rx == ry:
            return
        if self.rank[rx] < self.rank[ry]:
            rx, ry = ry, rx
        self.parent[ry] = rx
        if self.rank[rx] == self.rank[ry]:
            self.rank[rx] += 1


# ─────────────────────────────────────────────────────────────────────────────
# Geometry helpers
# ─────────────────────────────────────────────────────────────────────────────

def _shoelace_area(segments: list[dict]) -> float:
    pts = [seg["start"] for seg in segments]
    n = len(pts)
    if n < 3:
        return 0.0
    area = 0.0
    for i in range(n):
        j = (i + 1) % n
        area += pts[i][0] * pts[j][1]
        area -= pts[j][0] * pts[i][1]
    return abs(area) / 2.0


def _seg_bbox(segments: list[dict]) -> dict:
    xs = [c for seg in segments for c in (seg["start"][0], seg["end"][0])]
    ys = [c for seg in segments for c in (seg["start"][1], seg["end"][1])]
    return {
        "min_x": min(xs), "max_x": max(xs),
        "min_y": min(ys), "max_y": max(ys),
        "width":  max(xs) - min(xs),
        "height": max(ys) - min(ys),
    }


def _all_segs_bbox(elements: list[dict]) -> dict:
    xs, ys = [], []
    for el in elements:
        for seg in el["segments"]:
            xs += [seg["start"][0], seg["end"][0]]
            ys += [seg["start"][1], seg["end"][1]]
    if not xs:
        return {"width": 0, "height": 0}
    return {
        "min_x": min(xs), "max_x": max(xs),
        "min_y": min(ys), "max_y": max(ys),
        "width":  max(xs) - min(xs),
        "height": max(ys) - min(ys),
    }


# ─────────────────────────────────────────────────────────────────────────────
# Element-level pre-filters
# ─────────────────────────────────────────────────────────────────────────────

def _should_exclude_element(el: dict, drawing_bbox: dict) -> tuple[bool, str]:
    if EXCLUDE_AREA_SHAPES and el.get("area_shape", False):
        return True, "area_shape (circle/ellipse)"

    segs = el.get("segments", [])
    if not segs:
        return False, ""

    is_closed = el.get("is_closed", False)

    if is_closed:
        area = _shoelace_area(segs)
        if 0 < area < SMALL_CLOSED_SHAPE_MAX_AREA:
            return True, f"small closed shape (area={area:.1f} < {SMALL_CLOSED_SHAPE_MAX_AREA})"

    if is_closed and drawing_bbox["width"] > 0 and drawing_bbox["height"] > 0:
        bb = _seg_bbox(segs)
        w_ratio = bb["width"]  / drawing_bbox["width"]
        h_ratio = bb["height"] / drawing_bbox["height"]
        if w_ratio >= BORDER_COVERAGE_THRESHOLD and h_ratio >= BORDER_COVERAGE_THRESHOLD:
            return True, (
                f"document border (covers {w_ratio:.0%}×{h_ratio:.0%} of drawing)"
            )

    return False, ""


def _is_structural(el: dict) -> bool:
    if not STRUCTURAL_ONLY:
        return True
    if "is_structural" in el:
        cls = el.get("element_class", "unknown")
        if cls in ("dimension", "hatch", "non_structural"):
            return False
        return bool(el["is_structural"])
    cls = el.get("element_class", "unknown")
    if cls == "structural":
        return True
    if cls in ("dimension", "hatch", "non_structural", "furniture"):
        return False
    sw = el.get("stroke_width_px", None)
    if sw is not None:
        from stage1_parser import WALL_SW_MIN
        return float(sw) >= WALL_SW_MIN
    return True


def split_structural(elements: list[dict]) -> tuple[list[dict], list[dict]]:
    structural     = [e for e in elements if _is_structural(e)]
    non_structural = [e for e in elements if not _is_structural(e)]
    print(f"[Stage 4] Structural: {len(structural)}  "
          f"Non-structural: {len(non_structural)}")
    return structural, non_structural


def filter_wall_elements(elements: list[dict]) -> list[dict]:
    drawing_bbox = _all_segs_bbox(elements)
    print(f"[Stage 4] Drawing extent: "
          f"{drawing_bbox['width']:.1f} × {drawing_bbox['height']:.1f} units")

    kept:    list[dict] = []
    dropped: list[str]  = []

    for el in elements:
        exclude, reason = _should_exclude_element(el, drawing_bbox)
        if exclude:
            dropped.append(
                f"  ✗ id={el.get('id','?')!r:20s} tag={el.get('tag','?'):10s} → {reason}"
            )
        else:
            kept.append(el)

    if dropped:
        print(f"[Stage 4] Pre-filtered {len(dropped)} non-wall structural elements:")
        for msg in dropped[:20]:
            print(msg)
        if len(dropped) > 20:
            print(f"  ... and {len(dropped)-20} more")

    print(f"[Stage 4] Wall elements after pre-filter: {len(kept)}")
    return kept


# ─────────────────────────────────────────────────────────────────────────────
# Step 1+2 — collect & snap points
# ─────────────────────────────────────────────────────────────────────────────

def _collect_all_points(elements: list[dict]) -> list[tuple[float, float]]:
    pts = []
    for el in elements:
        for seg in el["segments"]:
            pts.append(seg["start"])
            pts.append(seg["end"])
    return pts


def _snap_points_kdtree(points: list[tuple], eps: float) -> list[tuple]:
    import numpy as np
    arr  = np.array(points, dtype=float)
    tree = KDTree(arr)
    pairs = tree.query_pairs(eps)
    uf = UnionFind(len(points))
    for i, j in pairs:
        uf.union(i, j)
    clusters: dict[int, list[int]] = defaultdict(list)
    for i in range(len(points)):
        clusters[uf.find(i)].append(i)
    canonical: list[tuple] = [(0.0, 0.0)] * len(points)
    for _, members in clusters.items():
        cx = sum(points[m][0] for m in members) / len(members)
        cy = sum(points[m][1] for m in members) / len(members)
        for m in members:
            canonical[m] = (cx, cy)
    return canonical


def _snap_points_naive(points: list[tuple], eps: float) -> list[tuple]:
    canonical = list(points)
    n = len(points)
    uf = UnionFind(n)
    for i in range(n):
        for j in range(i + 1, n):
            if math.dist(points[i], points[j]) <= eps:
                uf.union(i, j)
    clusters: dict[int, list[int]] = defaultdict(list)
    for i in range(n):
        clusters[uf.find(i)].append(i)
    for _, members in clusters.items():
        cx = sum(points[m][0] for m in members) / len(members)
        cy = sum(points[m][1] for m in members) / len(members)
        for m in members:
            canonical[m] = (cx, cy)
    return canonical


def snap_points(points: list[tuple], eps: float = SNAP_EPSILON) -> list[tuple]:
    if HAS_SCIPY and points:
        return _snap_points_kdtree(points, eps)
    return _snap_points_naive(points, eps)


# ─────────────────────────────────────────────────────────────────────────────
# Step 3 — remap segment endpoints
# ─────────────────────────────────────────────────────────────────────────────

def _remap_segments(elements: list[dict], canonical: list[tuple]) -> list[dict]:
    result = copy.deepcopy(elements)
    idx = 0
    for el in result:
        new_segs = []
        for seg in el["segments"]:
            s = canonical[idx]
            e = canonical[idx + 1]
            idx += 2
            if math.dist(s, e) < MIN_SEG_LENGTH:
                continue
            new_segs.append({"start": s, "end": e})
        el["segments"] = new_segs
    return result


# ─────────────────────────────────────────────────────────────────────────────
# Step 4 — deduplicate
# ─────────────────────────────────────────────────────────────────────────────

def _dedup_segments(elements: list[dict]) -> list[dict]:
    seen: set[frozenset] = set()
    result = copy.deepcopy(elements)
    for el in result:
        unique = []
        for seg in el["segments"]:
            key = frozenset([seg["start"], seg["end"]])
            if key not in seen:
                seen.add(key)
                unique.append(seg)
        el["segments"] = unique
    return result


# ─────────────────────────────────────────────────────────────────────────────
# Step 5 — merge collinear overlapping segments (gap-aware)
# ─────────────────────────────────────────────────────────────────────────────

def _seg_line_key(seg: dict) -> tuple:
    sx, sy = seg["start"]
    ex, ey = seg["end"]
    angle = math.atan2(ey - sy, ex - sx) % math.pi
    angle_bucket = round(angle / COLLINEAR_TOL) * COLLINEAR_TOL
    cos_a, sin_a = math.cos(angle_bucket), math.sin(angle_bucket)
    nx, ny = -sin_a, cos_a
    perp = sx * nx + sy * ny
    return (round(angle_bucket, 6), round(perp / COLLINEAR_TOL) * COLLINEAR_TOL)


def _project(pt: tuple, cos_a: float, sin_a: float) -> float:
    return pt[0] * cos_a + pt[1] * sin_a


def _backproject(t: float, perp: float, cos_a: float, sin_a: float) -> tuple:
    nx, ny = -sin_a, cos_a
    return (t * cos_a + perp * nx, t * sin_a + perp * ny)


def _merge_collinear(segments: list[dict]) -> list[dict]:
    groups: dict[tuple, list[dict]] = defaultdict(list)
    for seg in segments:
        groups[_seg_line_key(seg)].append(seg)

    merged: list[dict] = []
    for key, segs in groups.items():
        if len(segs) == 1:
            if math.dist(segs[0]["start"], segs[0]["end"]) >= MIN_WALL_LENGTH:
                merged.extend(segs)
            continue

        angle = key[0]
        cos_a, sin_a = math.cos(angle), math.sin(angle)
        nx, ny = -sin_a, cos_a
        perp = sum(
            seg["start"][0] * nx + seg["start"][1] * ny for seg in segs
        ) / len(segs)

        intervals = sorted(
            (min(_project(seg["start"], cos_a, sin_a),
                 _project(seg["end"],   cos_a, sin_a)),
             max(_project(seg["start"], cos_a, sin_a),
                 _project(seg["end"],   cos_a, sin_a)))
            for seg in segs
        )

        merged_intervals = [intervals[0]]
        for lo, hi in intervals[1:]:
            prev_lo, prev_hi = merged_intervals[-1]
            if lo - prev_hi <= MERGE_GAP_MAX:
                merged_intervals[-1] = (prev_lo, max(prev_hi, hi))
            else:
                merged_intervals.append((lo, hi))

        for lo, hi in merged_intervals:
            p1 = _backproject(lo, perp, cos_a, sin_a)
            p2 = _backproject(hi, perp, cos_a, sin_a)
            if math.dist(p1, p2) >= MIN_WALL_LENGTH:
                merged.append({"start": p1, "end": p2})

    return merged


def merge_collinear_global(elements: list[dict]) -> list[dict]:
    all_segs: list[dict] = []
    for el in elements:
        for seg in el["segments"]:
            all_segs.append(dict(seg))

    merged_segs = _merge_collinear(all_segs)

    return [{
        "id":              "merged_geometry",
        "tag":             "merged",
        "layer_path":      [],
        "stroke":          "",
        "stroke_width":    "1",
        "stroke_width_px": 1.0,
        "fill":            "none",
        "opacity":         "1",
        "is_closed":       False,
        "is_curve":        False,
        "area_shape":      False,
        "is_structural":   True,
        "element_class":   "structural",
        "baked_matrix":    [1, 0, 0, 1, 0, 0],
        "segments":        merged_segs,
    }]


# ─────────────────────────────────────────────────────────────────────────────
# Step 6 — T-junction splitter  ← THE KEY FIX
#
# After collinear merge, some segment endpoints (ends of partition walls) lie
# ON another segment (the outer wall) without being a node there.
# Example: outer wall runs A→B; partition wall ends at point P mid-way along
# A→B. After merge A→B is one segment with no node at P, so the DCEL cannot
# branch at P → the room faces spanning both sides of P get merged into one
# giant face.
#
# This pass:
#   1. Collects every unique endpoint in the segment set.
#   2. For each segment, checks whether any endpoint lies strictly on its
#      interior (not within eps of either endpoint).
#   3. If so, splits the segment at that point.
# Result: every T-intersection becomes a real node, enabling correct DCEL
# face traversal and individual room detection.
# ─────────────────────────────────────────────────────────────────────────────

def split_at_t_junctions(
    segments: list[dict],
    eps: float = SNAP_EPSILON,
) -> list[dict]:
    """
    Split any segment whose interior contains another segment's endpoint.

    Parameters
    ----------
    segments : flat list of {start, end} dicts (output of merge_collinear_global)
    eps      : tolerance for "point lies on segment" test (same as SNAP_EPSILON)

    Returns
    -------
    New list of segments with T-junction splits applied.
    Every T-intersection is now represented by a proper shared node.
    """

    def point_on_segment_interior(
        p: tuple, a: tuple, b: tuple, tol: float
    ) -> tuple[bool, float]:
        """
        Return (True, t) if point p lies on the interior of segment a→b
        within perpendicular distance tol, where t ∈ (0,1) is the
        parametric position along the segment.
        Returns (False, 0) if p is at/near an endpoint or off the segment.
        """
        dx = b[0] - a[0]
        dy = b[1] - a[1]
        seg_len_sq = dx * dx + dy * dy
        if seg_len_sq < 1e-12:
            return False, 0.0

        # Parametric projection
        t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / seg_len_sq

        # Must be strictly interior — not within eps of either endpoint
        endpoint_margin = tol / math.sqrt(seg_len_sq)
        if t <= endpoint_margin or t >= 1.0 - endpoint_margin:
            return False, 0.0

        # Perpendicular distance from p to the infinite line a→b
        foot_x = a[0] + t * dx
        foot_y = a[1] + t * dy
        perp_dist = math.dist(p, (foot_x, foot_y))

        if perp_dist <= tol:
            return True, t
        return False, 0.0

    # ── Collect all unique endpoints ──────────────────────────────────────────
    # Use a rounded-tuple set for fast lookup (same precision as snap stage)
    ROUND = 4
    endpoint_set: set[tuple] = set()
    for seg in segments:
        endpoint_set.add(
            (round(seg["start"][0], ROUND), round(seg["start"][1], ROUND))
        )
        endpoint_set.add(
            (round(seg["end"][0], ROUND), round(seg["end"][1], ROUND))
        )

    endpoints = list(endpoint_set)
    print(f"[Stage 4] T-junction check: {len(segments)} segments, "
          f"{len(endpoints)} unique endpoints")

    # ── For each segment, collect split points ────────────────────────────────
    result: list[dict] = []
    split_count = 0

    for seg in segments:
        a = seg["start"]
        b = seg["end"]

        # Gather all t-values where an endpoint lies on this segment's interior
        split_ts: list[float] = []
        for p in endpoints:
            on_interior, t = point_on_segment_interior(p, a, b, eps)
            if on_interior:
                split_ts.append(t)

        if not split_ts:
            result.append(seg)
            continue

        # Sort split points and generate sub-segments
        split_ts.sort()
        split_count += len(split_ts)

        prev_pt = a
        dx = b[0] - a[0]
        dy = b[1] - a[1]

        for t in split_ts:
            split_pt = (a[0] + t * dx, a[1] + t * dy)
            if math.dist(prev_pt, split_pt) >= MIN_WALL_LENGTH:
                result.append({"start": prev_pt, "end": split_pt})
            prev_pt = split_pt

        # Final sub-segment from last split to b
        if math.dist(prev_pt, b) >= MIN_WALL_LENGTH:
            result.append({"start": prev_pt, "end": b})

    print(f"[Stage 4] T-junction split: {len(segments)} → {len(result)} segments "
          f"({split_count} splits applied)")
    return result


# ─────────────────────────────────────────────────────────────────────────────
# Public API
# ─────────────────────────────────────────────────────────────────────────────

def snap_and_clean(
    elements: list[dict[str, Any]],
    eps: float = SNAP_EPSILON,
    merge_collinear: bool = True,
) -> list[dict[str, Any]]:
    """
    Full Stage 4 pipeline.

    Pass order
    ----------
    1. Split structural / non-structural (Stage 1 classification)
    2. Pre-filter: remove circles, small closed shapes, document border
    3. Snap nearby endpoints to canonical coordinates (KD-tree)
    4. Remap all segment endpoints to canonical points
    5. Deduplicate exact-duplicate segments
    6. Merge collinear overlapping/touching segments (gap-aware)
    7. Drop merged segments shorter than MIN_WALL_LENGTH
    8. NEW: Split segments at T-junctions so every partition-wall endpoint
            becomes a real graph node — required for correct DCEL room detection
    """
    # 1. Structural filter
    structural, _ = split_structural(elements)

    if not structural:
        print("[Stage 4] WARNING: No structural elements — falling back to ALL")
        structural = elements

    # 2. Pre-filter: circles, small closed shapes, document border
    wall_elements = filter_wall_elements(structural)

    if not wall_elements:
        print("[Stage 4] WARNING: No wall elements after pre-filter!")
        wall_elements = structural

    # 3. Collect & snap
    all_pts = _collect_all_points(wall_elements)
    print(f"[Stage 4] Wall endpoints before snap: {len(all_pts)}")

    if not all_pts:
        return []

    canonical = snap_points(all_pts, eps)
    print(f"[Stage 4] Unique canonical points: {len(set(canonical))}")

    # 4. Remap
    remapped = _remap_segments(wall_elements, canonical)

    # 5. Dedup
    before_dedup = sum(len(e["segments"]) for e in remapped)
    deduped = _dedup_segments(remapped)
    after_dedup = sum(len(e["segments"]) for e in deduped)
    print(f"[Stage 4] Dedup: {before_dedup} → {after_dedup} segments")

    if not merge_collinear:
        return deduped

    # 6+7. Collinear merge + length filter
    before_merge = after_dedup
    merged = merge_collinear_global(deduped)
    after_merge = sum(len(e["segments"]) for e in merged)
    print(f"[Stage 4] Collinear merge: {before_merge} → {after_merge} segments")

    # 8. T-junction splitter — THE KEY FIX FOR ROOM DETECTION
    #    Without this, partition-wall endpoints that land on the interior of
    #    outer-wall segments are invisible to the DCEL, causing it to trace
    #    one giant face instead of individual rooms.
    raw_segs = merged[0]["segments"]
    split_segs = split_at_t_junctions(raw_segs, eps=eps)

    # Re-snap the new split points so they share exact coordinates with the
    # endpoints that created them (floating-point drift from the split math)
    all_split_pts = []
    for seg in split_segs:
        all_split_pts.append(seg["start"])
        all_split_pts.append(seg["end"])

    if all_split_pts:
        canonical_split = snap_points(all_split_pts, eps)
        final_segs = []
        for i, seg in enumerate(split_segs):
            s = canonical_split[i * 2]
            e = canonical_split[i * 2 + 1]
            if math.dist(s, e) >= MIN_WALL_LENGTH:
                final_segs.append({"start": s, "end": e})
    else:
        final_segs = split_segs

    # Remove any duplicates introduced by the split+snap pass
    seen: set[frozenset] = set()
    deduped_final = []
    for seg in final_segs:
        key = frozenset([seg["start"], seg["end"]])
        if key not in seen:
            seen.add(key)
            deduped_final.append(seg)

    print(f"[Stage 4] Final segments after T-split + re-snap + dedup: "
          f"{len(deduped_final)}")

    merged[0]["segments"] = deduped_final
    return merged


# ─────────────────────────────────────────────────────────────────────────────
# CLI
# ─────────────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import sys
    from stage1_parser import parse_svg
    from stage2_flattener import flatten_transforms
    from stage3_normalizer import normalize_geometry

    path = sys.argv[1] if len(sys.argv) > 1 else "input.svg"
    _, elements = parse_svg(path)
    flat    = flatten_transforms(elements)
    normed  = normalize_geometry(flat)
    cleaned = snap_and_clean(normed)

    total_segs = sum(len(e["segments"]) for e in cleaned)
    print(f"\n[Stage 4] Final: {len(cleaned)} elements, {total_segs} segments")
    for seg in cleaned[0]["segments"][:5]:
        print(f"  {seg['start']} → {seg['end']}")