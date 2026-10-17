// @vitest-environment jsdom
import { expect, test, vi } from 'vitest';
import { termHeight } from './termsize.ts';

test('on a phone the keyboard shrinking the window does not shrink the terminal; rotating does', () => {
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: !q.includes('pointer: fine'), media: q }));
  const view = (width: number, height: number) => {
    Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, value: width });
    vi.stubGlobal('innerHeight', height);
  };
  view(390, 844);
  expect(termHeight()).toBeCloseTo(844 * 0.7);
  view(390, 500); // 화면 키보드
  expect(termHeight()).toBeCloseTo(844 * 0.7);
  view(844, 390); // 가로로 돌림
  expect(termHeight()).toBeCloseTo(390 * 0.7);
  vi.unstubAllGlobals();
});
