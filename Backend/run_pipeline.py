"""
run_pipeline.py — Master runner for floor plan analysis
Usage: python run_pipeline.py input.svg [output_annotated.svg]
"""

import sys
import os
import json
import time
import traceback
from pathlib import Path

MAX_LABELED_WALLS = 500


def dbg(msg): print(f"  [DBG] {msg}", flush=True)
def step(n, label): print(f"\n{'='*60}\n  STEP {n}: {label}\n{'='*60}", flush=True)
def ok(msg): print(f"  [OK]  {msg}", flush=True)
def fail(msg): print(f"  [ERR] {msg}", flush=True)


# ── Step 0: Environment ─────────────────────────────────────────────────

step(0, "Environment & file checks")
svg_in = sys.argv[1] if len(sys.argv) > 1 else "input.svg"
svg_out = sys.argv[2] if len(sys.argv) > 2 else "output_annotated.svg"

if not os.path.exists(svg_in):
    fail(f"Input file NOT FOUND: {svg_in}")
    sys.exit(1)
ok(f"Input: {svg_in} ({os.path.getsize(svg_in):,} bytes)")
ok(f"Output: {svg_out}")


# ── Step 1: Parse SVG (drop legend/grid) ────────────────────────────────

step(1, "Parsing SVG — DROPPING legend/grid elements")
t1 = time.time()
from stage1_parser import parse_svg, stroke_width_histogram
header, elements = parse_svg(svg_in)
ok(f"Parsed {len(elements)} elements in {time.time()-t1:.2f}s")

structural_count = sum(1 for e in elements if e.get("is_structural"))
ok(f"Structural: {structural_count}, Non-structural: {len(elements) - structural_count}")

if structural_count == 0:
    fail("No structural elements found!")
    # sys.exit(1)


# ── Step 2: Flatten transforms ──────────────────────────────────────────

step(2, "Flattening transforms")
t2 = time.time()
from stage2_flattener import flatten_transforms
flat = flatten_transforms(elements)
ok(f"Done in {time.time()-t2:.2f}s — {len(flat)} elements")


# ── Step 3: Normalize geometry ──────────────────────────────────────────

step(3, "Normalizing geometry")
t3 = time.time()
from stage3_normalizer import normalize_geometry
normed = normalize_geometry(flat)
ok(f"Done in {time.time()-t3:.2f}s — {len(normed)} elements")


# ── Step 4: Snap and clean ──────────────────────────────────────────────

step(4, "Snapping & deduplicating")
t4 = time.time()
from stage4_snapper import snap_and_clean
cleaned = snap_and_clean(normed)
total_segs = sum(len(e["segments"]) for e in cleaned)
ok(f"Done in {time.time()-t4:.2f}s — {total_segs} segments")

if total_segs == 0:
    fail("Zero segments after cleaning")
    # sys.exit(1)


# ── Step 5: Detect rooms ────────────────────────────────────────────────

step(5, "Detecting rooms & walls")
t5 = time.time()
from stage5_room_detector import detect_rooms_and_walls
rooms, walls = detect_rooms_and_walls(cleaned)
ok(f"Done in {time.time()-t5:.2f}s — Rooms: {len(rooms)}, Walls: {len(walls)}")

if not rooms:
    fail("No rooms detected")
    # sys.exit(1)


# ── Step 6: Shape matching ──────────────────────────────────────────────

step(6, "Detecting repetitive shapes")
t6 = time.time()
from stage6_shape_matcher import find_repetitive_shapes, groups_to_json
groups = find_repetitive_shapes(rooms)
ok(f"Done in {time.time()-t6:.2f}s — {len(groups)} groups")


# ── Step 7: Annotate SVG ────────────────────────────────────────────────

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
ok(f"Done in {time.time()-t7:.2f}s — {svg_out}")


# ── Step 8: JSON report ─────────────────────────────────────────────────

step(8, "Saving JSON report")
report_path = Path(svg_out).stem + "_report.json"
report = {
    "source": svg_in,
    "header": header,
    "summary": {
        "elements_parsed": len(elements),
        "structural_elements": structural_count,
        "segments_final": total_segs,
        "rooms": len(rooms),
        "walls": len(walls),
        "shape_groups": len(groups),
    },
    "rooms": [{k: v for k, v in r.items() if k != "vertices"} for r in rooms],
    "walls": walls,
    "groups": groups_to_json(groups),
}
Path(report_path).write_text(json.dumps(report, indent=2, default=str))
ok(f"Report → {report_path}")


# ── Final summary ───────────────────────────────────────────────────────

total_time = time.time() - t1
print(f"\n{'='*60}")
print(f"  PIPELINE COMPLETE ({total_time:.2f}s)")
print(f"  Rooms: {len(rooms)}, Walls: {len(walls)}, Groups: {len(groups)}")
print(f"  Output: {svg_out}")
print(f"{'='*60}")