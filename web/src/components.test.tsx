// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { ProjectSnapshot, RunResult, Snapshot, TmuxPane } from '../../shared/types.ts';
import { ConfigErrorBanner, Dashboard, ProjectCard } from './App.tsx';
import { GitTab, RunPanel, TerminalTab } from './ProjectDetail.tsx';

const NOW = '2026-10-04T03:00:00.000Z';

function project(over: Partial<ProjectSnapshot> = {}): ProjectSnapshot {
  return {
    id: 'api',
    name: 'api-server',
    repoPath: '/repos/api',
    tmuxSession: 'api',
    testCommand: 'npm test',
    buildCommand: null,
    logFile: '/repos/api/app.log',
    allowInput: false,
    git: {
      ok: true,
      branch: 'main',
      head: 'abcdef1234',
      clean: true,
      changedFiles: [],
      diffStat: [],
      additions: 0,
      deletions: 0,
      recentCommits: [],
      todayCommits: [],
      fingerprint: '',
    },
    since: null,
    lastGitChangeAt: null,
    tmux: {
      configured: true,
      exists: true,
      createdAt: NOW,
      attached: false,
      lastActivityAt: NOW,
      lastOutputChangeAt: NOW,
      output: ['plain output'],
      panes: [],
      waitingPrompt: null,
      attachCommand: 'tmux attach -t api',
    },
    logErrors: [],
    status: { state: 'running', reasons: [] },
    runs: { test: null, build: null },
    history: { test: [], build: [] },
    ...over,
  };
}

const pane = (id: string, index: number, active: boolean, lines: string[]): TmuxPane => ({
  id,
  window: 0,
  windowName: 'zsh',
  index,
  command: index === 0 ? 'node' : 'zsh',
  active,
  lines,
});

const run = (over: Partial<RunResult> = {}): RunResult => ({
  kind: 'test',
  command: 'npm test',
  running: false,
  startedAt: NOW,
  finishedAt: NOW,
  exitCode: 0,
  timedOut: false,
  canceled: false,
  durationMs: 1200,
  stdout: '',
  stderr: '',
  ...over,
});

const fetchMock = vi.fn<typeof fetch>();
const respond = (status: number, body: unknown) => fetchMock.mockResolvedValue(new Response(JSON.stringify(body), { status }));

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test('project card shows state label and reasons', () => {
  const p = project({ status: { state: 'waiting', reasons: ['확인 프롬프트에서 대기 중'] } });
  render(<ProjectCard p={p} now={NOW} />);
  expect(screen.getByText('입력 대기').className).toContain('state-waiting');
  expect(screen.getByText('확인 프롬프트에서 대기 중')).toBeTruthy();
  expect(screen.getByRole('link').className).toContain('state-waiting');
  expect(screen.getByText('브랜치')).toBeTruthy();
});

test('project card shows the git error variant', () => {
  const base = project();
  const p = project({ status: { state: 'error', reasons: ['Git 오류'] }, git: { ...base.git, ok: false, error: 'not a git repository' } });
  render(<ProjectCard p={p} now={NOW} />);
  expect(screen.getByText('오류')).toBeTruthy();
  expect(screen.getByText('not a git repository')).toBeTruthy();
  expect(screen.queryByText('브랜치')).toBeNull();
});

test('terminal falls back to plain output and shows the waiting prompt', () => {
  const base = project();
  render(<TerminalTab project={project({ tmux: { ...base.tmux, waitingPrompt: 'Proceed? (y/n)' } })} now={NOW} />);
  expect(screen.getByLabelText('최근 터미널 출력 100줄').textContent).toBe('plain output');
  expect(screen.getByRole('status').textContent).toContain('Proceed? (y/n)');
  expect(screen.queryByRole('group', { name: 'pane 선택' })).toBeNull();
});

test('pane selector defaults to the active pane, switches, and keeps the selection on rerender', () => {
  const base = project();
  const withPanes = (panes: TmuxPane[]) => project({ tmux: { ...base.tmux, panes } });
  const term = () => screen.getByLabelText('최근 터미널 출력 100줄');
  const { rerender } = render(
    <TerminalTab project={withPanes([pane('%1', 0, false, ['\x1b[31mfirst']), pane('%2', 1, true, ['second'])])} now={NOW} />,
  );
  expect(term().textContent).toBe('second');
  const first = screen.getByRole('button', { name: '0:zsh · 0 node' });
  expect(screen.getByRole('button', { name: '0:zsh · 1 zsh' }).getAttribute('aria-pressed')).toBe('true');

  fireEvent.click(first);
  expect(term().textContent).toBe('first');
  expect(screen.getByText('first').style.color).toBe('rgb(248, 113, 113)');

  // 새 스냅샷: 내용이 바뀌어도 고른 pane 이 유지된다
  rerender(<TerminalTab project={withPanes([pane('%1', 0, false, ['first', 'more']), pane('%2', 1, true, ['second!'])])} now={NOW} />);
  expect(term().textContent).toBe('first\nmore');

  // 고른 pane 이 사라지면 활성 pane 으로
  rerender(<TerminalTab project={withPanes([pane('%2', 1, true, ['second!']), pane('%3', 2, false, ['third'])])} now={NOW} />);
  expect(term().textContent).toBe('second!');
});

test('run panel shows 취소 while running and calls DELETE', async () => {
  respond(202, { ok: true });
  const p = project({ runs: { test: run({ running: true, finishedAt: null, exitCode: null, durationMs: null }), build: null } });
  render(<RunPanel project={p} kind="test" title="테스트" />);
  fireEvent.click(screen.getByRole('button', { name: '취소' }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/projects/api/run/test', { method: 'DELETE' }));
});

test('run panel shows an inline error when cancel fails', async () => {
  respond(409, { error: '실행 중이 아닙니다' });
  const p = project({ runs: { test: run({ running: true }), build: null } });
  render(<RunPanel project={p} kind="test" title="테스트" />);
  fireEvent.click(screen.getByRole('button', { name: '취소' }));
  expect((await screen.findByRole('alert')).textContent).toBe('취소 요청 실패: 실행 중이 아닙니다');
});

test('canceled result shows 취소됨 in a neutral color, and no cancel button', () => {
  const p = project({ runs: { test: run({ canceled: true, exitCode: null }), build: null } });
  render(<RunPanel project={p} kind="test" title="테스트" />);
  expect(screen.getByText('취소됨').className).toBe('dim');
  expect(screen.queryByText('실패')).toBeNull();
  expect(screen.queryByRole('button', { name: '취소' })).toBeNull();
});

test('history rows render with verdict, exit code and duration', () => {
  const summary = { startedAt: NOW, finishedAt: NOW, exitCode: 0, timedOut: false, canceled: false, durationMs: 1200 };
  const history = [
    summary,
    { ...summary, exitCode: 1, durationMs: 300 },
    { ...summary, exitCode: null, timedOut: true },
    { ...summary, exitCode: null, canceled: true },
  ];
  render(<RunPanel project={project({ history: { test: history, build: [] } })} kind="test" title="테스트" />);
  const rows = within(screen.getByRole('table')).getAllByRole('row').slice(1);
  expect(rows.map((r) => within(r).getAllByRole('cell')[1]?.textContent)).toEqual(['성공', '실패', '시간 초과', '취소됨']);
  expect(within(rows[1]!).getAllByRole('cell').slice(2).map((c) => c.textContent)).toEqual(['1', '300ms']);
});

test('no history table when history is empty', () => {
  render(<RunPanel project={project()} kind="test" title="테스트" />);
  expect(screen.queryByRole('table')).toBeNull();
});

test('git tab: renames, untracked marker, and ack button calls the endpoint', async () => {
  respond(200, { ok: true });
  const base = project();
  const p = project({
    logErrors: ['ERROR boom'],
    git: {
      ...base.git,
      clean: false,
      changedFiles: [{ path: 'new.ts', status: 'R ', from: 'old.ts' }],
      diffStat: [{ path: 'notes.md', additions: 3, deletions: 0, untracked: true }],
      additions: 3,
    },
  });
  render(<GitTab project={p} now={NOW} />);
  expect(screen.getByText('old.ts →').parentElement?.textContent).toBe('old.ts → new.ts');
  expect(screen.getByText('new')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '확인 처리' }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/projects/api/ack-errors', { method: 'POST' }));
});

test('git tab: ack failure shows an inline error; no button without log errors', async () => {
  respond(500, { error: 'boom' });
  const { rerender } = render(<GitTab project={project({ logErrors: ['ERROR x'] })} now={NOW} />);
  fireEvent.click(screen.getByRole('button', { name: '확인 처리' }));
  expect((await screen.findByRole('alert')).textContent).toBe('확인 처리 실패: boom');
  rerender(<GitTab project={project()} now={NOW} />);
  expect(screen.queryByRole('button', { name: '확인 처리' })).toBeNull();
});

test('config error banner preserves the message', () => {
  render(<ConfigErrorBanner message={'line 1\nline 2'} />);
  const alert = screen.getByRole('alert');
  expect(alert.textContent).toContain('config 를 다시 읽지 못했습니다. 이전 설정으로 동작 중입니다.');
  expect(alert.querySelector('.pre-wrap')?.textContent).toBe('line 1\nline 2');
});

test('dashboard: waiting tile, meta line, and session reset after confirm', async () => {
  respond(200, { ok: true });
  const snapshot: Snapshot = {
    generatedAt: NOW,
    startedAt: '2026-10-04T01:00:00.000Z',
    demo: false,
    refreshIntervalSec: 5,
    configPath: '/c.json',
    configMissing: false,
    configError: null,
    autoReportTime: '07:00',
    summary: { total: 1, sessionsRunning: 1, running: 0, waiting: 1, idle: 0, stalled: 0, error: 0 },
    projects: [project({ status: { state: 'waiting', reasons: [] } })],
  };
  const { container } = render(<Dashboard snapshot={snapshot} />);
  expect([...container.querySelectorAll('.tile dt')].map((d) => d.textContent)).toEqual([
    '전체 프로젝트',
    '실행 중인 세션',
    '정상',
    '입력 대기',
    '유휴',
    '정지 의심',
    '오류',
  ]);
  const meta = container.querySelector('.meta')?.textContent ?? '';
  expect(meta).toContain('2시간 전');
  expect(meta).toContain('갱신 주기 5초');
  expect(meta).toContain('자동 보고서 07:00');

  const confirm = vi.fn(() => false);
  vi.stubGlobal('confirm', confirm);
  fireEvent.click(screen.getByRole('button', { name: '모니터링 새로 시작' }));
  expect(confirm).toHaveBeenCalledOnce();
  expect(fetchMock).not.toHaveBeenCalled();

  confirm.mockReturnValue(true);
  fireEvent.click(screen.getByRole('button', { name: '모니터링 새로 시작' }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/session/reset', { method: 'POST' }));
});
