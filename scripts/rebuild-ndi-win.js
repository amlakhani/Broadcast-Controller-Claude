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

// node-gyp bakes the devdir into the generated .vcxproj as a *quoted* node_lib_file path, and
// MSBuild's Contains() condition in Microsoft.CppBuild.targets cannot parse an embedded quote.
// So a devdir containing an apostrophe fails the link step with a bewildering MSB4100, nowhere
// near the real cause. That is not hypothetical: a Windows account named e.g. "Anuj's Framework"
// puts an apostrophe in %TEMP% (C:\Users\ANUJ'S~1\AppData\Local\Temp), and the 8.3 short name
// keeps it. Double quotes and non-ASCII break the same way.
function isBuildPathSafe(dir) {
    return !/['"]/.test(dir) && /^[\x20-\x7E]*$/.test(dir);
}

// %TEMP% when it is usable, and a plainly-named fallback when it is not. C:\Users\Public is
// world-writable and, unlike a per-user temp dir, cannot inherit an apostrophe from the account
// name; the drive root is the last resort.
function buildScratchRoot() {
    const tmp = os.tmpdir();
    if (isBuildPathSafe(tmp)) return tmp;

    const systemDrive = process.env.SystemDrive || 'C:';
    for (const candidate of [process.env.PUBLIC, path.join(systemDrive, path.sep)]) {
        if (!candidate) continue;
        const dir = path.join(candidate, 'bc-native-build');
        if (!isBuildPathSafe(dir)) continue;
        try {
            fs.mkdirSync(dir, { recursive: true });
            console.log(`Note: %TEMP% (${tmp}) contains characters that break node-gyp on Windows; using ${dir} instead.`);
            return dir;
        } catch {
            // Not writable — try the next candidate.
        }
    }

    fail(`no usable build directory: %TEMP% (${tmp}) contains characters node-gyp cannot handle, and no fallback was writable.`);
    return '';
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

// Prefer %TEMP% over a hardcoded drive-root path (which is not a Windows convention and fails
// where the user cannot write to C:\), but fall back when %TEMP% is unusable — see
// buildScratchRoot above for why that matters here.
const scratchRoot = buildScratchRoot();
const devDir = path.join(scratchRoot, 'broadcast-controller-node-gyp-cache');
fs.mkdirSync(devDir, { recursive: true });

const scratchDir = fs.mkdtempSync(path.join(scratchRoot, 'bc-rebuild-ndi-'));
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
