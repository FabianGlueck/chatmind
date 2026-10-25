import type { LinksDto } from '@chatmind/core';
import { useEffect, useRef, useState } from 'react';
import { fetchLinks } from './api';

/** Spec M7 §6: arrow-key navigation fetches only the node the cursor settles on. */
export const LINKS_DEBOUNCE_MS = 150;

/** Spec M7 §6: the history entry's query string — canvas, plus the cursor when there is one. */
export function locationFor(slug: string, node: string | null, view: View = 'canvas'): string {
  const q = new URLSearchParams({ canvas: slug });
  if (node !== null) q.set('node', node);
  if (view === 'chat') q.set('view', 'chat'); // spec M9 §4.3: the canvas is the default and stays implicit
  return `?${q.toString()}`;
}

export function readLocation(search: string): { canvas: string | null; node: string | null; view: View } {
  const q = new URLSearchParams(search);
  return { canvas: q.get('canvas'), node: q.get('node'), view: q.get('view') === 'chat' ? 'chat' : 'canvas' };
}

/** Spec M9: the middle pane shows the canvas or the current strand as a chat. */
export type View = 'canvas' | 'chat';

/**
 * Spec M7 §6: the cursor's links. Debounced, the superseded request aborted, answers cached per canvas until
 * `version` changes (a vault event) — the old answer stays on screen until the refetch lands. A failed request
 * shows nothing, like no cursor.
 */
export function useLinks(slug: string | null, cursorId: string | null, version: number): LinksDto | null {
  const cache = useRef<{ scope: string; entries: Map<string, LinksDto> }>({ scope: '', entries: new Map() });
  const [shown, setShown] = useState<{ key: string; dto: LinksDto } | null>(null);
  const key = slug !== null && cursorId !== null ? `${slug}/${cursorId}` : null;

  useEffect(() => {
    if (slug === null || cursorId === null || key === null) return;
    const scope = `${slug}@${version}`;
    if (cache.current.scope !== scope) cache.current = { scope, entries: new Map() };
    const hit = cache.current.entries.get(key);
    if (hit) {
      setShown({ key, dto: hit });
      return;
    }
    const ctrl = new AbortController();
    const entries = cache.current.entries;
    const timer = setTimeout(() => {
      fetchLinks(slug, cursorId, ctrl.signal)
        .then((dto) => {
          entries.set(key, dto);
          if (!ctrl.signal.aborted) setShown({ key, dto });
        })
        .catch(() => undefined);
    }, LINKS_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [slug, cursorId, key, version]);

  return shown !== null && shown.key === key ? shown.dto : null;
}
