"""
Stage 6 — Shape Matcher & Classifier
======================================
Two jobs:

  1. CLASSIFY every face by semantic type:
       room, corridor, pillar, window, door_swing, furniture, fixture, void

  2. FIND REPETITIVE SHAPES:
       Group geometrically similar faces (same area ± tolerance, same aspect
       ratio ± tolerance, same vertex count) — useful for detecting pillar
       grids, window bays, toilet cubicles, stair treads, etc.

Classification heuristics
--------------------------
Uses area, aspect ratio, vertex count, nesting depth, and shape regularity.
No ML — pure geometry.  Thresholds are tunable constants.

  PILLAR       : tiny area, roughly square, high regularity, depth >= 1
  WINDOW       : thin rectangle (high aspect ratio), depth >= 1
  DOOR_SWING   : arc-like polygon (many vertices, low area)
  FURNITURE    : medium area, irregular shape, depth >= 1
  FIXTURE      : small area, depth >= 2 (toilet bowl inside cubicle, etc.)
  CORRIDOR     : large area, very high aspect ratio
  ROOM         : large area, moderate aspect ratio, depth 0 or 1
  VOID         : catch-all for anything unclassified

Repetitive shape groups
-----------------------
Output: list of groups, each group = list of face IDs with a representative
"template" face and a transform list (translation only — rotation/scale not
tracked in this version).
"""

from __future__ import annotations
import math
from collections import defaultdict
from typing import Any


# ─────────────────────────────────────────────────────────────────────────────
# Classification thresholds  (all in SVG units²)
# ─────────────────────────────────────────────────────────────────────────────

# Area bands
AREA_PILLAR_MAX    =    400.0   # very small closed shape → pillar / column
AREA_FIXTURE_MAX   =   2000.0   # toilet, basin, sink, bathtub, small furniture
AREA_FURNITURE_MAX =  10000.0   # bed, desk, sofa, wardrobe
AREA_CORRIDOR_MIN  =  15000.0   # long thin space

# Aspect ratio (long side / short side)
ASPECT_WINDOW_MIN   = 5.0   # very elongated → likely window opening
ASPECT_CORRIDOR_MIN = 3.5   # elongated but bigger → corridor
ASPECT_SQUARE_MAX   = 1.4   # nearly square

# Vertex count
VERTS_ARC_MIN = 20   # arc-like → door swing or curved element

# Regularity: perimeter² / (4π × area).  Circle = 1.0, square ≈ 1.27
REGULARITY_SQUARE_MAX = 1.35
REGULARITY_ARC_MAX    = 1.10

# Repetition matching tolerances
AREA_MATCH_PCT   = 0.12   # 12 % area tolerance
ASPECT_MATCH_ABS = 0.20   # absolute aspect-ratio tolerance
VERTS_MATCH_ABS  = 3      # vertex count tolerance
MIN_GROUP_SIZE   = 2      # groups smaller than this are not reported


# ─────────────────────────────────────────────────────────────────────────────
# Geometry helpers
# ─────────────────────────────────────────────────────────────────────────────

def _perimeter(vertices: list[tuple]) -> float:
    total = 0.0
    n = len(vertices)
    for i in range(n):
        total += math.dist(vertices[i], vertices[(i + 1) % n])
    return total


def _aspect_ratio(bbox: dict) -> float:
    w = max(bbox["width"],  0.001)
    h = max(bbox["height"], 0.001)
    return max(w, h) / min(w, h)


def _regularity(area: float, perimeter: float) -> float:
    """Isoperimetric quotient variant: higher = more circular."""
    if perimeter <= 0:
        return 0.0
    return (perimeter ** 2) / (4 * math.pi * max(area, 0.001))


# ─────────────────────────────────────────────────────────────────────────────
# Classifier
# ─────────────────────────────────────────────────────────────────────────────

def _classify_face(face: dict) -> str:
    area   = face["area"]
    bbox   = face["bbox"]
    verts  = face["vertex_count"]
    depth  = face.get("nesting_depth", 0)
    vertices = face.get("vertices", [])

    aspect = _aspect_ratio(bbox)
    perim  = _perimeter(vertices)
    reg    = _regularity(area, perim)

    # ── Pillar / column ──────────────────────────────────────────────────────
    if area <= AREA_PILLAR_MAX and depth >= 1:
        if aspect <= ASPECT_SQUARE_MAX and reg <= REGULARITY_SQUARE_MAX:
            return "pillar"
        if reg <= REGULARITY_ARC_MAX:
            return "pillar"   # circular column

    # ── Door swing (arc) ────────────────────────────────────────────────────
    if verts >= VERTS_ARC_MIN and area <= AREA_FIXTURE_MAX and depth >= 1:
        if reg <= REGULARITY_ARC_MAX:
            return "door_swing"

    # ── Window opening ──────────────────────────────────────────────────────
    if aspect >= ASPECT_WINDOW_MIN and area <= AREA_FURNITURE_MAX and depth >= 1:
        return "window"

    # ── Deep fixture (toilet bowl, basin inner, etc.) ───────────────────────
    if depth >= 2 and area <= AREA_FIXTURE_MAX:
        return "fixture"

    # ── General fixture / sanitary ──────────────────────────────────────────
    if area <= AREA_FIXTURE_MAX and depth >= 1:
        return "fixture"

    # ── Furniture ───────────────────────────────────────────────────────────
    if area <= AREA_FURNITURE_MAX and depth >= 1:
        return "furniture"

    # ── Corridor ────────────────────────────────────────────────────────────
    if area >= AREA_CORRIDOR_MIN and aspect >= ASPECT_CORRIDOR_MIN:
        return "corridor"

    # ── Room ────────────────────────────────────────────────────────────────
    if area > AREA_FURNITURE_MAX:
        return "room"

    # ── Void / unclassified ─────────────────────────────────────────────────
    return "void"


def classify_faces(faces: list[dict]) -> list[dict]:
    for face in faces:
        face["shape_type"] = _classify_face(face)
    return faces


# ─────────────────────────────────────────────────────────────────────────────
# Repetitive shape finder
# ─────────────────────────────────────────────────────────────────────────────

def _shape_signature(face: dict) -> tuple:
    """
    Coarse signature for grouping: (area_bucket, aspect_bucket, verts_bucket).
    Bucket sizes are tuned to the match tolerances above.
    """
    area_bucket   = round(face["area"]   / (face["area"] * AREA_MATCH_PCT + 1))
    aspect_bucket = round(_aspect_ratio(face["bbox"]) / ASPECT_MATCH_ABS)
    verts_bucket  = face["vertex_count"] // (VERTS_MATCH_ABS + 1)
    return (area_bucket, aspect_bucket, verts_bucket)


def _faces_similar(a: dict, b: dict) -> bool:
    """Detailed similarity check between two faces."""
    # Area
    area_a, area_b = a["area"], b["area"]
    if area_a == 0 or area_b == 0:
        return False
    area_ratio = max(area_a, area_b) / min(area_a, area_b)
    if area_ratio > 1 + AREA_MATCH_PCT:
        return False

    # Aspect ratio
    asp_a = _aspect_ratio(a["bbox"])
    asp_b = _aspect_ratio(b["bbox"])
    if abs(asp_a - asp_b) > ASPECT_MATCH_ABS:
        return False

    # Vertex count
    if abs(a["vertex_count"] - b["vertex_count"]) > VERTS_MATCH_ABS:
        return False

    return True


def find_repetitive_shapes(faces: list[dict]) -> list[dict]:
    """
    Group faces that are geometrically similar (potential repeated elements:
    pillars, windows, toilet cubicles, stair treads …).

    Returns
    -------
    list of group dicts:
      {
        "group_id": int,
        "count":    int,
        "shape_type": str,       # most common type in the group
        "template_area":   float,
        "template_aspect": float,
        "face_ids": [int, ...],
        "centroids": [(x,y), ...],
      }
    """
    # Coarse bucket pass
    buckets: dict[tuple, list[dict]] = defaultdict(list)
    for face in faces:
        buckets[_shape_signature(face)].append(face)

    # Within each bucket, do pairwise refinement with union-find
    # (buckets are small so O(n²) is fine here)
    groups: list[list[dict]] = []

    for bucket in buckets.values():
        if len(bucket) < MIN_GROUP_SIZE:
            continue

        # Simple greedy grouping within bucket
        used = [False] * len(bucket)
        for i in range(len(bucket)):
            if used[i]:
                continue
            group = [bucket[i]]
            used[i] = True
            for j in range(i + 1, len(bucket)):
                if used[j]:
                    continue
                if _faces_similar(bucket[i], bucket[j]):
                    group.append(bucket[j])
                    used[j] = True
            if len(group) >= MIN_GROUP_SIZE:
                groups.append(group)

    # Build output dicts
    result: list[dict] = []
    for gid, group in enumerate(groups, start=1):
        types = [f.get("shape_type", "void") for f in group]
        most_common_type = max(set(types), key=types.count)
        avg_area   = sum(f["area"] for f in group) / len(group)
        avg_aspect = sum(_aspect_ratio(f["bbox"]) for f in group) / len(group)

        result.append({
            "group_id":        gid,
            "count":           len(group),
            "shape_type":      most_common_type,
            "template_area":   round(avg_area, 1),
            "template_aspect": round(avg_aspect, 3),
            "face_ids":        [f["face_id"] for f in group],
            "centroids":       [f["centroid"] for f in group],
        })

    # Sort by count descending
    result.sort(key=lambda g: g["count"], reverse=True)

    print(f"[Stage 6] Found {len(result)} repetitive shape groups:")
    for g in result[:10]:
        print(f"  group {g['group_id']:3d}  "
              f"type={g['shape_type']:12s}  "
              f"count={g['count']:4d}  "
              f"area≈{g['template_area']:.1f}")
    if len(result) > 10:
        print(f"  … and {len(result) - 10} more groups")

    return result


def groups_to_json(groups: list[dict]) -> list[dict]:
    """Serialise groups to a JSON-friendly format."""
    return [
        {
            **g,
            "centroids": [[round(x, 2), round(y, 2)] for x, y in g["centroids"]],
        }
        for g in groups
    ]


# ─────────────────────────────────────────────────────────────────────────────
# Public API entry point
# ─────────────────────────────────────────────────────────────────────────────

def find_repetitive_shapes(faces: list[dict]) -> list[dict]:  # noqa: F811
    """
    Classify all faces then find groups of geometrically similar ones.
    Modifies faces in-place to add 'shape_type'.
    Returns list of group dicts.
    """
    classify_faces(faces)

    type_counts = defaultdict(int)
    for f in faces:
        type_counts[f["shape_type"]] += 1
    print("[Stage 6] Shape type summary:")
    for t, c in sorted(type_counts.items(), key=lambda x: -x[1]):
        print(f"  {t:15s}: {c}")

    # Re-use inner implementation above (shadow the outer def)
    # Coarse bucket pass
    buckets: dict[tuple, list[dict]] = defaultdict(list)
    for face in faces:
        buckets[_shape_signature(face)].append(face)

    groups: list[list[dict]] = []
    for bucket in buckets.values():
        if len(bucket) < MIN_GROUP_SIZE:
            continue
        used = [False] * len(bucket)
        for i in range(len(bucket)):
            if used[i]:
                continue
            group = [bucket[i]]
            used[i] = True
            for j in range(i + 1, len(bucket)):
                if used[j]:
                    continue
                if _faces_similar(bucket[i], bucket[j]):
                    group.append(bucket[j])
                    used[j] = True
            if len(group) >= MIN_GROUP_SIZE:
                groups.append(group)

    result: list[dict] = []
    for gid, group in enumerate(groups, start=1):
        types = [f.get("shape_type", "void") for f in group]
        most_common_type = max(set(types), key=types.count)
        avg_area   = sum(f["area"] for f in group) / len(group)
        avg_aspect = sum(_aspect_ratio(f["bbox"]) for f in group) / len(group)
        result.append({
            "group_id":        gid,
            "count":           len(group),
            "shape_type":      most_common_type,
            "template_area":   round(avg_area, 1),
            "template_aspect": round(avg_aspect, 3),
            "face_ids":        [f["face_id"] for f in group],
            "centroids":       [f["centroid"] for f in group],
        })

    result.sort(key=lambda g: g["count"], reverse=True)
    print(f"[Stage 6] Found {len(result)} repetitive shape groups")
    for g in result[:10]:
        print(f"  group {g['group_id']:3d}  "
              f"type={g['shape_type']:12s}  "
              f"count={g['count']:4d}  "
              f"area≈{g['template_area']:.1f}")
    if len(result) > 10:
        print(f"  … and {len(result) - 10} more groups")

    return result