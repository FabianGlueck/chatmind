import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createRef } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Composer } from '../src/Composer';

const models = [
  { id: 'claude-opus-5', provider: 'anthropic' as const, label: 'Claude Opus 5', available: true, contextTokens: 200_000 },
  { id: 'claude-sonnet-5', provider: 'anthropic' as const, label: 'Claude Sonnet 5', available: true, contextTokens: 200_000 },
  { id: 'x', provider: 'openai' as const, label: 'Unavailable', available: false, contextTokens: 200_000 },
];
const target = { id: 'A', role: 'user' as const, parents: [], created: 'c', summary: 'Ursprungsfrage', topics: [], body: '', layout: { x: 0, y: 0, width: 400, height: 200 } };

function setup(over: Partial<Parameters<typeof Composer>[0]> = {}) {
  const onSend = vi.fn(async () => true);
  const onEscape = vi.fn();
  const onModelChange = vi.fn();
  const promptTokens = vi.fn((text: string) => 100 + text.length);
  render(<Composer targets={[target]} language="en" promptTokens={promptTokens} budget={1000} models={models} model="claude-opus-5" onModelChange={onModelChange} onSend={onSend} sending={false} errorLine={null} onEscape={onEscape} textareaRef={createRef<HTMLTextAreaElement>()} {...over} />);
  return { onSend, onEscape, onModelChange, promptTokens };
}

describe('Composer', () => {
  it('shows the target, only available models, and the active one', () => {
    setup();
    expect(screen.getByText(/Replying to:/)).toHaveTextContent('Ursprungsfrage');
    expect(screen.getByRole('radio', { name: 'Claude Opus 5' })).toBeChecked();
    expect(screen.queryByRole('radio', { name: 'Unavailable' })).toBeNull();
  });
  it('says "New root message" without a target', () => {
    setup({ targets: [] });
    expect(screen.getByText('New root message')).toBeInTheDocument();
  });
  it('shows a hint for reaching the model chips by keyboard', () => {
    setup();
    expect(screen.getByText(/to change model/)).toBeInTheDocument();
  });
  it('does not send on Enter while an IME composition is in progress', async () => {
    const { onSend } = setup();
    const box = screen.getByRole('textbox');
    await userEvent.type(box, 'Hallo');
    fireEvent.keyDown(box, { key: 'Enter', isComposing: true });
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onSend).toHaveBeenCalledTimes(1);
  });
  it('sends on plain Enter with trimmed text and clears; Shift+Enter does not send; Cmd/Ctrl+Enter still sends', async () => {
    const { onSend } = setup();
    const box = screen.getByRole('textbox');
    await userEvent.type(box, '  Hallo  ');
    fireEvent.keyDown(box, { key: 'Enter', shiftKey: true });
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onSend).toHaveBeenCalledWith('Hallo', []);
    await screen.findByDisplayValue('');
    await userEvent.type(box, 'Zwei');
    fireEvent.keyDown(box, { key: 'Enter', metaKey: true });
    expect(onSend).toHaveBeenLastCalledWith('Zwei', []);
    await screen.findByDisplayValue('');
    await userEvent.type(box, 'Drei');
    fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true });
    expect(onSend).toHaveBeenLastCalledWith('Drei', []);
  });
  it('does not send empty text; Escape calls onEscape; model chips call onModelChange', async () => {
    const { onSend, onEscape, onModelChange } = setup();
    const box = screen.getByRole('textbox');
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.keyDown(box, { key: 'Escape' });
    expect(onEscape).toHaveBeenCalled();
    await userEvent.click(screen.getByRole('radio', { name: 'Claude Sonnet 5' }));
    expect(onModelChange).toHaveBeenCalledWith('claude-sonnet-5');
  });
  it('shows the no-provider hint and disables sending when no model is available', () => {
    setup({ models: [models[2]!] });
    expect(screen.getByText(/No provider configured/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  });
  it('shows the error line', () => {
    setup({ errorLine: 'boom' });
    expect(screen.getByRole('alert')).toHaveTextContent('boom');
  });
  it('keeps the typed text when onSend resolves false', async () => {
    const onSend = vi.fn(async () => false);
    setup({ onSend });
    const box = screen.getByRole('textbox');
    await userEvent.type(box, 'Hallo');
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(box).toHaveValue('Hallo'); // not cleared before onSend settles
    await waitFor(() => expect(onSend).toHaveBeenCalledWith('Hallo', []));
    expect(box).toHaveValue('Hallo'); // still not cleared once onSend resolves false
  });
  it('lists the merge targets in order and switches the placeholder by language', () => {
    const t2 = { ...target, id: 'B', summary: 'Zweiter' };
    const t3 = { ...target, id: 'C', summary: 'Dritter' };
    const t4 = { ...target, id: 'D', summary: 'Vierter' };
    setup({ targets: [target, t2], language: 'de' });
    expect(screen.getByText(/Merging:/)).toHaveTextContent('Merging: Ursprungsfrage, Zweiter');
    expect(screen.getByRole('textbox')).toHaveAttribute('placeholder', expect.stringContaining('Was soll aus diesen Zweigen entstehen?'));
    cleanup();
    setup({ targets: [target, t2, t3, t4], language: 'en' });
    expect(screen.getByText(/Merging:/)).toHaveTextContent('Merging: Ursprungsfrage, Zweiter, Dritter +1');
    expect(screen.getByRole('textbox')).toHaveAttribute('placeholder', expect.stringContaining('What should come out of these branches?'));
  });
  it('shows the token meter from promptTokens(text) against the budget', async () => {
    const { promptTokens } = setup({ budget: 1000 });
    const meter = screen.getByRole('meter', { name: 'Context tokens' });
    expect(meter).toHaveAttribute('aria-valuenow', '100');
    expect(meter).toHaveAttribute('aria-valuemax', '1000');
    expect(meter).toHaveTextContent('~100 / 1.0k');
    await userEvent.type(screen.getByRole('textbox'), 'abc');
    expect(promptTokens).toHaveBeenLastCalledWith('abc');
    expect(meter).toHaveAttribute('aria-valuenow', '103');
  });
  it('shows neither over nor warn and no over-budget alert when no model is resolved', () => {
    setup({ budget: 0 });
    const meter = screen.getByRole('meter');
    expect(meter).not.toHaveClass('over');
    expect(meter).not.toHaveClass('warn');
    expect(screen.queryByText(/Over budget/)).toBeNull();
  });
  it('turns amber at 80 % and blocks sending over budget with a hint', async () => {
    setup({ budget: 120 });
    expect(screen.getByRole('meter')).toHaveClass('warn');
    cleanup();
    const { onSend } = setup({ budget: 90, language: 'de' });
    expect(screen.getByRole('meter')).toHaveClass('over');
    expect(screen.getByRole('alert')).toHaveTextContent('Über Budget — Nodes abwählen');
    const box = screen.getByRole('textbox');
    await userEvent.type(box, 'Hallo');
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  });

  describe('images (spec M13)', () => {
    const png = () => new File([new Uint8Array([137, 80, 78, 71])], 'shot.png', { type: 'image/png' });
    it('adds a pasted screenshot as a thumbnail, counts it, and sends images only', async () => {
      const { onSend } = setup({ budget: 100_000 });
      const box = screen.getByRole('textbox');
      fireEvent.paste(box, { clipboardData: { files: [png()] } });
      expect(await screen.findByRole('img', { name: 'Image 1' })).toBeInTheDocument();
      expect(screen.getByRole('meter')).toHaveAttribute('aria-valuenow', String(100 + 1600));
      fireEvent.click(screen.getByRole('button', { name: 'Send' }));
      await waitFor(() => expect(onSend).toHaveBeenCalledWith('', [{ mediaType: 'image/png', data: 'iVBORw==', url: 'data:image/png;base64,iVBORw==' }]));
      await waitFor(() => expect(screen.queryByRole('img')).toBeNull());
    });
    it('attaches picked files, removes one with ✕ and refuses other types', async () => {
      setup({ budget: 100_000 });
      await userEvent.upload(screen.getByLabelText('Attach images'), [png(), png()]);
      expect(await screen.findAllByRole('img')).toHaveLength(2);
      fireEvent.click(screen.getByRole('button', { name: 'Remove image 1' }));
      expect(screen.getAllByRole('img')).toHaveLength(1);
      fireEvent.drop(screen.getByRole('textbox').closest('form')!, { dataTransfer: { files: [new File(['x'], 'a.svg', { type: 'image/svg+xml' })], types: ['Files'] } });
      expect(screen.getByRole('alert')).toHaveTextContent('Only PNG, JPEG, GIF and WebP');
    });
  });
});

describe('Composer edit mode (spec M17 §3.1)', () => {
  const card = { ...target, body: 'Wie evaluiere ich?' };
  it('heads with the card, asks what should change, rewrites; no images, no memories', () => {
    setup({ mode: 'edit', onModeChange: vi.fn(), editTarget: card, memories: [{ topic: 'T', body: '- x', covered: 0 }], memorySel: [], onMemorySel: vi.fn() });
    expect(screen.getByText(/^Edit:/)).toHaveTextContent('Edit: Ursprungsfrage');
    expect(screen.queryByText(/Replying to:/)).toBeNull();
    expect(screen.getByPlaceholderText('What should change?')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Rewrite' })).toBeDisabled();
    expect(screen.getByLabelText('Attach images')).toBeDisabled();
    expect(screen.queryByRole('group', { name: 'Memories in the system prompt' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Edit' })).toHaveAttribute('aria-pressed', 'true');
  });
  it('follows the language for the placeholder', () => {
    setup({ mode: 'edit', onModeChange: vi.fn(), editTarget: card, language: 'de' });
    expect(screen.getByPlaceholderText('Was soll sich ändern?')).toBeInTheDocument();
  });
  it('the switch changes mode; Edit needs a card', () => {
    const onModeChange = vi.fn();
    setup({ onModeChange, editTarget: card });
    expect(screen.getByRole('group', { name: 'Composer mode' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(onModeChange).toHaveBeenCalledWith('edit');
    cleanup();
    setup({ onModeChange, editTarget: null });
    expect(screen.getByRole('button', { name: 'Edit' })).toBeDisabled();
  });
  it('Esc on an empty edit composer discards the preview first, then goes back to Reply; with text it leaves', async () => {
    const onModeChange = vi.fn();
    const onDiscard = vi.fn();
    const { onEscape } = setup({ mode: 'edit', onModeChange, editTarget: card, onDiscard });
    const box = screen.getByRole('textbox');
    fireEvent.keyDown(box, { key: 'Escape' });
    expect(onDiscard).toHaveBeenCalledTimes(1);
    expect(onModeChange).not.toHaveBeenCalled();
    await userEvent.type(box, 'kürzer');
    fireEvent.keyDown(box, { key: 'Escape' });
    expect(onEscape).toHaveBeenCalledTimes(1);
    cleanup();
    setup({ mode: 'edit', onModeChange, editTarget: card });
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' });
    expect(onModeChange).toHaveBeenCalledWith('reply');
  });
  it('sends the instruction on Enter; ⌘Enter on an empty box accepts the preview', async () => {
    const onAccept = vi.fn();
    const { onSend } = setup({ mode: 'edit', onModeChange: vi.fn(), editTarget: card, onAccept });
    const box = screen.getByRole('textbox');
    fireEvent.keyDown(box, { key: 'Enter', metaKey: true });
    expect(onAccept).toHaveBeenCalledTimes(1);
    expect(onSend).not.toHaveBeenCalled();
    await userEvent.type(box, 'kürzer');
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(onSend).toHaveBeenCalledWith('kürzer', []));
  });
});

