import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import type { ConfigView } from '../shared/types.ts';
import type { Config } from './config.ts';
import { ConfigError } from './config.ts';
import { ConfigConflict } from './configEdit.ts';
import type { ParsedInput } from './input.ts';
import { parseInput } from './input.ts';
import type { Monitor } from './monitor.ts';
import { listReports, readReport, saveReport } from './report.ts';
import type { Runner } from './runner.ts';

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
const hostname = (host: string) => host.replace(/:\d+$/, '').toLowerCase();
const isLoopback = (host: string) => LOOPBACK.has(hostname(host));
const isLoopbackBind = (host: string) => isLoopback(host) || host === '::1';

/** Tailscale 이 기기에 주는 주소 (100.64.0.0/10, fd7a:115c:a1e0::/48). tailnet 안에서만 닿는다. */
export function isTailscaleAddress(host: string): boolean {
  const m = /^100\.(\d+)\.\d+\.\d+$/.exec(host);
  if (m) return Number(m[1]) >= 64 && Number(m[1]) <= 127;
  return host.toLowerCase().startsWith('fd7a:115c:a1e0:');
}

/** 터미널 입력을 받아도 되는 바인딩인지: loopback 이거나 Tailscale 주소. 0.0.0.0 이나 LAN 주소는 안 된다. */
export const isPrivateBind = (host: string) => isLoopbackBind(host) || isTailscaleAddress(host);

/**
 * 방어선.
 * - loopback 바인딩이면 Host 헤더가 loopback 이거나 allowedHosts 에 있어야 한다 (DNS rebinding 방어).
 *   allowedHosts 는 `tailscale serve` 같은 프록시를 거쳐 들어오는 이름을 허용하기 위한 것.
 *   host 를 loopback 밖으로 바꾼 경우는 사용자가 감수한 것으로 본다.
 * - 변경 요청은 Origin 이 자기 자신(또는 allowedHosts)일 때만 허용 (다른 웹사이트가 명령 실행을 유발하지 못하게).
 */
export function guard(config: Pick<Config, 'host'> & Partial<Pick<Config, 'allowedHosts'>>) {
  const checkHost = isLoopbackBind(config.host);
  const allowed = new Set(config.allowedHosts ?? []);
  return (req: Request, res: Response, next: NextFunction) => {
    const host = req.headers.host ?? '';
    if (checkHost && !isLoopback(host) && !allowed.has(hostname(host))) return void res.status(403).json({ error: '허용되지 않은 Host' });
    const origin = req.headers.origin;
    if (req.method !== 'GET' && req.method !== 'HEAD' && origin !== undefined) {
      const o = URL.parse(origin);
      if (!o || (o.host !== host && !allowed.has(o.hostname.toLowerCase()))) return void res.status(403).json({ error: '허용되지 않은 Origin' });
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
  /** 실시간 pane 보기와 키 입력. 없으면(demo) 스냅샷의 출력만 돌려주고 입력은 거부한다 */
  terminal?: {
    capture: (paneId: string) => Promise<string[]>;
    /** 실패하면 오류 메시지 */
    send: (input: ParsedInput) => Promise<string | null>;
    log: (projectId: string, input: ParsedInput) => void;
  };
  /** 설정 편집. 없으면 /api/config 는 404 */
  configEditor?: {
    view: () => ConfigView;
    /** 본문을 검증해 저장하고 즉시 적용한다. 잘못된 값이면 ConfigError */
    update: (body: unknown) => Promise<ConfigView>;
  };
}

export function createApp({ config, monitor, runner, reportsDir, configEditor, terminal }: AppDeps) {
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

  // 스냅샷에 있는 pane(= 이 프로젝트의 세션에 속한 pane)만 대상으로 삼는다.
  const findPane = (projectId: string, paneId: unknown) => {
    const project = monitor.snapshot.projects.find((p) => p.id === projectId);
    return { project, pane: project?.tmux.panes.find((x) => x.id === paneId) };
  };

  api.get('/projects/:id/panes/:paneId', async (req, res) => {
    const { pane } = findPane(req.params.id, req.params.paneId);
    if (!pane) return void res.status(404).json({ error: 'pane 을 찾을 수 없습니다' });
    res.json({ lines: terminal ? await terminal.capture(pane.id) : pane.lines });
  });

  // 웹에서 터미널로 키 입력을 보내는 유일한 경로. 임의 명령 실행과 같으므로 여러 겹으로 막는다:
  // allowInput 을 켠 프로젝트만, loopback·Tailscale 바인딩일 때만, 그 프로젝트 세션의 pane 으로만.
  api.post('/projects/:id/input', express.json({ limit: '32kb' }), async (req, res) => {
    const input = parseInput(req.body);
    if (typeof input === 'string') return void res.status(400).json({ error: input });
    const { project, pane } = findPane(req.params.id, input.pane);
    if (!project) return void res.status(404).json({ error: '프로젝트를 찾을 수 없습니다' });
    if (!terminal) return void res.status(403).json({ error: 'demo mode 에서는 입력을 보낼 수 없습니다' });
    if (!project.allowInput) return void res.status(403).json({ error: '이 프로젝트는 터미널 입력이 꺼져 있습니다. 설정 화면에서 켜세요.' });
    if (!isPrivateBind(config.host)) return void res.status(403).json({ error: '서버가 loopback·Tailscale 이 아닌 주소에 열려 있어 입력을 보낼 수 없습니다' });
    if (!pane) return void res.status(404).json({ error: 'pane 을 찾을 수 없습니다' });
    terminal.log(project.id, input);
    const error = await terminal.send(input);
    if (error) return void res.status(500).json({ error });
    res.json({ ok: true });
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
    if (err instanceof ConfigConflict) return void res.status(409).json({ error: err.message });
    if (err instanceof ConfigError) return void res.status(400).json({ error: 'config 가 올바르지 않습니다', issues: err.issues });
    // 잘못된 JSON 본문 등 클라이언트 오류는 그 상태 코드로 돌려준다.
    if (err.status && err.status >= 400 && err.status < 500) return void res.status(err.status).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: err.message });
  });

  app.use('/api', api);
  return app;
}
