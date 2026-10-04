import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import type { ConfigView } from '../shared/types.ts';
import type { Config } from './config.ts';
import { ConfigError } from './config.ts';
import type { Monitor } from './monitor.ts';
import { listReports, readReport, saveReport } from './report.ts';
import type { Runner } from './runner.ts';

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
const isLoopback = (host: string) => LOOPBACK.has(host.replace(/:\d+$/, ''));

/**
 * 로컬 전용 방어선.
 * - Host 헤더가 loopback 이 아니면 거부 (DNS rebinding 방어). host 를 loopback 밖으로 바꾼 경우는 사용자가 감수한 것으로 본다.
 * - 변경 요청은 Origin 이 자기 자신일 때만 허용 (다른 웹사이트가 test/build 실행을 유발하지 못하게).
 */
export function guard(config: Pick<Config, 'host'>) {
  const checkHost = isLoopback(config.host) || config.host === '::1';
  return (req: Request, res: Response, next: NextFunction) => {
    const host = req.headers.host ?? '';
    if (checkHost && !isLoopback(host)) return void res.status(403).json({ error: '허용되지 않은 Host' });
    const origin = req.headers.origin;
    if (req.method !== 'GET' && req.method !== 'HEAD' && origin !== undefined) {
      if (URL.parse(origin)?.host !== host) return void res.status(403).json({ error: '허용되지 않은 Origin' });
    }
    next();
  };
}

export interface AppDeps {
  /** 시작 시점의 config. host 검사에만 쓴다 (host/port 는 재시작해야 바뀐다). */
  config: Config;
  monitor: Monitor;
  runner: Runner;
  /** hot reload 로 바뀔 수 있어 매번 묻는다 */
  reportsDir: () => string;
  /** 설정 편집. 없으면 /api/config 는 404 */
  configEditor?: {
    view: () => ConfigView;
    /** 본문을 검증해 저장하고 즉시 적용한다. 잘못된 값이면 ConfigError */
    update: (body: unknown) => Promise<ConfigView>;
  };
}

export function createApp({ config, monitor, runner, reportsDir, configEditor }: AppDeps) {
  const app = express();
  app.disable('x-powered-by');
  app.use(guard(config));

  const api = express.Router();

  api.get('/snapshot', (_req, res) => void res.json(monitor.snapshot));

  api.get('/events', (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    // 느린 클라이언트에는 쌓아 두지 않고 건너뛴다. 스냅샷은 매번 전체 상태라 다음 것만 받아도 된다.
    const send = (s: unknown) => {
      if (!res.writableNeedDrain) res.write(`data: ${JSON.stringify(s)}\n\n`);
    };
    send(monitor.snapshot);
    req.on('close', monitor.subscribe(send));
  });

  // 요청 본문은 읽지 않는다. 실행되는 명령은 항상 config 에 적힌 것.
  api.post('/projects/:id/run/:kind', (req, res) => {
    const { id, kind } = req.params;
    const project = monitor.config.projects.find((p) => p.id === id);
    if (!project) return void res.status(404).json({ error: '프로젝트를 찾을 수 없습니다' });
    if (kind !== 'test' && kind !== 'build') return void res.status(400).json({ error: 'kind 는 test 또는 build 여야 합니다' });
    const outcome = runner.start(project, kind);
    if (outcome === 'no-command') return void res.status(400).json({ error: 'config 에 등록된 명령이 없습니다' });
    if (outcome === 'already-running') return void res.status(409).json({ error: '이미 실행 중입니다' });
    res.status(202).json({ ok: true });
  });

  api.delete('/projects/:id/run/:kind', (req, res) => {
    const { id, kind } = req.params;
    if (kind !== 'test' && kind !== 'build') return void res.status(400).json({ error: 'kind 는 test 또는 build 여야 합니다' });
    if (!runner.cancel(id, kind)) return void res.status(409).json({ error: '실행 중이 아닙니다' });
    res.status(202).json({ ok: true });
  });

  api.post('/projects/:id/ack-errors', (req, res) => {
    if (!monitor.ackErrors(req.params.id)) return void res.status(404).json({ error: '프로젝트를 찾을 수 없습니다' });
    res.json({ ok: true });
  });

  api.post('/session/reset', async (_req, res) => {
    await monitor.reset();
    res.json({ ok: true });
  });

  if (configEditor) {
    api.get('/config', (_req, res) => void res.json(configEditor.view()));
    // 본문을 읽는 유일한 경로. 편집 가능한 필드만 반영되며 명령 문자열은 받지 않는다 (configEdit.ts).
    api.put('/config', express.json({ limit: '256kb' }), async (req, res) => {
      const view = configEditor.view();
      if (!view.editable) return void res.status(403).json({ error: view.readOnlyReason ?? '수정할 수 없습니다' });
      res.json(await configEditor.update(req.body));
    });
  }

  api.get('/reports', async (_req, res) => void res.json(await listReports(reportsDir())));

  api.get('/reports/:name', async (req, res) => {
    const report = await readReport(reportsDir(), req.params.name);
    if (!report) return void res.status(404).json({ error: '보고서를 찾을 수 없습니다' });
    res.json(report);
  });

  api.post('/reports', async (_req, res) => void res.json(await saveReport(reportsDir(), monitor.snapshot)));

  api.use((_req, res) => void res.status(404).json({ error: '없는 API 입니다' }));
  // Express 는 인자 4개인 함수만 오류 핸들러로 인식한다.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  api.use((err: Error & { status?: number }, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ConfigError) return void res.status(400).json({ error: 'config 가 올바르지 않습니다', issues: err.issues });
    // 잘못된 JSON 본문 등 클라이언트 오류는 그 상태 코드로 돌려준다.
    if (err.status && err.status >= 400 && err.status < 500) return void res.status(err.status).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: err.message });
  });

  app.use('/api', api);
  return app;
}
