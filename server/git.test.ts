import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecResult } from './exec.ts';
import { run } from './exec.ts';
import { collectGit, collectSince, parseNumstat, parseStatus } from './git.ts';

vi.mock('./exec.ts', () => ({ run: vi.fn() }));
const mockRun = vi.mocked(run);

const ok = (stdout: string): ExecResult => ({ code: 0, stdout, stderr: '', timedOut: false });
const fail = (code: number | null, stderr = ''): ExecResult => ({ code, stdout: '', stderr, timedOut: false });

/** git 하위 명령(인자 일부)으로 응답을 고르는 mock */
function respond(table: Record<string, ExecResult>) {
  mockRun.mockImplementation(async (_bin, args = []) => {
    const joined = args.join(' ');
    const key = Object.keys(table).find((k) => joined.includes(k));
    return key ? table[key]! : fail(128, 'unexpected');
  });
}

const REPO = process.cwd(); // 실제로 존재하는 디렉터리면 된다 (git 은 mock)
const LOG = 'abc1234\x1fKim\x1f2026-10-04T01:00:00+09:00\x1ffeat: add thing\ndef5678\x1fLee\x1f2026-10-03T23:00:00+09:00\x1ffix: bug\n';

beforeEach(() => mockRun.mockReset());

describe('parsers', () => {
  it('parses porcelain status', () => {
    expect(parseStatus(' M src/a.ts\n?? new file.txt\nA  b.ts\n')).toEqual([
      { status: ' M', path: 'src/a.ts' },
      { status: '??', path: 'new file.txt' },
      { status: 'A ', path: 'b.ts' },
    ]);
  });

  it('parses numstat including binary files', () => {
    expect(parseNumstat('10\t2\tsrc/a.ts\n-\t-\timg.png\n')).toEqual([
      { path: 'src/a.ts', additions: 10, deletions: 2 },
      { path: 'img.png', additions: 0, deletions: 0 },
    ]);
  });
});

describe('collectGit', () => {
  it('reports a missing path without running git', async () => {
    const info = await collectGit('/definitely/not/here');
    expect(info).toMatchObject({ ok: false, error: '저장소 경로가 존재하지 않습니다' });
    expect(mockRun).not.toHaveBeenCalled();
  });

  it('reports a non-git directory', async () => {
    respond({ 'rev-parse --is-inside-work-tree': fail(128, 'fatal: not a git repository') });
    expect(await collectGit(REPO)).toMatchObject({ ok: false, error: 'Git 저장소가 아닙니다' });
  });

  it('collects branch, status, diff and commits', async () => {
    respond({
      'rev-parse --is-inside-work-tree': ok('true\n'),
      'branch --show-current': ok('feat/x\n'),
      'rev-parse --verify': ok('abc1234\n'),
      'status --porcelain': ok(' M src/a.ts\n?? b.ts\n'),
      'diff --numstat': ok('10\t2\tsrc/a.ts\n'),
      '--since=midnight': ok(LOG.split('\n')[0] + '\n'),
      'log -n 10': ok(LOG),
    });
    const info = await collectGit(REPO);
    expect(info).toMatchObject({ ok: true, branch: 'feat/x', head: 'abc1234', clean: false, additions: 10, deletions: 2 });
    expect(info.changedFiles).toHaveLength(2);
    expect(info.recentCommits).toHaveLength(2);
    expect(info.recentCommits[0]).toEqual({ hash: 'abc1234', author: 'Kim', date: '2026-10-04T01:00:00+09:00', subject: 'feat: add thing' });
    expect(info.todayCommits).toHaveLength(1);
    // 모든 호출이 셸 없이 argv 로, 저장소 경로를 -C 로 넘긴다
    for (const [bin, args] of mockRun.mock.calls) {
      expect(bin).toBe('git');
      expect(args.slice(0, 2)).toEqual(['-C', REPO]);
    }
  });

  it('handles a repository with no commits', async () => {
    respond({
      'rev-parse --is-inside-work-tree': ok('true\n'),
      'branch --show-current': ok('main\n'),
      'status --porcelain': ok('?? a.txt\n'),
    });
    const info = await collectGit(REPO);
    expect(info).toMatchObject({ ok: true, branch: 'main', head: null, clean: false, recentCommits: [], additions: 0 });
  });
});

describe('collectSince', () => {
  it('diffs against the baseline head', async () => {
    respond({ 'base000..HEAD': ok(LOG), 'diff --numstat base000': ok('5\t1\ta.ts\n3\t0\tb.ts\n') });
    const since = await collectSince(REPO, { at: '2026-10-04T00:00:00Z', branch: 'main', head: 'base000' });
    expect(since.commits).toHaveLength(2);
    expect(since).toMatchObject({ additions: 8, deletions: 1 });
  });
});
