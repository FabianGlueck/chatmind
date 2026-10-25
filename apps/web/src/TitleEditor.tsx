import type { NodeDto } from '@chatmind/core';
import { MAX_SUMMARY_CHARS, cleanSummaryInput } from '@chatmind/core/graph';
import { useRef, useState } from 'react';

export type SummarySave = { ok: true; node: NodeDto } | { ok: false; current: string };

interface Props {
  node: NodeDto;
  onSave: (summary: string, base: string) => Promise<SummarySave>;
  onClose: () => void;
}

/**
 * Spec M17 §6: the card's title (its summary) as a one-line input in the panel heading. Enter or leaving the field
 * saves, Esc cancels; empty hands the summary back to the indexer. A summary changed meanwhile (the indexer, Obsidian)
 * is shown and becomes the new base, the typed text stays.
 */
export function TitleEditor({ node, onSave, onClose }: Props) {
  const [text, setText] = useState(node.summary);
  const [base, setBase] = useState(node.summary);
  const [message, setMessage] = useState<string | null>(null);
  const busy = useRef(false);

  const save = async (): Promise<void> => {
    if (busy.current) return;
    const next = cleanSummaryInput(text);
    if (next === base) { onClose(); return; }
    if (next.length > MAX_SUMMARY_CHARS) { setMessage(`A title holds at most ${MAX_SUMMARY_CHARS} characters.`); return; }
    busy.current = true;
    try {
      const res = await onSave(next, base);
      if (res.ok) { onClose(); return; }
      setBase(res.current);
      setMessage(`The title changed meanwhile to “${res.current || '(none)'}” — save again to replace it.`);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      busy.current = false;
    }
  };

  return (
    <div className="title-editor">
      <input
        aria-label="Card title"
        autoFocus
        value={text}
        maxLength={MAX_SUMMARY_CHARS * 2}
        placeholder="Empty — the index writes a summary"
        onChange={(e) => setText(e.target.value)}
        onFocus={(e) => e.currentTarget.select()}
        onBlur={() => void save()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); void save(); }
          else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); busy.current = true; onClose(); }
        }}
      />
      <p className={message ? 'hint error' : 'hint'} role={message ? 'alert' : undefined}>
        {message ?? `⏎ save · Esc cancel · empty lets the index write one · ${cleanSummaryInput(text).length}/${MAX_SUMMARY_CHARS}`}
      </p>
    </div>
  );
}
