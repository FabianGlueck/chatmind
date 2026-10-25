import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { CSSProperties } from 'react';
import { formatTokens, replaceAttachments } from '@chatmind/core/graph';
import { CONTEXT_BADGE, roleText, type MessageFlowNode } from './flow';

/** Cards show the summary only (≤ 250 chars); until one exists, the start of the body as plain text. */
const FALLBACK_MAX = 250;
const MAX_THUMBS = 3;
function fallbackText(body: string): string {
  const flat = replaceAttachments(body, () => '').replace(/\s+/g, ' ').trim();
  return flat.length > FALLBACK_MAX ? `${flat.slice(0, FALLBACK_MAX)}…` : flat;
}

/** A card is a fixed 400×200, so a longer summary gets a smaller type size instead of being cut off (summaries run to 250 chars). */
export function summarySize(summary: string): 'lg' | 'md' | 'sm' {
  return summary.length <= 100 ? 'lg' : summary.length <= 150 ? 'md' : 'sm';
}

export function MessageNode({ data, selected }: NodeProps<MessageFlowNode>) {
  const waiting = data.streaming === true && data.body === '';
  const cls = `message-node role-${data.role}${data.cursor ? ' selected' : ''}${selected ? ' move-selected' : ''}${data.deleting ? ' deleting' : ''}${data.compress ? ` compress-${data.compress}` : ''}${data.streaming ? ' streaming' : ''}${data.error ? ' error' : ''}${data.inContext ? ' in-context' : ''}${data.excluded ? ' excluded' : ''}${data.topic !== undefined ? ' has-topic' : ''}${data.dimmed ? ' dimmed' : ''}${data.outside ? ' outside-context' : ''}`;
  const style = data.topic !== undefined ? ({ ['--topic' as string]: `var(--topic-${data.topicIndex ?? 0})` } as CSSProperties) : undefined;
  return (
    <div className={cls} style={style}>
      <Handle type="target" position={Position.Top} />
      {data.targetIndex !== undefined && <span className="target-badge" aria-label={`target ${data.targetIndex}`}>{data.targetIndex}</span>}
      <header>
        {data.topic !== undefined && <span className="topic-label" title={data.topic}><i className="dot" aria-hidden="true" />{data.topic}</span>}
        <span className="role">{roleText(data)}</span>
        {data.inContext && data.targetIndex === undefined && (
          // Clicking bubbles to GraphView's onNodeClick, which recognises `.context-badge` and toggles exclusion.
          <button type="button" className={`context-badge${data.excluded ? ' excluded' : ''}`}>{CONTEXT_BADGE[data.language ?? 'en']}</button>
        )}
        {data.images && <span className="image-count" title={`${data.images.length} image${data.images.length === 1 ? '' : 's'}`}>🖼 {data.images.length}</span>}
        <time dateTime={data.created}>{data.created.slice(0, 10)}</time>
      </header>
      {waiting ? (
        <p className="summary">Answering…</p>
      ) : data.summary !== '' ? (
        <p className={`summary size-${summarySize(data.summary)}`}>{data.summary}</p>
      ) : data.images && fallbackText(data.body) === '' ? (
        // Spec M13: a card of images only shows them until the indexer has written a summary.
        <div className="thumbs">{data.images.slice(0, MAX_THUMBS).map((src, i) => <img key={i} src={src} alt="" loading="lazy" />)}</div>
      ) : (
        <p className="summary fallback">{fallbackText(data.body) || '(empty)'}</p>
      )}
      {data.error && <p className="node-error">{data.error}</p>}
      {data.tokens !== undefined && <span className="token-chip" title="What this card adds to the prompt">≈ {formatTokens(data.tokens)} tok</span>}
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}
