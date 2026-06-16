// Web Worker that drives the WebGL particle renderer on an OffscreenCanvas, keeping all
// particle simulation and GPU draw calls off the main thread. Controlled by postMessage:
//   { cmd: 'init', canvas }            transferred OffscreenCanvas
//   { cmd: 'configure', type, intensity, speed }
//   { cmd: 'resize', width, height }
//   { cmd: 'start' } | { cmd: 'stop' } | { cmd: 'destroy' }
import { ParticleRenderer } from './particlesRenderer.js';

let renderer = null;

self.onmessage = (e) => {
    const msg = e.data || {};
    switch (msg.cmd) {
        case 'init':
            renderer = new ParticleRenderer(msg.canvas);
            if (!renderer.supported) {
                self.postMessage({ event: 'unsupported' });
            }
            break;
        case 'configure':
            renderer?.configure({ type: msg.type, intensity: msg.intensity, speed: msg.speed });
            break;
        case 'resize':
            renderer?.resize(msg.width, msg.height);
            break;
        case 'start':
            renderer?.start();
            break;
        case 'stop':
            renderer?.stop();
            break;
        case 'destroy':
            renderer?.destroy();
            renderer = null;
            break;
        default:
            break;
    }
};
