import { app, BrowserWindow, screen, ipcMain, dialog, session, Menu, shell, globalShortcut } from 'electron';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { NdiOutputService } from './ndi_output_service.js';
import { AtemService } from './atem_service.js';

// Start the existing Express server automatically and grab its socket instance
import {
    io,
    app as expressApp,
    server,
    setTranslationGlossaryDir,
    getAuthToken,
    loadAtemSettings,
    saveAtemSettings,
    setTranslationSecretResolver,
    setPresentationLiveListener,
    isLocalSocket,
    onLocalSocket,
} from './server.js';
import {
    setTranslationSecretsDir,
    setTranslationSecret,
    getTranslationSecret,
    getTranslationSecretStatus,
} from './translation_secrets.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// This is a live-broadcast tool: a single unhandled rejection anywhere must not be allowed to
// take the show off air. Log with full stack for post-show diagnosis and keep running — a
// degraded app the operator can still drive beats a black output and a dead tray icon.
function logFatal(kind, error) {
    const detail = error?.stack || String(error);
    console.error(`[${kind}]`, detail);
    try {
        const line = `${new Date().toISOString()} [${kind}] ${detail}\n\n`;
        fs.appendFileSync(path.join(app.getPath('userData'), 'crash.log'), line, 'utf8');
    } catch (err) {
        console.error('[crash-log] could not write crash log:', err);
    }
}

process.on('uncaughtException', (error) => logFatal('uncaughtException', error));
process.on('unhandledRejection', (reason) => logFatal('unhandledRejection', reason));

const APP_VERSION = '1.0.0';
let controlWindow;
let graphicsWindow;
let stageWindow;
let backstageWindow;
let serverPort = null;
let ndiOutputService = null;
let atemService = null;

// System-wide presentation-clicker capture, held ONLY while a deck is actually on screen.
//
// A global shortcut *consumes* the keystroke process-wide, so registering these for the app's
// whole lifetime meant that merely having Broadcast Controller running broke the arrow keys and
// PageUp/PageDown in every other application on the machine. Scoping them to live presentation
// keeps the clicker working when it matters and gives the keys back the rest of the time. (This
// is the same hazard the note below describes for Space, which was already excluded for it.)
//
// Covers every key mapping in common use across clicker models —
// PageDown/PageUp is the most common standard, but plenty of models send plain arrow keys
// instead, and some (mainly combo laser-pointer/media-remote units) send the media-transport
// keys instead of either. Space is deliberately excluded from the global set even though the
// local in-window handler (PresentationGraphic.jsx) treats it as "next" too — hijacking the
// spacebar system-wide (not just while presenting) would eat spaces typed into every other
// running application, a much bigger footprint than arrow/page/media keys.
const CLICKER_NEXT_KEYS = ['PageDown', 'Right', 'Down', 'MediaNextTrack'];
const CLICKER_PREV_KEYS = ['PageUp', 'Left', 'Up', 'MediaPreviousTrack'];

let clickerShortcutsHeld = false;

function registerClickerShortcuts() {
    if (clickerShortcutsHeld) return;
    const sendNav = (direction) => () => {
        console.log(`[clicker] nav "${direction}" triggered`);
        controlWindow?.webContents.send('presentation-clicker-nav', direction);
    };
    const results = [];
    for (const key of [...CLICKER_NEXT_KEYS, ...CLICKER_PREV_KEYS]) {
        const direction = CLICKER_NEXT_KEYS.includes(key) ? 'next' : 'prev';
        const ok = globalShortcut.register(key, sendNav(direction));
        results.push(`${key}=${ok ? 'ok' : 'FAILED'}`);
        if (!ok) {
            console.warn(`[clicker] Failed to register global shortcut "${key}" — it may already be in use by another application. Presentation clicker navigation mapped to this key will not work.`);
        }
    }
    clickerShortcutsHeld = true;
    console.log(`[clicker] global shortcut registration: ${results.join(', ')}`);
}

function releaseClickerShortcuts() {
    if (!clickerShortcutsHeld) return;
    for (const key of [...CLICKER_NEXT_KEYS, ...CLICKER_PREV_KEYS]) {
        globalShortcut.unregister(key);
    }
    clickerShortcutsHeld = false;
    console.log('[clicker] global shortcuts released');
}

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

// Windows that are allowed to embed arbitrary operator-chosen sites, and therefore the only
// ones whose subframe responses get their frame-protection headers stripped. The NDI offscreen
// renderer registers itself here too, since it loads the same graphics page.
const outputWebContentsIds = new Set();

function registerOutputWebContents(win) {
    if (!win || win.isDestroyed()) return;
    const id = win.webContents.id;
    outputWebContentsIds.add(id);
    win.webContents.once('destroyed', () => outputWebContentsIds.delete(id));
}

function isOutputWebContents(webContentsId) {
    return typeof webContentsId === 'number' && outputWebContentsIds.has(webContentsId);
}

function isLocalAppUrl(urlString) {
    try {
        const parsed = new URL(urlString);
        return parsed.protocol === 'http:' && parsed.hostname === '127.0.0.1' && parsed.port === String(serverPort);
    } catch {
        return false;
    }
}

// loadURL returns a promise; every call site used to drop it, so a window that failed to load
// produced an unhandled rejection instead of a diagnosable message.
function loadWindowUrl(win, url, label) {
    win.loadURL(url).catch((err) => {
        console.error(`Failed to load the ${label}:`, err);
    });
}

// `allowExternalOpen` must stay false for any window that embeds operator-chosen third-party
// sites in iframes. setWindowOpenHandler fires for window.open() from ANY frame and gives no way
// to tell which frame asked, so on the output windows an embedded page could otherwise drive
// shell.openExternal and pop the operator's browser mid-show. Only the control window — the
// operator's own UI, where clicking a link should open a browser — gets that privilege.
function hardenWindowNavigation(win, { allowExternalOpen = false } = {}) {
    const openExternalIfSafe = (url) => {
        if (!allowExternalOpen) return;
        if (url.startsWith('https://') || url.startsWith('http://')) {
            shell.openExternal(url);
        }
    };

    win.webContents.setWindowOpenHandler(({ url }) => {
        openExternalIfSafe(url);
        return { action: 'deny' };
    });

    win.webContents.on('will-navigate', (event, url) => {
        if (!isLocalAppUrl(url)) {
            event.preventDefault();
            openExternalIfSafe(url);
        }
    });
}

function reloadWindowGracefully(browserWindow, forceReload) {
    if (!browserWindow || browserWindow.isDestroyed()) return;

    const doReload = () => {
        if (browserWindow.isDestroyed()) return;
        if (forceReload) browserWindow.webContents.reloadIgnoringCache();
        else browserWindow.webContents.reload();
    };

    if (browserWindow === controlWindow) {
        // Give the control window a chance to clear all outputs before it
        // tears down, so Preview/Output don't end up desynced after reload.
        browserWindow.webContents.send('before-reload');
        setTimeout(doReload, 300);
    } else {
        doReload();
    }
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
                {
                    label: 'Reload',
                    accelerator: 'CmdOrCtrl+R',
                    click: (menuItem, browserWindow) => reloadWindowGracefully(browserWindow, false)
                },
                {
                    label: 'Force Reload',
                    accelerator: 'CmdOrCtrl+Shift+R',
                    click: (menuItem, browserWindow) => reloadWindowGracefully(browserWindow, true)
                },
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
            sandbox: true,
            // Same reasoning as the graphics/stage/backstage windows below: an operator
            // routinely leaves this window unfocused while looking at the output display,
            // and Chromium throttling its nested frames (e.g. the Live Preview iframe)
            // while unfocused reads as "the preview stopped updating".
            backgroundThrottling: false
        }
    });

    hardenWindowNavigation(controlWindow, { allowExternalOpen: true });
    loadWindowUrl(controlWindow, localAppUrl('/'), 'control window');

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
            sandbox: true,
            webSecurity: true,
            // This window is never focused (operator works in the control window). Without this,
            // Chromium throttles its rendering/timers, causing the projector output to stutter.
            backgroundThrottling: false
        }
    });

    hardenWindowNavigation(graphicsWindow);
    registerOutputWebContents(graphicsWindow);
    loadWindowUrl(graphicsWindow, localAppUrl('/graphics', { mode: 'graphics' }), 'graphics output');

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
            sandbox: true,
            webSecurity: true,
            // Never focused — keep it rendering at full rate (see graphics window).
            backgroundThrottling: false
        }
    });

    hardenWindowNavigation(stageWindow);
    registerOutputWebContents(stageWindow);
    loadWindowUrl(stageWindow, localAppUrl('/graphics', { mode: 'stage' }), 'confidence monitor');

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
            sandbox: true,
            webSecurity: true,
            // Never focused — keep it rendering at full rate (see graphics window).
            backgroundThrottling: false
        }
    });

    hardenWindowNavigation(backstageWindow);
    loadWindowUrl(backstageWindow, localAppUrl('/backstage'), 'backstage monitor');

    backstageWindow.on('closed', () => {
        backstageWindow = null;
    });
}

function getDisplayList() {
    return screen.getAllDisplays().map(d => ({
        id: d.id,
        label: d.label || (d.internal ? 'Internal Display' : `External Display (${d.size.width}x${d.size.height})`),
        bounds: d.bounds
    }));
}

// `target` defaults to every client, which is right when the display topology actually changed.
// On connect, pass the connecting socket instead — broadcasting to everyone made app startup
// O(n²) as five windows connected in quick succession.
function broadcastDisplays(target = io) {
    target.emit('available_displays', getDisplayList());
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
    setPresentationLiveListener((live) => {
        if (live) registerClickerShortcuts();
        else releaseClickerShortcuts();
    });
    setTranslationGlossaryDir(app.getPath('userData'));
    setTranslationSecretsDir(app.getPath('userData'));
    // Lets server.js fetch the decrypted key at start_translation time, so it never has to be
    // sent up from the renderer (or across the LAN).
    setTranslationSecretResolver(getTranslationSecret);
    ndiOutputService = new NdiOutputService({
        preloadPath: path.join(__dirname, 'preload.cjs'),
        onStatus: (status) => io.emit('ndi_status_update', status),
        // The offscreen renderer loads the same graphics page, so it needs the same
        // frame-header exemption for embedded sites.
        onWindowCreated: registerOutputWebContents
    });

    atemService = new AtemService({
        // Remote-paired clients must never see the switcher's LAN address or the
        // full input list, so the fan-out is split by socket type.
        onStatus: (status) => {
            // getPublicStatus() was recomputed once per remote socket; it only depends on the
            // status, so build it once. Rooms do the fan-out, so the payload is serialized once
            // per room instead of once per socket.
            io.to('local').emit('atem_status_update', status);
            io.to('remote').emit('atem_status_update', atemService.getPublicStatus());
        }
    });

    const atemSettings = loadAtemSettings();
    if (atemSettings.autoConnect && atemSettings.address) {
        atemService.connect({ address: atemSettings.address, port: atemSettings.port });
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
    //
    // Scoped to the output windows via webContentsId. This used to apply to every subframe in
    // defaultSession, which disabled clickjacking and cross-origin isolation defenses for any
    // site the operator ever loaded — including inside the control window. Only the surfaces
    // that actually need to embed arbitrary sites get the exemption.
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
        if (details.resourceType !== 'subFrame' || !isOutputWebContents(details.webContentsId)) {
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
        broadcastDisplays(socket);

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

        // set_bg_color is handled in server.js. It used to be registered here as well, so every
        // colour change was broadcast twice.

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
            // connection and the saved-connections chip row stays in sync. Wrapped because a
            // read-only userData dir would otherwise reject out of this async handler — and
            // failing to persist must not also fail the connection that just succeeded.
            try {
                saveAtemSettings({ ...saved, address: settings.address, port: settings.port, activeConnectionId: config.connectionId || null });
            } catch (err) {
                console.error('Connected to the ATEM but could not save the connection:', err);
            }
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

    // Write-only from the renderer's point of view: it can set or clear a key and ask whether
    // one exists, but there is deliberately no handler that returns a key's value.
    ipcMain.handle('set-translation-secret', (event, name, value) => {
        if (event.sender !== controlWindow?.webContents) {
            return { ok: false, error: 'Credentials can only be changed from the main controller.' };
        }
        return setTranslationSecret(name, value);
    });

    ipcMain.handle('get-translation-secret-status', (event) => {
        if (event.sender !== controlWindow?.webContents) return {};
        return getTranslationSecretStatus();
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
    globalShortcut.unregisterAll();
    ndiOutputService?.stop().catch(err => {
        console.error('Error stopping NDI output:', err);
    });
    atemService?.disconnect().catch(err => {
        console.error('Error disconnecting from ATEM:', err);
    });
});
