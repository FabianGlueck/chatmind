import { ReactFlowProvider } from '@xyflow/react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { MessageNodeData } from '../src/flow';
import { MessageNode, summarySize } from '../src/MessageNode';

const base: MessageNodeData = { role: 'assistant', model: 'm1', summary: '', body: '', created: '2026-01-01T00:00:00Z' };
// NodeProps carries many React Flow internals the component never reads; a cast keeps the test honest about what it exercises.
const renderNode = (data: MessageNodeData) => render(<ReactFlowProvider><MessageNode {...({ id: 'n', data, selected: false } as unknown as Parameters<typeof MessageNode>[0])} /></ReactFlowProvider>);

describe('summarySize', () => {
  it('steps the type size down as the summary gets longer', () => {
    expect([10, 100, 101, 150, 151, 250].map((n) => summarySize('x'.repeat(n)))).toEqual(['lg', 'lg', 'md', 'md', 'sm', 'sm']);
  });
});

describe('MessageNode', () => {
  it('shows the whole summary and nothing of the body', () => {
    const summary = 'Zentroid statt Re-Clustering. Die Zuordnung wird einmal entschieden und wandert danach nie mehr.';
    renderNode({ ...base, summary, body: 'Ein **fetter** Satz mit sehr viel Text.' });
    expect(screen.getByText(summary)).toBeInTheDocument();
    expect(screen.queryByText(/fetter/)).toBeNull();
  });
  it('falls back to the start of the body as plain text while there is no summary', () => {
    renderNode({ ...base, body: `Ein **fetter** Satz.\n\n${'x'.repeat(400)}` });
    const fallback = screen.getByText(/Ein \*\*fetter\*\* Satz/);
    expect(fallback).toHaveClass('fallback');
    expect(fallback.textContent!.length).toBeLessThanOrEqual(251);
    expect(fallback.textContent!.endsWith('…')).toBe(true);
    expect(screen.queryByRole('strong')).toBeNull();
  });
  it('shows "Answering…" as the title while streaming with no text yet', () => {
    renderNode({ ...base, streaming: true });
    expect(screen.getByText('Answering…')).toBeInTheDocument();
  });
  it('shows the topic label and colour only when a topic is set', () => {
    const { container } = renderNode({ ...base, summary: 'S', topic: 'Zentroide', topicIndex: 2 });
    const label = screen.getByText('Zentroide');
    expect(label).toHaveClass('topic-label');
    expect(label).toHaveAttribute('title', 'Zentroide');
    const card = container.querySelector('.message-node')!;
    expect(card).toHaveClass('has-topic');
    expect((card as HTMLElement).style.getPropertyValue('--topic')).toBe('var(--topic-2)');
  });
  it('has neither label nor colour without a topic, and dims when asked', () => {
    const { container } = renderNode({ ...base, summary: 'S', dimmed: true });
    expect(screen.queryByText(/topic/)).toBeNull();
    const card = container.querySelector('.message-node')!;
    expect(card).not.toHaveClass('has-topic');
    expect(card).toHaveClass('dimmed');
  });
});
