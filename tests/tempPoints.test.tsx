// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderHook, act } from '@testing-library/react';
import { TakeoffProvider, useTakeoffContext } from '@/context/TakeoffContext';

const wrapper = ({ children }: { children: React.ReactNode }) => <TakeoffProvider>{children}</TakeoffProvider>;

describe('in-progress points', () => {
  it('keeps every point when several are pushed in one handler (arc from a centre)', () => {
    const { result } = renderHook(() => useTakeoffContext(), { wrapper });
    act(() => {
      result.current.pushPoint({ x: 0.1, y: 0.1, snapped: false });   // start
      result.current.pushPoint({ x: 0.2, y: 0.2, snapped: false });   // middle
      result.current.pushPoint({ x: 0.3, y: 0.1, snapped: false });   // end
      result.current.pushPoint({ x: -1, y: -1, snapped: false });     // break marker
    });
    expect(result.current.tempPoints.map(p => p.x)).toEqual([0.1, 0.2, 0.3, -1]);
  });

  it('retag + push in the same handler keeps both changes (Linear → Polyarc upgrade)', () => {
    const { result } = renderHook(() => useTakeoffContext(), { wrapper });
    act(() => { result.current.pushPoint({ x: 0, y: 0, snapped: false }); result.current.pushPoint({ x: 1, y: 0, snapped: false }); });
    act(() => {
      result.current.retagTempPoints(pts => pts.map(p => ({ ...p, segmentType: 'line' })));
      result.current.pushPoint({ x: 1, y: 0, snapped: false, segmentType: 'arc' });
    });
    expect(result.current.tempPoints).toHaveLength(3);
    expect(result.current.tempPoints.map(p => p.segmentType)).toEqual(['line', 'line', 'arc']);
  });

  it('undo removes the points one at a time', () => {
    const { result } = renderHook(() => useTakeoffContext(), { wrapper });
    act(() => { result.current.pushPoint({ x: 0, y: 0, snapped: false }); result.current.pushPoint({ x: 1, y: 1, snapped: false }); result.current.pushPoint({ x: 2, y: 2, snapped: false }); });
    act(() => result.current.undo());
    expect(result.current.tempPoints).toHaveLength(2);
  });
});
