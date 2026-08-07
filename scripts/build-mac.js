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

// `required` for the x64 DMG itself: silently skipping the rename when the expected filename
// isn't there is how you ship an x64 build named as if it were universal. The name depends on
// electron-builder's default artifactName, so if that ever changes this must fail, not shrug.
function renameIfExists(from, to, { required = false } = {}) {
    if (fs.existsSync(from)) {
        fs.renameSync(from, to);
        return true;
    }
    if (required) {
        console.error(`Expected build output not found: ${from}`);
        console.error('electron-builder artifact naming may have changed — check "application packages/".');
        process.exit(1);
    }
    return false;
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
    path.join(outputDir, `Broadcast Controller-${version}-x64.dmg`),
    { required: true }
);
renameIfExists(
    path.join(outputDir, `Broadcast Controller-${version}.dmg.blockmap`),
    path.join(outputDir, `Broadcast Controller-${version}-x64.dmg.blockmap`)
);

run('node', ['scripts/rebuild-ndi-mac.js'], {
    env: { npm_config_arch: process.arch }
});
run('node', ['scripts/verify-ndi-mac.js', `--arch=${process.arch}`]);
