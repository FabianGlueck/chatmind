import type { MemoryDto } from '@chatmind/core';
import { useState, type CSSProperties } from 'react';
import { saveMemory } from './api';
import { MessageBody } from './MessageBody';

interface Props {
  slug: string;
  topic: string;
  memory: MemoryDto | undefined;
  onSaved: (m: MemoryDto) => void;
  style?: CSSProperties;
}

/**
 * Spec M15 §5: a topic's memory in the right sidebar — Markdown to read, a textarea to edit. Saving sends the body
 * the edit started from; if the file changed meanwhile the server refuses and the current version is shown.
 */
export function MemoryEditor({ slug, topic, memory, onSaved, style }: Props) {
  const body = memory?.body ?? '';
  const [draft, setDraft] = useState<{ base: string; text: string } | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const save = async (): Promise<void> => {
    if (!draft) return;
    setSaving(true);
    setError(null);
    try {
      const res = await saveMemory(slug, topic, draft.text, draft.base);
      if (res.ok) { onSaved(res.memory); setDraft(null); setConflict(null); }
      else { setConflict(res.current); setDraft({ base: res.current, text: draft.text }); }
    } catch (e) {
      setError(`Could not save: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSaving(false);
    }
  };
  const cancel = (): void => { setDraft(null); setConflict(null); setError(null); };

  return (
    <section className="memory" aria-label={`Memory of ${topic}`} style={style}>
      <header>
        <h3>Memory · <span className="memory-topic">{topic}</span></h3>
        {!draft && <button type="button" className="btn" onClick={(e) => { e.currentTarget.blur(); setDraft({ base: body, text: body }); }}>Edit</button>}
      </header>
      {draft ? (
        <>
          {conflict !== null && (
            <div className="composer-error" role="alert">
              The memory changed meanwhile (the indexer may have added to it). Current version:
              <pre>{conflict || '(empty)'}</pre>
              Your text is kept below — save again to replace it.
            </div>
          )}
          {error && <p className="composer-error" role="alert">{error}</p>}
          <textarea aria-label="Memory text" value={draft.text} rows={10} autoFocus onChange={(e) => setDraft({ ...draft, text: e.target.value })} onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); cancel(); } }} />
          <div className="memory-actions">
            <button type="button" className="confirm" disabled={saving} onClick={() => void save()}>Save</button>
            <button type="button" className="btn" onClick={cancel}>Cancel</button>
          </div>
        </>
      ) : body !== '' ? (
        <div className="body"><MessageBody text={body} slug={slug} /></div>
      ) : (
        <p className="hint">No memory yet — it fills as this topic grows, or write one.</p>
      )}
      {!draft && memory && memory.covered > 0 && <p className="hint">{memory.covered} turn{memory.covered === 1 ? '' : 's'} distilled</p>}
    </section>
  );
}
