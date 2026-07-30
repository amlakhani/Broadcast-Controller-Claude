import { useState, useEffect, useRef } from 'react';
import { ParticleRenderer } from './particlesRenderer';
import { LAYER_Z } from './layerZ';
import { useStage } from './stage';

// Creates a control surface over the particle renderer. Prefers an OffscreenCanvas + Worker so
// simulation and GPU draws run entirely off the main thread; falls back to a main-thread WebGL
// renderer if OffscreenCanvas/worker transfer isn't available.
function createParticleController(canvas) {
    const canOffscreen =
        typeof Worker !== 'undefined' &&
        typeof OffscreenCanvas !== 'undefined' &&
        typeof canvas.transferControlToOffscreen === 'function';

    if (canOffscreen) {
        try {
            const worker = new Worker(new URL('./particlesWorker.js', import.meta.url), { type: 'module' });
            const offscreen = canvas.transferControlToOffscreen();
            worker.postMessage({ cmd: 'init', canvas: offscreen }, [offscreen]);
            return {
                configure: (c) => worker.postMessage({ cmd: 'configure', ...c }),
                resize: (w, h) => worker.postMessage({ cmd: 'resize', width: w, height: h }),
                start: () => worker.postMessage({ cmd: 'start' }),
                stop: () => worker.postMessage({ cmd: 'stop' }),
                destroy: () => {
                    worker.postMessage({ cmd: 'destroy' });
                    worker.terminate();
                },
            };
        } catch (err) {
            console.warn('[particles] OffscreenCanvas worker unavailable, using main thread:', err);
        }
    }

    const renderer = new ParticleRenderer(canvas);
    if (!renderer.supported) console.warn('[particles] WebGL2 unavailable; particles disabled.');
    return {
        configure: (c) => renderer.configure(c),
        resize: (w, h) => renderer.resize(w, h),
        start: () => renderer.start(),
        stop: () => renderer.stop(),
        destroy: () => renderer.destroy(),
    };
}

export default function ParticlesGraphic({ socket }) {
    const [enabled, setEnabled] = useState(false);
    const [type, setType] = useState('dust');
    const [intensity, setIntensity] = useState(50);
    const [speed, setSpeed] = useState(50);

    const canvasRef = useRef(null);
    const controllerRef = useRef(null);
    // Particle size and velocity are absolute canvas pixels, so the backing store has to be
    // the design frame. Sizing it from the window used to make the same "dust" preset render
    // half-size and half-speed relative to frame on a 4K output.
    const { width: stageWidth, height: stageHeight } = useStage();

    useEffect(() => {
        if (!socket) return;

        const handleUpdate = (data) => {
            setEnabled(data.enabled);
            if (data.type) setType(data.type);
            if (data.intensity !== undefined) setIntensity(data.intensity);
            if (data.speed !== undefined) setSpeed(data.speed);
        };
        const handleStopGraphic = () => setEnabled(false);

        socket.on('particles_update', handleUpdate);
        socket.on('stop_graphic', handleStopGraphic);

        return () => {
            socket.off('particles_update', handleUpdate);
            socket.off('stop_graphic', handleStopGraphic);
        };
    }, [socket]);

    // Spin the renderer up/down with `enabled`. The canvas only exists in the DOM while enabled,
    // so each activation transfers a fresh canvas to a fresh worker.
    useEffect(() => {
        if (!enabled) return;
        const canvas = canvasRef.current;
        if (!canvas) return;

        const controller = createParticleController(canvas);
        controllerRef.current = controller;
        controller.configure({ type, intensity, speed });
        // Fixed to the stage, so no window resize listener is needed — the stage scales the
        // rendered result instead of re-seeding the simulation on every window change.
        controller.resize(stageWidth, stageHeight);
        controller.start();

        return () => {
            controller.destroy();
            controllerRef.current = null;
        };
        // type/intensity/speed are applied via the effect below; only (re)create on enable.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [enabled, stageWidth, stageHeight]);

    // Apply config changes without recreating the worker/context.
    useEffect(() => {
        if (!enabled || !controllerRef.current) return;
        controllerRef.current.configure({ type, intensity, speed });
    }, [type, intensity, speed, enabled]);

    if (!enabled) return null;

    return (
        <canvas
            ref={canvasRef}
            className="absolute inset-0 pointer-events-none"
            style={{ zIndex: LAYER_Z.particles, width: '100%', height: '100%' }}
        />
    );
}
