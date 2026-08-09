import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    getDeckType,
    isCanvaShortLink,
    isCanvaUrl,
    normalizeCanvaUrl,
    parseSourceUrl,
    resolveDeckUrl,
} from '../frontend/src/utils/presentation.js';

const EMBED = 'https://www.canva.com/design/DAGabc12345/xY-zToken_9/view?embed';

test('the public share link operators copy out of Canva becomes the embed URL', () => {
    const shareLink = 'https://www.canva.com/design/DAGabc12345/xY-zToken_9/view'
        + '?utm_content=DAGabc12345&utm_campaign=designshare&utm_medium=link2'
        + '&utm_source=uniquelinks&utlId=h1a2b3c4d5';
    assert.equal(normalizeCanvaUrl(shareLink), EMBED);
});

test('edit, present and already-embedded links all land on the same viewer URL', () => {
    assert.equal(normalizeCanvaUrl('https://www.canva.com/design/DAGabc12345/xY-zToken_9/edit'), EMBED);
    assert.equal(normalizeCanvaUrl('https://www.canva.com/design/DAGabc12345/xY-zToken_9/view?mode=present'), EMBED);
    assert.equal(normalizeCanvaUrl(EMBED), EMBED);
    assert.equal(normalizeCanvaUrl('https://www.canva.com/design/DAGabc12345/xY-zToken_9/view/'), EMBED);
});

test('a link pasted without a scheme still normalizes', () => {
    assert.equal(normalizeCanvaUrl('www.canva.com/design/DAGabc12345/xY-zToken_9/view'), EMBED);
});

test('watch links keep the video player path', () => {
    assert.equal(
        normalizeCanvaUrl('https://www.canva.com/design/DAGabc12345/xY-zToken_9/watch?utm_source=link'),
        'https://www.canva.com/design/DAGabc12345/xY-zToken_9/watch?embed'
    );
});

test('a published canva.site link is passed through untouched', () => {
    const site = 'https://morning-service.my.canva.site/deck';
    assert.equal(normalizeCanvaUrl(site), site);
    assert.equal(isCanvaUrl(site), true);
    assert.equal(getDeckType(site), 'Canva');
});

test('non-Canva URLs are left alone', () => {
    const google = 'https://docs.google.com/presentation/d/abc123/edit';
    assert.equal(isCanvaUrl(google), false);
    assert.equal(normalizeCanvaUrl(google), google);
    // A hostname that merely mentions canva.com must not be treated as Canva.
    assert.equal(isCanvaUrl('https://canva.com.example.net/design/x/view'), false);
});

test('parseSourceUrl loads a share link as a Canva deck', () => {
    const parsed = parseSourceUrl('https://www.canva.com/design/DAGabc12345/xY-zToken_9/view?utm_source=x', 20);
    assert.equal(parsed.error, undefined);
    assert.equal(parsed.state.isCanva, true);
    assert.equal(parsed.state.mode, 'url');
    assert.equal(parsed.state.baseUrl, EMBED);
    assert.equal(parsed.state.totalSlides, 1);
});

test('parseSourceUrl still accepts the Embed panel iframe snippet', () => {
    const parsed = parseSourceUrl(`<iframe src="${EMBED}" width="800"></iframe>`, 20);
    assert.equal(parsed.state.baseUrl, EMBED);
    assert.equal(parsed.state.isCanva, true);
});

test('a canva.link short link is recognised but never rewritten blind', () => {
    const short = 'https://canva.link/ibkb9hujzk7k7z3';
    assert.equal(isCanvaShortLink(short), true);
    assert.equal(isCanvaUrl(short), true);
    assert.equal(getDeckType(short), 'Canva');
    // The path is the shortener's code, so normalizing it would invent a dead URL.
    assert.equal(normalizeCanvaUrl(short), short);
    assert.equal(isCanvaShortLink('https://www.canva.com/design/DAGabc12345/xY-zToken_9/view'), false);
});

test('an unresolved short link is refused rather than embedded blank', () => {
    const parsed = parseSourceUrl('https://canva.link/ibkb9hujzk7k7z3', 20);
    assert.match(parsed.error, /short link/i);
    assert.equal(parsed.state, undefined);
});

test('resolveDeckUrl passes non-short links straight through without a fetch', async () => {
    const full = 'https://www.canva.com/design/DAGabc12345/xY-zToken_9/view';
    assert.deepEqual(await resolveDeckUrl(full), { url: full });
    assert.deepEqual(await resolveDeckUrl('https://docs.google.com/presentation/d/abc/edit'), {
        url: 'https://docs.google.com/presentation/d/abc/edit'
    });
});

test('resolveDeckUrl expands a short link via the server endpoint', async (t) => {
    const calls = [];
    global.fetch = async (url) => {
        calls.push(url);
        return {
            ok: true,
            json: async () => ({ url: 'https://www.canva.com/design/DAGPYWX1x-w/VPxkgOdsocN/view?utm_source=x' })
        };
    };
    global.window = { location: { origin: 'http://localhost:3000', search: '' } };
    global.localStorage = { getItem: () => null };
    t.after(() => { delete global.fetch; delete global.window; delete global.localStorage; });

    const resolved = await resolveDeckUrl('https://canva.link/ibkb9hujzk7k7z3');
    assert.equal(resolved.url, 'https://www.canva.com/design/DAGPYWX1x-w/VPxkgOdsocN/view?utm_source=x');
    assert.match(calls[0], /^\/api\/presentation\/resolve-link\?url=/);
    // And the expanded link is what finally becomes the embed URL.
    assert.equal(
        normalizeCanvaUrl(resolved.url),
        'https://www.canva.com/design/DAGPYWX1x-w/VPxkgOdsocN/view?embed'
    );
});

test('a short link the server cannot expand surfaces an error, not a broken deck', async (t) => {
    global.fetch = async () => ({ ok: false, json: async () => ({ error: 'Only Canva links can be resolved.' }) });
    global.window = { location: { origin: 'http://localhost:3000', search: '' } };
    global.localStorage = { getItem: () => null };
    t.after(() => { delete global.fetch; delete global.window; delete global.localStorage; });

    const resolved = await resolveDeckUrl('https://canva.link/ibkb9hujzk7k7z3');
    assert.equal(resolved.url, undefined);
    assert.equal(resolved.error, 'Only Canva links can be resolved.');
});

test('parseSourceUrl keeps Google Slides on the slide-indexed embed URL', () => {
    const parsed = parseSourceUrl('https://docs.google.com/presentation/d/abc123/edit#slide=id.p', 12);
    assert.equal(parsed.state.isCanva, false);
    assert.equal(parsed.state.baseUrl, 'https://docs.google.com/presentation/d/abc123/embed?rm=minimal&slide=');
    assert.equal(parsed.state.totalSlides, 12);
});
