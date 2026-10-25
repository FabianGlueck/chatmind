import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { NodePanel } from '../src/NodePanel';

const node = {
  id: '01JQ8F3K2M9XZP4V7NBHRCAAAA', role: 'assistant' as const, model: 'claude-sonnet-4-6',
  parents: ['01JQ8F2H7T4WKD9M3XBQNAAAAA'], created: '2026-03-14T10:42:03Z', summary: 'Zentroid',
  topics: ['eval'], body: '# Titel\n\nEin **fetter** Satz.\n\n- eins\n- zwei',
  layout: { x: 0, y: 0, width: 400, height: 200 },
};

describe('NodePanel', () => {
  it('renders metadata and the body as markdown', () => {
    render(<NodePanel node={node} />);
    expect(screen.getByRole('heading', { level: 2, name: 'Zentroid' })).toBeInTheDocument();
    expect(screen.getByText('assistant · claude-sonnet-4-6')).toBeInTheDocument();
    expect(screen.getByTitle('2026-03-14T10:42:03Z')).toHaveAttribute('datetime', '2026-03-14T10:42:03Z'); // shown as a local date
    expect(screen.getByText('eval')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Titel' })).toBeInTheDocument();
    expect(screen.getByText('fetter').tagName).toBe('STRONG');
    expect(screen.getAllByRole('listitem').map((li) => li.textContent)).toEqual(['eins', 'zwei']);
  });

  it('renders GFM tables, strikethrough and task lists', () => {
    render(<NodePanel node={{ ...node, body: '| Ansatz | Skaliert |\n|---|---|\n| Zentroid | ja |\n\n~~alt~~\n\n- [x] erledigt' }} />);
    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Ansatz' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'Zentroid' })).toBeInTheDocument();
    expect(screen.getByText('alt').tagName).toBe('DEL');
    expect(screen.getByRole('checkbox')).toBeChecked();
  });

  it('shows an empty state without a node', () => {
    render(<NodePanel node={null} />);
    expect(screen.getByText('Select a node to read it.')).toBeInTheDocument();
  });

  it('announces a running answer while the body is still empty, then keeps the status until the stream ends', () => {
    const { rerender } = render(<NodePanel node={{ ...node, summary: '', body: '' }} streaming />);
    expect(screen.getByRole('heading', { level: 2, name: 'Answering…' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('claude-sonnet-4-6 is answering');
    rerender(<NodePanel node={{ ...node, summary: '', body: 'First words' }} streaming />);
    expect(screen.getByRole('heading', { level: 2, name: 'First words' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toBeInTheDocument();
    rerender(<NodePanel node={{ ...node, summary: '', body: 'First words' }} />);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('does not load remote images from markdown, showing the alt text instead', () => {
    render(<NodePanel node={{ ...node, body: '![alt](https://example.com/x.png)' }} />);
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.getByText('alt')).toBeInTheDocument();
  });

  it('renders chatmind attachment embeds as images from the server (spec M13)', () => {
    render(<NodePanel node={{ ...node, summary: '', body: 'Hier:\n\n![[01JQ7M2V3X4Y5Z6A7B8C9D0E1F.png]]\n\n![[other.png]]' }} canvasSlug="masterarbeit" />);
    const img = screen.getByRole('img');
    expect(img).toHaveAttribute('src', '/api/canvases/masterarbeit/attachments/01JQ7M2V3X4Y5Z6A7B8C9D0E1F.png');
    expect(screen.getByText('![[other.png]]')).toBeInTheDocument(); // anything else stays text
    expect(screen.getByRole('heading', { level: 2, name: 'Hier:' })).toBeInTheDocument();
  });

  it('colours the topic pill from the palette', () => {
    render(<NodePanel node={{ ...node, topics: ['Alpha'] }} palette={new Map([['Alpha', 4]])} />);
    const pill = screen.getByText('Alpha');
    expect(pill).toHaveClass('topic');
    expect((pill as HTMLElement).style.getPropertyValue('--topic')).toBe('var(--topic-4)');
  });
});

describe('NodePanel editing (spec M17 §2)', () => {
  it('offers Edit for a question and an answer, not while streaming; the editor replaces the body', async () => {
    const { fireEvent } = await import('@testing-library/react');
    const asked: string[] = [];
    const { rerender } = render(<NodePanel node={{ ...node, role: 'user', model: undefined }} onEdit={(id) => asked.push(id)} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit card' }));
    rerender(<NodePanel node={node} onEdit={(id) => asked.push(id)} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit card' }));
    expect(asked).toEqual([node.id, node.id]);
    rerender(<NodePanel node={node} streaming onEdit={() => undefined} />);
    expect(screen.queryByRole('button', { name: 'Edit card' })).toBeNull();
    rerender(<NodePanel node={node} onEdit={() => undefined} editor={<p>EDITOR</p>} />);
    expect(screen.getByText('EDITOR')).toBeInTheDocument();
    expect(screen.queryByText('fetter')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit card' })).toBeNull();
  });
});

describe('NodePanel related (spec M7 §6)', () => {
  const links = { from: node.id, links: [
    { id: 'N2', canvas: 'hier', summary: 'Gleicher Canvas', similarity: 0.9, score: 0.61 },
    { id: 'N3', canvas: 'drueben', summary: 'Anderer Canvas', similarity: 0.8, score: 0.47 },
  ] };
  it('lists related answers with their score and the other canvas, and reports clicks', async () => {
    const { fireEvent } = await import('@testing-library/react');
    const clicks: string[] = [];
    render(<NodePanel node={node} related={links} canvasSlug="hier" onRelated={(l) => clicks.push(l.id)} />);
    const section = screen.getByRole('region', { name: 'Related' });
    expect(section).toHaveTextContent('Gleicher Canvas0.61');
    expect(section).toHaveTextContent('Anderer Canvas0.47drueben');
    expect(section.textContent).not.toContain('hier');
    fireEvent.click(screen.getByText('Anderer Canvas'));
    expect(clicks).toEqual(['N3']);
    // Pinned below the scrolling body, not inside it (user, 2026-09-24).
    expect(section.parentElement).toBe(screen.getByRole('complementary'));
    expect(section.closest('.panel-content')).toBeNull();
    expect(screen.getByText('fetter').closest('.panel-content')).not.toBeNull();
  });
  it('names why the list is empty, and hides the section for a user node without an answer', () => {
    const { rerender } = render(<NodePanel node={node} related={{ from: node.id, links: [] }} />);
    expect(screen.getByText('No related answers.')).toBeInTheDocument();
    rerender(<NodePanel node={node} related={{ from: node.id, links: [], reason: 'no-vector' }} />);
    expect(screen.getByText('Not embedded yet.')).toBeInTheDocument();
    rerender(<NodePanel node={node} related={{ from: null, links: [], reason: 'no-index' }} />);
    expect(screen.getByText('Index not available.')).toBeInTheDocument();
    rerender(<NodePanel node={node} related={{ from: null, links: [], reason: 'no-answer' }} />);
    expect(screen.queryByRole('region', { name: 'Related' })).toBeNull();
    rerender(<NodePanel node={node} related={null} />);
    expect(screen.queryByRole('region', { name: 'Related' })).toBeNull();
  });
});

describe('NodePanel title editing (spec M17 §6)', () => {
  it('clicking the title opens a one-line editor; Enter saves the cleaned text against the old summary', async () => {
    const onSaveTitle = vi.fn(async (_id: string, summary: string) => ({ ok: true as const, node: { ...node, summary } }));
    render(<NodePanel node={node} onSaveTitle={onSaveTitle} />);
    fireEvent.click(screen.getByRole('button', { name: 'Zentroid' }));
    const input = screen.getByRole('textbox', { name: 'Card title' });
    expect(input).toHaveValue('Zentroid');
    fireEvent.change(input, { target: { value: '  Zentroid \n statt Clustering ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Card title' })).toBeNull());
    expect(onSaveTitle).toHaveBeenCalledWith(node.id, 'Zentroid statt Clustering', 'Zentroid');
  });

  it('Esc cancels without saving; an unchanged title closes without a request', () => {
    const onSaveTitle = vi.fn();
    render(<NodePanel node={node} onSaveTitle={onSaveTitle} />);
    fireEvent.click(screen.getByRole('button', { name: 'Zentroid' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Card title' }), { target: { value: 'anders' } });
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Card title' }), { key: 'Escape' });
    expect(screen.queryByRole('textbox', { name: 'Card title' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Zentroid' }));
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Card title' }), { key: 'Enter' });
    expect(screen.queryByRole('textbox', { name: 'Card title' })).toBeNull();
    expect(onSaveTitle).not.toHaveBeenCalled();
  });

  it('a summary changed meanwhile is shown and becomes the new base; too long is refused', async () => {
    const onSaveTitle = vi.fn(async () => ({ ok: false as const, current: 'Vom Index' }));
    render(<NodePanel node={node} onSaveTitle={onSaveTitle} />);
    fireEvent.click(screen.getByRole('button', { name: 'Zentroid' }));
    const input = screen.getByRole('textbox', { name: 'Card title' });
    fireEvent.change(input, { target: { value: 'x'.repeat(251) } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByRole('alert')).toHaveTextContent('at most 250');
    expect(onSaveTitle).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: 'Mein Titel' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(await screen.findByText(/changed meanwhile to “Vom Index”/)).toBeInTheDocument();
    expect(input).toHaveValue('Mein Titel');
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(onSaveTitle).toHaveBeenLastCalledWith(node.id, 'Mein Titel', 'Vom Index'));
  });

  it('a streaming card has no title button', () => {
    render(<NodePanel node={node} streaming onSaveTitle={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Zentroid' })).toBeNull();
  });
});
