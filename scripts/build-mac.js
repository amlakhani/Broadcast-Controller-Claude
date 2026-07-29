import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const root = process.cwd();
const outputDir = path.join(root, 'application packages');
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;

function run(command, args, options = {}) {
    const result = spawnSync(command, args, {
        cwd: root,
        stdio: 'inherit',
        shell: false,
        env: {
            ...process.env,
            ...options.env
        }
    });

    if (result.status !== 0) {
        process.exit(result.status ?? 1);
    }
}

function renameIfExists(from, to) {
    if (fs.existsSync(from)) {
        fs.renameSync(from, to);
    }
}

// --publish never: only build the DMGs. Without it, electron-builder detects
// CI and tries to auto-publish to GitHub Releases (needs GH_TOKEN and fails).
// Publishing is handled explicitly by the release workflow / operator instead.
run('electron-builder', ['--mac', '--arm64', '--publish', 'never']);

run('node', ['scripts/rebuild-ndi-mac.js'], {
    env: { npm_config_arch: 'x64' }
});
run('node', ['scripts/verify-ndi-mac.js', '--arch=x64']);
run('electron-builder', ['--mac', '--x64', '--publish', 'never']);

renameIfExists(
    path.join(outputDir, `Broadcast Controller-${version}.dmg`),
    path.join(outputDir, `Broadcast Controller-${version}-x64.dmg`)
);
renameIfExists(
    path.join(outputDir, `Broadcast Controller-${version}.dmg.blockmap`),
    path.join(outputDir, `Broadcast Controller-${version}-x64.dmg.blockmap`)
);

run('node', ['scripts/rebuild-ndi-mac.js'], {
    env: { npm_config_arch: process.arch }
});
run('node', ['scripts/verify-ndi-mac.js', `--arch=${process.arch}`]);
