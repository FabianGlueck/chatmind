import type { CanvasDto } from '@chatmind/core';

/** Spec M10 §2: below this zoom the map is fully visible and cards hide their text. */
export const MAP_ZOOM = 0.28;
/** Spec M10 §2: areas and labels start fading in below this zoom. */
export const MAP_FADE_START = 0.38;
/** Spec M10 §2: padding of the area around each card; cards closer than twice this join one region. */
export const REGION_PAD = 60;

export interface Rect { x: number; y: number; width: number; height: number }
export interface TopicRegion { topic: string; index: number; ids: string[]; rects: Rect[]; label: { x: number; y: number } }

function near(a: Rect, b: Rect): boolean {
  const p = 2 * REGION_PAD;
  return a.x < b.x + b.width + p && b.x < a.x + a.width + p && a.y < b.y + b.height + p && b.y < a.y + a.height + p;
}

/** Spec M10 §2: per topic, cards joined by padded overlap into connected regions — larger regions first. Pure. */
export function topicRegions(dto: CanvasDto, palette: ReadonlyMap<string, number>): TopicRegion[] {
  const byTopic = new Map<string, { id: string; rect: Rect }[]>();
  for (const n of dto.nodes) {
    const t = n.topics[0];
    if (t === undefined || t === '') continue;
    const list = byTopic.get(t) ?? [];
    list.push({ id: n.id, rect: n.layout });
    byTopic.set(t, list);
  }
  const regions: TopicRegion[] = [];
  for (const [topic, cards] of byTopic) {
    const root = cards.map((_, i) => i);
    const find = (i: number): number => (root[i] === i ? i : (root[i] = find(root[i]!)));
    for (let i = 0; i < cards.length; i++) for (let j = i + 1; j < cards.length; j++) if (near(cards[i]!.rect, cards[j]!.rect)) root[find(i)] = find(j);
    const groups = new Map<number, typeof cards>();
    cards.forEach((c, i) => { const g = groups.get(find(i)) ?? []; g.push(c); groups.set(find(i), g); });
    for (const g of groups.values()) {
      const centre = (r: Rect) => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
      const mx = g.reduce((s, c) => s + centre(c.rect).x, 0) / g.length;
      const my = g.reduce((s, c) => s + centre(c.rect).y, 0) / g.length;
      let label = centre(g[0]!.rect);
      for (const c of g) {
        const p = centre(c.rect);
        if ((p.x - mx) ** 2 + (p.y - my) ** 2 < (label.x - mx) ** 2 + (label.y - my) ** 2) label = p;
      }
      regions.push({ topic, index: palette.get(topic) ?? 0, ids: g.map((c) => c.id), rects: g.map((c) => c.rect), label });
    }
  }
  return regions.sort((a, b) => b.ids.length - a.ids.length || (a.topic < b.topic ? -1 : a.topic > b.topic ? 1 : a.ids[0]! < b.ids[0]! ? -1 : 1));
}

/** Spec M10 §2: 0 at or above MAP_FADE_START, 1 at or below MAP_ZOOM, linear in between. */
export function mapOpacity(zoom: number): number {
  return Math.min(1, Math.max(0, (MAP_FADE_START - zoom) / (MAP_FADE_START - MAP_ZOOM)));
}

/** Screen font size of a region label: 14 px, + 2 px per doubling of the card count, at most 26 px. */
export function labelFontSize(cards: number): number {
  return Math.min(26, Math.round(14 + 2 * Math.log2(Math.max(1, cards))));
}

export interface PlacedLabel { region: TopicRegion; fontSize: number }

/** Spec M10 §2: greedy screen-space collision, regions in order (larger first); overlapping labels are hidden. */
export function visibleLabels(regions: readonly TopicRegion[], zoom: number): PlacedLabel[] {
  const placed: { box: Rect; label: PlacedLabel }[] = [];
  for (const region of regions) {
    const fontSize = labelFontSize(region.ids.length);
    const w = region.topic.length * fontSize * 0.6 + 24;
    const h = fontSize * 1.4 + 8;
    const box = { x: region.label.x * zoom - w / 2, y: region.label.y * zoom - h / 2, width: w, height: h };
    if (placed.some((p) => box.x < p.box.x + p.box.width && p.box.x < box.x + box.width && box.y < p.box.y + p.box.height && p.box.y < box.y + box.height)) continue;
    placed.push({ box, label: { region, fontSize } });
  }
  return placed.map((p) => p.label);
}
