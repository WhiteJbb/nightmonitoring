import { useEffect, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import type { ConfigUpdate, ConfigView } from '../../shared/types.ts';
import { api, ApiError, errorMessage } from './api.ts';

const NUMBERS = [
  ['refreshIntervalSec', '갱신 주기(초)', 1, ''],
  ['idleMinutes', '유휴 판정(분)', 0, ''],
  ['stalledMinutes', '정지 의심 — 출력(분)', 0, '출력이 이 시간 동안 없고'],
  ['noCommitMinutes', '정지 의심 — Git(분)', 0, 'Git 변화도 없으면 정지 의심'],
  ['commandTimeoutSec', '명령 시간 제한(초)', 1, ''],
] as const;
type NumKey = (typeof NUMBERS)[number][0];

const TOGGLES = [
  ['ignoreSpinnerChanges', '숫자·스피너만 바뀌는 출력 무시', '경과 시간·스피너만 바뀌는 출력은 활동으로 치지 않습니다'],
  ['sessionExitIsError', 'tmux 세션이 없으면 오류', '등록된 세션이 사라지면 오류 상태로 표시합니다'],
  ['notifications', 'macOS 알림', '오류·입력 대기·정지 의심으로 바뀔 때 알림을 보냅니다'],
] as const;
type ToggleKey = (typeof TOGGLES)[number][0];

const PATTERNS = [
  ['errorPatterns', '오류 패턴', '출력·로그에서 오류로 판정할 줄'],
  ['errorIgnorePatterns', '오류 제외 패턴', '오류 패턴에 걸려도 무시할 줄'],
  ['promptPatterns', '입력 대기 패턴', '입력 대기 프롬프트로 판정할 줄'],
] as const;
type PatternKey = (typeof PATTERNS)[number][0];

interface DraftProject {
  id: string | null;
  name: string;
  repoPath: string;
  tmuxSession: string;
  logFile: string;
  testCommand: string | null;
  buildCommand: string | null;
  repoPathLocked: boolean;
  allowInput: boolean;
}

/** 입력 중인 폼 상태. 숫자는 비워 둘 수 있게 문자열로, 패턴은 줄바꿈으로 이은 문자열로 둔다. */
type Draft = Record<NumKey | PatternKey, string> &
  Record<ToggleKey, boolean> & { autoReport: boolean; autoReportTime: string; projects: DraftProject[] };

function toDraft({ settings: s, projects }: ConfigView): Draft {
  return {
    refreshIntervalSec: String(s.refreshIntervalSec),
    idleMinutes: String(s.thresholds.idleMinutes),
    stalledMinutes: String(s.thresholds.stalledMinutes),
    noCommitMinutes: String(s.thresholds.noCommitMinutes),
    commandTimeoutSec: String(s.commandTimeoutSec),
    ignoreSpinnerChanges: s.ignoreSpinnerChanges,
    sessionExitIsError: s.sessionExitIsError,
    notifications: s.notifications,
    autoReport: s.autoReportTime !== null,
    autoReportTime: s.autoReportTime ?? '07:00',
    errorPatterns: s.errorPatterns.join('\n'),
    errorIgnorePatterns: s.errorIgnorePatterns.join('\n'),
    promptPatterns: s.promptPatterns.join('\n'),
    projects: projects.map((p) => ({ ...p, tmuxSession: p.tmuxSession ?? '', logFile: p.logFile ?? '' })),
  };
}

// 빈 칸은 NaN(JSON 으로는 null)으로 보내 서버 검증에 걸리게 한다. Number('') 는 0 이라 그대로 쓰면 안 된다
const num = (s: string) => (s.trim() === '' ? NaN : Number(s));
const lines = (s: string) => s.split('\n').filter((l) => l.trim() !== '');

const ALLOW_INPUT_CONFIRM =
  '이 프로젝트의 tmux 세션에 브라우저에서 키 입력을 보낼 수 있게 됩니다.\n대시보드에 접속할 수 있는 사람은 누구나 이 Mac 계정으로 명령을 실행할 수 있습니다.\n\n켤까요?';

function toUpdate(d: Draft): Omit<ConfigUpdate, 'version'> {
  return {
    settings: {
      refreshIntervalSec: num(d.refreshIntervalSec),
      thresholds: {
        idleMinutes: num(d.idleMinutes),
        stalledMinutes: num(d.stalledMinutes),
        noCommitMinutes: num(d.noCommitMinutes),
      },
      errorPatterns: lines(d.errorPatterns),
      errorIgnorePatterns: lines(d.errorIgnorePatterns),
      promptPatterns: lines(d.promptPatterns),
      ignoreSpinnerChanges: d.ignoreSpinnerChanges,
      sessionExitIsError: d.sessionExitIsError,
      notifications: d.notifications,
      autoReportTime: d.autoReport ? d.autoReportTime : null,
      commandTimeoutSec: num(d.commandTimeoutSec),
    },
    projects: d.projects.map((p) => ({
      id: p.id,
      name: p.name.trim(),
      repoPath: p.repoPath.trim(),
      tmuxSession: p.tmuxSession.trim() || null,
      logFile: p.logFile.trim() || null,
      allowInput: p.allowInput,
    })),
  };
}

const BLANK_PROJECT: DraftProject = {
  id: null,
  name: '',
  repoPath: '',
  tmuxSession: '',
  logFile: '',
  testCommand: null,
  buildCommand: null,
  repoPathLocked: false,
  allowInput: false,
};

function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="field">
      <label>
        <span>{label}</span>
        {children}
      </label>
      {hint && <p className="hint">{hint}</p>}
    </div>
  );
}

export function Settings() {
  const [view, setView] = useState<ConfigView | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<ApiError | Error | null>(null);

  const loaded = (v: ConfigView) => {
    setView(v);
    setDraft(toDraft(v));
  };
  const load = () => {
    setLoadError(null);
    api.config().then(loaded, (e: unknown) => setLoadError(errorMessage(e)));
  };
  useEffect(load, []); // 마운트 시 한 번만 불러온다

  if (loadError !== null) {
    return (
      <div className="notice error" role="alert">
        <strong>설정을 불러오지 못했습니다.</strong>
        <p>{loadError}</p>
        <button type="button" onClick={load}>
          다시 시도
        </button>
      </div>
    );
  }
  if (!view || !draft) return <div className="notice">불러오는 중…</div>;

  const ro = !view.editable;
  const dirty = JSON.stringify(toUpdate(draft)) !== JSON.stringify(toUpdate(toDraft(view)));

  const set = (patch: Partial<Draft>) => {
    setDraft({ ...draft, ...patch });
    setSaved(false);
  };
  const setProject = (i: number, patch: Partial<DraftProject>) =>
    set({ projects: draft.projects.map((p, j) => (j === i ? { ...p, ...patch } : p)) });
  const removeProject = (i: number) => {
    const name = draft.projects[i]?.name || '새 프로젝트';
    if (!window.confirm(`"${name}" 프로젝트를 목록에서 삭제할까요?\n저장하기 전까지는 반영되지 않습니다.`)) return;
    set({ projects: draft.projects.filter((_, j) => j !== i) });
  };

  const save = (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setSaved(false);
    setSaveError(null);
    api
      .saveConfig({ ...toUpdate(draft), version: view.version })
      .then((v) => {
        loaded(v);
        setSaved(true);
      })
      .catch((err: unknown) => setSaveError(err instanceof Error ? err : new Error(String(err))))
      .finally(() => setSaving(false));
  };
  // 파일이 다른 곳에서 바뀐 경우(409): 최신 내용을 다시 불러온다. 지금 화면의 수정은 버려진다.
  const reloadLatest = () => {
    setSaveError(null);
    setSaved(false);
    load();
  };
  const revert = () => {
    setDraft(toDraft(view));
    setSaved(false);
    setSaveError(null);
  };

  return (
    <form className="settings" onSubmit={save}>
      <div className="detail-head">
        <h1>설정</h1>
      </div>
      <p className="hint mono wrap">
        {view.path} · {view.format}
      </p>
      {ro && (
        <div className="notice banner" role="status">
          <strong>읽기 전용</strong>
          <p>{view.readOnlyReason ?? '지금은 설정을 저장할 수 없습니다.'}</p>
        </div>
      )}

      <h3>파일에서만 바꿀 수 있는 값</h3>
      <dl className="kv">
        <dt>host</dt>
        <dd className="wrap">{view.fileOnly.host}</dd>
        <dt>port</dt>
        <dd>{view.fileOnly.port}</dd>
        <dt>reportsDir</dt>
        <dd className="wrap">{view.fileOnly.reportsDir}</dd>
        <dt>allowedHosts</dt>
        <dd className="wrap">{view.fileOnly.allowedHosts.length ? view.fileOnly.allowedHosts.join(', ') : <span className="dim">없음</span>}</dd>
      </dl>
      <p className="hint">이 값들은 config 파일을 직접 고친 뒤 서버를 다시 시작해야 바뀝니다.</p>

      <h3>전역 설정</h3>
      <div className="settings-grid nums">
        {NUMBERS.map(([key, label, min, hint]) => (
          <Field key={key} label={label} hint={hint}>
            <input
              type="number"
              min={min}
              step="any"
              required
              value={draft[key]}
              disabled={ro}
              onChange={(e) => set({ [key]: e.target.value })}
            />
          </Field>
        ))}
      </div>
      <div className="toggles">
        <div className="toggle-row">
          <label className="check">
            <input
              type="checkbox"
              checked={draft.autoReport}
              disabled={ro}
              onChange={(e) => set({ autoReport: e.target.checked })}
            />
            Morning Report 자동 생성
          </label>
          <input
            type="time"
            aria-label="자동 생성 시각"
            required={draft.autoReport}
            value={draft.autoReportTime}
            disabled={ro || !draft.autoReport}
            onChange={(e) => set({ autoReportTime: e.target.value })}
          />
        </div>
        {TOGGLES.map(([key, label, hint]) => (
          <div className="toggle-row" key={key}>
            <label className="check">
              <input type="checkbox" checked={draft[key]} disabled={ro} onChange={(e) => set({ [key]: e.target.checked })} />
              {label}
            </label>
            <p className="hint">{hint}</p>
          </div>
        ))}
      </div>

      <h3>패턴</h3>
      <p className="hint">
        한 줄에 하나씩 적습니다. 일반 문자열은 대소문자를 무시한 부분 일치, <code>/…/flags</code> 형식은 정규식입니다.
      </p>
      <div className="settings-grid">
        {PATTERNS.map(([key, label, hint]) => (
          <Field key={key} label={label} hint={hint}>
            <textarea
              rows={6}
              spellCheck={false}
              value={draft[key]}
              disabled={ro}
              onChange={(e) => set({ [key]: e.target.value })}
            />
          </Field>
        ))}
      </div>

      <h3>프로젝트</h3>
      <p className="hint">
        테스트·빌드 명령은 config 파일에서만 등록·수정할 수 있습니다. 여기서 추가한 프로젝트에는 명령이 없습니다.
      </p>
      {draft.projects.length === 0 && <p className="dim">등록된 프로젝트가 없습니다.</p>}
      {draft.projects.map((p, i) => (
        // 모든 입력이 제어 컴포넌트라 index key 로도 삭제 시 값이 섞이지 않는다
        <fieldset className="project-edit" key={i}>
          <legend>{p.name || '새 프로젝트'}</legend>
          <div className="settings-grid">
            <Field
              label="이름"
              hint={
                p.id !== null &&
                '이름을 바꾸면 프로젝트 id 가 바뀌어 "모니터링 시작 이후" 기준점과 실행 이력이 초기화됩니다.'
              }
            >
              <input type="text" required value={p.name} disabled={ro} onChange={(e) => setProject(i, { name: e.target.value })} />
            </Field>
            <Field
              label="저장소 경로"
              hint={p.repoPathLocked && '테스트·빌드 명령이 등록된 프로젝트의 경로는 config 파일에서만 바꿀 수 있습니다'}
            >
              <input
                type="text"
                className="mono"
                required
                spellCheck={false}
                value={p.repoPath}
                disabled={ro || p.repoPathLocked}
                onChange={(e) => setProject(i, { repoPath: e.target.value })}
              />
            </Field>
            <Field
              label="tmux 세션"
              hint="비워 두면 세션을 감시하지 않습니다"
            >
              <input
                type="text"
                className="mono"
                spellCheck={false}
                value={p.tmuxSession}
                disabled={ro}
                onChange={(e) => setProject(i, { tmuxSession: e.target.value })}
              />
            </Field>
            <Field label="로그 파일" hint="비워 두면 로그를 읽지 않습니다. 저장소 경로 기준 상대 경로도 됩니다">
              <input
                type="text"
                className="mono"
                spellCheck={false}
                value={p.logFile}
                disabled={ro}
                onChange={(e) => setProject(i, { logFile: e.target.value })}
              />
            </Field>
          </div>
          <dl className="kv">
            <dt>테스트 명령</dt>
            <dd className="wrap">{p.testCommand ?? <span className="dim">등록 안 됨</span>}</dd>
            <dt>빌드 명령</dt>
            <dd className="wrap">{p.buildCommand ?? <span className="dim">등록 안 됨</span>}</dd>
          </dl>
          <div className="field">
            <label className="check">
              <input
                type="checkbox"
                checked={p.allowInput}
                disabled={ro}
                onChange={(e) => {
                  // 켜는 것은 "브라우저에서 이 계정으로 명령 실행"을 여는 일이라 한 번 확인한다.
                  if (e.target.checked && !window.confirm(ALLOW_INPUT_CONFIRM)) return;
                  setProject(i, { allowInput: e.target.checked });
                }}
              />
              터미널 입력 허용
            </label>
            <p className="hint">
              켜면 터미널 탭에서 이 프로젝트의 tmux 세션으로 키 입력을 보낼 수 있습니다. 보낸 내용은 서버에 기록됩니다.
            </p>
          </div>
          {!ro && (
            <button type="button" className="danger" onClick={() => removeProject(i)}>
              삭제
            </button>
          )}
        </fieldset>
      ))}
      {!ro && (
        <button type="button" onClick={() => set({ projects: [...draft.projects, BLANK_PROJECT] })}>
          프로젝트 추가
        </button>
      )}

      {!ro && (
        <div className="settings-actions">
          <button type="submit" className="primary" disabled={!dirty || saving}>
            {saving ? '저장 중…' : '저장'}
          </button>
          <button type="button" onClick={revert} disabled={!dirty || saving}>
            되돌리기
          </button>
          {saved && (
            <span className="ok" role="status">
              저장됨 — 바로 적용되었습니다
            </span>
          )}
          {saveError && (
            <div className="notice error" role="alert">
              <strong>저장하지 못했습니다.</strong>
              <p>{saveError.message}</p>
              {saveError instanceof ApiError && saveError.issues.length > 0 && (
                <ul className="mono">
                  {saveError.issues.map((issue) => (
                    <li key={issue}>{issue}</li>
                  ))}
                </ul>
              )}
              {saveError instanceof ApiError && saveError.status === 409 && (
                <>
                  <p className="dim">다시 불러오면 이 화면에서 수정한 내용은 사라집니다.</p>
                  <button type="button" onClick={reloadLatest}>
                    다시 불러오기
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      )}
    </form>
  );
}
