import { beforeEach, describe, expect, it, vi } from 'vitest';
import { run } from './exec.ts';
import { stripAnsi } from './logs.ts';
import { capturePane, cleanOutput, listSessions } from './tmux.ts';

vi.mock('./exec.ts', () => ({ run: vi.fn() }));
const mockRun = vi.mocked(run);
beforeEach(() => mockRun.mockReset());

describe('listSessions', () => {
  it('parses sessions', async () => {
    mockRun.mockResolvedValue({ code: 0, stdout: 'agent\t1790000000\t1\t1790000300\t1790000600\nother\t1790000100\t0\t1790000100\t\n', stderr: '', timedOut: false });
    const { sessions, error } = await listSessions();
    expect(error).toBeUndefined();
    expect(sessions.get('agent')).toEqual({
      createdAt: new Date(1790000000_000).toISOString(),
      attached: true,
      lastActivityAt: new Date(1790000600_000).toISOString(),
    });
    expect(sessions.get('other')?.attached).toBe(false);
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

describe('capturePane', () => {
  it('targets the exact session and cleans output', async () => {
    mockRun.mockResolvedValue({ code: 0, stdout: 'line 1  \n\x1b[32mgreen\x1b[0m\n\n\n', stderr: '', timedOut: false });
    expect(await capturePane('agent')).toEqual(['line 1', 'green']);
    expect(mockRun.mock.calls[0]![1]).toContain('=agent:');
  });

  it('returns nothing when the capture fails', async () => {
    mockRun.mockResolvedValue({ code: 1, stdout: '', stderr: "can't find session", timedOut: false });
    expect(await capturePane('gone')).toEqual([]);
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
