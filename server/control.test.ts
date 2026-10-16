import { describe, expect, it } from 'vitest';
import { ControlParser, unescapeOutput } from './control.ts';

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);

describe('ControlParser', () => {
  it('buffers a reply across three chunks, including split UTF-8', () => {
    const parser = new ControlParser();
    const first = bytes('%begin 1 2 0\r\n한글\\015\r\nsecond\r\n%end 1 2 0\r\n');
    const split = first.indexOf(0xed) + 1;
    expect(parser.feed(first.subarray(0, split))).toEqual([]);
    expect(parser.feed(first.subarray(split, first.length - 2))).toEqual([]);
    expect(parser.feed(first.subarray(first.length - 2))).toEqual([
      { type: 'reply', ok: true, lines: ['한글\\015', 'second'] },
    ]);
  });

  it('decodes output octal bytes and preserves raw UTF-8 split across two chunks', () => {
    const parser = new ControlParser();
    const line = bytes('%output %12 hello\\015\\012\\134한글\\015\n');
    const split = line.indexOf(0xed) + 1;
    expect(parser.feed(line.subarray(0, split))).toEqual([]);
    expect(parser.feed(line.subarray(split))).toEqual([
      { type: 'output', pane: '%12', data: bytes('hello\r\n\\한글\r') },
    ]);
  });

  it('emits error replies and treats percent-prefixed body lines as raw text', () => {
    const parser = new ControlParser();
    expect(parser.feed(bytes('%begin 1 2 0\n%output %12 \\015\n%pause %12\n%begin 2 3 0\n%end is text\n\n%error 1 2 0\n'))).toEqual([
      { type: 'reply', ok: false, lines: ['%output %12 \\015', '%pause %12', '%begin 2 3 0', '%end is text', ''] },
    ]);
  });

  it('keeps event order, ignores plain lines, and resumes after empty replies', () => {
    const parser = new ControlParser();
    expect(parser.feed(bytes('ignored\r\n%layout-change @1 80x24\r\n%begin 1 2 0\n%end 1 2 0\n%output %12 \n%pause %12\n%exit\r\n%window-ren'))).toEqual([
      { type: 'notify', name: 'layout-change', args: '@1 80x24' },
      { type: 'reply', ok: true, lines: [] },
      { type: 'output', pane: '%12', data: bytes('') },
      { type: 'notify', name: 'pause', args: '%12' },
      { type: 'notify', name: 'exit', args: '' },
    ]);
    expect(parser.feed(bytes('amed @1 new name\n'))).toEqual([
      { type: 'notify', name: 'window-renamed', args: '@1 new name' },
    ]);
    expect(parser.feed(bytes(''))).toEqual([]);
  });

  it('preserves output spaces and literal trailing CR, and owns buffered bytes', () => {
    const parser = new ControlParser();
    const chunk = bytes('%output %12  text ');
    expect(parser.feed(chunk)).toEqual([]);
    chunk.fill(0);
    expect(parser.feed(bytes('\r\n'))).toEqual([
      { type: 'output', pane: '%12', data: bytes(' text \r') },
    ]);
  });
});

describe('unescapeOutput', () => {
  it('decodes every byte value without mutating the input', () => {
    const input = bytes(Array.from({ length: 256 }, (_, n) => `\\${n.toString(8).padStart(3, '0')}`).join(''));
    const original = input.slice();
    expect(unescapeOutput(input)).toEqual(Uint8Array.from({ length: 256 }, (_, n) => n));
    expect(input).toEqual(original);
  });

  it('passes through raw bytes and malformed escapes without decoding recursively', () => {
    expect(unescapeOutput(bytes('한글\\x\\089\\12\\'))).toEqual(bytes('한글\\x\\089\\12\\'));
    expect(unescapeOutput(bytes('\\134015'))).toEqual(bytes('\\015'));
    expect(unescapeOutput(bytes(''))).toEqual(bytes(''));
  });
});
