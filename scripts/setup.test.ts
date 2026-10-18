import { describe, expect, it } from 'vitest';
import { plistText, serveTarget } from './setup.ts';

describe('serveTarget', () => {
  const name = 'mac.tail1.ts.net';
  const status = (proxy: string) => JSON.stringify({ TCP: { 443: { HTTPS: true } }, Web: { [`${name}:443`]: { Handlers: { '/': { Proxy: proxy } } } } });

  it('443 이 비어 있으면 null', () => {
    expect(serveTarget('{}', name)).toBeNull();
    expect(serveTarget('', name)).toBeNull();
  });
  it('443 이 중계하는 곳', () => {
    expect(serveTarget(status('http://127.0.0.1:4477'), name)).toBe('http://127.0.0.1:4477');
  });
  it('443 을 다른 방식(TCP 전달 등)으로 쓰면 비어 있지 않다고 본다', () => {
    expect(serveTarget(JSON.stringify({ TCP: { 443: { TCPForward: '127.0.0.1:22' } } }), name)).toBe('다른 용도');
  });
});

it('plist 에 넣는 경로는 XML 로 이스케이프한다', () => {
  const text = plistText('/opt/node', '/Users/me/A&B <x>', { PATH: '/bin' });
  expect(text).toContain('<string>/Users/me/A&amp;B &lt;x></string>');
  expect(text).not.toContain('A&B');
});
