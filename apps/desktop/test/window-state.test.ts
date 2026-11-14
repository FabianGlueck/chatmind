import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_BOUNDS, loadBounds, saneBounds, saveBounds } from '../src/window-state';

describe('window bounds (desktop spec §1)', () => {
  it('round-trips through the file and falls back on a missing or broken one', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chatmind-desktop-'));
    const file = path.join(dir, 'window.json');
    expect(await loadBounds(file)).toEqual(DEFAULT_BOUNDS);
    await saveBounds(file, { x: 10, y: 20, width: 1000, height: 700 });
    expect(await loadBounds(file)).toEqual({ x: 10, y: 20, width: 1000, height: 700 });
    await fs.writeFile(file, '{nope');
    expect(await loadBounds(file)).toEqual(DEFAULT_BOUNDS);
    await fs.rm(dir, { recursive: true, force: true });
  });
  it('clamps to the minimum size, rounds, and drops a half position', () => {
    expect(saneBounds({ width: 100, height: 100.4 })).toEqual({ width: 720, height: 480 });
    expect(saneBounds({ x: 1.6, width: 900, height: 600 })).toEqual({ width: 900, height: 600 });
    expect(saneBounds({ x: 'a', y: null, width: NaN })).toEqual({ width: DEFAULT_BOUNDS.width, height: DEFAULT_BOUNDS.height });
    expect(saneBounds(null)).toEqual(DEFAULT_BOUNDS);
  });
});
