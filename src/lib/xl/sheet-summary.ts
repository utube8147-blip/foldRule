// sheet-summary.ts  –  pixel-perfect port of the Python build_summary_sheet()
import * as ExcelJS from 'exceljs';

// ── colour constants (mirrors Python exactly) ────────────────────────────────
const NAVY       = 'FF0D1B2A';
const GOLD       = 'FFB8962E';
const GOLD_LIGHT = 'FFC8A84B';
const MID_BLUE   = 'FF1A3A5C';
const CHARCOAL   = 'FF2C3E50';
const WHITE      = 'FFFFFFFF';
const PALE_BLUE  = 'FFEBF3FB';
const MID_GREY   = 'FF6C7A8D';
const DARK_TEXT  = 'FF1C1C1C';
const FONT_FACE  = 'Calibri';

// ── helpers ──────────────────────────────────────────────────────────────────
function fill(argb: string): ExcelJS.Fill {
  return { type: 'pattern', pattern: 'solid', fgColor: { argb } };
}
function font(size: number, bold = false, argb = DARK_TEXT, italic = false): ExcelJS.Font {
  return { name: FONT_FACE, size, bold, color: { argb }, italic };
}
function al(
  horizontal: ExcelJS.Alignment['horizontal'],
  vertical: ExcelJS.Alignment['vertical'] = 'middle',
  wrapText = false,
): Partial<ExcelJS.Alignment> {
  return { horizontal, vertical, wrapText };
}
function side(style: ExcelJS.BorderStyle = 'thin', argb = 'FFBBBBBB'): ExcelJS.Border {
  return { style, color: { argb } };
}

// ─────────────────────────────────────────────────────────────────────────────
export async function buildSummarySheet(
  workbook: ExcelJS.Workbook,
  doc: any,
  sections: any[],
  sectionMap: Record<string, any>,
): Promise<void> {
  const ws = workbook.addWorksheet('Summary');
  ws.views = [{ showGridLines: false }];

  // ── COLUMN WIDTHS ─────────────────────────────────────────────────────────
  // [FIX] Col A width = 2 (was 0 → hidden). Python renders a narrow visible gold stripe.
  //       All other column widths unchanged from Python: B=22, C=36, D=16, E=16, F=0.
  ws.getColumn(1).width = 12;    // A – narrow gold left accent stripe (was 0 = invisible)
  ws.getColumn(2).width = 22;   // B – label column
  ws.getColumn(3).width = 36;   // C – value / merged content
  ws.getColumn(4).width = 16;   // D – part of merged value
  ws.getColumn(5).width = 16;   // E – part of merged value
  ws.getColumn(6).width = 0;    // F – right accent (intentionally hidden in Python too)

  const COLS = 6;
  let r = 1;

  // ── scoped helpers ────────────────────────────────────────────────────────

  function fillRow(row: number, argb: string) {
    for (let ci = 1; ci <= COLS; ci++) {
      ws.getCell(row, ci).fill = fill(argb);
    }
  }

  function goldStripe(h: number) {
    ws.getRow(r).height = h;
    fillRow(r, GOLD);
    r++;
  }

  /**
   * Navy title bar.
   * All cells: navy fill + medium-gold bottom border.
   * Col A: gold accent (stamp AFTER fillRow so it overrides navy).
   * B–E merged: centred white bold title text.
   */
  function navyBar(text: string, size: number, h: number) {
    ws.getRow(r).height = h;
    for (let ci = 1; ci <= COLS; ci++) {
      ws.getCell(r, ci).fill   = fill(NAVY);
      ws.getCell(r, ci).border = { bottom: side('medium', GOLD) };
    }
    ws.getCell(r, 1).fill = fill(GOLD);   // col A gold accent
    ws.mergeCells(r, 2, r, 5);
    const c = ws.getCell(r, 2);
    c.value     = text;
    c.font      = font(size, true, WHITE);
    c.fill      = fill(NAVY);
    c.alignment = al('center', 'middle');
    c.border    = { bottom: side('medium', GOLD) };
    r++;
  }

  /**
   * Mid-blue subtitle row.
   * Col A: gold accent. B–E merged italic gold-light text.
   */
  function subtitleBar(text: string) {
    ws.getRow(r).height = 20;
    for (let ci = 1; ci <= COLS; ci++) {
      ws.getCell(r, ci).fill = fill(MID_BLUE);
    }
    ws.getCell(r, 1).fill = fill(GOLD);   // col A gold accent
    ws.mergeCells(r, 2, r, 5);
    const c = ws.getCell(r, 2);
    c.value     = text;
    c.font      = font(10, false, GOLD_LIGHT, true);
    c.fill      = fill(MID_BLUE);
    c.alignment = al('center', 'middle');
    r++;
  }

  /**
   * Charcoal section-header bar.
   * Col A: gold accent. B–E merged uppercase gold-light label.
   */
  function secHdr(label: string) {
    ws.getRow(r).height = 26;
    for (let ci = 1; ci <= COLS; ci++) {
      ws.getCell(r, ci).fill   = fill(CHARCOAL);
      ws.getCell(r, ci).border = {
        top:    side('medium', GOLD),
        bottom: side('thin', GOLD_LIGHT),
      };
    }
    ws.getCell(r, 1).fill = fill(GOLD);   // col A gold accent
    ws.mergeCells(r, 2, r, 5);
    const c = ws.getCell(r, 2);
    c.value     = label.toUpperCase();
    c.font      = font(10, true, GOLD_LIGHT);
    c.fill      = fill(CHARCOAL);
    c.alignment = al('left', 'middle');
    c.border    = { top: side('medium', GOLD), bottom: side('thin', GOLD_LIGHT) };
    r++;
  }

  /**
   * Key-value detail row.
   * Col A: gold accent + thin bottom border.
   * Col B: label (grey bold, left gold border).
   * Cols C–E merged: value (navy bold, right gold border).
   * Col F: bg fill only.
   */
  function detail(label: string, value: string, alt: boolean) {
    ws.getRow(r).height = 22;
    const bg       = alt ? PALE_BLUE : WHITE;
    const thinArgb = alt ? 'FFDDEEFF' : 'FFE8E8E8';
    const thin     = side('thin', thinArgb);
    const gl       = side('medium', GOLD);

    // col A – gold accent
    ws.getCell(r, 1).fill   = fill(GOLD);
    ws.getCell(r, 1).border = { bottom: thin };

    // col B – label
    const lbl = ws.getCell(r, 2);
    lbl.value     = label;
    lbl.font      = font(9, true, MID_GREY);
    lbl.fill      = fill(bg);
    lbl.alignment = al('left', 'middle');
    lbl.border    = { left: gl, bottom: thin };

    // cols C–E – value
    ws.mergeCells(r, 3, r, 5);
    const val = ws.getCell(r, 3);
    val.value     = String(value);
    val.font      = font(10, true, NAVY);
    val.fill      = fill(bg);
    val.alignment = al('left', 'middle');
    val.border    = { right: gl, bottom: thin };

    // col F
    ws.getCell(r, 6).fill   = fill(bg);
    ws.getCell(r, 6).border = { bottom: thin };

    r++;
  }

  /**
   * Column-header row for section summary table.
   * Col A: gold accent. Cols B–E: centred white labels on mid-blue.
   */
  function colHdr(labels: [number, string][]) {
    ws.getRow(r).height = 26;
    for (let ci = 1; ci <= COLS; ci++) {
      ws.getCell(r, ci).fill   = fill(MID_BLUE);
      ws.getCell(r, ci).border = {
        top:    side('medium', GOLD),
        bottom: side('medium', GOLD),
      };
    }
    ws.getCell(r, 1).fill = fill(GOLD);   // col A gold accent
    for (const [ci, txt] of labels) {
      const c = ws.getCell(r, ci);
      c.value     = txt;
      c.font      = font(9, true, WHITE);
      c.fill      = fill(MID_BLUE);
      c.alignment = al('center', 'middle');
    }
    r++;
  }

  /**
   * Data row for section summary table.
   * Col A: gold accent. Cols B–E individual cells. Col F accent fill.
   */
  function tblRow(secId: string, ref: string, title: string, count: number, alt: boolean) {
    ws.getRow(r).height = 22;
    const bg       = alt ? PALE_BLUE : WHITE;
    const thinArgb = alt ? 'FFDDEEFF' : 'FFE8E8E8';
    const thin     = side('thin', thinArgb);
    const gl       = side('medium', GOLD);

    ws.getCell(r, 1).fill   = fill(GOLD);
    ws.getCell(r, 1).border = { bottom: thin };

    const cells: [number, string | number, ExcelJS.Alignment['horizontal']][] = [
      [2, secId, 'center'],
      [3, ref,   'center'],
      [4, title, 'left'],
      [5, count, 'center'],
    ];
    for (const [ci, val, ha] of cells) {
      const c = ws.getCell(r, ci);
      c.value     = val;
      c.font      = font(10, false, [2, 3, 5].includes(ci as number) ? NAVY : DARK_TEXT);
      c.fill      = fill(bg);
      c.alignment = al(ha, 'middle');
      const bk: ExcelJS.Borders = { bottom: thin };
      if (ci === 2) bk.left  = gl;
      if (ci === 5) bk.right = gl;
      c.border = bk;
    }

    ws.getCell(r, 6).fill   = fill(bg);
    ws.getCell(r, 6).border = { bottom: thin };
    r++;
  }

  // ── BUILD ROWS ────────────────────────────────────────────────────────────

  // r=1  gold stripe h=4
  goldStripe(4);

  // r=2  navy title bar h=36
  const kitchenType =
    doc.kitchen_type ||
    (doc.document_metadata || {}).kitchen_type ||
    'N/A';
  navyBar(
    `BILL OF QUANTITIES  ·  KITCHEN FITOUT  ·  TYPE ${kitchenType}`,
    13,
    36,
  );

  // r=3  mid-blue subtitle h=20
  subtitleBar(
    `${doc.project || doc.name || ''}   ·   ${doc.location || ''}   ·   ${doc.phase || ''}`,
  );

  // r=4  gold stripe h=3
  goldStripe(3);

  // r=5  PROJECT INFORMATION header
  secHdr('Project Information');

  // r=6–13  detail rows
  const meta   = doc.document_metadata || {};
  const stakes = doc.stakeholders || {};

  const infoRows: [string, string][] = [
    ['Main Contractor',   stakes.main_contractor   || doc.main_contractor   || 'N/A'],
    ['Design Consultant', stakes.design_consultant || doc.design_consultant || 'N/A'],
    ['Supervision',       stakes.supervision       || doc.supervision       || 'N/A'],
    ['Kitchen Type',      kitchenType],
    ['Total Units',       String(doc.total_kitchen_units ?? doc.total_units ?? 0)],
    ['Date',              meta.date     || doc.date     || new Date().toLocaleDateString('en-GB')],
    ['Revision',          meta.revision || doc.revision || 'N/A'],
    ['Currency / VAT',    `${meta.currency || doc.currency || 'AED'}  (VAT ${meta.vat_percent ?? doc.vat_rate_percent ?? 5}%)`],
  ];
  for (let i = 0; i < infoRows.length; i++) {
    detail(infoRows[i][0], infoRows[i][1], i % 2 === 0);
  }

  // spacer h=8
  ws.getRow(r).height = 8; r++;

  // DRAWING REFERENCES
  secHdr('Drawing References');

  const drawings: string[] =
    (Array.isArray(doc.drawings)           && doc.drawings.length > 0           ? doc.drawings           : null) ||
    (Array.isArray(doc.drawing_references) && doc.drawing_references.length > 0 ? doc.drawing_references : null) ||
    (Array.isArray(meta.drawings)          && meta.drawings.length > 0          ? meta.drawings          : null) ||
    [];

  const drawCount = Math.max(drawings.length, 1);
  for (let i = 0; i < drawCount; i++) {
    detail(`Ref ${String(i + 1).padStart(2, '0')}`, drawings[i] || '—', i % 2 === 0);
  }

  // spacer h=8
  ws.getRow(r).height = 8; r++;

  // SECTION SUMMARY
  secHdr('Section Summary');
  colHdr([[2, 'Section'], [3, 'Reference'], [4, 'Description'], [5, 'Items']]);

  for (let i = 0; i < sections.length; i++) {
    const sec = sections[i];
    const sid = sec.section_id || '';
    const sg  = sectionMap[sid] || {};
    tblRow(
      sid,
      sg.elevation || '—',
      sg.cabinet_type || sg.unit_type || '—',
      (sec.components || sec.items || []).length,
      i % 2 === 0,
    );
  }

  // spacer h=8
  ws.getRow(r).height = 8; r++;

  // GENERAL ASSUMPTIONS (conditional)
  const addNotes    = doc.additional_notes || {};
  const assumptions = addNotes.general_assumptions || [];
  if (assumptions.length > 0) {
    secHdr('General Assumptions');
    for (let i = 0; i < assumptions.length; i++) {
      const n = assumptions[i];
      detail(n.category || '', n.content || '', i % 2 === 0);
    }
    ws.getRow(r).height = 8; r++;
  }

  // EXCLUDED FROM SCOPE (conditional)
  const exclusions = addNotes.excluded_from_scope || [];
  if (exclusions.length > 0) {
    secHdr('Excluded from Scope');
    for (let i = 0; i < exclusions.length; i++) {
      const e = exclusions[i];
      detail(e.item || '', e.reason || '', i % 2 === 0);
    }
  }

  // FOOTER: thin gold stripe h=3 + navy disclaimer h=20
  ws.getRow(r).height = 3;
  fillRow(r, GOLD);
  r++;

  ws.getRow(r).height = 20;
  ws.mergeCells(r, 1, r, COLS);
  const footer = ws.getCell(r, 1);
  footer.value =
    'All quantities subject to field verification. Unit rates to be inserted by tendering contractor.';
  footer.font      = font(8, false, MID_GREY, true);
  footer.fill      = fill(NAVY);
  footer.alignment = al('center', 'middle');
}
