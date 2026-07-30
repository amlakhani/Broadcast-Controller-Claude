// NovaStar H Series (H2/H5/H9) LED-wall processor connection + control.
//
// Class shape mirrors VideohubService/AtemService: getStatus/getPublicStatus/
// emitStatus, a monotonic sessionId guarding every async continuation, and
// backoff+jitter reconnect. Unlike those two, the transport here is HTTP
// POST + JSON (NovaStar's "H Series OpenAPI"), not a persistent TCP socket —
// there is no connection to keep alive, so "connected" is re-verified with a
// periodic liveness poll (see startLivenessPoll) instead of a socket 'close'
// event, and "connect" itself is just the first successful poll.

import {
    DEFAULT_NOVASTAR_PORT,
    buildSignedRequest,
    buildScreenListBody,
    buildDeviceDetailBody,
    buildScreenFtbBody,
    buildFreezeBody,
    buildBrightnessBody,
    buildPresetListBody,
    buildPresetPlayBody,
    buildTextOsdBody,
    buildImageOsdBody,
    isSuccessResponse,
    responseErrorMessage,
    parseScreenListResponse,
    parsePresetListResponse,
    parseDeviceDetailResponse,
} from './novastar_protocol.js';

export { DEFAULT_NOVASTAR_PORT };

// Re-verifies liveness on a healthy connection — there's no TCP keepalive to
// lean on, so this is the HTTP-world equivalent. A read-only call, cheap
// enough to run this often on a LAN device.
const POLL_INTERVAL_MS = 20000;
const REQUEST_TIMEOUT_MS = 5000;

const BACKOFF_MS = [1000, 2000, 4000, 8000, 15000, 30000];
const jitter = (ms) => Math.round(ms * (0.8 + Math.random() * 0.4));

const DEFAULT_STATUS = {
    configured: false,
    address: '',
    port: DEFAULT_NOVASTAR_PORT,
    connectionState: 'idle', // idle | connecting | connected | reconnecting | error
    connectedAt: null,
    error: null,
    device: { name: null, status: null, temperature: null },
    screens: [], // [{ screenId, name }]
    selectedScreenId: null,
    presets: [], // [{ presetId, name }]
    blackout: false,
    frozen: false,
    brightness: null,
};

export class NovaStarService {
    constructor({ onStatus, fetchImpl, pollIntervalMs } = {}) {
        this.onStatus = onStatus;
        // Injected for tests, mirrors createSocket/createAtem's convention.
        this.fetchImpl = fetchImpl || fetch;
        this.pollIntervalMs = pollIntervalMs || POLL_INTERVAL_MS;

        this.address = '';
        this.port = DEFAULT_NOVASTAR_PORT;
        this.pId = '';
        this.secretKey = '';

        this.sessionId = 0;
        this.status = { ...DEFAULT_STATUS, device: { ...DEFAULT_STATUS.device }, screens: [], presets: [] };

        this.explicitDisconnect = false;
        this.backoffIndex = 0;
        this.reconnectTimer = null;
        this.pollTimer = null;
    }

    getStatus() {
        return {
            ...this.status,
            device: { ...this.status.device },
            screens: this.status.screens.map(s => ({ ...s })),
            presets: this.status.presets.map(p => ({ ...p })),
        };
    }

    // Remote-paired clients get connection state and model only — never the
    // LAN address, credentials, or the venue's screen/preset topology.
    getPublicStatus() {
        return { connectionState: this.status.connectionState, device: { name: this.status.device.name } };
    }

    emitStatus(patch = {}) {
        this.status = { ...this.status, ...patch, device: { ...this.status.device, ...(patch.device || {}) } };
        this.onStatus?.(this.getStatus());
    }

    // --- Transport ------------------------------------------------------------

    async _post(path, body, { address = this.address, port = this.port, pId = this.pId, secretKey = this.secretKey } = {}) {
        try {
            const signed = buildSignedRequest({ pId, secretKey, body });
            const response = await this.fetchImpl(`http://${address}:${port}${path}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(signed),
                signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            });
            if (!response.ok) {
                return { ok: false, error: `NovaStar returned HTTP ${response.status}.` };
            }
            const json = await response.json();
            if (!isSuccessResponse(json)) {
                return { ok: false, error: responseErrorMessage(json) };
            }
            return { ok: true, json };
        } catch (err) {
            return { ok: false, error: err?.message || String(err) };
        }
    }

    // A pre-flight check against whatever credentials are currently in the
    // settings form, without committing to a connection or touching
    // this.address/pId/secretKey/status. Mirrors local_ai_test's role for
    // the other HTTP-based integration in this app.
    //
    // Uses screen/readList, not device/readDetail, as the reachability
    // probe — confirmed against real H5 hardware that the entire "Devices"
    // category (readDetail, readIP) can 500 ("Server_Err") even with fully
    // valid credentials and a working connection, while "Screen"/"Presets"
    // endpoints work fine. screen/readList also happens to be required
    // functionality anyway (populating the screen picker), so probing with
    // it isn't wasted work the way a readDetail-only probe would be.
    async testConnection({ address, port = DEFAULT_NOVASTAR_PORT, pId, secretKey, deviceId = 0 } = {}) {
        if (!address || typeof address !== 'string') {
            return { ok: false, error: 'Enter the NovaStar processor IP address.' };
        }
        if (!pId || typeof pId !== 'string') {
            return { ok: false, error: 'Enter the OpenAPI Requestor ID (pId).' };
        }
        const result = await this._post('/open/api/screen/readList', buildScreenListBody({ deviceId }), { address, port, pId, secretKey });
        if (!result.ok) return result;
        return { ok: true, screens: parseScreenListResponse(result.json) };
    }

    async connect({ address, port = DEFAULT_NOVASTAR_PORT, pId, secretKey, deviceId = 0 } = {}) {
        if (!address || typeof address !== 'string') {
            this.emitStatus({ connectionState: 'error', error: 'Enter the NovaStar processor IP address.' });
            return this.getStatus();
        }
        if (!pId || typeof pId !== 'string') {
            this.emitStatus({ connectionState: 'error', error: 'Enter the OpenAPI Requestor ID (pId).' });
            return this.getStatus();
        }

        await this.disconnect({ silent: true });

        this.explicitDisconnect = false;
        const session = ++this.sessionId;
        this.address = address;
        this.port = port;
        this.pId = pId;
        this.secretKey = secretKey || '';
        this.deviceId = deviceId;
        this.emitStatus({ configured: true, address, port, connectionState: 'connecting', error: null });

        // screen/readList is the reachability/auth probe (see testConnection's
        // comment for why device/readDetail can't be relied on here).
        const screensResult = await this._post('/open/api/screen/readList', buildScreenListBody({ deviceId }));
        if (session !== this.sessionId) return this.getStatus();

        if (!screensResult.ok) {
            this.emitStatus({ connectionState: 'error', error: screensResult.error });
            this.scheduleReconnect(session);
            return this.getStatus();
        }

        this.backoffIndex = 0;
        this.clearTimer('reconnectTimer');
        const screens = parseScreenListResponse(screensResult.json);
        this.emitStatus({
            connectionState: 'connected',
            connectedAt: Date.now(),
            error: null,
            screens,
            selectedScreenId: this.status.selectedScreenId ?? screens[0]?.screenId ?? null,
        });

        // Best-effort only: device/readDetail is purely cosmetic info (model
        // name/temperature) on top of an already-established connection, so
        // its failure — including the "Devices" category outage seen on some
        // firmware — must never downgrade connectionState or block connect().
        const detail = await this._post('/open/api/device/readDetail', buildDeviceDetailBody({ deviceId }));
        if (session === this.sessionId && detail.ok) {
            this.emitStatus({ device: parseDeviceDetailResponse(detail.json) });
        }

        this.startLivenessPoll(session);
        return this.getStatus();
    }

    startLivenessPoll(session) {
        this.clearTimer('pollTimer');
        this.pollTimer = setTimeout(async () => {
            if (session !== this.sessionId || this.explicitDisconnect) return;
            // Same reasoning as connect(): screen/readList, not
            // device/readDetail, is the liveness signal.
            const result = await this._post('/open/api/screen/readList', buildScreenListBody({ deviceId: this.deviceId }));
            if (session !== this.sessionId || this.explicitDisconnect) return;
            if (!result.ok) {
                this.emitStatus({ connectionState: 'reconnecting', error: result.error });
                this.scheduleReconnect(session);
                return;
            }
            this.emitStatus({ connectionState: 'connected', error: null, screens: parseScreenListResponse(result.json) });
            this.startLivenessPoll(session);
        }, this.pollIntervalMs);
    }

    scheduleReconnect(session) {
        if (this.explicitDisconnect || session !== this.sessionId) return;
        const delay = jitter(BACKOFF_MS[Math.min(this.backoffIndex, BACKOFF_MS.length - 1)]);
        this.backoffIndex += 1;
        this.clearTimer('reconnectTimer');
        this.reconnectTimer = setTimeout(() => this.rebuild(session), delay);
    }

    rebuild(session) {
        if (session !== this.sessionId || this.explicitDisconnect) return;
        this.connect({ address: this.address, port: this.port, pId: this.pId, secretKey: this.secretKey, deviceId: this.deviceId });
    }

    clearTimer(name) {
        if (this[name]) {
            clearTimeout(this[name]);
            this[name] = null;
        }
    }

    async disconnect({ silent = false } = {}) {
        this.explicitDisconnect = true;
        this.sessionId += 1;
        this.clearTimer('reconnectTimer');
        this.clearTimer('pollTimer');

        if (!silent) {
            this.emitStatus({
                connectionState: 'idle',
                connectedAt: null,
                error: null,
                device: { ...DEFAULT_STATUS.device },
                screens: [],
                presets: [],
                blackout: false,
                frozen: false,
                brightness: null,
            });
        }
        return this.getStatus();
    }

    // --- Commands ---------------------------------------------------------
    // Every command needs a screenId; falls back to the currently selected
    // screen so callers don't have to thread it through when there's only
    // one screen on the wall.

    _resolveScreenId(screenId) {
        return screenId ?? this.status.selectedScreenId ?? null;
    }

    selectScreen(screenId) {
        this.emitStatus({ selectedScreenId: screenId ?? null });
        return { ok: true };
    }

    async readScreens(deviceId = this.deviceId ?? 0) {
        if (this.status.connectionState !== 'connected') return { ok: false, error: 'Not connected.' };
        const result = await this._post('/open/api/screen/readList', buildScreenListBody({ deviceId }));
        if (!result.ok) return result;
        const screens = parseScreenListResponse(result.json);
        this.emitStatus({ screens, selectedScreenId: this.status.selectedScreenId ?? screens[0]?.screenId ?? null });
        return { ok: true, screens };
    }

    async setBlackout({ type, time = 0, screenId, deviceId = this.deviceId ?? 0 } = {}) {
        if (this.status.connectionState !== 'connected') return { ok: false, error: 'Not connected.' };
        const targetScreenId = this._resolveScreenId(screenId);
        if (targetScreenId == null) return { ok: false, error: 'Select a screen first.' };
        const result = await this._post('/open/api/screen/ftb', buildScreenFtbBody({ screenId: targetScreenId, deviceId, type, time }));
        if (result.ok) this.emitStatus({ blackout: type === 0 });
        return result;
    }

    async setFreeze({ enable, screenId, deviceId = this.deviceId ?? 0 } = {}) {
        if (this.status.connectionState !== 'connected') return { ok: false, error: 'Not connected.' };
        const targetScreenId = this._resolveScreenId(screenId);
        if (targetScreenId == null) return { ok: false, error: 'Select a screen first.' };
        const result = await this._post('/open/api/screen/writeFreeze', buildFreezeBody({ screenId: targetScreenId, deviceId, enable }));
        if (result.ok) this.emitStatus({ frozen: !!enable });
        return result;
    }

    async setBrightness({ brightness, screenId, deviceId = this.deviceId ?? 0 } = {}) {
        if (this.status.connectionState !== 'connected') return { ok: false, error: 'Not connected.' };
        const targetScreenId = this._resolveScreenId(screenId);
        if (targetScreenId == null) return { ok: false, error: 'Select a screen first.' };
        const result = await this._post('/open/api/screen/writeBrightness', buildBrightnessBody({ screenId: targetScreenId, deviceId, brightness }));
        if (result.ok) this.emitStatus({ brightness });
        return result;
    }

    async saveBrightness({ brightness, screenId, deviceId = this.deviceId ?? 0 } = {}) {
        if (this.status.connectionState !== 'connected') return { ok: false, error: 'Not connected.' };
        const targetScreenId = this._resolveScreenId(screenId);
        if (targetScreenId == null) return { ok: false, error: 'Select a screen first.' };
        const result = await this._post('/open/api/screen/saveBrightness', buildBrightnessBody({ screenId: targetScreenId, deviceId, brightness }));
        if (result.ok) this.emitStatus({ brightness });
        return result;
    }

    async readPresets({ screenId, deviceId = this.deviceId ?? 0 } = {}) {
        if (this.status.connectionState !== 'connected') return { ok: false, error: 'Not connected.' };
        const targetScreenId = this._resolveScreenId(screenId);
        if (targetScreenId == null) return { ok: false, error: 'Select a screen first.' };
        const result = await this._post('/open/api/preset/readList', buildPresetListBody({ screenId: targetScreenId, deviceId }));
        if (!result.ok) return result;
        const presets = parsePresetListResponse(result.json);
        this.emitStatus({ presets });
        return { ok: true, presets };
    }

    async playPreset({ presetId, screenId, deviceId = this.deviceId ?? 0 } = {}) {
        if (this.status.connectionState !== 'connected') return { ok: false, error: 'Not connected.' };
        const targetScreenId = this._resolveScreenId(screenId);
        if (targetScreenId == null) return { ok: false, error: 'Select a screen first.' };
        return this._post('/open/api/preset/play', buildPresetPlayBody({ screenId: targetScreenId, deviceId, presetId }));
    }

    async setTextOsd(payload = {}) {
        if (this.status.connectionState !== 'connected') return { ok: false, error: 'Not connected.' };
        const targetScreenId = this._resolveScreenId(payload.screenId);
        if (targetScreenId == null) return { ok: false, error: 'Select a screen first.' };
        const deviceId = payload.deviceId ?? this.deviceId ?? 0;
        return this._post('/open/api/screen/writeOSD', buildTextOsdBody({ ...payload, screenId: targetScreenId, deviceId }));
    }

    async setImageOsd(payload = {}) {
        if (this.status.connectionState !== 'connected') return { ok: false, error: 'Not connected.' };
        const targetScreenId = this._resolveScreenId(payload.screenId);
        if (targetScreenId == null) return { ok: false, error: 'Select a screen first.' };
        const deviceId = payload.deviceId ?? this.deviceId ?? 0;
        return this._post('/open/api/screen/writeImageOSD', buildImageOsdBody({ ...payload, screenId: targetScreenId, deviceId }));
    }
}
