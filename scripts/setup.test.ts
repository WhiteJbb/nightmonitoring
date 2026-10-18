import { describe, expect, it } from 'vitest';
import { FUNNEL, plistText, relayHost, serveTarget, unitText } from './setup.ts';

describe('serveTarget', () => {
  const name = 'mac.tail1.ts.net';
  const status = (proxy: string) => JSON.stringify({ TCP: { 443: { HTTPS: true } }, Web: { [`${name}:443`]: { Handlers: { '/': { Proxy: proxy } } } } });

  it('443 이 비어 있으면 null', () => {
    expect(serveTarget('{}', name)).toBeNull();
    expect(serveTarget('', name)).toBeNull();
  });
  it('같은 곳을 가리켜도 Funnel 로 공개 중이면 받아들이지 않는다', () => {
    const funnel = { ...JSON.parse(status('http://127.0.0.1:4477')), AllowFunnel: { [`${name}:443`]: true } };
    expect(serveTarget(JSON.stringify(funnel), name)).toBe(FUNNEL);
  });
  it('읽을 수 없으면 비었다고 보지 않는다 (덮어쓰지 않게)', () => {
    expect(serveTarget('No serve config', name)).not.toBeNull();
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

it('tailscale serve 는 서버가 받는 로컬 주소로 중계한다', () => {
  expect(relayHost('127.0.0.1')).toBe('127.0.0.1');
  expect(relayHost('127.0.0.2')).toBe('127.0.0.2');
  expect(relayHost('::1')).toBe('::1');
  expect(relayHost('100.94.187.77')).toBe('127.0.0.1');
  expect(relayHost('192.168.0.10')).toBeNull();
  expect(relayHost('localhost')).toBeNull();
});

it('systemd 가 서비스를 다시 띄울 때 NightShift 가 띄운 tmux 까지 죽이지 않는다', () => {
  expect(unitText('/usr/bin/node', '/home/u/nightshift', { PATH: '/bin' })).toContain('KillMode=process');
});

it('systemd unit 의 경로·환경 값은 % 와 따옴표를 이스케이프한다', () => {
  const text = unitText('/opt/my "node"/node', '/home/u/release%n', { PATH: '/a%b:/c\\d' });
  expect(text).toContain('WorkingDirectory=/home/u/release%%n\n');
  expect(text).toContain('ExecStart="/opt/my \\"node\\"/node" server/index.ts');
  expect(text).toContain('Environment="PATH=/a%%b:/c\\\\d"');
});
