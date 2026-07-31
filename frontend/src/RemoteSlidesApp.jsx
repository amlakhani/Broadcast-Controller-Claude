import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, Grid3x3, Library, Monitor, MonitorOff } from 'lucide-react';
import { authUrl, getRemoteToken, socketOptions } from './auth';
import RemotePairing, { peekFragmentPairingCode } from './components/RemotePairing';
import { getDeckType, normalizeSlideCount, parseSourceUrl } from './utils/presentation';

const EMPTY_META = {
    mode: 'none',
    baseUrl: '',
    slideId: '',
    currentIdx: 0,
    totalSlides: 0,
    isCanva: false,
    showing: false
};

// Renders one slide. Image decks pull a single slide over HTTP so the phone
// never downloads the whole deck; URL decks use a scaled-down embed.
function SlideTile({ meta, index, label }) {
    const outOfRange = index < 0 || index >= meta.totalSlides;
    const unavailable = meta.mode === 'none' || outOfRange || (meta.isCanva && index !== meta.currentIdx);

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
                src={authUrl(`/api/presentation/slide/${index}`)}
                alt={label}
                loading="lazy"
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

// Mounts children only once scrolled into view — keeps a 40-slide grid from
// spinning up 40 Google Slides iframes at once.
function LazyMount({ children, className }) {
    const ref = useRef(null);
    const [visible, setVisible] = useState(false);

    useEffect(() => {
        const node = ref.current;
        if (!node || visible) return;
        if (typeof IntersectionObserver === 'undefined') {
            setVisible(true);
            return;
        }
        const observer = new IntersectionObserver((entries) => {
            if (entries.some(entry => entry.isIntersecting)) {
                setVisible(true);
                observer.disconnect();
            }
        }, { rootMargin: '200px' });
        observer.observe(node);
        return () => observer.disconnect();
    }, [visible]);

    return <div ref={ref} className={className}>{visible ? children : null}</div>;
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
        instance.on('pres_meta', (next) => setMeta({ ...EMPTY_META, ...next }));
        instance.on('pres_library_update', (list) => setLibrary(Array.isArray(list) ? list : []));
        instance.on('remote_session_revoked', () => {
            localStorage.removeItem('bc-remote-token');
            setRemoteToken('');
        });

        return () => instance.close();
    }, [remoteToken]);

    // Keep the screen awake while operating the show.
    useEffect(() => {
        if (!remoteToken || typeof navigator === 'undefined' || !navigator.wakeLock) return;
        let sentinel = null;
        let cancelled = false;

        const acquire = async () => {
            try {
                sentinel = await navigator.wakeLock.request('screen');
            } catch {
                // Unsupported or denied — not fatal.
            }
        };

        const onVisibility = () => {
            if (document.visibilityState === 'visible' && !cancelled) acquire();
        };

        acquire();
        document.addEventListener('visibilitychange', onVisibility);
        return () => {
            cancelled = true;
            document.removeEventListener('visibilitychange', onVisibility);
            sentinel?.release?.().catch(() => {});
        };
    }, [remoteToken]);

    const hasSlides = meta.mode !== 'none' && meta.totalSlides > 0;
    const canNavigate = hasSlides && !meta.isCanva;
    const deckType = meta.mode === 'images' ? 'Image Deck' : meta.isCanva ? 'Canva' : meta.mode === 'url' ? 'Google Slides' : 'No Deck';

    const go = useCallback((payload) => {
        if (!socket || !hasSlides) return;
        socket.emit('pres_goto', payload);
    }, [socket, hasSlides]);

    const setShowing = useCallback((showing) => {
        if (!socket || !hasSlides) return;
        socket.emit('pres_set_showing', showing);
    }, [socket, hasSlides]);

    const loadDeck = useCallback((item) => {
        if (!socket) return;
        const parsed = parseSourceUrl(item.url || '', normalizeSlideCount(item.totalSlides));
        if (!parsed?.state) return;
        socket.emit('pres_update', parsed.state);
        setPanel(null);
    }, [socket]);

    // Swipe left/right on the preview to change slides.
    const touchStartRef = useRef(null);
    const onTouchStart = (e) => { touchStartRef.current = e.touches[0]?.clientX ?? null; };
    const onTouchEnd = (e) => {
        const start = touchStartRef.current;
        touchStartRef.current = null;
        if (start == null || !canNavigate) return;
        const delta = (e.changedTouches[0]?.clientX ?? start) - start;
        if (Math.abs(delta) < 50) return;
        go({ direction: delta < 0 ? 'next' : 'prev' });
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
                <div className="space-y-2 p-3 landscape:flex landscape:flex-1 landscape:flex-col landscape:justify-center landscape:overflow-y-auto" onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
                    <div className="relative aspect-video overflow-hidden rounded-xl border-2 border-emerald-500 bg-black">
                        <SlideTile meta={meta} index={meta.currentIdx} label="Live slide" />
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                        {[['Previous', meta.currentIdx - 1], ['Next', meta.currentIdx + 1]].map(([label, idx]) => (
                            <div key={label}>
                                <div className="mb-1 text-[10px] font-bold uppercase tracking-widest text-slate-500">{label}</div>
                                <div className="relative aspect-video overflow-hidden rounded-lg border border-slate-300 bg-black dark:border-slate-700">
                                    <SlideTile meta={meta} index={idx} label={label} />
                                </div>
                            </div>
                        ))}
                    </div>
                </div>

                {/* Navigation */}
                <div className="mt-auto space-y-2 p-3 landscape:mt-0 landscape:w-72 landscape:shrink-0 landscape:self-stretch landscape:overflow-y-auto landscape:border-l landscape:border-slate-500/20 landscape:flex landscape:flex-col landscape:justify-center">
                    <div className="flex gap-2">
                        <button
                            onClick={() => go({ direction: 'prev' })}
                            disabled={!canNavigate || meta.currentIdx <= 0}
                            className={`${navButton} h-20 flex-1 bg-slate-500/15 text-lg active:bg-slate-500/25`}
                        >
                            <ChevronLeft className="h-8 w-8" />
                        </button>
                        <button
                            onClick={() => go({ direction: 'next' })}
                            disabled={!canNavigate || meta.currentIdx >= meta.totalSlides - 1}
                            className={`${navButton} h-20 flex-[2] bg-blue-600 text-white active:bg-blue-500`}
                        >
                            <ChevronRight className="h-9 w-9" />
                        </button>
                    </div>

                    <div className="grid grid-cols-4 gap-2">
                        <button onClick={() => go({ direction: 'first' })} disabled={!canNavigate || meta.currentIdx <= 0}
                            className={`${navButton} h-12 bg-slate-500/10 text-xs`}>
                            <ChevronsLeft className="h-4 w-4" />
                        </button>
                        <button onClick={() => go({ direction: 'last' })} disabled={!canNavigate || meta.currentIdx >= meta.totalSlides - 1}
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

            {/* All slides grid */}
            {panel === 'grid' && (
                <div className="surface-raised max-h-[55vh] shrink-0 overflow-y-auto border-t border-slate-500/20 p-3">
                    <div className="mb-2 text-xs font-bold uppercase tracking-wider text-slate-500">All Slides</div>
                    <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
                        {slideNumbers.map(i => (
                            <button key={i} onClick={() => { go({ index: i }); setPanel(null); }}
                                className={`relative aspect-video overflow-hidden rounded-lg border-2 bg-black transition ${i === meta.currentIdx ? 'border-emerald-500' : 'border-transparent'}`}>
                                <LazyMount className="absolute inset-0">
                                    <SlideTile meta={meta} index={i} label={`Slide ${i + 1}`} />
                                </LazyMount>
                                <span className="absolute bottom-0 right-0 bg-black/70 px-1.5 py-0.5 text-[10px] font-bold text-white">{i + 1}</span>
                            </button>
                        ))}
                    </div>
                </div>
            )}

            {/* Deck library */}
            {panel === 'library' && (
                <div className="surface-raised max-h-[55vh] shrink-0 overflow-y-auto border-t border-slate-500/20 p-3">
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
                </div>
            )}
        </div>
    );
}
