// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import { Markdown } from './markdown.tsx';

afterEach(cleanup);

test('headings are rendered one level down', () => {
  render(<Markdown source={'# Title\n\n## Project — 유휴\n\n### 생성된 커밋 (0)\n'} />);
  expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('Title');
  expect(screen.getByRole('heading', { level: 3 }).textContent).toBe('Project — 유휴');
  expect(screen.getByRole('heading', { level: 4 }).textContent).toBe('생성된 커밋 (0)');
});

test('list items and task items', () => {
  const { container } = render(<Markdown source={'- one\n- two\n\n- [ ] todo\n- [x] done\n'} />);
  expect(container.querySelectorAll('ul')).toHaveLength(2);
  expect(screen.getAllByRole('listitem').map((li) => li.textContent?.trim())).toEqual(['one', 'two', 'todo', 'done']);
  const boxes = screen.getAllByRole<HTMLInputElement>('checkbox');
  expect(boxes.map((b) => [b.checked, b.disabled])).toEqual([
    [false, true],
    [true, true],
  ]);
});

test('fenced code block keeps content verbatim', () => {
  const { container } = render(<Markdown source={'```text\n# not a heading\n- **raw** `x`\n\nlast\n```\nafter'} />);
  expect(container.querySelector('pre')?.textContent).toBe('# not a heading\n- **raw** `x`\n\nlast');
  expect(container.querySelector('h2, li, strong, code')).toBeNull();
  expect(container.querySelector('p')?.textContent).toBe('after');
});

test('unterminated code fence does not crash', () => {
  const { container } = render(<Markdown source={'para\n```\ncode\nmore'} />);
  expect(container.querySelector('p')?.textContent).toBe('para');
  expect(container.querySelector('pre')?.textContent).toBe('code\nmore');
});

test('blockquote and paragraphs', () => {
  const { container } = render(<Markdown source={'> demo mode 에서\n> 생성됨\n\nfirst line\nsecond line\n\nnext'} />);
  expect(container.querySelector('blockquote')?.textContent).toBe('demo mode 에서 생성됨');
  expect([...container.querySelectorAll('p')].map((p) => p.textContent)).toEqual(['first line second line', 'next']);
});

test('inline code and bold', () => {
  const { container } = render(<Markdown source={'- **실패** — `npm test` · exit 1\n\na `**not bold**` b **x `y`** c **open'} />);
  const li = container.querySelector('li');
  expect(li?.querySelector('strong')?.textContent).toBe('실패');
  expect(li?.querySelector('code')?.textContent).toBe('npm test');
  expect(li?.textContent).toBe('실패 — npm test · exit 1');
  const p = container.querySelector('p');
  expect([...(p?.querySelectorAll('code') ?? [])].map((c) => c.textContent)).toEqual(['**not bold**', 'y']);
  expect(p?.querySelector('strong')?.textContent).toBe('x y');
  expect(p?.textContent).toBe('a **not bold** b x y c **open');
});

test('html in the source is shown as text', () => {
  const { container } = render(<Markdown source={'<img src=x onerror=alert(1)>'} />);
  expect(container.querySelector('img')).toBeNull();
  expect(container.textContent).toContain('<img');
});
