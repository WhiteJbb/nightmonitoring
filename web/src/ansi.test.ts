import { expect, test } from 'vitest';
import { parseAnsi } from './ansi.ts';

const E = '\x1b';

test('plain text passes through with empty style', () => {
  expect(parseAnsi(['hello', ''])).toEqual([[{ text: 'hello', style: {} }], []]);
});

test('basic and bright fg/bg colors, default resets', () => {
  const [line] = parseAnsi([`${E}[31mred${E}[92;44mbright${E}[39;49mplain`]);
  expect(line).toHaveLength(3);
  expect(line?.[0]).toEqual({ text: 'red', style: { color: '#f87171' } });
  expect(line?.[1]?.style).toEqual({ color: '#86efac', backgroundColor: '#6ea8fe' });
  expect(line?.[2]).toEqual({ text: 'plain', style: {} });
});

test('attributes and their resets', () => {
  const [line] = parseAnsi([`${E}[1;2;3;4mA${E}[22mB${E}[23;24mC`]);
  expect(line?.[0]?.style).toEqual({ fontWeight: 'bold', opacity: 0.6, fontStyle: 'italic', textDecoration: 'underline' });
  expect(line?.[1]?.style).toEqual({ fontStyle: 'italic', textDecoration: 'underline' });
  expect(line?.[2]?.style).toEqual({});
});

test('inverse swaps fg and bg, using defaults when unset', () => {
  const [line] = parseAnsi([`${E}[7mA${E}[31mB${E}[27mC`]);
  expect(line?.[0]?.style).toEqual({ color: '#06080b', backgroundColor: '#d6dde6' });
  expect(line?.[1]?.style).toEqual({ color: '#06080b', backgroundColor: '#f87171' });
  expect(line?.[2]?.style).toEqual({ color: '#f87171' });
});

test('256-color: palette, cube and grayscale', () => {
  const [line] = parseAnsi([`${E}[38;5;1ma${E}[38;5;196mb${E}[48;5;232mc${E}[38;5;255md`]);
  expect(line?.[0]?.style.color).toBe('#f87171');
  expect(line?.[1]?.style.color).toBe('rgb(255,0,0)');
  expect(line?.[2]?.style.backgroundColor).toBe('rgb(8,8,8)');
  expect(line?.[3]?.style.color).toBe('rgb(238,238,238)');
});

test('truecolor, followed by more params in the same sequence', () => {
  const [line] = parseAnsi([`${E}[38;2;10;20;30;48;2;1;2;3;1mx`]);
  expect(line).toEqual([{ text: 'x', style: { color: 'rgb(10,20,30)', backgroundColor: 'rgb(1,2,3)', fontWeight: 'bold' } }]);
});

test('state carries across lines until reset', () => {
  const lines = parseAnsi([`${E}[32mgreen`, 'still green', `${E}[0mreset`, `${E}[35mm${E}[mempty-reset`]);
  expect(lines[0]?.[0]?.style).toEqual({ color: '#4ade80' });
  expect(lines[1]).toEqual([{ text: 'still green', style: { color: '#4ade80' } }]);
  expect(lines[2]).toEqual([{ text: 'reset', style: {} }]);
  expect(lines[3]?.[1]).toEqual({ text: 'empty-reset', style: {} });
});

test('non-SGR and broken escapes are dropped, never rendered', () => {
  const lines = parseAnsi([`a${E}[2Kb${E}[1;1Hc${E}]0;title\x07d${E}[?25le`, `x${E}[31`, `y${E}`, `${E}[38;9;1mz`]);
  const text = (l: number) => lines[l]?.map((s) => s.text).join('');
  expect(text(0)).toBe('abcde');
  expect(text(1)).toBe('x');
  expect(text(2)).toBe('y');
  expect(lines[3]).toEqual([{ text: 'z', style: {} }]);
  expect(JSON.stringify(lines)).not.toContain('\\u001b');
});
