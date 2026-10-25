import type { CanvasDto, CanvasSummaryDto, LinkDto, MemoryDto, ModelDto, NodeDto } from '@chatmind/core';
import { MAX_NOTE_CHARS, NODE_GAP, NODE_WIDTH, budgetFor, buildContext, buildEditContext, compressionSections, contextSet, deleteSet, graphLikeFromDto, promptTokens, maxCompressedTurns, rememberPath, strandOf, subtreeIds, topicKey, turnOf, type Section } from '@chatmind/core/graph';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { XYPosition } from '@xyflow/react';
import type { PendingImage } from './images';
import { compressStrand, createCanvas, createNote, deleteTurns, fetchCanvas, fetchCanvases, fetchModels, moveCards, rewriteNode, saveNode, saveSummary, sendMessage } from './api';
import { Composer, type ComposerMode } from './Composer';
import { EditPreview, type EditState } from './EditPreview';
import { createRefetcher, subscribeVaultEvents } from './events';
import { nodeTitle, type FlowMarks, type TopicMarks } from './flow';
import { GraphView } from './GraphView';
import { ChatView } from './ChatView';
import { locationFor, readLocation, useLinks, type View } from './links';
import { MemoryEditor } from './MemoryEditor';
import { mergeCanvas } from './merge';
import { nextSelection, type NavKey } from './navigation';
import { NodeEditor } from './NodeEditor';
import { NodePanel } from './NodePanel';
import { clearSelection, effectiveTargets, survivorAbove, toggleParticipation, type SelectionState } from './selection';
import { parseSseStream } from './sse';
import { nodesOfTopic, topicList, topicPalette } from './topics';
import { useCollapsed, usePanelWidth } from './usePanelWidth';
import { applyStreams, streamsReducer, type StreamState } from './streams';

const MODEL_KEY = 'chatmind.model';
/** Spec M11 §11: where the cards of a compress come from. */
type CompressSource = 'context' | 'selection' | 'subtree';
const COMPRESS_SOURCES: CompressSource[] = ['context', 'selection', 'subtree'];
const SOURCE_LABELS: Record<CompressSource, string> = { context: 'In context', selection: 'Selected cards', subtree: 'Everything below' };
const cardsOf = (sections: Section[]): string[] => sections.flatMap((s) => [...s.turns.flat(), ...s.folds.flat(2)]);
const NAV_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);
const SKIP_TAGS = new Set(['BUTTON', 'SELECT', 'INPUT', 'TEXTAREA', 'SUMMARY']);
// F2: a node this recently arrived via the send loop (its user-node or its assistant's done) is
// protected from a stale refetch for this long, even after streaming has moved on / finished.
const RECENT_MS = 5_000;
const NO_IDS: ReadonlySet<string> = new Set();

export function App() {
  const [canvases, setCanvases] = useState<CanvasSummaryDto[] | null>(null);
  const [slug, setSlug] = useState<string | null>(null);
  const [canvas, setCanvas] = useState<CanvasDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [canvasError, setCanvasError] = useState<string | null>(null);
  const [selection, setSelection] = useState<SelectionState>(clearSelection);
  const setCursor = (id: string | null): void => setSelection((s) => ({ ...s, cursorId: id }));
  const [models, setModels] = useState<ModelDto[]>([]);
  const [model, setModel] = useState<string>(() => { try { return localStorage.getItem(MODEL_KEY) ?? ''; } catch { return ''; } });
  const [streams, setStreams] = useState<ReadonlyMap<string, StreamState>>(new Map());
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [focusIds, setFocusIds] = useState<string[] | null>(null);
  const [activeTopic, setActiveTopic] = useState<string | null>(null);
  // Spec M15 §4: the user's memory choice, valid for the targets it was made for; otherwise the defaults apply.
  const [memoryPick, setMemoryPick] = useState<{ key: string; topics: string[] } | null>(null);
  // Spec M16 §6: the text of an open "+ Note" dialog.
  const [noteDraft, setNoteDraft] = useState<string | null>(null);
  // Spec M17 §2: the card open in the hand editor — the body it started from and the text it opens with.
  const [handEdit, setHandEdit] = useState<{ id: string; base: string; initial: string; seq: number } | null>(null);
  // Spec M17 §3: the composer's mode, the open rewrite preview (with the request streaming it) and an Accept in flight.
  const [mode, setMode] = useState<ComposerMode>('reply');
  const [edit, setEdit] = useState<EditState | null>(null);
  const editRef = useRef<EditState | null>(null);
  useEffect(() => { editRef.current = edit; }, [edit]);
  const editAbortRef = useRef<AbortController | null>(null);
  const [editSaving, setEditSaving] = useState(false);
  // Read by the window key handler: Esc / ⌘Enter belong to an open preview first.
  const editKeysRef = useRef<{ open: boolean; accept: () => void; discard: () => void }>({ open: false, accept: () => undefined, discard: () => undefined });
  const centreRef = useRef<(() => XYPosition) | null>(null);
  const [newName, setNewName] = useState<string | null>(null);
  const [newCanvasError, setNewCanvasError] = useState<string | null>(null);
  // Spec M8: the cards Cmd-click / Cmd-drag selected for moving and deleting; the ids a pending delete asks about.
  const [moveSel, setMoveSel] = useState<ReadonlySet<string>>(NO_IDS);
  const [pendingDelete, setPendingDelete] = useState<string[] | null>(null);
  // Spec M11 §6/§11: an open compress dialog — the cards of each source (frozen when it opened), the chosen source,
  // the fold checkbox, and whether the request is in flight.
  const [compress, setCompress] = useState<{ ids: Record<CompressSource, string[]>; source: CompressSource; fold: boolean; running: boolean } | null>(null);
  // Spec M9: which view the middle pane shows, and the branch last taken at each fork (session only, per canvas).
  const [view, setView] = useState<View>(() => readLocation(window.location.search).view);
  const [preferred, setPreferred] = useState<ReadonlyMap<string, string>>(new Map());
  // Spec M7 §6: bumped on every vault event, so cached links are refetched; the node a jump or Back lands on.
  const [linksVersion, setLinksVersion] = useState(0);
  const pendingCursorRef = useRef<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const panel = usePanelWidth();
  const [leftCollapsed, toggleLeft] = useCollapsed('left');
  const [rightCollapsed, toggleRight, setRightCollapsed] = useCollapsed('right');
  const graphRef = useRef<HTMLElement>(null);
  // Read by the window-level keydown listener (registered once, below) so it always
  // sees the latest canvas/selection without needing to re-subscribe on every change.
  const keyStateRef = useRef<{ canvas: CanvasDto | null; selection: SelectionState; activeTopic: string | null; moveSel: ReadonlySet<string>; deleting: boolean; view: View; preferred: ReadonlyMap<string, string> }>({ canvas: null, selection: clearSelection(), activeTopic: null, moveSel: NO_IDS, deleting: false, view: 'canvas', preferred: new Map() });
  // Read inside the send loop's async continuation to tell whether the user has since
  // switched to a different canvas (spec §7 — a send must not affect a canvas that isn't
  // its own, and must not steer selection/focus/streams for one the user has left).
  const currentSlugRef = useRef<string | null>(null);
  // Read by the vault-events subscription effect (registered once, below) so it always sees
  // the latest streams/canvases without needing to re-subscribe on every change.
  const streamsRef = useRef<ReadonlyMap<string, StreamState>>(new Map());
  useEffect(() => { streamsRef.current = streams; }, [streams]);
  const canvasesRef = useRef<CanvasSummaryDto[]>([]);
  useEffect(() => { canvasesRef.current = canvases ?? []; }, [canvases]);
  // F2: id → timestamp for a node the send loop just wrote (its user-node or its assistant's
  // done), fed by `consume` below. A refetch that raced the write (started before it landed,
  // resolved after `streams` already dropped the id on `done`) must still treat these as alive —
  // pruned of entries older than RECENT_MS on each read.
  const recentRef = useRef<Map<string, number>>(new Map());

  const reloadCanvases = useCallback(async () => {
    const list = await fetchCanvases();
    setCanvases(list);
    return list;
  }, []);

  useEffect(() => {
    // Read before anything async: once a canvas is open the URL is rewritten (replaceState), and StrictMode's second
    // run of this effect would otherwise read the rewritten URL and drop ?node=.
    const fromUrl = readLocation(window.location.search);
    Promise.all([reloadCanvases(), fetchModels()])
      .then(([list, ms]) => {
        setModels(ms);
        const initial = list.find((c) => c.slug === fromUrl.canvas)?.slug ?? null;
        if (initial !== null) pendingCursorRef.current = fromUrl.node; // spec M7 §6: ?node= selects on load
        setSlug(initial ?? list[0]?.slug ?? null);
        const available = ms.filter((m) => m.available);
        setModel((cur) => (available.some((m) => m.id === cur) ? cur : (available[0]?.id ?? '')));
      })
      .catch((e: unknown) => setError(String(e)));
  }, [reloadCanvases]);

  useEffect(() => {
    currentSlugRef.current = slug;
    if (slug === null) return;
    let cancelled = false;
    setCanvas(null);
    setCanvasError(null);
    setSelection(clearSelection());
    setMoveSel(NO_IDS);
    setPendingDelete(null);
    setCompress(null);
    setHandEdit(null);
    dropEdit();
    setMode('reply');
    setPreferred(new Map());
    setStreams(new Map());
    setFocusIds(null);
    setActiveTopic(null);
    fetchCanvas(slug)
      .then((c) => {
        if (cancelled) return;
        setCanvas(c);
        // Spec M7 §6: a jump, Back or ?node= lands on its node once the canvas is there; a vanished node opens just the canvas.
        const pending = pendingCursorRef.current;
        pendingCursorRef.current = null;
        if (pending !== null && c.nodes.some((n) => n.id === pending)) {
          setSelection({ ...clearSelection(), cursorId: pending });
          setFocusIds([pending]);
        }
      })
      .catch((e: unknown) => { if (!cancelled) setCanvasError(String(e)); });
    return () => { cancelled = true; };
  }, [slug]);

  // Spec M5 §7: follow the vault. Any change reloads the list; a change to the open canvas refetches and
  // merges it by id — ghosts, cursor and camera are left alone.
  useEffect(() => {
    const refetch = createRefetcher(async () => {
      const cur = currentSlugRef.current;
      // F2: a fetch in flight across the send loop's write can resolve a canvas that's missing a
      // node `streams` no longer names either (streamsReducer drops an id on `done`) — snapshot
      // the streaming ids at both ends of the fetch, plus anything the send loop touched in the
      // last RECENT_MS, and protect the union from being dropped by the merge below.
      const startIds = [...streamsRef.current.keys()];
      // allSettled, not all: a 404 on the current canvas (deleted in Obsidian) must not sink
      // the list reload too, or the deleted canvas lingers in the sidebar.
      const [listRes, freshRes] = await Promise.allSettled([fetchCanvases(), cur === null ? Promise.resolve(null) : fetchCanvas(cur)]);
      if (listRes.status === 'fulfilled') setCanvases(listRes.value);
      const fresh = freshRes.status === 'fulfilled' ? freshRes.value : null;
      if (fresh === null || currentSlugRef.current !== fresh.slug) return;
      const now = Date.now();
      for (const [id, at] of recentRef.current) if (now - at > RECENT_MS) recentRef.current.delete(id); // pruned on use
      const protectedIds = new Map<string, true>();
      for (const id of startIds) protectedIds.set(id, true);
      for (const id of streamsRef.current.keys()) protectedIds.set(id, true);
      for (const id of recentRef.current.keys()) protectedIds.set(id, true);
      setCanvas((c) => (c && c.slug === fresh.slug ? mergeCanvas(c, fresh, protectedIds) : c));
      const ids = new Set([...fresh.nodes.map((n) => n.id), ...protectedIds.keys()]);
      setSelection((s) => (s.cursorId !== null && !ids.has(s.cursorId) ? { ...s, cursorId: null } : s));
    });
    return subscribeVaultEvents((slugs) => {
      setLinksVersion((v) => v + 1); // spec M7 §6: any change may move links, in any canvas
      const cur = currentSlugRef.current;
      const unknown = slugs.some((s) => !canvasesRef.current.some((c) => c.slug === s));
      if (cur === null || slugs.includes(cur) || unknown) refetch();
      else void fetchCanvases().then(setCanvases).catch(() => undefined);
    });
  }, []);

  // Spec M7 §6: the current entry always carries canvas and cursor, so a pushState from here leaves a Back target.
  useEffect(() => {
    if (slug !== null) window.history.replaceState(null, '', locationFor(slug, selection.cursorId, view));
  }, [slug, selection.cursorId, view]);

  // Spec M9 §3: remember the branch taken at every fork above the cursor, so moving up keeps it below.
  useEffect(() => {
    const id = selection.cursorId;
    if (id !== null && canvas) setPreferred((p) => rememberPath(graphLikeFromDto(canvas), id, p));
  }, [selection.cursorId, canvas]);

  // Spec M17 §2: the hand editor belongs to the cursor's card; moving on closes it.
  // Spec M17 §3.2: so does a rewrite preview (it was never written); without a cursor the composer replies again.
  useEffect(() => {
    setHandEdit((h) => (h !== null && h.id !== selection.cursorId ? null : h));
    if (editRef.current !== null && editRef.current.id !== selection.cursorId) dropEdit();
    if (selection.cursorId === null) setMode('reply');
  }, [selection.cursorId]);

  useEffect(() => {
    const onPop = (): void => {
      const { canvas: target, node, view: toView } = readLocation(window.location.search);
      if (target === null) return;
      setView(toView);
      if (target === currentSlugRef.current) {
        setSelection((s) => ({ ...s, cursorId: node }));
        if (node !== null) setFocusIds([node]);
        return;
      }
      pendingCursorRef.current = node;
      setSlug(target);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  useEffect(() => {
    keyStateRef.current = { canvas, selection, activeTopic, moveSel, deleting: pendingDelete !== null || (compress !== null && !compress.running), view, preferred };
  }, [canvas, selection, activeTopic, moveSel, pendingDelete, compress, view, preferred]);

  /** Spec M7 §6: every canvas switch is a history entry; `node` becomes the cursor once the canvas has loaded. */
  const openCanvas = (target: string, node: string | null = null): void => {
    if (target === slug) {
      if (node !== null) { setCursor(node); setFocusIds([node]); }
      return;
    }
    pendingCursorRef.current = node;
    window.history.pushState(null, '', locationFor(target, node, view));
    setSlug(target);
  };
  const openRelated = (l: LinkDto): void => openCanvas(l.canvas, l.id);

  /** Spec M9 §4.3: back on the canvas the camera finds the cursor; the chat centres it on its own. */
  const switchView = (to: View): void => {
    setView(to);
    const id = keyStateRef.current.selection.cursorId;
    if (to === 'canvas' && id !== null) setFocusIds([id]);
  };

  /** Double-clicking a card reads it in the chat, at its place in the strand, with the right bar out of the way. */
  const openInChat = (id: string): void => {
    setCursor(id);
    setView('chat');
    setRightCollapsed(true);
  };

  const chooseModel = (id: string): void => {
    setModel(id);
    try { localStorage.setItem(MODEL_KEY, id); } catch { /* per-viewer convenience only */ }
  };

  // Graph-level keyboard model (spec §7). Registered once — reads keyStateRef for current
  // canvas/selection rather than depending on them, so the listener never churns.
  // Ignored unless the event targets the page body/window (nothing focused) or something
  // inside the graph pane itself, and always ignored for buttons/inputs/textareas/selects/
  // contenteditable so it never hijacks Enter/arrow keys away from sidebar controls, the
  // new-canvas input, or the composer's own textarea (which has its own key handling).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const t = e.target as EventTarget | null;
      if (t && 'tagName' in t) {
        const el = t as HTMLElement;
        if (SKIP_TAGS.has(el.tagName) || el.isContentEditable) return;
      }
      // A non-Node target (window itself — nothing focused) is always in scope. A Node
      // target is in scope only as document.body or something inside the graph pane.
      const inScope = !(t instanceof Node) || t === document.body || (graphRef.current !== null && graphRef.current.contains(t));
      if (!inScope) return;
      const { canvas: cur, selection: sel, moveSel: movers } = keyStateRef.current;
      if (!cur) return;
      const ek = editKeysRef.current;
      if (ek.open && !keyStateRef.current.deleting && (e.key === 'Escape' || (e.key === 'Enter' && (e.metaKey || e.ctrlKey)))) {
        // Spec M17 §3.2: an open rewrite preview owns Esc (discard) and ⌘Enter (accept).
        e.preventDefault();
        if (e.key === 'Escape') ek.discard();
        else ek.accept();
        return;
      }
      if (keyStateRef.current.deleting) {
        // Spec M8 §5.4: the confirmation owns the keyboard — Esc cancels, everything else waits for its buttons.
        if (e.key === 'Escape') { setPendingDelete(null); setCompress((c) => (c?.running ? c : null)); graphRef.current?.focus(); }
        return;
      }
      if (NAV_KEYS.has(e.key)) {
        e.preventDefault();
        // Spec M9 §4.2: in the chat ↓ follows the strand shown; ↑ (primary parent) and ←/→ (siblings) mean the same in both views.
        const inChat = keyStateRef.current.view === 'chat' && e.key === 'ArrowDown' && sel.cursorId !== null;
        const strand = inChat ? strandOf(graphLikeFromDto(cur), sel.cursorId!, keyStateRef.current.preferred) : [];
        const at = strand.findIndex((i) => i.node.id === sel.cursorId);
        const next = inChat ? (strand[at + 1]?.node.id ?? sel.cursorId) : nextSelection(cur, sel.cursorId, e.key as NavKey);
        setCursor(next);
        if (next) setFocusIds([next]);
      } else if (e.key === ' ') {
        if (sel.cursorId === null) return;
        e.preventDefault();
        const id = sel.cursorId;
        setSelection((s) => toggleParticipation(graphLikeFromDto(cur), s, id));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        textareaRef.current?.focus();
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        // Spec M8 §5.4: the move selection if there is one, otherwise the cursor; a confirmation follows.
        const ids = movers.size > 0 ? [...movers] : sel.cursorId !== null ? [sel.cursorId] : [];
        if (ids.length === 0) return;
        e.preventDefault();
        setPendingDelete(ids);
      } else if ((e.key === 'e' || e.key === 'E') && !e.metaKey && !e.ctrlKey && !e.altKey) {
        // Spec M17 §3.1: E tells the model what to change on the cursor's card.
        if (sel.cursorId === null) return;
        e.preventDefault();
        setMode('edit');
        textareaRef.current?.focus();
      } else if ((e.key === 'v' || e.key === 'V') && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        switchView(keyStateRef.current.view === 'chat' ? 'canvas' : 'chat');
      } else if (e.key === 'Escape') {
        // Spec M8 §4.1 / M6 §7: the move selection goes first, then a topic highlight, then the selection.
        if (movers.size > 0) setMoveSel(NO_IDS);
        else if (keyStateRef.current.activeTopic !== null) setActiveTopic(null);
        else setSelection(clearSelection());
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Consumes the SSE body after the send has already been accepted (so the composer can
  // clear immediately); runs detached from `send` and keeps `sending` true until it settles.
  const consume = async (sendSlug: string, body: ReadableStream<Uint8Array>): Promise<void> => {
    let assistantId: string | null = null;
    let assistantParentId: string | null = null; // from assistant-start — reselected if the answer fails outright
    const inScope = (): boolean => currentSlugRef.current === sendSlug;
    try {
      for await (const ev of parseSseStream(body)) {
        const data = JSON.parse(ev.data) as never;
        switch (ev.event) {
          case 'user-node': {
            const node = data as NodeDto;
            // One edge per parent (spec §5) with the server's ids, so a reload changes nothing; a merge node's second edge draws dashed at once.
            setCanvas((c) => (c && c.slug === sendSlug ? { ...c, nodes: [...c.nodes, node], edges: [...c.edges, ...node.parents.map((p) => ({ id: `e-${p}-${node.id}`, from: p, to: node.id }))] } : c));
            recentRef.current.set(node.id, Date.now()); // F2: protects it from a stale refetch until a vault-changed refetch has actually seen it
            break;
          }
          case 'assistant-start': {
            const s = data as { id: string; model: string; layout: NodeDto['layout']; parents: string[]; created: string };
            assistantId = s.id;
            assistantParentId = s.parents[0] ?? null;
            const node: NodeDto = { id: s.id, role: 'assistant', model: s.model, parents: s.parents, created: s.created, summary: '', topics: [], body: '', layout: s.layout };
            setCanvas((c) => (c && c.slug === sendSlug ? { ...c, nodes: [...c.nodes, node], edges: [...c.edges, { id: `e-${s.parents[0]}-${s.id}`, from: s.parents[0]!, to: s.id }] } : c));
            if (inScope()) {
              setStreams((st) => streamsReducer(st, { type: 'start', id: s.id, model: s.model }));
              setCursor(s.id);
              setFocusIds([s.parents[0]!, s.id]);
            }
            break;
          }
          case 'delta': {
            const d = data as { text: string };
            if (assistantId && inScope()) setStreams((st) => streamsReducer(st, { type: 'delta', id: assistantId!, text: d.text }));
            break;
          }
          case 'done': {
            const node = data as NodeDto;
            setCanvas((c) => (c && c.slug === sendSlug ? { ...c, nodes: c.nodes.map((n) => (n.id === node.id ? node : n)) } : c));
            if (inScope()) setStreams((st) => streamsReducer(st, { type: 'done', id: node.id }));
            // F2: `streamsReducer` just dropped this id from `streams` — a refetch already in
            // flight when the write landed must still treat it as alive for a few seconds.
            recentRef.current.set(node.id, Date.now());
            break;
          }
          case 'error': {
            const err = data as { message: string; partial: boolean };
            if (assistantId && err.partial === false) {
              // Nothing was ever written for this node (spec §7): it's a ghost — drop it and its
              // incoming edge instead of leaving a dead node on the canvas, and send selection back
              // to the user message so the composer is ready to retry.
              const deadId = assistantId;
              const parentId = assistantParentId;
              setCanvas((c) => (c && c.slug === sendSlug ? { ...c, nodes: c.nodes.filter((n) => n.id !== deadId), edges: c.edges.filter((e) => e.to !== deadId) } : c));
              if (inScope()) {
                setStreams((st) => streamsReducer(st, { type: 'done', id: deadId }));
                // Also drop the dead node from targets/excluded — it just left the canvas, and
                // leaving it selected would throw when flow.ts tries to place the ghost under it.
                setSelection((s) => ({ ...s, cursorId: parentId, targets: s.targets.filter((t) => t !== deadId), excluded: s.excluded.filter((e) => e !== deadId) }));
                setSendError(`Could not get an answer: ${err.message}`);
              }
            } else if (assistantId) {
              if (inScope()) setStreams((st) => streamsReducer(st, { type: 'error', id: assistantId!, message: err.message }));
            } else if (inScope()) {
              setSendError(`Could not send: ${err.message}`);
            }
            break;
          }
        }
      }
      // Stream ended without a `done`/`error` for the assistant node that was started
      // (connection dropped mid-answer): surface it as an error instead of leaving the
      // node pulsing forever.
      if (assistantId && inScope()) {
        setStreams((st) => (st.get(assistantId!)?.status === 'streaming' ? streamsReducer(st, { type: 'error', id: assistantId!, message: 'connection closed before the answer finished' }) : st));
      }
    } catch (e) {
      if (assistantId && inScope()) {
        setStreams((st) => (st.get(assistantId!)?.status === 'streaming' ? streamsReducer(st, { type: 'error', id: assistantId!, message: String(e) }) : st));
      } else if (inScope()) {
        setSendError(`Could not send: ${String(e)}`);
      }
    } finally {
      setSending(false);
    }
  };

  /** Resolves true once the send is accepted (so the composer can clear its text), false otherwise. */
  const send = async (content: string, images: PendingImage[]): Promise<boolean> => {
    if (!slug || !canvas) return false;
    const sendSlug = slug;
    setSending(true);
    setSendError(null);
    try {
      // Belt and braces alongside the selection invariant (targets vanished from the canvas are
      // already dropped from `targets` above; this also guards against any exclusion that ended
      // up overlapping a target, which the server rejects with 400).
      const excludedIds = selection.excluded.filter((id) => !targets.includes(id));
      const res = await sendMessage(sendSlug, { parentIds: targets, excludedIds, content, model, ...(memorySel.length > 0 ? { memoryTopics: memorySel } : {}), ...(images.length > 0 ? { images: images.map(({ mediaType, data }) => ({ mediaType, data })) } : {}) });
      if (!res.ok || !res.body) {
        const msg = ((await res.json().catch(() => ({}))) as { error?: string }).error ?? `${res.status}`;
        setSendError(`Could not send: ${msg}`);
        setSending(false);
        return false;
      }
      setSelection(clearSelection());
      void consume(sendSlug, res.body);
      return true;
    } catch (e) {
      setSendError(`Could not send: ${String(e)}`);
      setSending(false);
      return false;
    }
  };

  /** Spec M17 §3.2: closes the preview and stops a rewrite still streaming (nothing was written). */
  function dropEdit(): void {
    editAbortRef.current?.abort();
    editAbortRef.current = null;
    editRef.current = null;
    setEdit(null);
  }
  const changeMode = (to: ComposerMode): void => {
    if (to === 'reply') dropEdit();
    setMode(to);
  };

  /**
   * Spec M17 §3.2: asks the model to rewrite the cursor's card. With a preview open the request carries it as
   * `draft` (refine); `base` stays the body the edit started from. Resolves true once the stream is accepted.
   */
  const rewrite = async (instruction: string): Promise<boolean> => {
    const node = live?.nodes.find((n) => n.id === selection.cursorId);
    if (!slug || !node) return false;
    const prev = edit?.id === node.id ? edit : null;
    const draft = prev?.status === 'ready' && prev.text.trim() !== '' ? prev.text : undefined;
    const base = prev?.base ?? node.body;
    editAbortRef.current?.abort();
    const ac = new AbortController();
    editAbortRef.current = ac;
    setSendError(null);
    try {
      const res = await rewriteNode(slug, node.id, { instruction, model, ...(draft !== undefined ? { draft } : {}) }, ac.signal);
      if (editAbortRef.current !== ac) return false; // superseded: the cursor moved or the canvas changed meanwhile
      if (!res.ok || !res.body) {
        const msg = ((await res.json().catch(() => ({}))) as { error?: string }).error ?? `${res.status}`;
        setSendError(`Could not rewrite: ${msg}`);
        editAbortRef.current = null;
        return false;
      }
      const started: EditState = { id: node.id, base, text: '', status: 'streaming' };
      editRef.current = started;
      setEdit(started);
      void consumeRewrite(ac, res.body, draft);
      return true;
    } catch (e) {
      if (!ac.signal.aborted) setSendError(`Could not rewrite: ${String(e)}`);
      return false;
    }
  };
  const consumeRewrite = async (ac: AbortController, body: ReadableStream<Uint8Array>, fallback: string | undefined): Promise<void> => {
    const mine = (): boolean => editAbortRef.current === ac;
    const update = (f: (e: EditState) => EditState): void => { if (mine()) setEdit((e) => (e ? f(e) : e)); };
    // Nothing came back on a refine: the previous preview stays, with the error.
    const fail = (message: string): void => update((e) => (e.text === '' && fallback !== undefined ? { ...e, text: fallback, status: 'ready', error: `Could not rewrite: ${message}` } : { ...e, status: 'error', error: `Could not rewrite: ${message}` }));
    let finished = false;
    try {
      for await (const ev of parseSseStream(body)) {
        if (!mine()) return;
        if (ev.event === 'delta') { const d = JSON.parse(ev.data) as { text: string }; update((e) => ({ ...e, text: e.text + d.text })); }
        else if (ev.event === 'done') { const d = JSON.parse(ev.data) as { text: string }; update((e) => ({ ...e, text: d.text, status: 'ready' })); finished = true; }
        else if (ev.event === 'error') { fail((JSON.parse(ev.data) as { message: string }).message); finished = true; }
      }
      if (!finished) fail('connection closed before the rewrite finished');
    } catch (e) {
      if (!ac.signal.aborted) fail(String(e));
    } finally {
      if (mine()) editAbortRef.current = null;
    }
  };
  /** Spec M17 §3.2: writes the preview — against the original body, or (Overwrite) against the version a 409 reported. */
  const acceptEdit = async (overwrite = false): Promise<void> => {
    const cur = edit;
    if (!slug || !cur || cur.status !== 'ready' || cur.text.trim() === '' || editSaving) return;
    if (overwrite !== (cur.conflict !== undefined)) return;
    const same = (e: EditState | null): boolean => e !== null && e.id === cur.id && e.text === cur.text;
    setEditSaving(true);
    try {
      const res = await saveNode(slug, cur.id, cur.text, overwrite ? cur.conflict! : cur.base);
      if (res.ok) {
        nodeSaved(res.node);
        if (same(editRef.current)) { dropEdit(); setMode('reply'); graphRef.current?.focus(); }
      } else setEdit((e) => (same(e) ? { ...e!, conflict: res.current, error: undefined } : e));
    } catch (err) {
      setEdit((e) => (same(e) ? { ...e!, error: `Could not save: ${err instanceof Error ? err.message : String(err)}` } : e));
    } finally {
      setEditSaving(false);
    }
  };
  /** Spec M17 §3.2: the preview text goes to the hand editor, with the same base. */
  const editPreviewByHand = (): void => {
    const cur = edit;
    if (!cur) return;
    dropEdit();
    setMode('reply');
    openHandEdit(cur.id, cur.base, cur.text);
    if (view === 'canvas') setRightCollapsed(false);
  };
  editKeysRef.current = { open: edit !== null, accept: () => void acceptEdit(), discard: dropEdit };

  const live = useMemo(() => (canvas ? applyStreams(canvas, streams) : null), [canvas, streams]);
  const graphLike = useMemo(() => (live ? graphLikeFromDto(live) : null), [live]);
  // Drop targets that no longer exist on the canvas (e.g. a streaming assistant node that
  // died in a fatal-error branch before the selection could be steered away from it) — an
  // absent graph (nothing loaded yet) yields no targets.
  const targets = effectiveTargets(selection).filter((id) => graphLike?.nodes.has(id) ?? false);
  const built = useMemo(() => (graphLike ? buildContext(graphLike, targets, selection.excluded, '') : null), [graphLike, selection]);
  // Everything the graph needs to draw the selection — target numbers, context highlight,
  // exclusions, ghost merge node — computed once per selection change (spec M4 §6.3).
  const marks: FlowMarks = useMemo(() => {
    const set = graphLike ? contextSet(graphLike, targets, selection.excluded) : null;
    const deleting = graphLike && pendingDelete ? deleteSet(graphLike, pendingDelete) : undefined;
    const run = graphLike && compress ? cardsOf(compressionSections(graphLike, compress.ids[compress.source], compress.source === 'subtree' && compress.fold)) : [];
    return { targets, all: set?.all ?? new Set(), excluded: set?.excluded ?? new Set(), language: built?.language ?? 'en', ...(deleting ? { deleting } : {}), ...(run.length > 0 ? { compress: { ids: new Set(run), running: compress!.running } } : {}) };
  }, [graphLike, selection, built, pendingDelete, compress]);
  // Spec M15 §4: by default the memories of the targets' topics (with a body); a new strand starts with none.
  const memories = useMemo(() => canvas?.memories ?? [], [canvas]);
  const memoryFor = (topic: string): MemoryDto | undefined => memories.find((m) => topicKey(m.topic) === topicKey(topic));
  const targetsKey = `${slug ?? ''}:${targets.join(',')}`;
  const defaultMemories = [...new Set(targets.map((id) => live?.nodes.find((n) => n.id === id)?.topics[0]).filter((t): t is string => t !== undefined && t !== '').map((t) => memoryFor(t)).filter((m) => m !== undefined && m.body.trim() !== '').map((m) => m!.topic))];
  const memorySel = (memoryPick?.key === targetsKey ? memoryPick.topics : defaultMemories).filter((t) => memoryFor(t) !== undefined);
  const memorySelKey = memorySel.join('\n');
  const chosenMemories = useMemo(() => memorySel.map((t) => memoryFor(t)!).map((m) => ({ topic: m.topic, body: m.body })), [memorySelKey, memories]); // keyed by content: memorySel is a fresh array each render
  // Spec M17 §3.1: in Edit mode the meter counts the edit prompt (the strand above the card, the card or the preview).
  const editId = mode === 'edit' && graphLike && selection.cursorId !== null && graphLike.nodes.has(selection.cursorId) ? selection.cursorId : null;
  const editDraft = edit && edit.id === editId && edit.status === 'ready' && edit.text.trim() !== '' ? edit.text : undefined;
  const editLanguage = useMemo(() => (graphLike && editId !== null ? buildEditContext(graphLike, editId, '', editDraft).language : null), [graphLike, editId, editDraft]);
  const countTokens = useCallback((text: string): number => (!graphLike ? 0 : editId !== null ? promptTokens(buildEditContext(graphLike, editId, text, editDraft)) : promptTokens(buildContext(graphLike, targets, selection.excluded, text, chosenMemories))), [graphLike, selection, chosenMemories, editId, editDraft]);
  // Spec M6 §7: colour index per topic and the sidebar list, once per canvas fetch; the active topic dims the rest.
  const palette = useMemo(() => (canvas ? topicPalette(canvas) : new Map<string, number>()), [canvas]);
  const topics = useMemo(() => (canvas ? topicList(canvas) : []), [canvas]);
  const topicMarks: TopicMarks = useMemo(() => ({ palette, active: activeTopic }), [palette, activeTopic]);
  const related = useLinks(slug, selection.cursorId, linksVersion);
  const toggleTopic = (name: string): void => {
    if (activeTopic === name) { setActiveTopic(null); return; }
    setActiveTopic(name);
    if (canvas) setFocusIds(nodesOfTopic(canvas, name)); // a deliberate click, not auto-follow
  };

  /** Spec M8 §4.1: optimistic, then persisted; on failure the files decide. */
  const move = (positions: Record<string, { x: number; y: number }>): void => {
    if (!slug) return;
    const moveSlug = slug;
    setCanvas((c) => (c && c.slug === moveSlug ? { ...c, nodes: c.nodes.map((n) => (positions[n.id] ? { ...n, layout: { ...n.layout, ...positions[n.id] } } : n)) } : c));
    moveCards(moveSlug, positions).catch((e: unknown) => {
      setSendError(`Could not move: ${e instanceof Error ? e.message : String(e)}`);
      void fetchCanvas(moveSlug).then((fresh) => setCanvas((c) => (c && c.slug === fresh.slug ? mergeCanvas(c, fresh, streamsRef.current) : c))).catch(() => undefined);
    });
  };

  /**
   * Spec M16 §6: one note per text, side by side from `at` (or each in the next free root slot); the last one
   * becomes the cursor, so the composer targets it straight away. The camera stays: the notes land where the user looks.
   */
  const addNotes = async (texts: string[], at: XYPosition | undefined, skipped: number): Promise<void> => {
    if (!slug) return;
    const nSlug = slug;
    if (at && !(Number.isFinite(at.x) && Number.isFinite(at.y))) at = undefined; // no layout yet (e.g. a hidden pane)
    const tooLong = texts.filter((t) => t.length > MAX_NOTE_CHARS).length;
    const empty = texts.filter((t) => t.trim() === '').length;
    const ok = texts.filter((t) => t.trim() !== '' && t.length <= MAX_NOTE_CHARS);
    const problems = [
      skipped > 0 && `${skipped} file${skipped === 1 ? '' : 's'} skipped — only text files (.md, .txt) become notes`,
      tooLong > 0 && `${tooLong} too long (at most ${MAX_NOTE_CHARS.toLocaleString('en')} characters)`,
      empty > 0 && `${empty} empty`,
    ].filter((p): p is string => typeof p === 'string');
    let last: string | null = null;
    try {
      for (const [i, text] of ok.entries()) {
        const node = await createNote(nSlug, text, at ? { x: at.x + i * (NODE_WIDTH + NODE_GAP), y: at.y } : undefined);
        recentRef.current.set(node.id, Date.now()); // F2: a racing refetch must not drop it
        setCanvas((c) => (c && c.slug === nSlug && !c.nodes.some((n) => n.id === node.id) ? { ...c, nodes: [...c.nodes, node] } : c));
        last = node.id;
      }
      setSendError(problems.length > 0 ? `Notes: ${problems.join('; ')}.` : null);
    } catch (e) {
      setSendError(`Could not create the note: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (last !== null && currentSlugRef.current === nSlug) setSelection({ ...clearSelection(), cursorId: last });
  };
  const closeNoteDialog = (): void => { setNoteDraft(null); graphRef.current?.focus(); };
  const saveNoteDialog = (): void => {
    if (noteDraft === null || noteDraft.trim() === '') return;
    const at = view === 'canvas' ? (centreRef.current?.() ?? undefined) : undefined;
    void addNotes([noteDraft], at, 0);
    closeNoteDialog();
  };
  const nodeSaved = (n: NodeDto): void => setCanvas((c) => (c ? { ...c, nodes: c.nodes.map((x) => (x.id === n.id ? n : x)) } : c));
  /** Spec M17 §2: open the hand editor on a card (it becomes the cursor), with `initial` as its text. */
  const openHandEdit = (id: string, base?: string, initial?: string): void => {
    const node = live?.nodes.find((n) => n.id === id);
    if (!node) return;
    setCursor(id);
    setHandEdit((h) => ({ id, base: base ?? node.body, initial: initial ?? node.body, seq: (h?.seq ?? 0) + 1 }));
  };
  const closeHandEdit = (): void => { setHandEdit(null); graphRef.current?.focus(); };

  const pendingSet = graphLike && pendingDelete ? deleteSet(graphLike, pendingDelete) : null;
  const pendingTurns = graphLike && pendingDelete ? new Set(pendingDelete.map((id) => turnOf(graphLike, id)[0])).size : 0;
  const closeDelete = (): void => { setPendingDelete(null); graphRef.current?.focus(); };
  /** Spec M8 §5.4: the server expands and splices; afterwards the canvas is refetched and the selection pruned. */
  const confirmDelete = async (): Promise<void> => {
    if (!slug || !graphLike || !pendingDelete || !pendingSet) return;
    const delSlug = slug;
    const ids = pendingDelete;
    const cursor = survivorAbove(graphLike, ids[0]!, pendingSet);
    // Decided now: a vault-changed refetch may already have cleared a vanished cursor by the time the answer lands.
    const cursorGone = selection.cursorId !== null && pendingSet.has(selection.cursorId);
    closeDelete();
    try {
      const { deleted } = await deleteTurns(delSlug, ids);
      const gone = new Set(deleted);
      const fresh = await fetchCanvas(delSlug);
      setCanvas((c) => (c && c.slug === fresh.slug ? mergeCanvas(c, fresh, streamsRef.current) : c));
      if (currentSlugRef.current !== delSlug) return;
      setSelection((s) => ({ cursorId: cursorGone || (s.cursorId !== null && gone.has(s.cursorId)) ? cursor : s.cursorId, targets: s.targets.filter((t) => !gone.has(t)), excluded: s.excluded.filter((x) => !gone.has(x)) }));
      setMoveSel(NO_IDS);
      setSendError(null);
    } catch (e) {
      setSendError(`Could not delete: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  // Spec M11 §9: the button shows when either choice has something to do; the dialog opens on the one that does.
  // Spec M11 §11: what each source would compress — the context (as marked "in context"), the ⌘-selection, everything below the cursor.
  const sourceIds = (): Record<CompressSource, string[]> => ({
    context: [...marks.all].filter((id) => !marks.excluded.has(id)),
    selection: [...moveSel],
    subtree: graphLike && selection.cursorId ? subtreeIds(graphLike, selection.cursorId) : [],
  });
  const sectionsFor = (ids: Record<CompressSource, string[]>, source: CompressSource, fold: boolean): Section[] => (graphLike ? compressionSections(graphLike, ids[source], source === 'subtree' && fold) : []);
  const available = graphLike && compress === null ? sourceIds() : null;
  const canCompress = available !== null && COMPRESS_SOURCES.some((src) => sectionsFor(available, src, true).length > 0);
  const openCompress = (): void => {
    const ids = sourceIds();
    // an explicit ⌘-selection wins; otherwise the context, then everything below
    const order: CompressSource[] = moveSel.size > 0 ? ['selection', 'context', 'subtree'] : COMPRESS_SOURCES;
    const source = order.find((src) => sectionsFor(ids, src, true).length > 0) ?? 'context';
    setPendingDelete(null);
    setCompress({ ids, source, fold: false, running: false });
  };
  const pending = graphLike && compress && !compress.running ? sectionsFor(compress.ids, compress.source, compress.fold) : null;
  const compressTurns = pending?.reduce((n, s) => n + s.turns.length, 0) ?? 0;
  const pendingMax = pending?.reduce((n, s) => n + maxCompressedTurns(s.turns.length), 0) ?? 0;
  const pendingFolds = pending?.flatMap((s) => s.folds) ?? [];
  const closeCompress = (): void => { setCompress(null); graphRef.current?.focus(); };
  /** Spec M11 §6: the server asks the model and rewrites; afterwards the cursor follows its replacement. */
  const confirmCompress = async (): Promise<void> => {
    if (!slug || !compress || !model) return;
    const cSlug = slug;
    const ids = compress.ids[compress.source];
    const fold = compress.source === 'subtree' && compress.fold;
    setCompress({ ...compress, running: true });
    graphRef.current?.focus();
    try {
      const { removed, replacement } = await compressStrand(cSlug, ids, model, fold);
      const gone = new Set(removed);
      const fresh = await fetchCanvas(cSlug);
      setCanvas((c) => (c && c.slug === fresh.slug ? mergeCanvas(c, fresh, streamsRef.current) : c));
      if (currentSlugRef.current !== cSlug) return;
      setSelection((s) => ({ cursorId: s.cursorId !== null ? (replacement[s.cursorId] ?? s.cursorId) : null, targets: s.targets.filter((t) => !gone.has(t)), excluded: s.excluded.filter((x) => !gone.has(x)) }));
      setMoveSel(NO_IDS);
      setSendError(null);
    } catch (e) {
      setSendError(`Could not compress: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setCompress(null);
    }
  };

  if (error) return <main className="empty">Could not reach the chatmind server: {error}</main>;
  if (canvases === null) return <main className="empty">Loading…</main>;

  const activeModel = models.find((m) => m.id === model);
  const budget = activeModel ? budgetFor(activeModel.contextTokens) : 0;
  const selected = live?.nodes.find((n) => n.id === selection.cursorId) ?? null;
  // Spec M15 §5: the memory of the selected card's topic, or of the active topic when no card is selected.
  const memoryTopic = selected ? selected.topics[0] : (activeTopic ?? undefined);
  const saveMemoryLocally = (m: MemoryDto): void => setCanvas((c) => (c ? { ...c, memories: [...(c.memories ?? []).filter((x) => topicKey(x.topic) !== topicKey(m.topic)), m] } : c));
  const memoryPanel = slug && memoryTopic ? (
    <MemoryEditor key={`${slug}:${topicKey(memoryTopic)}`} slug={slug} topic={memoryFor(memoryTopic)?.topic ?? memoryTopic} memory={memoryFor(memoryTopic)} onSaved={saveMemoryLocally} style={palette.has(memoryTopic) ? { ['--topic' as string]: `var(--topic-${palette.get(memoryTopic)})` } : undefined} />
  ) : undefined;
  const selectedStream = selection.cursorId ? streams.get(selection.cursorId) : undefined;
  const editNode = edit ? live?.nodes.find((n) => n.id === edit.id) : undefined;
  const handEditor = slug && handEdit && selected?.id === handEdit.id ? (
    <NodeEditor key={`${handEdit.id}:${handEdit.seq}`} slug={slug} id={handEdit.id} base={handEdit.base} initial={handEdit.initial} onSaved={(n) => { nodeSaved(n); closeHandEdit(); }} onCancel={closeHandEdit} />
  ) : null;
  const targetNodes = live ? targets.map((id) => live.nodes.find((n) => n.id === id)).filter((n): n is NodeDto => n !== undefined) : [];

  return (
    <div className={`layout${leftCollapsed ? ' no-left' : ''}${rightCollapsed ? ' no-right' : ''}`} style={{ ["--panel-w" as string]: `${panel.width}px` }}>
      <button type="button" className="edge-toggle left" aria-label={leftCollapsed ? 'Show canvas list' : 'Hide canvas list'} aria-expanded={!leftCollapsed} title={leftCollapsed ? 'Show canvas list' : 'Hide canvas list'} onClick={(e) => { e.currentTarget.blur(); toggleLeft(); }}>{leftCollapsed ? '›' : '‹'}</button>
      <button type="button" className="edge-toggle right" aria-label={rightCollapsed ? 'Show panel' : 'Hide panel'} aria-expanded={!rightCollapsed} title={rightCollapsed ? 'Show panel' : 'Hide panel'} onClick={(e) => { e.currentTarget.blur(); toggleRight(); }}>{rightCollapsed ? '‹' : '›'}</button>
      <nav className="sidebar" aria-label="Canvases">
        <h1>chatmind</h1>
        <ul>
          {canvases.map((c) => (
            <li key={c.slug}>
              <button type="button" className={c.slug === slug ? 'active' : ''} onClick={() => openCanvas(c.slug)}>
                {c.slug} <span className="count">{c.nodeCount}</span>
              </button>
            </li>
          ))}
        </ul>
        {newName === null ? (
          <button type="button" className="new-canvas" onClick={() => { setNewName(''); setNewCanvasError(null); }}>+ New canvas</button>
        ) : (
          <form className="new-canvas-form" onSubmit={async (e) => {
            e.preventDefault();
            const trimmed = newName.trim();
            if (trimmed === '') return;
            setNewCanvasError(null);
            try {
              const created = await createCanvas(trimmed);
              await reloadCanvases();
              setNewName(null);
              openCanvas(created.slug);
            } catch (err) {
              setNewCanvasError(`Could not create canvas: ${String(err)}`);
            }
          }}>
            <div className="composer-row">
              <input autoFocus aria-label="Canvas name" value={newName} placeholder="Canvas name" onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape') { setNewName(null); setNewCanvasError(null); } }} />
              <button type="submit" disabled={newName.trim() === ''}>Create</button>
            </div>
            {newCanvasError && <p className="composer-error" role="alert">{newCanvasError}</p>}
          </form>
        )}
        {topics.length > 0 && (
          <section className="topics">
            <h2>Topics</h2>
            <ul aria-label="Topics">
              {topics.map((t) => (
                <li key={t.name}>
                  {/* Chromium/Edge/Arc focus a clicked button; left focused, it's in SKIP_TAGS above and
                      would swallow the very next Escape instead of letting it reach the graph (spec §7). */}
                  <button type="button" aria-pressed={activeTopic === t.name} style={{ ['--topic' as string]: `var(--topic-${t.index})` }} onClick={(e) => { e.currentTarget.blur(); toggleTopic(t.name); }}>
                    <i className="dot" aria-hidden="true" />{t.name}<span className="count">{t.count}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
        {canvases.length === 0 && <p className="hint">No canvases yet — create one above.</p>}
      </nav>
      <main className="graph" ref={graphRef} tabIndex={-1}>
        {canvasError ? (
          <p className="empty" role="alert">Could not load canvas "{slug}": {canvasError}</p>
        ) : live ? (
          <>
            {live.repairs.length > 0 && (
              <div className="banner" role="status">{live.repairs.length} repair{live.repairs.length === 1 ? '' : 's'} pending — run <code>pnpm cli check</code></div>
            )}
            <div className="view-bar">
              <button type="button" className="new-note" title="Place a note on the canvas — or paste text (⌘V) or drop a text file onto it" onClick={(e) => { e.currentTarget.blur(); setNoteDraft(''); }}>+ Note</button>
              <div className="view-switch" role="tablist" aria-label="View">
                {(['canvas', 'chat'] as const).map((v) => (
                  <button key={v} type="button" role="tab" aria-selected={view === v} title={`${v === 'canvas' ? 'Canvas' : 'Chat'} (V)`} onClick={(e) => { e.currentTarget.blur(); if (view !== v) switchView(v); }}>{v === 'canvas' ? 'Canvas' : 'Chat'}</button>
                ))}
              </div>
            </div>
            {noteDraft !== null && (
              <div className="note-dialog" role="dialog" aria-label="New note">
                <p>A note lies on the canvas and goes to the model only when you ask about it.</p>
                <textarea
                  aria-label="Note text"
                  autoFocus
                  rows={10}
                  value={noteDraft}
                  placeholder="Paste or write text…"
                  onChange={(e) => setNoteDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') { e.stopPropagation(); closeNoteDialog(); }
                    else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); saveNoteDialog(); }
                  }}
                />
                <div className="memory-actions">
                  <button type="button" className="confirm" disabled={noteDraft.trim() === ''} title="Place note (⌘Enter)" onClick={saveNoteDialog}>Place note</button>
                  <button type="button" className="btn" onClick={closeNoteDialog}>Cancel</button>
                </div>
              </div>
            )}
            {view === 'chat' ? (
              <ChatView canvas={live} streams={streams} marks={marks} palette={palette} cursorId={selection.cursorId} preferred={preferred} onCursor={setCursor} onToggle={(id) => setSelection((s) => toggleParticipation(graphLike!, s, id))} onEdit={(id) => openHandEdit(id)} editor={handEditor && handEdit ? { id: handEdit.id, node: handEditor } : null} />
            ) : (
            <GraphView canvas={live} streams={streams} marks={marks} topics={topicMarks} cursorId={selection.cursorId} focusIds={focusIds} links={related} moveSelection={moveSel} onMoveSelection={(f) => setMoveSel(f)} onMove={move} onCursor={setCursor} onOpen={openInChat} onToggle={(id) => setSelection((s) => toggleParticipation(graphLike!, s, id))} onClear={() => { setSelection(clearSelection()); setMoveSel(NO_IDS); }} onNotes={(texts, at, skipped) => void addNotes(texts, at, skipped)} centreRef={centreRef} />
            )}
            {pendingSet && (
              <div className="delete-dialog" role="alertdialog" aria-label="Delete" onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); closeDelete(); } }}>
                <p>Delete {pendingTurns} turn{pendingTurns === 1 ? '' : 's'} ({pendingSet.size} card{pendingSet.size === 1 ? '' : 's'})? The files go to <code>.trash/</code>.</p>
                <button type="button" className="danger" autoFocus onClick={() => void confirmDelete()}>Delete</button>
                <button type="button" onClick={closeDelete}>Cancel</button>
              </div>
            )}
            {compress && pending && (
              <div className="delete-dialog compress" role="alertdialog" aria-label="Compress" onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); closeCompress(); } }}>
                <div className="compress-options">
                  {COMPRESS_SOURCES.map((src) => (
                    <label key={src} className={sectionsFor(compress.ids, src, true).length === 0 ? 'unavailable' : undefined}>
                      <input type="radio" name="compress-source" checked={compress.source === src} disabled={sectionsFor(compress.ids, src, true).length === 0} onChange={() => setCompress({ ...compress, source: src })} /> {SOURCE_LABELS[src]}
                    </label>
                  ))}
                  {compress.source === 'subtree' && <label><input type="checkbox" checked={compress.fold} onChange={(e) => setCompress({ ...compress, fold: e.target.checked })} /> Fold short dead-end branches</label>}
                </div>
                <p>
                  {pending.length === 0
                    ? 'Nothing to compress here.'
                    : <>Compress {pending.length > 1 ? `${pending.length} sections, ` : ''}{compressTurns} turn{compressTurns === 1 ? '' : 's'} into at most {pendingMax}{pendingFolds.length > 0 ? `, folding ${pendingFolds.length} side branch${pendingFolds.length === 1 ? '' : 'es'} (${pendingFolds.flat().length} turn${pendingFolds.flat().length === 1 ? '' : 's'})` : ''}, with {activeModel?.label ?? model}? The originals go to <code>.trash/</code>.</>}
                </p>
                <button type="button" className="confirm" autoFocus disabled={pending.length === 0} onClick={() => void confirmCompress()}>Compress</button>
                <button type="button" onClick={closeCompress}>Cancel</button>
              </div>
            )}
            {compress?.running && <div className="banner" role="status">Compressing…</div>}
            <span hidden data-testid="canvas-loaded">{live.nodes.length} nodes</span>
          </>
        ) : slug ? (
          <p className="empty">Loading canvas…</p>
        ) : (
          <p className="empty">Create a canvas to start.</p>
        )}
        {slug && edit && editNode && (
          <EditPreview key={edit.id} edit={edit} title={nodeTitle(editNode)} slug={slug} saving={editSaving} onAccept={() => void acceptEdit()} onOverwrite={() => void acceptEdit(true)} onDiscard={dropEdit} onHand={editPreviewByHand} />
        )}
        {slug && (
          <Composer targets={targetNodes} language={editLanguage ?? marks.language} promptTokens={countTokens} budget={budget} models={models} model={model} onModelChange={chooseModel} onSend={mode === 'edit' ? (content) => rewrite(content) : send} sending={mode === 'edit' ? edit?.status === 'streaming' || editSaving : sending} errorLine={sendError} onEscape={() => { textareaRef.current?.blur(); graphRef.current?.focus(); }} textareaRef={textareaRef} memories={memories} memorySel={memorySel} onMemorySel={(topics) => setMemoryPick({ key: targetsKey, topics })} mode={mode} onModeChange={changeMode} editTarget={selected && selectedStream?.status !== 'streaming' ? selected : null} onAccept={edit?.status === 'ready' && edit.conflict === undefined ? () => void acceptEdit() : undefined} onDiscard={edit ? dropEdit : undefined} />
        )}
      </main>
      <div className="resizer" role="separator" aria-orientation="vertical" aria-label="Resize panel" aria-valuenow={panel.width} onPointerDown={panel.onPointerDown} />
      <NodePanel node={selected} streaming={selectedStream?.status === 'streaming'} streamError={selectedStream?.status === 'error' ? (selectedStream.error ?? 'error') : null} palette={palette} related={related} canvasSlug={slug} onRelated={openRelated} onDelete={(id) => setPendingDelete([id])} canCompress={canCompress} onCompress={openCompress} hideBody={view === 'chat'} memory={memoryPanel} onEdit={(id) => openHandEdit(id)} onSaveTitle={slug ? async (id, summary, base) => { const res = await saveSummary(slug, id, summary, base); if (res.ok) nodeSaved(res.node); return res; } : undefined} editor={view === 'chat' ? undefined : (handEditor ?? undefined)} />
    </div>
  );
}
