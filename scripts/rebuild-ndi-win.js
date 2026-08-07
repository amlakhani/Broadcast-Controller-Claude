import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

function fail(message) {
    console.error(`NDI Windows rebuild failed: ${message}`);
    process.exit(1);
}

function commandWorks(command, args) {
    return spawnSync(command, args, { stdio: 'ignore', shell: false }).status === 0;
}

function findPython() {
    if (process.env.PYTHON && fs.existsSync(process.env.PYTHON)) return process.env.PYTHON;
    if (commandWorks('py', ['-3', '--version'])) return 'PATH';
    if (commandWorks('python', ['--version'])) return 'PATH';

    const localPrograms = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python');
    if (!fs.existsSync(localPrograms)) return null;

    return fs.readdirSync(localPrograms)
        .map((name) => path.join(localPrograms, name, 'python.exe'))
        .find((candidate) => fs.existsSync(candidate)) || null;
}

function findVsInstallPath() {
    const vswherePaths = [
        path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Microsoft Visual Studio', 'Installer', 'vswhere.exe'),
        path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft Visual Studio', 'Installer', 'vswhere.exe')
    ];
    const vswhere = vswherePaths.find((candidate) => fs.existsSync(candidate));
    if (!vswhere) return null;

    const result = spawnSync(vswhere, [
        '-latest',
        '-products',
        '*',
        '-requires',
        'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
        '-property',
        'installationPath'
    ], { encoding: 'utf8' });

    return result.status === 0 ? result.stdout.trim() : null;
}

if (process.platform !== 'win32') {
    fail(`expected win32, got ${process.platform}`);
}

const python = findPython();
if (!python) {
    fail('Python 3 is required by node-gyp. Install Python 3 or set the PYTHON environment variable.');
}

const vsInstallPath = findVsInstallPath();
if (!vsInstallPath) {
    fail('Visual Studio Build Tools with the C++ x64 toolchain were not found.');
}

const vcvarsPath = path.join(vsInstallPath, 'VC', 'Auxiliary', 'Build', 'vcvars64.bat');
if (!fs.existsSync(vcvarsPath)) {
    fail(`vcvars64.bat was not found at ${vcvarsPath}`);
}

// Use os.tmpdir() rather than a hardcoded path at the drive root. The previous location was not
// a Windows convention, ignored %TEMP%, and failed on a machine where the user cannot create
// directories at C:\. (The macOS sibling script already did this correctly.)
const devDir = path.join(os.tmpdir(), 'broadcast-controller-node-gyp-cache');
fs.mkdirSync(devDir, { recursive: true });

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-rebuild-ndi-'));
const commandFile = path.join(scratchDir, 'rebuild-ndi.cmd');
const commands = [
    '@echo off',
    `call "${vcvarsPath}"`,
    'if errorlevel 1 exit /b %errorlevel%',
    python !== 'PATH' ? `set "PYTHON=${python}"` : null,
    `set "npm_config_devdir=${devDir}"`,
    'npm.cmd rebuild @stagetimerio/grandiose',
    'exit /b %errorlevel%'
].filter(Boolean).join('\r\n');
fs.writeFileSync(commandFile, commands);

// finally, so a throw between writing the script and running it can't leak the temp dir.
let result;
try {
    result = spawnSync('cmd.exe', ['/d', '/c', commandFile], {
        cwd: process.cwd(),
        stdio: 'inherit',
        shell: false
    });
} finally {
    fs.rmSync(scratchDir, { recursive: true, force: true });
}

process.exit(result?.status ?? 1);
