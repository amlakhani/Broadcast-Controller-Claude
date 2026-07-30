// Standalone diagnostic for the NovaStar H Series OpenAPI connection.
// Uses the exact same request-building code the app uses (novastar_protocol.js),
// so this isolates "is the app building/sending the request wrong" from
// "is something on the processor side rejecting valid credentials" — prints
// the raw outgoing body and the raw response so both can be inspected.
//
// Usage:
//   node scripts/novastar-diagnose.js <address> <pId> <secretKey> [port] [deviceId]
//
// Example:
//   node scripts/novastar-diagnose.js 192.168.1.50 myRequestorId myS3cretKey 80 0

import { buildSignedRequest, buildDeviceDetailBody } from '../novastar_protocol.js';

const [, , address, pId, secretKey, portArg, deviceIdArg] = process.argv;

if (!address || !pId) {
    console.error('Usage: node scripts/novastar-diagnose.js <address> <pId> <secretKey> [port] [deviceId]');
    process.exit(1);
}

const port = portArg ? Number(portArg) : 80;

async function tryDeviceId(deviceId) {
    const body = buildDeviceDetailBody({ deviceId });
    const signed = buildSignedRequest({ pId, secretKey: secretKey || '', body });
    const url = `http://${address}:${port}/open/api/device/readDetail`;

    console.log(`\n--- deviceId=${deviceId} ---`);
    console.log('URL:   ', url);
    console.log('Sent:  ', JSON.stringify(signed, null, 2));

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(signed),
            signal: AbortSignal.timeout(8000),
        });
        console.log('HTTP:  ', response.status, response.statusText);
        const text = await response.text();
        console.log('Body:  ', text);
        try {
            const json = JSON.parse(text);
            console.log('Parsed status:', json.status, ' msg:', json.msg);
        } catch {
            console.log('(response was not valid JSON)');
        }
    } catch (err) {
        console.log('Request failed:', err.message);
    }
}

// deviceId is documented inconsistently across NovaStar's own OpenAPI pages
// (most examples use 0, one field description says "Pass 1") — try both so
// that ambiguity is ruled out in a single run rather than a guessing loop.
const deviceIds = deviceIdArg ? [Number(deviceIdArg)] : [0, 1];
for (const id of deviceIds) {
    await tryDeviceId(id);
}
