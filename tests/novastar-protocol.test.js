import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
    buildSignedRequest,
    buildScreenFtbBody,
    buildFreezeBody,
    buildBrightnessBody,
    buildPresetListBody,
    buildPresetPlayBody,
    buildTextOsdBody,
    buildImageOsdBody,
    buildScreenListBody,
    buildDeviceDetailBody,
    isSuccessResponse,
    responseErrorMessage,
    parseScreenListResponse,
    parsePresetListResponse,
    parseDeviceDetailResponse,
} from '../novastar_protocol.js';

test('buildSignedRequest wraps the body and signs with Base64(MD5(timeStamp + pId))', () => {
    const { body, sign, pId, timeStamp } = buildSignedRequest({ pId: '1', secretKey: 'unused-in-this-mode', body: { deviceId: 0 } });
    assert.deepEqual(body, { deviceId: 0 });
    assert.equal(pId, '1');
    assert.match(timeStamp, /^\d+$/);

    const expectedHex = crypto.createHash('md5').update(`${timeStamp}${pId}`).digest('hex');
    const expectedSign = Buffer.from(expectedHex, 'utf8').toString('base64');
    assert.equal(sign, expectedSign, 'sign must be deterministic given timeStamp+pId per the documented "disable encryption" formula');
});

test('buildScreenFtbBody defaults type to blackout and clamps time', () => {
    assert.deepEqual(buildScreenFtbBody({ screenId: 2, deviceId: 0, type: 0, time: 3 }), { screenId: 2, deviceId: 0, type: 0, time: 3 });
    assert.deepEqual(buildScreenFtbBody({ screenId: 2, type: 1 }), { screenId: 2, deviceId: 0, type: 1, time: 0 }, 'time defaults to 0 (instant)');
    assert.equal(buildScreenFtbBody({ screenId: 2, type: 0, time: 999 }).time, 0, 'an out-of-range time falls back to 0 rather than being sent unclamped');
});

test('buildFreezeBody coerces enable to 0/1', () => {
    assert.deepEqual(buildFreezeBody({ screenId: 1, enable: true }), { deviceId: 0, screenId: 1, enable: 1 });
    assert.deepEqual(buildFreezeBody({ screenId: 1, enable: false }), { deviceId: 0, screenId: 1, enable: 0 });
});

test('buildBrightnessBody clamps to 0-100', () => {
    assert.deepEqual(buildBrightnessBody({ screenId: 2, brightness: 30 }), { screenId: 2, deviceId: 0, brightness: 30 });
    assert.equal(buildBrightnessBody({ screenId: 2, brightness: 250 }).brightness, 0, 'out-of-range brightness falls back to 0 rather than being sent unclamped');
    assert.equal(buildBrightnessBody({ screenId: 2, brightness: -5 }).brightness, 0);
});

test('preset list/play body builders shape the wire request', () => {
    assert.deepEqual(buildPresetListBody({ screenId: 3, deviceId: 0 }), { screenId: 3, deviceId: 0 });
    assert.deepEqual(buildPresetPlayBody({ screenId: 3, deviceId: 0, presetId: 2 }), { presetId: 2, screenId: 3, deviceId: 0 });
});

test('buildTextOsdBody shapes the scoped-down words schema and always requests isJudge', () => {
    const body = buildTextOsdBody({ screenId: 2, enable: true, chars: 'Welcome', fontPercent: 300 });
    assert.equal(body.screenId, 2);
    assert.equal(body.type, 0);
    assert.equal(body.enable, 1);
    assert.equal(body.isJudge, 1);
    assert.equal(body.words.chars, 'Welcome');
    assert.equal(body.words.fontPercent, 80, 'an out-of-range font size falls back to the default rather than being sent unclamped');
});

test('buildImageOsdBody shapes the image payload without touching the base64 file contents', () => {
    const body = buildImageOsdBody({ screenId: 1, enable: true, width: 400, height: 300, file: 'AAAA', fileName: 'a.png', fileLength: 3, opacity: 150 });
    assert.equal(body.type, 1);
    assert.equal(body.image.file, 'AAAA', 'the base64 payload must pass through unmodified');
    assert.equal(body.image.opacity, 100, 'opacity is clamped to 0-100');
});

test('buildScreenListBody / buildDeviceDetailBody default deviceId to 0', () => {
    assert.deepEqual(buildScreenListBody(), { deviceId: 0 });
    assert.deepEqual(buildDeviceDetailBody(), { deviceId: 0 });
    assert.deepEqual(buildScreenListBody({ deviceId: 2 }), { deviceId: 2 });
});

test('isSuccessResponse / responseErrorMessage read the {status,msg} envelope', () => {
    assert.equal(isSuccessResponse({ status: 0 }), true);
    assert.equal(isSuccessResponse({ status: 1 }), false);
    assert.equal(isSuccessResponse(null), false);
    assert.equal(responseErrorMessage({ status: 1, msg: 'Bad pId' }), 'Bad pId');
    assert.equal(responseErrorMessage(null), 'No response from the NovaStar processor.');
    assert.match(responseErrorMessage({ status: 5 }), /status 5/);
});

test('regression: a real H5 response keying status as "status " (trailing space) is still read correctly', () => {
    // Byte-for-byte shape captured from a real H5 screen/readList success —
    // this firmware spells the key "status " with a trailing space instead
    // of "status", which previously made a genuine success look like a
    // failure ("NovaStar returned status undefined.").
    const realSuccess = { body: { deviceId: 0, screens: [{ screenId: 0, name: 'Screen 1' }] }, msg: '', sign: '', 'status ': 0 };
    assert.equal(isSuccessResponse(realSuccess), true);

    const realFailure = { body: {}, msg: 'Open_Id_Illegal_Err', sign: '', 'status ': 15 };
    assert.equal(isSuccessResponse(realFailure), false);
    assert.equal(responseErrorMessage(realFailure), 'Open_Id_Illegal_Err', 'msg is present here, so it must be preferred over the status number either way');

    const trailingSpaceNoMsg = { body: {}, msg: '', 'status ': 15 };
    assert.match(responseErrorMessage(trailingSpaceNoMsg), /status 15/, 'falls back to the trailing-space status value, not "undefined"');
});

test('parseScreenListResponse / parsePresetListResponse extract lists, defaulting names', () => {
    const screens = parseScreenListResponse({ body: { screens: [{ screenId: 0, name: 'Screen 1' }, { screenId: 1 }] } });
    assert.equal(screens[0].name, 'Screen 1');
    assert.equal(screens[1].name, 'Screen 1', 'unnamed screen falls back to a numbered placeholder ("Screen <id>")');
    assert.equal(screens[1].screenId, 1);
    assert.deepEqual(parseScreenListResponse({}), []);

    const presets = parsePresetListResponse({ body: { presets: [{ presetId: 0, name: 'Preset 1' }, { presetId: 1 }] } });
    assert.equal(presets[0].name, 'Preset 1');
    assert.equal(presets[1].name, 'Preset 1');
    assert.deepEqual(parsePresetListResponse({}), []);
});

test('parseDeviceDetailResponse pulls name/status/temperature, defaulting to null', () => {
    const detail = parseDeviceDetailResponse({ body: { name: 'H5-Main', status: 1, backboardTemperature: 42 } });
    assert.deepEqual(detail, { name: 'H5-Main', status: 1, temperature: 42 });
    assert.deepEqual(parseDeviceDetailResponse({}), { name: null, status: null, temperature: null });
});
