import { isoTimestamp, newId } from './ids';
import { columnLayout } from './layout';
import type { CanvasGraph, MessageNode, NodeId, Role } from './types';

export interface TranscriptMessage {
  role: Role;
  content: string;
  summary?: string;
  model?: string;
}

/** Turn a linear transcript into a chain graph: each message's parent is the previous one. */
export function linearGraph(slug: string, messages: TranscriptMessage[], now: () => number = Date.now): CanvasGraph {
  const nodes = new Map<NodeId, MessageNode>();
  let prev: NodeId | undefined;
  for (const m of messages) {
    const ms = now();
    const id = newId(ms);
    const node: MessageNode = {
      id,
      role: m.role,
      parents: prev === undefined ? [] : [prev],
      created: isoTimestamp(ms),
      summary: m.summary ?? '',
      topics: [],
      body: m.content,
    };
    if (m.role === 'assistant' && m.model !== undefined) node.model = m.model;
    nodes.set(id, node);
    prev = id;
  }
  return { slug, nodes, layout: columnLayout([...nodes.keys()]), paths: new Map(), foreign: { nodes: [], edges: [] } };
}
