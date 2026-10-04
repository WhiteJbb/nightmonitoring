// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { ConfigUpdate, ConfigView } from '../../shared/types.ts';
import { Settings } from './Settings.tsx';

function view(over: Partial<ConfigView> = {}): ConfigView {
  return {
    path: '/home/me/nightshift.json',
    version: 'v1',
    format: 'json',
    editable: true,
    readOnlyReason: null,
    settings: {
      refreshIntervalSec: 5,
      thresholds: { idleMinutes: 15, stalledMinutes: 30, noCommitMinutes: 45 },
      errorPatterns: ['error', '/panic:/i'],
      errorIgnorePatterns: ['0 errors'],
      promptPatterns: ['(y/n)'],
      ignoreSpinnerChanges: true,
      sessionExitIsError: false,
      notifications: false,
      autoReportTime: '07:30',
      commandTimeoutSec: 600,
    },
    projects: [
      {
        id: 'api',
        name: 'api-server',
        repoPath: '~/code/api',
        tmuxSession: 'api',
        logFile: 'app.log',
        testCommand: 'npm test -- --run',
        buildCommand: null,
        repoPathLocked: true,
        allowInput: false,
      },
      {
        id: 'web',
        name: 'web-app',
        repoPath: '~/code/web',
        tmuxSession: null,
        logFile: null,
        testCommand: null,
        buildCommand: null,
        repoPathLocked: false,
        allowInput: false,
      },
    ],
    fileOnly: { host: '127.0.0.1', port: 4517, reportsDir: '/home/me/reports', allowedHosts: [] },
    ...over,
  };
}

const fetchMock = vi.fn<typeof fetch>();
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function renderLoaded(v = view()) {
  fetchMock.mockResolvedValueOnce(json(200, v));
  render(<Settings />);
  await screen.findByRole('heading', { name: '설정' });
}

const input = (label: string, within_: HTMLElement = document.body) =>
  within(within_).getByLabelText<HTMLInputElement | HTMLTextAreaElement>(label);
const project = (name: string) => screen.getByRole('group', { name });
const change = (el: HTMLElement, value: string) => fireEvent.change(el, { target: { value } });

/** 저장을 누르고 PUT 본문을 돌려준다 */
async function save(response: Response): Promise<ConfigUpdate> {
  fetchMock.mockResolvedValueOnce(response);
  fireEvent.click(screen.getByRole('button', { name: '저장' }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  const [url, init] = fetchMock.mock.calls[1]!;
  expect(url).toBe('/api/config');
  expect(init?.method).toBe('PUT');
  expect(new Headers(init?.headers).get('Content-Type')).toBe('application/json');
  return JSON.parse(init?.body as string) as ConfigUpdate;
}

test('renders loaded values', async () => {
  await renderLoaded();
  expect(fetchMock).toHaveBeenCalledWith('/api/config', { method: 'GET' });
  expect(screen.getByText('/home/me/nightshift.json · json')).toBeTruthy();
  expect(screen.getByText('4517')).toBeTruthy();
  expect(screen.getByText('/home/me/reports')).toBeTruthy();
  expect(input('갱신 주기(초)').value).toBe('5');
  expect(input('정지 의심 — Git(분)').value).toBe('45');
  expect(input('오류 패턴').value).toBe('error\n/panic:/i');
  expect((input('숫자·스피너만 바뀌는 출력 무시') as HTMLInputElement).checked).toBe(true);
  expect((input('macOS 알림') as HTMLInputElement).checked).toBe(false);
  expect(input('자동 생성 시각').value).toBe('07:30');
  expect(input('이름', project('api-server')).value).toBe('api-server');
  expect(input('tmux 세션', project('web-app')).value).toBe('');
  // 바뀐 것이 없으면 저장할 수 없다
  expect(screen.getByRole<HTMLButtonElement>('button', { name: '저장' }).disabled).toBe(true);
});

test('shows the load error and retries', async () => {
  fetchMock.mockResolvedValueOnce(json(404, { error: 'Not found' }));
  render(<Settings />);
  expect((await screen.findByRole('alert')).textContent).toContain('Not found');
  fetchMock.mockResolvedValueOnce(json(200, view()));
  fireEvent.click(screen.getByRole('button', { name: '다시 시도' }));
  expect(await screen.findByRole('heading', { name: '설정' })).toBeTruthy();
});

test('commands are plain text, never editable', async () => {
  await renderLoaded();
  const api = project('api-server');
  expect(within(api).getByText('npm test -- --run').tagName).toBe('DD');
  expect(within(api).getByText('등록 안 됨')).toBeTruthy();
  const editable = [...document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea')];
  expect(editable.length).toBeGreaterThan(10);
  expect(editable.filter((el) => el.value.includes('npm test'))).toEqual([]);
  expect(document.querySelector('[contenteditable]')).toBeNull();
});

test('locked repoPath is disabled, unlocked one is not', async () => {
  await renderLoaded();
  expect(input('저장소 경로', project('api-server')).disabled).toBe(true);
  expect(within(project('api-server')).getByText(/config 파일에서만 바꿀 수 있습니다/)).toBeTruthy();
  expect(input('저장소 경로', project('web-app')).disabled).toBe(false);
});

test('terminal input can be turned on after a confirm, and is sent in the PUT body', async () => {
  const v = view();
  v.projects[0] = { ...v.projects[0]!, allowInput: true };
  await renderLoaded(v);
  const box = (name: string) => within(project(name)).getByLabelText<HTMLInputElement>('터미널 입력 허용');
  expect(box('api-server').checked).toBe(true);
  expect(box('web-app').checked).toBe(false);
  // 입력이 허용된 프로젝트도 세션 이름을 바꿀 수 있다
  expect(input('tmux 세션', project('api-server')).disabled).toBe(false);

  // 켜기를 거절하면 그대로
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
  fireEvent.click(box('web-app'));
  expect(box('web-app').checked).toBe(false);
  expect(confirm.mock.calls[0]![0]).toContain('명령을 실행할 수 있습니다');

  confirm.mockReturnValue(true);
  fireEvent.click(box('web-app'));
  expect(box('web-app').checked).toBe(true);
  // 끄는 것은 확인 없이
  fireEvent.click(box('api-server'));
  expect(box('api-server').checked).toBe(false);
  expect(confirm).toHaveBeenCalledTimes(2);

  const body = await save(json(200, v));
  expect(body.projects.map((p) => p.allowInput)).toEqual([false, true]);
  confirm.mockRestore();
});

test('saving sends the edited ConfigUpdate and shows the confirmation', async () => {
  const v = view();
  await renderLoaded(v);
  change(input('갱신 주기(초)'), '10');
  change(input('오류 패턴'), 'error\n\n   \nfatal\n');
  fireEvent.click(input('macOS 알림'));
  fireEvent.click(input('Morning Report 자동 생성'));
  change(input('tmux 세션', project('api-server')), '  ');

  const saved = view({ settings: { ...v.settings, refreshIntervalSec: 10 } });
  const body = await save(json(200, saved));
  expect(body).toEqual({
    version: 'v1',
    settings: {
      ...v.settings,
      refreshIntervalSec: 10,
      errorPatterns: ['error', 'fatal'],
      notifications: true,
      autoReportTime: null,
    },
    projects: [
      { id: 'api', name: 'api-server', repoPath: '~/code/api', tmuxSession: null, logFile: 'app.log', allowInput: false },
      { id: 'web', name: 'web-app', repoPath: '~/code/web', tmuxSession: null, logFile: null, allowInput: false },
    ],
  } satisfies ConfigUpdate);

  expect((await screen.findByRole('status')).textContent).toBe('저장됨 — 바로 적용되었습니다');
  // 폼은 서버가 돌려준 값으로 바뀐다
  expect(input('갱신 주기(초)').value).toBe('10');
  expect(input('오류 패턴').value).toBe('error\n/panic:/i');
  expect(screen.getByRole<HTMLButtonElement>('button', { name: '저장' }).disabled).toBe(true);
});

test('adding and deleting projects changes the PUT body', async () => {
  const confirm = vi.fn(() => true);
  vi.stubGlobal('confirm', confirm);
  await renderLoaded();

  fireEvent.click(screen.getByRole('button', { name: '프로젝트 추가' }));
  const added = project('새 프로젝트');
  expect(within(added).getAllByText('등록 안 됨')).toHaveLength(2);
  change(input('이름', added), 'worker');
  change(input('저장소 경로', project('worker')), '~/code/worker');
  change(input('로그 파일', project('worker')), 'logs/out.log');

  fireEvent.click(within(project('api-server')).getByRole('button', { name: '삭제' }));
  expect(confirm).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole('group', { name: 'api-server' })).toBeNull();

  const body = await save(json(200, view()));
  expect(body.projects).toEqual([
    { id: 'web', name: 'web-app', repoPath: '~/code/web', tmuxSession: null, logFile: null, allowInput: false },
    { id: null, name: 'worker', repoPath: '~/code/worker', tmuxSession: null, logFile: 'logs/out.log', allowInput: false },
  ]);
});

test('declining the confirm keeps the project', async () => {
  vi.stubGlobal('confirm', () => false);
  await renderLoaded();
  fireEvent.click(within(project('web-app')).getByRole('button', { name: '삭제' }));
  expect(project('web-app')).toBeTruthy();
});

test('a 400 with issues lists every issue and keeps the edits', async () => {
  await renderLoaded();
  change(input('유휴 판정(분)'), '20');
  change(input('입력 대기 패턴'), '/(/');
  const issues = ['thresholds.idleMinutes: 0 이상의 숫자여야 합니다', 'promptPatterns[0]: 정규식이 올바르지 않습니다'];
  await save(json(400, { error: '설정이 올바르지 않습니다', issues }));

  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toContain('설정이 올바르지 않습니다');
  expect(within(alert).getAllByRole('listitem').map((li) => li.textContent)).toEqual(issues);
  expect(input('유휴 판정(분)').value).toBe('20');
  expect(input('입력 대기 패턴').value).toBe('/(/');
  expect(screen.getByRole<HTMLButtonElement>('button', { name: '저장' }).disabled).toBe(false);
  expect(screen.queryByText('저장됨 — 바로 적용되었습니다')).toBeNull();
});

test('a 409 offers to reload the latest file, discarding the edits', async () => {
  await renderLoaded();
  change(input('유휴 판정(분)'), '20');
  const body = await save(json(409, { error: 'config 파일이 다른 곳에서 수정되었습니다' }));
  expect(body.version).toBe('v1');

  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toContain('config 파일이 다른 곳에서 수정되었습니다');
  expect(input('유휴 판정(분)').value).toBe('20');

  const latest = view({ version: 'v2' });
  latest.settings.thresholds.idleMinutes = 33;
  fetchMock.mockResolvedValueOnce(json(200, latest));
  fireEvent.click(within(alert).getByRole('button', { name: '다시 불러오기' }));
  await waitFor(() => expect(input('유휴 판정(분)').value).toBe('33'));
  expect(screen.queryByRole('alert')).toBeNull();

  // 다시 불러온 뒤의 저장은 새 version 을 보낸다
  change(input('유휴 판정(분)'), '21');
  fetchMock.mockResolvedValueOnce(json(200, latest));
  fireEvent.click(screen.getByRole('button', { name: '저장' }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
  expect(JSON.parse(fetchMock.mock.calls[3]![1]?.body as string).version).toBe('v2');
});

test('revert restores the last loaded state', async () => {
  await renderLoaded();
  change(input('갱신 주기(초)'), '99');
  fireEvent.click(screen.getByRole('button', { name: '되돌리기' }));
  expect(input('갱신 주기(초)').value).toBe('5');
  expect(screen.getByRole<HTMLButtonElement>('button', { name: '저장' }).disabled).toBe(true);
});

test('read-only mode shows the reason, disables every field and hides save', async () => {
  await renderLoaded(view({ editable: false, readOnlyReason: '데모 모드에서는 설정을 저장할 수 없습니다' }));
  expect(screen.getByRole('status').textContent).toContain('데모 모드에서는 설정을 저장할 수 없습니다');
  const fields = [...document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea')];
  expect(fields.length).toBeGreaterThan(10);
  expect(fields.filter((el) => !el.disabled)).toEqual([]);
  for (const name of ['저장', '되돌리기', '프로젝트 추가', '삭제']) expect(screen.queryByRole('button', { name })).toBeNull();
});
