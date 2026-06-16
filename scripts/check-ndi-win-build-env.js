import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';

function fail(message) {
    console.error(`NDI Windows build preflight failed: ${message}`);
    process.exit(1);
}

function commandWorks(command, args) {
    const result = spawnSync(command, args, { encoding: 'utf8', shell: false });
    return result.status === 0;
}

if (process.platform !== 'win32') {
    fail(`expected win32, got ${process.platform}`);
}

if (!process.env.PYTHON && !commandWorks('py', ['-3', '--version']) && !commandWorks('python', ['--version'])) {
    const localPrograms = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python');
    const localPython = fs.existsSync(localPrograms)
        ? fs.readdirSync(localPrograms)
            .map((name) => path.join(localPrograms, name, 'python.exe'))
            .find((candidate) => fs.existsSync(candidate))
        : null;

    if (!localPython) {
        fail('Python 3 is required by node-gyp. Install Python 3 or set the PYTHON environment variable.');
    }
}

const vswherePaths = [
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Microsoft Visual Studio', 'Installer', 'vswhere.exe'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft Visual Studio', 'Installer', 'vswhere.exe')
];
const vswhere = vswherePaths.find((candidate) => fs.existsSync(candidate));

if (!vswhere) {
    fail('Visual Studio Build Tools are required. Install "Desktop development with C++" from Visual Studio Build Tools 2022.');
}

const vsResult = spawnSync(vswhere, [
    '-latest',
    '-products',
    '*',
    '-requires',
    'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
    '-property',
    'installationPath'
], { encoding: 'utf8' });

if (vsResult.status !== 0 || !vsResult.stdout.trim()) {
    fail('Visual Studio Build Tools are installed, but the C++ x64 toolchain was not found. Add the "Desktop development with C++" workload.');
}

console.log('NDI Windows build preflight passed.');
