// 서버와 UI가 공유하는 API 타입. 런타임 코드 없음 (type-only import 전용).

/** waiting = 에이전트가 사용자 입력(확인 프롬프트 등)을 기다리는 중 */
export type ProjectState = 'running' | 'waiting' | 'idle' | 'stalled' | 'error';
export type RunKind = 'test' | 'build';

export interface Commit {
  hash: string;
  author: string;
  /** ISO 8601 */
  date: string;
  subject: string;
}

export interface FileChange {
  path: string;
  /** git status --porcelain 의 XY 코드 (예: " M", "??", "A ") */
  status: string;
  /** 이름이 바뀐 파일의 원래 경로 */
  from?: string;
}

export interface FileStat {
  path: string;
  additions: number;
  deletions: number;
  /** 이름이 바뀐 파일의 원래 경로 */
  from?: string;
  /** untracked 파일 (additions 는 파일의 줄 수) */
  untracked?: boolean;
}

export interface GitInfo {
  ok: boolean;
  /** ok=false 일 때의 사유 */
  error?: string;
  branch: string;
  head: string | null;
  clean: boolean;
  changedFiles: FileChange[];
  /** HEAD 대비 working tree 의 파일별 diff stat */
  diffStat: FileStat[];
  additions: number;
  deletions: number;
  recentCommits: Commit[];
  todayCommits: Commit[];
  /** 활동 감지용 불투명 지문 (HEAD + 변경 파일들의 크기·수정 시각). UI 는 쓰지 않는다. */
  fingerprint: string;
}

/** 모니터링이 이 프로젝트를 처음 확인한 시점의 기준점 */
export interface GitBaseline {
  at: string;
  branch: string;
  head: string | null;
}

/** 최초 확인 시점부터 발생한 변경 (커밋되지 않은 변경 포함) */
export interface SinceBaseline {
  baseline: GitBaseline;
  commits: Commit[];
  files: FileStat[];
  additions: number;
  deletions: number;
}

export interface TmuxPane {
  /** tmux pane id (예: "%12") */
  id: string;
  window: number;
  windowName: string;
  index: number;
  /** pane 에서 실행 중인 명령 (예: "node", "zsh") */
  command: string;
  /** 세션의 활성 윈도우의 활성 pane 인지 */
  active: boolean;
  /**
   * 최근 출력 (최대 100줄). 색상용 SGR 시퀀스(ESC [ ... m)만 남아 있고 다른 제어 문자는 제거됨.
   * SGR 상태는 줄을 넘어 이어진다.
   */
  lines: string[];
}

export interface TmuxInfo {
  /** config 에 tmux 세션이 등록되어 있는지 */
  configured: boolean;
  exists: boolean;
  createdAt: string | null;
  attached: boolean;
  /** tmux 가 보고하는 세션 마지막 활동 시각 */
  lastActivityAt: string | null;
  /** NightShift 가 관측한 pane 출력의 마지막 변경 시각 */
  lastOutputChangeAt: string | null;
  /** 활성 pane 의 최근 출력 (최대 100줄, ANSI 제거됨) */
  output: string[];
  /** 세션의 모든 pane (최대 8개). 세션이 없으면 빈 배열 */
  panes: TmuxPane[];
  /** 입력 대기 프롬프트로 판정된 줄. 없으면 null */
  waitingPrompt: string | null;
  /** 예: tmux attach -t session-name */
  attachCommand: string | null;
  error?: string;
}

export interface RunResult {
  kind: RunKind;
  command: string;
  running: boolean;
  startedAt: string;
  finishedAt: string | null;
  exitCode: number | null;
  timedOut: boolean;
  /** 사용자가 취소했거나 서버 재시작으로 중단됨 */
  canceled: boolean;
  durationMs: number | null;
  stdout: string;
  stderr: string;
}

/** 실행 이력 한 건 (출력 제외) */
export type RunSummary = Pick<RunResult, 'startedAt' | 'finishedAt' | 'exitCode' | 'timedOut' | 'canceled' | 'durationMs'>;

export interface ProjectStatus {
  state: ProjectState;
  /** 사람이 읽는 판정 사유 */
  reasons: string[];
}

export interface ProjectSnapshot {
  id: string;
  name: string;
  repoPath: string;
  tmuxSession: string | null;
  testCommand: string | null;
  buildCommand: string | null;
  logFile: string | null;
  git: GitInfo;
  since: SinceBaseline | null;
  /** 마지막 커밋 또는 working tree 변경이 관측된 시각 */
  lastGitChangeAt: string | null;
  tmux: TmuxInfo;
  /** 로그 파일에서 오류 패턴에 걸린 최근 줄 */
  logErrors: string[];
  status: ProjectStatus;
  runs: Record<RunKind, RunResult | null>;
  /** 끝난 실행의 이력, 최신순, 종류별 최대 20건 */
  history: Record<RunKind, RunSummary[]>;
}

export interface Summary {
  total: number;
  sessionsRunning: number;
  running: number;
  waiting: number;
  idle: number;
  stalled: number;
  error: number;
}

export interface Snapshot {
  generatedAt: string;
  /** 모니터링 세션 시작 시각 (서버를 재시작해도 유지, "새 세션 시작"으로 초기화) */
  startedAt: string;
  demo: boolean;
  refreshIntervalSec: number;
  configPath: string;
  /** config 파일이 없어 빈 목록으로 시작한 경우 */
  configMissing: boolean;
  /** 실행 중 config 를 다시 읽다가 실패했을 때의 메시지 (이전 설정으로 계속 동작 중) */
  configError: string | null;
  /** Morning Report 자동 생성 시각 "HH:MM". 꺼져 있으면 null */
  autoReportTime: string | null;
  summary: Summary;
  projects: ProjectSnapshot[];
}

export interface ReportMeta {
  name: string;
  modifiedAt: string;
}

export interface Report {
  name: string;
  content: string;
}
