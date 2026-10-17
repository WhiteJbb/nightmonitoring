// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react';
import { language } from '@codemirror/language';
import { EditorView } from '@codemirror/view';
import { afterEach, expect, test, vi } from 'vitest';
import CodeEditor from './CodeEditor.tsx';

afterEach(cleanup);

function setup(path = 'notes.txt') {
  const onChange = vi.fn();
  const onSave = vi.fn();
  const props = { value: 'hello', onChange, onSave, path, readOnly: false, wrap: false, ariaLabel: '파일 내용' };
  const r = render(<CodeEditor {...props} />);
  const view = () => EditorView.findFromDOM(r.container.querySelector('.cm-editor') as HTMLElement)!;
  const content = () => r.container.querySelector('.cm-content') as HTMLElement;
  return { ...r, props, onChange, onSave, view, content };
}

test('사용자 편집은 onChange 로 알리고, 바깥에서 바꾼 값은 알리지 않고 갈아 끼운다', () => {
  const { view, onChange, rerender, props, content } = setup();
  expect(view().state.doc.toString()).toBe('hello');
  expect(content().getAttribute('aria-label')).toBe('파일 내용');

  view().dispatch({ changes: { from: 5, insert: '!' }, userEvent: 'input.type' });
  expect(onChange).toHaveBeenLastCalledWith('hello!');

  onChange.mockClear();
  rerender(<CodeEditor {...props} value={'from\ndisk'} />);
  expect(view().state.doc.toString()).toBe('from\ndisk');
  expect(onChange).not.toHaveBeenCalled();
});

test('readOnly 는 뷰를 다시 만들지 않고 편집을 막는다', () => {
  const { view, rerender, props, content } = setup();
  const before = view();
  expect(content().getAttribute('contenteditable')).toBe('true');
  rerender(<CodeEditor {...props} readOnly />);
  expect(content().getAttribute('contenteditable')).toBe('false');
  expect(view()).toBe(before);
});

test('Mod-s 는 브라우저 저장 대신 onSave 를 부른다', () => {
  const { onSave, content } = setup();
  // jsdom 은 Mac 이 아니라 Mod 가 Ctrl 이다
  const notPrevented = fireEvent.keyDown(content(), { key: 's', keyCode: 83, ctrlKey: true });
  expect(onSave).toHaveBeenCalledTimes(1);
  expect(notPrevented).toBe(false);
});

test('파일 이름으로 언어를 골라 불러온다', async () => {
  const { view } = setup('src/app.ts');
  await vi.waitFor(() => expect(view().state.facet(language)?.name).toBe('typescript'));
});
