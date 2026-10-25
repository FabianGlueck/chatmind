import type { CanvasDto, NodeDto } from '@chatmind/core';
import { blockLabels, graphLikeFromDto, rootsOf, strandOf, type StrandItem } from '@chatmind/core/graph';
import { useLayoutEffect, useMemo, useRef, type CSSProperties, type MouseEvent, type ReactNode } from 'react';
import { CONTEXT_BADGE, displayDate, nodeTitle, roleText, type FlowMarks } from './flow';
import { MessageBody } from './MessageBody';
import type { StreamState } from './streams';

interface Props {
  canvas: CanvasDto;
  streams: ReadonlyMap<string, StreamState>;
  marks: FlowMarks;
  palette: ReadonlyMap<string, number>;
  cursorId: string | null;
  preferred: ReadonlyMap<string, string>;
  onCursor: (id: string) => void;
  onToggle: (id: string) => void;
  /** Spec M17 §2: asks to edit a message by hand; the open editor (App builds it) replaces that message's body. */
  onEdit?: (id: string) => void;
  editor?: { id: string; node: ReactNode } | null;
}

/** Pixels from the bottom that still count as "at the bottom" for stream following (spec M9 §4.2). */
const BOTTOM_SLACK = 48;
/** Room kept above a revealed message, so the view switch does not cover it. */
const REVEAL_PAD = 56;

/** Scrolls only `box` (never the page, unlike scrollIntoView): centred, or just enough to show `el`. */
function reveal(box: HTMLElement, el: HTMLElement, center: boolean): void {
  const top = el.offsetTop;
  const bottom = top + el.offsetHeight;
  if (center) box.scrollTop = top - Math.max(REVEAL_PAD, (box.clientHeight - el.offsetHeight) / 2);
  else if (top < box.scrollTop + REVEAL_PAD) box.scrollTop = top - REVEAL_PAD;
  else if (bottom > box.scrollTop + box.clientHeight - 16) box.scrollTop = bottom - box.clientHeight + 16;
}

/** Spec M9 §4: the current strand as a chat transcript. Same cursor, marks and actions as the canvas. */
export function ChatView({ canvas, streams, marks, palette, cursorId, preferred, onCursor, onToggle, onEdit, editor }: Props) {
  const graph = useMemo(() => graphLikeFromDto(canvas), [canvas]);
  const items = useMemo(() => (cursorId === null ? [] : strandOf(graph, cursorId, preferred)), [graph, cursorId, preferred]);
  const scroller = useRef<HTMLDivElement>(null);
  const rows = useRef(new Map<string, HTMLElement>());
  const atBottom = useRef(false);
  const opened = useRef(false);

  // Opening the view centres the cursor; later cursor changes scroll just enough to show it.
  useLayoutEffect(() => {
    const el = cursorId === null ? undefined : rows.current.get(cursorId);
    if (!el || !scroller.current) return;
    reveal(scroller.current, el, !opened.current);
    opened.current = true;
  }, [cursorId]);
  // A growing answer is followed only while the view already sits at the bottom.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [items, streams]);
  const onScroll = (): void => {
    const el = scroller.current;
    if (el) atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_SLACK;
  };

  const message = (n: NodeDto, extra: { siblings?: string[]; compact?: boolean } = {}) => {
    const stream = streams.get(n.id);
    const streaming = stream?.status === 'streaming';
    const target = marks.targets.indexOf(n.id);
    const inContext = marks.all.has(n.id);
    const topic = n.topics[0];
    const cls = ['chat-msg', `role-${n.role}`, n.id === cursorId && 'cursor', inContext && 'in-context', marks.excluded.has(n.id) && 'excluded', marks.deleting?.has(n.id) && 'deleting', extra.compact && 'compact'].filter(Boolean).join(' ');
    const style = topic ? ({ ['--topic' as string]: `var(--topic-${palette.get(topic) ?? 0})` } as CSSProperties) : undefined;
    const onClick = (e: MouseEvent): void => {
      if ((e.target as HTMLElement).closest('button, a, summary')) return;
      if (e.shiftKey) onToggle(n.id);
      else onCursor(n.id);
    };
    const siblings = extra.siblings ?? [];
    const at = siblings.indexOf(n.id);
    // Blur after a button click: a focused button is in App's SKIP_TAGS and would swallow the next key.
    const press = (e: MouseEvent<HTMLButtonElement>, act: () => void): void => { e.currentTarget.blur(); act(); };
    return (
      <article key={n.id} ref={(el) => { if (el) rows.current.set(n.id, el); else rows.current.delete(n.id); }} className={cls} style={style} onClick={onClick} data-id={n.id}>
        <header>
          {target >= 0 && <span className="target-badge" aria-label={`target ${target + 1}`}>{target + 1}</span>}
          {topic && <span className="topic-label"><i className="dot" aria-hidden="true" />{topic}</span>}
          <span className="role">{roleText(n)}</span>
          {inContext && target < 0 && (
            <button type="button" className={`context-badge${marks.excluded.has(n.id) ? ' excluded' : ''}`} onClick={(e) => press(e, () => onToggle(n.id))}>{CONTEXT_BADGE[marks.language]}</button>
          )}
          {siblings.length > 1 && (
            <span className="fork" role="group" aria-label="Branches">
              <button type="button" aria-label="Previous branch" disabled={at <= 0} onClick={(e) => press(e, () => onCursor(siblings[at - 1]!))}>‹</button>
              <span>{at + 1}/{siblings.length}</span>
              <button type="button" aria-label="Next branch" disabled={at >= siblings.length - 1} onClick={(e) => press(e, () => onCursor(siblings[at + 1]!))}>›</button>
            </span>
          )}
          <time dateTime={n.created} title={n.created}>{displayDate(n.created)}</time>
          {onEdit && !streaming && editor?.id !== n.id && (
            <button type="button" className="chat-edit" aria-label="Edit card" title="Edit by hand" onClick={(e) => press(e, () => onEdit(n.id))}>
              <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M10.8 2.7l2.5 2.5L5.5 13H3v-2.5z M9.3 4.2l2.5 2.5" /></svg>
            </button>
          )}
        </header>
        {editor?.id === n.id ? editor.node : streaming && n.body === '' ? (
          <p className="streaming-status" role="status"><span className="dots" aria-hidden="true"><i /><i /><i /></span> {n.model ?? 'model'} is answering</p>
        ) : (
          <div className="chat-body"><MessageBody text={n.body} slug={canvas.slug} /></div>
        )}
        {stream?.status === 'error' && <p className="composer-error" role="alert">{stream.error ?? 'error'}</p>}
      </article>
    );
  };

  const mergeBlocks = (item: StrandItem<NodeDto>) => {
    const labels = blockLabels(item.merged.map((s) => s.target), marks.language);
    return item.merged.map((seg, i) => (
      <details key={`merge-${item.node.id}-${seg.target.id}`} className="merge-block">
        <summary>Merged branch · <strong>{labels[i]}</strong> · {seg.nodes.length} message{seg.nodes.length === 1 ? '' : 's'}</summary>
        {seg.nodes.map((n) => message(n, { compact: true }))}
      </details>
    ));
  };

  if (cursorId === null || items.length === 0) {
    const roots = rootsOf(graph);
    return (
      <div className="chat-view" ref={scroller}>
        <div className="chat-column chat-empty">
          {roots.length === 0 ? (
            <p className="hint">No messages yet — write the first one below.</p>
          ) : (
            <>
              <p className="hint">Pick a thread to read, or select a card on the canvas.</p>
              <ul className="chat-roots" aria-label="Threads">
                {roots.map((r) => (
                  <li key={r.id}>
                    <button type="button" onClick={(e) => { e.currentTarget.blur(); onCursor(r.id); }}>
                      <span>{nodeTitle(r)}</span>
                      <span className="count">{strandOf(graph, r.id, preferred).length}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      </div>
    );
  }

  const cursorIndex = items.findIndex((i) => i.node.id === cursorId);
  return (
    <div className="chat-view" ref={scroller} onScroll={onScroll} aria-label="Chat">
      <div className="chat-column">
        {items.map((item, i) => (
          <div key={item.node.id} className="chat-turn">
            {mergeBlocks(item)}
            {message(item.node, { siblings: item.siblings })}
            {i === cursorIndex && i < items.length - 1 && <div className="branch-hint" role="note">Replying here starts a new branch</div>}
          </div>
        ))}
      </div>
    </div>
  );
}
