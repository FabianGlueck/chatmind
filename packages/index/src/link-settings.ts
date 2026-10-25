import { LINK_K, T_LINK, type LinkSettings } from './links';

export const DEFAULT_LINK_SETTINGS: LinkSettings = { k: LINK_K, tMin: T_LINK };

/**
 * Spec M7 §4: `CHATMIND_LINK_K` (integer 1–50) and `CHATMIND_LINK_MIN` (a similarity in [−1, 1]). Anything
 * unparseable, empty or out of range falls back to the default, as `topicSettings` does.
 */
export function linkSettings(env: Record<string, string | undefined>): LinkSettings {
  const k = Number(env.CHATMIND_LINK_K?.trim() || NaN);
  const t = Number(env.CHATMIND_LINK_MIN?.trim() || NaN);
  return {
    k: Number.isInteger(k) && k >= 1 && k <= 50 ? k : LINK_K,
    tMin: Number.isFinite(t) && t >= -1 && t <= 1 ? t : T_LINK,
  };
}

/** The startup line's link part: what differs from the default, or `null` when nothing does. */
export function describeLinkSettings(s: LinkSettings): string | null {
  const parts = (Object.keys(DEFAULT_LINK_SETTINGS) as (keyof LinkSettings)[])
    .filter((key) => s[key] !== DEFAULT_LINK_SETTINGS[key])
    .map((key) => `${key} ${s[key]} (default ${DEFAULT_LINK_SETTINGS[key]})`);
  return parts.length === 0 ? null : parts.join(', ');
}
