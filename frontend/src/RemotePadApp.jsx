import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import { getRemoteToken, socketOptions } from './auth';
import RemotePairing from './components/RemotePairing';
import { peekFragmentPairingCode } from './utils/pairing';
import { useWakeLock } from './utils/useWakeLock';
import PadButton from './components/PadButton';
import { isPadClickEnabled, playPadClick, setPadClickEnabled } from './components/padClick';
import {
    DEFAULT_PAD_LAYOUT,
    PAD_LAYER_LABELS,
    getPadButtonActive,
    isPadActionAvailable,
    normalizePadLayout,
    resolvePadAction
} from './components/padModel';

// Tactile control pad served at /pad. Pairs exactly like the slides remote; the
// difference is that this page is a configurable grid of large buttons driven by
// a layout the desktop publishes, rather than a fixed slide clicker.

const EMPTY_PRES_META = {
    mode: 'none', baseUrl: '', slideId: '',
    currentIdx: 0, totalSlides: 0, isCanva: false, showing: false
};

// The nine `live` flags from the server's operator state, in the order they read
// best as a glance-able row.
const CUE_STATUS_DOT = {
    pending: 'bg-slate-500',
    armed: 'bg-amber-500',
    fired: 'bg-emerald-500',
    skipped: 'bg-slate-700',
    done: 'bg-blue-500'
};

const LIVE_PIPS = [
    ['presentation', 'Slides'],
    ['media', 'Media'],
    ['photo', 'Photo'],
    ['lowerThird', 'L3'],
    ['lyrics', 'Lyrics'],
    ['sabhaTimer', 'Sabha'],
    ['translation', 'CC'],
    ['particles', 'FX'],
    ['mediaMessage', 'Msg']
];

function StatusPips({ live }) {
    return (
        <div className="flex shrink-0 flex-wrap items-center gap-1">
            {LIVE_PIPS.map(([key, label]) => (
                <span
                    key={key}
                    title={label}
                    className={`rounded px-1.5 py-0.5 text-[9px] font-black uppercase tracking-wider transition ${
                        live?.[key]
                            ? 'bg-red-600 text-white'
                            : 'bg-slate-500/15 text-slate-500'
                    }`}
                >
                    {label}
                </span>
            ))}
        </div>
    );
}

function PadStatusBar({ state, presMeta, connected, compact }) {
    // A muted layer is the classic "why isn't it showing" panic, so it gets the
    // loudest treatment on the bar.
    const muted = useMemo(() => (
        Object.entries(state?.layerVisibility || {})
            .filter(([, visible]) => visible === false)
            .map(([key]) => PAD_LAYER_LABELS[key] || key)
    ), [state]);

    const mediaName = state?.current?.media?.name || '';
    const slideLabel = presMeta.totalSlides
        ? `Slide ${presMeta.currentIdx + 1} of ${presMeta.totalSlides}`
        : '';

    return (
        <header className="surface-raised z-10 flex shrink-0 items-center gap-3 px-3 py-2">
            <StatusPips live={state?.live} />

            {!compact && (
                <div className="flex min-w-0 flex-1 items-center gap-3 text-[11px] font-semibold text-slate-500">
                    {slideLabel && <span className="shrink-0">{slideLabel}</span>}
                    {mediaName && (
                        <span className="min-w-0 truncate">
                            {state?.playback?.mediaPlaying ? '▶' : '❙❙'} {mediaName}
                        </span>
                    )}
                </div>
            )}

            <div className="ml-auto flex shrink-0 items-center gap-2">
                {muted.length > 0 && (
                    <span className="rounded-md bg-red-600 px-2 py-1 text-[10px] font-black uppercase tracking-wider text-white">
                        {compact ? `${muted.length} Muted` : `Muted: ${muted.join(', ')}`}
                    </span>
                )}
                <span
                    title={connected ? 'Connected' : 'Disconnected'}
                    className={`h-2.5 w-2.5 rounded-full ${connected ? 'bg-emerald-500' : 'bg-slate-500'}`}
                />
            </div>
        </header>
    );
}

export default function RemotePadApp() {
    // A freshly scanned QR always wins over a stored token, so re-scanning is a
    // reliable way to recover from an expired session or a server restart.
    const [remoteToken, setRemoteToken] = useState(() => (peekFragmentPairingCode() ? '' : getRemoteToken()));
    const [socket, setSocket] = useState(null);
    const [connected, setConnected] = useState(false);

    // Separate slices on purpose: operator state fires after almost every server
    // mutation and the media playhead streams continuously. Keeping them apart
    // stops a playhead tick from re-rendering the whole button grid.
    const [operatorState, setOperatorState] = useState(null);
    const [presMeta, setPresMeta] = useState(EMPTY_PRES_META);
    const [layout, setLayout] = useState(null);
    const [rundown, setRundown] = useState([]);
    const [mediaTime, setMediaTime] = useState(0);
    const [toast, setToast] = useState(null);
    const [pending, setPending] = useState({});

    const [pageIndex, setPageIndex] = useState(0);
    const [showCues, setShowCues] = useState(false);
    const [clickEnabled, setClickEnabled] = useState(isPadClickEnabled);
    const [isPortrait, setIsPortrait] = useState(
        () => typeof window !== 'undefined' && window.matchMedia?.('(orientation: portrait)').matches
    );

    // The controller window owns the theme for its own pages; this one is on its
    // own. Default to dark — a bright tablet in a blacked-out hall is unusable.
    useEffect(() => {
        const stored = localStorage.getItem('bc-theme') || 'dark';
        document.documentElement.classList.toggle('dark', stored !== 'light');
    }, []);

    // Both signals on purpose: the matchMedia `change` event is not reliably
    // delivered on every platform, and a stale orientation leaves the grid stuck at
    // the wrong column count. A rotation always produces a resize.
    useEffect(() => {
        const read = () => setIsPortrait(
            window.matchMedia
                ? window.matchMedia('(orientation: portrait)').matches
                : window.innerHeight >= window.innerWidth
        );
        const query = window.matchMedia?.('(orientation: portrait)');
        query?.addEventListener?.('change', read);
        window.addEventListener('resize', read);
        window.addEventListener('orientationchange', read);
        read();
        return () => {
            query?.removeEventListener?.('change', read);
            window.removeEventListener('resize', read);
            window.removeEventListener('orientationchange', read);
        };
    }, []);

    // Connect once we hold a remote token.
    useEffect(() => {
        if (!remoteToken) return;
        const instance = io(socketOptions(remoteToken));
        setSocket(instance);

        instance.on('connect', () => setConnected(true));
        instance.on('disconnect', () => setConnected(false));
        // A stored token the server no longer honours (expired session, restart, or a
        // network-selection change) would otherwise strand this page on a dead UI with
        // no way back — drop it and fall through to the pairing screen.
        instance.on('connect_error', () => {
            setConnected(false);
            localStorage.removeItem('bc-remote-token');
            localStorage.removeItem('bc-remote-session');
            setRemoteToken('');
        });
        instance.on('operator_state_update', setOperatorState);
        instance.on('pres_meta', (next) => setPresMeta({ ...EMPTY_PRES_META, ...next }));
        instance.on('pad_layout_update', (next) => setLayout(normalizePadLayout(next)));
        instance.on('pad_rundown_update', (list) => setRundown(Array.isArray(list) ? list : []));
        instance.on('media_time_update', (data) => setMediaTime(Number(data?.currentTime) || 0));
        instance.on('action_forbidden', (data) => {
            setToast({ tone: 'error', text: data?.error || 'That action is only available on the main controller.' });
        });
        instance.on('remote_session_revoked', () => {
            localStorage.removeItem('bc-remote-token');
            setRemoteToken('');
        });

        return () => instance.close();
    }, [remoteToken]);

    // Keep the screen awake while operating the show.
    useWakeLock(Boolean(remoteToken));

    useEffect(() => {
        if (!toast) return;
        const timer = setTimeout(() => setToast(null), 3200);
        return () => clearTimeout(timer);
    }, [toast]);

    // Until the desktop publishes one, fall back to the built-in layout so a pad
    // that has never been configured is still useful.
    const activeLayout = layout || DEFAULT_PAD_LAYOUT;
    const page = activeLayout.pages[Math.min(pageIndex, activeLayout.pages.length - 1)] || activeLayout.pages[0];

    // A 6-column grid on a 390px phone gives 55px buttons, which stops being a pad.
    const cols = isPortrait ? Math.min(page?.cols || 5, 3) : (page?.cols || 5);

    // Live refs so the fire handler never closes over a stale snapshot: it is passed
    // to memoised buttons, so recreating it on every state update would defeat memo.
    const stateRef = useRef(operatorState);
    stateRef.current = operatorState;
    const ctxRef = useRef({ presMeta, mediaTime });
    ctxRef.current = { presMeta, mediaTime };

    // Relayed commands are acked by the server. A missing ack is treated as failure
    // so a button can never look like it worked when nothing was delivered.
    const sendCommand = useCallback((command, key) => {
        if (!socket) return;
        setPending(prev => ({ ...prev, [key]: true }));
        let settled = false;
        const finish = (result) => {
            if (settled) return;
            settled = true;
            setPending(prev => {
                const next = { ...prev };
                delete next[key];
                return next;
            });
            if (!result?.ok) {
                setToast({ tone: 'error', text: result?.error || 'The main controller did not respond.' });
            }
        };
        setTimeout(() => finish(null), 3000);
        socket.emit('pad_command', command, finish);
    }, [socket]);

    const fireCue = useCallback((cueId) => {
        sendCommand({ type: 'cue_fire', payload: { cueId } }, `cue:${cueId}`);
    }, [sendCommand]);

    const clickRef = useRef(clickEnabled);
    clickRef.current = clickEnabled;

    const fire = useCallback((button) => {
        if (!socket) return;
        if (clickRef.current) playPadClick();
        const resolved = resolvePadAction(button.action, { state: stateRef.current, ctx: ctxRef.current });
        if (!resolved.ok) {
            setToast({ tone: 'error', text: resolved.error });
            return;
        }

        if (resolved.steps) {
            for (const { event, args } of resolved.steps) {
                // Several server handlers take no argument at all; passing an
                // explicit undefined would still serialise as a null argument.
                if (args === undefined) socket.emit(event);
                else socket.emit(event, args);
            }
            return;
        }

        sendCommand(resolved.command, button.id);
    }, [socket, sendCommand]);

    if (!remoteToken) {
        return <RemotePairing onPaired={(token) => setRemoteToken(token)} title="Control Pad" subtitle="Pair with Main Controller" />;
    }

    return (
        <div
            className="app-bg flex h-dvh flex-col overflow-hidden text-slate-900 dark:text-white"
            style={{
                paddingTop: 'env(safe-area-inset-top)',
                paddingBottom: 'env(safe-area-inset-bottom)',
                paddingLeft: 'env(safe-area-inset-left)',
                paddingRight: 'env(safe-area-inset-right)'
            }}
        >
            <PadStatusBar state={operatorState} presMeta={presMeta} connected={connected} compact={isPortrait} />

            {showCues && (
                <section className="surface-raised max-h-[45%] shrink-0 overflow-y-auto border-b border-slate-500/20 p-3">
                    <div className="mb-2 flex items-center justify-between">
                        <span className="text-xs font-bold uppercase tracking-wider text-slate-500">Run of Show</span>
                        <button onClick={() => setShowCues(false)} className="text-xs font-bold text-slate-500">Close</button>
                    </div>
                    {rundown.length === 0 ? (
                        <p className="text-xs text-slate-500">
                            No cues published. Build a rundown on the main controller&rsquo;s Run of Show tab.
                        </p>
                    ) : (
                        <div className="space-y-1.5">
                            {rundown.map(cue => (
                                <button
                                    key={cue.id}
                                    onClick={() => fireCue(cue.id)}
                                    className="flex w-full items-center gap-3 rounded-lg bg-slate-500/10 px-3 py-3 text-left transition active:scale-[0.99] active:bg-slate-500/20"
                                >
                                    <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${CUE_STATUS_DOT[cue.status] || 'bg-slate-500'}`} />
                                    <span className="min-w-0 flex-1">
                                        <span className="block truncate text-sm font-semibold">{cue.title}</span>
                                        {cue.types?.length > 0 && (
                                            <span className="block truncate text-[10px] uppercase tracking-wider text-slate-500">
                                                {cue.types.join(' · ')}
                                            </span>
                                        )}
                                    </span>
                                    <span className="shrink-0 text-[10px] font-black uppercase tracking-wider text-slate-500">
                                        {cue.status}
                                    </span>
                                </button>
                            ))}
                        </div>
                    )}
                </section>
            )}

            <main className="flex-1 overflow-y-auto p-3">
                {page?.buttons?.length ? (
                    <div
                        className="grid gap-3 auto-rows-[minmax(92px,1fr)]"
                        style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
                    >
                        {page.buttons.map(button => (
                            <PadButton
                                key={button.id}
                                button={button}
                                disabled={!connected || !isPadActionAvailable(button.action, { state: operatorState, ctx: { presMeta, mediaTime } })}
                                active={getPadButtonActive(button, { state: operatorState, ctx: { presMeta } })}
                                pending={Boolean(pending[button.id])}
                                // Passed by reference, not as an inline arrow. `fire` is kept
                                // stable via live refs specifically so PadButton's memo holds;
                                // a fresh closure here made memo a no-op and repainted every
                                // key on every mediaTime tick. PadButton calls onFire(button).
                                onFire={fire}
                            />
                        ))}
                    </div>
                ) : (
                    <div className="flex h-full items-center justify-center px-6 text-center text-sm font-semibold text-slate-500">
                        This page has no buttons yet. Add some on the main controller&rsquo;s Pad Layout tab.
                    </div>
                )}
            </main>

            <nav className="surface-raised flex shrink-0 items-center gap-2 px-3 py-2">
                <div className="flex min-w-0 flex-1 items-center gap-2 overflow-x-auto">
                    {activeLayout.pages.map((item, index) => (
                        <button
                            key={item.id}
                            onClick={() => setPageIndex(index)}
                            className={`shrink-0 rounded-lg px-4 py-2 text-xs font-bold uppercase tracking-wider transition active:scale-95 ${
                                index === pageIndex
                                    ? 'bg-blue-600 text-white'
                                    : 'bg-slate-500/10 text-slate-600 dark:text-slate-300'
                            }`}
                        >
                            {item.name}
                        </button>
                    ))}
                </div>
                <button
                    onClick={() => {
                        const next = !clickEnabled;
                        setClickEnabled(next);
                        setPadClickEnabled(next);
                        // Play immediately: this click is inside the user gesture
                        // iOS requires to unlock the audio context.
                        if (next) playPadClick();
                    }}
                    title="Click sound on button press"
                    className={`shrink-0 rounded-lg px-3 py-2 text-xs font-bold uppercase tracking-wider transition active:scale-95 ${
                        clickEnabled ? 'bg-emerald-600 text-white' : 'bg-slate-500/10 text-slate-600 dark:text-slate-300'
                    }`}
                >
                    {clickEnabled ? 'Click On' : 'Click Off'}
                </button>
                <button
                    onClick={() => setShowCues(value => !value)}
                    className={`shrink-0 rounded-lg px-4 py-2 text-xs font-bold uppercase tracking-wider transition active:scale-95 ${
                        showCues ? 'bg-amber-500 text-black' : 'bg-slate-500/10 text-slate-600 dark:text-slate-300'
                    }`}
                >
                    Cues{rundown.length ? ` (${rundown.length})` : ''}
                </button>
            </nav>

            {toast && (
                <div
                    className={`pointer-events-none fixed inset-x-4 bottom-20 z-20 rounded-xl px-4 py-3 text-center text-sm font-bold shadow-lg ${
                        toast.tone === 'error' ? 'bg-red-600 text-white' : 'bg-emerald-600 text-white'
                    }`}
                >
                    {toast.text}
                </div>
            )}
        </div>
    );
}
