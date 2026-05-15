"""
Stage 1 — SVG Parser with Grid/Legend Detection
Grid and legend elements are DROPPED here before Stage 2

FIX applied:
  WALL_SW_MIN raised from 0.3 to 0.5.
  Architectural grid lines in SVG exports typically have stroke-widths of
  0.2–0.4 px.  The old threshold of 0.3 caused those lines to be classified
  as structural walls BEFORE grid_detector could override them.  Real load-
  bearing walls are drawn at 0.5 px or thicker in every major CAD/BIM export
  format (AutoCAD, Revit, ArchiCAD, Vectorworks).
"""

from __future__ import annotations
import re
import math
from pathlib import Path
from typing import Any
from collections import defaultdict
from lxml import etree


NS = {
    "svg":      "http://www.w3.org/2000/svg",
    "xlink":    "http://www.w3.org/1999/xlink",
    "inkscape": "http://www.inkscape.org/namespaces/inkscape",
}

GEOMETRY_TAGS = {"line", "polyline", "polygon", "rect", "circle", "ellipse", "path"}

STRIP_TAGS = {
    "text", "tspan", "textPath",
    "image", "filter", "feGaussianBlur",
    "pattern", "symbol", "marker",
    "clipPath", "metadata", "desc", "title",
    "style", "script",
}

# ── Stroke-width thresholds ──────────────────────────────────────────────────
# FIX: raised from 0.3 → 0.5.
# Grid/dimension lines in CAD exports are typically 0.2–0.4 px.
# Structural walls are 0.5 px or heavier.  The old value of 0.3 caused many
# grid lines to be misclassified as structural before the grid detector ran.
WALL_SW_MIN      = 0.5   # was 0.3
DIMENSION_SW_MAX = 0.28  # dimension lines (unchanged)

# ── Elements to DROP (legend, grid, annotations) ─────────────────────────────
DROP_LAYER_HINTS = {
    "legend", "legenda", "leyenda",
    "grid", "grille", "axis", "axes",
    "dimension", "dim", "annot", "annotation",
    "label", "text", "txt", "room label", "wall label",
    "bubble", "callout", "title block", "drawing no",
    "scale bar", "north arrow", "symbol",
}

STRUCTURAL_LAYER_HINTS = {
    "wall", "mur", "wand", "paroi", "struct",
    "boundary", "outline", "external", "partition",
    "office", "meeting", "boardroom", "open plan", "director",
    "stair", "lift", "elevator", "corridor", "hall",
}

# ── Colors to DROP (legend items, grid lines) ─────────────────────────────────
DROP_STROKE_COLORS = {
    "#0000ff", "#0000cd", "#00008b", "blue",
    "#0070c0", "#0078d7", "#0080ff", "#0060a0",
    "#00b0f0", "#4472c4", "#2e75b6", "#1f497d",
    "#5b9bd5", "#2f5496", "#17375e",
    "#00ffff", "#00cdcd", "cyan", "aqua",
    "#ff0000", "red", "#ff6600", "orange",
}


# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────

def _local_tag(element: etree._Element) -> str:
    tag = element.tag
    if isinstance(tag, str) and "}" in tag:
        return tag.split("}", 1)[1]
    return tag


def _parse_style_attr(style_str: str) -> dict[str, str]:
    result: dict[str, str] = {}
    if not style_str:
        return result
    for part in style_str.split(";"):
        part = part.strip()
        if ":" in part:
            k, v = part.split(":", 1)
            result[k.strip()] = v.strip()
    return result


def _effective_attr(element: etree._Element, attr: str) -> str | None:
    style = _parse_style_attr(element.get("style", ""))
    if attr in style:
        return style[attr]
    return element.get(attr)


def _collect_transforms(element: etree._Element) -> list[str]:
    transforms: list[str] = []
    el = element
    while el is not None:
        t = el.get("transform")
        if t:
            transforms.insert(0, t)
        el = el.getparent()
    return transforms


def _group_ancestry(element: etree._Element) -> list[str]:
    crumbs: list[str] = []
    el = element.getparent()
    while el is not None:
        tag = _local_tag(el)
        if tag == "g":
            gid = (
                el.get("id")
                or el.get("{http://www.inkscape.org/namespaces/inkscape}label")
                or ""
            )
            if gid:
                crumbs.insert(0, gid)
        el = el.getparent()
    return crumbs


def _parse_stroke_width(sw_str: str | None) -> float:
    if not sw_str:
        return 1.0
    sw_str = sw_str.strip().lower()
    for unit in ("px", "pt", "mm", "cm", "em", "rem", "in"):
        sw_str = sw_str.replace(unit, "")
    try:
        return float(sw_str.strip())
    except ValueError:
        return 1.0


def _should_drop_by_layer(layer_path: list[str]) -> bool:
    """Drop if any layer name matches drop hints (legend, grid, annotations)."""
    layer_lower = " ".join(layer_path).lower()
    normalized  = re.sub(r"[-_.]", " ", layer_lower)
    for hint in DROP_LAYER_HINTS:
        if hint in normalized:
            return True
    return False


def _should_drop_by_color(stroke: str) -> bool:
    """Drop if stroke color matches known grid/legend colors."""
    if not stroke or stroke in ("none", "inherit", "currentColor"):
        return False

    s = stroke.lower().strip()

    # Normalise 3-digit hex → 6-digit
    if re.match(r"^#[0-9a-f]{3}$", s):
        s = "#" + s[1]*2 + s[2]*2 + s[3]*2

    if s in DROP_STROKE_COLORS:
        return True

    m = re.match(r"rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)", s)
    if m:
        r, g, b = int(m.group(1)), int(m.group(2)), int(m.group(3))
        if f"#{r:02x}{g:02x}{b:02x}" in DROP_STROKE_COLORS:
            return True

    return False


# ─────────────────────────────────────────────────────────────────────────────
# Coordinate extractors
# ─────────────────────────────────────────────────────────────────────────────

def _coords_line(el: etree._Element) -> dict:
    return {
        "x1": float(el.get("x1", 0)), "y1": float(el.get("y1", 0)),
        "x2": float(el.get("x2", 0)), "y2": float(el.get("y2", 0)),
    }


def _coords_polyline(el: etree._Element) -> dict:
    raw  = el.get("points", "")
    nums = [float(n) for n in re.split(r"[\s,]+", raw.strip()) if n]
    pts  = [(nums[i], nums[i + 1]) for i in range(0, len(nums) - 1, 2)]
    return {"points": pts}


def _coords_polygon(el: etree._Element) -> dict:
    raw  = el.get("points", "")
    nums = [float(n) for n in re.split(r"[\s,]+", raw.strip()) if n]
    pts  = [(nums[i], nums[i + 1]) for i in range(0, len(nums) - 1, 2)]
    return {"points": pts, "closed": True}


def _coords_rect(el: etree._Element) -> dict:
    return {
        "x":      float(el.get("x",      0)),
        "y":      float(el.get("y",      0)),
        "width":  float(el.get("width",  0)),
        "height": float(el.get("height", 0)),
        "rx":     float(el.get("rx",     0)),
        "ry":     float(el.get("ry",     0)),
    }


def _coords_circle(el: etree._Element) -> dict:
    return {
        "cx": float(el.get("cx", 0)),
        "cy": float(el.get("cy", 0)),
        "r":  float(el.get("r",  0)),
    }


def _coords_ellipse(el: etree._Element) -> dict:
    return {
        "cx": float(el.get("cx", 0)),
        "cy": float(el.get("cy", 0)),
        "rx": float(el.get("rx", 0)),
        "ry": float(el.get("ry", 0)),
    }


def _coords_path(el: etree._Element) -> dict:
    return {"d": el.get("d", "")}


COORD_EXTRACTORS = {
    "line":     _coords_line,
    "polyline": _coords_polyline,
    "polygon":  _coords_polygon,
    "rect":     _coords_rect,
    "circle":   _coords_circle,
    "ellipse":  _coords_ellipse,
    "path":     _coords_path,
}


# ─────────────────────────────────────────────────────────────────────────────
# Main parser
# ─────────────────────────────────────────────────────────────────────────────

def parse_svg(svg_path: str | Path) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """
    Parse SVG, dropping legend, grid, and annotation elements.
    Returns (header, elements) where elements contain NO dropped items.

    Three-pass strategy
    -------------------
    Pass 1 — collect every geometry element with its raw attributes.
              No classification yet so the grid detector sees everything.
    Pass 2 — run geometric grid detector (mark_grid_elements).
              Grid lines are flagged is_grid=True and is_structural=False.
    Pass 3 — classify remaining elements as structural / non-structural,
              then drop anything flagged as grid or matching layer/color rules.
    """
    svg_path = Path(svg_path)
    tree     = etree.parse(str(svg_path))
    root     = tree.getroot()

    header = {
        "source_file": str(svg_path),
        "width":       root.get("width",   ""),
        "height":      root.get("height",  ""),
        "viewBox":     root.get("viewBox", ""),
        "version":     root.get("version", ""),
    }

    # Document dimensions (for grid detector)
    doc_width  = float(root.get("width",  1000))
    doc_height = float(root.get("height", 1000))
    if header["viewBox"]:
        vb = header["viewBox"].split()
        if len(vb) == 4:
            doc_width  = float(vb[2])
            doc_height = float(vb[3])

    # Build id → element map for <use> resolution
    defs_map: dict[str, etree._Element] = {}
    for el in root.iter():
        eid = el.get("id")
        if eid:
            defs_map[eid] = el

    # ── PASS 1: collect raw elements ─────────────────────────────────────────
    all_elements: list[dict[str, Any]] = []

    for el in root.iter():
        tag = _local_tag(el)

        if not isinstance(el.tag, str):
            continue

        # Resolve <use>
        if tag == "use":
            href   = el.get("href") or el.get("{http://www.w3.org/1999/xlink}href", "")
            ref_id = href.lstrip("#")
            if ref_id in defs_map:
                el  = defs_map[ref_id]
                tag = _local_tag(el)
            else:
                continue

        if tag in STRIP_TAGS:
            continue
        if tag not in GEOMETRY_TAGS:
            continue

        display    = _effective_attr(el, "display")    or "inline"
        visibility = _effective_attr(el, "visibility") or "visible"
        if display == "none" or visibility == "hidden":
            continue

        stroke       = _effective_attr(el, "stroke")       or "none"
        stroke_width = _effective_attr(el, "stroke-width") or "1"
        fill         = _effective_attr(el, "fill")         or "none"
        opacity      = _effective_attr(el, "opacity")      or "1"

        stroke_width_px = _parse_stroke_width(stroke_width)
        layer_path      = _group_ancestry(el)
        coords          = COORD_EXTRACTORS.get(tag, lambda e: {})(el)

        record: dict[str, Any] = {
            "id":             el.get("id", ""),
            "tag":            tag,
            "layer_path":     layer_path,
            "transforms":     _collect_transforms(el),
            "stroke":         stroke,
            "stroke_width":   stroke_width,
            "stroke_width_px": stroke_width_px,
            "fill":           fill,
            "opacity":        opacity,
            "display":        display,
            "visibility":     visibility,
            "element_class":  "unknown",
            "is_structural":  False,
            "is_grid":        False,
            "coords":         coords,
            "raw_attribs":    dict(el.attrib),
        }
        all_elements.append(record)

    print(f"[Stage 1] Collected {len(all_elements)} raw elements")

    # ── PASS 2: geometric grid detection ─────────────────────────────────────
    # Runs BEFORE classification so it sees every element unconditionally.
    # grid_detector.mark_grid_elements() now forces is_structural=False on
    # any element it identifies as a grid line.
    try:
        from grid_detector import mark_grid_elements
        all_elements = mark_grid_elements(all_elements, doc_width, doc_height)
        geom_grid_count = sum(1 for e in all_elements if e.get("is_grid", False))
        print(f"[Stage 1] Geometric detection found {geom_grid_count} grid lines")
    except ImportError as exc:
        print(f"[Stage 1] Warning: grid_detector not available: {exc}")
    except Exception as exc:
        print(f"[Stage 1] Warning: grid_detector error: {exc}")

    # ── PASS 3: classify and drop ─────────────────────────────────────────────
    final_elements:      list[dict] = []
    dropped_count        = 0
    dropped_by_geometry  = 0
    dropped_by_layer_col = 0
    structural_count     = 0

    for el in all_elements:
        should_drop = False

        # Priority 1: geometric grid detection (is_grid already forced
        # is_structural=False in the detector, but we also DROP these here).
        if el.get("is_grid", False):
            should_drop           = True
            dropped_by_geometry  += 1

        # Priority 2: layer name / stroke color rules
        elif _should_drop_by_layer(el.get("layer_path", [])):
            should_drop            = True
            dropped_by_layer_col  += 1
        elif _should_drop_by_color(el.get("stroke", "")):
            should_drop            = True
            dropped_by_layer_col  += 1

        if should_drop:
            dropped_count += 1
            continue

        # Classify what remains as structural or non-structural
        is_structural = False

        layer_lower = " ".join(el.get("layer_path", [])).lower()
        for hint in STRUCTURAL_LAYER_HINTS:
            if hint in layer_lower:
                is_structural = True
                break

        # WALL_SW_MIN is now 0.5 (raised from 0.3).
        # Only elements whose stroke_width_px >= 0.5 are promoted to structural
        # via the width heuristic.  Thinner lines (including most grid exports)
        # must be confirmed structural by a matching layer hint above.
        if not is_structural and el.get("stroke_width_px", 0) >= WALL_SW_MIN:
            is_structural = True

        el["is_structural"]  = is_structural
        el["element_class"]  = "structural" if is_structural else "non_structural"

        if is_structural:
            structural_count += 1

        final_elements.append(el)

    non_structural_count = len(final_elements) - structural_count

    print(f"[Stage 1] Final: {len(final_elements)} elements kept")
    print(f"[Stage 1]   Dropped by geometry (grid): {dropped_by_geometry}")
    print(f"[Stage 1]   Dropped by layer/color:     {dropped_by_layer_col}")
    print(f"[Stage 1]   Structural:                 {structural_count}")
    print(f"[Stage 1]   Non-structural:             {non_structural_count}")

    return header, final_elements


# ─────────────────────────────────────────────────────────────────────────────
# Utility
# ─────────────────────────────────────────────────────────────────────────────

def stroke_width_histogram(elements: list[dict]) -> dict[str, int]:
    hist: dict[str, int] = {}
    for el in elements:
        bucket = f"{round(el['stroke_width_px'], 1):.1f}"
        hist[bucket] = hist.get(bucket, 0) + 1
    return dict(sorted(hist.items(), key=lambda x: float(x[0])))


# ─────────────────────────────────────────────────────────────────────────────
# CLI entry point
# ─────────────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import sys, json

    path = sys.argv[1] if len(sys.argv) > 1 else "input.svg"
    hdr, elems = parse_svg(path)
    print(json.dumps(hdr, indent=2))

    print("\nStroke-width histogram:")
    hist = stroke_width_histogram(elems)
    for sw, cnt in hist.items():
        bar = "█" * min(cnt, 60)
        print(f"  {sw:>6} px  {cnt:5d}  {bar}")

    print("\nFirst 3 structural elements:")
    for e in [x for x in elems if x.get("is_structural")][:3]:
        print(json.dumps(
            {k: v for k, v in e.items() if k not in ("raw_attribs", "coords")},
            indent=2,
        ))