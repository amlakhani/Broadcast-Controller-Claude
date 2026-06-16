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

if (!executablePath) {
    process.exit(0);
}

const fullPath = path.join(electronDir, 'dist', executablePath);

if (!fs.existsSync(fullPath)) {
    process.exit(0);
}

fs.writeFileSync(pathFile, executablePath, 'utf8');
