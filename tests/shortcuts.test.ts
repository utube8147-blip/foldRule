import { describe, it, expect, beforeEach } from 'vitest';
import { PRESETS, SHORTCUT_LIST, applyPreset, activePreset, clearShortcut, isDeleteKey, actionForKey, setShortcut, shortcutKey, keyLabel, canAssign, resetShortcuts, wheelMode, setWheelMode, __resetShortcutsForTests } from '@/lib/shortcuts';

beforeEach(() => {
  __resetShortcutsForTests();
  (globalThis as any).window = { localStorage: { getItem: () => null, setItem: () => {} } };
});

describe('custom shortcuts', () => {
  it('starts with the defaults', () => {
    expect(actionForKey('P')).toBe('area');
    expect(actionForKey('F8')).toBe('angle');
    expect(keyLabel('select')).toBe('V');
  });
  it('moves an action to a free key', () => {
    expect(setShortcut('area', 'q')).toBeUndefined();
    expect(actionForKey('q')).toBe('area');
    expect(actionForKey('p')).toBeUndefined();
  });
  it('swaps when the key is already used, so nothing is left without a key', () => {
    expect(setShortcut('area', 'r')).toBe('rectangle');
    expect(shortcutKey('area')).toBe('r');
    expect(shortcutKey('rectangle')).toBe('p');
  });
  it('refuses keys with a fixed meaning', () => {
    expect(canAssign('Enter')).toBe(false);
    expect(canAssign('Backspace')).toBe(false);
    setShortcut('area', 'Escape');
    expect(shortcutKey('area')).toBe('p');
  });
  it('resets, including the wheel', () => {
    setShortcut('area', 'q'); setWheelMode('scroll');
    resetShortcuts();
    expect(shortcutKey('area')).toBe('p'); expect(wheelMode()).toBe('zoom');
  });
  it('recognises every way a keyboard says delete', () => {
    for (const k of ['Delete', 'Del', 'Backspace', 'Insert']) expect(isDeleteKey({ key: k })).toBe(true);
    expect(isDeleteKey({ key: 'Delete', code: 'NumpadDecimal' })).toBe(true);
    expect(isDeleteKey({ key: '.', code: 'NumpadDecimal' })).toBe(false);
    expect(isDeleteKey({ key: 'd' })).toBe(false);
  });
  it('no two actions share a key, in either preset', () => {
    for (const name of Object.keys(PRESETS) as (keyof typeof PRESETS)[]) {
      applyPreset(name);
      const keys = SHORTCUT_LIST.map(s => shortcutKey(s.id)).filter(Boolean);
      expect(new Set(keys).size, name).toBe(keys.length);
      expect(activePreset()).toBe(name);
    }
  });
  it('the PlanSwift set maps its keys and frees the ones it replaces', () => {
    applyPreset('planswift');
    expect(actionForKey('1')).toBe('area'); expect(actionForKey('2')).toBe('length'); expect(actionForKey('4')).toBe('count');
    expect(actionForKey('r')).toBe('swap'); expect(actionForKey('c')).toBe('close'); expect(actionForKey('a')).toBe('curve');
    expect(actionForKey('q')).toBe('rectangle'); expect(actionForKey('p')).toBeUndefined();
  });
  it('an action can be left without a key', () => {
    clearShortcut('magic');
    expect(shortcutKey('magic')).toBe(''); expect(actionForKey('m')).toBeUndefined(); expect(actionForKey('')).toBeUndefined();
  });
});
