// Groups parsed lyric lines into the units the operator takes live.
//
// `parsedVerses` stays canonical at ONE LINE per entry — the song library persists that
// array verbatim, so grouping must never be baked into it or a saved group boundary would
// become indistinguishable from a real line break on reload. Slides are derived instead,
// which also makes the setting hot-swappable with no re-parse.

export const LINES_PER_SLIDE_OPTIONS = [1, 2];

export function normalizeLinesPerSlide(value) {
    const parsed = parseInt(value, 10);
    return LINES_PER_SLIDE_OPTIONS.includes(parsed) ? parsed : 1;
}

// Joins a group's lines, dropping empty halves so a line missing its translation
// doesn't leave a stray blank line in the output.
const joinLines = (verses, key) => verses.map(v => (v?.[key] || '').trim()).filter(Boolean).join('\n');

// verses: [{ eng, guj }]  ->  [{ eng, guj, from, to }] where from/to index `verses`.
export function groupVersesIntoSlides(verses, linesPerSlide = 1) {
    if (!Array.isArray(verses) || verses.length === 0) return [];
    const size = normalizeLinesPerSlide(linesPerSlide);

    const slides = [];
    for (let i = 0; i < verses.length; i += size) {
        const chunk = verses.slice(i, i + size);
        slides.push({
            eng: joinLines(chunk, 'eng'),
            guj: joinLines(chunk, 'guj'),
            from: i,
            to: i + chunk.length - 1,
        });
    }
    return slides;
}

// Keeps the operator roughly in place when the setting is toggled mid-song: the slide
// index is converted back to its first underlying line, then into the new grouping.
export function remapSlideIndex(index, oldLinesPerSlide, newLinesPerSlide, slideCount = Infinity) {
    if (index === null || index === undefined || !Number.isFinite(index) || index < 0) return null;
    const oldSize = normalizeLinesPerSlide(oldLinesPerSlide);
    const newSize = normalizeLinesPerSlide(newLinesPerSlide);
    const lineIndex = index * oldSize;
    const mapped = Math.floor(lineIndex / newSize);
    if (!Number.isFinite(slideCount)) return Math.max(0, mapped);
    if (slideCount <= 0) return null;
    return Math.max(0, Math.min(mapped, slideCount - 1));
}

export function slideLabel(slide, fallbackIndex = 0) {
    if (!slide || slide.from === undefined) return `Verse ${fallbackIndex + 1}`;
    return slide.from === slide.to ? `Verse ${slide.from + 1}` : `Verses ${slide.from + 1}–${slide.to + 1}`;
}
