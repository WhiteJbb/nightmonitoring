// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { NewSession, sessionNameFrom, StartSession } from './NewSession.tsx';

const fetchMock = vi.fn<typeof fetch>();
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  window.location.hash = '#/';
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const field = (label: string) => screen.getByLabelText<HTMLInputElement>(label);
const type = (label: string, value: string) => fireEvent.change(field(label), { target: { value } });
const lastBody = () => JSON.parse(fetchMock.mock.calls.at(-1)![1]?.body as string) as Record<string, unknown>;

test('derives a tmux-safe session name', () => {
  expect(sessionNameFrom('My Web App')).toBe('my-web-app');
  expect(sessionNameFrom(' api.v2: worker ')).toBe('api-v2-worker');
  expect(sessionNameFrom('-$lead')).toBe('lead');
  expect(sessionNameFrom('한글 프로젝트')).toBe('한글-프로젝트');
});

test('a session name and an agent are enough to start', async () => {
  render(<NewSession />);
  fireEvent.click(screen.getByRole('button', { name: '+ tmux 세션 만들기' }));
  type('tmux 세션 이름', 'quick');
  fireEvent.click(screen.getByRole('radio', { name: 'Codex' }));
  expect(screen.getByLabelText<HTMLInputElement>('터미널 입력 허용').checked).toBe(true);
  fetchMock.mockResolvedValueOnce(json(200, { id: 'quick' }));
  fireEvent.click(screen.getByRole('button', { name: '만들기' }));
  await waitFor(() => expect(window.location.hash).toBe('#/project/quick'));
  expect(lastBody()).toMatchObject({ name: 'quick', repoPath: '', tmuxSession: 'quick', agent: 'codex', allowInput: true });
});

test('the repo path is empty (home) unless a git url fills it under the default folder', async () => {
  render(<NewSession />);
  fireEvent.click(screen.getByRole('button', { name: '+ tmux 세션 만들기' }));
  expect(field('저장소 경로').value).toBe('');
  type('프로젝트 이름', 'App');
  type('저장소 경로', '/Users/me/repos/app');
  fetchMock.mockResolvedValueOnce(json(200, { id: 'app' }));
  fireEvent.click(screen.getByRole('button', { name: '만들기' }));
  await waitFor(() => expect(window.location.hash).toBe('#/project/app'));
  expect(lastBody().repoPath).toBe('/Users/me/repos/app');
});

test('creates a session, following the project name until the session name is edited', async () => {
  render(<NewSession />);
  expect(screen.queryByLabelText('프로젝트 이름')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '+ tmux 세션 만들기' }));

  type('프로젝트 이름', 'My App');
  expect(field('tmux 세션 이름').value).toBe('my-app');
  type('tmux 세션 이름', 'custom');
  type('프로젝트 이름', 'My App 2');
  expect(field('tmux 세션 이름').value).toBe('custom');
  type('저장소 경로', ' ~/code/my-app ');

  fetchMock.mockResolvedValueOnce(json(200, { id: 'my-app-2' }));
  fireEvent.click(screen.getByRole('button', { name: '만들기' }));
  await waitFor(() => expect(window.location.hash).toBe('#/project/my-app-2'));
  expect(fetchMock.mock.calls[0]![0]).toBe('/api/sessions');
  // 보는 화면에 맞는 크기를 함께 보낸다 (테스트 환경의 화면 폭 1024px 기준)
  expect(lastBody()).toMatchObject({ name: 'My App 2', repoPath: '~/code/my-app', tmuxSession: 'custom', allowInput: false, rows: 40 });
  expect(lastBody().cols).toBeGreaterThanOrEqual(80);
});

test('a git url fills in name and path and is sent along', async () => {
  render(<NewSession />);
  fireEvent.click(screen.getByRole('button', { name: '+ tmux 세션 만들기' }));
  type('Git 저장소 주소 (선택)', 'git@github.com:me/my-app.git');
  expect(field('프로젝트 이름').value).toBe('my-app');
  expect(field('저장소 경로').value).toBe('~/repos/my-app');
  expect(field('tmux 세션 이름').value).toBe('my-app');
  fetchMock.mockResolvedValueOnce(json(200, { id: 'my-app' }));
  fireEvent.click(screen.getByRole('button', { name: '만들기' }));
  // clone 하는 동안은 기다리라는 안내가 뜨고 모든 칸이 잠긴다
  expect(screen.getByRole<HTMLButtonElement>('button', { name: '저장소를 받는 중…' }).disabled).toBe(true);
  expect(screen.getByRole('status').textContent).toContain('저장소를 받는 중…');
  expect(['Git 저장소 주소 (선택)', '프로젝트 이름', '저장소 경로', 'tmux 세션 이름', '터미널 입력 허용'].every((l) => field(l).disabled)).toBe(true);
  await waitFor(() => expect(window.location.hash).toBe('#/project/my-app'));
  expect(lastBody()).toMatchObject({ name: 'my-app', repoPath: '~/repos/my-app', gitUrl: 'git@github.com:me/my-app.git' });
});

test('name and path follow the git url as it is typed, until edited by hand', () => {
  render(<NewSession />);
  fireEvent.click(screen.getByRole('button', { name: '+ tmux 세션 만들기' }));
  const url = 'https://github.com/me/app.git';
  // 한 글자씩 칠 때: 덜 적은 주소("h", "https://github.com/")에서는 채우지 않는다
  type('Git 저장소 주소 (선택)', 'h');
  expect(field('프로젝트 이름').value).toBe('');
  expect(field('저장소 경로').value).toBe('');
  type('Git 저장소 주소 (선택)', 'https://github.com/');
  expect(field('프로젝트 이름').value).toBe('');
  type('Git 저장소 주소 (선택)', url);
  expect(field('프로젝트 이름').value).toBe('app');
  expect(field('저장소 경로').value).toBe('~/repos/app');
  // 주소를 고치면 따라 바뀐다
  type('Git 저장소 주소 (선택)', 'git@github.com:me/api');
  expect(field('프로젝트 이름').value).toBe('api');
  expect(field('저장소 경로').value).toBe('~/repos/api');
  expect(field('tmux 세션 이름').value).toBe('api');
  // 직접 고친 칸은 더 이상 따라가지 않는다
  type('프로젝트 이름', 'My API');
  type('Git 저장소 주소 (선택)', url);
  expect(field('프로젝트 이름').value).toBe('My API');
  expect(field('저장소 경로').value).toBe('~/repos/app');
  expect(field('tmux 세션 이름').value).toBe('my-api');
});

test('terminal input needs a confirm, and errors keep the form', async () => {
  render(<NewSession />);
  fireEvent.click(screen.getByRole('button', { name: '+ tmux 세션 만들기' }));
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
  fireEvent.click(field('터미널 입력 허용'));
  expect(field('터미널 입력 허용').checked).toBe(false);
  confirm.mockReturnValue(true);
  fireEvent.click(field('터미널 입력 허용'));
  expect(field('터미널 입력 허용').checked).toBe(true);

  type('프로젝트 이름', 'App');
  type('저장소 경로', '/nope');
  fetchMock.mockResolvedValueOnce(json(400, { error: '디렉터리가 없습니다: /nope' }));
  fireEvent.click(screen.getByRole('button', { name: '만들기' }));
  expect((await screen.findByRole('alert')).textContent).toContain('디렉터리가 없습니다: /nope');
  expect(lastBody().allowInput).toBe(true);
  expect(field('저장소 경로').value).toBe('/nope');
  expect(window.location.hash).toBe('#/');
  expect(screen.getByRole<HTMLButtonElement>('button', { name: '만들기' }).disabled).toBe(false);
  confirm.mockRestore();
});

test('start session posts to the project and shows a failure', async () => {
  render(<StartSession projectId="my app" />);
  fetchMock.mockResolvedValueOnce(json(403, { error: 'demo mode 에서는 세션을 만들 수 없습니다' }));
  fireEvent.click(screen.getByRole('button', { name: '세션 시작' }));
  expect((await screen.findByRole('alert')).textContent).toBe('demo mode 에서는 세션을 만들 수 없습니다');
  expect(fetchMock.mock.calls[0]![0]).toBe('/api/projects/my%20app/session');
  expect(fetchMock.mock.calls[0]![1]?.method).toBe('POST');

  fetchMock.mockResolvedValueOnce(json(200, { ok: true }));
  fireEvent.click(screen.getByRole('button', { name: '세션 시작' }));
  await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
});

test('closing fades the form out before removing it', () => {
  vi.useFakeTimers();
  try {
    const { container } = render(<NewSession />);
    fireEvent.click(screen.getByRole('button', { name: '+ tmux 세션 만들기' }));
    fireEvent.click(screen.getByRole('button', { name: '닫기' }));
    expect(container.querySelector('form')?.className).toContain('closing');
    act(() => void vi.advanceTimersByTime(120));
    expect(container.querySelector('form')).toBeNull();
    expect(screen.getByRole('button', { name: '+ tmux 세션 만들기' })).toBeTruthy();
  } finally {
    vi.useRealTimers();
  }
});
