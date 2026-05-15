"""
semantic_detector.py — Semantic Annotation Detector  (v4)
==========================================================
Root-cause fix vs all previous versions
-----------------------------------------
Previous versions analysed bounding boxes in RAW (pre-transform) coordinates.
This SVG's root group has:

    transform="matrix(1.3333333,0,0,-1.3333333,0,1121.3333)"

which FLIPS the y-axis and scales by 1.333. In raw coords:
  • The title block (y=12..141) appears near the TOP
  • The legend box (y=141..261) appears in the upper-left middle
  • The document border (1170x821 in a 1587x1121 viewbox) = only 73% coverage

After applying the transform to SCREEN SPACE:
  • Title block → bottom-right corner  (nx=0.84, ny=0.91)  → corner rule ✓
  • Legend box  → bottom-left corner   (nx=0.08, ny=0.85)  → corner rule ✓
  • Doc border  → 98% coverage                              → border rule ✓
  • North arrow → bottom-centre        (ny=0.91)            → bottom strip ✓

v4 computes SCREEN-SPACE bboxes by applying each element's full transform
chain before any spatial rule. Raw coords are still used for per-element
geometry heuristics (scale-bar thinness, swatch area) since those compare
relative dimensions unaffected by flip/scale.

API: mark_semantic_annotations(elements, doc_width, doc_height) → elements
     (same contract as all previous versions)
"""

from __future__ import annotations

import math
import re
from collections import defaultdict
from typing import Any


# ─────────────────────────────────────────────────────────────────────────────
# Tunable constants
# ─────────────────────────────────────────────────────────────────────────────

SWATCH_MAX_DIM       = 30.0
FILLED_RECT_MAX_AREA = 1200.0

SCALE_BAR_MAX_THIN   = 10.0
SCALE_BAR_MIN_LONG   = 25.0

# Document border: element covers this fraction of SCREEN in BOTH dims
DOC_BORDER_FRACTION  = 0.70

CORNER_ZONE_FRACTION         = 0.28
BOTTOM_STRIP_FRACTION        = 0.35
RIGHT_STRIP_FRACTION         = 0.30
TOP_STRIP_FRACTION           = 0.10
ANNOTATION_ASPECT_MIN        = 2.0
ANNOTATION_CORNER_AREA_FRAC  = 0.12
CLUSTER_PROXIMITY            = 120.0
MIN_SWATCHES_FOR_LEGEND      = 2
OUTSIDE_PLAN_TOLERANCE       = 0.02


ANNOTATION_LAYER_HINTS = {
    "legend", "legenda", "leyenda",
    "scale", "scala", "echelle", "escala", "scalebar", "scale bar", "scale_bar",
    "north", "norte", "nord", "compass", "rose", "north arrow",
    "title", "titleblock", "title block", "title_block", "drawing title",
    "project", "revision", "rev block", "sheet", "drawing no", "drg no",
    "metadata", "info", "information",
    "stamp", "seal", "logo",
    "keynote", "key note", "key",
    "schedule", "door schedule", "window schedule",
    "notes", "general notes", "abbreviation",
    "symbol", "symbols",
    "shape group", "shapegroup", "shape_group",
    "room stat", "roomstat", "area legend",
    "graphic", "graphics",
    "border", "frame", "sheet border",
    "annotation", "annot", "dim", "dimension",
}

ANNOTATION_ID_PATTERNS = [
    re.compile(r"\blegend\b",              re.I),
    re.compile(r"\bscale[\s_-]?bar\b",     re.I),
    re.compile(r"\bnorth[\s_-]?arrow\b",   re.I),
    re.compile(r"\btitle[\s_-]?block\b",   re.I),
    re.compile(r"\brev(ision)?\b",         re.I),
    re.compile(r"\bsheet[\s_-]?no\b",      re.I),
    re.compile(r"\bdrawing[\s_-]?no\b",    re.I),
    re.compile(r"\bproject[\s_-]?info\b",  re.I),
    re.compile(r"\bkeyplan\b",             re.I),
    re.compile(r"\bschedule\b",            re.I),
    re.compile(r"\bnotes?\b",              re.I),
    re.compile(r"\bshape[\s_-]?group\b",   re.I),
    re.compile(r"\broom[\s_-]?stat\b",     re.I),
    re.compile(r"\barea[\s_-]?legend\b",   re.I),
    re.compile(r"\bgraphic\b",             re.I),
    re.compile(r"\bborder\b",              re.I),
    re.compile(r"\bframe\b",               re.I),
]


# ─────────────────────────────────────────────────────────────────────────────
# Affine-matrix helpers  (same convention as stage2_flattener)
# [a,b,c,d,e,f]  ≡  | a  c  e |
#                    | b  d  f |
#                    | 0  0  1 |
# ─────────────────────────────────────────────────────────────────────────────

_Identity = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0]
_NUM_RE   = re.compile(r"[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?")


def _mat_mul(A: list[float], B: list[float]) -> list[float]:
    a1, b1, c1, d1, e1, f1 = A
    a2, b2, c2, d2, e2, f2 = B
    return [
        a1*a2 + c1*b2,  b1*a2 + d1*b2,
        a1*c2 + c1*d2,  b1*c2 + d1*d2,
        a1*e2 + c1*f2 + e1,
        b1*e2 + d1*f2 + f1,
    ]


def _apply(mat: list[float], x: float, y: float) -> tuple[float, float]:
    a, b, c, d, e, f = mat
    return a*x + c*y + e, b*x + d*y + f


def _parse_transform(t: str) -> list[float]:
    result = list(_Identity)
    for token in re.findall(r'\w+\([^)]*\)', t.strip()):
        func = re.match(r'(\w+)\(([^)]*)\)', token)
        if not func:
            continue
        name = func.group(1).lower()
        args = [float(v) for v in re.split(r'[\s,]+', func.group(2).strip()) if v]
        if name == "translate":
            m = [1, 0, 0, 1,
                 args[0] if args else 0.0,
                 args[1] if len(args) > 1 else 0.0]
        elif name == "scale":
            sx = args[0] if args else 1.0
            sy = args[1] if len(args) > 1 else sx
            m = [sx, 0, 0, sy, 0, 0]
        elif name == "rotate":
            ang = math.radians(args[0]) if args else 0.0
            ca, sa = math.cos(ang), math.sin(ang)
            if len(args) == 3:
                cx, cy = args[1], args[2]
                m = [ca, sa, -sa, ca,
                     cx - ca*cx + sa*cy, cy - sa*cx - ca*cy]
            else:
                m = [ca, sa, -sa, ca, 0, 0]
        elif name == "skewx":
            m = [1, 0, math.tan(math.radians(args[0] if args else 0)), 1, 0, 0]
        elif name == "skewy":
            m = [1, math.tan(math.radians(args[0] if args else 0)), 0, 1, 0, 0]
        elif name == "matrix" and len(args) == 6:
            m = list(args)
        else:
            continue
        result = _mat_mul(result, m)
    return result


def _compose_transforms(transform_strings: list[str]) -> list[float]:
    mat = list(_Identity)
    for t in transform_strings:
        mat = _mat_mul(mat, _parse_transform(t))
    return mat


def _screen_bbox(raw_bb: dict, mat: list[float]) -> dict:
    """Apply affine matrix to raw bbox corners → axis-aligned screen bbox."""
    x0, y0 = raw_bb["min_x"], raw_bb["min_y"]
    x1, y1 = raw_bb["max_x"], raw_bb["max_y"]
    pts = [_apply(mat, px, py)
           for px, py in [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]]
    xs, ys = [p[0] for p in pts], [p[1] for p in pts]
    mn_x, mx_x = min(xs), max(xs)
    mn_y, mx_y = min(ys), max(ys)
    return {"min_x": mn_x, "max_x": mx_x, "min_y": mn_y, "max_y": mx_y,
            "width": mx_x - mn_x, "height": mx_y - mn_y}


# ─────────────────────────────────────────────────────────────────────────────
# Raw bbox extraction (pre-transform — for geometry heuristics only)
# ─────────────────────────────────────────────────────────────────────────────

def _raw_bbox(el: dict) -> dict | None:
    tag    = el.get("tag", "")
    coords = el.get("coords", {})
    if tag == "rect":
        x, y = coords.get("x", 0), coords.get("y", 0)
        w, h = coords.get("width", 0), coords.get("height", 0)
        if w == 0 and h == 0:
            return None
        return {"min_x": x, "max_x": x+w, "min_y": y, "max_y": y+h,
                "width": w, "height": h}
    if tag in ("polygon", "polyline"):
        pts = coords.get("points", [])
        if len(pts) < 2:
            return None
        xs = [p[0] for p in pts]; ys = [p[1] for p in pts]
        return {"min_x": min(xs), "max_x": max(xs),
                "min_y": min(ys), "max_y": max(ys),
                "width": max(xs)-min(xs), "height": max(ys)-min(ys)}
    if tag == "line":
        x1, y1 = coords.get("x1", 0), coords.get("y1", 0)
        x2, y2 = coords.get("x2", 0), coords.get("y2", 0)
        return {"min_x": min(x1,x2), "max_x": max(x1,x2),
                "min_y": min(y1,y2), "max_y": max(y1,y2),
                "width": abs(x2-x1), "height": abs(y2-y1)}
    if tag == "circle":
        cx, cy, r = coords.get("cx",0), coords.get("cy",0), coords.get("r",0)
        if r == 0:
            return None
        return {"min_x": cx-r, "max_x": cx+r, "min_y": cy-r, "max_y": cy+r,
                "width": 2*r, "height": 2*r}
    if tag == "ellipse":
        cx, cy = coords.get("cx",0), coords.get("cy",0)
        rx, ry = coords.get("rx",0), coords.get("ry",0)
        if rx == 0 or ry == 0:
            return None
        return {"min_x": cx-rx, "max_x": cx+rx, "min_y": cy-ry, "max_y": cy+ry,
                "width": 2*rx, "height": 2*ry}
    if tag == "path":
        d = coords.get("d", "")
        if not d:
            return None
        nums = [float(m) for m in _NUM_RE.findall(d)]
        if len(nums) < 2:
            return None
        xs, ys = nums[0::2], nums[1::2]
        if not xs or not ys:
            return None
        mn_x, mx_x = min(xs), max(xs)
        mn_y, mx_y = min(ys), max(ys)
        w, h = mx_x - mn_x, mx_y - mn_y
        return {"min_x": mn_x, "max_x": mx_x, "min_y": mn_y, "max_y": mx_y,
                "width": w, "height": h}
    return None


def _centroid_bb(bb: dict) -> tuple[float, float]:
    return ((bb["min_x"] + bb["max_x"]) / 2, (bb["min_y"] + bb["max_y"]) / 2)


def _merge_bboxes(bbs: list[dict]) -> dict:
    mn_x = min(b["min_x"] for b in bbs); mx_x = max(b["max_x"] for b in bbs)
    mn_y = min(b["min_y"] for b in bbs); mx_y = max(b["max_y"] for b in bbs)
    return {"min_x": mn_x, "max_x": mx_x, "min_y": mn_y, "max_y": mx_y,
            "width": mx_x - mn_x, "height": mx_y - mn_y}


# ─────────────────────────────────────────────────────────────────────────────
# Pass A — per-element heuristics
# ─────────────────────────────────────────────────────────────────────────────

def _flag_by_layer_or_id(el: dict) -> str | None:
    layer_text = " ".join(el.get("layer_path", [])).lower()
    layer_norm = re.sub(r"[-_.]", " ", layer_text)
    for hint in ANNOTATION_LAYER_HINTS:
        if hint in layer_norm:
            return f"layer hint '{hint}'"
    eid = (el.get("id") or "").lower()
    for pat in ANNOTATION_ID_PATTERNS:
        if pat.search(eid):
            return f"id pattern '{pat.pattern}'"
    return None


def _flag_by_raw_geometry(el: dict, rb: dict | None) -> str | None:
    """Heuristics on RAW (pre-transform) dimensions."""
    if rb is None:
        return None
    tag  = el.get("tag", "")
    fill = (el.get("fill") or "none").lower().strip()
    w, h = rb["width"], rb["height"]
    has_fill = fill not in ("none", "", "transparent", "inherit", "currentcolor")
    if has_fill and w*h < FILLED_RECT_MAX_AREA and w < SWATCH_MAX_DIM*4 and h < SWATCH_MAX_DIM*4:
        return f"filled swatch ({tag} {w:.1f}x{h:.1f})"
    if w < SWATCH_MAX_DIM and h < SWATCH_MAX_DIM:
        return f"tiny shape ({tag} {w:.1f}x{h:.1f})"
    thin, long_d = min(w, h), max(w, h)
    if thin <= SCALE_BAR_MAX_THIN and long_d >= SCALE_BAR_MIN_LONG:
        return f"thin line/scale-bar (thin={thin:.1f} long={long_d:.1f})"
    return None


def _flag_by_screen_geometry(scr_bb: dict, dw: float, dh: float) -> str | None:
    """Heuristics on SCREEN-SPACE dimensions (transforms applied)."""
    if dw <= 0 or dh <= 0:
        return None
    w, h = scr_bb["width"], scr_bb["height"]
    if w / dw >= DOC_BORDER_FRACTION and h / dh >= DOC_BORDER_FRACTION:
        return f"document border ({w:.0f}x{h:.0f} = {w/dw*100:.0f}%x{h/dh*100:.0f}%)"
    return None


# ─────────────────────────────────────────────────────────────────────────────
# Pass B — spatial cluster analysis (SCREEN-SPACE bboxes)
# ─────────────────────────────────────────────────────────────────────────────

def _build_clusters(items: list[tuple[int, dict, dict]],
                    proximity: float) -> list[list[int]]:
    n = len(items)
    if n == 0:
        return []
    parent = list(range(n))

    def find(x: int) -> int:
        while parent[x] != x:
            parent[x] = parent[parent[x]]; x = parent[x]
        return x

    def union(a: int, b: int) -> None:
        parent[find(a)] = find(b)

    centroids = [_centroid_bb(bb) for _, _, bb in items]
    for i in range(n):
        for j in range(i+1, n):
            if math.hypot(centroids[j][0]-centroids[i][0],
                          centroids[j][1]-centroids[i][1]) <= proximity:
                union(i, j)
    groups: dict[int, list[int]] = defaultdict(list)
    for i in range(n):
        groups[find(i)].append(i)
    return list(groups.values())


def _find_plan_bbox(items, clusters, dw, dh) -> dict | None:
    drawing_area = dw * dh or 1.0
    best_area, best_bb = 0.0, None
    for cidx in clusters:
        bbs    = [items[i][2] for i in cidx]
        merged = _merge_bboxes(bbs)
        area   = merged["width"] * merged["height"]
        if area / drawing_area > 0.20 and area > best_area:
            best_area = area; best_bb = merged
    return best_bb


def _is_annotation_cluster(
    cidx: list[int],
    items: list[tuple[int, dict, dict]],
    dw: float, dh: float,
    d_min_x: float, d_min_y: float,
    plan_bbox: dict | None,
) -> tuple[bool, str]:

    bbs    = [items[i][2] for i in cidx]
    merged = _merge_bboxes(bbs)
    cx, cy = _centroid_bb(merged)

    nx = (cx - d_min_x) / dw if dw else 0.5
    ny = (cy - d_min_y) / dh if dh else 0.5

    cw, ch    = merged["width"], merged["height"]
    area_frac = (cw * ch) / (dw * dh) if dw * dh else 0
    aspect_wh = cw / ch if ch > 0 else 0
    aspect_hw = ch / cw if cw > 0 else 0

    in_left         = nx < CORNER_ZONE_FRACTION
    in_right        = nx > 1 - CORNER_ZONE_FRACTION
    in_top          = ny < TOP_STRIP_FRACTION
    in_bottom       = ny > 1 - BOTTOM_STRIP_FRACTION
    in_corner       = (in_left or in_right) and (in_top or in_bottom)
    in_right_strip  = nx > 1 - RIGHT_STRIP_FRACTION

    small_count = sum(
        1 for i in cidx
        if items[i][2]["width"]  <= SWATCH_MAX_DIM * 2
        and items[i][2]["height"] <= SWATCH_MAX_DIM * 2
    )

    # Rule 0: entirely outside the main plan bbox
    if plan_bbox is not None:
        tol_x = dw * OUTSIDE_PLAN_TOLERANCE
        tol_y = dh * OUTSIDE_PLAN_TOLERANCE
        if (merged["min_y"] > plan_bbox["max_y"] - tol_y or
                merged["max_y"] < plan_bbox["min_y"] + tol_y or
                merged["min_x"] > plan_bbox["max_x"] - tol_x or
                merged["max_x"] < plan_bbox["min_x"] + tol_x):
            return True, "cluster entirely outside plan bbox"

    # Rule 1: small cluster in any corner
    if in_corner and area_frac <= ANNOTATION_CORNER_AREA_FRAC:
        return True, f"corner cluster (nx={nx:.2f}, ny={ny:.2f}) area={area_frac*100:.1f}%"

    # Rule 2: bottom strip
    if in_bottom and aspect_wh >= ANNOTATION_ASPECT_MIN:
        return True, f"wide bottom-strip cluster (aspect={aspect_wh:.1f})"
    if in_bottom and area_frac <= ANNOTATION_CORNER_AREA_FRAC * 3:
        return True, f"bottom-strip cluster area={area_frac*100:.1f}%"

    # Rule 3: top strip
    if in_top and aspect_wh >= ANNOTATION_ASPECT_MIN:
        return True, f"wide top-strip cluster (aspect={aspect_wh:.1f})"
    if in_top and area_frac <= ANNOTATION_CORNER_AREA_FRAC * 2:
        return True, f"top-strip cluster area={area_frac*100:.1f}%"

    # Rule 4: swatch-dense edge cluster → legend
    if (small_count >= MIN_SWATCHES_FOR_LEGEND
            and (in_left or in_right or in_bottom or in_top or in_right_strip)
            and area_frac <= ANNOTATION_CORNER_AREA_FRAC * 2):
        return True, f"swatch-dense edge cluster ({small_count} small shapes)"

    # Rule 5: tall narrow corner cluster → stats panel
    if in_corner and aspect_hw >= ANNOTATION_ASPECT_MIN and area_frac <= 0.15:
        return True, f"tall corner cluster (aspect_hw={aspect_hw:.1f})"

    # Rule 6: right-strip cluster
    if in_right_strip and area_frac <= ANNOTATION_CORNER_AREA_FRAC * 2:
        return True, f"right-strip cluster (nx={nx:.2f}) area={area_frac*100:.1f}%"

    # Rule 7: bottom-right corner info panel (absolute position)
    if (merged["min_y"] > d_min_y + dh * (1 - BOTTOM_STRIP_FRACTION) and
            merged["min_x"] > d_min_x + dw * (1 - RIGHT_STRIP_FRACTION * 1.5)):
        return True, "bottom-right corner info panel"

    return False, ""


# ─────────────────────────────────────────────────────────────────────────────
# Public API
# ─────────────────────────────────────────────────────────────────────────────

def mark_semantic_annotations(
    elements: list[dict],
    doc_width:  float = 1000.0,
    doc_height: float = 1000.0,
) -> list[dict]:
    """
    Stamp is_semantic_annotation=True on every element that belongs to an
    annotation zone (legend, scale bar, title block, north arrow, doc border,
    metadata panel).

    CRITICAL: All spatial analysis is performed in SCREEN SPACE — element
    transforms are applied before any strip/corner/cluster tests.
    Raw coords are only used for the scale-bar and swatch size heuristics.
    """
    flagged_a = 0
    flagged_b = 0

    # ── Pre-compute raw and screen bboxes ────────────────────────────────────
    raw_bboxes: list[dict | None] = [_raw_bbox(el) for el in elements]
    screen_bboxes: list[dict | None] = []

    for el, rb in zip(elements, raw_bboxes):
        if rb is None:
            screen_bboxes.append(None)
            continue
        try:
            mat = _compose_transforms(el.get("transforms", []))
            screen_bboxes.append(_screen_bbox(rb, mat))
        except Exception:
            screen_bboxes.append(rb)   # fallback: treat raw as screen

    computed = sum(1 for b in screen_bboxes if b is not None)
    print(f"[SemanticDetector] bboxes: raw={sum(1 for b in raw_bboxes if b)}  "
          f"screen={computed}  skipped={len(elements)-computed}")

    # ── Pass A: per-element heuristics ───────────────────────────────────────
    for el, rb, sb in zip(elements, raw_bboxes, screen_bboxes):
        reason = (
            _flag_by_layer_or_id(el)
            or _flag_by_raw_geometry(el, rb)
            or (sb is not None and _flag_by_screen_geometry(sb, doc_width, doc_height))
        )
        if reason:
            el["is_semantic_annotation"] = True
            el["is_structural"]          = False
            el["_annot_reason"]          = f"passA: {reason}"
            flagged_a += 1
        else:
            el.setdefault("is_semantic_annotation", False)

    # ── Pass B: spatial cluster analysis in SCREEN SPACE ────────────────────
    surviving: list[tuple[int, dict, dict]] = [
        (i, el, sb)
        for i, (el, sb) in enumerate(zip(elements, screen_bboxes))
        if not el["is_semantic_annotation"] and sb is not None
    ]

    if surviving:
        all_min_x = min(bb["min_x"] for _, _, bb in surviving)
        all_min_y = min(bb["min_y"] for _, _, bb in surviving)
        dw = max(bb["max_x"] for _, _, bb in surviving) - all_min_x
        dh = max(bb["max_y"] for _, _, bb in surviving) - all_min_y

        if dw < doc_width  * 0.3: dw, all_min_x = doc_width,  0.0
        if dh < doc_height * 0.3: dh, all_min_y = doc_height, 0.0

        clusters  = _build_clusters(surviving, CLUSTER_PROXIMITY)
        plan_bbox = _find_plan_bbox(surviving, clusters, dw, dh)

        print(f"[SemanticDetector] Pass B: {len(surviving)} elements → "
              f"{len(clusters)} clusters")
        print(f"[SemanticDetector] Plan bbox (screen): {plan_bbox}")

        for cidx in clusters:
            is_annot, reason = _is_annotation_cluster(
                cidx, surviving, dw, dh, all_min_x, all_min_y, plan_bbox
            )
            if is_annot:
                for i in cidx:
                    _, el, _ = surviving[i]
                    if not el["is_semantic_annotation"]:
                        el["is_semantic_annotation"] = True
                        el["is_structural"]          = False
                        el["_annot_reason"]          = f"passB: {reason}"
                        flagged_b += 1

    total = sum(1 for el in elements if el.get("is_semantic_annotation"))

    reasons: dict[str, int] = defaultdict(int)
    for el in elements:
        if el.get("is_semantic_annotation"):
            reasons[el.get("_annot_reason", "?")] += 1

    print(f"[SemanticDetector] ── Result ──────────────────────────────────────")
    print(f"[SemanticDetector]   Pass A (per-element): {flagged_a}")
    print(f"[SemanticDetector]   Pass B (cluster):     {flagged_b}")
    print(f"[SemanticDetector]   Total flagged:        {total}")
    if reasons:
        print(f"[SemanticDetector] ── Reasons (top 20) ─────────────────────────")
        for r, c in sorted(reasons.items(), key=lambda x: -x[1])[:20]:
            print(f"[SemanticDetector]   x{c:4d}  {r}")

    return elements