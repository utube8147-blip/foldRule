// The job from a drawing to a priced estimate, in the order it is done. One list feeds
// the in-app checklist, the public guide page and the landing page, so they never disagree.

import type { Drawing, TakeoffRow } from '@/types';
import { getPageScale } from '@/lib/takeoff/scale';

export type StageId = 'drawing' | 'scale' | 'measure' | 'organise' | 'money' | 'materials' | 'rates' | 'export' | 'tender' | 'savings' | 'revision';

export interface Stage {
  id: StageId;
  title: string;
  /** One line for lists and cards. */
  short: string;
  /** Why this step exists, for someone who has never priced a job. */
  why: string;
  how: string[];
  tip?: string;
  /** Which screen it is done on. */
  on: 'workspace' | 'summary' | 'both';
  /** `data-guide` value of the control to point at on that screen. */
  target?: string;
  /** Not needed for a first estimate. */
  later?: boolean;
}

export const STAGES: Stage[] = [
  {
    id: 'drawing', title: 'Open the drawing', short: 'Add the plan as a PDF. It stays on your computer.',
    why: 'Everything is measured from the plan. A PDF exported from the architect’s software works best, because its lines can be snapped to.',
    how: ['Create a project from “My projects”.', 'Drop the PDF in, or use “Upload Drawing” in the left panel.', 'A set with many pages is fine: pick the page at the top.'],
    tip: 'A scanned or photographed plan still opens, but there are no lines to snap to, so click carefully.',
    on: 'workspace', target: 'upload',
  },
  {
    id: 'scale', title: 'Set the scale, then check it', short: 'Tell Foldrule how long one known dimension really is.',
    why: 'A drawing is a small picture of a big building. Until the scale is set, a wall is just “so many millimetres of paper”. A wrong scale makes every quantity wrong by the same amount.',
    how: ['Click “Calibrate” at the top.', 'Click the two ends of a dimension printed on the drawing and type its real length.', 'Click “Check scale” and try a second dimension, ideally one running the other way. It should agree.'],
    tip: 'Each page has its own scale. A site plan and a floor plan are rarely drawn at the same one.',
    on: 'workspace', target: 'scale',
  },
  {
    id: 'measure', title: 'Measure', short: 'Trace lengths, areas and counts on the plan.',
    why: 'This is the takeoff: turning the drawing into quantities. Walls and skirting are lengths (m), floors and ceilings are areas (m²), doors and sockets are counts.',
    how: ['Pick Length, Area or Count on the left.', 'Click the corners. With Snap on, points jump onto the drawing’s lines.', 'Double-click or press Enter to finish. Ctrl+Z undoes.', 'For a wall, use Convert → Assembly: one line becomes blockwork, plaster, paint and skirting, with openings taken off.'],
    tip: 'If a floor or flat repeats, do not measure it again. Give the page, group or row a multiplier (“× 6”).',
    on: 'workspace', target: 'tools',
  },
  {
    id: 'organise', title: 'Name and group', short: 'Give each measurement a name and put like with like.',
    why: 'A bill is read by people who never saw you measure. “Wall W1, Level 2” in a group called “Blockwork” can be checked; “Length 14” cannot.',
    how: ['Rename a row by clicking its name in the table on the right.', 'Select rows, right-click and choose “Group”.', 'Use the eye button to hide a group and see what is left unmeasured on the plan.'],
    on: 'workspace', target: 'takeoff',
  },
  {
    id: 'money', title: 'Set the currency and VAT', short: 'Choose the country’s currency and tax rate once.',
    why: 'Every total and the exported bill use them. Choosing the currency suggests the usual VAT for that country; you can change it.',
    how: ['In the workspace: left panel → Scope / Specs → Document Metadata.', 'Or on the summary page: the Currency and VAT boxes above the table.'],
    tip: 'Check the VAT rate with your accountant. Some jobs are zero-rated or exempt.',
    on: 'both', target: 'money',
  },
  {
    id: 'materials', title: 'Choose materials', short: 'Say what each group is made of.',
    why: 'A quantity alone has no price. “120 m² of floor” becomes money only when you say it is ceramic tile rather than marble.',
    how: ['Open the summary page (“Expand” above the table).', 'Click “+ Material for the group” on each group and pick from the bank.', 'One row different from its group? Set its material on the row.'],
    on: 'summary', target: 'steps',
  },
  {
    id: 'rates', title: 'Set the rates', short: 'Give each material a price per unit.',
    why: 'Rates are the one thing no software can know: they come from supplier quotes and your own past jobs. One rate prices every item on that material.',
    how: ['Summary page → “Set rates”, then type the prices straight into the table.', 'Waiting on a supplier? “Price request” downloads a sheet to send; “Import prices” reads their reply.', 'Sold by the box or bag? Say so on the material, with what one covers and a waste percentage.', 'Prices are remembered in your master bank for the next project.'],
    tip: 'A rate is usually material + labour + equipment. If your quote is all-in, put it in Material.',
    on: 'summary', target: 'steps',
  },
  {
    id: 'export', title: 'Export the bill', short: 'Download the priced Bill of Quantities for Excel.',
    why: 'The workbook is what you send: the takeoff, the bill in standard sections with live formulas and VAT, and sheets for savings and revisions.',
    how: ['Click “Export to Excel” (workspace) or “Export BOQ” (summary page).', 'Reports → Marked-up PDF gives the drawing with your measurements and a legend, as proof of where the numbers came from.'],
    on: 'both', target: 'export',
  },
  {
    id: 'tender', title: 'Turn cost into a tender price', short: 'Add preliminaries, contingency, overheads and profit.',
    why: 'The takeoff prices what is drawn. A tender also has to pay for running the site, risk, your head office and your profit, none of which appear on a plan.',
    how: ['Summary page → Estimate.', 'Enter a percentage for preliminaries, contingency, overheads and profit, and any provisional sums.', 'The same page lists the materials to order: net quantity plus waste, in boxes, bags or pieces.'],
    tip: 'Set waste and pack size on each material in the bank (“one box covers 1.44 m²”). The rate and the order quantity both follow.',
    on: 'summary', target: 'estimate', later: true,
  },
  {
    id: 'savings', title: 'Look for savings', short: 'Propose cheaper materials of equal quality (value engineering).',
    why: 'When the estimate is over budget, the usual answer is not to shrink the building but to swap materials. Quantities stay; only the material and its rate change.',
    how: ['Summary page → Value Engineering.', 'Pick a costly material and propose an alternative from your bank.', 'Accept or reject it. The designed material is kept and can be put back.'],
    on: 'summary', target: 'savings', later: true,
  },
  {
    id: 'revision', title: 'Handle a new drawing', short: 'Compare a revised plan and update only what changed.',
    why: 'Architects reissue drawings. You should not measure again from nothing: unchanged measurements carry over and only the affected ones need checking.',
    how: ['Workspace → “New revision”, and open the new PDF.', 'Red is removed, blue is added, grey is unchanged.', 'Accept it, then work through the rows flagged Check or Fix.', 'Every version is kept in History and can be restored.'],
    on: 'workspace', target: 'revision', later: true,
  },
];

export interface GuideProject {
  drawings: Pick<Drawing, 'id' | 'pageCount' | 'scaleFactor' | 'pageScales' | 'supersededBy'>[];
  measurements: Pick<TakeoffRow, 'id' | 'isGroupHeader' | 'childIds' | 'materialId' | 'unitRate'>[];
  currency?: string;
  vatPercent?: number;
  veProposals?: unknown[];
  markups?: { prelimsPercent?: number; prelimsSum?: number; contingencyPercent?: number; overheadPercent?: number; profitPercent?: number; provisional?: unknown[] };
  revisionLog?: unknown[];
}

export interface StageProgress { stage: Stage; done: boolean; detail?: string }

/** Which stages a project has finished, worked out from the project itself (nothing to tick by hand). */
export function guideProgress(p: GuideProject, exported = false): StageProgress[] {
  const live = p.drawings.filter(d => !d.supersededBy);
  let pages = 0, scaled = 0;
  for (const d of live) {
    const n = Math.max(1, d.pageCount || 1);
    pages += n;
    for (let i = 1; i <= n; i++) if (getPageScale(d as Drawing, i) !== null) scaled++;
  }
  const items = p.measurements.filter(m => !m.isGroupHeader);
  const grouped = p.measurements.some(m => m.isGroupHeader && (m.childIds?.length ?? 0) > 0);
  const priced = items.filter(m => m.unitRate > 0).length;
  const itemIds = new Set(items.map(m => m.id));
  const emptyBare = p.measurements.filter(m => m.isGroupHeader && !m.materialId && !(m.childIds ?? []).some(c => itemIds.has(c))).length;
  const withMaterial = items.filter(m => m.materialId || m.unitRate > 0).length;

  const done: Record<StageId, [boolean, string?]> = {
    drawing: [live.length > 0],
    scale: [pages > 0 && scaled === pages, pages > 0 && scaled < pages ? `${scaled} of ${pages} pages have a scale` : undefined],
    measure: [items.length > 0, items.length ? `${items.length} measured` : undefined],
    organise: [grouped],
    money: [!!p.currency && p.vatPercent !== undefined],
    materials: [items.length > 0 && withMaterial === items.length && emptyBare === 0, items.length ? `${withMaterial} of ${items.length} items` : undefined],
    rates: [items.length > 0 && priced === items.length, items.length ? `${priced} of ${items.length} items priced` : undefined],
    export: [exported],
    tender: [!!p.markups && [p.markups.prelimsPercent, p.markups.prelimsSum, p.markups.contingencyPercent, p.markups.overheadPercent, p.markups.profitPercent].some(n => (n ?? 0) > 0)],
    savings: [(p.veProposals?.length ?? 0) > 0],
    revision: [(p.revisionLog?.length ?? 0) > 0],
  };
  return STAGES.map(stage => ({ stage, done: done[stage.id][0], detail: done[stage.id][1] }));
}

/** Words a newcomer meets, in plain language. */
export const GLOSSARY: [string, string][] = [
  ['Takeoff', 'Measuring quantities off a drawing: how many metres of wall, square metres of floor, number of doors.'],
  ['BOQ (Bill of Quantities)', 'The list of everything to be built, each line with a quantity, a unit, a rate and an amount. It is what contractors price and are paid against.'],
  ['Rate', 'The price of one unit of something: per metre, per square metre, each. Amount = quantity × rate.'],
  ['Scale', 'How much smaller the drawing is than the building. At 1:100, one centimetre on paper is one metre on site.'],
  ['Assembly', 'One measurement that produces several bill lines. A wall line gives blockwork, plaster, paint and skirting.'],
  ['Deduction', 'Taking openings out of a quantity: a door’s area off the wall it sits in.'],
  ['Timesing', 'Multiplying a measurement instead of repeating it: one flat measured, billed six times.'],
  ['POMI', 'Principles of Measurement (International): a common rulebook in the Gulf for how work is grouped into sections and measured.'],
  ['Revision', 'A reissued drawing (Rev A, Rev B). The takeoff must follow it without being redone.'],
  ['Value engineering', 'Reducing cost without reducing function, usually by proposing an equivalent, cheaper material.'],
  ['Master bank', 'Your own price list, shared by all your projects and saved in your projects folder. It fills up as you work.'],
  ['Preliminaries', 'The cost of running the site rather than building the building: supervision, cabins, scaffolding, insurance, temporary power.'],
  ['Provisional sum', 'An allowance for work that is not designed yet, so it can be priced now and adjusted later.'],
  ['Contingency', 'Money set aside for risk: the things that go wrong on every job.'],
  ['Waste', 'Material you must buy but cannot bill: tile offcuts, broken blocks. It goes into the rate, not the quantity.'],
  ['Price request (RFQ)', 'A list of materials and quantities sent to suppliers to get their prices.'],
];

/** Questions people ask before they trust a number. */
export const FAQ: [string, string][] = [
  ['I am not a quantity surveyor. Can I use this?', 'Yes. The in-app guide walks you through the eight steps in order and ticks them off as you go. What you do need is a drawing with at least one printed dimension, and prices from your suppliers.'],
  ['Where do the prices come from?', 'From you. Foldrule ships with a catalogue of materials but no prices, because a price that is right in Dubai this month is wrong in Riyadh next month. Type rates in, or send a price request to suppliers and import their reply. Your prices are remembered for the next project.'],
  ['Do my drawings get uploaded?', 'No. PDFs are opened and measured inside your browser, and projects are saved on your own computer. Only the numbers needed to build the Excel file are sent when you export.'],
  ['What happens when the architect sends a new drawing?', 'Open it as a new revision. Foldrule lays it over the old one, carries across every measurement that still fits, and flags the ones that need checking. Old versions are kept and can be restored.'],
  ['Which measurement standard does the bill follow?', 'The bill is arranged in POMI-style sections, which is common practice in the Gulf, with quantities rounded for billing. Have your own surveyor confirm the layout suits your contract before you issue it.'],
  ['Which currencies and taxes are supported?', 'AED, SAR, QAR, OMR, BHD and KWD (with three decimals where the currency uses them), plus USD, GBP, EUR and LKR. Choosing a currency suggests the usual VAT rate, which you can change.'],
  ['Can I check where a number came from?', 'Yes. Every row shows its working, derived quantities say what they follow, and the marked-up PDF shows each measurement on the drawing with a legend.'],
  ['Does it give a tender price or just a cost?', 'Both. The takeoff gives the measured work. The Estimate page adds preliminaries, provisional sums, contingency, overheads and profit, then VAT, and the build-up is a sheet in the Excel export.'],
  ['My supplier sells tiles by the box. Does that work?', 'Yes. Say the material is bought by the box and what one box covers, and add a waste percentage. The rate per square metre is worked out for you, and “Materials to order” tells you how many boxes to buy.'],
  ['Who changed this number?', 'Every change to a quantity, rate, material, price or estimate setting is logged with who made it and when. See Activity on the summary page, or the “Change log” sheet of the export.'],
  ['Will it warn me about mistakes?', 'It flags the unlikely: a scale that makes the sheet hundreds of metres wide, the same shape measured twice, a length priced with a per-m² material, a rate far from your usual one. It cannot know what you forgot to measure.'],
  ['What does it not do?', 'It does not price the job for you, it does not measure from 3D models, it does not check your quantities against the specification, and it does not read old .xls files (save them as .xlsx).'],
];
