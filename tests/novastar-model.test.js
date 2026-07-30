import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    clampBrightness, screenLabelFor, hexToArgb, argbToHex, MAX_IMAGE_OSD_BASE64_LENGTH,
} from '../frontend/src/components/novaStarModel.js';

test('clampBrightness rounds and clamps to 0-100', () => {
    assert.equal(clampBrightness(42), 42);
    assert.equal(clampBrightness(42.6), 43);
    assert.equal(clampBrightness(-5), 0);
    assert.equal(clampBrightness(250), 100);
    assert.equal(clampBrightness('not a number'), 0);
});

test('screenLabelFor prefers the matched screen name, falling back to a numbered placeholder', () => {
    const screens = [{ screenId: 0, name: 'Main Wall' }, { screenId: 1, name: 'Overflow' }];
    assert.equal(screenLabelFor(screens, 0), 'Main Wall');
    assert.equal(screenLabelFor(screens, 5), 'Screen 5');
    assert.equal(screenLabelFor(screens, null), 'No screen selected');
    assert.equal(screenLabelFor([], null), 'No screen selected');
});

test('hexToArgb / argbToHex round-trip through the OpenAPI color shape', () => {
    assert.deepEqual(hexToArgb('#ff0000', 100), { A: 100, R: 255, G: 0, B: 0 });
    assert.equal(argbToHex({ A: 100, R: 255, G: 0, B: 0 }), '#ff0000');
    assert.equal(argbToHex(hexToArgb('#3366cc')), '#3366cc');
});

test('MAX_IMAGE_OSD_BASE64_LENGTH is a sane positive guard, not accidentally zero/undefined', () => {
    assert.ok(MAX_IMAGE_OSD_BASE64_LENGTH > 0);
});
