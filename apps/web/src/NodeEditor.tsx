import type { NodeDto } from '@chatmind/core';
import { MAX_BODY_CHARS } from '@chatmind/core/graph';
import { useState } from 'react';
import { saveNode } from './api';

interface Props {
  slug: string;
  id: string;
  /** The body the edit started from — sent as `base`, so a change in the file meanwhile is caught (spec M17 §2). */
  base: string;
  /** The text the textarea opens with: the body, or a model rewrite taken over by hand (spec M17 §3.2). */
  initial: string;
  onSaved: (n: NodeDto) => void;
  onCancel: () => void;
}

/**
 * Spec M17 §2 (generalised from the M16 note editor): any card's body as a Markdown textarea. Saving sends the body
 * the edit started from; if the file changed meanwhile (an Obsidian edit) the server refuses and the current version
 * is shown, the typed text kept — saving again replaces that version.
 */
export function NodeEditor({ slug, id, base: startBase, initial, onSaved, onCancel }: Props) {
  const [draft, setDraft] = useState({ base: startBase, text: initial });
  const [conflict, setConflict] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const save = async (): Promise<void> => {
    if (saving) return;
    if (draft.text.trim() === '') { setError('A card cannot be empty — delete it instead.'); return; }
    if (draft.text.length > MAX_BODY_CHARS) { setError(`Too long — at most ${MAX_BODY_CHARS.toLocaleString('en')} characters.`); return; }
    setSaving(true);
    setError(null);
    try {
      const res = await saveNode(slug, id, draft.text, draft.base);
      if (res.ok) onSaved(res.node);
      else { setConflict(res.current); setDraft({ base: res.current, text: draft.text }); }
    } catch (e) {
      setError(`Could not save: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="note-editor" aria-label="Edit card" onClick={(e) => e.stopPropagation()}>
      {conflict !== null && (
        <div className="composer-error" role="alert">
          The card changed meanwhile. Current version:
          <pre>{conflict}</pre>
          Your text is kept below — save again to replace it.
        </div>
      )}
      {error && <p className="composer-error" role="alert">{error}</p>}
      <textarea
        aria-label="Card text"
        value={draft.text}
        rows={14}
        autoFocus
        onChange={(e) => setDraft({ ...draft, text: e.target.value })}
        onKeyDown={(e) => {
          if (e.key === 'Escape') { e.stopPropagation(); onCancel(); }
          else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void save(); }
        }}
      />
      <div className="memory-actions">
        <button type="button" className="confirm" disabled={saving} title="Save (⌘Enter)" onClick={() => void save()}>Save</button>
        <button type="button" className="btn" title="Cancel (Esc)" onClick={onCancel}>Cancel</button>
      </div>
    </section>
  );
}
