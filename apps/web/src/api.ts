import type { CanvasDto, CanvasSummaryDto, LinksDto, MemoryDto, ModelDto, NodeDto, SendRequest } from '@chatmind/core';

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, signal ? { signal } : undefined);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return (await res.json()) as T;
}

export function fetchCanvases(): Promise<CanvasSummaryDto[]> {
  return getJson('/api/canvases');
}

export function fetchCanvas(slug: string): Promise<CanvasDto> {
  return getJson(`/api/canvases/${encodeURIComponent(slug)}`);
}

/** Spec M7 §5: the node's semantic links. */
export function fetchLinks(slug: string, id: string, signal?: AbortSignal): Promise<LinksDto> {
  return getJson(`/api/canvases/${encodeURIComponent(slug)}/nodes/${encodeURIComponent(id)}/links`, signal);
}

/** Spec M13: where the server serves an attachment of canvas `slug`. */
export const attachmentUrl = (slug: string, name: string): string => `/api/canvases/${encodeURIComponent(slug)}/attachments/${name}`;

export function fetchModels(): Promise<ModelDto[]> {
  return getJson('/api/models');
}

export async function createCanvas(name: string): Promise<CanvasSummaryDto> {
  const res = await fetch('/api/canvases', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) });
  if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `${res.status}`);
  return (await res.json()) as CanvasSummaryDto;
}

/** Returns the raw Response so the caller can read the SSE body. */
export function sendMessage(slug: string, req: SendRequest): Promise<Response> {
  return fetch(`/api/canvases/${encodeURIComponent(slug)}/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(req) });
}

async function postJson<T>(url: string, method: 'POST' | 'PATCH', body: unknown): Promise<T> {
  const res = await fetch(url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `${res.status}`);
  return (await res.json()) as T;
}

/** Spec M8 §4.2: persist the user's move. */
export function moveCards(slug: string, positions: Record<string, { x: number; y: number }>): Promise<{ ignored: string[] }> {
  return postJson(`/api/canvases/${encodeURIComponent(slug)}/layout`, 'PATCH', { positions });
}

/** Spec M11 §5/§11: compress the turns among `ids`; old id → covering new id in `replacement`. */
export function compressStrand(slug: string, ids: string[], model: string, fold = false): Promise<{ removed: string[]; added: string[]; replacement: Record<string, string> }> {
  return postJson(`/api/canvases/${encodeURIComponent(slug)}/compress`, 'POST', { ids, model, fold });
}

/** Spec M8 §5.3: delete the turns of `ids`; the server expands and splices. */
export function deleteTurns(slug: string, ids: string[]): Promise<{ deleted: string[]; reparented: string[] }> {
  return postJson(`/api/canvases/${encodeURIComponent(slug)}/delete`, 'POST', { ids });
}

/** Spec M15 §5: save a topic memory against the body the edit started from; a conflict returns the current body. */
export async function saveMemory(slug: string, topic: string, body: string, base: string): Promise<{ ok: true; memory: MemoryDto } | { ok: false; current: string }> {
  const res = await fetch(`/api/canvases/${encodeURIComponent(slug)}/memories`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ topic, body, base }) });
  const data = (await res.json().catch(() => ({}))) as MemoryDto & { error?: string };
  if (res.status === 409) return { ok: false, current: data.body ?? '' };
  if (!res.ok) throw new Error(data.error ?? `${res.status}`);
  return { ok: true, memory: data };
}

/** Spec M16 §3: place a note on the canvas — at `at` (top-left, canvas units), or in the next free root slot. */
export function createNote(slug: string, body: string, at?: { x: number; y: number }): Promise<NodeDto> {
  return postJson(`/api/canvases/${encodeURIComponent(slug)}/notes`, 'POST', at ? { body, at } : { body });
}

/**
 * Spec M17 §2 (M16 §3 for notes): save a card's body against the body the edit started from. A conflict returns the
 * current body; a 409 without one (the card is still streaming) is an error like any other.
 */
export async function saveNode(slug: string, id: string, body: string, base: string): Promise<{ ok: true; node: NodeDto } | { ok: false; current: string }> {
  const res = await fetch(`/api/canvases/${encodeURIComponent(slug)}/nodes/${encodeURIComponent(id)}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ body, base }) });
  const data = (await res.json().catch(() => ({}))) as Partial<NodeDto> & { error?: string };
  if (res.status === 409 && typeof data.body === 'string') return { ok: false, current: data.body };
  if (!res.ok) throw new Error(data.error ?? `${res.status}`);
  return { ok: true, node: data as NodeDto };
}

/** Spec M17 §4: ask the model to rewrite a card; the raw Response carries the SSE body (`delta` … `done`/`error`). Writes nothing. */
export function rewriteNode(slug: string, id: string, req: { instruction: string; model: string; draft?: string }, signal?: AbortSignal): Promise<Response> {
  return fetch(`/api/canvases/${encodeURIComponent(slug)}/nodes/${encodeURIComponent(id)}/rewrite`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(req), ...(signal ? { signal } : {}) });
}

/** Spec M17 §6: the card's title (its summary); 409 carries the summary the file holds now. */
export async function saveSummary(slug: string, id: string, summary: string, base: string): Promise<{ ok: true; node: NodeDto } | { ok: false; current: string }> {
  const res = await fetch(`/api/canvases/${encodeURIComponent(slug)}/nodes/${encodeURIComponent(id)}/summary`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ summary, base }) });
  const data = (await res.json().catch(() => ({}))) as Partial<NodeDto> & { error?: string };
  if (res.status === 409 && typeof data.summary === 'string') return { ok: false, current: data.summary };
  if (!res.ok) throw new Error(data.error ?? `${res.status}`);
  return { ok: true, node: data as NodeDto };
}
