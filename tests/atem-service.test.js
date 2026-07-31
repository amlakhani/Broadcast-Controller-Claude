import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { AtemService } from '../atem_service.js';

// Stands in for atem-connection, following the FakeWorker convention in
// server-socket.test.js. Records every command so the coalescer can be asserted
// on directly — no switcher and no Electron runtime involved.
class FakeAtem extends EventEmitter {
    constructor() {
        super();
        this.connectCalls = [];
        this.disconnectCalls = 0;
        this.boxCommands = [];
        this.propertyCommands = [];
        this.failNextConnect = false;
        this.state = {
            info: {
                model: 42,
                productIdentifier: 'ATEM Constellation 8K',
                apiVersion: 0x02010000,
                capabilities: { superSources: 2, mixEffects: 2, auxilliaries: 3, downstreamKeyers: 2 },
                superSources: [{ boxCount: 4 }, { boxCount: 4 }],
                mixEffects: [{ keyCount: 2 }, { keyCount: 2 }],
            },
            inputs: {
                1: { longName: 'Cam 1 Speaker', shortName: 'CM1', sourceAvailability: 0xff },
                2: { longName: 'Cam 2 Wide', shortName: 'CM2', sourceAvailability: 0xff },
                // Aux-routable but NOT a valid SuperSource box source (real ATEMs have
                // several of these — ME outputs, Multiview, Confidence Monitor, etc.):
                // regression coverage for inputs vs. auxSources filtering separately.
                10010: { longName: 'ME 1', shortName: 'ME1', sourceAvailability: 1 }, // Auxiliary only
                // Each Aux bus is also exposed as a self-source (internalPortType ===
                // Auxiliary) carrying the bus's own renameable name. Bus 3's is
                // deliberately renamed to something that does NOT match an "Aux N"
                // pattern, to prove the lookup is id-ordered, not name-pattern-matched.
                8001: { longName: 'Aux 1', shortName: 'Aux1', sourceAvailability: 1, internalPortType: 129 },
                8002: { longName: 'Aux 2', shortName: 'Aux2', sourceAvailability: 1, internalPortType: 129 },
                8003: { longName: 'Confidence Monitor', shortName: 'ConfMon', sourceAvailability: 1, internalPortType: 129 },
            },
            video: {
                superSources: [{ boxes: [{ enabled: true, x: 100, y: 0, size: 500 }] }],
                mixEffects: [
                    {
                        programInput: 1,
                        previewInput: 2,
                        transitionPreview: false,
                        fadeToBlack: { isFullyBlack: false, inTransition: false, remainingFrames: 0, rate: 25 },
                        transitionPosition: { inTransition: false, remainingFrames: 0, handlePosition: 0 },
                        transitionProperties: { style: 0, selection: [], nextStyle: 0, nextSelection: [] },
                        transitionSettings: { mix: { rate: 25 } },
                        upstreamKeyers: [
                            { upstreamKeyerId: 0, mixEffectKeyType: 0, flyEnabled: false, fillSource: 1, cutSource: 2, onAir: false, canFlyKey: false, maskSettings: { maskEnabled: false, maskTop: 0, maskBottom: 0, maskLeft: 0, maskRight: 0 } },
                            { upstreamKeyerId: 1, mixEffectKeyType: 0, flyEnabled: false, fillSource: 1, cutSource: 2, onAir: false, canFlyKey: false, maskSettings: { maskEnabled: false, maskTop: 0, maskBottom: 0, maskLeft: 0, maskRight: 0 } },
                        ],
                    },
                    {
                        programInput: 1,
                        previewInput: 2,
                        transitionPreview: false,
                        transitionPosition: { inTransition: false, remainingFrames: 0, handlePosition: 0 },
                        transitionProperties: { style: 0, selection: [], nextStyle: 0, nextSelection: [] },
                        transitionSettings: { mix: { rate: 25 } },
                        upstreamKeyers: [
                            { upstreamKeyerId: 0, mixEffectKeyType: 0, flyEnabled: false, fillSource: 1, cutSource: 2, onAir: false, canFlyKey: false, maskSettings: { maskEnabled: false, maskTop: 0, maskBottom: 0, maskLeft: 0, maskRight: 0 } },
                            { upstreamKeyerId: 1, mixEffectKeyType: 0, flyEnabled: false, fillSource: 1, cutSource: 2, onAir: false, canFlyKey: false, maskSettings: { maskEnabled: false, maskTop: 0, maskBottom: 0, maskLeft: 0, maskRight: 0 } },
                        ],
                    },
                ],
                downstreamKeyers: [
                    { onAir: false, isAuto: false, inTransition: false, remainingFrames: 0, sources: { fillSource: 1, cutSource: 2 }, properties: { preMultiply: true, clip: 0, gain: 0, invert: false, tie: false, rate: 25, mask: { enabled: false, top: 0, bottom: 0, left: 0, right: 0 } } },
                    { onAir: false, isAuto: false, inTransition: false, remainingFrames: 0, sources: { fillSource: 1, cutSource: 2 }, properties: { preMultiply: true, clip: 0, gain: 0, invert: false, tie: false, rate: 25, mask: { enabled: false, top: 0, bottom: 0, left: 0, right: 0 } } },
                ],
                auxilliaries: [1, 2, 3],
            },
        };
    }

    async connect(address, port) {
        this.connectCalls.push({ address, port });
        if (this.failNextConnect) {
            this.failNextConnect = false;
            throw new Error('ECONNREFUSED');
        }
    }

    async disconnect() { this.disconnectCalls += 1; }

    async setSuperSourceBoxSettings(props, boxIndex, ssrcId) {
        this.boxCommands.push({ props, boxIndex, ssrcId });
    }

    async setSuperSourceProperties(props, ssrcId) {
        this.propertyCommands.push({ props, ssrcId });
    }
}

const tick = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));

// Real SourceAvailability values (atem-connection's enums module) — injected
// directly since createAtem bypasses the lazy `require('atem-connection')` in
// loadAtemModule(), so `service._atemModule` would otherwise stay unset and
// the inputs/auxSources filters would only ever exercise their fallback path.
const FAKE_ENUMS = {
    SourceAvailability: { Auxiliary: 1, Multiviewer: 2, SuperSourceArt: 4, SuperSourceBox: 8, KeySource: 16, All: 255 },
    InternalPortType: { External: 0, Black: 1, ColorBars: 2, ColorGenerator: 3, MediaPlayerFill: 4, MediaPlayerKey: 5, SuperSource: 6, ExternalDirect: 7, MEOutput: 128, Auxiliary: 129, Mask: 130, MultiViewer: 131, AudioMonitor: 132 },
};

async function connectedService() {
    const fake = new FakeAtem();
    const statuses = [];
    const service = new AtemService({
        createAtem: () => fake,
        onStatus: status => statuses.push(status),
    });
    service._atemModule = { Enums: FAKE_ENUMS };
    await service.connect({ address: '192.168.1.240' });
    fake.emit('connected');
    await tick();
    return { fake, service, statuses };
}

test('connecting reads capabilities and input names off the device', async () => {
    const { fake, service } = await connectedService();

    assert.equal(fake.connectCalls[0].address, '192.168.1.240');
    assert.equal(fake.connectCalls[0].port, 9910);

    const status = service.getStatus();
    assert.equal(status.connectionState, 'connected');
    assert.equal(status.device.hasSuperSource, true);
    assert.equal(status.device.superSourceCount, 2);
    assert.deepEqual(status.device.boxCounts, [4, 4]);
    assert.deepEqual(status.inputs.map(i => i.longName), ['Cam 1 Speaker', 'Cam 2 Wide']);

    await service.disconnect();
});

test('a device with no SuperSource is a state, not an error', async () => {
    // Most ATEM Minis, TVS HD and 1 M/E units have none. This must not read as a fault.
    const fake = new FakeAtem();
    fake.state.info.capabilities.superSources = 0;
    fake.state.info.superSources = [];

    const service = new AtemService({ createAtem: () => fake });
    await service.connect({ address: '10.0.0.5' });
    fake.emit('connected');
    await tick();

    const status = service.getStatus();
    assert.equal(status.connectionState, 'connected');
    assert.equal(status.error, null);
    assert.equal(status.device.hasSuperSource, false);
    assert.equal(status.device.superSourceCount, 0);

    await service.disconnect();
});

test('a burst of pushes collapses into one command per box', async () => {
    // The whole point of the coalescer: a drag runs at rAF, the switcher must not.
    const { fake, service } = await connectedService();
    service.setArmed(true);

    for (let x = 0; x < 20; x += 1) {
        service.pushBoxes([{ boxIndex: 0, props: { x: x * 10 } }, { boxIndex: 1, props: { y: x } }]);
    }
    await tick(80);

    assert.equal(fake.boxCommands.length, 2, `expected 2 commands, got ${fake.boxCommands.length}`);
    const box0 = fake.boxCommands.find(c => c.boxIndex === 0);
    const box1 = fake.boxCommands.find(c => c.boxIndex === 1);
    assert.deepEqual(box0.props, { x: 190 }, 'box 0 must carry the FINAL value');
    assert.deepEqual(box1.props, { y: 19 });

    await service.disconnect();
});

test('re-sending an unchanged value produces no command at all', async () => {
    const { fake, service } = await connectedService();
    service.setArmed(true);

    service.pushBoxes([{ boxIndex: 0, props: { x: 500 } }]);
    await tick(80);
    assert.equal(fake.boxCommands.length, 1);

    service.pushBoxes([{ boxIndex: 0, props: { x: 500 } }]);
    await tick(80);
    assert.equal(fake.boxCommands.length, 1, 'an identical value should not hit the wire twice');

    service.pushBoxes([{ boxIndex: 0, props: { x: 501 } }]);
    await tick(80);
    assert.equal(fake.boxCommands.length, 2);

    await service.disconnect();
});

test('nothing reaches the switcher until push is armed', async () => {
    const { fake, service } = await connectedService();

    const result = service.pushBoxes([{ boxIndex: 0, props: { x: 100 } }]);
    await tick(80);
    assert.equal(result.ok, false);
    assert.match(result.error, /not armed/i);
    assert.equal(fake.boxCommands.length, 0);

    const props = await service.pushProperties({ artFillSource: 3 });
    assert.equal(props.ok, false);
    assert.equal(fake.propertyCommands.length, 0);

    await service.disconnect();
});

test('pushes while disconnected are dropped, and reconnecting forgets what was last sent', async () => {
    const { fake, service } = await connectedService();
    service.setArmed(true);

    service.pushBoxes([{ boxIndex: 0, props: { x: 100 } }]);
    await tick(80);
    assert.equal(fake.boxCommands.length, 1);

    fake.emit('disconnected');
    await tick();
    assert.equal(service.getStatus().connectionState, 'reconnecting');

    const dropped = service.pushBoxes([{ boxIndex: 0, props: { x: 200 } }]);
    assert.equal(dropped.ok, false);
    await tick(80);
    assert.equal(fake.boxCommands.length, 1, 'a drag during an outage must not queue up');

    fake.emit('connected');
    await tick();

    // The device may have power-cycled or been reconfigured while we were down, so
    // re-sending the SAME value the pre-outage cache thinks it already sent must
    // still go out — "last sent" is no longer trustworthy after a reconnect.
    service.pushBoxes([{ boxIndex: 0, props: { x: 100 } }]);
    await tick(80);
    assert.equal(fake.boxCommands.length, 2, 'reconnecting must force the next push through, even if unchanged');

    await service.disconnect();
});

test('boxes the device does not physically have are refused', async () => {
    const fake = new FakeAtem();
    fake.state.info.superSources = [{ boxCount: 2 }];
    fake.state.info.capabilities.superSources = 1;

    const service = new AtemService({ createAtem: () => fake });
    await service.connect({ address: '10.0.0.5' });
    fake.emit('connected');
    await tick();
    service.setArmed(true);

    service.pushBoxes([
        { boxIndex: 0, props: { x: 1 } },
        { boxIndex: 1, props: { x: 2 } },
        { boxIndex: 2, props: { x: 3 } },
        { boxIndex: 3, props: { x: 4 } },
    ]);
    await tick(80);

    assert.deepEqual(fake.boxCommands.map(c => c.boxIndex).sort(), [0, 1]);

    await service.disconnect();
});

test('disconnecting mid-flight emits no stale status', async () => {
    // The session guard. A callback landing after teardown must be inert.
    const fake = new FakeAtem();
    const service = new AtemService({ createAtem: () => fake });
    await service.connect({ address: '10.0.0.5' });

    await service.disconnect();
    const after = service.getStatus();

    // disconnect() strips the service's listeners, so 'error' would now be an
    // unhandled EventEmitter error. The sink isolates what we're actually
    // testing: that the SERVICE no longer reacts.
    assert.equal(fake.listenerCount('connected'), 0, 'listeners should be gone after disconnect');
    fake.on('error', () => {});

    // Late events from the dead instance must change nothing.
    fake.emit('connected');
    fake.emit('error', new Error('too late'));
    await tick(20);

    assert.equal(service.getStatus().connectionState, after.connectionState);
    assert.equal(service.getStatus().connectionState, 'idle');
    assert.equal(service.getStatus().error, null);
});

test('a failed connect reports the error and schedules a retry', async () => {
    const fake = new FakeAtem();
    fake.failNextConnect = true;
    const service = new AtemService({ createAtem: () => fake });

    await service.connect({ address: '10.0.0.9' });
    const status = service.getStatus();
    assert.equal(status.connectionState, 'error');
    assert.match(status.error, /ECONNREFUSED/);
    assert.notEqual(service.reconnectTimer, null, 'a retry should be pending');

    await service.disconnect();
});

test('connect rejects an empty address without touching the network', async () => {
    const fake = new FakeAtem();
    const service = new AtemService({ createAtem: () => fake });

    await service.connect({ address: '' });
    assert.equal(service.getStatus().connectionState, 'error');
    assert.equal(fake.connectCalls.length, 0);
});

test('remote status never leaks the switcher address or input list', async () => {
    const { service } = await connectedService();

    const publicStatus = service.getPublicStatus();
    assert.equal('address' in publicStatus, false);
    assert.equal('inputs' in publicStatus, false);
    assert.equal(publicStatus.connectionState, 'connected');
    assert.equal(publicStatus.device.hasSuperSource, true);

    await service.disconnect();
});

test('pullBoxes reads the switcher geometry back', async () => {
    const { service } = await connectedService();

    const boxes = service.pullBoxes(0);
    assert.equal(boxes.length, 1);
    assert.equal(boxes[0].x, 100);
    assert.equal(service.pullBoxes(3), null, 'a SuperSource unit that does not exist reads as null');

    await service.disconnect();
});

// --- Switcher: capabilities ------------------------------------------------
// These fields (meCount, auxSources, auxBusNames, etc.) have no UI consumer
// since AtemSwitcherPanel was removed, but readDeviceState() still populates
// them as part of the live SuperSource connect/status path, so the coverage
// stays.

test('connecting reads ME/DSK/aux capabilities off the device', async () => {
    const { service } = await connectedService();

    const status = service.getStatus();
    assert.equal(status.device.meCount, 2);
    assert.equal(status.device.auxCount, 3);
    assert.equal(status.device.dskCount, 2);
    assert.deepEqual(status.device.keyCounts, [2, 2]);
    assert.equal(status.mixEffects.length, 2);
    assert.equal(status.mixEffects[0].programInput, 1);
    assert.equal(status.mixEffects[0].previewInput, 2);
    assert.equal(status.mixEffects[0].upstreamKeyers.length, 2);
    assert.equal(status.downstreamKeyers.length, 2);
    assert.deepEqual(status.auxiliaries, [1, 2, 3]);

    await service.disconnect();
});

test('auxSources includes aux-only sources (e.g. ME outputs) that the box-filtered inputs list excludes', async () => {
    const { service } = await connectedService();

    const status = service.getStatus();
    assert.deepEqual(status.inputs.map(i => i.id), [1, 2], 'ME 1 output is not a valid SuperSource box source');
    assert.deepEqual(status.auxSources.map(i => i.id), [1, 2, 8001, 8002, 8003, 10010], 'but it IS a valid Aux/router source');

    await service.disconnect();
});

test('auxBusNames reads the device-reported, renameable name per bus, matched by source id not name pattern', async () => {
    const { service } = await connectedService();

    const status = service.getStatus();
    assert.deepEqual(status.auxBusNames, ['Aux 1', 'Aux 2', 'Confidence Monitor']);

    await service.disconnect();
});

