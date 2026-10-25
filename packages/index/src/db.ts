import { mkdirSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';

export interface NodeRow {
  id: string;
  canvas: string;
  content_hash: string;
  summary_written: string | null;
  summary_for_hash: string | null;
  embedded_hash: string | null;
  /** Spec M6 §6: the topic we wrote, or null when the frontmatter topic is the user's (or none yet). */
  topic_written: string | null;
}

export const SCHEMA_VERSION = 2;

const TABLES = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS nodes (
  id TEXT PRIMARY KEY,
  canvas TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  summary_written TEXT,
  summary_for_hash TEXT,
  embedded_hash TEXT,
  topic_written TEXT
);`;

/**
 * Spec M5 §4. One connection, WAL, fully disposable. `open` migrates: v1→v2 (spec M6 §6) adds
 * `topic_written` in place; any other schema version mismatch drops everything; an embed model/dim
 * mismatch drops only `vec_nodes` and clears `embedded_hash`.
 */
export class IndexDb {
  private constructor(readonly db: Database.Database) {}

  /** Only the "not there yet" errors are expected: no table before the first migration, no vec0 module on a readonly handle. */
  private static isMissing(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return /no such (table|module)/.test(msg);
  }

  static open(file: string, embed: { model: string; dim: number }): IndexDb {
    if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true }); // sync throughout, like better-sqlite3
    const raw = new Database(file);
    raw.pragma('journal_mode = WAL');
    raw.pragma('synchronous = NORMAL'); // F3: disposable db (spec §4) — WAL + NORMAL is durable enough, and skips an fsync per commit
    sqliteVec.load(raw);
    const db = new IndexDb(raw);
    const version = db.meta('schema_version');
    if (version === '1') {
      // Spec M6 §6: additive — a drop would re-embed the whole vault for one new column.
      raw.exec('ALTER TABLE nodes ADD COLUMN topic_written TEXT');
    } else if (version !== String(SCHEMA_VERSION)) {
      raw.exec('DROP TABLE IF EXISTS vec_nodes; DROP TABLE IF EXISTS nodes; DROP TABLE IF EXISTS meta;');
    }
    raw.exec(TABLES);
    db.setMeta('schema_version', String(SCHEMA_VERSION));
    if (db.meta('embed_model') !== embed.model || db.meta('embed_dim') !== String(embed.dim)) {
      raw.exec('DROP TABLE IF EXISTS vec_nodes; UPDATE nodes SET embedded_hash = NULL;');
      db.setMeta('embed_model', embed.model);
      db.setMeta('embed_dim', String(embed.dim));
    }
    raw.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS vec_nodes USING vec0(id TEXT PRIMARY KEY, embedding float[${embed.dim}])`);
    return db;
  }

  /** For the CLI: rows and meta only, no writes. `vec: true` loads sqlite-vec so `vector()`/`allVectors()` work (dry run, spec M6 §6). */
  static openReadonly(file: string, opts: { vec?: boolean } = {}): IndexDb {
    const raw = new Database(file, { readonly: true, fileMustExist: true });
    if (opts.vec) sqliteVec.load(raw);
    return new IndexDb(raw);
  }

  meta(key: string): string | null {
    try {
      const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
      return row?.value ?? null;
    } catch (err) {
      if (IndexDb.isMissing(err)) return null; // table does not exist yet
      throw err;
    }
  }

  private setMeta(key: string, value: string): void {
    this.db.prepare('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  rows(): Map<string, NodeRow> {
    const out = new Map<string, NodeRow>();
    for (const r of this.db.prepare('SELECT * FROM nodes').all() as NodeRow[]) out.set(r.id, r);
    return out;
  }

  upsertNode(id: string, canvas: string, contentHash: string): void {
    this.db
      .prepare('INSERT INTO nodes(id, canvas, content_hash) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET canvas = excluded.canvas, content_hash = excluded.content_hash')
      .run(id, canvas, contentHash);
  }

  /** F3: runs `fn` inside one write transaction (rolled back if it throws) instead of an implicit commit per statement. */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  deleteNodes(ids: readonly string[]): void {
    const delNode = this.db.prepare('DELETE FROM nodes WHERE id = ?');
    const delVec = this.db.prepare('DELETE FROM vec_nodes WHERE id = ?');
    this.db.transaction(() => {
      for (const id of ids) {
        delVec.run(id);
        delNode.run(id);
      }
    })();
  }

  private dim(): number {
    return Number(this.meta('embed_dim'));
  }

  /** Vector + hash in one transaction; `null` marks an empty body as done without a vector. */
  setEmbedded(id: string, hash: string, vec: Float32Array | null): void {
    if (vec !== null && vec.length !== this.dim()) throw new Error(`vector for ${id} has dim ${vec.length}, expected ${this.dim()}`);
    const delVec = this.db.prepare('DELETE FROM vec_nodes WHERE id = ?');
    const insVec = this.db.prepare('INSERT INTO vec_nodes(id, embedding) VALUES (?, ?)');
    const upd = this.db.prepare('UPDATE nodes SET embedded_hash = ? WHERE id = ?');
    this.db.transaction(() => {
      delVec.run(id);
      if (vec !== null) insVec.run(id, Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength));
      upd.run(hash, id);
    })();
  }

  setSummary(id: string, written: string, forHash: string): void {
    this.db.prepare('UPDATE nodes SET summary_written = ?, summary_for_hash = ? WHERE id = ?').run(written, forHash, id);
  }

  vector(id: string): Float32Array | null {
    try {
      const row = this.db.prepare('SELECT embedding FROM vec_nodes WHERE id = ?').get(id) as { embedding: Buffer } | undefined;
      if (!row) return null;
      const b = row.embedding;
      return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
    } catch (err) {
      if (IndexDb.isMissing(err)) return null; // readonly handle without the extension, or table missing
      throw err;
    }
  }

  /** Spec M6 §6: every stored vector, loaded once per run for centring and centroids. */
  allVectors(): Map<string, Float32Array> {
    const out = new Map<string, Float32Array>();
    try {
      for (const row of this.db.prepare('SELECT id, embedding FROM vec_nodes').all() as { id: string; embedding: Buffer }[]) {
        const b = row.embedding;
        out.set(row.id, new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)));
      }
    } catch (err) {
      if (!IndexDb.isMissing(err)) throw err;
    }
    return out;
  }

  /** Spec M7 §5: SQLite's `data_version` — changes on this handle whenever another connection has committed. */
  dataVersion(): number {
    return this.db.pragma('data_version', { simple: true }) as number;
  }

  setTopic(id: string, name: string): void {
    this.db.prepare('UPDATE nodes SET topic_written = ? WHERE id = ?').run(name, id);
  }

  close(): void {
    this.db.close();
  }
}
