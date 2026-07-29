import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GUJ_FONT_OPTIONS, DEFAULT_GUJ_FONT } from '../frontend/src/utils/lyricsFonts.js';

test('the Gujarati font catalogue is well formed', () => {
    assert.ok(GUJ_FONT_OPTIONS.length > 0);

    const values = GUJ_FONT_OPTIONS.map(o => o.value);
    assert.equal(new Set(values).size, values.length, 'font CSS values must be unique');

    const labels = GUJ_FONT_OPTIONS.map(o => o.label);
    assert.equal(new Set(labels).size, labels.length, 'font labels must be unique');

    for (const font of GUJ_FONT_OPTIONS) {
        assert.equal(typeof font.value, 'string');
        assert.equal(typeof font.label, 'string');
        assert.ok(font.value.includes(','), `${font.label} should declare a fallback family`);
    }
});

test('the default font is one of the offered options', () => {
    assert.ok(GUJ_FONT_OPTIONS.some(o => o.value === DEFAULT_GUJ_FONT));
});
