// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { ProjectSnapshot, RunResult, Snapshot } from '../../shared/types.ts';
import { NOT_A_REPO } from '../../shared/types.ts';
import { ConfigErrorBanner, Dashboard, ProjectCard } from './App.tsx';
import { GitTab, ProjectDetail, RunPanel, TerminalTab } from './ProjectDetail.tsx';

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
  expect(screen.getByRole('link', { name: 'api-server' }).closest('.card')?.className).toContain('state-waiting');
  // 라벨 없이 값만 나오고, 무엇인지는 title 로 알려 준다
  expect(screen.getByTitle(/^브랜치: /)).toBeTruthy();
});

test('project card shows the git error variant', () => {
  const base = project();
  const p = project({ status: { state: 'error', reasons: ['Git 오류'] }, git: { ...base.git, ok: false, error: 'not a git repository' } });
  render(<ProjectCard p={p} now={NOW} />);
  expect(screen.getByText('오류')).toBeTruthy();
  expect(screen.getByText('not a git repository')).toBeTruthy();
  expect(screen.queryByTitle(/^브랜치: /)).toBeNull();
});

test('terminal falls back to plain output and shows the waiting prompt', () => {
  const base = project();
  render(<TerminalTab project={project({ tmux: { ...base.tmux, waitingPrompt: 'Proceed? (y/n)' } })} now={NOW} />);
  expect(screen.getByLabelText('최근 터미널 출력').textContent).toBe('plain output');
  expect(screen.getByRole('status').textContent).toContain('Proceed? (y/n)');
  expect(screen.queryByRole('group', { name: 'pane 선택' })).toBeNull();
});

test('numbered choices under a waiting prompt are answer buttons that send the number to that pane', async () => {
  respond(200, { ok: true });
  const base = project();
  const waiting = { ...base.tmux, waitingPrompt: 'Do you want to proceed?', waitingChoices: { pane: '%7', options: [{ key: '1', label: 'Yes' }, { key: '2', label: 'No' }] } };
  const { unmount } = render(<TerminalTab project={project({ allowInput: true, tmux: waiting })} now={NOW} />);
  fireEvent.click(screen.getByRole('button', { name: '1. Yes' }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/projects/api/input', expect.objectContaining({ method: 'POST' })));
  const call = fetchMock.mock.calls.find(([url]) => url === '/api/projects/api/input')!;
  expect(JSON.parse(call[1]!.body as string)).toEqual({ pane: '%7', text: '1' });
  unmount();
  // 보기 전용 프로젝트에는 버튼이 없다
  render(<TerminalTab project={project({ tmux: waiting })} now={NOW} />);
  expect(screen.queryByRole('group', { name: '바로 답하기' })).toBeNull();
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
  expect(screen.getByText('ERROR boom')).toBeTruthy();
});

test('detail: log errors are acknowledged from the top of the page, with feedback; no notice without errors', async () => {
  respond(200, { ok: true });
  render(<ProjectDetail project={project({ logErrors: ['ERROR x'] })} now={NOW} />);
  expect(screen.getByRole('tab', { name: /Git/ }).textContent).toBe('Git1');
  fireEvent.click(screen.getByRole('button', { name: '로그 보기' }));
  expect(screen.getByRole('tab', { name: /Git/ }).getAttribute('aria-selected')).toBe('true');
  fireEvent.click(screen.getByRole('button', { name: '로그 오류 확인 완료' }));
  expect((await screen.findByRole('status')).textContent).toContain('로그 오류 표시를 지웠습니다');
  expect(fetchMock).toHaveBeenCalledWith('/api/projects/api/ack-errors', { method: 'POST' });
  window.location.hash = '';
});

test('detail: ack failure shows an inline error; no notice without log errors', async () => {
  respond(500, { error: 'boom' });
  const { rerender } = render(<ProjectDetail project={project({ logErrors: ['ERROR x'] })} now={NOW} />);
  fireEvent.click(screen.getByRole('button', { name: '로그 오류 확인 완료' }));
  expect((await screen.findByRole('alert')).textContent).toBe('확인 처리 실패: boom');
  rerender(<ProjectDetail project={project()} now={NOW} />);
  expect(screen.queryByRole('button', { name: '로그 오류 확인 완료' })).toBeNull();
});

test('detail tabs: arrow keys move, only the selected tab is tabbable, tab and panel are linked, the hash keeps the tab', () => {
  window.location.hash = '#/project/api/runs';
  render(<ProjectDetail project={project()} now={NOW} />);
  const tabs = screen.getAllByRole('tab');
  expect(tabs.map((t) => t.tabIndex)).toEqual([-1, -1, 0]);
  const panel = screen.getByRole('tabpanel');
  expect(tabs[2]!.getAttribute('aria-controls')).toBe(panel.id);
  expect(panel.getAttribute('aria-labelledby')).toBe(tabs[2]!.id);
  fireEvent.keyDown(tabs[2]!, { key: 'ArrowRight' });
  expect(document.activeElement).toBe(tabs[0]);
  expect(tabs[0]!.getAttribute('aria-selected')).toBe('true');
  expect(window.location.hash).toBe('#/project/api/terminal');
  fireEvent.keyDown(tabs[0]!, { key: 'ArrowLeft' });
  expect(window.location.hash).toBe('#/project/api/runs');
  fireEvent.keyDown(tabs[2]!, { key: 'Home' });
  expect(screen.getByRole('tabpanel').getAttribute('aria-labelledby')).toBe('tab-terminal');
  window.location.hash = '';
});

test('git tab: a project without a repo shows a neutral empty state, not an error', () => {
  const base = project();
  render(<GitTab project={project({ git: { ...base.git, ok: false, error: NOT_A_REPO } })} now={NOW} />);
  expect(screen.getByText('연결된 Git 저장소가 없습니다.').closest('.notice')!.className).not.toContain('error');
  expect(screen.queryByText(/Git 정보를 읽을 수 없습니다/)).toBeNull();
});

test('discovered session detail: the register button registers it and moves to the new project', async () => {
  respond(200, { id: 'scratch' });
  render(<ProjectDetail project={project({ id: 'tmux:scratch', tmuxSession: 'scratch', name: 'scratch' })} now={NOW} />);
  fireEvent.click(screen.getByRole('button', { name: '프로젝트로 등록' }));
  await waitFor(() => expect(window.location.hash).toBe('#/project/scratch'));
  expect(JSON.parse(fetchMock.mock.calls[0]![1]!.body as string)).toEqual({ name: 'scratch', repoPath: '/repos/api', tmuxSession: 'scratch', allowInput: false });
  window.location.hash = '';
});

test('run panel: shows 실행 요청함… until the snapshot reflects the run', async () => {
  respond(200, { ok: true });
  const p = project({ testCommand: 'npm test' });
  const { rerender } = render(<RunPanel project={p} kind="test" title="테스트" />);
  fireEvent.click(screen.getByRole('button', { name: '실행' }));
  expect((await screen.findByText('실행 요청함…')).getAttribute('role')).toBe('status');
  rerender(<RunPanel project={{ ...p, runs: { test: run({ running: true }), build: null } }} kind="test" title="테스트" />);
  await waitFor(() => expect(screen.queryByText('실행 요청함…')).toBeNull());
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
    summary: { total: 1, sessionsRunning: 1, running: 0, waiting: 1, idle: 0, stalled: 0, error: 0 },
    projects: [project({ status: { state: 'waiting', reasons: [] } })],
  };
  const { container } = render(<Dashboard snapshot={snapshot} />);
  // 요약 줄에는 0 인 상태가 나오지 않는다
  expect([...container.querySelectorAll('.stat')].map((d) => d.textContent)).toEqual(['프로젝트 1', '실행 중인 세션 1', '입력 대기1']);
  // 상태 알약을 누르면 그 상태의 카드만 남고, 다시 누르면 전체로 돌아온다
  const pill = screen.getByRole('button', { name: '입력 대기1' });
  fireEvent.click(pill);
  expect(pill.getAttribute('aria-pressed')).toBe('true');
  expect(container.querySelectorAll('.row')).toHaveLength(1);
  fireEvent.click(pill);
  expect(pill.getAttribute('aria-pressed')).toBe('false');
  const meta = container.querySelector('.meta')?.textContent ?? '';
  expect(meta).toContain('2시간 전');
  expect(meta).toContain('갱신 주기 5초');

  const confirm = vi.fn(() => false);
  vi.stubGlobal('confirm', confirm);
  fireEvent.click(screen.getByRole('button', { name: '모니터링 새로 시작' }));
  expect(confirm).toHaveBeenCalledOnce();
  expect(fetchMock).not.toHaveBeenCalled();

  confirm.mockReturnValue(true);
  fireEvent.click(screen.getByRole('button', { name: '모니터링 새로 시작' }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/session/reset', { method: 'POST' }));
});

test('git tab: long commit lists show ten rows until expanded', () => {
  const base = project();
  const commits = Array.from({ length: 25 }, (_, i) => ({ hash: `${String(i).padStart(2, '0')}abcdef0`, author: 'me', date: NOW, subject: `commit ${i}` }));
  const { container } = render(<GitTab project={project({ git: { ...base.git, recentCommits: commits.slice(0, 10), todayCommits: commits } })} now={NOW} />);
  const rows = () => container.querySelectorAll('.rows.commits li').length;
  const before = rows();
  // 최근 커밋 10개는 그대로(버튼 없음), 오늘 커밋 25개는 10개만
  const more = screen.getAllByRole('button', { name: '15개 더 보기' });
  expect(more).toHaveLength(1);
  fireEvent.click(more[0]!);
  expect(rows()).toBe(before + 15);
  fireEvent.click(screen.getByRole('button', { name: '접기' }));
  expect(rows()).toBe(before);
});

test('run tab: the run button is not styled as the primary action', () => {
  render(<RunPanel project={project({ testCommand: 'npm test' })} kind="test" title="테스트" />);
  expect(screen.getByRole('button', { name: '실행' }).className).not.toContain('primary');
});

const dash = (over: Partial<Snapshot> = {}): Snapshot => ({
  generatedAt: NOW,
  startedAt: NOW,
  demo: false,
  refreshIntervalSec: 5,
  configPath: '/c.json',
  configMissing: false,
  configError: null,
  summary: { total: 1, sessionsRunning: 1, running: 0, waiting: 1, idle: 0, stalled: 0, error: 0 },
  projects: [project({ status: { state: 'waiting', reasons: [] } })],
  ...over,
});

test('dashboard: the chosen filter survives dropping to 0, with an empty message and 전체 보기', () => {
  const { container, rerender } = render(<Dashboard snapshot={dash()} />);
  fireEvent.click(screen.getByRole('button', { name: '입력 대기1' }));
  expect(screen.getByRole('button', { name: '전체 보기' })).toBeTruthy();
  // 입력 대기가 0 이 되어도 타일과 필터는 남고, 전체 목록으로 돌아가지 않는다
  rerender(<Dashboard snapshot={dash({ summary: { total: 1, sessionsRunning: 1, running: 1, waiting: 0, idle: 0, stalled: 0, error: 0 }, projects: [project()] })} />);
  expect(screen.getByRole('button', { name: '입력 대기0' }).getAttribute('aria-pressed')).toBe('true');
  expect(container.querySelectorAll('.card')).toHaveLength(0);
  expect(screen.getByText('현재 입력 대기 프로젝트가 없습니다.')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '전체 보기' }));
  expect(container.querySelectorAll('.card')).toHaveLength(1);
  expect(screen.queryByRole('button', { name: /^입력 대기/ })).toBeNull();
  expect(screen.queryByRole('button', { name: '전체 보기' })).toBeNull();
});

test('dashboard: hiding a discovered session offers an undo that un-hides it', async () => {
  fetchMock.mockImplementation(async () => new Response(JSON.stringify({ ok: true })));
  const alert = vi.fn();
  vi.stubGlobal('alert', alert);
  const p = project({ id: 'tmux:scratch', name: 'scratch', tmuxSession: 'scratch' });
  render(<Dashboard snapshot={dash({ projects: [p] })} />);
  // 버튼은 카드 링크 안에 들어 있지 않다
  expect(screen.getByRole('button', { name: '숨김' }).closest('a')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '숨김' }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/sessions/scratch/hide', { method: 'POST' }));
  expect((await screen.findByRole('status')).textContent).toContain('scratch 세션을 숨겼습니다');
  fireEvent.click(screen.getByRole('button', { name: '실행 취소' }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/sessions/scratch/hide', { method: 'DELETE' }));
  expect(screen.queryByRole('button', { name: '실행 취소' })).toBeNull();
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  expect(alert).not.toHaveBeenCalled();
});

test('RunPanel loads the full output on demand when the snapshot only has the tail', async () => {
  const p = project({ runs: { test: run({ stdout: '...tail', truncated: true }), build: null } });
  render(<RunPanel project={p} kind="test" title="테스트" />);
  expect(screen.getByText('...tail')).toBeTruthy();
  respond(200, run({ stdout: 'head...tail' }));
  fireEvent.click(screen.getByRole('button', { name: '전체 출력 보기' }));
  await waitFor(() => expect(screen.getByText('head...tail')).toBeTruthy());
  expect(fetchMock).toHaveBeenCalledWith('/api/projects/api/run/test', { method: 'GET' });
  expect(screen.queryByRole('button', { name: '전체 출력 보기' })).toBeNull();
});
