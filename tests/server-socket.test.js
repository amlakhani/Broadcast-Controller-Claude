import assert from 'node:assert/strict';
import { after, afterEach, before, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { io as createClient } from '../frontend/node_modules/socket.io-client/build/esm/index.js';
import { PAD_EMIT_ACTIONS } from '../frontend/src/components/padModel.js';

process.env.BROADCAST_CONTROLLER_AUTOSTART = '0';

let serverModule;
let baseUrl;
let testDataDir;
const openSockets = [];

class FakeWorker {
    constructor() {
        this.connected = true;
        this.killed = false;
        this.sent = [];
        this.handlers = new Map();
    }

    send(message) {
        this.sent.push(message);
    }

    on(event, handler) {
        this.handlers.set(event, handler);
        return this;
    }

    kill() {
        this.killed = true;
        this.connected = false;
    }

    emitWorker(event, message) {
        this.handlers.get(event)?.(message);
    }
}

function waitFor(socket, event, { timeout = 1000, predicate } = {}) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            socket.off(event, handler);
            reject(new Error(`Timed out waiting for ${event}`));
        }, timeout);

        const handler = (...args) => {
            if (predicate && !predicate(...args)) return;
            clearTimeout(timer);
            socket.off(event, handler);
            resolve(args.length > 1 ? args : args[0]);
        };

        socket.on(event, handler);
    });
}

function waitUntil(predicate, { timeout = 1000, interval = 5, message = 'Condition was not met' } = {}) {
    return new Promise((resolve, reject) => {
        const startedAt = Date.now();
        const check = () => {
            if (predicate()) {
                resolve();
                return;
            }
            if (Date.now() - startedAt > timeout) {
                reject(new Error(message));
                return;
            }
            setTimeout(check, interval);
        };
        check();
    });
}

async function connectClient() {
    const socket = createClient(baseUrl, {
        autoConnect: false,
        forceNew: true,
        reconnection: false,
        transports: ['websocket'],
        auth: { token: serverModule.getAuthToken() }
    });
    openSockets.push(socket);
    const connected = waitFor(socket, 'connect');
    socket.connect();
    await connected;
    return socket;
}

async function connectClientWithReplay(events) {
    const socket = createClient(baseUrl, {
        autoConnect: false,
        forceNew: true,
        reconnection: false,
        transports: ['websocket'],
        auth: { token: serverModule.getAuthToken() }
    });
    openSockets.push(socket);
    const waits = Object.fromEntries(events.map(event => [event, waitFor(socket, event)]));
    const connected = waitFor(socket, 'connect');
    socket.connect();
    await connected;
    return { socket, waits };
}

async function pairRemote({ code, deviceName = 'Remote Test' } = {}) {
    const response = await fetchWithRetry(`${baseUrl}/api/remote/pair`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, deviceName })
    });
    const body = await response.json().catch(() => ({}));
    return { response, body };
}

async function connectRemote(remoteToken) {
    const socket = createClient(baseUrl, {
        autoConnect: false,
        forceNew: true,
        reconnection: false,
        transports: ['websocket'],
        auth: { remoteToken }
    });
    openSockets.push(socket);
    const connected = waitFor(socket, 'connect');
    socket.connect();
    await connected;
    return socket;
}

async function closeServer() {
    if (!serverModule) return;
    await new Promise(resolve => serverModule.io.close(resolve));
}

function emitWithAck(socket, event, payload) {
    return new Promise(resolve => {
        socket.emit(event, payload, resolve);
    });
}

async function fetchWithRetry(url, options, attempts = 2) {
    let lastError;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
        try {
            return await fetch(url, options);
        } catch (err) {
            lastError = err;
            await new Promise(resolve => setTimeout(resolve, 25));
        }
    }
    throw lastError;
}

before(async () => {
    serverModule = await import('../server.js');
    testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'broadcast-controller-test-'));
    serverModule.setTranslationGlossaryDir(testDataDir);
    serverModule.saveTranslationGlossary([]);
    const port = await serverModule.startServer(0);
    baseUrl = `http://127.0.0.1:${port}`;
});

afterEach(async () => {
    for (const socket of openSockets.splice(0)) {
        socket.disconnect();
    }
    await serverModule.setRemoteAccessEnabled(false);
    serverModule.setTranslationWorkerFactoryForTests(null);
    serverModule.saveRemoteNetworkSelection('auto');
    serverModule.resetServerStateForTests();
    serverModule.saveTranslationGlossary([]);
    serverModule.saveLocalAiSettings({
        ollamaBaseUrl: 'http://localhost:11434',
        ollamaModel: '',
        whisperExecutablePath: '',
        whisperModelPath: '',
        chunkSeconds: 5
    });
    serverModule.saveAtemSettings({ address: '', port: 9910, autoConnect: false });
});

after(async () => {
    await closeServer();
});

test('remote pairing is disabled until Remote Operators is enabled', async () => {
    const { response, body } = await pairRemote({ code: '123456' });
    assert.equal(response.status, 403);
    assert.equal(body.ok, false);
});

test('remote pairing validates code, then allows remote socket auth', async () => {
    await serverModule.setRemoteAccessEnabled(true);
    const status = serverModule.getRemoteStatus();

    const badCode = await pairRemote({ code: '000000' });
    assert.equal(badCode.response.status, 401);

    const paired = await pairRemote({ code: status.pairingCode, deviceName: 'Lyrics Laptop' });
    assert.equal(paired.response.status, 200);
    assert.equal(paired.body.ok, true);
    assert.equal(paired.body.session.deviceName, 'Lyrics Laptop');

    const remote = await connectRemote(paired.body.remoteToken);
    assert.equal(remote.connected, true);
});

test('repeated wrong pairing codes lock the client out, then a valid pair is rejected while locked', async () => {
    await serverModule.setRemoteAccessEnabled(true);
    const validCode = serverModule.getRemoteStatus().pairingCode;

    // Five wrong codes are each rejected with 401; the fifth trips the lockout.
    for (let i = 0; i < 5; i += 1) {
        const attempt = await pairRemote({ code: '000000' });
        assert.equal(attempt.response.status, 401, `attempt ${i + 1} should be 401`);
    }

    // Now even the correct code is refused with 429 until the lockout expires.
    const locked = await pairRemote({ code: validCode });
    assert.equal(locked.response.status, 429);
    assert.equal(locked.body.ok, false);
    assert.ok(locked.body.retryAfter > 0);
    assert.ok(Number(locked.response.headers.get('retry-after')) > 0);
});

test('a successful pair rotates the code so the same code cannot be reused', async () => {
    await serverModule.setRemoteAccessEnabled(true);
    const firstCode = serverModule.getRemoteStatus().pairingCode;

    const paired = await pairRemote({ code: firstCode });
    assert.equal(paired.response.status, 200);

    const rotatedCode = serverModule.getRemoteStatus().pairingCode;
    assert.notEqual(rotatedCode, firstCode);

    const reuse = await pairRemote({ code: firstCode });
    assert.equal(reuse.response.status, 401);
});

test('revoked or disabled remote sessions cannot stay connected', async () => {
    await serverModule.setRemoteAccessEnabled(true);
    const paired = await pairRemote({ code: serverModule.getRemoteStatus().pairingCode });
    const remote = await connectRemote(paired.body.remoteToken);

    const disconnected = waitFor(remote, 'disconnect');
    await serverModule.setRemoteAccessEnabled(false);
    await disconnected;
    assert.equal(remote.connected, false);

    const rejected = createClient(baseUrl, {
        autoConnect: false,
        forceNew: true,
        reconnection: false,
        transports: ['websocket'],
        auth: { remoteToken: paired.body.remoteToken }
    });
    openSockets.push(rejected);
    const errorSeen = waitFor(rejected, 'connect_error');
    rejected.connect();
    await errorSeen;
});

test('expired remote sessions cannot connect', async () => {
    await serverModule.setRemoteAccessEnabled(true);
    const paired = await pairRemote({ code: serverModule.getRemoteStatus().pairingCode });
    serverModule.expireRemoteSessionForTests(paired.body.remoteToken);

    const rejected = createClient(baseUrl, {
        autoConnect: false,
        forceNew: true,
        reconnection: false,
        transports: ['websocket'],
        auth: { remoteToken: paired.body.remoteToken }
    });
    openSockets.push(rejected);
    const errorSeen = waitFor(rejected, 'connect_error');
    rejected.connect();
    await errorSeen;
});

test('remote logout revokes only the current remote session', async () => {
    await serverModule.setRemoteAccessEnabled(true);
    const paired = await pairRemote({ code: serverModule.getRemoteStatus().pairingCode });
    const remote = await connectRemote(paired.body.remoteToken);

    const ack = emitWithAck(remote, 'remote_logout');
    assert.deepEqual(await ack, { ok: true });
    remote.disconnect();

    const rejected = createClient(baseUrl, {
        autoConnect: false,
        forceNew: true,
        reconnection: false,
        transports: ['websocket'],
        auth: { remoteToken: paired.body.remoteToken }
    });
    openSockets.push(rejected);
    const errorSeen = waitFor(rejected, 'connect_error');
    rejected.connect();
    await errorSeen;
});

test('remote pairing sets a cookie that can authorize protected requests without query tokens', async () => {
    await serverModule.setRemoteAccessEnabled(true);
    const paired = await pairRemote({ code: serverModule.getRemoteStatus().pairingCode });
    const cookie = paired.response.headers.get('set-cookie');
    assert.match(cookie, /bc_remote_token=/);

    const status = await fetch(`${baseUrl}/api/remote/status`, {
        headers: { cookie }
    });
    assert.equal(status.status, 200);
    const body = await status.json();
    assert.equal(body.session.deviceName, 'Remote Test');
});

test('remote clients cannot stream unregistered local media paths', async () => {
    await serverModule.setRemoteAccessEnabled(true);
    const paired = await pairRemote({ code: serverModule.getRemoteStatus().pairingCode });
    const cookie = paired.response.headers.get('set-cookie');
    const mediaPath = path.join(testDataDir, 'private.mp4');
    fs.writeFileSync(mediaPath, 'not really a video');

    const denied = await fetchWithRetry(`${baseUrl}/stream-video?path=${encodeURIComponent(mediaPath)}`, {
        headers: { cookie, connection: 'close' }
    });
    assert.equal(denied.status, 404);

    const registered = await fetch(`${baseUrl}/api/local-media/register`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-bc-auth-token': serverModule.getAuthToken()
        },
        body: JSON.stringify({ path: mediaPath, type: 'local' })
    });
    assert.equal(registered.status, 200);
    const { media } = await registered.json();

    const allowed = await fetchWithRetry(`${baseUrl}/stream-video?mediaId=${encodeURIComponent(media.mediaId)}`, {
        headers: { cookie, connection: 'close' }
    });
    assert.equal(allowed.status, 200);
});

test('remote sessions can control show operations but not local admin actions', async () => {
    await serverModule.setRemoteAccessEnabled(true);
    const graphicsPair = await pairRemote({ code: serverModule.getRemoteStatus().pairingCode });
    const graphicsRemote = await connectRemote(graphicsPair.body.remoteToken);
    const local = await connectClient();

    const lowerThirdSeen = waitFor(local, 'play_graphic');
    graphicsRemote.emit('show_lower_third', { name: 'Speaker', title: 'Katha' });
    assert.equal((await lowerThirdSeen).name, 'Speaker');

    const mediaSeen = waitFor(local, 'media_play');
    graphicsRemote.emit('play_media', { type: 'youtube', id: 'abc123', name: 'Remote clip' });
    assert.equal((await mediaSeen).name, 'Remote clip');

    const forbidden = emitWithAck(graphicsRemote, 'remote_pairing_code_rotate');
    assert.equal((await forbidden).ok, false);

    const localAiForbidden = emitWithAck(graphicsRemote, 'local_ai_settings_request');
    assert.equal((await localAiForbidden).ok, false);

    graphicsRemote.emit('start_translation', {
        engine: 'local',
        targetLang: 'en',
        sourceLanguages: ['gu-IN']
    });
    const blockedAction = await waitFor(graphicsRemote, 'action_forbidden');
    assert.match(blockedAction.error, /main controller/);
});

test('loopback is never blocked, in every spelling', async () => {
    // The lockout guard: the app's own windows (control/graphics/stage/backstage/NDI) all
    // connect over loopback, so these must hold regardless of remote access or selection.
    for (const address of ['127.0.0.1', '127.1.2.3', '::1', '::ffff:127.0.0.1']) {
        assert.equal(serverModule.isLoopbackAddress(address), true, `${address} should be loopback`);
        assert.equal(serverModule.isAllowedInterface(address), true, `${address} should be allowed`);
    }

    await serverModule.setRemoteAccessEnabled(true);
    for (const address of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
        assert.equal(serverModule.isAllowedInterface(address), true, `${address} allowed while enabled`);
    }

    // And the real controller path still works end to end over loopback.
    const local = await connectClient();
    assert.equal(local.connected, true);
    const page = await fetchWithRetry(`${baseUrl}/?auth=${serverModule.getAuthToken()}`);
    assert.equal(page.status, 200);
});

test('remote access is confined to the selected network interface', async () => {
    const adapters = serverModule.getNetworkAdapters();

    // Disabled: nothing but loopback may arrive.
    assert.equal(serverModule.isAllowedInterface('10.99.99.99'), false);

    await serverModule.setRemoteAccessEnabled(true);
    const active = serverModule.getRemoteStatus().activeAddress;

    if (adapters.length > 0) {
        assert.equal(typeof active, 'string');
        assert.ok(active, 'an adapter should be auto-selected when one exists');
        assert.equal(serverModule.isAllowedInterface(active), true, 'selected address must be allowed');
        // IPv4-mapped form of the same address must also pass.
        assert.equal(serverModule.isAllowedInterface(`::ffff:${active}`), true);
    }
    // An address that is not the selected adapter is refused.
    assert.equal(serverModule.isAllowedInterface('10.99.99.99'), false);
});

test('an unavailable selected network keeps enforcing instead of opening up', async () => {
    serverModule.saveRemoteNetworkSelection('No Such Adapter 9000');
    await serverModule.setRemoteAccessEnabled(true);

    const status = serverModule.getRemoteStatus();
    assert.equal(status.activeAddress, '');
    assert.equal(status.networkUnavailable, true);
    assert.deepEqual(status.lanUrls, [], 'no URLs published when the adapter is gone');
    assert.deepEqual(status.slidesUrls, []);

    // Critically: it must NOT fall back to allowing every network.
    assert.equal(serverModule.isAllowedInterface('10.99.99.99'), false);
    assert.equal(serverModule.isAllowedInterface('192.168.1.50'), false);
    // Loopback still works, so the operator can undo the setting.
    assert.equal(serverModule.isAllowedInterface('127.0.0.1'), true);
});

test('remote_network_set is local-only and updates the published status', async () => {
    await serverModule.setRemoteAccessEnabled(true);
    const paired = await pairRemote({ code: serverModule.getRemoteStatus().pairingCode });
    const remote = await connectRemote(paired.body.remoteToken);

    const forbidden = await emitWithAck(remote, 'remote_network_set', 'Some Adapter');
    assert.equal(forbidden.ok, false, 'a remote must not be able to widen its own access');
    assert.equal(serverModule.getRemoteStatus().selectedNetwork, 'auto');

    const local = await connectClient();
    const allowed = await emitWithAck(local, 'remote_network_set', 'Ethernet Test');
    assert.equal(allowed.ok, true);
    assert.equal(allowed.status.selectedNetwork, 'Ethernet Test');
    assert.equal(serverModule.getRemoteStatus().selectedNetwork, 'Ethernet Test');
});

test('timed rotation keeps the previous code alive briefly; a used code dies at once', async () => {
    await serverModule.setRemoteAccessEnabled(true);
    const original = serverModule.getRemoteStatus().pairingCode;

    // Timed rotation -> the outgoing code stays valid inside the grace window.
    serverModule.rotatePairingCode({ grace: true });
    const rotated = serverModule.getRemoteStatus().pairingCode;
    assert.notEqual(rotated, original, 'rotation must mint a new code');

    const graced = await pairRemote({ code: original, deviceName: 'Mid-scan' });
    assert.equal(graced.response.status, 200, 'the just-retired code should still pair within grace');

    // A successful pair rotates WITHOUT grace, so the code it consumed is dead immediately.
    const afterPair = serverModule.getRemoteStatus().pairingCode;
    const reuse = await pairRemote({ code: original });
    assert.equal(reuse.response.status, 401, 'a consumed code must never work again');
    assert.notEqual(afterPair, original);
});

test('two timed rotations retire the oldest code', async () => {
    await serverModule.setRemoteAccessEnabled(true);
    const oldest = serverModule.getRemoteStatus().pairingCode;

    serverModule.rotatePairingCode({ grace: true });
    serverModule.rotatePairingCode({ grace: true });

    const stale = await pairRemote({ code: oldest });
    assert.equal(stale.response.status, 401, 'only the immediately-previous code gets grace');
});

test('remote status exposes the QR countdown and network fields', async () => {
    await serverModule.setRemoteAccessEnabled(true);
    const status = serverModule.getRemoteStatus();

    assert.ok(status.pairingCodeExpiresAt > Date.now(), 'countdown target should be in the future');
    assert.ok(Array.isArray(status.networks));
    for (const adapter of status.networks) {
        assert.equal(typeof adapter.name, 'string');
        assert.equal(typeof adapter.address, 'string');
        assert.equal(typeof adapter.isVirtual, 'boolean');
    }
    assert.equal(status.selectedNetwork, 'auto');
    assert.equal(typeof status.activeAddress, 'string');

    // Disabled: no code and no countdown leak out.
    await serverModule.setRemoteAccessEnabled(false);
    const off = serverModule.getRemoteStatus();
    assert.equal(off.pairingCode, '');
    assert.equal(off.pairingCodeExpiresAt, 0);
});

test('pres_goto navigates authoritatively and clamps at both ends', async () => {
    const operator = await connectClient();
    operator.emit('pres_update', {
        mode: 'images', baseUrl: '', slideId: '', currentIdx: 0,
        totalSlides: 3, images: ['a', 'b', 'c'], isCanva: false, showing: false
    });
    await waitFor(operator, 'pres_update');

    const next = waitFor(operator, 'pres_update');
    operator.emit('pres_goto', { direction: 'next' });
    assert.equal((await next).currentIdx, 1);

    const last = waitFor(operator, 'pres_update');
    operator.emit('pres_goto', { direction: 'last' });
    assert.equal((await last).currentIdx, 2);

    // Already on the last slide: 'next' must not broadcast pres_update to anyone
    // -- but the caller still gets a pres_meta acknowledging the clamp, so its UI
    // doesn't look frozen with no response at all.
    let extra = 0;
    operator.on('pres_update', () => { extra += 1; });
    const clampAck = waitFor(operator, 'pres_meta');
    operator.emit('pres_goto', { direction: 'next' });
    const ack = await clampAck;
    assert.equal(ack.currentIdx, 2, 'the no-op ack should reflect the clamped (unchanged) index');
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.equal(extra, 0, 'pres_goto past the end should not broadcast');

    const jumped = waitFor(operator, 'pres_update');
    operator.emit('pres_goto', { index: 0 });
    assert.equal((await jumped).currentIdx, 0);

    // Out-of-range index clamps into the deck.
    const clamped = waitFor(operator, 'pres_update');
    operator.emit('pres_goto', { index: 99 });
    assert.equal((await clamped).currentIdx, 2);
});

test('pres_goto and pres_set_showing are no-ops without a loaded deck', async () => {
    const operator = await connectClient();
    let broadcasts = 0;
    operator.on('pres_update', () => { broadcasts += 1; });

    operator.emit('pres_goto', { direction: 'next' });
    operator.emit('pres_set_showing', true);
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.equal(broadcasts, 0);
});

test('pres_set_showing toggles the live flag', async () => {
    const operator = await connectClient();
    operator.emit('pres_update', {
        mode: 'url', baseUrl: 'https://example.test/embed?slide=', slideId: 'x',
        currentIdx: 0, totalSlides: 4, images: [], isCanva: false, showing: false
    });
    await waitFor(operator, 'pres_update');

    const live = waitFor(operator, 'pres_update');
    operator.emit('pres_set_showing', true);
    assert.equal((await live).showing, true);

    const down = waitFor(operator, 'pres_update');
    operator.emit('pres_set_showing', false);
    assert.equal((await down).showing, false);
});

test('pres_meta mirrors slide state without shipping the images array', async () => {
    const operator = await connectClient();
    const metaSeen = waitFor(operator, 'pres_meta');
    operator.emit('pres_update', {
        mode: 'images', baseUrl: '', slideId: '', currentIdx: 1,
        totalSlides: 3, images: ['a', 'b', 'c'], isCanva: false, showing: true
    });

    const meta = await metaSeen;
    assert.equal(meta.mode, 'images');
    assert.equal(meta.currentIdx, 1);
    assert.equal(meta.totalSlides, 3);
    assert.equal(meta.showing, true);
    assert.ok(!('images' in meta), 'pres_meta must not carry the images array');

    // New clients get pres_meta replayed on connect.
    const { waits } = await connectClientWithReplay(['pres_meta']);
    const replayed = await waits.pres_meta;
    assert.equal(replayed.currentIdx, 1);
    assert.ok(!('images' in replayed));
});

test('a paired remote can drive slides through pres_goto and pres_set_showing', async () => {
    await serverModule.setRemoteAccessEnabled(true);
    const paired = await pairRemote({ code: serverModule.getRemoteStatus().pairingCode, deviceName: 'iPad' });
    const remote = await connectRemote(paired.body.remoteToken);
    const local = await connectClient();

    local.emit('pres_update', {
        mode: 'images', baseUrl: '', slideId: '', currentIdx: 0,
        totalSlides: 3, images: ['a', 'b', 'c'], isCanva: false, showing: false
    });
    await waitFor(local, 'pres_update');

    const advanced = waitFor(local, 'pres_update');
    remote.emit('pres_goto', { direction: 'next' });
    assert.equal((await advanced).currentIdx, 1, 'remote should advance the deck for everyone');

    const live = waitFor(local, 'pres_update');
    remote.emit('pres_set_showing', true);
    assert.equal((await live).showing, true);
});

test('serves a single deck slide over HTTP for lightweight remotes', async () => {
    const operator = await connectClient();
    // 1x1 transparent GIF.
    const gif = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
    operator.emit('pres_update', {
        mode: 'images', baseUrl: '', slideId: '', currentIdx: 0,
        totalSlides: 1, images: [gif], isCanva: false, showing: false
    });
    await waitFor(operator, 'pres_update');

    const token = serverModule.getAuthToken();
    const ok = await fetchWithRetry(`${baseUrl}/api/presentation/slide/0?auth=${token}`);
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('content-type'), 'image/gif');
    assert.ok((await ok.arrayBuffer()).byteLength > 0);

    const missing = await fetchWithRetry(`${baseUrl}/api/presentation/slide/5?auth=${token}`);
    assert.equal(missing.status, 404);

    const unauthorized = await fetchWithRetry(`${baseUrl}/api/presentation/slide/0`);
    assert.equal(unauthorized.status, 403);
});

test('deckId is stable across navigation and show/hide, and changes on a new deck', async () => {
    const operator = await connectClient();
    operator.emit('pres_update', {
        mode: 'images', baseUrl: '', slideId: '', currentIdx: 0,
        totalSlides: 3, images: ['a', 'b', 'c'], isCanva: false, showing: false
    });
    const first = await waitFor(operator, 'pres_update');
    assert.ok(first.deckId, 'a loaded deck must carry a deckId');

    const afterGoto = waitFor(operator, 'pres_update');
    operator.emit('pres_goto', { direction: 'next' });
    assert.equal((await afterGoto).deckId, first.deckId, 'navigation must not change the deck id');

    const afterShowing = waitFor(operator, 'pres_update');
    operator.emit('pres_set_showing', true);
    assert.equal((await afterShowing).deckId, first.deckId, 'show/hide must not change the deck id');

    operator.emit('pres_update', {
        mode: 'images', baseUrl: '', slideId: '', currentIdx: 0,
        totalSlides: 2, images: ['x', 'y'], isCanva: false, showing: false
    });
    const second = await waitFor(operator, 'pres_update');
    assert.ok(second.deckId);
    assert.notEqual(second.deckId, first.deckId, 'a new deck must get a new id');
});

test('remotes receive presentation state with images stripped; local sockets do not', async () => {
    await serverModule.setRemoteAccessEnabled(true);
    const paired = await pairRemote({ code: serverModule.getRemoteStatus().pairingCode });
    const remote = await connectRemote(paired.body.remoteToken);
    const local = await connectClient();

    const localSeen = waitFor(local, 'pres_update');
    const remoteSeen = waitFor(remote, 'pres_update');
    local.emit('pres_update', {
        mode: 'images', baseUrl: '', slideId: '', currentIdx: 0,
        totalSlides: 2, images: ['a', 'b'], isCanva: false, showing: true
    });

    const [localState, remoteState] = await Promise.all([localSeen, remoteSeen]);
    assert.deepEqual(localState.images, ['a', 'b']);
    assert.deepEqual(remoteState.images, [], 'a remote must never receive the images array over the socket');
    assert.deepEqual(remoteState.thumbs, [], 'a remote must never receive the thumbs array over the socket either');
    assert.equal(remoteState.currentIdx, 0);
    assert.equal(remoteState.totalSlides, 2);
    assert.equal(remoteState.deckId, localState.deckId, 'both rooms must agree on the deck id');
});

test('connect replay gives local sockets full presentation state and remotes the stripped version', async () => {
    const local = await connectClient();
    local.emit('pres_update', {
        mode: 'images', baseUrl: '', slideId: '', currentIdx: 0,
        totalSlides: 1, images: ['solo'], isCanva: false, showing: true
    });
    await waitFor(local, 'pres_update');

    await serverModule.setRemoteAccessEnabled(true);
    const paired = await pairRemote({ code: serverModule.getRemoteStatus().pairingCode });

    const lateLocal = await connectClientWithReplay(['pres_update']);
    const lateLocalState = await lateLocal.waits.pres_update;
    assert.deepEqual(lateLocalState.images, ['solo']);

    const remoteSocket = createClient(baseUrl, {
        autoConnect: false, forceNew: true, reconnection: false,
        transports: ['websocket'], auth: { remoteToken: paired.body.remoteToken }
    });
    openSockets.push(remoteSocket);
    const remoteReplay = waitFor(remoteSocket, 'pres_update');
    const remoteConnected = waitFor(remoteSocket, 'connect');
    remoteSocket.connect();
    await remoteConnected;
    const remoteState = await remoteReplay;
    assert.deepEqual(remoteState.images, [], 'a freshly paired remote must not receive images on replay either');
});

test('slide endpoint caches immutably only with a matching deckId, and rejects a stale one', async () => {
    const operator = await connectClient();
    // 1x1 transparent GIF.
    const gif = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
    operator.emit('pres_update', {
        mode: 'images', baseUrl: '', slideId: '', currentIdx: 0,
        totalSlides: 1, images: [gif], isCanva: false, showing: false
    });
    const state = await waitFor(operator, 'pres_update');
    const deckId = state.deckId;
    assert.ok(deckId);

    const token = serverModule.getAuthToken();

    // No ?v=: back-compat behaviour, the original always-revalidate response.
    const noVersion = await fetchWithRetry(`${baseUrl}/api/presentation/slide/0?auth=${token}`);
    assert.equal(noVersion.status, 200);
    assert.equal(noVersion.headers.get('cache-control'), 'no-cache');

    // Correct ?v=: immutable, indefinite caching, with an ETag.
    const versioned = await fetchWithRetry(`${baseUrl}/api/presentation/slide/0?auth=${token}&v=${deckId}`);
    assert.equal(versioned.status, 200);
    assert.equal(versioned.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    const etag = versioned.headers.get('etag');
    assert.ok(etag);

    // A conditional request carrying that ETag gets a 304. Node's fetch
    // auto-injects `Cache-Control: no-cache` whenever If-None-Match is present
    // (undici mimicking a forced end-to-end reload), which Express's `fresh`
    // check honours by design (RFC 2616 §14.9.4) and always treats as stale --
    // a real browser's <img> revalidation doesn't send that header, so this
    // override just keeps the test representative of production traffic.
    const conditional = await fetchWithRetry(`${baseUrl}/api/presentation/slide/0?auth=${token}&v=${deckId}`, {
        headers: { 'If-None-Match': etag, 'Cache-Control': 'max-age=0' }
    });
    assert.equal(conditional.status, 304);

    // A stale ?v= (a prefetch that raced a deck swap) must never be answered with
    // the current deck's pixels -- that would poison an immutable cache entry.
    const stale = await fetchWithRetry(`${baseUrl}/api/presentation/slide/0?auth=${token}&v=not-the-real-deck-id`);
    assert.equal(stale.status, 409);
    assert.equal(stale.headers.get('cache-control'), 'no-store');
});

test('slide endpoint falls back to the full slide when ?w= is requested but no thumbnail exists', async () => {
    const operator = await connectClient();
    const gif = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
    // No `thumbs` field at all -- decks saved before thumbnails existed.
    operator.emit('pres_update', {
        mode: 'images', baseUrl: '', slideId: '', currentIdx: 0,
        totalSlides: 1, images: [gif], isCanva: false, showing: false
    });
    await waitFor(operator, 'pres_update');

    const token = serverModule.getAuthToken();
    const res = await fetchWithRetry(`${baseUrl}/api/presentation/slide/0?auth=${token}&w=320`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/gif');
    assert.ok((await res.arrayBuffer()).byteLength > 0);
});

test('pres_nav moves the deck server-side, same as pres_goto, and clamps silently past the end', async () => {
    const graphics = await connectClient();
    const other = await connectClient();
    graphics.emit('pres_update', {
        mode: 'images', baseUrl: '', slideId: '', currentIdx: 0,
        totalSlides: 2, images: ['a', 'b'], isCanva: false, showing: true
    });
    await waitFor(graphics, 'pres_update');

    const advanced = waitFor(other, 'pres_update', { predicate: data => data?.currentIdx === 1 });
    graphics.emit('pres_nav', 'next');
    assert.equal((await advanced).currentIdx, 1);

    // Already on the last slide: no pres_update should reach anyone else...
    let otherBroadcasts = 0;
    other.on('pres_update', () => { otherBroadcasts += 1; });
    // ...but the caller itself gets a pres_meta acknowledging the clamp.
    const ackMeta = waitFor(graphics, 'pres_meta');
    graphics.emit('pres_nav', 'next');
    const meta = await ackMeta;
    assert.equal(meta.currentIdx, 1);
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.equal(otherBroadcasts, 0, 'pres_nav past the end should not broadcast pres_update');
});

test('request_pres_state replies directly to the requesting socket, not the whole room', async () => {
    const operator = await connectClient();
    const other = await connectClient();
    operator.emit('pres_update', {
        mode: 'images', baseUrl: '', slideId: '', currentIdx: 1,
        totalSlides: 3, images: ['a', 'b', 'c'], isCanva: false, showing: true
    });
    await waitFor(operator, 'pres_update');
    await waitFor(other, 'pres_update');

    // A resync request from `other` must not cause a second broadcast to `operator`.
    let operatorExtraUpdates = 0;
    operator.on('pres_update', () => { operatorExtraUpdates += 1; });

    const resynced = waitFor(other, 'pres_update');
    other.emit('request_pres_state');
    const resyncedState = await resynced;
    assert.equal(resyncedState.currentIdx, 1);
    assert.equal(resyncedState.mode, 'images');

    await new Promise(resolve => setTimeout(resolve, 80));
    assert.equal(operatorExtraUpdates, 0, 'request_pres_state must reply only to the requester');
});

test('replays cached presentation, output mode, and layer visibility to new clients', async () => {
    const operator = await connectClient();

    // Every genuine pres_update now gets a server-stamped deckId (see
    // bumpPresDeckId), so these compare field-by-field rather than a full
    // deep-equal against a hand-built object that can't predict that id.
    const presState = { mode: 'images', currentIdx: 2, totalSlides: 5, images: ['a', 'b', 'c'], showing: true };
    const presEcho = waitFor(operator, 'pres_update');
    operator.emit('pres_update', presState);
    const echoed = await presEcho;
    assert.equal(echoed.mode, presState.mode);
    assert.equal(echoed.currentIdx, presState.currentIdx);
    assert.equal(echoed.totalSlides, presState.totalSlides);
    assert.deepEqual(echoed.images, presState.images);
    assert.equal(echoed.showing, presState.showing);
    assert.ok(echoed.deckId, 'a loaded deck must carry a deckId');

    const hiddenPresState = { ...presState, showing: false };
    const hiddenPresEcho = waitFor(operator, 'pres_update', {
        predicate: data => data?.showing === false
    });
    operator.emit('pres_update', hiddenPresState);
    const hiddenEchoed = await hiddenPresEcho;
    assert.equal(hiddenEchoed.showing, false);
    assert.equal(hiddenEchoed.currentIdx, hiddenPresState.currentIdx);
    assert.ok(hiddenEchoed.deckId);

    const clearedPresState = {
        mode: 'none',
        baseUrl: '',
        slideId: '',
        currentIdx: 0,
        totalSlides: 0,
        images: [],
        isCanva: false,
        showing: false
    };
    const clearedPresEcho = waitFor(operator, 'pres_update', {
        predicate: data => data?.mode === 'none'
    });
    operator.emit('pres_update', clearedPresState);
    const clearedEchoed = await clearedPresEcho;
    assert.equal(clearedEchoed.mode, 'none');
    assert.equal(clearedEchoed.totalSlides, 0);
    assert.deepEqual(clearedEchoed.images, []);

    const outputEcho = waitFor(operator, 'output_mode_update', {
        predicate: data => data?.backgroundMode === 'transparent'
    });
    operator.emit('output_mode_update', { backgroundMode: 'transparent' });
    const outputEchoed = await outputEcho;
    assert.equal(outputEchoed.backgroundMode, 'transparent');
    // fitMode wasn't part of this update -- must be preserved (defaulting to 'fit'),
    // not reset, so an unrelated field's change never silently flips Fill Display.
    assert.equal(outputEchoed.fitMode, 'fit');

    const visibilityPatch = { media: false, lyrics: false, particles: true };
    const layerEcho = waitFor(operator, 'layer_visibility_update', {
        predicate: data => data?.media === false && data?.lyrics === false
    });
    operator.emit('layer_visibility_update', visibilityPatch);
    const layerState = await layerEcho;
    assert.equal(layerState.media, false);
    assert.equal(layerState.lyrics, false);
    assert.equal(layerState.particles, true);

    const replay = await connectClientWithReplay([
        'pres_update',
        'output_mode_update',
        'layer_visibility_update'
    ]);

    const replayedPres = await replay.waits.pres_update;
    assert.equal(replayedPres.mode, 'none');
    assert.equal(replayedPres.totalSlides, 0);
    const replayedOutputMode = await replay.waits.output_mode_update;
    assert.equal(replayedOutputMode.backgroundMode, 'transparent');
    assert.equal(replayedOutputMode.fitMode, 'fit');
    const replayedLayers = await replay.waits.layer_visibility_update;
    assert.equal(replayedLayers.media, false);
    assert.equal(replayedLayers.lyrics, false);
});

test('output_mode_update sets fitMode independently and rejects invalid values', async () => {
    const operator = await connectClient();

    const filled = waitFor(operator, 'output_mode_update', { predicate: data => data?.fitMode === 'fill' });
    operator.emit('output_mode_update', { fitMode: 'fill' });
    const filledState = await filled;
    assert.equal(filledState.fitMode, 'fill');
    // Setting fitMode alone must not disturb backgroundMode, which the client never sent here.
    assert.equal(filledState.backgroundMode, 'green');

    // A follow-up update for the *other* field must not undo the fitMode just set.
    const recoloured = waitFor(operator, 'output_mode_update', { predicate: data => data?.backgroundMode === 'black' });
    operator.emit('output_mode_update', { backgroundMode: 'black' });
    const recolouredState = await recoloured;
    assert.equal(recolouredState.backgroundMode, 'black');
    assert.equal(recolouredState.fitMode, 'fill', 'an unrelated field update must not reset fitMode');

    // An invalid fitMode is ignored -- preserves whatever was already set rather than
    // silently reverting to the hardcoded default.
    const afterInvalid = waitFor(operator, 'output_mode_update');
    operator.emit('output_mode_update', { fitMode: 'stretch' });
    const afterInvalidState = await afterInvalid;
    assert.equal(afterInvalidState.fitMode, 'fill', 'an invalid fitMode must not overwrite the previously valid one');
});

test('ATEM settings persist locally and validate the switcher address', async () => {
    const local = await connectClient();
    const saved = await emitWithAck(local, 'atem_settings_save', { address: '192.168.1.240', port: 9910 });

    assert.equal(saved.ok, true);
    assert.equal(saved.settings.address, '192.168.1.240');
    assert.equal(path.dirname(serverModule.getAtemSettingsPath()), testDataDir);

    const invalid = serverModule.validateAtemSettings({ address: '' });
    assert.equal(invalid.ok, false);
    assert.equal(invalid.errors.length, 1);

    // An out-of-range port is auto-corrected back to 9910 rather than rejected —
    // same "clamp, don't reject" treatment this file gives chunkSeconds elsewhere.
    const oddPort = serverModule.validateAtemSettings({ address: '192.168.1.240', port: 99999 });
    assert.equal(oddPort.ok, true);
    assert.equal(oddPort.settings.port, 9910);

    const badHost = serverModule.validateAtemSettings({ address: 'not a host!', port: 9910 });
    assert.equal(badHost.checks.address, false);

    const validHostname = serverModule.validateAtemSettings({ address: 'atem-switcher.local', port: 9910 });
    assert.equal(validHostname.checks.address, true);
});

test('a remote operator cannot read or save ATEM settings', async () => {
    // The switcher address is the LAN location of production hardware — same
    // sensitivity class as local_ai_settings, which this mirrors.
    await serverModule.setRemoteAccessEnabled(true);
    const pair = await pairRemote({ code: serverModule.getRemoteStatus().pairingCode });
    const remote = await connectRemote(pair.body.remoteToken);

    const readForbidden = await emitWithAck(remote, 'atem_settings_request');
    assert.equal(readForbidden.ok, false);

    const saveForbidden = await emitWithAck(remote, 'atem_settings_save', { address: '10.0.0.1' });
    assert.equal(saveForbidden.ok, false);
});

test('a saved ATEM connections list round-trips alongside the active address', async () => {
    // connections/activeConnectionId are purely additive on top of the
    // existing address/port/autoConnect shape — this is what proves it.
    const local = await connectClient();
    const withConnections = await emitWithAck(local, 'atem_settings_save', {
        address: '192.168.1.240',
        port: 9910,
        connections: [
            { id: 'venue-a', name: 'Main Sanctuary', address: '192.168.1.240', port: 9910 },
            { id: 'venue-b', name: 'Overflow Room', address: '192.168.1.241', port: 9910 },
        ],
        activeConnectionId: 'venue-a',
    });

    assert.equal(withConnections.ok, true);
    assert.equal(withConnections.settings.connections.length, 2);
    assert.equal(withConnections.settings.connections[1].name, 'Overflow Room');
    assert.equal(withConnections.settings.activeConnectionId, 'venue-a');

    // atem_settings_request's handler takes a single (ack) param — like the
    // real frontend's `socket.emit('atem_settings_request', () => {})`, this
    // must emit with exactly one argument, not go through emitWithAck's
    // (payload, ack) shape, or the ack callback lands in the wrong position
    // and never fires.
    const reloaded = await new Promise(resolve => local.emit('atem_settings_request', resolve));
    assert.equal(reloaded.settings.connections.length, 2);
    assert.equal(reloaded.settings.activeConnectionId, 'venue-a');
});

test('relays media controls and returns full media state on request', async () => {
    const operator = await connectClient();
    const graphics = await connectClient();

    const mediaPath = path.join(testDataDir, 'video.mp4');
    fs.writeFileSync(mediaPath, 'fake video');
    const media = { type: 'local', path: mediaPath, name: 'video.mp4', duration: 120 };
    const playSeen = waitFor(graphics, 'media_play');
    operator.emit('play_media', media);
    const playedMedia = await playSeen;
    assert.equal(playedMedia.path, fs.realpathSync(mediaPath));
    assert.equal(playedMedia.name, 'video.mp4');
    assert.ok(playedMedia.mediaId);

    const pausedSeen = waitFor(graphics, 'media_toggle_play');
    operator.emit('media_toggle_play', false);
    assert.equal(await pausedSeen, false);

    operator.emit('media_set_loop', true);
    operator.emit('media_set_auto_next', true);
    operator.emit('media_set_muted', true);
    operator.emit('media_message_overlay_update', {
        enabled: true,
        text: 'Please remain seated',
        position: 'lowerThird',
        size: 84,
        color: '#ffcc00',
        weight: '900',
        uppercase: true,
        backdrop: true
    });

    const controller = await connectClient();
    const replayedMedia = waitFor(controller, 'media_play');
    const replayedPlaying = waitFor(controller, 'media_toggle_play');
    const replayedMessage = waitFor(controller, 'media_message_overlay_update', {
        predicate: data => data?.text === 'Please remain seated'
    });
    controller.emit('request_media_state');

    const replayed = await replayedMedia;
    assert.equal(replayed.mediaId, playedMedia.mediaId);
    assert.equal(replayed.loop, true);
    assert.equal(replayed.autoNext, true);
    assert.equal(replayed.muted, true);
    assert.equal(await replayedPlaying, false);
    assert.deepEqual(await replayedMessage, {
        enabled: true,
        text: 'Please remain seated',
        position: 'lowerThird',
        size: 84,
        color: '#ffcc00',
        weight: '900',
        uppercase: true,
        backdrop: true
    });

    const stopSeen = waitFor(graphics, 'media_stop');
    operator.emit('stop_media');
    await stopSeen;
});

test('emits normalized operator state for live outputs and clear flow', async () => {
    const operator = await connectClient();
    const monitor = await connectClient();

    const lowerThirdSeen = waitFor(monitor, 'operator_state_update', {
        predicate: data => data?.live?.lowerThird === true && data?.current?.lowerThird?.name === 'Pramukh Swami Maharaj'
    });
    operator.emit('show_lower_third', {
        name: 'Pramukh Swami Maharaj',
        title: 'Blessings',
        subtitle2: 'Evening Sabha'
    });
    const lowerThirdState = await lowerThirdSeen;
    assert.equal(lowerThirdState.current.lowerThird.title, 'Blessings');

    const lyricsSeen = waitFor(monitor, 'operator_state_update', {
        predicate: data => data?.live?.lyrics === true && data?.current?.lyrics?.engText === 'Welcome'
    });
    operator.emit('show_lyrics', {
        engText: 'Welcome',
        gujText: 'સ્વાગત',
        langOpt: 'both'
    });
    assert.equal((await lyricsSeen).current.lyrics.gujText, 'સ્વાગત');

    const mediaSeen = waitFor(monitor, 'operator_state_update', {
        predicate: data => data?.live?.media === true && data?.current?.media?.name === 'intro.mp4'
    });
    const introPath = path.join(testDataDir, 'intro.mp4');
    fs.writeFileSync(introPath, 'fake intro');
    operator.emit('play_media', { type: 'local', path: introPath, name: 'intro.mp4' });
    assert.equal((await mediaSeen).playback.mediaPlaying, true);

    const sabhaSeen = waitFor(monitor, 'operator_state_update', {
        predicate: data => data?.live?.sabhaTimer === true && data?.current?.sabhaTimer?.timeStr === '16:00'
    });
    operator.emit('sabha_timer_update', { timeStr: '16:00', message: 'Sabha Starts In', showing: true });
    assert.equal((await sabhaSeen).current.sabhaTimer.message, 'Sabha Starts In');

    const presSeen = waitFor(monitor, 'operator_state_update', {
        predicate: data => data?.live?.presentation === true && data?.current?.presentation?.totalSlides === 3
    });
    operator.emit('pres_update', { mode: 'images', currentIdx: 1, totalSlides: 3, images: ['a', 'b', 'c'], showing: true });
    assert.equal((await presSeen).current.presentation.label, 'Slide 2 of 3');

    const clearSeen = waitFor(monitor, 'operator_state_update', {
        predicate: data => data?.live?.media === false && data?.live?.lyrics === false && data?.live?.lowerThird === false && data?.live?.presentation === false && data?.live?.sabhaTimer === false
    });
    operator.emit('clear_all');
    const cleared = await clearSeen;
    assert.equal(cleared.outputMode.backgroundMode, 'green');
});

test('tracks stage timer update, pause, resume, stop, and cached request replay', async () => {
    const operator = await connectClient();
    const stage = await connectClient();

    const timerData = { duration: 300, remaining: 240, label: 'Break' };
    const updateSeen = waitFor(stage, 'stage_timer_update');
    operator.emit('set_stage_timer', timerData);
    assert.deepEqual(await updateSeen, timerData);

    const pauseSeen = waitFor(stage, 'stage_timer_pause');
    operator.emit('pause_stage_timer');
    await pauseSeen;

    const lateStage = await connectClient();
    const replayPause = waitFor(lateStage, 'stage_timer_pause');
    lateStage.emit('request_stage_state');
    await replayPause;

    const resumeData = { duration: 300, remaining: 180, label: 'Break' };
    const resumeSeen = waitFor(stage, 'stage_timer_update');
    operator.emit('resume_stage_timer', resumeData);
    assert.deepEqual(await resumeSeen, resumeData);

    const stopSeen = waitFor(stage, 'stage_timer_stop');
    operator.emit('stop_stage_timer');
    await stopSeen;
});

test('replays current presentation when confidence monitor requests stage state', async () => {
    const operator = await connectClient();
    const stage = await connectClient();
    const presState = { mode: 'url', currentIdx: 4, totalSlides: 12, baseUrl: 'https://docs.google.com/presentation/d/deck/embed?rm=minimal&slide=', slideId: 'deck', images: [], isCanva: false, showing: true };

    const presEcho = waitFor(operator, 'pres_update', {
        predicate: data => data?.currentIdx === 4
    });
    operator.emit('pres_update', presState);
    // Field-by-field: a genuine pres_update now carries a server-stamped deckId
    // (see bumpPresDeckId) that this hand-built expected object can't predict.
    const echoed = await presEcho;
    assert.equal(echoed.mode, presState.mode);
    assert.equal(echoed.currentIdx, presState.currentIdx);
    assert.equal(echoed.baseUrl, presState.baseUrl);
    assert.ok(echoed.deckId);

    const replaySeen = waitFor(stage, 'pres_update', {
        predicate: data => data?.currentIdx === 4
    });
    stage.emit('request_stage_state');
    const replayed = await replaySeen;
    assert.equal(replayed.mode, presState.mode);
    assert.equal(replayed.currentIdx, presState.currentIdx);
    assert.equal(replayed.baseUrl, presState.baseUrl);
    assert.equal(replayed.deckId, echoed.deckId, 'the stage replay must carry the same deck id, not a new one');
});

test('starts, relays, caches, stops, and clears translation worker lifecycle', async () => {
    const workers = [];
    serverModule.setTranslationWorkerFactoryForTests(() => {
        const worker = new FakeWorker();
        workers.push(worker);
        return worker;
    });

    const operator = await connectClient();
    const graphics = await connectClient();

    const startingSeen = waitFor(graphics, 'translation_status', {
        predicate: data => data?.state === 'starting'
    });
    operator.emit('start_translation', {
        key: 'test-key',
        region: 'eastus',
        targetLang: 'gu',
        sourceLanguages: ['en-US']
    });

    await waitUntil(() => workers.length === 1, { message: 'Translation worker was not spawned' });
    await startingSeen;
    assert.deepEqual(workers[0].sent[0].type, 'start');

    const listeningSeen = waitFor(graphics, 'translation_status', {
        predicate: data => data?.state === 'listening'
    });
    workers[0].emitWorker('message', { type: 'translation_started' });
    assert.equal((await listeningSeen).targetLang, 'gu');

    const updateSeen = waitFor(graphics, 'translation_update');
    workers[0].emitWorker('message', {
        type: 'translation_update',
        data: { text: 'Jai Swaminarayan', isFinal: true, lang: 'gu' }
    });
    const update = await updateSeen;
    assert.equal(update.text, 'Jai Swaminarayan');
    assert.equal(update.isFinal, true);

    const lateGraphics = await connectClientWithReplay(['translation_update']);
    assert.equal((await lateGraphics.waits.translation_update).text, 'Jai Swaminarayan');

    operator.emit('audio_chunk', Uint8Array.from([1, 2, 3]));
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(workers[0].sent.at(-1).type, 'audio_chunk');

    const displayClearSeen = waitFor(graphics, 'hide_translation');
    operator.emit('clear_translation_display');
    await displayClearSeen;
    assert.equal(workers[0].killed, false);

    const hideSeen = waitFor(graphics, 'hide_translation');
    const stoppedSeen = waitFor(graphics, 'translation_status', {
        predicate: data => data?.state === 'idle'
    });
    operator.emit('stop_translation');
    await hideSeen;
    assert.equal((await stoppedSeen).state, 'idle');
    assert.equal(workers[0].killed, true);

    operator.emit('start_translation', {
        key: 'test-key',
        region: 'eastus',
        targetLang: 'gu',
        sourceLanguages: ['en-US']
    });
    await waitUntil(() => workers.length === 2, { message: 'Second translation worker was not spawned' });

    const presState = { mode: 'images', currentIdx: 1, totalSlides: 3, images: ['one', 'two', 'three'], showing: true };
    const presEcho = waitFor(graphics, 'pres_update', {
        predicate: data => data?.mode === 'images' && data?.showing === true
    });
    operator.emit('pres_update', presState);
    // Field-by-field: a genuine pres_update now carries a server-stamped deckId
    // (see bumpPresDeckId) that this hand-built expected object can't predict.
    const echoed = await presEcho;
    assert.equal(echoed.mode, presState.mode);
    assert.equal(echoed.currentIdx, presState.currentIdx);
    assert.equal(echoed.totalSlides, presState.totalSlides);
    assert.deepEqual(echoed.images, presState.images);
    assert.equal(echoed.showing, presState.showing);
    assert.ok(echoed.deckId);

    const clearHideSeen = waitFor(graphics, 'hide_translation');
    const presClearSeen = waitFor(graphics, 'pres_update', {
        predicate: data => data?.mode === 'none' && data?.showing === false
    });
    operator.emit('clear_all');
    await clearHideSeen;
    const clearedPres = await presClearSeen;
    assert.equal(clearedPres.totalSlides, 0);
    assert.equal(workers[1].killed, true);
});

test('translation glossary persists locally and applies exact multilingual corrections', async () => {
    const entries = serverModule.saveTranslationGlossary([
        {
            en: 'Jai Swaminarayan',
            gu: 'જય સ્વામિનારાયણ',
            hi: 'जय स्वामिनारायण',
            notes: 'Greeting'
        },
        {
            en: 'mandir',
            gu: 'મંદિર',
            hi: 'मंदिर'
        }
    ]);

    assert.equal(entries.length, 2);
    assert.equal(path.dirname(serverModule.getTranslationGlossaryPath()), testDataDir);
    assert.equal(fs.existsSync(serverModule.getTranslationGlossaryPath()), true);

    assert.equal(
        serverModule.applyTranslationGlossary('Welcome to જય સ્વામિનારાયણ today', 'en'),
        'Welcome to Jai Swaminarayan today'
    );
    assert.equal(
        serverModule.applyTranslationGlossary('Please visit MANDIR after sabha', 'gu'),
        'Please visit મંદિર after sabha'
    );
    assert.equal(
        serverModule.applyTranslationGlossary('જય સ્વામિનારાયણ', 'en'),
        'Jai Swaminarayan'
    );
    assert.equal(
        serverModule.applyTranslationGlossary('समय पर मंदिर आएं', 'gu'),
        'समय पर મંદિર आएं'
    );
});

test('local AI settings persist locally and validate required user-installed tools', async () => {
    const whisperExe = path.join(testDataDir, 'whisper-cli');
    const whisperModel = path.join(testDataDir, 'ggml-base.bin');
    fs.writeFileSync(whisperExe, 'fake executable');
    fs.chmodSync(whisperExe, 0o755);
    fs.writeFileSync(whisperModel, 'fake model');

    const saved = serverModule.saveLocalAiSettings({
        ollamaBaseUrl: 'http://localhost:11434/',
        ollamaModel: 'gemma3:4b',
        whisperExecutablePath: whisperExe,
        whisperModelPath: whisperModel,
        chunkSeconds: 99
    });

    assert.equal(saved.ollamaBaseUrl, 'http://localhost:11434');
    assert.equal(saved.chunkSeconds, 15);
    assert.equal(path.dirname(serverModule.getLocalAiSettingsPath()), testDataDir);
    assert.equal(serverModule.validateLocalAiSettings(saved).ok, true);

    const invalid = serverModule.validateLocalAiSettings({
        ollamaBaseUrl: 'not-a-url',
        ollamaModel: '',
        whisperExecutablePath: '/missing/whisper',
        whisperModelPath: '/missing/model.bin',
        chunkSeconds: 5
    });
    assert.equal(invalid.ok, false);
    assert.equal(invalid.errors.length, 4);
});

test('starts local AI translation worker and applies glossary to local output', async () => {
    const whisperExe = path.join(testDataDir, 'whisper-cli-local');
    const whisperModel = path.join(testDataDir, 'ggml-local.bin');
    fs.writeFileSync(whisperExe, 'fake executable');
    fs.chmodSync(whisperExe, 0o755);
    fs.writeFileSync(whisperModel, 'fake model');
    serverModule.saveLocalAiSettings({
        ollamaBaseUrl: 'http://localhost:11434',
        ollamaModel: 'gemma3:4b',
        whisperExecutablePath: whisperExe,
        whisperModelPath: whisperModel,
        chunkSeconds: 5
    });
    serverModule.saveTranslationGlossary([
        { en: 'Akshardham', gu: 'અક્ષરધામ', hi: 'अक्षरधाम' }
    ]);

    const workers = [];
    const spawns = [];
    serverModule.setTranslationWorkerFactoryForTests((command, args) => {
        spawns.push({ command, args });
        const worker = new FakeWorker();
        workers.push(worker);
        return worker;
    });

    const operator = await connectClient();
    const graphics = await connectClient();
    const startingSeen = waitFor(graphics, 'translation_status', {
        predicate: data => data?.state === 'starting'
    });
    operator.emit('start_translation', {
        engine: 'local',
        targetLang: 'en',
        sourceLanguages: ['gu-IN']
    });

    await waitUntil(() => workers.length === 1, { message: 'Local translation worker was not spawned' });
    assert.match(spawns[0].args[0], /local_translation_worker\.js$/);
    assert.equal(workers[0].sent[0].config.engine, 'local');
    assert.equal(workers[0].sent[0].config.localAiSettings.ollamaModel, 'gemma3:4b');
    assert.equal((await startingSeen).engine, 'local');

    const listeningSeen = waitFor(graphics, 'translation_status', {
        predicate: data => data?.state === 'listening'
    });
    workers[0].emitWorker('message', { type: 'translation_started' });
    assert.equal((await listeningSeen).engine, 'local');

    const updateSeen = waitFor(graphics, 'translation_update');
    workers[0].emitWorker('message', {
        type: 'translation_update',
        data: { text: 'Welcome to અક્ષરધામ', sourceText: 'અક્ષરધામ', isFinal: true, lang: 'Local AI' }
    });
    const update = await updateSeen;
    assert.equal(update.text, 'Welcome to Akshardham');
    assert.equal(update.engine, 'local');
});

test('starts Soniox translation worker and applies glossary to Soniox output', async () => {
    serverModule.saveTranslationGlossary([
        { en: 'Akshardham', gu: 'અક્ષરધામ', hi: 'अक्षरधाम' }
    ]);

    const workers = [];
    const spawns = [];
    serverModule.setTranslationWorkerFactoryForTests((command, args) => {
        spawns.push({ command, args });
        const worker = new FakeWorker();
        workers.push(worker);
        return worker;
    });

    const operator = await connectClient();
    const graphics = await connectClient();
    const startingSeen = waitFor(graphics, 'translation_status', {
        predicate: data => data?.state === 'starting'
    });

    operator.emit('start_translation', {
        engine: 'soniox',
        key: 'soniox-key',
        targetLang: 'en',
        sourceLanguages: ['gu-IN', 'hi-IN'],
        sonioxModel: 'stt-rt-v4'
    });

    await waitUntil(() => workers.length === 1, { message: 'Soniox translation worker was not spawned' });
    assert.match(spawns[0].args[0], /soniox_translation_worker\.js$/);
    assert.equal(workers[0].sent[0].config.engine, 'soniox');
    assert.equal(workers[0].sent[0].config.sonioxModel, 'stt-rt-v4');
    assert.deepEqual(workers[0].sent[0].config.sonioxTranslationTerms, [
        { source: 'અક્ષરધામ', target: 'Akshardham' },
        { source: 'अक्षरधाम', target: 'Akshardham' }
    ]);
    assert.equal((await startingSeen).engine, 'soniox');

    const listeningSeen = waitFor(graphics, 'translation_status', {
        predicate: data => data?.state === 'listening'
    });
    workers[0].emitWorker('message', { type: 'translation_started' });
    assert.equal((await listeningSeen).engine, 'soniox');

    operator.emit('audio_chunk', Uint8Array.from([4, 5, 6]));
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(workers[0].sent.at(-1).type, 'audio_chunk');

    const updateSeen = waitFor(graphics, 'translation_update');
    workers[0].emitWorker('message', {
        type: 'translation_update',
        data: { text: 'Welcome to અક્ષરધામ', sourceText: 'અક્ષરધામ', isFinal: true, lang: 'en' }
    });
    const update = await updateSeen;
    assert.equal(update.text, 'Welcome to Akshardham');
    assert.equal(update.engine, 'soniox');
});

test('rejects missing Soniox API key without spawning workers', async () => {
    const workers = [];
    serverModule.setTranslationWorkerFactoryForTests(() => {
        const worker = new FakeWorker();
        workers.push(worker);
        return worker;
    });

    const operator = await connectClient();
    const failedSeen = waitFor(operator, 'translation_failed');
    const statusSeen = waitFor(operator, 'translation_status', {
        predicate: data => data?.state === 'error'
    });

    operator.emit('start_translation', {
        engine: 'soniox',
        key: '',
        targetLang: 'gu',
        sourceLanguages: ['en-US']
    });

    assert.match((await failedSeen).error, /soniox api key/i);
    assert.match((await statusSeen).error, /soniox api key/i);
    assert.equal(workers.length, 0);
});

test('manages translation glossary entries over sockets and corrects live updates', async () => {
    const workers = [];
    serverModule.setTranslationWorkerFactoryForTests(() => {
        const worker = new FakeWorker();
        workers.push(worker);
        return worker;
    });

    const operator = await connectClient();
    const graphics = await connectClient();

    const glossaryUpdateSeen = waitFor(operator, 'translation_glossary_update', {
        predicate: entries => entries.length === 1
    });
    const addResult = await emitWithAck(operator, 'translation_glossary_add', {
        en: 'Akshardham',
        gu: 'અક્ષરધામ',
        hi: 'अक्षरधाम',
        notes: 'Place name'
    });
    assert.equal(addResult.ok, true);
    const addedEntries = await glossaryUpdateSeen;
    assert.equal(addedEntries[0].en, 'Akshardham');

    const updatedSeen = waitFor(operator, 'translation_glossary_update', {
        predicate: entries => entries[0]?.notes === 'Temple name'
    });
    const updateResult = await emitWithAck(operator, 'translation_glossary_update_entry', {
        ...addedEntries[0],
        notes: 'Temple name'
    });
    assert.equal(updateResult.ok, true);
    const updatedEntries = await updatedSeen;
    assert.equal(updatedEntries[0].notes, 'Temple name');

    operator.emit('start_translation', {
        key: 'test-key',
        region: 'eastus',
        targetLang: 'en',
        sourceLanguages: ['gu-IN', 'en-US']
    });
    await waitUntil(() => workers.length === 1, { message: 'Translation worker was not spawned' });
    workers[0].emitWorker('message', { type: 'translation_started' });

    const updateSeen = waitFor(graphics, 'translation_update');
    workers[0].emitWorker('message', {
        type: 'translation_update',
        data: { text: 'Welcome to અક્ષરધામ', sourceText: 'અક્ષરધામ', isFinal: true, lang: 'gu' }
    });
    const liveUpdate = await updateSeen;
    assert.equal(liveUpdate.text, 'Welcome to Akshardham');
    assert.equal(liveUpdate.originalText, 'Welcome to અક્ષરધામ');

    const deletedSeen = waitFor(operator, 'translation_glossary_update', {
        predicate: entries => entries.length === 0
    });
    const deleteResult = await emitWithAck(operator, 'translation_glossary_delete', updatedEntries[0].id);
    assert.equal(deleteResult.ok, true);
    assert.deepEqual(await deletedSeen, []);
});

test('rejects invalid translation start payloads without spawning workers', async () => {
    const workers = [];
    serverModule.setTranslationWorkerFactoryForTests(() => {
        const worker = new FakeWorker();
        workers.push(worker);
        return worker;
    });

    const operator = await connectClient();
    const failedSeen = waitFor(operator, 'translation_failed');
    const statusSeen = waitFor(operator, 'translation_status', {
        predicate: data => data?.state === 'error'
    });

    operator.emit('start_translation', {
        key: '',
        region: 'eastus',
        targetLang: 'gu',
        sourceLanguages: ['en-US']
    });

    assert.match((await failedSeen).error, /key/i);
    assert.match((await statusSeen).error, /key/i);
    assert.equal(workers.length, 0);
});

test('keeps only one active translation worker across rapid restart flow', async () => {
    const workers = [];
    serverModule.setTranslationWorkerFactoryForTests(() => {
        const worker = new FakeWorker();
        workers.push(worker);
        return worker;
    });

    const operator = await connectClient();
    operator.emit('start_translation', {
        key: 'test-key',
        region: 'eastus',
        targetLang: 'gu',
        sourceLanguages: ['en-US']
    });
    await waitUntil(() => workers.length === 1, { message: 'First translation worker was not spawned' });

    operator.emit('start_translation', {
        key: 'test-key',
        region: 'eastus',
        targetLang: 'hi',
        sourceLanguages: ['en-US', 'gu-IN']
    });
    await waitUntil(() => workers.length === 2, { message: 'Restart translation worker was not spawned' });

    assert.equal(workers[0].killed, true);
    assert.equal(workers[1].killed, false);

    const idleSeen = waitFor(operator, 'translation_status', {
        predicate: data => data?.state === 'idle'
    });
    operator.emit('stop_translation');
    await idleSeen;
    assert.equal(workers[1].killed, true);
});

test('translation worker failure and cancellation emit final error status', async () => {
    const workers = [];
    serverModule.setTranslationWorkerFactoryForTests(() => {
        const worker = new FakeWorker();
        workers.push(worker);
        return worker;
    });

    const operator = await connectClient();
    const graphics = await connectClient();

    operator.emit('start_translation', {
        key: 'test-key',
        region: 'eastus',
        targetLang: 'gu',
        sourceLanguages: ['en-US']
    });
    await waitUntil(() => workers.length === 1, { message: 'Translation worker was not spawned' });

    const failedSeen = waitFor(operator, 'translation_failed');
    const errorStatusSeen = waitFor(graphics, 'translation_status', {
        predicate: data => data?.state === 'error' && /quota/i.test(data.error || '')
    });
    workers[0].emitWorker('message', { type: 'translation_failed', error: 'Quota exceeded' });
    assert.equal((await failedSeen).error, 'Quota exceeded');
    assert.equal((await errorStatusSeen).state, 'error');
    assert.equal(workers[0].killed, true);

    operator.emit('start_translation', {
        key: 'test-key',
        region: 'eastus',
        targetLang: 'gu',
        sourceLanguages: ['en-US']
    });
    await waitUntil(() => workers.length === 2, { message: 'Second translation worker was not spawned' });

    const canceledSeen = waitFor(graphics, 'translation_canceled');
    const canceledStatusSeen = waitFor(graphics, 'translation_status', {
        predicate: data => data?.state === 'error' && /network/i.test(data.error || '')
    });
    workers[1].emitWorker('message', { type: 'translation_canceled', error: 'Network dropped' });
    assert.equal((await canceledSeen).error, 'Network dropped');
    assert.equal((await canceledStatusSeen).state, 'error');
    assert.equal(workers[1].killed, true);
});

// ---------------------------------------------------------------------------
// Control Pad (/pad)
// ---------------------------------------------------------------------------

// Every new pad handler is (payload, ack). A single-param (ack) handler would bind
// the payload to `ack` and emitWithAck below would hang until the test timeout.

// Enabling remote access rebinds the listener and calls io.disconnectSockets(), so
// any test that needs a surviving local socket must enable it *before* connecting.
// Re-enabling when already enabled is a no-op, so this stays safe to call again.
async function enableRemoteAccess() {
    await serverModule.setRemoteAccessEnabled(true);
}

async function pairedRemote() {
    await enableRemoteAccess();
    const { body } = await pairRemote({ code: serverModule.getRemoteStatus().pairingCode });
    return connectRemote(body.remoteToken);
}

test('the pad route is advertised only while remote access is reachable', async () => {
    assert.deepEqual(serverModule.getRemoteStatus().padUrls, []);

    await serverModule.setRemoteAccessEnabled(true);
    const status = serverModule.getRemoteStatus();
    if (status.activeAddress) {
        assert.equal(status.padUrls.length, 1);
        // The pad must stay one path segment deep or the built HTML's relative
        // "./assets/..." references resolve to the wrong place.
        assert.equal(new URL(status.padUrls[0]).pathname, '/pad');
    }
});

test('remotes cannot publish the pad layout or rundown', async () => {
    const remote = await pairedRemote();

    const forbidden = waitFor(remote, 'action_forbidden');
    const layoutAck = await emitWithAck(remote, 'pad_layout_update', { pages: [{ name: 'Hijack', buttons: [] }] });
    assert.equal(layoutAck.ok, false);
    assert.match((await forbidden).error, /main controller/i);

    const rundownAck = await emitWithAck(remote, 'pad_rundown_update', [{ id: 'x', title: 'Hijack' }]);
    assert.equal(rundownAck.ok, false);

    // Nothing was cached, so a later command finds an empty rundown to check against.
    const local = await connectClient();
    const relayed = waitFor(local, 'pad_command');
    const ack = await emitWithAck(remote, 'pad_command', { type: 'cue_fire', payload: { cueId: 'x' } });
    assert.equal(ack.ok, true, 'an empty cache must not reject cue ids');
    await relayed;
});

test('the pad layout is clamped, cached, broadcast and replayed on connect', async () => {
    const local = await connectClient();
    const broadcast = waitFor(local, 'pad_layout_update');

    const ack = await emitWithAck(local, 'pad_layout_update', {
        pages: Array.from({ length: 20 }, () => ({
            name: 'x'.repeat(200),
            cols: 99,
            buttons: Array.from({ length: 200 }, () => ({
                label: 'y'.repeat(200),
                sub: 'z'.repeat(200),
                action: { kind: 'nonsense', id: 'a'.repeat(200), payload: [1, 2] }
            }))
        }))
    });
    assert.equal(ack.ok, true);

    const layout = await broadcast;
    assert.equal(layout.pages.length, 6);
    assert.equal(layout.pages[0].name.length, 24);
    assert.equal(layout.pages[0].cols, 5);
    assert.equal(layout.pages[0].buttons.length, 48);
    assert.equal(layout.pages[0].buttons[0].label.length, 20);
    assert.equal(layout.pages[0].buttons[0].sub.length, 20);
    assert.equal(layout.pages[0].buttons[0].action.kind, 'none');
    assert.equal(layout.pages[0].buttons[0].action.id.length, 48);
    assert.deepEqual(layout.pages[0].buttons[0].action.payload, {});

    const { waits } = await connectClientWithReplay(['pad_layout_update']);
    assert.deepEqual(await waits.pad_layout_update, layout);
});

test('the pad rundown is trimmed, and entries without an id are dropped', async () => {
    const local = await connectClient();
    const broadcast = waitFor(local, 'pad_rundown_update');

    await emitWithAck(local, 'pad_rundown_update', [
        { id: 'cue-1', title: 't'.repeat(200), status: 'fired', types: ['media', 'lyrics', 'a', 'b', 'c', 'd', 'e'] },
        { id: '', title: 'No id' },
        { title: 'Also no id' },
        { id: 'cue-2', status: 'bogus' },
        ...Array.from({ length: 400 }, (_, i) => ({ id: `bulk-${i}`, title: 'Bulk' }))
    ]);

    const rundown = await broadcast;
    assert.equal(rundown[0].id, 'cue-1');
    assert.equal(rundown[0].title.length, 80);
    assert.equal(rundown[0].status, 'fired');
    assert.equal(rundown[0].types.length, 6);
    assert.equal(rundown[1].id, 'cue-2');
    assert.equal(rundown[1].title, 'Cue');
    assert.equal(rundown[1].status, 'pending');
    // 200 entries are taken first, then the id-less ones dropped — the cap bounds
    // the work done regardless of how much junk was sent.
    assert.equal(rundown.length, 198);
    assert.ok(rundown.every(cue => cue.id), 'entries without an id must be dropped');
    // Cue action payloads carry local file paths and lyric text; they must never
    // reach a tablet.
    assert.ok(rundown.every(cue => !('payload' in cue) && !('actions' in cue)));
});

test('pad_command relays to the main controller only and never echoes to remotes', async () => {
    await enableRemoteAccess();
    const local = await connectClient();
    await emitWithAck(local, 'pad_rundown_update', [{ id: 'cue-1', title: 'Opening', status: 'pending' }]);

    const remote = await pairedRemote();
    const other = await pairedRemote();

    const relayed = waitFor(local, 'pad_command');
    const echoedToSender = waitFor(remote, 'pad_command', { timeout: 250 }).then(() => 'echoed', () => 'silent');
    const echoedToOther = waitFor(other, 'pad_command', { timeout: 250 }).then(() => 'echoed', () => 'silent');

    const ack = await emitWithAck(remote, 'pad_command', { type: 'cue_fire', payload: { cueId: 'cue-1' } });
    assert.equal(ack.ok, true);
    assert.equal(ack.delivered, 1);

    const command = await relayed;
    assert.equal(command.type, 'cue_fire');
    assert.equal(command.payload.cueId, 'cue-1');

    assert.equal(await echoedToSender, 'silent');
    assert.equal(await echoedToOther, 'silent');
});

test('pad_command with no cue id is relayed so the desktop can fire the next pending cue', async () => {
    await enableRemoteAccess();
    const local = await connectClient();
    await emitWithAck(local, 'pad_rundown_update', [{ id: 'cue-1', title: 'Opening' }]);
    const remote = await pairedRemote();

    const relayed = waitFor(local, 'pad_command');
    const ack = await emitWithAck(remote, 'pad_command', { type: 'cue_fire', payload: {} });
    assert.equal(ack.ok, true);
    assert.equal((await relayed).payload.cueId, '');
});

test('pad_command rejects unknown types, unknown statuses and stale cue ids', async () => {
    await enableRemoteAccess();
    const local = await connectClient();
    await emitWithAck(local, 'pad_rundown_update', [{ id: 'cue-1', title: 'Opening' }]);
    const remote = await pairedRemote();

    const never = waitFor(local, 'pad_command', { timeout: 250 }).then(() => 'relayed', () => 'silent');

    assert.match((await emitWithAck(remote, 'pad_command', { type: 'drop_database' })).error, /unknown pad command/i);
    assert.match((await emitWithAck(remote, 'pad_command', {})).error, /unknown pad command/i);
    assert.match(
        (await emitWithAck(remote, 'pad_command', { type: 'cue_status', payload: { cueId: 'cue-1', status: 'exploded' } })).error,
        /unknown cue status/i
    );
    assert.match(
        (await emitWithAck(remote, 'pad_command', { type: 'cue_fire', payload: { cueId: 'cue-deleted' } })).error,
        /no longer exists/i
    );

    assert.equal(await never, 'silent', 'a rejected command must not reach the controller');
});

test('pad_command fails cleanly when the main controller is not connected', async () => {
    const remote = await pairedRemote();
    const ack = await emitWithAck(remote, 'pad_command', { type: 'cue_fire', payload: {} });
    assert.equal(ack.ok, false);
    assert.match(ack.error, /not connected/i);
});

test('every pad emit action targets an event the server actually handles', async () => {
    // The regression net for the stop_media/media_stop class of bug: an action
    // pointing at an outbound broadcast name is a silent no-op at runtime, and
    // this is the only place that failure becomes visible.
    await connectClient();
    const handled = new Set(
        [...serverModule.io.sockets.sockets.values()].flatMap(socket => socket.eventNames())
    );

    const events = new Set();
    for (const def of Object.values(PAD_EMIT_ACTIONS)) {
        if (def.steps) for (const step of def.steps) events.add(step.event);
        else events.add(def.event);
    }
    assert.ok(events.size > 20, 'the action table should cover a real control surface');

    for (const event of events) {
        assert.ok(handled.has(event), `the server has no handler for "${event}"`);
    }
});

test('a remote can drive the pad control surface end to end', async () => {
    await enableRemoteAccess();
    const local = await connectClient();
    const remote = await pairedRemote();

    // Layer mute.
    const layers = waitFor(local, 'layer_visibility_update');
    remote.emit('layer_visibility_update', { lyrics: false });
    assert.equal((await layers).lyrics, false);

    // Slide navigation, server-authoritative.
    local.emit('pres_update', {
        mode: 'url', baseUrl: 'https://example.test/slide=', slideId: 'deck',
        currentIdx: 0, totalSlides: 3, images: [], isCanva: false, showing: false
    });
    const meta = waitFor(remote, 'pres_meta', { predicate: data => data.currentIdx === 1 });
    remote.emit('pres_goto', { direction: 'next' });
    assert.equal((await meta).currentIdx, 1);

    // Slides live toggle.
    const showing = waitFor(remote, 'pres_meta', { predicate: data => data.showing === true });
    remote.emit('pres_set_showing', true);
    assert.equal((await showing).showing, true);

    // Media transport reaches the graphics layer.
    const seek = waitFor(local, 'media_seek');
    remote.emit('media_seek', 42);
    assert.equal(await seek, 42);

    // Show safety.
    const cleared = waitFor(local, 'pres_update', { predicate: data => data.mode === 'none' });
    remote.emit('clear_all');
    assert.equal((await cleared).mode, 'none');
});
