import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Explainer, spotFromSelection } from '../src/Explainer';

afterEach(() => {
  vi.unstubAllGlobals();
  window.getSelection()?.removeAllRanges();
  document.body.innerHTML = '';
});

const sse = (events: [string, unknown][]): Response =>
  new Response(events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } });

/** Marks `word` inside the card body `id`. */
function mark(id: string, word: string): void {
  const p = document.querySelector(`[data-explain-id="${id}"] p`)!;
  const text = p.firstChild!;
  const start = text.textContent!.indexOf(word);
  const range = document.createRange();
  range.setStart(text, start);
  range.setEnd(text, start + word.length);
  window.getSelection()!.removeAllRanges();
  window.getSelection()!.addRange(range);
}

function Card() {
  return <div data-explain-id="A1"><p>The mean of the points in embedding space.</p></div>;
}

describe('spotFromSelection (spec quick-explain §2)', () => {
  it('reads the marked text, its sentence and the card; nothing outside a card body', () => {
    render(<><Card /><p id="outside">elsewhere text</p></>);
    mark('A1', 'embedding');
    expect(spotFromSelection(window.getSelection())).toMatchObject({ id: 'A1', selection: 'embedding', passage: 'The mean of the points in embedding space.' });
    const range = document.createRange();
    range.selectNodeContents(document.getElementById('outside')!);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    expect(spotFromSelection(window.getSelection())).toBeNull();
  });
});

describe('Explainer', () => {
  it('mark → ? → streamed explanation; nothing is written until "Keep as branch"', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/explain')) return sse([['delta', { text: 'A vector ' }], ['done', { text: 'A vector space.' }]]);
      if (url.endsWith('/explain/keep')) return new Response(JSON.stringify({ nodes: [{ id: 'U9' }, { id: 'A9' }] }), { status: 201 });
      throw new Error(`unexpected ${url} ${init?.method}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const kept = vi.fn();
    render(<><Card /><Explainer slug="m" model="claude-opus-5" onKeptBranch={kept} onKeepNote={() => undefined} /></>);
    mark('A1', 'embedding space');
    fireEvent.mouseUp(document.body);
    fireEvent.click(await screen.findByRole('button', { name: 'Explain the marked text' }));
    expect(await screen.findByText('A vector space.')).toBeInTheDocument();
    const body = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string) as Record<string, unknown>;
    expect(body).toMatchObject({ selection: 'embedding space', passage: 'The mean of the points in embedding space.', exchange: [], ask: '', model: 'claude-opus-5' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Keep as branch' }));
    await waitFor(() => expect(kept).toHaveBeenCalledWith([{ id: 'U9' }, { id: 'A9' }]));
    expect(JSON.parse(fetchMock.mock.calls[1]![1]!.body as string)).toEqual({ selection: 'embedding space', exchange: [{ q: '', a: 'A vector space.' }], model: 'claude-opus-5' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('a follow-up carries the exchange; Esc closes without writing; "Keep as note" hands the text to App', async () => {
    const answers = ['First.', 'Second.'];
    const fetchMock = vi.fn(async () => sse([['done', { text: answers.shift()! }]]));
    vi.stubGlobal('fetch', fetchMock);
    const note = vi.fn();
    render(<><Card /><Explainer slug="m" model="m1" onKeptBranch={() => undefined} onKeepNote={note} /></>);
    mark('A1', 'mean');
    fireEvent.mouseUp(document.body);
    fireEvent.click(await screen.findByRole('button', { name: 'Explain the marked text' }));
    await screen.findByText('First.');
    fireEvent.change(screen.getByLabelText('Follow-up question'), { target: { value: 'why?' } });
    fireEvent.submit(screen.getByLabelText('Follow-up question').closest('form')!);
    await screen.findByText('Second.');
    expect(JSON.parse((fetchMock.mock.calls[1] as unknown as [string, RequestInit])[1].body as string)).toMatchObject({ exchange: [{ q: '', a: 'First.' }], ask: 'why?' });
    fireEvent.click(screen.getByRole('button', { name: 'Keep as note' }));
    expect(note).toHaveBeenCalledWith('**»mean«**\n\nFirst.\n\n**why?**\n\nSecond.');

    mark('A1', 'points');
    fireEvent.mouseUp(document.body);
    answers.push('Third.');
    fireEvent.click(await screen.findByRole('button', { name: 'Explain the marked text' }));
    await screen.findByText('Third.');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
