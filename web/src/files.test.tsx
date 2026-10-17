// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { ProjectSnapshot } from '../../shared/types.ts';
import { FilesTab } from './Files.tsx';

const fetchMock = vi.fn<typeof fetch>();
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  sessionStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const project = (allowInput = true) =>
  ({ id: 'api', allowInput, git: { changedFiles: [{ path: 'src/app.ts', status: ' M' }, { path: 'gone.ts', status: ' D' }] } }) as unknown as ProjectSnapshot;

/** 서버 흉내: 파일 하나, 저장은 지문이 맞을 때만 */
function serve() {
  let disk = { content: 'const a = 1;\n', version: 'v1' };
  fetchMock.mockImplementation(async (url, init) => {
    const u = String(url);
    if (u.endsWith('/files')) return json(200, { files: ['README.md', 'src/app.ts'], ignored: ['.env'] });
    if (u.includes('/file?path=')) return json(200, disk);
    const body = JSON.parse(init!.body as string) as { content: string; version: string };
    if (body.version !== disk.version) return json(409, { error: '연 뒤로 파일이 바뀌었습니다' });
    disk = { content: body.content, version: `v${Number(disk.version.slice(1)) + 1}` };
    return json(200, { version: disk.version });
  });
  return { change: (content: string) => (disk = { content, version: 'agent' }) };
}
const editor = () => screen.getByLabelText<HTMLTextAreaElement>('src/app.ts 내용');

test('lists changed files first, opens one, saves with ⌘S against the version it opened, and refuses when the file changed meanwhile', async () => {
  const server = serve();
  render(<FilesTab project={project()} />);
  // 지운 파일은 목록에 없다
  await screen.findByRole('heading', { name: '바뀐 파일 (1)' });
  fireEvent.click(screen.getAllByRole('button', { name: 'src/app.ts' })[0]!);
  await waitFor(() => expect(editor().value).toBe('const a = 1;\n'));
  fireEvent.change(editor(), { target: { value: 'const a = 2;\n' } });
  fireEvent.keyDown(editor(), { key: 's', metaKey: true });
  await screen.findByText('저장했습니다');
  expect(JSON.parse(fetchMock.mock.calls.at(-1)![1]!.body as string)).toEqual({ path: 'src/app.ts', content: 'const a = 2;\n', version: 'v1' });

  server.change('const a = 3;\n'); // 에이전트가 고쳤다
  fireEvent.change(editor(), { target: { value: 'const a = 4;\n' } });
  fireEvent.click(screen.getByRole('button', { name: '저장' }));
  expect((await screen.findByRole('alert')).textContent).toContain('바뀌었습니다');
});

test('all files show as a folder tree that remembers what is open; ignored files are marked; search lists matches flat', async () => {
  serve();
  const { unmount } = render(<FilesTab project={project()} />);
  const folder = await screen.findByRole('button', { name: '▸ src/' });
  expect(screen.getByRole('button', { name: '.env' }).className).toContain('dim');
  expect(screen.getByText('무시됨')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'app.ts' })).toBeNull();
  fireEvent.click(folder);
  expect(screen.getByRole('button', { name: 'app.ts' })).toBeTruthy();
  unmount();
  render(<FilesTab project={project()} />);
  expect(await screen.findByRole('button', { name: '▾ src/' })).toBeTruthy(); // 펼친 채로 돌아온다
  fireEvent.change(screen.getByLabelText('파일 찾기'), { target: { value: 'app' } });
  expect(screen.getByRole('heading', { name: '찾은 파일 (1)' })).toBeTruthy();
  expect(screen.getAllByRole('button', { name: 'src/app.ts' })).toHaveLength(1);
  // 새로 생긴 무시된 파일은 Git 변화가 아니라서 새로고침으로 받는다
  const lists = () => fetchMock.mock.calls.filter(([u]) => String(u).endsWith('/files')).length;
  const before = lists();
  fireEvent.click(screen.getByRole('button', { name: '새로고침' }));
  await waitFor(() => expect(lists()).toBe(before + 1));
});

test('unsaved edits survive leaving the tab and come back with the version they were based on', async () => {
  serve();
  const { unmount } = render(<FilesTab project={project()} />);
  fireEvent.click((await screen.findAllByRole('button', { name: 'src/app.ts' }))[0]!);
  await waitFor(() => expect(editor().value).toBe('const a = 1;\n'));
  fireEvent.change(editor(), { target: { value: 'draft' } });
  unmount();
  render(<FilesTab project={project()} />);
  await screen.findByText('저장하지 않은 내용을 되살렸습니다');
  expect(editor().value).toBe('draft');
  fireEvent.click(screen.getByRole('button', { name: '← 목록' }));
  expect(await screen.findAllByText('저장 안 함')).not.toHaveLength(0);
});

test('a CRLF file is shown with LF and saved back with CRLF', async () => {
  fetchMock.mockImplementation(async (url) => {
    const u = String(url);
    if (u.endsWith('/files')) return json(200, { files: ['src/app.ts'], ignored: [] });
    if (u.includes('/file?path=')) return json(200, { content: 'a\r\nb\r\n', version: 'v1' });
    return json(200, { version: 'v2' });
  });
  render(<FilesTab project={project()} />);
  fireEvent.click((await screen.findAllByRole('button', { name: 'src/app.ts' }))[0]!);
  await waitFor(() => expect(editor().value).toBe('a\nb\n'));
  fireEvent.change(editor(), { target: { value: 'a\nc\n' } });
  fireEvent.click(screen.getByRole('button', { name: '저장' }));
  await screen.findByText('저장했습니다');
  expect(JSON.parse(fetchMock.mock.calls.at(-1)![1]!.body as string)).toMatchObject({ content: 'a\r\nc\r\n' });
});

test('⋯ menu: new file opens it, paste of a copy picks a free name, delete asks first; a read-only project has no menus', async () => {
  const sent: Record<string, unknown>[] = [];
  const taken = new Set(['README.md', 'src/app.ts']);
  fetchMock.mockImplementation(async (url, init) => {
    const u = String(url);
    if (u.endsWith('/files')) return json(200, { files: [...taken].sort(), ignored: [] });
    if (u.includes('/file?path=')) return json(200, { content: '', version: 'v0' });
    const body = JSON.parse(init!.body as string) as { op: string; path: string; to?: string };
    sent.push(body);
    if (body.to && taken.has(body.to)) return json(409, { error: '이미 있습니다' });
    if (body.to) taken.add(body.to);
    return json(200, { ok: true });
  });
  vi.stubGlobal('prompt', vi.fn(() => 'b.ts'));
  const confirm = vi.fn(() => true);
  vi.stubGlobal('confirm', confirm);
  const { unmount } = render(<FilesTab project={project()} />);
  fireEvent.click(await screen.findByRole('button', { name: 'src/ 메뉴' }));
  fireEvent.click(screen.getByRole('menuitem', { name: '새 파일…' }));
  await waitFor(() => expect(sent).toEqual([{ op: 'newFile', path: 'src/b.ts' }]));
  await screen.findByLabelText('src/b.ts 내용'); // 만든 파일을 연다
  fireEvent.click(screen.getByRole('button', { name: '← 목록' }));

  // README.md 를 복사해 맨 위에 붙여넣으면 같은 이름이 있어서 "README copy.md"
  fireEvent.click(await screen.findByRole('button', { name: 'README.md 메뉴' }));
  fireEvent.click(screen.getByRole('menuitem', { name: '복사' }));
  fireEvent.click(screen.getByRole('button', { name: '붙여넣기' }));
  await waitFor(() => expect(sent.slice(-2)).toEqual([{ op: 'copy', path: 'README.md', to: 'README.md' }, { op: 'copy', path: 'README.md', to: 'README copy.md' }]));

  fireEvent.click(await screen.findByRole('button', { name: 'README.md 메뉴' }));
  fireEvent.click(screen.getByRole('menuitem', { name: '지우기…' }));
  expect(confirm).toHaveBeenCalledOnce();
  await waitFor(() => expect(sent.at(-1)).toEqual({ op: 'delete', path: 'README.md' }));
  unmount();

  render(<FilesTab project={project(false)} />);
  await screen.findByRole('button', { name: '▸ src/' });
  expect(screen.queryByRole('button', { name: /메뉴$/ })).toBeNull();
  expect(screen.queryByRole('button', { name: '새 파일' })).toBeNull();
});

test('a read-only project can look but not save', async () => {
  serve();
  render(<FilesTab project={project(false)} />);
  fireEvent.click((await screen.findAllByRole('button', { name: 'src/app.ts' }))[0]!);
  await waitFor(() => expect(editor().readOnly).toBe(true));
  expect(screen.queryByRole('button', { name: '저장' })).toBeNull();
});
