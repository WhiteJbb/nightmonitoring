import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fsOp, listFiles, listIgnored, MAX_IMAGE_BYTES, readRaw, readText, writeText } from './files.ts';

describe('files', () => {
  let repo: string;
  let outside: string;
  beforeAll(async () => {
    repo = await mkdtemp(path.join(tmpdir(), 'nightshift-files-'));
    outside = await mkdtemp(path.join(tmpdir(), 'nightshift-outside-'));
    execFileSync('git', ['init', '-q', repo]);
    await mkdir(path.join(repo, 'src'));
    await writeFile(path.join(repo, 'src/app.ts'), 'export const a = 1;\n');
    await writeFile(path.join(repo, '.gitignore'), '.env\nbuild/\n');
    await mkdir(path.join(repo, 'build'));
    await writeFile(path.join(repo, 'build/out.js'), 'x\n');
    // 무시된 폴더에 억지로 추적시킨 파일이 있으면 Git 이 폴더를 접지 않는다
    await writeFile(path.join(repo, 'build/keep.js'), 'k\n');
    execFileSync('git', ['-C', repo, 'add', '-f', 'build/keep.js']);
    await writeFile(path.join(repo, '.env'), 'SECRET=1\n');
    await writeFile(path.join(repo, 'new.md'), '# 새 파일\n');
    await writeFile(path.join(repo, 'logo.bin'), Buffer.from([0x89, 0x50, 0x00, 0x01]));
    await writeFile(path.join(outside, 'secret.txt'), 'outside\n');
    await symlink(path.join(outside, 'secret.txt'), path.join(repo, 'link.txt'));
    await writeFile(path.join(repo, 'win.txt'), '\ufeffa\r\nb\r\n');
    await writeFile(path.join(repo, 'gone.txt'), 'bye\n');
    execFileSync('git', ['-C', repo, 'add', 'src/app.ts', '.gitignore', 'gone.txt']);
    await rm(path.join(repo, 'gone.txt'));
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

  it('lists tracked and new files, never ignored or deleted ones', async () => {
    expect(await listFiles(repo)).toEqual(['.gitignore', 'build/keep.js', 'cfg', 'cfg/config', 'link.txt', 'logo.bin', 'new.md', 'src/app.ts', 'win.txt']);
    // 프로젝트 경로가 하위 폴더여도 맨 위 기준 (Git 상태의 바뀐 파일 경로와 맞춘다)
    expect(await listFiles(path.join(repo, 'src'))).toContain('src/app.ts');
    expect((await readText(path.join(repo, 'src'), 'new.md')).content).toBe('# 새 파일\n');
    await expect(listFiles(outside)).rejects.toMatchObject({ status: 400 });
  });

  it('refuses a repository at the home folder (an accidental ~/.git would open every file there)', async () => {
    const home = process.env.HOME;
    process.env.HOME = repo;
    try {
      await expect(listFiles(path.join(repo, 'src'))).rejects.toMatchObject({ status: 400 });
      await expect(readText(repo, 'new.md')).rejects.toMatchObject({ status: 400 });
    } finally {
      process.env.HOME = home;
    }
  });

  it('reads and saves a text file; refuses to overwrite a file that changed after it was opened', async () => {
    const opened = await readText(repo, 'src/app.ts');
    expect(opened.content).toBe('export const a = 1;\n');
    await chmod(path.join(repo, 'src/app.ts'), 0o775); // umask(보통 022)에 깎이지 않아야 한다
    const version = await writeText(repo, 'src/app.ts', 'export const a = 2;\n', opened.version);
    expect((await stat(path.join(repo, 'src/app.ts'))).mode & 0o777).toBe(0o775); // 권한은 그대로
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

  it('saves different files in the same folder at the same time without mixing them', async () => {
    const [a, b] = await Promise.all([readText(repo, 'new.md'), readText(repo, 'win.txt')]);
    await Promise.all([writeText(repo, 'new.md', 'A\n', a.version), writeText(repo, 'win.txt', 'B\n', b.version)]);
    expect(await readFile(path.join(repo, 'new.md'), 'utf8')).toBe('A\n');
    expect(await readFile(path.join(repo, 'win.txt'), 'utf8')).toBe('B\n');
    await writeFile(path.join(repo, 'win.txt'), '\ufeffa\r\nb\r\n'); // 다음 테스트용으로 되돌린다
  });

  it('keeps the bytes it does not edit: a BOM and CRLF survive a round trip', async () => {
    const f = await readText(repo, 'win.txt');
    expect(f.content).toBe('\ufeffa\r\nb\r\n');
    await writeText(repo, 'win.txt', f.content, f.version);
    expect(await readFile(path.join(repo, 'win.txt'), 'utf8')).toBe('\ufeffa\r\nb\r\n');
  });

  it('opens ignored files like .env only when allowed; never the inside of an ignored folder', async () => {
    expect(await listIgnored(repo)).toEqual(['.env']);
    const env = await readText(repo, '.env', true);
    expect(env.content).toBe('SECRET=1\n');
    await writeText(repo, '.env', 'SECRET=2\n', env.version, true);
    expect(await readFile(path.join(repo, '.env'), 'utf8')).toBe('SECRET=2\n');
    await writeFile(path.join(repo, '.env'), 'SECRET=1\n');
    await expect(readText(repo, 'build/out.js', true)).rejects.toMatchObject({ status: 404 });
  });

  it('creates, moves, copies and deletes files and folders; deleted ones wait in a trash inside .git', async () => {
    const at = (rel: string) => path.join(repo, rel);
    await fsOp(repo, 'newDir', 'docs/guide');
    await fsOp(repo, 'newFile', 'docs/guide/intro.md');
    expect(await readFile(at('docs/guide/intro.md'), 'utf8')).toBe('');
    await expect(fsOp(repo, 'newFile', 'docs/guide/intro.md')).rejects.toMatchObject({ status: 409 });
    await writeFile(at('docs/guide/intro.md'), 'hello\n');
    await fsOp(repo, 'copy', 'docs', 'docs-copy');
    expect(await readFile(at('docs-copy/guide/intro.md'), 'utf8')).toBe('hello\n');
    await fsOp(repo, 'move', 'docs-copy/guide/intro.md', 'notes/intro.md');
    expect(await readFile(at('notes/intro.md'), 'utf8')).toBe('hello\n');
    await expect(fsOp(repo, 'move', 'docs', 'docs/inner')).rejects.toMatchObject({ status: 400 }); // 자기 안으로
    await expect(fsOp(repo, 'copy', 'notes/intro.md', 'notes/intro.md')).rejects.toMatchObject({ status: 409 }); // 제자리 복사는 '이미 있음'
    await expect(fsOp(repo, 'move', 'notes/intro.md', 'new.md')).rejects.toMatchObject({ status: 409 }); // 덮어쓰지 않는다
    await fsOp(repo, 'delete', 'docs');
    await expect(stat(at('docs'))).rejects.toThrow();
    const trash = path.join(repo, '.git/nightshift-trash');
    const [when] = await readdir(trash);
    expect(await readFile(path.join(trash, when!, 'docs/guide/intro.md'), 'utf8')).toBe('hello\n');
    await rm(at('notes'), { recursive: true });
    await rm(at('docs-copy'), { recursive: true });
  });

  it('never touches .git or anything outside the repository', async () => {
    for (const bad of ['../x', '/etc/passwd', '.git/config', '.GIT', '.Git/config', 'a/../../x', 'sub/.git/hooks/x', '.', ''])
      await expect(fsOp(repo, 'newFile', bad)).rejects.toMatchObject({ status: 400 });
    await expect(fsOp(repo, 'move', 'new.md', '../stolen.md')).rejects.toMatchObject({ status: 400 });
    // 안에 다른 저장소가 든 폴더는 통째로 다루지 않는다
    await mkdir(path.join(repo, 'vendor/inner/.git'), { recursive: true });
    for (const [op, to] of [['delete'], ['move', 'vendor2'], ['copy', 'vendor3']] as const) await expect(fsOp(repo, op, 'vendor', to)).rejects.toMatchObject({ status: 400 });
    await rm(path.join(repo, 'vendor'), { recursive: true });
    // 하위 저장소의 .git 을 가리키는 링크도 막는다
    await mkdir(path.join(repo, 'sub/.git'), { recursive: true });
    await symlink(path.join(repo, 'sub/.git'), path.join(repo, 'alias'));
    await expect(fsOp(repo, 'newFile', 'alias/hooks/x')).rejects.toMatchObject({ status: 400 });
    await rm(path.join(repo, 'alias'));
    await rm(path.join(repo, 'sub'), { recursive: true });
    // 링크된 폴더(cfg → .git)를 거쳐 들어가도 막는다
    await expect(fsOp(repo, 'newFile', 'cfg/hooks/pre-commit')).rejects.toMatchObject({ status: 400 });
    await expect(fsOp(repo, 'delete', 'cfg/config')).rejects.toMatchObject({ status: 400 });
  });

  it('refuses ignored files unless allowed, paths outside the list, links, and binary files', async () => {
    await expect(readText(repo, '.env')).rejects.toMatchObject({ status: 404 });
    await expect(readText(repo, '../' + path.basename(outside) + '/secret.txt')).rejects.toMatchObject({ status: 404 });
    await expect(readText(repo, 'link.txt')).rejects.toMatchObject({ status: 404 });
    await expect(readText(repo, 'cfg/config')).rejects.toMatchObject({ status: 404 });
    await expect(readText(repo, 'logo.bin')).rejects.toMatchObject({ status: 415 });
    await expect(writeText(repo, '.env', 'x', 'v')).rejects.toMatchObject({ status: 404 });
    expect(await readFile(path.join(repo, '.env'), 'utf8')).toBe('SECRET=1\n');
  });

  it('reads images (only images) under the same rules as text, up to 20MB', async () => {
    const at = (rel: string) => path.join(repo, rel);
    const png = Buffer.from('89504e470d0a1a0a', 'hex');
    const exclude = await readFile(at('.git/info/exclude'), 'utf8');
    await writeFile(at('shot.PNG'), png);
    await writeFile(at('private.png'), png);
    await writeFile(at('.git/info/exclude'), 'private.png\n');
    expect(await readRaw(repo, 'shot.PNG')).toEqual({ data: png, type: 'image/png' });
    // 무시된 그림은 허락할 때만
    await expect(readRaw(repo, 'private.png')).rejects.toMatchObject({ status: 404 });
    expect((await readRaw(repo, 'private.png', true)).type).toBe('image/png');
    await expect(readRaw(repo, 'src/app.ts')).rejects.toMatchObject({ status: 415 });
    await expect(readRaw(repo, 'cfg/config')).rejects.toMatchObject({ status: 404 });
    // 글은 그대로 1MB 까지, 그림은 20MB 까지
    await writeFile(at('shot.PNG'), Buffer.alloc(2 * 1024 * 1024));
    expect((await readRaw(repo, 'shot.PNG')).data.length).toBe(2 * 1024 * 1024);
    await expect(readText(repo, 'shot.PNG')).rejects.toMatchObject({ status: 413 });
    await writeFile(at('shot.PNG'), Buffer.alloc(MAX_IMAGE_BYTES + 1));
    await expect(readRaw(repo, 'shot.PNG')).rejects.toMatchObject({ status: 413 });
    await Promise.all([rm(at('shot.PNG')), rm(at('private.png')), writeFile(at('.git/info/exclude'), exclude)]);
  });
});
