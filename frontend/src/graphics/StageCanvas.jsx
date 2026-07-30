import { useLayoutEffect, useRef, useState } from 'react';
import { STAGE_WIDTH, STAGE_HEIGHT, StageContext, fitScaleFor } from './stage';

// Renders the fixed 1920x1080 program frame and scales it to fill the output window,
// letterboxing into the key colour when the window is not 16:9. See stage.js for why the
// frame is fixed.
export default function StageCanvas({ children }) {
    const containerRef = useRef(null);
    // Identity until measured. Deriving the seed from window dimensions looks tempting but
    // an output window that mounts hidden reports 0x0, which yields a large negative offset
    // and parks the whole frame off-screen.
    const [layout, setLayout] = useState({ scale: 1, offsetX: 0, offsetY: 0 });

    useLayoutEffect(() => {
        const container = containerRef.current;
        if (!container) return undefined;

        let retryFrame = 0;

        const measure = () => {
            const { width, height } = container.getBoundingClientRect();
            if (!width || !height) {
                // Mounted before layout (hidden window, deferred preview iframe). Keep
                // asking rather than waiting on a resize notification that may never come —
                // a stage stuck at the wrong scale is a dead output on air. rAF is throttled
                // to nothing while the window is hidden, so this costs nothing meanwhile.
                cancelAnimationFrame(retryFrame);
                retryFrame = requestAnimationFrame(measure);
                return;
            }
            const scale = fitScaleFor(width, height);
            setLayout(prev => {
                const next = {
                    scale,
                    offsetX: (width - STAGE_WIDTH * scale) / 2,
                    offsetY: (height - STAGE_HEIGHT * scale) / 2
                };
                if (prev.scale === next.scale && prev.offsetX === next.offsetX && prev.offsetY === next.offsetY) {
                    return prev;
                }
                return next;
            });
        };

        measure();
        const observer = new ResizeObserver(measure);
        observer.observe(container);
        // The observer alone should be enough, but output windows get moved between
        // displays and toggled fullscreen by the main process; a missed notification there
        // is not recoverable by the operator.
        window.addEventListener('resize', measure);
        return () => {
            cancelAnimationFrame(retryFrame);
            observer.disconnect();
            window.removeEventListener('resize', measure);
        };
    }, []);

    const { scale, offsetX, offsetY } = layout;
    // A 1920x1080 output (the NDI renderer, the Live Preview iframe, a 1080p projector) is
    // an exact 1:1 hit. Leave the transform off entirely in that case so the graphics root
    // never becomes a composited/re-rastered layer — that path carries video playback.
    const isIdentity = scale === 1 && offsetX === 0 && offsetY === 0;

    return (
        <div ref={containerRef} className="absolute inset-0 overflow-hidden">
            <div
                data-stage="program"
                style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: `${STAGE_WIDTH}px`,
                    height: `${STAGE_HEIGHT}px`,
                    transformOrigin: 'top left',
                    transform: isIdentity ? 'none' : `translate(${offsetX}px, ${offsetY}px) scale(${scale})`
                }}
            >
                <StageContext.Provider value={{ width: STAGE_WIDTH, height: STAGE_HEIGHT, scale }}>
                    {children}
                </StageContext.Provider>
            </div>
        </div>
    );
}
