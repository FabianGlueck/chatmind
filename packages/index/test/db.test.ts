import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { IndexDb, SCHEMA_VERSION } from '../src/db';

const dirs: string[] = [];
async function tmpFile(): Promise<string> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'chatmind-index-'));
  dirs.push(d);
  return path.join(d, '.app', 'index.db');
}
afterAll(async () => { for (const d of dirs) await fs.rm(d, { recursive: true, force: true }); });

const EMBED = { model: 'test/embed', dim: 4 };
const vec = (n: number): Float32Array => Float32Array.from([n, n, n, n]);

describe('IndexDb', () => {
  it('creates the schema, records meta and round-trips rows and vectors', () => {
    const db = IndexDb.open(':memory:', EMBED);
    expect(db.meta('schema_version')).toBe(String(SCHEMA_VERSION));
    expect(db.meta('embed_model')).toBe('test/embed');
    expect(db.meta('embed_dim')).toBe('4');
    db.upsertNode('A', 'masterarbeit', 'h1');
    expect(db.rows().get('A')).toEqual({ id: 'A', canvas: 'masterarbeit', content_hash: 'h1', summary_written: null, summary_for_hash: null, embedded_hash: null, topic_written: null });
    db.setEmbedded('A', 'h1', vec(1));
    expect(Array.from(db.vector('A')!)).toEqual([1, 1, 1, 1]);
    expect(db.rows().get('A')!.embedded_hash).toBe('h1');
    db.setSummary('A', 'Titel', 'h1');
    expect(db.rows().get('A')).toMatchObject({ summary_written: 'Titel', summary_for_hash: 'h1' });
    db.upsertNode('A', 'masterarbeit', 'h2'); // body changed: hash moves, the rest stays
    expect(db.rows().get('A')).toMatchObject({ content_hash: 'h2', summary_written: 'Titel', embedded_hash: 'h1' });
    db.close();
  });

  it('setEmbedded with null stores no vector but marks the hash (empty body)', () => {
    const db = IndexDb.open(':memory:', EMBED);
    db.upsertNode('A', 'c', 'h');
    db.setEmbedded('A', 'h', null);
    expect(db.vector('A')).toBeNull();
    expect(db.rows().get('A')!.embedded_hash).toBe('h');
  });

  it('deleteNodes removes rows and vectors', () => {
    const db = IndexDb.open(':memory:', EMBED);
    db.upsertNode('A', 'c', 'h');
    db.setEmbedded('A', 'h', vec(1));
    db.deleteNodes(['A', 'missing']);
    expect(db.rows().size).toBe(0);
    expect(db.vector('A')).toBeNull();
  });

  it('rejects a vector of the wrong dimension', () => {
    const db = IndexDb.open(':memory:', EMBED);
    db.upsertNode('A', 'c', 'h');
    expect(() => db.setEmbedded('A', 'h', Float32Array.from([1, 2]))).toThrow('dim');
  });

  it('persists to disk, creating .app/, and reopens; an embed model change drops the vectors only', async () => {
    const file = await tmpFile();
    let db = IndexDb.open(file, EMBED);
    db.upsertNode('A', 'c', 'h');
    db.setEmbedded('A', 'h', vec(1));
    db.setSummary('A', 'Titel', 'h');
    db.close();
    db = IndexDb.open(file, EMBED);
    expect(Array.from(db.vector('A')!)).toEqual([1, 1, 1, 1]);
    db.close();
    db = IndexDb.open(file, { model: 'test/other', dim: 3 });
    expect(db.meta('embed_model')).toBe('test/other');
    expect(db.vector('A')).toBeNull();
    expect(db.rows().get('A')).toMatchObject({ embedded_hash: null, summary_written: 'Titel', summary_for_hash: 'h' });
    db.setEmbedded('A', 'h', Float32Array.from([1, 2, 3]));
    db.close();
    const ro = IndexDb.openReadonly(file);
    expect(ro.rows().get('A')!.embedded_hash).toBe('h');
    expect(ro.meta('embed_dim')).toBe('3');
    expect(ro.vector('A')).toBeNull(); // no vec0 module on a readonly handle: "missing", not an error
    ro.close();
  });

  it('F3: transaction rolls back when fn throws', () => {
    const db = IndexDb.open(':memory:', EMBED);
    expect(() => db.transaction(() => {
      db.upsertNode('A', 'c', 'h');
      throw new Error('boom');
    })).toThrow('boom');
    expect(db.rows().has('A')).toBe(false);
    db.close();
  });

  it('a real error propagates instead of being read as "missing"', () => {
    const db = IndexDb.open(':memory:', EMBED);
    db.close();
    expect(() => db.meta('schema_version')).toThrow('The database connection is not open');
  });

  it('a schema version mismatch rebuilds from scratch', async () => {
    const file = await tmpFile();
    let db = IndexDb.open(file, EMBED);
    db.upsertNode('A', 'c', 'h');
    db.db.prepare(`UPDATE meta SET value = '0' WHERE key = 'schema_version'`).run();
    db.close();
    db = IndexDb.open(file, EMBED);
    expect(db.rows().size).toBe(0);
    expect(db.meta('schema_version')).toBe(String(SCHEMA_VERSION));
    db.close();
  });

  it('setTopic records the topic we wrote; allVectors returns every stored vector', () => {
    const db = IndexDb.open(':memory:', EMBED);
    db.upsertNode('A', 'c', 'h');
    db.upsertNode('B', 'c', 'h');
    db.setEmbedded('A', 'h', vec(1));
    db.setEmbedded('B', 'h', vec(2));
    db.setTopic('A', 'Zentroide');
    expect(db.rows().get('A')!.topic_written).toBe('Zentroide');
    const all = db.allVectors();
    expect([...all.keys()].sort()).toEqual(['A', 'B']);
    expect(Array.from(all.get('B')!)).toEqual([2, 2, 2, 2]);
    db.close();
  });

  it('migrates schema 1 → 2 in place: vectors and hashes survive, topic_written is added', async () => {
    const file = await tmpFile();
    const v2 = IndexDb.open(file, EMBED);
    v2.upsertNode('A', 'c', 'h');
    v2.setEmbedded('A', 'h', vec(3));
    v2.setSummary('A', 'T', 'h');
    // Turn the file back into what M5 wrote: no topic column, version 1.
    v2.db.exec("ALTER TABLE nodes DROP COLUMN topic_written; UPDATE meta SET value = '1' WHERE key = 'schema_version'");
    v2.close();
    const db = IndexDb.open(file, EMBED);
    expect(db.meta('schema_version')).toBe('2');
    expect(db.rows().get('A')).toEqual({ id: 'A', canvas: 'c', content_hash: 'h', summary_written: 'T', summary_for_hash: 'h', embedded_hash: 'h', topic_written: null });
    expect(Array.from(db.vector('A')!)).toEqual([3, 3, 3, 3]);
    db.close();
  });

  it('an unknown schema version still drops everything', async () => {
    const file = await tmpFile();
    const db1 = IndexDb.open(file, EMBED);
    db1.upsertNode('A', 'c', 'h');
    db1.db.exec("UPDATE meta SET value = '99' WHERE key = 'schema_version'");
    db1.close();
    const db2 = IndexDb.open(file, EMBED);
    expect(db2.rows().size).toBe(0);
    expect(db2.meta('schema_version')).toBe('2');
    db2.close();
  });

  it('openReadonly with vec loads the extension so vectors are readable', async () => {
    const file = await tmpFile();
    const w = IndexDb.open(file, EMBED);
    w.upsertNode('A', 'c', 'h');
    w.setEmbedded('A', 'h', vec(4));
    w.close();
    const ro = IndexDb.openReadonly(file, { vec: true });
    expect(Array.from(ro.vector('A')!)).toEqual([4, 4, 4, 4]);
    expect(ro.allVectors().size).toBe(1);
    ro.close();
    const plain = IndexDb.openReadonly(file);
    expect(plain.vector('A')).toBeNull(); // no extension: "no such module" is swallowed as before
    plain.close();
  });
});

describe('IndexDb.dataVersion (spec M7 §5)', () => {
  it('changes on a read-only handle after another connection commits', async () => {
    const file = await tmpFile();
    const w = IndexDb.open(file, EMBED);
    const r = IndexDb.openReadonly(file, { vec: true });
    const before = r.dataVersion();
    expect(r.dataVersion()).toBe(before); // no write, no change
    w.upsertNode('A', 'c', 'h');
    expect(r.dataVersion()).not.toBe(before);
    r.close();
    w.close();
  });
});
