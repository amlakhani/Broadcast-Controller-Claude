// Pure request-signing/body-building/response-parsing for the NovaStar H
// Series OpenAPI (HTTP + JSON, port configurable on the processor's own web
// service). No I/O here — novastar_service.js owns the actual fetch() calls;
// this module is the part that's worth unit-testing without a real H5, same
// split as videohub_protocol.js vs videohub_service.js.

import crypto from 'node:crypto';

// The OpenAPI docs don't fix a single default; the H5's built-in web service
// port is configurable per install, so this is just a common starting guess
// for the settings form, not a protocol constant like Videohub's 9990.
export const DEFAULT_NOVASTAR_PORT = 80;

// Every request body is signed and wrapped as { body, sign, pId, timeStamp }.
// This builds the "disable encryption" variant documented at
// openapi.novastar.tech: body travels as plain JSON, and
//   sign = Base64(MD5(timeStamp + pId))
// Note the documented formula for this mode does NOT fold in secretKey —
// only the DES-encrypted-body mode does. secretKey is still accepted/stored
// here for forward compatibility (a firmware update or an encrypted-mode
// implementation later might need it), but is deliberately unused in this
// computation; confirm this against real firmware before assuming it's
// complete (see plan's on-site verification notes).
export function buildSignedRequest({ pId, secretKey, body }) {
    void secretKey;
    const timeStamp = String(Date.now());
    const hex = crypto.createHash('md5').update(`${timeStamp}${pId}`).digest('hex');
    const sign = Buffer.from(hex, 'utf8').toString('base64');
    return { body, sign, pId, timeStamp };
}

function clampInt(value, min, max, fallback) {
    const n = Number(value);
    return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}

// --- Body builders --------------------------------------------------------
// Every device/screen call needs a deviceId (almost always 0 for a single H5
// unit) and a screenId (discovered via readList) — both required by every
// builder below rather than defaulted server-side, so a caller never
// silently targets the wrong screen.

export function buildScreenListBody({ deviceId = 0 } = {}) {
    return { deviceId };
}

export function buildDeviceDetailBody({ deviceId = 0 } = {}) {
    return { deviceId };
}

// type: 0 = blackout, 1 = screen on. time: transition duration in seconds.
export function buildScreenFtbBody({ screenId, deviceId = 0, type, time = 0 }) {
    return {
        screenId,
        deviceId,
        type: type === 1 ? 1 : 0,
        time: clampInt(time, 0, 60, 0),
    };
}

// enable: 0 = unfreeze, 1 = freeze.
export function buildFreezeBody({ screenId, deviceId = 0, enable }) {
    return { deviceId, screenId, enable: enable ? 1 : 0 };
}

export function buildBrightnessBody({ screenId, deviceId = 0, brightness }) {
    return { screenId, deviceId, brightness: clampInt(brightness, 0, 100, 0) };
}

export function buildPresetListBody({ screenId, deviceId = 0 }) {
    return { screenId, deviceId };
}

export function buildPresetPlayBody({ screenId, deviceId = 0, presetId }) {
    return { presetId, screenId, deviceId };
}

const DEFAULT_ARGB = { A: 100, R: 255, G: 255, B: 255 };

// Scoped-down subset of writeOSD's full schema (10 fonts, scroll direction/
// speed/spacing/alignment are all real fields this deliberately doesn't
// expose yet) — text, position, size, and color are enough for a lower-third
// -style banner pushed straight to the processor. isJudge is sent as 1 on
// every call per the docs' "set to 1 for first settings" guidance, since
// there's no cost documented for doing so on repeat calls either.
export function buildTextOsdBody({
    screenId, deviceId = 0, enable, x = 0, y = 0, width = 1920, height = 200,
    chars = '', fontPercent = 80, fontColor = DEFAULT_ARGB,
    backgroundEnable = false, backgroundColor = { A: 0, R: 0, G: 0, B: 0 },
}) {
    return {
        screenId,
        deviceId,
        enable: enable ? 1 : 0,
        isJudge: 1,
        type: 0,
        x, y, width, height,
        words: {
            chars,
            font: 0,
            fontPercent: clampInt(fontPercent, 1, 200, 80),
            speed: 0,
            direction: 0,
            aligned: 1,
            space: 100,
            backgroundEnable: backgroundEnable ? 1 : 0,
            backgroundType: 0,
            fontColor,
            backgroundColor,
        },
    };
}

// `file` is a base64-encoded image (no data: URI prefix). Caller is
// responsible for size/downscale guarding before this point — this just
// shapes the wire body.
export function buildImageOsdBody({
    screenId, deviceId = 0, enable, x = 0, y = 0, width, height,
    file, fileName = 'image.png', fileLength, opacity = 100,
}) {
    return {
        screenId,
        deviceId,
        enable: enable ? 1 : 0,
        isJudge: 1,
        type: 1,
        x, y, width, height,
        image: { file, fileName, fileLength, opacity: clampInt(opacity, 0, 100, 100), hashSum: 0 },
    };
}

// --- Response parsing ------------------------------------------------------

// Confirmed against real H5 firmware: some responses (e.g. a successful
// screen/readList) key the status field as "status " with a trailing space
// instead of "status" — a device-side JSON quirk, not a client bug. Reading
// json.status directly on one of those responses silently comes back
// undefined, which made a real success look like a failure ("NovaStar
// returned status undefined."). Read both spellings defensively.
function readStatus(json) {
    if (!json) return undefined;
    if (json.status !== undefined) return json.status;
    return json['status '];
}

export function isSuccessResponse(json) {
    return !!json && readStatus(json) === 0;
}

export function responseErrorMessage(json) {
    if (!json) return 'No response from the NovaStar processor.';
    return json.msg || `NovaStar returned status ${readStatus(json)}.`;
}

export function parseScreenListResponse(json) {
    const screens = json?.body?.screens;
    if (!Array.isArray(screens)) return [];
    return screens.map(s => ({ screenId: s.screenId, name: s.name || `Screen ${s.screenId}` }));
}

export function parsePresetListResponse(json) {
    const presets = json?.body?.presets;
    if (!Array.isArray(presets)) return [];
    return presets.map(p => ({ presetId: p.presetId, name: p.name || `Preset ${p.presetId}` }));
}

export function parseDeviceDetailResponse(json) {
    const body = json?.body || {};
    return {
        name: body.name || null,
        status: typeof body.status === 'number' ? body.status : null,
        temperature: body.backboardTemperature ?? null,
    };
}
