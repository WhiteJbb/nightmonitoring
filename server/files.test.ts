import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listFiles, readText, writeText } from './files.ts';

describe('files', () => {
  let repo: string;
  let outside: string;
  beforeAll(async () => {
    repo = await mkdtemp(path.join(tmpdir(), 'nightshift-files-'));
    outside = await mkdtemp(path.join(tmpdir(), 'nightshift-outside-'));
    execFileSync('git', ['init', '-q', repo]);
    await mkdir(path.join(repo, 'src'));
    await writeFile(path.join(repo, 'src/app.ts'), 'export const a = 1;\n');
    await writeFile(path.join(repo, '.gitignore'), '.env\n');
    await writeFile(path.join(repo, '.env'), 'SECRET=1\n');
    await writeFile(path.join(repo, 'new.md'), '# 새 파일\n');
    await writeFile(path.join(repo, 'logo.bin'), Buffer.from([0x89, 0x50, 0x00, 0x01]));
    await writeFile(path.join(outside, 'secret.txt'), 'outside\n');
    await symlink(path.join(outside, 'secret.txt'), path.join(repo, 'link.txt'));
    await writeFile(path.join(repo, 'win.txt'), '\ufeffa\r\nb\r\n');
    execFileSync('git', ['-C', repo, 'add', 'src/app.ts', '.gitignore']);
    // 추적 중인 폴더를 .git 으로 가는 링크로 바꿔도 그 안을 읽지 못해야 한다
    await mkdir(path.join(repo, 'cfg'));
    await writeFile(path.join(repo, 'cfg/config'), 'tracked\n');
    execFileSync('git', ['-C', repo, 'add', 'cfg/config']);
    await rm(path.join(repo, 'cfg'), { recursive: true });
    await symlink(path.join(repo, '.git'), path.join(repo, 'cfg'));
  });
  afterAll(async () => {
    await rm(repo, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  it('lists tracked and new files, never ignored ones', async () => {
    expect(await listFiles(repo)).toEqual(['.gitignore', 'cfg', 'cfg/config', 'link.txt', 'logo.bin', 'new.md', 'src/app.ts', 'win.txt']);
    // 프로젝트 경로가 하위 폴더여도 맨 위 기준 (Git 상태의 바뀐 파일 경로와 맞춘다)
    expect(await listFiles(path.join(repo, 'src'))).toContain('src/app.ts');
    expect((await readText(path.join(repo, 'src'), 'new.md')).content).toBe('# 새 파일\n');
    await expect(listFiles(outside)).rejects.toMatchObject({ status: 400 });
  });

  it('reads and saves a text file; refuses to overwrite a file that changed after it was opened', async () => {
    const opened = await readText(repo, 'src/app.ts');
    expect(opened.content).toBe('export const a = 1;\n');
    const version = await writeText(repo, 'src/app.ts', 'export const a = 2;\n', opened.version);
    expect(await readFile(path.join(repo, 'src/app.ts'), 'utf8')).toBe('export const a = 2;\n');
    // 에이전트가 그 사이 고쳤다
    await writeFile(path.join(repo, 'src/app.ts'), 'export const a = 3;\n');
    await expect(writeText(repo, 'src/app.ts', 'mine', version)).rejects.toMatchObject({ status: 409 });
    expect(await readFile(path.join(repo, 'src/app.ts'), 'utf8')).toBe('export const a = 3;\n');
    // 두 화면이 같은 내용을 열어 동시에 저장하면 하나만 된다
    const both = (await readText(repo, 'src/app.ts')).version;
    const texts = ['first\n', 'second, longer\n'];
    const results = await Promise.allSettled(texts.map((t) => writeText(repo, 'src/app.ts', t, both)));
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(await readFile(path.join(repo, 'src/app.ts'), 'utf8')).toBe(texts[results.findIndex((r) => r.status === 'fulfilled')]);
  });

  it('keeps the bytes it does not edit: a BOM and CRLF survive a round trip', async () => {
    const f = await readText(repo, 'win.txt');
    expect(f.content).toBe('\ufeffa\r\nb\r\n');
    await writeText(repo, 'win.txt', f.content, f.version);
    expect(await readFile(path.join(repo, 'win.txt'), 'utf8')).toBe('\ufeffa\r\nb\r\n');
  });

  it('refuses ignored files, paths outside the list, links, and binary files', async () => {
    await expect(readText(repo, '.env')).rejects.toMatchObject({ status: 404 });
    await expect(readText(repo, '../' + path.basename(outside) + '/secret.txt')).rejects.toMatchObject({ status: 404 });
    await expect(readText(repo, 'link.txt')).rejects.toMatchObject({ status: 404 });
    await expect(readText(repo, 'cfg/config')).rejects.toMatchObject({ status: 404 });
    await expect(readText(repo, 'logo.bin')).rejects.toMatchObject({ status: 415 });
    await expect(writeText(repo, '.env', 'x', 'v')).rejects.toMatchObject({ status: 404 });
    expect(await readFile(path.join(repo, '.env'), 'utf8')).toBe('SECRET=1\n');
  });
});
