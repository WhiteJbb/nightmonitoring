import type { Report, ReportMeta, RunKind, Snapshot } from '../../shared/types.ts';

async function req<T>(url: string, method: 'GET' | 'POST' | 'DELETE' = 'GET'): Promise<T> {
  const res = await fetch(url, { method });
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = (body as { error?: unknown } | null)?.error;
    throw new Error(typeof msg === 'string' ? msg : `HTTP ${res.status}`);
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
};
