import type { CanvasDto } from '@chatmind/core';

export interface StreamState { model: string; text: string; status: 'streaming' | 'error'; error?: string }

export type StreamAction =
  | { type: 'start'; id: string; model: string }
  | { type: 'delta'; id: string; text: string }
  | { type: 'done'; id: string }
  | { type: 'error'; id: string; message: string };

export function streamsReducer(state: ReadonlyMap<string, StreamState>, action: StreamAction): Map<string, StreamState> {
  const cur = state.get(action.id);
  if (action.type !== 'start' && cur === undefined) return state as Map<string, StreamState>;
  const next = new Map(state);
  switch (action.type) {
    case 'start': next.set(action.id, { model: action.model, text: '', status: 'streaming' }); break;
    case 'delta': next.set(action.id, { ...cur!, text: cur!.text + action.text }); break;
    case 'done': next.delete(action.id); break;
    case 'error': next.set(action.id, { ...cur!, status: 'error', error: action.message }); break;
  }
  return next;
}

/** Overlay live stream text onto the DTO; returns the same object when nothing streams. */
export function applyStreams(dto: CanvasDto, streams: ReadonlyMap<string, StreamState>): CanvasDto {
  if (streams.size === 0) return dto;
  return { ...dto, nodes: dto.nodes.map((n) => (streams.has(n.id) ? { ...n, body: streams.get(n.id)!.text } : n)) };
}
