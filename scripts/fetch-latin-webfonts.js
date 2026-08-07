// Mirrors the Latin display webfonts locally so nothing is fetched from a CDN at runtime.
//
// The Gujarati faces were already self-hosted (fonts/unicode), but the Latin families still
// came from fonts.googleapis.com in graphics.html — on the ON-AIR output window. A venue rig on
// an isolated LAN would silently fall back to a system font mid-service, and a slow CDN stalled
// the output renderer's parse.
//
// Run manually when the font list in frontend/src/index.css needs to change:
//   node scripts/fetch-latin-webfonts.js
// It rewrites fonts/latin/ and frontend/src/fonts-latin.css; both are committed.

import fs from 'fs';
import path from 'path';
import https from 'https';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, '..');
const fontDir = path.join(projectRoot, 'fonts', 'latin');
const cssOut = path.join(projectRoot, 'frontend', 'src', 'fonts-latin.css');

// Matches the families the graphics output offers. Rasa is deliberately absent: it is already
// self-hosted under fonts/unicode alongside its Gujarati companion face.
const FAMILIES = [
    'Outfit:wght@300;400;600;700;800',
    'Inter:wght@300;400;600;700;800',
    'Poppins:wght@300;400;600;700;800',
    'Montserrat:wght@300;400;600;700;800',
    'Roboto:wght@300;400;600;700;800',
    'Playfair+Display:ital,wght@0,400;0,700;1,400;1,700',
    'Lora:ital,wght@0,400;0,700;1,400;1,700',
    'Bebas+Neue',
    'Oswald:wght@300;400;600;700',
    'Open+Sans:wght@300;400;600;700;800'
];

// Only the subsets the app actually renders in Latin script. Skipping cyrillic/greek/vietnamese
// keeps the mirrored payload to a fraction of the full Google Fonts response.
const WANTED_SUBSETS = new Set(['latin', 'latin-ext']);

// A desktop Chrome UA is what makes the API answer with woff2 rather than legacy formats.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function get(url, { binary = false } = {}) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, { headers: { 'User-Agent': UA } }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                res.resume();
                return resolve(get(res.headers.location, { binary }));
            }
            if (res.statusCode !== 200) {
                res.resume();
                return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
            }
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => resolve(binary ? Buffer.concat(chunks) : Buffer.concat(chunks).toString('utf8')));
        });
        req.on('error', reject);
        req.setTimeout(30000, () => {
            req.destroy(new Error(`Timed out fetching ${url}`));
        });
    });
}

// The CSS is emitted as `/* subset */ @font-face { ... }` blocks, so the preceding comment is
// what identifies the subset a block belongs to.
function parseFontFaces(css) {
    const blocks = [];
    const re = /\/\*\s*([\w-]+)\s*\*\/\s*@font-face\s*\{([^}]*)\}/g;
    let match;
    while ((match = re.exec(css)) !== null) {
        blocks.push({ subset: match[1], body: match[2] });
    }
    return blocks;
}

function field(body, name) {
    const match = new RegExp(`${name}:\\s*([^;]+);`).exec(body);
    return match ? match[1].trim() : '';
}

function slug(value) {
    return value.replace(/['"]/g, '').replace(/[^A-Za-z0-9]+/g, '');
}

async function main() {
    fs.rmSync(fontDir, { recursive: true, force: true });
    fs.mkdirSync(fontDir, { recursive: true });

    const rules = [];
    let downloaded = 0;

    for (const family of FAMILIES) {
        const css = await get(`https://fonts.googleapis.com/css2?family=${family}&display=swap`);
        for (const { subset, body } of parseFontFaces(css)) {
            if (!WANTED_SUBSETS.has(subset)) continue;

            const familyName = field(body, 'font-family');
            const style = field(body, 'font-style') || 'normal';
            const weight = field(body, 'font-weight') || '400';
            const unicodeRange = field(body, 'unicode-range');
            const srcMatch = /url\((https:\/\/[^)]+\.woff2)\)/.exec(body);
            if (!srcMatch) continue;

            const fileName = `${slug(familyName)}-${subset}-${style}-${weight.replace(/\s+/g, '')}.woff2`;
            const buffer = await get(srcMatch[1], { binary: true });
            fs.writeFileSync(path.join(fontDir, fileName), buffer);
            downloaded += 1;

            rules.push([
                '@font-face {',
                `  font-family: ${familyName};`,
                `  font-style: ${style};`,
                `  font-weight: ${weight};`,
                '  font-display: swap;',
                `  src: url('/fonts/latin/${fileName}') format('woff2');`,
                unicodeRange ? `  unicode-range: ${unicodeRange};` : null,
                '}'
            ].filter(Boolean).join('\n'));
        }
        console.log(`fetched ${family.split(':')[0].replace(/\+/g, ' ')}`);
    }

    const header = [
        '/* GENERATED by scripts/fetch-latin-webfonts.js — do not edit by hand.',
        ' *',
        ' * Self-hosted Latin display faces. Served from /fonts/latin by the Express static',
        ' * handler, so the graphics output renders correctly with no internet connection.',
        ' */',
        ''
    ].join('\n');

    fs.writeFileSync(cssOut, `${header}${rules.join('\n\n')}\n`, 'utf8');
    console.log(`\n${downloaded} font files -> ${path.relative(projectRoot, fontDir)}`);
    console.log(`${rules.length} @font-face rules -> ${path.relative(projectRoot, cssOut)}`);
}

main().catch((err) => {
    console.error(err.message);
    process.exit(1);
});
