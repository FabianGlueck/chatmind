import { promises as fs } from 'node:fs';

export interface Bounds { x?: number; y?: number; width: number; height: number }

export const DEFAULT_BOUNDS: Bounds = { width: 1400, height: 900 };
export const MIN_SIZE = { width: 720, height: 480 };

/** Desktop spec §1: the remembered window bounds, or the default when the file is missing or broken. */
export async function loadBounds(file: string): Promise<Bounds> {
  try {
    return saneBounds(JSON.parse(await fs.readFile(file, 'utf8')));
  } catch {
    return DEFAULT_BOUNDS;
  }
}

export async function saveBounds(file: string, b: Bounds): Promise<void> {
  await fs.writeFile(file, JSON.stringify(saneBounds(b)));
}

/** Finite integers, at least MIN_SIZE; a position only when both coordinates are there. */
export function saneBounds(raw: unknown): Bounds {
  const r = (raw ?? {}) as Record<string, unknown>;
  const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : undefined);
  const width = Math.max(MIN_SIZE.width, num(r.width) ?? DEFAULT_BOUNDS.width);
  const height = Math.max(MIN_SIZE.height, num(r.height) ?? DEFAULT_BOUNDS.height);
  const x = num(r.x);
  const y = num(r.y);
  return x !== undefined && y !== undefined ? { x, y, width, height } : { width, height };
}
