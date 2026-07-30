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
        this.calls = []; // generic log for switcher/keyer/router commands — see _log
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

    _log(name, ...args) { this.calls.push({ name, args }); }

    async cut(me) { this._log('cut', me); }
    async autoTransition(me) { this._log('autoTransition', me); }
    async fadeToBlack(me) { this._log('fadeToBlack', me); }
    async changeProgramInput(input, me) { this._log('changeProgramInput', input, me); }
    async changePreviewInput(input, me) { this._log('changePreviewInput', input, me); }
    async setAuxSource(source, bus) { this._log('setAuxSource', source, bus); }
    async setTransitionStyle(props, me) { this._log('setTransitionStyle', props, me); }
    async setTransitionPosition(position, me) { this._log('setTransitionPosition', position, me); }
    async setMixTransitionSettings(props, me) { this._log('setMixTransitionSettings', props, me); }
    async setDipTransitionSettings(props, me) { this._log('setDipTransitionSettings', props, me); }
    async setWipeTransitionSettings(props, me) { this._log('setWipeTransitionSettings', props, me); }
    async setDVETransitionSettings(props, me) { this._log('setDVETransitionSettings', props, me); }
    async setStingerTransitionSettings(props, me) { this._log('setStingerTransitionSettings', props, me); }
    async setUpstreamKeyerOnAir(onAir, me, keyer) { this._log('setUpstreamKeyerOnAir', onAir, me, keyer); }
    async setUpstreamKeyerType(props, me, keyer) { this._log('setUpstreamKeyerType', props, me, keyer); }
    async setUpstreamKeyerFillSource(fillSource, me, keyer) { this._log('setUpstreamKeyerFillSource', fillSource, me, keyer); }
    async setUpstreamKeyerCutSource(cutSource, me, keyer) { this._log('setUpstreamKeyerCutSource', cutSource, me, keyer); }
    async setUpstreamKeyerChromaSettings(props, me, keyer) { this._log('setUpstreamKeyerChromaSettings', props, me, keyer); }
    async setUpstreamKeyerAdvancedChromaProperties(props, me, keyer) { this._log('setUpstreamKeyerAdvancedChromaProperties', props, me, keyer); }
    async setUpstreamKeyerLumaSettings(props, me, keyer) { this._log('setUpstreamKeyerLumaSettings', props, me, keyer); }
    async setUpstreamKeyerPatternSettings(props, me, keyer) { this._log('setUpstreamKeyerPatternSettings', props, me, keyer); }
    async setUpstreamKeyerDVESettings(props, me, keyer) { this._log('setUpstreamKeyerDVESettings', props, me, keyer); }
    async setUpstreamKeyerMaskSettings(props, me, keyer) { this._log('setUpstreamKeyerMaskSettings', props, me, keyer); }
    async setDownstreamKeyOnAir(onAir, key) { this._log('setDownstreamKeyOnAir', onAir, key); }
    async setDownstreamKeyTie(tie, key) { this._log('setDownstreamKeyTie', tie, key); }
    async setDownstreamKeyFillSource(fillSource, key) { this._log('setDownstreamKeyFillSource', fillSource, key); }
    async setDownstreamKeyCutSource(cutSource, key) { this._log('setDownstreamKeyCutSource', cutSource, key); }
    async setDownstreamKeyGeneralProperties(props, key) { this._log('setDownstreamKeyGeneralProperties', props, key); }
    async setDownstreamKeyMaskSettings(props, key) { this._log('setDownstreamKeyMaskSettings', props, key); }
    async setDownstreamKeyRate(rate, key) { this._log('setDownstreamKeyRate', rate, key); }
    async autoDownstreamKey(key, isTowardsOnAir) { this._log('autoDownstreamKey', key, isTowardsOnAir); }
}

const callsNamed = (fake, name) => fake.calls.filter(c => c.name === name);

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

// --- Switcher: capabilities, discrete actions, coalesced patches -----------

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

test('discrete switcher actions require armed + connected, same as box pushes', async () => {
    const { fake, service } = await connectedService();

    const cutResult = await service.cut(0);
    assert.equal(cutResult.ok, false);
    assert.match(cutResult.error, /not armed/i);
    assert.equal(callsNamed(fake, 'cut').length, 0);

    service.setArmed(true);
    const armedCut = await service.cut(0);
    assert.equal(armedCut.ok, true);
    assert.equal(callsNamed(fake, 'cut').length, 1);

    await service.disconnect();
});

test('program/preview/aux/transition-style actions reach the switcher once armed', async () => {
    const { fake, service } = await connectedService();
    service.setArmed(true);

    await service.setProgramInput(3, 0);
    await service.setPreviewInput(4, 0);
    await service.setAuxSource(2, 1);
    await service.setTransitionStyle({ nextStyle: 1 }, 0);
    await service.autoTransition(0);
    await service.fadeToBlack(0);

    assert.deepEqual(callsNamed(fake, 'changeProgramInput')[0].args, [3, 0]);
    assert.deepEqual(callsNamed(fake, 'changePreviewInput')[0].args, [4, 0]);
    assert.deepEqual(callsNamed(fake, 'setAuxSource')[0].args, [2, 1]);
    assert.equal(callsNamed(fake, 'setTransitionStyle').length, 1);
    assert.equal(callsNamed(fake, 'autoTransition').length, 1);
    assert.equal(callsNamed(fake, 'fadeToBlack').length, 1);

    await service.disconnect();
});

test('setAuxSource works without arming — regression for router Take silently no-op-ing unarmed', async () => {
    // Unlike the SuperSource/keyer pushes, Aux/router switching is a discrete,
    // immediately-visible action (same trust level as VideohubService's ungated
    // takeRoutes) — it must not require the "armed" toggle at all.
    const { fake, service } = await connectedService();

    const result = await service.setAuxSource(2, 1);
    assert.equal(result.ok, true);
    assert.deepEqual(callsNamed(fake, 'setAuxSource')[0].args, [2, 1]);

    await service.disconnect();
});

test('setAuxSource still requires a connection', async () => {
    const fake = new FakeAtem();
    const service = new AtemService({ createAtem: () => fake });

    const result = await service.setAuxSource(2, 1);
    assert.equal(result.ok, false);
    assert.match(result.error, /not connected/i);
    assert.equal(fake.calls.length, 0);
});

test('a burst of transition-position pushes collapses into one command with the final value', async () => {
    const { fake, service } = await connectedService();
    service.setArmed(true);

    for (let x = 0; x < 20; x += 1) {
        service.pushTransitionPosition(x * 500, 0);
    }
    await tick(80);

    const positionCalls = callsNamed(fake, 'setTransitionPosition');
    assert.equal(positionCalls.length, 1, `expected 1 command, got ${positionCalls.length}`);
    assert.deepEqual(positionCalls[0].args, [9500, 0]);

    await service.disconnect();
});

test('keyer settings coalesce independently per keyer, and suppress unchanged values', async () => {
    const { fake, service } = await connectedService();
    service.setArmed(true);

    service.pushKeyerSettings('luma', { clip: 100 }, 0, 0);
    service.pushKeyerSettings('chroma', { hue: 45 }, 0, 1);
    await tick(80);

    assert.equal(callsNamed(fake, 'setUpstreamKeyerLumaSettings').length, 1);
    assert.equal(callsNamed(fake, 'setUpstreamKeyerChromaSettings').length, 1);

    service.pushKeyerSettings('luma', { clip: 100 }, 0, 0);
    await tick(80);
    assert.equal(callsNamed(fake, 'setUpstreamKeyerLumaSettings').length, 1, 'an identical value should not hit the wire twice');

    service.pushKeyerSettings('luma', { clip: 150 }, 0, 0);
    await tick(80);
    assert.equal(callsNamed(fake, 'setUpstreamKeyerLumaSettings').length, 2);

    await service.disconnect();
});

test('DSK settings coalesce the same way as keyer settings', async () => {
    const { fake, service } = await connectedService();
    service.setArmed(true);

    service.pushDskSettings('general', { clip: 50 }, 0);
    service.pushDskSettings('general', { clip: 60 }, 0);
    await tick(80);

    const generalCalls = callsNamed(fake, 'setDownstreamKeyGeneralProperties');
    assert.equal(generalCalls.length, 1, 'a burst should collapse into one command carrying the final value');
    assert.deepEqual(generalCalls[0].args[0], { clip: 60 });

    await service.disconnect();
});

test('DSK and keyer on-air/tie/source actions require armed + connected', async () => {
    const { fake, service } = await connectedService();

    const blocked = await service.setDownstreamKeyOnAir(true, 0);
    assert.equal(blocked.ok, false);
    assert.equal(callsNamed(fake, 'setDownstreamKeyOnAir').length, 0);

    service.setArmed(true);
    await service.setDownstreamKeyOnAir(true, 0);
    await service.setDownstreamKeyTie(true, 0);
    await service.setDownstreamKeySources(3, 4, 0);
    await service.setUpstreamKeyerOnAir(true, 0, 0);
    await service.setUpstreamKeyerSources(3, 4, 0, 0);

    assert.equal(callsNamed(fake, 'setDownstreamKeyOnAir').length, 1);
    assert.equal(callsNamed(fake, 'setDownstreamKeyTie').length, 1);
    assert.equal(callsNamed(fake, 'setDownstreamKeyFillSource').length, 1);
    assert.equal(callsNamed(fake, 'setDownstreamKeyCutSource').length, 1);
    assert.equal(callsNamed(fake, 'setUpstreamKeyerOnAir').length, 1);
    assert.equal(callsNamed(fake, 'setUpstreamKeyerFillSource').length, 1);
    assert.equal(callsNamed(fake, 'setUpstreamKeyerCutSource').length, 1);

    await service.disconnect();
});

test('pushes while disconnected are dropped for the generic patch coalescer too', async () => {
    const { fake, service } = await connectedService();
    service.setArmed(true);

    fake.emit('disconnected');
    await tick();

    const dropped = service.pushTransitionPosition(1000, 0);
    assert.equal(dropped.ok, false);
    await tick(80);
    assert.equal(callsNamed(fake, 'setTransitionPosition').length, 0);

    await service.disconnect();
});

test('pullMixEffectState/pullKeyerState/pullDskState read the live device state back', async () => {
    const { service } = await connectedService();

    const me = service.pullMixEffectState(0);
    assert.equal(me.programInput, 1);
    assert.equal(me.previewInput, 2);
    assert.equal(service.pullMixEffectState(9), null, 'an M/E that does not exist reads as null');

    const keyer = service.pullKeyerState(0, 1);
    assert.equal(keyer.fillSource, 1);
    assert.equal(service.pullKeyerState(0, 9), null, 'a keyer that does not exist reads as null');

    const dsk = service.pullDskState(0);
    assert.equal(dsk.sources.fillSource, 1);
    assert.equal(service.pullDskState(9), null, 'a DSK that does not exist reads as null');

    await service.disconnect();
});
