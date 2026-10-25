import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { act, StrictMode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildEditContext, graphLikeFromDto, promptTokens } from '@chatmind/core/graph';
import { App } from '../src/App';

const canvases = [
  { slug: 'masterarbeit', nodeCount: 2 },
  { slug: 'python-lernen', nodeCount: 1 },
  { slug: 'zweige', nodeCount: 3 },
];
const masterarbeit = {
  slug: 'masterarbeit',
  nodes: [
    { id: '01JQ8F2H7T4WKD9M3XBQNAAAAA', role: 'user', parents: [], created: '2026-03-14T10:42:03Z', summary: 'Ursprungsfrage', topics: ['Evaluation'], body: 'Wie evaluiere ich?', layout: { x: 0, y: 0, width: 400, height: 200 } },
    { id: '01JQ8F3K2M9XZP4V7NBHRCAAAA', role: 'assistant', model: 'claude-sonnet-4-6', parents: ['01JQ8F2H7T4WKD9M3XBQNAAAAA'], created: '2026-03-14T10:43:03Z', summary: 'Zentroid', topics: ['Zentroide'], body: 'Zentroid statt Re-Clustering.', layout: { x: 0, y: 280, width: 400, height: 200 } },
  ],
  edges: [{ id: 'e-a-b', from: '01JQ8F2H7T4WKD9M3XBQNAAAAA', to: '01JQ8F3K2M9XZP4V7NBHRCAAAA' }],
  repairs: [],
};
const python = { slug: 'python-lernen', nodes: [], edges: [], repairs: [] };
// A(user) → B(assistant) ; A → C(user): two branches under A
const zweige = {
  slug: 'zweige',
  nodes: [
    { id: '01JQ8F2H7T4WKD9M3XBQNAAAAA', role: 'user', parents: [], created: 'c', summary: 'Ursprungsfrage', topics: [], body: 'Wie evaluiere ich?', layout: { x: 0, y: 0, width: 400, height: 200 } },
    { id: '01JQ8F3K2M9XZP4V7NBHRCAAAA', role: 'assistant', model: 'claude-sonnet-4-6', parents: ['01JQ8F2H7T4WKD9M3XBQNAAAAA'], created: 'c', summary: 'Zentroid', topics: [], body: 'Zentroid statt Re-Clustering.', layout: { x: 0, y: 280, width: 400, height: 200 } },
    { id: '01JQ8F4Q5R6S7T8V9W0X1Y2ZAA', role: 'user', parents: ['01JQ8F2H7T4WKD9M3XBQNAAAAA'], created: 'c', summary: 'Inhalt', topics: [], body: 'Inhaltliches Brainstorming.', layout: { x: 480, y: 280, width: 400, height: 200 } },
  ],
  edges: [{ id: 'e-a-b', from: '01JQ8F2H7T4WKD9M3XBQNAAAAA', to: '01JQ8F3K2M9XZP4V7NBHRCAAAA' }, { id: 'e-a-c', from: '01JQ8F2H7T4WKD9M3XBQNAAAAA', to: '01JQ8F4Q5R6S7T8V9W0X1Y2ZAA' }],
  repairs: [],
};
const models = [{ id: 'claude-opus-5', provider: 'anthropic', label: 'Claude Opus 5', available: true, contextTokens: 200_000 }];

const SSE_BODY = `event: user-node
data: {"id":"01JQ8F6000000000000000000A","role":"user","parents":["01JQ8F3K2M9XZP4V7NBHRCAAAA"],"created":"c","summary":"","topics":[],"body":"Und weiter?","layout":{"x":0,"y":560,"width":400,"height":200}}

event: assistant-start
data: {"id":"01JQ8F6000000000000000000B","model":"claude-opus-5","layout":{"x":0,"y":840,"width":400,"height":200},"parents":["01JQ8F6000000000000000000A"],"created":"c"}

event: delta
data: {"text":"Hel"}

event: delta
data: {"text":"lo"}

event: done
data: {"id":"01JQ8F6000000000000000000B","role":"assistant","model":"claude-opus-5","parents":["01JQ8F6000000000000000000A"],"created":"c","summary":"","topics":[],"body":"Hello","layout":{"x":0,"y":840,"width":400,"height":200}}

`;

let extraCanvases: typeof canvases = [];
let deleteCalls: { ids: string[] }[] = [];
let compressCalls: { ids: string[]; model: string; fold: boolean }[] = [];
let extraCanvasBodies: Record<string, unknown> = {};
let noteCalls: { body: string; at?: { x: number; y: number } }[] = [];
// Spec M17: queued answers for PUT /nodes/:id (a 409 conflict, say); empty → the saved node.
let putQueue: Response[] = [];
// Spec M17 §3: the rewrite requests and the SSE bodies they answer with (queued; default: one rewrite).
let rewriteCalls: { url: string; body: { instruction: string; model: string; draft?: string } }[] = [];
let rewriteQueue: string[] = [];
const rewriteSse = (...parts: string[]): string => `${parts.map((t) => `event: delta\ndata: ${JSON.stringify({ text: t })}\n\n`).join('')}event: done\ndata: ${JSON.stringify({ text: parts.join('').trim() })}\n\n`;

function sseResponse(): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(SSE_BODY));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

// Connection cut mid-answer: assistant-start + one delta, then the stream just ends (no
// `done`, no `error`).
const BROKEN_SSE_BODY = `event: user-node
data: {"id":"01JQ8F6200000000000000000A","role":"user","parents":["01JQ8F3K2M9XZP4V7NBHRCAAAA"],"created":"c","summary":"","topics":[],"body":"Und weiter?","layout":{"x":0,"y":560,"width":400,"height":200}}

event: assistant-start
data: {"id":"01JQ8F6200000000000000000B","model":"claude-opus-5","layout":{"x":0,"y":840,"width":400,"height":200},"parents":["01JQ8F6200000000000000000A"],"created":"c"}

event: delta
data: {"text":"Hel"}

`;

function brokenSseResponse(): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(BROKEN_SSE_BODY));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

// The model returns no text at all: user-node + assistant-start, then a terminal `error`
// with `partial: false` (nothing was ever written for the assistant node).
const FATAL_ERROR_SSE_BODY = `event: user-node
data: {"id":"01JQ8F6400000000000000000A","role":"user","parents":["01JQ8F3K2M9XZP4V7NBHRCAAAA"],"created":"c","summary":"","topics":[],"body":"Und weiter?","layout":{"x":0,"y":560,"width":400,"height":200}}

event: assistant-start
data: {"id":"01JQ8F6400000000000000000B","model":"claude-opus-5","layout":{"x":0,"y":840,"width":400,"height":200},"parents":["01JQ8F6400000000000000000A"],"created":"c"}

event: error
data: {"message":"boom","partial":false}

`;

function fatalErrorSseResponse(): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(FATAL_ERROR_SSE_BODY));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

// A merge send on the `zweige` canvas: the user node carries both targets as parents.
const MERGE_SSE_BODY = `event: user-node
data: {"id":"01JQ8F6500000000000000000A","role":"user","parents":["01JQ8F3K2M9XZP4V7NBHRCAAAA","01JQ8F4Q5R6S7T8V9W0X1Y2ZAA"],"created":"c","summary":"","topics":[],"body":"Combine.","layout":{"x":0,"y":560,"width":400,"height":200}}

event: assistant-start
data: {"id":"01JQ8F6500000000000000000B","model":"claude-opus-5","layout":{"x":0,"y":840,"width":400,"height":200},"parents":["01JQ8F6500000000000000000A"],"created":"c"}

event: done
data: {"id":"01JQ8F6500000000000000000B","role":"assistant","model":"claude-opus-5","parents":["01JQ8F6500000000000000000A"],"created":"c","summary":"","topics":[],"body":"Merged.","layout":{"x":0,"y":840,"width":400,"height":200}}

`;

function mergeSseResponse(): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(MERGE_SSE_BODY));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

const B_ID = '01JQ8F3K2M9XZP4V7NBHRCAAAA';
const C_ID = '01JQ8F4Q5R6S7T8V9W0X1Y2ZAA';
// Spec M7: masterarbeit's answer links into `zweige`; in `zweige` the answer links to its cousin.
const LINKS: Record<string, unknown[]> = {
  [`masterarbeit/${B_ID}`]: [{ id: C_ID, canvas: 'zweige', summary: 'Inhalt drüben', similarity: 0.7, score: 0.5 }],
  [`zweige/${B_ID}`]: [{ id: C_ID, canvas: 'zweige', summary: 'Inhalt hier', similarity: 0.8, score: 0.6 }],
};

function stubFetch(): void {
  extraCanvases = [];
  extraCanvasBodies = {};
  deleteCalls = [];
  compressCalls = [];
  noteCalls = [];
  putQueue = [];
  rewriteCalls = [];
  rewriteQueue = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/models') return new Response(JSON.stringify(models), { status: 200, headers: { 'content-type': 'application/json' } });
    if (url === '/api/canvases' && (!init || init.method === undefined)) {
      return new Response(JSON.stringify([...canvases, ...extraCanvases]), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url === '/api/canvases' && init?.method === 'POST') {
      const { name } = JSON.parse(init.body as string) as { name: string };
      const slug = name.toLowerCase();
      extraCanvases = [...extraCanvases, { slug, nodeCount: 0 }];
      extraCanvasBodies[slug] = { slug, nodes: [], edges: [], repairs: [] };
      return new Response(JSON.stringify({ slug, nodeCount: 0 }), { status: 201, headers: { 'content-type': 'application/json' } });
    }
    if (url.endsWith('/delete')) {
      deleteCalls.push(JSON.parse(init!.body as string) as { ids: string[] });
      return new Response(JSON.stringify({ deleted: [B_ID], reparented: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.endsWith('/compress')) {
      compressCalls.push(JSON.parse(init!.body as string) as { ids: string[]; model: string; fold: boolean });
      return new Response(JSON.stringify({ removed: [], added: [], replacement: {} }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.endsWith('/layout')) return new Response(JSON.stringify({ ignored: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
    if (url.endsWith('/memories')) {
      const { topic, body } = JSON.parse(init!.body as string) as { topic: string; body: string };
      return new Response(JSON.stringify({ topic, body, covered: 1 }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.endsWith('/notes')) {
      const { body, at } = JSON.parse(init!.body as string) as { body: string; at?: { x: number; y: number } };
      const id = `01JQ8F7000000000000000${String(noteCalls.length).padStart(4, '0')}`;
      noteCalls.push({ body, ...(at ? { at } : {}) });
      return new Response(JSON.stringify({ id, role: 'note', parents: [], created: 'c', summary: '', topics: [], body, layout: { x: at?.x ?? 900, y: at?.y ?? 0, width: 400, height: 200 } }), { status: 201, headers: { 'content-type': 'application/json' } });
    }
    if (url.includes('/nodes/') && init?.method === 'PUT') {
      const queued = putQueue.shift();
      if (queued) return queued;
      const id = url.split('/').pop()!;
      const { body } = JSON.parse(init.body as string) as { body: string };
      const known = [masterarbeit, zweige, ...Object.values(extraCanvasBodies)].flatMap((c) => (c as { nodes: { id: string }[] }).nodes).find((n) => n.id === id);
      return new Response(JSON.stringify({ ...(known ?? { id, role: 'note', parents: [], created: 'c', summary: '', topics: [], layout: { x: 900, y: 0, width: 400, height: 200 } }), body }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.endsWith('/rewrite')) {
      rewriteCalls.push({ url, body: JSON.parse(init!.body as string) as { instruction: string; model: string; draft?: string } });
      const text = rewriteQueue.shift() ?? rewriteSse('Wie ', 'messe ich?');
      return new Response(new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode(text)); c.close(); } }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    if (url.endsWith('/messages')) return url.includes('/zweige/') ? mergeSseResponse() : sseResponse();
    if (url.endsWith('/links')) {
      const [, , , linkSlug, , id] = url.split('/') as string[];
      const links = LINKS[`${linkSlug}/${id}`] ?? [];
      return new Response(JSON.stringify({ from: id, links }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    const slugFromUrl = url.split('/').pop() as string;
    const body = url === '/api/canvases' ? canvases : extraCanvasBodies[slugFromUrl] ?? (url.endsWith('/masterarbeit') ? masterarbeit : url.endsWith('/python-lernen') ? python : url.endsWith('/zweige') ? zweige : null);
    return new Response(JSON.stringify(body), { status: body ? 200 : 404, headers: { 'content-type': 'application/json' } });
  }));
}

afterEach(() => {
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/'); // spec M7 §6: the app writes the URL; never leak it into the next test
});

describe('App', () => {
  it('lists canvases and loads the first one', async () => {
    stubFetch();
    render(<App />);
    expect(await screen.findByRole('button', { name: /masterarbeit/ })).toHaveClass('active');
    expect(screen.getByRole('button', { name: /python-lernen/ })).not.toHaveClass('active');
    await waitFor(() => expect(screen.getByTestId('canvas-loaded')).toHaveTextContent('2 nodes'));
  });

  it('switches canvases on click', async () => {
    stubFetch();
    render(<App />);
    await screen.findByTestId('canvas-loaded');
    await userEvent.click(screen.getByRole('button', { name: /python-lernen/ }));
    await waitFor(() => expect(screen.getByTestId('canvas-loaded')).toHaveTextContent('0 nodes'));
  });

  it('shows an empty state when there are no canvases', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('[]', { status: 200 })));
    render(<App />);
    expect(await screen.findByText(/No canvases yet/)).toBeInTheDocument();
  });

  it('renders the graph and opens a node in the panel on click', async () => {
    stubFetch();
    render(<App />);
    await screen.findByTestId('canvas-loaded');
    expect(document.querySelector('.react-flow')).not.toBeNull();
    expect(screen.getByText('Select a node to read it.')).toBeInTheDocument();
    // fireEvent.click dispatches a single 'click' (enough for React Flow's onNodeClick,
    // which is a plain React onClick handler). userEvent.click additionally dispatches a
    // real mousedown/mouseup sequence, which bubbles into the React Flow pane and its
    // underlying d3-zoom pane listener — that listener calls dragDisable(event.view) and
    // crashes under jsdom because synthetic MouseEvents there carry `view: null`.
    fireEvent.click(await screen.findByText('Ursprungsfrage'));
    expect(await screen.findByRole('heading', { level: 2, name: 'Ursprungsfrage' })).toBeInTheDocument();
    // Scoped to the panel: the graph node's own preview also shows this body text
    // (MessageNode renders a preview of the body), so an unscoped getByText matches twice.
    expect(within(screen.getByRole('complementary')).getByText('Wie evaluiere ich?')).toBeInTheDocument();
  });

  it('keeps the sidebar when a single canvas fails to load', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/canvases') return new Response(JSON.stringify(canvases), { status: 200 });
      if (url === '/api/models') return new Response(JSON.stringify(models), { status: 200 });
      return new Response('boom', { status: 500 });
    }));
    render(<App />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load canvas "masterarbeit"');
    expect(screen.getByRole('button', { name: /python-lernen/ })).toBeInTheDocument();
  });

  it('sends from the composer and shows the streamed answer', async () => {
    stubFetch();
    render(<App />);
    await screen.findByTestId('canvas-loaded');
    fireEvent.click(await screen.findByText('Zentroid'));           // select node B as target
    const box = screen.getByRole('textbox');
    await userEvent.type(box, 'Und weiter?');
    fireEvent.keyDown(box, { key: 'Enter', metaKey: true });
    await waitFor(() => expect(screen.getByTestId('canvas-loaded')).toHaveTextContent('4 nodes'));
    expect(await screen.findByRole('heading', { level: 2, name: 'Hello' })).toBeInTheDocument(); // assistant selected → panel shows it
    const sent = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.find((c) => String(c[0]).endsWith('/messages'));
    expect(JSON.parse((sent![1] as RequestInit).body as string)).toEqual({ parentIds: ['01JQ8F3K2M9XZP4V7NBHRCAAAA'], excludedIds: [], content: 'Und weiter?', model: 'claude-opus-5' });
  });

  it('navigates with arrow keys and focuses the composer on Enter', async () => {
    stubFetch();
    render(<App />);
    await screen.findByTestId('canvas-loaded');
    fireEvent.keyDown(window, { key: 'ArrowDown' });               // first root (A)
    expect(await screen.findByText(/Replying to:/)).toHaveTextContent('Ursprungsfrage');
    fireEvent.keyDown(window, { key: 'ArrowDown' });               // child B
    expect(screen.getByText(/Replying to:/)).toHaveTextContent('Zentroid');
    fireEvent.keyDown(window, { key: 'Enter' });
    expect(screen.getByRole('textbox')).toHaveFocus();
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' });
    expect(screen.getByRole('textbox')).not.toHaveFocus();
  });

  it('creates a new canvas from the sidebar', async () => {
    stubFetch(); // extends: POST /api/canvases → 201 {slug,nodeCount:0}; GET /api/canvases then includes it; GET /api/canvases/<slug> → empty canvas
    render(<App />);
    await screen.findByTestId('canvas-loaded');
    await userEvent.click(screen.getByRole('button', { name: '+ New canvas' }));
    await userEvent.type(screen.getByLabelText('Canvas name'), 'Neu');
    await userEvent.click(screen.getByRole('button', { name: 'Create' }));
    expect(await screen.findByRole('button', { name: /^neu/ })).toHaveClass('active');
  });

  // C1: typed text must survive a failed send.
  it('keeps the typed text and shows an error when sending fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/models') return new Response(JSON.stringify(models), { status: 200, headers: { 'content-type': 'application/json' } });
      if (url === '/api/canvases') return new Response(JSON.stringify(canvases), { status: 200, headers: { 'content-type': 'application/json' } });
      if (url.endsWith('/messages')) return new Response(JSON.stringify({ error: 'boom' }), { status: 500, headers: { 'content-type': 'application/json' } });
      if (url.endsWith('/masterarbeit')) return new Response(JSON.stringify(masterarbeit), { status: 200, headers: { 'content-type': 'application/json' } });
      if (url.endsWith('/python-lernen')) return new Response(JSON.stringify(python), { status: 200, headers: { 'content-type': 'application/json' } });
      return new Response('not found', { status: 404 });
    }));
    render(<App />);
    await screen.findByTestId('canvas-loaded');
    const box = screen.getByRole('textbox');
    await userEvent.type(box, 'Und weiter?');
    fireEvent.keyDown(box, { key: 'Enter', metaKey: true });
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not send: boom');
    expect(box).toHaveValue('Und weiter?');
  });

  // I1: the global keyboard model must not hijack Enter/arrows away from sidebar controls.
  it('does not hijack Enter on a focused sidebar button', async () => {
    stubFetch();
    render(<App />);
    await screen.findByTestId('canvas-loaded');
    const newCanvasButton = screen.getByRole('button', { name: '+ New canvas' });
    newCanvasButton.focus();
    await userEvent.keyboard('{Enter}'); // native activation of the focused button
    // Scoped by placeholder: activating "+ New canvas" also renders the "Canvas name"
    // input, which — being a plain <input> — is itself a `textbox`-role element.
    expect(screen.getByPlaceholderText(/Write a message/)).not.toHaveFocus();
    expect(screen.getByLabelText('Canvas name')).toBeInTheDocument();
  });

  // I2: a stream that ends without `done`/`error` must not leave the node streaming forever.
  it('marks the node as errored when the stream ends without done', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/models') return new Response(JSON.stringify(models), { status: 200, headers: { 'content-type': 'application/json' } });
      if (url === '/api/canvases') return new Response(JSON.stringify(canvases), { status: 200, headers: { 'content-type': 'application/json' } });
      if (url.endsWith('/messages')) return brokenSseResponse();
      if (url.endsWith('/masterarbeit')) return new Response(JSON.stringify(masterarbeit), { status: 200, headers: { 'content-type': 'application/json' } });
      if (url.endsWith('/python-lernen')) return new Response(JSON.stringify(python), { status: 200, headers: { 'content-type': 'application/json' } });
      return new Response('not found', { status: 404 });
    }));
    render(<App />);
    await screen.findByTestId('canvas-loaded');
    const box = screen.getByRole('textbox');
    await userEvent.type(box, 'Und weiter?');
    fireEvent.keyDown(box, { key: 'Enter', metaKey: true });
    // assistant-start auto-selects the new node, so the panel shows its stream error once
    // the connection ends without `done`.
    expect(await screen.findByRole('alert')).toHaveTextContent('connection closed before the answer finished');
  });

  // Finding #2: a fatal error (partial: false) must remove the ghost assistant node and its
  // edge, drop its stream entry, and re-select the user node instead of leaving a dead node.
  it('removes the ghost assistant node on a fatal error and re-selects the user node', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/models') return new Response(JSON.stringify(models), { status: 200, headers: { 'content-type': 'application/json' } });
      if (url === '/api/canvases') return new Response(JSON.stringify(canvases), { status: 200, headers: { 'content-type': 'application/json' } });
      if (url.endsWith('/messages')) return fatalErrorSseResponse();
      if (url.endsWith('/masterarbeit')) return new Response(JSON.stringify(masterarbeit), { status: 200, headers: { 'content-type': 'application/json' } });
      if (url.endsWith('/python-lernen')) return new Response(JSON.stringify(python), { status: 200, headers: { 'content-type': 'application/json' } });
      return new Response('not found', { status: 404 });
    }));
    render(<App />);
    await screen.findByTestId('canvas-loaded');
    const box = screen.getByRole('textbox');
    await userEvent.type(box, 'Und weiter?');
    fireEvent.keyDown(box, { key: 'Enter', metaKey: true });
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not get an answer: boom');
    // back to the original 2 nodes + the new user node only — the assistant ghost is gone
    await waitFor(() => expect(screen.getByTestId('canvas-loaded')).toHaveTextContent('3 nodes'));
    expect(await screen.findByText(/Replying to:/)).toHaveTextContent('Und weiter?');
  });

  // I4: a failed canvas creation must be visible, even with zero canvases, and keep the typed name.
  it('shows an error and keeps the name when creating a canvas fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/models') return new Response(JSON.stringify(models), { status: 200, headers: { 'content-type': 'application/json' } });
      if (url === '/api/canvases' && init?.method === 'POST') {
        return new Response(JSON.stringify({ error: 'canvas exists' }), { status: 409, headers: { 'content-type': 'application/json' } });
      }
      if (url === '/api/canvases') return new Response(JSON.stringify(canvases), { status: 200, headers: { 'content-type': 'application/json' } });
      if (url.endsWith('/masterarbeit')) return new Response(JSON.stringify(masterarbeit), { status: 200, headers: { 'content-type': 'application/json' } });
      if (url.endsWith('/python-lernen')) return new Response(JSON.stringify(python), { status: 200, headers: { 'content-type': 'application/json' } });
      return new Response('not found', { status: 404 });
    }));
    render(<App />);
    await screen.findByTestId('canvas-loaded');
    await userEvent.click(screen.getByRole('button', { name: '+ New canvas' }));
    await userEvent.type(screen.getByLabelText('Canvas name'), 'Masterarbeit');
    await userEvent.click(screen.getByRole('button', { name: 'Create' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('canvas exists');
    expect(screen.getByLabelText('Canvas name')).toHaveValue('Masterarbeit');
  });

  // I5: a slow send from one canvas must not leak nodes/selection/streams into another
  // canvas the user has since switched to.
  it('does not let a slow send from one canvas leak into another', async () => {
    let release: () => void = () => {};
    const encoder = new TextEncoder();
    const slowStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(
          'event: user-node\ndata: {"id":"01JQ8F6300000000000000000A","role":"user","parents":["01JQ8F3K2M9XZP4V7NBHRCAAAA"],"created":"c","summary":"","topics":[],"body":"Und weiter?","layout":{"x":0,"y":560,"width":400,"height":200}}\n\n',
        ));
        const wait = new Promise<void>((resolve) => { release = resolve; });
        void wait.then(() => {
          controller.enqueue(encoder.encode(
            'event: assistant-start\ndata: {"id":"01JQ8F6300000000000000000B","model":"claude-opus-5","layout":{"x":0,"y":840,"width":400,"height":200},"parents":["01JQ8F6300000000000000000A"],"created":"c"}\n\nevent: done\ndata: {"id":"01JQ8F6300000000000000000B","role":"assistant","model":"claude-opus-5","parents":["01JQ8F6300000000000000000A"],"created":"c","summary":"","topics":[],"body":"Hello","layout":{"x":0,"y":840,"width":400,"height":200}}\n\n',
          ));
          controller.close();
        });
      },
    });
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/models') return new Response(JSON.stringify(models), { status: 200, headers: { 'content-type': 'application/json' } });
      if (url === '/api/canvases') return new Response(JSON.stringify(canvases), { status: 200, headers: { 'content-type': 'application/json' } });
      if (url.endsWith('/messages')) return new Response(slowStream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
      if (url.endsWith('/masterarbeit')) return new Response(JSON.stringify(masterarbeit), { status: 200, headers: { 'content-type': 'application/json' } });
      if (url.endsWith('/python-lernen')) return new Response(JSON.stringify(python), { status: 200, headers: { 'content-type': 'application/json' } });
      return new Response('not found', { status: 404 });
    }));
    render(<App />);
    await screen.findByTestId('canvas-loaded');
    const box = screen.getByRole('textbox');
    await userEvent.type(box, 'Und weiter?');
    fireEvent.keyDown(box, { key: 'Enter', metaKey: true });
    // the user-node event lands immediately, before the switch
    await waitFor(() => expect(screen.getByTestId('canvas-loaded')).toHaveTextContent('3 nodes'));
    await userEvent.click(screen.getByRole('button', { name: /python-lernen/ }));
    await waitFor(() => expect(screen.getByTestId('canvas-loaded')).toHaveTextContent('0 nodes'));
    await act(async () => {
      release();
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(screen.getByTestId('canvas-loaded')).toHaveTextContent('0 nodes');
  });

  async function openZweige(): Promise<void> {
    stubFetch();
    render(<App />);
    await screen.findByTestId('canvas-loaded');
    await userEvent.click(screen.getByRole('button', { name: /zweige/ }));
    await waitFor(() => expect(screen.getByTestId('canvas-loaded')).toHaveTextContent('3 nodes'));
  }
  const B = '01JQ8F3K2M9XZP4V7NBHRCAAAA';
  const C = '01JQ8F4Q5R6S7T8V9W0X1Y2ZAA';

  it('Space on two sibling nodes builds a merge: ghost, "Merging" chip, meter, and the request carries parentIds', async () => {
    await openZweige();
    fireEvent.keyDown(window, { key: 'ArrowDown' });   // A
    fireEvent.keyDown(window, { key: 'ArrowDown' });   // B
    fireEvent.keyDown(window, { key: ' ' });           // target B
    expect(screen.getByText(/Replying to:/)).toHaveTextContent('Zentroid');
    fireEvent.keyDown(window, { key: 'ArrowRight' });  // cursor C — targets unchanged
    expect(screen.getByText(/Replying to:/)).toHaveTextContent('Zentroid');
    fireEvent.keyDown(window, { key: ' ' });           // target C
    expect(screen.getByText(/Merging:/)).toHaveTextContent('Merging: Zentroid, Inhalt');
    // the fixture bodies are German ("Wie evaluiere ich?") → ghost text and badges are German
    expect(await screen.findByText('Merge · 2 Zweige')).toBeInTheDocument();
    expect(screen.getAllByText('im Kontext')).toHaveLength(1); // A only — targets B and C carry number badges instead
    expect(Number(screen.getByRole('meter').getAttribute('aria-valuenow'))).toBeGreaterThan(0);
    const box = screen.getByRole('textbox');
    await userEvent.type(box, 'Combine.');
    fireEvent.keyDown(box, { key: 'Enter' });
    const sent = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.find((c) => String(c[0]).endsWith('/messages'));
    expect(JSON.parse((sent![1] as RequestInit).body as string)).toEqual({ parentIds: [B, C], excludedIds: [], content: 'Combine.', model: 'claude-opus-5' });
    await waitFor(() => expect(screen.queryByText('Merge · 2 Zweige')).toBeNull()); // selection cleared on send
  });

  it('Space on a highlighted ancestor excludes it; the badge click re-includes it; Esc clears everything', async () => {
    await openZweige();
    fireEvent.click(await screen.findByText('Zentroid'));   // cursor B (implicit target)
    fireEvent.keyDown(window, { key: ' ' });                // make B an explicit target — otherwise moving the cursor moves the target
    fireEvent.keyDown(window, { key: 'ArrowUp' });          // cursor A, target stays B
    const before = Number(screen.getByRole('meter').getAttribute('aria-valuenow'));
    // The badge label follows the language of the prompt actually sent: A ("Wie evaluiere ich?")
    // is the only German body, so with A excluded the label flips to "in context".
    const badge = /im Kontext|in context/;
    fireEvent.keyDown(window, { key: ' ' });                // A is in B's context → exclude
    expect(screen.getByRole('button', { name: badge })).toHaveClass('excluded');
    expect(Number(screen.getByRole('meter').getAttribute('aria-valuenow'))).toBeLessThan(before);
    fireEvent.click(screen.getByRole('button', { name: badge }));  // badge click → re-include
    expect(screen.getByRole('button', { name: /im Kontext/ })).not.toHaveClass('excluded');
    expect(document.activeElement).toHaveClass('react-flow__node'); // focus handed to the node, not left on the button, so Esc/Space still reach the graph
    expect(Number(screen.getByRole('meter').getAttribute('aria-valuenow'))).toBe(before);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.getByText('New root message')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: badge })).toBeNull();
  });

  // The merge stream: a user node with two parents lands, the answer streams below it and
  // becomes the cursor. (The per-parent edges App derives for it are not observable here —
  // React Flow only renders edges once nodes are measured, which the stubbed ResizeObserver
  // in test/setup.ts never triggers.)
  it('streams the answer to a merge send below the two-parent user node', async () => {
    await openZweige();
    fireEvent.click(await screen.findByText('Zentroid'));
    fireEvent.click(screen.getByText('Inhalt'), { shiftKey: true });
    const box = screen.getByRole('textbox');
    await userEvent.type(box, 'Combine.');
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(screen.getByTestId('canvas-loaded')).toHaveTextContent('5 nodes'));
    expect(await screen.findByRole('heading', { level: 2, name: 'Merged.' })).toBeInTheDocument();
    expect(screen.getByText(/Replying to:/)).toHaveTextContent('Merged.');
  });

  it('shift-click adds a target with the mouse', async () => {
    await openZweige();
    fireEvent.click(await screen.findByText('Zentroid'));
    fireEvent.click(screen.getByText('Inhalt'), { shiftKey: true });
    expect(screen.getByText(/Merging:/)).toHaveTextContent('Merging: Zentroid, Inhalt');
  });

  it('blocks sending over budget', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/models') return new Response(JSON.stringify([{ ...models[0], contextTokens: 16_010 }]), { status: 200, headers: { 'content-type': 'application/json' } });
      if (url === '/api/canvases') return new Response(JSON.stringify(canvases), { status: 200, headers: { 'content-type': 'application/json' } });
      if (url.endsWith('/masterarbeit')) return new Response(JSON.stringify(masterarbeit), { status: 200, headers: { 'content-type': 'application/json' } });
      return new Response('not found', { status: 404 });
    }));
    render(<App />);
    await screen.findByTestId('canvas-loaded');
    fireEvent.click(await screen.findByText('Zentroid'));
    expect(screen.getByRole('meter')).toHaveClass('over');
    expect(screen.getByRole('alert')).toHaveTextContent('Über Budget'); // German fixture bodies
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  });
});

describe('live vault updates (spec M5 §7)', () => {
  it('refetches the current canvas on vault-changed and shows the new summary without losing the cursor', async () => {
    stubFetch();
    const instances: { listeners: Map<string, (e: MessageEvent) => void> }[] = [];
    class FakeES {
      listeners = new Map<string, (e: MessageEvent) => void>();
      constructor() { instances.push(this); }
      addEventListener(type: string, l: (e: MessageEvent) => void) { this.listeners.set(type, l); }
      close() {}
    }
    (globalThis as { EventSource?: unknown }).EventSource = FakeES;
    try {
      render(<App />);
      await screen.findByText('Ursprungsfrage');
      // select the first card so we can check the cursor survives (fireEvent.click, not
      // userEvent.click — see the comment above on the node-click test: a real mousedown/
      // mouseup sequence crashes d3-zoom under jsdom because synthetic events lack `view`)
      fireEvent.click(screen.getByText('Ursprungsfrage'));
      // the next fetch of the canvas returns a new summary on node 2
      extraCanvasBodies = { masterarbeit: { ...masterarbeit, nodes: [masterarbeit.nodes[0], { ...masterarbeit.nodes[1], summary: 'Neuer Titel' }] } };
      await act(async () => {
        instances[0]!.listeners.get('vault-changed')!({ data: '{"slugs":["masterarbeit"]}' } as MessageEvent);
      });
      await screen.findByText('Neuer Titel');
      // Scoped to the card's title (a plain getByText would also match the NodePanel heading
      // and the composer's "Replying to:" line, which show the same text once selected).
      // The card root (MessageNode.tsx) is `.message-node`, carrying `selected` itself —
      // not just `.react-flow__node`, React Flow's own wrapper, though both track the same
      // controlled `selected` flag.
      expect(screen.getByText('Ursprungsfrage', { selector: 'p.summary' }).closest('.message-node')).toHaveClass('selected');
    } finally {
      delete (globalThis as { EventSource?: unknown }).EventSource;
      extraCanvasBodies = {};
    }
  });

  // F2: a refetch that started before the assistant's write landed can resolve a canvas that's
  // still missing the just-written assistant node — by the time it resolves, `done` has already
  // fired and dropped the id from `streams`, so the old merge (keyed only on `streams`) would
  // drop the node and null the cursor. `recentRef` (fed by `done`) must protect it for a few
  // seconds regardless.
  it('keeps a just-finished assistant node and the cursor when a stale refetch races the write', async () => {
    const instances: { listeners: Map<string, (e: MessageEvent) => void> }[] = [];
    class FakeES {
      listeners = new Map<string, (e: MessageEvent) => void>();
      constructor() { instances.push(this); }
      addEventListener(type: string, l: (e: MessageEvent) => void) { this.listeners.set(type, l); }
      close() {}
    }
    (globalThis as { EventSource?: unknown }).EventSource = FakeES;
    // Mirrors SSE_BODY's ids: the user-node and the assistant `done` delivers. `staleCanvas`
    // stands in for a vault read that started before the assistant file was written — it has
    // the new user node (a plain edit, unrelated to the race) but not the assistant answer.
    const userNodeId = '01JQ8F6000000000000000000A';
    const assistantId = '01JQ8F6000000000000000000B';
    const staleCanvas = {
      ...masterarbeit,
      nodes: [...masterarbeit.nodes, { id: userNodeId, role: 'user', parents: [masterarbeit.nodes[1]!.id], created: 'c', summary: '', topics: [], body: 'Und weiter?', layout: { x: 0, y: 560, width: 400, height: 200 } }],
      edges: [...masterarbeit.edges, { id: `e-${masterarbeit.nodes[1]!.id}-${userNodeId}`, from: masterarbeit.nodes[1]!.id, to: userNodeId }],
    };
    let afterSend = false;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/models') return new Response(JSON.stringify(models), { status: 200, headers: { 'content-type': 'application/json' } });
      if (url === '/api/canvases') return new Response(JSON.stringify(canvases), { status: 200, headers: { 'content-type': 'application/json' } });
      if (url.endsWith('/messages')) { afterSend = true; return sseResponse(); }
      if (url.endsWith('/masterarbeit')) return new Response(JSON.stringify(afterSend ? staleCanvas : masterarbeit), { status: 200, headers: { 'content-type': 'application/json' } });
      if (url.endsWith('/python-lernen')) return new Response(JSON.stringify(python), { status: 200, headers: { 'content-type': 'application/json' } });
      return new Response('not found', { status: 404 });
    }));
    try {
      render(<App />);
      await screen.findByTestId('canvas-loaded');
      fireEvent.click(await screen.findByText('Zentroid'));
      const box = screen.getByRole('textbox');
      await userEvent.type(box, 'Und weiter?');
      fireEvent.keyDown(box, { key: 'Enter', metaKey: true });
      await waitFor(() => expect(screen.getByTestId('canvas-loaded')).toHaveTextContent('4 nodes'));
      expect(await screen.findByRole('heading', { level: 2, name: 'Hello' })).toBeInTheDocument();
      // a stale refetch races the just-finished write: the mocked /masterarbeit fetch below
      // returns the vault as it was read before the assistant node existed there
      await act(async () => {
        instances[0]!.listeners.get('vault-changed')!({ data: '{"slugs":["masterarbeit"]}' } as MessageEvent);
      });
      await waitFor(() => expect(screen.getByTestId('canvas-loaded')).toHaveTextContent('4 nodes'));
      expect(screen.getByRole('heading', { level: 2, name: 'Hello' })).toBeInTheDocument(); // cursor still on the assistant node
    } finally {
      delete (globalThis as { EventSource?: unknown }).EventSource;
    }
  });

  // The current canvas can 404 on refetch (deleted in Obsidian between the event firing and
  // the refetch landing). Promise.allSettled must keep the list reload independent of that
  // failure, or the deleted canvas lingers in the sidebar forever.
  it('still reloads the list when the current canvas 404s on refetch', async () => {
    const instances: { listeners: Map<string, (e: MessageEvent) => void> }[] = [];
    class FakeES {
      listeners = new Map<string, (e: MessageEvent) => void>();
      constructor() { instances.push(this); }
      addEventListener(type: string, l: (e: MessageEvent) => void) { this.listeners.set(type, l); }
      close() {}
    }
    (globalThis as { EventSource?: unknown }).EventSource = FakeES;
    let deleted = false;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/models') return new Response(JSON.stringify(models), { status: 200, headers: { 'content-type': 'application/json' } });
      if (url === '/api/canvases') {
        const list = deleted ? canvases.filter((c) => c.slug !== 'masterarbeit') : canvases;
        return new Response(JSON.stringify(list), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url.endsWith('/masterarbeit')) {
        if (deleted) return new Response('not found', { status: 404 });
        return new Response(JSON.stringify(masterarbeit), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url.endsWith('/python-lernen')) return new Response(JSON.stringify(python), { status: 200, headers: { 'content-type': 'application/json' } });
      if (url.endsWith('/zweige')) return new Response(JSON.stringify(zweige), { status: 200, headers: { 'content-type': 'application/json' } });
      return new Response('not found', { status: 404 });
    }));
    try {
      render(<App />);
      await screen.findByText('Ursprungsfrage');
      deleted = true; // the file vanished from the vault just before the event lands
      await act(async () => {
        instances[0]!.listeners.get('vault-changed')!({ data: '{"slugs":["masterarbeit"]}' } as MessageEvent);
      });
      // list reload must not be lost even though the canvas fetch 404s
      await waitFor(() => expect(screen.queryByRole('button', { name: /masterarbeit/ })).toBeNull());
      expect(screen.getByRole('button', { name: /python-lernen/ })).toBeInTheDocument();
    } finally {
      delete (globalThis as { EventSource?: unknown }).EventSource;
    }
  });
});

describe('topics (spec M6 §7)', () => {
  it('lists topics with counts, highlights on click, fits the camera, toggles off on a second click', async () => {
    stubFetch();
    render(<App />);
    await screen.findByTestId('canvas-loaded');
    const list = screen.getByRole('list', { name: 'Topics' });
    const items = within(list).getAllByRole('button');
    expect(items.map((b) => b.textContent)).toEqual(['Evaluation1', 'Zentroide1']);
    fireEvent.click(items[0]!);
    expect(items[0]).toHaveAttribute('aria-pressed', 'true');
    const cards = document.querySelectorAll('.message-node');
    expect(cards[0]).not.toHaveClass('dimmed');
    expect(cards[1]).toHaveClass('dimmed');
    fireEvent.click(items[0]!);
    expect(items[0]).toHaveAttribute('aria-pressed', 'false');
    expect(document.querySelector('.message-node.dimmed')).toBeNull();
  });

  it('Esc clears the active topic first and the selection only on the second press', async () => {
    stubFetch();
    render(<App />);
    await screen.findByTestId('canvas-loaded');
    fireEvent.click(await screen.findByText('Ursprungsfrage'));
    expect(await screen.findByRole('heading', { level: 2, name: 'Ursprungsfrage' })).toBeInTheDocument();
    // userEvent (unlike fireEvent) focuses the clicked button, the way a real click does in
    // Chromium/Edge/Arc — this is what exposes the bug where a focused topic button swallows
    // the very next Escape (it's in SKIP_TAGS, so the window keydown handler returns early).
    await userEvent.click(within(screen.getByRole('list', { name: 'Topics' })).getByText('Zentroide'));
    expect(document.querySelector('.message-node.dimmed')).not.toBeNull();
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(document.querySelector('.message-node.dimmed')).toBeNull();
    expect(screen.getByRole('heading', { level: 2, name: 'Ursprungsfrage' })).toBeInTheDocument(); // selection kept
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(screen.getByText('Select a node to read it.')).toBeInTheDocument();
  });

  it('hides the list on a canvas without topics and resets the active topic on canvas change', async () => {
    stubFetch();
    render(<App />);
    await screen.findByTestId('canvas-loaded');
    fireEvent.click(within(screen.getByRole('list', { name: 'Topics' })).getByText('Evaluation'));
    await userEvent.click(screen.getByRole('button', { name: /zweige/ }));
    await screen.findByText('3 nodes');
    expect(screen.queryByRole('list', { name: 'Topics' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: /masterarbeit/ }));
    await screen.findByText('2 nodes');
    expect(document.querySelector('.message-node.dimmed')).toBeNull();
    expect(within(screen.getByRole('list', { name: 'Topics' })).getByText('Evaluation').closest('button')).toHaveAttribute('aria-pressed', 'false');
  });
});

describe('semantic links (spec M7 §6)', () => {
  // 150 ms debounce + fetch: the default 1 s findBy timeout ran out once under a loaded parallel run.
  const related = () => screen.findByRole('region', { name: 'Related' }, { timeout: 3000 });

  it('shows the related list and a link edge; a same-canvas entry becomes the cursor', async () => {
    stubFetch();
    window.history.replaceState(null, '', '/?canvas=zweige');
    render(<App />);
    await screen.findByText('3 nodes');
    fireEvent.click(screen.getByText('Zentroid'));
    const section = await related();
    expect(section).toHaveTextContent('Inhalt hier0.60');
    expect(section.textContent).not.toContain('zweige'); // same canvas: no canvas line
    // The dashed edge itself is covered in flow.test.ts — React Flow draws no edges under jsdom (nodes are never measured).
    fireEvent.click(within(section).getByText('Inhalt hier'));
    expect(await screen.findByRole('heading', { level: 2, name: 'Inhalt' })).toBeInTheDocument();
    expect(window.location.search).toBe(`?canvas=zweige&node=${C_ID}`);
  });

  it('jumps into another canvas, and Back returns to where the jump started', async () => {
    stubFetch();
    render(<App />);
    await screen.findByText('2 nodes');
    fireEvent.click(screen.getByText('Zentroid'));
    const section = await related();
    expect(section).toHaveTextContent('Inhalt drüben0.50zweige');
    fireEvent.click(within(section).getByText('Inhalt drüben'));
    await screen.findByText('3 nodes');
    expect(await screen.findByRole('heading', { level: 2, name: 'Inhalt' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /zweige/ })).toHaveClass('active');
    expect(window.location.search).toBe(`?canvas=zweige&node=${C_ID}`);
    await act(async () => {
      window.history.back();
      await new Promise((r) => setTimeout(r, 50));
    });
    await screen.findByText('2 nodes');
    expect(await screen.findByRole('heading', { level: 2, name: 'Zentroid' })).toBeInTheDocument();
    expect(window.location.search).toBe(`?canvas=masterarbeit&node=${B_ID}`);
  });

  it('opens the node from the URL under StrictMode too (the dev build runs effects twice)', async () => {
    stubFetch();
    // Staggered answers, as over a real network: the first run's canvas opens (and rewrites the URL) before the second run's list arrives.
    const inner = globalThis.fetch;
    let calls = 0;
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      await new Promise((r) => setTimeout(r, 30 * calls++));
      return inner(url, init);
    });
    window.history.replaceState(null, '', `/?canvas=zweige&node=${C_ID}&view=chat`);
    render(<StrictMode><App /></StrictMode>);
    expect(await screen.findByRole('heading', { level: 2, name: 'Inhalt' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Chat' })).toHaveAttribute('aria-selected', 'true');
  });

  it('opens canvas and node from the URL, and a sidebar switch is a history entry too', async () => {
    stubFetch();
    window.history.replaceState(null, '', `/?canvas=zweige&node=${C_ID}`);
    render(<App />);
    expect(await screen.findByRole('heading', { level: 2, name: 'Inhalt' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /masterarbeit/ }));
    await screen.findByText('2 nodes');
    expect(window.location.search).toBe('?canvas=masterarbeit');
    await act(async () => {
      window.history.back();
      await new Promise((r) => setTimeout(r, 50));
    });
    await screen.findByText('3 nodes');
    expect(await screen.findByRole('heading', { level: 2, name: 'Inhalt' })).toBeInTheDocument();
  });
});

describe('move and delete (spec M8)', () => {
  async function openZweige(): Promise<void> {
    stubFetch();
    render(<App />);
    await screen.findByTestId('canvas-loaded');
    await userEvent.click(screen.getByRole('button', { name: /zweige/ }));
    await waitFor(() => expect(screen.getByTestId('canvas-loaded')).toHaveTextContent('3 nodes'));
  }
  it('Delete asks for the turn, Esc cancels, the button deletes and the cursor lands on the survivor above', async () => {
    await openZweige();
    fireEvent.click(await screen.findByText('Zentroid'));   // cursor B (answer of A)
    fireEvent.keyDown(window, { key: 'Delete' });
    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toHaveTextContent('Delete 1 turn (2 cards)?'); // B takes its question A along
    expect(screen.getByText('Zentroid', { selector: 'p.summary' }).closest('.message-node')).toHaveClass('deleting');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.getByText('Zentroid', { selector: 'p.summary' }).closest('.message-node')).not.toHaveClass('deleting');
    fireEvent.keyDown(window, { key: 'Backspace' });
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(deleteCalls).toEqual([{ ids: [B_ID] }]));
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('Cmd-click builds a move selection that Delete uses and Esc clears first; Shift still means merge', async () => {
    await openZweige();
    fireEvent.click(await screen.findByText('Zentroid'));
    fireEvent.click(screen.getByText('Inhalt'), { metaKey: true });
    const inhalt = screen.getByText('Inhalt', { selector: 'p.summary' }).closest('.message-node');
    expect(inhalt).toHaveClass('move-selected');
    expect(inhalt).not.toHaveClass('selected');              // the cursor did not move
    expect(screen.queryByText(/Merging:/)).toBeNull();        // and no merge target was added
    fireEvent.keyDown(window, { key: 'Delete' });
    expect(screen.getByRole('alertdialog')).toHaveTextContent('Delete 1 turn (1 card)?');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(inhalt).not.toHaveClass('move-selected');
    expect(screen.getByText('Zentroid', { selector: 'p.summary' }).closest('.message-node')).toHaveClass('selected'); // cursor survives the first Esc
  });

  it('the panel offers "Delete turn"', async () => {
    await openZweige();
    fireEvent.click(await screen.findByText('Inhalt'));
    fireEvent.click(screen.getByRole('button', { name: 'Delete turn' }));
    expect(screen.getByRole('alertdialog')).toHaveTextContent('Delete 1 turn (1 card)?');
  });
});

describe('chat view (spec M9)', () => {
  const A_ID = '01JQ8F2H7T4WKD9M3XBQNAAAAA';
  async function openZweige(): Promise<void> {
    stubFetch();
    render(<App />);
    await screen.findByTestId('canvas-loaded');
    await userEvent.click(screen.getByRole('button', { name: /zweige/ }));
    await waitFor(() => expect(screen.getByTestId('canvas-loaded')).toHaveTextContent('3 nodes'));
  }
  const strand = (): string[] => [...document.querySelectorAll('.chat-view > .chat-column .chat-turn > .chat-msg')].map((e) => (e as HTMLElement).dataset.id!);
  const cursor = (): string | undefined => (document.querySelector('.chat-msg.cursor') as HTMLElement | null)?.dataset.id;

  it('V and the tabs switch views; the URL carries the view; the panel drops the body', async () => {
    await openZweige();
    fireEvent.click(await screen.findByText('Zentroid'));
    fireEvent.keyDown(window, { key: 'v' });
    expect(screen.getByRole('tab', { name: 'Chat' })).toHaveAttribute('aria-selected', 'true');
    expect(strand()).toEqual([A_ID, B_ID]);
    expect(cursor()).toBe(B_ID);
    expect(window.location.search).toContain('view=chat');
    expect(within(screen.getByRole('complementary')).queryByText('Zentroid statt Re-Clustering.')).toBeNull();
    expect(within(screen.getByRole('complementary')).getByRole('heading', { level: 2, name: 'Zentroid' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Canvas' }));
    expect(document.querySelector('.react-flow')).not.toBeNull();
    expect(window.location.search).not.toContain('view=');
  });

  it('double-clicking a card opens it in the chat and folds the right bar', async () => {
    try { localStorage.clear(); } catch { /* ignore */ }
    await openZweige();
    fireEvent.doubleClick(await screen.findByText('Zentroid'));
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Chat' })).toHaveAttribute('aria-selected', 'true'));
    expect(strand()).toEqual([A_ID, B_ID]);
    expect(cursor()).toBe(B_ID);
    expect(document.querySelector('.layout')).toHaveClass('no-right');
    fireEvent.click(screen.getByRole('button', { name: 'Show panel' }));
    expect(document.querySelector('.layout')).not.toHaveClass('no-right');
  });

  it('the fork switcher and ←/→ change branch; ↑ keeps the branch below, ↓ follows it', async () => {
    await openZweige();
    fireEvent.click(await screen.findByText('Zentroid'));
    fireEvent.keyDown(window, { key: 'v' });
    expect(screen.getByRole('group', { name: 'Branches' })).toHaveTextContent('1/2');
    fireEvent.click(screen.getByRole('button', { name: 'Next branch' }));
    expect(strand()).toEqual([A_ID, C_ID]);
    expect(cursor()).toBe(C_ID);
    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    expect(cursor()).toBe(B_ID);
    fireEvent.keyDown(window, { key: 'ArrowUp' });
    expect(cursor()).toBe(A_ID);
    expect(strand()).toEqual([A_ID, B_ID]); // remembered, although C is newer
    expect(screen.getByRole('note')).toHaveTextContent('Replying here starts a new branch');
    fireEvent.keyDown(window, { key: 'ArrowDown' });
    expect(cursor()).toBe(B_ID);
  });

  it('without a cursor it lists the threads; V is ignored while typing', async () => {
    await openZweige();
    fireEvent.keyDown(window, { key: 'v' });
    fireEvent.click(within(screen.getByRole('list', { name: 'Threads' })).getByRole('button', { name: /Ursprungsfrage/ }));
    expect(cursor()).toBe(A_ID);
    expect(strand()).toEqual([A_ID, C_ID]); // the newest child
    const box = screen.getByRole('textbox');
    box.focus();
    fireEvent.keyDown(box, { key: 'v' });
    expect(screen.getByRole('tab', { name: 'Chat' })).toHaveAttribute('aria-selected', 'true');
  });

  it('a merge shows the merged-in branch as a collapsed block before the merge message', async () => {
    await openZweige();
    fireEvent.click(await screen.findByText('Zentroid'));
    fireEvent.click(screen.getByText('Inhalt'), { shiftKey: true });
    const box = screen.getByRole('textbox');
    await userEvent.type(box, 'Combine.');
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(screen.getByTestId('canvas-loaded')).toHaveTextContent('5 nodes'));
    (document.activeElement as HTMLElement | null)?.blur();
    fireEvent.keyDown(window, { key: 'v' });
    expect(strand()).toEqual([A_ID, B_ID, '01JQ8F6500000000000000000A', '01JQ8F6500000000000000000B']);
    const block = document.querySelector('details.merge-block')!;
    expect(block).not.toHaveAttribute('open');
    expect(block.querySelector('summary')).toHaveTextContent('Merged branch · Inhalt · 1 message');
  });
});

describe('compress a strand (spec M11 §6)', () => {
  const K = ['01JQ8F7000000000000000000A', '01JQ8F7000000000000000000B', '01JQ8F7000000000000000000C', '01JQ8F7000000000000000000D'];
  const kette = {
    slug: 'kette',
    nodes: K.map((id, i) => ({ id, role: i % 2 === 0 ? 'user' : 'assistant', parents: i === 0 ? [] : [K[i - 1]], created: 'c', summary: `Karte ${i + 1}`, topics: [], body: `Text ${i + 1}`, layout: { x: 0, y: i * 280, width: 400, height: 200 } })),
    edges: [],
    repairs: [],
  };
  it('compresses what is in context: the turns up to the cursor, its question taking its answer along', async () => {
    stubFetch();
    extraCanvases = [{ slug: 'kette', nodeCount: 4 }];
    extraCanvasBodies = { kette };
    render(<App />);
    await screen.findByTestId('canvas-loaded');
    await userEvent.click(screen.getByRole('button', { name: /kette/ }));
    await waitFor(() => expect(screen.getByTestId('canvas-loaded')).toHaveTextContent('4 nodes'));
    fireEvent.click(await screen.findByText('Karte 3'));
    fireEvent.click(screen.getByRole('button', { name: 'Compress' }));
    expect(within(screen.getByRole('alertdialog')).getByRole('radio', { name: 'In context' })).toBeChecked();
    expect(screen.getByRole('alertdialog')).toHaveTextContent('Compress 2 turns into at most 1, with Claude Opus 5?');
    expect(screen.getByText('Karte 4', { selector: 'p.summary' }).closest('.message-node')).toHaveClass('compress-pending');
    expect(screen.getByText('Karte 1', { selector: 'p.summary' }).closest('.message-node')).toHaveClass('compress-pending');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('alertdialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Compress' }));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Compress' }));
    await waitFor(() => expect(compressCalls.map((c) => ({ ...c, ids: [...c.ids].sort() }))).toEqual([{ ids: [K[0], K[1], K[2]], model: 'claude-opus-5', fold: false }]));
    await waitFor(() => expect(screen.queryByText('Compressing…')).toBeNull());
  });

  it('on a fork the dialog opens on "Everything below"; the checkbox folds the dead end', async () => {
    const id = (c: string) => `01JQ8F80000000000000000${c}`;
    const n = (c: string, role: string, parent: string | null, summary: string) => ({ id: id(c), role, parents: parent ? [id(parent)] : [], created: 'c', summary, topics: [], body: summary, layout: { x: 0, y: 0, width: 400, height: 200 } });
    const gabel = {
      slug: 'gabel',
      nodes: [n('00A', 'user', null, 'Start'), n('00B', 'assistant', '00A', 'Gabel'), n('00C', 'user', '00B', 'Weg 1'), n('00D', 'assistant', '00C', 'Weg 1 A'), n('00E', 'user', '00D', 'Weg 2'), n('00F', 'assistant', '00E', 'Weg 2 A'), n('00G', 'user', '00B', 'Sackgasse'), n('00H', 'assistant', '00G', 'Sackgasse A')],
      edges: [],
      repairs: [],
    };
    stubFetch();
    extraCanvases = [{ slug: 'gabel', nodeCount: 8 }];
    extraCanvasBodies = { gabel };
    render(<App />);
    await screen.findByTestId('canvas-loaded');
    await userEvent.click(screen.getByRole('button', { name: /gabel/ }));
    await waitFor(() => expect(screen.getByTestId('canvas-loaded')).toHaveTextContent('8 nodes'));
    fireEvent.click(await screen.findByText('Start', { selector: 'p.summary' }));
    fireEvent.click(screen.getByRole('button', { name: 'Compress' }));
    const dialog = screen.getByRole('alertdialog');
    expect(within(dialog).getByRole('radio', { name: 'Everything below' })).toBeChecked();
    expect(dialog).toHaveTextContent('Compress 2 turns into at most 1, with');
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Fold short dead-end branches' }));
    expect(dialog).toHaveTextContent('Compress 2 sections, 3 turns into at most 2, folding 1 side branch (1 turn), with');
    expect(screen.getByText('Sackgasse', { selector: 'p.summary' }).closest('.message-node')).toHaveClass('compress-pending');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Compress' }));
    await waitFor(() => expect(compressCalls.map((c) => ({ ...c, ids: [...c.ids].sort() }))).toEqual([{ ids: gabel.nodes.map((x) => x.id).sort(), model: 'claude-opus-5', fold: true }]));
  });

  it('a ⌘-selection opens the dialog on "Selected cards"', async () => {
    stubFetch();
    extraCanvases = [{ slug: 'kette', nodeCount: 4 }];
    extraCanvasBodies = { kette };
    render(<App />);
    await screen.findByTestId('canvas-loaded');
    await userEvent.click(screen.getByRole('button', { name: /kette/ }));
    await waitFor(() => expect(screen.getByTestId('canvas-loaded')).toHaveTextContent('4 nodes'));
    fireEvent.click(await screen.findByText('Karte 1'));
    fireEvent.click(screen.getByText('Karte 1', { selector: 'p.summary' }), { metaKey: true });
    fireEvent.click(screen.getByText('Karte 3', { selector: 'p.summary' }), { metaKey: true });
    fireEvent.click(screen.getByRole('button', { name: 'Compress' }));
    expect(within(screen.getByRole('alertdialog')).getByRole('radio', { name: 'Selected cards' })).toBeChecked();
    expect(within(screen.getByRole('alertdialog')).getByRole('radio', { name: 'In context' })).toBeDisabled(); // one turn in context
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Compress' }));
    await waitFor(() => expect(compressCalls).toEqual([{ ids: [K[0], K[2]], model: 'claude-opus-5', fold: false }]));
  });

  it('offers no button where the strand forks right away', async () => {
    stubFetch();
    render(<App />);
    await screen.findByTestId('canvas-loaded');
    await userEvent.click(screen.getByRole('button', { name: /zweige/ }));
    await waitFor(() => expect(screen.getByTestId('canvas-loaded')).toHaveTextContent('3 nodes'));
    fireEvent.click(await screen.findByText('Zentroid'));
    expect(screen.queryByRole('button', { name: 'Compress' })).toBeNull();
  });
});

describe('topic memories (spec M15)', () => {
  const sentBodies = () => (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.filter((c) => String(c[0]).endsWith('/messages')).map((c) => JSON.parse((c[1] as RequestInit).body as string) as Record<string, unknown>);

  it('shows the selected card\'s topic memory, preselects it in the composer, sends it, and can deselect it', async () => {
    stubFetch();
    extraCanvasBodies.masterarbeit = { ...masterarbeit, memories: [{ topic: 'Zentroide', body: '- nutzt Zentroide', covered: 1 }] };
    render(<App />);
    await screen.findByTestId('canvas-loaded');
    fireEvent.click(await screen.findByText('Zentroid'));
    const panelMemory = await screen.findByRole('region', { name: 'Memory of Zentroide' });
    expect(within(panelMemory).getByText('nutzt Zentroide')).toBeInTheDocument();
    const chips = screen.getByRole('group', { name: 'Memories in the system prompt' });
    expect(within(chips).getByText('Zentroide')).toBeInTheDocument();
    const box = screen.getByPlaceholderText(/Write a message/);
    await userEvent.type(box, 'Und weiter?');
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(sentBodies()).toHaveLength(1));
    expect(sentBodies()[0]!.memoryTopics).toEqual(['Zentroide']);

    fireEvent.click(await screen.findByText('Zentroid'));
    fireEvent.click(within(screen.getByRole('group', { name: 'Memories in the system prompt' })).getByRole('button', { name: 'Remove memory Zentroide' }));
    await userEvent.type(screen.getByPlaceholderText(/Write a message/), 'Ohne');
    fireEvent.keyDown(screen.getByPlaceholderText(/Write a message/), { key: 'Enter' });
    await waitFor(() => expect(sentBodies()).toHaveLength(2));
    expect(sentBodies()[1]!.memoryTopics).toBeUndefined();
  });

  it('edits a memory in the panel and saves it against its base', async () => {
    stubFetch();
    extraCanvasBodies.masterarbeit = { ...masterarbeit, memories: [{ topic: 'Zentroide', body: '- alt', covered: 1 }] };
    render(<App />);
    await screen.findByTestId('canvas-loaded');
    fireEvent.click(await screen.findByText('Zentroid'));
    const region = await screen.findByRole('region', { name: 'Memory of Zentroide' });
    fireEvent.click(within(region).getByRole('button', { name: 'Edit' }));
    const area = within(region).getByLabelText('Memory text');
    fireEvent.change(area, { target: { value: '- neu' } });
    fireEvent.click(within(region).getByRole('button', { name: 'Save' }));
    expect(await within(region).findByText('neu')).toBeInTheDocument();
    const put = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.find((c) => String(c[0]).endsWith('/memories'))!;
    expect(JSON.parse((put[1] as RequestInit).body as string)).toEqual({ topic: 'Zentroide', body: '- neu', base: '- alt' });
  });

  it('a new strand starts without memories; one can be added from the list', async () => {
    stubFetch();
    extraCanvasBodies.masterarbeit = { ...masterarbeit, memories: [{ topic: 'Zentroide', body: '- x', covered: 1 }] };
    render(<App />);
    await screen.findByTestId('canvas-loaded');
    const chips = screen.getByRole('group', { name: 'Memories in the system prompt' });
    expect(within(chips).queryByRole('button', { name: /Remove memory/ })).toBeNull();
    fireEvent.change(within(chips).getByRole('combobox', { name: 'Add memory' }), { target: { value: 'Zentroide' } });
    expect(within(chips).getByRole('button', { name: 'Remove memory Zentroide' })).toBeInTheDocument();
  });
});

describe('notes on the canvas (spec M16 §6)', () => {
  const NOTE = { id: '01JQ8F1A0B1C2D3E4F5G6H7JNN', role: 'note', parents: [], created: '2026-09-28T10:00:00Z', summary: 'Vertrag', topics: [], body: 'Kündigung: drei Monate.', layout: { x: 900, y: 0, width: 400, height: 200 } };

  it('"+ Note" places a note, which becomes the cursor', async () => {
    stubFetch();
    render(<App />);
    await screen.findByTestId('canvas-loaded');
    fireEvent.click(screen.getByRole('button', { name: '+ Note' }));
    const dialog = screen.getByRole('dialog', { name: 'New note' });
    fireEvent.change(within(dialog).getByLabelText('Note text'), { target: { value: 'Ein Vertragstext' } });
    fireEvent.keyDown(within(dialog).getByLabelText('Note text'), { key: 'Enter', metaKey: true });
    await waitFor(() => expect(noteCalls).toHaveLength(1));
    expect(noteCalls[0]!.body).toBe('Ein Vertragstext');
    expect(screen.queryByRole('dialog', { name: 'New note' })).toBeNull();
    expect(await screen.findByRole('button', { name: 'Edit card' })).toBeInTheDocument(); // the panel shows the new note
    expect(screen.getByText(/replying to/i)).toBeInTheDocument();
  });

  it('pasting text outside the composer makes a note; pasting into the composer does not', async () => {
    stubFetch();
    render(<App />);
    await screen.findByTestId('canvas-loaded');
    const paste = (target: Element, text: string) => {
      const ev = new Event('paste', { bubbles: true, cancelable: true }) as Event & { clipboardData: unknown };
      ev.clipboardData = { files: [], items: [], getData: (t: string) => (t === 'text/plain' ? text : '') };
      act(() => { target.dispatchEvent(ev); });
    };
    paste(screen.getByPlaceholderText(/Write a message/), 'in den Composer');
    paste(document.body, '   ');
    paste(document.body, 'Kopierter Artikel');
    await waitFor(() => expect(noteCalls).toHaveLength(1));
    expect(noteCalls[0]!.body).toBe('Kopierter Artikel');
    expect(noteCalls[0]!.at).toBeDefined();
  });

  it('dropping files makes one note per text file and says what was skipped', async () => {
    stubFetch();
    const { container } = render(<App />);
    await screen.findByTestId('canvas-loaded');
    const files = [new File(['# Eins'], 'eins.md', { type: '' }), new File(['zwei'], 'zwei.txt', { type: 'text/plain' }), new File(['x'], 'bild.png', { type: 'image/png' })];
    fireEvent.drop(container.querySelector('.react-flow')!, { clientX: 100, clientY: 100, dataTransfer: { files, types: ['Files'] } });
    await waitFor(() => expect(noteCalls).toHaveLength(2));
    expect(noteCalls.map((c) => c.body)).toEqual(['# Eins', 'zwei']);
    expect(await screen.findByText(/1 file skipped/)).toBeInTheDocument();
  });

  it('a note shows as such and is edited in the panel against its base', async () => {
    stubFetch();
    extraCanvasBodies.masterarbeit = { ...masterarbeit, nodes: [...masterarbeit.nodes, NOTE] };
    render(<App />);
    await screen.findByTestId('canvas-loaded');
    fireEvent.click(await screen.findByText('Vertrag'));
    fireEvent.click(await screen.findByRole('button', { name: 'Edit card' }));
    fireEvent.change(screen.getByLabelText('Card text'), { target: { value: 'Kündigung: sechs Monate.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect((await screen.findAllByText('Kündigung: sechs Monate.')).length).toBeGreaterThan(0);
    expect(screen.queryByLabelText('Card text')).toBeNull();
    const put = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.find((c) => String(c[0]).includes('/nodes/') && (c[1] as RequestInit | undefined)?.method === 'PUT')!;
    expect(String(put[0])).toBe(`/api/canvases/masterarbeit/nodes/${NOTE.id}`);
    expect(JSON.parse((put[1] as RequestInit).body as string)).toEqual({ body: 'Kündigung: sechs Monate.', base: 'Kündigung: drei Monate.' });
  });
});

describe('editing cards by hand (spec M17 §2)', () => {
  const A_ID = '01JQ8F2H7T4WKD9M3XBQNAAAAA';
  const putCalls = (): { url: string; body: unknown }[] => (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls
    .filter((c) => String(c[0]).includes('/nodes/') && (c[1] as RequestInit | undefined)?.method === 'PUT')
    .map((c) => ({ url: String(c[0]), body: JSON.parse((c[1] as RequestInit).body as string) as unknown }));

  it('edits a question in the panel against its base', async () => {
    stubFetch();
    render(<App />);
    await screen.findByTestId('canvas-loaded');
    fireEvent.click(await screen.findByText('Ursprungsfrage'));
    const panel = screen.getByRole('complementary');
    fireEvent.click(within(panel).getByRole('button', { name: 'Edit card' }));
    const area = within(panel).getByLabelText('Card text');
    expect(area).toHaveValue('Wie evaluiere ich?');
    fireEvent.change(area, { target: { value: 'Wie evaluiere ich Clustering?' } });
    fireEvent.keyDown(area, { key: 'Enter', metaKey: true });
    await waitFor(() => expect(within(panel).queryByLabelText('Card text')).toBeNull());
    expect(within(panel).getByText('Wie evaluiere ich Clustering?')).toBeInTheDocument();
    expect(putCalls()).toEqual([{ url: `/api/canvases/masterarbeit/nodes/${A_ID}`, body: { body: 'Wie evaluiere ich Clustering?', base: 'Wie evaluiere ich?' } }]);
  });

  it('edits an answer; a conflict shows the current text and saves against it', async () => {
    stubFetch();
    putQueue = [new Response(JSON.stringify({ error: 'the card changed meanwhile', body: 'Aus Obsidian geändert.' }), { status: 409 })];
    render(<App />);
    await screen.findByTestId('canvas-loaded');
    fireEvent.click(await screen.findByText('Zentroid'));
    const panel = screen.getByRole('complementary');
    fireEvent.click(within(panel).getByRole('button', { name: 'Edit card' }));
    fireEvent.change(within(panel).getByLabelText('Card text'), { target: { value: 'Neu.' } });
    fireEvent.click(within(panel).getByRole('button', { name: 'Save' }));
    const alert = await within(panel).findByRole('alert');
    expect(alert).toHaveTextContent('The card changed meanwhile');
    expect(alert).toHaveTextContent('Aus Obsidian geändert.');
    expect(within(panel).getByLabelText('Card text')).toHaveValue('Neu.');
    fireEvent.click(within(panel).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(within(panel).queryByLabelText('Card text')).toBeNull());
    expect(putCalls().map((c) => c.body)).toEqual([{ body: 'Neu.', base: 'Zentroid statt Re-Clustering.' }, { body: 'Neu.', base: 'Aus Obsidian geändert.' }]);
  });

  it('refuses an empty card without a request; Esc cancels', async () => {
    stubFetch();
    render(<App />);
    await screen.findByTestId('canvas-loaded');
    fireEvent.click(await screen.findByText('Zentroid'));
    const panel = screen.getByRole('complementary');
    fireEvent.click(within(panel).getByRole('button', { name: 'Edit card' }));
    fireEvent.change(within(panel).getByLabelText('Card text'), { target: { value: '   ' } });
    fireEvent.click(within(panel).getByRole('button', { name: 'Save' }));
    expect(await within(panel).findByRole('alert')).toHaveTextContent('A card cannot be empty — delete it instead.');
    fireEvent.keyDown(within(panel).getByLabelText('Card text'), { key: 'Escape' });
    expect(within(panel).queryByLabelText('Card text')).toBeNull();
    expect(putCalls()).toEqual([]);
  });

  it('in the chat view the editor replaces the message body in place', async () => {
    stubFetch();
    render(<App />);
    await screen.findByTestId('canvas-loaded');
    fireEvent.click(await screen.findByText('Zentroid'));
    fireEvent.keyDown(window, { key: 'v' });
    const msg = document.querySelector(`.chat-msg[data-id="${A_ID}"]`) as HTMLElement;
    fireEvent.click(within(msg).getByRole('button', { name: 'Edit card' }));
    const area = within(msg).getByLabelText('Card text');
    expect(area).toHaveValue('Wie evaluiere ich?');
    expect(msg.querySelector('.chat-body')).toBeNull();
    fireEvent.change(area, { target: { value: 'Neue Frage?' } });
    fireEvent.click(within(msg).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(within(msg).queryByLabelText('Card text')).toBeNull());
    expect(within(msg).getByText('Neue Frage?')).toBeInTheDocument();
    expect(putCalls().map((c) => c.body)).toEqual([{ body: 'Neue Frage?', base: 'Wie evaluiere ich?' }]);
  });
});

describe('editing cards with the model (spec M17 §3)', () => {
  const A_ID = '01JQ8F2H7T4WKD9M3XBQNAAAAA';
  const putCalls = (): unknown[] => (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls
    .filter((c) => String(c[0]).includes('/nodes/') && (c[1] as RequestInit | undefined)?.method === 'PUT')
    .map((c) => JSON.parse((c[1] as RequestInit).body as string) as unknown);
  async function editA(): Promise<HTMLElement> {
    stubFetch();
    render(<App />);
    await screen.findByTestId('canvas-loaded');
    fireEvent.keyDown(window, { key: 'ArrowDown' }); // cursor on A
    fireEvent.keyDown(window, { key: 'e' });
    return screen.getByRole('textbox');
  }
  async function rewrite(box: HTMLElement, instruction: string): Promise<HTMLElement> {
    fireEvent.change(box, { target: { value: instruction } });
    fireEvent.keyDown(box, { key: 'Enter' });
    const preview = await screen.findByRole('region', { name: 'Rewrite preview' });
    await waitFor(() => expect(within(preview).getByRole('button', { name: 'Accept' })).toBeEnabled());
    return preview;
  }

  it('E switches the composer to Edit on the cursor and focuses it; Esc on the empty box goes back to Reply', async () => {
    const box = await editA();
    expect(box).toHaveFocus();
    expect(screen.getByText(/^Edit:/)).toHaveTextContent('Edit: Ursprungsfrage');
    expect(box).toHaveAttribute('placeholder', 'Was soll sich ändern?'); // the card is German
    expect(screen.getByRole('button', { name: 'Rewrite' })).toBeInTheDocument();
    fireEvent.keyDown(box, { key: 'Escape' });
    expect(screen.getByText(/Replying to:/)).toHaveTextContent('Ursprungsfrage');
    expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument();
  });

  it('E without a cursor does nothing', async () => {
    stubFetch();
    render(<App />);
    await screen.findByTestId('canvas-loaded');
    fireEvent.keyDown(window, { key: 'e' });
    expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument();
  });

  it('the meter counts the edit prompt', async () => {
    const box = await editA();
    fireEvent.change(box, { target: { value: 'kürzer' } });
    const expected = promptTokens(buildEditContext(graphLikeFromDto(masterarbeit as never), A_ID, 'kürzer'));
    expect(screen.getByRole('meter', { name: 'Context tokens' })).toHaveAttribute('aria-valuenow', String(expected));
  });

  it('Rewrite streams a preview; Accept saves it against the original body', async () => {
    const box = await editA();
    const preview = await rewrite(box, 'präziser');
    expect(rewriteCalls).toEqual([{ url: `/api/canvases/masterarbeit/nodes/${A_ID}/rewrite`, body: { instruction: 'präziser', model: 'claude-opus-5' } }]);
    expect(within(preview).getByText('Wie messe ich?')).toBeInTheDocument();
    expect(box).toHaveValue('');
    fireEvent.click(within(preview).getByRole('button', { name: 'Changes' }));
    expect(preview.querySelector('del')).toHaveTextContent('evaluiere');
    expect(preview.querySelector('ins')).toHaveTextContent('messe');
    fireEvent.click(within(preview).getByRole('button', { name: 'Accept' }));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Rewrite preview' })).toBeNull());
    expect(putCalls()).toEqual([{ body: 'Wie messe ich?', base: 'Wie evaluiere ich?' }]);
    expect(within(screen.getByRole('complementary')).getByText('Wie messe ich?')).toBeInTheDocument();
  });

  it('Discard writes nothing; ⌘Enter on the graph accepts', async () => {
    const box = await editA();
    let preview = await rewrite(box, 'präziser');
    fireEvent.click(within(preview).getByRole('button', { name: 'Discard' }));
    expect(screen.queryByRole('region', { name: 'Rewrite preview' })).toBeNull();
    expect(putCalls()).toEqual([]);
    preview = await rewrite(box, 'präziser');
    box.blur();
    fireEvent.keyDown(window, { key: 'Enter', metaKey: true });
    await waitFor(() => expect(putCalls()).toHaveLength(1));
  });

  it('a second instruction refines the preview: it goes out as draft, the base stays', async () => {
    const box = await editA();
    await rewrite(box, 'präziser');
    rewriteQueue = [rewriteSse('Wie messe ich gut?')];
    const preview = await rewrite(box, 'mit gut');
    expect(rewriteCalls[1]!.body).toEqual({ instruction: 'mit gut', model: 'claude-opus-5', draft: 'Wie messe ich?' });
    expect(within(preview).getByText('Wie messe ich gut?')).toBeInTheDocument();
    fireEvent.click(within(preview).getByRole('button', { name: 'Accept' }));
    await waitFor(() => expect(putCalls()).toEqual([{ body: 'Wie messe ich gut?', base: 'Wie evaluiere ich?' }]));
  });

  it('moving the cursor discards the preview', async () => {
    const box = await editA();
    await rewrite(box, 'präziser');
    box.blur();
    fireEvent.keyDown(window, { key: 'ArrowDown' });
    expect(screen.queryByRole('region', { name: 'Rewrite preview' })).toBeNull();
    expect(screen.getByText(/^Edit:/)).toHaveTextContent('Edit: Zentroid'); // still editing, now the new cursor
    expect(putCalls()).toEqual([]);
  });

  it('a conflict on Accept keeps the preview; Overwrite saves against the new version', async () => {
    const box = await editA();
    const preview = await rewrite(box, 'präziser');
    putQueue = [new Response(JSON.stringify({ error: 'the card changed meanwhile', body: 'In Obsidian geändert.' }), { status: 409 })];
    fireEvent.click(within(preview).getByRole('button', { name: 'Accept' }));
    expect(await within(preview).findByRole('alert')).toHaveTextContent('The card changed meanwhile — discard, or accept to overwrite the new version');
    fireEvent.click(within(preview).getByRole('button', { name: 'Overwrite' }));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Rewrite preview' })).toBeNull());
    expect(putCalls()).toEqual([{ body: 'Wie messe ich?', base: 'Wie evaluiere ich?' }, { body: 'Wie messe ich?', base: 'In Obsidian geändert.' }]);
  });

  it('"Edit by hand" opens the editor with the preview text and the original base', async () => {
    const box = await editA();
    const preview = await rewrite(box, 'präziser');
    fireEvent.click(within(preview).getByRole('button', { name: 'Edit by hand' }));
    expect(screen.queryByRole('region', { name: 'Rewrite preview' })).toBeNull();
    const area = within(screen.getByRole('complementary')).getByLabelText('Card text');
    expect(area).toHaveValue('Wie messe ich?');
    fireEvent.change(area, { target: { value: 'Wie messe ich genau?' } });
    fireEvent.keyDown(area, { key: 'Enter', metaKey: true });
    await waitFor(() => expect(putCalls()).toEqual([{ body: 'Wie messe ich genau?', base: 'Wie evaluiere ich?' }]));
  });

  it('a failing rewrite shows its error in the preview', async () => {
    const box = await editA();
    rewriteQueue = ['event: error\ndata: {"message":"boom","partial":false}\n\n'];
    fireEvent.change(box, { target: { value: 'präziser' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    const preview = await screen.findByRole('region', { name: 'Rewrite preview' });
    expect(await within(preview).findByRole('alert')).toHaveTextContent('Could not rewrite: boom');
    expect(within(preview).getByRole('button', { name: 'Accept' })).toBeDisabled();
  });
});
