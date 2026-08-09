// Shared presentation deck helpers, used by the desktop Slides panel and the
// touch slides remote so both build deck state with the same parser.

// Extension included so plain `node --test` can import this module directly;
// Vite resolves it the same either way.
import { authFetch, authImageUrl, authUrl } from '../auth.js';

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

// Canva hands out several link shapes and the operator shouldn't have to know
// which one this app wants. Share > "Copy link" / "Public view link"
// (…/view?utm_…), the short canva.link/… form of that same link, the address bar
// while editing (…/edit), a present link (…/view?mode=present), the Embed panel's
// iframe snippet and a published-website link (*.canva.site) are all accepted,
// and everything except a canva.site publish is folded into the same embeddable
// viewer URL.
const CANVA_HOSTS = ['canva.com', 'canva.site', 'canva.link'];

// Parses a pasted link, tolerating the missing scheme in "www.canva.com/design/…".
const parseUrl = (url = '') => {
    const trimmed = String(url).trim();
    if (!trimmed) return null;
    try {
        return new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
    } catch (e) {
        return null;
    }
};

const hasHost = (url, hosts) => {
    const parsed = parseUrl(url);
    if (!parsed) return false;
    const host = parsed.hostname.toLowerCase();
    return hosts.some(allowed => host === allowed || host.endsWith(`.${allowed}`));
};

export const isCanvaUrl = (url = '') => hasHost(url, CANVA_HOSTS);

const isCanvaSiteUrl = (url = '') => hasHost(url, ['canva.site']);

// canva.link is Canva's own shortener — the design id is only in the redirect, so
// these have to make a round trip through the server before they mean anything.
export const isCanvaShortLink = (url = '') => hasHost(url, ['canva.link']);

export const getDeckType = (itemOrUrl = {}) => {
    const url = typeof itemOrUrl === 'string' ? itemOrUrl : itemOrUrl.url || '';
    if (itemOrUrl.type) return itemOrUrl.type;
    if (isCanvaUrl(url)) return 'Canva';
    if (url.includes('docs.google.com/presentation')) return 'Google Slides';
    return 'URL';
};

export const normalizeSlideCount = (value, fallback = 20) => {
    const parsed = parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

export const normalizeCanvaUrl = (url) => {
    if (!url || !isCanvaUrl(url)) return url;
    // A short link's path is the shortener's code, not a design path — rewriting it
    // here would invent a dead /view URL. resolveDeckUrl expands it first.
    if (isCanvaShortLink(url)) return url.trim();

    const urlObj = parseUrl(url);
    if (!urlObj) return url;

    // A canva.site publish is already a public, standalone page — there is no
    // /view form and no embed mode to add, so keep it exactly as published.
    if (isCanvaSiteUrl(urlObj.href)) return urlObj.href;

    let path = urlObj.pathname.replace(/\/+$/, '');
    // /watch is the video player and has no /view equivalent; everything else
    // (an edit link, a present link, a plain share link) resolves to the viewer.
    if (!path.endsWith('/watch')) {
        path = path.replace(/\/(edit|view|present|preview)$/i, '');
        path += '/view';
    }
    // Tracking params (utm_*, utlId) and whatever mode the copied link carried are
    // dropped. ?embed is not cosmetic: the plain share URL answers with
    // X-Frame-Options: deny, so only this form will render in the output window.
    return `https://www.canva.com${path}?embed`;
};

// Expands a canva.link short link into the design URL it points at. Everything
// else is returned untouched, so callers can pipe every pasted link through this.
// Returns { url } or { error } — a short link that can't be expanded is a hard
// failure, since the un-expanded form will never load in the output window.
export const resolveDeckUrl = async (rawUrl) => {
    const trimmed = String(rawUrl || '').trim();
    if (!isCanvaShortLink(trimmed)) return { url: trimmed };

    const parsed = parseUrl(trimmed);
    try {
        const response = await authFetch(authUrl('/api/presentation/resolve-link', { url: parsed.href }));
        const data = await response.json().catch(() => ({}));
        if (!response.ok || !data.url) {
            return { error: data.error || 'Could not open that Canva short link. Paste the full link from Canva instead.' };
        }
        return { url: data.url };
    } catch (e) {
        console.error('Canva short link resolution failed', e);
        return { error: 'Could not reach Canva to open that short link. Check the internet connection, or paste the full link.' };
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

    if (isCanvaUrl(targetUrl)) {
        // Guard rather than silently embed: a short link that reached here skipped
        // resolveDeckUrl, and framing it directly would just show a blank output.
        if (isCanvaShortLink(targetUrl)) {
            return { error: 'That Canva short link could not be opened. Paste the full link from Canva instead.' };
        }
        return {
            state: {
                ...EMPTY_PRESENTATION,
                mode: 'url',
                baseUrl: normalizeCanvaUrl(targetUrl),
                totalSlides: 1,
                isCanva: true
            },
            status: 'Canva loaded. If the output is blank, set the design to "Anyone with the link" in Canva. Use Canva controls on the output, or export to images for full slide navigation.'
        };
    }

    return { error: 'Supported URL sources are Google Slides and Canva.' };
};
