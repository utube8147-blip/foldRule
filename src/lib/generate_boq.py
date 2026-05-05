"""
BOQ Material Matrix Generator – Al Waha Residence 01
Generates the same material-matrix takeoff format as the original Excel:
  rows = line items   |   columns = individual materials / hardware
  
Now fully configurable via JSON input file with new data structure.
"""

import json, sys, re
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.utils import get_column_letter

# ══ COLOR CONSTANTS ════════════════════════════════════════════════════════
NAVY       = "0D1B2A"
GOLD       = "B8962E"
GOLD_LIGHT = "C8A84B"
MID_BLUE   = "1A3A5C"
CHARCOAL   = "2C3E50"
WHITE      = "FFFFFF"
PALE_BLUE  = "EBF3FB"
MID_GREY   = "6C7A8D"
DARK_TEXT  = "1C1C1C"
LIME_HL    = "E2EFDA"
PEACH_HL   = "FCE4D6"
SUBGRP_BG  = "D9E1F2"
ITEM_ALT   = "F2F2F2"
SEC_BAR_BG = "0D1B2A"
SEC_ACCENT = "B8962E"
SEC_TAG_BG = "1A3A5C"
SEC_TAG_FG = "C8A84B"
FONT_FACE  = "Calibri"
BASE_H     = 16
WARM_GREY  = "F4F3F1"


def _S(s="thin", c="BBBBBB"): return Side(border_style=s, color=c)
def _B(c="BBBBBB"): s=_S("thin",c); return Border(top=s,bottom=s,left=s,right=s)
def _thick(c=GOLD_LIGHT): s=_S("medium",c); return Border(top=s,bottom=s,left=s,right=s)
def _F(h): return PatternFill("solid", fgColor=h)
def _ft(size=11, bold=False, colour=DARK_TEXT, italic=False):
    return Font(name=FONT_FACE, size=size, bold=bold, color=colour, italic=italic)
def _al(h="left", v="center", wrap=False):
    return Alignment(horizontal=h, vertical=v, wrap_text=wrap)


def get_calculation_type(unit, unit_categories):
    """Determine calculation type based on unit and category mapping"""
    unit_upper = unit.upper() if unit else ""
    
    for calc_type, units in unit_categories.items():
        if unit_upper in units:
            return calc_type
    
    # Default fallbacks
    if unit_upper in ("NR", "NOS", "PC", "PCS", "EACH"):
        return "count_based"
    elif unit_upper in ("PR", "PAIR"):
        return "pair_based"
    elif unit_upper in ("SET", "KIT", "BOX"):
        return "set_based"
    elif unit_upper in ("M²", "M2", "SQ M", "SQM"):
        return "area_based"
    elif unit_upper in ("M³", "M3", "CU M"):
        return "volume_based"
    elif unit_upper in ("LM", "L M", "M"):
        return "linear_based"
    
    return "count_based"


def calculate_quantity(item, unit_categories):
    """Calculate quantity based on dimensions and unit type"""
    dims = item.get("dimensions", {})
    L = dims.get("length_meters") or dims.get("length_m")
    W = dims.get("width_meters") or dims.get("width_m")
    H = dims.get("height_meters") or dims.get("height_m") or dims.get("height_thk_m")
    
    qty = item.get("quantity_per_unit") or item.get("no_of_units") or item.get("quantity", 1)
    if qty is None:
        qty = 1
    
    unit = item.get("measurement_unit") or item.get("unit", "")
    calc_type = get_calculation_type(unit, unit_categories)
    
    if calc_type == "area_based":
        dims_list = [d for d in [L, W, H] if d is not None]
        if len(dims_list) >= 2:
            area = dims_list[0] * dims_list[1]
            return round(area * qty, 4)
        return None
    elif calc_type == "volume_based":
        if L is not None and W is not None and H is not None:
            return round(L * W * H * qty, 6)
        return None
    elif calc_type in ("linear_based", "lm", "m"):
        for dim in [L, H, W]:
            if dim is not None:
                return round(dim * qty, 4)
        return qty if qty != 1 else None
    else:
        return qty if qty != 1 else None


def build_quantity_formula(item, row_num, col_map, unit_categories):
    """Build Excel formula for quantity based on category"""
    dims = item.get("dimensions", {})
    L = dims.get("length_meters") or dims.get("length_m")
    W = dims.get("width_meters") or dims.get("width_m")
    H = dims.get("height_meters") or dims.get("height_m") or dims.get("height_thk_m")
    
    qty = item.get("quantity_per_unit") or item.get("no_of_units") or item.get("quantity", 1)
    if qty is None:
        qty = 1
    
    unit = item.get("measurement_unit") or item.get("unit", "")
    remarks = item.get("remarks", "")
    calc_type = get_calculation_type(unit, unit_categories)
    
    col_times = get_column_letter(col_map["times"])
    col_L = get_column_letter(col_map["L"])
    col_W = get_column_letter(col_map["W"])
    col_H = get_column_letter(col_map["H"])
    
    # Extract from remarks
    lm_match = re.search(r"([\d.]+)\s*lm", remarks.lower())
    area_match = re.search(r"([\d.]+)\s*m²", remarks.lower())
    if lm_match:
        return float(lm_match.group(1))
    if area_match and calc_type == "area_based":
        return float(area_match.group(1))
    
    if calc_type == "area_based":
        dim_cols = []
        if L is not None: dim_cols.append(col_L)
        if W is not None: dim_cols.append(col_W)
        if H is not None: dim_cols.append(col_H)
        
        if len(dim_cols) >= 2:
            formula = f"={dim_cols[0]}{row_num}*{dim_cols[1]}{row_num}"
            if qty != 1:
                formula = f"={formula}*{col_times}{row_num}"
            return formula
        return None
    elif calc_type == "volume_based":
        if L is not None and W is not None and H is not None:
            formula = f"={col_L}{row_num}*{col_W}{row_num}*{col_H}{row_num}"
            if qty != 1:
                formula = f"={formula}*{col_times}{row_num}"
            return formula
        return None
    elif calc_type in ("linear_based", "lm", "m"):
        for dim_col, dim_val in [(col_L, L), (col_H, H), (col_W, W)]:
            if dim_val is not None:
                formula = f"={dim_col}{row_num}"
                if qty != 1:
                    formula = f"={formula}*{col_times}{row_num}"
                return formula
        return qty if qty != 1 else None
    else:
        if qty != 1:
            return f"={col_times}{row_num}"
        return qty if qty != 1 else None


def detect_materials(item, material_rules):
    """Detect materials based on JSON configuration rules"""
    spec = (item.get("specification") or "").lower()
    desc = (item.get("description") or "").lower()
    remarks = (item.get("remarks") or "").lower()
    detected = []
    
    # Sheet/board material detection
    for rule in material_rules.get("board_rules", []):
        thickness = rule.get("thickness")
        material = rule.get("material")
        context = rule.get("context")
        
        thickness_match = (thickness is None or thickness.lower() in spec)
        material_match = (material is None or material in spec)
        context_match = True
        if context:
            context_match = any(ctx.lower() in desc for ctx in context) if isinstance(context, list) else context.lower() in desc
        
        if thickness_match and material_match and context_match:
            detected.append(rule.get("key"))
            break
    
    # Additional materials detection
    for rule in material_rules.get("addon_rules", []):
        triggers_spec = rule.get("trigger_spec", [])
        triggers_desc = rule.get("trigger_desc", [])
        size_filter = rule.get("size_filter")
        
        spec_match = any(t.lower() in spec for t in triggers_spec) if triggers_spec else False
        desc_match = any(t.lower() in desc for t in triggers_desc) if triggers_desc else False
        
        if spec_match or desc_match:
            if size_filter:
                if size_filter.lower() in spec or size_filter.lower() in desc:
                    detected.append(rule.get("key"))
            else:
                detected.append(rule.get("key"))
    
    return list(dict.fromkeys(detected))


def extract_from_remarks(remarks, regex_pattern):
    """Extract value from remarks using regex pattern"""
    if not remarks or not regex_pattern:
        return None
    match = re.search(regex_pattern, remarks.lower())
    if match:
        return float(match.group(1))
    return None


def build_summary_sheet(wb, doc, sections, section_map):
    """Create a professional Summary worksheet dynamically from JSON data"""
    ws = wb.create_sheet("Summary", 0)
    ws.sheet_view.showGridLines = False

    # Column widths
    ws.column_dimensions['A'].width = 3.5
    ws.column_dimensions['B'].width = 22
    ws.column_dimensions['C'].width = 36
    ws.column_dimensions['D'].width = 16
    ws.column_dimensions['E'].width = 16
    ws.column_dimensions['F'].width = 3.5

    COLS = 6

    def _gold_stripe(r, h=4):
        ws.row_dimensions[r].height = h
        for ci in range(1, COLS + 1):
            ws.cell(r, ci).fill = _F(GOLD)

    def _navy_bar(r, text, size=13, h=32):
        ws.row_dimensions[r].height = h
        for ci in range(1, COLS + 1):
            ws.cell(r, ci).fill = _F(NAVY)
            ws.cell(r, ci).border = Border(bottom=Side("medium", color=GOLD))
        ws.cell(r, 1).fill = _F(GOLD)
        ws.merge_cells(f"B{r}:E{r}")
        c = ws.cell(r, 2)
        c.value = text
        c.font = _ft(size, True, WHITE)
        c.fill = _F(NAVY)
        c.alignment = _al("left", "center")
        c.border = Border(bottom=Side("medium", color=GOLD))

    def _section_hdr(r, label):
        ws.row_dimensions[r].height = 26
        for ci in range(1, COLS + 1):
            ws.cell(r, ci).fill = _F(CHARCOAL)
            ws.cell(r, ci).border = Border(
                top=Side("medium", color=GOLD),
                bottom=Side("thin", color=GOLD_LIGHT)
            )
        ws.cell(r, 1).fill = _F(GOLD)
        ws.merge_cells(f"B{r}:E{r}")
        c = ws.cell(r, 2)
        c.value = label.upper()
        c.font = _ft(10, True, GOLD_LIGHT)
        c.fill = _F(CHARCOAL)
        c.alignment = _al("left", "center")
        c.border = Border(
            top=Side("medium", color=GOLD),
            bottom=Side("thin", color=GOLD_LIGHT)
        )

    def _detail_row(r, label, value, alt=False):
        ws.row_dimensions[r].height = 22
        bg = PALE_BLUE if alt else WHITE
        thin = Side("thin", color="DDEEFF" if alt else "E8E8E8")
        gold_l = Side("medium", color=GOLD)

        ws.cell(r, 1).fill = _F(GOLD)
        ws.cell(r, 1).border = Border(bottom=thin)

        c = ws.cell(r, 2)
        c.value = label
        c.font = _ft(9, True, MID_GREY)
        c.fill = _F(bg)
        c.alignment = _al("left", "center")
        c.border = Border(left=gold_l, bottom=thin)

        ws.merge_cells(f"C{r}:E{r}")
        c = ws.cell(r, 3)
        c.value = value
        c.font = _ft(10, True, NAVY)
        c.fill = _F(bg)
        c.alignment = _al("left", "center")
        c.border = Border(right=Side("medium", color=GOLD), bottom=thin)

        ws.cell(r, 6).fill = _F(bg)
        ws.cell(r, 6).border = Border(bottom=thin)

    def _col_hdr_row(r, labels):
        ws.row_dimensions[r].height = 26
        for ci in range(1, COLS + 1):
            c = ws.cell(r, ci)
            c.fill = _F(MID_BLUE)
            c.border = Border(
                top=Side("medium", color=GOLD),
                bottom=Side("medium", color=GOLD)
            )
        ws.cell(r, 1).fill = _F(GOLD)
        for ci, txt in labels:
            c = ws.cell(r, ci)
            c.value = txt
            c.font = _ft(9, True, WHITE)
            c.fill = _F(MID_BLUE)
            c.alignment = _al("center", "center")

    def _tbl_row(r, sec_id, ref, title, count, alt=False):
        ws.row_dimensions[r].height = 22
        bg = PALE_BLUE if alt else WHITE
        thin = Side("thin", color="DDEEFF" if alt else "E8E8E8")
        gold_l = Side("medium", color=GOLD)

        ws.cell(r, 1).fill = _F(GOLD)
        ws.cell(r, 1).border = Border(bottom=thin)

        data = [(2, sec_id, "center"), (3, ref, "center"),
                (4, title, "left"), (5, count, "center")]
        for ci, val, ha in data:
            c = ws.cell(r, ci)
            c.value = val
            c.font = _ft(10, False, NAVY if ci in (2,3,5) else DARK_TEXT)
            c.fill = _F(bg)
            c.alignment = _al(ha, "center")
            brd_kw = dict(bottom=thin)
            if ci == 2: brd_kw["left"] = gold_l
            if ci == 5: brd_kw["right"] = Side("medium", color=GOLD)
            c.border = Border(**brd_kw)

        ws.cell(r, 6).fill = _F(bg)
        ws.cell(r, 6).border = Border(bottom=thin)

    # Build the sheet
    r = 1
    _gold_stripe(r, 4); r += 1

    _navy_bar(r, f"BILL OF QUANTITIES  ·  KITCHEN FITOUT  ·  TYPE {doc.get('kitchen_type', 'N/A')}", size=13, h=36); r += 1

    ws.row_dimensions[r].height = 20
    for ci in range(1, COLS+1):
        ws.cell(r, ci).fill = _F(MID_BLUE)
    ws.cell(r, 1).fill = _F(GOLD)
    ws.merge_cells(f"B{r}:E{r}")
    c = ws.cell(r, 2)
    c.value = f"{doc.get('project', doc.get('name', ''))}   ·   {doc.get('location', '')}   ·   {doc.get('phase', '')}"
    c.font = _ft(10, False, GOLD_LIGHT, italic=True)
    c.fill = _F(MID_BLUE)
    c.alignment = _al("left", "center")
    r += 1

    _gold_stripe(r, 3); r += 1

    # Project Information
    _section_hdr(r, "Project Information"); r += 1

    details = [
        ("Main Contractor", doc.get("main_contractor", "N/A")),
        ("Design Consultant", doc.get("design_consultant", "N/A")),
        ("Supervision", doc.get("supervision", "N/A")),
        ("Kitchen Type", doc.get("kitchen_type", "N/A")),
        ("Total Units", doc.get("total_units", 0)),
        ("Date", doc.get("date", "N/A")),
        ("Revision", doc.get("revision", "N/A")),
        ("Currency / VAT", f"{doc.get('currency', 'AED')}  (VAT {doc.get('vat_rate_percent', 5)}%)"),
    ]
    for i, (lbl, val) in enumerate(details):
        _detail_row(r, lbl, val, alt=(i % 2 == 0)); r += 1

    # Drawing References
    ws.row_dimensions[r].height = 8; r += 1
    _section_hdr(r, "Drawing References"); r += 1

    for i, ref in enumerate(doc.get("drawing_references", [])):
        _detail_row(r, f"Ref {i+1:02d}", ref, alt=(i % 2 == 0)); r += 1

    # Section Summary
    ws.row_dimensions[r].height = 8; r += 1
    _section_hdr(r, "Section Summary"); r += 1

    _col_hdr_row(r, [(2, "Section"), (3, "Reference"), (4, "Description"), (5, "Items")]); r += 1

    for i, sec in enumerate(sections):
        sec_id = sec.get("section_id", "")
        sec_info = section_map.get(sec_id, {})
        elv_label = sec_info.get("elevation", "–")
        unit_type = sec_info.get("cabinet_type", sec_info.get("unit_type", "–"))
        items_count = len(sec.get("components", sec.get("items", [])))
        _tbl_row(r, sec_id, elv_label, unit_type, items_count, alt=(i % 2 == 0)); r += 1

    # Footer
    ws.row_dimensions[r].height = 8; r += 1
    _gold_stripe(r, 3); r += 1

    ws.row_dimensions[r].height = 20
    ws.merge_cells(f"A{r}:F{r}")
    c = ws.cell(r, 1)
    c.value = "All quantities subject to field verification. Unit rates to be inserted by tendering contractor."
    c.font = _ft(8, False, MID_GREY, italic=True)
    c.fill = _F(NAVY)
    c.alignment = _al("center", "center")

    return ws


def _build_matrix_sheet(wb, doc, sections, fixtures, section_map, material_cols, sheet_area_m2, output_options, unit_categories):
    """Build the BOQ Matrix sheet with fixtures support and original styling"""
    ws = wb.create_sheet("BOQ_Matrix")
    ws.sheet_view.showGridLines = False

    # Get output options from JSON
    PR = output_options.get("right_padding_columns", output_options.get("padding_right", 2))
    PB = output_options.get("bottom_padding_rows", output_options.get("padding_bottom", 10))

    # Build material columns list from JSON
    MATERIAL_COLS = [(col["key"], col["label"]) for col in material_cols if not col["key"].startswith("_blank")]
    SPACER_COLS = [col["key"] for col in material_cols if col["key"].startswith("_blank")]
    
    # Create mapping for count_only materials
    count_only_keys = {col["key"] for col in material_cols if col.get("count_only", False)}
    
    # Get material widths from JSON
    mat_widths = {col["key"]: col.get("width", 14) for col in material_cols}

    def sc(internal_col):
        return internal_col

    LEFT_COLS_COUNT = 9
    MAT_INTERNAL_START = 10
    REM_INTERNAL = MAT_INTERNAL_START + len(MATERIAL_COLS) + len(SPACER_COLS)
    rem_actual = sc(REM_INTERNAL)
    total_actual = rem_actual + PR

    # Column widths
    base_widths = {1:4, 2:10, 3:46, 4:9, 5:9, 6:9, 7:9, 8:9, 9:17}
    col_max = {}
    for ic in range(1, LEFT_COLS_COUNT+1):
        col_max[sc(ic)] = base_widths.get(ic, 10)
    
    mat_idx = 0
    for mi, (key, _) in enumerate(MATERIAL_COLS):
        col_max[sc(MAT_INTERNAL_START + mi)] = mat_widths.get(key, 14)
        mat_idx = mi + 1
    for si, key in enumerate(SPACER_COLS):
        col_max[sc(MAT_INTERNAL_START + mat_idx + si)] = mat_widths.get(key, 3.5)
    
    col_max[rem_actual] = 34

    def track_w(actual_col, text):
        if text:
            for line in str(text).split("\n"):
                col_max[actual_col] = max(col_max.get(actual_col, 10), len(line)+3)

    def apply_widths():
        for ci in range(rem_actual+1, total_actual+1):
            ws.column_dimensions[get_column_letter(ci)].width = 3.5
        for col_n, w in col_max.items():
            ws.column_dimensions[get_column_letter(col_n)].width = max(w, 8)

    row_max_lines = {}
    def track_h(row, lines=1):
        row_max_lines[row] = max(row_max_lines.get(row,1), lines)
    def apply_heights():
        for r, lines in row_max_lines.items():
            ws.row_dimensions[r].height = max(lines*BASE_H, BASE_H)

    def pad_bottom_row(row, height=8):
        ws.row_dimensions[row].height = height
        brd = _B() if output_options.get("border_padding_cells", output_options.get("padding_border", True)) else Border()
        for ci in range(1, total_actual+1):
            c = ws.cell(row, ci); c.fill = _F(WHITE); c.border = brd

    def apply_right_pad_cols(r1, r2):
        brd = _B() if output_options.get("border_padding_cells", output_options.get("padding_border", True)) else Border()
        for r in range(r1, r2+1):
            for ci in range(rem_actual+1, total_actual+1):
                c = ws.cell(r, ci); c.fill = _F(WHITE); c.border = brd

    # Start writing
    current_row = 1
    first_data_row = 1

    # Title Row
    ws.row_dimensions[current_row].height = 30
    ws.merge_cells(f"{get_column_letter(sc(1))}{current_row}:{get_column_letter(rem_actual)}{current_row}")
    c = ws.cell(current_row, sc(1))
    doc_title = doc.get("document_metadata", {}).get("title", doc.get("title", "BILL OF QUANTITIES"))
    c.value = (f"{doc_title} (TYPE {doc.get('kitchen_type', 'N/A')})   ·   "
               f"{doc.get('project', doc.get('name', ''))}   ·   {doc.get('location', '')}   ·   {doc.get('phase', '')}")
    c.font = _ft(14, True, WHITE)
    c.fill = _F(NAVY)
    c.alignment = _al("center", "center")
    current_row += 1

    # Info Bar
    ws.row_dimensions[current_row].height = 24
    for ci in range(1, total_actual+1):
        cell = ws.cell(current_row, ci)
        cell.fill = _F(MID_BLUE)
        cell.border = Border(bottom=Side("medium", color=GOLD))
        cell.value = None
    
    total_units_value = doc.get('total_units', 0)
    ws.cell(current_row, sc(8)).value = total_units_value
    ws.cell(current_row, sc(8)).font = _ft(11, True, MID_BLUE)
    ws.cell(current_row, sc(8)).fill = _F(MID_BLUE)
    current_row += 1

    # ========== SECTION HEADER WRITER ==========
    def write_sec_hdr(row, elv_label, unit_type, note=""):
        bar = row
        ws.row_dimensions[bar].height = 30
        
        gb_top = Side(border_style="medium", color=GOLD)
        gb_bottom = Side(border_style="medium", color=GOLD)
        
        for ci in range(1, total_actual+1):
            c = ws.cell(bar, ci)
            c.fill = _F(SEC_BAR_BG)
            c.border = Border(top=gb_top, bottom=gb_bottom)
        
        tag = ws.cell(bar, sc(2))
        tag.value = f"  {elv_label}  "
        tag.font = _ft(11, True, SEC_TAG_FG)
        tag.fill = _F(SEC_TAG_BG)
        tag.alignment = _al("center", "center")
        tag.border = Border(
            left=Side("medium", color=GOLD),
            right=Side("thin", color=GOLD_LIGHT),
            top=gb_top,
            bottom=gb_bottom
        )
        
        ttl = ws.cell(bar, sc(3))
        ttl.value = unit_type.upper()
        ttl.font = _ft(13, True, WHITE)
        ttl.fill = _F(SEC_BAR_BG)
        ttl.alignment = _al("left", "center")
        ttl.border = Border(top=gb_top, bottom=gb_bottom)
        
        if note:
            nc = ws.cell(bar, rem_actual)
            nc.value = note[:100]
            nc.font = _ft(10, False, SEC_ACCENT, True)
            nc.fill = _F(SEC_BAR_BG)
            nc.alignment = _al("right", "center", True)
            nc.border = Border(top=gb_top, bottom=gb_bottom)
            track_w(rem_actual, note)
        
        track_h(bar, 2)
        return row + 1

    # ========== COLUMN HEADERS WRITER ==========
    def write_col_hdrs(row):
        ws.row_dimensions[row].height = 60
        hf = _F(MID_BLUE)
        ff = _ft(11, True, WHITE)
        fa = _al("center", "center", True)
        fb = _thick()
        
        for ci, h in enumerate(["", "S.No", "Description", "Unit", "Times", "L", "W", "H", "Total QTY"], 1):
            c = ws.cell(row, sc(ci))
            c.value = h
            c.font = ff
            c.fill = hf
            c.alignment = fa
            c.border = fb
            track_w(sc(ci), h)
        
        # Material columns
        for mi, (key, hdr) in enumerate(MATERIAL_COLS):
            ci = sc(MAT_INTERNAL_START + mi)
            c = ws.cell(row, ci)
            c.value = hdr
            c.font = ff
            c.fill = hf
            c.alignment = fa
            c.border = fb
            track_w(ci, hdr)
        
        # Spacer columns
        spacer_idx = len(MATERIAL_COLS)
        for si, key in enumerate(SPACER_COLS):
            ci = sc(MAT_INTERNAL_START + spacer_idx + si)
            c = ws.cell(row, ci)
            c.fill = _F(CHARCOAL)
            c.border = fb
        
        c = ws.cell(row, rem_actual)
        c.value = "Remarks"
        c.font = ff
        c.fill = hf
        c.alignment = fa
        c.border = fb

    # ========== SUBGROUP HEADER WITH COLORED DIMENSION BOXES ==========
    def write_subgrp(row, label, L_val=None, W_val=None, H_val=None):
        """Write subgroup header with colored dimension boxes on the same row"""
        ws.row_dimensions[row].height = 28
        
        # Fill background
        for ci in range(1, total_actual+1):
            cell = ws.cell(row, ci)
            if not cell.value:
                cell.fill = _F(SUBGRP_BG)
        
        # Write the label in Description column
        c = ws.cell(row, sc(3))
        c.value = label
        c.fill = _F(SUBGRP_BG)
        c.font = _ft(11, True, MID_BLUE)
        c.alignment = _al("left", "center")
        track_w(sc(3), label)
        
        # ⭐ COLORED DIMENSION BOXES - ALL THREE ALWAYS COLORED ⭐
        dim_border = Border(
            left=Side("medium", color=GOLD),
            right=Side("medium", color=GOLD),
            top=Side("thin", color=GOLD),
            bottom=Side("thin", color=GOLD)
        )
        
        # L column (col 6) - always colored
        dim_cell_L = ws.cell(row, sc(6))
        dim_cell_L.border = dim_border
        dim_cell_L.fill = _F(GOLD_LIGHT)
        dim_cell_L.font = _ft(11, True, NAVY)
        dim_cell_L.alignment = _al("center", "center")
        if L_val is not None:
            dim_cell_L.value = L_val
        else:
            dim_cell_L.value = ""
        
        # W column (col 7) - always colored
        dim_cell_W = ws.cell(row, sc(7))
        dim_cell_W.border = dim_border
        dim_cell_W.fill = _F(GOLD_LIGHT)
        dim_cell_W.font = _ft(11, True, NAVY)
        dim_cell_W.alignment = _al("center", "center")
        if W_val is not None:
            dim_cell_W.value = W_val
        else:
            dim_cell_W.value = ""
        
        # H column (col 8) - always colored
        dim_cell_H = ws.cell(row, sc(8))
        dim_cell_H.border = dim_border
        dim_cell_H.fill = _F(GOLD_LIGHT)
        dim_cell_H.font = _ft(11, True, NAVY)
        dim_cell_H.alignment = _al("center", "center")
        if H_val is not None:
            dim_cell_H.value = H_val
        else:
            dim_cell_H.value = ""

    # ========== ENHANCED ITEM ROW WRITER WITH SLEEK DESIGN ==========
    def write_item(row, s_no, desc, unit, times, L, W, H, qty_formula, mat_a, remarks="", alt=False):
        ws.row_dimensions[row].height = 18  # Slightly taller for better readability
        
        # Sleek alternating backgrounds with subtle gradients
        if alt:
            bg = _F("F8F9FC")  # Very light cool gray for alternate rows
            border_color = "E8ECF1"
        else:
            bg = _F(WHITE)
            border_color = "EEF2F7"
        
        brd = Border(
            left=Side(style="thin", color=border_color),
            right=Side(style="thin", color=border_color),
            top=Side(style="thin", color=border_color),
            bottom=Side(style="thin", color=border_color)
        )
        
        # S.No column - subtle gray background
        sno_cell = ws.cell(row, sc(1))
        sno_cell.value = s_no
        sno_cell.fill = _F("F0F2F5")
        sno_cell.font = _ft(10, False, "6B7A8F")
        sno_cell.alignment = _al("center", "center")
        sno_cell.border = brd
        
        # Item number column
        item_cell = ws.cell(row, sc(2))
        item_cell.value = s_no
        item_cell.fill = bg
        item_cell.font = _ft(10, True, NAVY)
        item_cell.alignment = _al("center", "center")
        item_cell.border = brd
        
        # Description column - wrapped text with better spacing
        desc_cell = ws.cell(row, sc(3))
        desc_cell.value = desc
        desc_cell.fill = bg
        desc_cell.font = _ft(10, False, "2C3E50")
        desc_cell.alignment = _al("left", "center", wrap=True)
        desc_cell.border = brd
        
        # Unit column
        unit_cell = ws.cell(row, sc(4))
        unit_cell.value = unit
        unit_cell.fill = bg
        unit_cell.font = _ft(10, False, "5A6C7D")
        unit_cell.alignment = _al("center", "center")
        unit_cell.border = brd
        
        # Times column - subtle highlight
        times_cell = ws.cell(row, sc(5))
        if times is not None and times != 1 and times != "":
            times_cell.value = times
            times_cell.fill = _F("FFF8E7")  # Warm highlight
            times_cell.font = _ft(10, True, GOLD)
        else:
            times_cell.value = ""
            times_cell.fill = bg
            times_cell.font = _ft(10, False, "A0AAB5")
        times_cell.alignment = _al("center", "center")
        times_cell.border = brd
        
        # L column - subtle numeric styling
        L_cell = ws.cell(row, sc(6))
        if L is not None:
            L_cell.value = L
            L_cell.font = _ft(10, False, "3A5C8A")
        else:
            L_cell.value = ""
            L_cell.font = _ft(10, False, "B0B8C4")
        L_cell.fill = bg
        L_cell.alignment = _al("center", "center")
        L_cell.border = brd
        
        # W column
        W_cell = ws.cell(row, sc(7))
        if W is not None:
            W_cell.value = W
            W_cell.font = _ft(10, False, "3A5C8A")
        else:
            W_cell.value = ""
            W_cell.font = _ft(10, False, "B0B8C4")
        W_cell.fill = bg
        W_cell.alignment = _al("center", "center")
        W_cell.border = brd
        
        # H column
        H_cell = ws.cell(row, sc(8))
        if H is not None:
            H_cell.value = H
            H_cell.font = _ft(10, False, "3A5C8A")
        else:
            H_cell.value = ""
            H_cell.font = _ft(10, False, "B0B8C4")
        H_cell.fill = bg
        H_cell.alignment = _al("center", "center")
        H_cell.border = brd
        
        # Total QTY column - bold with subtle background
        qty_cell = ws.cell(row, sc(9))
        if qty_formula is not None:
            qty_cell.value = qty_formula
            qty_cell.font = _ft(10, True, "1A5C3A")  # Dark green for quantities
            qty_cell.fill = _F("E8F5E9")  # Very light green
        else:
            qty_cell.fill = bg
        qty_cell.alignment = _al("center", "center")
        qty_cell.border = brd
        qty_cell.number_format = "0.000"
        
        # Material columns
        for mi, (key, _) in enumerate(MATERIAL_COLS):
            ci = sc(MAT_INTERNAL_START + mi)
            c = ws.cell(row, ci)
            if key in mat_a:
                c.value = mat_a[key]
                c.fill = _F("EBF3FA")  # Soft blue for material quantities
                c.font = _ft(10, False, "2A6496")
                c.number_format = "0.000"
            else:
                c.fill = bg
            c.border = brd
            c.alignment = _al("center", "center")
        
        # Spacer columns - clean white
        spacer_idx = len(MATERIAL_COLS)
        for si, key in enumerate(SPACER_COLS):
            ci = sc(MAT_INTERNAL_START + spacer_idx + si)
            c = ws.cell(row, ci)
            c.fill = bg
            c.border = brd
        
        # Remarks column - italic with subtle gray
        remarks_cell = ws.cell(row, rem_actual)
        remarks_cell.value = remarks
        remarks_cell.fill = bg
        remarks_cell.font = _ft(9, False, "8A9BAE", italic=True)
        remarks_cell.alignment = _al("left", "center", True)
        remarks_cell.border = brd
        track_w(rem_actual, remarks)
        track_w(sc(3), desc)

    # ========== SUMMARY ROWS WRITER ==========
    def write_summary(pu_row, tot_row, i_start, i_end):
        ws.row_dimensions[pu_row].height = 20
        c = ws.cell(pu_row, sc(9))
        c.value = "Per Unit"
        c.font = _ft(11, True)
        c.fill = _F(LIME_HL)
        c.alignment = _al("center")
        
        for mi, (key, _) in enumerate(MATERIAL_COLS):
            ci = sc(MAT_INTERNAL_START + mi)
            cell = ws.cell(pu_row, ci)
            cell.value = f"=SUM({get_column_letter(ci)}{i_start}:{get_column_letter(ci)}{i_end})"
            cell.font = _ft(11)
            cell.fill = _F(LIME_HL)
            cell.number_format = "0.000"
            cell.alignment = _al("center")
            cell.border = _B()
        
        ws.row_dimensions[tot_row].height = 22
        c = ws.cell(tot_row, sc(8))
        c.value = f"=H2"
        c.font = _ft(13, True, "FF0000")
        c.alignment = _al("center")
        
        c = ws.cell(tot_row, sc(9))
        c.value = "Total Unit"
        c.font = _ft(11, True)
        c.fill = _F(PEACH_HL)
        c.alignment = _al("center")
        c.border = _B()
        
        for mi, (key, _) in enumerate(MATERIAL_COLS):
            ci = sc(MAT_INTERNAL_START + mi)
            col_l = get_column_letter(ci)
            cell = ws.cell(tot_row, ci)
            if key in count_only_keys:
                cell.value = f"={col_l}{pu_row}*H2"
            else:
                cell.value = f"={col_l}{pu_row}*H2/{sheet_area_m2}"
            cell.font = _ft(11)
            cell.fill = _F(PEACH_HL)
            cell.number_format = "0.000"
            cell.alignment = _al("center")
            cell.border = _B()

    # Get material detection rules
    material_rules = doc.get("material_detection_rules", {})
    subgroup_keywords = material_rules.get("subgroup_keywords", [])
    desc_strip_prefixes = material_rules.get("desc_strip_prefixes", [])
    
    # Collect all items from sections and fixtures
    all_items = []
    for sec in sections:
        sec_id = sec.get("section_id", "")
        sec_note = sec.get("notes", sec.get("note", ""))
        components = sec.get("components", sec.get("items", []))
        for comp in components:
            comp["_section_id"] = sec_id
            comp["_section_note"] = sec_note
            all_items.append(comp)
    
    for fixture in fixtures:
        fixture["_section_id"] = "FIXTURES"
        fixture["_section_note"] = ""
        all_items.append(fixture)

    # Group items by section
    sections_dict = {}
    for item in all_items:
        sid = item.get("_section_id", "OTHER")
        if sid not in sections_dict:
            sections_dict[sid] = []
        sections_dict[sid].append(item)

    total_unit_rows = []

    # Process each section
    for sid, items in sections_dict.items():
        sec_info = section_map.get(sid, {})
        
        if sid == "FIXTURES":
            elv_label = "FIXTURES"
            unit_type = "Kitchen Fixtures"
        else:
            elv_label = sec_info.get("elevation", sid)
            unit_type = sec_info.get("cabinet_type", sec_info.get("unit_type", "Section"))
        
        section_note = items[0].get("_section_note", "") if items else ""

        current_row = write_sec_hdr(current_row, elv_label, unit_type, section_note)
        write_col_hdrs(current_row)
        current_row += 1

        i_start = current_row
        cur_sg = None
        alt = False
        
        current_L = None
        current_W = None
        current_H = None

        for item in items:
            desc = item.get("description", "")
            item_no = item.get("item_number", item.get("item_no", ""))
            unit = item.get("measurement_unit", item.get("unit", ""))
            remarks = item.get("remarks", "")
            qty_val = item.get("quantity_per_unit", item.get("no_of_units", item.get("quantity", 1)))
            if qty_val is None:
                qty_val = 1
            
            dims = item.get("dimensions", {})
            L = dims.get("length_meters") or dims.get("length_m")
            W = dims.get("width_meters") or dims.get("width_m")
            H = dims.get("height_meters") or dims.get("height_m") or dims.get("height_thk_m")
            
            dl = desc.lower()
            
            # Detect subgroup using keywords
            sg = None
            for kw_rule in subgroup_keywords:
                keywords = kw_rule.get("keywords", [])
                if any(kw.lower() in dl for kw in keywords):
                    sg = kw_rule.get("label")
                    if kw_rule.get("has_dims", True):
                        current_L, current_W, current_H = L, W, H
                    else:
                        current_L, current_W, current_H = None, None, None
                    break
            
            if sg and sg != cur_sg:
                cur_sg = sg
                write_subgrp(current_row, sg, current_L, current_W, current_H)
                current_row += 1
                alt = False

            # Build quantity formula
            col_map = {"times": sc(5), "L": sc(6), "W": sc(7), "H": sc(8)}
            qty_formula = build_quantity_formula(item, current_row, col_map, unit_categories)
            
            # Check for directly assigned material (fixtures)
            assigned_material = item.get("assigned_material")
            if assigned_material:
                mat_keys = [assigned_material]
            else:
                mat_keys = detect_materials(item, material_rules)
            
            # Build material assignments with extraction from remarks
            mat_values = {}
            for mk in mat_keys:
                # Check if this material has a regex pattern for extraction
                extraction_rule = None
                for rule in material_rules.get("addon_rules", []):
                    if rule.get("key") == mk and rule.get("extract_from_remarks"):
                        extraction_rule = rule.get("regex_pattern")
                        break
                
                if extraction_rule:
                    extracted_val = extract_from_remarks(remarks, extraction_rule)
                    if extracted_val:
                        mat_values[mk] = extracted_val
                    else:
                        mat_values[mk] = f"={get_column_letter(sc(9))}{current_row}" if qty_formula is not None and not isinstance(qty_formula, (int, float)) else qty_val
                elif mk in count_only_keys:
                    mat_values[mk] = f"={get_column_letter(sc(9))}{current_row}" if qty_formula is not None and not isinstance(qty_formula, (int, float)) else qty_val
                else:
                    mat_values[mk] = f"={get_column_letter(sc(9))}{current_row}" if qty_formula is not None and not isinstance(qty_formula, (int, float)) else qty_val

            # Strip prefixes from description
            dd = desc
            for pfx in desc_strip_prefixes:
                if dd.startswith(pfx):
                    dd = dd[len(pfx):]
                    break

            write_item(current_row, item_no, dd, unit, qty_val if qty_val != 1 else None, 
                      L, W, H, qty_formula, mat_values, remarks, alt)
            alt = not alt
            current_row += 1

        i_end = current_row - 1
        pu = current_row
        tot = current_row + 1
        write_summary(pu, tot, i_start, i_end)
        total_unit_rows.append(tot)
        current_row += 2

        ws.row_dimensions[current_row].height = 10
        current_row += 1

    # Grand Total
    ws.row_dimensions[current_row].height = 10
    current_row += 1
    for ci in range(1, total_actual+1):
        ws.cell(current_row, ci).fill = _F(GOLD)
    ws.row_dimensions[current_row].height = 5
    current_row += 1

    ws.merge_cells(f"{get_column_letter(sc(1))}{current_row}:{get_column_letter(rem_actual)}{current_row}")
    c = ws.cell(current_row, sc(1))
    c.value = "PROJECT TOTALS  —  All Sections"
    c.font = _ft(13, True, WHITE)
    c.fill = _F(CHARCOAL)
    c.alignment = _al("center")
    ws.row_dimensions[current_row].height = 26
    current_row += 1

    gt = current_row
    ws.row_dimensions[gt].height = 28
    c = ws.cell(gt, sc(9))
    c.value = "Total QTY"
    c.font = _ft(12, True, WHITE)
    c.fill = _F(NAVY)
    c.alignment = _al("center")
    c.border = _thick()
    
    for mi, (key, _) in enumerate(MATERIAL_COLS):
        ci = sc(MAT_INTERNAL_START + mi)
        col_l = get_column_letter(ci)
        cell = ws.cell(gt, ci)
        cell.value = "=" + "+".join(f"{col_l}{r}" for r in total_unit_rows)
        cell.font = _ft(12, True, GOLD)
        cell.fill = _F(NAVY)
        cell.number_format = "0.000"
        cell.alignment = _al("center")
        cell.border = _thick()

    # Bottom label mirror row
    current_row += 1
    max_lines = max((hdr.count("\n")+1) for _, hdr in MATERIAL_COLS)
    label_h = max(max_lines * BASE_H + 10, 56)
    ws.row_dimensions[current_row].height = label_h
    for mi, (key, hdr) in enumerate(MATERIAL_COLS):
        ci = sc(MAT_INTERNAL_START + mi)
        c = ws.cell(current_row, ci)
        c.value = hdr
        c.font = _ft(11, True, WHITE)
        c.fill = _F(MID_BLUE)
        c.alignment = _al("center", "center", True)
        c.border = _B()

    last_data_row = current_row

    # Bottom padding
    for _ in range(PB):
        current_row += 1
        pad_bottom_row(current_row)

    # Right padding
    apply_right_pad_cols(first_data_row, last_data_row)

    apply_widths()
    apply_heights()

    freeze_panes = output_options.get("freeze_panes")
    if freeze_panes:
        ws.freeze_panes = freeze_panes


def generate(json_path, out_path):
    """Main generation function supporting new JSON structure"""
    with open(json_path, 'r', encoding='utf-8') as f:
        data = json.load(f)
    
    # Extract from new structure
    doc = data.get("project_info", {})
    sections = data.get("kitchen_sections", data.get("sections", []))
    fixtures = data.get("installed_fixtures", [])
    section_map = data.get("section_grouping", {})
    material_columns = data.get("material_columns", [])
    calculation_rules = data.get("calculation_rules", {})
    material_identification = data.get("material_identification", {})
    
    # Extract calculation parameters
    sheet_area_m2 = calculation_rules.get("sheet_area_square_meters", 2.88)
    output_options = calculation_rules.get("excel_formatting", {})
    unit_categories = calculation_rules.get("unit_type_mapping", {})
    
    # Default unit categories if not provided
    if not unit_categories:
        unit_categories = {
            "area_based": ["M²", "m2", "SQ M", "SQM", "M2"],
            "volume_based": ["M³", "m3", "CU M", "M3"],
            "linear_based": ["LM", "lm", "L M", "M", "m"],
            "count_based": ["Nr", "nos", "PC", "pcs", "Each", "each"],
            "pair_based": ["Pr", "Pair"],
            "set_based": ["Set", "Kit", "Box"]
        }
    
    # Transform document structure for compatibility with existing functions
    transformed_doc = {
        "project": doc.get("name", ""),
        "location": doc.get("location", ""),
        "phase": doc.get("phase", ""),
        "kitchen_type": doc.get("kitchen_type", "N/A"),
        "total_units": doc.get("total_kitchen_units", 0),
        "main_contractor": doc.get("stakeholders", {}).get("main_contractor", "N/A"),
        "design_consultant": doc.get("stakeholders", {}).get("design_consultant", "N/A"),
        "supervision": doc.get("stakeholders", {}).get("supervision", "N/A"),
        "date": doc.get("document_metadata", {}).get("date", "N/A"),
        "revision": doc.get("document_metadata", {}).get("revision", "N/A"),
        "currency": doc.get("document_metadata", {}).get("currency", "AED"),
        "vat_rate_percent": doc.get("document_metadata", {}).get("vat_percent", 5),
        "drawing_references": doc.get("drawings", []),
        "document_metadata": doc.get("document_metadata", {}),
        "stakeholders": doc.get("stakeholders", {}),
        "name": doc.get("name", ""),
        "title": doc.get("document_metadata", {}).get("title", "BILL OF QUANTITIES")
    }
    
    # Transform material columns format
    transformed_material_cols = []
    for col in material_columns:
        transformed_col = {
            "key": col.get("id"),
            "label": col.get("display_name"),
            "width": col.get("column_width", 14)
        }
        # Handle calculation type
        calc_type = col.get("calculation_type", "area_based")
        if calc_type in ("count_based", "pair_based", "set_based", "fixture_based"):
            transformed_col["count_only"] = True
        elif calc_type == "spacer":
            transformed_col["key"] = f"_blank_{col.get('id')}"
        transformed_material_cols.append(transformed_col)
    
    # Transform material identification rules
    transformed_material_rules = {
        "board_rules": [],
        "addon_rules": [],
        "subgroup_keywords": [],
        "desc_strip_prefixes": []
    }
    
    # Transform sheet materials to board_rules
    for rule in material_identification.get("sheet_materials", []):
        transformed_material_rules["board_rules"].append({
            "key": rule.get("material_id"),
            "thickness": rule.get("required_thickness"),
            "material": rule.get("material_type"),
            "context": rule.get("context_keywords")
        })
    
    # Transform additional materials to addon_rules
    for rule in material_identification.get("additional_materials", []):
        addon_rule = {
            "key": rule.get("material_id"),
            "trigger_spec": rule.get("triggers_in_specification", []),
            "trigger_desc": rule.get("triggers_in_description", []),
            "size_filter": rule.get("size_filter")
        }
        if rule.get("extract_from_remarks"):
            addon_rule["extract_from_remarks"] = True
            addon_rule["regex_pattern"] = rule.get("regex_pattern")
        transformed_material_rules["addon_rules"].append(addon_rule)
    
    # Transform subsection organization
    for rule in material_identification.get("subsection_organization", []):
        transformed_material_rules["subgroup_keywords"].append({
            "label": rule.get("subsection_name"),
            "keywords": rule.get("detection_keywords", []),
            "has_dims": rule.get("has_dimensions", True)
        })
    
    # Transform description prefixes to remove
    transformed_material_rules["desc_strip_prefixes"] = material_identification.get("description_prefixes_to_remove", [])
    
    # Add to transformed document
    transformed_doc["material_detection_rules"] = transformed_material_rules
    transformed_doc["material_columns"] = transformed_material_cols
    transformed_doc["sheet_area_m2"] = sheet_area_m2
    
    # Process items to add missing fields
    for sec in sections:
        components = sec.get("components", [])
        for comp in components:
            # Ensure spec field exists for material detection
            if "specification" not in comp:
                comp["specification"] = comp.get("description", "")
            # Ensure unit field exists with correct case
            if "unit" not in comp and "measurement_unit" in comp:
                comp["unit"] = comp["measurement_unit"]
            # Ensure no_of_units field exists
            if "no_of_units" not in comp:
                comp["no_of_units"] = comp.get("quantity_per_unit", 1)
            # Ensure dimensions are properly nested
            if "dimensions" in comp:
                dims = comp["dimensions"]
                if "length_meters" in dims:
                    comp["length_m"] = dims["length_meters"]
                if "width_meters" in dims:
                    comp["width_m"] = dims["width_meters"]
                if "height_meters" in dims:
                    comp["height_thk_m"] = dims["height_meters"]
    
    # Process fixtures
    for fixture in fixtures:
        if "specification" not in fixture:
            fixture["specification"] = fixture.get("description", "")
        if "unit" not in fixture and "measurement_unit" in fixture:
            fixture["unit"] = fixture["measurement_unit"]
        if "no_of_units" not in fixture:
            fixture["no_of_units"] = fixture.get("quantity_per_unit", 1)
    
    wb = Workbook()
    default_sheet = wb.active
    wb.remove(default_sheet)
    
    # Build sheets with transformed document
    build_summary_sheet(wb, transformed_doc, sections, section_map)
    _build_matrix_sheet(wb, transformed_doc, sections, fixtures, section_map, 
                       transformed_material_cols, sheet_area_m2, output_options, unit_categories)
    
    wb.save(out_path)
    print(f"✓  Saved: {out_path}")
    print(f"   - Project: {doc.get('name', 'N/A')}")
    print(f"   - Kitchen Type: {doc.get('kitchen_type', 'N/A')}")
    print(f"   - Total Units: {doc.get('total_kitchen_units', 0)}")
    print(f"   - Sections: {len(sections)}")
    print(f"   - Fixtures: {len(fixtures)}")
    print(f"   - Material columns: {len(material_columns)}")


if __name__ == "__main__":
    json_in = sys.argv[1] if len(sys.argv) > 1 else "D:/My-CODE_RUSH/projects/Quantity Savior/client/src/lib/boq_data.json"
    xlsx_out = sys.argv[2] if len(sys.argv) > 2 else "BOQ_AlWaha_C1_Enhanced.xlsx"
    generate(json_in, xlsx_out)