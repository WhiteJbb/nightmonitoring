import { existsSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import express from 'express';
import { createApp } from './app.ts';
import { ConfigError, loadConfig } from './config.ts';
import { demoCollector, demoConfig, demoExec, seedDemoRuns } from './demo.ts';
import { Monitor, realCollector } from './monitor.ts';
import { Runner } from './runner.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
process.chdir(ROOT);

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const option = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);

const dev = flag('--dev');
const demo = flag('--demo') || process.env.NIGHTSHIFT_DEMO === '1';
const configPath = path.resolve(option('--config') ?? process.env.NIGHTSHIFT_CONFIG ?? 'config/nightshift.json');

// 예상하지 못한 비동기 오류 하나로 관제 서버가 죽지 않게 한다.
process.on('unhandledRejection', (e) => console.error('unhandledRejection:', e));

async function main() {
  const loaded = loadConfig(configPath, ROOT);
  const missing = loaded.missing;
  const config = demo ? demoConfig(loaded.config) : loaded.config;

  const runner = new Runner({
    timeoutSec: config.commandTimeoutSec,
    logDir: demo ? null : path.join(ROOT, '.nightshift/runs'),
    ...(demo ? { exec: demoExec } : {}),
  });
  if (demo) seedDemoRuns(runner);

  const monitor = new Monitor({
    config,
    collector: demo ? demoCollector() : realCollector(config),
    runs: runner.get,
    history: runner.history,
    demo,
    configPath,
    configMissing: missing && !demo,
  });
  runner.onChange = () => monitor.publish();
  await monitor.tick();
  monitor.start();

  const app = createApp({ config, monitor, runner, reportsDir: demo ? path.join(config.reportsDir, 'demo') : config.reportsDir });
  const server = http.createServer(app);

  if (dev) {
    const { createServer } = await import('vite');
    const vite = await createServer({ server: { middlewareMode: true, hmr: { server } }, appType: 'spa' });
    app.use(vite.middlewares);
  } else {
    const dist = path.join(ROOT, 'dist/web');
    if (!existsSync(path.join(dist, 'index.html'))) {
      console.error('dist/web 이 없습니다. 먼저 `npm run build` 를 실행하거나 `npm run dev` 를 사용하세요.');
      process.exit(1);
    }
    app.use(express.static(dist));
  }

  server.on('error', (e: NodeJS.ErrnoException) => {
    console.error(e.code === 'EADDRINUSE' ? `포트 ${config.port} 가 이미 사용 중입니다. config 의 port 를 바꾸세요.` : e);
    process.exit(1);
  });
  server.listen(config.port, config.host, () => {
    console.log(`NightShift${demo ? ' (demo)' : ''}: http://${config.host}:${config.port}`);
    if (missing && !demo) console.log(`config 파일이 없습니다: ${configPath}\n  config/nightshift.example.json 을 복사해 프로젝트를 등록하세요.`);
    else if (!demo) console.log(`프로젝트 ${config.projects.length}개 감시 중 (${config.refreshIntervalSec}초 주기)`);
    if (!['127.0.0.1', 'localhost', '::1'].includes(config.host)) console.warn('경고: loopback 이 아닌 주소에 바인딩했습니다. 네트워크의 누구나 접근할 수 있습니다.');
  });
}

main().catch((e) => {
  console.error(e instanceof ConfigError ? e.message : e);
  process.exit(1);
});
