import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { VaultLock } from '@chatmind/core';
import { contentHash } from '../src/hash';
import { writeback, writeTopic } from '../src/writeback';
import { cleanupTmpDirs, files, nodeOnDisk, vaultWith } from './helpers';

afterAll(cleanupTmpDirs);

describe('writeback (spec M5 §6)', () => {
  it('writes the summary, renames the bare-ULID file once and updates graph.canvas', async () => {
    const { root, graph } = await vaultWith('m', [{ role: 'user', content: 'Wie evaluiere ich Topic-Zuordnung?' }]);
    const id = [...graph.nodes.keys()][0]!;
    const res = await writeback({ id, canvas: 'm', forHash: contentHash('Wie evaluiere ich Topic-Zuordnung?'), expectedSummary: '', newSummary: 'Evaluation der Topic-Zuordnung' }, { dataDir: root, lock: new VaultLock() });
    expect(res).toEqual({ written: true, renamed: true, skipped: null });
    expect(await files(root, 'm')).toEqual([`${id}-evaluation-der-topic-zuordnung.md`]);
    const { node, path: p } = await nodeOnDisk(root, 'm', id);
    expect(node.summary).toBe('Evaluation der Topic-Zuordnung');
    expect(p).toBe(`m/nodes/${id}-evaluation-der-topic-zuordnung.md`);
    const canvas = JSON.parse(await fs.readFile(path.join(root, 'm', 'graph.canvas'), 'utf8')) as { nodes: { file: string }[] };
    expect(canvas.nodes[0]!.file).toBe(p);
  });

  it('a second summary never renames again', async () => {
    const { root, graph } = await vaultWith('m', [{ role: 'user', content: 'Frage' }]);
    const id = [...graph.nodes.keys()][0]!;
    const deps = { dataDir: root, lock: new VaultLock() };
    await writeback({ id, canvas: 'm', forHash: contentHash('Frage'), expectedSummary: '', newSummary: 'Erster' }, deps);
    const res = await writeback({ id, canvas: 'm', forHash: contentHash('Frage'), expectedSummary: 'Erster', newSummary: 'Zweiter' }, deps);
    expect(res).toEqual({ written: true, renamed: false, skipped: null });
    expect(await files(root, 'm')).toEqual([`${id}-erster.md`]);
    expect((await nodeOnDisk(root, 'm', id)).node.summary).toBe('Zweiter');
  });

  it('rename-only job: summary unchanged, file renamed', async () => {
    const { root, graph } = await vaultWith('m', [{ role: 'user', content: 'Frage' }]);
    const id = [...graph.nodes.keys()][0]!;
    const file = path.join(root, 'm', 'nodes', `${id}.md`);
    await fs.writeFile(file, (await fs.readFile(file, 'utf8')).replace("summary: ''", 'summary: Von Hand'));
    const res = await writeback({ id, canvas: 'm', forHash: contentHash('Frage'), expectedSummary: 'Von Hand', newSummary: 'Von Hand' }, { dataDir: root, lock: new VaultLock() });
    expect(res).toEqual({ written: false, renamed: true, skipped: null });
    expect(await files(root, 'm')).toEqual([`${id}-von-hand.md`]);
  });

  it('skips when the body changed or the summary changed since the job was planned', async () => {
    const { root, graph } = await vaultWith('m', [{ role: 'user', content: 'Frage' }]);
    const id = [...graph.nodes.keys()][0]!;
    const deps = { dataDir: root, lock: new VaultLock() };
    expect(await writeback({ id, canvas: 'm', forHash: contentHash('andere Frage'), expectedSummary: '', newSummary: 'X' }, deps)).toEqual({ written: false, renamed: false, skipped: 'body-changed' });
    expect(await writeback({ id, canvas: 'm', forHash: contentHash('Frage'), expectedSummary: 'nicht leer', newSummary: 'X' }, deps)).toEqual({ written: false, renamed: false, skipped: 'summary-changed' });
    expect(await writeback({ id: 'nope', canvas: 'm', forHash: 'h', expectedSummary: '', newSummary: 'X' }, deps)).toEqual({ written: false, renamed: false, skipped: 'vanished' });
    expect(await files(root, 'm')).toEqual([`${id}.md`]);
  });
});

describe('writeTopic (spec M6 §6)', () => {
  it('writes topics: [name] into the frontmatter and touches nothing else', async () => {
    const { root, graph } = await vaultWith('m', [{ role: 'user', content: 'Frage' }]);
    const id = [...graph.nodes.keys()][0]!;
    const before = await files(root, 'm');
    const res = await writeTopic({ id, canvas: 'm', forHash: contentHash('Frage'), topic: 'Evaluation' }, { dataDir: root, lock: new VaultLock() });
    expect(res).toEqual({ written: true, skipped: null });
    const { node } = await nodeOnDisk(root, 'm', id);
    expect(node.topics).toEqual(['Evaluation']);
    expect(node.summary).toBe('');
    expect(await files(root, 'm')).toEqual(before); // no rename
  });
  it('drops the write when a topic appeared meanwhile, the body changed, or the node vanished', async () => {
    const { root, graph } = await vaultWith('m', [{ role: 'user', content: 'Frage' }]);
    const id = [...graph.nodes.keys()][0]!;
    const deps = { dataDir: root, lock: new VaultLock() };
    const file = path.join(root, 'm', 'nodes', `${id}.md`);
    await fs.writeFile(file, (await fs.readFile(file, 'utf8')).replace('topics: []', 'topics: [Von Hand]'));
    expect(await writeTopic({ id, canvas: 'm', forHash: contentHash('Frage'), topic: 'X' }, deps)).toEqual({ written: false, skipped: 'topics-changed' });
    expect((await nodeOnDisk(root, 'm', id)).node.topics).toEqual(['Von Hand']);
    expect(await writeTopic({ id, canvas: 'm', forHash: contentHash('anders'), topic: 'X' }, deps)).toMatchObject({ written: false, skipped: 'body-changed' });
    expect(await writeTopic({ id: '01JQ8F2H7T4WKD9M3XBQNAZZZZ', canvas: 'm', forHash: 'h', topic: 'X' }, deps)).toEqual({ written: false, skipped: 'vanished' });
    expect(await writeTopic({ id, canvas: 'nope', forHash: 'h', topic: 'X' }, deps)).toEqual({ written: false, skipped: 'vanished' });
  });
});
