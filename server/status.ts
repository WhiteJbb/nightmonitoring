import type { GitInfo, ProjectStatus, RunKind, RunResult, TmuxInfo } from '../shared/types.ts';
import type { Thresholds } from './config.ts';

export interface StatusInput {
  git: GitInfo;
  tmux: TmuxInfo;
  lastGitChangeAt: string | null;
  logErrors: string[];
  runs: Record<RunKind, RunResult | null>;
  thresholds: Thresholds;
  sessionExitIsError: boolean;
  now: number;
}

const minutesSince = (iso: string | null, now: number): number =>
  iso ? Math.max(0, (now - Date.parse(iso)) / 60_000) : Infinity;

const fmt = (min: number) => (Number.isFinite(min) ? `${Math.floor(min)}분 동안` : '모니터링 시작 이후');

function runFailure(label: string, r: RunResult | null): string | null {
  if (!r || r.running) return null;
  if (r.timedOut) return `${label} 시간 초과`;
  if (r.exitCode !== 0) return `${label} 실패 (exit ${r.exitCode ?? '없음'})`;
  return null;
}

/** 우선순위: 오류 > 정지 의심 > 유휴 > 정상. */
export function judge(i: StatusInput): ProjectStatus {
  const errors: string[] = [];
  if (!i.git.ok) errors.push(i.git.error ?? 'Git 정보를 가져올 수 없습니다');
  if (i.tmux.error) errors.push(i.tmux.error);
  else if (i.tmux.configured && !i.tmux.exists && i.sessionExitIsError) errors.push('tmux 세션이 종료되었거나 없습니다');
  if (i.logErrors.length) errors.push(`로그에서 오류 패턴 ${i.logErrors.length}건 발견`);
  for (const f of [runFailure('테스트', i.runs.test), runFailure('빌드', i.runs.build)]) if (f) errors.push(f);
  if (errors.length) return { state: 'error', reasons: errors };

  const gitIdle = minutesSince(i.lastGitChangeAt, i.now);
  // 세션이 없으면 볼 출력이 없으므로 Git 활동만으로 판정한다.
  const outputIdle = i.tmux.exists ? minutesSince(i.tmux.lastOutputChangeAt, i.now) : gitIdle;
  const what = i.tmux.exists ? '터미널 출력' : 'Git';

  if (outputIdle >= i.thresholds.stalledMinutes && gitIdle >= i.thresholds.noCommitMinutes) {
    return { state: 'stalled', reasons: [`${fmt(Math.min(outputIdle, gitIdle))} 출력·Git 변화 없음`] };
  }
  if (outputIdle >= i.thresholds.idleMinutes) {
    return { state: 'idle', reasons: [`${fmt(outputIdle)} ${what} 변화 없음`] };
  }
  return { state: 'running', reasons: [] };
}
