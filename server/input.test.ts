import type { AddressInfo } from 'node:net';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, guard, isPrivateBind, isTailscaleAddress } from './app.ts';
import { loadConfig, parseConfig } from './config.ts';
import { applyConfigUpdate, readConfigView } from './configEdit.ts';
import { run } from './exec.ts';
import type { ParsedInput } from './input.ts';
import { logInput, parseInput, sendInput } from './input.ts';
import type { Collector } from './monitor.ts';
import { Monitor, NO_LOG } from './monitor.ts';
import { Runner } from './runner.ts';
import { capturePaneNow, newSession } from './tmux.ts';

vi.mock('./exec.ts', () => ({ run: vi.fn() }));
const mockRun = vi.mocked(run);
const ok = (stdout = '') => ({ code: 0, stdout, stderr: '', timedOut: false });
beforeEach(() => {
  mockRun.mockReset();
  mockRun.mockResolvedValue(ok());
});

describe('parseInput', () => {
  it('accepts text or one allowlisted key', () => {
    expect(parseInput({ pane: '%3', text: 'hello', enter: true })).toEqual({ pane: '%3', text: 'hello', enter: true });
    expect(parseInput({ pane: '%3', text: '-rf; $(x)' })).toEqual({ pane: '%3', text: '-rf; $(x)', enter: false });
    expect(parseInput({ pane: '%3', key: 'C-c' })).toEqual({ pane: '%3', key: 'C-c' });
    expect(parseInput({ pane: '%3', key: 'PPage' })).toEqual({ pane: '%3', key: 'PPage' });
  });

  it('rejects everything else', () => {
    for (const body of [null, 'x', {}, { pane: 'agent:0.0', text: 'x' }, { pane: '%3' }, { pane: '%3', text: 'x', key: 'Enter' }, { pane: '%3', key: 'F1' }, { pane: '%3', key: 'Enter; kill-server' }, { pane: '%3', text: '' }, { pane: '%3', text: 5 }, { pane: '%3', text: 'a\0b' }, { pane: '%3', text: 'x'.repeat(4001) }]) {
      expect(typeof parseInput(body)).toBe('string');
    }
  });
});

describe('sendInput', () => {
  it('sends text literally, then Enter when asked', async () => {
    expect(await sendInput({ pane: '%3', text: '-l Enter; rm -rf ~', enter: true })).toBeNull();
    expect(mockRun.mock.calls.map((c) => c.slice(0, 2))).toEqual([
      ['tmux', ['send-keys', '-t', '%3', '-l', '--', '-l Enter; rm -rf ~']],
      ['tmux', ['send-keys', '-t', '%3', 'Enter']],
    ]);
  });

  it('sends a key, and text without Enter', async () => {
    await sendInput({ pane: '%3', key: 'BTab' });
    await sendInput({ pane: '%3', text: 'y', enter: false });
    expect(mockRun.mock.calls.map((c) => c[1])).toEqual([['send-keys', '-t', '%3', 'BTab'], ['send-keys', '-t', '%3', '-l', '--', 'y']]);
  });

  it('reports tmux failures and does not press Enter after a failed text', async () => {
    mockRun.mockResolvedValue({ code: 1, stdout: '', stderr: "can't find pane: %3\n", timedOut: false });
    expect(await sendInput({ pane: '%3', text: 'x', enter: true })).toBe("can't find pane: %3");
    expect(mockRun).toHaveBeenCalledTimes(1);
  });
});

describe('capturePaneNow', () => {
  it('asks for the pane height, then captures', async () => {
    mockRun.mockResolvedValueOnce(ok('40\n')).mockResolvedValueOnce(ok('a\n\x1b[31mb\x1b[0m\n'));
    expect(await capturePaneNow('%3')).toEqual(['a', '\x1b[31mb\x1b[0m']);
    expect(mockRun.mock.calls[1]![1]).toEqual(['-u', 'capture-pane', '-p', '-e', '-J', '-t', '%3', '-S', '-60']);
  });

  it('reaches further back into the scrollback when asked for more lines', async () => {
    const many = Array.from({ length: 1200 }, (_, i) => `l${i}`).join('\n');
    mockRun.mockResolvedValueOnce(ok('40\n')).mockResolvedValueOnce(ok(many));
    const lines = await capturePaneNow('%3', 1000);
    expect(mockRun.mock.calls[1]![1].at(-1)).toBe('-960');
    expect(lines).toHaveLength(1000);
    expect(lines.at(-1)).toBe('l1199');
  });
});

describe('logInput', () => {
  it('appends one JSON line per input', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'nightshift-input-'));
    const file = path.join(dir, 'nested/input.log');
    await logInput(file, 'app', { pane: '%3', text: 'hi', enter: true });
    await logInput(file, 'app', { pane: '%3', key: 'C-c' });
    const lines = (await readFile(file, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
    expect(lines).toMatchObject([{ project: 'app', pane: '%3', text: 'hi', enter: true }, { project: 'app', pane: '%3', key: 'C-c' }]);
    await rm(dir, { recursive: true });
  });
});

describe('terminal API', () => {
  const pane = (id: string) => ({ id, window: 0, windowName: 'w', index: 0, command: 'zsh', active: true, lines: [`snapshot ${id}`] });
  const collector: Collector = {
    git: async () => ({ ok: true, branch: 'main', head: 'h', clean: true, changedFiles: [], diffStat: [], additions: 0, deletions: 0, recentCommits: [], todayCommits: [], fingerprint: 'h' }),
    since: async (_p, baseline) => ({ baseline, commits: [], files: [], additions: 0, deletions: 0 }),
    tmux: async (projects) => new Map(projects.map((p, i) => [p.id, { configured: true, exists: true, createdAt: null, attached: false, lastActivityAt: null, output: [], panes: [pane(`%${i + 1}`)], waitingPrompt: null, attachCommand: null }])),
    logErrors: async () => NO_LOG,
  };
  const servers: { close: () => void }[] = [];
  afterAll(() => servers.forEach((s) => s.close()));

  async function start(opts: { host?: string; demo?: boolean } = {}) {
    const config = parseConfig({ host: opts.host, projects: [{ name: 'open', repoPath: '/r/open', tmuxSession: 'a', allowInput: true }, { name: 'closed', repoPath: '/r/closed', tmuxSession: 'b' }] }, '/base');
    const runner = new Runner({ timeoutSec: 1, logDir: null });
    const monitor = new Monitor({ config, collector, runs: runner.get });
    await monitor.tick();
    const terminal = { capture: vi.fn(async (id: string) => [`live ${id}`]), send: vi.fn<(input: ParsedInput) => Promise<string | null>>(async () => null), log: vi.fn(), createSession: vi.fn<(name: string, repoPath: string) => Promise<string | null>>(async () => null) };
    const server = createApp({ config, monitor, runner, reportsDir: () => '/nonexistent', ...(opts.demo ? {} : { terminal }) }).listen(0, '127.0.0.1');
    servers.push(server);
    await new Promise((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/projects`;
    const post = (id: string, body: unknown, headers: Record<string, string> = {}) => fetch(`${base}/${id}/input`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
    return { base, post, terminal };
  }

  it('serves a live capture only for panes of that project', async () => {
    const { base, terminal } = await start();
    expect(await (await fetch(`${base}/open/panes/%251`)).json()).toEqual({ lines: ['live %1'] });
    expect((await fetch(`${base}/open/panes/%252`)).status).toBe(404); // 다른 프로젝트의 pane
    expect((await fetch(`${base}/nope/panes/%251`)).status).toBe(404);
    expect(terminal.capture).toHaveBeenCalledExactlyOnceWith('%1', 100);
    // 줄 수는 100~5000 으로 잘린다
    for (const [q, n] of [['800', 800], ['999999', 5000], ['3', 100], ['abc', 100]] as const) {
      await fetch(`${base}/open/panes/%251?lines=${q}`);
      expect(terminal.capture).toHaveBeenLastCalledWith('%1', n);
    }
  });

  it('sends input only to an allowed project and its own panes, and logs it', async () => {
    const { post, terminal } = await start();
    expect((await post('open', { pane: '%1', text: 'continue', enter: true })).status).toBe(200);
    expect(terminal.send).toHaveBeenCalledExactlyOnceWith({ pane: '%1', text: 'continue', enter: true });
    expect(terminal.log).toHaveBeenCalledExactlyOnceWith('open', { pane: '%1', text: 'continue', enter: true });

    expect((await post('closed', { pane: '%2', text: 'x' })).status).toBe(403); // allowInput 꺼짐
    expect((await post('open', { pane: '%2', text: 'x' })).status).toBe(404); // 남의 pane
    expect((await post('open', { pane: '%99', key: 'Enter' })).status).toBe(404);
    expect((await post('nope', { pane: '%1', text: 'x' })).status).toBe(404);
    expect((await post('open', { pane: '%1', key: 'F12' })).status).toBe(400);
    expect((await post('open', { pane: '%1', text: 'x' }, { Origin: 'https://evil.example' })).status).toBe(403);
    expect((await fetch(`${(await start()).base}/open/input`, { method: 'POST', body: '{"pane":"%1","text":"x"}' })).status).toBe(400); // JSON 이 아닌 본문
    expect(terminal.send).toHaveBeenCalledTimes(1);
  });

  it('surfaces tmux failures', async () => {
    const { post, terminal } = await start();
    terminal.send.mockResolvedValueOnce("can't find pane");
    const res = await post('open', { pane: '%1', key: 'Enter' });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "can't find pane" });
  });

  it('refuses input when exposed beyond loopback/Tailscale, and in demo mode', async () => {
    for (const host of ['0.0.0.0', '192.168.0.10']) {
      const exposed = await start({ host });
      expect((await exposed.post('open', { pane: '%1', text: 'x' })).status).toBe(403);
      expect(exposed.terminal.send).not.toHaveBeenCalled();
    }
    // Tailscale 주소 바인딩은 tailnet 안에서만 닿으므로 허용
    const tailnet = await start({ host: '100.101.102.103' });
    expect((await tailnet.post('open', { pane: '%1', text: 'x' })).status).toBe(200);

    const demo = await start({ demo: true });
    expect((await demo.post('open', { pane: '%1', text: 'x' })).status).toBe(403);
    expect(await (await fetch(`${demo.base}/open/panes/%251`)).json()).toEqual({ lines: ['snapshot %1'] });
  });
});

describe('newSession', () => {
  it('creates a detached shell session in the directory, without any command', async () => {
    mockRun.mockResolvedValueOnce({ code: 1, stdout: '', stderr: "can't find session", timedOut: false }).mockResolvedValueOnce(ok());
    expect(await newSession('agent', '/repo/app')).toBeNull();
    expect(mockRun.mock.calls.map((c) => c[1])).toEqual([
      ['has-session', '-t', '=agent'],
      ['new-session', '-d', '-s', 'agent', '-c', '/repo/app', '-x', '200', '-y', '50'],
    ]);
  });

  it('leaves an existing session alone and reports failures', async () => {
    expect(await newSession('agent', '/repo/app')).toBeNull(); // has-session 성공
    expect(mockRun).toHaveBeenCalledTimes(1);
    mockRun.mockResolvedValueOnce({ code: 1, stdout: '', stderr: '', timedOut: false }).mockResolvedValueOnce({ code: 1, stdout: '', stderr: 'duplicate session: agent\n', timedOut: false });
    expect(await newSession('agent', '/repo/app')).toBe('duplicate session: agent');
  });
});

describe('session API', () => {
  const servers: { close: () => void }[] = [];
  afterAll(() => servers.forEach((s) => s.close()));
  let dir = '';
  beforeAll(async () => void (dir = await mkdtemp(path.join(tmpdir(), 'nightshift-session-'))));
  afterAll(() => rm(dir, { recursive: true }));

  async function start(opts: { host?: string; demo?: boolean } = {}) {
    const file = path.join(dir, `c-${servers.length}.json`);
    await writeFile(file, JSON.stringify({ host: opts.host, projects: [{ name: 'Old', repoPath: '/r/old', tmuxSession: 'old', testCommand: 'npm test' }, { name: 'NoSession', repoPath: '/r/none' }] }));
    const { config } = loadConfig(file, '/base');
    const runner = new Runner({ timeoutSec: 1, logDir: null });
    const collector: Collector = {
      git: async () => ({ ok: true, branch: 'main', head: 'h', clean: true, changedFiles: [], diffStat: [], additions: 0, deletions: 0, recentCommits: [], todayCommits: [], fingerprint: 'h' }),
      since: async (_p, baseline) => ({ baseline, commits: [], files: [], additions: 0, deletions: 0 }),
      tmux: async () => new Map(),
      logErrors: async () => NO_LOG,
    };
    const monitor = new Monitor({ config, collector, runs: runner.get });
    await monitor.tick();
    const createSession = vi.fn<(name: string, repoPath: string) => Promise<string | null>>(async (name) => (name === 'bad name' ? '세션 이름이 올바르지 않습니다' : null));
    const terminal = { capture: vi.fn(async () => []), send: vi.fn(async () => null), log: vi.fn(), createSession };
    const configEditor = {
      view: () => readConfigView(file, '/base'),
      update: async (body: unknown) => {
        applyConfigUpdate(file, '/base', body);
        await monitor.setConfig(loadConfig(file, '/base').config, collector);
        return readConfigView(file, '/base');
      },
    };
    const server = createApp({ config, monitor, runner, reportsDir: () => '/nonexistent', configEditor, ...(opts.demo ? {} : { terminal }) }).listen(0, '127.0.0.1');
    servers.push(server);
    await new Promise((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
    const post = async (p: string, body?: unknown) => {
      const res = await fetch(`${base}${p}`, { method: 'POST', ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
      return [res.status, await res.json()] as const;
    };
    return { post, createSession, monitor, file };
  }

  it('creates a session and registers it as a project in one step', async () => {
    const { post, createSession, monitor, file } = await start();
    expect(await post('/sessions', { name: 'New Agent', repoPath: '~/code/new', tmuxSession: 'new-agent', allowInput: true, testCommand: 'id' })).toEqual([200, { id: 'new-agent' }]);
    expect(createSession).toHaveBeenCalledExactlyOnceWith('new-agent', '~/code/new');
    expect(monitor.snapshot.projects.map((p) => p.id)).toEqual(['old', 'nosession', 'new-agent']);
    const added = loadConfig(file, '/base').config.projects[2]!;
    expect(added).toMatchObject({ name: 'New Agent', tmuxSession: 'new-agent', allowInput: true, testCommand: null });
    // 기존 프로젝트의 명령은 그대로
    expect(loadConfig(file, '/base').config.projects[0]!.testCommand).toBe('npm test');
  });

  it('rejects incomplete, duplicate and invalid requests without registering anything', async () => {
    const { post, createSession, file } = await start();
    expect((await post('/sessions', { name: 'x', repoPath: '', tmuxSession: 's' }))[0]).toBe(400);
    expect((await post('/sessions', { name: 'x', repoPath: '/r', tmuxSession: 'old' }))[0]).toBe(409);
    expect(createSession).not.toHaveBeenCalled();
    expect(await post('/sessions', { name: 'x', repoPath: '/r', tmuxSession: 'bad name' })).toEqual([400, { error: '세션 이름이 올바르지 않습니다' }]);
    expect(loadConfig(file, '/base').config.projects).toHaveLength(2);
  });

  it('restarts the session of a registered project', async () => {
    const { post, createSession } = await start();
    expect(await post('/projects/old/session')).toEqual([200, { ok: true }]);
    expect(createSession).toHaveBeenCalledExactlyOnceWith('old', '/r/old');
    expect((await post('/projects/nosession/session'))[0]).toBe(400);
    expect((await post('/projects/nope/session'))[0]).toBe(404);
  });

  it('refuses in demo mode and when exposed beyond loopback/Tailscale', async () => {
    const demo = await start({ demo: true });
    expect((await demo.post('/sessions', { name: 'x', repoPath: '/r', tmuxSession: 's' }))[0]).toBe(403);
    expect((await demo.post('/projects/old/session'))[0]).toBe(403);
    const exposed = await start({ host: '0.0.0.0' });
    expect((await exposed.post('/sessions', { name: 'x', repoPath: '/r', tmuxSession: 's' }))[0]).toBe(403);
    expect((await exposed.post('/projects/old/session'))[0]).toBe(403);
    expect(exposed.createSession).not.toHaveBeenCalled();
  });
});

describe('network guards', () => {
  it('recognizes Tailscale addresses', () => {
    expect(['100.64.0.1', '100.101.102.103', '100.127.255.254', 'fd7a:115c:a1e0::1'].map(isTailscaleAddress)).toEqual([true, true, true, true]);
    expect(['100.63.0.1', '100.128.0.1', '10.0.0.1', '192.168.0.10', '0.0.0.0', '1100.64.0.1'].map(isTailscaleAddress)).toEqual([false, false, false, false, false, false]);
    expect(['127.0.0.1', 'localhost', '::1', '100.64.0.1'].map(isPrivateBind)).toEqual([true, true, true, true]);
    expect(['0.0.0.0', '192.168.0.10', '::'].map(isPrivateBind)).toEqual([false, false, false]);
  });

  it('accepts allowedHosts as Host and Origin on a loopback bind, nothing else', () => {
    const g = guard({ host: '127.0.0.1', allowedHosts: ['mac.tailnet.ts.net'] }) as unknown as (req: object, res: object, next: () => void) => void;
    const check = (method: string, headers: Record<string, string>) => {
      let code = 200;
      const status = (c: number) => {
        code = c;
        return { json: () => {} };
      };
      g({ method, headers }, { status }, () => {});
      return code;
    };
    expect(check('GET', { host: 'MAC.tailnet.ts.net' })).toBe(200);
    expect(check('GET', { host: 'evil.example' })).toBe(403);
    expect(check('POST', { host: 'mac.tailnet.ts.net', origin: 'https://mac.tailnet.ts.net' })).toBe(200);
    // 프록시가 Host 를 localhost 로 바꿔 보내도 Origin 이 허용 목록에 있으면 통과
    expect(check('POST', { host: '127.0.0.1:4477', origin: 'https://mac.tailnet.ts.net' })).toBe(200);
    expect(check('POST', { host: 'mac.tailnet.ts.net', origin: 'https://evil.example' })).toBe(403);
    expect(check('POST', { host: '127.0.0.1:4477', origin: 'null' })).toBe(403);
  });
});
