import fs from 'fs';
import path from 'path';

const root = process.cwd();
const distDir = path.join(root, 'node_modules', '@stagetimerio', 'grandiose', 'dist');
const addonPath = path.join(distDir, 'grandiose.node');

function fail(message) {
    console.error(`NDI Windows build validation failed: ${message}`);
    process.exit(1);
}

if (process.platform !== 'win32') {
    fail(`expected win32, got ${process.platform}`);
}

if (!fs.existsSync(addonPath)) {
    fail(`${addonPath} does not exist`);
}

const header = fs.readFileSync(addonPath, { start: 0, end: 1 });
if (header[0] !== 0x4d || header[1] !== 0x5a) {
    fail('grandiose.node is not a Windows PE binary. Run npm run rebuild:ndi:win on Windows.');
}

const dlls = fs.readdirSync(distDir).filter((name) => name.toLowerCase().endsWith('.dll'));
if (dlls.length === 0) {
    fail('no NDI .dll was copied into @stagetimerio/grandiose/dist');
}

console.log(`NDI Windows build validation passed: ${path.relative(root, addonPath)}`);
