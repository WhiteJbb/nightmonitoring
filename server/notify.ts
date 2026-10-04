import type { ProjectState, Snapshot } from '../shared/types.ts';

const ALERT_STATES: Partial<Record<ProjectState, string>> = { waiting: '입력 대기', stalled: '정지 의심', error: '오류' };

export interface Alert {
  title: string;
  message: string;
}

/**
 * 이전 상태와 비교해 새로 입력 대기·정지 의심·오류가 된 프로젝트의 알림을 만든다.
 * prev 는 호출마다 현재 상태로 갱신된다. 처음 보는 프로젝트는 알리지 않는다 (시작 시 알림 폭주 방지).
 */
export function alertsFor(prev: Map<string, ProjectState>, snapshot: Snapshot): Alert[] {
  const alerts: Alert[] = [];
  for (const p of snapshot.projects) {
    const before = prev.get(p.id);
    const label = ALERT_STATES[p.status.state];
    if (before !== undefined && before !== p.status.state && label) {
      alerts.push({ title: `NightShift · ${p.name}: ${label}`, message: p.status.reasons.join(', ') || label });
    }
    prev.set(p.id, p.status.state);
  }
  for (const id of prev.keys()) if (!snapshot.projects.some((p) => p.id === id)) prev.delete(id);
  return alerts;
}

const pad = (n: number) => String(n).padStart(2, '0');
export const localDate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/**
 * 자동 Morning Report 를 지금 만들어야 하는지.
 * 오늘의 예약 시각이 지났고, 오늘 아직 만들지 않았고, 서버가 그 시각 이전부터 돌고 있었을 때만 true
 * (예약 시각이 지난 뒤에 서버를 켰다면 다음 날까지 기다린다).
 */
export function autoReportDue(now: Date, time: string | null, lastDate: string | null, processStartedAt: Date): boolean {
  if (!time) return false;
  const [h = 0, m = 0] = time.split(':').map(Number);
  const due = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m);
  return now >= due && lastDate !== localDate(now) && processStartedAt < due;
}
