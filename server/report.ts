import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ProjectSnapshot, Report, ReportMeta, RunResult, Snapshot } from '../shared/types.ts';

const STATE_LABEL = { running: '정상 실행', waiting: '입력 대기', idle: '유휴', stalled: '정지 의심', error: '오류' } as const;
const NAME_RE = /^\d{4}-\d{2}-\d{2}-morning-report\.md$/;
const OUTPUT_SUMMARY_LINES = 15;
const RUN_TAIL_LINES = 20;

const pad = (n: number) => String(n).padStart(2, '0');
const localDate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const localTime = (iso: string | null) => {
  if (!iso) return '-';
  const d = new Date(iso);
  return `${localDate(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

export const reportName = (now: Date) => `${localDate(now)}-morning-report.md`;

// 코드 펜스 안에 넣을 텍스트가 펜스를 닫아 버리지 않게 한다.
const fence = (text: string) => '```text\n' + text.replace(/```/g, "'''") + '\n```';
const tail = (text: string, n: number) => text.trimEnd().split('\n').slice(-n).join('\n');

function runSection(title: string, command: string | null, r: RunResult | null): string[] {
  const out = [`### ${title}`, ''];
  if (!command) return [...out, '- 등록된 명령 없음', ''];
  if (!r) return [...out, `- 실행하지 않음 (\`${command}\`)`, ''];
  if (r.running) return [...out, `- 실행 중 (\`${command}\`, 시작 ${localTime(r.startedAt)})`, ''];
  const verdict = r.timedOut ? '시간 초과' : r.exitCode === 0 ? '성공' : '실패';
  out.push(`- **${verdict}** — \`${command}\` · exit ${r.exitCode ?? '없음'} · ${((r.durationMs ?? 0) / 1000).toFixed(1)}초 · ${localTime(r.finishedAt)}`, '');
  if (verdict !== '성공') {
    const text = tail(r.stderr.trim() ? r.stderr : r.stdout, RUN_TAIL_LINES);
    if (text.trim()) out.push(fence(text), '');
  }
  return out;
}

function nextSteps(p: ProjectSnapshot): string[] {
  const steps: string[] = [];
  const failed = (r: RunResult | null) => r && !r.running && (r.timedOut || r.exitCode !== 0);
  if (!p.git.ok) steps.push(`저장소 경로와 config 를 확인: ${p.git.error ?? ''}`);
  if (p.tmux.configured && !p.tmux.exists) steps.push(`tmux 세션 \`${p.tmuxSession}\` 이 종료됨 — 에이전트가 끝난 것인지 죽은 것인지 확인`);
  if (p.status.state === 'waiting') steps.push(`입력 대기 중 — \`${p.tmux.attachCommand ?? ''}\` 로 접속해 응답: ${p.tmux.waitingPrompt ?? ''}`);
  if (p.status.state === 'stalled') steps.push(`정지 의심 — \`${p.tmux.attachCommand ?? '저장소'}\` 로 접속해 입력 대기 중인지 확인`);
  if (p.status.state === 'idle') steps.push('유휴 상태 — 작업이 끝났는지, 입력을 기다리는지 확인');
  if (p.logErrors.length) steps.push('로그의 오류 메시지 확인');
  if (failed(p.runs.test)) steps.push('실패한 테스트 수정');
  if (failed(p.runs.build)) steps.push('실패한 빌드 수정');
  if (p.testCommand && !p.runs.test) steps.push('테스트를 실행해 결과 확인');
  if (p.buildCommand && !p.runs.build) steps.push('빌드를 실행해 결과 확인');
  if (p.git.ok && !p.git.clean) steps.push(`커밋되지 않은 변경 ${p.git.changedFiles.length}개 파일 검토`);
  if (p.since?.commits.length) steps.push(`새 커밋 ${p.since.commits.length}개 리뷰`);
  return steps.length ? steps : ['특이 사항 없음'];
}

function projectSection(p: ProjectSnapshot): string[] {
  const out = [`## ${p.name} — ${STATE_LABEL[p.status.state]}`, ''];
  out.push(`- 저장소: \`${p.repoPath}\``);
  if (p.status.reasons.length) out.push(`- 판정 사유: ${p.status.reasons.join(', ')}`);
  if (p.since) out.push(`- 브랜치: \`${p.since.baseline.branch}\` (최초, ${localTime(p.since.baseline.at)}) → \`${p.git.branch}\` (최종)`);
  out.push(`- tmux: ${p.tmux.configured ? `\`${p.tmuxSession}\` ${p.tmux.exists ? '실행 중' : '종료됨'}` : '미등록'}`, '');

  const commits = p.since?.commits ?? [];
  out.push(`### 생성된 커밋 (${commits.length})`, '');
  out.push(...(commits.length ? commits.map((c) => `- \`${c.hash.slice(0, 7)}\` ${c.subject} — ${c.author}, ${localTime(c.date)}`) : ['- 없음']), '');

  const files = p.since?.files ?? [];
  out.push(`### 변경된 파일 (${files.length}) · +${p.since?.additions ?? 0} / -${p.since?.deletions ?? 0}`, '');
  out.push(...(files.length ? files.map((f) => `- \`${f.path}\` (+${f.additions} / -${f.deletions})`) : ['- 없음']), '');

  out.push('### 최근 터미널 출력', '');
  const lines = p.tmux.output.filter((l) => l.trim() !== '').slice(-OUTPUT_SUMMARY_LINES);
  out.push(lines.length ? fence(lines.join('\n')) : '- 출력 없음', '');

  out.push('### 발견된 오류', '');
  const errors = p.status.state === 'error' ? p.status.reasons : [];
  out.push(...(errors.length ? errors.map((e) => `- ${e}`) : ['- 없음']));
  if (p.logErrors.length) out.push('', fence(p.logErrors.join('\n')));
  out.push('');

  out.push(...runSection('테스트 결과', p.testCommand, p.runs.test));
  out.push(...runSection('빌드 결과', p.buildCommand, p.runs.build));

  out.push('### 다음에 확인할 항목', '', ...nextSteps(p).map((s) => `- [ ] ${s}`), '');
  return out;
}

export function buildReport(s: Snapshot, now: Date): string {
  const worked = s.projects.filter((p) => p.since && (p.since.commits.length || p.since.files.length));
  const { summary: m } = s;
  const out = [
    `# NightShift Morning Report — ${localDate(now)}`,
    '',
    ...(s.demo ? ['> demo mode 에서 생성된 예시 보고서입니다.', ''] : []),
    `- 모니터링 시작: ${localTime(s.startedAt)}`,
    `- 모니터링 종료(보고서 생성): ${localTime(now.toISOString())}`,
    `- 프로젝트 ${m.total}개: 정상 ${m.running} · 입력 대기 ${m.waiting} · 유휴 ${m.idle} · 정지 의심 ${m.stalled} · 오류 ${m.error}`,
    `- 작업한 프로젝트: ${worked.length ? worked.map((p) => p.name).join(', ') : '없음'}`,
    '',
  ];
  for (const p of s.projects) out.push(...projectSection(p));
  if (!s.projects.length) out.push('등록된 프로젝트가 없습니다.', '');
  return out.join('\n');
}

/** 같은 날짜의 보고서는 덮어쓴다. */
export async function saveReport(dir: string, s: Snapshot, now = new Date()): Promise<Report> {
  const report = { name: reportName(now), content: buildReport(s, now) };
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, report.name), report.content);
  return report;
}

export async function listReports(dir: string): Promise<ReportMeta[]> {
  const names = await readdir(dir).catch(() => [] as string[]);
  const metas = await Promise.all(
    names.filter((n) => NAME_RE.test(n)).map(async (name) => ({ name, modifiedAt: (await stat(path.join(dir, name))).mtime.toISOString() })),
  );
  return metas.sort((a, b) => b.name.localeCompare(a.name));
}

/** 이름이 보고서 파일명 형식이 아니거나 파일이 없으면 null. */
export async function readReport(dir: string, name: string): Promise<Report | null> {
  if (!NAME_RE.test(name)) return null;
  try {
    return { name, content: await readFile(path.join(dir, name), 'utf8') };
  } catch {
    return null;
  }
}
