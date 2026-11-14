import { useEffect, useState } from 'react';
import { fetchVault, pickVaultFolder, switchVault, type VaultInfo } from './api';

const baseName = (p: string): string => p.split(/[\\/]/).filter(Boolean).pop() ?? p;

/** Spec vault-switcher §2/§6: shows the live data folder; opens a small panel to pick a recent one or type a path. */
export function VaultSwitcher() {
  const [info, setInfo] = useState<VaultInfo | null>(null);
  const [open, setOpen] = useState(false);
  const [path, setPath] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // An older server (or a test stub) answers something else: then there is simply no switcher.
    fetchVault().then((v) => { if (typeof v?.dataDir === 'string' && Array.isArray(v.recent)) setInfo(v); }).catch(() => undefined);
  }, []);

  const go = async (dir: string): Promise<void> => {
    if (dir.trim() === '' || busy) return;
    setBusy(true);
    setError(null);
    try {
      await switchVault(dir.trim());
      window.location.assign('/'); // every canvas, selection and stream belongs to the old folder: start over
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  const browse = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const dir = await pickVaultFolder();
      setBusy(false);
      if (dir !== null) await go(dir);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  if (info === null) return null;
  return (
    <div className="vault-switcher">
      <button type="button" className="vault-current" aria-expanded={open} title={info.dataDir} onClick={() => setOpen((o) => !o)}>
        <span aria-hidden="true">📁</span> {baseName(info.dataDir)} <span className="vault-caret" aria-hidden="true">{open ? '▴' : '▾'}</span>
      </button>
      {open && (
        <div className="vault-panel">
          <p className="vault-path">{info.dataDir}</p>
          {info.overridden && <p className="vault-note">Set by --data-dir or CHATMIND_DATA_DIR: on the next start that wins over this choice.</p>}
          {info.recent.filter((p) => p !== info.dataDir).length > 0 && (
            <ul aria-label="Recent folders">
              {info.recent.filter((p) => p !== info.dataDir).map((p) => (
                <li key={p}><button type="button" title={p} disabled={busy} onClick={() => void go(p)}>{baseName(p)} <span className="count">{p}</span></button></li>
              ))}
            </ul>
          )}
          {info.canPick && <button type="button" className="new-canvas" disabled={busy} onClick={() => void browse()}>Browse…</button>}
          <form onSubmit={(e) => { e.preventDefault(); void go(path); }}>
            <div className="composer-row">
              <input aria-label="Folder path" value={path} placeholder="Open folder… (/path or ~/path)" onChange={(e) => setPath(e.target.value)} />
              <button type="submit" disabled={busy || path.trim() === ''}>Open</button>
            </div>
          </form>
          {error && <p className="composer-error" role="alert">{error}</p>}
        </div>
      )}
    </div>
  );
}
