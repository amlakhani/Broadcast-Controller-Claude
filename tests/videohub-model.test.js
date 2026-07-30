import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeStagedDiff, normalizeLabel, labelFor, MAX_LABEL_LENGTH } from '../frontend/src/components/videohubModel.js';

test('computeStagedDiff only returns destinations that would actually change', () => {
    const outputs = [{ id: 0, source: 0 }, { id: 1, source: 1 }, { id: 2, source: 2 }];
    const staged = { 0: 5, 1: 1, 2: 3 }; // dest 1 staged to what it already is
    const diff = computeStagedDiff(outputs, staged);
    assert.deepEqual(diff.sort((a, b) => a.destIndex - b.destIndex), [
        { destIndex: 0, srcIndex: 5 },
        { destIndex: 2, srcIndex: 3 },
    ]);
});

test('computeStagedDiff is empty when nothing is staged or staging matches current routing', () => {
    assert.deepEqual(computeStagedDiff([{ id: 0, source: 0 }], {}), []);
    assert.deepEqual(computeStagedDiff([{ id: 0, source: 0 }], { 0: 0 }), []);
});

test('normalizeLabel trims and caps length to match hub firmware limits', () => {
    assert.equal(normalizeLabel('  Camera 1  '), 'Camera 1');
    assert.equal(normalizeLabel('x'.repeat(40)).length, MAX_LABEL_LENGTH);
    assert.equal(normalizeLabel(null), '');
    assert.equal(normalizeLabel(undefined), '');
});

test('labelFor falls back to a numbered placeholder when unlabeled', () => {
    const inputs = [{ id: 0, label: 'Camera 1' }, { id: 1, label: '' }];
    assert.equal(labelFor(inputs, 0), 'Camera 1');
    assert.equal(labelFor(inputs, 1), 'Input 2');
    assert.equal(labelFor(inputs, 5), 'Input 6');
    assert.equal(labelFor(inputs, null), '—');
    assert.equal(labelFor([{ id: 0, label: 'Program' }], 0, 'Output'), 'Program');
});
