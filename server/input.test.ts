import type { AddressInfo } from 'node:net';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from './app.ts';
import { parseConfig } from './config.ts';
import { run } from './exec.ts';
import type { ParsedInput } from './input.ts';
import { logInput, parseInput, sendInput } from './input.ts';
import type { Collector } from './monitor.ts';
import { Monitor, NO_LOG } from './monitor.ts';
import { Runner } from './runner.ts';
import { capturePaneNow } from './tmux.ts';

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
    const terminal = { capture: vi.fn(async (id: string) => [`live ${id}`]), send: vi.fn<(input: ParsedInput) => Promise<string | null>>(async () => null), log: vi.fn() };
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
    expect(terminal.capture).toHaveBeenCalledExactlyOnceWith('%1');
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

  it('refuses input when not bound to loopback, and in demo mode', async () => {
    const exposed = await start({ host: '0.0.0.0' });
    expect((await exposed.post('open', { pane: '%1', text: 'x' })).status).toBe(403);
    expect(exposed.terminal.send).not.toHaveBeenCalled();

    const demo = await start({ demo: true });
    expect((await demo.post('open', { pane: '%1', text: 'x' })).status).toBe(403);
    expect(await (await fetch(`${demo.base}/open/panes/%251`)).json()).toEqual({ lines: ['snapshot %1'] });
  });
});
