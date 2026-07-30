import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    ART_OPTIONS,
    ASPECT_PRESETS,
    ATEM_BOX_FIELDS,
    ATEM_BOX_LIMITS,
    BOX_COUNT,
    DEFAULT_SUPERSOURCE_DOC,
    FRAME_UNITS,
    STAGE_HEIGHT,
    STAGE_PX_PER_UNIT,
    STAGE_WIDTH,
    SUPERSOURCE_PRESETS,
    applyPreset,
    atemBoxToDoc,
    boxToAtem,
    boxToCropInsets,
    boxToStageRect,
    boxToVisibleRect,
    createDefaultBox,
    createPresetFromDoc,
    cropForAspect,
    diffBoxesForAtem,
    easeInOutCubic,
    interpolateDoc,
    matchAspectPreset,
    normalizeBox,
    normalizeSuperSourceDoc,
    stageRectToBox,
} from '../frontend/src/components/superSourceModel.js';

const near = (actual, expected, tolerance, message) => {
    assert.ok(
        Math.abs(actual - expected) <= tolerance,
        `${message ?? ''} expected ${expected}, got ${actual} (tolerance ${tolerance})`
    );
};

const box = (patch = {}) => normalizeBox({ ...createDefaultBox(), enabled: true, ...patch });

// ---------------------------------------------------------------------------
// The invariant the whole mapping rests on
// ---------------------------------------------------------------------------

test('one ATEM unit is exactly 60 stage px on BOTH axes', () => {
    // If these ever disagree the coordinate mapping needs two constants, not one,
    // and every rect in the designer silently skews.
    assert.equal(STAGE_WIDTH / FRAME_UNITS.width, STAGE_PX_PER_UNIT);
    assert.equal(STAGE_HEIGHT / FRAME_UNITS.height, STAGE_PX_PER_UNIT);
});

test('a full-frame box maps to the whole 1920x1080 stage', () => {
    const rect = boxToStageRect(box({ x: 0, y: 0, size: 1000 }));
    assert.deepEqual(rect, { left: 0, top: 0, width: 1920, height: 1080 });
});

test('x maps to stage px at 0.6 px per raw unit', () => {
    // x:1600 raw = 16.00 units = one full half-width, so the centre lands on the right edge.
    const rect = boxToStageRect(box({ x: 1600, y: 0, size: 1000 }));
    near(rect.left + rect.width / 2, 1920, 1e-9, 'centre x');
});

test('y is flipped: positive y is UP', () => {
    // y:+900 raw = 9.00 units = one full half-height, so the centre lands on the TOP edge.
    const rect = boxToStageRect(box({ x: 0, y: 900, size: 1000 }));
    near(rect.top + rect.height / 2, 0, 1e-9, 'centre y');

    const below = boxToStageRect(box({ x: 0, y: -900, size: 1000 }));
    near(below.top + below.height / 2, STAGE_HEIGHT, 1e-9, 'centre y (negative)');
});

test('size scales both dimensions about the box centre', () => {
    const rect = boxToStageRect(box({ x: 0, y: 0, size: 500 }));
    assert.deepEqual(rect, { left: 480, top: 270, width: 960, height: 540 });
});

// ---------------------------------------------------------------------------
// Round trips
// ---------------------------------------------------------------------------

test('atemBoxToDoc(boxToAtem(b)) is identity for in-range boxes', () => {
    const original = box({ x: -1234, y: 987, size: 456, cropped: true, cropTop: 1500, cropLeft: 2500 });
    const round = atemBoxToDoc(boxToAtem(original));
    for (const field of ATEM_BOX_FIELDS) {
        assert.equal(round[field], original[field], `field ${field} did not survive the round trip`);
    }
});

test('stageRectToBox inverts boxToStageRect across a seeded sweep', () => {
    // A wrong scale factor anywhere in the mapping shows up here and nowhere else.
    let seed = 0x2f6e2b1;
    const rand = () => {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        return seed / 0x100000000;
    };

    for (let i = 0; i < 500; i += 1) {
        const original = box({
            x: Math.round((rand() * 2 - 1) * ATEM_BOX_LIMITS.x.max),
            y: Math.round((rand() * 2 - 1) * ATEM_BOX_LIMITS.y.max),
            size: Math.round(ATEM_BOX_LIMITS.size.min + rand() * (ATEM_BOX_LIMITS.size.max - ATEM_BOX_LIMITS.size.min)),
        });
        const recovered = stageRectToBox(boxToStageRect(original));
        assert.equal(recovered.x, original.x, `x round trip failed at i=${i}`);
        assert.equal(recovered.y, original.y, `y round trip failed at i=${i}`);
        assert.equal(recovered.size, original.size, `size round trip failed at i=${i}`);
    }
});

// ---------------------------------------------------------------------------
// Clamping — out-of-range values wrap as int16 on the wire, so they must never leave
// ---------------------------------------------------------------------------

test('boxToAtem clamps every field to its documented range', () => {
    const tooBig = boxToAtem({ x: 99999, y: 99999, size: 99999, cropped: true, cropTop: 99999, cropBottom: 99999, cropLeft: 99999, cropRight: 99999 });
    const tooSmall = boxToAtem({ x: -99999, y: -99999, size: -99999, cropped: true, cropTop: -99999, cropBottom: -99999, cropLeft: -99999, cropRight: -99999 });

    for (const [field, limit] of Object.entries(ATEM_BOX_LIMITS)) {
        assert.equal(tooBig[field], limit.max, `${field} did not clamp to max`);
        assert.equal(tooSmall[field], limit.min, `${field} did not clamp to min`);
    }
});

test('boxToAtem emits integers only — no floats reach the wire', () => {
    const result = boxToAtem({ x: 12.7, y: -3.2, size: 499.5, cropped: true, cropTop: 100.9 });
    for (const field of ['x', 'y', 'size', 'cropTop', 'cropBottom', 'cropLeft', 'cropRight', 'source']) {
        assert.ok(Number.isInteger(result[field]), `${field} is not an integer: ${result[field]}`);
    }
});

test('boxToAtem carries exactly the documented ATEM box fields, nothing else', () => {
    const result = boxToAtem(box({ x: 10, y: 20, size: 300 }));
    assert.deepEqual(Object.keys(result).sort(), [...ATEM_BOX_FIELDS].sort());
});

test('non-finite input falls back rather than producing NaN', () => {
    const result = boxToAtem({ x: NaN, y: undefined, size: 'nonsense' });
    assert.ok(Number.isInteger(result.x) && Number.isInteger(result.y) && Number.isInteger(result.size));
});

// ---------------------------------------------------------------------------
// Crop geometry
// ---------------------------------------------------------------------------

test('cropLeft of 16000 halves a full-frame box from the left', () => {
    // 16.00 units * 60 px/unit = 960 px at size 1.0.
    const cropped = box({ x: 0, y: 0, size: 1000, cropped: true, cropLeft: 16000 });
    const visible = boxToVisibleRect(cropped);
    near(visible.left, 960, 1e-9, 'visible left');
    near(visible.width, 960, 1e-9, 'visible width');
    near(visible.height, 1080, 1e-9, 'visible height unchanged');
});

test('crop maxima remove exactly the full frame', () => {
    const vertical = boxToCropInsets(box({ size: 1000, cropped: true, cropTop: ATEM_BOX_LIMITS.cropTop.max }));
    near(vertical.top, STAGE_HEIGHT, 1e-9, 'cropTop max');

    const horizontal = boxToCropInsets(box({ size: 1000, cropped: true, cropLeft: ATEM_BOX_LIMITS.cropLeft.max }));
    near(horizontal.left, STAGE_WIDTH, 1e-9, 'cropLeft max');
});

test('crop scales with the box', () => {
    const half = box({ size: 500, cropped: true, cropLeft: 16000 });
    // Same crop on a half-size box removes half as many stage px.
    near(boxToCropInsets(half).left, 480, 1e-9);
});

test('cropped:false disables cropping entirely', () => {
    const rect = boxToStageRect(box({ size: 1000, cropped: false, cropLeft: 16000 }));
    assert.deepEqual(boxToVisibleRect(box({ size: 1000, cropped: false, cropLeft: 16000 })), {
        left: rect.left, top: rect.top, width: rect.width, height: rect.height,
    });
});

test('opposing crops that exceed the box never invert the visible rect', () => {
    const visible = boxToVisibleRect(box({
        size: 1000, cropped: true,
        cropLeft: ATEM_BOX_LIMITS.cropLeft.max, cropRight: ATEM_BOX_LIMITS.cropRight.max,
        cropTop: ATEM_BOX_LIMITS.cropTop.max, cropBottom: ATEM_BOX_LIMITS.cropBottom.max,
    }));
    assert.ok(visible.width >= 0, `negative width: ${visible.width}`);
    assert.ok(visible.height >= 0, `negative height: ${visible.height}`);
});

// ---------------------------------------------------------------------------
// Aspect ratio presets — a box is always a 16:9 window, so "square" or "portrait"
// can only ever mean a symmetric crop
// ---------------------------------------------------------------------------

test('the native 16:9 preset applies no crop at all', () => {
    const wide = ASPECT_PRESETS.find(p => p.id === 'wide');
    assert.deepEqual(cropForAspect(wide.ratio), { cropped: false, cropTop: 0, cropBottom: 0, cropLeft: 0, cropRight: 0 });
});

test('a null ratio (Custom) means "leave crop alone"', () => {
    assert.equal(cropForAspect(null).cropped, false);
});

test('square crop trims left/right symmetrically and leaves the full height', () => {
    const crop = cropForAspect(1); // 1:1
    assert.equal(crop.cropped, true);
    assert.equal(crop.cropTop, 0);
    assert.equal(crop.cropBottom, 0);
    assert.equal(crop.cropLeft, crop.cropRight, 'must be symmetric, or the box would visibly shift off-centre');
    assert.ok(crop.cropLeft > 0);

    // The resulting VISIBLE rect should actually be square, independent of box size.
    for (const size of [1000, 700, 300]) {
        const box = normalizeBox({ enabled: true, size, ...crop });
        const visible = boxToVisibleRect(box);
        const tolerance = 1; // rounding to integer raw crop units
        assert.ok(Math.abs(visible.width - visible.height) <= tolerance, `size ${size}: ${visible.width} x ${visible.height} is not square`);
    }
});

test('portrait crop (9:16) trims left/right harder than square does', () => {
    const square = cropForAspect(1);
    const portrait = cropForAspect(9 / 16);
    assert.ok(portrait.cropLeft > square.cropLeft);
    assert.equal(portrait.cropTop, 0, 'still trims from the sides, not top/bottom, since 9:16 < 16:9');
});

test('an aspect wider than 16:9 trims top/bottom instead of left/right', () => {
    const ultraWide = cropForAspect(21 / 9);
    assert.ok(ultraWide.cropTop > 0);
    assert.equal(ultraWide.cropLeft, 0);
    assert.equal(ultraWide.cropTop, ultraWide.cropBottom);
});

test('matchAspectPreset recognizes every preset it just computed, and only that one', () => {
    for (const preset of ASPECT_PRESETS) {
        if (preset.id === 'custom') continue;
        const crop = cropForAspect(preset.ratio);
        const box = normalizeBox({ enabled: true, size: 500, ...crop });
        assert.equal(matchAspectPreset(box), preset.id, `${preset.id} did not round-trip through matchAspectPreset`);
    }
});

test('matchAspectPreset falls back to custom for hand-tuned crop', () => {
    const box = normalizeBox({ enabled: true, cropped: true, cropTop: 1234, cropLeft: 777 });
    assert.equal(matchAspectPreset(box), 'custom');
});

test('matchAspectPreset reads "wide" for an uncropped box', () => {
    assert.equal(matchAspectPreset(normalizeBox({ enabled: true })), 'wide');
});

test('aspect preset ids are unique', () => {
    const ids = ASPECT_PRESETS.map(p => p.id);
    assert.equal(new Set(ids).size, ids.length);
});

// ---------------------------------------------------------------------------
// Animated transitions
// ---------------------------------------------------------------------------

test('easeInOutCubic is anchored at the endpoints and monotonic', () => {
    assert.equal(easeInOutCubic(0), 0);
    assert.equal(easeInOutCubic(1), 1);
    let prev = -1;
    for (let i = 0; i <= 20; i += 1) {
        const eased = easeInOutCubic(i / 20);
        assert.ok(eased >= prev, 'easing must never run backwards');
        prev = eased;
    }
});

test('interpolateDoc(from, to, 0) matches "from" for shared enabled boxes', () => {
    const from = normalizeSuperSourceDoc({ boxes: [{ enabled: true, x: -800, y: 200, size: 400 }] });
    const to = normalizeSuperSourceDoc({ boxes: [{ enabled: true, x: 800, y: -200, size: 900 }] });
    const at0 = interpolateDoc(from, to, 0);
    assert.equal(at0.boxes[0].x, from.boxes[0].x);
    assert.equal(at0.boxes[0].y, from.boxes[0].y);
    assert.equal(at0.boxes[0].size, from.boxes[0].size);
});

test('interpolateDoc(from, to, 1) lands EXACTLY on "to" — no float drift on the final frame', () => {
    const from = normalizeSuperSourceDoc({ boxes: [{ enabled: true, x: -1234, y: 987, size: 456, cropped: true, cropLeft: 3333 }] });
    const to = normalizeSuperSourceDoc({ boxes: [{ enabled: true, x: 4567, y: -2222, size: 789, cropped: true, cropRight: 7777 }] });
    assert.deepEqual(interpolateDoc(from, to, 1), to);
});

test('interpolateDoc moves monotonically from "from" toward "to"', () => {
    const from = normalizeSuperSourceDoc({ boxes: [{ enabled: true, x: -4000, size: 300 }] });
    const to = normalizeSuperSourceDoc({ boxes: [{ enabled: true, x: 4000, size: 1000 }] });
    let prevX = -Infinity;
    for (let i = 0; i <= 10; i += 1) {
        const x = interpolateDoc(from, to, i / 10).boxes[0].x;
        assert.ok(x >= prevX, `x went backwards at step ${i}`);
        prevX = x;
    }
});

test('a box only enabled in "to" snaps instantly rather than growing from nothing', () => {
    const from = normalizeSuperSourceDoc({ boxes: [{ enabled: false }] });
    const to = normalizeSuperSourceDoc({ boxes: [{ enabled: true, x: 500, size: 600 }] });
    const mid = interpolateDoc(from, to, 0.5);
    assert.equal(mid.boxes[0].x, 500, 'box not in both docs should already be at its final position mid-transition');
    assert.equal(mid.boxes[0].size, 600);
});

test('interpolateDoc always emits values inside ATEM_BOX_LIMITS', () => {
    const from = normalizeSuperSourceDoc({ boxes: [{ enabled: true, x: ATEM_BOX_LIMITS.x.min, size: ATEM_BOX_LIMITS.size.min }] });
    const to = normalizeSuperSourceDoc({ boxes: [{ enabled: true, x: ATEM_BOX_LIMITS.x.max, size: ATEM_BOX_LIMITS.size.max }] });
    for (let i = 0; i <= 10; i += 1) {
        const box = interpolateDoc(from, to, i / 10).boxes[0];
        assert.ok(box.x >= ATEM_BOX_LIMITS.x.min && box.x <= ATEM_BOX_LIMITS.x.max);
        assert.ok(box.size >= ATEM_BOX_LIMITS.size.min && box.size <= ATEM_BOX_LIMITS.size.max);
    }
});

// ---------------------------------------------------------------------------
// Normalizer
// ---------------------------------------------------------------------------

test('normalizeSuperSourceDoc always yields exactly 4 boxes', () => {
    for (const input of [undefined, {}, { boxes: [] }, { boxes: new Array(8).fill({}) }, { boxes: 'nope' }]) {
        assert.equal(normalizeSuperSourceDoc(input).boxes.length, BOX_COUNT);
    }
});

test('every box starts disabled by default', () => {
    // Arming push must never turn on a box the operator hasn't touched.
    for (const b of normalizeSuperSourceDoc({}).boxes) {
        assert.equal(b.enabled, false);
    }
});

test('normalizeSuperSourceDoc survives garbage without throwing', () => {
    const doc = normalizeSuperSourceDoc({
        version: 'banana',
        ssrcId: 99,
        device: { designModel: 42, designSource: 'wat' },
        background: { artFillSource: 'left', artOption: 'sideways' },
        boxes: [{ x: 'left', y: null, size: {} }],
    });

    assert.equal(doc.boxes.length, BOX_COUNT);
    assert.equal(doc.device.designSource, 'manual');
    assert.equal(doc.background.artFillSource, 0);
    assert.equal(doc.background.artOption, 'background');
    assert.ok(doc.ssrcId >= 0 && doc.ssrcId <= 3);
});

test('normalizeSuperSourceDoc is idempotent', () => {
    const once = normalizeSuperSourceDoc({ boxes: [{ enabled: true, x: 500, y: -200, size: 640 }] });
    assert.deepEqual(normalizeSuperSourceDoc(once), once);
});

test('the default document is already normalized', () => {
    assert.deepEqual(normalizeSuperSourceDoc(DEFAULT_SUPERSOURCE_DOC), DEFAULT_SUPERSOURCE_DOC);
});

test('background artOption only accepts the documented values', () => {
    assert.deepEqual(ART_OPTIONS.map(o => o.id).sort(), ['background', 'foreground']);
    assert.equal(normalizeSuperSourceDoc({ background: { artOption: 'sideways' } }).background.artOption, 'background');
    assert.equal(normalizeSuperSourceDoc({ background: { artOption: 'foreground' } }).background.artOption, 'foreground');
});

// ---------------------------------------------------------------------------
// Diff — this is what keeps a drag from becoming a UDP flood
// ---------------------------------------------------------------------------

test('diffBoxesForAtem returns nothing for identical documents', () => {
    const doc = normalizeSuperSourceDoc({ boxes: [{ enabled: true, x: 100, y: 200, size: 500 }] });
    assert.deepEqual(diffBoxesForAtem(doc, doc), []);
    assert.deepEqual(diffBoxesForAtem(doc, normalizeSuperSourceDoc(doc)), []);
});

test('diffBoxesForAtem emits only the fields that actually changed', () => {
    const before = normalizeSuperSourceDoc({ boxes: [{ enabled: true, x: 100, y: 200, size: 500 }] });
    const after = normalizeSuperSourceDoc({ boxes: [{ enabled: true, x: 140, y: 200, size: 500 }] });

    assert.deepEqual(diffBoxesForAtem(before, after), [{ boxIndex: 0, props: { x: 140 } }]);
});

test('diffBoxesForAtem sends every box when there is no previous state', () => {
    const doc = normalizeSuperSourceDoc({});
    const patches = diffBoxesForAtem(null, doc);
    assert.equal(patches.length, BOX_COUNT);
    assert.deepEqual(Object.keys(patches[0].props).sort(), [...ATEM_BOX_FIELDS].sort());
});

test('diffBoxesForAtem respects a device that has fewer than 4 boxes', () => {
    const before = normalizeSuperSourceDoc({});
    const after = normalizeSuperSourceDoc({ boxes: [{ x: 1 }, { x: 2 }, { x: 3 }, { x: 4 }] });
    const patches = diffBoxesForAtem(before, after, { boxCount: 2 });
    assert.deepEqual(patches.map(p => p.boxIndex), [0, 1]);
});

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------

test('preset ids and names are unique', () => {
    const ids = SUPERSOURCE_PRESETS.map(p => p.id);
    assert.equal(new Set(ids).size, ids.length, 'duplicate preset id');
    const names = SUPERSOURCE_PRESETS.map(p => p.name);
    assert.equal(new Set(names).size, names.length, 'duplicate preset name');
});

test('every preset applies cleanly and stays inside the device limits', () => {
    for (const preset of SUPERSOURCE_PRESETS) {
        const doc = applyPreset(DEFAULT_SUPERSOURCE_DOC, preset.id);
        assert.equal(doc.boxes.length, BOX_COUNT, `${preset.id}: wrong box count`);

        const enabled = doc.boxes.filter(b => b.enabled);
        assert.equal(enabled.length, preset.requiresBoxes, `${preset.id}: requiresBoxes disagrees with the layout`);

        for (const b of doc.boxes) {
            for (const [field, limit] of Object.entries(ATEM_BOX_LIMITS)) {
                assert.ok(b[field] >= limit.min && b[field] <= limit.max, `${preset.id}: ${field}=${b[field]} out of range`);
            }
        }
    }
});

test('every preset keeps its enabled boxes on screen', () => {
    for (const preset of SUPERSOURCE_PRESETS) {
        const doc = applyPreset(DEFAULT_SUPERSOURCE_DOC, preset.id);
        for (const [i, b] of doc.boxes.entries()) {
            if (!b.enabled) continue;
            const rect = boxToStageRect(b);
            assert.ok(rect.left >= -1 && rect.top >= -1, `${preset.id} box ${i}: starts off-stage`);
            assert.ok(rect.left + rect.width <= STAGE_WIDTH + 1, `${preset.id} box ${i}: overruns the right edge`);
            assert.ok(rect.top + rect.height <= STAGE_HEIGHT + 1, `${preset.id} box ${i}: overruns the bottom edge`);
        }
    }
});

test('the tiling presets tile without overlapping', () => {
    const overlaps = (a, b) => (
        a.left < b.left + b.width && b.left < a.left + a.width
        && a.top < b.top + b.height && b.top < a.top + a.height
    );

    for (const id of ['split-2', 'quad', 'one-big-three-small', 'worship-speaker-slides']) {
        const rects = applyPreset(DEFAULT_SUPERSOURCE_DOC, id)
            .boxes.filter(b => b.enabled).map(boxToStageRect);

        for (let i = 0; i < rects.length; i += 1) {
            for (let j = i + 1; j < rects.length; j += 1) {
                assert.equal(overlaps(rects[i], rects[j]), false, `${id}: boxes ${i} and ${j} overlap`);
            }
        }
    }
});

test('split-2 and quad tile the frame exactly', () => {
    const area = (rects) => rects.reduce((sum, r) => sum + r.width * r.height, 0);
    const full = STAGE_WIDTH * STAGE_HEIGHT;

    const split = applyPreset(DEFAULT_SUPERSOURCE_DOC, 'split-2').boxes.filter(b => b.enabled).map(boxToStageRect);
    near(area(split), full / 2, 1e-6, '2-box split covers half the frame');

    const quad = applyPreset(DEFAULT_SUPERSOURCE_DOC, 'quad').boxes.filter(b => b.enabled).map(boxToStageRect);
    near(area(quad), full, 1e-6, 'quad covers the whole frame');
});

test('applying a preset preserves the input assignment', () => {
    // Presets are geometry. Clobbering the operator's input routing mid-show
    // would be the single most annoying possible bug in this panel.
    const doc = normalizeSuperSourceDoc({
        boxes: [{ source: 5 }, { source: 9 }, { source: 3 }, { source: 7 }],
    });

    for (const preset of SUPERSOURCE_PRESETS) {
        const applied = applyPreset(doc, preset.id);
        assert.deepEqual(applied.boxes.map(b => b.source), [5, 9, 3, 7], `${preset.id} clobbered source`);
    }
});

test('an unknown preset id returns the document unchanged', () => {
    const doc = normalizeSuperSourceDoc({ boxes: [{ x: 321 }] });
    assert.deepEqual(applyPreset(doc, 'no-such-preset'), doc);
});

test('a saved custom preset round-trips through apply', () => {
    const authored = normalizeSuperSourceDoc({
        boxes: [
            { enabled: true, x: -600, y: 300, size: 420 },
            { enabled: true, x: 600, y: -300, size: 420 },
            { enabled: false },
            { enabled: false },
        ],
    });

    const preset = createPresetFromDoc(authored, 'My Look', 'custom-test');
    assert.equal(preset.custom, true);
    assert.equal(preset.requiresBoxes, 2);

    // Applied onto a completely different starting document, the geometry must land exactly.
    const applied = applyPreset(normalizeSuperSourceDoc({}), 'custom-test', [preset]);
    for (const i of [0, 1]) {
        for (const field of ['x', 'y', 'size', 'enabled']) {
            assert.equal(applied.boxes[i][field], authored.boxes[i][field], `box ${i} field ${field}`);
        }
    }
    assert.equal(applied.boxes[2].enabled, false);
});

test('a custom preset captures the layout but never the routing', () => {
    const authored = normalizeSuperSourceDoc({
        boxes: [{ enabled: true, x: 100, size: 500, source: 6 }],
    });
    const preset = createPresetFromDoc(authored, 'Look', 'custom-routing');

    assert.equal('source' in preset.boxes[0], false, 'preset captured an ATEM input');

    const target = normalizeSuperSourceDoc({ boxes: [{ source: 3 }] });
    const applied = applyPreset(target, 'custom-routing', [preset]);
    assert.equal(applied.boxes[0].source, 3);
    assert.equal(applied.boxes[0].x, 100, 'but the geometry did apply');
});

test('applyPreset ignores a custom id that is no longer saved', () => {
    const doc = normalizeSuperSourceDoc({ boxes: [{ x: 250 }] });
    assert.deepEqual(applyPreset(doc, 'custom-deleted', []), doc);
});
