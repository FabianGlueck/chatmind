import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { PANEL_DEFAULT, PANEL_MIN, clampPanelWidth, useCollapsed, usePanelWidth } from '../src/usePanelWidth';

function Harness() {
  const { width, onPointerDown } = usePanelWidth();
  return (
    <div>
      <div role="separator" aria-orientation="vertical" onPointerDown={onPointerDown} />
      <output>{width}</output>
    </div>
  );
}

afterEach(() => { try { localStorage.clear(); } catch { /* ignore */ } });

describe('clampPanelWidth', () => {
  it('keeps the width between the minimum and 60 % of the window', () => {
    expect(clampPanelWidth(100, 1400)).toBe(PANEL_MIN);
    expect(clampPanelWidth(500, 1400)).toBe(500);
    expect(clampPanelWidth(2000, 1400)).toBe(840);
  });
});

describe('usePanelWidth', () => {
  it('starts at the default, follows a drag from the right edge, and remembers the result', () => {
    Object.defineProperty(window, 'innerWidth', { value: 1400, configurable: true });
    render(<Harness />);
    expect(screen.getByRole('status')).toHaveTextContent(String(PANEL_DEFAULT));
    fireEvent.pointerDown(screen.getByRole('separator'), { clientX: 1020 });
    fireEvent.pointerMove(window, { clientX: 900 });
    expect(screen.getByRole('status')).toHaveTextContent('500');
    fireEvent.pointerUp(window, { clientX: 900 });
    expect(localStorage.getItem('chatmind.panelWidth')).toBe('500');
    fireEvent.pointerMove(window, { clientX: 700 }); // released — no longer tracking
    expect(screen.getByRole('status')).toHaveTextContent('500');
  });
  it('restores a remembered width', () => {
    localStorage.setItem('chatmind.panelWidth', '450');
    render(<Harness />);
    expect(screen.getByRole('status')).toHaveTextContent('450');
  });
});

describe('useCollapsed', () => {
  function Fold({ side }: { side: 'left' | 'right' }) {
    const [collapsed, toggle] = useCollapsed(side);
    return <button onClick={toggle}>{collapsed ? 'folded' : 'open'}</button>;
  }
  it('starts open, toggles, and remembers each side on its own', () => {
    const { unmount } = render(<Fold side="left" />);
    expect(screen.getByRole('button')).toHaveTextContent('open');
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByRole('button')).toHaveTextContent('folded');
    expect(localStorage.getItem('chatmind.collapsed.left')).toBe('1');
    unmount();
    const again = render(<Fold side="left" />);
    expect(screen.getByRole('button')).toHaveTextContent('folded');
    again.unmount();
    render(<Fold side="right" />);
    expect(screen.getByRole('button')).toHaveTextContent('open');
  });
});
