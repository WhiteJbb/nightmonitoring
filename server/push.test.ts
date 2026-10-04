import { describe, expect, it, vi } from 'vitest';
import { parseConfig } from './config.ts';
import { parseNtfyUrl, sendNtfy } from './push.ts';

describe('parseNtfyUrl', () => {
  it('splits server and topic', () => {
    expect(parseNtfyUrl('https://ntfy.sh/my-topic_1')).toEqual({ server: 'https://ntfy.sh', topic: 'my-topic_1' });
    expect(parseNtfyUrl('http://100.94.1.2:8080/sub/alerts')).toEqual({ server: 'http://100.94.1.2:8080/sub', topic: 'alerts' });
  });

  it('rejects anything that is not an http(s) url with a plain topic', () => {
    for (const url of ['ntfy.sh/topic', 'https://ntfy.sh', 'https://ntfy.sh/', 'ftp://ntfy.sh/t', 'https://ntfy.sh/한글', 'https://ntfy.sh/a b', `https://ntfy.sh/${'x'.repeat(65)}`]) {
      expect(parseNtfyUrl(url)).toBeNull();
    }
  });
});

describe('sendNtfy', () => {
  it('posts JSON with the topic, text, priority and click url', async () => {
    const fetchFn = vi.fn(async () => new Response('{}', { status: 200 }));
    expect(await sendNtfy('https://ntfy.sh/topic', { title: 'NightShift · 앱: 정지 의심', message: '30분 동안 출력·Git 변화 없음', state: 'stalled', click: 'http://100.1.2.3:4477/#/project/app' }, fetchFn)).toBeNull();
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://ntfy.sh');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ topic: 'topic', title: 'NightShift · 앱: 정지 의심', message: '30분 동안 출력·Git 변화 없음', priority: 4, click: 'http://100.1.2.3:4477/#/project/app' });
  });

  it('uses normal priority for waiting and omits click when there is none', async () => {
    const fetchFn = vi.fn(async () => new Response('{}', { status: 200 }));
    await sendNtfy('https://ntfy.sh/topic', { title: 't', message: 'm', state: 'waiting' }, fetchFn);
    const body = JSON.parse((fetchFn.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body).toEqual({ topic: 'topic', title: 't', message: 'm', priority: 3 });
  });

  it('returns an error message instead of throwing', async () => {
    expect(await sendNtfy('not a url', { title: 't', message: 'm' })).toBe('ntfy 주소가 올바르지 않습니다');
    expect(await sendNtfy('https://ntfy.sh/t', { title: 't', message: 'm' }, vi.fn(async () => new Response('', { status: 429 })))).toBe('ntfy 서버가 429 로 응답했습니다');
    expect(await sendNtfy('https://ntfy.sh/t', { title: 't', message: 'm' }, vi.fn(async () => Promise.reject(new Error('offline'))))).toBe('ntfy 전송 실패: offline');
  });
});

describe('ntfy config', () => {
  it('is off by default and validates the url and states', () => {
    expect(parseConfig({}, '/base')).toMatchObject({ ntfyUrl: null, ntfyStates: ['waiting', 'stalled', 'error'] });
    expect(parseConfig({ ntfyUrl: 'https://ntfy.sh/abc', ntfyStates: ['stalled'] }, '/base')).toMatchObject({ ntfyUrl: 'https://ntfy.sh/abc', ntfyStates: ['stalled'] });
    expect(() => parseConfig({ ntfyUrl: 'ntfy.sh/abc' }, '/base')).toThrow(/ntfyUrl/);
    expect(() => parseConfig({ ntfyStates: ['running'] }, '/base')).toThrow(/ntfyStates/);
  });
});
