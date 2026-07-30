// Blackmagic Videohub connection + crosspoint control.
//
// Deliberately does NOT import 'electron' (same reasoning as atem_service.js)
// so it's loadable under bare `node --test`. Class shape mirrors AtemService:
// getStatus/getPublicStatus/emitStatus, a monotonic sessionId guarding every
// async continuation, and backoff+jitter reconnect. The Videohub Ethernet
// protocol has no client library like atem-connection, so this class also
// owns the TCP socket directly via node:net and the reconnect loop it would
// otherwise get from a library — there's no internal retry to defer to.

import net from 'node:net';
import {
    DEFAULT_VIDEOHUB_PORT,
    splitBlocks,
    parseBlock,
    buildRoutingCommand,
    buildLockCommand,
    buildInputLabelCommand,
    buildOutputLabelCommand,
} from './videohub_protocol.js';

export { DEFAULT_VIDEOHUB_PORT };

// Bounds only the initial handshake: on a healthy link the preamble arrives
// within a second or two, so no response within this window is treated as a
// dead connection attempt and rebuilt. NOT used once connected — Videohub
// only sends data when something actually changes, so an idle-but-healthy
// connection can go silent for a long time; that must not read as dead. A
// real dead link is instead caught by TCP keepalive (see wireEvents) firing
// a genuine 'error'/'close'.
const WATCHDOG_MS = 15000;
const BACKOFF_MS = [1000, 2000, 4000, 8000, 15000, 30000];

const jitter = (ms) => Math.round(ms * (0.8 + Math.random() * 0.4));

const DEFAULT_STATUS = {
    configured: false,
    address: '',
    port: DEFAULT_VIDEOHUB_PORT,
    connectionState: 'idle', // idle | connecting | connected | reconnecting | error
    connectedAt: null,
    error: null,
    device: {
        modelName: null,
        friendlyName: null,
        videoInputs: 0,
        videoOutputs: 0,
    },
    inputs: [], // [{ id, label }]
    outputs: [], // [{ id, label, source, locked }]
};

// Grows `list` up to `index` using `makeDefaults(i)` for any newly created
// entries, then merges `patch` into the entry at `index`.
function upsertIndexed(list, index, patch, makeDefaults) {
    const next = [...list];
    while (next.length <= index) {
        const i = next.length;
        next.push({ id: i, ...makeDefaults(i) });
    }
    next[index] = { ...next[index], ...patch };
    return next;
}

export class VideohubService {
    constructor({ onStatus, createSocket } = {}) {
        this.onStatus = onStatus;
        // Injected for tests, mirrors AtemService's createAtem convention.
        this.createSocket = createSocket || null;

        this.socket = null;
        this.buffer = '';
        this.sessionId = 0;
        this.status = { ...DEFAULT_STATUS, device: { ...DEFAULT_STATUS.device }, inputs: [], outputs: [] };

        this.explicitDisconnect = false;
        this.backoffIndex = 0;
        this.reconnectTimer = null;

        // Single-level undo: the routing snapshot captured right before the
        // most recent TAKE. Matches RouteTake's simple UNDO, not a full stack.
        this.undoSnapshot = null;
    }

    getStatus() {
        return {
            ...this.status,
            device: { ...this.status.device },
            inputs: this.status.inputs.map(i => ({ ...i })),
            outputs: this.status.outputs.map(o => ({ ...o })),
        };
    }

    // Remote-paired clients get connection state and model only — never the
    // LAN address of production hardware or the full I/O list.
    getPublicStatus() {
        return {
            connectionState: this.status.connectionState,
            device: { modelName: this.status.device.modelName },
        };
    }

    emitStatus(patch = {}) {
        this.status = { ...this.status, ...patch, device: { ...this.status.device, ...(patch.device || {}) } };
        this.onStatus?.(this.getStatus());
    }

    async connect({ address, port = DEFAULT_VIDEOHUB_PORT } = {}) {
        if (!address || typeof address !== 'string') {
            this.emitStatus({ connectionState: 'error', error: 'Enter the Videohub IP address.' });
            return this.getStatus();
        }

        await this.disconnect({ silent: true });

        this.explicitDisconnect = false;
        const session = ++this.sessionId;
        this.emitStatus({ configured: true, address, port, connectionState: 'connecting', error: null });

        let socket;
        try {
            socket = this.createSocket
                ? this.createSocket({ host: address, port })
                : net.createConnection({ host: address, port });
        } catch (err) {
            this.emitStatus({ connectionState: 'error', error: err?.message || String(err) });
            return this.getStatus();
        }

        if (session !== this.sessionId) {
            socket.destroy?.();
            return this.getStatus();
        }
        this.socket = socket;
        this.buffer = '';
        this.wireEvents(socket, session);

        return this.getStatus();
    }

    wireEvents(socket, session) {
        const guard = (fn) => (...args) => {
            if (session !== this.sessionId) return;
            fn(...args);
        };

        // Idle timeout bounds only the handshake (cleared once connected,
        // in the 'end' case below). Keepalive is what detects a truly dead
        // link — a dropped cable, a rebooted hub, a stale NAT/VPN path —
        // during the long normal idle stretches an open connection sits
        // through the rest of the time.
        socket.setTimeout?.(WATCHDOG_MS);
        socket.setKeepAlive?.(true, 10000);

        socket.on('data', guard((chunk) => {
            this.buffer += chunk.toString('utf8');
            const { blocks, remainder } = splitBlocks(this.buffer);
            this.buffer = remainder;
            for (const block of blocks) this.handleBlock(parseBlock(block));
        }));

        socket.on('timeout', guard(() => {
            socket.destroy(new Error('Videohub connection timed out.'));
        }));

        socket.on('error', guard((err) => {
            this.emitStatus({ error: err?.message || String(err) });
        }));

        socket.on('close', guard(() => {
            if (this.socket === socket) this.socket = null;
            if (this.explicitDisconnect) return;
            this.emitStatus({ connectionState: 'reconnecting', connectedAt: null });
            this.scheduleReconnect(session);
        }));
    }

    // Applies one parsed protocol block to status. The device streams its
    // full preamble (device info, then labels, locks, routing) on connect,
    // and the same block shapes arrive again — one block at a time — as
    // incremental updates whenever routing/locks/labels change, including
    // ones we caused ourselves, which is how writes get confirmed.
    handleBlock({ type, patch }) {
        switch (type) {
            case 'device':
                this.emitStatus({ device: { ...this.status.device, ...patch } });
                break;
            case 'inputLabels':
                this.emitStatus({
                    inputs: patch.reduce(
                        (list, { index, label }) => upsertIndexed(list, index, { label }, i => ({ label: `Input ${i + 1}` })),
                        this.status.inputs
                    ),
                });
                break;
            case 'outputLabels':
                this.emitStatus({
                    outputs: patch.reduce(
                        (list, { index, label }) => upsertIndexed(list, index, { label }, i => ({ label: `Output ${i + 1}`, source: null, locked: false })),
                        this.status.outputs
                    ),
                });
                break;
            case 'locks':
                this.emitStatus({
                    outputs: patch.reduce(
                        (list, { index, locked }) => upsertIndexed(list, index, { locked }, i => ({ label: `Output ${i + 1}`, source: null, locked: false })),
                        this.status.outputs
                    ),
                });
                break;
            case 'routing':
                this.emitStatus({
                    outputs: patch.reduce(
                        (list, { index, source }) => upsertIndexed(list, index, { source }, i => ({ label: `Output ${i + 1}`, source: null, locked: false })),
                        this.status.outputs
                    ),
                });
                break;
            case 'end':
                // Not "connected" until here — everything before this point is
                // still the device streaming its initial state to us. Disable
                // the handshake idle timeout now — from here on, silence is
                // normal (see WATCHDOG_MS), not a failure.
                this.socket?.setTimeout?.(0);
                this.backoffIndex = 0;
                this.clearTimer('reconnectTimer');
                this.emitStatus({ connectionState: 'connected', connectedAt: Date.now(), error: null });
                break;
            default:
                break;
        }
    }

    rebuild(session) {
        if (session !== this.sessionId || this.explicitDisconnect) return;
        const { address, port } = this.status;
        this.connect({ address, port });
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
        this.buffer = '';
        this.undoSnapshot = null;

        const socket = this.socket;
        this.socket = null;
        if (socket) {
            socket.removeAllListeners?.();
            socket.destroy();
        }

        if (!silent) {
            this.emitStatus({
                connectionState: 'idle',
                connectedAt: null,
                error: null,
                inputs: [],
                outputs: [],
                device: { ...DEFAULT_STATUS.device },
            });
        }
        return this.getStatus();
    }

    // --- Commands -----------------------------------------------------------

    write(command) {
        if (!this.socket || this.status.connectionState !== 'connected') return false;
        this.socket.write(command);
        return true;
    }

    currentRoutingMap() {
        return new Map(this.status.outputs.map(o => [o.id, o.source]));
    }

    // `pairs` is [{ destIndex, srcIndex }]. Rejected outright if it touches a
    // locked destination — locking is meant to prevent exactly this.
    takeRoutes(pairs = []) {
        if (this.status.connectionState !== 'connected') return { ok: false, error: 'Not connected.' };
        if (!Array.isArray(pairs) || pairs.length === 0) return { ok: false, error: 'Nothing to take.' };

        const lockedTarget = pairs.find(({ destIndex }) => this.status.outputs[destIndex]?.locked);
        if (lockedTarget) {
            return { ok: false, error: `Output ${lockedTarget.destIndex + 1} is locked.` };
        }

        this.undoSnapshot = this.currentRoutingMap();
        this.write(buildRoutingCommand(pairs));
        return { ok: true };
    }

    undoLastTake() {
        if (this.status.connectionState !== 'connected') return { ok: false, error: 'Not connected.' };
        if (!this.undoSnapshot) return { ok: false, error: 'Nothing to undo.' };

        const current = this.currentRoutingMap();
        const pairs = [];
        for (const [destIndex, srcIndex] of this.undoSnapshot) {
            if (current.get(destIndex) !== srcIndex && srcIndex != null) pairs.push({ destIndex, srcIndex });
        }
        this.undoSnapshot = null;
        if (pairs.length === 0) return { ok: true };
        this.write(buildRoutingCommand(pairs));
        return { ok: true };
    }

    setLock(destIndex, locked) {
        if (this.status.connectionState !== 'connected') return { ok: false, error: 'Not connected.' };
        this.write(buildLockCommand(destIndex, locked));
        return { ok: true };
    }

    renameInput(index, label) {
        if (this.status.connectionState !== 'connected') return { ok: false, error: 'Not connected.' };
        this.write(buildInputLabelCommand(index, label));
        return { ok: true };
    }

    renameOutput(index, label) {
        if (this.status.connectionState !== 'connected') return { ok: false, error: 'Not connected.' };
        this.write(buildOutputLabelCommand(index, label));
        return { ok: true };
    }
}
