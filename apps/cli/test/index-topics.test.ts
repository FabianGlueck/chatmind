import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { VaultLock, linearGraph, writeCanvas } from '@chatmind/core';
import { IndexDb, reconcile } from '@chatmind/index';
import { indexTopicsDryRun } from '../src/index-topics';

const dirs: string[] = [];
afterAll(async () => { for (const d of dirs) await fs.rm(d, { recursive: true, force: true }); });

function capture(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.join(' ')); });
  return { lines, restore: () => spy.mockRestore() };
}

// One-hot by first letter, like the index package's topicEmbedder.
// One-hot by first letter, plus a tiny length component so two texts on the same axis are *almost* — not exactly —
// parallel. Exact 1.0 similarities would make every threshold below 1 indistinguishable.
const embedder = { model: 'fake/e', dim: 4, embed: async (t: string[]) => t.map((s) => { const v = new Float32Array(4); const i = 'ABC'.indexOf(s[0] ?? ''); if (i >= 0) v[i] = 1; else v.fill(1); v[3] = s.length / 1000; return v; }) };

describe('chatmind index topics --dry-run (spec M6 §6)', () => {
  it('prints similarities and decisions without writing or naming', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chatmind-cli-'));
    dirs.push(root);
    await writeCanvas(linearGraph('m', [{ role: 'user', content: 'Alpha eins\nzwei' }, { role: 'assistant', content: 'Alpha zwei\ndrei', model: 'x' }, { role: 'user', content: 'Beta drei\nvier' }]), root);
    const db = IndexDb.open(path.join(root, '.app', 'index.db'), embedder);
    const far = () => Date.now() + 200_000;
    // Index with a namer that fails: vectors and summaries land, topics do not.
    await reconcile({ dataDir: root, db, embedder, summarizer: async ({ body }) => `T ${body.slice(0, 10)}`, namer: async () => { throw new Error('off'); }, lock: new VaultLock(), now: far });
    db.close();
    // Give the first node ("Alpha eins") a topic by hand so there is a centroid.
    const nodes = path.join(root, 'm', 'nodes');
    for (const name of await fs.readdir(nodes)) {
      const f = path.join(nodes, name);
      const text = await fs.readFile(f, 'utf8');
      if (text.includes('Alpha eins')) await fs.writeFile(f, text.replace('topics: []', 'topics: [Alpha]'));
    }
    const { lines, restore } = capture();
    expect(await indexTopicsDryRun(root, far)).toBe(0);
    restore();
    const out = lines.join('\n');
    expect(out).toMatch(/canvas m: 1 topic \(Alpha\), 2 candidates, 0 deferred/);
    expect(out).toMatch(/assistant parent Alpha \| Alpha=1\.00 \| → assign Alpha/);
    // The Beta node's parent is the assistant, which the dry run does not assign — so no parent topic.
    expect(out).toMatch(/user parent - \| Alpha=0\.00 \| → would ask \[Alpha\]/);
    // nothing written
    const after = await Promise.all((await fs.readdir(nodes)).map((n) => fs.readFile(path.join(nodes, n), 'utf8')));
    expect(after.filter((t) => t.includes('topics: []'))).toHaveLength(2);
  });

  it('reads sensibly when the canvas has no topic yet (no empty parens)', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chatmind-cli-'));
    dirs.push(root);
    await writeCanvas(linearGraph('m', [{ role: 'user', content: 'Alpha eins\nzwei' }, { role: 'assistant', content: 'Alpha zwei\ndrei', model: 'x' }]), root);
    const db = IndexDb.open(path.join(root, '.app', 'index.db'), embedder);
    const far = () => Date.now() + 200_000;
    await reconcile({ dataDir: root, db, embedder, summarizer: async ({ body }) => `T ${body.slice(0, 10)}`, namer: async () => { throw new Error('off'); }, lock: new VaultLock(), now: far });
    db.close();
    const { lines, restore } = capture();
    expect(await indexTopicsDryRun(root, far)).toBe(0);
    restore();
    const out = lines.join('\n');
    expect(out).toMatch(/canvas m: 0 topics, \d+ candidates, 0 deferred/);
    expect(out).not.toContain('()');
  });

  it('uses the CHATMIND_TOPIC_* thresholds and names them in the output (spec M6 §4)', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chatmind-cli-'));
    dirs.push(root);
    // Different lengths, so the two vectors are almost but not exactly parallel (see the embedder above).
    await writeCanvas(linearGraph('m', [{ role: 'user', content: 'Alpha eins\nzwei' }, { role: 'assistant', content: 'Alpha zwei drei vier fünf sechs\nsieben', model: 'x' }]), root);
    const db = IndexDb.open(path.join(root, '.app', 'index.db'), embedder);
    const far = () => Date.now() + 200_000;
    await reconcile({ dataDir: root, db, embedder, summarizer: async ({ body }) => `T ${body.slice(0, 10)}`, namer: async () => { throw new Error('off'); }, lock: new VaultLock(), now: far });
    db.close();
    const nodes = path.join(root, 'm', 'nodes');
    for (const name of await fs.readdir(nodes)) {
      const f = path.join(nodes, name);
      const text = await fs.readFile(f, 'utf8');
      if (text.includes('Alpha eins')) await fs.writeFile(f, text.replace('topics: []', 'topics: [Alpha]'));
    }
    const { lines, restore } = capture();
    // Without the env the assistant inherits Alpha from its parent; at 1 neither rule 3 nor rule 4 can be met.
    await indexTopicsDryRun(root, far, { CHATMIND_TOPIC_INHERIT: '1', CHATMIND_TOPIC_ASSIGN: '1' });
    restore();
    const out = lines.join('\n');
    expect(out).toMatch(/thresholds: tInherit 1 \(default 0\.15\), tAssign 1 \(default 0\.35\)/);
    expect(out).toMatch(/→ would ask \[Alpha\]/);

    // Same vault, no env: the default keeps it with its parent's topic.
    const plain = capture();
    await indexTopicsDryRun(root, far, {});
    plain.restore();
    expect(plain.lines.join('\n')).toMatch(/thresholds: defaults[\s\S]*→ assign Alpha/);
  });

  it('reads the thresholds from ~/.config/chatmind/env, like the server does (spec M6 §4)', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chatmind-cli-'));
    dirs.push(root);
    await writeCanvas(linearGraph('m', [{ role: 'user', content: 'Alpha eins\nzwei' }]), root);
    const db = IndexDb.open(path.join(root, '.app', 'index.db'), embedder);
    const far = () => Date.now() + 200_000;
    await reconcile({ dataDir: root, db, embedder, summarizer: async ({ body }) => `T ${body.slice(0, 10)}`, namer: async () => { throw new Error('off'); }, lock: new VaultLock(), now: far });
    db.close();

    // A real key file in a throwaway HOME — the dry run must find it without being handed an env.
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'chatmind-home-'));
    dirs.push(home);
    await fs.mkdir(path.join(home, '.config', 'chatmind'), { recursive: true });
    await fs.writeFile(path.join(home, '.config', 'chatmind', 'env'), '# key file\nCHATMIND_TOPIC_INHERIT=0.42\n');
    const realHome = process.env.HOME;
    process.env.HOME = home;
    const { lines, restore } = capture();
    try {
      await indexTopicsDryRun(root, far);
    } finally {
      restore();
      if (realHome === undefined) delete process.env.HOME; else process.env.HOME = realHome;
    }
    expect(lines.join('\n')).toMatch(/thresholds: tInherit 0\.42 \(default 0\.15\)/);
  });

  it('says so when there is no index', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chatmind-cli-'));
    dirs.push(root);
    await writeCanvas(linearGraph('m', [{ role: 'user', content: 'x' }]), root);
    const { lines, restore } = capture();
    expect(await indexTopicsDryRun(root)).toBe(0);
    restore();
    expect(lines.join('\n')).toMatch(/no index/);
  });
});
