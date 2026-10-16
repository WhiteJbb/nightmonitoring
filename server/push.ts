// 휴대폰 푸시 (ntfy). 설정에 주소를 적었을 때만 밖으로 요청을 보낸다.
import { setTimeout as sleep } from 'node:timers/promises';
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

/** 실패한 알림을 다시 보내기까지 기다리는 시간. 이만큼 해도 안 되면 버린다 */
export const RETRY_DELAYS_MS = [30_000, 2 * 60_000, 10 * 60_000];
/** 재시도를 기다리는 알림의 최대 개수. 넘치면 새 실패는 바로 버린다 (ntfy 가 오래 죽어 있어도 쌓이지 않게) */
export const MAX_PENDING_RETRIES = 20;
let pendingRetries = 0;

/** send 가 실패하면 RETRY_DELAYS_MS 간격으로 다시 시도한다. 끝내 실패하면 마지막 오류 메시지. */
export async function withRetry(send: () => Promise<string | null>, wait = (ms: number) => sleep(ms, undefined, { ref: false })): Promise<string | null> {
  let error = await send();
  for (const ms of RETRY_DELAYS_MS) {
    if (!error || pendingRetries >= MAX_PENDING_RETRIES) break;
    pendingRetries += 1;
    try {
      await wait(ms);
    } finally {
      pendingRetries -= 1;
    }
    error = await send();
  }
  return error;
}
