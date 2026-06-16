import fs from 'fs';
import path from 'path';

const root = process.cwd();
const distDir = path.join(root, 'node_modules', '@stagetimerio', 'grandiose', 'dist');
const addonPath = path.join(distDir, 'grandiose.node');
const expectedArch = process.argv.find((arg) => arg.startsWith('--arch='))?.slice('--arch='.length);

function fail(message) {
    console.error(`NDI macOS build validation failed: ${message}`);
    process.exit(1);
}

if (process.platform !== 'darwin') {
    fail(`expected darwin, got ${process.platform}`);
}

if (!fs.existsSync(addonPath)) {
    fail(`${addonPath} does not exist`);
}

const header = fs.readFileSync(addonPath, { start: 0, end: 7 });
const magic = header.readUInt32BE(0);
const machOMagics = new Set([
    0xfeedface,
    0xcefaedfe,
    0xfeedfacf,
    0xcffaedfe,
    0xcafebabe,
    0xbebafeca
]);

if (!machOMagics.has(magic)) {
    fail('grandiose.node is not a Mach-O binary. Run npm run rebuild:ndi:mac on macOS.');
}

if (expectedArch) {
    const normalizedArch = expectedArch === 'x64' ? 'x64' : expectedArch;
    const cpuType = header.readUInt32LE(4);
    const cpuTypes = {
        arm64: 0x0100000c,
        x64: 0x01000007
    };

    if (!cpuTypes[normalizedArch]) {
        fail(`unsupported architecture check: ${expectedArch}`);
    }

    if (cpuType !== cpuTypes[normalizedArch]) {
        fail(`grandiose.node is Mach-O, but not ${expectedArch}. Run npm run rebuild:ndi:mac for the requested architecture.`);
    }
}

const dylibs = fs.readdirSync(distDir).filter((name) => name.toLowerCase().endsWith('.dylib'));
if (dylibs.length === 0) {
    fail('no NDI .dylib was copied into @stagetimerio/grandiose/dist');
}

console.log(`NDI macOS build validation passed: ${path.relative(root, addonPath)}`);
