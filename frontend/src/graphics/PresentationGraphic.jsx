import { useState, useEffect, useRef } from 'react';
import { LAYER_Z } from './layerZ';
import { slideImageUrl } from '../utils/presentation';

// Resolves the URL for an image-deck slide. Prefers the cacheable HTTP endpoint
// (keyed on deckId, so four windows decoding the same nav no longer means four
// copies of a multi-MB base64 string retained in React state) and falls back to
// the inline data: URL that used to be the only option — covers a server that
// hasn't attached a deckId yet (a stale build, or a pre-migration
// restore_recent_clear snapshot), so this is always at least as good as before.
function imageUrlFor(state) {
    if (!state || state.mode !== 'images') return '';
    if (state.deckId) return slideImageUrl(state.currentIdx, state.deckId);
    return state.images?.[state.currentIdx] || '';
}

export default function PresentationGraphic({ socket, windowMode, isStageDisplaySlot = false, stagePresActive: propStagePresActive, presentationState, isPreview = false }) {
    const [presState, setPresState] = useState(null);
    const [internalStagePresActive, setInternalStagePresActive] = useState(false);

    // Use prop if provided, otherwise use internal state
    const stagePresActive = propStagePresActive !== undefined ? propStagePresActive : internalStagePresActive;
    const effectivePresState = presentationState || presState;

    // Read by the keyboard handler below without being a dependency of the effect
    // that registers it -- see that effect's comment for why that distinction matters.
    const stateRef = useRef(effectivePresState);
    useEffect(() => { stateRef.current = effectivePresState; }, [effectivePresState]);

    // Subscribed once per socket/windowMode, never torn down on a slide change.
    // Previously `effectivePresState` sat in this effect's dependency array, so
    // socket.off/socket.on ran on *every single navigation*. A pres_update landing
    // in that brief teardown window was silently dropped, and nothing ever resent
    // it -- the output held the old slide until a manual reload (which "worked"
    // only because reloading retriggers the server's connect-time state replay).
    // That dropped-event race was the actual cause of a slide getting permanently
    // stuck on air.
    useEffect(() => {
        if (!socket) return;

        const handlePresUpdate = (state) => setPresState(state);
        const handleStageToggle = (state) => {
            if (windowMode === 'stage') setInternalStagePresActive(state);
        };

        socket.on('pres_update', handlePresUpdate);
        socket.on('stage_pres_toggle_update', handleStageToggle);

        return () => {
            socket.off('pres_update', handlePresUpdate);
            socket.off('stage_pres_toggle_update', handleStageToggle);
        };
    }, [socket, windowMode]);

    // Self-healing safety net for whatever residual race can still leave this instance's
    // pres_update subscription out of sync (observed specifically on the doubly-nested Live
    // Preview iframe: correct on the very first slide, then never updates again until the
    // whole app is restarted). pres_meta is broadcast unscoped to every connected socket on
    // every genuine navigation (see server.js's emitPresMeta, target defaults to the whole
    // io instance, not room-scoped like pres_update) — so it's a reliable heartbeat even for
    // a socket that's silently stopped receiving room broadcasts. If it disagrees with what
    // this instance is currently holding, pull a fresh copy directly instead of waiting on
    // some future pres_update that might have the same delivery problem. This turns "stuck
    // until manually restarted" into "self-corrects within one navigation cycle".
    useEffect(() => {
        if (!socket) return;

        const handlePresMeta = (meta) => {
            setPresState((prev) => {
                if (!prev && meta.mode === 'none') return prev; // nothing loaded yet, nothing to reconcile
                const stale = !prev
                    || prev.mode !== meta.mode
                    || prev.currentIdx !== meta.currentIdx
                    || prev.showing !== meta.showing
                    || prev.deckId !== meta.deckId;
                if (stale) socket.emit('request_pres_state');
                return prev; // handlePresUpdate above applies the actual resync when it arrives
            });
        };

        socket.on('pres_meta', handlePresMeta);
        return () => socket.off('pres_meta', handlePresMeta);
    }, [socket]);

    // Keyboard shortcuts, also registered once and left alone across navigation.
    // Reads live state through the ref above instead of depending on it directly.
    useEffect(() => {
        if (!socket || windowMode === 'stage') return;

        const handleKeyDown = (e) => {
            const state = stateRef.current;
            if (!state || state.mode === 'none' || !state.showing) return;

            if (e.key === 'ArrowRight' || e.key === ' ' || e.key === 'PageDown') socket.emit('pres_nav', 'next');
            if (e.key === 'ArrowLeft' || e.key === 'PageUp') socket.emit('pres_nav', 'prev');
            if (e.key === 'Home') socket.emit('pres_nav', 'first');
            if (e.key === 'End') socket.emit('pres_nav', 'last');
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [socket, windowMode]);

    // Keep the neighbouring slide warm on the output side too. Only ±1 -- unlike
    // the phone remote, the operator can only ever advance one slide at a time
    // here, and this is a local/LAN link, so there's no latency budget to spend
    // preloading ten slides deep.
    useEffect(() => {
        if (!effectivePresState || effectivePresState.mode !== 'images' || !effectivePresState.deckId) return;
        const { currentIdx, totalSlides, deckId } = effectivePresState;
        [currentIdx - 1, currentIdx + 1].forEach((i) => {
            if (i < 0 || i >= totalSlides) return;
            const img = new Image();
            img.decoding = 'async';
            img.src = slideImageUrl(i, deckId);
        });
    }, [effectivePresState?.mode, effectivePresState?.deckId, effectivePresState?.currentIdx, effectivePresState?.totalSlides]);

    // A/B image buffers: the incoming slide is decoded off-screen before it is
    // ever shown, so the previous slide stays on air until the new one is
    // genuinely ready to paint -- no partially-decoded frame, no visible hitch.
    const [buffers, setBuffers] = useState(['', '']);
    const [front, setFront] = useState(0);
    const desiredImageSrc = imageUrlFor(effectivePresState);

    useEffect(() => {
        if (!desiredImageSrc || desiredImageSrc === buffers[front]) return;
        let cancelled = false;
        const backIndex = front === 0 ? 1 : 0;
        const img = new Image();
        img.decoding = 'async';

        const swap = () => {
            if (cancelled) return;
            setBuffers((prev) => {
                const next = prev.slice();
                next[backIndex] = desiredImageSrc;
                return next;
            });
            setFront(backIndex);
        };

        // A decode that never settles -- a dropped connection mid-fetch, a
        // corrupt frame -- must not leave the old slide on screen forever. That
        // is exactly the failure mode this component exists to close off, so
        // the worst case here is a slightly late swap, never a permanent one.
        const watchdog = setTimeout(swap, 3000);
        img.src = desiredImageSrc;
        const ready = img.decode
            ? img.decode().catch(() => {})
            : new Promise((resolve) => { img.onload = resolve; img.onerror = resolve; });
        ready.then(() => {
            clearTimeout(watchdog);
            swap();
        });

        return () => {
            cancelled = true;
            clearTimeout(watchdog);
        };
        // Deliberately reacting only to the desired src -- buffers/front are
        // read via the updater functions above, not needed as dependencies here.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [desiredImageSrc]);

    const isPresActive = effectivePresState && effectivePresState.mode !== 'none' && (effectivePresState.showing || isStageDisplaySlot);

    if (!effectivePresState || effectivePresState.mode === 'none') return null;

    // Logic for deciding if we render here:
    // If we are in graphics mode, we always render absolute inset-0.
    // If we are in stage mode, we only render if stagePresActive is true AND this instance is inside the slot.
    const hidden = (windowMode === 'stage' && !stagePresActive) || !isPresActive;
    const isUrlDeck = effectivePresState.mode === 'url';

    // Take Down used to unmount this entire subtree -- including all 8 pooled
    // Google Slides iframes -- so every re-take reloaded the deck cold from
    // Google. Chromium doesn't tear down an iframe's document on display:none,
    // only on DOM re-parenting, so keeping url decks mounted-but-hidden makes a
    // re-take instant. Image decks have no live document worth preserving here
    // (their warmth now lives in the HTTP cache via the ±1 prefetch above, and
    // a held-but-hidden decoded bitmap has no upside), so they unmount exactly
    // as before -- and a warm Canva embed left running off-screen would just be
    // idle CPU on the output machine for no benefit.
    if (hidden && !isUrlDeck) return null;

    return (
        <div
            id="pres-overlay"
            className={`bg-black ${isStageDisplaySlot ? 'absolute inset-0 w-full h-full' : 'absolute inset-0'}`}
            style={{ zIndex: LAYER_Z.slides, display: hidden ? 'none' : undefined }}
        >
            {effectivePresState.mode === 'url' && (
                <div id="pres-ifr-pool" className="absolute inset-0">
                    {/* 8 Iframes for pooling */}
                    {[0, 1, 2, 3, 4, 5, 6, 7].map((idx) => {
                        const poolIdx = effectivePresState.currentIdx % 8;
                        const nextIdx = (effectivePresState.currentIdx + 1) % 8;
                        const prevIdx = (effectivePresState.currentIdx - 1 + 8) % 8;

                        let isVisible = false;
                        let zIndex = 0;
                        let src = '';

                        if (idx === poolIdx) {
                            isVisible = true;
                            zIndex = 10;
                            src = effectivePresState.isCanva ? effectivePresState.baseUrl : `${effectivePresState.baseUrl}${effectivePresState.currentIdx + 1}`;
                        } else if (idx === nextIdx && effectivePresState.currentIdx + 1 < effectivePresState.totalSlides) {
                            isVisible = false; // Hidden but loaded
                            zIndex = 1;
                            src = `${effectivePresState.baseUrl}${effectivePresState.currentIdx + 2}`;
                        } else if (idx === prevIdx && effectivePresState.currentIdx - 1 >= 0) {
                            isVisible = false;
                            zIndex = 1;
                            src = `${effectivePresState.baseUrl}${effectivePresState.currentIdx}`;
                        }

                        // We render all 8 but control visibility and z-index to match the V1 logic
                        // React optimizes this because it only patches the src and style
                        //
                        // pointerEvents: 'none' matters here specifically: an operator has to click
                        // the output window to give it OS focus (e.g. to arm a presentation clicker),
                        // and without this, that click can land on the live Google Slides document
                        // and hand IT keyboard focus instead of this window. From that point the
                        // clicker's keys go straight to Google's own slide-advance handling inside the
                        // iframe -- the pixels on screen keep changing, but this app's handleKeyDown
                        // below never fires, so pres_nav never reaches the server and every other
                        // client (remote, desktop panel, Live Preview) is left showing a stale index.
                        const activeStyle = {
                            visibility: isVisible ? 'visible' : 'hidden',
                            zIndex: zIndex,
                            display: (idx === poolIdx || idx === nextIdx || idx === prevIdx) ? 'block' : 'none',
                            pointerEvents: 'none'
                        };

                        return (
                            <iframe 
                                key={idx}
                                id={`pres-ifr-${idx}`} 
                                className="absolute inset-0 w-full h-full border-0"
                                style={activeStyle}
                                src={src || undefined}
                                title={`Presentation Slide ${idx}`}
                            ></iframe>
                        );
                    })}
                </div>
            )}

            {effectivePresState.mode === 'url' && isPreview && (
                // Small always-correct overlay, control-room-facing only (never rendered on the
                // real output/stage/NDI). Google's embedded iframe above is the actual live
                // visual; this badge is just a cheap backstop in case that nested cross-origin
                // iframe ever lags, so the operator isn't left guessing without any confirmation
                // of the true current index.
                <div className="absolute bottom-2 right-2 z-50 rounded bg-black/70 px-2 py-1 text-xs font-bold text-white">
                    Slide {effectivePresState.currentIdx + 1} of {effectivePresState.totalSlides}
                </div>
            )}

            {effectivePresState.mode === 'images' && (
                <div id="pres-img-container" className="absolute inset-0 flex items-center justify-center bg-black">
                    {/* A/B buffers: the back one decodes off-screen (see the effect above)
                        and only becomes `front` once ready, so the slide on air never shows
                        a partially-decoded frame or goes blank mid-swap. No CSS transition
                        here on purpose -- an atomic opacity flip, not a crossfade, because a
                        crossfade would put two different slides on air at once. */}
                    {buffers.map((src, i) => (
                        <img
                            key={i}
                            id={`pres-img-buffer-${i}`}
                            className="absolute inset-0 h-full w-full object-contain"
                            style={{ opacity: i === front ? 1 : 0 }}
                            decoding="async"
                            src={src || ''}
                            alt="Presentation Slide"
                        />
                    ))}
                </div>
            )}
        </div>
    );
}
