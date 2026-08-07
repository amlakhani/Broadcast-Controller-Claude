// Blackmagic ATEM connection + SuperSource push.
//
// Deliberately does NOT import 'electron' (unlike ndi_output_service.js) — that is
// what keeps this file loadable under bare `node --test`, so the coalescer and the
// reconnect logic can be tested without a switcher or an Electron runtime.
//
// Class shape mirrors NdiOutputService: getStatus/emitStatus plus a monotonic
// sessionId guarding every async continuation, because a disconnect landing
// mid-await must not emit stale status.

import { createRequire } from 'module';

const require = createRequire(import.meta.url);

export const DEFAULT_ATEM_PORT = 9910;

// 25 Hz ceiling on commands to the device. ATEM commands are UDP behind an ack
// window and atem-connection queues them through p-queue, so a flood becomes
// unbounded LATENCY, not an error — the switcher just trails the drag by seconds.
const FLUSH_INTERVAL_MS = 40;

// stateChanged fires constantly (tally, clock), so status emission is throttled
// and only paths we actually surface mark the state dirty.
const STATUS_INTERVAL_MS = 250;
const STATUS_PATHS = [
    /^info/,
    /^inputs/,
    /^video\.superSources/,
    /^video\.mixEffects/,
    /^video\.downstreamKeyers/,
    /^video\.auxilliaries/, // library's own (mis-)spelling — see readDeviceState
];

// Applies to initial connect rejection and watchdog rebuilds only. atem-connection
// retries internally, so stacking a second loop on top produces duplicate sockets.
const BACKOFF_MS = [1000, 2000, 4000, 8000, 15000, 30000];
const WATCHDOG_MS = 30000;

const DEFAULT_STATUS = {
    configured: false,
    address: '',
    port: DEFAULT_ATEM_PORT,
    connectionState: 'idle', // idle | connecting | connected | reconnecting | error
    connectedAt: null,
    error: null,
    device: {
        model: null,
        productName: null,
        apiVersion: null,
        hasSuperSource: false,
        superSourceCount: 0,
        boxCounts: [],
        meCount: 0,
        auxCount: 0,
        dskCount: 0,
        keyCounts: [], // upstream keyer count per M/E, index-matched to mixEffects
    },
    inputs: [],
    auxSources: [], // like `inputs`, but filtered for Aux-bus availability, not SuperSource-box
    armed: false,
    lastPushAt: null,
    lastPushError: null,
    lastPushRoundTripMs: null,
    mixEffects: [],
    downstreamKeyers: [],
    auxiliaries: [], // source id per aux bus, index = bus number
    auxBusNames: [], // the device's own (renameable) name per aux bus, index = bus number
};

const jitter = (ms) => Math.round(ms * (0.8 + Math.random() * 0.4));

export class AtemService {
    constructor({ onStatus, createAtem } = {}) {
        this.onStatus = onStatus;
        // Injected for tests, following the setTranslationWorkerFactoryForTests
        // convention in server.js.
        this.createAtem = createAtem || null;

        this.atem = null;
        this.sessionId = 0;
        this.status = { ...DEFAULT_STATUS, device: { ...DEFAULT_STATUS.device } };

        this.explicitDisconnect = false;
        this.backoffIndex = 0;
        this.reconnectTimer = null;
        this.watchdogTimer = null;

        this.statusTimer = null;
        this.statusDirty = false;

        // Coalescer: pending box patches keyed `${ssrcId}:${boxIndex}`.
        this.pending = new Map();
        this.flushTimer = null;
        this.isFlushing = false;
        this.lastSent = new Map();
        this.pushSentAt = null;

        // Trailing-edge coalescer for push telemetry (see queuePushStatus).
        this.pushStatusTimer = null;
        this.pendingPushStatus = null;
    }

    getStatus() {
        return {
            ...this.status,
            device: { ...this.status.device },
            inputs: [...this.status.inputs],
            auxSources: [...this.status.auxSources],
            mixEffects: this.status.mixEffects.map(me => (me ? {
                ...me,
                upstreamKeyers: me.upstreamKeyers.map(k => (k ? { ...k } : null)),
            } : null)),
            downstreamKeyers: this.status.downstreamKeyers.map(dsk => (dsk ? { ...dsk } : null)),
            auxiliaries: [...this.status.auxiliaries],
            auxBusNames: [...this.status.auxBusNames],
        };
    }

    // Remote-paired clients get the connection state and model only — never the
    // LAN address of production hardware or the full input list.
    getPublicStatus() {
        return {
            connectionState: this.status.connectionState,
            armed: this.status.armed,
            device: { model: this.status.device.model, hasSuperSource: this.status.device.hasSuperSource },
        };
    }

    emitStatus(patch = {}) {
        this.status = { ...this.status, ...patch, device: { ...this.status.device, ...(patch.device || {}) } };
        this.onStatus?.(this.getStatus());
    }

    // Coalesces high-frequency push telemetry onto a trailing edge. The newest patch wins;
    // intermediate ones during a drag carry no information the previous one didn't.
    queuePushStatus(patch) {
        this.pendingPushStatus = { ...(this.pendingPushStatus || {}), ...patch };
        if (this.pushStatusTimer) return;
        this.pushStatusTimer = setTimeout(() => {
            this.pushStatusTimer = null;
            const pending = this.pendingPushStatus;
            this.pendingPushStatus = null;
            if (pending) this.emitStatus(pending);
        }, STATUS_INTERVAL_MS);
    }

    clearPushStatusTimer() {
        if (this.pushStatusTimer) {
            clearTimeout(this.pushStatusTimer);
            this.pushStatusTimer = null;
        }
        this.pendingPushStatus = null;
    }

    loadAtemModule() {
        // Lazy + CJS-in-ESM via createRequire, exactly as ndi_output_service.js does
        // for grandiose, so a missing native prebuild degrades to "ATEM unavailable"
        // instead of killing app boot.
        if (!this._atemModule) this._atemModule = require('atem-connection');
        return this._atemModule;
    }

    setArmed(armed) {
        this.emitStatus({ armed: !!armed });
        // Arming may follow a long stretch of unpushed edits; forget what we think
        // the switcher last saw so the next push sends every field, not just deltas.
        if (armed) this.lastSent.clear();
    }

    async connect({ address, port = DEFAULT_ATEM_PORT } = {}) {
        if (!address || typeof address !== 'string') {
            this.emitStatus({ connectionState: 'error', error: 'Enter the switcher IP address.' });
            return this.getStatus();
        }

        await this.disconnect({ silent: true });

        this.explicitDisconnect = false;
        const session = ++this.sessionId;
        this.emitStatus({ configured: true, address, port, connectionState: 'connecting', error: null });

        let atem;
        try {
            // disableMultithreaded: threadedclass forks a child process for the UDP
            // socket, and forking a file from inside asar is a known Electron failure.
            // Packet volume here is ~2 kB/s, so threading buys nothing anyway.
            const options = { disableMultithreaded: true };
            if (this.createAtem) {
                atem = this.createAtem(options);
            } else {
                const { Atem } = this.loadAtemModule();
                atem = new Atem(options);
            }
        } catch (err) {
            this.emitStatus({ connectionState: 'error', error: `ATEM support unavailable: ${err.message}` });
            return this.getStatus();
        }

        if (session !== this.sessionId) return this.getStatus();
        this.atem = atem;
        this.wireEvents(atem, session);

        try {
            await atem.connect(address, port);
            if (session !== this.sessionId) return this.getStatus();
            this.backoffIndex = 0;
        } catch (err) {
            if (session !== this.sessionId) return this.getStatus();
            this.emitStatus({ connectionState: 'error', error: err?.message || String(err) });
            this.scheduleReconnect(session);
        }
        return this.getStatus();
    }

    wireEvents(atem, session) {
        const guard = (fn) => (...args) => {
            if (session !== this.sessionId) return;
            fn(...args);
        };

        atem.on('connected', guard(() => {
            this.backoffIndex = 0;
            this.clearTimer('reconnectTimer');
            this.clearTimer('watchdogTimer');
            this.emitStatus({ connectionState: 'connected', connectedAt: Date.now(), error: null });
            this.readDeviceState();
            // The device may have power-cycled or been reconfigured while we were
            // down, so our record of "what it last saw" is not trustworthy anymore —
            // forget it so the next push sends every field instead of just deltas.
            this.lastSent.clear();
        }));

        atem.on('disconnected', guard(() => {
            this.emitStatus({ connectionState: 'reconnecting', connectedAt: null });
            // atem-connection is already retrying. Only rebuild the instance if it
            // is still down when the watchdog fires.
            this.clearTimer('watchdogTimer');
            this.watchdogTimer = setTimeout(() => {
                if (session === this.sessionId && this.status.connectionState !== 'connected') {
                    this.rebuild(session);
                }
            }, WATCHDOG_MS);
        }));

        atem.on('error', guard((err) => {
            this.emitStatus({ error: typeof err === 'string' ? err : err?.message || 'ATEM error' });
        }));

        atem.on('stateChanged', guard((state, paths) => {
            const list = Array.isArray(paths) ? paths : [paths];
            if (!list.some(path => STATUS_PATHS.some(re => re.test(String(path))))) return;
            this.statusDirty = true;
            if (this.statusTimer) return;
            this.statusTimer = setTimeout(() => {
                this.statusTimer = null;
                if (!this.statusDirty || session !== this.sessionId) return;
                this.statusDirty = false;
                this.readDeviceState();
            }, STATUS_INTERVAL_MS);
        }));
    }

    // Capabilities come off the device, never inferred from the model number.
    // Zero SuperSources is a first-class state, not an error — most ATEM Minis,
    // TVS HD and 1 M/E units have none.
    readDeviceState() {
        const state = this.atem?.state;
        if (!state) return;

        const superSourceCount = state.info?.capabilities?.superSources
            ?? (Array.isArray(state.info?.superSources) ? state.info.superSources.length : 0);
        const boxCounts = (state.info?.superSources || []).map(ssrc => ssrc?.boxCount ?? 4);

        const meCount = state.info?.capabilities?.mixEffects
            ?? (Array.isArray(state.info?.mixEffects) ? state.info.mixEffects.length : 0);
        const auxCount = state.info?.capabilities?.auxilliaries ?? 0; // library's own spelling
        const dskCount = state.info?.capabilities?.downstreamKeyers ?? 0;
        const keyCounts = (state.info?.mixEffects || []).map(me => me?.keyCount ?? 0);

        const Enums = this._atemModule?.Enums;
        const boxAvailability = Enums?.SourceAvailability?.SuperSourceBox;
        const inputs = Object.entries(state.inputs || {})
            .filter(([, input]) => input && (
                // Filter to sources the device will actually accept in a box; if the
                // enum is missing for any reason, list everything and let it reject.
                boxAvailability === undefined || (input.sourceAvailability & boxAvailability) !== 0
            ))
            .map(([id, input]) => ({
                id: Number(id),
                longName: input.longName || '',
                shortName: input.shortName || '',
            }))
            .sort((a, b) => a.id - b.id);

        // Separate list for the Aux/router UI: an Aux bus can route ME outputs,
        // monitor feeds, etc. that aren't valid SuperSource box sources (and so
        // are missing from `inputs` above) — those would otherwise fall back to
        // an unlabeled "Input <id>" in the router. Different availability flag,
        // same "list everything if the enum is missing" fallback as `inputs`.
        const auxAvailability = Enums?.SourceAvailability?.Auxiliary;
        const auxSources = Object.entries(state.inputs || {})
            .filter(([, input]) => input && (
                auxAvailability === undefined || (input.sourceAvailability & auxAvailability) !== 0
            ))
            .map(([id, input]) => ({
                id: Number(id),
                longName: input.longName || '',
                shortName: input.shortName || '',
            }))
            .sort((a, b) => a.id - b.id);

        const mixEffects = (state.video?.mixEffects || []).map((me, index) => (me ? {
            index,
            programInput: me.programInput,
            previewInput: me.previewInput,
            transitionPreview: me.transitionPreview,
            fadeToBlack: me.fadeToBlack ? { ...me.fadeToBlack } : null,
            transitionPosition: me.transitionPosition ? { ...me.transitionPosition } : null,
            transitionProperties: me.transitionProperties ? { ...me.transitionProperties } : null,
            transitionSettings: me.transitionSettings ? { ...me.transitionSettings } : null,
            upstreamKeyers: (me.upstreamKeyers || []).map(k => (k ? { ...k } : null)),
        } : null));

        const downstreamKeyers = (state.video?.downstreamKeyers || []).map((dsk, index) => (dsk ? {
            index,
            onAir: dsk.onAir,
            isAuto: dsk.isAuto,
            inTransition: dsk.inTransition,
            remainingFrames: dsk.remainingFrames,
            sources: dsk.sources ? { ...dsk.sources } : null,
            properties: dsk.properties ? {
                ...dsk.properties,
                mask: dsk.properties.mask ? { ...dsk.properties.mask } : null,
            } : null,
        } : null));

        // state.video.auxilliaries — the library spells it with a double L; our own
        // status field (auxiliaries, single L) is the sane spelling everywhere else.
        const auxiliaries = [...(state.video?.auxilliaries || [])];

        // Each Aux bus is ALSO exposed as a routable source (so one Aux's output can
        // feed another bus), tagged with internalPortType === Auxiliary — that source
        // entry's longName/shortName is the actual, renameable name the operator sees
        // and edits in ATEM Software Control, e.g. "Confidence Monitor" instead of a
        // generic "AUX 3". Matched to bus index by ascending source id, since nothing
        // in the protocol cross-references "bus N" to "source id" more directly than that.
        // Unlike `inputs`/`auxSources` above, an undefined enum means "name nothing" —
        // guessing wrong here would show a misleading name, whereas a generic "AUX N"
        // fallback (handled in the UI) is never wrong.
        const auxPortType = Enums?.InternalPortType?.Auxiliary;
        const auxBusNames = auxPortType === undefined ? [] : Object.entries(state.inputs || {})
            .filter(([, input]) => input && input.internalPortType === auxPortType)
            .map(([id, input]) => ({ id: Number(id), name: input.longName || input.shortName || null }))
            .sort((a, b) => a.id - b.id)
            .map(entry => entry.name);

        this.emitStatus({
            inputs,
            auxSources,
            mixEffects,
            downstreamKeyers,
            auxiliaries,
            auxBusNames,
            device: {
                model: state.info?.model ?? null,
                productName: state.info?.productIdentifier ?? null,
                apiVersion: state.info?.apiVersion ?? null,
                superSourceCount,
                hasSuperSource: superSourceCount > 0,
                boxCounts,
                meCount,
                auxCount,
                dskCount,
                keyCounts,
            },
        });
    }

    rebuild(session) {
        if (session !== this.sessionId || this.explicitDisconnect) return;
        const { address, port } = this.status;
        // connect() catches internally today, so this is currently safe — the explicit catch is
        // here so that staying safe does not depend on that remaining true.
        this.connect({ address, port }).catch((err) => {
            console.error('ATEM rebuild failed:', err);
        });
    }

    scheduleReconnect(session) {
        if (this.explicitDisconnect || session !== this.sessionId) return;
        const delay = jitter(BACKOFF_MS[Math.min(this.backoffIndex, BACKOFF_MS.length - 1)]);
        this.backoffIndex += 1;
        this.clearTimer('reconnectTimer');
        this.reconnectTimer = setTimeout(() => this.rebuild(session), delay);
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
        this.clearTimer('watchdogTimer');
        this.clearTimer('flushTimer');
        this.clearTimer('statusTimer');
        this.clearPushStatusTimer();
        this.pending.clear();
        this.lastSent.clear();

        const atem = this.atem;
        this.atem = null;
        if (atem) {
            try {
                await atem.disconnect();
            } catch {
                // A switcher that already went away is not an error worth surfacing.
            }
            atem.removeAllListeners?.();
        }

        if (!silent) {
            this.emitStatus({
                connectionState: 'idle',
                connectedAt: null,
                error: null,
                inputs: [],
                auxSources: [],
                mixEffects: [],
                downstreamKeyers: [],
                auxiliaries: [],
                auxBusNames: [],
                device: { ...DEFAULT_STATUS.device },
            });
        }
        return this.getStatus();
    }

    // --- Push -------------------------------------------------------------

    // `patches` is the output of diffBoxesForAtem: [{ boxIndex, props }].
    // Queued, never sent inline — see FLUSH_INTERVAL_MS.
    pushBoxes(patches = [], ssrcId = 0) {
        if (!this.status.armed) return { ok: false, error: 'Push to ATEM is not armed.' };
        if (this.status.connectionState !== 'connected') {
            // Dropped, not queued: replaying a minute of drag history on reconnect
            // would be worse than losing it. lastSent is cleared on 'connected', so
            // whatever the caller pushes next goes out in full rather than as a diff.
            return { ok: false, error: 'Not connected.' };
        }

        const boxCount = this.status.device.boxCounts[ssrcId] ?? 4;
        for (const patch of patches) {
            // Range-check both ends. An upper-bound-only check let a negative (or non-integer)
            // index through and fabricate pending keys the switcher never has.
            const boxIndex = Number(patch?.boxIndex);
            if (!Number.isInteger(boxIndex) || boxIndex < 0 || boxIndex >= boxCount) continue;
            if (!patch.props || typeof patch.props !== 'object' || Array.isArray(patch.props)) continue;
            const key = `${ssrcId}:${boxIndex}`;
            this.pending.set(key, { ...(this.pending.get(key) || {}), ...patch.props });
        }

        if (this.pending.size > 0 && !this.flushTimer) {
            this.flushTimer = setTimeout(() => this.flush(), FLUSH_INTERVAL_MS);
        }
        return { ok: true, queued: this.pending.size };
    }

    async flush() {
        this.flushTimer = null;
        if (this.isFlushing || !this.atem || this.status.connectionState !== 'connected') return;
        if (this.pending.size === 0) return;

        this.isFlushing = true;
        const batch = new Map(this.pending);
        this.pending.clear();
        this.pushSentAt = Date.now();

        try {
            for (const [key, props] of batch) {
                const [ssrcId, boxIndex] = key.split(':').map(Number);
                // Only fields that differ from what was last SENT — this is what
                // keeps a drag from becoming a command storm.
                const previous = this.lastSent.get(key) || {};
                const delta = {};
                for (const [field, value] of Object.entries(props)) {
                    if (previous[field] !== value) delta[field] = value;
                }
                if (Object.keys(delta).length === 0) continue;

                await this.atem.setSuperSourceBoxSettings(delta, boxIndex, ssrcId);
                this.lastSent.set(key, { ...previous, ...delta });
            }
            // Throttled: flush() runs every FLUSH_INTERVAL_MS (25 Hz) for as long as the
            // operator drags a SuperSource box, and each emitStatus deep-copies the whole
            // status object (inputs, every mixEffect with its keyers, aux buses) and fans it
            // out per-socket. This is push telemetry — round-trip time and a timestamp — so
            // coalescing it to the same 250 ms cadence as the stateChanged path loses nothing
            // the operator can perceive.
            this.queuePushStatus({
                lastPushAt: Date.now(),
                lastPushError: null,
                lastPushRoundTripMs: Date.now() - this.pushSentAt,
            });
        } catch (err) {
            // Errors are not throttled: a failed push must surface immediately.
            this.clearPushStatusTimer();
            this.emitStatus({ lastPushError: err?.message || String(err) });
        } finally {
            this.isFlushing = false;
            if (this.pending.size > 0 && !this.flushTimer) {
                this.flushTimer = setTimeout(() => this.flush(), FLUSH_INTERVAL_MS);
            }
        }
    }

    async pushProperties(props = {}, ssrcId = 0) {
        if (!this.status.armed) return { ok: false, error: 'Push to ATEM is not armed.' };
        if (!this.atem || this.status.connectionState !== 'connected') {
            return { ok: false, error: 'Not connected.' };
        }
        if (!props || typeof props !== 'object' || Array.isArray(props)) {
            return { ok: false, error: 'Invalid SuperSource properties.' };
        }
        try {
            await this.atem.setSuperSourceProperties(props, ssrcId);
            return { ok: true };
        } catch (err) {
            return { ok: false, error: err?.message || String(err) };
        }
    }

    // Reads the switcher's current SuperSource geometry back, for "pull from ATEM".
    pullBoxes(ssrcId = 0) {
        const boxes = this.atem?.state?.video?.superSources?.[ssrcId]?.boxes;
        if (!Array.isArray(boxes)) return null;
        return boxes.map(box => ({ ...box }));
    }

}
