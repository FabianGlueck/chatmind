export type NodeId = string; // ULID
export type Role = 'user' | 'assistant' | 'note'; // spec M16: a note is text the user placed on the canvas

export interface MessageNode {
  id: NodeId;
  role: Role;
  model?: string; // assistant only
  parents: NodeId[]; // always an array; root = []; first entry is the primary parent
  created: string; // ISO-8601 UTC without milliseconds
  summary: string; // '' until M5 fills it
  topics: string[];
  body: string;
}

export interface Layout {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Canvas content that is not ours (text/group/link nodes and edges touching them), preserved verbatim. */
export interface ForeignCanvasContent {
  nodes: Record<string, unknown>[];
  edges: Record<string, unknown>[];
}

/** Spec M15 §1: one topic's memory file under `<canvas>/memories/`; identity is `topic` (compared by topicKey). */
export interface TopicMemory {
  topic: string;
  covered: NodeId[]; // user-node ids of the turns already distilled into it
  body: string;
  path: string; // vault-relative posix path
}

export interface CanvasGraph {
  slug: string; // folder name
  nodes: Map<NodeId, MessageNode>;
  layout: Map<NodeId, Layout>;
  paths: Map<NodeId, string>; // current vault-relative posix path of each node file
  foreign: ForeignCanvasContent;
  memories?: TopicMemory[]; // spec M15; filled by the reader
}

export type Repair =
  | { kind: 'unparseable-node'; path: string; reason: string }
  | { kind: 'defaulted-field'; id: NodeId; field: string }
  | { kind: 'duplicate-id'; id: NodeId; kept: string; dropped: string }
  | { kind: 'canvas-missing'; canvas: string }
  | { kind: 'canvas-corrupt'; canvas: string; reason: string }
  | { kind: 'path-repaired'; id: NodeId; from: string; to: string }
  | { kind: 'canvas-id-repaired'; id: NodeId; canvasNodeId: string }
  | { kind: 'orphan-canvas-node'; canvas: string; canvasNodeId: string; file: string }
  | { kind: 'duplicate-canvas-node'; canvas: string; canvasNodeId: string; id: NodeId }   // a second canvas entry resolved to a node that already has one; first wins
  | { kind: 'layout-missing'; id: NodeId }
  | { kind: 'dangling-parent'; id: NodeId; parent: NodeId }
  | { kind: 'assistant-parents'; id: NodeId; count: number }   // role: assistant must have exactly one parent (spec M4 §2); reported only
  | { kind: 'edge-mismatch'; canvas: string; detail: string }
  | { kind: 'unparseable-memory'; path: string; reason: string }   // spec M15 §1
  | { kind: 'duplicate-memory'; path: string; topic: string; kept: string };
