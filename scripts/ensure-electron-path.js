import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const electronDir = path.join(rootDir, 'node_modules', 'electron');
const pathFile = path.join(electronDir, 'path.txt');

const executablePathByPlatform = {
    darwin: 'Electron.app/Contents/MacOS/Electron',
    win32: 'electron.exe',
    linux: 'electron'
};

const executablePath = executablePathByPlatform[process.platform];

// Fail loudly, like every sibling script in this folder. Exiting 0 here let `npm start` carry
// on and die with electron's own opaque error instead of naming the actual problem.
if (!executablePath) {
    console.error(`Electron does not ship a binary for this platform (${process.platform}).`);
    process.exit(1);
}

const fullPath = path.join(electronDir, 'dist', executablePath);

if (!fs.existsSync(fullPath)) {
    console.error(
        `The Electron binary is missing at ${fullPath}.
`
        + 'Reinstall dependencies with "npm install" (or "npm ci") and try again.'
    );
    process.exit(1);
}

fs.writeFileSync(pathFile, executablePath, 'utf8');
