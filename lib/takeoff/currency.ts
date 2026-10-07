// Currencies offered for a project. The Gulf states come first; VAT is the standard
// rate to start a new bill from and stays editable per project.

export interface CurrencyInfo {
  code: string;
  name: string;
  /** Minor-unit decimals (the Bahraini, Kuwaiti and Omani currencies use three). */
  decimals: number;
  /** Standard VAT % to suggest when the currency is picked. */
  vat: number;
}

export const CURRENCIES: CurrencyInfo[] = [
  { code: 'AED', name: 'UAE dirham',      decimals: 2, vat: 5 },
  { code: 'SAR', name: 'Saudi riyal',     decimals: 2, vat: 15 },
  { code: 'QAR', name: 'Qatari riyal',    decimals: 2, vat: 0 },
  { code: 'OMR', name: 'Omani rial',      decimals: 3, vat: 5 },
  { code: 'BHD', name: 'Bahraini dinar',  decimals: 3, vat: 10 },
  { code: 'KWD', name: 'Kuwaiti dinar',   decimals: 3, vat: 0 },
  { code: 'USD', name: 'US dollar',       decimals: 2, vat: 0 },
  { code: 'GBP', name: 'Pound sterling',  decimals: 2, vat: 20 },
  { code: 'EUR', name: 'Euro',            decimals: 2, vat: 0 },
  { code: 'LKR', name: 'Sri Lankan rupee', decimals: 2, vat: 18 },
];

export const DEFAULT_CURRENCY = 'AED';

export const currencyInfo = (code?: string | null): CurrencyInfo | undefined =>
  CURRENCIES.find(c => c.code === (code ?? '').trim().toUpperCase());

export const currencyDecimals = (code?: string | null): number => currencyInfo(code)?.decimals ?? 2;

/** Excel number format for money in a currency, e.g. `"BHD "#,##0.000`. */
export function excelMoneyFormat(code?: string | null): string {
  const digits = `#,##0.${'0'.repeat(currencyDecimals(code))}`;
  const c = (code ?? '').replace(/"/g, '').trim();
  return c ? `"${c} "${digits}` : digits;
}

let displayCurrency = DEFAULT_CURRENCY;
/** Currency the open project is priced in; used by formatMoney everywhere in the app. */
export const setDisplayCurrency = (code?: string | null) => { displayCurrency = (code ?? '').trim() || DEFAULT_CURRENCY; };

export function formatMoney(value: number, code: string = displayCurrency): string {
  const d = currencyDecimals(code);
  const n = (Number.isFinite(value) ? value : 0).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  return `${code} ${n}`;
}
