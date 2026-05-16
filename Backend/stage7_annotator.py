"""
Stage 7 — SVG Annotator
========================
Reads the original SVG and overlays:
  • Coloured face fills (one colour per shape_type)
  • Centroid labels (face_id + shape_type)
  • Wall labels (wall_id + length, optional)
  • Legend

All overlays go into a new <g id="floor-plan-annotations"> group appended
to the SVG root so the original geometry is untouched underneath.

Colour scheme (semi-transparent fills)
---------------------------------------
  room        #4A90D9  blue
  corridor    #7ED321  green
  pillar      #D0021B  red
  window      #9B59B6  purple
  door_swing  #F5A623  orange
  furniture   #50E3C2  teal
  fixture     #E91E63  pink
  void        #AAAAAA  grey
"""

from __future__ import annotations
import math
import re
from pathlib import Path
from typing import Any

try:
    from lxml import etree
    HAS_LXML = True
except ImportError:
    HAS_LXML = False

SVG_NS  = "http://www.w3.org/2000/svg"
XLINK   = "http://www.w3.org/1999/xlink"

FACE_COLORS = {
    "room":       ("#4A90D9", 0.18),
    "corridor":   ("#7ED321", 0.22),
    "pillar":     ("#D0021B", 0.40),
    "window":     ("#9B59B6", 0.35),
    "door_swing": ("#F5A623", 0.35),
    "furniture":  ("#50E3C2", 0.30),
    "fixture":    ("#E91E63", 0.38),
    "void":       ("#AAAAAA", 0.20),
}

LABEL_FONT_SIZE = 8    # px — scales with SVG viewBox, not screen pixels
WALL_FONT_SIZE  = 5


def _rgba(hex_color: str, alpha: float) -> str:
    h = hex_color.lstrip("#")
    r, g, b = int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)
    return f"rgba({r},{g},{b},{alpha:.2f})"


def _poly_to_points_str(vertices: list[tuple]) -> str:
    return " ".join(f"{x:.2f},{y:.2f}" for x, y in vertices)


def _estimate_font_size(bbox: dict, base: float = LABEL_FONT_SIZE) -> float:
    """Scale font to fit inside the face bbox."""
    min_dim = min(bbox.get("width", 1), bbox.get("height", 1))
    return max(3.0, min(base, min_dim / 8.0))


def _svg_text(parent, x: float, y: float, text: str,
              font_size: float = LABEL_FONT_SIZE,
              fill: str = "#000000",
              anchor: str = "middle",
              weight: str = "normal") -> None:
    t = etree.SubElement(parent, f"{{{SVG_NS}}}text")
    t.set("x", f"{x:.2f}")
    t.set("y", f"{y:.2f}")
    t.set("font-size",    f"{font_size:.1f}")
    t.set("fill",         fill)
    t.set("text-anchor",  anchor)
    t.set("font-family",  "monospace, sans-serif")
    t.set("font-weight",  weight)
    t.set("pointer-events", "none")
    t.text = text


# ─────────────────────────────────────────────────────────────────────────────
# Legend
# ─────────────────────────────────────────────────────────────────────────────

def _draw_legend(parent, x0: float, y0: float, rooms: list[dict],
                 groups: list[dict]) -> None:
    """Draw a compact legend in the top-left corner of the annotations layer."""
    # Background
    bg = etree.SubElement(parent, f"{{{SVG_NS}}}rect")
    bg.set("x",      f"{x0:.1f}")
    bg.set("y",      f"{y0:.1f}")
    bg.set("width",  "160")
    bg.set("height", f"{len(FACE_COLORS) * 14 + 20:.1f}")
    bg.set("fill",   "white")
    bg.set("fill-opacity", "0.85")
    bg.set("stroke", "#999")
    bg.set("stroke-width", "0.5")
    bg.set("rx", "3")

    # Title
    _svg_text(parent, x0 + 80, y0 + 11, "FLOOR PLAN ANALYSIS",
              font_size=7, fill="#333", weight="bold")

    # Count faces per type
    type_counts: dict[str, int] = {}
    for f in rooms:
        t = f.get("shape_type", "void")
        type_counts[t] = type_counts.get(t, 0) + 1

    row_y = y0 + 20
    for shape_type, (color, alpha) in FACE_COLORS.items():
        count = type_counts.get(shape_type, 0)
        if count == 0:
            continue

        # Color swatch
        swatch = etree.SubElement(parent, f"{{{SVG_NS}}}rect")
        swatch.set("x",      f"{x0 + 5:.1f}")
        swatch.set("y",      f"{row_y - 7:.1f}")
        swatch.set("width",  "10")
        swatch.set("height", "8")
        swatch.set("fill",   color)
        swatch.set("fill-opacity", f"{alpha + 0.3:.2f}")
        swatch.set("stroke", "#666")
        swatch.set("stroke-width", "0.3")

        # Label
        _svg_text(parent, x0 + 20, row_y,
                  f"{shape_type}  ({count})",
                  font_size=6, fill="#222", anchor="start")
        row_y += 14


# ─────────────────────────────────────────────────────────────────────────────
# Main annotator
# ─────────────────────────────────────────────────────────────────────────────

def annotate_svg(
    svg_in: str,
    rooms: list[dict],
    walls: list[dict],
    groups: list[dict],
    svg_out: str,
    show_wall_labels: bool = True,
    show_room_labels: bool = True,
    show_legend: bool = True,
) -> None:
    """
    Overlay face fills, labels, wall annotations, and a legend onto the SVG.

    Parameters
    ----------
    svg_in   : path to original SVG
    rooms    : faces from stage5 + stage6 (must have shape_type)
    walls    : wall segments from stage5
    groups   : repetitive shape groups from stage6
    svg_out  : output path
    """
    if not HAS_LXML:
        print("[Stage 7] ERROR: lxml not installed — cannot write SVG")
        return

    parser = etree.XMLParser(remove_comments=False, huge_tree=True)
    try:
        tree = etree.parse(str(svg_in), parser)
    except Exception as ex:
        print(f"[Stage 7] Failed to parse {svg_in}: {ex}")
        return

    root = tree.getroot()

    # Determine viewBox / document size for legend placement
    vb = root.get("viewBox", "")
    if vb:
        parts = vb.split()
        try:
            vb_x  = float(parts[0])
            vb_y  = float(parts[1])
            vb_w  = float(parts[2])
            vb_h  = float(parts[3])
        except (ValueError, IndexError):
            vb_x, vb_y, vb_w, vb_h = 0, 0, 1000, 1000
    else:
        try:
            vb_w = float(root.get("width",  1000))
            vb_h = float(root.get("height", 1000))
        except ValueError:
            vb_w, vb_h = 1000.0, 1000.0
        vb_x, vb_y = 0.0, 0.0

    # Create annotation group
    ann = etree.SubElement(root, f"{{{SVG_NS}}}g")
    ann.set("id", "floor-plan-annotations")
    ann.set("opacity", "1")

    # ── Face fills ──────────────────────────────────────────────────────────
    faces_g = etree.SubElement(ann, f"{{{SVG_NS}}}g")
    faces_g.set("id", "face-fills")

    for face in rooms:
        vertices = face.get("vertices", [])
        if len(vertices) < 3:
            continue

        shape_type = face.get("shape_type", "void")
        color, alpha = FACE_COLORS.get(shape_type, ("#AAAAAA", 0.20))

        poly = etree.SubElement(faces_g, f"{{{SVG_NS}}}polygon")
        poly.set("points", _poly_to_points_str(vertices))
        poly.set("fill",         color)
        poly.set("fill-opacity", f"{alpha:.2f}")
        poly.set("stroke",       color)
        poly.set("stroke-width", "0.3")
        poly.set("stroke-opacity", "0.5")
        poly.set("data-face-id",   str(face["face_id"]))
        poly.set("data-shape-type", shape_type)
        poly.set("data-area",      f"{face['area']:.1f}")
        poly.set("data-depth",     str(face.get("nesting_depth", 0)))

    # ── Room / face labels ──────────────────────────────────────────────────
    if show_room_labels:
        labels_g = etree.SubElement(ann, f"{{{SVG_NS}}}g")
        labels_g.set("id", "face-labels")

        for face in rooms:
            cx, cy = face["centroid"]
            bbox   = face["bbox"]
            fs     = _estimate_font_size(bbox, LABEL_FONT_SIZE)
            fid    = face["face_id"]
            stype  = face.get("shape_type", "void")
            area   = face["area"]

            # Only label if large enough to read
            if min(bbox.get("width", 0), bbox.get("height", 0)) < fs * 1.5:
                continue

            # White halo for readability
            halo = etree.SubElement(labels_g, f"{{{SVG_NS}}}text")
            halo.set("x", f"{cx:.2f}")
            halo.set("y", f"{cy:.2f}")
            halo.set("font-size",    f"{fs:.1f}")
            halo.set("fill",         "white")
            halo.set("text-anchor",  "middle")
            halo.set("font-family",  "monospace")
            halo.set("stroke",       "white")
            halo.set("stroke-width", f"{fs * 0.4:.1f}")
            halo.set("stroke-linejoin", "round")
            halo.set("pointer-events", "none")
            halo.text = f"F{fid}"

            _svg_text(labels_g, cx, cy, f"F{fid}", fs, "#111", weight="bold")

            # Type + area on second line
            if fs >= 5:
                _svg_text(labels_g, cx, cy + fs * 1.3,
                          f"{stype}", fs * 0.75, "#444")

    # ── Wall labels ─────────────────────────────────────────────────────────
    if show_wall_labels and walls:
        walls_g = etree.SubElement(ann, f"{{{SVG_NS}}}g")
        walls_g.set("id", "wall-labels")

        for wall in walls:
            sx, sy = wall["start"]
            ex, ey = wall["end"]
            mx = (sx + ex) / 2
            my = (sy + ey) / 2
            length = wall["length"]
            wid    = wall["wall_id"]

            if length < 10:
                continue  # too short to label

            # Perpendicular offset so label doesn't overlap the wall
            dx = ex - sx
            dy = ey - sy
            seg_len = max(math.sqrt(dx*dx + dy*dy), 0.001)
            nx = -dy / seg_len * 4
            ny =  dx / seg_len * 4

            _svg_text(walls_g,
                      mx + nx, my + ny,
                      f"W{wid} {length:.0f}",
                      font_size=WALL_FONT_SIZE,
                      fill="#666")

    # ── Legend ───────────────────────────────────────────────────────────────
    if show_legend:
        legend_g = etree.SubElement(ann, f"{{{SVG_NS}}}g")
        legend_g.set("id", "legend")
        _draw_legend(legend_g, vb_x + 5, vb_y + 5, rooms, groups)

    # ── Summary text ─────────────────────────────────────────────────────────
    summary_g = etree.SubElement(ann, f"{{{SVG_NS}}}g")
    summary_g.set("id", "summary")

    type_counts: dict[str, int] = {}
    for f in rooms:
        t = f.get("shape_type", "void")
        type_counts[t] = type_counts.get(t, 0) + 1

    summary_lines = [
        f"Faces: {len(rooms)}   Walls: {len(walls)}   Groups: {len(groups)}",
        "  ".join(f"{t}:{c}" for t, c in sorted(type_counts.items(), key=lambda x: -x[1])[:6]),
    ]
    for i, line in enumerate(summary_lines):
        _svg_text(summary_g,
                  vb_x + vb_w - 5,
                  vb_y + 10 + i * 9,
                  line,
                  font_size=6,
                  fill="#555",
                  anchor="end")

    # ── Write output ─────────────────────────────────────────────────────────
    tree.write(
        str(svg_out),
        xml_declaration=True,
        encoding="utf-8",
        pretty_print=True,
    )
    size_kb = Path(svg_out).stat().st_size / 1024
    print(f"[Stage 7] Wrote {svg_out}  ({size_kb:.1f} KB)")
    print(f"[Stage 7] Annotated: {len(rooms)} faces, {len(walls)} walls, "
          f"{len(groups)} groups")