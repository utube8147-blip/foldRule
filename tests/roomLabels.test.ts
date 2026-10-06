import { describe, it, expect } from 'vitest';
import { pickRoomLabel } from '@/lib/takeoff/roomLabels';

const inBox = (x0: number, y0: number, x1: number, y1: number) => (x: number, y: number) => x >= x0 && x <= x1 && y >= y0 && y <= y1;

describe('room name from the drawing', () => {
  const items = [
    { text: 'BEDROOM 1', x: 50, y: 50, size: 10 },
    { text: '3000', x: 50, y: 20, size: 8 },
    { text: '12.5 m²', x: 50, y: 62, size: 7 },
    { text: 'FFL +0.150', x: 50, y: 70, size: 7 },
    { text: 'KITCHEN', x: 250, y: 50, size: 10 },
  ];
  it('takes the name inside the room and skips numbers', () => {
    expect(pickRoomLabel(items, inBox(0, 0, 100, 100))).toBe('BEDROOM 1');
    expect(pickRoomLabel(items, inBox(200, 0, 300, 100))).toBe('KITCHEN');
  });
  it('joins a two-line name in reading order', () => {
    const two = [{ text: 'ROOM', x: 50, y: 62, size: 10 }, { text: 'LIVING', x: 50, y: 50, size: 10 }];
    expect(pickRoomLabel(two, inBox(0, 0, 100, 100))).toBe('LIVING ROOM');
  });
  it('returns nothing when the room has no name', () => {
    expect(pickRoomLabel(items, inBox(400, 400, 500, 500))).toBe('');
    expect(pickRoomLabel([{ text: '2400', x: 5, y: 5, size: 9 }], inBox(0, 0, 10, 10))).toBe('');
  });
});
