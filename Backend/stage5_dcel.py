"""
Stage 5 — DCEL Face Finder  (complete version)
===============================================
Builds a Doubly-Connected Edge List from the clean segment soup produced by
Stage 4, extracts EVERY bounded face (closed polygon), and returns both rooms
and walls.

KEY RULE — flood-fill semantics
--------------------------------
Each face is only the space enclosed by its immediate walls.  A pillar inside
a room is a SEPARATE face — the room face does NOT include the pillar area.
Nested faces are independent.  This matches the "pour water" intuition exactly.

Output
------
rooms : list[dict]   — every bounded face, including tiny ones
walls : list[dict]   — every unique wall segment with metadata
"""

from __future__ import annotations
import math
from collections import defaultdict
from typing import Any


# ─────────────────────────────────────────────────────────────────────────────
# Geometry helpers
# ─────────────────────────────────────────────────────────────────────────────

def _signed_area(pts: list[tuple]) -> float:
    n = len(pts)
    if n < 3:
        return 0.0
    area = 0.0
    for i in range(n):
        j = (i + 1) % n
        area += pts[i][0] * pts[j][1]
        area -= pts[j][0] * pts[i][1]
    return area / 2.0


def _centroid(pts: list[tuple]) -> tuple:
    if not pts:
        return (0.0, 0.0)
    return (sum(p[0] for p in pts) / len(pts),
            sum(p[1] for p in pts) / len(pts))


def _bbox(pts: list[tuple]) -> dict:
    xs = [p[0] for p in pts]
    ys = [p[1] for p in pts]
    return {
        "min_x": min(xs), "max_x": max(xs),
        "min_y": min(ys), "max_y": max(ys),
        "width":  max(xs) - min(xs),
        "height": max(ys) - min(ys),
    }


def _angle_from(origin: tuple, target: tuple) -> float:
    return math.atan2(target[1] - origin[1], target[0] - origin[0])


def _point_in_polygon(pt: tuple, poly: list[tuple]) -> bool:
    """Ray-casting point-in-polygon test."""
    x, y = pt
    n = len(poly)
    inside = False
    j = n - 1
    for i in range(n):
        xi, yi = poly[i]
        xj, yj = poly[j]
        if ((yi > y) != (yj > y)) and (x < (xj - xi) * (y - yi) / (yj - yi) + xi):
            inside = not inside
        j = i
    return inside


# ─────────────────────────────────────────────────────────────────────────────
# Half-edge data structure
# ─────────────────────────────────────────────────────────────────────────────

class HalfEdge:
    __slots__ = ("id", "origin", "twin", "next", "face")

    def __init__(self, he_id: int, origin: tuple):
        self.id     = he_id
        self.origin = origin
        self.twin:  "HalfEdge | None" = None
        self.next:  "HalfEdge | None" = None
        self.face   = -1

    def dest(self) -> tuple:
        return self.twin.origin  # type: ignore


# ─────────────────────────────────────────────────────────────────────────────
# Build DCEL
# ─────────────────────────────────────────────────────────────────────────────

def _build_dcel(segments: list[dict]) -> list[HalfEdge]:
    half_edges: list[HalfEdge] = []
    he_id = 0
    outgoing: dict[tuple, list[HalfEdge]] = defaultdict(list)

    for seg in segments:
        a, b = seg["start"], seg["end"]
        ab = HalfEdge(he_id,     a)
        ba = HalfEdge(he_id + 1, b)
        ab.twin = ba
        ba.twin = ab
        he_id += 2
        half_edges.extend([ab, ba])
        outgoing[a].append(ab)
        outgoing[b].append(ba)

    # Sort each node's outgoing edges by angle
    for node, edges in outgoing.items():
        edges.sort(key=lambda e: _angle_from(node, e.dest()))

    # Link .next: next(e) = twin of edge immediately CW of e's twin at dest(e)
    for node, edges in outgoing.items():
        n = len(edges)
        for i, e in enumerate(edges):
            edges[(i - 1) % n].twin.next = e

    return half_edges


# ─────────────────────────────────────────────────────────────────────────────
# Extract faces
# ─────────────────────────────────────────────────────────────────────────────

def _extract_faces(half_edges: list[HalfEdge]) -> list[dict[str, Any]]:
    visited: set[int] = set()
    faces: list[dict] = []
    face_id = 0

    for start_he in half_edges:
        if start_he.id in visited:
            continue
        if start_he.next is None:
            visited.add(start_he.id)
            continue

        cycle: list[HalfEdge] = []
        he = start_he
        for _ in range(len(half_edges) + 1):
            if he.id in visited:
                break
            visited.add(he.id)
            cycle.append(he)
            he.face = face_id
            he = he.next  # type: ignore
            if he is None or he is start_he:
                break

        if len(cycle) < 3:
            continue

        pts = [e.origin for e in cycle]
        sa  = _signed_area(pts)

        faces.append({
            "face_id":      face_id,
            "vertices":     pts,
            "polygon":      pts + [pts[0]],
            "area":         abs(sa),
            "signed_area":  sa,
            "is_outer":     sa < 0,
            "centroid":     _centroid(pts),
            "vertex_count": len(pts),
            "bbox":         _bbox(pts),
        })
        face_id += 1

    return faces


# ─────────────────────────────────────────────────────────────────────────────
# Wall extraction
# ─────────────────────────────────────────────────────────────────────────────

def _extract_walls(segments: list[dict]) -> list[dict]:
    walls = []
    for i, seg in enumerate(segments):
        sx, sy = seg["start"]
        ex, ey = seg["end"]
        length = math.dist((sx, sy), (ex, ey))
        angle  = math.degrees(math.atan2(ey - sy, ex - sx)) % 180

        # Orientation bucket
        if angle < 10 or angle > 170:
            orientation = "horizontal"
        elif 80 < angle < 100:
            orientation = "vertical"
        else:
            orientation = "diagonal"

        walls.append({
            "wall_id":     i + 1,
            "start":       seg["start"],
            "end":         seg["end"],
            "length":      round(length, 3),
            "angle_deg":   round(angle, 2),
            "orientation": orientation,
        })
    return walls


# ─────────────────────────────────────────────────────────────────────────────
# Nesting / containment
# ─────────────────────────────────────────────────────────────────────────────

def _compute_nesting(faces: list[dict]) -> list[dict]:
    """
    For each face, find its immediate parent (the smallest face that fully
    contains it).  Faces at nesting_depth=0 are top-level rooms.
    Faces at depth=1 are features inside rooms (pillars, furniture, etc).
    Faces at depth=2+ are deeply nested (toilet bowl inside cubicle, etc).
    """
    # Sort by area descending so outer faces are processed first
    sorted_faces = sorted(faces, key=lambda f: f["area"], reverse=True)

    # For each face store its index in sorted_faces
    parent_of: dict[int, int | None] = {f["face_id"]: None for f in sorted_faces}

    for i, face in enumerate(sorted_faces):
        centroid = face["centroid"]
        # Find smallest ancestor that contains this face's centroid
        best_ancestor = None
        best_area = float("inf")
        for j, candidate in enumerate(sorted_faces):
            if j == i:
                continue
            if candidate["area"] <= face["area"]:
                continue
            if _point_in_polygon(centroid, candidate["vertices"]):
                if candidate["area"] < best_area:
                    best_area = candidate["area"]
                    best_ancestor = candidate["face_id"]
        parent_of[face["face_id"]] = best_ancestor

    # Compute nesting depth
    def depth(fid):
        d = 0
        pid = parent_of[fid]
        while pid is not None:
            d += 1
            pid = parent_of[pid]
        return d

    for face in faces:
        face["parent_face_id"] = parent_of[face["face_id"]]
        face["nesting_depth"]  = depth(face["face_id"])

    return faces


# ─────────────────────────────────────────────────────────────────────────────
# Public API
# ─────────────────────────────────────────────────────────────────────────────

def detect_rooms_and_walls(
    stage4_output: list[dict[str, Any]],
) -> tuple[list[dict], list[dict]]:
    """
    Full Stage 5 pipeline.

    Returns
    -------
    rooms : every bounded face (including tiny ones — pillars, furniture, etc.)
    walls : every unique wall segment with length/orientation metadata
    """
    if not stage4_output:
        print("[Stage 5] WARNING: empty input")
        return [], []

    segments = stage4_output[0]["segments"]
    print(f"[Stage 5] Building DCEL from {len(segments)} segments …")

    half_edges = _build_dcel(segments)
    print(f"[Stage 5] Half-edges created: {len(half_edges)}")

    faces = _extract_faces(half_edges)
    print(f"[Stage 5] Raw faces found: {len(faces)}")

    if not faces:
        return [], _extract_walls(segments)

    # Sort by area descending
    faces.sort(key=lambda f: f["area"], reverse=True)

    # Drop the single largest CW face (document outer boundary)
    # It is always the face with the largest area AND negative signed_area
    outer_candidates = [f for f in faces if f["signed_area"] < 0]
    if outer_candidates:
        outer = max(outer_candidates, key=lambda f: f["area"])
        print(f"[Stage 5] Dropping outer face  "
              f"face_id={outer['face_id']}  area={outer['area']:.1f}")
        faces = [f for f in faces if f["face_id"] != outer["face_id"]]
    else:
        # Fallback: drop single largest face
        if faces:
            print(f"[Stage 5] Dropping largest face as outer  area={faces[0]['area']:.1f}")
            faces = faces[1:]

    # Re-index
    for i, f in enumerate(faces):
        f["face_id"] = i + 1

    # Compute nesting (which faces are inside which)
    faces = _compute_nesting(faces)

    # Summarise
    print(f"[Stage 5] Final faces kept: {len(faces)}")
    depth_counts = defaultdict(int)
    for f in faces:
        depth_counts[f["nesting_depth"]] += 1
    for d in sorted(depth_counts):
        print(f"  depth {d}: {depth_counts[d]} faces")
    for f in faces[:10]:
        print(f"  face {f['face_id']:3d}  "
              f"depth={f['nesting_depth']}  "
              f"verts={f['vertex_count']:3d}  "
              f"area={f['area']:8.1f}  "
              f"centroid=({f['centroid'][0]:.1f}, {f['centroid'][1]:.1f})")
    if len(faces) > 10:
        print(f"  … and {len(faces) - 10} more")

    walls = _extract_walls(segments)
    print(f"[Stage 5] Walls: {len(walls)}")

    return faces, walls


# ─────────────────────────────────────────────────────────────────────────────
# CLI
# ─────────────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import sys, json
    from stage1_parser     import parse_svg
    from stage2_flattener  import flatten_transforms
    from stage3_normalizer import normalize_geometry
    from stage4_snapper    import snap_and_clean

    path = sys.argv[1] if len(sys.argv) > 1 else "input.svg"
    _, elements = parse_svg(path)
    flat    = flatten_transforms(elements)
    normed  = normalize_geometry(flat)
    cleaned = snap_and_clean(normed)
    rooms, walls = detect_rooms_and_walls(cleaned)

    print(f"\n[Stage 5] Rooms: {len(rooms)}  Walls: {len(walls)}")
    print(json.dumps(rooms[:3], indent=2, default=str))