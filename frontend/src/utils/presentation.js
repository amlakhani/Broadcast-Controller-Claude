// Shared presentation deck helpers, used by the desktop Slides panel and the
// touch slides remote so both build deck state with the same parser.

import { authImageUrl } from '../auth';

// Builds the versioned, cacheable slide-image URL for image/PDF decks. The `v`
// query param is the deck id (see server.js's bumpPresDeckId / the
// /api/presentation/slide/:index handler) — including it is what turns the
// response into something the browser can cache immutably instead of
// re-fetching on every navigation. Shared by the slides remote's live/prev/next
// tiles, its prefetch warm-cache, the "All Slides" grid, and the desktop panel's
// own previews, so a prefetch anywhere is a cache hit everywhere it matters:
// they all need to build byte-identical URLs for a given (index, deckId) pair.
// `opts.w` asks the server for the pre-generated grid thumbnail instead of the
// full-resolution slide (falls back to full-res if the deck predates thumbnails).
export const slideImageUrl = (index, deckId, opts = {}) =>
    authImageUrl(`/api/presentation/slide/${index}`, {
        ...(deckId ? { v: deckId } : {}),
        ...(opts.w ? { w: opts.w } : {})
    });

export const EMPTY_PRESENTATION = {
    mode: 'none',
    baseUrl: '',
    slideId: '',
    currentIdx: 0,
    totalSlides: 0,
    images: [],
    thumbs: [],
    isCanva: false,
    showing: false,
    deckId: ''
};

export const getDeckType = (itemOrUrl = {}) => {
    const url = typeof itemOrUrl === 'string' ? itemOrUrl : itemOrUrl.url || '';
    if (itemOrUrl.type) return itemOrUrl.type;
    if (url.includes('canva.com')) return 'Canva';
    if (url.includes('docs.google.com/presentation')) return 'Google Slides';
    return 'URL';
};

export const normalizeSlideCount = (value, fallback = 20) => {
    const parsed = parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

export const normalizeCanvaUrl = (url) => {
    if (!url || !url.includes('canva.com')) return url;
    try {
        const urlObj = new URL(url);
        let path = urlObj.pathname.replace(/\/$/, '');
        if (!path.endsWith('/view') && !path.endsWith('/watch')) {
            path = path.replace(/\/edit$/, '');
            if (!path.endsWith('/view')) path += '/view';
        }
        return `https://www.canva.com${path}?embed`;
    } catch (e) {
        console.error('Canva normalization error', e);
        return url;
    }
};

// Returns { state, status } on success or { error } on failure.
export const parseSourceUrl = (rawUrl, total) => {
    if (!rawUrl.trim()) return null;

    let targetUrl = rawUrl.trim();
    if (targetUrl.includes('<iframe')) {
        const srcMatch = targetUrl.match(/src=["']([^"']+)["']/);
        if (srcMatch) targetUrl = srcMatch[1];
    }

    if (targetUrl.includes('docs.google.com/presentation')) {
        let id = '';
        const pubM = targetUrl.match(/\/presentation\/d\/e\/([\w-]+)/);
        if (pubM) id = `e/${pubM[1]}`;
        else {
            const editM = targetUrl.match(/\/presentation\/d\/([\w-]+)/);
            if (editM) id = editM[1];
        }

        if (!id) {
            return { error: 'Could not extract a Google Slides ID. Please check the URL format.' };
        }

        const totalSlides = normalizeSlideCount(total);
        return {
            state: {
                ...EMPTY_PRESENTATION,
                mode: 'url',
                slideId: id,
                baseUrl: `https://docs.google.com/presentation/d/${id}/embed?rm=minimal&slide=`,
                totalSlides,
                isCanva: false
            },
            status: `Google Slides loaded (${totalSlides} slides). Preview is ready.`
        };
    }

    if (targetUrl.includes('canva.com')) {
        return {
            state: {
                ...EMPTY_PRESENTATION,
                mode: 'url',
                baseUrl: normalizeCanvaUrl(targetUrl),
                totalSlides: 1,
                isCanva: true
            },
            status: 'Canva loaded. Use Canva controls on the output, or export to images for full slide navigation.'
        };
    }

    return { error: 'Supported URL sources are Google Slides and Canva.' };
};
