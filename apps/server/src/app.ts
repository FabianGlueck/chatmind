import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  attachmentEmbed,
  attachmentType,
  buildContext,
  buildEditContext,
  cleanRewrite,
  carryCovered,
  memoryOf,
  writeMemory,
  COMPRESS_SYSTEM,
  compressPrompt,
  compressionSections,
  MIN_COMPRESS_TURNS,
  deleteNodes,
  deleteSet,
  exists,
  idAt,
  isCanvasSlug,
  isoTimestamp,
  moveNodes,
  MAX_BODY_CHARS,
  newId,
  normalizeBody,
  parseCompression,
  planCompression,
  placeAt,
  placeChild,
  placeNear,
  densestStrand,
  readCanvas,
  readVault,
  replaceNodes,
  slug,
  toCanvasDto,
  toCanvasSummaryDto,
  toNodeDto,
  validateTargets,
  VaultLock,
  MAX_SUMMARY_CHARS,
  cleanSummaryInput,
  writeCanvas,
  writeCanvasFile,
  writeNode,
  type CanvasGraph,
  type MessageNode,
  type Section,
  type ReadResult,
  type SendRequest,
} from '@chatmind/core';
import type { IndexStatus, VaultWatcher } from '@chatmind/index';
import { generateText, streamText } from 'ai';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { attachmentsDir, decodeImages, withImages, writeAttachments } from './attachments';
import { startCompletion, type CompletionEvent, type CompletionJob } from './completion';
import type { Keys } from './keys';
import type { LinkService } from './links';
import type { TopicPlacer } from './placement';
import { findModel, isAvailable, modelDtos } from './models';
import { createModelFactory, type ModelFactory } from './providers';

export interface AppOptions {
  dataDir: string;
  /** Built frontend (apps/web/dist). When omitted, only /api routes exist. */
  staticDir?: string;
  keys?: Keys;
  modelFactory?: ModelFactory;
  /** Shared with the indexer so both hold the vault lock during a write (spec M5 §8). */
  lock?: VaultLock;
  /** File watcher feeding /api/events; absent in tests that need no events. */
  watcher?: Pick<VaultWatcher, 'onChange'>;
  /** Background indexer; absent when no key or --no-index (spec M5 §8). */
  indexer?: { status(): IndexStatus };
  /** Semantic links (spec M7 §5); absent means every node answers `no-index`. */
  links?: Pick<LinkService, 'links'>;
  /** Spec M14: places a new strand next to its topic; absent (no indexer) means the old placement. */
  placer?: Pick<TopicPlacer, 'pick'>;
}

/** Read the vault; a missing data dir is an empty vault, everything else propagates. */
async function readOrEmpty(dataDir: string): Promise<ReadResult> {
  try {
    return await readVault(dataDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { canvases: [], repairs: [] };
    throw err;
  }
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
};

export function createApp({ dataDir, staticDir, ...options }: AppOptions): Hono {
  const app = new Hono();
  const keys = options.keys ?? {};
  const modelFactory = options.modelFactory ?? createModelFactory(keys);
  const lock = options.lock ?? new VaultLock();
  const { watcher, indexer, links, placer } = options;

  // `c.req.json()` does no content-type check, so a `mode:'no-cors'` cross-site fetch (which cannot set a
  // custom content-type, only text/plain, multipart/form-data, or application/x-www-form-urlencoded) would
  // otherwise be accepted here: it could write a user node and spend the user's API key. Require an explicit
  // application/json body and, when an Origin header is present, require it to be localhost.
  app.use('/api/*', async (c, next) => {
    if (c.req.method !== 'GET') {
      const ct = c.req.header('content-type') ?? '';
      if (!ct.toLowerCase().startsWith('application/json')) return c.json({ error: 'content-type must be application/json' }, 415);
      const origin = c.req.header('origin');
      if (origin !== undefined) {
        let host = '';
        try {
          host = new URL(origin).hostname;
        } catch {
          // malformed origin → reject below
        }
        if (host !== 'localhost' && host !== '127.0.0.1' && host !== '[::1]' && host !== '::1') {
          return c.json({ error: 'cross-origin requests are not allowed' }, 403);
        }
      }
    }
    await next();
  });

  app.get('/api/canvases', async (c) => {
    const { canvases } = await readOrEmpty(dataDir);
    return c.json(canvases.map(toCanvasSummaryDto).sort((a, b) => (a.slug < b.slug ? -1 : 1)));
  });

  app.get('/api/canvases/:slug', async (c) => {
    const { canvases, repairs } = await readOrEmpty(dataDir);
    const graph = canvases.find((g) => g.slug === c.req.param('slug'));
    if (!graph) return c.json({ error: 'canvas not found' }, 404);
    return c.json(toCanvasDto(graph, repairs));
  });

  // Spec M7 §5: the selected node's semantic links, computed per request.
  app.get('/api/canvases/:slug/nodes/:id/links', async (c) => {
    const { canvases } = await readOrEmpty(dataDir);
    const slug = c.req.param('slug');
    const id = c.req.param('id');
    const graph = canvases.find((g) => g.slug === slug);
    if (!graph?.nodes.has(id)) return c.json({ error: 'node not found' }, 404);
    return c.json(links?.links(canvases, slug, id) ?? { from: null, links: [], reason: 'no-index' });
  });

  app.post('/api/canvases', async (c) => {
    const body = (await c.req.json().catch(() => null)) as { name?: unknown } | null;
    const name = typeof body?.name === 'string' ? body.name : '';
    const s = slug(name);
    if (!isCanvasSlug(s)) return c.json({ error: 'name must contain letters or digits' }, 400);
    const created = await lock.run(async () => {
      if (await exists(path.join(dataDir, s))) return false;
      const graph: CanvasGraph = { slug: s, nodes: new Map(), layout: new Map(), paths: new Map(), foreign: { nodes: [], edges: [] } };
      await writeCanvas(graph, dataDir);
      return true;
    });
    if (!created) return c.json({ error: 'canvas exists' }, 409);
    return c.json({ slug: s, nodeCount: 0 }, 201);
  });

  app.get('/api/models', (c) => c.json(modelDtos(keys)));

  // kept until finished; reattach after reload is a later milestone (spec §4)
  const jobs = new Map<string, CompletionJob>();
  // assistant id → its user node, while the completion runs: a delete must not remove either (spec M8 §5.3)
  const inFlight = new Map<string, string>();

  app.post('/api/canvases/:slug/messages', async (c) => {
    const body = (await c.req.json().catch(() => null)) as Partial<SendRequest> | null;
    if (!body || typeof body !== 'object') return c.json({ error: 'body must be a JSON object' }, 400);
    const content = typeof body.content === 'string' ? body.content.trim() : '';
    const images = decodeImages(body.images);
    if (typeof images === 'string') return c.json({ error: images }, 400);
    if (content === '' && images.length === 0) return c.json({ error: 'content must not be empty' }, 400);
    const parentIds = Array.isArray(body.parentIds) && body.parentIds.every((p) => typeof p === 'string') ? (body.parentIds as string[]) : null;
    if (parentIds === null) return c.json({ error: 'parentIds must be an array of node ids' }, 400);
    const excludedIds = body.excludedIds === undefined ? [] : Array.isArray(body.excludedIds) && body.excludedIds.every((p) => typeof p === 'string') ? (body.excludedIds as string[]) : null;
    if (excludedIds === null) return c.json({ error: 'excludedIds must be an array of node ids' }, 400);
    const memoryTopics = body.memoryTopics === undefined ? [] : Array.isArray(body.memoryTopics) && body.memoryTopics.every((t) => typeof t === 'string') ? (body.memoryTopics as string[]) : null;
    if (memoryTopics === null) return c.json({ error: 'memoryTopics must be an array of topic names' }, 400);
    const spec = typeof body.model === 'string' ? findModel(body.model) : undefined;
    if (!spec) return c.json({ error: 'unknown model' }, 400);
    if (!isAvailable(spec, keys)) return c.json({ error: `model ${spec.id} is not available (missing ${spec.provider} API key)` }, 400);

    // Spec M14: a new strand's topic is decided before the lock (embedding, maybe an LLM), so a slow provider never
    // holds the vault; inside the lock only the slot is computed, on the fresh graph.
    const slugParam = c.req.param('slug');
    const rootGraph = parentIds.length === 0 && placer && content !== '' ? (await readCanvas(dataDir, slugParam).catch(() => null))?.graph : undefined;
    const rootTopic = rootGraph ? await placer!.pick(rootGraph, content) : null;

    // 1. read + validate the canvas/targets + insert & write the user node, all inside one lock turn: two
    // concurrent sends on the same canvas must never read-then-overwrite each other's user node.
    const prepared = await lock.run(async () => {
      const { canvases } = await readOrEmpty(dataDir);
      const graph = canvases.find((g) => g.slug === slugParam);
      if (!graph) return { error: 404 as const, message: 'canvas not found' };
      const invalid = validateTargets(graph, parentIds, excludedIds);
      if (invalid !== null) return { error: 400 as const, message: invalid };
      // Spec M13: images land in attachments/ first, then the node that embeds them.
      const names = await writeAttachments(dataDir, graph.slug, images);
      const userBody = [content, names.map(attachmentEmbed).join('\n')].filter((p) => p !== '').join('\n\n');
      const userMs = Date.now();
      const user: MessageNode = { id: newId(userMs), role: 'user', parents: [...parentIds], created: isoTimestamp(userMs), summary: '', topics: [], body: userBody };
      const near = rootTopic === null ? null : placeNear(graph, densestStrand(graph, [...graph.nodes.values()].filter((n) => n.topics[0] === rootTopic).map((n) => n.id)));
      const userLayout = near ?? placeChild(graph, parentIds[0] ?? null);
      graph.nodes.set(user.id, user);
      graph.layout.set(user.id, userLayout);
      await writeNode(graph, user.id, dataDir);
      await writeCanvasFile(graph, dataDir);
      return { graph, user, userLayout };
    });
    if ('error' in prepared) return c.json({ error: prepared.message }, prepared.error);
    const { graph, user, userLayout } = prepared;

    // 2. assistant node in memory + context
    const aMs = Date.now();
    const assistant: MessageNode = { id: newId(aMs), role: 'assistant', model: spec.id, parents: [user.id], created: isoTimestamp(aMs), summary: '', topics: [], body: '' };
    const assistantLayout = placeChild(graph, user.id);
    // Spec M15 §4: the memories come from the files, not the request; unknown topics are skipped.
    const memories = memoryTopics.map((t) => memoryOf(graph.memories, t)).filter((m) => m !== undefined).map((m) => ({ topic: m.topic, body: m.body }));
    const { system, messages } = buildContext(graph, parentIds, excludedIds, user.body, memories);

    // 3. completion runs independently of this response
    const job = startCompletion({ dataDir, slug: graph.slug, assistant, layout: assistantLayout, model: modelFactory(spec), system, messages: await withImages(messages, attachmentsDir(dataDir, graph.slug)), lock });
    jobs.set(assistant.id, job);
    inFlight.set(assistant.id, user.id);
    void job.finished.finally(() => {
      jobs.delete(assistant.id);
      inFlight.delete(assistant.id);
    });

    // Note (known M3 limitation): the assistant layout is computed against the request-time graph; a
    // completion from another request finishing in between could yield overlapping slots.
    return streamSSE(c, async (stream) => {
      await stream.writeSSE({ event: 'user-node', data: JSON.stringify(toNodeDto(user, userLayout)) });
      await stream.writeSSE({ event: 'assistant-start', data: JSON.stringify({ id: assistant.id, model: spec.id, layout: assistantLayout, parents: [user.id], created: assistant.created }) });
      let unsubscribe = (): void => undefined;
      await new Promise<void>((resolve) => {
        // `subscribe` replays synchronously — if the job already finished (e.g. a fast provider failure), the
        // terminal event arrives before `job.subscribe(...)` has even returned. So `deliver` never references
        // the `unsubscribe` binding (that would be a TDZ ReferenceError on that synchronous replay); instead it
        // records `settled` and the caller unsubscribes afterwards if needed.
        let settled = false;
        const deliver = (e: CompletionEvent): void => {
          const data = e.type === 'delta' ? { text: e.text } : e.type === 'done' ? e.node : { message: e.message, partial: e.partial };
          const written = stream.writeSSE({ event: e.type, data: JSON.stringify(data) }).catch(() => undefined);
          if (e.type !== 'delta') {
            settled = true;
            void written.then(resolve);
          }
        };
        unsubscribe = job.subscribe(deliver);
        if (settled) unsubscribe();
        // The completion (`job`) runs independently of this HTTP connection — a client that disconnects
        // must not affect it (spec §7). But this handler's own promise must still settle when the client
        // goes away, so it stops delivering into a dead stream and its subscriber slot is freed.
        stream.onAbort(() => {
          unsubscribe();
          resolve();
        });
      });
    });
  });

  // Spec M13: an image the composer attached; only ULID-named attachment files are served.
  app.get('/api/canvases/:slug/attachments/:name', async (c) => {
    const slugParam = c.req.param('slug');
    const name = c.req.param('name');
    const type = attachmentType(name);
    if (slugParam.startsWith('.') || /[/\\]/.test(slugParam) || type === undefined) return c.json({ error: 'not found' }, 404);
    try {
      const bytes = await fs.readFile(path.join(attachmentsDir(dataDir, slugParam), name));
      return c.body(bytes, 200, { 'content-type': type, 'cache-control': 'private, max-age=31536000, immutable' });
    } catch {
      return c.json({ error: 'not found' }, 404);
    }
  });

  // Spec M15 §5: the user's edit of a topic memory; `base` guards against an append or an Obsidian edit meanwhile.
  app.put('/api/canvases/:slug/memories', async (c) => {
    const body = (await c.req.json().catch(() => null)) as { topic?: unknown; body?: unknown; base?: unknown } | null;
    const topic = typeof body?.topic === 'string' ? body.topic.trim() : '';
    if (topic === '' || typeof body?.body !== 'string' || typeof body.base !== 'string') return c.json({ error: 'topic, body and base must be strings' }, 400);
    const text = body.body;
    const base = body.base;
    const result = await lock.run(async () => {
      const found = await readCanvas(dataDir, c.req.param('slug'));
      if (!found) return { error: 404 as const, message: 'canvas not found' };
      const cur = memoryOf(found.graph.memories, topic);
      if ((cur?.body ?? '') !== base) return { error: 409 as const, message: 'the memory changed meanwhile', body: cur?.body ?? '' };
      const m = await writeMemory(found.graph, { topic: cur?.topic ?? topic, covered: cur?.covered ?? [], body: text, ...(cur ? { path: cur.path } : {}) }, dataDir);
      return { topic: m.topic, body: m.body, covered: m.covered.length };
    });
    if ('error' in result) return c.json({ error: result.message, ...('body' in result ? { body: result.body } : {}) }, result.error);
    return c.json(result);
  });

  // Spec M16 §3: a note the user placed on the canvas — no parents, no LLM call; at the free spot nearest `at`, else the next root slot.
  app.post('/api/canvases/:slug/notes', async (c) => {
    const req = (await c.req.json().catch(() => null)) as { body?: unknown; at?: unknown } | null;
    const text = typeof req?.body === 'string' ? req.body : '';
    if (text.trim() === '') return c.json({ error: 'body must be a non-empty string' }, 400);
    if (text.length > MAX_BODY_CHARS) return c.json({ error: `a note holds at most ${MAX_BODY_CHARS} characters` }, 400);
    const at = req?.at as { x?: unknown; y?: unknown } | undefined;
    if (at !== undefined && (typeof at !== 'object' || at === null || !Number.isFinite(at.x) || !Number.isFinite(at.y))) return c.json({ error: 'at must be finite { x, y }' }, 400);
    const result = await lock.run(async () => {
      const found = await readCanvas(dataDir, c.req.param('slug'));
      if (!found) return null;
      const { graph } = found;
      const ms = Date.now();
      const note: MessageNode = { id: newId(ms), role: 'note', parents: [], created: isoTimestamp(ms), summary: '', topics: [], body: normalizeBody(text) };
      const layout = at === undefined ? placeChild(graph, null) : placeAt(graph, at as { x: number; y: number });
      graph.nodes.set(note.id, note);
      graph.layout.set(note.id, layout);
      await writeNode(graph, note.id, dataDir);
      await writeCanvasFile(graph, dataDir);
      return toNodeDto(note, layout);
    });
    if (result === null) return c.json({ error: 'canvas not found' }, 404);
    return c.json(result, 201);
  });

  /** Spec M17 §1: a card whose answer still streams — the assistant node or its question. */
  const streaming = (id: string): boolean => [...inFlight].some(([a, u]) => a === id || u === id);

  // Spec M16 §3, M17 §4: the user's edit of any card's body — typed by hand or an accepted model rewrite; `base`
  // guards against an Obsidian edit meanwhile. Nothing but the body changes; an unchanged body is not written.
  app.put('/api/canvases/:slug/nodes/:id', async (c) => {
    const req = (await c.req.json().catch(() => null)) as { body?: unknown; base?: unknown } | null;
    if (typeof req?.body !== 'string' || typeof req.base !== 'string') return c.json({ error: 'body and base must be strings' }, 400);
    const text = req.body;
    const base = req.base;
    if (text.trim() === '') return c.json({ error: 'body must not be empty' }, 400);
    if (text.length > MAX_BODY_CHARS) return c.json({ error: `a card holds at most ${MAX_BODY_CHARS} characters` }, 400);
    const id = c.req.param('id');
    const result = await lock.run(async () => {
      if (streaming(id)) return { error: 409 as const, message: 'a reply is still streaming' };
      const found = await readCanvas(dataDir, c.req.param('slug'));
      const n = found?.graph.nodes.get(id);
      if (!found || !n) return { error: 404 as const, message: 'not found' };
      if (n.body !== normalizeBody(base)) return { error: 409 as const, message: 'the card changed meanwhile', body: n.body };
      const next = normalizeBody(text);
      if (next !== n.body) {
        n.body = next;
        await writeNode(found.graph, n.id, dataDir);
      }
      return toNodeDto(n, found.graph.layout.get(n.id)!);
    });
    if ('error' in result) return c.json({ error: result.message, ...('body' in result ? { body: result.body } : {}) }, result.error);
    return c.json(result);
  });

  // Spec M17 §6: the user's own summary (the card's title) — one line, at most MAX_SUMMARY_CHARS; empty hands it back
  // to the indexer. Once it differs from what the indexer wrote, the indexer leaves it alone (its "still ours" rule).
  app.put('/api/canvases/:slug/nodes/:id/summary', async (c) => {
    const req = (await c.req.json().catch(() => null)) as { summary?: unknown; base?: unknown } | null;
    if (typeof req?.summary !== 'string' || typeof req.base !== 'string') return c.json({ error: 'summary and base must be strings' }, 400);
    const summary = cleanSummaryInput(req.summary);
    const base = req.base;
    if (summary.length > MAX_SUMMARY_CHARS) return c.json({ error: `a summary holds at most ${MAX_SUMMARY_CHARS} characters` }, 400);
    const id = c.req.param('id');
    const result = await lock.run(async () => {
      if (streaming(id)) return { error: 409 as const, message: 'a reply is still streaming' };
      const found = await readCanvas(dataDir, c.req.param('slug'));
      const n = found?.graph.nodes.get(id);
      if (!found || !n) return { error: 404 as const, message: 'not found' };
      if (n.summary !== base) return { error: 409 as const, message: 'the summary changed meanwhile', summary: n.summary };
      if (summary !== n.summary) {
        n.summary = summary;
        await writeNode(found.graph, n.id, dataDir);
      }
      return toNodeDto(n, found.graph.layout.get(n.id)!);
    });
    if ('error' in result) return c.json({ error: result.message, ...('summary' in result ? { summary: result.summary } : {}) }, result.error);
    return c.json(result);
  });

  // Spec M17 §3.3/§4: a model rewrite of one card, streamed as a preview — writes nothing. The graph is read under
  // the lock, the model runs outside it, tied to this request: a client that goes away stops the call.
  app.post('/api/canvases/:slug/nodes/:id/rewrite', async (c) => {
    const req = (await c.req.json().catch(() => null)) as { instruction?: unknown; model?: unknown; draft?: unknown } | null;
    const instruction = typeof req?.instruction === 'string' ? req.instruction.trim() : '';
    if (instruction === '') return c.json({ error: 'instruction must not be empty' }, 400);
    if (req!.draft !== undefined && typeof req!.draft !== 'string') return c.json({ error: 'draft must be a string' }, 400);
    const draft = req!.draft as string | undefined;
    if (instruction.length > MAX_BODY_CHARS || (draft?.length ?? 0) > MAX_BODY_CHARS) return c.json({ error: `at most ${MAX_BODY_CHARS} characters` }, 400);
    const spec = typeof req!.model === 'string' ? findModel(req!.model) : undefined;
    if (!spec) return c.json({ error: 'unknown model' }, 400);
    if (!isAvailable(spec, keys)) return c.json({ error: `model ${spec.id} is not available (missing ${spec.provider} API key)` }, 400);
    const id = c.req.param('id');
    const prepared = await lock.run(async () => {
      if (streaming(id)) return { error: 409 as const, message: 'a reply is still streaming' };
      const found = await readCanvas(dataDir, c.req.param('slug'));
      if (!found) return { error: 404 as const, message: 'canvas not found' };
      if (!found.graph.nodes.has(id)) return { error: 404 as const, message: `unknown node ${id}` };
      return { slug: found.graph.slug, ctx: buildEditContext(found.graph, id, instruction, draft) };
    });
    if ('error' in prepared) return c.json({ error: prepared.message }, prepared.error);
    const { system, messages } = prepared.ctx;
    // The strand above may carry images (M13); the request itself stays text, so the card's embeds survive the rewrite.
    const request = messages[messages.length - 1]!;
    const modelMessages = [...(await withImages(messages.slice(0, -1), attachmentsDir(dataDir, prepared.slug))), { role: 'user' as const, content: request.content }];
    const abort = new AbortController();
    const signal = c.req.raw.signal;
    if (signal.aborted) abort.abort();
    else signal.addEventListener('abort', () => abort.abort(), { once: true });

    return streamSSE(c, async (stream) => {
      stream.onAbort(() => abort.abort());
      let text = '';
      try {
        const result = streamText({ model: modelFactory(spec), system, messages: modelMessages, abortSignal: abort.signal, onError: () => undefined });
        for await (const part of result.fullStream) {
          if (part.type === 'text-delta') {
            text += part.text;
            await stream.writeSSE({ event: 'delta', data: JSON.stringify({ text: part.text }) });
          } else if (part.type === 'error') throw part.error instanceof Error ? part.error : new Error(String(part.error));
        }
        if (abort.signal.aborted) return;
        const clean = normalizeBody(cleanRewrite(text));
        if (clean === '') await stream.writeSSE({ event: 'error', data: JSON.stringify({ message: 'the model returned no text', partial: text !== '' }) });
        else await stream.writeSSE({ event: 'done', data: JSON.stringify({ text: clean }) });
      } catch (err) {
        if (abort.signal.aborted) return;
        await stream.writeSSE({ event: 'error', data: JSON.stringify({ message: err instanceof Error ? err.message : String(err), partial: text !== '' }) }).catch(() => undefined);
      }
    });
  });

  // Spec M8 §4.2: the user's move — only x/y of existing file nodes in graph.canvas change.
  app.patch('/api/canvases/:slug/layout', async (c) => {
    const body = (await c.req.json().catch(() => null)) as { positions?: unknown } | null;
    const positions = body?.positions;
    const valid =
      typeof positions === 'object' && positions !== null && !Array.isArray(positions) &&
      Object.values(positions).every((p) => typeof p === 'object' && p !== null && Number.isFinite((p as { x: unknown }).x) && Number.isFinite((p as { y: unknown }).y));
    if (!valid) return c.json({ error: 'positions must map node ids to finite { x, y }' }, 400);
    const pos = positions as Record<string, { x: number; y: number }>;
    const result = await lock.run(async () => {
      const found = await readCanvas(dataDir, c.req.param('slug'));
      if (!found) return null;
      const moved = moveNodes(found.graph.layout, pos);
      if (moved.length > 0) await writeCanvasFile(found.graph, dataDir);
      return Object.keys(pos).filter((id) => !moved.includes(id));
    });
    if (result === null) return c.json({ error: 'canvas not found' }, 404);
    return c.json({ ignored: result });
  });

  // Spec M8 §5.3: the user's delete — whole turns go to .trash/, survivors are spliced onto the deleted nodes' parents.
  app.post('/api/canvases/:slug/delete', async (c) => {
    const body = (await c.req.json().catch(() => null)) as { ids?: unknown } | null;
    const ids = body?.ids;
    if (!Array.isArray(ids) || ids.length === 0 || !ids.every((id) => typeof id === 'string')) return c.json({ error: 'ids must be a non-empty array of node ids' }, 400);
    const result = await lock.run(async () => {
      const found = await readCanvas(dataDir, c.req.param('slug'));
      if (!found) return { error: 404 as const, message: 'canvas not found' };
      const { graph } = found;
      const unknown = (ids as string[]).filter((id) => !graph.nodes.has(id));
      if (unknown.length > 0) return { error: 404 as const, message: `unknown node ${unknown[0]}` };
      const deleted = deleteSet(graph, ids as string[]);
      for (const [a, u] of inFlight) if (deleted.has(a) || deleted.has(u)) return { error: 409 as const, message: 'a reply is still streaming' };
      const reparented = await deleteNodes(graph, deleted, dataDir);
      return { deleted: [...deleted], reparented };
    });
    if ('error' in result) return c.json({ error: result.message }, result.error);
    return c.json(result);
  });

  // Spec M11 §5/§11: the user's compress of the turns among `ids` — the LLM runs outside the lock; the write re-checks
  // that nothing it covers changed.
  app.post('/api/canvases/:slug/compress', async (c) => {
    const body = (await c.req.json().catch(() => null)) as { ids?: unknown; model?: unknown; fold?: unknown } | null;
    const ids = body?.ids;
    if (!Array.isArray(ids) || ids.length === 0 || !ids.every((x) => typeof x === 'string')) return c.json({ error: 'ids must be a non-empty array of node ids' }, 400);
    const fold = body?.fold === true;
    const spec = typeof body?.model === 'string' ? findModel(body.model) : undefined;
    if (!spec) return c.json({ error: 'unknown model' }, 400);
    if (!isAvailable(spec, keys)) return c.json({ error: `model ${spec.id} is not available (missing ${spec.provider} API key)` }, 400);
    const slugParam = c.req.param('slug');
    const cardsOf = (sections: Section[]) => sections.flatMap((s) => [...s.turns.flat(), ...s.folds.flat(2)]);
    const fingerprint = (graph: CanvasGraph, sections: Section[]) => JSON.stringify(cardsOf(sections).map((n) => [n, graph.nodes.get(n)?.body]));
    const inspect = async () => {
      const found = await readCanvas(dataDir, slugParam);
      if (!found) return { error: 404 as const, message: 'canvas not found' };
      const { graph } = found;
      const unknown = (ids as string[]).find((id) => !graph.nodes.has(id));
      if (unknown !== undefined) return { error: 404 as const, message: `unknown node ${unknown}` };
      const sections = compressionSections(graph, ids as string[], fold);
      if (sections.length === 0) return { error: 400 as const, message: `nothing to compress: no ${MIN_COMPRESS_TURNS} consecutive turns among these cards` };
      const cards = new Set(cardsOf(sections));
      for (const [a, u] of inFlight) if (cards.has(a) || cards.has(u)) return { error: 409 as const, message: 'a reply is still streaming' };
      return { graph, sections, fp: fingerprint(graph, sections) };
    };
    const before = await lock.run(inspect);
    if ('error' in before) return c.json({ error: before.message }, before.error);
    let turns;
    try {
      const { text } = await generateText({ model: modelFactory(spec), system: COMPRESS_SYSTEM, prompt: compressPrompt(before.graph, before.sections), maxOutputTokens: 32_000 });
      turns = parseCompression(text, before.sections.map((s) => s.turns.length));
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 502);
    }
    const result = await lock.run(async () => {
      const now = await inspect();
      if ('error' in now) return now;
      if (now.fp !== before.fp) return { error: 409 as const, message: 'the canvas changed meanwhile' };
      const plan = planCompression(now.graph, now.sections, turns, spec.id, idAt);
      const oldUsers = new Set(plan.removed.filter((id) => now.graph.nodes.get(id)?.role === 'user'));
      await replaceNodes(now.graph, plan, dataDir);
      // Spec M15 §3: turns already in a memory are not distilled again under their new ids.
      for (const m of now.graph.memories ?? []) {
        const covered = carryCovered(m.covered, plan.replacement, oldUsers);
        if (covered.length !== m.covered.length) await writeMemory(now.graph, { ...m, covered }, dataDir);
      }
      return { removed: plan.removed, added: plan.added.map((n) => n.id), replacement: plan.replacement };
    });
    if ('error' in result) return c.json({ error: result.message }, result.error);
    return c.json(result);
  });

  const KEEP_ALIVE_MS = 25_000;
  // Spec M5 §7: one long-lived stream per client; the watcher's debounced batches become vault-changed events.
  app.get('/api/events', (c) =>
    streamSSE(c, async (stream) => {
      const unsubscribe = watcher?.onChange((slugs) => void stream.writeSSE({ event: 'vault-changed', data: JSON.stringify({ slugs }) }).catch(() => undefined)) ?? (() => undefined);
      const keepAlive = setInterval(() => void stream.write(': keep-alive\n\n').catch(() => undefined), KEEP_ALIVE_MS);
      keepAlive.unref(); // never keeps the process (or a vitest worker) alive on its own
      await new Promise<void>((resolve) => stream.onAbort(resolve));
      clearInterval(keepAlive);
      unsubscribe();
    }),
  );

  const OFF: IndexStatus = { enabled: false, running: false, lastRun: null, pending: { embed: 0, summarize: 0, topics: 0, memories: 0 } };
  // Spec M5 §7: what `chatmind index status` (and the UI) polls; disabled when no indexer is wired.
  app.get('/api/index/status', (c) => c.json(indexer ? indexer.status() : OFF));

  app.all('/api/*', (c) => c.json({ error: 'not found' }, 404));

  if (staticDir !== undefined) {
    const root = path.resolve(staticDir);
    app.get('/*', async (c) => {
      const candidate = resolveStaticPath(root, c.req.path);
      const file = candidate !== null && (await isFile(candidate)) ? candidate : path.join(root, 'index.html');
      try {
        const body = await fs.readFile(file);
        return c.body(body, 200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
      } catch {
        return c.notFound();
      }
    });
  }

  return app;
}

/** Absolute file to serve for a request path, or null if it would leave `root`. Pure; no I/O. */
export function resolveStaticPath(root: string, reqPath: string): string | null {
  const resolvedRoot = path.resolve(root);
  let decoded: string;
  try {
    decoded = decodeURIComponent(reqPath);
  } catch {
    return null;
  }
  const candidate = path.resolve(resolvedRoot, `.${decoded}`);
  return candidate === resolvedRoot || candidate.startsWith(resolvedRoot + path.sep) ? candidate : null;
}

async function isFile(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isFile();
  } catch {
    return false;
  }
}
