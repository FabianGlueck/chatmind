# chatmind M10 — Topic map (semantic zoom)

Date: 2026-09-25. Builds on M6 (topics, palette `--topic-0 … --topic-9`, §7) and M8 (moving cards). Raised by the user in conversation: on a large canvas, zooming far out should turn the canvas into a map with the topics written over their areas; zooming back in shows the card texts again. The user chose coloured areas in addition to labels and one topic level.

## 1. Goal and done condition

Below a zoom threshold the graph becomes a map: every topic's cards are covered by a soft coloured area with the topic name over it, the cards lose their text and become colour blocks. Zooming back in fades the map out and the texts return.

**Done when** on a canvas with several topics: zooming out fades in areas and labels smoothly; a topic that lives in two places of the canvas shows two areas with a label each; labels keep their screen size at every zoom level and never overlap; clicking a label zooms into that area; the sidebar's active topic dims the other areas; nothing is written to the vault.

## 2. Decisions

| Topic | Decision |
|---|---|
| Source | `topics[0]` of every node (M6). Nodes without a topic get no area. Purely derived in the browser — no file, no `graph.canvas` group nodes (canvas stays free of chatmind extras), invisible in Obsidian. |
| Levels | One: the M6 topics. Super-topics (an LLM grouping topics) are a later extension. |
| Regions | Per topic, cards are joined into a region when their rectangles, each padded by `REGION_PAD = 60`, overlap (i.e. gap < 120 px — one layout gap of 80 px always joins). Connected components (union-find); a topic spread over the canvas yields several regions. |
| Area | The union of the padded card rectangles (corner radius = padding), filled with the topic colour; each region is one SVG group with group opacity, so overlapping rectangles do not darken. Drawn behind edges and cards. |
| Label | Topic name at the centre of the region's card nearest to the mean of its card centres (always inside the area, also for L-shaped regions). Constant screen size: 14 px, growing with `log2(cards)` up to 26 px. Greedy collision in screen space, larger regions first; a label that would overlap one already placed is hidden. |
| Thresholds | Areas and labels fade in linearly from zoom `MAP_FADE_START = 0.5` (invisible) to `MAP_ZOOM = 0.35` (full). Below `MAP_ZOOM` cards hide their text and fill with their topic colour. `minZoom` goes from 0.1 to 0.05 so large canvases fit. *Amended 2026-09-25 (M12 probe): the fade began over still readable cards; now 0.38 → 0.28.* |
| Interaction | Clicking a label fits the view to the region's cards at a readable zoom (≥ 0.55). Labels are the only clickable part of the map; areas let clicks through to the pane. |
| Active topic | With a topic active in the sidebar (M6 §7), the other regions' areas and labels are dimmed. |
| Position source | The canvas layout (`CanvasDto`), not the in-flight drag positions — the map follows a moved card on drop. |

## 3. Files

```
apps/web/src/topic-map.ts    topicRegions(dto, palette), mapOpacity(zoom), visibleLabels(regions, zoom) — pure
apps/web/src/TopicMap.tsx    renders areas and labels through React Flow's ViewportPortal
apps/web/src/GraphView.tsx   mounts TopicMap, `map-mode` class below MAP_ZOOM, minZoom 0.05
apps/web/src/styles.css      areas, labels, map-mode cards
apps/web/test/topic-map.test.ts
```

## 4. Tests

Pure functions only: region joining and splitting, nodes without topic, label anchor inside the region, fade curve, label collision and ordering. The rendering is checked at the manual gate.
