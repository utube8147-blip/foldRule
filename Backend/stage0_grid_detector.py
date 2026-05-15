"""
Grid Detector — Detects structural grid lines (column/row lines) in floor plans
================================================================================

KEY INSIGHT from diagnostic data
---------------------------------
Floor plan SVGs contain many lines at nearly the same position — both faces of
a wall, door jambs, slab edges, etc.  Naively clustering ALL line positions
gives CV > 1.0 because the distribution is not regular at all.

Correct approach:
  1. Snap nearby parallel lines into ONE representative position (deduplicate).
  2. THEN look for regular spacing in the deduplicated positions.
  3. Mark every original line within SNAP_TOL of a confirmed grid position.

From the diagnostic:
  - Vertical grid spacing:  50 SVG units  (columns at 160,210,260,310,360...)
  - Horizontal wall clusters at 303, 453, 603, 753 — spacing ~150 units
  - Max gap between any two consecutive lines: 50 SVG units

Tunable constants are set conservatively so they work for any floor plan
whose grid spacing is ≥ 20 SVG units.
"""

from __future__ import annotations
import math
import re
from typing import Any


# ─────────────────────────────────────────────────────────────────────────────
# Tunable constants
# ─────────────────────────────────────────────────────────────────────────────

# Lines shorter than this are ignored entirely
MIN_LINE_LENGTH = 50.0

# Angle tolerance: how many degrees off-axis counts as H or V
ANGLE_TOL_DEG = 1.0

# Lines within this distance of each other are the SAME logical line (wall faces,
# duplicates).  Set to half the thinnest wall in your drawings.
SNAP_TOL = 8.0

# After deduplication, look for this many regularly-spaced positions to call it a grid
MIN_GRID_LINES = 3

# Max gap between consecutive deduplicated positions before splitting into
# separate clusters.  Set large — we split by regularity, not by gap size.
MAX_GAP = 99999.0

# A cluster is a grid if its coefficient of variation is below this threshold.
# 0.30 = spacing can vary by up to 30% and still be called regular.
REGULARITY_CV = 0.30

# Lines shorter than this fraction of the longest line in their orientation
# are excluded from grid detection (keeps dimension ticks and hatch lines out)
MIN_LENGTH_FRACTION = 0.15

VERBOSE = True


# ─────────────────────────────────────────────────────────────────────────────
# Segment extraction  (same as before)
# ─────────────────────────────────────────────────────────────────────────────

def _extract_segment(tag: str, coords: dict) -> tuple[tuple, tuple] | None:
    if tag == "line":
        return (coords["x1"], coords["y1"]), (coords["x2"], coords["y2"])

    if tag in ("polyline", "polygon"):
        pts = coords.get("points", [])
        if len(pts) == 2:
            return pts[0], pts[1]

    if tag == "rect":
        w = coords.get("width", 0)
        h = coords.get("height", 0)
        if w > 0 and h > 0 and min(w, h) / max(w, h) < 0.02:
            x, y = coords["x"], coords["y"]
            if w > h:
                return (x, y + h / 2), (x + w, y + h / 2)
            else:
                return (x + w / 2, y), (x + w / 2, y + h)

    if tag == "path":
        d = (coords.get("d") or "").strip()
        if not d:
            return None
        for pat, builder in [
            (r'^M\s*([\d.-]+)\s*,?\s*([\d.-]+)\s+V\s*([\d.-]+)',
             lambda m: ((float(m.group(1)), float(m.group(2))),
                        (float(m.group(1)), float(m.group(3))))),
            (r'^M\s*([\d.-]+)\s*,?\s*([\d.-]+)\s+H\s*([\d.-]+)',
             lambda m: ((float(m.group(1)), float(m.group(2))),
                        (float(m.group(3)), float(m.group(2))))),
            (r'^M\s*([\d.-]+)\s*,?\s*([\d.-]+)\s+L\s*([\d.-]+)\s*,?\s*([\d.-]+)',
             lambda m: ((float(m.group(1)), float(m.group(2))),
                        (float(m.group(3)), float(m.group(4))))),
            (r'^M\s*([\d.-]+)\s*,?\s*([\d.-]+)\s+([\d.-]+)\s*,?\s*([\d.-]+)',
             lambda m: ((float(m.group(1)), float(m.group(2))),
                        (float(m.group(3)), float(m.group(4))))),
        ]:
            m = re.match(pat, d, re.IGNORECASE)
            if m:
                return builder(m)
    return None


# ─────────────────────────────────────────────────────────────────────────────
# Orientation
# ─────────────────────────────────────────────────────────────────────────────

def _orientation(start: tuple, end: tuple) -> str | None:
    dx = end[0] - start[0]
    dy = end[1] - start[1]
    length = math.hypot(dx, dy)
    if length < MIN_LINE_LENGTH:
        return None
    angle_deg = abs(math.degrees(math.atan2(abs(dy), abs(dx))))
    if angle_deg <= ANGLE_TOL_DEG or angle_deg >= (180.0 - ANGLE_TOL_DEG):
        return "H"
    if abs(angle_deg - 90.0) <= ANGLE_TOL_DEG:
        return "V"
    return None


# ─────────────────────────────────────────────────────────────────────────────
# Step 1: Deduplicate nearby parallel lines → representative positions
# ─────────────────────────────────────────────────────────────────────────────

def _deduplicate(items: list[dict], snap_tol: float) -> list[dict]:
    """
    Merge lines within snap_tol of each other into one representative entry.
    The representative keeps:
      - coord  = mean of the group
      - length = max length in the group  (longest line wins)
      - indices = all original indices in the group
    """
    if not items:
        return []

    sorted_items = sorted(items, key=lambda x: x["coord"])
    groups: list[dict] = []
    current_group = [sorted_items[0]]

    for item in sorted_items[1:]:
        if item["coord"] - current_group[-1]["coord"] <= snap_tol:
            current_group.append(item)
        else:
            groups.append(current_group)
            current_group = [item]
    groups.append(current_group)

    representatives = []
    for group in groups:
        mean_coord  = sum(i["coord"]  for i in group) / len(group)
        max_length  = max(i["length"] for i in group)
        all_indices = [idx for i in group for idx in i["indices"]]
        representatives.append({
            "coord":   mean_coord,
            "length":  max_length,
            "indices": all_indices,
            "count":   len(group),   # how many raw lines collapsed here
        })

    return representatives


# ─────────────────────────────────────────────────────────────────────────────
# Step 2: Find regularly-spaced clusters in deduplicated positions
# ─────────────────────────────────────────────────────────────────────────────

def _find_regular_clusters(reps: list[dict]) -> list[list[dict]]:
    """
    Split representatives into gap-separated clusters, then test each for
    regular spacing (low CV).  Returns list of clusters that pass.
    """
    if len(reps) < MIN_GRID_LINES:
        return []

    # Split on large gaps
    raw_clusters: list[list[dict]] = []
    current: list[dict] = [reps[0]]
    for i in range(1, len(reps)):
        gap = reps[i]["coord"] - reps[i - 1]["coord"]
        if gap > MAX_GAP:
            raw_clusters.append(current)
            current = []
        current.append(reps[i])
    raw_clusters.append(current)

    regular: list[list[dict]] = []
    for cluster in raw_clusters:
        if len(cluster) < MIN_GRID_LINES:
            continue
        coords = [r["coord"] for r in cluster]
        gaps   = [coords[i + 1] - coords[i] for i in range(len(coords) - 1)]

        # Remove zero gaps (exact duplicates that survived snap — shouldn't
        # happen after deduplicate, but guard anyway)
        gaps = [g for g in gaps if g > 0]
        if not gaps:
            continue

        mean_gap = sum(gaps) / len(gaps)
        if mean_gap == 0:
            continue
        variance = sum((g - mean_gap) ** 2 for g in gaps) / len(gaps)
        cv = math.sqrt(variance) / mean_gap

        if VERBOSE:
            print(
                f"[GridDetector]   cluster n={len(cluster)} "
                f"spacing={mean_gap:.1f} CV={cv:.3f} "
                f"{'✓ GRID' if cv < REGULARITY_CV else '✗ irregular'}"
            )

        if cv < REGULARITY_CV:
            regular.append(cluster)

    return regular


# ─────────────────────────────────────────────────────────────────────────────
# Main entry point
# ─────────────────────────────────────────────────────────────────────────────

def mark_grid_elements(
    elements: list[dict[str, Any]],
    doc_width:  float | None = None,
    doc_height: float | None = None,
) -> list[dict[str, Any]]:
    """
    Detect and mark grid/column lines.

    Algorithm
    ---------
    1. Extract all H and V lines that are long enough.
    2. Apply length pre-filter (remove hatch/tick lines).
    3. DEDUPLICATE nearby parallel lines (wall faces, duplicates) → reps.
    4. Find regularly-spaced clusters in the deduplicated positions.
    5. Collect all original element indices belonging to confirmed grid positions.
    6. Mark those elements is_grid=True, is_structural=False.
    """

    # ── 1. Collect oriented lines ─────────────────────────────────────────────
    v_items: list[dict] = []
    h_items: list[dict] = []

    for idx, el in enumerate(elements):
        seg = _extract_segment(el.get("tag", ""), el.get("coords", {}))
        if seg is None:
            continue
        orient = _orientation(*seg)
        if orient is None:
            continue

        start, end = seg
        if orient == "H":
            y      = (start[1] + end[1]) / 2.0
            length = abs(end[0] - start[0])
            h_items.append({"coord": y, "length": length, "indices": [idx]})
        else:
            x      = (start[0] + end[0]) / 2.0
            length = abs(end[1] - start[1])
            v_items.append({"coord": x, "length": length, "indices": [idx]})

    if VERBOSE:
        print(f"[GridDetector] Raw: {len(v_items)} vertical, {len(h_items)} horizontal")

    # ── 2. Length pre-filter ──────────────────────────────────────────────────
    def _length_filter(items: list[dict]) -> list[dict]:
        if not items:
            return items
        max_len   = max(i["length"] for i in items)
        threshold = max_len * MIN_LENGTH_FRACTION
        return [i for i in items if i["length"] >= threshold]

    v_items = _length_filter(v_items)
    h_items = _length_filter(h_items)

    if VERBOSE:
        print(
            f"[GridDetector] After length filter: "
            f"{len(v_items)} vertical, {len(h_items)} horizontal"
        )

    # ── 3. Deduplicate nearby lines ───────────────────────────────────────────
    v_reps = _deduplicate(v_items, SNAP_TOL)
    h_reps = _deduplicate(h_items, SNAP_TOL)

    if VERBOSE:
        print(
            f"[GridDetector] After dedup (snap={SNAP_TOL}): "
            f"{len(v_reps)} vertical positions, {len(h_reps)} horizontal positions"
        )

    # ── 4. Find regular clusters ──────────────────────────────────────────────
    if VERBOSE:
        print("[GridDetector] Vertical clusters:")
    v_clusters = _find_regular_clusters(v_reps)

    if VERBOSE:
        print("[GridDetector] Horizontal clusters:")
    h_clusters = _find_regular_clusters(h_reps)

    if VERBOSE:
        print(
            f"[GridDetector] Confirmed: "
            f"{len(v_clusters)} vertical grid cluster(s), "
            f"{len(h_clusters)} horizontal grid cluster(s)"
        )

    # ── 5. Collect all original indices ──────────────────────────────────────
    grid_indices: set[int] = set()
    for cluster in v_clusters + h_clusters:
        for rep in cluster:
            grid_indices.update(rep["indices"])

    # ── 6. Mark elements ──────────────────────────────────────────────────────
    marked = 0
    for idx in grid_indices:
        if idx < len(elements):
            el = elements[idx]
            el["element_class"] = "grid"
            el["is_structural"]  = False   # force — geometry wins over sw heuristic
            el["is_grid"]        = True
            marked += 1

    if VERBOSE:
        if marked:
            print(f"[GridDetector] ✓ Marked {marked} elements as grid")
        else:
            print("[GridDetector] No regular grid clusters found — 0 elements marked")

    return elements


# ─────────────────────────────────────────────────────────────────────────────
# Diagnostic helper
# ─────────────────────────────────────────────────────────────────────────────

def grid_summary(elements: list[dict[str, Any]]) -> None:
    grid_els = [e for e in elements if e.get("is_grid")]
    print(f"\n[GridDetector] {len(grid_els)} grid elements total")
    if not grid_els:
        print("  No grid elements found")
        return
    h_count = v_count = 0
    for el in grid_els:
        seg = _extract_segment(el.get("tag", ""), el.get("coords", {}))
        if seg:
            o = _orientation(*seg)
            if o == "H":   h_count += 1
            elif o == "V": v_count += 1
    print(f"  H-lines: {h_count}")
    print(f"  V-lines: {v_count}")


# ─────────────────────────────────────────────────────────────────────────────
# CLI
# ─────────────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import sys
    from stage1_parser import parse_svg
    from stage2_flattener import flatten_transforms

    path = sys.argv[1] if len(sys.argv) > 1 else "input.svg"
    _, elements = parse_svg(path)
    elements = flatten_transforms(elements)
    elements = mark_grid_elements(elements)
    grid_summary(elements)

    n_struct = sum(1 for e in elements if e.get("is_structural"))
    n_grid   = sum(1 for e in elements if e.get("is_grid"))
    n_other  = len(elements) - n_struct - n_grid
    print(f"\nTotals → structural: {n_struct}  grid: {n_grid}  other: {n_other}")