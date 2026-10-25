import { readVault, toNodeDto, writeCanvasFile, writeNode, type Layout, type MessageNode, type NodeDto, type VaultLock } from '@chatmind/core';
import { streamText, type LanguageModel, type ModelMessage } from 'ai';

export type CompletionEvent =
  | { type: 'delta'; text: string }
  | { type: 'done'; node: NodeDto }
  | { type: 'error'; message: string; partial: boolean };

export interface CompletionJob {
  assistantId: string;
  /**
   * Replays past events, then delivers live ones. Returns an unsubscribe function — a no-op once the job has
   * already reached a terminal event (`done`/`error`) by the time of the call, since there is nothing left to
   * deliver live and nothing was added to unsubscribe from.
   */
  subscribe(listener: (e: CompletionEvent) => void): () => void;
  finished: Promise<void>;
}

export interface CompletionOptions {
  dataDir: string;
  slug: string;
  assistant: MessageNode; // body '' — filled from the stream
  layout: Layout;
  model: LanguageModel;
  system: string;
  messages: ModelMessage[]; // user messages may carry image parts (spec M13)
  lock: VaultLock;
}

/**
 * Drives one model completion independently of any HTTP connection: buffers deltas, writes the node once at the
 * end (also on error after ≥1 delta), and publishes events to subscribers with replay.
 */
const isTerminal = (e: CompletionEvent): boolean => e.type !== 'delta';

export function startCompletion(o: CompletionOptions): CompletionJob {
  const history: CompletionEvent[] = [];
  const listeners = new Set<(e: CompletionEvent) => void>();
  /** Never let a throwing subscriber look like a provider error or become an unhandled rejection. */
  const notify = (listener: (e: CompletionEvent) => void, e: CompletionEvent): void => {
    try {
      listener(e);
    } catch {
      // swallow — a subscriber's bug is not this job's problem
    }
  };
  const emit = (e: CompletionEvent): void => {
    history.push(e);
    for (const l of listeners) notify(l, e);
  };
  let buffer = '';
  let written = false; // true once the node has actually landed on disk at least once
  let attemptedPersist = false; // true once the happy path has already tried persist() — its failure is not retried

  const persist = (): Promise<NodeDto> =>
    o.lock.run(async () => {
      const { canvases } = await readVault(o.dataDir);
      const graph = canvases.find((g) => g.slug === o.slug);
      if (!graph) throw new Error(`canvas ${o.slug} disappeared`);
      const node: MessageNode = { ...o.assistant, body: buffer };
      graph.nodes.set(node.id, node);
      graph.layout.set(node.id, o.layout);
      await writeNode(graph, node.id, o.dataDir);
      await writeCanvasFile(graph, o.dataDir);
      written = true;
      return toNodeDto(node, o.layout);
    });

  const finished = (async () => {
    try {
      // errors are surfaced through the `error` fullStream part below; onError only exists to stop the AI SDK's
      // own default console logging from double-reporting the same failure.
      const result = streamText({ model: o.model, system: o.system, messages: o.messages, onError: () => undefined });
      for await (const part of result.fullStream) {
        if (part.type === 'text-delta') {
          buffer += part.text;
          emit({ type: 'delta', text: part.text });
        } else if (part.type === 'error') {
          throw part.error instanceof Error ? part.error : new Error(String(part.error));
        }
      }
      if (buffer === '') {
        emit({ type: 'error', message: 'the model returned no text', partial: false });
      } else {
        attemptedPersist = true;
        emit({ type: 'done', node: await persist() });
      }
    } catch (err) {
      let message = err instanceof Error ? err.message : String(err);
      if (buffer.length > 0 && !attemptedPersist) {
        try {
          await persist();
        } catch (writeErr) {
          message += `; and writing the partial node failed: ${String(writeErr)}`;
        }
      }
      emit({ type: 'error', message, partial: written });
    }
  })();

  return {
    assistantId: o.assistant.id,
    subscribe(listener) {
      for (const e of history) notify(listener, e);
      const last = history[history.length - 1];
      if (last !== undefined && isTerminal(last)) return () => undefined; // already finished — nothing to subscribe to
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    finished,
  };
}
