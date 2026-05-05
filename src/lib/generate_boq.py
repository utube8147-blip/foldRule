"""
BOQ Material Matrix Generator – Al Waha Residence 01
Generates the same material-matrix takeoff format as the original Excel:
  rows = line items   |   columns = individual materials / hardware
  
Now fully configurable via JSON input file.
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


def _calc_qty(item):
    """Calculate quantity based on dimensions and unit type"""
    L,W,H = item.get("length_m"), item.get("width_m"), item.get("height_thk_m")
    nu, u = item.get("no_of_units"), item.get("unit","")
    if u in ("M²","m2"):
        dims = [d for d in [L,W,H] if d is not None]
        if len(dims)==2:
            base = dims[0]*dims[1]
            return round(base*nu,4) if nu else round(base,4)
    if u in ("M³","m3"):
        dims = [d for d in [L,W,H] if d is not None]
        if len(dims)==3: return round(dims[0]*dims[1]*dims[2],6)
    if u in ("LM","lm","Nr","nos","Pr","Pair","Item","m"): return nu
    return None


def _detect_mat(item, material_rules):
    """
    Detect materials based on JSON configuration rules
    """
    spec = (item.get("specification") or "").lower()
    desc = (item.get("description") or "").lower()
    remarks = (item.get("remarks") or "").lower()
    r = []
    
    # Board material detection
    for rule in material_rules.get("board_rules", []):
        thickness = rule.get("thickness")
        material = rule.get("material")
        context = rule.get("context")
        
        # Check thickness
        thickness_match = (thickness is None or thickness.lower() in spec)
        # Check material
        material_match = (material is None or material in spec)
        # Check context if specified
        context_match = True
        if context:
            context_match = any(ctx in desc for ctx in context)
        
        if thickness_match and material_match and context_match:
            r.append(rule["key"])
            break  # Only one board material per item
    
    # Add-on materials detection
    for rule in material_rules.get("addon_rules", []):
        trigger_spec = rule.get("trigger_spec", [])
        trigger_desc = rule.get("trigger_desc", [])
        size_filter = rule.get("size_filter")
        
        # Check if triggers match
        spec_match = any(t.lower() in spec for t in trigger_spec) if trigger_spec else False
        desc_match = any(t.lower() in desc for t in trigger_desc) if trigger_desc else False
        
        if spec_match or desc_match:
            # Check size filter
            if size_filter:
                if size_filter in spec or size_filter in desc:
                    r.append(rule["key"])
            else:
                r.append(rule["key"])
    
    return list(dict.fromkeys(r))  # Remove duplicates while preserving order


def _extract_lipping_from_remarks(remarks, regex_pattern):
    """Extract lipping length from remarks using regex"""
    if not remarks:
        return None
    match = re.search(regex_pattern, remarks.lower())
    if match:
        return float(match.group(1))
    return None


def _extract_laminate_from_remarks(remarks, regex_pattern):
    """Extract laminate area from remarks using regex"""
    if not remarks:
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
    SPAN = "A{r}:F{r}"

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

    _navy_bar(r, f"BILL OF QUANTITIES  ·  KITCHEN FITOUT  ·  TYPE {doc['kitchen_type']}", size=13, h=36); r += 1

    ws.row_dimensions[r].height = 20
    for ci in range(1, COLS+1):
        ws.cell(r, ci).fill = _F(MID_BLUE)
    ws.cell(r, 1).fill = _F(GOLD)
    ws.merge_cells(f"B{r}:E{r}")
    c = ws.cell(r, 2)
    c.value = f"{doc['project']}   ·   {doc['location']}   ·   {doc['phase']}"
    c.font = _ft(10, False, GOLD_LIGHT, italic=True)
    c.fill = _F(MID_BLUE)
    c.alignment = _al("left", "center")
    r += 1

    _gold_stripe(r, 3); r += 1

    # Project Information
    _section_hdr(r, "Project Information"); r += 1

    details = [
        ("Main Contractor",    doc["main_contractor"]),
        ("Design Consultant",  doc["design_consultant"]),
        ("Supervision",        doc["supervision"]),
        ("Kitchen Type",       doc["kitchen_type"]),
        ("Total Units",        doc["total_units"]),
        ("Date",               doc["date"]),
        ("Revision",           doc["revision"]),
        ("Currency / VAT",     f"{doc['currency']}  (VAT {doc['vat_rate_percent']}%)"),
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
        sec_info = section_map.get(sec["section_id"], {})
        elv_label = sec_info.get("elevation", "–")
        unit_type = sec_info.get("unit_type", "–")
        _tbl_row(
            r,
            sec["section_id"],
            elv_label,
            unit_type,
            len(sec.get("items", [])),
            alt=(i % 2 == 0)
        ); r += 1

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


def _build_matrix_sheet(wb, doc, sections, section_map, material_cols, sheet_area_m2, output_options):
    """Build the BOQ Matrix sheet dynamically from JSON data"""
    ws = wb.create_sheet("BOQ_Matrix")
    ws.sheet_view.showGridLines = False

    # Get output options from JSON
    PR = output_options.get("padding_right", 2)
    PB = output_options.get("padding_bottom", 10)

    # Build material columns list from JSON
    MATERIAL_COLS = [(col["key"], col["label"]) for col in material_cols]
    
    # Create mapping for count_only materials
    count_only_keys = {col["key"] for col in material_cols if col.get("count_only", False)}
    
    # Get material widths from JSON
    mat_widths = {col["key"]: col.get("width", 14) for col in material_cols}

    def sc(internal_col):
        return internal_col

    LEFT_COLS_COUNT = 9
    MAT_INTERNAL_START = 10
    REM_INTERNAL = MAT_INTERNAL_START + len(MATERIAL_COLS)
    rem_actual = sc(REM_INTERNAL)
    total_actual = rem_actual + PR

    # Column widths
    base_widths = {1:4, 2:10, 3:46, 4:9, 5:9, 6:9, 7:9, 8:9, 9:17}
    col_max = {}
    for ic in range(1, LEFT_COLS_COUNT+1):
        col_max[sc(ic)] = base_widths.get(ic, 10)
    for mi, (key, _) in enumerate(MATERIAL_COLS):
        col_max[sc(MAT_INTERNAL_START+mi)] = mat_widths.get(key, 14)
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
        brd = _B() if output_options.get("padding_border", True) else Border()
        for ci in range(1, total_actual+1):
            c = ws.cell(row, ci); c.fill = _F(WHITE); c.border = brd

    def apply_right_pad_cols(r1, r2):
        brd = _B() if output_options.get("padding_border", True) else Border()
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
    c.value = (f"BILL OF QUANTITIES – KITCHEN FITOUT (TYPE {doc['kitchen_type']})   ·   "
               f"{doc['project']}   ·   {doc['location']}   ·   {doc['phase']}")
    c.font = _ft(14, True, WHITE)
    c.fill = _F(NAVY)
    c.alignment = _al("center", "center")
    current_row += 1

    # Info Bar (blank with hidden total units)
    ws.row_dimensions[current_row].height = 24
    for ci in range(1, total_actual+1):
        cell = ws.cell(current_row, ci)
        cell.fill = _F(MID_BLUE)
        cell.border = Border(bottom=Side("medium", color=GOLD))
        cell.value = None
    
    c = ws.cell(current_row, sc(3))
    c.value = ""
    c.font = _ft(10, True, WHITE)
    c.alignment = _al("left", "center")
    
    total_units_value = doc.get('total_units', 0)
    info_bar_row = current_row
    ws.cell(info_bar_row, sc(8)).value = total_units_value
    ws.cell(info_bar_row, sc(8)).font = _ft(11, True, MID_BLUE)
    ws.cell(info_bar_row, sc(8)).fill = _F(MID_BLUE)
    current_row += 1

    # Section Header Writer
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
            nc.value = note
            nc.font = _ft(10, False, SEC_ACCENT, True)
            nc.fill = _F(SEC_BAR_BG)
            nc.alignment = _al("right", "center", True)
            nc.border = Border(top=gb_top, bottom=gb_bottom)
            track_w(rem_actual, note)
        
        track_h(bar, 2)
        return row + 1

    # Column Headers Writer
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
        
        for mi, (key, hdr) in enumerate(MATERIAL_COLS):
            ci = sc(MAT_INTERNAL_START + mi)
            c = ws.cell(row, ci)
            if key.startswith("_blank"):
                c.fill = _F(CHARCOAL)
            else:
                c.value = hdr
                c.font = ff
                c.fill = hf
                c.alignment = fa
                c.border = fb
                track_w(ci, hdr)
        
        c = ws.cell(row, rem_actual)
        c.value = "Remarks"
        c.font = ff
        c.fill = hf
        c.alignment = fa
        c.border = fb

    # Sub-group header writer
    def write_subgrp(row, label):
        ws.row_dimensions[row].height = 16
        c = ws.cell(row, sc(3))
        c.value = label
        c.fill = _F(SUBGRP_BG)
        c.font = _ft(11, True, MID_BLUE)
        c.alignment = _al("left", "center")
        
        for ci in range(1, total_actual+1):
            cell = ws.cell(row, ci)
            if not cell.value:
                cell.fill = _F(SUBGRP_BG)
        
        track_w(sc(3), label)

    # Item row writer
    def write_item(row, s_no, desc, unit, times, L, W, H, qty_f, mat_a, remarks="", alt=False):
        ws.row_dimensions[row].height = 16
        bg = _F(ITEM_ALT) if alt else _F(WHITE)
        brd = _B()
        
        vals = [None, s_no, desc, unit, times, L, W, H, None]
        aligns = ["left", "center", "left", "center", "center", "center", "center", "center", "center"]
        
        for ci, (val, ha) in enumerate(zip(vals, aligns), 1):
            c = ws.cell(row, sc(ci))
            if val is not None:
                c.value = val
            c.fill = bg
            c.border = brd
            c.font = _ft(11)
            c.alignment = _al(ha, "center", wrap=(ci == 3))
            if val:
                track_w(sc(ci), str(val))
        
        if qty_f is not None:
            c = ws.cell(row, sc(9))
            c.value = qty_f
            c.fill = bg
            c.border = brd
            c.alignment = _al("center", "center")
            c.font = _ft(11)
            c.number_format = "0.000"
        
        for mi, (key, _) in enumerate(MATERIAL_COLS):
            ci = sc(MAT_INTERNAL_START + mi)
            c = ws.cell(row, ci)
            if key.startswith("_blank"):
                c.fill = _F("EEEEEE")
                continue
            if key in mat_a:
                c.value = mat_a[key]
                c.fill = _F(PALE_BLUE)
                c.number_format = "0.000"
            else:
                c.fill = bg
            c.border = brd
            c.alignment = _al("center", "center")
            c.font = _ft(11)
        
        c = ws.cell(row, rem_actual)
        c.value = remarks
        c.fill = bg
        c.border = brd
        c.font = _ft(10, False, MID_GREY, True)
        c.alignment = _al("left", "center", True)
        track_w(rem_actual, remarks)
        track_w(sc(3), desc)

    # Summary rows writer
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
            if not key.startswith("_blank"):
                cell.value = f"=SUM({get_column_letter(ci)}{i_start}:{get_column_letter(ci)}{i_end})"
                cell.font = _ft(11)
                cell.fill = _F(LIME_HL)
                cell.number_format = "0.000"
                cell.alignment = _al("center")
                cell.border = _B()
            else:
                cell.fill = _F(LIME_HL)
        
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
            if not key.startswith("_blank"):
                if key in count_only_keys:
                    cell.value = f"={col_l}{pu_row}*H2"
                else:
                    cell.value = f"={col_l}{pu_row}*H2/{sheet_area_m2}"
                cell.font = _ft(11)
                cell.fill = _F(PEACH_HL)
                cell.number_format = "0.000"
                cell.alignment = _al("center")
                cell.border = _B()
            else:
                cell.fill = _F(PEACH_HL)

    # Get material detection rules and subgroup keywords from JSON
    material_rules = doc.get("material_detection_rules", {})
    subgroup_keywords = material_rules.get("subgroup_keywords", [])
    desc_strip_prefixes = material_rules.get("desc_strip_prefixes", [])
    
    total_unit_rows = []

    # Process Sections
    for sec in sections:
        sid = sec["section_id"]
        sec_info = section_map.get(sid, {})
        elv_label = sec_info.get("elevation", "")
        unit_type = sec_info.get("unit_type", "")
        note = sec.get("note", "")
        items = sec.get("items", [])

        current_row = write_sec_hdr(current_row, elv_label, unit_type, note)
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
            item_no = item.get("item_no", "")
            unit = item.get("unit", "")
            remarks = item.get("remarks", "")
            L = item.get("length_m")
            W = item.get("width_m")
            H = item.get("height_thk_m")
            times = item.get("no_of_units")
            dl = desc.lower()
            
            # Detect sub-group using JSON keywords
            sg = None
            for kw_rule in subgroup_keywords:
                keywords = kw_rule.get("keywords", [])
                if any(kw in dl for kw in keywords):
                    sg = kw_rule.get("label")
                    if kw_rule.get("has_dims", True):
                        current_L, current_W, current_H = L, W, H
                    else:
                        current_L, current_W, current_H = None, None, None
                    break
            
            if not sg:
                sg = cur_sg

            if sg and sg != cur_sg:
                cur_sg = sg
                write_subgrp(current_row, sg)
                if current_L:
                    ws.cell(current_row, sc(6)).value = current_L
                if current_W:
                    ws.cell(current_row, sc(7)).value = current_W
                if current_H:
                    ws.cell(current_row, sc(8)).value = current_H
                
                dim_border = Border(
                    left=Side("medium", color=GOLD),
                    right=Side("medium", color=GOLD),
                    top=Side("thin", color=GOLD),
                    bottom=Side("thin", color=GOLD)
                )
                for dim_col in [6, 7, 8]:
                    dim_cell = ws.cell(current_row, sc(dim_col))
                    dim_cell.border = dim_border
                    dim_cell.fill = _F(GOLD_LIGHT)
                    dim_cell.font = _ft(11, True, NAVY)
                    if dim_cell.value is None:
                        dim_cell.value = ""
                
                current_row += 1
                alt = False

            qty_v = _calc_qty(item)
            r = current_row
            qc = get_column_letter(sc(9))
            
            if unit in ("M²", "m2"):
                qf = f"=PRODUCT({get_column_letter(sc(5))}{r}:{get_column_letter(sc(8))}{r})"
            elif unit in ("M³", "m3"):
                qf = (f"={get_column_letter(sc(6))}{r}*{get_column_letter(sc(7))}{r}*{get_column_letter(sc(8))}{r}"
                      if all(x is not None for x in [L, W, H]) else qty_v)
            elif unit in ("LM", "lm"):
                qf = qty_v
            else:
                qf = qty_v

            mat_k = _detect_mat(item, material_rules)
            mat_a = {}
            
            for mk in mat_k:
                if mk in count_only_keys:
                    mat_a[mk] = f"={qc}{r}" if qf is not None else (times or 0)
                elif mk == "laminate":
                    laminate_area = _extract_laminate_from_remarks(remarks, r"([\d.]+)\s*m²")
                    mat_a[mk] = laminate_area if laminate_area else f"={qc}{r}"
                elif mk in ("lipping_grey", "lipping_25", "lipping_18", "lipping_12"):
                    lipping_len = _extract_lipping_from_remarks(remarks, r"([\d.]+)\s*lm")
                    mat_a[mk] = lipping_len if lipping_len else f"={qc}{r}"
                else:
                    mat_a[mk] = f"={qc}{r}"

            # Strip prefixes from description
            dd = desc
            for pfx in desc_strip_prefixes:
                if dd.startswith(pfx):
                    dd = dd[len(pfx):]
                    break

            write_item(current_row, item_no, dd, unit, times, L, W, H, qf, mat_a, remarks, alt)
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
        if not key.startswith("_blank"):
            cell.value = "=" + "+".join(f"{col_l}{r}" for r in total_unit_rows)
            cell.font = _ft(12, True, GOLD)
            cell.fill = _F(NAVY)
            cell.number_format = "0.000"
            cell.alignment = _al("center")
            cell.border = _thick()
        else:
            cell.fill = _F(NAVY)

    # Bottom label mirror row
    current_row += 1
    max_lines = max((hdr.count("\n")+1) for key, hdr in MATERIAL_COLS if not key.startswith("_blank"))
    label_h = max(max_lines * BASE_H + 10, 56)
    ws.row_dimensions[current_row].height = label_h
    for mi, (key, hdr) in enumerate(MATERIAL_COLS):
        ci = sc(MAT_INTERNAL_START + mi)
        c = ws.cell(current_row, ci)
        if not key.startswith("_blank"):
            c.value = hdr
            c.font = _ft(11, True, WHITE)
            c.fill = _F(MID_BLUE)
            c.alignment = _al("center", "center", True)
            c.border = _B()

    last_data_row = current_row

    # Bottom padding
    for _ in range(PADDING_BOTTOM):
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
    """Main generation function"""
    with open(json_path) as f:
        data = json.load(f)
    
    doc = data["document"]
    sections = data["sections"]
    
    # Extract configuration from JSON
    section_map = doc.get("section_map", {})
    material_cols = doc.get("material_columns", [])
    sheet_area_m2 = doc.get("sheet_area_m2", 2.88)
    output_options = doc.get("output_options", {})
    
    # Override script config with JSON values
    global PADDING_RIGHT, PADDING_BOTTOM, PADDING_BORDER, FREEZE_PANES
    PADDING_RIGHT = output_options.get("padding_right", 2)
    PADDING_BOTTOM = output_options.get("padding_bottom", 10)
    PADDING_BORDER = output_options.get("padding_border", True)
    FREEZE_PANES = output_options.get("freeze_panes", None)
    
    wb = Workbook()
    default_sheet = wb.active
    wb.remove(default_sheet)
    
    build_summary_sheet(wb, doc, sections, section_map)
    _build_matrix_sheet(wb, doc, sections, section_map, material_cols, sheet_area_m2, output_options)
    
    wb.save(out_path)
    print(f"✓  Saved: {out_path}")


if __name__ == "__main__":
    json_in = sys.argv[1] if len(sys.argv) > 1 else "D:/My-CODE_RUSH/projects/Quantity Savior/client/src/lib/boq_data.json"
    xlsx_out = sys.argv[2] if len(sys.argv) > 2 else "BOQ_AlWaha_C1_Enhanced.xlsx"
    generate(json_in, xlsx_out)