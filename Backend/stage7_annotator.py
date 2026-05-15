"""
Stage 7 — SVG Annotator
Takes the original SVG plus analysis results from stages 5 and 6,
strips grid elements from the source SVG tree, then writes an annotated SVG.

KEY FIX: annotate_svg() re-parses the original source SVG as its visual base.
This means grid lines that were filtered by the pipeline would re-appear.
Fix: before appending annotation layers, walk the parsed SVG tree and remove
any element that matches the same grid detection rules used in stage1_parser
(layer name, stroke color, geometry spacing).
"""

from __future__ import annotations
import math
import re
import colorsys
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Any


SVG_NS = "http://www.w3.org/2000/svg"

# ─────────────────────────────────────────────────────────────────────────────
# Grid detection — mirrors stage1_parser rules exactly
# ─────────────────────────────────────────────────────────────────────────────

GRID_STROKE_COLORS: set[str] = {
    "#0000ff", "#0000cd", "#00008b", "blue",
    "#0070c0", "#0078d7", "#0080ff", "#0060a0",
    "#00b0f0", "#4472c4", "#2e75b6", "#1f497d",
    "#5b9bd5", "#2f5496", "#17375e",
    "#00ffff", "#00cdcd", "cyan", "aqua",
}

GRID_LAYER_KEYWORDS = {
    "grid", "grille", "axis", "axes", "eje", "achse",
    "gridline", "grid line", "a grid", "s grid",
    "structural grid", "ref line", "setout", "set out",
    "setting out", "referenceline", "bubbles",
    "grid bubble", "column bubble",
}

GEOMETRY_TAGS = {"line", "polyline", "polygon", "rect", "circle", "ellipse", "path"}

# Minimum line length to consider for geometry-based grid detection (SVG units)
MIN_LINE_LENGTH = 50.0
# Minimum number of evenly-spaced parallel lines to declare a grid axis
MIN_GRID_LINES  = 3
# Max coefficient of variation for spacing to be "regular"
REGULARITY_CV   = 0.12
# Coordinate bucket for snapping (SVG units)
COORD_BUCKET    = 2.0


def _local_tag(el: ET.Element) -> str:
    tag = el.tag
    if isinstance(tag, str) and "}" in tag:
        return tag.split("}", 1)[1]
    return tag or ""


def _parse_style(style_str: str) -> dict[str, str]:
    result: dict[str, str] = {}
    for part in (style_str or "").split(";"):
        if ":" in part:
            k, v = part.split(":", 1)
            result[k.strip()] = v.strip()
    return result


def _get_attr(el: ET.Element, attr: str) -> str:
    style = _parse_style(el.get("style", ""))
    return style.get(attr) or el.get(attr) or ""


def _ancestor_ids(el: ET.Element, root: ET.Element) -> list[str]:
    """Collect group id/label values from ancestors."""
    ids: list[str] = []
    # ET doesn't have parent pointers — we pre-build a parent map
    # This is called with the parent_map already built; we use the
    # _parent_map injected as a closure in _remove_grid_elements.
    return ids


def _color_is_grid(stroke: str) -> bool:
    if not stroke or stroke in ("none", "inherit", "currentColor", ""):
        return False
    s = stroke.lower().strip()
    if re.match(r"^#[0-9a-f]{3}$", s):
        s = "#" + s[1]*2 + s[2]*2 + s[3]*2
    if s in GRID_STROKE_COLORS:
        return True
    m = re.match(r"rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)", s)
    if m:
        r, g, b = int(m.group(1)), int(m.group(2)), int(m.group(3))
        if f"#{r:02x}{g:02x}{b:02x}" in GRID_STROKE_COLORS:
            return True
        if b > 150 and b > r * 2 and b > g * 2:
            return True
    return False


def _layer_is_grid(layer_names: list[str]) -> bool:
    combined = re.sub(r"[-_.]", " ", " ".join(layer_names).lower())
    for kw in GRID_LAYER_KEYWORDS:
        if kw in combined:
            return True
    return False


def _get_line_endpoints(el: ET.Element, tag: str) -> tuple[tuple, tuple] | None:
    """Extract (start, end) for simple straight-line elements."""
    try:
        if tag == "line":
            return (
                (float(el.get("x1", 0)), float(el.get("y1", 0))),
                (float(el.get("x2", 0)), float(el.get("y2", 0))),
            )
        if tag in ("polyline", "polygon"):
            raw = el.get("points", "")
            nums = [float(n) for n in re.split(r"[\s,]+", raw.strip()) if n]
            if len(nums) == 4:
                return (nums[0], nums[1]), (nums[2], nums[3])
    except (ValueError, TypeError):
        pass
    return None


def _is_regular_spacing(coords: list[float]) -> bool:
    unique = sorted(set(round(c / COORD_BUCKET) * COORD_BUCKET for c in coords))
    if len(unique) < MIN_GRID_LINES:
        return False
    gaps = [unique[i+1] - unique[i] for i in range(len(unique) - 1)]
    mean = sum(gaps) / len(gaps)
    if mean < 1.0:
        return False
    variance = sum((g - mean) ** 2 for g in gaps) / len(gaps)
    cv = math.sqrt(variance) / mean
    return cv < REGULARITY_CV


def _remove_grid_elements(root: ET.Element) -> int:
    """
    Walk the SVG tree and remove elements that are grid lines.
    Uses three methods matching stage1_parser:
      1. Ancestor group id/label contains grid keyword
      2. Stroke color matches known grid colors
      3. Elements form evenly-spaced H or V families (geometry heuristic)

    Returns count of removed elements.
    """
    # Build parent map so we can walk ancestry
    parent_map: dict[ET.Element, ET.Element] = {}
    for parent in root.iter():
        for child in parent:
            parent_map[child] = parent

    def get_ancestor_names(el: ET.Element) -> list[str]:
        names = []
        cur = parent_map.get(el)
        while cur is not None:
            tag = _local_tag(cur)
            if tag == "g":
                gid = cur.get("id", "") or cur.get(
                    "{http://www.inkscape.org/namespaces/inkscape}label", ""
                )
                if gid:
                    names.append(gid)
            cur = parent_map.get(cur)
        return names

    # ── Pass 1: remove by layer name and stroke color ─────────────────────────
    to_remove: list[tuple[ET.Element, ET.Element]] = []  # (element, parent)

    for el in root.iter():
        tag = _local_tag(el)
        if tag not in GEOMETRY_TAGS:
            continue

        ancestor_names = get_ancestor_names(el)

        # Method 1: layer name
        if _layer_is_grid(ancestor_names):
            parent = parent_map.get(el)
            if parent is not None:
                to_remove.append((el, parent))
            continue

        # Method 2: stroke color
        stroke = _get_attr(el, "stroke")
        if _color_is_grid(stroke):
            parent = parent_map.get(el)
            if parent is not None:
                to_remove.append((el, parent))

    removed_set: set[ET.Element] = set()
    for el, parent in to_remove:
        if el not in removed_set:
            try:
                parent.remove(el)
                removed_set.add(el)
            except ValueError:
                pass

    # ── Pass 2: geometry heuristic — evenly-spaced H/V lines ─────────────────
    # Collect remaining line elements and bucket by axis coordinate
    from collections import defaultdict
    h_buckets: dict[float, list[tuple[ET.Element, ET.Element]]] = defaultdict(list)
    v_buckets: dict[float, list[tuple[ET.Element, ET.Element]]] = defaultdict(list)

    for el in root.iter():
        if el in removed_set:
            continue
        tag = _local_tag(el)
        if tag not in GEOMETRY_TAGS:
            continue

        pts = _get_line_endpoints(el, tag)
        if pts is None:
            continue

        (x1, y1), (x2, y2) = pts
        length = math.hypot(x2 - x1, y2 - y1)
        if length < MIN_LINE_LENGTH:
            continue

        dx, dy = x2 - x1, y2 - y1
        angle = abs(math.degrees(math.atan2(dy, dx)))
        is_h = angle <= 0.5 or angle >= 179.5
        is_v = abs(angle - 90.0) <= 0.5

        parent = parent_map.get(el)
        if parent is None:
            continue

        if is_h:
            y_mid = (y1 + y2) / 2.0
            y_key = round(y_mid / COORD_BUCKET) * COORD_BUCKET
            h_buckets[y_key].append((el, parent))
        elif is_v:
            x_mid = (x1 + x2) / 2.0
            x_key = round(x_mid / COORD_BUCKET) * COORD_BUCKET
            v_buckets[x_key].append((el, parent))

    geom_removed = 0

    if _is_regular_spacing(list(h_buckets.keys())):
        for els in h_buckets.values():
            for el, parent in els:
                if el not in removed_set:
                    try:
                        parent.remove(el)
                        removed_set.add(el)
                        geom_removed += 1
                    except ValueError:
                        pass

    if _is_regular_spacing(list(v_buckets.keys())):
        for els in v_buckets.values():
            for el, parent in els:
                if el not in removed_set:
                    try:
                        parent.remove(el)
                        removed_set.add(el)
                        geom_removed += 1
                    except ValueError:
                        pass

    total = len(removed_set)
    if total:
        print(f"[Stage 7] Removed {total} grid elements from source SVG "
              f"({total - geom_removed} by layer/color, {geom_removed} by geometry)")
    else:
        print("[Stage 7] No grid elements found in source SVG to remove")

    return total


# ─────────────────────────────────────────────────────────────────────────────
# Color utilities
# ─────────────────────────────────────────────────────────────────────────────

def _hsv_palette(n: int, saturation: float = 0.55, value: float = 0.88) -> list[str]:
    colors = []
    for i in range(max(n, 1)):
        h = i / max(n, 1)
        r, g, b = colorsys.hsv_to_rgb(h, saturation, value)
        colors.append(f"#{int(r*255):02x}{int(g*255):02x}{int(b*255):02x}")
    return colors


ORIENTATION_COLORS = {
    "H": "#2563eb",   # blue
    "V": "#dc2626",   # red
    "D": "#16a34a",   # green
}


# ─────────────────────────────────────────────────────────────────────────────
# SVG element builders
# ─────────────────────────────────────────────────────────────────────────────

def _el(tag: str, **attribs) -> ET.Element:
    el = ET.Element(f"{{{SVG_NS}}}{tag}")
    for k, v in attribs.items():
        el.set(k.replace("_", "-"), str(v))
    return el


def _text_el(
    x: float, y: float, text: str,
    font_size: float = 8,
    fill: str = "#111",
    anchor: str = "middle",
    weight: str = "normal",
    bg: str = "white",
) -> list[ET.Element]:
    char_w = font_size * 0.58
    w = len(text) * char_w + 6
    h = font_size + 5
    rect = _el("rect",
        x=x - w/2, y=y - h + 2,
        width=w, height=h,
        fill=bg, opacity="0.80", rx="2",
    )
    txt = _el("text",
        x=x, y=y,
        font_size=font_size,
        font_family="monospace",
        font_weight=weight,
        fill=fill,
        text_anchor=anchor,
        dominant_baseline="auto",
    )
    txt.text = text
    return [rect, txt]


# ─────────────────────────────────────────────────────────────────────────────
# ViewBox parser
# ─────────────────────────────────────────────────────────────────────────────

def _parse_viewbox(root: ET.Element) -> tuple[float, float, float, float]:
    vb = root.get("viewBox", "")
    if vb:
        parts = vb.split()
        if len(parts) == 4:
            return tuple(float(p) for p in parts)  # type: ignore[return-value]

    def _dim(s: str) -> float:
        if not s:
            return 800.0
        s = s.strip().lower().replace("px","").replace("pt","").replace("mm","")
        try:
            return float(s)
        except ValueError:
            return 800.0

    w = _dim(root.get("width", "800"))
    h = _dim(root.get("height", "600"))
    return 0.0, 0.0, w, h


# ─────────────────────────────────────────────────────────────────────────────
# ClipPath builder
# ─────────────────────────────────────────────────────────────────────────────

def _build_clip_path(vb_x: float, vb_y: float, vb_w: float, vb_h: float,
                     clip_id: str = "annot-clip") -> ET.Element:
    defs = _el("defs")
    cp = _el("clipPath", id=clip_id)
    rect = _el("rect", x=vb_x, y=vb_y, width=vb_w, height=vb_h)
    cp.append(rect)
    defs.append(cp)
    return defs


# ─────────────────────────────────────────────────────────────────────────────
# Annotation layers
# ─────────────────────────────────────────────────────────────────────────────

def _room_fill_layer(
    rooms: list[dict],
    groups: list[dict],
    palette: list[str],
    clip_id: str = "annot-clip",
) -> ET.Element:
    face_color: dict[int, str] = {}
    for i, grp in enumerate(groups):
        color = palette[i % len(palette)]
        for inst in grp["instances"]:
            face_color[inst["face_id"]] = color

    layer = _el("g", id="layer-rooms", opacity="0.18",
                clip_path=f"url(#{clip_id})")
    for room in rooms:
        fid = room["face_id"]
        color = face_color.get(fid, "#aaaaaa")
        pts_str = " ".join(f"{x:.3f},{y:.3f}" for x, y in room["vertices"])
        poly = _el("polygon",
            points=pts_str,
            fill=color,
            stroke=color,
            stroke_width="0.5",
        )
        layer.append(poly)
    return layer


def _room_label_layer(
    rooms: list[dict],
    groups: list[dict],
    font_size: float = 10,
    clip_id: str = "annot-clip",
) -> ET.Element:
    face_group: dict[int, int] = {}
    for grp in groups:
        for inst in grp["instances"]:
            face_group[inst["face_id"]] = grp["group_id"]

    layer = _el("g", id="layer-room-labels", clip_path=f"url(#{clip_id})")
    for room in rooms:
        cx, cy = room["centroid"]
        fid = room["face_id"]
        gid = face_group.get(fid, 0)
        area = room.get("area", 0)
        label    = f"R{fid:02d}"
        sublabel = f"A={area:.0f} G{gid}"
        for el in _text_el(cx, cy - font_size/2, label,
                           font_size=font_size, weight="bold"):
            layer.append(el)
        for el in _text_el(cx, cy + font_size, sublabel,
                           font_size=font_size * 0.75, fill="#444"):
            layer.append(el)
    return layer


def _wall_highlight_layer(
    walls: list[dict],
    stroke_width: float = 1.5,
    clip_id: str = "annot-clip",
) -> ET.Element:
    layer = _el("g", id="layer-walls",
                stroke_width=str(stroke_width),
                fill="none", opacity="0.65",
                clip_path=f"url(#{clip_id})")
    for w in walls:
        sx, sy = w["start"]
        ex, ey = w["end"]
        color = ORIENTATION_COLORS.get(w["orientation"], "#888")
        seg = _el("line",
            x1=sx, y1=sy, x2=ex, y2=ey,
            stroke=color,
            stroke_width=str(stroke_width),
        )
        layer.append(seg)
    return layer


def _wall_label_layer(
    walls: list[dict],
    font_size: float = 6,
    clip_id: str = "annot-clip",
) -> ET.Element:
    layer = _el("g", id="layer-wall-labels", clip_path=f"url(#{clip_id})")
    for w in walls:
        sx, sy = w["start"]
        ex, ey = w["end"]
        mx, my = (sx + ex) / 2, (sy + ey) / 2
        label  = f"{w['wall_id']} {w['length']:.1f}{w['orientation']}"
        angle  = w.get("angle_deg", 0)
        if 90 < angle <= 270:
            angle -= 180
        g = _el("g", transform=f"rotate({angle:.1f},{mx:.3f},{my:.3f})")
        for el in _text_el(mx, my, label, font_size=font_size, fill="#1e3a5f"):
            g.append(el)
        layer.append(g)
    return layer


def _legend_layer(
    groups: list[dict],
    palette: list[str],
    vb_x: float = 0,
    vb_y: float = 0,
    vb_w: float = 800,
    vb_h: float = 600,
) -> ET.Element:
    layer = _el("g", id="layer-legend")

    scale  = max(vb_w, vb_h) / 800.0
    fs     = max(6, round(9 * scale))
    row_h  = fs + 6
    box_w  = 170 * scale
    n_rows = min(len(groups), 12)
    box_h  = n_rows * row_h + 28 * scale

    x = vb_x + vb_w * 0.01
    y = vb_y + vb_h * 0.01

    bg = _el("rect",
        x=x, y=y,
        width=box_w, height=box_h,
        fill="white", opacity="0.88",
        stroke="#bbb", stroke_width=str(max(0.3, 0.5 * scale)),
        rx=str(3 * scale),
    )
    layer.append(bg)

    title = _el("text",
        x=x + 8 * scale, y=y + 16 * scale,
        font_size=str(fs + 1),
        font_weight="bold",
        fill="#111",
        font_family="monospace",
    )
    title.text = "Shape Groups"
    layer.append(title)

    for i, grp in enumerate(groups[:12]):
        color = palette[i % len(palette)]
        ry = y + 26 * scale + i * row_h
        sw = max(0.5, 10 * scale)
        sh = max(0.5, 10 * scale)
        swatch = _el("rect",
            x=x + 8 * scale, y=ry - sh * 0.8,
            width=sw, height=sh,
            fill=color, rx=str(2 * scale),
        )
        lbl = _el("text",
            x=x + 22 * scale, y=ry + 1,
            font_size=str(fs - 1),
            fill="#222",
            font_family="monospace",
        )
        area_val = grp["template"].get("area", 0)
        lbl.text = f"G{grp['group_id']}: {grp['count']}×  area≈{area_val:.0f}"
        layer.append(swatch)
        layer.append(lbl)

    return layer


# ─────────────────────────────────────────────────────────────────────────────
# Main annotator
# ─────────────────────────────────────────────────────────────────────────────

def annotate_svg(
    source_svg_path: str,
    rooms: list[dict],
    walls: list[dict],
    groups: list[dict],
    output_path: str,
    show_wall_labels: bool = False,
    show_room_labels: bool = True,
    show_legend:      bool = True,
) -> None:
    if not rooms:
        print("[Stage 7] WARNING: No rooms to annotate — SVG will only show wall highlights")
    if not walls:
        print("[Stage 7] WARNING: No walls to annotate")

    ET.register_namespace("", SVG_NS)
    ET.register_namespace("xlink", "http://www.w3.org/1999/xlink")

    tree = ET.parse(source_svg_path)
    root = tree.getroot()

    # ── KEY FIX: strip grid elements from the source SVG tree ─────────────────
    # The annotator re-parses the original file as its visual base, so grid
    # lines would re-appear even after pipeline filtering. Remove them here
    # using the same rules as stage1_parser before appending any annotations.
    print("[Stage 7] Stripping grid elements from source SVG...")
    _remove_grid_elements(root)

    # Parse viewBox
    vb_x, vb_y, vb_w, vb_h = _parse_viewbox(root)
    print(f"[Stage 7] ViewBox: x={vb_x} y={vb_y} w={vb_w} h={vb_h}")

    wall_sw = max(0.3, min(2.0, vb_w / 700.0))
    palette = _hsv_palette(max(len(groups), 1))
    clip_id = "annot-clip"

    defs = _build_clip_path(vb_x, vb_y, vb_w, vb_h, clip_id)
    root.insert(0, defs)

    root.append(_room_fill_layer(rooms, groups, palette, clip_id))
    root.append(_wall_highlight_layer(walls, stroke_width=wall_sw, clip_id=clip_id))

    if show_room_labels and rooms:
        fs = max(6, vb_w / 120)
        root.append(_room_label_layer(rooms, groups, font_size=fs, clip_id=clip_id))

    if show_wall_labels and walls:
        fs = max(4, vb_w / 200)
        root.append(_wall_label_layer(walls, font_size=fs, clip_id=clip_id))

    if show_legend and groups:
        root.append(_legend_layer(groups, palette, vb_x, vb_y, vb_w, vb_h))

    tree.write(output_path, xml_declaration=True, encoding="unicode")
    print(f"[Stage 7] Annotated SVG written → {output_path}")
    print(f"[Stage 7]   Rooms annotated  : {len(rooms)}")
    print(f"[Stage 7]   Walls highlighted: {len(walls)}")
    print(f"[Stage 7]   Wall labels shown: {show_wall_labels}")


# ─────────────────────────────────────────────────────────────────────────────
# Standalone SVG generator (for testing without original)
# ─────────────────────────────────────────────────────────────────────────────

def generate_standalone_svg(
    rooms: list[dict],
    walls: list[dict],
    groups: list[dict],
    output_path: str,
    viewbox: str = "0 0 1000 800",
) -> None:
    ET.register_namespace("", SVG_NS)
    root = ET.Element(f"{{{SVG_NS}}}svg")
    root.set("xmlns", SVG_NS)
    root.set("viewBox", viewbox)
    vb_parts = viewbox.split()
    root.set("width",  vb_parts[2])
    root.set("height", vb_parts[3])

    vb_x, vb_y, vb_w, vb_h = (float(p) for p in vb_parts)
    clip_id = "annot-clip"

    bg = _el("rect", x=vb_x, y=vb_y, width=vb_w, height=vb_h, fill="white")
    root.append(bg)

    defs = _build_clip_path(vb_x, vb_y, vb_w, vb_h, clip_id)
    root.insert(0, defs)

    palette = _hsv_palette(max(len(groups), 1))
    wall_sw = max(0.3, min(2.0, vb_w / 700.0))
    fs_room = max(6, vb_w / 120)

    root.append(_room_fill_layer(rooms, groups, palette, clip_id))
    root.append(_wall_highlight_layer(walls, stroke_width=wall_sw, clip_id=clip_id))
    root.append(_room_label_layer(rooms, groups, font_size=fs_room, clip_id=clip_id))
    root.append(_wall_label_layer(walls, font_size=max(4, vb_w / 200), clip_id=clip_id))
    if groups:
        root.append(_legend_layer(groups, palette, vb_x, vb_y, vb_w, vb_h))

    ET.ElementTree(root).write(output_path, xml_declaration=True, encoding="unicode")
    print(f"[Stage 7] Standalone SVG written → {output_path}")


# ─────────────────────────────────────────────────────────────────────────────
# CLI
# ─────────────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import sys
    from stage1_parser        import parse_svg
    from stage2_flattener     import flatten_transforms
    from stage3_normalizer    import normalize_geometry
    from stage4_snapper       import snap_and_clean
    from stage5_room_detector import detect_rooms_and_walls
    from stage6_shape_matcher import find_repetitive_shapes

    svg_in  = sys.argv[1] if len(sys.argv) > 1 else "input.svg"
    svg_out = sys.argv[2] if len(sys.argv) > 2 else "output_annotated.svg"

    _, elements = parse_svg(svg_in)
    flat    = flatten_transforms(elements)
    normed  = normalize_geometry(flat)
    cleaned = snap_and_clean(normed)
    rooms, walls = detect_rooms_and_walls(cleaned)
    groups  = find_repetitive_shapes(rooms)

    annotate_svg(svg_in, rooms, walls, groups, svg_out)
    print("Done. Open", svg_out, "in a browser.")