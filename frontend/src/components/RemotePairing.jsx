import { useCallback, useEffect, useRef, useState } from 'react';

// Non-destructive check: is a scanned pairing code sitting in the fragment?
// Lets a host decide to re-pair before this component mounts and consumes it.
export function peekFragmentPairingCode() {
  try {
    return /(?:^|[#&])c=(\d{6})(?:&|$)/.exec(window.location.hash || '')?.[1] || '';
  } catch {
    return '';
  }
}

// A scanned QR carries the code as "#c=123456". Read it once, then strip it from the URL so
// the credential does not linger in history or on screen. Fragments never reach the server.
function takeCodeFromFragment() {
  try {
    const match = /(?:^|[#&])c=(\d{6})(?:&|$)/.exec(window.location.hash || '');
    if (!match) return '';
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
    return match[1];
  } catch {
    return '';
  }
}

// Pairing screen shown to a remote device before it holds a remote token.
// Shared by the full remote controller (App) and the slides remote.
export default function RemotePairing({ onPaired, title = 'Remote Controller', subtitle = 'Pair with Main Controller' }) {
  const [deviceName, setDeviceName] = useState(() => localStorage.getItem('bc-remote-device-name') || '');
  const [code, setCode] = useState('');
  const [status, setStatus] = useState(null);
  const [error, setError] = useState('');
  const [isPairing, setIsPairing] = useState(false);

  useEffect(() => {
    fetch('/api/remote/status')
      .then(response => response.json())
      .then(setStatus)
      .catch(() => setStatus({ enabled: false }));
  }, []);

  const pair = useCallback(async (pairingCode) => {
    setError('');
    setIsPairing(true);
    try {
      const name = deviceName.trim() || 'Remote Controller';
      const response = await fetch('/api/remote/pair', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: pairingCode, deviceName: name }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result.ok) {
        throw new Error(result.error || 'Pairing failed.');
      }
      localStorage.setItem('bc-remote-token', result.remoteToken);
      localStorage.setItem('bc-remote-session', JSON.stringify(result.session));
      localStorage.setItem('bc-remote-device-name', name);
      onPaired(result.remoteToken, result.session);
    } catch (err) {
      setError(err.message || 'Pairing failed.');
    } finally {
      setIsPairing(false);
    }
  }, [deviceName, onPaired]);

  const handleSubmit = (event) => {
    event.preventDefault();
    pair(code);
  };

  // Scanned-QR path: pair straight away, no typing. The ref latch stops React 19
  // StrictMode's double-invoked effect from firing two pair requests.
  const autoPairedRef = useRef(false);
  useEffect(() => {
    if (autoPairedRef.current) return;
    const fragmentCode = takeCodeFromFragment();
    if (!fragmentCode) return;
    autoPairedRef.current = true;
    setCode(fragmentCode);
    pair(fragmentCode);
    // `pair` is intentionally not a dependency: this must run exactly once, on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="app-bg min-h-screen flex items-center justify-center p-4">
      <form onSubmit={handleSubmit} className="surface-raised w-full max-w-lg rounded-xl p-5">
        <div className="mb-5 flex items-center gap-3">
          <div className="surface-raised flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-lg p-px">
            <img src="/logo.png" className="h-full w-full rounded-[7px] object-cover" alt="Broadcast Controller logo" />
          </div>
          <div>
            <div className="text-lg font-bold leading-none text-slate-900 dark:text-white">{title}</div>
            <div className="mt-1 text-[10px] font-bold uppercase tracking-[0.25em] text-blue-600 dark:text-blue-400">{subtitle}</div>
          </div>
        </div>

        {status && !status.enabled && (
          <div className="mb-4 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs font-semibold text-amber-700 dark:text-amber-300">
            Remote Operators is currently disabled on the main controller.
          </div>
        )}

        <div className="space-y-3">
          <label className="block">
            <span className="text-xs font-bold uppercase tracking-wider text-slate-500">Device Name</span>
            <input
              value={deviceName}
              onChange={event => setDeviceName(event.target.value)}
              placeholder="Remote laptop"
              className="control-field mt-1 px-3 py-2 text-sm"
            />
          </label>

          <label className="block">
            <span className="text-xs font-bold uppercase tracking-wider text-slate-500">Pairing Code</span>
            <input
              value={code}
              onChange={event => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
              inputMode="numeric"
              placeholder="000000"
              className="control-field mt-1 px-3 py-3 text-center text-2xl font-black tracking-[0.35em]"
            />
          </label>
        </div>

        {error && (
          <div className="mt-4 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs font-semibold text-red-600 dark:text-red-300">
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={isPairing || code.length !== 6}
          className="mt-5 w-full rounded-lg bg-blue-600 px-4 py-3 text-sm font-bold uppercase tracking-wider text-white transition hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isPairing ? 'Pairing...' : 'Pair Remote Controller'}
        </button>
      </form>
    </div>
  );
}
