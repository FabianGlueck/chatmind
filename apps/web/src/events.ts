/** One refetch in flight at a time; triggers during a run set a dirty flag → exactly one more run (spec M5 §7). */
export function createRefetcher(run: () => Promise<void>): () => void {
  let running = false;
  let dirty = false;
  const loop = async (): Promise<void> => {
    running = true;
    try {
      do {
        dirty = false;
        try {
          await run();
        } catch {
          // swallow both sync and async errors
        }
      } while (dirty);
    } finally {
      running = false;
    }
  };
  return () => {
    if (running) dirty = true;
    else void loop();
  };
}

/** Opens /api/events; the browser reconnects on its own. No-op where EventSource is missing (tests). */
export function subscribeVaultEvents(onChange: (slugs: string[]) => void): () => void {
  if (typeof EventSource === 'undefined') return () => undefined;
  const es = new EventSource('/api/events');
  es.addEventListener('vault-changed', (e) => {
    try {
      const { slugs } = JSON.parse((e as MessageEvent).data as string) as { slugs: unknown };
      if (Array.isArray(slugs) && slugs.every((s) => typeof s === 'string')) onChange(slugs as string[]);
    } catch {
      // malformed event — ignore
    }
  });
  return () => es.close();
}
