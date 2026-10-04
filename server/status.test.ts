import { describe, expect, it } from 'vitest';
import type { GitInfo, RunResult, TmuxInfo } from '../shared/types.ts';
import { judge } from './status.ts';
import type { StatusInput } from './status.ts';

const NOW = Date.parse('2026-10-04T03:00:00Z');
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();

const git: GitInfo = { ok: true, branch: 'main', head: 'abc', clean: true, changedFiles: [], diffStat: [], additions: 0, deletions: 0, recentCommits: [], todayCommits: [], fingerprint: '' };
const tmux: TmuxInfo = { configured: true, exists: true, createdAt: ago(300), attached: false, lastActivityAt: ago(1), lastOutputChangeAt: ago(1), output: [], panes: [], waitingPrompt: null, attachCommand: 'tmux attach -t s' };
const run = (over: Partial<RunResult>): RunResult => ({ kind: 'test', command: 'npm test', running: false, startedAt: ago(5), finishedAt: ago(4), exitCode: 0, timedOut: false, canceled: false, durationMs: 1000, stdout: '', stderr: '', ...over });

const input = (over: Partial<StatusInput> = {}): StatusInput => ({
  git,
  tmux,
  lastGitChangeAt: ago(1),
  logErrors: [],
  runs: { test: null, build: null },
  thresholds: { idleMinutes: 15, stalledMinutes: 30, noCommitMinutes: 30 },
  sessionExitIsError: true,
  now: NOW,
  ...over,
});
const outputIdle = (min: number) => ({ ...tmux, lastOutputChangeAt: ago(min) });

describe('judge', () => {
  it('running when output is fresh', () => {
    expect(judge(input())).toEqual({ state: 'running', reasons: ['1분 전 마지막 출력'] });
    expect(judge(input({ tmux: outputIdle(0.2) })).reasons).toEqual(['지금 출력 중']);
    expect(judge(input({ tmux: outputIdle(9) })).reasons).toEqual(['9분 전 마지막 출력']);
  });

  it('idle after 15 minutes without output', () => {
    expect(judge(input({ tmux: outputIdle(20), lastGitChangeAt: ago(20) })).state).toBe('idle');
    expect(judge(input({ tmux: outputIdle(14) })).state).toBe('running');
  });

  it('stalled only when both output and git are quiet for 30 minutes', () => {
    expect(judge(input({ tmux: outputIdle(45), lastGitChangeAt: ago(45) })).state).toBe('stalled');
    // 출력은 멈췄지만 최근 커밋이 있으면 유휴
    expect(judge(input({ tmux: outputIdle(45), lastGitChangeAt: ago(5) })).state).toBe('idle');
  });

  it('writes long idle times in hours', () => {
    expect(judge(input({ tmux: outputIdle(829), lastGitChangeAt: ago(900) })).reasons).toEqual(['13시간 49분 동안 출력·Git 변화 없음']);
    expect(judge(input({ tmux: outputIdle(120), lastGitChangeAt: ago(5) })).reasons).toEqual(['2시간 동안 터미널 출력 변화 없음']);
    expect(judge(input({ tmux: outputIdle(45), lastGitChangeAt: ago(45) })).reasons).toEqual(['45분 동안 출력·Git 변화 없음']);
  });

  it('respects custom thresholds', () => {
    const thresholds = { idleMinutes: 1, stalledMinutes: 2, noCommitMinutes: 2 };
    expect(judge(input({ thresholds, tmux: outputIdle(3), lastGitChangeAt: ago(3) })).state).toBe('stalled');
  });

  it('error when the tmux session is gone, unless disabled', () => {
    const gone = { ...tmux, exists: false, lastOutputChangeAt: null };
    expect(judge(input({ tmux: gone })).state).toBe('error');
    expect(judge(input({ tmux: gone, sessionExitIsError: false })).state).toBe('running');
  });

  it('error on git failure, log errors, failed or timed out runs', () => {
    expect(judge(input({ git: { ...git, ok: false, error: 'Git 저장소가 아닙니다' } }))).toEqual({ state: 'error', reasons: ['Git 저장소가 아닙니다'] });
    expect(judge(input({ logErrors: ['Error: boom'] })).state).toBe('error');
    expect(judge(input({ runs: { test: run({ exitCode: 1 }), build: null } })).reasons).toEqual(['테스트 실패 (exit 1)']);
    expect(judge(input({ runs: { test: null, build: run({ kind: 'build', exitCode: null, timedOut: true }) } })).reasons).toEqual(['빌드 시간 초과']);
    expect(judge(input({ runs: { test: run({}), build: run({ running: true, exitCode: null }) } })).state).toBe('running');
    expect(judge(input({ runs: { test: run({ exitCode: null, canceled: true }), build: null } })).state).toBe('running');
  });

  it('waiting when a prompt is on screen, below errors', () => {
    const prompting = { ...tmux, waitingPrompt: 'Do you want to proceed?', lastOutputChangeAt: ago(50) };
    expect(judge(input({ tmux: prompting, lastGitChangeAt: ago(50) }))).toEqual({ state: 'waiting', reasons: ['입력 대기: Do you want to proceed?'] });
    expect(judge(input({ tmux: prompting, logErrors: ['Error: x'] })).state).toBe('error');
  });

  it('uses git activity alone when no session is configured', () => {
    const none = { ...tmux, configured: false, exists: false, lastOutputChangeAt: null };
    expect(judge(input({ tmux: none, lastGitChangeAt: ago(5) }))).toEqual({ state: 'running', reasons: ['5분 전 마지막 Git 변화'] });
    expect(judge(input({ tmux: none, lastGitChangeAt: ago(0) })).reasons).toEqual(['방금 Git 변화']);
    expect(judge(input({ tmux: none, lastGitChangeAt: ago(20) })).state).toBe('idle');
    expect(judge(input({ tmux: none, lastGitChangeAt: null })).state).toBe('stalled');
  });
});
