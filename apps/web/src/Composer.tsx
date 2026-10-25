import type { MemoryDto, ModelDto, NodeDto } from '@chatmind/core';
import { formatTokens, IMAGE_TOKENS, MAX_IMAGES, type Language } from '@chatmind/core/graph';
import { useState, type ClipboardEvent, type DragEvent, type FormEvent, type KeyboardEvent, type ReactElement, type RefObject } from 'react';
import { nodeTitle } from './flow';
import { isSupportedImage, prepareImage, type PendingImage } from './images';

export interface ComposerProps {
  targets: NodeDto[];
  language: Language;
  /** Tokens of the full prompt for the given instruction text (spec M4 §6.4) — App binds graph, targets and exclusions. */
  promptTokens: (text: string) => number;
  budget: number;
  models: ModelDto[];
  model: string;
  onModelChange: (id: string) => void;
  /** Resolves true once the send was accepted (so the composer can clear); false to keep the typed text and images. */
  onSend: (content: string, images: PendingImage[]) => Promise<boolean>;
  sending: boolean;
  errorLine: string | null;
  onEscape: () => void;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  /** Spec M15 §4: the canvas's memories, the chosen topics (they go into the system prompt) and the change handler. */
  memories?: MemoryDto[];
  memorySel?: string[];
  onMemorySel?: (topics: string[]) => void;
  /** Spec M17 §3.1: Reply sends a message; Edit asks the model to rewrite `editTarget` (the cursor). */
  mode?: ComposerMode;
  onModeChange?: (mode: ComposerMode) => void;
  editTarget?: NodeDto | null;
  /** Spec M17 §3.2: an open rewrite preview — ⌘Enter on the empty box accepts it, Esc discards it. */
  onAccept?: () => void;
  onDiscard?: () => void;
}

export type ComposerMode = 'reply' | 'edit';

const AUTOGROW_MAX = 200;
const MAX_LISTED_TARGETS = 3;
const PLACEHOLDER = {
  single: 'Write a message… (⏎ send, ⇧⏎ newline, Esc back to graph)',
  edit: { de: 'Was soll sich ändern?', en: 'What should change?' },
  merge: { de: 'Was soll aus diesen Zweigen entstehen? (⏎ senden, ⇧⏎ neue Zeile)', en: 'What should come out of these branches? (⏎ send, ⇧⏎ newline)' },
};
const OVER_BUDGET: Record<Language, string> = {
  de: 'Über Budget — Nodes abwählen (Space auf einem hervorgehobenen Node)',
  en: 'Over budget — deselect nodes (Space on a highlighted node)',
};

function targetLine(targets: NodeDto[]): ReactElement {
  if (targets.length === 0) return <>New root message</>;
  if (targets.length === 1) return <>Replying to: <strong>{nodeTitle(targets[0]!)}</strong></>;
  const listed = targets.slice(0, MAX_LISTED_TARGETS).map((t) => nodeTitle(t)).join(', ');
  const more = targets.length - MAX_LISTED_TARGETS;
  return <>Merging: <strong>{listed}</strong>{more > 0 ? ` +${more}` : ''}</>;
}

export function Composer({ targets, language, promptTokens, budget, models, model, onModelChange, onSend, sending, errorLine, onEscape, textareaRef, memories = [], memorySel = [], onMemorySel, mode = 'reply', onModeChange, editTarget = null, onAccept, onDiscard }: ComposerProps) {
  const editing = mode === 'edit';
  const [text, setText] = useState('');
  const [images, setImages] = useState<PendingImage[]>([]);
  const [imageError, setImageError] = useState<string | null>(null);
  const available = models.filter((m) => m.available);
  const used = promptTokens(text) + (editing ? 0 : images.length * IMAGE_TOKENS);
  const over = budget > 0 && used > budget;
  const warn = !over && budget > 0 && used / budget >= 0.8;
  const canSend = available.length > 0 && (text.trim() !== '' || (!editing && images.length > 0)) && !sending && !over && (!editing || editTarget !== null);
  const merging = targets.length >= 2;

  const submit = (): void => {
    if (!canSend) return;
    const content = text.trim();
    void (async () => {
      const ok = await onSend(content, editing ? [] : images);
      if (ok) { setText(''); setImages([]); setImageError(null); }
    })();
  };
  // Spec M13: paste, drop and the picker all end here; unsupported files and the ones over MAX_IMAGES are refused.
  const addImages = (files: File[]): void => {
    const ok = files.filter(isSupportedImage);
    const room = MAX_IMAGES - images.length;
    setImageError(ok.length < files.length ? 'Only PNG, JPEG, GIF and WebP images can be attached' : ok.length > room ? `At most ${MAX_IMAGES} images per message` : null);
    void Promise.all(ok.slice(0, Math.max(room, 0)).map(prepareImage))
      .then((ready) => setImages((cur) => [...cur, ...ready].slice(0, MAX_IMAGES)))
      .catch((e: unknown) => setImageError(`Could not read the image: ${String(e)}`));
  };
  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>): void => {
    const files = [...e.clipboardData.files].filter((f) => f.type.startsWith('image/'));
    if (files.length === 0 || editing) return; // plain text pastes as usual; an edit takes no images (spec M17 §3.1)
    e.preventDefault();
    addImages(files);
  };
  const onDrop = (e: DragEvent<HTMLFormElement>): void => {
    if (e.dataTransfer.files.length === 0) return;
    e.preventDefault();
    if (!editing) addImages([...e.dataTransfer.files]);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.nativeEvent.isComposing) return; // IME composition confirm (e.g. Enter) must not send
    if (e.key === 'Enter' && !e.shiftKey) {
      // Plain Enter sends; Shift+Enter falls through to insert a newline. Cmd/Ctrl+Enter
      // is covered too (shiftKey is false), kept working for muscle memory.
      e.preventDefault();
      // Spec M17 §3.2: with nothing typed, ⌘Enter accepts an open rewrite preview.
      if (editing && text.trim() === '' && (e.metaKey || e.ctrlKey) && onAccept) onAccept();
      else submit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      // Spec M17 §3.1/§3.2: an empty edit box steps back — the preview first, then to Reply.
      if (editing && text === '' && onDiscard) onDiscard();
      else if (editing && text === '' && onModeChange) onModeChange('reply');
      else onEscape();
    }
  };
  // Grows the textarea with its content up to AUTOGROW_MAX, for browsers without `field-sizing`.
  const onInput = (e: FormEvent<HTMLTextAreaElement>): void => {
    const el = e.currentTarget;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, AUTOGROW_MAX)}px`;
  };

  return (
    <form className="composer" onSubmit={(e) => { e.preventDefault(); submit(); }} onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) e.preventDefault(); }} onDrop={onDrop}>
      {errorLine && <p className="composer-error" role="alert">{errorLine}</p>}
      {imageError && <p className="composer-error" role="alert">{imageError}</p>}
      {over && <p className="composer-error" role="alert">{OVER_BUDGET[language]}</p>}
      <div className="composer-row">
        <span className="target">{editing ? <>Edit: <strong>{editTarget ? nodeTitle(editTarget) : '—'}</strong></> : targetLine(targets)}</span>
        <div className={`meter${over ? ' over' : warn ? ' warn' : ''}`} role="meter" aria-label="Context tokens" aria-valuenow={used} aria-valuemin={0} aria-valuemax={budget}>
          <span className="bar"><span className="fill" style={{ width: `${budget > 0 ? Math.min(100, (used / budget) * 100) : 100}%` }} /></span>
          <span className="meter-text">~{formatTokens(used)} / {formatTokens(budget)}</span>
        </div>
      </div>
      {!editing && memories.length > 0 && onMemorySel && (
        <div className="composer-row memories" role="group" aria-label="Memories in the system prompt">
          <span className="memories-label">Memory:</span>
          {memorySel.map((t) => (
            <span key={t} className="chip active memory-chip">
              {t}
              <button type="button" aria-label={`Remove memory ${t}`} onClick={() => onMemorySel(memorySel.filter((x) => x !== t))}>✕</button>
            </span>
          ))}
          {memories.some((m) => !memorySel.includes(m.topic)) && (
            <select aria-label="Add memory" value="" onChange={(e) => { if (e.target.value !== '') onMemorySel([...memorySel, e.target.value]); }}>
              <option value="">+ Memory</option>
              {memories.filter((m) => !memorySel.includes(m.topic)).map((m) => <option key={m.topic} value={m.topic}>{m.topic}</option>)}
            </select>
          )}
          {memorySel.length === 0 && <span className="hint">none — add one to give the model a topic's facts</span>}
        </div>
      )}
      <div className="composer-row">
        {available.length === 0 ? (
          <span className="no-provider">No provider configured — set ANTHROPIC_API_KEY, OPENAI_API_KEY, OPENROUTER_API_KEY or MISTRAL_API_KEY (or ~/.config/chatmind/env) and restart chatmind</span>
        ) : (
          <>
            <fieldset className="models" aria-label="Model">
              {available.map((m) => (
                <label key={m.id} className={m.id === model ? 'chip active' : 'chip'}>
                  <input type="radio" name="model" value={m.id} checked={m.id === model} onChange={() => onModelChange(m.id)} />
                  {m.label}
                </label>
              ))}
            </fieldset>
            {onModeChange && (
              <span className="mode-switch" role="group" aria-label="Composer mode">
                {(['reply', 'edit'] as const).map((m) => (
                  <button key={m} type="button" aria-pressed={mode === m} disabled={m === 'edit' && editTarget === null} title={m === 'edit' ? 'Tell the model what to change on the selected card (E)' : 'Write a reply (Enter)'} onClick={() => { if (mode !== m) onModeChange(m); textareaRef.current?.focus(); }}>{m === 'reply' ? 'Reply' : 'Edit'}</button>
                ))}
              </span>
            )}
            <span className="hint">⇧⇥ then ←→ to change model</span>
          </>
        )}
      </div>
      {!editing && images.length > 0 && (
        <ul className="composer-images" aria-label="Attached images">
          {images.map((img, i) => (
            <li key={i}>
              <img src={img.url} alt={`Image ${i + 1}`} />
              <button type="button" aria-label={`Remove image ${i + 1}`} onClick={() => { setImages((cur) => cur.filter((_, j) => j !== i)); setImageError(null); }}>✕</button>
            </li>
          ))}
        </ul>
      )}
      <div className="composer-row">
        <label className={`attach${editing || available.length === 0 || images.length >= MAX_IMAGES ? ' disabled' : ''}`} title="Attach images (or paste / drop them)">
          📎
          <input type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple disabled={editing || available.length === 0 || images.length >= MAX_IMAGES} aria-label="Attach images" onChange={(e) => { addImages([...(e.target.files ?? [])]); e.target.value = ''; }} />
        </label>
        <textarea ref={textareaRef} rows={2} value={text} placeholder={editing ? PLACEHOLDER.edit[language] : merging ? PLACEHOLDER.merge[language] : PLACEHOLDER.single} onChange={(e) => setText(e.target.value)} onInput={onInput} onKeyDown={onKeyDown} onPaste={onPaste} disabled={available.length === 0} />
        <button type="submit" disabled={!canSend}>{editing ? 'Rewrite' : 'Send'}</button>
      </div>
    </form>
  );
}
