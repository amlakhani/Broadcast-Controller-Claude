import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

function fail(message) {
    console.error(`NDI macOS rebuild failed: ${message}`);
    process.exit(1);
}

if (process.platform !== 'darwin') {
    fail(`expected darwin, got ${process.platform}`);
}

const root = process.cwd();
const grandioseDir = path.join(root, 'node_modules', '@stagetimerio', 'grandiose');
const buildDir = path.join(os.tmpdir(), `broadcast-controller-grandiose-${process.pid}`);

function linkMissingHoistedDependencies(tempNodeModules, rootNodeModules) {
    if (!fs.existsSync(tempNodeModules)) {
        fs.mkdirSync(tempNodeModules, { recursive: true });
    }

    for (const entry of fs.readdirSync(rootNodeModules)) {
        if (entry.startsWith('.')) continue;

        const rootEntry = path.join(rootNodeModules, entry);
        const tempEntry = path.join(tempNodeModules, entry);

        if (entry.startsWith('@') && fs.statSync(rootEntry).isDirectory()) {
            fs.mkdirSync(tempEntry, { recursive: true });
            for (const scopedEntry of fs.readdirSync(rootEntry)) {
                const scopedDestination = path.join(tempEntry, scopedEntry);
                if (!fs.existsSync(scopedDestination)) {
                    fs.symlinkSync(path.join(rootEntry, scopedEntry), scopedDestination, 'dir');
                }
            }
            continue;
        }

        if (!fs.existsSync(tempEntry)) {
            fs.symlinkSync(rootEntry, tempEntry, 'dir');
        }
    }
}

try {
    if (!fs.existsSync(grandioseDir)) {
        fail(`${grandioseDir} does not exist. Run npm install before building.`);
    }

    fs.rmSync(buildDir, { recursive: true, force: true });
    fs.cpSync(grandioseDir, buildDir, { recursive: true });
    linkMissingHoistedDependencies(path.join(buildDir, 'node_modules'), path.join(root, 'node_modules'));

    const result = spawnSync('npm', ['run', 'install'], {
        cwd: buildDir,
        env: {
            ...process.env,
            PATH: `${path.join(root, 'node_modules', '.bin')}${path.delimiter}${process.env.PATH || ''}`
        },
        stdio: 'inherit',
        shell: false
    });

    if (result.status !== 0) {
        process.exit(result.status ?? 1);
    }

    for (const dirName of ['ndi', 'build', 'dist']) {
        const source = path.join(buildDir, dirName);
        const destination = path.join(grandioseDir, dirName);
        if (!fs.existsSync(source)) {
            fail(`${source} was not created by the macOS rebuild.`);
        }
        fs.rmSync(destination, { recursive: true, force: true });
        fs.cpSync(source, destination, { recursive: true });
    }

    console.log('NDI macOS rebuild copied refreshed native artifacts into node_modules.');
} finally {
    fs.rmSync(buildDir, { recursive: true, force: true });
}
