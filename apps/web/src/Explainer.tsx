import { useCallback, useEffect, useRef, useState } from 'react';
import { explainSpot, keepExplanation, type ExplainTurn } from './api';
import { MessageBody } from './MessageBody';
import { parseSseStream } from './sse';
import type { NodeDto } from '@chatmind/core';

const MAX_SELECTION = 500;
const PASSAGE_TAGS = 'p, li, td, th, blockquote, pre, h1, h2, h3, h4, h5, h6';

interface Spot { id: string; selection: string; passage: string; rect: { top: number; left: number; bottom: number; right: number } }
interface Answer { q: string; text: string; status: 'streaming' | 'ready' | 'error'; error?: string }

/** The marked text inside one card body (an element with `data-explain-id`), or null. Pure DOM read. */
export function spotFromSelection(sel: Selection | null): Spot | null {
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
  const text = sel.toString().replace(/\s+/g, ' ').trim();
  if (text === '' || text.length > MAX_SELECTION) return null;
  const el = (n: Node | null): Element | null => (n === null ? null : n instanceof Element ? n : n.parentElement);
  const host = el(sel.anchorNode)?.closest('[data-explain-id]');
  if (!host || host !== el(sel.focusNode)?.closest('[data-explain-id]')) return null;
  const range = sel.getRangeAt(0);
  const passage = (el(range.startContainer)?.closest(PASSAGE_TAGS)?.textContent ?? '').replace(/\s+/g, ' ').trim();
  const r = typeof range.getBoundingClientRect === 'function' ? range.getBoundingClientRect() : { top: 0, left: 0, bottom: 0, right: 0 }; // jsdom has none
  return { id: host.getAttribute('data-explain-id')!, selection: text, passage, rect: { top: r.top, left: r.left, bottom: r.bottom, right: r.right } };
}

interface Props {
  slug: string | null;
  model: string;
  /** Kept as a branch: the written turns; the last one becomes the cursor. */
  onKeptBranch: (nodes: NodeDto[]) => void;
  /** Kept as a note: App creates it like any other note. */
  onKeepNote: (body: string) => void;
}

/**
 * Spec quick-explain §2: mark a spot in a card → "?" → a short explanation in a popover, with follow-ups.
 * Nothing is written unless the user keeps it (as a branch below the card, or as a note).
 */
export function Explainer({ slug, model, onKeptBranch, onKeepNote }: Props) {
  const [trigger, setTrigger] = useState<Spot | null>(null);
  const [open, setOpen] = useState<{ spot: Spot; done: ExplainTurn[]; cur: Answer } | null>(null);
  const [ask, setAsk] = useState('');
  const [keepError, setKeepError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);

  const close = useCallback((): void => {
    abortRef.current?.abort();
    abortRef.current = null;
    setOpen(null);
    setAsk('');
    setKeepError(null);
  }, []);

  // Watch the selection; a mark inside the popover itself never moves the trigger.
  useEffect(() => {
    const onUp = (e: Event): void => {
      if (popRef.current?.contains(e.target as Node)) return;
      if ((e.target as Element | null)?.closest?.('.explain-trigger')) return;
      setTimeout(() => setTrigger(spotFromSelection(window.getSelection())), 0);
    };
    document.addEventListener('mouseup', onUp);
    document.addEventListener('keyup', onUp);
    return () => {
      document.removeEventListener('mouseup', onUp);
      document.removeEventListener('keyup', onUp);
    };
  }, []);

  // Esc closes the popover before any other shortcut sees it; a click outside closes it too.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      e.preventDefault();
      close();
    };
    const onDown = (e: MouseEvent): void => { if (!popRef.current?.contains(e.target as Node)) close(); };
    window.addEventListener('keydown', onKey, true);
    document.addEventListener('mousedown', onDown);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      document.removeEventListener('mousedown', onDown);
    };
  }, [open, close]);

  useEffect(() => () => abortRef.current?.abort(), []);
  useEffect(close, [slug, close]); // another canvas: the explanation belongs to the old one

  const run = async (spot: Spot, done: ExplainTurn[], q: string): Promise<void> => {
    if (!slug) return;
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    const update = (f: (a: Answer) => Answer): void => { if (abortRef.current === ac) setOpen((o) => (o ? { ...o, cur: f(o.cur) } : o)); };
    const fail = (message: string): void => update((a) => ({ ...a, status: 'error', error: message }));
    setOpen({ spot, done, cur: { q, text: '', status: 'streaming' } });
    if (model === '') return fail('No model available — add an API key.');
    try {
      const res = await explainSpot(slug, spot.id, { selection: spot.selection, passage: spot.passage, exchange: done, ask: q, model }, ac.signal);
      if (!res.ok || !res.body) return fail(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `${res.status}`);
      let finished = false;
      for await (const ev of parseSseStream(res.body)) {
        if (abortRef.current !== ac) return;
        const d = JSON.parse(ev.data) as { text?: string; message?: string };
        if (ev.event === 'delta') update((a) => ({ ...a, text: a.text + (d.text ?? '') }));
        else if (ev.event === 'done') { update((a) => ({ ...a, text: d.text ?? a.text, status: 'ready' })); finished = true; }
        else if (ev.event === 'error') { fail(d.message ?? 'error'); finished = true; }
      }
      if (!finished) fail('connection closed before the explanation finished');
    } catch (e) {
      if (!ac.signal.aborted) fail(String(e));
    }
  };

  const start = (): void => {
    if (!trigger) return;
    const spot = trigger;
    setTrigger(null);
    window.getSelection()?.removeAllRanges();
    void run(spot, [], '');
  };

  const follow = (): void => {
    if (!open || open.cur.status !== 'ready') return;
    const q = ask.trim();
    if (q === '') return;
    setAsk('');
    void run(open.spot, [...open.done, { q: open.cur.q, a: open.cur.text }], q);
  };

  const turns = (): ExplainTurn[] => (open ? [...open.done, ...(open.cur.status === 'ready' ? [{ q: open.cur.q, a: open.cur.text }] : [])] : []);

  const keepBranch = async (): Promise<void> => {
    if (!open || !slug) return;
    try {
      const { nodes } = await keepExplanation(slug, open.spot.id, { selection: open.spot.selection, exchange: turns(), model });
      close();
      onKeptBranch(nodes);
    } catch (e) {
      setKeepError(`Could not keep it: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const keepNote = (): void => {
    if (!open) return;
    const body = [`**»${open.spot.selection}«**`, ...turns().flatMap((t, i) => [...(i > 0 || t.q !== '' ? [`**${t.q}**`] : []), t.a])].join('\n\n');
    close();
    onKeepNote(body);
  };

  const pos = (r: Spot['rect'], w: number): { top: number; left: number } => ({
    top: Math.min(r.bottom + 6, window.innerHeight - 80),
    left: Math.max(8, Math.min(r.left, window.innerWidth - w - 8)),
  });

  return (
    <>
      {trigger && !open && (
        <button type="button" className="explain-trigger" style={{ top: trigger.rect.top - 30, left: Math.min(trigger.rect.right, window.innerWidth - 36) }} title="Explain this (quick question, not saved)" aria-label="Explain the marked text" onMouseDown={(e) => e.preventDefault()} onClick={start}>?</button>
      )}
      {open && (
        <div ref={popRef} className="explain-pop" role="dialog" aria-label="Quick explanation" style={pos(open.spot.rect, 380)}>
          <header>
            <span className="explain-spot" title={open.spot.selection}>»{open.spot.selection}«</span>
            <button type="button" className="explain-close" aria-label="Close" title="Close (Esc)" onClick={close}>✕</button>
          </header>
          <div className="explain-body">
            {open.done.map((t, i) => (
              <div key={i} className="explain-turn">
                {(i > 0 || t.q !== '') && <p className="explain-q">{t.q}</p>}
                <MessageBody text={t.a} slug={slug ?? ''} />
              </div>
            ))}
            <div className="explain-turn">
              {(open.done.length > 0 || open.cur.q !== '') && <p className="explain-q">{open.cur.q}</p>}
              {open.cur.text !== '' && <MessageBody text={open.cur.text} slug={slug ?? ''} />}
              {open.cur.status === 'streaming' && open.cur.text === '' && <p className="streaming-status" role="status"><span className="dots" aria-hidden="true"><i /><i /><i /></span></p>}
              {open.cur.status === 'error' && <p className="composer-error" role="alert">{open.cur.error}</p>}
            </div>
          </div>
          <form onSubmit={(e) => { e.preventDefault(); follow(); }}>
            <input autoFocus aria-label="Follow-up question" placeholder="Ask a follow-up…" value={ask} onChange={(e) => setAsk(e.target.value)} disabled={open.cur.status === 'streaming'} />
          </form>
          <footer>
            <span className="hint">Not saved</span>
            <button type="button" disabled={turns().length === 0} onClick={() => void keepBranch()} title="Write it as a question and answer below the card">Keep as branch</button>
            <button type="button" disabled={turns().length === 0} onClick={keepNote} title="Put it on the canvas as a note">Keep as note</button>
          </footer>
          {keepError && <p className="composer-error" role="alert">{keepError}</p>}
        </div>
      )}
    </>
  );
}
