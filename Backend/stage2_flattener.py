"""
Stage 2 — Transform Flattener
Bakes all SVG transforms (translate, rotate, scale, matrix) into absolute
coordinates so every downstream stage works in one unified coordinate space.

Handles: translate, scale, rotate (1-arg and 3-arg), skewX/Y, matrix.
Applies the full ancestor transform chain collected by stage1_parser.
"""

from __future__ import annotations
import re
import math
import copy
from typing import Any

# ─────────────────────────────────────────────────────────────────────────────
# 3×3 affine matrix helpers (stored row-major [a,b,c,d,e,f] = CSS matrix)
#   | a  c  e |
#   | b  d  f |
#   | 0  0  1 |
# ─────────────────────────────────────────────────────────────────────────────

Identity = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0]  # a,b,c,d,e,f


def _mat_mul(A: list[float], B: list[float]) -> list[float]:
    """Multiply two affine matrices A × B."""
    a1, b1, c1, d1, e1, f1 = A
    a2, b2, c2, d2, e2, f2 = B
    return [
        a1*a2 + c1*b2,
        b1*a2 + d1*b2,
        a1*c2 + c1*d2,
        b1*c2 + d1*d2,
        a1*e2 + c1*f2 + e1,
        b1*e2 + d1*f2 + f1,
    ]


def _apply(mat: list[float], x: float, y: float) -> tuple[float, float]:
    a, b, c, d, e, f = mat
    return a*x + c*y + e, b*x + d*y + f


def _parse_transform_string(t: str) -> list[float]:
    """
    Parse a single SVG transform string into a 6-element affine matrix.
    Handles chained transforms like "translate(10,20) rotate(45)".
    Returns the composed matrix (leftmost applied last, i.e. standard SVG order).
    """
    result = list(Identity)

    # Split on function boundaries
    tokens = re.findall(r'\w+\([^)]*\)', t.strip())

    for token in tokens:
        func = re.match(r'(\w+)\(([^)]*)\)', token)
        if not func:
            continue
        name = func.group(1).lower()
        args = [float(v) for v in re.split(r'[\s,]+', func.group(2).strip()) if v]

        if name == "translate":
            tx = args[0] if len(args) >= 1 else 0.0
            ty = args[1] if len(args) >= 2 else 0.0
            m = [1, 0, 0, 1, tx, ty]

        elif name == "scale":
            sx = args[0] if len(args) >= 1 else 1.0
            sy = args[1] if len(args) >= 2 else sx
            m = [sx, 0, 0, sy, 0, 0]

        elif name == "rotate":
            angle = math.radians(args[0]) if args else 0.0
            cos_a, sin_a = math.cos(angle), math.sin(angle)
            if len(args) == 3:
                cx, cy = args[1], args[2]
                # rotate around (cx,cy): T(cx,cy) · R · T(-cx,-cy)
                m = [cos_a, sin_a, -sin_a, cos_a,
                     cx - cos_a*cx + sin_a*cy,
                     cy - sin_a*cx - cos_a*cy]
            else:
                m = [cos_a, sin_a, -sin_a, cos_a, 0, 0]

        elif name == "skewx":
            angle = math.radians(args[0]) if args else 0.0
            m = [1, 0, math.tan(angle), 1, 0, 0]

        elif name == "skewy":
            angle = math.radians(args[0]) if args else 0.0
            m = [1, math.tan(angle), 0, 1, 0, 0]

        elif name == "matrix":
            if len(args) == 6:
                m = args
            else:
                continue
        else:
            continue

        result = _mat_mul(result, m)

    return result


def _compose_transforms(transform_strings: list[str]) -> list[float]:
    """
    Compose a list of transform strings (outermost → innermost order)
    into a single affine matrix.
    """
    mat = list(Identity)
    for t in transform_strings:
        m = _parse_transform_string(t)
        mat = _mat_mul(mat, m)
    return mat


# ─────────────────────────────────────────────────────────────────────────────
# Coordinate flatteners per tag
# ─────────────────────────────────────────────────────────────────────────────

def _transform_point(mat: list[float], x: float, y: float) -> tuple[float, float]:
    return _apply(mat, x, y)


def _flatten_line(coords: dict, mat: list[float]) -> dict:
    x1, y1 = _transform_point(mat, coords["x1"], coords["y1"])
    x2, y2 = _transform_point(mat, coords["x2"], coords["y2"])
    return {"x1": x1, "y1": y1, "x2": x2, "y2": y2}


def _flatten_points(coords: dict, mat: list[float]) -> dict:
    new_pts = [_transform_point(mat, px, py) for px, py in coords["points"]]
    out = {"points": new_pts}
    if coords.get("closed"):
        out["closed"] = True
    return out


def _flatten_rect(coords: dict, mat: list[float]) -> dict:
    """
    Convert rect to 4 corner points (loses rx/ry rounding but gains uniformity).
    Marks as 'rect_origin' for later geometry stages that need to know.
    """
    x, y, w, h = coords["x"], coords["y"], coords["width"], coords["height"]
    corners = [(x, y), (x+w, y), (x+w, y+h), (x, y+h)]
    new_pts = [_transform_point(mat, px, py) for px, py in corners]
    return {
        "points": new_pts,
        "closed": True,
        "rect_origin": True,
        "rx": coords.get("rx", 0),
        "ry": coords.get("ry", 0),
    }


def _flatten_circle(coords: dict, mat: list[float]) -> dict:
    cx, cy = _transform_point(mat, coords["cx"], coords["cy"])
    # radius scaling: use average of x/y scale (handles uniform scale only)
    a, b, c, d = mat[0], mat[1], mat[2], mat[3]
    sx = math.sqrt(a*a + b*b)
    sy = math.sqrt(c*c + d*d)
    r = coords["r"] * (sx + sy) / 2.0
    return {"cx": cx, "cy": cy, "r": r, "circle_origin": True}


def _flatten_ellipse(coords: dict, mat: list[float]) -> dict:
    cx, cy = _transform_point(mat, coords["cx"], coords["cy"])
    a, b, c, d = mat[0], mat[1], mat[2], mat[3]
    sx = math.sqrt(a*a + b*b)
    sy = math.sqrt(c*c + d*d)
    return {
        "cx": cx, "cy": cy,
        "rx": coords["rx"] * sx,
        "ry": coords["ry"] * sy,
        "ellipse_origin": True,
    }


def _flatten_path(coords: dict, mat: list[float]) -> dict:
    """
    For paths we store the raw d-string and the baked matrix so
    Stage 3 (normalizer) can convert it using svgpathtools with the matrix.
    """
    return {
        "d": coords["d"],
        "baked_matrix": mat,
        "path_origin": True,
    }


FLATTENNERS = {
    "line":     _flatten_line,
    "polyline": _flatten_points,
    "polygon":  _flatten_points,
    "rect":     _flatten_rect,
    "circle":   _flatten_circle,
    "ellipse":  _flatten_ellipse,
    "path":     _flatten_path,
}


# ─────────────────────────────────────────────────────────────────────────────
# Public API
# ─────────────────────────────────────────────────────────────────────────────

def flatten_transforms(elements: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """
    Takes the element list from stage1_parser.parse_svg() and returns a new
    list where all transforms have been baked into absolute coordinates.
    The 'transforms' field is replaced with 'baked_matrix' (6-element list).
    """
    result: list[dict[str, Any]] = []

    for el in elements:
        el_out = copy.deepcopy(el)

        # Compose full ancestor + element transform chain
        mat = _compose_transforms(el["transforms"])
        el_out["baked_matrix"] = mat
        del el_out["transforms"]

        # Flatten coordinates
        tag = el["tag"]
        flattener = FLATTENNERS.get(tag)
        if flattener:
            el_out["coords"] = flattener(el["coords"], mat)
        # else: unknown tag, leave coords as-is

        result.append(el_out)

    print(f"[Stage 2] Flattened transforms for {len(result)} elements")
    return result


# ─────────────────────────────────────────────────────────────────────────────
# Utility: inspect baked matrix stats
# ─────────────────────────────────────────────────────────────────────────────

def matrix_summary(elements: list[dict[str, Any]]) -> dict[str, Any]:
    """Report unique matrix types seen after flattening."""
    identity_count = 0
    translate_only = 0
    complex_count  = 0
    for el in elements:
        m = el.get("baked_matrix", [1,0,0,1,0,0])
        a, b, c, d, e, f = m
        if abs(a-1)<1e-9 and abs(b)<1e-9 and abs(c)<1e-9 and abs(d-1)<1e-9:
            if abs(e)<1e-9 and abs(f)<1e-9:
                identity_count += 1
            else:
                translate_only += 1
        else:
            complex_count += 1
    return {
        "identity": identity_count,
        "translate_only": translate_only,
        "complex_transform": complex_count,
    }


if __name__ == "__main__":
    import sys, json
    from stage1_parser import parse_svg
    path = sys.argv[1] if len(sys.argv) > 1 else "input.svg"
    _, elements = parse_svg(path)
    flat = flatten_transforms(elements)
    print("Matrix summary:", matrix_summary(flat))
    print("First 2 flat elements:")
    for e in flat[:2]:
        print(json.dumps({k: v for k, v in e.items() if k not in ("raw_attribs",)}, indent=2))