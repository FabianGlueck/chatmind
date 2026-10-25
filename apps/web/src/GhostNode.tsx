import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { GhostFlowNode } from './flow';

/** Preview of the merge user node that a send would create (spec M4 §6.3). */
export function GhostNode({ data }: NodeProps<GhostFlowNode>) {
  return (
    <div className="ghost-node">
      <Handle type="target" position={Position.Top} />
      {data.language === 'de' ? `Merge · ${data.count} Zweige` : `Merge · ${data.count} branches`}
    </div>
  );
}
