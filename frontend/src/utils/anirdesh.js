// Parser for anirdesh.com kirtan pages.
//
// Page shape (verified against live pages):
//   <header/nav chrome>
//   Category: <gujarati category>      <- Gujarati lyrics follow
//   Category: <english category>       <- transliterated lyrics follow, TWICE:
//                                         first with diacritics (Mādhojī…), then
//                                         the same song plain-ASCII (Madhoji…)
//   Kirtan Selection … Anirdesh.com ©  <- footer/nav, must be dropped
//
// The two jobs beyond line-level junk filtering are therefore: stop at the footer,
// and cut the plain-ASCII repeat of the song.

// Material Symbols ligature names leak into the text layer as bare words.
const ICON_LIGATURES = new Set([
    'close', 'sort', 'search', 'menu', 'share', 'tune', 'help', 'history', 'favorite',
    'download', 'upload', 'chevron_right', 'chevron_left', 'dark_mode', 'music_note',
    'text_decrease', 'text_increase', 'screen_lock_rotation', 'qr_code', 'star',
    'expand_more', 'expand_less', 'arrow_back', 'arrow_forward', 'info', 'settings',
]);

// Standalone lines that mark the start of the site footer / nav. Everything after
// the first of these is chrome, never lyrics.
const FOOTER_SENTINELS = new Set([
    'kirtan selection', 'quick links', 'kirtan study',
    'publication media', 'sort kirtans by', 'ashram bhajanavali',
]);

// Nav labels and control text that appear as their own lines.
const NAV_LABELS = new Set([
    'go to:', 'sort by:', 'what:', 'type:', 'feedback', 'language', 'show lyrics',
    'font size', 'keep screen awake', 'title', 'lyrics', 'keyword', 'exact',
    'favorites', 'all categories', 'all writers', 'study', 'alphabetical',
    'kirtan number', 'hindi', 'category', 'utsavs', 'writer', 'media', 'artist',
    'raag', 'multi pads', 'cheshta with meaning', 'vachanamrut', 'swamini vato',
    'nishkulanand kavya', 'harililamrut', 'aksharamrutam', 'bhaktachintamani',
    'bhagwad gita', 'bhagvat purana', 'pads', 'translation', 'utsav', 'share',
    'home', 'next', 'prev', 'quick links', 'part-no', 'kirtan selection',
    'bhajan', 'prarthana', 'category:',
]);

export function isFooterStart(line) {
    return FOOTER_SENTINELS.has(String(line || '').trim().toLowerCase());
}

export function isJunkLine(line) {
    const l = String(line || '').trim();
    if (!l || l.length < 2) return true;

    const lower = l.toLowerCase();
    if (ICON_LIGATURES.has(lower)) return true;
    if (NAV_LABELS.has(lower)) return true;
    if (/anirdesh\.com/i.test(l)) return true;
    if (/^[<>]?\s*\d+\s*pads?$/i.test(l)) return true;         // "< 4 pads", "4 pads"
    if (/^(your view history|your recently viewed|add kirtans to your favorites|use the buttons below)/i.test(l)) return true;

    // Structural markers kept as verse separators.
    if (/^(꠶ટેક|ટેક|°ṭek|ṭek|[0-9૦-૯]+)$/i.test(l)) return false;

    if (/^\(.*\)$/.test(l)) return true;
    if (/^\[.*\]$/.test(l)) return true;
    if (/^Pad\s*[-–]\s*\d+$/i.test(l)) return true;
    if (/^પદ\s*[-–]\s*[\d૦-૯]+/.test(l)) return true;
    if (/\([^)]*સુદ[^)]*\)/.test(l)) return true;
    if (/\([^)]*sud\s+\d+[^)]*\)/i.test(l)) return true;
    if (/^Sadhu\b/i.test(l)) return true;
    if (/^(Sadguru|Swami|Sant)\s+\w/i.test(l)) return true;
    if (/^\d+-\d+[:\s]/.test(l)) return true;                   // "1-1: Sadguru Premanand Swami"
    if (/^Raag[s]?\s*[(:]/i.test(l)) return true;
    if (/^રાગ[:\s(]/i.test(l)) return true;
    if (/^સાખી/i.test(l)) return true;
    if (/^Sakhi/i.test(l)) return true;
    if (/your browser does not support/i.test(l)) return true;
    if (/listen to ['"‘’]/i.test(l)) return true;
    if (/^0:\d+\s*\//.test(l)) return true;

    return false;
}

export const stripMarkers = (l) =>
    String(l).replace(/[ .…°-]*(?:[0-9૦-૯]+|꠶ટેક|ટેક|ભલે|bhale|Pad)[ .…°0-9૦-૯-]*$/i, '').trim();

const stripDiacritics = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '');
const hasDiacritics = (s) => stripDiacritics(s) !== s;
const normLine = (s) =>
    stripDiacritics(String(s)).toLowerCase().replace(/[.,;:!?…'"‘’]/g, '').replace(/\s+/g, ' ').trim();

// Index where the plain-ASCII repeat of the song begins, or lines.length if absent.
//
// The repeat's opening line is often the bare title ("Madhoji mere tum hi ek") while
// line 0 carries the first full line ("Mādhojī mere tum hī ek, pāu dharanko ṭhekāno..."),
// so prefix matching is required — exact equality is not enough.
export function findRepeatStart(lines) {
    if (!Array.isArray(lines) || lines.length < 4) return lines?.length || 0;

    const first = normLine(lines[0]);
    if (first.length < 6) return lines.length;

    if (lines.some(hasDiacritics)) {
        // Normal case: block one is accented, the repeat is plain ASCII. Requiring the
        // tail to be diacritic-free is what stops a mid-song refrain triggering a cut.
        for (let i = 1; i < lines.length; i++) {
            if (hasDiacritics(lines[i])) continue;
            const ni = normLine(lines[i]);
            if (ni.length < 6) continue;
            if (!(ni === first || first.startsWith(ni) || ni.startsWith(first))) continue;
            if (lines.slice(i).some(hasDiacritics)) continue;
            return i;
        }
        return lines.length;
    }

    // No diacritics anywhere: fall back to looking for an exact repeat of line 0 in
    // the back half, so a refrain near the top can't truncate the song.
    for (let i = Math.floor(lines.length / 2); i < lines.length; i++) {
        if (normLine(lines[i]) === first) return i;
    }
    return lines.length;
}

// Collect lyric lines from one "Category:" section, stopping at the footer.
// `keep` decides whether a surviving line belongs to this language.
function collectSection(sectionText, keep) {
    const out = [];
    let skippedHeader = false;
    for (const raw of String(sectionText).split('\n')) {
        const line = raw.trim();
        if (!line) continue;
        if (isFooterStart(line)) break;          // rest of the page is nav/footer
        if (!skippedHeader) { skippedHeader = true; continue; }
        if (isJunkLine(line)) continue;
        if (/^[†*]/.test(line)) continue;
        if (!keep(line)) continue;
        out.push(stripMarkers(line));
    }
    return out;
}

const GUJARATI = /[઀-૿]/;

// Takes the page's extracted text and returns { GU, EN } lyric lines.
export function parseAnirdeshText(bodyText) {
    let body = String(bodyText || '');

    for (const marker of ['Publication Media', 'Sort kirtans by', 'Ashram Bhajanavali']) {
        const i = body.indexOf(marker);
        if (i > 100) body = body.substring(0, i);
    }

    const parts = body.split('Category:');
    const GU = parts.length >= 2
        ? collectSection(parts[1], (l) => GUJARATI.test(l) || /^[0-9]+$/.test(l) || /^(꠶ટેક|ટેક)$/.test(l))
        : [];

    let EN = [];
    if (parts.length >= 3) {
        EN = collectSection(parts[2], (l) => !GUJARATI.test(l) && l.length >= 2 && !/\?\s/.test(l));
        EN = EN.slice(0, findRepeatStart(EN));
    }

    return { GU, EN };
}
