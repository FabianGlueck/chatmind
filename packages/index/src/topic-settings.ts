import { ASSIGN_MARGIN, INHERIT_MARGIN, T_ASSIGN, T_INHERIT, type Thresholds } from './topics';

/** Spec M6 §4: the calibrated defaults — what every vault gets until its own env says otherwise. */
export const DEFAULT_THRESHOLDS: Thresholds = { tInherit: T_INHERIT, inheritMargin: INHERIT_MARGIN, tAssign: T_ASSIGN, assignMargin: ASSIGN_MARGIN };

/** A similarity lives in [-1, 1]; a margin is a distance between two of them, so it is never negative. */
function num(raw: string | undefined, fallback: number, min: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw.trim());
  if (raw.trim() === '' || !Number.isFinite(n) || n < min || n > 1) return fallback;
  return n;
}

/**
 * Spec M6 §4: the thresholds, resolved from CHATMIND_TOPIC_* env vars. Anything unparseable, empty or out of
 * range falls back to the default rather than throwing — a typo must not silently retune the whole vault.
 */
export function topicSettings(env: Record<string, string | undefined>): Thresholds {
  return {
    tInherit: num(env.CHATMIND_TOPIC_INHERIT, T_INHERIT, -1),
    inheritMargin: num(env.CHATMIND_TOPIC_INHERIT_MARGIN, INHERIT_MARGIN, 0),
    tAssign: num(env.CHATMIND_TOPIC_ASSIGN, T_ASSIGN, -1),
    assignMargin: num(env.CHATMIND_TOPIC_ASSIGN_MARGIN, ASSIGN_MARGIN, 0),
  };
}

/** The startup line's topic part: what differs from the default, or `null` when nothing does. */
export function describeThresholds(t: Thresholds): string | null {
  const parts = (Object.keys(DEFAULT_THRESHOLDS) as (keyof Thresholds)[])
    .filter((k) => t[k] !== DEFAULT_THRESHOLDS[k])
    .map((k) => `${k} ${t[k]} (default ${DEFAULT_THRESHOLDS[k]})`);
  return parts.length === 0 ? null : parts.join(', ');
}
