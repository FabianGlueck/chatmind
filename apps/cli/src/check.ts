import { readVault, resolveDataDir, type Repair } from '@chatmind/core';

function describe(r: Repair): string {
  switch (r.kind) {
    case 'unparseable-node':
      return `unparseable node   ${r.path} — ${r.reason}`;
    case 'defaulted-field':
      return `defaulted field    ${r.id} → ${r.field}`;
    case 'duplicate-id':
      return `duplicate id       ${r.id} kept ${r.kept}, ignored ${r.dropped}`;
    case 'canvas-missing':
      return `canvas missing     ${r.canvas}/graph.canvas`;
    case 'canvas-corrupt':
      return `canvas corrupt     ${r.canvas}/graph.canvas — ${r.reason}`;
    case 'path-repaired':
      return `path repaired      ${r.id}: ${r.from} → ${r.to}`;
    case 'canvas-id-repaired':
      return `canvas id repaired ${r.canvasNodeId} → ${r.id}`;
    case 'orphan-canvas-node':
      return `orphan canvas node ${r.canvas}: ${r.canvasNodeId} → ${r.file}`;
    case 'layout-missing':
      return `layout missing     ${r.id}`;
    case 'dangling-parent':
      return `dangling parent    ${r.id} → ${r.parent}`;
    case 'assistant-parents':
      return `assistant parents  ${r.id} has ${r.count} parents (expected 1)`;
    case 'edge-mismatch':
      return `edge mismatch      ${r.canvas}: ${r.detail}`;
    case 'duplicate-canvas-node':
      return `duplicate canvas  ${r.canvas}: ${r.canvasNodeId} → ${r.id} (ignored)`;
    case 'unparseable-memory':
      return `unparseable memory ${r.path} — ${r.reason}`;
    case 'duplicate-memory':
      return `duplicate memory   ${r.path}: "${r.topic}" already in ${r.kept} (ignored)`;
  }
}

export async function check(dataDir?: string): Promise<number> {
  const root = resolveDataDir(dataDir);
  const { canvases, repairs } = await readVault(root);
  console.log(`data dir: ${root}`);
  for (const c of canvases) console.log(`canvas ${c.slug}: ${c.nodes.size} nodes, ${c.foreign.nodes.length} foreign canvas nodes`);
  if (repairs.length === 0) {
    console.log('no repairs needed');
    return 0;
  }
  console.log(`${repairs.length} repair(s) — applied in memory, written on next save:`);
  for (const r of repairs) console.log(`  ${describe(r)}`);
  return 3;
}
