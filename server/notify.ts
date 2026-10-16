import type { ProjectState, Snapshot } from '../shared/types.ts';

// 유휴는 Mac 알림에서는 빠지지만, 휴대폰 푸시는 ntfyStates 로 고를 수 있어 전환 자체는 여기서 만든다.
const ALERT_STATES: Partial<Record<ProjectState, string>> = { waiting: '입력 대기', idle: '유휴', stalled: '정지 의심', error: '오류' };
/** Mac 알림을 띄우는 상태 */
export const MAC_ALERT_STATES: ProjectState[] = ['waiting', 'stalled', 'error'];

export interface Alert {
  title: string;
  message: string;
  projectId: string;
  state: ProjectState;
}

/** 프로젝트별로 알림 판단에 필요한 기억. alertsFor 가 호출마다 갱신한다. */
export interface AlertMemory {
  state: ProjectState;
  /** 마지막으로 알린 상태 */
  alertedState: ProjectState | null;
  /** 마지막으로 알림 상태에 들어온 뒤 출력이 바뀐 tick 수 (Git 변화는 REALERT_ACTIVITY 로 친다) */
  activity: number;
  /** undefined 면 아직 못 본 것 (재시작 뒤 복원한 기억). 첫 값은 활동으로 치지 않는다 */
  lastOutputAt: string | null | undefined;
  lastGitAt: string | null | undefined;
  /** 상태별로 마지막 알림 시각과 그때의 Git 변화 시각 */
  lastAlert: Partial<Record<ProjectState, { at: string; git: string | null }>>;
}

/** 재시작해도 이어지게 저장하는 부분 */
export type SavedAlerts = Record<string, Pick<AlertMemory, 'state' | 'alertedState' | 'lastAlert'>>;

export const exportAlerts = (memory: Map<string, AlertMemory>): SavedAlerts => Object.fromEntries([...memory].map(([id, m]) => [id, { state: m.state, alertedState: m.alertedState, lastAlert: m.lastAlert }]));

export const restoreAlerts = (saved: SavedAlerts | undefined): Map<string, AlertMemory> =>
  new Map(Object.entries(saved ?? {}).map(([id, m]) => [id, { ...m, activity: 0, lastOutputAt: undefined, lastGitAt: undefined }]));

/**
 * 한 번 알린 상태로 되돌아왔을 때 다시 알리려면 그 사이에 이만큼의 활동이 있어야 한다.
 * 멈춘 세션도 화면 갱신 한 번으로 "정상"이 됐다가 30분 뒤 다시 "정지 의심"이 되는데, 그건 새 소식이 아니다.
 */
export const REALERT_ACTIVITY = 3;

/**
 * 정지 의심·오류는 한 번 알리면 이 시간 동안 Git 변화(커밋·파일 변경)가 없는 한 다시 알리지 않는다.
 * 화면 출력은 크기 바꾸기·시계·스피너로도 바뀌어 "실제로 돌았다"는 증거로 약하다.
 */
export const REALERT_COOLDOWN_MS = 3 * 60 * 60 * 1000;
const COOLDOWN_STATES: ProjectState[] = ['stalled', 'error'];

/**
 * 이전 상태와 비교해 새로 입력 대기·정지 의심·오류가 된 프로젝트의 알림을 만든다.
 * 처음 보는 프로젝트는 알리지 않는다 (시작 시 알림 폭주 방지). 같은 상태의 반복은 그 사이에 실제 활동이 있었을 때만 알린다.
 */
export function alertsFor(memory: Map<string, AlertMemory>, snapshot: Snapshot): Alert[] {
  const alerts: Alert[] = [];
  for (const p of snapshot.projects) {
    const { state } = p.status;
    const outputAt = p.tmux.lastOutputChangeAt;
    const gitAt = p.lastGitChangeAt;
    const m = memory.get(p.id);
    if (!m) {
      memory.set(p.id, { state, alertedState: null, activity: 0, lastOutputAt: outputAt, lastGitAt: gitAt, lastAlert: {} });
      continue;
    }
    if (m.lastOutputAt !== undefined && outputAt !== m.lastOutputAt) m.activity += 1;
    if (m.lastGitAt !== undefined && gitAt !== m.lastGitAt) m.activity += REALERT_ACTIVITY;
    m.lastOutputAt = outputAt;
    m.lastGitAt = gitAt;
    // 에이전트가 할 일을 마친 유휴는 "작업 끝남" 으로 알린다
    const label = state === 'idle' && p.tmux.agent === 'ready' ? '작업 끝남' : ALERT_STATES[state];
    if (m.state !== state && label) {
      const alert = { title: `NightShift · ${p.name}: ${label}`, message: p.status.reasons.join(', ') || label, projectId: p.id, state };
      // 유휴는 정지 의심으로 가는 길목이라 반복 판단에 끼우지 않는다 (기본으로는 보내지도 않는다).
      if (state === 'idle') alerts.push(alert);
      else {
        const last = m.lastAlert[state];
        const cooling = COOLDOWN_STATES.includes(state) && last !== undefined && last.git === gitAt && Date.parse(snapshot.generatedAt) - Date.parse(last.at) < REALERT_COOLDOWN_MS;
        if (!cooling && !(m.alertedState === state && m.activity < REALERT_ACTIVITY)) {
          alerts.push(alert);
          m.alertedState = state;
          m.lastAlert[state] = { at: snapshot.generatedAt, git: gitAt };
        }
        m.activity = 0;
      }
    }
    m.state = state;
  }
  for (const id of memory.keys()) if (!snapshot.projects.some((p) => p.id === id)) memory.delete(id);
  return alerts;
}
