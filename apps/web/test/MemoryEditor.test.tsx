import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryEditor } from '../src/MemoryEditor';

afterEach(() => vi.unstubAllGlobals());

describe('MemoryEditor (spec M15 §5)', () => {
  it('without a memory it invites writing one', () => {
    render(<MemoryEditor slug="m" topic="Pandas" memory={undefined} onSaved={() => undefined} />);
    expect(screen.getByText(/No memory yet/)).toBeInTheDocument();
  });
  it('a conflict shows the current version and keeps the typed text; saving again uses the new base', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'the memory changed meanwhile', body: '- alt\\n\\n- vom Indexer' }), { status: 409 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ topic: 'Pandas', body: '- meins', covered: 2 }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const onSaved = vi.fn();
    render(<MemoryEditor slug="m" topic="Pandas" memory={{ topic: 'Pandas', body: '- alt', covered: 1 }} onSaved={onSaved} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByLabelText('Memory text'), { target: { value: '- meins' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('vom Indexer');
    expect(screen.getByLabelText('Memory text')).toHaveValue('- meins');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await vi.waitFor(() => expect(onSaved).toHaveBeenCalledWith({ topic: 'Pandas', body: '- meins', covered: 2 }));
    expect(JSON.parse(fetchMock.mock.calls[1]![1].body as string)).toMatchObject({ base: '- alt\\n\\n- vom Indexer' });
  });
});
