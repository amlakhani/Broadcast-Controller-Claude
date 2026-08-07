import { BrowserWindow } from 'electron';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const DEFAULT_STATUS = {
    enabled: false,
    sourceName: 'Broadcast Controller Graphics',
    sourceType: 'graphics',
    receivers: 0,
    fps: 0,
    lastFrameAt: null,
    error: null
};

const NDI_SOURCE_TYPES = new Set([
    'graphics',
    'stage',
    'lyrics',
    'lowerThirds',
    'sabhaTimer',
    'translation'
]);

function withTimeout(promise, ms, message) {
    return Promise.race([
        promise,
        new Promise((_, reject) => {
            setTimeout(() => reject(new Error(message)), ms);
        })
    ]);
}

export class NdiOutputService {
    constructor({ preloadPath, onStatus, onWindowCreated = null }) {
        this.preloadPath = preloadPath;
        this.onStatus = onStatus;
        // Called with the offscreen window once it exists, so the main process can treat it as
        // an output surface (see registerOutputWebContents in main.js).
        this.onWindowCreated = onWindowCreated;
        this.width = 1920;
        this.height = 1080;
        this.targetFps = 30;
        this.sourceName = DEFAULT_STATUS.sourceName;
        this.sourceType = DEFAULT_STATUS.sourceType;
        this.sender = null;
        this.window = null;
        this.grandiose = null;
        this.frameTimer = null;
        this.statusTimer = null;
        this.frameCount = 0;
        this.fpsWindowStartedAt = 0;
        this.isSendingFrame = false;
        this.sessionId = 0;
        // Latest GPU-composited frame delivered by the offscreen 'paint' event, kept as a
        // ready-to-send CPU bitmap so the NDI send loop never has to call capturePage().
        this.latestFrame = null;
        this.status = { ...DEFAULT_STATUS };
    }

    getStatus() {
        return { ...this.status };
    }

    emitStatus(patch = {}) {
        this.status = { ...this.status, ...patch };
        this.onStatus?.(this.getStatus());
    }

    async start({ sourceName = DEFAULT_STATUS.sourceName, sourceType = DEFAULT_STATUS.sourceType, width = 1920, height = 1080, fps = 30, serverPort, authToken }) {
        this.sourceName = sourceName.trim() || DEFAULT_STATUS.sourceName;
        this.sourceType = NDI_SOURCE_TYPES.has(sourceType) ? sourceType : DEFAULT_STATUS.sourceType;
        this.width = Number(width) || 1920;
        this.height = Number(height) || 1080;
        this.targetFps = Number(fps) || 30;

        if (this.sender || this.window) {
            await this.stop();
        }

        const sessionId = this.sessionId + 1;
        this.sessionId = sessionId;

        try {
            this.emitStatus({
                enabled: false,
                sourceName: this.sourceName,
                sourceType: this.sourceType,
                receivers: 0,
                fps: 0,
                lastFrameAt: null,
                error: null
            });

            if (!this.grandiose) {
                this.grandiose = require('@stagetimerio/grandiose');
            }

            this.sender = await withTimeout(this.grandiose.send({
                name: this.sourceName,
                clockVideo: true,
                clockAudio: false
            }), 5000, 'Timed out starting NDI sender. The native NDI module may need to be rebuilt for Electron.');

            this.window = new BrowserWindow({
                width: this.width,
                height: this.height,
                show: false,
                frame: false,
                transparent: true,
                backgroundColor: '#00000000',
                webPreferences: {
                    preload: this.preloadPath,
                    nodeIntegration: false,
                    contextIsolation: true,
                    sandbox: true,
                    webSecurity: true,
                    offscreen: true
                }
            });

            this.onWindowCreated?.(this.window);

            this.window.on('closed', () => {
                this.window = null;
                this.stop().catch(err => {
                    console.error('Error stopping NDI after window close:', err);
                });
            });
            this.window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
            this.window.webContents.on('will-navigate', (event, url) => {
                if (!url.startsWith(`http://127.0.0.1:${serverPort}/`)) {
                    event.preventDefault();
                }
            });

            const graphicsUrl = new URL(`http://127.0.0.1:${serverPort}/graphics`);
            graphicsUrl.searchParams.set('mode', this.sourceType === 'stage' ? 'stage' : 'graphics');
            graphicsUrl.searchParams.set('ndiSource', this.sourceType);
            graphicsUrl.searchParams.set('ndi', 'true');
            if (authToken) graphicsUrl.searchParams.set('auth', authToken);

            // Receive GPU-composited frames as they are painted instead of polling
            // capturePage(). Each 'paint' delivers the whole frame as a CPU NativeImage; we
            // cache it as a BGRA bitmap that the send loop reuses.
            this.latestFrame = null;
            this.window.webContents.on('paint', (event, dirty, image) => {
                if (sessionId !== this.sessionId || !image) return;
                const size = image.getSize();
                if (!size.width || !size.height) return;
                // On HiDPI/Retina displays the offscreen surface renders at the device scale
                // factor (e.g. 2x -> 3840x2160), which would push 4K over NDI. Normalize to the
                // configured output resolution so NDI output is consistent across machines.
                const frameImage = (size.width === this.width && size.height === this.height)
                    ? image
                    : image.resize({ width: this.width, height: this.height });
                this.latestFrame = {
                    data: frameImage.toBitmap(),
                    width: this.width,
                    height: this.height
                };
            });

            await withTimeout(
                this.window.loadURL(graphicsUrl.toString()),
                10000,
                'Timed out loading hidden NDI graphics renderer.'
            );

            // Cap the offscreen render rate to the NDI target so we don't paint faster than
            // we send.
            this.window.webContents.setFrameRate(this.targetFps);

            this.frameCount = 0;
            this.fpsWindowStartedAt = Date.now();
            this.emitStatus({
                enabled: true,
                sourceName: this.sourceName,
                sourceType: this.sourceType,
                receivers: 0,
                fps: 0,
                lastFrameAt: null,
                error: null
            });

            // Send at a steady target FPS by re-sending the most recently painted frame. This
            // keeps NDI receivers fed a constant rate even when the graphic is static, without
            // ever re-capturing on the CPU.
            const frameInterval = Math.max(1, Math.round(1000 / this.targetFps));
            this.frameTimer = setInterval(() => this.sendFrame(sessionId), frameInterval);
            this.statusTimer = setInterval(() => this.pollStatus(sessionId), 1000);
        } catch (err) {
            await this.stop({ preserveError: true });
            this.emitStatus({
                enabled: false,
                sourceName: this.sourceName,
                sourceType: this.sourceType,
                error: err?.message || String(err)
            });
        }
    }

    async stop({ preserveError = false } = {}) {
        if (this.frameTimer) {
            this.sessionId += 1;
            clearInterval(this.frameTimer);
            this.frameTimer = null;
        } else {
            this.sessionId += 1;
        }
        if (this.statusTimer) {
            clearInterval(this.statusTimer);
            this.statusTimer = null;
        }

        const win = this.window;
        this.window = null;
        if (win && !win.isDestroyed()) {
            win.close();
        }

        const sender = this.sender;
        this.sender = null;
        if (sender) {
            try {
                await sender.destroy();
            } catch (err) {
                console.error('Error destroying NDI sender:', err);
            }
        }

        this.isSendingFrame = false;
        this.latestFrame = null;
        this.emitStatus({
            enabled: false,
            sourceType: this.sourceType,
            receivers: 0,
            fps: 0,
            lastFrameAt: null,
            error: preserveError ? this.status.error : null
        });
    }

    async sendFrame(sessionId) {
        if (sessionId !== this.sessionId || !this.sender || !this.window || this.window.isDestroyed() || this.isSendingFrame) {
            return;
        }

        // Reuse the most recent frame painted by the offscreen renderer. No frame yet means
        // the page hasn't rendered its first frame; just wait for the next interval.
        const frame = this.latestFrame;
        if (!frame) return;

        this.isSendingFrame = true;
        try {
            if (sessionId !== this.sessionId || !this.sender) return;
            await this.sender.video({
                xres: frame.width,
                yres: frame.height,
                frameRateN: this.targetFps,
                frameRateD: 1,
                fourCC: this.grandiose.FOURCC_BGRA,
                pictureAspectRatio: 16 / 9,
                frameFormatType: this.grandiose.FORMAT_TYPE_PROGRESSIVE,
                lineStrideBytes: frame.width * 4,
                data: frame.data
            });
            if (sessionId !== this.sessionId) return;

            // Record only. This used to emitStatus() here, which meant a full status object was
            // io.emit'd to EVERY connected client 30 times a second — control window, graphics,
            // stage, backstage, the NDI renderer itself, and every paired phone over Wi-Fi.
            // pollStatus publishes this at 1 Hz, which is what it exists for.
            this.frameCount += 1;
            this.lastFrameAt = Date.now();
            this.lastFrameError = null;
        } catch (err) {
            // Errors still publish immediately — the operator needs to know the feed broke
            // without waiting for the next 1 Hz tick. Stored too, so pollStatus doesn't
            // immediately clear it.
            this.lastFrameError = err?.message || String(err);
            this.emitStatus({ error: this.lastFrameError });
        } finally {
            this.isSendingFrame = false;
        }
    }

    pollStatus(sessionId) {
        if (sessionId !== this.sessionId || !this.sender) return;

        let receivers = 0;
        try {
            receivers = this.sender.connections();
        } catch (err) {
            this.emitStatus({ error: err?.message || String(err) });
        }

        const now = Date.now();
        const elapsed = Math.max(1, now - this.fpsWindowStartedAt);
        const fps = Math.round((this.frameCount * 1000 / elapsed) * 10) / 10;
        this.frameCount = 0;
        this.fpsWindowStartedAt = now;

        this.emitStatus({
            enabled: true,
            receivers,
            fps,
            lastFrameAt: this.lastFrameAt ?? null,
            error: this.lastFrameError ?? null
        });
    }
}

export function getDefaultNdiStatus() {
    return { ...DEFAULT_STATUS };
}
