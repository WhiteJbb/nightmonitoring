import type { ConfigUpdate, ConfigView, Report, ReportMeta, RunKind, Snapshot } from '../../shared/types.ts';

/** 서버가 돌려준 오류. 검증 실패(400)면 issues 에 항목별 메시지가 들어 있다. */
export class ApiError extends Error {
  issues: string[];
  constructor(message: string, issues: string[] = []) {
    super(message);
    this.issues = issues;
  }
}

async function req<T>(url: string, method: 'GET' | 'POST' | 'PUT' | 'DELETE' = 'GET', json?: unknown): Promise<T> {
  const res = await fetch(
    url,
    json === undefined ? { method } : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(json) },
  );
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const { error, issues } = (body ?? {}) as { error?: unknown; issues?: unknown };
    throw new ApiError(
      typeof error === 'string' ? error : `HTTP ${res.status}`,
      Array.isArray(issues) ? issues.filter((i) => typeof i === 'string') : [],
    );
  }
  if (body === null) throw new Error('서버 응답을 해석할 수 없습니다');
  return body as T;
}

export const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export const api = {
  snapshot: () => req<Snapshot>('/api/snapshot'),
  run: (id: string, kind: RunKind) =>
    req<{ ok: true }>(`/api/projects/${encodeURIComponent(id)}/run/${kind}`, 'POST'),
  cancelRun: (id: string, kind: RunKind) =>
    req<{ ok: true }>(`/api/projects/${encodeURIComponent(id)}/run/${kind}`, 'DELETE'),
  ackErrors: (id: string) => req<{ ok: true }>(`/api/projects/${encodeURIComponent(id)}/ack-errors`, 'POST'),
  resetSession: () => req<{ ok: true }>('/api/session/reset', 'POST'),
  reports: () => req<ReportMeta[]>('/api/reports'),
  report: (name: string) => req<Report>(`/api/reports/${encodeURIComponent(name)}`),
  generateReport: () => req<Report>('/api/reports', 'POST'),
  config: () => req<ConfigView>('/api/config'),
  saveConfig: (update: ConfigUpdate) => req<ConfigView>('/api/config', 'PUT', update),
};
