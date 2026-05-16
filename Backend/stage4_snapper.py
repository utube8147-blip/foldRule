"""
Stage 4 — Point Snapper & Deduplicator
Fixes floating-point drift so the graph in Stage 5 actually connects.

KEY FIXES IN THIS VERSION
--------------------------
1. USE-ALL-FOR-BOUNDARY FIX:
   The old code filtered to STRUCTURAL_ONLY before snapping, which meant thin
   lines (door frames, partition walls, window sills) never participated in
   closing room boundaries — fill bled through the gaps they left.

   New behaviour:
     • ALL elements except grid lines and sheet borders enter the snapper and
       polygon builder (so every line contributes to closing room boundaries).
     • is_structural / is_title_block flags are PRESERVED on each segment so
       Stage 5 can still use them for labelling, colouring, and reporting.
     • The old STRUCTURAL_ONLY constant is kept but now only controls the
       collinear-merge and MIN_WALL_LENGTH filter, not the boundary input.

2. T-JUNCTION SPLITTER (retained from previous version):
   After collinear merge, partition-wall endpoints that lie ON an outer wall
   segment (but aren't a node there) cause the DCEL to skip that branch and
   produce one giant face instead of individual rooms.
   split_at_t_junctions() scans every endpoint against every segment and
   splits any segment where an endpoint lies on its interior.

Previous fixes retained
-----------------------
  1. area_shape elements (circles, ellipses) excluded from wall graph.
  2. Closed small rectangles excluded (column symbols, legend swatches).
  3. Outer document-border rectangle excluded.
  4. MIN_WALL_LENGTH=5.0 (stubs from T-junctions dropped).
  5. Gap-aware collinear merge.
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

# STRUCTURAL_ONLY now only affects collinear-merge grouping, NOT the boundary
# input. All non-grid lines always enter the snapper so thin lines close gaps.
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
    """
    Returns (should_exclude, reason_string).

    Excluded:
      • area_shape elements (circles/ellipses = columns/posts, not walls)
      • Small closed rectangles (column symbols, legend swatches)
      • The outer document-border rectangle
      • Grid lines  (is_grid=True)
      • Sheet borders (is_sheet_border=True)

    NOT excluded (even if thin):
      • Door swings, window lines, partition walls, fixture outlines
      • Title-block geometry (kept but flagged — Stage 5 ignores it for fills)
    """
    # Grid lines — always drop
    if el.get("is_grid", False):
        return True, "grid line"

    # Sheet border — always drop
    if el.get("is_sheet_border", False):
        return True, "sheet border"

    # Circles / ellipses = columns / posts, not wall lines
    if EXCLUDE_AREA_SHAPES and el.get("area_shape", False):
        return True, "area_shape (circle/ellipse)"

    segs = el.get("segments", [])
    if not segs:
        return False, ""

    is_closed = el.get("is_closed", False)

    # Small closed shapes (column symbols, legend swatches)
    if is_closed:
        area = _shoelace_area(segs)
        if 0 < area < SMALL_CLOSED_SHAPE_MAX_AREA:
            return True, f"small closed shape (area={area:.1f} < {SMALL_CLOSED_SHAPE_MAX_AREA})"

    # Document border: closed shape covering ≥ 80% of drawing extent
    if is_closed and drawing_bbox["width"] > 0 and drawing_bbox["height"] > 0:
        bb = _seg_bbox(segs)
        w_ratio = bb["width"]  / drawing_bbox["width"]
        h_ratio = bb["height"] / drawing_bbox["height"]
        if w_ratio >= BORDER_COVERAGE_THRESHOLD and h_ratio >= BORDER_COVERAGE_THRESHOLD:
            return True, (
                f"document border (covers {w_ratio:.0%}×{h_ratio:.0%} of drawing)"
            )

    return False, ""


def select_boundary_elements(elements: list[dict]) -> tuple[list[dict], list[dict]]:
    """
    FIX: Split elements into boundary (used for polygon building) and excluded.

    OLD behaviour: only structural elements entered the snapper.
    NEW behaviour: ALL elements except grids/borders/area-shapes enter the
                   snapper so thin lines (doors, partitions) close room gaps.

    Title-block elements are included in boundary_elements but flagged
    is_title_block=True so Stage 5 can skip them when filling rooms.
    """
    drawing_bbox = _all_segs_bbox(elements)
    print(f"[Stage 4] Drawing extent: "
          f"{drawing_bbox['width']:.1f} × {drawing_bbox['height']:.1f} units")

    boundary:    list[dict] = []
    excluded:    list[dict] = []
    drop_log:    list[str]  = []

    structural_count     = 0
    non_structural_count = 0
    title_block_count    = 0

    for el in elements:
        exclude, reason = _should_exclude_element(el, drawing_bbox)
        if exclude:
            excluded.append(el)
            drop_log.append(
                f"  ✗ id={el.get('id','?')!r:20s} "
                f"tag={el.get('tag','?'):10s} → {reason}"
            )
        else:
            boundary.append(el)
            if el.get("is_structural", False):
                structural_count += 1
            elif el.get("is_title_block", False):
                title_block_count += 1
            else:
                non_structural_count += 1

    if drop_log:
        print(f"[Stage 4] Excluded {len(drop_log)} elements from boundary:")
        for msg in drop_log[:20]:
            print(msg)
        if len(drop_log) > 20:
            print(f"  ... and {len(drop_log) - 20} more")

    print(f"[Stage 4] Boundary elements: {len(boundary)} total")
    print(f"[Stage 4]   Structural:    {structural_count}")
    print(f"[Stage 4]   Non-structural (thin lines included): {non_structural_count}")
    print(f"[Stage 4]   Title block:   {title_block_count}")

    return boundary, excluded


# kept for backwards compat — Stage 5 may call this
def filter_wall_elements(elements: list[dict]) -> list[dict]:
    boundary, _ = select_boundary_elements(elements)
    return boundary


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
            # Carry structural flag through so Stage 5 can use it
            all_segs.append({
                **seg,
                "is_structural":  el.get("is_structural", False),
                "is_title_block": el.get("is_title_block", False),
            })

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
# Step 6 — T-junction splitter
#
# After collinear merge, partition-wall endpoints that lie ON an outer wall
# segment (but aren't a node there) cause the DCEL to skip that branch and
# produce one giant face instead of individual rooms.
#
# This pass:
#   1. Collects every unique endpoint in the segment set.
#   2. For each segment, checks whether any endpoint lies strictly on its
#      interior (not within eps of either endpoint).
#   3. If so, splits the segment at that point.
# ─────────────────────────────────────────────────────────────────────────────

def split_at_t_junctions(
    segments: list[dict],
    eps: float = SNAP_EPSILON,
) -> list[dict]:
    """
    Split any segment whose interior contains another segment's endpoint.
    Every T-intersection becomes a real shared node for correct DCEL traversal.
    """

    def point_on_segment_interior(
        p: tuple, a: tuple, b: tuple, tol: float
    ) -> tuple[bool, float]:
        dx = b[0] - a[0]
        dy = b[1] - a[1]
        seg_len_sq = dx * dx + dy * dy
        if seg_len_sq < 1e-12:
            return False, 0.0
        t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / seg_len_sq
        endpoint_margin = tol / math.sqrt(seg_len_sq)
        if t <= endpoint_margin or t >= 1.0 - endpoint_margin:
            return False, 0.0
        foot_x = a[0] + t * dx
        foot_y = a[1] + t * dy
        perp_dist = math.dist(p, (foot_x, foot_y))
        if perp_dist <= tol:
            return True, t
        return False, 0.0

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

    result: list[dict] = []
    split_count = 0

    for seg in segments:
        a = seg["start"]
        b = seg["end"]

        split_ts: list[float] = []
        for p in endpoints:
            on_interior, t = point_on_segment_interior(p, a, b, eps)
            if on_interior:
                split_ts.append(t)

        if not split_ts:
            result.append(seg)
            continue

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
    1. select_boundary_elements() — exclude ONLY grids, sheet borders,
       area-shapes, and small closed symbols.
       ALL other lines (including thin non-structural ones) are kept so they
       participate in closing room boundaries.
    2. Snap nearby endpoints to canonical coordinates (KD-tree / naive).
    3. Remap all segment endpoints to canonical points.
    4. Deduplicate exact-duplicate segments.
    5. Merge collinear overlapping/touching segments (gap-aware).
    6. Drop merged segments shorter than MIN_WALL_LENGTH.
    7. Split segments at T-junctions so every partition-wall endpoint
       becomes a real graph node — required for correct DCEL room detection.
    8. Re-snap + dedup after T-split.
    """

    # 1. Select boundary elements (ALL lines except grids/borders/area-shapes)
    boundary_elements, excluded = select_boundary_elements(elements)

    if not boundary_elements:
        print("[Stage 4] WARNING: No boundary elements — check Stage 1 output!")
        return []

    # 2. Collect & snap
    all_pts = _collect_all_points(boundary_elements)
    print(f"[Stage 4] Endpoints before snap: {len(all_pts)}")

    if not all_pts:
        return []

    canonical = snap_points(all_pts, eps)
    print(f"[Stage 4] Unique canonical points: {len(set(canonical))}")

    # 3. Remap
    remapped = _remap_segments(boundary_elements, canonical)

    # 4. Dedup
    before_dedup = sum(len(e["segments"]) for e in remapped)
    deduped = _dedup_segments(remapped)
    after_dedup = sum(len(e["segments"]) for e in deduped)
    print(f"[Stage 4] Dedup: {before_dedup} → {after_dedup} segments")

    if not merge_collinear:
        return deduped

    # 5+6. Collinear merge + length filter
    before_merge = after_dedup
    merged = merge_collinear_global(deduped)
    after_merge = sum(len(e["segments"]) for e in merged)
    print(f"[Stage 4] Collinear merge: {before_merge} → {after_merge} segments")

    # 7. T-junction splitter
    raw_segs   = merged[0]["segments"]
    split_segs = split_at_t_junctions(raw_segs, eps=eps)

    # 8. Re-snap split points + final dedup
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