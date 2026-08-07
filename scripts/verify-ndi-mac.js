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
// Thin Mach-O only. The fat/universal magics (0xcafebabe / 0xbebafeca) used to be accepted
// here, but the arch check below reads offset 4 as a CPU type — in a fat header that field is
// nfat_arch, an architecture *count*. So a universal binary either failed with a nonsense
// "not x64" message or passed by coincidence. grandiose emits thin binaries, and this script
// exists to confirm the per-arch rebuild produced the right one, so reject fat outright.
const thinMachOMagics = new Set([
    0xfeedface,
    0xcefaedfe,
    0xfeedfacf,
    0xcffaedfe
]);
const fatMachOMagics = new Set([0xcafebabe, 0xbebafeca]);

if (fatMachOMagics.has(magic)) {
    fail('grandiose.node is a universal (fat) binary; this build expects a single-architecture one. Run npm run rebuild:ndi:mac for the requested architecture.');
}

if (!thinMachOMagics.has(magic)) {
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
