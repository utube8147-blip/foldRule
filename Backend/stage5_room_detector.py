"""
Stage 5 — Planar Graph & Room Detector
Fixed version: resolves false-negative room detection caused by over-aggressive
margin, corner, bottom-strip, and rectangle filters.

Key changes vs previous version
────────────────────────────────
• MARGIN_FRACTION        0.15  → 0.05   (edge rooms were excluded)
• CORNER_FRACTION        0.20  → 0.10   (corner rooms were excluded)
• BOTTOM_STRIP_FRACTION  0.25  → 0.10   (lower-half rooms were excluded)
• MAX_WALLS_FOR_RECT_CHECK 6   → 4      (real rooms ARE rectangles; only
                                          reject true 4-wall axis-aligned boxes
                                          that are also in a corner/strip)
• RECT_ANGLE_TOLERANCE_DEG 12  → 5      (stricter: avoids matching room walls
                                          that happen to be nearly orthogonal)
• MIN_ROOM_AREA          50.0  → 10.0   (SVG coordinate scale may be small)
• NEW: _is_annotation_block now requires BOTH shape + location tests to be
       true simultaneously — previously shape alone could trigger rejection
• NEW: debug_filter_decisions() helper prints exactly why each face was kept
       or dropped so you can tune constants without re-running the full pipeline
• NEW: SVG coordinate scale diagnostic printed at startup so you can verify
       MIN_ROOM_AREA is appropriate for your drawing's unit system
"""

from __future__ import annotations
import math
import copy
from typing import Any
from collections import defaultdict

try:
    from shapely.geometry import Polygon
    HAS_SHAPELY = True
except ImportError:
    HAS_SHAPELY = False
    print("[Stage 5] WARNING: shapely not installed — using shoelace area.")

# ── Tunable constants ─────────────────────────────────────────────────────────
MIN_ROOM_AREA          = 10.0     # SVG units² — raise if rooms still missing
MAX_ROOM_AREA          = 1e9
MIN_WALL_LABEL_LENGTH  = 5.0
MIN_WALLS_FOR_ROOM     = 3

# Document-border detection
DOCUMENT_BORDER_AREA_THRESHOLD = 90.0   # % of total area
AREA_RATIO_THRESHOLD           = 10.0   # must be 10× larger than 2nd biggest
MAX_REASONABLE_ROOM_AREA       = 500_000.0

# ── Bbox / shape rejection ────────────────────────────────────────────────────
MIN_ROOM_BBOX_WIDTH   = 10.0    # SVG units — was 30; scale-dependent
MIN_ROOM_BBOX_HEIGHT  = 10.0    # SVG units — was 30
MAX_BBOX_ASPECT_RATIO = 20.0    # was 15; dimension lines are very elongated

# ── Margin / corner artifact rejection ───────────────────────────────────────
# Outermost fraction on every side treated as "margin".
# REDUCED from 0.15 → 0.05: rooms near the building perimeter were excluded.
MARGIN_FRACTION = 0.005  

# Centroid within this fraction of the total drawing span from ANY corner.
# REDUCED from 0.20 → 0.10: corner offices were excluded.
CORNER_FRACTION = 0.10

# Bottom strip fraction — title-block zone.
# REDUCED from 0.25 → 0.10: rooms in the lower quarter were excluded.
BOTTOM_STRIP_FRACTION = 0.10

# ── Pure-rectangle / annotation-table rejection ───────────────────────────────
# REDUCED from 6 → 4: real rooms ARE rectangles with 4 walls.
# Only a true axis-aligned box (exactly 4 walls) is tested for the shape check.
# Even then it must ALSO be in a corner or bottom strip to be rejected.
MAX_WALLS_FOR_RECT_CHECK  = 4

# TIGHTENED from 12° → 5°: only reject near-perfect right-angle boxes.
# A room with a door cutout has a slightly non-90° effective corner — keep it.
RECT_ANGLE_TOLERANCE_DEG  = 5.0

# ── Verbose debug ─────────────────────────────────────────────────────────────
# Set True to print per-face filter decisions during development.
DEBUG_FILTERS = True


# ─────────────────────────────────────────────────────────────────────────────
# Step 1 — Build node + edge maps
# ─────────────────────────────────────────────────────────────────────────────

def _round_pt(pt: tuple, decimals: int = 4) -> tuple:
    return (round(pt[0], decimals), round(pt[1], decimals))


def build_graph(elements: list[dict]) -> tuple[dict, dict, list]:
    node_index: dict[tuple, int] = {}
    edges: list[tuple] = []

    def get_node(pt: tuple) -> int:
        p = _round_pt(pt)
        if p not in node_index:
            node_index[p] = len(node_index)
        return node_index[p]

    for el in elements:
        meta = {
            "stroke":          el.get("stroke", ""),
            "stroke_width":    el.get("stroke_width", "1"),
            "stroke_width_px": el.get("stroke_width_px", 1.0),
            "layer":           el.get("layer_path", []),
            "element_id":      el.get("id", ""),
        }
        for seg in el["segments"]:
            a = get_node(seg["start"])
            b = get_node(seg["end"])
            if a != b:
                edges.append((a, b, copy.copy(meta)))

    id_to_pt = {v: k for k, v in node_index.items()}
    print(f"[Stage 5] Graph: {len(node_index)} nodes, {len(edges)} edges")

    # ── Coordinate-scale diagnostic ───────────────────────────────────────────
    if node_index:
        all_x = [p[0] for p in node_index]
        all_y = [p[1] for p in node_index]
        span_x = max(all_x) - min(all_x)
        span_y = max(all_y) - min(all_y)
        print(f"[Stage 5] Drawing span: {span_x:.1f} × {span_y:.1f} SVG units")
        print(f"[Stage 5] MIN_ROOM_AREA={MIN_ROOM_AREA} — a room must be at least "
              f"{math.sqrt(MIN_ROOM_AREA):.1f}×{math.sqrt(MIN_ROOM_AREA):.1f} units. "
              f"Adjust if your coordinate scale is unusual.")

    return node_index, id_to_pt, edges


# ─────────────────────────────────────────────────────────────────────────────
# Step 2+3 — DCEL
# ─────────────────────────────────────────────────────────────────────────────

def _angle(pt_from: tuple, pt_to: tuple) -> float:
    return math.atan2(pt_to[1] - pt_from[1], pt_to[0] - pt_from[0])


def build_dcel(id_to_pt: dict, edges: list) -> dict:
    adj: dict[int, list[tuple]] = defaultdict(list)

    for a, b, _ in edges:
        pt_a, pt_b = id_to_pt[a], id_to_pt[b]
        adj[a].append((_angle(pt_a, pt_b), b))
        adj[b].append((_angle(pt_b, pt_a), a))

    for node in adj:
        adj[node].sort(key=lambda x: x[0])

    dcel: dict[tuple, dict] = {}

    for a, b, meta in edges:
        for src, dst in [(a, b), (b, a)]:
            dcel[(src, dst)] = {
                "twin":    (dst, src),
                "next":    None,
                "face_id": None,
                "angle":   _angle(id_to_pt[src], id_to_pt[dst]),
                "meta":    meta,
            }

    dangling = 0
    for (a, b) in list(dcel.keys()):
        neighbours = adj[b]
        idx = next((i for i, (_, nb) in enumerate(neighbours) if nb == a), None)
        if idx is None:
            dangling += 1
            continue
        _, next_nb = neighbours[(idx - 1) % len(neighbours)]
        dcel[(a, b)]["next"] = (b, next_nb)

    if dangling:
        print(f"[Stage 5] WARNING: {dangling} half-edges have no 'next' pointer. "
              f"This means unsnapped endpoints — increase SNAP_EPSILON in stage4.")

    return dcel


# ─────────────────────────────────────────────────────────────────────────────
# Step 4 helpers
# ─────────────────────────────────────────────────────────────────────────────

def _shoelace_signed(pts: list[tuple]) -> float:
    n = len(pts)
    return sum(
        pts[i][0] * pts[(i+1)%n][1] - pts[(i+1)%n][0] * pts[i][1]
        for i in range(n)
    ) / 2.0


def _centroid(pts: list[tuple]) -> tuple:
    return (round(sum(p[0] for p in pts) / len(pts), 4),
            round(sum(p[1] for p in pts) / len(pts), 4))


def _bounding_box(pts: list[tuple]) -> dict:
    xs = [p[0] for p in pts]
    ys = [p[1] for p in pts]
    w  = max(xs) - min(xs)
    h  = max(ys) - min(ys)
    return {"min_x": min(xs), "max_x": max(xs),
            "min_y": min(ys), "max_y": max(ys),
            "width": w, "height": h}


def _perimeter(pts: list[tuple]) -> float:
    return sum(math.dist(pts[i], pts[(i+1) % len(pts)]) for i in range(len(pts)))


# ─────────────────────────────────────────────────────────────────────────────
# Annotation / title-block / legend rejection helpers
# ─────────────────────────────────────────────────────────────────────────────

def _interior_angle_deg(p_prev: tuple, p_cur: tuple, p_next: tuple) -> float:
    """Return the interior angle at p_cur (0–360°)."""
    ax = p_prev[0] - p_cur[0];  ay = p_prev[1] - p_cur[1]
    bx = p_next[0] - p_cur[0];  by = p_next[1] - p_cur[1]
    dot   = ax * bx + ay * by
    cross = ax * by - ay * bx
    return abs(math.degrees(math.atan2(abs(cross), dot)))


def _looks_like_rectangle(pts: list[tuple]) -> bool:
    """
    Return True ONLY if the polygon is a near-perfect axis-aligned rectangle:
    - Exactly MAX_WALLS_FOR_RECT_CHECK (4) vertices
    - Every interior angle within RECT_ANGLE_TOLERANCE_DEG of 90° or 180°

    With MAX_WALLS_FOR_RECT_CHECK=4 and RECT_ANGLE_TOLERANCE_DEG=5, this
    catches title-block cells and legend swatches while leaving rooms alone —
    even rectangular rooms typically have door cutouts or column notches that
    add extra vertices, pushing n_walls above 4.
    """
    n = len(pts)
    if n > MAX_WALLS_FOR_RECT_CHECK:
        return False
    for i in range(n):
        ang = _interior_angle_deg(pts[i - 1], pts[i], pts[(i + 1) % n])
        near_90  = abs(ang - 90)  <= RECT_ANGLE_TOLERANCE_DEG
        near_180 = abs(ang - 180) <= RECT_ANGLE_TOLERANCE_DEG
        if not (near_90 or near_180):
            return False
    return True


def _compute_drawing_extents(faces: list[dict]) -> dict:
    """Full bounding box of all faces (the sheet extents)."""
    return {
        "min_x": min(f["bbox"]["min_x"] for f in faces),
        "max_x": max(f["bbox"]["max_x"] for f in faces),
        "min_y": min(f["bbox"]["min_y"] for f in faces),
        "max_y": max(f["bbox"]["max_y"] for f in faces),
    }


def _compute_floor_plan_core(faces: list[dict]) -> dict:
    """
    Bounding box of the CORE floor plan area = sheet extents shrunk by
    MARGIN_FRACTION on every side.
    With MARGIN_FRACTION=0.05 only a thin 5% strip on each side is excluded.
    """
    ext    = _compute_drawing_extents(faces)
    span_x = ext["max_x"] - ext["min_x"]
    span_y = ext["max_y"] - ext["min_y"]
    return {
        "min_x": ext["min_x"] + span_x * MARGIN_FRACTION,
        "max_x": ext["max_x"] - span_x * MARGIN_FRACTION,
        "min_y": ext["min_y"] + span_y * MARGIN_FRACTION,
        "max_y": ext["max_y"] - span_y * MARGIN_FRACTION,
    }


def _is_annotation_block(face: dict, extents: dict) -> tuple[bool, str]:
    """
    Heuristics targeting legend boxes, title blocks, and scale panels.

    FIXED logic: shape AND location must BOTH be true for rejection.
    Previously, shape-in-corner alone could reject a rectangular room.

    Check 1 — Rectangle AND in corner
        A ≤4-wall near-right-angle polygon whose centroid sits within
        CORNER_FRACTION (10%) of any corner → legend swatch or title cell.
        Requires BOTH shape test AND location test.

    Check 2 — Rectangle AND in bottom strip
        A ≤4-wall near-right-angle polygon whose centroid is in the bottom
        BOTTOM_STRIP_FRACTION (10%) of the sheet → title block panel.
        Requires BOTH shape test AND location test.

    Check 3 — Centroid extremely close to corner (4%), any shape
        Very tight threshold so only true corner decorations (north arrow
        base, scale-bar end cap) are caught, not corner offices.
    """
    pts = face["vertices"]
    cx, cy = face["centroid"]

    total_w = extents["max_x"] - extents["min_x"]
    total_h = extents["max_y"] - extents["min_y"]

    # Normalised position (0 = left/top edge, 1 = right/bottom edge)
    nx = (cx - extents["min_x"]) / total_w if total_w else 0.5
    ny = (cy - extents["min_y"]) / total_h if total_h else 0.5

    is_near_horiz_edge = nx < CORNER_FRACTION or nx > (1 - CORNER_FRACTION)
    is_near_vert_edge  = ny < CORNER_FRACTION or ny > (1 - CORNER_FRACTION)
    in_corner          = is_near_horiz_edge and is_near_vert_edge

    in_bottom_strip    = ny > (1 - BOTTOM_STRIP_FRACTION)

    looks_rect = _looks_like_rectangle(pts)

    # Check 1: rectangle AND in a corner (both conditions required)
    if looks_rect and in_corner:
        return True, (
            f"rectangle ({len(pts)} walls) in corner "
            f"(nx={nx:.2f}, ny={ny:.2f})"
        )

    # Check 2: rectangle AND in the bottom title-block strip (both required)
    if looks_rect and in_bottom_strip:
        return True, (
            f"rectangle ({len(pts)} walls) in bottom strip "
            f"(ny={ny:.2f})"
        )

    # Check 3: centroid extremely close to a corner (4% threshold),
    #          regardless of shape — catches circular north arrows, tiny
    #          scale-bar end boxes, etc.  NOT triggered by corner offices.
    tight = 0.04
    very_near_horiz = nx < tight or nx > (1 - tight)
    very_near_vert  = ny < tight or ny > (1 - tight)
    if very_near_horiz and very_near_vert:
        return True, (
            f"centroid very close to sheet corner "
            f"(nx={nx:.2f}, ny={ny:.2f})"
        )

    return False, ""


def _is_margin_artifact(face: dict, core: dict) -> tuple[bool, str]:
    """
    Return (True, reason) if this face is outside the core plan area or has
    degenerate dimensions.
    """
    bb = face["bbox"]
    w, h = bb["width"], bb["height"]

    # 1. Too small in either dimension
    if w < MIN_ROOM_BBOX_WIDTH or h < MIN_ROOM_BBOX_HEIGHT:
        return True, f"bbox too small ({w:.1f}×{h:.1f})"

    # 2. Extreme aspect ratio (scale bar / dimension line)
    if h > 0 and w / h > MAX_BBOX_ASPECT_RATIO:
        return True, f"aspect ratio too wide ({w/h:.1f})"
    if w > 0 and h / w > MAX_BBOX_ASPECT_RATIO:
        return True, f"aspect ratio too tall ({h/w:.1f})"

    # 3. Centroid outside shrunk core area
    cx, cy = face["centroid"]
    if (cx < core["min_x"] or cx > core["max_x"] or
            cy < core["min_y"] or cy > core["max_y"]):
        return True, (
            f"centroid ({cx:.1f},{cy:.1f}) outside core "
            f"[{core['min_x']:.1f}–{core['max_x']:.1f}, "
            f"{core['min_y']:.1f}–{core['max_y']:.1f}]"
        )

    return False, ""


def _is_document_border(face: dict, all_faces: list[dict]) -> bool:
    total_area = sum(f["area"] for f in all_faces)
    if total_area == 0:
        return False

    pct = face["area"] / total_area * 100

    if pct >= DOCUMENT_BORDER_AREA_THRESHOLD:
        print(f"[Stage 5]   → border by area: {pct:.1f}%")
        return True

    sorted_faces = sorted(all_faces, key=lambda f: f["area"], reverse=True)
    if (len(sorted_faces) >= 2
            and face["face_id"] == sorted_faces[0]["face_id"]):
        ratio = sorted_faces[0]["area"] / max(sorted_faces[1]["area"], 1)
        if ratio >= AREA_RATIO_THRESHOLD:
            bb = face["bbox"]
            contained = sum(
                1 for other in sorted_faces[1:]
                if (bb["min_x"] <= other["bbox"]["min_x"]
                    and bb["max_x"] >= other["bbox"]["max_x"]
                    and bb["min_y"] <= other["bbox"]["min_y"]
                    and bb["max_y"] >= other["bbox"]["max_y"])
            )
            if contained >= len(sorted_faces) * 0.7:
                print(f"[Stage 5]   → border by dominance: {ratio:.1f}×, "
                      f"contains {contained}")
                return True

    return False


# ─────────────────────────────────────────────────────────────────────────────
# Debug helper — prints per-face filter decisions
# ─────────────────────────────────────────────────────────────────────────────

def debug_filter_decisions(raw_faces: list[dict],
                           extents: dict,
                           core: dict,
                           max_faces: int = 30) -> None:
    """
    Call this right after traverse_faces() during development to see exactly
    why each candidate face is kept or dropped.  Controlled by DEBUG_FILTERS.
    """
    if not DEBUG_FILTERS:
        return

    print(f"\n[Stage 5] ── Per-face filter decisions (first {max_faces}) ──")
    print(f"  {'ID':>4}  {'walls':>5}  {'area':>10}  {'annot?':>8}  "
          f"{'artifact?':>10}  {'border?':>8}  decision")

    for face in raw_faces[:max_faces]:
        is_border  = _is_document_border(face, raw_faces)
        is_annot,  r1 = _is_annotation_block(face, extents)
        is_art,    r2 = _is_margin_artifact(face, core)

        if is_border:
            decision = "DROP — document border"
        elif is_annot:
            decision = f"DROP — annotation: {r1}"
        elif is_art:
            decision = f"DROP — margin artifact: {r2}"
        else:
            decision = "KEEP ✓"

        print(f"  {face['face_id']:>4}  {face['n_walls']:>5}  "
              f"{face['area']:>10.1f}  {str(is_annot):>8}  "
              f"{str(is_art):>10}  {str(is_border):>8}  {decision}")

    print("[Stage 5] ── end filter decisions ──\n")


# ─────────────────────────────────────────────────────────────────────────────
# Step 4 — Face traversal
# ─────────────────────────────────────────────────────────────────────────────

def traverse_faces(dcel: dict, id_to_pt: dict) -> list[dict]:
    visited: set[tuple] = set()
    raw_faces: list[dict] = []
    face_id = 0

    for he in dcel:
        if he in visited:
            continue
        if dcel[he]["next"] is None:
            visited.add(he)
            continue

        cycle: list[tuple] = []
        cur = he
        steps = 0
        max_steps = len(dcel) + 1

        while cur not in visited and steps < max_steps:
            visited.add(cur)
            cycle.append(cur)
            nxt = dcel[cur]["next"]
            if nxt is None:
                break
            cur = nxt
            steps += 1

        if len(cycle) < MIN_WALLS_FOR_ROOM:
            continue

        pts    = [id_to_pt[h[0]] for h in cycle]
        signed = _shoelace_signed(pts)
        area   = abs(signed)

        if area < MIN_ROOM_AREA or area > MAX_REASONABLE_ROOM_AREA:
            continue

        face_id += 1
        room: dict = {
            "face_id":   face_id,
            "vertices":  pts,
            "area":      area,
            "centroid":  _centroid(pts),
            "bbox":      _bounding_box(pts),
            "perimeter": _perimeter(pts),
            "n_walls":   len(pts),
            "is_ccw":    signed > 0,
        }

        if HAS_SHAPELY:
            try:
                poly = Polygon(pts)
                if poly.is_valid:
                    room["area"]     = poly.area
                    room["centroid"] = (round(poly.centroid.x, 4),
                                        round(poly.centroid.y, 4))
            except Exception:
                pass

        raw_faces.append(room)

    if not raw_faces:
        print("[Stage 5] WARNING: No faces found at all — check DCEL / snap.")
        return []

    # ── Sort and summarise ────────────────────────────────────────────────────
    raw_faces.sort(key=lambda f: f["area"], reverse=True)
    total_area = sum(f["area"] for f in raw_faces)

    print(f"[Stage 5] {len(raw_faces)} raw faces, total area={total_area:.1f}")
    print(f"[Stage 5] Top {min(10, len(raw_faces))} by area:")
    for f in raw_faces[:10]:
        pct = f["area"] / total_area * 100 if total_area else 0
        print(f"    Face {f['face_id']:4d}: area={f['area']:10.1f} "
              f"({pct:5.1f}%)  "
              f"bbox={f['bbox']['width']:.0f}×{f['bbox']['height']:.0f}  "
              f"walls={f['n_walls']}")

    # Pre-compute spatial context used by all filters
    extents = _compute_drawing_extents(raw_faces)
    core    = _compute_floor_plan_core(raw_faces)
    print(f"[Stage 5] Sheet extents: "
          f"x=[{extents['min_x']:.1f},{extents['max_x']:.1f}]  "
          f"y=[{extents['min_y']:.1f},{extents['max_y']:.1f}]")
    print(f"[Stage 5] Core floor-plan area (MARGIN={MARGIN_FRACTION}): "
          f"x=[{core['min_x']:.1f},{core['max_x']:.1f}]  "
          f"y=[{core['min_y']:.1f},{core['max_y']:.1f}]")

    # ── Debug: print per-face decisions before filtering ──────────────────────
    debug_filter_decisions(raw_faces, extents, core)

    # ── Filter pipeline ───────────────────────────────────────────────────────
    kept:    list[dict] = []
    dropped: list[str]  = []

    for face in raw_faces:

        # 1. Document border?
        if _is_document_border(face, raw_faces):
            dropped.append(f"Face {face['face_id']} — document border")
            continue

        # 2. Annotation / title-block / legend block?
        is_annot, reason = _is_annotation_block(face, extents)
        if is_annot:
            dropped.append(f"Face {face['face_id']} — annotation block: {reason}")
            continue

        # 3. Margin artifact (centroid outside core, extreme aspect, too small)?
        is_artifact, reason = _is_margin_artifact(face, core)
        if is_artifact:
            dropped.append(f"Face {face['face_id']} — margin artifact: {reason}")
            continue

        kept.append(face)

    # ── Report ────────────────────────────────────────────────────────────────
    if dropped:
        print(f"[Stage 5] Dropped {len(dropped)} non-room faces:")
        for msg in dropped:
            print(f"    ✗ {msg}")

    kept.sort(key=lambda f: f["area"], reverse=True)
    print(f"[Stage 5] Kept {len(kept)} rooms "
          f"(dropped {len(dropped)} from {len(raw_faces)} total)")

    if kept:
        print(f"[Stage 5] Largest: {kept[0]['area']:.1f}  "
              f"Smallest: {kept[-1]['area']:.1f}")
    else:
        print("[Stage 5] WARNING: No rooms kept after filtering.")
        print(f"  Suggestions:")
        print(f"    • Reduce MIN_ROOM_AREA (currently {MIN_ROOM_AREA})")
        print(f"    • Reduce MARGIN_FRACTION (currently {MARGIN_FRACTION})")
        print(f"    • Reduce CORNER_FRACTION (currently {CORNER_FRACTION})")
        print(f"    • Reduce BOTTOM_STRIP_FRACTION (currently {BOTTOM_STRIP_FRACTION})")
        print(f"    • Increase SNAP_EPSILON in stage4_snapper.py")
        print(f"    • Set DEBUG_FILTERS=True and re-run to see per-face reasons")

    return kept


# ─────────────────────────────────────────────────────────────────────────────
# Step 5 — Wall labeling
# ─────────────────────────────────────────────────────────────────────────────

def label_walls(edges: list, id_to_pt: dict) -> list[dict]:
    walls = []
    seen: set[frozenset] = set()

    for idx, (a, b, meta) in enumerate(edges):
        key = frozenset([a, b])
        if key in seen:
            continue
        seen.add(key)

        pt_a, pt_b = id_to_pt[a], id_to_pt[b]
        dx = pt_b[0] - pt_a[0]
        dy = pt_b[1] - pt_a[1]
        length = math.hypot(dx, dy)

        if length < MIN_WALL_LABEL_LENGTH:
            continue

        angle_deg = math.degrees(math.atan2(dy, dx)) % 360
        ang_norm  = angle_deg % 180

        if ang_norm < 15 or ang_norm > 165:
            orientation = "H"
        elif 75 < ang_norm < 105:
            orientation = "V"
        else:
            orientation = "D"

        compass_angle = (angle_deg + 90) % 360
        compass = "N"
        for threshold, label in [
            (22.5, "N"),  (67.5, "NE"), (112.5, "E"),  (157.5, "SE"),
            (202.5, "S"), (247.5, "SW"),(292.5, "W"),  (337.5, "NW"),
        ]:
            if compass_angle < threshold:
                compass = label
                break

        walls.append({
            "wall_id":         f"W{idx+1:04d}",
            "node_a":          a,
            "node_b":          b,
            "start":           pt_a,
            "end":             pt_b,
            "length":          round(length, 4),
            "angle_deg":       round(angle_deg, 2),
            "orientation":     orientation,
            "compass":         compass,
            "stroke":          meta.get("stroke", ""),
            "stroke_width":    meta.get("stroke_width", "1"),
            "stroke_width_px": meta.get("stroke_width_px", 1.0),
            "layer":           meta.get("layer", []),
        })

    print(f"[Stage 5] Labeled {len(walls)} unique walls "
          f"(≥ {MIN_WALL_LABEL_LENGTH} units)")
    return walls


# ─────────────────────────────────────────────────────────────────────────────
# Public API
# ─────────────────────────────────────────────────────────────────────────────

def detect_rooms_and_walls(elements: list[dict]) -> tuple[list[dict], list[dict]]:
    if not elements:
        print("[Stage 5] ERROR: No elements — check Stage 4 output")
        return [], []

    if sum(len(e["segments"]) for e in elements) == 0:
        print("[Stage 5] ERROR: Zero segments — nothing to build a graph from")
        return [], []

    node_index, id_to_pt, edges = build_graph(elements)

    if not edges:
        print("[Stage 5] ERROR: No edges in graph")
        return [], []

    dcel  = build_dcel(id_to_pt, edges)
    rooms = traverse_faces(dcel, id_to_pt)
    walls = label_walls(edges, id_to_pt)

    if not rooms:
        print("[Stage 5] No rooms detected. Tuning guide:")
        print(f"  1. Set DEBUG_FILTERS=True — re-run to see which filter drops each face")
        print(f"  2. Check DCEL warning count above — high dangling count → snap issue")
        print(f"  3. Lower MIN_ROOM_AREA (now {MIN_ROOM_AREA}) if faces are present but tiny")
        print(f"  4. Lower MARGIN_FRACTION (now {MARGIN_FRACTION}) if rooms are near sheet edges")

    return rooms, walls


# ─────────────────────────────────────────────────────────────────────────────
# CLI
# ─────────────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import sys
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

    print("\n=== ROOMS ===")
    for r in rooms[:20]:
        print(f"  Room {r['face_id']:3d}: area={r['area']:8.1f}  "
              f"centroid={r['centroid']}  walls={r['n_walls']}")

    print("\n=== WALLS (first 10) ===")
    for w in walls[:10]:
        print(f"  {w['wall_id']} [{w['orientation']}] "
              f"len={w['length']:.2f}  dir={w['compass']}")