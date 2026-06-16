import { useState, useEffect } from 'react';

export default function PresentationGraphic({ socket, windowMode, isStageDisplaySlot = false, stagePresActive: propStagePresActive, presentationState }) {
    const [presState, setPresState] = useState(null);
    const [internalStagePresActive, setInternalStagePresActive] = useState(false);

    // Use prop if provided, otherwise use internal state
    const stagePresActive = propStagePresActive !== undefined ? propStagePresActive : internalStagePresActive;
    const effectivePresState = presentationState || presState;

    useEffect(() => {
        if (!socket) return;

        const handlePresUpdate = (state) => setPresState(state);
        const handleStageToggle = (state) => {
            if (windowMode === 'stage') setInternalStagePresActive(state);
        };

        socket.on('pres_update', handlePresUpdate);
        socket.on('stage_pres_toggle_update', handleStageToggle);

        const handleKeyDown = (e) => {
            if (windowMode === 'stage') return;
            if (!effectivePresState || effectivePresState.mode === 'none' || !effectivePresState.showing) return;
            if (effectivePresState.mode === 'url' && effectivePresState.isCanva) {
                // Allow keyboard nav to proceed for Canva
            }

            if (e.key === 'ArrowRight' || e.key === ' ' || e.key === 'PageDown') socket.emit('pres_nav', 'next');
            if (e.key === 'ArrowLeft' || e.key === 'PageUp') socket.emit('pres_nav', 'prev');
            if (e.key === 'Home') socket.emit('pres_nav', 'first');
            if (e.key === 'End') socket.emit('pres_nav', 'last');
        };

        window.addEventListener('keydown', handleKeyDown);

        return () => {
            socket.off('pres_update', handlePresUpdate);
            socket.off('stage_pres_toggle_update', handleStageToggle);
            window.removeEventListener('keydown', handleKeyDown);
        };
    }, [socket, windowMode, effectivePresState]);

    const isPresActive = effectivePresState && effectivePresState.mode !== 'none' && (effectivePresState.showing || isStageDisplaySlot);

    // Logic for deciding if we render here:
    // If we are in graphics mode, we always render absolute inset-0.
    // If we are in stage mode, we only render if stagePresActive is true AND this instance is inside the slot.
    // We can conditionally return null if we are in the wrong context.
    if (windowMode === 'stage' && !stagePresActive) return null;
    if (!isPresActive) return null;

    return (
        <div 
            id="pres-overlay" 
            className={`bg-black z-[5200] ${isStageDisplaySlot ? 'absolute inset-0 w-full h-full' : 'absolute inset-0'}`}
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
                        const activeStyle = {
                            visibility: isVisible ? 'visible' : 'hidden',
                            zIndex: zIndex,
                            display: (idx === poolIdx || idx === nextIdx || idx === prevIdx) ? 'block' : 'none'
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

            {effectivePresState.mode === 'images' && (
                <div id="pres-img-container" className="absolute inset-0 flex items-center justify-center bg-black">
                    <img 
                        id="pres-img-main" 
                        className="w-full h-full object-contain" 
                        src={effectivePresState.images[effectivePresState.currentIdx] || ''} 
                        alt="Presentation Slide"
                    />
                </div>
            )}
        </div>
    );
}
