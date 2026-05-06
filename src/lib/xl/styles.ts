// styles.ts
import * as ExcelJS from 'exceljs';

export const Colors = {
  NAVY: 'FF0D1B2A',
  GOLD: 'FFB8962E',
  GOLD_LIGHT: 'FFC8A84B',
  MID_BLUE: 'FF1A3A5C',
  CHARCOAL: 'FF2C3E50',
  WHITE: 'FFFFFFFF',
  PALE_BLUE: 'FFEBF3FB',
  MID_GREY: 'FF6C7A8D',
  DARK_TEXT: 'FF1C1C1C',
  LIME_HL: 'FFE2EFDA',
  PEACH_HL: 'FFFCE4D6',
  SUBGRP_BG: 'FFD9E1F2',
  SEC_BAR_BG: 'FF0D1B2A',
  SEC_ACCENT: 'FFB8962E',
  SEC_TAG_BG: 'FF1A3A5C',
  SEC_TAG_FG: 'FFC8A84B',
  GREEN_HL: 'FFE8F5E9',
  AMBER_HL: 'FFFFF8E7',
  BORDER_LIGHT: 'FFE0E0E0',
  BORDER_DARK: 'FFBBBBBB',
};

export const FONT_FACE = 'Calibri';
export const BASE_H = 16;

export function getColumnLetter(col: number): string {
  let result = '';
  while (col > 0) {
    col--;
    result = String.fromCharCode(65 + (col % 26)) + result;
    col = Math.floor(col / 26);
  }
  return result;
}

export function createFill(color: string): Partial<ExcelJS.Fill> {
  return { type: 'pattern', pattern: 'solid', fgColor: { argb: color } };
}

export function createFont(size: number, bold: boolean = false, color: string = Colors.DARK_TEXT, italic: boolean = false): Partial<ExcelJS.Font> {
  return { name: FONT_FACE, size, bold, color: { argb: color }, italic };
}

export function createAlignment(horizontal: 'left' | 'center' | 'right' = 'left', vertical: 'center' | 'top' | 'bottom' = 'center', wrap: boolean = false): Partial<ExcelJS.Alignment> {
  return { horizontal, vertical, wrapText: wrap };
}

export function createBorder(style: 'thin' | 'medium' | 'thick' = 'thin', color: string = Colors.BORDER_DARK): Partial<ExcelJS.Border> {
  return { style, color: { argb: color } };
}

export function createFullBorder(color: string = Colors.BORDER_DARK): Partial<ExcelJS.Borders> {
  const border = createBorder('thin', color);
  return { top: border, bottom: border, left: border, right: border };
}

export function createThickBorder(color: string = Colors.GOLD_LIGHT): Partial<ExcelJS.Borders> {
  const border = createBorder('medium', color);
  return { top: border, bottom: border, left: border, right: border };
}