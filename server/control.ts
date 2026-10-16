export type ControlEvent =
  | { type: 'output'; pane: string; data: Uint8Array }
  | { type: 'reply'; ok: boolean; lines: string[] }
  | { type: 'notify'; name: string; args: string };

export function unescapeOutput(s: Uint8Array): Uint8Array {
  const result = new Uint8Array(s.length);
  let length = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === 92 && i + 3 < s.length) {
      const a = s[i + 1]! - 48;
      const b = s[i + 2]! - 48;
      const c = s[i + 3]! - 48;
      if (a >= 0 && a <= 7 && b >= 0 && b <= 7 && c >= 0 && c <= 7) {
        result[length++] = a * 64 + b * 8 + c;
        i += 3;
        continue;
      }
    }
    result[length++] = s[i]!;
  }
  return result.subarray(0, length);
}

export class ControlParser {
  private pending: Uint8Array[] = [];
  private body: string[] | null = null;

  /** Feed stdout bytes, retaining incomplete lines until the next call. */
  feed(chunk: Uint8Array): ControlEvent[] {
    const events: ControlEvent[] = [];
    let start = 0;
    for (let end = chunk.indexOf(10); end !== -1; end = chunk.indexOf(10, start)) {
      const line = Buffer.concat([...this.pending, chunk.subarray(start, end)]);
      this.pending = [];
      this.parseLine(line, events);
      start = end + 1;
    }
    // Copy retained bytes so callers may reuse their input buffer.
    if (start < chunk.length) this.pending.push(Buffer.from(chunk.subarray(start)));
    return events;
  }

  private parseLine(line: Buffer, events: ControlEvent[]): void {
    if (this.body === null && line.subarray(0, 8).toString('ascii') === '%output ') {
      const separator = line.indexOf(32, 8);
      if (separator !== -1) {
        events.push({ type: 'output', pane: line.subarray(8, separator).toString('utf8'), data: unescapeOutput(line.subarray(separator + 1)) });
        return;
      }
    }

    const text = line.toString('utf8').replace(/\r$/, '');
    if (this.body !== null) {
      const close = /^%(end|error) \d+ \d+ \d+$/.exec(text);
      if (close) {
        events.push({ type: 'reply', ok: close[1] === 'end', lines: this.body });
        this.body = null;
      } else {
        this.body.push(text);
      }
    } else if (/^%begin \d+ \d+ \d+$/.test(text)) {
      this.body = [];
    } else {
      const notify = /^%(\S+)(?: (.*))?$/.exec(text);
      if (notify) events.push({ type: 'notify', name: notify[1]!, args: notify[2] ?? '' });
    }
  }
}
