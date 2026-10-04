import { statSync } from 'node:fs';
import type { Commit, FileChange, FileStat, GitBaseline, GitInfo, SinceBaseline } from '../shared/types.ts';
import { run } from './exec.ts';

// 기준점에 커밋이 없었을 때(빈 저장소) 비교 대상으로 쓰는 Git 의 빈 트리.
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const LOG_FORMAT = '--format=%H%x1f%an%x1f%cI%x1f%s';

const git = (repo: string, ...args: string[]) => run('git', ['-C', repo, '-c', 'core.quotePath=false', ...args]);

export function parseLog(out: string): Commit[] {
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [hash = '', author = '', date = '', subject = ''] = line.split('\x1f');
      return { hash, author, date, subject };
    });
}

export function parseStatus(out: string): FileChange[] {
  return out
    .split('\n')
    .filter((l) => l.length > 3)
    .map((l) => ({ status: l.slice(0, 2), path: l.slice(3) }));
}

export function parseNumstat(out: string): FileStat[] {
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [add = '0', del = '0', ...rest] = line.split('\t');
      // 바이너리 파일은 "-\t-\tpath" → 0 으로 취급
      return { path: rest.join('\t'), additions: Number(add) || 0, deletions: Number(del) || 0 };
    });
}

const sum = (files: FileStat[], key: 'additions' | 'deletions') => files.reduce((n, f) => n + f[key], 0);

function failed(error: string): GitInfo {
  return {
    ok: false,
    error,
    branch: '',
    head: null,
    clean: true,
    changedFiles: [],
    diffStat: [],
    additions: 0,
    deletions: 0,
    recentCommits: [],
    todayCommits: [],
    fingerprint: '',
  };
}

export async function collectGit(repoPath: string): Promise<GitInfo> {
  try {
    if (!statSync(repoPath).isDirectory()) return failed('저장소 경로가 디렉터리가 아닙니다');
  } catch {
    return failed('저장소 경로가 존재하지 않습니다');
  }
  const inside = await git(repoPath, 'rev-parse', '--is-inside-work-tree');
  if (inside.code === null) return failed(`git 을 실행할 수 없습니다: ${inside.stderr.trim()}`);
  if (inside.code !== 0 || inside.stdout.trim() !== 'true') return failed('Git 저장소가 아닙니다');

  // 커밋이 하나도 없는 저장소에서는 HEAD 관련 명령이 실패한다 → 빈 값으로 취급.
  const [branch, head, status, numstat, recent, today] = await Promise.all([
    git(repoPath, 'branch', '--show-current'),
    git(repoPath, 'rev-parse', '--verify', '-q', 'HEAD'),
    git(repoPath, 'status', '--porcelain'),
    git(repoPath, 'diff', '--numstat', 'HEAD'),
    git(repoPath, 'log', '-n', '10', LOG_FORMAT),
    git(repoPath, 'log', '--since=midnight', LOG_FORMAT),
  ]);
  if (status.code !== 0) return failed(`git status 실패: ${status.stderr.trim()}`);

  const headSha = head.code === 0 ? head.stdout.trim() : null;
  const changedFiles = parseStatus(status.stdout);
  const diffStat = numstat.code === 0 ? parseNumstat(numstat.stdout) : [];
  return {
    ok: true,
    branch: branch.stdout.trim() || (headSha ? `(detached ${headSha.slice(0, 7)})` : '(unknown)'),
    head: headSha,
    clean: changedFiles.length === 0,
    changedFiles,
    diffStat,
    additions: sum(diffStat, 'additions'),
    deletions: sum(diffStat, 'deletions'),
    recentCommits: recent.code === 0 ? parseLog(recent.stdout) : [],
    todayCommits: today.code === 0 ? parseLog(today.stdout) : [],
    fingerprint: JSON.stringify([headSha, changedFiles, diffStat]),
  };
}

/** 기준점 이후의 커밋과 변경(커밋되지 않은 working tree 변경 포함). */
export async function collectSince(repoPath: string, baseline: GitBaseline): Promise<SinceBaseline> {
  const range = baseline.head ? [`${baseline.head}..HEAD`] : [];
  const [log, numstat] = await Promise.all([
    git(repoPath, 'log', '-n', '200', LOG_FORMAT, ...range),
    git(repoPath, 'diff', '--numstat', baseline.head ?? EMPTY_TREE),
  ]);
  const files = numstat.code === 0 ? parseNumstat(numstat.stdout) : [];
  return {
    baseline,
    commits: log.code === 0 ? parseLog(log.stdout) : [],
    files,
    additions: sum(files, 'additions'),
    deletions: sum(files, 'deletions'),
  };
}
