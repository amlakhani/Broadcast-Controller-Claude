import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, Grid3x3, Library, Monitor, MonitorOff } from 'lucide-react';
import { getRemoteToken, socketOptions } from './auth';
import LazyMount from './components/LazyMount';
import RemotePairing from './components/RemotePairing';
import { peekFragmentPairingCode } from './utils/pairing';
import { useWakeLock } from './utils/useWakeLock';
import { getDeckType, normalizeSlideCount, parseSourceUrl, resolveDeckUrl, slideImageUrl } from './utils/presentation';

const EMPTY_META = {
    mode: 'none',
    baseUrl: '',
    slideId: '',
    currentIdx: 0,
    totalSlides: 0,
    isCanva: false,
    showing: false,
    deckId: ''
};

// How far ahead/behind the current slide to keep warm in the background so a tap
// on Next/Prev is a cache hit instead of a fresh multi-hundred-KB download over
// Wi-Fi. Asymmetric because the operator moves forward far more often than back.
const PRELOAD_AHEAD = 10;
const PRELOAD_BEHIND = 3;
// Caps how many decoded slide bitmaps this tab keeps resident at once, so a
// 100+ slide deck doesn't just grow forever as the operator moves through it.
const WARM_CAP = 24;

// Renders one slide. Image decks pull a single slide over HTTP so the phone
// never downloads the whole deck; URL decks use a scaled-down embed.
// `thumb` requests the pre-generated ~320px grid thumbnail instead of the
// full-resolution slide — only the "All Slides" grid tiles set it; the live/
// prev/next tiles stay full-res since those are what actually go on air.
function SlideTile({ meta, index, label, thumb = false }) {
    const outOfRange = index < 0 || index >= meta.totalSlides;
    // A deck can briefly be in 'images' mode before its first pres_meta (and thus
    // deckId) arrives; without this guard that renders a slide URL with no `?v=`,
    // which still works but skips the immutable-cache path this component exists for.
    const missingDeckId = meta.mode === 'images' && !meta.deckId;
    const unavailable = meta.mode === 'none' || outOfRange || missingDeckId || (meta.isCanva && index !== meta.currentIdx);

    if (unavailable) {
        return (
            <div className="flex h-full w-full items-center justify-center text-[10px] font-bold uppercase tracking-widest text-slate-600">
                {meta.mode === 'none' ? 'No Deck' : 'End'}
            </div>
        );
    }

    if (meta.mode === 'images') {
        return (
            <img
                src={slideImageUrl(index, meta.deckId, thumb ? { w: 320 } : {})}
                alt={label}
                decoding="async"
                className="h-full w-full object-contain"
            />
        );
    }

    const src = meta.isCanva ? meta.baseUrl : `${meta.baseUrl}${index + 1}`;
    return (
        <iframe
            src={src}
            title={label}
            className="absolute left-0 top-0 h-[1000%] w-[1000%] origin-top-left scale-[0.1] border-none"
            style={{ pointerEvents: 'none' }}
        />
    );
}

export default function RemoteSlidesApp() {
    // A freshly scanned QR always wins over a stored token, so re-scanning is a reliable
    // way to recover from an expired session (they last 8h) or a server restart.
    const [remoteToken, setRemoteToken] = useState(() => (peekFragmentPairingCode() ? '' : getRemoteToken()));
    const [socket, setSocket] = useState(null);
    const [connected, setConnected] = useState(false);
    const [meta, setMeta] = useState(EMPTY_META);
    const [library, setLibrary] = useState([]);
    const [panel, setPanel] = useState(null); // 'grid' | 'library' | null
    // True once a pres_goto has gone unacknowledged for >1200ms — tells the operator
    // whether a stalled Next is the phone's problem or the desk's, instead of a dead
    // button with no feedback either way.
    const [awaitingAck, setAwaitingAck] = useState(false);
    const pendingIndexRef = useRef(null);
    const flushTimerRef = useRef(null);
    const ackWarnTimerRef = useRef(null);

    const clearPending = useCallback(() => {
        pendingIndexRef.current = null;
        setAwaitingAck(false);
        if (ackWarnTimerRef.current) {
            clearTimeout(ackWarnTimerRef.current);
            ackWarnTimerRef.current = null;
        }
    }, []);

    // Connect once we hold a remote token.
    useEffect(() => {
        if (!remoteToken) return;
        const instance = io(socketOptions(remoteToken));
        setSocket(instance);

        instance.on('connect', () => setConnected(true));
        instance.on('disconnect', () => setConnected(false));
        // A stored token the server no longer honours (expired session, restart, or a
        // network-selection change) would otherwise strand this page on a dead UI with no
        // way back — drop it and fall through to the pairing screen.
        instance.on('connect_error', () => {
            setConnected(false);
            localStorage.removeItem('bc-remote-token');
            localStorage.removeItem('bc-remote-session');
            setRemoteToken('');
        });
        instance.on('pres_meta', (next) => {
            setMeta({ ...EMPTY_META, ...next });
            // Any pres_meta is the desk telling us something -- whether it matches the
            // index we asked for or reflects a clamp, the wait is over either way.
            clearPending();
        });
        instance.on('pres_library_update', (list) => setLibrary(Array.isArray(list) ? list : []));
        instance.on('remote_session_revoked', () => {
            localStorage.removeItem('bc-remote-token');
            setRemoteToken('');
        });

        return () => instance.close();
    }, [remoteToken, clearPending]);

    // Keep the screen awake while operating the show.
    useWakeLock(Boolean(remoteToken));

    // Keep ~10 slides ahead and 3 behind warm in the background, so Next/Prev is a
    // cache hit instead of a fresh download. `new Image()` shares the browser's HTTP
    // cache (and sends the session cookie) with the visible <img> tiles, and holding
    // the element keeps the *decoded* bitmap resident — which is what makes the swap
    // instant rather than merely fast. Keyed on deckId so a new deck's slides can
    // never be confused with the old one's, even at the same index.
    const warmRef = useRef(new Map());
    useEffect(() => {
        if (meta.mode !== 'images' || !meta.deckId || !meta.totalSlides) return;
        const map = warmRef.current;

        // Deck changed: drop every entry from the old deck so its bitmaps can be GC'd.
        for (const key of map.keys()) {
            if (!key.startsWith(`${meta.deckId}:`)) map.delete(key);
        }

        // Priority order: current, +1, -1, +2, -2, ... so the tiles the operator can
        // actually see win the browser's ~6-connection budget over slide +10.
        const wanted = [];
        const maxRank = Math.max(PRELOAD_AHEAD, PRELOAD_BEHIND);
        for (let d = 0; d <= maxRank; d++) {
            if (d === 0) wanted.push(meta.currentIdx);
            else {
                if (d <= PRELOAD_AHEAD) wanted.push(meta.currentIdx + d);
                if (d <= PRELOAD_BEHIND) wanted.push(meta.currentIdx - d);
            }
        }

        wanted
            .filter(i => i >= 0 && i < meta.totalSlides)
            .forEach((i, rank) => {
                const key = `${meta.deckId}:${i}`;
                const existing = map.get(key);
                if (existing) {
                    // LRU touch: re-insert at the end so it's evicted last.
                    map.delete(key);
                    map.set(key, existing);
                    return;
                }
                const img = new Image();
                img.decoding = 'async';
                if (rank > 2) img.fetchPriority = 'low';
                img.src = slideImageUrl(i, meta.deckId);
                map.set(key, img);
            });

        while (map.size > WARM_CAP) {
            map.delete(map.keys().next().value);
        }
    }, [meta.mode, meta.deckId, meta.currentIdx, meta.totalSlides]);

    const hasSlides = meta.mode !== 'none' && meta.totalSlides > 0;
    // Indexed navigation — the scrubber, the slide grid, first/last, swipe-to-index.
    // Canva supports none of it (no index), but it can still be paged one at a time.
    const canNavigate = hasSlides && !meta.isCanva;
    const canPage = hasSlides;
    const deckType = meta.mode === 'images' ? 'Image Deck' : meta.isCanva ? 'Canva' : meta.mode === 'url' ? 'Google Slides' : 'No Deck';

    // Sends the pending index after a short coalescing window, so a burst of taps
    // (or a fast drag on the scrubber) collapses into a single pres_goto instead of
    // one per tap — the server would happily apply all of them, but there is no
    // reason to make it. Absolute indices are what make this safe to coalesce:
    // unlike 'direction: next' repeated ten times, 'index: n+10' sent once is
    // exactly equivalent.
    const gotoIndex = useCallback((rawIndex) => {
        if (!socket || !hasSlides || meta.isCanva || meta.totalSlides <= 0) return;
        const index = Math.max(0, Math.min(rawIndex, meta.totalSlides - 1));
        setMeta(m => (m.currentIdx === index ? m : { ...m, currentIdx: index })); // optimistic
        pendingIndexRef.current = index;
        if (ackWarnTimerRef.current) clearTimeout(ackWarnTimerRef.current);
        ackWarnTimerRef.current = setTimeout(() => setAwaitingAck(true), 1200);
        if (flushTimerRef.current) return;
        flushTimerRef.current = setTimeout(() => {
            flushTimerRef.current = null;
            if (pendingIndexRef.current != null) socket.emit('pres_goto', { index: pendingIndexRef.current });
        }, 40);
    }, [socket, hasSlides, meta.isCanva, meta.totalSlides]);

    const goRelative = useCallback((direction) => {
        if (!hasSlides) return;
        // Canva has no index to scrub to — next/prev are relayed to the output window
        // as a keystroke into the embed, so the phone can still page the deck even
        // though the scrubber, first/last and the grid stay unavailable for it.
        if (meta.isCanva) {
            if (direction === 'next' || direction === 'prev') socket?.emit('pres_canva_nav', direction);
            return;
        }
        let idx = meta.currentIdx;
        if (direction === 'next') idx += 1;
        else if (direction === 'prev') idx -= 1;
        else if (direction === 'first') idx = 0;
        else if (direction === 'last') idx = meta.totalSlides - 1;
        else return;
        gotoIndex(idx);
    }, [socket, hasSlides, meta.isCanva, meta.currentIdx, meta.totalSlides, gotoIndex]);

    const setShowing = useCallback((showing) => {
        if (!socket || !hasSlides) return;
        setMeta(m => ({ ...m, showing })); // optimistic, mirrors gotoIndex above
        socket.emit('pres_set_showing', showing);
    }, [socket, hasSlides]);

    const loadDeck = useCallback(async (item) => {
        if (!socket) return;
        // Library entries saved before short links were expanded can still hold a
        // canva.link URL, so the redirect hop has to happen here too.
        const resolved = await resolveDeckUrl(item.url || '');
        if (resolved.error) {
            alert(resolved.error);
            return;
        }
        const parsed = parseSourceUrl(resolved.url, normalizeSlideCount(item.totalSlides));
        if (!parsed?.state) return;
        socket.emit('pres_update', parsed.state);
        setPanel(null);
    }, [socket]);

    // Swipe left/right on the preview to change slides. Guards against a vertical
    // scroll being misread as a swipe by requiring the horizontal move to dominate.
    const touchStartRef = useRef(null);
    const onTouchStart = (e) => {
        const t = e.touches[0];
        touchStartRef.current = t ? { x: t.clientX, y: t.clientY } : null;
    };
    const onTouchEnd = (e) => {
        const start = touchStartRef.current;
        touchStartRef.current = null;
        if (!start || !canPage) return;
        const end = e.changedTouches[0];
        if (!end) return;
        const dx = end.clientX - start.x;
        const dy = end.clientY - start.y;
        if (Math.abs(dx) < 50 || Math.abs(dy) > Math.abs(dx)) return;
        goRelative(dx < 0 ? 'next' : 'prev');
    };

    const slideNumbers = useMemo(
        () => Array.from({ length: meta.totalSlides }, (_, i) => i),
        [meta.totalSlides]
    );

    if (!remoteToken) {
        return <RemotePairing onPaired={(token) => setRemoteToken(token)} subtitle="Slides Remote" />;
    }

    const navButton = 'flex items-center justify-center rounded-xl font-bold transition active:scale-95 disabled:cursor-not-allowed disabled:opacity-30';

    return (
        <div className="app-bg mx-auto flex h-dvh max-w-md flex-col overflow-y-auto text-slate-900 dark:text-white landscape:max-w-[1400px]" style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}>
            {/* Header */}
            <header className="surface-raised sticky top-0 z-10 flex shrink-0 items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                    <div className="truncate text-sm font-bold">{deckType}</div>
                    <div className="text-[11px] font-semibold text-slate-500">
                        {hasSlides ? `Slide ${meta.currentIdx + 1} of ${meta.totalSlides}` : 'Nothing loaded'}
                    </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                    {meta.showing && hasSlides && (
                        <span className="rounded-md bg-red-600 px-2 py-1 text-[10px] font-black uppercase tracking-wider text-white">On Air</span>
                    )}
                    {awaitingAck && (
                        <span
                            title="Waiting on the desk to confirm the last slide change"
                            className="h-2.5 w-2.5 animate-pulse rounded-full bg-amber-500"
                        />
                    )}
                    <span
                        title={connected ? 'Connected' : 'Disconnected'}
                        className={`h-2.5 w-2.5 rounded-full ${connected ? 'bg-emerald-500' : 'bg-slate-500'}`}
                    />
                </div>
            </header>

            {/* Previews + navigation: stacked in portrait, side-by-side in landscape so a
                wide-but-short tablet screen never forces vertical scrolling to reach controls. */}
            <div className="flex flex-1 flex-col landscape:flex-row landscape:overflow-hidden">
                {/* Previews */}
                <div
                    className="space-y-2 p-3 landscape:flex landscape:flex-1 landscape:flex-col landscape:justify-center landscape:overflow-y-auto"
                    style={{ touchAction: 'pan-y', WebkitUserSelect: 'none', userSelect: 'none' }}
                    onTouchStart={onTouchStart}
                    onTouchEnd={onTouchEnd}
                >
                    <div className="relative aspect-video overflow-hidden rounded-xl border-2 border-emerald-500 bg-black">
                        {/* Keyed on deckId (not index) so React patches `src` in place across a
                            nav within the same deck — the previous slide stays painted until the
                            new one is ready — but remounts cleanly when the deck itself changes. */}
                        <SlideTile key={meta.deckId} meta={meta} index={meta.currentIdx} label="Live slide" />
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                        {[['Previous', meta.currentIdx - 1], ['Next', meta.currentIdx + 1]].map(([label, idx]) => (
                            <div key={label}>
                                <div className="mb-1 text-[10px] font-bold uppercase tracking-widest text-slate-500">{label}</div>
                                <div className="relative aspect-video overflow-hidden rounded-lg border border-slate-300 bg-black dark:border-slate-700">
                                    <SlideTile key={meta.deckId} meta={meta} index={idx} label={label} />
                                </div>
                            </div>
                        ))}
                    </div>
                </div>

                {/* Navigation: sticky to the bottom of the scroll container in portrait, so
                    it never scrolls out of reach — a fixed sidebar in landscape already. */}
                <div className="remote-nav-sticky sticky bottom-0 z-10 mt-auto space-y-2 p-3 landscape:static landscape:mt-0 landscape:w-72 landscape:shrink-0 landscape:self-stretch landscape:overflow-y-auto landscape:border-l landscape:border-slate-500/20 landscape:flex landscape:flex-col landscape:justify-center">
                    <div className="flex gap-2">
                        <button
                            onClick={() => goRelative('prev')}
                            disabled={!canPage || (!meta.isCanva && meta.currentIdx <= 0)}
                            className={`${navButton} h-20 flex-1 bg-slate-500/15 text-lg active:bg-slate-500/25`}
                        >
                            <ChevronLeft className="h-8 w-8" />
                        </button>
                        <button
                            onClick={() => goRelative('next')}
                            disabled={!canPage || (!meta.isCanva && meta.currentIdx >= meta.totalSlides - 1)}
                            className={`${navButton} h-20 flex-[2] bg-blue-600 text-white active:bg-blue-500`}
                        >
                            <ChevronRight className="h-9 w-9" />
                        </button>
                    </div>

                    <div className="grid grid-cols-4 gap-2">
                        <button onClick={() => goRelative('first')} disabled={!canNavigate || meta.currentIdx <= 0}
                            className={`${navButton} h-12 bg-slate-500/10 text-xs`}>
                            <ChevronsLeft className="h-4 w-4" />
                        </button>
                        <button onClick={() => goRelative('last')} disabled={!canNavigate || meta.currentIdx >= meta.totalSlides - 1}
                            className={`${navButton} h-12 bg-slate-500/10 text-xs`}>
                            <ChevronsRight className="h-4 w-4" />
                        </button>
                        <button onClick={() => setPanel(panel === 'grid' ? null : 'grid')} disabled={!hasSlides}
                            className={`${navButton} h-12 text-xs ${panel === 'grid' ? 'bg-amber-500 text-white' : 'bg-slate-500/10'}`}>
                            <Grid3x3 className="h-4 w-4" />
                        </button>
                        <button onClick={() => setPanel(panel === 'library' ? null : 'library')}
                            className={`${navButton} h-12 text-xs ${panel === 'library' ? 'bg-amber-500 text-white' : 'bg-slate-500/10'}`}>
                            <Library className="h-4 w-4" />
                        </button>
                    </div>

                    <button
                        onClick={() => setShowing(!meta.showing)}
                        disabled={!hasSlides}
                        className={`${navButton} h-14 w-full text-sm uppercase tracking-wider text-white ${meta.showing ? 'bg-red-600 active:bg-red-500' : 'bg-emerald-600 active:bg-emerald-500'}`}
                    >
                        {meta.showing ? <><MonitorOff className="mr-2 h-5 w-5" /> Take Down</> : <><Monitor className="mr-2 h-5 w-5" /> Go Live</>}
                    </button>
                </div>
            </div>

            {/* All slides grid / Deck library: a bottom sheet over a dismiss-on-tap
                scrim, rather than an inline panel. Inline used to push the sticky nav
                bar itself off-screen and force the whole page to scroll to reach it —
                a sheet floats above everything else instead, so Prev/Next stay put. */}
            {panel && (
                <div
                    className="fixed inset-0 z-30 bg-black/40"
                    onClick={() => setPanel(null)}
                >
                    <div
                        className="surface-raised absolute inset-x-0 bottom-0 max-h-[70dvh] overflow-y-auto rounded-t-2xl p-3 shadow-2xl"
                        style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 0.75rem)' }}
                        onClick={(e) => e.stopPropagation()}
                    >
                        <div className="mx-auto mb-2 h-1.5 w-10 shrink-0 rounded-full bg-slate-500/30" />

                        {panel === 'grid' && (
                            <>
                                <div className="mb-2 text-xs font-bold uppercase tracking-wider text-slate-500">All Slides</div>
                                <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
                                    {slideNumbers.map(i => (
                                        <button key={`${i}-${meta.deckId}`} onClick={() => { gotoIndex(i); setPanel(null); }}
                                            className={`relative aspect-video overflow-hidden rounded-lg border-2 bg-black transition ${i === meta.currentIdx ? 'border-emerald-500' : 'border-transparent'}`}>
                                            <LazyMount className="absolute inset-0">
                                                <SlideTile meta={meta} index={i} label={`Slide ${i + 1}`} thumb />
                                            </LazyMount>
                                            <span className="absolute bottom-0 right-0 bg-black/70 px-1.5 py-0.5 text-[10px] font-bold text-white">{i + 1}</span>
                                        </button>
                                    ))}
                                </div>
                            </>
                        )}

                        {panel === 'library' && (
                            <>
                                <div className="mb-2 text-xs font-bold uppercase tracking-wider text-slate-500">Deck Library</div>
                                {library.length === 0 ? (
                                    <p className="text-xs text-slate-500">No saved decks. Save a deck on the main controller's Slides tab.</p>
                                ) : (
                                    <div className="space-y-1.5">
                                        {library.map(item => {
                                            const isImageDeck = item.mode === 'images' || item.type === 'Image Deck';
                                            return (
                                                <button key={item.id} onClick={() => !isImageDeck && loadDeck(item)} disabled={isImageDeck}
                                                    title={isImageDeck ? 'Image decks can only be loaded from the main controller' : undefined}
                                                    className={`flex w-full items-center justify-between gap-3 rounded-lg px-3 py-3 text-left transition ${isImageDeck ? 'cursor-not-allowed bg-slate-500/5 opacity-50' : 'bg-slate-500/10 active:bg-slate-500/20'}`}>
                                                    <div className="min-w-0">
                                                        <div className="truncate text-sm font-semibold">{item.name}</div>
                                                        <div className="text-[10px] text-slate-500">{getDeckType(item)} · {item.totalSlides || 1} slides{isImageDeck ? ' · controller only' : ''}</div>
                                                    </div>
                                                    <ChevronRight className="h-4 w-4 shrink-0 text-slate-500" />
                                                </button>
                                            );
                                        })}
                                    </div>
                                )}
                            </>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}
