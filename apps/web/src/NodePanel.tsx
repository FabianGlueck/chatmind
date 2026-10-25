import type { LinkDto, LinksDto, NodeDto } from '@chatmind/core';
import { useState, type CSSProperties, type ReactNode } from 'react';
import { displayDate, nodeTitle, roleText } from './flow';
import { MessageBody } from './MessageBody';
import { TitleEditor, type SummarySave } from './TitleEditor';

const EMPTY: Record<NonNullable<LinksDto['reason']> | 'none', string> = {
  none: 'No related answers.',
  'no-vector': 'Not embedded yet.',
  'no-index': 'Index not available.',
  'no-answer': '',
};

interface Props {
  node: NodeDto | null;
  streaming?: boolean;
  streamError?: string | null;
  palette?: ReadonlyMap<string, number>;
  /** Spec M7 §6: the cursor's semantic links; `null` while loading or without an index answer. */
  related?: LinksDto | null;
  canvasSlug?: string | null;
  onRelated?: (link: LinkDto) => void;
  /** Spec M8 §5.4: asks to delete this node's turn (App confirms). */
  onDelete?: (id: string) => void;
  /** Spec M11 §6/§9: whether something at or below this node can be compressed, and the request to open the dialog. */
  canCompress?: boolean;
  onCompress?: () => void;
  /** Spec M9 §4.4: in chat view the transcript shows the body; the panel keeps title, meta, topics and Related. */
  hideBody?: boolean;
  /** Spec M15 §5: the topic memory (App builds the editor) — under the body, or alone without a node. */
  memory?: ReactNode;
  /** Spec M17 §2: asks to edit this card's body by hand (App opens the editor where the body is shown). */
  onEdit?: (id: string) => void;
  /** Spec M17 §2: the open editor (App builds it), shown in place of the body. */
  editor?: ReactNode;
  /** Spec M17 §6: saves the card's title (its summary); without it the title is not editable. */
  onSaveTitle?: (id: string, summary: string, base: string) => Promise<SummarySave>;
}


const SHORTCUTS: [string[], string][] = [
  [['↑', '↓', '←', '→'], 'move between cards'],
  [['Enter'], 'write a reply'],
  [['E'], 'tell the model what to change'],
  [['Space'], 'add to merge / exclude'],
  [['⇧', 'click'], 'merge target'],
  [['⌘', 'click'], 'select to move'],
  [['⌘', 'V'], 'paste as a note'],
  [['V'], 'canvas ⇄ chat'],
  [['Del'], 'delete turn'],
  [['Esc'], 'clear selection'],
];

export function NodePanel({ node, streaming, streamError, palette, related, canvasSlug, onRelated, onDelete, canCompress = false, onCompress, hideBody, memory, onEdit, editor, onSaveTitle }: Props) {
  // The open title editor belongs to one card; moving the cursor closes it.
  const [titleFor, setTitleFor] = useState<string | null>(null);
  if (node === null && memory)
    return (
      <aside className="panel">
        <div className="panel-content">{memory}</div>
      </aside>
    );
  if (node === null)
    return (
      <aside className="panel empty">
        <p>Select a node to read it.</p>
        <dl className="shortcuts" aria-label="Keyboard shortcuts">
          {SHORTCUTS.map(([keys, what]) => (
            <div key={what}>
              <dt>{keys.map((k) => <kbd key={k}>{k}</kbd>)}</dt>
              <dd>{what}</dd>
            </div>
          ))}
        </dl>
      </aside>
    );
  // The first token can take seconds; without a visible status the wait looks like nothing is happening.
  const waiting = streaming === true && node.body === '';
  return (
    <aside className="panel">
      {/* Only this part scrolls; Related stays pinned below it (user, 2026-09-24). */}
      <div className="panel-content">
        <div className="panel-head">
          {titleFor === node.id && onSaveTitle ? (
            <TitleEditor node={node} onSave={(summary, base) => onSaveTitle(node.id, summary, base)} onClose={() => setTitleFor(null)} />
          ) : onSaveTitle && !streaming ? (
            <h2><button type="button" className="title-button" title="Edit title" onClick={() => setTitleFor(node.id)}>{nodeTitle(node)}</button></h2>
          ) : (
            <h2>{waiting ? 'Answering…' : nodeTitle(node)}</h2>
          )}
          {onEdit && !streaming && !editor && (
            // Blur after the click: a focused button is in App's SKIP_TAGS and would swallow the next key.
            <button type="button" className="edit-card" aria-label="Edit card" title="Edit by hand" onClick={(e) => { e.currentTarget.blur(); onEdit(node.id); }}>
              <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M10.8 2.7l2.5 2.5L5.5 13H3v-2.5z M9.3 4.2l2.5 2.5" /></svg>
            </button>
          )}
          {onCompress && !streaming && canCompress && (
            <button type="button" className="compress-strand" aria-label="Compress" title="Compress what is in context, the selected cards, or everything below" onClick={(e) => { e.currentTarget.blur(); onCompress(); }}>
              <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M8 1.5v4M5.8 3.5 8 5.7l2.2-2.2M8 14.5v-4M5.8 12.5 8 10.3l2.2 2.2M3 8h10" /></svg>
            </button>
          )}
          {onDelete && !streaming && (
            // Blur after the click: a focused button is in App's SKIP_TAGS and would swallow the next key.
            <button type="button" className="delete-turn" aria-label="Delete turn" title="Delete turn (Del)" onClick={(e) => { e.currentTarget.blur(); onDelete(node.id); }}>
              <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M2.5 4h11M6.5 4V2.5h3V4M4 4l.7 9.5h6.6L12 4M6.8 6.5v4.5M9.2 6.5v4.5" /></svg>
            </button>
          )}
        </div>
        {node.summary !== '' && node.summary !== nodeTitle(node) && <p className="summary">{node.summary}</p>}
        {streaming && (
          <p className="streaming-status" role="status">
            <span className="dots" aria-hidden="true"><i /><i /><i /></span> {node.model ?? 'model'} is answering
          </p>
        )}
        <div className="meta">
          <span className={`role role-${node.role}`}>{roleText(node)}</span>
          <time dateTime={node.created} title={node.created}>{displayDate(node.created)}</time>
        </div>
        {node.topics.length > 0 && (
          <p className="topics">
            {node.topics.map((t) => (
              <span key={t} className="topic" style={palette?.has(t) ? ({ ['--topic' as string]: `var(--topic-${palette.get(t)})` } as CSSProperties) : undefined}>{t}</span>
            ))}
          </p>
        )}
        {streamError && <p className="composer-error" role="alert">{streamError}</p>}
        {editor ?? (!hideBody && (
          <div className="body">
            <MessageBody text={node.body} slug={canvasSlug ?? ''} />
          </div>
        ))}
        {memory}
      </div>
      {related && related.reason !== 'no-answer' && (
        <section className="related" aria-label="Related">
          <h3>Related</h3>
          {related.links.length === 0 ? (
            <p className="hint">{EMPTY[related.reason ?? 'none']}</p>
          ) : (
            <ul>
              {related.links.map((l) => (
                <li key={l.id}>
                  {/* Blur after the click: a focused button is in App's SKIP_TAGS and would swallow the next arrow key. */}
                  <button type="button" onClick={(e) => { e.currentTarget.blur(); onRelated?.(l); }}>
                    <span className="related-summary">{l.summary}</span>
                    <span className="related-sim">{l.score.toFixed(2)}</span>
                    {l.canvas !== canvasSlug && <span className="related-canvas">{l.canvas}</span>}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </aside>
  );
}
