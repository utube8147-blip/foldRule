"""
Stage 3 — Geometry Normalizer
Converts every element (after transform flattening) into a uniform list of
explicit line segments: [(x1,y1), (x2,y2)].

Handles:
  - line       → 1 segment
  - polyline   → N-1 segments
  - polygon    → N segments (closes the shape)
  - rect       → 4 segments (already converted to points in Stage 2)
  - circle     → approximated as N-gon (stored separately, not as wall segments)
  - ellipse    → approximated as N-gon (stored separately)
  - path       → parsed via svgpathtools, curves subdivided into polyline segments

Output per element:
  {
    "id":           original SVG id,
    "tag":          original tag,
    "layer_path":   [...],
    "stroke":       ...,
    "stroke_width": ...,
    "fill":         ...,
    "segments":     [{"start": (x,y), "end": (x,y)}, ...],
    "is_closed":    bool,
    "is_curve":     bool,   # True if any arc/bezier was approximated
    "area_shape":   bool,   # True for circles/ellipses (non-wall candidates)
    "baked_matrix": [...],
  }
"""

from __future__ import annotations
import math
import copy
from typing import Any

# svgpathtools is optional — only needed for <path> elements
try:
    from svgpathtools import parse_path, Line, CubicBezier, QuadraticBezier, Arc
    HAS_SVGPATHTOOLS = True
except ImportError:
    HAS_SVGPATHTOOLS = False
    print("[Stage 3] WARNING: svgpathtools not installed. <path> elements will be skipped.")

# Number of line segments used to approximate a full circle/ellipse
CIRCLE_APPROX_SEGMENTS = 64
# Max chord length for bezier/arc subdivision (in SVG units)
CURVE_CHORD_TOLERANCE = 1.0


# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────

def _pts_to_segments(points: list[tuple], closed: bool) -> list[dict]:
    """Convert a point list into a list of segment dicts."""
    segs = []
    for i in range(len(points) - 1):
        segs.append({"start": points[i], "end": points[i + 1]})
    if closed and len(points) >= 3:
        segs.append({"start": points[-1], "end": points[0]})
    return segs


def _approx_circle(cx: float, cy: float, r: float, n: int = CIRCLE_APPROX_SEGMENTS) -> list[tuple]:
    return [
        (cx + r * math.cos(2 * math.pi * i / n),
         cy + r * math.sin(2 * math.pi * i / n))
        for i in range(n)
    ]


def _approx_ellipse(cx: float, cy: float, rx: float, ry: float,
                    n: int = CIRCLE_APPROX_SEGMENTS) -> list[tuple]:
    return [
        (cx + rx * math.cos(2 * math.pi * i / n),
         cy + ry * math.sin(2 * math.pi * i / n))
        for i in range(n)
    ]


def _subdivide_bezier(seg, tol: float = CURVE_CHORD_TOLERANCE) -> list[tuple]:
    """
    Adaptively subdivide a CubicBezier or QuadraticBezier into polyline points.
    Uses chord-length tolerance to decide subdivision depth.
    """
    points = [complex_to_tuple(seg.start)]

    def recurse(s, e, depth=0):
        if depth > 10:
            points.append(complex_to_tuple(e))
            return
        mid_t = 0.5
        mid_pt = seg.point(mid_t) if hasattr(seg, 'point') else (s + e) / 2
        chord = abs(e - s)
        if chord < tol:
            points.append(complex_to_tuple(e))
            return
        recurse(s, mid_pt, depth + 1)
        recurse(mid_pt, e, depth + 1)

    recurse(seg.start, seg.end)
    return points


def _subdivide_arc(seg: Any, tol: float = CURVE_CHORD_TOLERANCE) -> list[tuple]:
    """Approximate an SVG Arc with polyline points using fixed-step sampling."""
    n = max(8, int(abs(seg.end - seg.start) / tol))
    return [complex_to_tuple(seg.point(i / n)) for i in range(n + 1)]


def complex_to_tuple(c) -> tuple[float, float]:
    if isinstance(c, complex):
        return (c.real, c.imag)
    return (float(c[0]), float(c[1]))


def _apply_matrix_to_point(mat: list[float], x: float, y: float) -> tuple[float, float]:
    a, b, c, d, e, f = mat
    return a * x + c * y + e, b * x + d * y + f


def _transform_points(mat: list[float], pts: list[tuple]) -> list[tuple]:
    return [_apply_matrix_to_point(mat, px, py) for px, py in pts]


# ─────────────────────────────────────────────────────────────────────────────
# Per-tag normalizers
# ─────────────────────────────────────────────────────────────────────────────

def _norm_line(coords: dict, mat: list[float]) -> dict:
    p1 = (coords["x1"], coords["y1"])
    p2 = (coords["x2"], coords["y2"])
    return {
        "segments": _pts_to_segments([p1, p2], closed=False),
        "is_closed": False,
        "is_curve": False,
        "area_shape": False,
    }


def _norm_points(coords: dict, mat: list[float]) -> dict:
    pts = coords["points"]
    closed = coords.get("closed", False)
    return {
        "segments": _pts_to_segments(pts, closed=closed),
        "is_closed": closed,
        "is_curve": False,
        "area_shape": False,
    }


def _norm_rect(coords: dict, mat: list[float]) -> dict:
    # Already converted to 4 corner points in Stage 2
    pts = coords["points"]
    return {
        "segments": _pts_to_segments(pts, closed=True),
        "is_closed": True,
        "is_curve": False,
        "area_shape": False,
    }


def _norm_circle(coords: dict, mat: list[float]) -> dict:
    pts = _approx_circle(coords["cx"], coords["cy"], coords["r"])
    return {
        "segments": _pts_to_segments(pts, closed=True),
        "is_closed": True,
        "is_curve": True,
        "area_shape": True,  # circles → columns/posts, not walls
    }


def _norm_ellipse(coords: dict, mat: list[float]) -> dict:
    pts = _approx_ellipse(coords["cx"], coords["cy"], coords["rx"], coords["ry"])
    return {
        "segments": _pts_to_segments(pts, closed=True),
        "is_closed": True,
        "is_curve": True,
        "area_shape": True,
    }


def _norm_path(coords: dict, mat: list[float]) -> dict:
    """Parse SVG path d-string and convert to polyline segments."""
    if not HAS_SVGPATHTOOLS:
        return {"segments": [], "is_closed": False, "is_curve": True, "area_shape": False}

    d = coords.get("d", "")
    baked_mat = coords.get("baked_matrix", [1, 0, 0, 1, 0, 0])

    try:
        path = parse_path(d)
    except Exception as ex:
        print(f"[Stage 3] Path parse error: {ex}")
        return {"segments": [], "is_closed": False, "is_curve": True, "area_shape": False}

    all_points: list[tuple] = []
    has_curve = False
    subpath_groups: list[list[tuple]] = []
    current: list[tuple] = []

    for seg in path:
        if isinstance(seg, Line):
            if not current:
                current.append(complex_to_tuple(seg.start))
            current.append(complex_to_tuple(seg.end))

        elif isinstance(seg, (CubicBezier, QuadraticBezier)):
            has_curve = True
            pts = _subdivide_bezier(seg, CURVE_CHORD_TOLERANCE)
            if not current:
                current.extend(pts)
            else:
                current.extend(pts[1:])  # avoid duplicate start

        elif isinstance(seg, Arc):
            has_curve = True
            pts = _subdivide_arc(seg, CURVE_CHORD_TOLERANCE)
            if not current:
                current.extend(pts)
            else:
                current.extend(pts[1:])

        else:
            # Unknown segment type — treat as move (start new subpath)
            if current:
                subpath_groups.append(current)
            current = []

    if current:
        subpath_groups.append(current)

    # Apply baked matrix to all subpaths
    segments = []
    for group in subpath_groups:
        transformed = _transform_points(baked_mat, group)
        # Detect if path is closed (start ≈ end)
        closed = (
            len(transformed) > 2 and
            math.dist(transformed[0], transformed[-1]) < 1.0
        )
        segments.extend(_pts_to_segments(transformed, closed=False))

    is_closed = any(
        len(g) > 2 and math.dist(g[0], g[-1]) < 1.0
        for g in subpath_groups
    )

    return {
        "segments": segments,
        "is_closed": is_closed,
        "is_curve": has_curve,
        "area_shape": False,
    }


NORMALIZERS = {
    "line":     _norm_line,
    "polyline": _norm_points,
    "polygon":  _norm_points,
    "rect":     _norm_rect,
    "circle":   _norm_circle,
    "ellipse":  _norm_ellipse,
    "path":     _norm_path,
}


# ─────────────────────────────────────────────────────────────────────────────
# Public API
# ─────────────────────────────────────────────────────────────────────────────

def normalize_geometry(elements: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """
    Convert all elements to uniform segment representation.

    Parameters
    ----------
    elements : list[dict]
        Output from stage2_flattener.flatten_transforms()

    Returns
    -------
    list[dict]
        Each element now has a 'segments' key: list of {start, end} dicts.
        Elements with zero segments are dropped (degenerate geometry).
    """
    result: list[dict[str, Any]] = []
    skipped = 0

    for el in elements:
        tag = el["tag"]
        normalizer = NORMALIZERS.get(tag)
        if not normalizer:
            skipped += 1
            continue

        coords = el["coords"]
        mat = el.get("baked_matrix", [1, 0, 0, 1, 0, 0])

        try:
            geom = normalizer(coords, mat)
        except Exception as ex:
            print(f"[Stage 3] Error normalizing {tag} id={el.get('id', '?')}: {ex}")
            skipped += 1
            continue

        if not geom["segments"]:
            skipped += 1
            continue

        el_out = {k: v for k, v in el.items() if k not in ("coords",)}
        el_out.update(geom)
        result.append(el_out)

    total_segs = sum(len(e["segments"]) for e in result)
    print(f"[Stage 3] Normalized {len(result)} elements → {total_segs} segments")
    print(f"[Stage 3] Skipped/degenerate: {skipped}")
    return result


# ─────────────────────────────────────────────────────────────────────────────
# Utility: segment stats
# ─────────────────────────────────────────────────────────────────────────────

def segment_stats(elements: list[dict[str, Any]]) -> dict[str, Any]:
    lengths = []
    for el in elements:
        for seg in el["segments"]:
            sx, sy = seg["start"]
            ex, ey = seg["end"]
            lengths.append(math.dist((sx, sy), (ex, ey)))
    if not lengths:
        return {}
    return {
        "count":  len(lengths),
        "min":    min(lengths),
        "max":    max(lengths),
        "mean":   sum(lengths) / len(lengths),
        "median": sorted(lengths)[len(lengths) // 2],
    }


if __name__ == "__main__":
    import sys, json
    from stage1_parser import parse_svg
    from stage2_flattener import flatten_transforms

    path = sys.argv[1] if len(sys.argv) > 1 else "input.svg"
    _, elements = parse_svg(path)
    flat = flatten_transforms(elements)
    normed = normalize_geometry(flat)
    print("Segment stats:", json.dumps(segment_stats(normed), indent=2))
    print("First element segments (first 3):")
    for seg in normed[0]["segments"][:3]:
        print(f"  {seg['start']} → {seg['end']}")