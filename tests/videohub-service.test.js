import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { VideohubService } from '../videohub_service.js';

// Stands in for node:net's Socket, following the FakeAtem convention in
// atem-service.test.js. Records every write so commands can be asserted on
// directly — no hub and no real TCP socket involved.
class FakeSocket extends EventEmitter {
    constructor() {
        super();
        this.writes = [];
        this.destroyed = false;
        this.timeoutCalls = [];
        this.keepAliveCalls = [];
    }
    write(data) { this.writes.push(data); return true; }
    setTimeout(ms) { this.timeoutCalls.push(ms); }
    setKeepAlive(enable, delay) { this.keepAliveCalls.push({ enable, delay }); }
    destroy() { this.destroyed = true; }
}

const tick = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));

function block(header, lines = []) {
    return [header, ...lines].join('\n');
}

function preambleText({ inputs = ['Camera 1', 'Camera 2'], outputs = ['Program', 'Preview'], routing = [0, 1] } = {}) {
    return [
        block('PROTOCOL PREAMBLE:', ['Version: 2.8']),
        block('VIDEOHUB DEVICE:', [
            'Device present: true',
            'Model name: Blackmagic Smart Videohub 20 x 20',
            `Video inputs: ${inputs.length}`,
            `Video outputs: ${outputs.length}`,
        ]),
        block('INPUT LABELS:', inputs.map((label, i) => `${i} ${label}`)),
        block('OUTPUT LABELS:', outputs.map((label, i) => `${i} ${label}`)),
        block('VIDEO OUTPUT LOCKS:', outputs.map((_, i) => `${i} U`)),
        block('VIDEO OUTPUT ROUTING:', routing.map((src, i) => `${i} ${src}`)),
        // Real firmware sends "END PRELUDE:", not "END PREAMBLE:" — see the
        // real-capture test below, which is what caught this originally.
        block('END PRELUDE:', []),
    ].join('\n\n') + '\n\n';
}

// Byte-for-byte capture from a real Blackmagic Smart Videohub 20 x 20 in the
// field (via a raw TCP dump), reproducing the exact bug report: the app got
// stuck at "Connecting…" forever because this device closes its preamble
// with "END PRELUDE:" rather than the "END PREAMBLE:" the protocol's opening
// block name would suggest, and the old parser silently never recognized it.
const REAL_HUB_CAPTURE = 'PROTOCOL PREAMBLE:\nVersion: 2.8\n\n' +
    'VIDEOHUB DEVICE:\nDevice present: true\nModel name: Blackmagic Smart Videohub 20 x 20\n' +
    'Friendly name: Nij Mandir Hub\nUnique ID: 7C2E0DA58B55\nVideo inputs: 20\n' +
    'Video processing units: 0\nVideo outputs: 20\nVideo monitoring outputs: 0\nSerial ports: 0\n\n' +
    'INPUT LABELS:\n0 Mandir-1\n1 Mandir-2\n2 Mandir-3\n3 Mandir-4\n4 Mandir-Left WP\n5 Mandir-PTZ\n' +
    '6 FAC-Out-1\n7 FAC-Out-2\n8 NV-PTZ\n9 Input 10\n10 Input 11\n11 Input 12\n12 Input 13\n' +
    '13 Input 14\n14 Input 15\n15 Input 16\n16 Input 17\n17 Input 18\n18 Input 19\n19 Input 20\n\n' +
    'OUTPUT LABELS:\n0 FAC-In-1\n1 FAC-In-2\n2 Shayona-TV-1\n3 Shayona-TV-2\n4 Shayona-TV-3\n' +
    '5 Shayona-TV-4\n6 Pujari-TV-1\n7 Pujari-TV-2\n8 Hallway-Acct-TV\n9 Hallway-2.1\n10 Hallway2.2\n' +
    '11 Output 12\n12 Output 13\n13 Output 14\n14 NijToFAC\n15 Output 16\n16 Output 17\n17 Output 18\n' +
    '18 Output 19\n19 Nij NDI\n\n' +
    'VIDEO OUTPUT LOCKS:\n0 U\n1 U\n2 U\n3 U\n4 U\n5 U\n6 U\n7 U\n8 U\n9 U\n10 U\n11 U\n12 U\n13 U\n' +
    '14 U\n15 U\n16 U\n17 U\n18 U\n19 U\n\n' +
    'VIDEO OUTPUT ROUTING:\n0 5\n1 5\n2 1\n3 1\n4 1\n5 1\n6 19\n7 18\n8 1\n9 1\n10 1\n11 18\n12 1\n' +
    '13 1\n14 5\n15 1\n16 5\n17 1\n18 6\n19 5\n\n' +
    'CONFIGURATION:\nTake Mode: true\n\n' +
    'END PRELUDE:\n\n';

async function connectedService() {
    const fake = new FakeSocket();
    const statuses = [];
    const service = new VideohubService({
        createSocket: () => fake,
        onStatus: status => statuses.push(status),
    });
    await service.connect({ address: '192.168.1.250' });
    fake.emit('data', Buffer.from(preambleText()));
    await tick();
    return { fake, service, statuses };
}

test('connecting reads device info, labels and routing off the hub', async () => {
    const { service } = await connectedService();
    const status = service.getStatus();

    assert.equal(status.connectionState, 'connected');
    assert.equal(status.device.videoInputs, 2);
    assert.equal(status.device.videoOutputs, 2);
    assert.deepEqual(status.inputs.map(i => i.label), ['Camera 1', 'Camera 2']);
    assert.deepEqual(status.outputs.map(o => o.label), ['Program', 'Preview']);
    assert.deepEqual(status.outputs.map(o => o.source), [0, 1]);
    assert.deepEqual(status.outputs.map(o => o.locked), [false, false]);

    await service.disconnect();
});

test('regression: an idle connection is not mistaken for a dead one', async () => {
    // Videohub only sends data when something changes, so a long silent
    // stretch on an otherwise-healthy connection is normal. The handshake
    // idle timeout must be disabled once connected — otherwise every ~15s
    // of quiet gets misread as a dead link and the app cycles
    // connecting/reconnecting forever even though nothing is wrong.
    const { fake } = await connectedService();
    assert.equal(fake.timeoutCalls[0], 15000, 'the handshake itself is still bounded');
    assert.equal(fake.timeoutCalls.at(-1), 0, 'idle timeout must be turned off once connected');
    assert.deepEqual(fake.keepAliveCalls, [{ enable: true, delay: 10000 }], 'TCP keepalive, not an app-level idle timer, is what should catch a truly dead link');
});

test('regression: a real 20x20 hub capture reaches connected, not stuck at connecting', async () => {
    const fake = new FakeSocket();
    const service = new VideohubService({ createSocket: () => fake });
    await service.connect({ address: '10.50.20.35' });
    fake.emit('data', Buffer.from(REAL_HUB_CAPTURE));
    await tick();

    const status = service.getStatus();
    assert.equal(status.connectionState, 'connected');
    assert.equal(status.device.modelName, 'Blackmagic Smart Videohub 20 x 20');
    assert.equal(status.device.videoInputs, 20);
    assert.equal(status.device.videoOutputs, 20);
    assert.equal(status.inputs[4].label, 'Mandir-Left WP');
    assert.equal(status.inputs[9].label, 'Input 10', 'unlabeled inputs keep the numbered placeholder');
    assert.equal(status.outputs[14].label, 'NijToFAC');
    assert.equal(status.outputs[6].source, 19, 'output 7 (Pujari-TV-1) is routed from input 20');
    assert.deepEqual(status.outputs.map(o => o.locked), Array(20).fill(false));

    await service.disconnect();
});

test('the preamble can arrive split across multiple TCP chunks', async () => {
    const fake = new FakeSocket();
    const service = new VideohubService({ createSocket: () => fake });
    await service.connect({ address: '10.0.0.5' });

    const text = preambleText();
    const mid = Math.floor(text.length / 2);
    fake.emit('data', Buffer.from(text.slice(0, mid)));
    assert.notEqual(service.getStatus().connectionState, 'connected', 'must not be connected on a half-received preamble');
    fake.emit('data', Buffer.from(text.slice(mid)));
    await tick();

    assert.equal(service.getStatus().connectionState, 'connected');
    await service.disconnect();
});

test('TAKE writes a routing command and UNDO reverts it once confirmed', async () => {
    const { fake, service } = await connectedService();

    const take = service.takeRoutes([{ destIndex: 0, srcIndex: 1 }]);
    assert.equal(take.ok, true);
    assert.equal(fake.writes.at(-1), 'VIDEO OUTPUT ROUTING:\n0 1\n\n');

    // The device echoes the routing block back — that's what confirms it.
    fake.emit('data', Buffer.from(`${block('VIDEO OUTPUT ROUTING:', ['0 1'])}\n\n`));
    await tick();
    assert.equal(service.getStatus().outputs[0].source, 1);

    const undo = service.undoLastTake();
    assert.equal(undo.ok, true);
    assert.equal(fake.writes.at(-1), 'VIDEO OUTPUT ROUTING:\n0 0\n\n');

    await service.disconnect();
});

test('a locked destination refuses TAKE', async () => {
    const { fake, service } = await connectedService();

    service.setLock(0, true);
    fake.emit('data', Buffer.from(`${block('VIDEO OUTPUT LOCKS:', ['0 O'])}\n\n`));
    await tick();
    assert.equal(service.getStatus().outputs[0].locked, true);

    const writesBefore = fake.writes.length;
    const result = service.takeRoutes([{ destIndex: 0, srcIndex: 1 }]);
    assert.equal(result.ok, false);
    assert.match(result.error, /locked/i);
    assert.equal(fake.writes.length, writesBefore, 'a rejected take must not write anything');

    await service.disconnect();
});

test('renaming an input writes the label command', async () => {
    const { fake, service } = await connectedService();
    service.renameInput(0, 'Podium Cam');
    assert.equal(fake.writes.at(-1), 'INPUT LABELS:\n0 Podium Cam\n\n');
    await service.disconnect();
});

test('commands are refused while not connected', async () => {
    const fake = new FakeSocket();
    const service = new VideohubService({ createSocket: () => fake });

    assert.equal(service.takeRoutes([{ destIndex: 0, srcIndex: 1 }]).ok, false);
    assert.equal(service.setLock(0, true).ok, false);
    assert.equal(service.renameInput(0, 'x').ok, false);
    assert.equal(fake.writes.length, 0);
});

test('remote status never leaks the hub address or full I/O list', async () => {
    const { service } = await connectedService();
    const publicStatus = service.getPublicStatus();
    assert.equal('address' in publicStatus, false);
    assert.equal('inputs' in publicStatus, false);
    assert.equal('outputs' in publicStatus, false);
    assert.equal(publicStatus.connectionState, 'connected');
    await service.disconnect();
});

test('a socket close before the preamble finishes schedules a reconnect', async () => {
    const fake = new FakeSocket();
    const service = new VideohubService({ createSocket: () => fake });
    await service.connect({ address: '10.0.0.9' });

    fake.emit('close');
    await tick();
    assert.equal(service.getStatus().connectionState, 'reconnecting');
    assert.notEqual(service.reconnectTimer, null, 'a retry should be pending');

    await service.disconnect();
});

test('disconnecting mid-flight emits no stale status', async () => {
    // The session guard. A callback landing after teardown must be inert.
    const fake = new FakeSocket();
    const service = new VideohubService({ createSocket: () => fake });
    await service.connect({ address: '10.0.0.9' });

    await service.disconnect();
    const after = service.getStatus();

    assert.equal(fake.listenerCount('data'), 0, 'listeners should be gone after disconnect');

    // A late event from the dead socket must change nothing.
    fake.emit('data', Buffer.from(preambleText()));
    await tick();

    assert.equal(service.getStatus().connectionState, after.connectionState);
    assert.equal(service.getStatus().connectionState, 'idle');
});
