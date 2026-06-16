import assert from 'node:assert/strict';
import { after, afterEach, before, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { io as createClient } from '../frontend/node_modules/socket.io-client/build/esm/index.js';

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
    serverModule.resetServerStateForTests();
    serverModule.saveTranslationGlossary([]);
    serverModule.saveLocalAiSettings({
        ollamaBaseUrl: 'http://localhost:11434',
        ollamaModel: '',
        whisperExecutablePath: '',
        whisperModelPath: '',
        chunkSeconds: 5
    });
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

test('replays cached presentation, output mode, and layer visibility to new clients', async () => {
    const operator = await connectClient();

    const presState = { mode: 'images', currentIdx: 2, totalSlides: 5, images: ['a', 'b', 'c'], showing: true };
    const presEcho = waitFor(operator, 'pres_update');
    operator.emit('pres_update', presState);
    assert.deepEqual(await presEcho, presState);

    const hiddenPresState = { ...presState, showing: false };
    const hiddenPresEcho = waitFor(operator, 'pres_update', {
        predicate: data => data?.showing === false
    });
    operator.emit('pres_update', hiddenPresState);
    assert.deepEqual(await hiddenPresEcho, hiddenPresState);

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
    assert.deepEqual(await clearedPresEcho, clearedPresState);

    const outputEcho = waitFor(operator, 'output_mode_update', {
        predicate: data => data?.backgroundMode === 'transparent'
    });
    operator.emit('output_mode_update', { backgroundMode: 'transparent' });
    assert.deepEqual(await outputEcho, { backgroundMode: 'transparent' });

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

    assert.deepEqual(await replay.waits.pres_update, clearedPresState);
    assert.deepEqual(await replay.waits.output_mode_update, { backgroundMode: 'transparent' });
    const replayedLayers = await replay.waits.layer_visibility_update;
    assert.equal(replayedLayers.media, false);
    assert.equal(replayedLayers.lyrics, false);
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
    assert.deepEqual(await presEcho, presState);

    const replaySeen = waitFor(stage, 'pres_update', {
        predicate: data => data?.currentIdx === 4
    });
    stage.emit('request_stage_state');
    assert.deepEqual(await replaySeen, presState);
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
    assert.deepEqual(await presEcho, presState);

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
