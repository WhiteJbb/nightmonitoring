import { existsSync, watchFile } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import express from 'express';
import { createApp } from './app.ts';
import { ConfigError, defaultConfigPath, loadConfig } from './config.ts';
import { demoCollector, demoConfig, demoExec, seedDemoRuns } from './demo.ts';
import { notify } from './exec.ts';
import { Monitor, realCollector } from './monitor.ts';
import { alertsFor, autoReportDue, localDate } from './notify.ts';
import { reloadConfig } from './reload.ts';
import { saveReport } from './report.ts';
import { Runner } from './runner.ts';
import { loadState, saveState } from './state.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
process.chdir(ROOT);

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const option = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);

const dev = flag('--dev');
const demo = flag('--demo') || process.env.NIGHTSHIFT_DEMO === '1';
const configPath = path.resolve(option('--config') ?? process.env.NIGHTSHIFT_CONFIG ?? defaultConfigPath('config'));
const processStartedAt = new Date();

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

  // demo 는 저장하지 않는다. --fresh 는 저장된 세션을 무시하고 새로 시작한다.
  const stateFile = demo ? null : path.join(ROOT, '.nightshift/state.json');
  const saved = stateFile && !flag('--fresh') ? loadState(stateFile) : null;
  if (saved) runner.restore(saved.runner);

  const monitor = new Monitor({
    config,
    collector: demo ? demoCollector() : realCollector(config),
    runs: runner.get,
    history: runner.history,
    demo,
    configPath,
    configMissing: missing && !demo,
    restore: saved?.monitor ?? null,
  });
  runner.onChange = () => monitor.publish();

  const reportsDir = () => (demo ? path.join(monitor.config.reportsDir, 'demo') : monitor.config.reportsDir);
  let lastAutoReportDate = saved?.lastAutoReportDate ?? null;
  let autoReportBusy = false;

  if (!demo) {
    // 상태 변화 알림과 예약된 Morning Report. 둘 다 실패해도 감시는 계속된다.
    const prevStates = new Map(monitor.snapshot.projects.map((p) => [p.id, p.status.state]));
    monitor.subscribe((snapshot) => {
      const alerts = alertsFor(prevStates, snapshot);
      if (monitor.config.notifications) for (const a of alerts) void notify(a.title, a.message);

      const now = new Date();
      if (!autoReportBusy && autoReportDue(now, monitor.config.autoReportTime, lastAutoReportDate, processStartedAt)) {
        autoReportBusy = true;
        // 성공했을 때만 날짜를 기록해, 실패하면 다음 tick 에 다시 시도한다.
        saveReport(reportsDir(), snapshot, now)
          .then(
            (r) => {
              lastAutoReportDate = localDate(now);
              console.log(`Morning Report 자동 생성: ${r.name}`);
            },
            (e: Error) => console.error(`Morning Report 자동 생성 실패: ${e.message}`),
          )
          .finally(() => (autoReportBusy = false));
      }
    });

    // 에디터의 원자적 저장(rename)에도 안전하도록 polling 방식으로 감시한다.
    watchFile(configPath, { interval: 1000 }, (cur, prev) => {
      if (cur.mtimeMs !== prev.mtimeMs) void reloadConfig({ configPath, baseDir: ROOT, monitor, runner, collectorFor: realCollector });
    });
  }

  if (stateFile) {
    let last = '';
    monitor.subscribe(() => {
      const state = { version: 2 as const, monitor: monitor.exportState(), runner: runner.exportState(), lastAutoReportDate };
      const json = JSON.stringify(state);
      if (json === last) return;
      try {
        saveState(stateFile, state);
        last = json; // 실패하면 다음 스냅샷에서 다시 시도한다
      } catch (e) {
        console.error(`상태 저장 실패: ${(e as Error).message}`);
      }
    });
  }
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => {
      runner.cancelAll();
      process.exit(0);
    });
  }
  await monitor.tick();
  monitor.start();

  const app = createApp({ config, monitor, runner, reportsDir });
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
    else if (!demo) console.log(`프로젝트 ${config.projects.length}개 감시 중 (${config.refreshIntervalSec}초 주기)${saved ? `, ${saved.monitor.startedAt} 에 시작한 세션을 이어 갑니다 (새로 시작: --fresh)` : ''}`);
    if (!['127.0.0.1', 'localhost', '::1'].includes(config.host)) console.warn('경고: loopback 이 아닌 주소에 바인딩했습니다. 네트워크의 누구나 접근할 수 있습니다.');
  });
}

main().catch((e) => {
  console.error(e instanceof ConfigError ? e.message : e);
  process.exit(1);
});
