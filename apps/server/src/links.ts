import type { CanvasGraph, LinksDto, MessageNode } from '@chatmind/core';
import { IndexDb, linkSpace, mutualLinks, summaryOf, vaultLinks, type LinkSettings, type LinkSpace } from '@chatmind/index';

export interface LinkServiceOptions {
  dbFile: string;
  settings: LinkSettings;
}

/**
 * Spec M7 §5: semantic links for one node, computed per request. Its own read-only handle on `index.db`,
 * independent of the indexer (works with --no-index); the centred, normalised vectors are cached until
 * `data_version` says another connection has committed.
 */
export class LinkService {
  private db: IndexDb | null = null;
  private cache: { version: number; space: LinkSpace } | null = null;

  constructor(private readonly o: LinkServiceOptions) {}

  /** Every stored vector, centred and normalised; `null` while there is no usable index file. */
  private space(): LinkSpace | null {
    if (this.db === null) {
      try {
        this.db = IndexDb.openReadonly(this.o.dbFile, { vec: true });
      } catch {
        return null; // no index yet — retried on the next request
      }
    }
    const version = this.db.dataVersion();
    if (this.cache?.version !== version) {
      const dim = Number(this.db.meta('embed_dim'));
      if (!Number.isInteger(dim) || dim <= 0) return null;
      const all = this.db.allVectors();
      this.cache = { version, space: linkSpace(all, all.keys(), dim) };
    }
    return this.cache.space;
  }

  /** `null` when the canvas or node is unknown (→ 404). */
  links(canvases: readonly CanvasGraph[], slug: string, id: string): LinksDto | null {
    const graph = canvases.find((g) => g.slug === slug);
    const node = graph?.nodes.get(id);
    if (!graph || !node) return null;
    const all = this.space();
    if (all === null) return { from: null, links: [], reason: 'no-index' };
    let from: MessageNode | undefined = node;
    if (node.role === 'user') {
      // Spec M7 §4 (as M6): a user node stands for its oldest assistant reply with a vector.
      from = [...graph.nodes.values()]
        .filter((n) => n.role === 'assistant' && n.parents[0] === id && all.vecs.has(n.id))
        .sort((a, b) => (a.created < b.created ? -1 : a.created > b.created ? 1 : a.id < b.id ? -1 : 1))[0];
      if (!from) return { from: null, links: [], reason: 'no-answer' };
    }
    if (!all.vecs.has(from.id)) return { from: from.id, links: [], reason: 'no-vector' };

    const v = vaultLinks(canvases, all);
    const links = mutualLinks(from.id, v.space, v.excluded, this.o.settings).map((l) => {
      const g = v.owner.get(l.id)!;
      return { id: l.id, canvas: g.slug, summary: summaryOf(g.nodes.get(l.id)!), similarity: Math.round(l.sim * 100) / 100, score: Math.round(l.score * 100) / 100 };
    });
    return { from: from.id, links };
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }
}
