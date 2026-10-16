import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MAX_UPLOAD_BYTES, parseUpload, saveUpload } from './upload.ts';

describe('upload', () => {
  it('accepts only known image types with non-empty base64 data within the size limit', () => {
    expect(parseUpload(null)).toMatch(/본문/);
    expect(parseUpload({ type: 'text/plain', data: 'aGk=' })).toMatch(/이미지만/);
    expect(parseUpload({ type: 'image/png', data: '' })).toMatch(/비어/);
    expect(parseUpload({ type: 'image/png', data: '!!!' })).toMatch(/읽을 수/);
    expect(parseUpload({ type: 'image/jpeg', data: Buffer.alloc(MAX_UPLOAD_BYTES + 1).toString('base64') })).toMatch(/10MB/);
    const ok = parseUpload({ type: 'image/png', data: Buffer.from('png!').toString('base64') });
    expect(ok).toMatchObject({ ext: 'png' });
    expect((ok as { data: Buffer }).data.toString()).toBe('png!');
  });

  it('saves under the upload dir with a safe file name and returns the path', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'nightshift-up-'));
    try {
      const file = await saveUpload(path.join(dir, 'uploads'), 'tmux:my app', 'png', Buffer.from('x'));
      expect(path.dirname(file)).toBe(path.join(dir, 'uploads'));
      expect(path.basename(file)).toMatch(/^tmux_my_app-\d+\.png$/);
      expect((await readFile(file)).toString()).toBe('x');
    } finally {
      await rm(dir, { recursive: true });
    }
  });
});
