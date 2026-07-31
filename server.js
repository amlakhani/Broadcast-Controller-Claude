import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';
import https from 'https';
import zlib from 'zlib';
import fs from 'fs';
import os from 'os';
import crypto from 'crypto';
import { spawn as defaultSpawn } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = createServer(app);
const AUTH_TOKEN = crypto.randomBytes(32).toString('hex');
const io = new Server(server, {
    maxHttpBufferSize: 1e8 // 100MB
});
app.use(express.json({ limit: '1mb' }));

const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.webm', '.mkv']);
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp']);
const STREAM_EXTENSIONS = new Set([...VIDEO_EXTENSIONS, ...IMAGE_EXTENSIONS]);
const GLOSSARY_LANGUAGES = ['en', 'gu', 'hi'];
const TRANSLATION_ENGINES = new Set(['azure', 'local', 'soniox']);
const DEFAULT_SONIOX_MODEL = 'stt-rt-v4';
const DEFAULT_LOCAL_AI_SETTINGS = {
    ollamaBaseUrl: 'http://localhost:11434',
    ollamaModel: '',
    whisperExecutablePath: '',
    whisperModelPath: '',
    chunkSeconds: 5
};
const DEFAULT_MEDIA_MESSAGE_OVERLAY = {
    enabled: false,
    text: '',
    position: 'center',
    size: 72,
    color: '#ffffff',
    weight: '800',
    uppercase: false,
    backdrop: true
};
const REMOTE_SESSION_TTL_MS = 8 * 60 * 60 * 1000;
// Pairing brute-force protection: after PAIRING_MAX_FAILURES wrong codes from a
// single client IP, that IP is locked out for PAIRING_LOCKOUT_MS. Combined with
// rotating the 6-digit code on every successful pair, this bounds an attacker to
// a handful of guesses per lockout window instead of unlimited.
const PAIRING_MAX_FAILURES = 5;
const PAIRING_LOCKOUT_MS = 30 * 1000;
const PAIRING_ATTEMPT_TTL_MS = 5 * 60 * 1000;
// The pairing code is embedded in the scannable QR, so it rotates on a timer to keep a
// photographed QR from staying useful. The grace window keeps the immediately-previous code
// valid briefly so a scan (or manual entry) that lands mid-rotation still succeeds.
const PAIRING_CODE_ROTATE_MS = 30 * 1000;
const PAIRING_CODE_GRACE_MS = 10 * 1000;

let translationGlossaryDir = process.env.BROADCAST_CONTROLLER_USER_DATA_DIR || path.join(os.homedir(), '.broadcast-controller');
let translationGlossaryCache = null;
let localAiSettingsCache = null;
let remoteAccessEnabled = false;
let remotePairingCode = generatePairingCode();
let remotePairingCodeIssuedAt = Date.now();
let previousPairingCode = '';
let previousPairingCodeExpiresAt = 0;
let pairingRotateTimer = null;
let remoteNetworkSelection = null;
let lastBlockedRemote = null;
let lastBlockedEmitAt = 0;
let remoteSessions = new Map();
let pairingAttempts = new Map();
let serverHost = '127.0.0.1';
let registeredLocalMedia = new Map();

function getAuthToken() {
    return AUTH_TOKEN;
}

function getRequestToken(req) {
    return req.query?.auth || req.headers['x-bc-auth-token'] || getCookie(req, 'bc_auth') || '';
}

function generatePairingCode() {
    return String(crypto.randomInt(100000, 1000000));
}

function getRequestRemoteToken(req) {
    return req.query?.remoteToken || req.headers['x-bc-remote-token'] || getCookie(req, 'bc_remote_token') || '';
}

function getCookie(req, name) {
    const header = req.headers.cookie || '';
    return header
        .split(';')
        .map(part => part.trim())
        .find(part => part.startsWith(`${name}=`))
        ?.slice(name.length + 1) || '';
}

function setAuthCookies(res, { authToken, remoteToken } = {}) {
    const cookies = [];
    const options = 'Path=/; SameSite=Strict; HttpOnly';
    if (authToken) cookies.push(`bc_auth=${encodeURIComponent(authToken)}; ${options}`);
    if (remoteToken) cookies.push(`bc_remote_token=${encodeURIComponent(remoteToken)}; ${options}`);
    if (cookies.length) res.setHeader('Set-Cookie', cookies);
}

function clearRemoteCookie(res) {
    res.setHeader('Set-Cookie', 'bc_remote_token=; Path=/; SameSite=Strict; HttpOnly; Max-Age=0');
}

function isValidAuthToken(token) {
    return typeof token === 'string' && token.length === AUTH_TOKEN.length && crypto.timingSafeEqual(Buffer.from(token), Buffer.from(AUTH_TOKEN));
}

function getRemoteSession(token) {
    if (typeof token !== 'string' || !token) return null;
    const session = remoteSessions.get(token);
    if (!session) return null;
    if (session.expiresAt <= Date.now()) {
        remoteSessions.delete(token);
        return null;
    }
    return session;
}

function isValidRemoteToken(token) {
    return remoteAccessEnabled && Boolean(getRemoteSession(token));
}

function timingSafeEqualString(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    if (!a.length || a.length !== b.length) return false;
    return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function isValidPairingCode(code) {
    if (timingSafeEqualString(code, remotePairingCode)) return true;
    // Grace window: a code retired by *timed* rotation stays valid briefly. A code retired by a
    // successful pair is cleared outright (see rotatePairingCode), so it can never be reused.
    if (previousPairingCode && Date.now() < previousPairingCodeExpiresAt) {
        return timingSafeEqualString(code, previousPairingCode);
    }
    return false;
}

// grace=true  -> timed rotation; the outgoing code stays usable for PAIRING_CODE_GRACE_MS.
// grace=false -> the outgoing code dies immediately (successful pair, enable/disable).
function rotatePairingCode({ grace = false } = {}) {
    if (grace) {
        previousPairingCode = remotePairingCode;
        previousPairingCodeExpiresAt = Date.now() + PAIRING_CODE_GRACE_MS;
    } else {
        previousPairingCode = '';
        previousPairingCodeExpiresAt = 0;
    }
    remotePairingCode = generatePairingCode();
    remotePairingCodeIssuedAt = Date.now();
    return remotePairingCode;
}

function stopPairingRotation() {
    if (!pairingRotateTimer) return;
    clearInterval(pairingRotateTimer);
    pairingRotateTimer = null;
}

function startPairingRotation() {
    stopPairingRotation();
    pairingRotateTimer = setInterval(() => {
        rotatePairingCode({ grace: true });
        emitRemoteAccessStatus();
    }, PAIRING_CODE_ROTATE_MS);
    // Never hold the process (or a test run) open just for the rotation timer.
    pairingRotateTimer.unref?.();
}

// req.ip ignores X-Forwarded-For unless trust proxy is set (it isn't), so this is
// the real TCP peer and can't be spoofed by a header to evade the rate limit.
function getClientIp(req) {
    return req.ip || req.socket?.remoteAddress || 'unknown';
}

function prunePairingAttempts(now = Date.now()) {
    for (const [ip, record] of pairingAttempts) {
        if (record.lockedUntil <= now && (now - record.lastAttemptAt) > PAIRING_ATTEMPT_TTL_MS) {
            pairingAttempts.delete(ip);
        }
    }
}

function getPairingLockMs(ip, now = Date.now()) {
    const record = pairingAttempts.get(ip);
    return record && record.lockedUntil > now ? record.lockedUntil - now : 0;
}

function registerPairingFailure(ip, now = Date.now()) {
    const record = pairingAttempts.get(ip) || { failures: 0, lockedUntil: 0, lastAttemptAt: now };
    record.failures += 1;
    record.lastAttemptAt = now;
    if (record.failures >= PAIRING_MAX_FAILURES) {
        record.lockedUntil = now + PAIRING_LOCKOUT_MS;
        record.failures = 0;
    }
    pairingAttempts.set(ip, record);
}

function requireAuth(req, res, next) {
    if (isValidAuthToken(getRequestToken(req)) || isValidRemoteToken(getRequestRemoteToken(req))) {
        return next();
    }
    return res.status(403).send('Forbidden');
}

function requireLocalAuth(req, res, next) {
    if (isValidAuthToken(getRequestToken(req))) {
        return next();
    }
    return res.status(403).send('Forbidden');
}

function isLocalSocket(socket) {
    return socket.data?.clientType === 'local';
}

function sendForbiddenAck(ack, message = 'This action is only available on the main controller.') {
    if (typeof ack === 'function') {
        ack({ ok: false, error: message });
    }
}

function requireLocalSocket(socket, ack) {
    if (isLocalSocket(socket)) return true;
    sendForbiddenAck(ack);
    socket.emit('action_forbidden', { error: 'This action is only available on the main controller.' });
    return false;
}

function onLocalSocket(socket, event, handler) {
    socket.on(event, (...args) => {
        const ack = args.find(arg => typeof arg === 'function');
        if (!requireLocalSocket(socket, ack)) return;
        handler(...args);
    });
}

function getAllowedOrigin(port = app.get('port')) {
    const origins = new Set([
        `http://127.0.0.1:${port}`,
        `http://localhost:${port}`
    ]);
    if (remoteAccessEnabled) {
        // Only the selected network's address is a valid origin.
        const active = getActiveRemoteAddress();
        if (active) origins.add(`http://${active}:${port}`);
    }
    return origins;
}

function isAllowedOrigin(origin, port = app.get('port')) {
    return !origin || getAllowedOrigin(port).has(origin);
}

function sendAppHtml(res, fileName) {
    const html = fs.readFileSync(path.join(__dirname, 'public_react', fileName), 'utf8');
    setAuthCookies(res, { authToken: AUTH_TOKEN });
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(html.replace('</head>', `<script>window.__BC_AUTH_TOKEN__=${JSON.stringify(AUTH_TOKEN)};</script></head>`));
}

function sendRemoteHtml(res, fileName = 'index.html') {
    const html = fs.readFileSync(path.join(__dirname, 'public_react', fileName), 'utf8');
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(html.replace('</head>', '<script>window.__BC_REMOTE_ENTRY__=true;</script></head>'));
}

function getLanAddresses() {
    const interfaces = os.networkInterfaces();
    const addresses = [];
    for (const entries of Object.values(interfaces)) {
        for (const entry of entries || []) {
            if (entry.family === 'IPv4' && !entry.internal) {
                addresses.push(entry.address);
            }
        }
    }
    return addresses;
}

// Adapters that are almost never the LAN a phone is on. Used only for ranking the
// "auto" default — every adapter is still selectable.
const VIRTUAL_ADAPTER_PATTERNS = [
    /virtualbox/i, /host-?only/i, /vethernet/i, /hyper-?v/i, /vmware/i,
    /tailscale/i, /zerotier/i, /docker/i, /wsl/i, /loopback/i, /bluetooth/i
];

function isVirtualAdapter(name = '') {
    return VIRTUAL_ADAPTER_PATTERNS.some(pattern => pattern.test(name));
}

function getNetworkAdapters() {
    const interfaces = os.networkInterfaces();
    const adapters = [];
    for (const [name, entries] of Object.entries(interfaces)) {
        const ipv4 = (entries || []).find(entry => entry.family === 'IPv4' && !entry.internal);
        if (ipv4) adapters.push({ name, address: ipv4.address, isVirtual: isVirtualAdapter(name) });
    }
    // Real adapters first; stable alphabetical within each group.
    adapters.sort((a, b) => (a.isVirtual === b.isVirtual ? a.name.localeCompare(b.name) : (a.isVirtual ? 1 : -1)));
    return adapters;
}

function getRemoteNetworkPath() {
    return path.join(translationGlossaryDir, 'remote-network.json');
}

// Selection is stored by adapter NAME, not IP — DHCP moves IPs, names are stable.
function loadRemoteNetworkSelection() {
    if (remoteNetworkSelection) return remoteNetworkSelection;
    try {
        const selectionPath = getRemoteNetworkPath();
        if (fs.existsSync(selectionPath)) {
            const parsed = JSON.parse(fs.readFileSync(selectionPath, 'utf8'));
            if (typeof parsed?.selected === 'string' && parsed.selected.trim()) {
                remoteNetworkSelection = parsed.selected.trim();
                return remoteNetworkSelection;
            }
        }
    } catch (err) {
        console.error('Failed to load remote network selection:', err);
    }
    remoteNetworkSelection = 'auto';
    return remoteNetworkSelection;
}

function saveRemoteNetworkSelection(selected) {
    const value = typeof selected === 'string' && selected.trim() ? selected.trim() : 'auto';
    remoteNetworkSelection = value;
    try {
        fs.mkdirSync(translationGlossaryDir, { recursive: true });
        fs.writeFileSync(getRemoteNetworkPath(), JSON.stringify({ selected: value }, null, 2), 'utf8');
    } catch (err) {
        console.error('Failed to save remote network selection:', err);
    }
    return value;
}

function getSelectedNetwork() {
    const adapters = getNetworkAdapters();
    const selection = loadRemoteNetworkSelection();
    if (selection === 'auto') {
        return adapters.find(adapter => !adapter.isVirtual) || adapters[0] || null;
    }
    return adapters.find(adapter => adapter.name === selection) || null;
}

// The single LAN address remote devices may reach us on ('' when unavailable).
function getActiveRemoteAddress() {
    return getSelectedNetwork()?.address || '';
}

function normalizeIpAddress(address = '') {
    if (typeof address !== 'string') return '';
    return address.replace(/^::ffff:/i, '');
}

// Must cover every loopback spelling — a naive '127.0.0.1' compare would lock the app's
// own windows (control/graphics/stage/backstage/NDI all connect over loopback) out.
function isLoopbackAddress(address) {
    const ip = normalizeIpAddress(address);
    return ip === '::1' || ip.startsWith('127.');
}

// Gate on the interface a connection ARRIVED on, so remote access is confined to the
// selected network. Loopback is always allowed, regardless of selection or enable state.
function isAllowedInterface(localAddress) {
    if (isLoopbackAddress(localAddress)) return true;
    if (!remoteAccessEnabled) return false;
    const active = getActiveRemoteAddress();
    return Boolean(active) && normalizeIpAddress(localAddress) === active;
}

function recordBlockedRemote(address) {
    lastBlockedRemote = { address: normalizeIpAddress(address) || 'unknown', when: Date.now() };
    // Surface promptly in Settings, but don't spam the socket under a scan/flood.
    if (Date.now() - lastBlockedEmitAt > 3000) {
        lastBlockedEmitAt = Date.now();
        emitRemoteAccessStatus();
    }
}

function getRemoteStatus() {
    const port = app.get('port');
    const sessions = [...remoteSessions.entries()]
        .map(([token, session]) => ({ token, session }))
        .filter(({ session }) => session.expiresAt > Date.now())
        .map(({ token, session }) => ({
            id: token.slice(0, 12),
            deviceName: session.deviceName,
            connected: Boolean(session.connected),
            pairedAt: session.pairedAt,
            expiresAt: session.expiresAt
        }));
    const activeAddress = getActiveRemoteAddress();
    const reachable = remoteAccessEnabled && Boolean(port) && Boolean(activeAddress);
    return {
        enabled: remoteAccessEnabled,
        pairingCode: remoteAccessEnabled ? remotePairingCode : '',
        pairingCodeExpiresAt: remoteAccessEnabled ? remotePairingCodeIssuedAt + PAIRING_CODE_ROTATE_MS : 0,
        lanUrls: reachable ? [`http://${activeAddress}:${port}/remote`] : [],
        slidesUrls: reachable ? [`http://${activeAddress}:${port}/slides`] : [],
        networks: getNetworkAdapters(),
        selectedNetwork: loadRemoteNetworkSelection(),
        activeAddress,
        networkUnavailable: remoteAccessEnabled && !activeAddress,
        lastBlocked: lastBlockedRemote,
        sessions
    };
}

function getRemotePublicStatus(token = '') {
    const session = getRemoteSession(token);
    return {
        enabled: remoteAccessEnabled,
        session: session ? {
            deviceName: session.deviceName,
            expiresAt: session.expiresAt
        } : null
    };
}

function emitRemoteAccessStatus() {
    for (const socket of io.sockets.sockets.values()) {
        socket.emit(
            'remote_access_status_update',
            isLocalSocket(socket) ? getRemoteStatus() : getRemotePublicStatus(socket.data?.remoteToken)
        );
    }
}

function getValidatedLocalPath(rawPath, allowedExtensions) {
    if (typeof rawPath !== 'string' || !rawPath || rawPath.includes('\0')) {
        return null;
    }

    const filePath = path.resolve(rawPath);
    const ext = path.extname(filePath).toLowerCase();
    if (!allowedExtensions.has(ext)) {
        return null;
    }

    try {
        const stat = fs.statSync(filePath);
        return stat.isFile() ? { filePath, stat, ext } : null;
    } catch {
        return null;
    }
}

function registerLocalMediaPath(rawPath, allowedExtensions = STREAM_EXTENSIONS) {
    const localFile = getValidatedLocalPath(rawPath, allowedExtensions);
    if (!localFile) return null;

    let realPath;
    try {
        realPath = fs.realpathSync(localFile.filePath);
    } catch {
        return null;
    }

    const existing = [...registeredLocalMedia.entries()].find(([, entry]) => entry.filePath === realPath);
    if (existing) {
        return { mediaId: existing[0], ...existing[1] };
    }

    const mediaId = crypto.randomBytes(18).toString('base64url');
    const entry = {
        filePath: realPath,
        ext: localFile.ext,
        stat: localFile.stat,
        registeredAt: Date.now()
    };
    registeredLocalMedia.set(mediaId, entry);
    return { mediaId, ...entry };
}

function getRegisteredLocalMedia(mediaId, allowedExtensions = STREAM_EXTENSIONS) {
    if (typeof mediaId !== 'string' || !mediaId) return null;
    const entry = registeredLocalMedia.get(mediaId);
    if (!entry || !allowedExtensions.has(entry.ext)) return null;
    try {
        const stat = fs.statSync(entry.filePath);
        return stat.isFile() ? { ...entry, stat } : null;
    } catch {
        registeredLocalMedia.delete(mediaId);
        return null;
    }
}

function resolveMediaRequest(req, allowedExtensions) {
    const registered = getRegisteredLocalMedia(req.query.mediaId, allowedExtensions);
    if (registered) return registered;

    if (isValidAuthToken(getRequestToken(req))) {
        return getValidatedLocalPath(req.query.path, allowedExtensions);
    }

    return null;
}

function normalizeLocalMediaPayload(data, socket, allowedExtensions = STREAM_EXTENSIONS) {
    if (!data || typeof data !== 'object') return data;
    if (!['local', 'photo'].includes(data.type)) return data;

    const registered = getRegisteredLocalMedia(data.mediaId, allowedExtensions);
    if (registered) {
        return { ...data, mediaId: data.mediaId, path: registered.filePath };
    }

    if (isLocalSocket(socket)) {
        const localMedia = registerLocalMediaPath(data.path, allowedExtensions);
        if (localMedia) {
            return { ...data, mediaId: localMedia.mediaId, path: localMedia.filePath };
        }
    }

    return null;
}

function getContentType(ext) {
    if (ext === '.mov') return 'video/quicktime';
    if (ext === '.webm') return 'video/webm';
    if (ext === '.mkv') return 'video/x-matroska';
    if (['.jpg', '.jpeg'].includes(ext)) return 'image/jpeg';
    if (ext === '.png') return 'image/png';
    if (ext === '.webp') return 'image/webp';
    if (ext === '.gif') return 'image/gif';
    if (ext === '.bmp') return 'image/bmp';
    return 'video/mp4';
}

function setLocalMediaHeaders(res) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Cache-Control', 'private, max-age=3600');
}

function setTranslationGlossaryDir(dir) {
    if (typeof dir === 'string' && dir.trim()) {
        translationGlossaryDir = dir;
        translationGlossaryCache = null;
        localAiSettingsCache = null;
    }
}

function getTranslationGlossaryPath() {
    return path.join(translationGlossaryDir, 'translation-glossary.json');
}

function getLocalAiSettingsPath() {
    return path.join(translationGlossaryDir, 'local-ai-settings.json');
}

function normalizeLocalAiSettings(settings = {}) {
    const chunkSeconds = Number(settings.chunkSeconds);
    return {
        ollamaBaseUrl: typeof settings.ollamaBaseUrl === 'string' && settings.ollamaBaseUrl.trim()
            ? settings.ollamaBaseUrl.trim().replace(/\/+$/, '')
            : DEFAULT_LOCAL_AI_SETTINGS.ollamaBaseUrl,
        ollamaModel: typeof settings.ollamaModel === 'string' ? settings.ollamaModel.trim() : '',
        whisperExecutablePath: typeof settings.whisperExecutablePath === 'string' ? settings.whisperExecutablePath.trim() : '',
        whisperModelPath: typeof settings.whisperModelPath === 'string' ? settings.whisperModelPath.trim() : '',
        chunkSeconds: Number.isFinite(chunkSeconds) ? Math.min(15, Math.max(2, chunkSeconds)) : DEFAULT_LOCAL_AI_SETTINGS.chunkSeconds
    };
}

function loadLocalAiSettings() {
    if (localAiSettingsCache) {
        return localAiSettingsCache;
    }

    try {
        const settingsPath = getLocalAiSettingsPath();
        if (!fs.existsSync(settingsPath)) {
            localAiSettingsCache = { ...DEFAULT_LOCAL_AI_SETTINGS };
            return localAiSettingsCache;
        }
        localAiSettingsCache = normalizeLocalAiSettings(JSON.parse(fs.readFileSync(settingsPath, 'utf8')));
        return localAiSettingsCache;
    } catch (err) {
        console.error('Failed to load Local AI settings:', err);
        localAiSettingsCache = { ...DEFAULT_LOCAL_AI_SETTINGS };
        return localAiSettingsCache;
    }
}

function saveLocalAiSettings(settings) {
    const normalized = normalizeLocalAiSettings(settings);
    fs.mkdirSync(translationGlossaryDir, { recursive: true });
    fs.writeFileSync(getLocalAiSettingsPath(), JSON.stringify(normalized, null, 2), 'utf8');
    localAiSettingsCache = normalized;
    return normalized;
}

function validateLocalAiSettings(settings = loadLocalAiSettings()) {
    const normalized = normalizeLocalAiSettings(settings);
    const checks = {
        ollamaUrl: false,
        ollamaModel: false,
        whisperExecutable: false,
        whisperModel: false
    };
    const errors = [];

    try {
        const parsed = new URL(normalized.ollamaBaseUrl);
        checks.ollamaUrl = parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch {
        checks.ollamaUrl = false;
    }
    if (!checks.ollamaUrl) errors.push('Enter a valid Ollama URL.');

    checks.ollamaModel = normalized.ollamaModel.length > 0;
    if (!checks.ollamaModel) errors.push('Enter an Ollama model name.');

    checks.whisperExecutable = validateExecutablePath(normalized.whisperExecutablePath);
    if (!checks.whisperExecutable) errors.push('Select a valid Whisper executable.');

    checks.whisperModel = normalized.whisperModelPath
        ? fs.existsSync(normalized.whisperModelPath) && fs.statSync(normalized.whisperModelPath).isFile()
        : false;
    if (!checks.whisperModel) errors.push('Select a valid Whisper model file.');

    return {
        ok: errors.length === 0,
        settings: normalized,
        checks,
        errors
    };
}

// --- ATEM switcher settings -------------------------------------------------
// Same three-part shape as the Local AI block above: normalize / load / save,
// plus a validate that returns { ok, settings, checks, errors }. Lives on disk in
// userData rather than localStorage because it is machine config, and because the
// socket to the hardware is opened by the Node process, not the renderer.

const DEFAULT_ATEM_SETTINGS = {
    address: '',
    port: 9910,
    autoConnect: false,
    connections: [],
    activeConnectionId: null
};

let atemSettingsCache = null;

function getAtemSettingsPath() {
    return path.join(translationGlossaryDir, 'atem-settings.json');
}

// Saved connection profiles: a named address/port the operator can switch to
// without retyping it — "one device connected at a time" with a quick-switch
// list on the side.
function normalizeConnectionList(list, defaultPort) {
    if (!Array.isArray(list)) return [];
    return list
        .map(entry => {
            const address = typeof entry?.address === 'string' ? entry.address.trim() : '';
            if (!address) return null;
            const port = Number(entry?.port);
            return {
                id: typeof entry.id === 'string' && entry.id.trim()
                    ? entry.id.trim()
                    : `conn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                name: typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim() : address,
                address,
                port: Number.isInteger(port) && port >= 1 && port <= 65535 ? port : defaultPort
            };
        })
        .filter(Boolean);
}

function normalizeAtemSettings(settings = {}) {
    const port = Number(settings.port);
    return {
        address: typeof settings.address === 'string' ? settings.address.trim() : '',
        port: Number.isInteger(port) && port >= 1 && port <= 65535 ? port : DEFAULT_ATEM_SETTINGS.port,
        autoConnect: settings.autoConnect === true,
        connections: normalizeConnectionList(settings.connections, DEFAULT_ATEM_SETTINGS.port),
        activeConnectionId: typeof settings.activeConnectionId === 'string' ? settings.activeConnectionId : null
    };
}

function loadAtemSettings() {
    if (atemSettingsCache) {
        return atemSettingsCache;
    }

    try {
        const settingsPath = getAtemSettingsPath();
        if (!fs.existsSync(settingsPath)) {
            atemSettingsCache = { ...DEFAULT_ATEM_SETTINGS };
            return atemSettingsCache;
        }
        atemSettingsCache = normalizeAtemSettings(JSON.parse(fs.readFileSync(settingsPath, 'utf8')));
        return atemSettingsCache;
    } catch (err) {
        console.error('Failed to load ATEM settings:', err);
        atemSettingsCache = { ...DEFAULT_ATEM_SETTINGS };
        return atemSettingsCache;
    }
}

function saveAtemSettings(settings) {
    const normalized = normalizeAtemSettings(settings);
    fs.mkdirSync(translationGlossaryDir, { recursive: true });
    fs.writeFileSync(getAtemSettingsPath(), JSON.stringify(normalized, null, 2), 'utf8');
    atemSettingsCache = normalized;
    return normalized;
}

// Deliberately NOT restricted to private ranges — some installs route the
// switcher across subnets.
//
// Port is not separately validated: normalizeAtemSettings already silently
// clamps anything out of range back to the default (9910, the fixed ATEM
// protocol port), the same "auto-correct, don't reject" treatment this file
// already gives chunkSeconds in the Local AI settings above. Checking it here
// too would just always report valid, since normalize never lets it be otherwise.
function validateAtemSettings(settings = loadAtemSettings()) {
    const normalized = normalizeAtemSettings(settings);
    const checks = { address: false };
    const errors = [];

    checks.address = isValidHost(normalized.address);
    if (!checks.address) errors.push('Enter a valid switcher IP address or hostname.');

    return { ok: errors.length === 0, settings: normalized, checks, errors };
}

// Generic IPv4/hostname validation.
function isValidHost(host) {
    if (typeof host !== 'string' || !host || host.includes('\0') || host.length > 253) return false;
    const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
    if (ipv4) {
        return ipv4.slice(1).every(part => Number(part) <= 255 && String(Number(part)) === part);
    }
    // Hostname: letters, digits, hyphens, dots; no leading/trailing hyphen per label.
    return /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)*$/.test(host);
}

function validateExecutablePath(rawPath) {
    if (typeof rawPath !== 'string' || !rawPath || rawPath.includes('\0')) return false;
    try {
        const realPath = fs.realpathSync(rawPath);
        const stat = fs.statSync(realPath);
        if (!stat.isFile()) return false;
        if (process.platform === 'win32') {
            return ['.exe', '.cmd', '.bat'].includes(path.extname(realPath).toLowerCase());
        }
        fs.accessSync(realPath, fs.constants.X_OK);
        return true;
    } catch {
        return false;
    }
}

function normalizeGlossaryEntry(entry = {}, existing = {}) {
    const normalized = {
        id: typeof entry.id === 'string' && entry.id.trim()
            ? entry.id.trim()
            : existing.id || `glossary-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        en: typeof entry.en === 'string' ? entry.en.trim() : existing.en || '',
        gu: typeof entry.gu === 'string' ? entry.gu.trim() : existing.gu || '',
        hi: typeof entry.hi === 'string' ? entry.hi.trim() : existing.hi || '',
        notes: typeof entry.notes === 'string' ? entry.notes.trim() : existing.notes || '',
        createdAt: existing.createdAt || entry.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString()
    };

    return normalized;
}

function isUsableGlossaryEntry(entry) {
    return GLOSSARY_LANGUAGES.filter(lang => entry[lang]).length >= 2;
}

function sanitizeGlossaryEntries(entries) {
    if (!Array.isArray(entries)) return [];
    return entries
        .map(entry => normalizeGlossaryEntry(entry))
        .filter(isUsableGlossaryEntry);
}

function loadTranslationGlossary() {
    if (translationGlossaryCache) {
        return translationGlossaryCache;
    }

    try {
        const glossaryPath = getTranslationGlossaryPath();
        if (!fs.existsSync(glossaryPath)) {
            translationGlossaryCache = [];
            return translationGlossaryCache;
        }
        const parsed = JSON.parse(fs.readFileSync(glossaryPath, 'utf8'));
        translationGlossaryCache = sanitizeGlossaryEntries(parsed.entries || parsed);
        return translationGlossaryCache;
    } catch (err) {
        console.error('Failed to load translation glossary:', err);
        translationGlossaryCache = [];
        return translationGlossaryCache;
    }
}

function saveTranslationGlossary(entries) {
    const sanitized = sanitizeGlossaryEntries(entries);
    fs.mkdirSync(translationGlossaryDir, { recursive: true });
    fs.writeFileSync(
        getTranslationGlossaryPath(),
        JSON.stringify({ version: 1, entries: sanitized }, null, 2),
        'utf8'
    );
    translationGlossaryCache = sanitized;
    return sanitized;
}

function escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function replaceEnglishPhrase(text, source, target) {
    const pattern = new RegExp(`\\b${escapeRegExp(source)}\\b`, 'gi');
    return text.replace(pattern, target);
}

function replaceUnicodePhrase(text, source, target) {
    return text.split(source).join(target);
}

function applyTranslationGlossary(text, targetLang) {
    if (typeof text !== 'string' || !GLOSSARY_LANGUAGES.includes(targetLang)) {
        return text;
    }

    let corrected = text;
    const glossary = loadTranslationGlossary();

    for (const entry of glossary) {
        const targetPhrase = entry[targetLang];
        if (!targetPhrase) continue;

        const phrases = GLOSSARY_LANGUAGES
            .map(lang => ({ lang, phrase: entry[lang] }))
            .filter(({ phrase }) => phrase && phrase !== targetPhrase)
            .sort((a, b) => b.phrase.length - a.phrase.length);

        for (const { lang, phrase } of phrases) {
            corrected = lang === 'en'
                ? replaceEnglishPhrase(corrected, phrase, targetPhrase)
                : replaceUnicodePhrase(corrected, phrase, targetPhrase);
        }

    }

    return corrected;
}

function buildSonioxTranslationTerms(targetLang) {
    if (!GLOSSARY_LANGUAGES.includes(targetLang)) return [];

    return loadTranslationGlossary().flatMap(entry => {
        const target = entry[targetLang];
        if (!target) return [];

        return GLOSSARY_LANGUAGES
            .filter(lang => lang !== targetLang && entry[lang])
            .map(lang => ({ source: entry[lang], target }));
    });
}

function isAllowedHostname(urlString, hostnames) {
    try {
        const parsed = new URL(urlString);
        return parsed.protocol === 'https:' && hostnames.some(host => parsed.hostname === host || parsed.hostname.endsWith(`.${host}`));
    } catch {
        return false;
    }
}

function buildGoogleSheetCsvUrls(rawUrl) {
    try {
        const parsed = new URL(rawUrl);
        if (parsed.protocol !== 'https:' || parsed.hostname !== 'docs.google.com') return [];
        const match = parsed.pathname.match(/\/spreadsheets\/d\/([^/]+)/);
        if (!match) return [];
        const gid = parsed.searchParams.get('gid') || '0';
        const id = encodeURIComponent(match[1]);
        const encodedGid = encodeURIComponent(gid);
        return [
            `https://docs.google.com/spreadsheets/d/${id}/gviz/tq?tqx=out:csv&gid=${encodedGid}`,
            `https://docs.google.com/spreadsheets/d/${id}/gviz/tq?tqx=out:csv`,
            `https://docs.google.com/spreadsheets/d/${id}/export?format=csv&gid=${encodedGid}`
        ];
    } catch {
        return [];
    }
}

async function fetchTextWithRedirects(url, redirectsLeft = 3) {
    const response = await fetch(url, {
        headers: {
            'User-Agent': 'Broadcast Controller/1.0',
            'Accept': 'text/csv,text/plain,*/*'
        },
        redirect: 'manual',
        signal: AbortSignal.timeout(15000)
    });

    if ([301, 302, 303, 307, 308].includes(response.status)) {
        if (redirectsLeft <= 0) throw new Error('Too many Google Sheet redirects.');
        const location = response.headers.get('location');
        if (!location) throw new Error('Google Sheet redirect did not include a target URL.');
        return fetchTextWithRedirects(new URL(location, url).toString(), redirectsLeft - 1);
    }

    if (!response.ok) {
        throw new Error(`Google Sheet returned HTTP ${response.status}. Make sure sharing is set to Anyone with the link / Viewer.`);
    }
    return response.text();
}

function streamLocalFile(req, res, localFile, notFoundMessage = 'File not found') {
    if (!localFile) {
        return res.status(404).send(notFoundMessage);
    }

    const { filePath, stat, ext } = localFile;
    const fileSize = stat.size;
    const range = req.headers.range;
    const contentType = getContentType(ext);
    setLocalMediaHeaders(res);

    if (range) {
        const parts = range.replace(/bytes=/, '').split('-');
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

        if (Number.isNaN(start) || Number.isNaN(end) || start < 0 || end >= fileSize || start > end) {
            return res.status(416).send('Invalid range');
        }

        const chunksize = (end - start) + 1;
        const file = fs.createReadStream(filePath, { start, end });
        const head = {
            'Content-Range': `bytes ${start}-${end}/${fileSize}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': chunksize,
            'Content-Type': contentType,
        };
        res.writeHead(206, head);
        file.pipe(res);
    } else {
        const head = {
            'Content-Length': fileSize,
            'Content-Type': contentType,
        };
        res.writeHead(200, head);
        fs.createReadStream(filePath).pipe(res);
    }
}

// Confine remote access to the selected network. Runs ahead of every route and the static
// handlers, so a device on another network cannot even fetch the JS bundle. Loopback always
// passes, which is what keeps the app's own windows working.
app.use((req, res, next) => {
    if (isAllowedInterface(req.socket?.localAddress)) return next();
    recordBlockedRemote(req.socket?.remoteAddress);
    return res.status(403).send('Forbidden: remote access is limited to a different network.');
});

app.get('/', requireAuth, (req, res) => {
    sendAppHtml(res, 'index.html');
});

app.get('/index.html', requireAuth, (req, res) => {
    sendAppHtml(res, 'index.html');
});

app.get('/graphics', requireAuth, (req, res) => {
    sendAppHtml(res, 'graphics.html');
});

app.get('/graphics.html', requireAuth, (req, res) => {
    sendAppHtml(res, 'graphics.html');
});

app.get('/backstage', requireAuth, (req, res) => {
    sendAppHtml(res, 'backstage.html');
});

app.get('/backstage.html', requireAuth, (req, res) => {
    sendAppHtml(res, 'backstage.html');
});

app.get('/remote', (req, res) => {
    sendRemoteHtml(res);
});

// Touch-first slides remote (phone/iPad). Pairs the same way as /remote.
// Must stay a single path segment: the built HTML references assets
// relatively ("./assets/..."), which only resolves to /assets at depth 1.
app.get('/slides', (req, res) => {
    sendRemoteHtml(res, 'remote.html');
});

app.get('/remote/slides', (req, res) => res.redirect('/slides'));

app.get('/api/remote/status', (req, res) => {
    if (isValidAuthToken(getRequestToken(req))) {
        return res.json(getRemoteStatus());
    }
    const session = getRemoteSession(getRequestRemoteToken(req));
    res.json(getRemotePublicStatus(getRequestRemoteToken(req)));
});

app.post('/api/remote/pair', (req, res) => {
    if (!remoteAccessEnabled) {
        return res.status(403).json({ ok: false, error: 'Remote Operators is disabled on the main controller.' });
    }

    const ip = getClientIp(req);
    const now = Date.now();
    prunePairingAttempts(now);

    const lockMs = getPairingLockMs(ip, now);
    if (lockMs > 0) {
        const retryAfter = Math.ceil(lockMs / 1000);
        res.set('Retry-After', String(retryAfter));
        return res.status(429).json({
            ok: false,
            error: `Too many pairing attempts. Try again in ${retryAfter}s.`,
            retryAfter
        });
    }

    const code = typeof req.body?.code === 'string' ? req.body.code.replace(/\D/g, '') : '';
    const deviceName = typeof req.body?.deviceName === 'string' && req.body.deviceName.trim()
        ? req.body.deviceName.trim().slice(0, 80)
        : 'Remote Controller';

    if (!isValidPairingCode(code)) {
        registerPairingFailure(ip, now);
        return res.status(401).json({ ok: false, error: 'Pairing code is not valid.' });
    }

    // Successful pair: clear this IP's failures and rotate the code so it can't be reused.
    // No grace here — the code that was just consumed must die immediately.
    pairingAttempts.delete(ip);
    rotatePairingCode({ grace: false });

    const token = crypto.randomBytes(32).toString('hex');
    const session = {
        deviceName,
        pairedAt: Date.now(),
        expiresAt: Date.now() + REMOTE_SESSION_TTL_MS,
        connected: false
    };
    remoteSessions.set(token, session);
    emitRemoteAccessStatus();
    setAuthCookies(res, { remoteToken: token });
    return res.json({
        ok: true,
        remoteToken: token,
        session: {
            deviceName,
            expiresAt: session.expiresAt
        }
    });
});

app.post('/api/local-media/register', requireLocalAuth, (req, res) => {
    const type = req.body?.type === 'photo' ? 'photo' : 'local';
    const extensions = type === 'photo' ? IMAGE_EXTENSIONS : STREAM_EXTENSIONS;
    const registered = registerLocalMediaPath(req.body?.path, extensions);
    if (!registered) {
        return res.status(400).json({ ok: false, error: 'Select a valid local media file.' });
    }
    return res.json({
        ok: true,
        media: {
            mediaId: registered.mediaId,
            path: registered.filePath,
            name: path.basename(registered.filePath),
            type
        }
    });
});

// Serve static files from the 'public_react' directory for the new Vite app.
// HTML entry points are handled above so they can receive the per-launch token.
app.use(express.static(path.join(__dirname, 'public_react'), { index: false }));
// Fallback to 'public' for legacy assets like logo.png
app.use(express.static(path.join(__dirname, 'public'), { index: false }));
// Self-hosted typography: Unicode Gujarati webfonts (fonts/unicode) and the legacy
// 8-bit Gujarati TTFs (fonts/). Serving these locally is what lets Gujarati lyrics
// render with no internet — previously the only Gujarati face came from a CDN.
app.use('/fonts', express.static(path.join(__dirname, 'fonts'), {
    index: false,
    immutable: true,
    maxAge: '30d'
}));

// Endpoint to stream local video files with Range support (for seeking/streaming)
app.get('/local-video', requireAuth, (req, res) => {
    streamLocalFile(req, res, resolveMediaRequest(req, VIDEO_EXTENSIONS), 'Video not found');
});

// Endpoint to serve local images for thumbnails
app.get('/local-image', requireAuth, (req, res) => {
    const localImage = resolveMediaRequest(req, IMAGE_EXTENSIONS);
    if (!localImage) {
        return res.status(404).send('File not found');
    }
    setLocalMediaHeaders(res);
    res.sendFile(localImage.filePath, { dotfiles: 'deny' });
});

app.get('/fetch-google-sheet', requireAuth, async (req, res) => {
    const csvUrls = buildGoogleSheetCsvUrls(req.query.url || '');
    if (csvUrls.length === 0) {
        return res.status(400).send('Paste a valid Google Sheets link.');
    }
    let lastError = null;
    try {
        for (const csvUrl of csvUrls) {
            try {
                const text = await fetchTextWithRedirects(csvUrl);
                res.set('Content-Type', 'text/csv; charset=utf-8');
                res.set('Cache-Control', 'no-store');
                return res.send(text);
            } catch (err) {
                lastError = err;
            }
        }
        throw lastError || new Error('Could not fetch Google Sheet.');
    } catch (err) {
        console.error('Failed to fetch Google Sheet:', err);
        return res.status(502).send(err.message || 'Could not fetch Google Sheet.');
    }
});

// Anirdesh lyrics fetcher proxy
app.get('/fetch-anirdesh', requireAuth, (req, res) => {
    const anirdeshUrl = decodeURIComponent(req.query.url || '');
    if (!isAllowedHostname(anirdeshUrl, ['anirdesh.com'])) {
        return res.status(400).send('Invalid Anirdesh URL');
    }
    const options = {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Accept': 'text/html,application/xhtml+xml',
            'Accept-Language': 'gu,en;q=0.9'
        }
    };
    const doFetch = (fetchUrl) => {
        if (!isAllowedHostname(fetchUrl, ['anirdesh.com'])) {
            return res.status(400).send('Invalid Anirdesh redirect');
        }
        https.get(fetchUrl, options, (response) => {
            if (response.statusCode === 301 || response.statusCode === 302) {
                const nextUrl = new URL(response.headers.location, fetchUrl).toString();
                return doFetch(nextUrl);
            }
            let data = '';
            response.setEncoding('utf8');
            response.on('data', chunk => { data += chunk; });
            response.on('end', () => {
                res.set('Content-Type', 'text/html; charset=utf-8');
                res.send(data);
            });
        }).on('error', (err) => {
            res.status(500).send('Fetch error: ' + err.message);
        });
    };
    doFetch(anirdeshUrl);
});

// Anirdesh search proxy
app.get('/search-anirdesh', requireAuth, (req, res) => {
    const query = req.query.q || '';
    const what = req.query.what || 'title';
    const type = req.query.type || 'keyword';
    const beg = req.query.beg || '0';

    if (!query || query.length < 2) {
        return res.json([]);
    }

    const postData = `q=${encodeURIComponent(query)}&what=${what}&type=${type}&beg=${beg}`;

    const options = {
        hostname: 'www.anirdesh.com',
        port: 443,
        path: '/kirtan/search.php',
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            'Content-Length': Buffer.byteLength(postData),
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Accept': 'application/json, text/javascript, */*',
            'Referer': 'https://www.anirdesh.com/kirtan/',
            'Origin': 'https://www.anirdesh.com'
        }
    };

    const proxyReq = https.request(options, (proxyRes) => {
        let data = '';
        proxyRes.setEncoding('utf8');
        proxyRes.on('data', chunk => { data += chunk; });
        proxyRes.on('end', () => {
            res.set('Content-Type', 'application/json; charset=utf-8');
            try {
                // Validate it's JSON before sending
                JSON.parse(data);
                res.send(data);
            } catch (e) {
                res.json({ error: 'true', text: 'Invalid response from Anirdesh' });
            }
        });
    });

    proxyReq.on('error', (err) => {
        res.status(500).json({ error: 'true', text: 'Search error: ' + err.message });
    });

    proxyReq.write(postData);
    proxyReq.end();
});

// --- YouTube playlist scraping helpers ---

// Request gzip so the ~1MB playlist page and each 100-video continuation
// response transfer compressed — the main speed win for large playlists.
const YT_BROWSE_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br'
};

// Reuse one TLS connection across the (sequential) continuation requests.
const ytBrowseAgent = new https.Agent({ keepAlive: true });

// Decompress a response body buffer according to its Content-Encoding.
function decodeResponseBody(response, buffer) {
    const encoding = (response.headers['content-encoding'] || '').toLowerCase();
    if (encoding === 'gzip') return zlib.gunzipSync(buffer);
    if (encoding === 'deflate') return zlib.inflateSync(buffer);
    if (encoding === 'br') return zlib.brotliDecompressSync(buffer);
    return buffer;
}

// Fetch a URL and resolve with the full response body as a string.
function httpsGetText(url, headers = {}) {
    return new Promise((resolve, reject) => {
        https.get(url, { headers, agent: ytBrowseAgent }, (response) => {
            if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
                // Follow a single redirect (e.g. consent → playlist).
                response.resume();
                return httpsGetText(response.headers.location, headers).then(resolve, reject);
            }
            const chunks = [];
            response.on('data', chunk => { chunks.push(chunk); });
            response.on('end', () => {
                try {
                    resolve(decodeResponseBody(response, Buffer.concat(chunks)).toString('utf8'));
                } catch (e) {
                    reject(e);
                }
            });
        }).on('error', reject);
    });
}

// POST a JSON body and resolve with the parsed JSON response.
function httpsPostJson(url, headers, bodyObj) {
    return new Promise((resolve, reject) => {
        const payload = JSON.stringify(bodyObj);
        const parsed = new URL(url);
        const options = {
            method: 'POST',
            hostname: parsed.hostname,
            path: parsed.pathname + parsed.search,
            agent: ytBrowseAgent,
            headers: {
                ...headers,
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload)
            }
        };
        const request = https.request(options, (response) => {
            const chunks = [];
            response.on('data', chunk => { chunks.push(chunk); });
            response.on('end', () => {
                try {
                    resolve(JSON.parse(decodeResponseBody(response, Buffer.concat(chunks)).toString('utf8')));
                } catch (e) {
                    reject(e);
                }
            });
        });
        request.on('error', reject);
        request.write(payload);
        request.end();
    });
}

// Extract a brace-balanced JSON object substring starting at the first `{`
// at or after `startIndex`, respecting string literals and escape sequences.
function extractBalancedJson(text, startIndex) {
    const open = text.indexOf('{', startIndex);
    if (open === -1) return null;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = open; i < text.length; i++) {
        const ch = text[i];
        if (inString) {
            if (escaped) { escaped = false; }
            else if (ch === '\\') { escaped = true; }
            else if (ch === '"') { inString = false; }
            continue;
        }
        if (ch === '"') { inString = true; }
        else if (ch === '{') { depth++; }
        else if (ch === '}') {
            depth--;
            if (depth === 0) return text.slice(open, i + 1);
        }
    }
    return null;
}

// Locate and parse the ytInitialData blob from a YouTube HTML page.
function extractYtInitialData(html) {
    const anchors = ['var ytInitialData =', 'window["ytInitialData"] =', 'ytInitialData ='];
    for (const anchor of anchors) {
        const idx = html.indexOf(anchor);
        if (idx === -1) continue;
        const jsonStr = extractBalancedJson(html, idx + anchor.length);
        if (!jsonStr) continue;
        try {
            return JSON.parse(jsonStr);
        } catch {
            // Try the next anchor form.
        }
    }
    return null;
}

// Collect { type, id, name } videos from a list of renderer items, de-duping
// against `seen`. Handles both YouTube's current `lockupViewModel` format and
// the legacy `playlistVideoRenderer`. Returns the next continuation token if any.
function collectPlaylistItems(items, results, seen) {
    let continuationToken = null;
    if (!Array.isArray(items)) return continuationToken;
    for (const item of items) {
        const lock = item?.lockupViewModel;
        const legacy = item?.playlistVideoRenderer;
        if (lock && lock.contentId && lock.contentType === 'LOCKUP_CONTENT_TYPE_VIDEO') {
            if (!seen.has(lock.contentId)) {
                seen.add(lock.contentId);
                results.push({
                    type: 'youtube',
                    id: lock.contentId,
                    name: lock.metadata?.lockupMetadataViewModel?.title?.content || `Video: ${lock.contentId}`
                });
            }
        } else if (legacy && legacy.videoId) {
            if (!seen.has(legacy.videoId)) {
                seen.add(legacy.videoId);
                results.push({
                    type: 'youtube',
                    id: legacy.videoId,
                    name: legacy.title?.runs?.[0]?.text || legacy.title?.simpleText || `Video: ${legacy.videoId}`
                });
            }
        } else if (item?.continuationItemViewModel) {
            continuationToken = item.continuationItemViewModel
                ?.continuationCommand?.innertubeCommand?.continuationCommand?.token || null;
        } else if (item?.continuationItemRenderer) {
            continuationToken = item.continuationItemRenderer
                ?.continuationEndpoint?.continuationCommand?.token || null;
        }
    }
    return continuationToken;
}

const YT_MAX_VIDEOS = 5000;
const YT_MAX_PAGES = 60;

// YouTube Playlist fetcher proxy — scrapes the playlist page, then paginates
// through YouTube's internal InnerTube browse API to fetch the whole playlist.
app.get('/fetch-youtube-playlist', requireAuth, async (req, res) => {
    let playlistUrl = decodeURIComponent(req.query.url || '');
    if (!isAllowedHostname(playlistUrl, ['youtube.com', 'youtu.be']) || !playlistUrl.includes('list=')) {
        return res.status(400).send('Invalid YouTube Playlist URL');
    }

    // Normalize URL to the playlist page if it's a watch link
    if (playlistUrl.includes('watch?v=')) {
        const url = new URL(playlistUrl);
        const listId = url.searchParams.get('list');
        playlistUrl = `https://www.youtube.com/playlist?list=${listId}`;
    }

    const parsedMax = parseInt(req.query.max, 10);
    const maxVideos = Number.isFinite(parsedMax) && parsedMax > 0
        ? Math.min(parsedMax, YT_MAX_VIDEOS)
        : YT_MAX_VIDEOS;

    try {
        const html = await httpsGetText(playlistUrl, YT_BROWSE_HEADERS);
        const initialData = extractYtInitialData(html);
        if (!initialData) {
            console.error('YouTube playlist scrape: ytInitialData not found');
            return res.status(500).send('Failed to parse playlist data');
        }

        const results = [];
        const seen = new Set();

        // Current format: lockupViewModel items live directly in itemSectionRenderer.contents.
        const itemSection = initialData.contents?.twoColumnBrowseResultsRenderer?.tabs?.[0]
            ?.tabRenderer?.content?.sectionListRenderer?.contents?.[0]?.itemSectionRenderer?.contents;
        // Legacy format nested them under playlistVideoListRenderer.contents.
        const contents = itemSection?.[0]?.playlistVideoListRenderer?.contents || itemSection;

        let continuationToken = collectPlaylistItems(contents, results, seen);

        // Extract InnerTube credentials for continuation requests.
        const apiKeyMatch = html.match(/"INNERTUBE_API_KEY":"([^"]+)"/);
        const clientVersionMatch = html.match(/"INNERTUBE_CONTEXT_CLIENT_VERSION":"([^"]+)"/)
            || html.match(/"clientVersion":"([^"]+)"/);
        const apiKey = apiKeyMatch?.[1];
        const clientVersion = clientVersionMatch?.[1];

        // Paginate through continuation tokens (best-effort).
        let pages = 0;
        while (
            continuationToken && apiKey && clientVersion &&
            results.length < maxVideos && pages < YT_MAX_PAGES
        ) {
            pages++;
            try {
                const browseUrl = `https://www.youtube.com/youtubei/v1/browse?key=${apiKey}`;
                const body = {
                    context: { client: { clientName: 'WEB', clientVersion } },
                    continuation: continuationToken
                };
                const json = await httpsPostJson(browseUrl, YT_BROWSE_HEADERS, body);
                const actions = json.onResponseReceivedActions || [];
                let nextToken = null;
                for (const action of actions) {
                    const items = action?.appendContinuationItemsAction?.continuationItems;
                    const token = collectPlaylistItems(items, results, seen);
                    if (token) nextToken = token;
                }
                continuationToken = nextToken;
            } catch (e) {
                console.error('YouTube playlist continuation failed:', e.message);
                break; // Best-effort: return what we have so far.
            }
        }

        res.json(maxVideos < results.length ? results.slice(0, maxVideos) : results);
    } catch (err) {
        console.error('YouTube playlist scrape error:', err.message);
        res.status(500).send('Fetch error: ' + err.message);
    }
});

// Local Video Streamer
app.get('/stream-video', requireAuth, (req, res) => {
    streamLocalFile(req, res, resolveMediaRequest(req, STREAM_EXTENSIONS), 'Media not found');
});

// Single slide image for image/PDF decks. Lets the slides remote render
// previews and thumbnails without ever receiving the whole `images` array.
app.get('/api/presentation/slide/:index', requireAuth, (req, res) => {
    const images = currentPresState?.images;
    if (currentPresState?.mode !== 'images' || !Array.isArray(images)) {
        return res.status(404).send('No image deck loaded');
    }
    const index = Number.parseInt(req.params.index, 10);
    if (!Number.isInteger(index) || index < 0 || index >= images.length) {
        return res.status(404).send('Slide not found');
    }
    const match = /^data:([\w/+.-]+);base64,(.*)$/s.exec(images[index] || '');
    if (!match) return res.status(404).send('Slide not available');

    res.set('Content-Type', match[1]);
    res.set('Cache-Control', 'no-cache');
    res.send(Buffer.from(match[2], 'base64'));
});


const EMPTY_PRESENTATION_STATE = {
    mode: 'none',
    baseUrl: '',
    slideId: '',
    currentIdx: 0,
    totalSlides: 0,
    images: [],
    isCanva: false,
    showing: false
};

let currentPresState = null;
let currentPresLibrary = [];
let currentStagePresToggle = false;
let currentStageTimerState = null;
let currentStageMessage = null;
let currentStageNegFlash = true;
let currentStageNegWhite = false;
let currentMediaData = null;
let currentPhotoData = null;
let currentParticlesState = { enabled: false, type: 'dust', intensity: 50, speed: 50 };
let currentMediaMessageOverlay = { ...DEFAULT_MEDIA_MESSAGE_OVERLAY };
let currentMediaPlaying = false;
let currentMediaLoop = false;
let currentMediaAutoNext = false;
let currentMediaMuted = false;
let currentOutputMode = { backgroundMode: 'green' };
let currentLayerVisibility = {
    presentation: true,
    media: true,
    lowerThirds: true,
    lyrics: true,
    translation: true,
    sabhaTimer: true,
    particles: true,
    mediaMessage: true
};
let currentLowerThirdState = null;
let currentLyricsState = null;
let currentSabhaState = { 
    showing: false, 
    overlayMedia: false, 
    timeStr: '16:00', 
    message: 'Sabha Starts In', 
    style: {
        msg: { fontFamily: "'Outfit', sans-serif", fontWeight: '700', fontSize: '36', letterSpacing: '5', color: '#ffffff' },
        timer: { fontFamily: "'Outfit', sans-serif", fontWeight: '700', fontSize: '130', letterSpacing: '0', color: '#ffffff' }
    }
};
let currentTranslationState = null;
let lastTranslationStyle = {};
let lastTranslationLayout = {};
let currentTranslationStatus = { state: 'idle', error: null, engine: 'azure', updatedAt: Date.now() };
let currentBackstageState = {
    title: 'Backstage Monitor',
    rows: [],
    currentIndex: -1,
    completedRows: {},
    displayMode: 'currentNext',
    message: null,
    timing: null,
    programDriftSeconds: 0,
    serviceStartedAt: null,
    updatedAt: Date.now()
};
let lastClearSnapshot = null;
let translationWorker = null;
let spawnTranslationWorker = defaultSpawn;

const ALLOWED_TRANSLATION_TARGETS = new Set(['en', 'gu', 'hi']);
const ALLOWED_TRANSLATION_SOURCES = new Set(['en-US', 'gu-IN', 'hi-IN']);
const ALLOWED_AZURE_REGIONS = new Set([
    'eastus',
    'eastus2',
    'westus2',
    'centralus',
    'northcentralus',
    'southcentralus',
    'centralindia',
    'westeurope',
    'southeastasia'
]);

function emitTranslationStatus(state, details = {}) {
    currentTranslationStatus = {
        state,
        error: details.error || null,
        engine: details.engine ?? currentTranslationStatus.engine,
        targetLang: details.targetLang ?? currentTranslationStatus.targetLang,
        sourceLanguages: details.sourceLanguages ?? currentTranslationStatus.sourceLanguages,
        updatedAt: Date.now()
    };
    io.emit('translation_status', currentTranslationStatus);
    emitOperatorState();
}

function summarizeMedia(data) {
    if (!data) return null;
    return {
        type: data.type || 'media',
        name: data.name || data.title || data.path || data.id || 'Media',
        path: data.path || '',
        id: data.id || '',
        duration: data.duration || 0
    };
}

function summarizePresentation(data) {
    if (!data) return null;
    return {
        mode: data.mode || 'none',
        showing: Boolean(data.showing && data.mode !== 'none'),
        currentIdx: Number.isFinite(Number(data.currentIdx)) ? Number(data.currentIdx) : 0,
        totalSlides: Number.isFinite(Number(data.totalSlides)) ? Number(data.totalSlides) : 0,
        isCanva: Boolean(data.isCanva),
        label: data.isCanva
            ? 'Canva'
            : data.totalSlides
                ? `Slide ${(Number(data.currentIdx) || 0) + 1} of ${data.totalSlides}`
                : 'Presentation'
    };
}

function normalizeMediaMessageOverlay(data = {}, existing = currentMediaMessageOverlay) {
    const size = Number(data.size);
    const weight = String(data.weight || existing.weight || '800');
    return {
        enabled: Boolean(data.enabled),
        text: typeof data.text === 'string' ? data.text.slice(0, 180) : existing.text || '',
        position: ['top', 'center', 'bottom', 'lowerThird'].includes(data.position) ? data.position : existing.position || 'center',
        size: Number.isFinite(size) ? Math.min(180, Math.max(24, size)) : existing.size || 72,
        color: typeof data.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(data.color) ? data.color : existing.color || '#ffffff',
        weight: ['500', '700', '800', '900'].includes(weight) ? weight : '800',
        uppercase: Boolean(data.uppercase),
        backdrop: data.backdrop !== undefined ? Boolean(data.backdrop) : existing.backdrop !== false
    };
}

function getOperatorState() {
    const presentation = summarizePresentation(currentPresState);
    const sabhaShowing = Boolean(currentSabhaState?.showing);
    const translationLive = Boolean(currentTranslationState);
    return {
        live: {
            presentation: Boolean(presentation?.showing),
            media: Boolean(currentMediaData && currentMediaPlaying),
            photo: Boolean(currentPhotoData),
            lowerThird: Boolean(currentLowerThirdState),
            lyrics: Boolean(currentLyricsState),
            sabhaTimer: sabhaShowing,
            translation: translationLive,
            particles: Boolean(currentParticlesState?.enabled),
            mediaMessage: Boolean(currentMediaMessageOverlay?.enabled && currentMediaMessageOverlay?.text)
        },
        current: {
            presentation,
            media: summarizeMedia(currentMediaData),
            photo: summarizeMedia(currentPhotoData),
            lowerThird: currentLowerThirdState,
            lyrics: currentLyricsState,
            sabhaTimer: currentSabhaState ? {
                showing: sabhaShowing,
                timeStr: currentSabhaState.timeStr,
                message: currentSabhaState.message
            } : null,
            stageTimer: currentStageTimerState,
            stageMessage: currentStageMessage,
            mediaMessage: currentMediaMessageOverlay,
            translation: currentTranslationState ? {
                text: currentTranslationState.text,
                sourceText: currentTranslationState.sourceText,
                isFinal: currentTranslationState.isFinal,
                engine: currentTranslationState.engine,
                lang: currentTranslationState.lang
            } : null
        },
        playback: {
            mediaPlaying: currentMediaPlaying,
            mediaLoop: currentMediaLoop,
            mediaAutoNext: currentMediaAutoNext,
            mediaMuted: currentMediaMuted
        },
        outputMode: currentOutputMode,
        layerVisibility: currentLayerVisibility,
        translationStatus: currentTranslationStatus,
        updatedAt: Date.now()
    };
}

function emitOperatorState(target = io) {
    target.emit('operator_state_update', getOperatorState());
}

// Slim presentation state for lightweight clients (the slides remote).
// Deliberately omits `images`, which can be many megabytes of base64.
function getPresMeta() {
    const state = currentPresState || EMPTY_PRESENTATION_STATE;
    return {
        mode: state.mode || 'none',
        baseUrl: state.baseUrl || '',
        slideId: state.slideId || '',
        currentIdx: state.currentIdx || 0,
        totalSlides: state.totalSlides || 0,
        isCanva: Boolean(state.isCanva),
        showing: Boolean(state.showing)
    };
}

function emitPresMeta(target = io) {
    target.emit('pres_meta', getPresMeta());
}

function validateTranslationConfig(config) {
    const engine = TRANSLATION_ENGINES.has(config?.engine) ? config.engine : 'azure';
    const key = typeof config?.key === 'string' ? config.key.trim() : '';
    const region = typeof config?.region === 'string' ? config.region.trim() : '';
    const targetLang = typeof config?.targetLang === 'string' ? config.targetLang.trim() : '';
    const sonioxModel = typeof config?.sonioxModel === 'string' && config.sonioxModel.trim()
        ? config.sonioxModel.trim()
        : DEFAULT_SONIOX_MODEL;
    const sourceLanguages = Array.isArray(config?.sourceLanguages)
        ? [...new Set(config.sourceLanguages.filter(lang => typeof lang === 'string'))]
        : [];

    if (!ALLOWED_TRANSLATION_TARGETS.has(targetLang)) return { ok: false, error: 'Select a supported target language.' };

    const invalidSource = sourceLanguages.find(lang => !ALLOWED_TRANSLATION_SOURCES.has(lang));
    if (invalidSource) return { ok: false, error: `Unsupported source language: ${invalidSource}` };
    if (sourceLanguages.length === 0) return { ok: false, error: 'Select at least one source language.' };

    if (engine === 'azure') {
        if (!key) return { ok: false, error: 'Azure Speech key is required.' };
        if (!ALLOWED_AZURE_REGIONS.has(region)) return { ok: false, error: 'Select a supported Azure Speech region.' };
    }

    if (engine === 'soniox') {
        if (!key) return { ok: false, error: 'Soniox API key is required.' };
    }

    const localAi = engine === 'local' ? validateLocalAiSettings(config?.localAiSettings || loadLocalAiSettings()) : null;
    if (localAi && !localAi.ok) {
        return { ok: false, error: localAi.errors.join(' ') };
    }

    return {
        ok: true,
        config: {
            engine,
            key,
            region,
            targetLang,
            sourceLanguages,
            sonioxModel,
            localAiSettings: localAi?.settings
        }
    };
}

const cleanupWorker = ({ emitStatus = false, status = 'idle', error = null, engine = null } = {}) => {
    if (translationWorker) {
        try {
            translationWorker.kill();
            console.log("Translation worker killed.");
        } catch (e) {
            console.error("Error killing translation worker:", e);
        }
        translationWorker = null;
    }
    if (emitStatus) {
        emitTranslationStatus(status, { error, engine });
    }
};

function resetServerStateForTests() {
    stopPairingRotation();
    remoteNetworkSelection = null;
    lastBlockedRemote = null;
    lastBlockedEmitAt = 0;
    previousPairingCode = '';
    previousPairingCodeExpiresAt = 0;
    currentPresState = null;
    currentPresLibrary = [];
    currentStagePresToggle = false;
    currentStageTimerState = null;
    currentStageMessage = null;
    currentStageNegFlash = true;
    currentStageNegWhite = false;
    currentMediaData = null;
    currentPhotoData = null;
    currentParticlesState = { enabled: false, type: 'dust', intensity: 50, speed: 50 };
    currentMediaMessageOverlay = { ...DEFAULT_MEDIA_MESSAGE_OVERLAY };
    currentMediaPlaying = false;
    currentMediaLoop = false;
    currentMediaAutoNext = false;
    currentMediaMuted = false;
    currentOutputMode = { backgroundMode: 'green' };
    currentLayerVisibility = {
        presentation: true,
        media: true,
        lowerThirds: true,
        lyrics: true,
        translation: true,
        sabhaTimer: true,
        particles: true,
        mediaMessage: true
    };
    atemSettingsCache = null;
    currentLowerThirdState = null;
    currentLyricsState = null;
    currentSabhaState = {
        showing: false,
        overlayMedia: false,
        timeStr: '16:00',
        message: 'Sabha Starts In',
        style: {
            msg: { fontFamily: "'Outfit', sans-serif", fontWeight: '700', fontSize: '36', letterSpacing: '5', color: '#ffffff' },
            timer: { fontFamily: "'Outfit', sans-serif", fontWeight: '700', fontSize: '130', letterSpacing: '0', color: '#ffffff' }
        }
    };
    currentTranslationState = null;
    lastTranslationStyle = {};
    lastTranslationLayout = {};
    currentTranslationStatus = { state: 'idle', error: null, engine: 'azure', updatedAt: Date.now() };
    currentBackstageState = {
        title: 'Backstage Monitor',
        rows: [],
        currentIndex: -1,
        completedRows: {},
        displayMode: 'currentNext',
        message: null,
        timing: null,
        programDriftSeconds: 0,
        serviceStartedAt: null,
        updatedAt: Date.now()
    };
    lastClearSnapshot = null;
    registeredLocalMedia = new Map();
    pairingAttempts.clear();
    cleanupWorker();
}

function setTranslationWorkerFactoryForTests(factory) {
    spawnTranslationWorker = factory || defaultSpawn;
}

function expireRemoteSessionForTests(token) {
    const session = remoteSessions.get(token);
    if (session) {
        session.expiresAt = Date.now() - 1;
    }
}

function sendTranslationGlossary(socket) {
    socket.emit('translation_glossary_update', loadTranslationGlossary());
}

function emitTranslationGlossaryUpdate() {
    io.emit('translation_glossary_update', loadTranslationGlossary());
}

function sendGlossaryResult(ack, result) {
    if (typeof ack === 'function') {
        ack(result);
    }
}

function sendSocketResult(ack, result) {
    if (typeof ack === 'function') {
        ack(result);
    }
}

function sendLocalAiSettings(socket) {
    socket.emit('local_ai_settings_update', loadLocalAiSettings());
}

io.use((socket, next) => {
    const origin = socket.handshake.headers.origin || '';
    const token = socket.handshake.auth?.token || socket.handshake.query?.auth || '';
    const remoteToken = socket.handshake.auth?.remoteToken || socket.handshake.query?.remoteToken || '';
    // Same network confinement as the HTTP middleware (loopback always allowed).
    if (!isAllowedInterface(socket.request?.socket?.localAddress)) {
        recordBlockedRemote(socket.request?.socket?.remoteAddress);
        return next(new Error('Unauthorized'));
    }
    if (!isAllowedOrigin(origin)) {
        return next(new Error('Unauthorized'));
    }
    if (isValidAuthToken(token)) {
        socket.data.clientType = 'local';
        return next();
    }
    const remoteSession = getRemoteSession(remoteToken);
    if (remoteAccessEnabled && remoteSession) {
        socket.data.clientType = 'remote';
        socket.data.remoteToken = remoteToken;
        socket.data.remoteSession = remoteSession;
        return next();
    }
    if (remoteToken && !remoteAccessEnabled) {
        remoteSessions.delete(remoteToken);
    }
    return next(new Error('Unauthorized'));
});

async function testLocalAiSettings(settings = loadLocalAiSettings()) {
    const validation = validateLocalAiSettings(settings);
    if (!validation.ok) {
        return validation;
    }

    const endpoint = `${validation.settings.ollamaBaseUrl}/api/generate`;
    try {
        const response = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: validation.settings.ollamaModel,
                prompt: 'Reply with exactly: OK',
                stream: false,
                options: { temperature: 0 }
            }),
            signal: AbortSignal.timeout(10000)
        });

        if (!response.ok) {
            return {
                ...validation,
                ok: false,
                checks: { ...validation.checks, ollamaResponse: false },
                errors: [`Ollama returned HTTP ${response.status}. Check the model name and that Ollama is running.`]
            };
        }

        const data = await response.json();
        return {
            ...validation,
            checks: { ...validation.checks, ollamaResponse: Boolean(data?.response) },
            response: data?.response || ''
        };
    } catch (err) {
        return {
            ...validation,
            ok: false,
            checks: { ...validation.checks, ollamaResponse: false },
            errors: [`Could not reach Ollama at ${validation.settings.ollamaBaseUrl}: ${err.message}`]
        };
    }
}

io.on('connection', (socket) => {
    console.log('A client connected');
    if (socket.data.remoteSession) {
        socket.data.remoteSession.connected = true;
        emitRemoteAccessStatus();
    }

    // Send cached state to the new client
    if (currentPresState) socket.emit('pres_update', currentPresState);
    emitPresMeta(socket);
    if (currentPresLibrary.length) socket.emit('pres_library_update', currentPresLibrary);
    socket.emit('stage_pres_toggle_update', currentStagePresToggle);
    
    if (currentStageTimerState) {
        if (currentStageTimerState.type === 'update') socket.emit('stage_timer_update', currentStageTimerState.data);
        else if (currentStageTimerState.type === 'pause') socket.emit('stage_timer_pause');
        else if (currentStageTimerState.type === 'stop') socket.emit('stage_timer_stop');
    }
    if (currentStageMessage) socket.emit('stage_message_update', currentStageMessage);
    if (currentSabhaState) socket.emit('sabha_timer_state', currentSabhaState);
    if (currentMediaData) {
        socket.emit('media_play', currentMediaData);
        socket.emit('media_toggle_play', currentMediaPlaying);
    }
    if (currentParticlesState) {
        socket.emit('particles_update', currentParticlesState);
    }
    if (currentMediaMessageOverlay) {
        socket.emit('media_message_overlay_update', currentMediaMessageOverlay);
    }
    if (currentTranslationState) {
        socket.emit('translation_update', currentTranslationState);
    }
    socket.emit('translation_status', currentTranslationStatus);
    sendTranslationGlossary(socket);
    if (isLocalSocket(socket)) sendLocalAiSettings(socket);
    socket.emit('output_mode_update', currentOutputMode);
    socket.emit('layer_visibility_update', currentLayerVisibility);
    socket.emit('backstage_state_update', currentBackstageState);
    emitOperatorState(socket);

    socket.on('remote_access_status_request', (ack) => {
        const status = isLocalSocket(socket) ? getRemoteStatus() : getRemotePublicStatus(socket.data?.remoteToken);
        socket.emit('remote_access_status_update', status);
        sendSocketResult(ack, { ok: true, status });
    });

    onLocalSocket(socket, 'remote_pairing_code_rotate', (ack) => {
        remotePairingCode = generatePairingCode();
        emitRemoteAccessStatus();
        sendSocketResult(ack, { ok: true, status: getRemoteStatus() });
    });

    onLocalSocket(socket, 'remote_session_revoke', (sessionId, ack) => {
        const entry = [...remoteSessions.entries()].find(([token]) => token.startsWith(String(sessionId || '')));
        if (!entry) {
            sendSocketResult(ack, { ok: false, error: 'Remote session was not found.' });
            return;
        }
        const [token] = entry;
        remoteSessions.delete(token);
        for (const connected of io.sockets.sockets.values()) {
            if (connected.data?.remoteToken === token) {
                connected.emit('remote_session_revoked');
                connected.disconnect(true);
            }
        }
        emitRemoteAccessStatus();
        sendSocketResult(ack, { ok: true });
    });

    socket.on('remote_logout', (...args) => {
        const ack = args.find(arg => typeof arg === 'function');
        if (!socket.data?.remoteToken) {
            sendSocketResult(ack, { ok: false, error: 'This socket is not a remote session.' });
            return;
        }
        const token = socket.data.remoteToken;
        remoteSessions.delete(token);
        sendSocketResult(ack, { ok: true });
        emitRemoteAccessStatus();
    });

    onLocalSocket(socket, 'remote_access_set_enabled', async (enabled, ack) => {
        try {
            await setRemoteAccessEnabled(Boolean(enabled));
            sendSocketResult(ack, { ok: true, status: getRemoteStatus() });
        } catch (err) {
            sendSocketResult(ack, { ok: false, error: err.message || 'Could not update remote access.' });
        }
    });

    // Local-only: a remote must never be able to widen the network it reaches us on.
    onLocalSocket(socket, 'remote_network_set', (selected, ack) => {
        saveRemoteNetworkSelection(selected);
        lastBlockedRemote = null;
        emitRemoteAccessStatus();
        sendSocketResult(ack, { ok: true, status: getRemoteStatus() });
    });

    let autoClearTimer = null;

    socket.on('show_lower_third', async (data) => {
        console.log('Showing lower third:', data);
        currentLowerThirdState = {
            name: data?.name || '',
            title: data?.title || '',
            subtitle2: data?.subtitle2 || '',
            autoClear: data?.autoClear || 0
        };
        
        // 1. Tell the graphics window to play the animation
        io.emit('play_graphic', data);
        emitOperatorState();
        
        // 2. Handle Auto Clear
        if (autoClearTimer) {
            clearTimeout(autoClearTimer);
            autoClearTimer = null;
        }

        if (data.autoClear && !isNaN(data.autoClear) && Number(data.autoClear) > 0) {
            const ms = Number(data.autoClear) * 1000;
            autoClearTimer = setTimeout(() => {
                console.log(`Auto clearing after ${data.autoClear}s`);
                triggerHide();
            }, ms);
        }
    });

    socket.on('show_lyrics', async (data) => {
        console.log('Showing lyrics:', data);
        currentLyricsState = {
            engText: data?.engText || '',
            gujText: data?.gujText || '',
            langOpt: data?.langOpt || 'both',
            autoClear: data?.autoClear || 0
        };
        io.emit('play_lyrics', data);
        emitOperatorState();

        if (autoClearTimer) {
            clearTimeout(autoClearTimer);
            autoClearTimer = null;
        }
        if (data.autoClear && !isNaN(data.autoClear) && Number(data.autoClear) > 0) {
            const ms = Number(data.autoClear) * 1000;
            autoClearTimer = setTimeout(triggerHide, ms);
        }
    });

    socket.on('clear_all', () => {
        console.log('Global Clear Triggered');
        if (autoClearTimer) {

            clearTimeout(autoClearTimer);
            autoClearTimer = null;
        }
        lastClearSnapshot = {
            presentationState: currentPresState ? { ...currentPresState } : null,
            mediaData: currentMediaData,
            mediaPlaying: currentMediaPlaying,
            photoData: currentPhotoData,
            mediaMessageOverlay: { ...currentMediaMessageOverlay },
            sabhaState: currentSabhaState ? { ...currentSabhaState } : null,
            translationState: currentTranslationState ? { ...currentTranslationState } : null,
            lowerThirdState: currentLowerThirdState ? { ...currentLowerThirdState } : null,
            lyricsState: currentLyricsState ? { ...currentLyricsState } : null,
            capturedAt: Date.now()
        };
        triggerHide();
        // Also clear media, photos, and timers
        currentMediaData = null;
        currentMediaPlaying = false;
        currentPhotoData = null;
        currentMediaMessageOverlay = { ...DEFAULT_MEDIA_MESSAGE_OVERLAY };
        currentPresState = { ...EMPTY_PRESENTATION_STATE };
        currentTranslationState = null;
        currentSabhaState = { ...currentSabhaState, showing: false };
        currentLowerThirdState = null;
        currentLyricsState = null;
        cleanupWorker({ emitStatus: true, status: 'idle' });
        io.emit('media_stop');
        io.emit('photo_stop');
        io.emit('media_message_overlay_update', currentMediaMessageOverlay);
        io.emit('pres_update', currentPresState);
        emitPresMeta();
        io.emit('stop_sabha');
        io.emit('hide_translation');
        emitOperatorState();
    });

    socket.on('restore_recent_clear', () => {
        if (!lastClearSnapshot || Date.now() - lastClearSnapshot.capturedAt > 30000) {
            socket.emit('restore_recent_clear_result', { ok: false, error: 'Nothing recent to restore' });
            return;
        }

        if (lastClearSnapshot.mediaData) {
            currentMediaData = lastClearSnapshot.mediaData;
            currentMediaPlaying = lastClearSnapshot.mediaPlaying;
            io.emit('media_play', currentMediaData);
            io.emit('media_toggle_play', currentMediaPlaying);
        }
        if (lastClearSnapshot.photoData) {
            currentPhotoData = lastClearSnapshot.photoData;
            io.emit('photo_play', currentPhotoData);
        }
        if (lastClearSnapshot.mediaMessageOverlay) {
            currentMediaMessageOverlay = lastClearSnapshot.mediaMessageOverlay;
            io.emit('media_message_overlay_update', currentMediaMessageOverlay);
        }
        if (lastClearSnapshot.presentationState) {
            currentPresState = lastClearSnapshot.presentationState;
            io.emit('pres_update', currentPresState);
            emitPresMeta();
        }
        if (lastClearSnapshot.sabhaState) {
            currentSabhaState = { ...lastClearSnapshot.sabhaState, showing: true };
            io.emit('sabha_timer_state', currentSabhaState);
        }
        if (lastClearSnapshot.translationState) {
            currentTranslationState = lastClearSnapshot.translationState;
            io.emit('translation_update', currentTranslationState);
        }
        if (lastClearSnapshot.lowerThirdState) {
            currentLowerThirdState = lastClearSnapshot.lowerThirdState;
        }
        if (lastClearSnapshot.lyricsState) {
            currentLyricsState = lastClearSnapshot.lyricsState;
        }

        socket.emit('restore_recent_clear_result', { ok: true });
        lastClearSnapshot = null;
        emitOperatorState();
    });

    const triggerHide = () => {
        console.log('Global Clear / Hide Triggered');
        
        // 1. Tell graphics window to animate out
        io.emit('stop_graphic');
        currentLowerThirdState = null;
        currentLyricsState = null;
        emitOperatorState();
    };

    socket.on('hide_lower_third', () => {
        if (autoClearTimer) {
            clearTimeout(autoClearTimer);
            autoClearTimer = null;
        }
        currentLowerThirdState = null;
        io.emit('stop_lower_third');
        emitOperatorState();
    });

    socket.on('hide_lyrics', () => {
        if (autoClearTimer) {
            clearTimeout(autoClearTimer);
            autoClearTimer = null;
        }
        currentLyricsState = null;
        io.emit('stop_lyrics');
        emitOperatorState();
    });

    // Style Updates
    socket.on('update_lt_style', (style) => io.emit('update_lt_style', style));
    socket.on('update_lt_design', (design) => io.emit('update_lt_design', design));
    socket.on('update_lyrics_style', (style) => io.emit('update_lyrics_style', style));
    socket.on('update_lyrics_layout', (layout) => io.emit('update_lyrics_layout', layout));

    socket.on('output_mode_update', (data) => {
        const allowedModes = new Set(['green', 'black', 'transparent']);
        const backgroundMode = allowedModes.has(data?.backgroundMode) ? data.backgroundMode : 'green';
        currentOutputMode = { backgroundMode };
        io.emit('output_mode_update', currentOutputMode);
        emitOperatorState();
    });

    socket.on('layer_visibility_update', (data) => {
        currentLayerVisibility = {
            ...currentLayerVisibility,
            ...Object.fromEntries(
                Object.entries(data || {}).filter(([key, value]) => (
                    Object.prototype.hasOwnProperty.call(currentLayerVisibility, key) && typeof value === 'boolean'
                ))
            )
        };
        io.emit('layer_visibility_update', currentLayerVisibility);
        emitOperatorState();
    });

    // --- STAGE DISPLAY RELAYS ---
    socket.on('set_stage_timer', (data) => {
        currentStageTimerState = { type: 'update', data };
        io.emit('stage_timer_update', data);
        emitOperatorState();
    });
    socket.on('pause_stage_timer', () => {
        currentStageTimerState = { type: 'pause' };
        io.emit('stage_timer_pause');
        emitOperatorState();
    });
    socket.on('resume_stage_timer', (data) => {
        currentStageTimerState = { type: 'update', data };
        io.emit('stage_timer_update', data);
        emitOperatorState();
    });
    socket.on('stop_stage_timer', () => {
        currentStageTimerState = { type: 'stop' };
        io.emit('stage_timer_stop');
        emitOperatorState();
    });
    socket.on('set_stage_message', (msg) => {
        currentStageMessage = msg;
        io.emit('stage_message_update', msg);
        emitOperatorState();
    });
    socket.on('set_stage_pres_toggle', (state) => {
        console.log('Stage Presentation Toggle:', state);
        currentStagePresToggle = state;
        io.emit('stage_pres_toggle_update', state);
    });
    socket.on('set_stage_neg_flash', (state) => {
        currentStageNegFlash = state;
        io.emit('stage_neg_flash_update', state);
    });
    socket.on('set_stage_neg_white', (state) => {
        currentStageNegWhite = state;
        io.emit('stage_neg_white_update', state);
    });

    socket.on('request_stage_state', () => {
        socket.emit('stage_pres_toggle_update', currentStagePresToggle);
        if (currentPresState) socket.emit('pres_update', currentPresState);
        socket.emit('stage_neg_flash_update', currentStageNegFlash);
        socket.emit('stage_neg_white_update', currentStageNegWhite);
        if (currentStageMessage) socket.emit('stage_message_update', currentStageMessage);
        if (currentStageTimerState) {
            if (currentStageTimerState.type === 'update') socket.emit('stage_timer_update', currentStageTimerState.data);
            else if (currentStageTimerState.type === 'pause') socket.emit('stage_timer_pause');
            else if (currentStageTimerState.type === 'stop') socket.emit('stage_timer_stop');
        }
    });

    socket.on('backstage_state_update', (state = {}) => {
        currentBackstageState = {
            title: typeof state.title === 'string' ? state.title.slice(0, 160) : 'Backstage Monitor',
            rows: Array.isArray(state.rows) ? state.rows.slice(0, 500) : [],
            currentIndex: Number.isFinite(Number(state.currentIndex)) ? Number(state.currentIndex) : -1,
            completedRows: state.completedRows && typeof state.completedRows === 'object' ? state.completedRows : {},
            displayMode: ['currentNext', 'full'].includes(state.displayMode) ? state.displayMode : 'currentNext',
            message: state.message && typeof state.message === 'object' ? {
                text: typeof state.message.text === 'string' ? state.message.text.slice(0, 120) : '',
                tone: ['normal', 'info', 'warning', 'urgent'].includes(state.message.tone) ? state.message.tone : 'normal',
                flash: Boolean(state.message.flash),
                updatedAt: Number(state.message.updatedAt) || Date.now()
            } : null,
            timing: state.timing && typeof state.timing === 'object' ? state.timing : null,
            programDriftSeconds: Number(state.programDriftSeconds) || 0,
            serviceStartedAt: Number(state.serviceStartedAt) || null,
            updatedAt: Date.now()
        };
        socket.broadcast.emit('backstage_state_update', currentBackstageState);
    });

    socket.on('request_backstage_state', () => {
        socket.emit('backstage_state_update', currentBackstageState);
    });

    // Sabha Countdown Relay
    socket.on('sabha_timer_update', (data) => {
        currentSabhaState = { ...currentSabhaState, ...data };
        console.log('Sabha Timer State Merged:', currentSabhaState);
        io.emit('sabha_timer_state', currentSabhaState);
        emitOperatorState();
    });

    // Remote Close Display
    socket.on('remote_close_display', () => io.emit('close_window_command'));

    // Media Playback Relays
    socket.on('play_media', (data) => {
        const media = normalizeLocalMediaPayload(data, socket, STREAM_EXTENSIONS);
        if (!media) {
            socket.emit('media_rejected', { error: 'This local media file is not registered on the main controller.' });
            return;
        }
        currentMediaData = media;
        currentMediaPlaying = true;
        io.emit('media_play', media);
        emitOperatorState();
    });
    socket.on('stop_media', () => {
        console.log('Media Stop Triggered');
        currentMediaData = null;
        currentMediaPlaying = false;
        io.emit('media_stop');
        emitOperatorState();
    });

    socket.on('media_time_update', (data) => socket.broadcast.emit('media_time_update', data));
    socket.on('media_audio_level', (data) => socket.broadcast.emit('media_audio_level', data));
    socket.on('media_seek', (time) => io.emit('media_seek', time));

    // Photo Library Relays
    socket.on('photo_play', (data) => {
        const photo = normalizeLocalMediaPayload(data, socket, IMAGE_EXTENSIONS);
        if (!photo) {
            socket.emit('media_rejected', { error: 'This local photo is not registered on the main controller.' });
            return;
        }
        currentPhotoData = photo;
        io.emit('photo_play', photo);
        emitOperatorState();
    });
    socket.on('photo_stop', () => {
        currentPhotoData = null;
        io.emit('photo_stop');
        emitOperatorState();
    });

    socket.on('media_toggle_play', (state) => {
        currentMediaPlaying = state;
        io.emit('media_toggle_play', state);
        emitOperatorState();
    });
    socket.on('set_bg_color', (color) => io.emit('bg_color_update', color));

    socket.on('request_media_state', () => {
        if (currentMediaData) {
            socket.emit('media_play', { 
                ...currentMediaData, 
                loop: currentMediaLoop, 
                autoNext: currentMediaAutoNext, 
                muted: currentMediaMuted 
            });
            socket.emit('media_toggle_play', currentMediaPlaying);
        }
        if (currentPhotoData) {
            socket.emit('photo_play', currentPhotoData);
        }
        socket.emit('media_message_overlay_update', currentMediaMessageOverlay);
    });

    socket.on('media_set_loop', (state) => {
        currentMediaLoop = state;
        io.emit('media_set_loop', state);
        emitOperatorState();
    });

    socket.on('media_set_auto_next', (state) => {
        currentMediaAutoNext = state;
        io.emit('media_set_auto_next', state);
        emitOperatorState();
    });

    socket.on('media_set_muted', (state) => {
        currentMediaMuted = state;
        io.emit('media_set_muted', state);
        emitOperatorState();
    });

    socket.on('media_next', () => {
        // Relay to Admin to play next
        io.emit('media_next');
    });

    socket.on('particles_update', (data) => {
        currentParticlesState = { ...currentParticlesState, ...data };
        io.emit('particles_update', currentParticlesState);
        emitOperatorState();
    });

    socket.on('media_message_overlay_update', (data) => {
        currentMediaMessageOverlay = normalizeMediaMessageOverlay(data);
        io.emit('media_message_overlay_update', currentMediaMessageOverlay);
        emitOperatorState();
    });

    socket.on('pres_update', (data) => {
        currentPresState = data;
        io.emit('pres_update', data);
        emitPresMeta();
        emitOperatorState();
    });

    socket.on('pres_nav', (data) => io.emit('pres_nav', data));

    // Server-authoritative navigation. Lets lightweight clients (the slides
    // remote) move the deck without echoing the whole state object back.
    socket.on('pres_goto', (payload) => {
        if (!currentPresState || currentPresState.mode === 'none') return;
        const total = currentPresState.totalSlides || 0;
        if (total <= 0) return;

        const current = currentPresState.currentIdx || 0;
        let next = current;
        const direction = payload?.direction;
        if (direction === 'next') next = current + 1;
        else if (direction === 'prev') next = current - 1;
        else if (direction === 'first') next = 0;
        else if (direction === 'last') next = total - 1;
        else if (Number.isInteger(payload?.index)) next = payload.index;
        else return;

        next = Math.max(0, Math.min(next, total - 1));
        if (next === current) return;

        currentPresState = { ...currentPresState, currentIdx: next };
        io.emit('pres_update', currentPresState);
        emitPresMeta();
        emitOperatorState();
    });

    socket.on('pres_set_showing', (showing) => {
        if (!currentPresState || currentPresState.mode === 'none') return;
        currentPresState = { ...currentPresState, showing: Boolean(showing) };
        io.emit('pres_update', currentPresState);
        emitPresMeta();
        emitOperatorState();
    });

    // The desktop panel owns the saved-deck library; cache it so remotes can list it.
    socket.on('pres_library_update', (library) => {
        currentPresLibrary = Array.isArray(library) ? library : [];
        socket.broadcast.emit('pres_library_update', currentPresLibrary);
    });

    socket.on('start_translation', (config) => {
        if (config?.engine === 'local' && !requireLocalSocket(socket)) return;
        const validated = validateTranslationConfig(config);
        if (!validated.ok) {
            socket.emit('translation_failed', { error: validated.error });
            emitTranslationStatus('error', { error: validated.error });
            return;
        }

        const { engine, targetLang, sourceLanguages } = validated.config;
        cleanupWorker({ emitStatus: true, status: 'starting', error: null, engine });
        console.log(`Starting ${engine} translation worker: Target=${targetLang}, Source=${sourceLanguages}`);

        try {
            const workerFile = engine === 'local'
                ? 'local_translation_worker.js'
                : engine === 'soniox'
                    ? 'soniox_translation_worker.js'
                    : 'translation_worker.js';
            const workerPath = path.join(__dirname, workerFile);
            // Spawn node directly with standard IPC stdio configuration
            translationWorker = spawnTranslationWorker('node', [workerPath], {
                stdio: ['inherit', 'inherit', 'inherit', 'ipc']
            });

            translationWorker.send({
                type: 'start',
                config: {
                    ...validated.config,
                    sonioxTranslationTerms: engine === 'soniox' ? buildSonioxTranslationTerms(targetLang) : []
                }
            });

            translationWorker.on('message', (msg) => {
                if (msg.type === 'translation_started') {
                    emitTranslationStatus('listening', { targetLang, sourceLanguages, engine });
                    socket.emit('translation_started');
                } else if (msg.type === 'translation_failed') {
                    socket.emit('translation_failed', { error: msg.error });
                    cleanupWorker({ emitStatus: true, status: 'error', error: msg.error });
                } else if (msg.type === 'translation_update') {
                    const correctedText = applyTranslationGlossary(msg.data.text, targetLang);
                    currentTranslationState = {
                        text: correctedText,
                        originalText: correctedText === msg.data.text ? undefined : msg.data.text,
                        sourceText: msg.data.sourceText,
                        isFinal: msg.data.isFinal,
                        lang: msg.data.lang,
                        engine,
                        style: lastTranslationStyle,
                        layout: lastTranslationLayout
                    };
                    io.emit('translation_update', currentTranslationState);
                    emitOperatorState();
                } else if (msg.type === 'translation_canceled') {
                    io.emit('translation_canceled', { error: msg.error });
                    cleanupWorker({ emitStatus: true, status: 'error', error: msg.error });
                } else if (msg.type === 'translation_stopped') {
                    io.emit('translation_stopped');
                    cleanupWorker({ emitStatus: true, status: 'idle' });
                }
            });

            translationWorker.on('error', (err) => {
                console.error("Translation worker process error:", err);
                socket.emit('translation_failed', { error: err.toString() });
                cleanupWorker({ emitStatus: true, status: 'error', error: err.toString() });
            });

            translationWorker.on('exit', (code) => {
                console.log(`Translation worker exited with code ${code}`);
                translationWorker = null;
            });

        } catch (err) {
            console.error("Failed to spawn translation worker:", err);
            socket.emit('translation_failed', { error: err.toString() });
            cleanupWorker({ emitStatus: true, status: 'error', error: err.toString() });
        }
    });

    socket.on('stop_translation', () => {
        emitTranslationStatus('stopping');
        cleanupWorker({ emitStatus: true, status: 'idle' });
        currentTranslationState = null;
        io.emit('hide_translation');
        emitOperatorState();
    });

    socket.on('clear_translation_display', () => {
        currentTranslationState = null;
        io.emit('hide_translation');
        emitOperatorState();
    });

    socket.on('audio_chunk', (chunk) => {
        if (translationWorker && translationWorker.connected) {
            translationWorker.send({
                type: 'audio_chunk',
                chunk: Buffer.from(chunk)
            });
        }
    });

    socket.on('translation_glossary_request', (ack) => {
        const entries = loadTranslationGlossary();
        socket.emit('translation_glossary_update', entries);
        sendGlossaryResult(ack, { ok: true, entries });
    });

    socket.on('translation_glossary_add', (entry, ack) => {
        const normalized = normalizeGlossaryEntry(entry);
        if (!isUsableGlossaryEntry(normalized)) {
            sendGlossaryResult(ack, { ok: false, error: 'Enter at least two matching language phrases.' });
            return;
        }

        try {
            const entries = saveTranslationGlossary([...loadTranslationGlossary(), normalized]);
            emitTranslationGlossaryUpdate();
            sendGlossaryResult(ack, { ok: true, entry: normalized, entries });
        } catch (err) {
            sendGlossaryResult(ack, { ok: false, error: err.message || 'Failed to save glossary entry.' });
        }
    });

    socket.on('translation_glossary_update_entry', (entry, ack) => {
        const entries = loadTranslationGlossary();
        const index = entries.findIndex(item => item.id === entry?.id);
        if (index === -1) {
            sendGlossaryResult(ack, { ok: false, error: 'Glossary entry was not found.' });
            return;
        }

        const normalized = normalizeGlossaryEntry(entry, entries[index]);
        if (!isUsableGlossaryEntry(normalized)) {
            sendGlossaryResult(ack, { ok: false, error: 'Enter at least two matching language phrases.' });
            return;
        }

        try {
            const nextEntries = [...entries];
            nextEntries[index] = normalized;
            const saved = saveTranslationGlossary(nextEntries);
            emitTranslationGlossaryUpdate();
            sendGlossaryResult(ack, { ok: true, entry: normalized, entries: saved });
        } catch (err) {
            sendGlossaryResult(ack, { ok: false, error: err.message || 'Failed to update glossary entry.' });
        }
    });

    socket.on('translation_glossary_delete', (id, ack) => {
        const entries = loadTranslationGlossary();
        const nextEntries = entries.filter(entry => entry.id !== id);
        if (nextEntries.length === entries.length) {
            sendGlossaryResult(ack, { ok: false, error: 'Glossary entry was not found.' });
            return;
        }

        try {
            const saved = saveTranslationGlossary(nextEntries);
            emitTranslationGlossaryUpdate();
            sendGlossaryResult(ack, { ok: true, entries: saved });
        } catch (err) {
            sendGlossaryResult(ack, { ok: false, error: err.message || 'Failed to delete glossary entry.' });
        }
    });

    // ATEM connection settings. Local-only: this is the LAN address of production
    // hardware, and saving it is machine configuration.
    onLocalSocket(socket, 'atem_settings_request', (ack) => {
        const settings = loadAtemSettings();
        socket.emit('atem_settings_update', settings);
        sendSocketResult(ack, { ok: true, settings, validation: validateAtemSettings(settings) });
    });

    onLocalSocket(socket, 'atem_settings_save', (settings, ack) => {
        try {
            const validation = validateAtemSettings(settings);
            if (!validation.ok) {
                sendSocketResult(ack, { ok: false, error: validation.errors[0], validation });
                return;
            }
            const saved = saveAtemSettings(settings);
            io.emit('atem_settings_update', saved);
            sendSocketResult(ack, { ok: true, settings: saved, validation });
        } catch (err) {
            sendSocketResult(ack, { ok: false, error: err.message || 'Failed to save ATEM settings.' });
        }
    });

    onLocalSocket(socket, 'local_ai_settings_request', (ack) => {
        const settings = loadLocalAiSettings();
        socket.emit('local_ai_settings_update', settings);
        sendSocketResult(ack, { ok: true, settings });
    });

    onLocalSocket(socket, 'local_ai_settings_save', (settings, ack) => {
        try {
            const saved = saveLocalAiSettings(settings);
            io.emit('local_ai_settings_update', saved);
            sendSocketResult(ack, { ok: true, settings: saved, validation: validateLocalAiSettings(saved) });
        } catch (err) {
            sendSocketResult(ack, { ok: false, error: err.message || 'Failed to save Local AI settings.' });
        }
    });

    onLocalSocket(socket, 'local_ai_test', async (settings, ack) => {
        try {
            const normalized = saveLocalAiSettings(settings || loadLocalAiSettings());
            io.emit('local_ai_settings_update', normalized);
            sendSocketResult(ack, await testLocalAiSettings(normalized));
        } catch (err) {
            sendSocketResult(ack, { ok: false, errors: [err.message || 'Local AI test failed.'] });
        }
    });

    socket.on('update_translation_style', (style) => {
        lastTranslationStyle = style;
        if (currentTranslationState) {
            currentTranslationState.style = style;
        }
        io.emit('update_translation_style', style);
        emitOperatorState();
    });

    socket.on('update_translation_layout', (layout) => {
        lastTranslationLayout = layout;
        if (currentTranslationState) {
            currentTranslationState.layout = layout;
        }
        io.emit('update_translation_layout', layout);
        emitOperatorState();
    });

    socket.on('disconnect', () => {
        console.log('Client disconnected');
    });
});

const DEFAULT_PORT = 5522;

function listenOn(port, host) {
    serverHost = host;
    return new Promise((resolve, reject) => {
        const cleanupListeners = () => {
            server.off('error', handleError);
            server.off('listening', handleListening);
        };
        const handleError = (err) => {
            cleanupListeners();
            reject(err);
        };
        const handleListening = () => {
            cleanupListeners();
            const actualPort = server.address().port;
            app.set('port', actualPort);
            resolve(actualPort);
        };

        server.once('error', handleError);
        server.once('listening', handleListening);
        server.listen(port, host);
    });
}

function closeHttpServer() {
    if (!server.listening) return Promise.resolve();
    return new Promise(resolve => {
        const finish = () => resolve();
        server.close(finish);
        server.closeIdleConnections?.();
        server.closeAllConnections?.();
    });
}

async function setRemoteAccessEnabled(enabled) {
    if (remoteAccessEnabled === enabled) {
        emitRemoteAccessStatus();
        return getRemoteStatus();
    }

    const currentPort = app.get('port') || server.address()?.port || DEFAULT_PORT;
    remoteAccessEnabled = enabled;
    rotatePairingCode({ grace: false });
    pairingAttempts.clear();
    lastBlockedRemote = null;

    if (enabled) {
        startPairingRotation();
    } else {
        stopPairingRotation();
    }

    if (!enabled) {
        remoteSessions.clear();
        for (const connected of io.sockets.sockets.values()) {
            if (connected.data?.remoteSession) {
                connected.emit('remote_session_revoked');
                connected.disconnect(true);
            }
        }
    }

    io.disconnectSockets(true);
    await closeHttpServer();
    await listenOn(currentPort, enabled ? '0.0.0.0' : '127.0.0.1');
    emitRemoteAccessStatus();
    return getRemoteStatus();
}

function startServer(port) {
    if (server.listening) {
        const actualPort = server.address().port;
        app.set('port', actualPort);
        return Promise.resolve(actualPort);
    }

    return new Promise((resolve, reject) => {
        const cleanupListeners = () => {
            server.off('error', handleError);
            server.off('listening', handleListening);
        };
        const handleError = (err) => {
            cleanupListeners();
            if (err.code === 'EADDRINUSE') {
                console.log(`Port ${port} is busy, trying ${port + 1}...`);
                startServer(port + 1).then(resolve).catch(reject);
            } else {
                console.error('Server error:', err);
                reject(err);
            }
        };
        const handleListening = () => {
            cleanupListeners();
            const actualPort = server.address().port;
            serverHost = '127.0.0.1';
            console.log(`Server running on http://127.0.0.1:${actualPort}`);
            console.log(`Admin Panel: http://localhost:${actualPort}/`);
            console.log(`Graphics Output: http://localhost:${actualPort}/graphics`);
            // Set port for use in main.js
            app.set('port', actualPort);
            resolve(actualPort);
        };

        server.once('error', handleError);
        server.once('listening', handleListening);
        server.listen(port, '127.0.0.1');
    });
}

if (process.env.BROADCAST_CONTROLLER_AUTOSTART !== '0') {
    startServer(DEFAULT_PORT).catch(err => {
        console.error('Failed to start server:', err);
    });
}

export {
    io,
    app,
    server,
    startServer,
    setRemoteAccessEnabled,
    getRemoteStatus,
    expireRemoteSessionForTests,
    rotatePairingCode,
    saveRemoteNetworkSelection,
    getNetworkAdapters,
    isLoopbackAddress,
    isAllowedInterface,
    getAuthToken,
    resetServerStateForTests,
    setTranslationWorkerFactoryForTests,
    setTranslationGlossaryDir,
    loadTranslationGlossary,
    saveTranslationGlossary,
    applyTranslationGlossary,
    getTranslationGlossaryPath,
    getLocalAiSettingsPath,
    loadLocalAiSettings,
    saveLocalAiSettings,
    normalizeLocalAiSettings,
    validateLocalAiSettings,
    getAtemSettingsPath,
    loadAtemSettings,
    saveAtemSettings,
    normalizeAtemSettings,
    validateAtemSettings
};
