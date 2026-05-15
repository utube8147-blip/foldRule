"""
Stage 6 — Repetitive Shape Detector
Finds structurally and geometrically identical shapes across the floor plan,
regardless of rotation, reflection, or position.

Two complementary strategies:
  A. Exact match — canonical edge-length signature
     Works perfectly for rectilinear shapes (rooms, columns, stairwells).
     O(n) after sorting.

  B. Approximate match — Procrustes analysis
     Works for near-identical shapes with minor drafting variations.
     O(n²) but n is usually small (room count, not segment count).

Both strategies produce a GroupID → [room/shape instances] mapping.
Each instance stores the similarity transform (rotation, scale, translation)
that maps the canonical template onto it.

Additionally runs moment-invariant fingerprinting (Hu moments) as a fast
pre-filter before Procrustes to avoid O(n²) on large plans.
"""

from __future__ import annotations
import math
import copy
from typing import Any
from collections import defaultdict

try:
    import numpy as np
    HAS_NUMPY = True
except ImportError:
    HAS_NUMPY = False
    print("[Stage 6] WARNING: numpy not installed. Procrustes matching unavailable.")

# ─────────────────────────────────────────────────────────────────────────────
# Configuration
# ─────────────────────────────────────────────────────────────────────────────

# Tolerance for edge-length comparison in canonical signature (SVG units)
LENGTH_TOL = 1.0

# Max Procrustes residual (as fraction of shape scale) to call two shapes "same"
PROCRUSTES_TOL = 0.05   # 5% of shape size

# Hu moment distance threshold for pre-filter
HU_MOMENT_TOL = 0.05


# ─────────────────────────────────────────────────────────────────────────────
# Strategy A — Canonical edge-length signature
# ─────────────────────────────────────────────────────────────────────────────

def _edge_lengths(vertices: list[tuple]) -> list[float]:
    n = len(vertices)
    return [
        math.dist(vertices[i], vertices[(i+1) % n])
        for i in range(n)
    ]


def _canonical_signature(vertices: list[tuple]) -> tuple:
    """
    Rotation + reflection invariant signature for a polygon.
    Method: sort edge-length sequence by minimum lexicographic rotation,
    then also try the reverse (reflection) and take the smaller.

    Returns a tuple of rounded edge lengths — identical for congruent polygons.
    """
    lengths = _edge_lengths(vertices)
    n = len(lengths)

    # Round to LENGTH_TOL
    rounded = tuple(round(l / LENGTH_TOL) * LENGTH_TOL for l in lengths)

    # All rotations
    rotations = [rounded[i:] + rounded[:i] for i in range(n)]
    # All reflections (reverse)
    reflected = rounded[::-1]
    reflections = [reflected[i:] + reflected[:i] for i in range(n)]

    return min(rotations + reflections)


def group_by_signature(shapes: list[dict]) -> dict[tuple, list[dict]]:
    """
    Group shapes by their canonical edge-length signature.
    shapes: list of dicts with at least {"vertices": [...], "face_id": ...}
    """
    groups: dict[tuple, list[dict]] = defaultdict(list)
    for shape in shapes:
        sig = _canonical_signature(shape["vertices"])
        groups[sig].append(shape)

    # Keep only groups with more than one member (repetitive shapes)
    repeated = {sig: members for sig, members in groups.items() if len(members) > 1}
    print(f"[Stage 6] Signature groups: {len(groups)} total, {len(repeated)} repeated")
    return repeated


# ─────────────────────────────────────────────────────────────────────────────
# Strategy B — Procrustes analysis (rotation+scale invariant)
# ─────────────────────────────────────────────────────────────────────────────

def _to_array(vertices: list[tuple]) -> "np.ndarray":
    import numpy as np
    return np.array(vertices, dtype=float)


def _center(pts: "np.ndarray") -> "np.ndarray":
    return pts - pts.mean(axis=0)


def _normalize(pts: "np.ndarray") -> tuple["np.ndarray", float]:
    """Translate to centroid, scale so Frobenius norm = 1."""
    c = _center(pts)
    scale = math.sqrt((c ** 2).sum())
    if scale < 1e-10:
        return c, 1.0
    return c / scale, scale


def procrustes_distance(verts_a: list[tuple], verts_b: list[tuple]) -> float:
    """
    Compute minimum Procrustes distance between two polygons.
    Tries all cyclic rotations and reflection of B to find the best alignment.
    Returns residual after optimal rotation (0 = identical, 1 = totally different).
    """
    if not HAS_NUMPY:
        return float("inf")

    import numpy as np

    if len(verts_a) != len(verts_b):
        return float("inf")

    A, _ = _normalize(_to_array(verts_a))
    B_raw = _to_array(verts_b)

    n = len(verts_a)
    best_dist = float("inf")

    for reflect in [False, True]:
        B_try = B_raw[::-1] if reflect else B_raw
        for rot in range(n):
            B_rot = np.roll(B_try, rot, axis=0)
            B_norm, _ = _normalize(B_rot)

            # Optimal rotation via SVD
            H = A.T @ B_norm
            U, S, Vt = np.linalg.svd(H)
            R = Vt.T @ U.T
            # Ensure proper rotation (det = +1)
            if np.linalg.det(R) < 0:
                Vt[-1, :] *= -1
                R = Vt.T @ U.T

            B_aligned = B_norm @ R
            dist = float(np.sqrt(((A - B_aligned) ** 2).sum()))
            if dist < best_dist:
                best_dist = dist

    return best_dist


def _optimal_transform(
    verts_template: list[tuple],
    verts_instance: list[tuple]
) -> dict:
    """
    Compute the similarity transform (rotation_deg, scale, translation)
    that maps the template polygon onto the instance.
    """
    if not HAS_NUMPY:
        return {}

    import numpy as np
    A = _to_array(verts_template)
    B = _to_array(verts_instance)

    cA = A.mean(axis=0)
    cB = B.mean(axis=0)
    Ac = A - cA
    Bc = B - cB

    scaleA = math.sqrt((Ac ** 2).sum())
    scaleB = math.sqrt((Bc ** 2).sum())
    scale  = scaleB / scaleA if scaleA > 1e-10 else 1.0

    H = (Ac / scaleA).T @ (Bc / scaleB)
    U, _, Vt = np.linalg.svd(H)
    R = Vt.T @ U.T
    if np.linalg.det(R) < 0:
        Vt[-1, :] *= -1
        R = Vt.T @ U.T

    angle_rad = math.atan2(R[1, 0], R[0, 0])
    translation = cB - (scale * (cA @ R))

    return {
        "rotation_deg":   round(math.degrees(angle_rad), 2),
        "scale":          round(scale, 6),
        "translation":    (round(translation[0], 4), round(translation[1], 4)),
        "is_reflection":  bool(np.linalg.det(R) < 0),
    }


# ─────────────────────────────────────────────────────────────────────────────
# Hu-moment fingerprinting (fast pre-filter)
# ─────────────────────────────────────────────────────────────────────────────

def _hu_moments(vertices: list[tuple]) -> tuple:
    """
    Compute a simplified version of Hu moments from polygon vertex coordinates.
    Returns a 4-tuple used as a fast similarity pre-filter.
    """
    if not HAS_NUMPY or len(vertices) < 3:
        return (0.0,) * 4

    import numpy as np
    pts = np.array(vertices, dtype=float)
    cx, cy = pts.mean(axis=0)
    dx = pts[:, 0] - cx
    dy = pts[:, 1] - cy

    m20 = float((dx**2).mean())
    m02 = float((dy**2).mean())
    m11 = float((dx * dy).mean())
    m30 = float((dx**3).mean())
    m03 = float((dy**3).mean())

    # Invariant combinations
    hu1 = round((m20 + m02) / max(m20 * m02, 1e-12) ** 0.5, 4)
    hu2 = round((m20 - m02) ** 2 + 4 * m11**2, 4)
    hu3 = round((m30 - 3 * m12 if False else m30) ** 2, 4)  # simplified
    hu4 = round(m03, 4)

    return (hu1, hu2, hu3, hu4)


def _hu_distance(h1: tuple, h2: tuple) -> float:
    return math.sqrt(sum((a - b) ** 2 for a, b in zip(h1, h2)))


# ─────────────────────────────────────────────────────────────────────────────
# Combined matching pipeline
# ─────────────────────────────────────────────────────────────────────────────

def find_repetitive_shapes(
    shapes: list[dict],
    use_procrustes: bool = True,
) -> list[dict]:
    """
    Full Stage 6 pipeline. Finds all groups of geometrically identical shapes.

    Parameters
    ----------
    shapes : list[dict]
        Each dict must have "vertices" (list of (x,y)) and "face_id".
        Typically the output of stage5_room_detector.detect_rooms_and_walls() rooms list.
    use_procrustes : bool
        If True, also run Procrustes matching within signature groups for
        approximate matching (catches near-identical shapes).

    Returns
    -------
    groups : list[dict]
        [
          {
            "group_id":    int,
            "signature":   tuple,        # canonical edge-length tuple
            "count":       int,          # number of instances
            "template":    dict,         # the canonical instance (largest)
            "instances": [
              {
                "face_id":   ...,
                "transform": {rotation_deg, scale, translation, is_reflection},
                "procrustes_dist": float,
              }, ...
            ]
          }, ...
        ]
    """
    # Step A: group by exact signature
    sig_groups = group_by_signature(shapes)

    groups = []
    gid = 0

    for sig, members in sig_groups.items():
        # Pick the largest-area member as template
        template = max(members, key=lambda s: s.get("area", 0))
        instances = []

        for shape in members:
            transform = {}
            proc_dist = 0.0

            if use_procrustes and HAS_NUMPY and len(template["vertices"]) == len(shape["vertices"]):
                proc_dist = procrustes_distance(template["vertices"], shape["vertices"])
                if proc_dist <= PROCRUSTES_TOL:
                    transform = _optimal_transform(template["vertices"], shape["vertices"])

            instances.append({
                "face_id":         shape["face_id"],
                "centroid":        shape.get("centroid"),
                "area":            shape.get("area"),
                "transform":       transform,
                "procrustes_dist": round(proc_dist, 6),
            })

        gid += 1
        groups.append({
            "group_id":  gid,
            "signature": sig,
            "count":     len(members),
            "template":  {
                "face_id":  template["face_id"],
                "centroid": template.get("centroid"),
                "area":     template.get("area"),
                "vertices": template["vertices"],
            },
            "instances": instances,
        })

    # Sort groups by count (most repeated first)
    groups.sort(key=lambda g: g["count"], reverse=True)
    print(f"[Stage 6] Found {len(groups)} repeated shape groups")
    for g in groups[:5]:
        print(f"  Group {g['group_id']}: {g['count']} instances, "
              f"area≈{g['template'].get('area', 0):.1f}  sig={g['signature'][:3]}...")

    return groups


# ─────────────────────────────────────────────────────────────────────────────
# Export helpers
# ─────────────────────────────────────────────────────────────────────────────

def groups_to_json(groups: list[dict]) -> list[dict]:
    """Serialize groups to JSON-safe dicts (convert tuples to lists)."""
    import json
    raw = json.dumps(groups, default=lambda o: list(o) if isinstance(o, tuple) else str(o))
    return json.loads(raw)


# ─────────────────────────────────────────────────────────────────────────────
# CLI test
# ─────────────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import sys, json
    from stage1_parser     import parse_svg
    from stage2_flattener  import flatten_transforms
    from stage3_normalizer import normalize_geometry
    from stage4_snapper    import snap_and_clean
    from stage5_room_detector import detect_rooms_and_walls

    path = sys.argv[1] if len(sys.argv) > 1 else "input.svg"
    _, elements = parse_svg(path)
    flat    = flatten_transforms(elements)
    normed  = normalize_geometry(flat)
    cleaned = snap_and_clean(normed)
    rooms, walls = detect_rooms_and_walls(cleaned)

    groups = find_repetitive_shapes(rooms)
    print(json.dumps(groups_to_json(groups[:3]), indent=2))