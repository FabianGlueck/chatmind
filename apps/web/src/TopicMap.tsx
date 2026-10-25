import { ViewportPortal, useReactFlow, useStore } from '@xyflow/react';
import { REGION_PAD, mapOpacity, visibleLabels, type TopicRegion } from './topic-map';

/** Readable zoom a label click lands on at least (spec M10 §2). */
const FOCUS_ZOOM = 0.55;

/**
 * Spec M10: the topic map — areas behind edges and cards, labels on top at constant screen size. Only this
 * component follows the zoom continuously; the graph re-renders when crossing MAP_ZOOM only.
 */
export function TopicMap({ regions, active }: { regions: readonly TopicRegion[]; active: string | null }) {
  const zoom = useStore((s) => s.transform[2]);
  const rf = useReactFlow();
  const opacity = mapOpacity(zoom);
  if (opacity === 0 || regions.length === 0) return null;
  const dim = (r: TopicRegion) => active !== null && r.topic !== active;
  return (
    <ViewportPortal>
      <svg className="topic-areas" style={{ opacity }} aria-hidden="true">
        {regions.map((r) => (
          <g key={`${r.topic}:${r.ids[0]}`} opacity={dim(r) ? 0.06 : 0.2} style={{ fill: `var(--topic-${r.index})` }}>
            {r.rects.map((c, i) => <rect key={i} x={c.x - REGION_PAD} y={c.y - REGION_PAD} width={c.width + 2 * REGION_PAD} height={c.height + 2 * REGION_PAD} rx={REGION_PAD} />)}
          </g>
        ))}
      </svg>
      {visibleLabels(regions, zoom).map(({ region: r, fontSize }) => (
        <button
          key={`${r.topic}:${r.ids[0]}`}
          type="button"
          className={`topic-map-label${dim(r) ? ' dimmed' : ''}`}
          title={`${r.topic} · ${r.ids.length}`}
          style={{ left: r.label.x, top: r.label.y, fontSize, opacity, pointerEvents: opacity > 0.5 ? 'all' : 'none', transform: `translate(-50%, -50%) scale(${1 / zoom})`, ['--topic' as string]: `var(--topic-${r.index})` }}
          onClick={(e) => {
            e.currentTarget.blur();
            try {
              void rf.fitView({ nodes: r.ids.map((id) => ({ id })), padding: 0.2, duration: 400, minZoom: FOCUS_ZOOM });
            } catch {
              // fitView can throw under jsdom; ignore there.
            }
          }}
        >
          {r.topic}
        </button>
      ))}
    </ViewportPortal>
  );
}
