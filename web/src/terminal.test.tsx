// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { InputRequest, ProjectSnapshot, TmuxPane } from '../../shared/types.ts';
import { TerminalTab } from './ProjectDetail.tsx';

const NOW = '2026-10-04T03:00:00.000Z';

const pane = (id: string, index: number, active: boolean, lines: string[]): TmuxPane => ({
  id,
  window: 0,
  windowName: 'zsh',
  index,
  command: 'zsh',
  active,
  lines,
});

function project(panes: TmuxPane[], allowInput = true): ProjectSnapshot {
  return {
    id: 'api',
    name: 'api-server',
    repoPath: '/repos/api',
    tmuxSession: 'api',
    testCommand: null,
    buildCommand: null,
    logFile: null,
    allowInput,
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
      panes,
      waitingPrompt: null,
      attachCommand: null,
    },
    logErrors: [],
    status: { state: 'running', reasons: [] },
    runs: { test: null, build: null },
    history: { test: [], build: [] },
  };
}

const ONE = [pane('%12', 0, true, ['snap'])];
const TWO = [pane('%1', 0, true, ['one-snap']), pane('%2', 1, false, ['two-snap'])];

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const fetchMock = vi.fn<typeof fetch>();
/** GET(pane 읽기)과 POST(입력)에 각각 응답을 정한다 */
function serve(live: (url: string) => Response | Promise<Response>, input: () => Response = () => json(200, { ok: true })) {
  fetchMock.mockImplementation(async (url, init) => (init?.method === 'POST' ? input() : live(String(url))));
}
const calls = (method: string) => fetchMock.mock.calls.filter(([, init]) => init?.method === method);
const gets = () => calls('GET').map(([url]) => String(url));
const posts = () => calls('POST').map(([url, init]) => [String(url), JSON.parse(init?.body as string) as InputRequest] as const);

/** 타이머를 ms 만큼 돌리고, 그사이 끝난 fetch 의 후속 처리까지 반영한다 */
const tick = (ms = 0) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });

const term = () => screen.getByLabelText('최근 터미널 출력');
const box = () => screen.getByRole<HTMLInputElement>('textbox', { name: 'pane 에 보낼 입력' });
const type = (value: string) => fireEvent.change(box(), { target: { value } });

async function renderTab(p: ProjectSnapshot, refreshSec?: number) {
  const view = render(<TerminalTab project={p} now={NOW} refreshSec={refreshSec} />);
  await tick();
  return view;
}

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

test('live poll replaces the snapshot lines, with the pane id URL-encoded, one request at a time', async () => {
  let n = 0;
  serve(() => json(200, { lines: [`\x1b[31mlive ${++n}`] }));
  await renderTab(project(ONE));
  expect(gets()).toEqual(['/api/projects/api/panes/%2512?lines=500']);
  expect(term().textContent).toBe('live 1');
  expect(screen.getByText('live 1').style.color).toBe('rgb(248, 113, 113)');
  expect(screen.getByText('실시간')).toBeTruthy();

  await tick(699);
  expect(gets()).toHaveLength(1);
  await tick(1);
  expect(gets()).toHaveLength(2);
  expect(term().textContent).toBe('live 2');
});

test('does not start the next poll while one is still pending, and stops on unmount', async () => {
  let resolve!: (r: Response) => void;
  serve(() => new Promise<Response>((r) => (resolve = r)));
  const { unmount } = await renderTab(project(ONE));
  await tick(5000);
  expect(gets()).toHaveLength(1);
  expect(term().textContent).toBe('snap');

  resolve(json(200, { lines: ['live'] }));
  await tick();
  expect(term().textContent).toBe('live');
  unmount();
  await tick(5000);
  expect(gets()).toHaveLength(1);
});

test('polling follows the pane selection and ignores a stale response', async () => {
  let resolveFirst!: (r: Response) => void;
  serve((url) => (url.includes('/panes/%251?') ? new Promise<Response>((r) => (resolveFirst = r)) : json(200, { lines: ['two-live'] })));
  await renderTab(project(TWO));
  expect(gets()).toEqual(['/api/projects/api/panes/%251?lines=500']);
  expect(term().textContent).toBe('one-snap');

  fireEvent.click(screen.getByRole('button', { name: '0:zsh · 1 zsh' }));
  await tick();
  expect(term().textContent).toBe('two-live');

  // 앞서 고른 pane 의 응답이 뒤늦게 와도 화면은 바뀌지 않는다
  resolveFirst(json(200, { lines: ['one-late'] }));
  await tick();
  expect(term().textContent).toBe('two-live');

  await tick(1400);
  expect(gets().slice(1)).toEqual(Array<string>(3).fill('/api/projects/api/panes/%252?lines=500'));
});

test('a failed poll falls back to the snapshot lines and backs off', async () => {
  let ok = true;
  serve(() => (ok ? json(200, { lines: ['live'] }) : json(404, { error: 'pane 없음' })));
  await renderTab(project(ONE), 5);
  expect(term().textContent).toBe('live');

  ok = false;
  await tick(700);
  expect(term().textContent).toBe('snap');
  expect(screen.getByText('5초 갱신')).toBeTruthy();
  expect(screen.queryByText('실시간')).toBeNull();
  expect(screen.queryByRole('alert')).toBeNull();

  // 실패 뒤에는 3초 뒤에 다시 시도하고, 성공하면 실시간으로 돌아온다
  await tick(2999);
  expect(gets()).toHaveLength(2);
  ok = true;
  await tick(1);
  expect(gets()).toHaveLength(3);
  expect(term().textContent).toBe('live');
  expect(screen.getByText('실시간')).toBeTruthy();
});

test('shows 스냅샷 when the refresh interval is unknown', async () => {
  serve(() => json(500, { error: 'x' }));
  await renderTab(project(ONE));
  expect(screen.getByText('스냅샷')).toBeTruthy();
});

test('does not poll while the browser tab is hidden, and resumes when it is visible again', async () => {
  serve(() => json(200, { lines: ['live'] }));
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
  await renderTab(project(ONE));
  await tick(5000);
  expect(fetchMock).not.toHaveBeenCalled();

  visibility.mockReturnValue('visible');
  document.dispatchEvent(new Event('visibilitychange'));
  await tick();
  expect(gets()).toHaveLength(1);
  expect(term().textContent).toBe('live');
  visibility.mockRestore();
});

test('no polling, indicator or input bar when there are no panes', async () => {
  await renderTab(project([]));
  await tick(5000);
  expect(fetchMock).not.toHaveBeenCalled();
  expect(term().textContent).toBe('plain output');
  expect(screen.queryByText('스냅샷')).toBeNull();
  expect(screen.queryByRole('textbox')).toBeNull();
});

test('input bar is hidden and the config hint is shown when allowInput is false', async () => {
  serve(() => json(200, { lines: ['live'] }));
  await renderTab(project(ONE, false));
  expect(screen.queryByRole('textbox')).toBeNull();
  expect(screen.queryByRole('button', { name: '보내기' })).toBeNull();
  expect(screen.getByText(/입력을 보내려면/).textContent).toBe(
    '입력을 보내려면 설정에서 이 프로젝트의 "터미널 입력 허용"을 켜세요.',
  );
});

test('Enter sends the text with enter:true, clears the input, keeps focus and polls right away', async () => {
  serve(() => json(200, { lines: ['live'] }));
  await renderTab(project(ONE));
  expect(screen.getByText('입력은 선택한 pane 에 그대로 전달됩니다. 보낸 내용은 서버에 기록됩니다.')).toBeTruthy();
  expect(gets()).toHaveLength(1);

  type('npm test');
  fireEvent.keyDown(box(), { key: 'Enter' });
  expect(box().value).toBe('');
  expect(screen.getByRole<HTMLButtonElement>('button', { name: '보내기' }).disabled).toBe(true);
  await tick();
  expect(posts()).toEqual([['/api/projects/api/input', { pane: '%12', text: 'npm test', enter: true }]]);
  expect(new Headers(calls('POST')[0]?.[1]?.headers).get('Content-Type')).toBe('application/json');
  expect(document.activeElement).toBe(box());
  expect(screen.getByRole<HTMLButtonElement>('button', { name: '보내기' }).disabled).toBe(false);
  // 700ms 를 기다리지 않고 바로 다시 읽는다
  expect(gets()).toHaveLength(2);
});

test('Enter during IME composition does not send', async () => {
  serve(() => json(200, { lines: [] }));
  await renderTab(project(ONE));
  type('한그');
  fireEvent.keyDown(box(), { key: 'Enter', isComposing: true });
  fireEvent.keyDown(box(), { key: 'Enter', keyCode: 229 });
  await tick();
  expect(posts()).toEqual([]);
  expect(box().value).toBe('한그');
});

test('empty Enter and the 보내기 button send just the Enter key', async () => {
  serve(() => json(200, { lines: [] }));
  await renderTab(project(ONE));
  fireEvent.keyDown(box(), { key: 'Enter' });
  await tick();
  fireEvent.click(screen.getByRole('button', { name: '보내기' }));
  await tick();
  expect(posts().map(([, body]) => body)).toEqual([
    { pane: '%12', key: 'Enter' },
    { pane: '%12', key: 'Enter' },
  ]);
});

test('"Enter 없이 입력" omits enter and is disabled while empty', async () => {
  serve(() => json(200, { lines: [] }));
  await renderTab(project(ONE));
  const button = screen.getByRole<HTMLButtonElement>('button', { name: 'Enter 없이 입력' });
  expect(button.disabled).toBe(true);
  type('y');
  fireEvent.click(button);
  await tick();
  expect(posts().map(([, body]) => body)).toEqual([{ pane: '%12', text: 'y' }]);
  expect(box().value).toBe('');
});

test('special-key buttons send { pane, key } to the selected pane', async () => {
  serve(() => json(200, { lines: [] }));
  await renderTab(project(TWO));
  fireEvent.click(screen.getByRole('button', { name: '0:zsh · 1 zsh' }));
  await tick();
  const group = screen.getByRole('group', { name: '특수 키' });
  const keys = group.querySelectorAll('button:not(.more)');
  expect([...keys].map((b) => b.textContent)).toEqual(
    ['Enter', 'Esc', 'Tab', '⇧Tab', '↑', '↓', '←', '→', 'PgUp', 'PgDn', '⌫', 'Ctrl+C', 'Ctrl+D', 'Ctrl+U', 'Ctrl+L'],
  );
  // 터치 화면에서 접히는 키에는 extra 표시가 붙고, "더보기"가 펼침 상태를 바꾼다
  expect([...keys].filter((b) => !b.classList.contains('extra')).map((b) => b.textContent)).toEqual(['Esc', '↑', '↓', 'PgUp', 'PgDn']);
  const more = screen.getByRole('button', { name: '더보기' });
  expect(more.getAttribute('aria-expanded')).toBe('false');
  fireEvent.click(more);
  expect(group.className).toBe('keys open');
  expect(screen.getByRole('button', { name: '접기' }).getAttribute('aria-expanded')).toBe('true');
  for (const name of ['Ctrl+C 보내기 (중단)', 'Shift+Tab 보내기', 'Esc 보내기']) {
    const button = screen.getByRole('button', { name });
    expect(button.title).toBe(name);
    fireEvent.click(button);
    await tick();
  }
  expect(posts().map(([, body]) => body)).toEqual([
    { pane: '%2', key: 'C-c' },
    { pane: '%2', key: 'BTab' },
    { pane: '%2', key: 'Escape' },
  ]);
  expect(screen.getByRole('button', { name: 'Ctrl+C 보내기 (중단)' }).className).toContain('caution');
});

test('keys in an empty input are forwarded; with text they edit locally', async () => {
  serve(() => json(200, { lines: [] }));
  await renderTab(project(ONE));
  const press = async (init: KeyboardEventInit) => {
    const notPrevented = fireEvent.keyDown(box(), init);
    await tick();
    return !notPrevented;
  };
  expect(await press({ key: 'ArrowUp' })).toBe(true);
  expect(await press({ key: 'Backspace' })).toBe(true);
  expect(await press({ key: 'Tab' })).toBe(true);
  expect(await press({ key: 'Tab', shiftKey: true })).toBe(true);
  expect(posts().map(([, body]) => body.key)).toEqual(['Up', 'BSpace', 'Tab', 'BTab']);

  type('ls');
  expect(await press({ key: 'ArrowUp' })).toBe(false);
  expect(await press({ key: 'Backspace' })).toBe(false);
  // Tab 은 글이 있어도 포커스를 옮기지 않지만 보내지도 않는다
  expect(await press({ key: 'Tab' })).toBe(true);
  expect(posts()).toHaveLength(4);
});

test('a 403 shows the server error and puts the text back; the next success clears it', async () => {
  let status = 403;
  serve(
    () => json(200, { lines: [] }),
    () => (status === 200 ? json(200, { ok: true }) : json(status, { error: '이 프로젝트는 입력이 허용되지 않습니다' })),
  );
  await renderTab(project(ONE));
  type('rm -rf');
  fireEvent.keyDown(box(), { key: 'Enter' });
  await tick();
  expect(screen.getByRole('alert').textContent).toBe('이 프로젝트는 입력이 허용되지 않습니다');
  expect(box().value).toBe('rm -rf');

  status = 200;
  fireEvent.keyDown(box(), { key: 'Enter' });
  await tick();
  expect(screen.queryByRole('alert')).toBeNull();
  expect(box().value).toBe('');
});

test('scrolling up pauses the refresh; load-more asks for a longer scrollback', async () => {
  const many = Array.from({ length: 500 }, (_, i) => `line ${i}`);
  serve(() => json(200, { lines: many }));
  await renderTab(project(TWO));
  await tick();
  expect(gets().at(-1)).toBe('/api/projects/api/panes/%251?lines=500');
  expect(screen.getByText('실시간')).toBeTruthy();

  // 위로 올리면 갱신이 멈춘다
  const el = term();
  Object.defineProperties(el, { scrollHeight: { value: 5000, configurable: true }, clientHeight: { value: 400, configurable: true } });
  el.scrollTop = 1000;
  fireEvent.scroll(el);
  expect(screen.getByText('올려 보는 중 · 갱신 멈춤')).toBeTruthy();
  const before = gets().length;
  await vi.advanceTimersByTimeAsync(3000);
  expect(gets().length).toBe(before);

  // 올려 보는 중에도 "더 보기"는 한 번 읽어 온다 (줄 수 두 배)
  fireEvent.click(screen.getByRole('button', { name: '이전 출력 더 보기' }));
  await tick();
  expect(gets().at(-1)).toBe('/api/projects/api/panes/%251?lines=1000');
  expect(gets().length).toBe(before + 1);

  // 맨 아래로 돌아가면 다시 갱신한다
  fireEvent.click(screen.getByRole('button', { name: '맨 아래로' }));
  await tick();
  expect(screen.getByText('실시간')).toBeTruthy();
  expect(gets().length).toBeGreaterThan(before + 1);
});

test('wrap view shortens rule lines and long padding, and toggles a class on the terminal', async () => {
  const { compactForWrap } = await import('./ProjectDetail.tsx');
  expect(compactForWrap(`${'─'.repeat(157)}\n${' '.repeat(60)}✔ done\n    indented code\n\x1b[2m${'─'.repeat(40)}\x1b[0m`)).toBe(
    `${'─'.repeat(24)}\n  ✔ done\n    indented code\n\x1b[2m${'─'.repeat(24)}\x1b[0m`,
  );

  serve(() => json(200, { lines: ['x'] }));
  await renderTab(project(TWO));
  await tick();
  expect(term().className).toBe('terminal'); // 넓은 화면(테스트 환경)에서는 꺼진 채로 시작
  fireEvent.click(screen.getByRole('button', { name: '줄바꿈' }));
  expect(term().className).toBe('terminal wrap-lines');
  // 세션 정보 토글
  const info = screen.getByRole('button', { name: '세션 정보' });
  expect(info.getAttribute('aria-expanded')).toBe('false');
  fireEvent.click(info);
  expect(info.getAttribute('aria-expanded')).toBe('true');
});

test('on a touch screen a key button does not pull focus into the input (no keyboard pop-up)', async () => {
  // 터치 환경 흉내: (pointer: fine) 이 거짓
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: !q.includes('pointer: fine'), media: q, addEventListener() {}, removeEventListener() {} }));
  serve(() => json(200, { lines: [] }));
  await renderTab(project(TWO));
  await tick();
  const box = screen.getByPlaceholderText('입력 후 Enter');
  fireEvent.click(screen.getByRole('button', { name: 'Page Up 보내기 (프로그램 안에서 위로)' }));
  await tick();
  expect(document.activeElement).not.toBe(box);

  // 글을 보낸 뒤에는 이어서 칠 수 있게 포커스가 입력 칸에 있다
  fireEvent.change(box, { target: { value: 'hello' } });
  fireEvent.click(screen.getByRole('button', { name: '보내기' }));
  await tick();
  expect(document.activeElement).toBe(box);
});
