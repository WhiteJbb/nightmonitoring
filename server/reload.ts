import type { Config } from './config.ts';
import { ConfigError, loadConfig } from './config.ts';
import type { Collector, Monitor } from './monitor.ts';
import type { Runner } from './runner.ts';

export interface ReloadDeps {
  configPath: string;
  baseDir: string;
  monitor: Monitor;
  runner: Runner;
  collectorFor: (config: Config) => Collector;
}

/**
 * config 파일을 다시 읽어 적용한다. 실패하면 이전 설정을 유지하고 오류를 스냅샷에 싣는다.
 * host/port 는 이미 listen 중이라 바뀌지 않는다 (재시작 필요).
 */
export async function reloadConfig({ configPath, baseDir, monitor, runner, collectorFor }: ReloadDeps): Promise<'applied' | 'error'> {
  try {
    const { config, missing } = loadConfig(configPath, baseDir);
    if (missing && monitor.config.projects.length) throw new ConfigError([`${configPath}: 파일이 없습니다`]);
    const old = monitor.config;
    if (config.host !== old.host || config.port !== old.port) console.warn('host/port 변경은 서버를 재시작해야 적용됩니다.');
    runner.timeoutSec = config.commandTimeoutSec;
    // 같은 id 가 다른 저장소를 가리키게 됐거나 사라졌으면 이전 저장소의 실행 결과를 버린다.
    const next = new Map(config.projects.map((p) => [p.id, p.repoPath]));
    for (const p of old.projects) if (next.get(p.id) !== p.repoPath) runner.forget(p.id);
    await monitor.setConfig({ ...config, host: old.host, port: old.port }, collectorFor(config), missing);
    console.log(`config 를 다시 읽었습니다: 프로젝트 ${config.projects.length}개`);
    return 'applied';
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`config 를 다시 읽지 못했습니다. 이전 설정을 유지합니다.\n${message}`);
    monitor.setConfigError(message);
    return 'error';
  }
}
