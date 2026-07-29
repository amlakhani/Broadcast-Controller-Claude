import { spawnSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

// Runs at `npm install` time (see "preinstall" in package.json) so a missing
// Visual Studio Build Tools / Xcode Command Line Tools install is caught with
// a clear, actionable message — instead of the raw node-gyp stack trace that
// surfaces later when @stagetimerio/grandiose (the NDI native module) tries
// to compile.
//
// Reuses the same checks the packaging scripts already run before rebuilding
// NDI per-architecture, so there is one source of truth for each platform's
// requirements.
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const checkScriptByPlatform = {
    win32: 'check-ndi-win-build-env.js',
    darwin: 'check-ndi-mac-build-env.js'
};

const checkScript = checkScriptByPlatform[process.platform];
if (!checkScript) {
    // This project only packages for mac/win; nothing to preflight elsewhere.
    process.exit(0);
}

const result = spawnSync(process.execPath, [path.join(__dirname, checkScript)], { stdio: 'inherit' });
if (result.status !== 0) {
    console.error('\nSee README.md > Prerequisites for install instructions, then re-run npm install.\n');
    process.exit(result.status ?? 1);
}
