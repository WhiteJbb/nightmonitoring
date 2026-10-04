// 휴대폰 푸시 (ntfy). 설정에 주소를 적었을 때만 밖으로 요청을 보낸다.
import type { ProjectState } from '../shared/types.ts';

export interface PushMessage {
  title: string;
  message: string;
  /** 알림을 눌렀을 때 열 주소 */
  click?: string;
  state?: ProjectState;
}

/** "https://ntfy.sh/my-topic" → 서버 주소와 주제. 형식이 아니면 null. */
export function parseNtfyUrl(url: string): { server: string; topic: string } | null {
  const u = URL.parse(url);
  if (!u || (u.protocol !== 'https:' && u.protocol !== 'http:')) return null;
  const segments = u.pathname.split('/').filter(Boolean);
  const topic = segments.pop();
  if (!topic || !/^[A-Za-z0-9_-]{1,64}$/.test(topic)) return null;
  return { server: `${u.origin}${segments.length ? `/${segments.join('/')}` : ''}`, topic };
}

const PRIORITY: Partial<Record<ProjectState, number>> = { error: 4, stalled: 4, waiting: 3 };

/**
 * ntfy 로 알림 하나를 보낸다. 제목·본문에 한글이 들어가므로 헤더 대신 JSON 본문으로 보낸다.
 * 실패해도 throw 하지 않고 오류 메시지를 돌려준다 (알림 실패가 감시를 멈추면 안 된다).
 */
export async function sendNtfy(url: string, msg: PushMessage, fetchFn: typeof fetch = fetch): Promise<string | null> {
  const target = parseNtfyUrl(url);
  if (!target) return 'ntfy 주소가 올바르지 않습니다';
  try {
    const res = await fetchFn(target.server, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        topic: target.topic,
        title: msg.title,
        message: msg.message,
        priority: (msg.state && PRIORITY[msg.state]) ?? 3,
        ...(msg.click ? { click: msg.click } : {}),
      }),
      signal: AbortSignal.timeout(10_000),
    });
    return res.ok ? null : `ntfy 서버가 ${res.status} 로 응답했습니다`;
  } catch (e) {
    return `ntfy 전송 실패: ${(e as Error).message}`;
  }
}
