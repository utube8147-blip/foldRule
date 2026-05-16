"""
run_pipeline.py — Master runner for floor plan analysis
Usage: python run_pipeline.py input.svg [output_annotated.svg]

Pipeline
--------
Stage 1  parse_svg            → raw elements (drop legend/grid)
Stage 2  flatten_transforms   → absolute coordinates
Stage 3  normalize_geometry   → uniform segment lists
Stage 4  snap_and_clean       → snapped, merged, T-junction split
Stage 5  detect_rooms_walls   → DCEL face extraction (EVERY closed polygon)
Stage 5b filter_annotations   → remove legend/title-block faces
Stage 6  find_repetitive_sh.  → classify + group similar shapes
Stage 7  annotate_svg         → write coloured output SVG
Stage 8  JSON report          → machine-readable summary
"""

import sys
import os
import json
import time
from pathlib import Path

MAX_LABELED_WALLS = 500


def dbg(msg):  print(f"  [DBG] {msg}", flush=True)
def step(n, label): print(f"\n{'='*60}\n  STEP {n}: {label}\n{'='*60}", flush=True)
def ok(msg):   print(f"  [OK]  {msg}", flush=True)
def fail(msg): print(f"  [ERR] {msg}", flush=True)


# ── Step 0: Environment ──────────────────────────────────────────────────────

step(0, "Environment & file checks")
svg_in  = sys.argv[1] if len(sys.argv) > 1 else "input.svg"
svg_out = sys.argv[2] if len(sys.argv) > 2 else "annotated_output.svg"

if not os.path.exists(svg_in):
    fail(f"Input file NOT FOUND: {svg_in}")
    sys.exit(1)
ok(f"Input:  {svg_in} ({os.path.getsize(svg_in):,} bytes)")
ok(f"Output: {svg_out}")


# ── Step 1: Parse SVG ────────────────────────────────────────────────────────

step(1, "Parsing SVG — dropping legend/grid elements")
t1 = time.time()
from stage1_parser import parse_svg, stroke_width_histogram
header, elements = parse_svg(svg_in)
ok(f"Parsed {len(elements)} elements in {time.time()-t1:.2f}s")

structural_count = sum(1 for e in elements if e.get("is_structural"))
ok(f"Structural: {structural_count}, Non-structural: {len(elements) - structural_count}")

if structural_count == 0:
    fail("No structural elements found — check WALL_SW_MIN threshold")
    # Don't exit; proceed with all elements as fallback


# ── Step 2: Flatten transforms ───────────────────────────────────────────────

step(2, "Flattening transforms")
t2 = time.time()
from stage2_flattener import flatten_transforms
flat = flatten_transforms(elements)
ok(f"Done in {time.time()-t2:.2f}s — {len(flat)} elements")


# ── Step 3: Normalize geometry ───────────────────────────────────────────────

step(3, "Normalizing geometry → uniform segment lists")
t3 = time.time()
from stage3_normalizer import normalize_geometry
normed = normalize_geometry(flat)
ok(f"Done in {time.time()-t3:.2f}s — {len(normed)} elements")


# ── Step 4: Snap and clean ───────────────────────────────────────────────────

step(4, "Snapping, deduplicating & T-junction splitting")
t4 = time.time()
from stage4_snapper import snap_and_clean
cleaned = snap_and_clean(normed)
total_segs = sum(len(e["segments"]) for e in cleaned)
ok(f"Done in {time.time()-t4:.2f}s — {total_segs} segments")

if total_segs == 0:
    fail("Zero segments after cleaning — cannot continue")
    sys.exit(1)


# ── Step 5: Detect EVERY closed polygon ─────────────────────────────────────
#
# The DCEL finds ALL bounded faces — rooms, corridors, pillars, windows,
# toilet cubicles, bed outlines, bathtub rims, everything.
# Flood-fill semantics: each face is ONLY the space bounded by its own walls.
# A pillar inside a room is a SEPARATE face — the room does not include it.

step(5, "DCEL face extraction — finding every closed polygon")
t5 = time.time()
from stage5_dcel import detect_rooms_and_walls
rooms, walls = detect_rooms_and_walls(cleaned)
ok(f"Done in {time.time()-t5:.2f}s — Faces: {len(rooms)}, Walls: {len(walls)}")

if not rooms:
    fail("No faces detected — check segment connectivity")
    sys.exit(1)


# ── Step 5b: Semantic annotation filter ─────────────────────────────────────
#
# Remove faces that overlap dense SVG text (legend boxes, title blocks, etc.)

step("5b", "Semantic annotation filter")
t5b = time.time()
from stage5b_semantic_filter import filter_annotation_polygons
rooms_before = len(rooms)
rooms = filter_annotation_polygons(rooms, svg_in)
ok(f"Done in {time.time()-t5b:.2f}s — "
   f"{rooms_before} → {len(rooms)} faces "
   f"(removed {rooms_before - len(rooms)} annotation polygons)")


# ── Step 6: Classify & find repetitive shapes ────────────────────────────────
#
# Classify each face: room / corridor / pillar / window / door_swing /
#                     furniture / fixture / void
# Then group geometrically similar faces (pillar grids, window bays, etc.)

step(6, "Shape classification & repetitive shape detection")
t6 = time.time()
from stage6_shape_matcher import find_repetitive_shapes, groups_to_json
groups = find_repetitive_shapes(rooms)
ok(f"Done in {time.time()-t6:.2f}s — {len(groups)} repetitive groups")

# Print type summary
type_counts: dict[str, int] = {}
for f in rooms:
    t = f.get("shape_type", "void")
    type_counts[t] = type_counts.get(t, 0) + 1
ok("Face types: " + "  ".join(f"{k}:{v}" for k, v in
   sorted(type_counts.items(), key=lambda x: -x[1])))


# ── Step 7: Write annotated SVG ──────────────────────────────────────────────

step(7, "Writing annotated SVG")
t7 = time.time()
from stage7_annotator import annotate_svg

show_wall_labels = len(walls) <= MAX_LABELED_WALLS
annotate_svg(
    svg_in, rooms, walls, groups, svg_out,
    show_wall_labels=show_wall_labels,
    show_room_labels=True,
    show_legend=True,
)
ok(f"Done in {time.time()-t7:.2f}s → {svg_out}")


# ── Step 8: JSON report ──────────────────────────────────────────────────────

step(8, "Saving JSON report")
report_path = Path(svg_out).stem + "_report.json"

# Build per-face report (exclude raw vertex list to keep file manageable)
face_report = []
for r in rooms:
    face_report.append({
        "face_id":       r["face_id"],
        "shape_type":    r.get("shape_type", "void"),
        "area":          round(r["area"], 2),
        "centroid":      [round(r["centroid"][0], 2), round(r["centroid"][1], 2)],
        "vertex_count":  r["vertex_count"],
        "nesting_depth": r.get("nesting_depth", 0),
        "parent_face_id": r.get("parent_face_id"),
        "bbox":          {k: round(v, 2) for k, v in r["bbox"].items()},
    })

report = {
    "source": svg_in,
    "header": header,
    "summary": {
        "elements_parsed":     len(elements),
        "structural_elements": structural_count,
        "segments_final":      total_segs,
        "faces_total":         len(rooms),
        "walls":               len(walls),
        "shape_groups":        len(groups),
        "face_type_counts":    type_counts,
    },
    "faces":  face_report,
    "walls":  walls,
    "groups": groups_to_json(groups),
}

Path(report_path).write_text(json.dumps(report, indent=2, default=str))
ok(f"Report → {report_path}")


# ── Final summary ────────────────────────────────────────────────────────────

total_time = time.time() - t1
print(f"\n{'='*60}")
print(f"  PIPELINE COMPLETE ({total_time:.2f}s)")
print(f"  Faces: {len(rooms)}  Walls: {len(walls)}  Groups: {len(groups)}")
print(f"  Types: " + "  ".join(f"{k}:{v}" for k, v in
      sorted(type_counts.items(), key=lambda x: -x[1])))
print(f"  Output SVG:  {svg_out}")
print(f"  JSON report: {report_path}")
print(f"{'='*60}")