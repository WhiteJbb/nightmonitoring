// 서버와 UI가 공유하는 API 타입. 런타임 코드 없음 (type-only import 전용).

export type ProjectState = 'running' | 'idle' | 'stalled' | 'error';
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
}

export interface FileStat {
  path: string;
  additions: number;
  deletions: number;
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
  /** 최근 pane 출력 (최대 100줄, ANSI 제거됨) */
  output: string[];
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
  durationMs: number | null;
  stdout: string;
  stderr: string;
}

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
}

export interface Summary {
  total: number;
  sessionsRunning: number;
  running: number;
  idle: number;
  stalled: number;
  error: number;
}

export interface Snapshot {
  generatedAt: string;
  /** 모니터링(서버) 시작 시각 */
  startedAt: string;
  demo: boolean;
  refreshIntervalSec: number;
  configPath: string;
  /** config 파일이 없어 빈 목록으로 시작한 경우 */
  configMissing: boolean;
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
