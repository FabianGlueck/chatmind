import type { CanvasDto, LinksDto } from '@chatmind/core';
import { Background, Controls, MiniMap, ReactFlow, ReactFlowProvider, useReactFlow, useStore, type Node, type NodeChange, type XYPosition } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { NODE_HEIGHT, NODE_WIDTH } from '@chatmind/core/graph';
import { useEffect, useMemo, useRef, useState, type DragEvent, type MutableRefObject } from 'react';
import { GHOST_ID, movedPositions, toFlowEdges, toFlowNodes, type FlowMarks, type MessageFlowNode, type TopicMarks } from './flow';
import { GhostNode } from './GhostNode';
import { MessageNode } from './MessageNode';
import { MAP_ZOOM, topicRegions } from './topic-map';
import { TopicMap } from './TopicMap';
import type { StreamState } from './streams';

const nodeTypes = { message: MessageNode, ghost: GhostNode };

interface Props {
  canvas: CanvasDto;
  streams: ReadonlyMap<string, StreamState>;
  marks: FlowMarks;
  topics: TopicMarks;
  cursorId: string | null;
  focusIds: string[] | null;
  /** Spec M7 §6: the cursor's semantic links, drawn as dashed edges within this canvas. */
  links?: LinksDto | null;
  /** Spec M8 §4.1: the move selection — React Flow's `selected`, separate from cursor and merge targets. */
  moveSelection?: ReadonlySet<string>;
  onMoveSelection?: (update: (s: ReadonlySet<string>) => ReadonlySet<string>) => void;
  /** Called once per finished drag with the final positions of every card that actually moved. */
  onMove?: (positions: Record<string, XYPosition>) => void;
  onCursor: (id: string) => void;
  /** Double click on a card: read it in the chat view. */
  onOpen?: (id: string) => void;
  onToggle: (id: string) => void;
  onClear: () => void;
  /** Spec M16 §6: text pasted on the canvas or text files dropped on it; `at` is the first card's top-left, `skipped` the files that were not text. */
  onNotes?: (texts: string[], at: XYPosition, skipped: number) => void;
  /** Spec M16 §6: set to a function giving the top-left of a card centred in the viewport (for "+ Note"). */
  centreRef?: MutableRefObject<(() => XYPosition) | null>;
}

const TYPING_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);
/** Spec M16 §1: what a dropped file must look like to become a note. */
export const isTextFile = (f: { name: string; type: string }): boolean => f.type.startsWith('text/') || /\.(md|markdown|txt)$/i.test(f.name);

function Camera({ focusIds }: { focusIds: string[] | null }) {
  const rf = useReactFlow();
  useEffect(() => {
    if (!focusIds || focusIds.length === 0) return;
    const zoom = rf.getZoom();
    try {
      void rf.fitView({ nodes: focusIds.map((id) => ({ id })), padding: 0.4, duration: 300, minZoom: Math.min(zoom, 1), maxZoom: zoom });
    } catch {
      // React Flow's fitView can throw under jsdom (no real layout); ignore there.
    }
  }, [focusIds, rf]);
  return null;
}

const EMPTY_SET: ReadonlySet<string> = new Set();
// Spec M8 §4.1: Shift keeps its M4 meaning (merge target), so box and multi selection use Cmd (macOS) / Ctrl.
const MULTI_KEYS = ['Meta', 'Control'];

function Inner({ canvas, streams, marks, topics, cursorId, focusIds, links, moveSelection = EMPTY_SET, onMoveSelection, onMove, onCursor, onOpen, onToggle, onClear, onNotes, centreRef }: Props) {
  const rf = useReactFlow();
  const wrapper = useRef<HTMLDivElement>(null);
  // Spec M16 §6: the last pointer position over the canvas (client coords), where a paste lands; null once it leaves.
  const pointer = useRef<{ x: number; y: number } | null>(null);
  const cardAt = (client: { x: number; y: number }): XYPosition => {
    const p = rf.screenToFlowPosition(client);
    return { x: p.x - NODE_WIDTH / 2, y: p.y - NODE_HEIGHT / 2 };
  };
  const centre = (): XYPosition => {
    const r = wrapper.current?.getBoundingClientRect();
    return cardAt(r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : { x: 0, y: 0 });
  };
  const notesRef = useRef(onNotes);
  notesRef.current = onNotes;
  const centreFn = useRef(centre);
  centreFn.current = centre;
  useEffect(() => {
    if (!centreRef) return;
    centreRef.current = () => centreFn.current();
    return () => { centreRef.current = null; };
  }, [centreRef]);
  // Spec M16 §6: ⌘V with the canvas (or nothing) focused turns pasted text into a note; typing fields keep their paste.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent): void => {
      const t = e.target as HTMLElement | null;
      if (t && (TYPING_TAGS.has(t.tagName) || t.isContentEditable)) return;
      const inScope = !t || t === document.body || (wrapper.current?.contains(t) ?? false);
      const text = e.clipboardData?.getData('text/plain') ?? '';
      if (!inScope || text.trim() === '' || !notesRef.current) return;
      e.preventDefault();
      notesRef.current([text], pointer.current ? cardAt(pointer.current) : centreFn.current(), 0);
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [rf]);
  const onDrop = (e: DragEvent<HTMLDivElement>): void => {
    const files = [...e.dataTransfer.files];
    if (files.length === 0 || !onNotes) return;
    e.preventDefault();
    const at = cardAt({ x: e.clientX, y: e.clientY });
    const texts = files.filter(isTextFile);
    void Promise.all(texts.map((f) => f.text())).then((bodies) => onNotes(bodies, at, files.length - texts.length));
  };
  // Positions while a drag is running; cleared on drag stop, when the canvas carries them (spec M8 §4.1).
  const [dragPos, setDragPos] = useState<ReadonlyMap<string, XYPosition>>(new Map());
  const boxing = useRef(false);
  const nodes = useMemo(
    () =>
      toFlowNodes(canvas, streams, marks, topics).map((n) => {
        const p = dragPos.get(n.id);
        const moved = p ? { ...n, position: p } : n;
        return n.type === 'message' ? ({ ...moved, selected: moveSelection.has(n.id), data: n.id === cursorId ? { ...n.data, cursor: true } : n.data } as MessageFlowNode) : moved;
      }),
    [canvas, streams, marks, topics, cursorId, dragPos, moveSelection],
  );
  const edges = useMemo(() => toFlowEdges(canvas, marks, links), [canvas, marks, links]);
  // Spec M10: the topic map follows the canvas layout (not drag positions); map mode flips only at MAP_ZOOM.
  const regions = useMemo(() => topicRegions(canvas, topics.palette), [canvas, topics.palette]);
  const mapMode = useStore((s) => s.transform[2] < MAP_ZOOM);
  // Controlled nodes: only drag positions and box-selection changes are applied; clicks, removals and
  // React Flow's own click selection are ignored — App owns cursor, targets and the move selection.
  const onNodesChange = (changes: NodeChange[]): void => {
    const pos = new Map<string, XYPosition>();
    const sel: [string, boolean][] = [];
    for (const c of changes) {
      if (c.type === 'position' && c.position) pos.set(c.id, c.position);
      else if (c.type === 'select' && boxing.current && c.id !== GHOST_ID) sel.push([c.id, c.selected]);
    }
    if (pos.size > 0) setDragPos((d) => new Map([...d, ...pos]));
    if (sel.length > 0) onMoveSelection?.((s) => {
      const next = new Set(s);
      for (const [id, on] of sel) if (on) next.add(id); else next.delete(id);
      return next;
    });
  };
  const dragStop = (dragged: Node[]): void => {
    const moved = movedPositions(canvas, dragged);
    setDragPos(new Map());
    if (Object.keys(moved).length > 0) onMove?.(moved);
  };
  return (
    <ReactFlow
      ref={wrapper}
      onMouseMove={(e) => { pointer.current = { x: e.clientX, y: e.clientY }; }}
      onMouseLeave={() => { pointer.current = null; }}
      onDragOver={(e) => { if (onNotes && e.dataTransfer.types.includes('Files')) e.preventDefault(); }}
      onDrop={onDrop}
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      className={mapMode ? 'map-mode' : undefined}
      fitView
      nodesDraggable
      nodesConnectable={false}
      elementsSelectable
      selectionKeyCode={MULTI_KEYS}
      multiSelectionKeyCode={MULTI_KEYS}
      deleteKeyCode={null}
      minZoom={0.05}
      onNodesChange={onNodesChange}
      onNodeDragStop={(_, __, dragged) => dragStop(dragged)}
      onSelectionDragStop={(_, dragged) => dragStop(dragged)}
      onSelectionStart={() => { boxing.current = true; }}
      onSelectionEnd={() => { boxing.current = false; }}
      onNodeClick={(event, node) => {
        if (node.id === GHOST_ID) return;
        if (event.metaKey || event.ctrlKey) {
          onMoveSelection?.((s) => {
            const next = new Set(s);
            if (!next.delete(node.id)) next.add(node.id);
            return next;
          });
          return;
        }
        const badge = (event.target as HTMLElement).closest('.context-badge');
        // The badge is a <button>, which the graph key handler deliberately ignores — hand focus
        // to the node wrapper (where a plain node click leaves it) so Space/Esc keep working.
        if (badge !== null) (event.currentTarget as HTMLElement).focus();
        if (badge !== null || event.shiftKey) onToggle(node.id);
        else onCursor(node.id);
      }}
      onNodeDoubleClick={(_, node) => { if (node.id !== GHOST_ID) onOpen?.(node.id); }}
      onPaneClick={onClear}
      proOptions={{ hideAttribution: true }}
    >
      <Background gap={28} size={1.4} />
      <Controls showInteractive={false} />
      <MiniMap pannable zoomable style={{ width: 168, height: 112 }} nodeBorderRadius={24} nodeClassName={(n) => `${n.type === 'message' ? `role-${(n as MessageFlowNode).data.role}${(n as MessageFlowNode).data.inContext && !(n as MessageFlowNode).data.excluded ? ' in-context' : ''}` : ''}${n.id === cursorId ? ' cursor' : ''}`} />
      <Camera focusIds={focusIds} />
      <TopicMap regions={regions} active={topics.active} />
    </ReactFlow>
  );
}

export function GraphView(props: Props) {
  return (
    <ReactFlowProvider>
      <Inner {...props} />
    </ReactFlowProvider>
  );
}
