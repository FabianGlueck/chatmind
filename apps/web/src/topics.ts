import type { CanvasDto } from '@chatmind/core';

/** Spec M6 §7: ten hues (`--topic-0 … --topic-9`), cycling from the eleventh topic on. */
export const TOPIC_COLOURS = 10;

export interface TopicEntry { name: string; index: number; count: number }

/** Spec M6 §7: topic → colour index by first appearance (earliest `created` among its nodes). Pure. */
export function topicPalette(dto: CanvasDto): Map<string, number> {
  const first = new Map<string, string>();
  for (const n of dto.nodes) {
    const t = n.topics[0];
    if (t === undefined || t === '') continue;
    const cur = first.get(t);
    if (cur === undefined || n.created < cur) first.set(t, n.created);
  }
  const ordered = [...first].sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : a[0] < b[0] ? -1 : 1));
  return new Map(ordered.map(([name], i) => [name, i % TOPIC_COLOURS]));
}

/** Topics in palette order with node counts — the sidebar list. */
export function topicList(dto: CanvasDto): TopicEntry[] {
  const counts = new Map<string, number>();
  for (const n of dto.nodes) { const t = n.topics[0]; if (t !== undefined && t !== '') counts.set(t, (counts.get(t) ?? 0) + 1); }
  return [...topicPalette(dto)].map(([name, index]) => ({ name, index, count: counts.get(name) ?? 0 }));
}

export function nodesOfTopic(dto: CanvasDto, name: string): string[] {
  return dto.nodes.filter((n) => n.topics[0] === name).map((n) => n.id);
}
