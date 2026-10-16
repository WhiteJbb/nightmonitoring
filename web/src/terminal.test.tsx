// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { InputRequest, ProjectSnapshot, TmuxPane } from '../../shared/types.ts';

const { FakeTerminal } = vi.hoisted(() => {
  // xterm 은 jsdom 에서 그릴 수 없다. 받은 바이트·크기·입력 핸들러만 기록하는 가짜로 바꾼다
  class FakeTerminal {
    static all: FakeTerminal[] = [];
    options: Record<string, unknown>;
    cols = 80;
    rows = 24;
    writes: string[] = [];
    resizes: [number, number][] = [];
    resets = 0;
    disposed = false;
    private handlers: ((d: string) => void)[] = [];
    constructor(options: Record<string, unknown>) {
      this.options = options;
      FakeTerminal.all.push(this);
    }
    open() {}
    buffer = { active: { type: 'normal' } };
    modes = { mouseTrackingMode: 'none' };
    wheel: ((ev: WheelEvent) => boolean) | null = null;
    attachCustomWheelEventHandler(h: (ev: WheelEvent) => boolean) {
      this.wheel = h;
    }
    reset() {
      this.resets++;
    }
    resize(cols: number, rows: number) {
      this.cols = cols;
      this.rows = rows;
      this.resizes.push([cols, rows]);
    }
    write(data: Uint8Array) {
      this.writes.push(new TextDecoder().decode(data));
    }
    onData(h: (d: string) => void) {
      this.handlers.push(h);
      return { dispose: () => {} };
    }
    dispose() {
      this.disposed = true;
    }
    /** 사용자가 터미널에 친 것처럼 */
    type(d: string) {
      this.handlers.forEach((h) => h(d));
    }
  }
  return { FakeTerminal };
});
vi.mock('@xterm/xterm', () => ({ Terminal: FakeTerminal }));
vi.mock('@xterm/xterm/css/xterm.css', () => ({}));

class FakeEventSource {
  static all: FakeEventSource[] = [];
  url: string;
  onmessage: ((ev: MessageEvent<string>) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(url: string) {
    this.url = url;
    FakeEventSource.all.push(this);
  }
  close() {
    this.closed = true;
  }
  emit(e: unknown) {
    this.onmessage?.({ data: JSON.stringify(e) } as MessageEvent<string>);
  }
}

import { TerminalTab } from './ProjectDetail.tsx';

const NOW = '2026-10-04T03:00:00.000Z';
const b64 = (s: string) => btoa(s);

const pane = (id: string, index: number, active: boolean, lines: string[]): TmuxPane => ({ id, window: 0, windowName: 'zsh', index, command: 'zsh', active, lines });

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
    git: { ok: true, branch: 'main', head: 'abcdef1234', clean: true, changedFiles: [], diffStat: [], additions: 0, deletions: 0, recentCommits: [], todayCommits: [], fingerprint: '' },
    since: null,
    lastGitChangeAt: null,
    tmux: { configured: true, exists: true, createdAt: NOW, attached: false, lastActivityAt: NOW, lastOutputChangeAt: NOW, output: ['plain output'], panes, waitingPrompt: null, attachCommand: null },
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
function serve(input: () => Response = () => json(200, { ok: true })) {
  fetchMock.mockImplementation(async () => input());
}
const posts = () => fetchMock.mock.calls.filter(([url, init]) => init?.method === 'POST' && !String(url).endsWith('/fit')).map(([url, init]) => [String(url), JSON.parse(init?.body as string) as InputRequest & { data?: string }] as const);

const tick = (ms = 0) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });

const es = () => FakeEventSource.all.at(-1)!;
const xterm = () => FakeTerminal.all.at(-1)!;
const box = () => screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'pane 에 보낼 입력' });
const type = (value: string) => fireEvent.change(box(), { target: { value } });

async function renderTab(p: ProjectSnapshot) {
  const view = render(<TerminalTab project={p} now={NOW} />);
  await tick();
  return view;
}
/** 서버가 첫 화면을 보냈다 */
const init = (cols = 120, rows = 30, data = 'hello') =>
  act(() => {
    es().emit({ type: 'init', cols, rows, alt: false, data: b64(data) });
  });

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock.mockReset();
  serve();
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('EventSource', FakeEventSource);
  FakeEventSource.all = [];
  FakeTerminal.all = [];
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

test('streams the pane: init resets, resizes and writes the seed; out appends; resize follows; the ids are URL-encoded', async () => {
  await renderTab(project(ONE));
  expect(es().url).toBe('/api/projects/api/term/%2512');
  expect(screen.getByRole('status').textContent).toContain('연결 중');
  await init(120, 30);
  expect(xterm().resets).toBe(1);
  expect(xterm().resizes).toEqual([[120, 30]]);
  expect(xterm().writes).toEqual(['hello']);
  expect(screen.getByRole('status').textContent).toContain('실시간');
  expect(screen.getByTitle('pane 크기 (칸 × 줄)').textContent).toBe('120×30');

  act(() => es().emit({ type: 'out', data: b64(' more') }));
  expect(xterm().writes).toEqual(['hello', ' more']);
  act(() => es().emit({ type: 'resize', cols: 100, rows: 40 }));
  expect(xterm().resizes.at(-1)).toEqual([100, 40]);
  expect(screen.getByTitle('pane 크기 (칸 × 줄)').textContent).toBe('100×40');

  // 다시 연결되면 첫 화면이 다시 온다: 지우고 새로 그린다
  await init(100, 40, 'again');
  expect(xterm().resets).toBe(2);
  expect(xterm().writes.at(-1)).toBe('again');
});

test('shows the connection loss, a server error and the pane exit; error and exit close the stream', async () => {
  await renderTab(project(ONE));
  act(() => es().onerror?.());
  expect(screen.getByRole('status').textContent).toContain('연결 끊김');
  act(() => es().emit({ type: 'error', message: "can't find session" }));
  expect(screen.getByRole('status').textContent).toContain("can't find session");
  expect(es().closed).toBe(true);

  cleanup();
  await renderTab(project(ONE));
  act(() => es().emit({ type: 'exit' }));
  expect(screen.getByRole('status').textContent).toContain('pane 종료');
  expect(es().closed).toBe(true);
});

test('keys typed into the terminal are posted as raw base64 bytes, one request at a time, and coalesced while one is in flight', async () => {
  let release: (() => void) | null = null;
  fetchMock.mockImplementation(() => new Promise<Response>((resolve) => (release = () => resolve(json(200, { ok: true })))));
  await renderTab(project(ONE));
  await init();
  act(() => xterm().type('a'));
  act(() => xterm().type('\x1b[A'));
  act(() => xterm().type('한'));
  await tick();
  expect(posts()).toEqual([['/api/projects/api/raw', { pane: '%12', data: b64('a') }]]);
  // 첫 요청이 끝나면 그동안 모인 것이 한 번에 간다
  await act(async () => release!());
  await tick();
  expect(posts()).toHaveLength(2);
  expect(posts()[1]![1].data).toBe(btoa('\x1b[A' + String.fromCharCode(...new TextEncoder().encode('한'))));
});

test('mouse moves without a button are not sent; wheel reports are', async () => {
  await renderTab(project(ONE));
  await init();
  act(() => xterm().type('\x1b[<35;10;5M\x1b[<35;11;5M'));
  await tick();
  expect(posts()).toHaveLength(0);
  act(() => xterm().type('\x1b[<35;12;5M\x1b[<64;12;5M'));
  await tick();
  expect(posts().map(([, body]) => atob(body.data!))).toEqual(['\x1b[<64;12;5M']);
});

test('wheel in a full-screen program without mouse support turns into PgUp/PgDn; with mouse support xterm handles it', async () => {
  await renderTab(project(ONE));
  await init();
  const t = xterm();
  const wheel = (deltaY: number) => t.wheel!(new WheelEvent('wheel', { deltaY, cancelable: true }));
  expect(wheel(-120)).toBe(true); // 일반 화면: xterm 의 스크롤백
  t.buffer.active.type = 'alternate';
  expect(wheel(-60)).toBe(false);
  expect(wheel(-60)).toBe(false);
  expect(wheel(240)).toBe(false);
  await tick();
  await tick();
  expect(posts().map(([, body]) => atob(body.data!)).join('')).toBe('\x1b[5~\x1b[6~\x1b[6~');
  t.modes.mouseTrackingMode = 'any';
  expect(wheel(-120)).toBe(true);
});

test('a read-only project gets a terminal without stdin, no input bar, and the config hint', async () => {
  await renderTab(project(ONE, false));
  expect(xterm().options.disableStdin).toBe(true);
  expect(screen.queryByRole('textbox')).toBeNull();
  expect(screen.getByText(/입력을 보내려면/).textContent).toBe('입력을 보내려면 설정에서 이 프로젝트의 "터미널 입력 허용"을 켜세요.');
  act(() => xterm().type('x'));
  await tick();
  expect(posts()).toHaveLength(0);
});

test('no panes: the snapshot output is shown as text and nothing is streamed', async () => {
  await renderTab(project([]));
  expect(FakeEventSource.all).toHaveLength(0);
  expect(screen.getByLabelText('최근 터미널 출력').textContent).toBe('plain output');
  expect(screen.queryByRole('textbox')).toBeNull();
});

test('switching the pane opens a new stream and disposes the old terminal', async () => {
  await renderTab(project(TWO));
  expect(es().url).toBe('/api/projects/api/term/%251');
  const first = xterm();
  fireEvent.click(screen.getByRole('button', { name: /· 1/ }));
  await tick();
  expect(first.disposed).toBe(true);
  expect(es().url).toBe('/api/projects/api/term/%252');
  expect(FakeEventSource.all[0]!.closed).toBe(true);
});

test('the pane selection survives a new snapshot and falls back to the active pane when it disappears', async () => {
  const { rerender } = await renderTab(project([pane('%1', 0, false, []), pane('%2', 1, true, [])]));
  expect(es().url).toBe('/api/projects/api/term/%252');
  fireEvent.click(screen.getByRole('button', { name: /· 0/ }));
  await tick();
  expect(es().url).toBe('/api/projects/api/term/%251');
  rerender(<TerminalTab project={project([pane('%1', 0, false, []), pane('%2', 1, true, [])])} now={NOW} />);
  expect(es().url).toBe('/api/projects/api/term/%251');
  rerender(<TerminalTab project={project([pane('%2', 1, true, []), pane('%3', 2, false, [])])} now={NOW} />);
  await tick();
  expect(es().url).toBe('/api/projects/api/term/%252');
});

test('the stream is closed and the terminal disposed on unmount', async () => {
  const { unmount } = await renderTab(project(ONE));
  unmount();
  expect(es().closed).toBe(true);
  expect(xterm().disposed).toBe(true);
});

test('Enter sends the text with enter:true, clears the input and keeps focus', async () => {
  await renderTab(project(ONE));
  expect(screen.getByText(/^입력은 선택한 pane 에 그대로 전달됩니다/)).toBeTruthy();
  type('npm test');
  fireEvent.keyDown(box(), { key: 'Enter' });
  expect(box().value).toBe('');
  expect(screen.getByRole<HTMLButtonElement>('button', { name: '보내기' }).disabled).toBe(true);
  await tick();
  expect(posts()).toEqual([['/api/projects/api/input', { pane: '%12', text: 'npm test', enter: true }]]);
  expect(document.activeElement).toBe(box());
  expect(screen.getByRole<HTMLButtonElement>('button', { name: '보내기' }).disabled).toBe(false);
});

test('Shift+Enter inserts a newline instead of sending', async () => {
  await renderTab(project(ONE));
  type('line');
  const notPrevented = fireEvent.keyDown(box(), { key: 'Enter', shiftKey: true });
  expect(notPrevented).toBe(true);
  await tick();
  expect(posts()).toHaveLength(0);
});

test('Enter during IME composition does not send', async () => {
  await renderTab(project(ONE));
  type('한글');
  fireEvent.keyDown(box(), { key: 'Enter', isComposing: true });
  fireEvent.keyDown(box(), { key: 'Enter', keyCode: 229 });
  await tick();
  expect(posts()).toHaveLength(0);
  expect(box().value).toBe('한글');
});

test('pasting an image uploads it and puts the saved path into the input', async () => {
  fetchMock.mockImplementation(async (url, init) => {
    if (init?.method === 'POST' && String(url).endsWith('/upload')) {
      const body = JSON.parse(init.body as string) as { type: string; data: string };
      expect(body.type).toBe('image/png');
      expect(Buffer.from(body.data, 'base64').toString()).toBe('png!');
      return json(200, { path: '/Users/me/.nightshift/uploads/api-1.png' });
    }
    return json(200, { ok: true });
  });
  await renderTab(project(ONE));
  type('이 화면 봐줘');
  const file = new File(['png!'], 'shot.png', { type: 'image/png' });
  fireEvent.paste(box(), { clipboardData: { files: [file], getData: () => '' } });
  await tick();
  // FileReader 는 타이머가 아니라 실제 비동기라 몇 번 더 기다린다
  for (let i = 0; i < 20 && !box().value.includes('uploads'); i++) await tick(10);
  expect(box().value).toBe('이 화면 봐줘 /Users/me/.nightshift/uploads/api-1.png ');
  expect(posts().map(([url]) => url)).toEqual(['/api/projects/api/upload']);
});

test('empty Enter and the 보내기 button send just the Enter key', async () => {
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
  await renderTab(project(ONE));
  const button = screen.getByRole<HTMLButtonElement>('button', { name: 'Enter 없이 입력' });
  expect(button.disabled).toBe(true);
  type('y');
  expect(button.disabled).toBe(false);
  fireEvent.click(button);
  await tick();
  expect(posts().map(([, body]) => body)).toEqual([{ pane: '%12', text: 'y' }]);
});

test('special-key buttons send { pane, key } to the selected pane; Ctrl+C asks first', async () => {
  await renderTab(project(TWO));
  fireEvent.click(screen.getByRole('button', { name: /· 1/ }));
  await tick();
  const group = screen.getByRole('group', { name: '특수 키' });
  const keys = group.querySelectorAll('button:not(.more)');
  expect([...keys].map((b) => b.textContent)).toEqual(['Enter', 'Esc', 'Tab', '⇧Tab', '↑', '↓', '←', '→', 'PgUp', 'PgDn', '⌫', 'Ctrl+C', 'Ctrl+D', 'Ctrl+U', 'Ctrl+L']);
  expect([...keys].filter((b) => !b.classList.contains('extra')).map((b) => b.textContent)).toEqual(['Esc', '↑', '↓', 'PgUp', 'PgDn']);
  const more = screen.getByRole('button', { name: '더보기' });
  expect(more.getAttribute('aria-expanded')).toBe('false');
  fireEvent.click(more);
  expect(group.className).toBe('keys open');
  const confirm = vi.fn(() => true);
  vi.stubGlobal('confirm', confirm);
  for (const name of ['Ctrl+C 보내기 (중단)', 'Shift+Tab 보내기', 'Esc 보내기']) {
    fireEvent.click(screen.getByRole('button', { name }));
    await tick();
  }
  expect(confirm).toHaveBeenCalledOnce();
  expect(posts().map(([, body]) => body)).toEqual([
    { pane: '%2', key: 'C-c' },
    { pane: '%2', key: 'BTab' },
    { pane: '%2', key: 'Escape' },
  ]);
  expect(screen.getByRole('button', { name: 'Ctrl+C 보내기 (중단)' }).className).toContain('caution');
});

test('keys in an empty input are forwarded; with text they edit locally and Tab leaves the box', async () => {
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
  expect(await press({ key: 'PageUp' })).toBe(true);
  expect(await press({ key: 'c', ctrlKey: true })).toBe(true);
  expect(posts().map(([, body]) => body.key)).toEqual(['Up', 'BSpace', 'Tab', 'BTab', 'PPage', 'C-c']);

  type('ls');
  expect(await press({ key: 'ArrowUp' })).toBe(false);
  expect(await press({ key: 'Backspace' })).toBe(false);
  expect(await press({ key: 'c', ctrlKey: true })).toBe(false);
  expect(await press({ key: 'Tab' })).toBe(false);
  expect(posts()).toHaveLength(6);
});

test('a 403 shows the server error and puts the text back; the next success clears it', async () => {
  let status = 403;
  fetchMock.mockImplementation(async () => (status === 200 ? json(200, { ok: true }) : json(status, { error: '이 프로젝트는 입력이 허용되지 않습니다' })));
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
});

test('on a touch screen Enter inserts a newline, 보내기 sends, and a key button does not pull focus into the input', async () => {
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: !q.includes('pointer: fine'), media: q, addEventListener() {}, removeEventListener() {} }));
  await renderTab(project(TWO));
  const input = screen.getByPlaceholderText(/입력 후 보내기/);
  fireEvent.click(screen.getByRole('button', { name: 'Page Up 보내기 (프로그램 안에서 위로)' }));
  await tick();
  expect(document.activeElement).not.toBe(input);
  fireEvent.change(input, { target: { value: 'line' } });
  expect(fireEvent.keyDown(input, { key: 'Enter' })).toBe(true);
  await tick();
  expect(posts().map(([, body]) => body.key)).toEqual(['PPage']);
  fireEvent.click(screen.getByRole('button', { name: '보내기' }));
  await tick();
  expect(document.activeElement).toBe(input);
});

test('fits an unattached session to the screen it is opened on, once; an attached one is left alone', async () => {
  const fits = () => fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/panes/%251/fit'));
  await renderTab(project(TWO));
  await init(200, 50);
  await tick(400);
  // 테스트 환경에서는 요소 크기를 잴 수 없어 화면 폭으로 어림한 칸 수(약 120칸)·40줄로 맞춘다
  expect(fits()).toHaveLength(1);
  expect(fits()[0]![1]?.method).toBe('POST');
  expect(JSON.parse(fits()[0]![1]?.body as string)).toMatchObject({ rows: 40 });
  await init(200, 50);
  await tick(400);
  expect(fits()).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: '화면에 맞추기' }));
  await tick();
  expect(fits()).toHaveLength(2);

  cleanup();
  fetchMock.mockClear();
  const attached = project(TWO);
  attached.tmux.attached = true;
  await renderTab(attached);
  await init(200, 50);
  await tick(400);
  expect(fits()).toHaveLength(0);
  expect(screen.queryByRole('button', { name: '화면에 맞추기' })).toBeNull();
});
