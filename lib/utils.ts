import { formatMoney } from '@/lib/takeoff/currency';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Money in the open project's currency (set from the project, AED by default). */
export function formatCurrency(value: number) {
  return formatMoney(value);
}

export function formatQuantity(value: number, unit: string) {
  return `${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${unit}`;
}
