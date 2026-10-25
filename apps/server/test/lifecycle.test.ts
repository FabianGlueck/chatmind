import { afterEach, describe, expect, it, vi } from 'vitest';
import { portInUseMessage, watchParent } from '../src/lifecycle';

afterEach(() => vi.useRealTimers());

describe('watchParent', () => {
  it('calls onGone once the process is reparented, and only once', () => {
    vi.useFakeTimers();
    let ppid = 4242;
    const onGone = vi.fn();
    const stop = watchParent({ ppid: () => ppid, onGone, everyMs: 1000 });
    vi.advanceTimersByTime(3000);
    expect(onGone).not.toHaveBeenCalled();
    ppid = 1; // the parent died; launchd/init adopted us
    vi.advanceTimersByTime(1000);
    expect(onGone).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(5000);
    expect(onGone).toHaveBeenCalledTimes(1);
    stop();
  });

  it('stop() ends the watch', () => {
    vi.useFakeTimers();
    let ppid = 4242;
    const onGone = vi.fn();
    watchParent({ ppid: () => ppid, onGone, everyMs: 1000 })();
    ppid = 1;
    vi.advanceTimersByTime(5000);
    expect(onGone).not.toHaveBeenCalled();
  });
});

describe('portInUseMessage', () => {
  it('names the holder and how to stop it', () => {
    expect(portInUseMessage(3210, '38752')).toBe('port 3210 is already in use by pid 38752 — probably an older chatmind server. Stop it with: kill 38752');
  });
  it('points at lsof when the holder is unknown', () => {
    expect(portInUseMessage(3210, null)).toBe('port 3210 is already in use. Find the holder with: lsof -nP -iTCP:3210 -sTCP:LISTEN');
  });
});
