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
// Confine remote access to the selected network. This must be the FIRST middleware — ahead of
// the body parser, every route, and the static handlers — so a device on another network gets
// no request body parsed on its behalf and cannot even fetch the JS bundle. Loopback always
// passes, which is what keeps the app's own windows working. (isAllowedInterface and
// recordBlockedRemote are function declarations defined below and hoisted; nothing can reach
// this middleware before the module has finished evaluating, since listen() comes last.)
app.use((req, res, next) => {
    if (isAllowedInterface(req.socket?.localAddress)) return next();
    recordBlockedRemote(req.socket?.remoteAddress);
    return res.status(403).send('Forbidden: remote access is limited to a different network.');
});

app.use(express.json({ limit: '1mb' }));

const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.webm', '.mkv']);
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp']);
const STREAM_EXTENSIONS = new Set([...VIDEO_EXTENSIONS, ...IMAGE_EXTENSIONS]);
// Generous enough for a full service's playlists and photo sets, bounded enough that a long
// run can't accumulate readable-path capabilities indefinitely.
const MAX_REGISTERED_LOCAL_MEDIA = 500;
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

// Compare BYTE length, not string length. `token.length` counts UTF-16 code units, so a
// 64-char multi-byte string ('é'.repeat(64)) passes a string-length check but yields a
// 128-byte buffer, and timingSafeEqual throws RangeError. That throw is fatal inside the
// io.use middleware, so this must never be reachable.
function isValidAuthToken(token) {
    if (typeof token !== 'string') return false;
    const candidate = Buffer.from(token, 'utf8');
    const expected = Buffer.from(AUTH_TOKEN, 'utf8');
    if (candidate.length !== expected.length) return false;
    return crypto.timingSafeEqual(candidate, expected);
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

// Byte-length compare for the same reason as isValidAuthToken above. Callers currently
// pre-strip non-digits, but that must not be an unwritten invariant this function relies on.
function timingSafeEqualString(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    const left = Buffer.from(a, 'utf8');
    const right = Buffer.from(b, 'utf8');
    if (!left.length || left.length !== right.length) return false;
    return crypto.timingSafeEqual(left, right);
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

// The built pages never change while the app is running, so read each one once instead of on
// every request. Also turns a missing build from a 500-with-stack into an actionable message.
const pageCache = new Map();

function readPage(fileName) {
    if (pageCache.has(fileName)) return pageCache.get(fileName);
    let html;
    try {
        html = fs.readFileSync(path.join(__dirname, 'public_react', fileName), 'utf8');
    } catch (err) {
        console.error(`Could not read ${fileName} from public_react:`, err);
        return null;
    }
    pageCache.set(fileName, html);
    return html;
}

function sendMissingBuild(res, fileName) {
    res.status(500).type('text/plain').send(
        `${fileName} is missing from public_react. Run "npm run build:frontend" and restart.`
    );
}

function sendAppHtml(res, fileName) {
    const html = readPage(fileName);
    if (html === null) return sendMissingBuild(res, fileName);
    setAuthCookies(res, { authToken: AUTH_TOKEN });
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(html.replace('</head>', `<script>window.__BC_AUTH_TOKEN__=${JSON.stringify(AUTH_TOKEN)};</script></head>`));
}

function sendRemoteHtml(res, fileName = 'index.html') {
    const html = readPage(fileName);
    if (html === null) return sendMissingBuild(res, fileName);
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

// Write to a temp file and rename over the target. rename is atomic on both platforms we ship,
// so a crash or power loss mid-write leaves the previous file intact instead of a truncated one.
// That mattered: every loader falls back to defaults on a parse failure (which is the right
// behaviour), so a torn write presented as silent config loss — including the ATEM switcher
// address, at showtime.
//
// `version` is written on every settings file so a future schema change has something to branch
// on; loaders currently accept a missing version as "v1" for files written before this.
function writeJsonAtomic(filePath, value) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmpPath = `${filePath}.${process.pid}.tmp`;
    try {
        fs.writeFileSync(tmpPath, JSON.stringify(value, null, 2), 'utf8');
        fs.renameSync(tmpPath, filePath);
    } catch (err) {
        try {
            fs.rmSync(tmpPath, { force: true });
        } catch {
            // The temp file is already gone, or unreachable; the original error is what matters.
        }
        throw err;
    }
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
        writeJsonAtomic(getRemoteNetworkPath(), { version: 1, selected: value });
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
        padUrls: reachable ? [`http://${activeAddress}:${port}/pad`] : [],
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
    evictOldestRegisteredMedia();
    return { mediaId, ...entry };
}

// Every registered path stays readable for as long as it is in the map, so the map must not
// grow without bound across a long show. Map preserves insertion order, so the oldest ids
// drop out first — the same FIFO shape presSlideBufferCache uses.
function evictOldestRegisteredMedia() {
    while (registeredLocalMedia.size > MAX_REGISTERED_LOCAL_MEDIA) {
        const oldest = registeredLocalMedia.keys().next().value;
        if (oldest === undefined) return;
        registeredLocalMedia.delete(oldest);
    }
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

// Media is served ONLY by opaque mediaId. There used to be a `?path=` fallback for local-token
// holders, which was an unrestricted arbitrary-file-read over the whole filesystem (any file
// with an allowed extension, no directory confinement). Clients register a path once via
// POST /api/local-media/register and use the id they get back.
function resolveMediaRequest(req, allowedExtensions) {
    return getRegisteredLocalMedia(req.query.mediaId, allowedExtensions);
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
    writeJsonAtomic(getLocalAiSettingsPath(), { version: 1, ...normalized });
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
    writeJsonAtomic(getAtemSettingsPath(), { version: 1, ...normalized });
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
    writeJsonAtomic(getTranslationGlossaryPath(), { version: 1, entries: sanitized });
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


// These six MUST be requireLocalAuth, not requireAuth. sendAppHtml embeds AUTH_TOKEN in the
// page and sets the bc_auth cookie, so serving any of them to a merely-paired remote hands
// that device full local privileges and defeats every onLocalSocket gate. Remotes are served
// by sendRemoteHtml, which deliberately embeds no token.
app.get('/', requireLocalAuth, (req, res) => {
    sendAppHtml(res, 'index.html');
});

app.get('/index.html', requireLocalAuth, (req, res) => {
    sendAppHtml(res, 'index.html');
});

app.get('/graphics', requireLocalAuth, (req, res) => {
    sendAppHtml(res, 'graphics.html');
});

app.get('/graphics.html', requireLocalAuth, (req, res) => {
    sendAppHtml(res, 'graphics.html');
});

app.get('/backstage', requireLocalAuth, (req, res) => {
    sendAppHtml(res, 'backstage.html');
});

app.get('/backstage.html', requireLocalAuth, (req, res) => {
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

// Tactile control pad (iPad). Single path segment for the same asset-resolution
// reason as /slides above.
app.get('/pad', (req, res) => {
    sendRemoteHtml(res, 'pad.html');
});

app.get('/remote/pad', (req, res) => res.redirect('/pad'));

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
// Every page has a route above that injects __BC_AUTH_TOKEN__ or __BC_REMOTE_ENTRY__. Anything
// with a .html extension that reaches this point is a request for the *raw* file — which would
// hand back the same app minus that injection, i.e. a subtly different build (remote.html and
// pad.html were both reachable this way). Refuse it; assets still serve normally.
app.use((req, res, next) => {
    if (req.path.toLowerCase().endsWith('.html')) {
        return res.status(404).send('Not found');
    }
    return next();
});
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

app.get('/fetch-google-sheet', requireLocalAuth, async (req, res) => {
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
app.get('/fetch-anirdesh', requireLocalAuth, (req, res) => {
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
                // text/plain, not text/html: this is third-party markup being returned on the
                // app's own origin, which is the origin that holds the local auth token. The
                // client parses it (parseAnirdeshLyrics) rather than rendering it, so nothing
                // needs it to be HTML — and serving it as HTML would make any hostile upstream
                // response reflected XSS with access to that token.
                res.set('Content-Type', 'text/plain; charset=utf-8');
                res.set('X-Content-Type-Options', 'nosniff');
                res.send(data);
            });
        }).on('error', (err) => {
            res.status(500).send('Fetch error: ' + err.message);
        });
    };
    doFetch(anirdeshUrl);
});

// Anirdesh search proxy
app.get('/search-anirdesh', requireLocalAuth, (req, res) => {
    const query = req.query.q || '';
    const what = req.query.what || 'title';
    const type = req.query.type || 'keyword';
    const beg = req.query.beg || '0';

    if (!query || query.length < 2) {
        return res.json([]);
    }

    // Every value must be encoded, not just `q` — an unencoded `what`/`type`/`beg` lets a
    // caller inject extra fields into the upstream POST body.
    const postData = new URLSearchParams({ q: query, what, type, beg }).toString();

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
app.get('/fetch-youtube-playlist', requireLocalAuth, async (req, res) => {
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

// Canva's share sheet hands out canva.link short links, and the design id they
// stand for only shows up in the redirect. A browser cannot read a cross-origin
// redirect target, and the URL the link lands on refuses framing (X-Frame-Options:
// deny) until it is rewritten to the ?embed form — so the hop has to be followed
// here, server-side, before the output window ever sees the deck URL.
const CANVA_LINK_HOSTS = ['canva.link', 'canva.com', 'canva.site'];

async function resolveCanvaShortLink(url, redirectsLeft = 5) {
    // Re-checked on every hop: a shortener that redirects off Canva must not turn
    // this into a general-purpose fetcher for the venue's LAN.
    if (!isAllowedHostname(url, CANVA_LINK_HOSTS)) {
        throw new Error('That link redirected somewhere other than Canva.');
    }
    const response = await fetch(url, {
        headers: { 'User-Agent': 'Broadcast Controller/1.0', 'Accept': 'text/html,*/*' },
        redirect: 'manual',
        signal: AbortSignal.timeout(10000)
    });
    // Only where it landed matters, never the page itself.
    response.body?.cancel?.().catch(() => {});

    if ([301, 302, 303, 307, 308].includes(response.status)) {
        if (redirectsLeft <= 0) throw new Error('That Canva link redirects too many times.');
        const location = response.headers.get('location');
        if (!location) throw new Error('That Canva link redirected without a target.');
        return resolveCanvaShortLink(new URL(location, url).toString(), redirectsLeft - 1);
    }
    return url;
}

app.get('/api/presentation/resolve-link', requireAuth, async (req, res) => {
    const rawUrl = String(req.query.url || '').trim();
    if (!isAllowedHostname(rawUrl, CANVA_LINK_HOSTS)) {
        return res.status(400).json({ error: 'Only Canva links can be resolved.' });
    }
    try {
        const url = await resolveCanvaShortLink(rawUrl);
        res.set('Cache-Control', 'no-store');
        return res.json({ url });
    } catch (err) {
        console.error('Failed to resolve Canva link:', err);
        return res.status(502).json({ error: err.message || 'Could not resolve that Canva link.' });
    }
});

// Single slide image for image/PDF decks. Lets the slides remote (and, since the
// pres_update payload split, every output window too) render slides without ever
// receiving the whole `images` array over the socket.
//
// `?v=<deckId>` opts into immutable, indefinite caching: the deck id changes
// whenever the deck itself changes (see bumpPresDeckId), so index 3 under one id
// can never mean a different picture later. A request that names a *stale* id
// (a prefetch that raced a deck swap) gets a 409 rather than the new deck's
// pixels — answering it would poison the requester's immutable cache entry for
// that URL forever. Omitting `?v=` keeps the original always-revalidate behaviour,
// so an older cached frontend bundle still works unchanged.
app.get('/api/presentation/slide/:index', requireAuth, (req, res) => {
    const images = currentPresState?.images;
    if (currentPresState?.mode !== 'images' || !Array.isArray(images)) {
        return res.status(404).send('No image deck loaded');
    }
    const index = Number.parseInt(req.params.index, 10);
    if (!Number.isInteger(index) || index < 0 || index >= images.length) {
        return res.status(404).send('Slide not found');
    }

    const requestedVersion = typeof req.query.v === 'string' ? req.query.v : '';
    if (requestedVersion && requestedVersion !== currentPresDeckId) {
        res.set('Cache-Control', 'no-store');
        return res.status(409).send('Deck changed');
    }

    // `?w=` asks for the pre-generated grid thumbnail (see PresentationPanel's
    // canvasThumbnail/imageThumbnail, generated client-side at ingest — there is
    // only one thumbnail size, this isn't an arbitrary resize service) instead of
    // the full-resolution slide. Falls back to the full slide when the deck
    // predates thumbnails or has none at this index.
    const wantsThumb = Boolean(req.query.w);
    const thumbs = currentPresState?.thumbs;
    const useThumb = wantsThumb && Array.isArray(thumbs) && Boolean(thumbs[index]);
    const sourceUrl = useThumb ? thumbs[index] : images[index];

    const cacheKey = `${currentPresDeckId}:${index}:${useThumb ? 't' : 'f'}`;
    let entry = presSlideBufferCache.get(cacheKey);
    if (!entry) {
        const match = /^data:([\w/+.-]+);base64,(.*)$/s.exec(sourceUrl || '');
        if (!match) return res.status(404).send('Slide not available');
        entry = { type: match[1], buffer: Buffer.from(match[2], 'base64') };
        presSlideBufferCache.set(cacheKey, entry);
        if (presSlideBufferCache.size > PRES_SLIDE_CACHE_MAX) {
            // Evict whichever entry was cached longest ago (Map preserves insertion
            // order) rather than tracking per-slide distance-from-current — good
            // enough given the cap only guards a runaway 100+ slide deck.
            const oldestKey = presSlideBufferCache.keys().next().value;
            presSlideBufferCache.delete(oldestKey);
        }
    }

    res.set('Content-Type', entry.type);
    res.set('ETag', `"${cacheKey}"`);
    res.set('Cache-Control', requestedVersion
        ? 'public, max-age=31536000, immutable'
        : 'no-cache');
    res.send(entry.buffer);
});


const EMPTY_PRESENTATION_STATE = {
    mode: 'none',
    baseUrl: '',
    slideId: '',
    currentIdx: 0,
    totalSlides: 0,
    images: [],
    thumbs: [],
    isCanva: false,
    showing: false
};

const PRES_MODES = new Set(['none', 'url', 'images']);
// A deck is base64 image strings held in memory and fanned out to every local window, so it
// needs a hard ceiling. 500 slides at ~4 MB each would still be far past anything real; the
// byte budget is the limit that actually matters.
// A 200-slide deck of 1080p JPEGs is roughly 40 MB once base64-encoded, so 64 MB leaves real
// headroom while still refusing the payloads that were pinning server memory.
const MAX_PRES_SLIDES = 500;
const MAX_PRES_BYTES = 64 * 1024 * 1024;

function sumStringBytes(values) {
    let total = 0;
    for (const value of values) {
        total += typeof value === 'string' ? value.length : 0;
    }
    return total;
}

// pres_update used to store whatever a client sent, verbatim and unbounded. Shape it here so a
// malformed or oversized deck is rejected at the edge instead of becoming the server's state.
// Returns { ok, state } or { ok: false, error }.
// Cue-sheet rows carry operator-defined columns, so keep the shape but bound what any one cell
// (and any one row) can cost. Generous for real cue sheets; a hard stop for anything else.
const MAX_BACKSTAGE_CELL_CHARS = 2000;
const MAX_BACKSTAGE_ROW_KEYS = 40;

const MAX_BACKSTAGE_CUSTOM_FIELDS = 40;

function sanitizeBackstageCell(value) {
    if (typeof value === 'string') return value.slice(0, MAX_BACKSTAGE_CELL_CHARS);
    if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
    return undefined;
}

function sanitizeBackstageRow(row) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return {};
    const sanitized = {};
    for (const [key, value] of Object.entries(row).slice(0, MAX_BACKSTAGE_ROW_KEYS)) {
        // customFields carries the operator's extra spreadsheet columns as
        // [{ label, value, index }], so it has to survive one level of nesting — flattening it
        // away would silently drop custom columns from the backstage monitor.
        if (Array.isArray(value)) {
            sanitized[key] = value.slice(0, MAX_BACKSTAGE_CUSTOM_FIELDS).map(entry => {
                if (!entry || typeof entry !== 'object') return sanitizeBackstageCell(entry) ?? null;
                const cleaned = {};
                for (const [entryKey, entryValue] of Object.entries(entry).slice(0, MAX_BACKSTAGE_ROW_KEYS)) {
                    const safe = sanitizeBackstageCell(entryValue);
                    if (safe !== undefined) cleaned[entryKey] = safe;
                }
                return cleaned;
            });
            continue;
        }
        const safe = sanitizeBackstageCell(value);
        if (safe !== undefined) sanitized[key] = safe;
    }
    return sanitized;
}

function getPresStateForTests() {
    return currentPresState;
}

function normalizePresState(data) {
    if (data === null || data === undefined) {
        return { ok: true, state: null };
    }
    if (typeof data !== 'object' || Array.isArray(data)) {
        return { ok: false, error: 'Presentation state must be an object.' };
    }

    const images = Array.isArray(data.images) ? data.images.filter(v => typeof v === 'string') : [];
    const thumbs = Array.isArray(data.thumbs) ? data.thumbs.filter(v => typeof v === 'string') : [];

    if (images.length > MAX_PRES_SLIDES || thumbs.length > MAX_PRES_SLIDES) {
        return { ok: false, error: `A deck cannot exceed ${MAX_PRES_SLIDES} slides.` };
    }

    const totalBytes = sumStringBytes(images) + sumStringBytes(thumbs);
    if (totalBytes > MAX_PRES_BYTES) {
        return { ok: false, error: 'This deck is too large to load. Export it at a lower resolution.' };
    }

    const totalSlides = Number(data.totalSlides);
    const currentIdx = Number(data.currentIdx);

    return {
        ok: true,
        state: {
            mode: PRES_MODES.has(data.mode) ? data.mode : 'none',
            baseUrl: typeof data.baseUrl === 'string' ? data.baseUrl : '',
            slideId: typeof data.slideId === 'string' ? data.slideId : '',
            currentIdx: Number.isFinite(currentIdx) && currentIdx >= 0 ? Math.floor(currentIdx) : 0,
            totalSlides: Number.isFinite(totalSlides) && totalSlides >= 0 ? Math.floor(totalSlides) : 0,
            images,
            thumbs,
            isCanva: Boolean(data.isCanva),
            showing: Boolean(data.showing)
        }
    };
}

// Lower thirds and lyrics are independent layers that can be on air at the same time, so each
// owns its own auto-clear timer. A single shared timer meant showing either graphic silently
// cancelled the other's pending clear, and hiding either one disarmed whichever timer happened
// to be pending — so a name super with a 10s auto-clear would sit on screen for the rest of the
// show as soon as a verse went up.
//
// These live at module scope, alongside the rest of the authoritative show state. They used to
// be per-socket closures, which produced two bugs: a hide from a tablet could not cancel a timer
// started from the desktop (so the graphic came back down later anyway), and a pending timer
// outlived the browser that set it with nothing able to cancel it. Note they are deliberately
// NOT cleared on disconnect: "clear this graphic in 10 seconds" is a property of the show, not
// of whichever browser happened to request it.
let lowerThirdAutoClearTimer = null;
let lyricsAutoClearTimer = null;

function clearLowerThirdAutoClear() {
    if (lowerThirdAutoClearTimer) {
        clearTimeout(lowerThirdAutoClearTimer);
        lowerThirdAutoClearTimer = null;
    }
}

function clearLyricsAutoClear() {
    if (lyricsAutoClearTimer) {
        clearTimeout(lyricsAutoClearTimer);
        lyricsAutoClearTimer = null;
    }
}

// Auto-clear must take down only the layer whose timer fired. The global `stop_graphic` used
// previously is what every layer listens to, so a lower third expiring also wiped the lyrics,
// the sabha timer and the particles.
function hideLowerThirdNow() {
    clearLowerThirdAutoClear();
    currentLowerThirdState = null;
    io.emit('stop_lower_third');
    emitOperatorState();
}

function hideLyricsNow() {
    clearLyricsAutoClear();
    currentLyricsState = null;
    io.emit('stop_lyrics');
    emitOperatorState();
}

// Returns a timer handle when the payload carries a positive autoClear, otherwise null.
// Callers disarm their own timer first and assign the result, so nothing is left pending.
function armAutoClear(autoClear, onExpire, label) {
    const seconds = Number(autoClear);
    if (!autoClear || Number.isNaN(seconds) || seconds <= 0) return null;
    return setTimeout(() => {
        console.log(`Auto clearing ${label} after ${seconds}s`);
        onExpire();
    }, seconds * 1000);
}

let currentPresState = null;
// Identifies the currently loaded deck so slide image URLs can be cached
// immutably (see the /api/presentation/slide/:index handler below). Bumped
// whenever the deck itself changes, never on navigation or show/hide. Prefixed
// with a per-process random value (not just a counter) so a phone holding a
// year-long `immutable` cache entry for an old id can never collide with a
// deck loaded after a server restart, when the counter would otherwise reset.
const PRES_DECK_ID_PREFIX = crypto.randomBytes(4).toString('hex');
let presDeckSeq = 0;
let currentPresDeckId = '';
// Decoded slide bytes, keyed by `${deckId}:${index}:${full-or-thumb}`. Every
// output window (graphics/stage/NDI/control preview) plus every paired remote
// hits the same slide URLs, so decoding each base64 slide once here avoids
// repeating that work per request. Capped and pruned on each request so a large
// deck can't pin unbounded memory. Sized for ~15 slides' worth of full+thumb
// pairs, since the grid and the live/prev/next tiles cache separately now.
const presSlideBufferCache = new Map();
const PRES_SLIDE_CACHE_MAX = 60;

function bumpPresDeckId() {
    presDeckSeq += 1;
    currentPresDeckId = `${PRES_DECK_ID_PREFIX}${presDeckSeq}`;
    presSlideBufferCache.clear();
    // Stamp it onto the state object too, not just the module-level variable —
    // the 'local' room's pres_update carries currentPresState as-is (see
    // broadcastPresState), so without this, local windows (desktop panel,
    // graphics, stage, NDI) would never actually see a deckId even though
    // getPresMeta()/getPresStateLite() report one correctly for remotes.
    if (currentPresState) currentPresState = { ...currentPresState, deckId: currentPresDeckId };
    return currentPresDeckId;
}
let currentPresLibrary = [];
// Control Pad (/pad): the desktop owns both of these and publishes them; the server
// only caches them so a tablet that connects later has something to render.
let currentPadLayout = null;
let currentPadRundown = [];
let currentStagePresToggle = false;
let currentStageTimerState = null;
let currentStageMessage = null;
let currentStageNegFlash = true;
let currentStageNegWhite = false;
let currentMediaData = null;
let currentPhotoData = null;
// Default show state, defined ONCE and used both to seed the live values below and to reset
// them in resetServerStateForTests. Those two used to be separate verbatim copies of the same
// literals (the sabha style block appeared twice, 12 lines each), so any new field had to be
// added in both places or tests would silently leak state between cases.
const DEFAULT_PARTICLES_STATE = Object.freeze({ enabled: false, type: 'dust', intensity: 50, speed: 50 });
const DEFAULT_OUTPUT_MODE = Object.freeze({ backgroundMode: 'green', fitMode: 'fit' });
const DEFAULT_LAYER_VISIBILITY = Object.freeze({
    presentation: true,
    media: true,
    lowerThirds: true,
    lyrics: true,
    translation: true,
    sabhaTimer: true,
    particles: true,
    mediaMessage: true
});

function createDefaultSabhaState() {
    return {
        showing: false,
        overlayMedia: false,
        timeStr: '16:00',
        message: 'Sabha Starts In',
        style: {
            msg: { fontFamily: "'Outfit', sans-serif", fontWeight: '700', fontSize: '36', letterSpacing: '5', color: '#ffffff' },
            timer: { fontFamily: "'Outfit', sans-serif", fontWeight: '700', fontSize: '130', letterSpacing: '0', color: '#ffffff' }
        }
    };
}

function createDefaultTranslationStatus() {
    return { state: 'idle', error: null, engine: 'azure', updatedAt: Date.now() };
}

function createDefaultBackstageState() {
    return {
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
}

let currentParticlesState = { ...DEFAULT_PARTICLES_STATE };
let currentMediaMessageOverlay = { ...DEFAULT_MEDIA_MESSAGE_OVERLAY };
let currentMediaPlaying = false;
let currentMediaLoop = false;
let currentMediaAutoNext = false;
let currentMediaMuted = false;
let currentOutputMode = { ...DEFAULT_OUTPUT_MODE };
let currentLayerVisibility = { ...DEFAULT_LAYER_VISIBILITY };
let currentLowerThirdState = null;
let currentLyricsState = null;
let currentSabhaState = createDefaultSabhaState();
let currentTranslationState = null;
let lastTranslationStyle = {};
let lastTranslationLayout = {};
let currentTranslationStatus = createDefaultTranslationStatus();
let currentBackstageState = createDefaultBackstageState();
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

// --- Control Pad (/pad) -----------------------------------------------------
// The pad layout and rundown are authored on the desktop. The server never
// interprets them — it clamps the structure so a malformed or oversized publish
// can't be cached or fanned out, and leaves the meaning to padModel.js.

const PAD_COMMAND_TYPES = new Set(['cue_fire', 'cue_status', 'translation_start']);
const PAD_CUE_STATUSES = new Set(['pending', 'armed', 'fired', 'skipped', 'done']);
const PAD_COL_CHOICES = [4, 5, 6];
const MAX_PAD_PAGES = 6;
const MAX_PAD_BUTTONS = 48;
const MAX_PAD_CUES = 200;

function padString(value, max, fallback = '') {
    return typeof value === 'string' ? value.slice(0, max) : fallback;
}

function normalizePadLayout(data = {}) {
    const pages = Array.isArray(data?.pages) ? data.pages : [];
    return {
        version: 1,
        updatedAt: Date.now(),
        pages: pages.slice(0, MAX_PAD_PAGES).map((page, i) => {
            const source = page && typeof page === 'object' ? page : {};
            const buttons = Array.isArray(source.buttons) ? source.buttons : [];
            return {
                id: padString(source.id, 64) || `page-${i}`,
                name: padString(source.name, 24) || `Page ${i + 1}`,
                cols: PAD_COL_CHOICES.includes(Number(source.cols)) ? Number(source.cols) : 5,
                buttons: buttons.slice(0, MAX_PAD_BUTTONS).map((button, j) => {
                    const b = button && typeof button === 'object' ? button : {};
                    const action = b.action && typeof b.action === 'object' ? b.action : {};
                    return {
                        id: padString(b.id, 64) || `btn-${i}-${j}`,
                        label: padString(b.label, 20),
                        sub: padString(b.sub, 20),
                        icon: padString(b.icon, 32, 'none'),
                        color: padString(b.color, 16, 'slate'),
                        wide: Boolean(b.wide),
                        hold: Boolean(b.hold),
                        action: {
                            kind: ['emit', 'command', 'none'].includes(action.kind) ? action.kind : 'none',
                            id: padString(action.id, 48),
                            payload: action.payload && typeof action.payload === 'object' && !Array.isArray(action.payload)
                                ? action.payload
                                : {}
                        }
                    };
                })
            };
        })
    };
}

// Display-only. Cue action payloads are deliberately never mirrored here: they
// carry local file paths and lyric text, and the pad has no use for them.
function normalizePadRundown(list) {
    return (Array.isArray(list) ? list : []).slice(0, MAX_PAD_CUES).map((cue = {}) => {
        const source = cue && typeof cue === 'object' ? cue : {};
        return {
            id: padString(source.id, 64),
            title: padString(source.title, 80) || 'Cue',
            status: PAD_CUE_STATUSES.has(source.status) ? source.status : 'pending',
            types: (Array.isArray(source.types) ? source.types : [])
                .slice(0, 6)
                .map(type => padString(String(type), 24))
        };
    }).filter(cue => cue.id);
}

function countLocalSockets() {
    let count = 0;
    for (const client of io.sockets.sockets.values()) {
        if (isLocalSocket(client)) count += 1;
    }
    return count;
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

// Broadcasting to everyone is coalesced onto a short trailing edge. There are ~30 call sites,
// and most state mutations already io.emit the specific change too, so an un-debounced version
// meant two full-state broadcasts per event — to every window and every paired phone. 60 ms is
// below the threshold where an operator would notice a control-surface lag, and it collapses
// bursts (a deck load, a clear-all) into one send.
//
// Targeted sends — emitOperatorState(socket) on connect — stay immediate: a client that just
// connected needs its snapshot now, and there is no burst to collapse.
const OPERATOR_STATE_DEBOUNCE_MS = 60;
let operatorStateTimer = null;

function emitOperatorState(target = null) {
    if (target) {
        target.emit('operator_state_update', getOperatorState());
        return;
    }
    if (operatorStateTimer) return;
    operatorStateTimer = setTimeout(() => {
        operatorStateTimer = null;
        io.emit('operator_state_update', getOperatorState());
    }, OPERATOR_STATE_DEBOUNCE_MS);
    operatorStateTimer.unref?.();
}

function flushOperatorState() {
    if (!operatorStateTimer) return;
    clearTimeout(operatorStateTimer);
    operatorStateTimer = null;
    io.emit('operator_state_update', getOperatorState());
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
        showing: Boolean(state.showing),
        deckId: currentPresDeckId
    };
}

function emitPresMeta(target = io) {
    target.emit('pres_meta', getPresMeta());
}

// Full presentation state, but with `images` stripped. Sent to the 'remote' room
// (phones/tablets) in place of `currentPresState`. Kept as `images: []` rather than
// omitted so `{...EMPTY_PRESENTATION, ...state}` spreads on the client behave the
// same as they do for the full state. `/remote` (the full desktop app served over
// pairing) relies on the other fields here for its preview strip and status text;
// its own image previews come from the HTTP slide endpoint (see getPresImageUrl-style
// usage in PresentationPanel), not from this payload.
function getPresStateLite() {
    const base = currentPresState || EMPTY_PRESENTATION_STATE;
    // Thumbnails are far smaller than full slides, but they're still base64
    // images-shaped data a remote never needs inline — it fetches them (full or
    // thumbnail) over the cacheable HTTP endpoint via deckId instead.
    return { ...base, images: [], thumbs: [], deckId: currentPresDeckId };
}

// Broadcasts the current presentation state after a genuine change (new deck,
// navigation, or show/hide). Local sockets (desktop, graphics, stage, NDI) get the
// full state including `images`; remote sockets (phones/tablets paired over /remote
// or /slides) get the lite version. Splitting here — rather than only stripping
// images from the slides remote's own listener — is what keeps socket.io from
// spending the phone's bandwidth and head-of-line ordering on megabytes of base64
// it was always going to ignore.
function broadcastPresState() {
    io.to('local').emit('pres_update', currentPresState);
    io.to('remote').emit('pres_update', getPresStateLite());
    emitPresMeta();
    emitOperatorState();
    notifyPresentationLive();
}

// main.js uses this to hold the system-wide clicker shortcuts only while a deck is actually on
// screen. Every path that shows, hides, loads or clears a deck goes through broadcastPresState,
// so this is the one place that needs to report.
let presentationLiveListener = null;
let lastPresentationLive = false;

function isPresentationLive() {
    return Boolean(currentPresState && currentPresState.mode !== 'none' && currentPresState.showing);
}

function notifyPresentationLive() {
    const live = isPresentationLive();
    if (live === lastPresentationLive) return;
    lastPresentationLive = live;
    try {
        presentationLiveListener?.(live);
    } catch (err) {
        console.error('Presentation-live listener failed:', err);
    }
}

function setPresentationLiveListener(listener) {
    presentationLiveListener = typeof listener === 'function' ? listener : null;
}

function sendPresStateTo(socket) {
    if (!currentPresState) return;
    socket.emit('pres_update', isLocalSocket(socket) ? currentPresState : getPresStateLite());
}

// Canva is the one deck type with no index to be authoritative about: its embed
// exposes no per-slide URL and the iframe is cross-origin, so the app can neither
// read nor set which slide is up. Navigation is therefore not a state change but a
// keystroke posted into the embed on each output window — this relay carries that
// intent and deliberately leaves currentPresState alone. Only local windows
// (graphics, stage, NDI) can act on it; a phone has no embed to type into, so
// remotes send this but never receive it.
function relayCanvaNav(direction) {
    if (direction !== 'next' && direction !== 'prev') return;
    if (!currentPresState?.isCanva || !currentPresState.showing) return;
    io.to('local').emit('pres_canva_nav', direction);
}

// Server-authoritative navigation, shared by pres_goto (remotes/desktop moving the
// deck via absolute index) and pres_nav (the graphics window's own keyboard
// shortcuts, previously a blind client-side relay). Routing both through one
// function means there is exactly one place that computes the next index and
// exactly one broadcast per navigation.
function applyPresGoto(payload, originSocket) {
    if (!currentPresState || currentPresState.mode === 'none') return;
    const total = currentPresState.totalSlides || 0;
    if (total <= 0) return;

    // A Canva deck has no index to be authoritative about (see the pres_canva_nav
    // handler), so a next/prev arriving here — the clicker and the graphics window's
    // own keys both land on pres_nav — is turned into a keystroke for the embed
    // rather than a slide index that would clamp to a no-op.
    if (currentPresState.isCanva) {
        const step = payload?.direction;
        if (step === 'next' || step === 'prev') relayCanvaNav(step);
        return;
    }

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
    if (next === current) {
        // Clamped no-op: re-assert truth to the caller so a drifted remote
        // un-freezes instead of sitting on a dead button with no response.
        if (originSocket) originSocket.emit('pres_meta', getPresMeta());
        return;
    }

    currentPresState = { ...currentPresState, currentIdx: next };
    broadcastPresState();
}

// Supplied by main.js so the API key never has to travel from the renderer. Falls back to
// whatever the caller passed, which keeps the test suite (and any non-Electron run) working.
let translationSecretResolver = null;

function setTranslationSecretResolver(resolver) {
    translationSecretResolver = typeof resolver === 'function' ? resolver : null;
}

function resolveTranslationKey(engine, providedKey) {
    if (providedKey) return providedKey;
    if (!translationSecretResolver) return '';
    try {
        return translationSecretResolver(engine) || '';
    } catch (err) {
        console.error('Failed to resolve stored translation key:', err);
        return '';
    }
}

function validateTranslationConfig(config) {
    const engine = TRANSLATION_ENGINES.has(config?.engine) ? config.engine : 'azure';
    const providedKey = typeof config?.key === 'string' ? config.key.trim() : '';
    const key = engine === 'local' ? '' : resolveTranslationKey(engine, providedKey);
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
    lastPresentationLive = false;
    clearLowerThirdAutoClear();
    clearLyricsAutoClear();
    // A pending debounced broadcast would otherwise fire against the next test's state.
    if (operatorStateTimer) {
        clearTimeout(operatorStateTimer);
        operatorStateTimer = null;
    }
    remoteNetworkSelection = null;
    lastBlockedRemote = null;
    lastBlockedEmitAt = 0;
    previousPairingCode = '';
    previousPairingCodeExpiresAt = 0;
    currentPresState = null;
    currentPresDeckId = '';
    presDeckSeq = 0;
    presSlideBufferCache.clear();
    currentPresLibrary = [];
    currentPadLayout = null;
    currentPadRundown = [];
    currentStagePresToggle = false;
    currentStageTimerState = null;
    currentStageMessage = null;
    currentStageNegFlash = true;
    currentStageNegWhite = false;
    currentMediaData = null;
    currentPhotoData = null;
    currentParticlesState = { ...DEFAULT_PARTICLES_STATE };
    currentMediaMessageOverlay = { ...DEFAULT_MEDIA_MESSAGE_OVERLAY };
    currentMediaPlaying = false;
    currentMediaLoop = false;
    currentMediaAutoNext = false;
    currentMediaMuted = false;
    currentOutputMode = { ...DEFAULT_OUTPUT_MODE };
    currentLayerVisibility = { ...DEFAULT_LAYER_VISIBILITY };
    atemSettingsCache = null;
    currentLowerThirdState = null;
    currentLyricsState = null;
    currentSabhaState = createDefaultSabhaState();
    currentTranslationState = null;
    lastTranslationStyle = {};
    lastTranslationLayout = {};
    currentTranslationStatus = createDefaultTranslationStatus();
    currentBackstageState = createDefaultBackstageState();
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

function sendSocketResult(ack, result) {
    if (typeof ack === 'function') {
        ack(result);
    }
}

function sendLocalAiSettings(socket) {
    socket.emit('local_ai_settings_update', loadLocalAiSettings());
}

// socket.io's middleware runner has no try/catch of its own: a throw here escapes as an
// uncaught exception and kills the Electron main process mid-show. Every handshake is
// attacker-influenced, so the whole body is wrapped and any throw becomes a rejected
// connection instead of dead air.
io.use((socket, next) => {
    try {
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
    } catch (err) {
        console.error('Socket handshake check failed:', err);
        return next(new Error('Unauthorized'));
    }
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
    // Local (desktop/graphics/stage/NDI) vs remote (phone/tablet) determines whether
    // this socket receives full presentation state (with images) or the lite version.
    socket.join(isLocalSocket(socket) ? 'local' : 'remote');
    if (socket.data.remoteSession) {
        socket.data.remoteSession.connected = true;
        emitRemoteAccessStatus();
    }

    // Send cached state to the new client
    sendPresStateTo(socket);
    emitPresMeta(socket);
    if (currentPresLibrary.length) socket.emit('pres_library_update', currentPresLibrary);
    if (currentPadLayout) socket.emit('pad_layout_update', currentPadLayout);
    if (currentPadRundown.length) socket.emit('pad_rundown_update', currentPadRundown);
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
        // Must go through rotatePairingCode, not assign directly. A direct assignment leaves
        // previousPairingCode intact, so a code graced by an earlier *timed* rotation stays
        // usable after a manual rotate — exactly what manual rotation exists to prevent. It
        // also skipped remotePairingCodeIssuedAt, which made the operator's countdown wrong.
        rotatePairingCode({ grace: false });
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

    socket.on('show_lower_third', (data) => {
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
        clearLowerThirdAutoClear();
        lowerThirdAutoClearTimer = armAutoClear(data.autoClear, hideLowerThirdNow, 'lower third');
    });

    socket.on('show_lyrics', (data) => {
        console.log('Showing lyrics:', data);
        currentLyricsState = {
            engText: data?.engText || '',
            gujText: data?.gujText || '',
            langOpt: data?.langOpt || 'both',
            autoClear: data?.autoClear || 0
        };
        io.emit('play_lyrics', data);
        emitOperatorState();

        clearLyricsAutoClear();
        lyricsAutoClearTimer = armAutoClear(data.autoClear, hideLyricsNow, 'lyrics');
    });

    socket.on('clear_all', () => {
        console.log('Global Clear Triggered');
        clearLowerThirdAutoClear();
        clearLyricsAutoClear();
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
        currentPresDeckId = '';
        currentTranslationState = null;
        currentSabhaState = { ...currentSabhaState, showing: false };
        currentLowerThirdState = null;
        currentLyricsState = null;
        cleanupWorker({ emitStatus: true, status: 'idle' });
        io.emit('media_stop');
        io.emit('photo_stop');
        io.emit('media_message_overlay_update', currentMediaMessageOverlay);
        broadcastPresState();
        io.emit('stop_sabha');
        io.emit('hide_translation');
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
            // A restore is a deck change as far as caching is concerned: the
            // restored `images` array may not match whatever the retired deck id's
            // cached slide buffers held, so it needs a fresh id, not the old one.
            bumpPresDeckId();
            broadcastPresState();
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

    socket.on('hide_lower_third', hideLowerThirdNow);

    socket.on('hide_lyrics', hideLyricsNow);

    // Style Updates
    socket.on('update_lt_style', (style) => io.emit('update_lt_style', style));
    socket.on('update_lt_design', (design) => io.emit('update_lt_design', design));
    socket.on('update_lyrics_style', (style) => io.emit('update_lyrics_style', style));
    socket.on('update_lyrics_layout', (layout) => io.emit('update_lyrics_layout', layout));

    socket.on('output_mode_update', (data) => {
        // The client emits one field at a time (background-mode buttons and the Fill
        // Display toggle are independent controls, see App.jsx), so an update must
        // preserve whichever field it doesn't name rather than resetting it to a
        // hardcoded default -- otherwise, e.g., toggling the key colour would silently
        // flip Fill Display back to Fit every time.
        const allowedModes = new Set(['green', 'black', 'transparent']);
        const allowedFitModes = new Set(['fit', 'fill']);
        const backgroundMode = allowedModes.has(data?.backgroundMode)
            ? data.backgroundMode
            : (currentOutputMode.backgroundMode || 'green');
        const fitMode = allowedFitModes.has(data?.fitMode)
            ? data.fitMode
            : (currentOutputMode.fitMode || 'fit');
        currentOutputMode = { backgroundMode, fitMode };
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
        sendPresStateTo(socket);
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
        // Row *count* was capped but row *content* was not, so 500 rows of arbitrary strings
        // could still be arbitrarily large. Cue-sheet rows have operator-defined columns, so
        // bound each cell rather than pinning the shape.
        const rows = Array.isArray(state.rows) ? state.rows.slice(0, 500).map(sanitizeBackstageRow) : [];
        currentBackstageState = {
            title: typeof state.title === 'string' ? state.title.slice(0, 160) : 'Backstage Monitor',
            rows,
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

    // The deck payload used to be stored verbatim, unbounded and ungated: a remote could pin
    // up to maxHttpBufferSize of server memory and force a fan-out of it to every local window.
    // Now it is shape-checked and size-capped for everyone, and inline slide images are
    // local-only — the slides remote legitimately loads Google Slides/Canva decks, which are
    // URL-based and carry no image data, so it keeps working.
    socket.on('pres_update', (data, ack) => {
        const result = normalizePresState(data);
        if (!result.ok) {
            console.warn('Rejected pres_update:', result.error);
            sendSocketResult(ack, result);
            socket.emit('pres_update_rejected', { error: result.error });
            return;
        }

        const carriesImages = Boolean(result.state?.images?.length || result.state?.thumbs?.length);
        if (carriesImages && !isLocalSocket(socket)) {
            const error = 'Image decks can only be loaded from the main controller.';
            sendSocketResult(ack, { ok: false, error });
            socket.emit('pres_update_rejected', { error });
            return;
        }

        currentPresState = result.state;
        bumpPresDeckId();
        broadcastPresState();
        sendSocketResult(ack, { ok: true });
    });

    // The graphics window's own keyboard shortcuts (ArrowRight/Left/Home/End) used
    // to be a blind io.emit relay, trusting the desktop panel to compute the next
    // index. Now it goes through the same authoritative path as every other client.
    socket.on('pres_nav', (data) => applyPresGoto({ direction: data }, socket));

    // Server-authoritative navigation. Lets lightweight clients (the slides
    // remote) move the deck without echoing the whole state object back.
    socket.on('pres_goto', (payload) => applyPresGoto(payload, socket));

    // Canva paging from the desktop panel and the slides remote (see relayCanvaNav).
    socket.on('pres_canva_nav', (direction) => relayCanvaNav(direction));

    socket.on('pres_set_showing', (showing) => {
        if (!currentPresState || currentPresState.mode === 'none') return;
        currentPresState = { ...currentPresState, showing: Boolean(showing) };
        broadcastPresState();
    });

    // Self-healing resync: lets a client that suspects its cached presentation state has
    // drifted (e.g. a nested-iframe socket that connected fine but somehow missed a later
    // pres_update — the Live Preview's presentation layer watches for exactly this) pull a
    // fresh copy directly, rather than waiting on a future broadcast that might have the
    // same delivery problem. Replies straight to the requesting socket instead of a room
    // broadcast, so it recovers even from a socket that's silently fallen out of its room.
    socket.on('request_pres_state', () => sendPresStateTo(socket));

    // The desktop panel owns the saved-deck library; cache it so remotes can list it.
    socket.on('pres_library_update', (library) => {
        currentPresLibrary = Array.isArray(library) ? library : [];
        socket.broadcast.emit('pres_library_update', currentPresLibrary);
    });

    // --- Control Pad (/pad) -------------------------------------------------
    // Both publishes are local-only. The /remote full controller mounts the same
    // panels against its *own* localStorage, so without this gate a paired laptop
    // would overwrite the pad layout and rundown the tablets are working from.
    onLocalSocket(socket, 'pad_layout_update', (layout, ack) => {
        currentPadLayout = normalizePadLayout(layout);
        io.emit('pad_layout_update', currentPadLayout);
        sendSocketResult(ack, { ok: true });
    });

    onLocalSocket(socket, 'pad_rundown_update', (cues, ack) => {
        currentPadRundown = normalizePadRundown(cues);
        // Fanned out to everyone, unlike pres_library_update: the desktop's own
        // post-fire status change is exactly what the pad needs to see.
        io.emit('pad_rundown_update', currentPadRundown);
        sendSocketResult(ack, { ok: true });
    });

    // Relay for the few things a tablet cannot do itself. Firing a cue has to run
    // on the desktop: only it can reach the blackout handler, the renderer's
    // microphone, and local media paths (normalizeLocalMediaPayload rejects an
    // unregistered path from a remote socket).
    socket.on('pad_command', (payload, ack) => {
        const type = typeof payload?.type === 'string' ? payload.type : '';
        if (!PAD_COMMAND_TYPES.has(type)) {
            sendSocketResult(ack, { ok: false, error: 'Unknown pad command.' });
            return;
        }

        const body = payload?.payload && typeof payload.payload === 'object' ? payload.payload : {};
        const cueId = padString(body.cueId, 64);

        if (type === 'cue_status' && !PAD_CUE_STATUSES.has(body.status)) {
            sendSocketResult(ack, { ok: false, error: 'Unknown cue status.' });
            return;
        }
        // An empty cueId means "fire the next pending cue", which the desktop
        // resolves. A named cue that is no longer in the rundown is a stale pad.
        if (cueId && currentPadRundown.length && !currentPadRundown.some(cue => cue.id === cueId)) {
            sendSocketResult(ack, { ok: false, error: 'That cue no longer exists.' });
            return;
        }

        const delivered = countLocalSockets();
        if (!delivered) {
            sendSocketResult(ack, { ok: false, error: 'The main controller is not connected.' });
            return;
        }

        const relayed = { type, payload: { ...body, cueId } };
        for (const client of io.sockets.sockets.values()) {
            if (isLocalSocket(client)) client.emit('pad_command', relayed);
        }
        sendSocketResult(ack, { ok: true, delivered });
    });

    socket.on('start_translation', (config) => {
        // Local-only for every engine, not just 'local'. The azure/soniox payloads carry the
        // operator's paid API key, and when Remote Operators is on that key would otherwise
        // cross the venue LAN in cleartext.
        if (!requireLocalSocket(socket)) return;
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
            // Spawn Electron's own bundled runtime as a plain Node process, not a system
            // "node" binary: a packaged install has no guarantee node is on PATH at all, and
            // even when it is, an unrelated system node can't read *.js out of this app's
            // asar archive — only Electron's own asar-aware runtime can. ELECTRON_RUN_AS_NODE
            // makes process.execPath behave like `node`, skipping Chromium/GUI init.
            translationWorker = spawnTranslationWorker(process.execPath, [workerPath], {
                stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
                env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
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
                    // Deliberately no emitOperatorState() here. This fires for every interim
                    // ASR token — several times a second during live captioning — and the
                    // dedicated translation_update event above already carries what changed.
                    io.emit('translation_update', currentTranslationState);
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
        sendSocketResult(ack, { ok: true, entries });
    });

    socket.on('translation_glossary_add', (entry, ack) => {
        const normalized = normalizeGlossaryEntry(entry);
        if (!isUsableGlossaryEntry(normalized)) {
            sendSocketResult(ack, { ok: false, error: 'Enter at least two matching language phrases.' });
            return;
        }

        try {
            const entries = saveTranslationGlossary([...loadTranslationGlossary(), normalized]);
            emitTranslationGlossaryUpdate();
            sendSocketResult(ack, { ok: true, entry: normalized, entries });
        } catch (err) {
            sendSocketResult(ack, { ok: false, error: err.message || 'Failed to save glossary entry.' });
        }
    });

    socket.on('translation_glossary_update_entry', (entry, ack) => {
        const entries = loadTranslationGlossary();
        const index = entries.findIndex(item => item.id === entry?.id);
        if (index === -1) {
            sendSocketResult(ack, { ok: false, error: 'Glossary entry was not found.' });
            return;
        }

        const normalized = normalizeGlossaryEntry(entry, entries[index]);
        if (!isUsableGlossaryEntry(normalized)) {
            sendSocketResult(ack, { ok: false, error: 'Enter at least two matching language phrases.' });
            return;
        }

        try {
            const nextEntries = [...entries];
            nextEntries[index] = normalized;
            const saved = saveTranslationGlossary(nextEntries);
            emitTranslationGlossaryUpdate();
            sendSocketResult(ack, { ok: true, entry: normalized, entries: saved });
        } catch (err) {
            sendSocketResult(ack, { ok: false, error: err.message || 'Failed to update glossary entry.' });
        }
    });

    socket.on('translation_glossary_delete', (id, ack) => {
        const entries = loadTranslationGlossary();
        const nextEntries = entries.filter(entry => entry.id !== id);
        if (nextEntries.length === entries.length) {
            sendSocketResult(ack, { ok: false, error: 'Glossary entry was not found.' });
            return;
        }

        try {
            const saved = saveTranslationGlossary(nextEntries);
            emitTranslationGlossaryUpdate();
            sendSocketResult(ack, { ok: true, entries: saved });
        } catch (err) {
            sendSocketResult(ack, { ok: false, error: err.message || 'Failed to delete glossary entry.' });
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

    // Reported by ErrorBoundary when a renderer subtree fails. Logged here because a failure on
    // the graphics output is otherwise invisible: that window has no visible error state (it is
    // on air) and usually has no devtools open during a service.
    socket.on('client_error', (report = {}) => {
        const label = typeof report.label === 'string' ? report.label.slice(0, 80) : 'unknown';
        const message = typeof report.message === 'string' ? report.message.slice(0, 500) : '';
        console.error(`[client:${label}] ${message}`);
    });

    socket.on('disconnect', () => {
        console.log('Client disconnected');
    });
});

// Registered after every route, so these are the last things Express tries. Without them an
// unknown path fell through to Express's default HTML 404 and a throw inside any handler
// produced a 500 carrying a stack trace.
app.use((req, res) => {
    res.status(404).type('text/plain').send('Not found');
});

// Four args: Express identifies error middleware by arity, so `next` must stay even though it
// is unused.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
    console.error(`Unhandled error on ${req.method} ${req.path}:`, err);
    if (res.headersSent) return;
    res.status(500).type('text/plain').send('Something went wrong handling that request.');
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
    getPresStateForTests,
    normalizePresState,
    setTranslationWorkerFactoryForTests,
    setTranslationSecretResolver,
    setPresentationLiveListener,
    isLocalSocket,
    onLocalSocket,
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
