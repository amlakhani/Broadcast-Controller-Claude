import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    groupVersesIntoSlides,
    remapSlideIndex,
    slideLabel,
    normalizeLinesPerSlide,
} from '../frontend/src/utils/lyricsSlides.js';

const VERSES = [
    { eng: 'Line one', guj: 'લીટી એક' },
    { eng: 'Line two', guj: 'લીટી બે' },
    { eng: 'Line three', guj: 'લીટી ત્રણ' },
];

test('one line per slide keeps every verse separate', () => {
    const slides = groupVersesIntoSlides(VERSES, 1);
    assert.equal(slides.length, 3);
    assert.deepEqual(slides[0], { eng: 'Line one', guj: 'લીટી એક', from: 0, to: 0 });
    assert.deepEqual(slides[2], { eng: 'Line three', guj: 'લીટી ત્રણ', from: 2, to: 2 });
});

test('two lines per slide joins pairs with a newline', () => {
    const slides = groupVersesIntoSlides(VERSES, 2);
    assert.equal(slides.length, 2);
    assert.equal(slides[0].eng, 'Line one\nLine two');
    assert.equal(slides[0].guj, 'લીટી એક\nલીટી બે');
    assert.deepEqual([slides[0].from, slides[0].to], [0, 1]);
});

test('an odd final line forms its own single-line slide', () => {
    const slides = groupVersesIntoSlides(VERSES, 2);
    assert.equal(slides[1].eng, 'Line three');
    assert.deepEqual([slides[1].from, slides[1].to], [2, 2]);
});

test('a missing translation does not inject a blank line', () => {
    const slides = groupVersesIntoSlides([
        { eng: 'Only english', guj: '' },
        { eng: 'Second english', guj: 'ગુજરાતી બે' },
    ], 2);
    // The empty Gujarati half must not produce a leading "\n".
    assert.equal(slides[0].guj, 'ગુજરાતી બે');
    assert.equal(slides[0].eng, 'Only english\nSecond english');
});

test('a fully blank line is dropped from the join but still counted in the range', () => {
    const slides = groupVersesIntoSlides([
        { eng: 'Real line', guj: 'સાચી લીટી' },
        { eng: '   ', guj: '  ' },
    ], 2);
    assert.equal(slides[0].eng, 'Real line');
    assert.equal(slides[0].guj, 'સાચી લીટી');
    assert.deepEqual([slides[0].from, slides[0].to], [0, 1]);
});

test('empty and invalid input is handled', () => {
    assert.deepEqual(groupVersesIntoSlides([], 2), []);
    assert.deepEqual(groupVersesIntoSlides(null, 2), []);
    assert.deepEqual(groupVersesIntoSlides(undefined, 1), []);
});

test('an unknown lines-per-slide value falls back to 1', () => {
    assert.equal(normalizeLinesPerSlide('2'), 2);
    assert.equal(normalizeLinesPerSlide(2), 2);
    assert.equal(normalizeLinesPerSlide('7'), 1);
    assert.equal(normalizeLinesPerSlide(null), 1);
    assert.equal(normalizeLinesPerSlide('garbage'), 1);
    assert.equal(groupVersesIntoSlides(VERSES, 99).length, 3, 'invalid size behaves like 1');
});

test('remapSlideIndex keeps the operator in place across a toggle', () => {
    // 1 -> 2: line 2 (index 2) lives in the second pair.
    assert.equal(remapSlideIndex(2, 1, 2, 2), 1);
    // 2 -> 1: the second pair starts at line 2.
    assert.equal(remapSlideIndex(1, 2, 1, 3), 2);
    // Staying put is a no-op.
    assert.equal(remapSlideIndex(1, 2, 2, 2), 1);
    assert.equal(remapSlideIndex(0, 1, 2, 2), 0);
});

test('remapSlideIndex clamps into the new, shorter array', () => {
    // Was on the last of 3 single lines; grouped into 2 slides it must not point past the end.
    assert.equal(remapSlideIndex(2, 1, 2, 2), 1);
    assert.equal(remapSlideIndex(9, 1, 2, 2), 1);
    assert.equal(remapSlideIndex(0, 1, 2, 0), null, 'no slides means nothing armed');
});

test('remapSlideIndex passes through a null selection', () => {
    assert.equal(remapSlideIndex(null, 1, 2, 3), null);
    assert.equal(remapSlideIndex(undefined, 1, 2, 3), null);
    assert.equal(remapSlideIndex(-1, 1, 2, 3), null);
});

test('slideLabel reads singular or as a range', () => {
    assert.equal(slideLabel({ from: 2, to: 2 }), 'Verse 3');
    assert.equal(slideLabel({ from: 2, to: 3 }), 'Verses 3–4');
    assert.equal(slideLabel(null, 4), 'Verse 5');
});
