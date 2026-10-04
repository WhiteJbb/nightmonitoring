import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { compileMatcher } from './logs.ts';

export interface ProjectConfig {
  id: string;
  name: string;
  repoPath: string;
  tmuxSession: string | null;
  testCommand: string | null;
  buildCommand: string | null;
  logFile: string | null;
}

export interface Thresholds {
  idleMinutes: number;
  stalledMinutes: number;
  noCommitMinutes: number;
}

export interface Config {
  host: string;
  port: number;
  refreshIntervalSec: number;
  thresholds: Thresholds;
  /** 로그에서 찾을 패턴. 일반 문자열(대소문자 무시 부분 일치) 또는 "/정규식/플래그" */
  errorPatterns: string[];
  /** 이 패턴에 걸리는 줄은 오류로 보지 않는다 */
  errorIgnorePatterns: string[];
  /** 터미널 마지막 줄들에서 찾을 입력 대기 프롬프트 패턴 */
  promptPatterns: string[];
  /** 숫자·스피너 문자만 바뀌는 출력 변화는 활동으로 보지 않는다 */
  ignoreSpinnerChanges: boolean;
  sessionExitIsError: boolean;
  /** 상태가 입력 대기·정지 의심·오류로 바뀔 때 macOS 알림 */
  notifications: boolean;
  /** Morning Report 자동 생성 시각 "HH:MM" (로컬 시간). null 이면 끔 */
  autoReportTime: string | null;
  commandTimeoutSec: number;
  reportsDir: string;
  projects: ProjectConfig[];
}

export const DEFAULTS = {
  host: '127.0.0.1',
  port: 4477,
  refreshIntervalSec: 5,
  thresholds: { idleMinutes: 15, stalledMinutes: 30, noCommitMinutes: 30 },
  errorPatterns: ['error', 'failed', 'exception'],
  errorIgnorePatterns: ['0 errors', 'no errors', '0 failed'],
  promptPatterns: ['Do you want to', 'Would you like to', '(y/n)', '[y/n]', '(yes/no)', 'Press Enter to continue', '/❯\\s*1\\.\\s*Yes/'],
  ignoreSpinnerChanges: true,
  sessionExitIsError: true,
  notifications: true,
  autoReportTime: null as string | null,
  commandTimeoutSec: 600,
  reportsDir: 'reports',
};

export class ConfigError extends Error {
  issues: string[];
  constructor(issues: string[]) {
    super(`config 오류:\n${issues.map((i) => `  - ${i}`).join('\n')}`);
    this.issues = issues;
  }
}

// tmux 대상 문법(:, ., 선행 $ = @ %)과 옵션으로 해석될 수 있는 선행 '-'를 막는다.
const SESSION_RE = /^[^\s:.$=@%-][^\s:.]*$/;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

function expandPath(p: string, baseDir: string): string {
  if (p === '~' || p.startsWith('~/')) p = path.join(homedir(), p.slice(1));
  return path.resolve(baseDir, p);
}

export function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9가-힣]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'project'
  );
}

/** raw JSON 값을 검증해 기본값이 채워진 Config 로 만든다. 문제가 있으면 ConfigError. */
export function parseConfig(raw: unknown, baseDir: string): Config {
  const issues: string[] = [];
  if (!isObj(raw)) throw new ConfigError(['최상위 값은 객체여야 합니다']);

  const num = (obj: Obj, key: string, fallback: number, where: string, min: number): number => {
    const v = obj[key];
    if (v === undefined) return fallback;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < min) {
      issues.push(`${where}${key}: ${min} 이상의 숫자여야 합니다`);
      return fallback;
    }
    return v;
  };
  const optStr = (obj: Obj, key: string, where: string): string | null => {
    const v = obj[key];
    if (v === undefined || v === null || v === '') return null;
    if (typeof v !== 'string') {
      issues.push(`${where}${key}: 문자열이어야 합니다`);
      return null;
    }
    return v;
  };

  const t = raw.thresholds === undefined ? {} : raw.thresholds;
  if (!isObj(t)) issues.push('thresholds: 객체여야 합니다');
  const tObj = isObj(t) ? t : {};
  const thresholds: Thresholds = {
    idleMinutes: num(tObj, 'idleMinutes', DEFAULTS.thresholds.idleMinutes, 'thresholds.', 0),
    stalledMinutes: num(tObj, 'stalledMinutes', DEFAULTS.thresholds.stalledMinutes, 'thresholds.', 0),
    noCommitMinutes: num(tObj, 'noCommitMinutes', DEFAULTS.thresholds.noCommitMinutes, 'thresholds.', 0),
  };

  const patterns = (key: string, fallback: string[]): string[] => {
    const v = raw[key];
    if (v === undefined) return fallback;
    if (!Array.isArray(v) || !v.every((p) => typeof p === 'string')) {
      issues.push(`${key}: 문자열 배열이어야 합니다`);
      return fallback;
    }
    const list = v.filter((p) => p.trim() !== '');
    try {
      compileMatcher(list);
    } catch (e) {
      issues.push(`${key}: 잘못된 정규식 (${(e as Error).message})`);
    }
    return list;
  };
  const bool = (key: string, fallback: boolean): boolean => {
    const v = raw[key];
    if (v === undefined) return fallback;
    if (typeof v !== 'boolean') issues.push(`${key}: true 또는 false 여야 합니다`);
    return typeof v === 'boolean' ? v : fallback;
  };

  const autoReportTime = optStr(raw, 'autoReportTime', '');
  if (autoReportTime && !/^([01]\d|2[0-3]):[0-5]\d$/.test(autoReportTime)) issues.push('autoReportTime: "HH:MM" 형식이어야 합니다 (예: "07:00")');

  const projects: ProjectConfig[] = [];
  const rawProjects = raw.projects ?? [];
  if (!Array.isArray(rawProjects)) issues.push('projects: 배열이어야 합니다');
  else {
    const ids = new Set<string>();
    rawProjects.forEach((p: unknown, i) => {
      const where = `projects[${i}].`;
      if (!isObj(p)) return issues.push(`projects[${i}]: 객체여야 합니다`);
      const name = optStr(p, 'name', where);
      const repoPath = optStr(p, 'repoPath', where);
      if (!name) issues.push(`${where}name: 필수입니다`);
      if (!repoPath) issues.push(`${where}repoPath: 필수입니다`);
      const tmuxSession = optStr(p, 'tmuxSession', where);
      if (tmuxSession && !SESSION_RE.test(tmuxSession)) {
        issues.push(`${where}tmuxSession: 공백, ':', '.' 을 포함하거나 '-', '$', '=', '@', '%' 로 시작할 수 없습니다`);
      }
      if (!name || !repoPath) return;
      let id = slugify(name);
      for (let n = 2; ids.has(id); n++) id = `${slugify(name)}-${n}`;
      ids.add(id);
      const repo = expandPath(repoPath, baseDir);
      const logFile = optStr(p, 'logFile', where);
      projects.push({
        id,
        name,
        repoPath: repo,
        tmuxSession,
        testCommand: optStr(p, 'testCommand', where),
        buildCommand: optStr(p, 'buildCommand', where),
        logFile: logFile ? expandPath(logFile, repo) : null,
      });
    });
  }

  const config: Config = {
    host: optStr(raw, 'host', '') ?? DEFAULTS.host,
    port: num(raw, 'port', DEFAULTS.port, '', 1),
    refreshIntervalSec: num(raw, 'refreshIntervalSec', DEFAULTS.refreshIntervalSec, '', 1),
    thresholds,
    errorPatterns: patterns('errorPatterns', DEFAULTS.errorPatterns),
    errorIgnorePatterns: patterns('errorIgnorePatterns', DEFAULTS.errorIgnorePatterns),
    promptPatterns: patterns('promptPatterns', DEFAULTS.promptPatterns),
    ignoreSpinnerChanges: bool('ignoreSpinnerChanges', DEFAULTS.ignoreSpinnerChanges),
    sessionExitIsError: bool('sessionExitIsError', DEFAULTS.sessionExitIsError),
    notifications: bool('notifications', DEFAULTS.notifications),
    autoReportTime,
    commandTimeoutSec: num(raw, 'commandTimeoutSec', DEFAULTS.commandTimeoutSec, '', 1),
    reportsDir: expandPath(optStr(raw, 'reportsDir', '') ?? DEFAULTS.reportsDir, baseDir),
    projects,
  };
  if (issues.length) throw new ConfigError(issues);
  return config;
}

/** config 파일이 없으면 프로젝트 없는 기본 설정으로 시작한다 (missing=true). */
export function loadConfig(file: string, baseDir: string): { config: Config; missing: boolean } {
  if (!existsSync(file)) return { config: parseConfig({}, baseDir), missing: true };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new ConfigError([`${file}: JSON 파싱 실패 (${(e as Error).message})`]);
  }
  return { config: parseConfig(raw, baseDir), missing: false };
}
