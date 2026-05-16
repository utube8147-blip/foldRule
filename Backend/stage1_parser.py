"""
Stage 1 — SVG Parser with Grid/Legend/Border Detection
All non-room elements are DROPPED here before Stage 2.

FIXES APPLIED
─────────────
1. _parse_dimension()
   SVG width/height attributes from Illustrator/CAD export often carry unit
   suffixes like "1920.000000pt".  float() rejects those, so we strip the
   trailing unit before converting.

2. WALL_SW_MIN raised 0.3 → 0.5
   Architectural grid lines are typically 0.2–0.4 px; real walls are 0.5 px+.
   The old threshold caused grid lines to be promoted to structural before the
   grid detector could override them.

3. Sheet-border / frame detection  (_is_sheet_border)
   Floor-plan SVGs always have a thin rectangular frame drawn around the
   entire sheet.  This frame is a valid closed shape, so the face detector
   was filling the whole canvas purple.  We now detect and DROP:
     • Any <rect> that covers ≥ 90 % of the canvas area AND hugs all 4 edges.
     • Any <line> / <polyline> segment that spans ≥ 90 % of canvas width or
       height AND sits within 2 % of the corresponding edge.
   Interior thin lines (partition walls, door swings, fixtures) are NEVER
   matched because they don't simultaneously hug all 4 edges.

4. Title-block exclusion  (_is_title_block_element)
   Title blocks live in the rightmost ~15 % of the sheet.  Geometry there is
   kept in the output but flagged is_title_block=True so the face detector
   can ignore it without losing the geometry entirely.

5. viewBox fallback hardened
   The viewBox float() conversion is now wrapped in try/except so a malformed
   viewBox value does not crash the pipeline.
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
WALL_SW_MIN      = 0.5   # was 0.3 — see fix note 2 above
DIMENSION_SW_MAX = 0.28  # dimension lines (unchanged)

# ── Border / frame detection tolerances ──────────────────────────────────────
BORDER_EDGE_MARGIN = 0.02   # element must be within 2 % of each canvas edge
BORDER_SPAN_MIN    = 0.90   # line must span ≥ 90 % of canvas width or height
BORDER_AREA_MIN    = 0.50   # rect must cover ≥ 50 % of canvas area

# ── Title-block region ────────────────────────────────────────────────────────
TITLE_BLOCK_X_FRAC = 0.85   # rightmost 15 % of the sheet width

# ── Layer drop / keep hints ───────────────────────────────────────────────────
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
# Low-level helpers
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


def _parse_dimension(value: str | None, fallback: float = 1000.0) -> float:
    """
    Parse an SVG dimension, stripping any unit suffix (pt, px, mm, cm, in, em…).
    Illustrator and many CAD exporters write e.g. "1920.000000pt".
    """
    if value is None:
        return fallback
    cleaned = re.sub(r"[a-zA-Z%]+$", "", str(value).strip())
    try:
        return float(cleaned)
    except ValueError:
        return fallback


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


# ─────────────────────────────────────────────────────────────────────────────
# Border / title-block detection
# ─────────────────────────────────────────────────────────────────────────────

def _element_bbox(el: dict) -> tuple[float, float, float, float] | None:
    """Return (x_min, y_min, x_max, y_max) for simple element types."""
    tag    = el.get("tag", "")
    coords = el.get("coords", {})

    if tag == "rect":
        x = coords.get("x", 0)
        y = coords.get("y", 0)
        w = coords.get("width", 0)
        h = coords.get("height", 0)
        return (x, y, x + w, y + h)

    if tag == "line":
        x1, y1 = coords.get("x1", 0), coords.get("y1", 0)
        x2, y2 = coords.get("x2", 0), coords.get("y2", 0)
        return (min(x1, x2), min(y1, y2), max(x1, x2), max(y1, y2))

    if tag in ("polyline", "polygon"):
        pts = coords.get("points", [])
        if not pts:
            return None
        xs = [p[0] for p in pts]
        ys = [p[1] for p in pts]
        return (min(xs), min(ys), max(xs), max(ys))

    return None


def _is_sheet_border(el: dict, doc_width: float, doc_height: float) -> bool:
    """
    True when the element is the sheet-border frame that wraps the entire drawing.

    Detection logic (ALL conditions must hold):
      <rect>              — covers ≥ BORDER_AREA_MIN of canvas
                            AND its four edges hug all four canvas boundaries.
      <line>              — spans ≥ BORDER_SPAN_MIN of canvas width/height
                            AND lies within BORDER_EDGE_MARGIN of the matching edge.
      <polyline/polygon>  — bounding box covers ≥ BORDER_AREA_MIN
                            AND bbox hugs all four canvas boundaries.

    An interior partition wall can NEVER satisfy "hugs all 4 edges simultaneously",
    so thin interior lines are completely safe from false-positive matches.
    """
    tag    = el.get("tag", "")
    coords = el.get("coords", {})
    m      = BORDER_EDGE_MARGIN

    # ── <rect> ────────────────────────────────────────────────────────────────
    if tag == "rect":
        x = coords.get("x", 0)
        y = coords.get("y", 0)
        w = coords.get("width", 0)
        h = coords.get("height", 0)
        near_left   = x       < doc_width  * m
        near_top    = y       < doc_height * m
        near_right  = (x + w) > doc_width  * (1 - m)
        near_bottom = (y + h) > doc_height * (1 - m)
        large       = (w * h) / max(doc_width * doc_height, 1) > BORDER_AREA_MIN
        return near_left and near_top and near_right and near_bottom and large

    # ── <line> ────────────────────────────────────────────────────────────────
    if tag == "line":
        x1, y1 = coords.get("x1", 0), coords.get("y1", 0)
        x2, y2 = coords.get("x2", 0), coords.get("y2", 0)
        spans_w  = abs(x2 - x1) > doc_width  * BORDER_SPAN_MIN
        spans_h  = abs(y2 - y1) > doc_height * BORDER_SPAN_MIN
        hugs_top    = min(y1, y2) < doc_height * m
        hugs_bottom = max(y1, y2) > doc_height * (1 - m)
        hugs_left   = min(x1, x2) < doc_width  * m
        hugs_right  = max(x1, x2) > doc_width  * (1 - m)
        if spans_w and (hugs_top or hugs_bottom):
            return True
        if spans_h and (hugs_left or hugs_right):
            return True

    # ── <polyline> / <polygon> ────────────────────────────────────────────────
    if tag in ("polyline", "polygon"):
        bbox = _element_bbox(el)
        if bbox:
            x_min, y_min, x_max, y_max = bbox
            near_left   = x_min < doc_width  * m
            near_top    = y_min < doc_height * m
            near_right  = x_max > doc_width  * (1 - m)
            near_bottom = y_max > doc_height * (1 - m)
            area        = (x_max - x_min) * (y_max - y_min)
            large       = area / max(doc_width * doc_height, 1) > BORDER_AREA_MIN
            return near_left and near_top and near_right and near_bottom and large

    return False


def _is_title_block_element(el: dict, doc_width: float) -> bool:
    """
    True when the element's entire bounding box lies inside the title-block
    zone (rightmost TITLE_BLOCK_X_FRAC of the sheet width).
    Element is KEPT but flagged is_title_block=True.
    """
    bbox = _element_bbox(el)
    if bbox is None:
        return False
    x_min, _, _, _ = bbox
    return x_min > doc_width * TITLE_BLOCK_X_FRAC


# ─────────────────────────────────────────────────────────────────────────────
# Layer / colour drop rules
# ─────────────────────────────────────────────────────────────────────────────

def _should_drop_by_layer(layer_path: list[str]) -> bool:
    layer_lower = " ".join(layer_path).lower()
    normalized  = re.sub(r"[-_.]", " ", layer_lower)
    for hint in DROP_LAYER_HINTS:
        if hint in normalized:
            return True
    return False


def _should_drop_by_color(stroke: str) -> bool:
    if not stroke or stroke in ("none", "inherit", "currentColor"):
        return False
    s = stroke.lower().strip()
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
    Parse an architectural SVG floor plan, dropping all non-room geometry.
    Returns (header, elements).

    Four-pass strategy
    ------------------
    Pass 1 — Collect every visible geometry element with raw attributes.
    Pass 2 — Run geometric grid detector (mark_grid_elements).
    Pass 3 — Drop sheet borders, grids, and legend/color items.
    Pass 4 — Tag title-block elements; classify the rest structural/non-structural.
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

    # ── Document dimensions ───────────────────────────────────────────────────
    doc_width  = _parse_dimension(root.get("width"),  fallback=1000.0)
    doc_height = _parse_dimension(root.get("height"), fallback=1000.0)
    if header["viewBox"]:
        vb = header["viewBox"].split()
        if len(vb) == 4:
            try:
                doc_width  = float(vb[2])
                doc_height = float(vb[3])
            except ValueError:
                pass  # malformed viewBox — keep width/height derived values

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
            "id":              el.get("id", ""),
            "tag":             tag,
            "layer_path":      layer_path,
            "transforms":      _collect_transforms(el),
            "stroke":          stroke,
            "stroke_width":    stroke_width,
            "stroke_width_px": stroke_width_px,
            "fill":            fill,
            "opacity":         opacity,
            "display":         display,
            "visibility":      visibility,
            "element_class":   "unknown",
            "is_structural":   False,
            "is_grid":         False,
            "is_sheet_border": False,
            "is_title_block":  False,
            "coords":          coords,
            "raw_attribs":     dict(el.attrib),
        }
        all_elements.append(record)

    print(f"[Stage 1] Collected {len(all_elements)} raw elements")

    # ── PASS 2: geometric grid detection ─────────────────────────────────────
    try:
        from grid_detector import mark_grid_elements
        all_elements = mark_grid_elements(all_elements, doc_width, doc_height)
        geom_grid_count = sum(1 for e in all_elements if e.get("is_grid", False))
        print(f"[Stage 1] Geometric detection found {geom_grid_count} grid lines")
    except ImportError as exc:
        print(f"[Stage 1] Warning: grid_detector not available: {exc}")
    except Exception as exc:
        print(f"[Stage 1] Warning: grid_detector error: {exc}")

    # ── PASS 3 & 4: filter, tag, classify ────────────────────────────────────
    final_elements:      list[dict] = []
    dropped_count        = 0
    dropped_by_border    = 0
    dropped_by_geometry  = 0
    dropped_by_layer_col = 0
    title_block_count    = 0
    structural_count     = 0

    for el in all_elements:
        should_drop = False

        # ── Priority 0: sheet-border frame ───────────────────────────────────
        # Checked BEFORE layer/color rules — border lines often have no special
        # layer name and a neutral (black) stroke.
        if _is_sheet_border(el, doc_width, doc_height):
            el["is_sheet_border"] = True
            should_drop            = True
            dropped_by_border     += 1

        # ── Priority 1: geometric grid ────────────────────────────────────────
        elif el.get("is_grid", False):
            should_drop           = True
            dropped_by_geometry  += 1

        # ── Priority 2: layer name / stroke color ─────────────────────────────
        elif _should_drop_by_layer(el.get("layer_path", [])):
            should_drop            = True
            dropped_by_layer_col  += 1
        elif _should_drop_by_color(el.get("stroke", "")):
            should_drop            = True
            dropped_by_layer_col  += 1

        if should_drop:
            dropped_count += 1
            continue

        # ── Title-block tagging (keep but skip structural logic) ──────────────
        if _is_title_block_element(el, doc_width):
            el["is_title_block"] = True
            title_block_count   += 1
            final_elements.append(el)
            continue

        # ── Structural classification ─────────────────────────────────────────
        is_structural = False

        layer_lower = " ".join(el.get("layer_path", [])).lower()
        for hint in STRUCTURAL_LAYER_HINTS:
            if hint in layer_lower:
                is_structural = True
                break

        # Thickness heuristic: only promote via stroke width when no layer hint.
        # Interior thin lines (door swings, fixtures, window markers) are kept
        # as non-structural and are NEVER dropped here.
        if not is_structural and el.get("stroke_width_px", 0) >= WALL_SW_MIN:
            is_structural = True

        el["is_structural"] = is_structural
        el["element_class"] = "structural" if is_structural else "non_structural"

        if is_structural:
            structural_count += 1

        final_elements.append(el)

    non_structural_count = len(final_elements) - structural_count - title_block_count

    print(f"[Stage 1] Final: {len(final_elements)} elements kept")
    print(f"[Stage 1]   Dropped — sheet border:       {dropped_by_border}")
    print(f"[Stage 1]   Dropped — geometry (grid):    {dropped_by_geometry}")
    print(f"[Stage 1]   Dropped — layer/color:        {dropped_by_layer_col}")
    print(f"[Stage 1]   Title block (kept, flagged):  {title_block_count}")
    print(f"[Stage 1]   Structural:                   {structural_count}")
    print(f"[Stage 1]   Non-structural:               {non_structural_count}")

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