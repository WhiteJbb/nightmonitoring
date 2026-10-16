// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { ReportMeta } from '../../shared/types.ts';
import { Reports } from './Reports.tsx';

const A = '2026-10-15-morning-report.md';
const B = '2026-10-16-morning-report.md';
let metas: ReportMeta[];
let contents: Record<string, string>;
const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  metas = [{ name: A, modifiedAt: '2026-10-15T07:00:00.000Z' }];
  contents = { [A]: '# 어제 보고서', [B]: '# 오늘 보고서' };
  fetchMock.mockReset();
  fetchMock.mockImplementation((input) => {
    const url = String(input);
    const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status }));
    if (url === '/api/reports') return json(metas);
    if (url.startsWith('/api/reports/')) {
      const name = decodeURIComponent(url.slice('/api/reports/'.length));
      return json({ name, content: contents[name] });
    }
    return json({ error: 'no' }, 404);
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test('reports: a report generated while the page is open shows up when the window regains focus', async () => {
  render(<Reports />);
  await screen.findByText('어제 보고서');
  expect(screen.queryByRole('button', { name: new RegExp(B) })).toBeNull();

  metas = [{ name: B, modifiedAt: '2026-10-16T07:00:00.000Z' }, ...metas];
  fireEvent.focus(window);
  await screen.findByRole('button', { name: new RegExp(B) });

  // 목록 새로고침 버튼도 같은 목록을 다시 받는다
  const calls = fetchMock.mock.calls.filter(([u]) => String(u) === '/api/reports').length;
  fireEvent.click(screen.getByRole('button', { name: '목록 새로고침' }));
  await waitFor(() => expect(fetchMock.mock.calls.filter(([u]) => String(u) === '/api/reports').length).toBe(calls + 1));
});

test('reports: the open report is reloaded when it changes on disk', async () => {
  render(<Reports />);
  await screen.findByText('어제 보고서');

  contents[A] = '# 다시 만든 보고서';
  metas = [{ name: A, modifiedAt: '2026-10-15T08:00:00.000Z' }];
  fireEvent.click(screen.getByRole('button', { name: '목록 새로고침' }));
  await screen.findByText('다시 만든 보고서');
  expect(screen.getByRole('status').textContent).toContain('보고서가 갱신되었습니다');
});

test('reports: the narrow-screen selector opens a report and focuses its heading', async () => {
  metas = [{ name: B, modifiedAt: '2026-10-16T07:00:00.000Z' }, ...metas];
  render(<Reports />);
  await screen.findByText('오늘 보고서');
  expect(screen.getByRole('button', { name: '미리보기' }).getAttribute('aria-pressed')).toBe('true');

  fireEvent.change(screen.getByLabelText('보고서 선택'), { target: { value: A } });
  await screen.findByText('어제 보고서');
  await waitFor(() => expect(document.activeElement?.textContent).toContain(A));
});
