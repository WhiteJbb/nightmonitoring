import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parseConfig } from './config.ts';
import { demoCollector, demoConfig, seedDemoRuns } from './demo.ts';
import { Monitor } from './monitor.ts';
import { buildReport, listReports, readReport, reportName, saveReport } from './report.ts';
import { Runner } from './runner.ts';

const NOW = new Date(2026, 9, 5, 7, 30);

async function demoSnapshot() {
  const runner = new Runner({ timeoutSec: 1, logDir: null });
  seedDemoRuns(runner, () => NOW.getTime());
  const m = new Monitor({ config: demoConfig(parseConfig({}, '/base')), collector: demoCollector(() => NOW.getTime()), runs: runner.get, demo: true, now: () => NOW.getTime() });
  await m.tick();
  return m.snapshot;
}

describe('morning report', () => {
  it('names the file by local date', () => {
    expect(reportName(NOW)).toBe('2026-10-05-morning-report.md');
  });

  it('includes every required section', async () => {
    const md = buildReport(await demoSnapshot(), NOW);
    for (const text of ['모니터링 시작', '모니터링 종료', '작업한 프로젝트: api-server, web-frontend, mobile-app, payments-service, docs-site', '## mobile-app — 입력 대기', '`main` (최초', '### 생성된 커밋 (3)', '### 변경된 파일', '### 최근 터미널 출력', '### 발견된 오류', '- 테스트 실패 (exit 1)', '### 테스트 결과', '**실패** — `npm test` · exit 1', '### 빌드 결과', '### 다음에 확인할 항목', '- [ ] 실패한 테스트 수정', 'tmux 세션 `pipeline-agent` 이 종료됨']) {
      expect(md).toContain(text);
    }
  });

  it('handles an empty project list', async () => {
    const m = new Monitor({ config: parseConfig({}, '/base'), collector: demoCollector(), runs: () => ({ test: null, build: null }) });
    expect(buildReport(m.snapshot, NOW)).toContain('등록된 프로젝트가 없습니다.');
  });
});

describe('report files', () => {
  const dirs: string[] = [];
  afterAll(() => Promise.all(dirs.map((d) => rm(d, { recursive: true }))));

  it('saves, lists and reads; rejects path traversal', async () => {
    const dir = path.join(await mkdtemp(path.join(tmpdir(), 'nightshift-')), 'reports');
    dirs.push(path.dirname(dir));
    expect(await listReports(dir)).toEqual([]);
    const saved = await saveReport(dir, await demoSnapshot(), NOW);
    expect((await listReports(dir)).map((r) => r.name)).toEqual(['2026-10-05-morning-report.md']);
    expect(await readReport(dir, saved.name)).toEqual(saved);
    expect(await readReport(dir, '../../etc/passwd')).toBeNull();
    expect(await readReport(dir, '2026-01-01-morning-report.md')).toBeNull();
  });
});
