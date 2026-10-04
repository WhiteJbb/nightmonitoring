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

// 829분 같은 표기 대신 "13시간 49분" 으로 읽히게 한다.
function fmt(min: number): string {
  if (!Number.isFinite(min)) return '모니터링 시작 이후';
  const m = Math.floor(min);
  if (m < 60) return `${m}분 동안`;
  return m % 60 ? `${Math.floor(m / 60)}시간 ${m % 60}분 동안` : `${Math.floor(m / 60)}시간 동안`;
}

function runFailure(label: string, r: RunResult | null): string | null {
  if (!r || r.running || r.canceled) return null;
  if (r.timedOut) return `${label} 시간 초과`;
  if (r.exitCode !== 0) return `${label} 실패 (exit ${r.exitCode ?? '없음'})`;
  return null;
}

/** 우선순위: 오류 > 입력 대기 > 정지 의심 > 유휴 > 정상. */
export function judge(i: StatusInput): ProjectStatus {
  const errors: string[] = [];
  if (!i.git.ok) errors.push(i.git.error ?? 'Git 정보를 가져올 수 없습니다');
  if (i.tmux.error) errors.push(i.tmux.error);
  else if (i.tmux.configured && !i.tmux.exists && i.sessionExitIsError) errors.push('tmux 세션이 종료되었거나 없습니다');
  if (i.logErrors.length) errors.push(`로그에서 오류 패턴 ${i.logErrors.length}건 발견`);
  for (const f of [runFailure('테스트', i.runs.test), runFailure('빌드', i.runs.build)]) if (f) errors.push(f);
  if (errors.length) return { state: 'error', reasons: errors };

  if (i.tmux.exists && i.tmux.waitingPrompt) return { state: 'waiting', reasons: [`입력 대기: ${i.tmux.waitingPrompt}`] };

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
  // 정상일 때도 한 줄을 채워, 카드마다 줄 수가 달라 보이지 않게 한다.
  const m = Math.floor(outputIdle);
  const label = i.tmux.exists ? '출력' : 'Git 변화';
  return { state: 'running', reasons: [m < 1 ? (i.tmux.exists ? '지금 출력 중' : '방금 Git 변화') : `${m}분 전 마지막 ${label}`] };
}
