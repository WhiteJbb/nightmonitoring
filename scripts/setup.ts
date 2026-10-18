// npm run setup: 처음 설치할 때(그리고 git pull 로 업데이트한 뒤) 한 번 돌린다.
// 도구 확인 → 빌드 → Tailscale 로 휴대폰 접속 열기 → 로그인하면 자동으로 뜨게 등록 → 떴는지 확인.
// 다시 돌려도 된다. 이미 된 것은 그대로 두고 서버만 새 빌드로 다시 띄운다.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { isTailscaleAddress } from '../server/app.ts';
import { ConfigError, defaultConfigPath, loadConfig } from '../server/config.ts';
import { readRaw, writeRaw } from '../server/configEdit.ts';

export const ROOT = path.resolve(import.meta.dirname, '..');
const LABEL = 'com.nightshift';
const mac = process.platform === 'darwin';
const domain = `gui/${os.userInfo().uid}`;
const PLIST = path.join(os.homedir(), 'Library/LaunchAgents', `${LABEL}.plist`);
const UNIT = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'systemd/user/nightshift.service');

/** setup 이 등록한 서비스를 다루는 명령 (nightshift 명령과 setup 의 안내가 같이 쓴다). stop 은 다음 로그인·부팅 때 다시 뜬다. */
export const SERVICE = mac
  ? {
      file: PLIST,
      start: ['launchctl', 'bootstrap', domain, PLIST],
      stop: ['launchctl', 'bootout', `${domain}/${LABEL}`],
      restart: ['launchctl', 'kickstart', '-k', `${domain}/${LABEL}`],
      logs: ['tail', '-n', '50', '-f', path.join(ROOT, '.nightshift/server.log')],
    }
  : {
      file: UNIT,
      start: ['systemctl', '--user', 'start', 'nightshift'],
      stop: ['systemctl', '--user', 'stop', 'nightshift'],
      restart: ['systemctl', '--user', 'restart', 'nightshift'],
      logs: ['journalctl', '--user', '-u', 'nightshift', '-n', '50', '-f'],
    };

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

export const FUNNEL = 'tailscale funnel 로 인터넷에 공개 중';

/** tailscale serve status --json 에서 이 기기의 https(443)가 중계하는 곳. 443 이 비어 있으면 null. */
export function serveTarget(json: string, name: string): string | null {
  let s;
  try {
    s = JSON.parse(json || '{}');
  } catch {
    return '읽을 수 없는 설정'; // 비었다고 보고 덮어쓰지 않는다
  }
  if (!s?.TCP?.['443']) return null;
  // 인증 없는 대시보드가 인터넷에 열린다: 같은 곳을 가리켜도 받아들이지 않는다
  if (s.AllowFunnel?.[`${name}:443`]) return FUNNEL;
  return s.Web?.[`${name}:443`]?.Handlers?.['/']?.Proxy ?? '다른 용도';
}

/** tailscale serve 가 중계할 로컬 주소. 정할 수 없는 바인딩(LAN 주소, localhost)이면 null. */
export function relayHost(host: string): string | null {
  if (host === '::1' || host.startsWith('127.')) return host;
  // Tailscale 주소에 바인딩해도 https 이름(allowedHosts)을 적으면 127.0.0.1 에서도 받는다 (server/index.ts)
  if (['0.0.0.0', '::'].includes(host) || isTailscaleAddress(host)) return '127.0.0.1';
  return null; // localhost 는 node 가 ::1 로 받을 수도 있어 어디로 중계할지 정할 수 없다
}

export const urlOf = (host: string, port: number) => `http://${host.includes(':') ? `[${host}]` : host}:${port}`;

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

// systemd 는 % 를 지정자(%n 등)로 풀고, 따옴표 안에서는 \ 와 " 를 이스케이프로 읽는다
const sd = (s: string) => s.replace(/%/g, '%%');
const sdQuoted = (s: string) => `"${sd(s).replace(/[\\"]/g, '\\$&')}"`;

export function unitText(node: string, root: string, env: Record<string, string>): string {
  const vars = Object.entries(env).map(([k, v]) => `Environment=${sdQuoted(`${k}=${v}`)}`);
  return `[Unit]
Description=NightShift

[Service]
WorkingDirectory=${sd(root)}
ExecStart=${sdQuoted(node)} server/index.ts
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
  const status = quiet(ts, ['serve', 'status', '--json']);
  if (status.status !== 0) {
    warn(`tailscale serve status 를 읽지 못해 건너뜁니다: ${status.stderr.trim()}`);
    return null;
  }
  const current = serveTarget(status.stdout, name);
  if (current === FUNNEL) fail(`https://${name} 이(가) tailscale funnel 로 인터넷에 공개되어 있습니다. NightShift 는 인증이 없어 공개하면 안 됩니다: tailscale funnel --https=443 off 로 끈 뒤 다시 실행하세요.`);
  if (current === target) {
    console.log(`  https://${name} → ${target} (이미 열려 있음)`);
    return name;
  }
  if (current) {
    warn(`https://${name} 의 443 은 이미 다른 데 쓰이고 있어 건드리지 않습니다 (${current}). 직접 정리한 뒤 다시 실행하세요 (tailscale serve status).`);
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

/**
 * 서비스가 쓸 node: PATH 의 것(Homebrew 는 버전이 바뀌어도 그대로인 /opt/homebrew/bin/node).
 * fnm 은 셸마다 임시 링크(/run/user/…/fnm_multishells)를 주는데 재부팅하면 사라지므로 실제 파일을 쓴다.
 */
function nodePath(): string {
  const found = quiet('sh', ['-c', 'command -v node']).stdout.trim();
  return found && !/fnm_multishells|^\/run\//.test(found) ? found : process.execPath;
}

/** 서비스 환경. launchd·systemd 는 셸의 PATH 를 모르므로 지금 PATH 를 넘긴다 (git·tmux·claude·codex 를 찾게). */
function serviceEnv(node: string, configPath: string): Record<string, string> {
  const dirs = (process.env.PATH ?? '').split(':').filter((d) => d && !d.includes('node_modules'));
  const PATH = [...new Set([path.dirname(node), ...dirs, '/usr/local/bin', '/usr/bin', '/bin'])].join(':');
  // tmux 서버가 없을 때 NightShift 가 띄우면 그 안의 셸이 이 값을 물려받는다 (한글 입력)
  return { PATH, LANG: process.env.LANG || 'C.UTF-8', ...(process.env.NIGHTSHIFT_CONFIG ? { NIGHTSHIFT_CONFIG: configPath } : {}) };
}

/** 서비스를 등록하고 다시 띄운다. 자동 시작을 못 하면 false. */
async function service(host: string, port: number, configPath: string): Promise<boolean> {
  step('자동 시작 등록');
  const node = nodePath();
  const env = serviceEnv(node, configPath);
  mkdirSync(path.join(ROOT, '.nightshift'), { recursive: true });

  if (mac) {
    mkdirSync(path.dirname(PLIST), { recursive: true });
    writeFileSync(PLIST, plistText(node, ROOT, env));
    quiet(SERVICE.stop[0]!, SERVICE.stop.slice(1)); // 처음이면 등록된 게 없어 실패한다
    await waitFree(host, port);
    // 내린 직후에는 잠깐 다시 올리지 못할 때가 있다 (Bootstrap failed: 5)
    for (let i = 0; !works(SERVICE.start[0]!, SERVICE.start.slice(1)); i++) {
      if (i === 10) fail(`launchd 등록에 실패했습니다: ${SERVICE.start.join(' ')}`);
      await sleep(500);
    }
    console.log(`  ${PLIST}`);
    return true;
  }

  const userBus = process.platform === 'linux' && works('systemctl', ['--user', 'show-environment']);
  if (process.platform === 'linux' && existsSync('/run/systemd/system') && !userBus) {
    fail('사용자 systemd 에 연결할 수 없습니다. 이 사용자로 직접 로그인한 터미널(ssh 등)에서 다시 실행하세요 (sudo, sudo -u 로는 안 됩니다).');
  }
  if (userBus) {
    mkdirSync(path.dirname(UNIT), { recursive: true });
    writeFileSync(UNIT, unitText(node, ROOT, env));
    // 멈추기 전에 새 unit 을 읽힌다: 옛 unit(KillMode 없음)으로 멈추면 NightShift 가 띄운 tmux 까지 죽는다
    if (!show('systemctl', ['--user', 'daemon-reload'])) fail('systemctl --user daemon-reload 에 실패했습니다');
    quiet(SERVICE.stop[0]!, SERVICE.stop.slice(1));
    await waitFree(host, port);
    if (!show('systemctl', ['--user', 'enable', '--now', 'nightshift'])) fail('systemd 등록에 실패했습니다');
    console.log(`  ${UNIT}`);
    // 로그아웃해도(라즈베리파이를 화면 없이 켜 둬도) 돌게 한다
    if (!quiet('loginctl', ['show-user', os.userInfo().username, '--property=Linger']).stdout.includes('yes') && !works('loginctl', ['enable-linger'])) {
      warn('로그아웃하면 서버도 멈춥니다. 계속 돌게 하려면: sudo loginctl enable-linger $USER');
    }
    return true;
  }

  warn('systemd 가 없어 자동 시작은 건너뜁니다 (WSL 은 /etc/wsl.conf 에 systemd=true 를 넣고 wsl --shutdown 뒤 다시). 지금은 npm start 로 띄우세요.');
  return false;
}

const CLI = path.join(ROOT, 'scripts/nightshift.ts');

/** nightshift 명령을 PATH 에 건다 (npm link). 다른 프로그램이 그 이름을 쓰고 있으면 건드리지 않는다. */
function link(): boolean {
  step('nightshift 명령');
  const which = () => quiet('sh', ['-c', 'command -v nightshift']).stdout.trim();
  const found = which();
  if (found && realpathSync(found) === realpathSync(CLI)) {
    console.log(`  ${found}`);
    return true;
  }
  // 다른 폴더에 받아 둔 NightShift 면 이 폴더로 옮겨 건다
  if (found && !realpathSync(found).endsWith(path.join('scripts', 'nightshift.ts'))) {
    warn(`이미 다른 프로그램이 nightshift 라는 이름을 쓰고 있어 건너뜁니다: ${found}`);
    return false;
  }
  const env = { ...process.env };
  delete env.npm_config_allow_scripts; // npm 12: npm run 이 넘긴 이 값이 있으면 npm 이 거부한다
  if (spawnSync('npm', ['link'], { cwd: ROOT, stdio: 'inherit', env }).status !== 0) {
    warn('npm link 에 실패했습니다. 전역 폴더에 쓸 권한이 없으면 sudo npm link 를 실행하세요.');
    return false;
  }
  if (!which()) {
    warn(`nightshift 를 걸었지만 PATH 에 없습니다. ${quiet('npm', ['prefix', '-g']).stdout.trim()}/bin 을 PATH 에 넣으세요.`);
    return false;
  }
  console.log(`  ${which()}`);
  return true;
}

/** 서버가 받는 이 컴퓨터의 주소와 휴대폰용 https 주소(알림 링크와 같은 첫 *.ts.net). */
export function addresses(config: { host: string; port: number; allowedHosts: string[] }) {
  const host = ['0.0.0.0', '::'].includes(config.host) ? '127.0.0.1' : config.host;
  const phone = config.allowedHosts.find((h) => h.endsWith('.ts.net'));
  return { host, local: urlOf(host, config.port), phone: phone && `https://${phone}` };
}

/** 서버와 같은 규칙: NIGHTSHIFT_CONFIG 가 있으면 그 파일. */
export const configFile = () => path.resolve(ROOT, process.env.NIGHTSHIFT_CONFIG ?? defaultConfigPath(path.join(ROOT, 'config')));

/** base 에서 누가 답하는지. 아무도 안 받으면 null. 응답이 멈춰도 3초 안에 끝난다 (본문 읽기까지). */
export const probe = (base: string) =>
  fetch(`${base}/api/snapshot`, { signal: AbortSignal.timeout(3000) }).then(
    async (r) => (r.ok && Array.isArray((await r.json().catch(() => null))?.projects) ? 'nightshift' : 'other'),
    () => null,
  );

export async function up(base: string): Promise<boolean> {
  for (let i = 0; i < 40; i++) {
    if ((await probe(base)) === 'nightshift') return true;
    await sleep(250);
  }
  return false;
}

async function main() {
  console.log('NightShift 설치');
  tools();

  step('빌드');
  if (!show('npm', ['run', 'build'])) fail('빌드에 실패했습니다');

  const configPath = configFile(); // 서비스에도 넘긴다
  const load = () => {
    try {
      return loadConfig(configPath, ROOT).config;
    } catch (e) {
      return fail(e instanceof ConfigError ? e.message : String(e));
    }
  };
  const config = load();
  const { host, local } = addresses(config);
  const relay = relayHost(config.host);
  const upstream = relay && urlOf(relay, config.port);

  // 이 포트를 다른 프로그램이 쓰고 있으면 Tailscale 로 그것을 열어 버리기 전에 멈춘다
  for (const h of new Set([host, relay ?? host])) {
    const who = await probe(urlOf(h, config.port));
    // 답이 없어도(연결을 끊거나 응답이 멈춤) 누가 잡고 있으면 NightShift 가 아니다
    if (who === 'other' || (who === null && !(await portFree(h, config.port)))) fail(`${urlOf(h, config.port)} 를 NightShift 가 아닌 다른 프로그램이 쓰고 있습니다. 그 프로그램을 끄거나 config 의 port 를 바꾼 뒤 다시 실행하세요.`);
  }

  const name = tailscale(upstream);
  if (name) {
    // tailscale serve 로 들어오는 이름을 받게 한다 (안 적으면 DNS rebinding 방어로 거부).
    // 맨 앞에 둔다: 알림 링크는 첫 *.ts.net 을 쓰므로 기기 이름이 바뀌었으면 새 이름이 앞서야 한다
    const raw = readRaw(configPath);
    const hosts: unknown[] = Array.isArray(raw.allowedHosts) ? raw.allowedHosts : [];
    const next = [name, ...hosts.filter((h) => String(h).toLowerCase() !== name)];
    if (JSON.stringify(next) !== JSON.stringify(hosts)) {
      writeRaw(configPath, raw, { ...raw, allowedHosts: next });
      console.log(`  ${path.relative(ROOT, configPath)} 의 allowedHosts 맨 앞에 ${name}`);
      load(); // 쓴 결과가 서버가 읽을 수 있는 config 인지
    }
  }

  const registered = await service(host, config.port, configPath);
  if (registered) {
    step('확인');
    // Tailscale 주소에 바인딩했으면 중계용 127.0.0.1 은 따로 뜬다 (실패해도 서버는 로그만 남기고 돈다)
    for (const base of new Set([local, name && upstream ? upstream : local])) {
      if (!(await up(base))) fail(`${base} 에서 서버가 답하지 않습니다. 로그를 보세요: ${SERVICE.logs.join(' ')}`);
    }
  }
  const linked = link();
  const cmd = (c: 'logs' | 'restart' | 'stop') => (linked ? `nightshift ${c}` : SERVICE[c].join(' '));

  console.log(`\n✓ 준비됐습니다\n`);
  console.log(`  이 컴퓨터   ${local}`);
  if (name) console.log(`  휴대폰      https://${name}  (휴대폰 Tailscale 앱을 같은 계정으로 켠 채로)`);
  if (registered) console.log(`\n  로그        ${cmd('logs')}\n  재시작      ${cmd('restart')}\n  끄기        ${cmd('stop')}`);
  console.log(`  업데이트    ${linked ? 'nightshift update' : 'git pull && npm run setup'}`);
  if (linked) console.log(`  그 밖에     nightshift help`);
  if (mac) {
    // launchd 로 띄운 node 는 터미널의 권한을 물려받지 못한다
    console.log(`\n  다운로드·문서·데스크탑 폴더의 저장소를 보려면: 시스템 설정 → 개인정보 보호 및 보안 → 전체 디스크 접근 권한 → + → ⌘⇧G 로\n  ${realpathSync(nodePath())} 를 추가하세요 (node 를 업그레이드하면 다시).`);
  }
  console.log(`\n  처음이라면: 브라우저로 열고 돌고 있는 tmux 세션을 등록하거나 "+ tmux 세션 만들기"로 시작하세요.`);
}

// 직접 실행했을 때만 (nightshift 명령이 불러 쓸 때는 아니다). 심볼릭 링크로 받은 폴더에서도 맞게 비교한다
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
