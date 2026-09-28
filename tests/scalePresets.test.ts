import { describe, it, expect } from 'vitest';
import { presetScaleFactor } from '@/components/Viewer/ViewerToolbar';

const MM_PER_PT = 25.4 / 72;
const ptFromMm = (mm: number) => mm / MM_PER_PT;

describe('scale presets', () => {
  it('1:100 at actual PDF size: 1 pt on paper = 100 pt in reality', () => {
    // 1 pt = 0.3528 mm on paper → 35.28 mm = 0.03528 m real
    expect(presetScaleFactor(100, 'actual', ptFromMm(841))).toBeCloseTo(0.035278, 5);
  });

  it('a 10 m wall drawn at 1:50 measures correctly', () => {
    const paperMm = 10_000 / 50;                        // 200 mm on paper
    const f = presetScaleFactor(50, 'actual', ptFromMm(594));
    expect(ptFromMm(paperMm) * f).toBeCloseTo(10, 6);
  });

  it('"1:100 @ A1" printed on A3 corrects for the smaller sheet', () => {
    const a3LongPt = ptFromMm(420);
    const f = presetScaleFactor(100, 'A1', a3LongPt);
    // A 10 m wall is 100 mm on A1 but 100 × 420/841 mm on the A3 print.
    const onA3Mm = 100 * (420 / 841);
    expect(ptFromMm(onA3Mm) * f).toBeCloseTo(10, 6);
  });

  it('choosing the paper the PDF already is changes nothing', () => {
    const a1 = ptFromMm(841);
    expect(presetScaleFactor(100, 'A1', a1)).toBeCloseTo(presetScaleFactor(100, 'actual', a1), 9);
  });
});
