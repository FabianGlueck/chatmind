import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { withImages } from '../src/attachments';
import { cleanupTmpDirs, tmpDir } from './tmp';

afterAll(cleanupTmpDirs);

describe('withImages (spec M13)', () => {
  it('interleaves text and images in user messages, notes missing files, leaves assistants as text', async () => {
    const dir = await tmpDir();
    const a = '01JQ7M2V3X4Y5Z6A7B8C9D0E1F.jpg';
    const gone = '01JQ7M2V3X4Y5Z6A7B8C9D0E1G.png';
    await fs.writeFile(path.join(dir, a), Buffer.from([1, 2, 3]));
    const out = await withImages([
      { role: 'user', content: `vorher ![[${a}]] nachher ![[${gone}]]` },
      { role: 'assistant', content: `![[${a}]]` },
      { role: 'user', content: 'nur Text' },
    ], dir);
    expect(out[0]).toEqual({ role: 'user', content: [
      { type: 'text', text: 'vorher' },
      { type: 'file', data: Buffer.from([1, 2, 3]), mediaType: 'image/jpeg' },
      { type: 'text', text: 'nachher' },
      { type: 'text', text: `[missing image ${gone}]` },
    ] });
    expect(out[1]).toEqual({ role: 'assistant', content: `![[${a}]]` });
    expect(out[2]).toEqual({ role: 'user', content: 'nur Text' });
  });
});
