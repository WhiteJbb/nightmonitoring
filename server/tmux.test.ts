import { beforeEach, describe, expect, it, vi } from 'vitest';
import { run } from './exec.ts';
import { compileMatcher, findErrors, findPrompt, stripAnsi, stripVolatile } from './logs.ts';
import { capturePane, cleanOutput, listPanes, listSessions, MAX_PANES, parsePanes } from './tmux.ts';

vi.mock('./exec.ts', () => ({ run: vi.fn() }));
const mockRun = vi.mocked(run);
beforeEach(() => mockRun.mockReset());

describe('listSessions', () => {
  it('parses sessions', async () => {
    mockRun.mockResolvedValue({ code: 0, stdout: 'agent\t1790000000\t1\t1790000300\t1790000600\nother\t1790000100\t0\t1790000100\t\ngarbage\tx\t0\t\t\n', stderr: '', timedOut: false });
    const { sessions, error } = await listSessions();
    expect(error).toBeUndefined();
    expect(sessions.get('agent')).toEqual({
      createdAt: new Date(1790000000_000).toISOString(),
      attached: true,
      lastActivityAt: new Date(1790000600_000).toISOString(),
    });
    expect(sessions.get('other')?.attached).toBe(false);
    expect(sessions.has('garbage')).toBe(false);
  });

  it('treats "no server running" as zero sessions', async () => {
    mockRun.mockResolvedValue({ code: 1, stdout: '', stderr: 'no server running on /tmp/tmux-501/default', timedOut: false });
    expect(await listSessions()).toEqual({ sessions: new Map() });
  });

  it('reports an error when tmux cannot be executed', async () => {
    mockRun.mockResolvedValue({ code: null, stdout: '', stderr: 'spawn tmux ENOENT', timedOut: false });
    expect((await listSessions()).error).toContain('ENOENT');
  });
});

describe('panes', () => {
  it('lists panes per session with the active pane first', () => {
    const out = ['agent\t%3\t1\t0\tnode\t1\t0\t40\t157\tserver', 'agent\t%1\t0\t0\tclaude\t0\t1\t50\t157\tmy\twin', 'agent\t%2\t0\t1\tzsh\t1\t1\t50\t157\tmy\twin', 'other\t%9\t0\t0\tzsh\t1\t1\t24\t80\tzsh', 'bad\tx\t0'].join('\n');
    const panes = parsePanes(out);
    expect(panes.get('agent')!.map((p) => p.id)).toEqual(['%2', '%1', '%3']);
    expect(panes.get('agent')![0]).toEqual({ id: '%2', window: 0, windowName: 'my\twin', index: 1, command: 'zsh', active: true, height: 50, cols: 157 });
    expect(panes.get('other')).toHaveLength(1);
    expect(panes.has('bad')).toBe(false);
  });

  it('caps the number of panes per session', () => {
    const out = Array.from({ length: 12 }, (_, i) => `s\t%${i}\t0\t${i}\tzsh\t0\t1\t24\t80\tw`).join('\n');
    expect(parsePanes(out).get('s')).toHaveLength(MAX_PANES);
  });

  it('returns no panes when tmux fails', async () => {
    mockRun.mockResolvedValue({ code: 1, stdout: '', stderr: 'no server running', timedOut: false });
    expect(await listPanes()).toEqual(new Map());
  });
});

describe('capturePane', () => {
  it('captures by pane id with colors, keeping only SGR sequences', async () => {
    mockRun.mockResolvedValue({ code: 0, stdout: 'line 1  \n\x1b[32mgreen\x1b[0m\x1b[2K\x1b]0;title\x07\n\x1b[0m\n\n', stderr: '', timedOut: false });
    expect(await capturePane({ id: '%7', height: 40 })).toEqual(['line 1', '\x1b[32mgreen\x1b[0m']);
    const args = mockRun.mock.calls[0]![1];
    expect(args).toEqual(['-u', 'capture-pane', '-p', '-e', '-J', '-t', '%7', '-S', '-60']);
  });

  it('starts inside the screen when the pane is taller than the limit', async () => {
    mockRun.mockResolvedValue({ code: 0, stdout: 'x\n', stderr: '', timedOut: false });
    await capturePane({ id: '%7', height: 130 });
    expect(mockRun.mock.calls[0]![1].at(-1)).toBe('30');
  });

  it('returns nothing when the capture fails', async () => {
    mockRun.mockResolvedValue({ code: 1, stdout: '', stderr: "can't find pane", timedOut: false });
    expect(await capturePane({ id: '%7', height: 40 })).toEqual([]);
  });
});

describe('output cleaning', () => {
  it('keeps only the last 100 lines', () => {
    const out = Array.from({ length: 150 }, (_, i) => `l${i}`).join('\n');
    const lines = cleanOutput(out);
    expect(lines).toHaveLength(100);
    expect(lines[99]).toBe('l149');
  });

  it('strips CSI, OSC and control characters', () => {
    expect(stripAnsi('\x1b[1;31mred\x1b[0m \x1b]0;title\x07ok\r\x1b[2K\x08')).toBe('red ok');
  });
});

describe('pattern helpers', () => {
  it('matches plain substrings case-insensitively and /regex/ patterns', () => {
    const match = compileMatcher(['failed', '/^Error:/', '/panic/i']);
    expect(match('Build FAILED')).toBe(true);
    expect(match('Error: boom')).toBe(true);
    expect(match('an error: boom')).toBe(false);
    expect(match('PANIC at the disco')).toBe(true);
    expect(() => compileMatcher(['/(/'])).toThrow();
  });

  it('skips ignored lines when finding errors', () => {
    const lines = ['ok', 'Found 0 errors', 'TypeError: x is not a function', 'no errors found'];
    expect(findErrors(lines, ['error'], ['0 errors', 'no errors'])).toEqual(['TypeError: x is not a function']);
    expect(findErrors(lines, [])).toEqual([]);
  });

  it('finds a prompt only near the bottom of the screen', () => {
    const patterns = ['Do you want to', '(y/n)'];
    expect(findPrompt(['working', '  Do you want to proceed?', '  1. Yes', ''], patterns)).toBe('Do you want to proceed?');
    const scrolledAway = ['Overwrite? (y/n)', ...Array.from({ length: 20 }, (_, i) => `line ${i}`)];
    expect(findPrompt(scrolledAway, patterns)).toBeNull();
    expect(findPrompt(['Do you want to proceed?'], [])).toBeNull();
  });

  it('normalizes spinner and counter churn', () => {
    expect(stripVolatile('✽ Gusting… (10m 8s · ↓ 67.6k tokens)')).toBe(stripVolatile('✻ Gusting… (12m 41s · ↓ 70.1k tokens)'));
    expect(stripVolatile('⠋ building')).toBe(stripVolatile('⠙ building'));
    expect(stripVolatile('editing a.ts')).not.toBe(stripVolatile('editing b.ts'));
  });
});
