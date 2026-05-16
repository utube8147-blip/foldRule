"""
Stage 5b — Semantic Annotation Filter
======================================
Removes any detected polygon that spatially overlaps with SVG text annotations:
legend boxes, title blocks, north-arrow frames, scale panels, room-label areas, etc.

Strategy
--------
1. Parse the original SVG for all <text> and <tspan> elements, collecting their
   bounding positions (x, y attributes or transform-derived positions).
2. For each detected face/room polygon, count how many text nodes fall inside it.
3. Any polygon whose text-node density exceeds a threshold is classified as an
   annotation region and removed.

This runs purely on SVG text geometry — no pixel rendering needed.
"""

from __future__ import annotations
import re
import math
from pathlib import Path
from typing import Any

try:
    from lxml import etree
except ImportError:
    etree = None  # type: ignore


# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────

def _point_in_polygon(pt: tuple, poly: list[tuple]) -> bool:
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


def _parse_transform_translate(t: str) -> tuple[float, float]:
    """Extract (tx, ty) from a translate(...) transform string."""
    m = re.search(r'translate\(\s*([\d.\-]+)[\s,]+([\d.\-]+)', t or "")
    if m:
        return float(m.group(1)), float(m.group(2))
    m = re.search(r'translate\(\s*([\d.\-]+)\s*\)', t or "")
    if m:
        return float(m.group(1)), 0.0
    return 0.0, 0.0


def _collect_text_positions(svg_path: str) -> list[tuple[float, float]]:
    """
    Parse SVG and return (x, y) positions for every text node.
    Handles direct x/y attributes plus simple translate() transforms on parents.
    """
    if etree is None:
        return []

    try:
        tree = etree.parse(str(svg_path))
        root = tree.getroot()
    except Exception as ex:
        print(f"[Stage 5b] SVG parse error: {ex}")
        return []

    NS_SVG = "http://www.w3.org/2000/svg"
    positions: list[tuple[float, float]] = []

    for el in root.iter():
        tag = el.tag
        if not isinstance(tag, str):
            continue
        local = tag.split("}", 1)[1] if "}" in tag else tag
        if local not in ("text", "tspan"):
            continue

        # Get x, y directly
        try:
            x = float(el.get("x", 0) or 0)
            y = float(el.get("y", 0) or 0)
        except (ValueError, TypeError):
            x, y = 0.0, 0.0

        # Walk up and accumulate translate() transforms
        parent = el.getparent()
        while parent is not None:
            t = parent.get("transform", "")
            if t:
                tx, ty = _parse_transform_translate(t)
                x += tx
                y += ty
            parent = parent.getparent()

        if x != 0 or y != 0:
            positions.append((x, y))

    return positions


def _polygon_area(pts: list[tuple]) -> float:
    n = len(pts)
    if n < 3:
        return 0.0
    area = 0.0
    for i in range(n):
        j = (i + 1) % n
        area += pts[i][0] * pts[j][1]
        area -= pts[j][0] * pts[i][1]
    return abs(area) / 2.0


# ─────────────────────────────────────────────────────────────────────────────
# Public API
# ─────────────────────────────────────────────────────────────────────────────

# A polygon is considered an "annotation region" if it contains more than this
# many text nodes per unit area (normalised to 1000 SVG units²).
TEXT_DENSITY_THRESHOLD = 0.5   # text nodes per 1000 units²
MIN_TEXT_COUNT         = 2     # absolute minimum to trigger filtering


def filter_annotation_polygons(
    rooms: list[dict[str, Any]],
    svg_path: str,
    text_density_threshold: float = TEXT_DENSITY_THRESHOLD,
    min_text_count: int = MIN_TEXT_COUNT,
) -> list[dict[str, Any]]:
    """
    Remove faces that look like annotation areas (legend boxes, title blocks, etc.)

    Parameters
    ----------
    rooms : list[dict]
        Faces from Stage 5.  Each must have 'vertices' and 'area'.
    svg_path : str
        Original SVG file — used to extract text-node positions.
    text_density_threshold : float
        Text nodes per 1000 SVG units² above which a polygon is discarded.
    min_text_count : int
        Minimum absolute text count to bother checking density.

    Returns
    -------
    Filtered list of rooms with annotation regions removed.
    """
    text_positions = _collect_text_positions(svg_path)
    print(f"[Stage 5b] Found {len(text_positions)} text nodes in SVG")

    if not text_positions:
        print("[Stage 5b] No text nodes — skipping annotation filter")
        return rooms

    kept: list[dict] = []
    removed: list[dict] = []

    for room in rooms:
        vertices = room.get("vertices", [])
        area     = room.get("area", 0.0)

        if not vertices or area <= 0:
            kept.append(room)
            continue

        # Count text nodes inside this polygon
        text_inside = sum(
            1 for pt in text_positions
            if _point_in_polygon(pt, vertices)
        )

        if text_inside < min_text_count:
            kept.append(room)
            continue

        # Check density
        density = text_inside / max(area, 1.0) * 1000.0
        if density >= text_density_threshold:
            removed.append(room)
            print(f"  [5b] Removed face {room['face_id']}  "
                  f"area={area:.1f}  text_nodes={text_inside}  "
                  f"density={density:.3f}/1000u²")
        else:
            kept.append(room)

    print(f"[Stage 5b] Kept {len(kept)}, removed {len(removed)} annotation polygons")
    return kept