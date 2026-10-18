#!/usr/bin/env node
// nightshift 명령. npm run setup 이 npm link 로 PATH 에 건다 (직접: npm link).
// 이 파일이 있는 폴더의 NightShift 를 켜고 끄고 본다.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { ConfigError, loadConfig } from '../server/config.ts';
import { addresses, configFile, probe, ROOT, SERVICE, up } from './setup.ts';

const USAGE = `사용법: nightshift <명령>      (${ROOT})

  status    돌고 있는지와 접속 주소
  open      브라우저로 열기
  logs      서버 로그 보기
  restart   다시 띄우기
  stop      끄기 (다음 로그인·부팅 때 다시 뜬다)
  start     켜기
  setup     빌드·Tailscale·자동 시작 다시 하기
  update    git pull 뒤 setup`;

/** 화면에 그대로 보여 주며 실행하고 종료 코드를 돌려준다. */
const run = ([bin, ...args]: string[]) => spawnSync(bin!, args, { cwd: ROOT, stdio: 'inherit' }).status ?? 1;

function config() {
  try {
    return loadConfig(configFile(), ROOT).config;
  } catch (e) {
    console.error(e instanceof ConfigError ? e.message : String(e));
    return process.exit(1);
  }
}

/** 자동 시작이 등록되어 있어야 하는 명령 */
function service(argv: string[]): number {
  if (!existsSync(SERVICE.file)) {
    console.error('자동 시작이 등록되어 있지 않습니다. 먼저 nightshift setup 을 실행하세요 (systemd 가 없는 Linux 는 npm start 로 직접 띄웁니다).');
    return 1;
  }
  return run(argv);
}

/** 켠 뒤 실제로 답할 때까지 기다려 주소를 보여 준다 (launchctl·systemctl 은 성공해도 말이 없다). */
async function andWait(argv: string[]): Promise<number> {
  const code = service(argv);
  if (code) return code;
  const { local } = addresses(config());
  if (await up(local)) return status();
  console.error(`${local} 에서 답하지 않습니다. 로그를 보세요: nightshift logs`);
  return 1;
}

async function status(): Promise<number> {
  const { local, phone } = addresses(config());
  const who = await probe(local);
  if (who !== 'nightshift') {
    console.log(who === 'other' ? `${local} 에서 NightShift 가 아닌 다른 프로그램이 답합니다` : `꺼져 있습니다 (${local})`);
    if (existsSync(SERVICE.file)) console.log('  켜기: nightshift start    로그: nightshift logs');
    return 1;
  }
  console.log(`돌고 있습니다\n  이 컴퓨터   ${local}${phone ? `\n  휴대폰      ${phone}` : ''}`);
  return 0;
}

const commands: Record<string, () => number | Promise<number>> = {
  status,
  open: () => run([process.platform === 'darwin' ? 'open' : 'xdg-open', addresses(config()).local]),
  logs: () => service(SERVICE.logs),
  restart: () => andWait(SERVICE.restart),
  stop: () => {
    const code = service(SERVICE.stop);
    if (!code) console.log('껐습니다. 다음 로그인·부팅 때 다시 뜹니다 (지금 켜기: nightshift start)');
    return code;
  },
  start: async () => {
    if ((await probe(addresses(config()).local)) !== 'nightshift') return andWait(SERVICE.start);
    console.log('이미 돌고 있습니다');
    return 0;
  },
  setup: () => run(['npm', 'run', 'setup']),
  update: () => run(['git', 'pull', '--ff-only']) || run(['npm', 'run', 'setup']),
};

const [name = 'help'] = process.argv.slice(2);
const command = Object.hasOwn(commands, name) ? commands[name] : undefined;
if (!command) {
  if (!['help', '-h', '--help'].includes(name)) console.log(`알 수 없는 명령: ${name}\n`);
  console.log(USAGE);
  process.exit(['help', '-h', '--help'].includes(name) ? 0 : 1);
}
process.exit(await command());
