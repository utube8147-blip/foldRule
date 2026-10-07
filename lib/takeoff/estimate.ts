// From the cost of the measured work to the price you tender.
//
//   Measured work (quantity × rate, from the takeoff)
// + Preliminaries       site setup, supervision, scaffolding, insurances        (% of measured work, or a sum)
// + Provisional sums    allowances for work not yet designed                    (sums)
// = Works cost
// + Contingency         risk allowance                                          (% of works cost)
// + Overheads           head-office cost                                        (% of works cost + contingency)
// + Profit                                                                      (% of everything above)
// = Tender sum (before VAT)
// + VAT
// = Total

export interface ProvisionalSum { id: string; name: string; amount: number }
export interface Markups {
  prelimsPercent?: number;
  /** Preliminaries as a lump sum instead of a percentage (used when > 0). */
  prelimsSum?: number;
  contingencyPercent?: number;
  overheadPercent?: number;
  profitPercent?: number;
  provisional?: ProvisionalSum[];
}

export interface BuildUpLine {
  key: 'measured' | 'prelims' | 'provisional' | 'works' | 'contingency' | 'overheads' | 'profit' | 'tender' | 'vat' | 'total';
  label: string;
  /** The percentage applied, when the line is one. */
  percent?: number;
  amount: number;
  /** Subtotal rows. */
  total?: boolean;
  note?: string;
}

const pct = (n?: number) => Math.min(1000, Math.max(0, Number.isFinite(n) ? (n as number) : 0));
const money = (n: number) => Math.round(n * 100) / 100;

export function buildUp(measured: number, markups: Markups | undefined, vatPercent: number | undefined): BuildUpLine[] {
  const m = markups ?? {};
  const prelims = (m.prelimsSum ?? 0) > 0 ? m.prelimsSum! : measured * pct(m.prelimsPercent) / 100;
  const provisional = (m.provisional ?? []).reduce((s, p) => s + (Number.isFinite(p.amount) ? Math.max(0, p.amount) : 0), 0);
  const works = measured + prelims + provisional;
  const contingency = works * pct(m.contingencyPercent) / 100;
  const overheads = (works + contingency) * pct(m.overheadPercent) / 100;
  const profit = (works + contingency + overheads) * pct(m.profitPercent) / 100;
  const tender = works + contingency + overheads + profit;
  const vat = tender * pct(vatPercent) / 100;
  return [
    { key: 'measured', label: 'Measured work', amount: money(measured), note: 'Quantity × rate, from the takeoff' },
    { key: 'prelims', label: 'Preliminaries', amount: money(prelims), percent: (m.prelimsSum ?? 0) > 0 ? undefined : pct(m.prelimsPercent), note: 'Site setup, supervision, temporary works, insurances' },
    { key: 'provisional', label: 'Provisional sums', amount: money(provisional), note: 'Allowances for work not yet designed' },
    { key: 'works', label: 'Works cost', amount: money(works), total: true },
    { key: 'contingency', label: 'Contingency', amount: money(contingency), percent: pct(m.contingencyPercent), note: 'Risk allowance, on the works cost' },
    { key: 'overheads', label: 'Overheads', amount: money(overheads), percent: pct(m.overheadPercent), note: 'Head-office cost' },
    { key: 'profit', label: 'Profit', amount: money(profit), percent: pct(m.profitPercent) },
    { key: 'tender', label: 'Tender sum (before VAT)', amount: money(tender), total: true },
    { key: 'vat', label: 'VAT', amount: money(vat), percent: pct(vatPercent) },
    { key: 'total', label: 'Total', amount: money(tender + vat), total: true },
  ];
}

export const hasMarkups = (m?: Markups) =>
  !!m && ((m.prelimsPercent ?? 0) > 0 || (m.prelimsSum ?? 0) > 0 || (m.contingencyPercent ?? 0) > 0 || (m.overheadPercent ?? 0) > 0 || (m.profitPercent ?? 0) > 0 || (m.provisional?.length ?? 0) > 0);
