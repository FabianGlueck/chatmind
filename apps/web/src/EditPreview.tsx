import { diffWords } from 'diff';
import { useMemo, useState } from 'react';
import { MessageBody } from './MessageBody';

/** Spec M17 §3.2: a model rewrite of one card, shown before anything is written. */
export interface EditState {
  id: string;
  /** The body the edit started from — the `base` of Accept, kept across refinements. */
  base: string;
  text: string;
  status: 'streaming' | 'ready' | 'error';
  error?: string;
  /** The body the server reported on a 409 at Accept — Overwrite saves against it. */
  conflict?: string;
}

interface Props {
  edit: EditState;
  title: string;
  slug: string;
  saving: boolean;
  onAccept: () => void;
  onOverwrite: () => void;
  onDiscard: () => void;
  onHand: () => void;
}

/** Word diff of the rewrite against the body it started from (spec M17 §3.2, `diffWords`). */
function Changes({ from, to }: { from: string; to: string }) {
  const parts = useMemo(() => diffWords(from, to), [from, to]);
  return (
    <div className="edit-diff">
      {parts.map((p, i) => (p.added ? <ins key={i}>{p.value}</ins> : p.removed ? <del key={i}>{p.value}</del> : <span key={i}>{p.value}</span>))}
    </div>
  );
}

/**
 * Spec M17 §3.2: the streamed rewrite above the composer (so it works in both views and with the panel folded) —
 * rendered as Markdown, or as a word diff under "Changes". Accept writes it; Discard, Edit by hand, Overwrite on 409.
 */
export function EditPreview({ edit, title, slug, saving, onAccept, onOverwrite, onDiscard, onHand }: Props) {
  const [showChanges, setShowChanges] = useState(false);
  const streaming = edit.status === 'streaming';
  const usable = edit.status === 'ready' && edit.text.trim() !== '' && !saving;
  // Blur after a click: a focused button is in App's SKIP_TAGS and would swallow the next key.
  const press = (act: () => void) => (e: { currentTarget: HTMLButtonElement }): void => { e.currentTarget.blur(); act(); };
  return (
    <section className="edit-preview" aria-label="Rewrite preview">
      <header>
        <span className="edit-title">Rewrite of <strong>{title}</strong></span>
        {streaming && <span className="streaming-status" role="status"><span className="dots" aria-hidden="true"><i /><i /><i /></span> rewriting</span>}
        <button type="button" className={`chip${showChanges ? ' active' : ''}`} aria-pressed={showChanges} onClick={press(() => setShowChanges((v) => !v))}>Changes</button>
      </header>
      {edit.error && <p className="composer-error" role="alert">{edit.error}</p>}
      {edit.conflict !== undefined && <p className="composer-error" role="alert">The card changed meanwhile — discard, or accept to overwrite the new version</p>}
      <div className="edit-text">
        {showChanges ? <Changes from={edit.conflict ?? edit.base} to={edit.text} /> : <MessageBody text={edit.text} slug={slug} />}
      </div>
      <div className="memory-actions">
        {edit.conflict === undefined
          ? <button type="button" className="confirm" disabled={!usable} title="Accept (⌘Enter)" onClick={press(onAccept)}>Accept</button>
          : <button type="button" className="confirm" disabled={!usable} title="Save over the version in the file" onClick={press(onOverwrite)}>Overwrite</button>}
        <button type="button" className="btn" title="Discard (Esc)" onClick={press(onDiscard)}>Discard</button>
        <button type="button" className="btn" disabled={streaming || edit.text.trim() === ''} onClick={press(onHand)}>Edit by hand</button>
      </div>
    </section>
  );
}
