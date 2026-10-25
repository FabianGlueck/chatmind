import type { CanvasDto, NodeDto } from './dto';
import type { Layout, NodeId, Role } from './types';

/**
 * The structural view the pure graph functions (layout, context, tokens) need. `CanvasGraph` satisfies it,
 * and the browser builds one from a `CanvasDto` — so both sides run the same code on the same shape.
 */
export interface NodeLike {
  id: NodeId;
  role: Role;
  parents: NodeId[];
  body: string;
  summary: string;
}

export interface GraphLike<N extends NodeLike = NodeLike> {
  nodes: ReadonlyMap<NodeId, N>;
  layout: ReadonlyMap<NodeId, Layout>;
}

export function graphLikeFromDto(dto: CanvasDto): GraphLike<NodeDto> {
  return {
    nodes: new Map(dto.nodes.map((n) => [n.id, n])),
    layout: new Map(dto.nodes.map((n) => [n.id, n.layout])),
  };
}
