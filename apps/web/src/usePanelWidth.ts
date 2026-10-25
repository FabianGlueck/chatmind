import { useState, type PointerEvent as ReactPointerEvent } from 'react';

const COLLAPSE_KEY = 'chatmind.collapsed.';

/** Whether a side bar (`left` / `right`) is folded away, remembered per browser (a per-viewer convenience only). */
export function useCollapsed(side: 'left' | 'right'): [boolean, () => void, (to: boolean) => void] {
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try { return localStorage.getItem(COLLAPSE_KEY + side) === '1'; } catch { return false; }
  });
  const set = (to: boolean): void => {
    try { localStorage.setItem(COLLAPSE_KEY + side, to ? '1' : '0'); } catch { /* per-viewer convenience only */ }
    setCollapsed(to);
  };
  const toggle = (): void => set(!collapsed);
  return [collapsed, toggle, set];
}

const KEY = 'chatmind.panelWidth';
export const PANEL_MIN = 280;
export const PANEL_DEFAULT = 380;

/** The panel never gets narrower than PANEL_MIN nor wider than 60 % of the window. */
export function clampPanelWidth(width: number, innerWidth: number): number {
  return Math.min(Math.max(width, PANEL_MIN), Math.max(PANEL_MIN, Math.floor(innerWidth * 0.6)));
}

/** Width of the right panel, dragged at its left edge and remembered per browser (a per-viewer convenience only). */
export function usePanelWidth(): { width: number; onPointerDown: (e: ReactPointerEvent) => void } {
  const [width, setWidth] = useState<number>(() => {
    try {
      const stored = Number(localStorage.getItem(KEY));
      return stored > 0 ? clampPanelWidth(stored, window.innerWidth) : PANEL_DEFAULT;
    } catch {
      return PANEL_DEFAULT;
    }
  });
  const onPointerDown = (e: ReactPointerEvent): void => {
    e.preventDefault();
    const move = (ev: PointerEvent): void => setWidth(clampPanelWidth(window.innerWidth - ev.clientX, window.innerWidth));
    const up = (): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setWidth((w) => {
        try { localStorage.setItem(KEY, String(w)); } catch { /* per-viewer convenience only */ }
        return w;
      });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  return { width, onPointerDown };
}
