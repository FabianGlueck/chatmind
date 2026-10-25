import type { CanvasDto, NodeDto } from '@chatmind/core';

export type NavKey = 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight';

const byId = (a: NodeDto, b: NodeDto): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const childrenOf = (dto: CanvasDto, id: string | null): NodeDto[] =>
  dto.nodes.filter((n) => (id === null ? n.parents.length === 0 : n.parents[0] === id)).sort(byId);

/** Spec §7 keyboard model. Unknown/absent selection: only ArrowDown selects the first root. */
export function nextSelection(dto: CanvasDto, current: string | null, key: NavKey): string | null {
  const node = current === null ? undefined : dto.nodes.find((n) => n.id === current);
  if (!node) return key === 'ArrowDown' ? (childrenOf(dto, null)[0]?.id ?? null) : null;
  const parentId = node.parents[0] ?? null;
  switch (key) {
    case 'ArrowUp': return parentId ?? node.id;
    case 'ArrowDown': return childrenOf(dto, node.id)[0]?.id ?? node.id;
    case 'ArrowLeft':
    case 'ArrowRight': {
      const siblings = childrenOf(dto, parentId);
      const i = siblings.findIndex((n) => n.id === node.id);
      const j = key === 'ArrowLeft' ? i - 1 : i + 1;
      return siblings[j]?.id ?? node.id;
    }
  }
}
