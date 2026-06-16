import { spawnSync } from 'child_process';

function fail(message) {
    console.error(`NDI macOS build preflight failed: ${message}`);
    process.exit(1);
}

function commandWorks(command, args) {
    const result = spawnSync(command, args, { encoding: 'utf8', shell: false });
    return result.status === 0;
}

function commandExists(command) {
    return commandWorks('/usr/bin/which', [command]);
}

if (process.platform !== 'darwin') {
    fail(`expected darwin, got ${process.platform}`);
}

if (!commandWorks('xcode-select', ['-p'])) {
    fail('Xcode Command Line Tools are required. Install them with "xcode-select --install".');
}

if (!commandExists('pkgutil')) {
    fail('pkgutil is required to extract the NDI SDK package.');
}

if (!commandExists('cpio')) {
    fail('cpio is required to extract the NDI SDK package payload.');
}

console.log('NDI macOS build preflight passed.');
