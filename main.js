import { app, BrowserWindow, screen, ipcMain, dialog, session, Menu, shell } from 'electron';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { NdiOutputService } from './ndi_output_service.js';

// Start the existing Express server automatically and grab its socket instance
import { io, app as expressApp, server, setTranslationGlossaryDir, getAuthToken } from './server.js'; 

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const APP_VERSION = '1.0.0';
let controlWindow;
let graphicsWindow;
let stageWindow;
let backstageWindow;
let serverPort = null;
let ndiOutputService = null;

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
// NOTE: the GPU process initializes asynchronously, so the "startup" snapshot can show
// everything as software ("disabled_software", gl=none) before init finishes — that is
// expected and NOT a problem. The "settled" snapshot, taken a few seconds later, is the one
// that reflects reality. Both are written to <userData>/gpu-status.json (and the console) so
// you can verify on any machine, including packaged Windows builds.
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
    console.log(`[GPU] ${label}:`, JSON.stringify(snap.featureStatus, null, 2));
    return snap;
}

async function logGpuStatus() {
    const report = { startup: null, settled: null };
    // Immediate snapshot (may be pre-initialization).
    report.startup = await captureGpuSnapshot('startup');
    write();
    // Settled snapshot a few seconds later, after the GPU process has initialized.
    setTimeout(async () => {
        report.settled = await captureGpuSnapshot('settled');
        write();
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
});
