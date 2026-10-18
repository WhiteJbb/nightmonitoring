// npm run setup: 처음 설치할 때(그리고 git pull 로 업데이트한 뒤) 한 번 돌린다.
// 도구 확인 → 빌드 → Tailscale 로 휴대폰 접속 열기 → 로그인하면 자동으로 뜨게 등록 → 떴는지 확인.
// 다시 돌려도 된다. 이미 된 것은 그대로 두고 서버만 새 빌드로 다시 띄운다.
import { spawnSync } from 'node:child_process';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { isTailscaleAddress } from '../server/app.ts';
import { ConfigError, defaultConfigPath, loadConfig } from '../server/config.ts';
import { readRaw, writeRaw } from '../server/configEdit.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const LABEL = 'com.nightshift';
const mac = process.platform === 'darwin';

const step = (s: string) => console.log(`\n▸ ${s}`);
const warn = (s: string) => console.log(`  ! ${s}`);
const fail = (s: string): never => {
  console.error(`\n✗ ${s}`);
  process.exit(1);
};
// 셸을 거치지 않는다. quiet 는 결과만 보고, show 는 진행 과정을 화면에 그대로 보여 준다.
const quiet = (bin: string, args: string[]) => spawnSync(bin, args, { encoding: 'utf8' });
const works = (bin: string, args: string[]) => quiet(bin, args).status === 0;
const show = (bin: string, args: string[]) => spawnSync(bin, args, { stdio: 'inherit' }).status === 0;

/** tailscale serve status --json 에서 이 기기의 https(443)가 중계하는 곳. 443 이 비어 있으면 null. */
export function serveTarget(json: string, name: string): string | null {
  let s;
  try {
    s = JSON.parse(json || '{}');
  } catch {
    return null;
  }
  if (!s?.TCP?.['443']) return null;
  return s.Web?.[`${name}:443`]?.Handlers?.['/']?.Proxy ?? '다른 용도';
}

/** tailscale serve 가 중계할 주소. 정할 수 없는 바인딩(LAN 주소, localhost)이면 null. */
export function serveUpstream(host: string, port: number): string | null {
  if (host === '::1') return `http://[::1]:${port}`;
  if (host.startsWith('127.')) return `http://${host}:${port}`;
  // Tailscale 주소에 바인딩해도 https 이름(allowedHosts)을 적으면 127.0.0.1 에서도 받는다 (server/index.ts)
  if (['0.0.0.0', '::'].includes(host) || isTailscaleAddress(host)) return `http://127.0.0.1:${port}`;
  return null; // localhost 는 node 가 ::1 로 받을 수도 있어 어디로 중계할지 정할 수 없다
}

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

export function plistText(node: string, root: string, env: Record<string, string>): string {
  const log = xml(path.join(root, '.nightshift/server.log'));
  const vars = Object.entries(env).map(([k, v]) => `    <key>${k}</key><string>${xml(v)}</string>`);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(node)}</string>
    <string>server/index.ts</string>
  </array>
  <key>WorkingDirectory</key><string>${xml(root)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${vars.join('\n')}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${log}</string>
  <key>StandardErrorPath</key><string>${log}</string>
</dict>
</plist>
`;
}

export function unitText(node: string, root: string, env: Record<string, string>): string {
  const vars = Object.entries(env).map(([k, v]) => `Environment="${k}=${v}"`);
  return `[Unit]
Description=NightShift

[Service]
WorkingDirectory=${root}
ExecStart="${node}" server/index.ts
${vars.join('\n')}
Restart=always
# NightShift 가 띄운 tmux 서버(와 그 안의 에이전트)는 서비스를 다시 띄워도 살려 둔다
KillMode=process

[Install]
WantedBy=default.target
`;
}

function tools() {
  const missing = (['git', 'tmux'] as const).filter((b) => !works(b, [b === 'tmux' ? '-V' : '--version']));
  if (!missing.length) return;
  const names = missing.join(', ');
  if (works('brew', ['--version'])) {
    step(`${names} 설치 (Homebrew)`);
    if (show('brew', ['install', ...missing])) return;
  } else if (!mac && works('apt-get', ['--version'])) {
    step(`${names} 설치 (apt, 비밀번호를 물을 수 있습니다)`);
    const install = ['sh', '-c', `apt-get update && apt-get install -y ${missing.join(' ')}`];
    const [bin, ...args] = process.getuid?.() === 0 ? install : ['sudo', ...install];
    if (show(bin!, args)) return;
  }
  fail(`${names} 이(가) 필요합니다. ${mac ? 'Homebrew(https://brew.sh)를 설치한 뒤 다시 실행하세요.' : '패키지 관리자로 설치한 뒤 다시 실행하세요.'}`);
}

function tailscaleBin(): string | null {
  return ['tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale'].find((b) => works(b, ['version'])) ?? null;
}

/** 휴대폰에서 열 https 이름(<기기>.<tailnet>.ts.net). 열 수 없으면 이유를 말하고 null. */
function tailscale(target: string | null): string | null {
  step('휴대폰 접속 (Tailscale)');
  if (!target) {
    warn('config 의 host 로는 Tailscale 이 어디로 중계할지 정할 수 없어 건너뜁니다. host 를 지우거나(127.0.0.1) Tailscale 주소로 바꾼 뒤 다시 실행하세요.');
    return null;
  }
  const ts = tailscaleBin();
  if (!ts) {
    warn('Tailscale 이 없어 건너뜁니다. 휴대폰에서 보려면 https://tailscale.com/download 에서 이 컴퓨터와 휴대폰에 깔고 같은 계정으로 로그인한 뒤 다시 실행하세요.');
    return null;
  }
  const st = quiet(ts, ['status', '--json']);
  let self: { BackendState?: string; Self?: { DNSName?: string } } = {};
  try {
    self = JSON.parse(st.stdout);
  } catch {
    // 꺼져 있으면 JSON 이 아닌 안내문이 온다
  }
  const name = self.BackendState === 'Running' ? (self.Self?.DNSName ?? '').replace(/\.$/, '').toLowerCase() : '';
  if (!name) {
    warn('Tailscale 이 꺼져 있거나 로그인되어 있지 않아 건너뜁니다. 켜고 로그인한 뒤 다시 실행하세요.');
    return null;
  }
  const current = serveTarget(quiet(ts, ['serve', 'status', '--json']).stdout, name);
  if (current === target) {
    console.log(`  https://${name} → ${target} (이미 열려 있음)`);
    return name;
  }
  if (current) {
    warn(`https://${name} 은(는) 이미 ${current} 에 쓰이고 있어 건드리지 않습니다. 직접 정리한 뒤 다시 실행하세요 (tailscale serve status).`);
    return null;
  }
  // 처음이면 tailnet 에 https 를 켜라는 주소가 나오고, 켤 때까지 기다린다
  if (!show(ts, ['serve', '--bg', '--https=443', target])) {
    warn(mac ? 'tailscale serve 에 실패했습니다. 위 메시지를 확인하세요.' : 'tailscale serve 에 실패했습니다. 권한 문제라면 `sudo tailscale set --operator=$USER` 를 한 번 실행한 뒤 다시 실행하세요.');
    return null;
  }
  return name;
}

/** 주소가 비었는지. 다른 프로그램(직접 npm start 로 띄운 서버 등)이 쓰고 있으면 false. */
const portFree = (host: string, port: number) =>
  new Promise<boolean>((resolve) => {
    const srv = net.createServer();
    srv.once('error', (e: NodeJS.ErrnoException) => resolve(e.code !== 'EADDRINUSE'));
    srv.listen(port, host, () => srv.close(() => resolve(true)));
  });

async function waitFree(host: string, port: number) {
  for (let i = 0; i < 20; i++) {
    if (await portFree(host, port)) return;
    await sleep(250);
  }
  fail(`${host}:${port} 를 다른 프로그램이 쓰고 있습니다. 직접 띄운 NightShift(npm start)라면 끄고 다시 실행하세요.`);
}

/** 서비스가 쓸 node: PATH 의 것(Homebrew 는 버전이 바뀌어도 그대로인 /opt/homebrew/bin/node). */
const nodePath = () => quiet('sh', ['-c', 'command -v node']).stdout.trim() || process.execPath;

/** 서비스 환경. launchd·systemd 는 셸의 PATH 를 모르므로 지금 PATH 를 넘긴다 (git·tmux·claude·codex 를 찾게). */
function serviceEnv(node: string, configPath: string): Record<string, string> {
  const dirs = (process.env.PATH ?? '').split(':').filter((d) => d && !d.includes('node_modules'));
  const PATH = [...new Set([path.dirname(node), ...dirs, '/usr/local/bin', '/usr/bin', '/bin'])].join(':');
  // tmux 서버가 없을 때 NightShift 가 띄우면 그 안의 셸이 이 값을 물려받는다 (한글 입력)
  return { PATH, LANG: process.env.LANG || 'C.UTF-8', ...(process.env.NIGHTSHIFT_CONFIG ? { NIGHTSHIFT_CONFIG: configPath } : {}) };
}

/** 서비스를 등록하고 다시 띄운다. 끄고 켜는 방법을 돌려준다. 자동 시작을 못 하면 null. */
async function service(host: string, port: number, configPath: string): Promise<string[] | null> {
  step('자동 시작 등록');
  const node = nodePath();
  const env = serviceEnv(node, configPath);
  mkdirSync(path.join(ROOT, '.nightshift'), { recursive: true });

  if (mac) {
    const domain = `gui/${os.userInfo().uid}`;
    const plist = path.join(os.homedir(), 'Library/LaunchAgents', `${LABEL}.plist`);
    mkdirSync(path.dirname(plist), { recursive: true });
    writeFileSync(plist, plistText(node, ROOT, env));
    quiet('launchctl', ['bootout', `${domain}/${LABEL}`]); // 처음이면 등록된 게 없어 실패한다
    await waitFree(host, port);
    // 내린 직후에는 잠깐 다시 올리지 못할 때가 있다 (Bootstrap failed: 5)
    for (let i = 0; !works('launchctl', ['bootstrap', domain, plist]); i++) {
      if (i === 10) fail(`launchd 등록에 실패했습니다: launchctl bootstrap ${domain} ${plist}`);
      await sleep(500);
    }
    console.log(`  ${plist}`);
    return [`tail -f .nightshift/server.log`, `launchctl kickstart -k ${domain}/${LABEL}`, `launchctl bootout ${domain}/${LABEL}`];
  }

  if (process.platform === 'linux' && works('systemctl', ['--user', 'show-environment'])) {
    const unit = path.join(os.homedir(), '.config/systemd/user/nightshift.service');
    mkdirSync(path.dirname(unit), { recursive: true });
    writeFileSync(unit, unitText(node, ROOT, env));
    // 멈추기 전에 새 unit 을 읽힌다: 옛 unit(KillMode 없음)으로 멈추면 NightShift 가 띄운 tmux 까지 죽는다
    if (!show('systemctl', ['--user', 'daemon-reload'])) fail('systemctl --user daemon-reload 에 실패했습니다');
    quiet('systemctl', ['--user', 'stop', 'nightshift']);
    await waitFree(host, port);
    if (!show('systemctl', ['--user', 'enable', '--now', 'nightshift'])) fail('systemd 등록에 실패했습니다');
    console.log(`  ${unit}`);
    // 로그아웃해도(라즈베리파이를 화면 없이 켜 둬도) 돌게 한다
    if (!quiet('loginctl', ['show-user', os.userInfo().username, '--property=Linger']).stdout.includes('yes') && !works('loginctl', ['enable-linger'])) {
      warn('로그아웃하면 서버도 멈춥니다. 계속 돌게 하려면: sudo loginctl enable-linger $USER');
    }
    return ['journalctl --user -u nightshift -f', 'systemctl --user restart nightshift', 'systemctl --user disable --now nightshift'];
  }

  warn('systemd 가 없어 자동 시작은 건너뜁니다 (WSL 은 /etc/wsl.conf 에 systemd=true 를 넣고 wsl --shutdown 뒤 다시). 지금은 npm start 로 띄우세요.');
  return null;
}

async function up(url: string): Promise<boolean> {
  for (let i = 0; i < 40; i++) {
    if (await fetch(url).then((r) => r.ok, () => false)) return true;
    await sleep(250);
  }
  return false;
}

async function main() {
  console.log('NightShift 설치');
  tools();

  step('빌드');
  if (!show('npm', ['run', 'build'])) fail('빌드에 실패했습니다');

  // 서버와 같은 규칙: NIGHTSHIFT_CONFIG 가 있으면 그 파일 (서비스에도 넘긴다)
  const configPath = path.resolve(ROOT, process.env.NIGHTSHIFT_CONFIG ?? defaultConfigPath(path.join(ROOT, 'config')));
  const load = () => {
    try {
      return loadConfig(configPath, ROOT).config;
    } catch (e) {
      return fail(e instanceof ConfigError ? e.message : String(e));
    }
  };
  let config = load();

  const name = tailscale(serveUpstream(config.host, config.port));
  if (name && !config.allowedHosts.includes(name)) {
    // tailscale serve 로 들어오는 이름을 받게 한다 (안 적으면 DNS rebinding 방어로 거부)
    const raw = readRaw(configPath);
    writeRaw(configPath, raw, { ...raw, allowedHosts: [...(Array.isArray(raw.allowedHosts) ? raw.allowedHosts : []), name] });
    console.log(`  ${path.relative(ROOT, configPath)} 의 allowedHosts 에 ${name} 추가`);
    config = load();
  }

  const host = ['0.0.0.0', '::'].includes(config.host) ? '127.0.0.1' : config.host;
  const local = `http://${host.includes(':') ? `[${host}]` : host}:${config.port}`;
  const commands = await service(host, config.port, configPath);

  if (commands) {
    step('확인');
    if (!(await up(`${local}/api/snapshot`))) fail(`서버가 뜨지 않았습니다. 로그를 보세요: ${commands[0]}`);
  }

  console.log(`\n✓ 준비됐습니다\n`);
  console.log(`  이 컴퓨터   ${local}`);
  if (name) console.log(`  휴대폰      https://${name}  (휴대폰 Tailscale 앱을 같은 계정으로 켠 채로)`);
  if (commands) {
    const [logs, restart, stop] = commands;
    console.log(`\n  로그        ${logs}\n  재시작      ${restart}\n  끄기        ${stop}`);
  }
  console.log(`  업데이트    git pull && npm run setup`);
  if (mac) {
    // launchd 로 띄운 node 는 터미널의 권한을 물려받지 못한다
    console.log(`\n  다운로드·문서·데스크탑 폴더의 저장소를 보려면: 시스템 설정 → 개인정보 보호 및 보안 → 전체 디스크 접근 권한 → + → ⌘⇧G 로\n  ${realpathSync(nodePath())} 를 추가하세요 (node 를 업그레이드하면 다시).`);
  }
  console.log(`\n  처음이라면: 브라우저로 열고 돌고 있는 tmux 세션을 등록하거나 "+ tmux 세션 만들기"로 시작하세요.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
