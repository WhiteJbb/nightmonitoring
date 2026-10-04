import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
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
  it('parses NUL-separated porcelain status including renames and odd names', () => {
    expect(parseStatus(' M src/a.ts\0?? new "file"\n.txt\0R  new.ts\0old.ts\0A  b.ts\0')).toEqual([
      { status: ' M', path: 'src/a.ts' },
      { status: '??', path: 'new "file"\n.txt' },
      { status: 'R ', path: 'new.ts', from: 'old.ts' },
      { status: 'A ', path: 'b.ts' },
    ]);
  });

  it('parses NUL-separated numstat including binary files and renames', () => {
    expect(parseNumstat('10\t2\tsrc/a.ts\0-\t-\timg.png\x003\t1\t\0old.ts\0new.ts\0')).toEqual([
      { path: 'src/a.ts', additions: 10, deletions: 2 },
      { path: 'img.png', additions: 0, deletions: 0 },
      { path: 'new.ts', additions: 3, deletions: 1, from: 'old.ts' },
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
      'status --porcelain': ok(' M src/a.ts\0?? b.ts\0'),
      'diff --numstat': ok('10\t2\tsrc/a.ts\0'),
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
      'status --porcelain': ok('?? a.txt\0'),
    });
    const info = await collectGit(REPO);
    expect(info).toMatchObject({ ok: true, branch: 'main', head: null, clean: false, recentCommits: [], additions: 0 });
  });
});

describe('untracked files and fingerprint', () => {
  it('counts untracked lines and notices same-size edits', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'nightshift-git-'));
    try {
      await writeFile(path.join(dir, 'new.ts'), 'a\nb\nc\n');
      await writeFile(path.join(dir, 'bin.dat'), Buffer.from([1, 0, 2, 10]));
      execFileSync('mkfifo', [path.join(dir, 'pipe')]);
      respond({
        'rev-parse --is-inside-work-tree': ok('true\n'),
        'branch --show-current': ok('main\n'),
        'rev-parse --verify': ok('abc1234\n'),
        'status --porcelain': ok('?? new.ts\0?? bin.dat\0?? gone.ts\0?? pipe\0'),
        'diff --numstat': ok(''),
      });
      const first = await collectGit(dir);
      expect(first.diffStat).toEqual([
        { path: 'new.ts', additions: 3, deletions: 0, untracked: true },
        { path: 'bin.dat', additions: 0, deletions: 0, untracked: true },
        { path: 'gone.ts', additions: 0, deletions: 0, untracked: true },
        { path: 'pipe', additions: 0, deletions: 0, untracked: true }, // FIFO 를 열다 멈추지 않는다
      ]);
      expect(first.additions).toBe(3);
      expect((await collectGit(dir)).fingerprint).toBe(first.fingerprint);

      // 줄 수는 같지만 내용이 바뀜 → 지문이 달라져야 한다
      await writeFile(path.join(dir, 'new.ts'), 'x\ny\nz\n');
      await utimes(path.join(dir, 'new.ts'), new Date(), new Date(Date.now() + 5000));
      const second = await collectGit(dir);
      expect(second.additions).toBe(3);
      expect(second.fingerprint).not.toBe(first.fingerprint);

      const since = await collectSince(dir, { at: '2026-10-04T00:00:00Z', branch: 'main', head: 'abc1234' }, second);
      expect(since.files.map((f) => f.path)).toContain('new.ts');
      expect(since.additions).toBe(3);
    } finally {
      await rm(dir, { recursive: true });
    }
  });
});

describe('collectSince', () => {
  it('diffs against the baseline head', async () => {
    respond({ 'base000..HEAD': ok(LOG), 'diff --numstat -z base000': ok('5\t1\ta.ts\x003\t0\tb.ts\0') });
    const since = await collectSince(REPO, { at: '2026-10-04T00:00:00Z', branch: 'main', head: 'base000' });
    expect(since.commits).toHaveLength(2);
    expect(since).toMatchObject({ additions: 8, deletions: 1 });
  });

  it('diffs against the empty tree when the baseline had no commits', async () => {
    respond({ 'log -n 200': ok(LOG), 'diff --numstat -z 4b825dc': ok('7\t0\ta.ts\0') });
    const since = await collectSince(REPO, { at: '2026-10-04T00:00:00Z', branch: 'main', head: null });
    expect(since).toMatchObject({ additions: 7, deletions: 0 });
    expect(since.commits).toHaveLength(2);
  });
});
