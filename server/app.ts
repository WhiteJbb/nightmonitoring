import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import type { ConfigView, EditableProject, RawInputRequest, TermEvent } from '../shared/types.ts';
import type { Config } from './config.ts';
import { ConfigError, SESSION_RE } from './config.ts';
import { ConfigConflict } from './configEdit.ts';
import { GIT_URL_RE } from './git.ts';
import type { ParsedInput } from './input.ts';
import { parseInput } from './input.ts';
import type { Monitor } from './monitor.ts';
import { listReports, readReport, saveReport } from './report.ts';
import type { Runner } from './runner.ts';
import type { TermSize } from './tmux.ts';
import { clampSize, MAX_LIVE_LINES, OUTPUT_LINES } from './tmux.ts';
import { parseUpload } from './upload.ts';

/** 한 번에 받는 raw 입력의 최대 바이트 (키 몇 개나 마우스 보고 묶음이면 충분하다) */
export const MAX_RAW_BYTES = 4096;

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
 * - Tailscale 바인딩이면 그 주소, MagicDNS 이름(*.ts.net 또는 점 없는 짧은 이름), allowedHosts 만 받는다.
 *   tailnet 의 브라우저도 rebinding 에 걸릴 수 있다. 점 없는 이름은 공개 DNS 로 만들 수 없으므로 안전하다.
 *   그 밖의 주소로 바꾼 경우는 사용자가 감수한 것으로 본다.
 * - 변경 요청은 Origin 이 정확히 이 서버일 때만 허용 (다른 웹사이트가 명령 실행을 유발하지 못하게).
 *   직접 접속이면 http://<Host 헤더> 이고 그 포트가 이 서버가 받은 포트여야 한다. 프록시를 거치면 https://<allowedHosts 이름> (443) 만 받는다.
 *   이름만 보면 같은 기기의 다른 포트(다른 개발 서버)에서 온 요청도 통과하므로 scheme·포트까지 비교한다.
 */
export function guard(config: Pick<Config, 'host'> & Partial<Pick<Config, 'allowedHosts'>>) {
  const tailscale = isTailscaleAddress(config.host);
  const checkHost = isLoopbackBind(config.host) || tailscale;
  const allowed = new Set(config.allowedHosts ?? []);
  const self = new Set([config.host.toLowerCase(), `[${config.host.toLowerCase()}]`]);
  const hostOk = (host: string) => {
    const name = hostname(host);
    return isLoopback(host) || allowed.has(name) || (tailscale && (self.has(name) || name.endsWith('.ts.net') || !name.includes('.')));
  };
  return (req: Request, res: Response, next: NextFunction) => {
    const host = req.headers.host ?? '';
    if (checkHost && !hostOk(host)) return void res.status(403).json({ error: '허용되지 않은 Host' });
    const origin = req.headers.origin;
    if (req.method !== 'GET' && req.method !== 'HEAD' && origin !== undefined) {
      const o = URL.parse(origin)?.origin;
      const direct = URL.parse(`http://${host}`);
      const viaSelf = direct !== null && Number(direct.port || 80) === req.socket?.localPort && o === direct.origin;
      const viaProxy = o?.startsWith('https://') && allowed.has(o.slice('https://'.length));
      if (!viaSelf && !viaProxy) return void res.status(403).json({ error: '허용되지 않은 Origin' });
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
    capture: (paneId: string, lines: number) => Promise<string[]>;
    /** 실패하면 오류 메시지 */
    send: (input: ParsedInput) => Promise<string | null>;
    /** 터미널 에뮬레이터의 바이트를 그대로 넣는다. 실패하면 오류 메시지 */
    sendRaw: (paneId: string, bytes: Uint8Array) => Promise<string | null>;
    /** pane 출력 스트림. 돌려주는 함수로 끊는다 */
    stream: (session: string, paneId: string, sink: (e: TermEvent) => void) => () => void;
    log: (projectId: string, input: ParsedInput) => void;
    /** repoPath(원문, "~" 가능)에서 셸 세션을 만든다. 이미 있으면 그대로 둔다. 실패하면 오류 메시지 */
    createSession: (name: string, repoPath: string, size: TermSize) => Promise<string | null>;
    /** repoPath(원문) 에 git clone. 이미 저장소면 건너뛴다. 실패하면 오류 메시지 */
    cloneRepo: (url: string, repoPath: string) => Promise<string | null>;
    /** pane 이 속한 윈도우의 크기를 바꾼다. 실패하면 오류 메시지 */
    resize: (paneId: string, size: TermSize) => Promise<string | null>;
    /** 올린 이미지를 저장하고 절대 경로를 돌려준다 */
    saveUpload: (projectId: string, ext: string, data: Buffer) => Promise<string>;
  };
  /** 휴대폰 푸시 시험 전송. 실패하면 오류 메시지. 없으면(demo) 거부한다 */
  testPush?: () => Promise<string | null>;
  /** 설정 편집. 없으면 /api/config 는 404 */
  configEditor?: {
    view: () => ConfigView;
    /** 본문을 검증해 저장하고 즉시 적용한다. 잘못된 값이면 ConfigError */
    update: (body: unknown) => Promise<ConfigView>;
  };
}

export function createApp({ config, monitor, runner, reportsDir, configEditor, terminal, testPush }: AppDeps) {
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
    // 스크롤백을 더 보려면 ?lines= 로 늘린다. 터무니없는 값은 범위 안으로 자른다.
    const lines = Math.min(MAX_LIVE_LINES, Math.max(OUTPUT_LINES, Math.floor(Number(req.query.lines)) || OUTPUT_LINES));
    res.json({ lines: terminal ? await terminal.capture(pane.id, lines) : pane.lines });
  });

  // 웹에서 터미널로 키 입력을 보내는 유일한 경로. 임의 명령 실행과 같으므로 여러 겹으로 막는다:
  // allowInput 을 켠 프로젝트만, loopback·Tailscale 바인딩일 때만, 그 프로젝트 세션의 pane 으로만.
  const inputBlocked = (project: { allowInput: boolean }): string | null => {
    if (!terminal) return 'demo mode 에서는 입력을 보낼 수 없습니다';
    if (!project.allowInput) return '이 프로젝트는 터미널 입력이 꺼져 있습니다. 설정 화면에서 켜세요.';
    if (!isPrivateBind(config.host)) return '서버가 loopback·Tailscale 이 아닌 주소에 열려 있어 입력을 보낼 수 없습니다';
    return null;
  };
  api.post('/projects/:id/input', express.json({ limit: '32kb' }), async (req, res) => {
    const input = parseInput(req.body);
    if (typeof input === 'string') return void res.status(400).json({ error: input });
    const { project, pane } = findPane(req.params.id, input.pane);
    if (!project) return void res.status(404).json({ error: '프로젝트를 찾을 수 없습니다' });
    const blocked = inputBlocked(project);
    if (blocked || !terminal) return void res.status(403).json({ error: blocked });
    if (!pane) return void res.status(404).json({ error: 'pane 을 찾을 수 없습니다' });
    terminal.log(project.id, input);
    const error = await terminal.send(input);
    if (error) return void res.status(500).json({ error });
    res.json({ ok: true });
  });

  // 터미널 에뮬레이터가 만든 바이트. 글 입력과 같은 경로와 같은 조건이고, 같은 파일에 기록한다.
  api.post('/projects/:id/raw', express.json({ limit: '8kb' }), async (req, res) => {
    const body = (req.body ?? {}) as Partial<RawInputRequest>;
    const bytes = typeof body.data === 'string' && /^[A-Za-z0-9+/=]*$/.test(body.data) ? Buffer.from(body.data, 'base64') : null;
    if (!bytes || bytes.length === 0 || bytes.length > MAX_RAW_BYTES) return void res.status(400).json({ error: `data 는 base64 1~${MAX_RAW_BYTES} 바이트여야 합니다` });
    const { project, pane } = findPane(req.params.id, body.pane);
    if (!project) return void res.status(404).json({ error: '프로젝트를 찾을 수 없습니다' });
    const blocked = inputBlocked(project);
    if (blocked || !terminal) return void res.status(403).json({ error: blocked });
    if (!pane) return void res.status(404).json({ error: 'pane 을 찾을 수 없습니다' });
    // 마우스 보고(휠·클릭)만 있는 바이트는 기록하지 않는다. 사람이 친 글이 아니고 양이 많다
    const text = bytes.toString('utf8');
    // eslint-disable-next-line no-control-regex -- 터미널 이스케이프 시퀀스를 다룬다
    if (text.replace(/\x1b\[<\d+;\d+;\d+[Mm]/g, '') !== '') terminal.log(project.id, { pane: pane.id, text, enter: false });
    const error = await terminal.sendRaw(pane.id, bytes);
    if (error) return void res.status(500).json({ error });
    res.json({ ok: true });
  });

  // pane 출력 스트림. 읽기만 하므로 입력 조건은 걸지 않는다 (스냅샷에 있는 pane 만).
  api.get('/projects/:id/term/:paneId', (req, res) => {
    const { project, pane } = findPane(req.params.id, req.params.paneId);
    if (!project || !pane) return void res.status(404).json({ error: 'pane 을 찾을 수 없습니다' });
    if (!terminal || !project.tmuxSession) return void res.status(403).json({ error: 'demo mode 에서는 터미널 스트림이 없습니다' });
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    // 출력은 건너뛸 수 없다 (한 조각이 빠지면 화면이 어긋난다). 느린 클라이언트면 메모리에 쌓인다.
    const off = terminal.stream(project.tmuxSession, pane.id, (e) => void res.write(`data: ${JSON.stringify(e)}\n\n`));
    req.on('close', off);
  });

  // 이미지는 파일로 저장만 한다. 경로를 입력에 넣어 보내는 것은 평범한 글 입력과 같은 경로를 탄다.
  // base64 는 원본의 4/3 이라 10MB 이미지가 14MB 안에 들어온다.
  api.post('/projects/:id/upload', express.json({ limit: '14mb' }), async (req, res) => {
    const project = monitor.snapshot.projects.find((p) => p.id === req.params.id);
    if (!project) return void res.status(404).json({ error: '프로젝트를 찾을 수 없습니다' });
    const blocked = inputBlocked(project);
    if (blocked || !terminal) return void res.status(403).json({ error: blocked });
    const upload = parseUpload(req.body);
    if (typeof upload === 'string') return void res.status(400).json({ error: upload });
    res.json({ path: await terminal.saveUpload(project.id, upload.ext, upload.data) });
  });

  // 세션 만들기는 셸 프로세스를 띄우는 일이라 입력과 같은 범위(loopback·Tailscale)에서만 받는다.
  // 실행할 명령은 받지 않는다: 항상 기본 셸만 뜬다.
  const sessionBlocked = (): string | null => {
    if (!terminal) return 'demo mode 에서는 세션을 만들 수 없습니다';
    if (!isPrivateBind(config.host)) return '서버가 loopback·Tailscale 이 아닌 주소에 열려 있어 세션을 만들 수 없습니다';
    return null;
  };

  // 보는 화면에 맞게 tmux 윈도우 크기를 바꾼다. 터미널이 붙어 있는 세션은 그 터미널 화면까지 바뀌므로 건드리지 않는다.
  api.post('/projects/:id/panes/:paneId/fit', express.json({ limit: '4kb' }), async (req, res) => {
    const { project, pane } = findPane(req.params.id, req.params.paneId);
    if (!project) return void res.status(404).json({ error: '프로젝트를 찾을 수 없습니다' });
    const blocked = sessionBlocked();
    if (blocked || !terminal) return void res.status(403).json({ error: blocked });
    if (!project.allowInput) return void res.status(403).json({ error: '이 프로젝트는 터미널 입력이 꺼져 있습니다. 설정 화면에서 켜세요.' });
    if (!pane) return void res.status(404).json({ error: 'pane 을 찾을 수 없습니다' });
    if (project.tmux.attached) return void res.status(409).json({ error: '터미널이 붙어 있는 세션은 크기를 바꾸지 않습니다' });
    const body = (req.body ?? {}) as Record<string, unknown>;
    const error = await terminal.resize(pane.id, clampSize(body.cols, body.rows));
    if (error) return void res.status(500).json({ error });
    await monitor.tick();
    res.json({ ok: true });
  });

  api.post('/projects/:id/session', express.json({ limit: '4kb' }), async (req, res) => {
    const project = monitor.config.projects.find((p) => p.id === req.params.id);
    if (!project) return void res.status(404).json({ error: '프로젝트를 찾을 수 없습니다' });
    const blocked = sessionBlocked();
    if (blocked || !terminal) return void res.status(403).json({ error: blocked });
    if (!project.tmuxSession) return void res.status(400).json({ error: '이 프로젝트에는 tmux 세션이 등록되어 있지 않습니다' });
    const size = (req.body ?? {}) as Record<string, unknown>;
    const error = await terminal.createSession(project.tmuxSession, project.repoPath, clampSize(size.cols, size.rows));
    if (error) return void res.status(400).json({ error });
    await monitor.tick();
    res.json({ ok: true });
  });

  const editableProjects = (view: ConfigView): EditableProject[] =>
    view.projects.map(({ id, name, repoPath, tmuxSession, logFile, allowInput }) => ({ id, name, repoPath, tmuxSession, logFile, allowInput }));

  api.post('/sessions', express.json({ limit: '32kb' }), async (req, res) => {
    const blocked = sessionBlocked();
    if (blocked || !terminal) return void res.status(403).json({ error: blocked });
    if (!configEditor) return void res.status(403).json({ error: '설정을 수정할 수 없습니다' });
    const view = configEditor.view();
    if (!view.editable) return void res.status(403).json({ error: view.readOnlyReason ?? '설정을 수정할 수 없습니다' });
    const { name, repoPath, tmuxSession, allowInput, gitUrl, cols, rows } = (req.body ?? {}) as Record<string, unknown>;
    if (typeof name !== 'string' || typeof repoPath !== 'string' || typeof tmuxSession !== 'string' || !name.trim() || !repoPath.trim() || !tmuxSession.trim()) {
      return void res.status(400).json({ error: '이름, 저장소 경로, 세션 이름을 모두 입력하세요' });
    }
    if (!SESSION_RE.test(tmuxSession)) return void res.status(400).json({ error: '세션 이름이 올바르지 않습니다' });
    const registered = (v: ConfigView) => v.projects.some((p) => p.tmuxSession === tmuxSession);
    if (registered(view)) return void res.status(409).json({ error: `세션 "${tmuxSession}" 은 이미 프로젝트로 등록되어 있습니다` });

    // 주소가 있으면 clone 부터. 주소 형식은 서버가 검증하고 명령은 고정이다 (git.ts).
    if (typeof gitUrl === 'string' && gitUrl.trim()) {
      const url = gitUrl.trim();
      if (!GIT_URL_RE.test(url)) return void res.status(400).json({ error: 'Git 저장소 주소는 https://, ssh://, git@host:path 형식만 받습니다' });
      const cloneError = await terminal.cloneRepo(url, repoPath.trim());
      if (cloneError) return void res.status(400).json({ error: `git clone 실패: ${cloneError}` });
    }
    // 세션을 먼저 만든다 (이름·디렉터리가 잘못되면 등록하지 않는다). 이미 있는 세션이면 그대로 등록만 한다.
    const error = await terminal.createSession(tmuxSession, repoPath.trim(), clampSize(cols, rows));
    if (error) return void res.status(400).json({ error });
    // clone 하는 동안 설정이 바뀌었을 수 있으니 쓰기 직전에 다시 읽는다.
    const latest = configEditor.view();
    if (registered(latest)) return void res.status(409).json({ error: `세션 "${tmuxSession}" 은 이미 프로젝트로 등록되어 있습니다` });
    const next = await configEditor.update({
      version: latest.version,
      settings: latest.settings,
      projects: [...editableProjects(latest), { id: null, name: name.trim(), repoPath: repoPath.trim(), tmuxSession, logFile: null, allowInput: allowInput === true }],
    });
    await monitor.tick();
    res.json({ id: next.projects.find((p) => p.tmuxSession === tmuxSession)?.id });
  });

  // 설정에 없는 tmux 세션을 대시보드에서 숨긴다 (config 의 hiddenSessions). DELETE 는 되돌리기(실행 취소)다. 설정 화면에서 지워도 다시 보인다.
  api.all('/sessions/:name/hide', async (req, res, next) => {
    if (req.method !== 'POST' && req.method !== 'DELETE') return void next();
    if (!configEditor) return void res.status(403).json({ error: '설정을 수정할 수 없습니다' });
    const view = configEditor.view();
    if (!view.editable) return void res.status(403).json({ error: view.readOnlyReason ?? '설정을 수정할 수 없습니다' });
    const name = req.params.name;
    if (!SESSION_RE.test(name)) return void res.status(400).json({ error: '세션 이름이 올바르지 않습니다' });
    if (view.projects.some((p) => p.tmuxSession === name)) return void res.status(409).json({ error: '등록된 프로젝트의 세션은 숨길 수 없습니다. 설정에서 프로젝트를 삭제하세요' });
    await configEditor.update({
      version: view.version,
      settings: { ...view.settings, hiddenSessions: req.method === 'DELETE' ? view.settings.hiddenSessions.filter((s) => s !== name) : [...new Set([...view.settings.hiddenSessions, name])] },
      projects: editableProjects(view),
    });
    await monitor.tick();
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

  api.post('/notify/test', async (_req, res) => {
    if (!testPush) return void res.status(403).json({ error: 'demo mode 에서는 알림을 보낼 수 없습니다' });
    const error = await testPush();
    if (error) return void res.status(400).json({ error });
    res.json({ ok: true });
  });

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
