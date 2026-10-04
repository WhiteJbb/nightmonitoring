// UI 에서의 설정 편집. 편집 가능한 필드만 골라 파일에 반영하고,
// 테스트·빌드 명령과 그 명령이 실행되는 경로는 절대 요청 본문에서 받지 않는다.
// 터미널 입력 허용(allowInput)은 사용자의 결정으로 UI 에서 켜고 끌 수 있다.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Document, parseDocument } from 'yaml';
import type { ConfigProjectView, ConfigView, EditableSettings } from '../shared/types.ts';
import type { Config } from './config.ts';
import { ConfigError, expandPath, parseConfig } from './config.ts';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

const SETTING_KEYS = ['refreshIntervalSec', 'errorPatterns', 'errorIgnorePatterns', 'promptPatterns', 'ignoreSpinnerChanges', 'sessionExitIsError', 'notifications', 'autoReportTime', 'commandTimeoutSec', 'ntfyUrl'] as const;
const THRESHOLD_KEYS = ['idleMinutes', 'stalledMinutes', 'noCommitMinutes'] as const;

const isYaml = (file: string) => /\.ya?ml$/i.test(file);

/** 설정 화면을 연 뒤 파일이 다른 곳에서 바뀌었을 때 (HTTP 409) */
export class ConfigConflict extends Error {}

/** 파일 내용의 지문. 파일이 없으면 'none'. */
export function versionOf(file: string): string {
  return existsSync(file) ? createHash('sha1').update(readFileSync(file)).digest('hex') : 'none';
}

function readRaw(file: string): Obj {
  if (!existsSync(file)) return {};
  const text = readFileSync(file, 'utf8');
  let raw: unknown;
  try {
    raw = isYaml(file) ? parseDocument(text).toJS() : JSON.parse(text);
  } catch (e) {
    throw new ConfigError([`${file}: 파싱 실패 (${(e as Error).message})`]);
  }
  if (raw === null || raw === undefined) return {};
  if (!isObj(raw)) throw new ConfigError(['최상위 값은 객체여야 합니다']);
  return raw;
}

const settingsOf = (c: Config): EditableSettings => ({
  refreshIntervalSec: c.refreshIntervalSec,
  thresholds: c.thresholds,
  errorPatterns: c.errorPatterns,
  errorIgnorePatterns: c.errorIgnorePatterns,
  promptPatterns: c.promptPatterns,
  ignoreSpinnerChanges: c.ignoreSpinnerChanges,
  sessionExitIsError: c.sessionExitIsError,
  notifications: c.notifications,
  autoReportTime: c.autoReportTime,
  commandTimeoutSec: c.commandTimeoutSec,
  ntfyUrl: c.ntfyUrl,
});

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

/** demo 처럼 파일과 무관한 설정을 읽기 전용으로 보여 줄 때. */
export function readOnlyView(config: Config, file: string, reason: string): ConfigView {
  return {
    path: file,
    version: '',
    format: isYaml(file) ? 'yaml' : 'json',
    editable: false,
    readOnlyReason: reason,
    settings: settingsOf(config),
    projects: config.projects.map((p) => ({ ...p, repoPathLocked: true })),
    fileOnly: { host: config.host, port: config.port, reportsDir: config.reportsDir, allowedHosts: config.allowedHosts },
  };
}

/** 파일에 적힌 그대로의 값(경로는 원문 문자열)으로 편집 화면용 뷰를 만든다. 파일이 잘못됐으면 ConfigError. */
export function readConfigView(file: string, baseDir: string): ConfigView {
  const raw = readRaw(file);
  const config = parseConfig(raw, baseDir);
  const rawProjects = (raw.projects ?? []) as Obj[];
  const projects: ConfigProjectView[] = config.projects.map((p, i) => {
    const r = rawProjects[i]!;
    return {
      id: p.id,
      name: p.name,
      repoPath: String(r.repoPath),
      tmuxSession: p.tmuxSession,
      logFile: str(r.logFile),
      testCommand: p.testCommand,
      buildCommand: p.buildCommand,
      repoPathLocked: !!(p.testCommand || p.buildCommand),
      allowInput: p.allowInput,
    };
  });
  return {
    path: file,
    version: versionOf(file),
    format: isYaml(file) ? 'yaml' : 'json',
    editable: true,
    readOnlyReason: null,
    settings: settingsOf(config),
    projects,
    fileOnly: { host: config.host, port: config.port, reportsDir: config.reportsDir, allowedHosts: config.allowedHosts },
  };
}

/**
 * 신뢰할 수 없는 요청 본문에서 편집 가능한 필드만 골라 새 raw config 를 만든다.
 * 기존 프로젝트의 testCommand/buildCommand 는 파일의 값을 그대로 유지하고,
 * 새 프로젝트에는 명령이 없다. 본문에 명령이 들어 있어도 읽지 않는다.
 * allowInput 은 본문의 값을 따르고, 본문에 없으면 파일의 값을 유지한다.
 */
export function mergeUpdate(raw: Obj, current: Config, update: unknown, baseDir: string): Obj {
  if (!isObj(update) || !isObj(update.settings) || !Array.isArray(update.projects)) throw new ConfigError(['요청 형식이 잘못되었습니다 (settings, projects 필요)']);
  const issues: string[] = [];
  const next: Obj = { ...raw };

  // 파일에 이미 있는 키이거나 현재 값과 달라진 것만 쓴다 (기본값으로 파일을 채우지 않는다).
  const changed = (inFile: boolean, value: unknown, effective: unknown) => inFile || JSON.stringify(value) !== JSON.stringify(effective);
  const s = update.settings;
  for (const key of SETTING_KEYS) if (key in s && changed(key in raw, s[key], current[key])) next[key] = s[key];
  if (isObj(s.thresholds)) {
    const t: Obj = isObj(raw.thresholds) ? { ...raw.thresholds } : {};
    for (const key of THRESHOLD_KEYS) if (key in s.thresholds && changed(key in t, s.thresholds[key], current.thresholds[key])) t[key] = s.thresholds[key];
    if (Object.keys(t).length) next.thresholds = t;
  }

  const rawProjects = (raw.projects ?? []) as Obj[];
  const byId = new Map(current.projects.map((p, i) => [p.id, { parsed: p, raw: rawProjects[i]! }]));
  const used = new Set<string>();
  next.projects = update.projects.map((u: unknown, i) => {
    const where = `projects[${i}]`;
    if (!isObj(u)) {
      issues.push(`${where}: 객체여야 합니다`);
      return {};
    }
    let base: Obj = {};
    if (u.id !== null && u.id !== undefined) {
      const existing = typeof u.id === 'string' ? byId.get(u.id) : undefined;
      if (!existing || used.has(u.id as string)) {
        issues.push(`${where}.id: 존재하지 않거나 중복된 프로젝트입니다`);
        return {};
      }
      used.add(u.id as string);
      base = { ...existing.raw };
      const locked = existing.parsed.testCommand || existing.parsed.buildCommand;
      if (locked && (typeof u.repoPath !== 'string' || expandPath(u.repoPath, baseDir) !== existing.parsed.repoPath)) {
        issues.push(`${where}.repoPath: 테스트·빌드 명령이 등록된 프로젝트의 경로는 config 파일에서만 바꿀 수 있습니다`);
      }
    }
    const project: Obj = { ...base, name: u.name, repoPath: u.repoPath };
    for (const key of ['tmuxSession', 'logFile'] as const) {
      if (u[key] === null || u[key] === undefined || u[key] === '') delete project[key];
      else project[key] = u[key];
    }
    if (u.allowInput !== undefined && typeof u.allowInput !== 'boolean') issues.push(`${where}.allowInput: true 또는 false 여야 합니다`);
    if (u.allowInput === true) project.allowInput = true;
    else if (u.allowInput === false) delete project.allowInput;
    return project;
  });
  if (issues.length) throw new ConfigError(issues);
  return next;
}

/** 임시 파일에 쓴 뒤 rename. YAML 은 바뀐 최상위 키만 갈아 끼워 다른 곳의 주석을 보존한다. */
function writeRaw(file: string, before: Obj, next: Obj): void {
  let text: string;
  if (isYaml(file)) {
    const parsed = parseDocument(existsSync(file) ? readFileSync(file, 'utf8') : '');
    const doc: Document = parsed.contents === null ? new Document({}) : parsed;
    for (const [key, value] of Object.entries(next)) {
      if (JSON.stringify(before[key]) !== JSON.stringify(value)) doc.set(key, value);
    }
    text = String(doc);
  } else {
    text = `${JSON.stringify(next, null, 2)}\n`;
  }
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

/** 요청을 검증해 파일에 쓴다. 잘못된 값이면 파일을 건드리지 않고 ConfigError. */
export function applyConfigUpdate(file: string, baseDir: string, update: unknown): void {
  // 화면을 연 뒤 파일이 바뀌었으면 덮어쓰지 않는다. 읽기~쓰기가 모두 동기라 이 요청 안에서는 끼어들 틈이 없다.
  if (!isObj(update) || update.version !== versionOf(file)) {
    throw new ConfigConflict('설정 화면을 연 뒤 config 파일이 다른 곳에서 수정되었습니다. 다시 불러온 뒤 수정해 주세요.');
  }
  const raw = readRaw(file);
  const next = mergeUpdate(raw, parseConfig(raw, baseDir), update, baseDir);
  parseConfig(next, baseDir); // 전체 검증. 문제가 있으면 여기서 throw
  writeRaw(file, raw, next);
}
