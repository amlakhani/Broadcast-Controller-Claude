import { app, BrowserWindow, screen, ipcMain, dialog, session, Menu, shell } from 'electron';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { NdiOutputService } from './ndi_output_service.js';
import { AtemService } from './atem_service.js';
import { VideohubService } from './videohub_service.js';
import { NovaStarService } from './novastar_service.js';

// Start the existing Express server automatically and grab its socket instance
import {
    io,
    app as expressApp,
    server,
    setTranslationGlossaryDir,
    getAuthToken,
    loadAtemSettings,
    saveAtemSettings,
    loadVideohubSettings,
    saveVideohubSettings,
    loadNovastarSettings,
    saveNovastarSettings,
} from './server.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const APP_VERSION = '1.0.0';
let controlWindow;
let graphicsWindow;
let stageWindow;
let backstageWindow;
let serverPort = null;
let ndiOutputService = null;
let atemService = null;
let videohubService = null;
let novastarService = null;

function localAppUrl(pathname = '/', params = {}) {
    const url = new URL(`http://127.0.0.1:${serverPort}${pathname}`);
    url.searchParams.set('auth', getAuthToken());
    for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== null) {
            url.searchParams.set(key, String(value));
        }
    }
    return url.toString();
}

// Crucial: Disable autoplay restrictions so videos can play with sound on the graphics output
// without the user having to physically click on the external monitor window first.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// Explicitly opt into GPU acceleration so video playback and graphics-heavy output run on the
// hardware fast path instead of being composited/rasterized on the CPU (the cause of jitter).
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');
// On dual-GPU laptops (e.g. MacBook Pro, gaming laptops) prefer the discrete GPU. Harmless on
// single-GPU machines.
// NOTE: this only controls which GPU *renders*. If the output monitors are driven by a DisplayLink
// (USB virtual display) dock rather than a native DP/HDMI output, the heavy cost is DisplayLink's
// per-frame framebuffer capture+compress (attributed to DWM), not this app — and no GPU flag fixes
// that. For smooth full-motion video, drive the output displays from a native GPU output.
app.commandLine.appendSwitch('force_high_performance_gpu');

function isLocalAppUrl(urlString) {
    try {
        const parsed = new URL(urlString);
        return parsed.protocol === 'http:' && parsed.hostname === '127.0.0.1' && parsed.port === String(serverPort);
    } catch {
        return false;
    }
}

function hardenWindowNavigation(win) {
    win.webContents.setWindowOpenHandler(({ url }) => {
        if (url.startsWith('https://') || url.startsWith('http://')) {
            shell.openExternal(url);
        }
        return { action: 'deny' };
    });

    win.webContents.on('will-navigate', (event, url) => {
        if (!isLocalAppUrl(url)) {
            event.preventDefault();
            if (url.startsWith('https://') || url.startsWith('http://')) {
                shell.openExternal(url);
            }
        }
    });
}

function setAppMenu() {
    const template = [
        {
            label: 'File',
            submenu: [
                { role: 'quit' }
            ]
        },
        {
            label: 'Edit',
            submenu: [
                { role: 'undo' },
                { role: 'redo' },
                { type: 'separator' },
                { role: 'cut' },
                { role: 'copy' },
                { role: 'paste' },
                { role: 'selectAll' }
            ]
        },
        {
            label: 'View',
            submenu: [
                { role: 'reload' },
                { role: 'forceReload' },
                { role: 'toggleDevTools' },
                { type: 'separator' },
                { role: 'resetZoom' },
                { role: 'zoomIn' },
                { role: 'zoomOut' },
                { type: 'separator' },
                { role: 'togglefullscreen' }
            ]
        },
        {
            label: 'Window',
            submenu: [
                { role: 'minimize' },
                { role: 'zoom' },
                { role: 'close' }
            ]
        }
    ];

    if (process.platform === 'darwin') {
        template.unshift({
            label: app.name,
            submenu: [
                { role: 'about' },
                { type: 'separator' },
                { role: 'services' },
                { type: 'separator' },
                { role: 'hide' },
                { role: 'hideOthers' },
                { role: 'unhide' },
                { type: 'separator' },
                { role: 'quit' }
            ]
        });
    }

    const menu = Menu.buildFromTemplate(template);
    Menu.setApplicationMenu(menu);
}

function createWindows() {
    if (!serverPort) {
        // If port not yet set, we should wait or check expressApp
        serverPort = expressApp.get('port');
        if (!serverPort) {
            console.log("Waiting for server port...");
            return;
        }
    }

    // 1. Create Control Window on primary display
    controlWindow = new BrowserWindow({
        width: 1000,
        height: 850,
        show: false, // Don't show until ready — eliminates white flash on startup
        title: `Broadcast Controller v${APP_VERSION}`,
        icon: path.join(__dirname, 'public', 'logo.png'),
        webPreferences: {
            preload: path.join(__dirname, 'preload.cjs'),
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: false
        }
    });

    hardenWindowNavigation(controlWindow);
    controlWindow.loadURL(localAppUrl('/'));

    // Show window only once the page is rendered — feels instant
    controlWindow.once('ready-to-show', () => {
        controlWindow.show();
    });

    controlWindow.on('closed', () => {
        app.quit();
    });
}

function createGraphicsWindow(display) {
    if (!serverPort) return;

    if (graphicsWindow) {
        // Instantly move it to new display by dropping fullscreen temporarily to prevent macOS space lock
        graphicsWindow.setFullScreen(false);
        setTimeout(() => {
            graphicsWindow.setBounds({
                x: display.bounds.x,
                y: display.bounds.y,
                width: display.bounds.width,
                height: display.bounds.height
            });
            graphicsWindow.setFullScreen(true);
        }, 50);
        return;
    }

    graphicsWindow = new BrowserWindow({
        x: display.bounds.x,
        y: display.bounds.y,
        width: display.bounds.width,
        height: display.bounds.height,
        frame: false,
        thickFrame: false,
        // Opaque window: OS-level transparency forces a full redraw + per-pixel alpha composite
        // on every video frame and blocks the hardware video fast path. The page paints its own
        // green/black background for chroma keying, so transparency is not needed here.
        transparent: false,
        backgroundColor: '#000000',
        alwaysOnTop: true,
        hasShadow: false,
        roundedCorners: false, // Prevents rounding on macOS
        fullscreen: true, // Forces native OS full screen spaces to mask Taskbar/Menubars securely
        title: `Graphics Output v${APP_VERSION}`,
        icon: path.join(__dirname, 'public', 'logo.png'),
        webPreferences: {
            preload: path.join(__dirname, 'preload.cjs'),
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: false,
            webSecurity: true,
            // This window is never focused (operator works in the control window). Without this,
            // Chromium throttles its rendering/timers, causing the projector output to stutter.
            backgroundThrottling: false
        }
    });

    hardenWindowNavigation(graphicsWindow);
    graphicsWindow.loadURL(localAppUrl('/graphics', { mode: 'graphics' }));

    graphicsWindow.on('closed', () => {
        graphicsWindow = null;
    });
}

function createStageWindow(display) {
    if (!serverPort) return;

    if (stageWindow) {
        stageWindow.setFullScreen(false);
        setTimeout(() => {
            stageWindow.setBounds({
                x: display.bounds.x,
                y: display.bounds.y,
                width: display.bounds.width,
                height: display.bounds.height
            });
            stageWindow.setFullScreen(true);
        }, 50);
        return;
    }

    stageWindow = new BrowserWindow({
        x: display.bounds.x,
        y: display.bounds.y,
        width: display.bounds.width,
        height: display.bounds.height,
        frame: false,
        thickFrame: false,
        // Opaque for the same GPU fast-path reason as the graphics window (see above).
        transparent: false,
        backgroundColor: '#000000',
        alwaysOnTop: true,
        hasShadow: false,
        roundedCorners: false,
        fullscreen: true,
        title: `Confidence Monitor v${APP_VERSION}`,
        icon: path.join(__dirname, 'public', 'logo.png'),
        webPreferences: {
            preload: path.join(__dirname, 'preload.cjs'),
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: false,
            webSecurity: true,
            // Never focused — keep it rendering at full rate (see graphics window).
            backgroundThrottling: false
        }
    });

    hardenWindowNavigation(stageWindow);
    stageWindow.loadURL(localAppUrl('/graphics', { mode: 'stage' }));

    stageWindow.on('closed', () => {
        stageWindow = null;
    });
}

function createBackstageWindow(display) {
    if (!serverPort) return;

    if (backstageWindow) {
        backstageWindow.setFullScreen(false);
        setTimeout(() => {
            backstageWindow.setBounds({
                x: display.bounds.x,
                y: display.bounds.y,
                width: display.bounds.width,
                height: display.bounds.height
            });
            backstageWindow.setFullScreen(true);
        }, 50);
        return;
    }

    backstageWindow = new BrowserWindow({
        x: display.bounds.x,
        y: display.bounds.y,
        width: display.bounds.width,
        height: display.bounds.height,
        frame: false,
        thickFrame: false,
        transparent: false,
        backgroundColor: '#000000',
        alwaysOnTop: true,
        hasShadow: false,
        roundedCorners: false,
        fullscreen: true,
        title: `Backstage Monitor v${APP_VERSION}`,
        icon: path.join(__dirname, 'public', 'logo.png'),
        webPreferences: {
            preload: path.join(__dirname, 'preload.cjs'),
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: false,
            webSecurity: true,
            // Never focused — keep it rendering at full rate (see graphics window).
            backgroundThrottling: false
        }
    });

    hardenWindowNavigation(backstageWindow);
    backstageWindow.loadURL(localAppUrl('/backstage'));

    backstageWindow.on('closed', () => {
        backstageWindow = null;
    });
}

function broadcastDisplays() {
    const displays = screen.getAllDisplays().map(d => ({
        id: d.id,
        label: d.label || (d.internal ? 'Internal Display' : `External Display (${d.size.width}x${d.size.height})`),
        bounds: d.bounds
    }));
    io.emit('available_displays', displays);
}

function isLocalSocket(socket) {
    return socket.data?.clientType === 'local';
}

function onLocalSocket(socket, event, handler) {
    socket.on(event, (...args) => {
        if (!isLocalSocket(socket)) {
            const ack = args.find(arg => typeof arg === 'function');
            if (typeof ack === 'function') {
                ack({ ok: false, error: 'This action is only available on the main controller.' });
            }
            socket.emit('action_forbidden', { error: 'This action is only available on the main controller.' });
            return;
        }
        handler(...args);
    });
}

// GPU diagnostic: confirms hardware acceleration (especially "video_decode") is active.
// NOTE: the GPU process initializes asynchronously, so the "startup" snapshot shows everything
// as software ("disabled_software", gl=none) before init finishes — that is expected and NOT a
// problem, so it is recorded to disk but deliberately NOT printed (it reads like a failure).
// Only the "settled" snapshot, taken a few seconds later, reflects reality and is summarized to
// the console — as one line when healthy, or a loud warning with detail when acceleration is
// genuinely degraded. Both snapshots are always written to <userData>/gpu-status.json so you can
// verify on any machine, including packaged Windows builds.

// Features that must be accelerated for smooth broadcast output. Others (raw_draw,
// skia_graphite, webnn, ...) are off by default in healthy Chromium and are not signals.
const KEY_GPU_FEATURES = ['2d_canvas', 'gpu_compositing', 'rasterization', 'video_decode', 'webgl'];

async function captureGpuSnapshot(label) {
    const snap = { label, when: new Date().toISOString(), featureStatus: null, gpuInfo: null };
    try {
        snap.featureStatus = app.getGPUFeatureStatus();
    } catch (err) {
        snap.featureStatus = { error: String(err) };
    }
    try {
        // 'complete' forces a full GPU-info gather and reflects the settled GL/ANGLE backend.
        snap.gpuInfo = await app.getGPUInfo('complete');
    } catch (err) {
        snap.gpuInfo = { error: String(err) };
    }
    return snap;
}

function summarizeGpuSnapshot(snap) {
    const featureStatus = snap?.featureStatus || {};
    const degraded = KEY_GPU_FEATURES.filter(feature => !String(featureStatus[feature] || '').startsWith('enabled'));
    const activeDevice = (snap?.gpuInfo?.gpuDevice || []).find(device => device.active);
    return { degraded, device: activeDevice?.deviceString || 'unknown GPU' };
}

async function logGpuStatus() {
    const report = { startup: null, settled: null };
    // Immediate snapshot (pre-initialization; recorded but not printed — see note above).
    report.startup = await captureGpuSnapshot('startup');
    write();

    // Settled snapshot a few seconds later, after the GPU process has initialized.
    setTimeout(async () => {
        report.settled = await captureGpuSnapshot('settled');
        write();

        const statusPath = path.join(app.getPath('userData'), 'gpu-status.json');
        const { degraded, device } = summarizeGpuSnapshot(report.settled);
        if (degraded.length === 0) {
            console.log(`[GPU] Hardware acceleration active on ${device}.`);
        } else {
            console.warn(`[GPU] Running WITHOUT full hardware acceleration on ${device}.`);
            console.warn(`[GPU] Degraded: ${degraded.join(', ')}. Expect CPU-bound output and video jitter.`);
            console.warn('[GPU] Feature status:', JSON.stringify(report.settled.featureStatus, null, 2));
            console.warn(`[GPU] Full report: ${statusPath}`);
        }
    }, 5000);

    function write() {
        try {
            fs.writeFileSync(path.join(app.getPath('userData'), 'gpu-status.json'), JSON.stringify(report, null, 2));
        } catch (err) {
            console.error('[GPU] could not write status file:', err);
        }
    }
}

app.whenReady().then(() => {
    setAppMenu();
    logGpuStatus();
    setTranslationGlossaryDir(app.getPath('userData'));
    ndiOutputService = new NdiOutputService({
        preloadPath: path.join(__dirname, 'preload.cjs'),
        onStatus: (status) => io.emit('ndi_status_update', status)
    });

    atemService = new AtemService({
        // Remote-paired clients must never see the switcher's LAN address or the
        // full input list, so the fan-out is split by socket type.
        onStatus: (status) => {
            for (const socket of io.sockets.sockets.values()) {
                socket.emit('atem_status_update', isLocalSocket(socket) ? status : atemService.getPublicStatus());
            }
        }
    });

    const atemSettings = loadAtemSettings();
    if (atemSettings.autoConnect && atemSettings.address) {
        atemService.connect({ address: atemSettings.address, port: atemSettings.port });
    }

    videohubService = new VideohubService({
        // Same split as ATEM above: remote-paired clients never see the
        // hub's LAN address or full I/O list.
        onStatus: (status) => {
            for (const socket of io.sockets.sockets.values()) {
                socket.emit('videohub_status_update', isLocalSocket(socket) ? status : videohubService.getPublicStatus());
            }
        }
    });

    const videohubSettings = loadVideohubSettings();
    if (videohubSettings.autoConnect && videohubSettings.address) {
        videohubService.connect({ address: videohubSettings.address, port: videohubSettings.port });
    }

    novastarService = new NovaStarService({
        // Same split as ATEM/Videohub above: remote-paired clients never see
        // the processor's LAN address, credentials, or screen/preset list.
        onStatus: (status) => {
            for (const socket of io.sockets.sockets.values()) {
                socket.emit('novastar_status_update', isLocalSocket(socket) ? status : novastarService.getPublicStatus());
            }
        }
    });

    const novastarSettings = loadNovastarSettings();
    if (novastarSettings.autoConnect && novastarSettings.address) {
        novastarService.connect({
            address: novastarSettings.address,
            port: novastarSettings.port,
            pId: novastarSettings.pId,
            secretKey: novastarSettings.secretKey
        });
    }

    session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
        const allowedOrigins = new Set([
            `http://127.0.0.1:${serverPort}`,
            `http://localhost:${serverPort}`
        ]);
        const origin = (() => {
            try {
                return new URL(webContents.getURL()).origin;
            } catch {
                return '';
            }
        })();

        callback(permission === 'media' && allowedOrigins.has(origin));
    });

    // Strip only frame-blocking headers so operator-selected websites can
    // still be embedded in the graphics output iframes.
    // Handles: X-Frame-Options, COEP, COOP, CORP, and CSP frame-ancestors
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
        if (details.resourceType !== 'subFrame') {
            callback({});
            return;
        }

        const responseHeaders = { ...details.responseHeaders };
        const headersToRemove = [
            'x-frame-options',
            'cross-origin-embedder-policy',
            'cross-origin-opener-policy',
            'cross-origin-resource-policy'
        ];
        for (const key of Object.keys(responseHeaders)) {
            const lower = key.toLowerCase();
            if (headersToRemove.includes(lower)) {
                delete responseHeaders[key];
            }
            // Strip frame-ancestors from Content-Security-Policy
            if (lower === 'content-security-policy') {
                responseHeaders[key] = responseHeaders[key].map(val =>
                    val.replace(/frame-ancestors[^;]*(;|$)/gi, '').trim()
                );
            }
        }
        callback({ responseHeaders });
    });

    // Handle server ready
    const checkServer = () => {
        const port = expressApp.get('port');
        if (port) {
            serverPort = port;
            createWindows();
        } else {
            // Wait for listening event if not ready
            server.once('listening', () => {
                serverPort = expressApp.get('port');
                createWindows();
            });
        }
    };

    checkServer();

    io.on('connection', (socket) => {
        // Send displays on connect
        broadcastDisplays();

        onLocalSocket(socket, 'set_output_display', (displayId) => {
            const targetDisplay = screen.getAllDisplays().find(d => d.id === Number(displayId));
            if (targetDisplay) {
                createGraphicsWindow(targetDisplay);
            }
        });

        onLocalSocket(socket, 'close_graphics_window', () => {
            if (graphicsWindow) {
                graphicsWindow.close();
                graphicsWindow = null;
            }
        });

        onLocalSocket(socket, 'set_stage_display', (displayId) => {
            const targetDisplay = screen.getAllDisplays().find(d => d.id === Number(displayId));
            if (targetDisplay) {
                createStageWindow(targetDisplay);
            }
        });

        onLocalSocket(socket, 'close_stage_window', () => {
            if (stageWindow) {
                stageWindow.close();
                stageWindow = null;
            }
        });

        onLocalSocket(socket, 'set_backstage_display', (displayId) => {
            const targetDisplay = screen.getAllDisplays().find(d => d.id === Number(displayId));
            if (targetDisplay) {
                createBackstageWindow(targetDisplay);
            }
        });

        onLocalSocket(socket, 'close_backstage_window', () => {
            if (backstageWindow) {
                backstageWindow.close();
                backstageWindow = null;
            }
        });

        socket.on('set_bg_color', (color) => {
            io.emit('bg_color_update', color);
        });

        onLocalSocket(socket, 'ndi_start', (config = {}) => {
            if (!serverPort || !ndiOutputService) return;
            ndiOutputService.start({
                sourceName: config.sourceName || 'Broadcast Controller Graphics',
                sourceType: config.sourceType || 'graphics',
                width: config.width || 1920,
                height: config.height || 1080,
                fps: config.fps || 30,
                authToken: getAuthToken(),
                serverPort
            });
        });

        onLocalSocket(socket, 'ndi_stop', () => {
            ndiOutputService?.stop();
        });

        socket.on('ndi_status_request', () => {
            if (ndiOutputService) {
                socket.emit('ndi_status_update', ndiOutputService.getStatus());
            }
        });

        // --- ATEM switcher -------------------------------------------------
        // All privileged: these open a socket to, and drive, physical broadcast
        // hardware. Status is readable by anyone but redacted for remote clients.
        onLocalSocket(socket, 'atem_connect', async (config = {}, ack) => {
            if (!atemService) return;
            const saved = loadAtemSettings();
            const savedConnection = config.connectionId
                ? saved.connections.find(c => c.id === config.connectionId)
                : null;
            const settings = savedConnection || (config.address ? config : saved);
            const status = await atemService.connect({ address: settings.address, port: settings.port });
            // Remember what's active so a restart resumes the same saved
            // connection and the saved-connections chip row stays in sync.
            saveAtemSettings({ ...saved, address: settings.address, port: settings.port, activeConnectionId: config.connectionId || null });
            if (typeof ack === 'function') ack({ ok: status.connectionState !== 'error', status });
        });

        onLocalSocket(socket, 'atem_disconnect', async (payload, ack) => {
            // `payload` is unused — kept so the handler matches the (payload, ack)
            // shape every client call through emitAck() sends, even when there's
            // nothing to send. A bare (ack) param here would silently swallow the
            // ack function and hang the caller's promise forever.
            await atemService?.disconnect();
            if (typeof ack === 'function') ack({ ok: true });
        });

        onLocalSocket(socket, 'atem_set_armed', (armed, ack) => {
            atemService?.setArmed(armed);
            if (typeof ack === 'function') ack({ ok: true, armed: !!armed });
        });

        onLocalSocket(socket, 'atem_push_boxes', (payload = {}, ack) => {
            const result = atemService?.pushBoxes(payload.patches || [], payload.ssrcId || 0)
                || { ok: false, error: 'ATEM service unavailable.' };
            if (typeof ack === 'function') ack(result);
        });

        onLocalSocket(socket, 'atem_push_properties', async (payload = {}, ack) => {
            const result = await atemService?.pushProperties(payload.props || {}, payload.ssrcId || 0);
            if (typeof ack === 'function') ack(result || { ok: false, error: 'ATEM service unavailable.' });
        });

        onLocalSocket(socket, 'atem_pull_state', (payload = {}, ack) => {
            const boxes = atemService?.pullBoxes(payload.ssrcId || 0);
            if (typeof ack === 'function') ack({ ok: Array.isArray(boxes), boxes });
        });

        socket.on('atem_status_request', () => {
            if (!atemService) return;
            socket.emit('atem_status_update', isLocalSocket(socket)
                ? atemService.getStatus()
                : atemService.getPublicStatus());
        });

        // --- ATEM switcher: Program/Preview, transitions, keyers, router -----
        // Same privilege split as the ATEM block above: all writes are local-only.
        const atemUnavailable = { ok: false, error: 'ATEM service unavailable.' };

        onLocalSocket(socket, 'atem_cut', async (payload = {}, ack) => {
            const result = await atemService?.cut(payload.me || 0);
            if (typeof ack === 'function') ack(result || atemUnavailable);
        });

        onLocalSocket(socket, 'atem_auto_transition', async (payload = {}, ack) => {
            const result = await atemService?.autoTransition(payload.me || 0);
            if (typeof ack === 'function') ack(result || atemUnavailable);
        });

        onLocalSocket(socket, 'atem_fade_to_black', async (payload = {}, ack) => {
            const result = await atemService?.fadeToBlack(payload.me || 0);
            if (typeof ack === 'function') ack(result || atemUnavailable);
        });

        onLocalSocket(socket, 'atem_set_program', async (payload = {}, ack) => {
            const result = await atemService?.setProgramInput(payload.input, payload.me || 0);
            if (typeof ack === 'function') ack(result || atemUnavailable);
        });

        onLocalSocket(socket, 'atem_set_preview', async (payload = {}, ack) => {
            const result = await atemService?.setPreviewInput(payload.input, payload.me || 0);
            if (typeof ack === 'function') ack(result || atemUnavailable);
        });

        onLocalSocket(socket, 'atem_set_aux', async (payload = {}, ack) => {
            const result = await atemService?.setAuxSource(payload.source, payload.bus || 0);
            if (typeof ack === 'function') ack(result || atemUnavailable);
        });

        onLocalSocket(socket, 'atem_set_transition_style', async (payload = {}, ack) => {
            const result = await atemService?.setTransitionStyle(payload.props || {}, payload.me || 0);
            if (typeof ack === 'function') ack(result || atemUnavailable);
        });

        onLocalSocket(socket, 'atem_push_transition_position', (payload = {}, ack) => {
            const result = atemService?.pushTransitionPosition(payload.position, payload.me || 0) || atemUnavailable;
            if (typeof ack === 'function') ack(result);
        });

        onLocalSocket(socket, 'atem_push_transition_settings', (payload = {}, ack) => {
            const result = atemService?.pushTransitionSettings(payload.kind, payload.props || {}, payload.me || 0) || atemUnavailable;
            if (typeof ack === 'function') ack(result);
        });

        onLocalSocket(socket, 'atem_set_keyer_on_air', async (payload = {}, ack) => {
            const result = await atemService?.setUpstreamKeyerOnAir(payload.onAir, payload.me || 0, payload.keyer || 0);
            if (typeof ack === 'function') ack(result || atemUnavailable);
        });

        onLocalSocket(socket, 'atem_set_keyer_type', async (payload = {}, ack) => {
            const result = await atemService?.setUpstreamKeyerType(payload.props || {}, payload.me || 0, payload.keyer || 0);
            if (typeof ack === 'function') ack(result || atemUnavailable);
        });

        onLocalSocket(socket, 'atem_set_keyer_sources', async (payload = {}, ack) => {
            const result = await atemService?.setUpstreamKeyerSources(payload.fillSource, payload.cutSource, payload.me || 0, payload.keyer || 0);
            if (typeof ack === 'function') ack(result || atemUnavailable);
        });

        onLocalSocket(socket, 'atem_push_keyer_settings', (payload = {}, ack) => {
            const result = atemService?.pushKeyerSettings(payload.kind, payload.props || {}, payload.me || 0, payload.keyer || 0) || atemUnavailable;
            if (typeof ack === 'function') ack(result);
        });

        onLocalSocket(socket, 'atem_set_dsk_on_air', async (payload = {}, ack) => {
            const result = await atemService?.setDownstreamKeyOnAir(payload.onAir, payload.key || 0);
            if (typeof ack === 'function') ack(result || atemUnavailable);
        });

        onLocalSocket(socket, 'atem_set_dsk_tie', async (payload = {}, ack) => {
            const result = await atemService?.setDownstreamKeyTie(payload.tie, payload.key || 0);
            if (typeof ack === 'function') ack(result || atemUnavailable);
        });

        onLocalSocket(socket, 'atem_auto_dsk', async (payload = {}, ack) => {
            const result = await atemService?.autoDownstreamKey(payload.key || 0, payload.isTowardsOnAir);
            if (typeof ack === 'function') ack(result || atemUnavailable);
        });

        onLocalSocket(socket, 'atem_set_dsk_sources', async (payload = {}, ack) => {
            const result = await atemService?.setDownstreamKeySources(payload.fillSource, payload.cutSource, payload.key || 0);
            if (typeof ack === 'function') ack(result || atemUnavailable);
        });

        onLocalSocket(socket, 'atem_push_dsk_settings', (payload = {}, ack) => {
            const result = atemService?.pushDskSettings(payload.kind, payload.props || {}, payload.key || 0) || atemUnavailable;
            if (typeof ack === 'function') ack(result);
        });

        onLocalSocket(socket, 'atem_pull_me_state', (payload = {}, ack) => {
            const state = atemService?.pullMixEffectState(payload.me || 0);
            if (typeof ack === 'function') ack({ ok: !!state, state });
        });

        onLocalSocket(socket, 'atem_pull_keyer_state', (payload = {}, ack) => {
            const state = atemService?.pullKeyerState(payload.me || 0, payload.keyer || 0);
            if (typeof ack === 'function') ack({ ok: !!state, state });
        });

        onLocalSocket(socket, 'atem_pull_dsk_state', (payload = {}, ack) => {
            const state = atemService?.pullDskState(payload.key || 0);
            if (typeof ack === 'function') ack({ ok: !!state, state });
        });

        // --- Blackmagic Videohub --------------------------------------------
        // Same privilege split as ATEM above: writes are local-only, status
        // reads are open but redacted for remote clients.
        onLocalSocket(socket, 'videohub_connect', async (config = {}, ack) => {
            if (!videohubService) return;
            const saved = loadVideohubSettings();
            const savedConnection = config.connectionId
                ? saved.connections.find(c => c.id === config.connectionId)
                : null;
            const settings = savedConnection || (config.address ? config : saved);
            const status = await videohubService.connect({ address: settings.address, port: settings.port });
            saveVideohubSettings({ ...saved, address: settings.address, port: settings.port, activeConnectionId: config.connectionId || null });
            if (typeof ack === 'function') ack({ ok: status.connectionState !== 'error', status });
        });

        onLocalSocket(socket, 'videohub_disconnect', async (payload, ack) => {
            await videohubService?.disconnect();
            if (typeof ack === 'function') ack({ ok: true });
        });

        onLocalSocket(socket, 'videohub_take', (payload = {}, ack) => {
            const result = videohubService?.takeRoutes(payload.pairs || [])
                || { ok: false, error: 'Videohub service unavailable.' };
            if (typeof ack === 'function') ack(result);
        });

        onLocalSocket(socket, 'videohub_undo', (payload, ack) => {
            const result = videohubService?.undoLastTake()
                || { ok: false, error: 'Videohub service unavailable.' };
            if (typeof ack === 'function') ack(result);
        });

        onLocalSocket(socket, 'videohub_set_lock', (payload = {}, ack) => {
            const result = videohubService?.setLock(payload.destIndex, !!payload.locked)
                || { ok: false, error: 'Videohub service unavailable.' };
            if (typeof ack === 'function') ack(result);
        });

        onLocalSocket(socket, 'videohub_rename_input', (payload = {}, ack) => {
            const result = videohubService?.renameInput(payload.index, payload.label || '')
                || { ok: false, error: 'Videohub service unavailable.' };
            if (typeof ack === 'function') ack(result);
        });

        onLocalSocket(socket, 'videohub_rename_output', (payload = {}, ack) => {
            const result = videohubService?.renameOutput(payload.index, payload.label || '')
                || { ok: false, error: 'Videohub service unavailable.' };
            if (typeof ack === 'function') ack(result);
        });

        socket.on('videohub_status_request', () => {
            if (!videohubService) return;
            socket.emit('videohub_status_update', isLocalSocket(socket)
                ? videohubService.getStatus()
                : videohubService.getPublicStatus());
        });

        // --- NovaStar H Series LED processor ---------------------------------
        // Same privilege split as ATEM/Videohub above: writes are local-only,
        // status reads are open but redacted for remote clients. Unlike those
        // two, commands go over HTTP (see novastar_service.js), so there's
        // also a lightweight novastar_test pre-flight check with no
        // ATEM/Videohub equivalent — mirrors local_ai_test's role for the
        // other HTTP-based integration in this app.
        onLocalSocket(socket, 'novastar_connect', async (config = {}, ack) => {
            if (!novastarService) return;
            const saved = loadNovastarSettings();
            const savedConnection = config.connectionId
                ? saved.connections.find(c => c.id === config.connectionId)
                : null;
            const settings = savedConnection || (config.address ? config : saved);
            const status = await novastarService.connect({
                address: settings.address,
                port: settings.port,
                pId: settings.pId,
                secretKey: settings.secretKey
            });
            saveNovastarSettings({
                ...saved,
                address: settings.address,
                port: settings.port,
                pId: settings.pId,
                secretKey: settings.secretKey,
                activeConnectionId: config.connectionId || null
            });
            if (typeof ack === 'function') ack({ ok: status.connectionState !== 'error', status });
        });

        onLocalSocket(socket, 'novastar_disconnect', async (payload, ack) => {
            // (payload, ack) even though payload is unused — see
            // videohub_disconnect above; a bare (ack) here would silently
            // hang emitAck() callers.
            await novastarService?.disconnect();
            if (typeof ack === 'function') ack({ ok: true });
        });

        onLocalSocket(socket, 'novastar_test', async (config = {}, ack) => {
            const result = novastarService
                ? await novastarService.testConnection({
                    address: config.address, port: config.port, pId: config.pId, secretKey: config.secretKey
                })
                : { ok: false, error: 'NovaStar service unavailable.' };
            if (typeof ack === 'function') ack(result);
        });

        onLocalSocket(socket, 'novastar_select_screen', (payload = {}, ack) => {
            const result = novastarService?.selectScreen(payload.screenId)
                || { ok: false, error: 'NovaStar service unavailable.' };
            const saved = loadNovastarSettings();
            saveNovastarSettings({ ...saved, selectedScreenId: payload.screenId ?? null });
            if (typeof ack === 'function') ack(result);
        });

        onLocalSocket(socket, 'novastar_read_screens', async (payload = {}, ack) => {
            const result = novastarService
                ? await novastarService.readScreens(payload.deviceId ?? 0)
                : { ok: false, error: 'NovaStar service unavailable.' };
            if (typeof ack === 'function') ack(result);
        });

        onLocalSocket(socket, 'novastar_ftb', async (payload = {}, ack) => {
            const result = novastarService
                ? await novastarService.setBlackout(payload)
                : { ok: false, error: 'NovaStar service unavailable.' };
            if (typeof ack === 'function') ack(result);
        });

        onLocalSocket(socket, 'novastar_freeze', async (payload = {}, ack) => {
            const result = novastarService
                ? await novastarService.setFreeze(payload)
                : { ok: false, error: 'NovaStar service unavailable.' };
            if (typeof ack === 'function') ack(result);
        });

        onLocalSocket(socket, 'novastar_set_brightness', async (payload = {}, ack) => {
            const result = novastarService
                ? await novastarService.setBrightness(payload)
                : { ok: false, error: 'NovaStar service unavailable.' };
            if (typeof ack === 'function') ack(result);
        });

        onLocalSocket(socket, 'novastar_save_brightness', async (payload = {}, ack) => {
            const result = novastarService
                ? await novastarService.saveBrightness(payload)
                : { ok: false, error: 'NovaStar service unavailable.' };
            if (typeof ack === 'function') ack(result);
        });

        onLocalSocket(socket, 'novastar_read_presets', async (payload = {}, ack) => {
            const result = novastarService
                ? await novastarService.readPresets(payload)
                : { ok: false, error: 'NovaStar service unavailable.' };
            if (typeof ack === 'function') ack(result);
        });

        onLocalSocket(socket, 'novastar_load_preset', async (payload = {}, ack) => {
            const result = novastarService
                ? await novastarService.playPreset(payload)
                : { ok: false, error: 'NovaStar service unavailable.' };
            if (typeof ack === 'function') ack(result);
        });

        onLocalSocket(socket, 'novastar_set_text_osd', async (payload = {}, ack) => {
            const result = novastarService
                ? await novastarService.setTextOsd(payload)
                : { ok: false, error: 'NovaStar service unavailable.' };
            if (typeof ack === 'function') ack(result);
        });

        onLocalSocket(socket, 'novastar_set_image_osd', async (payload = {}, ack) => {
            const result = novastarService
                ? await novastarService.setImageOsd(payload)
                : { ok: false, error: 'NovaStar service unavailable.' };
            if (typeof ack === 'function') ack(result);
        });

        socket.on('novastar_status_request', () => {
            if (!novastarService) return;
            socket.emit('novastar_status_update', isLocalSocket(socket)
                ? novastarService.getStatus()
                : novastarService.getPublicStatus());
        });
    });

    ipcMain.handle('select-local-video', async () => {
        const result = await dialog.showOpenDialog(controlWindow, {
            properties: ['openFile'],
            filters: [
                { name: 'Video Files', extensions: ['mp4', 'webm', 'mov', 'mkv'] },
                { name: 'All Files', extensions: ['*'] }
            ]
        });
        if (!result.canceled && result.filePaths.length > 0) {
            return result.filePaths[0];
        }
        return null;
    });

    ipcMain.handle('select-local-photo', async () => {
        const result = await dialog.showOpenDialog(controlWindow, {
            properties: ['openFile', 'multiSelections'],
            filters: [
                { name: 'Image Files', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp'] },
                { name: 'All Files', extensions: ['*'] }
            ]
        });
        if (!result.canceled && result.filePaths.length > 0) {
            return result.filePaths;
        }
        return null;
    });

    ipcMain.handle('select-whisper-executable', async () => {
        const result = await dialog.showOpenDialog(controlWindow, {
            properties: ['openFile'],
            filters: [
                { name: 'Executable Files', extensions: process.platform === 'win32' ? ['exe'] : ['*'] },
                { name: 'All Files', extensions: ['*'] }
            ]
        });
        return !result.canceled && result.filePaths.length > 0 ? result.filePaths[0] : null;
    });

    ipcMain.handle('select-whisper-model', async () => {
        const result = await dialog.showOpenDialog(controlWindow, {
            properties: ['openFile'],
            filters: [
                { name: 'Whisper Model Files', extensions: ['bin', 'gguf', 'pt', 'onnx'] },
                { name: 'All Files', extensions: ['*'] }
            ]
        });
        return !result.canceled && result.filePaths.length > 0 ? result.filePaths[0] : null;
    });


    // Handle display plugin/unplug updates dynamically
    screen.on('display-added', broadcastDisplays);
    screen.on('display-removed', (event, oldDisplay) => {
        broadcastDisplays();
        // Check windows
        if (graphicsWindow) {
            const currentBounds = graphicsWindow.getBounds();
            const wasOnRemovedDisplay = oldDisplay.bounds.x === currentBounds.x && oldDisplay.bounds.y === currentBounds.y;
            if (wasOnRemovedDisplay) {
                graphicsWindow.close();
                graphicsWindow = null;
            }
        }
        if (stageWindow) {
            const currentBounds = stageWindow.getBounds();
            const wasOnRemovedDisplay = oldDisplay.bounds.x === currentBounds.x && oldDisplay.bounds.y === currentBounds.y;
            if (wasOnRemovedDisplay) {
                stageWindow.close();
                stageWindow = null;
            }
        }
        if (backstageWindow) {
            const currentBounds = backstageWindow.getBounds();
            const wasOnRemovedDisplay = oldDisplay.bounds.x === currentBounds.x && oldDisplay.bounds.y === currentBounds.y;
            if (wasOnRemovedDisplay) {
                backstageWindow.close();
                backstageWindow = null;
            }
        }
    });

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindows();
        }
    });
});

app.on('window-all-closed', () => {
    app.quit();
});

app.on('before-quit', () => {
    ndiOutputService?.stop().catch(err => {
        console.error('Error stopping NDI output:', err);
    });
    atemService?.disconnect().catch(err => {
        console.error('Error disconnecting from ATEM:', err);
    });
    videohubService?.disconnect().catch(err => {
        console.error('Error disconnecting from Videohub:', err);
    });
    novastarService?.disconnect().catch(err => {
        console.error('Error disconnecting from NovaStar:', err);
    });
});
