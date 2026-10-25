import { describe, expect, it } from 'vitest';
import { DEFAULT_THRESHOLDS, describeThresholds, topicSettings } from '../src/topic-settings';
import { ASSIGN_MARGIN, INHERIT_MARGIN, T_ASSIGN, T_INHERIT } from '../src/topics';

describe('topicSettings (spec M6 §4 — thresholds are configurable)', () => {
  it('defaults to the calibrated constants', () => {
    expect(topicSettings({})).toEqual(DEFAULT_THRESHOLDS);
    expect(DEFAULT_THRESHOLDS).toEqual({ tInherit: T_INHERIT, inheritMargin: INHERIT_MARGIN, tAssign: T_ASSIGN, assignMargin: ASSIGN_MARGIN });
  });

  it('reads every threshold from the environment', () => {
    expect(topicSettings({ CHATMIND_TOPIC_INHERIT: '0.3', CHATMIND_TOPIC_INHERIT_MARGIN: '0.08', CHATMIND_TOPIC_ASSIGN: '0.5', CHATMIND_TOPIC_ASSIGN_MARGIN: '0.2' }))
      .toEqual({ tInherit: 0.3, inheritMargin: 0.08, tAssign: 0.5, assignMargin: 0.2 });
  });

  it('accepts a negative similarity threshold (cosine runs from -1)', () => {
    expect(topicSettings({ CHATMIND_TOPIC_INHERIT: '-0.3' }).tInherit).toBe(-0.3);
  });

  it('falls back to the default for nonsense, out-of-range and empty values', () => {
    for (const bad of ['abc', '', ' ', '2', '-1.5', 'NaN', 'Infinity']) {
      expect(topicSettings({ CHATMIND_TOPIC_INHERIT: bad }).tInherit).toBe(T_INHERIT);
    }
    expect(topicSettings({ CHATMIND_TOPIC_ASSIGN_MARGIN: '-0.1' }).assignMargin).toBe(ASSIGN_MARGIN); // a margin is a distance
  });

  it('describeThresholds names only what differs from the default, for the startup line', () => {
    expect(describeThresholds(DEFAULT_THRESHOLDS)).toBeNull();
    expect(describeThresholds(topicSettings({ CHATMIND_TOPIC_INHERIT: '0.3' }))).toBe('tInherit 0.3 (default 0.15)');
    expect(describeThresholds(topicSettings({ CHATMIND_TOPIC_INHERIT: '0.3', CHATMIND_TOPIC_ASSIGN: '0.5' }))).toBe('tInherit 0.3 (default 0.15), tAssign 0.5 (default 0.35)');
  });
});
