import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NovaStarService } from '../novastar_service.js';

const tick = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));

function jsonResponse(json, { ok = true, status = 200 } = {}) {
    return { ok, status, json: async () => json };
}

// Stands in for global fetch, following the FakeSocket/FakeAtem convention in
// videohub-service.test.js/atem-service.test.js — records every call and
// replays a scripted sequence of responses, no real HTTP or hardware
// involved. Entries may be a plain response object or a function that
// returns/throws one, for testing the reject-mid-flight paths.
function makeFetch(script) {
    const calls = [];
    let i = 0;
    const fetchImpl = async (url, options) => {
        calls.push({ url, options });
        const entry = script[Math.min(i, script.length - 1)];
        i += 1;
        if (typeof entry === 'function') return entry();
        return entry;
    };
    fetchImpl.calls = calls;
    return fetchImpl;
}

test('connect requires an address and a pId before making any request', async () => {
    const fetchImpl = makeFetch([]);
    const service = new NovaStarService({ fetchImpl });

    const noAddress = await service.connect({ pId: '1' });
    assert.equal(noAddress.connectionState, 'error');
    assert.match(noAddress.error, /IP address/);

    const noPid = await service.connect({ address: '192.168.1.50' });
    assert.equal(noPid.connectionState, 'error');
    assert.match(noPid.error, /Requestor ID/);

    assert.equal(fetchImpl.calls.length, 0, 'must not hit the network without the required fields');
});

test('connect probes screen/readList then opportunistically enriches with device/readDetail, landing on connected', async () => {
    // screen/readList is the reachability/auth probe, not device/readDetail —
    // confirmed against real H5 hardware where the entire "Devices" category
    // (readDetail/readIP) can 500 even with fully valid credentials and a
    // working connection, while screen/readList works fine. device/readDetail
    // is called second, purely to enrich the device info, and its result must
    // never block reaching "connected".
    const fetchImpl = makeFetch([
        jsonResponse({ status: 0, body: { deviceId: 0, screens: [{ screenId: 0, name: 'Main Wall' }] } }),
        jsonResponse({ status: 0, body: { name: 'H5-Main', status: 1, backboardTemperature: 40 } }),
    ]);
    const statuses = [];
    const service = new NovaStarService({ fetchImpl, onStatus: s => statuses.push(s) });
    const status = await service.connect({ address: '192.168.1.50', port: 80, pId: '1', secretKey: 'k' });

    assert.equal(status.connectionState, 'connected');
    assert.equal(status.screens.length, 1);
    assert.equal(status.selectedScreenId, 0, 'the first discovered screen is auto-selected');
    assert.equal(status.device.name, 'H5-Main', 'the best-effort readDetail call still enriches device info when it succeeds');
    assert.match(fetchImpl.calls[0].url, /^http:\/\/192\.168\.1\.50:80\/open\/api\/screen\/readList$/);
    assert.match(fetchImpl.calls[1].url, /\/open\/api\/device\/readDetail$/);
    assert.ok(statuses.length > 0, 'onStatus must fire');

    await service.disconnect();
});

test('a failing device/readDetail enrichment does not prevent reaching connected', async () => {
    // The exact real-world case this regression guards: readList succeeds
    // (auth/reachability proven) but readDetail 500s ("Devices" category
    // outage) — the connection must still land on "connected", just without
    // a device name.
    const fetchImpl = makeFetch([
        jsonResponse({ status: 0, body: { screens: [{ screenId: 0, name: 'Main Wall' }] } }),
        jsonResponse({ status: 500, msg: 'Server_Err' }),
    ]);
    const service = new NovaStarService({ fetchImpl });
    const status = await service.connect({ address: '192.168.1.50', pId: '1' });

    assert.equal(status.connectionState, 'connected');
    assert.equal(status.device.name, null, 'device info stays unpopulated when readDetail fails, but that must not block the connection');

    await service.disconnect();
});

test('a failing screen/readList probe lands on error and schedules a reconnect', async () => {
    const fetchImpl = makeFetch([jsonResponse({ status: 1, msg: 'Bad pId' })]);
    const service = new NovaStarService({ fetchImpl });
    const status = await service.connect({ address: '192.168.1.50', pId: 'wrong' });

    assert.equal(status.connectionState, 'error');
    assert.equal(status.error, 'Bad pId');
    assert.notEqual(service.reconnectTimer, null, 'a retry should be pending');

    await service.disconnect();
});

test('a non-2xx HTTP response is treated as a failure, not a thrown exception', async () => {
    const fetchImpl = makeFetch([jsonResponse({}, { ok: false, status: 500 })]);
    const service = new NovaStarService({ fetchImpl });
    const status = await service.connect({ address: '192.168.1.50', pId: '1' });

    assert.equal(status.connectionState, 'error');
    assert.match(status.error, /500/);
    await service.disconnect();
});

test('a rejected fetch (network error) is caught and reported, not thrown', async () => {
    const fetchImpl = async () => { throw new Error('ECONNREFUSED'); };
    const service = new NovaStarService({ fetchImpl });
    const status = await service.connect({ address: '10.0.0.9', pId: '1' });

    assert.equal(status.connectionState, 'error');
    assert.match(status.error, /ECONNREFUSED/);
    await service.disconnect();
});

test('disconnect clears a pending reconnect timer left by a failed connect', async () => {
    const fetchImpl = makeFetch([jsonResponse({ status: 1, msg: 'nope' })]);
    const service = new NovaStarService({ fetchImpl });

    await service.connect({ address: '10.0.0.9', pId: '1' });
    assert.notEqual(service.reconnectTimer, null, 'a retry should be pending after the failed probe');

    await service.disconnect();
    assert.equal(service.reconnectTimer, null, 'disconnect must not leave a stale retry armed');
    assert.equal(service.getStatus().connectionState, 'idle');
});

test('commands are refused while not connected', async () => {
    const fetchImpl = makeFetch([]);
    const service = new NovaStarService({ fetchImpl });

    assert.equal((await service.setBlackout({ type: 0, screenId: 0 })).ok, false);
    assert.equal((await service.setFreeze({ enable: true, screenId: 0 })).ok, false);
    assert.equal((await service.setBrightness({ brightness: 50, screenId: 0 })).ok, false);
    assert.equal((await service.saveBrightness({ brightness: 50, screenId: 0 })).ok, false);
    assert.equal((await service.readPresets({ screenId: 0 })).ok, false);
    assert.equal((await service.playPreset({ presetId: 0, screenId: 0 })).ok, false);
    assert.equal((await service.setTextOsd({ screenId: 0 })).ok, false);
    assert.equal((await service.setImageOsd({ screenId: 0 })).ok, false);
    assert.equal(fetchImpl.calls.length, 0, 'a refused command must not hit the network');
});

test('setBlackout/setFreeze/setBrightness post the right endpoint and update local status on success', async () => {
    const fetchImpl = makeFetch([
        jsonResponse({ status: 0, body: { screens: [{ screenId: 0, name: 'Main' }] } }), // screen list (connect probe)
        jsonResponse({ status: 0, body: { name: 'H5' } }), // device readDetail (best-effort enrichment)
        jsonResponse({ status: 0 }), // ftb
        jsonResponse({ status: 0 }), // freeze
        jsonResponse({ status: 0 }), // brightness
    ]);
    const service = new NovaStarService({ fetchImpl });
    await service.connect({ address: '192.168.1.50', pId: '1' });

    const blackout = await service.setBlackout({ type: 0 });
    assert.equal(blackout.ok, true);
    assert.equal(service.getStatus().blackout, true);
    assert.match(fetchImpl.calls[2].url, /\/open\/api\/screen\/ftb$/);

    const freeze = await service.setFreeze({ enable: true });
    assert.equal(freeze.ok, true);
    assert.equal(service.getStatus().frozen, true);
    assert.match(fetchImpl.calls[3].url, /\/open\/api\/screen\/writeFreeze$/);

    const brightness = await service.setBrightness({ brightness: 42 });
    assert.equal(brightness.ok, true);
    assert.equal(service.getStatus().brightness, 42);
    assert.match(fetchImpl.calls[4].url, /\/open\/api\/screen\/writeBrightness$/);

    await service.disconnect();
});

test('readPresets populates the preset list and playPreset targets the selected screen', async () => {
    const fetchImpl = makeFetch([
        jsonResponse({ status: 0, body: { screens: [{ screenId: 3, name: 'Main' }] } }),
        jsonResponse({ status: 0, body: { name: 'H5' } }),
        jsonResponse({ status: 0, body: { presets: [{ presetId: 0, name: 'Preset 1' }] } }),
        jsonResponse({ status: 0 }),
    ]);
    const service = new NovaStarService({ fetchImpl });
    await service.connect({ address: '192.168.1.50', pId: '1' });

    const presets = await service.readPresets();
    assert.equal(presets.ok, true);
    assert.equal(service.getStatus().presets.length, 1);

    const play = await service.playPreset({ presetId: 0 });
    assert.equal(play.ok, true);
    const playBody = JSON.parse(fetchImpl.calls.at(-1).options.body).body;
    assert.equal(playBody.screenId, 3, 'falls back to the currently selected screen when none is given explicitly');

    await service.disconnect();
});

test('remote status never leaks address, credentials, screens, or presets', async () => {
    const fetchImpl = makeFetch([
        jsonResponse({ status: 0, body: { screens: [{ screenId: 0, name: 'Main' }] } }),
        jsonResponse({ status: 0, body: { name: 'H5-Main' } }),
    ]);
    const service = new NovaStarService({ fetchImpl });
    await service.connect({ address: '192.168.1.50', pId: '1', secretKey: 'topsecret' });

    const publicStatus = service.getPublicStatus();
    assert.equal('address' in publicStatus, false);
    assert.equal('pId' in publicStatus, false);
    assert.equal('secretKey' in publicStatus, false);
    assert.equal('screens' in publicStatus, false);
    assert.equal('presets' in publicStatus, false);
    assert.equal(publicStatus.connectionState, 'connected');
    assert.equal(publicStatus.device.name, 'H5-Main');

    await service.disconnect();
});

test('a liveness-poll failure after a successful connect moves to reconnecting and schedules a retry', async () => {
    const fetchImpl = makeFetch([
        jsonResponse({ status: 0, body: { screens: [] } }), // screen list (connect probe)
        jsonResponse({ status: 0, body: { name: 'H5' } }), // device readDetail (best-effort enrichment)
        jsonResponse({ status: 1, msg: 'timeout' }), // first liveness poll fails
    ]);
    const service = new NovaStarService({ fetchImpl, pollIntervalMs: 5 });
    await service.connect({ address: '192.168.1.50', pId: '1' });
    assert.equal(service.getStatus().connectionState, 'connected');

    await tick(30);
    assert.equal(service.getStatus().connectionState, 'reconnecting');
    assert.notEqual(service.reconnectTimer, null, 'a retry should be pending');

    await service.disconnect();
});

test('testConnection probes credentials via screen/readList without committing to a connection', async () => {
    // Uses screen/readList, not device/readDetail — see the connect() test
    // above for why the "Devices" category can't be relied on as a probe.
    const fetchImpl = makeFetch([jsonResponse({ status: 0, body: { screens: [{ screenId: 0, name: 'Main Wall' }] } })]);
    const service = new NovaStarService({ fetchImpl });
    const result = await service.testConnection({ address: '192.168.1.50', pId: '1', secretKey: 'k' });

    assert.equal(result.ok, true);
    assert.equal(result.screens.length, 1);
    assert.equal(result.screens[0].name, 'Main Wall');
    assert.equal(service.getStatus().connectionState, 'idle', 'testConnection must not change connectionState');
    assert.equal(service.getStatus().address, '', 'testConnection must not adopt the tested address as the live connection');
});

test('testConnection validates address/pId before touching the network', async () => {
    const fetchImpl = makeFetch([]);
    const service = new NovaStarService({ fetchImpl });

    assert.equal((await service.testConnection({ pId: '1' })).ok, false);
    assert.equal((await service.testConnection({ address: '192.168.1.50' })).ok, false);
    assert.equal(fetchImpl.calls.length, 0);
});
