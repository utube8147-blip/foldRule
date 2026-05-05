"""
BOQ Material Matrix Generator – Al Waha Residence 01
4 sheets: Summary | BOQ_Matrix | Materials_List | Cost_Breakdown

FIXES v2:
  - Fixtures section in BOQ_Matrix: all material cols merged into one clean "INSTALLED FIXTURE" cell
  - Materials_List now includes a fixtures section at the bottom
  - max() on empty MATERIAL_COLS guarded everywhere
  - _blank_ prefix only on calculation_type == "spacer"
  - All write_summary / grand-total blocks skip when MATERIAL_COLS empty
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
SEC_BAR_BG = "0D1B2A"
SEC_ACCENT = "B8962E"
SEC_TAG_BG = "1A3A5C"
SEC_TAG_FG = "C8A84B"
GREEN_HL   = "E8F5E9"
AMBER_HL   = "FFF8E7"
FONT_FACE  = "Calibri"
BASE_H     = 16

# ── Style helpers ──────────────────────────────────────────────────────────
def _S(s="thin", c="BBBBBB"):  return Side(border_style=s, color=c)
def _B(c="BBBBBB"):            s=_S("thin",c); return Border(top=s,bottom=s,left=s,right=s)
def _thick(c=GOLD_LIGHT):      s=_S("medium",c); return Border(top=s,bottom=s,left=s,right=s)
def _F(h):                     return PatternFill("solid", fgColor=h)
def _ft(size=11,bold=False,colour=DARK_TEXT,italic=False):
    return Font(name=FONT_FACE,size=size,bold=bold,color=colour,italic=italic)
def _al(h="left",v="center",wrap=False):
    return Alignment(horizontal=h,vertical=v,wrap_text=wrap)
def _border_row(ws, row, col_start, col_end, bg, top=None, bottom=None):
    t = top    or _S("thin","E0E0E0")
    b = bottom or _S("thin","E0E0E0")
    for ci in range(col_start, col_end+1):
        c = ws.cell(row, ci)
        c.fill   = _F(bg)
        c.border = Border(top=t, bottom=b,
                          left=_S("thin","E0E0E0"),
                          right=_S("thin","E0E0E0"))

# ── Column index constants (BOQ_Matrix) ────────────────────────────────────
COL_SNO   = 2
COL_DESC  = 3
COL_UNIT  = 4
COL_TIMES = 5
COL_L     = 6
COL_W     = 7
COL_H     = 8
COL_QTY   = 9
MAT_START = 10


# ═══════════════════════════════════════════════════════════════════════════
# UTILITY FUNCTIONS
# ═══════════════════════════════════════════════════════════════════════════

def get_calculation_type(unit, unit_categories):
    unit_upper = unit.upper() if unit else ""
    for calc_type, units in unit_categories.items():
        if unit_upper in [u.upper() for u in units]:
            return calc_type
    if unit_upper in ("NR","NOS","PC","PCS","EACH"):   return "count_based"
    if unit_upper in ("PR","PAIR"):                     return "pair_based"
    if unit_upper in ("SET","KIT","BOX"):               return "set_based"
    if unit_upper in ("M²","M2","SQ M","SQM"):         return "area_based"
    if unit_upper in ("M³","M3","CU M"):               return "volume_based"
    if unit_upper in ("LM","L M","M"):                 return "linear_based"
    return "count_based"


def detect_materials(item, material_rules):
    spec = (item.get("specification") or "").lower()
    desc = (item.get("description")   or "").lower()
    detected = []
    for rule in material_rules.get("board_rules", []):
        t = rule.get("thickness"); m = rule.get("material"); ctx = rule.get("context")
        t_ok = (t is None or t.lower() in spec)
        m_ok = (m is None or m in spec)
        c_ok = True
        if ctx:
            c_ok = (any(c.lower() in desc for c in ctx)
                    if isinstance(ctx, list) else ctx.lower() in desc)
        if t_ok and m_ok and c_ok:
            detected.append(rule.get("key")); break
    for rule in material_rules.get("addon_rules", []):
        ts = rule.get("trigger_spec",[]); td = rule.get("trigger_desc",[])
        sf = rule.get("size_filter")
        sm = any(t.lower() in spec for t in ts) if ts else False
        dm = any(t.lower() in desc for t in td) if td else False
        if sm or dm:
            if sf:
                if sf.lower() in spec or sf.lower() in desc:
                    detected.append(rule.get("key"))
            else:
                detected.append(rule.get("key"))
    return list(dict.fromkeys(detected))


def _build_qty_formula(unit, row, active_dim_cols, unit_categories):
    cT = get_column_letter(COL_TIMES)
    calc = get_calculation_type(unit, unit_categories)

    if calc == "area_based":
        if not active_dim_cols:
            return f"=IF({cT}{row}<>\"\",{cT}{row},1)"
        dim_mult = "*".join([f"{col}{row}" for col in active_dim_cols])
        return f"=IFERROR({dim_mult}*IF({cT}{row}<>\"\",{cT}{row},1),\"\")"

    elif calc == "volume_based":
        if len(active_dim_cols) < 3:
            return "\"\""
        dim_mult = "*".join([f"{col}{row}" for col in active_dim_cols])
        return f"=IFERROR({dim_mult}*IF({cT}{row}<>\"\",{cT}{row},1),\"\")"

    elif calc == "linear_based":
        if active_dim_cols:
            return f"=IFERROR({active_dim_cols[0]}{row}*IF({cT}{row}<>\"\",{cT}{row},1),\"\")"
        else:
            return f"=IF({cT}{row}<>\"\",{cT}{row},0)"

    else:
        return f"=IF({cT}{row}<>\"\",{cT}{row},0)"


# ═══════════════════════════════════════════════════════════════════════════
# SHEET 1 – SUMMARY
# ═══════════════════════════════════════════════════════════════════════════

def build_summary_sheet(wb, doc, sections, section_map):
    ws = wb.create_sheet("Summary", 0)
    ws.sheet_view.showGridLines = False
    for col,w in zip("ABCDEF",[3.5,22,36,16,16,3.5]):
        ws.column_dimensions[col].width = w
    COLS=6

    def _gold_stripe(r,h=4):
        ws.row_dimensions[r].height=h
        for ci in range(1,COLS+1): ws.cell(r,ci).fill=_F(GOLD)

    def _navy_bar(r,text,size=13,h=32):
        ws.row_dimensions[r].height=h
        for ci in range(1,COLS+1):
            ws.cell(r,ci).fill=_F(NAVY)
            ws.cell(r,ci).border=Border(bottom=Side("medium",color=GOLD))
        ws.cell(r,1).fill=_F(GOLD)
        ws.merge_cells(f"B{r}:E{r}")
        c=ws.cell(r,2); c.value=text; c.font=_ft(size,True,WHITE)
        c.fill=_F(NAVY); c.alignment=_al("left","center")
        c.border=Border(bottom=Side("medium",color=GOLD))

    def _sec_hdr(r,label):
        ws.row_dimensions[r].height=26
        for ci in range(1,COLS+1):
            ws.cell(r,ci).fill=_F(CHARCOAL)
            ws.cell(r,ci).border=Border(top=Side("medium",color=GOLD),
                                        bottom=Side("thin",color=GOLD_LIGHT))
        ws.cell(r,1).fill=_F(GOLD)
        ws.merge_cells(f"B{r}:E{r}")
        c=ws.cell(r,2); c.value=label.upper(); c.font=_ft(10,True,GOLD_LIGHT)
        c.fill=_F(CHARCOAL); c.alignment=_al("left","center")
        c.border=Border(top=Side("medium",color=GOLD),bottom=Side("thin",color=GOLD_LIGHT))

    def _detail(r,label,value,alt=False):
        ws.row_dimensions[r].height=22
        bg=PALE_BLUE if alt else WHITE
        thin=Side("thin",color="DDEEFF" if alt else "E8E8E8")
        gl=Side("medium",color=GOLD)
        ws.cell(r,1).fill=_F(GOLD); ws.cell(r,1).border=Border(bottom=thin)
        c=ws.cell(r,2); c.value=label; c.font=_ft(9,True,MID_GREY)
        c.fill=_F(bg); c.alignment=_al("left","center")
        c.border=Border(left=gl,bottom=thin)
        ws.merge_cells(f"C{r}:E{r}")
        c=ws.cell(r,3); c.value=value; c.font=_ft(10,True,NAVY)
        c.fill=_F(bg); c.alignment=_al("left","center")
        c.border=Border(right=Side("medium",color=GOLD),bottom=thin)
        ws.cell(r,6).fill=_F(bg); ws.cell(r,6).border=Border(bottom=thin)

    def _col_hdr(r,labels):
        ws.row_dimensions[r].height=26
        for ci in range(1,COLS+1):
            ws.cell(r,ci).fill=_F(MID_BLUE)
            ws.cell(r,ci).border=Border(top=Side("medium",color=GOLD),
                                        bottom=Side("medium",color=GOLD))
        ws.cell(r,1).fill=_F(GOLD)
        for ci,txt in labels:
            c=ws.cell(r,ci); c.value=txt; c.font=_ft(9,True,WHITE)
            c.fill=_F(MID_BLUE); c.alignment=_al("center","center")

    def _tbl_row(r,sec_id,ref,title,count,alt=False):
        ws.row_dimensions[r].height=22
        bg=PALE_BLUE if alt else WHITE
        thin=Side("thin",color="DDEEFF" if alt else "E8E8E8")
        gl=Side("medium",color=GOLD)
        ws.cell(r,1).fill=_F(GOLD); ws.cell(r,1).border=Border(bottom=thin)
        for ci,val,ha in [(2,sec_id,"center"),(3,ref,"center"),
                          (4,title,"left"),(5,count,"center")]:
            c=ws.cell(r,ci); c.value=val
            c.font=_ft(10,False,NAVY if ci in(2,3,5) else DARK_TEXT)
            c.fill=_F(bg); c.alignment=_al(ha,"center")
            bkw=dict(bottom=thin)
            if ci==2: bkw["left"]=gl
            if ci==5: bkw["right"]=Side("medium",color=GOLD)
            c.border=Border(**bkw)
        ws.cell(r,6).fill=_F(bg); ws.cell(r,6).border=Border(bottom=thin)

    r=1
    _gold_stripe(r,4); r+=1
    _navy_bar(r,f"BILL OF QUANTITIES  ·  KITCHEN FITOUT  ·  TYPE {doc.get('kitchen_type','N/A')}",
              size=13,h=36); r+=1
    ws.row_dimensions[r].height=20
    for ci in range(1,COLS+1): ws.cell(r,ci).fill=_F(MID_BLUE)
    ws.cell(r,1).fill=_F(GOLD)
    ws.merge_cells(f"B{r}:E{r}")
    c=ws.cell(r,2)
    c.value=(f"{doc.get('project',doc.get('name',''))}   ·   "
             f"{doc.get('location','')}   ·   {doc.get('phase','')}")
    c.font=_ft(10,False,GOLD_LIGHT,italic=True); c.fill=_F(MID_BLUE); c.alignment=_al("left","center")
    r+=1
    _gold_stripe(r,3); r+=1
    _sec_hdr(r,"Project Information"); r+=1
    for i,(lbl,val) in enumerate([
        ("Main Contractor",   doc.get("main_contractor","N/A")),
        ("Design Consultant", doc.get("design_consultant","N/A")),
        ("Supervision",       doc.get("supervision","N/A")),
        ("Kitchen Type",      doc.get("kitchen_type","N/A")),
        ("Total Units",       doc.get("total_units",0)),
        ("Date",              doc.get("date","N/A")),
        ("Revision",          doc.get("revision","N/A")),
        ("Currency / VAT",    f"{doc.get('currency','AED')}  (VAT {doc.get('vat_rate_percent',5)}%)"),
    ]):
        _detail(r,lbl,val,alt=(i%2==0)); r+=1
    ws.row_dimensions[r].height=8; r+=1
    _sec_hdr(r,"Drawing References"); r+=1
    for i,ref in enumerate(doc.get("drawing_references",[])):
        _detail(r,f"Ref {i+1:02d}",ref,alt=(i%2==0)); r+=1
    ws.row_dimensions[r].height=8; r+=1
    _sec_hdr(r,"Section Summary"); r+=1
    _col_hdr(r,[(2,"Section"),(3,"Reference"),(4,"Description"),(5,"Items")]); r+=1
    for i,sec in enumerate(sections):
        sid=sec.get("section_id","")
        si=section_map.get(sid,{})
        _tbl_row(r,sid,si.get("elevation","–"),
                 si.get("cabinet_type",si.get("unit_type","–")),
                 len(sec.get("components",sec.get("items",[]))),
                 alt=(i%2==0)); r+=1
    ws.row_dimensions[r].height=8; r+=1

    notes = doc.get("additional_notes", {})
    assumptions = notes.get("general_assumptions", [])
    excluded    = notes.get("excluded_from_scope", [])
    if assumptions:
        _sec_hdr(r,"General Assumptions"); r+=1
        for i,n in enumerate(assumptions):
            _detail(r,n.get("category",""),n.get("content",""),alt=(i%2==0)); r+=1
        ws.row_dimensions[r].height=8; r+=1
    if excluded:
        _sec_hdr(r,"Excluded from Scope"); r+=1
        for i,n in enumerate(excluded):
            _detail(r,n.get("item",""),n.get("reason",""),alt=(i%2==0)); r+=1
        ws.row_dimensions[r].height=8; r+=1

    _gold_stripe(r,3); r+=1
    ws.row_dimensions[r].height=20
    ws.merge_cells(f"A{r}:F{r}")
    c=ws.cell(r,1)
    c.value=("All quantities subject to field verification. "
             "Unit rates to be inserted by tendering contractor.")
    c.font=_ft(8,False,MID_GREY,italic=True); c.fill=_F(NAVY); c.alignment=_al("center","center")
    return ws


def _filter_hrefs_by_formula(item, hrefs, raw_dims):
    formula = (item.get("qty_formula") or "").lower()
    if not formula or "fixed" in formula or formula.strip() == "":
        return {}
    filtered = {}
    for dk, href in hrefs.items():
        dim_data = raw_dims.get(dk)
        if dim_data is None:
            continue
        label = (dim_data.get("label", "") if isinstance(dim_data, dict) else "").lower()
        if label and label in formula:
            filtered[dk] = href
    shelf = item.get("shelf_length")
    if shelf is not None:
        shelf_label = (shelf.get("label", "") if isinstance(shelf, dict) else "").lower()
        shelf_val   = shelf.get("value")      if isinstance(shelf, dict) else shelf
        if shelf_label and shelf_label in formula:
            filtered["L"] = ("__value__", shelf_val)
    return filtered


# ═══════════════════════════════════════════════════════════════════════════
# SHEET 2 – BOQ MATRIX
# ═══════════════════════════════════════════════════════════════════════════

def _build_matrix_sheet(wb, doc, sections, fixtures, section_map,
                        material_cols, sheet_area_m2, output_options,
                        unit_categories, auto_rules):
    ws = wb.create_sheet("BOQ_Matrix")
    ws.sheet_view.showGridLines = False

    PR = output_options.get("right_padding_columns", output_options.get("padding_right",2))
    PB = output_options.get("bottom_padding_rows",   output_options.get("padding_bottom",10))

    MATERIAL_COLS   = [(c["key"],c["label"]) for c in material_cols if not c["key"].startswith("_blank")]
    SPACER_COLS     = [c["key"]              for c in material_cols if     c["key"].startswith("_blank")]
    count_only_keys = {c["key"] for c in material_cols if c.get("count_only",False)}
    mat_widths      = {c["key"]:c.get("width",14) for c in material_cols}

    if not MATERIAL_COLS:
        print("WARNING: No material columns found. Check material_columns in JSON.")

    REM_INTERNAL = MAT_START + len(MATERIAL_COLS) + len(SPACER_COLS)
    rem_actual   = REM_INTERNAL
    total_actual = rem_actual + PR

    base_widths={1:4,2:10,3:46,4:9,5:9,6:9,7:9,8:9,9:17}
    col_max={}
    for ic in range(1,10): col_max[ic]=base_widths.get(ic,10)
    for mi,(key,_) in enumerate(MATERIAL_COLS):
        col_max[MAT_START+mi]=mat_widths.get(key,14)
    for si,key in enumerate(SPACER_COLS):
        col_max[MAT_START+len(MATERIAL_COLS)+si]=mat_widths.get(key,3.5)
    col_max[rem_actual]=34

    def track_w(ci,text):
        if text:
            for ln in str(text).split("\n"):
                col_max[ci]=max(col_max.get(ci,10),len(ln)+3)

    row_max_lines={}
    def track_h(row,lines=1):
        row_max_lines[row]=max(row_max_lines.get(row,1),lines)

    def apply_widths():
        for ci in range(rem_actual+1,total_actual+1):
            ws.column_dimensions[get_column_letter(ci)].width=3.5
        for cn,w in col_max.items():
            ws.column_dimensions[get_column_letter(cn)].width=max(w,8)

    def apply_heights():
        for r,lines in row_max_lines.items():
            ws.row_dimensions[r].height=max(lines*BASE_H,BASE_H)

    def pad_bottom(row,h=8):
        ws.row_dimensions[row].height=h
        brd=_B() if output_options.get("border_padding_cells",True) else Border()
        for ci in range(1,total_actual+1):
            c=ws.cell(row,ci); c.fill=_F(WHITE); c.border=brd

    def apply_right_pad(r1,r2):
        brd=_B() if output_options.get("border_padding_cells",True) else Border()
        for r in range(r1,r2+1):
            for ci in range(rem_actual+1,total_actual+1):
                c=ws.cell(r,ci); c.fill=_F(WHITE); c.border=brd

    current_row=1; first_data_row=1

    # Title
    ws.row_dimensions[current_row].height=30
    ws.merge_cells(f"{get_column_letter(1)}{current_row}:{get_column_letter(rem_actual)}{current_row}")
    c=ws.cell(current_row,1)
    dt=doc.get("document_metadata",{}).get("title",doc.get("title","BILL OF QUANTITIES"))
    c.value=(f"{dt} (TYPE {doc.get('kitchen_type','N/A')})   ·   "
             f"{doc.get('project',doc.get('name',''))}   ·   "
             f"{doc.get('location','')}   ·   {doc.get('phase','')}")
    c.font=_ft(14,True,WHITE); c.fill=_F(NAVY); c.alignment=_al("center","center")
    current_row+=1

    # Info bar – H2 holds total_units
    ws.row_dimensions[current_row].height=24
    for ci in range(1,total_actual+1):
        cell=ws.cell(current_row,ci); cell.fill=_F(MID_BLUE)
        cell.border=Border(bottom=Side("medium",color=GOLD)); cell.value=None
    ws.cell(current_row,COL_H).value=doc.get("total_units",0)
    ws.cell(current_row,COL_H).font =_ft(11,True,MID_BLUE)
    ws.cell(current_row,COL_H).fill =_F(MID_BLUE)
    current_row+=1

    # ── inner writers ──────────────────────────────────────────────────────
    def write_sec_hdr(row,elv,utype,note=""):
        ws.row_dimensions[row].height=45
        gbt=Side(border_style="medium",color=GOLD)
        gbb=Side(border_style="medium",color=GOLD)
        for ci in range(1,total_actual+1):
            c=ws.cell(row,ci); c.fill=_F(SEC_BAR_BG); c.border=Border(top=gbt,bottom=gbb)
        tag=ws.cell(row,COL_SNO); tag.value=f"  {elv}  "
        tag.font=_ft(11,True,SEC_TAG_FG); tag.fill=_F(SEC_TAG_BG); tag.alignment=_al("center","center")
        tag.border=Border(left=Side("medium",color=GOLD),right=Side("thin",color=GOLD_LIGHT),top=gbt,bottom=gbb)
        ttl=ws.cell(row,COL_DESC); ttl.value=utype.upper()
        ttl.font=_ft(13,True,WHITE); ttl.fill=_F(SEC_BAR_BG); ttl.alignment=_al("left","center")
        ttl.border=Border(top=gbt,bottom=gbb)
        if note:
            nc=ws.cell(row,rem_actual); nc.value=note[:100]
            nc.font=_ft(10,False,SEC_ACCENT,True); nc.fill=_F(SEC_BAR_BG)
            nc.alignment=_al("right","center",True); nc.border=Border(top=gbt,bottom=gbb)
            track_w(rem_actual,note)
        track_h(row,2); return row+1

    def write_col_hdrs(row):
        ws.row_dimensions[row].height=60
        hf=_F(MID_BLUE); ff=_ft(11,True,WHITE); fa=_al("center","center",True); fb=_thick()
        for ci,h in enumerate(["","S.No","Description","Unit","Times","L","W","H","Total QTY"],1):
            c=ws.cell(row,ci); c.value=h; c.font=ff; c.fill=hf; c.alignment=fa; c.border=fb
            track_w(ci,h)
        for mi,(key,hdr) in enumerate(MATERIAL_COLS):
            ci=MAT_START+mi; c=ws.cell(row,ci)
            c.value=hdr; c.font=ff; c.fill=hf; c.alignment=fa; c.border=fb; track_w(ci,hdr)
        for si,key in enumerate(SPACER_COLS):
            ci=MAT_START+len(MATERIAL_COLS)+si
            ws.cell(row,ci).fill=_F(CHARCOAL); ws.cell(row,ci).border=fb
        c=ws.cell(row,rem_actual); c.value="Remarks"
        c.font=ff; c.fill=hf; c.alignment=fa; c.border=fb

    def write_comp_hdr(row,name,dims_dict):
        ws.row_dimensions[row].height = 28
        for ci in range(1,total_actual+1): ws.cell(row,ci).fill=_F(SUBGRP_BG)
        c=ws.cell(row,COL_DESC); c.value=name; c.fill=_F(SUBGRP_BG)
        c.font=_ft(11,True,MID_BLUE); c.alignment=_al("left","center"); track_w(COL_DESC,name)
        db=Border(left=Side("medium",color=GOLD),right=Side("medium",color=GOLD),
                top=Side("thin",color=GOLD),bottom=Side("thin",color=GOLD))
        hrefs={}
        is_back_panel = "back" in name.lower() or "rear" in name.lower()
        for dk,ci_idx in [("L",COL_L),("W",COL_W),("H",COL_H)]:
            if is_back_panel and dk == "H":
                cell = ws.cell(row,ci_idx)
                cell.value = "—"; cell.fill = _F(SUBGRP_BG)
                cell.font = _ft(11,False,CHARCOAL); cell.alignment = _al("center","center")
                cell.border = db; continue
            val = dims_dict.get(dk)
            cell = ws.cell(row,ci_idx)
            if val is not None:
                cell.value = val; cell.fill = _F(GOLD_LIGHT)
                cell.font = _ft(11,True,NAVY); cell.alignment = _al("center","center")
                cell.border = db; cell.number_format = "0.000"
                hrefs[dk] = f"${get_column_letter(ci_idx)}${row}"
            else:
                cell.value = "—"; cell.fill = _F(SUBGRP_BG)
                cell.font = _ft(11,False,CHARCOAL); cell.alignment = _al("center","center")
                cell.border = db
        return row+1, hrefs

    def write_item(row,s_no,desc,unit,times_val,hrefs,mat_set,remarks="",alt=False):
        ws.row_dimensions[row].height = 18
        bg=_F("F8F9FC") if alt else _F(WHITE)
        brc="E8ECF1" if alt else "EEF2F7"
        brd=Border(left=Side(style="thin",color=brc),right=Side(style="thin",color=brc),
                top=Side(style="thin",color=brc),bottom=Side(style="thin",color=brc))
        ws.cell(row,COL_SNO).value=s_no; ws.cell(row,COL_SNO).fill=bg
        ws.cell(row,COL_SNO).font=_ft(10,True,NAVY); ws.cell(row,COL_SNO).alignment=_al("center","center")
        ws.cell(row,COL_SNO).border=brd
        c=ws.cell(row,COL_DESC); c.value=desc; c.fill=bg; c.font=_ft(10,False,"2C3E50")
        c.alignment=_al("left","center",wrap=True); c.border=brd; track_w(COL_DESC,desc)
        ws.cell(row,COL_UNIT).value=unit; ws.cell(row,COL_UNIT).fill=bg
        ws.cell(row,COL_UNIT).font=_ft(10,False,"5A6C7D"); ws.cell(row,COL_UNIT).alignment=_al("center","center")
        ws.cell(row,COL_UNIT).border=brd
        c=ws.cell(row,COL_TIMES)
        if times_val is not None and times_val!="" and times_val!=1:
            c.value=times_val; c.fill=_F("FFF8E7"); c.font=_ft(10,True,GOLD)
        else:
            c.value=""; c.fill=bg
        c.alignment=_al("center","center"); c.border=brd

        active_dims = []
        for dk, ci_idx in [("L", COL_L), ("W", COL_W), ("H", COL_H)]:
            c = ws.cell(row, ci_idx)
            href_val = hrefs.get(dk)
            if href_val is not None:
                if isinstance(href_val, tuple) and href_val[0] == "__value__":
                    c.value = href_val[1]
                    c.font = _ft(10, True, "B8962E")
                else:
                    c.value = f"={href_val}"
                    c.font = _ft(10, False, "3A5C8A")
                c.number_format = "0.000"
                active_dims.append(get_column_letter(ci_idx))
            else:
                c.value = ""
                c.font = _ft(10, False, "5A6C7D")
                c.number_format = "0.000"
            c.fill = bg; c.alignment = _al("center", "center"); c.border = brd

        qty_formula = _build_qty_formula(unit, row, active_dims, unit_categories)
        qc=ws.cell(row,COL_QTY)
        qc.value=qty_formula
        qc.font=_ft(10,True,"1A5C3A"); qc.fill=_F("E8F5E9"); qc.alignment=_al("center","center")
        qc.border=brd; qc.number_format="0.000"

        qref=f"{get_column_letter(COL_QTY)}{row}"
        for mi,(key,_) in enumerate(MATERIAL_COLS):
            ci=MAT_START+mi; c=ws.cell(row,ci)
            if key in mat_set:
                c.value=f"={qref}"; c.fill=_F("EBF3FA"); c.font=_ft(10,False,"2A6496"); c.number_format="0.000"
            else: c.fill=bg
            c.border=brd; c.alignment=_al("center","center")
        for si in range(len(SPACER_COLS)):
            ci=MAT_START+len(MATERIAL_COLS)+si; c=ws.cell(row,ci); c.fill=bg; c.border=brd
        c=ws.cell(row,rem_actual); c.value=remarks; c.fill=bg
        c.font=_ft(9,False,"8A9BAE",italic=True); c.alignment=_al("left","center",True); c.border=brd
        track_w(rem_actual,remarks)

    def write_summary(pu_row,tot_row,i_start,i_end):
        if not MATERIAL_COLS: return
        ws.row_dimensions[pu_row].height=20
        c=ws.cell(pu_row,COL_QTY); c.value="Per Unit"; c.font=_ft(11,True)
        c.fill=_F(LIME_HL); c.alignment=_al("center")
        for mi,(key,_) in enumerate(MATERIAL_COLS):
            ci=MAT_START+mi; cl=get_column_letter(ci); cell=ws.cell(pu_row,ci)
            cell.value=f"=SUM({cl}{i_start}:{cl}{i_end})"
            cell.font=_ft(11); cell.fill=_F(LIME_HL); cell.number_format="0.000"
            cell.alignment=_al("center"); cell.border=_B()
        ws.row_dimensions[tot_row].height=22
        ws.cell(tot_row,COL_H).value="=H2"
        ws.cell(tot_row,COL_H).font=_ft(13,True,"FF0000")
        ws.cell(tot_row,COL_H).alignment=_al("center")
        c=ws.cell(tot_row,COL_QTY); c.value="Total Unit"; c.font=_ft(11,True)
        c.fill=_F(PEACH_HL); c.alignment=_al("center"); c.border=_B()
        for mi,(key,_) in enumerate(MATERIAL_COLS):
            ci=MAT_START+mi; cl=get_column_letter(ci); cell=ws.cell(tot_row,ci)
            cell.value=(f"={cl}{pu_row}*H2" if key in count_only_keys
                        else f"={cl}{pu_row}*H2/{sheet_area_m2}")
            cell.font=_ft(11); cell.fill=_F(PEACH_HL); cell.number_format="0.000"
            cell.alignment=_al("center"); cell.border=_B()

    # ── process sections ───────────────────────────────────────────────────
    material_rules      = doc.get("material_detection_rules",{})
    desc_strip_prefixes = material_rules.get("desc_strip_prefixes",[])
    total_unit_rows=[]

    for sec in sections:
        sid=sec.get("section_id",""); sec_note=sec.get("notes",sec.get("note",""))
        si=section_map.get(sid,{})
        elv=si.get("elevation",sid); utype=si.get("cabinet_type",si.get("unit_type","Section"))
        current_row=write_sec_hdr(current_row,elv,utype,sec_note)
        write_col_hdrs(current_row); current_row+=1
        i_start=current_row; alt=False

        for comp in sec.get("components",sec.get("items",[])):
            cname=comp.get("component_name",comp.get("name",""))
            raw=comp.get("dimensions",{})
            def _ed(raw,k):
                v=raw.get(k)
                return v.get("value") if isinstance(v,dict) else v
            dims={k:_ed(raw,k) for k in("L","W","H") if _ed(raw,k) is not None}
            current_row,hrefs=write_comp_hdr(current_row,cname,dims)
            for item in comp.get("items",[]):
                ino=item.get("item_number",item.get("item_no",""))
                desc=item.get("description",""); unit=item.get("measurement_unit",item.get("unit","M²"))
                remarks=item.get("remarks",""); pc=item.get("panel_count")
                tv=pc if pc not in(None,0,1) else None
                dd=desc
                for pfx in desc_strip_prefixes:
                    if dd.startswith(pfx): dd=dd[len(pfx):]; break
                assigned=item.get("material")
                mat_keys=[assigned] if assigned else detect_materials(item,material_rules)
                item_hrefs = _filter_hrefs_by_formula(item, hrefs, raw)
                write_item(current_row,ino,dd,unit,tv,item_hrefs,set(mat_keys),remarks,alt)
                alt=not alt; current_row+=1

        i_end=current_row-1; pu=current_row; tot=current_row+1
        write_summary(pu,tot,i_start,i_end)
        total_unit_rows.append(tot); current_row+=2
        ws.row_dimensions[current_row].height=10; current_row+=1

    # ── FIXTURES SECTION ───────────────────────────────────────────────────
    # Clean, aesthetic layout: no redundant material columns.
    # Uses a compact 6-column layout merged across the material zone.
    if fixtures:
        current_row = write_sec_hdr(current_row, "FX", "Kitchen Fixtures – Installed Items Schedule")

        # ── fixture column header ──────────────────────────────────────────
        ws.row_dimensions[current_row].height = 48
        FX_COLS = [
            (COL_SNO,  "S.No",          "center", 9),
            (COL_DESC, "Description",   "left",   11),
            (COL_UNIT, "Unit",          "center", 9),
            (COL_TIMES,"Qty / Unit",    "center", 10),
            (COL_QTY,  "Total Qty\n(Project)", "center", 10),
            (rem_actual,"Remarks",      "left",   9),
        ]
        # Fill entire row with dark background first
        for ci in range(1, total_actual+1):
            c = ws.cell(current_row, ci)
            c.fill = _F(CHARCOAL)
            c.border = Border(top=Side("medium",color=GOLD), bottom=Side("medium",color=GOLD))

        # Gold accent col 1
        ws.cell(current_row, 1).fill = _F(GOLD)

        # Fill material zone cols with a single merged "MATERIAL SCOPE" label
        mat_start_ci = MAT_START
        mat_end_ci   = rem_actual - 1
        if mat_end_ci >= mat_start_ci:
            ws.merge_cells(
                start_row=current_row, start_column=mat_start_ci,
                end_row=current_row,   end_column=mat_end_ci
            )
            mc = ws.cell(current_row, mat_start_ci)
            mc.value = "— MATERIAL SCOPE N/A  ·  Installed Fixtures Only —"
            mc.font  = _ft(9, False, MID_GREY, italic=True)
            mc.fill  = _F(CHARCOAL)
            mc.alignment = _al("center","center")
            mc.border = Border(top=Side("medium",color=GOLD), bottom=Side("medium",color=GOLD))

        # Named columns
        for ci, lbl, ha, sz in FX_COLS:
            if ci == rem_actual and mat_end_ci >= mat_start_ci:
                pass  # rem_actual is outside merge, write normally
            c = ws.cell(current_row, ci)
            c.value = lbl; c.font = _ft(sz, True, WHITE)
            c.fill = _F(MID_BLUE); c.alignment = _al(ha,"center",True)
            c.border = Border(top=Side("medium",color=GOLD), bottom=Side("medium",color=GOLD),
                              left=Side("thin",color=GOLD_LIGHT), right=Side("thin",color=GOLD_LIGHT))
        current_row += 1

        # ── fixture rows ───────────────────────────────────────────────────
        alt = False
        for fx in fixtures:
            ino     = fx.get("item_number","")
            desc    = fx.get("description","")
            unit    = fx.get("measurement_unit","Each")
            remarks = fx.get("remarks","")
            qty     = fx.get("quantity_per_unit", 1)

            ws.row_dimensions[current_row].height = 22
            bg  = "F2F4F8" if alt else WHITE
            brc = "DDE3EE" if alt else "E8EDF5"
            brd = Border(left=Side("thin",color=brc), right=Side("thin",color=brc),
                         top=Side("thin",color=brc),  bottom=Side("thin",color=brc))

            # Fill all cells with base bg first
            for ci in range(1, total_actual+1):
                ws.cell(current_row, ci).fill = _F(bg)
                ws.cell(current_row, ci).border = brd

            # Gold accent left
            ws.cell(current_row, 1).fill  = _F(GOLD)
            ws.cell(current_row, 1).border = Border(bottom=Side("thin",color="E0C060"))

            # S.No
            c = ws.cell(current_row, COL_SNO)
            c.value=ino; c.font=_ft(10,True,NAVY); c.alignment=_al("center","center"); c.border=brd

            # Description
            c = ws.cell(current_row, COL_DESC)
            c.value=desc; c.font=_ft(10,False,DARK_TEXT)
            c.alignment=_al("left","center",wrap=True); c.border=brd; track_w(COL_DESC,desc)

            # Unit
            c = ws.cell(current_row, COL_UNIT)
            c.value=unit; c.font=_ft(10,False,"5A6C7D"); c.alignment=_al("center","center"); c.border=brd

            # Qty per unit
            c = ws.cell(current_row, COL_TIMES)
            c.value=qty; c.font=_ft(10,True,NAVY)
            c.fill=_F("EBF5FB"); c.alignment=_al("center","center"); c.border=brd

            # L / W / H — merge these into one clean "N/A" cell
            if COL_H >= COL_L:
                ws.merge_cells(start_row=current_row, start_column=COL_L,
                               end_row=current_row,   end_column=COL_H)
            mc = ws.cell(current_row, COL_L)
            mc.value = "—"; mc.font = _ft(9,False,MID_GREY,italic=True)
            mc.fill = _F(bg); mc.alignment = _al("center","center"); mc.border = brd

            # Total qty
            qc = ws.cell(current_row, COL_QTY)
            qc.value = f"={get_column_letter(COL_TIMES)}{current_row}*H2"
            qc.font=_ft(10,True,"1A5C3A"); qc.fill=_F("E8F5E9")
            qc.alignment=_al("center","center"); qc.border=brd; qc.number_format="0"

            # Material zone — single merged "N/A" stripe
            if mat_end_ci >= mat_start_ci:
                ws.merge_cells(start_row=current_row, start_column=mat_start_ci,
                               end_row=current_row,   end_column=mat_end_ci)
            mc2 = ws.cell(current_row, mat_start_ci)
            mc2.value = "—"; mc2.font = _ft(9,False,MID_GREY,italic=True)
            mc2.fill = _F("F0F2F5"); mc2.alignment = _al("center","center")
            mc2.border = Border(left=Side("thin",color=brc), right=Side("thin",color=brc),
                                top=Side("thin",color=brc),  bottom=Side("thin",color=brc))

            # Remarks
            c = ws.cell(current_row, rem_actual)
            c.value=remarks; c.font=_ft(9,False,"8A9BAE",italic=True)
            c.fill=_F(bg); c.alignment=_al("left","center",True); c.border=brd
            track_w(rem_actual,remarks)

            alt = not alt
            current_row += 1

        ws.row_dimensions[current_row].height = 10
        current_row += 2

    # ── grand total ────────────────────────────────────────────────────────
    ws.row_dimensions[current_row].height=10; current_row+=1
    for ci in range(1,total_actual+1): ws.cell(current_row,ci).fill=_F(GOLD)
    ws.row_dimensions[current_row].height=5; current_row+=1
    ws.merge_cells(f"{get_column_letter(1)}{current_row}:{get_column_letter(rem_actual)}{current_row}")
    c=ws.cell(current_row,1); c.value="PROJECT TOTALS  —  All Sections"
    c.font=_ft(13,True,WHITE); c.fill=_F(CHARCOAL); c.alignment=_al("center")
    ws.row_dimensions[current_row].height=26; current_row+=1

    gt_row=current_row
    ws.row_dimensions[gt_row].height=28
    c=ws.cell(gt_row,COL_QTY); c.value="Total QTY"
    c.font=_ft(12,True,WHITE); c.fill=_F(NAVY); c.alignment=_al("center"); c.border=_thick()
    if MATERIAL_COLS and total_unit_rows:
        for mi,(key,_) in enumerate(MATERIAL_COLS):
            ci=MAT_START+mi; cl=get_column_letter(ci); cell=ws.cell(gt_row,ci)
            cell.value="="+"+".join(f"{cl}{r}" for r in total_unit_rows)
            cell.font=_ft(12,True,GOLD); cell.fill=_F(NAVY); cell.number_format="0.000"
            cell.alignment=_al("center"); cell.border=_thick()
    current_row+=1

    max_lines=max((h.count("\n")+1 for _,h in MATERIAL_COLS),default=1)
    ws.row_dimensions[current_row].height=max(max_lines*BASE_H+10,56)
    for mi,(key,hdr) in enumerate(MATERIAL_COLS):
        ci=MAT_START+mi; c=ws.cell(current_row,ci)
        c.value=hdr; c.font=_ft(11,True,WHITE); c.fill=_F(MID_BLUE)
        c.alignment=_al("center","center",True); c.border=_B()
    last_data_row=current_row
    for _ in range(PB): current_row+=1; pad_bottom(current_row)
    apply_right_pad(first_data_row,last_data_row)
    apply_widths(); apply_heights()
    fp=output_options.get("freeze_panes")
    if fp: ws.freeze_panes=fp

    return gt_row


# ═══════════════════════════════════════════════════════════════════════════
# SHEET 3 – MATERIALS LIST
# Pulls totals from BOQ_Matrix grand-total row + adds fixtures section
# ═══════════════════════════════════════════════════════════════════════════

def build_materials_sheet(wb, doc, material_cols, gt_row, sheet_area_m2, fixtures=None):
    ws = wb.create_sheet("Materials_List")
    ws.sheet_view.showGridLines = False

    MATERIAL_COLS = [(c["key"],c["label"],c) for c in material_cols
                     if not c["key"].startswith("_blank")]
    count_only    = {c["key"] for c in material_cols if c.get("count_only",False)}

    col_widths = {1:4, 2:8, 3:28, 4:32, 5:12, 6:18, 7:14, 8:14, 9:28, 10:4}
    for ci,w in col_widths.items():
        ws.column_dimensions[get_column_letter(ci)].width = w

    r = 1

    # ── header banner ──────────────────────────────────────────────────────
    ws.row_dimensions[r].height = 5
    for ci in range(1,11): ws.cell(r,ci).fill=_F(GOLD)
    r+=1
    ws.row_dimensions[r].height = 36
    ws.merge_cells(f"B{r}:I{r}")
    c=ws.cell(r,2); c.value="MATERIALS LIST  ·  PROJECT TOTAL QUANTITIES"
    c.font=_ft(14,True,WHITE); c.fill=_F(NAVY); c.alignment=_al("left","center")
    c.border=Border(bottom=Side("medium",color=GOLD))
    ws.cell(r,1).fill=_F(GOLD); ws.cell(r,10).fill=_F(NAVY)
    r+=1
    ws.row_dimensions[r].height = 22
    ws.merge_cells(f"B{r}:I{r}")
    c=ws.cell(r,2)
    c.value=(f"{doc.get('project','')}   ·   {doc.get('location','')}   ·   "
             f"TYPE {doc.get('kitchen_type','N/A')}   ·   "
             f"{doc.get('total_units',0)} Units")
    c.font=_ft(10,False,GOLD_LIGHT,italic=True); c.fill=_F(MID_BLUE); c.alignment=_al("left","center")
    ws.cell(r,1).fill=_F(GOLD); ws.cell(r,10).fill=_F(MID_BLUE)
    r+=1
    ws.row_dimensions[r].height = 4
    for ci in range(1,11): ws.cell(r,ci).fill=_F(GOLD)
    r+=1

    ws.row_dimensions[r].height = 20
    ws.merge_cells(f"B{r}:I{r}")
    c=ws.cell(r,2)
    c.value=f"★  All quantities are live-linked from BOQ_Matrix row {gt_row}. Edit dimensions in BOQ_Matrix; this sheet updates automatically."
    c.font=_ft(9,False,MID_GREY,italic=True); c.fill=_F(PALE_BLUE); c.alignment=_al("left","center")
    ws.cell(r,1).fill=_F(PALE_BLUE); ws.cell(r,10).fill=_F(PALE_BLUE)
    r+=1
    ws.row_dimensions[r].height = 8; r+=1

    # ── column headers ─────────────────────────────────────────────────────
    ws.row_dimensions[r].height = 50
    hdrs = ["","#","Material ID","Description / Specification",
            "Unit","Total\nQuantity","Sheet Size\n(m²)","Sheets\nNeeded","Remarks",""]
    for ci,h in enumerate(hdrs,1):
        c=ws.cell(r,ci); c.value=h if h else ""
        c.font=_ft(11,True,WHITE); c.fill=_F(MID_BLUE)
        c.alignment=_al("center","center",True); c.border=_thick()
    r+=1

    boq_mat_cols = [(c["key"],c["label"],c) for c in material_cols
                    if not c["key"].startswith("_blank")]
    mat_col_index = {key: MAT_START+mi for mi,(key,_,__) in enumerate(boq_mat_cols)}

    # ── material rows ──────────────────────────────────────────────────────
    for idx,(key,label,col_cfg) in enumerate(MATERIAL_COLS):
        alt = (idx%2==0)
        bg  = PALE_BLUE if alt else WHITE
        ws.row_dimensions[r].height = 22
        brd = Border(left=Side("thin",color="DDEEFF" if alt else "E8E8E8"),
                     right=Side("thin",color="DDEEFF" if alt else "E8E8E8"),
                     top=Side("thin",color="DDEEFF" if alt else "E8E8E8"),
                     bottom=Side("thin",color="DDEEFF" if alt else "E8E8E8"))
        gl = Side("medium",color=GOLD)

        ws.cell(r,1).fill=_F(GOLD); ws.cell(r,1).border=Border(bottom=_S("thin","E8E8E8"))

        c=ws.cell(r,2); c.value=idx+1; c.font=_ft(10,True,NAVY)
        c.fill=_F(bg); c.alignment=_al("center","center"); c.border=Border(left=gl,bottom=brd.bottom)

        c=ws.cell(r,3); c.value=key; c.font=_ft(9,False,MID_GREY,italic=True)
        c.fill=_F(bg); c.alignment=_al("left","center"); c.border=brd

        c=ws.cell(r,4); c.value=label.replace("\n"," ")
        c.font=_ft(10,False,DARK_TEXT); c.fill=_F(bg)
        c.alignment=_al("left","center",wrap=True); c.border=brd

        is_count  = key in count_only
        is_linear = any(x in key.lower() for x in ("lipping","lm","skirting","runner"))
        is_volume = "volume" in key.lower() or "timber" in key.lower()
        if is_count:    unit_str="Nr / Pr"
        elif is_volume: unit_str="M³"
        elif is_linear: unit_str="LM"
        else:           unit_str="M²"
        c=ws.cell(r,5); c.value=unit_str; c.font=_ft(10,False,"5A6C7D")
        c.fill=_F(bg); c.alignment=_al("center","center"); c.border=brd

        boq_ci = mat_col_index.get(key)
        if boq_ci:
            boq_col_l = get_column_letter(boq_ci)
            c=ws.cell(r,6)
            c.value=f"=BOQ_Matrix!{boq_col_l}{gt_row}"
            c.font=_ft(11,True,"1A5C3A"); c.fill=_F(GREEN_HL)
            c.alignment=_al("center","center"); c.border=brd; c.number_format="0.000"
        else:
            ws.cell(r,6).fill=_F(bg); ws.cell(r,6).border=brd

        c=ws.cell(r,7)
        if not is_count and not is_linear and not is_volume:
            c.value=sheet_area_m2; c.font=_ft(10,False,CHARCOAL); c.fill=_F(AMBER_HL)
            c.alignment=_al("center","center"); c.border=brd; c.number_format="0.00"
        else:
            c.value="—"; c.font=_ft(10,False,MID_GREY); c.fill=_F(bg)
            c.alignment=_al("center","center"); c.border=brd

        c=ws.cell(r,8)
        qty_ref=f"F{r}"
        if not is_count and not is_linear and not is_volume and boq_ci:
            c.value=f"=IFERROR(CEILING({qty_ref}/G{r},1),\"\")"
            c.font=_ft(11,True,NAVY); c.fill=_F(PALE_BLUE)
            c.alignment=_al("center","center"); c.border=brd; c.number_format="0"
        else:
            c.value="—"; c.font=_ft(10,False,MID_GREY); c.fill=_F(bg)
            c.alignment=_al("center","center"); c.border=brd

        remarks_txt = col_cfg.get("remarks","")
        c=ws.cell(r,9); c.value=remarks_txt if remarks_txt else ""
        c.font=_ft(9,False,"8A9BAE",italic=True); c.fill=_F(bg)
        c.alignment=_al("left","center",True); c.border=Border(right=gl,bottom=brd.bottom)

        ws.cell(r,10).fill=_F(bg); ws.cell(r,10).border=Border(bottom=brd.bottom)
        r+=1

    # ── FIXTURES SECTION in Materials_List ─────────────────────────────────
    if fixtures:
        ws.row_dimensions[r].height = 8; r+=1

        # Section header bar
        ws.row_dimensions[r].height = 30
        for ci in range(1,11):
            ws.cell(r,ci).fill=_F(CHARCOAL)
            ws.cell(r,ci).border=Border(top=Side("medium",color=GOLD),
                                        bottom=Side("medium",color=GOLD))
        ws.cell(r,1).fill=_F(GOLD)
        ws.merge_cells(f"B{r}:I{r}")
        c=ws.cell(r,2); c.value="INSTALLED FIXTURES  ·  SCHEDULE OF QUANTITIES"
        c.font=_ft(11,True,GOLD_LIGHT); c.fill=_F(CHARCOAL); c.alignment=_al("left","center")
        c.border=Border(top=Side("medium",color=GOLD),bottom=Side("medium",color=GOLD))
        r+=1

        # Fixtures column headers
        ws.row_dimensions[r].height = 40
        fx_hdrs = ["","#","Item No","Description","Unit",
                   "Qty / Unit","Total Qty\n(Project)","—","Remarks",""]
        for ci,h in enumerate(fx_hdrs,1):
            c=ws.cell(r,ci); c.value=h if h else ""
            c.font=_ft(10,True,WHITE); c.fill=_F(MID_BLUE)
            c.alignment=_al("center","center",True)
            c.border=Border(top=Side("medium",color=GOLD),bottom=Side("medium",color=GOLD),
                            left=Side("thin",color=GOLD_LIGHT),right=Side("thin",color=GOLD_LIGHT))
        r+=1

        # Fixture rows
        alt = False
        for fx_idx, fx in enumerate(fixtures):
            ino     = fx.get("item_number","")
            desc    = fx.get("description","")
            unit    = fx.get("measurement_unit","Each")
            remarks = fx.get("remarks","")
            qty_pu  = fx.get("quantity_per_unit", 1)

            bg  = PALE_BLUE if alt else WHITE
            ws.row_dimensions[r].height = 22
            brd = Border(left=Side("thin",color="DDEEFF" if alt else "E8E8E8"),
                         right=Side("thin",color="DDEEFF" if alt else "E8E8E8"),
                         top=Side("thin",color="DDEEFF" if alt else "E8E8E8"),
                         bottom=Side("thin",color="DDEEFF" if alt else "E8E8E8"))
            gl = Side("medium",color=GOLD)

            ws.cell(r,1).fill=_F(GOLD); ws.cell(r,1).border=Border(bottom=brd.bottom)

            # # row index
            c=ws.cell(r,2); c.value=fx_idx+1; c.font=_ft(10,True,NAVY)
            c.fill=_F(bg); c.alignment=_al("center","center")
            c.border=Border(left=gl,bottom=brd.bottom)

            # Item No
            c=ws.cell(r,3); c.value=ino; c.font=_ft(9,False,MID_GREY,italic=True)
            c.fill=_F(bg); c.alignment=_al("left","center"); c.border=brd

            # Description
            c=ws.cell(r,4); c.value=desc; c.font=_ft(10,False,DARK_TEXT)
            c.fill=_F(bg); c.alignment=_al("left","center",wrap=True); c.border=brd

            # Unit
            c=ws.cell(r,5); c.value=unit; c.font=_ft(10,False,"5A6C7D")
            c.fill=_F(bg); c.alignment=_al("center","center"); c.border=brd

            # Qty per unit
            c=ws.cell(r,6); c.value=qty_pu; c.font=_ft(10,True,NAVY)
            c.fill=_F(GREEN_HL); c.alignment=_al("center","center"); c.border=brd; c.number_format="0"

            # Total qty = qty_pu × total_units (from BOQ_Matrix H2)
            c=ws.cell(r,7)
            c.value=f"=F{r}*BOQ_Matrix!H2"
            c.font=_ft(11,True,"1A5C3A"); c.fill=_F(GREEN_HL)
            c.alignment=_al("center","center"); c.border=brd; c.number_format="0"

            # Sheets needed — N/A for fixtures
            c=ws.cell(r,8); c.value="—"; c.font=_ft(10,False,MID_GREY)
            c.fill=_F(bg); c.alignment=_al("center","center"); c.border=brd

            # Remarks
            c=ws.cell(r,9); c.value=remarks; c.font=_ft(9,False,"8A9BAE",italic=True)
            c.fill=_F(bg); c.alignment=_al("left","center",True)
            c.border=Border(right=gl,bottom=brd.bottom)

            ws.cell(r,10).fill=_F(bg); ws.cell(r,10).border=Border(bottom=brd.bottom)
            alt = not alt
            r+=1

    # ── footer ─────────────────────────────────────────────────────────────
    ws.row_dimensions[r].height=5
    for ci in range(1,11): ws.cell(r,ci).fill=_F(GOLD)
    r+=1
    ws.row_dimensions[r].height=20
    ws.merge_cells(f"B{r}:I{r}")
    c=ws.cell(r,2)
    c.value=("Sheet size basis: "
             f"{sheet_area_m2} m² per board  ·  "
             "Sheets Needed rounds UP to whole boards  ·  "
             "Count/Linear/Volume items show actual quantities.")
    c.font=_ft(8,False,MID_GREY,italic=True); c.fill=_F(NAVY); c.alignment=_al("center","center")
    ws.cell(r,1).fill=_F(NAVY); ws.cell(r,10).fill=_F(NAVY)
    return ws


# ═══════════════════════════════════════════════════════════════════════════
# SHEET 4 – COST BREAKDOWN
# ═══════════════════════════════════════════════════════════════════════════

def build_cost_breakdown_sheet(wb, doc, material_cols, mat_list_data_start_row,
                                mat_list_ws_name="Materials_List", fixtures=None):
    ws = wb.create_sheet("Cost_Breakdown")
    ws.sheet_view.showGridLines = False

    MATERIAL_COLS = [(c["key"],c["label"],c) for c in material_cols
                     if not c["key"].startswith("_blank")]
    count_only    = {c["key"] for c in material_cols if c.get("count_only",False)}
    currency      = doc.get("currency","AED")
    vat_rate      = doc.get("vat_rate_percent",5) / 100.0
    vat_pct_label = f"{doc.get('vat_rate_percent',5)}%"

    col_widths = {1:4, 2:8, 3:28, 4:34, 5:12, 6:16, 7:18, 8:18, 9:28, 10:4}
    for ci,w in col_widths.items():
        ws.column_dimensions[get_column_letter(ci)].width = w

    r=1
    ws.row_dimensions[r].height=5
    for ci in range(1,11): ws.cell(r,ci).fill=_F(GOLD); r+=1

    ws.row_dimensions[r].height=36
    ws.merge_cells(f"B{r}:I{r}")
    c=ws.cell(r,2); c.value="COST BREAKDOWN  ·  MATERIAL QUANTITIES × UNIT RATES"
    c.font=_ft(14,True,WHITE); c.fill=_F(NAVY); c.alignment=_al("left","center")
    c.border=Border(bottom=Side("medium",color=GOLD))
    ws.cell(r,1).fill=_F(GOLD); ws.cell(r,10).fill=_F(NAVY); r+=1

    ws.row_dimensions[r].height=22
    ws.merge_cells(f"B{r}:I{r}")
    c=ws.cell(r,2)
    c.value=(f"{doc.get('project','')}   ·   {doc.get('location','')}   ·   "
             f"TYPE {doc.get('kitchen_type','N/A')}   ·   "
             f"{doc.get('total_units',0)} Units   ·   Currency: {currency}   ·   VAT: {vat_pct_label}")
    c.font=_ft(10,False,GOLD_LIGHT,italic=True); c.fill=_F(MID_BLUE); c.alignment=_al("left","center")
    ws.cell(r,1).fill=_F(GOLD); ws.cell(r,10).fill=_F(MID_BLUE); r+=1

    ws.row_dimensions[r].height=4
    for ci in range(1,11): ws.cell(r,ci).fill=_F(GOLD); r+=1

    ws.row_dimensions[r].height=20
    ws.merge_cells(f"B{r}:I{r}")
    c=ws.cell(r,2)
    c.value=(f"★  Unit rates in column G are pre-filled where cost data exists in the source JSON. "
             f"Amber cells = contractor to fill. Green cells = rate from data. Amount = Total Qty × Unit Rate.")
    c.font=_ft(9,False,MID_GREY,italic=True); c.fill=_F(PALE_BLUE); c.alignment=_al("left","center")
    ws.cell(r,1).fill=_F(PALE_BLUE); ws.cell(r,10).fill=_F(PALE_BLUE); r+=1
    ws.row_dimensions[r].height=8; r+=1

    ws.row_dimensions[r].height=50
    hdrs=["","#","Material ID","Description / Specification","Unit",
          "Total Qty","Unit Rate\n(AED / unit)","Amount\n(AED)","Notes",""]
    for ci,h in enumerate(hdrs,1):
        c=ws.cell(r,ci); c.value=h if h else ""
        c.font=_ft(11,True,WHITE); c.fill=_F(MID_BLUE)
        c.alignment=_al("center","center",True); c.border=_thick()
    r+=1

    first_data=r
    amount_rows=[]

    for idx,(key,label,col_cfg) in enumerate(MATERIAL_COLS):
        alt=(idx%2==0)
        bg=PALE_BLUE if alt else WHITE
        ws.row_dimensions[r].height=22
        brd=Border(left=Side("thin",color="DDEEFF" if alt else "E8E8E8"),
                   right=Side("thin",color="DDEEFF" if alt else "E8E8E8"),
                   top=Side("thin",color="DDEEFF" if alt else "E8E8E8"),
                   bottom=Side("thin",color="DDEEFF" if alt else "E8E8E8"))
        gl=Side("medium",color=GOLD)

        ws.cell(r,1).fill=_F(GOLD); ws.cell(r,1).border=Border(bottom=brd.bottom)

        c=ws.cell(r,2); c.value=idx+1; c.font=_ft(10,True,NAVY)
        c.fill=_F(bg); c.alignment=_al("center","center"); c.border=Border(left=gl,bottom=brd.bottom)

        c=ws.cell(r,3); c.value=key; c.font=_ft(9,False,MID_GREY,italic=True)
        c.fill=_F(bg); c.alignment=_al("left","center"); c.border=brd

        c=ws.cell(r,4); c.value=label.replace("\n"," ")
        c.font=_ft(10,False,DARK_TEXT); c.fill=_F(bg)
        c.alignment=_al("left","center",wrap=True); c.border=brd

        is_count  = key in count_only
        is_linear = any(x in key.lower() for x in ("lipping","lm","skirting","runner"))
        is_volume = "volume" in key.lower() or "timber" in key.lower()
        if is_count:    unit_str="Nr / Pr"
        elif is_volume: unit_str="M³"
        elif is_linear: unit_str="LM"
        else:           unit_str="M²"
        c=ws.cell(r,5); c.value=unit_str; c.font=_ft(10,False,"5A6C7D")
        c.fill=_F(bg); c.alignment=_al("center","center"); c.border=brd

        mat_qty_row = mat_list_data_start_row + idx
        c=ws.cell(r,6)
        c.value=f"='{mat_list_ws_name}'!F{mat_qty_row}"
        c.font=_ft(11,True,"1A5C3A"); c.fill=_F(GREEN_HL)
        c.alignment=_al("center","center"); c.border=brd; c.number_format="0.000"

        # Unit rate — pre-fill from data if available, else leave blank for contractor
        unit_rate = (col_cfg.get("unit_rate") or col_cfg.get("rate") or
                     col_cfg.get("cost") or col_cfg.get("unit_cost") or
                     col_cfg.get("price") or col_cfg.get("unit_price"))
        rate_filled = unit_rate is not None
        c=ws.cell(r,7)
        c.value = float(unit_rate) if rate_filled else None
        c.font  = _ft(11, True if rate_filled else False,
                      "1A5C3A" if rate_filled else NAVY)
        c.fill  = _F("D6F0E0" if rate_filled else AMBER_HL)   # green if pre-filled, amber if blank
        c.alignment=_al("center","center"); c.border=Border(
            left=Side("medium",color=GOLD),right=Side("medium",color=GOLD),
            top=Side("thin",color=GOLD),bottom=Side("thin",color=GOLD))
        c.number_format=f'"{currency} "#,##0.00'

        c=ws.cell(r,8)
        c.value=f"=IFERROR(F{r}*G{r},\"\")"
        c.font=_ft(11,True,NAVY); c.fill=_F(PALE_BLUE)
        c.alignment=_al("center","center"); c.border=brd
        c.number_format=f'"{currency} "#,##0.00'
        amount_rows.append(r)

        c=ws.cell(r,9); c.value=col_cfg.get("remarks","")
        c.font=_ft(9,False,"8A9BAE",italic=True); c.fill=_F(bg)
        c.alignment=_al("left","center",True); c.border=Border(right=gl,bottom=brd.bottom)

        ws.cell(r,10).fill=_F(bg); ws.cell(r,10).border=Border(bottom=brd.bottom)
        r+=1

    ws.row_dimensions[r].height=8; r+=1

    # ── FIXTURES SECTION in Cost Breakdown ────────────────────────────────
    fixture_amount_rows = []
    if fixtures:
        # Section header
        ws.row_dimensions[r].height = 30
        for ci in range(1,11):
            ws.cell(r,ci).fill=_F(CHARCOAL)
            ws.cell(r,ci).border=Border(top=Side("medium",color=GOLD),
                                        bottom=Side("medium",color=GOLD))
        ws.cell(r,1).fill=_F(GOLD)
        ws.merge_cells(f"B{r}:I{r}")
        c=ws.cell(r,2); c.value="INSTALLED FIXTURES  ·  SUPPLY & INSTALLATION RATES"
        c.font=_ft(11,True,GOLD_LIGHT); c.fill=_F(CHARCOAL); c.alignment=_al("left","center")
        c.border=Border(top=Side("medium",color=GOLD),bottom=Side("medium",color=GOLD))
        r+=1

        # Fixture column headers (same structure as materials: #|ItemNo|Desc|Unit|TotalQty|UnitRate|Amount|Notes)
        ws.row_dimensions[r].height = 48
        fx_cb_hdrs = ["","#","Item No","Description","Unit",
                      "Total Qty","Unit Rate\n(AED / unit)","Amount\n(AED)","Notes",""]
        for ci,h in enumerate(fx_cb_hdrs,1):
            c=ws.cell(r,ci); c.value=h if h else ""
            c.font=_ft(10,True,WHITE); c.fill=_F(MID_BLUE)
            c.alignment=_al("center","center",True)
            c.border=Border(top=Side("medium",color=GOLD),bottom=Side("medium",color=GOLD),
                            left=Side("thin",color=GOLD_LIGHT),right=Side("thin",color=GOLD_LIGHT))
        r+=1

        # We need to know where fixture qty data sits in Materials_List.
        # Fixtures start after the material rows + header rows in Materials_List:
        #   mat_list_data_start_row + len(MATERIAL_COLS) = last mat row + 1
        #   then: +1 spacer, +1 section hdr, +1 col hdr = +3 before first fixture row
        fx_mat_list_start = mat_list_data_start_row + len(MATERIAL_COLS) + 3

        alt = False
        for fx_idx, fx in enumerate(fixtures):
            ino     = fx.get("item_number","")
            desc    = fx.get("description","")
            unit    = fx.get("measurement_unit","Each")
            remarks = fx.get("remarks","")

            bg  = PALE_BLUE if alt else WHITE
            ws.row_dimensions[r].height = 22
            brd = Border(left=Side("thin",color="DDEEFF" if alt else "E8E8E8"),
                         right=Side("thin",color="DDEEFF" if alt else "E8E8E8"),
                         top=Side("thin",color="DDEEFF" if alt else "E8E8E8"),
                         bottom=Side("thin",color="DDEEFF" if alt else "E8E8E8"))
            gl  = Side("medium",color=GOLD)

            ws.cell(r,1).fill=_F(GOLD); ws.cell(r,1).border=Border(bottom=brd.bottom)

            # Row #
            c=ws.cell(r,2); c.value=fx_idx+1; c.font=_ft(10,True,NAVY)
            c.fill=_F(bg); c.alignment=_al("center","center")
            c.border=Border(left=gl,bottom=brd.bottom)

            # Item No
            c=ws.cell(r,3); c.value=ino; c.font=_ft(9,False,MID_GREY,italic=True)
            c.fill=_F(bg); c.alignment=_al("left","center"); c.border=brd

            # Description
            c=ws.cell(r,4); c.value=desc; c.font=_ft(10,False,DARK_TEXT)
            c.fill=_F(bg); c.alignment=_al("left","center",wrap=True); c.border=brd

            # Unit
            c=ws.cell(r,5); c.value=unit; c.font=_ft(10,False,"5A6C7D")
            c.fill=_F(bg); c.alignment=_al("center","center"); c.border=brd

            # Total qty — pull from Materials_List fixtures section col G (Total Qty)
            mat_list_fx_row = fx_mat_list_start + fx_idx
            c=ws.cell(r,6)
            c.value=f"='{mat_list_ws_name}'!G{mat_list_fx_row}"
            c.font=_ft(11,True,"1A5C3A"); c.fill=_F(GREEN_HL)
            c.alignment=_al("center","center"); c.border=brd; c.number_format="0"

            # Unit rate — pre-fill from data if available, else leave blank for contractor
            fx_rate = (fx.get("unit_rate") or fx.get("rate") or
                       fx.get("cost") or fx.get("unit_cost") or
                       fx.get("price") or fx.get("unit_price"))
            fx_rate_filled = fx_rate is not None
            c=ws.cell(r,7)
            c.value = float(fx_rate) if fx_rate_filled else None
            c.font  = _ft(11, True if fx_rate_filled else False,
                          "1A5C3A" if fx_rate_filled else NAVY)
            c.fill  = _F("D6F0E0" if fx_rate_filled else AMBER_HL)
            c.alignment=_al("center","center")
            c.border=Border(left=Side("medium",color=GOLD),right=Side("medium",color=GOLD),
                            top=Side("thin",color=GOLD),bottom=Side("thin",color=GOLD))
            c.number_format=f'"{currency} "#,##0.00'

            # Amount = Total Qty × Unit Rate
            c=ws.cell(r,8)
            c.value=f"=IFERROR(F{r}*G{r},\"\")"
            c.font=_ft(11,True,NAVY); c.fill=_F(PALE_BLUE)
            c.alignment=_al("center","center"); c.border=brd
            c.number_format=f'"{currency} "#,##0.00'
            fixture_amount_rows.append(r)

            # Notes / remarks
            c=ws.cell(r,9); c.value=remarks
            c.font=_ft(9,False,"8A9BAE",italic=True); c.fill=_F(bg)
            c.alignment=_al("left","center",True)
            c.border=Border(right=gl,bottom=brd.bottom)

            ws.cell(r,10).fill=_F(bg); ws.cell(r,10).border=Border(bottom=brd.bottom)
            alt = not alt
            r+=1

        ws.row_dimensions[r].height=8; r+=1

    def _summary_row(row,label,formula,height=28,bg=CHARCOAL,fc=WHITE,bold=True,num=""):
        ws.row_dimensions[row].height=height
        for ci in range(1,11): ws.cell(row,ci).fill=_F(bg)
        ws.cell(row,1).fill=_F(GOLD)
        ws.merge_cells(f"C{row}:G{row}")
        c=ws.cell(row,3); c.value=label
        c.font=_ft(12,bold,fc); c.fill=_F(bg); c.alignment=_al("right","center")
        c.border=Border(top=Side("medium",color=GOLD),bottom=Side("medium",color=GOLD))
        c=ws.cell(row,8); c.value=formula
        c.font=_ft(13,True,GOLD if bg==NAVY else fc); c.fill=_F(bg)
        c.alignment=_al("center","center"); c.number_format=num or f'"{currency} "#,##0.00'
        c.border=Border(left=Side("medium",color=GOLD),right=Side("medium",color=GOLD),
                        top=Side("medium",color=GOLD),bottom=Side("medium",color=GOLD))
        ws.cell(row,10).fill=_F(bg)

    all_amount_rows = amount_rows + fixture_amount_rows
    if all_amount_rows:
        # Build a SUM across all non-contiguous amount rows
        sum_parts = "+".join(f"IFERROR(H{rr},0)" for rr in all_amount_rows)
        sub_row=r
        _summary_row(r,"SUBTOTAL  (excl. VAT)",f"={sum_parts}",bg=CHARCOAL); r+=1
        vat_row=r
        _summary_row(r,f"VAT  ({vat_pct_label})",f"=H{sub_row}*{vat_rate}",
                     bg=MID_BLUE,fc=GOLD_LIGHT); r+=1
        _summary_row(r,"GRAND TOTAL  (incl. VAT)",f"=H{sub_row}+H{vat_row}",
                     height=34,bg=NAVY,fc=WHITE); r+=1

    ws.row_dimensions[r].height=5
    for ci in range(1,11): ws.cell(r,ci).fill=_F(GOLD); r+=1

    ws.row_dimensions[r].height=20
    ws.merge_cells(f"B{r}:I{r}")
    c=ws.cell(r,2)
    c.value=("Rates to be provided by tendering contractor.  "
             "All quantities are indicative and subject to field verification.  "
             f"Currency: {currency}  ·  VAT @ {vat_pct_label}")
    c.font=_ft(8,False,MID_GREY,italic=True); c.fill=_F(NAVY); c.alignment=_al("center","center")
    ws.cell(r,1).fill=_F(NAVY); ws.cell(r,10).fill=_F(NAVY)
    return ws


# ═══════════════════════════════════════════════════════════════════════════
# ENTRY POINT
# ═══════════════════════════════════════════════════════════════════════════

def generate(json_path, out_path):
    with open(json_path,"r",encoding="utf-8") as f:
        data=json.load(f)

    doc              = data.get("project_info",{})
    sections         = data.get("sections", data.get("kitchen_sections",[]))
    fixtures         = data.get("installed_fixtures",[])
    section_map      = data.get("section_grouping",{})
    material_columns = data.get("material_columns",[])
    calc_rules       = data.get("calculation_rules",{})
    mat_id           = data.get("material_identification",{})
    add_notes        = data.get("additional_notes",{})

    sheet_area_m2  = calc_rules.get("sheet_area_square_meters",2.88)
    output_options = calc_rules.get("excel_formatting",{})
    unit_categories= calc_rules.get("unit_type_mapping",{})
    auto_rules     = calc_rules.get("parametric_rules",{}).get("auto_calculation_rules",{})

    if not unit_categories:
        unit_categories={
            "area_based":  ["M²","m2","SQ M","SQM","M2"],
            "volume_based":["M³","m3","CU M","M3"],
            "linear_based":["LM","lm","L M","M","m"],
            "count_based": ["Nr","nos","PC","pcs","Each","each"],
            "pair_based":  ["Pr","Pair"],
            "set_based":   ["Set","Kit","Box"],
        }

    transformed_doc={
        "project":           doc.get("name",""),
        "location":          doc.get("location",""),
        "phase":             doc.get("phase",""),
        "kitchen_type":      doc.get("kitchen_type","N/A"),
        "total_units":       doc.get("total_kitchen_units",0),
        "main_contractor":   doc.get("stakeholders",{}).get("main_contractor","N/A"),
        "design_consultant": doc.get("stakeholders",{}).get("design_consultant","N/A"),
        "supervision":       doc.get("stakeholders",{}).get("supervision","N/A"),
        "date":              doc.get("document_metadata",{}).get("date","N/A"),
        "revision":          doc.get("document_metadata",{}).get("revision","N/A"),
        "currency":          doc.get("document_metadata",{}).get("currency","AED"),
        "vat_rate_percent":  doc.get("document_metadata",{}).get("vat_percent",5),
        "drawing_references":doc.get("drawings",[]),
        "document_metadata": doc.get("document_metadata",{}),
        "name":              doc.get("name",""),
        "title":             doc.get("document_metadata",{}).get("title","BILL OF QUANTITIES"),
        "additional_notes":  add_notes,
    }

    transformed_material_cols=[]
    for col in material_columns:
        calc_type = col.get("calculation_type","area_based")
        col_id    = col.get("id") or col.get("key") or ""
        tc={
            "key":     col_id,
            "label":   col.get("display_name", col.get("label","")),
            "width":   col.get("column_width",  col.get("width",14)),
            "remarks": col.get("remarks",""),
            "unit_rate": col.get("unit_rate"),  # ← ADD THIS LINE
        }
        if calc_type=="spacer":
            tc["key"]=f"_blank_{col_id}"
        elif calc_type in("count_based","pair_based","set_based","fixture_based"):
            tc["count_only"]=True
        transformed_material_cols.append(tc)

    real_cols=[c for c in transformed_material_cols if not c["key"].startswith("_blank")]
    if not real_cols:
        print("WARNING: material_columns produced zero real columns.")
        for col in material_columns:
            print(f"  id={col.get('id')!r}  calc_type={col.get('calculation_type')!r}")

    tmr={"board_rules":[],"addon_rules":[],"subgroup_keywords":[],"desc_strip_prefixes":[]}
    for rule in mat_id.get("sheet_materials",[]):
        tmr["board_rules"].append({
            "key":rule.get("material_id"),"thickness":rule.get("required_thickness"),
            "material":rule.get("material_type"),"context":rule.get("context_keywords")})
    for rule in mat_id.get("additional_materials",[]):
        tmr["addon_rules"].append({
            "key":rule.get("material_id"),
            "trigger_spec":rule.get("triggers_in_specification",[]),
            "trigger_desc":rule.get("triggers_in_description",[]),
            "size_filter":rule.get("size_filter")})
    for rule in mat_id.get("subsection_organization",[]):
        tmr["subgroup_keywords"].append({
            "label":rule.get("subsection_name"),
            "keywords":rule.get("detection_keywords",[]),
            "has_dims":rule.get("has_dimensions",True)})
    tmr["desc_strip_prefixes"]=mat_id.get("description_prefixes_to_remove",[])
    transformed_doc["material_detection_rules"]=tmr

    if not real_cols:
        seen={}
        for sec in sections:
            for comp in sec.get("components",sec.get("items",[])):
                for item in comp.get("items",[]):
                    mk=item.get("material","")
                    if mk and mk not in seen:
                        seen[mk]=item.get("description","")[:40]
        for fx in fixtures:
            mk=fx.get("assigned_material","")
            if mk and mk not in seen: seen[mk]=fx.get("description","")[:40]
        transformed_material_cols=[
            {"key": k, "label": v, "width": 16, "remarks": "", "unit_rate": None} 
            for k, v in seen.items()
        ]
        real_cols=transformed_material_cols[:]
        print(f"  Auto-detected {len(real_cols)} material columns from item data.")

    wb=Workbook(); wb.remove(wb.active)

    build_summary_sheet(wb, transformed_doc, sections, section_map)

    gt_row = _build_matrix_sheet(
        wb, transformed_doc, sections, fixtures, section_map,
        transformed_material_cols, sheet_area_m2,
        output_options, unit_categories, auto_rules)

    # Materials_List: data starts at row 9
    mat_list_data_start = 9
    build_materials_sheet(wb, transformed_doc, transformed_material_cols,
                          gt_row, sheet_area_m2, fixtures=fixtures)

    build_cost_breakdown_sheet(wb, transformed_doc, transformed_material_cols,
                               mat_list_data_start, fixtures=fixtures)

    wb.save(out_path)
    print(f"✓  Saved: {out_path}")
    print(f"   Sheets      : Summary | BOQ_Matrix | Materials_List | Cost_Breakdown")
    print(f"   Project     : {doc.get('name','N/A')}")
    print(f"   Kitchen Type: {doc.get('kitchen_type','N/A')}")
    print(f"   Total Units : {doc.get('total_kitchen_units',0)}")
    print(f"   Sections    : {len(sections)}")
    print(f"   Fixtures    : {len(fixtures)}")
    print(f"   Mat columns : {len(real_cols)}")
    print(f"   BOQ gt_row  : {gt_row}")


if __name__=="__main__":
    json_in  = sys.argv[1] if len(sys.argv)>1 else "D:/My-CODE_RUSH/projects/Quantity Savior/client/src/lib/boq_data.json"
    xlsx_out = sys.argv[2] if len(sys.argv)>2 else "BOQ_AlWaha_C1.xlsx"
    generate(json_in, xlsx_out)